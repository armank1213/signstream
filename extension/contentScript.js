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

  // Avatar renderer runs in the content script world (avoids YouTube CSP blocking injected scripts).
  let avatarState = {
    loading: null,
    ready: false,
    error: null,
    THREE: null,
    GLTFLoader: null,
    scene: null,
    camera: null,
    renderer: null,
    clock: null,
    avatar: null,
    bones: {},
    gesture: { name: null, t0: 0 },
  };

  function ensureAvatarMount() {
    const root = ensureOverlay();
    const wrap = root.querySelector('#signstream-avatar-wrap');
    if (!wrap) return null;

    let canvas = wrap.querySelector('#signstream-avatar-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'signstream-avatar-canvas';
      canvas.style.width = '220px';
      canvas.style.height = '220px';
      canvas.style.borderRadius = '16px';
      canvas.style.border = '1px solid rgba(255,255,255,0.20)';
      canvas.style.background = 'rgba(255,255,255,0.06)';
      canvas.style.display = 'block';
      wrap.appendChild(canvas);
    }

    let label = wrap.querySelector('#signstream-avatar-label');
    if (!label) {
      label = document.createElement('div');
      label.id = 'signstream-avatar-label';
      label.style.marginTop = '8px';
      label.style.fontSize = '13px';
      label.style.fontWeight = '700';
      label.style.opacity = '0.9';
      wrap.appendChild(label);
    }

    return { wrap, canvas, label };
  }

  function findFirstByName(root, patterns) {
    if (!root) return null;
    const pats = (patterns || []).map((p) => String(p).toLowerCase());
    let best = null;
    root.traverse((o) => {
      if (!o || !o.name) return;
      const n = String(o.name).toLowerCase();
      if (pats.some((p) => n.includes(p))) best = o;
    });
    return best;
  }

  function avatarCacheBones(avatarRoot) {
    const rightHand = findFirstByName(avatarRoot, [
      'r_hand',
      'righthand',
      'j_bip_r_hand',
      'hand_r',
      'rhand',
      'handright',
      'hand',
    ]);
    const leftHand = findFirstByName(avatarRoot, [
      'l_hand',
      'lefthand',
      'j_bip_l_hand',
      'hand_l',
      'lhand',
      'handleft',
      'hand',
    ]);
    const head = findFirstByName(avatarRoot, ['head']);

    avatarState.bones = { rightHand, leftHand, head };
  }

  function avatarResetRotation(o, s = 0.15) {
    if (!o || !o.rotation) return;
    o.rotation.x *= 1 - s;
    o.rotation.y *= 1 - s;
    o.rotation.z *= 1 - s;
  }

  function avatarApplyGesture(name, t) {
    const { rightHand, leftHand, head } = avatarState.bones || {};

    avatarResetRotation(rightHand);
    avatarResetRotation(leftHand);
    avatarResetRotation(head, 0.08);

    const wave = Math.sin(t * Math.PI * 2);

    if (name === 'HELLO') {
      if (rightHand) rightHand.rotation.z += wave * 0.6;
    } else if (name === 'YES') {
      if (head) head.rotation.x += Math.sin(t * Math.PI * 4) * 0.15;
    } else if (name === 'NO') {
      if (head) head.rotation.y += Math.sin(t * Math.PI * 4) * 0.25;
    } else if (name === 'THANK') {
      if (rightHand) rightHand.rotation.x += -0.6 * Math.sin(t * Math.PI);
    } else if (name === 'PLEASE') {
      if (rightHand) rightHand.rotation.y += 0.4 * Math.sin(t * Math.PI * 2);
    } else if (name === 'HELP') {
      if (leftHand) leftHand.rotation.y += -0.35 * Math.sin(t * Math.PI);
      if (rightHand) rightHand.rotation.y += 0.35 * Math.sin(t * Math.PI);
    } else {
      if (rightHand) rightHand.rotation.x += 0.25 * Math.sin(t * Math.PI * 2);
    }
  }

  function avatarAnimate() {
    if (!avatarState.renderer || !avatarState.scene || !avatarState.camera) return;

    if (avatarState.avatar) {
      avatarState.avatar.rotation.y = Math.sin(Date.now() / 2000) * 0.15;
    }

    if (avatarState.gesture?.name) {
      const dur = 0.85;
      const t = Math.min(1, (performance.now() - avatarState.gesture.t0) / (dur * 1000));
      avatarApplyGesture(avatarState.gesture.name, t);
      if (t >= 1) avatarState.gesture.name = null;
    }

    const canvas = avatarState.renderer.domElement;
    const w = canvas.clientWidth || 220;
    const h = canvas.clientHeight || 220;
    avatarState.renderer.setSize(w, h, false);
    avatarState.camera.aspect = w / h;
    avatarState.camera.updateProjectionMatrix();

    avatarState.renderer.render(avatarState.scene, avatarState.camera);
    requestAnimationFrame(avatarAnimate);
  }

  async function ensureAvatarReady() {
    if (avatarState.ready) return;
    if (avatarState.loading) return avatarState.loading;

    avatarState.loading = (async () => {
      const mount = ensureAvatarMount();
      if (!mount) throw new Error('Avatar mount missing');

      const { canvas, label } = mount;
      label.textContent = 'Loading avatar…';

      // Load modules (must be web accessible for some Chrome versions)
      const threeUrl = chrome.runtime.getURL('lib/three.module.min.js');
      const loaderUrl = chrome.runtime.getURL('lib/GLTFLoader.mjs');

      const THREE = await import(threeUrl);
      const loaderMod = await import(loaderUrl);

      const GLTFLoader = loaderMod.GLTFLoader;
      if (!GLTFLoader) throw new Error('GLTFLoader unavailable');

      avatarState.THREE = THREE;
      avatarState.GLTFLoader = GLTFLoader;

      avatarState.scene = new THREE.Scene();

      avatarState.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
      avatarState.camera.position.set(0, 1.35, 2.2);

      avatarState.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      avatarState.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

      const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
      hemi.position.set(0, 2, 0);
      avatarState.scene.add(hemi);

      const dir = new THREE.DirectionalLight(0xffffff, 0.9);
      dir.position.set(1, 2, 1);
      avatarState.scene.add(dir);

      const modelUrl = chrome.runtime.getURL('assets/avatar/model.vrm');

      const loader = new GLTFLoader();
      let gltf;
      try {
        gltf = await loader.loadAsync(modelUrl);
      } catch (e) {
        throw new Error(`Failed to load model.vrm: ${String(e?.message || e)}`);
      }

      avatarState.avatar = gltf.scene;
      avatarState.avatar.position.set(0, 0, 0);
      avatarState.scene.add(avatarState.avatar);
      avatarCacheBones(avatarState.avatar);

      label.textContent = 'Avatar ready';
      avatarState.ready = true;
      avatarState.error = null;

      requestAnimationFrame(avatarAnimate);
    })().catch((e) => {
      avatarState.error = String(e?.message || e);
      avatarState.ready = false;
      const mount = ensureAvatarMount();
      if (mount?.label) mount.label.textContent = 'Avatar load failed';
      setStatus(`Avatar error: ${avatarState.error}`);
    }).finally(() => {
      avatarState.loading = null;
    });

    return avatarState.loading;
  }

  function avatarPlayTokens(tokens) {
    void ensureAvatarReady();

    const mount = ensureAvatarMount();
    const label = mount?.label;

    const first = (tokens || []).find((x) => x && typeof x === 'string' && !x.startsWith('FS:'));
    if (!first) return;

    if (label) label.textContent = String(first);
    avatarState.gesture = { name: String(first).toUpperCase(), t0: performance.now() };
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
      avatarPlayTokens(tokens || []);
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

  // Avatar now runs in content script world; no window message bridge needed.

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
