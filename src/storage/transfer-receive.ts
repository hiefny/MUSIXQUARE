/**
 * MUSIXQUARE — File Transfer: Receive Side
 *
 * Handles FILE_PREPARE, FILE_START, FILE_RESUME, FILE_CHUNK, FILE_END,
 * FILE_WAIT. Manages the chunk watchdog and bounded reorder buffer.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { batchSetState, getState, setState } from '../core/state.ts';
import {
  MSG,
  CHUNK_SIZE,
  TRANSFER_STATE,
  WATCHDOG_TIMEOUT,
  PLAYBACK_STATE,
  LOAD_SOURCE,
} from '../core/constants.ts';
import { validateSessionId } from '../core/session.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { admitIncomingStoredFile, postCommand } from './storage.ts';
import { ramContiguousCount, ramReadBlob } from './ramstore.ts';
import { t } from '../i18n/index.ts';
import { sendToHost, isRemoteGuest, waitForGuestConnectionType } from '../network/peer.ts';
import {
  beginFileRequest,
  completeFileRequest,
  isCurrentFileRequestOwner,
  matchFileWaitResponse,
  sendFileRequest,
} from '../network/file-request-authority.ts';
import {
  cancelRemoteShareWait,
  prepareRemoteShareWait,
  shouldWaitForRemoteShare,
} from '../share/remote-share.ts';
import { isArrayBuffer } from './transfer-shared.ts';
import type { DataConnection, QueueItemId } from '../types/index.ts';
import { showToast, showLoader } from '../ui/toast.ts';
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
import {
  findQueueItemIndex,
  getQueueItemById,
  selectQueueItemById,
} from '../player/queue-model.ts';
import {
  finalizeProRoomLegacyDirectFile,
  isProRoomPersistentPlaylistFile,
  resolveProRoomPlaylistFile,
} from '../pro-room/legacy-media-hooks.ts';
import { isGuestR2FileDelivery, recordGuestFileDelivery } from '../share/file-delivery-policy.ts';

// ─── Receive-side Module State ───────────────────────────────────────

const fileReorderBuffer = new Map<number, Map<number, Uint8Array>>();
const fileQueueItemBySession = new Map<number, QueueItemId>();
let nextExpectedChunk = 0;
let lastChunkTime = 0;
let rejectedMainSessionId = 0;
let _filePrepareGeneration = 0;
const MAX_FILE_TOTAL = 200_000;

function setActiveFileSessionOwner(sessionId: number, queueItemId: QueueItemId): void {
  // Only one main receive session can be authoritative. Superseded sessions
  // may never reach FILE_END, so completion-only deletion would retain one
  // owner entry per rapid track switch for the lifetime of the room.
  for (const key of fileQueueItemBySession.keys()) {
    if (key !== sessionId) fileQueueItemBySession.delete(key);
  }
  fileQueueItemBySession.set(sessionId, queueItemId);
}

interface FilePrepareOwnerSnapshot {
  generation: number;
  hostConn: DataConnection | null;
  currentQueueItemId: QueueItemId | null;
  pendingQueueItemId: QueueItemId | null;
  transferQueueItemId: QueueItemId | null;
  transferSessionId: number;
}

function captureFilePrepareOwner(): FilePrepareOwnerSnapshot {
  const pending = getState('playback.pendingRecoveryTarget');
  const meta = getState('transfer.meta');
  return {
    generation: ++_filePrepareGeneration,
    hostConn: getState('network.hostConn'),
    currentQueueItemId: getState('playlist.currentQueueItemId'),
    pendingQueueItemId: pending?.queueItemId ?? null,
    transferQueueItemId: meta?.queueItemId ?? null,
    transferSessionId: Number(meta?.sessionId) || 0,
  };
}

/**
 * Revalidate an authoritative FILE_PREPARE after connection classification.
 * A null current target is valid during fresh bootstrap; only ownership that
 * changed to a conflicting target (or a newer transfer session) supersedes
 * the suspended frame.
 */
