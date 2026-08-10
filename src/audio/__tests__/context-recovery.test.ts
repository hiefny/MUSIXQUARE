/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import {
  bindAudioContextInterruptionRecovery,
  getPendingAudioContextInterruptionAttempt,
  hasPendingAudioContextInterruption,
  isAudioContextInterruptionAttemptCurrent,
  resumePendingAudioContextInterruptionFromGesture,
} from '../context-recovery.ts';

class FakeAudioContext {
  state = 'running';
  readonly resume = vi.fn(async () => undefined);
  private readonly listeners = new Set<() => void>();

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
});

function markActiveFileRoom(): void {
  setState('setup.sessionStarted', true);
  setState('playback.mode', 'file');
  setState('playback.activity', 'playing');
}

describe('AudioContext interruption recovery', () => {
  it('resumes the context and requests one local rejoin after active playback recovers', () => {
    markActiveFileRoom();
    const context = new FakeAudioContext();
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('interrupted');
    expect(context.resume).toHaveBeenCalledOnce();
    expect(rejoin).not.toHaveBeenCalled();

    context.dispatchState('running');
    expect(rejoin).toHaveBeenCalledOnce();
    expect(rejoin).toHaveBeenCalledWith({
      reason: 'audio-context-recovered',
      mode: 'file',
    });
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
      rejoinEmitted: true,
      fallbackEligible: false,
    });

    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(hasPendingAudioContextInterruption()).toBe(false);
    expect(rejoin).toHaveBeenCalledOnce();
  });

  it('fences a recovered interruption to the room and queue occurrence that armed it', () => {
    markActiveFileRoom();
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
    const context = new FakeAudioContext();
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('interrupted');
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
    context.dispatchState('running');

    expect(rejoin).not.toHaveBeenCalled();
    expect(hasPendingAudioContextInterruption()).toBe(false);
  });

  it('resumes the shared context after a mode change without rejoining the stale identity', async () => {
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
      fallbackEligible: true,
    });
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
