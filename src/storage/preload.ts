/**
 * MUSIXQUARE 3.0 — Preload System
 *
 * Manages: Host-side preload scheduling, background transfer to peers,
 * Guest-side preload receive (start/chunk/end), preload-ack, play-preloaded.
 */

import { log } from '../core/log.ts';
import { SessionScope } from '../core/session-scope.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, DELAY, TRANSFER_STATE } from '../core/constants.ts';
import { nextSessionId, validateSessionId } from '../core/session.ts';
import { setManagedTimer, clearManagedTimer, delay } from '../core/timers.ts';
import { postWorkerCommand, readFileFromOpfs } from './opfs.ts';
import { registerHandlers } from '../network/protocol.ts';
import { safeSend, sendToHost, canSendFileTo, filterEligiblePeers, isRemoteGuest, hasActiveRelay } from '../network/peer.ts';
import type { DataConnection, AnyProtocolMsg } from '../types/index.ts';

// ─── Reorder Buffer ──────────────────────────────────────────────────
// sessionId → Map(chunkIndex → Uint8Array)
const preloadReorderBuffer = new Map<number, Map<number, Uint8Array>>();
let latestPreloadSessionId = 0;
const MAX_EARLY_PRELOAD_CHUNKS = 128;
let _activePlayPreloadedIndex: number | undefined;
let _preloadScope: SessionScope | null = null;
/** Per-peer unicast preload abort controls (key: peerId) */
const _activePreloadUnicasts = new Map<string, SessionScope>();

/**
 * Clean up reorder buffers and session state for stale (non-current) sessions.
 */
const PRELOAD_SESSION_MAX = 20;

