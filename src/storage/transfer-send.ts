/**
 * MUSIXQUARE 3.0 — File Transfer: Send Side
 *
 * broadcastFile (host → all peers) and unicastFile (host → single peer).
 */

import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, DELAY } from '../core/constants.ts';
import { delay } from '../core/timers.ts';
import { filterEligiblePeers, canSendFileTo } from '../network/peer.ts';
import { SessionScope } from '../core/session-scope.ts';
import type { DataConnection } from '../types/index.ts';

// ─── Send-side Module State ──────────────────────────────────────────

/** Per-peer unicast abort controls (key: peerId) */
const _activeUnicasts = new Map<string, SessionScope>();

/** Broadcast-level scope for cancellation */
let _broadcastScope: SessionScope | null = null;

// ─── broadcastFile ───────────────────────────────────────────────────

/**
 * Broadcast a file to all connected peers (host-only).
 */
export async function broadcastFile(file: File, explicitSessionId: number | null = null): Promise<void> {
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
    return;
  }

  // Send header
  eligiblePeers.forEach(p => {
    try { (p.conn as DataConnection).send(header); } catch { /* noop */ }
  });

  // Send chunks
  for (let i = 0; i < total; i++) {
    if (scope.aborted) return;
    if (getState('transfer.activeBroadcastSession') !== sessionId) return;

    const start = i * CHUNK;
    const end = Math.min(start + CHUNK, file.size);
    const chunkBuf = await file.slice(start, end).arrayBuffer();
    const chunk = new Uint8Array(chunkBuf);
    const chunkMsg = { type: MSG.FILE_CHUNK, chunk, index: i, sessionId, total, name: file.name };

    // Send to all peers concurrently (backpressure is per-peer, not sequential)
    await Promise.all(eligiblePeers.map(async (p) => {
      const conn = p.conn as DataConnection;
      if (!conn?.open) return;
      // Backpressure check per peer (skip peer on timeout instead of aborting all)
      const BACKPRESSURE_TIMEOUT = 30_000;
      const backpressureStart = Date.now();
      while (conn.dataChannel && conn.dataChannel.bufferedAmount > 512 * 1024) {
        if (Date.now() - backpressureStart > BACKPRESSURE_TIMEOUT) {
          log.warn(`[Transfer] Backpressure timeout for peer ${p.label || p.id} — skipping`);
          return;
        }
        await delay(DELAY.BACKPRESSURE);
        if (!conn.open) return;
      }
      try { conn.send(chunkMsg); } catch { /* noop */ }
    }));

    if (i % 50 === 0) await delay(DELAY.TICK);
  }

  // Send end message
  const endMsg = { type: MSG.FILE_END, name: file.name, mime: file.type, sessionId };
  eligiblePeers.forEach(p => {
    const conn = p.conn as DataConnection;
    if (conn?.open) try { conn.send(endMsg); } catch { /* noop */ }
  });

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
  sessionId: number | null = null
): Promise<void> {
  if (!conn || !conn.open) {
    log.error('[Unicast] Connection is not open');
    return;
  }

  // Transport guard: block remote/unknown peers
  if (!(await canSendFileTo(conn))) {
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

      // Backpressure
      const startWait = Date.now();
      while (conn.dataChannel && conn.dataChannel.bufferedAmount > 64 * 1024) {
        if (Date.now() - startWait > 30000) break;
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
      conn.send({ type: MSG.FILE_END, name: fileName, mime: file.type, sessionId: effectiveSessionId });
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
