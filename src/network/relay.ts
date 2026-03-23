/**
 * MUSIXQUARE 3.0 — Relay Chain Management
 *
 * Manages: Upstream relay connection, downstream data peers,
 * relay file serving, preload relay, OPFS catch-up streaming.
 *
 * Activated by orchestrator.ts which sends ASSIGN_DATA_SOURCE to remote peers,
 * directing them to connect to a local peer for data relay.
 *
 * TURN cost policy:
 *   Host never sends file data to remote peers directly (no TURN transfer).
 *   Instead, a local (LAN) peer acts as relay: Host→LAN→LocalRelay→Remote.
 *   The relay-to-remote link uses the relay peer's own PeerJS connection,
 *   which may traverse TURN but the cost is on the relay leg only.
 *   If no local relay is available, remote peers receive control messages
 *   only (play/pause/chat/YouTube) — no file data.
 *   TODO(pro): Pro tier could enable host-direct TURN file transfer.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, DELAY, TRANSFER_STATE } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { validateSessionId } from '../core/session.ts';
import type { DataConnection } from '../types/index.ts';
import { registerHandlers } from './protocol.ts';
import { getPeer, safeSend, sendToHost } from './peer.ts';
import { unicastFile } from '../storage/transfer.ts';
import { ensureNamedFile, postWorkerCommand } from '../storage/opfs.ts';
import { showToast } from '../ui/toast.ts';

// ─── Module State ───────────────────────────────────────────────────
const RELAY_CONN_TIMER = 'relayConnTimeout';

// ─── OPFS Catch-up Pump ──────────────────────────────────────────────

interface OpfsCatchupPump {
  peerId: string;
  conn: DataConnection;
  filename: string;
  sessionId: number;
  isPreload: boolean;
  nextIndex: number;
  endIndex: number;
  awaiting: boolean;
  awaitingIndex: number | null;
  lastActivity: number;
  active: boolean;
  retryCount: number;
}

const opfsCatchupPumps = new Map<string, OpfsCatchupPump>();

function stopOpfsCatchupStream(peerId: string, reason = ''): void {
  const pump = opfsCatchupPumps.get(peerId);
  if (!pump) return;
  pump.active = false;
  clearManagedTimer('opfs-catchup-' + peerId);
  opfsCatchupPumps.delete(peerId);
  if (reason) log.debug(`[OPFS Catchup] Stop ...${peerId.slice(-4)}: ${reason}`);
}

function startOpfsCatchupStream(
  conn: DataConnection,
  opts: {
    filename: string;
    sessionId: number;
    startIndex?: number;
    endIndexExclusive?: number;
    isPreload?: boolean;
  },
): void {
  if (!conn || !conn.peer) return;
  const peerId = conn.peer;

  stopOpfsCatchupStream(peerId, 'restart');

  const sid = validateSessionId(opts.sessionId);
  if (!sid) {
    log.warn(`[OPFS Catchup] Invalid sessionId, abort for peer ...${peerId.slice(-4)}`);
    return;
  }

  const pump: OpfsCatchupPump = {
    peerId,
    conn,
    filename: opts.filename,
    sessionId: sid,
    isPreload: !!opts.isPreload,
    nextIndex: Math.max(0, (opts.startIndex || 0) | 0),
    endIndex: Math.max(0, (opts.endIndexExclusive || 0) | 0),
    awaiting: false,
    awaitingIndex: null,
    lastActivity: Date.now(),
    active: true,
    retryCount: 0,
  };

  opfsCatchupPumps.set(peerId, pump);
  scheduleOpfsCatchupPump(pump, 0);
}

function scheduleOpfsCatchupPump(pump: OpfsCatchupPump, delayMs: number): void {
  if (!pump || !pump.active) return;
  const timerName = 'opfs-catchup-' + pump.peerId;
  setManagedTimer(timerName, () => runOpfsCatchupPump(pump), Math.max(0, delayMs | 0));
}

function runOpfsCatchupPump(pump: OpfsCatchupPump): void {
  // Verify pump from map to avoid running stale reference from timer closure
  const current = opfsCatchupPumps.get(pump.peerId);
  if (!pump || !pump.active || current !== pump) return;

  const conn = pump.conn;
  if (!conn || !conn.open) {
    stopOpfsCatchupStream(pump.peerId, 'peer closed');
    return;
  }

  // Session guard: stop if app advanced to newer session
  // Note: `<` comparison is safe — IDs are timestamp-based and MAX_SAFE_INTEGER won't wrap
  const localSid = getState('transfer.localSessionId');
  if (pump.sessionId && pump.sessionId < localSid) {
    stopOpfsCatchupStream(pump.peerId, 'session advanced');
    return;
  }

  if (!pump.filename || pump.nextIndex >= pump.endIndex) {
    stopOpfsCatchupStream(pump.peerId, 'complete');
    return;
  }

  // Wait for previous OPFS_READ response (sequential pump)
  if (pump.awaiting) {
    const stuckMs = Date.now() - pump.lastActivity;
    if (stuckMs > 6000 && pump.awaitingIndex !== null) {
      pump.retryCount++;
      const MAX_RETRIES = 5;
      if (pump.retryCount > MAX_RETRIES) {
        stopOpfsCatchupStream(pump.peerId, `max retries (${MAX_RETRIES}) exceeded`);
        return;
      }
      log.warn(`[OPFS Catchup] Stuck ${stuckMs}ms, retry ${pump.retryCount}/${MAX_RETRIES} idx=${pump.awaitingIndex} for ...${pump.peerId.slice(-4)}`);
      pump.awaiting = false;
      pump.nextIndex = pump.awaitingIndex; // rewind to retry
      pump.awaitingIndex = null;
    }
    scheduleOpfsCatchupPump(pump, DELAY.BACKPRESSURE);
    return;
  }

  // Back-pressure: don't read faster than RTC can send
  const bufAmt = conn.dataChannel ? conn.dataChannel.bufferedAmount : 0;

  if (bufAmt > 256 * 1024) {
    scheduleOpfsCatchupPump(pump, DELAY.BACKPRESSURE);
    return;
  }

  const idx = pump.nextIndex;
  pump.nextIndex++;
  pump.awaiting = true;
  pump.awaitingIndex = idx;
  pump.lastActivity = Date.now();

  postWorkerCommand({
    command: 'OPFS_READ',
    filename: pump.filename,
    index: idx,
    isPreload: pump.isPreload,
    sessionId: pump.sessionId,
    requestId: `${pump.peerId}|catchup`,
  });
}

function onOpfsCatchupReadComplete(peerId: string, sessionId: number, requestTag: string): void {
  const pump = opfsCatchupPumps.get(peerId);
  if (!pump || !pump.active) return;

  // Only advance pump when this response is from catchup-tag
  if (requestTag !== 'catchup') return;

  // Session guard
  if (sessionId && pump.sessionId && sessionId !== pump.sessionId) {
    stopOpfsCatchupStream(peerId, 'session mismatch');
    return;
  }

  pump.awaiting = false;
  pump.awaitingIndex = null;
  pump.lastActivity = Date.now();
  pump.retryCount = 0;
  scheduleOpfsCatchupPump(pump, 0);
}

// ─── Upstream Relay Connection ──────────────────────────────────────

/**
 * Connect to a relay peer (upstream data source).
 * This is called when the host assigns a data relay target.
 */
