// content.js
// Chrome Extension Content Script for Zh-Lens

let observer = null;
let isAltPressed = false;
let tooltipElement = null;
let isEnabled = true;
let isTranslationMode = false;
let isPinyinEnabled = true;
const translationCache = new Map();

// Built-in Chrome Translator API (chrome://flags + Chrome 138+ desktop).
// Runs only in window contexts (not the service worker), so the primary
// translation path lives here in the content script. Falls back to the gtx
// API in background.js when the built-in API is unavailable or not ready.
const TRANSLATOR_SOURCE_LANG = 'zh';
const TRANSLATOR_TARGET_LANG = 'en';
let translatorPromise = null;
let translatorUnavailable = false;

// Which translation engine the user has selected in the popup:
//   'auto'    - built-in Translator API, falling back to gtx (default)
//   'builtin' - Chrome's built-in Translator API only
//   'google'  - Google Translate (gtx) endpoint only
let translationEngine = 'auto';

// Live translation progress, polled by the popup to render its loading bar.
// `total`/`done` drive a determinate bar; `rateLimited` surfaces the gtx
// verification link both in-page and in the popup.
let translationStatus = { active: false, done: 0, total: 0, rateLimited: false, verificationUrl: null };

// Debouncing mechanism for MutationObserver
let scanTimeout = null;
let pendingNodesToScan = [];

// Check if page contains Chinese characters to avoid overhead on non-Chinese sites
function pageContainsChinese() {
  return document.body && /[\u4e00-\u9fa5]/.test(document.body.innerText);
}

// TreeWalker filter to retrieve valid Chinese text nodes
function findChineseTextNodes(roots) {
  const textNodes = [];

  for (const root of roots) {
    if (root.nodeType === Node.TEXT_NODE) {
      if (isValidChineseTextNode(root)) {
        textNodes.push(root);
      }
      continue;
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return isValidChineseTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );

    let currentNode;
    while (currentNode = walker.nextNode()) {
      textNodes.push(currentNode);
    }
  }

  return textNodes;
}

// Check node eligibility for replacement
function isValidChineseTextNode(node) {
  const val = node.nodeValue;
  if (!val || !val.trim()) return false;
  if (!/[\u4e00-\u9fa5]/.test(val)) return false;

  let parent = node.parentElement;
  while (parent) {
    const tag = parent.tagName.toLowerCase();
    if (
      tag === 'script' ||
      tag === 'style' ||
      tag === 'textarea' ||
      tag === 'input' ||
      tag === 'select' ||
      tag === 'noscript' ||
      tag === 'code' ||
      tag === 'pre' ||
      tag === 'ruby' ||
      tag === 'rt' ||
      tag === 'rp' ||
      parent.getAttribute('contenteditable') === 'true' ||
      parent.id === 'zh-lens-tooltip'
    ) {
      return false;
    }
    parent = parent.parentElement;
  }
  return true;
}

// Group segments into logical sentences based on punctuation
function groupSegmentsIntoSentences(segments) {
  const sentences = [];
  let currentSentence = [];

  for (const seg of segments) {
    currentSentence.push(seg);

    // End sentence on common sentence-ending marks or newlines
    const isPunctuation = !seg.isChinese && /[\u3002\uff01\uff1f\.\!\?\n\r]/.test(seg.word);
    if (isPunctuation) {
      sentences.push(currentSentence);
      currentSentence = [];
    }
  }

  if (currentSentence.length > 0) {
    sentences.push(currentSentence);
  }

  return sentences;
}

