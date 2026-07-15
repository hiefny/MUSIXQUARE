import { describe, expect, it } from 'vitest';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  proRoomRoleCanForTests as proRoomRoleCan,
  type ProRoomCapability,
  type ProRoomSnapshot,
} from '../contracts.ts';
import {
  isProRoomPin,
  parseProRoomClaimToken,
  parseProRoomMemberTokenForTests as parseProRoomMemberToken,
  parseProRoomOwnerRecoveryClaimToken,
} from '../credentials.ts';
import { applyProRoomSnapshotMonotonically } from '../revision.ts';
import { parseProRoomPlaylistItem, parseProRoomSnapshot } from '../snapshot.ts';

const Q1 = '11111111-1111-4111-8111-111111111111';
const Q2 = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = 'member_0000000001';
const PARTICIPANT_ID = 'participant_00001';
const ASSET_ID = 'asset_00000000001';

const OWNER_CAPABILITIES: ProRoomCapability[] = [
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'coordinator.eligible',
  'members.manage',
  'room.configure',
];

function activeSnapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: '000001',
    status: 'active',
    runtime: 'awake',
    revision: 12,
    playlistRevision: 7,
    playlist: [
      {
        queueItemId: Q1,
        name: 'Live.flac',
        title: 'Live',
        source: {
          kind: 'pro-r2',
          assetId: ASSET_ID,
          version: 2,
          byteLength: 64 * 1024 * 1024,
          mime: 'audio/flac',
          sha256: 'a'.repeat(64),
        },
      },
      {
        queueItemId: Q2,
        name: 'YouTube track',
        source: {
          kind: 'youtube',
          videoId: 'dQw4w9WgXcQ',
          playlistId: 'PL_1234567890',
        },
      },
    ],
    currentQueueItemId: Q1,
    playback: {
      coordinatorEpoch: 3,
      revision: 9,
      state: 'playing',
      queueItemId: Q1,
      positionSeconds: 42.25,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 1_800_000_000_000,
    },
    presence: {
      coordinatorEpoch: 3,
      revision: 5,
      coordinatorParticipantId: PARTICIPANT_ID,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          displayName: 'Owner',
          role: 'owner',
          joinedAtMs: 1_800_000_000_000,
        },
      ],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 64 * 1024 * 1024,
      reservedBytes: 0,
    },
    viewer: {
      memberId: MEMBER_ID,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Owner',
      role: 'owner',
      capabilities: [...OWNER_CAPABILITIES],
      coordinatorEligible: true,
    },
  };
}

function unactivatedSnapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: '000000',
    status: 'unactivated',
    runtime: 'sleeping',
    revision: 0,
    playlistRevision: 0,
    playlist: [],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 0,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 0,
    },
    presence: {
      coordinatorEpoch: 0,
      revision: 0,
      coordinatorParticipantId: null,
      participants: [],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: null,
  };
}

describe('PRO room roles and credentials', () => {
  it('lets trusted controllers manage members while reserving room configuration for owners', () => {
    expect(capabilitiesForProRoomRole('controller')).toEqual([
      'queue.mutate',
      'playback.control',
      'effects.control',
      'asset.upload',
      'coordinator.eligible',
      'members.manage',
    ]);
    expect(capabilitiesForProRoomRole('owner')).toEqual(OWNER_CAPABILITIES);
    expect(proRoomRoleCan('controller', 'playback.control')).toBe(true);
    expect(proRoomRoleCan('controller', 'members.manage')).toBe(true);
    expect(proRoomRoleCan('controller', 'room.configure')).toBe(false);
    expect(proRoomRoleCan('owner', 'members.manage')).toBe(true);
  });

  it('validates an eight-digit PIN as a string without silently normalizing it', () => {
    expect(isProRoomPin('00000001')).toBe(true);
    expect(isProRoomPin('0000-0001')).toBe(false);
    expect(isProRoomPin(1)).toBe(false);
    expect(isProRoomPin('123456789')).toBe(false);
  });

  it('only performs bounded URL-safe format checks on opaque tokens', () => {
    const opaque = 'v1.' + 'a'.repeat(32) + '.' + 'B'.repeat(43);
    expect(parseProRoomMemberToken(opaque)).toBe(opaque);
    expect(parseProRoomClaimToken(opaque)).toBe(opaque);
    expect(parseProRoomOwnerRecoveryClaimToken(opaque)).toBe(opaque);
    expect(parseProRoomMemberToken('short')).toBeNull();
    expect(parseProRoomMemberToken('a'.repeat(31) + '/')).toBeNull();
    expect(parseProRoomClaimToken('a'.repeat(2049))).toBeNull();
    expect(parseProRoomOwnerRecoveryClaimToken('short')).toBeNull();
  });
});

