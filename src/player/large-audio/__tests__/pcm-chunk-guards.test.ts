import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { BoundedPlayback, type PcmChunk, type PcmIterator } from '../bounded-playback.ts';
import { BoundedAudioTrack, PRIME_SECONDS } from '../bounded-track.ts';
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

// At 48 Hz a merged quarter second is 12 frames and half a second is 24.
const RATE = 48;

/** Contiguous chunks whose samples count frames from one, negated on a second channel. */
function counted(sizes: number[], numberOfChannels = 1): PcmChunk[] {
  let frame = 0;
  return sizes.map((size) => {
    const values = Array.from({ length: size }, (_, index) => frame + index + 1);
    const channels = [values, values.map((value) => -value)].slice(0, numberOfChannels);
    const value = chunk(frame / RATE, channels, RATE);
    frame += size;
    return value;
  });
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function samples(value: PcmChunk, channel = 0): number[] {
  return Array.from(value.buffer.getChannelData(channel));
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

describe('merged bounded PCM', () => {
  it('joins contiguous chunks from mergeFrom into quarter-second buffers guarded by the next chunk', async () => {
    const originals = counted([4, 4, 4, 4, 4, 4, 4], 2);
    let reads = 0;
    const raw = (async function* (): PcmIterator {
      for (const value of originals) {
        reads++;
        yield value;
      }
    })();
    const reader = guardPcmChunkBoundaries(raw, Infinity, 0);
    const first = (await reader.next()).value!;
    // Three joined chunks, then the next one only for its first two samples.
    expect(reads).toBe(4);
    expect(first.timestamp).toBe(0);
    expect(first.duration).toBe(originals[3].timestamp);
    expect(first.buffer.duration).toBe(14 / RATE);
    expect(samples(first)).toEqual(range(1, 14));
    expect(samples(first, 1)).toEqual(range(1, 14).map((value) => -value));
    const second = (await reader.next()).value!;
    expect(second.timestamp).toBe(originals[3].timestamp);
    expect(second.duration).toBe(originals[6].timestamp - originals[3].timestamp);
    expect(samples(second)).toEqual(range(13, 26));
    // End of stream flushes the remainder without waiting for a full buffer.
    const last = (await reader.next()).value!;
    expect(last.timestamp).toBe(originals[6].timestamp);
    expect(last.duration).toBe(4 / RATE);
    expect(samples(last)).toEqual([25, 26, 27, 28, 0, 0]);
    expect((await reader.next()).done).toBe(true);
    expect(samples(originals[0])).toEqual([1, 2, 3, 4]);
  });

  it('yields and reads chunks before mergeFrom exactly as an unmerged reader does', async () => {
    const originals = counted(Array.from({ length: 10 }, () => 4));
    const read = async (mergeFrom: number) => {
      let reads = 0;
      const raw = (async function* (): PcmIterator {
        for (const value of originals) {
          reads++;
          yield value;
        }
      })();
      const yields: Array<{
        reads: number;
        timestamp: number;
        duration?: number;
        samples: number[];
      }> = [];
      for await (const value of guardPcmChunkBoundaries(raw, Infinity, mergeFrom)) {
        const { timestamp, duration } = value;
        yields.push({ reads, timestamp, duration, samples: samples(value) });
      }
      return yields;
    };
    const unmerged = await read(Infinity);
    const merged = await read(originals[2].timestamp);
    expect(merged.slice(0, 2)).toEqual(unmerged.slice(0, 2));
    expect(merged.slice(2).map((value) => value.samples)).toEqual([
      range(9, 22),
      range(21, 34),
      [...range(33, 40), 0, 0],
    ]);
  });

  it.each(['gap', 'rate', 'channels'] as const)(
    'ends a merged buffer at a %s without guard samples across it',
    async (kind) => {
      const next =
        kind === 'rate'
          ? chunk(8 / RATE, [[9, 10, 11, 12]], 44)
          : kind === 'channels'
            ? chunk(
                8 / RATE,
                [
                  [9, 10, 11, 12],
                  [9, 10, 11, 12],
                ],
                RATE,
              )
            : chunk(1, [[9, 10, 11, 12]], RATE);
      const reader = guardPcmChunkBoundaries(chunks([...counted([4, 4]), next]), Infinity, 0);
      const first = (await reader.next()).value!;
      expect(first.timestamp).toBe(0);
      expect(first.duration).toBe(8 / RATE);
      expect(samples(first)).toEqual([...range(1, 8), 0, 0]);
      const second = (await reader.next()).value!;
      expect(second.timestamp).toBe(next.timestamp);
      expect(second.buffer.sampleRate).toBe(next.buffer.sampleRate);
      expect(second.buffer.numberOfChannels).toBe(next.buffer.numberOfChannels);
      expect(samples(second)).toEqual([9, 10, 11, 12, 0, 0]);
      expect((await reader.next()).done).toBe(true);
    },
  );

  it('does not let tolerated timestamp rounding accumulate inside a merged buffer', async () => {
    // Every boundary is 0.9 microseconds late: tolerable against the previous
    // chunk, but the second late chunk is 1.8 microseconds from the joined end.
    const originals = counted([4, 4, 4, 4]).map((value, index) => ({
      ...value,
      timestamp: value.timestamp + index * 0.0000009,
    }));
    const reader = guardPcmChunkBoundaries(chunks(originals), Infinity, 0);
    const first = (await reader.next()).value!;
    expect(samples(first)).toEqual(range(1, 10));
    expect(first.timestamp + first.duration!).toBe(originals[2].timestamp);
    const second = (await reader.next()).value!;
    expect(second.timestamp).toBe(originals[2].timestamp);
    expect(samples(second)).toEqual([...range(9, 16), 0, 0]);
    expect((await reader.next()).done).toBe(true);
  });

  it('caps merged buffers at half a second and at 1 MiB of PCM', async () => {
    const [short, long] = counted([4, 22]);
    const reader = guardPcmChunkBoundaries(chunks([short, long]), Infinity, 0);
    const first = (await reader.next()).value!;
    expect(samples(first)).toEqual(range(1, 6));
    expect(first.duration).toBe(long.timestamp);
    const second = (await reader.next()).value!;
    expect(second.timestamp).toBe(long.timestamp);
    expect(samples(second)).toEqual([...range(5, 26), 0, 0]);
    expect((await reader.next()).done).toBe(true);
    // 32 channels of float PCM reach 1 MiB at 8192 frames, before a quarter second.
    const surround = Array.from({ length: 6 }, (_, index) => ({
      timestamp: (index * 2048) / 48_000,
      buffer: new AudioBuffer({ length: 2048, numberOfChannels: 32, sampleRate: 48_000 }),
    }));
    const wide = guardPcmChunkBoundaries(chunks(surround), Infinity, 0);
    expect((await wide.next()).value!.buffer.length).toBe(4 * 2048 + 2);
    expect((await wide.next()).value!.buffer.length).toBe(2 * 2048 + 2);
    expect((await wide.next()).done).toBe(true);
  });

  it.each([
    { end: 6, expectedReads: 2, tail: [0, 0] },
    { end: 7, expectedReads: 3, tail: [9, 0] },
    { end: 8, expectedReads: 3, tail: [9, 10] },
  ])(
    'flushes the buffer reaching audible frame $end without decoding past its guards',
    async ({ end, expectedReads, tail }) => {
      let reads = 0;
      const raw = (async function* (): PcmIterator {
        for (const value of counted([4, 4, 4])) {
          reads++;
          yield value;
        }
        reads++;
        throw new Error('unneeded encoded tail must not be decoded');
      })();
      const reader = guardPcmChunkBoundaries(raw, end / RATE, 0);
      try {
        const last = (await reader.next()).value!;
        expect(samples(last)).toEqual([...range(1, 8), ...tail]);
        expect(last.duration).toBe(8 / RATE);
        expect((await reader.next()).done).toBe(true);
        expect(reads).toBe(expectedReads);
      } finally {
        await reader.return();
      }
    },
  );

  describe('scheduling', () => {
    afterEach(() => {
      clearAllManagedTimers();
      vi.useRealTimers();
    });

    it.each([
      { now: 0, startsAt: 2, sourceOffset: 0.05 },
      { now: 2.1, startsAt: 2.1, sourceOffset: 0.15 },
    ])(
      'starts inside a merged buffer at $now on the original timeline and completes on time',
      async ({ now, startsAt, sourceOffset }) => {
        vi.useFakeTimers();
        const sources: Array<{
          buffer: AudioBuffer | null;
          onended: (() => void) | null;
          start: ReturnType<typeof vi.fn>;
          stop: ReturnType<typeof vi.fn>;
        }> = [];
        const context = {
          currentTime: now,
          createBufferSource: () => {
            const source = {
              buffer: null,
              onended: null,
              start: vi.fn(),
              stop: vi.fn(),
              connect: vi.fn(),
              disconnect: vi.fn(),
            };
            sources.push(source);
            return source;
          },
        };
        const onended = vi.fn();
        const playback = new BoundedPlayback({
          context: context as unknown as AudioContext,
          destination: {} as AudioNode,
          when: 2,
          offset: 0.3,
          duration: 1,
          iterator: guardPcmChunkBoundaries(
            chunks(counted(Array.from({ length: 12 }, () => 4))),
            1,
            0,
          ),
          firstChunk: null,
          onended,
          onerror: vi.fn(),
          onreleased: vi.fn(),
        });
        try {
          await vi.advanceTimersByTimeAsync(1);
          // The first quarter second ends before the offset and is never scheduled.
          expect(sources.map((source) => source.buffer!.length)).toEqual([14, 14, 14]);
          const [at, offset] = sources[0].start.mock.calls[0] as [number, number];
          expect(at).toBeCloseTo(startsAt, 12);
          expect(offset).toBeCloseTo(sourceOffset, 12);
          // Each merged source stops at the sample-clock time the next one starts.
          expect(sources[1].start).toHaveBeenCalledWith(sources[0].stop.mock.calls[0][0], 0);
          expect(sources[2].start).toHaveBeenCalledWith(sources[1].stop.mock.calls[0][0], 0);
          expect(sources[0].stop.mock.calls[0][0]).toBeCloseTo(2.2, 12);
          expect(sources[2].stop).toHaveBeenCalledWith(2 + 1 - 0.3);
          context.currentTime = 2 + 1 - 0.3;
          for (const source of sources) source.onended?.();
          await vi.advanceTimersByTimeAsync(100);
          expect(onended).toHaveBeenCalledOnce();
          expect(playback.ended).toBe(true);
        } finally {
          playback.stop();
        }
      },
    );

    it('prepares from the same codec frames and schedules far fewer sources across the lookahead', async () => {
      vi.useFakeTimers();
      const frame = 1152 / 48_000;
      const play = async (merge: boolean) => {
        let reads = 0;
        const track = new BoundedAudioTrack(
          600,
          48_000,
          2,
          (position) => {
            const raw = (async function* (): PcmIterator {
              // MP3 decodes half a second of seek preroll before the position.
              for (let index = Math.floor((position - 0.5) / frame); ; index++) {
                reads++;
                yield {
                  timestamp: index * frame,
                  buffer: new AudioBuffer({
                    length: 1152,
                    numberOfChannels: 2,
                    sampleRate: 48_000,
                  }),
                };
              }
            })();
            return guardPcmChunkBoundaries(raw, 600, merge ? position + PRIME_SECONDS : Infinity);
          },
          vi.fn(),
        );
        const scheduled: AudioBuffer[] = [];
        try {
          await track.prepare(100);
          const prepareReads = reads;
          const playback = track.createPlayback({
            context: {
              currentTime: 0,
              createBufferSource() {
                const source = {
                  buffer: null as AudioBuffer | null,
                  connect() {},
                  disconnect() {},
                  stop() {},
                  start() {
                    scheduled.push(source.buffer!);
                  },
                };
                return source;
              },
            } as unknown as AudioContext,
            destination: {} as AudioNode,
            when: 0,
            offset: 100,
            onended: vi.fn(),
            onerror: vi.fn(),
          });
          await vi.advanceTimersByTimeAsync(100);
          playback.stop();
          return { prepareReads, lengths: scheduled.map((buffer) => buffer.length) };
        } finally {
          track.dispose();
        }
      };
      const unmerged = await play(false);
      const merged = await play(true);
      expect(merged.prepareReads).toBe(unmerged.prepareReads);
      // 43 primed codec frames, then sources through the eight-second horizon:
      // 292 more frames unmerged, or 27 merged runs of 11 frames (0.264 s).
      expect(unmerged.lengths).toEqual(Array.from({ length: 335 }, () => 1154));
      expect(merged.lengths).toEqual([
        ...unmerged.lengths.slice(0, 43),
        ...Array.from({ length: 27 }, () => 11 * 1152 + 2),
      ]);
    });
  });
});