// Lazily create (and cache) a built-in Translator instance. Returns null when
// the API is missing, the language pair is unsupported, or creation fails
// (e.g. model not yet downloaded and no user activation). A transient failure
// resets the cache so a later attempt — typically after a user gesture — can
// retry; a permanent failure latches translatorUnavailable so we stop trying.
async function getBuiltInTranslator() {
  if (translatorUnavailable) return null;
  if (translatorPromise) return translatorPromise;
  if (typeof Translator === 'undefined') {
    translatorUnavailable = true;
    return null;
  }

  const attempt = (async () => {
    const availability = await Translator.availability({
      sourceLanguage: TRANSLATOR_SOURCE_LANG,
      targetLanguage: TRANSLATOR_TARGET_LANG,
    });
    // 'unsupported'/'unavailable' means this build can never serve the pair.
    if (availability !== 'available' && availability !== 'downloadable' && availability !== 'downloading') {
      translatorUnavailable = true;
      return null;
    }

    // When the model still needs downloading, Translator.create() requires
    // transient user activation. Our auto/storage-driven path has none, so
    // creating would reject with a DOMException — bail out cleanly and let gtx
    // handle this run. A later gesture (e.g. the Alt+Q hotkey) retries with
    // activation present, which is what actually kicks off the download.
    const needsDownload = availability !== 'available';
    if (needsDownload && !navigator.userActivation?.isActive) {
      throw new Error('built-in model needs download; deferring until a user gesture');
    }

    return Translator.create({
      sourceLanguage: TRANSLATOR_SOURCE_LANG,
      targetLanguage: TRANSLATOR_TARGET_LANG,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          console.log(`Zh-Lens: translation model downloading ${Math.round(e.loaded * 100)}%`);
        });
      },
    });
  })();

  translatorPromise = attempt.catch((error) => {
    // DOMException stringifies to a useless "[object DOMException]" — log its
    // name/message so the real reason (NotAllowedError, NotSupportedError, …)
    // is visible.
    const detail = error instanceof DOMException ? `${error.name}: ${error.message}` : error;
    console.warn('Zh-Lens: Built-in Translator unavailable, using gtx fallback.', detail);
    translatorPromise = null; // allow a later retry (e.g. after user activation)
    return null;
  });

  return translatorPromise;
}

// Translate a batch with the built-in API. Returns an array of
// { source, translated } items, or null to signal the caller to fall back.
// `onProgress` is invoked after each sentence so the popup loading bar can
// advance while a long page is processed.
async function translateWithBuiltIn(texts, onProgress) {
  const translator = await getBuiltInTranslator();
  if (!translator) return null;

  const results = [];
  // The Translator API processes calls sequentially, so awaiting in a loop
  // is no slower than firing them concurrently and is easier to reason about.
  for (const text of texts) {
    try {
      const translated = await translator.translate(text);
      if (translated) {
        results.push({ source: text, translated: translated.trim() });
      }
    } catch (error) {
      console.warn('Zh-Lens: Built-in translate() failed for a sentence.', error);
    }
    if (onProgress) onProgress();
  }
  return results;
}

// Translate a batch via the gtx endpoint in the background service worker.
// Surfaces a verification link to the user when Google rate-limits the request.
async function translateWithGtx(texts) {
  const response = await chrome.runtime.sendMessage({
    type: 'TRANSLATE_BATCH',
    texts
  });
  if (response && response.success && response.result) {
    return response.result;
  }
  if (response && response.rateLimited) {
    setRateLimited(response.verificationUrl, response.status);
  }
  return [];
}

// Pick the translation path based on the user's engine preference. Returns an
// array of { source, translated } items (possibly empty).
async function translateBatch(texts, onProgress) {
  if (translationEngine === 'google') {
    const gtx = await translateWithGtx(texts);
    if (onProgress) texts.forEach(onProgress);
    return gtx;
  }

  if (translationEngine === 'builtin') {
    const builtIn = await translateWithBuiltIn(texts, onProgress);
    return builtIn === null ? [] : builtIn;
  }

  // 'auto': built-in first, gtx as fallback when it is unavailable/not ready.
  let resultItems = await translateWithBuiltIn(texts, onProgress);
  if (resultItems === null) {
    resultItems = await translateWithGtx(texts);
    if (onProgress) texts.forEach(onProgress);
  }
  return resultItems;
}

