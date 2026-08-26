import {
  deriveStandardRoomMemberId,
  verifyStandardRoomAccountAssertion,
  verifyStandardRoomAccountDeletionAssertion,
} from './standard-room-account-assertion.ts';
import {
  INITIAL_PRO_ROOM_GENERATION,
  isProRoomGeneration,
  proRoomGenerationHeaderValue,
  proRoomObjectName,
} from './pro-room-generation.ts';
import { isSafeVisibleDisplayName } from './display-name-policy.ts';
import {
  consumeAbuseRateLimit,
  gateServiceMaintenance,
  readServiceMaintenance,
} from './service-maintenance.ts';
import {
  createRemoteShareUploadAssertion,
  parseRemoteShareUploadAssertionKeyring,
  REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_VERSION,
  REMOTE_SHARE_UPLOAD_ASSERTION_VERSION,
  type RemoteShareUploadAssertionKeyring,
} from './remote-share-upload-assertion.ts';
import {
  hasExactKeys,
  isRecord,
  isStandardRoomIdentityMutation,
  isValidPeerId,
  MAX_PRO_ROOM_MEMBERS,
  normalizeProBroadcastTargets,
  normalizeProRealtimeFrame,
  normalizeProServerEvent,
  PRO_CHAT_MODERATION_KINDS,
  PRO_CHAT_SLOWMODE_MAX_SECONDS,
  PRO_PRESENCE_INCARNATION_ID_RE,
  PRO_REALTIME_BODY_MAX_BYTES,
  PRO_REALTIME_EVENT_ID_RE,
  rawMessageByteLength,
  validateIncomingMessage,
  WS_MESSAGE_MAX_BYTES,
} from './signaling-protocol.ts';

type JsonRecord = Record<string, unknown>;
type HeaderRecord = Record<string, string>;
type NormalizedProRealtimeFrame = NonNullable<ReturnType<typeof normalizeProRealtimeFrame>>;

interface FetcherPort {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespacePort {
  getByName?(name: string): FetcherPort;
  idFromName?(name: string): unknown;
  get?(id: unknown): FetcherPort;
}

interface AddressableDurableObjectNamespacePort extends DurableObjectNamespacePort {
  idFromName(name: string): unknown;
  get(id: unknown): FetcherPort;
}

interface D1PreparedStatementPort {
  bind(...values: unknown[]): D1PreparedStatementPort;
  run(): Promise<unknown>;
}

interface D1DatabasePort {
  prepare(query: string): D1PreparedStatementPort;
}

interface SocketPort {
  readonly readyState?: number;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(attachment: unknown): void;
  deserializeAttachment?(): unknown;
}

interface OutboundWebSocketPort {
  readonly readyState?: number;
  accept(): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  readonly addEventListener: (
    type: 'message' | 'close' | 'error',
    listener: (event: unknown) => void,
  ) => void;
}

interface DurableObjectStoragePort {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  list?(): Promise<Map<string, unknown>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  transaction?<T>(closure: (transaction: DurableObjectStoragePort) => Promise<T>): Promise<T>;
}

interface DurableObjectStatePort {
  readonly id?: { readonly name?: unknown };
  readonly storage: DurableObjectStoragePort;
  waitUntil?(promise: Promise<unknown>): void;
  blockConcurrencyWhile?<T>(callback: () => Promise<T>): Promise<T>;
  getWebSockets?(): SocketPort[];
  setWebSocketAutoResponse?(pair: unknown): void;
  acceptWebSocket(socket: SocketPort, tags?: string[]): void;
}

interface SignalingEnvPort {
  readonly ADMIN_METRICS_DB?: unknown;
  readonly ALLOWED_ORIGINS?: unknown;
  readonly CF_VERSION_METADATA?: unknown;
  readonly MUSIXQUARE_ADMIN_DB?: unknown;
  readonly MUSIXQUARE_ROOMS?: unknown;
  readonly MUSIXQUARE_SERVICE_CONTROL?: unknown;
  readonly MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET?: unknown;
  readonly MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET?: unknown;
  readonly MXQR_STANDARD_ROOM_PIN_PEPPER?: unknown;
  readonly PRO_ROOM_AUTHORITY_ROOMS?: unknown;
  readonly PRO_SIGNALING_SECRET?: unknown;
  readonly TRUSTED_ORIGINS?: unknown;
}

interface SignalingWorkerEnvPort extends SignalingEnvPort {
  readonly MUSIXQUARE_ROOMS: AddressableDurableObjectNamespacePort;
}

interface StandardHttpBridgeMeta extends JsonRecord {
  v: 1;
  sessionId: string;
  generation: string;
  roomId: string;
  role: 'host' | 'guest';
  peerId: string;
  lastClientSeq: number;
  lastServerSeq: number;
  lastServerAck: number;
  requestEpoch: number;
  leaseExpiresAt: number;
}

interface StandardHttpBridgeEvent {
  readonly sseq: number;
  readonly data: string;
  readonly bytes: number;
}

interface StandardHttpBridgeTerminal {
  readonly code: number;
  readonly reason: string;
}

type StandardHttpBridgeWaitOutcome = 'ready' | 'superseded' | 'aborted' | 'timeout';

interface StandardHttpBridgeWaiter {
  readonly generation: string;
  readonly requestEpoch: number;
  readonly promise: Promise<StandardHttpBridgeWaitOutcome>;
  resolve(outcome: StandardHttpBridgeWaitOutcome): void;
}

interface ProSignalingTicket extends JsonRecord {
  v: number;
  kind: string;
  roomCode: string;
  roomGeneration: number;
  participantId: string;
  memberId?: string;
  displayName: string;
  coordinatorEpoch: number;
  presenceRevision: number;
  presenceIncarnationId: string;
  ticketSequence: number;
  jti: string;
  iat: number;
  exp: number;
}

interface StandardIdentityFields {
  accountSubject?: string;
  memberId?: string;
  memberDisplayNumber?: number;
  memberNickname?: string;
  identityExpiresAt?: number;
}

interface ProSocketAttachment extends JsonRecord {
  v: number;
  roomKind: 'pro';
  role: 'member';
  roomId: string;
  roomGeneration: number;
  peerId: string;
  participantId: string;
  memberId?: string;
  displayName: string;
  coordinatorEpoch: number;
  presenceRevision: number;
  ticketJti: string;
  presenceIncarnationId: string;
  ticketSequence: number;
  auth: 'ok';
  realtimeMessageTokens?: number;
  realtimeMessageUpdatedAt?: number;
  chatLastMessageAtMs?: number;
}

interface StandardHostOkAttachment extends JsonRecord, StandardIdentityFields {
  v: number;
  roomKind?: never;
  role: 'host';
  roomId: string;
  peerId: string;
  secret: string;
  auth: 'ok';
  pinConfigurationPending?: true;
  pinConfigurationMutationId?: string;
  remoteShareUploadAssertionTokens?: number;
  remoteShareUploadAssertionUpdatedAt?: number;
}

interface StandardHostPendingAttachment extends JsonRecord {
  v: number;
  roomKind?: never;
  role: 'host';
  roomId: string;
  peerId: string;
  auth: 'pending';
  authDeadline: number;
  authStarted?: boolean;
}

interface StandardOrderedIngress {
  preclaimedAuth: boolean;
  pinConfigurationMutationId?: string;
}

interface StandardGuestOkAttachment extends JsonRecord, StandardIdentityFields {
  v: number;
  roomKind?: never;
  role: 'guest';
  roomId: string;
  peerId: string;
  auth: 'ok';
  guestMessageTokens?: number;
  guestMessageUpdatedAt?: number;
}

interface StandardGuestPendingAttachment extends JsonRecord {
  v: number;
  roomKind?: never;
  role: 'guest';
  roomId: string;
  peerId: string;
  auth: 'pending';
  authDeadline: number;
  authStarted?: boolean;
  guestMessageTokens?: number;
  guestMessageUpdatedAt?: number;
}

type StandardSocketAttachment =
  | StandardHostOkAttachment
  | StandardHostPendingAttachment
  | StandardGuestOkAttachment
  | StandardGuestPendingAttachment;
type SocketAttachment = ProSocketAttachment | StandardSocketAttachment;

interface GuestBinding extends JsonRecord {
  peerId: string;
  secretHash: string;
  updatedAt: number;
}

interface GuestBindings extends JsonRecord {
  v: number;
  entries: GuestBinding[];
}

interface RoomMetaBase extends JsonRecord {
  roomSecret: string | null;
  hostPeerId: string | null;
  hostReleaseAt: number;
}

interface LegacyRoomMeta extends RoomMetaBase {
  v: 1;
  roomPassword: string;
}

interface StandardRoomPinVerifier extends JsonRecord {
  v: 1;
  algorithm: 'HMAC-SHA-256';
  digest: string;
}

interface InvalidStandardRoomPinVerifier extends JsonRecord {
  v: 0;
  algorithm: 'INVALID';
  digest: string;
}

type RoomPinVerifier = StandardRoomPinVerifier | InvalidStandardRoomPinVerifier;

interface CurrentRoomMeta extends RoomMetaBase {
  v: 2;
  /**
   * Opaque compatibility lock for the legacy v1 reader. Old Workers know only
   * this field, so a protected v2 room must remain non-empty and locked instead
   * of being misread as passwordless during a rollback. Never expose this
   * value: a retired Worker necessarily treats it as a password-equivalent.
   */
  roomPassword: string;
  roomPasswordVerifier: RoomPinVerifier | null;
}

type RoomMeta = LegacyRoomMeta | CurrentRoomMeta;

interface StandardRoomMember extends JsonRecord {
  accountSubject: string;
  memberId: string;
  memberDisplayNumber: number;
}

interface StandardRoomMembers extends JsonRecord {
  v: number;
  entries: StandardRoomMember[];
}

interface StandardRoomIdentity extends JsonRecord {
  accountSubject: string;
  memberId: string;
  memberDisplayNumber: number;
  nickname: string;
  expiresAt: number;
}

interface StandardRoomIdentityProjection {
  memberId: string;
  memberDisplayNumber: number;
  nickname: string;
  isAuthenticated: true;
}

interface ProRoomMeta extends JsonRecord {
  v: number;
  kind: 'pro';
  roomId: string;
  roomGeneration: number;
  coordinatorEpoch: number;
}

interface ProTicketUse extends JsonRecord {
  jti: string;
  exp: number;
}

interface ProTicketUses extends JsonRecord {
  v: number;
  roomGeneration: number;
  entries: ProTicketUse[];
}

interface ProParticipantHighWaterEntry extends JsonRecord {
  participantId: string;
  presenceIncarnationId: string;
  ticketSequence: number;
  exp: number;
}

interface ProParticipantHighWater extends JsonRecord {
  v: number;
  roomGeneration: number;
  entries: ProParticipantHighWaterEntry[];
}

interface ProPresenceAuthority extends JsonRecord {
  v: number;
  roomId: string;
  roomGeneration: number;
  coordinatorEpoch: number;
  presenceRevision: number;
  activeIncarnationIds: string[];
}

interface ProChatControlState extends JsonRecord {
  v: number;
  roomId: string;
  roomGeneration: number;
  coordinatorEpoch: number;
  revision: number;
  frozen: boolean;
  filterEnabled: boolean;
  slowmodeSeconds: number;
  mutedParticipantIds: string[];
}

interface ProBotRequestProof extends JsonRecord {
  requestId: string;
  participantId: string;
  status: 'pending' | 'consumed';
  expiresAtMs: number;
}

interface ProBotRequestProofs extends JsonRecord {
  v: number;
  roomId: string;
  roomGeneration: number;
  coordinatorEpoch: number;
  entries: ProBotRequestProof[];
}

interface ProOwnerAccountDeletionFenceV1 extends JsonRecord {
  v: 1;
  roomCode: string;
  roomGeneration: number;
  fencedCoordinatorEpoch: number;
  installedAtMs: number;
}

interface ProOwnerAccountDeletionFenceV2 extends JsonRecord {
  v: 2;
  roomCode: string;
  roomGeneration: number;
  fencedCoordinatorEpoch: number;
  installedAtMs: number;
  removalId: string;
  removedOwnerAuthorityEpoch: number;
}

type ProOwnerAccountDeletionFence = ProOwnerAccountDeletionFenceV1 | ProOwnerAccountDeletionFenceV2;

interface ProDecommissioned extends JsonRecord {
  v: number;
  roomCode: string;
  roomGeneration: number;
  requestId: string;
  decommissionedAtMs: number;
}

interface StandardWsRateState extends JsonRecord {
  v: number;
  windowStartMs: number;
  resetAtMs: number;
  count: number;
}

interface PortableSignalingHandler {
  fetch(request: Request, env: SignalingWorkerEnvPort): Promise<Response>;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isD1Database(value: unknown): value is D1DatabasePort {
  return isRecord(value) && typeof value.prepare === 'function';
}

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespacePort {
  return (
    isRecord(value) &&
    (typeof value.getByName === 'function' ||
      (typeof value.idFromName === 'function' && typeof value.get === 'function'))
  );
}

function isAddressableDurableObjectNamespace(
  value: unknown,
): value is AddressableDurableObjectNamespacePort {
  return (
    isRecord(value) && typeof value.idFromName === 'function' && typeof value.get === 'function'
  );
}

function isFetcher(value: unknown): value is FetcherPort {
  return isRecord(value) && typeof value.fetch === 'function';
}

const ROOM_PATH = /^\/api\/rooms\/(\d{6})\/ws$/;
const PRO_ROOM_PATH = /^\/api\/pro-rooms\/(\d{6})\/ws$/;
const PRO_ROOM_CODE_PATTERN = /^0\d{5}$/;
const ALTERNATE_STANDARD_SIGNALING_HOST = 'signal-alt.musixquare.com';
const HOST_RECLAIM_GRACE_MS = 120_000;
const HOST_AUTH_TIMEOUT_MS = 10_000;
const GUEST_AUTH_TIMEOUT_MS = 10_000;
const ROOM_META_KEY = 'roomMeta';
const ATTACHMENT_VERSION = 1;
const WS_RATE_LIMIT_PER_MINUTE = 120;
const SIGNALING_LIVENESS_VERSION = 1 as const;
const SIGNALING_LIVENESS_PING = '{"type":"signaling-liveness-ping","version":1}';
const SIGNALING_LIVENESS_PONG = '{"type":"signaling-liveness-pong","version":1}';
const STANDARD_WS_RATE_WINDOW_MS = 60_000;
const STANDARD_WS_RATE_STATE_KEY = 'standard-ws-open-rate-state-v1';
const STANDARD_WS_RATE_OBJECT_PREFIX = 'musixquare-standard-ws-open-rate-v1:';
const STANDARD_WS_RATE_OBJECT_NAME_RE = /^musixquare-standard-ws-open-rate-v1:[A-Za-z0-9_-]{43}$/;
const STANDARD_WS_RATE_CONSUME_PATH = '/internal/standard-ws-open-rate/v1/consume';
const STANDARD_WS_RATE_FETCH_TIMEOUT_MS = 2_000;
const STANDARD_HTTP_BRIDGE_OBJECT_PREFIX = 'mxqr-standard-http-bridge-v1:';
const STANDARD_HTTP_BRIDGE_OBJECT_NAME_RE = /^mxqr-standard-http-bridge-v1:([A-Za-z0-9_-]{32})$/;
const STANDARD_HTTP_BRIDGE_SESSION_ID_RE = /^[A-Za-z0-9_-]{32}$/;
const STANDARD_HTTP_BRIDGE_GENERATION_RE = /^[A-Za-z0-9_-]{22}$/;
const STANDARD_HTTP_BRIDGE_ROOM_ID_RE = /^[1-9]\d{5}$/;
const STANDARD_HTTP_BRIDGE_HEADER = 'x-mxqr-standard-http-bridge';
const STANDARD_HTTP_BRIDGE_HEADER_VALUE = 'v1';
const STANDARD_HTTP_BRIDGE_OPEN_PATH = '/internal/standard-http-bridge/v1/open';
const STANDARD_HTTP_BRIDGE_SEND_PATH = '/internal/standard-http-bridge/v1/send';
const STANDARD_HTTP_BRIDGE_POLL_PATH = '/internal/standard-http-bridge/v1/poll';
const STANDARD_HTTP_BRIDGE_CLOSE_PATH = '/internal/standard-http-bridge/v1/close';
const STANDARD_HTTP_BRIDGE_META_KEY = 'standard-http-bridge-meta-v1';
const STANDARD_HTTP_BRIDGE_BODY_MAX_BYTES = 96 * 1024;
const STANDARD_HTTP_BRIDGE_LEASE_MS = 45_000;
const STANDARD_HTTP_BRIDGE_MAX_WAIT_MS = 15_000;
const STANDARD_HTTP_BRIDGE_QUEUE_MAX_MESSAGES = 256;
const STANDARD_HTTP_BRIDGE_QUEUE_MAX_BYTES = 1024 * 1024;
const STANDARD_HTTP_BRIDGE_POLL_MAX_MESSAGES = 128;
const STANDARD_HTTP_BRIDGE_POLL_MAX_BYTES = 80 * 1024;
const REMOTE_SHARE_UPLOAD_ASSERTION_SECRET_MIN_LENGTH = 32;
const STANDARD_ROOM_PIN_PEPPER_MIN_BYTES = 32;
const STANDARD_ROOM_PIN_HMAC_PURPOSE = 'MUSIXQUARE:standard-room-pin:v1';
const STANDARD_ROOM_PIN_HMAC_ALGORITHM = 'HMAC-SHA-256' as const;
const STANDARD_ROOM_PIN_ROLLBACK_LOCK_PREFIX = 'mxqr-pin-v2:';
const STANDARD_ROOM_PIN_ROLLBACK_LOCK_RE = /^mxqr-pin-v2:([A-Za-z0-9_-]{43})$/;
const STANDARD_ROOM_PIN_QUARANTINE_LOCK_PREFIX = 'mxqr-pin-invalid:';
const STANDARD_ROOM_PIN_QUARANTINE_LOCK_RE = /^mxqr-pin-invalid:([A-Za-z0-9_-]{43})$/;
// A standard room keeps one host plus 99 guests. PRO rooms have no socket-level
// host and instead admit 100 equal authenticated members.
const MAX_ROOM_GUESTS = 99;
// Host ownership is authenticated after the WebSocket upgrade so its bearer
// secret never appears in the URL. Keep this pre-auth surface small and rotate
// only another unauthenticated host candidate; an authenticated host is never
// displaced before the new candidate proves the same room secret.
const MAX_PENDING_HOST_SOCKETS = 4;
// Every guest briefly occupies this unauthenticated state while proving its
// reconnect secret, including passwordless rooms. Keep the burst budget equal
// to the public guest capacity so a legitimate 100-device venue is not
// rejected merely because many devices scan the invite at once.
const MAX_PENDING_GUEST_SOCKETS = MAX_ROOM_GUESTS;
const GUEST_MESSAGE_BUCKET_CAPACITY = 120;
const GUEST_MESSAGE_REFILL_PER_MS = GUEST_MESSAGE_BUCKET_CAPACITY / 60_000;
const PRO_REALTIME_INGRESS_PENDING_LIMIT = 32;
const PRO_SYSTEM_AUDIO_SIGNAL_PENDING_LIMIT = 16;
// A legitimate room may allocate up to 120 Remote Share uploads per hour, so
// retain that full burst while bounding the HMAC work an authenticated (or
// compromised) host socket can trigger. Tokens refill at two requests/second;
// the Remote Worker still enforces the much tighter room-wide hourly quota.
const REMOTE_SHARE_UPLOAD_ASSERTION_BUCKET_CAPACITY = 120;
const REMOTE_SHARE_UPLOAD_ASSERTION_REFILL_PER_MS =
  REMOTE_SHARE_UPLOAD_ASSERTION_BUCKET_CAPACITY / 60_000;
const GUEST_BINDINGS_KEY = 'guestReconnectBindings';
const STANDARD_ROOM_MEMBERS_KEY = 'standardRoomAccountMembers';
const MAX_STANDARD_ROOM_ACCOUNT_MEMBERS = 100;
const PRO_ROOM_META_KEY = 'proRoomMeta';
const PRO_TICKET_USES_KEY = 'proSignalingTicketUses';
const PRO_PARTICIPANT_HIGH_WATER_KEY = 'proSignalingParticipantHighWater';
const PRO_PRESENCE_AUTHORITY_KEY = 'proSignalingPresenceAuthority';
const PRO_CHAT_CONTROL_STATE_KEY = 'proChatControlState';
const PRO_BOT_REQUEST_PROOFS_KEY = 'proBotRequestProofs';
const PRO_DECOMMISSIONED_KEY = 'proRoomDecommissioned';
const PRO_OWNER_ACCOUNT_DELETION_FENCE_KEY = 'proOwnerAccountDeletionFence';
const PRO_SIGNALING_TICKET_KIND = 'pro-signaling';
const PRO_SIGNALING_TICKET_VERSION = 1;
const PRO_SIGNALING_WEBSOCKET_PROTOCOL = 'mxqr.pro-signaling.v1';
const PRO_SIGNALING_TICKET_PROTOCOL_PREFIX = 'mxqr.ticket.';
const PRO_ROOM_GENERATION_HEADER = 'x-mxqr-pro-room-generation';
const PRO_SIGNALING_TICKET_MAX_SECONDS = 5 * 60;
const PRO_SIGNALING_CLOCK_SKEW_SECONDS = 30;
const PRO_AUTHORITY_CHECK_TIMEOUT_MS = 1_000;
const PRO_AUTHORITY_RESPONSE_MAX_BYTES = 4 * 1024;
// BOT requests are rendered as remote typing bubbles before their client-side
// execution finishes. Retain only a short, bounded server-observed proof so a
// terminal failure can close that bubble without allowing arbitrary BOT
// identity spoofing. Consumed entries remain until expiry to make the proof
// one-shot across Durable Object hibernation and same-participant reconnects.
const PRO_BOT_REQUEST_PROOF_TTL_MS = 60_000;
const PRO_BOT_REQUEST_PROOF_MAX_ITEMS = 128;
const MAINTENANCE_ALARM_RETRY_BASE_MS = 100;
const MAINTENANCE_ALARM_RETRY_MAX_MS = 5_000;
const PRO_DISPLAY_NAME_MAX_LENGTH = 64;
const INTERNAL_ADMIN_BODY_MAX_BYTES = 1024;
const INTERNAL_JSON_BODY_TIMEOUT_MS = 2_000;
const ADMIN_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_AUTHORITY_REMOVAL_ID_RE = /^removal_[A-Za-z0-9_-]{22}$/;
const MAX_PRO_TICKET_USES = 1024;
const MAX_PRO_PARTICIPANT_HIGH_WATER = 256;
const MAX_GUEST_BINDINGS = 256;
// The client exhausts its automatic signaling reconnect backoff in about 30s,
// and a host can reclaim its room for 60s. Five minutes leaves a conservative
// margin for mobile radio/foreground recovery without retaining every departed
// identity for the lifetime of a long-running room. Unexpired ownership is
// never evicted to make room for a new identity; capacity therefore fails
// closed until an inactive binding expires.
const GUEST_BINDING_RECONNECT_TTL_MS = 5 * 60_000;
const METRICS_TABLE = 'mxqr_metric_buckets';
const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function json(data: unknown, status = 200, headers: HeaderRecord = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function isAllowedOrigin(origin: unknown, env: SignalingEnvPort = {}): boolean {
  // Browser WebSocket clients always set Origin. An empty Origin signals a
  // non-browser tool (curl, wscat, custom scripts) ??no production scenario
  // should trust it for room signaling.
  if (typeof origin !== 'string' || !origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const configured = String(env.ALLOWED_ORIGINS || env.TRUSTED_ORIGINS || '')
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (configured.includes(url.origin)) return true;
    return (
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url.origin) ||
      /^https:\/\/musixquare\.com$/i.test(url.origin) ||
      /^https:\/\/www\.musixquare\.com$/i.test(url.origin) ||
      /^https:\/\/musixquare\.apps\.tossmini\.com$/i.test(url.origin) ||
      /^https:\/\/musixquare\.private-apps\.tossmini\.com$/i.test(url.origin)
    );
  } catch {
    return false;
  }
}

function isValidProEpoch(value: unknown): value is number {
  return isSafeInteger(value) && value >= 1;
}

function isProNamespaceRoomCode(roomId: unknown): roomId is string {
  return typeof roomId === 'string' && PRO_ROOM_CODE_PATTERN.test(roomId);
}

function exactProRoomGeneration(value: unknown): number | null {
  return isProRoomGeneration(value) ? value : null;
}

function internalProRoomGeneration(request: Request, value: unknown): number | null {
  if (!isRecord(value)) return null;
  const hasBodyGeneration = Object.prototype.hasOwnProperty.call(value, 'roomGeneration');
  const header = request.headers.get(PRO_ROOM_GENERATION_HEADER);
  if (!/^(?:0|[1-9]\d*)$/.test(header || '')) return null;
  const headerGeneration = Number(header);
  if (!isProRoomGeneration(headerGeneration)) return null;
  return !hasBodyGeneration || value.roomGeneration === headerGeneration ? headerGeneration : null;
}

function proRoomGenerationWireFields(roomGeneration: unknown): { roomGeneration: number } {
  if (!isProRoomGeneration(roomGeneration)) throw new Error('INVALID_PRO_ROOM_GENERATION');
  return { roomGeneration };
}

function proRoomGenerationWireHeaders(roomGeneration: unknown): HeaderRecord {
  if (!isProRoomGeneration(roomGeneration)) throw new Error('INVALID_PRO_ROOM_GENERATION');
  return { [PRO_ROOM_GENERATION_HEADER]: proRoomGenerationHeaderValue(roomGeneration) };
}

function responseRoomGenerationMatches(payload: unknown, roomGeneration: unknown): boolean {
  if (!isRecord(payload) || !isProRoomGeneration(roomGeneration)) return false;
  return payload.roomGeneration === roomGeneration;
}

function persistedProGenerationRecord(value: unknown, roomGeneration: unknown): JsonRecord {
  if (!isRecord(value) || !isProRoomGeneration(roomGeneration)) {
    throw new Error('INVALID_PRO_ROOM_GENERATION_RECORD');
  }
  return value;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeBytesEqual(left: unknown, right: unknown): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < right.byteLength; index++) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

function normalizeProTicketPayload(
  value: unknown,
  expectedRoomId: string,
  nowSeconds: number,
): ProSignalingTicket | null {
  if (!isRecord(value)) return null;
  const allowedTicketKeys = new Set([
    'v',
    'kind',
    'roomCode',
    'roomGeneration',
    'participantId',
    'memberId',
    'displayName',
    'role',
    'coordinatorEpoch',
    'presenceRevision',
    'presenceIncarnationId',
    'ticketSequence',
    'jti',
    'iat',
    'exp',
  ]);
  if (Object.keys(value).some((key) => !allowedTicketKeys.has(key))) return null;
  if (
    Object.prototype.hasOwnProperty.call(value, 'role') &&
    value.role !== 'coordinator' &&
    value.role !== 'member'
  ) {
    return null;
  }
  if (value.v !== PRO_SIGNALING_TICKET_VERSION || value.kind !== PRO_SIGNALING_TICKET_KIND) {
    return null;
  }
  if (value.roomCode !== expectedRoomId || !/^\d{6}$/.test(value.roomCode)) return null;
  const roomGeneration = exactProRoomGeneration(value.roomGeneration);
  if (roomGeneration === null) return null;
  if (!isValidPeerId(value.participantId)) return null;
  if (
    value.memberId !== undefined &&
    (typeof value.memberId !== 'string' ||
      !/^(?:member|owner)_[A-Za-z0-9_-]{16,128}$/.test(value.memberId))
  ) {
    return null;
  }
  if (
    typeof value.displayName !== 'string' ||
    value.displayName.length < 1 ||
    value.displayName.length > PRO_DISPLAY_NAME_MAX_LENGTH ||
    !isSafeVisibleDisplayName(value.displayName)
  ) {
    return null;
  }
  if (!isValidProEpoch(value.coordinatorEpoch)) return null;
  if (!isSafeInteger(value.presenceRevision) || value.presenceRevision < 0) return null;
  if (
    typeof value.presenceIncarnationId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value.presenceIncarnationId)
  ) {
    return null;
  }
  if (!isSafeInteger(value.ticketSequence) || value.ticketSequence < 1) return null;
  if (typeof value.jti !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.jti)) return null;
  if (!isSafeInteger(value.iat) || !isSafeInteger(value.exp)) return null;
  if (value.exp <= value.iat || value.exp - value.iat > PRO_SIGNALING_TICKET_MAX_SECONDS)
    return null;
  if (value.iat > nowSeconds + PRO_SIGNALING_CLOCK_SKEW_SECONDS || value.exp <= nowSeconds) {
    return null;
  }
  return {
    v: PRO_SIGNALING_TICKET_VERSION,
    kind: PRO_SIGNALING_TICKET_KIND,
    roomCode: value.roomCode,
    roomGeneration,
    participantId: value.participantId,
    ...(typeof value.memberId === 'string' && value.memberId ? { memberId: value.memberId } : {}),
    displayName: value.displayName,
    coordinatorEpoch: value.coordinatorEpoch,
    presenceRevision: value.presenceRevision,
    presenceIncarnationId: value.presenceIncarnationId,
    ticketSequence: value.ticketSequence,
    jti: value.jti,
    iat: value.iat,
    exp: value.exp,
  };
}

async function verifyProSignalingTicket(
  ticket: unknown,
  expectedRoomId: string,
  env: SignalingEnvPort,
  now = Date.now(),
): Promise<ProSignalingTicket | null> {
  const secret = typeof env.PRO_SIGNALING_SECRET === 'string' ? env.PRO_SIGNALING_SECRET : '';
  if (!secret || typeof ticket !== 'string' || ticket.length > 4096) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0].length > 3072) return null;

  const presentedSignature = base64UrlToBytes(parts[1]);
  const payloadBytes = base64UrlToBytes(parts[0]);
  if (!presentedSignature || presentedSignature.byteLength !== 32 || !payloadBytes) return null;

  let expectedSignature;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    expectedSignature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts[0])),
    );
  } catch {
    return null;
  }
  if (!constantTimeBytesEqual(presentedSignature, expectedSignature)) return null;

  try {
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      payloadBytes,
    );
    return normalizeProTicketPayload(JSON.parse(decoded), expectedRoomId, Math.floor(now / 1000));
  } catch {
    return null;
  }
}

function readProSignalingCredential(
  request: Request,
  url: URL,
): { ticket: string; responseProtocol: string } | null {
  if (url.search || url.hash) return null;
  const protocolHeader = request.headers.get('Sec-WebSocket-Protocol');
  if (protocolHeader === null || protocolHeader.length > 8192) return null;
  const protocols = protocolHeader.split(',').map((value) => value.trim());
  const protocol = protocols[0];
  const credentialProtocol = protocols[1];
  if (
    protocols.length !== 2 ||
    protocol !== PRO_SIGNALING_WEBSOCKET_PROTOCOL ||
    typeof credentialProtocol !== 'string' ||
    !credentialProtocol.startsWith(PRO_SIGNALING_TICKET_PROTOCOL_PREFIX)
  ) {
    return null;
  }
  const ticket = credentialProtocol.slice(PRO_SIGNALING_TICKET_PROTOCOL_PREFIX.length);
  if (!ticket || ticket.length > 4096) return null;
  return {
    ticket,
    responseProtocol: PRO_SIGNALING_WEBSOCKET_PROTOCOL,
  };
}

async function hashGuestReconnectSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return bytesToBase64Url(new Uint8Array(digest));
}

function constantTimeStringEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < right.length; index++) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function standardRoomPinPepperKeyring(
  env: SignalingEnvPort,
): RemoteShareUploadAssertionKeyring | null {
  const candidate = env.MXQR_STANDARD_ROOM_PIN_PEPPER;
  const keyring = parseRemoteShareUploadAssertionKeyring(candidate);
  if (!keyring) return null;

  const pinKeys = [keyring.current, ...(keyring.previous ? [keyring.previous] : [])];
  if (
    pinKeys.some(
      ({ secret }) =>
        new TextEncoder().encode(secret).byteLength < STANDARD_ROOM_PIN_PEPPER_MIN_BYTES,
    )
  ) {
    return null;
  }

  // This verifier survives active-room hibernation and therefore needs an
  // independently rotatable key. Reject accidental reuse of another signaling
  // credential instead of coupling its lifetime to room PIN persistence.
  const remoteShareKeyring = parseRemoteShareUploadAssertionKeyring(
    env.MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET,
  );
  const otherSecrets: unknown[] = [
    env.MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET,
    env.MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET,
    remoteShareKeyring?.current.secret,
    remoteShareKeyring?.previous?.secret,
    env.PRO_SIGNALING_SECRET,
  ];
  for (const { secret } of pinKeys) {
    for (const otherSecret of otherSecrets) {
      if (typeof otherSecret === 'string' && constantTimeStringEqual(secret, otherSecret)) {
        return null;
      }
    }
  }
  return keyring;
}

async function createStandardRoomPinVerifierWithPepper(
  pepper: string,
  roomId: string,
  roomSecret: string | null,
  password: string,
): Promise<StandardRoomPinVerifier | null> {
  if (!pepper || !/^\d{6}$/.test(roomId) || !roomSecret || !/^\d{8}$/.test(password)) {
    return null;
  }
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(pepper),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const input = JSON.stringify([STANDARD_ROOM_PIN_HMAC_PURPOSE, roomId, roomSecret, password]);
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
    return {
      v: 1,
      algorithm: STANDARD_ROOM_PIN_HMAC_ALGORITHM,
      digest: bytesToBase64Url(new Uint8Array(digest)),
    };
  } catch {
    return null;
  }
}

async function createStandardRoomPinVerifier(
  env: SignalingEnvPort,
  roomId: string,
  roomSecret: string | null,
  password: string,
): Promise<StandardRoomPinVerifier | null> {
  const keyring = standardRoomPinPepperKeyring(env);
  if (!keyring) return null;
  return createStandardRoomPinVerifierWithPepper(
    keyring.current.secret,
    roomId,
    roomSecret,
    password,
  );
}

function workerVersionFields(env: SignalingEnvPort): {
  workerVersionId?: string;
  signalingLivenessVersion?: typeof SIGNALING_LIVENESS_VERSION;
} {
  const metadata = env.CF_VERSION_METADATA;
  const workerVersionId = isRecord(metadata) ? metadata.id : undefined;
  return typeof workerVersionId === 'string' && workerVersionId
    ? { workerVersionId, signalingLivenessVersion: SIGNALING_LIVENESS_VERSION }
    : {};
}

function remoteShareUploadAssertionSecret(env: SignalingEnvPort): string {
  const secret = env.MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET;
  return typeof secret === 'string' &&
    secret.length >= REMOTE_SHARE_UPLOAD_ASSERTION_SECRET_MIN_LENGTH &&
    parseRemoteShareUploadAssertionKeyring(secret)
    ? secret
    : '';
}

function remoteShareUploadAssertionFeatureFields(env: SignalingEnvPort): JsonRecord {
  return remoteShareUploadAssertionSecret(env)
    ? {
        remoteShareUploadAssertionVersion: REMOTE_SHARE_UPLOAD_ASSERTION_VERSION,
        remoteShareUploadAssertionKeyringVersion: REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_VERSION,
      }
    : {};
}

function defaultGuestBindings(): GuestBindings {
  return { v: 1, entries: [] };
}

