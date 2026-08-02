import { describe, expect, it } from 'vitest';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_MAX_PRESENCE_ITEMS,
  PRO_ROOM_MAX_YOUTUBE_MANIFEST_ITEMS,
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
  'members.manage',
  'room.configure',
];

const OWNER_PERMISSIONS = {
  'media.add': true,
  'playback.control': true,
  'members.kick': true,
  'chat.notice': true,
} as const;

function activeSnapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: '000001',
    status: 'active',
    runtime: 'awake',
    revision: 12,
    playlistRevision: 7,
    effectsRevision: 2,
    queueModeRevision: 3,
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
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          memberId: MEMBER_ID,
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Owner',
          devicePlatform: 'other',
          role: 'owner',
          capabilities: [...OWNER_CAPABILITIES],
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
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Owner',
      role: 'owner',
      capabilities: [...OWNER_CAPABILITIES],
      coordinatorEligible: false,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: MEMBER_ID,
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: { ...OWNER_PERMISSIONS },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
    ],
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
    effectsRevision: 0,
    queueModeRevision: 0,
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
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: MEMBER_ID,
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: { ...OWNER_PERMISSIONS },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 0,
      },
    ],
  };
}

function authorityMemberSnapshot(capabilities: ProRoomCapability[]): ProRoomSnapshot {
  const value = activeSnapshot();
  const memberId = 'member_ordinary_0001';
  value.memberIdentityVersion = 1;
  value.authorityVersion = 1;
  value.administrators = [
    {
      memberId: 'member_owner_0000001',
      memberDisplayNumber: 0,
      isAuthenticated: true,
      displayName: 'Owner',
      role: 'owner',
      permissions: {
        'media.add': true,
        'playback.control': true,
        'members.kick': true,
        'chat.notice': true,
      },
      inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
      onlineDeviceCount: 0,
    },
  ];
  value.viewer = {
    ...value.viewer!,
    memberId,
    memberDisplayNumber: 1,
    isAuthenticated: true,
    displayName: 'Member',
    role: 'member',
    capabilities: [...capabilities],
  };
  value.presence.participants = [
    {
      ...value.presence.participants[0]!,
      memberId,
      memberDisplayNumber: 1,
      isAuthenticated: true,
      displayName: 'Member',
      role: 'member',
      capabilities: [...capabilities],
    },
  ];
  return value;
}

