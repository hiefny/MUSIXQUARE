/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { PLAYBACK_STATE } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import { newLoadEpoch, setCurrentAudioBuffer } from '../../player/_state.ts';
import { AUDIO_CLOCK_SAMPLE_MS } from '../context-protocol.ts';
import {
  armPendingAudioContextRecoveryFromBackground,
  beginPendingInterruptionRecoveryFromGesture,
  bindAudioContextInterruptionRecovery,
  checkForegroundClockBeforeFileStart,
  consumeForegroundAudioContextClockHealthCheck,
  finishPendingInterruptionRecoveryFromGesture,
  getPendingAudioContextInterruptionAttempt,
  getPendingAudioContextRecoveryAttemptForHealth,
  getPendingForegroundAudioContextClockHealthCheck,
  hasPendingAudioContextInterruption,
  isAudioContextInterruptionAttemptCurrent,
  ownerSubStepsForTests,
  retireAudioContextRecoveryAttempt,
} from '../context-recovery.ts';

const { requestRetiredAudioContextSuspendCleanup } = ownerSubStepsForTests;

/**
 * A gesture caller that still acts and whose resume reached running: the
 * owner's second step then observes, probes this exact attempt's clock (one
 * 180 ms sample when it runs) and escalates or commits (Phase 7 7C-1).
 */
const CURRENT_CALLER = { running: true, isCurrent: (): boolean => true };

/** That second step on fake timers: its 180 ms clock sample, then its outcome. */
async function finishOnFakeClock(attempt: object) {
  const finished = finishPendingInterruptionRecoveryFromGesture(attempt, CURRENT_CALLER);
  await vi.advanceTimersByTimeAsync(180);
  return finished;
}

class FakeAudioContext {
  state = 'running';
  clock: 'running' | 'stalled' = 'running';
  private readonly clockStartedAt = performance.now();
  readonly resume = vi.fn(async (): Promise<void> => undefined);
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

/**
 * The page returns from the background: the binding arms the foreground
 * incident on the hidden edge. Returns that incident's token.
 */
function returnToForeground(): object | undefined {
  for (const value of ['hidden', 'visible']) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  }
  return getPendingForegroundAudioContextClockHealthCheck()?.token;
}

/**
 * A local-file PLAY's clock check after that return (Phase 7 7C-3) finds the
 * clock frozen and prepares the play-request restart; the clock runs again
 * once the check has answered. Resolves with the preparation, or null.
 */
function prepareOnFrozenClock(context: FakeAudioContext) {
  context.clock = 'stalled';
  const verdict = checkForegroundClockBeforeFileStart({ isCurrent: () => true });
  return Promise.resolve(verdict).then((answer) => {
    context.clock = 'running';
    return answer?.kind === 'clock-stalled' ? answer.preparation : null;
  });
}

