/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { QueueItemId, RoomContext } from '../../types/index.ts';
import type { ProRoomPlaybackCheckpoint, ProRoomSnapshot } from '../contracts.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackMediaEndpoint,
  type ProPlaybackPrepareRequest,
  type ProPlaybackPrepareResult,
} from '../playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';

vi.mock('../network-bridge.ts', () => ({
  getProRoomServerNow: () => Date.now(),
  isProRoomServerClockCalibrated: () => true,
  waitForFreshProRoomServerClockCalibration: vi.fn().mockResolvedValue(true),
}));

const ROOM = '000001';
const EPOCH = 7;
const FAILED_ITEM = '40000000-0000-4000-8000-000000000001' as QueueItemId;
const HEALTHY_ITEM = '40000000-0000-4000-8000-000000000002' as QueueItemId;
const TRANSITION = `transition_${'a'.repeat(22)}`;

function playback(queueItemId = FAILED_ITEM, revision = 12): ProRoomPlaybackCheckpoint {
  return {
    coordinatorEpoch: EPOCH,
    revision,
    state: 'playing',
    queueItemId,
    positionSeconds: 24,
    updatedAtMs: Date.now(),
    youtubeVideoId: null,
    youtubeSubIndex: null,
  };
}

function snapshot(checkpoint = playback()): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: ROOM,
    status: 'active',
    runtime: 'awake',
    revision: checkpoint.revision,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [FAILED_ITEM, HEALTHY_ITEM].map((queueItemId, index) => ({
      queueItemId,
      name: `track-${index}.flac`,
      source: {
        kind: 'pro-r2',
        assetId: `asset_${String(index).repeat(22)}`,
        version: 1,
        byteLength: 4096,
        mime: 'audio/flac',
      },
    })),
    currentQueueItemId: checkpoint.queueItemId,
    playback: checkpoint,
    presence: {
      coordinatorEpoch: EPOCH,
      revision: 1,
      coordinatorParticipantId: null,
      participants: [],
    },
    quota: { limitBytes: 10_000, perAssetLimitBytes: 5_000, usedBytes: 8192, reservedBytes: 0 },
    viewer: null,
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [],
  };
}

function ready(request: Readonly<ProPlaybackPrepareRequest>): ProPlaybackPrepareResult {
  return {
    status: 'ready',
    authority: request.authority,
    queueItemId: request.queueItemId,
    mediaKind: 'file',
    durationSeconds: 180,
    youtubeVideoId: null,
    youtubeSubIndex: null,
  };
}

const controllers: ProRoomPlaybackController[] = [];

function setupController(endpoint: ProPlaybackMediaEndpoint) {
  let canonical = snapshot();
  const checkpointApplied = vi.fn();
  bus.on('sync:diagnostic-pro-checkpoint', checkpointApplied);
  const ports = {
    isActive: () => true,
    getCanonicalSnapshot: () => canonical,
    getPlaylistSnapshot: () => canonical,
    capturePlaylistLease: () => ({ generation: 1, roomCode: ROOM }),
    isPlaylistLeaseCurrent: () => true,
    getRoomAbortSignal: () => undefined,
    subscribePlaylistProjection: () => () => undefined,
    runHeartbeat: vi.fn().mockResolvedValue(undefined),
    reportPlaybackTransitionReady: vi.fn().mockResolvedValue('waiting'),
    executePlaybackCommand: vi.fn(),
    recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
  };
  registerProPlaybackMediaEndpoint(endpoint);
  const controller = new ProRoomPlaybackController(ports);
  controllers.push(controller);
  return {
    controller,
    ports,
    checkpointApplied,
    setCanonical(checkpoint: ProRoomPlaybackCheckpoint) {
      canonical = snapshot(checkpoint);
      return canonical;
    },
    prepare(checkpoint = canonical.playback) {
      controller.acceptPrepare({
        type: 'pro-playback-prepare',
        transitionId: TRANSITION,
        serverTimeMs: Date.now(),
        deadlineAtMs: Date.now() + 3000,
        basePlaybackRevision: checkpoint.revision - 1,
        target: checkpoint,
      });
    },
    commit(transitionId: string | null = TRANSITION, checkpoint = canonical.playback) {
      controller.acceptCommit({
        type: 'pro-playback-commit',
        transitionId,
        serverTimeMs: Date.now(),
        executeAtMs: Date.now(),
        playback: checkpoint,
      });
    },
  };
}

