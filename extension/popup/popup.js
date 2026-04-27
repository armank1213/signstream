const engineUrlEl = document.getElementById('engineUrl');
const modeEl = document.getElementById('mode');
const signRenderModeEl = document.getElementById('signRenderMode');
const bufferMsEl = document.getElementById('bufferMs');
const overlayPositionEl = document.getElementById('overlayPosition');
const overlayScaleEl = document.getElementById('overlayScale');
const simplificationLevelEl = document.getElementById('simplificationLevel');
const vadEnabledEl = document.getElementById('vadEnabled');
const fingerspellUnknownEl = document.getElementById('fingerspellUnknown');

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');

const DEFAULT_SETTINGS = {
  engineUrl: 'ws://127.0.0.1:8765',
  bufferMs: 1500,
  mode: 'sign+captions',
  signRenderMode: 'chips',
  overlayPosition: 'right-middle',
  overlayScale: 1.15,
  simplificationLevel: 1,
  vadEnabled: true,
  vadThreshold: 0.01,
  useWorklet: false,
  captionConfThreshold: 0.5,
  fingerspellUnknown: true,
};

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(items || {});
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve();
    });
  });
}

function coerceNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function coerceBool(v) {
  return v === true || v === 'true';
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', !!isError);
}

function runtimeSendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp);
    });
  });
}

async function refresh() {
  const resp = await runtimeSendMessage({ type: 'POPUP_GET_STATUS' });
  const state = resp?.state;
  if (!state) {
    setStatus('Unable to read status.', true);
    return;
  }

  const stored = await storageGet(Object.keys(DEFAULT_SETTINGS));
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  engineUrlEl.value = settings.engineUrl || state.engineUrl || DEFAULT_SETTINGS.engineUrl;
  modeEl.value = settings.mode;
  signRenderModeEl.value = settings.signRenderMode || 'chips';
  bufferMsEl.value = String(settings.bufferMs);
  overlayPositionEl.value = settings.overlayPosition;
  overlayScaleEl.value = String(settings.overlayScale);
  simplificationLevelEl.value = String(settings.simplificationLevel);
  vadEnabledEl.value = String(settings.vadEnabled);
  fingerspellUnknownEl.value = String(settings.fingerspellUnknown);

  if (state.lastError) setStatus(`Error: ${state.lastError}`, true);
  else if (state.capturing) setStatus('Capturing + streaming…');
  else setStatus('Idle');
}

startBtn.addEventListener('click', async () => {
  setStatus('Starting…');

  const nextSettings = {
    engineUrl: engineUrlEl.value.trim() || DEFAULT_SETTINGS.engineUrl,
    mode: modeEl.value,
    signRenderMode: signRenderModeEl.value,
    bufferMs: coerceNumber(bufferMsEl.value, DEFAULT_SETTINGS.bufferMs),
    overlayPosition: overlayPositionEl.value,
    overlayScale: coerceNumber(overlayScaleEl.value, DEFAULT_SETTINGS.overlayScale),
    simplificationLevel: coerceNumber(simplificationLevelEl.value, DEFAULT_SETTINGS.simplificationLevel),
    vadEnabled: coerceBool(vadEnabledEl.value),
    fingerspellUnknown: coerceBool(fingerspellUnknownEl.value),
  };

  await storageSet(nextSettings);

  await runtimeSendMessage({
    type: 'POPUP_START',
    engineUrl: nextSettings.engineUrl,
  });
  await refresh();
});

stopBtn.addEventListener('click', async () => {
  setStatus('Stopping…');
  await runtimeSendMessage({ type: 'POPUP_STOP' });
  await refresh();
});

refresh();
