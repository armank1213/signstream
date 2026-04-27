const DEFAULT_ENGINE_URL = 'ws://127.0.0.1:8765';
const OFFSCREEN_URL = 'offscreen/offscreen.html';

let state = {
  capturing: false,
  tabId: null,
  engineUrl: DEFAULT_ENGINE_URL,
  lastError: null,
};

const DEFAULT_SETTINGS = {
  engineUrl: DEFAULT_ENGINE_URL,
  bufferMs: 1500,
  mode: 'sign+captions', // sign-only | captions-only | sign+captions
  signRenderMode: 'chips', // chips | gestures
  overlayPosition: 'right-middle', // right-middle | bottom-right | bottom-left
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

async function getSettings() {
  const items = await storageGet(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...items };
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

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(tabs);
    });
  });
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp);
    });
  });
}

function offscreenHasDocument() {
  try {
    const maybePromise = chrome.offscreen.hasDocument();
    if (maybePromise && typeof maybePromise.then === 'function') return maybePromise;
  } catch {
    // fall back to callback style
  }

  return new Promise((resolve, reject) => {
    chrome.offscreen.hasDocument((exists) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(!!exists);
    });
  });
}

function offscreenCreateDocument(params) {
  try {
    const maybePromise = chrome.offscreen.createDocument(params);
    if (maybePromise && typeof maybePromise.then === 'function') return maybePromise;
  } catch {
    // fall back to callback style
  }

  return new Promise((resolve, reject) => {
    chrome.offscreen.createDocument(params, () => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve();
    });
  });
}

async function ensureOffscreenDocument() {
  const existing = await offscreenHasDocument();
  if (existing) return;

  await offscreenCreateDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Capture tab audio and stream to local SignStream engine.',
  });
}

async function getActiveTabId() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  return tabs?.[0]?.id ?? null;
}

function getMediaStreamIdForTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!streamId) return reject(new Error('No streamId returned'));
      resolve(streamId);
    });
  });
}

async function startCapture(engineUrl) {
  state.lastError = null;

  const settings = await getSettings();
  state.engineUrl = engineUrl || settings.engineUrl || state.engineUrl || DEFAULT_ENGINE_URL;

  const tabId = await getActiveTabId();
  if (!tabId) {
    state.lastError = 'No active tab found.';
    return;
  }

  await ensureOffscreenDocument();

  let streamId;
  try {
    streamId = await getMediaStreamIdForTab(tabId);
  } catch (e) {
    state.lastError = `tabCapture failed: ${String(e?.message || e)}`;
    return;
  }

  state.capturing = true;
  state.tabId = tabId;

  await runtimeSendMessage({
    type: 'OFFSCREEN_START',
    tabId,
    streamId,
    engineUrl: state.engineUrl,
    settings,
  });
}

async function stopCapture() {
  state.lastError = null;
  state.capturing = false;

  try {
    await runtimeSendMessage({ type: 'OFFSCREEN_STOP' });
  } catch {
    // ignore
  }
  state.tabId = null;
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-capture') return;
  if (state.capturing) await stopCapture();
  else await startCapture();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'POPUP_GET_STATUS') {
        sendResponse({ ok: true, state });
        return;
      }

      if (msg?.type === 'POPUP_START') {
        await startCapture(msg.engineUrl);
        sendResponse({ ok: true, state });
        return;
      }

      if (msg?.type === 'POPUP_STOP') {
        await stopCapture();
        sendResponse({ ok: true, state });
        return;
      }

      if (msg?.type === 'ENGINE_TOKENS' || msg?.type === 'ENGINE_TRANSCRIPT') {
        if (!state.tabId) return;
        try {
          await tabsSendMessage(state.tabId, msg);
        } catch {
          // Content script may not be ready (YouTube SPA) — ignore.
        }
        return;
      }

      if (msg?.type === 'ENGINE_STATUS') {
        if (!state.tabId) return;
        try {
          await tabsSendMessage(state.tabId, msg);
        } catch {
          // Content script may not be ready (YouTube SPA) — ignore.
        }
        return;
      }

      if (msg?.type === 'OFFSCREEN_ERROR') {
        state.lastError = msg.error || 'Offscreen error.';
        state.capturing = false;
        state.tabId = null;
        return;
      }
    } catch (e) {
      state.lastError = String(e?.message || e);
      sendResponse({ ok: false, error: state.lastError, state });
    }
  })();

  return true;
});
