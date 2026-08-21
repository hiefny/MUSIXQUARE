/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';

const mocks = vi.hoisted(() => ({
  isPlayingFile: vi.fn(() => true),
  isPipelineBusy: vi.fn(() => false),
  getBuffer: vi.fn(() => ({ duration: 120 }) as AudioBuffer | null),
  getContext: vi.fn(() => ({ state: 'running' }) as AudioContext | null),
  probe: vi.fn(),
  arm: vi.fn(() => ({})),
  getPendingAttempt: vi.fn(() => null as object | null),
  getRecoveryRequirement: vi.fn(
    () =>
      null as {
        attemptToken: object;
        isCurrent: () => boolean;
      } | null,
  ),
  getForegroundRequirement: vi.fn(
    () =>
      null as {
        token: object;
        isCurrent: () => boolean;
      } | null,
  ),
  isForegroundRestartOwned: vi.fn(() => false),
  cancelPending: vi.fn(() => true),
  confirmPending: vi.fn(),
  consumeForeground: vi.fn(() => true),
}));

vi.mock('../../player/ownership.ts', () => ({
  isPlaybackPlayingFile: mocks.isPlayingFile,
}));
vi.mock('../../player/transport.ts', () => ({
  isFilePipelineBusyForPlay: mocks.isPipelineBusy,
}));
vi.mock('../../player/_state.ts', () => ({
  getCurrentAudioBuffer: mocks.getBuffer,
}));
vi.mock('../context.ts', () => ({
  consumeForegroundAudioContextClockHealthCheck: mocks.consumeForeground,
  getExistingAudioContext: mocks.getContext,
  getPendingForegroundAudioContextClockHealthCheck: mocks.getForegroundRequirement,
  isForegroundAudioContextRestartOwned: mocks.isForegroundRestartOwned,
  probeAudioContextHealth: mocks.probe,
}));
vi.mock('../context-recovery.ts', () => ({
  armPendingAudioContextRecoveryFromBackground: mocks.arm,
  getPendingAudioContextClockHealthRequirement: mocks.getRecoveryRequirement,
  getPendingAudioContextRecoveryAttemptForHealth: mocks.getPendingAttempt,
  cancelPendingAudioContextRecovery: mocks.cancelPending,
  confirmPendingAudioContextRecoveryHealth: mocks.confirmPending,
}));

import { inspectBackgroundFileOutput } from '../output-health.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';

function stageFilePlayback(): void {
  setState('setup.sessionStarted', true);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setState('files.current', {
    name: 'resume.mp3',
    indexHint: 0,
    size: 10,
    mime: 'audio/mpeg',
    queueItemId: QUEUE_ITEM_ID,
    sessionId: 1,
    blob: new File(['audio'], 'resume.mp3', { type: 'audio/mpeg' }),
  });
}

describe('background local-file output health', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
    mocks.isPlayingFile.mockReturnValue(true);
    mocks.isPipelineBusy.mockReturnValue(false);
    mocks.getBuffer.mockReturnValue({ duration: 120 } as AudioBuffer);
    mocks.getContext.mockReturnValue({ state: 'running' } as AudioContext);
    mocks.getPendingAttempt.mockReturnValue(null);
    mocks.getRecoveryRequirement.mockReturnValue(null);
    mocks.getForegroundRequirement.mockReturnValue(null);
    mocks.isForegroundRestartOwned.mockReturnValue(false);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    stageFilePlayback();
  });

  it('accepts an advancing clock without arming gesture recovery', async () => {
    mocks.probe.mockImplementation(async (options: { isCurrent: () => boolean }) => {
      expect(options.isCurrent()).toBe(true);
      return {
        healthy: true,
        reason: 'healthy',
        state: 'running',
        clockAdvanceSeconds: 0.18,
      };
    });

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'healthy',
      reason: 'healthy',
    });
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it('defers without auto-resume while a generic foreground restart owns the context', async () => {
    const context = {
      state: 'suspended',
      resume: vi.fn(async () => undefined),
    } as unknown as AudioContext;
    mocks.getContext.mockReturnValue(context);
    mocks.isForegroundRestartOwned.mockReturnValue(true);

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'stale',
      reason: 'superseded',
    });

    expect(mocks.probe).not.toHaveBeenCalled();
    expect(context.resume).not.toHaveBeenCalled();
    expect(mocks.arm).not.toHaveBeenCalled();
    expect(mocks.consumeForeground).not.toHaveBeenCalled();
  });

  it('clears an exact stale attempt when the native clock recovered on its own', async () => {
    const attempt = {};
    mocks.getPendingAttempt.mockReturnValue(attempt);
    mocks.probe.mockResolvedValue({
      healthy: true,
      reason: 'healthy',
      state: 'running',
      clockAdvanceSeconds: 0.18,
    });

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'healthy',
      reason: 'healthy',
    });
    expect(mocks.cancelPending).toHaveBeenCalledWith(attempt);
  });

  it('confirms an exact provisional recovery after the shared healthy probe', async () => {
    const attempt = {};
    mocks.getPendingAttempt.mockReturnValue(attempt);
    mocks.getRecoveryRequirement.mockReturnValue({
      attemptToken: attempt,
      isCurrent: () => true,
    });
    mocks.probe.mockResolvedValue({
      healthy: true,
      reason: 'healthy',
      state: 'running',
      clockAdvanceSeconds: 0.18,
    });

    await expect(inspectBackgroundFileOutput()).resolves.toMatchObject({ status: 'healthy' });
    expect(mocks.confirmPending).toHaveBeenCalledWith(attempt);
    expect(mocks.cancelPending).not.toHaveBeenCalled();
  });

  it('arms the exact context when two clock samples remain frozen', async () => {
    const context = { state: 'running' } as AudioContext;
    mocks.getContext.mockReturnValue(context);
    mocks.probe.mockResolvedValue({
      healthy: false,
      reason: 'clock-stalled',
      state: 'running',
      clockAdvanceSeconds: 0,
    });

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'needs-gesture',
      reason: 'clock-stalled',
    });
    expect(mocks.arm).toHaveBeenCalledOnce();
    expect(mocks.arm).toHaveBeenCalledWith(context, 'background-clock-stalled');
  });

  it('drops a probe whose queue occurrence changes while it awaits WebKit', async () => {
    mocks.probe.mockImplementation(async (options: { isCurrent: () => boolean }) => {
      expect(options.isCurrent()).toBe(true);
      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
      expect(options.isCurrent()).toBe(false);
      return {
        healthy: false,
        reason: 'superseded',
        state: 'running',
        clockAdvanceSeconds: null,
      };
    });

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'stale',
      reason: 'superseded',
    });
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it('treats an early timer sample as inconclusive instead of arming recovery', async () => {
    const foregroundToken = {};
    mocks.getForegroundRequirement.mockReturnValue({
      token: foregroundToken,
      isCurrent: () => true,
    });
    mocks.probe.mockResolvedValue({
      healthy: false,
      reason: 'inconclusive',
      state: 'running',
      clockAdvanceSeconds: 0,
    });

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'stale',
      reason: 'inconclusive',
    });
    expect(mocks.arm).not.toHaveBeenCalled();
    expect(mocks.consumeForeground).not.toHaveBeenCalledWith(foregroundToken);
  });

  it('does nothing while a file transfer pipeline owns the next start', async () => {
    mocks.isPipelineBusy.mockReturnValue(true);

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'not-applicable',
      reason: null,
    });
    expect(mocks.probe).not.toHaveBeenCalled();
  });
});
