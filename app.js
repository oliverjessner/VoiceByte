const STORAGE_KEY = 'voicebyte-tts-state';
const FAVORITES_KEY = 'voicebyte-tts-favorites';
const MAX_FAVORITES = 10;
const MAX_HISTORY_ITEMS = 30;

const elements = {
    text: document.getElementById('text-input'),
    voice: document.getElementById('voice-select'),
    rate: document.getElementById('rate'),
    pitch: document.getElementById('pitch'),
    volume: document.getElementById('volume'),
    rateValue: document.getElementById('rate-value'),
    pitchValue: document.getElementById('pitch-value'),
    volumeValue: document.getElementById('volume-value'),
    speak: document.getElementById('speak-btn'),
    pause: document.getElementById('pause-btn'),
    resume: document.getElementById('resume-btn'),
    stop: document.getElementById('stop-btn'),
    clear: document.getElementById('clear-btn'),
    status: document.getElementById('status'),
    message: document.getElementById('message'),
    historyList: document.getElementById('history-list'),
    favoritesList: document.getElementById('favorites-list'),
    favoritesShortcutMeta: document.getElementById('favorites-shortcut-meta'),
    favoritesShortcutHelp: document.getElementById('favorites-shortcut-help'),
};

const synthesis = 'speechSynthesis' in window ? window.speechSynthesis : null;
const shortcutModifierLabel = detectShortcutModifierLabel();

let voices = [];
let currentUtterance = null;
let currentStatus = 'ready';
let pendingVoiceURI = '';
let historyItems = [];
let favorites = [];

const defaultState = {
    text: '',
    voiceURI: '',
    rate: 1,
    pitch: 1,
    volume: 1,
};

init();

function init() {
    logAppVersion();
    bindControls();
    loadState();
    loadFavorites();
    updateRangeOutputs();
    renderShortcutHints();
    renderHistory();
    renderFavorites();

    if (!synthesis || typeof window.SpeechSynthesisUtterance !== 'function') {
        setError('This browser does not support the Web Speech API.');
        disableSpeechControls(true);
        populateVoiceSelect([]);
        return;
    }

    populateVoiceSelect([]);
    refreshVoices();

    if (typeof synthesis.addEventListener === 'function') {
        synthesis.addEventListener('voiceschanged', refreshVoices);
    } else {
        synthesis.onvoiceschanged = refreshVoices;
    }

    updateStatus('ready');
    updateButtons();
}

async function logAppVersion() {
    try {
        const response = await fetch('/api/version', { cache: 'no-store' });
        if (!response.ok) {
            return;
        }

        const data = await response.json();
        if (data && data.version) {
            console.log(`VoiceByte version: ${data.version}`);
        }
    } catch {
        // Ignore version logging failures.
    }
}

function bindControls() {
    elements.text.addEventListener('input', () => {
        persistState();
        clearMessage();
        updateButtons();
    });

    elements.text.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            speakText();
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            clearText();
        }
    });

    document.addEventListener('keydown', handleGlobalKeydown);

    elements.voice.addEventListener('change', () => {
        pendingVoiceURI = elements.voice.value;
        persistState();
    });

    [elements.rate, elements.pitch, elements.volume].forEach(input => {
        input.addEventListener('input', () => {
            updateRangeOutputs();
            persistState();
        });
    });

    elements.speak.addEventListener('click', speakText);
    elements.pause.addEventListener('click', pauseSpeech);
    elements.resume.addEventListener('click', resumeSpeech);
    elements.stop.addEventListener('click', stopSpeech);
    elements.clear.addEventListener('click', clearText);

    window.addEventListener('beforeunload', () => {
        if (synthesis && (synthesis.speaking || synthesis.pending)) {
            synthesis.cancel();
        }
    });
}

function loadState() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        const state = { ...defaultState, ...saved };

        elements.text.value = typeof state.text === 'string' ? state.text : defaultState.text;
        elements.rate.value = normalizeNumber(state.rate, 0.5, 2, 1);
        elements.pitch.value = normalizeNumber(state.pitch, 0, 2, 1);
        elements.volume.value = normalizeNumber(state.volume, 0, 1, 1);
        pendingVoiceURI = typeof state.voiceURI === 'string' ? state.voiceURI : '';
    } catch {
        pendingVoiceURI = '';
    }
}

function persistState() {
    const state = {
        text: elements.text.value,
        voiceURI: elements.voice.value || pendingVoiceURI || '',
        rate: Number(elements.rate.value),
        pitch: Number(elements.pitch.value),
        volume: Number(elements.volume.value),
    };

    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        setMessage('Settings could not be saved in local storage.');
    }
}