describe('PRO device-unavailable playback checkpoints', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    resetProPlaybackAuthorityHooks();
    setState('room.context', {
      kind: 'pro',
      roomId: ROOM,
      role: 'member',
      coordinatorId: null,
      epoch: EPOCH,
      snapshotRevision: 12,
      capabilities: [],
    });
    setState(
      'playlist.items',
      [FAILED_ITEM, HEALTHY_ITEM].map((queueItemId) => ({
        queueItemId,
        type: 'file',
        name: 'track.flac',
        videoId: null,
        playlistId: null,
      })),
    );
  });

  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.stopLifecycle();
    registerProPlaybackMediaEndpoint(null);
    resetProPlaybackAuthorityHooks();
    clearAllManagedTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { label: 'ordinary member', capabilities: [] as RoomContext['capabilities'] },
    {
      label: 'playback controller',
      capabilities: ['playback.control'] as RoomContext['capabilities'],
    },
  ])(
    'reports terminal preparation without catch-up or a room command for $label',
    async ({ capabilities }) => {
      setState('room.context', { ...getState('room.context'), capabilities });
      const prepare = vi.fn<ProPlaybackMediaEndpoint['prepare']>(async (request) => ({
        status: 'failed',
        authority: request.authority,
        queueItemId: request.queueItemId,
        reason: 'device-unavailable',
      }));
      const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>();
      const invalidateCommitted = vi.fn();
      const harness = setupController({ prepare, commit, invalidateCommitted });

      harness.prepare();
      await vi.waitFor(() =>
        expect(harness.ports.reportPlaybackTransitionReady).toHaveBeenCalled(),
      );
      expect(harness.ports.reportPlaybackTransitionReady).toHaveBeenCalledWith({
        code: ROOM,
        transitionId: TRANSITION,
        basePlaybackRevision: 11,
        status: 'failed',
      });
      expect(invalidateCommitted).not.toHaveBeenCalled();

      harness.commit();
      await vi.waitFor(() => expect(invalidateCommitted).toHaveBeenCalledTimes(1));
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(harness.checkpointApplied).not.toHaveBeenCalled();
      expect(harness.ports.executePlaybackCommand).not.toHaveBeenCalled();
    },
  );

  it('keeps repeated failed snapshots unapplied and recovers on a healthy next occurrence', async () => {
    const prepare = vi.fn<ProPlaybackMediaEndpoint['prepare']>(async (request) =>
      request.queueItemId === FAILED_ITEM
        ? {
            status: 'failed',
            authority: request.authority,
            queueItemId: request.queueItemId,
            reason: 'device-unavailable',
          }
        : ready(request),
    );
    const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (request) => ({
      status: 'applied',
      authority: request.authority,
    }));
    const harness = setupController({ prepare, commit, invalidateCommitted: vi.fn() });

    for (let heartbeat = 0; heartbeat < 4; heartbeat += 1) {
      await expect(harness.controller.requestReconciliation()).resolves.toBe(false);
    }
    expect(commit).not.toHaveBeenCalled();
    expect(harness.checkpointApplied).not.toHaveBeenCalled();

    harness.setCanonical(playback(HEALTHY_ITEM, 13));
    await expect(harness.controller.requestReconciliation()).resolves.toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ queueItemId: HEALTHY_ITEM }));
    expect(harness.checkpointApplied).toHaveBeenCalledTimes(1);
    expect(harness.checkpointApplied).toHaveBeenCalledWith(
      expect.objectContaining({ trackKey: HEALTHY_ITEM, revision: 13 }),
    );
    expect(harness.ports.executePlaybackCommand).not.toHaveBeenCalled();
  });

  it('does not try preparation after a direct commit reports device unavailability', async () => {
    const prepare = vi.fn<ProPlaybackMediaEndpoint['prepare']>();
    const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (request) => ({
      status: 'failed',
      authority: request.authority,
      reason: 'device-unavailable',
    }));
    const invalidateCommitted = vi.fn();
    const harness = setupController({ prepare, commit, invalidateCommitted });

    harness.commit(null);
    await vi.waitFor(() => expect(invalidateCommitted).toHaveBeenCalledTimes(1));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(harness.checkpointApplied).not.toHaveBeenCalled();
    expect(harness.ports.executePlaybackCommand).not.toHaveBeenCalled();
  });

  it.each(['decode-failed', 'unknown'] as const)(
    'retains exact-checkpoint recovery for a retryable %s preparation failure',
    async (reason) => {
      const prepare = vi.fn<ProPlaybackMediaEndpoint['prepare']>(async (request) => ready(request));
      prepare.mockImplementationOnce(async (request) => ({
        status: 'failed',
        authority: request.authority,
        queueItemId: request.queueItemId,
        reason,
      }));
      const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (request) => ({
        status: 'applied',
        authority: request.authority,
      }));
      const harness = setupController({ prepare, commit, invalidateCommitted: vi.fn() });

      harness.prepare();
      await vi.waitFor(() =>
        expect(harness.ports.reportPlaybackTransitionReady).toHaveBeenCalled(),
      );
      harness.commit();
      await vi.waitFor(() => expect(harness.checkpointApplied).toHaveBeenCalledTimes(1));
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(prepare.mock.calls[1]?.[0].authority.transitionId).toBe('snapshot_12');
      expect(commit).toHaveBeenCalledTimes(1);
      expect(harness.ports.executePlaybackCommand).not.toHaveBeenCalled();
    },
  );
});
