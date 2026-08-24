/**
 * Standard-room operator queue mutation authority and two-phase result fence.
 *
 * The host is still the only queue writer. These acknowledgements only prove
 * that the host understands a request (`accepted`) and later report its
 * terminal outcome (`settled`). Guests never project queue state from an ACK;
 * the authoritative playlist snapshot remains the sole state source.
 */

import { MSG } from '../core/constants.ts';
import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { SessionScope } from '../core/session-scope.ts';
import { getState } from '../core/state.ts';
import { getRoomContext, hasRoomCapability, verifyPeerCapability } from '../rooms/authority.ts';
import type { DataConnection, ProtocolMsg, RoomCapability } from '../types/index.ts';
import { safeSend } from './peer-state.ts';
import { registerHandler } from './protocol.ts';

const MAX_REQUESTS_PER_CONNECTION = 256;
const MAX_PENDING_GUEST_REQUESTS = 64;
const ACCEPT_TIMEOUT_MS = 2_500;
const SETTLE_TIMEOUT_MS = 12_000;

type QueueMutationResult = ProtocolMsg<typeof MSG.OPERATOR_QUEUE_MUTATION_RESULT>;
export type StandardQueueMutationResultCode = NonNullable<QueueMutationResult['code']>;
type StandardQueueMutationRequest =
  | ProtocolMsg<typeof MSG.REQUEST_PLAYLIST_ADD_YOUTUBE>
  | ProtocolMsg<typeof MSG.REQUEST_PLAYLIST_REMOVE>
  | ProtocolMsg<typeof MSG.REQUEST_PLAYLIST_REORDER>;

function requiredQueueMutationCapability(
  messageOrName: StandardQueueMutationRequest | StandardQueueMutationRequest['type'],
): RoomCapability {
  const type = typeof messageOrName === 'string' ? messageOrName : messageOrName.type;
  return type === MSG.REQUEST_PLAYLIST_ADD_YOUTUBE ? 'media.add' : 'queue.mutate';
}

type QueueMutationClaim = 'accepted' | 'duplicate' | 'conflict';
type StandardQueueMutationRequestOutcome = QueueMutationClaim | 'unauthorized' | 'overloaded';

interface HostMutationRecord {
  fingerprint: string;
  acceptedRevision: number;
  settled: null | {
    outcome: 'applied' | 'rejected';
    revision: number;
    code: StandardQueueMutationResultCode | null;
  };
}

interface PendingGuestMutation {
  conn: DataConnection;
  accepted: boolean;
}

const requestsByConnection = new WeakMap<DataConnection, Map<string, HostMutationRecord>>();
const pendingGuestMutations = new Map<string, PendingGuestMutation>();
let guestLifecycleScope: SessionScope | null = null;
let guestMutationScope: SessionScope | null = null;

function acceptTimerKey(requestId: string): string {
  return `operator-queue-accept-${requestId}`;
}

function settleTimerKey(requestId: string): string {
  return `operator-queue-settle-${requestId}`;
}

function clearGuestMutation(requestId: string): void {
  pendingGuestMutations.delete(requestId);
  guestMutationScope?.clearTimer(acceptTimerKey(requestId));
  guestMutationScope?.clearTimer(settleTimerKey(requestId));
}

function cancelAllGuestMutations(): void {
  pendingGuestMutations.clear();
  guestMutationScope?.dispose();
  guestMutationScope = null;
}

function ensureGuestMutationScope(): SessionScope {
  if (guestMutationScope && !guestMutationScope.aborted) return guestMutationScope;
  const lifecycle = guestLifecycleScope ?? (guestLifecycleScope = new SessionScope());
  guestMutationScope = lifecycle.child();
  return guestMutationScope;
}

function failGuestMutation(
  requestId: string,
  reason: 'send-failed' | 'accept-timeout' | 'settle-timeout' | 'rejected',
  code: StandardQueueMutationResultCode | null = null,
): void {
  if (!pendingGuestMutations.has(requestId) && reason !== 'send-failed') return;
  clearGuestMutation(requestId);
  bus.emit('playlist:refresh-requested');
  bus.emit('standard-room:queue-mutation-failed', reason, code);
}

