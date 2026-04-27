class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs?.[0]?.[0];
    if (!input) return true;

    // Copy into a transferable buffer (Float32Array -> ArrayBuffer)
    const buf = new Float32Array(input.length);
    buf.set(input);
    this.port.postMessage({ type: 'audio', samples: buf.buffer }, [buf.buffer]);
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
