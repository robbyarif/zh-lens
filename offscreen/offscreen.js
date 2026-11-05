// offscreen/offscreen.js
// Hosts Tesseract.js in an offscreen document. A service worker cannot create
// the Web Workers Tesseract needs, and content scripts cannot fetch
// cross-origin images, so the background worker delegates OCR here.

const ALLOWED_LANGS = ['chi_tra', 'chi_sim'];
const OCR_TIMEOUT_MS = 90000;
const workerPromises = new Map(); // lang -> Promise<Worker>
let lastStage = 'idle'; // last Tesseract status, reported if OCR stalls

// Race a promise against a timeout so a stalled worker reports where it got stuck
// instead of leaving the overlay on "Recognizing…" forever.
function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`OCR timed out during "${lastStage}" (${label}). See the offscreen console.`));
    }, OCR_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Create one Tesseract worker per script and reuse it. The first call for a
// script loads the WASM engine and that model, which takes a few seconds.
function getWorker(lang) {
  if (!workerPromises.has(lang)) {
    const creating = Tesseract.createWorker(lang, 1, {
      workerPath: chrome.runtime.getURL('ocr/worker.min.js'),
      // By default Tesseract wraps the worker in a blob: URL that calls
      // importScripts() on the extension file, which Chrome blocks. Use the
      // extension URL directly instead.
      workerBlobURL: false,
      corePath: chrome.runtime.getURL('ocr/core/'),
      langPath: chrome.runtime.getURL('ocr/lang/'),
      logger: (m) => {
        lastStage = `${m.status} ${Math.round((m.progress || 0) * 100)}%`;
        console.log('Zh-Lens OCR:', lastStage);
      },
    });
    const promise = withTimeout(creating, `load ${lang}`).catch((error) => {
      console.error('Zh-Lens OCR: worker failed to start.', error);
      workerPromises.delete(lang); // allow a retry on the next request
      throw error;
    });
    workerPromises.set(lang, promise);
  }
  return workerPromises.get(lang);
}

// Flatten Tesseract's block > paragraph > line > word tree into a flat list.
function collectWords(data) {
  const words = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          words.push({ text: word.text, confidence: word.confidence, bbox: word.bbox });
        }
      }
    }
  }
  if (words.length === 0 && Array.isArray(data.words)) {
    for (const word of data.words) {
      words.push({ text: word.text, confidence: word.confidence, bbox: word.bbox });
    }
  }
  return words;
}

async function recognizeImage(srcUrl, lang) {
  if (!ALLOWED_LANGS.includes(lang)) throw new Error(`Unknown OCR script: ${lang}`);

  // Extension pages with host permissions can fetch cross-origin images.
  const response = await fetch(srcUrl, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Image request failed (HTTP ${response.status})`);
  }
  const blob = await response.blob();

  // Natural pixel size, so content.js can scale Tesseract's boxes to the
  // displayed image.
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  bitmap.close();

  const worker = await getWorker(lang);
  lastStage = 'recognizing';
  const { data } = await withTimeout(worker.recognize(blob, {}, { blocks: true }), 'recognize').catch((error) => {
    // Drop the worker so the next attempt starts clean.
    workerPromises.delete(lang);
    throw error;
  });

  return { width, height, words: collectWords(data) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen' || message.type !== 'OCR_RUN') return false;

  recognizeImage(message.srcUrl, message.lang)
    .then((result) => sendResponse({ success: true, ...result }))
    .catch((error) => sendResponse({ success: false, error: error.message || String(error) }));
  return true; // respond asynchronously
});
