/**
 * Remote file sharing over temporary encrypted object storage.
 *
 * This is intentionally a side path: LAN P2P transfer remains the primary
 * path, while remote/unknown guests receive an encrypted R2 descriptor.
 *
 * Foreground playback and speculative next-track delivery use separate lanes.
 * When the speculative object becomes current, its exact queue/session owner
 * is promoted in place so the already-running download never restarts.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { batchSetState, getState, setState } from '../core/state.ts';
import { MSG, PLAYBACK_STATE } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import { stripRecognizedAudioFileExtension } from '../media/audio-file.ts';
import { broadcastSystemMessage, sendSystemMessage } from '../chat/protocol.ts';
import { registerHandlers } from '../network/protocol.ts';
import {
  isRemoteGuest,
  safeSend,
  sendToHost,
  waitForGuestConnectionType,
} from '../network/peer.ts';
import { transition } from '../player/lifecycle.ts';
import { legacyBoundedFileV1Product } from '../player/legacy-bounded-file-v1-product.ts';
import { createFileTrackMeta, isExternalOwner, setPlaybackTrackMeta } from '../player/ownership.ts';
import {
  currentAudioBufferPcmBytes,
  getPendingPlayTime,
  getPendingPlayTimeSetAt,
  liveAudioBufferPcmBytes,
  setPendingPlayTime,
  setPendingRecoveryTarget,
} from '../player/_state.ts';
import {
  isAudioDecodeAdmissionError,
  reserveRemoteTransportMemoryWithinBudget,
  resolveDecodeMemoryBudget,
  waitForInFlightMemoryReservationChange,
  type RemoteTransportMemoryReservation,
} from '../player/decode-admission.ts';
import {
  adoptExternalStoredFileAdmission,
  rebindResidentStoredFileAdmission,
} from '../storage/storage.ts';
import { showLoader, showToast, updateLoader } from '../ui/toast.ts';
import { uploadRemoteFile } from './remote-upload.ts';
import { downloadRemoteFile } from './remote-download.ts';
import { isRemoteShareConfigured } from './r2-client.ts';
import { isCapabilityChallengeCancelled } from '../core/capability.ts';
import type {
  AnyProtocolMsg,
  DataConnection,
  ProtocolMsg,
  QueueItemId,
  RemoteFileSharePayload,
  ResidentFile,
} from '../types/index.ts';
import {
  findQueueItemIndex,
  getQueueItemById,
  selectQueueItemById,
} from '../player/queue-model.ts';
import { isPeerConnectionCurrent } from '../storage/chunk-pump.ts';
import { completeFileRequest } from '../network/file-request-authority.ts';
import {
  getR2FileTargets,
  markLocalFileR2Capable,
  markLateLocalPeerForR2,
  recordGuestFileDelivery,
  releaseFileDeliveryPeer,
  resetFileDeliveryPolicies,
  shouldConnectionUseR2,
} from './file-delivery-policy.ts';

const REMOTE_WAIT_TIMER = 'remote-share-wait-timeout';
const REMOTE_WAIT_MS = 5 * 60_000 + 15_000;
const REMOTE_UPLOAD_LOADER = 'remote-share-upload';
// Treat a descriptor as expired if it would expire within this window —
// avoids handing out a 30-second-window URL to a guest who'd race the TTL.
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

/** One switch for disabling speculative R2 traffic without changing playback. */
const REMOTE_FILE_PRELOAD_ENABLED = true;

interface UploadEntry {
  key: string;
  sessionId: number;
  queueItemId: QueueItemId;
  promise: Promise<RemoteFileSharePayload>;
  abort: AbortController;
  preload: boolean;
  stage: 'encrypting' | 'uploading';
  progress: number;
}

interface DownloadEntry {
  objectId: string;
  /** Latest playback context for this object. The bytes may stay the same while
   * queueItemId/sessionId advances, so completion publishes through this descriptor. */
  descriptor: RemoteFileSharePayload;
  abort: AbortController;
  intent: 'foreground' | 'preload';
  progress: number;
}

// Upload tracking stays keyed by playback request. Navigating to another
// track does not cancel an upload: completion-time gates suppress stale
// broadcasts, while the finished descriptor warms the cache and the shared
// promise remains available to recovery callers. Uploads are aborted only
// when no remote targets remain or the session is torn down.
const _activeUploads = new Map<string, UploadEntry>();
// Completed descriptors are keyed by browser File object identity. Metadata
// such as name/size/lastModified is not content identity and may collide.
const _descriptorCache = new Map<string, RemoteFileSharePayload>();
let _fileIds = new WeakMap<File, number>();
let _nextFileId = 1;

// Only one active (foreground) download at a time. A newer one supersedes
// the in-flight one via abort.
let _activeDownload: DownloadEntry | null = null;
// One independent speculative next-track download. Promotion transfers this
// exact entry to _activeDownload; its XHR/decrypt promise continues untouched.
let _activePreloadDownload: DownloadEntry | null = null;
// A current-track GET has strict priority, but the host sends a preload
// descriptor only once. Keep the newest validated hint and start it as soon as
// the foreground reservation is released instead of silently dropping it.
let _deferredPreloadDescriptor: RemoteFileSharePayload | null = null;
// Deferred work is resumed from a microtask so foreground completion can hand
// its resident to the decoder before the next preload claims preload.ready.
let _remotePreloadDrainQueued = false;

/** @internal Focused ownership seam for remote-preload race tests. */
export function getRemotePreloadOwnershipForTests(): {
  foregroundQueueItemId: QueueItemId | null;
  preloadQueueItemId: QueueItemId | null;
  deferredQueueItemId: QueueItemId | null;
} {
  return {
    foregroundQueueItemId: _activeDownload?.descriptor.queueItemId ?? null,
    preloadQueueItemId: _activePreloadDownload?.descriptor.queueItemId ?? null,
    deferredQueueItemId: _deferredPreloadDescriptor?.queueItemId ?? null,
  };
}

// Last adopted playback context. This survives download completion so late
// control responses cannot rewind the active queue occurrence or trigger another fetch.
// It resets at every session boundary because sessionId ordering is per host.
let _lastAdoptedRemoteContext: {
  objectId: string;
  queueItemId: QueueItemId;
  sessionId: number;
} | null = null;
let _remoteDescriptorGeneration = 0;
let _observedHostConn: DataConnection | null = null;

interface RemoteDescriptorOwnerSnapshot {
  generation: number;
  hostConn: DataConnection | null;
  currentQueueItemId: QueueItemId | null;
  pendingQueueItemId: QueueItemId | null;
  transferQueueItemId: QueueItemId | null;
  transferSessionId: number;
  activeDownload: DownloadEntry | null;
}

function captureRemoteDescriptorOwner(): RemoteDescriptorOwnerSnapshot {
  const pending = getState('playback.pendingRecoveryTarget');
  const meta = getState('transfer.meta');
  return {
    generation: ++_remoteDescriptorGeneration,
    hostConn: getState('network.hostConn'),
    currentQueueItemId: getState('playlist.currentQueueItemId'),
    pendingQueueItemId: pending?.queueItemId ?? null,
    transferQueueItemId: meta?.queueItemId ?? null,
    transferSessionId: Number(meta?.sessionId) || 0,
    activeDownload: _activeDownload,
  };
}

function transferOwnerSupersedesDescriptor(
  queueItemId: QueueItemId | null,
  sessionId: number,
  descriptor: RemoteFileSharePayload,
): boolean {
  return (
    sessionId > descriptor.sessionId ||
    (sessionId === descriptor.sessionId &&
      queueItemId !== null &&
      queueItemId !== descriptor.queueItemId)
  );
}

/**
 * Connection classification is asynchronous. Do not let an older descriptor
 * resume after a newer FILE_PREPARE/descriptor, host replacement, or queue
 * removal has transferred ownership. An unchanged null current target remains
 * valid for fresh-join bootstrap.
 */
function isRemoteDescriptorOwnerCurrent(
  snapshot: RemoteDescriptorOwnerSnapshot,
  descriptor: RemoteFileSharePayload,
  conn: DataConnection | undefined,
): boolean {
  if (
    snapshot.generation !== _remoteDescriptorGeneration ||
    !snapshot.hostConn ||
    getState('network.hostConn') !== snapshot.hostConn ||
    conn !== snapshot.hostConn ||
    !getQueueItemById(descriptor.queueItemId)
  ) {
    return false;
  }

  const currentQueueItemId = getState('playlist.currentQueueItemId');
  if (
    currentQueueItemId !== snapshot.currentQueueItemId &&
    currentQueueItemId !== descriptor.queueItemId
  ) {
    return false;
  }

  const pendingQueueItemId = getState('playback.pendingRecoveryTarget')?.queueItemId ?? null;
  if (
    pendingQueueItemId !== snapshot.pendingQueueItemId &&
    pendingQueueItemId !== descriptor.queueItemId
  ) {
    return false;
  }

  const meta = getState('transfer.meta');
  const transferQueueItemId = meta?.queueItemId ?? null;
  const transferSessionId = Number(meta?.sessionId) || 0;
  if (transferOwnerSupersedesDescriptor(transferQueueItemId, transferSessionId, descriptor)) {
    return false;
  }

  const active = _activeDownload;
  if (
    active !== snapshot.activeDownload &&
    active &&
    (transferOwnerSupersedesDescriptor(
      active.descriptor.queueItemId,
      active.descriptor.sessionId,
      descriptor,
    ) ||
      (active.descriptor.sessionId === descriptor.sessionId &&
        active.descriptor.queueItemId === descriptor.queueItemId &&
        active.objectId !== descriptor.objectId))
  ) {
    return false;
  }

  return true;
}

function adoptRemoteContext(descriptor: RemoteFileSharePayload): void {
  _lastAdoptedRemoteContext = {
    objectId: descriptor.objectId,
    queueItemId: descriptor.queueItemId,
    sessionId: descriptor.sessionId,
  };
}
let _lastUploadFailureMessageAt = 0;
let _lastStorageQuotaMessageAt = 0;

function rawRemoteShareError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clearStaleRemotePlayback(reason: string): void {
  const pendingTime = getPendingPlayTime();
  const pendingSetAt = getPendingPlayTimeSetAt();
  bus.emit('storage:clear-previous-track', reason);
  if (pendingTime !== undefined) setPendingPlayTime(pendingTime, pendingSetAt);
}

function toRemoteShareMessage(descriptor: RemoteFileSharePayload, preload = false): AnyProtocolMsg {
  return {
    type: MSG.REMOTE_FILE_SHARE,
    ...descriptor,
    delivery: 'r2',
    ...(preload ? { preload: true as const } : {}),
  } as AnyProtocolMsg;
}

