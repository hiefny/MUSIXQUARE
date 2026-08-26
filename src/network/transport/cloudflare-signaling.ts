import { log } from '../../core/log.ts';
import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { clearManagedTimer, delay, getManagedTimer, setManagedTimer } from '../../core/timers.ts';
import { proSignalingWebSocketProtocols } from '../pro-signaling-websocket.ts';
import { normalizeSignalingFallbackUrl } from './config.ts';
import { TinyEmitter } from './emitter.ts';
import {
  isStandardHttpSignalingSocket,
  StandardHttpSignalingSocket,
} from './standard-http-signaling.ts';
import {
  SIGNALING_LIVENESS_VERSION,
  SignalingSocketLivenessMonitor,
} from './signaling-liveness.ts';
import type {
  DeveloperCommandFrame,
  DeveloperInvalidationFrame,
  ProQueueAdditionFrame,
  ProSignalingOptions,
  TransportConnectOptions,
  TransportDataConnection,
  TransportBackgroundRecoveryResult,
  TransportBackgroundRecoveryStatus,
  TransportMediaConnection,
  TransportPeer,
  TransportPeerOptions,
  StandardRoomIdentityAssertions,
  StandardRoomIdentityClearReason,
  StandardRoomMemberIdentity,
  RemoteShareUploadAssertionRequest,
} from './types.ts';
import {
  parseDeveloperCommandFrame,
  parseDeveloperInvalidationFrame,
  parseProQueueAdditionFrame,
} from './types.ts';

type SignalingMessage =
  | {
      type: 'peer-open';
      peerId: string;
      roomId: string;
      workerVersionId?: string;
      signalingLivenessVersion?: 1;
      memberIdentity?: StandardRoomMemberIdentity;
      remoteShareUploadAssertionVersion?: 1;
      remoteShareUploadAssertionKeyringVersion?: 1;
      roomPasswordMutationId?: string;
      roomPasswordApplied?: true;
    }
  | {
      type: 'room-password-result';
      mutationId: string;
      applied: boolean;
      errorType?: string;
    }
  | { type: 'error'; errorType?: string; message?: string }
  | {
      type: 'remote-share-upload-assertion';
      correlationId: string;
      assertion: string;
      expiresAt: number;
    }
  | {
      type: 'remote-share-upload-assertion-error';
      correlationId: string;
      errorType: string;
    }
  | {
      type: 'signal-offer';
      from: string;
      sdp: RTCSessionDescriptionInit;
      negotiationId: string;
      metadata?: unknown;
      memberIdentity?: StandardRoomMemberIdentity;
    }
  | {
      type: 'signal-answer';
      from: string;
      sdp: RTCSessionDescriptionInit;
      negotiationId: string;
    }
  | {
      type: 'signal-candidate';
      from: string;
      candidate: RTCIceCandidateInit;
      negotiationId: string;
    }
  | {
      type: 'media-offer';
      from: string;
      callId: string;
      sdp: RTCSessionDescriptionInit;
      negotiationId: string;
      metadata?: Record<string, unknown>;
      audioTrackCount?: number;
    }
  | {
      type: 'media-answer';
      from: string;
      callId: string;
      sdp: RTCSessionDescriptionInit;
      negotiationId: string;
    }
  | { type: 'media-close'; from: string; callId: string }
  | { type: 'peer-left'; peerId: string }
  | {
      type: 'account-identity';
      memberIdentity: StandardRoomMemberIdentity | null;
      clearReason?: StandardRoomIdentityClearReason;
    }
  | {
      type: 'account-member-updated';
      peerId: string;
      memberIdentity: StandardRoomMemberIdentity | null;
      clearReason?: StandardRoomIdentityClearReason;
    }
  | { type: 'account-member-deleted'; memberId: string }
  | DeveloperCommandFrame
  | DeveloperInvalidationFrame
  | ProQueueAdditionFrame;

type OutgoingSignal =
  | { type: 'room-password-set'; password: string; pinMutationId: string }
  | ({
      type: 'remote-share-upload-assertion-request';
      correlationId: string;
    } & RemoteShareUploadAssertionRequest)
  | {
      type: 'signal-offer';
      to: 'host';
      sdp: RTCSessionDescriptionInit;
      negotiationId: string;
      metadata?: unknown;
    }
  | {
      type: 'signal-answer';
      to: string;
      sdp: RTCSessionDescriptionInit;
      negotiationId: string;
    }
  | {
      type: 'signal-candidate';
      to: string;
      candidate: RTCIceCandidateInit;
      negotiationId: string;
    }
  | {
      type: 'media-offer';
      to: string;
      callId: string;
      sdp: RTCSessionDescriptionInit;
      negotiationId: string;
      metadata?: Record<string, unknown>;
      audioTrackCount?: number;
    }
  | {
      type: 'media-answer';
      to: 'host';
      callId: string;
      sdp: RTCSessionDescriptionInit;
      negotiationId: string;
    }
  | { type: 'media-close'; to: string | 'host'; callId: string };

function normalizeStandardRoomMemberIdentity(value: unknown): StandardRoomMemberIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(',') !==
      'isAuthenticated,memberDisplayNumber,memberId,nickname' ||
    typeof candidate.memberId !== 'string' ||
    !/^member_[A-Za-z0-9_-]{22}$/.test(candidate.memberId) ||
    !Number.isSafeInteger(candidate.memberDisplayNumber) ||
    (candidate.memberDisplayNumber as number) < 0 ||
    (candidate.memberDisplayNumber as number) > 99 ||
    typeof candidate.nickname !== 'string' ||
    !candidate.nickname.trim() ||
    [...candidate.nickname].length > 20 ||
    candidate.isAuthenticated !== true
  ) {
    return null;
  }
  return {
    memberId: candidate.memberId,
    memberDisplayNumber: candidate.memberDisplayNumber as number,
    nickname: candidate.nickname.normalize('NFC').trim(),
    isAuthenticated: true,
  };
}

function normalizeStandardRoomIdentityAssertions(
  value: unknown,
): StandardRoomIdentityAssertions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const accountAssertion = candidate.accountAssertion;
  const deletionAssertion = candidate.deletionAssertion;
  if (
    (accountAssertion !== null &&
      (typeof accountAssertion !== 'string' ||
        accountAssertion.length < 3 ||
        accountAssertion.length > 2048)) ||
    (deletionAssertion !== null &&
      (typeof deletionAssertion !== 'string' ||
        deletionAssertion.length < 3 ||
        deletionAssertion.length > 2048)) ||
    (accountAssertion && deletionAssertion)
  ) {
    return null;
  }
  return {
    accountAssertion: accountAssertion as string | null,
    deletionAssertion: deletionAssertion as string | null,
  };
}

function hasExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function normalizeRemoteShareUploadAssertionResponse(
  value: unknown,
): Extract<SignalingMessage, { type: 'remote-share-upload-assertion' }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !hasExactObjectKeys(candidate, ['type', 'correlationId', 'assertion', 'expiresAt']) ||
    candidate.type !== 'remote-share-upload-assertion' ||
    typeof candidate.correlationId !== 'string' ||
    !REMOTE_SHARE_UPLOAD_ASSERTION_CORRELATION_ID_RE.test(candidate.correlationId) ||
    typeof candidate.assertion !== 'string' ||
    candidate.assertion.length < 64 ||
    candidate.assertion.length > REMOTE_SHARE_UPLOAD_ASSERTION_TOKEN_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate.assertion) ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    (candidate.expiresAt as number) <= 0
  ) {
    return null;
  }
  return {
    type: 'remote-share-upload-assertion',
    correlationId: candidate.correlationId,
    assertion: candidate.assertion,
    expiresAt: candidate.expiresAt as number,
  };
}

function normalizeRemoteShareUploadAssertionError(
  value: unknown,
): Extract<SignalingMessage, { type: 'remote-share-upload-assertion-error' }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !hasExactObjectKeys(candidate, ['type', 'correlationId', 'errorType']) ||
    candidate.type !== 'remote-share-upload-assertion-error' ||
    typeof candidate.correlationId !== 'string' ||
    !REMOTE_SHARE_UPLOAD_ASSERTION_CORRELATION_ID_RE.test(candidate.correlationId) ||
    typeof candidate.errorType !== 'string' ||
    !REMOTE_SHARE_UPLOAD_ASSERTION_ERROR_RE.test(candidate.errorType)
  ) {
    return null;
  }
  return {
    type: 'remote-share-upload-assertion-error',
    correlationId: candidate.correlationId,
    errorType: candidate.errorType,
  };
}

function isRemoteShareUploadAssertionRequest(value: RemoteShareUploadAssertionRequest): boolean {
  return (
    REMOTE_SHARE_UPLOAD_ACTOR_ID_RE.test(value.actorId) &&
    REMOTE_SHARE_UPLOAD_REQUEST_ID_RE.test(value.requestId) &&
    Number.isSafeInteger(value.sessionId) &&
    value.sessionId > 0 &&
    REMOTE_SHARE_UPLOAD_QUEUE_ITEM_ID_RE.test(value.queueItemId) &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    value.size <= 200 * 1024 * 1024 &&
    REMOTE_SHARE_UPLOAD_ASSERTION_BODY_SHA256_RE.test(value.bodySha256)
  );
}

/**
 * Durable "this session wants a signaling socket" record for a guest room.
 * roomSockets is a transient handle map whose close handler deletes the
 * entry, so reopen decisions must derive from this registry,
 * never from the socket map itself.
 */
interface GuestRoomRecord {
  conn: CloudflareDataConnection;
  metadata: unknown;
  password: string;
  /** Base signaling URL owned by this exact logical join generation. */
  signalingUrl: string;
  useHttpSignaling: boolean;
  routePlan: StandardSetupRoutePlan;
  socketGeneration: number;
  routeRetryGeneration: number;
  routeRetryCount: number;
  routeRetryController: AbortController | null;
  admissionTimeoutId: ReturnType<typeof globalThis.setTimeout> | null;
  /**
   * Set when the DO rejects our stored password on an established session
   * (mid-session rotation). Excludes the room from automatic reconnect; the
   * outer retry loop resets its budget on every 'disconnected', so without
   * this flag a stale password becomes an indefinite failed-auth hammer
   * against the DO rate limit. An explicit connect() re-join writes a fresh
   * record and re-arms reconnect.
   */
  authFailed: boolean;
}

interface RetiredSignalingSocketListeners {
  readonly open: EventListener;
  readonly close: EventListener;
  readonly error: EventListener;
}

type SignalingRoute = 'primary' | 'fallback' | 'http';
type StandardSignalingSocket = WebSocket | StandardHttpSignalingSocket;

interface StandardSetupRoutePlan {
  readonly preferredHttpFirst: boolean;
  readonly triedRoutes: Set<SignalingRoute>;
  routeBarrierConsumed: boolean;
}

type StandardSetupRouteFailure =
  | { readonly kind: 'error' }
  | { readonly kind: 'close'; readonly code: number; readonly wasClean: boolean }
  | { readonly kind: 'watchdog' };

interface StandardSetupRouteRetryDecision {
  readonly route: SignalingRoute;
  readonly signalingUrl: string | null;
  readonly prepareRoute: boolean;
}

interface SignalingSocketLifecycle {
  readonly route: SignalingRoute;
  readonly createdAt: number;
  everOpened: boolean;
  authSent: boolean;
  admitted: boolean;
  semanticFailureObserved: boolean;
  failureObserved: boolean;
  terminalCloseLogged: boolean;
  closeCode: number | null;
  closeClean: boolean | null;
}

interface QueuedIceCandidate {
  candidate: RTCIceCandidateInit;
  negotiationId: string;
  receivedAt: number;
  bytes: number;
}

interface PendingIceBucket {
  candidates: QueuedIceCandidate[];
  bytes: number;
  updatedAt: number;
}

interface IceNegotiationOwner {
  generation: number;
  peerId: string;
  pc: RTCPeerConnection;
  purpose: 'signal' | 'media';
  callId: string | null;
  negotiationId: string;
  remoteUfrag: string | null;
  candidates: QueuedIceCandidate[];
  bytes: number;
  createdAt: number;
  settled: boolean;
}

// ICE candidates are small signaling records, unrelated to media/file size.
// These deliberately generous limits protect a pathological pre-description
// queue without rejecting normal multi-interface/relay candidate gathering.
const ICE_QUEUE_TTL_MS = 120_000;
const ICE_QUEUE_MEMORY_BUDGET_BYTES = 4 * 1024 * 1024;
const ICE_QUEUE_MEMORY_RETAIN_BYTES = 3 * 1024 * 1024;
const ICE_QUEUE_PRUNE_INTERVAL_MS = 5_000;
const ICE_NEGOTIATION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
// Standard-room attach assertions and the Worker's derived identity lease both
// expire after 60 seconds. Admission stays bounded at two seconds so optional
// account I/O cannot delay joining, while an already-admitted socket renews
// early and may use the account client's full request budget. Sharing the
// admission cutoff here used to discard healthy-but-slow renewals, letting the
// Worker expire the lease and briefly revoke same-account controls.
const STANDARD_ROOM_IDENTITY_RENEW_INTERVAL_MS = 30_000;
const STANDARD_ROOM_IDENTITY_RETRY_MS = 5_000;
const STANDARD_ROOM_ASSERTION_ADMISSION_WAIT_MS = 2_000;
const STANDARD_ROOM_ASSERTION_RENEWAL_WAIT_MS = 15_000;
const STANDARD_ROOM_SETUP_ROUTE_RETRY_LIMIT = 2;
const STANDARD_ROOM_SETUP_ADMISSION_TIMEOUT_MS = 3_000;
const STANDARD_ROOM_HTTP_SETUP_ADMISSION_TIMEOUT_MS = 8_000;
const STANDARD_ROOM_HTTP_PREFERENCE_TTL_MS = 5 * 60_000;
const STANDARD_ROOM_FALLBACK_PEER_OPEN_TIMEOUT_MS = 25_000;
// Primary and alternate WSS each receive three seconds, then the same-origin
// HTTP bridge receives its separate eight-second admission window. Preserve a
// bounded remainder for ICE/data-channel establishment without extending
// PeerJS, PRO, or Standard rooms that have no alternate route.
const STANDARD_ROOM_FALLBACK_GUEST_PRE_OPEN_TIMEOUT_MS = 20_000;
// A setup attempt may transiently own primary WSS, alternate WSS, and the HTTP
// bridge while WebKit delays physical close events. Eight page-wide handles
// leave room for overlapping teardown generations while bounding handles that
// never leave CONNECTING/CLOSING.
const MAX_PAGE_SIGNALING_SOCKET_HANDLES = 8;
const REMOTE_SHARE_UPLOAD_ASSERTION_TIMEOUT_MS = 5_000;
const REMOTE_SHARE_UPLOAD_ASSERTION_TOKEN_MAX_LENGTH = 4096;
const REMOTE_SHARE_UPLOAD_ASSERTION_CORRELATION_ID_RE = /^rsaq_[A-Za-z0-9_-]{32}$/;
const REMOTE_SHARE_UPLOAD_ASSERTION_ERROR_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const REMOTE_SHARE_UPLOAD_ASSERTION_BODY_SHA256_RE = /^[A-Za-z0-9_-]{43}$/;
const REMOTE_SHARE_UPLOAD_ACTOR_ID_RE = /^rsa_[A-Za-z0-9_-]{43}$/;
const REMOTE_SHARE_UPLOAD_REQUEST_ID_RE = /^rs3_[A-Za-z0-9_-]{43}$/;
const REMOTE_SHARE_UPLOAD_QUEUE_ITEM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PendingRemoteShareUploadAssertion {
  readonly socket: StandardSignalingSocket;
  readonly resolve: (assertion: string | null) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutId: ReturnType<typeof globalThis.setTimeout>;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

const pageSignalingSocketCloseListeners = new Map<StandardSignalingSocket, EventListener>();
let standardHttpPreferenceDeadline = 0;
let standardHttpPreferenceNow = (): number => globalThis.performance.now();

function monotonicStandardHttpPreferenceNow(): number | null {
  try {
    const now = standardHttpPreferenceNow();
    return Number.isFinite(now) ? Math.max(0, now) : null;
  } catch {
    return null;
  }
}

function hasStandardHttpPreference(): boolean {
  if (standardHttpPreferenceDeadline === 0) return false;
  const now = monotonicStandardHttpPreferenceNow();
  if (now !== null && now < standardHttpPreferenceDeadline) return true;
  standardHttpPreferenceDeadline = 0;
  return false;
}

function promoteStandardHttpPreference(): void {
  // Non-sliding by design: repeated HTTP admissions inside the same window do
  // not keep a stale network-route decision alive indefinitely.
  if (hasStandardHttpPreference()) return;
  const now = monotonicStandardHttpPreferenceNow();
  if (now === null) return;
  standardHttpPreferenceDeadline = now + STANDARD_ROOM_HTTP_PREFERENCE_TTL_MS;
}

function clearStandardHttpPreference(): void {
  standardHttpPreferenceDeadline = 0;
}

function createStandardSetupRoutePlan(preferredHttpFirst: boolean): StandardSetupRoutePlan {
  return {
    preferredHttpFirst,
    triedRoutes: new Set<SignalingRoute>(),
    routeBarrierConsumed: false,
  };
}

function decideStandardSetupRouteRetry(
  plan: StandardSetupRoutePlan,
  failedRoute: SignalingRoute,
  primarySignalingUrl: string,
  fallbackSignalingUrl: string | null,
  retryCount: number,
): StandardSetupRouteRetryDecision | null {
  let route: SignalingRoute;
  let signalingUrl: string | null;

  if (failedRoute === 'http') {
    if (!plan.preferredHttpFirst || plan.triedRoutes.has('primary')) return null;
    route = 'primary';
    signalingUrl = primarySignalingUrl;
  } else if (failedRoute === 'primary') {
    if (fallbackSignalingUrl !== null && !plan.triedRoutes.has('fallback')) {
      route = 'fallback';
      signalingUrl = fallbackSignalingUrl;
    } else if (fallbackSignalingUrl === null && retryCount === 0) {
      // Preserve the established one-shot same-origin WSS readoption for
      // deployments that intentionally have no alternate route.
      route = 'primary';
      signalingUrl = primarySignalingUrl;
    } else {
      return null;
    }
  } else {
    if (plan.preferredHttpFirst || plan.triedRoutes.has('http')) return null;
    route = 'http';
    signalingUrl = null;
  }

  const prepareRoute = route !== 'http' && !plan.routeBarrierConsumed;
  if (prepareRoute) plan.routeBarrierConsumed = true;
  return { route, signalingUrl, prepareRoute };
}

function isGenuineStandardSetupRouteFailure(
  socket: StandardSignalingSocket,
  failure: StandardSetupRouteFailure,
  semanticFailureObserved: boolean,
): boolean {
  if (semanticFailureObserved) return false;
  if (failure.kind === 'watchdog') return true;
  if (!isStandardHttpSignalingSocket(socket)) {
    return failure.kind !== 'close' || failure.code < 4000;
  }
  if (failure.kind === 'close') {
    return !failure.wasClean && failure.code >= 1001 && failure.code < 4000;
  }
  const status = socket.diagnostic?.status ?? null;
  return (
    status === null ||
    (status >= 200 && status < 300) ||
    status === 404 ||
    status === 405 ||
    status === 408 ||
    status === 409 ||
    status === 410 ||
    status >= 500
  );
}

function shouldClearPreferredHttpAfterFailure(
  socket: StandardSignalingSocket,
  failure: StandardSetupRouteFailure,
  semanticFailureObserved: boolean,
): boolean {
  if (!isStandardHttpSignalingSocket(socket) || semanticFailureObserved) return false;
  if (failure.kind !== 'close') return true;
  // Application-defined terminal codes are authoritative room semantics. The
  // bridge's abnormal transport/service closes live below that range.
  return !failure.wasClean && failure.code < 4000;
}

function releasePageSignalingSocket(socket: StandardSignalingSocket): void {
  const closeListener = pageSignalingSocketCloseListeners.get(socket);
  if (!closeListener) return;
  pageSignalingSocketCloseListeners.delete(socket);
  socket.removeEventListener('close', closeListener);
}

function trackPageSignalingSocket(socket: StandardSignalingSocket): void {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closeListener: EventListener = () => releasePageSignalingSocket(socket);
  pageSignalingSocketCloseListeners.set(socket, closeListener);
  socket.addEventListener('close', closeListener);
}

function pruneClosedPageSignalingSockets(): void {
  for (const socket of pageSignalingSocketCloseListeners.keys()) {
    try {
      if (socket.readyState === WebSocket.CLOSED) releasePageSignalingSocket(socket);
    } catch {
      // An unreadable non-terminal handle remains charged against the cap.
    }
  }
}

function signalingSocketReadyStateDiagnostic(socket: StandardSignalingSocket): {
  readyState: number | null;
  readyStateName: 'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'UNKNOWN';
  closeSuppressed: boolean;
} {
  let readyState: number | null = null;
  try {
    readyState = socket.readyState;
  } catch {
    // Diagnostics must not alter retry ownership if a browser wrapper throws.
  }
  const readyStateName =
    readyState === WebSocket.CONNECTING
      ? 'CONNECTING'
      : readyState === WebSocket.OPEN
        ? 'OPEN'
        : readyState === WebSocket.CLOSING
          ? 'CLOSING'
          : readyState === WebSocket.CLOSED
            ? 'CLOSED'
            : 'UNKNOWN';
  return {
    readyState,
    readyStateName,
    closeSuppressed: readyState === WebSocket.CONNECTING || readyState === WebSocket.CLOSING,
  };
}

export const __cloudflareSignalingForTests = {
  maxPageSignalingSocketHandles: MAX_PAGE_SIGNALING_SOCKET_HANDLES,
  standardHttpPreferenceTtlMs: STANDARD_ROOM_HTTP_PREFERENCE_TTL_MS,
  hasStandardHttpPreference,
  promoteStandardHttpPreference,
  clearStandardHttpPreference,
  setStandardHttpPreferenceNow(now: (() => number) | null): void {
    standardHttpPreferenceNow = now ?? (() => globalThis.performance.now());
  },
  pageSignalingSocketHandleCount(): number {
    pruneClosedPageSignalingSockets();
    return pageSignalingSocketCloseListeners.size;
  },
  resetPageSignalingSocketHandles(): void {
    for (const [socket, closeListener] of pageSignalingSocketCloseListeners) {
      socket.removeEventListener('close', closeListener);
    }
    pageSignalingSocketCloseListeners.clear();
  },
  resetStandardHttpPreference(): void {
    clearStandardHttpPreference();
    standardHttpPreferenceNow = () => globalThis.performance.now();
  },
};

function parseIceNegotiationId(value: unknown): string | null {
  return typeof value === 'string' && ICE_NEGOTIATION_ID_RE.test(value) ? value : null;
}

function remoteIceUfrag(description: RTCSessionDescriptionInit): string | null {
  const match = /(?:^|\r?\n)a=ice-ufrag:([^\r\n]+)/m.exec(description.sdp ?? '');
  return match?.[1]?.trim() || null;
}

function candidateIceUfrag(candidate: RTCIceCandidateInit): string | null {
  if (typeof candidate.usernameFragment === 'string' && candidate.usernameFragment) {
    return candidate.usernameFragment;
  }
  const match = /(?:^|\s)ufrag\s+([^\s]+)/.exec(candidate.candidate ?? '');
  return match?.[1]?.trim() || null;
}

function candidateMatchesRemoteUfrag(
  candidate: RTCIceCandidateInit,
  remoteUfrag: string | null,
): boolean {
  const candidateUfrag = candidateIceUfrag(candidate);
  return !candidateUfrag || !remoteUfrag || candidateUfrag === remoteUfrag;
}

const DATA_CHANNEL_LABEL = 'musixquare-data';
const CONTROL_CHANNEL_LABEL = 'musixquare-control';
const BINARY_CHUNK_SENTINEL = '__mxqrBinaryChunk';
const BINARY_HEADER_MAX_BYTES = 16 * 1024;
const DATA_CHANNEL_TEXT_MAX_CODE_UNITS = 16 * 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function randomBase64Url(bytes = 18): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let raw = '';
  for (const byte of data) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomResumeProbePingId(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  // Reserve the upper half of the safe-integer range so this transport-owned
  // probe cannot realistically collide with the app sync counter.
  return 2 ** 52 + ((words[0] ?? 0) & 0xfffff) * 2 ** 32 + (words[1] ?? 0);
}

interface ProTicketClaims {
  roomCode: string;
  participantId: string;
  role: 'coordinator' | 'member';
  coordinatorEpoch: number;
  presenceIncarnationId: string;
  ticketSequence: number;
}

function proTicketClaims(ticket: string): ProTicketClaims | null {
  const encoded = ticket.split('.')[0];
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const padding = '='.repeat((4 - (encoded.length % 4)) % 4);
    const raw = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + padding);
    const payload = JSON.parse(
      textDecoder.decode(Uint8Array.from(raw, (character) => character.charCodeAt(0))),
    ) as Partial<ProTicketClaims>;
    if (
      typeof payload.roomCode !== 'string' ||
      !/^\d{6}$/.test(payload.roomCode) ||
      typeof payload.participantId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,96}$/.test(payload.participantId) ||
      (payload.role !== 'coordinator' && payload.role !== 'member') ||
      !Number.isSafeInteger(payload.coordinatorEpoch) ||
      (payload.coordinatorEpoch ?? 0) < 1 ||
      typeof payload.presenceIncarnationId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(payload.presenceIncarnationId) ||
      !Number.isSafeInteger(payload.ticketSequence) ||
      (payload.ticketSequence ?? 0) < 1
    ) {
      return null;
    }
    return payload as ProTicketClaims;
  } catch {
    return null;
  }
}

