let ws = null;
let mediaStream = null;
let audioCtx = null;
let processor = null;
let sessionEpochMs = null;
let seq = 0;

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function downsampleFloat32(input, inSampleRate, outSampleRate) {
  if (outSampleRate === inSampleRate) return input;
  const ratio = inSampleRate / outSampleRate;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i];
      count++;
    }
    result[offsetResult] = accum / count;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPCM(float32Array) {
  const output = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

async function connectWs(engineUrl) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(engineUrl);

  ws.onopen = () => {
    chrome.runtime.sendMessage({ type: 'ENGINE_STATUS', status: 'Engine connected' });
    ws.send(JSON.stringify({ type: 'session.start', epoch_ms: sessionEpochMs }));
  };

  ws.onclose = () => {
    chrome.runtime.sendMessage({ type: 'ENGINE_STATUS', status: 'Engine disconnected' });
  };

  ws.onerror = () => {
    chrome.runtime.sendMessage({ type: 'ENGINE_STATUS', status: 'Engine connection error' });
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg?.type === 'sign.tokens') {
        chrome.runtime.sendMessage({
          type: 'ENGINE_TOKENS',
          tokens: msg.tokens || [],
          start_ms: msg.start_ms,
          end_ms: msg.end_ms,
          conf: msg.conf,
        });
      }
      if (msg?.type === 'transcript.segment') {
        const text = msg.text || '';
        const suffix = msg.final ? '' : ' (partial)';
        chrome.runtime.sendMessage({ type: 'ENGINE_STATUS', status: `Heard: ${text}${suffix}` });
      }
      if (msg?.type === 'status') {
        chrome.runtime.sendMessage({ type: 'ENGINE_STATUS', status: msg.status || '' });
      }
    } catch {
      // ignore
    }
  };
}

async function start({ tabId, streamId, engineUrl }) {
  sessionEpochMs = Date.now();
  seq = 0;

  await connectWs(engineUrl);

  if (!streamId) throw new Error('Missing streamId');

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  if (!mediaStream) throw new Error('getUserMedia returned no stream');

  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(mediaStream);

  // ScriptProcessor is deprecated but works for MVP; AudioWorklet can come later.
  processor = audioCtx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const inBuf = e.inputBuffer.getChannelData(0);
    const ds = downsampleFloat32(inBuf, audioCtx.sampleRate, 16000);
    const pcm16 = floatTo16BitPCM(ds);

    const payload = {
      type: 'audio.frame',
      seq: seq++,
      epoch_ms: Date.now(),
      sample_rate: 16000,
      format: 'pcm_s16le',
      pcm16_b64: arrayBufferToBase64(pcm16.buffer),
    };

    ws.send(JSON.stringify(payload));
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);

  chrome.runtime.sendMessage({ type: 'ENGINE_STATUS', status: 'Capturing audio…' });
}

async function stop() {
  try {
    if (processor) processor.disconnect();
  } catch {}

  processor = null;

  try {
    if (audioCtx) await audioCtx.close();
  } catch {}
  audioCtx = null;

  try {
    mediaStream?.getTracks()?.forEach((t) => t.stop());
  } catch {}
  mediaStream = null;

  try {
    ws?.close();
  } catch {}
  ws = null;

  chrome.runtime.sendMessage({ type: 'ENGINE_STATUS', status: 'Stopped' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'OFFSCREEN_START') {
        await start(msg);
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'OFFSCREEN_STOP') {
        await stop();
        sendResponse({ ok: true });
        return;
      }
    } catch (e) {
      await stop();
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: String(e?.message || e) });
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});
