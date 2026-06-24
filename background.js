// background.js
// Chrome Extension Background Service Worker for Zh-Lens

const DB_NAME = 'ZhLensDB';
const DB_VERSION = 2; // Incremented database version for out-of-line keys upgrade
const STORE_NAME = 'dictionary';

let dbInstance = null;
let dictKeysSet = new Set();
let isDbReady = false;

// Initialize IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME); // Out-of-line keys setup
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

async function getDB() {
  if (!dbInstance) {
    dbInstance = await openDB();
  }
  return dbInstance;
}

// Retrieve entry from IndexedDB
function getFromDB(db, key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

// Retrieve all keys from IndexedDB (for cache)
function getAllKeysFromDB(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAllKeys();
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

// Write a batch of entries in a single transaction
function writeBatchToDB(db, batch) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    transaction.oncomplete = () => resolve();
    transaction.onerror = (event) => reject(event.target.error);
    
    for (const item of batch) {
      store.put(item.entry, item.key); // Write entry keyed by either Simplified or Traditional
    }
  });
}

// Load keys from IndexedDB into memory Set
async function initMemoryCache() {
  try {
    const db = await getDB();
    console.log('Loading dictionary keys into memory cache...');
    const keys = await getAllKeysFromDB(db);
    dictKeysSet = new Set(keys);
    isDbReady = dictKeysSet.size > 0;
    console.log(`Memory cache ready. Loaded ${dictKeysSet.size} entries.`);
    return isDbReady;
  } catch (e) {
    console.error('Failed to load memory cache:', e);
    isDbReady = false;
    return false;
  }
}

// Parse CC-CEDICT file and seed IndexedDB
async function initializeDictionary() {
  try {
    console.log('Starting dictionary initialization...');
    await chrome.storage.local.set({ dbStatus: 'loading', dbProgress: 0, dbError: null });
    const db = await getDB();

    const dictUrl = chrome.runtime.getURL('dictionary/cedict.txt');
    console.log('Fetching dictionary file:', dictUrl);
    const response = await fetch(dictUrl);
    if (!response.ok) {
      throw new Error(`Failed to locate dictionary/cedict.txt. Ensure setup script was run. Status: ${response.status}`);
    }

    const text = await response.text();
    console.log(`Dictionary file read. Size: ${(text.length / (1024 * 1024)).toFixed(2)} MB. Splitting lines...`);
    const lines = text.split(/\r?\n/);
    const dictMap = new Map();

    console.log(`Parsing ${lines.length} lines of CC-CEDICT...`);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#') || !line.trim()) continue;

      // Match: Traditional Simplified [pinyin] /defn1/defn2/.../
      const match = line.match(/^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\/(.*)\/\s*$/);
      if (match) {
        const traditional = match[1];
        const simplified = match[2];
        const pinyin = match[3];
        const englishList = match[4].split('/').map(d => d.trim()).filter(Boolean);

        if (dictMap.has(simplified)) {
          const entry = dictMap.get(simplified);
          const exists = entry.readings.some(r => r.pinyin.toLowerCase() === pinyin.toLowerCase());
          if (!exists) {
            entry.readings.push({ pinyin, english: englishList });
          }
        } else {
          dictMap.set(simplified, {
            simplified,
            traditional,
            readings: [{ pinyin, english: englishList }]
          });
        }
      }
    }

    // Build staging entries for both simplified and traditional keys
    const entriesToWrite = [];
    for (const entry of dictMap.values()) {
      entriesToWrite.push({ key: entry.simplified, entry });
      if (entry.traditional !== entry.simplified) {
        entriesToWrite.push({ key: entry.traditional, entry });
      }
    }
    console.log(`Parsed ${dictMap.size} unique records. Indexing ${entriesToWrite.length} keys (Simplified + Traditional). Seeding DB...`);

    const batchSize = 5000;
    for (let i = 0; i < entriesToWrite.length; i += batchSize) {
      const batch = entriesToWrite.slice(i, i + batchSize);
      await writeBatchToDB(db, batch);

      const progress = Math.round(((i + batch.length) / entriesToWrite.length) * 100);
      await chrome.storage.local.set({ dbProgress: progress });
      console.log(`Database seeding: ${progress}%`);
    }

    await chrome.storage.local.set({ dbStatus: 'ready', dbProgress: 100 });
    console.log('Database indexing complete.');
    await initMemoryCache();
  } catch (error) {
    console.error('Dictionary indexing failed:', error);
    await chrome.storage.local.set({ dbStatus: 'error', dbProgress: 0, dbError: error.message });
  }
}

// Forward Maximum Matching Segmentation (FMM)
function segmentChineseText(text) {
  const segments = [];
  let i = 0;
  const maxLen = 8; // standard maximum length for CC-CEDICT entries

  while (i < text.length) {
    let matched = false;
    
    // Try to match from longest slice down to 1 character
    const remainingLength = text.length - i;
    const tryLimit = Math.min(maxLen, remainingLength);
    
    for (let len = tryLimit; len >= 1; len--) {
      const sub = text.slice(i, i + len);
      
      // If we are ready and the set contains the word, segment it
      if (isDbReady && dictKeysSet.has(sub)) {
        segments.push({ word: sub, isChinese: true });
        i += len;
        matched = true;
        break;
      }
    }

    if (!matched) {
      const char = text[i];
      // Check if character lies in the common CJK Unified Ideographs block
      const isChineseChar = /[\u4e00-\u9fa5]/.test(char);
      segments.push({ word: char, isChinese: isChineseChar });
      i++;
    }
  }

  // Merge consecutive non-Chinese segments to optimize tree payload and element count
  const mergedSegments = [];
  for (const seg of segments) {
    const last = mergedSegments[mergedSegments.length - 1];
    if (last && !last.isChinese && !seg.isChinese) {
      last.word += seg.word;
    } else {
      mergedSegments.push(seg);
    }
  }

  return mergedSegments;
}

