/**
 * AudioWorklet Processor — PCM Capture (Host)
 *
 * Runs on the audio thread. Captures 128-sample stereo frames,
 * converts to interleaved Int16, posts to main thread via MessagePort.
 */

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private _active = true;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'stop') this._active = false;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this._active) return false;

    const input = inputs[0];
    if (!input || input.length < 1) return true;

    const left = input[0];
    const right = input.length > 1 ? input[1] : left; // mono fallback
    const len = left.length; // 128 samples (render quantum)

    // Float32 stereo → interleaved Int16
    const interleaved = new Int16Array(len * 2);
    for (let i = 0; i < len; i++) {
      interleaved[i * 2] = Math.max(-32768, Math.min(32767, (left[i] * 32767) | 0));
      interleaved[i * 2 + 1] = Math.max(-32768, Math.min(32767, (right[i] * 32767) | 0));
    }

    // Transfer buffer to main thread (zero-copy)
    this.port.postMessage(interleaved.buffer, [interleaved.buffer]);

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