describe('PRO room roles and credentials', () => {
  it('lets trusted controllers manage members while reserving room configuration for owners', () => {
    const delegatedPermissions = {
      'media.add': true,
      'playback.control': true,
      'members.kick': true,
      'chat.notice': false,
    } as const;
    expect(capabilitiesForProRoomRole('controller')).toEqual([]);
    expect(capabilitiesForProRoomRole('controller', delegatedPermissions)).toEqual([
      'queue.mutate',
      'playback.control',
      'asset.upload',
      'members.manage',
    ]);
    expect(capabilitiesForProRoomRole('owner')).toEqual(OWNER_CAPABILITIES);
    expect(capabilitiesForProRoomRole('member')).toEqual([]);
    expect(proRoomRoleCan('controller', 'playback.control', delegatedPermissions)).toBe(true);
    expect(proRoomRoleCan('controller', 'members.manage', delegatedPermissions)).toBe(true);
    expect(proRoomRoleCan('controller', 'room.configure', delegatedPermissions)).toBe(false);
    expect(proRoomRoleCan('owner', 'members.manage')).toBe(true);
    expect(proRoomRoleCan('member', 'playback.control')).toBe(false);
    expect(proRoomRoleCan('member', 'queue.mutate')).toBe(false);
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

  it('strictly validates an ordered YouTube playlist manifest without deduplicating occurrences', () => {
    const item = structuredClone(activeSnapshot().playlist[1]);
    if (item?.source.kind !== 'youtube') throw new Error('fixture');
    item.source.videoIds = ['dQw4w9WgXcQ', 'aaaaaaaaaaa', 'dQw4w9WgXcQ'];
    expect(parseProRoomPlaylistItem(item)?.source).toEqual(item.source);

    const detached = parseProRoomPlaylistItem(item);
    item.source.videoIds[1] = 'bbbbbbbbbbb';
    expect(detached?.source.kind === 'youtube' ? detached.source.videoIds?.[1] : null).toBe(
      'aaaaaaaaaaa',
    );

    const withoutPlaylist = structuredClone(item);
    if (withoutPlaylist.source.kind !== 'youtube') throw new Error('fixture');
    delete withoutPlaylist.source.playlistId;
    expect(parseProRoomPlaylistItem(withoutPlaylist)).toBeNull();

    const nonFirstEntry = structuredClone(item);
    if (nonFirstEntry.source.kind !== 'youtube' || !nonFirstEntry.source.videoIds) {
      throw new Error('fixture');
    }
    nonFirstEntry.source.videoIds = ['aaaaaaaaaaa', nonFirstEntry.source.videoId];
    expect(parseProRoomPlaylistItem(nonFirstEntry)).not.toBeNull();
    nonFirstEntry.source.videoIds = ['aaaaaaaaaaa'];
    expect(parseProRoomPlaylistItem(nonFirstEntry)).toBeNull();

    const tooLarge = structuredClone(item);
    if (tooLarge.source.kind !== 'youtube') throw new Error('fixture');
    tooLarge.source.videoIds = Array.from(
      { length: PRO_ROOM_MAX_YOUTUBE_MANIFEST_ITEMS + 1 },
      () => tooLarge.source.kind === 'youtube' && tooLarge.source.videoId,
    ).filter((videoId): videoId is string => typeof videoId === 'string');
    expect(parseProRoomPlaylistItem(tooLarge)).toBeNull();
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

  it('accepts only coarse device-platform categories in presence snapshots', () => {
    const known = activeSnapshot();
    known.presence.participants[0]!.devicePlatform = 'ios';
    expect(parseProRoomSnapshot(known)?.presence.participants[0]?.devicePlatform).toBe('ios');

    const unknown = activeSnapshot();
    (unknown.presence.participants[0] as unknown as Record<string, unknown>).devicePlatform =
      'freebsd';
    expect(parseProRoomSnapshot(unknown)).toBeNull();

    const nonString = activeSnapshot();
    (nonString.presence.participants[0] as unknown as Record<string, unknown>).devicePlatform = 42;
    expect(parseProRoomSnapshot(nonString)).toBeNull();
  });

  it('accepts least-privilege members and rejects the retired playback-capable member shape', () => {
    const denied = parseProRoomSnapshot(authorityMemberSnapshot([]));
    expect(denied?.viewer?.capabilities).toEqual([]);
    expect(denied?.presence.participants[0]?.capabilities).toEqual([]);

    expect(parseProRoomSnapshot(authorityMemberSnapshot(['playback.control']))).toBeNull();
    expect(parseProRoomSnapshot(authorityMemberSnapshot(['queue.mutate']))).toBeNull();
  });

  it('rejects snapshots missing any launch authority projection field', () => {
    for (const field of ['authorityVersion', 'administrators'] as const) {
      const incomplete = structuredClone(activeSnapshot()) as unknown as Record<string, unknown>;
      delete incomplete[field];
      expect(parseProRoomSnapshot(incomplete)).toBeNull();
    }

    const participantWithoutCapabilities = structuredClone(activeSnapshot()) as unknown as Record<
      string,
      unknown
    >;
    const presence = participantWithoutCapabilities.presence as Record<string, unknown>;
    const participants = presence.participants as Record<string, unknown>[];
    delete participants[0]!.capabilities;
    expect(parseProRoomSnapshot(participantWithoutCapabilities)).toBeNull();
  });

  it('requires non-negative safe effects and queue-mode revision heads', () => {
    const missingEffects = activeSnapshot() as unknown as Record<string, unknown>;
    delete missingEffects.effectsRevision;
    expect(parseProRoomSnapshot(missingEffects)).toBeNull();

    const malformedEffects = activeSnapshot();
    malformedEffects.effectsRevision = -1;
    expect(parseProRoomSnapshot(malformedEffects)).toBeNull();

    const malformedQueueMode = activeSnapshot();
    malformedQueueMode.queueModeRevision = Number.MAX_SAFE_INTEGER + 1;
    expect(parseProRoomSnapshot(malformedQueueMode)).toBeNull();
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
    sleeping.administrators[0]!.onlineDeviceCount = 0;
    expect(parseProRoomSnapshot(sleeping)).not.toBeNull();
  });

  it('accepts coordinator-free authority and rejects a stale elected-browser snapshot', () => {
    const coordinatorFree = activeSnapshot();
    expect(parseProRoomSnapshot(coordinatorFree)).not.toBeNull();

    coordinatorFree.presence.coordinatorParticipantId = PARTICIPANT_ID;
    expect(parseProRoomSnapshot(coordinatorFree)).toBeNull();
  });

  it('requires a suspended room to sleep and strips all effective capabilities', () => {
    const suspended = activeSnapshot();
    suspended.status = 'suspended';
    suspended.runtime = 'sleeping';
    suspended.presence.participants = [];
    suspended.presence.coordinatorParticipantId = null;
    suspended.administrators[0]!.onlineDeviceCount = 0;
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

  it('accepts at most 100 connected devices in a PRO presence snapshot', () => {
    const atCapacity = activeSnapshot();
    const coordinator = atCapacity.presence.participants[0]!;
    atCapacity.presence.participants = Array.from(
      { length: PRO_ROOM_MAX_PRESENCE_ITEMS },
      (_, index) =>
        index === 0
          ? coordinator
          : {
              participantId: `capacity_participant_${String(index).padStart(5, '0')}`,
              memberId: `capacity_member_${String(index).padStart(5, '0')}`,
              memberDisplayNumber: index,
              isAuthenticated: true,
              displayName: `Member ${index}`,
              devicePlatform: 'other' as const,
              role: 'member' as const,
              capabilities: [],
              joinedAtMs: coordinator.joinedAtMs + index,
            },
    );
    expect(parseProRoomSnapshot(atCapacity)).not.toBeNull();

    atCapacity.presence.participants.push({
      participantId: 'capacity_participant_00100',
      memberId: 'capacity_member_00100',
      memberDisplayNumber: 100,
      isAuthenticated: true,
      displayName: 'Over capacity',
      devicePlatform: 'other',
      role: 'member',
      capabilities: [],
      joinedAtMs: coordinator.joinedAtMs + PRO_ROOM_MAX_PRESENCE_ITEMS,
    });
    expect(parseProRoomSnapshot(atCapacity)).toBeNull();
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

  it('requires a manifested YouTube checkpoint to match the canonical ID at its index', () => {
    const youtube = activeSnapshot();
    const item = youtube.playlist[1]!;
    if (item.source.kind !== 'youtube') throw new Error('fixture');
    item.source.videoIds = ['dQw4w9WgXcQ', 'aaaaaaaaaaa'];
    youtube.currentQueueItemId = Q2;
    youtube.playback = {
      ...youtube.playback,
      queueItemId: Q2,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubeSubIndex: 1,
    };
    expect(parseProRoomSnapshot(youtube)).not.toBeNull();

    youtube.playback.youtubeVideoId = 'dQw4w9WgXcQ';
    expect(parseProRoomSnapshot(youtube)).toBeNull();
    youtube.playback.youtubeVideoId = 'aaaaaaaaaaa';
    youtube.playback.youtubeSubIndex = 2;
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
    const controllerMemberId = 'member_controller_0001';
    const delegatedPermissions = {
      'media.add': true,
      'playback.control': true,
      'members.kick': true,
      'chat.notice': false,
    } as const;
    const delegatedCapabilities = capabilitiesForProRoomRole('controller', delegatedPermissions);
    controller.viewer.memberId = controllerMemberId;
    controller.viewer.memberDisplayNumber = 1;
    controller.viewer.role = 'controller';
    controller.viewer.capabilities = [...delegatedCapabilities];
    controller.presence.participants[0] = {
      ...controller.presence.participants[0]!,
      memberId: controllerMemberId,
      memberDisplayNumber: 1,
      role: 'controller',
      capabilities: [...delegatedCapabilities],
    };
    controller.administrators[0]!.onlineDeviceCount = 0;
    controller.administrators.push({
      memberId: controllerMemberId,
      memberDisplayNumber: 1,
      isAuthenticated: true,
      displayName: 'Owner',
      role: 'controller',
      permissions: { ...delegatedPermissions },
      inheritedPermissions: [],
      onlineDeviceCount: 1,
    });
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
