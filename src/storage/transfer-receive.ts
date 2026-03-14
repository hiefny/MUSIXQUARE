/**
 * MUSIXQUARE 3.0 — File Transfer: Receive Side
 *
 * Handles FILE_PREPARE, FILE_START, FILE_RESUME, FILE_CHUNK, FILE_END,
 * FILE_WAIT. Manages chunk watchdog, reorder buffer, and early-chunk queue.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, TRANSFER_STATE, WATCHDOG_TIMEOUT, APP_STATE, DEMO_FILE_NAME, DEMO_TITLE } from '../core/constants.ts';
import { validateSessionId } from '../core/session.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { postWorkerCommand, cleanupOPFSInWorker } from './opfs.ts';
import { t } from '../i18n/index.ts';
import { safeSend, sendToHost, isRemoteGuest, hasActiveRelay, waitForGuestConnectionType } from '../network/peer.ts';
import { isArrayBuffer } from './transfer-shared.ts';
import type { FileMeta, AnyProtocolMsg } from '../types/index.ts';

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

async function fetchDemoFromServer(index: number): Promise<void> {
  bus.emit('ui:show-loader', true, t('transfer.demo_loading'));
  bus.emit('ui:update-loader', 0);

  try {
    const blob: Blob = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', DEMO_FILE_NAME, true);
      xhr.responseType = 'blob';
      xhr.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          bus.emit('ui:update-loader', percent);
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
    setState('preload.meta', { name: DEMO_FILE_NAME, title: DEMO_TITLE, index, size: file.size, mime: 'audio/mpeg' });
    bus.emit('ui:show-loader', false);
    bus.emit('storage:use-preloaded', index, DEMO_FILE_NAME);
  } catch (e) {
    log.error('[Transfer] Demo server fetch failed:', e);
    bus.emit('ui:show-toast', t('transfer.demo_load_fail'));
    bus.emit('ui:show-loader', false);
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
      bus.emit('ui:update-playlist');
    }
  }
  bus.emit('player:metadata-update', {
    type: 'file',
    title: t('toast.same_wifi_file_title'),
    name: (data.name as string) || '',
    videoId: null,
    playlistId: null,
  });
  bus.emit('ui:show-loader', false);
  bus.emit('ui:show-toast', t('toast.same_wifi_only'));
  log.info('[Transfer] Remote guest — file transfer skipped');
}

// ─── File Receive Handlers ───────────────────────────────────────────

export async function handleFilePrepare(data: Record<string, unknown>): Promise<void> {
  // Demo track: fetch directly from server instead of P2P transfer
  if (data.name === DEMO_FILE_NAME) {
    setState('transfer.skipIncomingFile', true);
    bus.emit('player:stop-all-media');
    const demoIndex = Number(data.index);
    const safeDemoIndex = Number.isFinite(demoIndex) && demoIndex >= 0 ? demoIndex : 0;
    if (data.index !== undefined) {
      setState('playlist.currentTrackIndex', safeDemoIndex);
      bus.emit('ui:update-playlist');
    }
    fetchDemoFromServer(safeDemoIndex);
    return;
  }

  // Remote guests: block file transfer unless relay is active
  if (isRemoteGuest() && !hasActiveRelay()) {
    const connType = getState('network.connectionType');
    if (connType === 'unknown') {
      log.info('[Transfer] connectionType unknown — waiting for ICE detection...');
      bus.emit('ui:show-loader', true, t('transfer.check_conn_type'));
      const resolved = await waitForGuestConnectionType(3000);
      if (resolved === 'local') {
        log.info(`[Transfer] connectionType resolved: local — proceeding`);
        bus.emit('ui:show-loader', false);
        // Fall through to normal handling below
      } else {
        showRemoteGuideUI(data);
        return;
      }
    } else {
      showRemoteGuideUI(data);
      return;
    }
  }

  // Always clear stuck preload waiting state on new file-prepare
  if (getState('transfer.waitingForPreload')) {
    log.debug('[file-prepare] Clearing stale waitingForPreload flag');
    setState('transfer.waitingForPreload', false);
  }
  clearManagedTimer('preloadWatchdog');
  setState('recovery.retryCount', 0);

  const incomingSid = data.sessionId as number;
  const prevLocalSid = getState('transfer.localSessionId');

  // Update session if newer
  if (incomingSid && incomingSid > prevLocalSid) {
    log.debug(`[file-prepare] New session: ${incomingSid} (prev: ${prevLocalSid})`);
    setState('transfer.localSessionId', incomingSid);
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
    bus.emit('ui:show-toast', t('transfer.preload_done'));

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

  // Check if guest already has this file loaded (e.g. repeat-one mode)
  // Guard: only skip if guest actually has a file loaded (currentFileBlob !== null)
  const currentFileBlob = getState('files.currentFileBlob');
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const isSameTrackByIndex = data.index !== undefined && data.index === currentTrackIndex;
  const currentTransferMeta = getState('transfer.meta');
  const isSameTrackByName = data.name && currentTransferMeta?.name === data.name;
  if (currentFileBlob && (isSameTrackByIndex || isSameTrackByName)) {
    log.debug(`[file-prepare] Same file already loaded (repeat?), skipping re-download: ${data.name}`);
    setState('transfer.skipIncomingFile', true);
    bus.emit('ui:show-loader', false);
    bus.emit('playback:replay-current');
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
      bus.emit('ui:show-loader', true, t('transfer.preload_pending', { name: data.name as string }));

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
        if (getState('transfer.waitingForPreload')) {
          log.warn('[Guest] Preload wait timed out. Force recovering...');
          setState('transfer.waitingForPreload', false);
          bus.emit('ui:show-loader', false);
          setState('transfer.skipIncomingFile', false);

          sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name: data.name as string | undefined, index: data.index as number | undefined });
        }
      }, 10000);

      return; // Don't start new download
    }
  }

  // Normal flow: No preload available, prepare for download
  setState('transfer.skipIncomingFile', false);
  setState('transfer.waitingForPreload', false);

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
    bus.emit('ui:show-loader', true, t('transfer.waiting_recovery', { name: data.name as string }));
  } else {
    bus.emit('storage:clear-previous-track', 'file-prepare');
    if (data.index !== undefined) {
      setState('playlist.currentTrackIndex', data.index as number);
      bus.emit('ui:update-playlist');
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

    bus.emit('ui:show-loader', true, t('transfer.preparing_name', { name: data.name as string }));
  }

  // Prepare watchdog with jitter recovery
  const prepareTimeout = getState('network.connectionType') === 'remote' ? 60000 : 15000;
  setManagedTimer('prepareWatchdog', () => {
    const transferState = getState('transfer.state');
    const rc = getState('transfer.receivedCount');
    if (transferState === TRANSFER_STATE.IDLE || rc === 0) {
      log.warn('[Prepare Watchdog] Timeout waiting for data start!');
      bus.emit('ui:show-toast', t('transfer.preparation_delayed'));

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
  }

  // Skip if using preloaded file — do NOT relay FILE_START downstream.
  // Downstream peers would begin expecting chunks that will never arrive
  // (since chunks are also skipped when skipIncomingFile is true).
  if (getState('transfer.skipIncomingFile')) {
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    return;
  }

  clearManagedTimer('prepareWatchdog');
  clearManagedTimer('chunkWatchdog');

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

  bus.emit('ui:show-loader', true, t('transfer.receiving_0pct'));
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
    if (_pendingEarlyChunks.length > 200) _pendingEarlyChunks.shift(); // overflow protection
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

  if (incomingSid < localSid) return;

  if (!fileReorderBuffer.has(incomingSid)) {
    fileReorderBuffer.set(incomingSid, new Map());
    // Don't reset nextExpectedChunk here — handleFileStart (line 402) and
    // handleFileResume (line 449) already set it correctly for their flows.
    // Resetting to 0 here overwrites the resume's startChunk value.
  }

  const sessionBuffer = fileReorderBuffer.get(incomingSid)!;

  // 12-4 + 13-9: Guard against unbounded reorder buffer growth with recovery
  const MAX_REORDER_BUFFER = 500;
  if (sessionBuffer.size > MAX_REORDER_BUFFER) {
    log.warn(`[Transfer] Reorder buffer exceeded ${MAX_REORDER_BUFFER} entries — clearing and requesting recovery`);
    sessionBuffer.clear();
    const overflowIdx = data.index as number;
    nextExpectedChunk = overflowIdx;
    setState('transfer.receivedCount', overflowIdx); // keep in sync
    bus.emit('storage:request-recovery');
    return; // Don't fall through to re-add chunk with incorrect offset
  }

  const chunkData = new Uint8Array(data.chunk as ArrayBuffer);
  sessionBuffer.set(data.index as number, chunkData);

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
  bus.emit('ui:show-toast', t('transfer.relay_wait'));

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

      bus.emit('ui:show-toast', t('transfer.relay_no_response'));

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
          bus.emit('ui:show-loader', false);
          return;
        }

        // Check if preload is in progress for this track
        const preloadMeta = getState('preload.meta');
        if (preloadMeta && preloadMeta.index === recoveryIndex) {
          log.debug('[file-wait timeout] Preload in progress for this track, waiting...');
          bus.emit('ui:show-toast', t('transfer.preload_waiting'));
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
}