function toRemoteFileUnavailableMessage(
  file: File,
  sessionId: number,
  queueItemId: QueueItemId,
  limited: boolean,
): AnyProtocolMsg {
  return {
    type: MSG.REMOTE_FILE_UNAVAILABLE,
    name: file.name,
    queueItemId,
    sessionId,
    limited,
    delivery: 'r2',
  } as AnyProtocolMsg;
}

function hasR2Targets(sessionId: number): boolean {
  return getR2FileTargets(sessionId).length > 0;
}

function isDescriptorFresh(descriptor: RemoteFileSharePayload | null): boolean {
  if (!descriptor) return false;
  return descriptor.expiresAt - Date.now() > EXPIRY_SAFETY_MARGIN_MS;
}

function fileIdentity(file: File): number {
  let id = _fileIds.get(file);
  if (id === undefined) {
    id = _nextFileId++;
    _fileIds.set(file, id);
  }
  return id;
}

function uploadRequestKey(file: File, sessionId: number, queueItemId: QueueItemId): string {
  return JSON.stringify([sessionId, queueItemId, fileIdentity(file)]);
}

function currentRemoteShareRoomId(): string {
  return getState('network.sessionCode') || getState('network.myId') || 'room';
}

function descriptorCacheKey(file: File, roomId: string): string {
  return JSON.stringify([roomId, fileIdentity(file)]);
}

function withPlaybackContext(
  descriptor: RemoteFileSharePayload,
  sessionId: number,
  queueItemId: QueueItemId,
): RemoteFileSharePayload {
  if (descriptor.sessionId === sessionId && descriptor.queueItemId === queueItemId)
    return descriptor;
  return { ...descriptor, sessionId, queueItemId };
}

function isHostActiveFile(file: File, queueItemId: QueueItemId): boolean {
  if (getState('playlist.currentQueueItemId') !== queueItemId) return false;

  const resident = getState('files.current');
  if (resident?.queueItemId === queueItemId && resident.blob === file) return true;

  // A caller can begin while the selected playlist item is current but before
  // its blob publication becomes observable. Exact File identity on the same
  // queue occurrence is the only safe fallback.
  const item = getQueueItemById(queueItemId);
  return item?.file === file;
}

function isHostPreloadFile(file: File, queueItemId: QueueItemId, sessionId: number): boolean {
  const item = getQueueItemById(queueItemId);
  const ready = getState('preload.ready');
  const target = getState('preload.activeTarget');
  return (
    item?.file === file &&
    ready?.blob === file &&
    ready.queueItemId === queueItemId &&
    ready.sessionId === sessionId &&
    target?.queueItemId === queueItemId &&
    target.sessionId === sessionId
  );
}

function showUploadProgress(message: string, progress = 0): void {
  showLoader(true, message, REMOTE_UPLOAD_LOADER);
  updateLoader(Math.round(progress * 100), REMOTE_UPLOAD_LOADER);
}

/**
 * Map internal error codes to user-facing toast messages. Falls back to the
 * raw message if no mapping exists — better to show something than nothing,
 * but keeps internal tokens out of the UI for the common cases.
 */
function friendlyErrorMessage(error: unknown): string {
  const raw = rawRemoteShareError(error);
  if (raw === 'REMOTE_SHARE_FILE_TOO_LARGE') return t('share.remote.too_large');
  if (
    raw === 'REMOTE_SHARE_UPLOAD_NETWORK' ||
    raw === 'REMOTE_SHARE_DOWNLOAD_NETWORK' ||
    raw === 'REMOTE_SHARE_UPLOAD_STALLED' ||
    raw === 'REMOTE_SHARE_DOWNLOAD_STALLED' ||
    raw === 'REMOTE_SHARE_SESSION_NETWORK' ||
    raw === 'REMOTE_SHARE_COMPLETE_NETWORK' ||
    raw === 'REMOTE_SHARE_SESSION_HTTP_503' ||
    raw === 'REMOTE_SHARE_COMPLETE_HTTP_503'
  ) {
    return t('share.remote.network_error');
  }
  if (
    raw === 'REMOTE_SHARE_UPLOAD_HTTP_429' ||
    raw === 'REMOTE_SHARE_SESSION_HTTP_429' ||
    raw === 'REMOTE_SHARE_COMPLETE_HTTP_429' ||
    raw === 'REMOTE_SHARE_DIRECT_UPLOAD_HTTP_429'
  ) {
    return t('share.remote.rate_limited');
  }
  if (raw === 'REMOTE_SHARE_SESSION_HTTP_409' || raw === 'REMOTE_SHARE_COMPLETE_HTTP_409') {
    return t('share.remote.quota_reached');
  }
  if (
    raw === 'REMOTE_SHARE_BAD_SESSION_RESPONSE' ||
    raw === 'REMOTE_SHARE_BAD_COMPLETE_RESPONSE' ||
    raw === 'REMOTE_SHARE_ENCRYPTED_SIZE_MISMATCH' ||
    raw === 'REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID' ||
    raw === 'REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH' ||
    raw === 'REMOTE_SHARE_PLAINTEXT_SIZE_MISMATCH' ||
    raw === 'REMOTE_SHARE_SESSION_HTTP_403' ||
    raw === 'REMOTE_SHARE_SESSION_HTTP_404' ||
    raw === 'REMOTE_SHARE_SESSION_HTTP_500' ||
    raw === 'REMOTE_SHARE_UPLOAD_HTTP_403' ||
    raw === 'REMOTE_SHARE_DIRECT_UPLOAD_HTTP_403' ||
    raw === 'REMOTE_SHARE_COMPLETE_HTTP_403' ||
    raw === 'REMOTE_SHARE_COMPLETE_HTTP_404' ||
    raw === 'REMOTE_SHARE_COMPLETE_HTTP_500'
  ) {
    return t('share.remote.auth_failed');
  }
  if (raw === 'REMOTE_SHARE_DIRECT_UPLOAD_HTTP_413' || raw === 'REMOTE_SHARE_COMPLETE_HTTP_413') {
    return t('share.remote.too_large');
  }
  if (raw.startsWith('REMOTE_SHARE_DOWNLOAD_HTTP_404')) return t('share.remote.expired');
  if (raw === 'REMOTE_SHARE_ABORTED') return raw; // never user-visible
  return raw;
}

function isUploadLimitError(error: unknown): boolean {
  const raw = rawRemoteShareError(error);
  return (
    raw === 'REMOTE_SHARE_UPLOAD_HTTP_429' ||
    raw === 'REMOTE_SHARE_SESSION_HTTP_429' ||
    raw === 'REMOTE_SHARE_COMPLETE_HTTP_429' ||
    raw === 'REMOTE_SHARE_DIRECT_UPLOAD_HTTP_429'
  );
}

function isStorageQuotaError(error: unknown): boolean {
  const raw = rawRemoteShareError(error);
  return raw === 'REMOTE_SHARE_SESSION_HTTP_409' || raw === 'REMOTE_SHARE_COMPLETE_HTTP_409';
}

function getR2MessageTargets(sessionId: number, targetConn?: DataConnection): DataConnection[] {
  if (targetConn?.open) {
    return shouldConnectionUseR2(targetConn, sessionId) ? [targetConn] : [];
  }
  return getR2FileTargets(sessionId);
}

function maybeNotifyRemoteUploadFailure(
  error: unknown,
  file: File,
  sessionId: number,
  queueItemId: QueueItemId,
  targetConn?: DataConnection,
): void {
  const now = Date.now();
  const targets = getR2MessageTargets(sessionId, targetConn);
  if (targets.length === 0) return;

  const quotaReached = isStorageQuotaError(error);
  const limited = quotaReached || isUploadLimitError(error);
  const unavailable = toRemoteFileUnavailableMessage(file, sessionId, queueItemId, limited);
  for (const conn of targets) {
    safeSend(conn, unavailable);
  }

  if (quotaReached) {
    if (now - _lastStorageQuotaMessageAt < 60_000) return;
    _lastStorageQuotaMessageAt = now;
    broadcastSystemMessage('chat.remote_storage_quota_system_message');
    return;
  }
  if (now - _lastUploadFailureMessageAt < 60_000) return;
  _lastUploadFailureMessageAt = now;
  const key = limited
    ? 'chat.remote_upload_limited_system_message'
    : 'chat.remote_upload_failed_system_message';
  for (const conn of targets) {
    sendSystemMessage(conn, key);
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.message === 'REMOTE_SHARE_ABORTED') return true;
  // A user-cancelled capability challenge follows the silent abort path.
  return isCapabilityChallengeCancelled(error);
}

function resetRemoteDownloadState(message: string | null = null): void {
  const remote = getState('share.remote');
  setState('share.remote', {
    ...remote,
    download: {
      status: 'idle',
      progress: 0,
      error: message,
    },
  });
}

/**
 * Release the wait owned by a failed foreground download. A superseded
 * download may settle after its successor has installed a new watchdog, so
 * ownership is the AbortController identity rather than objectId alone.
 */
function releaseOwnedRemoteWaitAfterDownloadFailure(abort: AbortController): boolean {
  if (_activeDownload?.abort !== abort) return false;
  clearManagedTimer(REMOTE_WAIT_TIMER);
  if (getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD) {
    transition({ type: 'REMOTE_FILE_UNAVAILABLE' });
  }
  return true;
}

function ownsLiveRemoteWait(abort: AbortController): boolean {
  const active = _activeDownload;
  if (!active || active.abort !== abort || abort.signal.aborted) return false;

  const descriptor = active.descriptor;
  const recoveryTarget = getState('playback.pendingRecoveryTarget');
  const waitMeta = getState('preload.activeTarget');
  return (
    getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD &&
    recoveryTarget?.queueItemId === descriptor.queueItemId &&
    recoveryTarget.name === descriptor.name &&
    Number(waitMeta?.sessionId) === descriptor.sessionId &&
    waitMeta?.objectId === descriptor.objectId
  );
}

function resetRemoteUploadState(message: string | null = null): void {
  const remote = getState('share.remote');
  setState('share.remote', {
    ...remote,
    upload: {
      status: 'idle',
      progress: 0,
      objectId: null,
      expiresAt: null,
      error: message,
    },
  });
}

function publishForegroundUploadProgress(entry: UploadEntry): void {
  const remote = getState('share.remote');
  setState('share.remote', {
    ...remote,
    upload: {
      status: entry.stage,
      progress: entry.progress,
      objectId: null,
      expiresAt: null,
      error: null,
    },
  });
  showUploadProgress(
    t(entry.stage === 'encrypting' ? 'share.remote.encrypting' : 'share.remote.uploading'),
    entry.progress,
  );
}

function publishForegroundUploadDone(descriptor: RemoteFileSharePayload): void {
  const remote = getState('share.remote');
  setState('share.remote', {
    ...remote,
    upload: {
      status: 'done',
      progress: 1,
      objectId: descriptor.objectId,
      expiresAt: descriptor.expiresAt,
      error: null,
    },
  });
}

