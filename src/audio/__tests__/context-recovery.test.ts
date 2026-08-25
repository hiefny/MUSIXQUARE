/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { PLAYBACK_STATE } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import {
  armForegroundAudioContextClockHealthCheck,
  consumeForegroundAudioContextClockHealthCheck,
  getPendingForegroundAudioContextClockHealthCheck,
  prepareForegroundAudioContextRestart,
  requestRetiredAudioContextSuspendCleanup,
} from '../context.ts';
import {
  armPendingAudioContextRecoveryFromBackground,
  bindAudioContextInterruptionRecovery,
  cancelPendingAudioContextRecovery,
  confirmPendingAudioContextRecoveryHealth,
  escalatePendingAudioContextRecoveryToClockStalled,
  getPendingAudioContextClockHealthRequirement,
  getPendingAudioContextInterruptionAttempt,
  getPendingAudioContextRecoveryAttemptForHealth,
  hasPendingAudioContextInterruption,
  isAudioContextInterruptionAttemptCurrent,
  resumePendingAudioContextInterruptionFromGesture,
} from '../context-recovery.ts';

class FakeAudioContext {
  state = 'running';
  clock: 'running' | 'stalled' = 'running';
  private readonly clockStartedAt = performance.now();
  readonly resume = vi.fn(async () => undefined);
  readonly suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  private readonly listeners = new Set<() => void>();

  get currentTime(): number {
    return this.clock === 'running' ? (performance.now() - this.clockStartedAt) / 1_000 : 4;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.listeners.delete(listener);
  }