function isFilePrepareOwnerCurrent(
  snapshot: FilePrepareOwnerSnapshot,
  queueItemId: QueueItemId,
  sessionId: number,
  conn: DataConnection | undefined,
): boolean {
  if (
    snapshot.generation !== _filePrepareGeneration ||
    !snapshot.hostConn ||
    getState('network.hostConn') !== snapshot.hostConn ||
    conn !== snapshot.hostConn ||
    !getQueueItemById(queueItemId)
  ) {
    return false;
  }

  if (getState('transfer.localSessionId') > sessionId) return false;

  const currentQueueItemId = getState('playlist.currentQueueItemId');
  if (currentQueueItemId !== snapshot.currentQueueItemId && currentQueueItemId !== queueItemId) {
    return false;
  }

  const pendingQueueItemId = getState('playback.pendingRecoveryTarget')?.queueItemId ?? null;
  if (pendingQueueItemId !== snapshot.pendingQueueItemId && pendingQueueItemId !== queueItemId) {
    return false;
  }

  const meta = getState('transfer.meta');
  const transferQueueItemId = meta?.queueItemId ?? null;
  const transferSessionId = Number(meta?.sessionId) || 0;
  const transferOwnerChanged =
    transferQueueItemId !== snapshot.transferQueueItemId ||
    transferSessionId !== snapshot.transferSessionId;
  if (
    transferOwnerChanged &&
    transferQueueItemId !== null &&
    (transferQueueItemId !== queueItemId || transferSessionId > sessionId)
  ) {
    return false;
  }

  return true;
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

function incomingQueueItemId(data: Record<string, unknown>): QueueItemId | null {
  return typeof data.queueItemId === 'string' && data.queueItemId.length > 0
    ? data.queueItemId
    : null;
}

function completeAcceptedFileRequest(
  data: Record<string, unknown>,
  conn: DataConnection | undefined,
): void {
  const queueItemId = incomingQueueItemId(data);
  if (!queueItemId) return;
  const sessionId = data.sessionId;
  completeFileRequest(
    conn,
    queueItemId,
    Number.isSafeInteger(sessionId) && (sessionId as number) > 0
      ? (sessionId as number)
      : undefined,
  );
}

function tryAdmitMainReceive(data: Record<string, unknown>): boolean {
  const sessionId = data.sessionId;
  const filename = data.name;
  const queueItemId = incomingQueueItemId(data);
  if (
    !queueItemId ||
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
      queueItemId,
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
    nextExpectedChunk = 0;
    setState('transfer.receivedCount', 0);
    bus.emit('player:stop-all-media', { cancelInFlight: true, clearBuffer: true });
    postCommand({ command: 'STORAGE_RESET', isPreload: false });
    setPlaybackIdle();
    sendToHost({ type: MSG.GUEST_DECODE_FAILED, queueItemId });
    showLoader(false);
    showToast(t('error.load_failed', { msg: message }));
    return false;
  }
}

type PendingPlaySnapshot = {
  time: number;
  setAt: number;
  currentQueueItemId: QueueItemId | null;
  targetQueueItemId?: QueueItemId;
  transferQueueItemId?: QueueItemId;
};

function capturePendingPlaySnapshot(): PendingPlaySnapshot | null {
  const time = getPendingPlayTime();
  if (time === undefined) return null;

  const target = getState('playback.pendingRecoveryTarget');
  const meta = getState('transfer.meta');
  return {
    time,
    setAt: getPendingPlayTimeSetAt(),
    currentQueueItemId: getState('playlist.currentQueueItemId'),
    targetQueueItemId: target?.queueItemId,
    transferQueueItemId: meta?.queueItemId,
  };
}

function shouldRestorePendingPlay(
  snapshot: PendingPlaySnapshot,
  data: Record<string, unknown>,
): boolean {
  const queueItemId = incomingQueueItemId(data);
  return (
    !!queueItemId &&
    (snapshot.currentQueueItemId === queueItemId ||
      snapshot.targetQueueItemId === queueItemId ||
      snapshot.transferQueueItemId === queueItemId)
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

  const queueItemId = data ? incomingQueueItemId(data) : null;
  const sessionId = data ? Number(data.sessionId) : undefined;
  if (isGuestR2FileDelivery(queueItemId, sessionId)) return true;

  // Remote guests use encrypted remote-share instead of direct file chunks;
  // orchestrator gates isDataTarget=false so stale direct frames are dropped.
  if (isRemoteGuest()) return true;

  if (data && !queueItemId) return true;
  if (queueItemId && isProRoomPersistentPlaylistFile(queueItemId)) return true;

  const lifecycle = getState('playback.lifecycle');

  // Waiting for a preload blob. The main-transfer
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
    return !!data && queueItemId === getState('playlist.currentQueueItemId');
  }

  // Same-transfer replay: skip tail frames only when they belong to the exact
  // session that produced the loaded blob. A filename match is insufficient:
  // distinct files can share both name and byte length.
  if (
    data &&
    lifecycle !== PLAYBACK_STATE.DOWNLOADING &&
    getState('transfer.state') !== TRANSFER_STATE.RECEIVING
  ) {
    const resident = getState('files.current');
    const incomingSessionId = Number(data.sessionId);
    const loadedSessionId = Number(resident?.sessionId);
    if (
      resident &&
      resident.queueItemId === queueItemId &&
      Number.isFinite(incomingSessionId) &&
      incomingSessionId > 0 &&
      incomingSessionId === loadedSessionId
    ) {
      return true;
    }
  }

  return false;
}

function shouldAcceptLocalDirectFileStart(data: Record<string, unknown>): boolean {
  if (getState('network.connectionType') !== 'local') return false;

  const queueItemId = incomingQueueItemId(data);
  if (!queueItemId) return false;
  if (isGuestR2FileDelivery(queueItemId, Number(data.sessionId))) return false;

  const pendingTarget = getState('playback.pendingRecoveryTarget');
  const meta = getState('transfer.meta');
  const preloadTarget = getState('preload.activeTarget');
  const identityMatches =
    pendingTarget?.queueItemId === queueItemId ||
    meta?.queueItemId === queueItemId ||
    preloadTarget?.queueItemId === queueItemId;
  const isWaitingForPreload = getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD;

  return isWaitingForPreload && identityMatches;
}

function adoptIncomingTrackTarget(data: Record<string, unknown>): void {
  const queueItemId = incomingQueueItemId(data);
  if (!queueItemId || !getQueueItemById(queueItemId)) return;
  const indexHint = findQueueItemIndex(queueItemId);
  const name =
    typeof data.name === 'string' ? data.name : getQueueItemById(queueItemId)?.name || '';
  selectQueueItemById(queueItemId);
  setPendingRecoveryTarget({ queueItemId, indexHint, name });
}

function enterAcceptedMainTransfer(
  data: Record<string, unknown>,
  variant: 'fresh' | 'resume',
): void {
  const queueItemId = incomingQueueItemId(data);
  const name = typeof data.name === 'string' ? data.name : '';
  if (!queueItemId || !name) return;

  if (getState('playback.lifecycle') !== PLAYBACK_STATE.DOWNLOADING) {
    transition({ type: 'FILE_PREPARE', variant, queueItemId, name });
  }
}

function switchRemoteWaitToLocalDirect(data: Record<string, unknown>): void {
  const incomingName = data.name as string;
  const queueItemId = incomingQueueItemId(data);
  if (!queueItemId) return;
  const indexHint = findQueueItemIndex(queueItemId);

  cancelRemoteShareWait('local-direct-file-start');
  setState('preload.ready', null);
  setState('preload.activeTarget', null);
  setState('preload.nextQueueItemId', null);
  setPendingRecoveryTarget({ queueItemId, indexHint, name: incomingName });
  transition({
    type: 'FILE_PREPARE',
    variant: 'fresh',
    queueItemId,
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

function showRemoteUnavailableUI(data: Record<string, unknown>): void {
  // (skip is derived: isRemoteGuest() returns true.)
  const queueItemId = incomingQueueItemId(data);
  if (queueItemId) selectQueueItemById(queueItemId);
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
  const resident = getState('files.current');
  const requestedQueueItemId = incomingQueueItemId(data);
  const requestedName = data.name as string | undefined;
  const replayName = requestedName || resident?.name || '';
  const incomingSessionId = Number(data.sessionId);
  const loadedSessionId = Number(resident?.sessionId);
  const metadataConsistent =
    (!requestedName || requestedName === resident?.name) &&
    (data.size === undefined || Number(data.size) === resident?.blob.size);

  if (
    !resident ||
    !requestedQueueItemId ||
    resident.queueItemId !== requestedQueueItemId ||
    getState('playlist.currentQueueItemId') !== requestedQueueItemId ||
    !metadataConsistent
  ) {
    return false;
  }
  if (!Number.isFinite(incomingSessionId) || incomingSessionId <= 0) return false;
  if (incomingSessionId !== loadedSessionId) return false;

  log.debug(`[file-prepare] Exact loaded transfer replay, skipping re-download: ${requestedName}`);
  transition({
    type: 'FILE_PREPARE',
    variant: 'same-file',
    queueItemId: requestedQueueItemId,
    name: replayName,
  });
  showLoader(false);
  const delayMs = Number(data.autoPlayDelayMs) || 0;
  bus.emit('playback:replay-current', delayMs);
  return true;
}

async function receiveProRoomFileDirectly(
  data: Record<string, unknown>,
  conn: DataConnection | undefined,
  ownerSnapshot: FilePrepareOwnerSnapshot,
  filePromise: Promise<File | null>,
): Promise<void> {
  const queueItemId = incomingQueueItemId(data);
  const sessionId = Number(data.sessionId);
  const item = queueItemId ? getQueueItemById(queueItemId) : null;
  if (!queueItemId || !item || !Number.isSafeInteger(sessionId) || sessionId <= 0) return;

  completeAcceptedFileRequest(data, conn);
  cancelRemoteShareWait('pro-room-direct-r2');
  clearManagedTimer('preloadWatchdog');
  clearManagedTimer('prepareWatchdog');
  clearManagedTimer('chunkWatchdog');
  clearManagedTimer('fileWaitTimeout');

  const pendingPlaySnapshot = capturePendingPlaySnapshot();
  bus.emit('player:stop-all-media');

  if (sessionId > getState('transfer.localSessionId')) {
    setState('transfer.localSessionId', sessionId);
  }
  setState('transfer.receivedCount', 0);
  setState('transfer.lastReceivedCountSnapshot', 0);
  fileReorderBuffer.clear();
  nextExpectedChunk = 0;
  setPlaybackTransferState(TRANSFER_STATE.IDLE);

  const indexHint = findQueueItemIndex(queueItemId);
  const name = (data.name as string) || item.name;
  const size = Number(data.size);
  const safeSize = Number.isSafeInteger(size) && size > 0 ? size : 0;
  setPendingRecoveryTarget({ queueItemId, indexHint, name });
  transition({ type: 'FILE_PREPARE', variant: 'fresh', queueItemId, name });
  bus.emit('storage:clear-previous-track', 'pro-room-direct-r2');
  selectQueueItemById(queueItemId);
  setState('transfer.meta', {
    ...getState('transfer.meta'),
    queueItemId,
    indexHint,
    name,
    size: safeSize,
    mime: (data.mime as string) || '',
    sessionId,
    total: safeSize > 0 ? Math.max(1, Math.ceil(safeSize / CHUNK_SIZE)) : 1,
  });
  setPlaybackTrackMeta(item);
  restorePendingPlaySnapshot(pendingPlaySnapshot, data, 'PRO direct R2 prepare');

  try {
    const file = await filePromise;
    if (!isFilePrepareOwnerCurrent(ownerSnapshot, queueItemId, sessionId, conn)) return;
    const meta = getState('transfer.meta');
    if (
      !file ||
      getState('playlist.currentQueueItemId') !== queueItemId ||
      meta?.queueItemId !== queueItemId ||
      meta.sessionId !== sessionId
    ) {
      if (!file) transition({ type: 'REMOTE_FILE_UNAVAILABLE' });
      return;
    }
    if (safeSize > 0 && file.size !== safeSize) {
      log.warn('[PRO] Direct R2 File size did not match FILE_PREPARE');
      transition({ type: 'REMOTE_FILE_UNAVAILABLE' });
      return;
    }

    transition({ type: 'FILE_END', queueItemId });
    await finalizeProRoomLegacyDirectFile(file, queueItemId, sessionId);
  } catch (error) {
    if (!isFilePrepareOwnerCurrent(ownerSnapshot, queueItemId, sessionId, conn)) return;
    log.warn('[PRO] Direct R2 receive failed', error);
    transition({ type: 'REMOTE_FILE_UNAVAILABLE' });
  }
}

export async function handleFilePrepare(
  data: Record<string, unknown>,
  conn?: DataConnection,
): Promise<void> {
  if (!isHostBroadcast(conn)) return;
  const queueItemId = incomingQueueItemId(data);
  if (!queueItemId || !getQueueItemById(queueItemId)) return;
  const indexHint = findQueueItemIndex(queueItemId);
  if (
    data.sessionId !== undefined &&
    (!Number.isSafeInteger(data.sessionId) || (data.sessionId as number) <= 0)
  ) {
    return;
  }
  const incomingSid = data.sessionId as number;
  const localSidAtEntry = getState('transfer.localSessionId');
  const transferMetaAtEntry = getState('transfer.meta');
  if (
    incomingSid < localSidAtEntry ||
    (Number(transferMetaAtEntry?.sessionId) === incomingSid &&
      transferMetaAtEntry?.queueItemId !== undefined &&
      transferMetaAtEntry.queueItemId !== queueItemId)
  ) {
    log.debug('[file-prepare] Ignoring stale or conflicting transfer owner');
    return;
  }
  const ownerSnapshot = captureFilePrepareOwner();

  if (isSystemAudioOwner()) {
    log.debug('[Transfer] Ignoring FILE_PREPARE - system audio mode active');
    return;
  }

  if (isYouTubeOwner()) {
    log.debug('[Transfer] Ignoring FILE_PREPARE — YouTube mode active');
    return;
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
  if (replayLoadedSameFile(data)) {
    completeAcceptedFileRequest(data, conn);
    return;
  }

  if (isProRoomPersistentPlaylistFile(queueItemId)) {
    const directFile = resolveProRoomPlaylistFile(queueItemId);
    if (directFile) {
      await receiveProRoomFileDirectly(data, conn, ownerSnapshot, directFile);
      return;
    }
  }

  // A host may intentionally offload a physically local guest once direct
  // LAN fanout is full. The authenticated per-peer marker, not ICE location,
  // owns that decision for this transfer session.
  if (data.delivery === 'r2') {
    recordGuestFileDelivery(queueItemId, incomingSid, 'r2');
    completeAcceptedFileRequest(data, conn);
    if (shouldWaitForRemoteShare()) {
      prepareRemoteShareWait(queueItemId, (data.name as string) || '', incomingSid);
      return;
    }
    showRemoteUnavailableUI(data);
    return;
  }

  // Remote guests do not use the local P2P path. Every queue file waits for
  // an R2 descriptor; bundled demo audio travels only through DEMO_* messages.
  if (isRemoteGuest()) {
    let confirmedRemote = true;
    const connType = getState('network.connectionType');
    if (connType === 'unknown') {
      log.info('[Transfer] connectionType unknown — waiting for ICE detection...');
      showLoader(true, t('transfer.check_conn_type'));
      const resolved = await waitForGuestConnectionType(3000);
      if (!isFilePrepareOwnerCurrent(ownerSnapshot, queueItemId, incomingSid, conn)) {
        log.debug('[file-prepare] Connection classification completed for a superseded owner');
        return;
      }
      if (resolved === 'local') {
        log.info(`[Transfer] connectionType resolved: local — proceeding`);
        showLoader(false);
        confirmedRemote = false;
      }
    }

    if (confirmedRemote) {
      recordGuestFileDelivery(queueItemId, incomingSid, 'r2');
      completeAcceptedFileRequest(data, conn);
      if (shouldWaitForRemoteShare()) {
        prepareRemoteShareWait(
          queueItemId,
          (data.name as string) || '',
          (data.sessionId as number) || getState('transfer.localSessionId') || 0,
        );
        return;
      }
      showRemoteUnavailableUI(data);
      return;
    }
  }

  // The connection, stable queue occurrence, transfer session, playback
  // owner, and remote/local route have all survived their admission gates.
  recordGuestFileDelivery(queueItemId, incomingSid, 'direct-local');
  completeAcceptedFileRequest(data, conn);

  // Lifecycle is authoritative. If we were AWAITING_PRELOAD, the transition()
  // call later in this handler supersedes us correctly.
  if (getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD) {
    log.debug('[file-prepare] AWAITING_PRELOAD → will be superseded below');
  }
  clearManagedTimer('preloadWatchdog');
  setState('recovery.retryCount', 0);

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
  const preloadTarget = getState('preload.activeTarget');
  const preloadReady = getState('preload.ready');
  const hasExactPreload =
    preloadReady?.queueItemId === queueItemId &&
    preloadTarget?.queueItemId === queueItemId &&
    preloadReady.sessionId === preloadTarget.sessionId;

  // Preload INDEX MISMATCH: Don't use stale preload from a different track
  const isMismatch = preloadTarget && preloadTarget.queueItemId !== queueItemId;
  // A different queue item ID is a different logical occurrence. Never
  // promote by name+size.
  if (isMismatch) {
    log.warn(
      `[file-prepare] Preload ownership changed: requested=${queueItemId}, staged=${preloadTarget?.queueItemId}. Clearing stale preload.`,
    );
    clearManagedTimer('preloadWatchdog');
    // Clear stale preload state — also makes shouldSkipIncomingFile() false
    // for this incoming track (no preload sessionState/blob/meta to match).
    setState('preload.ready', null);
    setState('preload.activeTarget', null);
    setState('preload.nextQueueItemId', null);
  }

  const pendingPlaySnapshot = capturePendingPlaySnapshot();

  // The stable queue item ID selects the staged Blob. The name is only a
  // metadata consistency check; a name match alone never permits promotion.
  if (preloadReady && !isMismatch && hasExactPreload) {
    log.debug('[Guest] Using preloaded track instead of re-downloading:', data.name);
    // No direct chunks follow this promotion, so disarm receive watchdogs now.
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('prepareWatchdog');
    showToast(t('transfer.preload_done'));

    // Stop old media right before loading preloaded track (minimizes audio gap)
    bus.emit('player:stop-all-media');

    selectQueueItemById(queueItemId);

    // FILE_PREPARE where blob already assembled → promote straight to DECODING
    // via the preload-promoted path. shouldSkipIncomingFile() returns true
    // automatically once lifecycle is DECODING with PRELOAD_PROMOTED loadSource.
    restorePendingPlaySnapshot(pendingPlaySnapshot, data, 'preload-match stopAllMedia');

    transition({
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      queueItemId,
      name: data.name as string,
    });
    const preloadSessionId = Number(preloadReady.sessionId);
    bus.emit(
      'storage:use-preloaded',
      queueItemId,
      data.name as string,
      Number.isSafeInteger(preloadSessionId) && preloadSessionId > 0 ? preloadSessionId : undefined,
    );

    showLoader(false);
    return;
  }

  // Check if guest already has this file loaded (e.g. repeat-one mode)
  // Guard: only skip when the guest owns the exact resident Blob and session.
  const currentResident = getState('files.current');
  const incomingSameFileSessionId = Number(data.sessionId);
  const loadedSameFileSessionId = Number(currentResident?.sessionId);
  const isExactLoadedTransfer =
    Number.isFinite(incomingSameFileSessionId) &&
    incomingSameFileSessionId > 0 &&
    incomingSameFileSessionId === loadedSameFileSessionId;
  const loadedMetadataConsistent =
    data.name === currentResident?.name &&
    (data.size === undefined || Number(data.size) === currentResident?.blob.size);
  if (
    currentResident &&
    currentResident.queueItemId === queueItemId &&
    getState('playlist.currentQueueItemId') === queueItemId &&
    loadedMetadataConsistent &&
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
    // shouldSkipIncomingFile() returns true via the exact resident queue item,
    // session, and metadata match.
    transition({
      type: 'FILE_PREPARE',
      variant: 'same-file',
      queueItemId,
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
  const preloadInProgress = preloadTarget?.queueItemId === queueItemId;
  const isPreloading = getState('preload.isPreloading');

  if (isPreloading && preloadInProgress) {
    // A newer main session supersedes an in-flight preload for the same track;
    // otherwise both paths can wait on ownership held by the other.
    if (incomingSid > prevLocalSid) {
      log.debug(
        '[file-prepare] Preload in progress but Host started Main Session. Prioritizing Main.',
      );
      setState('preload.ready', null);
      setState('preload.activeTarget', null);
      setState('preload.nextQueueItemId', null);
    } else {
      log.debug('[file-prepare] Preload in progress for this track, waiting...');
      // Preload still downloading for THIS track → AWAITING_PRELOAD. This
      // mirrors the PLAY_PRELOADED blob-waiting branch; both lead to the
      // same waiter semantics. shouldSkipIncomingFile() returns true once
      // lifecycle = AWAITING_PRELOAD.
      transition({
        type: 'FILE_PREPARE',
        variant: 'preload-waiting',
        queueItemId,
        name: data.name as string,
      });
      showLoader(true, t('transfer.preload_pending', { name: data.name as string }));

      setPendingRecoveryTarget({
        queueItemId,
        indexHint,
        name: (data.name as string) || getQueueItemById(queueItemId)?.name || '',
      });
      selectQueueItemById(queueItemId);

      // Mirror the fresh branch: surface the awaited track's title now so
      // the user sees it during the AWAITING_PRELOAD wait instead of after
      // the preload blob assembles.
      {
        const playlist = getState('playlist.items') || [];
        const trackEntry = playlist[indexHint];
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
            if (
              getState('playlist.currentQueueItemId') !== queueItemId ||
              getState('playback.pendingRecoveryTarget')?.queueItemId !== queueItemId
            ) {
              log.debug('[Guest] Preload watchdog belongs to a superseded queue item');
              return;
            }
            log.warn('[Guest] Preload wait timed out. Force recovering...');
            showLoader(false);

            const hostConn = getState('network.hostConn');
            if (!hostConn || !hostConn.open) return;
            const requestOwner = beginFileRequest(
              hostConn,
              queueItemId,
              Number.isSafeInteger(incomingSid) && incomingSid > 0 ? incomingSid : undefined,
            );
            sendFileRequest(requestOwner, {
              type: MSG.REQUEST_CURRENT_FILE,
              name: data.name as string | undefined,
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
    (meta?.queueItemId === queueItemId || prevTarget?.queueItemId === queueItemId);

  // Store pending file info (after reading old values above)
  setPendingRecoveryTarget({
    queueItemId,
    indexHint,
    name: (data.name as string) || getQueueItemById(queueItemId)?.name || '',
  });
  const isResuming = isSameFile && receivedCount > 0;

  if (isResuming) {
    log.debug(`[file-prepare] Same file in progress (${receivedCount} chunks), skipping reset`);
    // Lifecycle: resume scenario — we had partial data
    // for this file, now the host is restarting transfer. Stay in (or enter)
    // DOWNLOADING with the recovery-resume source.
    transition({
      type: 'FILE_PREPARE',
      variant: 'resume',
      queueItemId,
      name: data.name as string,
    });
    showLoader(true, t('transfer.waiting_recovery', { name: data.name as string }));
  } else {
    // Lifecycle: fresh download — no preload match, no
    // resume. Transition to DOWNLOADING with fresh source.
    transition({
      type: 'FILE_PREPARE',
      variant: 'fresh',
      queueItemId,
      name: data.name as string,
    });
    bus.emit('storage:clear-previous-track', 'file-prepare');
    selectQueueItemById(queueItemId);
    // Update meta
    setState('transfer.meta', {
      ...meta,
      queueItemId,
      name: (data.name as string) || '',
      indexHint,
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
      const trackEntry = playlist[indexHint];
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
              if (
                hostConn.open &&
                getState('files.current')?.queueItemId !== queueItemId &&
                getState('playback.pendingRecoveryTarget')?.queueItemId === queueItemId
              ) {
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
  const queueItemId = incomingQueueItemId(data);
  if (!queueItemId || !getQueueItemById(queueItemId)) return;
  const indexHint = findQueueItemIndex(queueItemId);

  const incomingSid = data.sessionId as number;
  if (!Number.isSafeInteger(incomingSid) || incomingSid <= 0) return;
  if (isGuestR2FileDelivery(queueItemId, incomingSid)) {
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    return;
  }
  recordGuestFileDelivery(queueItemId, incomingSid, 'direct-local');
  const localSid = getState('transfer.localSessionId');
  const isLocalDirectStart = shouldAcceptLocalDirectFileStart(data);

  // Persistent PRO occurrences are participant-owned R2 downloads. Even a
  // same-session FILE_START from a stale coordinator must not be interpreted
  // as legacy recovery and reopen the RAM chunk pipeline.
  if (isProRoomPersistentPlaylistFile(queueItemId)) {
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    return;
  }

  if (!incomingSid || incomingSid < localSid) {
    log.warn(`[file-start] Stale session ignored. Current: ${localSid}, Received: ${incomingSid}`);
    return;
  }

  // A remote-loaded guest has not adopted transfer.localSessionId yet. Preserve
  // its playing buffer only when FILE_START names the exact descriptor session
  // and stable queue occurrence already loaded. Name+size alone can collide.
  if (!isLocalDirectStart) {
    const loaded = getState('files.current');
    const loadedSid = Number(loaded?.sessionId);
    const sameSession = incomingSid > 0 && incomingSid === loadedSid;
    const sameQueueItem =
      loaded?.queueItemId === queueItemId &&
      getState('playlist.currentQueueItemId') === queueItemId;
    const metadataConsistent =
      data.name === loaded?.name &&
      Number(data.size) > 0 &&
      Number(data.size) === loaded?.blob.size;
    if (loaded && sameSession && sameQueueItem && metadataConsistent) {
      if (incomingSid > localSid) setState('transfer.localSessionId', incomingSid);
      setActiveFileSessionOwner(incomingSid, queueItemId);
      clearManagedTimer('prepareWatchdog');
      clearManagedTimer('chunkWatchdog');
      completeAcceptedFileRequest(data, conn);
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
      !isNewSession && Number(meta?.sessionId) === incomingSid && meta?.queueItemId === queueItemId;
    if (!isRecoveryResend) {
      clearManagedTimer('prepareWatchdog');
      clearManagedTimer('chunkWatchdog');
      return;
    }
    log.info('[file-start] Accepting same-session recovery resend');
  }

  // RAM-only storage must own a bounded encoded lease before any state change
  // can make this session eligible to accept payload chunks.
  if (!tryAdmitMainReceive(data)) return;
  completeAcceptedFileRequest(data, conn);

  if (isNewSession) {
    setState('transfer.localSessionId', incomingSid);
    postCommand({ command: 'STORAGE_RESET', isPreload: false, sessionId: incomingSid });
    // Remote-share waits already cleared stale playback on entry; clearing
    // again here erases the pending target needed to promote to local direct.
    if (!isLocalDirectStart) {
      bus.emit('storage:clear-previous-track', 'new-session-start');
    }
  }
  setActiveFileSessionOwner(incomingSid, queueItemId);
  if (isLocalDirectStart) switchRemoteWaitToLocalDirect(data);

  // FILE_START is authoritative when FILE_PREPARE was lost. Adopt its stable
  // queue occurrence only after stale/skip guards have accepted this frame.
  adoptIncomingTrackTarget(data);
  enterAcceptedMainTransfer(data, 'fresh');
  transition({ type: 'FILE_START', queueItemId, sessionId: incomingSid });

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
  const isRecoverySameFile =
    meta?.queueItemId === queueItemId &&
    Number(meta?.sessionId) === incomingSid &&
    meta?.total === (data.total as number);

  // Always fresh start — host resends from chunk 0 on recovery,
  // so keepExisting is unnecessary and stale counters cause infinite loops.
  if (isRecoverySameFile && receivedCount > 0) {
    log.debug(`[file-start] Same file re-sent (recovery). Resetting from scratch.`);
  }

  postCommand({
    command: 'STORAGE_START',
    queueItemId,
    filename: data.name as string,
    mime: (data.mime as string) || '',
    isPreload: false,
    sessionId: validateSessionId(incomingSid),
    size: CHUNK_SIZE,
  });

  setState('transfer.receivedCount', 0);
  setState('transfer.meta', {
    queueItemId,
    indexHint,
    name: data.name as string,
    mime: (data.mime as string) || '',
    size: data.size as number,
    total: data.total as number,
    sessionId: incomingSid,
  });
  setPlaybackTransferState(TRANSFER_STATE.RECEIVING);
  // Reset stale-burst tracking — a valid FILE_START means we're back on track
  setState('transfer.staleChunkBurstStart', 0);
  setState('transfer.staleChunkBurstCount', 0);

  fileReorderBuffer.clear();
  nextExpectedChunk = 0;

  startChunkWatchdog();

  showLoader(true, t('transfer.receiving_0pct'));
}

// Preload has no resume protocol; store reconciliation below is intentionally
// limited to the main transfer channel.
export function handleFileResume(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  const queueItemId = incomingQueueItemId(data);
  if (!queueItemId || !getQueueItemById(queueItemId)) return;
  const indexHint = findQueueItemIndex(queueItemId);

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
    meta?.queueItemId === queueItemId &&
    meta?.name === data.name &&
    Number(data.size) > 0 &&
    meta?.size === data.size &&
    meta?.total === data.total;

  // A delayed recovery response may arrive after this exact RAM session
  // finalized. Ignore only that exact transfer; same-name/size data from a
  // different session must start fresh.
  const finalizedBlob = ramReadBlob(queueItemId, false, incomingSid);
  if (resumeIdentityMatches && finalizedBlob && finalizedBlob.size === Number(data.size)) {
    log.debug(`[file-resume] "${data.name}" already finalized in store — dropping stale resume`);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    return;
  }

  if (!tryAdmitMainReceive(data)) return;
  completeAcceptedFileRequest(data, conn);

  // FILE_RESUME can also be the first surviving control frame. Do not mutate
  // lifecycle, playlist, or transfer ownership until the exact finalized-slot
  // guard above has ruled out a delayed resume for already-complete bytes.
  adoptIncomingTrackTarget(data);
  enterAcceptedMainTransfer(data, 'resume');
  transition({ type: 'FILE_RESUME', queueItemId, startChunk: Number(data.startChunk) || 0 });
  if (incomingSid > localSid) {
    setState('transfer.localSessionId', incomingSid);
  }
  setActiveFileSessionOwner(incomingSid, queueItemId);

  const startChunk = (data.startChunk as number) || 0;

  // The host's startChunk is a control-plane assertion; ramstore's contiguous
  // prefix is data-plane truth. Reuse it only inside the exact same session.
  // Any identity mismatch degrades safely to a full restart.
  const base = resumeIdentityMatches
    ? Math.min(startChunk, ramContiguousCount(queueItemId, false, incomingSid))
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
    queueItemId,
    filename: data.name as string,
    mime: (data.mime as string) || '',
    isPreload: false,
    sessionId: validateSessionId(incomingSid),
    size: CHUNK_SIZE,
    keepExisting: base > 0, // preserve existing data on resume
  });

  setState('transfer.meta', {
    queueItemId,
    indexHint,
    name: data.name as string,
    mime: (data.mime as string) || '',
    size: data.size as number,
    total: data.total as number,
    sessionId: incomingSid,
  });
  setPlaybackTransferState(TRANSFER_STATE.RECEIVING);

  startChunkWatchdog();

  // If the store is behind the asserted offset, rebase first and request a
  // replacement stream through the recovery bus so retry policy is preserved.
  if (base < startChunk) {
    bus.emit('storage:request-recovery', base);
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
  const queueItemId = incomingQueueItemId(data);
  if (!queueItemId || !getQueueItemById(queueItemId)) return;
  const indexHint = findQueueItemIndex(queueItemId);
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
  if (incomingSid >= localSid && !tryAdmitMainReceive(data)) return;

  // Reset RAM storage on new-session detection.
  if (incomingSid > localSid) {
    const chunkName = (data.name as string) || '';
    if (chunkName) {
      adoptIncomingTrackTarget(data);
      if (getState('playback.lifecycle') !== PLAYBACK_STATE.DOWNLOADING) {
        transition({
          type: 'FILE_PREPARE',
          variant: 'fresh',
          queueItemId,
          name: chunkName,
        });
      }
      transition({ type: 'FILE_START', queueItemId, sessionId: incomingSid });
    }
    setState('transfer.localSessionId', incomingSid);
    postCommand({ command: 'STORAGE_RESET', isPreload: false, sessionId: incomingSid });
    // This chunk is acting as the first surviving control frame for the new
    // session. Mirror FILE_START cleanup so an authoritative PLAY that arrived
    // first keeps its pending position through decode.
    bus.emit('storage:clear-previous-track', 'new-session-start');
    fileReorderBuffer.clear();
    nextExpectedChunk = 0;
    setState('transfer.receivedCount', 0);

    // Open the RAM slot before accepting subsequent writes.
    if (chunkName) {
      postCommand({
        command: 'STORAGE_START',
        queueItemId,
        filename: chunkName,
        mime: (data.mime as string) || '',
        isPreload: false,
        sessionId: validateSessionId(incomingSid),
        size: CHUNK_SIZE,
      });
      setPlaybackTransferState(TRANSFER_STATE.RECEIVING);
      if (data.total) {
        setState('transfer.meta', {
          queueItemId,
          indexHint,
          name: chunkName,
          total: data.total as number,
          sessionId: incomingSid,
          size: (data.size as number) || 0,
          mime: (data.mime as string) || '',
        });
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

  const sessionOwner = fileQueueItemBySession.get(incomingSid);
  if (sessionOwner && sessionOwner !== queueItemId) return;
  setActiveFileSessionOwner(incomingSid, queueItemId);
  const ownedMeta = getState('transfer.meta');
  if (
    ownedMeta &&
    (Number(ownedMeta.sessionId) !== incomingSid || ownedMeta.queueItemId !== queueItemId)
  ) {
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
  // enforces a non-negative safe integer for chunkIndex, but we repeat the
  // guard here because the chunk index is ultimately keyed into a Map — any leak of a malformed value
  // (negative, NaN, Infinity, or beyond meta.total) would bloat memory or
  // stall the drain loop. If meta.total is known and chunkIndex exceeds it,
  // drop the chunk; otherwise accept as usual.
  const chunkIndex = data.chunkIndex as number;
  if (!Number.isFinite(chunkIndex) || chunkIndex < 0 || !Number.isInteger(chunkIndex)) {
    log.warn(`[Transfer] Dropping chunk with invalid chunk index: ${chunkIndex}`);
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
  let receivedCount = getState('transfer.receivedCount');

  // Meta-recovery: if we missed FILE_START, extract meta from chunk data
  if (!meta || meta.total === undefined || meta.total === 0) {
    if (data.total !== undefined && Number(data.total) > 0) {
      const recoveredName = (data.name as string) || meta?.name || '';
      const recoveredMeta = {
        queueItemId,
        indexHint,
        name: recoveredName,
        total: data.total as number,
        sessionId: incomingSid,
        size: (data.size as number) || 0,
        mime: (data.mime as string) || '',
      };
      setState('transfer.meta', recoveredMeta);
      setPlaybackTransferState(TRANSFER_STATE.RECEIVING);

      const fname = (recoveredMeta.name as string) || '';
      if (fname) {
        postCommand({
          command: 'STORAGE_START',
          queueItemId,
          filename: fname,
          mime: recoveredMeta.mime,
          isPreload: false,
          sessionId: validateSessionId(incomingSid),
          size: CHUNK_SIZE,
        });
      }
      // Reset chunk pointer for new file (mirrors handleFileStart/handleFileResume)
      nextExpectedChunk = 0;
      setState('transfer.receivedCount', 0);
      log.debug(`[FileChunk] Recovered meta from chunk: ${fname} (${recoveredMeta.total} chunks)`);

      // Re-read after meta-recovery updated state (prevents stale reference)
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
      queueItemId,
      chunk: isArrayBuffer(chunk) ? chunk : ((chunk as Uint8Array).buffer as ArrayBuffer),
      chunkIndex: nextExpectedChunk,
      isPreload: false,
      filename: (getState('transfer.meta')?.name as string) || '',
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
    fileQueueItemBySession.delete(incomingSid);

    // Notify Host that we have this file (dedup via preload.ackSent)
    if (currentMeta?.queueItemId === queueItemId) {
      const ackSent = getState('preload.ackSent');
      if (ackSent.get(queueItemId) !== incomingSid) {
        const updatedAckSent = new Map(ackSent);
        updatedAckSent.set(queueItemId, incomingSid);
        setState('preload.ackSent', updatedAckSent);
        sendToHost({ type: MSG.PRELOAD_ACK, queueItemId, sessionId: incomingSid });
      }
    }

    // Finalize in storage
    postCommand({
      command: 'STORAGE_END',
      queueItemId,
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
  const queueItemId = incomingQueueItemId(data);
  if (!queueItemId) return;

  if (shouldSkipIncomingFile(data)) return;

  // Ignore stale FILE_END from old sessions
  const incomingSid = data.sessionId as number;
  if (!Number.isSafeInteger(incomingSid) || incomingSid <= 0) return;
  const localSid = getState('transfer.localSessionId');
  if (incomingSid && incomingSid < localSid) return;
  const meta = getState('transfer.meta');
  if (meta?.queueItemId !== queueItemId || Number(meta.sessionId) !== incomingSid) return;

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
  const requestOwner = matchFileWaitResponse(conn, data);
  if (!requestOwner) return;

  log.debug('[Guest] FILE_WAIT received — host has no data ready yet');
  showToast(t('transfer.file_wait'));

  // playback.ts owns bounded retries for identity repair. Falling through to
  // the generic timer would reintroduce a stale guest target into
  // REQUEST_DATA_RECOVERY and defeat the host-authoritative selector.
  if (data.reason === 'missing_transfer_identity') {
    clearManagedTimer('fileWaitTimeout');
    return;
  }

  clearManagedTimer('fileWaitTimeout');
  setManagedTimer(
    'fileWaitTimeout',
    () => {
      // A subsequent request, queue target, or host connection supersedes this
      // wait. Revalidate before any user-visible fallback or recovery action.
      if (!isCurrentFileRequestOwner(requestOwner)) return;

      const receivedCount = getState('transfer.receivedCount');
      if (receivedCount === 0) {
        const queueItem = getQueueItemById(requestOwner.queueItemId);
        if (!queueItem) {
          log.warn('[file-wait timeout] Requested queue item no longer exists');
          return;
        }

        // PRO persistent media is location agnostic: every device retries the
        // control request and downloads from the room bucket with its own
        // authenticated presign. Only ordinary remote guests depend on a
        // remote-share descriptor and may enter its unavailable UI.
        const isProDirect = isProRoomPersistentPlaylistFile(requestOwner.queueItemId);
        if (isRemoteGuest() && !isProDirect) {
          log.info('[file-wait timeout] Remote guest — remote share unavailable');
          showRemoteUnavailableUI({
            queueItemId: requestOwner.queueItemId,
            name: queueItem.name,
          });
          return;
        }

        // Continue only on the exact host DataConnection that owned the
        // request. Peer IDs can be reused after reconnects.
        if (getState('network.hostConn') === requestOwner.hostConn && requestOwner.hostConn.open) {
          const pendingFileName = queueItem.name;

          // Check if preload is in progress for this track
          const preloadTarget = getState('preload.activeTarget');
          if (preloadTarget?.queueItemId === requestOwner.queueItemId) {
            log.debug('[file-wait timeout] Preload in progress for this track, waiting...');
            showToast(t('transfer.preload_waiting'));
            return;
          }

          log.debug(
            `[file-wait timeout] Requesting from Host: ${pendingFileName} queueItemId: ${requestOwner.queueItemId}`,
          );
          const recoveryOwner = beginFileRequest(
            requestOwner.hostConn,
            requestOwner.queueItemId,
            requestOwner.sessionId,
          );
          sendFileRequest(recoveryOwner, {
            type: MSG.REQUEST_DATA_RECOVERY,
            nextChunk: 0,
            fileName: pendingFileName,
          });
        }
      }
    },
    10000,
  );
}

// ─── Debug: Memory Stats ─────────────────────────────────────────────
//
// Exposes the module-local main-transfer reorder-buffer footprint for
// `/debug memory`. Hot-path safe: only called from the chat command handler.

export function getTransferMemoryStats(): {
  ownerSessions: number;
  reorderSessions: number;
  reorderChunks: number;
  reorderBytes: number;
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
  return {
    ownerSessions: fileQueueItemBySession.size,
    reorderSessions: fileReorderBuffer.size,
    reorderChunks: chunks,
    reorderBytes: bytes,
    nextExpectedChunk,
  };
}

// ─── Session Cleanup (exported for initTransfer) ─────────────────────

function clearReceiveState(): void {
  // Invalidate FILE_PREPARE handlers suspended in connection classification.
  _filePrepareGeneration++;
  fileReorderBuffer.clear();
  fileQueueItemBySession.clear();
  rejectedMainSessionId = 0;
  nextExpectedChunk = 0;
  setState('transfer.staleChunkBurstStart', 0);
  setState('transfer.staleChunkBurstCount', 0);
}

/**
 * Reset every receive-side monotonic owner at a host-authority boundary.
 * Session IDs are scoped to a host runtime; carrying an old high-water mark
 * into a replacement connection would reject that host's fresh SID 1 frames.
 */
export function resetIncomingTransferAuthority(): void {
  clearReceiveState();
  lastChunkTime = 0;
  batchSetState({
    'transfer.receivedCount': 0,
    'transfer.lastReceivedCountSnapshot': 0,
    'transfer.meta': null,
    'transfer.localSessionId': 0,
    'transfer.currentSessionId': 0,
    'transfer.activeBroadcastSession': null,
  });
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
