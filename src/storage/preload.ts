/**
 * MUSIXQUARE 2.0 — Preload System
 * Extracted from original app.js lines 4064-4270, 7549-8143 (preload handlers)
 *
 * Manages: Host-side preload scheduling, background transfer to peers,
 * Guest-side preload receive (start/chunk/end), preload-ack, play-preloaded.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, DELAY, TRANSFER_STATE } from '../core/constants.ts';
import { nextSessionId, validateSessionId } from '../core/session.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { postWorkerCommand, readFileFromOpfs } from './opfs.ts';
import { registerHandlers } from '../network/protocol.ts';
import { safeSend, sendToHost, canSendFileTo, filterEligiblePeers, isRemoteGuest } from '../network/peer.ts';
import type { DataConnection, AnyProtocolMsg } from '../types/index.ts';

// ─── Reorder Buffer ──────────────────────────────────────────────────
// sessionId → Map(chunkIndex → Uint8Array)
const preloadReorderBuffer = new Map<number, Map<number, Uint8Array>>();
let latestPreloadSessionId = 0;
const MAX_EARLY_PRELOAD_CHUNKS = 128;
let _activePlayPreloadedIndex: number | undefined;

/**
 * Clean up reorder buffers and session state for stale (non-current) sessions.
 */
function cleanupStalePreloadSessions(keepSessionId: number): void {
  // Clean up reorder buffers for old sessions
  for (const sid of preloadReorderBuffer.keys()) {
    if (sid !== keepSessionId) {
      preloadReorderBuffer.delete(sid);
    }
  }
  // Clean up finalized/skipped session entries (keep only the active one)
  const sessionState = getState('preload.sessionState');
  for (const [sid, entry] of sessionState.entries()) {
    if (sid !== keepSessionId && (entry.finalized || entry.skipped)) {
      sessionState.delete(sid);
    }
  }
}

// ─── Host: Schedule Preload ─────────────────────────────────────────

/**
 * Schedule next track preload after a delay (host-only).
 */
export function schedulePreload(delayMs = 500): void {
  clearManagedTimer('preloadScheduleTimer');
  setManagedTimer('preloadScheduleTimer', () => {
    preloadNextTrack();
  }, delayMs);
}

/**
 * Preload the next track in the playlist (host-only).
 */
async function preloadNextTrack(): Promise<void> {
  const playlist = getState('playlist.items');
  if (playlist.length <= 1) return;

  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const repeatMode = getState('playlist.repeatMode');
  const isShuffle = getState('playlist.isShuffle');

  const currentSession = nextSessionId();
  setState('preload.sessionId', currentSession);

  // Determine next index
  let nextIdx: number;
  if (repeatMode === 2) {
    nextIdx = currentTrackIndex; // Repeat One
  } else if (isShuffle && playlist.length > 1) {
    do {
      nextIdx = Math.floor(Math.random() * playlist.length);
    } while (nextIdx === currentTrackIndex);
  } else if (isShuffle && playlist.length === 1) {
    nextIdx = 0;
  } else {
    nextIdx = currentTrackIndex + 1;
    if (nextIdx >= playlist.length) {
      if (repeatMode === 1) nextIdx = 0;
      else nextIdx = -1;
    }
  }

  setState('preload.nextTrackIndex', nextIdx);

  if (nextIdx < 0 || nextIdx >= playlist.length) {
    setState('preload.isPreloading', false);
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    return;
  }

  const item = playlist[nextIdx];
  if (!item) {
    setState('preload.isPreloading', false);
    return;
  }

  // Skip YouTube items
  if (item.type === 'youtube') {
    setState('preload.isPreloading', false);
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    return;
  }

  const file = item.file as File;
  if (!file) return;

  log.debug('[Preload] Starting for:', file.name, 'session:', currentSession);
  setState('preload.isPreloading', true);

  const total = Math.ceil(file.size / CHUNK_SIZE);
  setState('preload.nextFileBlob', file);
  setState('preload.meta', {
    name: file.name,
    index: nextIdx,
    mime: file.type,
    total,
    size: file.size,
    sessionId: currentSession,
  });

  // Broadcast preload to connected peers
  await backgroundTransfer(file, nextIdx, currentSession);

  if (getState('preload.sessionId') === currentSession) {
    setState('preload.isPreloading', false);
  }
}

