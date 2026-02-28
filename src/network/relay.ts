/**
 * MUSIXQUARE 2.0 — Relay Chain Management
 * Extracted from original app.js lines 9225-9555
 *
 * Manages: Upstream relay connection, downstream data peers,
 * relay file serving, preload relay, OPFS catch-up streaming.
 *
 * NOTE: 현재 MAX_GUEST_SLOTS=3 직결 구조로 운영 중이며 릴레이는 비활성 상태.
 * 호스트가 ASSIGN_DATA_SOURCE 메시지를 보내지 않으므로 이 모듈은 실행되지 않음.
 * 추후 안정성 확보 후 4인 이상 지원 시 릴레이 시스템 검토 예정.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, DELAY } from '../core/constants.ts';
import { validateSessionId } from '../core/session.ts';
import type { DataConnection } from '../types/index.ts';
import { registerHandlers } from './protocol.ts';
import { getPeer, safeSend, sendToHost } from './peer.ts';
import { unicastFile } from '../storage/transfer.ts';
import { ensureNamedFile, postWorkerCommand } from '../storage/opfs.ts';

// ─── Module State ───────────────────────────────────────────────────
let _relayConnTimer: ReturnType<typeof setTimeout> | null = null;

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
  _timer: ReturnType<typeof setTimeout> | null;
}

const opfsCatchupPumps = new Map<string, OpfsCatchupPump>();

function stopOpfsCatchupStream(peerId: string, reason = ''): void {
  const pump = opfsCatchupPumps.get(peerId);
  if (!pump) return;
  pump.active = false;
  if (pump._timer) {
    clearTimeout(pump._timer);
    pump._timer = null;
  }
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
    _timer: null,
  };

  opfsCatchupPumps.set(peerId, pump);
  scheduleOpfsCatchupPump(pump, 0);
}

function scheduleOpfsCatchupPump(pump: OpfsCatchupPump, delayMs: number): void {
  if (!pump || !pump.active) return;
  if (pump._timer) clearTimeout(pump._timer);
  pump._timer = setTimeout(() => runOpfsCatchupPump(pump), Math.max(0, delayMs | 0));
}

function runOpfsCatchupPump(pump: OpfsCatchupPump): void {
  if (!pump || !pump.active) return;

  const conn = pump.conn;
  if (!conn || !conn.open) {
    stopOpfsCatchupStream(pump.peerId, 'peer closed');
    return;
  }

  // Session guard: stop if app advanced to newer session
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
      log.warn(`[OPFS Catchup] Stuck ${stuckMs}ms, retry idx=${pump.awaitingIndex} for ...${pump.peerId.slice(-4)}`);
      pump.awaiting = false;
      pump.nextIndex = pump.awaitingIndex; // rewind to retry
      pump.awaitingIndex = null;
    }
    scheduleOpfsCatchupPump(pump, DELAY.BACKPRESSURE);
    return;
  }

  // Back-pressure: don't read faster than RTC can send
  const bufAmt = conn.dataChannel ? conn.dataChannel.bufferedAmount : 0;
  const peerQueueLen = conn._relayQueue ? conn._relayQueue.length : 0;

  if (peerQueueLen > 120 || bufAmt > 256 * 1024) {
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
  if (_relayConnTimer) { clearTimeout(_relayConnTimer); _relayConnTimer = null; }

  const myId = getState('network.myId');
  const conn = peer.connect(targetId, {
    metadata: { type: MSG.DATA_RELAY, label: myId },
  });

  const FAIL_TIMEOUT = 10000;
  _relayConnTimer = setTimeout(() => {
    if (!conn.open) {
      log.warn('[Relay] Connect Timeout');
      bus.emit('ui:show-toast', t('network.relay_timeout'));
      conn.close();
      setState('relay.upstreamDataConn', null);

      // Fallback: request recovery from host
      const meta = getState('transfer.meta');
      const receivedCount = getState('transfer.receivedCount');
      const currentTrackIndex = getState('playlist.currentTrackIndex');

      sendToHost({
        type: MSG.REQUEST_DATA_RECOVERY,
        nextChunk: receivedCount || 0,
        fileName: meta?.name || '',
        index: currentTrackIndex,
      });
    }
  }, FAIL_TIMEOUT);

  conn.on('open', () => {
    if (_relayConnTimer) { clearTimeout(_relayConnTimer); _relayConnTimer = null; }
    setState('relay.upstreamDataConn', conn);
    log.info('[Relay] Connected to upstream relay');
    bus.emit('ui:show-toast', t('network.relay_connected'));

    conn.on('data', (data: unknown) => {
      bus.emit('network:data', data, conn);
    });

    // Request current file from relay
    safeSend(conn, { type: MSG.REQUEST_CURRENT_FILE });
  });

  conn.on('error', (err: unknown) => {
    log.warn('[Relay] Connection error:', err);
    if (_relayConnTimer) { clearTimeout(_relayConnTimer); _relayConnTimer = null; }
    try { conn.close(); } catch { /* noop */ }
    const currentUpstream = getState('relay.upstreamDataConn');
    if (currentUpstream === conn) {
      setState('relay.upstreamDataConn', null);
    }
  });

  conn.on('close', () => {
    const currentUpstream = getState('relay.upstreamDataConn');
    if (currentUpstream && currentUpstream !== conn) return;

    setState('relay.upstreamDataConn', null);
    bus.emit('ui:show-toast', t('network.relay_disconnected'));

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
export function handleRelayConnection(conn: DataConnection): void {
  conn.on('open', () => {
    log.debug('[Relay] Accepted downstream connection from', conn.peer);

    const downstreamDataPeers = getState('relay.downstreamDataPeers');
    if (!downstreamDataPeers.find(p => p.peer === conn.peer)) {
      downstreamDataPeers.push(conn);
      setState('relay.downstreamDataPeers', downstreamDataPeers);
    }
  });

  conn.on('data', (data: unknown) => {
    const msg = data as Record<string, unknown>;

    if (msg.type === MSG.REQUEST_CURRENT_FILE) {
      bus.emit('relay:serve-current-file', conn, msg);
    } else if (msg.type === MSG.REQUEST_DATA_RECOVERY) {
      bus.emit('relay:serve-recovery', conn, msg);
    }
  });

  conn.on('close', () => {
    stopOpfsCatchupStream(conn.peer, 'downstream disconnected');
    const downstreamDataPeers = getState('relay.downstreamDataPeers');
    setState(
      'relay.downstreamDataPeers',
      downstreamDataPeers.filter(p => p.peer !== conn.peer)
    );
  });
}

// ─── Preload Relay ──────────────────────────────────────────────────

/**
 * Relay a preloaded file from local cache to downstream peers.
 */
export async function relayPreloadFromCache(
  blob: Blob,
  index: number,
  sessionId: number,
  fileName: string
): Promise<void> {
  if (!blob) {
    log.warn('[Relay] Cannot relay null blob for index:', index);
    return;
  }

  const downstreamDataPeers = getState('relay.downstreamDataPeers');
  if (downstreamDataPeers.length === 0) return;

  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(blob.size / CHUNK);

  log.debug(`[Preload Relay] Relaying ${fileName} (${total} chunks) to ${downstreamDataPeers.length} peers`);

  // Send PRELOAD_START
  const startMsg = {
    type: MSG.PRELOAD_START,
    name: fileName,
    index,
    sessionId,
    total,
    size: blob.size,
  };
  downstreamDataPeers.forEach(p => {
    safeSend(p, startMsg);
  });

  // Send chunks
  for (let i = 0; i < total; i++) {
    const activeDownstream = downstreamDataPeers.filter(p => p.open);
    if (activeDownstream.length === 0) break;

    const start = i * CHUNK;
    const end = Math.min(start + CHUNK, blob.size);
    const chunk = new Uint8Array(await blob.slice(start, end).arrayBuffer());

    const chunkMsg = { type: MSG.PRELOAD_CHUNK, chunk, index: i, sessionId };
    activeDownstream.forEach(p => safeSend(p, chunkMsg));

    // Backpressure: yield every 10 chunks
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 40));
  }

  // Send PRELOAD_END
  const endMsg = { type: MSG.PRELOAD_END, name: fileName, index, sessionId };
  downstreamDataPeers.forEach(p => {
    safeSend(p, endMsg);
  });

  log.debug(`[Preload Relay] Finished relaying index ${index}`);
}

