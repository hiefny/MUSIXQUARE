import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn(), warn: vi.fn() }));
vi.mock('../../core/log.ts', () => ({ log: { warn: mocks.warn } }));

describe('optional flight recorder readiness', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.init.mockReset();
    mocks.warn.mockReset();
  });

  afterEach(() => vi.doUnmock('../sync-flight-recorder.ts'));

  it('does no work until entry and shares initialization across room and demo callers', async () => {
    const evaluate = vi.fn(() => ({ initSyncFlightRecorder: mocks.init }));
    vi.doMock('../sync-flight-recorder.ts', evaluate);
    const { prepareSyncFlightRecorder } = await import('../sync-flight-recorder-loader.ts');

    await vi.dynamicImportSettled();
    expect(evaluate).not.toHaveBeenCalled();
    const room = prepareSyncFlightRecorder();
    const demo = prepareSyncFlightRecorder();
    expect(demo).toBe(room);
    await Promise.all([room, demo]);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(mocks.init).toHaveBeenCalledOnce();
    await prepareSyncFlightRecorder();
    expect(mocks.init).toHaveBeenCalledOnce();
  });

  it.each(['import', 'initialization'])(
    'keeps playback available after an optional %s failure',
    async (stage) => {
      const failure = new Error('recorder unavailable');
      vi.doMock('../sync-flight-recorder.ts', () => {
        if (stage === 'import') throw failure;
        return { initSyncFlightRecorder: mocks.init };
      });
      if (stage === 'initialization')
        mocks.init.mockImplementation(() => {
          throw failure;
        });
      const { prepareSyncFlightRecorder } = await import('../sync-flight-recorder-loader.ts');

      await expect(prepareSyncFlightRecorder()).resolves.toBeUndefined();
      await expect(prepareSyncFlightRecorder()).resolves.toBeUndefined();
      expect(mocks.warn).toHaveBeenCalledOnce();
      expect(mocks.warn).toHaveBeenCalledWith(
        '[SyncFlightRecorder] Optional initialization failed',
        expect.any(Error),
      );
      const reported = mocks.warn.mock.calls[0][1] as Error;
      expect(stage === 'import' ? reported.cause : reported).toBe(failure);
      expect(mocks.init).toHaveBeenCalledTimes(stage === 'initialization' ? 1 : 0);
    },
  );
});
