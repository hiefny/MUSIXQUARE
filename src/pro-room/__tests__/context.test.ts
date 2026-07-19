import { describe, expect, it } from 'vitest';
import type { ProRoomSnapshot } from '../contracts.ts';
import { PRO_ROOM_MAX_ASSET_BYTES, PRO_ROOM_QUOTA_BYTES } from '../contracts.ts';
import { projectProRoomContext } from '../context.ts';

const PARTICIPANT_ID = 'participant_00001';

function snapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: '000001',
    status: 'active',
    runtime: 'awake',
    revision: 7,
    playlistRevision: 2,
    playlist: [],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 3,
      revision: 1,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 1,
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

describe('PRO room authority projection', () => {
  it('projects an elected owner as an equal member and strips legacy coordinator capability', () => {
    const result = projectProRoomContext(snapshot());
    expect(result).toEqual({
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 3,
      snapshotRevision: 7,
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'members.manage',
        'room.configure',
      ],
    });
  });

  it('projects every authenticated viewer identically regardless of persisted room role or leader residue', () => {
    const value = snapshot();
    value.viewer = {
      ...value.viewer!,
      role: 'controller',
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'members.manage',
        'coordinator.eligible',
      ],
      coordinatorEligible: false,
    };
    value.presence.coordinatorParticipantId = 'participant_legacy_leader';

    expect(projectProRoomContext(value)).toMatchObject({
      role: 'member',
      coordinatorId: null,
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'members.manage',
      ],
    });
  });

  it('refuses unauthenticated or suspended snapshots', () => {
    const unauthenticated = snapshot();
    unauthenticated.viewer = null;
    expect(projectProRoomContext(unauthenticated)).toBeNull();

    const suspended = snapshot();
    suspended.status = 'suspended';
    expect(projectProRoomContext(suspended)).toBeNull();
  });
});
