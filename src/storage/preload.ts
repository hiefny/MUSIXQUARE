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
import type { DataConnection, PreloadSessionEntry } from '../types/index.ts';

// ─── Reorder Buffer ──────────────────────────────────────────────────
// sessionId → Map(chunkIndex → Uint8Array)
const preloadReorderBuffer = new Map<number, Map<number, Uint8Array>>();
let latestPreloadSessionId = 0;
const MAX_EARLY_PRELOAD_CHUNKS = 128;

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
  const playlist = getState<Array<Record<string, unknown>>>('playlist.items');
  if (playlist.length <= 1) return;

  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
  const repeatMode = getState<number>('playlist.repeatMode');
  const isShuffle = getState<boolean>('playlist.isShuffle');

  const currentSession = nextSessionId();
  setState('preload.sessionId', currentSession);

  // Determine next index
  let nextIdx = -1;
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

  if (getState<number>('preload.sessionId') === currentSession) {
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

  const connectedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
  const targets = connectedPeers.filter(p =>
    p.status === 'connected' && (p.conn as DataConnection)?.open && p.isDataTarget !== false
  );

  if (targets.length === 0) return;

  const targetsWhoNeedChunks = targets.filter(p => {
    const preloadedIndexes = p.preloadedIndexes as Set<number> | undefined;
    return !preloadedIndexes || !preloadedIndexes.has(index);
  });

  // Send header per-peer
  targets.forEach(p => {
    const conn = p.conn as DataConnection;
    const needsChunks = targetsWhoNeedChunks.includes(p);
    if (conn.open) {
      conn.send({ ...header, skipped: !needsChunks });
    }
  });

  // Send chunks
  for (let i = 0; i < total; i++) {
    if (getState<number>('preload.sessionId') !== sessionId) return;

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
      if (conn.open) conn.send(chunkMsg);
    });
  }

  if (getState<number>('preload.sessionId') === sessionId) {
    const endMsg = { type: MSG.PRELOAD_END, name: file.name, index, sessionId };
    targets.forEach(p => {
      const conn = p.conn as DataConnection;
      if (conn.open) conn.send(endMsg);
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
  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(file.size / CHUNK);
  const fileName = 'name' in file ? file.name : 'Track';

  conn.send({
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
    conn.send({ type: MSG.PRELOAD_CHUNK, chunk: new Uint8Array(chunkBuf), index: i, sessionId });
  }

  if (conn.open) {
    conn.send({ type: MSG.PRELOAD_END, name: fileName, index, sessionId });
  }
}

// ─── Guest: Preload Receive Handlers ────────────────────────────────

function handlePreloadStart(data: Record<string, unknown>): void {
  const sid = data.sessionId as number;
  if (!sid) {
    log.warn('[Preload] Start message missing sessionId. Ignoring.');
    return;
  }

  clearManagedTimer('prepareWatchdog');
  latestPreloadSessionId = sid;

  // Skip if this preload was already marked as skipped by host
  if (data.skipped) {
    log.debug(`[Preload] Skipping session ${sid}`);
    const sessionState = getState<Map<number, PreloadSessionEntry>>('preload.sessionState');
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

  log.debug(`[Preload] Start: ${data.name} (index: ${data.index}, total: ${data.total})`);

  // Initialize session state
  const sessionState = getState<Map<number, PreloadSessionEntry>>('preload.sessionState');
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
    name: data.name,
    index: data.index,
    mime: data.mime,
    total: data.total,
    size: data.size,
    sessionId: sid,
  });
  setState('preload.count', 0);

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
  const downstreamPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { if (p.open) p.send(data); });

  // Watchdog: unconditionally clear preload loader after 30s
  clearManagedTimer('preloadWatchdog');
  setManagedTimer('preloadWatchdog', () => {
    log.warn('[Preload] Watchdog: forcing preload loader reset after 30s');
    bus.emit('ui:show-loader', false);
    setState('transfer.waitingForPreload', false);
    // If main transfer is still in progress, restore its loader
    const transferState = getState<string>('transfer.state');
    if (transferState === TRANSFER_STATE.RECEIVING) {
      const meta = getState<Record<string, unknown>>('transfer.meta');
      const receivedCount = getState<number>('transfer.receivedCount');
      const total = (meta?.total as number) || 0;
      if (total > 0) {
        const pct = Math.round((receivedCount / total) * 100);
        bus.emit('ui:update-loader', pct);
      }
    }
  }, 30000);
}

function drainPreloadReorderBuffer(sessionId: number): void {
  const sessionState = getState<Map<number, PreloadSessionEntry>>('preload.sessionState');
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
    const downstreamPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
    if (downstreamPeers.length > 0) {
      const relayCopy = new Uint8Array(chunk);
      const relayMsg = { type: MSG.PRELOAD_CHUNK, chunk: relayCopy, index: nextChunkPtr, sessionId };
      downstreamPeers.forEach(p => { if (p.open) p.send(relayMsg); });
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
  setState('preload.count', session.progress);

  // Tick watchdog on progress
  const preloadMeta = getState<Record<string, unknown> | null>('preload.meta');
  if (preloadMeta && (preloadMeta.total as number) > 0) {
    clearManagedTimer('preloadWatchdog');
    setManagedTimer('preloadWatchdog', () => {
      const transferState = getState<string>('transfer.state');
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
        sessionId: sessionId,
        totalSize: fileSize,
      });
      preloadReorderBuffer.delete(sessionId); // Prevent memory leak
    }
  }
}

function handlePreloadChunk(data: Record<string, unknown>): void {
  // Require explicit sessionId — fallback to latestPreloadSessionId
  let sid = data.sessionId as number;
  if (!sid && latestPreloadSessionId !== 0) {
    sid = latestPreloadSessionId;
  }
  if (!sid) return;

  const sessionState = getState<Map<number, PreloadSessionEntry>>('preload.sessionState');
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
      log.warn(`[Preload] Too many early chunks without session state (SID: ${sid}). Dropping.`);
      preloadReorderBuffer.delete(sid);
    }
    return;
  }

  // Drain the reorder buffer sequentially
  drainPreloadReorderBuffer(sid);
}