describe('AudioContext interruption recovery', () => {
  it.each(['reject', 'timeout'] as const)(
    'offers one demo gesture recovery after automatic resume %s',
    async (failure) => {
      vi.useFakeTimers();
      let dispose: (() => void) | undefined;
      try {
        markActiveFileRoom();
        setState('demo.active', true);
        setState('demo.currentTrackIndex', 0);
        setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
        const context = new FakeAudioContext();
        if (failure === 'reject') context.resume.mockRejectedValue(new Error('Gesture required'));
        else context.resume.mockImplementation(() => new Promise<void>(() => undefined));
        const recoveryNeeded = vi.fn();
        bus.on('audio:output-recovery-needed', recoveryNeeded);
        dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
        context.dispatchState('suspended');
        await vi.advanceTimersByTimeAsync(751);
        expect(recoveryNeeded).toHaveBeenCalledOnce();
        expect(recoveryNeeded).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'background-resume',
            reason: 'context-not-running',
            queueItemId: null,
          }),
        );
        const request = recoveryNeeded.mock.calls[0]![0] as { isCurrent: () => boolean };
        expect(request.isCurrent()).toBe(true);
        newLoadEpoch();
        expect(request.isCurrent()).toBe(false);
      } finally {
        dispose?.();
        setCurrentAudioBuffer(null);
        vi.useRealTimers();
      }
    },
  );

  it('does not rejoin a replacement demo buffer when an old native resume settles', async () => {
    vi.useFakeTimers();
    let dispose: (() => void) | undefined;
    try {
      markActiveFileRoom();
      setState('demo.active', true);
      setState('demo.currentTrackIndex', 0);
      setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      const context = new FakeAudioContext();
      let resolveResume!: () => void;
      context.resume.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveResume = resolve;
          }),
      );
      const rejoin = vi.fn();
      const recoveryNeeded = vi.fn();
      bus.on('playback:local-output-rejoin', rejoin);
      bus.on('audio:output-recovery-needed', recoveryNeeded);
      dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
      context.dispatchState('suspended');
      setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      expect(getPendingAudioContextRecoveryAttemptForHealth()).toBeNull();
      context.state = 'running';
      resolveResume();
      await vi.advanceTimersByTimeAsync(1000);
      expect(rejoin).not.toHaveBeenCalled();
      expect(recoveryNeeded).not.toHaveBeenCalled();
    } finally {
      dispose?.();
      setCurrentAudioBuffer(null);
      vi.useRealTimers();
    }
  });

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

    await expect(beginPendingInterruptionRecoveryFromGesture()).resolves.toEqual({
      running: true,
      rejoinEmitted: false,
    });
    expect(context.resume).toHaveBeenCalledOnce();
    expect(rejoin).not.toHaveBeenCalled();
    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt!, CURRENT_CALLER),
    ).resolves.toEqual({ kind: 'recovered', rejoinEmitted: true });
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
    await vi.waitFor(() => expect(getPendingAudioContextRecoveryAttemptForHealth()).not.toBeNull());
    expect(rejoin).not.toHaveBeenCalled();
    const attempt = getPendingAudioContextRecoveryAttemptForHealth()!;
    // The owner's own clock check (its automatic resume promoted the attempt)
    // commits it once the clock is proven; no caller step confirms it.
    await vi.waitFor(() => expect(hasPendingAudioContextInterruption()).toBe(false));
    expect(isAudioContextInterruptionAttemptCurrent(attempt)).toBe(true);
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
    // The automatic resume is refused, so the PLAY's own resume brings the
    // context back and no automatic clock check races the PLAY's.
    context.resume.mockRejectedValueOnce(new Error('autoplay blocked'));

    context.dispatchState('suspended');
    await vi.waitFor(() => expect(getPendingAudioContextInterruptionAttempt()).not.toBeNull());
    const attempt = getPendingAudioContextInterruptionAttempt()!;
    // The PLAY's resume reaches running, but the clock stays frozen.
    context.clock = 'stalled';
    await expect(beginPendingInterruptionRecoveryFromGesture()).resolves.toMatchObject({
      running: true,
    });
    await expect(finishPendingInterruptionRecoveryFromGesture({}, CURRENT_CALLER)).resolves.toEqual(
      { kind: 'superseded' },
    );
    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt, CURRENT_CALLER),
    ).resolves.toEqual({ kind: 'escalated', escalation: 'prepared' });

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
    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt, CURRENT_CALLER),
    ).resolves.toEqual({ kind: 'superseded' });

    // The next gesture's resume brings a running clock.
    context.clock = 'running';
    await beginPendingInterruptionRecoveryFromGesture();
    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt, CURRENT_CALLER),
    ).resolves.toEqual({ kind: 'recovered', rejoinEmitted: true });
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
      // A PLAY's clock check finds the running clock frozen (two samples).
      context.clock = 'stalled';
      const escalation = finishPendingInterruptionRecoveryFromGesture(attempt!, CURRENT_CALLER);
      await vi.advanceTimersByTimeAsync(360 + 500);

      await expect(escalation).resolves.toEqual({ kind: 'escalated', escalation: 'preparing' });
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
    const checkToken = returnToForeground();

    const preparation = await prepareOnFrozenClock(context);

    expect(preparation?.status).toBe('prepared');
    expect(context.resume).not.toHaveBeenCalled();
    expect(context.state).toBe('suspended');
    consumeForegroundAudioContextClockHealthCheck(checkToken!);
    dispose();
  });

  it('keeps a prepared foreground restart token across a second hidden transition', async () => {
    const context = new FakeAudioContext();
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
    const checkToken = returnToForeground();
    const preparation = await prepareOnFrozenClock(context);

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
      await expect(
        finishPendingInterruptionRecoveryFromGesture(semanticAttempt!, CURRENT_CALLER),
      ).resolves.toEqual({ kind: 'superseded' });
      await expect(beginPendingInterruptionRecoveryFromGesture()).resolves.toMatchObject({
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
      // A PLAY in the same task as the return. Since Phase 7 7C-1 its commit
      // follows its own clock check, which starts here, before the owner's
      // automatic one (the hidden resume's settlement starts that).
      const attempt = getPendingAudioContextRecoveryAttemptForHealth();
      const resumed = beginPendingInterruptionRecoveryFromGesture();
      const played = finishPendingInterruptionRecoveryFromGesture(attempt!, CURRENT_CALLER);
      await vi.advanceTimersByTimeAsync(0);

      expect(getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
      expect(attempt !== null && isAudioContextInterruptionAttemptCurrent(attempt)).toBe(true);
      await expect(resumed).resolves.toMatchObject({
        running: true,
        rejoinEmitted: false,
      });
      await vi.advanceTimersByTimeAsync(180);
      await expect(played).resolves.toMatchObject({
        kind: 'recovered',
        rejoinEmitted: true,
      });
      expect(rejoin).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(180);
      expect(rejoin).toHaveBeenCalledOnce();
      expect(getPendingAudioContextRecoveryAttemptForHealth()).toBeNull();
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

    await expect(beginPendingInterruptionRecoveryFromGesture()).resolves.toEqual({
      running: true,
      rejoinEmitted: false,
    });

    const attempt = getPendingAudioContextRecoveryAttemptForHealth();
    expect(attempt !== null && isAudioContextInterruptionAttemptCurrent(attempt)).toBe(true);
    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt!, CURRENT_CALLER),
    ).resolves.toMatchObject({ kind: 'recovered', rejoinEmitted: true });

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
    // Its clock requirement is not current (another queue occurrence plays),
    // so a gesture's recovery commits nothing; its checks run at the call.
    const finished = finishPendingInterruptionRecoveryFromGesture(attempt!, CURRENT_CALLER);
    expect(retireAudioContextRecoveryAttempt(attempt!)).toBe(true);
    expect(hasPendingAudioContextInterruption()).toBe(false);
    await expect(finished).resolves.toEqual({ kind: 'superseded' });
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

    await expect(beginPendingInterruptionRecoveryFromGesture()).resolves.toEqual({
      running: true,
      rejoinEmitted: false,
    });
    const attempt = getPendingAudioContextRecoveryAttemptForHealth();
    expect(attempt).toBeTypeOf('object');
    // Its clock requirement is not current (the playback identity changed),
    // so the owner answers before any clock probe: a frozen clock is neither
    // probed nor escalated.
    context.clock = 'stalled';
    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt!, CURRENT_CALLER),
    ).resolves.toEqual({ kind: 'superseded' });
    expect(retireAudioContextRecoveryAttempt(attempt!)).toBe(true);
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
    const result = beginPendingInterruptionRecoveryFromGesture();
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledTimes(2));

    context.state = 'running';
    dispose();
    finishGestureResume?.();

    await expect(result).resolves.toEqual({
      running: true,
      rejoinEmitted: false,
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
      const firstGesture = beginPendingInterruptionRecoveryFromGesture();
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

      await beginPendingInterruptionRecoveryFromGesture();
      await expect(finishOnFakeClock(successorAttempt!)).resolves.toMatchObject({
        kind: 'recovered',
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
      await expect(beginPendingInterruptionRecoveryFromGesture()).resolves.toMatchObject({
        running: false,
      });
      expect(context.resume).not.toHaveBeenCalled();

      context.dispatchState('suspended');
      const preparedAttempt = getPendingAudioContextInterruptionAttempt();
      expect(preparedAttempt).toBe(preparingAttempt);
      expect(recoveryNeeded).toHaveBeenCalledOnce();

      await expect(beginPendingInterruptionRecoveryFromGesture()).resolves.toMatchObject({
        running: true,
        rejoinEmitted: false,
      });
      await expect(finishOnFakeClock(preparedAttempt!)).resolves.toMatchObject({
        kind: 'recovered',
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

      await beginPendingInterruptionRecoveryFromGesture();
      await expect(finishOnFakeClock(secondAttempt!)).resolves.toMatchObject({
        kind: 'recovered',
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

      await expect(beginPendingInterruptionRecoveryFromGesture()).resolves.toMatchObject({
        running: true,
        rejoinEmitted: false,
      });
      await expect(finishOnFakeClock(attempt!)).resolves.toMatchObject({
        kind: 'recovered',
        rejoinEmitted: true,
      });
      expect(context.suspend).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a resolved-running stalled suspend with the same exact attempt after the late fence', async () => {
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
      // Phase 7 7B-4 (owner answer Q6): the second suspend waits for the
      // 250 ms late fence after the 750 ms watchdog, as the play-request
      // restart's does, so it comes at 1,000 ms (before: at once at 750 ms).
      await vi.advanceTimersByTimeAsync(760);
      expect(context.suspend).toHaveBeenCalledOnce();
      expect(getPendingAudioContextInterruptionAttempt()).toBeNull();
      expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(true);
      await vi.advanceTimersByTimeAsync(250);

      await expect(arm).resolves.toBeNull();
      expect(context.suspend).toHaveBeenCalledTimes(2);
      expect(context.state).toBe('suspended');
      expect(getPendingAudioContextInterruptionAttempt()).toBe(attempt);
      expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(true);
      expect(recoveryNeeded).toHaveBeenCalledOnce();

      await beginPendingInterruptionRecoveryFromGesture();
      await expect(finishOnFakeClock(attempt!)).resolves.toMatchObject({
        kind: 'recovered',
        rejoinEmitted: true,
      });
      expect(rejoin).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a never-settling stalled suspend with the same exact attempt after the late fence', async () => {
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
      // Phase 7 7B-4 (owner answer Q6): as above, the second suspend comes
      // after the late fence at 1,000 ms (before: at 750 ms).
      await vi.advanceTimersByTimeAsync(760);
      expect(context.suspend).toHaveBeenCalledOnce();
      expect(getPendingAudioContextInterruptionAttempt()).toBeNull();
      expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(true);
      await vi.advanceTimersByTimeAsync(250);

      await expect(arm).resolves.toBeNull();
      expect(context.suspend).toHaveBeenCalledTimes(2);
      expect(context.state).toBe('suspended');
      expect(getPendingAudioContextInterruptionAttempt()).toBe(attempt);
      expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(true);
      expect(recoveryNeeded).toHaveBeenCalledOnce();

      await beginPendingInterruptionRecoveryFromGesture();
      await expect(finishOnFakeClock(attempt!)).resolves.toMatchObject({
        kind: 'recovered',
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
      // Phase 7 7B-4 (owner answer Q6): the second suspend came after the late
      // fence at 1,000 ms, so its watchdog gives up at 1,750 ms (before: the
      // second came at 750 ms and the attempt retired at 1,500 ms).
      await vi.advanceTimersByTimeAsync(1_510);
      expect(context.suspend).toHaveBeenCalledTimes(2);
      expect(isAudioContextInterruptionAttemptCurrent(attempt!)).toBe(true);
      await vi.advanceTimersByTimeAsync(250);

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

      await beginPendingInterruptionRecoveryFromGesture();
      await expect(finishOnFakeClock(successorAttempt!)).resolves.toMatchObject({
        kind: 'recovered',
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

    await beginPendingInterruptionRecoveryFromGesture();
    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt!, CURRENT_CALLER),
    ).resolves.toMatchObject({ kind: 'recovered', rejoinEmitted: true });
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

      const checkToken = returnToForeground();
      const preparing = prepareOnFrozenClock(context);
      await vi.advanceTimersByTimeAsync(2 * AUDIO_CLOCK_SAMPLE_MS + 500);
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

      await beginPendingInterruptionRecoveryFromGesture();
      await expect(finishOnFakeClock(successorAttempt!)).resolves.toMatchObject({
        kind: 'recovered',
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

    await expect(beginPendingInterruptionRecoveryFromGesture()).resolves.toEqual({
      running: false,
      rejoinEmitted: false,
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

describe("the playback scope's gesture recovery, second step (Phase 7 7C-1)", () => {
  /** A running context, its binding and a state-interruption attempt still awaiting its resume. */
  async function provisionalAttempt() {
    markActiveFileRoom();
    const context = new FakeAudioContext();
    const rejoin = vi.fn();
    const recoveryNeeded = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    bus.on('audio:output-recovery-needed', recoveryNeeded);
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);
    const attempt = await armPendingAudioContextRecoveryFromBackground(
      context as unknown as AudioContext,
      'state-interruption',
    );
    expect(attempt).toBeTypeOf('object');
    return { context, rejoin, recoveryNeeded, dispose, attempt: attempt! };
  }

  it('lets go of a resume that did not reach running without reading the caller', async () => {
    const { context, rejoin, dispose, attempt } = await provisionalAttempt();
    const isCurrent = vi.fn(() => true);

    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt, { running: false, isCurrent }),
    ).resolves.toEqual({ kind: 'not-running' });
    expect(isCurrent).not.toHaveBeenCalled();
    expect(isAudioContextInterruptionAttemptCurrent(attempt)).toBe(true);
    expect(hasPendingAudioContextInterruption('file')).toBe(true);
    expect(context.suspend).not.toHaveBeenCalled();
    expect(rejoin).not.toHaveBeenCalled();
    dispose();
  });

  it('commits nothing for a caller that is no longer current or another attempt', async () => {
    const { rejoin, dispose, attempt } = await provisionalAttempt();

    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt, {
        running: true,
        isCurrent: () => false,
      }),
    ).resolves.toEqual({ kind: 'superseded' });
    await expect(finishPendingInterruptionRecoveryFromGesture({}, CURRENT_CALLER)).resolves.toEqual(
      { kind: 'superseded' },
    );
    expect(hasPendingAudioContextInterruption('file')).toBe(true);
    expect(rejoin).not.toHaveBeenCalled();
    dispose();
  });

  it('retires an attempt a local pause made stale only for a PLAY that clears that pause', async () => {
    const { context, rejoin, dispose, attempt } = await provisionalAttempt();
    setState('playback.activity', 'paused');

    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt, {
        ...CURRENT_CALLER,
        clearsLocalPause: () => false,
      }),
    ).resolves.toEqual({ kind: 'superseded' });
    expect(isAudioContextInterruptionAttemptCurrent(attempt)).toBe(true);
    expect(getPendingForegroundAudioContextClockHealthCheck()).toBeNull();

    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt, {
        ...CURRENT_CALLER,
        clearsLocalPause: () => true,
      }),
    ).resolves.toEqual({ kind: 'stale-retired' });
    expect(isAudioContextInterruptionAttemptCurrent(attempt)).toBe(false);
    expect(hasPendingAudioContextInterruption()).toBe(false);
    // The next PLAY's clock check takes its place; the caller rejoins itself.
    expect(getPendingForegroundAudioContextClockHealthCheck()?.context).toBe(context);
    expect(rejoin).not.toHaveBeenCalled();
    dispose();
  });

  it('tells the caller the probe answer before it escalates a frozen clock', async () => {
    vi.useFakeTimers();
    try {
      const { context, rejoin, recoveryNeeded, dispose, attempt } = await provisionalAttempt();
      context.clock = 'stalled';
      const unhealthy: string[] = [];
      const finished = finishPendingInterruptionRecoveryFromGesture(attempt, {
        ...CURRENT_CALLER,
        unhealthy: (health) => {
          unhealthy.push(`${health.reason}:${context.suspend.mock.calls.length}`);
        },
      });
      await vi.advanceTimersByTimeAsync(360 + 500);

      await expect(finished).resolves.toEqual({ kind: 'escalated', escalation: 'prepared' });
      expect(unhealthy).toEqual(['clock-stalled:0']);
      expect(context.suspend).toHaveBeenCalledOnce();
      expect(getPendingAudioContextInterruptionAttempt()).toBe(attempt);
      expect(recoveryNeeded).toHaveBeenCalledOnce();
      expect(recoveryNeeded).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'clock-stalled', source: 'background-resume' }),
      );
      expect(rejoin).not.toHaveBeenCalled();
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the caller's currency after the probe: a caller gone by then escalates nothing", async () => {
    vi.useFakeTimers();
    try {
      const { context, recoveryNeeded, dispose, attempt } = await provisionalAttempt();
      context.clock = 'stalled';
      let current = true;
      const finished = finishPendingInterruptionRecoveryFromGesture(attempt, {
        running: true,
        isCurrent: () => current,
        unhealthy: () => {
          current = false;
        },
      });
      await vi.advanceTimersByTimeAsync(360 + 500);

      await expect(finished).resolves.toEqual({ kind: 'superseded' });
      expect(context.suspend).not.toHaveBeenCalled();
      expect(recoveryNeeded).not.toHaveBeenCalled();
      expect(isAudioContextInterruptionAttemptCurrent(attempt)).toBe(true);
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the attempt as it is when the probe gives no verdict', async () => {
    const { context, rejoin, dispose, attempt } = await provisionalAttempt();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const unhealthy: string[] = [];

    await expect(
      finishPendingInterruptionRecoveryFromGesture(attempt, {
        ...CURRENT_CALLER,
        unhealthy: (health) => {
          unhealthy.push(health.reason);
        },
      }),
    ).resolves.toEqual({ kind: 'unverified' });
    expect(unhealthy).toEqual(['hidden']);
    expect(isAudioContextInterruptionAttemptCurrent(attempt)).toBe(true);
    expect(hasPendingAudioContextInterruption('file')).toBe(true);
    expect(context.suspend).not.toHaveBeenCalled();
    expect(rejoin).not.toHaveBeenCalled();
    dispose();
  });

  it("only verifies a healthy clock for the dialog's failed-PLAY retry, which cancels the attempt itself (RO-37)", async () => {
    vi.useFakeTimers();
    try {
      const { rejoin, dispose, attempt } = await provisionalAttempt();
      const finished = finishPendingInterruptionRecoveryFromGesture(attempt, {
        ...CURRENT_CALLER,
        commit: false,
      });
      await vi.advanceTimersByTimeAsync(180);

      await expect(finished).resolves.toEqual({ kind: 'verified' });
      expect(rejoin).not.toHaveBeenCalled();
      expect(retireAudioContextRecoveryAttempt(attempt)).toBe(true);
      expect(hasPendingAudioContextInterruption()).toBe(false);
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