export function connectToRelay(targetId: string): void {
  const peer = getPeer();
  if (!peer) return;

  // Close existing relay connection
  const upstreamDataConn = getState('relay.upstreamDataConn');
  if (upstreamDataConn) {
    log.debug(`[Relay] Closing existing relay connection for new assignment`);
    upstreamDataConn.close();
    setState('relay.upstreamDataConn', null);
  }

  // Cancel previous relay connection timeout
  clearManagedTimer(RELAY_CONN_TIMER);

  const myId = getState('network.myId');
  const conn = peer.connect(targetId, {
    metadata: { type: MSG.DATA_RELAY, label: myId },
  });

  const FAIL_TIMEOUT = 15000;
  setManagedTimer(RELAY_CONN_TIMER, () => {
    if (!conn.open) {
      log.warn('[Relay] Connect Timeout');
      showToast(t('network.relay_timeout'));
      conn.close();
      setState('relay.upstreamDataConn', null);

      // Fallback: request recovery from host (skip if transfer already completed/idle)
      const transferState = getState('transfer.state');
      if (transferState === TRANSFER_STATE.IDLE) {
        log.debug('[Relay] Transfer idle during timeout — no recovery needed');
        return;
      }

      const meta = getState('transfer.meta');
      const receivedCount = getState('transfer.receivedCount');
      const currentTrackIndex = getState('playlist.currentTrackIndex');

      if (currentTrackIndex < 0 || !meta?.name) {
        log.warn('[Relay] Cannot request recovery: no active transfer — requesting current file');
        sendToHost({ type: MSG.REQUEST_CURRENT_FILE });
      } else {
        sendToHost({
          type: MSG.REQUEST_DATA_RECOVERY,
          nextChunk: receivedCount || 0,
          fileName: meta.name,
          index: currentTrackIndex,
          sessionId: getState('transfer.currentSessionId') || getState('transfer.localSessionId') || 0,
        });
      }
    }
  }, FAIL_TIMEOUT);

  // Register data handler before open to avoid missing early messages
  conn.on('data', (data: unknown) => {
    bus.emit('network:data', data, conn);
  });

  conn.on('open', () => {
    clearManagedTimer(RELAY_CONN_TIMER);
    setState('relay.upstreamDataConn', conn);
    log.info('[Relay] Connected to upstream relay');
    showToast(t('network.relay_connected'));

    // Request current file from relay
    safeSend(conn, { type: MSG.REQUEST_CURRENT_FILE });
  });

  conn.on('error', (err: unknown) => {
    log.warn('[Relay] Connection error:', err);
    clearManagedTimer(RELAY_CONN_TIMER);
    try { conn.close(); } catch { /* noop */ }
    const currentUpstream = getState('relay.upstreamDataConn');
    if (currentUpstream === conn) {
      setState('relay.upstreamDataConn', null);
    }
  });

  conn.on('close', () => {
    const currentUpstream = getState('relay.upstreamDataConn');
    // Skip if upstream was already cleaned up (e.g. by timeout handler) or replaced
    if (currentUpstream !== conn) return;

    setState('relay.upstreamDataConn', null);
    showToast(t('network.relay_disconnected'));

    const transferState = getState('transfer.state');
    if (transferState !== TRANSFER_STATE.RECEIVING) return;

    const meta = getState('transfer.meta');
    const receivedCount = getState('transfer.receivedCount');
    const total = (meta?.total as number) || 0;

    if (receivedCount < total) {
      const hostConn = getState('network.hostConn');
      if (hostConn && hostConn.open) {
        bus.emit('storage:request-recovery');
      }
    }
  });
}

