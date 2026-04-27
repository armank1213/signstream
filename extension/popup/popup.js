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

const currentSiteEl = document.getElementById('currentSite');
const addSiteBtn = document.getElementById('addSiteBtn');
const siteListEl = document.getElementById('siteList');

const DEFAULT_DOMAIN = 'www.youtube.com';

const DEFAULT_SETTINGS = {
  engineUrl: 'ws://127.0.0.1:4000',
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

let activeTabInfo = null;

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

function originPatternForHost(hostname) {
  return `*://${hostname}/*`;
}

function permissionsRequest(perm) {
  return new Promise((resolve, reject) => {
    try {
      chrome.permissions.request(perm, (granted) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(!!granted);
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function refreshSiteAccess() {
  const info = await runtimeSendMessage({ type: 'POPUP_GET_ACTIVE_TAB_INFO' });
  activeTabInfo = info;

  if (!info?.ok) {
    currentSiteEl.textContent = info?.error || 'No active tab.';
    currentSiteEl.classList.remove('allowed');
    addSiteBtn.disabled = true;
    return;
  }

  const { hostname, isAllowed, isDefault } = info;
  currentSiteEl.classList.toggle('allowed', !!isAllowed);

  if (!hostname) {
    currentSiteEl.textContent = 'Active tab has no host.';
    addSiteBtn.disabled = true;
  } else if (isAllowed) {
    currentSiteEl.textContent = `${hostname} (allowed${isDefault ? ', default' : ''})`;
    addSiteBtn.disabled = true;
    addSiteBtn.textContent = 'Already added';
  } else {
    currentSiteEl.textContent = hostname;
    addSiteBtn.disabled = false;
    addSiteBtn.textContent = 'Add this site';
  }

  await renderDomainList();
}

async function renderDomainList() {
  const resp = await runtimeSendMessage({ type: 'POPUP_LIST_DOMAINS' });
  siteListEl.innerHTML = '';
  if (!resp?.ok) return;

  const domains = resp.domains || [];
  for (const host of domains) {
    const row = document.createElement('div');
    row.className = 'site-row';

    const left = document.createElement('div');
    const hostSpan = document.createElement('span');
    hostSpan.className = 'host';
    hostSpan.textContent = host;
    left.appendChild(hostSpan);

    if (host === DEFAULT_DOMAIN) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'default';
      left.appendChild(badge);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = host === DEFAULT_DOMAIN ? 'Default domain (cannot remove)' : 'Remove';
    removeBtn.disabled = host === DEFAULT_DOMAIN;
    removeBtn.addEventListener('click', async () => {
      removeBtn.disabled = true;
      const r = await runtimeSendMessage({ type: 'POPUP_REMOVE_DOMAIN', hostname: host });
      if (!r?.ok) {
        setStatus(`Remove failed: ${r?.error || 'unknown error'}`, true);
        removeBtn.disabled = false;
        return;
      }
      await refreshSiteAccess();
    });

    row.appendChild(left);
    row.appendChild(removeBtn);
    siteListEl.appendChild(row);
  }
}

addSiteBtn.addEventListener('click', async () => {
  if (!activeTabInfo?.hostname) return;
  const host = activeTabInfo.hostname;

  setStatus(`Requesting permission for ${host}…`);

  let granted = false;
  try {
    granted = await permissionsRequest({ origins: [originPatternForHost(host)] });
  } catch (e) {
    setStatus(`Permission request failed: ${String(e?.message || e)}`, true);
    return;
  }

  if (!granted) {
    setStatus('Permission denied.', true);
    return;
  }

  const resp = await runtimeSendMessage({ type: 'POPUP_ADD_DOMAIN', hostname: host });
  if (!resp?.ok) {
    setStatus(`Could not add site: ${resp?.error || 'unknown error'}`, true);
    return;
  }

  setStatus(`${host} added. Reload the tab to enable the overlay.`);
  await refreshSiteAccess();
});

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

  await refreshSiteAccess();
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

  const resp = await runtimeSendMessage({
    type: 'POPUP_START',
    engineUrl: nextSettings.engineUrl,
  });

  if (resp?.state?.lastError) {
    setStatus(`Error: ${resp.state.lastError}`, true);
  }

  await refresh();
});

stopBtn.addEventListener('click', async () => {
  setStatus('Stopping…');
  await runtimeSendMessage({ type: 'POPUP_STOP' });
  await refresh();
});

refresh();