// ─── Host: Background Transfer ──────────────────────────────────────

async function backgroundTransfer(file: File, index: number, sessionId: number): Promise<void> {
  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(file.size / CHUNK);
  const header = {
    type: MSG.PRELOAD_START,
    name: file.name,
    mime: file.type,
    total,
    size: file.size,
    index,
    sessionId,
  };

  const targets = filterEligiblePeers();

  if (targets.length === 0) return;

  const targetsWhoNeedChunks = targets.filter(p => {
    const preloadedIndexes = p.preloadedIndexes as Set<number> | undefined;
    return !preloadedIndexes || !preloadedIndexes.has(index);
  });

  // Send header per-peer
  targets.forEach(p => {
    const conn = p.conn as DataConnection;
    const needsChunks = targetsWhoNeedChunks.includes(p);
    safeSend(conn, { ...header, skipped: !needsChunks });
  });

  // Send chunks
  for (let i = 0; i < total; i++) {
    if (getState('preload.sessionId') !== sessionId) return;

    // Backpressure
    let congested = true;
    while (congested) {
      congested = false;
      for (const p of targets) {
        const conn = p.conn as DataConnection;
        if (conn.open && conn.dataChannel && conn.dataChannel.bufferedAmount > 256 * 1024) {
          congested = true;
          break;
        }
      }
      if (congested) await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
    }

    const start = i * CHUNK;
    const end = Math.min(start + CHUNK, file.size);
    const chunkBuf = await file.slice(start, end).arrayBuffer();
    const chunk = new Uint8Array(chunkBuf);
    const chunkMsg = { type: MSG.PRELOAD_CHUNK, chunk, index: i, sessionId };

    targetsWhoNeedChunks.forEach(p => {
      const conn = p.conn as DataConnection;
      safeSend(conn, chunkMsg);
    });
  }

  if (getState('preload.sessionId') === sessionId) {
    const endMsg = { type: MSG.PRELOAD_END, name: file.name, index, sessionId };
    targets.forEach(p => {
      const conn = p.conn as DataConnection;
      safeSend(conn, endMsg);
    });
    log.debug('[Preload] Complete for index:', index);
  }
}

/**
 * Unicast preload data to a single peer (for late-joining guests).
 */
export async function unicastPreload(
  conn: DataConnection,
  file: File | Blob,
  index: number,
  sessionId: number
): Promise<void> {
  if (!conn || !conn.open || !file) return;

  // Transport guard: block remote/unknown peers
  if (!(await canSendFileTo(conn))) {
    log.info('[Preload Unicast] Skipped — remote/unknown peer');
    return;
  }

  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(file.size / CHUNK);
  const fileName = 'name' in file ? file.name : 'Track';

  safeSend(conn, {
    type: MSG.PRELOAD_START,
    name: fileName,
    mime: file.type,
    total,
    size: file.size,
    index,
    sessionId,
    skipped: false,
  });

  for (let i = 0; i < total; i++) {
    if (!conn.open) return;
    while (conn.open && conn.dataChannel && conn.dataChannel.bufferedAmount > 256 * 1024) {
      await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
    }
    if (!conn.open) return;
    const start = i * CHUNK;
    const chunkBuf = await file.slice(start, Math.min(start + CHUNK, file.size)).arrayBuffer();
    safeSend(conn, { type: MSG.PRELOAD_CHUNK, chunk: new Uint8Array(chunkBuf), index: i, sessionId });
  }

  safeSend(conn, { type: MSG.PRELOAD_END, name: fileName, index, sessionId });
}

// ─── Guest: Preload Receive Handlers ────────────────────────────────