// ─── Downstream Relay (Serving) ─────────────────────────────────────

/**
 * Handle an incoming relay connection (downstream peer connecting to us).
 */
const MAX_DOWNSTREAM_PEERS = 8;

export function handleRelayConnection(conn: DataConnection): void {
  conn.on('open', () => {
    log.debug('[Relay] Accepted downstream connection from', conn.peer);

    const downstreamDataPeers = getState('relay.downstreamDataPeers');

    // Enforce downstream peer limit to prevent resource exhaustion
    const currentCount = downstreamDataPeers.filter(p => p.peer !== conn.peer).length;
    if (currentCount >= MAX_DOWNSTREAM_PEERS) {
      log.warn(`[Relay] Downstream peer limit (${MAX_DOWNSTREAM_PEERS}) reached — rejecting ${conn.peer}`);
      try { conn.close(); } catch { /* noop */ }
      return;
    }
    // Duplicate check: remove stale connection for same peer before adding new one
    const existingIdx = downstreamDataPeers.findIndex(p => p.peer === conn.peer);
    if (existingIdx !== -1) {
      const stale = downstreamDataPeers[existingIdx];
      try { stale.close(); } catch { /* noop */ }
      const updated = downstreamDataPeers.filter(p => p.peer !== conn.peer);
      updated.push(conn);
      setState('relay.downstreamDataPeers', updated);
    } else {
      setState('relay.downstreamDataPeers', [...downstreamDataPeers, conn]);
    }
  });

  conn.on('data', (data: unknown) => {
    const msg = data as Record<string, unknown>;

    if (msg.type === MSG.REQUEST_CURRENT_FILE) {
      bus.emit('relay:serve-current-file', conn, msg);
    } else if (msg.type === MSG.REQUEST_DATA_RECOVERY) {
      bus.emit('relay:serve-recovery', conn, msg);
    } else {
      // Route all other messages through the protocol dispatcher
      // (e.g. operator request-* messages from downstream peers).
      // RELAY_LOCAL_REQUESTS in protocol.ts prevents double-handling.
      bus.emit('network:data', data, conn);
    }
  });

  conn.on('error', (err: unknown) => {
    log.warn(`[Relay] Downstream connection error (${conn.peer}):`, err);
    // Only stop pump if it belongs to THIS connection (not a reconnected one)
    const pump = opfsCatchupPumps.get(conn.peer);
    if (pump && pump.conn === conn) {
      stopOpfsCatchupStream(conn.peer, 'downstream error');
    }
    const downstreamDataPeers = getState('relay.downstreamDataPeers');
    const wasTracked = downstreamDataPeers.some(p => p === conn);
    setState(
      'relay.downstreamDataPeers',
      downstreamDataPeers.filter(p => p !== conn)
    );
    // Notify host so relay assignment is cleared (close handler skips if already removed)
    if (wasTracked) {
      sendToHost({ type: MSG.RELAY_DOWNSTREAM_LOST, lostPeerId: conn.peer });
    }
    try { conn.close(); } catch { /* noop */ }
  });

  conn.on('close', () => {
    log.info(`[Relay] Downstream peer disconnected: ${conn.peer}`);
    const pump = opfsCatchupPumps.get(conn.peer);
    if (pump && pump.conn === conn) {
      stopOpfsCatchupStream(conn.peer, 'downstream disconnected');
    }
    const downstreamDataPeers = getState('relay.downstreamDataPeers');
    // Use reference equality to avoid removing a new connection from the same peer
    const wasTracked = downstreamDataPeers.some(p => p === conn);
    setState(
      'relay.downstreamDataPeers',
      downstreamDataPeers.filter(p => p !== conn)
    );
    // Only notify host if THIS connection was still tracked — prevents double-fire when
    // error handler already removed it and close fires afterwards.
    if (wasTracked) {
      sendToHost({ type: MSG.RELAY_DOWNSTREAM_LOST, lostPeerId: conn.peer });
    }
  });
}

