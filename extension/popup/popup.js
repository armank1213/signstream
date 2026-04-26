const engineUrlEl = document.getElementById('engineUrl');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');

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

  engineUrlEl.value = state.engineUrl || 'ws://127.0.0.1:8765';

  if (state.lastError) setStatus(`Error: ${state.lastError}`, true);
  else if (state.capturing) setStatus('Capturing + streaming…');
  else setStatus('Idle');
}

startBtn.addEventListener('click', async () => {
  setStatus('Starting…');
  await runtimeSendMessage({
    type: 'POPUP_START',
    engineUrl: engineUrlEl.value.trim(),
  });
  await refresh();
});

stopBtn.addEventListener('click', async () => {
  setStatus('Stopping…');
  await runtimeSendMessage({ type: 'POPUP_STOP' });
  await refresh();
});

refresh();
