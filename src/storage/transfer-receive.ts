/**
 * MUSIXQUARE — File Transfer: Receive Side
 *
 * Handles FILE_PREPARE, FILE_START, FILE_RESUME, FILE_CHUNK, FILE_END,
 * FILE_WAIT. Manages chunk watchdog, reorder buffer, and early-chunk queue.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import {
  MSG,
  CHUNK_SIZE,
  TRANSFER_STATE,
  WATCHDOG_TIMEOUT,
  APP_STATE,
  DEMO_FILE_NAME,
  PLAYBACK_STATE,
  LOAD_SOURCE,
} from '../core/constants.ts';
import { validateSessionId } from '../core/session.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { postCommand, cleanupStoredFile } from './storage.ts';
import { t } from '../i18n/index.ts';
import {
  sendToHost,
  isRemoteGuest,
  waitForGuestConnectionType,
} from '../network/peer.ts';
import {
  cancelRemoteShareWait,
  prepareRemoteShareWait,
  shouldWaitForRemoteShare,
} from '../share/remote-share.ts';
import { isArrayBuffer } from './transfer-shared.ts';
import type { FileMeta, DataConnection } from '../types/index.ts';
import { showToast, showLoader, updateLoader } from '../ui/toast.ts';
import { transition } from '../player/lifecycle.ts';
import { isSystemAudioSessionActive } from '../player/video.ts';
import {
  getPendingPlayTime,
  setPendingPlayTime,
  getPendingPlayTimeSetAt,
  setPendingRecoveryTarget,
} from '../player/_state.ts';

// ─── Receive-side Module State ───────────────────────────────────────

const fileReorderBuffer = new Map<number, Map<number, Uint8Array>>();
let nextExpectedChunk = 0;
let lastChunkTime = 0;
let _demoFetchPromise: Promise<void> | null = null;
const _pendingEarlyChunks: Array<Record<string, unknown>> = [];

// ─── Skip-Incoming Derivation ────────────────────────────────────────
//
// Replaces the legacy `transfer.skipIncomingFile` flag (Phase 4 of the
// playback-state-machine migration). Computes the same boolean from
// primary state — lifecycle, appState, transfer.meta, files.currentFileBlob
// — instead of being mutated from 9 different modules. The flag-based
// version produced the bug class fixed in 61a1c2b: a sticky `true` from
// a prior preload-consume survived a rapid track switch and silently
// dropped every chunk for the new track until chunkWatchdog (12s)
// triggered recovery.
//
// Callers that have access to the incoming message's `name` should pass
// it so same-track replay can be detected.
function shouldSkipIncomingFile(incomingName?: string): boolean {
  // YouTube and system-audio modes own their own state paths;
  // lifecycle.ts::transition() is a no-op in either, so we can't rely on
  // lifecycle to gate file frames — appState must be checked directly.
  // System-audio is unlikely to receive stale FILE_* frames in practice
  // (host doesn't send while in that mode), but defense in depth: a
  // spoofed or out-of-order frame would otherwise fall through to the
  // (frozen) lifecycle check and possibly let chunks through.
  const appState = getState('appState');
  if (appState === APP_STATE.PLAYING_YOUTUBE) return true;
  if (isSystemAudioSessionActive()) return true;

  // Remote guests use encrypted remote-share instead of direct file chunks;
  // orchestrator gates isDataTarget=false so stale direct frames are dropped.
  if (isRemoteGuest()) return true;

  const lifecycle = getState('playback.lifecycle');

  // Waiting for preload blob (or demo HTTP fetch). The main-transfer
  // pipeline isn't the source — drop until lifecycle moves on
  // (PRELOAD_FILE_READY → DECODING, watchdog → DOWNLOADING fresh, etc.).
  if (lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD) return true;

  // Already promoted from a preload. Main-transfer chunks for this track
  // are stale — host's broadcastFile keeps streaming until its scope
  // disposes, and we don't want them re-overwriting the loaded blob.
  if (
    (lifecycle === PLAYBACK_STATE.DECODING ||
      lifecycle === PLAYBACK_STATE.READY ||
      lifecycle === PLAYBACK_STATE.PLAYING ||
      lifecycle === PLAYBACK_STATE.PAUSED) &&
    getState('playback.loadSource') === LOAD_SOURCE.PRELOAD_PROMOTED
  ) {
    return true;
  }

  // Same-track replay: host re-broadcasts on every playTrack() call,
  // including a re-click of the currently-loaded track. We already have
  // it — no work needed. Skip ONLY when we're in a passive state; when
  // lifecycle is DOWNLOADING or transfer.state is RECEIVING, a same-name
  // arrival is recovery-resend territory and the receive pipeline wants
  // those chunks (e.g. handleFileStart's "same-session recovery" branch).
  if (
    incomingName &&
    lifecycle !== PLAYBACK_STATE.DOWNLOADING &&
    getState('transfer.state') !== TRANSFER_STATE.RECEIVING
  ) {
    const blob = getState('files.currentFileBlob');
    const meta = getState('transfer.meta');
    if (blob && meta?.name === incomingName) return true;
  }

  return false;
}

function shouldAcceptLocalDirectFileStart(data: Record<string, unknown>): boolean {
  if (getState('network.connectionType') !== 'local') return false;
  if (getState('playback.lifecycle') !== PLAYBACK_STATE.AWAITING_PRELOAD) return false;

  const incomingName = typeof data.name === 'string' ? data.name : '';
  if (!incomingName) return false;

  const pendingTarget = getState('playback.pendingRecoveryTarget');
  const meta = getState('transfer.meta');
  const metaIndex = typeof meta?.index === 'number' ? meta.index : undefined;
  const incomingIndex = typeof data.index === 'number' ? data.index : undefined;
  const pendingIndex = pendingTarget?.index ?? metaIndex;

  const nameMatches = incomingName === pendingTarget?.name || incomingName === meta?.name;
  const indexMatches =
    incomingIndex === undefined || pendingIndex === undefined || incomingIndex === pendingIndex;

  return nameMatches && indexMatches;
}

function getLocalDirectFileIndex(data: Record<string, unknown>): number {
  if (typeof data.index === 'number') return data.index;

  const pendingIndex = getState('playback.pendingRecoveryTarget')?.index;
  if (typeof pendingIndex === 'number') return pendingIndex;

  const metaIndex = getState('transfer.meta')?.index;
  if (typeof metaIndex === 'number') return metaIndex;

  return Math.max(0, getState('playlist.currentTrackIndex'));
}

function switchRemoteWaitToLocalDirect(data: Record<string, unknown>): void {
  const incomingName = data.name as string;
  const incomingIndex = getLocalDirectFileIndex(data);

  cancelRemoteShareWait('local-direct-file-start');
  setState('preload.nextFileBlob', null);
  setState('preload.meta', null);
  setState('preload.nextTrackIndex', -1);
  setPendingRecoveryTarget(incomingIndex, incomingName);
  transition({
    type: 'FILE_PREPARE',
    variant: 'fresh',
    index: incomingIndex,
    name: incomingName,
  });
  log.info('[Transfer] Local direct file transfer superseded remote-share wait');
}

// ─── Chunk Watchdog ──────────────────────────────────────────────────

function getEffectiveWatchdogTimeout(): number {
  return getState('network.connectionType') === 'remote' ? 60000 : WATCHDOG_TIMEOUT;
}

function startChunkWatchdog(): void {
  clearManagedTimer('chunkWatchdog');
  lastChunkTime = Date.now();
  setState('transfer.lastReceivedCountSnapshot', getState('transfer.receivedCount'));

  setManagedTimer(
    'chunkWatchdog',
    () => {
      const timeout = getEffectiveWatchdogTimeout();
      const timeSinceLast = Date.now() - lastChunkTime;
      const receivedCount = getState('transfer.receivedCount');
      const lastSnapshot = getState('transfer.lastReceivedCountSnapshot');
      const isStuck = receivedCount === lastSnapshot && timeSinceLast > timeout;

      if (isStuck || timeSinceLast > timeout) {
        clearManagedTimer('chunkWatchdog');
        bus.emit('storage:request-recovery');
      }
      setState('transfer.lastReceivedCountSnapshot', receivedCount);
    },
    1000,
    { interval: true },
  );
}

// ─── Internal Helpers ────────────────────────────────────────────────

export async function fetchDemoFromServer(
  index: number,
  guardedPlayAt?: number,
  guardedPlaySetAt?: number,
): Promise<void> {
  // If connection type is unknown, wait before deciding to fetch from server.
  // This prevents local guests from hitting the HTTP demo path during bootstrap.
  if (isRemoteGuest() && getState('network.connectionType') === 'unknown') {
    const resolvedType = await waitForGuestConnectionType(2000);
    if (resolvedType === 'local') {
      log.debug('[Transfer] Resolved to local during demo fetch — aborting HTTP path');
      return;
    }
  }

  if (_demoFetchPromise) return _demoFetchPromise;

  _demoFetchPromise = _doFetchDemoFromServer(index, guardedPlayAt, guardedPlaySetAt);

  try {
    await _demoFetchPromise;
  } finally {
    _demoFetchPromise = null;
  }
}

async function _doFetchDemoFromServer(
  index: number,
  guardedPlayAt?: number,
  guardedPlaySetAt?: number,
): Promise<void> {
  const guardedPlaySetAtValue = guardedPlaySetAt ?? getPendingPlayTimeSetAt();
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
    setState('preload.meta', {
      name: DEMO_FILE_NAME,
      title: DEMO_FILE_NAME.replace(/\.[^/.]+$/, ''),
      index,
      size: file.size,
      mime: 'audio/mpeg',
    });
    showLoader(false);

    // Defensive: preserve pending play time if the HTTP fetch race cleared it
    if (guardedPlayAt !== undefined && getPendingPlayTime() === undefined) {
      setPendingPlayTime(guardedPlayAt, guardedPlaySetAtValue);
    }

    // THE BUG FIX: advance state machine past AWAITING_PRELOAD lock
    transition({ type: 'PRELOAD_FILE_READY', index });

    bus.emit('storage:use-preloaded', index, DEMO_FILE_NAME);
  } catch (e) {
    log.error('[Transfer] Demo server fetch failed:', e);
    // The translated string ends with ":" — append the error to avoid a
    // dangling colon in the toast (matches playlist.ts:987 usage).
    showToast(`${t('transfer.demo_load_fail')} ${(e as Error).message || ''}`.trim());
    showLoader(false);
    // Fallback: request from host. shouldSkipIncomingFile() will return false
    // once the host's FILE_PREPARE response transitions us out of
    // AWAITING_PRELOAD via the fresh-download path.
    sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name: DEMO_FILE_NAME, index });
  }
}

function showRemoteUnavailableUI(data: Record<string, unknown>): void {
  // (skip is derived: isRemoteGuest() returns true.)
  if (data.index !== undefined) {
    const idx = Number(data.index);
    const playlist = getState('playlist.items') || [];
    if (Number.isFinite(idx) && idx >= 0 && idx < playlist.length) {
      setState('playlist.currentTrackIndex', idx);
    }
  }
  setState('player.currentTrackMeta', {
    type: 'file',
    title: ((data.name as string) || '').replace(/\.[^/.]+$/, ''),
    name: (data.name as string) || '',
    videoId: null,
    playlistId: null,
  });
  showLoader(false);
  showToast(t('share.remote.unavailable'));
  log.info('[Transfer] Remote guest — file transfer skipped');
}

// ─── File Receive Handlers ───────────────────────────────────────────

/**
 * Reject broadcast frames not arriving via hostConn. FILE_* messages flow
 * host-to-guest only: the host triggers transfers from its own broadcastFile
 * and unicast pipelines, and guests only trust the authenticated host
 * connection for file state mutations.
 */
