import { describe, expect, it, vi } from 'vitest';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { buildProRoomUnloadCheckpoint, waitForProRoomPresenceClose } from '../hard-close.ts';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';
const PARTICIPANT_ID = 'participant_00001';

function snapshot(source: 'youtube' | 'file' = 'youtube'): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: '000001',
    status: 'active',
    runtime: 'awake',
    revision: 8,
    playlistRevision: 1,
    playlist: [
      {
        queueItemId: QUEUE_ITEM_ID,
        name: 'Track',
        source:
          source === 'youtube'
            ? { kind: 'youtube', videoId: 'dQw4w9WgXcQ' }
            : {
                kind: 'pro-r2',
                assetId: 'asset_00000000001',
                version: 1,
                byteLength: 4096,
                mime: 'audio/flac',
              },
      },
    ],
    currentQueueItemId: QUEUE_ITEM_ID,
    playback: {
      coordinatorEpoch: 3,
      revision: 4,
      state: 'paused',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 10,
      youtubeVideoId: source === 'youtube' ? 'dQw4w9WgXcQ' : null,
      youtubeSubIndex: source === 'youtube' ? 0 : null,
      updatedAtMs: 1_800_000_000_000,
    },
    presence: {
      coordinatorEpoch: 3,
      revision: 2,
      coordinatorParticipantId: PARTICIPANT_ID,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          displayName: 'Owner',
          role: 'owner',
          joinedAtMs: 1,
        },
      ],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: {
      memberId: 'member_0000000001',
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Owner',
      role: 'owner',
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'coordinator.eligible',
        'members.manage',
        'room.configure',
      ],
      coordinatorEligible: true,
    },
  };
}

describe('PRO room unload checkpoint', () => {
  it('bounds explicit leave without aborting the underlying keepalive request', async () => {
    vi.useFakeTimers();
    try {
      let finishRequest!: () => void;
      let underlyingFinished = false;
      const request = new Promise<void>((resolve) => {
        finishRequest = () => {
          underlyingFinished = true;
          resolve();
        };
      });
      const bounded = waitForProRoomPresenceClose(request, 1_200);
      const timedOut = expect(bounded).rejects.toThrow('PRO_ROOM_PRESENCE_CLOSE_TIMEOUT');

      await vi.advanceTimersByTimeAsync(1_200);
      await timedOut;
      expect(underlyingFinished).toBe(false);

      finishRequest();
      await request;
      expect(underlyingFinished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('versions the final coordinator position and preserves exact YouTube identity', () => {
    const result = buildProRoomUnloadCheckpoint(snapshot(), {
      state: 'playing',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 42.25,
      youtubeVideoId: '9bZkp7q19f0',
      youtubeSubIndex: 7,
      updatedAtMs: 1_800_000_000_500,
    });

    expect(result).toEqual({
      currentQueueItemId: QUEUE_ITEM_ID,
      playback: {
        coordinatorEpoch: 3,
        revision: 5,
        state: 'playing',
        queueItemId: QUEUE_ITEM_ID,
        positionSeconds: 42.25,
        youtubeVideoId: '9bZkp7q19f0',
        youtubeSubIndex: 7,
        updatedAtMs: 1_800_000_000_500,
      },
    });
  });

  it('never lets a non-coordinator submit a playback checkpoint', () => {
    const member = snapshot();
    member.presence.coordinatorParticipantId = 'participant_00002';

    expect(
      buildProRoomUnloadCheckpoint(member, {
        state: 'playing',
        queueItemId: QUEUE_ITEM_ID,
        positionSeconds: 42,
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
        updatedAtMs: 1_800_000_000_500,
      }),
    ).toEqual({ currentQueueItemId: null, playback: null });
  });

  it('degrades mismatched media metadata to a presence-only close', () => {
    expect(
      buildProRoomUnloadCheckpoint(snapshot('file'), {
        state: 'playing',
        queueItemId: QUEUE_ITEM_ID,
        positionSeconds: 42,
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
        updatedAtMs: 1_800_000_000_500,
      }),
    ).toEqual({ currentQueueItemId: null, playback: null });
  });
});
