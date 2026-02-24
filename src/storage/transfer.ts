/**
 * MUSIXQUARE 2.0 — File Transfer (Chunk Receive & Send)
 * Extracted from original app.js lines 6887-7615, 9847-10093
 *
 * Manages: File receive (prepare/start/chunk/end/wait/resume),
 * file send (broadcastFile, unicastFile), chunk watchdog,
 * reorder buffer, relay forwarding during transfer.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, DELAY, TRANSFER_STATE, WATCHDOG_TIMEOUT } from '../core/constants.ts';
import { validateSessionId, nextSessionId } from '../core/session.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { postWorkerCommand, cleanupOPFSInWorker } from './opfs.ts';
import { registerHandlers } from '../network/protocol.ts';
import type { DataConnection } from '../types/index.ts';

// ─── Module State ───────────────────────────────────────────────────
const fileReorderBuffer = new Map<number, Map<number, Uint8Array>>();
let nextExpectedChunk = 0;
let lastChunkTime = 0;

// ─── Chunk Watchdog ─────────────────────────────────────────────────

function startChunkWatchdog(): void {
  clearManagedTimer('chunkWatchdog');
  lastChunkTime = Date.now();
  setState('transfer.lastReceivedCountSnapshot', getState<number>('transfer.receivedCount'));

  setManagedTimer('chunkWatchdog', () => {
    const timeSinceLast = Date.now() - lastChunkTime;
    const receivedCount = getState<number>('transfer.receivedCount');
    const lastSnapshot = getState<number>('transfer.lastReceivedCountSnapshot');
    const isStuck = (receivedCount === lastSnapshot) && timeSinceLast > WATCHDOG_TIMEOUT;

    if (isStuck || timeSinceLast > WATCHDOG_TIMEOUT) {
      clearManagedTimer('chunkWatchdog');
      bus.emit('storage:request-recovery');
    }
    setState('transfer.lastReceivedCountSnapshot', receivedCount);
  }, 1000, { interval: true });
}

// ─── File Receive Handlers ──────────────────────────────────────────

function handleFilePrepare(data: Record<string, unknown>): void {
  const incomingSid = data.sessionId as number;
  const localSid = getState<number>('transfer.localSessionId');

  // Update session if newer
  if (incomingSid && incomingSid > localSid) {
    setState('transfer.localSessionId', incomingSid);
  }

  // Check for preloaded match
  const preloadMeta = getState<Record<string, unknown> | null>('preload.meta');
  const nextFileBlob = getState<Blob | null>('preload.nextFileBlob');
  const hasPreloadedByIndex = preloadMeta && data.index !== undefined && data.index === preloadMeta.index;
  const hasPreloadedByName = preloadMeta && data.name && data.name === preloadMeta.name;

  if (nextFileBlob && (hasPreloadedByIndex || hasPreloadedByName)) {
    log.debug('[Guest] Using preloaded track instead of re-downloading:', data.name);
    setState('transfer.skipIncomingFile', true);

    if (data.index !== undefined) {
      setState('playlist.currentTrackIndex', data.index as number);
    }

    bus.emit('storage:use-preloaded', data.index as number, data.name as string);
    return;
  }

  // Normal flow: prepare for download
  setState('transfer.skipIncomingFile', false);
  setState('recovery.retryCount', 0);

  // Store pending file info
  setState('recovery.pendingFileName', data.name as string || '');
  setState('recovery.pendingFileIndex', data.index as number);

  // Check if same file (resume scenario)
  const meta = getState<Record<string, unknown>>('transfer.meta');
  const receivedCount = getState<number>('transfer.receivedCount');
  const isSameFile = (meta.name === data.name);
  const isResuming = isSameFile && receivedCount > 0;

  if (!isResuming) {
    bus.emit('storage:clear-previous-track', 'file-prepare');
    if (data.index !== undefined) {
      setState('playlist.currentTrackIndex', data.index as number);
    }
    // Update meta
    setState('transfer.meta', {
      ...meta,
      name: data.name || '',
      index: data.index ?? getState<number>('playlist.currentTrackIndex'),
      size: data.size || 0,
      mime: data.mime || '',
      sessionId: data.sessionId || localSid,
    });
  }

  bus.emit('ui:show-loader', true, `준비 중: ${data.name}`);

  // Prepare watchdog
  setManagedTimer('prepareWatchdog', () => {
    const transferState = getState<string>('transfer.state');
    const rc = getState<number>('transfer.receivedCount');
    if (transferState === TRANSFER_STATE.IDLE || rc === 0) {
      log.warn('[Prepare Watchdog] Timeout waiting for data start!');
      bus.emit('storage:request-recovery');
    }
  }, 15000);
}

function handleFileStart(data: Record<string, unknown>): void {
  const incomingSid = data.sessionId as number;
  const localSid = getState<number>('transfer.localSessionId');

  if (!incomingSid || incomingSid < localSid) {
    log.warn(`[file-start] Stale session ignored. Current: ${localSid}, Received: ${incomingSid}`);
    return;
  }

  const isNewSession = incomingSid > localSid;
  if (isNewSession) {
    setState('transfer.localSessionId', incomingSid);
    postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });
    bus.emit('storage:clear-previous-track', 'new-session-start');
  }

  // Skip if using preloaded file
  if (getState<boolean>('transfer.skipIncomingFile')) {
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');

    // Relay header downstream
    const downstreamPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
    downstreamPeers.forEach(p => { if (p.open) p.send(data); });

    return;
  }

  clearManagedTimer('prepareWatchdog');
  clearManagedTimer('chunkWatchdog');

  // Check if same file (recovery)
  const meta = getState<Record<string, unknown>>('transfer.meta');
  const receivedCount = getState<number>('transfer.receivedCount');
  const isRecoverySameFile = meta.name === data.name && meta.total === (data.total as number);

  const opfsFilename = getState<{ name: string | null }>('files.currentFileOpfs');
  if (opfsFilename.name && opfsFilename.name !== data.name) {
    cleanupOPFSInWorker(opfsFilename.name, false);
  }
  opfsFilename.name = data.name as string;

  if (isRecoverySameFile && receivedCount > 0) {
    // Recovery mode: keep existing chunks
    log.debug(`[file-start] Same file detected! Keeping ${receivedCount}/${data.total} chunks`);

    postWorkerCommand({
      command: 'OPFS_START',
      filename: data.name as string,
      isPreload: false,
      sessionId: validateSessionId(incomingSid),
    });

    setState('transfer.meta', data);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
  } else {
    // New file: initialize fresh
    postWorkerCommand({
      command: 'OPFS_START',
      filename: data.name as string,
      isPreload: false,
      sessionId: validateSessionId(incomingSid),
    });

    setState('transfer.receivedCount', 0);
    setState('transfer.meta', data);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);

    fileReorderBuffer.clear();
    nextExpectedChunk = 0;
  }

  startChunkWatchdog();

  // Relay header downstream
  const downstreamPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { if (p.open) p.send(data); });

  bus.emit('ui:show-loader', true, `수신 중... 0%`);
}

function handleFileResume(data: Record<string, unknown>): void {
  const incomingSid = data.sessionId as number;
  const localSid = getState<number>('transfer.localSessionId');

  if (!incomingSid || incomingSid < localSid) return;
  if (incomingSid > localSid) setState('transfer.localSessionId', incomingSid);

  clearManagedTimer('prepareWatchdog');
  setState('transfer.skipIncomingFile', false);

  postWorkerCommand({
    command: 'OPFS_START',
    filename: data.name as string,
    isPreload: false,
    sessionId: validateSessionId(incomingSid),
  });

  const opfsFilename = getState<{ name: string | null }>('files.currentFileOpfs');
  opfsFilename.name = data.name as string;

  nextExpectedChunk = (data.startChunk as number) || 0;
  setState('transfer.meta', data);
  setState('transfer.state', TRANSFER_STATE.RECEIVING);

  startChunkWatchdog();

  const downstreamPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { if (p.open) p.send(data); });
}

function handleFileChunk(data: Record<string, unknown>): void {
  const incomingSid = data.sessionId as number;
  if (!incomingSid) return;

  // Skip if using preloaded file
  if (getState<boolean>('transfer.skipIncomingFile')) {
    const localSid = getState<number>('transfer.localSessionId');
    if (incomingSid > localSid) setState('transfer.localSessionId', incomingSid);
    return;
  }

  const localSid = getState<number>('transfer.localSessionId');

  // Reset worker on new session detection
  if (incomingSid > localSid) {
    setState('transfer.localSessionId', incomingSid);
    postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });
    bus.emit('storage:clear-previous-track', 'session-change');
    fileReorderBuffer.clear();
    nextExpectedChunk = 0;
    setState('transfer.receivedCount', 0);
  }

  if (incomingSid < localSid) return;

  if (!fileReorderBuffer.has(incomingSid)) {
    fileReorderBuffer.set(incomingSid, new Map());
    nextExpectedChunk = 0;
  }

  const sessionBuffer = fileReorderBuffer.get(incomingSid)!;
  const chunkData = new Uint8Array(data.chunk as ArrayBuffer);
  sessionBuffer.set(data.index as number, chunkData);

  const meta = getState<Record<string, unknown>>('transfer.meta');
  const opfsFilename = getState<{ name: string | null }>('files.currentFileOpfs');
  let receivedCount = getState<number>('transfer.receivedCount');

  // Process all contiguous chunks in order
  while (sessionBuffer.has(nextExpectedChunk)) {
    const chunk = sessionBuffer.get(nextExpectedChunk)!;

    // Prepare relay copy before transfer to worker
    const downstreamPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
    let relayCopy: Uint8Array | null = null;
    if (downstreamPeers.length > 0) {
      relayCopy = new Uint8Array(chunk);
    }

    postWorkerCommand({
      command: 'OPFS_WRITE',
      chunk: chunk instanceof ArrayBuffer ? chunk : (chunk as Uint8Array).buffer as ArrayBuffer,
      index: nextExpectedChunk,
      isPreload: false,
      filename: opfsFilename.name || '',
      sessionId: validateSessionId(incomingSid),
    });

    // Relay to downstream
    if (relayCopy && downstreamPeers.length > 0) {
      const chunkMsg = {
        type: MSG.FILE_CHUNK,
        chunk: relayCopy,
        index: nextExpectedChunk,
        sessionId: incomingSid,
      };
      downstreamPeers.forEach(p => {
        if (p.open) try { p.send(chunkMsg); } catch { /* noop */ }
      });
    }

    sessionBuffer.delete(nextExpectedChunk);
    nextExpectedChunk++;
    receivedCount++;
  }

  setState('transfer.receivedCount', receivedCount);
  lastChunkTime = Date.now();

  // Progress update
  const total = (meta.total as number) || 0;
  if (total > 0) {
    const percent = Math.min(100, Math.floor((receivedCount / total) * 100));
    bus.emit('storage:transfer-progress', percent, total);
  }

  // File complete check
  if (total > 0 && receivedCount >= total && getState<string>('transfer.state') !== TRANSFER_STATE.PROCESSING) {
    setState('transfer.state', TRANSFER_STATE.PROCESSING);
    setState('recovery.retryCount', 0);

    // Notify Host that we have this file
    const hostConn = getState<DataConnection | null>('network.hostConn');
    const processingIndex = meta.index as number;
    if (hostConn && hostConn.open && processingIndex !== undefined) {
      hostConn.send({ type: MSG.PRELOAD_ACK, index: processingIndex });
    }

    // Finalize in OPFS
    postWorkerCommand({
      command: 'OPFS_END',
      filename: (meta.name as string) || '',
      isPreload: false,
      sessionId: validateSessionId(incomingSid),
      total: meta.size as number,
    });

    clearManagedTimer('chunkWatchdog');
  }
}

