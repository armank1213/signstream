const DEFAULT_ENGINE_URL = 'ws://127.0.0.1:4000';
const OFFSCREEN_URL = 'offscreen/offscreen.html';

const DEFAULT_DOMAIN = 'www.youtube.com';
const ALLOWED_DOMAINS_KEY = 'allowedDomains';
const DYNAMIC_SCRIPT_ID = 'signstream-dynamic';

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
  useWorklet: true,
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

async function getSettings() {
  const items = await storageGet(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...items };
}

function normalizeHostname(input) {
  if (!input || typeof input !== 'string') return null;
  let h = input.trim().toLowerCase();
  // Accept full URLs too
  try {
    if (h.includes('://')) h = new URL(h).hostname;
  } catch {
    return null;
  }
  // Strip trailing dot, port
  h = h.replace(/\.$/, '').split(':')[0];
  if (!h || h === 'localhost') return h || null;
  // Very loose validation — must contain at least one dot or be a valid hostname
  if (!/^[a-z0-9.-]+$/.test(h)) return null;
  return h;
}

function originPatternForHost(hostname) {
  return `*://${hostname}/*`;
}

async function getStoredDomains() {
  const items = await storageGet([ALLOWED_DOMAINS_KEY]);
  const list = Array.isArray(items[ALLOWED_DOMAINS_KEY]) ? items[ALLOWED_DOMAINS_KEY] : [];
  // De-dupe + drop the static default since manifest already covers it
  return Array.from(new Set(list.filter((h) => typeof h === 'string' && h && h !== DEFAULT_DOMAIN)));
}

async function getAllAllowedDomains() {
  const stored = await getStoredDomains();
  return [DEFAULT_DOMAIN, ...stored];
}

async function setStoredDomains(list) {
  const cleaned = Array.from(new Set((list || []).filter((h) => h && h !== DEFAULT_DOMAIN)));
  await storageSet({ [ALLOWED_DOMAINS_KEY]: cleaned });
}

function permissionsContains(perm) {
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains(perm, (granted) => resolve(!!granted));
    } catch {
      resolve(false);
    }
  });
}

function permissionsRemove(perm) {
  return new Promise((resolve) => {
    try {
      chrome.permissions.remove(perm, (removed) => resolve(!!removed));
    } catch {
      resolve(false);
    }
  });
}

async function registerDynamicContentScripts() {
  const stored = await getStoredDomains();
  // Filter to hosts we actually have permission for, otherwise registerContentScripts fails
  const verified = [];
  for (const h of stored) {
    const ok = await permissionsContains({ origins: [originPatternForHost(h)] });
    if (ok) verified.push(h);
  }

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
    if (existing && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
    }
  } catch {
    // ignore — nothing to unregister
  }

  if (verified.length === 0) return;

  const matches = verified.map(originPatternForHost);
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: DYNAMIC_SCRIPT_ID,
        matches,
        js: ['contentScript.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ]);
  } catch (e) {
    console.warn('SignStream: failed to register dynamic content scripts', e);
  }
}

async function addAllowedDomain(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) throw new Error('Invalid hostname');
  if (host === DEFAULT_DOMAIN) return; // already covered by static manifest

  const granted = await permissionsContains({ origins: [originPatternForHost(host)] });
  if (!granted) throw new Error('Permission not granted for ' + host);

  const stored = await getStoredDomains();
  if (!stored.includes(host)) stored.push(host);
  await setStoredDomains(stored);
  await registerDynamicContentScripts();
}

async function removeAllowedDomain(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) throw new Error('Invalid hostname');
  if (host === DEFAULT_DOMAIN) throw new Error('Cannot remove default domain');

  const stored = await getStoredDomains();
  const next = stored.filter((h) => h !== host);
  await setStoredDomains(next);
  await permissionsRemove({ origins: [originPatternForHost(host)] });
  await registerDynamicContentScripts();
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

async function getActiveTab() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  return tabs?.[0] ?? null;
}