function isHostBroadcast(conn: DataConnection | undefined): boolean {
  const hostConn = getState('network.hostConn');
  return !!hostConn && conn === hostConn;
}

function replayLoadedSameFile(data: Record<string, unknown>): boolean {
  const currentFileBlob = getState('files.currentFileBlob');
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const currentTransferMeta = getState('transfer.meta');
  const requestedIndex = data.index as number | undefined;
  const requestedName = data.name as string | undefined;
  const replayName = requestedName || ((currentTransferMeta?.name as string | undefined) ?? '');
  const incomingSessionId = Number(data.sessionId);
  const loadedSessionId =
    Number(getState('transfer.localSessionId')) || Number(currentTransferMeta?.sessionId) || 0;
  const isSameTrackByIndex = requestedIndex !== undefined && requestedIndex === currentTrackIndex;
  const isSameTrackByName =
    requestedIndex === undefined && !!requestedName && currentTransferMeta?.name === requestedName;

  if (!currentFileBlob || (!isSameTrackByIndex && !isSameTrackByName)) return false;
  if (
    Number.isFinite(incomingSessionId) &&
    incomingSessionId > 0 &&
    loadedSessionId > 0 &&
    incomingSessionId > loadedSessionId
  ) {
    return false;
  }

  log.debug(
    `[file-prepare] Same file already loaded (repeat?), skipping re-download: ${requestedName}`,
  );
  transition({
    type: 'FILE_PREPARE',
    variant: 'same-file',
    index: requestedIndex as number,
    name: replayName,
  });
  showLoader(false);
  const delayMs = Number(data.autoPlayDelayMs) || 0;
  bus.emit('playback:replay-current', delayMs);
  return true;
}

