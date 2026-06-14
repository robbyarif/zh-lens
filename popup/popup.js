// popup.js
// Chrome Extension Popup Script for Zh-Lens

const badge = document.getElementById('status-badge');
const stateLoading = document.getElementById('state-loading');
const stateReady = document.getElementById('state-ready');
const stateError = document.getElementById('state-error');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const errorMessage = document.getElementById('error-message');
const enableToggle = document.getElementById('enable-toggle');
const btnRetry = document.getElementById('btn-retry');
const btnReindex = document.getElementById('btn-reindex');

function updateUI() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    // If runtime background worker is dead/unreachable, gracefully wait
    if (chrome.runtime.lastError || !response) {
      badge.textContent = 'Offline';
      badge.className = 'badge status-error';
      return;
    }

    const { status, progress, error } = response;
    
    // Reset state visibility
    badge.className = 'badge';
    stateLoading.classList.add('hidden');
    stateReady.classList.add('hidden');
    stateError.classList.add('hidden');

    if (status === 'loading') {
      badge.textContent = 'Seeding';
      badge.classList.add('status-loading');
      stateLoading.classList.remove('hidden');
      
      progressBar.style.width = `${progress}%`;
      progressText.textContent = `${progress}%`;
    } else if (status === 'ready') {
      badge.textContent = 'Ready';
      badge.classList.add('status-ready');
      stateReady.classList.remove('hidden');
    } else if (status === 'error') {
      badge.textContent = 'Error';
      badge.classList.add('status-error');
      stateError.classList.remove('hidden');
      errorMessage.textContent = error || 'Unexpected database seeding error.';
    } else {
      badge.textContent = 'Empty';
      badge.classList.add('status-error');
      stateError.classList.remove('hidden');
      errorMessage.textContent = 'The CC-CEDICT database is not initialized.';
    }
  });
}

const pinyinToggle = document.getElementById('pinyin-toggle');
const translationToggle = document.getElementById('translation-toggle');

// Load current settings
chrome.storage.local.get({ enabled: true, pinyinEnabled: true, translationMode: false }, (settings) => {
  enableToggle.checked = settings.enabled;
  pinyinToggle.checked = settings.pinyinEnabled;
  translationToggle.checked = settings.translationMode;
});

// Update settings on toggle
enableToggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: enableToggle.checked });
});

pinyinToggle.addEventListener('change', () => {
  if (pinyinToggle.checked) {
    // Negate translation when pinyin is turned ON
    translationToggle.checked = false;
    chrome.storage.local.set({ 
      pinyinEnabled: true,
      translationMode: false
    });
  } else {
    chrome.storage.local.set({ pinyinEnabled: false });
  }
});

translationToggle.addEventListener('change', () => {
  if (translationToggle.checked) {
    // Negate pinyin when translation is turned ON
    pinyinToggle.checked = false;
    chrome.storage.local.set({
      translationMode: true,
      pinyinEnabled: false
    });
  } else {
    chrome.storage.local.set({ translationMode: false });
  }
});

// Sync checkboxes if settings change externally (like via Alt+Shift hotkey on a page)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) {
    enableToggle.checked = changes.enabled.newValue;
  }
  if (changes.pinyinEnabled) {
    pinyinToggle.checked = changes.pinyinEnabled.newValue;
  }
  if (changes.translationMode) {
    translationToggle.checked = changes.translationMode.newValue;
  }
});

// Retry Setup click handler
btnRetry.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RELOAD_DICTIONARY' }, () => {
    updateUI();
  });
});

// Rebuild Database link handler
btnReindex.addEventListener('click', (e) => {
  e.preventDefault();
  const warning = 'Are you sure you want to rebuild the dictionary database?\nThis will clear and re-parse dictionary/cedict.txt.';
  if (confirm(warning)) {
    chrome.runtime.sendMessage({ type: 'RELOAD_DICTIONARY' }, () => {
      updateUI();
    });
  }
});

// Initial query and polling
updateUI();
const pollInterval = setInterval(updateUI, 800);

// Cleanup polling when popup closes
window.addEventListener('unload', () => {
  clearInterval(pollInterval);
});
