/**
 * MUSIXQUARE 2.0 — Relay Chain Management
 * Extracted from original app.js lines 9225-9555
 *
 * Manages: Upstream relay connection, downstream data peers,
 * relay file serving, preload relay, OPFS catch-up streaming.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE } from '../core/constants.ts';
import type { DataConnection, PeerInstance } from '../types/index.ts';
import { registerHandlers } from './protocol.ts';
import { getPeer } from './peer.ts';
import { unicastFile } from '../storage/transfer.ts';
import { ensureNamedFile, postWorkerCommand } from '../storage/opfs.ts';

// ─── Module State ───────────────────────────────────────────────────
let _relayConnTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Upstream Relay Connection ──────────────────────────────────────

/**
 * Connect to a relay peer (upstream data source).
 * This is called when the host assigns a data relay target.
 */
export function connectToRelay(targetId: string): void {
  const peer = getPeer();
  if (!peer) return;

  // Close existing relay connection
  const upstreamDataConn = getState<DataConnection | null>('relay.upstreamDataConn');
  if (upstreamDataConn) {
    log.debug(`[Relay] Closing existing relay connection for new assignment`);
    upstreamDataConn.close();
    setState('relay.upstreamDataConn', null);
  }

  // Cancel previous relay connection timeout
  if (_relayConnTimer) { clearTimeout(_relayConnTimer); _relayConnTimer = null; }

  const myId = getState<string | null>('network.myId');
  const conn = peer.connect(targetId, {
    metadata: { type: MSG.DATA_RELAY, label: myId },
  });

  const FAIL_TIMEOUT = 10000;
  _relayConnTimer = setTimeout(() => {
    if (!conn.open) {
      log.warn('[Relay] Connect Timeout');
      conn.close();
      setState('relay.upstreamDataConn', null);

      // Fallback: request recovery from host
      const hostConn = getState<DataConnection | null>('network.hostConn');
      if (hostConn && hostConn.open) {
        const meta = getState<Record<string, unknown>>('transfer.meta');
        const receivedCount = getState<number>('transfer.receivedCount');
        const currentTrackIndex = getState<number>('playlist.currentTrackIndex');

        hostConn.send({
          type: MSG.REQUEST_DATA_RECOVERY,
          nextChunk: receivedCount || 0,
          fileName: meta?.name || '',
          index: currentTrackIndex,
        });
      }
    }
  }, FAIL_TIMEOUT);

  conn.on('open', () => {
    if (_relayConnTimer) { clearTimeout(_relayConnTimer); _relayConnTimer = null; }
    setState('relay.upstreamDataConn', conn);
    log.info('[Relay] Connected to upstream relay');

    conn.on('data', (data: unknown) => {
      bus.emit('network:data', data, conn);
    });

    // Request current file from relay
    conn.send({ type: MSG.REQUEST_CURRENT_FILE });
  });

  conn.on('error', (err: unknown) => {
    log.warn('[Relay] Connection error:', err);
    if (_relayConnTimer) { clearTimeout(_relayConnTimer); _relayConnTimer = null; }
  });

  conn.on('close', () => {
    setState('relay.upstreamDataConn', null);

    const meta = getState<Record<string, unknown>>('transfer.meta');
    const receivedCount = getState<number>('transfer.receivedCount');
    const total = (meta?.total as number) || 0;

    if (receivedCount < total) {
      const hostConn = getState<DataConnection | null>('network.hostConn');
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

    const downstreamDataPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
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
    const downstreamDataPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
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

  const downstreamDataPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
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
    if (p.open) p.send(startMsg);
  });

  // Send chunks
  for (let i = 0; i < total; i++) {
    const activeDownstream = downstreamDataPeers.filter(p => p.open);
    if (activeDownstream.length === 0) break;

    const start = i * CHUNK;
    const end = Math.min(start + CHUNK, blob.size);
    const chunk = new Uint8Array(await blob.slice(start, end).arrayBuffer());

    const chunkMsg = { type: MSG.PRELOAD_CHUNK, chunk, index: i, sessionId };
    activeDownstream.forEach(p => p.send(chunkMsg));

    // Backpressure: yield every 10 chunks
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 40));
  }

  // Send PRELOAD_END
  const endMsg = { type: MSG.PRELOAD_END, name: fileName, index, sessionId };
  downstreamDataPeers.forEach(p => {
    if (p.open) p.send(endMsg);
  });

  log.debug(`[Preload Relay] Finished relaying index ${index}`);
}

// ─── Protocol Handlers ──────────────────────────────────────────────