// Fetch translations for sentences on the page in a single batch
async function translatePageSentences() {
  if (!chrome.runtime?.id) {
    stopObserver();
    return;
  }
  const sentenceElements = Array.from(document.querySelectorAll('.zh-lens-sentence'));
  const textsToTranslate = [];

  for (const elem of sentenceElements) {
    const text = elem.getAttribute('data-sentence-text')?.trim();
    if (text && !translationCache.has(text) && !textsToTranslate.includes(text)) {
      textsToTranslate.push(text);
    }
  }

  if (textsToTranslate.length === 0) {
    applyTranslationsFromCache();
    return;
  }

  // Begin a fresh progress run for the popup loading bar.
  translationStatus = {
    active: true,
    done: 0,
    total: textsToTranslate.length,
    rateLimited: false,
    verificationUrl: null,
  };
  const onProgress = () => { translationStatus.done++; };

  try {
    const resultItems = await translateBatch(textsToTranslate, onProgress);

    const responseMap = new Map();
    resultItems.forEach(item => {
      if (item.source && item.translated) {
        responseMap.set(item.source, item.translated);
      }
    });

    textsToTranslate.forEach((originalText, index) => {
      let translation = responseMap.get(originalText);
      // Fallback to index-based matching
      if (!translation && resultItems[index]) {
        translation = resultItems[index].translated;
      }

      if (translation) {
        translationCache.set(originalText, translation);
      }
    });

    applyTranslationsFromCache();
  } catch (error) {
    console.warn('Zh-Lens: Batch translation failed.', error);
  } finally {
    translationStatus.active = false;
  }
}

// Record a gtx rate-limit / verification request and surface it to the user via
// an in-page banner. The popup reads the same `translationStatus` to mirror it.
function setRateLimited(verificationUrl, status) {
  const url = verificationUrl || 'https://www.google.com/sorry/index';
  translationStatus.rateLimited = true;
  translationStatus.verificationUrl = url;
  showRateLimitBanner(url, status);
}

// In-page banner prompting the user to complete Google's human-verification so
// the gtx endpoint resumes serving translations.
function showRateLimitBanner(url, status) {
  if (document.getElementById('zh-lens-rate-limit')) return;

  const banner = document.createElement('div');
  banner.id = 'zh-lens-rate-limit';

  const text = document.createElement('span');
  text.className = 'zh-lens-rate-limit-text';
  text.textContent = status
    ? `Google Translate needs verification (HTTP ${status}).`
    : 'Google Translate needs verification.';

  const link = document.createElement('a');
  link.className = 'zh-lens-rate-limit-link';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Verify, then retry';
  link.addEventListener('click', () => {
    // Give the user a moment to solve the challenge, then re-attempt.
    setTimeout(() => {
      const b = document.getElementById('zh-lens-rate-limit');
      if (b) b.remove();
      translationStatus.rateLimited = false;
      translationStatus.verificationUrl = null;
      if (isTranslationMode) translatePageSentences();
    }, 1500);
  });

  const close = document.createElement('button');
  close.className = 'zh-lens-rate-limit-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => banner.remove());

  banner.appendChild(text);
  banner.appendChild(link);
  banner.appendChild(close);
  document.body.appendChild(banner);
}

// Match ellipsis at the end of the original text
function matchEllipsis(original, translation) {
  if (!original || !translation) return translation;
  const trimmedOrig = original.trim();
  const trimmedTrans = translation.trim();

  if (trimmedOrig.endsWith('...')) {
    if (!trimmedTrans.endsWith('...')) {
      return trimmedTrans + '...';
    }
  } else if (trimmedOrig.endsWith('…')) {
    if (!trimmedTrans.endsWith('…')) {
      return trimmedTrans + '…';
    }
  }
  return translation;
}