function hostnameFromTab(tab) {
  if (!tab?.url) return null;
  try {
    return new URL(tab.url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function getActiveTabInfo() {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: 'No active tab.' };

  const hostname = hostnameFromTab(tab);
  const allowed = await getAllAllowedDomains();
  const isAllowed = !!hostname && allowed.includes(hostname);
  const hasPermission = !!hostname && (
    hostname === DEFAULT_DOMAIN
      ? true
      : await permissionsContains({ origins: [originPatternForHost(hostname)] })
  );

  return {
    ok: true,
    tabId: tab.id,
    url: tab.url,
    hostname,
    isAllowed,
    hasPermission,
    isDefault: hostname === DEFAULT_DOMAIN,
    allowedDomains: allowed,
  };
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

  const tab = await getActiveTab();
  if (!tab?.id) {
    state.lastError = 'No active tab found.';
    return;
  }

  const hostname = hostnameFromTab(tab);
  const allowed = await getAllAllowedDomains();
  if (!hostname || !allowed.includes(hostname)) {
    state.lastError = `${hostname || 'this site'} is not in your allowed list. Open the popup and click "Add this site".`;
    return;
  }

  await ensureOffscreenDocument();

  let streamId;
  try {
    streamId = await getMediaStreamIdForTab(tab.id);
  } catch (e) {
    state.lastError = `tabCapture failed: ${String(e?.message || e)}`;
    return;
  }

  state.capturing = true;
  state.tabId = tab.id;

  await runtimeSendMessage({
    type: 'OFFSCREEN_START',
    tabId: tab.id,
    streamId,
    engineUrl: state.engineUrl,
    settings,
  });
}

async function stopCapture() {
  state.lastError = null;
  state.capturing = false;

  if (state.tabId) {
    try {
      await tabsSendMessage(state.tabId, { type: 'SIGNSTREAM_STOP' });
    } catch (e) {
      console.warn('[SignStream] Failed to send stop to content script:', e?.message);
    }
  }

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

chrome.runtime.onInstalled.addListener(() => {
  void registerDynamicContentScripts();
});

chrome.runtime.onStartup.addListener(() => {
  void registerDynamicContentScripts();
});

if (chrome.permissions?.onRemoved) {
  chrome.permissions.onRemoved.addListener(async (perm) => {
    const origins = perm?.origins || [];
    if (origins.length === 0) return;

    const stored = await getStoredDomains();
    const removedHosts = new Set();
    for (const o of origins) {
      try {
        // Pattern is *://hostname/* — extract hostname segment
        const match = o.match(/^\*?:?\/?\/?([^/]+)\/\*$/);
        if (match) removedHosts.add(match[1].toLowerCase());
      } catch {
        // ignore
      }
    }

    const next = stored.filter((h) => !removedHosts.has(h));
    if (next.length !== stored.length) {
      await setStoredDomains(next);
      await registerDynamicContentScripts();
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const expectsResponse = msg?.type?.startsWith('POPUP_') || msg?.type?.startsWith('OFFSCREEN_');

  (async () => {
    try {
      if (msg?.type === 'POPUP_GET_STATUS') {
        sendResponse({ ok: true, state });
        return;
      }

      if (msg?.type === 'POPUP_GET_ACTIVE_TAB_INFO') {
        const info = await getActiveTabInfo();
        sendResponse(info);
        return;
      }

      if (msg?.type === 'POPUP_LIST_DOMAINS') {
        const domains = await getAllAllowedDomains();
        sendResponse({ ok: true, domains, defaultDomain: DEFAULT_DOMAIN });
        return;
      }

      if (msg?.type === 'POPUP_ADD_DOMAIN') {
        try {
          await addAllowedDomain(msg.hostname);
          const domains = await getAllAllowedDomains();
          sendResponse({ ok: true, domains });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
        return;
      }

      if (msg?.type === 'POPUP_REMOVE_DOMAIN') {
        try {
          await removeAllowedDomain(msg.hostname);
          const domains = await getAllAllowedDomains();
          sendResponse({ ok: true, domains });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
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
        if (!state.tabId) {
          console.warn('[SignStream] ENGINE message received but no active tabId');
          return;
        }
        try {
          await tabsSendMessage(state.tabId, msg);
        } catch (e) {
          console.warn('[SignStream] Failed to send message to content script:', e?.message);
          // Content script may not be ready (YouTube SPA) — ignore.
        }
        return;
      }

      if (msg?.type === 'ENGINE_STATUS') {
        if (!state.tabId) return;
        try {
          await tabsSendMessage(state.tabId, msg);
        } catch (e) {
          console.warn('[SignStream] Failed to send ENGINE_STATUS:', e?.message);
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
      if (expectsResponse) sendResponse({ ok: false, error: state.lastError, state });
    }
  })();

  return expectsResponse;
});
