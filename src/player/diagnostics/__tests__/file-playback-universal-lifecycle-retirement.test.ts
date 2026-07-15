import { describe, expect, it, vi } from 'vitest';

import { confirmFilePlaybackUniversalLifecycleRetirement } from '../file-playback-universal-lifecycle-retirement.ts';
import { createFilePlaybackUniversalLifecycleDiagnosticsForTests as createFilePlaybackUniversalLifecycleDiagnostics } from '../file-playback-universal-lifecycle-diagnostics.ts';

type RetirementRuntime = NonNullable<
  Parameters<typeof confirmFilePlaybackUniversalLifecycleRetirement>[3]
>;

function retirementRuntime(options: { readonly clearThrows?: boolean } = {}) {
  const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
  const handle = {} as ReturnType<typeof globalThis.setTimeout>;
  let callback: (() => void) | null = null;
  const clearTimeout = vi.fn(() => {
    if (options.clearThrows) throw new Error('native timer cancellation failed');
  });
  const runtime: RetirementRuntime = {
    acquireTimerLease: () => diagnostics.acquire('timers'),
    setTimeout: (candidate) => {
      callback = candidate;
      return handle;
    },
    clearTimeout,
  };
  return {
    diagnostics,
    runtime,
    clearTimeout,
    fire: () => {
      if (!callback) throw new Error('retirement deadline was not armed');
      callback();
    },
  };
}

describe('file playback universal lifecycle retirement', () => {
  it('keeps an owner retiring until physical cleanup settles', async () => {
    const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });

    // Exercise the helper contract with the shared timer ledger separately
    // from this isolated owner ledger.
    const retirement = confirmFilePlaybackUniversalLifecycleRetirement(
      diagnostics.acquire('roomOwners'),
      () => cleanup,
    );
    expect(diagnostics.snapshot().kinds.roomOwners).toMatchObject({ live: 0, retiring: 1 });

    resolveCleanup();
    await expect(retirement).resolves.toBe('released');
    expect(diagnostics.snapshot().kinds.roomOwners).toMatchObject({
      retiring: 0,
      unconfirmed: 0,
      releasedTotal: 1,
    });
  });

  it('makes rejection sticky-unconfirmed', async () => {
    const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
    const retirement = confirmFilePlaybackUniversalLifecycleRetirement(
      diagnostics.acquire('connectionOwners'),
      () => Promise.reject(new Error('cleanup failed')),
    );

    await expect(retirement).resolves.toBe('unconfirmed');
    expect(diagnostics.snapshot().kinds.connectionOwners).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 1,
      releasedTotal: 0,
    });
  });

  it('makes a missed acknowledgement sticky-unconfirmed at the deadline', async () => {
    vi.useFakeTimers();
    try {
      const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
      const retirement = confirmFilePlaybackUniversalLifecycleRetirement(
        diagnostics.acquire('encodedSources'),
        () => new Promise<void>(() => undefined),
        5_000,
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(retirement).resolves.toBe('unconfirmed');
      expect(diagnostics.snapshot().kinds.encodedSources).toMatchObject({
        live: 0,
        retiring: 0,
        unconfirmed: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rolls back the deadline lease and marks only the target unconfirmed if timer arming throws', async () => {
    const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
    const setTimeout = vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
      throw new Error('timer factory failed');
    });
    try {
      const outcome = confirmFilePlaybackUniversalLifecycleRetirement(
        diagnostics.acquire('roomOwners'),
        () => Promise.resolve(),
      );

      await expect(outcome).resolves.toBe('unconfirmed');
      expect(diagnostics.snapshot().kinds.roomOwners).toMatchObject({
        live: 0,
        retiring: 0,
        unconfirmed: 1,
      });
    } finally {
      setTimeout.mockRestore();
    }
  });

  it('keeps a failed native deadline cancellation sticky-unconfirmed without hiding confirmed target cleanup', async () => {
    const target = createFilePlaybackUniversalLifecycleDiagnostics();
    const h = retirementRuntime({ clearThrows: true });

    const outcome = confirmFilePlaybackUniversalLifecycleRetirement(
      target.acquire('encodedSources'),
      () => Promise.resolve(),
      5_000,
      h.runtime,
    );

    await expect(outcome).resolves.toBe('released');
    expect(target.snapshot().kinds.encodedSources).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 0,
      releasedTotal: 1,
    });
    expect(h.clearTimeout).toHaveBeenCalledOnce();
    expect(h.diagnostics.snapshot().kinds.timers).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 1,
      releasedTotal: 0,
    });
  });

  it('settles both ledgers sticky-unconfirmed when cleanup and deadline cancellation fail', async () => {
    const target = createFilePlaybackUniversalLifecycleDiagnostics();
    const h = retirementRuntime({ clearThrows: true });

    const outcome = confirmFilePlaybackUniversalLifecycleRetirement(
      target.acquire('workers'),
      () => Promise.reject(new Error('physical cleanup failed')),
      5_000,
      h.runtime,
    );

    await expect(outcome).resolves.toBe('unconfirmed');
    expect(target.snapshot().kinds.workers).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 1,
      releasedTotal: 0,
    });
    expect(h.diagnostics.snapshot().kinds.timers).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 1,
      releasedTotal: 0,
    });
  });

  it('treats the fired deadline callback as physical timer retirement even if cancellation is hostile', async () => {
    const target = createFilePlaybackUniversalLifecycleDiagnostics();
    const h = retirementRuntime({ clearThrows: true });
    const outcome = confirmFilePlaybackUniversalLifecycleRetirement(
      target.acquire('ports'),
      () => new Promise<void>(() => undefined),
      5_000,
      h.runtime,
    );

    h.fire();
    await expect(outcome).resolves.toBe('unconfirmed');
    expect(h.clearTimeout).not.toHaveBeenCalled();
    expect(h.diagnostics.snapshot().kinds.timers).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 0,
      releasedTotal: 1,
    });
    expect(target.snapshot().kinds.ports).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 1,
    });
  });
});