function createTransportError(type: string, message: string): Error & { type: string } {
  const err = new Error(message) as Error & { type: string };
  err.type = type;
  return err;
}

function isPermanentGuestAuthError(errorType: string | undefined): boolean {
  return errorType?.startsWith('room-password-') === true || errorType === 'guest-reconnect-denied';
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function encodePayload(data: unknown): string | ArrayBuffer {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const chunk = toUint8Array(record.chunk);
    if (chunk) {
      const header = { ...record, chunk: { [BINARY_CHUNK_SENTINEL]: true } };
      const headerBytes = textEncoder.encode(JSON.stringify(header));
      if (headerBytes.byteLength > BINARY_HEADER_MAX_BYTES || chunk.byteLength > CHUNK_SIZE) {
        throw new Error('DATA_CHANNEL_BINARY_FRAME_TOO_LARGE');
      }
      const frame = new Uint8Array(4 + headerBytes.byteLength + chunk.byteLength);
      new DataView(frame.buffer).setUint32(0, headerBytes.byteLength, false);
      frame.set(headerBytes, 4);
      frame.set(chunk, 4 + headerBytes.byteLength);
      return frame.buffer;
    }
  }
  return JSON.stringify(data);
}

function decodeBinaryPayload(frame: ArrayBuffer): unknown {
  if (frame.byteLength < 4) throw new Error('INVALID_BINARY_FRAME');
  const view = new DataView(frame);
  const headerLength = view.getUint32(0, false);
  if (
    headerLength <= 0 ||
    headerLength > BINARY_HEADER_MAX_BYTES ||
    headerLength > frame.byteLength - 4
  ) {
    throw new Error('INVALID_BINARY_HEADER');
  }
  if (frame.byteLength - 4 - headerLength > CHUNK_SIZE) {
    throw new Error('INVALID_BINARY_BODY');
  }
  const bytes = new Uint8Array(frame);
  const headerJson = textDecoder.decode(bytes.slice(4, 4 + headerLength));
  const payload = JSON.parse(headerJson) as Record<string, unknown>;
  const chunkMarker = payload.chunk as Record<string, unknown> | undefined;
  const isChunk = chunkMarker?.[BINARY_CHUNK_SENTINEL] === true;
  if (!isChunk) throw new Error('INVALID_BINARY_MARKER');
  const body = bytes.slice(4 + headerLength);
  payload.chunk = body;
  return payload;
}

async function decodePayload(data: unknown): Promise<unknown> {
  if (typeof data === 'string') {
    if (data.length > DATA_CHANNEL_TEXT_MAX_CODE_UNITS) {
      throw new Error('DATA_CHANNEL_TEXT_FRAME_TOO_LARGE');
    }
    return JSON.parse(data);
  }
  if (data instanceof ArrayBuffer) return decodeBinaryPayload(data);
  if (data instanceof Blob) {
    if (data.size > 4 + BINARY_HEADER_MAX_BYTES + CHUNK_SIZE) {
      throw new Error('DATA_CHANNEL_BINARY_FRAME_TOO_LARGE');
    }
    return decodeBinaryPayload(await data.arrayBuffer());
  }
  return data;
}

function isBulkPayload(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const payload = data as Record<string, unknown>;
  if (toUint8Array(payload.chunk)) return true;

  // File chunks are carried by the ordered bulk channel. Keep both terminal
  // fences on that same channel as well: ordering is guaranteed within one
  // RTCDataChannel, but not between the bulk and control channels. Receivers
  // continue accepting these messages from either channel, so old senders
  // remain compatible while upgraded senders cannot overtake their last chunk.
  return payload.type === MSG.FILE_END || payload.type === MSG.OPERATOR_FILE_UPLOAD_FINISH;
}

function isBenignDataChannelCloseError(event: Event): boolean {
  const error = (event as Event & { error?: { message?: unknown; name?: unknown } }).error;
  return (
    error?.name === 'OperationError' &&
    typeof error.message === 'string' &&
    /(?:reason\s*=\s*)?Close called/iu.test(error.message)
  );
}

let cloudflareDataConnectionSequence = 0;

const DATA_CONNECTION_DISCONNECTED_GRACE_MS = 15_000;
const BACKGROUND_RESUME_DISCONNECTED_PROBE_MS = 1_000;
const BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS = 3_000;

export class CloudflareDataConnection extends TinyEmitter implements TransportDataConnection {
  open = false;
  peerConnection?: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  controlChannel?: RTCDataChannel;
  private closed = false;
  private intentionalClosing = false;
  private pcListenersAttached = false;
  private resourcesDisposed = false;
  private readonly disconnectedGraceTimerKey = `cloudflare-data-disconnected-grace-${++cloudflareDataConnectionSequence}`;
  private readonly backgroundResumeLivenessTimerKey = `${this.disconnectedGraceTimerKey}-background-resume-liveness`;
  private readonly backgroundResumeDisconnectedTimerKey = `${this.disconnectedGraceTimerKey}-background-resume-disconnected`;
  private backgroundResumeRecoveryArmed = false;
  private backgroundResumeProbePingId: number | null = null;
  private backgroundResumeSawDisconnected = false;

  constructor(
    readonly peer: string,
    readonly metadata?: unknown,
    public roomIdentity: StandardRoomMemberIdentity | null = null,
    private readonly onConnectionStateChange?: () => void,
    readonly recommendedPreOpenTimeoutMs?: number,
  ) {
    super();
  }

  updateRoomIdentity(
    identity: StandardRoomMemberIdentity | null,
    clearReason?: StandardRoomIdentityClearReason,
  ): void {
    this.roomIdentity = identity;
    this.emit('identity', identity, clearReason);
  }

  attach(pc: RTCPeerConnection, channel: RTCDataChannel): boolean {
    this.peerConnection = pc;
    const isControl = channel.label === CONTROL_CHANNEL_LABEL;
    if (isControl) this.controlChannel = channel;
    else this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';

    channel.addEventListener('open', () => {
      this.markOpenIfReady();
    });
    channel.addEventListener('message', (event) => {
      decodePayload(event.data)
        .then((payload) => {
          // A connection that WebKit reports as connected/open can still be a
          // frozen SCTP association. Only the exact reply to our post-resume
          // challenge proves that this connection reaches the live host. Other
          // frames may have been queued before the app was suspended.
          if (this.isBackgroundResumeProbePong(payload)) {
            this.clearBackgroundResumeRecovery();
          }
          this.emit('data', payload);
        })
        .catch((error) => this.emit('error', error));
    });
    channel.addEventListener('close', () => {
      this.terminate();
    });
    channel.addEventListener('error', (event) => {
      // Chromium can synchronously report `OperationError: ... Close called`
      // while an application-requested RTCDataChannel.close() is in progress,
      // including when one remotely closed channel makes us dispose its
      // still-open sibling. Those are lifecycle notifications, not a second
      // failed live connection.
      if (
        this.closed ||
        this.intentionalClosing ||
        this.resourcesDisposed ||
        isBenignDataChannelCloseError(event)
      ) {
        return;
      }
      this.emit('error', event);
    });

    if (!this.pcListenersAttached) {
      this.pcListenersAttached = true;
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') {
          this.cancelDisconnectedGrace();
          // A genuine disconnected -> connected transition is ICE-level proof.
          // A redundant connected event on a stale WebKit object is not.
          if (!this.backgroundResumeRecoveryArmed || this.backgroundResumeSawDisconnected) {
            this.clearBackgroundResumeRecovery();
          }
          this.onConnectionStateChange?.();
          return;
        }
        if (pc.connectionState === 'disconnected') {
          // Let the peer combine this RTC transition with its signaling state
          // before granting a fresh grace period. A long-hidden outage may
          // already have consumed the entire grace while WebKit was suspended.
          this.reconcileBackgroundResumeRecovery(false);
          this.onConnectionStateChange?.();
          if (this.closed) return;
          this.scheduleDisconnectedGrace(pc);
          return;
        }
        if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
          this.terminate();
        }
      });
    }

    if (channel.readyState === 'open') queueMicrotask(() => this.markOpenIfReady());
    return !isControl;
  }

  send(data: unknown): void {
    // Keep latency-sensitive control frames (PLAY/PAUSE/SYNC/etc.) off the
    // ordered bulk stream. iOS can throttle a backgrounded receiver while file
    // chunks keep queuing; sharing one stream lets playback commands sit behind
    // those chunks for seconds after the app returns.
    const bulk = isBulkPayload(data);
    const channel = bulk ? this.dataChannel : this.controlChannel;
    if (!this.open || !channel || channel.readyState !== 'open') {
      throw createTransportError('webrtc', 'DATA_CHANNEL_NOT_OPEN');
    }
    const encoded = encodePayload(data);
    if (typeof encoded === 'string') channel.send(encoded);
    else channel.send(encoded);
  }

  close(): void {
    if (!this.intentionalClosing) this.intentionalClosing = true;
    this.terminate();
  }

  recoverAfterBackground(
    hiddenMs: number,
    signalingDisconnected: boolean,
  ): TransportBackgroundRecoveryStatus {
    if (
      this.closed ||
      !this.open ||
      !Number.isFinite(hiddenMs) ||
      hiddenMs < DATA_CONNECTION_DISCONNECTED_GRACE_MS
    ) {
      return 'not-applicable';
    }

    this.backgroundResumeRecoveryArmed = true;
    this.backgroundResumeSawDisconnected = false;
    this.backgroundResumeProbePingId = randomResumeProbePingId();
    // visibilitychange can run while WebKit still reports a dead RTC object as
    // connected/open. Require a bounded, connection-bound SYNC_PONG instead of
    // trusting that cached state. Existing hosts already answer SYNC_PING, so
    // the liveness challenge remains compatible across a rolling static deploy.
    setManagedTimer(
      this.backgroundResumeLivenessTimerKey,
      () => {
        if (this.backgroundResumeRecoveryArmed && !this.closed) this.terminate();
      },
      BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS,
    );
    const status = this.reconcileBackgroundResumeRecovery(signalingDisconnected);
    if (status === 'stale-connection-closed') return status;

    try {
      this.send({
        type: MSG.SYNC_PING,
        pingId: this.backgroundResumeProbePingId,
        guestTime: Date.now(),
      });
    } catch {
      this.terminate();
      return 'stale-connection-closed';
    }
    return status;
  }

  reconcileBackgroundResumeRecovery(
    signalingDisconnected: boolean,
  ): TransportBackgroundRecoveryStatus {
    if (this.closed || !this.backgroundResumeRecoveryArmed) return 'not-applicable';

    const rtcState = this.peerConnection?.connectionState;
    const rtcTerminal = !this.peerConnection || rtcState === 'failed' || rtcState === 'closed';
    const dataChannelsUnhealthy =
      this.dataChannel?.readyState !== 'open' || this.controlChannel?.readyState !== 'open';

    // Terminal RTC/data-channel state is already conclusive after an absence
    // longer than the ordinary grace. A disconnected PC with open channels is
    // less certain: iOS can briefly report it while restoring the radio, so
    // give that foreground hand-off one bounded probe instead of another full
    // 15-second grace. Lost signaling strengthens the stale-session evidence
    // and makes that probe unnecessary, but is deliberately not required: the
    // room worker retains guest signaling for the host's 60-second reclaim
    // window even after the host transport has gone away.
    if (rtcTerminal || dataChannelsUnhealthy) {
      this.terminate();
      return 'stale-connection-closed';
    }

    if (rtcState === 'connected') {
      return 'monitoring';
    }

    if (rtcState === 'disconnected') {
      this.backgroundResumeSawDisconnected = true;
      if (signalingDisconnected) {
        this.terminate();
        return 'stale-connection-closed';
      }
      setManagedTimer(
        this.backgroundResumeDisconnectedTimerKey,
        () => {
          if (!this.backgroundResumeRecoveryArmed || this.closed) return;
          const currentState = this.peerConnection?.connectionState;
          const channelsOpen =
            this.dataChannel?.readyState === 'open' && this.controlChannel?.readyState === 'open';
          if (currentState === 'connected' && channelsOpen) {
            // A state transition event or the nonce reply clears recovery. If
            // WebKit silently mutates the property, keep waiting for the reply.
            return;
          }
          this.terminate();
        },
        BACKGROUND_RESUME_DISCONNECTED_PROBE_MS,
      );
    }

    return 'monitoring';
  }

  clearBackgroundResumeRecovery(): void {
    this.backgroundResumeRecoveryArmed = false;
    this.backgroundResumeProbePingId = null;
    this.backgroundResumeSawDisconnected = false;
    clearManagedTimer(this.backgroundResumeLivenessTimerKey);
    clearManagedTimer(this.backgroundResumeDisconnectedTimerKey);
  }

  private isBackgroundResumeProbePong(payload: unknown): boolean {
    if (this.backgroundResumeProbePingId === null || !payload || typeof payload !== 'object') {
      return false;
    }
    const record = payload as Record<string, unknown>;
    return record.type === MSG.SYNC_PONG && record.pingId === this.backgroundResumeProbePingId;
  }

  private terminate(): void {
    this.cancelDisconnectedGrace();
    this.clearBackgroundResumeRecovery();
    this.disposeResources();
    this.markClosed();
  }

  private disposeResources(): void {
    if (this.resourcesDisposed) return;
    this.resourcesDisposed = true;
    try {
      this.dataChannel?.close();
    } catch {
      /* noop */
    }
    try {
      this.controlChannel?.close();
    } catch {
      /* noop */
    }
    try {
      this.peerConnection?.close();
    } catch {
      /* noop */
    }
  }

  private scheduleDisconnectedGrace(pc: RTCPeerConnection): void {
    if (this.closed || getManagedTimer(this.disconnectedGraceTimerKey) !== null) return;
    setManagedTimer(
      this.disconnectedGraceTimerKey,
      () => {
        if (pc !== this.peerConnection || pc.connectionState !== 'disconnected') return;
        this.terminate();
      },
      DATA_CONNECTION_DISCONNECTED_GRACE_MS,
    );
  }

  private cancelDisconnectedGrace(): void {
    clearManagedTimer(this.disconnectedGraceTimerKey);
  }

  private markOpenIfReady(): void {
    if (this.closed || this.open) return;
    if (this.dataChannel?.readyState !== 'open' || this.controlChannel?.readyState !== 'open') {
      return;
    }
    this.open = true;
    this.emit('open');
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
    this.clear();
  }
}

