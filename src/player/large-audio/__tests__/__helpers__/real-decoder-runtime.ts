import NodeWorker from '@eshaz/web-worker';
import { afterEach, beforeEach, vi } from 'vitest';

const workers: ObservedWorker[] = [];

class ObservedWorker extends NodeWorker {
  terminated = false;

  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    workers.push(this);
  }

  override terminate(): void {
    this.terminated = true;
    super.terminate();
  }
}

// PCM storage is the only unavailable Web Audio primitive in these Node tests.
// Demuxing, codec initialization, WASM workers, and decoder ownership are real.
class PcmBuffer {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(options: AudioBufferOptions) {
    this.length = options.length;
    this.numberOfChannels = options.numberOfChannels ?? 1;
    this.sampleRate = options.sampleRate;
    this.duration = options.length / options.sampleRate;
    this.channels = Array.from(
      { length: this.numberOfChannels },
      () => new Float32Array(this.length),
    );
  }

  copyToChannel(source: Float32Array, channel: number, offset = 0): void {
    this.channels[channel].set(source, offset);
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

/**
 * Run every test in the calling file with real decoder workers (Node worker
 * threads) and PCM buffer storage. Returns the workers the current test started.
 */
export function useRealDecoderRuntime(): readonly ObservedWorker[] {
  beforeEach(() => {
    workers.length = 0;
    vi.stubGlobal('Worker', ObservedWorker);
    vi.stubGlobal('AudioBuffer', PcmBuffer);
  });

  afterEach(() => {
    // Failed baseline assertions must not leave native threads alive in Vitest.
    for (const worker of workers) if (!worker.terminated) worker.terminate();
    vi.unstubAllGlobals();
  });

  return workers;
}
