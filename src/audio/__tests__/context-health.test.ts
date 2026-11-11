/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { probeAudioContextHealth } from '../context.ts';
import { AUDIO_CLOCK_SAMPLE_MS } from '../context-protocol.ts';

interface FakeContextOptions {
  state?: AudioContextState | 'interrupted';
  clock?: 'running' | 'stalled';
  resume?: 'resolve-running' | 'resolve-unchanged' | 'pending';
}

class FakeAudioContext {
  state: AudioContextState | 'interrupted';
  readonly resume = vi.fn<() => Promise<void>>();
  readonly suspend = vi.fn<() => Promise<void>>();
  private readonly clock: 'running' | 'stalled';
  private readonly baseTime: number;
  private readonly listeners = new Set<() => void>();

  constructor(options: FakeContextOptions = {}) {
    this.state = options.state ?? 'running';
    this.clock = options.clock ?? 'running';
    this.baseTime = performance.now();
    const resumeMode = options.resume ?? 'resolve-running';
    this.resume.mockImplementation(() => {
      if (resumeMode === 'pending') return new Promise<void>(() => undefined);
      if (resumeMode === 'resolve-running') this.state = 'running';
      return Promise.resolve();
    });
    this.suspend.mockImplementation(() => {
      this.state = 'suspended';
      return Promise.resolve();
    });
  }

  get currentTime(): number {
    return this.clock === 'running' ? (performance.now() - this.baseTime) / 1_000 : 4;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.listeners.delete(listener);
  }

