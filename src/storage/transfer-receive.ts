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
  PLAYBACK_STATE,
  LOAD_SOURCE,
} from '../core/constants.ts';
import { nextSessionId, validateSessionId } from '../core/session.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { admitIncomingStoredFile, postCommand, cleanupStoredFile } from './storage.ts';
import { ramContiguousCount, ramReadBlob } from './ramstore.ts';
import { t } from '../i18n/index.ts';
import { sendToHost, isRemoteGuest, waitForGuestConnectionType } from '../network/peer.ts';
import {
  cancelRemoteShareWait,
  prepareRemoteShareWait,
  shouldWaitForRemoteShare,
} from '../share/remote-share.ts';
import { isArrayBuffer } from './transfer-shared.ts';
import type { FileMeta, DataConnection } from '../types/index.ts';
import { showToast, showLoader, updateLoader } from '../ui/toast.ts';
import { transition } from '../player/lifecycle.ts';
import {
  createFileTrackMeta,
  isExternalOwner,
  isSystemAudioOwner,
  isYouTubeOwner,
  setPlaybackIdle,
  setPlaybackTransferState,
  setPlaybackTrackMeta,
} from '../player/ownership.ts';
import {
  getPendingPlayTime,
  setPendingPlayTime,
  getPendingPlayTimeSetAt,
  currentAudioBufferPcmBytes,
  liveAudioBufferPcmBytes,
  setPendingRecoveryTarget,
} from '../player/_state.ts';
import { resolveDecodeMemoryBudget } from '../player/decode-admission.ts';
import { createDemoTrackMeta, getDemoTrackForPlayback, isDemoTrackName } from '../demo/tracks.ts';

// ─── Receive-side Module State ───────────────────────────────────────

const fileReorderBuffer = new Map<number, Map<number, Uint8Array>>();
let nextExpectedChunk = 0;
let lastChunkTime = 0;
let _demoFetchPromise: { key: string; promise: Promise<void> } | null = null;
const _pendingEarlyChunks: Array<Record<string, unknown>> = [];
let rejectedMainSessionId = 0;
const MAX_FILE_TOTAL = 200_000;
const MAX_EARLY_MAIN_SESSIONS = 4;
const MAX_EARLY_MAIN_CHUNKS = 64;
const MAX_EARLY_MAIN_BYTES = 4 * 1024 * 1024;

function incomingChunkByteLength(data: Record<string, unknown>): number {
  const chunk = data.chunk;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return 0;
}

function bufferEarlyMainChunk(data: Record<string, unknown>): void {
  const sessionId = data.sessionId as number;
  const chunkIndex = data.index as number;
  const existingIndex = _pendingEarlyChunks.findIndex(
    (entry) => entry.sessionId === sessionId && entry.index === chunkIndex,
  );
  if (existingIndex >= 0) _pendingEarlyChunks.splice(existingIndex, 1);

  const sessionIds = [...new Set(_pendingEarlyChunks.map((entry) => entry.sessionId as number))];
  if (!sessionIds.includes(sessionId) && sessionIds.length >= MAX_EARLY_MAIN_SESSIONS) {
    const evictedSid = sessionIds[0];
    for (let i = _pendingEarlyChunks.length - 1; i >= 0; i--) {
      if (_pendingEarlyChunks[i]?.sessionId === evictedSid) _pendingEarlyChunks.splice(i, 1);
    }
    log.warn(`[Transfer] Early buffer evicted stale session ${evictedSid}`);
  }

  _pendingEarlyChunks.push(data);
  const totalBytes = (): number =>
    _pendingEarlyChunks.reduce((sum, entry) => sum + incomingChunkByteLength(entry), 0);
  while (
    _pendingEarlyChunks.length > MAX_EARLY_MAIN_CHUNKS ||
    totalBytes() > MAX_EARLY_MAIN_BYTES
  ) {
    const oldestStaleSid = _pendingEarlyChunks.find(
      (entry) => entry.sessionId !== sessionId,
    )?.sessionId;
    if (oldestStaleSid !== undefined) {
      for (let i = _pendingEarlyChunks.length - 1; i >= 0; i--) {
        if (_pendingEarlyChunks[i]?.sessionId === oldestStaleSid) {
          _pendingEarlyChunks.splice(i, 1);
        }
      }
      continue;
    }

    // Only the newest session remains. Preserve its lowest indexes so
    // recovery retains the longest possible contiguous prefix.
    let dropIndex = -1;
    let highestChunkIndex = -1;
    for (let i = 0; i < _pendingEarlyChunks.length; i++) {
      const entry = _pendingEarlyChunks[i]!;
      if (entry.sessionId === sessionId && Number(entry.index) >= highestChunkIndex) {
        highestChunkIndex = Number(entry.index);
        dropIndex = i;
      }
    }
    if (dropIndex < 0) dropIndex = _pendingEarlyChunks.length - 1;
    _pendingEarlyChunks.splice(dropIndex, 1);
  }
}

function discardPendingEarlySessionsExcept(sessionId: number): void {
  for (let i = _pendingEarlyChunks.length - 1; i >= 0; i--) {
    if (_pendingEarlyChunks[i]?.sessionId !== sessionId) _pendingEarlyChunks.splice(i, 1);
  }
}