function handleAssignDataSource(data: Record<string, unknown>): void {
  const targetId = data.targetId as string | null;
  const myId = getState<string | null>('network.myId');

  if (targetId && targetId !== myId) {
    connectToRelay(targetId);
  } else if (targetId === myId) {
    log.warn('[Relay] Ignored self-assignment request from Host.');
  } else if (targetId === null) {
    // Fallback to Host Direct
    log.debug('[Relay] Fallback to Host requested.');
    const upstreamDataConn = getState<DataConnection | null>('relay.upstreamDataConn');
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
    [MSG.ASSIGN_DATA_SOURCE]: handleAssignDataSource as unknown as (d: Record<string, unknown>, c: DataConnection) => void,
  });

  // Accept incoming relay connections routed from peer.ts
  bus.on('relay:incoming-connection', ((...args: unknown[]) => {
    const conn = args[0] as DataConnection;
    if (conn) handleRelayConnection(conn);
  }) as (...args: unknown[]) => void);

  // Relay: serve current file to downstream peer
  bus.on('relay:serve-current-file', ((...args: unknown[]) => {
    const conn = args[0] as DataConnection;
    const msg = args[1] as Record<string, unknown>;
    if (!conn || !conn.open) return;

    const reqName = msg.name ? String(msg.name) : '';
    const reqIndex = msg.index !== undefined ? Number(msg.index) : undefined;

    const currentFileBlob = getState<Blob | null>('files.currentFileBlob');
    const nextFileBlob = getState<Blob | null>('preload.nextFileBlob');
    const meta = getState<Record<string, unknown>>('transfer.meta');
    const nextMeta = getState<Record<string, unknown> | null>('preload.meta');
    const currentTrackIndex = getState<number>('playlist.currentTrackIndex');

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
      const receivedCount = getState<number>('transfer.receivedCount');
      const bootName = (meta.name as string) || reqName;
      log.debug(`[Relay] Bootstrapping downstream for ${bootName} (${receivedCount}/${meta.total || '?'})`);

      conn.send({
        ...meta,
        type: MSG.FILE_START,
        name: bootName,
        sessionId: meta.sessionId || getState<number>('transfer.localSessionId'),
      });

      // OPFS catch-up: read stored chunks and send to downstream
      if (receivedCount > 0) {
        for (let i = 0; i < receivedCount; i++) {
          postWorkerCommand({
            command: 'OPFS_READ',
            filename: bootName,
            index: i,
            isPreload: false,
            sessionId: meta.sessionId as number || getState<number>('transfer.localSessionId'),
            requestId: `${conn.peer}|catchup`,
          });
        }
      }
    } else {
      log.debug('[Relay] No matching data yet for', reqName || 'current');
      conn.send({ type: MSG.FILE_WAIT, message: 'Relay source not ready yet' });
    }
  }) as (...args: unknown[]) => void);

  // Relay: serve recovery chunk to downstream peer
  bus.on('relay:serve-recovery', ((...args: unknown[]) => {
    const conn = args[0] as DataConnection;
    const msg = args[1] as Record<string, unknown>;
    if (!conn || !conn.open) return;

    const fileName = (msg.fileName || msg.name) as string || '';
    const nextChunk = Number(msg.nextChunk) || 0;
    const sessionId = msg.sessionId as number || getState<number>('transfer.localSessionId');

    log.debug(`[Relay Recovery] Peer ${conn.peer} requested chunk ${nextChunk} of ${fileName}`);

    postWorkerCommand({
      command: 'OPFS_READ',
      filename: fileName,
      index: nextChunk,
      isPreload: false,
      sessionId,
      requestId: `${conn.peer}|recovery`,
    });
  }) as (...args: unknown[]) => void);

  // Handle OPFS read-complete: forward read chunks to downstream peers
  bus.on('opfs:read-complete', ((...args: unknown[]) => {
    const data = args[0] as Record<string, unknown>;
    if (!data) return;

    const chunk = data.chunk as Uint8Array;
    const index = data.index as number;
    const filename = data.filename as string;
    const requestId = data.requestId as string || '';
    const sessionId = data.sessionId as number;

    // Parse requestId format: "<peerId>|<tag>"
    const sepIdx = requestId.lastIndexOf('|');
    const peerId = sepIdx > 0 ? requestId.slice(0, sepIdx) : requestId;
    const _tag = sepIdx > 0 ? requestId.slice(sepIdx + 1) : '';

    if (!peerId || !chunk) return;

    // Session guard: discard stale chunks
    const localSid = getState<number>('transfer.localSessionId');
    if (sessionId && sessionId < localSid) {
      log.warn(`[OPFS_READ] Stale session chunk discarded (got ${sessionId}, current ${localSid})`);
      return;
    }

    const downstreamDataPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
    const dConn = downstreamDataPeers.find(p => p.peer === peerId);
    if (dConn && dConn.open) {
      const meta = getState<Record<string, unknown>>('transfer.meta');
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
  }) as (...args: unknown[]) => void);

  // Handle OPFS write-complete for relay catch-up streaming
  bus.on('opfs:write-complete', ((...args: unknown[]) => {
    const peerId = args[0] as string;
    const _sessionId = args[1] as number;
    const _tag = args[2] as string;

    if (!peerId) return;

    // Forward new chunks to downstream peers as they arrive
    const downstreamDataPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
    const hasDownstream = downstreamDataPeers.some(p => p.peer === peerId && p.open);
    if (hasDownstream) {
      log.debug(`[Relay] Write-complete notification for peer ${peerId}`);
    }
  }) as (...args: unknown[]) => void);

  log.info('[Relay] Handlers registered');
}
