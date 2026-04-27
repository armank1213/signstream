(function () {
  const isYouTubeWatch = () => location.hostname === 'www.youtube.com' && location.pathname === '/watch';

  const DEFAULT_SETTINGS = {
    mode: 'sign+captions',
    signRenderMode: 'chips', // chips | gestures | avatar
    overlayPosition: 'right-middle',
    overlayScale: 1.15,
    captionConfThreshold: 0.5,
  };

  let settings = { ...DEFAULT_SETTINGS };
  let pending = { timeoutId: null, tokens: [], conf: 0.0, displayAt: 0 };
  let lastTranscript = '';

  let gestureState = {
    playing: false,
    queue: [],
    cancelToken: 0,
  };

  let avatarState = {
    injected: false,
    initSent: false,
  };

  function injectScriptOnce({ id, src, type }) {
    if (document.getElementById(id)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.id = id;
      s.src = src;
      if (type) s.type = type;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      (document.head || document.documentElement).appendChild(s);
    });
  }

  async function ensureAvatarInjected() {
    if (avatarState.injected) return;
    avatarState.injected = true;

    const url = chrome.runtime.getURL('renderer/avatarPage.mjs');
    try {
      await injectScriptOnce({ id: 'signstream-avatar-module', src: url, type: 'module' });
    } catch (e) {
      setStatus(`Avatar load failed: ${String(e?.message || e)}`);
      avatarState.injected = false;
    }
  }

  function avatarPost(type, payload) {
    try {
      window.postMessage({ __signstream: true, type, ...(payload || {}) }, '*');
    } catch {}
  }

  async function ensureAvatarInit() {
    await ensureAvatarInjected();
    if (avatarState.initSent) return;

    avatarState.initSent = true;
    avatarPost('AVATAR_INIT', { modelUrl: chrome.runtime.getURL('assets/avatar/model.vrm') });
  }

  function sendAvatarTokens(tokens) {
    void ensureAvatarInit();
    avatarPost('AVATAR_TOKENS', { tokens: tokens || [] });
  }

  const gestureAvailabilityCache = new Map();

  function tokenToGestureUrl(token) {
    if (!token || typeof token !== 'string') return null;
    // Skip fingerspelling pseudo-tokens.
    if (token.startsWith('FS:')) return null;

    const safe = token.toLowerCase().replace(/[^a-z0-9_-]+/g, '');
    if (!safe) return null;
    return chrome.runtime.getURL(`assets/signs/${safe}.webm`);
  }

  // Try to avoid repeated failed loads, but don't block playback if probing fails.
  function noteGestureResult(url, ok) {
    if (!url) return;
    gestureAvailabilityCache.set(url, !!ok);
  }

  function applyOverlayPosition(root) {
    // Reset anchors
    root.style.left = '';
    root.style.right = '';
    root.style.top = '';
    root.style.bottom = '';
    root.style.transform = '';

    const pos = settings.overlayPosition;
    if (pos === 'bottom-right') {
      root.style.right = '16px';
      root.style.bottom = '16px';
    } else if (pos === 'bottom-left') {
      root.style.left = '16px';
      root.style.bottom = '16px';
    } else {
      // right-middle
      root.style.right = '16px';
      root.style.top = '50%';
      root.style.transform = 'translateY(-50%)';
    }
  }

  function ensureOverlay() {
    let root = document.getElementById('signstream-overlay-root');
    if (root) return root;

    root = document.createElement('div');
    root.id = 'signstream-overlay-root';
    root.style.position = 'fixed';
    root.style.zIndex = '2147483647';
    root.style.pointerEvents = 'none';
    root.style.maxWidth = '420px';
    root.style.maxHeight = '80vh';
    root.style.overflow = 'hidden';
    root.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';

    applyOverlayPosition(root);

    const panel = document.createElement('div');
    panel.id = 'signstream-overlay-panel';
    panel.style.background = 'rgba(0,0,0,0.80)';
    panel.style.color = 'white';
    panel.style.padding = '14px 16px';
    panel.style.borderRadius = '16px';
    panel.style.backdropFilter = 'blur(10px)';
    panel.style.border = '1px solid rgba(255,255,255,0.20)';
    panel.style.minWidth = '280px';
    panel.style.boxShadow = '0 20px 40px rgba(0,0,0,0.25)';
    panel.style.transformOrigin = 'bottom right';
    panel.style.transform = `scale(${settings.overlayScale || 1})`;

    const title = document.createElement('div');
    title.textContent = 'SignStream';
    title.style.fontSize = '12px';
    title.style.opacity = '0.85';
    title.style.marginBottom = '8px';

    const caption = document.createElement('div');
    caption.id = 'signstream-caption';
    caption.style.fontSize = '14px';
    caption.style.lineHeight = '1.35';
    caption.style.marginBottom = '10px';
    caption.style.opacity = '0.95';

    const avatarWrap = document.createElement('div');
    avatarWrap.id = 'signstream-avatar-wrap';
    avatarWrap.style.display = 'none';

    const gestureWrap = document.createElement('div');
    gestureWrap.id = 'signstream-gesture-wrap';
    gestureWrap.style.display = 'none';
    gestureWrap.style.gap = '8px';
    gestureWrap.style.alignItems = 'center';

    const gestureVideo = document.createElement('video');
    gestureVideo.id = 'signstream-gesture-video';
    gestureVideo.muted = true;
    gestureVideo.playsInline = true;
    gestureVideo.autoplay = true;
    gestureVideo.preload = 'auto';
    gestureVideo.style.width = '160px';
    gestureVideo.style.height = '160px';
    gestureVideo.style.objectFit = 'contain';
    gestureVideo.style.borderRadius = '16px';
    gestureVideo.style.border = '1px solid rgba(255,255,255,0.20)';
    gestureVideo.style.background = 'rgba(255,255,255,0.06)';

    const gestureLabel = document.createElement('div');
    gestureLabel.id = 'signstream-gesture-label';
    gestureLabel.style.fontSize = '13px';
    gestureLabel.style.opacity = '0.9';
    gestureLabel.style.fontWeight = '700';

    gestureWrap.appendChild(gestureVideo);
    gestureWrap.appendChild(gestureLabel);

    const chips = document.createElement('div');
    chips.id = 'signstream-chips';
    chips.style.display = 'flex';
    chips.style.flexWrap = 'wrap';
    chips.style.gap = '8px';

    const status = document.createElement('div');
    status.id = 'signstream-status';
    status.style.marginTop = '10px';
    status.style.fontSize = '12px';
    status.style.opacity = '0.8';
    status.textContent = 'Listening…';

    panel.appendChild(title);
    panel.appendChild(caption);
    panel.appendChild(avatarWrap);
    panel.appendChild(gestureWrap);
    panel.appendChild(chips);
    panel.appendChild(status);
    root.appendChild(panel);
    document.documentElement.appendChild(root);

    return root;
  }

  async function playGestureSequence(tokens) {
    const root = ensureOverlay();
    const wrap = root.querySelector('#signstream-gesture-wrap');
    const video = root.querySelector('#signstream-gesture-video');
    const label = root.querySelector('#signstream-gesture-label');

    if (!wrap || !video || !label) return;

    const myToken = ++gestureState.cancelToken;
    gestureState.playing = true;

    wrap.style.display = 'flex';

    const queue = (tokens || []).slice(0, 12);
    for (const t of queue) {
      if (myToken !== gestureState.cancelToken) break;

      const url = tokenToGestureUrl(t);
      if (!url) continue;

      // If we've already learned this URL is missing, skip it.
      if (gestureAvailabilityCache.get(url) === false) continue;

      label.textContent = String(t);

      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          video.onended = null;
          video.onerror = null;
          resolve();
        };

        video.onended = () => {
          noteGestureResult(url, true);
          finish();
        };
        video.onerror = () => {
          noteGestureResult(url, false);
          finish();
        };

        // Safety timeout (prevents hanging if onended never fires)
        const timeoutMs = 900;
        setTimeout(finish, timeoutMs);

        video.src = url;
        video.currentTime = 0;
        void video.play().catch(() => finish());
      });

      // Small gap between signs
      await new Promise((r) => setTimeout(r, 120));
    }

    if (myToken === gestureState.cancelToken) {
      label.textContent = '';
    }

    gestureState.playing = false;
  }

  function stopGestures() {
    gestureState.cancelToken++;
    gestureState.playing = false;

    const root = document.getElementById('signstream-overlay-root');
    const wrap = root?.querySelector?.('#signstream-gesture-wrap');
    const video = root?.querySelector?.('#signstream-gesture-video');
    const label = root?.querySelector?.('#signstream-gesture-label');

    try {
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load?.();
      }
    } catch {}

    if (label) label.textContent = '';
    if (wrap) wrap.style.display = 'none';
  }

  function render(tokens, conf) {
    const root = ensureOverlay();
    const chips = root.querySelector('#signstream-chips');
    const status = root.querySelector('#signstream-status');
    const caption = root.querySelector('#signstream-caption');
    const avatarWrap = root.querySelector('#signstream-avatar-wrap');
    const gestureWrap = root.querySelector('#signstream-gesture-wrap');
    const mode = settings.mode;

    if (caption) {
      caption.style.display = mode === 'sign-only' ? 'none' : 'block';
      caption.textContent = lastTranscript || '';
      caption.style.opacity = conf < (settings.captionConfThreshold || 0.5) ? '1' : '0.9';
    }

    const wantsSigns = mode !== 'captions-only';
    const wantsGestures = wantsSigns && settings.signRenderMode === 'gestures';
    const wantsAvatar = wantsSigns && settings.signRenderMode === 'avatar';

    if (avatarWrap) {
      avatarWrap.style.display = wantsAvatar ? 'block' : 'none';
    }

    if (gestureWrap) {
      gestureWrap.style.display = wantsGestures ? 'flex' : 'none';
    }

    if (chips) {
      chips.style.display = wantsSigns && !wantsGestures && !wantsAvatar ? 'flex' : 'none';
      chips.textContent = '';
      (tokens || []).slice(0, 16).forEach((t) => {
        const chip = document.createElement('span');

        const isFs = typeof t === 'string' && t.startsWith('FS:');
        const fsValue = isFs ? t.slice(3) : null;

        chip.textContent = isFs ? (fsValue ? fsValue.split('').join(' ') : '') : t;
        chip.style.display = 'inline-block';
        chip.style.padding = '6px 10px';
        chip.style.borderRadius = isFs ? '12px' : '999px';
        chip.style.background = conf < (settings.captionConfThreshold || 0.5)
          ? 'rgba(255,255,255,0.10)'
          : 'rgba(255,255,255,0.16)';
        chip.style.border = '1px solid rgba(255,255,255,0.20)';
        chip.style.fontSize = isFs ? '14px' : '15px';
        chip.style.letterSpacing = isFs ? '1.2px' : '0.4px';
        chip.style.fontWeight = '700';
        if (isFs) chip.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        chips.appendChild(chip);
      });
    }

    if (status) {
      status.textContent = conf < (settings.captionConfThreshold || 0.5)
        ? 'Low confidence — showing captions'
        : (settings.signRenderMode === 'gestures'
          ? 'Live (gestures)'
          : settings.signRenderMode === 'avatar'
            ? 'Live (avatar)'
            : 'Live');
    }

    if (wantsGestures) {
      stopGestures();
      void playGestureSequence(tokens || []);
    } else {
      stopGestures();
    }

    if (wantsAvatar) {
      sendAvatarTokens(tokens || []);
    }
  }

  function scheduleRender(tokens, conf, displayAtEpochMs) {
    const when = Number(displayAtEpochMs || Date.now());

    pending.tokens = tokens || [];
    pending.conf = Number(conf || 0);
    pending.displayAt = when;

    if (pending.timeoutId) clearTimeout(pending.timeoutId);

    const delay = Math.max(0, when - Date.now());
    pending.timeoutId = setTimeout(() => {
      pending.timeoutId = null;
      render(pending.tokens, pending.conf);
    }, delay);
  }

  function setStatus(text) {
    const root = ensureOverlay();
    const status = root.querySelector('#signstream-status');
    if (status) status.textContent = text;
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (items) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(items || {});
      });
    });
  }

  async function loadSettings() {
    const stored = await storageGet(Object.keys(DEFAULT_SETTINGS));
    settings = { ...DEFAULT_SETTINGS, ...stored };

    const root = document.getElementById('signstream-overlay-root');
    if (root) applyOverlayPosition(root);

    const panel = document.getElementById('signstream-overlay-panel');
    if (panel) panel.style.transform = `scale(${settings.overlayScale || 1})`;
  }

  // Always register listeners even if we weren't on /watch when the script first ran.
  // YouTube is SPA-like; the user may navigate to /watch without a full page reload.

  if (isYouTubeWatch()) {
    ensureOverlay();
    void loadSettings();
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    void loadSettings();
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__signstream !== true) return;

    if (msg.type === 'AVATAR_STATUS') {
      setStatus(msg.status || '');
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!isYouTubeWatch()) return;

    if (msg?.type === 'ENGINE_TOKENS') {
      const tokens = msg.tokens || [];
      const conf = Number(msg.conf || 0);
      const displayAt = msg.display_at_epoch_ms || Date.now();
      scheduleRender(tokens, conf, displayAt);
    }

    if (msg?.type === 'ENGINE_TRANSCRIPT') {
      lastTranscript = msg.text || '';
      // If we're caption-focused, update immediately.
      if (settings.mode !== 'sign-only') {
        render(pending.tokens || [], pending.conf || 0);
      }
    }

    if (msg?.type === 'ENGINE_STATUS') {
      setStatus(msg.status || '');
    }
  });

  const obs = new MutationObserver(() => {
    if (isYouTubeWatch()) {
      ensureOverlay();
      void loadSettings();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
