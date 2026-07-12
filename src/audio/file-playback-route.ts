/**
 * Stable input for every file-playback backend.
 *
 * Sources connect once to `input`; product routing may then switch between the
 * stereo effects input and the multichannel splitter without asking a decoder
 * to rebuild or reconnect its native output node.
 */
export class FilePlaybackRoute {
  readonly input: GainNode;

  readonly #context: AudioContext;
  #destination: AudioNode | null = null;
  #destroyed = false;

  constructor(context: AudioContext) {
    this.#context = context;
    this.input = context.createGain();
    this.input.gain.value = 1;
    this.input.channelCountMode = 'max';
    this.input.channelInterpretation = 'discrete';
  }

  destination(): AudioNode | null {
    return this.#destination;
  }

  connect(destination: AudioNode): void {
    this.#assertActive();
    if (destination.context !== this.#context) {
      throw new TypeError('File playback route destination belongs to another AudioContext');
    }
    if (this.#destination === destination) return;

    this.input.disconnect();
    this.input.connect(destination);
    this.#destination = destination;
  }

  disconnect(): void {
    if (this.#destroyed) return;
    this.input.disconnect();
    this.#destination = null;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.input.disconnect();
    this.#destination = null;
    this.#destroyed = true;
  }

  #assertActive(): void {
    if (this.#destroyed) throw new Error('File playback route has been destroyed');
  }
}
