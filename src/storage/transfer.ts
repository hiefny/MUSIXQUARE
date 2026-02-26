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
import { MSG, CHUNK_SIZE, DELAY, TRANSFER_STATE, WATCHDOG_TIMEOUT, APP_STATE } from '../core/constants.ts';
import { validateSessionId, nextSessionId } from '../core/session.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { postWorkerCommand, cleanupOPFSInWorker } from './opfs.ts';
import { registerHandlers } from '../network/protocol.ts';
import { safeSend, sendToHost } from '../network/peer.ts';
import type { DataConnection } from '../types/index.ts';

// ─── Module State ───────────────────────────────────────────────────
const fileReorderBuffer = new Map<number, Map<number, Uint8Array>>();
let nextExpectedChunk = 0;
let lastChunkTime = 0;
let _pendingEarlyChunks: Array<Record<string, unknown>> = [];

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
  // Always clear stuck preload waiting state on new file-prepare
  if (getState<boolean>('transfer.waitingForPreload')) {
    log.debug('[file-prepare] Clearing stale waitingForPreload flag');
    setState('transfer.waitingForPreload', false);
  }
  clearManagedTimer('preloadWatchdog');
  setState('recovery.retryCount', 0);

  const incomingSid = data.sessionId as number;
  const prevLocalSid = getState<number>('transfer.localSessionId');

  // Update session if newer
  if (incomingSid && incomingSid > prevLocalSid) {
    log.debug(`[file-prepare] New session: ${incomingSid} (prev: ${prevLocalSid})`);
    setState('transfer.localSessionId', incomingSid);
  }

  // Check for preloaded match
  const preloadMeta = getState<Record<string, unknown> | null>('preload.meta');
  const nextFileBlob = getState<Blob | null>('preload.nextFileBlob');
  const hasPreloadedByIndex = preloadMeta && data.index !== undefined && data.index === preloadMeta.index;
  const hasPreloadedByName = preloadMeta && data.name && data.name === preloadMeta.name;

  // Preload INDEX MISMATCH: Don't use stale preload from a different track
  const isMismatch = preloadMeta && data.index !== undefined && data.index !== preloadMeta.index;
  if (isMismatch) {
    log.warn(`[file-prepare] Preload index mismatch! Request: ${data.index}, Preloaded: ${preloadMeta!.index}. Clearing stale preload.`);
    setState('transfer.waitingForPreload', false);
    setState('transfer.skipIncomingFile', false);
    clearManagedTimer('preloadWatchdog');
    // Clear stale preload state
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
  }

  if (nextFileBlob && (hasPreloadedByIndex || hasPreloadedByName)) {
    log.debug('[Guest] Using preloaded track instead of re-downloading:', data.name);
    bus.emit('ui:show-toast', '프리로드된 파일 사용!');

    // Stop old media right before loading preloaded track (minimizes audio gap)
    bus.emit('player:stop-all-media');

    if (data.index !== undefined) {
      setState('playlist.currentTrackIndex', data.index as number);
    }
    bus.emit('ui:update-playlist');

    setState('transfer.skipIncomingFile', true);
    bus.emit('storage:use-preloaded', data.index as number, data.name as string);

    bus.emit('ui:show-loader', false);
    return;
  }

  // Not using preloaded track — stop current media
  bus.emit('player:stop-all-media');

  // Check if preload is IN PROGRESS for this track
  const preloadInProgressByIndex = preloadMeta && data.index !== undefined && data.index === preloadMeta.index;
  const preloadInProgressByName = preloadMeta && data.name && data.name === preloadMeta.name;
  const isPreloading = getState<boolean>('preload.isPreloading');

  if (isPreloading && (preloadInProgressByIndex || preloadInProgressByName)) {
    // Resolve Deadlock: If Host started new Main Session (SID increased), prioritize it
    if (incomingSid > prevLocalSid) {
      log.debug('[file-prepare] Preload in progress but Host started Main Session. Prioritizing Main.');
      setState('preload.nextFileBlob', null);
      setState('preload.meta', null);
      setState('preload.nextTrackIndex', -1);
      // Continue to normal flow below
    } else {
      log.debug('[file-prepare] Preload in progress for this track, waiting...');
      bus.emit('ui:show-loader', true, `프리로드 완료 대기 중: ${data.name}`);

      setState('recovery.pendingFileName', data.name as string || '');
      setState('recovery.pendingFileIndex', data.index as number);
      setState('transfer.waitingForPreload', true);
      setState('transfer.skipIncomingFile', true);

      if (data.index !== undefined) {
        setState('playlist.currentTrackIndex', data.index as number);
        bus.emit('ui:update-playlist');
      }

      // Preload Watchdog: If preloading fails to complete, recover after 10s
      setManagedTimer('preloadWatchdog', () => {
        if (getState<boolean>('transfer.waitingForPreload')) {
          log.warn('[Guest] Preload wait timed out. Force recovering...');
          setState('transfer.waitingForPreload', false);
          bus.emit('ui:show-loader', false);
          setState('transfer.skipIncomingFile', false);

          sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name: data.name, index: data.index });
        }
      }, 10000);

      return; // Don't start new download
    }
  }

  // Normal flow: No preload available, prepare for download
  setState('transfer.skipIncomingFile', false);
  setState('transfer.waitingForPreload', false);

  // Check if same file (resume scenario) — read BEFORE updating pending info
  const meta = getState<Record<string, unknown>>('transfer.meta');
  const receivedCount = getState<number>('transfer.receivedCount');
  const pendingFileIndex = getState<number | undefined>('recovery.pendingFileIndex');
  const isSameFile = (meta.name === data.name) ||
    (pendingFileIndex !== undefined && pendingFileIndex === data.index);

  // Store pending file info (after reading old values above)
  setState('recovery.pendingFileName', data.name as string || '');
  setState('recovery.pendingFileIndex', data.index as number);
  const isResuming = isSameFile && receivedCount > 0;

  if (isResuming) {
    log.debug(`[file-prepare] Same file in progress (${receivedCount} chunks), skipping reset`);
    bus.emit('ui:show-loader', true, `복구 대기 중: ${data.name}`);
  } else {
    bus.emit('storage:clear-previous-track', 'file-prepare');
    if (data.index !== undefined) {
      setState('playlist.currentTrackIndex', data.index as number);
      bus.emit('ui:update-playlist');
    }
    // Update meta
    setState('transfer.meta', {
      ...meta,
      name: data.name || '',
      index: data.index ?? getState<number>('playlist.currentTrackIndex'),
      size: data.size || 0,
      mime: data.mime || '',
      sessionId: data.sessionId || getState<number>('transfer.localSessionId'),
    });

    // Stop YouTube mode for incoming local file
    const currentState = getState<string>('appState');
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
      log.debug('[file-prepare] Stopping YouTube mode for incoming local file');
      bus.emit('youtube:stop-mode');
    }

    bus.emit('ui:show-loader', true, `준비 중: ${data.name}`);
  }

  // Prepare watchdog with jitter recovery
  setManagedTimer('prepareWatchdog', () => {
    const transferState = getState<string>('transfer.state');
    const rc = getState<number>('transfer.receivedCount');
    if (transferState === TRANSFER_STATE.IDLE || rc === 0) {
      log.warn('[Prepare Watchdog] Timeout waiting for data start!');
      bus.emit('ui:show-toast', '준비 지연 중... Host 복구 요청');

      const hostConn = getState<DataConnection | null>('network.hostConn');
      if (hostConn && hostConn.open) {
        const jitter = Math.random() * 1000 + 200;
        setTimeout(() => {
          if (hostConn.open && !getState<Blob | null>('files.currentFileBlob')) {
            bus.emit('storage:request-recovery');
          }
        }, jitter);
      }
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
    downstreamPeers.forEach(p => { safeSend(p, data); });

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
  setState('files.currentFileOpfs', { name: data.name as string });

  if (isRecoverySameFile && receivedCount > 0) {
    // Recovery mode: keep existing chunks
    log.debug(`[file-start] Same file detected! Keeping ${receivedCount}/${data.total} chunks`);

    postWorkerCommand({
      command: 'OPFS_START',
      filename: data.name as string,
      isPreload: false,
      sessionId: validateSessionId(incomingSid),
      size: CHUNK_SIZE,
      keepExisting: true,
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
      size: CHUNK_SIZE,
    });

    setState('transfer.receivedCount', 0);
    setState('transfer.meta', data);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);

    fileReorderBuffer.clear();
    nextExpectedChunk = 0;
  }

  startChunkWatchdog();

  // Replay any early chunks that arrived before FILE_START
  if (_pendingEarlyChunks.length > 0) {
    const earlyChunks = _pendingEarlyChunks.splice(0);
    log.debug(`[file-start] Replaying ${earlyChunks.length} early chunks`);
    for (const pending of earlyChunks) {
      handleFileChunk(pending);
    }
  }

  // Relay header downstream
  const downstreamPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { safeSend(p, data); });

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
    size: CHUNK_SIZE,
  });

  setState('files.currentFileOpfs', { name: data.name as string });

  nextExpectedChunk = (data.startChunk as number) || 0;
  setState('transfer.meta', data);
  setState('transfer.state', TRANSFER_STATE.RECEIVING);

  startChunkWatchdog();

  const downstreamPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { safeSend(p, data); });
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

  // Buffer early chunks that arrive before FILE_START sets up the session
  const transferState = getState<string>('transfer.state');
  if (transferState === TRANSFER_STATE.IDLE && !fileReorderBuffer.has(incomingSid)) {
    _pendingEarlyChunks.push(data);
    if (_pendingEarlyChunks.length > 200) _pendingEarlyChunks.shift(); // overflow protection
    return;
  }

  const localSid = getState<number>('transfer.localSessionId');

  // Reset worker on new session detection
  if (incomingSid > localSid) {
    setState('transfer.localSessionId', incomingSid);
    postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });
    bus.emit('storage:clear-previous-track', 'session-change');
    fileReorderBuffer.clear();
    _pendingEarlyChunks.length = 0;
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

  // Meta-recovery: if we missed FILE_START, extract meta from chunk data
  if (!meta || meta.total === undefined || meta.total === 0) {
    if (data.total !== undefined && Number(data.total) > 0) {
      const recoveredMeta = {
        name: data.name || meta?.name || '',
        total: data.total,
        sessionId: incomingSid,
        size: data.size || 0,
        mime: data.mime || '',
      };
      setState('transfer.meta', recoveredMeta);
      setState('transfer.state', TRANSFER_STATE.RECEIVING);

      const fname = (recoveredMeta.name as string) || '';
      if (fname) {
        setState('files.currentFileOpfs', { name: fname });
        postWorkerCommand({
          command: 'OPFS_START',
          filename: fname,
          isPreload: false,
          sessionId: validateSessionId(incomingSid),
          size: CHUNK_SIZE,
        });
      }
      log.debug(`[FileChunk] Recovered meta from chunk: ${fname} (${recoveredMeta.total} chunks)`);
    } else if (!meta || meta.total === undefined) {
      // Orphan chunk with no meta — can't process
      return;
    }
  }

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

  // Progress update — re-read meta from state to avoid stale reference after recovery
  const currentMeta = getState<Record<string, unknown>>('transfer.meta');
  const total = (currentMeta?.total as number) || 0;
  if (total > 0) {
    const percent = Math.min(100, Math.floor((receivedCount / total) * 100));
    bus.emit('storage:transfer-progress', percent, total);
  }

  // File complete check
  if (total > 0 && receivedCount >= total && getState<string>('transfer.state') !== TRANSFER_STATE.PROCESSING) {
    setState('transfer.state', TRANSFER_STATE.PROCESSING);
    setState('recovery.retryCount', 0);

    // Notify Host that we have this file (dedup via preload.ackSent)
    const processingIndex = currentMeta.index as number;
    if (processingIndex !== undefined) {
      const ackSent = getState<Set<number>>('preload.ackSent');
      if (!ackSent.has(processingIndex)) {
        ackSent.add(processingIndex);
        sendToHost({ type: MSG.PRELOAD_ACK, index: processingIndex });
      }
    }

    // Finalize in OPFS
    postWorkerCommand({
      command: 'OPFS_END',
      filename: (currentMeta.name as string) || '',
      isPreload: false,
      sessionId: validateSessionId(incomingSid),
      totalSize: currentMeta.size as number,
    });

    clearManagedTimer('chunkWatchdog');
  }
}