// Apply translations from the local cache map to elements
function applyTranslationsFromCache() {
  const sentenceElements = document.querySelectorAll('.zh-lens-sentence');
  sentenceElements.forEach(elem => {
    const text = elem.getAttribute('data-sentence-text')?.trim();
    if (text && translationCache.has(text)) {
      const transSpan = elem.querySelector('.zh-lens-sentence-translated-text');
      if (transSpan) {
        let translation = translationCache.get(text);
        translation = matchEllipsis(text, translation);
        transSpan.textContent = translation;
        elem.setAttribute('data-translated', 'true');
      }
    }
  });
}

// Run FMM batch segmentation and DOM replacement
async function scanAndProcessNodes(roots) {
  if (!chrome.runtime?.id) {
    stopObserver();
    return;
  }
  if (!isEnabled) return;
  
  try {
    const textNodes = findChineseTextNodes(roots);
    if (textNodes.length === 0) return;

    const texts = textNodes.map(node => node.nodeValue);

    // Send single batch query to background worker
    const response = await chrome.runtime.sendMessage({ type: 'SEGMENT_BATCH', texts });
    if (!response || !response.success) {
      console.warn('Zh-Lens: Batch processing failed.', response?.error);
      return;
    }

    const batchResults = response.result;

    // Disconnect observer to avoid recording self-generated DOM mutations
    stopObserver();

    for (let i = 0; i < textNodes.length; i++) {
      const node = textNodes[i];
      const segments = batchResults[i];
      if (!segments || !node.parentNode) continue;

      const fragment = document.createDocumentFragment();
      const sentenceGroups = groupSegmentsIntoSentences(segments);

      for (const group of sentenceGroups) {
        const sentenceText = group.map(seg => seg.word).join('').trim();
        if (!sentenceText) continue;

        const containsChinese = group.some(seg => seg.isChinese);

        if (containsChinese) {
          const sentenceSpan = document.createElement('span');
          sentenceSpan.className = 'zh-lens-sentence';
          sentenceSpan.setAttribute('data-sentence-text', sentenceText);

          const originalSpan = document.createElement('span');
          originalSpan.className = 'zh-lens-sentence-original';

          for (const seg of group) {
            if (seg.isChinese) {
              const ruby = document.createElement('ruby');
              ruby.className = 'zh-lens-word';

              const readings = seg.entry?.readings || [];
              const pinyinStr = readings[0]?.pinyin || '';
              const syllables = pinyinStr.split(/\s+/).filter(Boolean);
              const chars = Array.from(seg.word);

              if (chars.length === syllables.length && syllables.length > 0) {
                // Map character-to-syllable 1:1 for individual coloring
                for (let idx = 0; idx < chars.length; idx++) {
                  const char = chars[idx];
                  const syl = syllables[idx];
                  const { marked, tone } = convertSyllable(syl);

                  const rb = document.createElement('rb');
                  rb.textContent = char;
                  ruby.appendChild(rb);

                  const rt = document.createElement('rt');
                  rt.textContent = marked;
                  rt.className = `zh-tone-${tone} zh-pinyin`;
                  ruby.appendChild(rt);
                }
              } else {
                // Fallback: whole word and joint pinyin
                const rb = document.createElement('rb');
                rb.textContent = seg.word;
                ruby.appendChild(rb);

                const rt = document.createElement('rt');
                rt.className = 'zh-pinyin';
                if (syllables.length > 0) {
                  rt.textContent = syllables.map(s => convertSyllable(s).marked).join(' ');
                  if (syllables.length === 1) {
                    const { tone } = convertSyllable(syllables[0]);
                    rt.className = `zh-tone-${tone} zh-pinyin`;
                  }
                } else {
                  rt.textContent = ' ';
                }
                ruby.appendChild(rt);
              }

              // Store raw entry data in HTML attributes for tooltips
              if (seg.entry) {
                ruby.setAttribute('data-simplified', seg.entry.simplified || seg.word);
                ruby.setAttribute('data-traditional', seg.entry.traditional || '');
                ruby.setAttribute('data-readings', JSON.stringify(readings));
              } else {
                ruby.setAttribute('data-simplified', seg.word);
                ruby.setAttribute('data-traditional', '');
                ruby.setAttribute('data-readings', JSON.stringify([]));
              }

              originalSpan.appendChild(ruby);
            } else {
              if (/\n/.test(seg.word)) {
                const parts = seg.word.split(/(\r?\n)/);
                parts.forEach(part => {
                  if (/^\r?\n$/.test(part)) {
                    // Append newline outside the hidden original span so it stays active in translation mode
                    sentenceSpan.appendChild(document.createTextNode(part));
                  } else if (part) {
                    originalSpan.appendChild(document.createTextNode(part));
                  }
                });
              } else {
                originalSpan.appendChild(document.createTextNode(seg.word));
              }
            }
          }

          sentenceSpan.appendChild(originalSpan);

          // Add the outer sentence-level translation tag
          const translationSpan = document.createElement('span');
          translationSpan.className = 'zh-lens-sentence-translated-text';
          
          const hasTranslation = translationCache.has(sentenceText);
          if (hasTranslation) {
            let translation = translationCache.get(sentenceText);
            translation = matchEllipsis(sentenceText, translation);
            translationSpan.textContent = translation;
            sentenceSpan.setAttribute('data-translated', 'true');
          } else {
            translationSpan.textContent = '';
          }
          sentenceSpan.appendChild(translationSpan);

          fragment.appendChild(sentenceSpan);
        } else {
          // Plain non-Chinese segment
          for (const seg of group) {
            fragment.appendChild(document.createTextNode(seg.word));
          }
        }
      }

      node.parentNode.replaceChild(fragment, node);
    }
  } catch (error) {
    console.error('Zh-Lens DOM Processing Error:', error);
  } finally {
    // Re-engage observer
    startObserver();
    // Translate newly loaded sentences if in translation mode
    if (isTranslationMode) {
      translatePageSentences();
    }
  }
}