function handlePreloadStart(data: Record<string, unknown>): void {
  // Remote guests: skip preload (transport guard)
  if (isRemoteGuest()) {
    log.info('[Preload] Skipped — remote/unknown guest');
    return;
  }

  const sid = data.sessionId as number;
  if (!sid) {
    log.warn('[Preload] Start message missing sessionId. Ignoring.');
    return;
  }

  clearManagedTimer('prepareWatchdog');

  // Clean up buffers from previous sessions when a new one starts
  if (latestPreloadSessionId && latestPreloadSessionId !== sid) {
    cleanupStalePreloadSessions(sid);
  }
  latestPreloadSessionId = sid;

  // Skip if this preload was already marked as skipped by host
  if (data.skipped) {
    log.debug(`[Preload] Skipping session ${sid}`);
    const sessionState = getState('preload.sessionState');
    sessionState.set(sid, {
      skipped: true,
      progress: 0,
      total: (data.total as number) || 0,
      name: (data.name as string) || '',
      index: (data.index as number) || 0,
      size: (data.size as number) || 0,
      mime: (data.mime as string) || '',
      nextExpectedChunk: 0,
      finalized: false,
    });
    try { preloadReorderBuffer.delete(sid); } catch { /* ignore */ }
    return;
  }

  // Clear any stuck waiting state from previous preload
  setState('transfer.waitingForPreload', false);

  // Validate required metadata
  if (!data.name || !data.total || (data.total as number) <= 0) {
    log.error('[Preload] Start message has invalid metadata:', data);
    return;
  }

  log.debug(`[Preload] Start: ${data.name} (index: ${data.index}, total: ${data.total})`);

  // Show loader only if main transfer is not in progress
  const transferState = getState('transfer.state');
  if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE || !transferState) {
    bus.emit('ui:show-loader', true, `다음 곡 준비 중... (${data.name})`);
  }

  // Initialize session state
  const sessionState = getState('preload.sessionState');
  sessionState.set(sid, {
    skipped: false,
    progress: 0,
    total: (data.total as number) || 0,
    name: (data.name as string) || '',
    index: (data.index as number) || 0,
    size: (data.size as number) || 0,
    mime: (data.mime as string) || '',
    nextExpectedChunk: 0,
    finalized: false,
  });

  setState('preload.meta', {
    name: data.name as string,
    index: data.index as number,
    mime: data.mime as string,
    total: data.total as number,
    size: data.size as number,
    sessionId: sid,
  });

  // OPFS: Start preload slot
  // Reset preload slot before starting (clear stale locks)
  postWorkerCommand({ command: 'OPFS_RESET', isPreload: true });

  postWorkerCommand({
    command: 'OPFS_START',
    filename: data.name as string,
    isPreload: true,
    sessionId: validateSessionId(sid),
    size: CHUNK_SIZE,
  });

  // Drain any chunks that arrived before PRELOAD_START (unordered delivery)
  try { drainPreloadReorderBuffer(sid); } catch { /* best-effort */ }

  // Relay downstream
  const downstreamPeers = getState('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { safeSend(p, data as AnyProtocolMsg); });

  // Watchdog: unconditionally clear preload loader after 30s
  clearManagedTimer('preloadWatchdog');
  setManagedTimer('preloadWatchdog', () => {
    log.warn('[Preload] Watchdog: forcing preload loader reset after 30s');
    bus.emit('ui:show-loader', false);
    setState('transfer.waitingForPreload', false);
    // If main transfer is still in progress, restore its loader
    const transferState = getState('transfer.state');
    if (transferState === TRANSFER_STATE.RECEIVING) {
      const meta = getState('transfer.meta');
      const receivedCount = getState('transfer.receivedCount');
      const total = (meta?.total as number) || 0;
      if (total > 0) {
        const pct = Math.round((receivedCount / total) * 100);
        bus.emit('ui:update-loader', pct);
      }
    }
  }, 30000);
}

