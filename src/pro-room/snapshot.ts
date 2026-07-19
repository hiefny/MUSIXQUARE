import type { QueueItemId } from '../types/index.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_MAX_PLAYLIST_ITEMS,
  PRO_ROOM_MAX_PRESENCE_ITEMS,
  PRO_ROOM_MAX_YOUTUBE_MANIFEST_ITEMS,
  PRO_ROOM_QUOTA_BYTES,
  PRO_ROOM_SNAPSHOT_SCHEMA_VERSION,
  type ProRoomPlaybackCheckpoint,
  type ProRoomCapability,
  type ProRoomPlaylistWireItem,
  type ProRoomPresenceParticipant,
  type ProRoomPresenceSnapshot,
  type ProRoomQuotaSnapshot,
  type ProRoomRole,
  type ProRoomRuntimeStatus,
  type ProRoomSnapshot,
  type ProRoomStatus,
  type ProRoomSystemAudioPublication,
  type ProRoomSystemAudioPublicationTrack,
  type ProRoomSystemAudioState,
  type ProRoomViewerSnapshot,
} from './contracts.ts';
import { isProRoomCode } from './room-code.ts';

const MAX_TEXT_LENGTH = 2048;
const MAX_DISPLAY_NAME_LENGTH = 64;
const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const SHA256_RE = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const SYSTEM_AUDIO_PUBLIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const MAX_SYSTEM_AUDIO_TRACK_NAME_LENGTH = 160;
const MAX_SYSTEM_AUDIO_MID_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Matches the existing queue model's UUID v4 identity convention without importing UI state. */
export function isProRoomQueueItemId(value: unknown): value is QueueItemId {
  return typeof value === 'string' && QUEUE_ITEM_ID_RE.test(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasExactKeysWithOptionals(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = [...required, ...optional];
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
    Object.keys(record).every((key) => allowed.includes(key))
  );
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTimestampMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isBoundedString(value: unknown, maxLength = MAX_TEXT_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isOptionalBoundedString(value: unknown): value is string | undefined {
  return value === undefined || isBoundedString(value);
}

function parseTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function isRole(value: unknown): value is ProRoomRole {
  return value === 'owner' || value === 'controller';
}

function isStatus(value: unknown): value is ProRoomStatus {
  return value === 'unactivated' || value === 'active' || value === 'suspended';
}

function isRuntimeStatus(value: unknown): value is ProRoomRuntimeStatus {
  return value === 'awake' || value === 'sleeping';
}

function isCapability(value: unknown): value is ProRoomCapability {
  return (
    value === 'queue.mutate' ||
    value === 'playback.control' ||
    value === 'effects.control' ||
    value === 'asset.upload' ||
    value === 'members.manage' ||
    value === 'room.configure' ||
    value === 'coordinator.eligible'
  );
}

function cloneOptionalMetadata(
  item: Record<string, unknown>,
): Pick<ProRoomPlaylistWireItem, 'name' | 'title' | 'artist' | 'thumbnail'> {
  return {
    name: item.name as string,
    ...(item.title === undefined ? {} : { title: item.title as string }),
    ...(item.artist === undefined ? {} : { artist: item.artist as string }),
    ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail as string }),
  };
}

function parseSystemAudioTrack(value: unknown): ProRoomSystemAudioPublicationTrack | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeysWithOptionals(value, ['trackName', 'channel'], ['mid'])) return null;
  const trackName = parseTrimmedString(value.trackName, MAX_SYSTEM_AUDIO_TRACK_NAME_LENGTH);
  const mid =
    value.mid === undefined
      ? undefined
      : parseTrimmedString(value.mid, MAX_SYSTEM_AUDIO_MID_LENGTH);
  if (!trackName || (value.channel !== 'L' && value.channel !== 'R')) return null;
  if (value.mid !== undefined && !mid) return null;
  return {
    trackName,
    channel: value.channel,
    ...(typeof mid === 'string' ? { mid } : {}),
  };
}

export function parseProRoomSystemAudioPublication(
  value: unknown,
): ProRoomSystemAudioPublication | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['publicationId', 'sessionId', 'tracks'])) return null;
  if (
    typeof value.publicationId !== 'string' ||
    !SYSTEM_AUDIO_PUBLIC_ID_RE.test(value.publicationId) ||
    typeof value.sessionId !== 'string' ||
    !SYSTEM_AUDIO_PUBLIC_ID_RE.test(value.sessionId) ||
    !Array.isArray(value.tracks) ||
    value.tracks.length !== 2
  ) {
    return null;
  }
  const leftOrRight = parseSystemAudioTrack(value.tracks[0]);
  const rightOrLeft = parseSystemAudioTrack(value.tracks[1]);
  if (!leftOrRight || !rightOrLeft) return null;
  if (leftOrRight.channel === rightOrLeft.channel) return null;
  if (leftOrRight.trackName === rightOrLeft.trackName) return null;
  if (leftOrRight.mid !== undefined && leftOrRight.mid === rightOrLeft.mid) return null;

  return {
    publicationId: value.publicationId,
    sessionId: value.sessionId,
    tracks: [leftOrRight, rightOrLeft],
  };
}