function abortActiveUploadsWithoutTargets(reason: string): void {
  if (getState('network.hostConn')) return;
  if (_activeUploads.size === 0) return;
  let abortedForegroundUpload = false;

  for (const [key, entry] of _activeUploads) {
    if (hasR2Targets(entry.sessionId)) continue;
    if (!entry.preload) abortedForegroundUpload = true;
    entry.abort.abort();
    _activeUploads.delete(key);
  }

  // A surviving speculative next-track upload must not keep a cancelled
  // foreground loader and progress state on screen.
  const hasForegroundUpload = [..._activeUploads.values()].some((entry) => !entry.preload);
  if (abortedForegroundUpload && !hasForegroundUpload) {
    resetRemoteUploadState();
    showLoader(false, undefined, REMOTE_UPLOAD_LOADER);
  }
  if (_activeUploads.size > 0) return;
  if (!abortedForegroundUpload) resetRemoteUploadState();
  log.info(`[RemoteShare] Active upload cancelled (${reason})`);
}

export function cancelRemoteShareWait(reason: string): void {
  // Supersede descriptors suspended in connection-type classification.
  _remoteDescriptorGeneration++;
  const hadActiveDownload = !!_activeDownload;

  // A deferred next-track descriptor is subordinate to the foreground wait
  // that kept it queued. Once that wait is explicitly cancelled, allowing its
  // finally block to drain the old descriptor could resurrect a track from a
  // superseded playlist/playback owner.
  const deferred = _deferredPreloadDescriptor;
  const authoritativeCurrentQueueItemId = getState('playlist.currentQueueItemId');
  const preservePromotedSuccessor =
    reason === 'playlist-current-removed' &&
    !!deferred &&
    deferred.queueItemId === authoritativeCurrentQueueItemId &&
    !!getQueueItemById(deferred.queueItemId);
  if (!preservePromotedSuccessor) _deferredPreloadDescriptor = null;

  if (_activeDownload) {
    _activeDownload.abort.abort();
    _activeDownload = null;
  }

  clearManagedTimer(REMOTE_WAIT_TIMER);
  if (hadActiveDownload || getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD) {
    resetRemoteDownloadState();
    showLoader(false);
  }

  if (hadActiveDownload) {
    log.info(`[RemoteShare] Active remote download cancelled (${reason})`);
  }
  if (preservePromotedSuccessor) scheduleDeferredRemotePreloadDrain();
}

/** Cancel only speculative R2 work; foreground remote playback is untouched. */
export function cancelRemoteFilePreload(reason: string, queueItemId?: QueueItemId): void {
  const active = _activePreloadDownload;
  let cancelledDownload = false;
  const deferred = _deferredPreloadDescriptor;
  const hadDeferred = !!deferred && (!queueItemId || deferred.queueItemId === queueItemId);
  if (hadDeferred) _deferredPreloadDescriptor = null;
  if (active && (!queueItemId || active.descriptor.queueItemId === queueItemId)) {
    active.abort.abort();
    _activePreloadDownload = null;
    clearOwnedRemotePreloadState(active);
    cancelledDownload = true;
  }

  // Host uploads use the same in-flight promise when a preloaded track is
  // promoted. A foreground caller flips entry.preload to false before waiting,
  // so cancellation only aborts uploads that still have speculative ownership.
  let cancelledUploads = 0;
  for (const [key, entry] of _activeUploads) {
    if (!entry.preload || (queueItemId && entry.queueItemId !== queueItemId)) continue;
    entry.abort.abort();
    _activeUploads.delete(key);
    cancelledUploads++;
  }

  if (cancelledDownload || hadDeferred || cancelledUploads > 0) {
    log.debug(
      `[RemoteShare] Background preload cancelled (${reason}; uploads=${cancelledUploads})`,
    );
  }
}

/**
 * Promote an in-flight speculative download as soon as PLAY_PRELOADED arrives.
 * Waiting for the follow-up descriptor would create a small race where the
 * background owner is cleared by the foreground wait before completion.
 */
export function promoteRemotePreloadWait(queueItemId: QueueItemId, name: string): boolean {
  const entry = _activePreloadDownload;
  if (entry) {
    if (
      entry.abort.signal.aborted ||
      entry.descriptor.queueItemId !== queueItemId ||
      (name && entry.descriptor.name !== name) ||
      !getQueueItemById(queueItemId)
    ) {
      return false;
    }

    _activePreloadDownload = null;
    _activeDownload?.abort.abort();
    _activeDownload = entry;
    entry.descriptor = { ...entry.descriptor, preload: undefined };
    adoptRemoteContext(entry.descriptor);
    enterForegroundRemoteDownload(entry, true);
    log.info(`[RemoteShare] PLAY_PRELOADED promoted remote preload (${queueItemId})`);
    return true;
  }

  // The hint may be queued behind the previous current-file GET. Selection
  // transfers priority immediately and consumes that already-authenticated
  // descriptor instead of waiting for a second host message.
  const deferred = _deferredPreloadDescriptor;
  if (
    !deferred ||
    deferred.queueItemId !== queueItemId ||
    (name && deferred.name !== name) ||
    !getQueueItemById(queueItemId)
  ) {
    return false;
  }
  _deferredPreloadDescriptor = null;
  _activeDownload?.abort.abort();
  const promoted: DownloadEntry = {
    objectId: deferred.objectId,
    descriptor: { ...deferred, preload: undefined },
    abort: new AbortController(),
    intent: 'foreground',
    progress: 0,
  };
  _activeDownload = promoted;
  adoptRemoteContext(promoted.descriptor);
  enterForegroundRemoteDownload(promoted);
  void runRemoteDownload(promoted);
  log.info(`[RemoteShare] PLAY_PRELOADED activated queued remote preload (${queueItemId})`);
  return true;
}

export function shouldWaitForRemoteShare(): boolean {
  return isRemoteShareConfigured();
}

interface ShareRemoteFileOptions {
  /** Stable queue occurrence that owns this upload. */
  queueItemId?: QueueItemId;
  /** Publish as a silent next-track descriptor rather than active playback. */
  preload?: boolean;
}

/**
 * Speculatively upload the exact host preload owner for R2-routed guests.
 * This is deliberately a narrow wrapper so the policy can later be disabled
 * without touching the local P2P preload path.
 */
export async function preloadRemoteFileIfNeeded(
  file: File,
  sessionId: number,
  queueItemId: QueueItemId,
  targetConn?: DataConnection,
): Promise<void> {
  if (!REMOTE_FILE_PRELOAD_ENABLED) return;
  await shareRemoteFileIfNeeded(file, sessionId, targetConn, { queueItemId, preload: true });
}

/**
 * Host-side: encrypt + upload the file and broadcast the descriptor to
 * remote guests. Completed uploads are reused for the same file while fresh,
 * rebasing the wire descriptor to the current queue occurrence and session.
 * In-flight uploads remain scoped to the original playback request so
 * cancellation stays narrow during rapid track switches.
 */
export async function shareRemoteFileIfNeeded(
  file: File,
  sessionId: number | null,
  targetConn?: DataConnection,
  options?: ShareRemoteFileOptions,
): Promise<void> {
  if (getState('network.hostConn')) return;
  // Persistent PRO media already lives in the private room bucket. Every
  // participant downloads that canonical object directly; re-encrypting and
  // uploading a second transient copy would waste memory, storage, and uplink.
  if (getState('room.context').kind === 'pro') return;
  if (!isRemoteShareConfigured()) return;
  if (sessionId === null) return;
  if (!targetConn && !hasR2Targets(sessionId)) return;
  if (targetConn && !shouldConnectionUseR2(targetConn, sessionId)) return;

  const isPreload = options?.preload === true;
  if (isPreload && !REMOTE_FILE_PRELOAD_ENABLED) return;

  const currentResident = getState('files.current');
  const queueItemId =
    options?.queueItemId ??
    (currentResident?.blob === file ? currentResident.queueItemId : undefined);
  if (!queueItemId || !getQueueItemById(queueItemId)) return;

  const roomId = currentRemoteShareRoomId();
  const uploadKey = uploadRequestKey(file, sessionId, queueItemId);
  const cacheKey = descriptorCacheKey(file, roomId);

  try {
    let descriptor: RemoteFileSharePayload;

    // Fast path: reuse a cached, still-fresh descriptor for this file.
    const cached = _descriptorCache.get(cacheKey);
    if (cached && isDescriptorFresh(cached)) {
      descriptor = cached;
    } else {
      // Drop expired cache entry — its R2 URL would 404 for guests.
      if (cached && !isDescriptorFresh(cached)) {
        _descriptorCache.delete(cacheKey);
      }

      const inFlight = _activeUploads.get(uploadKey);
      if (inFlight) {
        // Another caller already uploading the same file — share the result.
        // Once active playback joins this promise, speculative cancellation may
        // no longer abort it; completion still serves the current-track owner.
        if (!isPreload) {
          inFlight.preload = false;
          publishForegroundUploadProgress(inFlight);
        }
        descriptor = await inFlight.promise;
        if (inFlight.abort.signal.aborted) return;
      } else {
        const abort = new AbortController();
        let currentStage: UploadEntry['stage'] = 'encrypting';
        let currentProgress = 0;
        let entry: UploadEntry | null = null;
        const promise = uploadRemoteFile(file, sessionId, queueItemId, {
          signal: abort.signal,
          publishState: !isPreload,
          onUploadProgress: (progress) => {
            currentProgress = progress;
            if (!entry) return;
            entry.progress = progress;
            if (!entry.preload) publishForegroundUploadProgress(entry);
          },
          onStageChange: (stage) => {
            currentStage = stage;
            if (!entry) return;
            entry.stage = stage;
            if (!entry.preload) publishForegroundUploadProgress(entry);
          },
        });

        entry = {
          key: uploadKey,
          sessionId,
          queueItemId,
          promise,
          abort,
          preload: isPreload,
          stage: currentStage,
          progress: currentProgress,
        };
        _activeUploads.set(uploadKey, entry);

        if (!isPreload) {
          showToast(t('share.remote.encrypting'));
          showUploadProgress(t('share.remote.encrypting'));
        }

        try {
          descriptor = await promise;
          if (abort.signal.aborted) return;
          _descriptorCache.set(cacheKey, descriptor);
        } finally {
          if (_activeUploads.get(uploadKey) === entry) _activeUploads.delete(uploadKey);
        }
      }
    }

    if (!isPreload) {
      publishForegroundUploadDone(descriptor);
      showLoader(false, undefined, REMOTE_UPLOAD_LOADER);
    }

    // Upload completion may resume long after either a room-wide publish or a
    // targeted late-join/recovery request began. Both paths obey the same
    // queue/file/playback authority: a unicast descriptor for an old track is
    // just as stale as a broadcast descriptor for that track.
    const stillOwned = isPreload
      ? isHostPreloadFile(file, queueItemId, sessionId)
      : isHostActiveFile(file, queueItemId);
    if (!stillOwned) {
      log.debug(
        `[RemoteShare] ${isPreload ? 'Preload' : 'Active'} upload completed for stale track; descriptor not published`,
      );
      return;
    }
    // Blob identity can remain current across an external-owner switch.
    // Require file ownership as well so completion cannot publish an inactive
    // file descriptor. Returning to file mode later may reuse the cached result.
    if (!isPreload && isExternalOwner()) {
      log.debug(
        '[RemoteShare] Upload completed but external playback mode owns the room; descriptor not published',
      );
      return;
    }

    if (!targetConn && !hasR2Targets(sessionId)) {
      log.debug(
        '[RemoteShare] Upload completed but no remote targets remain; descriptor not broadcast',
      );
      return;
    }
    if (targetConn && (!targetConn.open || !isPeerConnectionCurrent(targetConn.peer, targetConn))) {
      log.debug(
        '[RemoteShare] Upload completed after target connection was superseded; descriptor not sent',
      );
      return;
    }

    const outboundDescriptor = withPlaybackContext(descriptor, sessionId, queueItemId);
    const msg = toRemoteShareMessage(outboundDescriptor, isPreload);
    const targets = getR2MessageTargets(sessionId, targetConn);
    if (targets.length === 0) return;
    for (const conn of targets) safeSend(conn, msg);
    log.info(
      `[RemoteShare] Shared encrypted ${isPreload ? 'preload ' : ''}descriptor for ${outboundDescriptor.name}`,
    );
    if (!isPreload) showToast(t('share.remote.upload_ready'));
  } catch (error) {
    if (isAbortError(error)) {
      log.debug('[RemoteShare] Upload superseded — abort path is expected');
      return;
    }
    if (!isPreload) showLoader(false, undefined, REMOTE_UPLOAD_LOADER);
    if (isPreload) {
      log.debug('[RemoteShare] Speculative preload upload failed silently:', error);
      return;
    }
    const message = friendlyErrorMessage(error);
    setState('share.remote', {
      ...getState('share.remote'),
      upload: {
        status: 'error',
        progress: 0,
        objectId: null,
        expiresAt: null,
        error: message,
      },
    });
    log.warn('[RemoteShare] Upload/share failed:', error);
    maybeNotifyRemoteUploadFailure(error, file, sessionId, queueItemId, targetConn);
    showToast(t('share.remote.upload_failed', { msg: message }));
  }
}

