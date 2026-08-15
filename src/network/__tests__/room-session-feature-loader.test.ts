import { afterEach, describe, expect, it, vi } from 'vitest';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.doUnmock('../room-session-feature-runtime.ts');
  vi.resetModules();
});

describe('room session feature loader', () => {
  it('settles one aborted caller while the shared import continues for another caller', async () => {
    const evaluation = deferred();
    vi.doMock('../room-session-feature-runtime.ts', async () => {
      await evaluation.promise;
      return {};
    });
    const { prepareRoomSessionFeatures } = await import('../room-session-feature-loader.ts');
    const controller = new AbortController();
    const cancelled = prepareRoomSessionFeatures(controller.signal);
    const reused = prepareRoomSessionFeatures();

    controller.abort(new Error('caller stopped'));
    await expect(cancelled).rejects.toThrow('caller stopped');

    evaluation.resolve();
    await expect(reused).resolves.toBeUndefined();
  });

  it('emits once for concurrent callers and re-emits for a later caller', async () => {
    let evaluations = 0;
    vi.doMock('../room-session-feature-runtime.ts', () => {
      evaluations += 1;
      throw new Error('chunk unavailable');
    });
    const { bus } = await import('../../core/events.ts');
    const failure = vi.fn();
    bus.on('app:lazy-feature-load-failed', failure);
    const { prepareRoomSessionFeatures } = await import('../room-session-feature-loader.ts');

    const first = prepareRoomSessionFeatures();
    const retained = prepareRoomSessionFeatures();

    expect(retained).toBe(first);
    await Promise.all([
      expect(first).rejects.toThrow('ROOM_SESSION_FEATURE_LOAD_FAILED_RELOAD_REQUIRED'),
      expect(retained).rejects.toThrow('ROOM_SESSION_FEATURE_LOAD_FAILED_RELOAD_REQUIRED'),
    ]);
    expect(evaluations).toBe(1);
    expect(failure).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith('room-session', expect.any(Error));

    await expect(prepareRoomSessionFeatures()).rejects.toThrow(
      'ROOM_SESSION_FEATURE_LOAD_FAILED_RELOAD_REQUIRED',
    );
    expect(evaluations).toBe(1);
    expect(failure).toHaveBeenCalledTimes(2);
  });
});