function handlePreloadEnd(data: Record<string, unknown>): void {
  const sid = data.sessionId as number;
  if (!sid) return;

  const sessionState = getState<Map<number, PreloadSessionEntry>>('preload.sessionState');
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

  // Notify host
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn && hostConn.open && data.index !== undefined) {
    const ackSent = getState<Set<number>>('preload.ackSent');
    if (!ackSent.has(data.index as number)) {
      ackSent.add(data.index as number);
      hostConn.send({ type: MSG.PRELOAD_ACK, index: data.index });
    }
  }

  // Relay downstream
  const downstreamPeers = getState<DataConnection[]>('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { if (p.open) p.send(data); });

  bus.emit('storage:preload-ready', data.index as number);
}

function handlePreloadAck(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return; // Guest ignores

  const connectedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
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
  log.debug('[Guest] Command: Play Preloaded Track, index:', index);

  if (data.index !== undefined) {
    setState('playlist.currentTrackIndex', index);
  }

  bus.emit('storage:play-preloaded', index, data.name as string, data);
}

// ─── Register Handlers ──────────────────────────────────────────────

export function initPreload(): void {
  registerHandlers({
    [MSG.PRELOAD_START]: handlePreloadStart as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.PRELOAD_CHUNK]: handlePreloadChunk as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.PRELOAD_END]: handlePreloadEnd as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.PRELOAD_ACK]: handlePreloadAck,
    [MSG.PLAY_PRELOADED]: handlePlayPreloaded as (d: Record<string, unknown>, c: DataConnection) => void,
  });

  // Handle preload file ready from OPFS (bridged from opfs:file-ready via playback.ts)
  bus.on('storage:preload-file-ready', (async (...args: unknown[]) => {
    const filename = args[0] as string;
    const sessionId = args[1] as number;

    log.debug(`[Preload] OPFS preload ready: ${filename} (SID: ${sessionId})`);

    const file = await readFileFromOpfs(filename, true);
    if (!file) {
      log.error('[Preload] Failed to read preload file from OPFS:', filename);
      return;
    }

    // Store as preload blob
    setState('preload.nextFileBlob', file);

    const sessionState = getState<Map<number, PreloadSessionEntry>>('preload.sessionState');
    const session = sessionState.get(sessionId);
    const preloadMeta = getState<Record<string, unknown> | null>('preload.meta');

    setState('preload.meta', session || preloadMeta);

    const nextTrackIndex = (session?.index ?? (preloadMeta?.index as number)) ?? -1;
    setState('preload.nextTrackIndex', nextTrackIndex);

    // If guest was waiting for this preloaded file, trigger playback
    const waitingForPreload = getState<boolean>('transfer.waitingForPreload');
    const pendingFileIndex = getState<number | undefined>('recovery.pendingFileIndex');
    if (waitingForPreload && pendingFileIndex === nextTrackIndex) {
      log.debug('[Preload] Guest was waiting for this track. Playing now.');
      setState('transfer.waitingForPreload', false);
      bus.emit('ui:show-loader', false);
      bus.emit('storage:play-preloaded', nextTrackIndex, filename, {});
    }
  }) as (...args: unknown[]) => void);

  // Handle preload-ready notification (emitted after PRELOAD_END)
  bus.on('storage:preload-ready', ((...args: unknown[]) => {
    const index = args[0] as number;
    log.debug(`[Preload] Preload ready for index: ${index}`);
    // This signals the preload chain is complete.
    // The actual file finalization is handled by opfs:file-ready → storage:preload-file-ready
  }) as (...args: unknown[]) => void);

  log.info('[Preload] Handlers registered');
}