function loadFavorites() {
    try {
        const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
        favorites = Array.isArray(saved)
            ? saved
                  .filter(item => item && typeof item.text === 'string' && item.text.trim())
                  .slice(0, MAX_FAVORITES)
                  .map(item => ({
                      id: typeof item.id === 'string' ? item.id : createId(),
                      text: item.text.trim(),
                  }))
            : [];
    } catch {
        favorites = [];
    }
}

function persistFavorites() {
    try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    } catch {
        setMessage('Favorites could not be saved in local storage.');
    }
}

function refreshVoices() {
    if (!synthesis) {
        return;
    }

    const latest = synthesis.getVoices();
    voices = Array.isArray(latest) ? latest.slice() : [];

    if (!voices.length) {
        populateVoiceSelect([]);
        setMessage('No voices are currently available. Some browsers load them after a short delay.');
        updateButtons();
        return;
    }

    clearMessage();
    populateVoiceSelect(voices);
    updateButtons();
}

function populateVoiceSelect(nextVoices) {
    const previousSelection = elements.voice.value || pendingVoiceURI || '';
    elements.voice.replaceChildren();

    if (!nextVoices.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No voices available';
        elements.voice.append(option);
        elements.voice.disabled = true;
        return;
    }

    elements.voice.disabled = false;

    nextVoices.forEach(voice => {
        const option = document.createElement('option');
        option.value = voice.voiceURI;
        option.textContent = `${voice.name} (${voice.lang})${voice.default ? ' — Default' : ''}`;
        elements.voice.append(option);
    });

    const matchedVoice = nextVoices.find(voice => voice.voiceURI === previousSelection);
    const fallbackVoice = getPreferredFallbackVoice(nextVoices);
    const selectedVoiceURI = matchedVoice ? matchedVoice.voiceURI : fallbackVoice.voiceURI;

    elements.voice.value = selectedVoiceURI;
    pendingVoiceURI = selectedVoiceURI;
    persistState();
}

function getPreferredFallbackVoice(nextVoices) {
    const browserLanguages =
        Array.isArray(navigator.languages) && navigator.languages.length
            ? navigator.languages
            : [navigator.language || 'en-US'];

    const normalizedLanguages = browserLanguages.map(lang => String(lang).toLowerCase());
    const googleVoices = nextVoices.filter(voice => /google/i.test(voice.name));

    for (const language of normalizedLanguages) {
        const exactGoogleMatch = googleVoices.find(voice => voice.lang.toLowerCase() === language);
        if (exactGoogleMatch) {
            return exactGoogleMatch;
        }

        const baseLanguage = language.split('-')[0];
        const baseGoogleMatch = googleVoices.find(voice => voice.lang.toLowerCase().startsWith(`${baseLanguage}-`));
        if (baseGoogleMatch) {
            return baseGoogleMatch;
        }
    }

    return googleVoices[0] || nextVoices.find(voice => voice.default) || nextVoices[0];
}

function updateRangeOutputs() {
    elements.rateValue.value = Number(elements.rate.value).toFixed(1);
    elements.pitchValue.value = Number(elements.pitch.value).toFixed(1);
    elements.volumeValue.value = Number(elements.volume.value).toFixed(1);
}