function drainPreloadReorderBuffer(sessionId: number): void {
  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sessionId);
  if (!session || session.skipped) return;

  const sessionBuffer = preloadReorderBuffer.get(sessionId);
  if (!sessionBuffer) return;

  let nextChunkPtr = session.nextExpectedChunk || 0;

  while (sessionBuffer.has(nextChunkPtr)) {
    const chunk = sessionBuffer.get(nextChunkPtr)!;

    // Clone chunk to prevent detachment issues (one for relay, one for worker)
    const chunkClone = new Uint8Array(chunk);
    const fileName = session.name;

    // If we still don't know the filename, keep buffering
    if (!fileName) break;

    // Relay downstream
    const downstreamPeers = getState('relay.downstreamDataPeers');
    if (downstreamPeers.length > 0) {
      const relayCopy = new Uint8Array(chunk);
      const relayMsg = { type: MSG.PRELOAD_CHUNK, chunk: relayCopy, index: nextChunkPtr, sessionId };
      downstreamPeers.forEach(p => { safeSend(p, relayMsg); });
    }

    postWorkerCommand({
      command: 'OPFS_WRITE',
      chunk: chunkClone.buffer as ArrayBuffer,
      index: nextChunkPtr,
      isPreload: true,
      filename: fileName,
      sessionId: validateSessionId(sessionId),
    });

    sessionBuffer.delete(nextChunkPtr);
    nextChunkPtr++;
  }

  session.nextExpectedChunk = nextChunkPtr;
  session.progress = nextChunkPtr;

  // Update preload progress UI (only if main transfer is not active)
  if (session.total > 0) {
    const pct = Math.round((session.progress / session.total) * 100);
    const transferState = getState('transfer.state');
    if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE || !transferState) {
      bus.emit('ui:show-loader', true, `다음 곡 준비 중... ${pct}%`);
      bus.emit('ui:update-loader', pct);
    }
  }

  // Tick watchdog on progress
  const preloadMeta = getState('preload.meta');
  if (preloadMeta && (preloadMeta.total as number) > 0) {
    clearManagedTimer('preloadWatchdog');
    setManagedTimer('preloadWatchdog', () => {
      const transferState = getState('transfer.state');
      if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE) {
        bus.emit('ui:show-loader', false);
      }
    }, 15000);
  }

  // Finalize if all chunks received (in-chunk finalization)
  const totalExpected = session.total || 0;
  const fileSize = session.size || 0;
  if (totalExpected > 0 && session.progress >= totalExpected) {
    if (!session.finalized) {
      log.debug(`[Preload] All chunks received (${session.progress}/${totalExpected}). Finalizing...`);
      session.finalized = true;
      postWorkerCommand({
        command: 'OPFS_END',
        filename: session.name,
        isPreload: true,
        sessionId: validateSessionId(sessionId),
        totalSize: fileSize,
      });
      preloadReorderBuffer.delete(sessionId); // Prevent memory leak
    }
  }
}

function handlePreloadChunk(data: Record<string, unknown>): void {
  // Remote guests: drop preload chunks (transport guard)
  if (isRemoteGuest()) return;

  // Require explicit sessionId — fallback to latestPreloadSessionId
  let sid = data.sessionId as number;
  if (!sid && latestPreloadSessionId !== 0) {
    sid = latestPreloadSessionId;
  }
  if (!sid) return;

  // Ignore chunks from sessions older than the latest known
  if (latestPreloadSessionId && sid < latestPreloadSessionId) return;

  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sid);

  // If session state is marked skipped/finalized, ignore
  if (session?.skipped || session?.finalized) return;

  // Buffer the chunk in the reorder map
  if (!preloadReorderBuffer.has(sid)) {
    preloadReorderBuffer.set(sid, new Map());
  }
  const sessionBuffer = preloadReorderBuffer.get(sid)!;

  // Clone data before storing to avoid detached ArrayBuffer issues
  sessionBuffer.set(data.index as number, new Uint8Array(data.chunk as Uint8Array));

  // If PRELOAD_START hasn't been processed yet (unordered delivery),
  // keep buffering until sessionState exists so we have a reliable filename/total.
  if (!session) {
    if (sessionBuffer.size > MAX_EARLY_PRELOAD_CHUNKS) {
      // Drop oldest chunk instead of entire buffer to preserve recent data
      const oldestKey = Math.min(...sessionBuffer.keys());
      sessionBuffer.delete(oldestKey);
      log.warn(`[Preload] Early chunk buffer overflow (SID: ${sid}). Dropped oldest chunk ${oldestKey}.`);
    }
    return;
  }

  // Drain the reorder buffer sequentially
  drainPreloadReorderBuffer(sid);
}

function handlePreloadEnd(data: Record<string, unknown>): void {
  const sid = data.sessionId as number;
  if (!sid) return;

  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sid);
  if (!session || session.skipped) return;

  // Only finalize if not already finalized by in-chunk detection
  if (!session.finalized) {
    session.finalized = true;

    // Finalize OPFS
    postWorkerCommand({
      command: 'OPFS_END',
      filename: session.name,
      isPreload: true,
      sessionId: validateSessionId(sid),
      totalSize: session.size,
    });
  }

  // Cleanup reorder buffer
  preloadReorderBuffer.delete(sid);

  log.debug(`[Preload] End: ${session.name} (${session.progress}/${session.total} chunks)`);

  // NOTE: PRELOAD_ACK is now sent in storage:preload-file-ready handler (after OPFS confirms file)
  // Previously it was sent here (before OPFS confirmed), causing timing issues.

  // Relay downstream
  const downstreamPeers = getState('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { safeSend(p, data as AnyProtocolMsg); });

  bus.emit('storage:preload-ready', data.index as number);
}

