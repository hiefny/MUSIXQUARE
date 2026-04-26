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
import type { DataConnection, AnyProtocolMsg } from '../types/index.ts';

// ─── Send-side Module State ──────────────────────────────────────────

/** Per-peer unicast abort controls (key: peerId) */
const _activeUnicasts = new Map<string, SessionScope>();

/** Broadcast-level scope for cancellation */
let _broadcastScope: SessionScope | null = null;

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

  const eligiblePeers = filterEligiblePeers();

  // 12-13: Clean up activeBroadcastSession on early return to avoid resource leak
  if (eligiblePeers.length === 0) {
    setState('transfer.activeBroadcastSession', null);
    scope.dispose();
    return;
  }

  // Send header
  eligiblePeers.forEach((p) => {
    try {
      (p.conn as DataConnection).send(header);
    } catch {
      /* noop */
    }
  });

  // Track peers that hit backpressure timeout — skip them for ALL remaining chunks
  // to avoid creating permanent chunk holes that force a full recovery re-transfer.
  const timedOutPeers = new Set<string>();

  // Send chunks
  for (let i = 0; i < total; i++) {
    if (scope.aborted) {
      setState('transfer.activeBroadcastSession', null);
      scope.dispose();
      return;
    }
    if (getState('transfer.activeBroadcastSession') !== sessionId) {
      // Another broadcast superseded this one — scope/session already reassigned
      scope.dispose();
      return;
    }

    const start = i * CHUNK;
    const end = Math.min(start + CHUNK, file.size);
    const chunkBuf = await file.slice(start, end).arrayBuffer();
    const chunk = new Uint8Array(chunkBuf);
    const chunkMsg = { type: MSG.FILE_CHUNK, chunk, index: i, sessionId, total, name: file.name };

    // Send to all peers concurrently (backpressure is per-peer, not sequential)
    await Promise.all(
      eligiblePeers.map(async (p) => {
        if (timedOutPeers.has(p.id)) return;
        const conn = p.conn as DataConnection;
        if (!conn?.open) return;
        const BACKPRESSURE_TIMEOUT = 30_000;
        const backpressureStart = Date.now();
        while (conn.dataChannel && conn.dataChannel.bufferedAmount > 512 * 1024) {
          if (Date.now() - backpressureStart > BACKPRESSURE_TIMEOUT) {
            log.warn(
              `[Transfer] Backpressure timeout for peer ${p.label || p.id} — excluding from remaining transfer`,
            );
            timedOutPeers.add(p.id);
            return;
          }
          await delay(DELAY.BACKPRESSURE);
          if (!conn.open) return;
        }
        try {
          conn.send(chunkMsg);
        } catch {
          /* noop */
        }
      }),
    );

    if (i % 50 === 0) await delay(DELAY.TICK);
  }

  // Send end message (skip if superseded or aborted after loop)
  if (!scope.aborted && getState('transfer.activeBroadcastSession') === sessionId) {
    const endMsg = { type: MSG.FILE_END, name: file.name, mime: file.type, sessionId };
    eligiblePeers.forEach((p) => {
      if (timedOutPeers.has(p.id)) return;
      const conn = p.conn as DataConnection;
      if (conn?.open)
        try {
          conn.send(endMsg);
        } catch {
          /* noop */
        }
    });
  }

  setState('transfer.activeBroadcastSession', null);
  scope.dispose();
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

  // Transport guard: block remote/unknown peers
  // skipTransportGuard=true for relay→downstream (conn is in relay.downstreamDataPeers, not connectedPeers)
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
    return;
  }

  await delay(100);

  try {
    for (let i = startChunkIndex; i < total; i++) {
      // Abort if: peer-level cancel, connection closed, or track changed
      if (scope.aborted || !conn.open) return;
      if (getState('playlist.currentTrackIndex') !== currentTrackIndex) return;

      // Backpressure (return on timeout — connection is likely dead)
      const startWait = Date.now();
      while (conn.dataChannel && conn.dataChannel.bufferedAmount > 64 * 1024) {
        if (Date.now() - startWait > 30000) {
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
