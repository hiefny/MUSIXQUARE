/**
 * AudioWorklet Processor — PCM Playback (Guest)
 *
 * Runs on the audio thread. Reads from a ring buffer fed by
 * main thread via MessagePort, outputs stereo audio.
 */

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  private _ringL: Float32Array;
  private _ringR: Float32Array;
  private _ringSize: number;
  private _writePos = 0;
  private _readPos = 0;
  private _active = true;

  constructor() {
    super();
    // 150ms ring buffer at 48kHz (~7200 samples)
    this._ringSize = Math.ceil(48000 * 0.15);
    this._ringL = new Float32Array(this._ringSize);
    this._ringR = new Float32Array(this._ringSize);

    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'stop') {
        this._active = false;
        return;
      }

      if (e.data instanceof ArrayBuffer) {
        const int16 = new Int16Array(e.data);
        const samples = int16.length / 2;

        for (let i = 0; i < samples; i++) {
          this._ringL[this._writePos] = int16[i * 2] / 32767;
          this._ringR[this._writePos] = int16[i * 2 + 1] / 32767;
          this._writePos = (this._writePos + 1) % this._ringSize;
        }
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this._active) return false;

    const output = outputs[0];
    if (!output || output.length < 2) return true;

    const outL = output[0];
    const outR = output[1];

    for (let i = 0; i < outL.length; i++) {
      if (this._readPos !== this._writePos) {
        outL[i] = this._ringL[this._readPos];
        outR[i] = this._ringR[this._readPos];
        this._readPos = (this._readPos + 1) % this._ringSize;
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-playback-processor', PcmPlaybackProcessor);
