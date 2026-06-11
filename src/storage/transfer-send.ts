/**
 * MUSIXQUARE — File Transfer: Send Side
 *
 * broadcastFile (host → all peers) and unicastFile (host → single peer).
 */

import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, DELAY } from '../core/constants.ts';
import { delay, setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { filterEligiblePeers, canSendFileTo, broadcast } from '../network/peer.ts';
import { SessionScope } from '../core/session-scope.ts';
import {
  pumpChunksToPeers,
  isPeerConnectionCurrent,
  isBulkTransferWritablePeer,
} from './chunk-pump.ts';
import type { DataConnection, AnyProtocolMsg } from '../types/index.ts';

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
  sessionId: number | null;
  prepareMsg?: AnyProtocolMsg;
} | null = null;

/**
 * Debounced wrapper around broadcastFile. Coalesces rapid consecutive calls
 * (e.g. user clicking next-next-next within ~300ms) so only the last stable
 * track actually starts a chunk broadcast. Prevents the dataChannel buffer
 * from accumulating chunks from superseded broadcasts — a stuck buffer is
 * what surfaces on the receiver as reorder-buffer overflow, decode failures,
 * and infinite recovery loops, since WebRTC reliable+ordered keeps the
 * stale chunks in the queue ahead of the new track's FILE_START.
 *
 * The optional prepareMsg parameter coalesces the FILE_PREPARE announcement
 * with the chunk broadcast so guests don't get a flood of metadata updates
 * for tracks the user already left. Without this, the receiver pipeline
 * would reset on every prepareMsg, race against PLAY messages still in
 * flight, and surface as "Name mismatch on PLAY" with the guest stuck
 * waiting for a FILE_PREPARE that already arrived as a stale earlier one.
 *
 * setManagedTimer is name-keyed: a second call within the window cancels the
 * previous pending fire and replaces _pendingBroadcast with the new file,
 * so the queued broadcast always reflects the latest user intent.
 */
export function broadcastFileDebounced(
  file: File,
  sessionId: number | null,
  prepareMsg?: AnyProtocolMsg,
): void {
  _pendingBroadcast = { file, sessionId, prepareMsg };
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
        broadcast(p.prepareMsg);
      }
      broadcastFile(p.file, p.sessionId).catch((e) =>
        log.error('[Host] broadcastFile (debounced) failed:', e),
      );
    },
    BROADCAST_DEBOUNCE_MS,
  );
}

