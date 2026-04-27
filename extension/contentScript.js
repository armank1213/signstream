(function () {
  const isYouTube = () => location.hostname === 'www.youtube.com';
  const isYouTubeWatch = () => isYouTube() && location.pathname === '/watch';
  // On YouTube, only show on /watch pages (other YT pages don't have audio worth captioning).
  // On every other allowed site, just always run.
  const isEnabled = () => (isYouTube() ? isYouTubeWatch() : true);

  const DEFAULT_SETTINGS = {
    mode: 'sign+captions',
    signRenderMode: 'chips', // chips | gestures
    overlayPosition: 'right-middle',
    overlayCollapsed: false,
    captionConfThreshold: 0.5,
  };

  const OVERLAY_MAX_WIDTH = 440;

  let settings = { ...DEFAULT_SETTINGS };
  let pending = { timeoutId: null, tokens: [], conf: 0.0, displayAt: 0 };
  let lastTranscript = '';

  let gestureState = {
    wordQueue: [],
    processedWords: [],
    displayTimeoutId: null,
    isActive: false,
  };

  const gestureAvailabilityCache = new Map();

  function expandFsToken(token) {
    if (typeof token !== 'string' || !token.startsWith('FS:')) return [token];
    const value = token.slice(3).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!value) return [];
    if (value.length <= 1) return [token];
    return value.split('').map((ch) => `FS:${ch}`);
  }

  function tokenToGestureAssetUrls(token) {
    if (!token || typeof token !== 'string') return [];

    let normalized = token;
    if (token.startsWith('FS:')) {
      normalized = token.slice(3);
    }

    const safe = normalized.toLowerCase().replace(/[^a-z0-9_-]+/g, '');
    if (!safe) return [];
    const firstLetter = safe.charAt(0).toUpperCase();
    const base = chrome.runtime.getURL(`assets/signs/test/${firstLetter}/${safe}`);
    return [
      `${base}.webm`,
      `${base}.png`,
      `${base}.webp`,
      `${base}.jpg`,
      `${base}.jpeg`,
    ];
  }

  function tokenToGestureImageUrls(token) {
    if (!token || typeof token !== 'string') return [];

    let normalized = token;
    if (token.startsWith('FS:')) {
      normalized = token.slice(3);
    }

    const safe = normalized.toLowerCase().replace(/[^a-z0-9_-]+/g, '');
    if (!safe) return [];
    const firstLetter = safe.charAt(0).toUpperCase();
    const base = chrome.runtime.getURL(`assets/signs/test/${firstLetter}/${safe}`);
    return [
      `${base}.png`,
      `${base}.webp`,
      `${base}.jpg`,
      `${base}.jpeg`,
    ];
  }

  function loadImageWithFallback(img, urls) {
    return new Promise((resolve) => {
      const next = () => {
        if (urls.length === 0) {
          resolve(false);
          return;
        }

        const url = urls.shift();
        img.src = url;
      };

      img.onload = () => resolve(true);
      img.onerror = () => next();
      next();
    });
  }

  function normalizeWord(word) {
    if (typeof word !== 'string') return '';
    return word.toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function transcriptToWords(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    return text.trim().split(/\s+/).filter(Boolean);
  }

  function commonPrefixLength(a, b) {
    const len = Math.min(a.length, b.length);
    let i = 0;
    while (i < len && normalizeWord(a[i]) === normalizeWord(b[i])) i++;
    return i;
  }

  function wordDisplayDurationMs(word) {
    const letters = normalizeWord(word);
    return Math.min(2500, Math.max(800, letters.length * 250));
  }

  function wordToLetterTokens(word) {
    if (!word || typeof word !== 'string') return [];
    return word.toLowerCase().split('').map((ch) => `FS:${ch}`);
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
    const viewportWidth = window.innerWidth;
    const effectiveWidth = Math.min(OVERLAY_MAX_WIDTH, viewportWidth - 32);

    let panelOrigin = 'center right';
    let useLeft = false;

    if (pos === 'bottom-right') {
      if (16 + effectiveWidth > viewportWidth) {
        root.style.left = '16px';
        useLeft = true;
      } else {
        root.style.right = '16px';
      }
      root.style.bottom = '16px';
      panelOrigin = useLeft ? 'bottom left' : 'bottom right';
    } else if (pos === 'bottom-left') {
      root.style.left = '16px';
      root.style.bottom = '16px';
      panelOrigin = 'bottom left';
    } else {
      // right-middle (default)
      if (16 + effectiveWidth > viewportWidth) {
        root.style.left = '16px';
        root.style.top = '50%';
        root.style.transform = 'translateY(-50%)';
        panelOrigin = 'center left';
      } else {
        root.style.right = '16px';
        root.style.top = '50%';
        root.style.transform = 'translateY(-50%)';
        panelOrigin = 'center right';
      }
    }

    const panel = root.querySelector('#signstream-overlay-panel');
    if (panel) panel.style.transformOrigin = panelOrigin;
  }

  function ensureOverlayStyles() {
    if (document.getElementById('signstream-overlay-style')) return;
    const style = document.createElement('style');
    style.id = 'signstream-overlay-style';
    style.textContent = `
#signstream-overlay-root { pointer-events: none; }
#signstream-overlay-panel { pointer-events: auto; transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease; }
#signstream-overlay-panel:hover { box-shadow: 0 24px 50px rgba(0,0,0,0.35); border-color: rgba(255,255,255,0.35); }
.ss-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ss-header-left { display: flex; align-items: center; gap: 8px; }
.ss-logo { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border-radius: 8px; background: rgba(56,189,248,0.15); border: 1px solid rgba(56,189,248,0.4); }
.ss-title { font-size: 12px; font-weight: 600; opacity: 0.9; }
.ss-pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(34,197,94,0.45); background: rgba(34,197,94,0.15); color: #bbf7d0; }
.ss-pill.error { border-color: rgba(248,113,113,0.5); background: rgba(248,113,113,0.2); color: #fecaca; }
.ss-pill.idle { border-color: rgba(148,163,184,0.4); background: rgba(148,163,184,0.15); color: #e2e8f0; }
.ss-collapse { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #e5e7eb; border-radius: 8px; cursor: pointer; padding: 2px 6px; display: flex; align-items: center; justify-content: center; transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease; }
.ss-collapse:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.4); }
.ss-collapse-icon { display: block; transition: transform 0.2s ease; }
.ss-panel.collapsed .ss-collapse-icon { transform: rotate(-90deg); }
.ss-body { margin-top: 10px; transition: max-height 0.25s ease, opacity 0.2s ease, margin-top 0.2s ease; max-height: 1000px; opacity: 1; }
.ss-panel.collapsed .ss-body { max-height: 0; opacity: 0; margin-top: 0; pointer-events: none; }
.ss-toggle-row { display: flex; gap: 6px; margin-bottom: 10px; }
.ss-toggle { padding: 4px 10px; font-size: 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: #e5e7eb; cursor: pointer; transition: background 0.2s ease, border-color 0.2s ease; }
.ss-toggle:hover { background: rgba(255,255,255,0.14); }
.ss-toggle.active { background: rgba(56,189,248,0.25); border-color: rgba(56,189,248,0.6); color: #e0f2fe; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureOverlay() {
    let root = document.getElementById('signstream-overlay-root');
    if (root) return root;

    ensureOverlayStyles();

    root = document.createElement('div');
    root.id = 'signstream-overlay-root';
    root.style.position = 'fixed';
    root.style.zIndex = '2147483647';
    root.style.pointerEvents = 'none';
    root.style.overflow = 'visible';
    root.style.width = 'auto';
    root.style.maxWidth = `min(${OVERLAY_MAX_WIDTH}px, calc(100vw - 32px))`;
    root.style.maxHeight = '80vh';
    root.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    root.style.contains = 'layout style paint';

    const panel = document.createElement('div');
    panel.id = 'signstream-overlay-panel';
    panel.className = 'ss-panel';
    panel.style.background = 'rgba(7,11,20,0.92)';
    panel.style.color = 'white';
    panel.style.padding = '12px 14px';
    panel.style.borderRadius = '16px';
    panel.style.backdropFilter = 'blur(12px)';
    panel.style.border = '1px solid rgba(255,255,255,0.20)';
    panel.style.visibility = 'visible';
    panel.style.opacity = '1';
    panel.style.width = '100%';
    panel.style.minWidth = '280px';
    panel.style.maxWidth = '100%';
    panel.style.boxSizing = 'border-box';
    panel.style.boxShadow = '0 20px 40px rgba(0,0,0,0.25)';
    panel.style.wordWrap = 'break-word';
    panel.style.overflowWrap = 'break-word';

    const header = document.createElement('div');
    header.className = 'ss-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'ss-header-left';

    const logo = document.createElement('div');
    logo.className = 'ss-logo';
    logo.innerHTML = `
      <svg viewBox="0 0 32 32" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="16" cy="16" r="13" stroke="#38BDF8" stroke-width="2" />
        <path d="M7.5 18.5c3-3.6 6-3.6 9 0s6 3.6 9 0" stroke="#22C55E" stroke-width="2" stroke-linecap="round" />
        <circle cx="16" cy="11" r="2" fill="#E2E8F0" />
      </svg>
    `;

    const title = document.createElement('div');
    title.className = 'ss-title';
    title.textContent = 'SignStream';

    headerLeft.appendChild(logo);
    headerLeft.appendChild(title);

    const headerRight = document.createElement('div');
    headerRight.style.display = 'flex';
    headerRight.style.alignItems = 'center';
    headerRight.style.gap = '6px';

    const statusPill = document.createElement('span');
    statusPill.id = 'signstream-status-pill';
    statusPill.className = 'ss-pill idle';
    statusPill.textContent = 'Ready';

    const collapseBtn = document.createElement('button');
    collapseBtn.id = 'signstream-collapse-btn';
    collapseBtn.className = 'ss-collapse';
    collapseBtn.type = 'button';
    collapseBtn.setAttribute('aria-expanded', 'true');
    collapseBtn.setAttribute('aria-label', 'Collapse panel');
    collapseBtn.innerHTML = '<span class="ss-collapse-icon">▾</span>';

    headerRight.appendChild(statusPill);
    headerRight.appendChild(collapseBtn);

    header.appendChild(headerLeft);
    header.appendChild(headerRight);

    const body = document.createElement('div');
    body.id = 'signstream-overlay-body';
    body.className = 'ss-body';

    const toggleRow = document.createElement('div');
    toggleRow.className = 'ss-toggle-row';

    const captionsToggle = document.createElement('button');
    captionsToggle.id = 'signstream-toggle-captions';
    captionsToggle.className = 'ss-toggle';
    captionsToggle.type = 'button';
    captionsToggle.textContent = 'Captions';

    const signsToggle = document.createElement('button');
    signsToggle.id = 'signstream-toggle-signs';
    signsToggle.className = 'ss-toggle';
    signsToggle.type = 'button';
    signsToggle.textContent = 'Signs';

    toggleRow.appendChild(captionsToggle);
    toggleRow.appendChild(signsToggle);

    const caption = document.createElement('div');
    caption.id = 'signstream-caption';
    caption.style.fontSize = '14px';
    caption.style.lineHeight = '1.35';
    caption.style.marginBottom = '10px';
    caption.style.opacity = '0.95';
    caption.style.wordWrap = 'break-word';
    caption.style.overflowWrap = 'break-word';
    caption.style.hyphens = 'auto';

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

    const gestureLetters = document.createElement('div');
    gestureLetters.id = 'signstream-gesture-letters';
    gestureLetters.style.display = 'none';
    gestureLetters.style.gap = '8px';
    gestureLetters.style.flexWrap = 'wrap';
    gestureLetters.style.alignItems = 'center';
    gestureLetters.style.justifyContent = 'center';

    const gestureLabel = document.createElement('div');
    gestureLabel.id = 'signstream-gesture-label';
    gestureLabel.style.fontSize = '13px';
    gestureLabel.style.opacity = '0.9';
    gestureLabel.style.fontWeight = '700';

    gestureWrap.appendChild(gestureVideo);
    gestureWrap.appendChild(gestureLetters);
    gestureWrap.appendChild(gestureLabel);

    const chips = document.createElement('div');
    chips.id = 'signstream-chips';
    chips.style.display = 'flex';
    chips.style.flexWrap = 'wrap';
    chips.style.gap = '8px';
    chips.style.width = '100%';
    chips.style.boxSizing = 'border-box';

    const status = document.createElement('div');
    status.id = 'signstream-status';
    status.style.marginTop = '10px';
    status.style.fontSize = '12px';
    status.style.opacity = '0.8';
    status.textContent = 'Listening…';

    body.appendChild(toggleRow);
    body.appendChild(caption);
    body.appendChild(gestureWrap);
    body.appendChild(chips);
    body.appendChild(status);

    panel.appendChild(header);
    panel.appendChild(body);
    root.appendChild(panel);
    applyOverlayPosition(root);
    document.documentElement.appendChild(root);

    collapseBtn.addEventListener('click', () => {
      setOverlayCollapsed(!settings.overlayCollapsed, true);
    });

    captionsToggle.addEventListener('click', () => {
      toggleOverlayMode('captions');
    });

    signsToggle.addEventListener('click', () => {
      toggleOverlayMode('signs');
    });

    return root;
  }

  function renderQueuedWord(word) {
    const root = ensureOverlay();
    const gestureLetters = root.querySelector('#signstream-gesture-letters');
    const label = root.querySelector('#signstream-gesture-label');
    if (!gestureLetters || !label) return false;

    const letters = normalizeWord(word);
    if (!letters) return false;

    label.textContent = word;
    gestureLetters.innerHTML = '';

    const letterTokens = wordToLetterTokens(letters);
    console.log('[SignStream] Fingerspelling word:', word, 'letters:', letterTokens);

    letterTokens.forEach((letterToken) => {
      const imageUrls = tokenToGestureImageUrls(letterToken);
      if (imageUrls.length === 0) {
        console.warn('[SignStream] No gesture URLs for letter:', letterToken);
        return;
      }

      const img = document.createElement('img');
      img.style.width = '80px';
      img.style.height = '80px';
      img.style.objectFit = 'contain';
      img.style.borderRadius = '8px';
      img.style.border = '1px solid rgba(255,255,255,0.20)';
      img.style.background = 'rgba(255,255,255,0.06)';
      img.style.marginRight = '4px';
      gestureLetters.appendChild(img);

      loadImageWithFallback(img, imageUrls.slice()).then((loaded) => {
        if (!loaded) {
          console.warn('[SignStream] Failed to load gesture image for letter:', letterToken);
        }
      });
    });

    return true;
  }

  function processWordQueue() {
    gestureState.displayTimeoutId = null;
    if (!gestureState.isActive || gestureState.wordQueue.length === 0) return;

    const word = gestureState.wordQueue.shift();
    if (!renderQueuedWord(word)) {
      processWordQueue();
      return;
    }

    gestureState.displayTimeoutId = setTimeout(processWordQueue, wordDisplayDurationMs(word));
  }

  function enqueueWordsFromTranscript() {
    if (!gestureState.isActive) return;

    const newWords = transcriptToWords(lastTranscript);
    const prefix = commonPrefixLength(gestureState.processedWords, newWords);
    const toEnqueue = newWords
      .slice(prefix)
      .filter((w) => normalizeWord(w).length > 0);

    gestureState.processedWords = newWords;
    if (toEnqueue.length === 0) return;

    gestureState.wordQueue.push(...toEnqueue);
    if (!gestureState.displayTimeoutId) processWordQueue();
  }

  function startGestureRefresh() {
    const root = ensureOverlay();
    const wrap = root.querySelector('#signstream-gesture-wrap');
    const gestureLetters = root.querySelector('#signstream-gesture-letters');
    const label = root.querySelector('#signstream-gesture-label');
    if (!wrap || !gestureLetters || !label) return;

    wrap.style.display = 'flex';
    gestureLetters.style.display = 'flex';

    if (gestureState.isActive) return;

    gestureState.isActive = true;
    gestureState.processedWords = [];
    gestureState.wordQueue = [];
    enqueueWordsFromTranscript();
  }

  function stopGestureRefresh() {
    if (gestureState.displayTimeoutId) {
      clearTimeout(gestureState.displayTimeoutId);
      gestureState.displayTimeoutId = null;
    }
    gestureState.wordQueue = [];
    gestureState.processedWords = [];
    gestureState.isActive = false;

    const root = document.getElementById('signstream-overlay-root');
    const wrap = root?.querySelector?.('#signstream-gesture-wrap');
    const video = root?.querySelector?.('#signstream-gesture-video');
    const label = root?.querySelector?.('#signstream-gesture-label');
    const gestureLetters = root?.querySelector?.('#signstream-gesture-letters');

    try {
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load?.();
      }
    } catch {}

    if (gestureLetters) gestureLetters.innerHTML = '';
    if (label) label.textContent = '';
    if (wrap) wrap.style.display = 'none';
  }

  function stopRendering() {
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
      pending.timeoutId = null;
    }
    pending.tokens = [];
    pending.conf = 0;
    pending.displayAt = 0;
    stopGestureRefresh();

    const root = document.getElementById('signstream-overlay-root');
    if (!root) return;

    const chips = root.querySelector('#signstream-chips');
    const caption = root.querySelector('#signstream-caption');
    const status = root.querySelector('#signstream-status');

    if (chips) chips.textContent = '';
    if (caption) caption.textContent = '';
    if (status) status.textContent = 'Stopped';
  }

  function render(tokens, conf) {
    const root = ensureOverlay();
    const chips = root.querySelector('#signstream-chips');
    const status = root.querySelector('#signstream-status');
    const caption = root.querySelector('#signstream-caption');
    const gestureWrap = root.querySelector('#signstream-gesture-wrap');
    const mode = settings.mode;

    console.log('[SignStream] Render called with tokens:', tokens, 'mode:', mode, 'signRenderMode:', settings.signRenderMode);

    if (caption) {
      caption.style.display = mode === 'sign-only' ? 'none' : 'block';
      caption.textContent = lastTranscript || '';
      caption.style.opacity = conf < (settings.captionConfThreshold || 0.5) ? '1' : '0.9';
    }

    const wantsSigns = mode !== 'captions-only';
    const wantsGestures = wantsSigns && settings.signRenderMode === 'gestures';

    if (gestureWrap) {
      gestureWrap.style.display = wantsGestures ? 'flex' : 'none';
    }

    if (chips) {
      chips.style.display = wantsSigns && !wantsGestures ? 'flex' : 'none';
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
        : (settings.signRenderMode === 'gestures' ? 'Live (gestures)' : 'Live');
    }

    if (wantsGestures) {
      startGestureRefresh();
    } else {
      stopGestureRefresh();
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
      try {
        render(pending.tokens, pending.conf);
      } catch (e) {
        console.warn('[SignStream] render failed:', e);
      }
    }, delay);
  }

  function setStatus(text) {
    const root = ensureOverlay();
    const status = root.querySelector('#signstream-status');
    if (status) status.textContent = text;
  }

  function setStatusPill(text, tone = 'active') {
    const root = ensureOverlay();
    const pill = root.querySelector('#signstream-status-pill');
    if (!pill) return;
    pill.textContent = text;
    pill.classList.toggle('error', tone === 'error');
    pill.classList.toggle('idle', tone === 'idle');
    if (tone !== 'error' && tone !== 'idle') {
      pill.classList.remove('error', 'idle');
    }
  }

  function setToggleButton(btn, enabled) {
    if (!btn) return;
    btn.classList.toggle('active', !!enabled);
    btn.setAttribute('aria-pressed', String(!!enabled));
  }

  function applyModeToOverlayControls(mode) {
    const root = ensureOverlay();
    const captionsBtn = root.querySelector('#signstream-toggle-captions');
    const signsBtn = root.querySelector('#signstream-toggle-signs');
    const captionsOn = mode !== 'sign-only';
    const signsOn = mode !== 'captions-only';
    setToggleButton(captionsBtn, captionsOn);
    setToggleButton(signsBtn, signsOn);
  }

  function toggleOverlayMode(target) {
    const root = ensureOverlay();
    const captionsBtn = root.querySelector('#signstream-toggle-captions');
    const signsBtn = root.querySelector('#signstream-toggle-signs');
    const captionsOn = captionsBtn?.classList.contains('active');
    const signsOn = signsBtn?.classList.contains('active');
    let nextCaptions = !!captionsOn;
    let nextSigns = !!signsOn;

    if (target === 'captions') nextCaptions = !nextCaptions;
    if (target === 'signs') nextSigns = !nextSigns;

    if (!nextCaptions && !nextSigns) nextCaptions = true;

    const nextMode = nextCaptions && nextSigns
      ? 'sign+captions'
      : (nextSigns ? 'sign-only' : 'captions-only');

    settings.mode = nextMode;
    applyModeToOverlayControls(nextMode);
    void storageSet({ mode: nextMode });
    render(pending.tokens || [], pending.conf || 0);
  }

  function setOverlayCollapsed(collapsed, persist) {
    settings.overlayCollapsed = !!collapsed;
    const root = ensureOverlay();
    const panel = root.querySelector('#signstream-overlay-panel');
    const collapseBtn = root.querySelector('#signstream-collapse-btn');
    if (panel) panel.classList.toggle('collapsed', settings.overlayCollapsed);
    if (collapseBtn) {
      collapseBtn.setAttribute('aria-expanded', String(!settings.overlayCollapsed));
      collapseBtn.setAttribute('aria-label', settings.overlayCollapsed ? 'Expand panel' : 'Collapse panel');
    }
    if (persist) void storageSet({ overlayCollapsed: settings.overlayCollapsed });
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

  function storageSet(items) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(items, () => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve();
      });
    });
  }

  async function loadSettings() {
    const stored = await storageGet(Object.keys(DEFAULT_SETTINGS));
    settings = { ...DEFAULT_SETTINGS, ...stored };

    const root = document.getElementById('signstream-overlay-root');
    if (root) {
      applyOverlayPosition(root);
      applyModeToOverlayControls(settings.mode);
      setOverlayCollapsed(!!settings.overlayCollapsed, false);
      render(pending.tokens || [], pending.conf || 0);
    }
  }

  // Always register listeners even if we weren't on a watchable page when the script first ran.
  // YouTube is SPA-like; the user may navigate to /watch without a full page reload.

  if (isEnabled()) {
    ensureOverlay();
    void loadSettings();
    console.log(`[SignStream] Overlay initialized on ${location.hostname}`);
  } else {
    console.log(`[SignStream] Disabled on ${location.hostname}`);
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    void loadSettings();
  });

  // Reposition overlay on window resize to ensure it stays visible
  window.addEventListener('resize', () => {
    const root = document.getElementById('signstream-overlay-root');
    if (root) applyOverlayPosition(root);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!isEnabled()) return;

    if (msg?.type === 'ENGINE_TOKENS') {
      // Token-based rendering no longer used; gestures now driven by caption words
    }

    if (msg?.type === 'ENGINE_TRANSCRIPT') {
      lastTranscript = msg.text || '';
      render(pending.tokens || [], pending.conf || 0);
      enqueueWordsFromTranscript();
    }

    if (msg?.type === 'ENGINE_STATUS') {
      setStatus(msg.status || '');
      if (msg.status === 'Stopped' || msg.status === 'Idle' || msg.status === 'Error') {
        stopRendering();
      }
    }

    if (msg?.type === 'SIGNSTREAM_STOP' || msg?.type === 'OFFSCREEN_STOP') {
      stopRendering();
    }
  });

  // Only YouTube needs SPA-style re-injection on URL changes; non-SPA sites init once.
  if (isYouTube()) {
    const obs = new MutationObserver(() => {
      if (isEnabled()) {
        ensureOverlay();
        void loadSettings();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