// Set up MutationObserver
function startObserver() {
  if (observer || !isEnabled) return;

  observer = new MutationObserver((mutations) => {
    if (!chrome.runtime?.id) {
      stopObserver();
      return;
    }
    let hasAdditions = false;
    const addedNodes = [];

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
            // Ignore own tooltip modifications
            if (node.id === 'zh-lens-tooltip' || (node.parentElement && node.parentElement.id === 'zh-lens-tooltip')) {
              continue;
            }
            addedNodes.push(node);
            hasAdditions = true;
          }
        }
      } else if (mutation.type === 'characterData') {
        const node = mutation.target;
        // Skip mutations occurring within our own ruby structures or tooltips
        let parent = node.parentElement;
        let insideOwnElement = false;
        while (parent) {
          const tag = parent.tagName.toLowerCase();
          if (tag === 'ruby' && parent.classList.contains('zh-lens-word')) {
            insideOwnElement = true;
            break;
          }
          if (parent.id === 'zh-lens-tooltip') {
            insideOwnElement = true;
            break;
          }
          parent = parent.parentElement;
        }
        
        if (!insideOwnElement && isValidChineseTextNode(node)) {
          addedNodes.push(node);
          hasAdditions = true;
        }
      }
    }

    if (hasAdditions) {
      scheduleScan(addedNodes);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true // Observe direct text edits
  });
}

function stopObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function scheduleScan(nodes) {
  pendingNodesToScan.push(...nodes);
  if (scanTimeout) clearTimeout(scanTimeout);

  scanTimeout = setTimeout(() => {
    const nodesToProcess = [...pendingNodesToScan];
    pendingNodesToScan = [];
    scanAndProcessNodes(nodesToProcess);
  }, 250);
}

// Tooltip Management
function getOrCreateTooltip() {
  if (tooltipElement) return tooltipElement;

  tooltipElement = document.getElementById('zh-lens-tooltip');
  if (tooltipElement) return tooltipElement;

  tooltipElement = document.createElement('div');
  tooltipElement.id = 'zh-lens-tooltip';
  document.body.appendChild(tooltipElement);
  return tooltipElement;
}