function speakText() {
    clearMessage();

    if (!synthesis) {
        setError('Speech synthesis is not available in this browser.');
        return;
    }

    if (!voices.length) {
        setError('No voices are available yet.');
        refreshVoices();
        return;
    }

    const text = elements.text.value.trim();
    if (!text) {
        setError('Enter some text before starting speech.');
        elements.text.focus();
        return;
    }

    addHistoryItem(text);

    if (synthesis.speaking || synthesis.pending) {
        synthesis.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const selectedVoice = voices.find(voice => voice.voiceURI === elements.voice.value) || null;

    if (selectedVoice) {
        utterance.voice = selectedVoice;
        utterance.lang = selectedVoice.lang;
    }

    utterance.rate = Number(elements.rate.value);
    utterance.pitch = Number(elements.pitch.value);
    utterance.volume = Number(elements.volume.value);

    utterance.onstart = () => {
        currentUtterance = utterance;
        updateStatus('speaking');
    };

    utterance.onend = () => {
        if (currentUtterance === utterance) {
            currentUtterance = null;
        }
        updateStatus('ended');
    };

    utterance.onpause = () => {
        currentUtterance = utterance;
        updateStatus('paused');
    };

    utterance.onresume = () => {
        currentUtterance = utterance;
        updateStatus('speaking');
    };

    utterance.onerror = event => {
        if (currentUtterance === utterance) {
            currentUtterance = null;
        }
        setError(`Speech error: ${event.error || 'unknown error'}.`);
    };

    try {
        currentUtterance = utterance;
        synthesis.speak(utterance);
    } catch (error) {
        currentUtterance = null;
        setError(`Unable to start speech: ${error.message || 'unknown error'}.`);
    }
}

function pauseSpeech() {
    if (!synthesis || !synthesis.speaking || synthesis.paused) {
        return;
    }

    synthesis.pause();
}

function resumeSpeech() {
    if (!synthesis || !synthesis.paused) {
        return;
    }

    synthesis.resume();
}

function stopSpeech() {
    if (!synthesis) {
        return;
    }

    synthesis.cancel();
    currentUtterance = null;
    updateStatus('ready');
}

function clearText() {
    if (synthesis && (synthesis.speaking || synthesis.pending || synthesis.paused)) {
        synthesis.cancel();
    }

    currentUtterance = null;
    elements.text.value = '';
    updateStatus('ready');
    clearMessage();
    persistState();
    elements.text.focus();
}

function addHistoryItem(text) {
    const normalizedText = text.trim();
    if (!normalizedText) {
        return;
    }

    historyItems.unshift({
        id: createId(),
        text: normalizedText,
    });

    historyItems = historyItems.slice(0, MAX_HISTORY_ITEMS);
    renderHistory();
}

function toggleFavoriteFromHistory(id) {
    const historyItem = historyItems.find(item => item.id === id);
    if (!historyItem) {
        return;
    }

    const existingIndex = favorites.findIndex(item => item.text === historyItem.text);
    if (existingIndex >= 0) {
        favorites.splice(existingIndex, 1);
    } else {
        if (favorites.length >= MAX_FAVORITES) {
            setMessage('You can save up to 10 favorites.');
            return;
        }

        favorites.push({
            id: createId(),
            text: historyItem.text,
        });
    }

    persistFavorites();
    renderHistory();
    renderFavorites();
}

function removeFavorite(id) {
    const nextFavorites = favorites.filter(item => item.id !== id);
    if (nextFavorites.length === favorites.length) {
        return;
    }

    favorites = nextFavorites;
    persistFavorites();
    renderHistory();
    renderFavorites();
}

function loadItemText(text) {
    elements.text.value = text;
    clearMessage();
    persistState();
    updateButtons();
    elements.text.focus();
}

function speakFavoriteByIndex(index) {
    const favorite = favorites[index];
    if (!favorite) {
        return;
    }

    loadItemText(favorite.text);
    speakText();
}

function handleGlobalKeydown(event) {
    if (event.defaultPrevented || event.altKey || event.metaKey || event.shiftKey || !event.ctrlKey) {
        return;
    }

    if (isBlockedShortcutTarget(event.target)) {
        return;
    }

    const index = shortcutKeyToIndex(event.key);
    if (index === null || !favorites[index]) {
        return;
    }

    event.preventDefault();
    speakFavoriteByIndex(index);
}

function renderHistory() {
    elements.historyList.replaceChildren();

    if (!historyItems.length) {
        elements.historyList.append(createEmptyState('No history yet. Start speech and it will appear here.'));
        return;
    }

    historyItems.forEach(item => {
        const isFavorite = favorites.some(favorite => favorite.text === item.text);
        elements.historyList.append(createHistoryCard(item, isFavorite));
    });
}

function renderFavorites() {
    elements.favoritesList.replaceChildren();

    if (!favorites.length) {
        elements.favoritesList.append(createEmptyState('No favorites saved.'));
        return;
    }

    favorites.forEach((item, index) => {
        elements.favoritesList.append(createFavoriteCard(item, index));
    });
}

function createHistoryCard(item, isFavorite) {
    const article = document.createElement('article');
    article.className = 'history-item';
    article.setAttribute('role', 'listitem');

    const mainButton = document.createElement('button');
    mainButton.type = 'button';
    mainButton.className = 'history-main';
    mainButton.setAttribute('aria-label', `Load history item: ${previewText(item.text, 80)}`);
    mainButton.addEventListener('click', () => loadItemText(item.text));

    const title = document.createElement('span');
    title.className = 'history-main-title';
    title.textContent = 'Load into editor';

    const preview = document.createElement('p');
    preview.className = 'history-preview';
    preview.textContent = item.text;

    mainButton.append(title, preview);

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const favoriteButton = document.createElement('button');
    favoriteButton.type = 'button';
    favoriteButton.className = `icon-button${isFavorite ? ' icon-button-active' : ''}`;
    favoriteButton.setAttribute('aria-pressed', String(isFavorite));
    favoriteButton.setAttribute('aria-label', isFavorite ? 'Remove from favorites' : 'Save as favorite');
    favoriteButton.textContent = isFavorite ? '♥' : '♡';
    favoriteButton.addEventListener('click', () => toggleFavoriteFromHistory(item.id));

    actions.append(favoriteButton);
    article.append(mainButton, actions);
    return article;
}

function createFavoriteCard(item, index) {
    const article = document.createElement('article');
    article.className = 'history-item';
    article.setAttribute('role', 'listitem');

    const mainButton = document.createElement('button');
    mainButton.type = 'button';
    mainButton.className = 'history-main';
    mainButton.setAttribute('aria-label', `Speak favorite ${index + 1}: ${previewText(item.text, 80)}`);
    mainButton.addEventListener('click', () => speakFavoriteByIndex(index));

    const preview = document.createElement('p');
    preview.className = 'history-preview';
    preview.textContent = item.text;

    mainButton.append(preview);

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'icon-button icon-button-active';
    removeButton.setAttribute('aria-label', 'Remove favorite');
    removeButton.textContent = '♥';
    removeButton.addEventListener('click', () => removeFavorite(item.id));

    actions.append(removeButton);
    article.append(mainButton, actions);
    return article;
}

function createEmptyState(text) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = text;
    return empty;
}

