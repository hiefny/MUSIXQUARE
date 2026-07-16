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
        sendFilePrepareByDelivery(p.prepareMsg, p.sessionId);
      }
      broadcastFile(p.file, p.queueItemId, p.sessionId).catch((e) =>
        log.error('[Host] broadcastFile (debounced) failed:', e),
      );
    },
    BROADCAST_DEBOUNCE_MS,
  );
}

/**
 * FILE_PREPARE is control-plane metadata, but it also tells a local guest
 * whether bytes will follow on the data channel. Send a per-target copy so
 * only R2-routed peers enter the remote wait path.
 */
export function sendFilePrepareByDelivery(
  prepareMsg: AnyProtocolMsg,
  sessionId: number | null,
  options: { r2Only?: boolean } = {},
): void {
  if (sessionId === null || !Number.isSafeInteger(sessionId) || sessionId <= 0) return;
  freezeFileDeliveryMode(sessionId);
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
    safeSend(
      conn,
      useR2 ? ({ ...prepareMsg, delivery: 'r2' } as unknown as AnyProtocolMsg) : prepareMsg,
    );
  }
}

/**
 * A legacy LAN peer beyond the eight direct slots cannot understand local R2
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

  // Cancel previous broadcast and yield so its loop can exit cleanly
  // before we send the new FILE_START header (prevents chunk interleaving)
  if (activeBroadcast) {
    setState('transfer.activeBroadcastSession', null);
    await delay(0);
  }
  setState('transfer.activeBroadcastSession', sessionId);

  _broadcastScope = SessionScope.replace(_broadcastScope);
  const scope = _broadcastScope;

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

    // Send header (raw conn.send + try/catch, deliberately NOT safeSend —
    // pinned by transfer.test.ts whose stale-conn mock hooks FILE_START).
    eligiblePeers.forEach((p) => {
      try {
        (p.conn as DataConnection).send(header);
      } catch {
        /* noop */
      }
    });

    // A peer excluded for backpressure receives no later chunks from this
    // stream; recovery handles its missing suffix.
    const { excluded } = await pumpChunksToPeers({
      file,
      chunkSize: CHUNK,
      peers: eligiblePeers,
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
      isWritable: isBulkTransferWritablePeer,
      // Stop on cancel (scope abort) or when another broadcast superseded
      // this one (activeBroadcastSession re-pointed).
      shouldContinue: () =>
        !scope.aborted &&
        getState('transfer.activeBroadcastSession') === sessionId &&
        getState('playlist.currentQueueItemId') === queueItemId &&
        getState('files.current')?.blob === file,
    });

    // Send end message (skip if superseded or aborted after the pump;
    // excluded peers get no FILE_END — recovery re-requests serve them)
    if (
      !scope.aborted &&
      getState('transfer.activeBroadcastSession') === sessionId &&
      getState('playlist.currentQueueItemId') === queueItemId &&
      getState('files.current')?.blob === file
    ) {
      const endMsg = {
        type: MSG.FILE_END,
        name: file.name,
        mime: file.type,
        queueItemId,
        sessionId,
      };
      eligiblePeers.forEach((p) => {
        if (excluded.has(p.id)) return;
        const conn = p.conn as DataConnection;
        if (conn?.open)
          try {
            conn.send(endMsg);
          } catch {
            /* noop */
          }
      });
    }
  } finally {
    // A superseded loop may finish after its successor has claimed the state.
    // Clear only the session this invocation still owns.
    if (getState('transfer.activeBroadcastSession') === sessionId) {
      setState('transfer.activeBroadcastSession', null);
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
    log.info('[Unicast] Skipped — connection has no frozen direct assignment');
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

  // Cancel any previous unicast to same peer
  const prevScope = _activeUnicasts.get(unicastKey) ?? null;
  const scope = SessionScope.replace(prevScope);
  _activeUnicasts.set(unicastKey, scope);
  const canContinue = (): boolean =>
    !scope.aborted &&
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
  if (!scope) return;
  scope.dispose();
  _activeUnicasts.delete(peerId);
}

export function cancelOutgoingFileTransfers(): void {
  // A broadcast still parked in the debounce window is an outgoing transfer
  // too — drop it first so it can't fire after this teardown and resurrect
  // a chunk stream for a file the caller just discarded.
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
}