// ─── Protocol Handlers ──────────────────────────────────────────────

function handleAssignDataSource(data: Record<string, unknown>): void {
  const targetId = (data.targetId as string | null | undefined) ?? null;
  const myId = getState('network.myId');

  if (targetId && targetId !== myId) {
    connectToRelay(targetId);
  } else if (targetId === myId) {
    log.warn('[Relay] Ignored self-assignment request from Host.');
  } else if (targetId === null) {
    // Fallback to Host Direct
    log.debug('[Relay] Fallback to Host requested.');
    clearManagedTimer(RELAY_CONN_TIMER);
    const upstreamDataConn = getState('relay.upstreamDataConn');
    if (upstreamDataConn) {
      upstreamDataConn.close();
      setState('relay.upstreamDataConn', null);
    }
    const transferState = getState('transfer.state');
    if (transferState !== TRANSFER_STATE.IDLE) {
      bus.emit('storage:request-recovery');
    }
  }
}

// ─── Initialize Relay ───────────────────────────────────────────────

export function initRelay(): void {
  registerHandlers({
    [MSG.ASSIGN_DATA_SOURCE]: handleAssignDataSource,
  });

  // Accept incoming relay connections routed from peer.ts
  bus.on('relay:incoming-connection', (conn: DataConnection) => {
    if (conn) handleRelayConnection(conn);
  });

  // Clean up OPFS catch-up pumps when session ends
  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      for (const peerId of opfsCatchupPumps.keys()) {
        stopOpfsCatchupStream(peerId, 'session ended');
      }
    }
  });

  // Relay: serve current file to downstream peer
  bus.on('relay:serve-current-file', (conn: DataConnection, msg: unknown) => {
    const m = msg as Record<string, unknown>;
    if (!conn || !conn.open) return;

    const reqName = m.name ? String(m.name) : '';
    const reqIndex = m.index !== undefined ? Number(m.index) : undefined;

    const currentFileBlob = getState('files.currentFileBlob');
    const nextFileBlob = getState('preload.nextFileBlob');
    const meta = getState('transfer.meta');
    const nextMeta = getState('preload.meta');

    // Try to match current file
    const isMatchCurrent = currentFileBlob && (!reqName || (meta && meta.name === reqName));
    // Try to match preloaded file (index match → name match → implicit next-track match)
    const nextTrackIndex = getState('preload.nextTrackIndex');
    const isMatchPreload = nextFileBlob && (
      (reqIndex !== undefined && nextMeta?.index === reqIndex) ||
      (reqName && nextMeta?.name === reqName) ||
      (!reqName && nextTrackIndex >= 0 && (nextMeta?.index as number) === nextTrackIndex)
    );

    if (isMatchCurrent) {
      log.debug(`[Relay] Serving current file to ${conn.peer}: ${meta?.name}`);
      const file = ensureNamedFile(currentFileBlob, (meta?.name as string) || 'Track');
      if (file) unicastFile(conn, file, 0, null, true).catch(e => log.error('[Relay] unicast current failed:', e));
    } else if (isMatchPreload) {
      log.debug(`[Relay] Serving preloaded file to ${conn.peer}: ${nextMeta?.name}`);
      const file = ensureNamedFile(nextFileBlob, (nextMeta?.name as string) || 'Track');
      if (file) unicastFile(conn, file, 0, null, true).catch(e => log.error('[Relay] unicast preload failed:', e));
    } else if (meta?.name) {
      // Mid-download relay: send header + trigger OPFS catch-up
      const receivedCount = getState('transfer.receivedCount');
      const bootName = (meta.name as string) || reqName;
      log.debug(`[Relay] Bootstrapping downstream for ${bootName} (${receivedCount}/${meta.total || '?'})`);

      safeSend(conn, {
        type: MSG.FILE_START,
        name: bootName,
        mime: (meta.mime as string) || '',
        total: (meta.total as number) || 0,
        size: (meta.size as number) || 0,
        index: (meta.index as number) ?? 0,
        sessionId: (meta.sessionId as number) ?? getState('transfer.localSessionId'),
      });

      // OPFS catch-up: sequential pump with back-pressure
      if (receivedCount > 0) {
        startOpfsCatchupStream(conn, {
          filename: bootName,
          sessionId: (meta.sessionId as number) ?? getState('transfer.localSessionId'),
          startIndex: 0,
          endIndexExclusive: receivedCount,
          isPreload: false,
        });
      }
    } else {
      log.debug('[Relay] No matching data yet for', reqName || 'current');
      safeSend(conn, { type: MSG.FILE_WAIT, message: 'Relay source not ready yet' });
    }
  });

  // Relay: serve recovery chunks to downstream peer (uses catchup pump for multi-chunk)
  bus.on('relay:serve-recovery', (conn: DataConnection, msg: unknown) => {
    const m = msg as Record<string, unknown>;
    if (!conn || !conn.open) return;

    const fileName = (m.fileName || m.name) as string || '';
    const nextChunk = Number(m.nextChunk) || 0;
    const rawSessionId = m.sessionId;
    if (rawSessionId == null) {
      log.warn('[Relay Recovery] Missing sessionId in recovery request — skipping');
      return;
    }
    const sessionId = Number(rawSessionId);
    const receivedCount = getState('transfer.receivedCount');

    log.debug(`[Relay Recovery] Peer ${conn.peer} requested chunk ${nextChunk} of ${fileName}, available: ${receivedCount}`);

    if (receivedCount > nextChunk) {
      startOpfsCatchupStream(conn, {
        filename: fileName,
        sessionId,
        startIndex: nextChunk,
        endIndexExclusive: receivedCount,
        isPreload: false,
      });
    } else {
      safeSend(conn, { type: MSG.FILE_WAIT, message: 'Relay recovery: no data available yet' });
    }
  });

  // Handle OPFS read failure during recovery/catchup serving
  bus.on('opfs:read-error', (data: unknown) => {
    const d = data as Record<string, unknown>;
    if (!d) return;
    const requestId = (d.requestId as string) || '';
    const sepIdx = requestId.lastIndexOf('|');
    const peerId = sepIdx > 0 ? requestId.slice(0, sepIdx) : '';
    const tag = sepIdx > 0 ? requestId.slice(sepIdx + 1) : '';

    if (tag === 'recovery') {
      log.warn(`[Relay Recovery] OPFS read failed for ${peerId}: ${d.error || 'unknown'}`);
      const downstreamDataPeers = getState('relay.downstreamDataPeers');
      const dConn = downstreamDataPeers.find(p => p.peer === peerId);
      if (dConn && dConn.open) {
        safeSend(dConn, { type: MSG.FILE_WAIT, message: 'Relay OPFS read failed' });
      }
    } else if (tag === 'catchup') {
      // Stop the catchup pump on read error to prevent infinite retry (#097).
      // Without this, the pump stays in `awaiting` state until the 6s stuck timer
      // retries indefinitely, since no read-complete event ever arrives.
      log.warn(`[OPFS Catchup] Read failed for ${peerId}: ${d.error || 'unknown'}`);
      const downstreamDataPeers2 = getState('relay.downstreamDataPeers');
      const dConn2 = downstreamDataPeers2.find(p => p.peer === peerId);
      if (dConn2 && dConn2.open) {
        safeSend(dConn2, { type: MSG.FILE_WAIT, message: 'Relay OPFS catchup read failed' });
      }
      stopOpfsCatchupStream(peerId, 'OPFS read error');
    }
  });

  // Handle OPFS read-complete: forward read chunks to downstream peers + advance pump
  bus.on('opfs:read-complete', (data: unknown) => {
    const d = data as Record<string, unknown>;
    if (!d) return;

    const chunk = d.chunk as Uint8Array;
    const index = d.index as number;
    const filename = d.filename as string;
    const requestId = d.requestId as string || '';
    const sessionId = d.sessionId as number;

    // Parse requestId format: "<peerId>|<tag>"
    const sepIdx = requestId.lastIndexOf('|');
    const peerId = sepIdx > 0 ? requestId.slice(0, sepIdx) : requestId;
    const tag = sepIdx > 0 ? requestId.slice(sepIdx + 1) : '';

    if (!peerId || !chunk) return;

    // Only relay-originated reads should forward to downstream peers
    if (tag !== 'catchup') return;

    // Session guard: discard stale chunks
    const localSid = getState('transfer.localSessionId');
    if (sessionId && sessionId < localSid) {
      log.warn(`[OPFS_READ] Stale session chunk discarded (got ${sessionId}, current ${localSid})`);
      return;
    }

    const downstreamDataPeers = getState('relay.downstreamDataPeers');
    const dConn = downstreamDataPeers.find(p => p.peer === peerId);
    if (dConn && dConn.open) {
      const meta = getState('transfer.meta');
      try {
        dConn.send({
          type: MSG.FILE_CHUNK,
          chunk,
          index,
          sessionId,
          total: meta?.total,
          name: (meta?.name as string) || filename,
        });
      } catch (e) {
        log.warn(`[Relay] Send chunk to ${peerId} failed:`, e);
      }
    }

    // Advance the catch-up pump (sequential: wait for response before next read)
    onOpfsCatchupReadComplete(peerId, sessionId, tag);
  });

  log.info('[Relay] Handlers registered');
}