  dispatchState(state: AudioContextState | 'interrupted'): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

async function loadContext(options: FakeContextOptions = {}) {
  const instance = new FakeAudioContext(options);
  class AudioContextConstructor {
    constructor() {
      return instance;
    }
  }
  vi.stubGlobal('AudioContext', AudioContextConstructor);
  vi.resetModules();
  // The play-request restart's names as these rows read them since Phase 7
  // 7C-4 moved it into context-recovery.ts: context.ts's own exports, the
  // owner's exported ones and its sub-steps (its one test seam).
  const context = await import('../context.ts');
  const {
    confirmPlayRequestAttemptHealth,
    consumeForegroundAudioContextClockHealthCheck,
    getPendingForegroundAudioContextClockHealthCheck,
    retireAudioContextRecoveryAttempt,
    ownerSubStepsForTests,
  } = await import('../context-recovery.ts');
  const module = {
    ...context,
    confirmPlayRequestAttemptHealth,
    consumeForegroundAudioContextClockHealthCheck,
    getPendingForegroundAudioContextClockHealthCheck,
    retireAudioContextRecoveryAttempt,
    ...ownerSubStepsForTests,
  };
  module.getAudioContext();
  return { instance, module };
}

/**
 * The engine's binding of the loaded context (context-recovery.ts, same
 * module graph): from then on each hidden edge arms the next foreground
 * incident and captures the hidden continuity, as a return from the
 * background does. Returns its disposer.
 */
async function bindForegroundReturns(instance: FakeAudioContext): Promise<() => void> {
  const recovery = await import('../context-recovery.ts');
  return recovery.bindAudioContextInterruptionRecovery(instance as unknown as AudioContext);
}

function setVisibility(value: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}

/**
 * The binding of the loaded context, a return from the background that arms
 * one foreground incident (its token), and a local-file PLAY's clock check on
 * this file's frozen clock (context-recovery.ts, Phase 7 7C-3): after its two
 * clock samples it prepares the play-request restart, and the promise
 * resolves with that preparation, or null.
 */
async function prepareAfterForegroundReturn(
  instance: FakeAudioContext,
  module: Awaited<ReturnType<typeof loadContext>>['module'],
) {
  const recovery = await import('../context-recovery.ts');
  recovery.bindAudioContextInterruptionRecovery(instance as unknown as AudioContext);
  setVisibility('hidden');
  setVisibility('visible');
  const checkToken = module.getPendingForegroundAudioContextClockHealthCheck()?.token;
  const verdict = recovery.checkForegroundClockBeforeFileStart({ isCurrent: () => true });
  const preparing = Promise.resolve(verdict).then((answer) =>
    answer?.kind === 'clock-stalled' ? answer.preparation : null,
  );
  return { checkToken, preparing };
}

describe('AudioContext foreground health', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('accepts a running native clock only after currentTime advances', async () => {
    const { module } = await loadContext({ clock: 'running' });
    const probe = module.probeAudioContextHealth({ attemptResume: true });
    await vi.advanceTimersByTimeAsync(180);

    await expect(probe).resolves.toMatchObject({
      healthy: true,
      reason: 'healthy',
      state: 'running',
    });
  });

  it('detects two consecutive running-but-frozen clock samples', async () => {
    const { module } = await loadContext({ clock: 'stalled' });
    const probe = module.probeAudioContextHealth({ attemptResume: true });
    await vi.advanceTimersByTimeAsync(360);

    await expect(probe).resolves.toEqual({
      healthy: false,
      reason: 'clock-stalled',
      state: 'running',
      clockAdvanceSeconds: 0,
    });
  });

  it('does not trust suspended-to-running when the resumed native clock stays frozen', async () => {
    const { instance, module } = await loadContext({
      state: 'suspended',
      resume: 'resolve-running',
      clock: 'stalled',
    });
    const probe = module.probeAudioContextHealth({ attemptResume: true });
    await vi.advanceTimersByTimeAsync(360);

    await expect(probe).resolves.toEqual({
      healthy: false,
      reason: 'clock-stalled',
      state: 'running',
      clockAdvanceSeconds: 0,
    });
    expect(instance.resume).toHaveBeenCalledOnce();
  });

  it('reports an early timer sample as inconclusive rather than clock-stalled', async () => {
    const { module } = await loadContext({ clock: 'stalled' });
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(100).mockReturnValueOnce(110);
    const probe = module.probeAudioContextHealth({ attemptResume: true });
    await vi.advanceTimersByTimeAsync(180);

    await expect(probe).resolves.toEqual({
      healthy: false,
      reason: 'inconclusive',
      state: 'running',
      clockAdvanceSeconds: 0,
    });
    now.mockRestore();
  });

  it('does not treat a resolved resume promise as success while native state stays suspended', async () => {
    const { module } = await loadContext({
      state: 'suspended',
      resume: 'resolve-unchanged',
    });

    await expect(module.probeAudioContextHealth({ attemptResume: true })).resolves.toMatchObject({
      healthy: false,
      reason: 'not-running',
      state: 'suspended',
    });
    await expect(module.ensureRunning()).rejects.toMatchObject({
      name: 'AudioContextNotRunningError',
      state: 'suspended',
    });
  });

  it('bounds a resume promise that WebKit never settles and reports the concrete state', async () => {
    const { module } = await loadContext({ state: 'suspended', resume: 'pending' });
    const probe = module.probeAudioContextHealth({ attemptResume: true });
    await vi.advanceTimersByTimeAsync(500);

    await expect(probe).resolves.toMatchObject({
      healthy: false,
      reason: 'not-running',
      state: 'suspended',
    });
  });

  it('starts the prepared context resume synchronously from a gesture', async () => {
    const { instance, module } = await loadContext({ state: 'running' });
    const recovery = module.restartAudioContextFromGesture();

    expect(instance.resume).toHaveBeenCalledOnce();
    expect(instance.suspend).not.toHaveBeenCalled();
    await recovery;
    expect(instance.state).toBe('running');
  });

  it('keeps only the exact one-shot foreground clock-health incident', async () => {
    const { instance, module } = await loadContext();
    const dispose = await bindForegroundReturns(instance);
    setVisibility('hidden');
    const first = module.getPendingForegroundAudioContextClockHealthCheck()?.token ?? null;
    const firstRequirement = module.getPendingForegroundAudioContextClockHealthCheck();
    setVisibility('visible');
    setVisibility('hidden');
    const second = module.getPendingForegroundAudioContextClockHealthCheck()?.token ?? null;
    const secondRequirement = module.getPendingForegroundAudioContextClockHealthCheck();

    expect(firstRequirement?.token).toBe(first);
    expect(firstRequirement?.isCurrent()).toBe(false);
    expect(secondRequirement?.token).toBe(second);
    expect(secondRequirement?.isCurrent()).toBe(true);
    expect(module.consumeForegroundAudioContextClockHealthCheck(first!)).toBe(false);
    expect(module.consumeForegroundAudioContextClockHealthCheck(second!)).toBe(true);
    expect(module.getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
    dispose();
  });

  it('reports no hidden continuity gap when wall and AudioContext clocks advance together', async () => {
    vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'));
    const { instance, module } = await loadContext({ clock: 'running' });
    const dispose = await bindForegroundReturns(instance);
    setVisibility('hidden');
    const token = module.getPendingForegroundAudioContextClockHealthCheck()?.token;

    await vi.advanceTimersByTimeAsync(2_000);

    const requirement = module.getPendingForegroundAudioContextClockHealthCheck();
    expect(requirement?.token).toBe(token);
    expect(requirement?.getHiddenContinuityGapSeconds()).toBeCloseTo(0, 6);
    dispose();
  });

  it('reports the hidden continuity gap when wall time advances but AudioContext freezes', async () => {
    vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'));
    const { instance, module } = await loadContext({ clock: 'stalled' });
    const dispose = await bindForegroundReturns(instance);
    setVisibility('hidden');
    const token = module.getPendingForegroundAudioContextClockHealthCheck()?.token;

    await vi.advanceTimersByTimeAsync(2_000);

    const requirement = module.getPendingForegroundAudioContextClockHealthCheck();
    expect(requirement?.token).toBe(token);
    expect(requirement?.getHiddenContinuityGapSeconds()).toBeCloseTo(2, 6);
    dispose();
  });

  it('prepares and confirms an identity-less foreground restart only after clock health', async () => {
    const { instance, module } = await loadContext({ clock: 'running' });
    const checkToken = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );

    const preparation = await module.preparePlayRequestRestart(checkToken!);
    expect(preparation).toMatchObject({ status: 'prepared' });
    expect(instance.state).toBe('suspended');
    expect(preparation?.isCurrent()).toBe(true);

    await expect(
      module.resumePreparedPlayRequestRestartFromGesture(preparation!.attemptToken),
    ).resolves.toEqual({ running: true, requiresClockVerification: true });
    const requirement = module.getPlayRequestClockRequirement();
    expect(requirement?.attemptToken).toBe(preparation?.attemptToken);
    expect(requirement?.isCurrent()).toBe(true);
    const health = module.probeAudioContextHealth({
      attemptResume: false,
      context: requirement!.context,
      isCurrent: requirement!.isCurrent,
    });
    await vi.advanceTimersByTimeAsync(180);
    await expect(health).resolves.toMatchObject({ healthy: true, reason: 'healthy' });
    expect(module.confirmPlayRequestAttemptHealth(preparation!.attemptToken)).toBe(true);
    expect(module.getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
  });

  it('prepares a generic restart for a tokenless PLAY clock stall', async () => {
    const { instance, module } = await loadContext({ clock: 'stalled' });

    const preparation = await module.preparePlayRequestRestartAfterClockStall(
      instance as unknown as AudioContext,
    );

    expect(preparation).toMatchObject({ status: 'prepared' });
    expect(preparation?.isCurrent()).toBe(true);
    expect(instance.suspend).toHaveBeenCalledOnce();
    expect(instance.state).toBe('suspended');
    expect(module.getPendingForegroundAudioContextClockHealthCheck()?.isCurrent()).toBe(true);
  });

  it('keeps a slow tokenless PLAY restart non-actionable until native suspension', async () => {
    const { instance, module } = await loadContext({ clock: 'stalled' });
    instance.suspend.mockImplementation(() => new Promise<void>(() => undefined));

    const pending = module.preparePlayRequestRestartAfterClockStall(
      instance as unknown as AudioContext,
    );
    await vi.advanceTimersByTimeAsync(500);
    const preparation = await pending;

    expect(preparation).toMatchObject({ status: 'preparing' });
    expect(preparation?.isCurrent()).toBe(false);
    expect(instance.resume).not.toHaveBeenCalled();

    instance.dispatchState('suspended');
    await expect(preparation!.whenPrepared).resolves.toBe(true);
    expect(preparation?.isCurrent()).toBe(true);
  });

  it('auto-rotates one resolved-running tokenless suspend without replacing its token', async () => {
    const { instance, module } = await loadContext({ clock: 'stalled' });
    instance.suspend
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(async () => {
        instance.state = 'suspended';
      });

    const pending = module.preparePlayRequestRestartAfterClockStall(
      instance as unknown as AudioContext,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const preparation = await pending;

    expect(preparation).toMatchObject({ status: 'preparing' });
    await expect(preparation!.whenPrepared).resolves.toBe(true);
    expect(preparation?.isCurrent()).toBe(true);
    expect(instance.suspend).toHaveBeenCalledTimes(2);
    expect(instance.state).toBe('suspended');
  });

  it('auto-rotates one never-settling tokenless suspend without replacing its token', async () => {
    const { instance, module } = await loadContext({ clock: 'stalled' });
    instance.suspend
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
      .mockImplementationOnce(async () => {
        instance.state = 'suspended';
      });

    const pending = module.preparePlayRequestRestartAfterClockStall(
      instance as unknown as AudioContext,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const preparation = await pending;

    expect(preparation).toMatchObject({ status: 'preparing' });
    await expect(preparation!.whenPrepared).resolves.toBe(true);
    expect(preparation?.isCurrent()).toBe(true);
    expect(instance.suspend).toHaveBeenCalledTimes(2);
    expect(instance.state).toBe('suspended');
  });

  it('never auto-retries a resolved-running generic lease after it is superseded', async () => {
    const { instance, module } = await loadContext({ clock: 'stalled' });
    instance.suspend.mockImplementation(() => new Promise<void>(() => undefined));
    const pending = module.preparePlayRequestRestartAfterClockStall(
      instance as unknown as AudioContext,
    );
    await vi.advanceTimersByTimeAsync(500);
    const preparation = await pending;
    const check = module.getPendingForegroundAudioContextClockHealthCheck();

    expect(preparation?.status).toBe('preparing');
    expect(module.consumeForegroundAudioContextClockHealthCheck(check!.token)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(preparation!.whenPrepared).resolves.toBe(false);
    expect(preparation?.isCurrent()).toBe(false);
    expect(instance.suspend).toHaveBeenCalledOnce();
  });

  it('withholds generic gesture resume across the 500ms late-suspend boundary', async () => {
    const { instance, module } = await loadContext({ clock: 'stalled' });
    let finishSuspend: (() => void) | undefined;
    instance.suspend.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSuspend = resolve;
        }),
    );
    const checkToken = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const preparing = module.preparePlayRequestRestart(checkToken!);
    await vi.advanceTimersByTimeAsync(500);
    const preparation = await preparing;

    expect(preparation).toMatchObject({ status: 'preparing' });
    await expect(
      module.resumePreparedPlayRequestRestartFromGesture(preparation!.attemptToken),
    ).resolves.toEqual({ running: false, requiresClockVerification: false });
    expect(instance.resume).not.toHaveBeenCalled();

    instance.dispatchState('suspended');
    await expect(preparation!.whenPrepared).resolves.toBe(true);
    await expect(
      module.resumePreparedPlayRequestRestartFromGesture(preparation!.attemptToken),
    ).resolves.toEqual({ running: true, requiresClockVerification: true });
    finishSuspend?.();
    await Promise.resolve();
    expect(instance.state).toBe('running');
    expect(instance.suspend).toHaveBeenCalledOnce();
  });

  it('promotes an exact gesture resume that reaches running after the 750ms deadline', async () => {
    const { instance, module } = await loadContext({ clock: 'running' });
    const checkToken = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const preparation = await module.preparePlayRequestRestart(checkToken!);
    let finishResume: (() => void) | undefined;
    instance.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishResume = resolve;
        }),
    );

    const gesture = module.resumePreparedPlayRequestRestartFromGesture(preparation!.attemptToken);
    await vi.advanceTimersByTimeAsync(750);
    await expect(gesture).resolves.toEqual({
      running: false,
      requiresClockVerification: false,
    });
    expect(module.getPlayRequestClockRequirement()).toBeNull();

    instance.dispatchState('running');
    finishResume?.();
    await Promise.resolve();
    const requirement = module.getPlayRequestClockRequirement();
    expect(requirement?.attemptToken).toBe(preparation?.attemptToken);
    expect(requirement?.isCurrent()).toBe(true);
  });

  it('keeps a retired late gesture resume inert against a successor restart', async () => {
    const { instance, module } = await loadContext({ clock: 'running' });
    const firstCheck = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const first = await module.preparePlayRequestRestart(firstCheck!);
    let finishFirstResume: (() => void) | undefined;
    instance.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirstResume = resolve;
        }),
    );
    const firstGesture = module.resumePreparedPlayRequestRestartFromGesture(first!.attemptToken);
    await vi.advanceTimersByTimeAsync(750);
    await firstGesture;

    const secondCheck = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const second = await module.preparePlayRequestRestart(secondCheck!);
    instance.dispatchState('running');
    finishFirstResume?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(module.getPlayRequestClockRequirement()).toBeNull();
    expect(first?.isCurrent()).toBe(false);
    expect(second?.isCurrent()).toBe(true);
    expect(instance.suspend).toHaveBeenCalledTimes(2);
    expect(instance.state).toBe('suspended');
  });

  it('hands a pending generic suspend lease only to the newest foreground token', async () => {
    const { instance, module } = await loadContext({ clock: 'stalled' });
    let finishSuspend: (() => void) | undefined;
    instance.suspend.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSuspend = resolve;
        }),
    );
    const firstCheck = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const firstPreparing = module.preparePlayRequestRestart(firstCheck!);
    await vi.advanceTimersByTimeAsync(500);
    const first = await firstPreparing;

    const secondCheck = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const secondPreparing = module.preparePlayRequestRestart(secondCheck!);
    await vi.advanceTimersByTimeAsync(500);
    const second = await secondPreparing;
    expect(instance.suspend).toHaveBeenCalledTimes(2);

    instance.dispatchState('suspended');
    await expect(first!.whenPrepared).resolves.toBe(false);
    await expect(second!.whenPrepared).resolves.toBe(true);
    expect(first!.isCurrent()).toBe(false);
    expect(second!.isCurrent()).toBe(true);
    finishSuspend?.();
  });

  it('retires a resolved-running suspend lease and fences its late state from a successor', async () => {
    const { instance, module } = await loadContext({ clock: 'stalled' });
    let finishSecondSuspend: (() => void) | undefined;
    instance.suspend
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishSecondSuspend = resolve;
          }),
      );
    const firstCheck = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const firstPreparing = module.preparePlayRequestRestart(firstCheck!);
    await vi.advanceTimersByTimeAsync(500);
    const first = await firstPreparing;
    expect(first?.status).toBe('preparing');
    expect(instance.suspend).toHaveBeenCalledOnce();

    const secondCheck = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const secondPreparing = module.preparePlayRequestRestart(secondCheck!);
    await vi.advanceTimersByTimeAsync(100);
    instance.dispatchState('suspended');
    await Promise.resolve();
    await Promise.resolve();

    expect(instance.resume).not.toHaveBeenCalled();
    expect(instance.suspend).toHaveBeenCalledOnce();
    await expect(first!.whenPrepared).resolves.toBe(false);
    expect(module.getPlayRequestClockRequirement()).toBeNull();

    const second = await secondPreparing;
    expect(second?.status).toBe('prepared');
    expect(second?.isCurrent()).toBe(true);
    await expect(second!.whenPrepared).resolves.toBe(true);
    expect(instance.state).toBe('suspended');
    finishSecondSuspend?.();
  });

  it('issues a fresh native suspend when the same token explicitly retries an inconclusive lease', async () => {
    const { instance, module } = await loadContext({ clock: 'stalled' });
    instance.suspend
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(async () => {
        instance.state = 'suspended';
      });
    const checkToken = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const firstPreparing = module.preparePlayRequestRestart(checkToken!);
    await vi.advanceTimersByTimeAsync(500);
    const first = await firstPreparing;
    expect(first?.status).toBe('preparing');

    const retry = module.preparePlayRequestRestart(checkToken!);
    await vi.advanceTimersByTimeAsync(250);

    await expect(retry).resolves.toMatchObject({
      status: 'prepared',
      attemptToken: first?.attemptToken,
    });
    expect(instance.suspend).toHaveBeenCalledTimes(2);
  });

  it('restores a visible context when a retired generic suspend lands late', async () => {
    const { instance, module } = await loadContext({ clock: 'stalled' });
    instance.suspend.mockImplementation(() => new Promise<void>(() => undefined));
    const { checkToken, preparing } = await prepareAfterForegroundReturn(instance, module);
    await vi.advanceTimersByTimeAsync(2 * AUDIO_CLOCK_SAMPLE_MS + 500);
    const preparation = await preparing;
    expect(preparation?.status).toBe('preparing');

    expect(module.consumeForegroundAudioContextClockHealthCheck(checkToken!)).toBe(true);
    instance.dispatchState('suspended');
    await Promise.resolve();

    expect(instance.resume).toHaveBeenCalledOnce();
    expect(instance.state).toBe('running');
    await expect(preparation!.whenPrepared).resolves.toBe(false);
  });

  it('has every probe caller choose whether it may resume: attemptResume has no default', () => {
    // Type-level: the production callers all pass it; a caller that leaves it out
    // would silently get a native resume() (Phase 7 7A-4).
    expectTypeOf<Parameters<typeof probeAudioContextHealth>[0]>()
      .toHaveProperty('attemptResume')
      .toEqualTypeOf<boolean>();
  });

  it('leaves nothing to retire once a restart is confirmed, even after a newer restart starts', async () => {
    const { instance, module } = await loadContext({ clock: 'running' });
    const context = instance as unknown as AudioContext;
    const preparation = await module.preparePlayRequestRestart(
      module.armForegroundAudioContextClockHealthCheck(context)!,
    );
    await module.resumePreparedPlayRequestRestartFromGesture(preparation!.attemptToken);
    const requirement = module.getPlayRequestClockRequirement();
    const health = module.probeAudioContextHealth({
      attemptResume: false,
      context: requirement!.context,
      isCurrent: requirement!.isCurrent,
    });
    await vi.advanceTimersByTimeAsync(180);
    await expect(health).resolves.toMatchObject({ healthy: true });
    expect(module.confirmPlayRequestAttemptHealth(preparation!.attemptToken)).toBe(true);
    const nativeCalls = instance.resume.mock.calls.length + instance.suspend.mock.calls.length;

    // The recovery dialog retires this token when its failed-PLAY retry does
    // not start; the confirm already emptied the slot, so that retire is a
    // no-op and the re-arm behind it never ran (removed in Phase 7 7A-6).
    expect(module.retireAudioContextRecoveryAttempt(preparation!.attemptToken)).toBe(false);
    expect(module.getPendingForegroundAudioContextClockHealthCheck()).toBeNull();

    // A newer restart that starts while the retry runs has a token of its own.
    instance.state = 'running';
    const newer = await module.preparePlayRequestRestart(
      module.armForegroundAudioContextClockHealthCheck(context)!,
    );
    expect(newer?.status).toBe('prepared');
    const newerCalls = instance.resume.mock.calls.length + instance.suspend.mock.calls.length;
    expect(module.retireAudioContextRecoveryAttempt(preparation!.attemptToken)).toBe(false);
    expect(newer?.isCurrent()).toBe(true);
    expect(instance.resume.mock.calls.length + instance.suspend.mock.calls.length).toBe(newerCalls);
    expect(newerCalls).toBe(nativeCalls + 1);
  });
});