function updateStatus(status) {
    currentStatus = status;

    const labelMap = {
        ready: 'Ready',
        speaking: 'Speaking',
        paused: 'Paused',
        ended: 'Ended',
        error: 'Error',
    };

    elements.status.textContent = labelMap[status] || 'Ready';
    elements.status.className = `status-chip status-${status}`;
    updateButtons();
}

function updateButtons() {
    const apiUnavailable = !synthesis;
    const noVoices = !voices.length;
    const hasText = elements.text.value.trim().length > 0;
    const speaking = Boolean(synthesis && synthesis.speaking);
    const paused = Boolean(synthesis && synthesis.paused);

    elements.speak.disabled = apiUnavailable || noVoices || !hasText;
    elements.pause.disabled = apiUnavailable || !speaking || paused;
    elements.resume.disabled = apiUnavailable || !paused;
    elements.stop.disabled = apiUnavailable || (!speaking && !paused && currentStatus !== 'ended');
    elements.clear.disabled = apiUnavailable && !elements.text.value.length;
}

function disableSpeechControls(disabled) {
    elements.voice.disabled = disabled;
    elements.rate.disabled = disabled;
    elements.pitch.disabled = disabled;
    elements.volume.disabled = disabled;
    elements.speak.disabled = disabled;
    elements.pause.disabled = disabled;
    elements.resume.disabled = disabled;
    elements.stop.disabled = disabled;
}

function setError(message) {
    setMessage(message);
    updateStatus('error');
}

function setMessage(message) {
    elements.message.textContent = message;
    elements.message.hidden = false;
}

function clearMessage() {
    elements.message.hidden = true;
    elements.message.textContent = '';
}

function isBlockedShortcutTarget(target) {
    return Boolean(
        target &&
        ((target.closest('input') && !target.closest('textarea')) ||
            target.closest('select') ||
            target.isContentEditable),
    );
}

function shortcutKeyToIndex(key) {
    if (/^[1-9]$/.test(key)) {
        return Number(key) - 1;
    }

    if (key === '0') {
        return 9;
    }

    return null;
}

function renderShortcutHints() {
    elements.favoritesShortcutMeta.textContent = `${shortcutModifierLabel} + 1-9, 0`;
    elements.favoritesShortcutHelp.textContent = `Up to 10 favorites are stored locally. Press ${shortcutModifierLabel} plus a number key to load and speak one.`;
}

function detectShortcutModifierLabel() {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    return /Mac|iPhone|iPad|iPod/i.test(platform) ? 'Control' : 'Ctrl';
}

function previewText(text, maxLength) {
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength).trimEnd()}...`;
}

function createId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
        return String(fallback);
    }

    return String(Math.min(max, Math.max(min, numeric)));
}