function retainedPcmBytesForReceive(): number {
  return resolveDecodeMemoryBudget().tier === 'ios'
    ? liveAudioBufferPcmBytes()
    : currentAudioBufferPcmBytes();
}

function hasSafeIncomingFileSize(data: Record<string, unknown>): boolean {
  const size = data.size;
  const total = data.total;
  return (
    Number.isSafeInteger(size) &&
    (size as number) > 0 &&
    Number.isSafeInteger(total) &&
    (total as number) > 0 &&
    (total as number) <= MAX_FILE_TOTAL &&
    (total as number) === Math.ceil((size as number) / CHUNK_SIZE)
  );
}

function tryAdmitMainReceive(
  data: Record<string, unknown>,
  authoritativeTrackIndex?: number,
): boolean {
  const sessionId = data.sessionId;
  const filename = data.name;
  if (
    !Number.isSafeInteger(sessionId) ||
    (sessionId as number) <= 0 ||
    typeof filename !== 'string' ||
    !filename ||
    !hasSafeIncomingFileSize(data)
  ) {
    log.warn('[Transfer] Refusing receive without an exact encoded-size contract', data);
    return false;
  }

  try {
    admitIncomingStoredFile({
      filename,
      isPreload: false,
      sessionId: sessionId as number,
      totalSize: data.size as number,
      retainedPcmBytes: retainedPcmBytesForReceive(),
    });
    if (rejectedMainSessionId === sessionId) rejectedMainSessionId = 0;
    return true;
  } catch (error) {
    rejectedMainSessionId = sessionId as number;
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[Transfer] RAM admission rejected session ${sessionId}: ${message}`);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('fileWaitTimeout');
    fileReorderBuffer.clear();
    _pendingEarlyChunks.length = 0;
    nextExpectedChunk = 0;
    setState('transfer.receivedCount', 0);
    bus.emit('player:stop-all-media', { cancelInFlight: true, clearBuffer: true });
    setState('files.currentFileBlob', null);
    postCommand({ command: 'STORAGE_RESET', isPreload: false });
    setPlaybackIdle();
    if (
      typeof authoritativeTrackIndex === 'number' &&
      Number.isSafeInteger(authoritativeTrackIndex) &&
      authoritativeTrackIndex >= 0
    ) {
      sendToHost({ type: MSG.GUEST_DECODE_FAILED, index: authoritativeTrackIndex });
    }
    showLoader(false);
    showToast(t('error.load_failed', { msg: message }));
    return false;
  }
}

type PendingPlaySnapshot = {
  time: number;
  setAt: number;
  trackIndex: number;
  targetIndex?: number;
  targetName?: string;
  transferName?: string;
};

function capturePendingPlaySnapshot(): PendingPlaySnapshot | null {
  const time = getPendingPlayTime();
  if (time === undefined) return null;

  const target = getState('playback.pendingRecoveryTarget');
  const meta = getState('transfer.meta');
  return {
    time,
    setAt: getPendingPlayTimeSetAt(),
    trackIndex: getState('playlist.currentTrackIndex'),
    targetIndex: target?.index,
    targetName: target?.name,
    transferName: typeof meta?.name === 'string' ? meta.name : undefined,
  };
}

function shouldRestorePendingPlay(
  snapshot: PendingPlaySnapshot,
  data: Record<string, unknown>,
): boolean {
  const incomingIndex = typeof data.index === 'number' ? data.index : undefined;
  const incomingName = typeof data.name === 'string' ? data.name : undefined;

  if (incomingIndex !== undefined) {
    return snapshot.trackIndex === incomingIndex || snapshot.targetIndex === incomingIndex;
  }

  return !!(
    incomingName &&
    (snapshot.targetName === incomingName || snapshot.transferName === incomingName)
  );
}

function restorePendingPlaySnapshot(
  snapshot: PendingPlaySnapshot | null,
  data: Record<string, unknown>,
  reason: string,
): void {
  if (!snapshot) return;
  if (getPendingPlayTime() !== undefined) return;
  if (!shouldRestorePendingPlay(snapshot, data)) return;
  setPendingPlayTime(snapshot.time, snapshot.setAt);
  log.debug(`[Transfer] Restored pending play time after ${reason}`);
}

// ─── Skip-Incoming Derivation ────────────────────────────────────────
//
// Derive the skip decision from lifecycle, playback ownership, transfer meta,
// and the active blob. A derived decision cannot leak across track changes as
// a mutable cross-module flag could.
//
// Callers pass the full frame so same-session identity can be checked without
// falling back to filename metadata.
function shouldSkipIncomingFile(data?: Record<string, unknown>): boolean {
  // External owners have their own state paths, so stale file frames are
  // dropped before lifecycle/transfer heuristics get a chance to accept them.
  if (isExternalOwner()) return true;

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
    const meta = getState('transfer.meta');
    const carriesPlaylistIndex = data?.type === MSG.FILE_START || data?.type === MSG.FILE_RESUME;
    return !!(
      data &&
      data.sessionId === meta?.sessionId &&
      data.name === meta?.name &&
      (!carriesPlaylistIndex || data.index === undefined || data.index === meta?.index)
    );
  }

  // Same-transfer replay: skip tail frames only when they belong to the exact
  // session that produced the loaded blob. A filename match is insufficient:
  // distinct files can share both name and byte length.
  if (
    data &&
    lifecycle !== PLAYBACK_STATE.DOWNLOADING &&
    getState('transfer.state') !== TRANSFER_STATE.RECEIVING
  ) {
    const blob = getState('files.currentFileBlob');
    const meta = getState('transfer.meta');
    const incomingSessionId = Number(data.sessionId);
    const loadedSessionId = Number(meta?.sessionId);
    if (
      blob &&
      Number.isFinite(incomingSessionId) &&
      incomingSessionId > 0 &&
      incomingSessionId === loadedSessionId &&
      meta?.name === data.name
    ) {
      return true;
    }
  }

  return false;
}

function shouldAcceptLocalDirectFileStart(data: Record<string, unknown>): boolean {
  if (getState('network.connectionType') !== 'local') return false;

  const incomingName = typeof data.name === 'string' ? data.name : '';
  if (!incomingName) return false;

  const pendingTarget = getState('playback.pendingRecoveryTarget');
  const meta = getState('transfer.meta');
  const preloadMeta = getState('preload.meta');
  const metaIndex = typeof meta?.index === 'number' ? meta.index : undefined;
  const preloadIndex = typeof preloadMeta?.index === 'number' ? preloadMeta.index : undefined;
  const incomingIndex = typeof data.index === 'number' ? data.index : undefined;
  const pendingIndex = pendingTarget?.index ?? metaIndex ?? preloadIndex;

  const nameMatches =
    incomingName === pendingTarget?.name ||
    incomingName === meta?.name ||
    incomingName === preloadMeta?.name;
  const indexMatches =
    incomingIndex === undefined || pendingIndex === undefined || incomingIndex === pendingIndex;
  const isWaitingForPreload = getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD;

  return isWaitingForPreload && nameMatches && indexMatches;
}

function getLocalDirectFileIndex(data: Record<string, unknown>): number {
  if (typeof data.index === 'number') return data.index;

  const pendingIndex = getState('playback.pendingRecoveryTarget')?.index;
  if (typeof pendingIndex === 'number') return pendingIndex;

  const metaIndex = getState('transfer.meta')?.index;
  if (typeof metaIndex === 'number') return metaIndex;

  return Math.max(0, getState('playlist.currentTrackIndex'));
}

function adoptIncomingTrackTarget(data: Record<string, unknown>): void {
  const index = Number(data.index);
  if (!Number.isSafeInteger(index) || index < 0) return;
  const name = typeof data.name === 'string' ? data.name : undefined;
  setState('playlist.currentTrackIndex', index);
  setPendingRecoveryTarget(index, name);
}

function hasValidOptionalTrackIndex(data: Record<string, unknown>): boolean {
  const index = data.index;
  return (
    index === undefined || (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0)
  );
}

function resolvePendingChunkBootstrapIndex(data: Record<string, unknown>): number | undefined {
  const filename = typeof data.name === 'string' ? data.name : '';
  const total = data.total;
  const chunkIndex = data.index;
  const pending = getState('playback.pendingRecoveryTarget');

  if (
    !filename ||
    !pending ||
    pending.name !== filename ||
    !Number.isSafeInteger(pending.index) ||
    pending.index < 0 ||
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    typeof chunkIndex !== 'number' ||
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex >= total
  ) {
    return undefined;
  }

  return pending.index;
}

function resolveRecoveredTrackIndex(filename: string, existingIndex?: unknown): number | undefined {
  const parsedExisting = Number(existingIndex);
  if (Number.isSafeInteger(parsedExisting) && parsedExisting >= 0) return parsedExisting;

  const pending = getState('playback.pendingRecoveryTarget');
  if (
    pending &&
    (!filename || !pending.name || pending.name === filename) &&
    Number.isSafeInteger(pending.index) &&
    pending.index >= 0
  ) {
    return pending.index;
  }

  // A current playlist index by itself is not ownership evidence: the guest
  // may still be showing the previous track, and duplicate filenames are
  // valid. Without FILE_PREPARE/PLAY-derived identity, leave the index absent
  // so the completion gate rejects the ambiguous bytes and recovery retries.
  return undefined;
}

function enterAcceptedMainTransfer(
  data: Record<string, unknown>,
  variant: 'fresh' | 'resume',
): void {
  const index = Number(data.index);
  const name = typeof data.name === 'string' ? data.name : '';
  if (!Number.isSafeInteger(index) || index < 0 || !name) return;

  if (getState('playback.lifecycle') !== PLAYBACK_STATE.DOWNLOADING) {
    transition({ type: 'FILE_PREPARE', variant, index, name });
  }
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
  demoName?: unknown,
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

  const demoTrack = getDemoTrackForPlayback(index, demoName);
  if (_demoFetchPromise?.key === demoTrack.id) return _demoFetchPromise.promise;

  _demoFetchPromise = {
    key: demoTrack.id,
    promise: _doFetchDemoFromServer(index, guardedPlayAt, guardedPlaySetAt, demoName),
  };

  try {
    await _demoFetchPromise.promise;
  } finally {
    if (_demoFetchPromise?.key === demoTrack.id) _demoFetchPromise = null;
  }
}

async function _doFetchDemoFromServer(
  index: number,
  guardedPlayAt?: number,
  guardedPlaySetAt?: number,
  demoName?: unknown,
): Promise<void> {
  const guardedPlaySetAtValue = guardedPlaySetAt ?? getPendingPlayTimeSetAt();
  const demoTrack = getDemoTrackForPlayback(index, demoName);
  showLoader(true, t('transfer.demo_loading'));
  updateLoader(0);

  try {
    const blob: Blob = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', demoTrack.url, true);
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

    const file = new File([blob], demoTrack.fileName, { type: demoTrack.mime });
    const demoSessionId = nextSessionId();

    // Use the preload path for seamless playback
    setState('preload.nextFileBlob', file);
    setState('preload.meta', {
      ...createDemoTrackMeta(demoTrack),
      index,
      size: file.size,
      mime: demoTrack.mime,
      sessionId: demoSessionId,
    });
    setState('preload.nextTrackIndex', index);
    showLoader(false);

    // Defensive: preserve pending play time if the HTTP fetch race cleared it
    if (guardedPlayAt !== undefined && getPendingPlayTime() === undefined) {
      setPendingPlayTime(guardedPlayAt, guardedPlaySetAtValue);
    }

    // The fetched demo file now owns the preload lifecycle.
    transition({ type: 'PRELOAD_FILE_READY', index });

    bus.emit('storage:use-preloaded', index, demoTrack.fileName, demoSessionId);
  } catch (e) {
    log.error('[Transfer] Demo server fetch failed:', e);
    // The translated string ends with ":"; append the error so the toast does
    // not end with dangling punctuation.
    showToast(`${t('transfer.demo_load_fail')} ${(e as Error).message || ''}`.trim());
    showLoader(false);
    // Fallback: request from host. shouldSkipIncomingFile() will return false
    // once the host's FILE_PREPARE response transitions us out of
    // AWAITING_PRELOAD via the fresh-download path.
    sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name: demoTrack.fileName, index });
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
  setPlaybackTrackMeta(createFileTrackMeta((data.name as string) || ''));
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
  const loadedSessionId = Number(currentTransferMeta?.sessionId);
  const isSameTrackByIndex =
    requestedIndex !== undefined &&
    requestedIndex === currentTrackIndex &&
    requestedIndex === currentTransferMeta?.index;
  const isSameTrackByName =
    requestedIndex === undefined && !!requestedName && currentTransferMeta?.name === requestedName;
  const metadataConsistent =
    (!requestedName || requestedName === currentTransferMeta?.name) &&
    (data.size === undefined || Number(data.size) === currentFileBlob?.size);

  if (!currentFileBlob || !metadataConsistent || (!isSameTrackByIndex && !isSameTrackByName)) {
    return false;
  }
  if (!Number.isFinite(incomingSessionId) || incomingSessionId <= 0) return false;
  if (incomingSessionId !== loadedSessionId) return false;

  log.debug(`[file-prepare] Exact loaded transfer replay, skipping re-download: ${requestedName}`);
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
  if (
    data.sessionId !== undefined &&
    (!Number.isSafeInteger(data.sessionId) || (data.sessionId as number) <= 0)
  ) {
    return;
  }

  if (isSystemAudioOwner()) {
    log.debug('[Transfer] Ignoring FILE_PREPARE - system audio mode active');
    return;
  }

  // YouTube mode normally owns its own transport, but demo is a deliberate
  // cross-mode switch: remote guests fetch the bundled demo over HTTP after
  // FILE_PREPARE. Accept that one and tear YouTube down before driving the
  // file lifecycle.
  if (isYouTubeOwner()) {
    if (!isDemoTrackName(data.name)) {
      log.debug('[Transfer] Ignoring FILE_PREPARE — YouTube mode active');
      return;
    }
    const pendingTime = getPendingPlayTime();
    const pendingSetAt = getPendingPlayTimeSetAt();
    log.debug('[Transfer] Accepting demo FILE_PREPARE during YouTube mode');
    bus.emit('player:stop-all-media');
    if (isYouTubeOwner()) {
      setPlaybackIdle();
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
      if (isDemoTrackName(data.name)) {
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

        fetchDemoFromServer(safeDemoIndex, pendingTime, pendingSetAt, data.name);
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

  // Lifecycle is authoritative. If we were AWAITING_PRELOAD, the transition()
  // call later in this handler supersedes us correctly.
  if (getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD) {
    log.debug('[file-prepare] AWAITING_PRELOAD → will be superseded below');
  }
  clearManagedTimer('preloadWatchdog');
  setState('recovery.retryCount', 0);

  const incomingSid = data.sessionId as number;
  const prevLocalSid = getState('transfer.localSessionId');
  const isNewSession = incomingSid && incomingSid > prevLocalSid;

  // A newer session owns a fresh receive pipeline. Reset counters, ordering,
  // watchdog time, and transfer state before accepting its chunks.
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
    setPlaybackTransferState(TRANSFER_STATE.IDLE);
    // Arm chunk watchdog from NOW so the 12s timer counts from FILE_PREPARE,
    // not from the last chunk of the previous (defunct) session.
    startChunkWatchdog();
  }

  // Check for preloaded match
  const preloadMeta = getState('preload.meta');
  const nextFileBlob = getState('preload.nextFileBlob');
  const hasPreloadedByIndex =
    preloadMeta &&
    data.index !== undefined &&
    data.index === preloadMeta.index &&
    data.name === preloadMeta.name;

  // Preload INDEX MISMATCH: Don't use stale preload from a different track
  const isMismatch = preloadMeta && data.index !== undefined && data.index !== preloadMeta.index;
  // A different playlist slot is a different logical file unless the protocol
  // carries an explicit object identity. Never promote by name+size.
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

  const pendingPlaySnapshot = capturePendingPlaySnapshot();

  // The exact playlist index selects the staged Blob. The name is only a
  // metadata consistency check; a name match alone never permits promotion.
  if (nextFileBlob && !isMismatch && hasPreloadedByIndex) {
    log.debug('[Guest] Using preloaded track instead of re-downloading:', data.name);
    // No direct chunks follow this promotion, so disarm receive watchdogs now.
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('prepareWatchdog');
    showToast(t('transfer.preload_done'));

    // Stop old media right before loading preloaded track (minimizes audio gap)
    bus.emit('player:stop-all-media');

    if (data.index !== undefined) {
      setState('playlist.currentTrackIndex', data.index as number);
    }

    // FILE_PREPARE where blob already assembled → promote straight to DECODING
    // via the preload-promoted path. shouldSkipIncomingFile() returns true
    // automatically once lifecycle is DECODING with PRELOAD_PROMOTED loadSource.
    restorePendingPlaySnapshot(pendingPlaySnapshot, data, 'preload-match stopAllMedia');

    transition({
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      index: data.index as number,
      name: data.name as string,
    });
    const preloadSessionId = Number(preloadMeta?.sessionId);
    bus.emit(
      'storage:use-preloaded',
      data.index as number,
      data.name as string,
      Number.isSafeInteger(preloadSessionId) && preloadSessionId > 0 ? preloadSessionId : undefined,
    );

    showLoader(false);
    return;
  }

  // Check if guest already has this file loaded (e.g. repeat-one mode)
  // Guard: only skip if guest actually has a file loaded (currentFileBlob !== null)
  const currentFileBlob = getState('files.currentFileBlob');
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const currentTransferMeta = getState('transfer.meta');
  const isSameTrackByIndex =
    data.index !== undefined &&
    data.index === currentTrackIndex &&
    data.index === currentTransferMeta?.index;
  const isSameTrackByName =
    data.index === undefined && data.name && currentTransferMeta?.name === data.name;
  const incomingSameFileSessionId = Number(data.sessionId);
  const loadedSameFileSessionId = Number(currentTransferMeta?.sessionId);
  const isExactLoadedTransfer =
    Number.isFinite(incomingSameFileSessionId) &&
    incomingSameFileSessionId > 0 &&
    incomingSameFileSessionId === loadedSameFileSessionId;
  const loadedMetadataConsistent =
    data.name === currentTransferMeta?.name &&
    (data.size === undefined || Number(data.size) === currentFileBlob?.size);
  if (
    currentFileBlob &&
    loadedMetadataConsistent &&
    (isSameTrackByIndex || isSameTrackByName) &&
    isExactLoadedTransfer
  ) {
    log.debug(
      `[file-prepare] Same file already loaded (repeat?), skipping re-download: ${data.name}`,
    );
    // Replay receives no chunks, so clear the watchdog armed for a new session.
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('prepareWatchdog');
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
    // A newer main session supersedes an in-flight preload for the same track;
    // otherwise both paths can wait on ownership held by the other.
    if (incomingSid > prevLocalSid) {
      log.debug(
        '[file-prepare] Preload in progress but Host started Main Session. Prioritizing Main.',
      );
      setState('preload.nextFileBlob', null);
      setState('preload.meta', null);
      setState('preload.nextTrackIndex', -1);
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
          setPlaybackTrackMeta(trackEntry);
        }
      }

      // Recover if preload assembly stalls. Remote preload shares the 60s
      // receive allowance; local preload gets 30s (longer than chunk receive).
      restorePendingPlaySnapshot(pendingPlaySnapshot, data, 'preload-waiting stopAllMedia');

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
    Number(meta?.sessionId) === incomingSid &&
    (meta?.index === data.index || (prevTarget !== null && prevTarget.index === data.index));

  // Store pending file info (after reading old values above)
  setPendingRecoveryTarget(data.index as number | undefined, data.name as string | undefined);
  const isResuming = isSameFile && receivedCount > 0;

  if (isResuming) {
    log.debug(`[file-prepare] Same file in progress (${receivedCount} chunks), skipping reset`);
    // Lifecycle: resume scenario — we had partial data
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
    // Lifecycle: fresh download — no preload match, no
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
        setPlaybackTrackMeta(trackEntry);
      }
    }

    // Stop YouTube mode for incoming local file
    if (isYouTubeOwner()) {
      log.debug('[file-prepare] Stopping YouTube mode for incoming local file');
      bus.emit('youtube:stop-mode');
    }

    showLoader(true, t('transfer.preparing_name', { name: data.name as string }));
  }
  restorePendingPlaySnapshot(pendingPlaySnapshot, data, 'file-prepare reset');

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

  if (!hasValidOptionalTrackIndex(data)) {
    log.warn(`[file-start] Invalid playlist index ignored: ${String(data.index)}`);
    return;
  }

  const incomingSid = data.sessionId as number;
  if (!Number.isSafeInteger(incomingSid) || incomingSid <= 0) return;
  const localSid = getState('transfer.localSessionId');
  const isLocalDirectStart = shouldAcceptLocalDirectFileStart(data);

  if (!incomingSid || incomingSid < localSid) {
    log.warn(`[file-start] Stale session ignored. Current: ${localSid}, Received: ${incomingSid}`);
    return;
  }

  // A remote-loaded guest has not adopted transfer.localSessionId yet. Preserve
  // its playing buffer only when FILE_START names the exact descriptor session
  // and playlist slot already loaded. Name+size alone can collide.
  if (!isLocalDirectStart) {
    const loadedBlob = getState('files.currentFileBlob');
    const loadedMeta = getState('transfer.meta');
    const loadedSid = Number(loadedMeta?.sessionId);
    const sameSession = incomingSid > 0 && incomingSid === loadedSid;
    const sameIndex =
      Number.isInteger(data.index) &&
      data.index === loadedMeta?.index &&
      data.index === getState('playlist.currentTrackIndex');
    const metadataConsistent =
      data.name === loadedMeta?.name &&
      Number(data.size) > 0 &&
      Number(data.size) === loadedBlob?.size;
    if (loadedBlob && sameSession && sameIndex && metadataConsistent) {
      if (incomingSid > localSid) setState('transfer.localSessionId', incomingSid);
      clearManagedTimer('prepareWatchdog');
      clearManagedTimer('chunkWatchdog');
      log.info(
        `[file-start] Already loaded "${data.name}" (adopting sid ${incomingSid}); skipping redundant re-transfer`,
      );
      return;
    }
  }

  const isNewSession = incomingSid > localSid;

  // Skip if using preloaded file; no direct receive pipeline is needed.
  // Downstream peers would begin expecting chunks that will never arrive
  // (since chunks are also skipped when shouldSkipIncomingFile() is true).
  // Exception: if this FILE_START is a recovery re-send (same file, same
  // session), the host explicitly wants us to receive data — fall through
  // and let the STORAGE_START + transfer.state=RECEIVING below break the
  // skip condition for subsequent chunks.
  if (!isLocalDirectStart && shouldSkipIncomingFile(data)) {
    const meta = getState('transfer.meta');
    const isRecoveryResend =
      !isNewSession && Number(meta?.sessionId) === incomingSid && meta?.index === data.index;
    if (!isRecoveryResend) {
      clearManagedTimer('prepareWatchdog');
      clearManagedTimer('chunkWatchdog');
      return;
    }
    log.info('[file-start] Accepting same-session recovery resend');
  }

  // RAM-only storage must own a bounded encoded lease before any state change
  // can make this session eligible to accept payload chunks.
  if (!tryAdmitMainReceive(data, data.index as number | undefined)) return;

  if (isNewSession) {
    setState('transfer.localSessionId', incomingSid);
    postCommand({ command: 'STORAGE_RESET', isPreload: false, sessionId: incomingSid });
    // Remote-share waits already cleared stale playback on entry; clearing
    // again here erases the pending target needed to promote to local direct.
    if (!isLocalDirectStart) {
      bus.emit('storage:clear-previous-track', 'new-session-start');
    }
    discardPendingEarlySessionsExcept(incomingSid);
  }
  if (isLocalDirectStart) switchRemoteWaitToLocalDirect(data);

  // FILE_START is authoritative when FILE_PREPARE was lost. Adopt its
  // playlist slot only after stale/skip guards have accepted this frame.
  adoptIncomingTrackTarget(data);
  enterAcceptedMainTransfer(data, 'fresh');
  transition({ type: 'FILE_START', sessionId: incomingSid });

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
  setPlaybackTransferState(TRANSFER_STATE.RECEIVING);
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

// Preload has no resume protocol; store reconciliation below is intentionally
// limited to the main transfer channel.
export function handleFileResume(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  if (!hasValidOptionalTrackIndex(data)) {
    log.warn(`[file-resume] Invalid playlist index ignored: ${String(data.index)}`);
    return;
  }

  const incomingSid = data.sessionId as number;
  if (!Number.isSafeInteger(incomingSid) || incomingSid <= 0) return;
  const localSid = getState('transfer.localSessionId');

  if (!incomingSid || incomingSid < localSid) return;
  if (shouldSkipIncomingFile(data)) {
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    return;
  }

  const meta = getState('transfer.meta');
  const resumeIdentityMatches =
    Number(meta?.sessionId) === incomingSid &&
    meta?.name === data.name &&
    Number.isSafeInteger(data.index) &&
    meta?.index === data.index &&
    Number(data.size) > 0 &&
    meta?.size === data.size &&
    meta?.total === data.total;

  // A delayed recovery response may arrive after this exact RAM session
  // finalized. Ignore only that exact transfer; same-name/size data from a
  // different session must start fresh.
  const finalizedBlob = ramReadBlob((data.name as string) || '', false, incomingSid);
  if (resumeIdentityMatches && finalizedBlob && finalizedBlob.size === Number(data.size)) {
    log.debug(`[file-resume] "${data.name}" already finalized in store — dropping stale resume`);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    return;
  }

  if (!tryAdmitMainReceive(data, data.index as number | undefined)) return;

  // FILE_RESUME can also be the first surviving control frame. Do not mutate
  // lifecycle, playlist, or transfer ownership until the exact finalized-slot
  // guard above has ruled out a delayed resume for already-complete bytes.
  adoptIncomingTrackTarget(data);
  enterAcceptedMainTransfer(data, 'resume');
  transition({ type: 'FILE_RESUME', startChunk: Number(data.startChunk) || 0 });
  if (incomingSid > localSid) {
    setState('transfer.localSessionId', incomingSid);
    discardPendingEarlySessionsExcept(incomingSid);
  }

  const startChunk = (data.startChunk as number) || 0;

  // The host's startChunk is a control-plane assertion; ramstore's contiguous
  // prefix is data-plane truth. Reuse it only inside the exact same session.
  // Any identity mismatch degrades safely to a full restart.
  const base = resumeIdentityMatches
    ? Math.min(startChunk, ramContiguousCount((data.name as string) || '', false, incomingSid))
    : 0;

  // receivedCount and nextExpectedChunk MUST move together — rebasing one
  // while the other keeps startChunk recreates the failure in the opposite
  // direction (drain stall at phantom completion, or chunks stranded in the
  // reorder buffer past a fast-forwarded pointer).
  fileReorderBuffer.clear();
  setState('transfer.receivedCount', base);
  nextExpectedChunk = base;

  clearManagedTimer('prepareWatchdog');
  postCommand({
    command: 'STORAGE_START',
    filename: data.name as string,
    isPreload: false,
    sessionId: validateSessionId(incomingSid),
    size: CHUNK_SIZE,
    keepExisting: base > 0, // preserve existing data on resume
  });

  setState('files.currentTrack', { name: data.name as string });

  setState('transfer.meta', data as Partial<FileMeta>);
  setPlaybackTransferState(TRANSFER_STATE.RECEIVING);

  startChunkWatchdog();

  // If the store is behind the asserted offset, rebase first and request a
  // replacement stream through the recovery bus so retry policy is preserved.
  if (base < startChunk) {
    bus.emit('storage:request-recovery', base);
  }

  // Drain same-session chunks that arrived before the resume header.
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

// Network entry authenticates the host frame; internal replay sites call
// applyFileChunk directly because queued chunks no longer retain `conn`.
export function handleFileChunk(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  applyFileChunk(data);
}

function applyFileChunk(data: Record<string, unknown>): void {
  const incomingSid = data.sessionId as number;
  if (!Number.isSafeInteger(incomingSid) || incomingSid <= 0) return;
  if (incomingSid === rejectedMainSessionId) return;

  // Reject a missing chunk rather than constructing an empty byte view.
  if (data.chunk == null) {
    log.warn('[Transfer] Received null/undefined chunk, skipping');
    return;
  }

  // Validate the chunk with a cross-realm-safe ArrayBuffer check.
  if (!(data.chunk instanceof Uint8Array) && !isArrayBuffer(data.chunk)) {
    log.warn('[Transfer] Invalid chunk type received, ignoring');
    return;
  }

  // Skip if using preloaded file
  if (shouldSkipIncomingFile(data)) {
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

  const localSid = getState('transfer.localSessionId');
  const pendingBootstrapIndex =
    transferState === TRANSFER_STATE.IDLE && incomingSid > localSid
      ? resolvePendingChunkBootstrapIndex(data)
      : undefined;

  // Buffer early chunks that arrive before FILE_START sets up the session.
  // An authoritative PLAY can arrive first and pin an exact {index, name}
  // target. In that one case a self-describing chunk is allowed to act as the
  // first surviving transfer control frame instead of waiting forever for a
  // FILE_START that was lost.
  if (
    transferState === TRANSFER_STATE.IDLE &&
    !fileReorderBuffer.has(incomingSid) &&
    pendingBootstrapIndex === undefined
  ) {
    bufferEarlyMainChunk(data);
    return;
  }

  const activeMeta = getState('transfer.meta');
  const admittedTrackIndex =
    Number(activeMeta?.sessionId) === incomingSid && Number.isSafeInteger(activeMeta?.index)
      ? (activeMeta?.index as number)
      : pendingBootstrapIndex;
  if (incomingSid >= localSid && !tryAdmitMainReceive(data, admittedTrackIndex)) return;

  // Reset RAM storage on new-session detection.
  if (incomingSid > localSid) {
    const chunkName = (data.name as string) || '';
    const recoveredIndex = pendingBootstrapIndex ?? resolveRecoveredTrackIndex(chunkName);
    if (recoveredIndex !== undefined && chunkName) {
      setState('playlist.currentTrackIndex', recoveredIndex);
      if (getState('playback.lifecycle') !== PLAYBACK_STATE.DOWNLOADING) {
        transition({
          type: 'FILE_PREPARE',
          variant: 'fresh',
          index: recoveredIndex,
          name: chunkName,
        });
      }
      transition({ type: 'FILE_START', sessionId: incomingSid });
    }
    setState('transfer.localSessionId', incomingSid);
    postCommand({ command: 'STORAGE_RESET', isPreload: false, sessionId: incomingSid });
    // This chunk is acting as the first surviving control frame for the new
    // session. Mirror FILE_START cleanup so an authoritative PLAY that arrived
    // first keeps its pending position through decode.
    bus.emit('storage:clear-previous-track', 'new-session-start');
    fileReorderBuffer.clear();
    _pendingEarlyChunks.length = 0;
    nextExpectedChunk = 0;
    setState('transfer.receivedCount', 0);

    // Open the RAM slot before accepting subsequent writes.
    if (chunkName) {
      postCommand({
        command: 'STORAGE_START',
        filename: chunkName,
        isPreload: false,
        sessionId: validateSessionId(incomingSid),
        size: CHUNK_SIZE,
      });
      setState('files.currentTrack', { name: chunkName });
      setPlaybackTransferState(TRANSFER_STATE.RECEIVING);
      if (data.total) {
        setState('transfer.meta', {
          name: chunkName,
          index: recoveredIndex,
          total: data.total as number,
          sessionId: incomingSid,
          size: (data.size as number) || 0,
          mime: (data.mime as string) || '',
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
    // FILE_START and FILE_RESUME already set the correct expected offset.
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

  // Bound the reorder buffer and recover from the contiguous offset.
  const MAX_REORDER_BUFFER = 500;
  if (sessionBuffer.size > MAX_REORDER_BUFFER) {
    log.warn(
      `[Transfer] Reorder buffer exceeded ${MAX_REORDER_BUFFER} entries — clearing and requesting recovery`,
    );
    sessionBuffer.clear();
    // Do not fast-forward across missing chunks. Recovery must restart from
    // the real contiguous prefix.
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
      const recoveredName = (data.name as string) || meta?.name || '';
      const recoveredIndex = resolveRecoveredTrackIndex(recoveredName, meta?.index);
      const recoveredMeta = {
        name: recoveredName,
        index: recoveredIndex,
        total: data.total as number,
        sessionId: incomingSid,
        size: (data.size as number) || 0,
        mime: (data.mime as string) || '',
      };
      setState('transfer.meta', recoveredMeta);
      setPlaybackTransferState(TRANSFER_STATE.RECEIVING);

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
    setPlaybackTransferState(TRANSFER_STATE.PROCESSING);
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

  if (shouldSkipIncomingFile(data)) return;

  // Ignore stale FILE_END from old sessions
  const incomingSid = data.sessionId as number;
  if (!Number.isSafeInteger(incomingSid) || incomingSid <= 0) return;
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

export function handleFileWait(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  log.debug('[Guest] FILE_WAIT received — host has no data ready yet');
  showToast(t('transfer.file_wait'));

  // playback.ts owns bounded retries for identity repair. Falling through to
  // the generic timer would reintroduce a stale guest index into
  // REQUEST_DATA_RECOVERY and defeat the host-authoritative selector.
  if (data.reason === 'missing_transfer_identity') {
    clearManagedTimer('fileWaitTimeout');
    return;
  }

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
  pendingEarlySessions: number;
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
    pendingEarlySessions: new Set(_pendingEarlyChunks.map((entry) => entry.sessionId)).size,
    nextExpectedChunk,
  };
}

// ─── Session Cleanup (exported for initTransfer) ─────────────────────

export function clearReceiveState(): void {
  fileReorderBuffer.clear();
  _pendingEarlyChunks.length = 0;
  rejectedMainSessionId = 0;
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
  log.info(`[Transfer] Clearing incoming transfer/storage: ${reason} (${state})`);

  clearManagedTimer('chunkWatchdog');
  clearManagedTimer('prepareWatchdog');

  clearReceiveState();

  if (state === TRANSFER_STATE.RECEIVING || state === TRANSFER_STATE.PROCESSING) {
    setPlaybackTransferState(TRANSFER_STATE.IDLE);
    setState('transfer.receivedCount', 0);
  }

  // Releases partial/finalized storage ownership. A READY current File is a
  // separate resident owner and is deliberately preserved while its exact
  // Blob remains published (e.g. temporary system-audio/YouTube takeover).
  postCommand({ command: 'STORAGE_RESET', isPreload: false });
  showLoader(false);
}