// ─── Protocol Handlers ──────────────────────────────────────────────

function handleAssignDataSource(data: Record<string, unknown>): void {
  const targetId = data.targetId as string | null;
  const myId = getState('network.myId');

  if (targetId && targetId !== myId) {
    connectToRelay(targetId);
  } else if (targetId === myId) {
    log.warn('[Relay] Ignored self-assignment request from Host.');
  } else if (targetId === null) {
    // Fallback to Host Direct
    log.debug('[Relay] Fallback to Host requested.');
    const upstreamDataConn = getState('relay.upstreamDataConn');
    if (upstreamDataConn) {
      upstreamDataConn.close();
      setState('relay.upstreamDataConn', null);
    }
    bus.emit('storage:request-recovery');
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
    const currentTrackIndex = getState('playlist.currentTrackIndex');

    // Try to match current file
    const isMatchCurrent = currentFileBlob && (!reqName || (meta && meta.name === reqName));
    // Try to match preloaded file
    const isMatchPreload = nextFileBlob && (
      (reqIndex !== undefined && nextMeta?.index === reqIndex) ||
      (reqName && nextMeta?.name === reqName) ||
      (!reqName && (nextMeta?.index as number) === currentTrackIndex)
    );

    if (isMatchCurrent) {
      log.debug(`[Relay] Serving current file to ${conn.peer}: ${meta?.name}`);
      const file = ensureNamedFile(currentFileBlob, (meta?.name as string) || 'Track');
      if (file) unicastFile(conn, file, 0).catch(e => log.error('[Relay] unicast current failed:', e));
    } else if (isMatchPreload) {
      log.debug(`[Relay] Serving preloaded file to ${conn.peer}: ${nextMeta?.name}`);
      const file = ensureNamedFile(nextFileBlob, (nextMeta?.name as string) || 'Track');
      if (file) unicastFile(conn, file, 0).catch(e => log.error('[Relay] unicast preload failed:', e));
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
        index: (meta.index as number) || 0,
        sessionId: (meta.sessionId as number) || getState('transfer.localSessionId'),
      });

      // OPFS catch-up: sequential pump with back-pressure
      if (receivedCount > 0) {
        startOpfsCatchupStream(conn, {
          filename: bootName,
          sessionId: meta.sessionId as number || getState('transfer.localSessionId'),
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

  // Relay: serve recovery chunk to downstream peer
  bus.on('relay:serve-recovery', (conn: DataConnection, msg: unknown) => {
    const m = msg as Record<string, unknown>;
    if (!conn || !conn.open) return;

    const fileName = (m.fileName || m.name) as string || '';
    const nextChunk = Number(m.nextChunk) || 0;
    const sessionId = m.sessionId as number || getState('transfer.localSessionId');

    log.debug(`[Relay Recovery] Peer ${conn.peer} requested chunk ${nextChunk} of ${fileName}`);

    postWorkerCommand({
      command: 'OPFS_READ',
      filename: fileName,
      index: nextChunk,
      isPreload: false,
      sessionId,
      requestId: `${conn.peer}|recovery`,
    });
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
