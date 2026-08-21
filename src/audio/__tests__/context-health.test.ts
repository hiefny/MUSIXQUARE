/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const module = await import('../context.ts');
  module.getAudioContext();
  return { instance, module };
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
    const probe = module.probeAudioContextHealth();
    await vi.advanceTimersByTimeAsync(180);

    await expect(probe).resolves.toMatchObject({
      healthy: true,
      reason: 'healthy',
      state: 'running',
    });
  });

  it('detects two consecutive running-but-frozen clock samples', async () => {
    const { module } = await loadContext({ clock: 'stalled' });
    const probe = module.probeAudioContextHealth();
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
    const probe = module.probeAudioContextHealth();
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
    const probe = module.probeAudioContextHealth();
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

    await expect(module.probeAudioContextHealth()).resolves.toMatchObject({
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
    const probe = module.probeAudioContextHealth();
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
    const first = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const firstRequirement = module.getPendingForegroundAudioContextClockHealthCheck();
    const second = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const secondRequirement = module.getPendingForegroundAudioContextClockHealthCheck();

    expect(firstRequirement?.token).toBe(first);
    expect(firstRequirement?.isCurrent()).toBe(false);
    expect(secondRequirement?.token).toBe(second);
    expect(secondRequirement?.isCurrent()).toBe(true);
    expect(module.consumeForegroundAudioContextClockHealthCheck(first!)).toBe(false);
    expect(module.consumeForegroundAudioContextClockHealthCheck(second!)).toBe(true);
    expect(module.getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
  });

  it('reports no hidden continuity gap when wall and AudioContext clocks advance together', async () => {
    vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'));
    const { instance, module } = await loadContext({ clock: 'running' });
    const token = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
      { captureHiddenContinuity: true },
    );

    await vi.advanceTimersByTimeAsync(2_000);

    const requirement = module.getPendingForegroundAudioContextClockHealthCheck();
    expect(requirement?.token).toBe(token);
    expect(requirement?.getHiddenContinuityGapSeconds()).toBeCloseTo(0, 6);
  });

  it('reports the hidden continuity gap when wall time advances but AudioContext freezes', async () => {
    vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'));
    const { instance, module } = await loadContext({ clock: 'stalled' });
    const token = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
      { captureHiddenContinuity: true },
    );

    await vi.advanceTimersByTimeAsync(2_000);

    const requirement = module.getPendingForegroundAudioContextClockHealthCheck();
    expect(requirement?.token).toBe(token);
    expect(requirement?.getHiddenContinuityGapSeconds()).toBeCloseTo(2, 6);
  });

  it('prepares and confirms an identity-less foreground restart only after clock health', async () => {
    const { instance, module } = await loadContext({ clock: 'running' });
    const checkToken = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );

    const preparation = await module.prepareForegroundAudioContextRestart(checkToken!);
    expect(preparation).toMatchObject({ status: 'prepared' });
    expect(instance.state).toBe('suspended');
    expect(preparation?.isCurrent()).toBe(true);

    await expect(
      module.resumePreparedForegroundAudioContextRestartFromGesture(preparation!.attemptToken),
    ).resolves.toEqual({ running: true, requiresClockVerification: true });
    const requirement = module.getPendingForegroundAudioContextRestartClockHealthRequirement();
    expect(requirement?.attemptToken).toBe(preparation?.attemptToken);
    expect(requirement?.isCurrent()).toBe(true);
    const health = module.probeAudioContextHealth({
      attemptResume: false,
      context: requirement!.context,
      isCurrent: requirement!.isCurrent,
    });
    await vi.advanceTimersByTimeAsync(180);
    await expect(health).resolves.toMatchObject({ healthy: true, reason: 'healthy' });
    expect(module.confirmForegroundAudioContextRestartHealth(preparation!.attemptToken)).toBe(true);
    expect(module.getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
  });

  it('prepares a generic restart for a tokenless PLAY clock stall', async () => {
    const { instance, module } = await loadContext({ clock: 'stalled' });

    const preparation = await module.prepareForegroundAudioContextRestartAfterClockStall(
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

    const pending = module.prepareForegroundAudioContextRestartAfterClockStall(
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

    const pending = module.prepareForegroundAudioContextRestartAfterClockStall(
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

    const pending = module.prepareForegroundAudioContextRestartAfterClockStall(
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
    const pending = module.prepareForegroundAudioContextRestartAfterClockStall(
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
    const preparing = module.prepareForegroundAudioContextRestart(checkToken!);
    await vi.advanceTimersByTimeAsync(500);
    const preparation = await preparing;

    expect(preparation).toMatchObject({ status: 'preparing' });
    await expect(
      module.resumePreparedForegroundAudioContextRestartFromGesture(preparation!.attemptToken),
    ).resolves.toEqual({ running: false, requiresClockVerification: false });
    expect(instance.resume).not.toHaveBeenCalled();

    instance.dispatchState('suspended');
    await expect(preparation!.whenPrepared).resolves.toBe(true);
    await expect(
      module.resumePreparedForegroundAudioContextRestartFromGesture(preparation!.attemptToken),
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
    const preparation = await module.prepareForegroundAudioContextRestart(checkToken!);
    let finishResume: (() => void) | undefined;
    instance.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishResume = resolve;
        }),
    );

    const gesture = module.resumePreparedForegroundAudioContextRestartFromGesture(
      preparation!.attemptToken,
    );
    await vi.advanceTimersByTimeAsync(750);
    await expect(gesture).resolves.toEqual({
      running: false,
      requiresClockVerification: false,
    });
    expect(module.getPendingForegroundAudioContextRestartClockHealthRequirement()).toBeNull();

    instance.dispatchState('running');
    finishResume?.();
    await Promise.resolve();
    const requirement = module.getPendingForegroundAudioContextRestartClockHealthRequirement();
    expect(requirement?.attemptToken).toBe(preparation?.attemptToken);
    expect(requirement?.isCurrent()).toBe(true);
  });

  it('keeps a retired late gesture resume inert against a successor restart', async () => {
    const { instance, module } = await loadContext({ clock: 'running' });
    const firstCheck = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const first = await module.prepareForegroundAudioContextRestart(firstCheck!);
    let finishFirstResume: (() => void) | undefined;
    instance.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirstResume = resolve;
        }),
    );
    const firstGesture = module.resumePreparedForegroundAudioContextRestartFromGesture(
      first!.attemptToken,
    );
    await vi.advanceTimersByTimeAsync(750);
    await firstGesture;

    const secondCheck = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const second = await module.prepareForegroundAudioContextRestart(secondCheck!);
    instance.dispatchState('running');
    finishFirstResume?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(module.getPendingForegroundAudioContextRestartClockHealthRequirement()).toBeNull();
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
    const firstPreparing = module.prepareForegroundAudioContextRestart(firstCheck!);
    await vi.advanceTimersByTimeAsync(500);
    const first = await firstPreparing;

    const secondCheck = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const secondPreparing = module.prepareForegroundAudioContextRestart(secondCheck!);
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
    const firstPreparing = module.prepareForegroundAudioContextRestart(firstCheck!);
    await vi.advanceTimersByTimeAsync(500);
    const first = await firstPreparing;
    expect(first?.status).toBe('preparing');
    expect(instance.suspend).toHaveBeenCalledOnce();

    const secondCheck = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const secondPreparing = module.prepareForegroundAudioContextRestart(secondCheck!);
    await vi.advanceTimersByTimeAsync(100);
    instance.dispatchState('suspended');
    await Promise.resolve();
    await Promise.resolve();

    expect(instance.resume).not.toHaveBeenCalled();
    expect(instance.suspend).toHaveBeenCalledOnce();
    await expect(first!.whenPrepared).resolves.toBe(false);
    expect(module.getPendingForegroundAudioContextRestartClockHealthRequirement()).toBeNull();

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
    const firstPreparing = module.prepareForegroundAudioContextRestart(checkToken!);
    await vi.advanceTimersByTimeAsync(500);
    const first = await firstPreparing;
    expect(first?.status).toBe('preparing');

    const retry = module.prepareForegroundAudioContextRestart(checkToken!);
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
    const checkToken = module.armForegroundAudioContextClockHealthCheck(
      instance as unknown as AudioContext,
    );
    const preparing = module.prepareForegroundAudioContextRestart(checkToken!);
    await vi.advanceTimersByTimeAsync(500);
    const preparation = await preparing;
    expect(preparation?.status).toBe('preparing');

    expect(module.consumeForegroundAudioContextClockHealthCheck(checkToken!)).toBe(true);
    instance.dispatchState('suspended');
    await Promise.resolve();

    expect(instance.resume).toHaveBeenCalledOnce();
    expect(instance.state).toBe('running');
    await expect(preparation!.whenPrepared).resolves.toBe(false);
  });
});