  dispatchState(state: string): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

beforeEach(() => {
  resetState();
  bus.clear();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  const foreground = getPendingForegroundAudioContextClockHealthCheck();
  if (foreground) consumeForegroundAudioContextClockHealthCheck(foreground.token);
});

function markActiveFileRoom(): void {
  setState('setup.sessionStarted', true);
  setState('playback.mode', 'file');
  setState('playback.activity', 'playing');
  setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
}

describe('AudioContext interruption recovery', () => {
  it('turns a running-but-frozen background clock into one identity-fenced gesture rejoin', async () => {
    markActiveFileRoom();
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
    const context = new FakeAudioContext();
    context.resume.mockImplementation(async () => {
      context.state = 'running';
    });
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    const attempt = await armPendingAudioContextRecoveryFromBackground(
      context as unknown as AudioContext,
    );
    expect(attempt).toBeTypeOf('object');
    expect(context.suspend).toHaveBeenCalledOnce();
    expect(context.state).toBe('suspended');
    expect(hasPendingAudioContextInterruption('file')).toBe(true);

    await expect(resumePendingAudioContextInterruptionFromGesture()).resolves.toEqual({
      running: true,
      rejoinEmitted: false,
      fallbackEligible: false,
    });
    expect(context.resume).toHaveBeenCalledOnce();
    expect(rejoin).not.toHaveBeenCalled();
    expect(confirmPendingAudioContextRecoveryHealth(attempt!)).toEqual({
      running: true,
      rejoinEmitted: true,
      fallbackEligible: false,
    });
    expect(rejoin).toHaveBeenCalledOnce();
    expect(rejoin).toHaveBeenCalledWith({
      reason: 'audio-context-recovered',
      mode: 'file',
    });
  });

  it('best-effort resumes an active file while hidden but defers proof and rejoin', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      context.resume.mockImplementation(async () => {
        context.state = 'running';
      });
      const rejoin = vi.fn();
      bus.on('playback:local-output-rejoin', rejoin);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });

      context.dispatchState('suspended');
      expect(context.resume).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(hasPendingAudioContextInterruption('file')).toBe(true);
      expect(rejoin).not.toHaveBeenCalled();

      // The native resume is the only hidden operation. Clock sampling and
      // semantic local-output rejoin begin after the foreground transition.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(rejoin).not.toHaveBeenCalled();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(180);

      expect(rejoin).toHaveBeenCalledOnce();
      expect(rejoin).toHaveBeenCalledWith({
        reason: 'audio-context-recovered',
        mode: 'file',
      });

      // Duplicate foreground notifications belong to the same visibility
      // occurrence and must not resume or rebuild output a second time.
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(360);
      expect(context.resume).toHaveBeenCalledOnce();
      expect(rejoin).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries in foreground when the hidden native resume flight never settles', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      context.resume
        .mockImplementationOnce(() => new Promise<undefined>(() => undefined))
        .mockImplementationOnce(async () => {
          context.state = 'running';
        });
      const rejoin = vi.fn();
      bus.on('playback:local-output-rejoin', rejoin);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });

      context.dispatchState('suspended');
      expect(context.resume).toHaveBeenCalledOnce();

      // Foreground arrives while the hidden resume Promise still owns the
      // automatic-resuming phase. Its bounded deadline must hand recovery
      // back to the visible path instead of leaving PLAY permanently queued.
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(context.resume).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(750);
      expect(context.resume).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(180);

      expect(context.state).toBe('running');
      expect(rejoin).toHaveBeenCalledOnce();
      expect(hasPendingAudioContextInterruption()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an automatic state recovery provisional until its clock is confirmed', async () => {
    markActiveFileRoom();
    const context = new FakeAudioContext();
    context.resume.mockImplementation(async () => {
      context.state = 'running';
    });
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('interrupted');
    expect(context.resume).toHaveBeenCalledOnce();
    expect(rejoin).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(getPendingAudioContextClockHealthRequirement()).not.toBeNull());
    expect(rejoin).not.toHaveBeenCalled();
    const attempt = getPendingAudioContextClockHealthRequirement()!.attemptToken;
    expect(confirmPendingAudioContextRecoveryHealth(attempt)).toMatchObject({
      running: true,
      rejoinEmitted: true,
    });
    expect(rejoin).toHaveBeenCalledOnce();
    expect(rejoin).toHaveBeenCalledWith({
      reason: 'audio-context-recovered',
      mode: 'file',
    });
  });

  it('escalates only the exact provisional PLAY probe into prepared stalled recovery', async () => {
    markActiveFileRoom();
    const context = new FakeAudioContext();
    context.resume.mockImplementation(async () => {
      context.state = 'running';
    });
    const recoveryNeeded = vi.fn();
    const rejoin = vi.fn();
    bus.on('audio:output-recovery-needed', recoveryNeeded);
    bus.on('playback:local-output-rejoin', rejoin);
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('suspended');
    await vi.waitFor(() => expect(getPendingAudioContextClockHealthRequirement()).not.toBeNull());
    const attempt = getPendingAudioContextClockHealthRequirement()!.attemptToken;
    await expect(escalatePendingAudioContextRecoveryToClockStalled({})).resolves.toBe('rejected');
    await expect(escalatePendingAudioContextRecoveryToClockStalled(attempt)).resolves.toBe(
      'prepared',
    );

    expect(context.suspend).toHaveBeenCalledOnce();
    expect(context.state).toBe('suspended');
    expect(getPendingAudioContextInterruptionAttempt()).toBe(attempt);
    expect(recoveryNeeded).toHaveBeenCalledOnce();
    expect(recoveryNeeded).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'clock-stalled',
        source: 'background-resume',
      }),
    );
    const preparedRequest = recoveryNeeded.mock.calls[0]![0] as { isCurrent: () => boolean };
    expect(preparedRequest.isCurrent()).toBe(true);
    expect(confirmPendingAudioContextRecoveryHealth(attempt)).toMatchObject({ running: false });

    await resumePendingAudioContextInterruptionFromGesture();
    expect(confirmPendingAudioContextRecoveryHealth(attempt)).toMatchObject({
      running: true,
      rejoinEmitted: true,
    });
    expect(rejoin).toHaveBeenCalledOnce();
  });

  it('reports a slow exact escalation as preparing until native suspension arrives', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      context.suspend.mockImplementation(() => new Promise<void>(() => undefined));
      const recoveryNeeded = vi.fn();
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const attempt = await armPendingAudioContextRecoveryFromBackground(
        context as unknown as AudioContext,
        'state-interruption',
      );
      expect(getPendingAudioContextClockHealthRequirement()?.attemptToken).toBe(attempt);
      const escalation = escalatePendingAudioContextRecoveryToClockStalled(attempt!);
      await vi.advanceTimersByTimeAsync(500);

      await expect(escalation).resolves.toBe('preparing');
      expect(getPendingAudioContextInterruptionAttempt()).toBeNull();
      expect(recoveryNeeded).not.toHaveBeenCalled();

      context.dispatchState('suspended');
      expect(getPendingAudioContextInterruptionAttempt()).toBe(attempt);
      expect(recoveryNeeded).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not arm recovery for initial suspension outside an active room', () => {
    const context = new FakeAudioContext();
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('suspended');
    markActiveFileRoom();
    context.dispatchState('running');

    expect(context.resume).toHaveBeenCalledOnce();
    expect(rejoin).not.toHaveBeenCalled();
  });

  it('contains a rejected best-effort resume outside active playback', async () => {
    const context = new FakeAudioContext();
    context.resume.mockRejectedValueOnce(new Error('native resume rejected'));
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('suspended');
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledOnce());

    expect(hasPendingAudioContextInterruption()).toBe(false);
    dispose();
  });

  it('never calls native resume while hidden without active playback', () => {
    const context = new FakeAudioContext();
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    context.dispatchState('suspended');

    expect(context.resume).not.toHaveBeenCalled();
    expect(getPendingAudioContextRecoveryAttemptForHealth()).toBeNull();
  });

  it('never calls native resume while hidden for non-file playback', () => {
    setState('setup.sessionStarted', true);
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    const context = new FakeAudioContext();
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    context.dispatchState('interrupted');

    expect(context.resume).not.toHaveBeenCalled();
    expect(hasPendingAudioContextInterruption('youtube')).toBe(true);
  });

  it('never calls native resume for a hidden file shadow that is not audibly playing', () => {
    markActiveFileRoom();
    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    const context = new FakeAudioContext();
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    context.dispatchState('suspended');

    expect(context.resume).not.toHaveBeenCalled();
    expect(hasPendingAudioContextInterruption('file')).toBe(true);
  });

  it('lets an earlier visible listener observe the hidden token and reuses it exactly once', () => {
    const context = new FakeAudioContext();
    let tokenSeenByEarlierListener: object | null = null;
    const earlierVisibilityListener = (): void => {
      if (document.visibilityState !== 'visible') return;
      tokenSeenByEarlierListener =
        getPendingForegroundAudioContextClockHealthCheck()?.token ?? null;
    };
    document.addEventListener('visibilitychange', earlierVisibilityListener);
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    const hiddenRequirement = getPendingForegroundAudioContextClockHealthCheck();
    expect(hiddenRequirement?.context).toBe(context);
    expect(hiddenRequirement?.isCurrent()).toBe(true);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    const requirement = getPendingForegroundAudioContextClockHealthCheck();
    expect(tokenSeenByEarlierListener).toBe(hiddenRequirement?.token);
    expect(requirement?.token).toBe(hiddenRequirement?.token);
    expect(requirement?.context).toBe(context);
    expect(requirement?.isCurrent()).toBe(true);
    expect(consumeForegroundAudioContextClockHealthCheck(requirement!.token)).toBe(true);
    expect(consumeForegroundAudioContextClockHealthCheck(requirement!.token)).toBe(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
    dispose();
    document.removeEventListener('visibilitychange', earlierVisibilityListener);
    expect(getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
  });

  it('defers a generic foreground suspend statechange to its exact leaf lease', async () => {
    const context = new FakeAudioContext();
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
    context.suspend.mockImplementation(async () => {
      context.dispatchState('suspended');
    });
    const checkToken = armForegroundAudioContextClockHealthCheck(
      context as unknown as AudioContext,
    );

    const preparation = await prepareForegroundAudioContextRestart(checkToken!);

    expect(preparation?.status).toBe('prepared');
    expect(context.resume).not.toHaveBeenCalled();
    expect(context.state).toBe('suspended');
    consumeForegroundAudioContextClockHealthCheck(checkToken!);
    dispose();
  });

  it('keeps a prepared foreground restart token across a second hidden transition', async () => {
    const context = new FakeAudioContext();
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
    const checkToken = armForegroundAudioContextClockHealthCheck(
      context as unknown as AudioContext,
    );
    const preparation = await prepareForegroundAudioContextRestart(checkToken!);

    expect(preparation?.status).toBe('prepared');
    expect(preparation?.isCurrent()).toBe(true);
    expect(context.suspend).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(getPendingForegroundAudioContextClockHealthCheck()?.token).toBe(checkToken);
    expect(preparation?.isCurrent()).toBe(true);
    expect(context.suspend).toHaveBeenCalledOnce();

    consumeForegroundAudioContextClockHealthCheck(checkToken!);
    dispose();
  });

  it('recovers an active interruption after a 999ms hidden interval without an app guard', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      context.resume.mockImplementation(async () => {
        context.state = 'running';
      });
      const rejoin = vi.fn();
      bus.on('playback:local-output-rejoin', rejoin);
      const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      context.dispatchState('suspended');
      await vi.advanceTimersByTimeAsync(999);
      expect(context.resume).toHaveBeenCalledOnce();

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(context.resume).toHaveBeenCalledOnce();
      expect(rejoin).not.toHaveBeenCalled();
      expect(getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
      const semanticAttempt = getPendingAudioContextInterruptionAttempt();
      expect(semanticAttempt).toBeTypeOf('object');
      await vi.advanceTimersByTimeAsync(180);

      expect(rejoin).toHaveBeenCalledOnce();
      expect(confirmPendingAudioContextRecoveryHealth(semanticAttempt!)).toMatchObject({
        running: false,
        rejoinEmitted: false,
      });
      await expect(resumePendingAudioContextInterruptionFromGesture()).resolves.toMatchObject({
        running: false,
        rejoinEmitted: false,
      });
      expect(rejoin).toHaveBeenCalledOnce();
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an exact PLAY confirmation win a visible automatic probe without duplicate rejoin', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      context.resume.mockImplementation(async () => {
        context.state = 'running';
      });
      const rejoin = vi.fn();
      bus.on('playback:local-output-rejoin', rejoin);
      const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      context.dispatchState('suspended');
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);

      expect(getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
      const requirement = getPendingAudioContextClockHealthRequirement();
      expect(requirement?.isCurrent()).toBe(true);
      await expect(resumePendingAudioContextInterruptionFromGesture()).resolves.toMatchObject({
        running: true,
        rejoinEmitted: false,
      });
      expect(confirmPendingAudioContextRecoveryHealth(requirement!.attemptToken)).toMatchObject({
        running: true,
        rejoinEmitted: true,
      });
      expect(rejoin).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(180);
      expect(rejoin).toHaveBeenCalledOnce();
      expect(getPendingAudioContextClockHealthRequirement()).toBeNull();
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a pending rejoin when the room pauses during interruption', () => {
    markActiveFileRoom();
    const context = new FakeAudioContext();
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('suspended');
    setState('playback.activity', 'paused');
    context.dispatchState('running');

    expect(rejoin).not.toHaveBeenCalled();
  });

  it('retains a failed automatic recovery and retries inside the next play gesture', async () => {
    markActiveFileRoom();
    const context = new FakeAudioContext();
    context.resume
      .mockRejectedValueOnce(new Error('autoplay blocked'))
      .mockImplementationOnce(async () => {
        context.state = 'running';
      });
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('suspended');
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledTimes(1));
    expect(hasPendingAudioContextInterruption('file')).toBe(true);

    await expect(resumePendingAudioContextInterruptionFromGesture()).resolves.toEqual({
      running: true,
      rejoinEmitted: false,
      fallbackEligible: false,
    });

    const requirement = getPendingAudioContextClockHealthRequirement();
    expect(requirement?.isCurrent()).toBe(true);
    expect(confirmPendingAudioContextRecoveryHealth(requirement!.attemptToken)).toMatchObject({
      rejoinEmitted: true,
    });

    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(hasPendingAudioContextInterruption()).toBe(false);
    expect(rejoin).toHaveBeenCalledOnce();
  });

  it('fences a provisional recovery to the room and queue occurrence that armed it', async () => {
    markActiveFileRoom();
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
    const context = new FakeAudioContext();
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('interrupted');
    await Promise.resolve();
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
    context.dispatchState('running');

    expect(rejoin).not.toHaveBeenCalled();
    const attempt = getPendingAudioContextRecoveryAttemptForHealth();
    expect(attempt).toBeTypeOf('object');
    expect(getPendingAudioContextClockHealthRequirement()?.isCurrent()).toBe(false);
    expect(confirmPendingAudioContextRecoveryHealth(attempt!)).toMatchObject({
      running: false,
      rejoinEmitted: false,
    });
    expect(cancelPendingAudioContextRecovery(attempt!)).toBe(true);
    expect(hasPendingAudioContextInterruption()).toBe(false);
  });

  it('does not transfer a gesture recovery after the playback identity changes', async () => {
    markActiveFileRoom();
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
    const context = new FakeAudioContext();
    context.resume
      .mockRejectedValueOnce(new Error('autoplay blocked'))
      .mockImplementationOnce(async () => {
        context.state = 'running';
      });
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('suspended');
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledOnce());
    setState('playback.mode', 'youtube');
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');

    await expect(resumePendingAudioContextInterruptionFromGesture()).resolves.toEqual({
      running: true,
      rejoinEmitted: false,
      fallbackEligible: false,
    });
    const attempt = getPendingAudioContextRecoveryAttemptForHealth();
    expect(attempt).toBeTypeOf('object');
    expect(getPendingAudioContextClockHealthRequirement()?.isCurrent()).toBe(false);
    expect(cancelPendingAudioContextRecovery(attempt!)).toBe(true);
    expect(rejoin).not.toHaveBeenCalled();
    expect(hasPendingAudioContextInterruption()).toBe(false);
  });

  it('does not transfer a late gesture recovery after its exact binding is disposed', async () => {
    markActiveFileRoom();
    const context = new FakeAudioContext();
    let finishGestureResume: (() => void) | undefined;
    const gestureResume = new Promise<undefined>((resolve) => {
      finishGestureResume = () => resolve(undefined);
    });
    context.resume
      .mockRejectedValueOnce(new Error('autoplay blocked'))
      .mockImplementationOnce(() => gestureResume);
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('suspended');
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledOnce());
    const result = resumePendingAudioContextInterruptionFromGesture();
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledTimes(2));

    context.state = 'running';
    dispose();
    finishGestureResume?.();

    await expect(result).resolves.toEqual({
      running: true,
      rejoinEmitted: false,
      fallbackEligible: false,
    });
    expect(hasPendingAudioContextInterruption()).toBe(false);
  });

  it('re-suspends a prepared successor after a retired resume settles without statechange', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
      const context = new FakeAudioContext();
      let finishFirstResume: (() => void) | undefined;
      const firstResume = new Promise<undefined>((resolve) => {
        finishFirstResume = () => {
          context.state = 'running';
          resolve(undefined);
        };
      });
      context.resume
        .mockImplementationOnce(() => firstResume)
        .mockImplementationOnce(async () => {
          context.state = 'running';
        });
      const recoveryNeeded = vi.fn();
      const rejoin = vi.fn();
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      bus.on('playback:local-output-rejoin', rejoin);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const firstAttempt = await armPendingAudioContextRecoveryFromBackground(
        context as unknown as AudioContext,
      );
      const firstGesture = resumePendingAudioContextInterruptionFromGesture();
      await vi.advanceTimersByTimeAsync(750);
      await expect(firstGesture).resolves.toMatchObject({ running: false });

      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
      const successorAttempt = await armPendingAudioContextRecoveryFromBackground(
        context as unknown as AudioContext,
      );
      expect(successorAttempt).toBeTypeOf('object');
      expect(successorAttempt).not.toBe(firstAttempt);
      expect(context.state).toBe('suspended');

      finishFirstResume?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(context.suspend).toHaveBeenCalledTimes(2);
      expect(context.state).toBe('suspended');
      expect(getPendingAudioContextInterruptionAttempt()).toBe(successorAttempt);
      expect(isAudioContextInterruptionAttemptCurrent(firstAttempt!)).toBe(false);
      expect(isAudioContextInterruptionAttemptCurrent(successorAttempt!)).toBe(true);
      expect(recoveryNeeded).toHaveBeenCalledOnce();

      await resumePendingAudioContextInterruptionFromGesture();
      expect(confirmPendingAudioContextRecoveryHealth(successorAttempt!)).toMatchObject({
        running: true,
        rejoinEmitted: true,
      });
      expect(rejoin).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes only the exact active interruption attempt and invalidates it on close', async () => {
    markActiveFileRoom();
    const context = new FakeAudioContext();
    context.resume.mockRejectedValueOnce(new Error('autoplay blocked'));
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    expect(getPendingAudioContextInterruptionAttempt()).toBeNull();
    expect(isAudioContextInterruptionAttemptCurrent({})).toBe(false);
    context.dispatchState('suspended');
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledOnce());

    const attempt = getPendingAudioContextInterruptionAttempt();
    expect(attempt).toBeTypeOf('object');
    expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(true);
    expect(isAudioContextInterruptionAttemptCurrent({})).toBe(false);

    context.dispatchState('closed');
    expect(getPendingAudioContextInterruptionAttempt()).toBeNull();
    expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(false);
    dispose();
  });

  it('promotes suspended-to-running with a frozen clock into prepared gesture recovery', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      context.clock = 'stalled';
      context.resume.mockImplementation(async () => {
        context.state = 'running';
      });
      const rejoin = vi.fn();
      const recoveryNeeded = vi.fn();
      bus.on('playback:local-output-rejoin', rejoin);
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      context.dispatchState('suspended');
      await vi.advanceTimersByTimeAsync(360);
      await vi.advanceTimersByTimeAsync(0);

      expect(rejoin).not.toHaveBeenCalled();
      expect(context.suspend).toHaveBeenCalledOnce();
      expect(context.state).toBe('suspended');
      expect(getPendingAudioContextInterruptionAttempt()).toBeTypeOf('object');
      expect(recoveryNeeded).toHaveBeenCalledOnce();
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports when an automatically resumed context stops during its clock proof', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      context.resume.mockImplementation(async () => {
        context.state = 'running';
      });
      const recoveryNeeded = vi.fn();
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      context.dispatchState('suspended');
      await vi.advanceTimersByTimeAsync(0);
      expect(context.state).toBe('running');

      context.state = 'suspended';
      await vi.advanceTimersByTimeAsync(180);

      expect(recoveryNeeded).toHaveBeenCalledOnce();
      expect(recoveryNeeded).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'context-not-running',
          source: 'background-resume',
        }),
      );
      const request = recoveryNeeded.mock.calls[0]![0] as { isCurrent: () => boolean };
      expect(request.isCurrent()).toBe(true);
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a rejected native suspend without exposing gesture recovery', async () => {
    markActiveFileRoom();
    const context = new FakeAudioContext();
    context.suspend.mockRejectedValueOnce(new Error('native suspend rejected'));
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    await expect(
      armPendingAudioContextRecoveryFromBackground(context as unknown as AudioContext),
    ).resolves.toBeNull();

    expect(context.suspend).toHaveBeenCalledOnce();
    expect(hasPendingAudioContextInterruption()).toBe(false);
    dispose();
  });

  it('does not expose gesture recovery before a timed-out native suspend lands', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      let finishSuspend: (() => void) | undefined;
      context.suspend.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishSuspend = resolve;
          }),
      );
      context.resume.mockImplementation(async () => {
        context.state = 'running';
      });
      const recoveryNeeded = vi.fn();
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const arm = armPendingAudioContextRecoveryFromBackground(context as unknown as AudioContext);
      const preparingAttempt = getPendingAudioContextRecoveryAttemptForHealth();
      await vi.advanceTimersByTimeAsync(500);

      await expect(arm).resolves.toBeNull();
      expect(preparingAttempt).toBeTypeOf('object');
      expect(getPendingAudioContextInterruptionAttempt()).toBeNull();
      await expect(resumePendingAudioContextInterruptionFromGesture()).resolves.toMatchObject({
        running: false,
      });
      expect(context.resume).not.toHaveBeenCalled();

      context.dispatchState('suspended');
      const preparedAttempt = getPendingAudioContextInterruptionAttempt();
      expect(preparedAttempt).toBe(preparingAttempt);
      expect(recoveryNeeded).toHaveBeenCalledOnce();

      await expect(resumePendingAudioContextInterruptionFromGesture()).resolves.toMatchObject({
        running: true,
        rejoinEmitted: false,
      });
      expect(confirmPendingAudioContextRecoveryHealth(preparedAttempt!)).toMatchObject({
        rejoinEmitted: true,
      });
      finishSuspend?.();
      await Promise.resolve();
      expect(context.state).toBe('running');
      expect(context.suspend).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands one late suspend lease only to the newest queue identity', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
      const context = new FakeAudioContext();
      let finishSuspend: (() => void) | undefined;
      context.suspend.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishSuspend = resolve;
          }),
      );
      context.resume.mockImplementation(async () => {
        context.state = 'running';
      });
      const recoveryNeeded = vi.fn();
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const firstArm = armPendingAudioContextRecoveryFromBackground(
        context as unknown as AudioContext,
      );
      const firstAttempt = getPendingAudioContextRecoveryAttemptForHealth();
      await vi.advanceTimersByTimeAsync(500);
      await expect(firstArm).resolves.toBeNull();

      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
      const secondArm = armPendingAudioContextRecoveryFromBackground(
        context as unknown as AudioContext,
      );
      const secondAttempt = getPendingAudioContextRecoveryAttemptForHealth();
      expect(secondAttempt).not.toBe(firstAttempt);
      expect(context.suspend).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(500);
      await expect(secondArm).resolves.toBeNull();

      context.dispatchState('suspended');
      expect(getPendingAudioContextInterruptionAttempt()).toBe(secondAttempt);
      expect(isAudioContextInterruptionAttemptCurrent(firstAttempt!)).toBe(false);
      expect(isAudioContextInterruptionAttemptCurrent(secondAttempt!)).toBe(true);
      expect(recoveryNeeded).toHaveBeenCalledOnce();

      await resumePendingAudioContextInterruptionFromGesture();
      expect(confirmPendingAudioContextRecoveryHealth(secondAttempt!)).toMatchObject({
        rejoinEmitted: true,
      });
      finishSuspend?.();
      await Promise.resolve();
      expect(context.state).toBe('running');
      expect(context.suspend).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a resolved-running suspend fenced until its late native state arrives', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      context.suspend.mockResolvedValue(undefined);
      context.resume.mockImplementation(async () => {
        context.state = 'running';
      });
      const recoveryNeeded = vi.fn();
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const arm = armPendingAudioContextRecoveryFromBackground(context as unknown as AudioContext);
      const attempt = getPendingAudioContextRecoveryAttemptForHealth();
      await vi.advanceTimersByTimeAsync(500);

      await expect(arm).resolves.toBeNull();
      expect(attempt).toBeTypeOf('object');
      expect(getPendingAudioContextInterruptionAttempt()).toBeNull();
      expect(hasPendingAudioContextInterruption()).toBe(true);
      expect(recoveryNeeded).not.toHaveBeenCalled();

      context.dispatchState('suspended');
      expect(getPendingAudioContextInterruptionAttempt()).toBe(attempt);
      expect(recoveryNeeded).toHaveBeenCalledOnce();
      expect(context.state).toBe('suspended');

      await expect(resumePendingAudioContextInterruptionFromGesture()).resolves.toMatchObject({
        running: true,
        rejoinEmitted: false,
      });
      expect(confirmPendingAudioContextRecoveryHealth(attempt!)).toMatchObject({
        running: true,
        rejoinEmitted: true,
      });
      expect(context.suspend).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a resolved-running stalled suspend with the same exact attempt', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      context.suspend
        .mockImplementationOnce(() => Promise.resolve())
        .mockImplementationOnce(async () => {
          context.state = 'suspended';
        });
      context.resume.mockImplementation(async () => {
        context.state = 'running';
      });
      const recoveryNeeded = vi.fn();
      const rejoin = vi.fn();
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      bus.on('playback:local-output-rejoin', rejoin);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const arm = armPendingAudioContextRecoveryFromBackground(context as unknown as AudioContext);
      const attempt = getPendingAudioContextRecoveryAttemptForHealth();
      await vi.advanceTimersByTimeAsync(750);

      await expect(arm).resolves.toBeNull();
      expect(context.suspend).toHaveBeenCalledTimes(2);
      expect(context.state).toBe('suspended');
      expect(getPendingAudioContextInterruptionAttempt()).toBe(attempt);
      expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(true);
      expect(recoveryNeeded).toHaveBeenCalledOnce();

      await resumePendingAudioContextInterruptionFromGesture();
      expect(confirmPendingAudioContextRecoveryHealth(attempt!)).toMatchObject({
        running: true,
        rejoinEmitted: true,
      });
      expect(rejoin).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a never-settling stalled suspend with the same exact attempt', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      context.suspend
        .mockImplementationOnce(() => new Promise<undefined>(() => undefined))
        .mockImplementationOnce(async () => {
          context.state = 'suspended';
        });
      context.resume.mockImplementation(async () => {
        context.state = 'running';
      });
      const recoveryNeeded = vi.fn();
      const rejoin = vi.fn();
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      bus.on('playback:local-output-rejoin', rejoin);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const arm = armPendingAudioContextRecoveryFromBackground(context as unknown as AudioContext);
      const attempt = getPendingAudioContextRecoveryAttemptForHealth();
      await vi.advanceTimersByTimeAsync(750);

      await expect(arm).resolves.toBeNull();
      expect(context.suspend).toHaveBeenCalledTimes(2);
      expect(context.state).toBe('suspended');
      expect(getPendingAudioContextInterruptionAttempt()).toBe(attempt);
      expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(true);
      expect(recoveryNeeded).toHaveBeenCalledOnce();

      await resumePendingAudioContextInterruptionFromGesture();
      expect(confirmPendingAudioContextRecoveryHealth(attempt!)).toMatchObject({
        running: true,
        rejoinEmitted: true,
      });
      expect(rejoin).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never retries a never-settling semantic lease after its identity is stale', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
      const context = new FakeAudioContext();
      context.suspend.mockImplementation(() => new Promise<undefined>(() => undefined));
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const arm = armPendingAudioContextRecoveryFromBackground(context as unknown as AudioContext);
      const attempt = getPendingAudioContextRecoveryAttemptForHealth();
      await vi.advanceTimersByTimeAsync(500);
      await expect(arm).resolves.toBeNull();
      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
      await vi.advanceTimersByTimeAsync(250);

      expect(context.suspend).toHaveBeenCalledOnce();
      expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(false);
      expect(hasPendingAudioContextInterruption()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires rather than permanently preparing after two unresolved state fences', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      const context = new FakeAudioContext();
      context.suspend.mockResolvedValue(undefined);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const arm = armPendingAudioContextRecoveryFromBackground(context as unknown as AudioContext);
      const attempt = getPendingAudioContextRecoveryAttemptForHealth();
      await vi.advanceTimersByTimeAsync(1_500);

      await expect(arm).resolves.toBeNull();
      expect(context.suspend).toHaveBeenCalledTimes(2);
      expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(false);
      expect(hasPendingAudioContextInterruption()).toBe(false);
      expect(getPendingForegroundAudioContextClockHealthCheck()?.context).toBe(context);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a resolved-running late suspend inert after its queue identity is stale', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
      const context = new FakeAudioContext();
      context.suspend.mockResolvedValue(undefined);
      context.resume.mockImplementation(async () => {
        context.state = 'running';
      });
      const recoveryNeeded = vi.fn();
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const arm = armPendingAudioContextRecoveryFromBackground(context as unknown as AudioContext);
      const attempt = getPendingAudioContextRecoveryAttemptForHealth();
      await vi.advanceTimersByTimeAsync(500);
      await expect(arm).resolves.toBeNull();

      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
      context.dispatchState('suspended');
      await Promise.resolve();

      expect(recoveryNeeded).not.toHaveBeenCalled();
      expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(false);
      expect(hasPendingAudioContextInterruption()).toBe(false);
      expect(context.resume).toHaveBeenCalledOnce();
      expect(context.state).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('adopts a semantic late suspend when cleanup rejects after a successor file starts', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
      const context = new FakeAudioContext();
      context.suspend.mockResolvedValue(undefined);
      context.resume
        .mockRejectedValueOnce(new Error('cleanup rejected'))
        .mockImplementationOnce(async () => {
          context.state = 'running';
        });
      const recoveryNeeded = vi.fn();
      const rejoin = vi.fn();
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      bus.on('playback:local-output-rejoin', rejoin);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const firstArm = armPendingAudioContextRecoveryFromBackground(
        context as unknown as AudioContext,
      );
      const firstAttempt = getPendingAudioContextRecoveryAttemptForHealth();
      await vi.advanceTimersByTimeAsync(500);
      await expect(firstArm).resolves.toBeNull();

      const successorQueueItemId = '00000000-0000-4000-8000-000000000002';
      setState('playlist.currentQueueItemId', successorQueueItemId);
      context.dispatchState('suspended');
      await vi.advanceTimersByTimeAsync(0);

      const successorAttempt = getPendingAudioContextInterruptionAttempt();
      expect(successorAttempt).toBeTypeOf('object');
      expect(successorAttempt).not.toBe(firstAttempt);
      expect(isAudioContextInterruptionAttemptCurrent(firstAttempt!)).toBe(false);
      expect(isAudioContextInterruptionAttemptCurrent(successorAttempt!)).toBe(true);
      expect(recoveryNeeded).toHaveBeenCalledOnce();
      expect(recoveryNeeded).toHaveBeenCalledWith(
        expect.objectContaining({
          queueItemId: successorQueueItemId,
          reason: 'clock-stalled',
        }),
      );
      expect(rejoin).not.toHaveBeenCalled();

      await resumePendingAudioContextInterruptionFromGesture();
      expect(confirmPendingAudioContextRecoveryHealth(successorAttempt!)).toMatchObject({
        running: true,
        rejoinEmitted: true,
      });
      expect(rejoin).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-prepares the same semantic token when cleanup resumes without statechange', async () => {
    markActiveFileRoom();
    const context = new FakeAudioContext();
    context.resume.mockImplementation(async () => {
      context.state = 'running';
    });
    const recoveryNeeded = vi.fn();
    const rejoin = vi.fn();
    bus.on('audio:output-recovery-needed', recoveryNeeded);
    bus.on('playback:local-output-rejoin', rejoin);
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    const attempt = await armPendingAudioContextRecoveryFromBackground(
      context as unknown as AudioContext,
    );
    expect(attempt).toBeTypeOf('object');
    expect(context.state).toBe('suspended');
    expect(context.suspend).toHaveBeenCalledOnce();

    requestRetiredAudioContextSuspendCleanup(context as unknown as AudioContext);
    await vi.waitFor(() => expect(context.suspend).toHaveBeenCalledTimes(2));

    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.state).toBe('suspended');
    expect(getPendingAudioContextInterruptionAttempt()).toBe(attempt);
    expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(true);
    expect(recoveryNeeded).toHaveBeenCalledOnce();

    await resumePendingAudioContextInterruptionFromGesture();
    expect(confirmPendingAudioContextRecoveryHealth(attempt!)).toMatchObject({
      running: true,
      rejoinEmitted: true,
    });
    expect(rejoin).toHaveBeenCalledOnce();
  });

  it('adopts a retired generic late suspend when cleanup hangs after a successor file starts', async () => {
    vi.useFakeTimers();
    try {
      markActiveFileRoom();
      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
      const context = new FakeAudioContext();
      context.suspend.mockResolvedValue(undefined);
      context.resume
        .mockImplementationOnce(() => new Promise<undefined>(() => undefined))
        .mockImplementationOnce(async () => {
          context.state = 'running';
        });
      const recoveryNeeded = vi.fn();
      const rejoin = vi.fn();
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      bus.on('playback:local-output-rejoin', rejoin);
      bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

      const checkToken = armForegroundAudioContextClockHealthCheck(
        context as unknown as AudioContext,
      );
      const preparing = prepareForegroundAudioContextRestart(checkToken!);
      await vi.advanceTimersByTimeAsync(500);
      const retiredPreparation = await preparing;
      expect(retiredPreparation?.status).toBe('preparing');
      expect(consumeForegroundAudioContextClockHealthCheck(checkToken!)).toBe(true);

      const successorQueueItemId = '00000000-0000-4000-8000-000000000002';
      setState('playlist.currentQueueItemId', successorQueueItemId);
      context.dispatchState('suspended');
      expect(context.resume).toHaveBeenCalledOnce();
      expect(recoveryNeeded).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);

      const successorAttempt = getPendingAudioContextInterruptionAttempt();
      expect(retiredPreparation?.isCurrent()).toBe(false);
      expect(successorAttempt).toBeTypeOf('object');
      expect(isAudioContextInterruptionAttemptCurrent(successorAttempt!)).toBe(true);
      expect(recoveryNeeded).toHaveBeenCalledOnce();
      expect(recoveryNeeded).toHaveBeenCalledWith(
        expect.objectContaining({
          queueItemId: successorQueueItemId,
          reason: 'clock-stalled',
        }),
      );
      expect(rejoin).not.toHaveBeenCalled();

      await resumePendingAudioContextInterruptionFromGesture();
      expect(confirmPendingAudioContextRecoveryHealth(successorAttempt!)).toMatchObject({
        running: true,
        rejoinEmitted: true,
      });
      expect(context.resume).toHaveBeenCalledTimes(2);
      expect(rejoin).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a non-running result when no interruption attempt is pending', async () => {
    const context = new FakeAudioContext();
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
    dispose();

    await expect(resumePendingAudioContextInterruptionFromGesture()).resolves.toEqual({
      running: false,
      rejoinEmitted: false,
      fallbackEligible: false,
    });
  });

  it('removes its listener exactly when disposed', () => {
    markActiveFileRoom();
    const context = new FakeAudioContext();
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    dispose();
    context.dispatchState('interrupted');
    context.dispatchState('running');

    expect(context.resume).not.toHaveBeenCalled();
    expect(rejoin).not.toHaveBeenCalled();
  });
});