function normalizeGuestBindings(value: unknown): GuestBindings | null {
  if (
    !hasExactKeys(value, ['v', 'entries']) ||
    value.v !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_GUEST_BINDINGS
  ) {
    return null;
  }
  const normalized = defaultGuestBindings();
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (
      !hasExactKeys(entry, ['peerId', 'secretHash', 'updatedAt']) ||
      !isValidPeerId(entry.peerId) ||
      seen.has(entry.peerId) ||
      typeof entry.secretHash !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(entry.secretHash) ||
      !isFiniteNumber(entry.updatedAt) ||
      entry.updatedAt < 0
    ) {
      return null;
    }
    seen.add(entry.peerId);
    normalized.entries.push({
      peerId: entry.peerId,
      secretHash: entry.secretHash,
      updatedAt: entry.updatedAt,
    });
  }
  return normalized;
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown | null> {
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) return null;
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let stop: (outcome: { kind: 'aborted' }) => void = () => {};
  const stopped = new Promise<{ kind: 'aborted' }>((resolve) => {
    stop = resolve;
  });
  const cancel = (reason: unknown): void => {
    try {
      Promise.resolve(reader.cancel(reason)).catch(() => {});
    } catch {
      // Cancellation is best-effort and must never delay the bounded result.
    }
  };
  const timeoutSignal = AbortSignal.timeout(INTERNAL_JSON_BODY_TIMEOUT_MS);
  const stopSignal =
    typeof AbortSignal.any === 'function'
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;
  const abort = () => {
    stop({ kind: 'aborted' });
    cancel(stopSignal.reason);
  };
  if (stopSignal.aborted) abort();
  else stopSignal.onabort = abort;
  try {
    while (true) {
      const outcome = await Promise.race([
        reader.read().then(
          (value) => ({ kind: 'read' as const, value }),
          () => ({ kind: 'invalid' as const }),
        ),
        stopped,
      ]);
      if (outcome.kind !== 'read') return null;
      const { done, value } = outcome.value;
      if (done) break;
      if (!value) continue;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        cancel('INTERNAL_REQUEST_BODY_TOO_LARGE');
        return null;
      }
      chunks.push(bytes);
    }
  } catch {
    return null;
  } finally {
    stopSignal.onabort = null;
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative stream may retain the timed-out pending read.
    }
  }
  if (totalBytes === 0) return null;
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
}

function cancelBodyStream(bodyOrReader: unknown, reason: unknown): void {
  const body = isRecord(bodyOrReader) && bodyOrReader.body ? bodyOrReader.body : bodyOrReader;
  if (!isRecord(body)) return;
  if (!body || typeof body.cancel !== 'function') return;
  try {
    Promise.resolve(body.cancel(reason)).catch(() => {});
  } catch {
    // Cancellation is best-effort and must never delay the fail-closed result.
  }
}

async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
  registerReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): Promise<unknown | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    cancelBodyStream(response, 'AUTHORITY_RESPONSE_TOO_LARGE');
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  registerReader(reader);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        cancelBodyStream(reader, 'AUTHORITY_RESPONSE_TOO_LARGE');
        return null;
      }
      chunks.push(bytes);
    }
  } catch {
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative body may retain the timed-out pending read.
    }
  }
  if (totalBytes === 0) return null;
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
}

async function fetchBoundedJsonWithSignal(
  fetcher: (request: Request) => Promise<Response>,
  request: Request,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ response: Response; value: unknown } | null> {
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timedOut = signal.aborted;
  let abort: (() => void) | null = null;
  const operation = Promise.resolve()
    .then(() => fetcher(request))
    .then(async (response) => {
      if (timedOut) {
        cancelBodyStream(response, signal.reason);
        return null;
      }
      const value = await readBoundedJsonResponse(response, maxBytes, (reader) => {
        activeReader = reader;
      });
      return timedOut ? null : { response, value };
    })
    // Normalize a dependency rejection even when it settles after the signal.
    .catch(() => null);
  const timeout = new Promise<null>((resolve) => {
    abort = () => {
      timedOut = true;
      cancelBodyStream(activeReader, signal.reason);
      resolve(null);
    };
    if (signal.aborted) abort();
    else signal.onabort = abort;
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (signal.onabort === abort) signal.onabort = null;
  }
}

function defaultProTicketUses(roomGeneration = INITIAL_PRO_ROOM_GENERATION): ProTicketUses {
  return { v: 1, roomGeneration, entries: [] };
}

function normalizeProTicketUses(value: unknown): ProTicketUses | null {
  if (
    !hasExactKeys(value, ['v', 'entries'], ['roomGeneration']) ||
    value.v !== 1 ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }
  const roomGeneration = exactProRoomGeneration(value.roomGeneration);
  if (roomGeneration === null) return null;
  if (value.entries.length > MAX_PRO_TICKET_USES) return null;
  const entries: ProTicketUse[] = [];
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!isRecord(entry)) return null;
    if (typeof entry.jti !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(entry.jti)) return null;
    if (!isSafeInteger(entry.exp) || entry.exp < 0 || seen.has(entry.jti)) return null;
    seen.add(entry.jti);
    entries.push({ jti: entry.jti, exp: entry.exp });
  }
  return { v: 1, roomGeneration, entries };
}

function normalizeProParticipantHighWater(value: unknown): ProParticipantHighWater | null {
  if (
    !hasExactKeys(value, ['v', 'entries'], ['roomGeneration']) ||
    value.v !== 1 ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }
  const roomGeneration = exactProRoomGeneration(value.roomGeneration);
  if (roomGeneration === null) return null;
  if (value.entries.length > MAX_PRO_PARTICIPANT_HIGH_WATER) return null;
  const entries: ProParticipantHighWaterEntry[] = [];
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !isValidPeerId(entry.participantId) ||
      seen.has(entry.participantId) ||
      typeof entry.presenceIncarnationId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(entry.presenceIncarnationId) ||
      !isSafeInteger(entry.ticketSequence) ||
      entry.ticketSequence < 1 ||
      !isSafeInteger(entry.exp) ||
      entry.exp < 0
    ) {
      return null;
    }
    seen.add(entry.participantId);
    entries.push({
      participantId: entry.participantId,
      presenceIncarnationId: entry.presenceIncarnationId,
      ticketSequence: entry.ticketSequence,
      exp: entry.exp,
    });
  }
  return { v: 1, roomGeneration, entries };
}

function normalizeProPresenceAuthority(value: unknown): ProPresenceAuthority | null {
  if (
    !hasExactKeys(
      value,
      ['v', 'roomId', 'coordinatorEpoch', 'presenceRevision', 'activeIncarnationIds'],
      ['roomGeneration'],
    ) ||
    value.v !== 1 ||
    !isProNamespaceRoomCode(value.roomId) ||
    !isValidProEpoch(value.coordinatorEpoch) ||
    !isSafeInteger(value.presenceRevision) ||
    value.presenceRevision < 0
  ) {
    return null;
  }
  const roomGeneration = exactProRoomGeneration(value.roomGeneration);
  if (roomGeneration === null) return null;
  const activeIncarnationIds = normalizeProBroadcastTargets(value.activeIncarnationIds);
  if (!activeIncarnationIds) return null;
  return {
    v: 1,
    roomId: value.roomId,
    roomGeneration,
    coordinatorEpoch: value.coordinatorEpoch,
    presenceRevision: value.presenceRevision,
    activeIncarnationIds: [...activeIncarnationIds].sort(),
  };
}

function normalizeProDecommissioned(value: unknown): ProDecommissioned | null {
  if (
    !hasExactKeys(
      value,
      ['v', 'roomCode', 'requestId', 'decommissionedAtMs'],
      ['roomGeneration'],
    ) ||
    value.v !== 1 ||
    !isProNamespaceRoomCode(value.roomCode) ||
    typeof value.requestId !== 'string' ||
    !ADMIN_REQUEST_ID_RE.test(value.requestId) ||
    !isSafeInteger(value.decommissionedAtMs) ||
    value.decommissionedAtMs <= 0
  ) {
    return null;
  }
  const roomGeneration = exactProRoomGeneration(value.roomGeneration);
  if (roomGeneration === null) return null;
  return {
    v: 1,
    roomCode: value.roomCode,
    roomGeneration,
    requestId: value.requestId,
    decommissionedAtMs: value.decommissionedAtMs,
  };
}

function normalizeProOwnerAccountDeletionFence(
  value: unknown,
): ProOwnerAccountDeletionFence | null {
  if (!isRecord(value)) return null;
  const roomGeneration = exactProRoomGeneration(value.roomGeneration);
  if (roomGeneration === null) return null;
  if (
    !isProNamespaceRoomCode(value.roomCode) ||
    !isSafeInteger(value.fencedCoordinatorEpoch) ||
    value.fencedCoordinatorEpoch < 0 ||
    !isSafeInteger(value.installedAtMs) ||
    value.installedAtMs <= 0
  ) {
    return null;
  }
  if (
    value.v === 1 &&
    hasExactKeys(
      value,
      ['v', 'roomCode', 'fencedCoordinatorEpoch', 'installedAtMs'],
      ['roomGeneration'],
    )
  ) {
    return {
      v: 1,
      roomCode: value.roomCode,
      roomGeneration,
      fencedCoordinatorEpoch: value.fencedCoordinatorEpoch,
      installedAtMs: value.installedAtMs,
    };
  }
  if (
    value.v === 2 &&
    hasExactKeys(
      value,
      [
        'v',
        'roomCode',
        'removalId',
        'removedOwnerAuthorityEpoch',
        'fencedCoordinatorEpoch',
        'installedAtMs',
      ],
      ['roomGeneration'],
    ) &&
    typeof value.removalId === 'string' &&
    OWNER_AUTHORITY_REMOVAL_ID_RE.test(value.removalId) &&
    isSafeInteger(value.removedOwnerAuthorityEpoch) &&
    value.removedOwnerAuthorityEpoch >= 0
  ) {
    return {
      v: 2,
      roomCode: value.roomCode,
      roomGeneration,
      removalId: value.removalId,
      removedOwnerAuthorityEpoch: value.removedOwnerAuthorityEpoch,
      fencedCoordinatorEpoch: value.fencedCoordinatorEpoch,
      installedAtMs: value.installedAtMs,
    };
  }
  return null;
}

function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
  );
}

async function signalingRateIdentity(
  request: Request,
  key: string,
  env: SignalingEnvPort,
): Promise<string> {
  const ip = getClientIp(request);
  const secret = String(env?.PRO_SIGNALING_SECRET || '');
  const keyBytes = new TextEncoder().encode(secret || 'musixquare-signaling-rate-v1');
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(`ws-open:${key}:${ip}`),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function normalizeStandardWsRateState(value: unknown): StandardWsRateState | null {
  if (
    !hasExactKeys(value, ['v', 'windowStartMs', 'resetAtMs', 'count']) ||
    value.v !== 1 ||
    !isSafeInteger(value.windowStartMs) ||
    value.windowStartMs < 0 ||
    value.windowStartMs % STANDARD_WS_RATE_WINDOW_MS !== 0 ||
    !isSafeInteger(value.resetAtMs) ||
    value.resetAtMs !== value.windowStartMs + STANDARD_WS_RATE_WINDOW_MS ||
    !isSafeInteger(value.count) ||
    value.count < 1 ||
    value.count > WS_RATE_LIMIT_PER_MINUTE
  ) {
    return null;
  }
  return {
    v: 1,
    windowStartMs: value.windowStartMs,
    resetAtMs: value.resetAtMs,
    count: value.count,
  };
}

function namedRoomStub(binding: unknown, name: string): FetcherPort | null {
  if (!isDurableObjectNamespace(binding)) return null;
  if (typeof binding.getByName === 'function') return binding.getByName(name);
  if (typeof binding.idFromName !== 'function' || typeof binding.get !== 'function') {
    return null;
  }
  return binding.get(binding.idFromName(name));
}

type StandardWsRateFetchOutcome =
  | { kind: 'response'; response: Response }
  | { kind: 'unavailable' };

async function fetchStandardWsRate(
  stub: FetcherPort,
  request: Request,
): Promise<StandardWsRateFetchOutcome> {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return { kind: 'unavailable' };
  }
  const signal = AbortSignal.timeout(STANDARD_WS_RATE_FETCH_TIMEOUT_MS);
  let abort: (() => void) | null = null;
  const operation = Promise.resolve()
    .then(() => stub.fetch(request))
    .then(
      (response) => ({ kind: 'response' as const, response }),
      () => ({ kind: 'unavailable' as const }),
    );
  const timeout = new Promise<StandardWsRateFetchOutcome>((resolve) => {
    abort = () => resolve({ kind: 'unavailable' });
    if (signal.aborted) abort();
    else signal.onabort = abort;
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (signal.onabort === abort) signal.onabort = null;
  }
}

interface SignalingRateLimitResult {
  status: 'ok' | 'unavailable' | 'unbound';
  allowed?: boolean;
  retryAfterSeconds?: number;
}

async function checkStandardWsRateLimit(
  request: Request,
  env: SignalingEnvPort,
): Promise<SignalingRateLimitResult> {
  try {
    const binding = env?.MUSIXQUARE_ROOMS;
    if (!binding) return { status: 'unavailable' };
    const identity = await signalingRateIdentity(request, 'ws-open', env);
    const stub = namedRoomStub(binding, `${STANDARD_WS_RATE_OBJECT_PREFIX}${identity}`);
    if (!stub || typeof stub.fetch !== 'function') return { status: 'unavailable' };
    const outcome = await fetchStandardWsRate(
      stub,
      new Request(`https://signaling-rate.internal${STANDARD_WS_RATE_CONSUME_PATH}`, {
        method: 'POST',
      }),
    );
    if (outcome.kind !== 'response') return { status: 'unavailable' };
    if (outcome.response?.status === 204) {
      return { status: 'ok', allowed: true, retryAfterSeconds: 0 };
    }
    if (outcome.response?.status === 429) {
      return { status: 'ok', allowed: false, retryAfterSeconds: 0 };
    }
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

async function checkProRateLimit(
  request: Request,
  env: SignalingEnvPort,
  key: string,
  limit = WS_RATE_LIMIT_PER_MINUTE,
  windowSec = 60,
): Promise<SignalingRateLimitResult> {
  if (!env?.MUSIXQUARE_SERVICE_CONTROL) {
    // Direct unit runtimes omit production bindings and Cache API. A real
    // Cloudflare deployment missing the atomic namespace fails closed.
    return typeof caches === 'undefined'
      ? { status: 'ok', allowed: true, retryAfterSeconds: 0 }
      : { status: 'unavailable' };
  }
  const identity = await signalingRateIdentity(request, key, env);
  return consumeAbuseRateLimit(env, {
    scope: `signaling-${key}`,
    identity,
    limit,
    windowMs: windowSec * 1_000,
  });
}

function send(ws: SocketPort, message: unknown): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* noop */
  }
}

function sendChecked(ws: SocketPort, message: unknown): boolean {
  try {
    // Cloudflare exposes the standard numeric readyState values. A closed
    // hibernatable socket may discard send() without throwing, so a successful
    // call alone is not proof that peer-open can reach the candidate.
    if (typeof ws.readyState === 'number' && ws.readyState !== 1) return false;
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function closeWithError(ws: SocketPort, errorType: string, message: string, code = 1011): void {
  send(ws, { type: 'error', errorType, message });
  try {
    ws.close(code, message);
  } catch {
    /* noop */
  }
}

function getMetricsDb(env: SignalingEnvPort): D1DatabasePort | null {
  if (isD1Database(env.MUSIXQUARE_ADMIN_DB)) return env.MUSIXQUARE_ADMIN_DB;
  return isD1Database(env.ADMIN_METRICS_DB) ? env.ADMIN_METRICS_DB : null;
}

async function recordMetric(env: SignalingEnvPort, event: string, now = Date.now()): Promise<void> {
  if ((await readServiceMaintenance(env)).enabled) return;
  const db = getMetricsDb(env);
  if (!db || !event) return;
  const bucketMinute = Math.floor(now / 60000);
  try {
    await db
      .prepare(
        `INSERT INTO ${METRICS_TABLE} (bucket_minute, event, count)
         VALUES (?1, ?2, 1)
         ON CONFLICT(bucket_minute, event)
         DO UPDATE SET count = count + 1`,
      )
      .bind(bucketMinute, event)
      .run();
  } catch (error) {
    console.warn('[Metrics] Failed to record signaling metric', event, error);
  }
}

function defaultRoomMeta(): CurrentRoomMeta {
  return {
    v: 2,
    roomSecret: null,
    roomPassword: '',
    roomPasswordVerifier: null,
    hostPeerId: null,
    hostReleaseAt: 0,
  };
}

function defaultStandardRoomMembers(): StandardRoomMembers {
  return { v: 1, entries: [] };
}

function normalizeStandardRoomMembers(value: unknown): StandardRoomMembers {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.entries)) {
    return defaultStandardRoomMembers();
  }
  const entries: StandardRoomMember[] = [];
  const accountSubjects = new Set<string>();
  const memberIds = new Set<string>();
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.accountSubject !== 'string' ||
      !/^sub_[A-Za-z0-9_-]{22}$/.test(entry.accountSubject) ||
      typeof entry.memberId !== 'string' ||
      !/^member_[A-Za-z0-9_-]{22}$/.test(entry.memberId) ||
      !isSafeInteger(entry.memberDisplayNumber) ||
      entry.memberDisplayNumber < 0 ||
      entry.memberDisplayNumber > 99 ||
      accountSubjects.has(entry.accountSubject) ||
      memberIds.has(entry.memberId)
    ) {
      continue;
    }
    accountSubjects.add(entry.accountSubject);
    memberIds.add(entry.memberId);
    entries.push({
      accountSubject: entry.accountSubject,
      memberId: entry.memberId,
      memberDisplayNumber: entry.memberDisplayNumber,
    });
    if (entries.length >= MAX_STANDARD_ROOM_ACCOUNT_MEMBERS) break;
  }
  return { v: 1, entries };
}

function standardRoomMemberIdentityFromAttachment(
  attachment: unknown,
): StandardRoomIdentityProjection | null {
  if (!isRecord(attachment)) return null;
  if (
    typeof attachment?.memberId !== 'string' ||
    !/^member_[A-Za-z0-9_-]{22}$/.test(attachment.memberId) ||
    !isSafeInteger(attachment.memberDisplayNumber) ||
    typeof attachment.memberNickname !== 'string' ||
    !attachment.memberNickname ||
    !isSafeInteger(attachment.identityExpiresAt) ||
    Date.now() >= attachment.identityExpiresAt
  ) {
    return null;
  }
  return {
    memberId: attachment.memberId,
    memberDisplayNumber: attachment.memberDisplayNumber,
    nickname: attachment.memberNickname,
    isAuthenticated: true,
  };
}

function standardRoomIdentityAttachmentFields(
  identity: StandardRoomIdentity | null | undefined,
): StandardIdentityFields {
  if (!identity) return {};
  return {
    accountSubject: identity.accountSubject,
    memberId: identity.memberId,
    memberDisplayNumber: identity.memberDisplayNumber,
    memberNickname: identity.nickname,
    identityExpiresAt: identity.expiresAt * 1000,
  };
}

function withoutStandardRoomIdentity(
  attachment: StandardHostOkAttachment | StandardGuestOkAttachment,
): StandardHostOkAttachment | StandardGuestOkAttachment;
function withoutStandardRoomIdentity(
  attachment: StandardSocketAttachment,
): StandardSocketAttachment;
function withoutStandardRoomIdentity(
  attachment: StandardSocketAttachment,
): StandardSocketAttachment {
  const {
    accountSubject: _accountSubject,
    memberId: _memberId,
    memberDisplayNumber: _memberDisplayNumber,
    memberNickname: _memberNickname,
    identityExpiresAt: _identityExpiresAt,
    ...rest
  } = attachment;
  return rest;
}

function invalidStandardRoomPinVerifier(): InvalidStandardRoomPinVerifier {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const digest = bytesToBase64Url(random);
  if (!/^[A-Za-z0-9_-]{43}$/.test(digest)) {
    throw new Error('STANDARD_ROOM_PIN_QUARANTINE_LOCK_UNAVAILABLE');
  }
  return { v: 0, algorithm: 'INVALID', digest };
}

function standardRoomPinRollbackLock(verifier: RoomPinVerifier | null): string {
  if (verifier === null) return '';
  const prefix = isValidStandardRoomPinVerifier(verifier)
    ? STANDARD_ROOM_PIN_ROLLBACK_LOCK_PREFIX
    : STANDARD_ROOM_PIN_QUARANTINE_LOCK_PREFIX;
  return `${prefix}${verifier.digest}`;
}

function standardRoomPinVerifierFromRollbackLock(value: unknown): RoomPinVerifier | null {
  if (typeof value !== 'string') return null;
  const verifierDigest = STANDARD_ROOM_PIN_ROLLBACK_LOCK_RE.exec(value)?.[1];
  if (verifierDigest) {
    return { v: 1, algorithm: STANDARD_ROOM_PIN_HMAC_ALGORITHM, digest: verifierDigest };
  }
  const quarantineDigest = STANDARD_ROOM_PIN_QUARANTINE_LOCK_RE.exec(value)?.[1];
  return quarantineDigest ? { v: 0, algorithm: 'INVALID', digest: quarantineDigest } : null;
}

function isLegacyRollbackLockedRoomMeta(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.v === 1 &&
    standardRoomPinVerifierFromRollbackLock(value.roomPassword) !== null
  );
}

function normalizeStandardRoomPinVerifier(value: unknown): RoomPinVerifier {
  if (
    hasExactKeys(value, ['v', 'algorithm', 'digest']) &&
    value.v === 1 &&
    value.algorithm === STANDARD_ROOM_PIN_HMAC_ALGORITHM &&
    typeof value.digest === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value.digest)
  ) {
    return {
      v: 1,
      algorithm: STANDARD_ROOM_PIN_HMAC_ALGORITHM,
      digest: value.digest,
    };
  }
  if (
    hasExactKeys(value, ['v', 'algorithm', 'digest']) &&
    value.v === 0 &&
    value.algorithm === 'INVALID' &&
    typeof value.digest === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value.digest)
  ) {
    return { v: 0, algorithm: 'INVALID', digest: value.digest };
  }
  return invalidStandardRoomPinVerifier();
}

function isValidStandardRoomPinVerifier(value: RoomPinVerifier): value is StandardRoomPinVerifier {
  return (
    value.v === 1 &&
    value.algorithm === STANDARD_ROOM_PIN_HMAC_ALGORITHM &&
    /^[A-Za-z0-9_-]{43}$/.test(value.digest)
  );
}

function roomMetaBase(value: JsonRecord): RoomMetaBase {
  return {
    roomSecret: typeof value.roomSecret === 'string' && value.roomSecret ? value.roomSecret : null,
    hostPeerId: typeof value.hostPeerId === 'string' && value.hostPeerId ? value.hostPeerId : null,
    hostReleaseAt: isFiniteNumber(value.hostReleaseAt) ? Math.max(0, value.hostReleaseAt) : 0,
  };
}

function hasValidRoomMetaBase(value: JsonRecord): boolean {
  return (
    (value.roomSecret === null ||
      (typeof value.roomSecret === 'string' && value.roomSecret.length > 0)) &&
    (value.hostPeerId === null ||
      (typeof value.hostPeerId === 'string' && value.hostPeerId.length > 0)) &&
    isFiniteNumber(value.hostReleaseAt) &&
    value.hostReleaseAt >= 0
  );
}

function invalidCurrentRoomMeta(base: RoomMetaBase): CurrentRoomMeta {
  const verifier = invalidStandardRoomPinVerifier();
  return {
    v: 2,
    ...base,
    roomPassword: standardRoomPinRollbackLock(verifier),
    roomPasswordVerifier: verifier,
  };
}

function isExactLegacyRoomMeta(value: JsonRecord): boolean {
  return hasExactKeys(value, ['v', 'roomSecret', 'roomPassword', 'hostPeerId', 'hostReleaseAt']);
}

function isFutureRoomMeta(value: unknown): value is JsonRecord {
  return isRecord(value) && isSafeInteger(value.v) && value.v > 2;
}

function isCanonicalQuarantinedRoomMeta(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.v !== 2 ||
    !hasExactKeys(value, [
      'v',
      'roomSecret',
      'roomPassword',
      'roomPasswordVerifier',
      'hostPeerId',
      'hostReleaseAt',
    ]) ||
    !hasValidRoomMetaBase(value) ||
    !hasExactKeys(value.roomPasswordVerifier, ['v', 'algorithm', 'digest']) ||
    value.roomPasswordVerifier.v !== 0 ||
    value.roomPasswordVerifier.algorithm !== 'INVALID' ||
    typeof value.roomPasswordVerifier.digest !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.roomPasswordVerifier.digest)
  ) {
    return false;
  }
  const verifier: InvalidStandardRoomPinVerifier = {
    v: 0,
    algorithm: 'INVALID',
    digest: value.roomPasswordVerifier.digest,
  };
  return (
    value.roomPassword === standardRoomPinRollbackLock(verifier) &&
    typeof value.roomPassword === 'string'
  );
}

function normalizeRoomMeta(value: unknown): RoomMeta {
  if (value === undefined) return defaultRoomMeta();
  if (!isRecord(value)) {
    return invalidCurrentRoomMeta({
      roomSecret: null,
      hostPeerId: null,
      hostReleaseAt: 0,
    });
  }
  const base = roomMetaBase(value);
  if (!hasValidRoomMetaBase(value)) return invalidCurrentRoomMeta(base);
  if (value.v === 1) {
    if (!isExactLegacyRoomMeta(value)) return invalidCurrentRoomMeta(base);
    if (typeof value.roomPassword !== 'string') return invalidCurrentRoomMeta(base);
    const rollbackVerifier = standardRoomPinVerifierFromRollbackLock(value.roomPassword);
    if (rollbackVerifier) {
      return {
        v: 2,
        ...base,
        roomPassword: standardRoomPinRollbackLock(rollbackVerifier),
        roomPasswordVerifier: rollbackVerifier,
      };
    }
    if (value.roomPassword !== '' && !/^\d{8}$/.test(value.roomPassword)) {
      return invalidCurrentRoomMeta(base);
    }
    return {
      v: 1,
      ...base,
      roomPassword: value.roomPassword,
    };
  }
  if (
    value.v === 2 &&
    hasExactKeys(value, [
      'v',
      'roomSecret',
      'roomPassword',
      'roomPasswordVerifier',
      'hostPeerId',
      'hostReleaseAt',
    ])
  ) {
    if (value.roomPasswordVerifier === null && value.roomPassword === '') {
      return {
        v: 2,
        ...base,
        roomPassword: '',
        roomPasswordVerifier: null,
      };
    }
    const verifier = normalizeStandardRoomPinVerifier(value.roomPasswordVerifier);
    if (
      typeof value.roomPassword === 'string' &&
      value.roomPassword === standardRoomPinRollbackLock(verifier)
    ) {
      return {
        v: 2,
        ...base,
        roomPassword: standardRoomPinRollbackLock(verifier),
        roomPasswordVerifier: verifier,
      };
    }
    return invalidCurrentRoomMeta(base);
  }
  // Unknown or ambiguous future/corrupt metadata must not silently downgrade a
  // protected room to passwordless. The sentinel remains quarantined until the
  // room epoch is explicitly discarded through its lifecycle boundary.
  return invalidCurrentRoomMeta(base);
}

function currentRoomMeta(
  meta: RoomMeta,
  roomPasswordVerifier: StandardRoomPinVerifier | null,
): CurrentRoomMeta {
  return {
    v: 2,
    roomSecret: meta.roomSecret,
    roomPassword: standardRoomPinRollbackLock(roomPasswordVerifier),
    roomPasswordVerifier,
    hostPeerId: meta.hostPeerId,
    hostReleaseAt: meta.hostReleaseAt,
  };
}

function hasStandardRoomPassword(meta: RoomMeta): boolean {
  return meta.v === 1 ? Boolean(meta.roomPassword) : meta.roomPasswordVerifier !== null;
}

function isQuarantinedRoomMeta(meta: RoomMeta): boolean {
  return meta.v === 2 && meta.roomPasswordVerifier?.v === 0;
}

function normalizeProRoomMeta(value: unknown): ProRoomMeta | null {
  if (
    !hasExactKeys(value, ['v', 'kind', 'roomId', 'coordinatorEpoch'], ['roomGeneration']) ||
    value.v !== 2 ||
    value.kind !== 'pro' ||
    !isProNamespaceRoomCode(value.roomId)
  ) {
    return null;
  }
  const roomGeneration = exactProRoomGeneration(value.roomGeneration);
  if (roomGeneration === null) return null;
  if (!isValidProEpoch(value.coordinatorEpoch)) return null;
  return {
    v: 2,
    kind: 'pro',
    roomId: value.roomId,
    roomGeneration,
    coordinatorEpoch: value.coordinatorEpoch,
  };
}

function defaultProChatControlState(
  roomId: string,
  roomGeneration: number,
  coordinatorEpoch: number,
): ProChatControlState {
  return {
    v: 1,
    roomId,
    roomGeneration,
    coordinatorEpoch,
    revision: 0,
    frozen: false,
    filterEnabled: false,
    slowmodeSeconds: 0,
    mutedParticipantIds: [],
  };
}

function normalizeProChatControlState(value: unknown): ProChatControlState | null {
  if (
    !hasExactKeys(value, [
      'v',
      'roomId',
      'roomGeneration',
      'coordinatorEpoch',
      'revision',
      'frozen',
      'filterEnabled',
      'slowmodeSeconds',
      'mutedParticipantIds',
    ]) ||
    value.v !== 1 ||
    !isProNamespaceRoomCode(value.roomId) ||
    !isProRoomGeneration(value.roomGeneration) ||
    !isValidProEpoch(value.coordinatorEpoch) ||
    !isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.frozen !== 'boolean' ||
    typeof value.filterEnabled !== 'boolean' ||
    !isSafeInteger(value.slowmodeSeconds) ||
    value.slowmodeSeconds < 0 ||
    value.slowmodeSeconds > PRO_CHAT_SLOWMODE_MAX_SECONDS ||
    !Array.isArray(value.mutedParticipantIds) ||
    value.mutedParticipantIds.length > MAX_PRO_ROOM_MEMBERS
  ) {
    return null;
  }
  const mutedParticipantIds: string[] = [];
  const seen = new Set<string>();
  for (const participantId of value.mutedParticipantIds) {
    if (!isValidPeerId(participantId) || seen.has(participantId)) return null;
    seen.add(participantId);
    mutedParticipantIds.push(participantId);
  }
  mutedParticipantIds.sort();
  return {
    v: 1,
    roomId: value.roomId,
    roomGeneration: value.roomGeneration,
    coordinatorEpoch: value.coordinatorEpoch,
    revision: value.revision,
    frozen: value.frozen,
    filterEnabled: value.filterEnabled,
    slowmodeSeconds: value.slowmodeSeconds,
    mutedParticipantIds,
  };
}

function defaultProBotRequestProofs(
  roomId: string,
  roomGeneration: number,
  coordinatorEpoch: number,
): ProBotRequestProofs {
  return { v: 1, roomId, roomGeneration, coordinatorEpoch, entries: [] };
}

function normalizeProBotRequestProofs(value: unknown): ProBotRequestProofs | null {
  if (
    !hasExactKeys(value, ['v', 'roomId', 'roomGeneration', 'coordinatorEpoch', 'entries']) ||
    value.v !== 1 ||
    !isProNamespaceRoomCode(value.roomId) ||
    !isProRoomGeneration(value.roomGeneration) ||
    !isValidProEpoch(value.coordinatorEpoch) ||
    !Array.isArray(value.entries) ||
    value.entries.length > PRO_BOT_REQUEST_PROOF_MAX_ITEMS
  ) {
    return null;
  }

  const entries: ProBotRequestProof[] = [];
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (
      !hasExactKeys(entry, ['requestId', 'participantId', 'status', 'expiresAtMs']) ||
      typeof entry.requestId !== 'string' ||
      !PRO_REALTIME_EVENT_ID_RE.test(entry.requestId) ||
      !isValidPeerId(entry.participantId) ||
      (entry.status !== 'pending' && entry.status !== 'consumed') ||
      !isSafeInteger(entry.expiresAtMs) ||
      entry.expiresAtMs <= 0 ||
      seen.has(entry.requestId)
    ) {
      return null;
    }
    seen.add(entry.requestId);
    entries.push({
      requestId: entry.requestId,
      participantId: entry.participantId,
      status: entry.status,
      expiresAtMs: entry.expiresAtMs,
    });
  }
  return {
    v: 1,
    roomId: value.roomId,
    roomGeneration: value.roomGeneration,
    coordinatorEpoch: value.coordinatorEpoch,
    entries,
  };
}

function normalizeStandardRoomIdentityAttachment(value: JsonRecord): StandardIdentityFields {
  const identityKeys = [
    'accountSubject',
    'memberId',
    'memberDisplayNumber',
    'memberNickname',
    'identityExpiresAt',
  ];
  const present = identityKeys.filter((key) => value[key] !== undefined);
  if (present.length === 0) return {};
  if (
    present.length !== identityKeys.length ||
    typeof value.accountSubject !== 'string' ||
    !/^sub_[A-Za-z0-9_-]{22}$/.test(value.accountSubject) ||
    typeof value.memberId !== 'string' ||
    !/^member_[A-Za-z0-9_-]{22}$/.test(value.memberId) ||
    !isSafeInteger(value.memberDisplayNumber) ||
    value.memberDisplayNumber < 0 ||
    value.memberDisplayNumber > 99 ||
    typeof value.memberNickname !== 'string' ||
    !value.memberNickname.trim() ||
    [...value.memberNickname].length > 20 ||
    !isSafeVisibleDisplayName(value.memberNickname.normalize('NFC').trim()) ||
    !isSafeInteger(value.identityExpiresAt) ||
    value.identityExpiresAt <= 0
  ) {
    return {};
  }
  return {
    accountSubject: value.accountSubject,
    memberId: value.memberId,
    memberDisplayNumber: value.memberDisplayNumber,
    memberNickname: value.memberNickname.normalize('NFC').trim(),
    identityExpiresAt: value.identityExpiresAt,
  };
}

