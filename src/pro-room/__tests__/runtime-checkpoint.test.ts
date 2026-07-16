/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PLAYBACK_STATE } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { transition } from '../../player/lifecycle.ts';
import type { PlaylistItem, QueueItemId, RoomContext } from '../../types/index.ts';
import {
  captureLocalPlaybackCheckpointForTests,
  shouldRetainPendingProDownloadForTests,
} from '../runtime.ts';

const QUEUE_ITEM_ID = '20000000-0000-4000-8000-000000000001' as QueueItemId;

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