function armRemoteWaitTimeout(
  queueItemId: QueueItemId,
  name: string,
  sessionId: number,
  objectId?: string,
): void {
  clearManagedTimer(REMOTE_WAIT_TIMER);
  setManagedTimer(
    REMOTE_WAIT_TIMER,
    () => {
      const waitMeta = getState('preload.activeTarget');
      const stillOwnsWait =
        waitMeta?.queueItemId === queueItemId &&
        Number(waitMeta.sessionId) === sessionId &&
        (!objectId || waitMeta.objectId === objectId);
      if (!stillOwnsWait) return;

      const ready = getState('preload.ready');
      if (
        ready?.queueItemId === queueItemId &&
        ready.sessionId === sessionId &&
        (!objectId || ready.objectId === objectId)
      ) {
        return;
      }
      log.warn('[RemoteShare] Wait timed out before descriptor/download completed');
      const active = _activeDownload;
      if (
        active &&
        active.descriptor.queueItemId === queueItemId &&
        active.descriptor.sessionId === sessionId &&
        active.descriptor.name === name &&
        (!objectId || active.objectId === objectId)
      ) {
        active.abort.abort();
        if (_activeDownload === active) _activeDownload = null;
      }
      // The timed-out foreground owner was the serialization barrier for any
      // deferred preload. Do not let its eventual promise settlement start a
      // descriptor that is no longer attached to live playback authority.
      _deferredPreloadDescriptor = null;
      showToast(t('share.remote.timeout'));
      showLoader(false);
      setState('share.remote', {
        ...getState('share.remote'),
        download: {
          status: 'error',
          progress: 0,
          error: t('share.remote.timeout'),
        },
      });
      // Release AWAITING_PRELOAD so later host playback can drive recovery.
      if (getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD) {
        transition({ type: 'REMOTE_FILE_UNAVAILABLE' });
      }
    },
    REMOTE_WAIT_MS,
  );
}

export function prepareRemoteShareWait(
  queueItemId: QueueItemId,
  name: string,
  sessionId: number,
  objectId?: string,
): void {
  // PLAY_PRELOADED has no session field. A fresh remote guest may establish a
  // qid-only placeholder with 0 until REMOTE_FILE_SHARE supplies the positive
  // authoritative transfer session.
  if (!shouldWaitForRemoteShare() || !Number.isSafeInteger(sessionId) || sessionId < 0) {
    return;
  }
  const indexHint = findQueueItemIndex(queueItemId);
  if (indexHint < 0) return;

  // FILE_PREPARE and REMOTE_FILE_SHARE may both establish the same wait.
  // Session is part of transfer ownership even when qid/object bytes match.
  const lifecycle = getState('playback.lifecycle');
  const recoveryTarget = getState('playback.pendingRecoveryTarget');
  const currentWaitMeta = getState('preload.activeTarget');
  const sameWaitBytes =
    lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD &&
    recoveryTarget?.queueItemId === queueItemId &&
    recoveryTarget.name === name &&
    currentWaitMeta?.queueItemId === queueItemId &&
    (!objectId || currentWaitMeta.objectId === objectId);
  const currentWaitSessionId = Number(currentWaitMeta?.sessionId) || 0;

  if (sameWaitBytes && currentWaitSessionId === sessionId) {
    log.debug('[RemoteShare] Exact wait owner already established; skipping re-arm');
    return;
  }

  if (sameWaitBytes && currentWaitSessionId > sessionId) {
    log.debug('[RemoteShare] Ignoring an older wait session for the same bytes');
    return;
  }

  if (sameWaitBytes && currentWaitSessionId < sessionId) {
    const effectiveObjectId = objectId ?? currentWaitMeta.objectId;
    const existingReady = getState('preload.ready');
    const readyHasExactBytes =
      !!effectiveObjectId &&
      existingReady?.queueItemId === queueItemId &&
      existingReady.sessionId === currentWaitSessionId &&
      existingReady.objectId === effectiveObjectId;
    const canRebindReady =
      readyHasExactBytes &&
      rebindResidentStoredFileAdmission({
        queueItemId,
        blob: existingReady.blob,
        filename: name,
        isPreload: true,
        sessionId,
      });
    const reboundMeta = {
      ...currentWaitMeta,
      queueItemId,
      indexHint,
      name,
      sessionId,
      ...(effectiveObjectId ? { objectId: effectiveObjectId } : {}),
    };
    const reboundReady = canRebindReady
      ? {
          ...existingReady,
          queueItemId,
          indexHint,
          name,
          sessionId,
          objectId: effectiveObjectId,
        }
      : null;

    setPendingRecoveryTarget({ queueItemId, indexHint, name });
    selectQueueItemById(queueItemId);
    batchSetState({
      'preload.activeTarget': reboundMeta,
      'preload.ready': reboundReady,
      'preload.nextQueueItemId': queueItemId,
      'transfer.meta': reboundMeta,
    });
    armRemoteWaitTimeout(queueItemId, name, sessionId, effectiveObjectId);
    log.debug('[RemoteShare] Rebound in-flight wait to a newer transfer session');
    return;
  }

  clearStaleRemotePlayback('remote-share-wait');
  setPendingRecoveryTarget({ queueItemId, indexHint, name });
  selectQueueItemById(queueItemId);
  const existingReady = getState('preload.ready');
  const existingPreloadMeta = getState('preload.activeTarget');
  const activePreload = _activePreloadDownload;
  const existingReadyMatches =
    !!existingReady &&
    !!existingPreloadMeta &&
    existingReady.queueItemId === queueItemId &&
    existingPreloadMeta.queueItemId === queueItemId &&
    existingReady.sessionId === sessionId &&
    existingPreloadMeta.sessionId === sessionId &&
    (!objectId ||
      (existingReady.objectId === objectId && existingPreloadMeta.objectId === objectId));
  // FILE_PREPARE intentionally arrives before PLAY_PRELOADED. If the exact
  // speculative GET is still running, preserve its object owner even though
  // preload.ready has not been published yet. Clearing objectId in this tiny
  // window makes completion look stale and throws away an almost-finished GET.
  const existingInFlightPreloadMatches =
    !!activePreload &&
    !activePreload.abort.signal.aborted &&
    !!existingPreloadMeta &&
    activePreload.descriptor.queueItemId === queueItemId &&
    activePreload.descriptor.sessionId === sessionId &&
    existingPreloadMeta.queueItemId === queueItemId &&
    existingPreloadMeta.sessionId === sessionId &&
    existingPreloadMeta.objectId === activePreload.objectId &&
    (!objectId || activePreload.objectId === objectId);
  const existingPreloadMatches = existingReadyMatches || existingInFlightPreloadMatches;
  const waitMeta = existingPreloadMatches
    ? {
        ...existingPreloadMeta,
        name,
        queueItemId,
        indexHint,
        sessionId,
        ...(objectId ? { objectId } : {}),
      }
    : {
        name,
        title: stripRecognizedAudioFileExtension(name),
        queueItemId,
        indexHint,
        size: 0,
        mime: '',
        sessionId,
        ...(objectId ? { objectId } : {}),
      };
  batchSetState({
    'preload.activeTarget': waitMeta,
    'preload.ready': existingReadyMatches ? existingReady : null,
    'preload.nextQueueItemId': queueItemId,
    'transfer.meta': waitMeta,
  });

  const playlist = getState('playlist.items') || [];
  if (playlist[indexHint]) {
    setPlaybackTrackMeta(playlist[indexHint]);
  } else {
    setPlaybackTrackMeta(createFileTrackMeta(name));
  }

  transition({ type: 'FILE_PREPARE', variant: 'preload-waiting', queueItemId, name });
  showLoader(true, t('share.remote.waiting'));
  armRemoteWaitTimeout(queueItemId, name, sessionId, objectId);
}

function isCurrentRemoteFileLoaded(descriptor: RemoteFileSharePayload): boolean {
  const current = getState('files.current');
  if (!current) return false;
  return (
    current.queueItemId === descriptor.queueItemId &&
    current.sessionId === descriptor.sessionId &&
    current.objectId === descriptor.objectId &&
    current.blob.size === descriptor.size
  );
}

