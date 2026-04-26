(function () {
  const isYouTubeWatch = () => location.hostname === 'www.youtube.com' && location.pathname === '/watch';

  function ensureOverlay() {
    let root = document.getElementById('signstream-overlay-root');
    if (root) return root;

    root = document.createElement('div');
    root.id = 'signstream-overlay-root';
    root.style.position = 'fixed';
    root.style.right = '16px';
    root.style.bottom = '16px';
    root.style.zIndex = '2147483647';
    root.style.pointerEvents = 'none';
    root.style.maxWidth = '40vw';
    root.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';

    const panel = document.createElement('div');
    panel.id = 'signstream-overlay-panel';
    panel.style.background = 'rgba(0,0,0,0.65)';
    panel.style.color = 'white';
    panel.style.padding = '10px 12px';
    panel.style.borderRadius = '10px';
    panel.style.backdropFilter = 'blur(6px)';
    panel.style.border = '1px solid rgba(255,255,255,0.15)';

    const title = document.createElement('div');
    title.textContent = 'SignStream';
    title.style.fontSize = '12px';
    title.style.opacity = '0.8';
    title.style.marginBottom = '6px';

    const chips = document.createElement('div');
    chips.id = 'signstream-chips';
    chips.style.display = 'flex';
    chips.style.flexWrap = 'wrap';
    chips.style.gap = '6px';

    const status = document.createElement('div');
    status.id = 'signstream-status';
    status.style.marginTop = '8px';
    status.style.fontSize = '12px';
    status.style.opacity = '0.8';
    status.textContent = 'Waiting…';

    panel.appendChild(title);
    panel.appendChild(chips);
    panel.appendChild(status);
    root.appendChild(panel);
    document.documentElement.appendChild(root);
    return root;
  }

  function renderTokens(tokens) {
    const root = ensureOverlay();
    const chips = root.querySelector('#signstream-chips');
    const status = root.querySelector('#signstream-status');
    if (!chips || !status) return;

    chips.textContent = '';
    (tokens || []).slice(0, 12).forEach((t) => {
      const chip = document.createElement('span');
      chip.textContent = t;
      chip.style.display = 'inline-block';
      chip.style.padding = '4px 8px';
      chip.style.borderRadius = '999px';
      chip.style.background = 'rgba(255,255,255,0.14)';
      chip.style.border = '1px solid rgba(255,255,255,0.18)';
      chip.style.fontSize = '13px';
      chip.style.letterSpacing = '0.3px';
      chips.appendChild(chip);
    });

    status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  function setStatus(text) {
    const root = ensureOverlay();
    const status = root.querySelector('#signstream-status');
    if (status) status.textContent = text;
  }

  // Always register listeners even if we weren't on /watch when the script first ran.
  // YouTube is SPA-like; the user may navigate to /watch without a full page reload.

  if (isYouTubeWatch()) ensureOverlay();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ENGINE_TOKENS') {
      if (!isYouTubeWatch()) return;
      renderTokens(msg.tokens);
    }
    if (msg?.type === 'ENGINE_STATUS') {
      if (!isYouTubeWatch()) return;
      setStatus(msg.status || '');
    }
  });

  const obs = new MutationObserver(() => {
    if (isYouTubeWatch()) ensureOverlay();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
