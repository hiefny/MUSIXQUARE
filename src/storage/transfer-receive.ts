/**
 * MUSIXQUARE — File Transfer: Receive Side
 *
 * Handles FILE_PREPARE, FILE_START, FILE_RESUME, FILE_CHUNK, FILE_END,
 * FILE_WAIT. Manages chunk watchdog, reorder buffer, and early-chunk queue.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, TRANSFER_STATE, WATCHDOG_TIMEOUT, APP_STATE, DEMO_FILE_NAME, PLAYBACK_STATE } from '../core/constants.ts';
import { validateSessionId } from '../core/session.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { postWorkerCommand, cleanupOPFSInWorker } from './opfs.ts';
import { t } from '../i18n/index.ts';
import { safeSend, sendToHost, isRemoteGuest, hasActiveRelay, waitForGuestConnectionType } from '../network/peer.ts';
import { isArrayBuffer } from './transfer-shared.ts';
import type { FileMeta, AnyProtocolMsg } from '../types/index.ts';
import { showToast, showLoader, updateLoader } from '../ui/toast.ts';
import { transition } from '../player/lifecycle.ts';
import { getPendingPlayTime, setPendingPlayTime } from '../player/_state.ts';

// ─── Receive-side Module State ───────────────────────────────────────

const fileReorderBuffer = new Map<number, Map<number, Uint8Array>>();
let nextExpectedChunk = 0;
let lastChunkTime = 0;
const _pendingEarlyChunks: Array<Record<string, unknown>> = [];

// ─── Chunk Watchdog ──────────────────────────────────────────────────

function getEffectiveWatchdogTimeout(): number {
  return getState('network.connectionType') === 'remote' ? 60000 : WATCHDOG_TIMEOUT;
}

function startChunkWatchdog(): void {
  clearManagedTimer('chunkWatchdog');
  lastChunkTime = Date.now();
  setState('transfer.lastReceivedCountSnapshot', getState('transfer.receivedCount'));

  setManagedTimer('chunkWatchdog', () => {
    const timeout = getEffectiveWatchdogTimeout();
    const timeSinceLast = Date.now() - lastChunkTime;
    const receivedCount = getState('transfer.receivedCount');
    const lastSnapshot = getState('transfer.lastReceivedCountSnapshot');
    const isStuck = (receivedCount === lastSnapshot) && timeSinceLast > timeout;

    if (isStuck || timeSinceLast > timeout) {
      clearManagedTimer('chunkWatchdog');
      bus.emit('storage:request-recovery');
    }
    setState('transfer.lastReceivedCountSnapshot', receivedCount);
  }, 1000, { interval: true });
}

// ─── Internal Helpers ────────────────────────────────────────────────

export async function fetchDemoFromServer(index: number, guardedPlayAt?: number): Promise<void> {
  showLoader(true, t('transfer.demo_loading'));
  updateLoader(0);

  try {
    const blob: Blob = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', DEMO_FILE_NAME, true);
      xhr.responseType = 'blob';
      xhr.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          updateLoader(percent);
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as Blob);
        else reject(new Error(`HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Network Error'));
      xhr.timeout = 10000;
      xhr.ontimeout = () => {
        log.warn('[Transfer] Demo fetch timed out');
        reject(new Error('Request Timeout'));
      };
      xhr.send();
    });

    const file = new File([blob], DEMO_FILE_NAME, { type: 'audio/mpeg' });

    // Use the preload path for seamless playback
    setState('preload.nextFileBlob', file);
    setState('preload.meta', { name: DEMO_FILE_NAME, title: DEMO_FILE_NAME.replace(/\.[^/.]+$/, ''), index, size: file.size, mime: 'audio/mpeg' });
    showLoader(false);

    // Defensive: if the caller passed a play-at hint and nothing currently
    // holds a pendingPlayTime, restore it right before handing off to
    // loadPreloadedTrack. During the multi-second fetch window, stopAllMedia
    // or a superseding transition may have cleared pendingPlayTime, leaving
    // loadPreloadedTrack with nothing to seek to and therefore no play().
    if (guardedPlayAt !== undefined && getPendingPlayTime() === undefined) {
      setPendingPlayTime(guardedPlayAt);
    }
    bus.emit('storage:use-preloaded', index, DEMO_FILE_NAME);
  } catch (e) {
    log.error('[Transfer] Demo server fetch failed:', e);
    showToast(t('transfer.demo_load_fail'));
    showLoader(false);
    // Fallback: allow normal P2P transfer
    setState('transfer.skipIncomingFile', false);
    sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name: DEMO_FILE_NAME, index });
  }
}

function showRemoteGuideUI(data: Record<string, unknown>): void {
  setState('transfer.skipIncomingFile', true);
  if (data.index !== undefined) {
    const idx = Number(data.index);
    const playlist = getState('playlist.items') || [];
    if (Number.isFinite(idx) && idx >= 0 && idx < playlist.length) {
      setState('playlist.currentTrackIndex', idx);
    }
  }
  setState('player.currentTrackMeta', {
    type: 'file',
    title: t('toast.same_wifi_file_title'),
    name: (data.name as string) || '',
    videoId: null,
    playlistId: null,
  });
  showLoader(false);
  showToast(t('toast.same_wifi_only'));
  log.info('[Transfer] Remote guest — file transfer skipped');
}

// ─── File Receive Handlers ───────────────────────────────────────────

export async function handleFilePrepare(data: Record<string, unknown>): Promise<void> {
  // YouTube mode: ignore file transfers entirely — no file to receive
  if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) {
    log.debug('[Transfer] Ignoring FILE_PREPARE — YouTube mode active');
    return;
  }

  // Remote guests (no local P2P path): demo → HTTP fetch from server,
  // other files → guide UI. Local guests always fall through to the
  // normal P2P receive path below (even for the demo), so the host's
  // broadcastFile has one coherent audience.
  if (isRemoteGuest() && !hasActiveRelay()) {
    let confirmedRemote = true;
    const connType = getState('network.connectionType');
    if (connType === 'unknown') {
      log.info('[Transfer] connectionType unknown — waiting for ICE detection...');
      showLoader(true, t('transfer.check_conn_type'));
      const resolved = await waitForGuestConnectionType(3000);
      if (resolved === 'local') {
        log.info(`[Transfer] connectionType resolved: local — proceeding`);
        showLoader(false);
        confirmedRemote = false;
      }
    }

    if (confirmedRemote) {
      if (data.name === DEMO_FILE_NAME) {
        // Lifecycle (Phase 3 dual-write): demo files go through a preload-like
        // path (HTTP fetch + storage:use-preloaded) so we enter AWAITING_PRELOAD.
        transition({ type: 'FILE_PREPARE', variant: 'demo', index: Number(data.index) || 0, name: data.name as string });
        setState('transfer.skipIncomingFile', true);
        bus.emit('player:stop-all-media');
        const demoIndex = Number(data.index);
        const safeDemoIndex = Number.isFinite(demoIndex) && demoIndex >= 0 ? demoIndex : 0;
        if (data.index !== undefined) {
          setState('playlist.currentTrackIndex', safeDemoIndex);
        }
        fetchDemoFromServer(safeDemoIndex);
        return;
      }
      showRemoteGuideUI(data);
      return;
    }
  }

  // Phase 4: lifecycle is authoritative. If we were AWAITING_PRELOAD, the
  // transition() call later in this handler supersedes us correctly. The
  // legacy flag is still dual-written in other paths during migration, so
  // we defensively clear it if set (harmless once the flag is deleted in
  // Phase 4.3).
  if (getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD) {
    log.debug('[file-prepare] AWAITING_PRELOAD → will be superseded below');
  }
  clearManagedTimer('preloadWatchdog');
  setState('recovery.retryCount', 0);

  const incomingSid = data.sessionId as number;
  const prevLocalSid = getState('transfer.localSessionId');
  const isNewSession = incomingSid && incomingSid > prevLocalSid;

  // Update session if newer + hard-reset receive pipeline.
  //
  // Rapid track switch (e.g. 4→5→4→5) bug: without this reset, the old
  // session's receivedCount persists across the new FILE_PREPARE. That
  // leaves prepareWatchdog's `rc===0` condition unsatisfiable, and the
  // chunkWatchdog's `lastChunkTime` stays anchored to an old chunk from
  // the defunct session. Result: guest sits at "0%" until the 12s
  // chunkWatchdog eventually expires from absolute time drift.
  //
  // Fix: on every new-session FILE_PREPARE, wipe the receive state and
  // restart the chunkWatchdog from NOW so both safety nets are armed.
  if (isNewSession) {
    log.debug(`[file-prepare] New session: ${incomingSid} (prev: ${prevLocalSid}) — resetting receive pipeline`);
    setState('transfer.localSessionId', incomingSid);
    setState('transfer.receivedCount', 0);
    setState('transfer.lastReceivedCountSnapshot', 0);
    fileReorderBuffer.clear();
    nextExpectedChunk = 0;
    setState('transfer.staleChunkBurstStart', 0);
    setState('transfer.staleChunkBurstCount', 0);
    // Arm chunk watchdog from NOW so the 12s timer counts from FILE_PREPARE,
    // not from the last chunk of the previous (defunct) session.
    startChunkWatchdog();
  }

  // Check for preloaded match
  const preloadMeta = getState('preload.meta');
  const nextFileBlob = getState('preload.nextFileBlob');
  const hasPreloadedByIndex = preloadMeta && data.index !== undefined && data.index === preloadMeta.index;
  const hasPreloadedByName = preloadMeta && data.name && data.name === preloadMeta.name;

  // Preload INDEX MISMATCH: Don't use stale preload from a different track
  const isMismatch = preloadMeta && data.index !== undefined && data.index !== preloadMeta.index;
  if (isMismatch) {
    log.warn(`[file-prepare] Preload index mismatch! Request: ${data.index}, Preloaded: ${preloadMeta!.index}. Clearing stale preload.`);
    setState('transfer.skipIncomingFile', false);
    clearManagedTimer('preloadWatchdog');
    // Clear stale preload state
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
  }

  if (nextFileBlob && (hasPreloadedByIndex || hasPreloadedByName)) {
    log.debug('[Guest] Using preloaded track instead of re-downloading:', data.name);
    showToast(t('transfer.preload_done'));

    // Stop old media right before loading preloaded track (minimizes audio gap)
    bus.emit('player:stop-all-media');

    if (data.index !== undefined) {
      setState('playlist.currentTrackIndex', data.index as number);
    }

    // Lifecycle (Phase 3 dual-write): FILE_PREPARE where blob already assembled
    // → promote straight to DECODING via the preload-promoted path.
    transition({
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      index: data.index as number,
      name: data.name as string,
    });
    setState('transfer.skipIncomingFile', true);
    bus.emit('storage:use-preloaded', data.index as number, data.name as string);

    showLoader(false);
    return;
  }

  // Check if guest already has this file loaded (e.g. repeat-one mode)
  // Guard: only skip if guest actually has a file loaded (currentFileBlob !== null)
  const currentFileBlob = getState('files.currentFileBlob');
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const isSameTrackByIndex = data.index !== undefined && data.index === currentTrackIndex;
  const currentTransferMeta = getState('transfer.meta');
  const isSameTrackByName = data.name && currentTransferMeta?.name === data.name;
  if (currentFileBlob && (isSameTrackByIndex || isSameTrackByName)) {
    log.debug(`[file-prepare] Same file already loaded (repeat?), skipping re-download: ${data.name}`);
    // Lifecycle (Phase 3 dual-write): same file already loaded. No state
    // change — replay-current fires and the existing PLAYING/READY/PAUSED
    // state keeps its audio buffer.
    transition({
      type: 'FILE_PREPARE',
      variant: 'same-file',
      index: data.index as number,
      name: data.name as string,
    });
    setState('transfer.skipIncomingFile', true);
    showLoader(false);
    // Honor host's auto-play delay if provided — otherwise the guest would
    // play(0) immediately and drift for 3s while the host still waits on
    // its autoPlayTimer before broadcasting MSG.PLAY.
    const delayMs = Number(data.autoPlayDelayMs) || 0;
    bus.emit('playback:replay-current', delayMs);
    return;
  }

  // Not using preloaded track — stop current media
  bus.emit('player:stop-all-media');

  // Check if preload is IN PROGRESS for this track
  const preloadInProgressByIndex = preloadMeta && data.index !== undefined && data.index === preloadMeta.index;
  const preloadInProgressByName = preloadMeta && data.name && data.name === preloadMeta.name;
  const isPreloading = getState('preload.isPreloading');

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
      // Lifecycle (Phase 3 dual-write): preload still downloading for THIS
      // track → AWAITING_PRELOAD. This mirrors the PLAY_PRELOADED
      // blob-waiting branch; both lead to the same waiter semantics.
      transition({
        type: 'FILE_PREPARE',
        variant: 'preload-waiting',
        index: data.index as number,
        name: data.name as string,
      });
      showLoader(true, t('transfer.preload_pending', { name: data.name as string }));

      setState('recovery.pendingFileName', data.name as string || '');
      setState('recovery.pendingFileIndex', data.index as number);
      setState('transfer.skipIncomingFile', true);

      if (data.index !== undefined) {
        setState('playlist.currentTrackIndex', data.index as number);
      }

      // Preload Watchdog: If preloading fails to complete, recover.
      // Use same connection-aware timeout as chunk watchdog (60s remote, 30s local).
      const preloadWatchdogMs = getState('network.connectionType') === 'remote' ? 60000 : 30000;
      setManagedTimer('preloadWatchdog', () => {
        // Phase 4: check lifecycle instead of the legacy flag. If the state
        // machine has moved on (to DECODING, DOWNLOADING, etc.), the preload
        // succeeded or was superseded and we must not recover.
        if (getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD) {
          log.warn('[Guest] Preload wait timed out. Force recovering...');
          showLoader(false);
          setState('transfer.skipIncomingFile', false);

          sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name: data.name as string | undefined, index: data.index as number | undefined });
        }
      }, preloadWatchdogMs);

      return; // Don't start new download
    }
  }

  // Normal flow: No preload available, prepare for download
  setState('transfer.skipIncomingFile', false);

  // Check if same file (resume scenario) — read BEFORE updating pending info
  const meta = getState('transfer.meta');
  const receivedCount = getState('transfer.receivedCount');
  const pendingFileIndex = getState('recovery.pendingFileIndex');
  const isSameFile = (meta?.name === data.name) ||
    (pendingFileIndex !== undefined && pendingFileIndex === data.index);

  // Store pending file info (after reading old values above)
  setState('recovery.pendingFileName', data.name as string || '');
  setState('recovery.pendingFileIndex', data.index as number);
  const isResuming = isSameFile && receivedCount > 0;

  if (isResuming) {
    log.debug(`[file-prepare] Same file in progress (${receivedCount} chunks), skipping reset`);
    // Lifecycle (Phase 3 dual-write): resume scenario — we had partial data
    // for this file, now the host is restarting transfer. Stay in (or enter)
    // DOWNLOADING with the recovery-resume source.
    transition({
      type: 'FILE_PREPARE',
      variant: 'resume',
      index: data.index as number,
      name: data.name as string,
    });
    showLoader(true, t('transfer.waiting_recovery', { name: data.name as string }));
  } else {
    // Lifecycle (Phase 3 dual-write): fresh download — no preload match, no
    // resume. Transition to DOWNLOADING with fresh source.
    transition({
      type: 'FILE_PREPARE',
      variant: 'fresh',
      index: data.index as number,
      name: data.name as string,
    });
    bus.emit('storage:clear-previous-track', 'file-prepare');
    if (data.index !== undefined) {
      setState('playlist.currentTrackIndex', data.index as number);
    }
    // Update meta
    setState('transfer.meta', {
      ...meta,
      name: (data.name as string) || '',
      index: (data.index as number) ?? getState('playlist.currentTrackIndex'),
      size: (data.size as number) || 0,
      mime: (data.mime as string) || '',
      sessionId: (data.sessionId as number) || getState('transfer.localSessionId'),
    });

    // Stop YouTube mode for incoming local file
    const currentState = getState('appState');
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
      log.debug('[file-prepare] Stopping YouTube mode for incoming local file');
      bus.emit('youtube:stop-mode');
    }

    showLoader(true, t('transfer.preparing_name', { name: data.name as string }));
  }

  // Prepare watchdog with jitter recovery
  const prepareTimeout = getState('network.connectionType') === 'remote' ? 60000 : 15000;
  setManagedTimer('prepareWatchdog', () => {
    const transferState = getState('transfer.state');
    const rc = getState('transfer.receivedCount');
    if (transferState === TRANSFER_STATE.IDLE || rc === 0) {
      log.warn('[Prepare Watchdog] Timeout waiting for data start!');
      showToast(t('transfer.preparation_delayed'));

      const hostConn = getState('network.hostConn');
      if (hostConn && hostConn.open) {
        const jitter = Math.random() * 1000 + 200;
        setManagedTimer('prepare-watchdog-jitter', () => {
          if (hostConn.open && !getState('files.currentFileBlob')) {
            bus.emit('storage:request-recovery');
          }
        }, jitter);
      }
    }
  }, prepareTimeout);

  // Relay FILE_PREPARE to downstream peers (mirrors FILE_START/CHUNK/END relay).
  // Downstream peers need FILE_PREPARE to update their playlist index and metadata.
  if (!getState('transfer.skipIncomingFile')) {
    const downstreamPeers = getState('relay.downstreamDataPeers');
    downstreamPeers.forEach(p => { safeSend(p, data as AnyProtocolMsg); });
  }
}

export function handleFileStart(data: Record<string, unknown>): void {
  const incomingSid = data.sessionId as number;
  const localSid = getState('transfer.localSessionId');

  if (!incomingSid || incomingSid < localSid) {
    log.warn(`[file-start] Stale session ignored. Current: ${localSid}, Received: ${incomingSid}`);
    return;
  }

  const isNewSession = incomingSid > localSid;
  if (isNewSession) {
    setState('transfer.localSessionId', incomingSid);
    postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });
    bus.emit('storage:clear-previous-track', 'new-session-start');
    _pendingEarlyChunks.length = 0; // Discard stale chunks from previous session
    // New session always resets skipIncomingFile — a stale flag from a previous
    // preload/demo/same-file skip must not block the new session's file transfer.
    setState('transfer.skipIncomingFile', false);
  }

  // Skip if using preloaded file — do NOT relay FILE_START downstream.
  // Downstream peers would begin expecting chunks that will never arrive
  // (since chunks are also skipped when skipIncomingFile is true).
  // Exception: if this FILE_START is a recovery re-send (same file, same session),
  // the host explicitly wants us to receive data — clear the stale skip flag.
  if (getState('transfer.skipIncomingFile')) {
    const meta = getState('transfer.meta');
    const isRecoveryResend = !isNewSession && meta?.name === data.name;
    if (isRecoveryResend) {
      log.info('[file-start] Clearing stale skipIncomingFile for same-session recovery');
      setState('transfer.skipIncomingFile', false);
    } else {
      clearManagedTimer('prepareWatchdog');
      clearManagedTimer('chunkWatchdog');
      return;
    }
  }

  clearManagedTimer('prepareWatchdog');
  clearManagedTimer('chunkWatchdog');

  // Evict stale reorder buffer entries from previous sessions — prevents
  // memory accumulation when transfers are interrupted without cleanup.
  if (fileReorderBuffer.size > 1) {
    for (const key of fileReorderBuffer.keys()) {
      if (key !== incomingSid) fileReorderBuffer.delete(key);
    }
  }

  // Check if same file (recovery)
  const meta = getState('transfer.meta');
  const receivedCount = getState('transfer.receivedCount');
  const isRecoverySameFile = meta?.name === data.name && meta?.total === (data.total as number);

  const opfsFilename = getState('files.currentFileOpfs');
  if (opfsFilename.name && opfsFilename.name !== data.name) {
    cleanupOPFSInWorker(opfsFilename.name, false);
  }
  setState('files.currentFileOpfs', { name: (data.name as string) || null });

  // Always fresh start — host resends from chunk 0 on recovery,
  // so keepExisting is unnecessary and stale counters cause infinite loops.
  if (isRecoverySameFile && receivedCount > 0) {
    log.debug(`[file-start] Same file re-sent (recovery). Resetting from scratch.`);
  }

  postWorkerCommand({
    command: 'OPFS_START',
    filename: data.name as string,
    isPreload: false,
    sessionId: validateSessionId(incomingSid),
    size: CHUNK_SIZE,
  });

  setState('transfer.receivedCount', 0);
  setState('transfer.meta', data as Partial<FileMeta>);
  setState('transfer.state', TRANSFER_STATE.RECEIVING);
  // Reset stale-burst tracking — a valid FILE_START means we're back on track
  setState('transfer.staleChunkBurstStart', 0);
  setState('transfer.staleChunkBurstCount', 0);

  fileReorderBuffer.clear();
  nextExpectedChunk = 0;

  startChunkWatchdog();

  // Replay any early chunks that arrived before FILE_START (same session only)
  if (_pendingEarlyChunks.length > 0) {
    const earlyChunks = _pendingEarlyChunks.splice(0);
    const matching = earlyChunks.filter(c => (c.sessionId as number) === incomingSid);
    if (matching.length > 0) {
      log.debug(`[file-start] Replaying ${matching.length} early chunks (of ${earlyChunks.length} queued)`);
      for (const pending of matching) {
        handleFileChunk(pending);
      }
    }
  }

  // Relay header downstream
  const downstreamPeers = getState('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { safeSend(p, data as AnyProtocolMsg); });

  showLoader(true, t('transfer.receiving_0pct'));
}

export function handleFileResume(data: Record<string, unknown>): void {
  const incomingSid = data.sessionId as number;
  const localSid = getState('transfer.localSessionId');

  if (!incomingSid || incomingSid < localSid) return;
  if (getState('transfer.skipIncomingFile')) {
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    return;
  }
  if (incomingSid > localSid) {
    setState('transfer.localSessionId', incomingSid);
    _pendingEarlyChunks.length = 0; // Discard stale chunks from previous session
  }

  const startChunk = (data.startChunk as number) || 0;

  // 12-1: Reset receive state for clean resume
  // Set receivedCount to startChunk (not 0) because we already have those chunks.
  // Completion check is `receivedCount >= total`, so we must account for the offset.
  fileReorderBuffer.clear();
  setState('transfer.receivedCount', startChunk);

  clearManagedTimer('prepareWatchdog');
  setState('transfer.skipIncomingFile', false);
  postWorkerCommand({
    command: 'OPFS_START',
    filename: data.name as string,
    isPreload: false,
    sessionId: validateSessionId(incomingSid),
    size: CHUNK_SIZE,
    keepExisting: startChunk > 0, // preserve existing data on resume
  });

  setState('files.currentFileOpfs', { name: data.name as string });

  nextExpectedChunk = startChunk;
  setState('transfer.meta', data as Partial<FileMeta>);
  setState('transfer.state', TRANSFER_STATE.RECEIVING);

  startChunkWatchdog();

  // 12-28: Drain any early chunks that arrived before resume was processed (same session only)
  if (_pendingEarlyChunks.length > 0) {
    const earlyChunks = _pendingEarlyChunks.splice(0);
    const matching = earlyChunks.filter(c => (c.sessionId as number) === incomingSid);
    if (matching.length > 0) {
      log.debug(`[file-resume] Replaying ${matching.length} early chunks (of ${earlyChunks.length} queued)`);
      for (const pending of matching) {
        handleFileChunk(pending);
      }
    }
  }

  const downstreamPeers = getState('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { safeSend(p, data as AnyProtocolMsg); });
}

export function handleFileChunk(data: Record<string, unknown>): void {
  const incomingSid = data.sessionId as number;
  if (!incomingSid) return;

  // 13-8: Guard against undefined/null chunk → would create 0-byte Uint8Array
  if (data.chunk == null) {
    log.warn('[Transfer] Received null/undefined chunk, skipping');
    return;
  }

  // 12-23 + 13-10: Validate chunk data type (cross-realm safe ArrayBuffer check)
  if (!(data.chunk instanceof Uint8Array) && !isArrayBuffer(data.chunk)) {
    log.warn('[Transfer] Invalid chunk type received, ignoring');
    return;
  }

  // Skip if using preloaded file
  if (getState('transfer.skipIncomingFile')) {
    const localSid = getState('transfer.localSessionId');
    if (incomingSid > localSid) setState('transfer.localSessionId', incomingSid);
    return;
  }

  // Skip stale chunks that arrive after the transfer already completed.
  // This prevents broadcast chunks (whose FILE_START was skipped due to
  // preload) from re-showing the loader after finalizeGuestFile finishes.
  const transferState = getState('transfer.state');
  if ((transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.PROCESSING) &&
      incomingSid <= getState('transfer.localSessionId')) {
    return;
  }

  // Buffer early chunks that arrive before FILE_START sets up the session
  if (transferState === TRANSFER_STATE.IDLE && !fileReorderBuffer.has(incomingSid)) {
    _pendingEarlyChunks.push(data);
    // Overflow protection: drop oldest chunk from a DIFFERENT session first
    if (_pendingEarlyChunks.length > 200) {
      const currentSid = (data as Record<string, unknown>).sessionId;
      const staleIdx = _pendingEarlyChunks.findIndex(c => (c as Record<string, unknown>).sessionId !== currentSid);
      if (staleIdx >= 0) _pendingEarlyChunks.splice(staleIdx, 1);
      else _pendingEarlyChunks.shift();
    }
    return;
  }

  const localSid = getState('transfer.localSessionId');

  // Reset worker on new session detection
  if (incomingSid > localSid) {
    setState('transfer.localSessionId', incomingSid);
    postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });
    bus.emit('storage:clear-previous-track', 'session-change');
    fileReorderBuffer.clear();
    _pendingEarlyChunks.length = 0;
    nextExpectedChunk = 0;
    setState('transfer.receivedCount', 0);

    // Send OPFS_START so worker accepts subsequent writes (prevents 12-60s recovery delay)
    const chunkName = (data.name as string) || '';
    if (chunkName) {
      postWorkerCommand({
        command: 'OPFS_START',
        filename: chunkName,
        isPreload: false,
        sessionId: validateSessionId(incomingSid),
        size: CHUNK_SIZE,
      });
      setState('files.currentFileOpfs', { name: chunkName });
      setState('transfer.state', TRANSFER_STATE.RECEIVING);
      if (data.total) {
        setState('transfer.meta', { name: chunkName, total: data.total as number, sessionId: incomingSid } as Partial<FileMeta>);
      }
      startChunkWatchdog();
    }
  }

  if (incomingSid < localSid) {
    // Stale chunk from a superseded session. Usually harmless — but if the
    // host just flipped sessions rapidly (e.g. 4→5→4→5) and the new
    // session's chunks are stuck behind backpressure, the guest can sit
    // idle while stale chunks pile up. Detect the burst and short-circuit
    // the 12s chunkWatchdog by requesting recovery after 3s of stale flood.
    const now = Date.now();
    const burstStart = getState('transfer.staleChunkBurstStart');
    const burstCount = getState('transfer.staleChunkBurstCount');

    if (burstStart === 0 || now - burstStart > 5000) {
      // New burst window
      setState('transfer.staleChunkBurstStart', now);
      setState('transfer.staleChunkBurstCount', 1);
    } else {
      const newCount = burstCount + 1;
      setState('transfer.staleChunkBurstCount', newCount);

      // Threshold: 3s of stale-only traffic AND at least 20 rejections
      // (avoids tripping on a single straggler chunk)
      const burstDuration = now - burstStart;
      const rc = getState('transfer.receivedCount');
      if (burstDuration > 3000 && newCount >= 20 && rc === 0) {
        log.warn(`[file-chunk] Stale-session burst detected (${newCount} rejects over ${burstDuration}ms) — requesting early recovery`);
        setState('transfer.staleChunkBurstStart', 0);
        setState('transfer.staleChunkBurstCount', 0);
        clearManagedTimer('chunkWatchdog');
        bus.emit('storage:request-recovery');
      }
    }
    return;
  }

  // Valid chunk (session matches) — reset stale-burst tracking
  if (getState('transfer.staleChunkBurstStart') !== 0) {
    setState('transfer.staleChunkBurstStart', 0);
    setState('transfer.staleChunkBurstCount', 0);
  }

  if (!fileReorderBuffer.has(incomingSid)) {
    fileReorderBuffer.set(incomingSid, new Map());
    // Don't reset nextExpectedChunk here — handleFileStart (line 402) and
    // handleFileResume (line 449) already set it correctly for their flows.
    // Resetting to 0 here overwrites the resume's startChunk value.
  }

  const sessionBuffer = fileReorderBuffer.get(incomingSid)!;

  // Defense-in-depth chunk index bounds check. The protocol validator now
  // enforces isNonNegInt(index), but we repeat the guard here because the
  // index is ultimately keyed into a Map — any leak of a malformed value
  // (negative, NaN, Infinity, or beyond meta.total) would bloat memory or
  // stall the drain loop. If meta.total is known and index exceeds it,
  // drop the chunk; otherwise accept as usual.
  const chunkIndex = data.index as number;
  if (!Number.isFinite(chunkIndex) || chunkIndex < 0 || !Number.isInteger(chunkIndex)) {
    log.warn(`[Transfer] Dropping chunk with invalid index: ${chunkIndex}`);
    return;
  }
  const metaPeek = getState('transfer.meta');
  const expectedTotal = (metaPeek?.total as number | undefined);
  if (typeof expectedTotal === 'number' && expectedTotal > 0 && chunkIndex >= expectedTotal) {
    log.warn(`[Transfer] Dropping chunk beyond total: ${chunkIndex} >= ${expectedTotal}`);
    return;
  }

  // 12-4 + 13-9: Guard against unbounded reorder buffer growth with recovery
  const MAX_REORDER_BUFFER = 500;
  if (sessionBuffer.size > MAX_REORDER_BUFFER) {
    log.warn(`[Transfer] Reorder buffer exceeded ${MAX_REORDER_BUFFER} entries — clearing and requesting recovery`);
    sessionBuffer.clear();
    nextExpectedChunk = chunkIndex;
    setState('transfer.receivedCount', chunkIndex); // keep in sync
    bus.emit('storage:request-recovery');
    return; // Don't fall through to re-add chunk with incorrect offset
  }

  const chunkData = new Uint8Array(data.chunk as ArrayBuffer);
  sessionBuffer.set(chunkIndex, chunkData);

  const meta = getState('transfer.meta');
  let opfsFilename = getState('files.currentFileOpfs');
  let receivedCount = getState('transfer.receivedCount');

  // Meta-recovery: if we missed FILE_START, extract meta from chunk data
  if (!meta || meta.total === undefined || meta.total === 0) {
    if (data.total !== undefined && Number(data.total) > 0) {
      const recoveredMeta = {
        name: (data.name as string) || meta?.name || '',
        total: data.total as number,
        sessionId: incomingSid,
        size: (data.size as number) || 0,
        mime: (data.mime as string) || '',
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
      // Reset chunk pointer for new OPFS file (mirrors handleFileStart/handleFileResume)
      nextExpectedChunk = 0;
      setState('transfer.receivedCount', 0);
      log.debug(`[FileChunk] Recovered meta from chunk: ${fname} (${recoveredMeta.total} chunks)`);

      // Drain early chunks that arrived before meta-recovery (mirrors FILE_START/RESUME paths)
      // Filter by session ID to avoid replaying stale chunks from a previous transfer
      if (_pendingEarlyChunks.length > 0) {
        const earlyChunks = _pendingEarlyChunks.splice(0);
        const sessionFiltered = earlyChunks.filter(ec => (ec.sessionId as number) === incomingSid);
        log.debug(`[FileChunk] Replaying ${sessionFiltered.length}/${earlyChunks.length} early chunks after meta-recovery (session ${incomingSid})`);
        for (const ec of sessionFiltered) {
          handleFileChunk(ec);
        }
      }

      // Re-read after meta-recovery updated state (prevents stale reference)
      opfsFilename = getState('files.currentFileOpfs');
      receivedCount = getState('transfer.receivedCount');
    } else if (!meta || meta.total === undefined) {
      // Orphan chunk with no meta — can't process
      return;
    }
  }

  // Process all contiguous chunks in order
  while (sessionBuffer.has(nextExpectedChunk)) {
    const chunk = sessionBuffer.get(nextExpectedChunk)!;

    // Prepare relay copy before transfer to worker
    const downstreamPeers = getState('relay.downstreamDataPeers');
    let relayCopy: Uint8Array | null = null;
    if (downstreamPeers.length > 0) {
      relayCopy = new Uint8Array(chunk);
    }

    postWorkerCommand({
      command: 'OPFS_WRITE',
      chunk: isArrayBuffer(chunk) ? chunk : (chunk as Uint8Array).buffer as ArrayBuffer,
      index: nextExpectedChunk,
      isPreload: false,
      filename: opfsFilename.name || '',
      sessionId: validateSessionId(incomingSid),
    });

    // Relay to downstream (12-14: include total/name so downstream can recover meta)
    if (relayCopy && downstreamPeers.length > 0) {
      const currentMetaForRelay = getState('transfer.meta');
      const chunkMsg = {
        type: MSG.FILE_CHUNK,
        chunk: relayCopy,
        index: nextExpectedChunk,
        sessionId: incomingSid,
        total: currentMetaForRelay?.total ?? data.total,
        name: currentMetaForRelay?.name ?? data.name,
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

  // Reset recovery retry counter on meaningful progress — prevents cumulative
  // retryCount from permanently disabling recovery after partial successes.
  if (getState('recovery.retryCount') > 0) {
    setState('recovery.retryCount', 0);
  }

  // Progress update — re-read meta from state to avoid stale reference after recovery
  const currentMeta = getState('transfer.meta');
  const total = (currentMeta?.total as number) || 0;
  if (total > 0) {
    const percent = Math.min(100, Math.floor((receivedCount / total) * 100));
    bus.emit('storage:transfer-progress', percent, total);
  }

  // File complete check
  if (total > 0 && receivedCount >= total && getState('transfer.state') !== TRANSFER_STATE.PROCESSING) {
    setState('transfer.state', TRANSFER_STATE.PROCESSING);
    setState('recovery.retryCount', 0);

    // Clean up reorder buffer for this session to prevent memory leak
    fileReorderBuffer.delete(incomingSid);

    // Notify Host that we have this file (dedup via preload.ackSent)
    const processingIndex = currentMeta?.index as number;
    if (processingIndex !== undefined) {
      const ackSent = getState('preload.ackSent');
      if (!ackSent.has(processingIndex)) {
        const updatedAckSent = new Set(ackSent);
        updatedAckSent.add(processingIndex);
        setState('preload.ackSent', updatedAckSent);
        sendToHost({ type: MSG.PRELOAD_ACK, index: processingIndex });
      }
    }

    // Finalize in OPFS
    postWorkerCommand({
      command: 'OPFS_END',
      filename: (currentMeta?.name as string) || '',
      isPreload: false,
      sessionId: validateSessionId(incomingSid),
      totalSize: currentMeta?.size as number,
    });

    clearManagedTimer('chunkWatchdog');
  }
}

export function handleFileEnd(data: Record<string, unknown>): void {
  if (getState('transfer.skipIncomingFile')) return;

  // Ignore stale FILE_END from old sessions
  const incomingSid = data.sessionId as number;
  const localSid = getState('transfer.localSessionId');
  if (incomingSid && incomingSid < localSid) return;

  // Relay to downstream
  const downstreamPeers = getState('relay.downstreamDataPeers');
  downstreamPeers.forEach(p => { safeSend(p, data as AnyProtocolMsg); });

  log.debug(`[file-end] Received end signal for: ${data.name}`);
}

export function handleFileWait(): void {
  log.debug('[Guest] Relay has no data yet, waiting for forwarded data...');
  showToast(t('transfer.relay_wait'));

  clearManagedTimer('relayWaitTimeout');
  setManagedTimer('relayWaitTimeout', () => {
    const receivedCount = getState('transfer.receivedCount');
    if (receivedCount === 0) {
      log.debug('[Guest] Relay wait timeout - falling back to Host');

      // Disconnect from relay upstream
      const upstreamDataConn = getState('relay.upstreamDataConn');
      if (upstreamDataConn) {
        upstreamDataConn.close();
        setState('relay.upstreamDataConn', null);
      }

      // Remote guest with no relay: show WiFi guidance instead of futile host request
      if (isRemoteGuest() && !hasActiveRelay()) {
        log.info('[file-wait timeout] Remote guest — showing WiFi guidance');
        showRemoteGuideUI({
          index: getState('playlist.currentTrackIndex'),
          name: getState('recovery.pendingFileName') || '',
        });
        return;
      }

      showToast(t('transfer.relay_no_response'));

      // Request file from Host
      const hostConn = getState('network.hostConn');
      if (hostConn && hostConn.open) {
        const pendingFileName = getState('recovery.pendingFileName') || '';
        const pendingFileIndex = getState('recovery.pendingFileIndex');
        const currentTrackIndex = getState('playlist.currentTrackIndex');
        const recoveryIndex = pendingFileIndex !== undefined ? pendingFileIndex : currentTrackIndex;
        const playlist = getState('playlist.items') || [];

        // Validation: Don't send recovery with invalid index
        if (recoveryIndex < 0 || recoveryIndex >= playlist.length) {
          log.warn('[file-wait timeout] Invalid index, skipping recovery:', recoveryIndex);
          showLoader(false);
          return;
        }

        // Check if preload is in progress for this track
        const preloadMeta = getState('preload.meta');
        if (preloadMeta && preloadMeta.index === recoveryIndex) {
          log.debug('[file-wait timeout] Preload in progress for this track, waiting...');
          showToast(t('transfer.preload_waiting'));
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

// ─── Session Cleanup (exported for initTransfer) ─────────────────────

export function clearReceiveState(): void {
  fileReorderBuffer.clear();
  _pendingEarlyChunks.length = 0;
  nextExpectedChunk = 0;
  setState('transfer.staleChunkBurstStart', 0);
  setState('transfer.staleChunkBurstCount', 0);
}

// ─── Cancel In-Flight Incoming Transfer (guest-only) ─────────────────

/**
 * Abort an in-flight main download on the guest side.
 * Called when the host signals the playlist has been emptied — drops
 * buffered chunks, resets transfer state, and tells the OPFS worker to
 * discard the partially written file.
 */
export function cancelIncomingFileTransfer(reason: string): void {
  const state = getState('transfer.state');
  if (state !== TRANSFER_STATE.RECEIVING) return;

  log.info(`[Transfer] Cancelling incoming transfer: ${reason}`);

  clearManagedTimer('chunkWatchdog');
  clearManagedTimer('prepareWatchdog');

  fileReorderBuffer.clear();
  _pendingEarlyChunks.length = 0;
  nextExpectedChunk = 0;

  setState('transfer.state', TRANSFER_STATE.IDLE);
  setState('transfer.receivedCount', 0);
  setState('transfer.meta', {});

  postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });
  showLoader(false);
}
