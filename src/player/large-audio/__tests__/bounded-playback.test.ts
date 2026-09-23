import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { BoundedPlayback, type PcmChunk } from '../bounded-playback.ts';

function chunk(timestamp: number, duration = 0.25): PcmChunk {
  return {
    timestamp,
    buffer: {
      duration,
      length: duration * 48_000,
      numberOfChannels: 2,
      sampleRate: 48_000,
    } as AudioBuffer,
  };
}

function setup() {
  vi.useFakeTimers();
  const sources: Array<{
    buffer: AudioBuffer | null;
    onended: (() => void) | null;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const context = {
    currentTime: 0,
    createBufferSource: () => {
      const node = {
        buffer: null,
        onended: null,
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      sources.push(node);
      return node;
    },
  };
  const options = {
    context: context as unknown as AudioContext,
    destination: {} as AudioNode,
    when: 0,
    offset: 0,
    duration: 100,
    onended: vi.fn(),
    onerror: vi.fn(),
    onreleased: vi.fn(),
  };
  return { sources, context, options };
}

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('bounded sample-clock scheduling', () => {
  it('keeps only a short horizon and releases every scheduled source when stopped', async () => {
    const { sources, options } = setup();
    const closed = vi.fn();
    const iterator = (async function* () {
      try {
        for (let time = 0.25; time < 100; time += 0.25) yield chunk(time);
      } finally {
        closed();
      }
    })();
    const playback = new BoundedPlayback({ ...options, firstChunk: chunk(0), iterator });
    await vi.advanceTimersByTimeAsync(100);
    // Eight seconds of lookahead plus the quarter-second source at the boundary.
    expect(sources.length).toBeLessThanOrEqual(33);
    expect(sources[0].start).toHaveBeenCalledWith(0, 0, 0.25);
    expect(playback.bufferedPcmBytes).toBeLessThan(4 * 1024 * 1024);
    playback.stop();
    await Promise.resolve();
    expect(playback.bufferedPcmBytes).toBe(0);
    expect(
      sources.every((node) => node.stop.mock.calls.length === 1 && node.onended === null),
    ).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    expect(options.onended).not.toHaveBeenCalled();
  });

  it('clips elapsed PCM rather than playing an obsolete position late', () => {
    const { sources, context, options } = setup();
    context.currentTime = 5;
    const playback = new BoundedPlayback({
      ...options,
      when: 4,
      offset: 10,
      duration: 12,
      firstChunk: chunk(10, 2),
      iterator: (async function* () {})(),
    });
    expect(sources[0].start).toHaveBeenCalledWith(5, 1, 1);
    playback.stop();
  });

  it('seeks directly to the live position after a long timer suspension', async () => {
    const { sources, context, options } = setup();
    const closed = vi.fn();
    const reopenReader = vi.fn(async function* (position: number) {
      for (let time = position; time < position + 20; time += 0.25) yield chunk(time);
    });
    const playback = new BoundedPlayback({
      ...options,
      duration: 1200,
      firstChunk: chunk(0),
      iterator: (async function* () {
        try {
          for (let time = 0.25; time < 1200; time += 0.25) yield chunk(time);
        } finally {
          closed();
        }
      })(),
      reopenReader,
    });
    await vi.advanceTimersByTimeAsync(100);
    const previousCount = sources.length;
    context.currentTime = 600;
    await vi.advanceTimersByTimeAsync(100);
    expect(reopenReader).toHaveBeenCalledExactlyOnceWith(600);
    expect(closed).toHaveBeenCalledOnce();
    expect(sources[previousCount].start).toHaveBeenCalledWith(600, 0, 0.25);
    expect(sources.length - previousCount).toBeLessThan(40);
    expect(options.onended).not.toHaveBeenCalled();
    playback.stop();
  });

  it('still releases the iterator when native stop and disconnect throw', async () => {
    const { sources, options } = setup();
    const closed = vi.fn();
    const playback = new BoundedPlayback({
      ...options,
      firstChunk: chunk(0),
      iterator: (async function* () {
        try {
          yield chunk(0.25);
        } finally {
          closed();
        }
      })(),
    });
    await vi.advanceTimersByTimeAsync(1);
    for (const node of sources) {
      node.stop.mockImplementation(() => {
        throw new Error('stopped');
      });
      node.disconnect.mockImplementation(() => {
        throw new Error('disconnected');
      });
    }
    expect(() => playback.stop()).not.toThrow();
    await Promise.resolve();
    expect(closed).toHaveBeenCalledOnce();
    expect(options.onreleased).toHaveBeenCalledOnce();
    expect(playback.bufferedPcmBytes).toBe(0);
  });

  it('does not confuse temporary empty output or decoder failure with track completion', async () => {
    const { sources, context, options } = setup();
    const playback = new BoundedPlayback({
      ...options,
      firstChunk: chunk(0),
      iterator: (async function* () {
        yield await Promise.reject<PcmChunk>(new Error('bad frame'));
      })(),
    });
    await vi.advanceTimersByTimeAsync(1);
    context.currentTime = 10;
    sources[0].onended?.();
    expect(options.onerror).toHaveBeenCalledOnce();
    expect(options.onended).not.toHaveBeenCalled();
    expect(playback.ended).toBe(false);
    expect(playback.bufferedPcmBytes).toBe(0);
  });

  it('waits for the real audio clock deadline before reporting natural completion', async () => {
    const { sources, context, options } = setup();
    const playback = new BoundedPlayback({
      ...options,
      duration: 1,
      when: 2,
      firstChunk: chunk(0, 1),
      iterator: (async function* () {})(),
    });
    await vi.advanceTimersByTimeAsync(100);
    sources[0].onended?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(options.onended).not.toHaveBeenCalled();
    context.currentTime = 3;
    await vi.advanceTimersByTimeAsync(100);
    expect(options.onended).toHaveBeenCalledOnce();
    expect(playback.ended).toBe(true);
  });
});