describe('PRO playlist wire items', () => {
  it('accepts canonical nested YouTube and private R2 sources', () => {
    const snapshot = activeSnapshot();
    expect(parseProRoomPlaylistItem(snapshot.playlist[0])).toEqual(snapshot.playlist[0]);
    expect(parseProRoomPlaylistItem(snapshot.playlist[1])).toEqual(snapshot.playlist[1]);

    const malformedVideo = structuredClone(snapshot.playlist[1]);
    if (malformedVideo?.source.kind !== 'youtube') throw new Error('fixture');
    malformedVideo.source.videoId = 'too-short';
    expect(parseProRoomPlaylistItem(malformedVideo)).toBeNull();
  });

  it('rejects flattened, oversized, unversioned, and weakly identified R2 assets', () => {
    const flattened = {
      queueItemId: Q1,
      name: 'track.flac',
      source: 'r2',
      assetId: ASSET_ID,
      mime: 'audio/flac',
      byteLength: 1,
    };
    expect(parseProRoomPlaylistItem(flattened)).toBeNull();

    const item = structuredClone(activeSnapshot().playlist[0]);
    if (item?.source.kind !== 'pro-r2') throw new Error('fixture');
    item.source.byteLength = PRO_ROOM_MAX_ASSET_BYTES + 1;
    expect(parseProRoomPlaylistItem(item)).toBeNull();
    item.source.byteLength = 1;
    item.source.version = 0;
    expect(parseProRoomPlaylistItem(item)).toBeNull();
    item.source.version = 1;
    item.source.assetId = '../private/key';
    expect(parseProRoomPlaylistItem(item)).toBeNull();
  });

  it('rejects unknown fields and malformed optional hashes', () => {
    const item = structuredClone(activeSnapshot().playlist[0]);
    if (item?.source.kind !== 'pro-r2') throw new Error('fixture');
    const source = item.source as unknown as Record<string, unknown>;
    source.objectKey = 'rooms/000001/private';
    expect(parseProRoomPlaylistItem(item)).toBeNull();
    delete source.objectKey;
    item.source.sha256 = 'not-a-digest';
    expect(parseProRoomPlaylistItem(item)).toBeNull();
  });
});