class CloudflareMediaConnection extends TinyEmitter implements TransportMediaConnection {
  peerConnection?: RTCPeerConnection;
  private closed = false;
  private remoteOffer: RTCSessionDescriptionInit | null = null;
  private readonly remoteStream = new MediaStream();
  private remoteStreamEmitted = false;
  private remoteStreamTimerActive = false;
  private readonly localSenders: RTCRtpSender[] = [];
  private trackListener: ((event: RTCTrackEvent) => void) | null = null;
  private answerHandler:
    | ((mediaConn: CloudflareMediaConnection, stream?: MediaStream) => Promise<void>)
    | null = null;
  private closeHandler:
    | ((mediaConn: CloudflareMediaConnection, notifyRemote: boolean) => void)
    | null = null;

  constructor(
    readonly peer: string,
    readonly callId: string,
    readonly metadata: Record<string, unknown> | undefined,
    private readonly expectedAudioTrackCount: number,
  ) {
    super();
  }

  attachPeerConnection(pc: RTCPeerConnection): void {
    this.peerConnection = pc;
    this.trackListener = (event) => this.handleTrack(event);
    pc.addEventListener('track', this.trackListener);
  }

  setRemoteOffer(offer: RTCSessionDescriptionInit): void {
    this.remoteOffer = offer;
  }

  getRemoteOffer(): RTCSessionDescriptionInit | null {
    return this.remoteOffer;
  }

  setAnswerHandler(
    handler: (mediaConn: CloudflareMediaConnection, stream?: MediaStream) => Promise<void>,
  ): void {
    this.answerHandler = handler;
  }

  setCloseHandler(
    handler: (mediaConn: CloudflareMediaConnection, notifyRemote: boolean) => void,
  ): void {
    this.closeHandler = handler;
  }

  addLocalStream(stream: MediaStream): void {
    const pc = this.peerConnection;
    if (!pc) throw createTransportError('webrtc', 'MEDIA_PEER_CONNECTION_MISSING');
    for (const track of stream.getTracks()) {
      this.localSenders.push(pc.addTrack(track, stream));
    }
  }

  answer(stream?: MediaStream): void {
    if (!this.answerHandler) return;
    this.answerHandler(this, stream).catch((error) => this.emit('error', error));
  }

  close(): void {
    this.closeInternal(true);
  }

  closeFromRemote(): void {
    this.closeInternal(false);
  }

  private closeInternal(notifyRemote: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (this.remoteStreamTimerActive) {
      clearManagedTimer(this.remoteStreamTimerName());
      this.remoteStreamTimerActive = false;
    }
    const pc = this.peerConnection;
    if (pc) {
      for (const sender of this.localSenders) {
        try {
          pc.removeTrack(sender);
        } catch {
          /* noop */
        }
      }
      if (this.trackListener) {
        pc.removeEventListener('track', this.trackListener);
        this.trackListener = null;
      }
    }
    this.localSenders.length = 0;
    this.closeHandler?.(this, notifyRemote);
    this.emit('close');
    this.clear();
  }

  private handleTrack(event: RTCTrackEvent): void {
    if (this.closed || event.track.kind !== 'audio') return;

    const incomingStream = event.streams[0];
    const tracks = incomingStream?.getAudioTracks() ?? [event.track];
    for (const track of tracks) {
      if (!this.remoteStream.getTracks().some((existing) => existing.id === track.id)) {
        this.remoteStream.addTrack(track);
      }
    }

    event.track.addEventListener('ended', () => {
      if (this.remoteStream.getAudioTracks().every((track) => track.readyState === 'ended')) {
        this.closeFromRemote();
      }
    });

    this.scheduleRemoteStreamEmit();
  }

  private scheduleRemoteStreamEmit(): void {
    if (this.remoteStreamEmitted) return;
    const actual = this.remoteStream.getAudioTracks().length;
    const expected = Math.max(1, this.expectedAudioTrackCount || 1);
    if (actual >= expected) {
      this.emitRemoteStream();
      return;
    }

    if (this.remoteStreamTimerActive) return;
    this.remoteStreamTimerActive = true;
    setManagedTimer(
      this.remoteStreamTimerName(),
      () => {
        this.remoteStreamTimerActive = false;
        this.emitRemoteStream();
      },
      180,
    );
  }

  private emitRemoteStream(): void {
    if (this.closed || this.remoteStreamEmitted) return;
    this.remoteStreamEmitted = true;
    this.emit('stream', this.remoteStream);
  }

  private remoteStreamTimerName(): string {
    return `cloudflare-media-stream-${this.callId}`;
  }
}

export class CloudflareSignalingPeer extends TinyEmitter implements TransportPeer {
  id?: string;
  open = false;
  destroyed = false;
  disconnected = false;

  private readonly connections = new Map<string, CloudflareDataConnection>();
  private readonly mediaCalls = new Map<string, CloudflareMediaConnection>();
  // Early candidates are isolated by both peer and mandatory negotiation ID.
  private readonly pendingCandidates = new Map<string, Map<string, PendingIceBucket>>();
  private readonly iceNegotiations = new Map<string, IceNegotiationOwner>();
  private iceNegotiationGeneration = 0;
  private lastIceQueuePruneAt = 0;
  private readonly roomSockets = new Map<string, StandardSignalingSocket>();
  private readonly guestRooms = new Map<string, GuestRoomRecord>();
  /**
   * Physical sockets whose logical authority has already been revoked.
   *
   * WebKit/CFNetwork can poison every later WebSocket in the app process when
   * close() is called while a socket is still CONNECTING. Keep those sockets
   * strongly owned instead: if one eventually opens, close it from OPEN; once
   * it actually closes, release its retirement listeners. A non-terminal error
   * is only observed because WebKit may leave readyState at CONNECTING. This
   * registry is intentionally independent from hostSocket/roomSockets, whose
   * entries are authority handles rather than physical-lifetime handles.
   */
  private readonly retiredSignalingSockets = new Map<WebSocket, RetiredSignalingSocketListeners>();
  private readonly signalingSocketLifecycles = new WeakMap<
    StandardSignalingSocket,
    SignalingSocketLifecycle
  >();
  /** RAM-only per-room proof; survives conn replacement but never a page reload. */
  private readonly guestReconnectSecrets = new Map<string, string>();
  private rtcConfiguration: RTCConfiguration;
  private readonly rtcConfigurationReady: Promise<void>;
  private rtcConfigurationPending: boolean;
  private resolveRtcConfigurationReady: (() => void) | null = null;
  private hostSocket: StandardSignalingSocket | null = null;
  private readonly primarySignalingUrl: string;
  private readonly fallbackSignalingUrl: string | null;
  private hostSignalingUrl: string;
  private hostSocketGeneration = 0;
  private hostRouteRetryGeneration = 0;
  private hostRouteRetryCount = 0;
  private hostRouteRetryController: AbortController | null = null;
  private hostUseHttpSignaling = false;
  private hostRoutePlan = createStandardSetupRoutePlan(false);
  private hostSignalingOpenedOnce = false;
  private hostAdmissionTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly hostRoomId: string | null;
  private readonly hostSecret = randomBase64Url(24);
  private readonly proParticipantId: string | null;
  private proSignalingAccess: ProSignalingOptions | null;
  private roomPassword: string | null = null;
  private roomPasswordMutationId = randomBase64Url(24);
  private acknowledgedRoomPasswordMutationId: string | null = null;
  private acknowledgedRoomPasswordSocket: StandardSignalingSocket | null = null;
  private readonly standardRoomIdentityRefreshTimerKey = 'standard-room-identity-refresh';
  private readonly standardRoomIdentityDeletionReconcileTimerKey =
    'standard-room-identity-deletion-reconcile';
  private readonly standardRoomIdentityDeletionProofs = new Map<string, string>();
  private readonly standardRoomIdentityAdmittedHostSockets = new WeakSet<StandardSignalingSocket>();
  private readonly standardRoomIdentityAdmittedGuestSockets =
    new WeakSet<StandardSignalingSocket>();
  private readonly standardRoomIdentityRefreshAfterGuestAdmission =
    new WeakSet<StandardSignalingSocket>();
  private readonly standardRoomIdentityActiveRefreshGenerations = new Set<number>();
  private standardRoomIdentityRefreshGeneration = 0;
  private remoteShareUploadAssertionStatus:
    | 'unknown'
    | 'unsupported'
    | 'supported'
    | 'unavailable' = 'unknown';
  private remoteShareUploadAssertionObserved = false;
  private readonly pendingRemoteShareUploadAssertions = new Map<
    string,
    PendingRemoteShareUploadAssertion
  >();
  private hostMessageSequence = 0;
  private readonly peerOfferSequences = new Map<string, number>();
  private readonly peerDepartureSequences = new Map<string, number>();
  private readonly peerIdentityProjections = new Map<
    string,
    {
      sequence: number;
      identity: StandardRoomMemberIdentity | null;
      clearReason?: StandardRoomIdentityClearReason;
    }
  >();

  private readonly signalingLiveness = new SignalingSocketLivenessMonitor((socket) => {
    this.retireHostSignalingSocket(socket, true);
  });

  get recommendedPeerOpenTimeoutMs(): number | undefined {
    return !this.proSignalingAccess &&
      this.fallbackSignalingUrl !== null &&
      !!this.options.prepareNetworkRouteRetry
      ? STANDARD_ROOM_FALLBACK_PEER_OPEN_TIMEOUT_MS
      : undefined;
  }

  private nextHostMessageSequence(): number {
    this.hostMessageSequence += 1;
    return this.hostMessageSequence;
  }

  private rememberPeerIdentityProjection(
    peerId: string,
    sequence: number,
    identity: StandardRoomMemberIdentity | null,
    clearReason?: StandardRoomIdentityClearReason,
  ): void {
    const current = this.peerIdentityProjections.get(peerId);
    if (current && current.sequence > sequence) return;
    this.peerIdentityProjections.set(peerId, { sequence, identity, clearReason });
  }

  private standardRoomIdentityProofKey(roomCode: string, role: 'host' | 'guest'): string {
    return `${role}:${roomCode}`;
  }

  private applyStandardRoomIdentity(
    value: unknown,
    clearReason?: StandardRoomIdentityClearReason,
  ): void {
    const identity = value === null ? null : normalizeStandardRoomMemberIdentity(value);
    if (value !== null && !identity) return;
    // A verified deletion is a cross-device revocation, not merely an ack for
    // one socket. It always invalidates provider work that started before the
    // projection arrived. If that cancels an active refresh (for example a
    // rapid re-login racing the deletion ack), fetch the latest account state
    // once after the normal retry delay. Explicit clear acks are FIFO-ordered
    // with their originating socket and must not cancel a newer login refresh;
    // lease expiry likewise lets an already-running, projection-bound renewal
    // finish while retaining the fail-closed retry deadline.
    const replayAfterDeletion =
      identity === null &&
      clearReason === 'deleted' &&
      this.standardRoomIdentityActiveRefreshGenerations.size > 0;
    if (identity === null && clearReason === 'deleted') {
      this.standardRoomIdentityRefreshGeneration += 1;
    }
    this.emit('room-identity', identity, clearReason);
    // A same-account sibling projection can update this identity without
    // extending this socket's independent server lease. Keep the earlier
    // renewal deadline instead of letting sibling devices postpone each other.
    if (identity) {
      this.scheduleStandardRoomIdentityRefresh(STANDARD_ROOM_IDENTITY_RENEW_INTERVAL_MS, true);
    } else if (clearReason === 'expired' || replayAfterDeletion) {
      this.scheduleStandardRoomIdentityRefresh(STANDARD_ROOM_IDENTITY_RETRY_MS);
    } else if (clearReason !== 'explicit') {
      this.scheduleStandardRoomIdentityRefresh(null);
    }
  }

  private scheduleStandardRoomIdentityRefresh(
    delayMs: number | null,
    preserveExisting = false,
  ): void {
    if (delayMs === null || this.destroyed || this.proSignalingAccess) {
      clearManagedTimer(this.standardRoomIdentityRefreshTimerKey);
      return;
    }
    if (preserveExisting && getManagedTimer(this.standardRoomIdentityRefreshTimerKey) !== null) {
      return;
    }
    setManagedTimer(
      this.standardRoomIdentityRefreshTimerKey,
      () =>
        this.refreshStandardRoomIdentity().catch((error) =>
          this.handleStandardRoomIdentityBackgroundFailure(error, 'renewal'),
        ),
      delayMs,
    );
  }

  private handleStandardRoomIdentityBackgroundFailure(error: unknown, operation: string): void {
    // Identity projection is optional background enrichment on an already-open
    // Standard-room socket. A failed send must not masquerade as a fatal room
    // transport error (which the UI turns into a generic network toast).
    try {
      log.warn(`[Transport] Standard room identity ${operation} failed; retrying`, error);
    } catch {
      // Diagnostics must never replace the original non-fatal outcome.
    }
    try {
      if (!this.destroyed && !this.proSignalingAccess) {
        this.scheduleStandardRoomIdentityRefresh(STANDARD_ROOM_IDENTITY_RETRY_MS);
      }
    } catch (retryError) {
      try {
        log.warn('[Transport] Failed to schedule Standard room identity retry', retryError);
      } catch {
        // The room transport remains authoritative even if diagnostics fail.
      }
    }
  }

  private scheduleStandardRoomIdentityDeletionReconcile(): void {
    if (this.destroyed || this.proSignalingAccess) {
      clearManagedTimer(this.standardRoomIdentityDeletionReconcileTimerKey);
      return;
    }
    // A mixed provider snapshot (delete on one physical socket, older attach
    // on another) gets exactly one fresh reconciliation. Keep it independent
    // from the normal renewal timer so the Worker's delayed deleted projection
    // cannot erase this proof-completion pass.
    if (getManagedTimer(this.standardRoomIdentityDeletionReconcileTimerKey) !== null) return;
    setManagedTimer(
      this.standardRoomIdentityDeletionReconcileTimerKey,
      () =>
        this.refreshStandardRoomIdentity(false).catch((error) =>
          this.handleStandardRoomIdentityBackgroundFailure(error, 'deletion reconciliation'),
        ),
      STANDARD_ROOM_IDENTITY_RETRY_MS,
    );
  }

  private async getStandardRoomAssertions(
    roomCode: string,
    peerId: string,
    role: 'host' | 'guest',
    waitMs = STANDARD_ROOM_ASSERTION_ADMISSION_WAIT_MS,
  ): Promise<StandardRoomIdentityAssertions | undefined> {
    const provider = this.options.standardRoomAssertionProvider;
    if (!provider || this.proSignalingAccess) {
      return { accountAssertion: null, deletionAssertion: null };
    }
    try {
      const value = await Promise.race([
        provider({ roomCode, peerId, role }),
        delay(waitMs).then(() => undefined),
      ]);
      if (value === undefined) return undefined;
      return normalizeStandardRoomIdentityAssertions(value) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private rememberStandardRoomDeletionProof(
    roomCode: string,
    role: 'host' | 'guest',
    deletionAssertion: string | null,
  ): void {
    const key = this.standardRoomIdentityProofKey(roomCode, role);
    if (deletionAssertion) this.standardRoomIdentityDeletionProofs.set(key, deletionAssertion);
    else this.standardRoomIdentityDeletionProofs.delete(key);
  }

  private sendPendingStandardRoomDeletion(
    roomCode: string,
    role: 'host' | 'guest',
    socket: StandardSignalingSocket,
  ): boolean {
    const key = this.standardRoomIdentityProofKey(roomCode, role);
    const deletionAssertion = this.standardRoomIdentityDeletionProofs.get(key);
    if (!deletionAssertion || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'account-identity-delete', deletionAssertion }));
    this.standardRoomIdentityDeletionProofs.delete(key);
    return true;
  }