function isCurrentRemoteObjectLoaded(descriptor: RemoteFileSharePayload): boolean {
  const current = getState('files.current');
  if (!current) return false;
  return (
    current.queueItemId === descriptor.queueItemId &&
    current.objectId === descriptor.objectId &&
    current.blob.size === descriptor.size
  );
}

function isPreloadedRemoteFile(
  descriptor: RemoteFileSharePayload,
  ready: Readonly<ResidentFile>,
): boolean {
  return (
    ready.blob.size === descriptor.size &&
    ready.queueItemId === descriptor.queueItemId &&
    ready.objectId === descriptor.objectId &&
    ready.sessionId === descriptor.sessionId
  );
}

function sameRemoteDownloadOwner(
  entry: DownloadEntry,
  descriptor: RemoteFileSharePayload,
): boolean {
  return (
    entry.objectId === descriptor.objectId &&
    entry.descriptor.queueItemId === descriptor.queueItemId &&
    entry.descriptor.sessionId === descriptor.sessionId
  );
}

function sameRemoteDescriptorBytes(
  left: RemoteFileSharePayload,
  right: RemoteFileSharePayload,
): boolean {
  return (
    left.roomId === right.roomId &&
    left.objectId === right.objectId &&
    left.size === right.size &&
    left.encryptedSize === right.encryptedSize
  );
}

function reconcileDeferredPreloadForActiveDescriptor(descriptor: RemoteFileSharePayload): void {
  const deferred = _deferredPreloadDescriptor;
  if (!deferred) return;

  // The current descriptor normally has an older SID than its already-issued
  // next-track hint, which must survive. The same object consumes that hint;
  // a same/newer authoritative SID is a direct jump and supersedes it.
  if (
    sameRemoteDescriptorBytes(deferred, descriptor) ||
    descriptor.sessionId >= deferred.sessionId
  ) {
    _deferredPreloadDescriptor = null;
  }
}

function remotePreloadMeta(descriptor: RemoteFileSharePayload) {
  return {
    name: descriptor.name,
    title: stripRecognizedAudioFileExtension(descriptor.name),
    queueItemId: descriptor.queueItemId,
    indexHint: findQueueItemIndex(descriptor.queueItemId),
    size: descriptor.size,
    mime: descriptor.mime,
    sessionId: descriptor.sessionId,
    objectId: descriptor.objectId,
  };
}

function ownsRemotePreloadDownload(entry: DownloadEntry): boolean {
  if (_activePreloadDownload !== entry || entry.abort.signal.aborted) return false;
  if (getState('network.hostConn') !== _observedHostConn) return false;
  if (!getQueueItemById(entry.descriptor.queueItemId)) return false;
  const target = getState('preload.activeTarget');
  return (
    target?.queueItemId === entry.descriptor.queueItemId &&
    target.sessionId === entry.descriptor.sessionId &&
    target.objectId === entry.descriptor.objectId
  );
}

function publishForegroundDownloadProgress(entry: DownloadEntry): void {
  if (entry.intent !== 'foreground' || _activeDownload !== entry) return;
  updateLoader(Math.round(entry.progress * 100));
  const remote = getState('share.remote');
  setState('share.remote', {
    ...remote,
    download: {
      ...remote.download,
      status: 'fetching',
      progress: entry.progress,
      error: null,
    },
  });
}

function enterForegroundRemoteDownload(entry: DownloadEntry, alreadyStarted = false): void {
  entry.intent = 'foreground';
  setState('share.remote', {
    ...getState('share.remote'),
    download: {
      status: 'fetching',
      progress: entry.progress,
      error: null,
    },
  });
  prepareRemoteShareWait(
    entry.descriptor.queueItemId,
    entry.descriptor.name,
    entry.descriptor.sessionId,
    entry.descriptor.objectId,
  );
  showLoader(true, t('share.remote.downloading'));
  updateLoader(Math.round(entry.progress * 100));
  // The foreground wait timer protects descriptor/admission waiting. A
  // promoted speculative transfer is already making progress and owns its own
  // progress-aware XHR watchdog, so it must not inherit that absolute timer.
  if (alreadyStarted) clearManagedTimer(REMOTE_WAIT_TIMER);
}

function clearOwnedRemotePreloadState(entry: DownloadEntry): void {
  const target = getState('preload.activeTarget');
  const ready = getState('preload.ready');
  if (
    target?.queueItemId !== entry.descriptor.queueItemId ||
    target.sessionId !== entry.descriptor.sessionId ||
    target.objectId !== entry.descriptor.objectId ||
    ready
  ) {
    return;
  }
  batchSetState({
    'preload.activeTarget': null,
    'preload.nextQueueItemId': null,
  });
}

async function runRemoteDownload(entry: DownloadEntry): Promise<void> {
  const abort = entry.abort;
  // Object bytes and cryptographic material are immutable even if promotion
  // later rebinds the same object to a newer playback descriptor object.
  const downloadDescriptor = entry.descriptor;
  let transportReservation: RemoteTransportMemoryReservation | null = null;

  try {
    const memoryBudget = resolveDecodeMemoryBudget();
    for (;;) {
      try {
        transportReservation = reserveRemoteTransportMemoryWithinBudget(downloadDescriptor.size, {
          budget: memoryBudget,
          fileName: downloadDescriptor.name,
          retainedPcmBytes:
            memoryBudget.tier === 'ios' ? liveAudioBufferPcmBytes() : currentAudioBufferPcmBytes(),
        });
        break;
      } catch (error) {
        const foreground = entry.intent === 'foreground' && _activeDownload === entry;
        if (
          foreground &&
          isAudioDecodeAdmissionError(error) &&
          error.reason === 'transport-working-set' &&
          !abort.signal.aborted
        ) {
          const reservationChanged = await waitForInFlightMemoryReservationChange(abort.signal);
          if (!reservationChanged) {
            if (abort.signal.aborted || _activeDownload !== entry) return;
            throw error;
          }
          if (!ownsLiveRemoteWait(abort)) return;
          continue;
        }
        if (abort.signal.aborted) return;
        throw error;
      }
    }

    if (entry.intent === 'foreground' && _activeDownload === entry) {
      clearManagedTimer(REMOTE_WAIT_TIMER);
    }

    const onDownloadProgress = (progress: number): void => {
      if (abort.signal.aborted) return;
      entry.progress = progress;
      publishForegroundDownloadProgress(entry);
    };

    let file: File;
    for (let attempt = 1; ; attempt++) {
      try {
        file = await downloadRemoteFile(downloadDescriptor, onDownloadProgress, abort.signal);
        break;
      } catch (error) {
        const raw = rawRemoteShareError(error);
        const transient =
          raw === 'REMOTE_SHARE_DOWNLOAD_NETWORK' || raw === 'REMOTE_SHARE_DOWNLOAD_STALLED';
        if (
          attempt >= 2 ||
          !transient ||
          isAbortError(error) ||
          abort.signal.aborted ||
          !isDescriptorFresh(downloadDescriptor)
        ) {
          throw error;
        }
        log.warn('[RemoteShare] Transient download failure - retrying once:', error);
      }
    }

    if (abort.signal.aborted) return;
    const foreground = entry.intent === 'foreground' && _activeDownload === entry;
    const preload = entry.intent === 'preload' && ownsRemotePreloadDownload(entry);
    if (!foreground && !preload) return;
    if (foreground && !ownsLiveRemoteWait(abort)) return;

    const publishDescriptor = entry.descriptor;
    if (!getQueueItemById(publishDescriptor.queueItemId)) return;
    const meta = remotePreloadMeta(publishDescriptor);
    const retainedReservation = transportReservation.handoffToRetainedEncoded(file, file.size);
    adoptExternalStoredFileAdmission({
      queueItemId: publishDescriptor.queueItemId,
      filename: publishDescriptor.name,
      isPreload: true,
      sessionId: publishDescriptor.sessionId,
      blob: file,
      reservation: retainedReservation,
    });

    const ready = { ...meta, blob: file };
    batchSetState({
      'preload.ready': ready,
      'preload.activeTarget': meta,
      'preload.nextQueueItemId': publishDescriptor.queueItemId,
    });

    if (!foreground) {
      log.debug(`[RemoteShare] Background preload ready: ${publishDescriptor.name}`);
      return;
    }

    setState('share.remote', {
      ...getState('share.remote'),
      download: {
        status: 'ready',
        progress: 1,
        error: null,
      },
    });
    clearManagedTimer(REMOTE_WAIT_TIMER);
    transition({ type: 'PRELOAD_FILE_READY', queueItemId: publishDescriptor.queueItemId });
    bus.emit(
      'storage:use-preloaded',
      publishDescriptor.queueItemId,
      publishDescriptor.name,
      publishDescriptor.sessionId,
    );
  } catch (error) {
    const foreground = entry.intent === 'foreground' && _activeDownload === entry;
    if (!foreground) {
      clearOwnedRemotePreloadState(entry);
      if (!isAbortError(error)) {
        log.debug('[RemoteShare] Background preload download skipped:', error);
      }
      return;
    }
    if (!releaseOwnedRemoteWaitAfterDownloadFailure(abort)) return;
    if (isAbortError(error)) return;
    if (isAudioDecodeAdmissionError(error)) {
      sendToHost({ type: MSG.GUEST_DECODE_FAILED, queueItemId: entry.descriptor.queueItemId });
    }
    const message = friendlyErrorMessage(error);
    setState('share.remote', {
      ...getState('share.remote'),
      download: { status: 'error', progress: 0, error: message },
    });
    log.warn('[RemoteShare] Download/decrypt failed:', error);
    showToast(t('share.remote.download_failed', { msg: message }));
    showLoader(false);
  } finally {
    transportReservation?.release();
    const releasedForeground = _activeDownload === entry;
    if (releasedForeground) _activeDownload = null;
    if (_activePreloadDownload === entry) _activePreloadDownload = null;
    if (releasedForeground) scheduleDeferredRemotePreloadDrain();
  }
}

function deferRemotePreload(descriptor: RemoteFileSharePayload): void {
  const pending = _deferredPreloadDescriptor;
  if (!pending || descriptor.sessionId > pending.sessionId) {
    _deferredPreloadDescriptor = descriptor;
    return;
  }
  if (
    descriptor.sessionId === pending.sessionId &&
    descriptor.queueItemId === pending.queueItemId &&
    descriptor.objectId === pending.objectId
  ) {
    _deferredPreloadDescriptor = descriptor;
  }
}

function liveForegroundRemoteWaitQueueItemId(): QueueItemId | null {
  if (getState('playback.lifecycle') !== PLAYBACK_STATE.AWAITING_PRELOAD) return null;
  const recoveryTarget = getState('playback.pendingRecoveryTarget');
  const waitTarget = getState('preload.activeTarget');
  return recoveryTarget?.queueItemId &&
    recoveryTarget.queueItemId === waitTarget?.queueItemId &&
    !!getQueueItemById(recoveryTarget.queueItemId)
    ? recoveryTarget.queueItemId
    : null;
}

