import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { BoundedAudioTrack } from '../bounded-track.ts';
import type { PcmChunk, PcmIterator } from '../bounded-playback.ts';
import { getLargeAudioDiagnostics } from '../diagnostics.ts';

const makeChunk = (timestamp: number): PcmChunk => ({
  timestamp,
  buffer: {
    duration: 0.25,
    length: 12_000,
    numberOfChannels: 2,
    sampleRate: 48_000,
  } as AudioBuffer,
});

async function flushReads(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(async () => {
  await flushReads();
  clearAllManagedTimers();
  const { resources } = getLargeAudioDiagnostics();
  expect(resources.tracks.live).toBe(0);
  expect(resources.readers.live).toBe(0);
});

describe('bounded track ownership', () => {
  it('primes a bounded second and cancels an obsolete seek without disposing the track', async () => {
    const closed: number[] = [];
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const disposeInput = vi.fn();
    const track = new BoundedAudioTrack(
      600,
      48_000,
      2,
      async function* (position) {
        try {
          if (position === 0) await firstRead;
          for (let time = position; time < position + 5; time += 0.25) yield makeChunk(time);
        } finally {
          closed.push(position);
        }
      },
      disposeInput,
    );
    const first = track.prepare(0);
    const firstOutcome = first.catch((error: unknown) => error);
    await flushReads();
    const latest = track.prepare(90);
    // Cancellation must settle even while the obsolete decoder is still busy.
    expect(((await firstOutcome) as Error).name).toBe('AbortError');
    releaseFirst();
    await latest;
    expect(track.bufferedPcmBytes).toBe(48_000 * 2 * 4);
    expect(disposeInput).not.toHaveBeenCalled();
    expect(closed).toContain(0);
    track.dispose();
    await flushReads();
    expect(track.bufferedPcmBytes).toBe(0);
    expect(disposeInput).toHaveBeenCalledOnce();
    expect(closed).toContain(90);
  });

  it('fences an aborted preparation and closes its decoder', async () => {
    const closed = vi.fn();
    const track = new BoundedAudioTrack(
      10,
      48_000,
      2,
      async function* () {
        try {
          for (let time = 0; time < 10; time += 0.25) yield makeChunk(time);
        } finally {
          closed();
        }
      },
      vi.fn(),
    );
    const abort = new AbortController();
    await track.prepare(0, abort.signal);
    abort.abort();
    await flushReads();
    expect(closed).toHaveBeenCalledOnce();
    expect(track.bufferedPcmBytes).toBe(0);
    await expect(track.prepare(0, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    track.dispose();
  });

  it('hands a completed prime to a new owner without decoding twice', async () => {
    const open = vi.fn(async function* () {
      for (let time = 0; time < 10; time += 0.25) yield makeChunk(time);
    });
    const track = new BoundedAudioTrack(10, 48_000, 2, open, vi.fn());
    const oldOwner = new AbortController();
    const newOwner = new AbortController();
    await track.prepare(0, oldOwner.signal);
    await track.prepare(0, newOwner.signal);
    oldOwner.abort();
    expect(open).toHaveBeenCalledOnce();
    expect(track.bufferedPcmBytes).toBe(384_000);
    newOwner.abort();
    expect(track.bufferedPcmBytes).toBe(0);
    track.dispose();
  });

  it('coalesces hundreds of seeks behind one retiring decoder and keeps only the final intent', async () => {
    const opened: number[] = [];
    const closed: number[] = [];
    let liveReaders = 0;
    let peakReaders = 0;
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const track = new BoundedAudioTrack(
      1_000,
      48_000,
      2,
      (position) => {
        opened.push(position);
        peakReaders = Math.max(peakReaders, ++liveReaders);
        const iterator = (async function* () {
          try {
            if (position === 0) await firstRead;
            for (let time = position; time < position + 5; time += 0.25) yield makeChunk(time);
          } finally {
            closed.push(position);
            liveReaders--;
          }
        })();
        return iterator;
      },
      vi.fn(),
    );
    const first = track.prepare(0).catch((error: unknown) => error);
    await flushReads();
    const obsolete: Promise<unknown>[] = [];
    for (let position = 1; position <= 200; position++) {
      obsolete.push(track.prepare(position).catch((error: unknown) => error));
      await flushReads();
    }
    const last = track.prepare(777);
    await flushReads();
    expect(opened).toEqual([0]);
    expect(peakReaders).toBe(1);
    expect(getLargeAudioDiagnostics().resources.readers.live).toBe(1);
    expect(((await first) as Error).name).toBe('AbortError');
    expect(await Promise.all(obsolete)).toEqual(
      Array.from({ length: 200 }, () => expect.objectContaining({ name: 'AbortError' })),
    );
    releaseFirst();
    await last;
    expect(opened).toEqual([0, 777]);
    expect(closed).toEqual([0]);
    expect(peakReaders).toBe(1);
    expect(track.bufferedPcmBytes).toBe(384_000);
    track.dispose();
    await flushReads();
    expect(closed).toEqual([0, 777]);
    expect(liveReaders).toBe(0);
    expect(track.bufferedPcmBytes).toBe(0);
  });

  it('disposes the input immediately while a cancelled decoder is still busy', async () => {
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const closed = vi.fn();
    const open = vi.fn(async function* () {
      try {
        await firstRead;
        yield makeChunk(0);
      } finally {
        closed();
      }
    });
    const disposeInput = vi.fn();
    const track = new BoundedAudioTrack(1_000, 48_000, 2, open, disposeInput);
    const first = track.prepare(0).catch((error: unknown) => error);
    await flushReads();
    const latest = track.prepare(500).catch((error: unknown) => error);
    track.dispose();
    track.dispose();
    expect(disposeInput).toHaveBeenCalledOnce();
    expect(getLargeAudioDiagnostics().resources.tracks.live).toBe(0);
    expect(getLargeAudioDiagnostics().resources.readers.live).toBe(1);
    expect(((await first) as Error).name).toBe('AbortError');
    expect(((await latest) as Error).name).toBe('AbortError');
    expect(open).toHaveBeenCalledOnce();
    releaseFirst();
    await flushReads();
    expect(closed).toHaveBeenCalledOnce();
    expect(track.bufferedPcmBytes).toBe(0);
    await expect(track.prepare(600)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('closes each reader once when cancellation and late rejection both reach cleanup', async () => {
    let rejectRead!: (reason: unknown) => void;
    const pending = new Promise<IteratorResult<PcmChunk, void>>((_resolve, reject) => {
      rejectRead = reject;
    });
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const reader: PcmIterator = {
      next: () => pending,
      return: close,
      throw: async (error) => {
        throw error;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async [Symbol.asyncDispose]() {
        await this.return();
      },
    };
    const track = new BoundedAudioTrack(10, 48_000, 2, () => reader, vi.fn());
    const owner = new AbortController();
    const prepared = track.prepare(0, owner.signal).catch((error: unknown) => error);
    await flushReads();
    owner.abort();
    expect(((await prepared) as Error).name).toBe('AbortError');
    rejectRead(new Error('late decoder failure'));
    track.dispose();
    await flushReads();
    expect(close).toHaveBeenCalledOnce();
    expect(track.bufferedPcmBytes).toBe(0);
  });

  it('releases a playback reader once despite generator and source cleanup sharing ownership', async () => {
    let closeCalls = 0;
    const open = (): PcmIterator => {
      const reader = (async function* () {
        for (let time = 0; time < 10; time += 0.25) yield makeChunk(time);
      })();
      const originalReturn = reader.return.bind(reader);
      reader.return = (...args) => {
        closeCalls++;
        return originalReturn(...args);
      };
      return reader;
    };
    const track = new BoundedAudioTrack(10, 48_000, 2, open, vi.fn());
    await track.prepare(0);
    const context = {
      currentTime: 0,
      createBufferSource: () => ({ connect() {}, disconnect() {}, stop() {}, start() {} }),
    } as unknown as AudioContext;
    const playback = track.createPlayback({
      context,
      destination: {} as AudioNode,
      when: 0,
      offset: 0,
      onended: vi.fn(),
      onerror: vi.fn(),
    });
    await flushReads();
    playback.stop();
    playback.disconnect();
    track.dispose();
    await flushReads();
    expect(closeCalls).toBe(1);
    expect(track.bufferedPcmBytes).toBe(0);
  });
});
