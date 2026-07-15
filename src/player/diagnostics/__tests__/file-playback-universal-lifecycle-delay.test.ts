import { describe, expect, it, vi } from 'vitest';

import { createFilePlaybackUniversalLifecycleDelay } from '../file-playback-universal-lifecycle-delay.ts';
import { createFilePlaybackUniversalLifecycleDiagnosticsForTests } from '../file-playback-universal-lifecycle-diagnostics.ts';

type FilePlaybackUniversalLifecycleDelayRuntime = NonNullable<
  Parameters<typeof createFilePlaybackUniversalLifecycleDelay>[1]
>;

function harness(
  options: {
    readonly clearThrows?: boolean;
    readonly armThrows?: boolean;
    readonly firesWhileArming?: boolean;
  } = {},
) {
  const diagnostics = createFilePlaybackUniversalLifecycleDiagnosticsForTests();
  const handle = {} as ReturnType<typeof globalThis.setTimeout>;
  let callback: (() => void) | null = null;
  const clearTimeout = vi.fn(() => {
    if (options.clearThrows) throw new Error('native timer cancellation failed');
  });
  const runtime: FilePlaybackUniversalLifecycleDelayRuntime = {
    acquireTimerLease: () => diagnostics.acquire('timers'),
    setTimeout: (candidate) => {
      if (options.armThrows) throw new Error('native timer arming failed');
      callback = candidate;
      if (options.firesWhileArming) candidate();
      return handle;
    },
    clearTimeout,
  };
  return {
    diagnostics,
    runtime,
    handle,
    clearTimeout,
    fire: () => {
      if (!callback) throw new Error('timer was not armed');
      callback();
    },
  };
}

describe('file playback universal lifecycle delay', () => {
  it('releases the timer lease only after confirmed cancellation', async () => {
    const h = harness();
    const delay = createFilePlaybackUniversalLifecycleDelay(2_500, h.runtime);

    expect(h.diagnostics.snapshot().kinds.timers.live).toBe(1);
    delay.cancel();
    await expect(delay.promise).resolves.toBeUndefined();

    expect(h.clearTimeout).toHaveBeenCalledOnce();
    expect(h.clearTimeout).toHaveBeenCalledWith(h.handle);
    expect(h.diagnostics.snapshot().kinds.timers).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 0,
      releasedTotal: 1,
    });
  });

  it('keeps a failed native cancellation sticky-unconfirmed', async () => {
    const h = harness({ clearThrows: true });
    const delay = createFilePlaybackUniversalLifecycleDelay(2_500, h.runtime);

    delay.cancel();
    await expect(delay.promise).resolves.toBeUndefined();

    expect(h.diagnostics.snapshot().kinds.timers).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 1,
      releasedTotal: 0,
    });
  });

  it('treats the native callback itself as physical timer completion', async () => {
    const h = harness({ clearThrows: true });
    const delay = createFilePlaybackUniversalLifecycleDelay(2_500, h.runtime);

    h.fire();
    await expect(delay.promise).resolves.toBeUndefined();

    expect(h.clearTimeout).not.toHaveBeenCalled();
    expect(h.diagnostics.snapshot().kinds.timers).toMatchObject({
      live: 0,
      unconfirmed: 0,
      releasedTotal: 1,
    });
  });

  it('does not publish a false zero when a hostile timer fires during registration', async () => {
    const h = harness({ clearThrows: true, firesWhileArming: true });
    const delay = createFilePlaybackUniversalLifecycleDelay(2_500, h.runtime);

    await expect(delay.promise).resolves.toBeUndefined();

    expect(h.clearTimeout).not.toHaveBeenCalled();
    expect(h.diagnostics.snapshot().kinds.timers).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 0,
      releasedTotal: 1,
    });
  });

  it('rolls back the lease when native timer arming throws', async () => {
    const h = harness({ armThrows: true });
    const delay = createFilePlaybackUniversalLifecycleDelay(2_500, h.runtime);

    await expect(delay.promise).rejects.toThrow(/arming failed/i);
    expect(h.diagnostics.snapshot().kinds.timers).toMatchObject({
      live: 0,
      unconfirmed: 0,
      releasedTotal: 1,
    });
  });
});