function normalizeAttachment(value: unknown): SocketAttachment | null {
  if (!isRecord(value) || value.v !== ATTACHMENT_VERSION) return null;
  if (typeof value.roomId !== 'string' || !value.roomId) return null;
  if (typeof value.peerId !== 'string' || !value.peerId) return null;

  if (value.roomKind === 'pro') {
    if (value.role !== 'member') return null;
    if (!isProNamespaceRoomCode(value.roomId) || value.peerId !== value.participantId) return null;
    const roomGeneration = exactProRoomGeneration(value.roomGeneration);
    if (roomGeneration === null) return null;
    if (!isValidProEpoch(value.coordinatorEpoch)) return null;
    if (!isValidPeerId(value.participantId)) return null;
    if (
      value.memberId !== undefined &&
      (typeof value.memberId !== 'string' ||
        !/^(?:member|owner)_[A-Za-z0-9_-]{16,128}$/.test(value.memberId))
    ) {
      return null;
    }
    if (
      typeof value.displayName !== 'string' ||
      value.displayName.length < 1 ||
      value.displayName.length > PRO_DISPLAY_NAME_MAX_LENGTH ||
      !isSafeVisibleDisplayName(value.displayName)
    ) {
      return null;
    }
    if (typeof value.ticketJti !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.ticketJti)) {
      return null;
    }
    if (
      typeof value.presenceIncarnationId !== 'string' ||
      !PRO_PRESENCE_INCARNATION_ID_RE.test(value.presenceIncarnationId) ||
      (value.presenceRevision !== undefined &&
        (!isSafeInteger(value.presenceRevision) || value.presenceRevision < 0)) ||
      !isSafeInteger(value.ticketSequence) ||
      value.ticketSequence < 1
    ) {
      return null;
    }
    if (value.auth !== 'ok') return null;
    const proAttachment: ProSocketAttachment = {
      v: ATTACHMENT_VERSION,
      roomKind: 'pro',
      role: 'member',
      roomId: value.roomId,
      roomGeneration,
      peerId: value.peerId,
      participantId: value.participantId,
      ...(typeof value.memberId === 'string' ? { memberId: value.memberId } : {}),
      displayName: value.displayName,
      coordinatorEpoch: value.coordinatorEpoch,
      // Older live attachments can survive a rolling Worker deployment. Their
      // incarnation is still checked against the persisted authoritative set;
      // revision zero is used only as attachment metadata, never to admit a
      // newly presented ticket.
      presenceRevision: value.presenceRevision ?? 0,
      ticketJti: value.ticketJti,
      presenceIncarnationId: value.presenceIncarnationId,
      ticketSequence: value.ticketSequence,
      auth: 'ok',
    };
    if (
      isFiniteNumber(value.realtimeMessageTokens) &&
      isFiniteNumber(value.realtimeMessageUpdatedAt)
    ) {
      proAttachment.realtimeMessageTokens = Math.min(
        GUEST_MESSAGE_BUCKET_CAPACITY,
        Math.max(0, value.realtimeMessageTokens),
      );
      proAttachment.realtimeMessageUpdatedAt = Math.max(0, value.realtimeMessageUpdatedAt);
    }
    if (isFiniteNumber(value.chatLastMessageAtMs)) {
      proAttachment.chatLastMessageAtMs = Math.max(0, value.chatLastMessageAtMs);
    }
    return proAttachment;
  }

  if (value.role !== 'host' && value.role !== 'guest') return null;

  if (value.role === 'host') {
    if (value.auth === 'ok' && typeof value.secret === 'string' && value.secret) {
      const remoteShareUploadAssertionBucket =
        isFiniteNumber(value.remoteShareUploadAssertionTokens) &&
        isFiniteNumber(value.remoteShareUploadAssertionUpdatedAt)
          ? {
              remoteShareUploadAssertionTokens: Math.min(
                REMOTE_SHARE_UPLOAD_ASSERTION_BUCKET_CAPACITY,
                Math.max(0, value.remoteShareUploadAssertionTokens),
              ),
              remoteShareUploadAssertionUpdatedAt: Math.max(
                0,
                value.remoteShareUploadAssertionUpdatedAt,
              ),
            }
          : {};
      return {
        v: ATTACHMENT_VERSION,
        role: 'host',
        roomId: value.roomId,
        peerId: value.peerId,
        secret: value.secret,
        auth: 'ok',
        ...(value.pinConfigurationPending === true
          ? {
              pinConfigurationPending: true as const,
              ...(typeof value.pinConfigurationMutationId === 'string' &&
              /^[A-Za-z0-9_-]{16,64}$/.test(value.pinConfigurationMutationId)
                ? { pinConfigurationMutationId: value.pinConfigurationMutationId }
                : {}),
            }
          : {}),
        ...normalizeStandardRoomIdentityAttachment(value),
        ...remoteShareUploadAssertionBucket,
      };
    }
    if (value.auth === 'pending') {
      return {
        v: ATTACHMENT_VERSION,
        role: 'host',
        roomId: value.roomId,
        peerId: value.peerId,
        auth: 'pending',
        authDeadline: isFiniteNumber(value.authDeadline) ? value.authDeadline : 0,
        authStarted: value.authStarted === true,
      };
    }
    return null;
  }

  const guestMessageBucket =
    isFiniteNumber(value.guestMessageTokens) && isFiniteNumber(value.guestMessageUpdatedAt)
      ? {
          guestMessageTokens: Math.min(
            GUEST_MESSAGE_BUCKET_CAPACITY,
            Math.max(0, value.guestMessageTokens),
          ),
          guestMessageUpdatedAt: Math.max(0, value.guestMessageUpdatedAt),
        }
      : {};
  if (value.auth === 'ok') {
    return {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId: value.roomId,
      peerId: value.peerId,
      auth: 'ok',
      ...normalizeStandardRoomIdentityAttachment(value),
      ...guestMessageBucket,
    };
  }

  if (value.auth === 'pending') {
    return {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId: value.roomId,
      peerId: value.peerId,
      auth: 'pending',
      authDeadline: isFiniteNumber(value.authDeadline) ? value.authDeadline : 0,
      authStarted: value.authStarted === true,
      ...guestMessageBucket,
    };
  }

  return null;
}

function deserializeAttachment(ws: SocketPort | null | undefined): unknown | null {
  try {
    return ws?.deserializeAttachment?.() ?? null;
  } catch {
    return null;
  }
}

function readAttachment(ws: SocketPort | null | undefined): SocketAttachment | null {
  return normalizeAttachment(deserializeAttachment(ws));
}

function serializeSocketAttachment(ws: SocketPort, attachment: SocketAttachment): void {
  const stored =
    attachment?.roomKind === 'pro'
      ? persistedProGenerationRecord(attachment, attachment.roomGeneration)
      : attachment;
  ws.serializeAttachment(stored);
}

function closeSocket(ws: SocketPort, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* noop */
  }
}

function createWebSocketPairPorts(): [SocketPort, SocketPort] {
  const pairConstructor = (
    globalThis as typeof globalThis & {
      WebSocketPair?: new () => unknown;
    }
  ).WebSocketPair;
  if (typeof pairConstructor !== 'function') throw new Error('WEBSOCKET_PAIR_UNAVAILABLE');
  const pair = new pairConstructor();
  const sockets =
    typeof pair === 'object' && pair !== null ? Object.values(pair as Record<string, unknown>) : [];
  const [client, server] = sockets;
  const isSocket = (value: unknown): value is SocketPort =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<SocketPort>).send === 'function' &&
    typeof (value as Partial<SocketPort>).close === 'function' &&
    typeof (value as Partial<SocketPort>).serializeAttachment === 'function';
  if (!isSocket(client) || !isSocket(server)) throw new Error('WEBSOCKET_PAIR_UNAVAILABLE');
  return [client, server];
}

function webSocketUpgradeResponse(client: SocketPort, headers?: HeaderRecord): Response {
  const init: ResponseInit = {
    status: 101,
    ...(headers ? { headers } : {}),
  };
  Object.defineProperty(init, 'webSocket', {
    value: client,
    enumerable: true,
  });
  return new Response(null, init);
}

function normalizeStandardHttpBridgeMeta(value: unknown): StandardHttpBridgeMeta | null {
  if (
    !hasExactKeys(value, [
      'v',
      'sessionId',
      'generation',
      'roomId',
      'role',
      'peerId',
      'lastClientSeq',
      'lastServerSeq',
      'lastServerAck',
      'requestEpoch',
      'leaseExpiresAt',
    ]) ||
    value.v !== 1 ||
    typeof value.sessionId !== 'string' ||
    !STANDARD_HTTP_BRIDGE_SESSION_ID_RE.test(value.sessionId) ||
    typeof value.generation !== 'string' ||
    !STANDARD_HTTP_BRIDGE_GENERATION_RE.test(value.generation) ||
    typeof value.roomId !== 'string' ||
    !STANDARD_HTTP_BRIDGE_ROOM_ID_RE.test(value.roomId) ||
    (value.role !== 'host' && value.role !== 'guest') ||
    !isValidPeerId(value.peerId) ||
    !isSafeInteger(value.lastClientSeq) ||
    value.lastClientSeq < 0 ||
    !isSafeInteger(value.lastServerSeq) ||
    value.lastServerSeq < 0 ||
    !isSafeInteger(value.lastServerAck) ||
    value.lastServerAck < 0 ||
    value.lastServerAck > value.lastServerSeq ||
    !isSafeInteger(value.requestEpoch) ||
    value.requestEpoch < 0 ||
    !isFiniteNumber(value.leaseExpiresAt) ||
    value.leaseExpiresAt < 0
  ) {
    return null;
  }
  return {
    v: 1,
    sessionId: value.sessionId,
    generation: value.generation,
    roomId: value.roomId,
    role: value.role,
    peerId: value.peerId,
    lastClientSeq: value.lastClientSeq,
    lastServerSeq: value.lastServerSeq,
    lastServerAck: value.lastServerAck,
    requestEpoch: value.requestEpoch,
    leaseExpiresAt: value.leaseExpiresAt,
  };
}

async function standardHttpBridgeFrameDigest(frame: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(frame));
  return bytesToBase64Url(new Uint8Array(digest));
}

function standardHttpBridgeMessageData(event: unknown): unknown {
  return typeof event === 'object' && event !== null && 'data' in event
    ? (event as { readonly data?: unknown }).data
    : undefined;
}

function standardHttpBridgeCloseTerminal(event: unknown): StandardHttpBridgeTerminal {
  const record =
    typeof event === 'object' && event !== null
      ? (event as { readonly code?: unknown; readonly reason?: unknown })
      : {};
  const code =
    isSafeInteger(record.code) && record.code >= 1000 && record.code <= 4999 ? record.code : 1006;
  const reason =
    typeof record.reason === 'string' && new TextEncoder().encode(record.reason).byteLength <= 123
      ? record.reason
      : '';
  return { code, reason };
}

export class MusixquareRoom {
  private readonly state: DurableObjectStatePort;
  private readonly env: SignalingEnvPort;
  private readonly standardHttpBridgeOnly: boolean;
  private readonly standardHttpBridgeSessionId: string | null;
  private standardHttpBridgeReady: Promise<unknown>;
  private standardHttpBridgeMeta: StandardHttpBridgeMeta | null;
  private standardHttpBridgeSocket: OutboundWebSocketPort | null;
  private standardHttpBridgeSocketFence: number;
  private standardHttpBridgeLastClientDigest: string | null;
  private readonly standardHttpBridgeQueue: StandardHttpBridgeEvent[];
  private standardHttpBridgeQueueBytes: number;
  private standardHttpBridgeTerminal: StandardHttpBridgeTerminal | null;
  private standardHttpBridgeWaiter: StandardHttpBridgeWaiter | null;
  private standardHttpBridgeMutationSync: Promise<unknown>;
  private readonly standardRateOnly: boolean;
  private standardRateState: StandardWsRateState | null;
  private standardRateStateInvalid: boolean;
  private standardRateAlarmAt: number | null;
  private standardRateReady: Promise<unknown>;
  private standardRoomId: string | null;
  private standardSocketsValidated: boolean;
  private readonly standardPinRetrySockets: Set<SocketPort>;
  private futureRoomMetaVersion: boolean;
  private standardRoomPinMutationFence: string | null;
  private standardRoomPinMutationFenceOwner: SocketPort | null;
  private roomMeta: RoomMeta | null;
  private roomMetaLoad: Promise<RoomMeta> | null;
  private proRoomMeta: ProRoomMeta | null;
  private host: SocketPort | null;
  private hostPeerId: string | null;
  private readonly pendingHosts: Set<SocketPort>;
  private readonly guests: Map<string, SocketPort>;
  private readonly pendingGuests: Set<SocketPort>;
  private readonly proMembers: Map<string, SocketPort>;
  private guestBindings: GuestBindings | null;
  private guestBindingsInvalid: boolean;
  private guestBindingsFutureVersion: boolean;
  private guestBindingsLoad: Promise<GuestBindings> | null;
  private standardRoomMembers: StandardRoomMembers | null;
  private proTicketUses: ProTicketUses | null;
  private proParticipantHighWater: ProParticipantHighWater | null;
  private proPresenceAuthority: ProPresenceAuthority | null | undefined;
  private proChatControlState: ProChatControlState | null | undefined;
  private proBotRequestProofs: ProBotRequestProofs | null | undefined;
  private proOwnerAccountDeletionFence: ProOwnerAccountDeletionFence | null | undefined;
  private standardAdmissionSync: Promise<unknown>;
  private standardOrderedIngressSync: Promise<unknown>;
  private proAdmissionSync: Promise<unknown>;
  private proChatMutationSync: Promise<unknown>;
  private readonly proRealtimeIngressDepth: WeakMap<SocketPort, number>;
  private readonly proSystemAudioSignalIngressSync: WeakMap<SocketPort, Promise<unknown>>;
  private readonly proSystemAudioSignalIngressDepth: WeakMap<SocketPort, number>;
  private alarmSync: Promise<unknown>;
  private alarmMaintenanceRetryAttempt: number;
  private proSocketsValidated: boolean;

  constructor(state: DurableObjectStatePort, env: SignalingEnvPort = {}) {
    this.state = state;
    this.env = env;
    const objectName = String(state.id?.name || '');
    const standardHttpBridgeMatch = objectName.match(STANDARD_HTTP_BRIDGE_OBJECT_NAME_RE);
    this.standardHttpBridgeOnly = objectName.startsWith(STANDARD_HTTP_BRIDGE_OBJECT_PREFIX);
    this.standardHttpBridgeSessionId = standardHttpBridgeMatch?.[1] || null;
    const requestResponsePair = (
      globalThis as typeof globalThis & {
        WebSocketRequestResponsePair?: new (request: string, response: string) => unknown;
      }
    ).WebSocketRequestResponsePair;
    if (
      !this.standardHttpBridgeOnly &&
      typeof state.setWebSocketAutoResponse === 'function' &&
      requestResponsePair
    ) {
      try {
        state.setWebSocketAutoResponse(
          new requestResponsePair(SIGNALING_LIVENESS_PING, SIGNALING_LIVENESS_PONG),
        );
      } catch {
        // Local/test runtimes use the explicit webSocketMessage fallback below.
      }
    }
    this.standardHttpBridgeReady = Promise.resolve();
    this.standardHttpBridgeMeta = null;
    this.standardHttpBridgeSocket = null;
    this.standardHttpBridgeSocketFence = 0;
    this.standardHttpBridgeLastClientDigest = null;
    this.standardHttpBridgeQueue = [];
    this.standardHttpBridgeQueueBytes = 0;
    this.standardHttpBridgeTerminal = null;
    this.standardHttpBridgeWaiter = null;
    this.standardHttpBridgeMutationSync = Promise.resolve();
    this.standardRateOnly = STANDARD_WS_RATE_OBJECT_NAME_RE.test(objectName);
    this.standardRateState = null;
    this.standardRateStateInvalid = false;
    this.standardRateAlarmAt = null;
    this.standardRoomId = null;
    this.standardSocketsValidated = false;
    this.standardPinRetrySockets = new Set();
    this.futureRoomMetaVersion = false;
    this.standardRoomPinMutationFence = null;
    this.standardRoomPinMutationFenceOwner = null;
    this.roomMeta = null;
    this.roomMetaLoad = null;
    this.proRoomMeta = null;
    this.host = null;
    this.hostPeerId = null;
    this.pendingHosts = new Set();
    this.guests = new Map();
    this.pendingGuests = new Set();
    this.proMembers = new Map();
    this.guestBindings = null;
    this.guestBindingsInvalid = false;
    this.guestBindingsFutureVersion = false;
    this.guestBindingsLoad = null;
    this.standardRoomMembers = null;
    this.proTicketUses = null;
    this.proParticipantHighWater = null;
    this.proPresenceAuthority = undefined;
    this.proChatControlState = undefined;
    this.proBotRequestProofs = undefined;
    this.proOwnerAccountDeletionFence = undefined;
    // Standard-room host metadata and guest reconnect bindings describe one
    // room epoch. Serialize their admission/leave mutations together so an
    // awaited host reconnect write cannot be overwritten by a stale host close
    // or an overlapping empty-room cleanup.
    this.standardAdmissionSync = Promise.resolve();
    // Capture authority-bearing Standard-room admissions, identity changes,
    // and PIN mutations in receive order before the asynchronous maintenance
    // gate. They later join the admission queue only for their authoritative
    // read/verify/write section, so ordinary signaling remains independent.
    this.standardOrderedIngressSync = Promise.resolve();
    this.proAdmissionSync = Promise.resolve();
    this.proChatMutationSync = Promise.resolve();
    this.proRealtimeIngressDepth = new WeakMap();
    this.proSystemAudioSignalIngressSync = new WeakMap();
    this.proSystemAudioSignalIngressDepth = new WeakMap();
    this.alarmSync = Promise.resolve();
    this.alarmMaintenanceRetryAttempt = 0;
    this.proSocketsValidated = false;
    if (this.standardHttpBridgeOnly) {
      const loadStandardHttpBridgeMeta = async () => {
        const stored = await this.state.storage.get(STANDARD_HTTP_BRIDGE_META_KEY);
        if (stored === undefined || stored === null) return;
        const normalized = normalizeStandardHttpBridgeMeta(stored);
        if (!normalized || normalized.sessionId !== this.standardHttpBridgeSessionId) {
          await this.state.storage.delete(STANDARD_HTTP_BRIDGE_META_KEY);
          await this.state.storage.deleteAlarm();
          return;
        }
        // Outbound client WebSockets cannot hibernate. Only non-secret cursors
        // survive in storage; a later request must re-authenticate by opening a
        // new bridge rather than replaying either uplink or downlink payloads.
        this.standardHttpBridgeMeta = normalized;
      };
      this.standardHttpBridgeReady =
        typeof state.blockConcurrencyWhile === 'function'
          ? state.blockConcurrencyWhile(loadStandardHttpBridgeMeta)
          : loadStandardHttpBridgeMeta();
      this.standardRateReady = Promise.resolve();
    } else if (this.standardRateOnly) {
      const loadStandardRateState = async () => {
        const [stored, storedAlarmAt] = await Promise.all([
          this.state.storage.get(STANDARD_WS_RATE_STATE_KEY),
          this.state.storage.getAlarm(),
        ]);
        const normalized =
          stored === undefined || stored === null ? null : normalizeStandardWsRateState(stored);
        if (stored !== undefined && stored !== null && !normalized) {
          this.standardRateStateInvalid = true;
        }
        this.standardRateState = normalized;
        this.standardRateAlarmAt = isSafeInteger(storedAlarmAt) ? storedAlarmAt : null;
      };
      this.standardRateReady =
        typeof state.blockConcurrencyWhile === 'function'
          ? state.blockConcurrencyWhile(loadStandardRateState)
          : loadStandardRateState();
    } else {
      this.standardRateReady = Promise.resolve();
      this.rehydrateSockets();
    }
  }

