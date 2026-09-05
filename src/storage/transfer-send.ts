/**
 * MUSIXQUARE — File Transfer: Send Side
 *
 * broadcastFile (host → all peers) and unicastFile (host → single peer).
 */

import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, DELAY } from '../core/constants.ts';
import { delay, setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { filterEligiblePeers, canSendFileTo, safeSend } from '../network/peer.ts';
import { SessionScope } from '../core/session-scope.ts';
import {
  pumpChunksToPeers,
  isPeerConnectionCurrent,
  isBulkTransferWritablePeer,
} from './chunk-pump.ts';
import type { DataConnection, AnyProtocolMsg } from '../types/index.ts';
import { freezeFileDeliveryMode, resolvePeerFileDelivery } from '../share/file-delivery-policy.ts';

// ─── Send-side Module State ──────────────────────────────────────────

/** Per-peer unicast abort controls (key: peerId) */
const _activeUnicasts = new Map<string, SessionScope>();

/** Broadcast-level scope for cancellation */
let _broadcastScope: SessionScope | null = null;
let _broadcastGeneration = 0;

type PeerTransferKind = 'broadcast' | 'unicast';

interface PeerTransferOwner {
  readonly kind: PeerTransferKind;
  readonly conn: DataConnection;
  readonly queueItemId: string;
  readonly sessionId: number;
  readonly scope: SessionScope;
  status: 'active' | 'complete';
}

/**
 * Exact per-connection ownership for the active file lane.
 *
 * A late guest can become eligible while the debounced room broadcast is
 * starting. Without a shared lane, the broadcast and the peer bootstrap both
 * emit FILE_START/chunks for the same occurrence and reset the receiver in
 * the middle of its stream. Completed owners intentionally remain registered
 * until the occurrence, connection, or room is superseded so a later
 * bootstrap cannot replay the same bytes. Explicit recovery is allowed to
 * take the lane over.
 */
const _peerTransferOwners = new Map<string, PeerTransferOwner>();

function isExactPeerTransfer(
  owner: PeerTransferOwner,
  conn: DataConnection,
  queueItemId: string,
  sessionId: number,
): boolean {
  return owner.conn === conn && owner.queueItemId === queueItemId && owner.sessionId === sessionId;
}

function ownsPeerTransfer(peerId: string, owner: PeerTransferOwner): boolean {
  return _peerTransferOwners.get(peerId) === owner;
}

function disposeSupersededUnicast(peerId: string, owner: PeerTransferOwner): void {
  if (owner.kind !== 'unicast' || owner.status !== 'active') return;
  owner.scope.dispose();
  if (_activeUnicasts.get(peerId) === owner.scope) {
    _activeUnicasts.delete(peerId);
  }
}

function claimBroadcastPeer(
  conn: DataConnection,
  queueItemId: string,
  sessionId: number,
  scope: SessionScope,
): PeerTransferOwner | null {
  const peerId = conn.peer;
  const existing = _peerTransferOwners.get(peerId);

  // First owner wins for the exact stream. This covers both an active
  // bootstrap and one that completed during the 300 ms broadcast debounce.
  if (existing && isExactPeerTransfer(existing, conn, queueItemId, sessionId)) return null;

  if (existing) disposeSupersededUnicast(peerId, existing);
  const owner: PeerTransferOwner = {
    kind: 'broadcast',
    conn,
    queueItemId,
    sessionId,
    scope,
    status: 'active',
  };
  _peerTransferOwners.set(peerId, owner);
  return owner;
}

function releasePeerTransfer(peerId: string, owner: PeerTransferOwner): void {
  if (ownsPeerTransfer(peerId, owner)) _peerTransferOwners.delete(peerId);
}

const BROADCAST_BACKPRESSURE_LIMIT = 512 * 1024;
const BROADCAST_BACKPRESSURE_TIMEOUT = 5_000;
const UNICAST_BACKPRESSURE_LIMIT = 256 * 1024;
const UNICAST_BACKPRESSURE_TIMEOUT = 30_000;

// ─── Broadcast Debounce ──────────────────────────────────────────────

const BROADCAST_DEBOUNCE_KEY = 'broadcast-debounce';
const BROADCAST_DEBOUNCE_MS = 300;
let _pendingBroadcast: {
  file: File;
  queueItemId: string;
  sessionId: number | null;
  prepareMsg?: AnyProtocolMsg;
} | null = null;

interface PendingBroadcastSuspension {
  readonly id: number;
}

let _nextPendingBroadcastSuspensionId = 0;
let _activePendingBroadcastSuspension: PendingBroadcastSuspension | null = null;

function armPendingBroadcastTimer(): void {
  setManagedTimer(
    BROADCAST_DEBOUNCE_KEY,
    () => {
      if (!_pendingBroadcast) return;
      const p = _pendingBroadcast;
      _pendingBroadcast = null;
      // Send FILE_PREPARE first so guests update their metadata before the
      // chunk stream lands. Both happen in the same microtask after the
      // debounce, so guests see exactly one announce + one transfer per
      // settled track.
      if (p.prepareMsg) {
        sendFilePrepareByDelivery(p.prepareMsg, p.sessionId, { suppressOwnedDirect: true });
      }
      broadcastFile(p.file, p.queueItemId, p.sessionId).catch((e) =>
        log.error('[Host] broadcastFile (debounced) failed:', e),
      );
    },
    BROADCAST_DEBOUNCE_MS,
  );
}

/**
 * Coalesce rapid track selections so only the latest settled file and its
 * optional FILE_PREPARE announcement enter the ordered data channel. The
 * name-keyed timer and `_pendingBroadcast` must always describe the same call.
 */
export function broadcastFileDebounced(
  file: File,
  queueItemId: string,
  sessionId: number | null,
  prepareMsg?: AnyProtocolMsg,
): void {
  if (!queueItemId) return;
  if (sessionId !== null) freezeFileDeliveryMode(sessionId);
  _pendingBroadcast = { file, queueItemId, sessionId, prepareMsg };
  if (_activePendingBroadcastSuspension) {
    clearManagedTimer(BROADCAST_DEBOUNCE_KEY);
    return;
  }
  armPendingBroadcastTimer();
}

/**
 * Park the current debounce and any successor scheduled while an async media
 * transition is unresolved. A newer suspension supersedes the older token,
 * so a stale continuation cannot resume or discard its successor's payload.
 */
export function beginPendingBroadcastSuspension(): PendingBroadcastSuspension {
  const suspension = Object.freeze({ id: ++_nextPendingBroadcastSuspensionId });
  _activePendingBroadcastSuspension = suspension;
  clearManagedTimer(BROADCAST_DEBOUNCE_KEY);
  return suspension;
}

/** Resume only the latest still-current payload after a rejected transition. */
export function resumePendingBroadcastSuspension(suspension: PendingBroadcastSuspension): void {
  if (_activePendingBroadcastSuspension !== suspension) return;
  _activePendingBroadcastSuspension = null;
  if (!_pendingBroadcast) return;

  const { file, queueItemId } = _pendingBroadcast;
  if (
    getState('playlist.currentQueueItemId') !== queueItemId ||
    getState('files.current')?.blob !== file
  ) {
    _pendingBroadcast = null;
    return;
  }
  armPendingBroadcastTimer();
}

/** Discard the parked payload after the replacement media teardown commits. */
export function discardPendingBroadcastSuspension(suspension: PendingBroadcastSuspension): void {
  if (_activePendingBroadcastSuspension !== suspension) return;
  _activePendingBroadcastSuspension = null;
  cancelPendingBroadcast();
}

/**
 * FILE_PREPARE is control-plane metadata, but it also tells a local guest
 * whether bytes will follow on the data channel. Send a per-target copy so
 * only R2-routed peers enter the remote wait path.
 */
export function sendFilePrepareByDelivery(
  prepareMsg: AnyProtocolMsg,
  sessionId: number | null,
  options: { r2Only?: boolean; suppressOwnedDirect?: boolean } = {},
): void {
  if (sessionId === null || !Number.isSafeInteger(sessionId) || sessionId <= 0) return;
  freezeFileDeliveryMode(sessionId);
  const queueItemId =
    'queueItemId' in prepareMsg && typeof prepareMsg.queueItemId === 'string'
      ? prepareMsg.queueItemId
      : null;
  const peers = getState('network.connectedPeers') || [];
  for (const peer of peers) {
    const conn = peer.conn as DataConnection | null;
    if (peer.status !== 'connected' || !conn?.open) continue;
    const delivery = resolvePeerFileDelivery(peer, sessionId);
    if (delivery === 'pending') continue;
    if (delivery === 'unsupported') {
      sendFileDeliveryUnavailable(conn, prepareMsg, sessionId);
      continue;
    }
    const useR2 = delivery === 'r2';
    if (options.r2Only && !useR2) continue;
    if (options.suppressOwnedDirect && !useR2 && queueItemId) {
      const owner = _peerTransferOwners.get(peer.id);
      if (owner && isExactPeerTransfer(owner, conn, queueItemId, sessionId)) continue;
    }
    const outbound = useR2 ? { ...prepareMsg, delivery: 'r2' as const } : prepareMsg;
    safeSend(conn, outbound);
  }
}

/**
 * An unadvertised LAN peer beyond the eight direct slots cannot understand local R2
 * delivery. Fail explicitly instead of sending FILE_PREPARE and leaving it
 * waiting forever for chunks which must never be fanned out directly.
 */
export function sendFileDeliveryUnavailable(
  conn: DataConnection,
  source: AnyProtocolMsg | Record<string, unknown>,
  sessionId: number,
): void {
  const data = source as Record<string, unknown>;
  const name = typeof data.name === 'string' ? data.name : '';
  const queueItemId = typeof data.queueItemId === 'string' ? data.queueItemId : '';
  if (!conn.open || !name || !queueItemId || !Number.isSafeInteger(sessionId) || sessionId <= 0) {
    return;
  }
  safeSend(conn, {
    type: MSG.REMOTE_FILE_UNAVAILABLE,
    name,
    queueItemId,
    sessionId,
    delivery: 'r2',
  } as AnyProtocolMsg);
}

/**
 * Drop a queued broadcast before it starts. Clear both the payload and timer
 * so teardown cannot resurrect a superseded file transfer.
 */
export function cancelPendingBroadcast(): void {
  _pendingBroadcast = null;
  clearManagedTimer(BROADCAST_DEBOUNCE_KEY);
}

// ─── broadcastFile ───────────────────────────────────────────────────

/**
 * Broadcast a file to all connected peers (host-only).
 */
export async function broadcastFile(
  file: File,
  queueItemId: string,
  explicitSessionId: number | null = null,
): Promise<void> {
  if (!queueItemId) return;
  let sessionId: number;
  const currentTransferSessionId = getState('transfer.currentSessionId');

  if (explicitSessionId !== null) {
    sessionId = explicitSessionId;
    if (sessionId > currentTransferSessionId) setState('transfer.currentSessionId', sessionId);
  } else {
    sessionId = currentTransferSessionId + 1;
    setState('transfer.currentSessionId', sessionId);
  }
  freezeFileDeliveryMode(sessionId);

  const activeBroadcast = getState('transfer.activeBroadcastSession');
  if (activeBroadcast === sessionId) return;

  if (
    getState('playlist.currentQueueItemId') !== queueItemId ||
    getState('files.current')?.blob !== file
  ) {
    log.debug('[Host] Broadcast source was superseded before start');
    return;
  }

  const generation = ++_broadcastGeneration;
  // Cancel previous broadcast and yield so its loop can exit cleanly
  // before we send the new FILE_START header (prevents chunk interleaving)
  if (activeBroadcast) {
    setState('transfer.activeBroadcastSession', null);
    await delay(0);
  }
  // Cancellation or a successor can run while the predecessor is yielding.
  // Recheck before installing a scope or announcing any bytes to receivers.
  if (
    generation !== _broadcastGeneration ||
    getState('playlist.currentQueueItemId') !== queueItemId ||
    getState('files.current')?.blob !== file
  )
    return;
  setState('transfer.activeBroadcastSession', sessionId);

  _broadcastScope = SessionScope.replace(_broadcastScope);
  const scope = _broadcastScope;
  const ownedPeers = new Map<string, PeerTransferOwner>();

  try {
    const CHUNK = CHUNK_SIZE;
    const total = Math.ceil(file.size / CHUNK);
    const header = {
      type: MSG.FILE_START,
      name: file.name,
      mime: file.type,
      total,
      size: file.size,
      queueItemId,
      sessionId,
    };

    const eligiblePeers = filterEligiblePeers(sessionId).filter(isBulkTransferWritablePeer);

    // The ownership-conditional finally block clears this session.
    if (eligiblePeers.length === 0) return;

    for (const peer of eligiblePeers) {
      const conn = peer.conn as DataConnection | null;
      if (!conn) continue;
      const owner = claimBroadcastPeer(conn, queueItemId, sessionId, scope);
      if (owner) ownedPeers.set(peer.id, owner);
    }
    const broadcastPeers = eligiblePeers.filter((peer) => ownedPeers.has(peer.id));

    // Every eligible peer is already being served (or was served) by the
    // exact same lane. Do not emit a second FILE_START after the debounce.
    if (broadcastPeers.length === 0) return;

    // Send header (raw conn.send + try/catch, deliberately NOT safeSend —
    // pinned by transfer.test.ts whose stale-conn mock hooks FILE_START).
    broadcastPeers.forEach((p) => {
      try {
        (p.conn as DataConnection).send(header);
      } catch {
        /* noop */
      }
    });

    // A peer excluded for backpressure receives no later chunks from this
    // stream; recovery handles its missing suffix.
    await pumpChunksToPeers({
      file,
      chunkSize: CHUNK,
      peers: broadcastPeers,
      buildChunkMsg: (chunk, i) => ({
        type: MSG.FILE_CHUNK,
        chunk,
        chunkIndex: i,
        queueItemId,
        sessionId,
        total,
        name: file.name,
        size: file.size,
        mime: file.type,
      }),
      bufferedLimit: BROADCAST_BACKPRESSURE_LIMIT,
      stallTimeoutMs: BROADCAST_BACKPRESSURE_TIMEOUT,
      isWritable: (peer) => {
        const owner = ownedPeers.get(peer.id);
        return !!owner && ownsPeerTransfer(peer.id, owner) && isBulkTransferWritablePeer(peer);
      },
      // Stop on cancel (scope abort) or when another broadcast superseded
      // this one (activeBroadcastSession re-pointed).
      shouldContinue: () =>
        !scope.aborted &&
        getState('transfer.activeBroadcastSession') === sessionId &&
        getState('playlist.currentQueueItemId') === queueItemId &&
        getState('files.current')?.blob === file,
      onPeerExcluded: (peer) => {
        const owner = ownedPeers.get(peer.id);
        if (owner) releasePeerTransfer(peer.id, owner);
      },
      // The pump rechecks source and connection ownership before completion.
      // Finish this receiver immediately; another peer's wait must not delay
      // its completion frame. Retain the completed owner as the exact-bootstrap fence.
      onPeerComplete: (peer) => {
        const owner = ownedPeers.get(peer.id);
        if (!owner || !ownsPeerTransfer(peer.id, owner)) return;
        try {
          owner.conn.send({
            type: MSG.FILE_END,
            name: file.name,
            mime: file.type,
            queueItemId,
            sessionId,
          });
          owner.status = 'complete';
        } catch {
          /* noop */
        }
      },
    });
  } finally {
    // Owners which did not reach FILE_END must not block an explicit retry.
    // Completed owners stay as a fence against a delayed duplicate bootstrap.
    for (const [peerId, owner] of ownedPeers) {
      if (owner.status === 'active') releasePeerTransfer(peerId, owner);
    }
    // A superseded loop may finish after its successor has claimed the state.
    // Clear only the session this invocation still owns.
    if (_broadcastScope === scope) {
      if (getState('transfer.activeBroadcastSession') === sessionId) {
        setState('transfer.activeBroadcastSession', null);
      }
      _broadcastScope = null;
    }
    scope.dispose();
  }
}

// ─── unicastFile ─────────────────────────────────────────────────────

/**
 * Unicast a file to a single connection (for late-join/recovery).
 */
interface UnicastFileOptions {
  readonly queueItemId: string;
  readonly skipTransportGuard?: boolean;
  readonly isSourceCurrent?: () => boolean;
  /** Bootstrap joins an existing exact lane; recovery explicitly replaces it. */
  readonly purpose?: 'bootstrap' | 'recovery';
}

export async function unicastFile(
  conn: DataConnection,
  file: File | Blob,
  startChunkIndex = 0,
  sessionId: number | null = null,
  options: UnicastFileOptions,
): Promise<void> {
  if (!conn || !conn.open) {
    log.error('[Unicast] Connection is not open');
    return;
  }

  // Freeze all control-plane identity before the transport classification
  // await below. Otherwise a track/session switch during ICE evaluation could
  // label the already-selected Blob with the successor's identity.
  const effectiveSessionId = sessionId ?? getState('transfer.currentSessionId');
  const queueItemId = options.queueItemId;
  if (!queueItemId || !Number.isSafeInteger(effectiveSessionId) || effectiveSessionId <= 0) return;
  const unicastKey = conn.peer;
  const isTransferStillCurrent = (): boolean =>
    !!queueItemId &&
    getState('playlist.currentQueueItemId') === queueItemId &&
    (options.isSourceCurrent?.() ?? true);

  // Transport guard: require this connection's frozen direct assignment.
  // Internal recovery callers can opt out after validating the same policy.
  if (!options.skipTransportGuard && !(await canSendFileTo(conn, effectiveSessionId))) {
    log.info('[Unicast] Skipped: connection has no frozen direct assignment');
    return;
  }

  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(file.size / CHUNK);

  // canSendFileTo may await ICE classification. Revalidate the selected peer
  // connection, stable queue occurrence, and exact source Blob before emitting
  // the header.
  if (!isPeerConnectionCurrent(unicastKey, conn) || !isTransferStillCurrent()) {
    log.info('[Unicast] Selected source was superseded before transfer start');
    return;
  }

  const purpose = options.purpose ?? 'recovery';
  const existingOwner = _peerTransferOwners.get(unicastKey);
  if (
    purpose === 'bootstrap' &&
    existingOwner &&
    isExactPeerTransfer(existingOwner, conn, queueItemId, effectiveSessionId)
  ) {
    log.debug('[Unicast] Exact peer transfer is already owned; bootstrap joined existing lane');
    return;
  }

  // Recovery is authoritative for this peer. Replacing a broadcast owner
  // makes its per-peer writability gate exclude this connection without
  // aborting healthy recipients of the same room broadcast.
  if (existingOwner) disposeSupersededUnicast(unicastKey, existingOwner);

  // Cancel any previous unicast to same peer.
  const prevScope = _activeUnicasts.get(unicastKey) ?? null;
  const scope = SessionScope.replace(prevScope);
  _activeUnicasts.set(unicastKey, scope);
  const owner: PeerTransferOwner = {
    kind: 'unicast',
    conn,
    queueItemId,
    sessionId: effectiveSessionId,
    scope,
    status: 'active',
  };
  _peerTransferOwners.set(unicastKey, owner);
  const canContinue = (): boolean =>
    !scope.aborted &&
    ownsPeerTransfer(unicastKey, owner) &&
    conn.open &&
    isPeerConnectionCurrent(unicastKey, conn) &&
    isTransferStillCurrent();

  const isResume = startChunkIndex > 0;
  const msgType = isResume ? MSG.FILE_RESUME : MSG.FILE_START;
  const fileName = 'name' in file ? file.name : 'Track';

  try {
    conn.send({
      type: msgType,
      name: fileName,
      mime: file.type,
      total,
      size: file.size,
      startChunk: startChunkIndex,
      sessionId: effectiveSessionId,
      queueItemId,
    });
  } catch (e) {
    log.error(`[Unicast] Failed to send ${msgType}:`, e);
    // The initial send failed *before* the chunk loop's try/finally below, so
    // its cleanup never runs. Dispose the scope we registered above to avoid a
    // stale _activeUnicasts entry (and an undisposed SessionScope) lingering
    // until the next unicast to this peer replaces it.
    if (_activeUnicasts.get(unicastKey) === scope) {
      scope.dispose();
      _activeUnicasts.delete(unicastKey);
    }
    releasePeerTransfer(unicastKey, owner);
    return;
  }

  await delay(100);

  try {
    for (let i = startChunkIndex; i < total; i++) {
      // Abort if: peer-level cancel, connection closed, or track changed
      if (!canContinue()) return;

      // Backpressure (return on timeout — connection is likely dead)
      const startWait = Date.now();
      while (conn.dataChannel && conn.dataChannel.bufferedAmount > UNICAST_BACKPRESSURE_LIMIT) {
        if (!canContinue()) return;
        if (Date.now() - startWait > UNICAST_BACKPRESSURE_TIMEOUT) {
          log.warn('[Unicast] Backpressure timeout');
          return;
        }
        await delay(DELAY.BACKPRESSURE);
      }
      if (!canContinue()) return;

      const start = i * CHUNK;
      const end = Math.min(start + CHUNK, file.size);
      const chunkBuf = await file.slice(start, end).arrayBuffer();
      if (!canContinue()) return;
      const chunk = new Uint8Array(chunkBuf);

      conn.send({
        type: MSG.FILE_CHUNK,
        chunk,
        chunkIndex: i,
        queueItemId,
        sessionId: effectiveSessionId,
        total,
        name: fileName,
        size: file.size,
        mime: file.type,
      });

      if (i % 50 === 0) await delay(DELAY.TICK);
    }

    if (canContinue()) {
      conn.send({
        type: MSG.FILE_END,
        name: fileName,
        mime: file.type,
        queueItemId,
        sessionId: effectiveSessionId,
      });
      owner.status = 'complete';
      log.debug('[Unicast] Transfer complete:', fileName);
    }
  } catch (e) {
    log.error('[Unicast] Transfer error:', e);
  } finally {
    // Clean up abort control if still ours
    if (_activeUnicasts.get(unicastKey) === scope) {
      scope.dispose();
      _activeUnicasts.delete(unicastKey);
    }
    if (owner.status === 'active') releasePeerTransfer(unicastKey, owner);
  }
}

// ─── Cancel All Outgoing Transfers ───────────────────────────────────

/**
 * Cancel any in-flight outgoing file transfers (host-only).
 * Used when the host empties the playlist so guests stop receiving a
 * file that's no longer needed. Both broadcastFile loops (via
 * _broadcastScope) and unicastFile loops (via _activeUnicasts) check
 * their scope each iteration and exit on the next tick.
 */
export function cancelOutgoingFileTransferForPeer(peerId: string): void {
  const scope = _activeUnicasts.get(peerId);
  if (scope) {
    scope.dispose();
    _activeUnicasts.delete(peerId);
  }
  _peerTransferOwners.delete(peerId);
}

export function cancelOutgoingFileTransfers(): void {
  _broadcastGeneration++;
  // A broadcast still parked in the debounce window is an outgoing transfer
  // too — drop it first so it can't fire after this teardown and resurrect
  // a chunk stream for a file the caller just discarded.
  _activePendingBroadcastSuspension = null;
  cancelPendingBroadcast();

  if (_broadcastScope) {
    _broadcastScope.dispose();
    _broadcastScope = null;
  }
  setState('transfer.activeBroadcastSession', null);

  for (const scope of _activeUnicasts.values()) {
    scope.dispose();
  }
  _activeUnicasts.clear();
  _peerTransferOwners.clear();
}
