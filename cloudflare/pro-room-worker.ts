import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  ACCOUNT_ASSERTION_HEADER,
  verifyAccountAssertion,
} from './account-assertion.ts';
import {
  effectsContractVersion,
  initialEffectsState,
  mergeRoomEffectsPatch,
  normalizeStoredEffects,
  parseRoomEffects,
  parseRoomEffectsPatch,
  publicEffects,
  publicSettingsSync,
} from './pro-room-effects.ts';
import {
  developerQueueMode,
  initialQueueModeState,
  normalizeStoredQueueMode,
  parseQueueModeValues,
  PLAYLIST_MAX_ITEMS,
  publicQueueMode,
  QUEUE_ITEM_ID_RE,
  shuffledQueueItemIds,
} from './pro-room-queue-mode.ts';
import type { StoredQueueMode } from './pro-room-queue-mode.ts';
import {
  capabilitiesFromPermissions,
  clonePermissionSet,
  DELEGATED_ADMIN_PERMISSIONS,
  isProInternalAuthorityPermission,
  MEMBER_PERMISSIONS,
  normalizePermissionSet,
  OWNER_PERMISSIONS,
  PRO_ROOM_PERMISSION_KEYS,
  requiredProSystemMessagePermission,
} from './pro-room-permissions.ts';
import type {
  ProRoomCapability,
  ProRoomPermission,
  ProRoomPermissionSet,
  ProRoomRole,
} from './pro-room-permissions.ts';
import type { RoomEffectsPatch, RoomEffectsState } from './pro-room-effects.ts';
import { hasExactKeys, isSafeNonNegativeInteger } from './pro-room-validation.ts';
import {
  PRO_ROOM_ACTIVATION_CLAIM_MAX_LIFETIME_MS as ACTIVATION_CLAIM_MAX_LIFETIME_MS,
  PRO_ROOM_OWNER_TRANSFER_CLAIM_DEFAULT_LIFETIME_MS as OWNER_TRANSFER_CLAIM_DEFAULT_LIFETIME_MS,
  createProRoomOwnerTransferCommitProof as ownerTransferCommitProof,
  inspectProRoomOwnerTransferClaim as inspectOwnerTransferClaim,
  issueProRoomActivationClaim,
  issueProRoomOwnerRecoveryClaim,
  issueProRoomOwnerTransferClaim,
  verifyProRoomActivationClaim as verifyActivationClaim,
  verifyProRoomOwnerRecoveryClaim as verifyOwnerRecoveryClaim,
  verifyProRoomOwnerTransferRevocationReceipt as verifyOwnerTransferRevocationReceipt,
} from './pro-room-claims.ts';
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  hmacBase64Url,
  hmacBytes,
  randomToken,
  sha256Base64Url,
  sha256Bytes,
} from './pro-room-crypto.ts';
import { isSafeVisibleDisplayName } from './display-name-policy.ts';
import {
  INITIAL_PRO_ROOM_GENERATION,
  isProRoomGeneration,
  proRoomGenerationHeaderValue,
  proRoomMediaPrefix,
  proRoomObjectName,
} from './pro-room-generation.ts';
import { cancelReadableBody, readBodyBytesLimited } from './pro-room-body.ts';
import { gateServiceMaintenance, readServiceMaintenance } from './service-maintenance.ts';
import {
  finalizeProRoomActivationEntitlement,
  reserveProRoomActivationEntitlement,
  reserveProRoomOwnershipTransferEntitlement,
} from './pro-room-grants.ts';

export { MusixquareServiceControl } from './service-control-object.ts';
export {
  issueProRoomActivationClaim,
  issueProRoomOwnerRecoveryClaim,
  issueProRoomOwnerTransferClaim,
} from './pro-room-claims.ts';
export type {
  ProRoomActivationClaimOptions,
  ProRoomOwnerRecoveryClaimOptions,
  ProRoomOwnerTransferClaimOptions,
} from './pro-room-claims.ts';

type JsonRecord = Record<string, unknown>;
type HeaderRecord = Record<string, string>;

interface FetcherPort {
  fetch(request: Request): Promise<Response>;
}

type FetchOperation = (request: Request) => Promise<Response>;

interface DurableObjectNamespacePort {
  idFromName(name: string): unknown;
  get(id: unknown): FetcherPort;
}

interface D1BoundStatementPort {
  first(): Promise<JsonRecord | null>;
  all(): Promise<{ results?: JsonRecord[] }>;
  run(): Promise<unknown>;
}

interface D1PreparedStatementPort {
  bind(...values: unknown[]): D1BoundStatementPort;
}

interface D1DatabasePort {
  prepare(query: string): D1PreparedStatementPort;
  batch?(statements: D1BoundStatementPort[]): Promise<unknown[]>;
}

interface R2ObjectPort {
  readonly key?: string;
  readonly size?: number;
  readonly etag?: string;
  readonly uploaded?: Date;
  readonly customMetadata?: Record<string, string>;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly body?: ReadableStream<Uint8Array>;
}

interface R2BucketPort {
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<unknown>;
  head(key: string): Promise<R2ObjectPort | null>;
  get(key: string): Promise<R2ObjectPort | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: unknown,
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

interface DurableObjectStoragePort {
  get(key: string | string[]): Promise<unknown>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<void>;
  delete(key: string | string[]): Promise<unknown>;
  transaction?<T>(callback: (storage: DurableObjectStoragePort) => Promise<T>): Promise<T>;
  getAlarm?(): Promise<number | null>;
  setAlarm(value: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectStatePort {
  readonly storage: DurableObjectStoragePort;
  blockConcurrencyWhile?<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil?(promise: Promise<unknown>): void;
}

interface ProRoomEnvPort {
  readonly ADMIN_METRICS_DB?: D1DatabasePort;
  readonly ALLOWED_ORIGINS?: unknown;
  readonly ASSET_GC_GRACE_SECONDS?: unknown;
  readonly CF_VERSION_METADATA?: { readonly id?: unknown };
  readonly DECOMMISSION_FINAL_EMPTY_WINDOW_SECONDS?: unknown;
  readonly DEVELOPER_API_DB?: D1DatabasePort;
  readonly DEVELOPER_API_LIMITERS?: DurableObjectNamespacePort;
  readonly MUSIXQUARE_ADMIN_DB?: D1DatabasePort;
  readonly MUSIXQUARE_AUTH_DB?: D1DatabasePort;
  readonly MUSIXQUARE_SERVICE_CONTROL?: unknown;
  readonly MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET?: unknown;
  readonly PRESENCE_TTL_SECONDS?: unknown;
  readonly PRESIGN_TTL_SECONDS?: unknown;
  readonly PRO_MEDIA_BUCKET?: R2BucketPort;
  readonly PRO_ROOM_ACTIVATION_SECRET?: unknown;
  readonly PRO_ROOM_PIN_PEPPER?: unknown;
  readonly PRO_ROOM_RATE_LIMIT_SECRET?: unknown;
  readonly PRO_ROOM_SESSION_SECRET?: unknown;
  readonly PRO_ROOMS?: DurableObjectNamespacePort;
  readonly PRO_SIGNALING_ROOMS?: DurableObjectNamespacePort;
  readonly PRO_SIGNALING_SECRET?: unknown;
  readonly R2_ACCESS_KEY_ID?: unknown;
  readonly R2_ACCOUNT_ID?: unknown;
  readonly R2_BUCKET_NAME?: unknown;
  readonly R2_SECRET_ACCESS_KEY?: unknown;
  readonly RESERVATION_TTL_SECONDS?: unknown;
  readonly SESSION_TTL_SECONDS?: unknown;
}

interface ProRoomWorkerHandler {
  fetch(request: Request, env: ProRoomEnvPort): Promise<Response>;
}

interface PlaylistYouTubeSource {
  kind: 'youtube';
  videoId: string;
  playlistId?: string;
  videoIds?: string[];
}

interface PlaylistR2Source {
  kind: 'pro-r2';
  assetId: string;
  version: number;
  byteLength: number;
  mime: string;
  sha256?: string;
}

type PlaylistSource = PlaylistYouTubeSource | PlaylistR2Source;

interface PlaylistItem {
  queueItemId: string;
  name: string;
  title?: string;
  artist?: string;
  thumbnail?: string;
  source: PlaylistSource;
  developerOwnerKeyId?: string;
}

interface PlaybackState {
  coordinatorEpoch: number;
  revision: number;
  state: 'idle' | 'playing' | 'paused';
  queueItemId: string | null;
  positionSeconds: number;
  updatedAtMs: number;
  youtubeVideoId: string | null;
  youtubeSubIndex: number | null;
}

interface PlaybackMediaIdentity {
  youtubeVideoId: string;
  youtubeSubIndex: number;
}

type PlaybackAuthorityCommand =
  | {
      type: 'play' | 'pause' | 'stop' | 'next' | 'previous';
      baseRevision: number;
    }
  | { type: 'seek'; baseRevision: number; positionSeconds: number }
  | {
      type: 'select';
      baseRevision: number;
      queueItemId: string;
      state: 'playing' | 'paused';
      positionSeconds: number;
      youtubeVideoId?: string;
      youtubeSubIndex?: number;
    }
  | {
      type: 'ended' | 'unavailable';
      baseRevision: number;
      queueItemId: string;
      mediaKind: 'file' | 'youtube';
      observedPositionSeconds: number;
      durationSeconds: number | null;
      youtubeVideoId?: string;
      youtubeSubIndex?: number;
    };

interface PlaybackAuthorityResult {
  status: string | number;
  error?: string;
  event?: JsonRecord | null;
  cancelEvent?: JsonRecord | null;
  transitionId?: string;
  targets?: string[];
}

interface PlaybackOutcome {
  event?: JsonRecord | null;
  cancelEvent?: JsonRecord | null;
  targets?: string[];
}

interface PlaybackBroadcastOptions {
  basePlaybackRevision?: number;
}

interface PresenceRevision {
  coordinatorEpoch: number;
  presenceRevision: number;
}

type PlaybackManifestResult =
  | { error: string; status: number }
  | {
      index: number;
      videoIds: string[];
      mediaIdentity: PlaybackMediaIdentity;
    };

interface RoomSession {
  participantId: string;
  memberId: string;
  memberDisplayNumber?: number;
  peerOrdinal?: number;
  displayName: string;
  role: ProRoomRole;
  authEpoch: number;
  roomGeneration: number;
  createdAtMs: number;
  expiresAtMs: number;
  signalingTicketSequence: number;
  presenceIncarnationId: string | null;
  accountId?: string;
  accountLeaseExpiresAtMs?: number;
}

interface PresenceParticipant {
  participantId: string;
  presenceIncarnationId: string;
  sessionHash: string;
  memberId: string;
  memberDisplayNumber?: number;
  displayName: string;
  role: ProRoomRole;
  accountId?: string;
  developerControlVersion: number;
  devicePlatform: string;
  joinedAtMs: number;
  lastSeenAtMs: number;
}

interface PresenceState {
  coordinatorEpoch: number;
  revision: number;
  coordinatorParticipantId: string | null;
  participants: Record<string, PresenceParticipant>;
}

interface SystemAudioPublication {
  publicationId: string;
  sessionId: string;
  tracks: Array<{
    trackName: string;
    channel: 'L' | 'R';
    mid?: string;
  }>;
}

interface SystemAudioState {
  generation: number;
  status: 'idle' | 'preparing' | 'live';
  ownerParticipantId: string | null;
  ownerPresenceIncarnationId: string | null;
  leaseId: string | null;
  claimExpiresAt: number | null;
  liveExpiresAt: number | null;
  publication: SystemAudioPublication | null;
}

interface RoomQuota {
  limitBytes: number;
  perAssetLimitBytes: number;
  usedBytes: number;
  reservedBytes: number;
}

interface PinRecord {
  salt: string;
  iterations: number;
  hash: string;
}

interface AccountMember {
  memberId: string;
  displayName: string;
  displayNumber: number;
  role: ProRoomRole;
  permissions: ProRoomPermissionSet;
  createdAtMs: number;
  updatedAtMs: number;
}

type AccountMemberWithId = AccountMember & { accountId: string };

interface DetachAccountSessionOptions {
  requireUniqueDisplayNumber?: boolean;
  touchPresence?: boolean;
}

interface OwnerTransferCommitOptions {
  reconcile?: boolean;
}

interface RemoveAccountAuthorityOptions {
  retainDeletionTombstone?: boolean;
  suspensionReason?: 'owner_account_deleted' | 'ownership_transfer_pending';
}

interface AccountAuthorityRemovalResult {
  changed: boolean;
  authorityChanged: boolean;
  ownerAuthorityRemoved: boolean;
  removal: OwnerAuthorityRemoval | null;
  removedSessions: number;
}

interface OwnerAuthorityDetachResponseOptions {
  changed?: boolean;
  removedSessions?: number;
}

interface AnonymousAdministrator {
  memberId: string;
  displayName: string;
  displayNumber: number;
  permissions: ProRoomPermissionSet;
  createdAtMs: number;
  updatedAtMs: number;
}

interface OwnershipTransferPending {
  transferId: string;
  requestId: string;
  targetAccountId: string;
  targetDisplayName: string;
  previousOwnerAccountId: string | null;
  preservedOwnerMemberId: string;
  pin: PinRecord;
  claimNonceHash: string;
  claimGeneration: number;
  ownerAuthorityEpoch: number;
  preparedAtMs: number;
  expiresAtMs: number;
  devicePlatform: string;
  commitProofHash: string;
}

interface OwnershipTransferCompleted {
  transferId: string;
  requestId: string;
  targetAccountId: string;
  previousOwnerAccountId: string | null;
  preservedOwnerMemberId: string;
  claimNonceHash: string;
  commitProofHash: string;
  revocationReceiptHash: string;
  ownerAuthorityEpoch: number;
  authEpoch: number;
  preparedAtMs: number;
  expiresAtMs: number;
  committedAtMs: number;
  replayUntilMs: number;
  sessionTokenHash: string;
  ownerCredentialHash: string;
}

interface OwnerAuthorityRemoval {
  accountId: string;
  removalId: string;
  removedAtMs: number;
  ownerAuthorityEpoch: number;
  fencedCoordinatorEpoch: number;
  projectionAcked: boolean;
}

interface StagingCleanupFields {
  cleanupAfterMs?: number;
  emptySinceMs?: number | null;
  stagingCleanupAfterMs?: number;
  stagingEmptySinceMs?: number | null;
}

interface RoomAsset extends StagingCleanupFields {
  status: 'reserved' | 'ready';
  assetId: string;
  objectKey: string;
  stagingObjectKey?: string;
  version: number;
  byteLength: number;
  mime: string;
  roomGeneration: number;
  sha256?: string;
  expiresAtMs?: number;
  uploadExpiresAtMs?: number;
  gcAfterMs?: number;
  stagingCleanupAfterMs?: number;
  stagingEmptySinceMs?: number | null;
  completedAtMs?: number;
  reservedByParticipantId?: string;
  reservedByDeveloperKeyId?: string;
  developerMetadata?: JsonRecord;
  developerQueueItemId?: string;
  upload?: JsonRecord;
  name?: string;
  createdAtMs?: number;
}

interface RateLimitRecord {
  count: number;
  resetAtMs: number;
}

interface IdempotencyRecord {
  fingerprint: string;
  body?: JsonRecord;
  kind?: string;
  status?: number;
  committedRevision?: number;
  tokenHash?: string;
  participantId?: string;
  expiresAtMs: number;
}

interface DeveloperCommandRecord {
  roomCode: string;
  commandId: string;
  keyId: string;
  idempotencyKey: string;
  status: string;
  attempts?: number;
  nextAttemptAtMs?: number;
  createdAtMs: number;
  expiresAtMs: number;
  retainUntilMs: number;
  coordinatorEpoch: number;
  developerControlVersion: number;
  command: DeveloperControlCommand;
  expected: {
    queueItemId: string | null;
    playlistRevision: number;
    playbackRevision: number;
  };
  resultCode?: string;
  acknowledgedAtMs?: number;
  completedAtMs?: number;
  dispatchCapacityReserve?: boolean;
  terminalCapacityReserve?: boolean;
}

interface DeveloperCommandIdempotencyRecord {
  idempotencyKey: string;
  fingerprint: string;
  commandId: string;
  body: JsonRecord;
  status: number;
  expiresAtMs: number;
}

type DeveloperControlCommand =
  | { type: 'play' | 'pause' | 'next' }
  | { type: 'seek'; positionSeconds: number }
  | { type: 'play_item'; queueItemId: string }
  | { type: 'set_effects'; effects: RoomEffectsPatch };

interface DeveloperMetadata extends JsonRecord {
  name?: string;
  title?: string;
  artist?: string;
  thumbnail?: string;
}

interface DeveloperNamedMetadata extends DeveloperMetadata {
  name: string;
}

interface DeveloperYouTubeItem extends DeveloperNamedMetadata {
  videoId: string;
  playlistId?: string;
  videoIds?: string[];
}

type DeveloperQueueMutation =
  | ({
      type: 'add_youtube';
      videoId: string;
      playlistId?: string;
      videoIds?: string[];
    } & DeveloperNamedMetadata)
  | { type: 'add_youtube_batch'; items: DeveloperYouTubeItem[] }
  | { type: 'remove'; queueItemId: string }
  | { type: 'remove_many'; queueItemIds: string[] }
  | { type: 'clear' }
  | { type: 'clear_owned' }
  | { type: 'reorder'; basePlaylistRevision: number; queueItemIds: string[] };

type BotPlan =
  | { intent: 'add_youtube'; trackQueries: string[]; playAddedIndex: number; answer?: string }
  | { intent: 'play_existing'; queueItemId: string; answer?: string }
  | { intent: 'remove_items'; queueItemIds: string[]; answer?: string }
  | { intent: 'clear_queue'; basePlaylistRevision: number; answer?: string }
  | { intent: 'playback'; playbackCommand: 'play' | 'pause' | 'next'; answer?: string }
  | {
      intent: 'queue_mode';
      repeatMode?: 'off' | 'all' | 'one';
      shuffleEnabled?: boolean;
      answer?: string;
    }
  | { intent: 'virtual_treble'; virtualTrebleEnabled: boolean; answer?: string }
  | { intent: 'answer'; answer: string };

interface DeveloperMediaUpload extends DeveloperNamedMetadata {
  byteLength: number;
  mime: string;
  sha256?: string;
}

interface StagingTombstone extends StagingCleanupFields {
  objectKey: string;
  emptySinceMs?: number | null;
  cleanupAfterMs: number;
}

interface DecommissionState {
  requestId: string;
  startedAtMs: number;
  purgeAfterMs?: number;
  retryAtMs?: number;
  signalingCleared?: boolean;
  initialSweepCompleted?: boolean;
  developerDataCleared?: boolean;
  developerLimiterCleared?: boolean;
  finalEmptySinceMs?: number | null;
  completedAtMs?: number;
  maintenanceAtMs?: number;
}

interface PlaybackTransition {
  transitionId: string;
  coordinatorEpoch: number;
  basePlaybackRevision: number;
  createdAtMs: number;
  deadlineAtMs: number;
  target: PlaybackState;
  cohort: string[];
  ready: Record<string, 'ready' | 'failed'>;
  resumeFromSleep?: true;
  developerCommandId: string | null;
}

interface PlaybackBroadcastRecord {
  kind: 'prepare' | 'cancel' | 'commit';
  coordinatorEpoch: number;
  transitionId: string | null;
  playbackRevision: number;
  basePlaybackRevision: number;
  event: JsonRecord;
  targets: string[];
  attempts: number;
  retryAtMs: number;
  createdAtMs: number;
}

interface PresenceBroadcastRecord {
  coordinatorEpoch: number;
  presenceRevision: number;
  roomRevision: number;
  attempts: number;
  retryAtMs: number;
}

interface ProRoomState {
  v: number;
  roomCode: string;
  roomGeneration: number;
  provisioned: boolean;
  activationClaimGeneration: number;
  ownershipTransferClaimGeneration: number;
  status: 'unactivated' | 'active' | 'suspended' | 'decommissioning' | 'decommissioned';
  suspensionReason: string | null;
  runtime: 'sleeping' | 'awake';
  revision: number;
  playlistRevision: number;
  playlist: PlaylistItem[];
  currentQueueItemId: string | null;
  playback: PlaybackState;
  pendingPlaybackTransition: PlaybackTransition | null;
  pendingPlaybackBroadcasts: PlaybackBroadcastRecord[];
  presence: PresenceState;
  pendingPresenceBroadcast: PresenceBroadcastRecord | null;
  queueMode: StoredQueueMode;
  systemAudio: SystemAudioState;
  effects: RoomEffectsState;
  quota: RoomQuota;
  pin: PinRecord | null;
  authEpoch: number;
  ownerAuthorityEpoch: number;
  developerAuthorityEpoch: number;
  ownerMemberId: string | null;
  ownerAccountId: string | null;
  ownerDisplayName: string | null;
  accountMembers: Record<string, AccountMember>;
  anonymousAdministrators: Record<string, AnonymousAdministrator>;
  accountDeletionTombstones: Record<string, number>;
  nextMemberDisplayNumber: number;
  ownerCredentialHash: string | null;
  pendingOwnershipTransfer: OwnershipTransferPending | null;
  completedOwnershipTransfer: OwnershipTransferCompleted | null;
  ownerAuthorityRemoval: OwnerAuthorityRemoval | null;
  sessions: Record<string, RoomSession>;
  assets: Record<string, RoomAsset>;
  idempotency: Record<string, IdempotencyRecord>;
  developerMutationIdempotency: Record<string, IdempotencyRecord>;
  rateLimits: Record<string, RateLimitRecord>;
  botRateLimits: Record<string, RateLimitRecord>;
  consumedRecoveryNonces: Record<string, number>;
  consumedOwnershipTransferClaims: Record<string, { requestId: string; expiresAtMs: number }>;
  stagingTombstones: Record<string, StagingTombstone>;
  developerCommands: Record<string, DeveloperCommandRecord>;
  developerCommandIdempotency: Record<string, DeveloperCommandIdempotencyRecord>;
  decommission?: DecommissionState;
}

interface InMemoryCheckpoint {
  room: ProRoomState | null;
  persistedPlaylistSignatures: Map<string, string>;
  persistedPresenceLastSeenAtMs: Map<string, number>;
  hasV2Persistence: boolean;
  heartbeatDurabilityDirty: boolean;
  lastHeartbeatDurabilityPersistedAtMs: number | null;
  heartbeatFlushGeneration: number;
  pendingHeartbeatFlushGeneration: number | null;
  pendingHeartbeatFlushTimer: ReturnType<typeof setTimeout> | null;
  scheduledAlarmMs: number | null | undefined;
  systemAudioMigrationPending: boolean;
  effectsMigrationPending: boolean;
  queueModeMigrationPending: boolean;
  accountIdentityMigrationPending: boolean;
  developerCommandMigrationPending: boolean;
  playbackAuthorityMigrationPending: boolean;
  alarmMaintenanceDirty: boolean;
  alarmMaintenanceRetryAttempt: number;
  alarmMaintenanceRetryTimer: ReturnType<typeof setTimeout> | null;
}

interface StoredV2Envelope {
  schemaVersion: number;
  core: Omit<ProRoomState, 'playlist'>;
  playlistOrder: string[];
}

interface PersistOptions {
  heartbeatFlushGeneration?: number;
  flushPlaybackOutbox?: boolean;
  retainEarlierAlarm?: boolean;
}

interface AlarmScheduleOptions {
  retainEarlier?: boolean;
}

interface BotTerminalOptions {
  action: 'remove_items' | 'clear_queue';
  languageHint: string;
  expectedPlaylistRevision?: number;
  terminalScope: string;
  terminalKey: string;
  terminalFingerprint: string;
}

interface DeveloperInvalidationHint {
  actorName?: unknown;
  fallback: string;
  count: number;
  firstTitle?: string;
}

interface AuthenticatedSession {
  tokenHash: string;
  session: RoomSession;
  participant?: PresenceParticipant;
  response?: never;
}

interface ActivePresenceSession extends AuthenticatedSession {
  participant: PresenceParticipant;
}

interface SessionRequirementFailure {
  response: Response;
  tokenHash?: never;
  session?: never;
  participant?: never;
}

type SessionRequirementResult = AuthenticatedSession | SessionRequirementFailure;
type ActivePresenceRequirementResult = ActivePresenceSession | SessionRequirementFailure;

interface RequireSessionOptions {
  owner?: boolean;
  capability?: ProRoomCapability;
  capabilities?: ProRoomCapability[];
  permission?: ProRoomPermission;
  activePresence?: boolean;
}

type ParsedBodyResult =
  | { response: Response; value?: never; empty?: never }
  | { response?: never; value: unknown; empty: boolean };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function matchesPattern(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function isProRoomPermission(value: string): value is keyof ProRoomPermissionSet {
  return PRO_ROOM_PERMISSION_KEYS.some((permission) => permission === value);
}

function r2ListObjectKeys(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.objects)) return [];
  return value.objects.flatMap((object) =>
    isRecord(object) && typeof object.key === 'string' ? [object.key] : [],
  );
}

/**
 * MUSIXQUARE persistent PRO room service.
 *
 * The public bootstrap endpoint intentionally exposes only room status. Owner
 * claim credentials are issued offline with `issueProRoomActivationClaim` and
 * are never returned by this Worker. Persistent room state is serialized by a
 * per-room Durable Object; private media bytes live in a dedicated R2 bucket.
 */

const PRO_ROOM_CODE_RE = /^0\d{5}$/;
const INITIAL_PRO_ROOMS = Object.freeze([
  Object.freeze({ roomCode: '000000', label: 'MUSIXQUARE Developer' }),
]);
const INITIAL_PRO_ROOM_CODES: ReadonlySet<string> = new Set(
  INITIAL_PRO_ROOMS.map((room) => room.roomCode),
);
const OWNER_TRANSFER_COMPLETED_REPLAY_TTL_MS = 10 * 60 * 1000;
const OWNER_TRANSFER_COMPLETED_REPLAY_MAX_LIFETIME_MS = 15 * 60 * 1000;
const PRO_ROOM_REGISTRY_MAX_ITEMS = 1000;
const PRO_ROOM_REGISTRY_REFRESH_MS = 5_000;
const PRO_ROOM_GENERATION_HEADER = 'x-mxqr-pro-room-generation';
const PIN_RE = /^\d{8}$/;
const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{22}$/;
const ACCOUNT_TABLE = 'mxqr_accounts';
const ACCOUNT_DELETION_TABLE = 'mxqr_account_deletions';
const OWNER_TRANSFER_ID_RE = /^transfer_[A-Za-z0-9_-]{22}$/;
const OWNER_TRANSFER_REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const OWNER_AUTHORITY_REMOVAL_ID_RE = /^removal_[A-Za-z0-9_-]{22}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const PRO_ROOM_SESSION_ACTOR_HEADER = 'x-mxqr-pro-session-actor';
const PRO_ROOM_SESSION_ACTOR_RE = /^[A-Za-z0-9_-]{43}$/;
const ADMIN_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const SHA256_RE = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVELOPER_AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'flac',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'webm',
  'aif',
  'aiff',
  'caf',
]);
const SYSTEM_AUDIO_LEASE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const DEVELOPER_API_KEY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const DEVELOPER_COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{22}$/;
const BOT_DEVELOPER_KEY_ID = 'MxqrGeminiBot001';
const BOT_REQUEST_ID_RE = IDEMPOTENCY_KEY_RE;
// A 24-byte random token is encoded as exactly 32 Base64URL characters. Unlike
// public resource identifiers, Base64URL tokens may legitimately begin with
// `-` or `_`; rejecting those values would make a server-issued BOT lease fail
// nondeterministically on its next request.
const BOT_LEASE_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

function proRoomGenerationWireFields(roomGeneration: number) {
  if (!isProRoomGeneration(roomGeneration)) throw new Error('Invalid room generation');
  return { roomGeneration };
}

function proRoomGenerationWireHeaders(roomGeneration: number) {
  if (!isProRoomGeneration(roomGeneration)) throw new Error('Invalid room generation');
  return { [PRO_ROOM_GENERATION_HEADER]: proRoomGenerationHeaderValue(roomGeneration) };
}

function proRoomGenerationUploadMetadataHeaders(roomGeneration: number) {
  if (!isProRoomGeneration(roomGeneration)) throw new Error('Invalid room generation');
  return { 'x-amz-meta-mxqr-generation': proRoomGenerationHeaderValue(roomGeneration) };
}

function responseRoomGenerationMatches(payload: unknown, roomGeneration: number) {
  if (!isRecord(payload) || !isProRoomGeneration(roomGeneration)) return false;
  return payload.roomGeneration === roomGeneration;
}

function exactInternalRoomGeneration(request: Request, payload: unknown) {
  const header = request.headers.get(PRO_ROOM_GENERATION_HEADER);
  if (!/^(?:0|[1-9]\d*)$/.test(header || '')) return null;
  const roomGeneration = Number(header);
  if (!isProRoomGeneration(roomGeneration)) return null;
  return !isRecord(payload) ||
    payload.roomGeneration === undefined ||
    payload.roomGeneration === roomGeneration
    ? roomGeneration
    : null;
}

const SCHEMA_VERSION = 1;
// Keep the bounded core and playlist rows in separate keys so a large queue
// cannot crowd media completion metadata out of the Durable Object record.
const STORAGE_V2_CORE_KEY = 'pro-room:v2:core';
const STORAGE_V2_PLAYLIST_PREFIX = 'pro-room:v2:playlist:';
const STORAGE_V2_SCHEMA_VERSION = 2;
const ROOM_QUOTA_BYTES = 1024 * 1024 * 1024;
const ASSET_MAX_BYTES = 200 * 1024 * 1024;
const DEVELOPER_YOUTUBE_BATCH_MAX_ITEMS = 100;
const YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS = 5000;
const DEVELOPER_REMOVE_MANY_MAX_ITEMS = 20;
const BOT_MAX_TRACK_ITEMS = 3;
const BOT_MEMBER_MINUTE_LIMIT = 3;
const BOT_ROOM_HOUR_LIMIT = 100;
const BOT_MEMBER_MINUTE_MS = 60 * 1000;
const BOT_ROOM_HOUR_MS = 60 * 60 * 1000;
const BOT_REQUEST_LEASE_MS = 45 * 1000;
// Every active PRO participant is an equal room member. Signaling applies the
// same 100-device ceiling to the corresponding authenticated control sockets.
const PRESENCE_MAX_ITEMS = 100;
const SESSION_MAX_ITEMS = 128;
const DEFAULT_PEER_DISPLAY_NAME = 'Peer';
const ASSET_MAX_ITEMS = 1024;
const RESERVED_ASSET_MAX_ITEMS = 32;
const RESERVED_ASSET_MAX_ITEMS_PER_PARTICIPANT = 8;
const RESERVED_ASSET_MAX_ITEMS_PER_DEVELOPER_KEY = 2;
const IDEMPOTENCY_MAX_ITEMS = 256;
// Developer mutations receive their own full 24-hour replay budget. Because
// the complete room core is deliberately bounded to one 1.2 MiB value, this
// ledger cannot grow without limit; once full, new mutations fail closed while
// all accepted receipts remain exact.
const DEVELOPER_MUTATION_IDEMPOTENCY_MAX_ITEMS = 256;
const RATE_LIMIT_MAX_ITEMS = 512;
const BOT_RATE_LIMIT_MAX_ITEMS = 512;
const RECOVERY_NONCE_MAX_ITEMS = 128;
const OWNER_TRANSFER_NONCE_MAX_ITEMS = 128;
const STAGING_TOMBSTONE_MAX_ITEMS = ASSET_MAX_ITEMS;
const DEVELOPER_COMMAND_MAX_ITEMS = 64;
const DEVELOPER_COMMAND_MAX_ACTIVE_ITEMS = 8;
// The command ledger is intentionally separate from the browser mutation
// idempotency ledger. Keeping the API window independent prevents sustained
// automation from evicting a fresh browser receipt and turning a retry into a
// duplicate command.
// One room-bound API key may issue 30 commands/minute; 384 entries preserve a
// full ten-minute window even across a fixed-window rate-limit boundary.
const DEVELOPER_COMMAND_IDEMPOTENCY_MAX_ITEMS = 384;
// SQLite-backed Durable Object KV rejects a single value above 2 MiB. Keep
// enough headroom for storage encoding overhead and future schema additions.
// Playlist rows are stored independently and therefore have their own public
// snapshot budget below the client's 4 MiB response ceiling.
const STATE_MAX_BYTES = 1200 * 1024;
const PLAYLIST_STATE_MAX_BYTES = 3 * 1024 * 1024;
const PLAYLIST_ITEM_MAX_BYTES = 128 * 1024;
// Compact mutations must be able to carry every playlist accepted by the
// 3 MiB persisted-state budget. Keep the endpoint bounded while matching the
// browser client's JSON ceiling.
const REQUEST_MAX_BYTES = 4 * 1024 * 1024;
const PUBLIC_MUTATION_BODY_TIMEOUT_MS = 10_000;
const INTERNAL_REQUEST_BODY_TIMEOUT_MS = 2_000;
const SMALL_REQUEST_MAX_BYTES = 16 * 1024;
const UNLOAD_CLOSE_REQUEST_MAX_BYTES = 4 * 1024;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
// Google account identity is optional and must not inherit the 30-day room
// cookie lifetime. A fresh App-Worker assertion renews this short server-owned
// lease; logout-all therefore removes room authority even when another device
// cannot receive the browser logout event. The remaining lease is also the
// bounded grace window for a transient App/D1 outage.
const ACCOUNT_IDENTITY_LEASE_TTL_MS = 120 * 1000;
const ACCOUNT_IDENTITY_LEASE_RENEW_THRESHOLD_MS = 60 * 1000;
const PRESENCE_TTL_SECONDS = 45;
// Keep this in sync with src/pro-room/runtime.ts. The guard covers one normal
// client interval, one coalescing window, and one storage-retry interval.
const PRESENCE_HEARTBEAT_EXPECTED_INTERVAL_MS = 15_000;
const PRESENCE_HEARTBEAT_PERSIST_COALESCE_MS = 1_000;
const PRESENCE_HEARTBEAT_PERSIST_RETRY_MS = 1_000;
const ALARM_MAINTENANCE_RETRY_MAX_MS = 60_000;
const PRESENCE_HEARTBEAT_PERSIST_EXPIRY_GUARD_MS =
  PRESENCE_HEARTBEAT_EXPECTED_INTERVAL_MS +
  PRESENCE_HEARTBEAT_PERSIST_COALESCE_MS +
  PRESENCE_HEARTBEAT_PERSIST_RETRY_MS;
const PRESENCE_BROADCAST_RETRY_BASE_MS = 1_000;
const PRESENCE_BROADCAST_RETRY_MAX_MS = 60_000;
const PRESENCE_BROADCAST_RETRY_MAX_ATTEMPTS = 16;
const PLAYBACK_BROADCAST_RETRY_BASE_MS = 1_000;
const PLAYBACK_BROADCAST_RETRY_MAX_MS = 60_000;
const PLAYBACK_BROADCAST_RETRY_MAX_ATTEMPTS = 16;
// One undelivered canonical COMMIT may be the base for one newer PREPARE or
// CANCEL. Newer COMMITs supersede both, so the durable playback outbox never
// needs more than these two ordered records.
const PLAYBACK_BROADCAST_OUTBOX_MAX_ITEMS = 2;
const RESERVATION_TTL_SECONDS = 15 * 60;
// A completed upload is deliberately retained long enough for the client to
// append it to the authoritative playlist. If that never happens, the asset is
// an orphan and the Durable Object reclaims it after this grace period.
const ASSET_GC_GRACE_SECONDS = 15 * 60;
const ASSET_GC_RETRY_SECONDS = 60;
// A presigned PUT may have started before its signature expired but become
// visible in R2 only after the first cleanup pass. Keep checking the staging
// key until it has remained absent for the same one-hour continuous-empty
// window used by room decommissioning.
const STAGING_OBJECT_EMPTY_WINDOW_MS = 60 * 60 * 1000;
const PRESIGN_TTL_SECONDS = 10 * 60;
const DECOMMISSION_RETRY_MS = 60 * 1000;
const DECOMMISSION_FINAL_EMPTY_WINDOW_SECONDS = 60 * 60;
const DECOMMISSION_TOMBSTONE_MAINTENANCE_MS = 24 * 60 * 60 * 1000;
const SIGNALING_TICKET_TTL_SECONDS = 90;
const SYSTEM_AUDIO_MAX_PRESENCE_ITEMS = 4;
const SYSTEM_AUDIO_CLAIM_TTL_MS = 45 * 1000;
const SYSTEM_AUDIO_LIVE_TTL_MS = 2 * 60 * 60 * 1000;
const SYSTEM_AUDIO_TRACK_NAME_MAX_LENGTH = 160;
const SYSTEM_AUDIO_TRACK_MID_MAX_LENGTH = 64;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
// Session admission sits behind the App facade's bounded response window. A
// room mutation can therefore commit after the browser receives a gateway
// timeout. Retain a compact receipt long enough for an explicit retry while
// avoiding permanent pressure on the room-wide 256-item browser ledger.
const SESSION_CREATE_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
// Playback controls are high-frequency, short-retry mutations. The browser
// retries one command for at most a few seconds, so retaining every full
// command response for 24 hours can saturate the shared 256-item browser
// ledger during ordinary all-day playback. Keep a generous ten-minute replay
// fence for controls while preserving the 24-hour contract for playlist,
// media, account, and other destructive browser mutations.
const PLAYBACK_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const PLAYBACK_IDEMPOTENCY_SCOPE_SEGMENT = ':playback-authority:';
// workerd rejects PBKDF2 counts above 100,000. Keep the stored record at the
// runtime ceiling so activation and PIN verification use the strongest value
// Cloudflare can execute instead of surfacing an unhandled NotSupportedError.
const PBKDF2_MAX_ITERATIONS = 100_000;
const PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_MEDIA_NAME_LENGTH = 2048;
const MAX_TEXT_LENGTH = 2048;
const PLAYBACK_MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;
const PLAYBACK_TRANSITION_DEADLINE_MS = 3_000;
// Encode the transition kind in a numeric field that older Workers already
// accept. This keeps an in-flight transition readable after a Worker rollback;
// the one millisecond deadline difference is operationally inert.
const PLAYBACK_ZERO_START_TRANSITION_DEADLINE_MS = PLAYBACK_TRANSITION_DEADLINE_MS - 1;
const PLAYBACK_COMMIT_LEAD_MS = 700;
// Strict event parsers make a new COMMIT JSON key unsafe during a rolling PWA
// deployment. A -1ms lead is an inert marker to old clients and lets refreshed
// clients recognize only an explicitly classified true zero-start. Legacy and
// unknown 700ms transitions fail safely as ordinary scheduled controls.
const PLAYBACK_ZERO_START_COMMIT_LEAD_MS = PLAYBACK_COMMIT_LEAD_MS - 1;
// A browser ENDED event is an observation, not a control command.  When the
// media reports a finite duration, require both the browser cursor and the
// server-projected room cursor to be genuinely near that end.  Unknown/live
// durations use the narrower timeline-alignment rule in
// applyPlaybackAuthorityCommand instead of being rejected wholesale.
const PLAYBACK_ENDED_NEAR_END_TOLERANCE_SECONDS = 2;
const PLAYBACK_UNKNOWN_DURATION_POSITION_TOLERANCE_SECONDS = 10;
const PLAYBACK_UNKNOWN_DURATION_MIN_PLAYING_MS = 750;
const PLAYBACK_TRANSITION_ID_RE = /^transition_[A-Za-z0-9_-]{22}$/;
const OWNER_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
// v1 covers direct playback controls and queue invalidations. v2 adds
// set_effects; v3 adds aggregate-aware next; v4 adds a bounded first-track
// title to queue-addition hints. Older frames remain valid so a rolling deploy
// does not strand an already-open tab.
const DEVELOPER_CONTROL_VERSION = 1;
const DEVELOPER_EFFECTS_CONTROL_VERSION = 2;
const DEVELOPER_NEXT_CONTROL_VERSION = 3;
const DEVELOPER_QUEUE_TITLE_CONTROL_VERSION = 4;
const DEVELOPER_CONTROL_MAX_VERSION = DEVELOPER_QUEUE_TITLE_CONTROL_VERSION;
const DEVELOPER_COMMAND_TTL_MS = 30 * 1000;
const DEVELOPER_COMMAND_MAX_ATTEMPTS = 3;
const DEVELOPER_COMMAND_DISPATCH_TIMEOUT_MS = 900;
const INTERNAL_SERVICE_RESPONSE_TIMEOUT_MS = 2_000;
const INTERNAL_SERVICE_RESPONSE_MAX_BYTES = 16 * 1024;
const DEVELOPER_COMMAND_RETENTION_MS = 10 * 60 * 1000;
const DEVELOPER_COMMAND_RESULT_CODES = new Set([
  'applied',
  'already_applied',
  'busy',
  'no_media',
  'stale_queue',
  'unsupported_mode',
  'expired',
  'execution_failed',
]);

const ACCOUNT_MEMBER_MAX_ITEMS = 100;
const ANONYMOUS_ADMIN_MAX_ITEMS = 100;
const ACCOUNT_DELETION_TOMBSTONE_MAX_ITEMS = 256;
const ACCOUNT_DELETION_TOMBSTONE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://musixquare.com',
  'https://www.musixquare.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const encoder = new TextEncoder();

function configuredNumber(
  value: unknown,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function isProRoomCode(value: unknown): value is string {
  return typeof value === 'string' && PRO_ROOM_CODE_RE.test(value);
}

interface ProRoomRegistryCache {
  registered: Map<string, number>;
  suspended: Map<string, number>;
  suspendedRechecks: Map<string, Promise<number | null>>;
  refreshedAtMs: number;
  refreshPromise: Promise<void> | null;
}

const registryCacheByDb = new WeakMap<D1DatabasePort, ProRoomRegistryCache>();

function registryCacheFor(db: D1DatabasePort): ProRoomRegistryCache {
  let cache = registryCacheByDb.get(db);
  if (!cache) {
    cache = {
      registered: new Map<string, number>(),
      suspended: new Map<string, number>(),
      suspendedRechecks: new Map<string, Promise<number | null>>(),
      refreshedAtMs: 0,
      refreshPromise: null,
    };
    registryCacheByDb.set(db, cache);
  }
  return cache;
}

async function recheckSuspendedRoomGeneration(
  db: D1DatabasePort,
  cache: ProRoomRegistryCache,
  roomCode: string,
  expectedGeneration: number,
): Promise<number | null> {
  const key = `${roomCode}:${expectedGeneration}`;
  if (!cache.suspendedRechecks.has(key)) {
    const recheck = (async () => {
      try {
        const statement = db
          .prepare(
            `SELECT room_generation, status FROM mxqr_pro_room_registry
             WHERE room_code = ?1 LIMIT 1`,
          )
          .bind(roomCode);
        const row =
          typeof statement.first === 'function'
            ? await statement.first()
            : (await statement.all()).results?.[0] || null;
        const generation = Number(row?.room_generation);
        if (
          row?.status === 'registered' &&
          generation === expectedGeneration &&
          cache.suspended.get(roomCode) === expectedGeneration
        ) {
          cache.suspended.delete(roomCode);
          cache.registered.set(roomCode, expectedGeneration);
          return expectedGeneration;
        }
        // A still-suspended row, a recycled generation, a missing row, and
        // every other registry state remain closed at the public facade.
        return null;
      } catch {
        return null;
      }
    })();
    cache.suspendedRechecks.set(key, recheck);
    recheck.finally(() => {
      if (cache.suspendedRechecks.get(key) === recheck) {
        cache.suspendedRechecks.delete(key);
      }
    });
  }
  return cache.suspendedRechecks.get(key) ?? null;
}

async function frontProvisionedRoomGeneration(
  roomCode: string,
  env: ProRoomEnvPort,
  nowMs = Date.now(),
  allowSuspended = false,
): Promise<number | null> {
  const db = env?.MUSIXQUARE_ADMIN_DB || env?.ADMIN_METRICS_DB || null;
  // Local/test environments without the shared registry keep only the
  // developer canary. Production always binds D1 and resolves every room from
  // the canonical registry.
  if (!db?.prepare) {
    return INITIAL_PRO_ROOM_CODES.has(roomCode) ? INITIAL_PRO_ROOM_GENERATION : null;
  }
  const cache = registryCacheFor(db);
  if (nowMs - cache.refreshedAtMs < PRO_ROOM_REGISTRY_REFRESH_MS) {
    const registeredGeneration = cache.registered.get(roomCode);
    if (registeredGeneration !== undefined) return registeredGeneration;
    const suspendedGeneration = cache.suspended.get(roomCode);
    if (suspendedGeneration === undefined) return null;
    if (allowSuspended) return suspendedGeneration;
    // A transfer commit can promote D1 immediately after bootstrap populated
    // this short-lived suspended cache. Re-read only this exact room before a
    // non-allowlisted request so the new owner never inherits a five-second
    // false 404, while a still-suspended/recycled/unreadable row stays closed.
    return recheckSuspendedRoomGeneration(db, cache, roomCode, suspendedGeneration);
  }
  if (!cache.refreshPromise) {
    cache.refreshPromise = (async () => {
      const result = await db
        .prepare(
          `SELECT room_code, room_generation, status FROM mxqr_pro_room_registry
           WHERE status IN ('registered', 'suspended')
           ORDER BY room_code ASC LIMIT ?1`,
        )
        .bind(PRO_ROOM_REGISTRY_MAX_ITEMS + 1)
        .all();
      const rows = Array.isArray(result?.results) ? result.results : [];
      if (rows.length > PRO_ROOM_REGISTRY_MAX_ITEMS) {
        throw new Error('PRO room registry exceeds its bounded cache capacity');
      }
      const registered = new Map<string, number>();
      const suspended = new Map<string, number>();
      for (const row of rows) {
        const generation = Number(row?.room_generation);
        if (isProRoomCode(row?.room_code) && isProRoomGeneration(generation)) {
          if (row.status === 'registered') registered.set(row.room_code, generation);
          else if (row.status === 'suspended') suspended.set(row.room_code, generation);
        }
      }
      cache.registered = registered;
      cache.suspended = suspended;
      cache.refreshedAtMs = Date.now();
    })().finally(() => {
      cache.refreshPromise = null;
    });
  }
  try {
    await cache.refreshPromise;
  } catch (error) {
    // Fail closed once the registry is bound. A stale positive result must not
    // keep a permanently deleted room open during a D1 incident.
    console.warn('[PRO registry] front-door refresh failed', error);
    cache.registered = new Map();
    cache.suspended = new Map();
    cache.refreshedAtMs = Date.now();
    return null;
  }
  return (
    cache.registered.get(roomCode) ??
    (allowSuspended ? cache.suspended.get(roomCode) : undefined) ??
    null
  );
}

function configuredAllowedOrigins(env: ProRoomEnvPort): ReadonlySet<string> {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length > 0 ? new Set(configured) : DEFAULT_ALLOWED_ORIGINS;
}

function allowedOrigin(request: Request, env: ProRoomEnvPort): string | null {
  const origin = request.headers.get('origin') || '';
  return configuredAllowedOrigins(env).has(origin) ? origin : null;
}

function devicePlatformFromRequest(request: Request): string {
  const userAgent = String(request.headers.get('user-agent') || '');
  if (
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent))
  ) {
    return 'ios';
  }
  if (/Android/i.test(userAgent)) return 'android';
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return 'other';
}

function corsHeaders(origin: string): HeaderRecord {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers':
      'content-type,idempotency-key,authorization,x-mxqr-pro-participant-id,x-mxqr-pro-presence-incarnation,x-mxqr-pro-effects-version',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function jsonResponse(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...extraHeaders,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function errorResponse(error: string, status: number, extraHeaders: HeadersInit = {}): Response {
  return jsonResponse({ error }, status, extraHeaders);
}

function withPublicHeaders(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  for (const [name, value] of Object.entries(corsHeaders(origin))) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  if ((!allowEmpty && result.length === 0) || result.length > maxLength) return null;
  return result;
}

function generatedPeerOrdinal(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^Peer ([1-9]\d*)$/i.exec(value.trim());
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= SESSION_MAX_ITEMS
    ? ordinal
    : null;
}

function isGeneratedPeerNamespaceDisplayName(value: unknown) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return (
    normalized.toLowerCase() === DEFAULT_PEER_DISPLAY_NAME.toLowerCase() ||
    /^Peer \d+$/i.test(normalized)
  );
}

function validDeveloperActorName(value: unknown) {
  const normalized = boundedString(value, MAX_DISPLAY_NAME_LENGTH);
  return normalized !== null && isSafeVisibleDisplayName(normalized);
}

function signalingDisplayName(value: unknown) {
  const normalized = boundedString(value, MAX_DISPLAY_NAME_LENGTH);
  return normalized !== null && isSafeVisibleDisplayName(normalized) ? normalized : 'Peer';
}

function queueAdditionActorName(value: unknown, fallback = 'Peer') {
  const normalized = boundedString(value, MAX_DISPLAY_NAME_LENGTH);
  const source =
    normalized !== null && isSafeVisibleDisplayName(normalized) ? normalized : fallback;
  let result = '';
  for (const character of source) {
    if (result.length + character.length > 30) break;
    result += character;
  }
  return result || 'Peer';
}

function queueAdditionTrackTitle(value: unknown) {
  const normalized =
    typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim()
      : '';
  if (!normalized) return null;
  let result = '';
  for (const character of normalized) {
    if (result.length + character.length > 120) break;
    result += character;
  }
  return result || null;
}

async function createProSignalingTicket(payload: unknown, secret: string) {
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmacBase64Url(secret, encoded)}`;
}

async function createOpaqueCredential(secret: string) {
  const random = randomToken(32);
  return `v1.${random}.${await hmacBase64Url(secret, `v1.${random}`)}`;
}

async function createDeterministicOpaqueCredential(secret: string, context: string) {
  const deterministic = await hmacBase64Url(secret, `pro-room-credential\u0000${context}`);
  return `v1.${deterministic}.${await hmacBase64Url(secret, `v1.${deterministic}`)}`;
}

async function verifyOpaqueCredential(token: string, secret: string) {
  if (!token || typeof secret !== 'string' || secret.length < 32) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return false;
  return constantTimeEqual(await hmacBase64Url(secret, `${parts[0]}.${parts[1]}`), parts[2]);
}

async function derivePinHash(
  pin: string,
  salt: string,
  pepper: string,
  iterations = PBKDF2_ITERATIONS,
) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) {
    throw new RangeError('Invalid PBKDF2 iteration count');
  }
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${pin}\u0000${pepper}`),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: base64UrlDecode(salt), iterations },
        material,
        256,
      ),
    ),
  );
}

async function createPinRecord(pin: string, pepper: string): Promise<PinRecord> {
  const salt = randomToken(16);
  return { salt, iterations: PBKDF2_ITERATIONS, hash: await derivePinHash(pin, salt, pepper) };
}

async function verifyPin(pin: string, record: unknown, pepper: string) {
  if (!isRecord(record) || typeof pepper !== 'string' || pepper.length < 32) return false;
  if (
    typeof record.salt !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(record.salt) ||
    typeof record.hash !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.hash) ||
    !isSafeInteger(record.iterations) ||
    record.iterations < 1 ||
    record.iterations > PBKDF2_MAX_ITERATIONS
  ) {
    return false;
  }
  try {
    const actual = await derivePinHash(pin, record.salt, pepper, record.iterations);
    return constantTimeEqual(actual, record.hash);
  } catch {
    // Corrupt or runtime-incompatible stored credentials fail closed instead
    // of turning a PIN attempt into a Worker exception.
    return false;
  }
}

type JsonBodyReadResult = { value: unknown } | { empty: true } | { error: string; status?: number };

async function readJsonBody(
  request: Request,
  maxBytes: number,
  allowSimpleText = false,
  allowEmpty = false,
): Promise<JsonBodyReadResult> {
  const contentType = request.headers.get('content-type') || '';
  const acceptedContentType = allowSimpleText
    ? /^text\/plain(?:\s*;|$)/i.test(contentType)
    : /^application\/json(?:\s*;|$)/i.test(contentType);
  if (!acceptedContentType && !allowEmpty) return { error: 'INVALID_REQUEST' };
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    return { error: 'REQUEST_TOO_LARGE', status: 413 };
  }
  const declaredLength = declared === null ? null : Number(declared);
  if (!request.body) {
    return allowEmpty && (declaredLength === null || declaredLength === 0)
      ? { empty: true }
      : { error: 'INVALID_REQUEST' };
  }
  const bounded = await readBodyBytesLimited(request, maxBytes, INTERNAL_REQUEST_BODY_TIMEOUT_MS);
  if ('error' in bounded && bounded.error === 'too-large') {
    return { error: 'REQUEST_TOO_LARGE', status: 413 };
  }
  if ('error' in bounded && (bounded.error === 'timeout' || bounded.error === 'aborted')) {
    return { error: 'REQUEST_TIMEOUT', status: 408 };
  }
  if ('error' in bounded || !(bounded.body instanceof Uint8Array)) {
    return { error: 'INVALID_REQUEST' };
  }
  if (
    bounded.body.byteLength === 0 &&
    allowEmpty &&
    (declaredLength === null || declaredLength === 0)
  ) {
    return { empty: true };
  }
  if (!acceptedContentType) return { error: 'INVALID_REQUEST' };
  try {
    return {
      value: JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bounded.body),
      ),
    };
  } catch {
    return { error: 'INVALID_REQUEST' };
  }
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function sessionCookieName(roomCode: string) {
  return `__Host-mxqr_pro_session_${roomCode}`;
}

function ownerCookieName(roomCode: string) {
  return `__Host-mxqr_pro_owner_${roomCode}`;
}

function requestSessionToken(request: Request, roomCode: string) {
  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return bearer?.[1] ?? cookieValue(request, sessionCookieName(roomCode));
}

function requestOwnerToken(request: Request, roomCode: string) {
  return cookieValue(request, ownerCookieName(roomCode));
}

function sessionCookie(roomCode: string, token: string, maxAgeSeconds: number) {
  return `${sessionCookieName(roomCode)}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function ownerCookie(roomCode: string, token: string) {
  return `${ownerCookieName(roomCode)}=${token}; Path=/; Max-Age=${OWNER_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function initialRoomState(
  roomCode: string,
  provisioned = INITIAL_PRO_ROOM_CODES.has(roomCode),
  roomGeneration = INITIAL_PRO_ROOM_GENERATION,
): ProRoomState {
  return {
    v: 1,
    roomCode,
    roomGeneration,
    provisioned,
    activationClaimGeneration: 0,
    ownershipTransferClaimGeneration: 0,
    status: 'unactivated',
    suspensionReason: null,
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
      updatedAtMs: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    },
    pendingPlaybackTransition: null,
    pendingPlaybackBroadcasts: [],
    presence: {
      coordinatorEpoch: 0,
      revision: 0,
      coordinatorParticipantId: null,
      participants: {},
    },
    pendingPresenceBroadcast: null,
    queueMode: initialQueueModeState(),
    systemAudio: initialSystemAudioState(),
    effects: initialEffectsState(),
    quota: {
      limitBytes: ROOM_QUOTA_BYTES,
      perAssetLimitBytes: ASSET_MAX_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    pin: null,
    authEpoch: 0,
    ownerAuthorityEpoch: 0,
    developerAuthorityEpoch: 0,
    ownerMemberId: null,
    ownerAccountId: null,
    ownerDisplayName: null,
    accountMembers: {},
    anonymousAdministrators: {},
    accountDeletionTombstones: {},
    nextMemberDisplayNumber: 1,
    ownerCredentialHash: null,
    pendingOwnershipTransfer: null,
    completedOwnershipTransfer: null,
    ownerAuthorityRemoval: null,
    sessions: {},
    assets: {},
    idempotency: {},
    developerMutationIdempotency: {},
    rateLimits: {},
    botRateLimits: {},
    consumedRecoveryNonces: {},
    consumedOwnershipTransferClaims: {},
    stagingTombstones: {},
    developerCommands: {},
    developerCommandIdempotency: {},
  };
}

function internalOwnerTransferReconciliation(room: ProRoomState) {
  const completed = room.completedOwnershipTransfer;
  if (completed) {
    return {
      phase: 'completed',
      transferId: completed.transferId,
      claimGeneration: null,
      requestId: completed.requestId,
      targetAccountId: completed.targetAccountId,
      previousOwnerAccountId: completed.previousOwnerAccountId,
      preparedAtMs: completed.preparedAtMs,
      expiresAtMs: completed.expiresAtMs,
      committedAtMs: completed.committedAtMs,
      replayUntilMs: completed.replayUntilMs,
    };
  }
  const record = room.pendingOwnershipTransfer;
  if (!record) return null;
  return {
    phase: 'pending',
    transferId: record.transferId,
    claimGeneration: record.claimGeneration,
    requestId: record.requestId,
    targetAccountId: record.targetAccountId,
    previousOwnerAccountId: record.previousOwnerAccountId,
    preparedAtMs: record.preparedAtMs,
    expiresAtMs: record.expiresAtMs,
    committedAtMs: null,
    replayUntilMs: record.expiresAtMs,
  };
}

function internalOwnerAuthorityRemoval(room: ProRoomState) {
  const removal = room.ownerAuthorityRemoval;
  if (!removal) return null;
  return {
    accountId: removal.accountId,
    removalId: removal.removalId,
    removedAtMs: removal.removedAtMs,
    ownerAuthorityEpoch: removal.ownerAuthorityEpoch,
    fencedCoordinatorEpoch: removal.fencedCoordinatorEpoch,
    projectionAcked: removal.projectionAcked,
  };
}

function reconcileQueueModePlaylist(room: ProRoomState, nowMs = Date.now()) {
  const current = room.queueMode;
  const nextOrder = current.shuffleEnabled
    ? [
        ...current.shuffleOrder.filter((queueItemId: string) =>
          room.playlist.some((item: PlaylistItem) => item.queueItemId === queueItemId),
        ),
        ...room.playlist
          .map((item: PlaylistItem) => item.queueItemId)
          .filter((queueItemId: string) => !current.shuffleOrder.includes(queueItemId)),
      ]
    : [];
  if (
    nextOrder.length === current.shuffleOrder.length &&
    nextOrder.every((queueItemId, index) => queueItemId === current.shuffleOrder[index])
  ) {
    return false;
  }
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new RoomStateCapacityError();
  room.queueMode = {
    ...current,
    revision: current.revision + 1,
    updatedAtMs: nowMs,
    shuffleOrder: nextOrder,
  };
  return true;
}

function initialSystemAudioState(generation = 0): SystemAudioState {
  return {
    generation,
    status: 'idle',
    ownerParticipantId: null,
    ownerPresenceIncarnationId: null,
    leaseId: null,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  };
}

function publicSystemAudio(state: SystemAudioState) {
  return {
    generation: state.generation,
    status: state.status,
    ownerParticipantId: state.ownerParticipantId,
    claimExpiresAt: state.claimExpiresAt,
    liveExpiresAt: state.liveExpiresAt,
    publication: state.publication ? structuredClone(state.publication) : null,
  };
}

function parseSystemAudioPublication(value: unknown): SystemAudioPublication | null {
  if (!hasExactKeys(value, ['publicationId', 'sessionId', 'tracks'])) return null;
  if (
    typeof value.publicationId !== 'string' ||
    !OPAQUE_ID_RE.test(value.publicationId) ||
    typeof value.sessionId !== 'string' ||
    !OPAQUE_ID_RE.test(value.sessionId)
  ) {
    return null;
  }
  if (!Array.isArray(value.tracks) || value.tracks.length !== 2) return null;
  const channels = new Set<'L' | 'R'>();
  const trackNames = new Set<string>();
  const mids = new Set<string>();
  const tracks: SystemAudioPublication['tracks'] = [];
  for (const rawTrack of value.tracks) {
    if (!hasExactKeys(rawTrack, ['trackName', 'channel'], ['mid'])) return null;
    const trackName = boundedString(rawTrack.trackName, SYSTEM_AUDIO_TRACK_NAME_MAX_LENGTH);
    if (
      !trackName ||
      (rawTrack.channel !== 'L' && rawTrack.channel !== 'R') ||
      channels.has(rawTrack.channel) ||
      trackNames.has(trackName)
    ) {
      return null;
    }
    const mid: string | null | undefined =
      rawTrack.mid === undefined
        ? undefined
        : boundedString(rawTrack.mid, SYSTEM_AUDIO_TRACK_MID_MAX_LENGTH);
    if (rawTrack.mid !== undefined && (!mid || mids.has(mid))) return null;
    channels.add(rawTrack.channel);
    trackNames.add(trackName);
    if (mid) mids.add(mid);
    tracks.push({
      trackName,
      channel: rawTrack.channel,
      ...(typeof mid === 'string' ? { mid } : {}),
    });
  }
  if (!channels.has('L') || !channels.has('R')) return null;
  return {
    publicationId: value.publicationId,
    sessionId: value.sessionId,
    tracks,
  };
}

function normalizeStoredSystemAudio(value: unknown): SystemAudioState | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !hasExactKeys(value, [
      'generation',
      'status',
      'ownerParticipantId',
      'ownerPresenceIncarnationId',
      'leaseId',
      'claimExpiresAt',
      'liveExpiresAt',
      'publication',
    ]) ||
    !isSafeNonNegativeInteger(value.generation)
  ) {
    return null;
  }
  if (value.status === 'idle') {
    return value.ownerParticipantId === null &&
      value.ownerPresenceIncarnationId === null &&
      value.leaseId === null &&
      value.claimExpiresAt === null &&
      value.liveExpiresAt === null &&
      value.publication === null
      ? initialSystemAudioState(value.generation)
      : null;
  }
  if (
    value.generation === 0 ||
    typeof value.ownerParticipantId !== 'string' ||
    !OPAQUE_ID_RE.test(value.ownerParticipantId) ||
    typeof value.ownerPresenceIncarnationId !== 'string' ||
    !OPAQUE_ID_RE.test(value.ownerPresenceIncarnationId) ||
    typeof value.leaseId !== 'string' ||
    !SYSTEM_AUDIO_LEASE_ID_RE.test(value.leaseId)
  ) {
    return null;
  }
  if (value.status === 'preparing') {
    if (
      !isSafeInteger(value.claimExpiresAt) ||
      value.claimExpiresAt <= 0 ||
      value.liveExpiresAt !== null ||
      value.publication !== null
    ) {
      return null;
    }
    return {
      generation: value.generation,
      status: 'preparing',
      ownerParticipantId: value.ownerParticipantId,
      ownerPresenceIncarnationId: value.ownerPresenceIncarnationId,
      leaseId: value.leaseId,
      claimExpiresAt: value.claimExpiresAt,
      liveExpiresAt: null,
      publication: null,
    };
  }
  const publication = parseSystemAudioPublication(value.publication);
  if (
    value.status !== 'live' ||
    value.claimExpiresAt !== null ||
    !isSafeInteger(value.liveExpiresAt) ||
    value.liveExpiresAt <= 0 ||
    !publication
  ) {
    return null;
  }
  return {
    generation: value.generation,
    status: 'live',
    ownerParticipantId: value.ownerParticipantId,
    ownerPresenceIncarnationId: value.ownerPresenceIncarnationId,
    leaseId: value.leaseId,
    claimExpiresAt: null,
    liveExpiresAt: value.liveExpiresAt,
    publication,
  };
}

function publicAsset(asset: RoomAsset): PlaylistR2Source {
  return {
    kind: 'pro-r2',
    assetId: asset.assetId,
    version: asset.version,
    byteLength: asset.byteLength,
    mime: asset.mime,
    ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
  };
}

function publicPlaylistItem(item: PlaylistItem): PlaylistItem {
  const source: PlaylistSource =
    item.source.kind === 'youtube'
      ? {
          kind: 'youtube',
          videoId: item.source.videoId,
          ...(item.source.playlistId === undefined ? {} : { playlistId: item.source.playlistId }),
          ...(item.source.videoIds === undefined ? {} : { videoIds: [...item.source.videoIds] }),
        }
      : {
          kind: 'pro-r2',
          assetId: item.source.assetId,
          version: item.source.version,
          byteLength: item.source.byteLength,
          mime: item.source.mime,
          ...(item.source.sha256 === undefined ? {} : { sha256: item.source.sha256 }),
        };
  return {
    queueItemId: item.queueItemId,
    name: item.name,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.artist === undefined ? {} : { artist: item.artist }),
    ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail }),
    source,
  };
}

function sessionPermissionSet(room: ProRoomState, session: RoomSession) {
  if (session.role === 'owner') return clonePermissionSet(OWNER_PERMISSIONS);
  if (session.accountId) {
    const member = room.accountMembers?.[session.accountId];
    if (member?.role === 'controller') {
      return (
        normalizePermissionSet(member.permissions, DELEGATED_ADMIN_PERMISSIONS) ??
        clonePermissionSet(DELEGATED_ADMIN_PERMISSIONS)
      );
    }
    return clonePermissionSet(MEMBER_PERMISSIONS);
  }
  const administrator = room.anonymousAdministrators?.[session.memberId];
  return administrator
    ? (normalizePermissionSet(administrator.permissions, DELEGATED_ADMIN_PERMISSIONS) ??
        clonePermissionSet(DELEGATED_ADMIN_PERMISSIONS))
    : clonePermissionSet(MEMBER_PERMISSIONS);
}

function sessionCapabilities(room: ProRoomState, session: RoomSession) {
  return capabilitiesFromPermissions(session.role, sessionPermissionSet(room, session));
}

function compareAdministratorText(left: string, right: string) {
  // Do not let an isolate's default locale affect a server-authoritative
  // projection. Relational string comparison has a fixed UTF-16 code-unit
  // order, and memberId provides the final deterministic tie-breaker.
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function publicAdministrators(room: ProRoomState) {
  const liveCounts = new Map();
  for (const participant of Object.values(room.presence.participants || {})) {
    liveCounts.set(participant.memberId, (liveCounts.get(participant.memberId) || 0) + 1);
  }
  const ownerAccount = room.ownerAccountId ? room.accountMembers?.[room.ownerAccountId] : null;
  const administrators = [
    {
      memberId: room.ownerMemberId,
      memberDisplayNumber: 0,
      isAuthenticated: !!ownerAccount,
      displayName: ownerAccount?.displayName || room.ownerDisplayName || 'Owner',
      role: 'owner',
      permissions: clonePermissionSet(OWNER_PERMISSIONS),
      inheritedPermissions: [...PRO_ROOM_PERMISSION_KEYS],
      onlineDeviceCount: room.ownerMemberId ? liveCounts.get(room.ownerMemberId) || 0 : 0,
    },
  ];
  for (const member of Object.values(room.accountMembers || {})) {
    if (member.role !== 'controller') continue;
    administrators.push({
      memberId: member.memberId,
      memberDisplayNumber: member.displayNumber,
      isAuthenticated: true,
      displayName: member.displayName,
      role: 'controller',
      permissions: clonePermissionSet(member.permissions),
      inheritedPermissions: [],
      onlineDeviceCount: liveCounts.get(member.memberId) || 0,
    });
  }
  for (const administrator of Object.values(room.anonymousAdministrators || {})) {
    administrators.push({
      memberId: administrator.memberId,
      memberDisplayNumber: administrator.displayNumber,
      isAuthenticated: false,
      displayName: administrator.displayName,
      role: 'controller',
      permissions: clonePermissionSet(administrator.permissions),
      inheritedPermissions: [],
      onlineDeviceCount: liveCounts.get(administrator.memberId) || 0,
    });
  }
  return administrators.sort((left, right) => {
    const ownerOrder = Number(right.role === 'owner') - Number(left.role === 'owner');
    if (ownerOrder !== 0) return ownerOrder;

    const leftOnline = left.onlineDeviceCount > 0;
    const rightOnline = right.onlineDeviceCount > 0;
    const onlineOrder = Number(rightOnline) - Number(leftOnline);
    if (onlineOrder !== 0) return onlineOrder;

    if (leftOnline) {
      const displayNumberOrder = left.memberDisplayNumber - right.memberDisplayNumber;
      if (displayNumberOrder !== 0) return displayNumberOrder;
    } else {
      const displayNameOrder = compareAdministratorText(left.displayName, right.displayName);
      if (displayNameOrder !== 0) return displayNameOrder;
    }

    return compareAdministratorText(left.memberId ?? '', right.memberId ?? '');
  });
}

function publicSnapshot(room: ProRoomState, session: RoomSession | null = null) {
  const participants = Object.values(room.presence.participants)
    .sort(
      (left, right) =>
        left.joinedAtMs - right.joinedAtMs || left.participantId.localeCompare(right.participantId),
    )
    .map((participant) => {
      const participantSession = room.sessions[participant.sessionHash];
      const memberDisplayNumber =
        participant.memberDisplayNumber ??
        participantSession?.memberDisplayNumber ??
        participantSession?.peerOrdinal ??
        (participant.role === 'owner' ? 0 : null);
      return {
        participantId: participant.participantId,
        memberId: participant.memberId,
        memberDisplayNumber,
        isAuthenticated: typeof participant.accountId === 'string',
        displayName: participant.displayName,
        devicePlatform: participant.devicePlatform || 'other',
        role: participant.role,
        capabilities:
          participantSession && room.status === 'active'
            ? sessionCapabilities(room, participantSession)
            : [],
        joinedAtMs: participant.joinedAtMs,
      };
    });
  const participant = session ? room.presence.participants[session.participantId] : null;
  const viewer = session
    ? {
        memberId: session.memberId,
        memberDisplayNumber:
          session.memberDisplayNumber ?? session.peerOrdinal ?? (session.role === 'owner' ? 0 : 1),
        isAuthenticated: typeof session.accountId === 'string',
        participantId: session.participantId,
        presenceIncarnationId: participant?.presenceIncarnationId || session.presenceIncarnationId,
        displayName: session.displayName,
        role: session.role,
        capabilities: room.status === 'active' ? sessionCapabilities(room, session) : [],
        coordinatorEligible: false,
      }
    : null;
  // An awake snapshot may only advertise a viewer currently in presence.
  const safeViewer = room.runtime === 'awake' && !participant ? null : viewer;
  return {
    schemaVersion: SCHEMA_VERSION,
    roomCode: room.roomCode,
    status: room.status,
    runtime: room.runtime,
    revision: room.revision,
    playlistRevision: room.playlistRevision,
    effectsRevision: room.effects.revision,
    queueModeRevision: room.queueMode.revision,
    // Developer ownership is private server state. Keeping the public v1
    // playlist exact lets cached clients round-trip snapshots without learning
    // or being able to forge API-key attribution.
    playlist: room.playlist.map(publicPlaylistItem),
    currentQueueItemId: room.currentQueueItemId,
    playback: structuredClone(room.playback),
    presence: {
      coordinatorEpoch: room.presence.coordinatorEpoch,
      revision: room.presence.revision,
      coordinatorParticipantId: room.presence.coordinatorParticipantId,
      participants,
    },
    quota: { ...room.quota },
    viewer: safeViewer,
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: publicAdministrators(room),
  };
}

function developerQueueItem(item: PlaylistItem, requesterKeyId: string | undefined) {
  const developerText = (value: unknown) => {
    if (typeof value !== 'string' || value.length <= 512) return value;
    const truncated = value.slice(0, 512);
    return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
  };
  const addedBy = DEVELOPER_API_KEY_ID_RE.test(requesterKeyId || '')
    ? DEVELOPER_API_KEY_ID_RE.test(item.developerOwnerKeyId || '') &&
      item.developerOwnerKeyId === requesterKeyId
      ? 'current_api_key'
      : DEVELOPER_API_KEY_ID_RE.test(item.developerOwnerKeyId || '')
        ? 'another_api_key'
        : 'participant'
    : null;
  const metadata = {
    queueItemId: item.queueItemId,
    kind: item.source.kind === 'youtube' ? 'youtube' : 'audio',
    name: developerText(item.name),
    ...(addedBy === null ? {} : { addedBy }),
    ...(item.title === undefined ? {} : { title: developerText(item.title) }),
    ...(item.artist === undefined ? {} : { artist: developerText(item.artist) }),
    ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail }),
  };
  return item.source.kind === 'pro-r2'
    ? { ...metadata, byteLength: item.source.byteLength }
    : metadata;
}

function developerProjection(
  room: ProRoomState,
  projection: unknown,
  nowMs: number,
  requesterKeyId: string | undefined,
  effectsVersion = 1,
) {
  void effectsVersion;
  if (projection === 'room') {
    return {
      schemaVersion: 1,
      view: 'room',
      roomCode: room.roomCode,
      status: room.status,
      runtime: room.runtime,
      revision: room.revision,
      participantCount: Object.keys(room.presence.participants).length,
      // The Durable Object is the authority. Developer control no longer
      // depends on one browser tab remaining awake and relay-capable.
      controlAvailable: room.status === 'active',
      quota: { ...room.quota },
    };
  }
  const playlistById = new Map(room.playlist.map((item: PlaylistItem) => [item.queueItemId, item]));
  if (projection === 'playback') {
    const item = room.playback.queueItemId
      ? playlistById.get(room.playback.queueItemId) || null
      : null;
    if ((item === null) !== (room.playback.queueItemId === null)) return null;
    let positionSeconds = room.playback.positionSeconds;
    if (
      room.runtime === 'awake' &&
      room.playback.state === 'playing' &&
      room.playback.updatedAtMs > 0 &&
      nowMs > room.playback.updatedAtMs
    ) {
      positionSeconds = Math.min(
        PLAYBACK_MAX_POSITION_SECONDS,
        positionSeconds + (nowMs - room.playback.updatedAtMs) / 1_000,
      );
    }
    return {
      schemaVersion: 1,
      view: 'playback',
      roomCode: room.roomCode,
      revision: room.playback.revision,
      playlistRevision: room.playlistRevision,
      state: room.playback.state,
      queueItemId: room.playback.queueItemId,
      positionSeconds,
      youtubeVideoId: room.playback.youtubeVideoId,
      youtubeSubIndex: room.playback.youtubeSubIndex,
      observedAtMs: nowMs,
      item: item ? developerQueueItem(item, requesterKeyId) : null,
    };
  }
  if (projection === 'queue') {
    return {
      schemaVersion: 1,
      view: 'queue',
      roomCode: room.roomCode,
      playlistRevision: room.playlistRevision,
      currentQueueItemId: room.currentQueueItemId,
      items: room.playlist.map((item: PlaylistItem) => developerQueueItem(item, requesterKeyId)),
    };
  }
  if (projection === 'effects') return publicEffects(room);
  if (projection === 'queue-mode') return developerQueueMode(room);
  return null;
}

function parseDeveloperCommand(value: unknown): DeveloperControlCommand | null {
  if (!isRecord(value)) return null;
  if (value.type === 'play' || value.type === 'pause' || value.type === 'next') {
    return hasExactKeys(value, ['type']) ? { type: value.type } : null;
  }
  if (value.type === 'seek') {
    return hasExactKeys(value, ['type', 'positionSeconds']) &&
      isFiniteNumber(value.positionSeconds) &&
      value.positionSeconds >= 0 &&
      value.positionSeconds <= PLAYBACK_MAX_POSITION_SECONDS
      ? { type: 'seek', positionSeconds: value.positionSeconds }
      : null;
  }
  if (value.type === 'play_item') {
    return hasExactKeys(value, ['type', 'queueItemId']) &&
      typeof value.queueItemId === 'string' &&
      QUEUE_ITEM_ID_RE.test(value.queueItemId)
      ? { type: 'play_item', queueItemId: value.queueItemId }
      : null;
  }
  if (value.type === 'set_effects') {
    const effects = hasExactKeys(value, ['type', 'effects'])
      ? parseRoomEffectsPatch(value.effects)
      : null;
    return effects ? { type: 'set_effects', effects } : null;
  }
  return null;
}

function requiredDeveloperControlVersion(command: DeveloperControlCommand | null | undefined) {
  if (command?.type === 'next') return DEVELOPER_NEXT_CONTROL_VERSION;
  if (command?.type === 'set_effects') return DEVELOPER_EFFECTS_CONTROL_VERSION;
  return DEVELOPER_CONTROL_VERSION;
}

function randomQueueItemId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function parseDeveloperMetadata(value: unknown, requiredName?: true): DeveloperNamedMetadata | null;
function parseDeveloperMetadata(value: unknown, requiredName: false): DeveloperMetadata | null;
function parseDeveloperMetadata(value: unknown, requiredName = true): DeveloperMetadata | null {
  if (!isRecord(value)) return null;
  const name = requiredName ? boundedString(value.name, 512) : undefined;
  if (requiredName && !name) return null;
  const metadata: DeveloperMetadata = {};
  if (typeof name === 'string') metadata.name = name;
  for (const key of ['title', 'artist', 'thumbnail']) {
    if (value[key] === undefined) continue;
    const parsed = boundedString(value[key], 512);
    if (!parsed) return null;
    metadata[key] = parsed;
  }
  return metadata;
}

function canonicalizeDeveloperYouTubeBatchItems(
  items: DeveloperYouTubeItem[],
): DeveloperYouTubeItem[] | null {
  const result: DeveloperYouTubeItem[] = [];
  const playlistAggregates = new Map<string, { index: number; mode: 'rows' | 'manifest' }>();
  for (const item of items) {
    if (item.playlistId === undefined) {
      result.push(item);
      continue;
    }
    const aggregate = playlistAggregates.get(item.playlistId);
    if (aggregate === undefined) {
      playlistAggregates.set(item.playlistId, {
        index: result.length,
        mode: item.videoIds === undefined ? 'rows' : 'manifest',
      });
      result.push(item);
      continue;
    }
    const existing = result[aggregate.index];
    if (!existing) return null;
    if (aggregate.mode === 'manifest') {
      const existingVideoIds = existing.videoIds;
      const itemVideoIds = item.videoIds;
      if (
        itemVideoIds === undefined ||
        existingVideoIds === undefined ||
        existingVideoIds.length !== itemVideoIds.length ||
        existingVideoIds.some((videoId: string, index: number) => videoId !== itemVideoIds[index])
      ) {
        return null;
      }
      continue;
    }
    if (item.videoIds !== undefined) return null;
    const videoIds = [
      ...(existing.videoIds === undefined ? [existing.videoId] : existing.videoIds),
      item.videoId,
    ];
    if (videoIds.length > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS) return null;
    result[aggregate.index] = { ...existing, videoIds };
  }
  return result;
}

function parseYouTubeVideoIds(
  value: unknown,
  videoId: string,
  playlistId: string | undefined,
): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (
    playlistId === undefined ||
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS ||
    !value.includes(videoId) ||
    !isStringArray(value) ||
    value.some((candidate) => !YOUTUBE_VIDEO_ID_RE.test(candidate))
  ) {
    return null;
  }
  return [...value];
}

function parseDeveloperQueueMutation(value: unknown): DeveloperQueueMutation | null {
  if (!isRecord(value)) return null;
  if (value.type === 'add_youtube') {
    if (
      !hasExactKeys(
        value,
        ['type', 'videoId', 'name'],
        ['playlistId', 'videoIds', 'title', 'artist', 'thumbnail'],
      ) ||
      typeof value.videoId !== 'string' ||
      !YOUTUBE_VIDEO_ID_RE.test(value.videoId) ||
      (value.playlistId !== undefined &&
        (typeof value.playlistId !== 'string' || !YOUTUBE_PLAYLIST_ID_RE.test(value.playlistId)))
    ) {
      return null;
    }
    const metadata = parseDeveloperMetadata(value);
    const videoIds = parseYouTubeVideoIds(value.videoIds, value.videoId, value.playlistId);
    if (!metadata || videoIds === null) return null;
    return {
      type: 'add_youtube',
      videoId: value.videoId,
      ...(value.playlistId === undefined ? {} : { playlistId: value.playlistId }),
      ...(videoIds === undefined ? {} : { videoIds }),
      ...metadata,
    };
  }
  if (value.type === 'add_youtube_batch') {
    if (
      !hasExactKeys(value, ['type', 'items']) ||
      !Array.isArray(value.items) ||
      value.items.length === 0 ||
      value.items.length > DEVELOPER_YOUTUBE_BATCH_MAX_ITEMS
    ) {
      return null;
    }
    const items = value.items.map((item) => {
      if (
        !hasExactKeys(
          item,
          ['videoId', 'name'],
          ['playlistId', 'videoIds', 'title', 'artist', 'thumbnail'],
        ) ||
        typeof item.videoId !== 'string' ||
        !YOUTUBE_VIDEO_ID_RE.test(item.videoId) ||
        (item.playlistId !== undefined &&
          (typeof item.playlistId !== 'string' || !YOUTUBE_PLAYLIST_ID_RE.test(item.playlistId)))
      ) {
        return null;
      }
      const metadata = parseDeveloperMetadata(item);
      const videoIds = parseYouTubeVideoIds(item.videoIds, item.videoId, item.playlistId);
      return metadata && videoIds !== null
        ? {
            videoId: item.videoId,
            ...(item.playlistId === undefined ? {} : { playlistId: item.playlistId }),
            ...(videoIds === undefined ? {} : { videoIds }),
            ...metadata,
          }
        : null;
    });
    if (items.some((item) => item === null)) return null;
    const validItems = items.filter((item): item is DeveloperYouTubeItem => item !== null);
    const canonicalItems = canonicalizeDeveloperYouTubeBatchItems(validItems);
    return canonicalItems === null ? null : { type: 'add_youtube_batch', items: canonicalItems };
  }
  if (value.type === 'remove') {
    return hasExactKeys(value, ['type', 'queueItemId']) &&
      typeof value.queueItemId === 'string' &&
      QUEUE_ITEM_ID_RE.test(value.queueItemId)
      ? { type: 'remove', queueItemId: value.queueItemId }
      : null;
  }
  if (value.type === 'remove_many') {
    if (
      !hasExactKeys(value, ['type', 'queueItemIds']) ||
      !Array.isArray(value.queueItemIds) ||
      value.queueItemIds.length < 1 ||
      value.queueItemIds.length > DEVELOPER_REMOVE_MANY_MAX_ITEMS ||
      !isStringArray(value.queueItemIds) ||
      value.queueItemIds.some((queueItemId) => !QUEUE_ITEM_ID_RE.test(queueItemId)) ||
      new Set(value.queueItemIds).size !== value.queueItemIds.length
    ) {
      return null;
    }
    return { type: 'remove_many', queueItemIds: [...value.queueItemIds] };
  }
  if (value.type === 'clear') {
    return hasExactKeys(value, ['type']) ? { type: 'clear' } : null;
  }
  if (value.type === 'clear_owned') {
    return hasExactKeys(value, ['type']) ? { type: 'clear_owned' } : null;
  }
  if (value.type === 'reorder') {
    if (
      !hasExactKeys(value, ['type', 'basePlaylistRevision', 'queueItemIds']) ||
      !isSafeNonNegativeInteger(value.basePlaylistRevision) ||
      !Array.isArray(value.queueItemIds) ||
      value.queueItemIds.length > PLAYLIST_MAX_ITEMS ||
      !isStringArray(value.queueItemIds) ||
      value.queueItemIds.some((queueItemId) => !QUEUE_ITEM_ID_RE.test(queueItemId)) ||
      new Set(value.queueItemIds).size !== value.queueItemIds.length
    ) {
      return null;
    }
    return {
      type: 'reorder',
      basePlaylistRevision: value.basePlaylistRevision,
      queueItemIds: [...value.queueItemIds],
    };
  }
  return null;
}

function parseBotPlan(value: unknown): BotPlan | null {
  if (
    !hasExactKeys(
      value,
      ['intent'],
      [
        'trackQueries',
        'playAddedIndex',
        'queueItemId',
        'queueItemIds',
        'basePlaylistRevision',
        'playbackCommand',
        'repeatMode',
        'shuffleEnabled',
        'virtualTrebleEnabled',
        'answer',
      ],
    ) ||
    ![
      'add_youtube',
      'play_existing',
      'remove_items',
      'clear_queue',
      'playback',
      'queue_mode',
      'virtual_treble',
      'answer',
    ].includes(typeof value.intent === 'string' ? value.intent : '')
  ) {
    return null;
  }
  const answer = value.answer === undefined ? undefined : boundedString(value.answer, 240, true);
  if (value.answer !== undefined && answer === null) return null;
  if (value.intent === 'add_youtube') {
    if (
      !Array.isArray(value.trackQueries) ||
      value.trackQueries.length < 1 ||
      value.trackQueries.length > BOT_MAX_TRACK_ITEMS ||
      value.trackQueries.some((query) => boundedString(query, 160) === null)
    ) {
      return null;
    }
    const playAddedIndex = value.playAddedIndex === undefined ? -1 : value.playAddedIndex;
    if (
      !isSafeInteger(playAddedIndex) ||
      playAddedIndex < -1 ||
      playAddedIndex >= value.trackQueries.length
    ) {
      return null;
    }
    return {
      intent: value.intent,
      trackQueries: value.trackQueries.map((query) => boundedString(query, 160)).filter(isString),
      playAddedIndex,
      ...(answer ? { answer } : {}),
    };
  }
  if (value.intent === 'play_existing') {
    return typeof value.queueItemId === 'string' && QUEUE_ITEM_ID_RE.test(value.queueItemId)
      ? { intent: value.intent, queueItemId: value.queueItemId, ...(answer ? { answer } : {}) }
      : null;
  }
  if (value.intent === 'remove_items') {
    if (
      !hasExactKeys(value, ['intent', 'queueItemIds'], ['answer']) ||
      !Array.isArray(value.queueItemIds) ||
      value.queueItemIds.length < 1 ||
      value.queueItemIds.length > DEVELOPER_REMOVE_MANY_MAX_ITEMS ||
      !isStringArray(value.queueItemIds) ||
      value.queueItemIds.some((queueItemId) => !QUEUE_ITEM_ID_RE.test(queueItemId)) ||
      new Set(value.queueItemIds).size !== value.queueItemIds.length
    ) {
      return null;
    }
    return {
      intent: value.intent,
      queueItemIds: [...value.queueItemIds],
      ...(answer ? { answer } : {}),
    };
  }
  if (value.intent === 'clear_queue') {
    return hasExactKeys(value, ['intent', 'basePlaylistRevision'], ['answer']) &&
      isSafeNonNegativeInteger(value.basePlaylistRevision)
      ? {
          intent: value.intent,
          basePlaylistRevision: value.basePlaylistRevision,
          ...(answer ? { answer } : {}),
        }
      : null;
  }
  if (value.intent === 'playback') {
    return value.playbackCommand === 'play' ||
      value.playbackCommand === 'pause' ||
      value.playbackCommand === 'next'
      ? {
          intent: value.intent,
          playbackCommand: value.playbackCommand,
          ...(answer ? { answer } : {}),
        }
      : null;
  }
  if (value.intent === 'queue_mode') {
    if (
      (value.repeatMode === undefined && value.shuffleEnabled === undefined) ||
      (value.repeatMode !== undefined &&
        value.repeatMode !== 'off' &&
        value.repeatMode !== 'all' &&
        value.repeatMode !== 'one') ||
      (value.shuffleEnabled !== undefined && typeof value.shuffleEnabled !== 'boolean')
    ) {
      return null;
    }
    return {
      intent: value.intent,
      ...(value.repeatMode === undefined ? {} : { repeatMode: value.repeatMode }),
      ...(value.shuffleEnabled === undefined ? {} : { shuffleEnabled: value.shuffleEnabled }),
      ...(answer ? { answer } : {}),
    };
  }
  if (value.intent === 'virtual_treble') {
    return hasExactKeys(value, ['intent', 'virtualTrebleEnabled'], ['answer']) &&
      typeof value.virtualTrebleEnabled === 'boolean'
      ? {
          intent: value.intent,
          virtualTrebleEnabled: value.virtualTrebleEnabled,
          ...(answer ? { answer } : {}),
        }
      : null;
  }
  return answer && value.intent === 'answer' ? { intent: 'answer', answer } : null;
}

function parseBotTracks(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > BOT_MAX_TRACK_ITEMS) return null;
  const mutation = parseDeveloperQueueMutation({ type: 'add_youtube_batch', items: value });
  return mutation?.type === 'add_youtube_batch' ? mutation.items : null;
}

function botDestructiveSummary(action: string, removedCount: number, languageHint = '') {
  const korean = /[가-힣]/u.test(languageHint);
  if (action === 'clear_queue') {
    if (removedCount === 0) {
      return korean ? '재생목록이 이미 비어 있어요.' : 'The queue was already empty.';
    }
    return korean
      ? `트랙 ${removedCount}개를 삭제해 재생목록을 비웠어요.`
      : `Cleared the queue and removed ${removedCount} track${removedCount === 1 ? '' : 's'}.`;
  }
  return korean
    ? `트랙 ${removedCount}개를 삭제했어요.`
    : `Removed ${removedCount} track${removedCount === 1 ? '' : 's'}.`;
}

function botDestructiveResult(
  action: string,
  removedCount: number,
  playbackChanged: boolean,
  languageHint = '',
) {
  return {
    ok: true,
    summary: botDestructiveSummary(action, removedCount, languageHint),
    addedCount: 0,
    playbackChanged,
  };
}

function isDeveloperAudioCandidate(name: string, mime: string) {
  if (typeof name !== 'string' || typeof mime !== 'string') return false;
  if (/^audio\//i.test(mime) || mime.toLowerCase() === 'application/ogg') return true;
  if (mime.toLowerCase() !== 'application/octet-stream') return false;
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  return DEVELOPER_AUDIO_EXTENSIONS.has(extension);
}

function parseDeveloperMediaUpload(value: unknown): DeveloperMediaUpload | null {
  if (
    !hasExactKeys(
      value,
      ['name', 'byteLength', 'mime'],
      ['sha256', 'title', 'artist', 'thumbnail'],
    ) ||
    !isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > ASSET_MAX_BYTES ||
    typeof value.mime !== 'string' ||
    !MIME_RE.test(value.mime) ||
    (value.sha256 !== undefined &&
      (typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)))
  ) {
    return null;
  }
  const metadata = parseDeveloperMetadata(value);
  if (!metadata || !isDeveloperAudioCandidate(metadata.name, value.mime)) return null;
  return {
    ...metadata,
    byteLength: value.byteLength,
    mime: value.mime,
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
  };
}

function publicDeveloperCommand(record: DeveloperCommandRecord) {
  return {
    schemaVersion: 1,
    roomCode: record.roomCode,
    commandId: record.commandId,
    status: record.status,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    ...(Number.isSafeInteger(record.completedAtMs) ? { completedAtMs: record.completedAtMs } : {}),
    ...(typeof record.resultCode === 'string' ? { resultCode: record.resultCode } : {}),
  };
}

async function readResponseBytesLimited(response: Response, maxBytes: number, signal: AbortSignal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    cancelReadableBody(response, 'INTERNAL_RESPONSE_TOO_LARGE');
    throw new Error('INTERNAL_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  type ResponseReadOutcome =
    | { kind: 'read'; value: ReadableStreamReadResult<Uint8Array> }
    | { kind: 'invalid' }
    | { kind: 'aborted' };
  let stop!: (outcome: ResponseReadOutcome) => void;
  const stopped = new Promise<ResponseReadOutcome>((resolve) => {
    stop = resolve;
  });
  const abortReason = () =>
    signal.reason instanceof Error ? signal.reason : new Error('INTERNAL_RESPONSE_TIMEOUT');
  const abort = () => {
    stop({ kind: 'aborted' });
    cancelReadableBody(reader, abortReason());
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });

  try {
    while (true) {
      const outcome: ResponseReadOutcome = await Promise.race([
        reader.read().then(
          (value): ResponseReadOutcome => ({ kind: 'read', value }),
          (): ResponseReadOutcome => ({ kind: 'invalid' }),
        ),
        stopped,
      ]);
      if (outcome.kind === 'aborted') throw abortReason();
      if (outcome.kind !== 'read') throw new Error('INTERNAL_RESPONSE_INVALID');
      const { done, value } = outcome.value;
      if (done) break;
      if (!value) continue;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        cancelReadableBody(reader, 'INTERNAL_RESPONSE_TOO_LARGE');
        throw new Error('INTERNAL_RESPONSE_TOO_LARGE');
      }
      chunks.push(bytes);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative stream may retain the timed-out pending read.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchWithDeadline(
  fetcher: FetchOperation,
  request: Request,
  timeoutMs: number,
  maxBytes = INTERNAL_SERVICE_RESPONSE_MAX_BYTES,
): Promise<{ response: Response; bytes: Uint8Array }> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const operation = Promise.resolve()
    .then(() => fetcher(new Request(request, { signal: controller.signal })))
    .then(async (response) => {
      if (timedOut) {
        cancelReadableBody(response, 'INTERNAL_RESPONSE_TIMEOUT');
        return null;
      }
      const bytes = await readResponseBytesLimited(response, maxBytes, controller.signal);
      return timedOut ? null : { response, bytes };
    })
    // Normalize both an early dependency failure and a rejection that arrives
    // after the timeout so neither can surface as an unhandled rejection.
    .catch(() => null);
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('INTERNAL_RESPONSE_TIMEOUT'));
      resolve(null);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([operation, timeout]);
    if (!result) throw new Error('INTERNAL_RESPONSE_UNAVAILABLE');
    return result;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function parseInternalJsonResponse(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
}

function parsePlaylistItem(value: unknown): PlaylistItem | null {
  if (!hasExactKeys(value, ['queueItemId', 'source', 'name'], ['title', 'artist', 'thumbnail']))
    return null;
  if (typeof value.queueItemId !== 'string' || !QUEUE_ITEM_ID_RE.test(value.queueItemId))
    return null;
  const name = boundedString(value.name, MAX_TEXT_LENGTH);
  if (!name || typeof value.name !== 'string') return null;
  const optional: Pick<PlaylistItem, 'title' | 'artist' | 'thumbnail'> = {};
  for (const key of ['title', 'artist', 'thumbnail'] as const) {
    if (value[key] !== undefined) {
      if (
        typeof value[key] !== 'string' ||
        value[key].length === 0 ||
        value[key].length > MAX_TEXT_LENGTH
      )
        return null;
      optional[key] = value[key];
    }
  }
  const source = value.source;
  if (
    hasExactKeys(source, ['kind', 'videoId'], ['playlistId', 'videoIds']) &&
    source.kind === 'youtube'
  ) {
    if (typeof source.videoId !== 'string' || !YOUTUBE_VIDEO_ID_RE.test(source.videoId))
      return null;
    if (
      source.playlistId !== undefined &&
      (typeof source.playlistId !== 'string' || !YOUTUBE_PLAYLIST_ID_RE.test(source.playlistId))
    )
      return null;
    const videoIds = parseYouTubeVideoIds(source.videoIds, source.videoId, source.playlistId);
    if (videoIds === null) return null;
    return {
      queueItemId: value.queueItemId,
      name: value.name,
      ...optional,
      source: {
        kind: 'youtube',
        videoId: source.videoId,
        ...(source.playlistId === undefined ? {} : { playlistId: source.playlistId }),
        ...(videoIds === undefined ? {} : { videoIds }),
      },
    };
  }
  if (
    hasExactKeys(source, ['kind', 'assetId', 'version', 'byteLength', 'mime'], ['sha256']) &&
    source.kind === 'pro-r2'
  ) {
    if (
      typeof source.assetId !== 'string' ||
      !OPAQUE_ID_RE.test(source.assetId) ||
      !isSafeInteger(source.version) ||
      source.version <= 0 ||
      !isSafeInteger(source.byteLength) ||
      source.byteLength <= 0 ||
      source.byteLength > ASSET_MAX_BYTES ||
      typeof source.mime !== 'string' ||
      !MIME_RE.test(source.mime) ||
      (source.sha256 !== undefined &&
        (typeof source.sha256 !== 'string' || !SHA256_RE.test(source.sha256)))
    ) {
      return null;
    }
    return {
      queueItemId: value.queueItemId,
      name: value.name,
      ...optional,
      source: {
        kind: 'pro-r2',
        assetId: source.assetId,
        version: source.version,
        byteLength: source.byteLength,
        mime: source.mime,
        ...(source.sha256 === undefined ? {} : { sha256: source.sha256 }),
      },
    };
  }
  return null;
}

function parsePlaylist(value: unknown): PlaylistItem[] | null {
  if (!Array.isArray(value) || value.length > PLAYLIST_MAX_ITEMS) return null;
  const result: PlaylistItem[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const item = parsePlaylistItem(raw);
    if (!item || ids.has(item.queueItemId)) return null;
    ids.add(item.queueItemId);
    result.push(item);
  }
  return result;
}

function preservesImmutableYouTubeManifest(
  previous: PlaylistItem | null | undefined,
  next: PlaylistItem | null | undefined,
) {
  const previousVideoIds =
    previous?.source.kind === 'youtube' ? previous.source.videoIds : undefined;
  const nextVideoIds = next?.source.kind === 'youtube' ? next.source.videoIds : undefined;
  if (previousVideoIds === undefined && nextVideoIds === undefined) return true;
  // A legacy playlist row may be enriched exactly once after the client has
  // resolved its canonical ordered manifest. The queue item and source
  // identity must not change during that bounded upgrade.
  if (previousVideoIds === undefined && Array.isArray(nextVideoIds)) {
    return (
      previous?.source.kind === 'youtube' &&
      next?.source.kind === 'youtube' &&
      previous.source.playlistId !== undefined &&
      previous.source.playlistId === next.source.playlistId &&
      previous.source.videoId === next.source.videoId
    );
  }
  return (
    previous?.source.kind === 'youtube' &&
    next?.source.kind === 'youtube' &&
    previous.source.playlistId === next.source.playlistId &&
    previous.source.videoId === next.source.videoId &&
    Array.isArray(previousVideoIds) &&
    Array.isArray(nextVideoIds) &&
    previousVideoIds.length === nextVideoIds.length &&
    previousVideoIds.every((videoId, index) => videoId === nextVideoIds[index])
  );
}

function playbackMatchesYouTubeManifest(playback: PlaybackState, item: PlaylistItem) {
  if (item?.source.kind !== 'youtube' || item.source.videoIds === undefined) return true;
  return (
    isSafeNonNegativeInteger(playback.youtubeSubIndex) &&
    playback.youtubeSubIndex < item.source.videoIds.length &&
    item.source.videoIds[playback.youtubeSubIndex] === playback.youtubeVideoId
  );
}

function playbackSemanticallyEqual(left: PlaybackState, right: PlaybackState) {
  return (
    left.coordinatorEpoch === right.coordinatorEpoch &&
    left.state === right.state &&
    left.queueItemId === right.queueItemId &&
    left.positionSeconds === right.positionSeconds &&
    left.youtubeVideoId === right.youtubeVideoId &&
    left.youtubeSubIndex === right.youtubeSubIndex
  );
}

function parsePlaybackCandidate(
  value: unknown,
  playlistById: Map<string, PlaylistItem>,
  currentQueueItemId: string | null,
  coordinatorEpoch: number,
): PlaybackState | null {
  if (
    !hasExactKeys(value, [
      'coordinatorEpoch',
      'revision',
      'state',
      'queueItemId',
      'positionSeconds',
      'updatedAtMs',
      'youtubeVideoId',
      'youtubeSubIndex',
    ]) ||
    value.coordinatorEpoch !== coordinatorEpoch ||
    !isSafeNonNegativeInteger(value.revision) ||
    typeof value.positionSeconds !== 'number' ||
    !Number.isFinite(value.positionSeconds) ||
    value.positionSeconds < 0 ||
    value.positionSeconds > PLAYBACK_MAX_POSITION_SECONDS ||
    !isSafeNonNegativeInteger(value.updatedAtMs)
  ) {
    return null;
  }
  if (value.state === 'idle') {
    if (
      value.queueItemId !== null ||
      currentQueueItemId !== null ||
      value.positionSeconds !== 0 ||
      value.youtubeVideoId !== null ||
      value.youtubeSubIndex !== null
    )
      return null;
    return {
      coordinatorEpoch,
      revision: value.revision,
      state: 'idle',
      queueItemId: null,
      positionSeconds: value.positionSeconds,
      updatedAtMs: value.updatedAtMs,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    };
  }
  if (typeof value.queueItemId !== 'string') return null;
  const currentItem = playlistById.get(value.queueItemId);
  {
    if (
      (value.state !== 'playing' && value.state !== 'paused') ||
      !QUEUE_ITEM_ID_RE.test(value.queueItemId) ||
      value.queueItemId !== currentQueueItemId ||
      !currentItem
    ) {
      return null;
    }
    if (currentItem.source.kind === 'youtube') {
      if (
        typeof value.youtubeVideoId !== 'string' ||
        !YOUTUBE_VIDEO_ID_RE.test(value.youtubeVideoId) ||
        !isSafeNonNegativeInteger(value.youtubeSubIndex) ||
        value.youtubeSubIndex > 100_000 ||
        (currentItem.source.videoIds !== undefined &&
          (value.youtubeSubIndex >= currentItem.source.videoIds.length ||
            currentItem.source.videoIds[value.youtubeSubIndex] !== value.youtubeVideoId))
      ) {
        return null;
      }
    } else if (value.youtubeVideoId !== null || value.youtubeSubIndex !== null) {
      return null;
    }
  }
  return {
    coordinatorEpoch,
    revision: value.revision,
    state: value.state,
    queueItemId: value.queueItemId,
    positionSeconds: value.positionSeconds,
    updatedAtMs: value.updatedAtMs,
    youtubeVideoId: currentItem.source.kind === 'youtube' ? value.youtubeVideoId : null,
    youtubeSubIndex: currentItem.source.kind === 'youtube' ? value.youtubeSubIndex : null,
  };
}

function playbackPositionAt(playback: PlaybackState, nowMs: number) {
  if (
    playback.state !== 'playing' ||
    !Number.isSafeInteger(playback.updatedAtMs) ||
    playback.updatedAtMs <= 0 ||
    nowMs <= playback.updatedAtMs
  ) {
    return playback.positionSeconds;
  }
  return Math.min(
    PLAYBACK_MAX_POSITION_SECONDS,
    playback.positionSeconds + (nowMs - playback.updatedAtMs) / 1_000,
  );
}

function playbackTraversalOrder(room: ProRoomState) {
  return room.queueMode.shuffleEnabled
    ? [...room.queueMode.shuffleOrder]
    : room.playlist.map((item: PlaylistItem) => item.queueItemId);
}

function adjacentQueueItemId(
  room: ProRoomState,
  direction: string,
  { repeatCurrent = false }: { repeatCurrent?: boolean } = {},
): string | null {
  const order = playbackTraversalOrder(room);
  if (order.length === 0) return null;
  const current = room.currentQueueItemId;
  if (repeatCurrent && current && order.includes(current)) return current;
  const index = current ? order.indexOf(current) : -1;
  if (direction === 'next') {
    const nextIndex = index < 0 ? 0 : index + 1;
    if (nextIndex < order.length) return order[nextIndex] ?? null;
    return room.queueMode.repeatMode === 1 ? (order[0] ?? null) : null;
  }
  if (index > 0) return order[index - 1] ?? null;
  if (index === 0 && room.queueMode.repeatMode === 1 && order.length > 1) {
    return order[order.length - 1] ?? null;
  }
  return current || order[0] || null;
}

function parsePlaybackAuthorityCommand(value: unknown): PlaybackAuthorityCommand | null {
  if (!isRecord(value)) return null;
  if (!isSafeNonNegativeInteger(value.baseRevision)) return null;
  if (
    value.type === 'play' ||
    value.type === 'pause' ||
    value.type === 'stop' ||
    value.type === 'next' ||
    value.type === 'previous'
  ) {
    return hasExactKeys(value, ['type', 'baseRevision'])
      ? { type: value.type, baseRevision: value.baseRevision }
      : null;
  }
  if (value.type === 'seek') {
    return hasExactKeys(value, ['type', 'baseRevision', 'positionSeconds']) &&
      isFiniteNumber(value.positionSeconds) &&
      value.positionSeconds >= 0 &&
      value.positionSeconds <= PLAYBACK_MAX_POSITION_SECONDS
      ? { type: 'seek', baseRevision: value.baseRevision, positionSeconds: value.positionSeconds }
      : null;
  }
  if (value.type === 'select') {
    if (
      !hasExactKeys(
        value,
        ['type', 'baseRevision', 'queueItemId'],
        ['state', 'positionSeconds', 'youtubeVideoId', 'youtubeSubIndex'],
      ) ||
      typeof value.queueItemId !== 'string' ||
      !QUEUE_ITEM_ID_RE.test(value.queueItemId) ||
      (value.state !== undefined && value.state !== 'playing' && value.state !== 'paused') ||
      (value.positionSeconds !== undefined &&
        (!isFiniteNumber(value.positionSeconds) ||
          value.positionSeconds < 0 ||
          value.positionSeconds > PLAYBACK_MAX_POSITION_SECONDS)) ||
      (value.youtubeVideoId !== undefined &&
        (typeof value.youtubeVideoId !== 'string' ||
          !YOUTUBE_VIDEO_ID_RE.test(value.youtubeVideoId))) ||
      (value.youtubeSubIndex !== undefined &&
        (!isSafeNonNegativeInteger(value.youtubeSubIndex) || value.youtubeSubIndex > 100_000))
    ) {
      return null;
    }
    if ((value.youtubeVideoId === undefined) !== (value.youtubeSubIndex === undefined)) return null;
    const selectCommand: Extract<PlaybackAuthorityCommand, { type: 'select' }> = {
      type: 'select',
      baseRevision: value.baseRevision,
      queueItemId: value.queueItemId,
      state: value.state || 'playing',
      positionSeconds: value.positionSeconds || 0,
    };
    if (value.youtubeVideoId === undefined) return selectCommand;
    if (!isSafeNonNegativeInteger(value.youtubeSubIndex)) return null;
    return {
      ...selectCommand,
      youtubeVideoId: value.youtubeVideoId,
      youtubeSubIndex: value.youtubeSubIndex,
    };
  }
  if (value.type === 'ended' || value.type === 'unavailable') {
    if (
      !hasExactKeys(
        value,
        [
          'type',
          'baseRevision',
          'queueItemId',
          'mediaKind',
          'observedPositionSeconds',
          'durationSeconds',
        ],
        ['youtubeVideoId', 'youtubeSubIndex'],
      ) ||
      typeof value.queueItemId !== 'string' ||
      !QUEUE_ITEM_ID_RE.test(value.queueItemId) ||
      (value.mediaKind !== 'file' && value.mediaKind !== 'youtube') ||
      !isFiniteNumber(value.observedPositionSeconds) ||
      value.observedPositionSeconds < 0 ||
      value.observedPositionSeconds > PLAYBACK_MAX_POSITION_SECONDS ||
      (value.durationSeconds !== null &&
        (!isFiniteNumber(value.durationSeconds) ||
          value.durationSeconds <= 0 ||
          value.durationSeconds > PLAYBACK_MAX_POSITION_SECONDS)) ||
      (value.youtubeVideoId !== undefined &&
        (typeof value.youtubeVideoId !== 'string' ||
          !YOUTUBE_VIDEO_ID_RE.test(value.youtubeVideoId))) ||
      (value.youtubeSubIndex !== undefined &&
        (!isSafeNonNegativeInteger(value.youtubeSubIndex) || value.youtubeSubIndex > 100_000)) ||
      (value.youtubeVideoId === undefined) !== (value.youtubeSubIndex === undefined)
    ) {
      return null;
    }
    const observationCommand: Extract<PlaybackAuthorityCommand, { type: 'ended' | 'unavailable' }> =
      {
        type: value.type,
        baseRevision: value.baseRevision,
        queueItemId: value.queueItemId,
        mediaKind: value.mediaKind,
        observedPositionSeconds: value.observedPositionSeconds,
        durationSeconds: value.durationSeconds,
      };
    if (value.youtubeVideoId === undefined) return observationCommand;
    if (!isSafeNonNegativeInteger(value.youtubeSubIndex)) return null;
    return {
      ...observationCommand,
      youtubeVideoId: value.youtubeVideoId,
      youtubeSubIndex: value.youtubeSubIndex,
    };
  }
  return null;
}

function normalizeStoredPlaybackTransition(
  value: unknown,
  room: ProRoomState,
): PlaybackTransition | null {
  if (value === null || value === undefined) return null;
  if (
    !hasExactKeys(
      value,
      [
        'transitionId',
        'coordinatorEpoch',
        'basePlaybackRevision',
        'createdAtMs',
        'deadlineAtMs',
        'target',
        'cohort',
        'ready',
        'developerCommandId',
      ],
      ['resumeFromSleep'],
    ) ||
    typeof value.transitionId !== 'string' ||
    !PLAYBACK_TRANSITION_ID_RE.test(value.transitionId) ||
    value.coordinatorEpoch !== room.presence.coordinatorEpoch ||
    value.basePlaybackRevision !== room.playback.revision ||
    !isSafeNonNegativeInteger(value.createdAtMs) ||
    !isSafeNonNegativeInteger(value.deadlineAtMs) ||
    value.deadlineAtMs < value.createdAtMs ||
    value.deadlineAtMs - value.createdAtMs > PLAYBACK_TRANSITION_DEADLINE_MS ||
    (value.resumeFromSleep !== undefined && value.resumeFromSleep !== true) ||
    (value.developerCommandId !== null &&
      (typeof value.developerCommandId !== 'string' ||
        !DEVELOPER_COMMAND_ID_RE.test(value.developerCommandId)))
  ) {
    return null;
  }
  const cohort = value.cohort;
  const storedReady = value.ready;
  if (
    !isStringArray(cohort) ||
    cohort.length > PRESENCE_MAX_ITEMS ||
    new Set(cohort).size !== cohort.length ||
    cohort.some((incarnationId) => !OPAQUE_ID_RE.test(incarnationId)) ||
    !isRecord(storedReady) ||
    Object.keys(storedReady).some(
      (incarnationId) =>
        !cohort.includes(incarnationId) ||
        (storedReady[incarnationId] !== 'ready' && storedReady[incarnationId] !== 'failed'),
    )
  ) {
    return null;
  }
  const target = parsePlaybackCandidate(
    value.target,
    new Map(room.playlist.map((item: PlaylistItem) => [item.queueItemId, item])),
    isRecord(value.target) && typeof value.target.queueItemId === 'string'
      ? value.target.queueItemId
      : null,
    room.presence.coordinatorEpoch,
  );
  if (!target || target.revision !== room.playback.revision + 1) return null;
  const ready: Record<string, 'ready' | 'failed'> = {};
  for (const incarnationId of Object.keys(storedReady)) {
    const status = storedReady[incarnationId];
    if (status === 'ready' || status === 'failed') ready[incarnationId] = status;
  }
  return {
    transitionId: value.transitionId,
    coordinatorEpoch: room.presence.coordinatorEpoch,
    basePlaybackRevision: room.playback.revision,
    createdAtMs: value.createdAtMs,
    deadlineAtMs: value.deadlineAtMs,
    target,
    cohort: [...cohort],
    ready,
    developerCommandId: value.developerCommandId,
    ...(value.resumeFromSleep === true ? { resumeFromSleep: true } : {}),
  };
}

function playbackTransitionCohortIsTerminal(pending: PlaybackTransition) {
  return pending.cohort.every(
    (incarnationId: string) =>
      pending.ready[incarnationId] === 'ready' || pending.ready[incarnationId] === 'failed',
  );
}

function normalizeStoredPlaybackBroadcastRecord(
  value: unknown,
  room: ProRoomState,
): PlaybackBroadcastRecord | null {
  if (
    !hasExactKeys(value, [
      'kind',
      'coordinatorEpoch',
      'transitionId',
      'basePlaybackRevision',
      'playbackRevision',
      'targets',
      'event',
      'createdAtMs',
      'attempts',
      'retryAtMs',
    ]) ||
    (value.kind !== 'prepare' && value.kind !== 'cancel' && value.kind !== 'commit') ||
    value.coordinatorEpoch !== room.presence.coordinatorEpoch ||
    (value.transitionId !== null &&
      (typeof value.transitionId !== 'string' ||
        !PLAYBACK_TRANSITION_ID_RE.test(value.transitionId))) ||
    !isSafeNonNegativeInteger(value.basePlaybackRevision) ||
    !isSafeNonNegativeInteger(value.playbackRevision) ||
    value.playbackRevision !== value.basePlaybackRevision + 1 ||
    !isStringArray(value.targets) ||
    value.targets.length === 0 ||
    value.targets.length > PRESENCE_MAX_ITEMS ||
    new Set(value.targets).size !== value.targets.length ||
    value.targets.some((target) => !OPAQUE_ID_RE.test(target)) ||
    !isSafeNonNegativeInteger(value.createdAtMs) ||
    !isSafeNonNegativeInteger(value.attempts) ||
    value.attempts > PLAYBACK_BROADCAST_RETRY_MAX_ATTEMPTS ||
    !isSafeInteger(value.retryAtMs) ||
    value.retryAtMs <= 0 ||
    !isRecord(value.event)
  ) {
    return null;
  }

  const event = value.event;
  if (value.kind === 'prepare') {
    if (
      !hasExactKeys(event, [
        'type',
        'transitionId',
        'serverTimeMs',
        'deadlineAtMs',
        'basePlaybackRevision',
        'target',
      ]) ||
      event.type !== 'pro-playback-prepare' ||
      event.transitionId !== value.transitionId ||
      event.basePlaybackRevision !== value.basePlaybackRevision ||
      !isSafeNonNegativeInteger(event.serverTimeMs) ||
      !isSafeNonNegativeInteger(event.deadlineAtMs) ||
      event.deadlineAtMs < event.serverTimeMs ||
      event.deadlineAtMs - event.serverTimeMs > PLAYBACK_TRANSITION_DEADLINE_MS
    ) {
      return null;
    }
    const target = parsePlaybackCandidate(
      event.target,
      new Map(room.playlist.map((item: PlaylistItem) => [item.queueItemId, item])),
      isRecord(event.target) && typeof event.target.queueItemId === 'string'
        ? event.target.queueItemId
        : null,
      value.coordinatorEpoch,
    );
    if (!target || target.revision !== value.playbackRevision) return null;
  } else if (value.kind === 'cancel') {
    if (
      !hasExactKeys(event, ['type', 'transitionId', 'serverTimeMs', 'reason']) ||
      event.type !== 'pro-playback-cancel' ||
      event.transitionId !== value.transitionId ||
      !isSafeNonNegativeInteger(event.serverTimeMs) ||
      typeof event.reason !== 'string' ||
      event.reason.length === 0 ||
      event.reason.length > 64
    ) {
      return null;
    }
  } else {
    if (
      !hasExactKeys(event, ['type', 'transitionId', 'serverTimeMs', 'executeAtMs', 'playback']) ||
      event.type !== 'pro-playback-commit' ||
      event.transitionId !== value.transitionId ||
      !isSafeNonNegativeInteger(event.serverTimeMs) ||
      !isSafeNonNegativeInteger(event.executeAtMs)
    ) {
      return null;
    }
    const playback = parsePlaybackCandidate(
      event.playback,
      new Map(room.playlist.map((item: PlaylistItem) => [item.queueItemId, item])),
      isRecord(event.playback) && typeof event.playback.queueItemId === 'string'
        ? event.playback.queueItemId
        : null,
      value.coordinatorEpoch,
    );
    if (
      !playback ||
      playback.revision !== value.playbackRevision ||
      playback.updatedAtMs !== event.executeAtMs
    ) {
      return null;
    }
  }
  return {
    kind: value.kind,
    coordinatorEpoch: room.presence.coordinatorEpoch,
    transitionId: value.transitionId,
    basePlaybackRevision: value.basePlaybackRevision,
    playbackRevision: value.playbackRevision,
    targets: [...value.targets],
    event: structuredClone(event),
    createdAtMs: value.createdAtMs,
    attempts: value.attempts,
    retryAtMs: value.retryAtMs,
  };
}

function normalizeStoredPlaybackBroadcasts(
  value: unknown,
  room: ProRoomState,
): PlaybackBroadcastRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > PLAYBACK_BROADCAST_OUTBOX_MAX_ITEMS) return [];
  const records = value.map((record) => normalizeStoredPlaybackBroadcastRecord(record, room));
  if (records.some((record) => record === null)) return [];
  const validRecords = records.filter(
    (record): record is PlaybackBroadcastRecord => record !== null,
  );
  if (validRecords.length === 2) {
    const [first, second] = validRecords;
    if (!first || !second) return [];
    const commitThenSuccessor =
      first.kind === 'commit' &&
      second.kind !== 'commit' &&
      first.playbackRevision === second.basePlaybackRevision;
    const cancelThenTransition =
      first.kind === 'cancel' &&
      second.kind !== 'cancel' &&
      first.basePlaybackRevision === second.basePlaybackRevision &&
      first.playbackRevision === second.playbackRevision;
    if (!commitThenSuccessor && !cancelThenTransition) return [];
  }
  return validRecords;
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: unknown): Promise<string> {
  return hex(await sha256Bytes(value));
}

async function botDerivedIdempotencyKey(requestId: string, operation: string) {
  const candidate = `${requestId}.${operation}`;
  if (IDEMPOTENCY_KEY_RE.test(candidate)) return candidate;
  return `bot-${operation}-${await sha256Hex(requestId)}`;
}

function awsEncode(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeObjectPath(path: string) {
  return path.split('/').map(awsEncode).join('/');
}

function canonicalQuery(parameters: Array<[string, string]>) {
  return [...parameters]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join('&');
}

function amzDateParts(now: Date) {
  const value = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: value, dateStamp: value.slice(0, 8) };
}

function r2S3Config(env: ProRoomEnvPort) {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucketName = String(env.R2_BUCKET_NAME || 'musixquare-pro-media').trim();
  return accountId && accessKeyId && secretAccessKey && bucketName
    ? { accountId, accessKeyId, secretAccessKey, bucketName }
    : null;
}

interface R2PresignOptions {
  env: ProRoomEnvPort;
  method: string;
  objectKey: string;
  headers?: HeaderRecord;
  expiresInSeconds: number;
  now: Date;
}

async function createR2PresignedUrl({
  env,
  method,
  objectKey,
  headers = {},
  expiresInSeconds,
  now,
}: R2PresignOptions) {
  const config = r2S3Config(env);
  if (!config) return null;
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = amzDateParts(now);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const canonicalUri = `/${awsEncode(config.bucketName)}/${encodeObjectPath(objectKey)}`;
  const normalizedHeaders: HeaderRecord = { ...headers, host };
  const signedHeaderNames = Object.keys(normalizedHeaders)
    .map((name) => name.toLowerCase())
    .sort();
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(normalizedHeaders[name]).trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const queryParameters: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
    ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresInSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];
  const query = canonicalQuery(queryParameters);
  const canonicalRequest = [
    method,
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join(
    '\n',
  );
  const dateKey = await hmacBytes(encoder.encode(`AWS4${config.secretAccessKey}`), dateStamp);
  const regionKey = await hmacBytes(dateKey, 'auto');
  const serviceKey = await hmacBytes(regionKey, 's3');
  const signingKey = await hmacBytes(serviceKey, 'aws4_request');
  const signature = hex(await hmacBytes(signingKey, stringToSign));
  return `https://${host}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}

class RoomStateCapacityError extends Error {
  constructor() {
    super('PRO room state exceeds its bounded storage budget');
    this.name = 'RoomStateCapacityError';
  }
}

class RoomStateStorageCommitError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
    super(`PRO room state storage transaction failed${detail}`, { cause });
    this.name = 'RoomStateStorageCommitError';
  }
}

function playlistStorageKey(queueItemId: string) {
  return `${STORAGE_V2_PLAYLIST_PREFIX}${queueItemId}`;
}

function playlistItemSignature(item: PlaylistItem) {
  return JSON.stringify(item);
}

function parseStoredPlaylistItem(value: unknown) {
  if (!isRecord(value)) return null;
  const { developerOwnerKeyId, ...publicValue } = value;
  const parsed = parsePlaylistItem(publicValue);
  if (!parsed) return null;
  if (developerOwnerKeyId === undefined) return parsed;
  return typeof developerOwnerKeyId === 'string' &&
    DEVELOPER_API_KEY_ID_RE.test(developerOwnerKeyId)
    ? { ...parsed, developerOwnerKeyId }
    : null;
}

function splitPersistentRoomState(room: ProRoomState) {
  const { playlist: _playlist, ...core } = room;
  return {
    schemaVersion: STORAGE_V2_SCHEMA_VERSION,
    core,
    playlistOrder: room.playlist.map((item: PlaylistItem) => item.queueItemId),
  };
}

function serializedCoreStateByteLength(room: ProRoomState) {
  return encoder.encode(JSON.stringify(splitPersistentRoomState(room))).byteLength;
}

function serializedPlaylistStateByteLength(room: ProRoomState) {
  return encoder.encode(JSON.stringify(room.playlist)).byteLength;
}

function validStoredV2Core(value: unknown): value is StoredV2Envelope {
  if (
    !isRecord(value) ||
    value.schemaVersion !== STORAGE_V2_SCHEMA_VERSION ||
    !isRecord(value.core) ||
    !Array.isArray(value.playlistOrder) ||
    value.playlistOrder.length > PLAYLIST_MAX_ITEMS
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const queueItemId of value.playlistOrder) {
    if (
      typeof queueItemId !== 'string' ||
      !QUEUE_ITEM_ID_RE.test(queueItemId) ||
      ids.has(queueItemId)
    ) {
      return false;
    }
    ids.add(queueItemId);
  }
  return true;
}

async function putStorageEntries(
  storage: DurableObjectStoragePort,
  entries: Array<[string, unknown]>,
) {
  for (let offset = 0; offset < entries.length; offset += 128) {
    const batch = Object.fromEntries(entries.slice(offset, offset + 128));
    if (Object.keys(batch).length > 0) await storage.put(batch);
  }
}

async function getStorageEntries(
  storage: DurableObjectStoragePort,
  keys: string[],
): Promise<Map<string, unknown>> {
  const values = new Map<string, unknown>();
  for (let offset = 0; offset < keys.length; offset += 128) {
    const batch = keys.slice(offset, offset + 128);
    if (batch.length === 0) continue;
    if (batch.length === 1) {
      const key = batch[0];
      if (key !== undefined) values.set(key, await storage.get(key));
      continue;
    }
    const loaded = await storage.get(batch);
    if (!(loaded instanceof Map)) throw new Error('PRO_ROOM_PERSISTENCE_V2_BATCH_INVALID');
    for (const key of batch) values.set(key, loaded.get(key));
  }
  return values;
}

async function deleteStorageKeys(storage: DurableObjectStoragePort, keys: string[]) {
  for (let offset = 0; offset < keys.length; offset += 128) {
    const batch = keys.slice(offset, offset + 128);
    if (batch.length > 0) await storage.delete(batch);
  }
}

function assertBoundedRoomState(room: ProRoomState) {
  if (
    Object.keys(room.presence.participants).length > PRESENCE_MAX_ITEMS ||
    Object.keys(room.sessions).length > SESSION_MAX_ITEMS ||
    Object.keys(room.accountMembers || {}).length > ACCOUNT_MEMBER_MAX_ITEMS ||
    Object.keys(room.anonymousAdministrators || {}).length > ANONYMOUS_ADMIN_MAX_ITEMS ||
    Object.keys(room.accountDeletionTombstones || {}).length >
      ACCOUNT_DELETION_TOMBSTONE_MAX_ITEMS ||
    Object.keys(room.assets).length > ASSET_MAX_ITEMS ||
    Object.keys(room.assets).length + Object.keys(room.stagingTombstones || {}).length >
      ASSET_MAX_ITEMS ||
    Object.keys(room.idempotency).length > IDEMPOTENCY_MAX_ITEMS ||
    Object.keys(room.developerMutationIdempotency || {}).length >
      DEVELOPER_MUTATION_IDEMPOTENCY_MAX_ITEMS ||
    Object.keys(room.rateLimits).length > RATE_LIMIT_MAX_ITEMS ||
    Object.keys(room.botRateLimits || {}).length > BOT_RATE_LIMIT_MAX_ITEMS ||
    Object.keys(room.consumedRecoveryNonces || {}).length > RECOVERY_NONCE_MAX_ITEMS ||
    Object.keys(room.consumedOwnershipTransferClaims || {}).length >
      OWNER_TRANSFER_NONCE_MAX_ITEMS ||
    Object.keys(room.stagingTombstones || {}).length > STAGING_TOMBSTONE_MAX_ITEMS ||
    Object.keys(room.developerCommands || {}).length > DEVELOPER_COMMAND_MAX_ITEMS ||
    Object.keys(room.developerCommandIdempotency || {}).length >
      DEVELOPER_COMMAND_IDEMPOTENCY_MAX_ITEMS ||
    serializedCoreStateByteLength(room) > STATE_MAX_BYTES ||
    serializedPlaylistStateByteLength(room) > PLAYLIST_STATE_MAX_BYTES ||
    room.playlist.some(
      (item: PlaylistItem) =>
        encoder.encode(playlistItemSignature(item)).byteLength > PLAYLIST_ITEM_MAX_BYTES,
    )
  ) {
    throw new RoomStateCapacityError();
  }
}

export default {
  async fetch(request: Request, env: ProRoomEnvPort): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      const workerVersionId = env?.CF_VERSION_METADATA?.id;
      return jsonResponse({
        ok: true,
        service: 'musixquare-pro-room',
        ...(typeof workerVersionId === 'string' && workerVersionId ? { workerVersionId } : {}),
      });
    }
    const maintenanceResponse = await gateServiceMaintenance(request, env, { format: 'json' });
    if (maintenanceResponse) return maintenanceResponse;
    const origin = allowedOrigin(request, env);
    if (request.method === 'OPTIONS') {
      return origin
        ? new Response(null, {
            status: 204,
            headers: { ...SECURITY_HEADERS, ...corsHeaders(origin) },
          })
        : errorResponse('FORBIDDEN_ORIGIN', 403);
    }
    if (!origin) return errorResponse('FORBIDDEN_ORIGIN', 403);
    if (url.search || url.hash || request.url.length > 8192) {
      return withPublicHeaders(errorResponse('INVALID_REQUEST', 400), origin);
    }
    const match = url.pathname.match(/^\/v1\/rooms\/(\d{6})(?:\/|$)/);
    if (!match || !isProRoomCode(match[1])) {
      return withPublicHeaders(errorResponse('ROOM_NOT_FOUND', 404), origin);
    }
    if (url.pathname.startsWith(`/v1/rooms/${match[1]}/internal/`)) {
      return withPublicHeaders(errorResponse('ROOM_NOT_FOUND', 404), origin);
    }
    const ownerTransferPreparePath =
      request.method === 'POST' && url.pathname === `/v1/rooms/${match[1]}/owner-transfer/prepare`;
    const bootstrapPath =
      request.method === 'GET' && url.pathname === `/v1/rooms/${match[1]}/bootstrap`;
    const roomGeneration = await frontProvisionedRoomGeneration(
      match[1],
      env,
      Date.now(),
      ownerTransferPreparePath || bootstrapPath,
    );
    if (roomGeneration === null) {
      return withPublicHeaders(errorResponse('ROOM_NOT_FOUND', 404), origin);
    }
    if (!env.PRO_ROOMS || typeof env.PRO_ROOMS.idFromName !== 'function') {
      return withPublicHeaders(errorResponse('SERVICE_NOT_CONFIGURED', 503), origin);
    }
    const rateSecret = String(env.PRO_ROOM_RATE_LIMIT_SECRET || env.PRO_ROOM_SESSION_SECRET || '');
    if (rateSecret.length < 32) {
      return withPublicHeaders(errorResponse('SERVICE_NOT_CONFIGURED', 503), origin);
    }
    const rawIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      'unknown';
    // Start the public-body deadline before the asynchronous IP HMAC. A slow
    // sender must not gain extra unbounded time merely because the facade is
    // completing unrelated control-plane work before forwarding the request.
    const bodyReadPromise =
      request.method === 'GET' || request.method === 'HEAD'
        ? Promise.resolve({ body: null })
        : readBodyBytesLimited(request, REQUEST_MAX_BYTES, PUBLIC_MUTATION_BODY_TIMEOUT_MS);
    const ipHash = await hmacBase64Url(rateSecret, `pro-room-rate:${rawIp}`);
    const headers = new Headers(request.headers);
    headers.set('x-mxqr-pro-room-code', match[1]);
    headers.set(PRO_ROOM_GENERATION_HEADER, proRoomGenerationHeaderValue(roomGeneration));
    headers.set('x-mxqr-pro-ip-hash', ipHash);
    headers.delete('cf-connecting-ip');
    headers.delete('x-forwarded-for');
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const buffered = await bodyReadPromise;
      if ('error' in buffered && buffered.error === 'too-large') {
        return withPublicHeaders(errorResponse('PRO_ROOM_REQUEST_BODY_TOO_LARGE', 413), origin);
      }
      if ('error' in buffered && (buffered.error === 'timeout' || buffered.error === 'aborted')) {
        return withPublicHeaders(errorResponse('PRO_ROOM_REQUEST_BODY_TIMEOUT', 408), origin);
      }
      if ('error' in buffered) {
        return withPublicHeaders(errorResponse('INVALID_REQUEST', 400), origin);
      }
      body = buffered.body;
    }
    const stub = env.PRO_ROOMS.get(
      env.PRO_ROOMS.idFromName(proRoomObjectName(match[1], roomGeneration)),
    );
    const upstreamInit: RequestInit = { method: request.method, headers, signal: request.signal };
    if (body !== null) upstreamInit.body = body;
    const response = await stub.fetch(new Request(request.url, upstreamInit));
    return withPublicHeaders(response, origin);
  },
} satisfies ProRoomWorkerHandler;

export class MusixquareProRoom {
  readonly state: DurableObjectStatePort;
  readonly storage: DurableObjectStoragePort;
  readonly env: ProRoomEnvPort;
  room: ProRoomState | null;
  mutationTail: Promise<unknown>;
  systemAudioMigrationPending: boolean;
  effectsMigrationPending: boolean;
  queueModeMigrationPending: boolean;
  accountIdentityMigrationPending: boolean;
  developerCommandMigrationPending: boolean;
  playbackAuthorityMigrationPending: boolean;
  persistedPlaylistSignatures: Map<string, string>;
  persistedPresenceLastSeenAtMs: Map<string, number>;
  hasV2Persistence: boolean;
  heartbeatDurabilityDirty: boolean;
  lastHeartbeatDurabilityPersistedAtMs: number | null;
  heartbeatFlushGeneration: number;
  pendingHeartbeatFlushGeneration: number | null;
  pendingHeartbeatFlushTimer: ReturnType<typeof setTimeout> | null;
  stateStorageRollbackDepth: number;
  alarmMaintenanceDirty: boolean;
  alarmMaintenanceRetryAttempt: number;
  alarmMaintenanceRetryTimer: ReturnType<typeof setTimeout> | null;
  scheduledAlarmMs: number | null | undefined;
  ready: Promise<void> | undefined;

  private get activeRoom(): ProRoomState {
    if (!this.room) throw new Error('PRO_ROOM_STATE_UNAVAILABLE');
    return this.room;
  }

  constructor(state: DurableObjectStatePort, env: ProRoomEnvPort = {}) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.room = null;
    this.mutationTail = Promise.resolve();
    this.systemAudioMigrationPending = false;
    this.effectsMigrationPending = false;
    this.queueModeMigrationPending = false;
    this.accountIdentityMigrationPending = false;
    this.developerCommandMigrationPending = false;
    this.playbackAuthorityMigrationPending = false;
    this.persistedPlaylistSignatures = new Map();
    this.persistedPresenceLastSeenAtMs = new Map();
    this.hasV2Persistence = false;
    this.heartbeatDurabilityDirty = false;
    this.lastHeartbeatDurabilityPersistedAtMs = null;
    this.heartbeatFlushGeneration = 0;
    this.pendingHeartbeatFlushGeneration = null;
    this.pendingHeartbeatFlushTimer = null;
    this.stateStorageRollbackDepth = 0;
    this.alarmMaintenanceDirty = false;
    this.alarmMaintenanceRetryAttempt = 0;
    this.alarmMaintenanceRetryTimer = null;
    // `undefined` means a restarted instance has not yet reconciled the
    // storage alarm; `null` means it has authoritatively removed one.
    this.scheduledAlarmMs = undefined;
    const load = async () => {
      await this.loadRoomFromStorage();
      this.normalizeLoadedSystemAudio();
      this.normalizeLoadedEffects();
      this.normalizeLoadedQueueMode();
      this.normalizeLoadedOwnershipTransfer();
      this.normalizeLoadedAccountIdentity();
      this.normalizeLoadedDeveloperCommands();
      this.normalizeLoadedSecurityLedgers();
      this.normalizeLoadedPlaybackAuthority();
      this.normalizeLoadedPlaybackBroadcasts();
      this.normalizeLoadedPresenceBroadcast();
    };
    if (typeof state.blockConcurrencyWhile === 'function') state.blockConcurrencyWhile(load);
    else this.ready = load();
  }

  async ensureReady(request: Request): Promise<boolean> {
    if (this.ready) await this.ready;
    const roomCode =
      request.headers.get('x-mxqr-pro-room-code') ||
      new URL(request.url).pathname.split('/')[3] ||
      '';
    if (!isProRoomCode(roomCode)) return false;
    const generationHeader = request.headers.get(PRO_ROOM_GENERATION_HEADER);
    const roomGeneration =
      generationHeader === null || generationHeader === '' ? NaN : Number(generationHeader);
    if (!isProRoomGeneration(roomGeneration)) return false;
    if (!this.room) {
      this.room = initialRoomState(
        roomCode,
        roomGeneration === INITIAL_PRO_ROOM_GENERATION && INITIAL_PRO_ROOM_CODES.has(roomCode),
        roomGeneration,
      );
    }
    if (!isProRoomGeneration(this.activeRoom.roomGeneration)) return false;
    if (!Number.isSafeInteger(this.activeRoom.activationClaimGeneration)) {
      this.activeRoom.activationClaimGeneration = 0;
    }
    if (!isSafeNonNegativeInteger(this.activeRoom.ownershipTransferClaimGeneration)) {
      this.activeRoom.ownershipTransferClaimGeneration = 0;
    }
    if (!isSafeNonNegativeInteger(this.activeRoom.ownerAuthorityEpoch)) {
      this.activeRoom.ownerAuthorityEpoch = isSafeNonNegativeInteger(this.activeRoom.authEpoch)
        ? this.activeRoom.authEpoch
        : 0;
    }
    if (!isSafeNonNegativeInteger(this.activeRoom.developerAuthorityEpoch)) {
      this.activeRoom.developerAuthorityEpoch = 0;
    }
    if (!this.activeRoom.consumedRecoveryNonces) this.activeRoom.consumedRecoveryNonces = {};
    if (
      !this.activeRoom.consumedOwnershipTransferClaims ||
      typeof this.activeRoom.consumedOwnershipTransferClaims !== 'object' ||
      Array.isArray(this.activeRoom.consumedOwnershipTransferClaims)
    ) {
      this.activeRoom.consumedOwnershipTransferClaims = {};
    }
    if (!this.activeRoom.stagingTombstones) this.activeRoom.stagingTombstones = {};
    this.normalizeLoadedSystemAudio();
    this.normalizeLoadedEffects();
    this.normalizeLoadedQueueMode();
    this.normalizeLoadedOwnershipTransfer();
    this.normalizeLoadedAccountIdentity();
    this.normalizeLoadedDeveloperCommands();
    this.normalizeLoadedSecurityLedgers();
    this.normalizeLoadedPlaybackAuthority();
    this.normalizeLoadedPlaybackBroadcasts();
    this.normalizeLoadedPresenceBroadcast();
    this.reconcileMemberAuthoritySessions();
    if (!Object.prototype.hasOwnProperty.call(this.activeRoom.playback, 'youtubeVideoId')) {
      this.activeRoom.playback.youtubeVideoId = null;
      this.activeRoom.playback.youtubeSubIndex = null;
    }
    for (const session of Object.values(this.activeRoom.sessions)) {
      if (!Number.isSafeInteger(session.signalingTicketSequence)) {
        session.signalingTicketSequence = 0;
      }
    }
    return (
      this.activeRoom.roomCode === roomCode && this.activeRoom.roomGeneration === roomGeneration
    );
  }

  normalizeLoadedSystemAudio() {
    if (!this.room) return;
    const normalizedSystemAudio = normalizeStoredSystemAudio(this.activeRoom.systemAudio);
    if (normalizedSystemAudio) {
      this.activeRoom.systemAudio = normalizedSystemAudio;
    } else {
      const storedGeneration = isSafeNonNegativeInteger(this.activeRoom.systemAudio?.generation)
        ? this.activeRoom.systemAudio.generation
        : 0;
      const mustFenceMalformedLease =
        this.activeRoom.systemAudio && this.activeRoom.systemAudio.status !== 'idle';
      this.activeRoom.systemAudio = initialSystemAudioState(
        mustFenceMalformedLease && storedGeneration < Number.MAX_SAFE_INTEGER
          ? storedGeneration + 1
          : storedGeneration,
      );
      this.systemAudioMigrationPending = true;
    }
  }

  normalizeLoadedEffects() {
    if (!this.room) return;
    const normalized = normalizeStoredEffects(this.activeRoom.effects);
    if (normalized) {
      this.activeRoom.effects = normalized.state;
      this.effectsMigrationPending = this.effectsMigrationPending || normalized.migrated;
      return;
    }
    // Effects predate this dedicated resource. An old room starts from the
    // same neutral DSP state as a fresh client, without changing snapshot v1.
    this.activeRoom.effects = initialEffectsState();
    this.effectsMigrationPending = true;
  }

  normalizeLoadedQueueMode() {
    if (!this.room) return;
    const normalized = normalizeStoredQueueMode(
      this.activeRoom.queueMode,
      this.activeRoom.playlist || [],
    );
    if (normalized) {
      this.activeRoom.queueMode = normalized;
      return;
    }
    // Queue behavior predates this rolling-deploy-safe resource. Preserve the
    // old product default until an authorized participant explicitly changes it.
    this.activeRoom.queueMode = initialQueueModeState();
    this.queueModeMigrationPending = true;
  }

  normalizeLoadedOwnershipTransfer(nowMs = Date.now()) {
    if (!this.room) return;
    const rawClaims = this.activeRoom.consumedOwnershipTransferClaims;
    const normalizedClaims: ProRoomState['consumedOwnershipTransferClaims'] = {};
    if (rawClaims && typeof rawClaims === 'object' && !Array.isArray(rawClaims)) {
      for (const [nonceHash, record] of Object.entries(rawClaims)) {
        if (
          Object.keys(normalizedClaims).length >= OWNER_TRANSFER_NONCE_MAX_ITEMS ||
          !/^[A-Za-z0-9_-]{43}$/.test(nonceHash) ||
          !hasExactKeys(record, ['requestId', 'expiresAtMs']) ||
          typeof record.requestId !== 'string' ||
          !OWNER_TRANSFER_REQUEST_ID_RE.test(record.requestId) ||
          !isSafeInteger(record.expiresAtMs) ||
          record.expiresAtMs <= nowMs
        ) {
          continue;
        }
        normalizedClaims[nonceHash] = {
          requestId: record.requestId,
          expiresAtMs: record.expiresAtMs,
        };
      }
    }
    this.activeRoom.consumedOwnershipTransferClaims = normalizedClaims;
    const allowedReasons = new Set([
      'operator_suspended',
      'owner_account_deleted',
      'ownership_transfer_pending',
    ]);
    this.activeRoom.suspensionReason =
      this.activeRoom.status === 'suspended'
        ? typeof this.activeRoom.suspensionReason === 'string' &&
          allowedReasons.has(this.activeRoom.suspensionReason)
          ? this.activeRoom.suspensionReason
          : 'operator_suspended'
        : null;

    const pending = this.activeRoom.pendingOwnershipTransfer;
    const validPending =
      pending &&
      typeof pending === 'object' &&
      !Array.isArray(pending) &&
      hasExactKeys(pending, [
        'transferId',
        'requestId',
        'targetAccountId',
        'targetDisplayName',
        'previousOwnerAccountId',
        'preservedOwnerMemberId',
        'pin',
        'claimNonceHash',
        'claimGeneration',
        'ownerAuthorityEpoch',
        'preparedAtMs',
        'expiresAtMs',
        'devicePlatform',
        'commitProofHash',
      ]) &&
      OWNER_TRANSFER_ID_RE.test(pending.transferId || '') &&
      OWNER_TRANSFER_REQUEST_ID_RE.test(pending.requestId || '') &&
      ACCOUNT_ID_RE.test(pending.targetAccountId || '') &&
      validDeveloperActorName(pending.targetDisplayName) &&
      (pending.previousOwnerAccountId === null ||
        ACCOUNT_ID_RE.test(pending.previousOwnerAccountId || '')) &&
      OPAQUE_ID_RE.test(pending.preservedOwnerMemberId || '') &&
      this.activeRoom.ownerMemberId === pending.preservedOwnerMemberId &&
      pending.pin &&
      typeof pending.pin === 'object' &&
      !Array.isArray(pending.pin) &&
      typeof pending.pin.salt === 'string' &&
      /^[A-Za-z0-9_-]{16,128}$/.test(pending.pin.salt) &&
      Number.isSafeInteger(pending.pin.iterations) &&
      pending.pin.iterations >= 1 &&
      pending.pin.iterations <= PBKDF2_MAX_ITERATIONS &&
      typeof pending.pin.hash === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(pending.pin.hash) &&
      /^[A-Za-z0-9_-]{43}$/.test(pending.claimNonceHash || '') &&
      isSafeNonNegativeInteger(pending.claimGeneration) &&
      isSafeNonNegativeInteger(pending.ownerAuthorityEpoch) &&
      Number.isSafeInteger(pending.preparedAtMs) &&
      pending.preparedAtMs >= 0 &&
      Number.isSafeInteger(pending.expiresAtMs) &&
      pending.expiresAtMs > pending.preparedAtMs &&
      ['ios', 'android', 'windows', 'macos', 'linux', 'other'].includes(pending.devicePlatform) &&
      /^[A-Za-z0-9_-]{43}$/.test(pending.commitProofHash || '');
    this.activeRoom.pendingOwnershipTransfer = validPending ? pending : null;

    const completed = this.activeRoom.completedOwnershipTransfer;
    const validCompleted =
      completed &&
      typeof completed === 'object' &&
      !Array.isArray(completed) &&
      hasExactKeys(completed, [
        'transferId',
        'requestId',
        'targetAccountId',
        'previousOwnerAccountId',
        'preservedOwnerMemberId',
        'claimNonceHash',
        'commitProofHash',
        'revocationReceiptHash',
        'ownerAuthorityEpoch',
        'authEpoch',
        'preparedAtMs',
        'expiresAtMs',
        'committedAtMs',
        'replayUntilMs',
        'sessionTokenHash',
        'ownerCredentialHash',
      ]) &&
      OWNER_TRANSFER_ID_RE.test(completed.transferId || '') &&
      OWNER_TRANSFER_REQUEST_ID_RE.test(completed.requestId || '') &&
      ACCOUNT_ID_RE.test(completed.targetAccountId || '') &&
      (completed.previousOwnerAccountId === null ||
        ACCOUNT_ID_RE.test(completed.previousOwnerAccountId || '')) &&
      OPAQUE_ID_RE.test(completed.preservedOwnerMemberId || '') &&
      this.activeRoom.ownerMemberId === completed.preservedOwnerMemberId &&
      /^[A-Za-z0-9_-]{43}$/.test(completed.claimNonceHash || '') &&
      /^[A-Za-z0-9_-]{43}$/.test(completed.commitProofHash || '') &&
      /^[A-Za-z0-9_-]{43}$/.test(completed.revocationReceiptHash || '') &&
      isSafeNonNegativeInteger(completed.ownerAuthorityEpoch) &&
      isSafeNonNegativeInteger(completed.authEpoch) &&
      Number.isSafeInteger(completed.preparedAtMs) &&
      completed.preparedAtMs >= 0 &&
      Number.isSafeInteger(completed.expiresAtMs) &&
      completed.expiresAtMs > completed.preparedAtMs &&
      Number.isSafeInteger(completed.committedAtMs) &&
      completed.committedAtMs >= 0 &&
      Number.isSafeInteger(completed.replayUntilMs) &&
      completed.replayUntilMs > completed.committedAtMs &&
      completed.replayUntilMs - completed.committedAtMs <=
        OWNER_TRANSFER_COMPLETED_REPLAY_MAX_LIFETIME_MS &&
      /^[A-Za-z0-9_-]{43}$/.test(completed.sessionTokenHash || '') &&
      /^[A-Za-z0-9_-]{43}$/.test(completed.ownerCredentialHash || '');
    this.activeRoom.completedOwnershipTransfer = validCompleted ? completed : null;

    const removal = this.activeRoom.ownerAuthorityRemoval;
    const validLegacyRemoval =
      removal &&
      typeof removal === 'object' &&
      !Array.isArray(removal) &&
      hasExactKeys(removal, ['accountId', 'removedAtMs', 'ownerAuthorityEpoch']) &&
      ACCOUNT_ID_RE.test(removal.accountId || '') &&
      Number.isSafeInteger(removal.removedAtMs) &&
      removal.removedAtMs >= 0 &&
      isSafeNonNegativeInteger(removal.ownerAuthorityEpoch);
    const validRemovalWithoutCoordinatorEpoch =
      removal &&
      typeof removal === 'object' &&
      !Array.isArray(removal) &&
      hasExactKeys(removal, [
        'accountId',
        'removalId',
        'removedAtMs',
        'ownerAuthorityEpoch',
        'projectionAcked',
      ]) &&
      ACCOUNT_ID_RE.test(removal.accountId || '') &&
      OWNER_AUTHORITY_REMOVAL_ID_RE.test(removal.removalId || '') &&
      Number.isSafeInteger(removal.removedAtMs) &&
      removal.removedAtMs >= 0 &&
      isSafeNonNegativeInteger(removal.ownerAuthorityEpoch) &&
      typeof removal.projectionAcked === 'boolean';
    const validRemoval =
      removal &&
      typeof removal === 'object' &&
      !Array.isArray(removal) &&
      hasExactKeys(removal, [
        'accountId',
        'removalId',
        'removedAtMs',
        'ownerAuthorityEpoch',
        'fencedCoordinatorEpoch',
        'projectionAcked',
      ]) &&
      ACCOUNT_ID_RE.test(removal.accountId || '') &&
      OWNER_AUTHORITY_REMOVAL_ID_RE.test(removal.removalId || '') &&
      Number.isSafeInteger(removal.removedAtMs) &&
      removal.removedAtMs >= 0 &&
      isSafeNonNegativeInteger(removal.ownerAuthorityEpoch) &&
      isSafeNonNegativeInteger(removal.fencedCoordinatorEpoch) &&
      typeof removal.projectionAcked === 'boolean';
    if (validRemoval) {
      this.activeRoom.ownerAuthorityRemoval = removal;
    } else if (validRemovalWithoutCoordinatorEpoch || validLegacyRemoval) {
      // A legacy single-phase purge cannot prove that its App-side D1
      // projection completed. Give it a stable reconciliation identity and
      // require the deletion saga to replay + acknowledge it before a new
      // owner may be installed. The first projection-saga format already has
      // that identity; preserve its acknowledgement while binding it to the
      // room's current monotonic signaling epoch during this one-time upgrade.
      this.activeRoom.ownerAuthorityRemoval = {
        accountId: removal.accountId,
        removalId: validRemovalWithoutCoordinatorEpoch
          ? removal.removalId
          : `removal_${randomToken(16)}`,
        removedAtMs: removal.removedAtMs,
        ownerAuthorityEpoch: removal.ownerAuthorityEpoch,
        fencedCoordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
        projectionAcked: validRemovalWithoutCoordinatorEpoch ? removal.projectionAcked : false,
      };
      this.accountIdentityMigrationPending = true;
    } else {
      this.activeRoom.ownerAuthorityRemoval = null;
    }
  }

  normalizeLoadedAccountDeletionTombstones() {
    if (!this.room) return;
    const stored = this.activeRoom.accountDeletionTombstones;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      this.activeRoom.accountDeletionTombstones = {};
      return;
    }
    const normalized: Record<string, number> = {};
    const entries = Object.entries(stored)
      .filter(
        ([accountId, expiresAtMs]) =>
          /^acct_[A-Za-z0-9_-]{22}$/.test(accountId) &&
          isSafeInteger(expiresAtMs) &&
          expiresAtMs > 0,
      )
      // If a legacy/corrupt single-record state exceeds the current bound,
      // retain the tombstones that protect accounts for the longest period.
      .sort(([, left], [, right]) => right - left)
      .slice(0, ACCOUNT_DELETION_TOMBSTONE_MAX_ITEMS);
    for (const [accountId, expiresAtMs] of entries) normalized[accountId] = expiresAtMs;
    this.activeRoom.accountDeletionTombstones = normalized;
  }

  normalizeLoadedAccountIdentity() {
    if (!this.room) return;
    const canFenceAnonymousIdentityMigration =
      this.activeRoom.revision < Number.MAX_SAFE_INTEGER &&
      this.activeRoom.presence.revision < Number.MAX_SAFE_INTEGER;
    let anonymousIdentityChanged = false;
    this.normalizeLoadedAccountDeletionTombstones();
    if (
      !this.activeRoom.accountMembers ||
      typeof this.activeRoom.accountMembers !== 'object' ||
      Array.isArray(this.activeRoom.accountMembers)
    ) {
      this.activeRoom.accountMembers = {};
    }
    const normalizedMembers: Record<string, AccountMember> = {};
    let highestDisplayNumber = 0;
    for (const [accountId, member] of Object.entries(this.activeRoom.accountMembers)) {
      const permissions =
        member?.role === 'owner'
          ? clonePermissionSet(OWNER_PERMISSIONS)
          : member?.role === 'controller'
            ? normalizePermissionSet(member.permissions, DELEGATED_ADMIN_PERMISSIONS)
            : member?.role === 'member'
              ? clonePermissionSet(MEMBER_PERMISSIONS)
              : null;
      const valid =
        /^acct_[A-Za-z0-9_-]{22}$/.test(accountId) &&
        member &&
        typeof member === 'object' &&
        !Array.isArray(member) &&
        OPAQUE_ID_RE.test(member.memberId || '') &&
        validDeveloperActorName(member.displayName) &&
        Number.isSafeInteger(member.displayNumber) &&
        member.displayNumber >= 0 &&
        member.displayNumber <= SESSION_MAX_ITEMS &&
        (member.role === 'owner' || member.role === 'controller' || member.role === 'member') &&
        permissions !== null &&
        Number.isSafeInteger(member.createdAtMs) &&
        member.createdAtMs >= 0 &&
        Number.isSafeInteger(member.updatedAtMs) &&
        member.updatedAtMs >= member.createdAtMs;
      if (!valid || Object.keys(normalizedMembers).length >= ACCOUNT_MEMBER_MAX_ITEMS) continue;
      normalizedMembers[accountId] = {
        memberId: member.memberId,
        displayName: member.displayName,
        displayNumber: member.displayNumber,
        role: member.role,
        permissions,
        createdAtMs: member.createdAtMs,
        updatedAtMs: member.updatedAtMs,
      };
      highestDisplayNumber = Math.max(highestDisplayNumber, member.displayNumber);
    }
    this.activeRoom.accountMembers = normalizedMembers;
    const normalizedOwner =
      typeof this.activeRoom.ownerAccountId === 'string'
        ? normalizedMembers[this.activeRoom.ownerAccountId]
        : undefined;
    if (!normalizedOwner || normalizedOwner.role !== 'owner') {
      this.activeRoom.ownerAccountId = null;
    }
    if (
      typeof this.activeRoom.ownerDisplayName !== 'string' ||
      !validDeveloperActorName(this.activeRoom.ownerDisplayName)
    ) {
      this.activeRoom.ownerDisplayName = this.activeRoom.ownerAccountId
        ? normalizedMembers[this.activeRoom.ownerAccountId]?.displayName || 'Owner'
        : Object.values(this.activeRoom.sessions || {}).find((session) => session.role === 'owner')
            ?.displayName || 'Owner';
    }
    if (
      !this.activeRoom.anonymousAdministrators ||
      typeof this.activeRoom.anonymousAdministrators !== 'object' ||
      Array.isArray(this.activeRoom.anonymousAdministrators)
    ) {
      this.activeRoom.anonymousAdministrators = {};
    }
    const normalizedAnonymousAdministrators: Record<string, AnonymousAdministrator> = {};
    for (const [memberId, administrator] of Object.entries(
      this.activeRoom.anonymousAdministrators,
    )) {
      const permissions = normalizePermissionSet(
        administrator?.permissions,
        DELEGATED_ADMIN_PERMISSIONS,
      );
      const valid =
        OPAQUE_ID_RE.test(memberId) &&
        administrator &&
        typeof administrator === 'object' &&
        !Array.isArray(administrator) &&
        administrator.memberId === memberId &&
        validDeveloperActorName(administrator.displayName) &&
        Number.isSafeInteger(administrator.displayNumber) &&
        administrator.displayNumber > 0 &&
        administrator.displayNumber <= SESSION_MAX_ITEMS &&
        permissions !== null &&
        Number.isSafeInteger(administrator.createdAtMs) &&
        administrator.createdAtMs >= 0 &&
        Number.isSafeInteger(administrator.updatedAtMs) &&
        administrator.updatedAtMs >= administrator.createdAtMs;
      if (
        !valid ||
        Object.keys(normalizedAnonymousAdministrators).length >= ANONYMOUS_ADMIN_MAX_ITEMS
      ) {
        continue;
      }
      normalizedAnonymousAdministrators[memberId] = {
        memberId,
        displayName: administrator.displayName,
        displayNumber: administrator.displayNumber,
        permissions,
        createdAtMs: administrator.createdAtMs,
        updatedAtMs: administrator.updatedAtMs,
      };
      highestDisplayNumber = Math.max(highestDisplayNumber, administrator.displayNumber);
    }
    this.activeRoom.anonymousAdministrators = normalizedAnonymousAdministrators;
    const storedNext = this.activeRoom.nextMemberDisplayNumber;
    this.activeRoom.nextMemberDisplayNumber =
      Number.isSafeInteger(storedNext) &&
      storedNext >= 1 &&
      storedNext <= SESSION_MAX_ITEMS + 1 &&
      storedNext > highestDisplayNumber
        ? storedNext
        : Math.min(SESSION_MAX_ITEMS + 1, highestDisplayNumber + 1);

    for (const session of Object.values(this.activeRoom.sessions || {})) {
      if (typeof session.accountId !== 'string') {
        delete session.accountId;
        delete session.accountLeaseExpiresAtMs;
        if (session.role !== 'owner' && !canFenceAnonymousIdentityMigration) continue;
        const fallbackDisplayNumber =
          session.role === 'owner'
            ? 0
            : isSafeInteger(session.memberDisplayNumber)
              ? session.memberDisplayNumber
              : isSafeInteger(session.peerOrdinal)
                ? session.peerOrdinal
                : this.nextAccountMemberDisplayNumber();
        if (isSafeInteger(fallbackDisplayNumber)) {
          session.memberDisplayNumber = fallbackDisplayNumber;
        }
        continue;
      }
      const member = normalizedMembers[session.accountId];
      if (!member || session.memberId !== member.memberId) {
        delete session.accountId;
        delete session.accountLeaseExpiresAtMs;
        delete session.memberDisplayNumber;
        continue;
      }
      // Account authority is renewable proof, not a property of the long-lived
      // room cookie. Sessions written before this field existed fail closed on
      // the first prune and can immediately reattach from a still-valid App
      // account session without disturbing room playback.
      if (!isSafeInteger(session.accountLeaseExpiresAtMs) || session.accountLeaseExpiresAtMs <= 0) {
        session.accountLeaseExpiresAtMs = 0;
      }
      session.displayName = member.displayName;
      session.memberDisplayNumber = member.displayNumber;
      session.role = member.role;
    }
    // A member number identifies a person, while `peerOrdinal` reserves each
    // physical device's admission slot. Rebuild missing/duplicate legacy
    // reservations deterministically so an account with three devices keeps
    // member #1 while the next member starts at #4 after an isolate restart.
    anonymousIdentityChanged =
      this.normalizeLoadedPhysicalSlotAssignments(canFenceAnonymousIdentityMigration) ||
      anonymousIdentityChanged;
    for (const participant of Object.values(this.activeRoom.presence?.participants || {})) {
      const session = this.activeRoom.sessions?.[participant.sessionHash];
      if (!session?.accountId) {
        if (session?.role !== 'owner' && !canFenceAnonymousIdentityMigration) {
          continue;
        }
        if (
          session?.role !== 'owner' &&
          session &&
          (participant.accountId !== undefined ||
            participant.memberId !== session.memberId ||
            participant.displayName !== session.displayName ||
            participant.role !== session.role ||
            participant.memberDisplayNumber !== session.memberDisplayNumber)
        ) {
          anonymousIdentityChanged = true;
        }
        delete participant.accountId;
        if (session) {
          participant.memberId = session.memberId;
          participant.displayName = session.displayName;
          participant.role = session.role;
        }
        if (session && isSafeInteger(session.memberDisplayNumber)) {
          participant.memberDisplayNumber = session.memberDisplayNumber;
        } else {
          delete participant.memberDisplayNumber;
        }
        continue;
      }
      participant.accountId = session.accountId;
      participant.memberId = session.memberId;
      participant.displayName = session.displayName;
      if (isSafeInteger(session.memberDisplayNumber)) {
        participant.memberDisplayNumber = session.memberDisplayNumber;
      } else {
        delete participant.memberDisplayNumber;
      }
      participant.role = session.role;
    }
    if (anonymousIdentityChanged) {
      this.activeRoom.presence.revision += 1;
      this.activeRoom.revision += 1;
      this.accountIdentityMigrationPending = true;
    }
  }

  reconcileMemberAuthoritySessions() {
    for (const session of Object.values(this.activeRoom.sessions || {})) {
      if (session.role === 'owner' || session.memberId === this.activeRoom.ownerMemberId) {
        session.role = 'owner';
      } else if (session.accountId) {
        session.role = this.activeRoom.accountMembers?.[session.accountId]?.role || 'member';
      } else {
        session.role = this.activeRoom.anonymousAdministrators?.[session.memberId]
          ? 'controller'
          : 'member';
      }
      const participant = this.activeRoom.presence?.participants?.[session.participantId];
      if (participant) participant.role = session.role;
    }
  }

  normalizeLoadedDeveloperCommands() {
    if (!this.room) return;
    if (
      !this.activeRoom.developerCommands ||
      typeof this.activeRoom.developerCommands !== 'object' ||
      Array.isArray(this.activeRoom.developerCommands)
    ) {
      this.activeRoom.developerCommands = {};
      this.developerCommandMigrationPending = true;
    }
    if (
      !this.activeRoom.developerCommandIdempotency ||
      typeof this.activeRoom.developerCommandIdempotency !== 'object' ||
      Array.isArray(this.activeRoom.developerCommandIdempotency)
    ) {
      this.activeRoom.developerCommandIdempotency = {};
      this.developerCommandMigrationPending = true;
    }
    for (const participant of Object.values(this.activeRoom.presence?.participants || {})) {
      if (
        !Number.isSafeInteger(participant.developerControlVersion) ||
        participant.developerControlVersion < 0 ||
        participant.developerControlVersion > DEVELOPER_CONTROL_MAX_VERSION
      ) {
        participant.developerControlVersion = 0;
        this.developerCommandMigrationPending = true;
      }
    }
    for (const record of Object.values(this.activeRoom.developerCommands)) {
      const command = parseDeveloperCommand(record?.command);
      const requiredVersion = requiredDeveloperControlVersion(command);
      if (record?.developerControlVersion !== requiredVersion) {
        record.developerControlVersion = requiredVersion;
        this.developerCommandMigrationPending = true;
      }
    }
  }

  normalizeLoadedSecurityLedgers() {
    if (!this.room) return;
    if (!isSafeNonNegativeInteger(this.activeRoom.developerAuthorityEpoch)) {
      this.activeRoom.developerAuthorityEpoch = 0;
      this.developerCommandMigrationPending = true;
    }
    if (
      !this.activeRoom.developerMutationIdempotency ||
      typeof this.activeRoom.developerMutationIdempotency !== 'object' ||
      Array.isArray(this.activeRoom.developerMutationIdempotency)
    ) {
      this.activeRoom.developerMutationIdempotency = {};
      this.developerCommandMigrationPending = true;
    }
    if (
      !this.activeRoom.botRateLimits ||
      typeof this.activeRoom.botRateLimits !== 'object' ||
      Array.isArray(this.activeRoom.botRateLimits)
    ) {
      this.activeRoom.botRateLimits = {};
      this.developerCommandMigrationPending = true;
    }

    // Move legacy Developer API receipts out of the participant/browser
    // ledger without dropping any live record. If a mixed rolling-deploy
    // state already filled the new ledger, leave the remaining legacy
    // receipts in place; replay reads both ledgers until their TTL expires.
    for (const [storageKey, record] of Object.entries(this.activeRoom.idempotency || {})) {
      if (!storageKey.startsWith('developer:')) continue;
      if (this.activeRoom.developerMutationIdempotency[storageKey] !== undefined) {
        if (
          JSON.stringify(this.activeRoom.developerMutationIdempotency[storageKey]) ===
          JSON.stringify(record)
        ) {
          delete this.activeRoom.idempotency[storageKey];
          this.developerCommandMigrationPending = true;
        }
        continue;
      }
      if (
        Object.keys(this.activeRoom.developerMutationIdempotency).length >=
        DEVELOPER_MUTATION_IDEMPOTENCY_MAX_ITEMS
      ) {
        continue;
      }
      this.activeRoom.developerMutationIdempotency[storageKey] = record;
      delete this.activeRoom.idempotency[storageKey];
      this.developerCommandMigrationPending = true;
    }

    // BOT context limits are authenticated automation policy, while the
    // remaining map protects activation, owner recovery, and PIN admission.
    // Keeping their capacity independent prevents unrelated IP churn from
    // erasing or crowding out the room-wide BOT counter.
    for (const [key, record] of Object.entries(this.activeRoom.rateLimits || {})) {
      if (
        !key.startsWith('bot-minute:') &&
        !key.startsWith('bot-room-hour-v1:') &&
        !key.startsWith('bot-day:')
      ) {
        continue;
      }
      if (this.activeRoom.botRateLimits[key] !== undefined) {
        if (JSON.stringify(this.activeRoom.botRateLimits[key]) === JSON.stringify(record)) {
          delete this.activeRoom.rateLimits[key];
          this.developerCommandMigrationPending = true;
        }
        continue;
      }
      if (Object.keys(this.activeRoom.botRateLimits).length >= BOT_RATE_LIMIT_MAX_ITEMS) continue;
      this.activeRoom.botRateLimits[key] = record;
      delete this.activeRoom.rateLimits[key];
      this.developerCommandMigrationPending = true;
    }
  }

  normalizeLoadedPlaybackAuthority() {
    if (!this.room?.presence || !this.activeRoom.playback) return;
    let changed = false;
    // A PRO room has no browser coordinator. Keep the historical field as a
    // room-incarnation fence during this protocol cutover, but it must never
    // identify or grant authority to a participant.
    if (this.activeRoom.presence.coordinatorParticipantId !== null) {
      this.activeRoom.presence.coordinatorParticipantId = null;
      if (this.activeRoom.presence.coordinatorEpoch < Number.MAX_SAFE_INTEGER) {
        this.activeRoom.presence.coordinatorEpoch += 1;
      }
      changed = true;
    }
    if (this.activeRoom.playback.coordinatorEpoch !== this.activeRoom.presence.coordinatorEpoch) {
      this.activeRoom.playback.coordinatorEpoch = this.activeRoom.presence.coordinatorEpoch;
      if (this.activeRoom.playback.revision < Number.MAX_SAFE_INTEGER) {
        this.activeRoom.playback.revision += 1;
      }
      changed = true;
    }
    const pending = normalizeStoredPlaybackTransition(
      this.activeRoom.pendingPlaybackTransition,
      this.activeRoom,
    );
    if (pending === null && this.activeRoom.pendingPlaybackTransition !== null) changed = true;
    this.activeRoom.pendingPlaybackTransition = pending;
    this.playbackAuthorityMigrationPending = this.playbackAuthorityMigrationPending || changed;
  }

  normalizeLoadedPlaybackBroadcasts() {
    if (!this.room) return;
    const raw = this.activeRoom.pendingPlaybackBroadcasts;
    const normalized = normalizeStoredPlaybackBroadcasts(raw, this.activeRoom);
    if (JSON.stringify(raw ?? []) !== JSON.stringify(normalized)) {
      this.playbackAuthorityMigrationPending = true;
    }
    this.activeRoom.pendingPlaybackBroadcasts = normalized;
  }

  normalizeLoadedPresenceBroadcast() {
    if (!this.room) return;
    const pending = this.activeRoom.pendingPresenceBroadcast;
    if (pending === undefined || pending === null) {
      this.activeRoom.pendingPresenceBroadcast = null;
      return;
    }
    if (
      !hasExactKeys(pending, [
        'coordinatorEpoch',
        'presenceRevision',
        'roomRevision',
        'retryAtMs',
        'attempts',
      ]) ||
      !isSafeNonNegativeInteger(pending.coordinatorEpoch) ||
      !isSafeNonNegativeInteger(pending.presenceRevision) ||
      !isSafeNonNegativeInteger(pending.roomRevision) ||
      !Number.isSafeInteger(pending.retryAtMs) ||
      pending.retryAtMs <= 0 ||
      !isSafeNonNegativeInteger(pending.attempts) ||
      pending.attempts > PRESENCE_BROADCAST_RETRY_MAX_ATTEMPTS
    ) {
      this.activeRoom.pendingPresenceBroadcast = null;
    }
  }

  async withMutation<T>(callback: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  captureInMemoryState(): InMemoryCheckpoint {
    return {
      room: structuredClone(this.room),
      persistedPlaylistSignatures: new Map(this.persistedPlaylistSignatures),
      persistedPresenceLastSeenAtMs: new Map(this.persistedPresenceLastSeenAtMs),
      hasV2Persistence: this.hasV2Persistence,
      heartbeatDurabilityDirty: this.heartbeatDurabilityDirty,
      lastHeartbeatDurabilityPersistedAtMs: this.lastHeartbeatDurabilityPersistedAtMs,
      heartbeatFlushGeneration: this.heartbeatFlushGeneration,
      pendingHeartbeatFlushGeneration: this.pendingHeartbeatFlushGeneration,
      pendingHeartbeatFlushTimer: this.pendingHeartbeatFlushTimer,
      scheduledAlarmMs: this.scheduledAlarmMs,
      systemAudioMigrationPending: this.systemAudioMigrationPending,
      effectsMigrationPending: this.effectsMigrationPending,
      queueModeMigrationPending: this.queueModeMigrationPending,
      accountIdentityMigrationPending: this.accountIdentityMigrationPending,
      developerCommandMigrationPending: this.developerCommandMigrationPending,
      playbackAuthorityMigrationPending: this.playbackAuthorityMigrationPending,
      alarmMaintenanceDirty: this.alarmMaintenanceDirty,
      alarmMaintenanceRetryAttempt: this.alarmMaintenanceRetryAttempt,
      alarmMaintenanceRetryTimer: this.alarmMaintenanceRetryTimer,
    };
  }

  restoreInMemoryState(checkpoint: InMemoryCheckpoint) {
    if (
      this.pendingHeartbeatFlushTimer !== null &&
      this.pendingHeartbeatFlushTimer !== checkpoint.pendingHeartbeatFlushTimer
    ) {
      clearTimeout(this.pendingHeartbeatFlushTimer);
    }
    if (
      this.alarmMaintenanceRetryTimer !== null &&
      this.alarmMaintenanceRetryTimer !== checkpoint.alarmMaintenanceRetryTimer
    ) {
      clearTimeout(this.alarmMaintenanceRetryTimer);
    }
    this.room = checkpoint.room;
    this.persistedPlaylistSignatures = checkpoint.persistedPlaylistSignatures;
    this.persistedPresenceLastSeenAtMs = checkpoint.persistedPresenceLastSeenAtMs;
    this.hasV2Persistence = checkpoint.hasV2Persistence;
    this.heartbeatDurabilityDirty = checkpoint.heartbeatDurabilityDirty;
    this.lastHeartbeatDurabilityPersistedAtMs = checkpoint.lastHeartbeatDurabilityPersistedAtMs;
    this.heartbeatFlushGeneration = checkpoint.heartbeatFlushGeneration;
    this.pendingHeartbeatFlushGeneration = checkpoint.pendingHeartbeatFlushGeneration;
    this.pendingHeartbeatFlushTimer = checkpoint.pendingHeartbeatFlushTimer;
    this.scheduledAlarmMs = checkpoint.scheduledAlarmMs;
    this.systemAudioMigrationPending = checkpoint.systemAudioMigrationPending;
    this.effectsMigrationPending = checkpoint.effectsMigrationPending;
    this.queueModeMigrationPending = checkpoint.queueModeMigrationPending;
    this.accountIdentityMigrationPending = checkpoint.accountIdentityMigrationPending;
    this.developerCommandMigrationPending = checkpoint.developerCommandMigrationPending;
    this.playbackAuthorityMigrationPending = checkpoint.playbackAuthorityMigrationPending;
    this.alarmMaintenanceDirty = checkpoint.alarmMaintenanceDirty;
    this.alarmMaintenanceRetryAttempt = checkpoint.alarmMaintenanceRetryAttempt;
    this.alarmMaintenanceRetryTimer = checkpoint.alarmMaintenanceRetryTimer;
  }

  async withStateCapacityRollback<T>(
    callback: () => T | Promise<T>,
    options: { rollbackStorageFailure?: boolean } = {},
  ): Promise<T | Response> {
    const checkpoint = this.captureInMemoryState();
    const rollbackStorageFailure = options.rollbackStorageFailure === true;
    if (rollbackStorageFailure) this.stateStorageRollbackDepth += 1;
    try {
      return await callback();
    } catch (error) {
      if (error instanceof RoomStateCapacityError) {
        this.restoreInMemoryState(checkpoint);
        await this.persist();
        return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
      }
      if (rollbackStorageFailure && error instanceof RoomStateStorageCommitError) {
        // The SQLite transaction failed atomically, so the durable state still
        // matches this checkpoint. Restore every cache/fence alongside `room`
        // and let the caller observe the original storage failure. In
        // particular, a pending heartbeat retry must never persist the aborted
        // mutation later as a ghost commit.
        this.restoreInMemoryState(checkpoint);
      }
      throw error;
    } finally {
      if (rollbackStorageFailure) this.stateStorageRollbackDepth -= 1;
    }
  }

  async loadRoomFromStorage() {
    const storedV2 = await this.storage.get(STORAGE_V2_CORE_KEY);
    if (storedV2 !== undefined && storedV2 !== null) {
      if (!validStoredV2Core(storedV2)) {
        throw new Error('PRO_ROOM_PERSISTENCE_V2_CORE_INVALID');
      }
      const playlistKeys = storedV2.playlistOrder.map(playlistStorageKey);
      const storedPlaylist = await getStorageEntries(this.storage, playlistKeys);
      const playlist = [];
      for (const queueItemId of storedV2.playlistOrder) {
        const item = parseStoredPlaylistItem(storedPlaylist.get(playlistStorageKey(queueItemId)));
        if (!item || item.queueItemId !== queueItemId) {
          throw new Error('PRO_ROOM_PERSISTENCE_V2_PLAYLIST_INVALID');
        }
        playlist.push(item);
      }
      const room = { ...storedV2.core, playlist };
      assertBoundedRoomState(room);
      this.room = room;
      this.persistedPlaylistSignatures = new Map(
        playlist.map((item) => [item.queueItemId, playlistItemSignature(item)]),
      );
      this.persistedPresenceLastSeenAtMs = new Map(
        Object.values(room.presence.participants).map((participant) => [
          participant.participantId,
          participant.lastSeenAtMs,
        ]),
      );
      this.hasV2Persistence = true;
      return;
    }

    this.room = null;
    this.persistedPlaylistSignatures = new Map();
    this.persistedPresenceLastSeenAtMs = new Map();
    this.hasV2Persistence = false;
  }

  invalidatePendingHeartbeatFlush() {
    if (this.pendingHeartbeatFlushTimer !== null) {
      clearTimeout(this.pendingHeartbeatFlushTimer);
      this.pendingHeartbeatFlushTimer = null;
    }
    if (this.pendingHeartbeatFlushGeneration === null) return;
    this.pendingHeartbeatFlushGeneration = null;
    this.heartbeatFlushGeneration += 1;
  }

  async scheduleHeartbeatPersistRetryAlarm() {
    if (typeof this.storage.setAlarm !== 'function') return;
    const retryAtMs = Date.now() + PRESENCE_HEARTBEAT_PERSIST_RETRY_MS;
    if (
      isSafeInteger(this.scheduledAlarmMs) &&
      this.scheduledAlarmMs > Date.now() &&
      this.scheduledAlarmMs <= retryAtMs
    ) {
      return;
    }
    try {
      await this.storage.setAlarm(retryAtMs);
      this.scheduledAlarmMs = retryAtMs;
    } catch {
      // The next ordinary heartbeat can install another coalesced flush. A
      // storage outage must never escape the timer callback as an unhandled
      // rejection merely because even the recovery alarm could not be set.
    }
  }

  async flushHeartbeatDurability(generation: number) {
    if (this.pendingHeartbeatFlushGeneration !== generation) return;
    if (!this.heartbeatDurabilityDirty) return;
    try {
      await this.persist({
        retainEarlierAlarm: true,
        heartbeatFlushGeneration: generation,
      });
    } catch {
      // Keep the dirty bit set. A later heartbeat will schedule a fresh
      // generation, while the retry alarm lets an otherwise-idle room recover
      // without producing an unhandled timer-callback rejection.
      if (this.pendingHeartbeatFlushGeneration === generation) {
        this.pendingHeartbeatFlushGeneration = null;
        this.pendingHeartbeatFlushTimer = null;
        this.heartbeatFlushGeneration += 1;
      }
      await this.scheduleHeartbeatPersistRetryAlarm();
    }
  }

  scheduleHeartbeatDurability(nowMs: number) {
    this.heartbeatDurabilityDirty = true;
    if (this.pendingHeartbeatFlushGeneration !== null) return true;
    if (!isSafeInteger(this.lastHeartbeatDurabilityPersistedAtMs)) return false;
    const windowEndsAtMs =
      this.lastHeartbeatDurabilityPersistedAtMs + PRESENCE_HEARTBEAT_PERSIST_COALESCE_MS;
    if (nowMs >= windowEndsAtMs) return false;
    const generation = this.heartbeatFlushGeneration + 1;
    this.heartbeatFlushGeneration = generation;
    this.pendingHeartbeatFlushGeneration = generation;
    // DurableObjectState.waitUntil() is a compatibility no-op. A timer keeps
    // the object non-hibernateable, so only dense traffic pays this cost: the
    // first heartbeat after a quiet period persists inline, and a second one
    // inside its one-second window opens the timer for the remaining duration.
    this.pendingHeartbeatFlushTimer = setTimeout(
      () => {
        if (this.pendingHeartbeatFlushGeneration === generation) {
          this.pendingHeartbeatFlushTimer = null;
        }
        readServiceMaintenance(this.env)
          .then((maintenance) => {
            if (maintenance.enabled) return undefined;
            return this.withMutation(async () => {
              if ((await readServiceMaintenance(this.env)).enabled) return;
              await this.flushHeartbeatDurability(generation);
            });
          })
          .catch(() => undefined);
      },
      Math.max(0, windowEndsAtMs - nowMs),
    );
    return true;
  }

  async persist(options: PersistOptions = {}) {
    const heartbeatFlushGeneration = options.heartbeatFlushGeneration;
    if (
      heartbeatFlushGeneration !== undefined &&
      this.pendingHeartbeatFlushGeneration !== heartbeatFlushGeneration
    ) {
      return false;
    }
    try {
      await this.persistRoom(options);
    } catch (error) {
      // Do not absorb the pending generation until the full transaction and
      // alarm maintenance have both succeeded. If this was the only pending
      // heartbeat work, leave a short recovery alarm before propagating the
      // original mutation failure to its caller.
      if (
        !(error instanceof RoomStateStorageCommitError && this.stateStorageRollbackDepth > 0) &&
        this.heartbeatDurabilityDirty &&
        this.pendingHeartbeatFlushGeneration === null
      ) {
        await this.scheduleHeartbeatPersistRetryAlarm();
      }
      throw error;
    }
    if (this.heartbeatDurabilityDirty) {
      this.lastHeartbeatDurabilityPersistedAtMs = Date.now();
    }
    this.heartbeatDurabilityDirty = false;
    this.invalidatePendingHeartbeatFlush();
    if (options.flushPlaybackOutbox !== false) {
      // The canonical mutation and its playback event are now durable. Only at
      // this point may the cross-Worker dispatch begin.
      await this.flushPendingPlaybackBroadcasts(Date.now());
    }
    return true;
  }

  async persistRoom(options: PersistOptions = {}) {
    assertBoundedRoomState(this.activeRoom);
    const storedCore = splitPersistentRoomState(this.activeRoom);
    const nextSignatures = new Map(
      this.activeRoom.playlist.map((item) => [item.queueItemId, playlistItemSignature(item)]),
    );
    const changedEntries = this.activeRoom.playlist
      .filter(
        (item) =>
          !this.hasV2Persistence ||
          this.persistedPlaylistSignatures.get(item.queueItemId) !==
            nextSignatures.get(item.queueItemId),
      )
      .map((item): [string, unknown] => [playlistStorageKey(item.queueItemId), item]);
    const removedKeys = [...this.persistedPlaylistSignatures.keys()]
      .filter((queueItemId) => !nextSignatures.has(queueItemId))
      .map(playlistStorageKey);
    const write = async (storage: DurableObjectStoragePort) => {
      await putStorageEntries(storage, changedEntries);
      await deleteStorageKeys(storage, removedKeys);
      await storage.put(STORAGE_V2_CORE_KEY, storedCore);
    };
    try {
      if (typeof this.storage.transaction === 'function') {
        await this.storage.transaction((transaction) => write(transaction));
      } else {
        // Unit-test and local compatibility fallback. Production SQLite-backed
        // Durable Objects provide transaction(), which makes row/core changes
        // atomic.
        await write(this.storage);
      }
    } catch (error) {
      throw new RoomStateStorageCommitError(error);
    }
    this.persistedPlaylistSignatures = nextSignatures;
    this.persistedPresenceLastSeenAtMs = new Map(
      Object.values(this.activeRoom.presence.participants).map((participant) => [
        participant.participantId,
        participant.lastSeenAtMs,
      ]),
    );
    this.hasV2Persistence = true;
    // The room transaction above is already authoritative. Alarm maintenance
    // is a post-commit scheduling concern: a transient setAlarm/deleteAlarm
    // failure must not turn a committed mutation into an apparent failed one.
    // Retry it independently without rolling the canonical state back.
    await this.maintainAlarm({ retainEarlier: options.retainEarlierAlarm === true });
  }

  clearAlarmMaintenanceRetry() {
    if (this.alarmMaintenanceRetryTimer !== null) {
      clearTimeout(this.alarmMaintenanceRetryTimer);
      this.alarmMaintenanceRetryTimer = null;
    }
  }

  scheduleAlarmMaintenanceRetry() {
    if (this.alarmMaintenanceRetryTimer !== null) return;
    const delay = Math.min(
      ALARM_MAINTENANCE_RETRY_MAX_MS,
      PRESENCE_HEARTBEAT_PERSIST_RETRY_MS * 2 ** Math.min(this.alarmMaintenanceRetryAttempt, 6),
    );
    this.alarmMaintenanceRetryAttempt += 1;
    this.alarmMaintenanceRetryTimer = setTimeout(() => {
      this.alarmMaintenanceRetryTimer = null;
      readServiceMaintenance(this.env)
        .then((maintenance) => {
          if (maintenance.enabled) return undefined;
          return this.withMutation(async () => {
            if ((await readServiceMaintenance(this.env)).enabled) return;
            if (!this.room || !this.alarmMaintenanceDirty) return;
            await this.maintainAlarm();
          });
        })
        .catch(() => {
          // maintainAlarm absorbs storage scheduling failures. Keep this guard
          // for an unexpected mutation-queue failure so a timer callback never
          // becomes an unhandled rejection and the maintenance work is retried.
          this.alarmMaintenanceDirty = true;
          this.scheduleAlarmMaintenanceRetry();
        });
    }, delay);
  }

  async maintainAlarm(options: AlarmScheduleOptions = {}) {
    try {
      await this.scheduleAlarm(options);
      this.alarmMaintenanceDirty = false;
      this.alarmMaintenanceRetryAttempt = 0;
      this.clearAlarmMaintenanceRetry();
      return true;
    } catch {
      this.alarmMaintenanceDirty = true;
      this.scheduleAlarmMaintenanceRetry();
      return false;
    }
  }

  async scheduleAlarm(options: AlarmScheduleOptions = {}) {
    if (typeof this.storage.setAlarm !== 'function') return;
    const nowMs = Date.now();
    const candidates: Array<number | null | undefined> = [];
    if (this.activeRoom.status === 'decommissioning') {
      candidates.push(
        this.activeRoom.decommission?.retryAtMs,
        this.activeRoom.decommission?.purgeAfterMs,
      );
    } else if (this.activeRoom.status === 'decommissioned') {
      candidates.push(this.activeRoom.decommission?.maintenanceAtMs);
    }
    for (const session of Object.values(this.activeRoom.sessions)) {
      candidates.push(session.expiresAtMs);
      if (session.accountId) candidates.push(session.accountLeaseExpiresAtMs);
    }
    for (const participant of Object.values(this.activeRoom.presence.participants)) {
      candidates.push(participant.lastSeenAtMs + this.presenceTtlMs());
    }
    if (this.activeRoom.systemAudio.status === 'preparing') {
      candidates.push(this.activeRoom.systemAudio.claimExpiresAt);
    } else if (this.activeRoom.systemAudio.status === 'live') {
      candidates.push(this.activeRoom.systemAudio.liveExpiresAt);
    }
    for (const asset of Object.values(this.activeRoom.assets)) {
      if (asset.status === 'reserved') candidates.push(asset.expiresAtMs);
      if (Number.isSafeInteger(asset.stagingCleanupAfterMs)) {
        candidates.push(asset.stagingCleanupAfterMs);
      }
      if (asset.status === 'ready' && Number.isSafeInteger(asset.gcAfterMs)) {
        candidates.push(asset.gcAfterMs);
      }
    }
    for (const expiresAtMs of Object.values(this.activeRoom.consumedRecoveryNonces || {})) {
      candidates.push(expiresAtMs);
    }
    for (const record of Object.values(this.activeRoom.consumedOwnershipTransferClaims || {})) {
      candidates.push(record.expiresAtMs);
    }
    for (const expiresAtMs of Object.values(this.activeRoom.accountDeletionTombstones || {})) {
      candidates.push(expiresAtMs);
    }
    for (const tombstone of Object.values(this.activeRoom.stagingTombstones || {})) {
      candidates.push(tombstone.cleanupAfterMs);
    }
    for (const command of Object.values(this.activeRoom.developerCommands || {})) {
      if (command.status === 'pending' || command.status === 'dispatched') {
        candidates.push(command.expiresAtMs);
        if (
          isSafeInteger(command.attempts) &&
          command.attempts < DEVELOPER_COMMAND_MAX_ATTEMPTS &&
          isSafeInteger(command.nextAttemptAtMs)
        ) {
          candidates.push(command.nextAttemptAtMs);
        }
      } else {
        candidates.push(command.retainUntilMs);
      }
    }
    for (const record of Object.values(this.activeRoom.developerCommandIdempotency || {})) {
      candidates.push(record.expiresAtMs);
    }
    for (const [storageKey, record] of Object.entries(this.activeRoom.idempotency || {})) {
      candidates.push(this.idempotencyExpiresAt(storageKey, record));
    }
    for (const record of Object.values(this.activeRoom.developerMutationIdempotency || {})) {
      candidates.push(record.expiresAtMs);
    }
    for (const record of Object.values(this.activeRoom.rateLimits || {})) {
      candidates.push(record.resetAtMs);
    }
    for (const record of Object.values(this.activeRoom.botRateLimits || {})) {
      candidates.push(record.resetAtMs);
    }
    if (this.activeRoom.pendingPresenceBroadcast) {
      const retryAtMs = this.activeRoom.pendingPresenceBroadcast.retryAtMs;
      candidates.push(retryAtMs <= nowMs ? nowMs + 1 : retryAtMs);
    }
    const playbackBroadcast = this.activeRoom.pendingPlaybackBroadcasts?.[0];
    if (playbackBroadcast) {
      candidates.push(
        playbackBroadcast.retryAtMs <= nowMs ? nowMs + 1 : playbackBroadcast.retryAtMs,
      );
    }
    if (this.activeRoom.pendingPlaybackTransition) {
      const deadlineAtMs = this.activeRoom.pendingPlaybackTransition.deadlineAtMs;
      // Persistence can begin before the rendezvous deadline and finish after
      // it. Cloudflare removes due alarms before invoking them, so dropping an
      // already-due deadline here would strand PREPARE until unrelated traffic
      // wakes the object. Install a next-tick alarm instead.
      candidates.push(deadlineAtMs <= nowMs ? nowMs + 1 : deadlineAtMs);
    }
    const next = candidates
      .filter((value): value is number => isSafeInteger(value) && value > nowMs)
      .sort((a, b) => a - b)[0];
    // An earlier alarm is safe: it will wake, find that a renewed lease has
    // not expired, and schedule the later deadline. Avoid moving the alarm
    // forward on every heartbeat, which otherwise turns presence liveness
    // into an extra Durable Object write every 15 seconds.
    if (next) {
      if (
        options.retainEarlier === true &&
        isSafeInteger(this.scheduledAlarmMs) &&
        this.scheduledAlarmMs > nowMs &&
        this.scheduledAlarmMs <= next
      ) {
        return;
      }
      await this.storage.setAlarm(next);
      this.scheduledAlarmMs = next;
    } else if (typeof this.storage.deleteAlarm === 'function') {
      if (this.scheduledAlarmMs !== null) await this.storage.deleteAlarm();
      this.scheduledAlarmMs = null;
    }
  }

  presenceTtlMs() {
    return configuredNumber(this.env.PRESENCE_TTL_SECONDS, PRESENCE_TTL_SECONDS, 15, 300) * 1000;
  }

  sessionTtlSeconds() {
    return configuredNumber(
      this.env.SESSION_TTL_SECONDS,
      SESSION_TTL_SECONDS,
      300,
      90 * 24 * 60 * 60,
    );
  }

  accountIdentityLeaseExpiresAt(nowMs = Date.now()) {
    return nowMs + ACCOUNT_IDENTITY_LEASE_TTL_MS;
  }

  reservationTtlSeconds() {
    return configuredNumber(this.env.RESERVATION_TTL_SECONDS, RESERVATION_TTL_SECONDS, 60, 3600);
  }

  assetGcGraceMs() {
    return (
      configuredNumber(this.env.ASSET_GC_GRACE_SECONDS, ASSET_GC_GRACE_SECONDS, 60, 24 * 60 * 60) *
      1000
    );
  }

  referencedAssetIds() {
    return new Set(
      this.activeRoom.playlist.flatMap((item) =>
        item.source.kind === 'pro-r2' ? [item.source.assetId] : [],
      ),
    );
  }

  reconcileAssetGarbageCollection(nowMs: number, referenced = this.referencedAssetIds()) {
    let changed = false;
    for (const asset of Object.values(this.activeRoom.assets)) {
      if (asset.status !== 'ready') continue;
      if (referenced.has(asset.assetId)) {
        if (asset.gcAfterMs !== undefined) {
          delete asset.gcAfterMs;
          changed = true;
        }
      } else if (!Number.isSafeInteger(asset.gcAfterMs)) {
        asset.gcAfterMs = nowMs + this.assetGcGraceMs();
        changed = true;
      }
    }
    return changed;
  }

  retainStagingTombstone(asset: RoomAsset, nowMs = Date.now()) {
    if (!asset.stagingObjectKey || !isSafeInteger(asset.uploadExpiresAtMs)) return;
    const uploadExpiresAtMs = asset.uploadExpiresAtMs;
    const cleanupAfterMs = Math.max(
      uploadExpiresAtMs + 5_000,
      isSafeInteger(asset.stagingCleanupAfterMs) ? asset.stagingCleanupAfterMs : nowMs + 5_000,
    );
    this.activeRoom.stagingTombstones[asset.assetId] = {
      objectKey: asset.stagingObjectKey,
      cleanupAfterMs,
    };
  }

  async advanceStagingObjectCleanup(
    record: StagingTombstone | RoomAsset,
    objectKey: string,
    nowMs: number,
    cleanupField: 'cleanupAfterMs' | 'stagingCleanupAfterMs' = 'cleanupAfterMs',
    emptyField: 'emptySinceMs' | 'stagingEmptySinceMs' = 'emptySinceMs',
  ) {
    const bucket = this.env.PRO_MEDIA_BUCKET;
    if (!bucket) throw new Error('PRO_ROOM_MEDIA_BUCKET_NOT_CONFIGURED');
    const object = await bucket.head(objectKey);
    if (object) {
      await bucket.delete(objectKey);
      // A late completion resets the continuous-empty proof even when this
      // cleanup successfully removed it.
      if (emptyField === 'emptySinceMs') record.emptySinceMs = nowMs;
      else record.stagingEmptySinceMs = nowMs;
    } else if (
      !isSafeInteger(
        emptyField === 'emptySinceMs' ? record.emptySinceMs : record.stagingEmptySinceMs,
      )
    ) {
      if (emptyField === 'emptySinceMs') record.emptySinceMs = nowMs;
      else record.stagingEmptySinceMs = nowMs;
    } else {
      const emptySinceMs =
        emptyField === 'emptySinceMs' ? record.emptySinceMs : record.stagingEmptySinceMs;
      if (isSafeInteger(emptySinceMs) && emptySinceMs + STAGING_OBJECT_EMPTY_WINDOW_MS <= nowMs) {
        return true;
      }
    }
    if (cleanupField === 'cleanupAfterMs')
      record.cleanupAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
    else record.stagingCleanupAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
    return false;
  }

  async fetch(request: Request) {
    const maintenanceResponse = await gateServiceMaintenance(request, this.env, { format: 'json' });
    if (maintenanceResponse) return maintenanceResponse;
    if (!(await this.ensureReady(request))) return errorResponse('ROOM_NOT_FOUND', 404);
    const url = new URL(request.url);
    if (url.search || url.hash || request.url.length > 8192) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (url.pathname === '/internal/authority/check') {
      if (request.method !== 'POST') return errorResponse('NOT_FOUND', 404);
      return this.withMutation(async () => {
        const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
        if (accountDeletionResponse) return accountDeletionResponse;
        await this.prune(Date.now());
        return this.handleInternalAuthorityCheck(request);
      });
    }
    if (url.pathname.startsWith('/internal/bot/')) {
      if (request.method !== 'POST') return errorResponse('NOT_FOUND', 404);
      return this.withMutation(async () => {
        const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
        if (accountDeletionResponse) return accountDeletionResponse;
        await this.prune(Date.now());
        return this.withStateCapacityRollback(
          async () => {
            if (url.pathname === '/internal/bot/context') {
              return this.handleInternalBotContext(request);
            }
            if (url.pathname === '/internal/bot/execute') {
              return this.handleInternalBotExecute(request);
            }
            return errorResponse('NOT_FOUND', 404);
          },
          {
            // BOT execution composes several independently durable operations
            // (queue mutation followed by an optional playback command). A late
            // failure must not rewind earlier commits in memory. Context lease
            // creation is a single state-only transaction and is safe to undo.
            rollbackStorageFailure: url.pathname === '/internal/bot/context',
          },
        );
      });
    }
    if (url.pathname.startsWith('/internal/admin/')) {
      if (request.method === 'GET' && url.pathname === '/internal/admin/status') {
        return this.withMutation(async () => {
          const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
          // A terminal deletion may make this very status request perform the
          // durable self-suspension. Return that new state to the control plane;
          // an unverifiable Auth D1 verdict remains fail-closed.
          if (accountDeletionResponse && accountDeletionResponse.status !== 423) {
            return accountDeletionResponse;
          }
          return jsonResponse({
            roomCode: this.activeRoom.roomCode,
            roomGeneration: this.activeRoom.roomGeneration,
            provisioned: this.activeRoom.provisioned,
            status: this.activeRoom.status,
            suspensionReason: this.activeRoom.suspensionReason,
            ownerAccountLinked: typeof this.activeRoom.ownerAccountId === 'string',
            ownerAccountId: ACCOUNT_ID_RE.test(this.activeRoom.ownerAccountId || '')
              ? this.activeRoom.ownerAccountId
              : null,
            ownerAuthorityEpoch: this.activeRoom.ownerAuthorityEpoch,
            developerAuthorityEpoch: this.activeRoom.developerAuthorityEpoch,
            ownerAuthorityRemoval: internalOwnerAuthorityRemoval(this.activeRoom),
            ownerTransferReconciliation: internalOwnerTransferReconciliation(this.activeRoom),
          });
        });
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/provision') {
        return this.withMutation(async () => {
          return this.withStateCapacityRollback(
            async () => {
              if (
                this.activeRoom.status === 'decommissioning' ||
                this.activeRoom.status === 'decommissioned'
              ) {
                return errorResponse('PRO_ROOM_PERMANENTLY_DECOMMISSIONED', 410);
              }
              if (!this.activeRoom.provisioned) {
                this.activeRoom.provisioned = true;
                await this.persist();
              }
              return jsonResponse({
                ok: true,
                roomCode: this.activeRoom.roomCode,
                roomGeneration: this.activeRoom.roomGeneration,
                status: this.activeRoom.status,
              });
            },
            { rollbackStorageFailure: true },
          );
        });
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/activation-claim') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalActivationClaim(request), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/owner-recovery-claim') {
        // Serialize issuance with suspend/decommission and other room
        // mutations. A recovery URL must reflect one stable canonical status,
        // never an in-flight pre-mutation snapshot.
        return this.withMutation(async () => {
          const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
          if (accountDeletionResponse) return accountDeletionResponse;
          return this.handleInternalOwnerRecoveryClaim();
        });
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/owner-transfer-claim') {
        return this.withMutation(async () => {
          const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
          if (accountDeletionResponse) return accountDeletionResponse;
          return this.withStateCapacityRollback(
            () => this.handleInternalOwnerTransferClaim(request),
            {
              rollbackStorageFailure: true,
            },
          );
        });
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/owner-transfer/commit') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalOwnerTransferCommit(request), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/internal/admin/owner-transfer/reconcile'
      ) {
        return this.withMutation(() =>
          this.withStateCapacityRollback(
            () => this.handleInternalOwnerTransferCommit(request, { reconcile: true }),
            {
              rollbackStorageFailure: true,
            },
          ),
        );
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/suspend') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalSuspend(), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/resume') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalResume(), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/decommission') {
        return this.withMutation(() => this.handleInternalDecommission(request));
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/owner-authority/detach') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalOwnerAuthorityDetach(request), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/internal/admin/owner-authority/detach/ack'
      ) {
        return this.withMutation(() =>
          this.withStateCapacityRollback(
            () => this.handleInternalOwnerAuthorityDetachAck(request),
            { rollbackStorageFailure: true },
          ),
        );
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/account-authority/purge') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalAccountAuthorityPurge(request), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/internal/admin/account-authority/classify'
      ) {
        return this.withMutation(() => this.handleInternalAccountAuthorityClassify(request));
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/internal/admin/account-authority/purge/ack'
      ) {
        return this.withMutation(() =>
          this.withStateCapacityRollback(
            () => this.handleInternalAccountAuthorityPurgeAck(request),
            { rollbackStorageFailure: true },
          ),
        );
      }
      return errorResponse('NOT_FOUND', 404);
    }
    if (url.pathname.startsWith('/internal/developer/')) {
      if (request.method !== 'POST') {
        return errorResponse('NOT_FOUND', 404);
      }
      return this.withMutation(async () => {
        const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
        if (accountDeletionResponse) return accountDeletionResponse;
        await this.prune(Date.now());
        // Authenticated projections are read-only. Keep them behind the
        // mutation queue for an atomic view, but do not clone the bounded
        // multi-megabyte room merely to prepare a capacity rollback that can
        // never be used by this route.
        if (url.pathname === '/internal/developer/v1/read') {
          return this.handleInternalDeveloperRead(request);
        }
        return this.withStateCapacityRollback(
          async () => {
            if (url.pathname === '/internal/developer/v1/commands/create') {
              return this.handleInternalDeveloperCommandCreate(request);
            }
            if (url.pathname === '/internal/developer/v1/commands/status') {
              return this.handleInternalDeveloperCommandStatus(request);
            }
            if (url.pathname === '/internal/developer/v1/queue/mutate') {
              return this.handleInternalDeveloperQueueMutation(request);
            }
            if (url.pathname === '/internal/developer/v1/queue-mode/update') {
              return this.handleInternalDeveloperQueueModeUpdate(request);
            }
            if (url.pathname === '/internal/developer/v1/media/uploads/create') {
              return this.handleInternalDeveloperMediaUploadCreate(request);
            }
            if (url.pathname === '/internal/developer/v1/media/uploads/complete') {
              return this.handleInternalDeveloperMediaUploadComplete(request);
            }
            return errorResponse('NOT_FOUND', 404);
          },
          {
            // Completion promotes bytes from staging into the final R2 key
            // before committing metadata. Rewinding only memory after that
            // external side effect would manufacture a second, contradictory
            // view of the upload. Its existing cleanup saga remains responsible
            // for recovery; every other route in this group is state-only.
            rollbackStorageFailure:
              url.pathname !== '/internal/developer/v1/media/uploads/complete',
          },
        );
      });
    }
    const prefix = `/v1/rooms/${this.activeRoom.roomCode}`;
    if (!url.pathname.startsWith(`${prefix}/`)) return errorResponse('ROOM_NOT_FOUND', 404);
    if (!this.activeRoom.provisioned) return errorResponse('ROOM_NOT_FOUND', 404);
    if (request.method === 'GET' && url.pathname === `${prefix}/bootstrap`) {
      return this.withMutation(async () => {
        const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
        // If this read discovered a terminal owner deletion, the room is
        // already durably suspended. Expose that canonical bootstrap state so
        // the browser renders the inactive-room UX instead of a one-off link
        // or transport error. An unverifiable Auth D1 verdict stays closed.
        if (accountDeletionResponse && accountDeletionResponse.status !== 423) {
          return accountDeletionResponse;
        }
        return this.handleBootstrap();
      });
    }
    return this.withMutation(async () => {
      const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
      if (accountDeletionResponse) return accountDeletionResponse;
      await this.prune(Date.now());
      if (request.method === 'GET') {
        if (url.pathname === `${prefix}/snapshot`) return this.handleGetSnapshot(request);
        if (url.pathname === `${prefix}/administrators`)
          return this.handleGetAdministrators(request);
        if (url.pathname === `${prefix}/effects`) return this.handleGetEffects(request);
        if (url.pathname === `${prefix}/settings-sync`) return this.handleGetSettingsSync(request);
        if (url.pathname === `${prefix}/queue-mode`) return this.handleGetQueueMode(request);
        if (url.pathname === `${prefix}/system-audio`) return this.handleGetSystemAudio(request);
        const readDownload = url.pathname.match(
          new RegExp(`^${prefix}/media/([A-Za-z0-9_-]{16,128})/download$`),
        );
        const readDownloadAssetId = readDownload?.[1];
        if (readDownloadAssetId) return this.handleDownloadMedia(request, readDownloadAssetId);
      }
      const completeMediaMatch = url.pathname.match(
        new RegExp(`^${prefix}/media/([A-Za-z0-9_-]{16,128})/complete$`),
      );
      const deleteMediaMatch = url.pathname.match(
        new RegExp(`^${prefix}/media/([A-Za-z0-9_-]{16,128})$`),
      );
      const completedAssetId = completeMediaMatch?.[1];
      const deletedAssetId = deleteMediaMatch?.[1];
      // Completion may leave a verified immutable final object in R2 before
      // the room-state commit. Its retry path now treats that object as the
      // recovery source, so rewinding the in-memory reservation on a storage
      // commit failure is both safe and required. Deletion is different: once
      // an R2 object is removed there is no recovery source, therefore only
      // that route keeps its post-side-effect state on commit failure.
      const hasIrreversibleMediaDelete = request.method === 'DELETE' && deleteMediaMatch !== null;
      return this.withStateCapacityRollback(
        async () => {
          const administratorMatch = url.pathname.match(
            new RegExp(`^${prefix}/administrators/([A-Za-z0-9][A-Za-z0-9_-]{15,127})$`),
          );
          const administratorMemberId = administratorMatch?.[1];
          if (request.method === 'POST' && url.pathname === `${prefix}/activation`)
            return this.handleActivation(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/owner-recovery`)
            return this.handleOwnerRecovery(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/owner-transfer/prepare`)
            return this.handleOwnerTransferPrepare(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/sessions`)
            return this.handleCreateSession(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/sessions/current/account`)
            return this.handleAttachCurrentAccount(request);
          if (
            request.method === 'POST' &&
            url.pathname === `${prefix}/sessions/current/account/lease`
          )
            return this.handleRenewCurrentAccountLease(request);
          if (request.method === 'DELETE' && url.pathname === `${prefix}/sessions/current/account`)
            return this.handleDetachCurrentAccount(request);
          if (request.method === 'DELETE' && url.pathname === `${prefix}/sessions/current`)
            return this.handleCloseSession(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/sessions/current/close`)
            return this.handleCloseSessionFenced(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/pin`)
            return this.handleChangePin(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/presence/heartbeat`)
            return this.handleHeartbeat(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/presence/enter`)
            return this.handleEnterPresence(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/presence/close`)
            return this.handleClosePresence(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/presence/kick-device`)
            return this.handleKickPhysicalPresence(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/presence/kick`)
            return this.handleKickPresence(request);
          if (request.method === 'PUT' && administratorMemberId)
            return this.handlePutAdministrator(request, administratorMemberId);
          if (request.method === 'DELETE' && administratorMemberId)
            return this.handleDeleteAdministrator(request, administratorMemberId);
          if (request.method === 'DELETE' && url.pathname === `${prefix}/presence/current`)
            return this.handleLeavePresence(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/signaling-tickets`)
            return this.handleSignalingTicket(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/playback/commands`)
            return this.handlePlaybackCommand(request);
          const playbackReady = url.pathname.match(
            new RegExp(`^${prefix}/playback/transitions/(transition_[A-Za-z0-9_-]{22})/ready$`),
          );
          const playbackTransitionId = playbackReady?.[1];
          if (request.method === 'POST' && playbackTransitionId) {
            return this.handlePlaybackTransitionReady(request, playbackTransitionId);
          }
          const developerCommandAck = url.pathname.match(
            new RegExp(`^${prefix}/developer-commands/(cmd_[A-Za-z0-9_-]{22})/ack$`),
          );
          const developerCommandId = developerCommandAck?.[1];
          if (request.method === 'POST' && developerCommandId) {
            return this.handleDeveloperCommandAck(request, developerCommandId);
          }
          if (request.method === 'PUT' && url.pathname === `${prefix}/effects`)
            return this.handleUpdateEffects(request);
          if (request.method === 'PUT' && url.pathname === `${prefix}/settings-sync`)
            return this.handleUpdateSettingsSync(request);
          if (request.method === 'PUT' && url.pathname === `${prefix}/queue-mode`)
            return this.handleUpdateQueueMode(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/acquire`)
            return this.handleAcquireSystemAudio(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/commit`)
            return this.handleCommitSystemAudio(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/heartbeat`)
            return this.handleHeartbeatSystemAudio(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/release`)
            return this.handleReleaseSystemAudio(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/snapshot/compact`)
            return this.handleCompactSnapshotMutation(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/media/reservations`)
            return this.handleCreateReservation(request);
          if (request.method === 'POST' && completedAssetId)
            return this.handleCompleteMedia(request, completedAssetId);
          if (request.method === 'DELETE' && deletedAssetId)
            return this.handleDeleteMedia(request, deletedAssetId);
          return errorResponse('NOT_FOUND', 404);
        },
        { rollbackStorageFailure: !hasIrreversibleMediaDelete },
      );
    });
  }

  handleBootstrap() {
    const status =
      this.activeRoom.status === 'unactivated'
        ? 'activation_required'
        : this.activeRoom.status === 'suspended'
          ? 'suspended'
          : 'pin_required';
    return jsonResponse({ roomCode: this.activeRoom.roomCode, status });
  }

  botRateLimitResponse(key: string, limit: number, nowMs: number) {
    const current = this.activeRoom.botRateLimits[key];
    if (!current || current.resetAtMs <= nowMs || current.count < limit) return null;
    return errorResponse('RATE_LIMITED', 429, {
      'retry-after': String(Math.max(1, Math.ceil((current.resetAtMs - nowMs) / 1000))),
    });
  }

  pruneRateLimitLedger(records: Record<string, RateLimitRecord>, nowMs: number) {
    let changed = false;
    for (const [key, record] of Object.entries(records)) {
      if (record.resetAtMs > nowMs) continue;
      delete records[key];
      changed = true;
    }
    return changed;
  }

  rateLimitCapacityResponse(
    records: Record<string, RateLimitRecord>,
    keys: string[],
    maxItems: number,
    nowMs: number,
  ) {
    this.pruneRateLimitLedger(records, nowMs);
    const missing = new Set(keys.filter((key: string) => records[key] === undefined));
    if (Object.keys(records).length + missing.size <= maxItems) return null;
    const retryAtMs = Math.min(
      ...Object.values(records)
        .map((record) => record.resetAtMs)
        .filter((value) => Number.isSafeInteger(value) && value > nowMs),
    );
    return errorResponse('RATE_LIMITED', 429, {
      'retry-after': String(
        Number.isFinite(retryAtMs) ? Math.max(1, Math.ceil((retryAtMs - nowMs) / 1000)) : 60,
      ),
    });
  }

  recordBotRateLimit(key: string, windowMs: number, nowMs: number) {
    const current = this.activeRoom.botRateLimits[key];
    if (!current || current.resetAtMs <= nowMs) {
      this.activeRoom.botRateLimits[key] = { count: 1, resetAtMs: nowMs + windowMs };
      return;
    }
    current.count += 1;
  }

  publicBotContext(auth: AuthenticatedSession) {
    const playlist = this.activeRoom.playlist.slice(0, 100).map((item) => ({
      queueItemId: item.queueItemId,
      kind: item.source.kind === 'youtube' ? 'youtube' : 'audio',
      name: item.name.slice(0, 160),
      ...(typeof item.title === 'string' ? { title: item.title.slice(0, 160) } : {}),
      ...(typeof item.artist === 'string' ? { artist: item.artist.slice(0, 160) } : {}),
    }));
    return {
      actorName: queueAdditionActorName(auth.session.displayName, 'Peer'),
      room: {
        playlistRevision: this.activeRoom.playlistRevision,
        currentQueueItemId: this.activeRoom.currentQueueItemId,
        playbackState: this.activeRoom.playback.state,
        repeatMode:
          this.activeRoom.queueMode.repeatMode === 2
            ? 'one'
            : this.activeRoom.queueMode.repeatMode === 1
              ? 'all'
              : 'off',
        shuffleEnabled: this.activeRoom.queueMode.shuffleEnabled,
        effects: structuredClone(this.activeRoom.effects.effects),
        playlist,
      },
    };
  }

  async handleInternalBotContext(request: Request) {
    if (!this.activeRoom.provisioned || this.activeRoom.status !== 'active') {
      return errorResponse('BOT_ROOM_ONLY', 400);
    }
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (auth.session.role === 'member') {
      return errorResponse('ADMINISTRATOR_REQUIRED', 403);
    }
    const parsed = await this.parseBody(request, 2 * 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['roomCode', 'roomGeneration', 'requestId', 'prompt']) ||
      parsed.value.roomCode !== this.activeRoom.roomCode ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      !matchesPattern(parsed.value.requestId, BOT_REQUEST_ID_RE) ||
      boundedString(parsed.value.prompt, 500) === null
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }

    const prompt = boundedString(parsed.value.prompt, 500);
    if (prompt === null) return errorResponse('INVALID_REQUEST', 400);
    const scope = `bot-context:${auth.tokenHash}`;
    const fingerprint = await this.idempotencyFingerprint(scope, {
      roomCode: this.activeRoom.roomCode,
      prompt,
    });
    const storageKey = `${scope}:${parsed.value.requestId}`;
    const receipt = this.activeRoom.idempotency[storageKey];
    if (receipt && !constantTimeEqual(receipt.fingerprint, fingerprint)) {
      return errorResponse('IDEMPOTENCY_CONFLICT', 409);
    }
    const nowMs = Date.now();
    if (receipt) {
      const executeReceipt =
        this.activeRoom.idempotency[`bot-execute:${auth.tokenHash}:${parsed.value.requestId}`];
      if (executeReceipt?.body) return jsonResponse({ replay: executeReceipt.body });
      const leaseExpiresAtMs = receipt.body?.leaseExpiresAtMs;
      return errorResponse(
        isSafeInteger(leaseExpiresAtMs) && leaseExpiresAtMs > nowMs
          ? 'BOT_REQUEST_IN_PROGRESS'
          : 'BOT_REQUEST_EXPIRED',
        409,
        isSafeInteger(leaseExpiresAtMs) && leaseExpiresAtMs > nowMs
          ? { 'retry-after': String(Math.max(1, Math.ceil((leaseExpiresAtMs - nowMs) / 1000))) }
          : {},
      );
    }

    const leaseToken = randomToken(24);
    {
      const minuteKey = `bot-minute:${auth.tokenHash}`;
      const hourKey = `bot-room-hour-v1:${this.activeRoom.roomCode}`;
      const minuteLimit = this.botRateLimitResponse(minuteKey, BOT_MEMBER_MINUTE_LIMIT, nowMs);
      if (minuteLimit) return minuteLimit;
      const hourLimit = this.botRateLimitResponse(hourKey, BOT_ROOM_HOUR_LIMIT, nowMs);
      if (hourLimit) return hourLimit;
      const capacityError = this.rateLimitCapacityResponse(
        this.activeRoom.botRateLimits,
        [minuteKey, hourKey],
        BOT_RATE_LIMIT_MAX_ITEMS,
        nowMs,
      );
      if (capacityError) return capacityError;
      this.recordBotRateLimit(minuteKey, BOT_MEMBER_MINUTE_MS, nowMs);
      this.recordBotRateLimit(hourKey, BOT_ROOM_HOUR_MS, nowMs);
      // The former daily policy used a different key. Remove its inert room
      // state as soon as the new policy records a request.
      delete this.activeRoom.botRateLimits[`bot-day:${this.activeRoom.roomCode}`];
      this.storeIdempotency(
        scope,
        parsed.value.requestId,
        fingerprint,
        {
          leaseToken,
          leaseExpiresAtMs: nowMs + BOT_REQUEST_LEASE_MS,
          playlistRevision: this.activeRoom.playlistRevision,
        },
        200,
        nowMs + IDEMPOTENCY_TTL_MS,
      );
      await this.persist();
    }
    return jsonResponse({ leaseToken, ...this.publicBotContext(auth) });
  }

  async runBotDeveloperCommand(requestId: string, command: DeveloperControlCommand) {
    const idempotencyKey = await botDerivedIdempotencyKey(requestId, 'command');
    const response = await this.handleInternalDeveloperCommandCreate(
      new Request('https://pro-room.internal/internal/developer/v1/commands/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...proRoomGenerationWireHeaders(this.activeRoom.roomGeneration),
        },
        body: JSON.stringify({
          roomCode: this.activeRoom.roomCode,
          ...proRoomGenerationWireFields(this.activeRoom.roomGeneration),
          keyId: BOT_DEVELOPER_KEY_ID,
          developerAuthorityEpoch: this.activeRoom.developerAuthorityEpoch,
          idempotencyKey,
          command,
        }),
      }),
    );
    if (!response.ok) return false;
    const result = await response
      .clone()
      .json()
      .catch(() => null);
    // Command creation intentionally stays HTTP 202 for the public async API,
    // even when the Durable Object can already determine a terminal result.
    // BOT is an in-process caller, so it must inspect that terminal body rather
    // than treating every 202 as a successful action. The same check applies to
    // idempotent replays of a previously rejected command.
    return (
      isRecord(result) &&
      (result.status === 'pending' || result.status === 'dispatched' || result.status === 'applied')
    );
  }

  async handleInternalBotExecute(request: Request) {
    if (!this.activeRoom.provisioned || this.activeRoom.status !== 'active') {
      return errorResponse('BOT_ROOM_ONLY', 400);
    }
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (auth.session.role === 'member') {
      return errorResponse('ADMINISTRATOR_REQUIRED', 403);
    }
    const parsed = await this.parseBody(request, 64 * 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, [
        'roomCode',
        'roomGeneration',
        'requestId',
        'leaseToken',
        'plan',
        'tracks',
      ]) ||
      parsed.value.roomCode !== this.activeRoom.roomCode ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      !matchesPattern(parsed.value.requestId, BOT_REQUEST_ID_RE) ||
      !matchesPattern(parsed.value.leaseToken, BOT_LEASE_TOKEN_RE) ||
      !Array.isArray(parsed.value.tracks)
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    const plan = parseBotPlan(parsed.value.plan);
    if (!plan) return errorResponse('INVALID_REQUEST', 400);
    if (plan.intent === 'add_youtube' && !this.sessionHasPermission(auth.session, 'media.add')) {
      return errorResponse('PERMISSION_REQUIRED', 403);
    }
    // BOT is only an alternate command surface; it never widens the calling
    // room member's authority. In particular, a delegated administrator whose
    // playback toggle was revoked may still converse with BOT or add media,
    // but cannot smuggle a play/pause/next/item-selection action through the
    // internal Developer-command executor.
    if (
      (plan.intent === 'playback' ||
        plan.intent === 'play_existing' ||
        (plan.intent === 'add_youtube' && plan.playAddedIndex >= 0)) &&
      !this.sessionHasPermission(auth.session, 'playback.control')
    ) {
      return errorResponse('PERMISSION_REQUIRED', 403);
    }
    if (
      (plan.intent === 'remove_items' ||
        plan.intent === 'clear_queue' ||
        plan.intent === 'queue_mode') &&
      !this.sessionHasPermission(auth.session, 'media.add')
    ) {
      return errorResponse('PERMISSION_REQUIRED', 403);
    }
    if (plan.intent === 'virtual_treble' && auth.session.role !== 'owner') {
      return errorResponse('OWNER_REQUIRED', 403);
    }
    const tracks =
      plan.intent === 'add_youtube'
        ? parseBotTracks(parsed.value.tracks)
        : parsed.value.tracks.length === 0
          ? []
          : null;
    if (!tracks) return errorResponse('INVALID_REQUEST', 400);

    const contextScope = `bot-context:${auth.tokenHash}`;
    const contextReceipt = this.activeRoom.idempotency[`${contextScope}:${parsed.value.requestId}`];
    if (
      !contextReceipt ||
      !constantTimeEqual(contextReceipt.body?.leaseToken, parsed.value.leaseToken)
    ) {
      return errorResponse('BOT_CONTEXT_REQUIRED', 409);
    }

    const scope = `bot-execute:${auth.tokenHash}`;
    const fingerprint = await this.idempotencyFingerprint(scope, { plan, tracks });
    const replay = this.replayIdempotency(scope, parsed.value.requestId, fingerprint);
    if (replay) return replay;
    if (
      plan.intent === 'clear_queue' &&
      (contextReceipt.body?.playlistRevision !== plan.basePlaylistRevision ||
        this.activeRoom.playlistRevision !== plan.basePlaylistRevision)
    ) {
      return errorResponse('BOT_CONTEXT_STALE', 409);
    }
    const contextLeaseExpiresAtMs = contextReceipt.body?.leaseExpiresAtMs;
    if (!isSafeInteger(contextLeaseExpiresAtMs) || contextLeaseExpiresAtMs <= Date.now()) {
      return errorResponse('BOT_CONTEXT_REQUIRED', 409);
    }

    let addedCount = 0;
    let playbackChanged = false;
    let destructiveResponseBody: JsonRecord | null = null;
    if (plan.intent === 'add_youtube') {
      const queueIdempotencyKey = await botDerivedIdempotencyKey(parsed.value.requestId, 'queue');
      const queueResponse = await this.handleInternalDeveloperQueueMutation(
        new Request('https://pro-room.internal/internal/developer/v1/queue/mutate', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...proRoomGenerationWireHeaders(this.activeRoom.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.activeRoom.roomCode,
            ...proRoomGenerationWireFields(this.activeRoom.roomGeneration),
            keyId: BOT_DEVELOPER_KEY_ID,
            developerAuthorityEpoch: this.activeRoom.developerAuthorityEpoch,
            idempotencyKey: queueIdempotencyKey,
            actorName: queueAdditionActorName(`${auth.session.displayName} · BOT`, 'BOT'),
            mutation: { type: 'add_youtube_batch', items: tracks },
          }),
        }),
      );
      if (!queueResponse.ok) return errorResponse('BOT_ACTION_FAILED', 409);
      addedCount = tracks.length;
      if (plan.playAddedIndex >= 0) {
        const targetVideoId = tracks[plan.playAddedIndex]?.videoId;
        const target = [...this.activeRoom.playlist]
          .reverse()
          .find(
            (item) =>
              item.source.kind === 'youtube' &&
              item.source.videoId === targetVideoId &&
              item.developerOwnerKeyId === BOT_DEVELOPER_KEY_ID,
          );
        if (target) {
          playbackChanged = await this.runBotDeveloperCommand(parsed.value.requestId, {
            type: 'play_item',
            queueItemId: target.queueItemId,
          });
        }
      }
    } else if (plan.intent === 'play_existing') {
      if (!this.activeRoom.playlist.some((item) => item.queueItemId === plan.queueItemId)) {
        return errorResponse('QUEUE_ITEM_NOT_FOUND', 404);
      }
      playbackChanged = await this.runBotDeveloperCommand(parsed.value.requestId, {
        type: 'play_item',
        queueItemId: plan.queueItemId,
      });
      if (!playbackChanged) return errorResponse('BOT_ACTION_FAILED', 409);
    } else if (plan.intent === 'remove_items' || plan.intent === 'clear_queue') {
      const queueIdempotencyKey = await botDerivedIdempotencyKey(parsed.value.requestId, 'queue');
      const queueResponse = await this.handleInternalDeveloperQueueMutation(
        new Request('https://pro-room.internal/internal/developer/v1/queue/mutate', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...proRoomGenerationWireHeaders(this.activeRoom.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.activeRoom.roomCode,
            ...proRoomGenerationWireFields(this.activeRoom.roomGeneration),
            keyId: BOT_DEVELOPER_KEY_ID,
            developerAuthorityEpoch: this.activeRoom.developerAuthorityEpoch,
            idempotencyKey: queueIdempotencyKey,
            mutation:
              plan.intent === 'remove_items'
                ? { type: 'remove_many', queueItemIds: plan.queueItemIds }
                : { type: 'clear' },
          }),
        }),
        {
          action: plan.intent,
          languageHint: plan.answer || '',
          ...(plan.intent === 'clear_queue'
            ? { expectedPlaylistRevision: plan.basePlaylistRevision }
            : {}),
          terminalScope: scope,
          terminalKey: parsed.value.requestId,
          terminalFingerprint: fingerprint,
        },
      );
      if (!queueResponse.ok) {
        const queueError = await queueResponse
          .clone()
          .json()
          .catch(() => null);
        if (isRecord(queueError) && queueError.error === 'BOT_CONTEXT_STALE') return queueResponse;
        return errorResponse('BOT_ACTION_FAILED', 409);
      }
      destructiveResponseBody =
        this.activeRoom.idempotency[`${scope}:${parsed.value.requestId}`]?.body || null;
      if (!destructiveResponseBody) return errorResponse('BOT_ACTION_FAILED', 409);
    } else if (plan.intent === 'playback') {
      playbackChanged = await this.runBotDeveloperCommand(parsed.value.requestId, {
        type: plan.playbackCommand,
      });
      if (!playbackChanged) return errorResponse('BOT_ACTION_FAILED', 409);
    } else if (plan.intent === 'queue_mode') {
      const modeIdempotencyKey = await botDerivedIdempotencyKey(parsed.value.requestId, 'mode');
      const queueModeResponse = await this.handleInternalDeveloperQueueModeUpdate(
        new Request('https://pro-room.internal/internal/developer/v1/queue-mode/update', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...proRoomGenerationWireHeaders(this.activeRoom.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.activeRoom.roomCode,
            ...proRoomGenerationWireFields(this.activeRoom.roomGeneration),
            keyId: BOT_DEVELOPER_KEY_ID,
            developerAuthorityEpoch: this.activeRoom.developerAuthorityEpoch,
            idempotencyKey: modeIdempotencyKey,
            queueMode: {
              baseRevision: this.activeRoom.queueMode.revision,
              repeatMode:
                plan.repeatMode ||
                (this.activeRoom.queueMode.repeatMode === 2
                  ? 'one'
                  : this.activeRoom.queueMode.repeatMode === 1
                    ? 'all'
                    : 'off'),
              shuffleEnabled:
                plan.shuffleEnabled === undefined
                  ? this.activeRoom.queueMode.shuffleEnabled
                  : plan.shuffleEnabled,
            },
          }),
        }),
      );
      if (!queueModeResponse.ok) return errorResponse('BOT_ACTION_FAILED', 409);
    } else if (plan.intent === 'virtual_treble') {
      const effectsChanged = await this.runBotDeveloperCommand(parsed.value.requestId, {
        type: 'set_effects',
        effects: { virtualTreble: { enabled: plan.virtualTrebleEnabled } },
      });
      if (!effectsChanged) return errorResponse('BOT_ACTION_FAILED', 409);
    }

    if (destructiveResponseBody) return jsonResponse(destructiveResponseBody);

    const fallbackSummary =
      addedCount > 0
        ? `Added ${addedCount} track${addedCount === 1 ? '' : 's'}${playbackChanged ? ' and started playback' : ''}.`
        : playbackChanged
          ? 'Playback updated.'
          : 'Done.';
    const responseBody = {
      ok: true,
      summary: addedCount > 0 ? fallbackSummary : plan.answer || fallbackSummary,
      addedCount,
      playbackChanged,
    };
    this.storeIdempotency(scope, parsed.value.requestId, fingerprint, responseBody);
    await this.persist();
    return jsonResponse(responseBody);
  }

  developerAuthorityEpochError(value: unknown) {
    if (value === undefined) {
      return this.activeRoom.developerAuthorityEpoch === 0
        ? null
        : errorResponse('DEVELOPER_API_AUTHORITY_STALE', 409);
    }
    if (!isSafeNonNegativeInteger(value)) return errorResponse('INVALID_REQUEST', 400);
    return value === this.activeRoom.developerAuthorityEpoch
      ? null
      : errorResponse('DEVELOPER_API_AUTHORITY_STALE', 409);
  }

  async handleInternalDeveloperRead(request: Request) {
    if (!this.activeRoom.provisioned || this.activeRoom.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['projection'],
        ['keyId', 'effectsVersion', 'roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      (parsed.value.keyId !== undefined &&
        !matchesPattern(parsed.value.keyId, DEVELOPER_API_KEY_ID_RE)) ||
      (parsed.value.projection === 'effects'
        ? parsed.value.effectsVersion !== 2
        : parsed.value.effectsVersion !== undefined) ||
      typeof parsed.value.projection !== 'string' ||
      !['room', 'playback', 'queue', 'effects', 'queue-mode'].includes(parsed.value.projection)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
    const projection = developerProjection(
      this.activeRoom,
      parsed.value.projection,
      Date.now(),
      parsed.value.keyId,
      parsed.value.projection === 'effects' ? 2 : 1,
    );
    return projection ? jsonResponse(projection) : errorResponse('ROOM_STATE_INVALID', 503);
  }

  async handleInternalDeveloperCommandCreate(request: Request) {
    if (!this.activeRoom.provisioned || this.activeRoom.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'idempotencyKey', 'command'],
        ['roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      parsed.value.roomCode !== this.activeRoom.roomCode ||
      !matchesPattern(parsed.value.keyId, DEVELOPER_API_KEY_ID_RE) ||
      !matchesPattern(parsed.value.idempotencyKey, IDEMPOTENCY_KEY_RE)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
    const command = parseDeveloperCommand(parsed.value.command);
    if (!command) return errorResponse('INVALID_REQUEST', 400);

    const scope = `developer:${parsed.value.keyId}:playback`;
    const fingerprint = await this.idempotencyFingerprint(scope, command);
    const replay = this.replayDeveloperCommandIdempotency(
      scope,
      parsed.value.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;

    const requiredControlVersion = requiredDeveloperControlVersion(command);
    if (command.type === 'play_item') {
      if (!this.activeRoom.playlist.some((item) => item.queueItemId === command.queueItemId)) {
        return errorResponse('QUEUE_ITEM_NOT_FOUND', 404);
      }
    }

    const activeCount = Object.values(this.activeRoom.developerCommands).filter(
      (record) => record.status === 'pending' || record.status === 'dispatched',
    ).length;
    if (activeCount >= DEVELOPER_COMMAND_MAX_ACTIVE_ITEMS) {
      return errorResponse('COMMAND_CAPACITY_EXCEEDED', 409);
    }
    const idempotencyStorageKey = this.developerCommandIdempotencyStorageKey(
      scope,
      parsed.value.idempotencyKey,
    );
    if (!this.reserveDeveloperCommandIdempotencySlot(idempotencyStorageKey)) {
      return errorResponse('COMMAND_CAPACITY_EXCEEDED', 409);
    }
    if (!this.reserveDeveloperCommandSlot()) {
      return errorResponse('COMMAND_CAPACITY_EXCEEDED', 409);
    }

    const nowMs = Date.now();
    const commandId = `cmd_${randomToken(16)}`;
    const record: DeveloperCommandRecord = {
      roomCode: this.activeRoom.roomCode,
      commandId,
      keyId: parsed.value.keyId,
      idempotencyKey: parsed.value.idempotencyKey,
      command,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + DEVELOPER_COMMAND_TTL_MS,
      retainUntilMs: nowMs + DEVELOPER_COMMAND_RETENTION_MS,
      coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
      developerControlVersion: requiredControlVersion,
      expected: {
        queueItemId: this.activeRoom.currentQueueItemId,
        playlistRevision: this.activeRoom.playlistRevision,
        playbackRevision: this.activeRoom.playback.revision,
      },
      status: 'pending',
    };
    this.activeRoom.developerCommands[commandId] = record;
    const responseBody = publicDeveloperCommand(record);
    this.activeRoom.developerCommandIdempotency[idempotencyStorageKey] = {
      idempotencyKey: parsed.value.idempotencyKey,
      fingerprint,
      commandId,
      body: responseBody,
      status: 202,
      expiresAtMs: nowMs + DEVELOPER_COMMAND_RETENTION_MS,
    };

    let authorityResult: PlaybackAuthorityResult | null = null;
    if (command.type === 'set_effects') {
      if (this.activeRoom.effects.revision >= Number.MAX_SAFE_INTEGER) {
        this.completeDeveloperCommand(record, 'rejected', 'execution_failed', nowMs);
      } else {
        const effects = mergeRoomEffectsPatch(this.activeRoom.effects.effects, command.effects);
        if (JSON.stringify(effects) !== JSON.stringify(this.activeRoom.effects.effects)) {
          this.activeRoom.effects = {
            revision: this.activeRoom.effects.revision + 1,
            updatedAtMs: nowMs,
            masterVolume: this.activeRoom.effects.masterVolume ?? 1,
            effects,
          };
          this.activeRoom.revision += 1;
        }
        this.completeDeveloperCommand(record, 'applied', 'applied', nowMs);
      }
    } else {
      const baseRevision = this.activeRoom.playback.revision;
      const authorityCommand: PlaybackAuthorityCommand =
        command.type === 'play_item'
          ? {
              type: 'select',
              baseRevision,
              queueItemId: command.queueItemId,
              state: 'playing',
              positionSeconds: 0,
            }
          : command.type === 'seek'
            ? { type: 'seek', baseRevision, positionSeconds: command.positionSeconds }
            : { type: command.type, baseRevision };
      authorityResult = this.applyPlaybackAuthorityCommand(authorityCommand, nowMs, commandId);
      if (authorityResult.error) {
        this.completeDeveloperCommand(
          record,
          'rejected',
          authorityResult.error === 'NO_MEDIA'
            ? 'no_media'
            : authorityResult.error === 'PLAYBACK_REVISION_CONFLICT'
              ? 'stale_queue'
              : 'execution_failed',
          nowMs,
        );
      } else if (authorityResult.status === 'unchanged') {
        this.completeDeveloperCommand(record, 'applied', 'already_applied', nowMs);
      }
    }
    this.syncDeveloperCommandIdempotency(record);
    this.enqueuePlaybackOutcome(authorityResult, nowMs);
    await this.persist();
    if (command.type === 'set_effects' && record.status === 'applied') {
      await this.broadcastServerEvent(
        this.invalidationEvent({ effectsRevision: this.activeRoom.effects.revision }),
      );
    }
    return jsonResponse(publicDeveloperCommand(record), 202);
  }

  async handleInternalDeveloperCommandStatus(request: Request) {
    if (!this.activeRoom.provisioned || this.activeRoom.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'commandId'],
        ['roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      parsed.value.roomCode !== this.activeRoom.roomCode ||
      !matchesPattern(parsed.value.keyId, DEVELOPER_API_KEY_ID_RE) ||
      !matchesPattern(parsed.value.commandId, DEVELOPER_COMMAND_ID_RE)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
    const commandId = parsed.value.commandId;
    const developerKeyId = parsed.value.keyId;
    const record = this.activeRoom.developerCommands[commandId];
    // A command created by another API key is deliberately indistinguishable
    // from an unknown ID.
    if (record && !constantTimeEqual(record.keyId, developerKeyId)) {
      return errorResponse('COMMAND_NOT_FOUND', 404);
    }
    if (record) return jsonResponse(publicDeveloperCommand(record));

    // Terminal command records may leave the 64-slot polling ledger before
    // their ten-minute contract window under sustained use. The separate,
    // larger idempotency ledger retains the sanitized terminal body and is
    // still strictly key-bound.
    const prefix = `developer:${developerKeyId}:playback:`;
    const retained = Object.entries(this.activeRoom.developerCommandIdempotency).find(
      ([storageKey, candidate]) =>
        storageKey.startsWith(prefix) &&
        candidate.commandId === commandId &&
        candidate.body?.commandId === commandId &&
        (candidate.body.status === 'applied' ||
          candidate.body.status === 'rejected' ||
          candidate.body.status === 'expired'),
    )?.[1];
    return retained ? jsonResponse(retained.body) : errorResponse('COMMAND_NOT_FOUND', 404);
  }

  async handleInternalDeveloperQueueMutation(
    request: Request,
    botTerminal: BotTerminalOptions | null = null,
  ) {
    if (!this.activeRoom.provisioned || this.activeRoom.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    // The public 64 KiB batch body is wrapped in an authenticated envelope.
    const parsed = await this.parseBody(request, 128 * 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'idempotencyKey', 'mutation'],
        ['actorName', 'roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      parsed.value.roomCode !== this.activeRoom.roomCode ||
      !matchesPattern(parsed.value.keyId, DEVELOPER_API_KEY_ID_RE) ||
      !matchesPattern(parsed.value.idempotencyKey, IDEMPOTENCY_KEY_RE) ||
      (parsed.value.actorName !== undefined && !validDeveloperActorName(parsed.value.actorName))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
    const developerKeyId = parsed.value.keyId;
    const idempotencyKey = parsed.value.idempotencyKey;
    const actorName = parsed.value.actorName;
    const mutation = parseDeveloperQueueMutation(parsed.value.mutation);
    if (!mutation) return errorResponse('INVALID_REQUEST', 400);
    const botTerminalAction =
      mutation.type === 'remove_many'
        ? 'remove_items'
        : mutation.type === 'clear'
          ? 'clear_queue'
          : null;
    if (
      botTerminal !== null &&
      (botTerminalAction === null ||
        botTerminal.action !== botTerminalAction ||
        !/^bot-execute:[A-Za-z0-9_-]{43}$/u.test(botTerminal.terminalScope || '') ||
        !BOT_REQUEST_ID_RE.test(botTerminal.terminalKey || '') ||
        !SHA256_RE.test(botTerminal.terminalFingerprint || '') ||
        (botTerminalAction === 'clear_queue' &&
          !isSafeNonNegativeInteger(botTerminal.expectedPlaylistRevision)) ||
        (botTerminalAction === 'remove_items' &&
          botTerminal.expectedPlaylistRevision !== undefined) ||
        (botTerminal.languageHint !== undefined &&
          boundedString(botTerminal.languageHint, 240, true) === null))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const scope = `developer:${developerKeyId}:queue:${mutation.type}`;
    const fingerprint = await this.idempotencyFingerprint(scope, mutation);
    const replay = this.replayIdempotency(scope, idempotencyKey, fingerprint, null, developerKeyId);
    if (replay) return replay;

    const nowMs = Date.now();
    let playlistChanged = false;
    let removedCount = null;
    let destructivePlaybackChanged = false;
    // The public developer clear remains intentionally unfenced. BOT clear is
    // destructive and is therefore bound to the exact queue revision shown to
    // the model. Recheck here, after every parser/fingerprint await and directly
    // before mutation, so a stale plan cannot clear newly-added tracks.
    if (
      botTerminal !== null &&
      botTerminalAction === 'clear_queue' &&
      this.activeRoom.playlistRevision !== botTerminal.expectedPlaylistRevision
    ) {
      return errorResponse('BOT_CONTEXT_STALE', 409);
    }
    if (mutation.type === 'add_youtube') {
      if (this.activeRoom.playlist.length >= PLAYLIST_MAX_ITEMS) {
        return errorResponse('PLAYLIST_CAPACITY_EXCEEDED', 409);
      }
      const queueItemId = randomQueueItemId();
      const item: PlaylistItem = {
        queueItemId,
        name: mutation.name,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.artist === undefined ? {} : { artist: mutation.artist }),
        ...(mutation.thumbnail === undefined ? {} : { thumbnail: mutation.thumbnail }),
        source: {
          kind: 'youtube',
          videoId: mutation.videoId,
          ...(mutation.playlistId === undefined ? {} : { playlistId: mutation.playlistId }),
          ...(mutation.videoIds === undefined ? {} : { videoIds: [...mutation.videoIds] }),
        },
        developerOwnerKeyId: developerKeyId,
      };
      this.activeRoom.playlist.push(item);
      playlistChanged = true;
    } else if (mutation.type === 'add_youtube_batch') {
      if (this.activeRoom.playlist.length + mutation.items.length > PLAYLIST_MAX_ITEMS) {
        return errorResponse('PLAYLIST_CAPACITY_EXCEEDED', 409);
      }
      if (
        this.activeRoom.playlistRevision >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.revision >= Number.MAX_SAFE_INTEGER
      ) {
        return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
      }
      const items = mutation.items.map(
        (candidate): PlaylistItem => ({
          queueItemId: randomQueueItemId(),
          name: candidate.name,
          ...(candidate.title === undefined ? {} : { title: candidate.title }),
          ...(candidate.artist === undefined ? {} : { artist: candidate.artist }),
          ...(candidate.thumbnail === undefined ? {} : { thumbnail: candidate.thumbnail }),
          source: {
            kind: 'youtube',
            videoId: candidate.videoId,
            ...(candidate.playlistId === undefined ? {} : { playlistId: candidate.playlistId }),
            ...(candidate.videoIds === undefined ? {} : { videoIds: [...candidate.videoIds] }),
          },
          developerOwnerKeyId: developerKeyId,
        }),
      );
      this.activeRoom.playlist.push(...items);
      playlistChanged = true;
    } else if (mutation.type === 'remove') {
      const index = this.activeRoom.playlist.findIndex(
        (item) => item.queueItemId === mutation.queueItemId,
      );
      if (index === -1) return errorResponse('QUEUE_ITEM_NOT_FOUND', 404);
      const removedCurrent = this.activeRoom.currentQueueItemId === mutation.queueItemId;
      if (removedCurrent && this.activeRoom.playback.revision >= Number.MAX_SAFE_INTEGER) {
        return errorResponse('PLAYBACK_REVISION_EXHAUSTED', 409);
      }
      this.activeRoom.playlist.splice(index, 1);
      playlistChanged = true;
      if (removedCurrent) {
        destructivePlaybackChanged = true;
        this.activeRoom.currentQueueItemId = null;
        this.activeRoom.playback = {
          coordinatorEpoch: this.activeRoom.playback.coordinatorEpoch,
          revision: this.activeRoom.playback.revision + 1,
          state: 'idle',
          queueItemId: null,
          positionSeconds: 0,
          updatedAtMs: Math.max(this.activeRoom.playback.updatedAtMs, nowMs),
          youtubeVideoId: null,
          youtubeSubIndex: null,
        };
      }
    } else if (mutation.type === 'remove_many') {
      const queueItemIds = new Set(mutation.queueItemIds);
      if (
        mutation.queueItemIds.some(
          (queueItemId) =>
            !this.activeRoom.playlist.some((item) => item.queueItemId === queueItemId),
        )
      ) {
        return errorResponse('QUEUE_ITEM_NOT_FOUND', 404);
      }
      if (
        this.activeRoom.playlistRevision >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.revision >= Number.MAX_SAFE_INTEGER
      ) {
        return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
      }
      const clearCurrentPlayback =
        (this.activeRoom.currentQueueItemId !== null &&
          queueItemIds.has(this.activeRoom.currentQueueItemId)) ||
        (this.activeRoom.playback.queueItemId !== null &&
          queueItemIds.has(this.activeRoom.playback.queueItemId));
      if (clearCurrentPlayback && this.activeRoom.playback.revision >= Number.MAX_SAFE_INTEGER) {
        return errorResponse('PLAYBACK_REVISION_EXHAUSTED', 409);
      }
      removedCount = queueItemIds.size;
      this.activeRoom.playlist = this.activeRoom.playlist.filter(
        (item) => !queueItemIds.has(item.queueItemId),
      );
      playlistChanged = true;
      if (clearCurrentPlayback) {
        destructivePlaybackChanged = true;
        this.activeRoom.currentQueueItemId = null;
        this.activeRoom.playback = {
          coordinatorEpoch: this.activeRoom.playback.coordinatorEpoch,
          revision: this.activeRoom.playback.revision + 1,
          state: 'idle',
          queueItemId: null,
          positionSeconds: 0,
          updatedAtMs: Math.max(this.activeRoom.playback.updatedAtMs, nowMs),
          youtubeVideoId: null,
          youtubeSubIndex: null,
        };
      }
    } else if (mutation.type === 'clear') {
      removedCount = this.activeRoom.playlist.length;
      if (this.activeRoom.playlist.length > 0) {
        if (
          this.activeRoom.playlistRevision >= Number.MAX_SAFE_INTEGER ||
          this.activeRoom.revision >= Number.MAX_SAFE_INTEGER
        ) {
          return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
        }
        const clearCurrentPlayback =
          this.activeRoom.currentQueueItemId !== null ||
          this.activeRoom.playback.queueItemId !== null ||
          this.activeRoom.playback.state !== 'idle';
        if (clearCurrentPlayback && this.activeRoom.playback.revision >= Number.MAX_SAFE_INTEGER) {
          return errorResponse('PLAYBACK_REVISION_EXHAUSTED', 409);
        }
        this.activeRoom.playlist = [];
        playlistChanged = true;
        if (clearCurrentPlayback) {
          destructivePlaybackChanged = true;
          this.activeRoom.currentQueueItemId = null;
          this.activeRoom.playback = {
            coordinatorEpoch: this.activeRoom.playback.coordinatorEpoch,
            revision: this.activeRoom.playback.revision + 1,
            state: 'idle',
            queueItemId: null,
            positionSeconds: 0,
            updatedAtMs: Math.max(this.activeRoom.playback.updatedAtMs, nowMs),
            youtubeVideoId: null,
            youtubeSubIndex: null,
          };
        }
      }
    } else if (mutation.type === 'clear_owned') {
      const ownedQueueItemIds = new Set(
        this.activeRoom.playlist
          .filter((item) => item.developerOwnerKeyId === developerKeyId)
          .map((item) => item.queueItemId),
      );
      if (ownedQueueItemIds.size > 0) {
        if (
          this.activeRoom.playlistRevision >= Number.MAX_SAFE_INTEGER ||
          this.activeRoom.revision >= Number.MAX_SAFE_INTEGER
        ) {
          return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
        }
        const clearCurrentPlayback =
          (this.activeRoom.currentQueueItemId !== null &&
            ownedQueueItemIds.has(this.activeRoom.currentQueueItemId)) ||
          (this.activeRoom.playback.queueItemId !== null &&
            ownedQueueItemIds.has(this.activeRoom.playback.queueItemId));
        if (clearCurrentPlayback && this.activeRoom.playback.revision >= Number.MAX_SAFE_INTEGER) {
          return errorResponse('PLAYBACK_REVISION_EXHAUSTED', 409);
        }
        this.activeRoom.playlist = this.activeRoom.playlist.filter(
          (item) => !ownedQueueItemIds.has(item.queueItemId),
        );
        playlistChanged = true;
        if (clearCurrentPlayback) {
          destructivePlaybackChanged = true;
          this.activeRoom.currentQueueItemId = null;
          this.activeRoom.playback = {
            coordinatorEpoch: this.activeRoom.playback.coordinatorEpoch,
            revision: this.activeRoom.playback.revision + 1,
            state: 'idle',
            queueItemId: null,
            positionSeconds: 0,
            updatedAtMs: Math.max(this.activeRoom.playback.updatedAtMs, nowMs),
            youtubeVideoId: null,
            youtubeSubIndex: null,
          };
        }
      }
    } else {
      if (mutation.basePlaylistRevision !== this.activeRoom.playlistRevision) {
        return errorResponse('PLAYLIST_REVISION_CONFLICT', 409);
      }
      const currentIds = this.activeRoom.playlist.map((item) => item.queueItemId);
      const requested = new Set(mutation.queueItemIds);
      if (
        currentIds.length !== mutation.queueItemIds.length ||
        currentIds.some((queueItemId) => !requested.has(queueItemId))
      ) {
        return errorResponse('PLAYLIST_REVISION_CONFLICT', 409);
      }
      playlistChanged = currentIds.some(
        (queueItemId, index) => queueItemId !== mutation.queueItemIds[index],
      );
      if (playlistChanged) {
        const itemById = new Map(this.activeRoom.playlist.map((item) => [item.queueItemId, item]));
        const reordered = mutation.queueItemIds.map((queueItemId) => itemById.get(queueItemId));
        if (reordered.some((item) => item === undefined)) {
          return errorResponse('PLAYLIST_REVISION_CONFLICT', 409);
        }
        this.activeRoom.playlist = reordered.filter(
          (item): item is PlaylistItem => item !== undefined,
        );
      }
    }

    if (playlistChanged) {
      reconcileQueueModePlaylist(this.activeRoom, nowMs);
      this.activeRoom.playlistRevision += 1;
      this.activeRoom.revision += 1;
      this.reconcileAssetGarbageCollection(nowMs);
    }
    let playbackCancelEvent: JsonRecord | null = null;
    const pendingTargetQueueItemId = this.activeRoom.pendingPlaybackTransition?.target.queueItemId;
    if (
      destructivePlaybackChanged ||
      (pendingTargetQueueItemId != null &&
        !this.activeRoom.playlist.some((item) => item.queueItemId === pendingTargetQueueItemId))
    ) {
      playbackCancelEvent = this.cancelPendingPlayback('queue-item-removed', nowMs);
    }
    const responseBody = developerProjection(this.activeRoom, 'queue', nowMs, developerKeyId);
    const responseStatus =
      mutation.type === 'add_youtube' || mutation.type === 'add_youtube_batch' ? 201 : 200;
    this.storeDeveloperQueueIdempotency(scope, idempotencyKey, fingerprint, responseStatus);
    if (botTerminal !== null && botTerminalAction !== null && removedCount !== null) {
      this.storeIdempotency(
        botTerminal.terminalScope,
        botTerminal.terminalKey,
        botTerminal.terminalFingerprint,
        botDestructiveResult(
          botTerminalAction,
          removedCount,
          destructivePlaybackChanged,
          botTerminal.languageHint,
        ),
      );
    }
    if (playbackCancelEvent) this.enqueuePlaybackBroadcast(playbackCancelEvent);
    if (destructivePlaybackChanged) {
      this.enqueuePlaybackBroadcast(
        this.playbackCommitEvent(null, this.activeRoom.playback.updatedAtMs, nowMs),
      );
    }
    const addedCount =
      mutation.type === 'add_youtube'
        ? 1
        : mutation.type === 'add_youtube_batch'
          ? mutation.items.length
          : 0;
    const firstAddedTitle =
      mutation.type === 'add_youtube'
        ? mutation.title || mutation.name
        : mutation.type === 'add_youtube_batch'
          ? mutation.items[0]?.title || mutation.items[0]?.name
          : undefined;
    await this.persist();
    if (playlistChanged) {
      this.scheduleDeveloperInvalidationHint(
        addedCount > 0
          ? {
              actorName,
              fallback: 'API',
              count: addedCount,
              ...(firstAddedTitle === undefined ? {} : { firstTitle: firstAddedTitle }),
            }
          : null,
      );
    }
    return jsonResponse(responseBody, responseStatus);
  }

  async handleInternalDeveloperQueueModeUpdate(request: Request) {
    if (!this.activeRoom.provisioned || this.activeRoom.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 4 * 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'idempotencyKey', 'queueMode'],
        ['roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      parsed.value.roomCode !== this.activeRoom.roomCode ||
      !matchesPattern(parsed.value.keyId, DEVELOPER_API_KEY_ID_RE) ||
      !matchesPattern(parsed.value.idempotencyKey, IDEMPOTENCY_KEY_RE) ||
      !parsed.value.queueMode ||
      typeof parsed.value.queueMode !== 'object' ||
      Array.isArray(parsed.value.queueMode) ||
      !hasExactKeys(parsed.value.queueMode, ['baseRevision', 'repeatMode', 'shuffleEnabled']) ||
      !isSafeNonNegativeInteger(parsed.value.queueMode.baseRevision) ||
      (parsed.value.queueMode.repeatMode !== 'off' &&
        parsed.value.queueMode.repeatMode !== 'all' &&
        parsed.value.queueMode.repeatMode !== 'one') ||
      typeof parsed.value.queueMode.shuffleEnabled !== 'boolean'
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;

    const mutation = parsed.value.queueMode;
    const developerKeyId = parsed.value.keyId;
    const idempotencyKey = parsed.value.idempotencyKey;
    const shuffleEnabled = mutation.shuffleEnabled === true;
    const scope = `developer:${developerKeyId}:queue-mode:update`;
    const fingerprint = await this.idempotencyFingerprint(scope, mutation);
    const replay = this.replayIdempotency(scope, idempotencyKey, fingerprint);
    if (replay) return replay;
    if (mutation.baseRevision !== this.activeRoom.queueMode.revision) {
      return errorResponse('QUEUE_MODE_REVISION_CONFLICT', 409);
    }

    const repeatMode = mutation.repeatMode === 'one' ? 2 : mutation.repeatMode === 'all' ? 1 : 0;
    const changed =
      repeatMode !== this.activeRoom.queueMode.repeatMode ||
      shuffleEnabled !== this.activeRoom.queueMode.shuffleEnabled;
    if (
      changed &&
      (this.activeRoom.queueMode.revision >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.revision >= Number.MAX_SAFE_INTEGER)
    ) {
      return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
    }

    if (changed) {
      const nowMs = Date.now();
      this.activeRoom.queueMode = {
        revision: this.activeRoom.queueMode.revision + 1,
        updatedAtMs: nowMs,
        repeatMode,
        shuffleEnabled,
        shuffleOrder: shuffleEnabled
          ? this.activeRoom.queueMode.shuffleEnabled
            ? [...this.activeRoom.queueMode.shuffleOrder]
            : shuffledQueueItemIds(this.activeRoom.playlist)
          : [],
      };
      this.activeRoom.revision += 1;
    }

    const responseBody: JsonRecord = { ...developerQueueMode(this.activeRoom) };
    this.storeIdempotency(scope, idempotencyKey, fingerprint, responseBody);
    await this.persist();
    if (changed) {
      this.scheduleServerEvent(
        this.invalidationEvent({ queueModeRevision: this.activeRoom.queueMode.revision }),
      );
    }
    return jsonResponse(responseBody);
  }

  async handleInternalDeveloperMediaUploadCreate(request: Request) {
    if (!this.activeRoom.provisioned || this.activeRoom.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 16 * 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'idempotencyKey', 'media'],
        ['roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      parsed.value.roomCode !== this.activeRoom.roomCode ||
      !matchesPattern(parsed.value.keyId, DEVELOPER_API_KEY_ID_RE) ||
      !matchesPattern(parsed.value.idempotencyKey, IDEMPOTENCY_KEY_RE)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
    const developerKeyId = parsed.value.keyId;
    const idempotencyKey = parsed.value.idempotencyKey;
    const media = parseDeveloperMediaUpload(parsed.value.media);
    if (!media) return errorResponse('INVALID_MEDIA', 400);
    const scope = `developer:${developerKeyId}:media:reserve`;
    const fingerprint = await this.idempotencyFingerprint(scope, media);
    const replay = this.replayIdempotency(scope, idempotencyKey, fingerprint);
    if (replay) return replay;
    if (!this.env.PRO_MEDIA_BUCKET || !r2S3Config(this.env)) {
      return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    }
    if (this.activeRoom.playlist.length >= PLAYLIST_MAX_ITEMS) {
      return errorResponse('PLAYLIST_CAPACITY_EXCEEDED', 409);
    }
    const assets = Object.values(this.activeRoom.assets);
    const reservations = assets.filter((asset) => asset.status === 'reserved');
    if (assets.length + Object.keys(this.activeRoom.stagingTombstones).length >= ASSET_MAX_ITEMS) {
      return errorResponse('ASSET_CAPACITY_EXCEEDED', 409);
    }
    if (reservations.length >= RESERVED_ASSET_MAX_ITEMS) {
      return errorResponse('RESERVATION_CAPACITY_EXCEEDED', 409);
    }
    if (
      reservations.filter((asset) => asset.reservedByDeveloperKeyId === developerKeyId).length >=
      RESERVED_ASSET_MAX_ITEMS_PER_DEVELOPER_KEY
    ) {
      return errorResponse('RESERVATION_CAPACITY_EXCEEDED', 409);
    }
    if (
      this.activeRoom.quota.usedBytes + this.activeRoom.quota.reservedBytes + media.byteLength >
      ROOM_QUOTA_BYTES
    ) {
      return errorResponse('ROOM_QUOTA_EXCEEDED', 409);
    }

    const nowMs = Date.now();
    const assetId = `asset_${randomToken(24)}`;
    const queueItemId = randomQueueItemId();
    const version = 1;
    const objectPrefix = `${proRoomMediaPrefix(
      this.activeRoom.roomCode,
      this.activeRoom.roomGeneration,
    )}/assets/${assetId}/v${version}`;
    const stagingObjectKey = `${objectPrefix}/staging_${randomToken(18)}`;
    const objectKey = `${objectPrefix}/object_${randomToken(24)}`;
    const uploadHeaders = {
      'content-length': String(media.byteLength),
      'content-type': media.mime,
      'x-amz-meta-mxqr-room': this.activeRoom.roomCode,
      ...proRoomGenerationUploadMetadataHeaders(this.activeRoom.roomGeneration),
      'x-amz-meta-mxqr-asset': assetId,
      'x-amz-meta-mxqr-version': String(version),
      'x-amz-meta-mxqr-bytes': String(media.byteLength),
      ...(media.sha256 === undefined ? {} : { 'x-amz-meta-mxqr-sha256': media.sha256 }),
    };
    const presignTtl = Math.min(
      this.reservationTtlSeconds(),
      configuredNumber(this.env.PRESIGN_TTL_SECONDS, PRESIGN_TTL_SECONDS, 60, 3600),
    );
    const uploadExpiresAtMs = nowMs + presignTtl * 1000;
    // Completion keeps the original grace window: a large PUT may begin
    // before its signature expires and finish shortly afterward.
    const completionExpiresAtMs = nowMs + this.reservationTtlSeconds() * 1000;
    const uploadUrl = await createR2PresignedUrl({
      env: this.env,
      method: 'PUT',
      objectKey: stagingObjectKey,
      headers: uploadHeaders,
      expiresInSeconds: presignTtl,
      now: new Date(nowMs),
    });
    if (!uploadUrl) return errorResponse('MEDIA_NOT_CONFIGURED', 503);

    this.activeRoom.assets[assetId] = {
      status: 'reserved',
      assetId,
      roomGeneration: this.activeRoom.roomGeneration,
      version,
      objectKey,
      stagingObjectKey,
      uploadExpiresAtMs,
      reservedByDeveloperKeyId: parsed.value.keyId,
      developerQueueItemId: queueItemId,
      developerMetadata: {
        name: media.name,
        ...(media.title === undefined ? {} : { title: media.title }),
        ...(media.artist === undefined ? {} : { artist: media.artist }),
        ...(media.thumbnail === undefined ? {} : { thumbnail: media.thumbnail }),
      },
      byteLength: media.byteLength,
      name: media.name,
      mime: media.mime,
      ...(media.sha256 === undefined ? {} : { sha256: media.sha256 }),
      createdAtMs: nowMs,
      expiresAtMs: completionExpiresAtMs,
    };
    this.activeRoom.quota.reservedBytes += media.byteLength;
    this.activeRoom.revision += 1;
    const responseBody = {
      schemaVersion: 1,
      roomCode: this.activeRoom.roomCode,
      assetId,
      queueItemId,
      byteLength: media.byteLength,
      uploadExpiresAtMs,
      completionExpiresAtMs,
      upload: { method: 'PUT', url: uploadUrl, headers: uploadHeaders },
      quota: { ...this.activeRoom.quota },
    };
    // Never replay an expired signed URL. The reservation itself remains
    // completable through completionExpiresAtMs when the upload started in
    // time but crossed the signing deadline.
    this.storeIdempotency(
      scope,
      parsed.value.idempotencyKey,
      fingerprint,
      responseBody,
      201,
      uploadExpiresAtMs,
    );
    await this.persist();
    return jsonResponse(responseBody, 201);
  }

  async handleInternalDeveloperMediaUploadComplete(request: Request) {
    if (!this.activeRoom.provisioned || this.activeRoom.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 4 * 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'idempotencyKey', 'assetId'],
        ['actorName', 'roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      parsed.value.roomCode !== this.activeRoom.roomCode ||
      !matchesPattern(parsed.value.keyId, DEVELOPER_API_KEY_ID_RE) ||
      !matchesPattern(parsed.value.idempotencyKey, IDEMPOTENCY_KEY_RE) ||
      !matchesPattern(parsed.value.assetId, OPAQUE_ID_RE) ||
      (parsed.value.actorName !== undefined && !validDeveloperActorName(parsed.value.actorName))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
    const assetId = parsed.value.assetId;
    const scope = `developer:${parsed.value.keyId}:media:complete:${assetId}`;
    const fingerprint = await this.idempotencyFingerprint(scope, { assetId });
    const replay = this.replayIdempotency(scope, parsed.value.idempotencyKey, fingerprint);
    if (replay) return replay;
    const asset = this.activeRoom.assets[assetId];
    if (!asset || asset.status !== 'reserved') return errorResponse('ASSET_NOT_FOUND', 404);
    if (!constantTimeEqual(asset.reservedByDeveloperKeyId || '', parsed.value.keyId)) {
      return errorResponse('ASSET_NOT_FOUND', 404);
    }
    const developerMetadata = parseDeveloperMetadata(asset.developerMetadata);
    const stagingObjectKey = asset.stagingObjectKey;
    if (
      !matchesPattern(asset.developerQueueItemId, QUEUE_ITEM_ID_RE) ||
      !developerMetadata ||
      typeof stagingObjectKey !== 'string'
    ) {
      return errorResponse('ROOM_STATE_INVALID', 503);
    }
    if (this.activeRoom.playlist.length >= PLAYLIST_MAX_ITEMS) {
      return errorResponse('PLAYLIST_CAPACITY_EXCEEDED', 409);
    }
    if (!this.env.PRO_MEDIA_BUCKET) return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    if (serializedCoreStateByteLength(this.activeRoom) > STATE_MAX_BYTES - 32 * 1024) {
      return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
    }
    const assetRoomGeneration = asset.roomGeneration;
    if (assetRoomGeneration !== this.activeRoom.roomGeneration) {
      return errorResponse('ROOM_STATE_INVALID', 503);
    }
    const expectedObjectMetadata = {
      'mxqr-room': this.activeRoom.roomCode,
      'mxqr-generation': String(assetRoomGeneration),
      'mxqr-asset': asset.assetId,
      'mxqr-version': String(asset.version),
      'mxqr-bytes': String(asset.byteLength),
      ...(asset.sha256 === undefined ? {} : { 'mxqr-sha256': asset.sha256 }),
    };
    const objectMatchesReservation = (object: R2ObjectPort | null | undefined) => {
      const metadata = object?.customMetadata || {};
      return (
        object?.size === asset.byteLength &&
        object?.httpMetadata?.contentType === asset.mime &&
        Object.entries(expectedObjectMetadata).every(
          ([metadataKey, metadataValue]) => metadata[metadataKey] === metadataValue,
        ) &&
        (asset.sha256 !== undefined || metadata['mxqr-sha256'] === undefined)
      );
    };

    const bucket = this.env.PRO_MEDIA_BUCKET;
    let stagingObject: R2ObjectPort | null | undefined;
    let finalObject: R2ObjectPort | null | undefined;
    try {
      stagingObject = await bucket.head(stagingObjectKey);
      if (!stagingObject) finalObject = await bucket.head(asset.objectKey);
    } catch {
      return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
    }
    // A previous attempt may have copied the final object and then lost its
    // response or been interrupted before the Durable Object commit. The
    // immutable final object is a valid recovery source when every reserved
    // property still matches; otherwise a missing staging object means the
    // client upload has not completed.
    if (!stagingObject && !objectMatchesReservation(finalObject)) {
      return errorResponse('UPLOAD_INCOMPLETE', 409);
    }
    if (stagingObject && !objectMatchesReservation(stagingObject)) {
      try {
        await bucket.delete(stagingObjectKey);
      } catch {
        asset.expiresAtMs = Date.now() + 60_000;
        await this.persist();
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
      this.activeRoom.quota.reservedBytes -= asset.byteLength;
      this.retainStagingTombstone(asset);
      delete this.activeRoom.assets[assetId];
      this.activeRoom.revision += 1;
      await this.persist();
      return errorResponse('UPLOAD_MISMATCH', 409);
    }

    if (!objectMatchesReservation(finalObject)) {
      try {
        const staged = await bucket.get(stagingObjectKey);
        if (!staged?.body) return errorResponse('UPLOAD_INCOMPLETE', 409);
        await bucket.put(asset.objectKey, staged.body, {
          httpMetadata: { contentType: asset.mime },
          customMetadata: expectedObjectMetadata,
        });
        finalObject = await bucket.head(asset.objectKey);
        if (!objectMatchesReservation(finalObject)) {
          await bucket.delete(asset.objectKey).catch(() => {});
          return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
        }
      } catch {
        await bucket.delete(asset.objectKey).catch(() => {});
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
    }

    const nowMs = Date.now();
    const queueItem: PlaylistItem = {
      queueItemId: asset.developerQueueItemId,
      ...developerMetadata,
      source: publicAsset(asset),
      developerOwnerKeyId: parsed.value.keyId,
    };
    asset.status = 'ready';
    delete asset.expiresAtMs;
    asset.completedAtMs = nowMs;
    const uploadExpiresAtMs = isSafeInteger(asset.uploadExpiresAtMs)
      ? asset.uploadExpiresAtMs
      : nowMs;
    asset.stagingCleanupAfterMs = Math.max(uploadExpiresAtMs + 5_000, nowMs + 60_000);
    this.activeRoom.quota.reservedBytes -= asset.byteLength;
    this.activeRoom.quota.usedBytes += asset.byteLength;
    this.activeRoom.playlist.push(queueItem);
    this.activeRoom.playlistRevision += 1;
    delete asset.reservedByDeveloperKeyId;
    delete asset.developerQueueItemId;
    delete asset.developerMetadata;
    this.reconcileAssetGarbageCollection(nowMs);
    this.activeRoom.revision += 1;
    const responseBody = {
      schemaVersion: 1,
      roomCode: this.activeRoom.roomCode,
      asset: publicAsset(asset),
      queueItem: developerQueueItem(queueItem, parsed.value.keyId),
      playlistRevision: this.activeRoom.playlistRevision,
      quota: { ...this.activeRoom.quota },
    };
    this.storeIdempotency(scope, parsed.value.idempotencyKey, fingerprint, responseBody, 201);
    await this.persist();
    this.scheduleDeveloperInvalidationHint({
      actorName: parsed.value.actorName,
      fallback: 'API',
      count: 1,
      firstTitle: queueItem.title || queueItem.name,
    });
    // State is authoritative once persisted. Staging cleanup is deliberately
    // after that commit, so interruption cannot strand a reserved asset whose
    // only recoverable upload object was already deleted. The normal alarm GC
    // retries this best-effort cleanup via stagingCleanupAfterMs.
    const cleanup = bucket.delete(stagingObjectKey).catch(() => {});
    if (typeof this.state.waitUntil === 'function') this.state.waitUntil(cleanup);
    return jsonResponse(responseBody, 201);
  }

  reserveDeveloperCommandSlot() {
    const records = this.activeRoom.developerCommands;
    const ids = Object.keys(records);
    if (ids.length < DEVELOPER_COMMAND_MAX_ITEMS) return true;
    const evictable = ids
      .filter((id) => {
        const record = records[id];
        return (
          record !== undefined && record.status !== 'pending' && record.status !== 'dispatched'
        );
      })
      .sort((left, right) => {
        const leftRecord = records[left];
        const rightRecord = records[right];
        if (!leftRecord || !rightRecord) return 0;
        return (
          (leftRecord.completedAtMs || leftRecord.createdAtMs) -
          (rightRecord.completedAtMs || rightRecord.createdAtMs)
        );
      })[0];
    if (!evictable) return false;
    // Status polling may lose an old terminal record under the strict 64-item
    // state bound, but an Idempotency-Key replay must still return the exact
    // terminal result for its full retention window.
    const evictedRecord = records[evictable];
    if (!evictedRecord) return false;
    this.syncDeveloperCommandIdempotency(evictedRecord);
    delete records[evictable];
    return true;
  }

  developerCommandIdempotencyStorageKey(scope: string, key: string) {
    return `${scope}:${key}`;
  }

  reserveDeveloperCommandIdempotencySlot(storageKey: string, nowMs = Date.now()) {
    const records = this.activeRoom.developerCommandIdempotency;
    if (records[storageKey]) return true;
    for (const [key, record] of Object.entries(records)) {
      if (record.expiresAtMs <= nowMs) delete records[key];
    }
    // Never evict an unexpired record to admit a new command: doing so would
    // silently weaken exactly-once intent into best-effort deduplication.
    return Object.keys(records).length < DEVELOPER_COMMAND_IDEMPOTENCY_MAX_ITEMS;
  }

  syncDeveloperCommandIdempotency(command: DeveloperCommandRecord) {
    if (
      !command ||
      !DEVELOPER_API_KEY_ID_RE.test(command.keyId || '') ||
      !IDEMPOTENCY_KEY_RE.test(command.idempotencyKey || '')
    ) {
      return false;
    }
    const scope = `developer:${command.keyId}:playback`;
    const storageKey = this.developerCommandIdempotencyStorageKey(scope, command.idempotencyKey);
    const record = this.activeRoom.developerCommandIdempotency[storageKey];
    if (!record || record.commandId !== command.commandId) return false;
    record.body = publicDeveloperCommand(command);
    return true;
  }

  replayDeveloperCommandIdempotency(scope: string, key: string, fingerprint: string) {
    const storageKey = this.developerCommandIdempotencyStorageKey(scope, key);
    const record = this.activeRoom.developerCommandIdempotency[storageKey];
    if (!record) return null;
    if (!constantTimeEqual(record.fingerprint, fingerprint)) {
      return errorResponse('IDEMPOTENCY_CONFLICT', 409);
    }
    const commandId = record.body.commandId;
    const command =
      typeof commandId === 'string' && DEVELOPER_COMMAND_ID_RE.test(commandId)
        ? this.activeRoom.developerCommands[commandId]
        : null;
    return command
      ? jsonResponse(publicDeveloperCommand(command), 202)
      : jsonResponse(record.body, record.status);
  }

  completeDeveloperCommand(
    record: DeveloperCommandRecord,
    status: string,
    resultCode: string,
    nowMs: number,
    acknowledged = false,
  ) {
    delete record.dispatchCapacityReserve;
    delete record.terminalCapacityReserve;
    delete record.nextAttemptAtMs;
    record.status = status;
    record.resultCode = resultCode;
    record.completedAtMs = nowMs;
    record.retainUntilMs = nowMs + DEVELOPER_COMMAND_RETENTION_MS;
    if (acknowledged) record.acknowledgedAtMs = nowMs;
    this.syncDeveloperCommandIdempotency(record);
  }

  scheduleDeveloperInvalidationHint(addition: DeveloperInvalidationHint | null = null) {
    if (
      this.activeRoom.status !== 'active' ||
      !Number.isSafeInteger(this.activeRoom.revision) ||
      this.activeRoom.revision < 0 ||
      !Number.isSafeInteger(this.activeRoom.playlistRevision) ||
      this.activeRoom.playlistRevision < 0
    ) {
      return;
    }
    const firstTitle = queueAdditionTrackTitle(addition?.firstTitle);
    const normalizedAddition =
      addition &&
      Number.isSafeInteger(addition.count) &&
      addition.count >= 1 &&
      addition.count <= 1000
        ? {
            type: 'pro-queue-addition',
            version: DEVELOPER_CONTROL_VERSION,
            roomCode: this.activeRoom.roomCode,
            coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
            playlistRevision: this.activeRoom.playlistRevision,
            eventId: `qa_${this.activeRoom.roomCode}_${this.activeRoom.playlistRevision}_${this.activeRoom.revision}`,
            actorName: queueAdditionActorName(addition.actorName, addition.fallback),
            count: addition.count,
            ...(firstTitle ? { firstTitle } : {}),
          }
        : null;
    this.scheduleServerEvent(
      this.invalidationEvent({
        playlistRevision: this.activeRoom.playlistRevision,
        ...(normalizedAddition ? { addition: normalizedAddition } : {}),
      }),
    );
  }

  async processDeveloperCommands(nowMs = Date.now(), onlyCommandId: string | null = null) {
    let changed = false;
    const onlyRecord = onlyCommandId ? this.activeRoom.developerCommands[onlyCommandId] : undefined;
    const records: DeveloperCommandRecord[] = onlyCommandId
      ? onlyRecord
        ? [onlyRecord]
        : []
      : Object.values(this.activeRoom.developerCommands);
    for (const record of records) {
      if (record.status !== 'pending' && record.status !== 'dispatched') continue;
      if (record.expiresAtMs <= nowMs) {
        this.completeDeveloperCommand(record, 'expired', 'expired', nowMs);
        if (this.activeRoom.pendingPlaybackTransition?.developerCommandId === record.commandId) {
          const cancelEvent = this.cancelPendingPlayback('command-expired', nowMs);
          if (cancelEvent) this.scheduleServerEvent(cancelEvent);
        }
        changed = true;
      }
    }
    return changed;
  }

  async handleDeveloperCommandAck(request: Request, commandId: string) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !DEVELOPER_COMMAND_ID_RE.test(commandId) ||
      !hasExactKeys(parsed.value, ['resultCode']) ||
      typeof parsed.value.resultCode !== 'string' ||
      !DEVELOPER_COMMAND_RESULT_CODES.has(parsed.value.resultCode)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (!this.activeRoom.developerCommands[commandId])
      return errorResponse('COMMAND_NOT_FOUND', 404);
    // Browser ACKs belonged to the removed coordinator relay. Commands are
    // now applied by this Durable Object and observed through status polling.
    return errorResponse('COMMAND_ACK_NOT_REQUIRED', 410);
  }

  async handleInternalActivationClaim(request: Request) {
    if (!this.activeRoom.provisioned) return errorResponse('PRO_ROOM_NOT_FOUND', 404);
    if (this.activeRoom.status !== 'unactivated') {
      return jsonResponse(
        { error: 'PRO_ROOM_ACTIVATION_UNAVAILABLE', status: this.activeRoom.status },
        409,
      );
    }
    const secret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    if (secret.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    if (this.activeRoom.activationClaimGeneration >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('ACTIVATION_CLAIM_CAPACITY_EXCEEDED', 409);
    }
    const nowMs = Date.now();
    const expiresAt = nowMs + ACTIVATION_CLAIM_MAX_LIFETIME_MS;
    let targetAccountId: string | null = null;
    if (
      String(request.headers.get('content-type') || '')
        .toLowerCase()
        .startsWith('application/json')
    ) {
      const parsed = await this.parseBody(request, 1024);
      if (parsed.response) return parsed.response;
      if (
        !hasExactKeys(parsed.value, ['roomGeneration', 'targetAccountId']) ||
        parsed.value.roomGeneration !== this.activeRoom.roomGeneration ||
        typeof parsed.value.targetAccountId !== 'string' ||
        !ACCOUNT_ID_RE.test(parsed.value.targetAccountId)
      ) {
        return errorResponse('INVALID_REQUEST', 400);
      }
      targetAccountId = parsed.value.targetAccountId;
    }
    this.activeRoom.activationClaimGeneration += 1;
    // Persist the new generation before returning the credential. A lost
    // response may require the operator to issue again, but can never leave a
    // returned link valid without its generation being authoritative.
    await this.persist();
    const claim = await issueProRoomActivationClaim(this.activeRoom.roomCode, secret, {
      nowMs,
      expiresAtMs: expiresAt,
      generation: this.activeRoom.activationClaimGeneration,
      roomGeneration: this.activeRoom.roomGeneration,
      ...(targetAccountId === null ? {} : { targetAccountId }),
    });
    return jsonResponse({
      roomCode: this.activeRoom.roomCode,
      roomGeneration: this.activeRoom.roomGeneration,
      activationUrl: `https://musixquare.com/${this.activeRoom.roomCode}#pro-claim=${encodeURIComponent(claim)}`,
      expiresAt,
    });
  }

  async handleInternalOwnerRecoveryClaim() {
    if (!this.activeRoom.provisioned) return errorResponse('PRO_ROOM_NOT_FOUND', 404);
    if (
      this.activeRoom.status !== 'active' ||
      !ACCOUNT_ID_RE.test(this.activeRoom.ownerAccountId || '')
    ) {
      return jsonResponse(
        {
          error: 'PRO_ROOM_OWNER_RECOVERY_UNAVAILABLE',
          status: this.activeRoom.status,
          reason:
            this.activeRoom.status === 'active' ? 'owner_account_not_linked' : 'room_not_active',
        },
        409,
        { 'cache-control': 'no-store, max-age=0' },
      );
    }
    const secret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    if (secret.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    const nowMs = Date.now();
    const expiresAt = nowMs + 10 * 60 * 1000;
    const claim = await issueProRoomOwnerRecoveryClaim(this.activeRoom.roomCode, secret, {
      nowMs,
      expiresAtMs: expiresAt,
      roomGeneration: this.activeRoom.roomGeneration,
      ownerAuthorityEpoch: this.activeRoom.ownerAuthorityEpoch,
    });
    return jsonResponse(
      {
        roomCode: this.activeRoom.roomCode,
        roomGeneration: this.activeRoom.roomGeneration,
        recoveryUrl: `https://musixquare.com/${this.activeRoom.roomCode}#pro-recovery=${encodeURIComponent(claim)}`,
        expiresAt,
        ownerAccountLinked: true,
      },
      200,
      { 'cache-control': 'no-store, max-age=0' },
    );
  }

  async handleInternalOwnerTransferClaim(request: Request) {
    if (!this.activeRoom.provisioned) return errorResponse('PRO_ROOM_NOT_FOUND', 404);
    const nowMs = Date.now();
    if (
      (this.activeRoom.pendingOwnershipTransfer?.expiresAtMs || 0) > nowMs ||
      (this.activeRoom.completedOwnershipTransfer?.replayUntilMs || 0) > nowMs
    ) {
      return errorResponse('OWNER_TRANSFER_RECONCILIATION_REQUIRED', 409);
    }
    if (
      this.activeRoom.status !== 'active' &&
      !(
        this.activeRoom.status === 'suspended' &&
        (this.activeRoom.suspensionReason === 'operator_suspended' ||
          this.activeRoom.suspensionReason === 'owner_account_deleted' ||
          this.activeRoom.suspensionReason === 'ownership_transfer_pending')
      )
    ) {
      return jsonResponse(
        {
          error: 'PRO_ROOM_OWNER_TRANSFER_UNAVAILABLE',
          status: this.activeRoom.status,
          suspensionReason: this.activeRoom.suspensionReason,
        },
        409,
        { 'cache-control': 'no-store, max-age=0' },
      );
    }
    const parsed = await this.parseBody(request, 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['targetAccountId'], ['roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      typeof parsed.value.targetAccountId !== 'string' ||
      !ACCOUNT_ID_RE.test(parsed.value.targetAccountId)
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    if (this.activeRoom.ownerAuthorityRemoval?.projectionAcked === false) {
      return errorResponse('OWNER_AUTHORITY_PROJECTION_PENDING', 409);
    }
    if (
      this.activeRoom.status === 'active' &&
      this.activeRoom.ownerAccountId === parsed.value.targetAccountId
    ) {
      return errorResponse('OWNER_TRANSFER_TARGET_UNCHANGED', 409);
    }
    const secret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    if (secret.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    if (this.activeRoom.ownershipTransferClaimGeneration >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('OWNER_TRANSFER_CLAIM_CAPACITY_EXCEEDED', 409);
    }
    if (
      this.activeRoom.pendingOwnershipTransfer &&
      (this.activeRoom.authEpoch >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.ownerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.revision >= Number.MAX_SAFE_INTEGER)
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    const expiresAt = nowMs + OWNER_TRANSFER_CLAIM_DEFAULT_LIFETIME_MS;
    if (this.activeRoom.pendingOwnershipTransfer) {
      // The old transaction has expired, but preserve its previous-owner edge
      // until the replacement PREPARE copies it. Advancing both authority
      // fences makes every captured credential/proof unambiguously obsolete.
      this.activeRoom.authEpoch += 1;
      this.activeRoom.ownerAuthorityEpoch += 1;
      this.activeRoom.revision += 1;
    }
    this.activeRoom.ownershipTransferClaimGeneration += 1;
    await this.persist();
    const claim = await issueProRoomOwnerTransferClaim(this.activeRoom.roomCode, secret, {
      nowMs,
      expiresAtMs: expiresAt,
      roomGeneration: this.activeRoom.roomGeneration,
      targetAccountId: parsed.value.targetAccountId,
      claimGeneration: this.activeRoom.ownershipTransferClaimGeneration,
      ownerAuthorityEpoch: this.activeRoom.ownerAuthorityEpoch,
    });
    return jsonResponse(
      {
        ok: true,
        roomCode: this.activeRoom.roomCode,
        roomGeneration: this.activeRoom.roomGeneration,
        status: this.activeRoom.status,
        suspensionReason: this.activeRoom.suspensionReason,
        targetAccountId: parsed.value.targetAccountId,
        claimGeneration: this.activeRoom.ownershipTransferClaimGeneration,
        transferUrl: `https://musixquare.com/${this.activeRoom.roomCode}#pro-transfer=${encodeURIComponent(claim)}`,
        expiresAt,
      },
      200,
      { 'cache-control': 'no-store, max-age=0' },
    );
  }

  markRegistryActivationActive() {
    const db = this.env?.MUSIXQUARE_ADMIN_DB || this.env?.ADMIN_METRICS_DB || null;
    if (!db?.prepare) return;
    const update = (async () => {
      if ((await readServiceMaintenance(this.env)).enabled) return;
      await db
        .prepare(
          `UPDATE mxqr_pro_room_registry
           SET activation_state = 'active', updated_at = ?3
           WHERE room_code = ?1 AND room_generation = ?2 AND status = 'registered'`,
        )
        .bind(this.activeRoom.roomCode, this.activeRoom.roomGeneration, Date.now())
        .run();
    })().catch((error) => {
      console.warn('[PRO registry] activation-state update failed', error);
    });
    if (typeof this.state.waitUntil === 'function') this.state.waitUntil(update);
  }

  async parseBody(
    request: Request,
    maxBytes = SMALL_REQUEST_MAX_BYTES,
    allowSimpleText = false,
    allowEmpty = false,
  ): Promise<ParsedBodyResult> {
    const parsed = await readJsonBody(request, maxBytes, allowSimpleText, allowEmpty);
    if ('error' in parsed) {
      return { response: errorResponse(parsed.error, parsed.status || 400) };
    }
    return {
      value: 'value' in parsed ? parsed.value : undefined,
      empty: 'empty' in parsed && parsed.empty === true,
    };
  }

  rateLimitKey(request: Request, kind: string) {
    const ipHash = request.headers.get('x-mxqr-pro-ip-hash') || 'internal-test';
    return `${kind}:${ipHash}`;
  }

  readRateLimit(request: Request, kind: string, limit: number, now = Date.now()) {
    const key = this.rateLimitKey(request, kind);
    const capacityError = this.rateLimitCapacityResponse(
      this.activeRoom.rateLimits,
      [key],
      RATE_LIMIT_MAX_ITEMS,
      now,
    );
    if (capacityError) return capacityError;
    const current = this.activeRoom.rateLimits[key];
    if (current && current.resetAtMs > now && current.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAtMs - now) / 1000));
      return errorResponse('RATE_LIMITED', 429, { 'retry-after': String(retryAfterSeconds) });
    }
    return null;
  }

  recordRateLimitHit(request: Request, kind: string, windowMs: number, now = Date.now()) {
    const key = this.rateLimitKey(request, kind);
    const current = this.activeRoom.rateLimits[key];
    if (!current || current.resetAtMs <= now) {
      this.activeRoom.rateLimits[key] = { count: 1, resetAtMs: now + windowMs };
      return;
    }
    current.count += 1;
  }

  async applyRateLimit(request: Request, kind: string, limit: number, windowMs: number) {
    const rateError = this.readRateLimit(request, kind, limit);
    if (rateError) return rateError;
    this.recordRateLimitHit(request, kind, windowMs);
    await this.persist();
    return null;
  }

  pruneAccountDeletionTombstones(nowMs: number) {
    let changed = false;
    for (const [accountId, expiresAtMs] of Object.entries(
      this.activeRoom.accountDeletionTombstones || {},
    )) {
      if (expiresAtMs > nowMs) continue;
      delete this.activeRoom.accountDeletionTombstones[accountId];
      changed = true;
    }
    return changed;
  }

  retainAccountDeletionTombstone(accountId: string, nowMs: number) {
    const pruned = this.pruneAccountDeletionTombstones(nowMs);
    const tombstones = this.activeRoom.accountDeletionTombstones;
    if (
      tombstones[accountId] === undefined &&
      Object.keys(tombstones).length >= ACCOUNT_DELETION_TOMBSTONE_MAX_ITEMS
    ) {
      // Do not evict a live deletion fence: doing so could admit an assertion
      // that was issued before account deletion but arrived afterward.
      throw new RoomStateCapacityError();
    }
    // A target deleted after transfer PREPARE must remain fenced for the
    // entire transaction lifetime. The ordinary assertion tombstone can be
    // shorter than an owner-transfer claim, and allowing it to expire first
    // would let a later internal reconciliation install a deleted account.
    const pendingTransferExpiry =
      this.activeRoom.pendingOwnershipTransfer?.targetAccountId === accountId
        ? this.activeRoom.pendingOwnershipTransfer.expiresAtMs
        : 0;
    const expiresAtMs = Math.max(
      nowMs + ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
      Number.isSafeInteger(pendingTransferExpiry) ? pendingTransferExpiry : 0,
    );
    const changed = tombstones[accountId] !== expiresAtMs;
    tombstones[accountId] = expiresAtMs;
    return pruned || changed;
  }

  isAccountDeletionTombstoned(accountId: string, nowMs = Date.now()) {
    return (this.activeRoom.accountDeletionTombstones?.[accountId] || 0) > nowMs;
  }

  async accountAssertion(request: Request) {
    const token = request.headers.get(ACCOUNT_ASSERTION_HEADER);
    if (!token) return { account: null };
    const secret = String(this.env.MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET || '');
    if (secret.length < 32) {
      return { response: errorResponse('ACCOUNT_IDENTITY_NOT_CONFIGURED', 503) };
    }
    const account = await verifyAccountAssertion(token, secret, {
      audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
      roomCode: this.activeRoom.roomCode,
      roomGeneration: this.activeRoom.roomGeneration,
    });
    return account && !this.isAccountDeletionTombstoned(account.accountId)
      ? { account }
      : { response: errorResponse('ACCOUNT_ASSERTION_INVALID', 401) };
  }

  usedMemberDisplayNumbers() {
    const used = new Set<number>();
    for (const member of Object.values(this.activeRoom.accountMembers || {})) {
      if (isSafeInteger(member.displayNumber) && member.displayNumber > 0) {
        used.add(member.displayNumber);
      }
    }
    for (const administrator of Object.values(this.activeRoom.anonymousAdministrators || {})) {
      if (isSafeInteger(administrator.displayNumber) && administrator.displayNumber > 0) {
        used.add(administrator.displayNumber);
      }
    }
    for (const session of Object.values(this.activeRoom.sessions || {})) {
      if (isSafeInteger(session.memberDisplayNumber) && session.memberDisplayNumber > 0) {
        used.add(session.memberDisplayNumber);
      }
      if (isSafeInteger(session.peerOrdinal) && session.peerOrdinal > 0) {
        used.add(session.peerOrdinal);
      }
    }
    return used;
  }

  physicalSlotGroupKey(session: RoomSession) {
    return typeof session.accountId === 'string'
      ? `account:${session.accountId}`
      : `member:${session.memberId}`;
  }

  memberDisplayNumberReservations() {
    const reservations = new Map<number, string>();
    const reserve = (displayNumber: unknown, groupKey: string) => {
      if (
        isSafeInteger(displayNumber) &&
        displayNumber > 0 &&
        displayNumber <= SESSION_MAX_ITEMS &&
        !reservations.has(displayNumber)
      ) {
        reservations.set(displayNumber, groupKey);
      }
    };
    const liveSessionHashes = new Set(
      Object.values(this.activeRoom.presence.participants || {}).map(
        (participant) => participant.sessionHash,
      ),
    );
    const sessions = Object.entries(this.activeRoom.sessions || {}).sort(
      ([leftHash, left], [rightHash, right]) =>
        Number(liveSessionHashes.has(rightHash)) - Number(liveSessionHashes.has(leftHash)) ||
        (left.createdAtMs || 0) - (right.createdAtMs || 0) ||
        String(left.participantId || '').localeCompare(String(right.participantId || '')) ||
        leftHash.localeCompare(rightHash),
    );
    // A live presence epoch owns the visible numbering. Persistent authority
    // records and dormant resume cookies may retain older numbers, but they
    // cannot displace a participant that is currently shown as #1.
    for (const [tokenHash, session] of sessions) {
      if (session.role === 'owner' || !liveSessionHashes.has(tokenHash)) continue;
      reserve(session.memberDisplayNumber, this.physicalSlotGroupKey(session));
    }
    for (const [accountId, member] of Object.entries(this.activeRoom.accountMembers || {})) {
      reserve(member.displayNumber, `account:${accountId}`);
    }
    for (const [memberId, administrator] of Object.entries(
      this.activeRoom.anonymousAdministrators || {},
    )) {
      reserve(administrator.displayNumber, `member:${memberId}`);
    }
    for (const [, session] of sessions) {
      if (session.role === 'owner') continue;
      reserve(session.memberDisplayNumber, this.physicalSlotGroupKey(session));
    }
    return reservations;
  }

  normalizeLoadedPhysicalSlotAssignments(canMigrateAnonymousIdentity = true) {
    let anonymousIdentityChanged = false;
    const liveSessionHashes = new Set(
      Object.values(this.activeRoom.presence.participants || {}).map(
        (participant) => participant.sessionHash,
      ),
    );
    const sessions = Object.entries(this.activeRoom.sessions || {})
      .filter(([, session]) => session.role !== 'owner')
      .sort(
        ([leftHash, left], [rightHash, right]) =>
          Number(liveSessionHashes.has(rightHash)) - Number(liveSessionHashes.has(leftHash)) ||
          (left.createdAtMs || 0) - (right.createdAtMs || 0) ||
          String(left.participantId || '').localeCompare(String(right.participantId || '')) ||
          leftHash.localeCompare(rightHash),
      );
    const reservations = this.memberDisplayNumberReservations();
    const assigned = new Map<RoomSession, number>();
    const used = new Set<number>();

    // Preserve durable unique assignments when they do not steal another
    // member's canonical number. This keeps ordinary restarts byte-stable.
    for (const [, session] of sessions) {
      const preferred = session.peerOrdinal;
      const groupKey = this.physicalSlotGroupKey(session);
      const reservationOwner = isSafeInteger(preferred) ? reservations.get(preferred) : undefined;
      if (
        !isSafeInteger(preferred) ||
        preferred < 1 ||
        preferred > SESSION_MAX_ITEMS ||
        used.has(preferred) ||
        (reservationOwner !== undefined && reservationOwner !== groupKey)
      ) {
        continue;
      }
      assigned.set(session, preferred);
      used.add(preferred);
    }

    for (const [, session] of sessions) {
      if (assigned.has(session)) continue;
      const groupKey = this.physicalSlotGroupKey(session);
      const preferred = session.memberDisplayNumber;
      const preferredOwner = isSafeInteger(preferred) ? reservations.get(preferred) : undefined;
      let ordinal =
        isSafeInteger(preferred) &&
        preferred >= 1 &&
        preferred <= SESSION_MAX_ITEMS &&
        !used.has(preferred) &&
        (preferredOwner === undefined || preferredOwner === groupKey)
          ? preferred
          : 1;
      while (
        ordinal <= SESSION_MAX_ITEMS &&
        (used.has(ordinal) || (reservations.has(ordinal) && reservations.get(ordinal) !== groupKey))
      ) {
        ordinal += 1;
      }
      // A fully occupied legacy reservation table must not make an otherwise
      // valid stored room unloadable. Physical uniqueness still takes priority.
      if (ordinal > SESSION_MAX_ITEMS) {
        ordinal = 1;
        while (ordinal <= SESSION_MAX_ITEMS && used.has(ordinal)) ordinal += 1;
      }
      if (ordinal > SESSION_MAX_ITEMS) continue;
      assigned.set(session, ordinal);
      used.add(ordinal);
    }

    let highestOrdinal = 0;
    for (const [, session] of sessions) {
      const ordinal = assigned.get(session);
      if (!isSafeInteger(ordinal)) continue;
      highestOrdinal = Math.max(highestOrdinal, ordinal);
      if (!session.accountId) {
        if (!canMigrateAnonymousIdentity) continue;
        if (session.peerOrdinal !== ordinal) anonymousIdentityChanged = true;
        session.peerOrdinal = ordinal;
        if (session.memberDisplayNumber !== ordinal) anonymousIdentityChanged = true;
        session.memberDisplayNumber = ordinal;
        const canonicalDisplayName = `${DEFAULT_PEER_DISPLAY_NAME} ${ordinal}`;
        if (session.displayName !== canonicalDisplayName) anonymousIdentityChanged = true;
        session.displayName = canonicalDisplayName;
        const administrator = this.activeRoom.anonymousAdministrators?.[session.memberId];
        if (administrator) {
          if (administrator.displayNumber !== ordinal) anonymousIdentityChanged = true;
          administrator.displayNumber = ordinal;
          if (administrator.displayName !== canonicalDisplayName) {
            anonymousIdentityChanged = true;
          }
          administrator.displayName = canonicalDisplayName;
        }
      } else {
        session.peerOrdinal = ordinal;
      }
    }
    if (highestOrdinal > 0) {
      this.activeRoom.nextMemberDisplayNumber = Math.min(
        SESSION_MAX_ITEMS + 1,
        Math.max(this.activeRoom.nextMemberDisplayNumber || 1, highestOrdinal + 1),
      );
    }
    return anonymousIdentityChanged;
  }

  nextAccountMemberDisplayNumber() {
    // Display numbers describe the current presence epoch, not the lifetime
    // of a resumable room cookie. A sleeping room can retain old sessions and
    // persistent account authority for hours; those dormant records must not
    // make the first returning listener appear as #12.
    return this.nextLivePhysicalDeviceOrdinal();
  }

  livePhysicalDeviceOrdinals(excludedSession: RoomSession | null = null) {
    const used = new Set<number>();
    for (const participant of Object.values(this.activeRoom.presence.participants || {})) {
      const session = this.activeRoom.sessions?.[participant.sessionHash];
      if (!session || session === excludedSession || session.role === 'owner') continue;
      if (
        isSafeInteger(session.peerOrdinal) &&
        session.peerOrdinal >= 1 &&
        session.peerOrdinal <= SESSION_MAX_ITEMS
      ) {
        used.add(session.peerOrdinal);
      }
    }
    return used;
  }

  nextLivePhysicalDeviceOrdinal(excludedSession: RoomSession | null = null) {
    const used = this.livePhysicalDeviceOrdinals(excludedSession);
    for (let ordinal = 1; ordinal <= SESSION_MAX_ITEMS; ordinal += 1) {
      if (!used.has(ordinal)) return ordinal;
    }
    return null;
  }

  reclaimLiveAccountRepresentativeOrdinal(departed: PresenceParticipant) {
    const representativeOrdinal = departed.memberDisplayNumber;
    if (
      !departed.accountId ||
      !isSafeInteger(representativeOrdinal) ||
      representativeOrdinal < 1 ||
      representativeOrdinal > SESSION_MAX_ITEMS
    ) {
      return false;
    }

    const remaining: Array<{ participant: PresenceParticipant; session: RoomSession }> = [];
    for (const participant of Object.values(this.activeRoom.presence.participants || {})) {
      if (participant.memberId !== departed.memberId) continue;
      const session = this.activeRoom.sessions?.[participant.sessionHash];
      if (session && session.role !== 'owner') remaining.push({ participant, session });
    }
    remaining.sort(
      (left, right) =>
        (left.session.peerOrdinal || SESSION_MAX_ITEMS + 1) -
          (right.session.peerOrdinal || SESSION_MAX_ITEMS + 1) ||
        left.participant.joinedAtMs - right.participant.joinedAtMs ||
        left.participant.participantId.localeCompare(right.participant.participantId),
    );
    if (remaining.length === 0) return false;
    if (remaining.some(({ session }) => session.peerOrdinal === representativeOrdinal)) {
      return false;
    }

    // Keep the account row's visible number stable without reserving an extra
    // physical slot. When its representative device leaves, one remaining
    // device atomically inherits that ordinal before another member can join.
    // This avoids duplicate visible rows and still preserves the full 100
    // physical-device capacity.
    if (this.livePhysicalDeviceOrdinals().has(representativeOrdinal)) return false;
    const representative = remaining[0];
    if (!representative) return false;
    representative.session.peerOrdinal = representativeOrdinal;
    return true;
  }

  assignSessionPresenceIdentity(session: RoomSession) {
    if (session.role === 'owner') {
      session.memberDisplayNumber = 0;
      delete session.peerOrdinal;
      return true;
    }

    // A physical slot is scoped to live presence. Re-entering after a room
    // sleeps (or after another device leaves) is a new ordering event even if
    // the long-lived session cookie is reused.
    const peerOrdinal = this.nextLivePhysicalDeviceOrdinal(session);
    if (peerOrdinal === null) return false;
    session.peerOrdinal = peerOrdinal;

    const sameMember = Object.values(this.activeRoom.presence.participants || {}).find(
      (participant) => participant.memberId === session.memberId,
    );
    const groupDisplayNumber =
      sameMember &&
      isSafeInteger(sameMember.memberDisplayNumber) &&
      sameMember.memberDisplayNumber > 0
        ? sameMember.memberDisplayNumber
        : peerOrdinal;
    session.memberDisplayNumber = groupDisplayNumber;

    if (session.accountId) {
      const member = this.activeRoom.accountMembers?.[session.accountId];
      if (member && member.memberId === session.memberId) {
        member.displayNumber = groupDisplayNumber;
        this.syncAccountMemberSessions(session.accountId, member);
      }
    } else {
      const administrator = this.activeRoom.anonymousAdministrators?.[session.memberId];
      if (administrator) {
        administrator.displayNumber = groupDisplayNumber;
        administrator.displayName = `${DEFAULT_PEER_DISPLAY_NAME} ${peerOrdinal}`;
      }
    }

    if (!session.accountId) {
      session.displayName = `${DEFAULT_PEER_DISPLAY_NAME} ${peerOrdinal}`;
    }
    this.activeRoom.nextMemberDisplayNumber = Math.min(
      SESSION_MAX_ITEMS + 1,
      Math.max(this.activeRoom.nextMemberDisplayNumber || 1, peerOrdinal + 1),
    );
    return true;
  }

  syncAccountMemberSessions(accountId: string, member: AccountMember) {
    for (const session of Object.values(this.activeRoom.sessions)) {
      if (session.accountId !== accountId) continue;
      session.memberId = member.memberId;
      session.memberDisplayNumber = member.displayNumber;
      session.displayName = member.displayName;
      session.role = member.role;
      const participant = this.activeRoom.presence.participants[session.participantId];
      if (!participant) continue;
      participant.accountId = accountId;
      participant.memberId = member.memberId;
      participant.memberDisplayNumber = member.displayNumber;
      participant.displayName = member.displayName;
      participant.role = member.role;
    }
  }

  detachAccountSession(
    session: RoomSession,
    nowMs: number,
    options: DetachAccountSessionOptions = {},
  ) {
    if (!session?.accountId) return null;
    const participant = this.activeRoom.presence.participants[session.participantId] || null;
    let memberDisplayNumber = this.nextAccountMemberDisplayNumber();
    if (memberDisplayNumber === null) {
      if (options.requireUniqueDisplayNumber === true) return null;
      // Revocation must never fail open merely because every display slot is
      // reserved. `peerOrdinal` is a physical-device label rather than an
      // authority key, so a temporary duplicate visual number is safer than
      // retaining owner/controller capabilities. The next normal slot repair
      // can choose a unique number after another session departs.
      memberDisplayNumber =
        isSafeInteger(session.peerOrdinal) && session.peerOrdinal > 0
          ? session.peerOrdinal
          : isSafeInteger(session.memberDisplayNumber) && session.memberDisplayNumber > 0
            ? session.memberDisplayNumber
            : 1;
    }

    delete session.accountId;
    delete session.accountLeaseExpiresAtMs;
    session.memberId = `member_${randomToken(18)}`;
    session.memberDisplayNumber = memberDisplayNumber;
    session.peerOrdinal = memberDisplayNumber;
    session.displayName = `${DEFAULT_PEER_DISPLAY_NAME} ${memberDisplayNumber}`;
    session.role = 'member';
    this.activeRoom.nextMemberDisplayNumber = Math.min(
      SESSION_MAX_ITEMS + 1,
      Math.max(this.activeRoom.nextMemberDisplayNumber || 1, memberDisplayNumber + 1),
    );

    if (participant) {
      delete participant.accountId;
      participant.memberId = session.memberId;
      participant.memberDisplayNumber = memberDisplayNumber;
      participant.displayName = session.displayName;
      participant.role = 'member';
      if (options.touchPresence === true) participant.lastSeenAtMs = nowMs;
      if (this.activeRoom.presence.revision < Number.MAX_SAFE_INTEGER) {
        this.activeRoom.presence.revision += 1;
      }
    }
    if (this.activeRoom.revision < Number.MAX_SAFE_INTEGER) this.activeRoom.revision += 1;
    return { participant, memberDisplayNumber };
  }

  resolveAccountMember(
    account: { accountId: string; nickname: string },
    role: ProRoomRole,
    nowMs: number,
  ): AccountMemberWithId | null {
    if (!account) return null;
    let member = this.activeRoom.accountMembers[account.accountId] || null;
    const linkingOwner = role === 'owner' && this.activeRoom.ownerAccountId === null;
    const linkedOwner = this.activeRoom.ownerAccountId === account.accountId;
    const ownerMemberId = this.activeRoom.ownerMemberId;

    // A browser owner credential proves the existing owner, but must not
    // silently transfer a previously linked room to whichever Google account
    // happens to be signed in on that browser today.
    if (role === 'owner' && this.activeRoom.ownerAccountId && !linkedOwner) return null;
    if ((linkingOwner || linkedOwner) && ownerMemberId === null) return null;

    if (!member) {
      if (Object.keys(this.activeRoom.accountMembers).length >= ACCOUNT_MEMBER_MAX_ITEMS)
        return null;
      const displayNumber = linkingOwner || linkedOwner ? 0 : this.nextAccountMemberDisplayNumber();
      if (displayNumber === null) return null;
      const memberId = linkingOwner || linkedOwner ? ownerMemberId : `member_${randomToken(18)}`;
      if (memberId === null) return null;
      const newMember: AccountMember = {
        memberId,
        displayName: account.nickname,
        displayNumber,
        role: linkingOwner || linkedOwner ? 'owner' : 'member',
        permissions:
          linkingOwner || linkedOwner
            ? clonePermissionSet(OWNER_PERMISSIONS)
            : clonePermissionSet(MEMBER_PERMISSIONS),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      member = newMember;
      this.activeRoom.accountMembers[account.accountId] = newMember;
      if (displayNumber > 0) {
        this.activeRoom.nextMemberDisplayNumber = Math.min(
          SESSION_MAX_ITEMS + 1,
          displayNumber + 1,
        );
      }
    } else {
      member.displayName = account.nickname;
      member.updatedAtMs = nowMs;
    }
    if (!member) return null;

    if (linkingOwner || linkedOwner) {
      this.activeRoom.ownerAccountId = account.accountId;
      member.memberId = ownerMemberId ?? member.memberId;
      member.displayNumber = 0;
      member.role = 'owner';
      member.permissions = clonePermissionSet(OWNER_PERMISSIONS);
      this.activeRoom.ownerDisplayName = member.displayName;
    }
    this.syncAccountMemberSessions(account.accountId, member);
    return { accountId: account.accountId, ...member };
  }

  prepareOwnerAccountMember(
    account: { accountId: string; nickname: string },
    nowMs: number,
  ): AccountMemberWithId | null {
    if (!account) return null;
    const linkedOwner = this.activeRoom.ownerAccountId === account.accountId;
    if (this.activeRoom.ownerAccountId && !linkedOwner) return null;
    const ownerMemberId = this.activeRoom.ownerMemberId;
    if (ownerMemberId === null) return null;
    const existing = this.activeRoom.accountMembers[account.accountId] || null;
    if (
      !existing &&
      Object.keys(this.activeRoom.accountMembers).length >= ACCOUNT_MEMBER_MAX_ITEMS
    ) {
      return null;
    }
    return {
      accountId: account.accountId,
      memberId: ownerMemberId,
      displayName: account.nickname,
      displayNumber: 0,
      role: 'owner',
      permissions: clonePermissionSet(OWNER_PERMISSIONS),
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };
  }

  commitOwnerAccountMember(accountMember: AccountMemberWithId) {
    const { accountId, ...member } = accountMember;
    this.activeRoom.accountMembers[accountId] = member;
    this.activeRoom.ownerAccountId = accountId;
    this.activeRoom.ownerDisplayName = member.displayName;
    this.syncAccountMemberSessions(accountId, member);
  }

  findAccountMemberByMemberId(memberId: string) {
    return (
      Object.entries(this.activeRoom.accountMembers || {}).find(
        ([, member]) => member.memberId === memberId,
      ) || null
    );
  }

  syncAnonymousMemberSessions(
    memberId: string,
    role: ProRoomRole,
    administrator: AnonymousAdministrator | null = null,
  ) {
    for (const session of Object.values(this.activeRoom.sessions || {})) {
      if (session.accountId || session.memberId !== memberId || session.role === 'owner') continue;
      session.role = role;
      if (administrator) {
        session.displayName = administrator.displayName;
        session.memberDisplayNumber = administrator.displayNumber;
      }
      const participant = this.activeRoom.presence.participants[session.participantId];
      if (!participant) continue;
      participant.role = role;
      participant.displayName = session.displayName;
      if (isSafeInteger(session.memberDisplayNumber)) {
        participant.memberDisplayNumber = session.memberDisplayNumber;
      } else {
        delete participant.memberDisplayNumber;
      }
    }
  }

  removeAnonymousAdministrator(memberId: string) {
    if (!this.activeRoom.anonymousAdministrators?.[memberId]) return false;
    delete this.activeRoom.anonymousAdministrators[memberId];
    this.syncAnonymousMemberSessions(memberId, 'member');
    return true;
  }

  cleanupMemberAfterSessionRemoval(session: RoomSession) {
    if (!session) return false;
    const hasAnotherSession = Object.values(this.activeRoom.sessions || {}).some(
      (candidate) => candidate.memberId === session.memberId,
    );
    if (hasAnotherSession) return false;
    if (!session.accountId) return this.removeAnonymousAdministrator(session.memberId);
    const member = this.activeRoom.accountMembers?.[session.accountId];
    if (!member || member.role !== 'member') return false;
    delete this.activeRoom.accountMembers[session.accountId];
    return true;
  }

  removeSessionRecord(tokenHash: string) {
    const session = this.activeRoom.sessions[tokenHash];
    if (!session) return false;
    delete this.activeRoom.sessions[tokenHash];
    this.cleanupMemberAfterSessionRemoval(session);
    return true;
  }

  discardTransientMemberAuthority() {
    this.activeRoom.anonymousAdministrators = {};
    for (const [accountId, member] of Object.entries(this.activeRoom.accountMembers || {})) {
      if (member.role === 'member') delete this.activeRoom.accountMembers[accountId];
    }
  }

  memberSessionRecords(memberId: string) {
    return Object.entries(this.activeRoom.sessions || {}).filter(
      ([, session]) => session.memberId === memberId,
    );
  }

  administratorResponse() {
    return jsonResponse({
      authorityVersion: 1,
      administrators: publicAdministrators(this.activeRoom),
    });
  }

  async handleGetAdministrators(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    return this.administratorResponse();
  }

  async handlePutAdministrator(request: Request, memberId: string) {
    const auth = await this.requireSession(request, { owner: true, activePresence: true });
    if (auth.response) return auth.response;
    if (!OPAQUE_ID_RE.test(memberId || '') || memberId === this.activeRoom.ownerMemberId) {
      return errorResponse('ADMINISTRATOR_TARGET_INVALID', 409);
    }
    const parsed = await this.parseBody(request, 2 * 1024);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['permissions'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const permissions = normalizePermissionSet(parsed.value.permissions);
    if (!permissions) return errorResponse('INVALID_REQUEST', 400);
    const nowMs = Date.now();
    const accountEntry = this.findAccountMemberByMemberId(memberId);
    if (accountEntry) {
      const [accountId, member] = accountEntry;
      if (member.role === 'owner' || accountId === this.activeRoom.ownerAccountId) {
        return errorResponse('OWNER_AUTHORITY_IMMUTABLE', 409);
      }
      member.role = 'controller';
      member.permissions = permissions;
      member.updatedAtMs = nowMs;
      this.syncAccountMemberSessions(accountId, member);
    } else {
      const sessions = this.memberSessionRecords(memberId).filter(
        ([, session]) => !session.accountId,
      );
      const session = sessions[0]?.[1];
      if (!session) return errorResponse('MEMBER_NOT_FOUND', 404);
      if (!isSafeInteger(session.memberDisplayNumber)) {
        return errorResponse('ROOM_STATE_INVALID', 503);
      }
      const existing = this.activeRoom.anonymousAdministrators[memberId];
      if (
        !existing &&
        Object.keys(this.activeRoom.anonymousAdministrators).length >= ANONYMOUS_ADMIN_MAX_ITEMS
      ) {
        return errorResponse('ADMINISTRATOR_CAPACITY_EXCEEDED', 409);
      }
      const administrator: AnonymousAdministrator = {
        memberId,
        displayName: session.displayName,
        displayNumber: session.memberDisplayNumber,
        permissions,
        createdAtMs: existing?.createdAtMs || nowMs,
        updatedAtMs: nowMs,
      };
      this.activeRoom.anonymousAdministrators[memberId] = administrator;
      this.syncAnonymousMemberSessions(memberId, 'controller', administrator);
    }
    this.activeRoom.presence.revision += 1;
    this.activeRoom.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent());
    return this.administratorResponse();
  }

  async handleDeleteAdministrator(request: Request, memberId: string) {
    const auth = await this.requireSession(request, { owner: true, activePresence: true });
    if (auth.response) return auth.response;
    if (!OPAQUE_ID_RE.test(memberId || '') || memberId === this.activeRoom.ownerMemberId) {
      return errorResponse('OWNER_AUTHORITY_IMMUTABLE', 409);
    }
    if (request.body && (request.headers.get('content-length') || '') !== '0') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    let changed = false;
    const accountEntry = this.findAccountMemberByMemberId(memberId);
    if (accountEntry) {
      const [accountId, member] = accountEntry;
      if (member.role !== 'controller') return errorResponse('ADMINISTRATOR_NOT_FOUND', 404);
      member.role = 'member';
      member.permissions = clonePermissionSet(MEMBER_PERMISSIONS);
      member.updatedAtMs = Date.now();
      this.syncAccountMemberSessions(accountId, member);
      if (this.memberSessionRecords(memberId).length === 0) {
        delete this.activeRoom.accountMembers[accountId];
      }
      changed = true;
    } else {
      changed = this.removeAnonymousAdministrator(memberId);
    }
    if (!changed) return errorResponse('ADMINISTRATOR_NOT_FOUND', 404);
    this.activeRoom.presence.revision += 1;
    this.activeRoom.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent());
    return this.administratorResponse();
  }

  async handleInternalAuthorityCheck(request: Request) {
    const parsed = await this.parseBody(request, 2 * 1024);
    if (parsed.response) return parsed.response;
    if (!isRecord(parsed.value) || typeof parsed.value.permission !== 'string') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const permission = parsed.value.permission;
    const expectedKeys =
      permission === 'bot.result'
        ? ['participantId', 'presenceIncarnationId', 'permission', 'requestId', 'result']
        : permission === 'system.broadcast'
          ? ['participantId', 'presenceIncarnationId', 'permission', 'i18nKey']
          : ['participantId', 'presenceIncarnationId', 'permission'];
    if (
      !hasExactKeys(parsed.value, [...expectedKeys, 'roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      !matchesPattern(parsed.value.participantId, OPAQUE_ID_RE) ||
      !matchesPattern(parsed.value.presenceIncarnationId, OPAQUE_ID_RE) ||
      !isProInternalAuthorityPermission(permission)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const participantId = parsed.value.participantId;
    const presenceIncarnationId = parsed.value.presenceIncarnationId;
    const participant = this.activeRoom.presence.participants[participantId];
    const session = participant ? this.activeRoom.sessions[participant.sessionHash] : null;
    let allowed = false;
    if (participant && session && participant.presenceIncarnationId === presenceIncarnationId) {
      if (isProRoomPermission(permission)) {
        allowed = this.sessionHasPermission(session, permission);
      } else if (permission === 'room.configure') {
        allowed = session.role === 'owner';
      } else if (permission === 'chat.manage') {
        allowed = session.role === 'owner' || session.role === 'controller';
      } else if (permission === 'system.broadcast') {
        const requiredPermission =
          typeof parsed.value.i18nKey === 'string'
            ? requiredProSystemMessagePermission(parsed.value.i18nKey)
            : null;
        allowed =
          requiredPermission === 'room.configure'
            ? session.role === 'owner'
            : requiredPermission === 'playback.control' &&
              this.sessionHasPermission(session, 'playback.control');
      } else if (
        permission === 'bot.result' &&
        matchesPattern(parsed.value.requestId, BOT_REQUEST_ID_RE)
      ) {
        const receipt =
          this.activeRoom.idempotency[
            `bot-execute:${participant.sessionHash}:${parsed.value.requestId}`
          ];
        const body = receipt?.body;
        let expectedResult = null;
        if (
          body?.ok === true &&
          isSafeInteger(body.addedCount) &&
          body.addedCount > 0 &&
          body.addedCount <= BOT_MAX_TRACK_ITEMS &&
          typeof body.playbackChanged === 'boolean'
        ) {
          expectedResult = {
            kind: 'added',
            count: body.addedCount,
            playbackChanged: body.playbackChanged,
          };
        } else if (
          body?.ok === true &&
          typeof body.summary === 'string' &&
          body.summary.trim().length > 0 &&
          body.summary.length <= 500
        ) {
          expectedResult = { kind: 'answer', text: body.summary };
        }
        allowed =
          expectedResult !== null &&
          JSON.stringify(parsed.value.result) === JSON.stringify(expectedResult);
      }
    }
    return allowed && session
      ? jsonResponse({
          allowed: true,
          roomCode: this.activeRoom.roomCode,
          ...proRoomGenerationWireFields(this.activeRoom.roomGeneration),
          memberId: session.memberId,
          role: session.role,
          permission,
        })
      : errorResponse('PERMISSION_REQUIRED', 403);
  }

  async currentOwnerAccountDeletionState() {
    const accountId = this.activeRoom.ownerAccountId;
    if (!ACCOUNT_ID_RE.test(accountId || '')) return 'not-linked';
    const db = this.env.MUSIXQUARE_AUTH_DB;
    if (!db?.prepare) return 'unavailable';
    try {
      // This query always returns one row. The deletion fence is created before
      // the account/session revocation batch, but that early fence is still
      // reversible when deletion preflight fails. Therefore active+fenced may
      // block a request, but must never destructively purge room authority.
      // Only disabled/missing is terminal evidence for the self-purge below.
      const statement = db
        .prepare(
          `SELECT
             (SELECT status FROM ${ACCOUNT_TABLE}
               WHERE account_id = ?1 LIMIT 1) AS account_status,
             EXISTS(
               SELECT 1 FROM ${ACCOUNT_DELETION_TABLE}
                WHERE account_id = ?1
             ) AS deletion_pending`,
        )
        .bind(accountId);
      const row =
        typeof statement.first === 'function'
          ? await statement.first()
          : (await statement.all())?.results?.[0] || null;
      if (
        !row ||
        !hasExactKeys(row, ['account_status', 'deletion_pending']) ||
        (row.deletion_pending !== 0 && row.deletion_pending !== 1)
      ) {
        return 'unavailable';
      }
      if (row.account_status === 'active') {
        return row.deletion_pending === 1 ? 'deleting' : 'active';
      }
      if (row.account_status === 'disabled' || row.account_status === null) return 'deleted';
      return 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  async projectOwnerAccountDeletedSuspension(nowMs = Date.now()) {
    const db = this.env.MUSIXQUARE_ADMIN_DB || this.env.ADMIN_METRICS_DB || null;
    if (!db?.prepare) return false;
    try {
      const result = await db
        .prepare(
          `UPDATE mxqr_pro_room_registry
              SET status = 'suspended', suspension_reason = 'owner_account_deleted',
                  activation_state = 'active', updated_at = ?3
            WHERE room_code = ?1 AND room_generation = ?2
              AND status NOT IN ('decommissioning', 'decommissioned')`,
        )
        .bind(this.activeRoom.roomCode, this.activeRoom.roomGeneration, nowMs)
        .run();
      const changes =
        isRecord(result) && isRecord(result.meta) && isFiniteNumber(result.meta.changes)
          ? result.meta.changes
          : 0;
      if (changes < 1) return false;
      // Keep this isolate's public front-door cache consistent with the D1
      // projection immediately. Other isolates re-read the same row on their
      // bounded registry refresh, while this DO remains the final authority.
      const cache = registryCacheFor(db);
      cache.registered.delete(this.activeRoom.roomCode);
      cache.suspended.set(this.activeRoom.roomCode, this.activeRoom.roomGeneration);
      // This is only a one-room projection, not a complete registry refresh.
      // Preserve the cache timestamp so an empty or stale cache cannot make
      // unrelated rooms look absent (or extend stale entries) for another TTL.
      return true;
    } catch {
      return false;
    }
  }

  async enforceOwnerAccountDeletionFence(nowMs = Date.now()) {
    if (
      (this.activeRoom.status !== 'active' && this.activeRoom.status !== 'suspended') ||
      !this.activeRoom.ownerAccountId
    ) {
      return null;
    }
    const deletionState = await this.currentOwnerAccountDeletionState();
    if (deletionState === 'active' || deletionState === 'not-linked') return null;
    if (deletionState === 'deleting' || deletionState === 'unavailable') {
      // Do not execute an owner/session/developer mutation while the only
      // service capable of proving that the linked account still exists is
      // unavailable. Anonymous legacy rooms have no ownerAccountId and do not
      // enter this branch. A reversible active+deletion-fence race also uses
      // this response without destroying room authority; after rollback, the
      // next request observes active+unfenced and proceeds normally.
      return errorResponse('ACCOUNT_AUTHORITY_UNAVAILABLE', 503);
    }

    const accountId = this.activeRoom.ownerAccountId;
    const purgeResponse = await this.withStateCapacityRollback(
      async () => {
        const result = this.purgeAccountAuthority(accountId, nowMs);
        if (!result?.ownerAuthorityRemoved) {
          return errorResponse('ACCOUNT_AUTHORITY_UNAVAILABLE', 503);
        }
        if (result.changed || this.accountIdentityMigrationPending) {
          if (result.authorityChanged) this.activeRoom.revision += 1;
          await this.persist();
          this.accountIdentityMigrationPending = false;
          if (result.authorityChanged) this.scheduleServerEvent(this.presenceEvent());
        }
        return null;
      },
      { rollbackStorageFailure: true },
    );
    if (purgeResponse) return purgeResponse;
    // Projection is best-effort here because the durable room has already
    // revoked every credential and is suspended. The account-deletion retry
    // job will finish Developer-key revocation, audit and the exact projection
    // ACK before an ownership transfer may reactivate the room.
    await this.projectOwnerAccountDeletedSuspension(nowMs);
    return errorResponse('ROOM_SUSPENDED', 423);
  }

  removeAccountAuthority(
    accountId: string,
    nowMs: number,
    {
      retainDeletionTombstone = true,
      suspensionReason = 'owner_account_deleted',
    }: RemoveAccountAuthorityOptions = {},
  ): AccountAuthorityRemovalResult | null {
    if (!ACCOUNT_ID_RE.test(accountId)) return null;
    const tombstoneChanged = retainDeletionTombstone
      ? this.retainAccountDeletionTombstone(accountId, nowMs)
      : false;
    const member = this.activeRoom.accountMembers?.[accountId] || null;
    const replayedOwnerRemoval =
      this.activeRoom.status === 'suspended' &&
      this.activeRoom.suspensionReason === suspensionReason &&
      this.activeRoom.ownerAuthorityRemoval?.accountId === accountId;
    const removingCurrentOwner =
      this.activeRoom.ownerAccountId === accountId || member?.role === 'owner';

    if (removingCurrentOwner) {
      const playbackRevisionSteps =
        this.activeRoom.playback.state === 'playing' && this.activeRoom.playback.updatedAtMs > 0
          ? 2
          : 1;
      if (
        this.activeRoom.authEpoch >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.ownerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.developerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.revision >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.presence.revision >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.presence.coordinatorEpoch >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.playback.revision > Number.MAX_SAFE_INTEGER - playbackRevisionSteps
      ) {
        throw new RoomStateCapacityError();
      }
      const removedSessions = Object.keys(this.activeRoom.sessions || {}).length;
      this.freezePlayback(nowMs);
      this.activeRoom.sessions = {};
      this.activeRoom.presence.participants = {};
      this.activeRoom.presence.coordinatorParticipantId = null;
      this.activeRoom.presence.revision += 1;
      this.activeRoom.accountMembers = {};
      this.activeRoom.anonymousAdministrators = {};
      this.activeRoom.pin = null;
      this.activeRoom.ownerCredentialHash = null;
      this.activeRoom.ownerAccountId = null;
      this.activeRoom.ownerDisplayName = null;
      this.activeRoom.pendingOwnershipTransfer = null;
      this.activeRoom.completedOwnershipTransfer = null;
      this.activeRoom.developerCommands = {};
      this.activeRoom.developerCommandIdempotency = {};
      this.activeRoom.authEpoch += 1;
      this.activeRoom.ownerAuthorityEpoch += 1;
      this.activeRoom.developerAuthorityEpoch += 1;
      this.activeRoom.runtime = 'sleeping';
      this.reconcileSystemAudio(nowMs);
      this.bumpRoomEpoch(nowMs);
      this.activeRoom.ownerAuthorityRemoval = {
        accountId,
        removalId: `removal_${randomToken(16)}`,
        removedAtMs: nowMs,
        ownerAuthorityEpoch: this.activeRoom.ownerAuthorityEpoch,
        fencedCoordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
        projectionAcked: false,
      };
      this.activeRoom.status = 'suspended';
      this.activeRoom.suspensionReason = suspensionReason;
      return {
        changed: true,
        authorityChanged: true,
        ownerAuthorityRemoved: true,
        removal: this.activeRoom.ownerAuthorityRemoval,
        removedSessions,
      };
    }

    let removedSessions = 0;
    for (const [tokenHash, session] of Object.entries(this.activeRoom.sessions || {})) {
      if (session.accountId !== accountId) continue;
      this.removePresence(session.participantId, nowMs);
      delete this.activeRoom.sessions[tokenHash];
      removedSessions += 1;
    }
    if (member) delete this.activeRoom.accountMembers[accountId];
    const authorityChanged = !!member || removedSessions > 0;
    return {
      changed: tombstoneChanged || authorityChanged,
      authorityChanged,
      ownerAuthorityRemoved: replayedOwnerRemoval,
      removal: replayedOwnerRemoval ? this.activeRoom.ownerAuthorityRemoval : null,
      removedSessions,
    };
  }

  purgeAccountAuthority(accountId: string, nowMs: number) {
    return this.removeAccountAuthority(accountId, nowMs);
  }

  ownerAuthorityDetachResponse(
    removal: OwnerAuthorityRemoval,
    { changed, removedSessions = 0 }: OwnerAuthorityDetachResponseOptions = {},
  ) {
    return jsonResponse({
      ok: true,
      roomCode: this.activeRoom.roomCode,
      roomGeneration: this.activeRoom.roomGeneration,
      status: this.activeRoom.status,
      suspensionReason: this.activeRoom.suspensionReason,
      previousOwnerAccountId: removal.accountId,
      expectedOwnerAuthorityEpoch: removal.ownerAuthorityEpoch - 1,
      ownerAuthorityEpoch: this.activeRoom.ownerAuthorityEpoch,
      ownerAuthorityRemoved: true,
      removalId: removal.removalId,
      removedOwnerAuthorityEpoch: removal.ownerAuthorityEpoch,
      fencedCoordinatorEpoch: removal.fencedCoordinatorEpoch,
      projectionAcked: removal.projectionAcked,
      changed: changed === true,
      removedSessions,
    });
  }

  async handleInternalOwnerAuthorityDetach(request: Request) {
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['accountId', 'expectedOwnerAuthorityEpoch', 'roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      !matchesPattern(parsed.value.accountId, ACCOUNT_ID_RE) ||
      !isSafeNonNegativeInteger(parsed.value.expectedOwnerAuthorityEpoch) ||
      parsed.value.expectedOwnerAuthorityEpoch >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const accountId = parsed.value.accountId;
    if (!this.activeRoom.provisioned) return errorResponse('PRO_ROOM_NOT_FOUND', 404);

    const expectedOwnerAuthorityEpoch = parsed.value.expectedOwnerAuthorityEpoch;
    const existingRemoval = this.activeRoom.ownerAuthorityRemoval;
    const replayedRemoval =
      this.activeRoom.status === 'suspended' &&
      this.activeRoom.suspensionReason === 'ownership_transfer_pending' &&
      this.activeRoom.ownerAccountId === null &&
      existingRemoval?.accountId === accountId &&
      existingRemoval.ownerAuthorityEpoch === expectedOwnerAuthorityEpoch + 1 &&
      this.activeRoom.ownerAuthorityEpoch === existingRemoval.ownerAuthorityEpoch;
    if (replayedRemoval && existingRemoval) {
      return this.ownerAuthorityDetachResponse(existingRemoval, {
        changed: false,
        removedSessions: 0,
      });
    }

    const nowMs = Date.now();
    if (
      (this.activeRoom.pendingOwnershipTransfer?.expiresAtMs || 0) > nowMs ||
      (this.activeRoom.completedOwnershipTransfer?.replayUntilMs || 0) > nowMs
    ) {
      return errorResponse('OWNER_TRANSFER_RECONCILIATION_REQUIRED', 409);
    }
    if (
      !(
        this.activeRoom.status === 'active' ||
        (this.activeRoom.status === 'suspended' &&
          this.activeRoom.suspensionReason === 'operator_suspended')
      ) ||
      this.activeRoom.ownerAccountId !== accountId ||
      !OPAQUE_ID_RE.test(this.activeRoom.ownerMemberId || '') ||
      existingRemoval !== null
    ) {
      return errorResponse('PRO_ROOM_OWNER_DETACH_UNAVAILABLE', 409);
    }
    if (this.activeRoom.ownerAuthorityEpoch !== expectedOwnerAuthorityEpoch) {
      return errorResponse('OWNER_AUTHORITY_EPOCH_MISMATCH', 409);
    }

    const result = this.removeAccountAuthority(accountId, nowMs, {
      retainDeletionTombstone: false,
      suspensionReason: 'ownership_transfer_pending',
    });
    if (!result?.ownerAuthorityRemoved || !result.removal) {
      return errorResponse('PRO_ROOM_OWNER_DETACH_UNAVAILABLE', 409);
    }
    if (result.changed || this.accountIdentityMigrationPending) {
      if (result.authorityChanged) this.activeRoom.revision += 1;
      await this.persist();
      this.accountIdentityMigrationPending = false;
      if (result.authorityChanged) this.scheduleServerEvent(this.presenceEvent());
    }
    return this.ownerAuthorityDetachResponse(result.removal, {
      changed: true,
      removedSessions: result.removedSessions,
    });
  }

  async handleInternalOwnerAuthorityDetachAck(request: Request) {
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, [
        'accountId',
        'expectedOwnerAuthorityEpoch',
        'removalId',
        'removedOwnerAuthorityEpoch',
        'fencedCoordinatorEpoch',
        'roomGeneration',
      ]) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      !matchesPattern(parsed.value.accountId, ACCOUNT_ID_RE) ||
      !isSafeNonNegativeInteger(parsed.value.expectedOwnerAuthorityEpoch) ||
      parsed.value.expectedOwnerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
      !matchesPattern(parsed.value.removalId, OWNER_AUTHORITY_REMOVAL_ID_RE) ||
      !isSafeNonNegativeInteger(parsed.value.removedOwnerAuthorityEpoch) ||
      !isSafeNonNegativeInteger(parsed.value.fencedCoordinatorEpoch)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const removal = this.activeRoom.ownerAuthorityRemoval;
    if (
      this.activeRoom.status !== 'suspended' ||
      this.activeRoom.suspensionReason !== 'ownership_transfer_pending' ||
      this.activeRoom.ownerAccountId !== null ||
      !removal ||
      removal.accountId !== parsed.value.accountId ||
      removal.removalId !== parsed.value.removalId ||
      removal.ownerAuthorityEpoch !== parsed.value.removedOwnerAuthorityEpoch ||
      removal.ownerAuthorityEpoch !== parsed.value.expectedOwnerAuthorityEpoch + 1 ||
      removal.fencedCoordinatorEpoch !== parsed.value.fencedCoordinatorEpoch ||
      this.activeRoom.ownerAuthorityEpoch !== removal.ownerAuthorityEpoch
    ) {
      return errorResponse('OWNER_AUTHORITY_REMOVAL_MISMATCH', 409);
    }
    const changed = removal.projectionAcked !== true;
    if (changed) {
      removal.projectionAcked = true;
      await this.persist();
    }
    return jsonResponse({
      ok: true,
      roomCode: this.activeRoom.roomCode,
      roomGeneration: this.activeRoom.roomGeneration,
      status: this.activeRoom.status,
      suspensionReason: this.activeRoom.suspensionReason,
      previousOwnerAccountId: removal.accountId,
      expectedOwnerAuthorityEpoch: parsed.value.expectedOwnerAuthorityEpoch,
      ownerAuthorityEpoch: this.activeRoom.ownerAuthorityEpoch,
      ownerAuthorityRemoved: true,
      removalId: removal.removalId,
      removedOwnerAuthorityEpoch: removal.ownerAuthorityEpoch,
      fencedCoordinatorEpoch: removal.fencedCoordinatorEpoch,
      projectionAcked: true,
      changed,
    });
  }

  async handleInternalAccountAuthorityPurge(request: Request) {
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['accountId'], ['roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      !matchesPattern(parsed.value.accountId, ACCOUNT_ID_RE)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const result = this.purgeAccountAuthority(parsed.value.accountId, Date.now());
    if ((result?.changed ?? false) || this.accountIdentityMigrationPending) {
      if (result?.authorityChanged) this.activeRoom.revision += 1;
      await this.persist();
      this.accountIdentityMigrationPending = false;
      if (result?.authorityChanged) this.scheduleServerEvent(this.presenceEvent());
    }
    const removal = result?.ownerAuthorityRemoved ? result.removal : null;
    return jsonResponse({
      ok: true,
      roomCode: this.activeRoom.roomCode,
      roomGeneration: this.activeRoom.roomGeneration,
      status: this.activeRoom.status,
      suspensionReason: this.activeRoom.suspensionReason,
      ownerAuthorityRemoved: result?.ownerAuthorityRemoved === true,
      removalId: removal?.removalId || null,
      removedOwnerAuthorityEpoch: removal?.ownerAuthorityEpoch ?? null,
      fencedCoordinatorEpoch: removal?.fencedCoordinatorEpoch ?? null,
      projectionAcked: removal?.projectionAcked ?? true,
      removedSessions: result?.removedSessions || 0,
    });
  }

  async handleInternalAccountAuthorityClassify(request: Request) {
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['accountId'], ['roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      !matchesPattern(parsed.value.accountId, ACCOUNT_ID_RE)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const ownerAuthority =
      this.activeRoom.ownerAccountId === parsed.value.accountId ||
      (this.activeRoom.status === 'suspended' &&
        this.activeRoom.suspensionReason === 'owner_account_deleted' &&
        this.activeRoom.ownerAuthorityRemoval?.accountId === parsed.value.accountId);
    return jsonResponse({
      ok: true,
      roomCode: this.activeRoom.roomCode,
      roomGeneration: this.activeRoom.roomGeneration,
      ownerAuthority,
    });
  }

  async handleInternalAccountAuthorityPurgeAck(request: Request) {
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['accountId', 'removalId', 'removedOwnerAuthorityEpoch', 'fencedCoordinatorEpoch'],
        ['roomGeneration'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      !matchesPattern(parsed.value.accountId, ACCOUNT_ID_RE) ||
      !matchesPattern(parsed.value.removalId, OWNER_AUTHORITY_REMOVAL_ID_RE) ||
      !isSafeNonNegativeInteger(parsed.value.removedOwnerAuthorityEpoch) ||
      !isSafeNonNegativeInteger(parsed.value.fencedCoordinatorEpoch)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const removal = this.activeRoom.ownerAuthorityRemoval;
    if (
      this.activeRoom.status !== 'suspended' ||
      this.activeRoom.suspensionReason !== 'owner_account_deleted' ||
      !removal ||
      removal.accountId !== parsed.value.accountId ||
      removal.removalId !== parsed.value.removalId ||
      removal.ownerAuthorityEpoch !== parsed.value.removedOwnerAuthorityEpoch ||
      removal.fencedCoordinatorEpoch !== parsed.value.fencedCoordinatorEpoch
    ) {
      return errorResponse('OWNER_AUTHORITY_REMOVAL_MISMATCH', 409);
    }
    const changed = removal.projectionAcked !== true;
    if (changed) {
      removal.projectionAcked = true;
      await this.persist();
    }
    return jsonResponse({
      ok: true,
      roomCode: this.activeRoom.roomCode,
      roomGeneration: this.activeRoom.roomGeneration,
      status: this.activeRoom.status,
      suspensionReason: this.activeRoom.suspensionReason,
      ownerAuthorityRemoved: true,
      removalId: removal.removalId,
      removedOwnerAuthorityEpoch: removal.ownerAuthorityEpoch,
      fencedCoordinatorEpoch: removal.fencedCoordinatorEpoch,
      projectionAcked: true,
      changed,
    });
  }

  async createSessionRecord(
    role: ProRoomRole,
    displayName: string,
    nowMs: number,
    memberId: string | null = null,
    accountMember: (AccountMember & { accountId: string }) | null = null,
    credentialContext: string | null = null,
  ): Promise<{ token: string; tokenHash: string; session: RoomSession } | null> {
    const secret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (secret.length < 32) return null;
    const sessions = Object.entries(this.activeRoom.sessions);
    if (sessions.length >= SESSION_MAX_ITEMS) {
      const presentSessionHashes = new Set(
        Object.values(this.activeRoom.presence.participants).map(
          (participant) => participant.sessionHash,
        ),
      );
      const evictable = sessions
        .filter(([tokenHash]) => !presentSessionHashes.has(tokenHash))
        .sort(
          ([, left], [, right]) =>
            Number(left.role === 'owner') - Number(right.role === 'owner') ||
            left.createdAtMs - right.createdAtMs,
        )[0];
      if (!evictable) return null;
      this.removeSessionRecord(evictable[0]);
    }
    // Anonymous non-owner identities are always allocated by the server.
    // Account nicknames and the persisted owner identity remain authoritative
    // for their respective sessions.
    const peerOrdinal =
      role === 'owner'
        ? null
        : this.nextPhysicalDeviceOrdinal(accountMember?.displayNumber ?? null);
    if (role !== 'owner' && peerOrdinal === null) return null;
    const resolvedDisplayName =
      !accountMember && role !== 'owner' && peerOrdinal !== null
        ? `${DEFAULT_PEER_DISPLAY_NAME} ${peerOrdinal}`
        : displayName;
    const memberDisplayNumber =
      accountMember?.displayNumber ?? (role === 'owner' ? 0 : peerOrdinal);
    if (!isSafeInteger(memberDisplayNumber)) return null;
    const highestAssignedNumber = Math.max(memberDisplayNumber, peerOrdinal || 0);
    if (highestAssignedNumber > 0) {
      this.activeRoom.nextMemberDisplayNumber = Math.min(
        SESSION_MAX_ITEMS + 1,
        Math.max(this.activeRoom.nextMemberDisplayNumber || 1, highestAssignedNumber + 1),
      );
    }
    const token = credentialContext
      ? await createDeterministicOpaqueCredential(secret, credentialContext)
      : await createOpaqueCredential(secret);
    const tokenHash = await sha256Base64Url(token);
    const session: RoomSession = {
      roomGeneration: this.activeRoom.roomGeneration,
      memberId:
        memberId || (role === 'owner' ? `owner_${randomToken(18)}` : `member_${randomToken(18)}`),
      participantId: `participant_${randomToken(18)}`,
      presenceIncarnationId: null,
      signalingTicketSequence: 0,
      displayName: resolvedDisplayName,
      ...(peerOrdinal === null ? {} : { peerOrdinal }),
      memberDisplayNumber,
      ...(accountMember ? { accountId: accountMember.accountId } : {}),
      ...(accountMember
        ? { accountLeaseExpiresAtMs: this.accountIdentityLeaseExpiresAt(nowMs) }
        : {}),
      role,
      authEpoch: this.activeRoom.authEpoch,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.sessionTtlSeconds() * 1000,
    };
    this.activeRoom.sessions[tokenHash] = session;
    return { token, tokenHash, session };
  }

  peerOrdinalAssignments() {
    const candidates = Object.entries(this.activeRoom.sessions)
      .filter(([, session]) => {
        return (
          isGeneratedPeerNamespaceDisplayName(session.displayName) ||
          (isSafeInteger(session.peerOrdinal) &&
            session.peerOrdinal >= 1 &&
            session.peerOrdinal <= SESSION_MAX_ITEMS)
        );
      })
      .sort(
        ([leftHash, left], [rightHash, right]) =>
          left.createdAtMs - right.createdAtMs ||
          left.participantId.localeCompare(right.participantId) ||
          leftHash.localeCompare(rightHash),
      );
    const assigned = new Map<RoomSession, number>();
    const used = new Set<number>();

    // Preserve every valid durable assignment first. Exact legacy `Peer N`
    // labels are also treated as reservations so a rolling deploy cannot hand
    // the same visible identity to a new session.
    for (const [, session] of candidates) {
      const preferred =
        isSafeInteger(session.peerOrdinal) &&
        session.peerOrdinal >= 1 &&
        session.peerOrdinal <= SESSION_MAX_ITEMS
          ? session.peerOrdinal
          : generatedPeerOrdinal(session.displayName);
      if (preferred === null || used.has(preferred)) continue;
      assigned.set(session, preferred);
      used.add(preferred);
    }

    // Old sessions only stored the generic `Peer` placeholder. Give those
    // sessions deterministic slots without making a browser the allocator.
    for (const [, session] of candidates) {
      if (assigned.has(session)) continue;
      let ordinal = 1;
      while (ordinal <= SESSION_MAX_ITEMS && used.has(ordinal)) ordinal += 1;
      if (ordinal > SESSION_MAX_ITEMS) continue;
      assigned.set(session, ordinal);
      used.add(ordinal);
    }
    return assigned;
  }

  nextPhysicalDeviceOrdinal(preferred: number | null = null) {
    const used = new Set(this.peerOrdinalAssignments().values());
    if (
      isSafeInteger(preferred) &&
      preferred >= 1 &&
      preferred <= SESSION_MAX_ITEMS &&
      !used.has(preferred)
    ) {
      return preferred;
    }
    const reserved = this.usedMemberDisplayNumbers();
    for (let ordinal = 1; ordinal <= SESSION_MAX_ITEMS; ordinal += 1) {
      if (!used.has(ordinal) && !reserved.has(ordinal)) return ordinal;
    }
    return null;
  }

  ensureSessionPeerIdentity(session: RoomSession) {
    const participant = this.activeRoom.presence.participants[session.participantId];
    if (!participant) {
      return { ordinal: null, stateChanged: false, publicChanged: false };
    }
    if (session.role === 'owner') {
      return { ordinal: null, stateChanged: false, publicChanged: false };
    }

    const liveUsed = this.livePhysicalDeviceOrdinals(session);
    const preferred = session.peerOrdinal;
    const ordinal =
      isSafeInteger(preferred) &&
      preferred >= 1 &&
      preferred <= SESSION_MAX_ITEMS &&
      !liveUsed.has(preferred)
        ? preferred
        : this.nextLivePhysicalDeviceOrdinal(session);
    if (ordinal === null) {
      return { ordinal: null, stateChanged: false, publicChanged: false };
    }

    let stateChanged = session.peerOrdinal !== ordinal;
    session.peerOrdinal = ordinal;
    const sameMember = Object.values(this.activeRoom.presence.participants || {}).find(
      (candidate) =>
        candidate.participantId !== session.participantId &&
        candidate.memberId === session.memberId,
    );
    const groupDisplayNumber =
      sameMember &&
      isSafeInteger(sameMember.memberDisplayNumber) &&
      sameMember.memberDisplayNumber > 0
        ? sameMember.memberDisplayNumber
        : ordinal;
    if (session.memberDisplayNumber !== groupDisplayNumber) stateChanged = true;
    session.memberDisplayNumber = groupDisplayNumber;
    if (session.accountId) {
      const member = this.activeRoom.accountMembers?.[session.accountId];
      if (member && member.memberId === session.memberId) {
        if (member.displayNumber !== groupDisplayNumber) stateChanged = true;
        member.displayNumber = groupDisplayNumber;
      }
    } else {
      const administrator = this.activeRoom.anonymousAdministrators?.[session.memberId];
      if (administrator) {
        if (administrator.displayNumber !== groupDisplayNumber) stateChanged = true;
        administrator.displayNumber = groupDisplayNumber;
      }
    }
    const canonicalDisplayName = `${DEFAULT_PEER_DISPLAY_NAME} ${ordinal}`;
    if (!session.accountId) {
      if (session.displayName !== canonicalDisplayName) stateChanged = true;
      session.displayName = canonicalDisplayName;
      const administrator = this.activeRoom.anonymousAdministrators?.[session.memberId];
      if (administrator && administrator.displayName !== canonicalDisplayName) {
        administrator.displayName = canonicalDisplayName;
        stateChanged = true;
      }
    }

    const publicChanged =
      !!participant &&
      (participant.displayName !== session.displayName ||
        participant.memberDisplayNumber !== groupDisplayNumber);
    if (publicChanged) {
      participant.displayName = session.displayName;
      participant.memberDisplayNumber = groupDisplayNumber;
    }
    return { ordinal, stateChanged, publicChanged };
  }

  async createOwnerCredential() {
    const secret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (secret.length < 32) return null;
    const token = await createOpaqueCredential(secret);
    return { token, hash: await sha256Base64Url(token) };
  }

  async hasOwnerCredential(request: Request) {
    const token = requestOwnerToken(request, this.activeRoom.roomCode);
    const secret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (!(await verifyOpaqueCredential(token, secret))) return false;
    const hash = await sha256Base64Url(token);
    return constantTimeEqual(hash, this.activeRoom.ownerCredentialHash || '');
  }

  async authenticate(request: Request): Promise<AuthenticatedSession | null> {
    const token = requestSessionToken(request, this.activeRoom.roomCode);
    const secret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (!token || secret.length < 32) return null;
    if (!(await verifyOpaqueCredential(token, secret))) return null;
    const tokenHash = await sha256Base64Url(token);
    const session = this.activeRoom.sessions[tokenHash];
    if (
      !session ||
      session.expiresAtMs <= Date.now() ||
      session.authEpoch !== this.activeRoom.authEpoch ||
      session.roomGeneration !== this.activeRoom.roomGeneration
    ) {
      if (session) this.removeSessionRecord(tokenHash);
      return null;
    }
    return { tokenHash, session };
  }

  async requireSession(
    request: Request,
    options: RequireSessionOptions & { activePresence: true },
  ): Promise<ActivePresenceRequirementResult>;
  async requireSession(
    request: Request,
    options?: RequireSessionOptions,
  ): Promise<SessionRequirementResult>;
  async requireSession(
    request: Request,
    options: RequireSessionOptions = {},
  ): Promise<SessionRequirementResult> {
    const auth = await this.authenticate(request);
    if (!auth) return { response: errorResponse('SESSION_REQUIRED', 401) };
    if (this.activeRoom.status === 'suspended')
      return { response: errorResponse('ROOM_SUSPENDED', 423) };
    if (options.owner && auth.session.role !== 'owner')
      return { response: errorResponse('OWNER_REQUIRED', 403) };
    const requiredCapabilities = Array.isArray(options.capabilities)
      ? options.capabilities
      : options.capability
        ? [options.capability]
        : [];
    if (
      requiredCapabilities.some(
        (capability) => !sessionCapabilities(this.activeRoom, auth.session).includes(capability),
      )
    ) {
      return { response: errorResponse('CAPABILITY_REQUIRED', 403) };
    }
    if (options.permission && !this.sessionHasPermission(auth.session, options.permission)) {
      return { response: errorResponse('PERMISSION_REQUIRED', 403) };
    }
    if (options.activePresence) {
      const expectedParticipantId = request.headers.get('x-mxqr-pro-participant-id') || '';
      const expectedPresenceIncarnationId =
        request.headers.get('x-mxqr-pro-presence-incarnation') || '';
      const participant = this.activeRoom.presence.participants[auth.session.participantId];
      if (
        !OPAQUE_ID_RE.test(expectedParticipantId) ||
        !OPAQUE_ID_RE.test(expectedPresenceIncarnationId) ||
        auth.session.participantId !== expectedParticipantId ||
        auth.session.presenceIncarnationId !== expectedPresenceIncarnationId ||
        !participant ||
        participant.sessionHash !== auth.tokenHash ||
        participant.participantId !== expectedParticipantId ||
        participant.presenceIncarnationId !== expectedPresenceIncarnationId
      ) {
        return { response: errorResponse('PRESENCE_SUPERSEDED', 409) };
      }
      auth.participant = participant;
    }
    return auth;
  }

  sessionHasPermission(session: RoomSession, permission: ProRoomPermission) {
    if (session.role === 'owner') return true;
    return sessionPermissionSet(this.activeRoom, session)[permission] === true;
  }

  async handleGetEffects(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (request.body && (request.headers.get('content-length') || '') !== '0') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const contractVersion = effectsContractVersion(request);
    return contractVersion === null
      ? errorResponse('INVALID_REQUEST', 400)
      : jsonResponse(publicEffects(this.activeRoom));
  }

  async handleUpdateEffects(request: Request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'playback.control',
    });
    if (auth.response) return auth.response;
    if (auth.session.role !== 'owner') {
      return errorResponse('OWNER_REQUIRED', 403);
    }
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['coordinatorEpoch', 'baseRevision', 'effects'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const contractVersion = effectsContractVersion(request);
    const effects = contractVersion === 2 ? parseRoomEffects(parsed.value.effects) : null;
    if (
      !isSafeNonNegativeInteger(parsed.value.coordinatorEpoch) ||
      !isSafeNonNegativeInteger(parsed.value.baseRevision) ||
      !effects
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (this.activeRoom.presence.coordinatorEpoch !== parsed.value.coordinatorEpoch) {
      return errorResponse('ROOM_EPOCH_MISMATCH', 409);
    }
    if (parsed.value.baseRevision !== this.activeRoom.effects.revision) {
      return jsonResponse(
        {
          error: 'EFFECTS_REVISION_CONFLICT',
          effects: publicEffects(this.activeRoom),
        },
        409,
      );
    }
    if (JSON.stringify(effects) === JSON.stringify(this.activeRoom.effects.effects)) {
      return jsonResponse(publicEffects(this.activeRoom));
    }
    if (
      this.activeRoom.effects.revision >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.revision >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    this.activeRoom.effects = {
      revision: this.activeRoom.effects.revision + 1,
      updatedAtMs: Date.now(),
      masterVolume: this.activeRoom.effects.masterVolume ?? 1,
      effects,
    };
    // room.revision is the heartbeat's aggregate change detector. Keep it in
    // the same persisted mutation as the dedicated effects revision so a peer
    // that misses the invalidation event cannot receive a false notModified.
    this.activeRoom.revision += 1;
    await this.persist();
    await this.broadcastServerEvent(
      this.invalidationEvent({ effectsRevision: this.activeRoom.effects.revision }),
    );
    return jsonResponse(publicEffects(this.activeRoom));
  }

  async handleGetSettingsSync(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (request.body && (request.headers.get('content-length') || '') !== '0') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    return jsonResponse(publicSettingsSync(this.activeRoom));
  }

  async handleUpdateSettingsSync(request: Request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'effects.control',
    });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['coordinatorEpoch', 'baseRevision', 'masterVolume', 'effects'])
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    const effects = parseRoomEffects(parsed.value.effects);
    if (
      !isSafeNonNegativeInteger(parsed.value.coordinatorEpoch) ||
      !isSafeNonNegativeInteger(parsed.value.baseRevision) ||
      typeof parsed.value.masterVolume !== 'number' ||
      !Number.isFinite(parsed.value.masterVolume) ||
      parsed.value.masterVolume < 0 ||
      parsed.value.masterVolume > 1 ||
      !effects
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (this.activeRoom.presence.coordinatorEpoch !== parsed.value.coordinatorEpoch) {
      return errorResponse('ROOM_EPOCH_MISMATCH', 409);
    }
    if (parsed.value.baseRevision !== this.activeRoom.effects.revision) {
      return jsonResponse(
        {
          error: 'SETTINGS_SYNC_REVISION_CONFLICT',
          settings: publicSettingsSync(this.activeRoom),
        },
        409,
      );
    }
    if (
      parsed.value.masterVolume === (this.activeRoom.effects.masterVolume ?? 1) &&
      JSON.stringify(effects) === JSON.stringify(this.activeRoom.effects.effects)
    ) {
      return jsonResponse(publicSettingsSync(this.activeRoom));
    }
    if (
      this.activeRoom.effects.revision >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.revision >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    this.activeRoom.effects = {
      revision: this.activeRoom.effects.revision + 1,
      updatedAtMs: Date.now(),
      masterVolume: parsed.value.masterVolume,
      effects,
    };
    this.activeRoom.revision += 1;
    await this.persist();
    await this.broadcastServerEvent(
      this.invalidationEvent({ effectsRevision: this.activeRoom.effects.revision }),
    );
    return jsonResponse(publicSettingsSync(this.activeRoom));
  }

  async handleGetQueueMode(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (request.body && (request.headers.get('content-length') || '') !== '0') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    return jsonResponse(publicQueueMode(this.activeRoom));
  }

  async handleUpdateQueueMode(request: Request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'queue.mutate',
    });
    if (auth.response) return auth.response;
    // Repeat and shuffle are queue policy, so they follow media management
    // rather than playback control. queue.mutate is server-projected only for
    // the owner or a controller with the stable `media.add` permission.
    const parsed = await this.parseBody(request, 128 * 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, [
        'coordinatorEpoch',
        'baseRevision',
        'playlistRevision',
        'repeatMode',
        'shuffleEnabled',
        'shuffleOrder',
      ]) ||
      !isSafeNonNegativeInteger(parsed.value.coordinatorEpoch) ||
      !isSafeNonNegativeInteger(parsed.value.baseRevision) ||
      !isSafeNonNegativeInteger(parsed.value.playlistRevision)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (this.activeRoom.presence.coordinatorEpoch !== parsed.value.coordinatorEpoch) {
      return errorResponse('ROOM_EPOCH_MISMATCH', 409);
    }
    if (parsed.value.playlistRevision !== this.activeRoom.playlistRevision) {
      return jsonResponse(
        { error: 'PLAYLIST_REVISION_CONFLICT', queueMode: publicQueueMode(this.activeRoom) },
        409,
      );
    }
    if (parsed.value.baseRevision !== this.activeRoom.queueMode.revision) {
      return jsonResponse(
        { error: 'QUEUE_MODE_REVISION_CONFLICT', queueMode: publicQueueMode(this.activeRoom) },
        409,
      );
    }
    const queueMode = parseQueueModeValues(
      {
        repeatMode: parsed.value.repeatMode,
        shuffleEnabled: parsed.value.shuffleEnabled,
        shuffleOrder: parsed.value.shuffleOrder,
      },
      this.activeRoom.playlist,
    );
    if (!queueMode) return errorResponse('INVALID_QUEUE_MODE', 400);
    if (
      queueMode.repeatMode === this.activeRoom.queueMode.repeatMode &&
      queueMode.shuffleEnabled === this.activeRoom.queueMode.shuffleEnabled &&
      queueMode.shuffleOrder.length === this.activeRoom.queueMode.shuffleOrder.length &&
      queueMode.shuffleOrder.every(
        (queueItemId, index) => queueItemId === this.activeRoom.queueMode.shuffleOrder[index],
      )
    ) {
      return jsonResponse(publicQueueMode(this.activeRoom));
    }
    if (
      this.activeRoom.queueMode.revision >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.revision >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    this.activeRoom.queueMode = {
      revision: this.activeRoom.queueMode.revision + 1,
      updatedAtMs: Date.now(),
      ...queueMode,
    };
    // See handleUpdateEffects(): queue-mode invalidation is best-effort, while
    // the aggregate room revision is the durable heartbeat recovery fence.
    this.activeRoom.revision += 1;
    await this.persist();
    await this.broadcastServerEvent(
      this.invalidationEvent({ queueModeRevision: this.activeRoom.queueMode.revision }),
    );
    return jsonResponse(publicQueueMode(this.activeRoom));
  }

  systemAudioResponse(extra = {}) {
    return jsonResponse({ systemAudio: publicSystemAudio(this.activeRoom.systemAudio), ...extra });
  }

  isSystemAudioOwner(auth: AuthenticatedSession) {
    const state = this.activeRoom.systemAudio;
    return (
      state.status !== 'idle' &&
      state.ownerParticipantId === auth.session.participantId &&
      state.ownerPresenceIncarnationId === auth.participant?.presenceIncarnationId
    );
  }

  clearSystemAudioLease() {
    const currentGeneration = isSafeNonNegativeInteger(this.activeRoom.systemAudio?.generation)
      ? this.activeRoom.systemAudio.generation
      : 0;
    const nextGeneration =
      currentGeneration < Number.MAX_SAFE_INTEGER ? currentGeneration + 1 : currentGeneration;
    this.activeRoom.systemAudio = initialSystemAudioState(nextGeneration);
    return true;
  }

  reconcileSystemAudio(nowMs: number) {
    const state = this.activeRoom.systemAudio;
    if (!state || state.status === 'idle') return false;
    const owner = state.ownerParticipantId
      ? this.activeRoom.presence.participants[state.ownerParticipantId]
      : undefined;
    const ownerMissingOrSuperseded =
      !owner || owner.presenceIncarnationId !== state.ownerPresenceIncarnationId;
    const overDeviceLimit =
      Object.keys(this.activeRoom.presence.participants).length > SYSTEM_AUDIO_MAX_PRESENCE_ITEMS;
    const expired =
      (state.status === 'preparing' &&
        (!isSafeInteger(state.claimExpiresAt) || state.claimExpiresAt <= nowMs)) ||
      (state.status === 'live' &&
        (!isSafeInteger(state.liveExpiresAt) || state.liveExpiresAt <= nowMs));
    if (!ownerMissingOrSuperseded && !overDeviceLimit && !expired) return false;
    return this.clearSystemAudioLease();
  }

  validateSystemAudioLease(auth: AuthenticatedSession, generation: number, leaseId: string) {
    if (!isSafeNonNegativeInteger(generation) || !SYSTEM_AUDIO_LEASE_ID_RE.test(leaseId || '')) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (generation !== this.activeRoom.systemAudio.generation) {
      return errorResponse('SYSTEM_AUDIO_GENERATION_MISMATCH', 409);
    }
    if (!this.isSystemAudioOwner(auth)) {
      return errorResponse('SYSTEM_AUDIO_NOT_OWNER', 409);
    }
    if (!constantTimeEqual(leaseId, this.activeRoom.systemAudio.leaseId || '')) {
      return errorResponse('SYSTEM_AUDIO_LEASE_INVALID', 409);
    }
    return null;
  }

  async handleGetSystemAudio(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (request.body && (request.headers.get('content-length') || '') !== '0') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    return this.systemAudioResponse();
  }

  async handleAcquireSystemAudio(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    // Live capture is deliberately outside the four delegated administrator
    // toggles, so the cost-bearing publisher lease stays with the room owner.
    if (auth.session.role !== 'owner') {
      return errorResponse('OWNER_REQUIRED', 403);
    }
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, [])) return errorResponse('INVALID_REQUEST', 400);
    if (
      Object.keys(this.activeRoom.presence.participants).length > SYSTEM_AUDIO_MAX_PRESENCE_ITEMS
    ) {
      return errorResponse('SYSTEM_AUDIO_DEVICE_LIMIT', 409);
    }

    if (this.activeRoom.systemAudio.status !== 'idle') {
      if (!this.isSystemAudioOwner(auth)) {
        return errorResponse('SYSTEM_AUDIO_OWNER_ACTIVE', 409);
      }
      auth.participant.lastSeenAtMs = Date.now();
      await this.persist();
      return this.systemAudioResponse({ leaseId: this.activeRoom.systemAudio.leaseId });
    }
    if (this.activeRoom.systemAudio.generation >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('SYSTEM_AUDIO_GENERATION_EXHAUSTED', 409);
    }

    const nowMs = Date.now();
    this.activeRoom.systemAudio = {
      generation: this.activeRoom.systemAudio.generation + 1,
      status: 'preparing',
      ownerParticipantId: auth.session.participantId,
      ownerPresenceIncarnationId: auth.participant.presenceIncarnationId,
      leaseId: randomToken(32),
      claimExpiresAt: nowMs + SYSTEM_AUDIO_CLAIM_TTL_MS,
      liveExpiresAt: null,
      publication: null,
    };
    auth.participant.lastSeenAtMs = nowMs;
    await this.persist();
    await this.broadcastServerEvent(
      this.invalidationEvent({ systemAudioGeneration: this.activeRoom.systemAudio.generation }),
    );
    return this.systemAudioResponse({ leaseId: this.activeRoom.systemAudio.leaseId });
  }

  async handleCommitSystemAudio(request: Request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'playback.control',
    });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['generation', 'leaseId', 'publication']) ||
      !isSafeNonNegativeInteger(parsed.value.generation) ||
      !matchesPattern(parsed.value.leaseId, SYSTEM_AUDIO_LEASE_ID_RE)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const publication = parseSystemAudioPublication(parsed.value.publication);
    if (!publication) return errorResponse('INVALID_REQUEST', 400);
    const leaseError = this.validateSystemAudioLease(
      auth,
      parsed.value.generation,
      parsed.value.leaseId,
    );
    if (leaseError) return leaseError;

    if (this.activeRoom.systemAudio.status === 'live') {
      if (JSON.stringify(this.activeRoom.systemAudio.publication) !== JSON.stringify(publication)) {
        return errorResponse('SYSTEM_AUDIO_ALREADY_COMMITTED', 409);
      }
      return this.systemAudioResponse();
    }
    if (this.activeRoom.systemAudio.status !== 'preparing') {
      return errorResponse('SYSTEM_AUDIO_INVALID_TRANSITION', 409);
    }

    const nowMs = Date.now();
    this.activeRoom.systemAudio.status = 'live';
    this.activeRoom.systemAudio.claimExpiresAt = null;
    this.activeRoom.systemAudio.liveExpiresAt = nowMs + SYSTEM_AUDIO_LIVE_TTL_MS;
    this.activeRoom.systemAudio.publication = publication;
    auth.participant.lastSeenAtMs = nowMs;
    await this.persist();
    await this.broadcastServerEvent(
      this.invalidationEvent({ systemAudioGeneration: this.activeRoom.systemAudio.generation }),
    );
    return this.systemAudioResponse();
  }

  async handleHeartbeatSystemAudio(request: Request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'playback.control',
    });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['generation', 'leaseId']) ||
      !isSafeNonNegativeInteger(parsed.value.generation) ||
      !matchesPattern(parsed.value.leaseId, SYSTEM_AUDIO_LEASE_ID_RE)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const leaseError = this.validateSystemAudioLease(
      auth,
      parsed.value.generation,
      parsed.value.leaseId,
    );
    if (leaseError) return leaseError;
    auth.participant.lastSeenAtMs = Date.now();
    await this.persist();
    return this.systemAudioResponse();
  }

  async handleReleaseSystemAudio(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['generation', 'leaseId']) ||
      !isSafeNonNegativeInteger(parsed.value.generation) ||
      !matchesPattern(parsed.value.leaseId, SYSTEM_AUDIO_LEASE_ID_RE)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const leaseError = this.validateSystemAudioLease(
      auth,
      parsed.value.generation,
      parsed.value.leaseId,
    );
    if (leaseError) return leaseError;
    this.clearSystemAudioLease();
    await this.persist();
    await this.broadcastServerEvent(
      this.invalidationEvent({ systemAudioGeneration: this.activeRoom.systemAudio.generation }),
    );
    return this.systemAudioResponse();
  }

  joinPresence(session: RoomSession, tokenHash: string, nowMs: number, devicePlatform = 'other') {
    const existing = this.activeRoom.presence.participants[session.participantId];
    if (existing) {
      existing.lastSeenAtMs = nowMs;
      existing.devicePlatform = devicePlatform;
      session.presenceIncarnationId = existing.presenceIncarnationId;
      return false;
    }
    if (Object.keys(this.activeRoom.presence.participants).length >= PRESENCE_MAX_ITEMS)
      return null;
    if (!this.assignSessionPresenceIdentity(session)) return null;
    const wasSleeping = this.activeRoom.runtime === 'sleeping';
    const presenceIncarnationId = `presence_${randomToken(18)}`;
    session.presenceIncarnationId = presenceIncarnationId;
    this.activeRoom.presence.participants[session.participantId] = {
      participantId: session.participantId,
      presenceIncarnationId,
      memberId: session.memberId,
      ...(session.accountId ? { accountId: session.accountId } : {}),
      ...(Number.isSafeInteger(session.memberDisplayNumber)
        ? { memberDisplayNumber: session.memberDisplayNumber }
        : {}),
      sessionHash: tokenHash,
      displayName: session.displayName,
      devicePlatform,
      role: session.role,
      joinedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      developerControlVersion: 0,
    };
    this.activeRoom.runtime = 'awake';
    this.activeRoom.presence.revision += 1;
    this.activeRoom.presence.coordinatorParticipantId = null;
    if (wasSleeping) {
      this.bumpRoomEpoch(nowMs);
      if (this.activeRoom.playback.state === 'playing' && this.activeRoom.playback.queueItemId) {
        // Sleeping rooms retain the intent to resume but their timeline is
        // frozen. Anchor the old checkpoint at wake and rendezvous the first
        // participant from that exact position; never charge the time spent
        // asleep (or preparing) as audible playback.
        this.activeRoom.playback.updatedAtMs = nowMs;
        const mediaIdentity: PlaybackMediaIdentity | null =
          this.activeRoom.playback.youtubeVideoId === null ||
          this.activeRoom.playback.youtubeSubIndex === null
            ? null
            : {
                youtubeVideoId: this.activeRoom.playback.youtubeVideoId,
                youtubeSubIndex: this.activeRoom.playback.youtubeSubIndex,
              };
        const target = this.targetPlayback(
          this.activeRoom.playback.queueItemId,
          'playing',
          this.activeRoom.playback.positionSeconds,
          nowMs,
          mediaIdentity,
        );
        if (target) {
          const wakeTransition = this.preparePlaybackTransition(target, nowMs, null, {
            resumeFromSleep: true,
            timingMode: 'scheduled-control',
          });
          if (wakeTransition.cancelEvent) this.scheduleServerEvent(wakeTransition.cancelEvent);
          if (wakeTransition.event) {
            this.scheduleServerEvent(wakeTransition.event, wakeTransition.targets);
          }
        }
      }
    }
    // A member arriving during an existing PREPARE receives it in the
    // signaling ticket and can arm locally, but the gate's cohort is immutable.
    // Only takeover rotates an existing cohort identity; leave can shrink it.
    this.reconcileSystemAudio(nowMs);
    this.activeRoom.revision += 1;
    this.scheduleServerEvent(this.presenceEvent());
    return true;
  }

  enterPresence(
    session: RoomSession,
    tokenHash: string,
    nowMs: number,
    takeover = false,
    devicePlatform = 'other',
  ) {
    const existing = this.activeRoom.presence.participants[session.participantId];
    if (!existing) {
      return this.joinPresence(session, tokenHash, nowMs, devicePlatform) === null
        ? 'room-full'
        : 'entered';
    }
    if (existing.sessionHash !== tokenHash) return 'identity-mismatch';

    // A room cookie is shared by every tab in the same browser profile. Do
    // not let an ordinary resume silently rotate the live tab's incarnation:
    // doing so repeatedly replaces the authenticated signaling socket and can
    // make control-channel recovery unstable. A takeover is therefore an
    // explicit, user-confirmed operation.
    if (!takeover) return 'active-elsewhere';

    // A resumed tab is a new presence incarnation even though its long-lived
    // HttpOnly session and participant identity are intentionally reused.
    // Rotating this nonce fences every request and WebSocket captured by the
    // prior tab without changing room-wide authority for every other peer.
    const previousPresenceIncarnationId = existing.presenceIncarnationId;
    const presenceIncarnationId = `presence_${randomToken(18)}`;
    session.presenceIncarnationId = presenceIncarnationId;
    existing.presenceIncarnationId = presenceIncarnationId;
    existing.developerControlVersion = 0;
    existing.joinedAtMs = nowMs;
    existing.lastSeenAtMs = nowMs;
    existing.devicePlatform = devicePlatform;
    const pending = this.activeRoom.pendingPlaybackTransition;
    if (pending?.cohort.includes(previousPresenceIncarnationId)) {
      pending.cohort = pending.cohort.map((candidate) =>
        candidate === previousPresenceIncarnationId ? presenceIncarnationId : candidate,
      );
      pending.cohort.sort();
      delete pending.ready[previousPresenceIncarnationId];
    }
    this.reconcileSystemAudio(nowMs);
    this.activeRoom.presence.revision += 1;
    this.activeRoom.revision += 1;
    this.scheduleServerEvent(this.presenceEvent());
    return 'entered';
  }

  bumpRoomEpoch(nowMs: number) {
    this.cancelPendingPlayback('room-epoch-changed', nowMs);
    // Signaling closes old-epoch sockets when the authoritative presence fence
    // advances. Neither their CANCEL nor any older playback event may cross the
    // new epoch.
    this.activeRoom.pendingPlaybackBroadcasts = [];
    this.activeRoom.presence.coordinatorEpoch += 1;
    this.activeRoom.playback.coordinatorEpoch = this.activeRoom.presence.coordinatorEpoch;
    this.activeRoom.playback.revision += 1;
  }

  freezePlayback(nowMs: number) {
    if (this.activeRoom.playback.state === 'playing' && this.activeRoom.playback.updatedAtMs > 0) {
      this.activeRoom.playback.positionSeconds = Math.min(
        PLAYBACK_MAX_POSITION_SECONDS,
        this.activeRoom.playback.positionSeconds +
          Math.max(0, (nowMs - this.activeRoom.playback.updatedAtMs) / 1000),
      );
      this.activeRoom.playback.updatedAtMs = nowMs;
      this.activeRoom.playback.revision += 1;
    }
  }

  realtimePresenceTargets() {
    return Object.values(this.activeRoom.presence.participants)
      .map((participant) => participant.presenceIncarnationId)
      .filter((incarnationId) => OPAQUE_ID_RE.test(incarnationId || ''))
      .sort();
  }

  async broadcastServerEvent(
    event: JsonRecord,
    targets: string[] = this.realtimePresenceTargets(),
    coordinatorEpoch = this.activeRoom.presence.coordinatorEpoch,
  ) {
    const namespace = this.env.PRO_SIGNALING_ROOMS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    try {
      const stub = namespace.get(
        namespace.idFromName(
          proRoomObjectName(this.activeRoom.roomCode, this.activeRoom.roomGeneration),
        ),
      );
      const { response, bytes } = await fetchWithDeadline(
        (boundedRequest) => stub.fetch(boundedRequest),
        new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': this.activeRoom.roomCode,
            ...proRoomGenerationWireHeaders(this.activeRoom.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.activeRoom.roomCode,
            ...proRoomGenerationWireFields(this.activeRoom.roomGeneration),
            coordinatorEpoch,
            targets,
            event,
          }),
        }),
        DEVELOPER_COMMAND_DISPATCH_TIMEOUT_MS,
      );
      return response.status === 200 && parseInternalJsonResponse(bytes) !== null;
    } catch {
      return false;
    }
  }

  playbackBroadcastRetryDelayMs(attempts: number) {
    return Math.min(
      PLAYBACK_BROADCAST_RETRY_MAX_MS,
      PLAYBACK_BROADCAST_RETRY_BASE_MS * 2 ** Math.min(attempts, 6),
    );
  }

  playbackBroadcastRecord(
    event: JsonRecord,
    targets: string[],
    nowMs = Date.now(),
    options: PlaybackBroadcastOptions = {},
  ) {
    const normalizedTargets = [...new Set(targets || [])]
      .filter((target) => OPAQUE_ID_RE.test(target || ''))
      .sort();
    if (normalizedTargets.length === 0 || normalizedTargets.length > PRESENCE_MAX_ITEMS)
      return null;

    let kind: PlaybackBroadcastRecord['kind'];
    let coordinatorEpoch: unknown;
    let transitionId: unknown;
    let basePlaybackRevision: unknown;
    let playbackRevision: unknown;
    if (event?.type === 'pro-playback-prepare') {
      const target = isRecord(event.target) ? event.target : null;
      kind = 'prepare';
      coordinatorEpoch = target?.coordinatorEpoch;
      transitionId = event.transitionId;
      basePlaybackRevision = event.basePlaybackRevision;
      playbackRevision = target?.revision;
    } else if (event?.type === 'pro-playback-cancel') {
      kind = 'cancel';
      coordinatorEpoch = this.activeRoom.presence.coordinatorEpoch;
      transitionId = event.transitionId;
      const cancelBasePlaybackRevision =
        options.basePlaybackRevision === undefined
          ? this.activeRoom.playback.revision
          : options.basePlaybackRevision;
      basePlaybackRevision = cancelBasePlaybackRevision;
      playbackRevision = cancelBasePlaybackRevision + 1;
    } else if (event?.type === 'pro-playback-commit') {
      const playback = isRecord(event.playback) ? event.playback : null;
      kind = 'commit';
      coordinatorEpoch = playback?.coordinatorEpoch;
      transitionId = event.transitionId;
      playbackRevision = playback?.revision;
      basePlaybackRevision = isSafeNonNegativeInteger(playbackRevision)
        ? playbackRevision - 1
        : undefined;
    } else {
      return null;
    }
    const candidate = {
      kind,
      coordinatorEpoch,
      transitionId,
      basePlaybackRevision,
      playbackRevision,
      targets: normalizedTargets,
      event: structuredClone(event),
      createdAtMs: nowMs,
      attempts: 0,
      retryAtMs: nowMs,
    };
    return normalizeStoredPlaybackBroadcastRecord(candidate, this.activeRoom);
  }

  enqueuePlaybackBroadcast(
    event: JsonRecord,
    targets: string[] = this.realtimePresenceTargets(),
    nowMs = Date.now(),
    options: PlaybackBroadcastOptions = {},
  ) {
    const record = this.playbackBroadcastRecord(event, targets, nowMs, options);
    if (!record) return false;
    const current = (this.activeRoom.pendingPlaybackBroadcasts || []).filter(
      (candidate) => candidate.coordinatorEpoch === record.coordinatorEpoch,
    );
    if (record.kind === 'commit') {
      const matchingCancel = [...current]
        .reverse()
        .find(
          (candidate) =>
            candidate.kind === 'cancel' &&
            candidate.basePlaybackRevision === record.basePlaybackRevision &&
            candidate.playbackRevision === record.playbackRevision,
        );
      // Preserve the product's existing immediate cancellation feedback before
      // a superseding direct COMMIT. The pair remains bounded and idempotent.
      this.activeRoom.pendingPlaybackBroadcasts = matchingCancel
        ? [matchingCancel, record]
        : [record];
      return true;
    }
    const baseCommit = [...current]
      .reverse()
      .find(
        (candidate) =>
          candidate.kind === 'commit' && candidate.playbackRevision === record.basePlaybackRevision,
      );
    const matchingCancel = [...current]
      .reverse()
      .find(
        (candidate) =>
          candidate.kind === 'cancel' &&
          candidate.basePlaybackRevision === record.basePlaybackRevision &&
          candidate.playbackRevision === record.playbackRevision,
      );
    this.activeRoom.pendingPlaybackBroadcasts = baseCommit
      ? [baseCommit, record]
      : record.kind === 'prepare' && matchingCancel
        ? [matchingCancel, record]
        : [record];
    return true;
  }

  enqueuePlaybackOutcome(outcome: PlaybackOutcome | null, nowMs = Date.now()) {
    if (!outcome) return false;
    let changed = false;
    if (outcome.cancelEvent) {
      const outcomePlayback = isRecord(outcome.event?.playback) ? outcome.event.playback : null;
      const successorBasePlaybackRevision =
        outcome.event?.type === 'pro-playback-prepare'
          ? outcome.event.basePlaybackRevision
          : outcome.event?.type === 'pro-playback-commit'
            ? isSafeNonNegativeInteger(outcomePlayback?.revision)
              ? outcomePlayback.revision - 1
              : undefined
            : undefined;
      const options = isSafeNonNegativeInteger(successorBasePlaybackRevision)
        ? { basePlaybackRevision: successorBasePlaybackRevision }
        : {};
      changed = this.enqueuePlaybackBroadcast(
        outcome.cancelEvent,
        this.realtimePresenceTargets(),
        nowMs,
        options,
      );
    }
    if (outcome.event) {
      changed =
        this.enqueuePlaybackBroadcast(
          outcome.event,
          outcome.targets || this.realtimePresenceTargets(),
          nowMs,
        ) || changed;
    }
    return changed;
  }

  async dispatchPlaybackBroadcast(record: PlaybackBroadcastRecord) {
    const namespace = this.env.PRO_SIGNALING_ROOMS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    try {
      const stub = namespace.get(
        namespace.idFromName(
          proRoomObjectName(this.activeRoom.roomCode, this.activeRoom.roomGeneration),
        ),
      );
      const { response, bytes } = await fetchWithDeadline(
        (boundedRequest) => stub.fetch(boundedRequest),
        new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': this.activeRoom.roomCode,
            ...proRoomGenerationWireHeaders(this.activeRoom.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.activeRoom.roomCode,
            ...proRoomGenerationWireFields(this.activeRoom.roomGeneration),
            coordinatorEpoch: record.coordinatorEpoch,
            targets: record.targets,
            event: record.event,
          }),
        }),
        DEVELOPER_COMMAND_DISPATCH_TIMEOUT_MS,
      );
      if (response.status !== 200) return false;
      const body = parseInternalJsonResponse(bytes);
      return !!(
        hasExactKeys(body, ['broadcast', 'eligible', 'sent']) &&
        body.broadcast === true &&
        isSafeNonNegativeInteger(body.eligible) &&
        isSafeNonNegativeInteger(body.sent) &&
        body.sent <= body.eligible &&
        body.sent === body.eligible
      );
    } catch {
      return false;
    }
  }

  async flushPendingPlaybackBroadcasts(nowMs = Date.now()) {
    while ((this.room?.pendingPlaybackBroadcasts?.length ?? 0) > 0) {
      const record = this.activeRoom.pendingPlaybackBroadcasts[0];
      if (!record) break;
      if (record.coordinatorEpoch !== this.activeRoom.presence.coordinatorEpoch) {
        const previous = structuredClone(this.activeRoom.pendingPlaybackBroadcasts);
        this.activeRoom.pendingPlaybackBroadcasts.shift();
        try {
          await this.persist({
            flushPlaybackOutbox: false,
          });
        } catch {
          this.activeRoom.pendingPlaybackBroadcasts = previous;
          await this.maintainAlarm();
          return false;
        }
        continue;
      }
      if (record.retryAtMs > nowMs) return false;

      const previous = structuredClone(this.activeRoom.pendingPlaybackBroadcasts);
      const delivered = await this.dispatchPlaybackBroadcast(record);
      if (delivered) {
        this.activeRoom.pendingPlaybackBroadcasts.shift();
      } else {
        const attempts = Math.min(PLAYBACK_BROADCAST_RETRY_MAX_ATTEMPTS, record.attempts + 1);
        record.attempts = attempts;
        record.retryAtMs = nowMs + this.playbackBroadcastRetryDelayMs(record.attempts - 1);
      }
      try {
        await this.persist({
          flushPlaybackOutbox: false,
        });
      } catch {
        // The previous durable record is still authoritative. Restore the same
        // in-memory queue and let its already-maintained alarm redeliver it.
        this.activeRoom.pendingPlaybackBroadcasts = previous;
        await this.maintainAlarm();
        return false;
      }
      if (!delivered) return false;
      nowMs = Date.now();
    }
    return true;
  }

  presenceBroadcastRetryDelayMs(attempts: number) {
    return Math.min(
      PRESENCE_BROADCAST_RETRY_MAX_MS,
      PRESENCE_BROADCAST_RETRY_BASE_MS * 2 ** Math.min(attempts, 6),
    );
  }

  comparePresenceBroadcastRevision(left: PresenceRevision, right: PresenceRevision) {
    if (left.coordinatorEpoch !== right.coordinatorEpoch) {
      return left.coordinatorEpoch - right.coordinatorEpoch;
    }
    return left.presenceRevision - right.presenceRevision;
  }

  currentPresenceBroadcastRecord(nowMs: number, attempts = 0): PresenceBroadcastRecord {
    return {
      coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
      presenceRevision: this.activeRoom.presence.revision,
      roomRevision: this.activeRoom.revision,
      retryAtMs: nowMs + this.presenceBroadcastRetryDelayMs(attempts),
      attempts,
    };
  }

  async rememberFailedPresenceBroadcast(event: JsonRecord, coordinatorEpoch: number) {
    if ((await readServiceMaintenance(this.env)).enabled) return;
    await this.withMutation(async () => {
      if ((await readServiceMaintenance(this.env)).enabled) return;
      if (
        !this.room ||
        event.type !== 'pro-presence-snapshot' ||
        !isSafeNonNegativeInteger(event.presenceRevision)
      ) {
        return;
      }
      const deliveredRevision = {
        coordinatorEpoch,
        presenceRevision: event.presenceRevision,
      };
      const currentRevision = {
        coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
        presenceRevision: this.activeRoom.presence.revision,
      };
      // A later full snapshot supersedes this failed attempt. Its own delivery
      // path is responsible for installing a retry marker if it also fails.
      if (this.comparePresenceBroadcastRevision(deliveredRevision, currentRevision) !== 0) return;

      const existing = this.activeRoom.pendingPresenceBroadcast;
      const attempts =
        existing && this.comparePresenceBroadcastRevision(existing, currentRevision) === 0
          ? existing.attempts
          : 0;
      const next = this.currentPresenceBroadcastRecord(Date.now(), attempts);
      if (existing && this.comparePresenceBroadcastRevision(existing, next) > 0) return;
      if (existing && this.comparePresenceBroadcastRevision(existing, next) === 0) {
        next.retryAtMs = Math.min(existing.retryAtMs, next.retryAtMs);
      }
      this.activeRoom.pendingPresenceBroadcast = next;
      // The retry marker and its alarm must survive isolate eviction. It is an
      // internal delivery concern, so avoid rewriting the legacy shadow.
      await this.persist({ retainEarlierAlarm: true });
    });
  }

  async clearDeliveredPresenceBroadcast(event: JsonRecord, coordinatorEpoch: number) {
    if ((await readServiceMaintenance(this.env)).enabled) return;
    await this.withMutation(async () => {
      if ((await readServiceMaintenance(this.env)).enabled) return;
      const pending = this.room?.pendingPresenceBroadcast;
      if (
        !pending ||
        event.type !== 'pro-presence-snapshot' ||
        !isSafeNonNegativeInteger(event.presenceRevision)
      ) {
        return;
      }
      const deliveredRevision = {
        coordinatorEpoch,
        presenceRevision: event.presenceRevision,
      };
      if (this.comparePresenceBroadcastRevision(deliveredRevision, pending) < 0) return;
      this.activeRoom.pendingPresenceBroadcast = null;
      await this.persist({ retainEarlierAlarm: true });
    });
  }

  async deliverPresenceBroadcast(event: JsonRecord, targets: string[], coordinatorEpoch: number) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.broadcastServerEvent(event, targets, coordinatorEpoch)) {
        await this.clearDeliveredPresenceBroadcast(event, coordinatorEpoch);
        return true;
      }
    }
    await this.rememberFailedPresenceBroadcast(event, coordinatorEpoch);
    return false;
  }

  async retryPendingPresenceBroadcast(nowMs: number) {
    const pending = this.activeRoom.pendingPresenceBroadcast;
    if (!pending || pending.retryAtMs > nowMs) return false;

    const currentRevision = {
      coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
      presenceRevision: this.activeRoom.presence.revision,
    };
    const attempts =
      this.comparePresenceBroadcastRevision(pending, currentRevision) === 0 ? pending.attempts : 0;
    const delivered = await this.broadcastServerEvent(
      this.presenceEvent(),
      this.realtimePresenceTargets(),
      currentRevision.coordinatorEpoch,
    );
    if (delivered) {
      this.activeRoom.pendingPresenceBroadcast = null;
    } else {
      const nextAttempts = Math.min(PRESENCE_BROADCAST_RETRY_MAX_ATTEMPTS, attempts + 1);
      this.activeRoom.pendingPresenceBroadcast = this.currentPresenceBroadcastRecord(
        nowMs,
        nextAttempts,
      );
    }
    await this.persist();
    return delivered;
  }

  scheduleServerEvent(event: JsonRecord, targets: string[] = this.realtimePresenceTargets()) {
    if (
      event?.type === 'pro-playback-prepare' ||
      event?.type === 'pro-playback-cancel' ||
      event?.type === 'pro-playback-commit'
    ) {
      // Playback events must be included in the caller's next canonical room
      // persist. Never start cross-Worker delivery from this pre-persist seam.
      return Promise.resolve(this.enqueuePlaybackBroadcast(event, targets));
    }
    const coordinatorEpoch = this.activeRoom.presence.coordinatorEpoch;
    const hasSignalingNamespace =
      this.env.PRO_SIGNALING_ROOMS && typeof this.env.PRO_SIGNALING_ROOMS.idFromName === 'function';
    const delivery =
      event?.type === 'pro-presence-snapshot' && hasSignalingNamespace
        ? this.deliverPresenceBroadcast(event, targets, coordinatorEpoch)
        : this.broadcastServerEvent(event, targets, coordinatorEpoch);
    if (typeof this.state.waitUntil === 'function') this.state.waitUntil(delivery);
    return delivery;
  }

  presenceEvent() {
    return {
      type: 'pro-presence-snapshot',
      presenceRevision: this.activeRoom.presence.revision,
      roomRevision: this.activeRoom.revision,
    };
  }

  invalidationEvent(extra = {}) {
    return {
      type: 'pro-room-invalidated',
      roomRevision: this.activeRoom.revision,
      ...extra,
    };
  }

  playbackCommitEvent(transitionId: string | null, executeAtMs: number, nowMs: number) {
    return {
      type: 'pro-playback-commit',
      transitionId,
      serverTimeMs: nowMs,
      executeAtMs,
      playback: structuredClone(this.activeRoom.playback),
    };
  }

  playbackPrepareEvent(pending: PlaybackTransition, nowMs = Date.now()) {
    return {
      type: 'pro-playback-prepare',
      transitionId: pending.transitionId,
      serverTimeMs: nowMs,
      deadlineAtMs: pending.deadlineAtMs,
      basePlaybackRevision: pending.basePlaybackRevision,
      target: structuredClone(pending.target),
    };
  }

  cancelPendingPlayback(reason: string, nowMs = Date.now()) {
    const pending = this.activeRoom.pendingPlaybackTransition;
    if (!pending) return null;
    this.activeRoom.pendingPlaybackTransition = null;
    if (pending.developerCommandId) {
      const record = this.activeRoom.developerCommands[pending.developerCommandId];
      if (record && (record.status === 'pending' || record.status === 'dispatched')) {
        this.completeDeveloperCommand(record, 'rejected', 'busy', nowMs);
      }
    }
    return {
      type: 'pro-playback-cancel',
      transitionId: pending.transitionId,
      serverTimeMs: nowMs,
      reason,
    };
  }

  targetPlayback(
    queueItemId: string | null,
    state: PlaybackState['state'],
    positionSeconds: number,
    nowMs: number,
    mediaIdentity: PlaybackMediaIdentity | null = null,
  ): PlaybackState | null {
    if (this.activeRoom.playback.revision >= Number.MAX_SAFE_INTEGER) return null;
    if (queueItemId === null) {
      return {
        coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
        revision: this.activeRoom.playback.revision + 1,
        state: 'idle',
        queueItemId: null,
        positionSeconds: 0,
        updatedAtMs: nowMs,
        youtubeVideoId: null,
        youtubeSubIndex: null,
      };
    }
    const item = this.activeRoom.playlist.find(
      (candidate) => candidate.queueItemId === queueItemId,
    );
    if (!item || (state !== 'playing' && state !== 'paused')) return null;
    const boundedPosition = Math.min(PLAYBACK_MAX_POSITION_SECONDS, Math.max(0, positionSeconds));
    if (item.source.kind === 'youtube') {
      let youtubeVideoId;
      let youtubeSubIndex;
      if (item.source.videoIds !== undefined) {
        youtubeSubIndex =
          mediaIdentity?.youtubeSubIndex ?? item.source.videoIds.indexOf(item.source.videoId);
        if (
          !isSafeNonNegativeInteger(youtubeSubIndex) ||
          youtubeSubIndex >= item.source.videoIds.length
        ) {
          return null;
        }
        youtubeVideoId = item.source.videoIds[youtubeSubIndex];
        if (youtubeVideoId === undefined) return null;
        // Once a manifest exists, the client-reported video ID is an assertion,
        // never authority. The immutable server list derives the actual target.
        if (
          mediaIdentity?.youtubeVideoId !== undefined &&
          mediaIdentity.youtubeVideoId !== youtubeVideoId
        ) {
          return null;
        }
      } else if (item.source.playlistId === undefined) {
        youtubeVideoId = item.source.videoId;
        youtubeSubIndex = 0;
        if (
          mediaIdentity !== null &&
          (mediaIdentity.youtubeVideoId !== youtubeVideoId ||
            mediaIdentity.youtubeSubIndex !== youtubeSubIndex)
        ) {
          return null;
        }
      } else {
        // Legacy playlist rows have no canonical ordered manifest. Preserve
        // explicit select/resume compatibility, but never invent traversal.
        youtubeVideoId = mediaIdentity?.youtubeVideoId || item.source.videoId;
        youtubeSubIndex = mediaIdentity?.youtubeSubIndex ?? 0;
      }
      if (
        !YOUTUBE_VIDEO_ID_RE.test(youtubeVideoId || '') ||
        !isSafeNonNegativeInteger(youtubeSubIndex) ||
        youtubeSubIndex > 100_000
      ) {
        return null;
      }
      return {
        coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
        revision: this.activeRoom.playback.revision + 1,
        state,
        queueItemId,
        positionSeconds: boundedPosition,
        updatedAtMs: nowMs,
        youtubeVideoId,
        youtubeSubIndex,
      };
    }
    if (
      mediaIdentity?.youtubeVideoId !== undefined ||
      mediaIdentity?.youtubeSubIndex !== undefined
    ) {
      return null;
    }
    return {
      coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
      revision: this.activeRoom.playback.revision + 1,
      state,
      queueItemId,
      positionSeconds: boundedPosition,
      updatedAtMs: nowMs,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    };
  }

  directPlaybackCommit(
    target: PlaybackState,
    nowMs: number,
    developerCommandId: string | null = null,
  ): PlaybackAuthorityResult {
    const cancelEvent = this.cancelPendingPlayback('superseded', nowMs);
    const executeAtMs = nowMs + PLAYBACK_COMMIT_LEAD_MS;
    target.updatedAtMs = executeAtMs;
    this.activeRoom.currentQueueItemId = target.queueItemId;
    this.activeRoom.playback = target;
    this.activeRoom.pendingPlaybackTransition = null;
    this.activeRoom.revision += 1;
    if (developerCommandId) {
      const record = this.activeRoom.developerCommands[developerCommandId];
      if (record) this.completeDeveloperCommand(record, 'applied', 'applied', nowMs);
    }
    return {
      status: 'committed',
      cancelEvent,
      event: this.playbackCommitEvent(null, executeAtMs, nowMs),
    };
  }

  preparePlaybackTransition(
    target: PlaybackState,
    nowMs: number,
    developerCommandId: string | null = null,
    options: {
      timingMode?: 'zero-start' | 'scheduled-control';
      resumeFromSleep?: boolean;
    } = {},
  ): PlaybackAuthorityResult {
    const timingMode = options.timingMode === 'zero-start' ? 'zero-start' : 'scheduled-control';
    const existing = this.activeRoom.pendingPlaybackTransition;
    if (
      existing &&
      existing.coordinatorEpoch === this.activeRoom.presence.coordinatorEpoch &&
      existing.basePlaybackRevision === this.activeRoom.playback.revision &&
      (existing.resumeFromSleep !== true &&
      existing.deadlineAtMs - existing.createdAtMs === PLAYBACK_ZERO_START_TRANSITION_DEADLINE_MS
        ? 'zero-start'
        : 'scheduled-control') === timingMode &&
      playbackSemanticallyEqual(existing.target, target)
    ) {
      // Several devices commonly report the same YouTube ENDED observation.
      // Coalesce those observations instead of repeatedly cancelling the same
      // three-second rendezvous and postponing the canonical transition.
      if (developerCommandId) {
        return { error: 'PLAYBACK_TRANSITION_PENDING', status: 409 };
      }
      return {
        status: 'preparing',
        transitionId: existing.transitionId,
        targets: [],
        event: null,
      };
    }
    const cancelEvent = this.cancelPendingPlayback('superseded', nowMs);
    const cohort = this.realtimePresenceTargets();
    if (cohort.length === 0) {
      const committed = this.directPlaybackCommit(target, nowMs, developerCommandId);
      return cancelEvent ? { ...committed, cancelEvent } : committed;
    }
    const transitionId = `transition_${randomToken(16)}`;
    const deadlineAtMs =
      nowMs +
      (timingMode === 'zero-start'
        ? PLAYBACK_ZERO_START_TRANSITION_DEADLINE_MS
        : PLAYBACK_TRANSITION_DEADLINE_MS);
    const pending: PlaybackTransition = {
      transitionId,
      coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
      basePlaybackRevision: this.activeRoom.playback.revision,
      createdAtMs: nowMs,
      deadlineAtMs,
      target,
      cohort,
      ready: {},
      developerCommandId,
      ...(options.resumeFromSleep === true ? { resumeFromSleep: true } : {}),
    };
    this.activeRoom.pendingPlaybackTransition = pending;
    return {
      status: 'preparing',
      transitionId,
      cancelEvent,
      targets: cohort,
      event: this.playbackPrepareEvent(pending, nowMs),
    };
  }

  commitPendingPlaybackTransition(nowMs = Date.now()) {
    const pending = this.activeRoom.pendingPlaybackTransition;
    if (!pending) return null;
    if (
      pending.coordinatorEpoch !== this.activeRoom.presence.coordinatorEpoch ||
      pending.basePlaybackRevision !== this.activeRoom.playback.revision
    ) {
      return { cancelEvent: this.cancelPendingPlayback('stale', nowMs), event: null };
    }
    const executeAtMs =
      nowMs +
      (pending.resumeFromSleep !== true &&
      pending.deadlineAtMs - pending.createdAtMs === PLAYBACK_ZERO_START_TRANSITION_DEADLINE_MS
        ? PLAYBACK_ZERO_START_COMMIT_LEAD_MS
        : PLAYBACK_COMMIT_LEAD_MS);
    pending.target.updatedAtMs = executeAtMs;
    this.activeRoom.currentQueueItemId = pending.target.queueItemId;
    this.activeRoom.playback = pending.target;
    this.activeRoom.pendingPlaybackTransition = null;
    this.activeRoom.revision += 1;
    if (pending.developerCommandId) {
      const record = this.activeRoom.developerCommands[pending.developerCommandId];
      if (record) this.completeDeveloperCommand(record, 'applied', 'applied', nowMs);
    }
    return {
      cancelEvent: null,
      event: this.playbackCommitEvent(pending.transitionId, executeAtMs, nowMs),
    };
  }

  applyPlaybackAuthorityCommand(
    command: PlaybackAuthorityCommand,
    nowMs = Date.now(),
    developerCommandId: string | null = null,
  ): PlaybackAuthorityResult {
    if (command.baseRevision !== this.activeRoom.playback.revision) {
      return { error: 'PLAYBACK_REVISION_CONFLICT', status: 409 };
    }
    const playback = this.activeRoom.playback;
    const currentIdentity: PlaybackMediaIdentity | null =
      playback.youtubeVideoId === null || playback.youtubeSubIndex === null
        ? null
        : {
            youtubeVideoId: playback.youtubeVideoId,
            youtubeSubIndex: playback.youtubeSubIndex,
          };
    const pendingPlaybackTransition = this.activeRoom.pendingPlaybackTransition;
    const wakeTransition = pendingPlaybackTransition?.resumeFromSleep === true;
    const playbackClockRunning = this.activeRoom.runtime === 'awake' && !wakeTransition;
    const currentPosition = playbackClockRunning
      ? playbackPositionAt(playback, nowMs)
      : wakeTransition
        ? pendingPlaybackTransition.target.positionSeconds
        : playback.positionSeconds;
    let target: PlaybackState | null;
    let requiresPrepare = false;
    let timingMode: 'zero-start' | 'scheduled-control' = 'scheduled-control';

    if (command.type === 'play') {
      if (playback.state === 'playing') return { status: 'unchanged', event: null };
      const queueItemId =
        playback.queueItemId ||
        this.activeRoom.currentQueueItemId ||
        this.activeRoom.playlist[0]?.queueItemId ||
        null;
      if (!queueItemId) return { error: 'NO_MEDIA', status: 409 };
      target = this.targetPlayback(
        queueItemId,
        'playing',
        playback.queueItemId === queueItemId ? playback.positionSeconds : 0,
        nowMs,
        playback.queueItemId === queueItemId ? currentIdentity : null,
      );
      // Resuming is a synchronized start, even when every participant already
      // has the same item resident. A direct COMMIT lets a cold/late endpoint
      // start behind the rest of the room.
      requiresPrepare = true;
      timingMode = playback.state === 'idle' ? 'zero-start' : 'scheduled-control';
    } else if (command.type === 'pause') {
      if (playback.state === 'idle') return { error: 'NO_MEDIA', status: 409 };
      if (playback.state === 'paused') return { status: 'unchanged', event: null };
      target = this.targetPlayback(
        playback.queueItemId,
        'paused',
        currentPosition + (playbackClockRunning ? PLAYBACK_COMMIT_LEAD_MS / 1_000 : 0),
        nowMs,
        currentIdentity,
      );
    } else if (command.type === 'stop') {
      if (playback.state === 'idle') return { status: 'unchanged', event: null };
      if (playback.state === 'paused' && playback.positionSeconds === 0) {
        return { status: 'unchanged', event: null };
      }
      target = this.targetPlayback(playback.queueItemId, 'paused', 0, nowMs, currentIdentity);
    } else if (command.type === 'seek') {
      if (playback.state === 'idle') return { error: 'NO_MEDIA', status: 409 };
      target = this.targetPlayback(
        playback.queueItemId,
        playback.state,
        command.positionSeconds,
        nowMs,
        currentIdentity,
      );
      requiresPrepare = playback.state === 'playing';
      timingMode = 'scheduled-control';
    } else {
      let queueItemId: string | null = null;
      let state: 'playing' | 'paused' = 'playing';
      let positionSeconds = 0;
      let mediaIdentity: PlaybackMediaIdentity | null = null;
      const currentItem = playback.queueItemId
        ? this.activeRoom.playlist.find(
            (candidate) => candidate.queueItemId === playback.queueItemId,
          )
        : null;
      const currentPlaylistSource =
        currentItem?.source.kind === 'youtube' && currentItem.source.playlistId !== undefined
          ? currentItem.source
          : null;
      const currentManifestIdentity = (): PlaybackManifestResult | null => {
        if (!currentPlaylistSource) return null;
        if (currentPlaylistSource.videoIds === undefined) {
          return { error: 'PLAYLIST_MANIFEST_REQUIRED', status: 409 };
        }
        const index = playback.youtubeSubIndex;
        if (
          !isSafeNonNegativeInteger(index) ||
          index >= currentPlaylistSource.videoIds.length ||
          currentPlaylistSource.videoIds[index] !== playback.youtubeVideoId
        ) {
          return { error: 'INVALID_PLAYBACK_TARGET', status: 400 };
        }
        const youtubeVideoId = currentPlaylistSource.videoIds[index];
        if (youtubeVideoId === undefined) {
          return { error: 'INVALID_PLAYBACK_TARGET', status: 400 };
        }
        return {
          index,
          videoIds: currentPlaylistSource.videoIds,
          mediaIdentity: {
            youtubeVideoId,
            youtubeSubIndex: index,
          },
        };
      };
      const nextWithinCurrentPlaylist = ():
        | Extract<PlaybackManifestResult, { error: string }>
        | { queueItemId: string | null; mediaIdentity: PlaybackMediaIdentity }
        | null => {
        const manifest = currentManifestIdentity();
        if (!manifest || 'error' in manifest) return manifest;
        const nextIndex = manifest.index + 1;
        if (nextIndex >= manifest.videoIds.length) return null;
        const youtubeVideoId = manifest.videoIds[nextIndex];
        if (youtubeVideoId === undefined) return { error: 'INVALID_PLAYBACK_TARGET', status: 400 };
        return {
          queueItemId: playback.queueItemId,
          mediaIdentity: { youtubeVideoId, youtubeSubIndex: nextIndex },
        };
      };
      if (command.type === 'select') {
        queueItemId = command.queueItemId;
        state = command.state;
        positionSeconds = command.positionSeconds;
        if (command.youtubeVideoId === undefined || command.youtubeSubIndex === undefined) {
          mediaIdentity = null;
        } else {
          mediaIdentity = {
            youtubeVideoId: command.youtubeVideoId,
            youtubeSubIndex: command.youtubeSubIndex,
          };
        }
      } else if (command.type === 'previous') {
        if (currentPlaylistSource) {
          const manifest = currentManifestIdentity();
          if (manifest && 'error' in manifest) return manifest;
          if (!manifest) return { error: 'INVALID_PLAYBACK_TARGET', status: 400 };
          if (manifest.index > 0) {
            queueItemId = playback.queueItemId;
            const previousIndex = manifest.index - 1;
            const youtubeVideoId = manifest.videoIds[previousIndex];
            if (youtubeVideoId === undefined) {
              return { error: 'INVALID_PLAYBACK_TARGET', status: 400 };
            }
            mediaIdentity = {
              youtubeVideoId,
              youtubeSubIndex: previousIndex,
            };
          } else {
            queueItemId = adjacentQueueItemId(this.activeRoom, 'previous');
          }
        } else {
          queueItemId = adjacentQueueItemId(this.activeRoom, 'previous');
        }
      } else if (command.type === 'ended' || command.type === 'unavailable') {
        if (command.queueItemId !== playback.queueItemId) {
          return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
        }
        const observedMediaKind = currentItem?.source.kind === 'youtube' ? 'youtube' : 'file';
        if (!currentItem || command.mediaKind !== observedMediaKind) {
          return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
        }
        if (
          command.youtubeVideoId !== undefined &&
          (command.youtubeVideoId !== playback.youtubeVideoId ||
            command.youtubeSubIndex !== playback.youtubeSubIndex)
        ) {
          return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
        }
        if (
          command.mediaKind === 'youtube' &&
          (command.youtubeVideoId === undefined || command.youtubeSubIndex === undefined)
        ) {
          return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
        }
        if (
          command.mediaKind === 'file' &&
          (command.youtubeVideoId !== undefined || command.youtubeSubIndex !== undefined)
        ) {
          return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
        }
        if (command.type === 'ended') {
          if (playback.state !== 'playing' || !playbackClockRunning) {
            return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
          }
          if (command.durationSeconds !== null) {
            const nearEndTolerance = Math.min(
              PLAYBACK_ENDED_NEAR_END_TOLERANCE_SECONDS,
              Math.max(0.25, command.durationSeconds * 0.01),
            );
            const nearEndThreshold = Math.max(0, command.durationSeconds - nearEndTolerance);
            if (
              command.observedPositionSeconds < nearEndThreshold ||
              currentPosition < nearEndThreshold
            ) {
              return { error: 'PLAYBACK_OBSERVATION_NOT_AT_END', status: 409 };
            }
          } else {
            // Live/unknown-duration YouTube media can still emit a legitimate
            // ENDED event. Accept it only after the canonical revision has
            // actually been playing and while the observer remains close to
            // the server clock; this avoids both a blanket rejection and an
            // immediate/spurious auto-advance.
            const playingForMs = nowMs - playback.updatedAtMs;
            if (
              playingForMs < PLAYBACK_UNKNOWN_DURATION_MIN_PLAYING_MS ||
              Math.abs(command.observedPositionSeconds - currentPosition) >
                PLAYBACK_UNKNOWN_DURATION_POSITION_TOLERANCE_SECONDS
            ) {
              return { error: 'PLAYBACK_OBSERVATION_NOT_AT_END', status: 409 };
            }
          }
        }
        if (command.type === 'ended' && this.activeRoom.queueMode.repeatMode === 2) {
          queueItemId = playback.queueItemId;
          mediaIdentity = currentIdentity;
        } else if (currentPlaylistSource) {
          const internal = nextWithinCurrentPlaylist();
          if (internal && 'error' in internal) return internal;
          if (internal) {
            queueItemId = internal.queueItemId;
            mediaIdentity = internal.mediaIdentity;
          } else {
            queueItemId = adjacentQueueItemId(this.activeRoom, 'next');
          }
        } else {
          queueItemId = adjacentQueueItemId(this.activeRoom, 'next');
        }
      } else {
        if (currentPlaylistSource) {
          const internal = nextWithinCurrentPlaylist();
          if (internal && 'error' in internal) return internal;
          if (internal) {
            queueItemId = internal.queueItemId;
            mediaIdentity = internal.mediaIdentity;
          } else {
            queueItemId = adjacentQueueItemId(this.activeRoom, 'next');
          }
        } else {
          queueItemId = adjacentQueueItemId(this.activeRoom, 'next');
        }
      }
      target = this.targetPlayback(
        queueItemId,
        queueItemId ? state : 'idle',
        positionSeconds,
        nowMs,
        mediaIdentity,
      );
      requiresPrepare = queueItemId !== null;
      timingMode = 'zero-start';
    }

    if (!target) return { error: 'INVALID_PLAYBACK_TARGET', status: 400 };
    return requiresPrepare
      ? this.preparePlaybackTransition(target, nowMs, developerCommandId, { timingMode })
      : this.directPlaybackCommit(target, nowMs, developerCommandId);
  }

  decommissionPurgeAfterMs(nowMs: number) {
    const presignTtlMs =
      configuredNumber(this.env.PRESIGN_TTL_SECONDS, PRESIGN_TTL_SECONDS, 60, 3600) * 1000;
    let purgeAfterMs = nowMs + presignTtlMs + 5_000;
    for (const asset of Object.values(this.activeRoom.assets || {})) {
      if (isSafeInteger(asset.expiresAtMs)) {
        purgeAfterMs = Math.max(purgeAfterMs, asset.expiresAtMs + 5_000);
      }
      if (isSafeInteger(asset.uploadExpiresAtMs)) {
        purgeAfterMs = Math.max(purgeAfterMs, asset.uploadExpiresAtMs + 5_000);
      }
      if (isSafeInteger(asset.stagingCleanupAfterMs)) {
        purgeAfterMs = Math.max(purgeAfterMs, asset.stagingCleanupAfterMs);
      }
    }
    for (const tombstone of Object.values(this.activeRoom.stagingTombstones || {})) {
      if (isSafeInteger(tombstone.cleanupAfterMs)) {
        purgeAfterMs = Math.max(purgeAfterMs, tombstone.cleanupAfterMs);
      }
    }
    return purgeAfterMs;
  }

  decommissionFinalEmptyWindowMs() {
    return (
      configuredNumber(
        this.env.DECOMMISSION_FINAL_EMPTY_WINDOW_SECONDS,
        DECOMMISSION_FINAL_EMPTY_WINDOW_SECONDS,
        60,
        24 * 60 * 60,
      ) * 1000
    );
  }

  async purgeDecommissionedMediaPrefix() {
    if ((await readServiceMaintenance(this.env)).enabled) return { ok: false, deletedAny: false };
    const bucket = this.env.PRO_MEDIA_BUCKET;
    if (!bucket || typeof bucket.list !== 'function' || typeof bucket.delete !== 'function') {
      return { ok: false, deletedAny: false };
    }
    const prefix = `${proRoomMediaPrefix(this.activeRoom.roomCode, this.activeRoom.roomGeneration)}/`;
    let deletedAny = false;
    try {
      // Re-read the first page after every batch. Deleting while following an
      // old cursor can skip keys when the listing contracts underneath it.
      for (let round = 0; round < 32; round += 1) {
        if ((await readServiceMaintenance(this.env)).enabled) {
          return { ok: false, deletedAny };
        }
        const page = await bucket.list({ prefix, limit: 1000 });
        const keys = r2ListObjectKeys(page);
        if (keys.length === 0) return { ok: true, deletedAny };
        deletedAny = true;
        await bucket.delete(keys);
      }
      return { ok: false, deletedAny };
    } catch {
      return { ok: false, deletedAny };
    }
  }

  async decommissionSignaling(requestId: string) {
    if ((await readServiceMaintenance(this.env)).enabled) return false;
    const namespace = this.env.PRO_SIGNALING_ROOMS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    try {
      const stub = namespace.get(
        namespace.idFromName(
          proRoomObjectName(this.activeRoom.roomCode, this.activeRoom.roomGeneration),
        ),
      );
      const { response, bytes } = await fetchWithDeadline(
        (boundedRequest) => stub.fetch(boundedRequest),
        new Request('https://signaling.internal/internal/admin/v1/decommission', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': this.activeRoom.roomCode,
            ...proRoomGenerationWireHeaders(this.activeRoom.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.activeRoom.roomCode,
            ...proRoomGenerationWireFields(this.activeRoom.roomGeneration),
            requestId,
          }),
        }),
        INTERNAL_SERVICE_RESPONSE_TIMEOUT_MS,
      );
      const payload = parseInternalJsonResponse(bytes);
      return (
        response.ok &&
        payload?.ok === true &&
        payload.roomCode === this.activeRoom.roomCode &&
        responseRoomGenerationMatches(payload, this.activeRoom.roomGeneration) &&
        payload.status === 'decommissioned'
      );
    } catch {
      return false;
    }
  }

  async deleteDeveloperRoomData(requestId: string, nowMs = Date.now()) {
    if ((await readServiceMaintenance(this.env)).enabled) return false;
    const db = this.env.DEVELOPER_API_DB;
    if (!db?.prepare) return false;
    try {
      // Generation-scoped authorization fences allow a public room number to
      // be reused without ever reviving credentials from this incarnation.
      await db
        .prepare(
          `INSERT INTO mxqr_developer_api_room_generation_tombstones
            (room_code, room_generation, request_id, decommissioned_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(room_code, room_generation) DO UPDATE SET
             request_id = excluded.request_id,
             decommissioned_at = MIN(
               mxqr_developer_api_room_generation_tombstones.decommissioned_at,
               excluded.decommissioned_at
             )`,
        )
        .bind(this.activeRoom.roomCode, this.activeRoom.roomGeneration, requestId, nowMs)
        .run();
      for (const table of [
        'mxqr_developer_api_keys',
        'mxqr_developer_api_audit',
        'mxqr_developer_api_admin_audit',
        'mxqr_developer_api_room_authority_fences',
      ]) {
        await db
          .prepare(
            `DELETE FROM ${table}
             WHERE room_code = ?1 AND room_generation = ?2`,
          )
          .bind(this.activeRoom.roomCode, this.activeRoom.roomGeneration)
          .run();
      }
      const remainingFence = await db
        .prepare(
          `SELECT 1 AS present
             FROM mxqr_developer_api_room_authority_fences
            WHERE room_code = ?1 AND room_generation = ?2
            LIMIT 1`,
        )
        .bind(this.activeRoom.roomCode, this.activeRoom.roomGeneration)
        .all();
      if ((remainingFence?.results || []).length > 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  async clearDeveloperRoomLimiter(requestId: string) {
    if ((await readServiceMaintenance(this.env)).enabled) return false;
    const namespace = this.env.DEVELOPER_API_LIMITERS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    try {
      const limiterName = `room:${proRoomObjectName(this.activeRoom.roomCode, this.activeRoom.roomGeneration)}`;
      const stub = namespace.get(namespace.idFromName(limiterName));
      const { response, bytes } = await fetchWithDeadline(
        (boundedRequest) => stub.fetch(boundedRequest),
        new Request('https://developer-api.internal/internal/admin/v1/decommission', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': this.activeRoom.roomCode,
            ...proRoomGenerationWireHeaders(this.activeRoom.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.activeRoom.roomCode,
            ...proRoomGenerationWireFields(this.activeRoom.roomGeneration),
            requestId,
          }),
        }),
        INTERNAL_SERVICE_RESPONSE_TIMEOUT_MS,
      );
      const payload = parseInternalJsonResponse(bytes);
      return (
        response.ok &&
        payload?.ok === true &&
        payload.roomCode === this.activeRoom.roomCode &&
        responseRoomGenerationMatches(payload, this.activeRoom.roomGeneration)
      );
    } catch {
      return false;
    }
  }

  async markRegistryDecommissioned(nowMs: number) {
    if ((await readServiceMaintenance(this.env)).enabled) return false;
    const db = this.env.MUSIXQUARE_ADMIN_DB || this.env.ADMIN_METRICS_DB || null;
    if (!db?.prepare) return false;
    try {
      await db
        .prepare(
          `INSERT OR IGNORE INTO mxqr_pro_room_generation_history
            (room_code, room_generation, status, decommissioned_at, request_id)
           VALUES (?1, ?2, 'decommissioned', ?3, ?4)`,
        )
        .bind(
          this.activeRoom.roomCode,
          this.activeRoom.roomGeneration,
          nowMs,
          this.activeRoom.decommission?.requestId || null,
        )
        .run();
      await db
        .prepare(
          `UPDATE mxqr_pro_room_registry
           SET label = 'Decommissioned PRO room',
               status = 'decommissioned',
               activation_state = 'unactivated',
               updated_at = ?3
           WHERE room_code = ?1 AND room_generation = ?2`,
        )
        .bind(this.activeRoom.roomCode, this.activeRoom.roomGeneration, nowMs)
        .run();
      const statement = db
        .prepare(
          `SELECT status, room_generation FROM mxqr_pro_room_registry
           WHERE room_code = ?1 LIMIT 1`,
        )
        .bind(this.activeRoom.roomCode);
      const row =
        typeof statement.first === 'function'
          ? await statement.first()
          : (await statement.all())?.results?.[0] || null;
      const currentGeneration = Number(row?.room_generation);
      return (
        (currentGeneration === this.activeRoom.roomGeneration &&
          row?.status === 'decommissioned') ||
        (isProRoomGeneration(currentGeneration) &&
          currentGeneration > this.activeRoom.roomGeneration)
      );
    } catch {
      return false;
    }
  }

  async retireAccountReverseEdge() {
    if ((await readServiceMaintenance(this.env)).enabled) return false;
    const db = this.env.MUSIXQUARE_AUTH_DB;
    // Decommission admission requires this production binding. Keep the guard
    // here as a fail-closed defense for rolling or malformed deployments.
    if (!db?.prepare) return false;
    const roomCode = this.activeRoom.roomCode;
    const roomGeneration = this.activeRoom.roomGeneration;
    try {
      await db
        .prepare(
          `DELETE FROM mxqr_account_pro_room_generations
            WHERE room_code = ?1 AND room_generation = ?2`,
        )
        .bind(roomCode, roomGeneration)
        .run();
      return true;
    } catch {
      return false;
    }
  }

  async maintainDecommissionedTombstone(nowMs = Date.now()) {
    if (this.activeRoom.status !== 'decommissioned' || !this.activeRoom.decommission) return false;
    const requestId = this.activeRoom.decommission.requestId;
    const media = await this.purgeDecommissionedMediaPrefix();
    const signaling = await this.decommissionSignaling(requestId);
    const developerData = await this.deleteDeveloperRoomData(requestId, nowMs);
    const developerLimiter = await this.clearDeveloperRoomLimiter(requestId);
    const registry = await this.markRegistryDecommissioned(nowMs);
    // Marking the registry first closes new account-link preflights. The
    // idempotent exact-edge deletion then drains every request that passed its
    // preflight just before the status transition.
    const accountReverseEdge = await this.retireAccountReverseEdge();
    const repaired =
      media.ok && signaling && developerData && developerLimiter && accountReverseEdge && registry;
    this.activeRoom.decommission.maintenanceAtMs =
      nowMs + (repaired ? DECOMMISSION_TOMBSTONE_MAINTENANCE_MS : DECOMMISSION_RETRY_MS);
    await this.persist();
    return repaired;
  }

  async continueDecommission(nowMs = Date.now()) {
    if (this.activeRoom.status !== 'decommissioning' || !this.activeRoom.decommission) {
      return this.activeRoom.status === 'decommissioned';
    }
    const job = this.activeRoom.decommission;
    if (!isSafeInteger(job.purgeAfterMs)) return false;
    const purgeAfterMs = job.purgeAfterMs;

    if (!job.signalingCleared) {
      job.signalingCleared = await this.decommissionSignaling(job.requestId);
    }
    if (!job.initialSweepCompleted) {
      job.initialSweepCompleted = (await this.purgeDecommissionedMediaPrefix()).ok;
    }
    if (!job.developerDataCleared) {
      job.developerDataCleared = await this.deleteDeveloperRoomData(job.requestId, nowMs);
    }
    if (!job.developerLimiterCleared) {
      job.developerLimiterCleared = await this.clearDeveloperRoomLimiter(job.requestId);
    }

    if (nowMs < purgeAfterMs) {
      job.retryAtMs =
        job.signalingCleared &&
        job.initialSweepCompleted &&
        job.developerDataCleared &&
        job.developerLimiterCleared
          ? purgeAfterMs
          : Math.min(purgeAfterMs, nowMs + DECOMMISSION_RETRY_MS);
      await this.persist();
      return false;
    }

    // Repeat every externally writable cleanup after the URL-expiry fence.
    // Requests that authenticated just before decommission may otherwise
    // finish after the initial pass and recreate audit/limiter state.
    const finalSweep = await this.purgeDecommissionedMediaPrefix();
    job.developerDataCleared = await this.deleteDeveloperRoomData(job.requestId, nowMs);
    job.developerLimiterCleared = await this.clearDeveloperRoomLimiter(job.requestId);
    job.signalingCleared = await this.decommissionSignaling(job.requestId);
    if (
      !job.signalingCleared ||
      !job.developerDataCleared ||
      !job.developerLimiterCleared ||
      !finalSweep.ok
    ) {
      job.finalEmptySinceMs = null;
      job.retryAtMs = nowMs + DECOMMISSION_RETRY_MS;
      await this.persist();
      return false;
    }
    if (finalSweep.deletedAny || !isSafeInteger(job.finalEmptySinceMs)) {
      job.finalEmptySinceMs = nowMs;
    }
    const finalEmptySinceMs = isSafeInteger(job.finalEmptySinceMs) ? job.finalEmptySinceMs : nowMs;
    const finalEmptyAtMs = finalEmptySinceMs + this.decommissionFinalEmptyWindowMs();
    if (nowMs < finalEmptyAtMs) {
      job.retryAtMs = Math.min(finalEmptyAtMs, nowMs + DECOMMISSION_RETRY_MS);
      await this.persist();
      return false;
    }
    if (!(await this.markRegistryDecommissioned(nowMs))) {
      job.retryAtMs = nowMs + DECOMMISSION_RETRY_MS;
      await this.persist();
      return false;
    }
    if (!(await this.retireAccountReverseEdge())) {
      job.retryAtMs = nowMs + DECOMMISSION_RETRY_MS;
      await this.persist();
      return false;
    }

    this.activeRoom.status = 'decommissioned';
    this.activeRoom.decommission = {
      requestId: job.requestId,
      startedAtMs: job.startedAtMs,
      completedAtMs: nowMs,
      maintenanceAtMs: nowMs + DECOMMISSION_TOMBSTONE_MAINTENANCE_MS,
    };
    await this.persist();
    return true;
  }

  async handleInternalDecommission(request: Request) {
    const parsed = await readJsonBody(request, SMALL_REQUEST_MAX_BYTES);
    if ('error' in parsed) {
      return errorResponse(parsed.error, parsed.status || 400);
    }
    const value = 'value' in parsed ? parsed.value : undefined;
    if (
      !hasExactKeys(value, ['roomCode', 'roomGeneration', 'requestId']) ||
      value.roomCode !== this.activeRoom.roomCode ||
      exactInternalRoomGeneration(request, value) !== this.activeRoom.roomGeneration ||
      !matchesPattern(value.requestId, ADMIN_REQUEST_ID_RE)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (this.activeRoom.status === 'decommissioned') {
      return jsonResponse({
        ok: true,
        roomCode: this.activeRoom.roomCode,
        roomGeneration: this.activeRoom.roomGeneration,
        status: 'decommissioned',
        changed: false,
        completedAtMs: this.activeRoom.decommission?.completedAtMs || null,
      });
    }
    if (this.activeRoom.status === 'decommissioning') {
      const completed = await this.continueDecommission(Date.now());
      return jsonResponse(
        {
          ok: true,
          roomCode: this.activeRoom.roomCode,
          roomGeneration: this.activeRoom.roomGeneration,
          status: completed ? 'decommissioned' : 'decommissioning',
          changed: false,
          purgeAfterMs: this.activeRoom.decommission?.purgeAfterMs || null,
          completedAtMs: this.activeRoom.decommission?.completedAtMs || null,
        },
        completed ? 200 : 202,
      );
    }
    if (
      !this.env.PRO_MEDIA_BUCKET?.list ||
      !this.env.PRO_MEDIA_BUCKET?.delete ||
      !this.env.PRO_SIGNALING_ROOMS?.idFromName ||
      !this.env.DEVELOPER_API_DB?.prepare ||
      !this.env.DEVELOPER_API_LIMITERS?.idFromName ||
      !(this.env.MUSIXQUARE_ADMIN_DB || this.env.ADMIN_METRICS_DB)?.prepare ||
      !this.env.MUSIXQUARE_AUTH_DB?.prepare
    ) {
      return errorResponse('PRO_ROOM_DECOMMISSION_NOT_CONFIGURED', 503);
    }

    const nowMs = Date.now();
    const purgeAfterMs = this.decommissionPurgeAfterMs(nowMs);
    const previousActivationGeneration = Number.isSafeInteger(
      this.activeRoom.activationClaimGeneration,
    )
      ? this.activeRoom.activationClaimGeneration
      : 0;
    const previousAuthEpoch = Number.isSafeInteger(this.activeRoom.authEpoch)
      ? this.activeRoom.authEpoch
      : 0;
    const tombstone = initialRoomState(
      this.activeRoom.roomCode,
      false,
      this.activeRoom.roomGeneration,
    );
    tombstone.status = 'decommissioning';
    tombstone.activationClaimGeneration = Math.min(
      Number.MAX_SAFE_INTEGER,
      previousActivationGeneration + 1,
    );
    tombstone.authEpoch = Math.min(Number.MAX_SAFE_INTEGER, previousAuthEpoch + 1);
    tombstone.decommission = {
      requestId: value.requestId,
      startedAtMs: nowMs,
      purgeAfterMs,
      retryAtMs: nowMs,
      signalingCleared: false,
      initialSweepCompleted: false,
      developerDataCleared: false,
      developerLimiterCleared: false,
      finalEmptySinceMs: null,
    };
    // The first tombstone commit is the irreversible admission fence. If that
    // atomic storage transaction fails, no external cleanup has started yet;
    // restore the exact active in-memory state so a following request cannot
    // continue a decommission job that durable storage never recorded.
    const checkpoint = this.captureInMemoryState();
    this.room = tombstone;
    try {
      await this.persist();
    } catch (error) {
      if (error instanceof RoomStateStorageCommitError) {
        this.restoreInMemoryState(checkpoint);
      }
      throw error;
    }
    const completed = await this.continueDecommission(nowMs);
    return jsonResponse(
      {
        ok: true,
        roomCode: this.activeRoom.roomCode,
        roomGeneration: this.activeRoom.roomGeneration,
        status: completed ? 'decommissioned' : 'decommissioning',
        changed: true,
        purgeAfterMs: this.activeRoom.decommission?.purgeAfterMs || null,
        completedAtMs: this.activeRoom.decommission?.completedAtMs || null,
      },
      completed ? 200 : 202,
    );
  }

  internalAdminStateResponse(changed: boolean) {
    return jsonResponse({
      ok: true,
      roomCode: this.activeRoom.roomCode,
      roomGeneration: this.activeRoom.roomGeneration,
      status: this.activeRoom.status,
      suspensionReason: this.activeRoom.suspensionReason,
      changed,
    });
  }

  async handleInternalSuspend() {
    if (!this.activeRoom.provisioned) return errorResponse('ROOM_NOT_FOUND', 404);
    if (this.activeRoom.status === 'suspended') return this.internalAdminStateResponse(false);
    if (this.activeRoom.status !== 'active') return errorResponse('ROOM_NOT_ACTIVE', 409);
    const playbackRevisionSteps =
      this.activeRoom.playback.state === 'playing' && this.activeRoom.playback.updatedAtMs > 0
        ? 2
        : 1;
    if (
      this.activeRoom.authEpoch >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.ownerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.revision >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.presence.revision >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.presence.coordinatorEpoch >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.playback.revision > Number.MAX_SAFE_INTEGER - playbackRevisionSteps
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    const nowMs = Date.now();
    this.freezePlayback(nowMs);

    // Suspension is an authorization and control-incarnation fence, not data deletion.
    // Playlist, media assets, PIN, and the owner recovery credential remain in
    // the room while every transient browser/session identity is discarded.
    this.discardTransientMemberAuthority();
    this.activeRoom.sessions = {};
    this.activeRoom.presence.participants = {};
    this.activeRoom.presence.coordinatorParticipantId = null;
    this.activeRoom.presence.revision += 1;
    this.activeRoom.authEpoch += 1;
    this.activeRoom.ownerAuthorityEpoch += 1;
    this.activeRoom.runtime = 'sleeping';
    this.reconcileSystemAudio(nowMs);
    this.bumpRoomEpoch(nowMs);
    this.activeRoom.status = 'suspended';
    this.activeRoom.suspensionReason = 'operator_suspended';
    this.activeRoom.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent(), []);
    return this.internalAdminStateResponse(true);
  }

  async handleInternalResume() {
    if (!this.activeRoom.provisioned) return errorResponse('ROOM_NOT_FOUND', 404);
    if (this.activeRoom.status === 'active') return this.internalAdminStateResponse(false);
    if (this.activeRoom.status !== 'suspended') return errorResponse('ROOM_NOT_SUSPENDED', 409);
    if (this.activeRoom.suspensionReason !== 'operator_suspended') {
      return errorResponse('ROOM_OWNER_TRANSFER_REQUIRED', 409);
    }
    if (!this.activeRoom.pin) return errorResponse('ROOM_OWNER_TRANSFER_REQUIRED', 409);
    if (this.activeRoom.revision >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    // A resumed room is available for fresh PIN authentication only. No old
    // presence, cookie session, control channel, or system-audio lease is revived.
    this.discardTransientMemberAuthority();
    this.activeRoom.sessions = {};
    this.activeRoom.presence.participants = {};
    this.activeRoom.presence.coordinatorParticipantId = null;
    this.activeRoom.runtime = 'sleeping';
    this.reconcileSystemAudio(Date.now());
    this.activeRoom.status = 'active';
    this.activeRoom.suspensionReason = null;
    this.activeRoom.revision += 1;
    await this.persist();
    return this.internalAdminStateResponse(true);
  }

  removePresence(participantId: string, nowMs: number) {
    const departed = this.activeRoom.presence.participants[participantId];
    if (!departed) return false;
    const departedIncarnationId = departed.presenceIncarnationId;
    delete this.activeRoom.presence.participants[participantId];
    this.reclaimLiveAccountRepresentativeOrdinal(departed);
    if (
      !departed.accountId &&
      this.activeRoom.anonymousAdministrators?.[departed.memberId] &&
      !Object.values(this.activeRoom.presence.participants).some(
        (participant) => participant.memberId === departed.memberId,
      )
    ) {
      // Anonymous delegation is presence-scoped. Session cookies deliberately
      // outlive a backgrounded tab for resume, but they must not keep an
      // offline administrator visible (or privileged) after the member's last
      // authoritative presence expires/leaves. Authenticated grants remain in
      // accountMembers and are intentionally unaffected.
      this.removeAnonymousAdministrator(departed.memberId);
    }
    this.reconcileSystemAudio(nowMs);
    const remaining = Object.values(this.activeRoom.presence.participants).sort(
      (left, right) =>
        left.joinedAtMs - right.joinedAtMs || left.participantId.localeCompare(right.participantId),
    );
    this.activeRoom.presence.revision += 1;
    if (remaining.length === 0) {
      if (this.activeRoom.pendingPlaybackTransition?.resumeFromSleep === true) {
        this.activeRoom.playback.positionSeconds =
          this.activeRoom.pendingPlaybackTransition.target.positionSeconds;
        this.activeRoom.playback.updatedAtMs = nowMs;
      } else {
        this.freezePlayback(nowMs);
      }
      this.activeRoom.runtime = 'sleeping';
      this.activeRoom.presence.coordinatorParticipantId = null;
      this.bumpRoomEpoch(nowMs);
    } else {
      this.activeRoom.presence.coordinatorParticipantId = null;
      const pending = this.activeRoom.pendingPlaybackTransition;
      if (pending?.cohort.includes(departedIncarnationId)) {
        pending.cohort = pending.cohort.filter((value) => value !== departedIncarnationId);
        delete pending.ready[departedIncarnationId];
        if (playbackTransitionCohortIsTerminal(pending)) {
          const committed = this.commitPendingPlaybackTransition(nowMs);
          if (committed?.event) this.scheduleServerEvent(committed.event);
          if (committed?.cancelEvent) this.scheduleServerEvent(committed.cancelEvent);
        }
      }
    }
    this.activeRoom.revision += 1;
    this.scheduleServerEvent(this.presenceEvent());
    return true;
  }

  async ownerTransferPrepareResponse(
    record: OwnershipTransferPending | OwnershipTransferCompleted,
    replayed: boolean,
  ) {
    const secret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    const commitProof = await ownerTransferCommitProof(this.activeRoom, record, secret);
    if (!constantTimeEqual(await sha256Base64Url(commitProof), record.commitProofHash)) {
      return errorResponse('OWNER_TRANSFER_STATE_INVALID', 409);
    }
    return jsonResponse(
      {
        ok: true,
        roomCode: this.activeRoom.roomCode,
        roomGeneration: this.activeRoom.roomGeneration,
        status: this.activeRoom.status,
        suspensionReason: this.activeRoom.suspensionReason,
        transferId: record.transferId,
        claimGeneration: 'claimGeneration' in record ? record.claimGeneration : null,
        commitProof,
        requestId: record.requestId,
        targetAccountId: record.targetAccountId,
        // The App Worker consumes this field for exact reverse-edge cleanup
        // and must remove it before returning the public facade response.
        previousOwnerAccountId: record.previousOwnerAccountId,
        preparedAtMs: record.preparedAtMs,
        expiresAtMs: record.expiresAtMs,
        committedAtMs: 'committedAtMs' in record ? record.committedAtMs : null,
        replayUntilMs: 'replayUntilMs' in record ? record.replayUntilMs : record.expiresAtMs,
        replayed,
      },
      200,
      { 'cache-control': 'no-store, max-age=0' },
    );
  }

  async restoreCompletedOwnerTransferReplayAuthority(
    record: OwnershipTransferCompleted,
    account: { accountId: string; nickname: string },
    request: Request,
    nowMs: number,
  ) {
    const session = this.activeRoom.sessions[record.sessionTokenHash] || null;
    if (
      this.activeRoom.status !== 'active' ||
      this.activeRoom.suspensionReason !== null ||
      this.activeRoom.ownerAccountId !== record.targetAccountId ||
      this.activeRoom.ownerMemberId !== record.preservedOwnerMemberId ||
      this.activeRoom.authEpoch !== record.authEpoch ||
      this.activeRoom.ownerAuthorityEpoch !== record.ownerAuthorityEpoch ||
      !constantTimeEqual(this.activeRoom.ownerCredentialHash || '', record.ownerCredentialHash) ||
      !session ||
      session.roomGeneration !== this.activeRoom.roomGeneration ||
      session.authEpoch !== this.activeRoom.authEpoch
    ) {
      return errorResponse('OWNER_TRANSFER_COMMIT_SUPERSEDED', 409);
    }
    const participant = this.activeRoom.presence.participants[session.participantId] || null;
    const authorityCurrent =
      session.role === 'owner' &&
      session.accountId === record.targetAccountId &&
      isSafeInteger(session.accountLeaseExpiresAtMs) &&
      session.accountLeaseExpiresAtMs > nowMs;
    const presenceCurrent =
      participant &&
      participant.sessionHash === record.sessionTokenHash &&
      participant.presenceIncarnationId === session.presenceIncarnationId &&
      participant.memberId === record.preservedOwnerMemberId &&
      participant.accountId === record.targetAccountId &&
      participant.role === 'owner';
    if (authorityCurrent && presenceCurrent) return null;
    if (
      this.activeRoom.revision >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.presence.revision >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.presence.coordinatorEpoch >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.playback.revision >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    if (participant && participant.sessionHash !== record.sessionTokenHash) {
      return errorResponse('OWNER_TRANSFER_COMMIT_SUPERSEDED', 409);
    }
    if (
      !participant &&
      Object.keys(this.activeRoom.presence.participants).length >= PRESENCE_MAX_ITEMS
    ) {
      return errorResponse('ROOM_FULL', 409);
    }
    const accountMember = this.prepareOwnerAccountMember(account, nowMs);
    if (!accountMember) return errorResponse('ACCOUNT_MEMBER_CAPACITY_EXCEEDED', 409);
    session.accountId = record.targetAccountId;
    session.accountLeaseExpiresAtMs = this.accountIdentityLeaseExpiresAt(nowMs);
    session.memberId = record.preservedOwnerMemberId;
    session.memberDisplayNumber = 0;
    session.displayName = account.nickname;
    session.role = 'owner';
    this.commitOwnerAccountMember(accountMember);
    if (participant) {
      participant.lastSeenAtMs = nowMs;
      participant.devicePlatform = devicePlatformFromRequest(request);
      this.activeRoom.presence.revision += 1;
      this.activeRoom.revision += 1;
      this.reconcileSystemAudio(nowMs);
      this.scheduleServerEvent(this.presenceEvent());
    } else {
      session.presenceIncarnationId = null;
      if (
        this.joinPresence(
          session,
          record.sessionTokenHash,
          nowMs,
          devicePlatformFromRequest(request),
        ) === null
      ) {
        throw new RoomStateCapacityError();
      }
    }
    await this.persist();
    return null;
  }

  async handleOwnerTransferPrepare(request: Request) {
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['claimToken', 'newPin', 'requestId']) ||
      typeof parsed.value.claimToken !== 'string' ||
      !matchesPattern(parsed.value.newPin, PIN_RE) ||
      !matchesPattern(parsed.value.requestId, OWNER_TRANSFER_REQUEST_ID_RE)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const claimToken = parsed.value.claimToken;
    const newPin = parsed.value.newPin;
    const requestId = parsed.value.requestId;
    const activationSecret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    const pepper = String(this.env.PRO_ROOM_PIN_PEPPER || '');
    if (
      activationSecret.length < 32 ||
      pepper.length < 32 ||
      String(this.env.PRO_ROOM_SESSION_SECRET || '').length < 32
    ) {
      return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    }
    const rateError = await this.applyRateLimit(request, 'owner-transfer', 10, 60 * 60 * 1000);
    if (rateError) return rateError;
    const nowMs = Date.now();
    const inspected = await inspectOwnerTransferClaim(
      claimToken,
      this.activeRoom.roomCode,
      activationSecret,
      nowMs,
    );
    if (!inspected.claim) {
      return errorResponse(inspected.error || 'OWNER_TRANSFER_CLAIM_INVALID', 401);
    }
    const claim = inspected.claim;
    if (claim.roomGeneration !== this.activeRoom.roomGeneration) {
      return errorResponse('OWNER_TRANSFER_CLAIM_INVALID', 401);
    }
    if (this.activeRoom.ownerAuthorityRemoval?.projectionAcked === false) {
      return errorResponse('OWNER_AUTHORITY_PROJECTION_PENDING', 409);
    }
    const nonceHash = await sha256Base64Url(`owner-transfer:${claim.nonce}`);
    const pending = this.activeRoom.pendingOwnershipTransfer;
    const completed = this.activeRoom.completedOwnershipTransfer;
    const matchingRecord =
      pending?.claimNonceHash === nonceHash
        ? pending
        : completed?.claimNonceHash === nonceHash
          ? completed
          : null;
    const consumedClaim = this.activeRoom.consumedOwnershipTransferClaims[nonceHash] || null;
    if (consumedClaim && consumedClaim.requestId !== requestId) {
      return errorResponse('OWNER_TRANSFER_CLAIM_USED', 409);
    }
    if (matchingRecord && matchingRecord.requestId !== requestId) {
      return errorResponse('OWNER_TRANSFER_CLAIM_USED', 409);
    }

    // A completed exact transaction owns a separate short replay receipt.
    // This is the sole exception to claim expiry: it lets the App finish D1
    // reconciliation and return the already-committed deterministic cookies
    // after response loss near the claim deadline. No different request,
    // account, PIN, epoch, session, or nonce can enter this branch.
    if (completed && matchingRecord === completed) {
      if (completed.replayUntilMs <= nowMs) {
        return errorResponse('OWNER_TRANSFER_CLAIM_EXPIRED', 410);
      }
      const asserted = await this.accountAssertion(request);
      if (asserted.response) return asserted.response;
      if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
      if (claim.targetAccountId !== asserted.account.accountId) {
        return errorResponse('OWNER_TRANSFER_TARGET_ACCOUNT_MISMATCH', 409);
      }
      if (
        matchingRecord.targetAccountId !== asserted.account.accountId ||
        matchingRecord.claimNonceHash !== nonceHash
      ) {
        return errorResponse('OWNER_TRANSFER_CLAIM_USED', 409);
      }
      if (!(await verifyPin(newPin, this.activeRoom.pin, pepper))) {
        return errorResponse('OWNER_TRANSFER_REPLAY_MISMATCH', 409);
      }
      const restoreError = await this.restoreCompletedOwnerTransferReplayAuthority(
        completed,
        asserted.account,
        request,
        nowMs,
      );
      if (restoreError) return restoreError;
      return this.ownerTransferPrepareResponse(matchingRecord, true);
    }

    // Every non-completed claim keeps one canonical terminal expiry result,
    // before target-account or stale-generation classification.
    if (inspected.expired) return errorResponse('OWNER_TRANSFER_CLAIM_EXPIRED', 410);
    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
    if (claim.targetAccountId !== asserted.account.accountId) {
      return errorResponse('OWNER_TRANSFER_TARGET_ACCOUNT_MISMATCH', 409);
    }
    if (matchingRecord) {
      if (
        matchingRecord.targetAccountId !== asserted.account.accountId ||
        matchingRecord.claimNonceHash !== nonceHash
      ) {
        return errorResponse('OWNER_TRANSFER_CLAIM_USED', 409);
      }
      if (!('pin' in matchingRecord) || !(await verifyPin(newPin, matchingRecord.pin, pepper))) {
        return errorResponse('OWNER_TRANSFER_REPLAY_MISMATCH', 409);
      }
      return this.ownerTransferPrepareResponse(matchingRecord, true);
    }
    if (
      this.activeRoom.status === 'active' &&
      this.activeRoom.ownerAccountId === asserted.account.accountId
    ) {
      return errorResponse('OWNER_TRANSFER_TARGET_UNCHANGED', 409);
    }
    if (consumedClaim) return errorResponse('OWNER_TRANSFER_CLAIM_USED', 409);

    if (
      claim.claimGeneration !== this.activeRoom.ownershipTransferClaimGeneration ||
      claim.ownerAuthorityEpoch !== this.activeRoom.ownerAuthorityEpoch
    ) {
      return errorResponse('OWNER_TRANSFER_CLAIM_STALE', 409);
    }
    if (
      this.activeRoom.status !== 'active' &&
      !(
        this.activeRoom.status === 'suspended' &&
        (this.activeRoom.suspensionReason === 'operator_suspended' ||
          this.activeRoom.suspensionReason === 'owner_account_deleted' ||
          this.activeRoom.suspensionReason === 'ownership_transfer_pending')
      )
    ) {
      return errorResponse('OWNER_TRANSFER_UNAVAILABLE', 409);
    }
    if (this.activeRoom.pin && (await verifyPin(newPin, this.activeRoom.pin, pepper))) {
      return errorResponse('OWNER_TRANSFER_PIN_REUSE', 409);
    }
    if (
      Object.keys(this.activeRoom.consumedOwnershipTransferClaims).length >=
      OWNER_TRANSFER_NONCE_MAX_ITEMS
    ) {
      return errorResponse('OWNER_TRANSFER_CLAIM_CAPACITY_EXCEEDED', 409);
    }
    const playbackRevisionSteps =
      this.activeRoom.playback.state === 'playing' && this.activeRoom.playback.updatedAtMs > 0
        ? 2
        : 1;
    if (
      this.activeRoom.authEpoch >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.ownerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.developerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.revision >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.presence.revision >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.presence.coordinatorEpoch >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.playback.revision > Number.MAX_SAFE_INTEGER - playbackRevisionSteps
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    if (!OPAQUE_ID_RE.test(this.activeRoom.ownerMemberId || '')) {
      return errorResponse('OWNER_TRANSFER_OWNER_IDENTITY_INVALID', 409);
    }
    const preservedOwnerMemberId = this.activeRoom.ownerMemberId;
    if (preservedOwnerMemberId === null) {
      return errorResponse('OWNER_TRANSFER_OWNER_IDENTITY_INVALID', 409);
    }
    const nextPin = await createPinRecord(newPin, pepper);
    if (
      !(await reserveProRoomOwnershipTransferEntitlement(this.env, {
        targetAccountId: asserted.account.accountId,
        roomCode: this.activeRoom.roomCode,
        roomGeneration: this.activeRoom.roomGeneration,
        requestId,
        nowMs,
      }))
    ) {
      return errorResponse('ACCOUNT_PRO_ROOM_LIMIT_REACHED', 409);
    }
    const previousOwnerAccountId =
      this.activeRoom.pendingOwnershipTransfer?.previousOwnerAccountId ||
      this.activeRoom.ownerAccountId ||
      null;
    this.freezePlayback(nowMs);
    this.activeRoom.sessions = {};
    this.activeRoom.presence.participants = {};
    this.activeRoom.presence.coordinatorParticipantId = null;
    this.activeRoom.presence.revision += 1;
    this.activeRoom.accountMembers = {};
    this.activeRoom.anonymousAdministrators = {};
    this.activeRoom.pin = null;
    this.activeRoom.ownerCredentialHash = null;
    this.activeRoom.ownerAccountId = null;
    this.activeRoom.ownerDisplayName = null;
    this.activeRoom.developerCommands = {};
    this.activeRoom.developerCommandIdempotency = {};
    this.activeRoom.authEpoch += 1;
    this.activeRoom.ownerAuthorityEpoch += 1;
    this.activeRoom.developerAuthorityEpoch += 1;
    this.activeRoom.runtime = 'sleeping';
    this.reconcileSystemAudio(nowMs);
    this.bumpRoomEpoch(nowMs);
    this.activeRoom.status = 'suspended';
    this.activeRoom.suspensionReason = 'ownership_transfer_pending';
    this.activeRoom.completedOwnershipTransfer = null;
    const prepared: OwnershipTransferPending = {
      transferId: `transfer_${randomToken(16)}`,
      requestId,
      targetAccountId: asserted.account.accountId,
      targetDisplayName: asserted.account.nickname,
      previousOwnerAccountId,
      preservedOwnerMemberId,
      pin: nextPin,
      claimNonceHash: nonceHash,
      claimGeneration: claim.claimGeneration,
      ownerAuthorityEpoch: this.activeRoom.ownerAuthorityEpoch,
      preparedAtMs: nowMs,
      expiresAtMs: claim.exp,
      devicePlatform: devicePlatformFromRequest(request),
      commitProofHash: '',
    };
    const commitProof = await ownerTransferCommitProof(this.activeRoom, prepared, activationSecret);
    prepared.commitProofHash = await sha256Base64Url(commitProof);
    this.activeRoom.pendingOwnershipTransfer = prepared;
    this.activeRoom.consumedOwnershipTransferClaims[nonceHash] = {
      requestId,
      expiresAtMs: claim.exp,
    };
    this.activeRoom.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent(), []);
    return this.ownerTransferPrepareResponse(prepared, false);
  }

  async ownerTransferCommitResponse(
    receipt: OwnershipTransferCompleted,
    session: RoomSession,
    sessionToken: string,
    ownerToken: string,
    replayed: boolean,
  ) {
    const response = jsonResponse(
      {
        ok: true,
        roomCode: this.activeRoom.roomCode,
        roomGeneration: this.activeRoom.roomGeneration,
        status: this.activeRoom.status,
        suspensionReason: this.activeRoom.suspensionReason,
        transferId: receipt.transferId,
        requestId: receipt.requestId,
        targetAccountId: receipt.targetAccountId,
        previousOwnerAccountId: receipt.previousOwnerAccountId,
        replayed,
        snapshot: publicSnapshot(this.activeRoom, session),
        session: { expiresAtMs: session.expiresAtMs },
      },
      200,
      {
        'cache-control': 'no-store, max-age=0',
        'set-cookie': sessionCookie(
          this.activeRoom.roomCode,
          sessionToken,
          this.sessionTtlSeconds(),
        ),
      },
    );
    response.headers.append('set-cookie', ownerCookie(this.activeRoom.roomCode, ownerToken));
    return response;
  }

  ownerTransferReconcileResponse(receipt: OwnershipTransferCompleted, replayed: boolean) {
    return jsonResponse(
      {
        ok: true,
        roomCode: this.activeRoom.roomCode,
        roomGeneration: this.activeRoom.roomGeneration,
        status: this.activeRoom.status,
        suspensionReason: this.activeRoom.suspensionReason,
        transferId: receipt.transferId,
        requestId: receipt.requestId,
        targetAccountId: receipt.targetAccountId,
        previousOwnerAccountId: receipt.previousOwnerAccountId,
        replayed,
      },
      200,
      { 'cache-control': 'no-store, max-age=0' },
    );
  }

  async handleInternalOwnerTransferCommit(
    request: Request,
    options: OwnerTransferCommitOptions = {},
  ) {
    const reconcile = options.reconcile === true;
    const parsed = await this.parseBody(request, 16 * 1024);
    if (parsed.response) return parsed.response;
    const requiredKeys = reconcile
      ? ['transferId', 'targetAccountId', 'requestId', 'revocationReceipt']
      : ['transferId', 'commitProof', 'targetAccountId', 'requestId', 'revocationReceipt'];
    if (
      !hasExactKeys(parsed.value, requiredKeys, ['roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.activeRoom.roomGeneration ||
      !matchesPattern(parsed.value.transferId, OWNER_TRANSFER_ID_RE) ||
      (!reconcile && typeof parsed.value.commitProof !== 'string') ||
      !matchesPattern(parsed.value.targetAccountId, ACCOUNT_ID_RE) ||
      !matchesPattern(parsed.value.requestId, OWNER_TRANSFER_REQUEST_ID_RE) ||
      typeof parsed.value.revocationReceipt !== 'string'
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const transferId = parsed.value.transferId;
    const targetAccountId = parsed.value.targetAccountId;
    const requestId = parsed.value.requestId;
    const revocationReceipt = parsed.value.revocationReceipt;
    const commitProof =
      typeof parsed.value.commitProof === 'string' ? parsed.value.commitProof : null;
    const nowMs = Date.now();
    const activationSecret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    const sessionSecret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    const assertionSecret = String(this.env.MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET || '');
    if (activationSecret.length < 32 || sessionSecret.length < 32 || assertionSecret.length < 32) {
      return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    }
    const expected = {
      roomCode: this.activeRoom.roomCode,
      roomGeneration: this.activeRoom.roomGeneration,
      transferId,
      targetAccountId,
      requestId,
    };
    const revocation = await verifyOwnerTransferRevocationReceipt(
      revocationReceipt,
      expected,
      assertionSecret,
      nowMs,
    );
    if (!revocation) return errorResponse('OWNER_TRANSFER_REVOCATION_PROOF_INVALID', 401);
    const matchingRevocationBoundary =
      this.activeRoom.pendingOwnershipTransfer?.transferId === transferId
        ? this.activeRoom.pendingOwnershipTransfer.preparedAtMs
        : this.activeRoom.completedOwnershipTransfer?.transferId === transferId
          ? this.activeRoom.completedOwnershipTransfer.preparedAtMs
          : null;
    if (
      isSafeInteger(matchingRevocationBoundary) &&
      revocation.revokedAtMs < matchingRevocationBoundary
    ) {
      return errorResponse('OWNER_TRANSFER_REVOCATION_PROOF_INVALID', 401);
    }
    const proofHash = reconcile || commitProof === null ? null : await sha256Base64Url(commitProof);
    const completed = this.activeRoom.completedOwnershipTransfer;
    if (completed && completed.transferId === transferId) {
      if (
        completed.requestId !== requestId ||
        completed.targetAccountId !== targetAccountId ||
        (!reconcile &&
          (proofHash === null || !constantTimeEqual(completed.commitProofHash, proofHash)))
      ) {
        return errorResponse('OWNER_TRANSFER_COMMIT_MISMATCH', 409);
      }
      if (reconcile) {
        const expectedProof = await ownerTransferCommitProof(
          this.activeRoom,
          completed,
          activationSecret,
        );
        if (!constantTimeEqual(completed.commitProofHash, await sha256Base64Url(expectedProof))) {
          return errorResponse('OWNER_TRANSFER_COMMIT_MISMATCH', 409);
        }
      }
      if (completed.replayUntilMs <= nowMs) {
        return errorResponse('OWNER_TRANSFER_CLAIM_EXPIRED', 410);
      }
      const sessionToken = await createDeterministicOpaqueCredential(
        sessionSecret,
        `owner-transfer-session:${this.activeRoom.roomCode}:${this.activeRoom.roomGeneration}:${completed.transferId}:${completed.requestId}`,
      );
      const ownerToken = await createDeterministicOpaqueCredential(
        sessionSecret,
        `owner-transfer-owner:${this.activeRoom.roomCode}:${this.activeRoom.roomGeneration}:${completed.transferId}:${completed.requestId}`,
      );
      const [sessionTokenHash, ownerCredentialHash] = await Promise.all([
        sha256Base64Url(sessionToken),
        sha256Base64Url(ownerToken),
      ]);
      const session = this.activeRoom.sessions[sessionTokenHash];
      const participant = session
        ? this.activeRoom.presence.participants[session.participantId] || null
        : null;
      if (
        this.activeRoom.status !== 'active' ||
        this.activeRoom.suspensionReason !== null ||
        this.activeRoom.ownerAccountId !== completed.targetAccountId ||
        this.activeRoom.ownerMemberId !== completed.preservedOwnerMemberId ||
        this.activeRoom.authEpoch !== completed.authEpoch ||
        this.activeRoom.ownerAuthorityEpoch !== completed.ownerAuthorityEpoch ||
        !constantTimeEqual(sessionTokenHash, completed.sessionTokenHash) ||
        !constantTimeEqual(ownerCredentialHash, completed.ownerCredentialHash) ||
        !constantTimeEqual(ownerCredentialHash, this.activeRoom.ownerCredentialHash || '') ||
        !session ||
        session.roomGeneration !== this.activeRoom.roomGeneration ||
        session.authEpoch !== this.activeRoom.authEpoch ||
        session.memberId !== completed.preservedOwnerMemberId ||
        session.accountId !== completed.targetAccountId ||
        session.role !== 'owner' ||
        !isSafeInteger(session.accountLeaseExpiresAtMs) ||
        session.accountLeaseExpiresAtMs <= nowMs ||
        !participant ||
        participant.sessionHash !== sessionTokenHash ||
        participant.presenceIncarnationId !== session.presenceIncarnationId ||
        participant.memberId !== completed.preservedOwnerMemberId ||
        participant.accountId !== completed.targetAccountId ||
        participant.role !== 'owner'
      ) {
        return errorResponse('OWNER_TRANSFER_COMMIT_SUPERSEDED', 409);
      }
      return reconcile
        ? this.ownerTransferReconcileResponse(completed, true)
        : this.ownerTransferCommitResponse(completed, session, sessionToken, ownerToken, true);
    }

    const pending = this.activeRoom.pendingOwnershipTransfer;
    if (
      !pending ||
      this.activeRoom.status !== 'suspended' ||
      this.activeRoom.suspensionReason !== 'ownership_transfer_pending'
    ) {
      return errorResponse('OWNER_TRANSFER_NOT_PENDING', 409);
    }
    if (
      pending.transferId !== transferId ||
      pending.requestId !== requestId ||
      pending.targetAccountId !== targetAccountId ||
      (!reconcile && (proofHash === null || !constantTimeEqual(pending.commitProofHash, proofHash)))
    ) {
      return errorResponse('OWNER_TRANSFER_COMMIT_MISMATCH', 409);
    }
    if (pending.expiresAtMs <= nowMs) return errorResponse('OWNER_TRANSFER_CLAIM_EXPIRED', 410);
    if (this.isAccountDeletionTombstoned(pending.targetAccountId, nowMs)) {
      return errorResponse('OWNER_TRANSFER_TARGET_ACCOUNT_DELETED', 409);
    }
    const expectedProof = await ownerTransferCommitProof(
      this.activeRoom,
      pending,
      activationSecret,
    );
    const proofMatches = reconcile
      ? constantTimeEqual(pending.commitProofHash, await sha256Base64Url(expectedProof))
      : commitProof !== null && constantTimeEqual(expectedProof, commitProof);
    if (!proofMatches) {
      return errorResponse('OWNER_TRANSFER_COMMIT_MISMATCH', 409);
    }
    if (
      this.activeRoom.revision >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.presence.revision >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.presence.coordinatorEpoch >= Number.MAX_SAFE_INTEGER ||
      this.activeRoom.playback.revision >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    const sessionToken = await createDeterministicOpaqueCredential(
      sessionSecret,
      `owner-transfer-session:${this.activeRoom.roomCode}:${this.activeRoom.roomGeneration}:${pending.transferId}:${pending.requestId}`,
    );
    const ownerToken = await createDeterministicOpaqueCredential(
      sessionSecret,
      `owner-transfer-owner:${this.activeRoom.roomCode}:${this.activeRoom.roomGeneration}:${pending.transferId}:${pending.requestId}`,
    );
    const [sessionTokenHash, ownerCredentialHash, revocationReceiptHash] = await Promise.all([
      sha256Base64Url(sessionToken),
      sha256Base64Url(ownerToken),
      sha256Base64Url(revocationReceipt),
    ]);
    const session: RoomSession = {
      roomGeneration: this.activeRoom.roomGeneration,
      memberId: pending.preservedOwnerMemberId,
      participantId: `participant_${randomToken(18)}`,
      presenceIncarnationId: null,
      signalingTicketSequence: 0,
      displayName: pending.targetDisplayName,
      memberDisplayNumber: 0,
      accountId: pending.targetAccountId,
      accountLeaseExpiresAtMs: this.accountIdentityLeaseExpiresAt(nowMs),
      role: 'owner',
      authEpoch: this.activeRoom.authEpoch,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.sessionTtlSeconds() * 1000,
    };
    this.activeRoom.pin = pending.pin;
    this.activeRoom.ownerMemberId = pending.preservedOwnerMemberId;
    this.activeRoom.ownerAccountId = pending.targetAccountId;
    this.activeRoom.ownerDisplayName = pending.targetDisplayName;
    this.activeRoom.accountMembers = {
      [pending.targetAccountId]: {
        memberId: pending.preservedOwnerMemberId,
        displayName: pending.targetDisplayName,
        displayNumber: 0,
        role: 'owner',
        permissions: clonePermissionSet(OWNER_PERMISSIONS),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      },
    };
    this.activeRoom.anonymousAdministrators = {};
    this.activeRoom.sessions = { [sessionTokenHash]: session };
    this.activeRoom.presence.participants = {};
    this.activeRoom.presence.coordinatorParticipantId = null;
    this.activeRoom.ownerCredentialHash = ownerCredentialHash;
    this.activeRoom.status = 'active';
    this.activeRoom.suspensionReason = null;
    this.activeRoom.runtime = 'sleeping';
    if (this.joinPresence(session, sessionTokenHash, nowMs, pending.devicePlatform) === null) {
      return errorResponse('ROOM_FULL', 409);
    }
    const receipt: OwnershipTransferCompleted = {
      transferId: pending.transferId,
      requestId: pending.requestId,
      targetAccountId: pending.targetAccountId,
      previousOwnerAccountId: pending.previousOwnerAccountId,
      preservedOwnerMemberId: pending.preservedOwnerMemberId,
      claimNonceHash: pending.claimNonceHash,
      commitProofHash: pending.commitProofHash,
      revocationReceiptHash,
      ownerAuthorityEpoch: this.activeRoom.ownerAuthorityEpoch,
      authEpoch: this.activeRoom.authEpoch,
      preparedAtMs: pending.preparedAtMs,
      expiresAtMs: pending.expiresAtMs,
      committedAtMs: nowMs,
      replayUntilMs: nowMs + OWNER_TRANSFER_COMPLETED_REPLAY_TTL_MS,
      sessionTokenHash,
      ownerCredentialHash,
    };
    this.activeRoom.completedOwnershipTransfer = receipt;
    this.activeRoom.pendingOwnershipTransfer = null;
    this.activeRoom.ownerAuthorityRemoval = null;
    await this.persist();
    // A non-empty authoritative snapshot at the transfer's newer compatibility
    // epoch releases the signaling-side owner-deletion admission fence. The
    // existing durable retry path keeps signaling closed if delivery fails.
    this.scheduleServerEvent(this.presenceEvent());
    return reconcile
      ? this.ownerTransferReconcileResponse(receipt, false)
      : this.ownerTransferCommitResponse(receipt, session, sessionToken, ownerToken, false);
  }

  async handleActivation(request: Request) {
    if (this.activeRoom.status !== 'unactivated')
      return errorResponse('ACTIVATION_UNAVAILABLE', 409);
    const rateError = await this.applyRateLimit(request, 'activation', 10, 60 * 60 * 1000);
    if (rateError) return rateError;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!hasExactKeys(body, ['claimToken', 'temporaryPin', 'newPin'], ['ownerName'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const claimToken = body.claimToken;
    const temporaryPin = body.temporaryPin;
    const newPin = body.newPin;
    const ownerName =
      body.ownerName === undefined
        ? 'Owner'
        : boundedString(body.ownerName, MAX_DISPLAY_NAME_LENGTH);
    if (
      typeof claimToken !== 'string' ||
      typeof temporaryPin !== 'string' ||
      typeof newPin !== 'string' ||
      !ownerName ||
      !isSafeVisibleDisplayName(ownerName) ||
      !PIN_RE.test(newPin) ||
      newPin === temporaryPin
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const activationSecret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    const pepper = String(this.env.PRO_ROOM_PIN_PEPPER || '');
    if (
      activationSecret.length < 32 ||
      pepper.length < 32 ||
      String(this.env.PRO_ROOM_SESSION_SECRET || '').length < 32
    ) {
      return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    }
    const nowMs = Date.now();
    const [claimValid] = await Promise.all([
      verifyActivationClaim(claimToken, this.activeRoom.roomCode, activationSecret, nowMs),
      // Always perform a digest for the temporary PIN branch so invalid claim
      // and invalid temporary PIN share one externally uniform failure path.
      sha256Bytes(temporaryPin),
    ]);
    const expectedTemporaryPin = this.activeRoom.roomCode.padStart(8, '0');
    const temporaryPinValid =
      PIN_RE.test(temporaryPin) && constantTimeEqual(temporaryPin, expectedTemporaryPin);
    if (
      !claimValid ||
      claimValid.generation !== this.activeRoom.activationClaimGeneration ||
      claimValid.roomGeneration !== this.activeRoom.roomGeneration ||
      !temporaryPinValid
    ) {
      return errorResponse('ACTIVATION_INVALID', 401);
    }

    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
    if (
      claimValid.targetAccountId !== undefined &&
      claimValid.targetAccountId !== asserted.account.accountId
    ) {
      return errorResponse('OWNER_ACCOUNT_LINK_CONFLICT', 409);
    }
    const pin = await createPinRecord(newPin, pepper);
    if (
      !(await reserveProRoomActivationEntitlement(this.env, {
        accountId: asserted.account.accountId,
        roomCode: this.activeRoom.roomCode,
        roomGeneration: this.activeRoom.roomGeneration,
        nowMs,
      }))
    ) {
      return errorResponse('ACCOUNT_PRO_ROOM_LIMIT_REACHED', 409);
    }
    this.activeRoom.status = 'active';
    this.activeRoom.suspensionReason = null;
    this.activeRoom.authEpoch = 1;
    this.activeRoom.ownerAuthorityEpoch = 1;
    this.activeRoom.pin = pin;
    const ownerCredential = await this.createOwnerCredential();
    this.activeRoom.ownerMemberId = this.activeRoom.ownerMemberId || `owner_${randomToken(18)}`;
    const accountMember = this.resolveAccountMember(asserted.account, 'owner', nowMs);
    const created = await this.createSessionRecord(
      'owner',
      accountMember?.displayName || ownerName,
      nowMs,
      this.activeRoom.ownerMemberId,
      accountMember,
    );
    if (!created || !ownerCredential) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    this.activeRoom.ownerCredentialHash = ownerCredential.hash;
    this.activeRoom.ownerDisplayName = created.session.displayName;
    this.joinPresence(
      created.session,
      created.tokenHash,
      nowMs,
      devicePlatformFromRequest(request),
    );
    await this.persist();
    this.markRegistryActivationActive();
    await finalizeProRoomActivationEntitlement(this.env, {
      accountId: asserted.account.accountId,
      roomCode: this.activeRoom.roomCode,
      roomGeneration: this.activeRoom.roomGeneration,
      nowMs,
    }).catch(() => false);
    const response = jsonResponse(
      {
        snapshot: publicSnapshot(this.activeRoom, created.session),
      },
      200,
      {
        'set-cookie': sessionCookie(
          this.activeRoom.roomCode,
          created.token,
          this.sessionTtlSeconds(),
        ),
      },
    );
    response.headers.append(
      'set-cookie',
      ownerCookie(this.activeRoom.roomCode, ownerCredential.token),
    );
    return response;
  }

  async handleOwnerRecovery(request: Request) {
    if (this.activeRoom.status !== 'active') return errorResponse('RECOVERY_UNAVAILABLE', 409);
    const rateError = await this.applyRateLimit(request, 'owner-recovery', 10, 60 * 60 * 1000);
    if (rateError) return rateError;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['claimToken']) ||
      typeof parsed.value.claimToken !== 'string'
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const activationSecret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    if (
      activationSecret.length < 32 ||
      String(this.env.PRO_ROOM_SESSION_SECRET || '').length < 32
    ) {
      return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    }
    const nowMs = Date.now();
    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    // Ownership recovery is an account-binding operation, not an anonymous
    // bearer-login escape hatch. A missing assertion must fail before the
    // claim or any existing owner state can be consumed.
    if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
    const claim = await verifyOwnerRecoveryClaim(
      parsed.value.claimToken,
      this.activeRoom.roomCode,
      activationSecret,
      nowMs,
    );
    if (
      !claim ||
      claim.roomGeneration !== this.activeRoom.roomGeneration ||
      claim.ownerAuthorityEpoch !== this.activeRoom.ownerAuthorityEpoch
    ) {
      return errorResponse('RECOVERY_INVALID', 401);
    }
    const nonceHash = await sha256Base64Url(`owner-recovery:${claim.nonce}`);
    if (this.activeRoom.consumedRecoveryNonces[nonceHash]) {
      return errorResponse('RECOVERY_CLAIM_USED', 409);
    }
    if (Object.keys(this.activeRoom.consumedRecoveryNonces).length >= RECOVERY_NONCE_MAX_ITEMS) {
      return errorResponse('RECOVERY_CAPACITY_EXCEEDED', 409);
    }

    // Validate the recovery claim before exposing whether this room is linked
    // to another account. A valid claim still cannot transfer a linked room,
    // and every account-capacity check remains non-mutating so the same claim
    // can be retried after the operator resolves the account condition.
    if (
      !ACCOUNT_ID_RE.test(this.activeRoom.ownerAccountId || '') ||
      this.activeRoom.ownerAccountId !== asserted.account.accountId
    ) {
      return errorResponse('OWNER_ACCOUNT_LINK_CONFLICT', 409);
    }
    const accountMember = this.prepareOwnerAccountMember(asserted.account, nowMs);
    if (!accountMember) return errorResponse('ACCOUNT_MEMBER_CAPACITY_EXCEEDED', 409);
    const ownerCredential = await this.createOwnerCredential();
    if (!ownerCredential) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    if (this.activeRoom.ownerAuthorityEpoch >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    // The recovery page can be opened from a browser that is already present
    // as an ordinary room member. Its response replaces that browser's
    // session cookie, so retire the superseded physical session now instead
    // of leaving an unreachable owner presence behind until TTL expiry. Other
    // devices of the same proven account remain live and are upgraded below.
    const recoveringSession = await this.authenticate(request);
    if (recoveringSession) {
      this.removePresence(recoveringSession.session.participantId, nowMs);
      this.removeSessionRecord(recoveringSession.tokenHash);
    }
    for (const [tokenHash, session] of Object.entries(this.activeRoom.sessions)) {
      if (session.role !== 'owner') continue;
      this.removePresence(session.participantId, nowMs);
      this.removeSessionRecord(tokenHash);
    }
    const created = await this.createSessionRecord(
      'owner',
      accountMember.displayName,
      nowMs,
      this.activeRoom.ownerMemberId,
      accountMember,
    );
    if (!created) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    this.commitOwnerAccountMember(accountMember);
    this.activeRoom.ownerAuthorityEpoch += 1;
    this.activeRoom.ownerCredentialHash = ownerCredential.hash;
    this.activeRoom.ownerDisplayName = created.session.displayName;
    this.activeRoom.consumedRecoveryNonces[nonceHash] = claim.exp;
    this.joinPresence(
      created.session,
      created.tokenHash,
      nowMs,
      devicePlatformFromRequest(request),
    );
    await this.persist();
    const response = jsonResponse(
      {
        snapshot: publicSnapshot(this.activeRoom, created.session),
      },
      200,
      {
        'set-cookie': sessionCookie(
          this.activeRoom.roomCode,
          created.token,
          this.sessionTtlSeconds(),
        ),
      },
    );
    response.headers.append(
      'set-cookie',
      ownerCookie(this.activeRoom.roomCode, ownerCredential.token),
    );
    return response;
  }

  async handleCreateSession(request: Request) {
    if (this.activeRoom.status === 'unactivated') return errorResponse('ACTIVATION_REQUIRED', 409);
    if (this.activeRoom.status === 'suspended') return errorResponse('ROOM_SUSPENDED', 423);
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!isRecord(body)) return errorResponse('INVALID_REQUEST', 400);
    const legacyBody = hasExactKeys(body, ['pin']);
    const idempotentBody = hasExactKeys(body, ['pin', 'requestId']);
    const pin = typeof body.pin === 'string' ? body.pin : null;
    const requestId = idempotentBody && typeof body.requestId === 'string' ? body.requestId : null;
    if (
      (!legacyBody && !idempotentBody) ||
      pin === null ||
      !PIN_RE.test(pin) ||
      (idempotentBody && (requestId === null || !IDEMPOTENCY_KEY_RE.test(requestId)))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const pepper = String(this.env.PRO_ROOM_PIN_PEPPER || '');
    const sessionSecret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (pepper.length < 32 || sessionSecret.length < 32) {
      return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    }
    const nowMs = Date.now();
    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    const ownerCredential = await this.hasOwnerCredential(request);
    let scope = null;
    let fingerprint = null;
    let credentialContext = null;
    let idempotencyRecords = null;
    if (requestId !== null) {
      const actorHint = request.headers.get(PRO_ROOM_SESSION_ACTOR_HEADER) || '';
      // The App facade derives this stable, authority-free actor from the
      // room-scoped 192-bit client requestId before optional account lookup.
      // A newly issued session cookie or recovered account assertion must
      // never change idempotency scope after an outcome-unknown response.
      const actorIdentity = PRO_ROOM_SESSION_ACTOR_RE.test(actorHint)
        ? `facade:${actorHint}`
        : `network:${request.headers.get('x-mxqr-pro-ip-hash') || 'internal-test'}`;
      const actorHash = await sha256Base64Url(actorIdentity);
      scope = `session-create:${actorHash}`;
      fingerprint = await hmacBase64Url(
        sessionSecret,
        `session-create-fingerprint:v1\u0000${scope}\u0000${JSON.stringify({
          pin,
          requestId,
        })}`,
      );
      credentialContext = [
        'session-create:v1',
        this.activeRoom.roomCode,
        String(this.activeRoom.roomGeneration),
        scope,
        requestId,
        fingerprint,
      ].join('\u0000');
      const deterministicToken = await createDeterministicOpaqueCredential(
        sessionSecret,
        credentialContext,
      );
      const deterministicTokenHash = await sha256Base64Url(deterministicToken);
      const existingReceipt = this.idempotencyRecord(scope, requestId);
      if (existingReceipt) {
        if (!constantTimeEqual(existingReceipt.fingerprint || '', fingerprint)) {
          return errorResponse('IDEMPOTENCY_CONFLICT', 409);
        }
        const receiptTokenHash = existingReceipt.tokenHash;
        const receiptParticipantId = existingReceipt.participantId;
        if (
          existingReceipt.kind !== 'session-create' ||
          existingReceipt.status !== 200 ||
          typeof receiptTokenHash !== 'string' ||
          !SHA256_RE.test(receiptTokenHash) ||
          typeof receiptParticipantId !== 'string' ||
          !OPAQUE_ID_RE.test(receiptParticipantId)
        ) {
          return errorResponse('ROOM_STATE_INVALID', 503);
        }
        const replaySession = this.activeRoom.sessions[receiptTokenHash];
        if (
          !constantTimeEqual(deterministicTokenHash, receiptTokenHash) ||
          !replaySession ||
          replaySession.participantId !== receiptParticipantId ||
          replaySession.expiresAtMs <= nowMs ||
          replaySession.authEpoch !== this.activeRoom.authEpoch ||
          replaySession.roomGeneration !== this.activeRoom.roomGeneration
        ) {
          // The receipt remains an exactly-once fence until its short TTL ends.
          // Never turn an explicitly closed or capacity-evicted session into a
          // second admission under the same logical request.
          return errorResponse('SESSION_REPLAY_UNAVAILABLE', 409);
        }
        if (!this.activeRoom.presence.participants[replaySession.participantId]) {
          if (
            this.joinPresence(
              replaySession,
              deterministicTokenHash,
              nowMs,
              devicePlatformFromRequest(request),
            ) === null
          ) {
            return errorResponse('ROOM_FULL', 409);
          }
        }
        // A prior storage failure can leave a receipt/session visible in this
        // isolate even though the durable transaction did not commit (for
        // example, a compatibility storage implementation without the outer
        // rollback seam). Converge durability before returning any replayed
        // credential, even when its presence was already resident in memory.
        await this.persist();
        const remainingTtlSeconds = Math.max(
          1,
          Math.ceil((replaySession.expiresAtMs - nowMs) / 1000),
        );
        return jsonResponse(
          {
            snapshot: publicSnapshot(this.activeRoom, replaySession),
            session: { expiresAtMs: replaySession.expiresAtMs },
          },
          200,
          {
            'set-cookie': sessionCookie(
              this.activeRoom.roomCode,
              deterministicToken,
              remainingTtlSeconds,
            ),
            ...(replaySession.accountId ? { 'x-mxqr-account-linked': '1' } : {}),
          },
        );
      }

      // The compact receipt intentionally expires before the session. An
      // outcome-unknown retry can therefore arrive after its receipt was
      // pruned while the deterministic credential is still authoritative.
      // Reuse that exact live session and recreate the receipt; overwriting
      // the same tokenHash with a new participant would orphan the prior
      // presence and turn one logical admission into two identities.
      const recoveredSession = this.activeRoom.sessions[deterministicTokenHash];
      if (recoveredSession) {
        if (
          !OPAQUE_ID_RE.test(recoveredSession.participantId || '') ||
          recoveredSession.expiresAtMs <= nowMs ||
          recoveredSession.authEpoch !== this.activeRoom.authEpoch ||
          recoveredSession.roomGeneration !== this.activeRoom.roomGeneration
        ) {
          return errorResponse('ROOM_STATE_INVALID', 503);
        }
        if (!this.activeRoom.presence.participants[recoveredSession.participantId]) {
          if (
            this.joinPresence(
              recoveredSession,
              deterministicTokenHash,
              nowMs,
              devicePlatformFromRequest(request),
            ) === null
          ) {
            return errorResponse('ROOM_FULL', 409);
          }
        }
        const recoveredRecords = this.reserveIdempotencySlot(scope, requestId, nowMs);
        recoveredRecords[`${scope}:${requestId}`] = {
          kind: 'session-create',
          fingerprint,
          status: 200,
          tokenHash: deterministicTokenHash,
          participantId: recoveredSession.participantId,
          expiresAtMs: Math.min(
            recoveredSession.expiresAtMs,
            nowMs + SESSION_CREATE_IDEMPOTENCY_TTL_MS,
          ),
        };
        await this.persist();
        const remainingTtlSeconds = Math.max(
          1,
          Math.ceil((recoveredSession.expiresAtMs - nowMs) / 1000),
        );
        return jsonResponse(
          {
            snapshot: publicSnapshot(this.activeRoom, recoveredSession),
            session: { expiresAtMs: recoveredSession.expiresAtMs },
          },
          200,
          {
            'set-cookie': sessionCookie(
              this.activeRoom.roomCode,
              deterministicToken,
              remainingTtlSeconds,
            ),
            ...(recoveredSession.accountId ? { 'x-mxqr-account-linked': '1' } : {}),
          },
        );
      }
    }
    // The one-field legacy body remains accepted during the cached-client
    // rollout. It cannot be safely collapsed by IP/PIN/User-Agent without
    // merging distinct devices behind the same NAT, so only v1 clients that
    // supply an opaque requestId receive exactly-once replay semantics.
    const rateError = this.readRateLimit(request, 'pin-failure', 10);
    if (rateError) return rateError;
    if (!(await verifyPin(pin, this.activeRoom.pin, pepper))) {
      this.recordRateLimitHit(request, 'pin-failure', 60 * 60 * 1000);
      await this.persist();
      return errorResponse('PIN_INVALID', 401);
    }
    if (requestId !== null && scope) {
      // Capacity is reserved before account/session state is touched, so a
      // full receipt ledger fails closed without a partially admitted identity.
      idempotencyRecords = this.reserveIdempotencySlot(scope, requestId, nowMs);
    }
    const role =
      (ownerCredential && this.activeRoom.ownerAccountId === null) ||
      (asserted.account && this.activeRoom.ownerAccountId === asserted.account.accountId)
        ? 'owner'
        : 'member';
    const accountMember = asserted.account
      ? this.resolveAccountMember(asserted.account, role, nowMs)
      : null;
    if (
      asserted.account &&
      !accountMember &&
      !(role === 'owner' && this.activeRoom.ownerAccountId !== null)
    ) {
      return errorResponse('ACCOUNT_MEMBER_CAPACITY_EXCEEDED', 409);
    }
    const created = await this.createSessionRecord(
      accountMember?.role || role,
      accountMember?.displayName ||
        (role === 'owner'
          ? this.activeRoom.ownerDisplayName || 'Owner'
          : DEFAULT_PEER_DISPLAY_NAME),
      nowMs,
      accountMember?.memberId || (role === 'owner' ? this.activeRoom.ownerMemberId : null),
      accountMember,
      credentialContext,
    );
    if (!created) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    if (
      this.joinPresence(
        created.session,
        created.tokenHash,
        nowMs,
        devicePlatformFromRequest(request),
      ) === null
    ) {
      this.removeSessionRecord(created.tokenHash);
      return errorResponse('ROOM_FULL', 409);
    }
    if (idempotencyRecords && scope && fingerprint && requestId !== null) {
      idempotencyRecords[`${scope}:${requestId}`] = {
        kind: 'session-create',
        fingerprint,
        status: 200,
        tokenHash: created.tokenHash,
        participantId: created.session.participantId,
        expiresAtMs: Math.min(
          created.session.expiresAtMs,
          nowMs + SESSION_CREATE_IDEMPOTENCY_TTL_MS,
        ),
      };
    }
    await this.persist();
    return jsonResponse(
      {
        snapshot: publicSnapshot(this.activeRoom, created.session),
        session: { expiresAtMs: created.session.expiresAtMs },
      },
      200,
      {
        'set-cookie': sessionCookie(
          this.activeRoom.roomCode,
          created.token,
          this.sessionTtlSeconds(),
        ),
        ...(accountMember ? { 'x-mxqr-account-linked': '1' } : {}),
      },
    );
  }

  async handleGetSnapshot(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    return jsonResponse({
      snapshot: publicSnapshot(this.activeRoom, auth.session),
    });
  }

  async handleAttachCurrentAccount(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, SMALL_REQUEST_MAX_BYTES, false, true);
    if (parsed.response) return parsed.response;
    if (!parsed.empty) return errorResponse('INVALID_REQUEST', 400);
    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
    if (auth.session.accountId && auth.session.accountId !== asserted.account.accountId) {
      return errorResponse('SESSION_ACCOUNT_CONFLICT', 409);
    }
    if (
      auth.session.role === 'owner' &&
      this.activeRoom.ownerAccountId &&
      this.activeRoom.ownerAccountId !== asserted.account.accountId
    ) {
      return errorResponse('OWNER_ACCOUNT_LINK_CONFLICT', 409);
    }
    const nowMs = Date.now();
    const existingMember = this.activeRoom.accountMembers?.[asserted.account.accountId] || null;
    const existingParticipant =
      this.activeRoom.presence.participants[auth.session.participantId] || null;
    if (
      auth.session.accountId === asserted.account.accountId &&
      existingMember &&
      existingMember.displayName === asserted.account.nickname &&
      auth.session.memberId === existingMember.memberId &&
      auth.session.memberDisplayNumber === existingMember.displayNumber &&
      auth.session.displayName === existingMember.displayName &&
      auth.session.role === existingMember.role &&
      (!existingParticipant ||
        (existingParticipant.accountId === asserted.account.accountId &&
          existingParticipant.memberId === existingMember.memberId &&
          existingParticipant.memberDisplayNumber === existingMember.displayNumber &&
          existingParticipant.displayName === existingMember.displayName &&
          existingParticipant.role === existingMember.role))
    ) {
      // Account refresh/focus reconciliation may prove the same HttpOnly
      // identity repeatedly. Keep that path revision-idempotent so safety does
      // not turn into a periodic presence broadcast.
      if (
        !isSafeInteger(auth.session.accountLeaseExpiresAtMs) ||
        auth.session.accountLeaseExpiresAtMs <= nowMs + ACCOUNT_IDENTITY_LEASE_RENEW_THRESHOLD_MS
      ) {
        auth.session.accountLeaseExpiresAtMs = this.accountIdentityLeaseExpiresAt(nowMs);
        await this.persist({ retainEarlierAlarm: true });
      }
      return jsonResponse(
        {
          snapshot: publicSnapshot(this.activeRoom, auth.session),
        },
        200,
        {
          'x-mxqr-account-linked': '1',
        },
      );
    }
    const role =
      auth.session.role === 'owner' || this.activeRoom.ownerAccountId === asserted.account.accountId
        ? 'owner'
        : 'member';
    const accountMember = this.resolveAccountMember(asserted.account, role, nowMs);
    if (!accountMember) return errorResponse('ACCOUNT_MEMBER_CAPACITY_EXCEEDED', 409);
    const previousAnonymousMemberId = auth.session.accountId ? null : auth.session.memberId;
    if (previousAnonymousMemberId) {
      // An ephemeral anonymous grant must never become a persistent account
      // grant merely because the same tab signs in. The owner can delegate to
      // the newly proven account explicitly after attachment.
      this.removeAnonymousAdministrator(previousAnonymousMemberId);
    }
    auth.session.accountId = accountMember.accountId;
    auth.session.memberId = accountMember.memberId;
    auth.session.memberDisplayNumber = accountMember.displayNumber;
    auth.session.displayName = accountMember.displayName;
    auth.session.role = accountMember.role;
    auth.session.accountLeaseExpiresAtMs = this.accountIdentityLeaseExpiresAt(nowMs);
    this.syncAccountMemberSessions(accountMember.accountId, accountMember);
    this.activeRoom.presence.revision += 1;
    this.activeRoom.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent());
    return jsonResponse(
      {
        snapshot: publicSnapshot(this.activeRoom, auth.session),
      },
      200,
      {
        'x-mxqr-account-linked': '1',
      },
    );
  }

  async handleRenewCurrentAccountLease(request: Request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, SMALL_REQUEST_MAX_BYTES, false, true);
    if (parsed.response) return parsed.response;
    if (!parsed.empty) return errorResponse('INVALID_REQUEST', 400);
    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
    if (!auth.session.accountId) return errorResponse('ACCOUNT_REATTACH_REQUIRED', 409);
    if (auth.session.accountId !== asserted.account.accountId) {
      return errorResponse('SESSION_ACCOUNT_CONFLICT', 409);
    }
    const member = this.activeRoom.accountMembers?.[auth.session.accountId] || null;
    if (!member || member.memberId !== auth.session.memberId) {
      return errorResponse('ACCOUNT_REATTACH_REQUIRED', 409);
    }

    const nowMs = Date.now();
    if (
      !isSafeInteger(auth.session.accountLeaseExpiresAtMs) ||
      auth.session.accountLeaseExpiresAtMs <= nowMs + ACCOUNT_IDENTITY_LEASE_RENEW_THRESHOLD_MS
    ) {
      auth.session.accountLeaseExpiresAtMs = this.accountIdentityLeaseExpiresAt(nowMs);
      // This endpoint cannot create an account-room relationship and changes no
      // public revision. Keep the durable proof, but avoid rewriting the v1
      // rollback shadow or moving an already-earlier alarm on every renewal.
      await this.persist({ retainEarlierAlarm: true });
    }
    return jsonResponse({
      ok: true,
      leaseExpiresAtMs: auth.session.accountLeaseExpiresAtMs,
    });
  }

  async handleDetachCurrentAccount(request: Request) {
    // Account logout is independent from transport presence. In particular,
    // a backgrounded tab may have lost its live presence while its resumable
    // room session cookie is still valid. Authenticate that exact cookie, but
    // do not require or revive presence merely to drop account authority.
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, SMALL_REQUEST_MAX_BYTES, false, true);
    if (parsed.response) return parsed.response;
    if (!parsed.empty) return errorResponse('INVALID_REQUEST', 400);
    const detachResponse = (session: RoomSession, participant: PresenceParticipant | null) => {
      const snapshot = participant ? publicSnapshot(this.activeRoom, session) : null;
      return jsonResponse({ ok: true, detached: true, snapshot });
    };

    // Repeated logout/cross-tab reconciliation is deliberately idempotent.
    if (!auth.session.accountId) {
      const participant = this.activeRoom.presence.participants[auth.session.participantId] || null;
      return detachResponse(auth.session, participant);
    }

    const participant = this.activeRoom.presence.participants[auth.session.participantId] || null;
    if (
      this.activeRoom.revision >= Number.MAX_SAFE_INTEGER ||
      (participant && this.activeRoom.presence.revision >= Number.MAX_SAFE_INTEGER)
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    const nowMs = Date.now();
    const detached = this.detachAccountSession(auth.session, nowMs, {
      requireUniqueDisplayNumber: true,
      touchPresence: true,
    });
    if (!detached) return errorResponse('ACCOUNT_DETACH_CAPACITY_EXCEEDED', 409);
    // The account member record (including any persistent delegation) and
    // ownerAccountId intentionally remain untouched. Other devices linked to
    // the same account therefore keep their identity and authority.
    await this.persist();
    if (participant) this.scheduleServerEvent(this.presenceEvent());
    return detachResponse(auth.session, participant);
  }

  async handleEnterPresence(request: Request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    let takeover = false;
    const parsed = await this.parseBody(request, SMALL_REQUEST_MAX_BYTES, false, true);
    if (parsed.response) return parsed.response;
    if (!parsed.empty) {
      if (!hasExactKeys(parsed.value, ['takeover']) || parsed.value.takeover !== true) {
        return errorResponse('INVALID_REQUEST', 400);
      }
      takeover = true;
    }
    const entered = this.enterPresence(
      auth.session,
      auth.tokenHash,
      Date.now(),
      takeover,
      devicePlatformFromRequest(request),
    );
    if (entered === 'room-full') return errorResponse('ROOM_FULL', 409);
    if (entered === 'active-elsewhere') {
      return errorResponse('PRESENCE_ACTIVE_ELSEWHERE', 409);
    }
    if (entered === 'identity-mismatch') {
      return errorResponse('PRESENCE_IDENTITY_MISMATCH', 409);
    }
    await this.persist();
    return jsonResponse({
      snapshot: publicSnapshot(this.activeRoom, auth.session),
    });
  }

  async handleCloseSession(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    this.removePresence(auth.session.participantId, Date.now());
    this.removeSessionRecord(auth.tokenHash);
    await this.persist();
    // The browser token is inert once its exact server record is removed. Do
    // not return a same-name cookie tombstone: a delayed response could arrive
    // after a replacement tab has installed a new room cookie and erase it.
    return jsonResponse({ ok: true });
  }

  async handleCloseSessionFenced(request: Request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, UNLOAD_CLOSE_REQUEST_MAX_BYTES, true);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (
      !hasExactKeys(body, ['expectedParticipantId', 'expectedPresenceIncarnationId']) ||
      typeof body.expectedParticipantId !== 'string' ||
      !OPAQUE_ID_RE.test(body.expectedParticipantId) ||
      typeof body.expectedPresenceIncarnationId !== 'string' ||
      !OPAQUE_ID_RE.test(body.expectedPresenceIncarnationId)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (
      auth.session.participantId !== body.expectedParticipantId ||
      auth.session.presenceIncarnationId !== body.expectedPresenceIncarnationId
    ) {
      return errorResponse('PRESENCE_IDENTITY_MISMATCH', 409);
    }
    const participant = this.activeRoom.presence.participants[body.expectedParticipantId];
    if (
      participant &&
      (participant.sessionHash !== auth.tokenHash ||
        participant.presenceIncarnationId !== body.expectedPresenceIncarnationId)
    ) {
      return errorResponse('PRESENCE_IDENTITY_MISMATCH', 409);
    }

    // The atomic presence close may already have removed the participant. The
    // session deliberately retains its last incarnation so this second phase
    // can still revoke exactly the server record represented by that cookie,
    // while a newer explicit enter rotates the value and fences this request
    // with a harmless 409.
    this.removePresence(body.expectedParticipantId, Date.now());
    this.removeSessionRecord(auth.tokenHash);
    await this.persist();
    // Do not emit a cookie tombstone here. This response may arrive after a
    // different tab has authenticated again and installed a newer cookie with
    // the same room-scoped name; a delayed Max-Age=0 header would erase that
    // replacement even though the server mutation was correctly fenced to the
    // captured session/incarnation. The exact server-side session is already
    // revoked above, so leaving its now-inert browser token is the safe choice.
    return jsonResponse({ ok: true });
  }

  async handleChangePin(request: Request) {
    const auth = await this.requireSession(request, { owner: true, activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['pin']) || !matchesPattern(parsed.value.pin, PIN_RE)) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const pepper = String(this.env.PRO_ROOM_PIN_PEPPER || '');
    if (pepper.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    const nextPin = await createPinRecord(parsed.value.pin, pepper);
    this.activeRoom.authEpoch += 1;
    this.activeRoom.pin = nextPin;
    const ownerSession = auth.session;
    ownerSession.authEpoch = this.activeRoom.authEpoch;
    const nowMs = Date.now();
    for (const tokenHash of Object.keys(this.activeRoom.sessions)) {
      if (tokenHash === auth.tokenHash) continue;
      this.removeSessionRecord(tokenHash);
    }
    // Revoke every other participant atomically. A PIN rotation advances the
    // room-incarnation fence exactly once; no browser gains server authority.
    const ownerParticipant = auth.participant;
    ownerParticipant.lastSeenAtMs = nowMs;
    this.activeRoom.presence.participants = {
      [ownerSession.participantId]: ownerParticipant,
    };
    this.reconcileSystemAudio(nowMs);
    this.activeRoom.presence.coordinatorParticipantId = null;
    this.activeRoom.presence.revision += 1;
    this.activeRoom.runtime = 'awake';
    this.bumpRoomEpoch(nowMs);
    this.activeRoom.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent());
    return jsonResponse({ ok: true });
  }

  async handleHeartbeat(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, SMALL_REQUEST_MAX_BYTES, false, true);
    if (parsed.response) return parsed.response;
    const known = parsed.empty ? null : parsed.value;
    if (
      known !== null &&
      (!hasExactKeys(known, [
        'revision',
        'playlistRevision',
        'presenceRevision',
        'playbackRevision',
        'coordinatorEpoch',
      ]) ||
        !isSafeNonNegativeInteger(known.revision) ||
        !isSafeNonNegativeInteger(known.playlistRevision) ||
        !isSafeNonNegativeInteger(known.presenceRevision) ||
        !isSafeNonNegativeInteger(known.playbackRevision) ||
        !isSafeNonNegativeInteger(known.coordinatorEpoch))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const nowMs = Date.now();
    const hadPeerOrdinal = Object.prototype.hasOwnProperty.call(auth.session, 'peerOrdinal');
    const previousPeerOrdinal = auth.session.peerOrdinal;
    const previousSessionDisplayName = auth.session.displayName;
    const previousSessionMemberDisplayNumber = auth.session.memberDisplayNumber;
    const previousParticipantDisplayName = auth.participant.displayName;
    const previousParticipantMemberDisplayNumber = auth.participant.memberDisplayNumber;
    const accountMember = auth.session.accountId
      ? this.activeRoom.accountMembers?.[auth.session.accountId]
      : null;
    const previousAccountIdentity = accountMember
      ? { displayNumber: accountMember.displayNumber }
      : null;
    const anonymousAdministrator = !auth.session.accountId
      ? this.activeRoom.anonymousAdministrators?.[auth.session.memberId]
      : null;
    const previousAdministratorIdentity = anonymousAdministrator
      ? {
          displayName: anonymousAdministrator.displayName,
          displayNumber: anonymousAdministrator.displayNumber,
        }
      : null;
    const canonicalPeerIdentity = this.ensureSessionPeerIdentity(auth.session);
    const displayIdentityChanged =
      canonicalPeerIdentity.stateChanged || canonicalPeerIdentity.publicChanged;
    if (
      displayIdentityChanged &&
      (this.activeRoom.revision >= Number.MAX_SAFE_INTEGER ||
        this.activeRoom.presence.revision >= Number.MAX_SAFE_INTEGER)
    ) {
      if (hadPeerOrdinal && previousPeerOrdinal !== undefined) {
        auth.session.peerOrdinal = previousPeerOrdinal;
      } else delete auth.session.peerOrdinal;
      auth.session.displayName = previousSessionDisplayName;
      if (previousSessionMemberDisplayNumber !== undefined) {
        auth.session.memberDisplayNumber = previousSessionMemberDisplayNumber;
      } else {
        delete auth.session.memberDisplayNumber;
      }
      auth.participant.displayName = previousParticipantDisplayName;
      if (previousParticipantMemberDisplayNumber !== undefined) {
        auth.participant.memberDisplayNumber = previousParticipantMemberDisplayNumber;
      } else {
        delete auth.participant.memberDisplayNumber;
      }
      if (accountMember && previousAccountIdentity) {
        accountMember.displayNumber = previousAccountIdentity.displayNumber;
      }
      if (anonymousAdministrator && previousAdministratorIdentity) {
        anonymousAdministrator.displayName = previousAdministratorIdentity.displayName;
        anonymousAdministrator.displayNumber = previousAdministratorIdentity.displayNumber;
      }
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    if (displayIdentityChanged) {
      this.activeRoom.presence.revision += 1;
      this.activeRoom.revision += 1;
    }
    const previousLastSeenAtMs = this.persistedPresenceLastSeenAtMs.get(
      auth.participant.participantId,
    );
    const nearPersistedExpiry =
      !isSafeInteger(previousLastSeenAtMs) ||
      previousLastSeenAtMs + this.presenceTtlMs() <=
        nowMs + PRESENCE_HEARTBEAT_PERSIST_EXPIRY_GUARD_MS;
    const recoveringUnscheduledHeartbeat =
      this.heartbeatDurabilityDirty && this.pendingHeartbeatFlushGeneration === null;
    auth.participant.lastSeenAtMs = nowMs;
    this.heartbeatDurabilityDirty = true;
    const developerCommandsChanged = await this.processDeveloperCommands(nowMs);
    if (
      displayIdentityChanged ||
      canonicalPeerIdentity.stateChanged ||
      developerCommandsChanged ||
      nearPersistedExpiry ||
      recoveringUnscheduledHeartbeat ||
      !this.scheduleHeartbeatDurability(nowMs)
    ) {
      await this.persist({ retainEarlierAlarm: true });
    }
    if (displayIdentityChanged) this.scheduleServerEvent(this.presenceEvent());
    if (
      known !== null &&
      known.revision === this.activeRoom.revision &&
      known.playlistRevision === this.activeRoom.playlistRevision &&
      known.presenceRevision === this.activeRoom.presence.revision &&
      known.playbackRevision === this.activeRoom.playback.revision &&
      known.coordinatorEpoch === this.activeRoom.presence.coordinatorEpoch
    ) {
      return jsonResponse({
        notModified: true,
        revision: this.activeRoom.revision,
        playlistRevision: this.activeRoom.playlistRevision,
        presenceRevision: this.activeRoom.presence.revision,
        playbackRevision: this.activeRoom.playback.revision,
        coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
      });
    }
    return jsonResponse({
      snapshot: publicSnapshot(this.activeRoom, auth.session),
    });
  }

  async handleLeavePresence(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    // The v1 client contract requires an awake snapshot's viewer to remain in
    // its presence list. When other peers remain, return the last internally
    // consistent departing snapshot while persisting the newer server state;
    // the caller is leaving and must not apply a phantom post-leave viewer.
    const departingSnapshot = publicSnapshot(this.activeRoom, auth.session);
    const hadOtherParticipants = Object.keys(this.activeRoom.presence.participants).length > 1;
    this.removePresence(auth.session.participantId, Date.now());
    await this.persist();
    return jsonResponse({
      snapshot: hadOtherParticipants
        ? departingSnapshot
        : publicSnapshot(this.activeRoom, auth.session),
    });
  }

  async handleClosePresence(request: Request) {
    // Keep the cookie session alive so a later tab can resume without asking
    // for the PIN. Only UI-driven explicit leave closes that session.
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, UNLOAD_CLOSE_REQUEST_MAX_BYTES, true);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (
      !hasExactKeys(body, [
        'idempotencyKey',
        'expectedParticipantId',
        'expectedPresenceIncarnationId',
        'baseRevision',
        'currentQueueItemId',
        'playback',
      ]) ||
      typeof body.idempotencyKey !== 'string' ||
      !IDEMPOTENCY_KEY_RE.test(body.idempotencyKey) ||
      typeof body.expectedParticipantId !== 'string' ||
      !OPAQUE_ID_RE.test(body.expectedParticipantId) ||
      typeof body.expectedPresenceIncarnationId !== 'string' ||
      !OPAQUE_ID_RE.test(body.expectedPresenceIncarnationId)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (auth.session.participantId !== body.expectedParticipantId) {
      return errorResponse('PRESENCE_IDENTITY_MISMATCH', 409);
    }

    const key = body.idempotencyKey;
    const mutation = {
      expectedParticipantId: body.expectedParticipantId,
      expectedPresenceIncarnationId: body.expectedPresenceIncarnationId,
      baseRevision: body.baseRevision,
      currentQueueItemId: body.currentQueueItemId,
      playback: body.playback,
    };
    // Scope replay to the captured presence incarnation and exact cookie
    // session. A processed old request may replay harmlessly after resume,
    // while a never-processed old request cannot target the new incarnation.
    const scope = `participant:${body.expectedParticipantId}:incarnation:${body.expectedPresenceIncarnationId}:session:${auth.tokenHash}:presence-close`;
    const fingerprint = await this.idempotencyFingerprint(scope, mutation);
    const replay = this.replayIdempotency(scope, key, fingerprint, auth.session, null);
    if (replay) return replay;
    const participant = this.activeRoom.presence.participants[body.expectedParticipantId];
    if (
      !participant ||
      participant.sessionHash !== auth.tokenHash ||
      participant.presenceIncarnationId !== body.expectedPresenceIncarnationId
    ) {
      return errorResponse('PRESENCE_IDENTITY_MISMATCH', 409);
    }
    if (
      !isSafeNonNegativeInteger(body.baseRevision) ||
      body.baseRevision > this.activeRoom.revision
    ) {
      return errorResponse('INVALID_REVISION', 400);
    }

    // Playback is server-authoritative. Pagehide may carry the last locally
    // observed checkpoint for request-shape continuity, but it is never
    // allowed to overwrite the canonical server clock.
    if (
      body.currentQueueItemId !== null &&
      !matchesPattern(body.currentQueueItemId, QUEUE_ITEM_ID_RE)
    ) {
      return errorResponse('INVALID_PLAYBACK', 400);
    }
    if (body.playback !== null && typeof body.playback !== 'object') {
      return errorResponse('INVALID_PLAYBACK', 400);
    }
    this.removePresence(body.expectedParticipantId, Date.now());
    const responseBody = { ok: true };
    this.storeIdempotency(scope, key, fingerprint, responseBody);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async handleKickPresence(request: Request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'members.manage',
    });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    let target: PresenceParticipant | undefined;
    if (
      hasExactKeys(parsed.value, ['targetParticipantId']) &&
      matchesPattern(parsed.value.targetParticipantId, OPAQUE_ID_RE)
    ) {
      target = this.activeRoom.presence.participants[parsed.value.targetParticipantId];
    } else if (
      hasExactKeys(parsed.value, ['targetMemberId']) &&
      matchesPattern(parsed.value.targetMemberId, OPAQUE_ID_RE)
    ) {
      const targetMemberId = parsed.value.targetMemberId;
      target = Object.values(this.activeRoom.presence.participants).find(
        (participant) => participant.memberId === targetMemberId,
      );
    } else {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (!target) return errorResponse('PARTICIPANT_NOT_FOUND', 404);
    const targetParticipantId = target.participantId;
    const targetSession = this.activeRoom.sessions[target.sessionHash];
    if (!targetSession) return errorResponse('PARTICIPANT_NOT_FOUND', 404);
    if (
      targetParticipantId === auth.session.participantId ||
      targetSession.memberId === auth.session.memberId
    ) {
      return errorResponse('CANNOT_KICK_SELF', 409);
    }
    if (targetSession.role === 'owner') return errorResponse('OWNER_AUTHORITY_IMMUTABLE', 409);
    if (auth.session.role !== 'owner' && targetSession.role === 'controller') {
      return errorResponse('ADMINISTRATOR_TARGET_FORBIDDEN', 403);
    }
    // Member kick revokes delegated authority and removes every live session
    // for that room member. Exact transport removal is `/presence/kick-device`.
    if (targetSession.accountId) {
      const member = this.activeRoom.accountMembers?.[targetSession.accountId];
      if (member?.role === 'controller') {
        member.role = 'member';
        member.permissions = clonePermissionSet(MEMBER_PERMISSIONS);
        member.updatedAtMs = Date.now();
        this.syncAccountMemberSessions(targetSession.accountId, member);
      }
    } else {
      this.removeAnonymousAdministrator(targetSession.memberId);
    }
    const memberSessions = this.memberSessionRecords(targetSession.memberId);
    const nowMs = Date.now();
    for (const [tokenHash, session] of memberSessions) {
      this.removePresence(session.participantId, nowMs);
      this.removeSessionRecord(tokenHash);
    }
    await this.persist();
    return jsonResponse({
      snapshot: publicSnapshot(this.activeRoom, auth.session),
    });
  }

  async handleKickPhysicalPresence(request: Request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'members.manage',
    });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['targetParticipantId']) ||
      !matchesPattern(parsed.value.targetParticipantId, OPAQUE_ID_RE)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const target = this.activeRoom.presence.participants[parsed.value.targetParticipantId];
    if (!target) return errorResponse('PARTICIPANT_NOT_FOUND', 404);
    const targetSession = this.activeRoom.sessions[target.sessionHash];
    if (!targetSession) return errorResponse('PARTICIPANT_NOT_FOUND', 404);
    if (
      target.participantId === auth.session.participantId ||
      target.sessionHash === auth.tokenHash
    ) {
      return errorResponse('CANNOT_KICK_SELF', 409);
    }
    const isVerifiedAccountSibling =
      typeof auth.session.accountId === 'string' &&
      auth.session.accountId.length > 0 &&
      targetSession.accountId === auth.session.accountId &&
      auth.participant.accountId === auth.session.accountId &&
      target.accountId === targetSession.accountId &&
      auth.participant.memberId === auth.session.memberId &&
      target.memberId === targetSession.memberId &&
      targetSession.memberId === auth.session.memberId &&
      target.sessionHash !== auth.tokenHash;
    if (!isVerifiedAccountSibling && targetSession.role === 'owner') {
      return errorResponse('OWNER_AUTHORITY_IMMUTABLE', 409);
    }
    if (
      !isVerifiedAccountSibling &&
      auth.session.role !== 'owner' &&
      targetSession.role === 'controller'
    ) {
      return errorResponse('ADMINISTRATOR_TARGET_FORBIDDEN', 403);
    }

    // This endpoint is intentionally exact and transport-scoped. Sibling
    // sessions, the member directory, and delegated authority stay intact.
    this.removeSessionRecord(target.sessionHash);
    this.removePresence(target.participantId, Date.now());
    await this.persist();
    return jsonResponse({
      snapshot: publicSnapshot(this.activeRoom, auth.session),
    });
  }

  async handleSignalingTicket(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const participant = auth.participant;
    if (!participant) return errorResponse('PRESENCE_SUPERSEDED', 409);
    const parsed = await this.parseBody(request, 1024, false, true);
    if (parsed.response) return parsed.response;
    const developerControlVersion = parsed.empty
      ? 0
      : hasExactKeys(parsed.value, ['developerControlVersion']) &&
          isSafeInteger(parsed.value.developerControlVersion) &&
          parsed.value.developerControlVersion >= DEVELOPER_CONTROL_VERSION &&
          parsed.value.developerControlVersion <= DEVELOPER_CONTROL_MAX_VERSION
        ? parsed.value.developerControlVersion
        : null;
    if (developerControlVersion === null) return errorResponse('INVALID_REQUEST', 400);
    participant.developerControlVersion = developerControlVersion;
    const secret = String(this.env.PRO_SIGNALING_SECRET || '');
    if (secret.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    const nowMs = Date.now();
    const role = 'member';
    const issuedAtSeconds = Math.floor(nowMs / 1000);
    const expiresAtSeconds = issuedAtSeconds + SIGNALING_TICKET_TTL_SECONDS;
    const expiresAtMs = expiresAtSeconds * 1000;
    if (
      !Number.isSafeInteger(auth.session.signalingTicketSequence) ||
      auth.session.signalingTicketSequence >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('SIGNALING_TICKET_SEQUENCE_EXHAUSTED', 409);
    }
    const ticketSequence = auth.session.signalingTicketSequence + 1;
    auth.session.signalingTicketSequence = ticketSequence;
    const presenceIncarnationId = participant.presenceIncarnationId;
    const ticket = await createProSignalingTicket(
      {
        v: 1,
        kind: 'pro-signaling',
        roomCode: this.activeRoom.roomCode,
        ...proRoomGenerationWireFields(this.activeRoom.roomGeneration),
        participantId: auth.session.participantId,
        memberId: auth.session.memberId,
        displayName: signalingDisplayName(auth.session.displayName),
        role,
        coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
        presenceIncarnationId,
        // The signaling Durable Object uses this signed revision together
        // with its latest authoritative presence snapshot to reject a ticket
        // issued before this participant was kicked, left, or superseded.
        presenceRevision: this.activeRoom.presence.revision,
        ticketSequence,
        jti: randomToken(18),
        iat: issuedAtSeconds,
        exp: expiresAtSeconds,
      },
      secret,
    );
    await this.persist();
    const pendingPlaybackTransition = this.activeRoom.pendingPlaybackTransition
      ? this.playbackPrepareEvent(this.activeRoom.pendingPlaybackTransition, nowMs)
      : null;
    return jsonResponse({
      ticket,
      expiresAtMs,
      role,
      coordinatorEpoch: this.activeRoom.presence.coordinatorEpoch,
      presenceIncarnationId,
      ticketSequence,
      pendingPlaybackTransition,
    });
  }

  async handlePlaybackCommand(request: Request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const key = this.readIdempotencyKey(request);
    if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400);
    const parsed = await this.parseBody(request, 4 * 1024);
    if (parsed.response) return parsed.response;
    const command = parsePlaybackAuthorityCommand(parsed.value);
    if (!command) return errorResponse('INVALID_REQUEST', 400);
    // Every room-wide playback mutation, including media observations that
    // can advance or skip the queue, requires explicit playback authority.
    // Revision/media/clock fences make an authorized observation idempotent;
    // they are not proof that an ordinary member is entitled to mutate the
    // canonical timeline.
    if (!this.sessionHasPermission(auth.session, 'playback.control')) {
      return errorResponse('PERMISSION_REQUIRED', 403);
    }
    const scope = `participant:${auth.session.participantId}:playback-authority`;
    const fingerprint = await this.idempotencyFingerprint(scope, command);
    const replay = this.replayIdempotency(scope, key, fingerprint, auth.session, null);
    if (replay) return replay;

    const nowMs = Date.now();
    const result = this.applyPlaybackAuthorityCommand(command, nowMs);
    if (result.error) {
      const errorStatus = typeof result.status === 'number' ? result.status : 500;
      return errorResponse(result.error, errorStatus, {
        'x-mxqr-playback-revision': String(this.activeRoom.playback.revision),
      });
    }
    const pendingTransition = this.activeRoom.pendingPlaybackTransition;
    if (result.status === 'preparing' && !pendingTransition) {
      return errorResponse('ROOM_STATE_INVALID', 503);
    }
    const transitionEvent =
      result.status === 'preparing' && pendingTransition
        ? this.playbackPrepareEvent(pendingTransition, nowMs)
        : null;
    const responseBody = {
      schemaVersion: 1,
      roomCode: this.activeRoom.roomCode,
      status: result.status,
      ...(result.status === 'preparing'
        ? {
            transition: transitionEvent,
          }
        : {}),
      playback: structuredClone(this.activeRoom.playback),
      serverTimeMs: nowMs,
    };
    this.storeIdempotency(
      scope,
      key,
      fingerprint,
      responseBody,
      result.status === 'preparing' ? 202 : 200,
    );
    this.enqueuePlaybackOutcome(result, nowMs);
    await this.persist();
    return jsonResponse(responseBody, result.status === 'preparing' ? 202 : 200);
  }

  async handlePlaybackTransitionReady(request: Request, transitionId: string) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const participant = auth.participant;
    if (!participant) return errorResponse('PRESENCE_SUPERSEDED', 409);
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !PLAYBACK_TRANSITION_ID_RE.test(transitionId || '') ||
      !hasExactKeys(parsed.value, ['basePlaybackRevision', 'status']) ||
      !isSafeNonNegativeInteger(parsed.value.basePlaybackRevision) ||
      (parsed.value.status !== 'ready' && parsed.value.status !== 'failed')
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const pending = this.activeRoom.pendingPlaybackTransition;
    if (!pending || pending.transitionId !== transitionId) {
      return errorResponse('PLAYBACK_TRANSITION_NOT_FOUND', 404);
    }
    if (
      pending.coordinatorEpoch !== this.activeRoom.presence.coordinatorEpoch ||
      pending.basePlaybackRevision !== parsed.value.basePlaybackRevision ||
      pending.basePlaybackRevision !== this.activeRoom.playback.revision
    ) {
      return errorResponse('PLAYBACK_TRANSITION_STALE', 409);
    }
    const incarnationId = participant.presenceIncarnationId;
    if (!pending.cohort.includes(incarnationId)) {
      return errorResponse('PLAYBACK_TRANSITION_NOT_IN_COHORT', 409);
    }
    const previous = pending.ready[incarnationId];
    if (previous && previous !== parsed.value.status) {
      return errorResponse('PLAYBACK_READY_CONFLICT', 409);
    }
    pending.ready[incarnationId] = parsed.value.status;
    participant.lastSeenAtMs = Date.now();
    // A readiness report is final for this immutable cohort: conflicting
    // replacements are rejected above. Once every participant has answered,
    // waiting out the remainder of the fixed deadline cannot make a failed
    // endpoint ready; it only stalls the endpoints that did prepare. Commit
    // immediately and let failed endpoints catch up from the canonical
    // checkpoint. A participant that has not reported still keeps the bounded
    // deadline behavior unchanged.
    const allReported = playbackTransitionCohortIsTerminal(pending);
    let committed = null;
    if (allReported) committed = this.commitPendingPlaybackTransition(Date.now());
    this.enqueuePlaybackOutcome(committed);
    await this.persist();
    return jsonResponse({
      ok: true,
      transitionId,
      status: committed?.event ? 'committed' : 'waiting',
      playbackRevision: this.activeRoom.playback.revision,
    });
  }

  readIdempotencyKey(request: Request) {
    const key = request.headers.get('idempotency-key') || '';
    return IDEMPOTENCY_KEY_RE.test(key) ? key : null;
  }

  async idempotencyFingerprint(scope: string, body: unknown) {
    return sha256Base64Url(`${scope}\n${JSON.stringify(body)}`);
  }

  idempotencyLedger(scope: string) {
    return scope.startsWith('developer:')
      ? {
          records: this.activeRoom.developerMutationIdempotency,
          maxItems: DEVELOPER_MUTATION_IDEMPOTENCY_MAX_ITEMS,
        }
      : { records: this.activeRoom.idempotency, maxItems: IDEMPOTENCY_MAX_ITEMS };
  }

  idempotencyExpiresAt(storageKey: string, record: IdempotencyRecord) {
    if (!storageKey.includes(PLAYBACK_IDEMPOTENCY_SCOPE_SEGMENT)) {
      return record.expiresAtMs;
    }
    if (record.kind === 'playback-authority') return record.expiresAtMs;
    // Legacy playback receipts have no kind marker and were written with the
    // former 24-hour TTL. Derive their original creation time so this rollout
    // immediately releases already-saturated rooms instead of waiting up to a
    // day for the old absolute expiry.
    return Math.min(
      record.expiresAtMs,
      record.expiresAtMs - IDEMPOTENCY_TTL_MS + PLAYBACK_IDEMPOTENCY_TTL_MS,
    );
  }

  idempotencyRecordIsExpired(storageKey: string, record: IdempotencyRecord, nowMs = Date.now()) {
    return this.idempotencyExpiresAt(storageKey, record) <= nowMs;
  }

  idempotencyRecord(scope: string, key: string) {
    const storageKey = `${scope}:${key}`;
    const { records } = this.idempotencyLedger(scope);
    // During the additive ledger migration, a receipt written by the previous
    // Worker may still live in the shared map. Read it until its ordinary TTL
    // expires so a retry spanning deployment cannot duplicate a mutation.
    const primary = records[storageKey];
    if (primary) {
      if (!this.idempotencyRecordIsExpired(storageKey, primary)) return primary;
      delete records[storageKey];
    }
    const legacyDeveloper = scope.startsWith('developer:')
      ? this.activeRoom.idempotency[storageKey]
      : undefined;
    if (!legacyDeveloper) return undefined;
    if (!this.idempotencyRecordIsExpired(storageKey, legacyDeveloper)) return legacyDeveloper;
    delete this.activeRoom.idempotency[storageKey];
    return undefined;
  }

  reserveIdempotencySlot(scope: string, key: string, nowMs = Date.now()) {
    const storageKey = `${scope}:${key}`;
    const { records, maxItems } = this.idempotencyLedger(scope);
    for (const [recordKey, record] of Object.entries(records)) {
      if (this.idempotencyRecordIsExpired(recordKey, record, nowMs)) delete records[recordKey];
    }
    if (records[storageKey] !== undefined) return records;
    if (Object.keys(records).length >= maxItems) {
      // An unexpired receipt is a durable exactly-once fence. Never trade it
      // for availability: the outer mutation checkpoint rolls back the new
      // action and returns a bounded capacity response.
      throw new RoomStateCapacityError();
    }
    return records;
  }

  replayIdempotency(
    scope: string,
    key: string,
    fingerprint: string,
    session: RoomSession | null = null,
    developerRequesterKeyId: string | null = null,
  ) {
    const record = this.idempotencyRecord(scope, key);
    if (!record) return null;
    if (!constantTimeEqual(record.fingerprint, fingerprint)) {
      return errorResponse('IDEMPOTENCY_CONFLICT', 409);
    }
    if (record.kind === 'snapshot') {
      return jsonResponse({ snapshot: publicSnapshot(this.activeRoom, session) }, record.status);
    }
    if (record.kind === 'developer-queue') {
      // The action is replayed from a compact receipt, while the response is
      // regenerated from authoritative state. Storing a full queue snapshot
      // per API mutation would duplicate up to 3 MiB in the room's 24-hour
      // idempotency ledger and make an otherwise healthy room unwritable.
      if (!DEVELOPER_API_KEY_ID_RE.test(developerRequesterKeyId || '')) {
        return errorResponse('ROOM_STATE_INVALID', 503);
      }
      return jsonResponse(
        developerProjection(
          this.activeRoom,
          'queue',
          Date.now(),
          developerRequesterKeyId ?? undefined,
        ),
        record.status,
      );
    }
    return jsonResponse(record.body, record.status);
  }

  storeIdempotency(
    scope: string,
    key: string,
    fingerprint: string,
    body: JsonRecord,
    status = 200,
    expiresAtMs = Date.now() + IDEMPOTENCY_TTL_MS,
  ) {
    const records = this.reserveIdempotencySlot(scope, key);
    const playbackAuthority = scope.endsWith(':playback-authority');
    records[`${scope}:${key}`] = {
      fingerprint,
      body: structuredClone(body),
      status,
      ...(playbackAuthority ? { kind: 'playback-authority' } : {}),
      expiresAtMs: playbackAuthority
        ? Math.min(expiresAtMs, Date.now() + PLAYBACK_IDEMPOTENCY_TTL_MS)
        : expiresAtMs,
    };
  }

  storeSnapshotIdempotency(
    scope: string,
    key: string,
    fingerprint: string,
    committedRevision: number,
  ) {
    const records = this.reserveIdempotencySlot(scope, key);
    records[`${scope}:${key}`] = {
      fingerprint,
      kind: 'snapshot',
      committedRevision,
      status: 200,
      expiresAtMs: Date.now() + IDEMPOTENCY_TTL_MS,
    };
  }

  storeDeveloperQueueIdempotency(scope: string, key: string, fingerprint: string, status: number) {
    const records = this.reserveIdempotencySlot(scope, key);
    records[`${scope}:${key}`] = {
      fingerprint,
      kind: 'developer-queue',
      status,
      expiresAtMs: Date.now() + IDEMPOTENCY_TTL_MS,
    };
  }

  validatePlaylistAssets(playlist: PlaylistItem[]) {
    for (const item of playlist) {
      if (item.source.kind !== 'pro-r2') continue;
      const asset = this.activeRoom.assets[item.source.assetId];
      if (
        !asset ||
        asset.status !== 'ready' ||
        asset.version !== item.source.version ||
        asset.byteLength !== item.source.byteLength ||
        asset.mime !== item.source.mime ||
        (asset.sha256 || undefined) !== (item.source.sha256 || undefined)
      ) {
        return false;
      }
    }
    return true;
  }

  async handleCompactSnapshotMutation(request: Request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'queue.mutate',
    });
    if (auth.response) return auth.response;
    const key = this.readIdempotencyKey(request);
    if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400);
    const parsed = await this.parseBody(request, REQUEST_MAX_BYTES);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (
      !hasExactKeys(body, [
        'baseRevision',
        'playlistOrder',
        'upserts',
        'currentQueueItemId',
        'playback',
      ])
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const scope = `participant:${auth.session.participantId}:snapshot`;
    const fingerprint = await this.idempotencyFingerprint(scope, body);
    const replay = this.replayIdempotency(scope, key, fingerprint, auth.session, null);
    if (replay) return replay;
    if (!isSafeNonNegativeInteger(body.baseRevision)) return errorResponse('INVALID_REVISION', 400);
    if (body.baseRevision !== this.activeRoom.revision) {
      // Keep the CAS error envelope bounded. The following explicit GET is
      // authoritative and can carry a multi-megabyte playlist safely.
      return errorResponse('REVISION_CONFLICT', 409);
    }
    if (
      body.playlistOrder !== null &&
      (!isStringArray(body.playlistOrder) || body.playlistOrder.length > PLAYLIST_MAX_ITEMS)
    ) {
      return errorResponse('INVALID_PLAYLIST', 400);
    }
    const playlistOrder: string[] = [];
    const requestedIds = new Set<string>();
    const requestedOrder =
      body.playlistOrder === null
        ? this.activeRoom.playlist.map((item) => item.queueItemId)
        : body.playlistOrder;
    for (const queueItemId of requestedOrder) {
      if (!QUEUE_ITEM_ID_RE.test(queueItemId || '') || requestedIds.has(queueItemId)) {
        return errorResponse('INVALID_PLAYLIST', 400);
      }
      requestedIds.add(queueItemId);
      playlistOrder.push(queueItemId);
    }
    const upserts = parsePlaylist(body.upserts);
    if (!upserts) return errorResponse('INVALID_PLAYLIST', 400);
    const upsertsById = new Map<string, PlaylistItem>();
    for (const item of upserts) {
      if (!requestedIds.has(item.queueItemId)) return errorResponse('INVALID_PLAYLIST', 400);
      upsertsById.set(item.queueItemId, item);
    }
    const existingById = new Map<string, PlaylistItem>(
      this.activeRoom.playlist.map((item): [string, PlaylistItem] => [
        item.queueItemId,
        publicPlaylistItem(item),
      ]),
    );
    const playlist: PlaylistItem[] = [];
    for (const queueItemId of playlistOrder) {
      const item = upsertsById.get(queueItemId) || existingById.get(queueItemId);
      if (!item) return errorResponse('INVALID_PLAYLIST', 400);
      playlist.push(item);
    }
    return this.commitParticipantSnapshot({
      auth,
      key,
      scope,
      fingerprint,
      playlist,
      currentQueueItemId: body.currentQueueItemId,
      playbackInput: body.playback,
    });
  }

  async commitParticipantSnapshot({
    auth,
    key,
    scope,
    fingerprint,
    playlist: parsedPlaylist,
    currentQueueItemId,
    playbackInput,
  }: {
    auth: AuthenticatedSession;
    key: string;
    scope: string;
    fingerprint: string;
    playlist: PlaylistItem[];
    currentQueueItemId: unknown;
    playbackInput: unknown;
  }) {
    const previousPlaylistById = new Map(
      this.activeRoom.playlist.map((item) => [item.queueItemId, item]),
    );
    for (const item of parsedPlaylist) {
      const previous = previousPlaylistById.get(item.queueItemId);
      if (previous && !preservesImmutableYouTubeManifest(previous, item)) {
        return errorResponse('PLAYLIST_MANIFEST_IMMUTABLE', 409);
      }
    }
    const playlist: PlaylistItem[] = parsedPlaylist.map((item: PlaylistItem) => {
      const existingOwnerKeyId = previousPlaylistById.get(item.queueItemId)?.developerOwnerKeyId;
      return typeof existingOwnerKeyId === 'string' &&
        DEVELOPER_API_KEY_ID_RE.test(existingOwnerKeyId)
        ? { ...item, developerOwnerKeyId: existingOwnerKeyId }
        : item;
    });
    const addedItems = playlist.filter(
      (item: PlaylistItem) => !previousPlaylistById.has(item.queueItemId),
    );
    const addedCount = addedItems.length;
    if (addedCount > 0 && !this.sessionHasPermission(auth.session, 'media.add')) {
      return errorResponse('PERMISSION_REQUIRED', 403);
    }
    if (auth.session.role !== 'owner') {
      const changesExistingItem = playlist.some((item: PlaylistItem) => {
        const previous = previousPlaylistById.get(item.queueItemId);
        return (
          previous !== undefined &&
          JSON.stringify(publicPlaylistItem(previous)) !== JSON.stringify(publicPlaylistItem(item))
        );
      });
      // Media managers may add, remove, and reorder queue entries. Mutating an
      // existing item's canonical metadata/source remains owner-only because
      // it is outside the four-permission UI contract.
      if (changesExistingItem) {
        return errorResponse('OWNER_REQUIRED', 403);
      }
    }
    const playlistById = new Map(playlist.map((item: PlaylistItem) => [item.queueItemId, item]));
    const playbackItem =
      this.activeRoom.playback.queueItemId === null
        ? null
        : playlistById.get(this.activeRoom.playback.queueItemId) || null;
    if (playbackItem && !playbackMatchesYouTubeManifest(this.activeRoom.playback, playbackItem)) {
      return errorResponse('PLAYLIST_MANIFEST_PLAYBACK_CONFLICT', 409);
    }
    const pendingTarget = this.activeRoom.pendingPlaybackTransition?.target;
    const pendingItem =
      pendingTarget?.queueItemId == null
        ? null
        : playlistById.get(pendingTarget.queueItemId) || null;
    if (
      pendingTarget &&
      pendingItem &&
      !playbackMatchesYouTubeManifest(pendingTarget, pendingItem)
    ) {
      return errorResponse('PLAYLIST_MANIFEST_PLAYBACK_CONFLICT', 409);
    }
    if (
      currentQueueItemId !== null &&
      (typeof currentQueueItemId !== 'string' ||
        !QUEUE_ITEM_ID_RE.test(currentQueueItemId) ||
        !playlistById.has(currentQueueItemId))
    ) {
      return errorResponse('INVALID_QUEUE_ITEM_ID', 400);
    }
    const nowMs = Date.now();
    const canonicalQueueItemId = this.activeRoom.currentQueueItemId;
    const canonicalSurvives =
      canonicalQueueItemId !== null && playlistById.has(canonicalQueueItemId);
    if (
      (canonicalSurvives && currentQueueItemId !== canonicalQueueItemId) ||
      (!canonicalSurvives && currentQueueItemId !== null)
    ) {
      return errorResponse('PLAYBACK_COMMAND_REQUIRED', 409);
    }
    // The field stays in the queue-mutation request during the cutover, but
    // it is observation-only. Only /playback/commands may change playback.
    if (playbackInput !== null && typeof playbackInput !== 'object') {
      return errorResponse('INVALID_PLAYBACK', 400);
    }
    if (!this.validatePlaylistAssets(playlist)) return errorResponse('ASSET_NOT_READY', 409);
    let playback = this.activeRoom.playback;
    let playbackCleared = false;
    let pendingCancelEvent = null;
    if (!canonicalSurvives && canonicalQueueItemId !== null) {
      const target = this.targetPlayback(null, 'idle', 0, nowMs);
      if (!target) return errorResponse('PLAYBACK_REVISION_EXHAUSTED', 409);
      pendingCancelEvent = this.cancelPendingPlayback('queue-item-removed', nowMs);
      playback = target;
      playbackCleared = true;
    }

    const playlistChanged = JSON.stringify(playlist) !== JSON.stringify(this.activeRoom.playlist);
    this.activeRoom.playlist = playlist;
    this.activeRoom.currentQueueItemId = canonicalSurvives ? canonicalQueueItemId : null;
    this.activeRoom.playback = playback;
    if (
      this.activeRoom.pendingPlaybackTransition?.target.queueItemId != null &&
      !playlistById.has(this.activeRoom.pendingPlaybackTransition.target.queueItemId)
    ) {
      pendingCancelEvent = this.cancelPendingPlayback('queue-item-removed', nowMs);
    }
    this.reconcileAssetGarbageCollection(nowMs);
    if (playlistChanged) {
      reconcileQueueModePlaylist(this.activeRoom, nowMs);
      this.activeRoom.playlistRevision += 1;
    }
    this.activeRoom.revision += 1;
    const responseBody = {
      snapshot: publicSnapshot(this.activeRoom, auth.session),
    };
    this.storeSnapshotIdempotency(scope, key, fingerprint, this.activeRoom.revision);
    if (pendingCancelEvent) this.enqueuePlaybackBroadcast(pendingCancelEvent);
    if (playbackCleared) {
      this.enqueuePlaybackBroadcast(
        this.playbackCommitEvent(null, this.activeRoom.playback.updatedAtMs, nowMs),
      );
    }
    await this.persist();
    await this.broadcastServerEvent(
      this.invalidationEvent({
        playlistRevision: this.activeRoom.playlistRevision,
        ...(playbackCleared ? { playbackRevision: this.activeRoom.playback.revision } : {}),
      }),
    );
    if (addedCount > 0) {
      const firstTitle = addedItems[0]?.title || addedItems[0]?.name;
      this.scheduleDeveloperInvalidationHint({
        actorName: auth.session.displayName,
        fallback: 'Peer',
        count: addedCount,
        ...(firstTitle === undefined ? {} : { firstTitle }),
      });
    }
    return jsonResponse(responseBody);
  }

  async handleCreateReservation(request: Request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'asset.upload',
    });
    if (auth.response) return auth.response;
    const key = this.readIdempotencyKey(request);
    if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400);
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!hasExactKeys(body, ['byteLength', 'name', 'mime'], ['sha256'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const name = boundedString(body.name, MAX_MEDIA_NAME_LENGTH);
    if (
      !name ||
      !isSafeInteger(body.byteLength) ||
      body.byteLength <= 0 ||
      body.byteLength > ASSET_MAX_BYTES ||
      typeof body.mime !== 'string' ||
      !MIME_RE.test(body.mime) ||
      (body.sha256 !== undefined &&
        (typeof body.sha256 !== 'string' || !SHA256_RE.test(body.sha256)))
    ) {
      return errorResponse('INVALID_MEDIA', 400);
    }
    const normalizedBody = {
      byteLength: body.byteLength,
      name,
      mime: body.mime,
      ...(body.sha256 === undefined ? {} : { sha256: body.sha256 }),
    };
    const scope = `participant:${auth.session.participantId}:reserve`;
    const fingerprint = await this.idempotencyFingerprint(scope, normalizedBody);
    const replay = this.replayIdempotency(scope, key, fingerprint);
    if (replay) return replay;
    if (!this.env.PRO_MEDIA_BUCKET || !r2S3Config(this.env)) {
      return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    }
    const assets = Object.values(this.activeRoom.assets);
    const reservations = assets.filter((asset) => asset.status === 'reserved');
    if (assets.length + Object.keys(this.activeRoom.stagingTombstones).length >= ASSET_MAX_ITEMS) {
      return errorResponse('ASSET_CAPACITY_EXCEEDED', 409);
    }
    if (reservations.length >= RESERVED_ASSET_MAX_ITEMS) {
      return errorResponse('RESERVATION_CAPACITY_EXCEEDED', 409);
    }
    if (
      reservations.filter((asset) => asset.reservedByParticipantId === auth.session.participantId)
        .length >= RESERVED_ASSET_MAX_ITEMS_PER_PARTICIPANT
    ) {
      return errorResponse('RESERVATION_CAPACITY_EXCEEDED', 409);
    }
    if (
      this.activeRoom.quota.usedBytes + this.activeRoom.quota.reservedBytes + body.byteLength >
      ROOM_QUOTA_BYTES
    ) {
      return errorResponse('ROOM_QUOTA_EXCEEDED', 409);
    }
    const nowMs = Date.now();
    const assetId = `asset_${randomToken(24)}`;
    const version = 1;
    const objectPrefix = `${proRoomMediaPrefix(
      this.activeRoom.roomCode,
      this.activeRoom.roomGeneration,
    )}/assets/${assetId}/v${version}`;
    const stagingObjectKey = `${objectPrefix}/staging_${randomToken(18)}`;
    const objectKey = `${objectPrefix}/object_${randomToken(24)}`;
    const expiresAtMs = nowMs + this.reservationTtlSeconds() * 1000;
    const uploadHeaders = {
      'content-type': body.mime,
      'x-amz-meta-mxqr-room': this.activeRoom.roomCode,
      ...proRoomGenerationUploadMetadataHeaders(this.activeRoom.roomGeneration),
      'x-amz-meta-mxqr-asset': assetId,
      'x-amz-meta-mxqr-version': String(version),
      'x-amz-meta-mxqr-bytes': String(body.byteLength),
      ...(body.sha256 === undefined ? {} : { 'x-amz-meta-mxqr-sha256': body.sha256 }),
    };
    // Content-Length is a forbidden browser request header: XHR supplies it
    // from the Blob body and application code cannot set it. Bind that
    // browser-generated value into SigV4 without returning it in the header
    // list that the client applies manually.
    const signedUploadHeaders = {
      'content-length': String(body.byteLength),
      ...uploadHeaders,
    };
    const presignTtl = Math.min(
      this.reservationTtlSeconds(),
      configuredNumber(this.env.PRESIGN_TTL_SECONDS, PRESIGN_TTL_SECONDS, 60, 3600),
    );
    const uploadUrl = await createR2PresignedUrl({
      env: this.env,
      method: 'PUT',
      objectKey: stagingObjectKey,
      headers: signedUploadHeaders,
      expiresInSeconds: presignTtl,
      now: new Date(nowMs),
    });
    if (!uploadUrl) return errorResponse('MEDIA_NOT_CONFIGURED', 503);

    this.activeRoom.assets[assetId] = {
      status: 'reserved',
      assetId,
      roomGeneration: this.activeRoom.roomGeneration,
      version,
      objectKey,
      stagingObjectKey,
      uploadExpiresAtMs: nowMs + presignTtl * 1000,
      reservedByParticipantId: auth.session.participantId,
      byteLength: body.byteLength,
      name,
      mime: body.mime,
      ...(body.sha256 === undefined ? {} : { sha256: body.sha256 }),
      createdAtMs: nowMs,
      expiresAtMs,
    };
    this.activeRoom.quota.reservedBytes += body.byteLength;
    this.activeRoom.revision += 1;
    const responseBody = {
      reservation: {
        assetId,
        version,
        byteLength: body.byteLength,
        expiresAtMs,
        upload: { method: 'PUT', url: uploadUrl, headers: uploadHeaders },
      },
      quota: { ...this.activeRoom.quota },
    };
    this.storeIdempotency(scope, key, fingerprint, responseBody, 200, expiresAtMs);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async handleCompleteMedia(request: Request, assetId: string) {
    // Completion remains creator-only and requires an active heartbeat. A
    // client that leaves mid-upload can rejoin, but another participant cannot
    // adopt its still-valid presigned staging URL/reservation.
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'asset.upload',
    });
    if (auth.response) return auth.response;
    const key = this.readIdempotencyKey(request);
    if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400);
    if (!OPAQUE_ID_RE.test(assetId)) return errorResponse('INVALID_ASSET_ID', 400);
    if (request.body && (request.headers.get('content-length') || '') !== '0')
      return errorResponse('INVALID_REQUEST', 400);
    const scope = `participant:${auth.session.participantId}:complete`;
    const fingerprint = await this.idempotencyFingerprint(scope, { assetId });
    const replay = this.replayIdempotency(scope, key, fingerprint);
    if (replay) return replay;
    const asset = this.activeRoom.assets[assetId];
    if (!asset || asset.status !== 'reserved') return errorResponse('ASSET_NOT_FOUND', 404);
    if (asset.reservedByParticipantId !== auth.session.participantId) {
      return errorResponse('RESERVATION_OWNER_REQUIRED', 403);
    }
    if (!this.env.PRO_MEDIA_BUCKET) return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    if (serializedCoreStateByteLength(this.activeRoom) > STATE_MAX_BYTES - 8 * 1024) {
      return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
    }
    const assetRoomGeneration = asset.roomGeneration;
    if (assetRoomGeneration !== this.activeRoom.roomGeneration) {
      return errorResponse('ROOM_STATE_INVALID', 503);
    }
    const stagingObjectKey = asset.stagingObjectKey;
    const uploadExpiresAtMs = asset.uploadExpiresAtMs;
    if (typeof stagingObjectKey !== 'string' || !isSafeInteger(uploadExpiresAtMs)) {
      return errorResponse('ROOM_STATE_INVALID', 503);
    }
    const finalMetadata = {
      'mxqr-room': this.activeRoom.roomCode,
      'mxqr-generation': String(assetRoomGeneration),
      'mxqr-asset': asset.assetId,
      'mxqr-version': String(asset.version),
      'mxqr-bytes': String(asset.byteLength),
      ...(asset.sha256 === undefined ? {} : { 'mxqr-sha256': asset.sha256 }),
    };
    const objectMatchesReservation = (object: R2ObjectPort | null) => {
      const metadata = object?.customMetadata ?? {};
      return (
        object?.size === asset.byteLength &&
        object?.httpMetadata?.contentType === asset.mime &&
        Object.entries(finalMetadata).every(
          ([metadataKey, metadataValue]) => metadata[metadataKey] === metadataValue,
        ) &&
        (asset.sha256 !== undefined || metadata['mxqr-sha256'] === undefined)
      );
    };

    let stagingObject;
    let finalObject;
    try {
      [stagingObject, finalObject] = await Promise.all([
        this.env.PRO_MEDIA_BUCKET.head(stagingObjectKey),
        this.env.PRO_MEDIA_BUCKET.head(asset.objectKey),
      ]);
    } catch {
      return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
    }

    // A prior completion may have created and verified the immutable final
    // object, then lost the Durable Object commit or response. Treat that exact
    // object as the recovery source instead of requiring staging to survive.
    if (!objectMatchesReservation(finalObject) && !stagingObject) {
      return errorResponse('UPLOAD_INCOMPLETE', 409);
    }
    if (!objectMatchesReservation(finalObject) && !objectMatchesReservation(stagingObject)) {
      try {
        await this.env.PRO_MEDIA_BUCKET.delete(stagingObjectKey);
      } catch {
        asset.expiresAtMs = Date.now() + 60_000;
        await this.persist();
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
      this.activeRoom.quota.reservedBytes -= asset.byteLength;
      this.retainStagingTombstone(asset);
      delete this.activeRoom.assets[assetId];
      this.activeRoom.revision += 1;
      await this.persist();
      return errorResponse('UPLOAD_MISMATCH', 409);
    }

    if (!objectMatchesReservation(finalObject)) {
      try {
        const staged = await this.env.PRO_MEDIA_BUCKET.get(stagingObjectKey);
        if (!staged?.body) return errorResponse('UPLOAD_INCOMPLETE', 409);
        await this.env.PRO_MEDIA_BUCKET.put(asset.objectKey, staged.body, {
          httpMetadata: { contentType: asset.mime },
          customMetadata: finalMetadata,
        });
        finalObject = await this.env.PRO_MEDIA_BUCKET.head(asset.objectKey);
      } catch {
        // Keep both keys. R2 PUT is atomic and a retry can verify/recover an
        // already-created final object even when the post-PUT HEAD failed.
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
      if (!objectMatchesReservation(finalObject)) {
        await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey).catch(() => {});
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
    }
    const completedAtMs = Date.now();
    asset.status = 'ready';
    delete asset.expiresAtMs;
    asset.completedAtMs = completedAtMs;
    asset.stagingCleanupAfterMs = Math.max(uploadExpiresAtMs + 5_000, completedAtMs + 60_000);
    this.activeRoom.quota.reservedBytes -= asset.byteLength;
    this.activeRoom.quota.usedBytes += asset.byteLength;
    // Completion and playlist insertion are separate idempotent operations.
    // Start a conservative orphan deadline now; a later accepted snapshot that
    // references this asset clears the marker.
    this.reconcileAssetGarbageCollection(completedAtMs);
    this.activeRoom.revision += 1;
    const responseBody = { asset: publicAsset(asset), quota: { ...this.activeRoom.quota } };
    this.storeIdempotency(scope, key, fingerprint, responseBody);
    await this.persist();
    // Commit metadata and idempotency before deleting the only client-uploaded
    // copy. If cleanup is interrupted, alarm GC retries via
    // stagingCleanupAfterMs; if persistence failed, the next completion can
    // recover from the verified final object above.
    const cleanup = this.env.PRO_MEDIA_BUCKET.delete(stagingObjectKey).catch(() => {});
    if (typeof this.state.waitUntil === 'function') this.state.waitUntil(cleanup);
    return jsonResponse(responseBody);
  }

  async handleDownloadMedia(request: Request, assetId: string) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (!OPAQUE_ID_RE.test(assetId)) return errorResponse('INVALID_ASSET_ID', 400);
    const asset = this.activeRoom.assets[assetId];
    if (!asset || asset.status !== 'ready') return errorResponse('ASSET_NOT_FOUND', 404);
    const nowMs = Date.now();
    const ttl = configuredNumber(this.env.PRESIGN_TTL_SECONDS, PRESIGN_TTL_SECONDS, 60, 3600);
    const url = await createR2PresignedUrl({
      env: this.env,
      method: 'GET',
      objectKey: asset.objectKey,
      expiresInSeconds: ttl,
      now: new Date(nowMs),
    });
    if (!url) return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    return jsonResponse({
      asset: publicAsset(asset),
      download: { url, expiresAtMs: nowMs + ttl * 1000 },
    });
  }

  async handleDeleteMedia(request: Request, assetId: string) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'asset.upload',
    });
    if (auth.response) return auth.response;
    const key = this.readIdempotencyKey(request);
    if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400);
    if (!OPAQUE_ID_RE.test(assetId)) return errorResponse('INVALID_ASSET_ID', 400);
    if (request.body && (request.headers.get('content-length') || '') !== '0')
      return errorResponse('INVALID_REQUEST', 400);
    const scope = `participant:${auth.session.participantId}:delete`;
    const fingerprint = await this.idempotencyFingerprint(scope, { assetId });
    const replay = this.replayIdempotency(scope, key, fingerprint);
    if (replay) return replay;
    const asset = this.activeRoom.assets[assetId];
    if (!asset || (asset.status !== 'reserved' && asset.status !== 'ready')) {
      return errorResponse('ASSET_NOT_FOUND', 404);
    }
    if (
      this.activeRoom.playlist.some(
        (item) => item.source.kind === 'pro-r2' && item.source.assetId === assetId,
      )
    ) {
      return errorResponse('ASSET_IN_USE', 409);
    }
    if (!this.env.PRO_MEDIA_BUCKET) return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    try {
      if (asset.stagingObjectKey) {
        await this.env.PRO_MEDIA_BUCKET.delete(asset.stagingObjectKey);
      }
      if (asset.status === 'ready') await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey);
    } catch {
      return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
    }
    if (asset.status === 'reserved') this.activeRoom.quota.reservedBytes -= asset.byteLength;
    else this.activeRoom.quota.usedBytes -= asset.byteLength;
    this.retainStagingTombstone(asset);
    delete this.activeRoom.assets[assetId];
    this.activeRoom.revision += 1;
    const responseBody = { ok: true, assetId, quota: { ...this.activeRoom.quota } };
    this.storeIdempotency(scope, key, fingerprint, responseBody);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async prune(nowMs: number) {
    if (this.activeRoom.status === 'decommissioning') {
      await this.continueDecommission(nowMs);
      return true;
    }
    if (this.activeRoom.status === 'decommissioned') {
      if ((this.activeRoom.decommission?.maintenanceAtMs || 0) <= nowMs) {
        await this.maintainDecommissionedTombstone(nowMs);
        return true;
      }
      return false;
    }
    // This also migrates ready assets written before gcAfterMs existed and
    // repairs stale markers on assets that are referenced by the playlist.
    let playbackTransitionOutcome = null;
    let changed =
      this.systemAudioMigrationPending ||
      this.effectsMigrationPending ||
      this.queueModeMigrationPending ||
      this.accountIdentityMigrationPending ||
      this.developerCommandMigrationPending ||
      this.playbackAuthorityMigrationPending ||
      this.reconcileSystemAudio(nowMs);
    if (
      this.activeRoom.pendingPlaybackTransition &&
      this.activeRoom.pendingPlaybackTransition.deadlineAtMs <= nowMs
    ) {
      playbackTransitionOutcome = this.commitPendingPlaybackTransition(nowMs);
      changed = true;
    }
    // YouTube-only rooms have no ready R2 assets and therefore need no
    // playlist reference scan. Rooms with ready media compute the set once and
    // reuse it for both marker repair and the due-GC safety check below.
    const hasReadyAssets = Object.values(this.activeRoom.assets).some(
      (asset) => asset.status === 'ready',
    );
    const referencedAssets = hasReadyAssets ? this.referencedAssetIds() : new Set<string>();
    changed = this.reconcileAssetGarbageCollection(nowMs, referencedAssets) || changed;
    let accountLeasePresenceChanged = false;
    for (const [tokenHash, session] of Object.entries(this.activeRoom.sessions)) {
      if (
        session.expiresAtMs <= nowMs ||
        session.authEpoch !== this.activeRoom.authEpoch ||
        session.roomGeneration !== this.activeRoom.roomGeneration
      ) {
        changed = this.removePresence(session.participantId, nowMs) || changed;
        changed = this.removeSessionRecord(tokenHash) || changed;
        changed = true;
        continue;
      }
      if (
        session.accountId &&
        (!isSafeInteger(session.accountLeaseExpiresAtMs) ||
          session.accountLeaseExpiresAtMs <= nowMs)
      ) {
        const detached = this.detachAccountSession(session, nowMs);
        if (detached) {
          changed = true;
          accountLeasePresenceChanged =
            accountLeasePresenceChanged || detached.participant !== null;
        }
      }
    }
    for (const participant of Object.values(this.activeRoom.presence.participants)) {
      if (participant.lastSeenAtMs + this.presenceTtlMs() <= nowMs) {
        changed = this.removePresence(participant.participantId, nowMs) || changed;
      }
    }
    if (accountLeasePresenceChanged) this.scheduleServerEvent(this.presenceEvent());
    changed = (await this.processDeveloperCommands(nowMs)) || changed;
    for (const [commandId, command] of Object.entries(this.activeRoom.developerCommands)) {
      if (
        command.status !== 'pending' &&
        command.status !== 'dispatched' &&
        command.retainUntilMs <= nowMs
      ) {
        this.syncDeveloperCommandIdempotency(command);
        delete this.activeRoom.developerCommands[commandId];
        changed = true;
      }
    }
    for (const [key, record] of Object.entries(this.activeRoom.developerCommandIdempotency)) {
      if (record.expiresAtMs <= nowMs) {
        delete this.activeRoom.developerCommandIdempotency[key];
        changed = true;
      }
    }
    for (const [key, record] of Object.entries(this.activeRoom.idempotency)) {
      if (this.idempotencyRecordIsExpired(key, record, nowMs)) {
        delete this.activeRoom.idempotency[key];
        changed = true;
      }
    }
    for (const [key, record] of Object.entries(this.activeRoom.developerMutationIdempotency)) {
      if (record.expiresAtMs <= nowMs) {
        delete this.activeRoom.developerMutationIdempotency[key];
        changed = true;
      }
    }
    for (const [assetId, tombstone] of Object.entries(this.activeRoom.stagingTombstones)) {
      if (tombstone.cleanupAfterMs > nowMs) continue;
      if (!this.env.PRO_MEDIA_BUCKET) {
        tombstone.cleanupAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
        changed = true;
        continue;
      }
      try {
        const quietWindowComplete = await this.advanceStagingObjectCleanup(
          tombstone,
          tombstone.objectKey,
          nowMs,
        );
        if (quietWindowComplete) delete this.activeRoom.stagingTombstones[assetId];
        changed = true;
      } catch {
        delete tombstone.emptySinceMs;
        tombstone.cleanupAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
        changed = true;
      }
    }
    for (const [assetId, asset] of Object.entries(this.activeRoom.assets)) {
      const stagingObjectKey = asset.stagingObjectKey;
      const stagingCleanupAfterMs = asset.stagingCleanupAfterMs;
      if (
        stagingObjectKey &&
        isSafeInteger(stagingCleanupAfterMs) &&
        stagingCleanupAfterMs <= nowMs
      ) {
        if (!this.env.PRO_MEDIA_BUCKET) {
          asset.stagingCleanupAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
          changed = true;
        } else {
          try {
            const quietWindowComplete = await this.advanceStagingObjectCleanup(
              asset,
              stagingObjectKey,
              nowMs,
              'stagingCleanupAfterMs',
              'stagingEmptySinceMs',
            );
            if (quietWindowComplete) {
              delete asset.stagingObjectKey;
              delete asset.stagingCleanupAfterMs;
              delete asset.stagingEmptySinceMs;
              delete asset.uploadExpiresAtMs;
            }
            changed = true;
          } catch {
            delete asset.stagingEmptySinceMs;
            asset.stagingCleanupAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
            changed = true;
          }
        }
      }
      const expiresAtMs = asset.expiresAtMs;
      if (asset.status === 'reserved' && isSafeInteger(expiresAtMs) && expiresAtMs <= nowMs) {
        if (!this.env.PRO_MEDIA_BUCKET) {
          asset.expiresAtMs = nowMs + 60_000;
          changed = true;
          continue;
        }
        const reservedObjectKey = asset.stagingObjectKey;
        if (!reservedObjectKey) {
          asset.expiresAtMs = nowMs + 60_000;
          changed = true;
          continue;
        }
        try {
          await this.env.PRO_MEDIA_BUCKET.delete(reservedObjectKey);
        } catch {
          asset.expiresAtMs = nowMs + 60_000;
          changed = true;
          continue;
        }
        this.activeRoom.quota.reservedBytes -= asset.byteLength;
        this.retainStagingTombstone(asset, nowMs);
        delete this.activeRoom.assets[assetId];
        changed = true;
        continue;
      }
      const gcAfterMs = asset.gcAfterMs;
      if (asset.status === 'ready' && isSafeInteger(gcAfterMs) && gcAfterMs <= nowMs) {
        // Never trust the marker alone: a later snapshot may have restored one
        // or several references since it was created.
        if (referencedAssets.has(assetId)) {
          delete asset.gcAfterMs;
          changed = true;
          continue;
        }
        if (!this.env.PRO_MEDIA_BUCKET) {
          asset.gcAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
          changed = true;
          continue;
        }
        try {
          await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey);
          if (asset.stagingObjectKey) {
            await this.env.PRO_MEDIA_BUCKET.delete(asset.stagingObjectKey);
          }
        } catch {
          // R2 is authoritative for byte deletion. Keep both the asset ledger
          // and used-byte charge intact until deletion succeeds.
          asset.gcAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
          changed = true;
          continue;
        }
        this.activeRoom.quota.usedBytes -= asset.byteLength;
        this.retainStagingTombstone(asset, nowMs);
        delete this.activeRoom.assets[assetId];
        this.activeRoom.revision += 1;
        changed = true;
      }
    }
    for (const [key, value] of Object.entries(this.activeRoom.rateLimits)) {
      if (value.resetAtMs <= nowMs) {
        delete this.activeRoom.rateLimits[key];
        changed = true;
      }
    }
    for (const [key, value] of Object.entries(this.activeRoom.botRateLimits)) {
      if (value.resetAtMs <= nowMs) {
        delete this.activeRoom.botRateLimits[key];
        changed = true;
      }
    }
    for (const [nonceHash, expiresAtMs] of Object.entries(this.activeRoom.consumedRecoveryNonces)) {
      if (expiresAtMs <= nowMs) {
        delete this.activeRoom.consumedRecoveryNonces[nonceHash];
        changed = true;
      }
    }
    for (const [nonceHash, record] of Object.entries(
      this.activeRoom.consumedOwnershipTransferClaims || {},
    )) {
      if (record.expiresAtMs <= nowMs) {
        delete this.activeRoom.consumedOwnershipTransferClaims[nonceHash];
        changed = true;
      }
    }
    changed = this.pruneAccountDeletionTombstones(nowMs) || changed;
    this.enqueuePlaybackOutcome(playbackTransitionOutcome, nowMs);
    if (changed) {
      await this.persist();
      this.systemAudioMigrationPending = false;
      this.effectsMigrationPending = false;
      this.queueModeMigrationPending = false;
      this.accountIdentityMigrationPending = false;
      this.developerCommandMigrationPending = false;
      this.playbackAuthorityMigrationPending = false;
    }
    return changed;
  }

  async alarm() {
    if ((await readServiceMaintenance(this.env)).enabled) {
      if (typeof this.storage.setAlarm === 'function') {
        const retryAtMs = Date.now() + 60_000;
        try {
          await this.storage.setAlarm(retryAtMs);
          this.scheduledAlarmMs = retryAtMs;
        } catch {
          // A later request or control-plane recovery can install the next
          // ordinary alarm. Maintenance still fails closed for room mutation.
        }
      }
      return;
    }
    await this.withMutation(async () => {
      // Cloudflare removes the due alarm before invoking this callback. Clear
      // the in-memory hint so scheduleAlarm() can install the next deadline.
      this.scheduledAlarmMs = null;
      if (this.ready) await this.ready;
      if (!this.room) await this.loadRoomFromStorage();
      if (!this.room) return;
      this.normalizeLoadedSystemAudio();
      this.normalizeLoadedEffects();
      this.normalizeLoadedQueueMode();
      this.normalizeLoadedOwnershipTransfer();
      this.normalizeLoadedDeveloperCommands();
      this.normalizeLoadedSecurityLedgers();
      this.normalizeLoadedPlaybackAuthority();
      this.normalizeLoadedPlaybackBroadcasts();
      this.normalizeLoadedPresenceBroadcast();
      const nowMs = Date.now();
      await this.prune(nowMs);
      if (this.heartbeatDurabilityDirty) {
        try {
          await this.persist();
        } catch {
          await this.scheduleHeartbeatPersistRetryAlarm();
          return;
        }
      }
      await this.retryPendingPresenceBroadcast(nowMs);
      await this.flushPendingPlaybackBroadcasts(nowMs);
      await this.maintainAlarm();
    });
  }
}