  private sendHostAuth(socket: StandardSignalingSocket): boolean {
    if (
      !this.hostRoomId ||
      !this.id ||
      socket !== this.hostSocket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    socket.send(
      JSON.stringify({
        type: 'host-auth',
        secret: this.hostSecret,
        desiredRoomPassword: this.roomPassword || '',
        pinMutationId: this.roomPasswordMutationId,
      }),
    );
    this.noteSignalingSocketAuthSent(socket);
    return true;
  }

  private async sendGuestAuth(roomId: string, socket: StandardSignalingSocket): Promise<boolean> {
    if (!this.id || socket.readyState !== WebSocket.OPEN) return false;
    const assertionGeneration = this.standardRoomIdentityRefreshGeneration;
    const assertions = await this.getStandardRoomAssertions(roomId, this.id, 'guest');
    if (socket !== this.roomSockets.get(roomId) || socket.readyState !== WebSocket.OPEN)
      return false;
    const currentAssertions =
      assertionGeneration === this.standardRoomIdentityRefreshGeneration ? assertions : undefined;
    if (assertionGeneration !== this.standardRoomIdentityRefreshGeneration) {
      // The account projection changed while guest-auth was waiting. Keep the
      // first frame anonymous, then fetch the newest projection only after this
      // exact socket receives peer-open from the Worker.
      this.standardRoomIdentityRefreshAfterGuestAdmission.add(socket);
    }
    if (assertionGeneration === this.standardRoomIdentityRefreshGeneration && !assertions) {
      this.scheduleStandardRoomIdentityRefresh(STANDARD_ROOM_IDENTITY_RETRY_MS);
    }
    if (currentAssertions) {
      this.rememberStandardRoomDeletionProof(roomId, 'guest', currentAssertions.deletionAssertion);
    }
    const record = this.guestRooms.get(roomId);
    if (!record) return false;
    const reconnectSecret = this.guestReconnectSecrets.get(roomId);
    if (!reconnectSecret) return false;
    socket.send(
      JSON.stringify({
        type: 'guest-auth',
        password: record.password || '',
        reconnectSecret,
        ...(currentAssertions?.accountAssertion
          ? { accountAssertion: currentAssertions.accountAssertion }
          : {}),
      }),
    );
    this.noteSignalingSocketAuthSent(socket);
    return true;
  }

  private handleProEpochAdvanced(): void {
    if (!this.proSignalingAccess || this.destroyed) return;
    // The signaling close is an authority event, not a transient network
    // blip. Tear down every RTC facade immediately; the PRO runtime fetches
    // the new snapshot/epoch and constructs a fresh transport.
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.peerIdentityProjections.clear();
    this.peerOfferSequences.clear();
    this.peerDepartureSequences.clear();
    this.guestRooms.clear();
    for (const mediaConn of this.mediaCalls.values()) mediaConn.closeFromRemote();
    this.mediaCalls.clear();
    this.clearAllIceState();
    this.open = false;
    this.disconnected = true;
    this.emit('pro-epoch-advanced');
  }

  constructor(
    requestedId: string | null,
    private readonly options: TransportPeerOptions,
  ) {
    super();
    this.primarySignalingUrl = options.signalingUrl ?? '';
    this.fallbackSignalingUrl =
      normalizeSignalingFallbackUrl(options.signalingUrl, options.signalingFallbackUrl) ?? null;
    this.hostSignalingUrl = this.primarySignalingUrl;
    this.rtcConfiguration = options.config;
    this.rtcConfigurationPending = options.deferRtcUntilConfigured === true;
    this.rtcConfigurationReady = options.deferRtcUntilConfigured
      ? new Promise<void>((resolve) => {
          this.resolveRtcConfigurationReady = resolve;
        })
      : Promise.resolve();
    const proSignaling = options.proSignaling;
    const claims = proSignaling ? proTicketClaims(proSignaling.ticket) : null;
    const proParticipantId = claims?.participantId ?? null;
    if (proSignaling) {
      const validShape =
        /^\d{6}$/.test(proSignaling.roomCode) &&
        !!proSignaling.ticket &&
        claims?.roomCode === proSignaling.roomCode &&
        claims.role === proSignaling.role &&
        claims.coordinatorEpoch === proSignaling.coordinatorEpoch &&
        claims.presenceIncarnationId === proSignaling.presenceIncarnationId &&
        claims.ticketSequence === proSignaling.ticketSequence &&
        Number.isSafeInteger(proSignaling.coordinatorEpoch) &&
        proSignaling.coordinatorEpoch >= 1;
      const validRoleShape =
        (proSignaling.role === 'coordinator' && requestedId === proSignaling.roomCode) ||
        (proSignaling.role === 'member' && requestedId === null);
      if (!validShape || !validRoleShape) {
        throw createTransportError('invalid-id', 'INVALID_PRO_SIGNALING_OPTIONS');
      }
    }
    this.hostRoomId = requestedId;
    this.proParticipantId = proParticipantId;
    this.proSignalingAccess = proSignaling ? { ...proSignaling } : null;
    const preferHttpFirst =
      requestedId !== null &&
      !this.proSignalingAccess &&
      this.fallbackSignalingUrl !== null &&
      !!this.options.prepareNetworkRouteRetry &&
      hasStandardHttpPreference();
    if (preferHttpFirst) {
      this.hostUseHttpSignaling = true;
      this.hostRoutePlan = createStandardSetupRoutePlan(true);
    }
    this.id =
      requestedId ??
      (proSignaling?.role === 'member' ? proParticipantId : null) ??
      `mx-${randomBase64Url(12)}`;

    if (requestedId) {
      queueMicrotask(() => this.openHostSocket());
    } else {
      queueMicrotask(() => {
        if (this.destroyed || !this.id) return;
        this.open = true;
        this.disconnected = false;
        this.emit('open', this.id);
      });
    }
  }

  connect(roomId: string, options?: TransportConnectOptions): TransportDataConnection {
    if (this.destroyed) throw createTransportError('disconnected', 'PEER_DESTROYED');
    if (
      this.proSignalingAccess &&
      (this.proSignalingAccess.role !== 'member' || roomId !== this.proSignalingAccess.roomCode)
    ) {
      throw createTransportError('invalid-id', 'PRO_SIGNALING_ROOM_MISMATCH');
    }
    const recommendedPreOpenTimeoutMs =
      !this.proSignalingAccess &&
      this.fallbackSignalingUrl !== null &&
      !!this.options.prepareNetworkRouteRetry
        ? STANDARD_ROOM_FALLBACK_GUEST_PRE_OPEN_TIMEOUT_MS
        : undefined;
    const conn = new CloudflareDataConnection(
      roomId,
      options?.metadata,
      null,
      () => {
        this.reconcileGuestBackgroundRecovery(roomId);
      },
      recommendedPreOpenTimeoutMs,
    );
    const roomPassword =
      typeof options?.roomPassword === 'string' ? options.roomPassword.trim() : '';
    const previousRecord = this.guestRooms.get(roomId);
    previousRecord?.routeRetryController?.abort(new Error('GUEST_ROUTE_RETRY_SUPERSEDED'));
    if (previousRecord && previousRecord.admissionTimeoutId !== null) {
      globalThis.clearTimeout(previousRecord.admissionTimeoutId);
      previousRecord.admissionTimeoutId = null;
    }
    const previousSocket = this.roomSockets.get(roomId);
    if (previousSocket) {
      // Explicit re-join supersedes the previous socket even when its conn was
      // already closed. Remove routing authority before retiring the physical
      // handle so a late WebKit open cannot authenticate the old attempt.
      this.roomSockets.delete(roomId);
      this.retireSignalingSocket(previousSocket);
    }
    if (!this.proSignalingAccess && !this.guestReconnectSecrets.has(roomId)) {
      this.guestReconnectSecrets.set(roomId, randomBase64Url(32));
    }
    const preferHttpFirst =
      !this.proSignalingAccess &&
      this.fallbackSignalingUrl !== null &&
      !!this.options.prepareNetworkRouteRetry &&
      hasStandardHttpPreference();
    const record: GuestRoomRecord = {
      conn,
      metadata: options?.metadata,
      password: roomPassword,
      signalingUrl: this.primarySignalingUrl,
      useHttpSignaling: preferHttpFirst,
      routePlan: createStandardSetupRoutePlan(preferHttpFirst),
      socketGeneration: 0,
      routeRetryGeneration: 0,
      routeRetryCount: 0,
      routeRetryController: null,
      admissionTimeoutId: null,
      authFailed: false,
    };
    this.guestRooms.set(roomId, record);
    this.connections.set(roomId, conn);
    conn.on('close', () => {
      // Identity-guarded cleanup: a late 'close' from a conn replaced by a
      // newer connect() for the same room must not evict the live records.
      // Also drops queued candidates so a dead peer cannot grow
      // pendingCandidates unbounded.
      const currentRecord = this.guestRooms.get(roomId);
      if (currentRecord?.conn === conn) {
        currentRecord.routeRetryController?.abort(new Error('GUEST_CONNECTION_CLOSED'));
        if (currentRecord.admissionTimeoutId !== null) {
          globalThis.clearTimeout(currentRecord.admissionTimeoutId);
          currentRecord.admissionTimeoutId = null;
        }
        const currentSocket = this.roomSockets.get(roomId);
        if (currentSocket) {
          this.roomSockets.delete(roomId);
          this.retireSignalingSocket(currentSocket);
        }
        this.guestRooms.delete(roomId);
      }
      if (this.connections.get(roomId) === conn) {
        this.connections.delete(roomId);
        this.clearIcePeerState(roomId, conn.peerConnection ?? undefined);
      }
    });
    // Deliberately NOT ensureGuestSocket: a re-join must create a socket whose
    // listeners are closure-bound to this new conn. Any previous physical
    // socket was authority-fenced and retired above before this replacement.
    this.openGuestSocket(roomId);
    return conn;
  }

  call(
    peerId: string,
    stream: MediaStream,
    options?: { metadata?: Record<string, unknown> },
  ): TransportMediaConnection {
    if (this.destroyed) throw createTransportError('disconnected', 'PEER_DESTROYED');
    const conn = this.connections.get(peerId);
    const pc = conn?.peerConnection;
    if (!conn?.open || !pc) throw createTransportError('peer-unavailable', 'PEER_NOT_CONNECTED');

    const mediaConn = new CloudflareMediaConnection(
      peerId,
      randomBase64Url(12),
      options?.metadata,
      stream.getAudioTracks().length,
    );
    mediaConn.attachPeerConnection(pc);
    mediaConn.setCloseHandler((closedConn, notifyRemote) =>
      this.closeMediaCall(peerId, closedConn.callId, notifyRemote),
    );
    mediaConn.addLocalStream(stream);
    this.mediaCalls.set(mediaConn.callId, mediaConn);

    queueMicrotask(() => {
      this.startMediaOffer(peerId, mediaConn).catch((error) => mediaConn.emit('error', error));
    });

    return mediaConn;
  }

  private releaseRetiredSignalingSocket(socket: WebSocket): void {
    const listeners = this.retiredSignalingSockets.get(socket);
    if (!listeners) return;
    this.retiredSignalingSockets.delete(socket);
    socket.removeEventListener('open', listeners.open);
    socket.removeEventListener('close', listeners.close);
    socket.removeEventListener('error', listeners.error);
    if (socket.readyState === WebSocket.CLOSED) releasePageSignalingSocket(socket);
  }

  /**
   * Revoke a physical socket without ever calling close() in CONNECTING.
   *
   * Logical authority must be removed by the caller before entering here. A
   * late open is therefore harmless: the original open callback is fenced by
   * exact socket/generation ownership, then this retirement listener closes
   * the now-OPEN socket safely. CLOSING is likewise observed rather than
   * prodded, because another close() cannot improve it and has triggered
   * process-wide CFNetwork WebSocket failures on iOS.
   */
  private retireSignalingSocket(socket: StandardSignalingSocket): void {
    if (isStandardHttpSignalingSocket(socket)) {
      try {
        socket.close();
      } catch {
        // HTTP bridge retirement is best-effort after logical authority moved.
      }
      return;
    }
    if (this.retiredSignalingSockets.has(socket)) return;

    const release = () => this.releaseRetiredSignalingSocket(socket);
    const releaseAfterClose: EventListener = (event) => {
      this.noteSignalingSocketClosed(socket, event as CloseEvent);
      release();
    };
    const closeAfterOpen = () => {
      if (!this.retiredSignalingSockets.has(socket)) return;
      try {
        socket.close();
      } catch {
        // Keep the handle until a later close/error. Losing it here would make
        // destroy() and superseding setup attempts unable to fence the socket.
      }
      if (socket.readyState === WebSocket.CLOSED) release();
    };
    const listeners: RetiredSignalingSocketListeners = {
      open: closeAfterOpen,
      close: releaseAfterClose,
      error: () => {
        // WebKit can report error while the physical operation remains
        // CONNECTING/CLOSING. Keep the handle in that case; only CLOSED is a
        // terminal cleanup signal, while an unexpectedly OPEN socket can now
        // be closed without entering the CONNECTING-close failure mode.
        if (socket.readyState === WebSocket.CLOSED) release();
        else if (socket.readyState === WebSocket.OPEN) closeAfterOpen();
      },
    };
    this.retiredSignalingSockets.set(socket, listeners);
    socket.addEventListener('open', listeners.open);
    socket.addEventListener('close', listeners.close);
    socket.addEventListener('error', listeners.error);

    if (socket.readyState === WebSocket.OPEN) closeAfterOpen();
    else if (socket.readyState === WebSocket.CLOSED) release();
  }

  private retireHostSignalingSocket(
    socket: StandardSignalingSocket,
    closePhysical: boolean,
  ): boolean {
    if (!isStandardHttpSignalingSocket(socket)) this.signalingLiveness.stop(socket);
    this.rejectPendingRemoteShareUploadAssertions(
      socket,
      'REMOTE_SHARE_UPLOAD_ASSERTION_SOCKET_CLOSED',
    );
    if (this.hostSocket !== socket) return false;

    this.clearHostSetupAdmissionTimeout();
    this.hostSocket = null;
    this.remoteShareUploadAssertionStatus = this.remoteShareUploadAssertionObserved
      ? 'unavailable'
      : 'unknown';
    this.open = false;
    const wasDisconnected = this.disconnected;
    this.disconnected = true;
    if (closePhysical) this.retireSignalingSocket(socket);
    if (!wasDisconnected) this.emit('disconnected');
    return true;
  }

  private retireGuestSignalingSocket(
    roomId: string,
    record: GuestRoomRecord,
    socket: StandardSignalingSocket,
    signalingDisconnected: boolean,
  ): boolean {
    if (this.guestRooms.get(roomId) !== record || this.roomSockets.get(roomId) !== socket) {
      return false;
    }
    this.clearGuestSetupAdmissionTimeout(record);
    this.roomSockets.delete(roomId);
    this.retireSignalingSocket(socket);
    if (signalingDisconnected && record.conn.peerConnection) {
      const wasDisconnected = this.disconnected;
      this.disconnected = true;
      this.reconcileGuestBackgroundRecovery(roomId, true);
      if (!wasDisconnected) this.emit('disconnected');
    }
    return true;
  }

  markSignalingUnavailable(): boolean {
    if (this.destroyed || this.proSignalingAccess || !this.hostRoomId) return false;
    const socket = this.hostSocket;
    return socket ? this.retireHostSignalingSocket(socket, true) : false;
  }

  reconnect(): void {
    if (this.destroyed) return;
    if (this.hostRoomId) {
      this.openHostSocket();
      return;
    }
    for (const [roomId, record] of this.guestRooms) {
      // Dead sessions belong to the join/HOST_DISCONNECTED re-join path, and
      // mid-handshake conns (peerConnection set, open=false) stay with the
      // join timeout — reconnect only serves established sessions whose
      // signaling socket blipped.
      if (!this.isDataConnectionAlive(record.conn)) continue;
      this.ensureGuestSocket(roomId);
    }
  }

  recoverAfterBackground(hiddenMs: number): TransportBackgroundRecoveryResult {
    if (
      this.destroyed ||
      this.hostRoomId !== null ||
      this.proSignalingAccess ||
      !Number.isFinite(hiddenMs) ||
      hiddenMs < DATA_CONNECTION_DISCONNECTED_GRACE_MS
    ) {
      return { status: 'not-applicable' };
    }

    let status: TransportBackgroundRecoveryStatus = 'not-applicable';
    for (const record of this.guestRooms.values()) {
      const next = record.conn.recoverAfterBackground(hiddenMs, this.disconnected);
      if (next === 'stale-connection-closed') return { status: next };
      if (next === 'monitoring') status = next;
    }
    return { status };
  }

  setRtcConfiguration(configuration: RTCConfiguration): void {
    if (this.destroyed) return;
    this.rtcConfiguration = configuration;
    this.rtcConfigurationPending = false;
    const resolve = this.resolveRtcConfigurationReady;
    this.resolveRtcConfigurationReady = null;
    resolve?.();
  }

  setRoomPassword(password: string | null): void {
    if (!this.hostRoomId) return;
    const normalized = typeof password === 'string' && /^\d{8}$/.test(password) ? password : '';
    this.roomPassword = normalized || null;
    this.roomPasswordMutationId = randomBase64Url(24);
    this.acknowledgedRoomPasswordMutationId = null;
    this.acknowledgedRoomPasswordSocket = null;
    const socket = this.hostSocket;
    if (
      !this.proSignalingAccess &&
      socket?.readyState === WebSocket.OPEN &&
      !this.standardRoomIdentityAdmittedHostSockets.has(socket)
    ) {
      // host-auth already captured the previous desired PIN. Do not let its
      // peer-open briefly publish that stale configuration and admit a guest
      // before the follow-up mutation round trip. Replace the pre-admission
      // socket immediately; its next first frame carries this exact intent.
      this.retireHostSignalingSocket(socket, true);
      this.openHostSocket();
      return;
    }
    this.sendRoomPassword();
  }

  setProSignalingAccess(access: ProSignalingOptions): boolean {
    const current = this.proSignalingAccess;
    const claims = proTicketClaims(access.ticket);
    if (
      !current ||
      !claims ||
      claims.participantId !== this.proParticipantId ||
      claims.roomCode !== access.roomCode ||
      claims.role !== access.role ||
      claims.coordinatorEpoch !== access.coordinatorEpoch ||
      claims.presenceIncarnationId !== access.presenceIncarnationId ||
      claims.ticketSequence !== access.ticketSequence ||
      access.roomCode !== current.roomCode ||
      access.role !== current.role ||
      access.coordinatorEpoch !== current.coordinatorEpoch ||
      access.presenceIncarnationId !== current.presenceIncarnationId ||
      access.ticketSequence <= current.ticketSequence
    ) {
      return false;
    }
    this.proSignalingAccess = { ...access };
    return true;
  }

  private takePendingRemoteShareUploadAssertion(
    correlationId: string,
    socket?: StandardSignalingSocket,
  ): PendingRemoteShareUploadAssertion | null {
    const pending = this.pendingRemoteShareUploadAssertions.get(correlationId);
    if (!pending || (socket && pending.socket !== socket)) return null;
    this.pendingRemoteShareUploadAssertions.delete(correlationId);
    globalThis.clearTimeout(pending.timeoutId);
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener('abort', pending.abort);
    }
    return pending;
  }

  private rejectPendingRemoteShareUploadAssertions(
    socket: StandardSignalingSocket | null,
    code: string,
  ): void {
    for (const [correlationId, pending] of this.pendingRemoteShareUploadAssertions) {
      if (socket && pending.socket !== socket) continue;
      const claimed = this.takePendingRemoteShareUploadAssertion(correlationId, pending.socket);
      claimed?.reject(new Error(code));
    }
  }

  async requestRemoteShareUploadAssertion(
    request: RemoteShareUploadAssertionRequest,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_UPLOAD_ASSERTION_ABORTED');
    if (this.destroyed || this.proSignalingAccess || !this.hostRoomId) {
      throw new Error('REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE');
    }
    // Marker absence is the sole mixed-version fallback. Once a Worker
    // advertises support, every failure below is authoritative and must not be
    // converted into an assertion-free legacy request.
    if (this.remoteShareUploadAssertionStatus === 'unsupported') return null;
    if (this.remoteShareUploadAssertionStatus !== 'supported') {
      throw new Error('REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE');
    }
    if (!isRemoteShareUploadAssertionRequest(request)) {
      throw new Error('REMOTE_SHARE_UPLOAD_ASSERTION_INVALID_REQUEST');
    }
    const socket = this.hostSocket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !this.standardRoomIdentityAdmittedHostSockets.has(socket)
    ) {
      throw new Error('REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE');
    }

    let correlationId = '';
    do correlationId = `rsaq_${randomBase64Url(24)}`;
    while (this.pendingRemoteShareUploadAssertions.has(correlationId));