function handleFileEnd(data: Record<string, unknown>): void {
  if (getState<boolean>('transfer.skipIncomingFile')) return;

  // Relay to downstream
  const downstreamPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { if (p.open) p.send(data); });

  log.debug(`[file-end] Received end signal for: ${data.name}`);
}

function handleFileWait(): void {
  log.debug('[Guest] Relay has no data yet, waiting...');

  clearManagedTimer('relayWaitTimeout');
  setManagedTimer('relayWaitTimeout', () => {
    const receivedCount = getState<number>('transfer.receivedCount');
    if (receivedCount === 0) {
      log.debug('[Guest] Relay wait timeout - falling back to Host');
      bus.emit('storage:request-recovery');
    }
  }, 10000);
}

// ─── File Send (Host) ───────────────────────────────────────────────

/**
 * Broadcast a file to all connected peers (host-only).
 */
export async function broadcastFile(file: File, explicitSessionId: number | null = null): Promise<void> {
  let sessionId: number;
  const currentTransferSessionId = getState<number>('transfer.currentSessionId');

  if (explicitSessionId !== null) {
    sessionId = explicitSessionId;
    if (sessionId > currentTransferSessionId) setState('transfer.currentSessionId', sessionId);
  } else {
    sessionId = currentTransferSessionId + 1;
    setState('transfer.currentSessionId', sessionId);
  }

  const activeBroadcast = getState<number | null>('transfer.activeBroadcastSession');
  if (activeBroadcast === sessionId) return;
  setState('transfer.activeBroadcastSession', sessionId);

  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(file.size / CHUNK);
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
  const header = {
    type: MSG.FILE_START,
    name: file.name,
    mime: file.type,
    total,
    size: file.size,
    index: currentTrackIndex,
    sessionId,
  };

  const connectedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
  const eligiblePeers = connectedPeers.filter(p =>
    p.status === 'connected' && (p.conn as DataConnection)?.open && p.isDataTarget !== false
  );

  if (eligiblePeers.length === 0) return;

  // Send header
  eligiblePeers.forEach(p => {
    try { (p.conn as DataConnection).send(header); } catch { /* noop */ }
  });

  // Send chunks
  for (let i = 0; i < total; i++) {
    if (getState<number | null>('transfer.activeBroadcastSession') !== sessionId) return;

    const start = i * CHUNK;
    const end = Math.min(start + CHUNK, file.size);
    const chunkBuf = await file.slice(start, end).arrayBuffer();
    const chunk = new Uint8Array(chunkBuf);
    const chunkMsg = { type: MSG.FILE_CHUNK, chunk, index: i, sessionId, total, name: file.name };

    for (const p of eligiblePeers) {
      const conn = p.conn as DataConnection;
      if (conn?.open) {
        // Backpressure check
        while (conn.dataChannel && conn.dataChannel.bufferedAmount > 512 * 1024) {
          await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
          if (!conn.open) break;
        }
        try { conn.send(chunkMsg); } catch { /* noop */ }
      }
    }

    if (i % 50 === 0) await new Promise(r => setTimeout(r, DELAY.TICK));
  }

  // Send end message
  const endMsg = { type: MSG.FILE_END, name: file.name, mime: file.type, sessionId };
  eligiblePeers.forEach(p => {
    const conn = p.conn as DataConnection;
    if (conn?.open) try { conn.send(endMsg); } catch { /* noop */ }
  });

  setState('transfer.activeBroadcastSession', null);
}

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

  const effectiveSessionId = sessionId ?? getState<number>('transfer.currentSessionId');
  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(file.size / CHUNK);
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');

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

  await new Promise(r => setTimeout(r, 100));

  try {
    for (let i = startChunkIndex; i < total; i++) {
      if (getState<number>('transfer.currentSessionId') !== effectiveSessionId) return;
      if (!conn.open) return;

      // Backpressure
      const startWait = Date.now();
      while (conn.dataChannel && conn.dataChannel.bufferedAmount > 64 * 1024) {
        if (Date.now() - startWait > 30000) break;
        await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
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

      if (i % 50 === 0) await new Promise(r => setTimeout(r, DELAY.TICK));
    }

    if (conn.open) {
      conn.send({ type: MSG.FILE_END, name: fileName, mime: file.type, sessionId: effectiveSessionId });
      log.debug('[Unicast] Transfer complete:', fileName);
    }
  } catch (e) {
    log.error('[Unicast] Transfer error:', e);
  }
}

// ─── Register Handlers ──────────────────────────────────────────────

export function initTransfer(): void {
  registerHandlers({
    [MSG.FILE_PREPARE]: handleFilePrepare as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.FILE_START]: handleFileStart as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.FILE_RESUME]: handleFileResume as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.FILE_CHUNK]: handleFileChunk as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.FILE_END]: handleFileEnd as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.FILE_WAIT]: handleFileWait as unknown as (d: Record<string, unknown>, c: DataConnection) => void,
  });

  log.info('[Transfer] Handlers registered');
}