  private enqueueStandardHttpBridgeMutation<T>(callback: () => Promise<T>): Promise<T> {
    const run = this.standardHttpBridgeMutationSync.then(callback, callback);
    this.standardHttpBridgeMutationSync = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private parseStandardHttpBridgeEnvelope(
    value: unknown,
    withRequest: boolean,
  ): {
    sessionId: string;
    generation: string;
    roomId: string;
    role: 'host' | 'guest';
    peerId: string;
    request?: unknown;
  } | null {
    const required = ['v', 'sessionId', 'generation', 'roomId', 'role', 'peerId'];
    if (withRequest) required.push('request');
    if (
      !hasExactKeys(value, required) ||
      value.v !== 1 ||
      typeof value.sessionId !== 'string' ||
      !STANDARD_HTTP_BRIDGE_SESSION_ID_RE.test(value.sessionId) ||
      value.sessionId !== this.standardHttpBridgeSessionId ||
      typeof value.generation !== 'string' ||
      !STANDARD_HTTP_BRIDGE_GENERATION_RE.test(value.generation) ||
      typeof value.roomId !== 'string' ||
      !STANDARD_HTTP_BRIDGE_ROOM_ID_RE.test(value.roomId) ||
      (value.role !== 'host' && value.role !== 'guest') ||
      !isValidPeerId(value.peerId)
    ) {
      return null;
    }
    return {
      sessionId: value.sessionId,
      generation: value.generation,
      roomId: value.roomId,
      role: value.role,
      peerId: value.peerId,
      ...(withRequest ? { request: value.request } : {}),
    };
  }

  private standardHttpBridgeAuthorityMatches(
    envelope: {
      sessionId: string;
      generation: string;
      roomId: string;
      role: 'host' | 'guest';
      peerId: string;
    },
    meta = this.standardHttpBridgeMeta,
  ): boolean {
    return Boolean(
      meta &&
      meta.sessionId === envelope.sessionId &&
      meta.generation === envelope.generation &&
      meta.roomId === envelope.roomId &&
      meta.role === envelope.role &&
      meta.peerId === envelope.peerId,
    );
  }

  private async persistStandardHttpBridgeMeta(): Promise<void> {
    const meta = this.standardHttpBridgeMeta;
    if (!meta) return;
    await this.state.storage.put(STANDARD_HTTP_BRIDGE_META_KEY, meta);
    await this.state.storage.setAlarm(meta.leaseExpiresAt);
  }

  private async refreshStandardHttpBridgeLease(): Promise<void> {
    const meta = this.standardHttpBridgeMeta;
    if (!meta) return;
    meta.leaseExpiresAt = Date.now() + STANDARD_HTTP_BRIDGE_LEASE_MS;
    await this.persistStandardHttpBridgeMeta();
  }

  private resolveStandardHttpBridgeWaiter(outcome: StandardHttpBridgeWaitOutcome): void {
    const waiter = this.standardHttpBridgeWaiter;
    if (!waiter) return;
    this.standardHttpBridgeWaiter = null;
    waiter.resolve(outcome);
  }

  private createStandardHttpBridgeWaiter(
    generation: string,
    requestEpoch: number,
  ): StandardHttpBridgeWaiter {
    let settled = false;
    let settle: (outcome: StandardHttpBridgeWaitOutcome) => void = () => undefined;
    const promise = new Promise<StandardHttpBridgeWaitOutcome>((resolve) => {
      settle = resolve;
    });
    return {
      generation,
      requestEpoch,
      promise,
      resolve(outcome) {
        if (settled) return;
        settled = true;
        settle(outcome);
      },
    };
  }

  private async clearStandardHttpBridgeState(
    code: number,
    reason: string,
    waiterOutcome: StandardHttpBridgeWaitOutcome,
  ): Promise<void> {
    const socket = this.standardHttpBridgeSocket;
    this.standardHttpBridgeSocketFence += 1;
    this.standardHttpBridgeSocket = null;
    this.standardHttpBridgeMeta = null;
    this.standardHttpBridgeLastClientDigest = null;
    this.standardHttpBridgeQueue.length = 0;
    this.standardHttpBridgeQueueBytes = 0;
    this.standardHttpBridgeTerminal = null;
    this.resolveStandardHttpBridgeWaiter(waiterOutcome);
    // Revoke the live authority path before any fallible storage I/O. A slow
    // or unavailable Durable Object storage backend must never leave the
    // actual-room socket able to relay after close, expiry, or re-auth fencing.
    if (socket) {
      try {
        socket.close(code, reason);
      } catch {
        /* already closed */
      }
    }
    await this.state.storage.delete(STANDARD_HTTP_BRIDGE_META_KEY);
    await this.state.storage.deleteAlarm();
  }

  private async requireLiveStandardHttpBridge(
    envelope: {
      sessionId: string;
      generation: string;
      roomId: string;
      role: 'host' | 'guest';
      peerId: string;
    },
    allowTerminal: boolean,
  ): Promise<Response | null> {
    if (!this.standardHttpBridgeMeta) {
      return json({ error: 'STANDARD_HTTP_BRIDGE_REAUTH_REQUIRED' }, 409);
    }
    if (!this.standardHttpBridgeAuthorityMatches(envelope)) {
      return json({ error: 'STANDARD_HTTP_BRIDGE_AUTHORITY_MISMATCH' }, 409);
    }
    if (this.standardHttpBridgeTerminal && allowTerminal) return null;
    if (this.standardHttpBridgeTerminal) {
      return json({ error: 'STANDARD_HTTP_BRIDGE_CLOSED' }, 410);
    }
    if (this.standardHttpBridgeSocket) return null;
    // A persisted cursor without the non-hibernatable outbound socket means
    // the isolate restarted. Never reconstruct or replay sensitive frames.
    await this.clearStandardHttpBridgeState(
      1012,
      'HTTP bridge re-authentication required',
      'aborted',
    );
    return json({ error: 'STANDARD_HTTP_BRIDGE_REAUTH_REQUIRED' }, 409);
  }

  private attachStandardHttpBridgeSocket(socket: OutboundWebSocketPort, fence: number): void {
    const listen = socket.addEventListener.bind(socket);
    listen('message', (event) => {
      this.defer(
        this.enqueueStandardHttpBridgeMutation(() =>
          this.handleStandardHttpBridgeSocketMessage(socket, fence, event),
        ),
        'HTTP bridge outbound message',
      );
    });
    listen('close', (event) => {
      this.defer(
        this.enqueueStandardHttpBridgeMutation(() =>
          this.handleStandardHttpBridgeSocketTerminal(
            socket,
            fence,
            standardHttpBridgeCloseTerminal(event),
            false,
          ),
        ),
        'HTTP bridge outbound close',
      );
    });
    listen('error', () => {
      this.defer(
        this.enqueueStandardHttpBridgeMutation(() =>
          this.handleStandardHttpBridgeSocketTerminal(
            socket,
            fence,
            { code: 1011, reason: 'HTTP bridge outbound socket error' },
            true,
          ),
        ),
        'HTTP bridge outbound error',
      );
    });
  }

  private async handleStandardHttpBridgeSocketMessage(
    socket: OutboundWebSocketPort,
    fence: number,
    event: unknown,
  ): Promise<void> {
    if (
      socket !== this.standardHttpBridgeSocket ||
      fence !== this.standardHttpBridgeSocketFence ||
      !this.standardHttpBridgeMeta ||
      this.standardHttpBridgeTerminal
    ) {
      return;
    }
    const data = standardHttpBridgeMessageData(event);
    const bytes = typeof data === 'string' ? rawMessageByteLength(data) : null;
    if (typeof data !== 'string' || bytes === null || bytes > WS_MESSAGE_MAX_BYTES) {
      await this.handleStandardHttpBridgeSocketTerminal(
        socket,
        fence,
        { code: 1009, reason: 'HTTP bridge received an invalid frame' },
        true,
      );
      return;
    }
    if (
      this.standardHttpBridgeQueue.length >= STANDARD_HTTP_BRIDGE_QUEUE_MAX_MESSAGES ||
      this.standardHttpBridgeQueueBytes + bytes > STANDARD_HTTP_BRIDGE_QUEUE_MAX_BYTES
    ) {
      await this.handleStandardHttpBridgeSocketTerminal(
        socket,
        fence,
        { code: 1013, reason: 'HTTP bridge receive queue overflow' },
        true,
      );
      return;
    }
    const meta = this.standardHttpBridgeMeta;
    meta.lastServerSeq += 1;
    this.standardHttpBridgeQueue.push({ sseq: meta.lastServerSeq, data, bytes });
    this.standardHttpBridgeQueueBytes += bytes;
    await this.persistStandardHttpBridgeMeta();
    this.resolveStandardHttpBridgeWaiter('ready');
  }

  private async handleStandardHttpBridgeSocketTerminal(
    socket: OutboundWebSocketPort,
    fence: number,
    terminal: StandardHttpBridgeTerminal,
    close: boolean,
  ): Promise<void> {
    if (
      socket !== this.standardHttpBridgeSocket ||
      fence !== this.standardHttpBridgeSocketFence ||
      !this.standardHttpBridgeMeta ||
      this.standardHttpBridgeTerminal
    ) {
      return;
    }
    this.standardHttpBridgeSocketFence += 1;
    this.standardHttpBridgeSocket = null;
    this.standardHttpBridgeTerminal = terminal;
    if (close) {
      try {
        socket.close(terminal.code, terminal.reason);
      } catch {
        /* already closed */
      }
    }
    await this.persistStandardHttpBridgeMeta();
    this.resolveStandardHttpBridgeWaiter('ready');
  }

  private standardHttpBridgePollResponse(): Response {
    const events: { sseq: number; data: string }[] = [];
    let responseBytes = 0;
    for (const event of this.standardHttpBridgeQueue) {
      if (events.length >= STANDARD_HTTP_BRIDGE_POLL_MAX_MESSAGES) break;
      const wire = { sseq: event.sseq, data: event.data };
      const encodedBytes = new TextEncoder().encode(JSON.stringify(wire)).byteLength;
      if (encodedBytes > STANDARD_HTTP_BRIDGE_POLL_MAX_BYTES && events.length === 0) {
        const socket = this.standardHttpBridgeSocket;
        const fence = this.standardHttpBridgeSocketFence;
        if (socket) {
          this.defer(
            this.enqueueStandardHttpBridgeMutation(() =>
              this.handleStandardHttpBridgeSocketTerminal(
                socket,
                fence,
                { code: 1009, reason: 'HTTP bridge response frame too large' },
                true,
              ),
            ),
            'HTTP bridge oversized response cleanup',
          );
        }
        return json({
          v: 1,
          events: [],
          terminal: { code: 1009, reason: 'HTTP bridge response frame too large' },
        });
      }
      if (responseBytes + encodedBytes > STANDARD_HTTP_BRIDGE_POLL_MAX_BYTES) break;
      responseBytes += encodedBytes;
      events.push(wire);
    }
    const hasMoreEvents = events.length < this.standardHttpBridgeQueue.length;
    return json({
      v: 1,
      events,
      ...(this.standardHttpBridgeTerminal && !hasMoreEvents
        ? { terminal: this.standardHttpBridgeTerminal }
        : {}),
    });
  }

  private async handleStandardHttpBridgeOpen(value: unknown): Promise<Response> {
    const envelope = this.parseStandardHttpBridgeEnvelope(value, false);
    if (!envelope) return json({ error: 'INVALID_STANDARD_HTTP_BRIDGE_REQUEST' }, 400);
    return this.enqueueStandardHttpBridgeMutation(async () => {
      if (this.standardHttpBridgeMeta) {
        if (!this.standardHttpBridgeAuthorityMatches(envelope)) {
          return json({ error: 'STANDARD_HTTP_BRIDGE_AUTHORITY_MISMATCH' }, 409);
        }
        if (this.standardHttpBridgeTerminal) {
          return json({ error: 'STANDARD_HTTP_BRIDGE_CLOSED' }, 410);
        }
        if (this.standardHttpBridgeSocket) {
          await this.refreshStandardHttpBridgeLease();
          return json({ ok: true });
        }
        // Persisted metadata with no socket is an isolate restart. Open is the
        // only operation allowed to establish a fresh authority path; all
        // cursors reset and the client must send the room auth frame again.
        await this.clearStandardHttpBridgeState(1012, 'HTTP bridge re-open', 'superseded');
      }
      const namespace = this.env.MUSIXQUARE_ROOMS;
      if (!isAddressableDurableObjectNamespace(namespace)) {
        return json({ error: 'STANDARD_HTTP_BRIDGE_UNAVAILABLE' }, 503);
      }
      const room = namespace.get(namespace.idFromName(envelope.roomId));
      const url = new URL(`https://signaling.internal/api/rooms/${envelope.roomId}/ws`);
      url.searchParams.set('role', envelope.role);
      url.searchParams.set('peerId', envelope.peerId);
      let response: Response;
      try {
        response = await room.fetch(
          new Request(url.toString(), {
            headers: { Upgrade: 'websocket' },
          }),
        );
      } catch {
        return json({ error: 'STANDARD_HTTP_BRIDGE_UPSTREAM_UNAVAILABLE' }, 502);
      }
      const socket = (response as Response & { webSocket?: OutboundWebSocketPort | null })
        .webSocket;
      if (
        response.status !== 101 ||
        !socket ||
        typeof socket.accept !== 'function' ||
        typeof socket.send !== 'function' ||
        typeof socket.close !== 'function' ||
        typeof socket.addEventListener !== 'function'
      ) {
        return json({ error: 'STANDARD_HTTP_BRIDGE_UPSTREAM_REJECTED' }, 502);
      }
      const now = Date.now();
      this.standardHttpBridgeMeta = {
        v: 1,
        sessionId: envelope.sessionId,
        generation: envelope.generation,
        roomId: envelope.roomId,
        role: envelope.role,
        peerId: envelope.peerId,
        lastClientSeq: 0,
        lastServerSeq: 0,
        lastServerAck: 0,
        requestEpoch: 0,
        leaseExpiresAt: now + STANDARD_HTTP_BRIDGE_LEASE_MS,
      };
      this.standardHttpBridgeLastClientDigest = null;
      this.standardHttpBridgeQueue.length = 0;
      this.standardHttpBridgeQueueBytes = 0;
      this.standardHttpBridgeTerminal = null;
      this.standardHttpBridgeSocketFence += 1;
      const fence = this.standardHttpBridgeSocketFence;
      this.standardHttpBridgeSocket = socket;
      this.attachStandardHttpBridgeSocket(socket, fence);
      try {
        socket.accept();
        await this.persistStandardHttpBridgeMeta();
      } catch {
        await this.clearStandardHttpBridgeState(
          1011,
          'HTTP bridge initialization failed',
          'aborted',
        );
        return json({ error: 'STANDARD_HTTP_BRIDGE_UPSTREAM_UNAVAILABLE' }, 502);
      }
      return json({ ok: true });
    });
  }

  private async handleStandardHttpBridgeSend(value: unknown): Promise<Response> {
    const envelope = this.parseStandardHttpBridgeEnvelope(value, true);
    if (!envelope || !hasExactKeys(envelope.request, ['v', 'cseq', 'frame'])) {
      return json({ error: 'INVALID_STANDARD_HTTP_BRIDGE_REQUEST' }, 400);
    }
    const request = envelope.request;
    const bytes = typeof request.frame === 'string' ? rawMessageByteLength(request.frame) : null;
    if (
      request.v !== 1 ||
      !isSafeInteger(request.cseq) ||
      request.cseq < 1 ||
      typeof request.frame !== 'string' ||
      bytes === null ||
      bytes > WS_MESSAGE_MAX_BYTES
    ) {
      return json({ error: 'INVALID_STANDARD_HTTP_BRIDGE_REQUEST' }, 400);
    }
    const cseq = request.cseq as number;
    const frame = request.frame as string;
    return this.enqueueStandardHttpBridgeMutation(async () => {
      const unavailable = await this.requireLiveStandardHttpBridge(envelope, false);
      if (unavailable) return unavailable;
      const meta = this.standardHttpBridgeMeta;
      const socket = this.standardHttpBridgeSocket;
      if (!meta || !socket) return json({ error: 'STANDARD_HTTP_BRIDGE_REAUTH_REQUIRED' }, 409);
      const digest = await standardHttpBridgeFrameDigest(frame);
      if (cseq === meta.lastClientSeq) {
        if (!this.standardHttpBridgeLastClientDigest) {
          await this.clearStandardHttpBridgeState(
            1012,
            'HTTP bridge replay state unavailable',
            'aborted',
          );
          return json({ error: 'STANDARD_HTTP_BRIDGE_REAUTH_REQUIRED' }, 409);
        }
        if (digest !== this.standardHttpBridgeLastClientDigest) {
          return json({ error: 'STANDARD_HTTP_BRIDGE_SEQUENCE_REPLAY_MISMATCH' }, 409);
        }
        await this.refreshStandardHttpBridgeLease();
        return json({ v: 1, ack: cseq });
      }
      if (cseq !== meta.lastClientSeq + 1) {
        return json({ error: 'STANDARD_HTTP_BRIDGE_SEQUENCE_GAP' }, 409);
      }
      try {
        socket.send(frame);
      } catch {
        await this.handleStandardHttpBridgeSocketTerminal(
          socket,
          this.standardHttpBridgeSocketFence,
          { code: 1011, reason: 'HTTP bridge outbound send failed' },
          true,
        );
        return json({ error: 'STANDARD_HTTP_BRIDGE_SEND_FAILED' }, 502);
      }
      // Publish the accepted sequence before yielding to persistence so a
      // retry in this isolate cannot duplicate an authority-bearing auth frame.
      meta.lastClientSeq = cseq;
      this.standardHttpBridgeLastClientDigest = digest;
      await this.refreshStandardHttpBridgeLease();
      return json({ v: 1, ack: cseq });
    });
  }

  private async waitForStandardHttpBridgePoll(
    waiter: StandardHttpBridgeWaiter,
    waitMs: number,
    requestSignal: AbortSignal,
  ): Promise<StandardHttpBridgeWaitOutcome> {
    const timeoutSignal = AbortSignal.timeout(waitMs);
    const onTimeout = () => waiter.resolve('timeout');
    const onAbort = () => waiter.resolve('aborted');
    const listenTimeout = timeoutSignal.addEventListener.bind(timeoutSignal);
    const listenAbort = requestSignal.addEventListener.bind(requestSignal);
    listenTimeout('abort', onTimeout, { once: true });
    listenAbort('abort', onAbort, { once: true });
    if (timeoutSignal.aborted) onTimeout();
    if (requestSignal.aborted) onAbort();
    try {
      return await waiter.promise;
    } finally {
      timeoutSignal.removeEventListener('abort', onTimeout);
      requestSignal.removeEventListener('abort', onAbort);
    }
  }

  private async handleStandardHttpBridgePoll(
    value: unknown,
    requestSignal: AbortSignal,
  ): Promise<Response> {
    const envelope = this.parseStandardHttpBridgeEnvelope(value, true);
    if (!envelope || !hasExactKeys(envelope.request, ['v', 'requestEpoch', 'ack', 'waitMs'])) {
      return json({ error: 'INVALID_STANDARD_HTTP_BRIDGE_REQUEST' }, 400);
    }
    const request = envelope.request;
    if (
      request.v !== 1 ||
      !isSafeInteger(request.requestEpoch) ||
      request.requestEpoch < 1 ||
      !isSafeInteger(request.ack) ||
      request.ack < 0 ||
      !isSafeInteger(request.waitMs) ||
      request.waitMs < 0 ||
      request.waitMs > STANDARD_HTTP_BRIDGE_MAX_WAIT_MS
    ) {
      return json({ error: 'INVALID_STANDARD_HTTP_BRIDGE_REQUEST' }, 400);
    }
    const requestEpoch = request.requestEpoch as number;
    const ack = request.ack as number;
    const waitMs = request.waitMs as number;
    const prepared = await this.enqueueStandardHttpBridgeMutation(async () => {
      const unavailable = await this.requireLiveStandardHttpBridge(envelope, true);
      if (unavailable) return { response: unavailable, waiter: null };
      const meta = this.standardHttpBridgeMeta;
      if (!meta) {
        return {
          response: json({ error: 'STANDARD_HTTP_BRIDGE_REAUTH_REQUIRED' }, 409),
          waiter: null,
        };
      }
      if (ack > meta.lastServerSeq) {
        return {
          response: json({ error: 'STANDARD_HTTP_BRIDGE_ACK_AHEAD' }, 409),
          waiter: null,
        };
      }
      if (requestEpoch < meta.requestEpoch) {
        return {
          response: json({ error: 'STANDARD_HTTP_BRIDGE_REQUEST_EPOCH_STALE' }, 409),
          waiter: null,
        };
      }
      if (requestEpoch >= meta.requestEpoch && this.standardHttpBridgeWaiter) {
        this.resolveStandardHttpBridgeWaiter('superseded');
      }
      meta.requestEpoch = requestEpoch;
      meta.lastServerAck = Math.max(meta.lastServerAck, ack);
      while (
        this.standardHttpBridgeQueue.length > 0 &&
        (this.standardHttpBridgeQueue[0]?.sseq || 0) <= meta.lastServerAck
      ) {
        const acknowledged = this.standardHttpBridgeQueue.shift();
        if (acknowledged) this.standardHttpBridgeQueueBytes -= acknowledged.bytes;
      }
      await this.refreshStandardHttpBridgeLease();
      if (
        this.standardHttpBridgeQueue.length > 0 ||
        this.standardHttpBridgeTerminal ||
        waitMs === 0 ||
        requestSignal.aborted
      ) {
        return { response: this.standardHttpBridgePollResponse(), waiter: null };
      }
      const waiter = this.createStandardHttpBridgeWaiter(envelope.generation, requestEpoch);
      this.standardHttpBridgeWaiter = waiter;
      return { response: null, waiter };
    });
    if (prepared.response) return prepared.response;
    const waiter = prepared.waiter;
    if (!waiter) return json({ error: 'STANDARD_HTTP_BRIDGE_UNAVAILABLE' }, 503);
    const outcome = await this.waitForStandardHttpBridgePoll(waiter, waitMs, requestSignal);
    return this.enqueueStandardHttpBridgeMutation(async () => {
      if (this.standardHttpBridgeWaiter === waiter) this.standardHttpBridgeWaiter = null;
      if (outcome === 'superseded') {
        return json({ error: 'STANDARD_HTTP_BRIDGE_POLL_SUPERSEDED' }, 409);
      }
      if (outcome === 'aborted') {
        return json({ error: 'STANDARD_HTTP_BRIDGE_POLL_ABORTED' }, 499);
      }
      if (
        !this.standardHttpBridgeMeta ||
        this.standardHttpBridgeMeta.generation !== waiter.generation
      ) {
        return json({ error: 'STANDARD_HTTP_BRIDGE_REAUTH_REQUIRED' }, 409);
      }
      if (this.standardHttpBridgeMeta.requestEpoch > waiter.requestEpoch) {
        return json({ error: 'STANDARD_HTTP_BRIDGE_POLL_SUPERSEDED' }, 409);
      }
      return this.standardHttpBridgePollResponse();
    });
  }

  private async handleStandardHttpBridgeClose(value: unknown): Promise<Response> {
    const envelope = this.parseStandardHttpBridgeEnvelope(value, false);
    if (!envelope) return json({ error: 'INVALID_STANDARD_HTTP_BRIDGE_REQUEST' }, 400);
    return this.enqueueStandardHttpBridgeMutation(async () => {
      if (this.standardHttpBridgeMeta && !this.standardHttpBridgeAuthorityMatches(envelope)) {
        return json({ error: 'STANDARD_HTTP_BRIDGE_AUTHORITY_MISMATCH' }, 409);
      }
      await this.clearStandardHttpBridgeState(1000, 'HTTP bridge closed', 'aborted');
      return json({ ok: true });
    });
  }

  private async handleStandardHttpBridgeFetch(request: Request, url: URL): Promise<Response> {
    await this.standardHttpBridgeReady;
    if (
      request.method !== 'POST' ||
      url.search ||
      url.hash ||
      request.headers.get(STANDARD_HTTP_BRIDGE_HEADER) !== STANDARD_HTTP_BRIDGE_HEADER_VALUE
    ) {
      return json({ error: 'NOT_FOUND' }, 404);
    }
    if (
      url.pathname !== STANDARD_HTTP_BRIDGE_OPEN_PATH &&
      url.pathname !== STANDARD_HTTP_BRIDGE_SEND_PATH &&
      url.pathname !== STANDARD_HTTP_BRIDGE_POLL_PATH &&
      url.pathname !== STANDARD_HTTP_BRIDGE_CLOSE_PATH
    ) {
      return json({ error: 'NOT_FOUND' }, 404);
    }
    const value = await readBoundedJson(request, STANDARD_HTTP_BRIDGE_BODY_MAX_BYTES);
    if (value === null) return json({ error: 'INVALID_STANDARD_HTTP_BRIDGE_REQUEST' }, 400);
    if (url.pathname === STANDARD_HTTP_BRIDGE_OPEN_PATH) {
      return this.handleStandardHttpBridgeOpen(value);
    }
    if (url.pathname === STANDARD_HTTP_BRIDGE_SEND_PATH) {
      return this.handleStandardHttpBridgeSend(value);
    }
    if (url.pathname === STANDARD_HTTP_BRIDGE_POLL_PATH) {
      return this.handleStandardHttpBridgePoll(value, request.signal);
    }
    return this.handleStandardHttpBridgeClose(value);
  }

  private async cleanupStandardHttpBridgeLease(): Promise<void> {
    await this.standardHttpBridgeReady;
    await this.enqueueStandardHttpBridgeMutation(async () => {
      const meta = this.standardHttpBridgeMeta;
      if (!meta) {
        await this.state.storage.delete(STANDARD_HTTP_BRIDGE_META_KEY);
        await this.state.storage.deleteAlarm();
        return;
      }
      if (meta.leaseExpiresAt > Date.now()) {
        await this.state.storage.setAlarm(meta.leaseExpiresAt);
        return;
      }
      await this.clearStandardHttpBridgeState(1001, 'HTTP bridge lease expired', 'aborted');
    });
  }

  private defer(task: Promise<unknown>, operation: string): void {
    const handled = task.catch((error) => {
      console.warn(`[Room] Background ${operation} failed`, error);
    });
    try {
      if (typeof this.state.waitUntil === 'function') {
        this.state.waitUntil(handled);
        return;
      }
    } catch (error) {
      // The handled task is already running. Keep the local/test fallback
      // rejection-safe even when waitUntil registration itself is unavailable.
      console.warn(`[Room] Failed to register background ${operation}`, error);
    }
  }

  private recordMetric(event: string, now = Date.now()): void {
    this.defer(recordMetric(this.env, event, now), `metric ${event}`);
  }

  private admittedGuestIds(): Set<string> {
    // Pending sockets are handshake attempts, not connected devices. Counting
    // them here lets silent unauthenticated clients consume all 99 legitimate
    // guest slots for the full authentication timeout.
    return new Set(this.guests.keys());
  }

  private rememberStandardRoomId(roomId: string): boolean {
    if (!/^\d{6}$/.test(roomId)) return false;
    if (this.standardRoomId === null) {
      this.standardRoomId = roomId;
      return true;
    }
    return this.standardRoomId === roomId;
  }

  private consumeGuestMessageToken(ws: SocketPort, now = Date.now()): boolean {
    const attachment = readAttachment(ws);
    if (!attachment || attachment.role !== 'guest') return false;
    const previousTokens = isFiniteNumber(attachment.guestMessageTokens)
      ? attachment.guestMessageTokens
      : GUEST_MESSAGE_BUCKET_CAPACITY;
    const previousUpdatedAt = isFiniteNumber(attachment.guestMessageUpdatedAt)
      ? attachment.guestMessageUpdatedAt
      : now;
    const elapsed = Math.max(0, now - previousUpdatedAt);
    const tokens = Math.min(
      GUEST_MESSAGE_BUCKET_CAPACITY,
      previousTokens + elapsed * GUEST_MESSAGE_REFILL_PER_MS,
    );
    const remainingTokens = tokens < 1 ? tokens : tokens - 1;
    // WebSocket attachments survive Durable Object hibernation, unlike an
    // in-memory Map/WeakMap. Persisting this tiny bucket state on each frame
    // keeps one active guest from receiving a fresh burst after rehydration.
    // A genuinely new connection still starts a new burst; reconnect churn is
    // separately bounded by the outer per-IP `ws-open` limiter.
    serializeSocketAttachment(ws, {
      ...attachment,
      guestMessageTokens: remainingTokens,
      guestMessageUpdatedAt: now,
    });
    if (tokens < 1) {
      return false;
    }
    return true;
  }

  private consumeRemoteShareUploadAssertionToken(ws: SocketPort, now = Date.now()): boolean {
    const attachment = readAttachment(ws);
    if (!attachment || attachment.role !== 'host' || attachment.auth !== 'ok') return false;
    const previousTokens = isFiniteNumber(attachment.remoteShareUploadAssertionTokens)
      ? attachment.remoteShareUploadAssertionTokens
      : REMOTE_SHARE_UPLOAD_ASSERTION_BUCKET_CAPACITY;
    const previousUpdatedAt = isFiniteNumber(attachment.remoteShareUploadAssertionUpdatedAt)
      ? attachment.remoteShareUploadAssertionUpdatedAt
      : now;
    const elapsed = Math.max(0, now - previousUpdatedAt);
    const tokens = Math.min(
      REMOTE_SHARE_UPLOAD_ASSERTION_BUCKET_CAPACITY,
      previousTokens + elapsed * REMOTE_SHARE_UPLOAD_ASSERTION_REFILL_PER_MS,
    );
    serializeSocketAttachment(ws, {
      ...attachment,
      remoteShareUploadAssertionTokens: tokens < 1 ? tokens : tokens - 1,
      remoteShareUploadAssertionUpdatedAt: now,
    });
    return tokens >= 1;
  }

  private consumeProRealtimeMessageToken(ws: SocketPort, now = Date.now()): boolean {
    const attachment = readAttachment(ws);
    if (!attachment || attachment.roomKind !== 'pro' || attachment.role !== 'member') return false;
    const previousTokens = isFiniteNumber(attachment.realtimeMessageTokens)
      ? attachment.realtimeMessageTokens
      : GUEST_MESSAGE_BUCKET_CAPACITY;
    const previousUpdatedAt = isFiniteNumber(attachment.realtimeMessageUpdatedAt)
      ? attachment.realtimeMessageUpdatedAt
      : now;
    const elapsed = Math.max(0, now - previousUpdatedAt);
    const tokens = Math.min(
      GUEST_MESSAGE_BUCKET_CAPACITY,
      previousTokens + elapsed * GUEST_MESSAGE_REFILL_PER_MS,
    );
    serializeSocketAttachment(ws, {
      ...attachment,
      realtimeMessageTokens: tokens < 1 ? tokens : tokens - 1,
      realtimeMessageUpdatedAt: now,
    });
    return tokens >= 1;
  }

  private async hasProRealtimePermission(
    attachment: ProSocketAttachment,
    permission: string,
    details: JsonRecord = {},
  ): Promise<boolean> {
    const namespace = this.env.PRO_ROOM_AUTHORITY_ROOMS;
    if (!isAddressableDurableObjectNamespace(namespace)) {
      this.recordMetric('pro_realtime_authority_unavailable');
      return false;
    }

    let authorityRequest: Request | undefined;
    let authoritySignal: AbortSignal | undefined;
    try {
      const room = namespace.get(
        namespace.idFromName(proRoomObjectName(attachment.roomId, attachment.roomGeneration)),
      );
      if (!isFetcher(room)) {
        this.recordMetric('pro_realtime_authority_unavailable');
        return false;
      }
      if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
        this.recordMetric('pro_realtime_authority_unavailable');
        return false;
      }
      authoritySignal = AbortSignal.timeout(PRO_AUTHORITY_CHECK_TIMEOUT_MS);
      authorityRequest = new Request('https://pro-room.internal/internal/authority/check', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': attachment.roomId,
          ...proRoomGenerationWireHeaders(attachment.roomGeneration),
        },
        body: JSON.stringify({
          ...proRoomGenerationWireFields(attachment.roomGeneration),
          participantId: attachment.participantId,
          presenceIncarnationId: attachment.presenceIncarnationId,
          permission,
          ...details,
        }),
        signal: authoritySignal,
      });
      const result = await fetchBoundedJsonWithSignal(
        (boundedRequest) => room.fetch(boundedRequest),
        authorityRequest,
        authoritySignal,
        PRO_AUTHORITY_RESPONSE_MAX_BYTES,
      );
      if (!result) {
        this.recordMetric(
          authoritySignal.aborted
            ? 'pro_realtime_authority_timeout'
            : 'pro_realtime_authority_failed',
        );
        return false;
      }
      const { response, value: payload } = result;
      if (response.status !== 200) {
        this.recordMetric('pro_realtime_authority_denied');
        return false;
      }
      if (!payload) {
        this.recordMetric('pro_realtime_authority_invalid_response');
        return false;
      }
      const allowed =
        isRecord(payload) &&
        payload.allowed === true &&
        payload.roomCode === attachment.roomId &&
        responseRoomGenerationMatches(payload, attachment.roomGeneration) &&
        payload.permission === permission &&
        typeof payload.memberId === 'string' &&
        typeof payload.role === 'string' &&
        (permission !== 'system-audio.signal' ||
          (payload.targetParticipantId === details.targetParticipantId &&
            payload.targetPresenceIncarnationId === details.targetPresenceIncarnationId &&
            payload.direction === details.direction &&
            payload.generation === details.generation &&
            payload.publicationId === details.publicationId &&
            payload.negotiationId === details.negotiationId));
      if (!allowed) this.recordMetric('pro_realtime_authority_invalid_response');
      return allowed;
    } catch {
      this.recordMetric(
        authoritySignal?.aborted
          ? 'pro_realtime_authority_timeout'
          : 'pro_realtime_authority_failed',
      );
      return false;
    }
  }

  private rehydrateSockets(): void {
    const sockets =
      typeof this.state.getWebSockets === 'function' ? this.state.getWebSockets() : [];
    const expiredIdentitySockets: SocketPort[] = [];
    for (const ws of sockets) {
      if (this.indexSocket(ws)) expiredIdentitySockets.push(ws);
    }
    // Index every socket before broadcasting expiry so a guest rehydrated
    // ahead of the host cannot lose the authoritative anonymous projection.
    for (const ws of expiredIdentitySockets) {
      const attachment = readAttachment(ws);
      if (attachment?.roomKind !== 'pro' && attachment?.auth === 'ok') {
        this.notifyStandardRoomIdentity(ws, attachment, 'expired');
      }
    }
    if (sockets.length > 0) {
      // A prior alarm write and its immediate durable retry can both fail
      // before the isolate hibernates. Recompute from attachments and durable
      // metadata on every wake so that failure cannot extend an identity
      // lease or retain a silent pending-auth slot indefinitely.
      this.requestMaintenanceAlarm();
    }
  }

  private indexSocket(ws: SocketPort): boolean {
    const serialized = deserializeAttachment(ws);
    let attachment = normalizeAttachment(serialized);
    if (!attachment) {
      if (isRecord(serialized) && serialized.roomKind === 'pro') {
        closeSocket(ws, 1012, 'PRO_ROOM_PROTOCOL_UPGRADED');
      }
      return false;
    }
    if (attachment.roomKind !== 'pro' && !this.rememberStandardRoomId(attachment.roomId)) {
      closeSocket(ws, 1012, 'STANDARD_ROOM_ID_MISMATCH');
      return false;
    }
    let identityExpired = false;
    if (
      attachment.roomKind !== 'pro' &&
      attachment.auth === 'ok' &&
      isSafeInteger(attachment.identityExpiresAt) &&
      Date.now() >= attachment.identityExpiresAt
    ) {
      attachment = withoutStandardRoomIdentity(attachment);
      serializeSocketAttachment(ws, attachment);
      identityExpired = true;
    }
    if (attachment.roomKind === 'pro') {
      const previous = this.proMembers.get(attachment.participantId);
      const previousAttachment = readAttachment(previous);
      const previousProAttachment =
        previousAttachment?.roomKind === 'pro' ? previousAttachment : null;
      if (previous && previous !== ws) {
        if (
          previousProAttachment?.roomGeneration !== attachment.roomGeneration ||
          (previousProAttachment?.ticketSequence || 0) >= attachment.ticketSequence
        ) {
          closeSocket(ws, 1012, 'PRO_MEMBER_REPLACED');
          return false;
        }
        closeSocket(previous, 1012, 'PRO_MEMBER_REPLACED');
      }
      if (!previous && this.proMembers.size >= MAX_PRO_ROOM_MEMBERS) {
        closeWithError(ws, 'room-full', 'ROOM_MEMBER_LIMIT_REACHED', 1008);
        return false;
      }
      this.proMembers.set(attachment.participantId, ws);
      return false;
    }
    if (attachment.role === 'host') {
      if (attachment.auth === 'pending') {
        if (attachment.authStarted) {
          // No authentication task survives an isolate restart. A persisted
          // in-flight marker would otherwise make every replay a no-op until
          // the timeout alarm fires, and a host claim that already committed
          // metadata could leave the prior host indexed in the meantime.
          closeSocket(ws, 1012, 'HOST_AUTH_RETRY_REQUIRED');
          return false;
        }
        if (this.pendingHosts.size >= MAX_PENDING_HOST_SOCKETS) {
          closeWithError(ws, 'room-full', 'HOST_PENDING_LIMIT_REACHED', 1008);
          return false;
        }
        if (Date.now() > attachment.authDeadline) {
          closeSocket(ws, 1011, 'host auth timeout (hibernation)');
          return false;
        }
        this.pendingHosts.add(ws);
        return false;
      }
      if (attachment.pinConfigurationPending) {
        // Every client confirms its current desired PIN in the first frame
        // after peer-open. If the isolate hibernated before that frame, or
        // crashed after the metadata write but before the attachment clear,
        // the only safe convergence is to reconnect and replay the handshake.
        // Never infer success from the room metadata: a blank desired PIN and
        // a pre-existing blank room are intentionally indistinguishable.
        this.standardPinRetrySockets.add(ws);
        closeSocket(ws, 1012, 'ROOM_PASSWORD_CONFIGURATION_RETRY_REQUIRED');
        return false;
      }
      this.host = ws;
      this.hostPeerId = attachment.peerId;
      return identityExpired;
    }
    const admitted = this.admittedGuestIds();
    if (!admitted.has(attachment.peerId) && admitted.size >= MAX_ROOM_GUESTS) {
      closeWithError(ws, 'room-full', 'ROOM_GUEST_LIMIT_REACHED', 1008);
      return false;
    }
    if (attachment.auth === 'ok') {
      this.guests.set(attachment.peerId, ws);
      return identityExpired;
    }
    if (attachment.auth === 'pending') {
      if (attachment.authStarted) {
        // As with host authentication, the receive-order claim belongs to the
        // previous isolate. Reconnect immediately instead of retaining an
        // orphaned pending socket that can no longer complete its first frame.
        closeSocket(ws, 1012, 'GUEST_AUTH_RETRY_REQUIRED');
        return false;
      }
      if (this.pendingGuests.size >= MAX_PENDING_GUEST_SOCKETS) {
        closeWithError(ws, 'room-full', 'ROOM_PENDING_LIMIT_REACHED', 1008);
        this.recordMetric('guest_pending_capacity');
        return false;
      }
      // If the DO slept past the pending guest's authDeadline, don't leak
      // the slot ??close immediately on hibernation wake so a real guest
      // can take its place.
      if (typeof attachment.authDeadline === 'number' && Date.now() > attachment.authDeadline) {
        try {
          ws.close(1011, 'auth timeout (hibernation)');
        } catch {
          /* ignore */
        }
        return false;
      }
      this.pendingGuests.add(ws);
    }
    return false;
  }

  private async loadProRoomMeta(): Promise<ProRoomMeta | null> {
    if (!this.proRoomMeta) {
      const stored = await this.state.storage.get(PRO_ROOM_META_KEY);
      this.proRoomMeta = normalizeProRoomMeta(stored);
    }
    return this.proRoomMeta;
  }

  private async loadProOwnerAccountDeletionFence(): Promise<ProOwnerAccountDeletionFence | null> {
    if (this.proOwnerAccountDeletionFence !== undefined) {
      return this.proOwnerAccountDeletionFence;
    }
    const stored = await this.state.storage.get(PRO_OWNER_ACCOUNT_DELETION_FENCE_KEY);
    if (stored === undefined || stored === null) {
      this.proOwnerAccountDeletionFence = null;
      return null;
    }
    const normalized = normalizeProOwnerAccountDeletionFence(stored);
    if (!normalized) throw new Error('INVALID_PRO_OWNER_ACCOUNT_DELETION_FENCE');
    this.proOwnerAccountDeletionFence = normalized;
    return normalized;
  }

  private async loadProChatControlState(
    roomId: string,
    coordinatorEpoch: number,
  ): Promise<ProChatControlState> {
    const roomGeneration = this.proRoomMeta?.roomGeneration;
    if (!isProRoomGeneration(roomGeneration)) throw new Error('INVALID_PRO_ROOM_META');
    const cached = this.proChatControlState;
    if (cached !== undefined) {
      if (
        cached?.roomId === roomId &&
        cached.roomGeneration === roomGeneration &&
        cached.coordinatorEpoch === coordinatorEpoch
      )
        return cached;
      const initial = defaultProChatControlState(roomId, roomGeneration, coordinatorEpoch);
      this.proChatControlState = initial;
      return initial;
    }
    const stored = await this.state.storage.get(PRO_CHAT_CONTROL_STATE_KEY);
    if (stored === undefined || stored === null) {
      const initial = defaultProChatControlState(roomId, roomGeneration, coordinatorEpoch);
      this.proChatControlState = initial;
      return initial;
    }
    const normalized = normalizeProChatControlState(stored);
    if (!normalized) throw new Error('INVALID_PRO_CHAT_CONTROL_STATE');
    if (
      normalized.roomId !== roomId ||
      normalized.roomGeneration !== roomGeneration ||
      normalized.coordinatorEpoch !== coordinatorEpoch
    ) {
      const initial = defaultProChatControlState(roomId, roomGeneration, coordinatorEpoch);
      this.proChatControlState = initial;
      return initial;
    }
    this.proChatControlState = normalized;
    return normalized;
  }

  private async saveProChatControlState(state: unknown): Promise<ProChatControlState> {
    const normalized = normalizeProChatControlState(state);
    if (!normalized) throw new Error('INVALID_PRO_CHAT_CONTROL_STATE');
    await this.state.storage.put(PRO_CHAT_CONTROL_STATE_KEY, normalized);
    this.proChatControlState = normalized;
    return normalized;
  }

  private async loadProBotRequestProofs(
    roomId: string,
    coordinatorEpoch: number,
  ): Promise<ProBotRequestProofs> {
    const roomGeneration = this.proRoomMeta?.roomGeneration;
    if (!isProRoomGeneration(roomGeneration)) throw new Error('INVALID_PRO_ROOM_META');
    const cached = this.proBotRequestProofs;
    if (cached !== undefined) {
      if (
        cached?.roomId === roomId &&
        cached.roomGeneration === roomGeneration &&
        cached.coordinatorEpoch === coordinatorEpoch
      )
        return cached;
      const initial = defaultProBotRequestProofs(roomId, roomGeneration, coordinatorEpoch);
      this.proBotRequestProofs = initial;
      return initial;
    }
    const stored = await this.state.storage.get(PRO_BOT_REQUEST_PROOFS_KEY);
    if (stored === undefined || stored === null) {
      const initial = defaultProBotRequestProofs(roomId, roomGeneration, coordinatorEpoch);
      this.proBotRequestProofs = initial;
      return initial;
    }
    const normalized = normalizeProBotRequestProofs(stored);
    if (!normalized) throw new Error('INVALID_PRO_BOT_REQUEST_PROOFS');
    if (
      normalized.roomId !== roomId ||
      normalized.roomGeneration !== roomGeneration ||
      normalized.coordinatorEpoch !== coordinatorEpoch
    ) {
      const initial = defaultProBotRequestProofs(roomId, roomGeneration, coordinatorEpoch);
      this.proBotRequestProofs = initial;
      return initial;
    }
    this.proBotRequestProofs = normalized;
    return normalized;
  }

  private async saveProBotRequestProofs(state: unknown): Promise<ProBotRequestProofs> {
    const normalized = normalizeProBotRequestProofs(state);
    if (!normalized) throw new Error('INVALID_PRO_BOT_REQUEST_PROOFS');
    await this.state.storage.put(PRO_BOT_REQUEST_PROOFS_KEY, normalized);
    this.proBotRequestProofs = normalized;
    return normalized;
  }

  private pruneProBotRequestProofs(
    state: ProBotRequestProofs,
    nowMs = Date.now(),
  ): ProBotRequestProofs {
    const entries = state.entries.filter((entry) => entry.expiresAtMs > nowMs);
    return entries.length === state.entries.length ? state : { ...state, entries };
  }

  private async rememberProBotRequest(
    roomId: string,
    coordinatorEpoch: number,
    participantId: string,
    requestId: string,
  ): Promise<boolean> {
    const nowMs = Date.now();
    const loaded = await this.loadProBotRequestProofs(roomId, coordinatorEpoch);
    const current = this.pruneProBotRequestProofs(loaded, nowMs);
    if (current.entries.some((entry) => entry.requestId === requestId)) {
      if (current !== loaded) await this.saveProBotRequestProofs(current);
      return false;
    }
    if (current.entries.length >= PRO_BOT_REQUEST_PROOF_MAX_ITEMS) {
      if (current !== loaded) await this.saveProBotRequestProofs(current);
      return false;
    }
    await this.saveProBotRequestProofs({
      ...current,
      entries: [
        ...current.entries,
        {
          requestId,
          participantId,
          status: 'pending',
          expiresAtMs: nowMs + PRO_BOT_REQUEST_PROOF_TTL_MS,
        },
      ],
    });
    this.requestMaintenanceAlarm();
    return true;
  }

  async consumeProBotRequest(
    roomId: string,
    coordinatorEpoch: number,
    participantId: string,
    requestId: string,
    allowUnobservedSuccess: boolean,
  ): Promise<boolean> {
    const nowMs = Date.now();
    const loaded = await this.loadProBotRequestProofs(roomId, coordinatorEpoch);
    const current = this.pruneProBotRequestProofs(loaded, nowMs);
    const index = current.entries.findIndex((entry) => entry.requestId === requestId);
    if (index >= 0) {
      const proof = current.entries[index];
      if (!proof) return false;
      if (proof.participantId !== participantId || proof.status !== 'pending') {
        if (current !== loaded) await this.saveProBotRequestProofs(current);
        return false;
      }
      const entries = [...current.entries];
      entries[index] = {
        ...proof,
        status: 'consumed',
        expiresAtMs: nowMs + PRO_BOT_REQUEST_PROOF_TTL_MS,
      };
      await this.saveProBotRequestProofs({ ...current, entries });
      this.requestMaintenanceAlarm();
      return true;
    }
    if (!allowUnobservedSuccess || current.entries.length >= PRO_BOT_REQUEST_PROOF_MAX_ITEMS) {
      if (current !== loaded) await this.saveProBotRequestProofs(current);
      return false;
    }

    // During a rolling deploy, the request message can have crossed an older
    // signaling Worker that did not retain proofs. An exact successful PRO
    // Worker execution receipt remains sufficient, but record a consumed
    // tombstone now so the same terminal frame cannot be replayed.
    await this.saveProBotRequestProofs({
      ...current,
      entries: [
        ...current.entries,
        {
          requestId,
          participantId,
          status: 'consumed',
          expiresAtMs: nowMs + PRO_BOT_REQUEST_PROOF_TTL_MS,
        },
      ],
    });
    this.requestMaintenanceAlarm();
    return true;
  }

  private async pruneExpiredProBotRequests(
    roomId: string,
    coordinatorEpoch: number,
    nowMs = Date.now(),
  ): Promise<ProBotRequestProofs> {
    const loaded = await this.loadProBotRequestProofs(roomId, coordinatorEpoch);
    const current = this.pruneProBotRequestProofs(loaded, nowMs);
    if (current !== loaded) await this.saveProBotRequestProofs(current);
    return current;
  }

  async pruneProChatMutedParticipants(
    roomId: string,
    roomGeneration: number,
    coordinatorEpoch: number,
    activeIncarnationIds: string[],
  ): Promise<ProChatControlState> {
    return this.enqueueProChatMutation(async () => {
      const state = await this.loadProChatControlState(roomId, coordinatorEpoch);
      if (state.mutedParticipantIds.length === 0) return state;

      // Presence snapshots identify live incarnations, while mute authority is
      // intentionally participant-scoped so a socket reconnect does not clear
      // it. The persisted ticket high-water fence is the canonical bridge
      // between those identities, including participants that are temporarily
      // disconnected when the snapshot arrives.
      const activeIncarnations = new Set(activeIncarnationIds);
      const highWater = await this.loadProParticipantHighWater(roomGeneration);
      const activeParticipantIds = new Set(
        highWater.entries
          .filter((entry) => activeIncarnations.has(entry.presenceIncarnationId))
          .map((entry) => entry.participantId),
      );
      const mutedParticipantIds = state.mutedParticipantIds.filter((participantId) =>
        activeParticipantIds.has(participantId),
      );
      if (mutedParticipantIds.length === state.mutedParticipantIds.length) return state;
      return this.saveProChatControlState({
        ...state,
        revision: state.revision + 1,
        mutedParticipantIds,
      });
    });
  }

  private enqueueProChatMutation<T>(task: (value?: unknown) => Promise<T>): Promise<T> {
    const run = this.proChatMutationSync.then(task, task);
    this.proChatMutationSync = run.catch(() => {});
    return run;
  }

  private currentProRealtimeAttachment(
    ws: SocketPort,
    expected: ProSocketAttachment,
  ): ProSocketAttachment | null {
    const current = readAttachment(ws);
    if (
      current?.roomKind !== 'pro' ||
      current.role !== 'member' ||
      current.auth !== 'ok' ||
      current.roomId !== expected.roomId ||
      current.roomGeneration !== expected.roomGeneration ||
      current.coordinatorEpoch !== expected.coordinatorEpoch ||
      current.participantId !== expected.participantId ||
      current.presenceIncarnationId !== expected.presenceIncarnationId ||
      this.proMembers.get(expected.participantId) !== ws
    ) {
      return null;
    }
    return current;
  }

  private proRealtimeRelay(
    normalized: NormalizedProRealtimeFrame,
    attachment: ProSocketAttachment,
  ): JsonRecord {
    return {
      ...normalized,
      roomCode: attachment.roomId,
      roomGeneration: attachment.roomGeneration,
      coordinatorEpoch: attachment.coordinatorEpoch,
      sender: {
        participantId: attachment.participantId,
        presenceIncarnationId: attachment.presenceIncarnationId,
        ...(attachment.memberId ? { memberId: attachment.memberId } : {}),
        displayName: attachment.displayName,
      },
    };
  }

  private broadcastProRealtimeRelay(
    ws: SocketPort,
    attachment: ProSocketAttachment,
    normalized: NormalizedProRealtimeFrame,
    targetSocket: SocketPort | null = null,
  ): void {
    const relay = this.proRealtimeRelay(normalized, attachment);
    if (normalized.channel === 'chat' && normalized.payload.kind === 'whisper') {
      if (targetSocket) sendChecked(targetSocket, relay);
      return;
    }
    for (const [participantId, socket] of this.proMembers) {
      if (socket === ws) continue;
      const recipient = readAttachment(socket);
      if (
        recipient?.roomKind !== 'pro' ||
        recipient.auth !== 'ok' ||
        recipient.roomId !== attachment.roomId ||
        recipient.roomGeneration !== attachment.roomGeneration ||
        recipient.coordinatorEpoch !== attachment.coordinatorEpoch ||
        recipient.participantId !== participantId ||
        this.proMembers.get(participantId) !== socket
      ) {
        continue;
      }
      sendChecked(socket, relay);
    }
  }

  private sendProChatControlSnapshot(
    ws: SocketPort,
    attachment: ProSocketAttachment,
    state: ProChatControlState,
  ): void {
    // A dedicated server-only channel is ignored by rolling-deploy clients,
    // while current clients atomically replace all local control state. This
    // avoids replaying historical moderation commands as four new messages.
    sendChecked(ws, {
      type: 'pro-realtime',
      version: 1,
      eventId: crypto.randomUUID(),
      channel: 'chat-control-snapshot',
      payload: {
        revision: state.revision,
        frozen: state.frozen,
        filterEnabled: state.filterEnabled,
        slowmodeSeconds: state.slowmodeSeconds,
        muted: state.mutedParticipantIds.includes(attachment.participantId),
      },
      roomCode: attachment.roomId,
      roomGeneration: attachment.roomGeneration,
      coordinatorEpoch: attachment.coordinatorEpoch,
      sender: {
        participantId: 'server',
        presenceIncarnationId: 'server-chat-state',
        displayName: 'MUSIXQUARE',
      },
    });
  }

  private async loadProTicketUses(roomGeneration: unknown): Promise<ProTicketUses> {
    if (!isProRoomGeneration(roomGeneration)) {
      throw new Error('INVALID_PRO_ROOM_GENERATION');
    }
    if (this.proTicketUses) {
      if (this.proTicketUses.roomGeneration !== roomGeneration) {
        throw new Error('PRO_SIGNALING_TICKET_LEDGER_GENERATION_MISMATCH');
      }
      return this.proTicketUses;
    }
    const stored = await this.state.storage.get(PRO_TICKET_USES_KEY);
    if (stored !== undefined && stored !== null) {
      const normalized = normalizeProTicketUses(stored);
      if (!normalized) throw new Error('INVALID_PRO_SIGNALING_TICKET_LEDGER');
      if (normalized.roomGeneration !== roomGeneration) {
        throw new Error('PRO_SIGNALING_TICKET_LEDGER_GENERATION_MISMATCH');
      }
      this.proTicketUses = normalized;
      return normalized;
    }

    const seeded = defaultProTicketUses(roomGeneration);
    this.proTicketUses = seeded;
    return seeded;
  }

  private async consumeProTicket(
    ticket: ProSignalingTicket,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<boolean> {
    const current = await this.loadProTicketUses(ticket.roomGeneration);
    const entries = current.entries.filter((entry) => entry.exp > nowSeconds);
    if (entries.some((entry) => entry.jti === ticket.jti)) return false;
    if (entries.length >= MAX_PRO_TICKET_USES) {
      throw new Error('PRO_SIGNALING_TICKET_LEDGER_FULL');
    }
    const next: ProTicketUses = {
      v: 1,
      roomGeneration: ticket.roomGeneration,
      entries: [...entries, { jti: ticket.jti, exp: ticket.exp }],
    };
    // Persist before replacing any live socket. A failed write therefore fails
    // closed instead of admitting a replayable credential.
    await this.state.storage.put(
      PRO_TICKET_USES_KEY,
      persistedProGenerationRecord(next, ticket.roomGeneration),
    );
    this.proTicketUses = next;
    return true;
  }

  private async loadProParticipantHighWater(
    roomGeneration: unknown,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<ProParticipantHighWater> {
    if (!isProRoomGeneration(roomGeneration)) {
      throw new Error('INVALID_PRO_ROOM_GENERATION');
    }
    if (this.proParticipantHighWater) {
      if (this.proParticipantHighWater.roomGeneration !== roomGeneration) {
        throw new Error('PRO_SIGNALING_PARTICIPANT_HIGH_WATER_GENERATION_MISMATCH');
      }
      return this.proParticipantHighWater;
    }
    const stored = await this.state.storage.get(PRO_PARTICIPANT_HIGH_WATER_KEY);
    if (stored !== undefined && stored !== null) {
      const normalized = normalizeProParticipantHighWater(stored);
      if (!normalized) throw new Error('INVALID_PRO_SIGNALING_PARTICIPANT_HIGH_WATER');
      if (normalized.roomGeneration !== roomGeneration) {
        throw new Error('PRO_SIGNALING_PARTICIPANT_HIGH_WATER_GENERATION_MISMATCH');
      }
      this.proParticipantHighWater = normalized;
      return normalized;
    }

    // Recover the monotonic fence from hibernated sockets before accepting a
    // fresh credential. This prevents a delayed, lower-sequence ticket from
    // reverse-replacing the socket that survived Worker eviction/deployment.
    const byParticipant = new Map<string, ProParticipantHighWaterEntry>();
    for (const socket of typeof this.state.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : []) {
      const attachment = readAttachment(socket);
      if (attachment?.roomKind !== 'pro' || attachment.ticketSequence < 1) continue;
      if (attachment.roomGeneration !== roomGeneration) {
        throw new Error('PRO_SIGNALING_ATTACHMENT_GENERATION_MISMATCH');
      }
      const current = byParticipant.get(attachment.participantId);
      if (!current || attachment.ticketSequence > current.ticketSequence) {
        byParticipant.set(attachment.participantId, {
          participantId: attachment.participantId,
          presenceIncarnationId: attachment.presenceIncarnationId,
          ticketSequence: attachment.ticketSequence,
          exp: nowSeconds + PRO_SIGNALING_TICKET_MAX_SECONDS,
        });
      }
    }
    const seeded = {
      v: 1,
      roomGeneration,
      entries: [...byParticipant.values()].slice(0, MAX_PRO_PARTICIPANT_HIGH_WATER),
    };
    if (seeded.entries.length > 0) {
      await this.state.storage.put(
        PRO_PARTICIPANT_HIGH_WATER_KEY,
        persistedProGenerationRecord(seeded, roomGeneration),
      );
    }
    this.proParticipantHighWater = seeded;
    return seeded;
  }

  private async advanceProParticipantHighWater(
    ticket: ProSignalingTicket,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<boolean> {
    const current = await this.loadProParticipantHighWater(ticket.roomGeneration, nowSeconds);
    const entries = current.entries.filter(
      (entry) => entry.exp > nowSeconds || entry.participantId === ticket.participantId,
    );
    const previous = entries.find((entry) => entry.participantId === ticket.participantId);
    if (previous && ticket.ticketSequence <= previous.ticketSequence) return false;
    const remaining = entries.filter((entry) => entry.participantId !== ticket.participantId);
    if (remaining.length >= MAX_PRO_PARTICIPANT_HIGH_WATER) {
      throw new Error('PRO_SIGNALING_PARTICIPANT_HIGH_WATER_FULL');
    }
    const next = {
      v: 1,
      roomGeneration: ticket.roomGeneration,
      entries: [
        ...remaining,
        {
          participantId: ticket.participantId,
          presenceIncarnationId: ticket.presenceIncarnationId,
          ticketSequence: ticket.ticketSequence,
          exp: ticket.exp,
        },
      ],
    };
    await this.state.storage.put(
      PRO_PARTICIPANT_HIGH_WATER_KEY,
      persistedProGenerationRecord(next, ticket.roomGeneration),
    );
    this.proParticipantHighWater = next;
    return true;
  }

  private async loadProPresenceAuthority(
    roomGeneration: unknown,
  ): Promise<ProPresenceAuthority | null> {
    if (!isProRoomGeneration(roomGeneration)) {
      throw new Error('INVALID_PRO_ROOM_GENERATION');
    }
    if (this.proPresenceAuthority !== undefined) {
      if (
        this.proPresenceAuthority &&
        this.proPresenceAuthority.roomGeneration !== roomGeneration
      ) {
        throw new Error('PRO_SIGNALING_PRESENCE_AUTHORITY_GENERATION_MISMATCH');
      }
      return this.proPresenceAuthority;
    }
    const stored = await this.state.storage.get(PRO_PRESENCE_AUTHORITY_KEY);
    if (stored === undefined || stored === null) {
      this.proPresenceAuthority = null;
      return null;
    }
    const normalized = normalizeProPresenceAuthority(stored);
    if (!normalized) throw new Error('INVALID_PRO_SIGNALING_PRESENCE_AUTHORITY');
    if (normalized.roomGeneration !== roomGeneration) {
      throw new Error('PRO_SIGNALING_PRESENCE_AUTHORITY_GENERATION_MISMATCH');
    }
    this.proPresenceAuthority = normalized;
    return normalized;
  }

  async advanceProPresenceAuthority(
    roomId: string,
    roomGeneration: number,
    coordinatorEpoch: number,
    presenceRevision: number,
    targets: string[],
  ): Promise<'stale' | 'unchanged' | 'conflict' | 'advanced'> {
    const candidate = normalizeProPresenceAuthority({
      v: 1,
      roomId,
      roomGeneration,
      coordinatorEpoch,
      presenceRevision,
      activeIncarnationIds: targets,
    });
    if (!candidate) throw new Error('INVALID_PRO_SIGNALING_PRESENCE_AUTHORITY');

    const current = await this.loadProPresenceAuthority(roomGeneration);
    if (current) {
      if (candidate.coordinatorEpoch < current.coordinatorEpoch) return 'stale';
      if (candidate.coordinatorEpoch === current.coordinatorEpoch) {
        if (candidate.presenceRevision < current.presenceRevision) return 'stale';
        if (candidate.presenceRevision === current.presenceRevision) {
          const sameActiveSet =
            candidate.activeIncarnationIds.length === current.activeIncarnationIds.length &&
            candidate.activeIncarnationIds.every(
              (incarnationId, index) => incarnationId === current.activeIncarnationIds[index],
            );
          return sameActiveSet ? 'unchanged' : 'conflict';
        }
      }
    }

    // Persist the new authoritative live-set before it is used to close or
    // admit sockets. A failed write leaves the previous fence intact and the
    // broadcast fails closed instead of creating a memory-only revocation.
    await this.state.storage.put(
      PRO_PRESENCE_AUTHORITY_KEY,
      persistedProGenerationRecord(candidate, roomGeneration),
    );
    this.proPresenceAuthority = candidate;
    return 'advanced';
  }

  private async isProTicketPresenceAuthorized(ticket: ProSignalingTicket): Promise<boolean> {
    const authority = await this.loadProPresenceAuthority(ticket.roomGeneration);
    if (!authority) return true;
    if (authority.roomId !== ticket.roomCode) return false;
    if (authority.roomGeneration !== ticket.roomGeneration) return false;
    if (ticket.coordinatorEpoch < authority.coordinatorEpoch) return false;
    if (ticket.coordinatorEpoch > authority.coordinatorEpoch) return true;
    if (ticket.presenceRevision < authority.presenceRevision) return false;
    // A ticket for the next authoritative revision can legitimately arrive
    // before the corresponding presence snapshot broadcast. Once that
    // snapshot arrives it either establishes the incarnation or closes it.
    if (ticket.presenceRevision > authority.presenceRevision) return true;
    return authority.activeIncarnationIds.includes(ticket.presenceIncarnationId);
  }

  private enqueueProAdmission<T>(task: (value?: unknown) => Promise<T>): Promise<T> {
    const run = this.proAdmissionSync.then(task, task);
    this.proAdmissionSync = run.catch(() => {});
    return run;
  }

  private async acceptProSocket(ws: SocketPort, ticket: ProSignalingTicket): Promise<void> {
    try {
      const meta = await this.loadProRoomMeta();
      if (
        meta &&
        (meta.roomId !== ticket.roomCode || meta.roomGeneration !== ticket.roomGeneration)
      ) {
        this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:room-mismatch']);
        closeWithError(ws, 'invalid-id', 'PRO_ROOM_GENERATION_MISMATCH', 1008);
        return;
      }
      if (meta && ticket.coordinatorEpoch < meta.coordinatorEpoch) {
        // Reject before consuming the one-shot JTI or advancing the per-member
        // sequence fence. Otherwise a delayed old-epoch credential could
        // poison the high-water state used by a legitimate current epoch.
        this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:stale-epoch']);
        closeWithError(ws, 'peer-unavailable', 'PRO_COORDINATOR_EPOCH_STALE', 1008);
        return;
      }
    } catch {
      this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:room-state']);
      closeWithError(ws, 'unavailable', 'PRO_SIGNALING_ROOM_STATE_UNAVAILABLE', 1013);
      this.recordMetric('pro_room_state_unavailable');
      return;
    }

    try {
      if (!(await this.isProTicketPresenceAuthorized(ticket))) {
        this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:presence-stale']);
        closeWithError(ws, 'peer-unavailable', 'PRO_SIGNALING_PRESENCE_STALE', 1008);
        this.recordMetric('pro_ticket_stale_presence');
        return;
      }
    } catch {
      this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:presence-state']);
      closeWithError(ws, 'unavailable', 'PRO_SIGNALING_PRESENCE_STATE_UNAVAILABLE', 1013);
      this.recordMetric('pro_presence_state_unavailable');
      return;
    }

    try {
      if (!(await this.consumeProTicket(ticket))) {
        this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:ticket-replay']);
        closeWithError(ws, 'peer-unavailable', 'PRO_SIGNALING_TICKET_REPLAYED', 1008);
        this.recordMetric('pro_ticket_replayed');
        return;
      }
    } catch {
      this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:ticket-state']);
      closeWithError(ws, 'unavailable', 'PRO_SIGNALING_TICKET_STATE_UNAVAILABLE', 1013);
      this.recordMetric('pro_ticket_state_unavailable');
      return;
    }

    try {
      if (!(await this.advanceProParticipantHighWater(ticket))) {
        this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:ticket-sequence']);
        closeWithError(ws, 'peer-unavailable', 'PRO_SIGNALING_TICKET_STALE', 1008);
        this.recordMetric('pro_ticket_stale_sequence');
        return;
      }
    } catch {
      this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:ticket-state']);
      closeWithError(ws, 'unavailable', 'PRO_SIGNALING_TICKET_STATE_UNAVAILABLE', 1013);
      this.recordMetric('pro_ticket_state_unavailable');
      return;
    }

    await this.acceptProMember(ws, ticket);
  }

  private async validateRehydratedProSockets(roomGeneration: unknown): Promise<void> {
    if (!isProRoomGeneration(roomGeneration)) {
      throw new Error('INVALID_PRO_ROOM_GENERATION');
    }
    if (this.proSocketsValidated) return;
    const meta = await this.loadProRoomMeta();
    if (meta && meta.roomGeneration !== roomGeneration) {
      throw new Error('PRO_SIGNALING_ROOM_META_GENERATION_MISMATCH');
    }
    const authority = await this.loadProPresenceAuthority(roomGeneration);
    for (const socket of typeof this.state.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : []) {
      const attachment = readAttachment(socket);
      if (attachment?.roomKind !== 'pro') continue;
      const current =
        meta?.kind === 'pro' &&
        meta.roomId === attachment.roomId &&
        meta.roomGeneration === attachment.roomGeneration &&
        attachment.roomGeneration === roomGeneration &&
        meta.coordinatorEpoch === attachment.coordinatorEpoch &&
        (!authority ||
          (authority.roomId === attachment.roomId &&
            authority.roomGeneration === attachment.roomGeneration &&
            (authority.coordinatorEpoch < attachment.coordinatorEpoch ||
              (authority.coordinatorEpoch === attachment.coordinatorEpoch &&
                (attachment.presenceRevision > authority.presenceRevision ||
                  authority.activeIncarnationIds.includes(attachment.presenceIncarnationId)))))) &&
        this.proMembers.get(attachment.participantId) === socket;
      if (current) continue;
      const presenceRevoked =
        authority?.roomId === attachment.roomId &&
        authority.roomGeneration === attachment.roomGeneration &&
        authority.coordinatorEpoch === attachment.coordinatorEpoch &&
        authority.presenceRevision >= attachment.presenceRevision &&
        !authority.activeIncarnationIds.includes(attachment.presenceIncarnationId);
      closeSocket(
        socket,
        presenceRevoked ? 1008 : 1012,
        presenceRevoked ? 'PRO_PRESENCE_REVOKED' : 'PRO_ROOM_EPOCH_STALE',
      );
      if (this.proMembers.get(attachment.participantId) === socket) {
        this.proMembers.delete(attachment.participantId);
      }
    }
    this.proSocketsValidated = true;
  }

  private loadRoomMeta(): Promise<RoomMeta> {
    if (this.roomMetaLoad) return this.roomMetaLoad;
    if (
      this.roomMeta &&
      this.standardSocketsValidated &&
      (this.futureRoomMetaVersion || this.roomMeta.v !== 1)
    ) {
      return Promise.resolve(this.roomMeta);
    }
    const shared = this.loadAndMigrateRoomMeta().finally(() => {
      if (this.roomMetaLoad === shared) this.roomMetaLoad = null;
    });
    this.roomMetaLoad = shared;
    return shared;
  }

  private async loadAndMigrateRoomMeta(): Promise<RoomMeta> {
    if (!this.roomMeta) {
      const stored = await this.state.storage.get(ROOM_META_KEY);
      const futureMeta = isFutureRoomMeta(stored);
      const canonicalStoredQuarantine = isCanonicalQuarantinedRoomMeta(stored);
      const missingMetaWithLiveRoom =
        stored === undefined && (this.host !== null || this.guests.size > 0);
      let normalized = missingMetaWithLiveRoom
        ? invalidCurrentRoomMeta({
            roomSecret: null,
            hostPeerId: this.hostPeerId,
            hostReleaseAt: 0,
          })
        : normalizeRoomMeta(stored);
      this.futureRoomMetaVersion = futureMeta;
      if (futureMeta) this.revokeStandardSocketsForFutureRoomMeta();

      if (
        !futureMeta &&
        isQuarantinedRoomMeta(normalized) &&
        this.host === null &&
        (normalized.hostReleaseAt === 0 ||
          !canonicalStoredQuarantine ||
          normalized.hostReleaseAt > Date.now() + HOST_RECLAIM_GRACE_MS)
      ) {
        // Corrupt current-schema records fail closed for one ordinary reclaim
        // window, then become recoverable without dashboard intervention. A
        // pending claimant is not an established epoch and must not make this
        // quarantine permanent.
        normalized = {
          ...normalized,
          hostPeerId: null,
          hostReleaseAt:
            canonicalStoredQuarantine && normalized.hostReleaseAt > 0
              ? Math.min(normalized.hostReleaseAt, Date.now() + HOST_RECLAIM_GRACE_MS)
              : Date.now() + HOST_RECLAIM_GRACE_MS,
        };
      }

      if (
        !futureMeta &&
        (missingMetaWithLiveRoom ||
          isLegacyRollbackLockedRoomMeta(stored) ||
          isQuarantinedRoomMeta(normalized))
      ) {
        // A retired Worker can rewrite the v2 compatibility lock into its v1
        // shape during an unrelated lifecycle update. Canonicalize that record
        // durably before admitting anyone. Missing or malformed current state
        // is quarantine, never a new passwordless room. Future schema versions
        // stay byte-for-byte untouched for a forward-compatible Worker.
        await this.state.storage.put(ROOM_META_KEY, normalized);
      }
      this.roomMeta = normalized;
    }

    if (!this.futureRoomMetaVersion && this.roomMeta.v === 1) {
      let migrated = await this.migrateLegacyRoomMeta(this.roomMeta);
      if (migrated !== this.roomMeta) {
        if (isQuarantinedRoomMeta(migrated) && this.host === null) {
          migrated = {
            ...migrated,
            hostPeerId: null,
            hostReleaseAt: Date.now() + HOST_RECLAIM_GRACE_MS,
          };
        }
        await this.state.storage.put(ROOM_META_KEY, migrated);
        this.roomMeta = migrated;
      }
    }
    this.roomMeta = await this.validateRehydratedStandardSockets(this.roomMeta);
    return this.roomMeta;
  }

  private async validateRehydratedStandardSockets(meta: RoomMeta): Promise<RoomMeta> {
    if (this.standardSocketsValidated) return meta;
    if (this.futureRoomMetaVersion || isQuarantinedRoomMeta(meta)) {
      this.standardSocketsValidated = true;
      return meta;
    }
    if (typeof this.state.getWebSockets !== 'function') {
      this.standardSocketsValidated = true;
      return meta;
    }

    // WebSocket attachments are hibernation indexes, not durable host
    // authority. A replacement can commit roomMeta and then lose its isolate
    // before promoting its attachment or closing the predecessor. Select the
    // socket named by the durable record regardless of enumeration order and
    // revoke every other auth-ok host before any Standard frame can relay.
    const indexedHost = this.host;
    const sockets = this.state.getWebSockets();
    const orderedSockets = indexedHost
      ? [indexedHost, ...sockets.filter((socket) => socket !== indexedHost)]
      : sockets;
    let authoritativeHost: SocketPort | null = null;
    let authoritativeAttachment: StandardHostOkAttachment | null = null;
    for (const socket of orderedSockets) {
      const attachment = readAttachment(socket);
      if (
        !attachment ||
        attachment.roomKind === 'pro' ||
        attachment.role !== 'host' ||
        attachment.auth !== 'ok' ||
        this.standardPinRetrySockets.has(socket)
      ) {
        continue;
      }
      const authoritative =
        authoritativeHost === null &&
        meta.roomSecret !== null &&
        meta.hostReleaseAt === 0 &&
        attachment.roomId === this.standardRoomId &&
        attachment.secret === meta.roomSecret &&
        attachment.peerId === meta.hostPeerId;
      if (authoritative) {
        authoritativeHost = socket;
        authoritativeAttachment = attachment;
      } else {
        closeSocket(socket, 1012, 'STANDARD_ROOM_AUTHORITY_STALE');
      }
    }
    this.host = authoritativeHost;
    this.hostPeerId = authoritativeAttachment?.peerId ?? null;

    let reconciled = meta;
    if (!authoritativeHost && meta.hostPeerId !== null && meta.hostReleaseAt === 0) {
      // A durable host selection without its matching accepted attachment is a
      // crash residue. Start the ordinary reclaim window so the same secret
      // can reconnect immediately and the room cannot remain orphaned forever.
      reconciled = await this.saveRoomMeta({
        ...meta,
        hostPeerId: null,
        hostReleaseAt: Date.now() + HOST_RECLAIM_GRACE_MS,
      });
    }
    this.standardSocketsValidated = true;
    return reconciled;
  }

  private revokeStandardSocketsForFutureRoomMeta(): void {
    // A future schema may add authority or revocation state that this Worker
    // cannot interpret. Hibernated auth-ok attachments are only an index hint;
    // they must never outlive the durable authority schema that validated them.
    // Preserve the unknown record byte-for-byte and require a forward-capable
    // Worker to rehydrate the epoch.
    const sockets = new Set<SocketPort>([
      ...(this.host ? [this.host] : []),
      ...this.pendingHosts,
      ...this.guests.values(),
      ...this.pendingGuests,
    ]);
    this.host = null;
    this.hostPeerId = null;
    this.pendingHosts.clear();
    this.guests.clear();
    this.pendingGuests.clear();
    this.standardSocketsValidated = true;
    for (const socket of sockets) {
      closeSocket(socket, 1012, 'STANDARD_ROOM_PROTOCOL_UPGRADED');
    }
  }

  private async migrateLegacyRoomMeta(meta: LegacyRoomMeta): Promise<RoomMeta> {
    if (meta.roomPassword === '') return currentRoomMeta(meta, null);
    if (!this.standardRoomId) return meta;
    const verifier = await createStandardRoomPinVerifier(
      this.env,
      this.standardRoomId,
      meta.roomSecret,
      meta.roomPassword,
    );
    // Configuration and cryptographic availability failures are retryable;
    // they are not evidence that the stored legacy record is corrupt. Keep the
    // original protected value and fail admission until a later load can make
    // the hash-only replacement durable.
    return verifier ? currentRoomMeta(meta, verifier) : meta;
  }

  private async saveRoomMeta(meta: unknown): Promise<RoomMeta> {
    if (this.futureRoomMetaVersion) {
      throw new Error('STANDARD_ROOM_META_FUTURE_VERSION');
    }
    let normalized = normalizeRoomMeta(meta);
    if (normalized.v === 1) normalized = await this.migrateLegacyRoomMeta(normalized);
    await this.state.storage.put(ROOM_META_KEY, normalized);
    this.roomMeta = normalized;
    return normalized;
  }

  private async verifyStandardRoomPassword(
    meta: RoomMeta,
    roomId: string,
    password: string,
  ): Promise<boolean> {
    if (!hasStandardRoomPassword(meta)) return true;

    // Always require the dedicated pepper before consulting a legacy plaintext
    // value. A missing/mis-scoped secret must fail closed and must never turn a
    // protected active room into an accepted legacy-only path.
    const pinKeyring = standardRoomPinPepperKeyring(this.env);
    if (!pinKeyring) return false;
    const presentedVerifier = await createStandardRoomPinVerifierWithPepper(
      pinKeyring.current.secret,
      roomId,
      meta.roomSecret,
      password,
    );
    if (!presentedVerifier) return false;

    if (meta.v === 1) {
      const legacyVerifier = await createStandardRoomPinVerifierWithPepper(
        pinKeyring.current.secret,
        roomId,
        meta.roomSecret,
        meta.roomPassword,
      );
      if (
        !legacyVerifier ||
        !constantTimeStringEqual(presentedVerifier.digest, legacyVerifier.digest)
      ) {
        return false;
      }
      // The guest-admission queue serializes this write with host ownership and
      // password mutations. Admission happens only after the hash-only v2 record
      // is durable, so a failed migration cannot authenticate the guest.
      await this.saveRoomMeta(currentRoomMeta(meta, legacyVerifier));
      return true;
    }

    if (
      meta.roomPasswordVerifier === null ||
      !isValidStandardRoomPinVerifier(meta.roomPasswordVerifier)
    ) {
      return false;
    }
    if (constantTimeStringEqual(presentedVerifier.digest, meta.roomPasswordVerifier.digest)) {
      return true;
    }

    const previousPepper = pinKeyring.previous?.secret;
    if (!previousPepper) return false;
    const previousVerifier = await createStandardRoomPinVerifierWithPepper(
      previousPepper,
      roomId,
      meta.roomSecret,
      password,
    );
    if (
      !previousVerifier ||
      !constantTimeStringEqual(previousVerifier.digest, meta.roomPasswordVerifier.digest)
    ) {
      return false;
    }

    // Successful previous-key verification is also the rewrap boundary. Make
    // the current-key verifier durable before guest admission so the previous
    // key can be retired without disconnecting an active protected room.
    await this.saveRoomMeta(currentRoomMeta(meta, presentedVerifier));
    return true;
  }

  private async clearRoomMeta(): Promise<RoomMeta> {
    if (this.futureRoomMetaVersion) {
      if (this.roomMeta) return this.roomMeta;
      throw new Error('STANDARD_ROOM_META_FUTURE_VERSION');
    }
    const roomMeta = defaultRoomMeta();
    const members = defaultStandardRoomMembers();
    const bindings = defaultGuestBindings();
    // Do not let an older hibernation-time read publish a stale reconnect
    // directory into memory after this atomic epoch reset commits. A future
    // reconnect schema may carry authority this Worker cannot discard, so it
    // remains byte-for-byte owned by the forward-capable release.
    await this.loadGuestBindings();
    if (this.guestBindingsFutureVersion) {
      throw new Error('STANDARD_ROOM_GUEST_BINDINGS_FUTURE_VERSION');
    }
    if (typeof this.state.storage.transaction === 'function') {
      await this.state.storage.transaction(async (transaction) => {
        await transaction.put(ROOM_META_KEY, roomMeta);
        await transaction.put(STANDARD_ROOM_MEMBERS_KEY, members);
        await transaction.put(GUEST_BINDINGS_KEY, bindings);
      });
    } else {
      // Test/runtime compatibility fallback. Production Durable Object storage
      // provides transactions, making the room epoch reset atomic.
      await this.state.storage.put(ROOM_META_KEY, roomMeta);
      await this.state.storage.put(STANDARD_ROOM_MEMBERS_KEY, members);
      await this.state.storage.put(GUEST_BINDINGS_KEY, bindings);
    }
    this.roomMeta = roomMeta;
    this.futureRoomMetaVersion = false;
    this.standardRoomMembers = members;
    this.guestBindings = bindings;
    this.guestBindingsInvalid = false;
    this.guestBindingsFutureVersion = false;
    return roomMeta;
  }

  private failStandardRoomPinMutation(
    ws: SocketPort,
    mutationId: string | null,
    errorType: string,
  ): void {
    // The desired PIN remains in the client and is replayed in host-auth after
    // reconnect. Until that exact mutation commits, block guest admission and
    // revoke every in-memory authority derived from the older durable record.
    this.standardRoomPinMutationFence = mutationId || `legacy-${crypto.randomUUID()}`;
    this.standardRoomPinMutationFenceOwner = ws;
    if (mutationId) {
      sendChecked(ws, {
        type: 'room-password-result',
        mutationId,
        applied: false,
        errorType,
      });
    }
    const sockets = new Set<SocketPort>([
      ws,
      ...(this.host ? [this.host] : []),
      ...this.pendingHosts,
      ...this.guests.values(),
      ...this.pendingGuests,
    ]);
    this.host = null;
    this.hostPeerId = null;
    this.guests.clear();
    this.pendingGuests.clear();
    this.pendingHosts.clear();
    for (const socket of sockets) {
      closeSocket(socket, socket === ws ? 1011 : 1012, 'ROOM_SECURITY_CONFIG_UNAVAILABLE');
    }
    this.requestMaintenanceAlarm();
  }

  private rejectPendingStandardRoomPinMutation(
    ws: SocketPort,
    mutationId: string | null,
    previousFence: string | null,
    previousFenceOwner: SocketPort | null,
    errorType: string,
    closeReason = 'ROOM_SECURITY_CONFIG_UNAVAILABLE',
  ): void {
    // A replacement candidate has not acquired authority yet. Its failed
    // durable commit must not revoke the still-authoritative live host or its
    // guests; restore the fence that existed before this admission attempt and
    // reject only the candidate. The client retains the mutation for retry.
    this.standardRoomPinMutationFence = previousFence;
    this.standardRoomPinMutationFenceOwner = previousFenceOwner;
    this.pendingHosts.delete(ws);
    if (mutationId) {
      sendChecked(ws, {
        type: 'room-password-result',
        mutationId,
        applied: false,
        errorType,
      });
    }
    closeSocket(ws, 1011, closeReason);
    this.requestMaintenanceAlarm();
  }

  private async loadStandardRoomMembers(): Promise<StandardRoomMembers> {
    if (!this.standardRoomMembers) {
      const stored = await this.state.storage.get(STANDARD_ROOM_MEMBERS_KEY);
      this.standardRoomMembers = normalizeStandardRoomMembers(stored);
    }
    return this.standardRoomMembers;
  }

  private async saveStandardRoomMembers(directory: unknown): Promise<StandardRoomMembers> {
    const normalized = normalizeStandardRoomMembers(directory);
    await this.state.storage.put(STANDARD_ROOM_MEMBERS_KEY, normalized);
    this.standardRoomMembers = normalized;
    return normalized;
  }

  private async clearStandardRoomMembers(): Promise<StandardRoomMembers> {
    return this.saveStandardRoomMembers(defaultStandardRoomMembers());
  }

  private async resolveStandardRoomIdentity(
    assertion: unknown,
    roomId: string,
    peerId: string,
    role: 'host' | 'guest',
    roomSecret: string,
  ): Promise<StandardRoomIdentity | null> {
    if (typeof assertion !== 'string' || !assertion) return null;
    const secret = String(this.env?.MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET || '');
    const verified = await verifyStandardRoomAccountAssertion(assertion, secret, {
      roomCode: roomId,
      peerId,
      role,
    });
    if (!verified) return null;
    const memberId = await deriveStandardRoomMemberId(roomSecret, verified.accountSubject);
    if (!memberId) return null;
    const directory = await this.loadStandardRoomMembers();
    const existing = directory.entries.find(
      (entry) => entry.accountSubject === verified.accountSubject,
    );
    let memberDisplayNumber = role === 'host' ? 0 : existing?.memberDisplayNumber;
    if (memberDisplayNumber === undefined) {
      const occupied = new Set(directory.entries.map((entry) => entry.memberDisplayNumber));
      const preferred = Math.max(1, Math.min(99, this.guests.size + 1));
      for (let offset = 0; offset < 99; offset += 1) {
        const candidate = ((preferred - 1 + offset) % 99) + 1;
        if (occupied.has(candidate)) continue;
        memberDisplayNumber = candidate;
        break;
      }
      if (memberDisplayNumber === undefined) return null;
    }
    const entry = {
      accountSubject: verified.accountSubject,
      memberId,
      memberDisplayNumber,
    };
    if (
      !existing ||
      existing.memberId !== entry.memberId ||
      existing.memberDisplayNumber !== entry.memberDisplayNumber
    ) {
      const remaining = directory.entries.filter(
        (candidate) => candidate.accountSubject !== verified.accountSubject,
      );
      if (!existing && remaining.length >= MAX_STANDARD_ROOM_ACCOUNT_MEMBERS) return null;
      await this.saveStandardRoomMembers({ v: 1, entries: [...remaining, entry] });
    }
    return {
      ...entry,
      nickname: verified.nickname,
      expiresAt: verified.expiresAt,
    };
  }

  private async resolveStandardRoomIdentityDeletion(
    assertion: unknown,
    roomId: string,
    peerId: string,
    role: 'host' | 'guest',
    roomSecret: string,
  ): Promise<{ accountSubject: string; memberId: string } | null> {
    if (typeof assertion !== 'string' || !assertion) return null;
    const secret = String(this.env?.MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET || '');
    const verified = await verifyStandardRoomAccountDeletionAssertion(assertion, secret, {
      roomCode: roomId,
      peerId,
      role,
    });
    if (!verified) return null;
    const memberId = await deriveStandardRoomMemberId(roomSecret, verified.accountSubject);
    if (!memberId) return null;
    return { accountSubject: verified.accountSubject, memberId };
  }

  private loadGuestBindings(): Promise<GuestBindings> {
    if (this.guestBindings) return Promise.resolve(this.guestBindings);
    if (this.guestBindingsLoad) return this.guestBindingsLoad;
    const shared = this.loadGuestBindingsFromStorage().finally(() => {
      if (this.guestBindingsLoad === shared) this.guestBindingsLoad = null;
    });
    this.guestBindingsLoad = shared;
    return shared;
  }

  private async loadGuestBindingsFromStorage(): Promise<GuestBindings> {
    const stored = await this.state.storage.get(GUEST_BINDINGS_KEY);
    if (stored === undefined) {
      // New and pre-binding rooms legitimately have no directory. Live
      // hibernated guests prove that reconnect ownership did exist, however;
      // treating that loss as an empty map would let any secret take over an
      // already admitted peerId.
      this.guestBindingsInvalid = this.guests.size > 0;
      this.guestBindingsFutureVersion = false;
      this.guestBindings = defaultGuestBindings();
      return this.guestBindings;
    }
    const normalized = normalizeGuestBindings(stored);
    this.guestBindingsFutureVersion = isRecord(stored) && isSafeInteger(stored.v) && stored.v > 1;
    this.guestBindingsInvalid = normalized === null;
    this.guestBindings = normalized ?? defaultGuestBindings();
    return this.guestBindings;
  }

  private async saveGuestBindings(bindings: unknown): Promise<GuestBindings> {
    const normalized = normalizeGuestBindings(bindings);
    if (!normalized || this.guestBindingsInvalid) {
      throw new Error('STANDARD_ROOM_GUEST_BINDINGS_INVALID');
    }
    await this.state.storage.put(GUEST_BINDINGS_KEY, normalized);
    this.guestBindings = normalized;
    return normalized;
  }

  private async clearGuestBindings(): Promise<GuestBindings> {
    await this.loadGuestBindings();
    if (this.guestBindingsFutureVersion) {
      throw new Error('STANDARD_ROOM_GUEST_BINDINGS_FUTURE_VERSION');
    }
    const bindings = defaultGuestBindings();
    await this.state.storage.put(GUEST_BINDINGS_KEY, bindings);
    this.guestBindings = bindings;
    this.guestBindingsInvalid = false;
    this.guestBindingsFutureVersion = false;
    return bindings;
  }

  private pruneGuestBindings(bindings: GuestBindings, now = Date.now()): GuestBindings {
    const activePeerIds = new Set(this.guests.keys());
    const entries = bindings.entries.filter(
      (entry) =>
        activePeerIds.has(entry.peerId) || now - entry.updatedAt <= GUEST_BINDING_RECONNECT_TTL_MS,
    );
    return { v: 1, entries };
  }

  private enqueueStandardAdmission<T>(task: (value?: unknown) => Promise<T>): Promise<T> {
    const run = this.standardAdmissionSync.then(task, task);
    this.standardAdmissionSync = run.catch(() => {});
    return run;
  }

  private enqueueHostAdmission<T>(task: (value?: unknown) => Promise<T>): Promise<T> {
    return this.enqueueStandardAdmission(task);
  }

  private enqueueGuestAdmission<T>(task: (value?: unknown) => Promise<T>): Promise<T> {
    return this.enqueueStandardAdmission(task);
  }

  private enqueueStandardOrderedIngress<T>(task: (value?: unknown) => Promise<T>): Promise<T> {
    const run = this.standardOrderedIngressSync.then(task, task);
    this.standardOrderedIngressSync = run.catch(() => {});
    return run;
  }

  private currentStandardRoomAttachment(
    ws: SocketPort,
  ): StandardHostOkAttachment | StandardGuestOkAttachment | null {
    const attachment = readAttachment(ws);
    if (!attachment || attachment.roomKind === 'pro' || attachment.auth !== 'ok') return null;
    if (attachment.role === 'host') return this.host === ws ? attachment : null;
    return this.guests.get(attachment.peerId) === ws ? attachment : null;
  }

  private releaseStandardRoomPinMutationClaim(ws: SocketPort, mutationClaim?: string): void {
    if (!mutationClaim) return;
    const current = this.currentStandardRoomAttachment(ws);
    if (
      current?.role === 'host' &&
      current.pinConfigurationPending &&
      current.pinConfigurationMutationId === mutationClaim
    ) {
      const released = { ...current };
      delete released.pinConfigurationPending;
      delete released.pinConfigurationMutationId;
      serializeSocketAttachment(ws, released);
    }
    if (
      this.standardRoomPinMutationFence === mutationClaim &&
      this.standardRoomPinMutationFenceOwner === ws
    ) {
      this.standardRoomPinMutationFence = null;
      this.standardRoomPinMutationFenceOwner = null;
    }
  }

  private classifyStandardOrderedIngress(
    ws: SocketPort,
    raw: unknown,
  ): StandardOrderedIngress | null {
    const attachment = readAttachment(ws);
    if (!attachment || attachment.roomKind === 'pro') return null;
    if (attachment.auth === 'ok') {
      const rawBytes = rawMessageByteLength(raw);
      if (rawBytes === null || rawBytes > WS_MESSAGE_MAX_BYTES) return null;
      const message = this.parse(raw);
      if (this.currentStandardRoomAttachment(ws) === null) return null;
      if (
        attachment.role === 'host' &&
        message?.type === 'room-password-set' &&
        validateIncomingMessage(message, 'host') === 'valid'
      ) {
        return {
          preclaimedAuth: false,
          pinConfigurationMutationId:
            typeof message.pinMutationId === 'string'
              ? message.pinMutationId
              : `legacy-${crypto.randomUUID()}`,
        };
      }
      return isStandardRoomIdentityMutation(message) ? { preclaimedAuth: false } : null;
    }
    if (attachment.authStarted) return null;
    if (attachment.role === 'host') {
      return this.pendingHosts.has(ws) ? { preclaimedAuth: true } : null;
    }
    return this.pendingGuests.has(ws) ? { preclaimedAuth: true } : null;
  }

  private async consumeStandardWsOpenRate(): Promise<Response> {
    await this.standardRateReady;
    if (this.standardRateStateInvalid) {
      return json({ error: 'STANDARD_WS_RATE_STATE_INVALID' }, 503);
    }
    return this.enqueueStandardAdmission(async () => {
      const now = Date.now();
      const windowStartMs =
        Math.floor(now / STANDARD_WS_RATE_WINDOW_MS) * STANDARD_WS_RATE_WINDOW_MS;
      const resetAtMs = windowStartMs + STANDARD_WS_RATE_WINDOW_MS;
      const current =
        this.standardRateState?.windowStartMs === windowStartMs ? this.standardRateState : null;
      const count = current?.count || 0;
      const allowed = count < WS_RATE_LIMIT_PER_MINUTE;
      if (allowed) {
        const next = {
          v: 1,
          windowStartMs,
          resetAtMs,
          count: count + 1,
        };
        await this.state.storage.put(STANDARD_WS_RATE_STATE_KEY, next);
        this.standardRateState = next;
      }
      if (this.standardRateAlarmAt !== resetAtMs) {
        await this.state.storage.setAlarm(resetAtMs);
        this.standardRateAlarmAt = resetAtMs;
      }
      if (allowed) return new Response(null, { status: 204 });
      return new Response(null, {
        status: 429,
        headers: { 'retry-after': String(Math.max(1, Math.ceil((resetAtMs - now) / 1_000))) },
      });
    });
  }

  private async cleanupStandardWsOpenRate(): Promise<void> {
    await this.standardRateReady;
    if (this.standardRateStateInvalid) {
      throw new Error('STANDARD_WS_RATE_STATE_INVALID');
    }
    return this.enqueueStandardAdmission(async () => {
      const state = this.standardRateState;
      if (state && state.resetAtMs > Date.now()) {
        await this.state.storage.setAlarm(state.resetAtMs);
        this.standardRateAlarmAt = state.resetAtMs;
        return;
      }
      await this.state.storage.delete(STANDARD_WS_RATE_STATE_KEY);
      await this.state.storage.deleteAlarm();
      this.standardRateState = null;
      this.standardRateAlarmAt = null;
    });
  }

  private async clearExpiredHostRelease(): Promise<RoomMeta> {
    const meta = await this.loadRoomMeta();
    if (this.futureRoomMetaVersion) return meta;
    if (this.host || !meta.hostReleaseAt || meta.hostReleaseAt > Date.now()) return meta;

    // A room epoch ends when the host reclaim grace expires. Any hibernated
    // guest sockets from that epoch must not survive into a new host that later
    // claims the same six-digit room ID.
    for (const socket of new Set([...this.guests.values(), ...this.pendingGuests])) {
      closeSocket(socket, 1012, 'ROOM_EXPIRED');
    }
    this.guests.clear();
    this.pendingGuests.clear();
    return this.clearRoomMeta();
  }

  private nextMaintenanceAlarmAt(): number | null {
    let earliest: number | null = null;
    for (const sock of [...this.pendingHosts, ...this.pendingGuests]) {
      const attachment = readAttachment(sock);
      if (typeof attachment?.authDeadline !== 'number') continue;
      // Fire just after the deadline so the strict `now > authDeadline`
      // timeout check has definitely elapsed on wake.
      const authSweepAt = attachment.authDeadline + 1000;
      if (earliest === null || authSweepAt < earliest) earliest = authSweepAt;
    }

    const hostReleaseAt = !this.host ? this.roomMeta?.hostReleaseAt : 0;
    if (hostReleaseAt && (earliest === null || hostReleaseAt < earliest)) {
      earliest = hostReleaseAt;
    }
    for (const socket of [this.host, ...this.guests.values()]) {
      if (!socket) continue;
      const attachment = readAttachment(socket);
      if (!isSafeInteger(attachment?.identityExpiresAt)) continue;
      const identityExpiryAt = attachment.identityExpiresAt;
      if (earliest === null || identityExpiryAt < earliest) earliest = identityExpiryAt;
    }
    for (const proof of this.proBotRequestProofs?.entries || []) {
      const proofExpiryAt = proof.expiresAtMs + 1;
      if (earliest === null || proofExpiryAt < earliest) earliest = proofExpiryAt;
    }
    const activeGuestIds = new Set(this.guests.keys());
    for (const binding of this.guestBindings?.entries || []) {
      if (activeGuestIds.has(binding.peerId)) continue;
      const bindingExpiryAt = binding.updatedAt + GUEST_BINDING_RECONNECT_TTL_MS + 1;
      if (earliest === null || bindingExpiryAt < earliest) earliest = bindingExpiryAt;
    }
    return earliest;
  }

  private async syncMaintenanceAlarm(): Promise<void> {
    await this.loadRoomMeta();
    await this.loadGuestBindings();
    const proMeta = await this.loadProRoomMeta();
    if (proMeta) {
      await this.loadProBotRequestProofs(proMeta.roomId, proMeta.coordinatorEpoch);
    }
    const nextAlarmAt = this.nextMaintenanceAlarmAt();
    const currentAlarm = await this.state.storage.getAlarm();
    if (nextAlarmAt === null) {
      if (currentAlarm !== null) await this.state.storage.deleteAlarm();
      return;
    }
    if (currentAlarm !== nextAlarmAt) await this.state.storage.setAlarm(nextAlarmAt);
  }

  private async scheduleMaintenanceAlarmRetry(): Promise<void> {
    const delay = Math.min(
      MAINTENANCE_ALARM_RETRY_MAX_MS,
      MAINTENANCE_ALARM_RETRY_BASE_MS * 2 ** this.alarmMaintenanceRetryAttempt,
    );
    this.alarmMaintenanceRetryAttempt += 1;
    // Durable Objects expose one persistent alarm and may hibernate between
    // events. Use that alarm itself as the retry clock instead of a JavaScript
    // timer, which would keep the isolate alive and disappear on eviction.
    await this.state.storage.setAlarm(Date.now() + delay);
  }

  private clearMaintenanceAlarmRetry(): void {
    this.alarmMaintenanceRetryAttempt = 0;
  }

  private scheduleMaintenanceAlarm(): Promise<void> {
    // Alarm updates may be requested by overlapping WebSocket callbacks. Keep
    // them ordered and recompute from the latest in-memory state at execution
    // time so an older request cannot overwrite a newer deadline.
    const run = this.alarmSync.then(
      () => this.syncMaintenanceAlarm(),
      () => this.syncMaintenanceAlarm(),
    );
    // Keep the serialization tail fulfilled so one transient storage failure
    // cannot poison every later alarm update. The returned operation still
    // rejects, allowing an awaited alarm callback to surface the fault, while
    // the bounded Durable Object alarm repairs fire-and-forget WebSocket paths
    // even if the isolate hibernates immediately afterwards.
    this.alarmSync = run.catch(() => {});
    const observed = run.then(
      () => {
        this.clearMaintenanceAlarmRetry();
      },
      async (error) => {
        console.warn('[Room] Failed to synchronize maintenance alarm', error);
        try {
          await this.scheduleMaintenanceAlarmRetry();
        } catch (retryError) {
          throw new AggregateError(
            [error, retryError],
            'Failed to synchronize or arm a maintenance alarm retry',
          );
        }
        throw error;
      },
    );
    return observed;
  }

  private requestMaintenanceAlarm(): void {
    // Keep the rejected branch observable: if both synchronization and its
    // durable retry fail, defer() reports the AggregateError instead of losing
    // the only evidence that no persistent alarm was armed.
    this.defer(this.scheduleMaintenanceAlarm(), 'maintenance alarm synchronization');
  }

  private acceptSocket(ws: SocketPort, attachment: SocketAttachment | null, tags: string[]): void {
    this.state.acceptWebSocket(ws, tags);
    if (attachment) serializeSocketAttachment(ws, attachment);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (this.standardHttpBridgeOnly) {
      return this.handleStandardHttpBridgeFetch(request, url);
    }
    if (this.standardRateOnly) {
      if (
        request.method !== 'POST' ||
        url.pathname !== STANDARD_WS_RATE_CONSUME_PATH ||
        url.search ||
        url.hash
      ) {
        return json({ error: 'NOT_FOUND' }, 404);
      }
      return this.consumeStandardWsOpenRate();
    }
    const maintenanceResponse = await gateServiceMaintenance(request, this.env, { format: 'json' });
    if (maintenanceResponse) return maintenanceResponse;
    if (url.pathname.startsWith('/internal/')) {
      if (request.method !== 'POST' || url.search || url.hash) {
        return json({ error: 'NOT_FOUND' }, 404);
      }
      if (url.pathname === '/internal/developer/v1/dispatch') {
        return json({ error: 'PRO_COORDINATOR_REMOVED' }, 409);
      }
      if (url.pathname === '/internal/developer/v1/invalidate') {
        return json({ error: 'PRO_COORDINATOR_REMOVED' }, 409);
      }
      if (url.pathname === '/internal/realtime/v1/broadcast') {
        return this.enqueueProAdmission(() => this.handleInternalProRealtimeBroadcast(request));
      }
      if (url.pathname === '/internal/admin/v1/decommission') {
        return this.enqueueProAdmission(() =>
          this.enqueueProChatMutation(() => this.handleInternalAdminDecommission(request)),
        );
      }
      if (url.pathname === '/internal/admin/v1/owner-account-deleted') {
        return this.enqueueProAdmission(() =>
          this.enqueueProChatMutation(() => this.handleInternalOwnerAccountDeletedFence(request)),
        );
      }
      return json({ error: 'NOT_FOUND' }, 404);
    }
    const upgrade = request.headers.get('Upgrade') || '';
    if (upgrade.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required' }, 426);
    }

    const proRoomId = url.pathname.match(PRO_ROOM_PATH)?.[1];
    if (proRoomId) {
      if (!isProNamespaceRoomCode(proRoomId)) {
        return json({ error: 'PRO_ROOM_NOT_CONFIGURED' }, 404);
      }
      // The signed bearer is accepted only as a non-selected WebSocket
      // subprotocol token so URL telemetry cannot capture or replay it.
      const credential = readProSignalingCredential(request, url);
      if (!credential) return json({ error: 'INVALID_PRO_SIGNALING_TICKET' }, 401);
      const ticket = await verifyProSignalingTicket(credential.ticket, proRoomId, this.env);
      if (!ticket) return json({ error: 'INVALID_PRO_SIGNALING_TICKET' }, 401);

      return this.enqueueProAdmission(async () => {
        // Keep the tombstone read in the same queue as ticket consumption and
        // permanent decommission. A connection that passed an earlier check
        // must never repopulate signaling storage after the deletion sweep.
        const storedDecommissioned = await this.state.storage.get(PRO_DECOMMISSIONED_KEY);
        const decommissioned =
          storedDecommissioned === undefined || storedDecommissioned === null
            ? null
            : normalizeProDecommissioned(storedDecommissioned);
        if (
          storedDecommissioned !== undefined &&
          storedDecommissioned !== null &&
          !decommissioned
        ) {
          return json({ error: 'PRO_SIGNALING_ROOM_STATE_UNAVAILABLE' }, 503);
        }
        if (
          decommissioned &&
          (decommissioned.roomCode !== proRoomId ||
            decommissioned.roomGeneration !== ticket.roomGeneration)
        ) {
          return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
        }
        if (decommissioned) {
          return json({ error: 'PRO_ROOM_DECOMMISSIONED' }, 410);
        }
        let ownerAccountDeletionFence;
        try {
          ownerAccountDeletionFence = await this.loadProOwnerAccountDeletionFence();
        } catch {
          return json({ error: 'PRO_SIGNALING_ROOM_STATE_UNAVAILABLE' }, 503);
        }
        if (ownerAccountDeletionFence) {
          return json({ error: 'PRO_OWNER_ACCOUNT_DELETED' }, 423);
        }
        await this.validateRehydratedProSockets(ticket.roomGeneration);
        const [client, server] = createWebSocketPairPorts();
        await this.acceptProSocket(server, ticket);
        return webSocketUpgradeResponse(
          client,
          credential.responseProtocol
            ? { 'Sec-WebSocket-Protocol': credential.responseProtocol }
            : undefined,
        );
      });
    }

    const roomId = url.pathname.match(ROOM_PATH)?.[1];
    const role = url.searchParams.get('role');
    const peerId = url.searchParams.get('peerId');
    if (!roomId || (role !== 'host' && role !== 'guest') || !isValidPeerId(peerId)) {
      return json({ error: 'Bad request' }, 400);
    }
    if (isProNamespaceRoomCode(roomId)) {
      return json({ error: 'ROOM_RESERVED' }, 403);
    }
    if (!this.rememberStandardRoomId(roomId)) {
      return json({ error: 'ROOM_STATE_INVALID' }, 409);
    }

    const [client, server] = createWebSocketPairPorts();

    if (role === 'host') {
      this.acceptPendingHost(server, roomId, peerId);
    } else if (role === 'guest') {
      await this.acceptGuest(server, roomId, peerId);
    } else {
      this.acceptSocket(server, null, ['role:invalid']);
      closeWithError(server, 'invalid-id', 'INVALID_ROLE');
    }

    return webSocketUpgradeResponse(client);
  }

  private async handleInternalAdminDecommission(request: Request): Promise<Response> {
    const value = await readBoundedJson(request, INTERNAL_ADMIN_BODY_MAX_BYTES);
    const roomGeneration = internalProRoomGeneration(request, value);
    if (
      !hasExactKeys(value, ['roomCode', 'requestId'], ['roomGeneration']) ||
      !isProNamespaceRoomCode(value.roomCode) ||
      request.headers.get('x-mxqr-pro-room-code') !== value.roomCode ||
      roomGeneration === null ||
      typeof value.requestId !== 'string' ||
      !ADMIN_REQUEST_ID_RE.test(value.requestId)
    ) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }

    const storedExisting = await this.state.storage.get(PRO_DECOMMISSIONED_KEY);
    const existing =
      storedExisting === undefined || storedExisting === null
        ? null
        : normalizeProDecommissioned(storedExisting);
    if (storedExisting !== undefined && storedExisting !== null && !existing) {
      return json({ error: 'PRO_SIGNALING_ROOM_STATE_UNAVAILABLE' }, 503);
    }
    if (
      existing &&
      (existing.roomCode !== value.roomCode || existing.roomGeneration !== roomGeneration)
    ) {
      return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
    }
    const meta = await this.loadProRoomMeta();
    if (meta && (meta.roomId !== value.roomCode || meta.roomGeneration !== roomGeneration)) {
      return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
    }
    const changed = !existing;
    const tombstone = changed
      ? {
          v: 1,
          roomCode: value.roomCode,
          ...proRoomGenerationWireFields(roomGeneration),
          requestId: value.requestId,
          decommissionedAtMs: Date.now(),
        }
      : existing;

    // Persist the admission fence before deleting any other key. If cleanup is
    // interrupted, old signaling tickets remain rejected and an idempotent
    // retry repairs the residue without a deleteAll -> put crash window.
    await this.state.storage.put(
      PRO_DECOMMISSIONED_KEY,
      persistedProGenerationRecord(tombstone, roomGeneration),
    );

    for (const socket of typeof this.state.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : []) {
      closeSocket(socket, 1012, 'PRO_ROOM_DECOMMISSIONED');
    }
    this.host = null;
    this.hostPeerId = null;
    this.pendingHosts.clear();
    this.guests.clear();
    this.pendingGuests.clear();
    this.proMembers.clear();
    this.roomMeta = null;
    this.proRoomMeta = null;
    this.guestBindings = null;
    this.proTicketUses = null;
    this.proParticipantHighWater = null;
    this.proPresenceAuthority = undefined;
    this.proChatControlState = undefined;
    this.proBotRequestProofs = undefined;
    this.proOwnerAccountDeletionFence = undefined;
    this.proSocketsValidated = true;

    const stored =
      typeof this.state.storage.list === 'function' ? await this.state.storage.list() : null;
    const keys = stored
      ? [...stored.keys()]
      : [
          ROOM_META_KEY,
          GUEST_BINDINGS_KEY,
          PRO_ROOM_META_KEY,
          PRO_TICKET_USES_KEY,
          PRO_PARTICIPANT_HIGH_WATER_KEY,
          PRO_PRESENCE_AUTHORITY_KEY,
          PRO_CHAT_CONTROL_STATE_KEY,
          PRO_BOT_REQUEST_PROOFS_KEY,
          PRO_OWNER_ACCOUNT_DELETION_FENCE_KEY,
        ];
    for (const key of keys) {
      if (key !== PRO_DECOMMISSIONED_KEY && typeof this.state.storage.delete === 'function') {
        await this.state.storage.delete(key);
      }
    }
    if (typeof this.state.storage.deleteAlarm === 'function') {
      await this.state.storage.deleteAlarm();
    }
    return json({
      ok: true,
      roomCode: value.roomCode,
      ...proRoomGenerationWireFields(roomGeneration),
      status: 'decommissioned',
      changed,
    });
  }

  private async handleInternalOwnerAccountDeletedFence(request: Request): Promise<Response> {
    const value = await readBoundedJson(request, INTERNAL_ADMIN_BODY_MAX_BYTES);
    const roomGeneration = internalProRoomGeneration(request, value);
    if (!isRecord(value)) return json({ error: 'INVALID_REQUEST' }, 400);
    const keys = Object.keys(value).sort();
    const legacyKeys =
      keys.length >= 1 &&
      keys.length <= 2 &&
      keys.includes('roomCode') &&
      keys.every((key) => key === 'roomCode' || key === 'roomGeneration');
    const exactRequiredKeys = [
      'fencedCoordinatorEpoch',
      'removalId',
      'removedOwnerAuthorityEpoch',
      'roomCode',
    ];
    const exactKeys =
      keys.length >= exactRequiredKeys.length &&
      keys.length <= exactRequiredKeys.length + 1 &&
      exactRequiredKeys.every((key) => keys.includes(key)) &&
      keys.every((key) => exactRequiredKeys.includes(key) || key === 'roomGeneration');
    if (
      (!legacyKeys && !exactKeys) ||
      !isProNamespaceRoomCode(value.roomCode) ||
      request.headers.get('x-mxqr-pro-room-code') !== value.roomCode ||
      roomGeneration === null
    ) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }
    const roomCode = value.roomCode;
    const meta = await this.loadProRoomMeta();
    if (meta && (meta.roomId !== roomCode || meta.roomGeneration !== roomGeneration)) {
      return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
    }
    const existing = await this.loadProOwnerAccountDeletionFence();
    if (
      existing &&
      (existing.roomCode !== roomCode || existing.roomGeneration !== roomGeneration)
    ) {
      return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
    }
    if (legacyKeys) {
      // Rolling deploy compatibility: an older App Worker knows only the
      // room/generation contract. Preserve its fail-closed behavior without
      // pretending that it proved a specific PRO removal. A later exact
      // request can atomically upgrade this v1 fence; same-epoch authority can
      // never clear it in the meantime.
      const changed = !existing;
      const fence =
        existing ||
        normalizeProOwnerAccountDeletionFence({
          v: 1,
          roomCode,
          roomGeneration,
          fencedCoordinatorEpoch: meta?.coordinatorEpoch || 0,
          installedAtMs: Date.now(),
        });
      if (!fence) return json({ error: 'PRO_SIGNALING_ROOM_STATE_UNAVAILABLE' }, 503);
      if (changed) {
        // Publish the in-isolate fence before yielding to storage. A frame
        // racing this write observes the fence synchronously; persistence keeps
        // the same denial across hibernation and deployments.
        this.proOwnerAccountDeletionFence = fence;
        for (const socket of typeof this.state.getWebSockets === 'function'
          ? this.state.getWebSockets()
          : []) {
          const attachment = readAttachment(socket);
          if (attachment?.roomKind !== 'pro') continue;
          closeSocket(socket, 1008, 'PRO_OWNER_ACCOUNT_DELETED');
        }
        this.proMembers.clear();
        this.proSocketsValidated = true;
        await this.state.storage.put(
          PRO_OWNER_ACCOUNT_DELETION_FENCE_KEY,
          persistedProGenerationRecord(fence, roomGeneration),
        );
      }
      return json({
        ok: true,
        roomCode,
        ...proRoomGenerationWireFields(roomGeneration),
        status: 'suspended',
        reason: 'owner_account_deleted',
        changed,
      });
    }

    if (
      !exactKeys ||
      typeof value.removalId !== 'string' ||
      !OWNER_AUTHORITY_REMOVAL_ID_RE.test(value.removalId) ||
      !isSafeInteger(value.removedOwnerAuthorityEpoch) ||
      value.removedOwnerAuthorityEpoch < 0 ||
      !isValidProEpoch(value.fencedCoordinatorEpoch)
    ) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }
    const exactValue = {
      roomCode,
      removalId: value.removalId,
      removedOwnerAuthorityEpoch: value.removedOwnerAuthorityEpoch,
      fencedCoordinatorEpoch: value.fencedCoordinatorEpoch,
    };

    const requestedCoordinatorEpoch = exactValue.fencedCoordinatorEpoch;
    const observedCoordinatorEpoch = meta?.coordinatorEpoch || 0;
    const effectiveCoordinatorEpoch = Math.max(
      observedCoordinatorEpoch,
      existing?.fencedCoordinatorEpoch || 0,
    );
    const exactResponse = (
      fenceStatus: 'stale' | 'installed',
      changed: boolean,
      effectiveEpoch: number,
    ): Response =>
      json({
        ok: true,
        roomCode: exactValue.roomCode,
        ...proRoomGenerationWireFields(roomGeneration),
        status: 'suspended',
        reason: 'owner_account_deleted',
        fenceStatus,
        changed,
        removalId: exactValue.removalId,
        removedOwnerAuthorityEpoch: exactValue.removedOwnerAuthorityEpoch,
        fencedCoordinatorEpoch: requestedCoordinatorEpoch,
        effectiveCoordinatorEpoch: effectiveEpoch,
      });

    // The signaling DO serializes this handler with admission and authoritative
    // broadcasts. A strictly newer observed authority (or an already newer
    // durable deletion fence) proves this removal request is stale, so it must
    // not close the newer owner's sockets or overwrite the newer fence.
    if (effectiveCoordinatorEpoch > requestedCoordinatorEpoch) {
      return exactResponse('stale', false, effectiveCoordinatorEpoch);
    }
    const exactExisting =
      existing?.v === 2 &&
      existing.removalId === exactValue.removalId &&
      existing.removedOwnerAuthorityEpoch === exactValue.removedOwnerAuthorityEpoch &&
      existing.fencedCoordinatorEpoch === requestedCoordinatorEpoch;
    if (exactExisting) {
      return exactResponse('installed', false, requestedCoordinatorEpoch);
    }
    if (existing?.v === 2 && existing.fencedCoordinatorEpoch === requestedCoordinatorEpoch) {
      return json({ error: 'PRO_OWNER_ACCOUNT_DELETION_FENCE_CONFLICT' }, 409);
    }

    // No fence, an older fence, or a rollout-era v1 fence can be upgraded only
    // to the exact PRO-authoritative removal tuple. Never derive the boundary
    // from signaling's mutable current metadata.
    const fence = normalizeProOwnerAccountDeletionFence({
      v: 2,
      roomCode: exactValue.roomCode,
      roomGeneration,
      removalId: exactValue.removalId,
      removedOwnerAuthorityEpoch: exactValue.removedOwnerAuthorityEpoch,
      fencedCoordinatorEpoch: requestedCoordinatorEpoch,
      installedAtMs: Date.now(),
    });
    if (!fence) return json({ error: 'PRO_SIGNALING_ROOM_STATE_UNAVAILABLE' }, 503);
    // Publish the in-isolate fence before yielding to storage. A frame racing
    // this write observes the fence synchronously; persistence keeps the same
    // denial across hibernation and deployments.
    this.proOwnerAccountDeletionFence = fence;
    for (const socket of typeof this.state.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : []) {
      const attachment = readAttachment(socket);
      if (attachment?.roomKind !== 'pro') continue;
      closeSocket(socket, 1008, 'PRO_OWNER_ACCOUNT_DELETED');
    }
    this.proMembers.clear();
    this.proSocketsValidated = true;
    await this.state.storage.put(
      PRO_OWNER_ACCOUNT_DELETION_FENCE_KEY,
      persistedProGenerationRecord(fence, roomGeneration),
    );
    return exactResponse('installed', true, requestedCoordinatorEpoch);
  }

  private async handleInternalProRealtimeBroadcast(request: Request): Promise<Response> {
    const value = await readBoundedJson(request, PRO_REALTIME_BODY_MAX_BYTES);
    const targets = normalizeProBroadcastTargets(isRecord(value) ? value.targets : undefined);
    const event = normalizeProServerEvent(isRecord(value) ? value.event : undefined);
    const roomGeneration = internalProRoomGeneration(request, value);
    if (
      !hasExactKeys(
        value,
        ['roomCode', 'coordinatorEpoch', 'targets', 'event'],
        ['roomGeneration'],
      ) ||
      !isProNamespaceRoomCode(value.roomCode) ||
      roomGeneration === null ||
      (Object.prototype.hasOwnProperty.call(value, 'roomGeneration') &&
        request.headers.get('x-mxqr-pro-room-code') !== value.roomCode) ||
      (request.headers.get('x-mxqr-pro-room-code') !== null &&
        request.headers.get('x-mxqr-pro-room-code') !== value.roomCode) ||
      !isValidProEpoch(value.coordinatorEpoch) ||
      !targets ||
      !event
    ) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }

    let ownerAccountDeletionFence;
    try {
      ownerAccountDeletionFence = await this.loadProOwnerAccountDeletionFence();
    } catch {
      return json({ error: 'PRO_SIGNALING_ROOM_STATE_UNAVAILABLE' }, 503);
    }
    const restoresOwnerAuthority =
      ownerAccountDeletionFence &&
      event.type === 'pro-presence-snapshot' &&
      targets.length > 0 &&
      value.coordinatorEpoch > ownerAccountDeletionFence.fencedCoordinatorEpoch;
    await this.validateRehydratedProSockets(roomGeneration);
    let meta = await this.loadProRoomMeta();
    if (meta && (meta.roomId !== value.roomCode || meta.roomGeneration !== roomGeneration)) {
      return json({ error: 'PRO_ROOM_EPOCH_STALE' }, 409);
    }
    if (!meta || value.coordinatorEpoch > meta.coordinatorEpoch) {
      // The room state service can publish the first authoritative presence
      // set before any browser requests a signaling ticket. It also advances
      // the room fence on sleep, PIN rotation, or suspension. A presence
      // snapshot is the only server event allowed to initialize/advance this
      // namespace; all other future-epoch events fail closed.
      if (event.type !== 'pro-presence-snapshot') {
        return json({ error: 'PRO_ROOM_EPOCH_STALE' }, 409);
      }
      meta = await this.resetProRoomEpoch(value.roomCode, roomGeneration, value.coordinatorEpoch);
    }
    if (value.coordinatorEpoch < meta.coordinatorEpoch) {
      return json({ error: 'PRO_ROOM_EPOCH_STALE' }, 409);
    }

    if (event.type === 'pro-presence-snapshot') {
      if (!isSafeInteger(event.presenceRevision)) {
        return json({ error: 'INVALID_REQUEST' }, 400);
      }
      const authorityResult = await this.advanceProPresenceAuthority(
        value.roomCode,
        roomGeneration,
        value.coordinatorEpoch,
        event.presenceRevision,
        targets,
      );
      if (authorityResult === 'stale') {
        return json({ error: 'PRO_PRESENCE_REVISION_STALE' }, 409);
      }
      if (authorityResult === 'conflict') {
        return json({ error: 'PRO_PRESENCE_REVISION_CONFLICT' }, 409);
      }
      await this.pruneProChatMutedParticipants(
        value.roomCode,
        roomGeneration,
        value.coordinatorEpoch,
        targets,
      );
      if (restoresOwnerAuthority) {
        // Clear only after the exact room/generation/epoch snapshot has passed
        // the monotonic presence-authority checks. A stale or conflicting
        // cross-worker delivery can therefore never reopen admission.
        await this.state.storage.delete(PRO_OWNER_ACCOUNT_DELETION_FENCE_KEY);
        this.proOwnerAccountDeletionFence = null;
      }
    }

    const targetSet = new Set(targets);
    const frame = {
      type: 'pro-server-event',
      version: 1,
      roomCode: value.roomCode,
      roomGeneration,
      coordinatorEpoch: value.coordinatorEpoch,
      event,
    };
    let eligible = 0;
    let sentCount = 0;
    for (const [participantId, socket] of this.proMembers) {
      const attachment = readAttachment(socket);
      const isInvalidRoomMember =
        attachment?.roomKind !== 'pro' ||
        attachment.role !== 'member' ||
        attachment.auth !== 'ok' ||
        attachment.roomId !== value.roomCode ||
        attachment.roomGeneration !== roomGeneration ||
        attachment.coordinatorEpoch !== value.coordinatorEpoch ||
        attachment.participantId !== participantId ||
        this.proMembers.get(participantId) !== socket;
      if (isInvalidRoomMember) {
        continue;
      }
      if (!targetSet.has(attachment.presenceIncarnationId)) {
        // A presence snapshot is the Durable Object's authoritative live-set,
        // not merely a broadcast audience. Revoke sockets removed by a kick,
        // TTL expiry, explicit leave, or same-participant tab takeover so a
        // stale authenticated connection cannot keep relaying chat until its
        // browser happens to close it. Other event types intentionally target
        // subsets (for example a PREPARE cohort) and must never prune here.
        if (event.type === 'pro-presence-snapshot') {
          this.proMembers.delete(participantId);
          closeSocket(socket, 1008, 'PRO_PRESENCE_REVOKED');
        }
        continue;
      }
      eligible += 1;
      if (sendChecked(socket, frame)) sentCount += 1;
    }
    return json({ broadcast: true, eligible, sent: sentCount });
  }

  private async resetProRoomEpoch(
    roomCode: string,
    roomGeneration: number,
    coordinatorEpoch: number,
  ): Promise<ProRoomMeta> {
    if (!isProRoomGeneration(roomGeneration)) {
      throw new Error('INVALID_PRO_ROOM_GENERATION');
    }
    return this.enqueueProChatMutation(async () => {
      for (const socket of typeof this.state.getWebSockets === 'function'
        ? this.state.getWebSockets()
        : []) {
        const attachment = readAttachment(socket);
        if (attachment?.roomKind === 'pro') {
          closeSocket(socket, 1012, 'PRO_ROOM_EPOCH_ADVANCED');
        }
      }
      this.proMembers.clear();
      this.proSocketsValidated = true;
      const nextMeta = normalizeProRoomMeta({
        v: 2,
        kind: 'pro',
        roomId: roomCode,
        roomGeneration,
        coordinatorEpoch,
      });
      if (!nextMeta) throw new Error('INVALID_PRO_ROOM_META');
      if (typeof this.state.storage.transaction === 'function') {
        await this.state.storage.transaction(async (transaction) => {
          await transaction.put(
            PRO_ROOM_META_KEY,
            persistedProGenerationRecord(nextMeta, roomGeneration),
          );
          await transaction.delete(PRO_CHAT_CONTROL_STATE_KEY);
          await transaction.delete(PRO_BOT_REQUEST_PROOFS_KEY);
        });
      } else {
        await this.state.storage.put(
          PRO_ROOM_META_KEY,
          persistedProGenerationRecord(nextMeta, roomGeneration),
        );
        await this.state.storage.delete(PRO_CHAT_CONTROL_STATE_KEY);
        await this.state.storage.delete(PRO_BOT_REQUEST_PROOFS_KEY);
      }
      this.proRoomMeta = nextMeta;
      this.proChatControlState = defaultProChatControlState(
        roomCode,
        roomGeneration,
        coordinatorEpoch,
      );
      this.proBotRequestProofs = defaultProBotRequestProofs(
        roomCode,
        roomGeneration,
        coordinatorEpoch,
      );
      return nextMeta;
    });
  }

  private async resetForProEpoch(ticket: ProSignalingTicket): Promise<ProRoomMeta> {
    return this.resetProRoomEpoch(ticket.roomCode, ticket.roomGeneration, ticket.coordinatorEpoch);
  }

  private async acceptProMember(ws: SocketPort, ticket: ProSignalingTicket): Promise<void> {
    let meta = await this.loadProRoomMeta();
    if (
      meta &&
      (meta.roomId !== ticket.roomCode || meta.roomGeneration !== ticket.roomGeneration)
    ) {
      this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:room-mismatch']);
      closeWithError(ws, 'invalid-id', 'PRO_ROOM_GENERATION_MISMATCH', 1008);
      return;
    }
    if (meta && ticket.coordinatorEpoch < meta.coordinatorEpoch) {
      this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:stale-epoch']);
      closeWithError(ws, 'peer-unavailable', 'PRO_COORDINATOR_EPOCH_STALE', 1008);
      return;
    }

    if (!meta || ticket.coordinatorEpoch > meta.coordinatorEpoch) {
      meta = await this.resetForProEpoch(ticket);
    }

    if (
      !meta ||
      meta.roomId !== ticket.roomCode ||
      meta.roomGeneration !== ticket.roomGeneration ||
      meta.coordinatorEpoch !== ticket.coordinatorEpoch
    ) {
      this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:stale-epoch']);
      closeWithError(ws, 'peer-unavailable', 'PRO_COORDINATOR_EPOCH_STALE', 1008);
      return;
    }

    if (
      !this.proMembers.has(ticket.participantId) &&
      this.proMembers.size >= MAX_PRO_ROOM_MEMBERS
    ) {
      this.acceptSocket(ws, null, ['kind:pro', 'role:member', 'rejected:room-full']);
      closeWithError(ws, 'room-full', 'ROOM_MEMBER_LIMIT_REACHED', 1008);
      this.recordMetric('pro_room_full');
      return;
    }

    const previous = this.proMembers.get(ticket.participantId);
    const previousAttachment = readAttachment(previous);
    if (previous && previous !== ws) closeSocket(previous, 1012, 'PRO_MEMBER_REPLACED');
    const attachment: ProSocketAttachment = {
      v: ATTACHMENT_VERSION,
      roomKind: 'pro',
      role: 'member',
      roomId: ticket.roomCode,
      roomGeneration: ticket.roomGeneration,
      peerId: ticket.participantId,
      participantId: ticket.participantId,
      ...(ticket.memberId ? { memberId: ticket.memberId } : {}),
      displayName: ticket.displayName,
      coordinatorEpoch: ticket.coordinatorEpoch,
      presenceRevision: ticket.presenceRevision,
      ticketJti: ticket.jti,
      presenceIncarnationId: ticket.presenceIncarnationId,
      ticketSequence: ticket.ticketSequence,
      auth: 'ok',
      ...(isFiniteNumber(previousAttachment?.realtimeMessageTokens) &&
      isFiniteNumber(previousAttachment?.realtimeMessageUpdatedAt)
        ? {
            realtimeMessageTokens: previousAttachment.realtimeMessageTokens,
            realtimeMessageUpdatedAt: previousAttachment.realtimeMessageUpdatedAt,
          }
        : {}),
      ...(isFiniteNumber(previousAttachment?.chatLastMessageAtMs)
        ? { chatLastMessageAtMs: previousAttachment.chatLastMessageAtMs }
        : {}),
    };
    this.acceptSocket(ws, attachment, [
      'kind:pro',
      'role:member',
      `peer:${ticket.participantId}`,
      `generation:${ticket.roomGeneration}`,
      `epoch:${ticket.coordinatorEpoch}`,
    ]);
    this.proMembers.set(ticket.participantId, ws);
    this.recordMetric('pro_member_joined');
    send(ws, {
      type: 'peer-open',
      peerId: ticket.participantId,
      roomId: ticket.roomCode,
      roomGeneration: ticket.roomGeneration,
      ...workerVersionFields(this.env),
    });
    await this.enqueueProChatMutation(async () => {
      let currentAttachment = this.currentProRealtimeAttachment(ws, attachment);
      if (!currentAttachment) return;
      const chatState = await this.loadProChatControlState(
        ticket.roomCode,
        ticket.coordinatorEpoch,
      );
      // Loading durable state yields. Revalidate so a same-participant
      // replacement cannot receive a snapshot intended for its predecessor.
      currentAttachment = this.currentProRealtimeAttachment(ws, currentAttachment);
      if (currentAttachment) this.sendProChatControlSnapshot(ws, currentAttachment, chatState);
    });
  }

  private acceptPendingHost(ws: SocketPort, roomId: string, peerId: string): void {
    if (!this.reservePendingHostSlot()) {
      this.acceptSocket(ws, null, ['role:host', 'rejected:pending-capacity']);
      closeWithError(ws, 'room-full', 'HOST_PENDING_LIMIT_REACHED', 1008);
      return;
    }

    const attachment: StandardHostPendingAttachment = {
      v: ATTACHMENT_VERSION,
      role: 'host',
      roomId,
      peerId,
      auth: 'pending',
      authDeadline: Date.now() + HOST_AUTH_TIMEOUT_MS,
    };
    this.acceptSocket(ws, attachment, ['role:host', `peer:${peerId}`, 'auth:pending']);
    this.pendingHosts.add(ws);
    this.requestMaintenanceAlarm();
  }

  private reservePendingHostSlot(): boolean {
    if (this.pendingHosts.size < MAX_PENDING_HOST_SOCKETS) return true;
    for (const pending of this.pendingHosts) {
      const attachment = readAttachment(pending);
      if (attachment?.auth !== 'pending' || attachment.authStarted) continue;
      this.pendingHosts.delete(pending);
      closeSocket(pending, 1013, 'HOST_AUTH_CANDIDATE_REPLACED');
      this.requestMaintenanceAlarm();
      return true;
    }
    return false;
  }

  private async completeHostAccept(
    ws: SocketPort,
    roomId: string,
    peerId: string,
    secret: unknown,
    accountAssertion: unknown = '',
    desiredRoomPassword: unknown = undefined,
    pinMutationId: unknown = undefined,
  ): Promise<boolean> {
    // The caller owns standardAdmissionSync. Expire the previous epoch in the
    // same queue before reading the ownership snapshot used by this claim.
    const meta = await this.clearExpiredHostRelease();
    if (isQuarantinedRoomMeta(meta)) {
      this.pendingHosts.delete(ws);
      closeWithError(ws, 'room-state-invalid', 'ROOM_STATE_INVALID');
      this.requestMaintenanceAlarm();
      return false;
    }
    if (typeof secret !== 'string' || !secret) {
      this.pendingHosts.delete(ws);
      closeWithError(ws, 'invalid-id', 'MISSING_ROOM_SECRET');
      this.requestMaintenanceAlarm();
      return false;
    }
    if (meta.roomSecret && meta.roomSecret !== secret) {
      this.pendingHosts.delete(ws);
      closeWithError(ws, 'id-taken', 'ROOM_ALREADY_ACTIVE');
      this.requestMaintenanceAlarm();
      return false;
    }

    const ownsPinMutation =
      typeof desiredRoomPassword === 'string' &&
      (desiredRoomPassword === '' || /^\d{8}$/.test(desiredRoomPassword)) &&
      typeof pinMutationId === 'string' &&
      /^[A-Za-z0-9_-]{16,64}$/.test(pinMutationId);
    const previousPinMutationFence = this.standardRoomPinMutationFence;
    const previousPinMutationFenceOwner = this.standardRoomPinMutationFenceOwner;

    let desiredVerifier: StandardRoomPinVerifier | null = null;
    if (ownsPinMutation && desiredRoomPassword !== '') {
      desiredVerifier = await createStandardRoomPinVerifier(
        this.env,
        roomId,
        secret,
        desiredRoomPassword,
      );
      if (!desiredVerifier) {
        this.rejectPendingStandardRoomPinMutation(
          ws,
          pinMutationId,
          previousPinMutationFence,
          previousPinMutationFenceOwner,
          'STANDARD_ROOM_PIN_PEPPER_UNAVAILABLE',
        );
        return false;
      }
    }

    const isNewRoom = !meta.roomSecret;
    let identity: StandardRoomIdentity | null = null;
    let attachment: StandardHostOkAttachment;
    this.standardRoomPinMutationFence = ownsPinMutation
      ? pinMutationId
      : `legacy-${crypto.randomUUID()}`;
    this.standardRoomPinMutationFenceOwner = ws;
    try {
      if (isNewRoom) {
        await this.clearGuestBindings();
        await this.clearStandardRoomMembers();
      }
      identity = await this.resolveStandardRoomIdentity(
        accountAssertion,
        roomId,
        peerId,
        'host',
        secret,
      );
      attachment = {
        v: ATTACHMENT_VERSION,
        role: 'host',
        roomId,
        peerId,
        secret,
        auth: 'ok',
        // The host-auth payload is a pre-admission snapshot. Keep every host,
        // including a modern client, fenced until it confirms its latest local
        // PIN after peer-open. This closes the cross-socket race where the user
        // changes the PIN while the durable host-auth commit is still in flight.
        pinConfigurationPending: true,
        ...standardRoomIdentityAttachmentFields(identity),
      };
      // Persist the authenticated owner before replacing the live host. Every
      // await after installing the candidate fence belongs to this boundary;
      // any assertion/directory/storage failure restores the prior live room.
      const ownedMeta = {
        ...meta,
        roomSecret: secret,
        hostPeerId: peerId,
        hostReleaseAt: 0,
      } satisfies RoomMeta;
      const committedMeta = ownsPinMutation
        ? currentRoomMeta(ownedMeta, desiredVerifier)
        : ownedMeta;
      await this.saveRoomMeta(committedMeta);
    } catch (error) {
      this.rejectPendingStandardRoomPinMutation(
        ws,
        ownsPinMutation ? pinMutationId : null,
        previousPinMutationFence,
        previousPinMutationFenceOwner,
        'ROOM_PASSWORD_STORAGE_UNAVAILABLE',
      );
      throw error;
    }
    serializeSocketAttachment(ws, attachment);

    // A socket can close while the Durable Object storage write is awaited.
    // Prove the accepted candidate is still reachable before replacing the
    // live host; otherwise restore the prior metadata inside the same queue.
    if (
      !this.pendingHosts.has(ws) ||
      !sendChecked(ws, {
        type: 'peer-open',
        peerId: roomId,
        roomId,
        ...(identity
          ? { memberIdentity: standardRoomMemberIdentityFromAttachment(attachment) }
          : {}),
        ...remoteShareUploadAssertionFeatureFields(this.env),
        ...workerVersionFields(this.env),
        ...(ownsPinMutation
          ? { roomPasswordMutationId: pinMutationId, roomPasswordApplied: true }
          : {}),
      })
    ) {
      this.pendingHosts.delete(ws);
      try {
        await this.saveRoomMeta(meta);
      } catch (rollbackError) {
        this.failStandardRoomPinMutation(
          ws,
          ownsPinMutation ? pinMutationId : null,
          'HOST_AUTH_ROLLBACK_UNAVAILABLE',
        );
        throw rollbackError;
      }
      this.rejectPendingStandardRoomPinMutation(
        ws,
        ownsPinMutation ? pinMutationId : null,
        previousPinMutationFence,
        previousPinMutationFenceOwner,
        'HOST_AUTH_SOCKET_CLOSED',
        'HOST_AUTH_SOCKET_CLOSED',
      );
      return false;
    }

    this.pendingHosts.delete(ws);
    const previous = this.host;
    this.host = ws;
    this.hostPeerId = peerId;
    // Do not clear the guest-admission fence here. The client must echo its
    // current mutation after peer-open, so a newer local PIN always supersedes
    // the snapshot captured by host-auth before any guest can enter.
    if (previous && previous !== ws) closeSocket(previous, 1012, 'HOST_REPLACED');
    this.requestMaintenanceAlarm();
    this.recordMetric(isNewRoom ? 'room_opened' : 'host_reconnected');
    return true;
  }

  private async acceptGuest(ws: SocketPort, roomId: string, peerId: string): Promise<void> {
    const meta = await this.loadRoomMeta();
    if (this.standardRoomPinMutationFence) {
      this.acceptSocket(ws, null, ['role:guest', 'rejected:pin-mutation']);
      closeWithError(ws, 'service-unavailable', 'ROOM_PASSWORD_MUTATION_PENDING', 1013);
      return;
    }
    if (!this.host) {
      this.acceptSocket(ws, null, ['role:guest']);
      this.recordMetric('guest_host_unavailable');
      closeWithError(ws, 'peer-unavailable', 'HOST_NOT_AVAILABLE');
      return;
    }

    const admitted = this.admittedGuestIds();
    if (!admitted.has(peerId) && admitted.size >= MAX_ROOM_GUESTS) {
      this.acceptSocket(ws, null, ['role:guest', 'rejected:room-full']);
      closeWithError(ws, 'room-full', 'ROOM_GUEST_LIMIT_REACHED', 1008);
      this.recordMetric('guest_room_full');
      return;
    }
    if (!this.reservePendingGuestSlot()) {
      this.acceptSocket(ws, null, ['role:guest', 'rejected:pending-capacity']);
      closeWithError(ws, 'room-full', 'ROOM_PENDING_LIMIT_REACHED', 1008);
      this.recordMetric('guest_pending_capacity');
      return;
    }

    // Every guest authenticates its reconnect secret over the WebSocket frame,
    // never in the URL. The current client sends guest-auth for passwordless
    // rooms too, so this adds no user-visible round trip.
    this.acceptPendingGuest(ws, roomId, peerId);
    if (hasStandardRoomPassword(meta)) this.recordMetric('guest_auth_pending');
  }

  private reservePendingGuestSlot(): boolean {
    if (this.pendingGuests.size < MAX_PENDING_GUEST_SOCKETS) return true;

    // Give every new connection one bounded chance to present its first auth
    // frame. Rotate the oldest *silent* candidate, but never a socket whose
    // validated guest-auth frame is already serialized in the admission queue.
    // This keeps the pending set bounded while preventing 99 silent sockets
    // from starving a legitimate join or reconnect for the full 10 seconds.
    for (const pending of this.pendingGuests) {
      const attachment = readAttachment(pending);
      if (attachment?.auth !== 'pending' || attachment.authStarted) continue;
      this.pendingGuests.delete(pending);
      closeSocket(pending, 1013, 'PENDING_GUEST_SLOT_ROTATED');
      this.requestMaintenanceAlarm();
      return true;
    }
    return false;
  }

  private acceptPendingGuest(ws: SocketPort, roomId: string, peerId: string): void {
    const attachment: StandardGuestPendingAttachment = {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId,
      peerId,
      auth: 'pending',
      authDeadline: Date.now() + GUEST_AUTH_TIMEOUT_MS,
    };
    this.acceptSocket(ws, attachment, ['role:guest', `peer:${peerId}`, 'auth:pending']);
    this.pendingGuests.add(ws);
    this.scheduleAuthSweep();
  }

  // Active sweep for unauthenticated pending guests. handleGuestAuth (on a guest
  // message) and indexSocket (on hibernation wake) already close expired pending
  // sockets, but a guest that connects and then stays silent triggers neither ??  // its socket would linger until something else wakes the DO. Schedule a DO
  // alarm at the earliest pending authDeadline so the slot is reclaimed even with
  // no further traffic. The shared scheduler also preserves the host-release
  // deadline because Durable Objects expose one alarm per object.
  private scheduleAuthSweep(): void {
    this.requestMaintenanceAlarm();
  }

  private async reconcileStandardRoomClosuresDuringMaintenance(now = Date.now()): Promise<void> {
    await this.loadRoomMeta();
    if (this.futureRoomMetaVersion) return;
    let cleanupError: unknown = null;
    try {
      // Maintenance blocks new authority and mutable room work, but a close is
      // a revocation boundary. Let an already-recorded host release expire so
      // stale guests and room ownership cannot survive a prolonged outage of
      // the control plane itself.
      await this.enqueueStandardAdmission(() => this.clearExpiredHostRelease());
    } catch (error) {
      cleanupError = error;
    }

    let alarmError: unknown = null;
    if (typeof this.state.storage.setAlarm === 'function') {
      const retryAt = now + 60_000;
      const hostReleaseAt = !this.host ? this.roomMeta?.hostReleaseAt : 0;
      const alarmAt =
        isFiniteNumber(hostReleaseAt) && hostReleaseAt > now
          ? Math.min(hostReleaseAt, retryAt)
          : retryAt;
      try {
        await this.state.storage.setAlarm(alarmAt);
      } catch (error) {
        alarmError = error;
      }
    }

    if (cleanupError && alarmError) {
      throw new AggregateError(
        [cleanupError, alarmError],
        'Failed to reconcile standard-room closures during maintenance',
      );
    }
    if (cleanupError) throw cleanupError;
    if (alarmError) throw alarmError;
  }

  async alarm(): Promise<void> {
    if (this.standardHttpBridgeOnly) {
      await this.cleanupStandardHttpBridgeLease();
      return;
    }
    if (this.standardRateOnly) {
      await this.cleanupStandardWsOpenRate();
      return;
    }
    if ((await readServiceMaintenance(this.env)).enabled) {
      await this.reconcileStandardRoomClosuresDuringMaintenance();
      return;
    }
    const now = Date.now();
    let futureRoomMetaVersion = false;
    await this.enqueueStandardAdmission(async () => {
      await this.loadRoomMeta();
      if (this.futureRoomMetaVersion) {
        futureRoomMetaVersion = true;
        return;
      }
      for (const sock of [...this.pendingHosts]) {
        const att = readAttachment(sock);
        if (typeof att?.authDeadline === 'number' && now > att.authDeadline) {
          this.pendingHosts.delete(sock);
          closeSocket(sock, 1011, 'host auth timeout (sweep)');
        }
      }
      for (const sock of [...this.pendingGuests]) {
        const att = readAttachment(sock);
        if (typeof att?.authDeadline === 'number' && now > att.authDeadline) {
          this.pendingGuests.delete(sock);
          this.recordMetric('guest_auth_timeout', now);
          try {
            sock.close(1011, 'auth timeout (sweep)');
          } catch {
            /* already closed */
          }
        }
      }
      for (const sock of [this.host, ...this.guests.values()]) {
        if (!sock) continue;
        const attachment = readAttachment(sock);
        if (
          attachment?.auth === 'ok' &&
          isSafeInteger(attachment.identityExpiresAt) &&
          now >= attachment.identityExpiresAt
        ) {
          await this.applyStandardRoomIdentity(sock, null, 'expired');
        }
      }
      // The same alarm also expires host metadata after reconnect grace.
      await this.clearExpiredHostRelease();
      const bindings = await this.loadGuestBindings();
      if (!this.guestBindingsInvalid) {
        const prunedBindings = this.pruneGuestBindings(bindings, now);
        if (prunedBindings.entries.length !== bindings.entries.length) {
          await this.saveGuestBindings(prunedBindings);
        }
      }
    });
    if (futureRoomMetaVersion) return;
    await this.enqueueProChatMutation(async () => {
      const meta = await this.loadProRoomMeta();
      if (meta) {
        await this.pruneExpiredProBotRequests(meta.roomId, meta.coordinatorEpoch, now);
      }
    });
    await this.scheduleMaintenanceAlarm();
  }

  private async completeGuestAccept(
    ws: SocketPort,
    roomId: string,
    peerId: string,
    identity: StandardRoomIdentity | null = null,
  ): Promise<void> {
    const previous = this.guests.get(peerId);
    const currentAttachment = readAttachment(ws);
    const previousAttachment = readAttachment(previous);
    const bucketAttachment = isFiniteNumber(previousAttachment?.guestMessageTokens)
      ? previousAttachment
      : currentAttachment;
    if (previous && previous !== ws) {
      closeSocket(previous, 1012, 'GUEST_REPLACED');
    }
    for (const pending of [...this.pendingGuests]) {
      if (pending === ws) continue;
      const pendingAttachment = readAttachment(pending);
      if (pendingAttachment?.peerId !== peerId) continue;
      this.pendingGuests.delete(pending);
      closeSocket(pending, 1012, 'GUEST_REPLACED');
    }

    const attachment: StandardGuestOkAttachment = {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId,
      peerId,
      auth: 'ok',
      ...standardRoomIdentityAttachmentFields(identity),
      ...(isFiniteNumber(bucketAttachment?.guestMessageTokens) &&
      isFiniteNumber(bucketAttachment?.guestMessageUpdatedAt)
        ? {
            guestMessageTokens: bucketAttachment.guestMessageTokens,
            guestMessageUpdatedAt: bucketAttachment.guestMessageUpdatedAt,
          }
        : {}),
    };
    serializeSocketAttachment(ws, attachment);

    this.pendingGuests.delete(ws);
    this.guests.set(peerId, ws);
    this.requestMaintenanceAlarm();
    this.recordMetric('guest_joined');
    send(ws, {
      type: 'peer-open',
      peerId,
      roomId,
      ...(identity ? { memberIdentity: standardRoomMemberIdentityFromAttachment(attachment) } : {}),
      ...workerVersionFields(this.env),
    });
    if (identity) await this.scheduleMaintenanceAlarm();
  }

  private notifyStandardRoomIdentity(
    ws: SocketPort,
    attachment: StandardHostOkAttachment | StandardGuestOkAttachment,
    clearReason?: string,
  ): void {
    const memberIdentity = standardRoomMemberIdentityFromAttachment(attachment);
    sendChecked(ws, {
      type: 'account-identity',
      memberIdentity,
      ...(memberIdentity === null && clearReason ? { clearReason } : {}),
    });
    if (attachment.role === 'guest' && this.host) {
      sendChecked(this.host, {
        type: 'account-member-updated',
        peerId: attachment.peerId,
        memberIdentity,
        ...(memberIdentity === null && clearReason ? { clearReason } : {}),
      });
    }
  }

  private async applyStandardRoomIdentity(
    ws: SocketPort,
    identity: StandardRoomIdentity | null,
    clearReason?: string,
  ): Promise<boolean> {
    // Identity verification, expiry, and alarm work all await. Always merge
    // into the live attachment at commit time so an ordinary guest frame that
    // refreshed its hibernation-safe rate bucket cannot be overwritten by an
    // older snapshot.
    const attachment = this.currentStandardRoomAttachment(ws);
    if (!attachment) return false;
    const next: StandardHostOkAttachment | StandardGuestOkAttachment = {
      ...withoutStandardRoomIdentity(attachment),
      ...standardRoomIdentityAttachmentFields(identity),
    };
    serializeSocketAttachment(ws, next);
    this.notifyStandardRoomIdentity(ws, next, clearReason);

    // Nickname and member number belong to the account member, not one tab.
    // Update every other live device with the same room-scoped subject while
    // preserving each device's independently expiring assertion lease.
    if (identity) {
      const peers = [this.host, ...this.guests.values()];
      for (const peerSocket of peers) {
        if (!peerSocket) continue;
        if (peerSocket === ws) continue;
        const peerAttachment = readAttachment(peerSocket);
        if (
          peerAttachment?.roomKind === 'pro' ||
          peerAttachment?.auth !== 'ok' ||
          peerAttachment.accountSubject !== identity.accountSubject
        ) {
          continue;
        }
        const updated = {
          ...peerAttachment,
          memberId: identity.memberId,
          memberDisplayNumber: identity.memberDisplayNumber,
          memberNickname: identity.nickname,
        };
        serializeSocketAttachment(peerSocket, updated);
        this.notifyStandardRoomIdentity(peerSocket, updated);
      }
    }
    await this.scheduleMaintenanceAlarm();
    return true;
  }

  private async handleStandardRoomIdentityMutation(
    ws: SocketPort,
    message: JsonRecord,
  ): Promise<void> {
    // The caller owns standardAdmissionSync. Re-read only after acquiring it:
    // the socket may have been replaced, closed, or promoted while this frame
    // waited behind admission work.
    const attachment = this.currentStandardRoomAttachment(ws);
    if (!attachment) return;
    if (message.type === 'account-identity-delete') {
      const meta = await this.loadRoomMeta();
      if (!meta.roomSecret) return;
      const deletion = await this.resolveStandardRoomIdentityDeletion(
        message.deletionAssertion,
        attachment.roomId,
        attachment.peerId,
        attachment.role === 'host' ? 'host' : 'guest',
        meta.roomSecret,
      );
      // Deletion authority is never inferred from a live attachment and a
      // normal attach assertion can never pass this verifier.
      if (!deletion) return;
      if (!this.currentStandardRoomAttachment(ws)) return;
      const accountSubject = deletion.accountSubject;
      let deletedMemberId: string | undefined = deletion.memberId;
      const directory = await this.loadStandardRoomMembers();
      const directoryEntry = directory.entries.find(
        (entry) => entry.accountSubject === accountSubject,
      );
      if (!/^member_[A-Za-z0-9_-]{22}$/.test(String(deletedMemberId || ''))) {
        deletedMemberId = directoryEntry?.memberId;
      }
      await this.saveStandardRoomMembers({
        v: 1,
        entries: directory.entries.filter((entry) => entry.accountSubject !== accountSubject),
      });
      const peers = [this.host, ...this.guests.values()];
      for (const peerSocket of peers) {
        if (!peerSocket) continue;
        const peerAttachment = readAttachment(peerSocket);
        if (
          peerAttachment?.roomKind === 'pro' ||
          peerAttachment?.auth !== 'ok' ||
          peerAttachment.accountSubject !== accountSubject
        ) {
          continue;
        }
        const cleared = withoutStandardRoomIdentity(peerAttachment);
        serializeSocketAttachment(peerSocket, cleared);
        this.notifyStandardRoomIdentity(peerSocket, cleared, 'deleted');
      }
      if (
        this.host &&
        typeof deletedMemberId === 'string' &&
        /^member_[A-Za-z0-9_-]{22}$/.test(deletedMemberId)
      ) {
        // The room host owns Standard-room grants in RAM. This server-issued
        // pseudonymous event revokes the durable grant even when every
        // physical account lease expired before account deletion completed.
        sendChecked(this.host, {
          type: 'account-member-deleted',
          memberId: deletedMemberId,
        });
      }
      await this.scheduleMaintenanceAlarm();
      return;
    }
    if (message.type === 'account-identity-clear') {
      await this.applyStandardRoomIdentity(ws, null, 'explicit');
      return;
    }
    const meta = await this.loadRoomMeta();
    if (!meta.roomSecret) return;
    const role = attachment.role === 'host' ? 'host' : 'guest';
    const identity = await this.resolveStandardRoomIdentity(
      message.accountAssertion,
      attachment.roomId,
      attachment.peerId,
      role,
      meta.roomSecret,
    );
    if (!identity) return;
    if (!this.currentStandardRoomAttachment(ws)) return;
    await this.applyStandardRoomIdentity(ws, identity);
  }

  webSocketMessage(ws: SocketPort, raw: unknown): Promise<void> {
    if (this.standardHttpBridgeOnly) return Promise.resolve();
    // Production Durable Objects answer this exact frame without waking the
    // object. Keep a fallback for local tests and runtimes without auto-response.
    if (raw === SIGNALING_LIVENESS_PING) {
      try {
        ws.send(SIGNALING_LIVENESS_PONG);
      } catch {
        /* noop */
      }
      return Promise.resolve();
    }
    const attachment = readAttachment(ws);
    const rawBytes = rawMessageByteLength(raw);
    if (rawBytes !== null && rawBytes > WS_MESSAGE_MAX_BYTES) {
      closeWithError(ws, 'message-too-large', 'SIGNALING_MESSAGE_TOO_LARGE', 1009);
      this.defer(this.webSocketClose(ws), 'closed socket cleanup');
      this.recordMetric(
        attachment?.roomKind === 'pro' ? 'pro_realtime_oversized' : 'ws_message_oversized',
      );
      return Promise.resolve();
    }
    if (attachment?.roomKind === 'pro') {
      const pendingIngress = this.proRealtimeIngressDepth.get(ws) ?? 0;
      if (pendingIngress >= PRO_REALTIME_INGRESS_PENDING_LIMIT) {
        closeWithError(ws, 'rate-limited', 'SIGNALING_RATE_LIMITED', 1008);
        this.defer(this.webSocketClose(ws), 'closed socket cleanup');
        this.recordMetric('pro_realtime_rate_limited');
        return Promise.resolve();
      }
      this.proRealtimeIngressDepth.set(ws, pendingIngress + 1);
      return this.processWebSocketMessage(ws, raw).finally(() => {
        const remaining = Math.max(0, (this.proRealtimeIngressDepth.get(ws) ?? 1) - 1);
        if (remaining === 0) this.proRealtimeIngressDepth.delete(ws);
        else this.proRealtimeIngressDepth.set(ws, remaining);
      });
    }
    const ingress = this.classifyStandardOrderedIngress(ws, raw);
    if (ingress) {
      if (ingress.pinConfigurationMutationId) {
        const attachment = this.currentStandardRoomAttachment(ws);
        if (!attachment || attachment.role !== 'host') {
          return this.processWebSocketMessage(ws, raw);
        }
        // Persist the receive-order claim before maintenance, HMAC, or
        // storage can yield. If the isolate restarts anywhere in that span,
        // rehydration closes this host and requires the client to replay its
        // latest desired PIN instead of serving the older durable setting.
        serializeSocketAttachment(ws, {
          ...attachment,
          pinConfigurationPending: true,
          pinConfigurationMutationId: ingress.pinConfigurationMutationId,
        });
        if (
          this.standardRoomPinMutationFence === null ||
          this.standardRoomPinMutationFenceOwner === ws
        ) {
          this.standardRoomPinMutationFence = ingress.pinConfigurationMutationId;
          this.standardRoomPinMutationFenceOwner = ws;
        }
      }
      if (ingress.preclaimedAuth) {
        const attachment = readAttachment(ws);
        if (!attachment || attachment.auth !== 'pending' || attachment.authStarted) {
          return this.processWebSocketMessage(ws, raw);
        }
        // Claim the one permitted first auth frame synchronously. Later frames
        // still pass through maintenance, size, and guest-rate enforcement,
        // but cannot overtake this frame and become the authentication attempt.
        serializeSocketAttachment(ws, { ...attachment, authStarted: true });
      }
      return this.enqueueStandardOrderedIngress(() =>
        this.processWebSocketMessage(ws, raw, ingress),
      );
    }
    return this.processWebSocketMessage(ws, raw);
  }

  private async processWebSocketMessage(
    ws: SocketPort,
    raw: unknown,
    ingress: StandardOrderedIngress = { preclaimedAuth: false },
  ): Promise<void> {
    let attachment = readAttachment(ws);
    if (!attachment) return;

    if (attachment.roomKind === 'pro') {
      if ((await readServiceMaintenance(this.env)).enabled) {
        closeWithError(ws, 'service-maintenance', 'SERVICE_MAINTENANCE', 1012);
        return;
      }
      return this.handleProRealtimeMessage(ws, raw, attachment);
    }

    const isPendingHost = attachment.role === 'host' && attachment.auth === 'pending';
    const isPendingGuest = attachment.role === 'guest' && attachment.auth === 'pending';
    if (!isPendingHost && !isPendingGuest) {
      await this.loadRoomMeta();
      if (this.futureRoomMetaVersion) return;
    }
    if ((await readServiceMaintenance(this.env)).enabled) {
      closeWithError(ws, 'service-maintenance', 'SERVICE_MAINTENANCE', 1012);
      return;
    }

    if (
      attachment.auth === 'ok' &&
      isSafeInteger(attachment.identityExpiresAt) &&
      Date.now() >= attachment.identityExpiresAt
    ) {
      // Only an already-expired frame joins admission. Live-lease ordinary
      // signaling stays lock-free, while the commit-time re-read ensures a
      // queued refresh wins over an older expiry observation.
      await this.enqueueStandardAdmission(async () => {
        const current = this.currentStandardRoomAttachment(ws);
        if (
          current &&
          isSafeInteger(current.identityExpiresAt) &&
          Date.now() >= current.identityExpiresAt
        ) {
          await this.applyStandardRoomIdentity(ws, null, 'expired');
        }
      });
      attachment = this.currentStandardRoomAttachment(ws);
      if (!attachment) return;
    }

    const rawBytes = rawMessageByteLength(raw);
    if (rawBytes !== null && rawBytes > WS_MESSAGE_MAX_BYTES) {
      closeWithError(ws, 'message-too-large', 'SIGNALING_MESSAGE_TOO_LARGE', 1009);
      await this.webSocketClose(ws);
      this.recordMetric('ws_message_oversized');
      return;
    }

    if (attachment.role === 'guest' && !this.consumeGuestMessageToken(ws)) {
      closeWithError(ws, 'rate-limited', 'SIGNALING_RATE_LIMITED', 1008);
      await this.webSocketClose(ws);
      this.recordMetric('ws_message_rate_limited');
      return;
    }

    // Authentication is a one-frame protocol. Once the first frame owns the
    // receive-order queue, do not parse or enqueue any later frame as auth.
    // Keep this check after the absolute frame-size boundary and guest bucket:
    // in-flight auth must not become a temporary ingress exemption.
    if ((isPendingHost || isPendingGuest) && attachment.authStarted && !ingress.preclaimedAuth) {
      return;
    }

    const message = this.parse(raw);
    if (!message) {
      if (isPendingHost || isPendingGuest) {
        const reason = isPendingHost
          ? 'HOST_AUTH_FIRST_FRAME_INVALID'
          : 'GUEST_AUTH_FIRST_FRAME_INVALID';
        closeWithError(ws, 'invalid-id', reason, 1008);
        await this.webSocketClose(ws);
      }
      return;
    }
    const role =
      attachment.role === 'host'
        ? attachment.auth === 'pending'
          ? 'host-pending'
          : 'host'
        : attachment.auth === 'pending'
          ? 'pending'
          : 'guest';
    const validation = validateIncomingMessage(message, role);
    if (validation === 'oversized') {
      closeWithError(ws, 'message-too-large', 'SIGNALING_MESSAGE_TOO_LARGE', 1009);
      await this.webSocketClose(ws);
      this.recordMetric('ws_message_oversized');
      return;
    }
    if (validation !== 'valid') {
      if (isPendingHost || isPendingGuest) {
        const reason = isPendingHost
          ? 'HOST_AUTH_FIRST_FRAME_INVALID'
          : 'GUEST_AUTH_FIRST_FRAME_INVALID';
        closeWithError(ws, 'invalid-id', reason, 1008);
        await this.webSocketClose(ws);
      }
      return;
    }

    if (attachment.role === 'host') {
      if (attachment.auth === 'pending') {
        if (!this.pendingHosts.has(ws)) return;
        await this.handleHostAuth(ws, message, attachment, ingress.preclaimedAuth);
        return;
      }
      if (attachment.roomKind !== 'pro') await this.loadRoomMeta();
      if (this.host !== ws) {
        this.releaseStandardRoomPinMutationClaim(ws, ingress.pinConfigurationMutationId);
        return;
      }
      if (isStandardRoomIdentityMutation(message)) {
        await this.enqueueStandardAdmission(() =>
          this.handleStandardRoomIdentityMutation(ws, message),
        );
        return;
      }
      await this.handleHostMessage(ws, message, attachment, ingress.pinConfigurationMutationId);
      return;
    }

    if (attachment.auth === 'pending') {
      if (!this.pendingGuests.has(ws)) return;
      await this.handleGuestAuth(ws, message, attachment, ingress.preclaimedAuth);
      return;
    }

    if (attachment.roomKind !== 'pro') await this.loadRoomMeta();

    if (this.guests.get(attachment.peerId) !== ws) return;
    if (isStandardRoomIdentityMutation(message)) {
      await this.enqueueStandardAdmission(() =>
        this.handleStandardRoomIdentityMutation(ws, message),
      );
      return;
    }
    this.handleGuestMessage(attachment.peerId, message, attachment);
  }

  private handleProRealtimeMessage(
    ws: SocketPort,
    raw: unknown,
    attachment: ProSocketAttachment,
  ): Promise<void> {
    const rawBytes = rawMessageByteLength(raw);
    if (rawBytes !== null && rawBytes > WS_MESSAGE_MAX_BYTES) {
      closeWithError(ws, 'message-too-large', 'SIGNALING_MESSAGE_TOO_LARGE', 1009);
      this.defer(this.webSocketClose(ws), 'closed socket cleanup');
      this.recordMetric('pro_realtime_oversized');
      return Promise.resolve();
    }
    const normalized = normalizeProRealtimeFrame(this.parse(raw));
    if (normalized?.channel !== 'system-audio-signal') {
      return this.handleProRealtimeMessageNow(ws, raw, attachment);
    }
    const pendingSignals = this.proSystemAudioSignalIngressDepth.get(ws) ?? 0;
    if (pendingSignals >= PRO_SYSTEM_AUDIO_SIGNAL_PENDING_LIMIT) {
      closeWithError(ws, 'rate-limited', 'SIGNALING_RATE_LIMITED', 1008);
      this.defer(this.webSocketClose(ws), 'closed socket cleanup');
      this.recordMetric('pro_realtime_rate_limited');
      return Promise.resolve();
    }
    // Charge before enqueueing so a slow authority dependency cannot let one
    // sender accumulate an unbounded in-memory signal backlog.
    if (!this.consumeProRealtimeMessageToken(ws)) {
      closeWithError(ws, 'rate-limited', 'SIGNALING_RATE_LIMITED', 1008);
      this.defer(this.webSocketClose(ws), 'closed socket cleanup');
      this.recordMetric('pro_realtime_rate_limited');
      return Promise.resolve();
    }

    // Cross-DO authority checks yield to other WebSocket events. Preserve the
    // sender's exact signal order so a delayed offer cannot overtake its close
    // or a replacement negotiation and revive a superseded peer connection.
    const previous = this.proSystemAudioSignalIngressSync.get(ws) ?? Promise.resolve();
    this.proSystemAudioSignalIngressDepth.set(ws, pendingSignals + 1);
    const run = previous.then(
      () => this.handleProRealtimeMessageNow(ws, raw, attachment, true),
      () => this.handleProRealtimeMessageNow(ws, raw, attachment, true),
    );
    const settled = run.finally(() => {
      const remaining = Math.max(0, (this.proSystemAudioSignalIngressDepth.get(ws) ?? 1) - 1);
      if (remaining === 0) this.proSystemAudioSignalIngressDepth.delete(ws);
      else this.proSystemAudioSignalIngressDepth.set(ws, remaining);
    });
    this.proSystemAudioSignalIngressSync.set(
      ws,
      settled.catch(() => {}),
    );
    return settled;
  }

  private async handleProRealtimeMessageNow(
    ws: SocketPort,
    raw: unknown,
    attachment: ProSocketAttachment,
    messageTokenPreconsumed = false,
  ): Promise<void> {
    let ownerAccountDeletionFence;
    try {
      ownerAccountDeletionFence = await this.loadProOwnerAccountDeletionFence();
    } catch {
      ownerAccountDeletionFence = { unavailable: true };
    }
    if (ownerAccountDeletionFence) {
      closeSocket(ws, 1008, 'PRO_OWNER_ACCOUNT_DELETED');
      await this.webSocketClose(ws);
      return;
    }
    const meta = await this.loadProRoomMeta();
    const authority = await this.loadProPresenceAuthority(attachment.roomGeneration);
    const current =
      meta?.roomId === attachment.roomId &&
      meta.roomGeneration === attachment.roomGeneration &&
      meta.coordinatorEpoch === attachment.coordinatorEpoch &&
      (!authority ||
        (authority.roomId === attachment.roomId &&
          authority.roomGeneration === attachment.roomGeneration &&
          (authority.coordinatorEpoch < attachment.coordinatorEpoch ||
            (authority.coordinatorEpoch === attachment.coordinatorEpoch &&
              (attachment.presenceRevision > authority.presenceRevision ||
                authority.activeIncarnationIds.includes(attachment.presenceIncarnationId)))))) &&
      this.proMembers.get(attachment.participantId) === ws;
    if (!current) {
      const presenceRevoked =
        authority?.roomId === attachment.roomId &&
        authority.roomGeneration === attachment.roomGeneration &&
        authority.coordinatorEpoch === attachment.coordinatorEpoch &&
        authority.presenceRevision >= attachment.presenceRevision &&
        !authority.activeIncarnationIds.includes(attachment.presenceIncarnationId);
      closeSocket(
        ws,
        presenceRevoked ? 1008 : 1012,
        presenceRevoked ? 'PRO_PRESENCE_REVOKED' : 'PRO_ROOM_EPOCH_STALE',
      );
      await this.webSocketClose(ws);
      return;
    }

    const rawBytes = rawMessageByteLength(raw);
    if (rawBytes !== null && rawBytes > WS_MESSAGE_MAX_BYTES) {
      closeWithError(ws, 'message-too-large', 'SIGNALING_MESSAGE_TOO_LARGE', 1009);
      await this.webSocketClose(ws);
      this.recordMetric('pro_realtime_oversized');
      return;
    }
    if (!messageTokenPreconsumed && !this.consumeProRealtimeMessageToken(ws)) {
      closeWithError(ws, 'rate-limited', 'SIGNALING_RATE_LIMITED', 1008);
      await this.webSocketClose(ws);
      this.recordMetric('pro_realtime_rate_limited');
      return;
    }

    const message = this.parse(raw);
    const normalized = normalizeProRealtimeFrame(message);
    const rawLimit =
      normalized?.channel === 'system-audio-signal'
        ? WS_MESSAGE_MAX_BYTES
        : PRO_REALTIME_BODY_MAX_BYTES;
    if (rawBytes !== null && rawBytes > rawLimit) {
      closeWithError(ws, 'message-too-large', 'SIGNALING_MESSAGE_TOO_LARGE', 1009);
      await this.webSocketClose(ws);
      this.recordMetric('pro_realtime_oversized');
      return;
    }
    if (!normalized) return;
    if (normalized.channel === 'clock') {
      sendChecked(ws, {
        type: 'pro-clock',
        version: 1,
        requestId: normalized.payload.requestId,
        clientSentAtMs: normalized.payload.clientSentAtMs,
        serverTimeMs: Date.now(),
      });
      return;
    }

    const liveAttachment = this.currentProRealtimeAttachment(ws, attachment);
    if (!liveAttachment) return;

    if (normalized.channel === 'system-audio-signal') {
      const payload = normalized.payload;
      const targetSocket = this.proMembers.get(payload.targetParticipantId) || null;
      const targetAttachment = readAttachment(targetSocket);
      if (
        !targetSocket ||
        targetSocket === ws ||
        targetAttachment?.roomKind !== 'pro' ||
        targetAttachment.role !== 'member' ||
        targetAttachment.auth !== 'ok' ||
        targetAttachment.roomId !== liveAttachment.roomId ||
        targetAttachment.roomGeneration !== liveAttachment.roomGeneration ||
        targetAttachment.coordinatorEpoch !== liveAttachment.coordinatorEpoch ||
        targetAttachment.participantId !== payload.targetParticipantId ||
        this.proMembers.get(payload.targetParticipantId) !== targetSocket
      ) {
        return;
      }
      const targetPresenceIncarnationId = targetAttachment.presenceIncarnationId;
      if (
        !(await this.hasProRealtimePermission(liveAttachment, 'system-audio.signal', {
          targetParticipantId: payload.targetParticipantId,
          targetPresenceIncarnationId,
          direction: payload.direction,
          generation: payload.generation,
          publicationId: payload.publicationId,
          negotiationId: payload.negotiationId,
        }))
      ) {
        return;
      }

      const actor = this.currentProRealtimeAttachment(ws, liveAttachment);
      const currentTargetSocket = this.proMembers.get(payload.targetParticipantId) || null;
      const currentTargetAttachment = readAttachment(currentTargetSocket);
      if (
        !actor ||
        currentTargetSocket !== targetSocket ||
        currentTargetAttachment?.roomKind !== 'pro' ||
        currentTargetAttachment.role !== 'member' ||
        currentTargetAttachment.auth !== 'ok' ||
        currentTargetAttachment.roomId !== actor.roomId ||
        currentTargetAttachment.roomGeneration !== actor.roomGeneration ||
        currentTargetAttachment.coordinatorEpoch !== actor.coordinatorEpoch ||
        currentTargetAttachment.participantId !== payload.targetParticipantId ||
        currentTargetAttachment.presenceIncarnationId !== targetPresenceIncarnationId
      ) {
        return;
      }
      sendChecked(targetSocket, this.proRealtimeRelay(normalized, actor));
      return;
    }

    if (normalized.channel !== 'chat') {
      this.broadcastProRealtimeRelay(ws, liveAttachment, normalized);
      return;
    }

    const payload = normalized.payload;
    if (PRO_CHAT_MODERATION_KINDS.has(payload.kind)) {
      return this.enqueueProChatMutation(async () => {
        let actor = this.currentProRealtimeAttachment(ws, liveAttachment);
        if (!actor) return;
        if (!(await this.hasProRealtimePermission(actor, 'room.configure'))) return;
        // Authority is tied to an exact presence incarnation, but the socket
        // can still be replaced while the cross-DO check is in flight.
        actor = this.currentProRealtimeAttachment(ws, actor);
        if (!actor) return;

        let targetSocket = null;
        if (payload.kind === 'mute') {
          targetSocket = this.proMembers.get(payload.targetParticipantId) || null;
          const target = readAttachment(targetSocket);
          if (
            !targetSocket ||
            target?.roomKind !== 'pro' ||
            target.auth !== 'ok' ||
            target.roomId !== actor.roomId ||
            target.roomGeneration !== actor.roomGeneration ||
            target.coordinatorEpoch !== actor.coordinatorEpoch ||
            target.participantId !== payload.targetParticipantId ||
            this.proMembers.get(payload.targetParticipantId) !== targetSocket
          ) {
            return;
          }
        }

        const currentState = await this.loadProChatControlState(
          actor.roomId,
          actor.coordinatorEpoch,
        );
        let nextState = currentState;
        if (payload.kind === 'freeze' && currentState.frozen !== payload.on) {
          nextState = { ...currentState, revision: currentState.revision + 1, frozen: payload.on };
        } else if (payload.kind === 'filter' && currentState.filterEnabled !== payload.on) {
          nextState = {
            ...currentState,
            revision: currentState.revision + 1,
            filterEnabled: payload.on,
          };
        } else if (
          payload.kind === 'slowmode' &&
          currentState.slowmodeSeconds !== payload.seconds
        ) {
          nextState = {
            ...currentState,
            revision: currentState.revision + 1,
            slowmodeSeconds: payload.seconds,
          };
        } else if (payload.kind === 'mute') {
          const muted = new Set(currentState.mutedParticipantIds);
          const wasMuted = muted.has(payload.targetParticipantId);
          if (payload.on) muted.add(payload.targetParticipantId);
          else muted.delete(payload.targetParticipantId);
          if (wasMuted !== payload.on) {
            nextState = {
              ...currentState,
              revision: currentState.revision + 1,
              mutedParticipantIds: [...muted].sort(),
            };
          }
        }

        // `clear` is a transient command. Every other moderation mutation is
        // committed before relay so hibernation/reconnect cannot make live
        // recipients disagree with a later participant.
        if (nextState !== currentState) await this.saveProChatControlState(nextState);
        if (payload.kind === 'clear' || nextState !== currentState) {
          this.broadcastProRealtimeRelay(ws, actor, normalized, targetSocket);
        }
      });
    }

    if (payload.kind === 'message' || payload.kind === 'whisper') {
      return this.enqueueProChatMutation(async () => {
        let actor = this.currentProRealtimeAttachment(ws, liveAttachment);
        if (!actor) return;
        const state = await this.loadProChatControlState(actor.roomId, actor.coordinatorEpoch);
        if (state.mutedParticipantIds.includes(actor.participantId)) return;

        if (payload.kind === 'message' && state.frozen) {
          if (!(await this.hasProRealtimePermission(actor, 'chat.manage'))) return;
          actor = this.currentProRealtimeAttachment(ws, actor);
          if (!actor) return;
        }

        let targetSocket = null;
        if (payload.kind === 'whisper') {
          targetSocket = this.proMembers.get(payload.targetParticipantId) || null;
          const target = readAttachment(targetSocket);
          if (
            !targetSocket ||
            target?.roomKind !== 'pro' ||
            target.auth !== 'ok' ||
            target.roomId !== actor.roomId ||
            target.roomGeneration !== actor.roomGeneration ||
            target.coordinatorEpoch !== actor.coordinatorEpoch ||
            target.participantId !== payload.targetParticipantId ||
            this.proMembers.get(payload.targetParticipantId) !== targetSocket
          ) {
            return;
          }
        }

        if (payload.kind === 'message' && state.slowmodeSeconds > 0) {
          const nowMs = Date.now();
          const lastMessageAtMs = isFiniteNumber(actor.chatLastMessageAtMs)
            ? actor.chatLastMessageAtMs
            : 0;
          if (nowMs - lastMessageAtMs < state.slowmodeSeconds * 1000) return;
          actor = { ...actor, chatLastMessageAtMs: nowMs };
          serializeSocketAttachment(ws, actor);
        }
        if (payload.kind === 'message' && payload.botRequestId) {
          const remembered = await this.rememberProBotRequest(
            actor.roomId,
            actor.coordinatorEpoch,
            actor.participantId,
            payload.botRequestId,
          );
          if (!remembered) return;
          // The durable proof write yields. Only the exact socket that sent the
          // observed request may cause its visible chat command to be relayed.
          actor = this.currentProRealtimeAttachment(ws, actor);
          if (!actor) return;
        }
        this.broadcastProRealtimeRelay(ws, actor, normalized, targetSocket);
      });
    }

    if (payload.kind === 'bot-result') {
      return this.enqueueProChatMutation(async () => {
        let actor = this.currentProRealtimeAttachment(ws, liveAttachment);
        if (!actor) return;
        const successful = payload.result.kind === 'answer' || payload.result.kind === 'added';
        if (
          successful &&
          !(await this.hasProRealtimePermission(actor, 'bot.result', {
            requestId: payload.requestId,
            result: payload.result,
          }))
        ) {
          return;
        }
        // A successful result remains bound to the exact PRO Worker execution
        // receipt. Failure/rate-limit results have no execution receipt, so
        // they instead require the pending request that this signaling DO
        // observed from the same participant. Every accepted terminal result
        // consumes a durable one-shot proof before it is relayed.
        actor = this.currentProRealtimeAttachment(ws, actor);
        if (!actor) return;
        const consumed = await this.consumeProBotRequest(
          actor.roomId,
          actor.coordinatorEpoch,
          actor.participantId,
          payload.requestId,
          successful,
        );
        if (!consumed) return;
        actor = this.currentProRealtimeAttachment(ws, actor);
        if (!actor) return;
        this.broadcastProRealtimeRelay(ws, actor, normalized);
      });
    }

    let requiredPermission = null;
    let authorityDetails = {};
    if (payload.kind === 'notice') {
      requiredPermission = 'chat.notice';
    } else if (payload.kind === 'system') {
      requiredPermission = 'system.broadcast';
      authorityDetails = { i18nKey: payload.i18nKey };
    }
    if (requiredPermission) {
      if (
        !(await this.hasProRealtimePermission(liveAttachment, requiredPermission, authorityDetails))
      ) {
        return;
      }
      const actor = this.currentProRealtimeAttachment(ws, liveAttachment);
      if (!actor) return;
      this.broadcastProRealtimeRelay(ws, actor, normalized);
    }
  }

  private async handleHostAuth(
    ws: SocketPort,
    message: JsonRecord,
    attachment: StandardHostPendingAttachment,
    preclaimedAuth = false,
  ): Promise<void> {
    const currentAttachment = readAttachment(ws) || attachment;
    if (currentAttachment.authStarted && !preclaimedAuth) return;
    if (!currentAttachment.authStarted) {
      serializeSocketAttachment(ws, { ...currentAttachment, authStarted: true });
    }
    try {
      return await this.enqueueHostAdmission(() => this.finishHostAuth(ws, message));
    } catch (error) {
      // A transient storage failure did not consume the one allowed attempt.
      // Reset the marker only if this exact candidate is still pending so a
      // deliberate retry can be accepted without allowing an in-flight queue
      // amplification.
      const latest = readAttachment(ws);
      if (this.pendingHosts.has(ws) && latest?.role === 'host' && latest.auth === 'pending') {
        serializeSocketAttachment(ws, { ...latest, authStarted: false });
      }
      throw error;
    }
  }

  private async finishHostAuth(ws: SocketPort, message: JsonRecord): Promise<void> {
    const attachment = readAttachment(ws);
    if (
      !this.pendingHosts.has(ws) ||
      attachment?.role !== 'host' ||
      attachment.auth !== 'pending' ||
      !attachment.authStarted
    ) {
      return;
    }
    if (Date.now() > attachment.authDeadline) {
      this.pendingHosts.delete(ws);
      this.requestMaintenanceAlarm();
      closeWithError(ws, 'host-auth-timeout', 'HOST_AUTH_TIMEOUT', 1008);
      return;
    }
    await this.completeHostAccept(
      ws,
      attachment.roomId,
      attachment.peerId,
      message.secret,
      message.accountAssertion,
      message.desiredRoomPassword,
      message.pinMutationId,
    );
  }

  private async handleGuestAuth(
    ws: SocketPort,
    message: JsonRecord,
    attachment: StandardGuestPendingAttachment,
    preclaimedAuth = false,
  ): Promise<void> {
    // consumeGuestMessageToken() may have persisted a newer bucket earlier in
    // this event. Merge the marker into that attachment instead of restoring
    // the stale pre-consumption snapshot passed by webSocketMessage().
    const currentAttachment = readAttachment(ws) || attachment;
    if (currentAttachment.authStarted && !preclaimedAuth) return;
    if (!currentAttachment.authStarted) {
      serializeSocketAttachment(ws, { ...currentAttachment, authStarted: true });
    }
    try {
      return await this.enqueueGuestAdmission(() => this.finishGuestAuth(ws, message));
    } catch (error) {
      const latest = readAttachment(ws);
      if (this.pendingGuests.has(ws) && latest?.role === 'guest' && latest.auth === 'pending') {
        serializeSocketAttachment(ws, { ...latest, authStarted: false });
      }
      throw error;
    }
  }

  private async finishGuestAuth(ws: SocketPort, message: JsonRecord): Promise<void> {
    const attachment = readAttachment(ws);
    if (
      !this.pendingGuests.has(ws) ||
      attachment?.role !== 'guest' ||
      attachment.auth !== 'pending' ||
      !attachment.authStarted
    ) {
      return;
    }
    if (this.standardRoomPinMutationFence) {
      this.pendingGuests.delete(ws);
      closeWithError(ws, 'service-unavailable', 'ROOM_PASSWORD_MUTATION_PENDING', 1013);
      return;
    }
    if (!this.host) {
      this.pendingGuests.delete(ws);
      closeWithError(ws, 'peer-unavailable', 'HOST_NOT_AVAILABLE');
      return;
    }
    if (Date.now() > attachment.authDeadline) {
      this.pendingGuests.delete(ws);
      this.requestMaintenanceAlarm();
      this.recordMetric('guest_auth_timeout');
      closeWithError(ws, 'room-password-auth-timeout', 'ROOM_PASSWORD_AUTH_TIMEOUT');
      return;
    }

    const meta = await this.loadRoomMeta();
    const password = typeof message.password === 'string' ? message.password : '';
    const passwordRequired = hasStandardRoomPassword(meta);
    if (passwordRequired && !password) {
      this.pendingGuests.delete(ws);
      this.requestMaintenanceAlarm();
      this.recordMetric('guest_auth_failed');
      closeWithError(ws, 'room-password-required', 'ROOM_PASSWORD_REQUIRED');
      return;
    }
    if (
      passwordRequired &&
      !(await this.verifyStandardRoomPassword(meta, attachment.roomId, password))
    ) {
      this.pendingGuests.delete(ws);
      this.requestMaintenanceAlarm();
      this.recordMetric('guest_auth_failed');
      closeWithError(ws, 'room-password-invalid', 'ROOM_PASSWORD_INVALID');
      return;
    }

    // Socket admission and frame authentication are separate events. Recheck
    // the admitted-device ceiling inside the serialized auth queue so a burst
    // of valid pending guests can never race past the 99-guest product limit.
    if (!this.guests.has(attachment.peerId) && this.guests.size >= MAX_ROOM_GUESTS) {
      this.pendingGuests.delete(ws);
      this.requestMaintenanceAlarm();
      this.recordMetric('guest_room_full');
      closeWithError(ws, 'room-full', 'ROOM_GUEST_LIMIT_REACHED', 1008);
      return;
    }

    const storedBindings = await this.loadGuestBindings();
    if (this.guestBindingsInvalid) {
      this.pendingGuests.delete(ws);
      this.requestMaintenanceAlarm();
      this.recordMetric('guest_reconnect_state_invalid');
      closeWithError(ws, 'room-state-invalid', 'ROOM_STATE_INVALID', 1011);
      return;
    }
    const bindings = this.pruneGuestBindings(storedBindings);
    const existingBinding = bindings.entries.find((entry) => entry.peerId === attachment.peerId);
    const reconnectSecret =
      typeof message.reconnectSecret === 'string' ? message.reconnectSecret : '';
    if (existingBinding) {
      const presentedHash = await hashGuestReconnectSecret(reconnectSecret);
      if (!constantTimeStringEqual(presentedHash, existingBinding.secretHash)) {
        this.pendingGuests.delete(ws);
        this.requestMaintenanceAlarm();
        this.recordMetric('guest_reconnect_denied');
        closeWithError(ws, 'guest-reconnect-denied', 'GUEST_RECONNECT_DENIED', 1008);
        return;
      }
      await this.saveGuestBindings({
        ...bindings,
        entries: bindings.entries.map((entry) =>
          entry.peerId === attachment.peerId ? { ...entry, updatedAt: Date.now() } : entry,
        ),
      });
    } else {
      if (bindings.entries.length >= MAX_GUEST_BINDINGS) {
        this.pendingGuests.delete(ws);
        this.requestMaintenanceAlarm();
        this.recordMetric('guest_identity_capacity');
        closeWithError(ws, 'room-full', 'ROOM_IDENTITY_LIMIT_REACHED', 1008);
        return;
      }
      const secretHash = await hashGuestReconnectSecret(reconnectSecret);
      await this.saveGuestBindings({
        ...bindings,
        entries: [
          ...bindings.entries,
          { peerId: attachment.peerId, secretHash, updatedAt: Date.now() },
        ],
      });
    }

    const identity = meta.roomSecret
      ? await this.resolveStandardRoomIdentity(
          message.accountAssertion,
          attachment.roomId,
          attachment.peerId,
          'guest',
          meta.roomSecret,
        )
      : null;
    await this.completeGuestAccept(ws, attachment.roomId, attachment.peerId, identity);
  }

  private handleGuestMessage(
    peerId: string,
    message: JsonRecord,
    attachment: StandardGuestOkAttachment,
  ): void {
    if (!this.host) return;
    const {
      to: _to,
      memberIdentity: _untrustedMemberIdentity,
      accountSubject: _untrustedAccountSubject,
      ...rest
    } = message;
    const memberIdentity = standardRoomMemberIdentityFromAttachment(attachment);
    send(this.host, {
      ...rest,
      from: peerId,
      ...(memberIdentity ? { memberIdentity } : {}),
    });
  }

  private async handleHostMessage(
    ws: SocketPort,
    message: JsonRecord,
    attachment: StandardHostOkAttachment,
    pinConfigurationMutationId?: string,
  ): Promise<void> {
    if (message.type === 'remote-share-upload-assertion-request') {
      if (
        !isSafeInteger(message.sessionId) ||
        typeof message.queueItemId !== 'string' ||
        !isSafeInteger(message.size) ||
        typeof message.actorId !== 'string' ||
        typeof message.requestId !== 'string' ||
        typeof message.bodySha256 !== 'string'
      ) {
        return;
      }
      const current = this.currentStandardRoomAttachment(ws);
      if (!current || current.role !== 'host') return;
      if (!this.consumeRemoteShareUploadAssertionToken(ws)) {
        sendChecked(ws, {
          type: 'remote-share-upload-assertion-error',
          correlationId: message.correlationId,
          errorType: 'REMOTE_SHARE_UPLOAD_ASSERTION_RATE_LIMITED',
        });
        return;
      }
      const secret = remoteShareUploadAssertionSecret(this.env);
      let issued = null;
      if (secret) {
        try {
          issued = await createRemoteShareUploadAssertion(
            {
              roomId: current.roomId,
              hostPeerId: current.peerId,
              sessionId: message.sessionId,
              queueItemId: message.queueItemId,
              size: message.size,
              actorId: message.actorId,
              requestId: message.requestId,
              bodySha256: message.bodySha256,
            },
            secret,
          );
        } catch {
          issued = null;
        }
      }

      // HMAC work yields. Re-read the attachment and live host index so a
      // replaced or closed predecessor can never receive fresh authority.
      const afterIssue = this.currentStandardRoomAttachment(ws);
      if (
        !afterIssue ||
        afterIssue.role !== 'host' ||
        afterIssue.roomId !== current.roomId ||
        afterIssue.peerId !== current.peerId
      ) {
        return;
      }
      if (!issued) {
        sendChecked(ws, {
          type: 'remote-share-upload-assertion-error',
          correlationId: message.correlationId,
          errorType: 'REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE',
        });
        return;
      }
      sendChecked(ws, {
        type: 'remote-share-upload-assertion',
        correlationId: message.correlationId,
        assertion: issued.assertion,
        expiresAt: issued.expiresAt,
      });
      return;
    }
    if (message.type === 'room-password-set') {
      if (attachment.roomKind === 'pro') return;
      const password = typeof message.password === 'string' ? message.password : '';
      const pinMutationId =
        typeof message.pinMutationId === 'string' ? message.pinMutationId : null;
      const mutationClaim =
        pinConfigurationMutationId || pinMutationId || `legacy-${crypto.randomUUID()}`;
      return this.enqueueHostAdmission(async () => {
        if (this.host !== ws) {
          this.releaseStandardRoomPinMutationClaim(ws, mutationClaim);
          return;
        }
        const meta = await this.loadRoomMeta();
        if (
          this.host !== ws ||
          meta.roomSecret !== attachment.secret ||
          meta.hostPeerId !== attachment.peerId
        ) {
          this.releaseStandardRoomPinMutationClaim(ws, mutationClaim);
          return;
        }
        // An invalid verifier represents corrupt/ambiguous durable state, not
        // a passwordless room. Even a previously rehydrated host must not turn
        // that quarantine into an open room with the ordinary blank setting.
        if (isQuarantinedRoomMeta(meta)) {
          this.failStandardRoomPinMutation(ws, pinMutationId, 'ROOM_STATE_INVALID');
          return;
        }
        const currentBeforeCommit = this.currentStandardRoomAttachment(ws);
        if (!currentBeforeCommit || currentBeforeCommit.role !== 'host') return;
        let activeMutationClaim = currentBeforeCommit.pinConfigurationMutationId;
        if (!currentBeforeCommit.pinConfigurationPending || !activeMutationClaim) {
          activeMutationClaim = mutationClaim;
          serializeSocketAttachment(ws, {
            ...currentBeforeCommit,
            pinConfigurationPending: true,
            pinConfigurationMutationId: mutationClaim,
          });
        }
        // A newer frame can synchronously preclaim this attachment while an
        // older frame is awaiting maintenance. Preserve that newer claim;
        // the older durable commit must not reopen guest admission.
        this.standardRoomPinMutationFence = activeMutationClaim;
        this.standardRoomPinMutationFenceOwner = ws;
        let verifier: StandardRoomPinVerifier | null = null;
        if (/^\d{8}$/.test(password)) {
          verifier = await createStandardRoomPinVerifier(
            this.env,
            attachment.roomId,
            meta.roomSecret,
            password,
          );
          if (!verifier) {
            this.failStandardRoomPinMutation(
              ws,
              pinMutationId,
              'STANDARD_ROOM_PIN_PEPPER_UNAVAILABLE',
            );
            throw new Error('STANDARD_ROOM_PIN_PEPPER_UNAVAILABLE');
          }
        }
        try {
          await this.saveRoomMeta(currentRoomMeta(meta, verifier));
        } catch (error) {
          this.failStandardRoomPinMutation(ws, pinMutationId, 'ROOM_PASSWORD_STORAGE_UNAVAILABLE');
          throw error;
        }
        // Other host-only work (notably Remote Share assertion rate limiting)
        // can update this hibernation attachment while the storage write
        // yields. Clear only the compatibility bit on the latest live value;
        // replaying the event-start snapshot would rewind those authority and
        // rate-limit fields.
        const currentAttachment = this.currentStandardRoomAttachment(ws);
        if (
          !currentAttachment ||
          currentAttachment.role !== 'host' ||
          currentAttachment.roomId !== attachment.roomId ||
          currentAttachment.peerId !== attachment.peerId ||
          currentAttachment.secret !== attachment.secret
        ) {
          this.releaseStandardRoomPinMutationClaim(ws, mutationClaim);
          return;
        }
        if (
          currentAttachment.pinConfigurationPending &&
          currentAttachment.pinConfigurationMutationId === mutationClaim
        ) {
          const configuredAttachment = { ...currentAttachment };
          delete configuredAttachment.pinConfigurationPending;
          delete configuredAttachment.pinConfigurationMutationId;
          serializeSocketAttachment(ws, configuredAttachment);
        }
        if (
          this.standardRoomPinMutationFence === mutationClaim &&
          this.standardRoomPinMutationFenceOwner === ws
        ) {
          this.standardRoomPinMutationFence = null;
          this.standardRoomPinMutationFenceOwner = null;
        }
        if (pinMutationId) {
          sendChecked(ws, {
            type: 'room-password-result',
            mutationId: pinMutationId,
            applied: true,
          });
        }
      });
    }
    if (this.host !== ws) return;
    if (typeof message.to !== 'string') return;
    const guest = this.guests.get(message.to);
    if (!guest) return;
    const { to: _to, ...rest } = message;
    send(guest, { ...rest, from: attachment.peerId });
  }

  async webSocketClose(ws: SocketPort): Promise<void> {
    if (this.standardHttpBridgeOnly) return;
    const attachment = readAttachment(ws);
    if (!attachment) return;

    if (attachment.roomKind === 'pro') {
      if (this.proMembers.get(attachment.participantId) === ws) {
        this.proMembers.delete(attachment.participantId);
      }
      return;
    }

    await this.loadRoomMeta();
    if (this.futureRoomMetaVersion) return;

    if (attachment.role === 'host') {
      return this.enqueueHostAdmission(async () => {
        // Re-read after queued authentication: the close event may have
        // captured a pending attachment that was promoted while awaiting this
        // same admission queue.
        const current = readAttachment(ws) || attachment;
        if (current.roomKind === 'pro' || current.role !== 'host') return;
        if (current.auth === 'pending') {
          this.pendingHosts.delete(ws);
          await this.scheduleMaintenanceAlarm();
          return;
        }
        await this.releaseHost(ws, current);
      });
    }

    return this.enqueueGuestAdmission(async () => {
      // A close can arrive while guest-auth is awaiting its reconnect binding.
      // Re-read after that queued admission: if it won, remove the promoted
      // socket; otherwise reclaim only the still-pending slot. This prevents a
      // closed socket from becoming a permanent admitted guest.
      const current = readAttachment(ws) || attachment;
      if (current.auth === 'pending') {
        this.pendingGuests.delete(ws);
        await this.scheduleMaintenanceAlarm();
        return;
      }
      await this.finishRemoveGuest(current.peerId, ws);
    });
  }

  async webSocketError(ws: SocketPort): Promise<void> {
    if (this.standardHttpBridgeOnly) return;
    await this.webSocketClose(ws);
  }

  private async releaseHost(ws: SocketPort, attachment: StandardHostOkAttachment): Promise<void> {
    // The caller owns standardAdmissionSync. A live replacement always wins,
    // while a retry after storage/alarm failure may continue from host=null.
    // This makes duplicate close callbacks convergent without allowing a stale
    // socket to release a newer host.
    if (this.host !== null && this.host !== ws) return;
    const meta = await this.loadRoomMeta();
    if (isQuarantinedRoomMeta(meta) && this.host === ws) {
      this.host = null;
      this.hostPeerId = null;
      if (!this.futureRoomMetaVersion) {
        await this.saveRoomMeta({
          ...meta,
          hostPeerId: null,
          hostReleaseAt: Date.now() + HOST_RECLAIM_GRACE_MS,
        });
      }
      await this.scheduleMaintenanceAlarm();
      return;
    }
    const ownsPersistedHost =
      meta.roomSecret === attachment.secret && meta.hostPeerId === attachment.peerId;
    const alreadyReleasedSameEpoch =
      this.host === null &&
      meta.roomSecret === attachment.secret &&
      meta.hostPeerId === null &&
      meta.hostReleaseAt > 0;
    if (!ownsPersistedHost && !alreadyReleasedSameEpoch) return;

    if (ownsPersistedHost) {
      this.host = null;
      this.hostPeerId = null;
      await this.saveRoomMeta({
        ...meta,
        hostPeerId: null,
        hostReleaseAt: Date.now() + HOST_RECLAIM_GRACE_MS,
      });
    }
    await this.clearExpiredHostRelease();
    await this.scheduleMaintenanceAlarm();
  }

  private async finishRemoveGuest(peerId: string, ws: SocketPort): Promise<void> {
    const current = this.guests.get(peerId);
    if (current && current !== ws) return;

    if (current === ws) {
      const bindings = await this.loadGuestBindings();
      if (!this.guestBindingsInvalid && bindings.entries.some((entry) => entry.peerId === peerId)) {
        await this.saveGuestBindings({
          ...bindings,
          entries: bindings.entries.map((entry) =>
            entry.peerId === peerId ? { ...entry, updatedAt: Date.now() } : entry,
          ),
        });
      }
      this.guests.delete(peerId);
      if (this.host) {
        send(this.host, { type: 'peer-left', peerId });
        await this.scheduleMaintenanceAlarm();
        return;
      }
    }

    // A duplicate close may be the retry after storage failed once the socket
    // had already been removed from the in-memory index. Continue the empty-
    // room reconciliation in that case, but never act on a replaced peer.
    if (!this.host && this.guests.size === 0) {
      const meta = await this.loadRoomMeta();
      if (this.host) {
        // A host may have reclaimed the room while the metadata read yielded.
        // Treat the departure exactly like a normal hosted guest close instead
        // of clearing the newly reconnected room epoch.
        send(this.host, { type: 'peer-left', peerId });
        return;
      }
      if (meta.hostReleaseAt > Date.now()) {
        // The room epoch still belongs to the disconnected host. Keep both the
        // host secret and guest reconnect ownership until its grace alarm ends.
        await this.scheduleMaintenanceAlarm();
        return;
      }
      await this.clearGuestBindings();
      if (this.host) return;
      await this.clearRoomMeta();
      await this.scheduleMaintenanceAlarm();
    }
  }

  private parse(raw: unknown): JsonRecord | null {
    if (typeof raw !== 'string') return null;
    try {
      const value: unknown = JSON.parse(raw);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }
}