function handlePreloadAck(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Guest ignores

  const connectedPeers = getState('network.connectedPeers');
  const p = connectedPeers.find(x => x.id === conn.peer);
  if (p && data.index !== undefined) {
    const preloadedIndexes = p.preloadedIndexes as Set<number>;
    if (preloadedIndexes) {
      preloadedIndexes.add(Number(data.index));
      log.debug(`[Host] Marked index ${data.index} as CACHED for peer ${p.label}`);
    }
  }
}

function handlePlayPreloaded(data: Record<string, unknown>): void {
  const index = data.index as number;
  const name = (data.name as string) || '';
  const retryAttempt = (data.retryAttempt as number) || 0;

  log.debug(`[Guest] Command: Play Preloaded Track, index: ${index}, name: ${name}, retry: ${retryAttempt}`);

  // Dedup: ignore duplicate commands for same track (unless retry)
  if (_activePlayPreloadedIndex === index && retryAttempt === 0) {
    log.debug(`[PlayPreloaded] Already processing track ${index}, ignoring duplicate`);
    return;
  }

  // First attempt: stop current media and update state
  if (retryAttempt === 0) {
    _activePlayPreloadedIndex = index;
    bus.emit('player:stop-all-media');

    if (data.index !== undefined) {
      setState('playlist.currentTrackIndex', index);
    }
    bus.emit('ui:update-playlist');

    // Update metadata for UI title display
    const playlist = getState('playlist.items') || [];
    if (playlist[index]) {
      bus.emit('player:metadata-update', playlist[index]);
    }
  }

  // Check if preloaded blob matches requested track
  const nextFileBlob = getState('preload.nextFileBlob');
  const nextMeta = getState('preload.meta');
  const isMatch = nextFileBlob && nextMeta &&
    ((nextMeta.index as number) === index || (nextMeta.name as string) === name);

  if (isMatch) {
    // Preloaded file available — activate it directly via playback module
    log.debug('[Guest] Using preloaded file for track', index);
    setState('recovery.pendingFileIndex', index);
    bus.emit('storage:use-preloaded', index, name);
    _activePlayPreloadedIndex = undefined;

    // Relay downstream
    const downstreamPeers = getState('relay.downstreamDataPeers');
    downstreamPeers.forEach(p => {
      safeSend(p, { type: MSG.PLAY_PRELOADED, index, name });
    });
    return;
  }

  // Check if preload download is still in progress for this track
  const sessionState = getState('preload.sessionState');
  let isDownloadingSame = false;
  for (const [, session] of sessionState) {
    if (!session.skipped && !session.finalized &&
      (session.index === index || session.name === name)) {
      isDownloadingSame = true;
      break;
    }
  }

  if (isDownloadingSame && retryAttempt < 4) {
    // Preload in progress — retry after delay (up to 4 attempts = 2s total)
    log.debug(`[PlayPreloaded] Preload in progress. Retrying... (${retryAttempt + 1}/4)`);
    if (retryAttempt === 0) {
      bus.emit('ui:show-loader', true, '다운로드 마무리 중...');
    }
    setTimeout(() => {
      handlePlayPreloaded({ ...data, retryAttempt: retryAttempt + 1 });
    }, 500);
    return;
  }

  // Fallback: no preloaded file available — request from host
  log.warn('[Guest] No preloaded file for track', index, '— requesting from Host');
  _activePlayPreloadedIndex = undefined;

  // Ensure incoming file transfer is not skipped
  setState('transfer.skipIncomingFile', false);
  setState('transfer.waitingForPreload', false);
  setState('recovery.pendingFileIndex', index);
  setState('recovery.pendingFileName', name);
  bus.emit('ui:show-loader', true, '파일 요청 중...');

  const hostConn = getState('network.hostConn');
  const playlist = getState('playlist.items') || [];
  const trackName = name || playlist[index]?.name || '';

  if (hostConn?.open) {
    // Short jitter to avoid thundering herd, but not too long to cause stale track
    const jitter = Math.random() * 300 + 50;
    setTimeout(() => {
      // Double-check: did preload arrive during wait?
      const nowBlob = getState('preload.nextFileBlob');
      const nowMeta = getState('preload.meta');
      if (nowBlob && nowMeta &&
        ((nowMeta.index as number) === index || (nowMeta.name as string) === trackName)) {
        log.debug('[Guest] Preload arrived during jitter wait! Using it.');
        bus.emit('storage:use-preloaded', index, trackName);
        return;
      }

      // Check if host already moved past this track — don't request stale file
      const currentTrackIndex = getState('playlist.currentTrackIndex');
      if (currentTrackIndex !== index) {
        log.debug(`[Guest] Track already changed (${currentTrackIndex} != ${index}), skipping recovery request`);
        bus.emit('ui:show-loader', false);
        return;
      }

      if (sendToHost({
          type: MSG.REQUEST_DATA_RECOVERY,
          nextChunk: 0,
          fileName: trackName,
          index,
        })) {
        log.debug('[Guest] Requested file recovery from Host for:', trackName);
      }
    }, jitter);
  }

  // Relay downstream regardless
  const downstreamPeers = getState('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => {
    safeSend(p, { type: MSG.PLAY_PRELOADED, index, name: trackName });
  });
}