/** Strict parser for the dedicated authenticated PRO system-audio resource. */
export function parseProRoomSystemAudioState(value: unknown): ProRoomSystemAudioState | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, [
      'generation',
      'status',
      'ownerParticipantId',
      'claimExpiresAt',
      'liveExpiresAt',
      'publication',
    ]) ||
    !isRevision(value.generation)
  ) {
    return null;
  }

  if (value.status === 'idle') {
    if (
      value.ownerParticipantId !== null ||
      value.claimExpiresAt !== null ||
      value.liveExpiresAt !== null ||
      value.publication !== null
    ) {
      return null;
    }
    return {
      generation: value.generation,
      status: 'idle',
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    };
  }

  if (
    value.generation === 0 ||
    typeof value.ownerParticipantId !== 'string' ||
    !OPAQUE_ID_RE.test(value.ownerParticipantId)
  ) {
    return null;
  }

  if (value.status === 'preparing') {
    if (
      !isTimestampMs(value.claimExpiresAt) ||
      value.claimExpiresAt === 0 ||
      value.liveExpiresAt !== null ||
      value.publication !== null
    ) {
      return null;
    }
    return {
      generation: value.generation,
      status: 'preparing',
      ownerParticipantId: value.ownerParticipantId,
      claimExpiresAt: value.claimExpiresAt,
      liveExpiresAt: null,
      publication: null,
    };
  }

  if (value.status === 'live') {
    const publication = parseProRoomSystemAudioPublication(value.publication);
    if (
      value.claimExpiresAt !== null ||
      !isTimestampMs(value.liveExpiresAt) ||
      value.liveExpiresAt === 0 ||
      !publication
    ) {
      return null;
    }
    return {
      generation: value.generation,
      status: 'live',
      ownerParticipantId: value.ownerParticipantId,
      claimExpiresAt: null,
      liveExpiresAt: value.liveExpiresAt,
      publication,
    };
  }

  return null;
}

export function parseProRoomPlaylistItem(value: unknown): ProRoomPlaylistWireItem | null {
  if (!isRecord(value)) return null;
  const requiredBase = ['queueItemId', 'source', 'name'] as const;
  const optionalBase = ['title', 'artist', 'thumbnail'] as const;
  if (!isProRoomQueueItemId(value.queueItemId) || !isBoundedString(value.name)) return null;
  if (!isOptionalBoundedString(value.title)) return null;
  if (!isOptionalBoundedString(value.artist)) return null;
  if (!isOptionalBoundedString(value.thumbnail)) return null;

  if (!hasExactKeysWithOptionals(value, requiredBase, optionalBase)) return null;
  if (!isRecord(value.source)) return null;

  if (value.source.kind === 'youtube') {
    if (!hasExactKeysWithOptionals(value.source, ['kind', 'videoId'], ['playlistId', 'videoIds'])) {
      return null;
    }
    if (
      typeof value.source.videoId !== 'string' ||
      !YOUTUBE_VIDEO_ID_RE.test(value.source.videoId)
    ) {
      return null;
    }
    if (
      value.source.playlistId !== undefined &&
      (typeof value.source.playlistId !== 'string' ||
        !YOUTUBE_PLAYLIST_ID_RE.test(value.source.playlistId))
    ) {
      return null;
    }
    let videoIds: string[] | undefined;
    if (value.source.videoIds !== undefined) {
      if (
        value.source.playlistId === undefined ||
        !Array.isArray(value.source.videoIds) ||
        value.source.videoIds.length === 0 ||
        value.source.videoIds.length > PRO_ROOM_MAX_YOUTUBE_MANIFEST_ITEMS ||
        value.source.videoIds.some(
          (videoId) => typeof videoId !== 'string' || !YOUTUBE_VIDEO_ID_RE.test(videoId),
        ) ||
        !value.source.videoIds.includes(value.source.videoId)
      ) {
        return null;
      }
      // Duplicates are valid playlist occurrences and must retain their order.
      videoIds = [...value.source.videoIds];
    }
    return {
      queueItemId: value.queueItemId,
      ...cloneOptionalMetadata(value),
      source: {
        kind: 'youtube',
        videoId: value.source.videoId,
        ...(value.source.playlistId === undefined ? {} : { playlistId: value.source.playlistId }),
        ...(videoIds === undefined ? {} : { videoIds }),
      },
    };
  }

  if (value.source.kind === 'pro-r2') {
    if (
      !hasExactKeysWithOptionals(
        value.source,
        ['kind', 'assetId', 'version', 'byteLength', 'mime'],
        ['sha256'],
      )
    ) {
      return null;
    }
    if (typeof value.source.assetId !== 'string' || !OPAQUE_ID_RE.test(value.source.assetId)) {
      return null;
    }
    if (!isRevision(value.source.version) || value.source.version === 0) return null;
    if (typeof value.source.mime !== 'string' || !MIME_RE.test(value.source.mime)) return null;
    if (
      !isByteCount(value.source.byteLength) ||
      value.source.byteLength === 0 ||
      value.source.byteLength > PRO_ROOM_MAX_ASSET_BYTES
    ) {
      return null;
    }
    if (
      value.source.sha256 !== undefined &&
      (typeof value.source.sha256 !== 'string' || !SHA256_RE.test(value.source.sha256))
    ) {
      return null;
    }
    return {
      queueItemId: value.queueItemId,
      ...cloneOptionalMetadata(value),
      source: {
        kind: 'pro-r2',
        assetId: value.source.assetId,
        version: value.source.version,
        byteLength: value.source.byteLength,
        mime: value.source.mime,
        ...(value.source.sha256 === undefined ? {} : { sha256: value.source.sha256 }),
      },
    };
  }

  return null;
}

