// content.js
// Chrome Extension Content Script for Zh-Lens

let observer = null;
let isAltPressed = false;
let tooltipElement = null;
let isEnabled = true;
let isPinyinEnabled = true;

// Track context invalidation state when extension is reloaded/updated
let isContextInvalidated = false;

// Store event listener references so we can remove them on context invalidation cleanup
let mouseOverListener = null;
let mouseOutListener = null;
let keyDownListener = null;
let keyUpListener = null;
let blurListener = null;

// Debouncing mechanism for MutationObserver
let scanTimeout = null;
let pendingNodesToScan = [];

// Check if extension context has been invalidated
function checkContextInvalidated() {
  if (isContextInvalidated) return true;

  let invalidated = false;
  try {
    if (!chrome.runtime || !chrome.runtime.id) {
      invalidated = true;
    }
  } catch (e) {
    invalidated = true;
  }

  if (invalidated) {
    isContextInvalidated = true;
    cleanUpInvalidatedContext();
  }

  return isContextInvalidated;
}

// Clean up resources, mutation observers, and event listeners when context becomes invalid
function cleanUpInvalidatedContext() {
  stopObserver();
  hideTooltip();

  if (mouseOverListener) {
    document.body.removeEventListener('mouseover', mouseOverListener);
    mouseOverListener = null;
  }
  if (mouseOutListener) {
    document.body.removeEventListener('mouseout', mouseOutListener);
    mouseOutListener = null;
  }
  if (keyDownListener) {
    window.removeEventListener('keydown', keyDownListener);
    keyDownListener = null;
  }
  if (keyUpListener) {
    window.removeEventListener('keyup', keyUpListener);
    keyUpListener = null;
  }
  if (blurListener) {
    window.removeEventListener('blur', blurListener);
    blurListener = null;
  }

  if (tooltipElement && tooltipElement.parentNode) {
    tooltipElement.parentNode.removeChild(tooltipElement);
    tooltipElement = null;
  }
}

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


// Run FMM batch segmentation and DOM replacement
async function scanAndProcessNodes(roots) {
  if (checkContextInvalidated()) return;
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

      for (const seg of segments) {
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

          fragment.appendChild(ruby);
        } else {
          // Plain non-Chinese segment
          fragment.appendChild(document.createTextNode(seg.word));
        }
      }

      node.parentNode.replaceChild(fragment, node);
    }
  } catch (error) {
    if (error.message && error.message.includes('context invalidated')) {
      isContextInvalidated = true;
      cleanUpInvalidatedContext();
      return;
    }
    console.error('Zh-Lens DOM Processing Error:', error);
  } finally {
    if (!isContextInvalidated) {
      // Re-engage observer
      startObserver();
    }
  }
}

// Set up MutationObserver
function startObserver() {
  if (checkContextInvalidated()) return;
  if (observer || !isEnabled) return;

  observer = new MutationObserver((mutations) => {
    if (checkContextInvalidated()) return;
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
    if (checkContextInvalidated()) return;
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

// Toggle Pinyin display mode
function togglePinyinMode(forceState) {
  if (checkContextInvalidated()) return;
  const nextState = (forceState !== undefined) ? forceState : !isPinyinEnabled;
  if (isPinyinEnabled === nextState) return; // Avoid redundant toggles

  isPinyinEnabled = nextState;

  if (isPinyinEnabled) {
    document.body.classList.remove('zh-lens-pinyin-disabled');
  } else {
    document.body.classList.add('zh-lens-pinyin-disabled');
  }

  chrome.storage.local.set({ pinyinEnabled: isPinyinEnabled });
}

// Event Listeners
function setupEventListeners() {
  if (checkContextInvalidated()) return;

  // Event Delegation for hover triggers
  mouseOverListener = (e) => {
    if (checkContextInvalidated()) return;
    const ruby = e.target.closest('ruby.zh-lens-word');
    if (ruby && isAltPressed) {
      showTooltip(ruby);
    }
  };
  document.body.addEventListener('mouseover', mouseOverListener);

  mouseOutListener = (e) => {
    if (checkContextInvalidated()) return;
    const ruby = e.target.closest('ruby.zh-lens-word');
    if (ruby) {
      hideTooltip();
    }
  };
  document.body.addEventListener('mouseout', mouseOutListener);

  keyDownListener = (e) => {
    if (checkContextInvalidated()) return;
    if (e.repeat) return; // Prevent OS key-repeat from triggering multiple toggles

    if (e.key === 'Alt') {
      isAltPressed = true;
      const hoveredRuby = document.querySelector('ruby.zh-lens-word:hover');
      if (hoveredRuby) {
        showTooltip(hoveredRuby);
      }
    }

    // Toggle pinyin display on Alt+Q key combination press
    if (e.altKey && (e.key.toLowerCase() === 'q' || e.code === 'KeyQ')) {
      togglePinyinMode(!isPinyinEnabled);
    }
  };
  window.addEventListener('keydown', keyDownListener);

  keyUpListener = (e) => {
    if (checkContextInvalidated()) return;
    if (e.key === 'Alt') {
      isAltPressed = false;
      hideTooltip();
    }
  };
  window.addEventListener('keyup', keyUpListener);

  blurListener = () => {
    if (checkContextInvalidated()) return;
    isAltPressed = false;
    hideTooltip();
  };
  window.addEventListener('blur', blurListener);
}

// Listen for messages from popup or background commands
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TOGGLE_PINYIN_MODE') {
    togglePinyinMode(!isPinyinEnabled);
    if (sendResponse) sendResponse({ success: true, isPinyinEnabled });
  }
});

// Initialize Extension Settings
chrome.storage.local.get({ enabled: true, pinyinEnabled: true }, (settings) => {
  isEnabled = settings.enabled;
  isPinyinEnabled = settings.pinyinEnabled;
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
  if (checkContextInvalidated()) return;
  if (changes.enabled) {
    isEnabled = changes.enabled.newValue;
    if (isEnabled) {
      onPageLoad();
    } else {
      stopObserver();
      hideTooltip();
    }
  }

  if (changes.pinyinEnabled) {
    togglePinyinMode(changes.pinyinEnabled.newValue);
  }
});

function onPageLoad() {
  scanAndProcessNodes([document.body]).then(() => {
    // Apply initial toggles on load
    if (!isPinyinEnabled) {
      document.body.classList.add('zh-lens-pinyin-disabled');
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