export default {
  async fetch(request: Request, env: SignalingWorkerEnvPort): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(ROOM_PATH);
    const proMatch = url.pathname.match(PRO_ROOM_PATH);
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === ALTERNATE_STANDARD_SIGNALING_HOST &&
      url.pathname !== '/' &&
      (!match?.[1] || isProNamespaceRoomCode(match[1]))
    ) {
      // The cold iOS route-retry alias is deliberately not a second public
      // surface for PRO or private signaling. Keep only root health and an
      // exact ordinary Standard-room WebSocket path reachable on this host.
      return json({ error: 'NOT_FOUND' }, 404);
    }
    if (url.pathname.startsWith('/internal/')) {
      return json({ error: 'NOT_FOUND' }, 404);
    }
    const maintenanceResponse = await gateServiceMaintenance(request, env, { format: 'json' });
    if (maintenanceResponse) return maintenanceResponse;
    if (!match && !proMatch) {
      if (hostname === ALTERNATE_STANDARD_SIGNALING_HOST) {
        return json({
          ok: true,
          service: 'musixquare-signaling',
          websocket: '/api/rooms/:roomId/ws',
        });
      }
      return json({
        ok: true,
        service: 'musixquare-signaling',
        websocket: '/api/rooms/:roomId/ws',
        proWebsocket: '/api/pro-rooms/:roomId/ws + Sec-WebSocket-Protocol',
      });
    }

    const upgrade = request.headers.get('Upgrade') || '';
    if (upgrade.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required' }, 426);
    }

    if (!isAllowedOrigin(request.headers.get('Origin') || '', env)) {
      return json({ error: 'Forbidden' }, 403);
    }

    const roomId = match?.[1] ?? proMatch?.[1];
    if (!roomId) return json({ error: 'Bad request' }, 400);
    if (proMatch) {
      if (!isProNamespaceRoomCode(roomId)) {
        return json({ error: 'PRO_ROOM_NOT_CONFIGURED' }, 404);
      }
      const credential = readProSignalingCredential(request, url);
      if (!credential) return json({ error: 'INVALID_PRO_SIGNALING_TICKET' }, 401);
      const ticket = await verifyProSignalingTicket(credential.ticket, roomId, env);
      if (!ticket) return json({ error: 'INVALID_PRO_SIGNALING_TICKET' }, 401);
      const proRoomObject = proRoomObjectName(roomId, ticket.roomGeneration);
      const rate = await checkProRateLimit(request, env, `pro-ws-open:${proRoomObject}`);
      if (rate.status !== 'ok') return json({ error: 'RATE_LIMIT_UNAVAILABLE' }, 503);
      if (!rate.allowed) {
        return json({ error: 'Too Many Requests' }, 429);
      }
      const id = env.MUSIXQUARE_ROOMS.idFromName(proRoomObject);
      const room = env.MUSIXQUARE_ROOMS.get(id);
      return room.fetch(request);
    }

    const role = url.searchParams.get('role');
    const peerId = url.searchParams.get('peerId');
    if (!roomId || (role !== 'host' && role !== 'guest') || !isValidPeerId(peerId)) {
      return json({ error: 'Bad request' }, 400);
    }
    if (isProNamespaceRoomCode(roomId)) {
      return json({ error: 'ROOM_RESERVED' }, 403);
    }
    const rate = await checkStandardWsRateLimit(request, env);
    if (rate.status !== 'ok') return json({ error: 'RATE_LIMIT_UNAVAILABLE' }, 503);
    if (!rate.allowed) {
      return json({ error: 'Too Many Requests' }, 429);
    }

    const id = env.MUSIXQUARE_ROOMS.idFromName(roomId);
    const room = env.MUSIXQUARE_ROOMS.get(id);
    return room.fetch(request);
  },
} satisfies PortableSignalingHandler;
