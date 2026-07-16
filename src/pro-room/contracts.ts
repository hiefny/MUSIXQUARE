import type { QueueItemId } from '../types/index.ts';

export const PRO_ROOM_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const PRO_ROOM_QUOTA_BYTES = 1024 * 1024 * 1024;
export const PRO_ROOM_MAX_ASSET_BYTES = 200 * 1024 * 1024;
export const PRO_ROOM_MAX_PLAYLIST_ITEMS = 1000;
/** One elected coordinator plus at most 99 connected members. */
export const PRO_ROOM_MAX_PRESENCE_ITEMS = 100;

export type ProRoomStatus = 'unactivated' | 'active' | 'suspended';
export type ProRoomRuntimeStatus = 'awake' | 'sleeping';
export type ProRoomRole = 'owner' | 'controller';

export type ProRoomCapability =
  | 'queue.mutate'
  | 'playback.control'
  | 'effects.control'
  | 'asset.upload'
  | 'members.manage'
  | 'room.configure'
  | 'coordinator.eligible';

const CONTROLLER_CAPABILITIES = [
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'coordinator.eligible',
  'members.manage',
] as const satisfies readonly ProRoomCapability[];

const OWNER_CAPABILITIES = [
  ...CONTROLLER_CAPABILITIES,
  'room.configure',
] as const satisfies readonly ProRoomCapability[];

export function capabilitiesForProRoomRole(role: ProRoomRole): readonly ProRoomCapability[] {
  return role === 'owner' ? OWNER_CAPABILITIES : CONTROLLER_CAPABILITIES;
}

function proRoomRoleCan(role: ProRoomRole, capability: ProRoomCapability): boolean {
  return (capabilitiesForProRoomRole(role) as readonly ProRoomCapability[]).includes(capability);
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
  displayName: string;
  role: ProRoomRole;
  joinedAtMs: number;
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
  playlist: ProRoomPlaylistWireItem[];
  currentQueueItemId: QueueItemId | null;
  playback: ProRoomPlaybackCheckpoint;
  presence: ProRoomPresenceSnapshot;
  quota: ProRoomQuotaSnapshot;
  viewer: ProRoomViewerSnapshot | null;
}

export type ProRoomSnapshot = ProRoomSnapshotV1;
