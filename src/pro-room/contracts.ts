import type { DevicePlatform, QueueItemId } from '../types/index.ts';

export const PRO_ROOM_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const PRO_ROOM_QUOTA_BYTES = 1024 * 1024 * 1024;
export const PRO_ROOM_MAX_ASSET_BYTES = 200 * 1024 * 1024;
export const PRO_ROOM_MAX_PLAYLIST_ITEMS = 1000;
export const PRO_ROOM_MAX_YOUTUBE_MANIFEST_ITEMS = 5000;
/** At most 100 equal connected participants. */
export const PRO_ROOM_MAX_PRESENCE_ITEMS = 100;

export type ProRoomStatus = 'unactivated' | 'active' | 'suspended';
export type ProRoomRuntimeStatus = 'awake' | 'sleeping';
export type ProRoomRole = 'owner' | 'controller' | 'member';

export type ProRoomPermission = 'media.add' | 'playback.control' | 'members.kick' | 'chat.notice';

export type ProRoomPermissionSet = Record<ProRoomPermission, boolean>;

export type ProRoomCapability =
  | 'queue.mutate'
  | 'playback.control'
  | 'effects.control'
  | 'asset.upload'
  | 'members.manage'
  | 'room.configure'
  | 'coordinator.eligible';

const MEMBER_CAPABILITIES = [] as const satisfies readonly ProRoomCapability[];

const OWNER_CAPABILITIES = [
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'members.manage',
  'room.configure',
] as const satisfies readonly ProRoomCapability[];

export function capabilitiesForProRoomRole(
  role: ProRoomRole,
  permissions: Readonly<ProRoomPermissionSet> | null = null,
): readonly ProRoomCapability[] {
  if (role === 'owner') return OWNER_CAPABILITIES;
  if (role === 'member' || !permissions) return MEMBER_CAPABILITIES;
  return [
    // `media.add` is retained as the v1 permission key, but represents the
    // complete media-management surface: add/upload, remove, and reorder.
    ...(permissions['media.add'] ? (['queue.mutate'] as const) : []),
    ...(permissions['playback.control'] ? (['playback.control'] as const) : []),
    ...(permissions['media.add'] ? (['asset.upload'] as const) : []),
    ...(permissions['members.kick'] ? (['members.manage'] as const) : []),
  ];
}

function proRoomRoleCan(
  role: ProRoomRole,
  capability: ProRoomCapability,
  permissions: Readonly<ProRoomPermissionSet> | null = null,
): boolean {
  return capabilitiesForProRoomRole(role, permissions).includes(capability);
}

export { proRoomRoleCan as proRoomRoleCanForTests };

interface ProRoomPlaylistItemBase {
  queueItemId: QueueItemId;
  name: string;
  title?: string;
  artist?: string;
  thumbnail?: string;
}

/** A canonical YouTube source persisted by the PRO room service. */
export interface ProRoomYouTubeSource {
  kind: 'youtube';
  videoId: string;
  playlistId?: string;
  /**
   * Canonical, room-owned order for a persisted YouTube playlist. Older
   * snapshots may omit it. `videoId` identifies this row's entry point and
   * must occur in this natural playlist order.
   */
  videoIds?: string[];
}

/**
 * A private R2 object reference. `assetId` and `version` form a stable cache
 * identity. An R2 key or signed URL must never enter the persistent playlist.
 */
export interface ProRoomR2Source {
  kind: 'pro-r2';
  assetId: string;
  version: number;
  byteLength: number;
  mime: string;
  sha256?: string;
}

export type ProRoomMediaSource = ProRoomYouTubeSource | ProRoomR2Source;

export interface ProRoomPlaylistWireItem extends ProRoomPlaylistItemBase {
  source: ProRoomMediaSource;
}

type ProRoomPlaybackState = 'idle' | 'playing' | 'paused';

export interface ProRoomPlaybackCheckpoint {
  coordinatorEpoch: number;
  revision: number;
  state: ProRoomPlaybackState;
  queueItemId: QueueItemId | null;
  positionSeconds: number;
  /** Exact video currently playing inside a persisted YouTube playlist item. */
  youtubeVideoId: string | null;
  /** Zero-based sub-item index paired with `youtubeVideoId`. */
  youtubeSubIndex: number | null;
  updatedAtMs: number;
}

