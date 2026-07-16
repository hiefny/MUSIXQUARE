/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PLAYBACK_STATE } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { transition } from '../../player/lifecycle.ts';
import type { ConnectedPeer, PlaylistItem, QueueItemId, RoomContext } from '../../types/index.ts';
import {
  captureLocalPlaybackCheckpointForTests,
  reconcileRemovedProRoomQueueStateForTests,
  shouldRetainPendingProDownloadForTests,
} from '../runtime.ts';

const QUEUE_ITEM_ID = '20000000-0000-4000-8000-000000000001' as QueueItemId;
const REMOVED_PRELOAD_ID = '20000000-0000-4000-8000-000000000002' as QueueItemId;
const REMOVED_RECOVERY_ID = '20000000-0000-4000-8000-000000000003' as QueueItemId;

beforeEach(() => {
  resetState();
});

describe('PRO room periodic playback checkpoint', () => {
  it('preserves an unloaded persistent selection while its R2 body is downloading', () => {
    const item: PlaylistItem = {
      queueItemId: QUEUE_ITEM_ID,
      type: 'file',
      name: 'orchestra.flac',
      videoId: null,
      playlistId: null,
    };
    setState('playlist.items', [item]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);

    transition({
      type: 'FILE_PREPARE',
      variant: 'fresh',
      queueItemId: QUEUE_ITEM_ID,
      name: item.name,
    });

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(captureLocalPlaybackCheckpointForTests()).toEqual({
      state: 'paused',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: expect.any(Number),
    });
  });
});

describe('PRO room R2 download ownership', () => {
  function context(role: RoomContext['role'], epoch: number, roomId = '000001'): RoomContext {
    return {
      kind: 'pro',
      roomId,
      role,
      coordinatorId: role === 'coordinator' ? 'local-device' : 'another-device',
      epoch,
      snapshotRevision: epoch,
      capabilities: ['playback.control'],
    };
  }

  it('keeps the participant-owned download through coordinator and epoch changes', () => {
    expect(shouldRetainPendingProDownloadForTests('000001', context('member', 12))).toBe(true);
    expect(shouldRetainPendingProDownloadForTests('000001', context('coordinator', 13))).toBe(true);
    expect(shouldRetainPendingProDownloadForTests('000001', context('member', 14))).toBe(true);
  });

  it('releases the download when the participant leaves or switches rooms', () => {
    expect(shouldRetainPendingProDownloadForTests('000001', context('member', 13, '000002'))).toBe(
      false,
    );
    expect(
      shouldRetainPendingProDownloadForTests('000001', {
        ...context('idle', 13),
        kind: 'standard',
        roomId: null,
        coordinatorId: null,
        capabilities: [],
      }),
    ).toBe(false);
  });
});

describe('PRO room accepted removal cleanup', () => {
  it('clears preload and recovery owners for every removed queue identity', () => {
    setState('preload.nextQueueItemId', REMOVED_PRELOAD_ID);
    setState('preload.activeTarget', {
      queueItemId: REMOVED_PRELOAD_ID,
      indexHint: 1,
      name: 'preloaded.flac',
      sessionId: 9,
    });
    setState('playback.pendingRecoveryTarget', {
      queueItemId: REMOVED_RECOVERY_ID,
      indexHint: 2,
      name: 'recovering.flac',
    });
    setState('recovery.pending', true);

    reconcileRemovedProRoomQueueStateForTests([REMOVED_PRELOAD_ID, REMOVED_RECOVERY_ID]);

    expect(getState('preload.nextQueueItemId')).toBeNull();
    expect(getState('preload.activeTarget')).toBeNull();
    expect(getState('playback.pendingRecoveryTarget')).toBeNull();
    expect(getState('recovery.pending')).toBe(false);
  });

  it('prunes removed IDs from coordinator peer preload caches without dropping survivors', () => {
    const peer = {
      id: 'peer-1',
      slot: 1,
      label: 'Peer 1',
      conn: null,
      isOp: true,
      preloadedQueueItemIds: new Set([QUEUE_ITEM_ID, REMOVED_PRELOAD_ID, REMOVED_RECOVERY_ID]),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'local',
      lastHeartbeat: Date.now(),
    } satisfies ConnectedPeer;
    setState('network.connectedPeers', [peer]);

    reconcileRemovedProRoomQueueStateForTests([REMOVED_PRELOAD_ID, REMOVED_RECOVERY_ID]);

    expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([
      QUEUE_ITEM_ID,
    ]);
  });
});