// Lookup definitions from database
async function lookupWords(words) {
  const db = await getDB();
  const uniqueWords = Array.from(new Set(words));
  const entriesMap = new Map();

  await Promise.all(
    uniqueWords.map(async (word) => {
      try {
        const entry = await getFromDB(db, word);
        if (entry) {
          entriesMap.set(word, entry);
        }
      } catch (e) {
        console.error(`DB retrieval failed for key: ${word}`, e);
      }
    })
  );

  return entriesMap;
}

// Batch segmentation & database retrieval
async function handleSegmentBatch(texts) {
  // 1. Run FMM segmentation
  const segmentedTexts = texts.map(text => segmentChineseText(text));

  // 2. Identify unique Chinese words
  const allChineseWords = new Set();
  for (const segments of segmentedTexts) {
    for (const seg of segments) {
      if (seg.isChinese) {
        allChineseWords.add(seg.word);
      }
    }
  }

  // 3. Fetch database entries for words
  const entriesMap = await lookupWords(Array.from(allChineseWords));

  // 4. Map entries back to segments
  const result = segmentedTexts.map(segments => {
    return segments.map(seg => {
      if (seg.isChinese) {
        const entry = entriesMap.get(seg.word) || null;
        return {
          word: seg.word,
          isChinese: true,
          entry
        };
      } else {
        return {
          word: seg.word,
          isChinese: false
        };
      }
    });
  });

  return result;
}

// Google Translate (gtx) API Integration.
// Fallback path only: content.js uses Chrome's built-in Translator API as the
// primary translator and calls TRANSLATE_BATCH here when that API is
// unavailable (Chrome <138, mobile, model not downloaded, or unsupported pair).
// Page the user is sent to in order to complete Google's human-verification
// (reCAPTCHA) when the gtx endpoint rejects automated queries. Solving it
// clears the block for the user's IP so translation can resume.
const GTX_VERIFICATION_URL = 'https://www.google.com/sorry/index?continue=https://translate.googleapis.com/';

async function translateChunk(chunk, targetLang) {
  const joinedText = chunk.join('\n');
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=${targetLang}&dt=t&q=${encodeURIComponent(joinedText)}`;
  const results = [];

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    console.warn('Error during translation chunk fetch:', error);
    return [];
  }

  if (!response.ok) {
    // 403/429 means Google flagged the traffic as automated and wants the user
    // to solve a captcha. Propagate so content.js can surface the link.
    if (response.status === 403 || response.status === 429) {
      const e = new Error(`Google Translate verification required (HTTP ${response.status})`);
      e.code = 'RATE_LIMITED';
      e.status = response.status;
      throw e;
    }
    console.warn(`Translation chunk failed with status: ${response.status}`);
    return [];
  }

  try {
    const data = await response.json();
    if (data && data[0]) {
      data[0].forEach(item => {
        if (Array.isArray(item) && item.length >= 2) {
          const translated = item[0];
          const source = item[1];
          if (translated !== undefined && source !== undefined) {
            results.push({
              source: source.trim(),
              translated: translated.trim()
            });
          }
        }
      });
    }
  } catch (error) {
    console.warn('Error parsing translation chunk response:', error);
  }

  return results;
}

async function translateTexts(texts, targetLang = 'en') {
  if (!texts || texts.length === 0) return [];

  const results = [];
  let currentChunk = [];
  let currentLength = 0;
  const maxLength = 1500; // Limit encoded text query size to prevent URL limit failures

  for (const text of texts) {
    const encodedText = encodeURIComponent(text);
    // If adding this text would exceed the limit, translate the current chunk
    if (currentLength + encodedText.length + 1 > maxLength && currentChunk.length > 0) {
      const chunkResults = await translateChunk(currentChunk, targetLang);
      results.push(...chunkResults);
      currentChunk = [];
      currentLength = 0;
    }
    currentChunk.push(text);
    currentLength += encodedText.length + 1; // +1 for the encoded newline
  }

  if (currentChunk.length > 0) {
    const chunkResults = await translateChunk(currentChunk, targetLang);
    results.push(...chunkResults);
  }

  return results;
}

// Message Dispatcher
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SEGMENT_BATCH') {
    handleSegmentBatch(message.texts)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open asynchronously
  }

  if (message.type === 'TRANSLATE_BATCH') {
    translateTexts(message.texts)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => {
        if (err && err.code === 'RATE_LIMITED') {
          sendResponse({
            success: false,
            rateLimited: true,
            status: err.status,
            verificationUrl: GTX_VERIFICATION_URL
          });
        } else {
          sendResponse({ success: false, error: err.message });
        }
      });
    return true;
  }

  if (message.type === 'GET_STATUS') {
    chrome.storage.local.get(['dbStatus', 'dbProgress', 'dbError'], (data) => {
      sendResponse({
        status: data.dbStatus || 'uninitialized',
        progress: data.dbProgress || 0,
        error: data.dbError || null,
        isCacheReady: isDbReady
      });
    });
    return true;
  }

  if (message.type === 'RELOAD_DICTIONARY') {
    initializeDictionary()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// Keyboard Commands Listener
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-translation-mode') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_TRANSLATION_MODE' }).catch(() => {
          // Ignore tab mismatch errors
        });
      }
    });
  }
});

// Extension Lifecycle Events
chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed. Triggering dictionary initialization.');
  initializeDictionary();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('Service worker starting up. Warming up memory cache.');
  initMemoryCache();
});

// Immediate load on worker startup
getDB().then(() => {
  initMemoryCache();
});