describe('PRO room snapshot validation', () => {
  it('parses the active v1 snapshot and returns a detached JSON-safe copy', () => {
    const raw = activeSnapshot();
    const parsed = parseProRoomSnapshot(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    expect(parsed?.playlist).not.toBe(raw.playlist);
    expect(parsed?.playback).not.toBe(raw.playback);
  });

  it('accepts the empty unactivated lifecycle and keeps runtime separate', () => {
    expect(parseProRoomSnapshot(unactivatedSnapshot())).toEqual(unactivatedSnapshot());

    const invalid = unactivatedSnapshot();
    invalid.runtime = 'awake';
    expect(parseProRoomSnapshot(invalid)).toBeNull();
  });

  it('accepts an authenticated sleeping room without pretending the viewer is present', () => {
    const sleeping = activeSnapshot();
    sleeping.runtime = 'sleeping';
    sleeping.presence.participants = [];
    sleeping.presence.coordinatorParticipantId = null;
    expect(parseProRoomSnapshot(sleeping)).not.toBeNull();
  });

  it('keeps coordinator authority separate from current device eligibility', () => {
    const nonCoordinator = activeSnapshot();
    if (!nonCoordinator.viewer) throw new Error('fixture');
    nonCoordinator.viewer.coordinatorEligible = false;
    nonCoordinator.presence.coordinatorParticipantId = null;
    expect(parseProRoomSnapshot(nonCoordinator)).not.toBeNull();

    nonCoordinator.presence.coordinatorParticipantId = PARTICIPANT_ID;
    expect(parseProRoomSnapshot(nonCoordinator)).toBeNull();
  });

  it('requires a suspended room to sleep and strips all effective capabilities', () => {
    const suspended = activeSnapshot();
    suspended.status = 'suspended';
    suspended.runtime = 'sleeping';
    suspended.presence.participants = [];
    suspended.presence.coordinatorParticipantId = null;
    if (!suspended.viewer) throw new Error('fixture');
    suspended.viewer.capabilities = [];
    suspended.viewer.coordinatorEligible = false;
    expect(parseProRoomSnapshot(suspended)).not.toBeNull();

    suspended.viewer.capabilities = ['playback.control'];
    expect(parseProRoomSnapshot(suspended)).toBeNull();
  });

  it('enforces queue, playback, presence, coordinator epoch, and quota invariants', () => {
    const missingCurrent = activeSnapshot();
    missingCurrent.currentQueueItemId = '33333333-3333-4333-8333-333333333333';
    expect(parseProRoomSnapshot(missingCurrent)).toBeNull();

    const staleAnchor = activeSnapshot();
    staleAnchor.playback.coordinatorEpoch += 1;
    expect(parseProRoomSnapshot(staleAnchor)).toBeNull();

    const absentCoordinator = activeSnapshot();
    absentCoordinator.presence.coordinatorParticipantId = 'participant_99999';
    expect(parseProRoomSnapshot(absentCoordinator)).toBeNull();

    const overQuota = activeSnapshot();
    overQuota.quota.usedBytes = PRO_ROOM_QUOTA_BYTES;
    overQuota.quota.reservedBytes = 1;
    expect(parseProRoomSnapshot(overQuota)).toBeNull();
  });

  it('pairs a YouTube checkpoint with its exact video and sub-item index only', () => {
    const youtube = activeSnapshot();
    youtube.currentQueueItemId = Q2;
    youtube.playback = {
      ...youtube.playback,
      queueItemId: Q2,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 7,
    };
    expect(parseProRoomSnapshot(youtube)).not.toBeNull();

    youtube.playback.youtubeSubIndex = null;
    expect(parseProRoomSnapshot(youtube)).toBeNull();

    youtube.playback.youtubeSubIndex = 7;
    youtube.playback.youtubeVideoId = null;
    expect(parseProRoomSnapshot(youtube)).toBeNull();
  });

  it('permits repeated R2 assets as distinct queue occurrences but not duplicate queue IDs', () => {
    const repeatedAsset = activeSnapshot();
    const first = repeatedAsset.playlist[0];
    if (!first) throw new Error('fixture');
    repeatedAsset.playlist.push({ ...structuredClone(first), queueItemId: Q2 });
    repeatedAsset.playlist.splice(1, 1);
    expect(parseProRoomSnapshot(repeatedAsset)).not.toBeNull();

    repeatedAsset.playlist.push(structuredClone(repeatedAsset.playlist[0]!));
    expect(parseProRoomSnapshot(repeatedAsset)).toBeNull();
  });

  it('accepts controller member management but rejects owner-only room configuration', () => {
    const extra = activeSnapshot() as unknown as Record<string, unknown>;
    extra.debug = true;
    expect(parseProRoomSnapshot(extra)).toBeNull();

    const controller = activeSnapshot();
    if (!controller.viewer) throw new Error('fixture');
    controller.viewer.role = 'controller';
    controller.viewer.capabilities = OWNER_CAPABILITIES.filter(
      (capability) => capability !== 'room.configure',
    );
    controller.presence.participants[0]!.role = 'controller';
    expect(parseProRoomSnapshot(controller)).not.toBeNull();

    controller.viewer.capabilities.push('room.configure');
    expect(parseProRoomSnapshot(controller)).toBeNull();
  });
});

describe('monotonic PRO snapshot application', () => {
  it('applies the first/newer snapshot and identifies duplicate, stale, and conflict frames', () => {
    const current = activeSnapshot();

    expect(applyProRoomSnapshotMonotonically(null, current)).toEqual({
      outcome: 'applied',
      snapshot: current,
    });
    expect(applyProRoomSnapshotMonotonically(current, structuredClone(current)).outcome).toBe(
      'duplicate',
    );

    const reorderedCapabilities = structuredClone(current);
    reorderedCapabilities.viewer?.capabilities.reverse();
    expect(applyProRoomSnapshotMonotonically(current, reorderedCapabilities).outcome).toBe(
      'duplicate',
    );

    const stale = activeSnapshot();
    stale.revision -= 1;
    expect(applyProRoomSnapshotMonotonically(current, stale).outcome).toBe('stale');

    const conflict = activeSnapshot();
    conflict.playback.positionSeconds += 1;
    expect(applyProRoomSnapshotMonotonically(current, conflict).outcome).toBe('conflict');

    const newer = activeSnapshot();
    newer.revision += 1;
    newer.playback.revision += 1;
    newer.playback.positionSeconds += 1;
    expect(applyProRoomSnapshotMonotonically(current, newer)).toEqual({
      outcome: 'applied',
      snapshot: newer,
    });
  });

  it('rejects component rollback but permits a reset revision after a coordinator epoch change', () => {
    const current = activeSnapshot();
    const rollback = activeSnapshot();
    rollback.revision += 1;
    rollback.playlistRevision -= 1;
    expect(applyProRoomSnapshotMonotonically(current, rollback).outcome).toBe('conflict');

    const failover = activeSnapshot();
    failover.revision += 1;
    failover.presence.revision += 1;
    failover.presence.coordinatorEpoch += 1;
    failover.playback.coordinatorEpoch += 1;
    failover.playback.revision = 0;
    expect(applyProRoomSnapshotMonotonically(current, failover).outcome).toBe('applied');
  });

  it('does not replace current state for another room or an invalid snapshot', () => {
    const current = activeSnapshot();
    const otherRoom = activeSnapshot();
    otherRoom.roomCode = '000000';
    otherRoom.revision += 1;
    expect(applyProRoomSnapshotMonotonically(current, otherRoom)).toEqual({
      outcome: 'conflict',
      snapshot: current,
    });

    expect(applyProRoomSnapshotMonotonically(current, { revision: 999 })).toEqual({
      outcome: 'invalid',
      snapshot: current,
    });
  });
});