function scheduleDeferredRemotePreloadDrain(): void {
  if (_remotePreloadDrainQueued || !_deferredPreloadDescriptor) return;
  _remotePreloadDrainQueued = true;
  queueMicrotask(() => {
    _remotePreloadDrainQueued = false;
    void drainDeferredRemotePreload();
  });
}

async function drainDeferredRemotePreload(): Promise<void> {
  if (
    _activeDownload ||
    _activePreloadDownload ||
    liveForegroundRemoteWaitQueueItemId() ||
    !REMOTE_FILE_PRELOAD_ENABLED
  ) {
    return;
  }
  const descriptor = _deferredPreloadDescriptor;
  if (!descriptor) return;

  // A completed foreground GET first lands in the shared preload slot. Let
  // storage atomically move those bytes into files.current before the next
  // speculative target is allowed to claim that slot.
  const ready = getState('preload.ready');
  const currentQueueItemId = getState('playlist.currentQueueItemId');
  const pendingQueueItemId = getState('playback.pendingRecoveryTarget')?.queueItemId;
  if (
    ready &&
    ready.queueItemId !== descriptor.queueItemId &&
    (ready.queueItemId === currentQueueItemId || ready.queueItemId === pendingQueueItemId)
  ) {
    return;
  }
  _deferredPreloadDescriptor = null;

  const expectedRoomId = getState('network.sessionCode') || getState('network.lastJoinCode');
  if (
    !getState('network.hostConn') ||
    !getQueueItemById(descriptor.queueItemId) ||
    !isDescriptorFresh(descriptor) ||
    (expectedRoomId && descriptor.roomId !== expectedRoomId)
  ) {
    return;
  }
  await handleRemotePreloadShare(descriptor);
}

async function handleRemotePreloadShare(descriptor: RemoteFileSharePayload): Promise<void> {
  if (!REMOTE_FILE_PRELOAD_ENABLED) return;

  // Older/newer mixed clients may still advertise repeat-one with a fresh
  // session id. The immutable object is already resident and replayable, so
  // downloading it into the next-track slot would only duplicate RAM.
  if (isCurrentRemoteObjectLoaded(descriptor)) {
    log.debug('[RemoteShare] Preload object is already the current resident; ignoring duplicate');
    return;
  }

  if (_activeDownload && sameRemoteDownloadOwner(_activeDownload, descriptor)) {
    log.debug('[RemoteShare] Foreground download already owns this preload descriptor');
    return;
  }

  const liveForegroundQueueItemId = liveForegroundRemoteWaitQueueItemId();
  if (liveForegroundQueueItemId === descriptor.queueItemId) {
    // FILE_PREPARE/PLAY_PRELOADED may select the row before the host finishes
    // uploading its speculative object. The late preload descriptor is now the
    // foreground answer; consume it immediately instead of waiting for a
    // redundant non-preload descriptor that may never be sent.
    if (
      _deferredPreloadDescriptor &&
      sameRemoteDescriptorBytes(_deferredPreloadDescriptor, descriptor)
    ) {
      _deferredPreloadDescriptor = null;
    }
    _activeDownload?.abort.abort();
    _activeDownload = null;
    _activePreloadDownload?.abort.abort();
    _activePreloadDownload = null;
    const foregroundDescriptor = { ...descriptor, preload: undefined };
    const entry: DownloadEntry = {
      objectId: descriptor.objectId,
      descriptor: foregroundDescriptor,
      abort: new AbortController(),
      intent: 'foreground',
      progress: 0,
    };
    _activeDownload = entry;
    adoptRemoteContext(foregroundDescriptor);
    enterForegroundRemoteDownload(entry);
    await runRemoteDownload(entry);
    return;
  }

  // FILE_PREPARE can establish foreground ownership before its R2 descriptor
  // arrives. That descriptor-less wait is still the strict priority lane: a
  // next-track hint must remain queued instead of overwriting activeTarget and
  // then being discarded when the current descriptor finally appears.
  if (_activeDownload || liveForegroundQueueItemId) {
    deferRemotePreload(descriptor);
    log.debug('[RemoteShare] Preload queued behind the current-file wait/download');
    return;
  }

  const ready = getState('preload.ready');
  if (ready && isPreloadedRemoteFile(descriptor, ready)) return;

  if (_activePreloadDownload) {
    if (sameRemoteDownloadOwner(_activePreloadDownload, descriptor)) return;
    _activePreloadDownload.abort.abort();
  }

  const entry: DownloadEntry = {
    objectId: descriptor.objectId,
    descriptor,
    abort: new AbortController(),
    intent: 'preload',
    progress: 0,
  };
  _activePreloadDownload = entry;
  const meta = remotePreloadMeta(descriptor);
  batchSetState({
    'preload.ready': null,
    'preload.activeTarget': meta,
    'preload.nextQueueItemId': descriptor.queueItemId,
  });
  await runRemoteDownload(entry);
}