function showTooltip(rubyElement) {
  if (!isEnabled) return;
  
  const simplified = rubyElement.getAttribute('data-simplified');
  const traditional = rubyElement.getAttribute('data-traditional');
  const readingsData = rubyElement.getAttribute('data-readings');

  if (!simplified || !readingsData) return;

  const readings = JSON.parse(readingsData);
  if (readings.length === 0) return;

  const tooltip = getOrCreateTooltip();

  // Create markup
  let html = `
    <div class="zh-lens-tooltip-header">
      <span class="zh-lens-tooltip-chars">${simplified}</span>
  `;

  if (traditional && traditional !== simplified) {
    html += `<span class="zh-lens-tooltip-trad">(${traditional})</span>`;
  }

  html += `</div><div class="zh-lens-tooltip-divider"></div>`;

  readings.forEach((reading, index) => {
    const englishHTML = reading.english.map(def => `<li>${escapeHTML(def)}</li>`).join('');
    const toneMarkedPinyin = convertPinyinString(reading.pinyin);
    html += `
      <div class="zh-lens-tooltip-reading">
        <div class="zh-lens-tooltip-pinyin">${escapeHTML(toneMarkedPinyin)}</div>
        <ol class="zh-lens-tooltip-defs">
          ${englishHTML}
        </ol>
      </div>
    `;
    if (index < readings.length - 1) {
      html += `<div class="zh-lens-tooltip-divider" style="opacity: 0.4; margin: 8px 0;"></div>`;
    }
  });

  tooltip.innerHTML = html;
  tooltip.classList.add('zh-lens-tooltip-visible');

  positionTooltip(rubyElement, tooltip);
}

function hideTooltip() {
  if (tooltipElement) {
    tooltipElement.classList.remove('zh-lens-tooltip-visible');
  }
}

