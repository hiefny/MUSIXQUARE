import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PcmChunk, PcmIterator } from '../bounded-playback.ts';
import { guardPcmChunkBoundaries } from '../pcm-chunk-guards.ts';

class TestAudioBuffer {
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  private readonly channels: Float32Array[];

  constructor(options: AudioBufferOptions) {
    this.length = options.length;
    this.sampleRate = options.sampleRate;
    this.numberOfChannels = options.numberOfChannels ?? 1;
    this.channels = Array.from(
      { length: this.numberOfChannels },
      () => new Float32Array(this.length),
    );
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }

  copyToChannel(data: Float32Array, channel: number, offset = 0): void {
    this.channels[channel].set(data, offset);
  }
}

function chunk(timestamp: number, channels: number[][], sampleRate = 48_000): PcmChunk {
  const buffer = new AudioBuffer({
    length: channels[0].length,
    numberOfChannels: channels.length,
    sampleRate,
  });
  channels.forEach((values, channel) => buffer.copyToChannel(Float32Array.from(values), channel));
  return { buffer, timestamp };
}

async function* chunks(values: PcmChunk[]): PcmIterator {
  yield* values;
}

beforeEach(() => vi.stubGlobal('AudioBuffer', TestAudioBuffer));
afterEach(() => vi.unstubAllGlobals());