function isExactLiveStandardGuestConnection(conn: DataConnection): boolean {
  return (
    getRoomContext().kind === 'standard' &&
    getState('network.appRole') === 'host' &&
    !getState('network.hostConn') &&
    conn.open === true &&
    !!conn.peer &&
    getState('network.activeHostConnByPeerId').get(conn.peer) === conn &&
    getState('network.connectedPeers').some((peer) => peer.id === conn.peer && peer.conn === conn)
  );
}

function sendMutationResult(
  conn: DataConnection,
  requestId: string,
  phase: 'accepted' | 'settled',
  outcome: null | 'applied' | 'rejected',
  revision: number,
  code: StandardQueueMutationResultCode | null,
): boolean {
  if (!isExactLiveStandardGuestConnection(conn)) return false;
  return safeSend(conn, {
    type: MSG.OPERATOR_QUEUE_MUTATION_RESULT,
    requestId,
    phase,
    outcome,
    revision,
    code,
  });
}

function replayHostMutationResult(
  conn: DataConnection,
  requestId: string,
  record: HostMutationRecord,
): void {
  sendMutationResult(conn, requestId, 'accepted', null, record.acceptedRevision, null);
  if (!record.settled) return;
  sendMutationResult(
    conn,
    requestId,
    'settled',
    record.settled.outcome,
    record.settled.revision,
    record.settled.code,
  );
}

function claimQueueMutationRequest(
  conn: DataConnection,
  requestId: string,
  fingerprint: string,
): QueueMutationClaim | 'overloaded' {
  let requests = requestsByConnection.get(conn);
  if (!requests) {
    requests = new Map<string, HostMutationRecord>();
    requestsByConnection.set(conn, requests);
  }

  const previous = requests.get(requestId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) return 'conflict';
    replayHostMutationResult(conn, requestId, previous);
    return 'duplicate';
  }

  if (requests.size >= MAX_REQUESTS_PER_CONNECTION) {
    for (const [settledRequestId, record] of requests) {
      if (!record.settled) continue;
      requests.delete(settledRequestId);
      if (requests.size < MAX_REQUESTS_PER_CONNECTION) break;
    }
    if (requests.size >= MAX_REQUESTS_PER_CONNECTION) return 'overloaded';
  }

  const record: HostMutationRecord = {
    fingerprint,
    acceptedRevision: getState('playlist.revision'),
    settled: null,
  };
  requests.set(requestId, record);
  sendMutationResult(conn, requestId, 'accepted', null, record.acceptedRevision, null);
  return 'accepted';
}

export function acceptStandardQueueMutationRequest(input: {
  conn: DataConnection;
  requestId: string;
  requestName: string;
  fingerprint: string;
}): StandardQueueMutationRequestOutcome {
  const { conn, requestId, requestName, fingerprint } = input;
  const capability = requiredQueueMutationCapability(
    requestName as StandardQueueMutationRequest['type'],
  );
  if (!isExactLiveStandardGuestConnection(conn) || !verifyPeerCapability(conn, capability)) {
    log.warn(`[Playlist] Rejected ${requestName} from unauthorized connection: ${conn.peer}`);
    if (isExactLiveStandardGuestConnection(conn)) {
      sendMutationResult(
        conn,
        requestId,
        'settled',
        'rejected',
        getState('playlist.revision'),
        'unauthorized',
      );
    }
    return 'unauthorized';
  }

  const claim = claimQueueMutationRequest(conn, requestId, fingerprint);
  if (claim === 'conflict') {
    log.warn(`[Playlist] Rejected conflicting request ID for ${requestName}: ${conn.peer}`);
    sendMutationResult(
      conn,
      requestId,
      'settled',
      'rejected',
      getState('playlist.revision'),
      'conflict',
    );
  } else if (claim === 'overloaded') {
    log.warn(`[Playlist] Rejected excess pending ${requestName} requests: ${conn.peer}`);
    sendMutationResult(
      conn,
      requestId,
      'settled',
      'rejected',
      getState('playlist.revision'),
      'internal-error',
    );
  }
  return claim;
}