export async function handleFilePrepare(
  data: Record<string, unknown>,
  conn?: DataConnection,
): Promise<void> {
  if (!isHostBroadcast(conn)) return;

  if (isSystemAudioSessionActive()) {
    log.debug('[Transfer] Ignoring FILE_PREPARE - system audio mode active');
    return;
  }

  // YouTube mode normally owns its own transport, but demo is a deliberate
  // cross-mode switch: remote guests fetch the bundled demo over HTTP after
  // FILE_PREPARE. Accept that one and tear YouTube down before driving the
  // file lifecycle.
  if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) {
    if (data.name !== DEMO_FILE_NAME) {
      log.debug('[Transfer] Ignoring FILE_PREPARE — YouTube mode active');
      return;
    }
    const pendingTime = getPendingPlayTime();
    const pendingSetAt = getPendingPlayTimeSetAt();
    log.debug('[Transfer] Accepting demo FILE_PREPARE during YouTube mode');
    bus.emit('player:stop-all-media');
    if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) {
      setState('appState', APP_STATE.IDLE);
    }
    if (pendingTime !== undefined) setPendingPlayTime(pendingTime, pendingSetAt);
  }

  // New track arriving — reset the per-track decode failure counter so the
  // 2-strikes give-up logic in finalizeGuestFile starts fresh. Without this,
  // a guest who failed twice on track A would still have count=2 carried
  // over and would prematurely give up on track B's first decode failure.
  setState('player.decodeFailureCount', 0);

  // Same-track replay needs to win before the remote-share branch. A remote
  // guest that already has the Blob should restart it locally, not enter
  // "waiting for encrypted remote file" for a descriptor the host will not
  // send on the replay fast path.
  if (replayLoadedSameFile(data)) return;

  // Remote guests (no local P2P path): demo → HTTP fetch from server,
  // other files → guide UI. Local guests always fall through to the
  // normal P2P receive path below (even for the demo), so the host's
  // broadcastFile has one coherent audience.
  if (isRemoteGuest()) {
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
        // Demo files go through a preload-like path (HTTP fetch +
        // storage:use-preloaded) so we enter AWAITING_PRELOAD —
        // shouldSkipIncomingFile() returns true automatically.
        transition({
          type: 'FILE_PREPARE',
          variant: 'demo',
          index: Number(data.index) || 0,
          name: data.name as string,
        });

        // Preserve pendingPlayTime before stopAllMedia clears it, since we
        // won't send a REQUEST_RETRANSMIT to get a fresh MSG.PLAY from the host.
        const pendingTime = getPendingPlayTime();
        const pendingSetAt = getPendingPlayTimeSetAt();
        bus.emit('player:stop-all-media');

        const demoIndex = Number(data.index);
        const safeDemoIndex = Number.isFinite(demoIndex) && demoIndex >= 0 ? demoIndex : 0;
        if (data.index !== undefined) {
          setState('playlist.currentTrackIndex', safeDemoIndex);
        }

        fetchDemoFromServer(safeDemoIndex, pendingTime, pendingSetAt);
        return;
      }
      if (shouldWaitForRemoteShare()) {
        const idx = Number(data.index);
        const safeIndex = Number.isFinite(idx) && idx >= 0 ? idx : 0;
        prepareRemoteShareWait(
          safeIndex,
          (data.name as string) || '',
          (data.sessionId as number) || getState('transfer.localSessionId') || 0,
        );
        return;
      }
      showRemoteUnavailableUI(data);
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
  // transfer.state must also be reset to IDLE so the stale-on-completed
  // guard in applyFileChunk doesn't filter out the new session's chunks
  // when the prior decode left state at READY/PROCESSING.
  if (isNewSession) {
    log.debug(
      `[file-prepare] New session: ${incomingSid} (prev: ${prevLocalSid}) — resetting receive pipeline`,
    );
    setState('transfer.localSessionId', incomingSid);
    setState('transfer.receivedCount', 0);
    setState('transfer.lastReceivedCountSnapshot', 0);
    fileReorderBuffer.clear();
    nextExpectedChunk = 0;
    setState('transfer.staleChunkBurstStart', 0);
    setState('transfer.staleChunkBurstCount', 0);
    setState('transfer.state', TRANSFER_STATE.IDLE);
    // Arm chunk watchdog from NOW so the 12s timer counts from FILE_PREPARE,
    // not from the last chunk of the previous (defunct) session.
    startChunkWatchdog();
  }

  // Check for preloaded match
  const preloadMeta = getState('preload.meta');
  const nextFileBlob = getState('preload.nextFileBlob');
  const hasPreloadedByIndex =
    preloadMeta && data.index !== undefined && data.index === preloadMeta.index;
  const hasPreloadedByName = preloadMeta && data.name && data.name === preloadMeta.name;

  // Preload INDEX MISMATCH: Don't use stale preload from a different track
  const isMismatch = preloadMeta && data.index !== undefined && data.index !== preloadMeta.index;
  if (isMismatch) {
    log.warn(
      `[file-prepare] Preload index mismatch! Request: ${data.index}, Preloaded: ${preloadMeta!.index}. Clearing stale preload.`,
    );
    clearManagedTimer('preloadWatchdog');
    // Clear stale preload state — also makes shouldSkipIncomingFile() false
    // for this incoming track (no preload sessionState/blob/meta to match).
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

    // FILE_PREPARE where blob already assembled → promote straight to DECODING
    // via the preload-promoted path. shouldSkipIncomingFile() returns true
    // automatically once lifecycle is DECODING with PRELOAD_PROMOTED loadSource.
    transition({
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      index: data.index as number,
      name: data.name as string,
    });
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
  const isSameTrackByName =
    data.index === undefined && data.name && currentTransferMeta?.name === data.name;
  const incomingSameFileSessionId = Number(data.sessionId);
  const loadedSameFileSessionId =
    Number(getState('transfer.localSessionId')) || Number(currentTransferMeta?.sessionId) || 0;
  const isNewerSameFileSession =
    Number.isFinite(incomingSameFileSessionId) &&
    incomingSameFileSessionId > 0 &&
    loadedSameFileSessionId > 0 &&
    incomingSameFileSessionId > loadedSameFileSessionId;
  if (currentFileBlob && (isSameTrackByIndex || isSameTrackByName) && !isNewerSameFileSession) {
    log.debug(
      `[file-prepare] Same file already loaded (repeat?), skipping re-download: ${data.name}`,
    );
    // Same file already loaded. No lifecycle change — replay-current fires
    // and the existing PLAYING/READY/PAUSED state keeps its audio buffer.
    // shouldSkipIncomingFile() returns true via the same-track-replay
    // branch (currentFileBlob + meta.name === data.name).
    transition({
      type: 'FILE_PREPARE',
      variant: 'same-file',
      index: data.index as number,
      name: data.name as string,
    });
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
  const preloadInProgressByIndex =
    preloadMeta && data.index !== undefined && data.index === preloadMeta.index;
  const preloadInProgressByName = preloadMeta && data.name && data.name === preloadMeta.name;
  const isPreloading = getState('preload.isPreloading');

  if (isPreloading && (preloadInProgressByIndex || preloadInProgressByName)) {
    // Resolve Deadlock: If Host started new Main Session (SID increased), prioritize it
    if (incomingSid > prevLocalSid) {
      log.debug(
        '[file-prepare] Preload in progress but Host started Main Session. Prioritizing Main.',
      );
      setState('preload.nextFileBlob', null);
      setState('preload.meta', null);
      setState('preload.nextTrackIndex', -1);
      // Continue to normal flow below
    } else {
      log.debug('[file-prepare] Preload in progress for this track, waiting...');
      // Preload still downloading for THIS track → AWAITING_PRELOAD. This
      // mirrors the PLAY_PRELOADED blob-waiting branch; both lead to the
      // same waiter semantics. shouldSkipIncomingFile() returns true once
      // lifecycle = AWAITING_PRELOAD.
      transition({
        type: 'FILE_PREPARE',
        variant: 'preload-waiting',
        index: data.index as number,
        name: data.name as string,
      });
      showLoader(true, t('transfer.preload_pending', { name: data.name as string }));

      setPendingRecoveryTarget(data.index as number | undefined, data.name as string | undefined);

      if (data.index !== undefined) {
        setState('playlist.currentTrackIndex', data.index as number);
      }

      // Mirror the fresh branch: surface the awaited track's title now so
      // the user sees it during the AWAITING_PRELOAD wait instead of after
      // the preload blob assembles.
      {
        const playlist = getState('playlist.items') || [];
        const trackEntry = playlist[data.index as number];
        if (trackEntry) {
          setState('player.currentTrackMeta', trackEntry);
        }
      }

      // Preload Watchdog: If preloading fails to complete, recover.
      // Use same connection-aware timeout as chunk watchdog (60s remote, 30s local).
      const preloadWatchdogMs = getState('network.connectionType') === 'remote' ? 60000 : 30000;
      setManagedTimer(
        'preloadWatchdog',
        () => {
          // Check lifecycle: if the state machine has moved on (to DECODING,
          // DOWNLOADING, etc.), the preload succeeded or was superseded and
          // we must not recover. The host's REQUEST_CURRENT_FILE response
          // will transition us out of AWAITING_PRELOAD via the fresh-download
          // path, breaking shouldSkipIncomingFile().
          if (getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD) {
            log.warn('[Guest] Preload wait timed out. Force recovering...');
            showLoader(false);

            sendToHost({
              type: MSG.REQUEST_CURRENT_FILE,
              name: data.name as string | undefined,
              index: data.index as number | undefined,
            });
          }
        },
        preloadWatchdogMs,
      );

      return; // Don't start new download
    }
  }

  // Normal flow: No preload available, prepare for download.
  // (No flag to clear — shouldSkipIncomingFile() returns false naturally
  //  once transition() below moves lifecycle to DOWNLOADING.)

  // Check if same file (resume scenario) — read BEFORE updating pending info
  const meta = getState('transfer.meta');
  const receivedCount = getState('transfer.receivedCount');
  const prevTarget = getState('playback.pendingRecoveryTarget');
  const isSameFile =
    meta?.name === data.name ||
    (prevTarget !== null && prevTarget.index === data.index);

  // Store pending file info (after reading old values above)
  setPendingRecoveryTarget(data.index as number | undefined, data.name as string | undefined);
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

    // Show the new track title immediately. Without this, finalizeGuestFile
    // is the first place player.currentTrackMeta gets set on the download
    // path, so the title in the UI stayed on the previous track until every
    // chunk arrived and decoded — feels broken on slow networks even though
    // the playlist entry was already known the moment FILE_PREPARE landed.
    {
      const playlist = getState('playlist.items') || [];
      const trackEntry = playlist[data.index as number];
      if (trackEntry) {
        setState('player.currentTrackMeta', trackEntry);
      }
    }

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
  setManagedTimer(
    'prepareWatchdog',
    () => {
      const transferState = getState('transfer.state');
      const rc = getState('transfer.receivedCount');
      if (transferState === TRANSFER_STATE.IDLE || rc === 0) {
        log.warn('[Prepare Watchdog] Timeout waiting for data start!');
        showToast(t('transfer.preparation_delayed'));

        const hostConn = getState('network.hostConn');
        if (hostConn && hostConn.open) {
          const jitter = Math.random() * 1000 + 200;
          setManagedTimer(
            'prepare-watchdog-jitter',
            () => {
              if (hostConn.open && !getState('files.currentFileBlob')) {
                bus.emit('storage:request-recovery');
              }
            },
            jitter,
          );
        }
      }
    },
    prepareTimeout,
  );

}

export function handleFileStart(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  const incomingSid = data.sessionId as number;
  const localSid = getState('transfer.localSessionId');

  if (!incomingSid || incomingSid < localSid) {
    log.warn(`[file-start] Stale session ignored. Current: ${localSid}, Received: ${incomingSid}`);
    return;
  }

  const isNewSession = incomingSid > localSid;
  if (isNewSession) {
    setState('transfer.localSessionId', incomingSid);
    postCommand({ command: 'STORAGE_RESET', isPreload: false });
    bus.emit('storage:clear-previous-track', 'new-session-start');
    _pendingEarlyChunks.length = 0; // Discard stale chunks from previous session
  }

  // Skip if using preloaded file; no direct receive pipeline is needed.
  // Downstream peers would begin expecting chunks that will never arrive
  // (since chunks are also skipped when shouldSkipIncomingFile() is true).
  // Exception: if this FILE_START is a recovery re-send (same file, same
  // session), the host explicitly wants us to receive data — fall through
  // and let the STORAGE_START + transfer.state=RECEIVING below break the
  // skip condition for subsequent chunks.
  if (shouldSkipIncomingFile(data.name as string | undefined)) {
    const meta = getState('transfer.meta');
    const isRecoveryResend = !isNewSession && meta?.name === data.name;
    const isLocalDirectStart = shouldAcceptLocalDirectFileStart(data);
    if (!isRecoveryResend && !isLocalDirectStart) {
      clearManagedTimer('prepareWatchdog');
      clearManagedTimer('chunkWatchdog');
      return;
    }
    if (isLocalDirectStart) {
      switchRemoteWaitToLocalDirect(data);
    } else {
      log.info('[file-start] Accepting same-session recovery resend');
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

  const currentTrackEntry = getState('files.currentTrack');
  if (currentTrackEntry.name && currentTrackEntry.name !== data.name) {
    cleanupStoredFile(currentTrackEntry.name, false);
  }
  setState('files.currentTrack', { name: (data.name as string) || null });

  // Always fresh start — host resends from chunk 0 on recovery,
  // so keepExisting is unnecessary and stale counters cause infinite loops.
  if (isRecoverySameFile && receivedCount > 0) {
    log.debug(`[file-start] Same file re-sent (recovery). Resetting from scratch.`);
  }

  postCommand({
    command: 'STORAGE_START',
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
    const matching = earlyChunks.filter((c) => (c.sessionId as number) === incomingSid);
    if (matching.length > 0) {
      log.debug(
        `[file-start] Replaying ${matching.length} early chunks (of ${earlyChunks.length} queued)`,
      );
      for (const pending of matching) {
        applyFileChunk(pending);
      }
    }
  }

  showLoader(true, t('transfer.receiving_0pct'));
}

export function handleFileResume(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  const incomingSid = data.sessionId as number;
  const localSid = getState('transfer.localSessionId');

  if (!incomingSid || incomingSid < localSid) return;
  if (shouldSkipIncomingFile(data.name as string | undefined)) {
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
  postCommand({
    command: 'STORAGE_START',
    filename: data.name as string,
    isPreload: false,
    sessionId: validateSessionId(incomingSid),
    size: CHUNK_SIZE,
    keepExisting: startChunk > 0, // preserve existing data on resume
  });

  setState('files.currentTrack', { name: data.name as string });

  nextExpectedChunk = startChunk;
  setState('transfer.meta', data as Partial<FileMeta>);
  setState('transfer.state', TRANSFER_STATE.RECEIVING);

  startChunkWatchdog();

  // 12-28: Drain any early chunks that arrived before resume was processed (same session only)
  if (_pendingEarlyChunks.length > 0) {
    const earlyChunks = _pendingEarlyChunks.splice(0);
    const matching = earlyChunks.filter((c) => (c.sessionId as number) === incomingSid);
    if (matching.length > 0) {
      log.debug(
        `[file-resume] Replaying ${matching.length} early chunks (of ${earlyChunks.length} queued)`,
      );
      for (const pending of matching) {
        applyFileChunk(pending);
      }
    }
  }

}

// Network entry for FILE_CHUNK. Gates the host-broadcast auth check, then
// delegates to applyFileChunk for the trusted internal-apply path. The split
// mirrors a6eadce → 2d3c5e5 (handleReverbTypeMsg / applyReverbType): the
// internal early-chunk replay sites in handleFileStart, handleFileResume, and
// applyFileChunk's own meta-recovery branch must call applyFileChunk directly
// — re-entering handleFileChunk would fail isHostBroadcast (the original conn
// is not preserved on _pendingEarlyChunks entries) and silently drop already-
// authenticated chunks.
export function handleFileChunk(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  applyFileChunk(data);
}

function applyFileChunk(data: Record<string, unknown>): void {
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
  if (shouldSkipIncomingFile(data.name as string | undefined)) {
    const localSid = getState('transfer.localSessionId');
    if (incomingSid > localSid) setState('transfer.localSessionId', incomingSid);
    return;
  }

  // Skip stale chunks that arrive after the transfer already completed.
  // This prevents broadcast chunks (whose FILE_START was skipped due to
  // preload) from re-showing the loader after finalizeGuestFile finishes.
  const transferState = getState('transfer.state');
  if (
    (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.PROCESSING) &&
    incomingSid <= getState('transfer.localSessionId')
  ) {
    return;
  }

  // Buffer early chunks that arrive before FILE_START sets up the session
  if (transferState === TRANSFER_STATE.IDLE && !fileReorderBuffer.has(incomingSid)) {
    _pendingEarlyChunks.push(data);
    // Overflow protection: drop oldest chunk from a DIFFERENT session first.
    // If all queued chunks are from the current session, drop the NEWEST
    // (pop, not shift) — losing chunk-0 would stall the reorder drain until
    // the chunk watchdog fires (~12s) and triggers recovery. Losing the
    // highest-index chunk is cheap: the host's live broadcast typically
    // re-sends it shortly after, and the reorder loop starts from chunk-0.
    if (_pendingEarlyChunks.length > 200) {
      const currentSid = (data as Record<string, unknown>).sessionId;
      const staleIdx = _pendingEarlyChunks.findIndex(
        (c) => (c as Record<string, unknown>).sessionId !== currentSid,
      );
      if (staleIdx >= 0) _pendingEarlyChunks.splice(staleIdx, 1);
      else _pendingEarlyChunks.pop();
    }
    return;
  }

  const localSid = getState('transfer.localSessionId');

  // Reset worker on new session detection
  if (incomingSid > localSid) {
    setState('transfer.localSessionId', incomingSid);
    postCommand({ command: 'STORAGE_RESET', isPreload: false });
    bus.emit('storage:clear-previous-track', 'session-change');
    fileReorderBuffer.clear();
    _pendingEarlyChunks.length = 0;
    nextExpectedChunk = 0;
    setState('transfer.receivedCount', 0);

    // Send STORAGE_START so worker accepts subsequent writes (prevents 12-60s recovery delay)
    const chunkName = (data.name as string) || '';
    if (chunkName) {
      postCommand({
        command: 'STORAGE_START',
        filename: chunkName,
        isPreload: false,
        sessionId: validateSessionId(incomingSid),
        size: CHUNK_SIZE,
      });
      setState('files.currentTrack', { name: chunkName });
      setState('transfer.state', TRANSFER_STATE.RECEIVING);
      if (data.total) {
        setState('transfer.meta', {
          name: chunkName,
          total: data.total as number,
          sessionId: incomingSid,
        } as Partial<FileMeta>);
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
        log.warn(
          `[file-chunk] Stale-session burst detected (${newCount} rejects over ${burstDuration}ms) — requesting early recovery`,
        );
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
  const expectedTotal = metaPeek?.total as number | undefined;
  if (typeof expectedTotal === 'number' && expectedTotal > 0 && chunkIndex >= expectedTotal) {
    log.warn(`[Transfer] Dropping chunk beyond total: ${chunkIndex} >= ${expectedTotal}`);
    return;
  }

  // 12-4 + 13-9: Guard against unbounded reorder buffer growth with recovery
  const MAX_REORDER_BUFFER = 500;
  if (sessionBuffer.size > MAX_REORDER_BUFFER) {
    log.warn(
      `[Transfer] Reorder buffer exceeded ${MAX_REORDER_BUFFER} entries — clearing and requesting recovery`,
    );
    sessionBuffer.clear();
    // Do NOT fast-forward nextExpectedChunk / receivedCount to chunkIndex.
    // Those positions weren't actually received — the buffered chunks were
    // beyond the current expected one because intermediate chunks never
    // arrived (host-side send race during rapid track changes). Marking
    // them as received forced recovery to resume from the wrong offset,
    // so the missing chunks were never re-sent and file-end reported a
    // permanent shortfall (e.g. 5118/5272), kicking off an infinite
    // recovery loop. Leaving the counters as-is lets recovery resume
    // from the real position and the missing chunks arrive in order.
    bus.emit('storage:request-recovery');
    return; // Don't fall through to re-add chunk with incorrect offset
  }

  const chunkData = new Uint8Array(data.chunk as ArrayBuffer);
  sessionBuffer.set(chunkIndex, chunkData);

  const meta = getState('transfer.meta');
  let currentTrackEntry = getState('files.currentTrack');
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
        setState('files.currentTrack', { name: fname });
        postCommand({
          command: 'STORAGE_START',
          filename: fname,
          isPreload: false,
          sessionId: validateSessionId(incomingSid),
          size: CHUNK_SIZE,
        });
      }
      // Reset chunk pointer for new file (mirrors handleFileStart/handleFileResume)
      nextExpectedChunk = 0;
      setState('transfer.receivedCount', 0);
      log.debug(`[FileChunk] Recovered meta from chunk: ${fname} (${recoveredMeta.total} chunks)`);

      // Drain early chunks that arrived before meta-recovery (mirrors FILE_START/RESUME paths)
      // Filter by session ID to avoid replaying stale chunks from a previous transfer
      if (_pendingEarlyChunks.length > 0) {
        const earlyChunks = _pendingEarlyChunks.splice(0);
        const sessionFiltered = earlyChunks.filter(
          (ec) => (ec.sessionId as number) === incomingSid,
        );
        log.debug(
          `[FileChunk] Replaying ${sessionFiltered.length}/${earlyChunks.length} early chunks after meta-recovery (session ${incomingSid})`,
        );
        for (const ec of sessionFiltered) {
          applyFileChunk(ec);
        }
      }

      // Re-read after meta-recovery updated state (prevents stale reference)
      currentTrackEntry = getState('files.currentTrack');
      receivedCount = getState('transfer.receivedCount');
    } else if (!meta || meta.total === undefined) {
      // Orphan chunk with no meta — can't process
      return;
    }
  }

  // Process all contiguous chunks in order
  while (sessionBuffer.has(nextExpectedChunk)) {
    const chunk = sessionBuffer.get(nextExpectedChunk)!;

    postCommand({
      command: 'STORAGE_WRITE',
      chunk: isArrayBuffer(chunk) ? chunk : ((chunk as Uint8Array).buffer as ArrayBuffer),
      index: nextExpectedChunk,
      isPreload: false,
      filename: currentTrackEntry.name || '',
      sessionId: validateSessionId(incomingSid),
    });

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
  if (
    total > 0 &&
    receivedCount >= total &&
    getState('transfer.state') !== TRANSFER_STATE.PROCESSING
  ) {
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

    // Finalize in storage
    postCommand({
      command: 'STORAGE_END',
      filename: (currentMeta?.name as string) || '',
      isPreload: false,
      sessionId: validateSessionId(incomingSid),
      totalSize: currentMeta?.size as number,
      total: currentMeta?.total as number,
    });

    clearManagedTimer('chunkWatchdog');
  }
}

export function handleFileEnd(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  if (shouldSkipIncomingFile(data.name as string | undefined)) return;

  // Ignore stale FILE_END from old sessions
  const incomingSid = data.sessionId as number;
  const localSid = getState('transfer.localSessionId');
  if (incomingSid && incomingSid < localSid) return;

  log.debug(`[file-end] Received end signal for: ${data.name}`);

  // Host has finished sending all chunks. If we still have gaps (a tail
  // chunk dropped while the rest arrived), don't wait for chunkWatchdog
  // (12s local / 60s remote) — request recovery now. handleFileChunk
  // already handles the in-progress finalize when receivedCount reaches
  // total, so this only fires when the gap is real.
  const transferState = getState('transfer.state');
  if (transferState === TRANSFER_STATE.RECEIVING) {
    const total = (getState('transfer.meta')?.total as number) || 0;
    const receivedCount = getState('transfer.receivedCount') || 0;
    if (total > 0 && receivedCount < total) {
      log.warn(`[file-end] ${receivedCount}/${total} chunks — triggering immediate recovery`);
      clearManagedTimer('chunkWatchdog');
      bus.emit('storage:request-recovery');
    }
  }
}

export function handleFileWait(_data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  log.debug('[Guest] FILE_WAIT received — host has no data ready yet');
  showToast(t('transfer.file_wait'));

  clearManagedTimer('fileWaitTimeout');
  setManagedTimer(
    'fileWaitTimeout',
    () => {
      const receivedCount = getState('transfer.receivedCount');
      if (receivedCount === 0) {
        if (isRemoteGuest()) {
          log.info('[file-wait timeout] Remote guest — remote share unavailable');
          const target = getState('playback.pendingRecoveryTarget');
          showRemoteUnavailableUI({
            index: getState('playlist.currentTrackIndex'),
            name: target?.name ?? '',
          });
          return;
        }

        // Request file from Host. setPendingRecoveryTarget() guarantees the
        // target is null OR a valid (index, name) pair, so optional-chain
        // returns either a non-negative index or undefined.
        const hostConn = getState('network.hostConn');
        if (hostConn && hostConn.open) {
          const target = getState('playback.pendingRecoveryTarget');
          const pendingFileName = target?.name ?? '';
          const recoveryIndex = target?.index ?? getState('playlist.currentTrackIndex');
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

          log.debug(
            `[file-wait timeout] Requesting from Host: ${pendingFileName} index: ${recoveryIndex}`,
          );
          sendToHost({
            type: MSG.REQUEST_DATA_RECOVERY,
            nextChunk: 0,
            fileName: pendingFileName,
            index: recoveryIndex,
          });
        }
      }
    },
    10000,
  );
}

// ─── Debug: Memory Stats ─────────────────────────────────────────────
//
// Exposes module-local main-transfer reorder buffer + pending-early queue
// footprint for `/debug memory`. Hot-path safe: only called from chat
// command handler.

export function getTransferMemoryStats(): {
  reorderSessions: number;
  reorderChunks: number;
  reorderBytes: number;
  pendingEarlyChunks: number;
  pendingEarlyBytes: number;
  nextExpectedChunk: number;
} {
  let chunks = 0;
  let bytes = 0;
  for (const sessionBuf of fileReorderBuffer.values()) {
    chunks += sessionBuf.size;
    for (const chunk of sessionBuf.values()) {
      bytes += chunk.byteLength;
    }
  }
  let earlyBytes = 0;
  for (const c of _pendingEarlyChunks) {
    const chunk = c.chunk;
    if (chunk instanceof Uint8Array) earlyBytes += chunk.byteLength;
    else if (chunk instanceof ArrayBuffer) earlyBytes += chunk.byteLength;
  }
  return {
    reorderSessions: fileReorderBuffer.size,
    reorderChunks: chunks,
    reorderBytes: bytes,
    pendingEarlyChunks: _pendingEarlyChunks.length,
    pendingEarlyBytes: earlyBytes,
    nextExpectedChunk,
  };
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
 * buffered chunks, resets transfer state, and tells the storage layer to
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

  postCommand({ command: 'STORAGE_RESET', isPreload: false });
  showLoader(false);
}