export function parseProRoomPlaybackCheckpoint(value: unknown): ProRoomPlaybackCheckpoint | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, [
      'coordinatorEpoch',
      'revision',
      'state',
      'queueItemId',
      'positionSeconds',
      'youtubeVideoId',
      'youtubeSubIndex',
      'updatedAtMs',
    ])
  ) {
    return null;
  }
  if (
    !isRevision(value.coordinatorEpoch) ||
    !isRevision(value.revision) ||
    !isFiniteNonNegative(value.positionSeconds)
  ) {
    return null;
  }
  if (!isTimestampMs(value.updatedAtMs)) return null;
  if (
    value.youtubeVideoId !== null &&
    (typeof value.youtubeVideoId !== 'string' || !YOUTUBE_VIDEO_ID_RE.test(value.youtubeVideoId))
  ) {
    return null;
  }
  if (value.youtubeSubIndex !== null && !isRevision(value.youtubeSubIndex)) return null;

  if (value.state === 'idle') {
    if (
      value.queueItemId !== null ||
      value.positionSeconds !== 0 ||
      value.youtubeVideoId !== null ||
      value.youtubeSubIndex !== null
    ) {
      return null;
    }
  } else {
    if (value.state !== 'playing' && value.state !== 'paused') return null;
    if (!isProRoomQueueItemId(value.queueItemId)) return null;
  }

  return {
    coordinatorEpoch: value.coordinatorEpoch,
    revision: value.revision,
    state: value.state,
    queueItemId: value.queueItemId,
    positionSeconds: value.positionSeconds,
    youtubeVideoId: value.youtubeVideoId,
    youtubeSubIndex: value.youtubeSubIndex,
    updatedAtMs: value.updatedAtMs,
  };
}

function parsePresenceParticipant(value: unknown): ProRoomPresenceParticipant | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['participantId', 'displayName', 'role', 'joinedAtMs'])) return null;
  if (typeof value.participantId !== 'string' || !OPAQUE_ID_RE.test(value.participantId)) {
    return null;
  }
  if (!isBoundedString(value.displayName, MAX_DISPLAY_NAME_LENGTH)) return null;
  if (!isRole(value.role) || !isTimestampMs(value.joinedAtMs)) return null;
  return {
    participantId: value.participantId,
    displayName: value.displayName,
    role: value.role,
    joinedAtMs: value.joinedAtMs,
  };
}

