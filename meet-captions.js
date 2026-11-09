// meet-captions.js
// Live captions for Google Meet, shown in a floating Document Picture-in-Picture
// window. The window mirrors Meet's caption feed: one block per speaker turn,
// Chinese sentence (with pinyin and word tooltips) and its English translation.
// Meet's own caption elements are only read, never changed.
// Self-contained: the pinyin helpers and tone colors mirror content.js so the
// window looks like the page annotation, without depending on that script.

(() => {
  if (window.__zhLensMeetCaptions) return;
  window.__zhLensMeetCaptions = true;

  const CAPTION_REGION = '[aria-label="Captions"]';
  const TEXT_SELECTOR = '.ygicle';
  const BUTTON_ID = 'zh-lens-pip-btn';
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
  const CJK_ONLY = /[^\u3400-\u4dbf\u4e00-\u9fff]/g;
  const SENTENCE_END = /[。？！?!]/g;
  const SENTENCE_RE = /[^。？！?!]*[。？！?!]/g;
  const DEBOUNCE_MS = 300;         // process captions shortly after a change
  const IDLE_FLUSH_MS = 3000;      // treat an unpunctuated tail as a sentence after a pause
  const REVISION_SIMILARITY = 0.85; // fuzzy match needed to treat two long sentences as one
  const MAX_TURNS = 60;            // speaker turns kept in the window
  const CATCHUP_BLOCKS = 3;        // when the window opens, process only the last few captions
  const WINDOW_SIZE = { width: 420, height: 400 };

  // Same tone-mark tables and rules as content.js (convertSyllable / addToneMark).
  const TONE_MAP = {
    'a': ['a', 'ā', 'á', 'ǎ', 'à', 'a'], 'o': ['o', 'ō', 'ó', 'ǒ', 'ò', 'o'],
    'e': ['e', 'ē', 'é', 'ě', 'è', 'e'], 'i': ['i', 'ī', 'í', 'ǐ', 'ì', 'i'],
    'u': ['u', 'ū', 'ú', 'ǔ', 'ù', 'u'], 'ü': ['ü', 'ǖ', 'ǘ', 'ǚ', 'ǜ', 'ü'],
    'A': ['A', 'Ā', 'Á', 'Ǎ', 'À', 'A'], 'O': ['O', 'Ō', 'Ó', 'Ǒ', 'Ò', 'O'],
    'E': ['E', 'Ē', 'É', 'Ě', 'È', 'E'], 'I': ['I', 'Ī', 'Í', 'Ǐ', 'Ì', 'I'],
    'U': ['U', 'Ū', 'Ú', 'Ǔ', 'Ù', 'U'], 'Ü': ['Ü', 'Ǖ', 'Ǘ', 'Ǚ', 'Ǜ', 'Ü'],
  };

  function addToneMark(base, tone) {
    if (tone < 1 || tone > 4) return base;
    let idx = base.search(/[aA]/);
    if (idx !== -1) return base.slice(0, idx) + TONE_MAP[base[idx]][tone] + base.slice(idx + 1);
    idx = base.search(/[eE]/);
    if (idx !== -1) return base.slice(0, idx) + TONE_MAP[base[idx]][tone] + base.slice(idx + 1);
    idx = base.search(/ou|OU|Ou|oU/);
    if (idx !== -1) return base.slice(0, idx) + TONE_MAP[base[idx]][tone] + base.slice(idx + 1);
    idx = base.search(/ui|UI|uI|Ui/);
    if (idx !== -1) {
      const iIdx = idx + 1;
      return base.slice(0, iIdx) + TONE_MAP[base[iIdx]][tone] + base.slice(iIdx + 1);
    }
    idx = base.search(/iu|IU|iU|Iu/);
    if (idx !== -1) {
      const uIdx = idx + 1;
      return base.slice(0, uIdx) + TONE_MAP[base[uIdx]][tone] + base.slice(uIdx + 1);
    }
    idx = base.search(/[oOiIuUüÜ]/);
    if (idx !== -1) return base.slice(0, idx) + TONE_MAP[base[idx]][tone] + base.slice(idx + 1);
    return base;
  }

  function convertSyllable(syllable) {
    const match = syllable.match(/^([a-zA-ZüÜvV:]+)([1-5])?$/);
    if (!match) return { marked: syllable, tone: 5 };
    let base = match[1];
    const tone = match[2] ? parseInt(match[2], 10) : 5;
    base = base.replace(/u:/g, 'ü').replace(/U:/g, 'Ü').replace(/v/g, 'ü').replace(/V/g, 'Ü');
    return { marked: addToneMark(base, tone), tone };
  }

  function convertPinyinString(pinyinStr) {
    if (!pinyinStr) return '';
    return pinyinStr.split(/\s+/).map((s) => convertSyllable(s).marked).join(' ');
  }

  const PIP_CSS = `
    html, body { margin: 0; height: 100%; background: #202124; color: #e8eaed;
      font-family: "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif; }
    body { --scale: 1; display: flex; flex-direction: column; box-sizing: border-box; }

    .toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 4px;
      padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .toolbar button { background: rgba(255,255,255,0.08); border: none; color: #e8eaed;
      border-radius: 6px; padding: 2px 8px; font: 600 12px system-ui, sans-serif; cursor: pointer; }
    .toolbar button:hover { background: rgba(255,255,255,0.16); }
    .toolbar button.on { background: #10b981; color: #052e16; }

    .feed { flex: 1; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 14px; }
    .turn .speaker { font-size: calc(12px * var(--scale)); color: #9aa0a6; margin-bottom: 2px; }
    .line + .line { margin-top: 6px; }
    .zh { font-size: calc(18px * var(--scale)); line-height: 1.5; color: #e8eaed; }
    .en { font-size: calc(16px * var(--scale)); line-height: 1.4; color: #81c995; margin-top: 2px; }
    .en.pending { color: #5f6368; }

    /* Pinyin annotation, styled like the page annotation in styles.css */
    ruby.zh-lens-word { ruby-position: over; -webkit-ruby-position: before; border-bottom: 1px dashed rgba(16,185,129,0.35);
      padding-bottom: 1px; margin: 0 1px; cursor: help; }
    ruby.zh-lens-word:hover { background-color: rgba(16,185,129,0.08); border-bottom-color: #10b981; }
    ruby.zh-lens-word > rt { font-size: 0.45em; font-weight: 600; color: #059669; text-align: center; user-select: none; }
    ruby.zh-lens-word > rt.zh-tone-1 { color: #ef4444 !important; }
    ruby.zh-lens-word > rt.zh-tone-2 { color: #f97316 !important; }
    ruby.zh-lens-word > rt.zh-tone-3 { color: #22c55e !important; }
    ruby.zh-lens-word > rt.zh-tone-4 { color: #3b82f6 !important; }
    ruby.zh-lens-word > rt.zh-tone-5 { color: #64748b !important; }
    body.no-pinyin ruby.zh-lens-word > rt { display: none !important; }
    body.no-pinyin ruby.zh-lens-word { ruby-position: initial; -webkit-ruby-position: initial; }

    /* Word tooltip, styled like #zh-lens-tooltip in styles.css */
    #zh-lens-tooltip { position: fixed; z-index: 10; background: #0f172a; border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px; padding: 12px 14px; color: #f8fafc; font-family: system-ui, sans-serif;
      box-shadow: 0 10px 30px -5px rgba(0,0,0,0.5); width: max-content; max-width: 300px;
      pointer-events: none; opacity: 0; line-height: 1.4; transition: opacity 0.12s; }
    #zh-lens-tooltip.visible { opacity: 1; }
    .tt-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
    .tt-chars { font-size: 1.35em; font-weight: bold; color: #34d399; letter-spacing: 0.5px; }
    .tt-trad { font-size: 0.85em; color: #94a3b8; }
    .tt-divider { height: 1px; background: rgba(255,255,255,0.08); margin: 8px 0; }
    .tt-reading { margin-bottom: 8px; }
    .tt-reading:last-child { margin-bottom: 0; }
    .tt-pinyin { font-size: 0.92em; font-weight: 700; color: #f59e0b; margin-bottom: 2px; }
    .tt-defs { padding-left: 18px; margin: 4px 0 0; color: #e2e8f0; font-size: 0.82em; }

    .live { min-height: 1.5em; padding: 6px 14px; font-size: calc(16px * var(--scale)); color: #9aa0a6;
      border-top: 1px solid rgba(255,255,255,0.08); line-height: 1.4; }
  `;

  let enabled = true;
  let region = null;
  let regionObserver = null;
  let pipWindow = null;
  let pipView = null;             // { addSentence(block, speaker, zh), setLive(text) }
  let lastBlock = null;           // caption block that changed most recently
  const cache = new Map();        // Chinese sentence -> English
  const segCache = new Map();     // Chinese sentence -> dictionary segments (for pinyin)
  let recordsByBlock = new WeakMap(); // caption block -> [{ zh, entry }] sentences shown for it
  const blockTimers = new WeakMap();
  let queue = Promise.resolve();  // keeps translations in caption order

  // ---- Translation ---------------------------------------------------------

  let translatorPromise = null;
  let translatorUnavailable = false;

  // Built-in Chrome Translator API (Chrome 138+). Returns null when unusable,
  // in which case we fall back to the gtx path in the background worker.
  async function getBuiltInTranslator() {
    if (translatorUnavailable) return null;
    if (translatorPromise) return translatorPromise;
    if (typeof Translator === 'undefined') {
      translatorUnavailable = true;
      return null;
    }

    translatorPromise = (async () => {
      const availability = await Translator.availability({ sourceLanguage: 'zh', targetLanguage: 'en' });
      if (!['available', 'downloadable', 'downloading'].includes(availability)) {
        translatorUnavailable = true;
        return null;
      }
      // Model download needs a user gesture; defer rather than reject.
      if (availability !== 'available' && !navigator.userActivation?.isActive) {
        throw new Error('built-in model needs download; deferring until a user gesture');
      }
      return Translator.create({ sourceLanguage: 'zh', targetLanguage: 'en' });
    })().catch((error) => {
      console.warn('Zh-Lens (Meet): Built-in Translator unavailable, using gtx fallback.', error);
      translatorPromise = null; // allow a later retry
      return null;
    });

    return translatorPromise;
  }

  async function translateText(text) {
    const translator = await getBuiltInTranslator();
    if (translator) {
      try {
        const out = await translator.translate(text);
        if (out) return out.trim();
      } catch (error) {
        console.warn('Zh-Lens (Meet): built-in translate() failed.', error);
      }
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH', texts: [text] });
      if (response?.success && Array.isArray(response.result)) {
        return response.result.find((r) => r.source === text)?.translated?.trim() || null;
      }
    } catch (error) {
      // Extension reloaded or context invalidated; nothing to do.
    }
    return null;
  }

  // Dictionary segmentation with readings and meanings, from the extension's
  // background worker (the same lookup that drives pinyin on normal pages).
  async function segmentText(text) {
    if (segCache.has(text)) return segCache.get(text);
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SEGMENT_BATCH', texts: [text] });
      if (response?.success && Array.isArray(response.result) && response.result[0]) {
        segCache.set(text, response.result[0]);
        return response.result[0];
      }
    } catch (error) {
      // Extension reloaded or context invalidated; show the text without pinyin.
    }
    return null;
  }

  // ---- Caption text --------------------------------------------------------

  function normalize(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  // Plain Chinese text of a caption block. content.js wraps characters in
  // <ruby> with pinyin in <rt>/<rp>, which textContent would include (even when
  // the pinyin is hidden by CSS), so skip those text nodes.
  function captionText(block) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest('rt, rp') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let out = '';
    while (walker.nextNode()) out += walker.currentNode.nodeValue;
    return out;
  }

  function speakerOf(block) {
    return block.closest('.nMcdL')?.querySelector('.NWpY1d')?.textContent.trim() || '';
  }

  // Text without punctuation or spaces, so a sentence still matches its own
  // continuation when Meet adds or moves a 。 or ，.
  const stripPunct = (s) => s.replace(/[\s，。！？、,.!?；;：:「」『』“”"'（）()]/g, '');

  // Similarity of two Chinese strings by shared character pairs (Dice coefficient).
  function bigrams(s) {
    const t = s.replace(CJK_ONLY, '');
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  }

  function similarity(a, b) {
    const A = bigrams(a);
    const B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let common = 0;
    for (const x of A) if (B.has(x)) common++;
    return (2 * common) / (A.size + B.size);
  }

  // ---- Sentence handling ---------------------------------------------------

  // Renders a record's Chinese text (with pinyin) and English into the window, in order.
  function translateInto(record) {
    queue = queue.then(async () => {
      const zh = record.zh;
      const segments = await segmentText(zh);
      record.entry.update({ zh, segments });

      let en = cache.get(zh);
      if (!en) {
        en = await translateText(zh);
        if (en) cache.set(zh, en);
      }
      record.entry.update({ en: en || '(translation unavailable)' });
    });
  }

  function addRecord(block, zh) {
    const record = { zh, entry: pipView.addSentence(block, speakerOf(block), zh) };
    translateInto(record);
    return record;
  }

  // Shows a finished sentence once. If Meet extended or rewrote a sentence already
  // shown from this caption block, that line is updated instead of added again.
  function syncSentence(block, sentence) {
    let records = recordsByBlock.get(block);
    if (!records) {
      records = [];
      recordsByBlock.set(block, records);
    }
    if (records.some((r) => r.zh === sentence)) return;

    const key = stripPunct(sentence);
    for (const r of records) {
      const rk = stripPunct(r.zh);
      const related = rk.startsWith(key) || key.startsWith(rk)
        || (key.length >= 6 && rk.length >= 6 && similarity(r.zh, sentence) >= REVISION_SIMILARITY);
      if (!related) continue;
      // A shorter fragment of a sentence already shown adds nothing new.
      if (rk.startsWith(key) && key.length < rk.length) return;
      r.zh = sentence;
      r.entry.update({ zh: sentence, segments: null });
      translateInto(r);
      return;
    }
    records.push(addRecord(block, sentence));
  }

  // Finished sentences (ending in 。？！) are shown as they complete. The unfinished
  // tail is shown as live text, and is treated as a sentence after a pause (flushAll).
  function processBlock(block, flushAll) {
    if (!enabled || !pipView || !block.isConnected) return;

    const full = normalize(captionText(block));
    if (!CJK.test(full)) return;

    let lastEnd = 0;
    for (const m of full.matchAll(SENTENCE_END)) lastEnd = m.index + 1;
    const finished = full.slice(0, lastEnd);
    const tail = full.slice(lastEnd).trim();

    const sentences = (finished.match(SENTENCE_RE) || []).map((s) => s.trim()).filter((s) => CJK.test(s));
    if (flushAll && CJK.test(tail)) sentences.push(tail);
    sentences.forEach((s) => syncSentence(block, s));

    if (block === lastBlock) pipView.setLive(flushAll ? '' : tail);
  }

  function scheduleBlock(block) {
    lastBlock = block;
    const timers = blockTimers.get(block) || {};
    clearTimeout(timers.debounce);
    clearTimeout(timers.idle);
    timers.debounce = setTimeout(() => processBlock(block, false), DEBOUNCE_MS);
    timers.idle = setTimeout(() => processBlock(block, true), IDLE_FLUSH_MS);
    blockTimers.set(block, timers);
  }

  // ---- Observing the captions region --------------------------------------

  function onRegionMutations(mutations) {
    if (!enabled || !region) return;

    const touched = new Set();
    for (const m of mutations) {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const block = el?.closest(TEXT_SELECTOR);
      if (block && region.contains(block)) touched.add(block);
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.(TEXT_SELECTOR)) touched.add(n);
        n.querySelectorAll?.(TEXT_SELECTOR).forEach((b) => touched.add(b));
      }
    }
    touched.forEach(scheduleBlock);
  }

  function attachRegion(el) {
    if (regionObserver) regionObserver.disconnect();
    region = el;
    regionObserver = new MutationObserver(onRegionMutations);
    regionObserver.observe(region, { childList: true, subtree: true, characterData: true });
  }

  function detachRegion() {
    regionObserver?.disconnect();
    regionObserver = null;
    region = null;
  }

  // ---- Floating window (Document Picture-in-Picture) -----------------------

  function buildPipView(win) {
    const doc = win.document;
    const style = doc.createElement('style');
    style.textContent = PIP_CSS;
    doc.head.append(style);

    doc.body.innerHTML = `
      <div class="toolbar">
        <button type="button" data-act="pinyin" class="on">Pinyin</button>
        <button type="button" data-act="follow" class="on">Follow</button>
        <button type="button" data-act="smaller">A−</button>
        <button type="button" data-act="bigger">A+</button>
      </div>
      <div class="feed"></div>
      <div class="live"></div>`;

    const feed = doc.querySelector('.feed');
    const live = doc.querySelector('.live');
    const followBtn = doc.querySelector('[data-act="follow"]');
    const pinyinBtn = doc.querySelector('[data-act="pinyin"]');

    let follow = true;
    let scale = 1;
    const turns = new Map(); // caption block -> its speaker turn element

    const scrollToEnd = () => {
      if (follow) feed.scrollTop = feed.scrollHeight;
    };

    doc.querySelector('.toolbar').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'pinyin') {
        pinyinBtn.classList.toggle('on');
        doc.body.classList.toggle('no-pinyin', !pinyinBtn.classList.contains('on'));
      } else if (act === 'follow') {
        follow = !follow;
        followBtn.classList.toggle('on', follow);
        scrollToEnd();
      } else if (act === 'bigger' || act === 'smaller') {
        scale = Math.min(1.6, Math.max(0.8, scale + (act === 'bigger' ? 0.1 : -0.1)));
        doc.body.style.setProperty('--scale', scale.toFixed(2));
      }
    });

    // ---- Word tooltip (meanings and readings) -----------------------------

    const tooltip = doc.createElement('div');
    tooltip.id = 'zh-lens-tooltip';
    doc.body.append(tooltip);

    function el(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function showTooltip(ruby) {
      const simplified = ruby.getAttribute('data-simplified');
      const traditional = ruby.getAttribute('data-traditional');
      let readings = [];
      try {
        readings = JSON.parse(ruby.getAttribute('data-readings') || '[]');
      } catch (e) {
        readings = [];
      }
      if (!simplified || readings.length === 0) return;

      tooltip.textContent = '';
      const header = el('div', 'tt-header');
      header.append(el('span', 'tt-chars', simplified));
      if (traditional && traditional !== simplified) header.append(el('span', 'tt-trad', `(${traditional})`));
      tooltip.append(header, el('div', 'tt-divider'));

      readings.forEach((reading, index) => {
        const block = el('div', 'tt-reading');
        block.append(el('div', 'tt-pinyin', convertPinyinString(reading.pinyin)));
        const defs = el('ol', 'tt-defs');
        const list = Array.isArray(reading.english) ? reading.english : [String(reading.english || '')];
        list.forEach((def) => defs.append(el('li', null, def)));
        block.append(defs);
        tooltip.append(block);
        if (index < readings.length - 1) tooltip.append(el('div', 'tt-divider'));
      });

      tooltip.classList.add('visible');

      // Above the word, or below it when there is no room at the top.
      const rect = ruby.getBoundingClientRect();
      const tipHeight = tooltip.getBoundingClientRect().height;
      const left = Math.min(Math.max(rect.left + rect.width / 2, 150), win.innerWidth - 150);
      tooltip.style.left = `${left}px`;
      if (rect.top - tipHeight - 12 < 0) {
        tooltip.style.top = `${rect.bottom + 8}px`;
        tooltip.style.transform = 'translate(-50%, 0)';
      } else {
        tooltip.style.top = `${rect.top - 8}px`;
        tooltip.style.transform = 'translate(-50%, -100%)';
      }
    }

    function hideTooltip() {
      tooltip.classList.remove('visible');
    }

    feed.addEventListener('mouseover', (e) => {
      const ruby = e.target.closest?.('ruby.zh-lens-word');
      if (ruby) showTooltip(ruby);
    });
    feed.addEventListener('mouseout', (e) => {
      const ruby = e.target.closest?.('ruby.zh-lens-word');
      if (ruby && !ruby.contains(e.relatedTarget)) hideTooltip();
    });
    feed.addEventListener('scroll', hideTooltip);

    // ---- Captions ----------------------------------------------------------

    // Sentences from the same caption block go under one speaker turn, the same
    // way Meet groups a speaker's words together.
    function turnFor(block, speaker) {
      let turn = turns.get(block);
      if (!turn || !turn.isConnected) {
        turn = doc.createElement('div');
        turn.className = 'turn';
        const name = doc.createElement('div');
        name.className = 'speaker';
        name.textContent = speaker;
        turn.append(name);
        feed.append(turn);
        turns.set(block, turn);
        while (feed.querySelectorAll('.turn').length > MAX_TURNS) {
          feed.querySelector('.turn').remove();
        }
      }
      return turn;
    }

    // Chinese with pinyin, built the same way as the page annotation: one reading
    // per character when the dictionary splits the word cleanly, otherwise one
    // reading for the whole word. Each word carries its dictionary data for the tooltip.
    function renderZh(target, zh, segments) {
      target.textContent = '';
      if (!segments) {
        target.textContent = zh;
        return;
      }
      for (const seg of segments) {
        const readings = seg.entry?.readings || [];
        if (!seg.isChinese || readings.length === 0) {
          target.append(seg.word);
          continue;
        }

        const syllables = (readings[0].pinyin || '').split(/\s+/).filter(Boolean);
        const chars = Array.from(seg.word);

        const ruby = doc.createElement('ruby');
        ruby.className = 'zh-lens-word';
        ruby.setAttribute('data-simplified', seg.entry.simplified || seg.word);
        ruby.setAttribute('data-traditional', seg.entry.traditional || '');
        ruby.setAttribute('data-readings', JSON.stringify(readings));

        if (chars.length === syllables.length && syllables.length > 0) {
          chars.forEach((ch, i) => {
            const { marked, tone } = convertSyllable(syllables[i]);
            const rb = doc.createElement('rb');
            rb.textContent = ch;
            const rt = doc.createElement('rt');
            rt.textContent = marked;
            rt.className = `zh-tone-${tone} zh-pinyin`;
            ruby.append(rb, rt);
          });
        } else {
          const rb = doc.createElement('rb');
          rb.textContent = seg.word;
          const rt = doc.createElement('rt');
          rt.className = 'zh-pinyin';
          if (syllables.length > 0) {
            rt.textContent = syllables.map((s) => convertSyllable(s).marked).join(' ');
            if (syllables.length === 1) rt.className = `zh-tone-${convertSyllable(syllables[0]).tone} zh-pinyin`;
          }
          ruby.append(rb, rt);
        }
        target.append(ruby);
      }
    }

    return {
      addSentence(block, speaker, zh) {
        const turn = turnFor(block, speaker);

        const line = doc.createElement('div');
        line.className = 'line';
        const zhEl = doc.createElement('div');
        zhEl.className = 'zh';
        zhEl.textContent = zh;
        const enEl = doc.createElement('div');
        enEl.className = 'en pending';
        enEl.textContent = '…';
        line.append(zhEl, enEl);
        turn.append(line);

        scrollToEnd();
        return {
          // Any subset of { zh, segments, en }. segments === null shows plain text
          // until the next dictionary lookup arrives.
          update({ zh, segments, en }) {
            if (zh !== undefined) zhEl.dataset.zh = zh;
            if (zh !== undefined || segments !== undefined) {
              renderZh(zhEl, zhEl.dataset.zh || '', segments ?? null);
            }
            if (en !== undefined) {
              enEl.textContent = en;
              enEl.classList.remove('pending');
            }
            scrollToEnd();
          },
        };
      },
      setLive(text) {
        live.textContent = text;
      },
    };
  }

  function setButtonLabel(text, disabled = false) {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    btn.textContent = text;
    btn.disabled = disabled;
  }

  async function openWindow() {
    // Start the translator first, while this click's user activation is still
    // valid; a first-time model download needs it.
    getBuiltInTranslator();

    if (pipWindow) {
      pipWindow.focus();
      return;
    }
    if (!window.documentPictureInPicture) {
      setButtonLabel('English window needs Chrome 116+', true);
      return;
    }

    try {
      const win = await window.documentPictureInPicture.requestWindow(WINDOW_SIZE);
      pipWindow = win;
      pipView = buildPipView(win);
      recordsByBlock = new WeakMap(); // records from an earlier window point at its old DOM
      win.addEventListener('pagehide', () => {
        pipWindow = null;
        pipView = null;
        setButtonLabel('English window');
      });
      setButtonLabel('English window ✓');

      // Show the most recent captions already on screen.
      if (region) {
        const blocks = Array.from(region.querySelectorAll(TEXT_SELECTOR)).slice(-CATCHUP_BLOCKS);
        blocks.forEach((b) => processBlock(b, true));
      }
    } catch (error) {
      console.warn('Zh-Lens (Meet): could not open the English window.', error);
      setButtonLabel('English window (failed, click to retry)');
    }
  }

  function ensureButton() {
    if (document.getElementById(BUTTON_ID) || !document.body) return;
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = 'English window';
    btn.addEventListener('click', openWindow);
    document.body.append(btn);
  }

  function setButtonVisible(visible) {
    const btn = document.getElementById(BUTTON_ID);
    if (btn) btn.hidden = !visible;
  }

  // ---- Lifecycle and settings ---------------------------------------------

  // Meet mounts the captions region only when captions are turned on, and may
  // replace it later, so poll cheaply for a new or detached region.
  function ensureRegion() {
    if (!enabled) return;
    const found = document.querySelector(CAPTION_REGION);
    if (found && found !== region) attachRegion(found);
    if (region && !region.isConnected) detachRegion();
  }

  function setEnabled(value) {
    enabled = value;
    if (enabled) {
      ensureButton();
      setButtonVisible(true);
      ensureRegion();
    } else {
      detachRegion();
      pipWindow?.close();
      setButtonVisible(false);
    }
  }

  try {
    chrome.storage.local.get({ meetCaptionTranslation: true }, (settings) => {
      setEnabled(settings.meetCaptionTranslation);
    });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.meetCaptionTranslation) {
        setEnabled(changes.meetCaptionTranslation.newValue);
      }
    });
  } catch (error) {
    // Extension context gone (reloaded); the page keeps its current state.
  }

  setInterval(() => {
    if (enabled) ensureButton();
    ensureRegion();
  }, 1000);
})();
