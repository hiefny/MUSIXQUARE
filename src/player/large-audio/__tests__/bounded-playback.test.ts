import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { BoundedPlayback, type PcmChunk } from '../bounded-playback.ts';
import { getLargeAudioDiagnostics } from '../diagnostics.ts';
import { isLargeAudioOutputError } from '../output-error.ts';

function pendingChunk() {
  let resolve!: (chunk: PcmChunk) => void;
  const promise = new Promise<PcmChunk>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

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
  vi.restoreAllMocks();
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
    expect(sources[0].start).toHaveBeenCalledWith(0, 0);
    expect(sources[0].stop).toHaveBeenCalledWith(0.25);
    expect(playback.bufferedPcmBytes).toBeLessThan(4 * 1024 * 1024);
    playback.stop();
    await Promise.resolve();
    expect(playback.bufferedPcmBytes).toBe(0);
    expect(
      sources.every((node) => node.stop.mock.calls.length === 2 && node.onended === null),
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
    expect(sources[0].start).toHaveBeenCalledWith(5, 1);
    expect(sources[0].stop).toHaveBeenCalledWith(6);
    playback.stop();
  });

  it('seeks directly to the live position after a long timer suspension', async () => {
    const { sources, context, options } = setup();
    const before = getLargeAudioDiagnostics();
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
    expect(sources[previousCount].start).toHaveBeenCalledWith(600, 0);
    expect(sources[previousCount].stop).toHaveBeenCalledWith(600.25);
    expect(sources.length - previousCount).toBeLessThan(40);
    expect(options.onended).not.toHaveBeenCalled();
    playback.stop();
    const after = getLargeAudioDiagnostics();
    expect(after.output.readerRestarts).toBe(before.output.readerRestarts + 1);
    expect(after.resources.playbacks.live).toBe(before.resources.playbacks.live);
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
    expect(isLargeAudioOutputError(options.onerror.mock.calls[0][0])).toBe(false);
    expect(options.onended).not.toHaveBeenCalled();
    expect(playback.ended).toBe(false);
    expect(playback.bufferedPcmBytes).toBe(0);
  });

  it('waits for the real audio clock deadline before reporting natural completion', async () => {
    const { sources, context, options } = setup();
    const before = getLargeAudioDiagnostics();
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
    expect(getLargeAudioDiagnostics().output.supplyGaps).toBe(before.output.supplyGaps);
    expect(getLargeAudioDiagnostics().resources.playbacks.live).toBe(
      before.resources.playbacks.live,
    );
  });

  it.each([10.25, 10.2])(
    'stops at the logical track boundary %s without playing interpolation tail samples',
    async (duration) => {
      const { sources, context, options } = setup();
      const when = 2.000013;
      const offset = 10.1;
      const firstChunk = { ...chunk(10, 0.25 + 2 / 48_000), duration: 0.25 };
      const playback = new BoundedPlayback({
        ...options,
        when,
        offset,
        duration,
        firstChunk,
        iterator: (async function* () {})(),
      });
      try {
        expect(firstChunk.buffer.duration).toBeGreaterThan(firstChunk.duration);
        expect(sources[0].start).toHaveBeenCalledOnce();
        expect(sources[0].start.mock.calls[0]).toHaveLength(2);
        expect(sources[0].start.mock.calls[0][0]).toBeCloseTo(when, 12);
        expect(sources[0].start.mock.calls[0][1]).toBeCloseTo(offset - firstChunk.timestamp, 12);
        const expectedEnd = when + duration - offset;
        expect(sources[0].stop).toHaveBeenCalledExactlyOnceWith(expectedEnd);
        expect(expectedEnd).toBeLessThan(
          when + firstChunk.timestamp + firstChunk.buffer.duration - offset,
        );
        await vi.advanceTimersByTimeAsync(1);
        context.currentTime = expectedEnd;
        sources[0].onended?.();
        await vi.advanceTimersByTimeAsync(100);
        expect(playback.ended).toBe(true);
        expect(options.onended).toHaveBeenCalledOnce();
        expect(options.onerror).not.toHaveBeenCalled();
      } finally {
        playback.stop();
      }
    },
  );

  it.each([NaN, 0, -1, 0.5])(
    'rejects an invalid logical PCM duration %s before scheduling',
    (duration) => {
      const { sources, options } = setup();
      const playback = new BoundedPlayback({
        ...options,
        firstChunk: { ...chunk(0, 0.25), duration },
        iterator: (async function* () {})(),
      });
      expect(sources).toHaveLength(0);
      expect(playback.active).toBe(false);
      expect(options.onerror).toHaveBeenCalledOnce();
      expect(isLargeAudioOutputError(options.onerror.mock.calls[0][0])).toBe(false);
      expect(options.onreleased).toHaveBeenCalledOnce();
      expect(options.onended).not.toHaveBeenCalled();
    },
  );

  it.each(
    (['create', 'connect', 'start', 'stop'] as const).flatMap((operation) =>
      (['initial', 'later'] as const).map((phase) => ({ operation, phase })),
    ),
  )(
    'identifies $phase native $operation failures without blaming decoded media',
    async ({ operation, phase }) => {
      const { sources, context, options } = setup();
      const nativeFailure = new DOMException('Audio route changed', 'InvalidStateError');
      const originalCreate = context.createBufferSource;
      let calls = 0;
      vi.spyOn(context, 'createBufferSource').mockImplementation(() => {
        const shouldFail = ++calls === (phase === 'initial' ? 1 : 2);
        if (shouldFail && operation === 'create') throw nativeFailure;
        const source = originalCreate();
        if (shouldFail && operation !== 'create') {
          source[operation].mockImplementationOnce(() => {
            throw nativeFailure;
          });
        }
        return source;
      });
      const playback = new BoundedPlayback({
        ...options,
        firstChunk: chunk(0),
        iterator: (async function* () {
          yield chunk(0.25);
        })(),
      });
      if (phase === 'initial') expect(options.onerror).toHaveBeenCalledOnce();
      else {
        expect(options.onerror).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(options.onerror).toHaveBeenCalledOnce();
      const error: unknown = options.onerror.mock.calls[0][0];
      expect(error).toMatchObject({ cause: nativeFailure });
      expect(isLargeAudioOutputError(error)).toBe(true);
      expect(isLargeAudioOutputError(new Error('source adapter', { cause: error }))).toBe(true);
      expect(isLargeAudioOutputError(nativeFailure)).toBe(false);
      expect(playback.active).toBe(false);
      expect(playback.ended).toBe(false);
      expect(options.onreleased).toHaveBeenCalledOnce();
      expect(options.onended).not.toHaveBeenCalled();
      expect(sources.every((source) => source.disconnect.mock.calls.length > 0)).toBe(true);
    },
  );

  it('does not classify unrelated cyclic errors as output scheduling failures', () => {
    const error = new Error('decode failed');
    error.cause = error;
    expect(isLargeAudioOutputError(error)).toBe(false);
  });

  it('counts pending decoder gaps only after the audio deadline and once per recovered episode', async () => {
    const { sources, context, options } = setup();
    const before = getLargeAudioDiagnostics();
    const first = pendingChunk();
    const second = pendingChunk();
    const closed = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let readClock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => readClock);
    const playback = new BoundedPlayback({
      ...options,
      when: 2,
      firstChunk: chunk(0),
      iterator: (async function* () {
        try {
          yield await first.promise;
          yield await second.promise;
        } finally {
          closed();
        }
      })(),
    });
    try {
      expect(getLargeAudioDiagnostics().resources.playbacks.live).toBe(
        before.resources.playbacks.live + 1,
      );
      sources[0].onended?.(); // Simulate a browser reporting ended before its audio clock deadline.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getLargeAudioDiagnostics().output.supplyGaps).toBe(before.output.supplyGaps);
      context.currentTime = 2.26;
      await vi.advanceTimersByTimeAsync(100);
      expect(getLargeAudioDiagnostics().output.supplyGaps).toBe(before.output.supplyGaps);
      context.currentTime = 2.3;
      await vi.advanceTimersByTimeAsync(100);
      expect(getLargeAudioDiagnostics().output.supplyGaps).toBe(before.output.supplyGaps + 1);
      context.currentTime = 2.7;
      await vi.advanceTimersByTimeAsync(300);
      expect(getLargeAudioDiagnostics().output.supplyGaps).toBe(before.output.supplyGaps + 1);
      expect(warn).toHaveBeenCalledOnce();
      readClock = 1200;
      first.resolve(chunk(0.25, 1));
      await vi.advanceTimersByTimeAsync(1);
      expect(sources).toHaveLength(2);
      expect(sources[1].start.mock.calls[0][0]).toBeCloseTo(2.7);
      expect(getLargeAudioDiagnostics().output.longestReadMs).toBeGreaterThanOrEqual(1200);
      expect(options.onended).not.toHaveBeenCalled();
      expect(options.onerror).not.toHaveBeenCalled();
      context.currentTime = 3.3;
      await vi.advanceTimersByTimeAsync(100);
      expect(getLargeAudioDiagnostics().output.supplyGaps).toBe(before.output.supplyGaps + 2);
      context.currentTime = 3.8;
      await vi.advanceTimersByTimeAsync(300);
      expect(getLargeAudioDiagnostics().output.supplyGaps).toBe(before.output.supplyGaps + 2);
      expect(getLargeAudioDiagnostics().output.longestSupplyGapMs).toBeGreaterThanOrEqual(549);
      const stoppedCount = getLargeAudioDiagnostics().resources.playbacks.closed;
      playback.stop();
      playback.stop();
      expect(getLargeAudioDiagnostics().resources.playbacks.live).toBe(
        before.resources.playbacks.live,
      );
      expect(getLargeAudioDiagnostics().resources.playbacks.closed).toBe(stoppedCount + 1);
      const supplyGapsAfterStop = getLargeAudioDiagnostics().output.supplyGaps;
      second.resolve(chunk(1.25, 1));
      context.currentTime = 80;
      await vi.advanceTimersByTimeAsync(1000);
      expect(sources).toHaveLength(2);
      expect(getLargeAudioDiagnostics().output.supplyGaps).toBe(supplyGapsAfterStop);
      expect(closed).toHaveBeenCalledOnce();
      expect(playback.bufferedPcmBytes).toBe(0);
      expect(options.onreleased).toHaveBeenCalledOnce();
    } finally {
      first.resolve(chunk(0.25, 1));
      second.resolve(chunk(1.25, 1));
      playback.stop();
    }
  });
});