function parsePresenceSnapshot(value: unknown): ProRoomPresenceSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, [
      'coordinatorEpoch',
      'revision',
      'coordinatorParticipantId',
      'participants',
    ])
  ) {
    return null;
  }
  if (
    !isRevision(value.coordinatorEpoch) ||
    !isRevision(value.revision) ||
    !Array.isArray(value.participants)
  ) {
    return null;
  }
  if (value.participants.length > PRO_ROOM_MAX_PRESENCE_ITEMS) return null;

  const participants: ProRoomPresenceParticipant[] = [];
  const participantIds = new Set<string>();
  for (const rawParticipant of value.participants) {
    const participant = parsePresenceParticipant(rawParticipant);
    if (!participant || participantIds.has(participant.participantId)) return null;
    participantIds.add(participant.participantId);
    participants.push(participant);
  }

  const coordinatorParticipantId = value.coordinatorParticipantId;
  if (
    coordinatorParticipantId !== null &&
    (typeof coordinatorParticipantId !== 'string' || !participantIds.has(coordinatorParticipantId))
  ) {
    return null;
  }
  if (participants.length === 0 && coordinatorParticipantId !== null) return null;

  return {
    coordinatorEpoch: value.coordinatorEpoch,
    revision: value.revision,
    coordinatorParticipantId,
    participants,
  };
}

function parseQuotaSnapshot(value: unknown): ProRoomQuotaSnapshot | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['limitBytes', 'perAssetLimitBytes', 'usedBytes', 'reservedBytes'])) {
    return null;
  }
  if (
    value.limitBytes !== PRO_ROOM_QUOTA_BYTES ||
    value.perAssetLimitBytes !== PRO_ROOM_MAX_ASSET_BYTES ||
    !isByteCount(value.usedBytes) ||
    !isByteCount(value.reservedBytes) ||
    value.usedBytes + value.reservedBytes > value.limitBytes
  ) {
    return null;
  }
  return {
    limitBytes: value.limitBytes,
    perAssetLimitBytes: value.perAssetLimitBytes,
    usedBytes: value.usedBytes,
    reservedBytes: value.reservedBytes,
  };
}

function parseViewerSnapshot(value: unknown): ProRoomViewerSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, [
      'memberId',
      'participantId',
      'presenceIncarnationId',
      'displayName',
      'role',
      'capabilities',
      'coordinatorEligible',
    ])
  ) {
    return null;
  }
  if (typeof value.memberId !== 'string' || !OPAQUE_ID_RE.test(value.memberId)) return null;
  if (typeof value.participantId !== 'string' || !OPAQUE_ID_RE.test(value.participantId)) {
    return null;
  }
  if (
    typeof value.presenceIncarnationId !== 'string' ||
    !OPAQUE_ID_RE.test(value.presenceIncarnationId)
  ) {
    return null;
  }
  if (
    !isBoundedString(value.displayName, MAX_DISPLAY_NAME_LENGTH) ||
    !isRole(value.role) ||
    !Array.isArray(value.capabilities) ||
    typeof value.coordinatorEligible !== 'boolean'
  ) {
    return null;
  }
  const capabilities: ProRoomCapability[] = [];
  const uniqueCapabilities = new Set<ProRoomCapability>();
  for (const capability of value.capabilities) {
    if (!isCapability(capability) || uniqueCapabilities.has(capability)) return null;
    if (value.role === 'controller' && capability === 'room.configure') {
      return null;
    }
    uniqueCapabilities.add(capability);
    capabilities.push(capability);
  }
  const capabilityOrder: readonly ProRoomCapability[] = [
    'queue.mutate',
    'playback.control',
    'effects.control',
    'asset.upload',
    'coordinator.eligible',
    'members.manage',
    'room.configure',
  ];
  capabilities.sort(
    (left, right) => capabilityOrder.indexOf(left) - capabilityOrder.indexOf(right),
  );
  if (value.coordinatorEligible && !capabilities.includes('coordinator.eligible')) return null;

  return {
    memberId: value.memberId,
    participantId: value.participantId,
    presenceIncarnationId: value.presenceIncarnationId,
    displayName: value.displayName,
    role: value.role,
    capabilities,
    coordinatorEligible: value.coordinatorEligible,
  };
}

