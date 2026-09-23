import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { BoundedAudioTrack } from '../bounded-track.ts';
import type { PcmChunk } from '../bounded-playback.ts';

const makeChunk = (timestamp: number): PcmChunk => ({
  timestamp,
  buffer: {
    duration: 0.25,
    length: 12_000,
    numberOfChannels: 2,
    sampleRate: 48_000,
  } as AudioBuffer,
});

afterEach(() => {
  clearAllManagedTimers();
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
    await track.prepare(90);
    expect(track.bufferedPcmBytes).toBe(48_000 * 2 * 4);
    // Cancellation must settle even while the obsolete decoder is still busy.
    expect(((await firstOutcome) as Error).name).toBe('AbortError');
    releaseFirst();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(disposeInput).not.toHaveBeenCalled();
    expect(closed).toContain(0);
    track.dispose();
    await Promise.resolve();
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
    await Promise.resolve();
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
});