function handleFileEnd(data: Record<string, unknown>): void {
  if (getState<boolean>('transfer.skipIncomingFile')) return;

  // Relay to downstream
  const downstreamPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { safeSend(p, data); });

  log.debug(`[file-end] Received end signal for: ${data.name}`);
}

function handleFileWait(): void {
  log.debug('[Guest] Relay has no data yet, waiting for forwarded data...');
  bus.emit('ui:show-toast', '릴레이 대기 중... 잠시만 기다려주세요');

  clearManagedTimer('relayWaitTimeout');
  setManagedTimer('relayWaitTimeout', () => {
    const receivedCount = getState<number>('transfer.receivedCount');
    if (receivedCount === 0) {
      log.debug('[Guest] Relay wait timeout - falling back to Host');
      bus.emit('ui:show-toast', '릴레이 응답 없음. Host에서 직접 수신...');

      // Disconnect from relay upstream
      const upstreamDataConn = getState<DataConnection | null>('relay.upstreamDataConn');
      if (upstreamDataConn) {
        upstreamDataConn.close();
        setState('relay.upstreamDataConn', null);
      }

      // Request file from Host
      const hostConn = getState<DataConnection | null>('network.hostConn');
      if (hostConn && hostConn.open) {
        const pendingFileName = getState<string>('recovery.pendingFileName') || '';
        const pendingFileIndex = getState<number | undefined>('recovery.pendingFileIndex');
        const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
        const recoveryIndex = pendingFileIndex !== undefined ? pendingFileIndex : currentTrackIndex;
        const playlist = getState<unknown[]>('playlist.items') || [];

        // Validation: Don't send recovery with invalid index
        if (recoveryIndex < 0 || recoveryIndex >= playlist.length) {
          log.warn('[file-wait timeout] Invalid index, skipping recovery:', recoveryIndex);
          bus.emit('ui:show-loader', false);
          return;
        }

        // Check if preload is in progress for this track
        const preloadMeta = getState<Record<string, unknown> | null>('preload.meta');
        if (preloadMeta && preloadMeta.index === recoveryIndex) {
          log.debug('[file-wait timeout] Preload in progress for this track, waiting...');
          bus.emit('ui:show-toast', '프리로드 완료 대기 중...');
          return;
        }

        log.debug(`[file-wait timeout] Requesting from Host: ${pendingFileName} index: ${recoveryIndex}`);
        sendToHost({
          type: MSG.REQUEST_DATA_RECOVERY,
          nextChunk: 0,
          fileName: pendingFileName,
          index: recoveryIndex,
        });
      }
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