function positionTooltip(ruby, tooltip) {
  const rect = ruby.getBoundingClientRect();

  // Reset positioning for bounds evaluation
  tooltip.style.left = '0px';
  tooltip.style.top = '0px';
  tooltip.style.transform = 'none';

  const tooltipRect = tooltip.getBoundingClientRect();

  let left = rect.left + rect.width / 2 + window.scrollX;
  let top = rect.top + window.scrollY;
  let transform = 'translate(-50%, -100%) translateY(-10px)';

  // Flip tooltip below element if it overflows top of page
  if (rect.top - tooltipRect.height - 15 < 0) {
    top = rect.bottom + window.scrollY;
    transform = 'translate(-50%, 0) translateY(10px)';
  }

  // Bound checks on screen edges
  const viewportWidth = window.innerWidth;
  const halfWidth = tooltipRect.width / 2;
  const targetX = rect.left + rect.width / 2;

  if (targetX - halfWidth < 10) {
    left = 10 + halfWidth + window.scrollX;
  } else if (targetX + halfWidth > viewportWidth - 10) {
    left = viewportWidth - 10 - halfWidth + window.scrollX;
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  tooltip.style.transform = transform;
}

function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Toggle translation mode active state and class on body
function toggleTranslationMode(forceState) {
  const nextState = (forceState !== undefined) ? forceState : !isTranslationMode;
  if (isTranslationMode === nextState) return; // Avoid redundant toggles

  isTranslationMode = nextState;

  if (isTranslationMode) {
    document.body.classList.add('zh-lens-translation-active');
    translatePageSentences();
    // If translation is turned ON, we turn Pinyin OFF
    if (isPinyinEnabled) {
      togglePinyinMode(false);
    }
  } else {
    document.body.classList.remove('zh-lens-translation-active');
  }

  chrome.storage.local.set({ translationMode: isTranslationMode });
}

// Toggle Pinyin display mode
function togglePinyinMode(forceState) {
  const nextState = (forceState !== undefined) ? forceState : !isPinyinEnabled;
  if (isPinyinEnabled === nextState) return; // Avoid redundant toggles

  isPinyinEnabled = nextState;

  if (isPinyinEnabled) {
    document.body.classList.remove('zh-lens-pinyin-disabled');
    // If Pinyin is turned ON, we turn Translation OFF
    if (isTranslationMode) {
      toggleTranslationMode(false);
    }
  } else {
    document.body.classList.add('zh-lens-pinyin-disabled');
  }

  chrome.storage.local.set({ pinyinEnabled: isPinyinEnabled });
}

// Event Listeners
function setupEventListeners() {
  // Event Delegation for hover triggers
  document.body.addEventListener('mouseover', (e) => {
    const ruby = e.target.closest('ruby.zh-lens-word');
    if (ruby && isAltPressed) {
      showTooltip(ruby);
    }
  });

  document.body.addEventListener('mouseout', (e) => {
    const ruby = e.target.closest('ruby.zh-lens-word');
    if (ruby) {
      hideTooltip();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return; // Prevent OS key-repeat from triggering multiple toggles

    if (e.key === 'Alt') {
      isAltPressed = true;
      const hoveredRuby = document.querySelector('ruby.zh-lens-word:hover');
      if (hoveredRuby) {
        showTooltip(hoveredRuby);
      }
    }

    // Toggle translation on Alt+Q key combination press
    if (e.altKey && (e.key.toLowerCase() === 'q' || e.code === 'KeyQ')) {
      if (isTranslationMode) {
        togglePinyinMode(true);
      } else {
        toggleTranslationMode(true);
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      isAltPressed = false;
      hideTooltip();
    }
  });

  window.addEventListener('blur', () => {
    isAltPressed = false;
    hideTooltip();
  });
}

// Listen for messages from popup or background commands
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TOGGLE_TRANSLATION_MODE') {
    // Swap modes: if Translation Mode is active, switch to Pinyin, and vice-versa
    if (isTranslationMode) {
      togglePinyinMode(true);
    } else {
      toggleTranslationMode(true);
    }
    if (sendResponse) sendResponse({ success: true, isTranslationMode, isPinyinEnabled });
  }

  // Popup polls this to render its translation loading bar / verification link.
  if (message.type === 'GET_TRANSLATION_STATUS') {
    sendResponse({ ...translationStatus, isTranslationMode });
  }
});

// Initialize Extension Settings
chrome.storage.local.get({ enabled: true, pinyinEnabled: true, translationMode: false, translationEngine: 'auto' }, (settings) => {
  isEnabled = settings.enabled;
  isPinyinEnabled = settings.pinyinEnabled;
  isTranslationMode = settings.translationMode;
  translationEngine = settings.translationEngine;
  if (isEnabled) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onPageLoad);
    } else {
      onPageLoad();
    }
  }
});

// React to global settings toggle changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) {
    isEnabled = changes.enabled.newValue;
    if (isEnabled) {
      onPageLoad();
    } else {
      stopObserver();
      hideTooltip();
    }
  }
  if (changes.translationMode) {
    toggleTranslationMode(changes.translationMode.newValue);
  }
  if (changes.pinyinEnabled) {
    togglePinyinMode(changes.pinyinEnabled.newValue);
  }
  if (changes.translationEngine) {
    translationEngine = changes.translationEngine.newValue;
    // Give the newly chosen engine a fresh attempt (the built-in latch may have
    // tripped under 'auto') and re-translate the visible page with it.
    translatorUnavailable = false;
    translatorPromise = null;
    if (isTranslationMode) {
      translationCache.clear();
      clearTranslationsInDom();
      translatePageSentences();
    }
  }
});

// Clear rendered sentence translations so a re-translate (e.g. after switching
// engines) repopulates them from scratch.
function clearTranslationsInDom() {
  document.querySelectorAll('.zh-lens-sentence').forEach(elem => {
    const transSpan = elem.querySelector('.zh-lens-sentence-translated-text');
    if (transSpan) transSpan.textContent = '';
    elem.removeAttribute('data-translated');
  });
}