export interface ProRoomPresenceParticipant {
  participantId: string;
  /** Room-scoped person identity. */
  memberId: string;
  /** Stable room-member number; several devices may share it. */
  memberDisplayNumber: number;
  isAuthenticated: boolean;
  displayName: string;
  /** Coarse active-device OS category; no raw UA or hardware model. */
  devicePlatform: DevicePlatform;
  role: ProRoomRole;
  /** Effective server authority. */
  capabilities: ProRoomCapability[];
  joinedAtMs: number;
}

export interface ProRoomAdministrator {
  memberId: string;
  memberDisplayNumber: number;
  isAuthenticated: boolean;
  displayName: string;
  role: 'owner' | 'controller';
  permissions: ProRoomPermissionSet;
  /** Baseline permissions that cannot be disabled by delegation. */
  inheritedPermissions: ProRoomPermission[];
  onlineDeviceCount: number;
}

export interface ProRoomPresenceSnapshot {
  coordinatorEpoch: number;
  revision: number;
  coordinatorParticipantId: string | null;
  participants: ProRoomPresenceParticipant[];
}

export interface ProRoomQuotaSnapshot {
  limitBytes: number;
  perAssetLimitBytes: number;
  usedBytes: number;
  reservedBytes: number;
}

export interface ProRoomViewerSnapshot {
  memberId: string;
  memberDisplayNumber: number;
  isAuthenticated: boolean;
  participantId: string;
  /** Server-issued nonce identifying this tab/resume presence incarnation. */
  presenceIncarnationId: string;
  displayName: string;
  role: ProRoomRole;
  capabilities: ProRoomCapability[];
  coordinatorEligible: boolean;
}

export type ProRoomSystemAudioStatus = 'idle' | 'preparing' | 'live';

/** Public Cloudflare Realtime coordinates. Ownership credentials never enter this value. */
export interface ProRoomSystemAudioPublication {
  publicationId: string;
  sessionId: string;
  tracks: [ProRoomSystemAudioPublicationTrack, ProRoomSystemAudioPublicationTrack];
}

export interface ProRoomSystemAudioPublicationTrack {
  trackName: string;
  channel: 'L' | 'R';
  mid?: string;
}

interface ProRoomSystemAudioStateBase {
  /** Monotonic fencing generation advanced whenever ownership is revoked or replaced. */
  generation: number;
  status: ProRoomSystemAudioStatus;
  ownerParticipantId: string | null;
  claimExpiresAt: number | null;
  liveExpiresAt: number | null;
  publication: ProRoomSystemAudioPublication | null;
}

interface ProRoomSystemAudioIdleState extends ProRoomSystemAudioStateBase {
  status: 'idle';
  ownerParticipantId: null;
  claimExpiresAt: null;
  liveExpiresAt: null;
  publication: null;
}

interface ProRoomSystemAudioPreparingState extends ProRoomSystemAudioStateBase {
  status: 'preparing';
  ownerParticipantId: string;
  claimExpiresAt: number;
  liveExpiresAt: null;
  publication: null;
}

interface ProRoomSystemAudioLiveState extends ProRoomSystemAudioStateBase {
  status: 'live';
  ownerParticipantId: string;
  claimExpiresAt: null;
  liveExpiresAt: number;
  publication: ProRoomSystemAudioPublication;
}

/**
 * Authoritative PRO live-share ownership returned by the dedicated
 * `/system-audio` resource. It deliberately stays outside snapshot v1 so old
 * strict clients can keep joining during a rolling deployment.
 */
export type ProRoomSystemAudioState =
  | ProRoomSystemAudioIdleState
  | ProRoomSystemAudioPreparingState
  | ProRoomSystemAudioLiveState;

/** Authoritative, fully validated room state returned after activation/authentication. */
interface ProRoomSnapshotV1 {
  schemaVersion: typeof PRO_ROOM_SNAPSHOT_SCHEMA_VERSION;
  roomCode: string;
  status: ProRoomStatus;
  runtime: ProRoomRuntimeStatus;
  revision: number;
  playlistRevision: number;
  effectsRevision: number;
  queueModeRevision: number;
  playlist: ProRoomPlaylistWireItem[];
  currentQueueItemId: QueueItemId | null;
  playback: ProRoomPlaybackCheckpoint;
  presence: ProRoomPresenceSnapshot;
  quota: ProRoomQuotaSnapshot;
  viewer: ProRoomViewerSnapshot | null;
  memberIdentityVersion: 1;
  authorityVersion: 1;
  administrators: ProRoomAdministrator[];
}

export type ProRoomSnapshot = ProRoomSnapshotV1;