async function handleRemoteFileShare(
  descriptor: RemoteFileSharePayload,
  conn?: DataConnection,
): Promise<void> {
  if (getState('room.context').kind === 'pro') return;
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;
  if (
    !Number.isSafeInteger(descriptor.sessionId) ||
    descriptor.sessionId <= 0 ||
    !descriptor.queueItemId ||
    !getQueueItemById(descriptor.queueItemId)
  ) {
    return;
  }
  const expectedRoomId = getState('network.sessionCode') || getState('network.lastJoinCode');
  if (expectedRoomId && descriptor.roomId !== expectedRoomId) {
    log.warn('[RemoteShare] Ignoring descriptor issued for a different room');
    return;
  }
  const ownerSnapshot = captureRemoteDescriptorOwner();

  const explicitR2Delivery = descriptor.delivery === 'r2';
  if (!explicitR2Delivery && getState('network.connectionType') === 'unknown') {
    const resolved = await waitForGuestConnectionType(3000);
    if (resolved === 'local') return;
  } else if (!isRemoteGuest() && !explicitR2Delivery) {
    return;
  }

  if (!isRemoteDescriptorOwnerCurrent(ownerSnapshot, descriptor, conn)) {
    log.debug('[RemoteShare] Descriptor superseded during connection classification');
    return;
  }

  recordGuestFileDelivery(descriptor.queueItemId, descriptor.sessionId, 'r2');

  if (descriptor.preload === true) {
    await handleRemotePreloadShare(descriptor);
    return;
  }

  if (isCurrentRemoteFileLoaded(descriptor)) {
    reconcileDeferredPreloadForActiveDescriptor(descriptor);
    log.debug('[RemoteShare] Active descriptor already loaded, ignoring duplicate');
    clearManagedTimer(REMOTE_WAIT_TIMER);
    completeFileRequest(conn, descriptor.queueItemId, descriptor.sessionId);
    return;
  }

  // Fast-path: an active descriptor for a track we already have in the
  // preload slot. Skip the redundant download and promote the existing blob.
  const preReady = getState('preload.ready');
  if (preReady && isPreloadedRemoteFile(descriptor, preReady)) {
    reconcileDeferredPreloadForActiveDescriptor(descriptor);
    log.info(
      `[RemoteShare] Active descriptor matches preloaded blob (${descriptor.queueItemId}); promoting`,
    );

    adoptRemoteContext(descriptor);
    const indexHint = findQueueItemIndex(descriptor.queueItemId);
    const preservedMeta = {
      ...preReady,
      name: descriptor.name,
      title: stripRecognizedAudioFileExtension(descriptor.name),
      queueItemId: descriptor.queueItemId,
      indexHint,
      size: preReady.blob.size,
      mime: preReady.mime || descriptor.mime,
      sessionId: descriptor.sessionId,
      objectId: descriptor.objectId,
    };
    rebindResidentStoredFileAdmission({
      queueItemId: descriptor.queueItemId,
      blob: preReady.blob,
      filename: descriptor.name,
      isPreload: true,
      sessionId: descriptor.sessionId,
    });
    clearStaleRemotePlayback('remote-share-preload-promote');
    setPendingRecoveryTarget({
      queueItemId: descriptor.queueItemId,
      indexHint,
      name: descriptor.name,
    });
    selectQueueItemById(descriptor.queueItemId);
    setState('preload.activeTarget', preservedMeta);
    setState('preload.ready', preservedMeta);
    setState('preload.nextQueueItemId', descriptor.queueItemId);
    setState('transfer.meta', preservedMeta);
    const playlist = getState('playlist.items') || [];
    if (playlist[indexHint]) {
      setPlaybackTrackMeta(playlist[indexHint]);
    } else {
      setPlaybackTrackMeta(createFileTrackMeta(descriptor.name));
    }
    clearManagedTimer(REMOTE_WAIT_TIMER);
    transition({
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      queueItemId: descriptor.queueItemId,
      name: descriptor.name,
    });
    completeFileRequest(conn, descriptor.queueItemId, descriptor.sessionId);
    bus.emit(
      'storage:use-preloaded',
      descriptor.queueItemId,
      descriptor.name,
      descriptor.sessionId,
    );
    return;
  }

  // Reject a different queue occurrence from the same or an older session even after the
  // previous download completed. The identical context remains retryable.
  if (_lastAdoptedRemoteContext) {
    const last = _lastAdoptedRemoteContext;
    const incomingSid = Number(descriptor.sessionId);
    const isNewerContext = Number.isFinite(incomingSid) && incomingSid > last.sessionId;
    // Context identity is queueItemId + sessionId, not objectId. Recovery may upload
    // the same track as a new object without advancing the playback context.
    const isSameContextResend =
      descriptor.queueItemId === last.queueItemId && incomingSid === last.sessionId;
    if (!isNewerContext && !isSameContextResend) {
      log.debug(
        `[RemoteShare] Stale descriptor context ignored (${descriptor.queueItemId}, sid ${descriptor.sessionId} ≤ adopted ${last.sessionId})`,
      );
      return;
    }
  }

  reconcileDeferredPreloadForActiveDescriptor(descriptor);

  // The descriptor has survived connection, queue, and adopted-context gates.
  // Only now may it settle a request; stale same-queue descriptors must not
  // clear an unscoped successor before being rejected above.
  completeFileRequest(conn, descriptor.queueItemId, descriptor.sessionId);

  // The same speculative object is already arriving. Transfer ownership from
  // the background lane to foreground playback without aborting XHR/decrypt or
  // allocating a second transport reservation.
  if (_activePreloadDownload && sameRemoteDownloadOwner(_activePreloadDownload, descriptor)) {
    const promoted = _activePreloadDownload;
    _activePreloadDownload = null;
    _activeDownload?.abort.abort();
    _activeDownload = promoted;
    promoted.descriptor = descriptor;
    adoptRemoteContext(descriptor);
    enterForegroundRemoteDownload(promoted, true);
    log.info(`[RemoteShare] Promoted in-flight remote preload (${descriptor.queueItemId})`);
    return;
  }

  // An unrelated speculative object must yield to active playback. This is a
  // narrow owner cancellation; a matching owner took the promotion path above.
  if (_activePreloadDownload) {
    _activePreloadDownload.abort.abort();
    _activePreloadDownload = null;
  }

  // Active descriptor: supersede any in-flight active download for a
  // DIFFERENT object (newer track wins). Same-object dedup keeps the
  // in-flight download but must adopt the NEW playback context.
  if (_activeDownload) {
    if (_activeDownload.objectId === descriptor.objectId) {
      // Keep the in-flight bytes and move their publish context only when the
      // session advances. Equal-session targeted responses may name an older
      // queue occurrence and therefore must not re-point the wait.
      const trackedSid = Number(_activeDownload.descriptor.sessionId);
      const incomingSid = Number(descriptor.sessionId);
      const isNewerContext =
        Number.isFinite(incomingSid) && (!Number.isFinite(trackedSid) || incomingSid > trackedSid);
      if (isNewerContext) {
        _activeDownload.descriptor = descriptor;
        adoptRemoteContext(descriptor);
        prepareRemoteShareWait(
          descriptor.queueItemId,
          descriptor.name,
          descriptor.sessionId,
          descriptor.objectId,
        );
        log.debug('[RemoteShare] Duplicate active descriptor — download kept, context re-pointed');
      } else {
        log.debug('[RemoteShare] Duplicate active descriptor (same/older context), ignoring');
      }
      return;
    }
    log.info(
      `[RemoteShare] Newer active descriptor (${descriptor.queueItemId}) supersedes in-flight (${_activeDownload.descriptor.queueItemId})`,
    );
    _activeDownload.abort.abort();
  }

  const abort = new AbortController();
  _activeDownload = {
    objectId: descriptor.objectId,
    descriptor,
    abort,
    intent: 'foreground',
    progress: 0,
  };
  adoptRemoteContext(descriptor);
  let transportReservation: RemoteTransportMemoryReservation | null = null;

  try {
    setState('share.remote', {
      ...getState('share.remote'),
      download: {
        status: 'fetching',
        progress: 0,
        error: null,
      },
    });

    prepareRemoteShareWait(
      descriptor.queueItemId,
      descriptor.name,
      descriptor.sessionId,
      descriptor.objectId,
    );
    showLoader(true, t('share.remote.downloading'));

    // Whole-file XHR + Web Crypto allocations happen before decode admission.
    // Reject an unsafe transport peak before the browser receives the first
    // encrypted byte.
    const memoryBudget = resolveDecodeMemoryBudget();
    for (;;) {
      try {
        transportReservation = reserveRemoteTransportMemoryWithinBudget(descriptor.size, {
          budget: memoryBudget,
          fileName: descriptor.name,
          retainedPcmBytes:
            memoryBudget.tier === 'ios' ? liveAudioBufferPcmBytes() : currentAudioBufferPcmBytes(),
        });
        break;
      } catch (error) {
        if (
          isAudioDecodeAdmissionError(error) &&
          error.reason === 'transport-working-set' &&
          _activeDownload?.abort === abort &&
          !abort.signal.aborted
        ) {
          const reservationChanged = await waitForInFlightMemoryReservationChange(abort.signal);
          if (!reservationChanged) {
            if (abort.signal.aborted || _activeDownload?.abort !== abort) return;
            throw error;
          }
          if (!ownsLiveRemoteWait(abort)) return;
          // An older uncancellable native decode or remote transport still
          // owns RAM. Re-admit only after the shared ledger changes, without
          // starting XHR or treating the current track as permanently failed.
          continue;
        }
        if (abort.signal.aborted || _activeDownload?.abort !== abort) return;
        throw error;
      }
    }

    // The room-level timer covers descriptor/admission waiting only. Once RAM
    // is reserved and XHR is about to start, remote-download's progress-aware
    // stall watchdog owns liveness; a healthy slow 200 MiB transfer must not
    // inherit an absolute five-minute cutoff.
    clearManagedTimer(REMOTE_WAIT_TIMER);

    const onDownloadProgress = (progress: number): void => {
      if (abort.signal.aborted) return;
      updateLoader(Math.round(progress * 100));
      const remote = getState('share.remote');
      setState('share.remote', {
        ...remote,
        download: {
          ...remote.download,
          status: 'fetching',
          progress,
        },
      });
    };

    // Retry one transient network failure. Policy, expiry, rate-limit, and
    // supersession failures are terminal for this descriptor.
    let file: File;
    for (let attempt = 1; ; attempt++) {
      try {
        file = await downloadRemoteFile(descriptor, onDownloadProgress, abort.signal);
        break;
      } catch (error) {
        const raw = rawRemoteShareError(error);
        const transient =
          raw === 'REMOTE_SHARE_DOWNLOAD_NETWORK' || raw === 'REMOTE_SHARE_DOWNLOAD_STALLED';
        if (
          attempt >= 2 ||
          !transient ||
          isAbortError(error) ||
          abort.signal.aborted ||
          !isDescriptorFresh(descriptor)
        ) {
          throw error;
        }
        log.warn('[RemoteShare] Transient download failure — retrying once:', error);
      }
    }

    if (abort.signal.aborted) {
      log.debug('[RemoteShare] Active download finished but was superseded; discarding');
      return;
    }

    // Do not create an object URL here; playback consumes the File through the
    // preload/decode path, which owns any URL lifecycle. Publish with the
    // latest context because a same-object descriptor may advance it while the
    // download is running.
    const publishDescriptor =
      _activeDownload?.objectId === descriptor.objectId ? _activeDownload.descriptor : descriptor;

    if (
      _activeDownload?.abort !== abort ||
      abort.signal.aborted ||
      !ownsLiveRemoteWait(abort) ||
      !getQueueItemById(publishDescriptor.queueItemId)
    ) {
      return;
    }

    const indexHint = findQueueItemIndex(publishDescriptor.queueItemId);

    const meta = {
      name: publishDescriptor.name,
      title: stripRecognizedAudioFileExtension(publishDescriptor.name),
      queueItemId: publishDescriptor.queueItemId,
      indexHint,
      size: file.size,
      mime: publishDescriptor.mime,
      sessionId: publishDescriptor.sessionId,
      objectId: publishDescriptor.objectId,
    };

    const retainedReservation = transportReservation.handoffToRetainedEncoded(file, file.size);
    adoptExternalStoredFileAdmission({
      queueItemId: publishDescriptor.queueItemId,
      filename: publishDescriptor.name,
      isPreload: true,
      sessionId: publishDescriptor.sessionId,
      blob: file,
      reservation: retainedReservation,
    });

    const ready = { ...meta, blob: file };
    setState('preload.ready', ready);
    setState('preload.activeTarget', meta);
    setState('preload.nextQueueItemId', publishDescriptor.queueItemId);
    setState('share.remote', {
      ...getState('share.remote'),
      download: {
        status: 'ready',
        progress: 1,
        error: null,
      },
    });

    clearManagedTimer(REMOTE_WAIT_TIMER);
    transition({ type: 'PRELOAD_FILE_READY', queueItemId: publishDescriptor.queueItemId });
    bus.emit(
      'storage:use-preloaded',
      publishDescriptor.queueItemId,
      publishDescriptor.name,
      publishDescriptor.sessionId,
    );
  } catch (error) {
    // Admission can throw synchronously after prepareRemoteShareWait() armed
    // the five-minute watchdog. Later network/decrypt failures own the same
    // cleanup contract, but a stale predecessor must not clear its successor.
    if (!releaseOwnedRemoteWaitAfterDownloadFailure(abort)) {
      log.debug('[RemoteShare] Stale download failure ignored after supersession');
      return;
    }
    if (isAbortError(error)) {
      log.debug('[RemoteShare] Active download superseded — abort is expected');
      return;
    }
    if (isAudioDecodeAdmissionError(error)) {
      sendToHost({ type: MSG.GUEST_DECODE_FAILED, queueItemId: descriptor.queueItemId });
    }
    const message = friendlyErrorMessage(error);
    setState('share.remote', {
      ...getState('share.remote'),
      download: {
        status: 'error',
        progress: 0,
        error: message,
      },
    });
    log.warn('[RemoteShare] Download/decrypt failed:', error);
    showToast(t('share.remote.download_failed', { msg: message }));
    showLoader(false);
  } finally {
    transportReservation?.release();
    const releasedForeground = _activeDownload?.abort === abort;
    if (releasedForeground) {
      _activeDownload = null;
      scheduleDeferredRemotePreloadDrain();
    }
  }
}

function handleRemoteFileUnavailable(data: Record<string, unknown>, conn?: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;
  if (
    data.delivery !== 'r2' &&
    !isRemoteGuest() &&
    getState('network.connectionType') !== 'unknown'
  ) {
    return;
  }
  recordGuestFileDelivery(data.queueItemId as QueueItemId, Number(data.sessionId), 'r2');

  const queueItemId = data.queueItemId;
  const sessionId = data.sessionId;
  const name = (data.name as string) || '';
  if (
    typeof queueItemId !== 'string' ||
    !queueItemId ||
    !Number.isSafeInteger(sessionId) ||
    (sessionId as number) <= 0 ||
    !name
  )
    return;
  const safeQueueItemId = queueItemId as QueueItemId;
  const safeSessionId = sessionId as number;

  const pendingTarget = getState('playback.pendingRecoveryTarget');
  const transferMeta = getState('transfer.meta');
  const activeSessionId = Number(transferMeta?.sessionId) || 0;
  const matchesPending = pendingTarget?.queueItemId === safeQueueItemId;
  const matchesSession = activeSessionId === 0 || activeSessionId === safeSessionId;
  const bounded = legacyBoundedFileV1Product.snapshot();
  const boundedCurrent = bounded.current;
  const matchesBoundedFallback =
    getState('playback.lifecycle') === PLAYBACK_STATE.DECODING &&
    bounded.role === 'guest' &&
    boundedCurrent?.queueItemId === safeQueueItemId &&
    boundedCurrent.legacySessionId === safeSessionId &&
    (boundedCurrent.state === 'fallback' || boundedCurrent.state === 'failed');
  const shouldAct =
    matchesPending &&
    matchesSession &&
    (getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD || matchesBoundedFallback);
  if (!shouldAct) return;
  completeFileRequest(conn, safeQueueItemId, safeSessionId);

  if (matchesBoundedFallback) {
    clearManagedTimer('boundedV1FallbackWatchdog');
    void legacyBoundedFileV1Product
      .abandonGuestTransfer(conn, safeQueueItemId, safeSessionId)
      .catch((error) => {
        log.warn('[RemoteShare] Bounded fallback retirement failed:', error);
      });
  }

  const activeDownload = _activeDownload;
  if (activeDownload?.descriptor.queueItemId === safeQueueItemId) {
    activeDownload.abort.abort();
    _activeDownload = null;
  }

  const message = data.limited
    ? t('chat.remote_upload_limited_system_message')
    : t('chat.remote_upload_failed_system_message');
  clearManagedTimer(REMOTE_WAIT_TIMER);
  showLoader(false);
  showToast(message);
  setState('share.remote', {
    ...getState('share.remote'),
    download: {
      status: 'error',
      progress: 0,
      error: message,
    },
  });
  transition({ type: 'REMOTE_FILE_UNAVAILABLE' });
}