function onPageLoad() {
  scanAndProcessNodes([document.body]).then(() => {
    // Apply initial toggles on load
    if (!isPinyinEnabled) {
      document.body.classList.add('zh-lens-pinyin-disabled');
    }
    if (isTranslationMode) {
      document.body.classList.add('zh-lens-translation-active');
      translatePageSentences();
    }
  });
  startObserver();
  setupEventListeners();
}

// Tone-Mark Pinyin Conversion Helpers
const TONE_MAP = {
  'a': ['a', 'ā', 'á', 'ǎ', 'à', 'a'],
  'o': ['o', 'ō', 'ó', 'ǒ', 'ò', 'o'],
  'e': ['e', 'ē', 'é', 'ě', 'è', 'e'],
  'i': ['i', 'ī', 'í', 'ǐ', 'ì', 'i'],
  'u': ['u', 'ū', 'ú', 'ǔ', 'ù', 'u'],
  'ü': ['ü', 'ǖ', 'ǘ', 'ǚ', 'ǜ', 'ü'],
  'A': ['A', 'Ā', 'Á', 'Ǎ', 'À', 'A'],
  'O': ['O', 'Ō', 'Ó', 'Ǒ', 'Ò', 'O'],
  'E': ['E', 'Ē', 'É', 'Ě', 'È', 'E'],
  'I': ['I', 'Ī', 'Í', 'Ǐ', 'Ì', 'I'],
  'U': ['U', 'Ū', 'Ú', 'Ǔ', 'Ù', 'U'],
  'Ü': ['Ü', 'Ǖ', 'Ǘ', 'Ǚ', 'Ǜ', 'Ü']
};

function addToneMark(base, tone) {
  if (tone < 1 || tone > 4) return base; // neutral tone has no marks
  
  let idx = base.search(/[aA]/);
  if (idx !== -1) {
    const char = base[idx];
    return base.slice(0, idx) + TONE_MAP[char][tone] + base.slice(idx + 1);
  }
  
  idx = base.search(/[eE]/);
  if (idx !== -1) {
    const char = base[idx];
    return base.slice(0, idx) + TONE_MAP[char][tone] + base.slice(idx + 1);
  }
  
  idx = base.search(/ou|OU|Ou|oU/);
  if (idx !== -1) {
    const char = base[idx]; // 'o' or 'O'
    return base.slice(0, idx) + TONE_MAP[char][tone] + base.slice(idx + 1);
  }
  
  idx = base.search(/ui|UI|uI|Ui/);
  if (idx !== -1) {
    const iIdx = idx + 1;
    const char = base[iIdx];
    return base.slice(0, iIdx) + TONE_MAP[char][tone] + base.slice(iIdx + 1);
  }
  idx = base.search(/iu|IU|iU|Iu/);
  if (idx !== -1) {
    const uIdx = idx + 1;
    const char = base[uIdx];
    return base.slice(0, uIdx) + TONE_MAP[char][tone] + base.slice(uIdx + 1);
  }
  
  idx = base.search(/[oOiIuUüÜ]/);
  if (idx !== -1) {
    const char = base[idx];
    return base.slice(0, idx) + TONE_MAP[char][tone] + base.slice(idx + 1);
  }
  
  return base;
}

function convertSyllable(syllable) {
  const match = syllable.match(/^([a-zA-ZüÜvV:]+)([1-5])?$/);
  if (!match) {
    return { marked: syllable, tone: 5 };
  }
  
  let base = match[1];
  const tone = match[2] ? parseInt(match[2], 10) : 5;
  
  // Clean u-umlaut notations
  base = base.replace(/u:/g, 'ü').replace(/U:/g, 'Ü').replace(/v/g, 'ü').replace(/V/g, 'Ü');
  const marked = addToneMark(base, tone);
  return { marked, tone };
}

function convertPinyinString(pinyinStr) {
  if (!pinyinStr) return '';
  return pinyinStr.split(/\s+/).map(s => convertSyllable(s).marked).join(' ');
}