export function parseProRoomSnapshot(value: unknown): ProRoomSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'roomCode',
      'status',
      'runtime',
      'revision',
      'playlistRevision',
      'effectsRevision',
      'queueModeRevision',
      'playlist',
      'currentQueueItemId',
      'playback',
      'presence',
      'quota',
      'viewer',
    ])
  ) {
    return null;
  }
  if (value.schemaVersion !== PRO_ROOM_SNAPSHOT_SCHEMA_VERSION) return null;
  if (
    !isProRoomCode(value.roomCode) ||
    !isStatus(value.status) ||
    !isRuntimeStatus(value.runtime)
  ) {
    return null;
  }
  if (
    !isRevision(value.revision) ||
    !isRevision(value.playlistRevision) ||
    !isRevision(value.effectsRevision) ||
    !isRevision(value.queueModeRevision)
  ) {
    return null;
  }
  if (!Array.isArray(value.playlist) || value.playlist.length > PRO_ROOM_MAX_PLAYLIST_ITEMS) {
    return null;
  }

  const playlist: ProRoomPlaylistWireItem[] = [];
  const queueItemIds = new Set<QueueItemId>();
  for (const rawItem of value.playlist) {
    const item = parseProRoomPlaylistItem(rawItem);
    if (!item || queueItemIds.has(item.queueItemId)) return null;
    queueItemIds.add(item.queueItemId);
    playlist.push(item);
  }

  const currentQueueItemId = value.currentQueueItemId;
  if (
    currentQueueItemId !== null &&
    (!isProRoomQueueItemId(currentQueueItemId) || !queueItemIds.has(currentQueueItemId))
  ) {
    return null;
  }

  const playback = parseProRoomPlaybackCheckpoint(value.playback);
  const presence = parsePresenceSnapshot(value.presence);
  const quota = parseQuotaSnapshot(value.quota);
  if (!playback || !presence || !quota) return null;
  // PRO v1 is coordinator-free as a protocol invariant. Retaining the field
  // name avoids a mixed-schema rollout, but accepting a non-null participant
  // here would silently revive the retired browser-authority contract.
  if (presence.coordinatorParticipantId !== null) return null;
  if (playback.coordinatorEpoch !== presence.coordinatorEpoch) return null;
  if (playback.queueItemId !== null && !queueItemIds.has(playback.queueItemId)) return null;
  if (playback.queueItemId !== currentQueueItemId) return null;
  if (playback.queueItemId !== null) {
    const playbackItem = playlist.find((item) => item.queueItemId === playback.queueItemId);
    if (!playbackItem) return null;
    if (playbackItem.source.kind === 'youtube') {
      if (playback.youtubeVideoId === null || playback.youtubeSubIndex === null) return null;
      const manifest = playbackItem.source.videoIds;
      if (
        manifest &&
        (playback.youtubeSubIndex >= manifest.length ||
          manifest[playback.youtubeSubIndex] !== playback.youtubeVideoId)
      ) {
        return null;
      }
    } else if (playback.youtubeVideoId !== null || playback.youtubeSubIndex !== null) {
      return null;
    }
  }

  let viewer: ProRoomViewerSnapshot | null = null;
  if (value.viewer !== null) {
    viewer = parseViewerSnapshot(value.viewer);
    if (!viewer) return null;
    if (value.runtime === 'awake') {
      const participant = presence.participants.find(
        (candidate) => candidate.participantId === viewer?.participantId,
      );
      if (
        !participant ||
        participant.role !== viewer.role ||
        participant.displayName !== viewer.displayName
      ) {
        return null;
      }
      if (
        presence.coordinatorParticipantId === viewer.participantId &&
        !viewer.coordinatorEligible
      ) {
        return null;
      }
    }
  }

  if (value.status === 'unactivated') {
    if (
      viewer !== null ||
      playlist.length !== 0 ||
      currentQueueItemId !== null ||
      playback.state !== 'idle' ||
      presence.participants.length !== 0 ||
      quota.usedBytes !== 0 ||
      quota.reservedBytes !== 0
    ) {
      return null;
    }
  } else if (viewer === null) {
    return null;
  }

  if (value.status !== 'active' && value.runtime !== 'sleeping') return null;
  if (
    value.runtime === 'sleeping' &&
    (presence.participants.length !== 0 || presence.coordinatorParticipantId !== null)
  ) {
    return null;
  }
  if (value.runtime === 'awake' && presence.participants.length === 0) return null;

  if (viewer) {
    const expectedCapabilities: ProRoomCapability[] =
      value.status === 'suspended'
        ? []
        : viewer.role === 'owner'
          ? [
              'queue.mutate',
              'playback.control',
              'effects.control',
              'asset.upload',
              'members.manage',
              'room.configure',
            ]
          : [
              'queue.mutate',
              'playback.control',
              'effects.control',
              'asset.upload',
              'members.manage',
            ];
    if (
      viewer.capabilities.length !== expectedCapabilities.length ||
      expectedCapabilities.some((capability) => !viewer.capabilities.includes(capability))
    ) {
      return null;
    }
  }

  return {
    schemaVersion: PRO_ROOM_SNAPSHOT_SCHEMA_VERSION,
    roomCode: value.roomCode,
    status: value.status,
    runtime: value.runtime,
    revision: value.revision,
    playlistRevision: value.playlistRevision,
    effectsRevision: value.effectsRevision,
    queueModeRevision: value.queueModeRevision,
    playlist,
    currentQueueItemId,
    playback,
    presence,
    quota,
    viewer,
  };
}