    return new Promise<string | null>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        const claimed = this.takePendingRemoteShareUploadAssertion(correlationId, socket);
        claimed?.reject(new Error('REMOTE_SHARE_UPLOAD_ASSERTION_TIMEOUT'));
      }, REMOTE_SHARE_UPLOAD_ASSERTION_TIMEOUT_MS);
      const abort = signal
        ? () => {
            const claimed = this.takePendingRemoteShareUploadAssertion(correlationId, socket);
            claimed?.reject(new Error('REMOTE_SHARE_UPLOAD_ASSERTION_ABORTED'));
          }
        : undefined;
      const pending: PendingRemoteShareUploadAssertion = {
        socket,
        resolve,
        reject,
        timeoutId,
        signal,
        abort,
      };
      this.pendingRemoteShareUploadAssertions.set(correlationId, pending);
      if (signal && abort) signal.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort?.();
        return;
      }
      try {
        this.send(socket, {
          type: 'remote-share-upload-assertion-request',
          correlationId,
          ...request,
        });
      } catch (error) {
        const claimed = this.takePendingRemoteShareUploadAssertion(correlationId, socket);
        claimed?.reject(new Error('REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE', { cause: error }));
      }
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.hostAdmissionTimeoutId !== null) {
      globalThis.clearTimeout(this.hostAdmissionTimeoutId);
      this.hostAdmissionTimeoutId = null;
    }
    this.hostRouteRetryController?.abort(new Error('PEER_DESTROYED'));
    this.hostRouteRetryController = null;
    this.signalingLiveness.stopAll();
    this.standardRoomIdentityRefreshGeneration += 1;
    const resolveRtcConfiguration = this.resolveRtcConfigurationReady;
    this.resolveRtcConfigurationReady = null;
    this.rtcConfigurationPending = false;
    resolveRtcConfiguration?.();
    this.open = false;
    this.disconnected = false;
    this.scheduleStandardRoomIdentityRefresh(null);
    clearManagedTimer(this.standardRoomIdentityDeletionReconcileTimerKey);
    this.standardRoomIdentityDeletionProofs.clear();
    this.peerIdentityProjections.clear();
    this.peerOfferSequences.clear();
    this.peerDepartureSequences.clear();
    this.remoteShareUploadAssertionStatus = 'unknown';
    this.remoteShareUploadAssertionObserved = false;
    this.rejectPendingRemoteShareUploadAssertions(null, 'REMOTE_SHARE_UPLOAD_ASSERTION_DESTROYED');
    for (const record of this.guestRooms.values()) {
      record.routeRetryController?.abort(new Error('PEER_DESTROYED'));
      if (record.admissionTimeoutId !== null) {
        globalThis.clearTimeout(record.admissionTimeoutId);
        record.admissionTimeoutId = null;
      }
    }
    const roomSockets = [...this.roomSockets.values()];
    this.roomSockets.clear();
    for (const socket of roomSockets) this.retireSignalingSocket(socket);
    const hostSocket = this.hostSocket;
    this.hostSocket = null;
    if (hostSocket) this.retireSignalingSocket(hostSocket);
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.guestRooms.clear();
    this.guestReconnectSecrets.clear();
    this.clearAllIceState();
    for (const mediaConn of this.mediaCalls.values()) mediaConn.closeFromRemote();
    this.mediaCalls.clear();
    this.clear();
  }

  private requireSignalingUrl(url = this.primarySignalingUrl): string {
    if (!url) throw createTransportError('server-error', 'CLOUDFLARE_SIGNALING_URL_MISSING');
    return url;
  }

  private buildSocketUrl(
    signalingUrl: string,
    roomId: string,
    role: 'host' | 'guest',
    peerId: string,
  ): string {
    // PRO tickets are authority-bound to the primary ingress and never
    // participate in the Standard-room route fallback.
    const base = new URL(
      this.requireSignalingUrl(this.proSignalingAccess ? this.primarySignalingUrl : signalingUrl),
    );
    if (base.protocol === 'http:') base.protocol = 'ws:';
    else if (base.protocol === 'https:') base.protocol = 'wss:';
    const proSignaling = this.proSignalingAccess;
    if (proSignaling) {
      const standardBase = base.pathname.replace(/\/+$/, '');
      const proBase = standardBase.endsWith('/api/rooms')
        ? `${standardBase.slice(0, -'/api/rooms'.length)}/api/pro-rooms`
        : standardBase.endsWith('/api/pro-rooms')
          ? standardBase
          : `${standardBase}/api/pro-rooms`;
      base.pathname = `${proBase}/${encodeURIComponent(roomId)}/ws`;
      base.search = '';
      return base.toString();
    }
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(roomId)}/ws`;
    // A standard room's host secret is a bearer credential. Keep the URL
    // limited to routing identifiers so edge logs, traces, and diagnostics can
    // never capture it; the host proves ownership in the first WebSocket frame.
    base.search = '';
    base.searchParams.set('role', role);
    base.searchParams.set('peerId', peerId);
    return base.toString();
  }

  private noteSignalingSocketOpened(socket: StandardSignalingSocket): void {
    const lifecycle = this.signalingSocketLifecycles.get(socket);
    if (lifecycle) lifecycle.everOpened = true;
  }

  private noteSignalingSocketAuthSent(socket: StandardSignalingSocket): void {
    const lifecycle = this.signalingSocketLifecycles.get(socket);
    if (lifecycle) lifecycle.authSent = true;
  }

  private noteSignalingSocketAdmitted(socket: StandardSignalingSocket): void {
    const lifecycle = this.signalingSocketLifecycles.get(socket);
    if (lifecycle) lifecycle.admitted = true;
  }

  private noteSignalingSocketSemanticFailure(socket: StandardSignalingSocket): void {
    const lifecycle = this.signalingSocketLifecycles.get(socket);
    if (lifecycle) lifecycle.semanticFailureObserved = true;
  }

  private noteSignalingSocketFailure(socket: StandardSignalingSocket): void {
    const lifecycle = this.signalingSocketLifecycles.get(socket);
    if (lifecycle) lifecycle.failureObserved = true;
  }

  private noteSignalingSocketClosed(socket: StandardSignalingSocket, event: CloseEvent): void {
    const lifecycle = this.signalingSocketLifecycles.get(socket);
    if (!lifecycle) return;
    lifecycle.closeCode = Number.isSafeInteger(event.code) ? event.code : null;
    lifecycle.closeClean = typeof event.wasClean === 'boolean' ? event.wasClean : null;
    if (lifecycle.failureObserved && !lifecycle.admitted && !lifecycle.terminalCloseLogged) {
      lifecycle.terminalCloseLogged = true;
      log.warn(
        '[Transport] Signaling socket reached terminal close after pre-admission retirement',
        this.signalingSocketDiagnostic(socket),
      );
    }
  }

  private signalingSocketDiagnostic(socket: StandardSignalingSocket): {
    route: SignalingRoute;
    everOpened: boolean;
    authSent: boolean;
    admitted: boolean;
    elapsedMs: number;
    closeCode: number | null;
    closeClean: boolean | null;
    readyState: number | null;
    readyStateName: 'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'UNKNOWN';
    closeSuppressed: boolean;
    httpPhase?: 'open' | 'send' | 'poll' | 'close';
    httpStatus?: number | null;
  } {
    const lifecycle = this.signalingSocketLifecycles.get(socket);
    const rawElapsedMs = lifecycle ? Date.now() - lifecycle.createdAt : 0;
    // Keep diagnostic cardinality bounded while retaining enough resolution to
    // distinguish immediate ingress rejection from the admission watchdog.
    const elapsedMs = Math.min(60_000, Math.max(0, Math.round(rawElapsedMs / 250) * 250));
    const httpDiagnostic = isStandardHttpSignalingSocket(socket) ? socket.diagnostic : null;
    return {
      route: lifecycle?.route ?? 'primary',
      everOpened: lifecycle?.everOpened ?? false,
      authSent: lifecycle?.authSent ?? false,
      admitted: lifecycle?.admitted ?? false,
      elapsedMs,
      closeCode: lifecycle?.closeCode ?? null,
      closeClean: lifecycle?.closeClean ?? null,
      ...signalingSocketReadyStateDiagnostic(socket),
      ...(httpDiagnostic
        ? { httpPhase: httpDiagnostic.phase, httpStatus: httpDiagnostic.status }
        : {}),
    };
  }

  private openSignalingSocket(url: string, route: SignalingRoute): WebSocket {
    pruneClosedPageSignalingSockets();
    if (pageSignalingSocketCloseListeners.size >= MAX_PAGE_SIGNALING_SOCKET_HANDLES) {
      log.warn('[Transport] Refusing signaling socket creation; page handle limit reached', {
        activeHandles: pageSignalingSocketCloseListeners.size,
        handleLimit: MAX_PAGE_SIGNALING_SOCKET_HANDLES,
      });
      throw createTransportError('network', 'SIGNALING_SOCKET_HANDLE_LIMIT_REACHED');
    }
    const ticket = this.proSignalingAccess?.ticket;
    const socket = ticket
      ? new WebSocket(url, proSignalingWebSocketProtocols(ticket))
      : new WebSocket(url);
    this.signalingSocketLifecycles.set(socket, {
      route,
      createdAt: Date.now(),
      everOpened: false,
      authSent: false,
      admitted: false,
      semanticFailureObserved: false,
      failureObserved: false,
      terminalCloseLogged: false,
      closeCode: null,
      closeClean: null,
    });
    trackPageSignalingSocket(socket);
    return socket;
  }

  private openHttpSignalingSocket(
    roomId: string,
    role: 'host' | 'guest',
    peerId: string,
  ): StandardHttpSignalingSocket {
    pruneClosedPageSignalingSockets();
    if (pageSignalingSocketCloseListeners.size >= MAX_PAGE_SIGNALING_SOCKET_HANDLES) {
      log.warn('[Transport] Refusing signaling socket creation; page handle limit reached', {
        activeHandles: pageSignalingSocketCloseListeners.size,
        handleLimit: MAX_PAGE_SIGNALING_SOCKET_HANDLES,
      });
      throw createTransportError('network', 'SIGNALING_SOCKET_HANDLE_LIMIT_REACHED');
    }
    const socket = new StandardHttpSignalingSocket({ roomId, role, peerId });
    this.signalingSocketLifecycles.set(socket, {
      route: 'http',
      createdAt: Date.now(),
      everOpened: false,
      authSent: false,
      admitted: false,
      semanticFailureObserved: false,
      failureObserved: false,
      terminalCloseLogged: false,
      closeCode: null,
      closeClean: null,
    });
    trackPageSignalingSocket(socket);
    return socket;
  }

  private send(socket: StandardSignalingSocket | null | undefined, message: OutgoingSignal): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw createTransportError('socket-closed', 'SIGNALING_SOCKET_NOT_OPEN');
    }
    socket.send(JSON.stringify(message));
  }

  private isDataConnectionAlive(conn: CloudflareDataConnection | undefined): boolean {
    if (!conn?.open) return false;
    const state = conn.peerConnection?.connectionState;
    return state !== 'closed' && state !== 'failed';
  }

  private handleSignalingSocketError(
    socket: StandardSignalingSocket,
    options: {
      label: string;
      isCurrent: () => boolean;
      isEstablished: () => boolean;
      retryPreOpen?: (event: Event) => boolean;
      retireEstablished: () => void;
      emitPreOpenError: (event: Event) => void;
    },
    event: Event,
  ): void {
    // An async route barrier deliberately retires the failed physical socket
    // before opening its successor. WebKit can still dispatch a queued error
    // or close from that object; exact socket identity is the authority fence.
    if (!options.isCurrent()) return;
    if (!options.isEstablished()) {
      if (options.retryPreOpen?.(event)) return;
      this.noteSignalingSocketFailure(socket);
      log.warn(
        `[Transport] ${options.label} signaling socket error before admission`,
        this.signalingSocketDiagnostic(socket),
      );
      options.emitPreOpenError(event);
      return;
    }

    const lifecycle = this.signalingSocketLifecycles.get(socket);
    if (
      lifecycle?.route === 'http' &&
      shouldClearPreferredHttpAfterFailure(
        socket,
        { kind: 'error' },
        lifecycle.semanticFailureObserved,
      )
    ) {
      // This only changes the route chosen by a future setup. The admitted
      // room keeps its established data channels and existing reconnect owner.
      clearStandardHttpPreference();
    }

    log.warn(
      `[Transport] ${options.label} signaling socket error; preserving data channel`,
      this.signalingSocketDiagnostic(socket),
    );
    options.retireEstablished();
  }

  private async runNetworkRouteRetryBarrier(
    signal: AbortSignal,
    label: string,
    retrySignalingUrl: string,
  ): Promise<void> {
    const prepare = this.options.prepareNetworkRouteRetry;
    if (!prepare) return;
    try {
      const configuration = await prepare(signal, retrySignalingUrl);
      if (!signal.aborted && configuration) this.setRtcConfiguration(configuration);
    } catch (error) {
      if (signal.aborted) return;
      // The retry remains bounded even if the read-only route probe itself is
      // unavailable. Its one successor socket is still useful evidence and
      // preserves the existing terminal error contract if the outage remains.
      log.warn(`[Transport] ${label} network-route barrier failed; retrying once`, error);
    }
  }

  private clearHostSetupAdmissionTimeout(): void {
    if (this.hostAdmissionTimeoutId === null) return;
    globalThis.clearTimeout(this.hostAdmissionTimeoutId);
    this.hostAdmissionTimeoutId = null;
  }

  private armHostSetupAdmissionTimeout(
    socket: StandardSignalingSocket,
    socketGeneration: number,
  ): void {
    this.clearHostSetupAdmissionTimeout();
    if (
      !this.options.prepareNetworkRouteRetry ||
      this.proSignalingAccess ||
      this.destroyed ||
      this.hostSignalingOpenedOnce
    ) {
      return;
    }
    this.hostAdmissionTimeoutId = globalThis.setTimeout(
      () => {
        this.hostAdmissionTimeoutId = null;
        if (
          this.destroyed ||
          this.hostSignalingOpenedOnce ||
          this.hostSocket !== socket ||
          this.hostSocketGeneration !== socketGeneration
        ) {
          return;
        }
        if (this.scheduleHostSetupRouteRetry(socket, socketGeneration, { kind: 'watchdog' }))
          return;
        this.noteSignalingSocketFailure(socket);
        this.hostSocket = null;
        this.retireSignalingSocket(socket);
        log.warn(
          '[Transport] Host signaling admission timed out',
          this.signalingSocketDiagnostic(socket),
        );
        this.emit('error', createTransportError('network', 'SIGNALING_HOST_ADMISSION_TIMEOUT'));
      },
      isStandardHttpSignalingSocket(socket)
        ? STANDARD_ROOM_HTTP_SETUP_ADMISSION_TIMEOUT_MS
        : STANDARD_ROOM_SETUP_ADMISSION_TIMEOUT_MS,
    );
  }

  private clearGuestSetupAdmissionTimeout(record: GuestRoomRecord): void {
    if (record.admissionTimeoutId === null) return;
    globalThis.clearTimeout(record.admissionTimeoutId);
    record.admissionTimeoutId = null;
  }

  private armGuestSetupAdmissionTimeout(
    roomId: string,
    record: GuestRoomRecord,
    socket: StandardSignalingSocket,
    socketGeneration: number,
  ): void {
    this.clearGuestSetupAdmissionTimeout(record);
    if (!this.options.prepareNetworkRouteRetry || this.proSignalingAccess || this.destroyed) return;
    record.admissionTimeoutId = globalThis.setTimeout(
      () => {
        record.admissionTimeoutId = null;
        if (
          this.destroyed ||
          this.guestRooms.get(roomId) !== record ||
          this.roomSockets.get(roomId) !== socket ||
          record.socketGeneration !== socketGeneration ||
          record.conn.open ||
          record.conn.peerConnection
        ) {
          return;
        }
        if (
          this.scheduleGuestSetupRouteRetry(roomId, record, socket, socketGeneration, {
            kind: 'watchdog',
          })
        )
          return;
        this.noteSignalingSocketFailure(socket);
        this.roomSockets.delete(roomId);
        this.retireSignalingSocket(socket);
        log.warn(
          '[Transport] Guest signaling admission timed out',
          this.signalingSocketDiagnostic(socket),
        );
        record.conn.emit(
          'error',
          createTransportError('network', 'SIGNALING_GUEST_ADMISSION_TIMEOUT'),
        );
      },
      isStandardHttpSignalingSocket(socket)
        ? STANDARD_ROOM_HTTP_SETUP_ADMISSION_TIMEOUT_MS
        : STANDARD_ROOM_SETUP_ADMISSION_TIMEOUT_MS,
    );
  }

  private scheduleHostSetupRouteRetry(
    socket: StandardSignalingSocket,
    socketGeneration: number,
    failure: StandardSetupRouteFailure,
  ): boolean {
    if (
      !this.options.prepareNetworkRouteRetry ||
      this.proSignalingAccess ||
      this.destroyed ||
      this.hostSignalingOpenedOnce ||
      this.hostSocket !== socket ||
      socketGeneration !== this.hostSocketGeneration ||
      this.hostRouteRetryCount >= STANDARD_ROOM_SETUP_ROUTE_RETRY_LIMIT
    ) {
      return false;
    }

    const lifecycle = this.signalingSocketLifecycles.get(socket);
    const failedRoute = lifecycle?.route;
    if (!failedRoute) return false;
    if (
      failedRoute === 'http' &&
      this.hostRoutePlan.preferredHttpFirst &&
      shouldClearPreferredHttpAfterFailure(socket, failure, lifecycle.semanticFailureObserved)
    ) {
      // The breaker is only a setup hint. A genuine failure on its first HTTP
      // route revokes both page and local preference before any WSS successor
      // is selected, and this plan's tried set prevents HTTP re-entry.
      clearStandardHttpPreference();
      this.hostUseHttpSignaling = false;
    }
    if (!isGenuineStandardSetupRouteFailure(socket, failure, lifecycle.semanticFailureObserved)) {
      return false;
    }
    const decision = decideStandardSetupRouteRetry(
      this.hostRoutePlan,
      failedRoute,
      this.primarySignalingUrl,
      this.fallbackSignalingUrl,
      this.hostRouteRetryCount,
    );
    if (!decision) return false;

    this.clearHostSetupAdmissionTimeout();
    this.noteSignalingSocketFailure(socket);
    this.hostRouteRetryCount += 1;
    const retryGeneration = ++this.hostRouteRetryGeneration;
    this.hostRouteRetryController?.abort(new Error('HOST_ROUTE_RETRY_SUPERSEDED'));
    const controller = new AbortController();
    this.hostRouteRetryController = controller;
    const retrySignalingUrl = decision.signalingUrl ?? this.hostSignalingUrl;

    // Retire the stale CONNECTING/OPEN-but-unadmitted path synchronously. The
    // Worker's host secret remains on this peer instance, so a commit whose
    // peer-open was lost is reclaimed idempotently instead of claiming a
    // second room/code with a different authority token.
    if (!isStandardHttpSignalingSocket(socket)) this.signalingLiveness.stop(socket);
    if (this.hostSocket === socket) this.hostSocket = null;
    this.retireSignalingSocket(socket);

    log.warn(
      decision.route === 'http'
        ? '[Transport] Host alternate signaling failed before admission; activating HTTPS bridge fallback'
        : failedRoute === 'http'
          ? '[Transport] Preferred HTTPS bridge failed before admission; retrying host WSS routes once'
          : '[Transport] Host signaling failed before admission; awaiting fresh route once',
      this.signalingSocketDiagnostic(socket),
    );
    const barrier = decision.prepareRoute
      ? this.runNetworkRouteRetryBarrier(controller.signal, 'Host', retrySignalingUrl)
      : Promise.resolve();
    barrier
      .then(() => {
        if (
          controller.signal.aborted ||
          this.destroyed ||
          this.hostSignalingOpenedOnce ||
          retryGeneration !== this.hostRouteRetryGeneration ||
          this.hostRouteRetryController !== controller ||
          this.hostSocket !== null
        ) {
          return;
        }
        this.hostRouteRetryController = null;
        this.hostUseHttpSignaling = decision.route === 'http';
        if (decision.signalingUrl) this.hostSignalingUrl = decision.signalingUrl;
        this.openHostSocket();
      })
      .catch((error) => log.warn('[Transport] Host route retry escaped its boundary', error));
    return true;
  }

  private scheduleGuestSetupRouteRetry(
    roomId: string,
    record: GuestRoomRecord,
    socket: StandardSignalingSocket,
    socketGeneration: number,
    failure: StandardSetupRouteFailure,
  ): boolean {
    if (
      !this.options.prepareNetworkRouteRetry ||
      this.proSignalingAccess ||
      this.destroyed ||
      this.guestRooms.get(roomId) !== record ||
      this.roomSockets.get(roomId) !== socket ||
      record.socketGeneration !== socketGeneration ||
      record.routeRetryCount >= STANDARD_ROOM_SETUP_ROUTE_RETRY_LIMIT ||
      record.conn.open ||
      record.conn.peerConnection
    ) {
      return false;
    }

    const lifecycle = this.signalingSocketLifecycles.get(socket);
    const failedRoute = lifecycle?.route;
    if (!failedRoute) return false;
    if (
      failedRoute === 'http' &&
      record.routePlan.preferredHttpFirst &&
      shouldClearPreferredHttpAfterFailure(socket, failure, lifecycle.semanticFailureObserved)
    ) {
      clearStandardHttpPreference();
      record.useHttpSignaling = false;
    }
    if (!isGenuineStandardSetupRouteFailure(socket, failure, lifecycle.semanticFailureObserved)) {
      return false;
    }
    const decision = decideStandardSetupRouteRetry(
      record.routePlan,
      failedRoute,
      this.primarySignalingUrl,
      this.fallbackSignalingUrl,
      record.routeRetryCount,
    );
    if (!decision) return false;

    this.clearGuestSetupAdmissionTimeout(record);
    this.noteSignalingSocketFailure(socket);
    record.routeRetryCount += 1;
    const retryGeneration = ++record.routeRetryGeneration;
    record.routeRetryController?.abort(new Error('GUEST_ROUTE_RETRY_SUPERSEDED'));
    const controller = new AbortController();
    record.routeRetryController = controller;
    const retrySignalingUrl = decision.signalingUrl ?? record.signalingUrl;

    // Removing map ownership before close makes every queued callback from the
    // first socket inert. The same conn, peer ID, room password, and RAM-only
    // reconnect proof cross the barrier, so this cannot duplicate a logical
    // join or let a stale attempt mutate guest join authority.
    this.roomSockets.delete(roomId);
    this.retireSignalingSocket(socket);

    log.warn(
      decision.route === 'http'
        ? '[Transport] Guest alternate signaling failed before admission; activating HTTPS bridge fallback'
        : failedRoute === 'http'
          ? '[Transport] Preferred HTTPS bridge failed before admission; retrying guest WSS routes once'
          : '[Transport] Guest signaling failed before admission; awaiting fresh route once',
      this.signalingSocketDiagnostic(socket),
    );
    const barrier = decision.prepareRoute
      ? this.runNetworkRouteRetryBarrier(controller.signal, 'Guest', retrySignalingUrl)
      : Promise.resolve();
    barrier
      .then(() => {
        if (
          controller.signal.aborted ||
          this.destroyed ||
          retryGeneration !== record.routeRetryGeneration ||
          record.routeRetryController !== controller ||
          this.guestRooms.get(roomId) !== record ||
          record.conn.open ||
          record.conn.peerConnection ||
          record.authFailed ||
          this.roomSockets.has(roomId)
        ) {
          return;
        }
        record.routeRetryController = null;
        record.useHttpSignaling = decision.route === 'http';
        if (decision.signalingUrl) record.signalingUrl = decision.signalingUrl;
        this.openGuestSocket(roomId);
      })
      .catch((error) => log.warn('[Transport] Guest route retry escaped its boundary', error));
    return true;
  }

  private sendRoomPassword(): void {
    if (!this.hostRoomId) return;
    if (this.proSignalingAccess) return;
    const socket = this.hostSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (
      this.acknowledgedRoomPasswordMutationId === this.roomPasswordMutationId &&
      this.acknowledgedRoomPasswordSocket === socket
    ) {
      return;
    }
    if (!this.standardRoomIdentityAdmittedHostSockets.has(socket)) return;
    try {
      this.send(socket, {
        type: 'room-password-set',
        password: this.roomPassword || '',
        pinMutationId: this.roomPasswordMutationId,
      });
    } catch (error) {
      this.emit('error', error);
    }
  }

  private openHostSocket(): void {
    if (!this.hostRoomId || !this.id || this.destroyed) return;
    const existing = this.hostSocket;
    if (
      existing &&
      existing.readyState !== WebSocket.CLOSED &&
      existing.readyState !== WebSocket.CLOSING
    ) {
      return;
    }
    if (existing) {
      this.rejectPendingRemoteShareUploadAssertions(
        existing,
        'REMOTE_SHARE_UPLOAD_ASSERTION_SOCKET_REPLACED',
      );
      this.hostSocket = null;
      this.retireSignalingSocket(existing);
    }

    let socket: StandardSignalingSocket;
    try {
      const useHttp = !this.proSignalingAccess && this.hostUseHttpSignaling;
      if (useHttp) {
        this.hostUseHttpSignaling = true;
        socket = this.openHttpSignalingSocket(this.hostRoomId, 'host', this.id);
      } else {
        const signalingUrl = this.hostSignalingUrl;
        const route: SignalingRoute =
          !this.proSignalingAccess &&
          this.fallbackSignalingUrl !== null &&
          signalingUrl === this.fallbackSignalingUrl
            ? 'fallback'
            : 'primary';
        socket = this.openSignalingSocket(
          this.buildSocketUrl(signalingUrl, this.hostRoomId, 'host', this.id),
          route,
        );
      }
    } catch (error) {
      this.emit('error', error);
      return;
    }

    const openedRoute = this.signalingSocketLifecycles.get(socket)?.route;
    if (openedRoute) this.hostRoutePlan.triedRoutes.add(openedRoute);

    this.remoteShareUploadAssertionStatus = this.remoteShareUploadAssertionObserved
      ? 'unavailable'
      : 'unknown';
    this.hostSocket = socket;
    const socketGeneration = ++this.hostSocketGeneration;
    socket.addEventListener('open', () => {
      this.noteSignalingSocketOpened(socket);
      if (
        this.destroyed ||
        this.hostSocket !== socket ||
        socketGeneration !== this.hostSocketGeneration
      ) {
        return;
      }
      if (this.proSignalingAccess) return;
      this.clearHostSetupAdmissionTimeout();
      try {
        if (this.sendHostAuth(socket)) {
          // CONNECTING time and server admission time are separate budgets.
          // Re-arm only after the first authority frame was actually sent.
          this.armHostSetupAdmissionTimeout(socket, socketGeneration);
        }
      } catch (error) {
        this.emit('error', error);
      }
    });
    socket.addEventListener('message', (event) => {
      if (
        !isStandardHttpSignalingSocket(socket) &&
        this.signalingLiveness.noteMessage(socket, (event as MessageEvent).data)
      ) {
        return;
      }
      const sequence = this.nextHostMessageSequence();
      this.handleHostMessage((event as MessageEvent).data, sequence, socket).catch((error) =>
        this.emit('error', error),
      );
    });
    socket.addEventListener('close', (event) => {
      this.noteSignalingSocketClosed(socket, event as CloseEvent);
      if (!isStandardHttpSignalingSocket(socket)) this.releaseRetiredSignalingSocket(socket);
      if (this.destroyed) {
        if (!isStandardHttpSignalingSocket(socket)) this.signalingLiveness.stop(socket);
        this.rejectPendingRemoteShareUploadAssertions(
          socket,
          'REMOTE_SHARE_UPLOAD_ASSERTION_SOCKET_CLOSED',
        );
        return;
      }
      if ((event as CloseEvent).reason === 'PRO_COORDINATOR_EPOCH_ADVANCED') {
        if (!isStandardHttpSignalingSocket(socket)) this.signalingLiveness.stop(socket);
        this.rejectPendingRemoteShareUploadAssertions(
          socket,
          'REMOTE_SHARE_UPLOAD_ASSERTION_SOCKET_CLOSED',
        );
        if (this.hostSocket === socket) this.hostSocket = null;
        this.handleProEpochAdvanced();
        return;
      }
      if (
        !this.proSignalingAccess &&
        !this.hostSignalingOpenedOnce &&
        this.hostSocket === socket &&
        socketGeneration === this.hostSocketGeneration
      ) {
        if (
          this.scheduleHostSetupRouteRetry(socket, socketGeneration, {
            kind: 'close',
            code: (event as CloseEvent).code,
            wasClean: (event as CloseEvent).wasClean,
          })
        )
          return;
        this.noteSignalingSocketFailure(socket);
        this.clearHostSetupAdmissionTimeout();
        this.hostSocket = null;
        log.warn(
          '[Transport] Host signaling socket closed before admission',
          this.signalingSocketDiagnostic(socket),
        );
        this.emit(
          'error',
          createTransportError('network', 'SIGNALING_SOCKET_CLOSED_BEFORE_HOST_ADMISSION'),
        );
        return;
      }
      const lifecycle = this.signalingSocketLifecycles.get(socket);
      if (
        this.hostSocket === socket &&
        this.hostSignalingOpenedOnce &&
        lifecycle?.route === 'http' &&
        shouldClearPreferredHttpAfterFailure(
          socket,
          {
            kind: 'close',
            code: (event as CloseEvent).code,
            wasClean: (event as CloseEvent).wasClean,
          },
          lifecycle.semanticFailureObserved,
        )
      ) {
        clearStandardHttpPreference();
      }
      this.retireHostSignalingSocket(socket, false);
    });
    socket.addEventListener('error', (event) =>
      this.handleSignalingSocketError(
        socket,
        {
          label: 'Host',
          isCurrent: () =>
            this.hostSocket === socket && socketGeneration === this.hostSocketGeneration,
          isEstablished: () => this.open,
          retryPreOpen: () =>
            this.scheduleHostSetupRouteRetry(socket, socketGeneration, { kind: 'error' }),
          retireEstablished: () => {
            this.retireHostSignalingSocket(socket, true);
          },
          emitPreOpenError: (error) => {
            this.clearHostSetupAdmissionTimeout();
            if (this.hostSocket === socket) this.hostSocket = null;
            this.retireSignalingSocket(socket);
            this.emit('error', error);
          },
        },
        event,
      ),
    );
    this.armHostSetupAdmissionTimeout(socket, socketGeneration);
  }

  /**
   * Idempotent reopen used by reconnect(): mirrors openHostSocket's
   * readyState guard. Never stacks a second socket on a CONNECTING/OPEN one
   * — the DO would close the older with GUEST_REPLACED, whose close re-emits
   * 'disconnected', resets the outer retry budget, and causes a permanent
   * open/close oscillation.
   */
  private reconcileGuestBackgroundRecovery(
    roomId: string,
    signalingDisconnected = this.disconnected,
  ): TransportBackgroundRecoveryStatus {
    const record = this.guestRooms.get(roomId);
    if (!record) return 'not-applicable';
    return record.conn.reconcileBackgroundResumeRecovery(signalingDisconnected);
  }

  private ensureGuestSocket(roomId: string): void {
    const record = this.guestRooms.get(roomId);
    if (!record || record.authFailed) return;
    const existing = this.roomSockets.get(roomId);
    if (
      existing &&
      existing.readyState !== WebSocket.CLOSED &&
      existing.readyState !== WebSocket.CLOSING
    ) {
      return;
    }
    this.openGuestSocket(roomId);
  }

  private openGuestSocket(roomId: string): void {
    const record = this.guestRooms.get(roomId);
    if (!record || !this.id || this.destroyed) return;
    const { conn, metadata } = record;
    const existing = this.roomSockets.get(roomId);
    if (existing) {
      this.roomSockets.delete(roomId);
      this.retireSignalingSocket(existing);
    }
    let socket: StandardSignalingSocket;
    try {
      const useHttp = !this.proSignalingAccess && record.useHttpSignaling;
      if (useHttp) {
        record.useHttpSignaling = true;
        socket = this.openHttpSignalingSocket(roomId, 'guest', this.id);
      } else {
        const signalingUrl = record.signalingUrl;
        const route: SignalingRoute =
          !this.proSignalingAccess &&
          this.fallbackSignalingUrl !== null &&
          signalingUrl === this.fallbackSignalingUrl
            ? 'fallback'
            : 'primary';
        socket = this.openSignalingSocket(
          this.buildSocketUrl(signalingUrl, roomId, 'guest', this.id),
          route,
        );
      }
    } catch (error) {
      queueMicrotask(() => conn.emit('error', error));
      return;
    }

    const openedRoute = this.signalingSocketLifecycles.get(socket)?.route;
    if (openedRoute) record.routePlan.triedRoutes.add(openedRoute);

    this.roomSockets.set(roomId, socket);
    const socketGeneration = ++record.socketGeneration;
    socket.addEventListener('open', () => {
      this.noteSignalingSocketOpened(socket);
      if (
        this.destroyed ||
        this.guestRooms.get(roomId) !== record ||
        this.roomSockets.get(roomId) !== socket ||
        record.socketGeneration !== socketGeneration
      ) {
        return;
      }
      if (this.proSignalingAccess) return;
      // Optional identity projection may legitimately consume its own two-
      // second budget. Do not count that work as a stuck CONNECTING socket.
      this.clearGuestSetupAdmissionTimeout(record);
      void this.sendGuestAuth(roomId, socket).then(
        (sent) => {
          if (
            sent &&
            this.guestRooms.get(roomId) === record &&
            this.roomSockets.get(roomId) === socket &&
            record.socketGeneration === socketGeneration &&
            !record.conn.peerConnection
          ) {
            this.armGuestSetupAdmissionTimeout(roomId, record, socket, socketGeneration);
          }
        },
        (error) => conn.emit('error', error),
      );
    });
    socket.addEventListener('message', (event) => {
      this.handleGuestMessage(roomId, socket, conn, metadata, (event as MessageEvent).data).catch(
        (error) => conn.emit('error', error),
      );
    });
    socket.addEventListener('close', (event) => {
      this.noteSignalingSocketClosed(socket, event as CloseEvent);
      if (!isStandardHttpSignalingSocket(socket)) this.releaseRetiredSignalingSocket(socket);
      if (this.destroyed) return;
      if ((event as CloseEvent).reason === 'PRO_COORDINATOR_EPOCH_ADVANCED') {
        if (this.roomSockets.get(roomId) === socket) this.roomSockets.delete(roomId);
        this.handleProEpochAdvanced();
        return;
      }
      if (this.roomSockets.get(roomId) === socket) {
        if (!conn.peerConnection && !conn.open) {
          if (
            this.scheduleGuestSetupRouteRetry(roomId, record, socket, socketGeneration, {
              kind: 'close',
              code: (event as CloseEvent).code,
              wasClean: (event as CloseEvent).wasClean,
            })
          )
            return;
          this.noteSignalingSocketFailure(socket);
          this.clearGuestSetupAdmissionTimeout(record);
          this.roomSockets.delete(roomId);
          log.warn(
            '[Transport] Guest signaling socket closed before admission',
            this.signalingSocketDiagnostic(socket),
          );
          conn.emit(
            'error',
            createTransportError('network', 'SIGNALING_SOCKET_CLOSED_BEFORE_GUEST_ADMISSION'),
          );
          return;
        }
        const lifecycle = this.signalingSocketLifecycles.get(socket);
        if (
          lifecycle?.route === 'http' &&
          shouldClearPreferredHttpAfterFailure(
            socket,
            {
              kind: 'close',
              code: (event as CloseEvent).code,
              wasClean: (event as CloseEvent).wasClean,
            },
            lifecycle.semanticFailureObserved,
          )
        ) {
          clearStandardHttpPreference();
        }
        this.roomSockets.delete(roomId);
        if (conn.peerConnection) {
          const wasDisconnected = this.disconnected;
          this.disconnected = true;
          this.reconcileGuestBackgroundRecovery(roomId, true);
          if (!wasDisconnected) this.emit('disconnected');
        }
      }
    });
    socket.addEventListener('error', (event) =>
      this.handleSignalingSocketError(
        socket,
        {
          label: 'Guest',
          isCurrent: () =>
            this.guestRooms.get(roomId) === record &&
            this.roomSockets.get(roomId) === socket &&
            record.socketGeneration === socketGeneration,
          isEstablished: () => this.isDataConnectionAlive(conn),
          retryPreOpen: () =>
            this.scheduleGuestSetupRouteRetry(roomId, record, socket, socketGeneration, {
              kind: 'error',
            }),
          retireEstablished: () => {
            this.retireGuestSignalingSocket(roomId, record, socket, true);
          },
          emitPreOpenError: (error) => {
            this.clearGuestSetupAdmissionTimeout(record);
            if (this.roomSockets.get(roomId) === socket) this.roomSockets.delete(roomId);
            this.retireSignalingSocket(socket);
            conn.emit('error', error);
          },
        },
        event,
      ),
    );
    this.armGuestSetupAdmissionTimeout(roomId, record, socket, socketGeneration);
  }

  private async parseSignal(raw: unknown): Promise<SignalingMessage> {
    if (typeof raw !== 'string') throw createTransportError('server-error', 'INVALID_SIGNAL');
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw createTransportError('server-error', 'INVALID_SIGNAL');
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'remote-share-upload-assertion'
    ) {
      const response = normalizeRemoteShareUploadAssertionResponse(value);
      if (!response) {
        throw createTransportError('server-error', 'INVALID_REMOTE_SHARE_UPLOAD_ASSERTION');
      }
      return response;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'remote-share-upload-assertion-error'
    ) {
      const response = normalizeRemoteShareUploadAssertionError(value);
      if (!response) {
        throw createTransportError('server-error', 'INVALID_REMOTE_SHARE_UPLOAD_ASSERTION_ERROR');
      }
      return response;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'developer-command'
    ) {
      const command = parseDeveloperCommandFrame(value);
      if (!command) throw createTransportError('server-error', 'INVALID_DEVELOPER_COMMAND');
      return command;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'developer-invalidation'
    ) {
      const invalidation = parseDeveloperInvalidationFrame(value);
      if (!invalidation) {
        throw createTransportError('server-error', 'INVALID_DEVELOPER_INVALIDATION');
      }
      return invalidation;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'pro-queue-addition'
    ) {
      const addition = parseProQueueAdditionFrame(value);
      if (!addition) {
        throw createTransportError('server-error', 'INVALID_DEVELOPER_QUEUE_ADDITION');
      }
      return addition;
    }
    return value as SignalingMessage;
  }

  private async handleHostMessage(
    raw: unknown,
    sequence = this.nextHostMessageSequence(),
    sourceSocket = this.hostSocket,
  ): Promise<void> {
    const message = await this.parseSignal(raw);
    if (this.destroyed || sourceSocket !== this.hostSocket) return;
    if (message.type === 'room-password-result') {
      if (message.mutationId !== this.roomPasswordMutationId) return;
      if (message.applied) {
        this.acknowledgedRoomPasswordMutationId = message.mutationId;
        this.acknowledgedRoomPasswordSocket = sourceSocket;
      } else {
        if (sourceSocket) this.noteSignalingSocketSemanticFailure(sourceSocket);
        try {
          log.warn(
            `[Transport] Standard room password mutation was not committed (${message.errorType || 'unknown'})`,
          );
        } catch {
          // A failed diagnostic must not consume the reconnect-owned intent.
        }
        try {
          if (sourceSocket?.readyState === WebSocket.OPEN) {
            sourceSocket.close(4001, 'ROOM_PASSWORD_RETRY_REQUIRED');
          }
        } catch {
          // The Worker also closes failed mutations. This local close is the
          // defensive convergence path for mixed versions or a lost close
          // frame; reconnect will replay the same desired PIN and mutation ID.
        }
      }
      return;
    }
    if (message.type === 'remote-share-upload-assertion') {
      if (!sourceSocket) return;
      const pending = this.takePendingRemoteShareUploadAssertion(
        message.correlationId,
        sourceSocket,
      );
      pending?.resolve(message.assertion);
      return;
    }
    if (message.type === 'remote-share-upload-assertion-error') {
      if (!sourceSocket) return;
      const pending = this.takePendingRemoteShareUploadAssertion(
        message.correlationId,
        sourceSocket,
      );
      pending?.reject(new Error(message.errorType));
      return;
    }
    if (message.type === 'developer-command') {
      if (this.proSignalingAccess?.role !== 'coordinator') {
        throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_COMMAND');
      }
      this.emit('developer-command', message);
      return;
    }
    if (message.type === 'developer-invalidation') {
      const access = this.proSignalingAccess;
      if (
        access?.role !== 'coordinator' ||
        message.roomCode !== access.roomCode ||
        message.coordinatorEpoch !== access.coordinatorEpoch
      ) {
        throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_INVALIDATION');
      }
      this.emit('developer-invalidation', message);
      return;
    }
    if (message.type === 'pro-queue-addition') {
      const access = this.proSignalingAccess;
      if (
        access?.role !== 'coordinator' ||
        message.roomCode !== access.roomCode ||
        message.coordinatorEpoch !== access.coordinatorEpoch
      ) {
        throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_QUEUE_ADDITION');
      }
      this.emit('pro-queue-addition', message);
      return;
    }
    if (message.type === 'peer-open') {
      if (sourceSocket) this.noteSignalingSocketAdmitted(sourceSocket);
      if (sourceSocket && isStandardHttpSignalingSocket(sourceSocket)) {
        this.hostUseHttpSignaling = true;
        promoteStandardHttpPreference();
      } else if (!this.proSignalingAccess && sourceSocket) {
        clearStandardHttpPreference();
      }
      if (
        !this.proSignalingAccess &&
        sourceSocket &&
        !isStandardHttpSignalingSocket(sourceSocket) &&
        message.signalingLivenessVersion === SIGNALING_LIVENESS_VERSION
      ) {
        this.signalingLiveness.start(sourceSocket);
      }
      if (message.remoteShareUploadAssertionVersion === 1) {
        this.remoteShareUploadAssertionObserved = true;
        this.remoteShareUploadAssertionStatus = 'supported';
      } else {
        this.remoteShareUploadAssertionStatus = this.remoteShareUploadAssertionObserved
          ? 'unavailable'
          : 'unsupported';
      }
      if (sourceSocket) this.standardRoomIdentityAdmittedHostSockets.add(sourceSocket);
      if (message.memberIdentity) this.applyStandardRoomIdentity(message.memberIdentity);
      if (this.hostRoomId && this.hostSocket) {
        this.sendPendingStandardRoomDeletion(this.hostRoomId, 'host', this.hostSocket);
        // Room admission and code display must never wait on the account API.
        // Attach (or clear/delete) account identity only after the Worker has
        // authenticated the RAM-only host secret and admitted this socket.
        void this.refreshStandardRoomIdentity().catch((error) => this.emit('error', error));
      }
      this.open = true;
      this.hostSignalingOpenedOnce = true;
      this.clearHostSetupAdmissionTimeout();
      this.hostRouteRetryController?.abort(new Error('HOST_SIGNALING_ADMITTED'));
      this.hostRouteRetryController = null;
      this.disconnected = false;
      this.emit('open', message.peerId);
      // host-auth commits a snapshot, but the local desired PIN can change
      // while that write is in flight. Always echo the current mutation after
      // peer-open; the Worker keeps guest admission fenced until it ACKs this
      // final confirmation.
      this.sendRoomPassword();
      return;
    }
    if (message.type === 'error') {
      if (sourceSocket) {
        this.noteSignalingSocketSemanticFailure(sourceSocket);
        if (!this.hostSignalingOpenedOnce && this.hostSocket === sourceSocket) {
          // The Worker has already supplied the authoritative setup result.
          // Revoke physical-socket ownership now so a following terminal close
          // or a lost terminal/watchdog cannot emit a second generic error.
          this.clearHostSetupAdmissionTimeout();
          this.hostSocket = null;
          this.retireSignalingSocket(sourceSocket);
        }
      }
      this.emit(
        'error',
        createTransportError(
          message.errorType ?? 'server-error',
          message.message ?? 'SIGNALING_ERROR',
        ),
      );
      return;
    }
    if (message.type === 'signal-offer') {
      const negotiationId = parseIceNegotiationId(message.negotiationId);
      if (negotiationId === null) return;
      if (sequence > (this.peerDepartureSequences.get(message.from) ?? -1)) {
        this.peerDepartureSequences.delete(message.from);
      }
      this.peerOfferSequences.set(message.from, sequence);
      const offerIdentity = normalizeStandardRoomMemberIdentity(message.memberIdentity);
      // An omitted identity is an authoritative anonymous projection for this
      // offer. Recording only explicit fields would let a replacement that
      // reuses the peer ID inherit the previous authenticated connection's
      // identity from peerIdentityProjections.
      this.rememberPeerIdentityProjection(message.from, sequence, offerIdentity);
      await this.handleHostOffer(
        message.from,
        message.sdp,
        negotiationId,
        message.metadata,
        offerIdentity,
        sequence,
        sourceSocket,
      );
      return;
    }
    if (message.type === 'account-identity') {
      this.applyStandardRoomIdentity(message.memberIdentity, message.clearReason);
      return;
    }
    if (message.type === 'account-member-updated') {
      const identity =
        message.memberIdentity === null
          ? null
          : normalizeStandardRoomMemberIdentity(message.memberIdentity);
      if (message.memberIdentity !== null && !identity) return;
      this.rememberPeerIdentityProjection(message.peerId, sequence, identity, message.clearReason);
      this.connections.get(message.peerId)?.updateRoomIdentity(identity, message.clearReason);
      return;
    }
    if (message.type === 'account-member-deleted') {
      if (/^member_[A-Za-z0-9_-]{22}$/.test(message.memberId)) {
        this.emit('room-member-deleted', message.memberId);
      }
      return;
    }
    if (message.type === 'signal-candidate') {
      const negotiationId = parseIceNegotiationId(message.negotiationId);
      if (negotiationId === null) return;
      await this.addRemoteCandidate(message.from, message.candidate, negotiationId);
      return;
    }
    if (message.type === 'media-answer') {
      const negotiationId = parseIceNegotiationId(message.negotiationId);
      if (negotiationId === null) return;
      await this.handleMediaAnswer(message.callId, message.sdp, negotiationId);
      return;
    }
    if (message.type === 'media-close') {
      this.mediaCalls.get(message.callId)?.closeFromRemote();
      this.mediaCalls.delete(message.callId);
      return;
    }
    if (message.type === 'peer-left') {
      // Signaling departure ends trickle for this socket identity even when an
      // already-established data channel is deliberately kept alive.
      this.peerDepartureSequences.set(message.peerId, sequence);
      const inFlightNegotiation = this.iceNegotiations.get(message.peerId);
      this.clearIcePeerState(message.peerId);
      this.peerIdentityProjections.delete(message.peerId);
      if (inFlightNegotiation && !inFlightNegotiation.settled) {
        try {
          inFlightNegotiation.pc.close();
        } catch {
          /* noop */
        }
      }
      const conn = this.connections.get(message.peerId);
      if (this.isDataConnectionAlive(conn)) {
        log.info(
          `[Transport] Ignoring signaling peer-left for ${message.peerId}; data channel is still alive`,
        );
        return;
      }
      conn?.close();
      for (const [callId, mediaConn] of this.mediaCalls) {
        if (mediaConn.peer === message.peerId) {
          mediaConn.closeFromRemote();
          this.mediaCalls.delete(callId);
        }
      }
    }
  }

  private async handleGuestMessage(
    roomId: string,
    socket: StandardSignalingSocket,
    conn: CloudflareDataConnection,
    metadata: unknown,
    raw: unknown,
  ): Promise<void> {
    const message = await this.parseSignal(raw);
    if (socket !== this.roomSockets.get(roomId)) return;
    if (message.type === 'developer-command') {
      throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_COMMAND');
    }
    if (message.type === 'developer-invalidation') {
      throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_INVALIDATION');
    }
    if (message.type === 'pro-queue-addition') {
      throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_QUEUE_ADDITION');
    }
    if (message.type === 'peer-open') {
      this.noteSignalingSocketAdmitted(socket);
      if (isStandardHttpSignalingSocket(socket)) {
        const currentRecord = this.guestRooms.get(roomId);
        if (currentRecord?.conn === conn) currentRecord.useHttpSignaling = true;
        promoteStandardHttpPreference();
      } else if (!this.proSignalingAccess) {
        clearStandardHttpPreference();
      }
      // Only the Worker's peer-open proves that guest-auth won admission for
      // this exact socket. Before this point guest-auth must remain the sole
      // first frame; background identity mutations would either close the
      // socket or be discarded while its asynchronous auth is in progress.
      this.standardRoomIdentityAdmittedGuestSockets.add(socket);
      const admittedRecord = this.guestRooms.get(roomId);
      if (admittedRecord?.conn === conn) {
        this.clearGuestSetupAdmissionTimeout(admittedRecord);
        admittedRecord.routeRetryController?.abort(new Error('GUEST_SIGNALING_ADMITTED'));
        admittedRecord.routeRetryController = null;
      }
      const refreshAfterAdmission =
        this.standardRoomIdentityRefreshAfterGuestAdmission.delete(socket);
      if (message.memberIdentity) this.applyStandardRoomIdentity(message.memberIdentity);
      this.sendPendingStandardRoomDeletion(roomId, 'guest', socket);
      this.disconnected = false;
      if (refreshAfterAdmission) {
        void this.refreshStandardRoomIdentity().catch((error) => conn.emit('error', error));
      }
      await this.startGuestOffer(roomId, socket, conn, metadata);
      return;
    }
    if (message.type === 'account-identity') {
      this.applyStandardRoomIdentity(message.memberIdentity, message.clearReason);
      return;
    }
    if (message.type === 'account-member-updated') return;
    if (message.type === 'error') {
      this.noteSignalingSocketSemanticFailure(socket);
      const error = createTransportError(
        message.errorType ?? 'server-error',
        message.message ?? 'SIGNALING_ERROR',
      );
      if (this.isDataConnectionAlive(conn)) {
        // These rejection frames concern the signaling socket, not necessarily
        // the established data channel. Emitting a connection error would tear
        // down a channel that may still work, so retire only the socket and
        // publish signaling loss for the outer reconnect backoff.
        const record = this.guestRooms.get(roomId);
        if (isPermanentGuestAuthError(message.errorType)) {
          if (record?.conn === conn) record.authFailed = true;
        }
        log.warn(
          '[Transport] Guest signaling rejected after establishment; preserving data channel',
          error,
        );
        if (record?.conn === conn) {
          this.retireGuestSignalingSocket(roomId, record, socket, true);
        } else if (this.roomSockets.get(roomId) === socket) {
          this.roomSockets.delete(roomId);
          this.retireSignalingSocket(socket);
        }
        return;
      }
      const preAdmissionRecord = this.guestRooms.get(roomId);
      if (preAdmissionRecord?.conn === conn && this.roomSockets.get(roomId) === socket) {
        this.clearGuestSetupAdmissionTimeout(preAdmissionRecord);
        this.roomSockets.delete(roomId);
        this.retireSignalingSocket(socket);
      }
      conn.emit('error', error);
      return;
    }
    if (message.type === 'signal-answer') {
      const negotiationId = parseIceNegotiationId(message.negotiationId);
      if (negotiationId === null) return;
      await this.handleGuestAnswer(roomId, message.sdp, negotiationId);
      return;
    }
    if (message.type === 'signal-candidate') {
      const negotiationId = parseIceNegotiationId(message.negotiationId);
      if (negotiationId === null) return;
      await this.addRemoteCandidate(roomId, message.candidate, negotiationId);
      return;
    }
    if (message.type === 'media-offer') {
      if (parseIceNegotiationId(message.negotiationId) === null) return;
      this.handleMediaOffer(roomId, message).catch((error) => conn.emit('error', error));
      return;
    }
    if (message.type === 'media-close') {
      this.mediaCalls.get(message.callId)?.closeFromRemote();
      this.mediaCalls.delete(message.callId);
      return;
    }
    if (message.type === 'peer-left') {
      this.clearIcePeerState(roomId);
      if (this.isDataConnectionAlive(conn)) {
        log.info('[Transport] Ignoring signaling peer-left for host; data channel is still alive');
        return;
      }
      conn.close();
    }
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(this.rtcConfiguration);
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return;
      const negotiation = this.iceNegotiations.get(peerId);
      // A replaced RTCPeerConnection may continue trickling after its successor
      // owns the peer. Never retag those candidates with the successor token.
      if (!negotiation || negotiation.pc !== pc || !this.isIceNegotiationCurrent(negotiation)) {
        log.debug(`[Transport] Ignoring ICE candidate from superseded connection for ${peerId}`);
        return;
      }
      // This listener outlives any individual signaling socket (candidates
      // can trickle after a socket blip + reopen), so resolve the CURRENT
      // socket at send time instead of capturing one. On the guest side the
      // peer ID is the room ID and therefore the roomSockets key. A missing
      // current socket fails with SIGNALING_SOCKET_NOT_OPEN.
      const socket = this.hostRoomId ? this.hostSocket : this.roomSockets.get(peerId);
      try {
        this.send(socket, {
          type: 'signal-candidate',
          to: this.hostRoomId ? peerId : 'host',
          candidate: event.candidate.toJSON(),
          negotiationId: negotiation.negotiationId,
        });
      } catch (error) {
        this.emit('error', error);
      }
    });
    return pc;
  }

  private async handleHostOffer(
    peerId: string,
    sdp: RTCSessionDescriptionInit,
    negotiationId: string,
    metadata: unknown,
    roomIdentity: StandardRoomMemberIdentity | null,
    offerSequence: number,
    sourceSocket: StandardSignalingSocket | null,
  ): Promise<void> {
    const waitedForRtcConfiguration = this.rtcConfigurationPending;
    if (waitedForRtcConfiguration) await this.rtcConfigurationReady;
    if (
      this.destroyed ||
      sourceSocket !== this.hostSocket ||
      !sourceSocket ||
      sourceSocket.readyState !== WebSocket.OPEN ||
      (waitedForRtcConfiguration && this.peerOfferSequences.get(peerId) !== offerSequence) ||
      (this.peerDepartureSequences.get(peerId) ?? -1) >= offerSequence
    ) {
      return;
    }
    const socket = sourceSocket;

    // Keep the established connection alive until the replacement has a data
    // channel and has synchronously reached the host lifecycle owner. Closing
    // it here lets Chromium's synchronous close/error event tear down the peer
    // before the replacement is registered.
    const previousConnection = this.connections.get(peerId);
    const conn = new CloudflareDataConnection(peerId, metadata, roomIdentity);
    const pc = this.createPeerConnection(peerId);
    conn.peerConnection = pc;
    const negotiation = this.beginIceNegotiation(peerId, pc, sdp, negotiationId);
    conn.on('close', () => {
      // Identity-guarded: a late close from a connection replaced by a newer
      // offer for the same peer must not evict the live record.
      if (this.connections.get(peerId) === conn) {
        this.connections.delete(peerId);
      }
      this.clearIcePeerState(peerId, pc);
    });

    pc.addEventListener('datachannel', (event) => {
      if (
        !this.isIceNegotiationCurrent(negotiation) ||
        (this.peerDepartureSequences.get(peerId) ?? -1) >= offerSequence
      ) {
        try {
          event.channel.close();
        } catch {
          /* noop */
        }
        conn.close();
        return;
      }
      const shouldEmitConnection = conn.attach(pc, event.channel);
      if (shouldEmitConnection) {
        const latestIdentity = this.peerIdentityProjections.get(peerId);
        if (latestIdentity) {
          conn.roomIdentity = latestIdentity.identity;
        }
        this.connections.set(peerId, conn);
        negotiation.settled = true;
        this.emit('connection', conn);
        if (previousConnection !== conn) previousConnection?.close();
      }
    });

    try {
      await pc.setRemoteDescription(sdp);
      if (!this.isIceNegotiationCurrent(negotiation)) {
        conn.close();
        return;
      }
      if (!(await this.flushRemoteCandidates(negotiation))) {
        conn.close();
        return;
      }
      const answer = await pc.createAnswer();
      if (!this.isIceNegotiationCurrent(negotiation)) {
        conn.close();
        return;
      }
      await pc.setLocalDescription(answer);
      if (!this.isIceNegotiationCurrent(negotiation)) {
        conn.close();
        return;
      }
      if (!pc.localDescription) throw createTransportError('webrtc', 'MISSING_LOCAL_DESCRIPTION');
      if (socket !== this.hostSocket || socket.readyState !== WebSocket.OPEN) {
        throw createTransportError('socket-closed', 'SIGNALING_SOCKET_NOT_OPEN');
      }
      this.send(socket, {
        type: 'signal-answer',
        to: peerId,
        sdp: pc.localDescription.toJSON(),
        negotiationId: negotiation.negotiationId,
      });
    } catch (error) {
      const stillCurrent = this.isIceNegotiationCurrent(negotiation);
      if (stillCurrent) {
        this.clearIcePeerState(peerId, pc);
      }
      conn.close();
      // Supersession is ordinary control flow: only the newest generation may
      // report a negotiation failure or send an answer.
      if (!stillCurrent) return;
      throw error;
    }
  }

  private async startGuestOffer(
    roomId: string,
    socket: StandardSignalingSocket,
    conn: CloudflareDataConnection,
    metadata: unknown,
  ): Promise<void> {
    if (this.rtcConfigurationPending) await this.rtcConfigurationReady;
    if (
      this.destroyed ||
      conn.peerConnection ||
      socket !== this.roomSockets.get(roomId) ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const pc = this.createPeerConnection(roomId);
    const negotiation = this.beginIceNegotiation(roomId, pc);
    const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, {
      ordered: true,
    });
    const controlChannel = pc.createDataChannel(CONTROL_CHANNEL_LABEL, {
      ordered: true,
    });
    conn.attach(pc, channel);
    conn.attach(pc, controlChannel);
    this.connections.set(roomId, conn);

    const offer = await pc.createOffer();
    if (!this.isIceNegotiationCurrent(negotiation)) return;
    await pc.setLocalDescription(offer);
    if (!this.isIceNegotiationCurrent(negotiation)) return;
    if (!pc.localDescription) throw createTransportError('webrtc', 'MISSING_LOCAL_DESCRIPTION');
    if (socket !== this.roomSockets.get(roomId) || socket.readyState !== WebSocket.OPEN) return;
    this.send(socket, {
      type: 'signal-offer',
      to: 'host',
      sdp: pc.localDescription.toJSON(),
      negotiationId: negotiation.negotiationId!,
      metadata,
    });
  }

  private async handleGuestAnswer(
    roomId: string,
    sdp: RTCSessionDescriptionInit,
    negotiationId: string,
  ): Promise<void> {
    const conn = this.connections.get(roomId);
    const pc = conn?.peerConnection;
    if (!pc) return;
    const negotiation = this.iceNegotiations.get(roomId);
    if (!negotiation || negotiation.pc !== pc) return;
    if (negotiation.purpose !== 'signal') return;
    if (!this.confirmRemoteNegotiationId(negotiation, negotiationId)) return;
    negotiation.remoteUfrag = remoteIceUfrag(sdp);
    negotiation.candidates = negotiation.candidates.filter((entry) =>
      this.candidateMatchesNegotiation(entry, negotiation),
    );
    negotiation.bytes = negotiation.candidates.reduce((total, entry) => total + entry.bytes, 0);
    await pc.setRemoteDescription(sdp);
    if (!(await this.flushRemoteCandidates(negotiation))) return;
    negotiation.settled = true;
  }

  async refreshStandardRoomIdentity(allowMixedDeletionRetry = true): Promise<void> {
    if (this.destroyed || this.proSignalingAccess || !this.id) return;
    // One generation covers every socket targeted by this logical refresh.
    // Starting a newer refresh makes every older provider result stale while
    // still allowing same-generation host/guest targets to finish independently.
    const refreshGeneration = ++this.standardRoomIdentityRefreshGeneration;
    this.standardRoomIdentityActiveRefreshGenerations.add(refreshGeneration);
    const peerId = this.id;
    const targets: Array<{
      roomCode: string;
      role: 'host' | 'guest';
      socket: StandardSignalingSocket;
    }> = [];
    if (
      this.hostRoomId &&
      this.hostSocket &&
      this.hostSocket.readyState === WebSocket.OPEN &&
      this.standardRoomIdentityAdmittedHostSockets.has(this.hostSocket)
    ) {
      targets.push({ roomCode: this.hostRoomId, role: 'host', socket: this.hostSocket });
    }
    for (const [roomCode, socket] of this.roomSockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (this.standardRoomIdentityAdmittedGuestSockets.has(socket)) {
        targets.push({ roomCode, role: 'guest', socket });
      } else {
        // Preserve the newest logical refresh across guest admission without
        // violating the Worker's guest-auth-first-frame protocol. peer-open
        // consumes this marker and immediately fetches the latest projection.
        this.standardRoomIdentityRefreshAfterGuestAdmission.add(socket);
      }
    }
    try {
      const results = await Promise.all(
        targets.map(async ({ roomCode, role, socket }) => {
          const assertions = await this.getStandardRoomAssertions(
            roomCode,
            peerId,
            role,
            STANDARD_ROOM_ASSERTION_RENEWAL_WAIT_MS,
          );
          return { roomCode, role, socket, assertions };
        }),
      );
      if (refreshGeneration !== this.standardRoomIdentityRefreshGeneration || this.destroyed) {
        return;
      }

      const isCurrentTarget = ({ roomCode, role, socket }: (typeof results)[number]): boolean => {
        const currentSocket = role === 'host' ? this.hostSocket : this.roomSockets.get(roomCode);
        return socket === currentSocket && socket.readyState === WebSocket.OPEN;
      };
      const deletionResults = results.filter(({ assertions }) => assertions?.deletionAssertion);
      if (deletionResults.length > 0) {
        // Deletion is generation-wide and dominant. Provider calls are
        // projection-bound individually, but two physical targets can still
        // observe opposite sides of the account-deletion commit. Never let a
        // faster deletion proof be followed by a slower pre-delete attach.
        this.standardRoomIdentityRefreshGeneration += 1;
        this.scheduleStandardRoomIdentityRefresh(null);
        clearManagedTimer(this.standardRoomIdentityDeletionReconcileTimerKey);
        let sentDeletionProofs = 0;
        for (const result of deletionResults) {
          if (!isCurrentTarget(result)) continue;
          result.socket.send(
            JSON.stringify({
              type: 'account-identity-delete',
              deletionAssertion: result.assertions!.deletionAssertion,
            }),
          );
          sentDeletionProofs += 1;
        }
        const targetLacksUsableDeletionProof =
          deletionResults.length < results.length || sentDeletionProofs < deletionResults.length;
        if (allowMixedDeletionRetry && targetLacksUsableDeletionProof) {
          this.scheduleStandardRoomIdentityDeletionReconcile();
        }
        return;
      }

      const hasAuthoritativeClear = results.some(
        ({ assertions }) =>
          assertions !== undefined &&
          assertions.accountAssertion === null &&
          assertions.deletionAssertion === null,
      );
      if (hasAuthoritativeClear) {
        // HTTP 401/session expiry is authoritative account-wide state. Just as
        // with deletion, concurrent physical-target calls can straddle that
        // transition. Clear every current socket and suppress any stale
        // positive or transient result from this generation.
        this.standardRoomIdentityRefreshGeneration += 1;
        this.scheduleStandardRoomIdentityRefresh(null);
        // A previously armed deletion-proof reconciliation has higher
        // authority and remains independent from ordinary logout renewal.
        for (const result of results) {
          if (!isCurrentTarget(result)) continue;
          result.socket.send(JSON.stringify({ type: 'account-identity-clear' }));
        }
        return;
      }

      for (const result of results) {
        if (!isCurrentTarget(result)) continue;
        const { assertions, socket } = result;
        if (assertions === undefined) {
          this.scheduleStandardRoomIdentityRefresh(STANDARD_ROOM_IDENTITY_RETRY_MS);
          continue;
        }
        if (assertions.accountAssertion) {
          socket.send(
            JSON.stringify({
              type: 'account-identity-refresh',
              accountAssertion: assertions.accountAssertion,
            }),
          );
          continue;
        }
      }
    } finally {
      this.standardRoomIdentityActiveRefreshGenerations.delete(refreshGeneration);
    }
  }

  deleteStandardRoomIdentity(): void {
    // The App Worker mints a deletion-audience assertion only after the D1
    // account deletion transaction commits. A normal attach assertion is
    // intentionally never cached or repurposed as deletion authority.
    this.refreshStandardRoomIdentity().catch((error) =>
      this.handleStandardRoomIdentityBackgroundFailure(error, 'deletion'),
    );
  }

  private async startMediaOffer(
    peerId: string,
    mediaConn: CloudflareMediaConnection,
  ): Promise<void> {
    const socket = this.hostSocket;
    const pc = mediaConn.peerConnection;
    if (!socket || socket.readyState !== WebSocket.OPEN || !pc) {
      throw createTransportError('socket-closed', 'SIGNALING_SOCKET_NOT_OPEN');
    }
    await this.waitForStableSignaling(pc);
    const negotiation = this.beginIceNegotiation(
      peerId,
      pc,
      undefined,
      undefined,
      'media',
      mediaConn.callId,
    );
    const offer = await pc.createOffer();
    if (!this.isIceNegotiationCurrent(negotiation)) return;
    await pc.setLocalDescription(offer);
    if (!this.isIceNegotiationCurrent(negotiation)) return;
    if (!pc.localDescription) throw createTransportError('webrtc', 'MISSING_LOCAL_DESCRIPTION');
    this.send(socket, {
      type: 'media-offer',
      to: peerId,
      callId: mediaConn.callId,
      sdp: pc.localDescription.toJSON(),
      negotiationId: negotiation.negotiationId!,
      metadata: mediaConn.metadata,
      audioTrackCount: Math.max(1, pc.getSenders().filter((s) => s.track?.kind === 'audio').length),
    });
  }

  private async handleMediaOffer(
    roomId: string,
    message: Extract<SignalingMessage, { type: 'media-offer' }>,
  ): Promise<void> {
    const parsedNegotiationId = parseIceNegotiationId(message.negotiationId);
    if (parsedNegotiationId === null) return;
    const conn = this.connections.get(roomId);
    const pc = conn?.peerConnection;
    if (!pc) throw createTransportError('webrtc', 'MEDIA_PEER_CONNECTION_MISSING');

    const existing = this.mediaCalls.get(message.callId);
    if (existing) existing.closeFromRemote();

    const mediaConn = new CloudflareMediaConnection(
      roomId,
      message.callId,
      message.metadata,
      message.audioTrackCount ?? 1,
    );
    mediaConn.attachPeerConnection(pc);
    mediaConn.setRemoteOffer(message.sdp);
    mediaConn.setAnswerHandler(async (incomingConn, stream) => {
      if (stream) incomingConn.addLocalStream(stream);
      const offer = incomingConn.getRemoteOffer();
      if (!offer) throw createTransportError('webrtc', 'MEDIA_OFFER_MISSING');
      await this.waitForStableSignaling(pc);
      if (this.mediaCalls.get(incomingConn.callId) !== incomingConn) return;
      const negotiation = this.beginIceNegotiation(
        roomId,
        pc,
        offer,
        parsedNegotiationId,
        'media',
        incomingConn.callId,
      );
      await pc.setRemoteDescription(offer);
      if (!(await this.flushRemoteCandidates(negotiation))) return;
      const answer = await pc.createAnswer();
      if (!this.isIceNegotiationCurrent(negotiation)) return;
      await pc.setLocalDescription(answer);
      if (!this.isIceNegotiationCurrent(negotiation)) return;
      if (!pc.localDescription) throw createTransportError('webrtc', 'MISSING_LOCAL_DESCRIPTION');
      negotiation.settled = true;
      // answer() may run long after the socket that delivered the offer died
      // (signaling blip + reopen mid system-audio handshake), so resolve the
      // current room socket at send time. A missing current socket fails with
      // SIGNALING_SOCKET_NOT_OPEN.
      this.send(this.roomSockets.get(roomId), {
        type: 'media-answer',
        to: 'host',
        callId: incomingConn.callId,
        sdp: pc.localDescription.toJSON(),
        negotiationId: negotiation.negotiationId,
      });
    });
    mediaConn.setCloseHandler((closedConn, notifyRemote) =>
      this.closeMediaCall(roomId, closedConn.callId, notifyRemote),
    );
    this.mediaCalls.set(message.callId, mediaConn);
    this.emit('call', mediaConn);
  }

  private async handleMediaAnswer(
    callId: string,
    sdp: RTCSessionDescriptionInit,
    negotiationId: string,
  ): Promise<void> {
    const mediaConn = this.mediaCalls.get(callId);
    const pc = mediaConn?.peerConnection;
    if (!mediaConn || !pc) return;
    const negotiation = this.iceNegotiations.get(mediaConn.peer);
    if (!negotiation || negotiation.pc !== pc) return;
    if (negotiation.purpose !== 'media' || negotiation.callId !== callId) return;
    if (!this.confirmRemoteNegotiationId(negotiation, negotiationId)) return;
    negotiation.remoteUfrag = remoteIceUfrag(sdp);
    negotiation.candidates = negotiation.candidates.filter((entry) =>
      this.candidateMatchesNegotiation(entry, negotiation),
    );
    negotiation.bytes = negotiation.candidates.reduce((total, entry) => total + entry.bytes, 0);
    await pc.setRemoteDescription(sdp);
    if (!(await this.flushRemoteCandidates(negotiation))) return;
    negotiation.settled = true;
  }

  private closeMediaCall(peerId: string, callId: string, notifyRemote: boolean): void {
    this.mediaCalls.delete(callId);
    if (!notifyRemote) return;

    const socket = this.hostRoomId ? this.hostSocket : this.roomSockets.get(peerId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      this.send(socket, {
        type: 'media-close',
        to: this.hostRoomId ? peerId : 'host',
        callId,
      });
    } catch {
      /* noop */
    }
  }

  private async waitForStableSignaling(pc: RTCPeerConnection): Promise<void> {
    if (pc.signalingState === 'stable') return;
    await Promise.race([
      new Promise<void>((resolve) => {
        const onChange = (): void => {
          if (pc.signalingState !== 'stable') return;
          pc.removeEventListener('signalingstatechange', onChange);
          resolve();
        };
        pc.addEventListener('signalingstatechange', onChange);
      }),
      delay(3000),
    ]);
    const finalState = pc.signalingState as RTCSignalingState;
    if (finalState !== 'stable') {
      throw createTransportError('webrtc', `SIGNALING_NOT_STABLE:${finalState}`);
    }
  }

  private isIceNegotiationCurrent(owner: IceNegotiationOwner): boolean {
    return (
      this.iceNegotiations.get(owner.peerId) === owner && owner.pc.connectionState !== 'closed'
    );
  }

  private candidateMatchesNegotiation(
    entry: QueuedIceCandidate,
    owner: IceNegotiationOwner,
  ): boolean {
    if (!candidateMatchesRemoteUfrag(entry.candidate, owner.remoteUfrag)) return false;
    return entry.negotiationId === owner.negotiationId;
  }

  private confirmRemoteNegotiationId(owner: IceNegotiationOwner, negotiationId: string): boolean {
    if (negotiationId !== owner.negotiationId) {
      log.warn(
        `[Transport] Ignoring answer with mismatched ICE negotiation token for ${owner.peerId}`,
      );
      return false;
    }
    owner.candidates = owner.candidates.filter((entry) =>
      this.candidateMatchesNegotiation(entry, owner),
    );
    owner.bytes = owner.candidates.reduce((total, entry) => total + entry.bytes, 0);
    return true;
  }

  private candidateBytes(candidate: RTCIceCandidateInit, negotiationId: string): number | null {
    try {
      return textEncoder.encode(JSON.stringify({ candidate, negotiationId })).byteLength;
    } catch {
      log.warn('[Transport] Dropping non-serializable ICE candidate');
      return null;
    }
  }

  private queuePendingCandidate(peerId: string, entry: QueuedIceCandidate): void {
    const tokenKey = entry.negotiationId;
    const peerBuckets = this.pendingCandidates.get(peerId) ?? new Map<string, PendingIceBucket>();
    const bucket = peerBuckets.get(tokenKey) ?? {
      candidates: [],
      bytes: 0,
      updatedAt: entry.receivedAt,
    };
    bucket.candidates.push(entry);
    bucket.bytes += entry.bytes;
    bucket.updatedAt = entry.receivedAt;
    peerBuckets.set(tokenKey, bucket);
    this.pendingCandidates.set(peerId, peerBuckets);
    this.enforceIceMemoryBudget();
  }

  private pruneIceQueues(now = Date.now(), force = false): void {
    if (!force && now - this.lastIceQueuePruneAt < ICE_QUEUE_PRUNE_INTERVAL_MS) return;
    this.lastIceQueuePruneAt = now;
    const cutoff = now - ICE_QUEUE_TTL_MS;
    for (const [peerId, peerBuckets] of this.pendingCandidates) {
      for (const [tokenKey, bucket] of peerBuckets) {
        bucket.candidates = bucket.candidates.filter((entry) => entry.receivedAt >= cutoff);
        bucket.bytes = bucket.candidates.reduce((total, entry) => total + entry.bytes, 0);
        if (bucket.candidates.length === 0) peerBuckets.delete(tokenKey);
      }
      if (peerBuckets.size === 0) this.pendingCandidates.delete(peerId);
    }
    for (const owner of this.iceNegotiations.values()) {
      owner.candidates = owner.candidates.filter((entry) => entry.receivedAt >= cutoff);
      owner.bytes = owner.candidates.reduce((total, entry) => total + entry.bytes, 0);
    }
  }

  private queuedIceBytes(): number {
    let total = 0;
    for (const peerBuckets of this.pendingCandidates.values()) {
      for (const bucket of peerBuckets.values()) total += bucket.bytes;
    }
    for (const owner of this.iceNegotiations.values()) total += owner.bytes;
    return total;
  }

  /**
   * Emergency soft eviction only. Ordinary candidate sets remain far below a
   * multi-megabyte queue even with multiple interfaces and TURN gathering.
   * Evict the oldest queued records rather than imposing a media-size-related
   * candidate count cap. Eviction happens in one batch down to a lower-water
   * mark so hostile trickle cannot force a full scan for every new candidate.
   */
  private enforceIceMemoryBudget(): void {
    this.pruneIceQueues();
    let total = this.queuedIceBytes();
    if (total <= ICE_QUEUE_MEMORY_BUDGET_BYTES) return;

    const oldestFirst: QueuedIceCandidate[] = [];
    for (const peerBuckets of this.pendingCandidates.values()) {
      for (const bucket of peerBuckets.values()) {
        for (const entry of bucket.candidates) oldestFirst.push(entry);
      }
    }
    for (const owner of this.iceNegotiations.values()) {
      for (const entry of owner.candidates) oldestFirst.push(entry);
    }
    oldestFirst.sort((left, right) => left.receivedAt - right.receivedAt);

    const evicted = new Set<QueuedIceCandidate>();
    for (const entry of oldestFirst) {
      if (total <= ICE_QUEUE_MEMORY_RETAIN_BYTES) break;
      evicted.add(entry);
      total -= entry.bytes;
    }

    for (const [peerId, peerBuckets] of this.pendingCandidates) {
      for (const [tokenKey, bucket] of peerBuckets) {
        if (!bucket.candidates.some((entry) => evicted.has(entry))) continue;
        bucket.candidates = bucket.candidates.filter((entry) => !evicted.has(entry));
        bucket.bytes = bucket.candidates.reduce((sum, entry) => sum + entry.bytes, 0);
        if (bucket.candidates.length === 0) peerBuckets.delete(tokenKey);
      }
      if (peerBuckets.size === 0) this.pendingCandidates.delete(peerId);
    }
    for (const owner of this.iceNegotiations.values()) {
      if (!owner.candidates.some((entry) => evicted.has(entry))) continue;
      owner.candidates = owner.candidates.filter((entry) => !evicted.has(entry));
      owner.bytes = owner.candidates.reduce((sum, entry) => sum + entry.bytes, 0);
    }
    log.warn('[Transport] Pending ICE memory budget exceeded; evicted oldest candidates');
  }

  private beginIceNegotiation(
    peerId: string,
    pc: RTCPeerConnection,
    remoteDescription?: RTCSessionDescriptionInit,
    remoteNegotiationId?: string,
    purpose: 'signal' | 'media' = 'signal',
    callId: string | null = null,
  ): IceNegotiationOwner {
    this.pruneIceQueues(Date.now(), true);
    const prior = this.iceNegotiations.get(peerId);
    const establishedPc = this.connections.get(peerId)?.peerConnection;
    if (prior && prior.pc !== pc && prior.pc !== establishedPc) {
      // A superseded incomplete offer has no lifecycle owner. Closing it
      // causes its pending WebRTC awaits to reject and release resources while
      // an established incumbent (if any) remains untouched.
      try {
        prior.pc.close();
      } catch {
        /* noop */
      }
    }

    const answeringRemoteOffer = remoteDescription !== undefined;
    if (answeringRemoteOffer && !remoteNegotiationId) {
      throw createTransportError('webrtc', 'MISSING_NEGOTIATION_ID');
    }
    const negotiationId = remoteNegotiationId ?? randomBase64Url(18);
    const remoteUfrag = remoteDescription ? remoteIceUfrag(remoteDescription) : null;
    const owner: IceNegotiationOwner = {
      generation: ++this.iceNegotiationGeneration,
      peerId,
      pc,
      purpose,
      callId,
      negotiationId,
      remoteUfrag,
      candidates: [],
      bytes: 0,
      createdAt: Date.now(),
      settled: false,
    };
    if (answeringRemoteOffer) {
      const peerBuckets = this.pendingCandidates.get(peerId);
      const tokenKey = negotiationId;
      const early = peerBuckets?.get(tokenKey);
      peerBuckets?.delete(tokenKey);
      if (peerBuckets?.size === 0) this.pendingCandidates.delete(peerId);
      owner.candidates = (early?.candidates ?? []).filter((entry) =>
        this.candidateMatchesNegotiation(entry, owner),
      );
      owner.bytes = owner.candidates.reduce((total, entry) => total + entry.bytes, 0);
    }
    this.iceNegotiations.set(peerId, owner);
    return owner;
  }

  private clearIcePeerState(peerId: string, pc?: RTCPeerConnection): void {
    this.pendingCandidates.delete(peerId);
    const owner = this.iceNegotiations.get(peerId);
    if (!owner || (pc && owner.pc !== pc)) return;
    owner.candidates = [];
    owner.bytes = 0;
    this.iceNegotiations.delete(peerId);
  }

  private clearAllIceState(): void {
    this.pendingCandidates.clear();
    this.iceNegotiations.clear();
    this.lastIceQueuePruneAt = 0;
  }

  private async addRemoteCandidate(
    peerId: string,
    candidate: RTCIceCandidateInit,
    negotiationId: string,
  ): Promise<void> {
    const bytes = this.candidateBytes(candidate, negotiationId);
    if (bytes === null) return;
    const entry: QueuedIceCandidate = {
      candidate,
      negotiationId,
      receivedAt: Date.now(),
      bytes,
    };
    const owner = this.iceNegotiations.get(peerId);
    if (!owner) {
      this.queuePendingCandidate(peerId, entry);
      return;
    }
    if (!this.candidateMatchesNegotiation(entry, owner)) {
      // A candidate can legally precede its offer on the signaling socket.
      // Preserve it in the token-isolated early bucket for a future owner.
      this.queuePendingCandidate(peerId, entry);
      return;
    }
    if (!owner.pc.remoteDescription) {
      owner.candidates.push(entry);
      owner.bytes += bytes;
      this.enforceIceMemoryBudget();
      return;
    }
    if (!this.isIceNegotiationCurrent(owner)) return;
    try {
      await owner.pc.addIceCandidate(candidate);
    } catch (error) {
      if (this.isIceNegotiationCurrent(owner)) {
        log.warn('[Transport] Failed to add ICE candidate:', error);
      }
    }
  }

  private async flushRemoteCandidates(owner: IceNegotiationOwner): Promise<boolean> {
    if (!this.isIceNegotiationCurrent(owner)) return false;
    const queued = owner.candidates;
    owner.candidates = [];
    owner.bytes = 0;
    for (const entry of queued) {
      if (!this.isIceNegotiationCurrent(owner)) return false;
      if (!this.candidateMatchesNegotiation(entry, owner)) continue;
      try {
        await owner.pc.addIceCandidate(entry.candidate);
      } catch (error) {
        if (this.isIceNegotiationCurrent(owner)) {
          log.warn('[Transport] Failed to add queued ICE candidate:', error);
        }
      }
    }
    return this.isIceNegotiationCurrent(owner);
  }
}

export function createCloudflarePeer(
  requestedId: string | null,
  options: TransportPeerOptions,
): TransportPeer {
  log.info('[Transport] Using Cloudflare Durable Object signaling');
  return new CloudflareSignalingPeer(requestedId, options);
}