/** Drop any pending debounced broadcast (e.g. on session leave / cancel). */
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
  explicitSessionId: number | null = null,
): Promise<void> {
  let sessionId: number;
  const currentTransferSessionId = getState('transfer.currentSessionId');

  if (explicitSessionId !== null) {
    sessionId = explicitSessionId;
    if (sessionId > currentTransferSessionId) setState('transfer.currentSessionId', sessionId);
  } else {
    sessionId = currentTransferSessionId + 1;
    setState('transfer.currentSessionId', sessionId);
  }

  const activeBroadcast = getState('transfer.activeBroadcastSession');
  if (activeBroadcast === sessionId) return;

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
    const currentTrackIndex = getState('playlist.currentTrackIndex');
    const header = {
      type: MSG.FILE_START,
      name: file.name,
      mime: file.type,
      total,
      size: file.size,
      index: currentTrackIndex,
      sessionId,
    };

    const eligiblePeers = filterEligiblePeers().filter(isBulkTransferWritablePeer);

    // 12-13: no eligible peers — the ownership-conditional finally below
    // clears activeBroadcastSession (the old early return cleared it inline).
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

    // Per-peer backpressure + exclusion lives in the shared engine. Peers
    // that hit the backpressure timeout are skipped for ALL remaining chunks
    // to avoid creating permanent chunk holes that force a full recovery
    // re-transfer (36f8fbf2).
    const { excluded } = await pumpChunksToPeers({
      file,
      chunkSize: CHUNK,
      peers: eligiblePeers,
      buildChunkMsg: (chunk, i) => ({
        type: MSG.FILE_CHUNK,
        chunk,
        index: i,
        sessionId,
        total,
        name: file.name,
      }),
      bufferedLimit: BROADCAST_BACKPRESSURE_LIMIT,
      stallTimeoutMs: BROADCAST_BACKPRESSURE_TIMEOUT,
      isWritable: isBulkTransferWritablePeer,
      // Stop on cancel (scope abort) or when another broadcast superseded
      // this one (activeBroadcastSession re-pointed).
      shouldContinue: () =>
        !scope.aborted && getState('transfer.activeBroadcastSession') === sessionId,
    });

    // Send end message (skip if superseded or aborted after the pump;
    // excluded peers get no FILE_END — recovery re-requests serve them)
    if (!scope.aborted && getState('transfer.activeBroadcastSession') === sessionId) {
      const endMsg = { type: MSG.FILE_END, name: file.name, mime: file.type, sessionId };
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
    // OWNERSHIP-CONDITIONAL session clear — threat model: a successor
    // broadcastFile B aborts THIS loop via SessionScope.replace AFTER it has
    // already re-pointed transfer.activeBroadcastSession to its own
    // sessionId. The pre-refactor abort exit cleared the state
    // unconditionally, so a loop parked in a backpressure wait (or in
    // file.slice().arrayBuffer()) when B started would wake aborted and
    // stomp B's session — B then died at its own supersession check before
    // sending FILE_END. Clearing only when we still OWN the session
    // preserves the deliberate aborted-vs-superseded asymmetry
    // (cancelOutgoingFileTransfers nulls the state itself, so the old
    // abort-path clear was redundant-at-best) and eliminates the
    // successor-stomp class. Also covers the 12-13 early return above and
    // slice() throws (which previously leaked the session until the next
    // broadcast).
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
export async function unicastFile(
  conn: DataConnection,
  file: File | Blob,
  startChunkIndex = 0,
  sessionId: number | null = null,
  skipTransportGuard = false,
): Promise<void> {
  if (!conn || !conn.open) {
    log.error('[Unicast] Connection is not open');
    return;
  }

  // Transport guard: block remote/unknown peers.
  // Internal recovery callers can opt out when they already validated the connection.
  if (!skipTransportGuard && !(await canSendFileTo(conn))) {
    log.info('[Unicast] Skipped — remote/unknown peer');
    return;
  }

  const effectiveSessionId = sessionId ?? getState('transfer.currentSessionId');
  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(file.size / CHUNK);
  const currentTrackIndex = getState('playlist.currentTrackIndex');

  // Cancel any previous unicast to same peer
  const unicastKey = conn.peer;
  const prevScope = _activeUnicasts.get(unicastKey) ?? null;
  const scope = SessionScope.replace(prevScope);
  _activeUnicasts.set(unicastKey, scope);

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
      index: currentTrackIndex,
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
      if (scope.aborted || !conn.open) return;
      if (!isPeerConnectionCurrent(unicastKey, conn)) return;
      if (getState('playlist.currentTrackIndex') !== currentTrackIndex) return;

      // Backpressure (return on timeout — connection is likely dead)
      const startWait = Date.now();
      while (conn.dataChannel && conn.dataChannel.bufferedAmount > UNICAST_BACKPRESSURE_LIMIT) {
        if (!conn.open || !isPeerConnectionCurrent(unicastKey, conn)) return;
        if (Date.now() - startWait > UNICAST_BACKPRESSURE_TIMEOUT) {
          log.warn('[Unicast] Backpressure timeout');
          return;
        }
        await delay(DELAY.BACKPRESSURE);
      }

      const start = i * CHUNK;
      const end = Math.min(start + CHUNK, file.size);
      const chunkBuf = await file.slice(start, end).arrayBuffer();
      const chunk = new Uint8Array(chunkBuf);

      conn.send({
        type: MSG.FILE_CHUNK,
        chunk,
        index: i,
        sessionId: effectiveSessionId,
        total,
        name: fileName,
      });

      if (i % 50 === 0) await delay(DELAY.TICK);
    }

    if (conn.open) {
      conn.send({
        type: MSG.FILE_END,
        name: fileName,
        mime: file.type,
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