export function settleStandardQueueMutationRequest(
  conn: DataConnection,
  requestId: string,
  settlement:
    | { outcome: 'applied' }
    | { outcome: 'rejected'; code: StandardQueueMutationResultCode },
): boolean {
  const record = requestsByConnection.get(conn)?.get(requestId);
  if (!record) {
    log.debug(`[Playlist] Ignored settlement for unknown request: ${requestId}`);
    return false;
  }

  if (!record.settled) {
    record.settled = {
      outcome: settlement.outcome,
      revision: getState('playlist.revision'),
      code: settlement.outcome === 'applied' ? null : settlement.code,
    };
  }
  return sendMutationResult(
    conn,
    requestId,
    'settled',
    record.settled.outcome,
    record.settled.revision,
    record.settled.code,
  );
}

/**
 * Submit one standard-room operator queue request without optimistic state.
 * No automatic retry is performed: a silent old host gets a compatibility
 * timeout, while the UI re-renders from its last authoritative snapshot.
 */
export function sendStandardQueueMutationRequest(message: StandardQueueMutationRequest): boolean {
  const conn = getState('network.hostConn');
  if (
    getRoomContext().kind !== 'standard' ||
    getState('network.appRole') !== 'guest' ||
    conn?.open !== true ||
    !hasRoomCapability(requiredQueueMutationCapability(message))
  ) {
    bus.emit('playlist:refresh-requested');
    bus.emit('standard-room:queue-mutation-failed', 'rejected', 'unauthorized');
    return false;
  }
  if (pendingGuestMutations.size >= MAX_PENDING_GUEST_REQUESTS) {
    bus.emit('playlist:refresh-requested');
    bus.emit('standard-room:queue-mutation-failed', 'rejected', 'internal-error');
    return false;
  }

  pendingGuestMutations.set(message.requestId, { conn, accepted: false });
  const scope = ensureGuestMutationScope();
  scope.timer(
    acceptTimerKey(message.requestId),
    () => failGuestMutation(message.requestId, 'accept-timeout'),
    ACCEPT_TIMEOUT_MS,
  );
  scope.timer(
    settleTimerKey(message.requestId),
    () => failGuestMutation(message.requestId, 'settle-timeout'),
    SETTLE_TIMEOUT_MS,
  );

  if (safeSend(conn, message)) return true;
  failGuestMutation(message.requestId, 'send-failed');
  return false;
}

function handleQueueMutationResult(data: QueueMutationResult, conn: DataConnection): void {
  const pending = pendingGuestMutations.get(data.requestId);
  if (!pending || pending.conn !== conn || getState('network.hostConn') !== conn) return;

  if (data.phase === 'accepted') {
    if (pending.accepted) return;
    pending.accepted = true;
    guestMutationScope?.clearTimer(acceptTimerKey(data.requestId));
    return;
  }

  clearGuestMutation(data.requestId);
  if (data.outcome === 'rejected') {
    bus.emit('playlist:refresh-requested');
    bus.emit('standard-room:queue-mutation-failed', 'rejected', data.code);
  }
}

export function initStandardQueueMutationAuthority(): void {
  cancelAllGuestMutations();
  guestLifecycleScope = SessionScope.replace(guestLifecycleScope);
  const scope = guestLifecycleScope;
  registerHandler(MSG.OPERATOR_QUEUE_MUTATION_RESULT, handleQueueMutationResult);

  scope.own(
    bus.on('state:network.hostConn', (nextConn) => {
      for (const [requestId, pending] of pendingGuestMutations) {
        if (nextConn !== pending.conn) clearGuestMutation(requestId);
      }
    }),
  );
  scope.own(
    bus.on('state:network.isOperator', (isOperator) => {
      if (isOperator !== true) cancelAllGuestMutations();
    }),
  );
  scope.own(
    bus.on('state:network.standardRoomCapabilities', () => {
      // A fine-grained permission edit can revoke the request capability while
      // the compatibility ADMIN projection remains true.
      cancelAllGuestMutations();
    }),
  );
  scope.own(
    bus.on('state:network.appRole', (role) => {
      if (role !== 'guest') cancelAllGuestMutations();
    }),
  );
  scope.own(
    bus.on('state:room.context', (context) => {
      if (
        !context ||
        typeof context !== 'object' ||
        (context as { kind?: unknown }).kind !== 'standard'
      ) {
        cancelAllGuestMutations();
      }
    }),
  );
}

export const standardQueueMutationTimingForTests = {
  acceptTimeoutMs: ACCEPT_TIMEOUT_MS,
  settleTimeoutMs: SETTLE_TIMEOUT_MS,
} as const;
