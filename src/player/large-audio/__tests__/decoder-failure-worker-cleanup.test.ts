import { readFile } from 'node:fs/promises';
import NodeWorker from '@eshaz/web-worker';
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLargeAudioTrack } from '../index.ts';
import type { LargeAudioTrack } from '../../file-playback-resource.ts';

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

// PCM storage is the only unavailable Web Audio primitive in this Node test.
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

async function aacFixture(corrupt: boolean): Promise<Blob> {
  const bytes = await readFile('e2e/fixtures/large-audio-chirp-lc-stereo.m4a');
  if (corrupt) {
    let corrupted = false;
    for (let offset = 0; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      if (size < 8) break;
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'mdat') {
        // Preserve the valid container and sample table; only encoded audio is
        // corrupt. FAAD's actual worker resolves its normal errors[] response.
        bytes.fill(0xff, offset + 8, offset + size);
        corrupted = true;
        break;
      }
      offset += size;
    }
    expect(corrupted).toBe(true);
  }
  return new Blob([new Uint8Array(bytes)]);
}

async function flacFixture(corrupt: boolean): Promise<Blob> {
  const bytes = await readFile('e2e/fixtures/large-audio-chirp.flac');
  if (corrupt) {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(new Blob([new Uint8Array(bytes)])),
    });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) throw new Error('FLAC fixture has no audio track');
      const packet = await new EncodedPacketSink(track).getFirstPacket();
      if (!packet) throw new Error('FLAC fixture has no first packet');
      const offset = bytes.indexOf(packet.data);
      expect(offset).toBeGreaterThanOrEqual(0);
      // Keep the demuxable frame header and metadata, but damage actual coded
      // samples so libFLAC itself reports a lost-sync error in its worker.
      bytes.fill(0xff, offset + 10, offset + packet.data.length);
    } finally {
      input.dispose();
    }
  }
  return new Blob([new Uint8Array(bytes)]);
}

async function expectWorkersRetired(): Promise<void> {
  expect(workers.length).toBeGreaterThan(0);
  await vi.waitFor(() => expect(workers.every((worker) => worker.terminated)).toBe(true), {
    timeout: 3_000,
  });
}

describe('real decoder worker retirement through Mediabunny', () => {
  it('retires valid AAC probe and prepared-reader workers after disposal', async () => {
    let track: LargeAudioTrack | undefined;
    try {
      track = await openLargeAudioTrack(await aacFixture(false));
      await track.prepare(0);
    } finally {
      track?.dispose();
    }
    await expectWorkersRetired();
  });

  it('retires a worker after real corrupt AAC data rejects opening', async () => {
    await expect(openLargeAudioTrack(await aacFixture(true))).rejects.toThrow(
      'Invalid number of channels',
    );
    await expectWorkersRetired();
  });

  it('retires a valid FLAC prepared-reader worker after disposal', async () => {
    let track: LargeAudioTrack | undefined;
    try {
      track = await openLargeAudioTrack(await flacFixture(false));
      await track.prepare(0);
    } finally {
      track?.dispose();
    }
    await expectWorkersRetired();
  });

  it('retires a worker after real corrupt FLAC data rejects preparation', async () => {
    const track = await openLargeAudioTrack(await flacFixture(true));
    try {
      await expect(track.prepare(0)).rejects.toThrow('FLAC__STREAM_DECODER_ERROR_STATUS_LOST_SYNC');
    } finally {
      track.dispose();
    }
    await expectWorkersRetired();
  });
});