describe('bounded PCM interpolation guards', () => {
  it('appends actual adjacent samples per channel without extending logical duration or mutating input', async () => {
    const originals = [
      chunk(0, [
        [1, 2, 3, 4],
        [10, 20, 30, 40],
      ]),
      chunk(4 / 48_000, [
        [5, 6, 7, 8],
        [50, 60, 70, 80],
      ]),
    ];
    const reader = guardPcmChunkBoundaries(chunks(originals));
    const first = (await reader.next()).value!;
    expect(first.timestamp).toBe(0);
    expect(first.duration).toBe(4 / 48_000);
    expect(first.buffer.duration).toBe(6 / 48_000);
    expect(Array.from(first.buffer.getChannelData(0))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(first.buffer.getChannelData(1))).toEqual([10, 20, 30, 40, 50, 60]);
    expect(Array.from(originals[0].buffer.getChannelData(0))).toEqual([1, 2, 3, 4]);
    const last = (await reader.next()).value!;
    expect(last.timestamp).toBe(4 / 48_000);
    expect(last.duration).toBe(4 / 48_000);
    expect(Array.from(last.buffer.getChannelData(0))).toEqual([5, 6, 7, 8, 0, 0]);
    expect((await reader.next()).done).toBe(true);
  });

  it('uses at most two one-sample neighbors and preserves every small chunk', async () => {
    let reads = 0;
    const raw = (async function* (): PcmIterator {
      for (let frame = 0; frame < 100; frame++) {
        reads++;
        yield chunk(frame / 48_000, [[frame + 1]]);
      }
    })();
    const reader = guardPcmChunkBoundaries(raw);
    const first = (await reader.next()).value!;
    expect(reads).toBe(3);
    expect(Array.from(first.buffer.getChannelData(0))).toEqual([1, 2, 3]);
    const second = (await reader.next()).value!;
    expect(reads).toBe(4);
    expect(Array.from(second.buffer.getChannelData(0))).toEqual([2, 3, 4]);
    expect(second.timestamp).toBe(1 / 48_000);
    await reader.return();
    expect(reads).toBe(4);
  });

  it.each([
    { audibleEnd: 3 / 48_000, guards: [5, 0] },
    { audibleEnd: 4 / 48_000, guards: [5, 6] },
  ])(
    'keeps the required interpolation neighbors but stops delivering PCM beyond audible end $audibleEnd',
    async ({ audibleEnd, guards }) => {
      const closed = vi.fn();
      let reads = 0;
      const raw = (async function* (): PcmIterator {
        try {
          reads++;
          yield chunk(0, [[1, 2, 3, 4]]);
          reads++;
          yield chunk(4 / 48_000, [[5, 6, 7, 8]]);
          reads++;
          throw new Error('unneeded encoded tail must not be decoded');
        } finally {
          closed();
        }
      })();
      const reader = guardPcmChunkBoundaries(raw, audibleEnd);
      try {
        const first = (await reader.next()).value!;
        expect(Array.from(first.buffer.getChannelData(0))).toEqual([1, 2, 3, 4, ...guards]);
        expect(first.duration).toBe(4 / 48_000);
        expect((await reader.next()).done).toBe(true);
        expect(reads).toBe(2);
        expect(closed).toHaveBeenCalledOnce();
      } finally {
        await reader.return();
      }
    },
  );

  it.each(
    [44_100, 48_000, 96_000].flatMap((sampleRate) =>
      [3, 3.25].map((endFrame) => ({ sampleRate, endFrame })),
    ),
  )(
    'reads only the needed one-sample neighbors for end frame $endFrame at $sampleRate Hz',
    async ({ sampleRate, endFrame }) => {
      const timestamp = 1_234.567;
      const expectedReads = endFrame === 3 ? 2 : 3;
      let reads = 0;
      const raw = (async function* (): PcmIterator {
        reads++;
        yield chunk(timestamp, [[1, 2, 3, 4]], sampleRate);
        reads++;
        yield chunk(timestamp + 4 / sampleRate, [[5]], sampleRate);
        if (expectedReads === 3) {
          reads++;
          yield chunk(timestamp + 5 / sampleRate, [[6]], sampleRate);
        }
        reads++;
        throw new Error('read beyond the required interpolation neighbors');
      })();
      const reader = guardPcmChunkBoundaries(raw, timestamp + endFrame / sampleRate);
      try {
        const first = (await reader.next()).value!;
        expect(Array.from(first.buffer.getChannelData(0))).toEqual(
          endFrame === 3 ? [1, 2, 3, 4, 5, 0] : [1, 2, 3, 4, 5, 6],
        );
        expect((await reader.next()).done).toBe(true);
        expect(reads).toBe(expectedReads);
      } finally {
        await reader.return();
      }
    },
  );

  it('does not read another chunk when the current PCM already contains the end and interpolation guards', async () => {
    let reads = 0;
    const raw = (async function* (): PcmIterator {
      reads++;
      yield chunk(0, [[1, 2, 3, 4]]);
      reads++;
      throw new Error('the next chunk is outside the required audible and guard samples');
    })();
    const reader = guardPcmChunkBoundaries(raw, 2 / 48_000);
    try {
      const first = (await reader.next()).value!;
      expect(Array.from(first.buffer.getChannelData(0))).toEqual([1, 2, 3, 4, 0, 0]);
      expect(first.duration).toBe(4 / 48_000);
      expect((await reader.next()).done).toBe(true);
      expect(reads).toBe(1);
    } finally {
      await reader.return();
    }
  });

  it.each(['gap', 'rate', 'channels'] as const)(
    'does not interpolate across a %s discontinuity',
    async (kind) => {
      const next =
        kind === 'rate'
          ? chunk(4 / 48_000, [[5, 6, 7, 8]], 44_100)
          : kind === 'channels'
            ? chunk(4 / 48_000, [
                [5, 6, 7, 8],
                [50, 60, 70, 80],
              ])
            : chunk(1, [[5, 6, 7, 8]]);
      const reader = guardPcmChunkBoundaries(chunks([chunk(0, [[1, 2, 3, 4]]), next]));
      const first = (await reader.next()).value!;
      expect(Array.from(first.buffer.getChannelData(0))).toEqual([1, 2, 3, 4, 0, 0]);
      const second = (await reader.next()).value!;
      expect(second.timestamp).toBe(next.timestamp);
      expect(Array.from(second.buffer.getChannelData(0))).toEqual([5, 6, 7, 8, 0, 0]);
      await reader.return();
    },
  );

  it.each([-0.0000004, 0.0000004])(
    'shares the adjacent boundary after %s seconds of packet rounding without shifting timestamps',
    async (rounding) => {
      const exactNext = 4 / 48_000;
      const nextTimestamp = exactNext + rounding;
      const reader = guardPcmChunkBoundaries(
        chunks([chunk(0, [[1, 2, 3, 4]]), chunk(nextTimestamp, [[5, 6, 7, 8]])]),
      );
      const first = (await reader.next()).value!;
      const second = (await reader.next()).value!;
      expect(Array.from(first.buffer.getChannelData(0))).toEqual([1, 2, 3, 4, 5, 6]);
      expect(first.timestamp).toBe(0);
      expect(first.timestamp + first.duration!).toBe(nextTimestamp);
      expect(second.timestamp).toBe(nextTimestamp);
      expect(second.duration).toBe(exactNext);
      // Absolute start/stop deadlines must round to the same output frame,
      // including a render phase where the original ends straddle a boundary.
      for (const phase of [0, 0.0000004]) {
        const endFrame = Math.ceil((phase + first.timestamp + first.duration!) * 48_000);
        const nextFrame = Math.ceil((phase + second.timestamp) * 48_000);
        expect(endFrame).toBe(nextFrame);
      }
      await reader.return();
    },
  );

  it('closes the upstream iterator and releases lookahead when the consumer cancels', async () => {
    const closed = vi.fn();
    let reads = 0;
    const raw = (async function* (): PcmIterator {
      try {
        for (let frame = 0; frame < 100; frame += 4) {
          reads++;
          yield chunk(frame / 48_000, [[1, 2, 3, 4]]);
        }
      } finally {
        closed();
      }
    })();
    const reader = guardPcmChunkBoundaries(raw);
    await reader.next();
    expect(reads).toBe(2);
    await reader.return();
    await reader.return();
    expect(closed).toHaveBeenCalledOnce();
    expect(reads).toBe(2);
    expect((await reader.next()).done).toBe(true);
  });

  it('releases upstream after a lookahead decode failure instead of yielding fake guard audio', async () => {
    const closed = vi.fn();
    const raw = (async function* (): PcmIterator {
      try {
        yield chunk(0, [[1, 2, 3, 4]]);
        throw new Error('next frame corrupted');
      } finally {
        closed();
      }
    })();
    const reader = guardPcmChunkBoundaries(raw);
    await expect(reader.next()).rejects.toThrow('next frame corrupted');
    expect(closed).toHaveBeenCalledOnce();
    expect((await reader.next()).done).toBe(true);
  });
});