async function handleFileR2Capability(
  data: ProtocolMsg<typeof MSG.FILE_R2_CAPABILITY>,
  conn?: DataConnection,
): Promise<void> {
  if (data.version !== 1 || data.localAudience !== true) return;
  if (getState('network.appRole') !== 'host' || !conn?.peer) return;
  if (getState('network.activeHostConnByPeerId').get(conn.peer) !== conn) return;

  const recoveredSessionIds = markLocalFileR2Capable(conn.peer);
  if (recoveredSessionIds.length === 0) return;

  const current = getState('files.current');
  let replayedCurrentOwner: { queueItemId: QueueItemId; sessionId: number } | null = null;
  if (
    current?.blob instanceof File &&
    current.queueItemId &&
    getState('playlist.currentQueueItemId') === current.queueItemId &&
    recoveredSessionIds.includes(current.sessionId) &&
    shouldConnectionUseR2(conn, current.sessionId)
  ) {
    replayedCurrentOwner = {
      queueItemId: current.queueItemId,
      sessionId: current.sessionId,
    };
    // The bounded current owner publishes an encrypted range record through its
    // own negotiated descriptor. Replaying the legacy whole-blob R2 path for
    // the same queue/session would create two competing foreground owners.
    // Preload remains independent and is intentionally drained below.
    if (!legacyBoundedFileV1Product.ownsSession(current.queueItemId, current.sessionId)) {
      safeSend(conn, {
        type: MSG.FILE_PREPARE,
        name: current.name,
        queueItemId: current.queueItemId,
        sessionId: current.sessionId,
        size: current.blob.size,
        mime: current.mime || current.blob.type || 'application/octet-stream',
        autoPlayDelayMs: 0,
        delivery: 'r2',
      });
      await shareRemoteFileIfNeeded(current.blob, current.sessionId, conn, {
        queueItemId: current.queueItemId,
      });
    }
  }

  // ICE can classify the ninth local peer before its capability frame arrives.
  // That ordering recovers every already-frozen session at once, including the
  // independently frozen next-track session. Replay its warm descriptor too;
  // otherwise this one peer alone would miss preload until foreground play.
  // Establish current playback first. If next arrives before a slow current
  // upload, the guest would start the warm GET and then abort it for current,
  // with no second one-shot hint. Re-read authority after the await so playlist
  // changes and connection replacement cannot publish a stale next target.
  if (getState('network.activeHostConnByPeerId').get(conn.peer) !== conn || !conn.open) return;
  const preload = getState('preload.ready');
  const preloadTarget = getState('preload.activeTarget');
  if (
    REMOTE_FILE_PRELOAD_ENABLED &&
    preload?.blob instanceof File &&
    preload.queueItemId === preloadTarget?.queueItemId &&
    preload.sessionId === preloadTarget.sessionId &&
    (replayedCurrentOwner?.queueItemId !== preload.queueItemId ||
      replayedCurrentOwner.sessionId !== preload.sessionId) &&
    recoveredSessionIds.includes(preload.sessionId) &&
    shouldConnectionUseR2(conn, preload.sessionId)
  ) {
    await preloadRemoteFileIfNeeded(preload.blob, preload.sessionId, preload.queueItemId, conn);
  }
}

function resetRemoteShareAuthorityBoundary(): void {
  _remoteDescriptorGeneration++;
  _lastAdoptedRemoteContext = null;
  resetFileDeliveryPolicies();

  for (const entry of _activeUploads.values()) entry.abort.abort();
  _activeUploads.clear();
  _descriptorCache.clear();
  _fileIds = new WeakMap<File, number>();
  _lastUploadFailureMessageAt = 0;
  _lastStorageQuotaMessageAt = 0;

  _activeDownload?.abort.abort();
  _activeDownload = null;
  _activePreloadDownload?.abort.abort();
  _activePreloadDownload = null;
  _deferredPreloadDescriptor = null;
  _remotePreloadDrainQueued = false;
  clearManagedTimer(REMOTE_WAIT_TIMER);
  setState('share.remote', {
    upload: {
      status: 'idle',
      progress: 0,
      objectId: null,
      expiresAt: null,
      error: null,
    },
    download: {
      status: 'idle',
      progress: 0,
      error: null,
    },
  });
}

export function initRemoteShare(): void {
  registerHandlers({
    [MSG.FILE_R2_CAPABILITY]: handleFileR2Capability,
    [MSG.REMOTE_FILE_SHARE]: handleRemoteFileShare,
    [MSG.REMOTE_FILE_UNAVAILABLE]: handleRemoteFileUnavailable,
  });

  _observedHostConn = getState('network.hostConn');

  // Foreground storage adoption is asynchronous. These transitions retry a
  // deferred R2 preload only after the shared resident slot is released, and
  // also cover a local/P2P current transfer followed by an R2-only next track.
  bus.on('state:preload.ready', scheduleDeferredRemotePreloadDrain);
  bus.on('state:files.current', scheduleDeferredRemotePreloadDrain);
  bus.on('state:playback.lifecycle', scheduleDeferredRemotePreloadDrain);
  bus.on('state:playlist.items', () => {
    const activeQueueItemId = _activePreloadDownload?.descriptor.queueItemId;
    if (activeQueueItemId && !getQueueItemById(activeQueueItemId)) {
      cancelRemoteFilePreload('playlist-item-removed', activeQueueItemId);
    }
    const deferredQueueItemId = _deferredPreloadDescriptor?.queueItemId;
    if (deferredQueueItemId && !getQueueItemById(deferredQueueItemId)) {
      cancelRemoteFilePreload('playlist-item-removed', deferredQueueItemId);
    }
    scheduleDeferredRemotePreloadDrain();
  });

  const warmLateR2Peer = async (peerId: string): Promise<void> => {
    const hostConn = getState('network.hostConn');
    if (hostConn || !isRemoteShareConfigured()) return;

    markLateLocalPeerForR2(peerId);
    const peers = getState('network.connectedPeers') || [];
    const peer = peers.find((item) => item.id === peerId);
    if (!peer?.conn?.open) return;

    const current = getState('files.current');
    const currentBlob = current?.blob;
    let replayedCurrentOwner: { queueItemId: QueueItemId; sessionId: number } | null = null;
    if (
      currentBlob instanceof File &&
      current?.queueItemId &&
      getState('playlist.currentQueueItemId') === current.queueItemId &&
      current.sessionId &&
      shouldConnectionUseR2(peer.conn, current.sessionId)
    ) {
      replayedCurrentOwner = {
        queueItemId: current.queueItemId,
        sessionId: current.sessionId,
      };
      if (!legacyBoundedFileV1Product.ownsSession(current.queueItemId, current.sessionId)) {
        await shareRemoteFileIfNeeded(currentBlob, current.sessionId, peer.conn, {
          queueItemId: current.queueItemId,
        });
      }
    }

    // Give a late R2 participant the same warm next-track resident that a late
    // LAN participant receives through unicastPreload. The completed object is
    // normally cached, so this targets only a small descriptor and one GET.
    if (
      getState('network.hostConn') ||
      !peer.conn.open ||
      !isPeerConnectionCurrent(peer.conn.peer, peer.conn)
    ) {
      return;
    }
    const preload = getState('preload.ready');
    const preloadTarget = getState('preload.activeTarget');
    if (
      REMOTE_FILE_PRELOAD_ENABLED &&
      preload?.blob instanceof File &&
      preload.queueItemId === preloadTarget?.queueItemId &&
      preload.sessionId === preloadTarget.sessionId &&
      (replayedCurrentOwner?.queueItemId !== preload.queueItemId ||
        replayedCurrentOwner.sessionId !== preload.sessionId) &&
      shouldConnectionUseR2(peer.conn, preload.sessionId)
    ) {
      await preloadRemoteFileIfNeeded(
        preload.blob,
        preload.sessionId,
        preload.queueItemId,
        peer.conn,
      );
    }
  };
  // peer-joined may precede ICE classification; the later events retry the
  // same idempotent cached descriptors once R2 routing/data eligibility is
  // known, so no late participant misses the one-shot warm hint.
  bus.on('orchestrator:peer-joined', warmLateR2Peer);
  bus.on('orchestrator:peer-data-target-ready', warmLateR2Peer);

  bus.on('orchestrator:peer-evaluated', (peerId: string) => {
    warmLateR2Peer(peerId);
    abortActiveUploadsWithoutTargets('no-r2-targets');
  });

  bus.on('network:peer-connected', (conn: DataConnection) => {
    if (getState('network.appRole') !== 'guest') return;
    const hostConn = getState('network.hostConn');
    if (!hostConn || conn !== hostConn) return;
    safeSend(hostConn, {
      type: MSG.FILE_R2_CAPABILITY,
      version: 1,
      localAudience: true,
    });
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    if (getState('network.appRole') !== 'host') return;
    releaseFileDeliveryPeer(peerId);
    abortActiveUploadsWithoutTargets('peer-disconnected');
  });

  bus.on('network:peer-connection-replaced', (peerId: string) => {
    if (getState('network.appRole') !== 'host') return;
    releaseFileDeliveryPeer(peerId);
    abortActiveUploadsWithoutTargets('peer-connection-replaced');
  });

  bus.on('state:network.hostConn', (value) => {
    const hostConn = (value as DataConnection | null) ?? null;
    const previousHostConn = _observedHostConn;
    _observedHostConn = hostConn;
    if (hostConn === previousHostConn) return;
    if (!hostConn && !previousHostConn) return;

    // The exact host connection authenticates every guest-side transfer. A
    // reconnect can replace it without changing the room code, so old route
    // markers and an in-flight R2 download must not survive this boundary.
    resetRemoteShareAuthorityBoundary();
  });

  bus.on('state:network.sessionCode', () => {
    // A new host owns a new sessionId ordering, including truthy-to-truthy
    // session-code changes, so reset the adopted-context gate unconditionally.
    // Room changes are security boundaries even when both codes are truthy.
    // Never carry encrypted objects, cached descriptors, or download
    // ownership from room A into room B.
    resetRemoteShareAuthorityBoundary();
  });

  log.info('[RemoteShare] Handlers registered');
}
