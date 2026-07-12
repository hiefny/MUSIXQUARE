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
  #mode: 'disconnected' | 'stereo' | 'surround' = 'disconnected';
  #surroundPath: {
    splitter: ChannelSplitterNode;
    gain: GainNode;
    destination: AudioNode;
    channelIndex: number;
  } | null = null;
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

  mode(): 'disconnected' | 'stereo' | 'surround' {
    return this.#mode;
  }

  connectStereo(destination: AudioNode): void {
    this.#assertActive();
    this.#assertContext(destination);
    this.#connectInput('stereo', destination);
  }

  connectSurround(
    splitter: ChannelSplitterNode,
    gain: GainNode,
    destination: AudioNode,
    channelIndex: number,
  ): void {
    this.#assertActive();
    this.#assertContext(splitter);
    this.#assertContext(gain);
    this.#assertContext(destination);
    if (!Number.isInteger(channelIndex) || channelIndex < 0 || channelIndex > 7) {
      throw new RangeError('File playback surround channel must be an integer from 0 to 7');
    }

    const previous = this.#surroundPath;
    if (!previous || previous.gain !== gain || previous.destination !== destination) {
      if (previous && previous.gain !== gain) previous.gain.disconnect();
      gain.disconnect();
      gain.connect(destination);
    }

    if (
      !previous ||
      previous.splitter !== splitter ||
      previous.gain !== gain ||
      previous.channelIndex !== channelIndex
    ) {
      if (previous && previous.splitter !== splitter) previous.splitter.disconnect();
      splitter.disconnect();
      if (channelIndex === 6) {
        splitter.connect(gain, 6, 0);
        splitter.connect(gain, 4, 0);
      } else if (channelIndex === 7) {
        splitter.connect(gain, 7, 0);
        splitter.connect(gain, 5, 0);
      } else {
        splitter.connect(gain, channelIndex, 0);
      }
    }

    this.#surroundPath = { splitter, gain, destination, channelIndex };
    this.#connectInput('surround', splitter);
  }

  #connectInput(mode: 'stereo' | 'surround', destination: AudioNode): void {
    if (this.#destination === destination && this.#mode === mode) return;

    this.input.disconnect();
    this.input.connect(destination);
    this.#destination = destination;
    this.#mode = mode;
  }

  disconnect(): void {
    if (this.#destroyed) return;
    this.input.disconnect();
    this.#destination = null;
    this.#mode = 'disconnected';
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.input.disconnect();
    this.#surroundPath?.splitter.disconnect();
    this.#surroundPath?.gain.disconnect();
    this.#surroundPath = null;
    this.#destination = null;
    this.#mode = 'disconnected';
    this.#destroyed = true;
  }

  #assertContext(node: AudioNode): void {
    if (node.context !== this.#context) {
      throw new TypeError('File playback route destination belongs to another AudioContext');
    }
  }

  #assertActive(): void {
    if (this.#destroyed) throw new Error('File playback route has been destroyed');
  }
}