function cleanupStalePreloadSessions(keepSessionId: number): void {
  // Clean up reorder buffers for old sessions
  for (const sid of preloadReorderBuffer.keys()) {
    if (sid !== keepSessionId) {
      preloadReorderBuffer.delete(sid);
    }
  }
  // Clean up finalized/skipped session entries (immutable update)
  const sessionState = getState('preload.sessionState');
  const toRemove: number[] = [];
  for (const [sid, entry] of sessionState.entries()) {
    if (sid !== keepSessionId && (entry.finalized || entry.skipped)) {
      toRemove.push(sid);
    }
  }
  // Hard cap: evict numerically oldest beyond the active one
  if (sessionState.size - toRemove.length > PRELOAD_SESSION_MAX) {
    const sortedSids = [...sessionState.keys()].sort((a, b) => a - b);
    for (const sid of sortedSids) {
      if (sid !== keepSessionId && !toRemove.includes(sid)) {
        toRemove.push(sid);
        if (sessionState.size - toRemove.length <= PRELOAD_SESSION_MAX) break;
      }
    }
  }
  if (toRemove.length > 0) {
    const updated = new Map(sessionState);
    for (const sid of toRemove) updated.delete(sid);
    setState('preload.sessionState', updated);
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
  if (!file) {
    setState('preload.isPreloading', false);
    return;
  }

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
  try {
    await backgroundTransfer(file, nextIdx, currentSession);
  } catch (e) {
    log.warn('[Preload] backgroundTransfer failed:', e);
  } finally {
    if (getState('preload.sessionId') === currentSession) {
      setState('preload.isPreloading', false);
    }
  }
}

// ─── Host: Background Transfer ──────────────────────────────────────

async function backgroundTransfer(file: File, index: number, sessionId: number): Promise<void> {
  _preloadScope = SessionScope.replace(_preloadScope);
  const scope = _preloadScope;

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
    if (scope.aborted) return;
    if (getState('preload.sessionId') !== sessionId) return;

    // Backpressure (with 30s timeout to prevent infinite stall)
    let congested = true;
    const bpStart = Date.now();
    while (congested) {
      congested = false;
      for (const p of targetsWhoNeedChunks) {
        const conn = p.conn as DataConnection;
        if (conn.open && conn.dataChannel && conn.dataChannel.bufferedAmount > 256 * 1024) {
          congested = true;
          break;
        }
      }
      if (congested) {
        if (Date.now() - bpStart > 30_000) { log.warn('[Preload] Backpressure timeout'); break; }
        await delay(DELAY.BACKPRESSURE);
      }
    }

    const start = i * CHUNK;
    const end = Math.min(start + CHUNK, file.size);
    const chunkBuf = await file.slice(start, end).arrayBuffer();
    const chunk = new Uint8Array(chunkBuf);
    const chunkMsg = { type: MSG.PRELOAD_CHUNK, chunk, index: i, sessionId };

    targetsWhoNeedChunks.forEach(p => {
      const conn = p.conn as DataConnection;
      if (conn?.open) safeSend(conn, chunkMsg);
    });
  }

  if (getState('preload.sessionId') === sessionId) {
    const endMsg = { type: MSG.PRELOAD_END, name: file.name, index, sessionId };
    targets.forEach(p => {
      const conn = p.conn as DataConnection;
      if (conn?.open) safeSend(conn, endMsg);
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
  // Per-peer scope isolation: cancel any previous unicast preload to same peer
  const unicastKey = conn.peer;
  const prevScope = _activePreloadUnicasts.get(unicastKey) ?? null;
  const scope = SessionScope.replace(prevScope);
  _activePreloadUnicasts.set(unicastKey, scope);

  if (!conn || !conn.open || !file) {
    scope.dispose();
    _activePreloadUnicasts.delete(unicastKey);
    return;
  }

  // Transport guard: block remote/unknown peers
  if (!(await canSendFileTo(conn))) {
    log.info('[Preload Unicast] Skipped — remote/unknown peer');
    scope.dispose();
    _activePreloadUnicasts.delete(unicastKey);
    return;
  }

  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(file.size / CHUNK);
  const fileName = 'name' in file ? file.name : 'Track';

  try {
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
      if (scope.aborted) return;
      if (!conn.open) return;
      const bpStart = Date.now();
      while (conn.open && conn.dataChannel && conn.dataChannel.bufferedAmount > 256 * 1024) {
        if (Date.now() - bpStart > 30_000) { log.warn('[Preload Unicast] Backpressure timeout'); return; }
        await delay(DELAY.BACKPRESSURE);
      }
      if (!conn.open) return;
      const start = i * CHUNK;
      const chunkBuf = await file.slice(start, Math.min(start + CHUNK, file.size)).arrayBuffer();
      safeSend(conn, { type: MSG.PRELOAD_CHUNK, chunk: new Uint8Array(chunkBuf), index: i, sessionId });
    }

    safeSend(conn, { type: MSG.PRELOAD_END, name: fileName, index, sessionId });
  } finally {
    // Clean up scope if still ours
    if (_activePreloadUnicasts.get(unicastKey) === scope) {
      scope.dispose();
      _activePreloadUnicasts.delete(unicastKey);
    }
  }
}

// ─── Guest: Preload Receive Handlers ────────────────────────────────

function handlePreloadStart(data: Record<string, unknown>): void {
  // Remote guests: skip preload unless relay is active
  if (isRemoteGuest() && !hasActiveRelay()) {
    log.info('[Preload] Skipped — remote/unknown guest without relay');
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
    const skipSessionState = new Map(getState('preload.sessionState'));
    skipSessionState.set(sid, {
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
    setState('preload.sessionState', skipSessionState);
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
    bus.emit('ui:show-loader', true, t('toast.preparing_next', { name: data.name as string }));
  }

  // Initialize session state
  const initSessionState = new Map(getState('preload.sessionState'));
  initSessionState.set(sid, {
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
  setState('preload.sessionState', initSessionState);

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
  // Use setTimeout(0) to let the worker process OPFS_START before receiving WRITE commands
  setManagedTimer('preload-drain-' + sid, () => { try { drainPreloadReorderBuffer(sid); } catch { /* best-effort */ } }, 0);

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

  // Immutable update: create new session object with updated progress
  const totalExpected = session.total || 0;
  const fileSize = session.size || 0;
  const isComplete = totalExpected > 0 && nextChunkPtr >= totalExpected;
  const updatedSession = {
    ...session,
    nextExpectedChunk: nextChunkPtr,
    progress: nextChunkPtr,
    finalized: session.finalized || (isComplete ? true : false),
  };
  const newSessionState = new Map(getState('preload.sessionState'));
  newSessionState.set(sessionId, updatedSession);
  setState('preload.sessionState', newSessionState);

  // Update preload progress UI (only if main transfer is not active)
  if (updatedSession.total > 0) {
    const pct = Math.round((updatedSession.progress / updatedSession.total) * 100);
    const transferState = getState('transfer.state');
    if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE || !transferState) {
      bus.emit('ui:show-loader', true, t('toast.preparing_next_pct', { pct }));
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
  if (isComplete && !session.finalized) {
    log.debug(`[Preload] All chunks received (${nextChunkPtr}/${totalExpected}). Finalizing...`);
    postWorkerCommand({
      command: 'OPFS_END',
      filename: updatedSession.name,
      isPreload: true,
      sessionId: validateSessionId(sessionId),
      totalSize: fileSize,
    });
    preloadReorderBuffer.delete(sessionId); // Prevent memory leak
  }
}

function handlePreloadChunk(data: Record<string, unknown>): void {
  // Remote guests: drop preload chunks unless relay is active
  if (isRemoteGuest() && !hasActiveRelay()) return;

  // Require explicit sessionId — fallback to latestPreloadSessionId
  let sid = data.sessionId as number;
  if (!sid && latestPreloadSessionId !== 0) {
    log.warn('[Preload] Chunk missing sessionId — falling back to latest:', latestPreloadSessionId);
    sid = latestPreloadSessionId;
  }
  if (!sid) return;

  // Ignore chunks from sessions older than the latest known
  if (latestPreloadSessionId && sid < latestPreloadSessionId) return;

  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sid);

  // If session state is marked skipped/finalized, ignore
  if (session?.skipped || session?.finalized) return;

  // Bounds check: drop chunks with index beyond expected total
  if (session && session.total > 0 && (data.index as number) >= session.total) {
    log.warn(`[Preload] Out-of-bounds chunk index ${data.index} (total: ${session.total})`);
    return;
  }

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

  // Drain any remaining buffered chunks FIRST — ensures OPFS_WRITE messages
  // are posted to the worker before OPFS_END (worker processes sequentially).
  drainPreloadReorderBuffer(sid);

  // Re-read session after drain (drain may have updated it via immutable setState)
  const freshSession = getState('preload.sessionState').get(sid);
  if (!freshSession) return;

  // Only finalize if not already finalized by in-chunk detection (drain may have done it)
  if (!freshSession.finalized) {
    const allReceived = freshSession.total > 0 && freshSession.progress >= freshSession.total;
    if (allReceived) {
      // All chunks drained — safe to send OPFS_END
      const finalizedSession = { ...freshSession, finalized: true };
      const updatedSessionState = new Map(getState('preload.sessionState'));
      updatedSessionState.set(sid, finalizedSession);
      setState('preload.sessionState', updatedSessionState);

      postWorkerCommand({
        command: 'OPFS_END',
        filename: freshSession.name,
        isPreload: true,
        sessionId: validateSessionId(sid),
        totalSize: freshSession.size,
      });
    } else {
      // Some chunks still missing — let future handlePreloadChunk → drain finalize it.
      // This prevents premature OPFS_END when network reordering causes late chunk arrival.
      log.debug(`[Preload] END received but ${freshSession.progress}/${freshSession.total} — deferring OPFS_END`);
    }
  }

  // Cleanup reorder buffer only if finalized (otherwise chunks may still arrive)
  if (getState('preload.sessionState').get(sid)?.finalized) {
    preloadReorderBuffer.delete(sid);
  }

  log.debug(`[Preload] End: ${freshSession.name} (${freshSession.progress}/${freshSession.total} chunks)`);

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
      const idx = Number(data.index);
      if (preloadedIndexes.has(idx)) return; // Already marked
      // Immutable update: new Set → new peer → new array → setState
      const updatedSet = new Set(preloadedIndexes);
      updatedSet.add(idx);
      const updatedPeers = connectedPeers.map(x =>
        x.id === conn.peer ? { ...x, preloadedIndexes: updatedSet } : x,
      );
      setState('network.connectedPeers', updatedPeers);
      log.debug(`[Host] Marked index ${idx} as CACHED for peer ${p.label}`);
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
      bus.emit('ui:show-loader', true, t('transfer.download_finishing'));
    }
    setManagedTimer('preload-play-retry', () => {
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
  bus.emit('ui:show-loader', true, t('transfer.file_requesting'));

  const hostConn = getState('network.hostConn');
  const playlist = getState('playlist.items') || [];
  const trackName = name || playlist[index]?.name || '';

  if (hostConn?.open) {
    // Short jitter to avoid thundering herd, but not too long to cause stale track
    const jitter = Math.random() * 300 + 50;
    setManagedTimer('preload-recovery-jitter', () => {
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
    try {
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
          const updatedAckSent = new Set(ackSent);
          updatedAckSent.add(nextTrackIndex);
          setState('preload.ackSent', updatedAckSent);
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
    } catch (e) {
      log.error('[Preload] preload-file-ready handler failed:', e);
    }
  });

  // Handle preload-ready notification (emitted after PRELOAD_END)
  bus.on('storage:preload-ready', (index: number) => {
    log.debug(`[Preload] Preload ready for index: ${index}`);
    // This signals the preload chain is complete.
    // The actual file finalization is handled by opfs:file-ready → storage:preload-file-ready
  });

  // Clean up module-local variables when the session is left
  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      latestPreloadSessionId = 0;
      preloadReorderBuffer.clear();
      _activePlayPreloadedIndex = undefined;
      _preloadScope?.dispose();
      _preloadScope = null;
      _activePreloadUnicasts.forEach(s => s.dispose());
      _activePreloadUnicasts.clear();
    }
  });

  log.info('[Preload] Handlers registered');
}