// ─── Register Handlers ──────────────────────────────────────────────

export function initPreload(): void {
  registerHandlers({
    [MSG.PRELOAD_START]: handlePreloadStart,
    [MSG.PRELOAD_CHUNK]: handlePreloadChunk,
    [MSG.PRELOAD_END]: handlePreloadEnd,
    [MSG.PRELOAD_ACK]: handlePreloadAck,
    [MSG.PLAY_PRELOADED]: handlePlayPreloaded,
  });

  // Handle preload file ready from OPFS (bridged from opfs:file-ready via playback.ts)
  bus.on('storage:preload-file-ready', async (filename: string, sessionId: number) => {
    log.debug(`[Preload] OPFS preload ready: ${filename} (SID: ${sessionId})`);

    const file = await readFileFromOpfs(filename, true);
    if (!file) {
      log.error('[Preload] Failed to read preload file from OPFS:', filename);
      return;
    }

    // Store as preload blob
    setState('preload.nextFileBlob', file);

    const sessionState = getState('preload.sessionState');
    const session = sessionState.get(sessionId);
    const preloadMeta = getState('preload.meta');

    setState('preload.meta', session || preloadMeta);

    const nextTrackIndex = (session?.index ?? (preloadMeta?.index as number)) ?? -1;
    setState('preload.nextTrackIndex', nextTrackIndex);

    // Send PRELOAD_ACK to host now that OPFS file is confirmed ready
    if (nextTrackIndex >= 0) {
      const ackSent = getState('preload.ackSent');
      if (!ackSent.has(nextTrackIndex)) {
        ackSent.add(nextTrackIndex);
        if (sendToHost({ type: MSG.PRELOAD_ACK, index: nextTrackIndex })) {
          log.debug(`[Guest] Sent PRELOAD_ACK for index ${nextTrackIndex}`);
        }
      }
    }

    // Hide preload loader (background preload complete)
    bus.emit('ui:show-loader', false);

    // If guest was waiting for this preloaded file, trigger playback
    const waitingForPreload = getState('transfer.waitingForPreload');
    const pendingFileIndex = getState('recovery.pendingFileIndex');
    if (waitingForPreload && pendingFileIndex === nextTrackIndex) {
      log.debug('[Preload] Guest was waiting for this track. Playing now.');
      setState('transfer.waitingForPreload', false);
      bus.emit('storage:use-preloaded', nextTrackIndex, filename);
    }
  });

  // Handle preload-ready notification (emitted after PRELOAD_END)
  bus.on('storage:preload-ready', (index: number) => {
    log.debug(`[Preload] Preload ready for index: ${index}`);
    // This signals the preload chain is complete.
    // The actual file finalization is handled by opfs:file-ready → storage:preload-file-ready
  });

  log.info('[Preload] Handlers registered');
}
