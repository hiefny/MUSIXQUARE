/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';

const mocks = vi.hoisted(() => ({
  isPlayingFile: vi.fn(() => true),
  isPipelineBusy: vi.fn(() => false),
  isSourceUsable: vi.fn(
    (node: AudioBufferSourceNode | null, buffer: AudioBuffer) =>
      node !== null && node.buffer === buffer,
  ),
  getBuffer: vi.fn(() => ({ duration: 120 }) as AudioBuffer | null),
  getPlayerNode: vi.fn(() => ({ buffer: null }) as unknown as AudioBufferSourceNode | null),
  getContext: vi.fn(() => ({ state: 'running' }) as AudioContext | null),
  probe: vi.fn(),
  arm: vi.fn(() => ({})),
  getPendingAttempt: vi.fn(() => null as object | null),
  getForegroundRequirement: vi.fn(
    () =>
      null as {
        context: AudioContext;
        token: object;
        isCurrent: () => boolean;
        getHiddenContinuityGapSeconds: () => number | null;
      } | null,
  ),
  isForegroundRestartOwned: vi.fn(() => false),
  cancelPending: vi.fn(() => true),
  consumeForeground: vi.fn(() => true),
}));

vi.mock('../../player/ownership.ts', () => ({
  isPlaybackPlayingFile: mocks.isPlayingFile,
}));
vi.mock('../../player/transport.ts', () => ({
  isFilePipelineBusyForPlay: mocks.isPipelineBusy,
  isFileSourceNodeUsable: mocks.isSourceUsable,
}));
vi.mock('../../player/_state.ts', () => ({
  getCurrentAudioBuffer: mocks.getBuffer,
  getPlayerNode: mocks.getPlayerNode,
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
  getPendingAudioContextRecoveryAttemptForHealth: mocks.getPendingAttempt,
  cancelPendingAudioContextRecovery: mocks.cancelPending,
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
    mocks.isSourceUsable.mockImplementation(
      (node: AudioBufferSourceNode | null, buffer: AudioBuffer) =>
        node !== null && node.buffer === buffer,
    );
    const buffer = { duration: 120 } as AudioBuffer;
    mocks.getBuffer.mockReturnValue(buffer);
    mocks.getPlayerNode.mockReturnValue({ buffer } as AudioBufferSourceNode);
    mocks.getContext.mockReturnValue({ state: 'running' } as AudioContext);
    mocks.getPendingAttempt.mockReturnValue(null);
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
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: expect.any(Function),
      isPlaybackCurrent: expect.any(Function),
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
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: null,
      isPlaybackCurrent: null,
    });

    expect(mocks.probe).not.toHaveBeenCalled();
    expect(context.resume).not.toHaveBeenCalled();
    expect(mocks.arm).not.toHaveBeenCalled();
    expect(mocks.consumeForeground).not.toHaveBeenCalled();
  });

  it('defers entirely to a semantic recovery that already owns the incident', async () => {
    const attempt = {};
    mocks.getPendingAttempt.mockReturnValue(attempt);

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'stale',
      reason: 'superseded',
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: null,
      isPlaybackCurrent: null,
    });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.cancelPending).not.toHaveBeenCalled();
  });

  it('does not adopt a semantic recovery that appears during its foreground probe', async () => {
    const attempt = {};
    mocks.getPendingAttempt.mockReturnValueOnce(null).mockReturnValue(attempt);
    mocks.probe.mockResolvedValue({
      healthy: true,
      reason: 'healthy',
      state: 'running',
      clockAdvanceSeconds: 0.18,
    });

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'stale',
      reason: 'superseded',
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: null,
      isPlaybackCurrent: null,
    });
    expect(mocks.probe).toHaveBeenCalledOnce();
    expect(mocks.cancelPending).not.toHaveBeenCalled();
  });

  it('consumes one pre-armed foreground incident without requesting a healthy rejoin', async () => {
    const context = { state: 'running' } as AudioContext;
    const foregroundToken = {};
    const foregroundRequirement = {
      context,
      token: foregroundToken,
      isCurrent: vi.fn(() => true),
      getHiddenContinuityGapSeconds: vi.fn(() => 0),
    };
    mocks.getContext.mockReturnValue(context);
    mocks.getForegroundRequirement.mockReturnValue(foregroundRequirement);
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
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: expect.any(Function),
      isPlaybackCurrent: expect.any(Function),
    });

    expect(mocks.probe).toHaveBeenCalledOnce();
    expect(foregroundRequirement.isCurrent).toHaveBeenCalled();
    expect(foregroundRequirement.getHiddenContinuityGapSeconds).toHaveBeenCalledOnce();
    expect(mocks.consumeForeground).toHaveBeenCalledOnce();
    expect(mocks.consumeForeground).toHaveBeenCalledWith(foregroundToken);
  });

  it('requires one rejoin when hidden wall time outran an otherwise healthy PRO clock', async () => {
    const context = { state: 'running' } as AudioContext;
    const foregroundToken = {};
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    mocks.getContext.mockReturnValue(context);
    mocks.getForegroundRequirement.mockReturnValue({
      context,
      token: foregroundToken,
      isCurrent: () => true,
      // The clock can advance during the post-visible probe even though it was
      // frozen for most of the hidden interval on iOS.
      getHiddenContinuityGapSeconds: vi.fn(() => 2),
    });
    mocks.probe.mockResolvedValue({
      healthy: true,
      reason: 'healthy',
      state: 'running',
      clockAdvanceSeconds: 0.18,
    });

    const output = await inspectBackgroundFileOutput();
    expect(output).toEqual({
      status: 'healthy',
      reason: 'healthy',
      rejoinRequired: true,
      rejoinEmitted: false,
      isCurrent: expect.any(Function),
      isPlaybackCurrent: expect.any(Function),
    });
    expect(output.isCurrent?.()).toBe(true);
    expect(output.isPlaybackCurrent?.()).toBe(true);

    // A source successor after inspection invalidates the exact rebuild claim
    // even while the room/queue/buffer occurrence itself is still current.
    mocks.getPlayerNode.mockReturnValue({ buffer: mocks.getBuffer() } as AudioBufferSourceNode);
    expect(output.isCurrent?.()).toBe(false);
    expect(output.isPlaybackCurrent?.()).toBe(true);
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
    expect(output.isPlaybackCurrent?.()).toBe(false);
    expect(mocks.probe).toHaveBeenCalledOnce();
    expect(mocks.consumeForeground).toHaveBeenCalledOnce();
    expect(mocks.consumeForeground).toHaveBeenCalledWith(foregroundToken);
  });

  it.each([
    ['missing', null],
    ['bound to a different buffer', { buffer: { duration: 120 } as AudioBuffer }],
  ])('requires one rejoin when the physical source is %s', async (_label, source) => {
    mocks.getPlayerNode.mockReturnValue(source as AudioBufferSourceNode | null);
    mocks.probe.mockResolvedValue({
      healthy: true,
      reason: 'healthy',
      state: 'running',
      clockAdvanceSeconds: 0.18,
    });

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'healthy',
      reason: 'healthy',
      rejoinRequired: true,
      rejoinEmitted: false,
      isCurrent: expect.any(Function),
      isPlaybackCurrent: expect.any(Function),
    });
  });

  it('requires one rejoin when the retained source has already ended', async () => {
    const source = mocks.getPlayerNode();
    const buffer = mocks.getBuffer();
    mocks.isSourceUsable.mockReturnValue(false);
    mocks.probe.mockResolvedValue({
      healthy: true,
      reason: 'healthy',
      state: 'running',
      clockAdvanceSeconds: 0.18,
    });

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'healthy',
      reason: 'healthy',
      rejoinRequired: true,
      rejoinEmitted: false,
      isCurrent: expect.any(Function),
      isPlaybackCurrent: expect.any(Function),
    });
    expect(mocks.isSourceUsable).toHaveBeenCalledWith(source, buffer);
  });

  it('drops a probe when a successor source replaces the captured source', async () => {
    const successor = { buffer: mocks.getBuffer() } as AudioBufferSourceNode;
    mocks.probe.mockImplementation(async (options: { isCurrent: () => boolean }) => {
      expect(options.isCurrent()).toBe(true);
      mocks.getPlayerNode.mockReturnValue(successor);
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
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: null,
      isPlaybackCurrent: null,
    });
    expect(mocks.arm).not.toHaveBeenCalled();
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
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: null,
      isPlaybackCurrent: null,
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
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: null,
      isPlaybackCurrent: null,
    });
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it('treats an early timer sample as inconclusive instead of arming recovery', async () => {
    const foregroundToken = {};
    mocks.getForegroundRequirement.mockReturnValue({
      context: mocks.getContext()!,
      token: foregroundToken,
      isCurrent: () => true,
      getHiddenContinuityGapSeconds: () => null,
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
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: null,
      isPlaybackCurrent: null,
    });
    expect(mocks.arm).not.toHaveBeenCalled();
    expect(mocks.consumeForeground).not.toHaveBeenCalledWith(foregroundToken);
  });

  it('does nothing while a file transfer pipeline owns the next start', async () => {
    mocks.isPipelineBusy.mockReturnValue(true);

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'not-applicable',
      reason: null,
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: null,
      isPlaybackCurrent: null,
    });
    expect(mocks.probe).not.toHaveBeenCalled();
  });
});
