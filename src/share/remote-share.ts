/**
 * Remote file sharing over temporary encrypted object storage.
 *
 * This is intentionally a side path: LAN P2P transfer remains the primary
 * path, while remote/unknown guests receive an encrypted R2 descriptor.
 *
 * Two descriptor flavors share the same wire envelope (MSG.REMOTE_FILE_SHARE),
 * distinguished by the `preload` flag:
 *   - preload=false (default): Active descriptor for the CURRENT track. Guest
 *     stops the previous audio, transitions to AWAITING_PRELOAD, downloads,
 *     and promotes via storage:use-preloaded so loadPreloadedTrack consumes
 *     pendingPlayTime → play.
 *   - preload=true: Speculative descriptor for the NEXT track. Guest pre-
 *     downloads silently into preload.nextFileBlob WITHOUT touching the
 *     current playback. When host eventually advances and emits MSG.PLAY
 *     with the new index, the existing preload-promoted path activates the
 *     already-downloaded blob with zero wait.
 *
 * Concurrency: only ONE active descriptor download runs at a time. A newer
 * active descriptor cancels the in-flight one via AbortController. Preload
 * downloads run independently of an active download (they target the
 * preload slot before the active path takes ownership), but a newer preload
 * supersedes an older preload.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE, PLAYBACK_STATE } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import { sendSystemNotice } from '../chat/protocol.ts';
import { registerHandlers } from '../network/protocol.ts';
import {
  broadcast,
  isRemoteGuest,
  hasActiveRelay,
  safeSend,
  waitForGuestConnectionType,
} from '../network/peer.ts';
import { transition } from '../player/lifecycle.ts';
import {
  getPendingPlayTime,
  getPendingPlayTimeSetAt,
  setPendingPlayTime,
  setPendingRecoveryTarget,
} from '../player/_state.ts';
import { showLoader, showToast, updateLoader } from '../ui/toast.ts';
import { uploadRemoteFile } from './remote-upload.ts';
import { downloadRemoteFile } from './remote-download.ts';
import { isRemoteShareConfigured } from './r2-client.ts';
import type { AnyProtocolMsg, DataConnection, RemoteFileSharePayload } from '../types/index.ts';

const REMOTE_WAIT_TIMER = 'remote-share-wait-timeout';
const REMOTE_WAIT_MS = 5 * 60_000 + 15_000;
const REMOTE_UPLOAD_LOADER = 'remote-share-upload';
// Treat a descriptor as expired if it would expire within this window —
// avoids handing out a 30-second-window URL to a guest who'd race the TTL.
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

interface UploadEntry {
  key: string;
  promise: Promise<RemoteFileSharePayload>;
  abort: AbortController;
}

interface DownloadEntry {
  objectId: string;
  index: number;
  abort: AbortController;
}

// Upload tracking. Keyed by file-signature so a preload upload for track N
// can be reused/awaited by a subsequent active upload for the same track.
const _activeUploads = new Map<string, UploadEntry>();
// Cached completed descriptors (per file-signature). Reused if still fresh.
const _descriptorCache = new Map<string, RemoteFileSharePayload>();

// Only one active (foreground) download at a time. A newer one supersedes
// the in-flight one via abort.
let _activeDownload: DownloadEntry | null = null;
// Preload (background) download runs in parallel to the active download
// because they target distinct ownership of preload.nextFileBlob slot.
let _activePreloadDownload: DownloadEntry | null = null;
let _lastUploadFailureNoticeAt = 0;

function rawRemoteShareError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clearStaleRemotePlayback(reason: string): void {
  const pendingTime = getPendingPlayTime();
  const pendingSetAt = getPendingPlayTimeSetAt();
  bus.emit('storage:clear-previous-track', reason);
  if (pendingTime !== undefined) setPendingPlayTime(pendingTime, pendingSetAt);
}

function toRemoteShareMessage(
  descriptor: RemoteFileSharePayload,
  preload: boolean,
): AnyProtocolMsg {
  return { type: MSG.REMOTE_FILE_SHARE, ...descriptor, preload } as AnyProtocolMsg;
}

function toRemoteFileUnavailableMessage(
  file: File,
  sessionId: number,
  index: number,
  limited: boolean,
): AnyProtocolMsg {
  return {
    type: MSG.REMOTE_FILE_UNAVAILABLE,
    name: file.name,
    index,
    sessionId,
    limited,
  } as AnyProtocolMsg;
}

function hasRemoteTargets(): boolean {
  const peers = getState('network.connectedPeers') || [];
  return peers.some(
    (peer) =>
      peer.status === 'connected' &&
      peer.conn?.open &&
      (peer.connectionType === 'remote' || peer.connectionType === 'unknown'),
  );
}

function isDescriptorFresh(descriptor: RemoteFileSharePayload | null): boolean {
  if (!descriptor) return false;
  return descriptor.expiresAt - Date.now() > EXPIRY_SAFETY_MARGIN_MS;
}

function fileSignatureKey(file: File, sessionId: number, index: number): string {
  return `${sessionId}:${index}:${file.name}:${file.size}:${file.lastModified}`;
}

function isHostActiveFile(file: File, index: number): boolean {
  if (getState('files.currentFileBlob') === file) return true;

  // Host preload activation calls shareRemoteFileIfNeeded before
  // loadPreloadedTrack publishes files.currentFileBlob. In that window the
  // selected playlist slot is the authoritative "still current" signal.
  const currentIndex = getState('playlist.currentTrackIndex');
  if (currentIndex !== index) return false;

  const playlist = getState('playlist.items') || [];
  const item = playlist[index] as { file?: File } | undefined;
  return item?.file === file;
}

function showUploadProgress(message: string, progress = 0): void {
  showLoader(true, message, REMOTE_UPLOAD_LOADER);
  updateLoader(Math.round(progress * 100));
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
    raw === 'REMOTE_SHARE_UPLOAD_TIMEOUT' ||
    raw === 'REMOTE_SHARE_DOWNLOAD_TIMEOUT' ||
    raw === 'REMOTE_SHARE_SESSION_NETWORK' ||
    raw === 'REMOTE_SHARE_COMPLETE_NETWORK'
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
  if (
    raw === 'REMOTE_SHARE_BAD_SESSION_RESPONSE' ||
    raw === 'REMOTE_SHARE_BAD_COMPLETE_RESPONSE' ||
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
  if (
    raw === 'REMOTE_SHARE_DIRECT_UPLOAD_HTTP_413' ||
    raw === 'REMOTE_SHARE_COMPLETE_HTTP_413'
  ) {
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

function getRemoteNoticeTargets(targetConn?: DataConnection): DataConnection[] {
  if (targetConn?.open) return [targetConn];

  const peers = getState('network.connectedPeers') || [];
  return peers
    .filter(
      (peer) =>
        peer.status === 'connected' &&
        peer.conn?.open &&
        (peer.connectionType === 'remote' || peer.connectionType === 'unknown'),
    )
    .map((peer) => peer.conn as DataConnection);
}

function maybeNotifyRemoteUploadFailure(
  error: unknown,
  file: File,
  sessionId: number,
  index: number,
  targetConn?: DataConnection,
): void {
  const now = Date.now();
  const targets = getRemoteNoticeTargets(targetConn);
  if (targets.length === 0) return;

  const limited = isUploadLimitError(error);
  const unavailable = toRemoteFileUnavailableMessage(file, sessionId, index, limited);
  for (const conn of targets) {
    safeSend(conn, unavailable);
  }

  if (now - _lastUploadFailureNoticeAt < 60_000) return;
  _lastUploadFailureNoticeAt = now;
  const key = limited
    ? 'chat.remote_upload_limited_notice'
    : 'chat.remote_upload_failed_notice';
  for (const conn of targets) {
    sendSystemNotice(conn, key);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === 'REMOTE_SHARE_ABORTED';
}

export function shouldWaitForRemoteShare(): boolean {
  return isRemoteShareConfigured();
}

export interface ShareRemoteFileOptions {
  /**
   * Speculative pre-share for the NEXT track. The host runs this from
   * preloadNextTrack so the encrypted object lands on R2 before the user
   * advances. Guest receives a `preload: true` descriptor and silently
   * pre-downloads into the preload slot without interrupting the current
   * track.
   */
  preload?: boolean;
  /**
   * Override for the index recorded on the wire. Required when `preload`
   * is true (caller passes the next-track index); ignored when omitted in
   * the active path (defaults to playlist.currentTrackIndex).
   */
  index?: number;
}

/**
 * Host-side: encrypt + upload the file and broadcast the descriptor to
 * remote guests. Idempotent — repeat calls for the same file/session/index
 * reuse the cached descriptor (when fresh) or share the in-flight upload
 * promise. Cancels superseded uploads via AbortController so a rapid
 * track switch doesn't race two completed-but-stale descriptors.
 */
export async function shareRemoteFileIfNeeded(
  file: File,
  sessionId: number | null,
  targetConn?: DataConnection,
  options?: ShareRemoteFileOptions,
): Promise<void> {
  if (getState('network.hostConn')) return;
  if (!isRemoteShareConfigured()) return;
  if (sessionId === null) return;
  if (!targetConn && !hasRemoteTargets()) return;

  const preload = options?.preload === true;
  const index =
    options?.index !== undefined ? options.index : (getState('playlist.currentTrackIndex') as number);
  if (!Number.isFinite(index) || index < 0) return;

  const key = fileSignatureKey(file, sessionId, index);

  try {
    let descriptor: RemoteFileSharePayload;

    // Fast path: reuse a cached, still-fresh descriptor for this file.
    const cached = _descriptorCache.get(key);
    if (cached && isDescriptorFresh(cached)) {
      descriptor = cached;
    } else {
      // Drop expired cache entry — its R2 URL would 404 for guests.
      if (cached && !isDescriptorFresh(cached)) {
        _descriptorCache.delete(key);
      }

      const inFlight = _activeUploads.get(key);
      if (inFlight) {
        // Another caller already uploading the same file — share the result.
        if (!preload) showUploadProgress(t('share.remote.uploading'));
        descriptor = await inFlight.promise;
      } else {
        const abort = new AbortController();
        const promise = uploadRemoteFile(file, sessionId, index, {
          signal: abort.signal,
          onUploadProgress: (progress) => {
            if (!preload) {
              showUploadProgress(t('share.remote.uploading'), progress);
            }
            bus.emit('remote-file:progress', 'upload', progress);
          },
        });

        const entry: UploadEntry = { key, promise, abort };
        _activeUploads.set(key, entry);

        if (!preload) {
          showToast(t('share.remote.encrypting'));
          showUploadProgress(t('share.remote.encrypting'));
        }

        try {
          descriptor = await promise;
          _descriptorCache.set(key, descriptor);
        } finally {
          if (_activeUploads.get(key) === entry) _activeUploads.delete(key);
        }
      }
    }

    if (!preload) showLoader(false, undefined, REMOTE_UPLOAD_LOADER);

    // Stale-track guard (broadcast-mode only): if the host moved on during
    // the upload, suppress the broadcast so guests don't get a descriptor
    // for a track they already advanced past. Different rules per flavor:
    //   - active: stale if currentFileBlob is no longer this file
    //   - preload: stale if preload.nextTrackIndex moved off our index
    //     (host scheduled a newer preload before our upload finished)
    if (!targetConn) {
      if (!preload && !isHostActiveFile(file, index)) {
        log.debug('[RemoteShare] Active upload completed for stale track; descriptor not broadcast');
        return;
      }
      if (preload && (getState('preload.nextTrackIndex') as number) !== index) {
        log.debug(
          `[RemoteShare] Preload upload completed for stale next-index ${index}; descriptor not broadcast`,
        );
        return;
      }
    }

    const msg = toRemoteShareMessage(descriptor, preload);
    if (targetConn) {
      safeSend(targetConn, msg);
    } else {
      broadcast(msg);
    }
    if (!preload) {
      bus.emit('share:remote-file', descriptor);
      log.info(`[RemoteShare] Shared encrypted descriptor for ${descriptor.name}`);
      showToast(t('share.remote.upload_ready'));
    } else {
      log.info(`[RemoteShare] Shared preload descriptor for ${descriptor.name}`);
    }
  } catch (error) {
    if (isAbortError(error)) {
      log.debug('[RemoteShare] Upload superseded — abort path is expected');
      return;
    }
    if (!preload) showLoader(false, undefined, REMOTE_UPLOAD_LOADER);
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
    if (!preload) {
      maybeNotifyRemoteUploadFailure(error, file, sessionId, index, targetConn);
      showToast(t('share.remote.upload_failed', { msg: message }));
    }
  }
}

/**
 * Cancel any in-flight upload for the given file key. Called when the host
 * navigates away from a track before its upload completes — saves CPU and
 * R2 bandwidth, and prevents a stale descriptor from being broadcast.
 */
export function cancelInFlightUpload(file: File, sessionId: number, index: number): void {
  const key = fileSignatureKey(file, sessionId, index);
  const entry = _activeUploads.get(key);
  if (entry) {
    entry.abort.abort();
    _activeUploads.delete(key);
  }
}

export function prepareRemoteShareWait(index: number, name: string, sessionId: number): void {
  if (!shouldWaitForRemoteShare()) return;

  // Idempotent: if we're already AWAITING_PRELOAD for this same index, don't
  // re-arm timers / re-fire the transition. FILE_PREPARE and REMOTE_FILE_SHARE
  // both arrive on the wire and both used to call this — without idempotency,
  // the watchdog reset and lifecycle re-entry made debugging confusing.
  const lifecycle = getState('playback.lifecycle');
  const recoveryTarget = getState('playback.pendingRecoveryTarget');
  const alreadyWaiting =
    lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD &&
    recoveryTarget?.index === index &&
    recoveryTarget.name === name;
  if (alreadyWaiting) {
    log.debug('[RemoteShare] Wait state already established for this index; skipping re-arm');
    return;
  }

  clearStaleRemotePlayback('remote-share-wait');
  setPendingRecoveryTarget(index, name);
  setState('playlist.currentTrackIndex', index);
  const existingPreloadBlob = getState('preload.nextFileBlob');
  const existingPreloadMeta = getState('preload.meta');
  const existingPreloadMatches =
    existingPreloadBlob &&
    existingPreloadMeta &&
    Number(existingPreloadMeta.index) === index &&
    existingPreloadMeta.name === name;
  const waitMeta = existingPreloadMatches
    ? {
        ...existingPreloadMeta,
        sessionId: existingPreloadMeta.sessionId ?? sessionId,
      }
    : {
        name,
        title: name.replace(/\.[^/.]+$/, ''),
        index,
        size: 0,
        mime: '',
        sessionId,
      };
  if (existingPreloadBlob && !existingPreloadMatches) {
    setState('preload.nextFileBlob', null);
  }
  setState('preload.meta', waitMeta);
  setState('preload.nextTrackIndex', index);
  setState('transfer.meta', waitMeta);

  const playlist = getState('playlist.items') || [];
  if (playlist[index]) {
    setState('player.currentTrackMeta', playlist[index]);
  } else {
    setState('player.currentTrackMeta', {
      type: 'file',
      title: name.replace(/\.[^/.]+$/, '') || name,
      name,
      videoId: null,
      playlistId: null,
    });
  }

  transition({ type: 'FILE_PREPARE', variant: 'preload-waiting', index, name });
  showLoader(true, t('share.remote.waiting'));

  clearManagedTimer(REMOTE_WAIT_TIMER);
  setManagedTimer(
    REMOTE_WAIT_TIMER,
    () => {
      const readyBlob = getState('preload.nextFileBlob');
      const readyMeta = getState('preload.meta');
      if (
        readyBlob &&
        readyMeta &&
        Number(readyMeta.index) === index &&
        readyMeta.name === name
      ) {
        return;
      }
      log.warn('[RemoteShare] Wait timed out before descriptor/download completed');
      showToast(t('share.remote.timeout'));
      showLoader(false);
    },
    REMOTE_WAIT_MS,
  );
}

/**
 * Pure preload path: fetch the encrypted blob into preload.nextFileBlob
 * WITHOUT touching active playback. The host's later MSG.PLAY for the
 * preloaded index activates it via the existing handlePlayMsg →
 * loadPreloadedTrack flow (zero-wait switch).
 */
const REMOTE_PRELOAD_LOADER = 'remote-share-preload';

async function downloadRemotePreload(descriptor: RemoteFileSharePayload): Promise<void> {
  // Already in flight for the same object — drop dup.
  if (_activePreloadDownload?.objectId === descriptor.objectId) return;
  // Already have this exact track preloaded — drop dup.
  const existingMeta = getState('preload.meta');
  const existingBlob = getState('preload.nextFileBlob');
  if (existingBlob && isPreloadedRemoteFile(descriptor, existingBlob, existingMeta)) {
    return;
  }

  // Supersede any older preload for a different track.
  if (_activePreloadDownload && _activePreloadDownload.objectId !== descriptor.objectId) {
    _activePreloadDownload.abort.abort();
    showLoader(false, undefined, REMOTE_PRELOAD_LOADER);
  }

  const abort = new AbortController();
  _activePreloadDownload = {
    objectId: descriptor.objectId,
    index: descriptor.index,
    abort,
  };

  // Surface the preload progress in the header loader (same channel as
  // local-network preload UI in preload.ts → "preparing next" toast).
  // Distinct loader id so the preload's "show: false" on completion
  // doesn't clobber an active-download loader from a parallel track
  // switch.
  showLoader(true, t('share.remote.preload_downloading'), REMOTE_PRELOAD_LOADER);
  updateLoader(0);

  try {
    const file = await downloadRemoteFile(
      descriptor,
      (progress) => {
        if (abort.signal.aborted) return;
        updateLoader(Math.round(progress * 100));
        bus.emit('remote-file:progress', 'download', progress);
      },
      abort.signal,
    );
    if (abort.signal.aborted) return;

    // Yield if an active download for a different track owns the slot now.
    if (_activeDownload && _activeDownload.index !== descriptor.index) {
      log.debug('[RemoteShare] Preload completed but active download owns slot; discarding');
      return;
    }

    setState('preload.nextFileBlob', file);
    setState('preload.meta', {
      name: descriptor.name,
      title: descriptor.name.replace(/\.[^/.]+$/, ''),
      index: descriptor.index,
      size: file.size,
      mime: descriptor.mime,
      sessionId: descriptor.sessionId,
    });
    setState('preload.nextTrackIndex', descriptor.index);
    log.info(`[RemoteShare] Preload ready for index ${descriptor.index} (${descriptor.name})`);
    promoteRemotePreloadIfActive(descriptor, file);
  } catch (error) {
    if (isAbortError(error)) {
      log.debug('[RemoteShare] Preload download superseded — abort is expected');
      return;
    }
    log.warn('[RemoteShare] Preload download failed:', error);
    // Preload failure is silent toast-wise — the user-facing path (active
    // descriptor arriving on track advance) will surface its own error if
    // R2 is down.
  } finally {
    if (_activePreloadDownload?.objectId === descriptor.objectId) {
      _activePreloadDownload = null;
    }
    showLoader(false, undefined, REMOTE_PRELOAD_LOADER);
  }
}

function remoteFileMeta(descriptor: RemoteFileSharePayload, file: File): Record<string, unknown> {
  return {
    name: descriptor.name,
    title: descriptor.name.replace(/\.[^/.]+$/, ''),
    index: descriptor.index,
    size: file.size,
    mime: descriptor.mime,
    sessionId: descriptor.sessionId,
  };
}

function isCurrentRemoteFileLoaded(descriptor: RemoteFileSharePayload): boolean {
  const currentBlob = getState('files.currentFileBlob');
  const meta = getState('transfer.meta');
  if (!currentBlob || !meta) return false;
  const metaSessionId = Number(meta.sessionId);
  const sessionMatches =
    !Number.isFinite(metaSessionId) || metaSessionId === descriptor.sessionId;
  return (
    Number(meta.index) === descriptor.index &&
    meta.name === descriptor.name &&
    currentBlob.size === descriptor.size &&
    sessionMatches
  );
}

function isPreloadedRemoteFile(descriptor: RemoteFileSharePayload, blob: Blob, meta: unknown): boolean {
  const preloadMeta = meta as Record<string, unknown> | null;
  if (!preloadMeta) return false;
  const metaSessionId = Number(preloadMeta.sessionId);
  return (
    blob.size === descriptor.size &&
    Number(preloadMeta.index) === descriptor.index &&
    preloadMeta.name === descriptor.name &&
    (!Number.isFinite(metaSessionId) || metaSessionId === descriptor.sessionId)
  );
}

function shouldPromoteRemotePreload(descriptor: RemoteFileSharePayload): boolean {
  if ((getState('playlist.currentTrackIndex') as number) !== descriptor.index) return false;
  if (isCurrentRemoteFileLoaded(descriptor)) return false;

  const lifecycle = getState('playback.lifecycle');
  const pendingTarget = getState('playback.pendingRecoveryTarget');
  return (
    pendingTarget?.index === descriptor.index ||
    lifecycle === PLAYBACK_STATE.IDLE ||
    lifecycle === PLAYBACK_STATE.DOWNLOADING ||
    lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD
  );
}

function promoteRemotePreloadIfActive(descriptor: RemoteFileSharePayload, file: File): void {
  if (!shouldPromoteRemotePreload(descriptor)) return;

  const meta = remoteFileMeta(descriptor, file);
  log.info(
    `[RemoteShare] Completed preload is now active (index ${descriptor.index}); promoting`,
  );
  clearStaleRemotePlayback('remote-share-preload-promote');
  setPendingRecoveryTarget(descriptor.index, descriptor.name);
  setState('preload.meta', meta);
  setState('preload.nextTrackIndex', descriptor.index);
  setState('transfer.meta', meta);
  const playlist = getState('playlist.items') || [];
  if (playlist[descriptor.index]) {
    setState('player.currentTrackMeta', playlist[descriptor.index]);
  } else {
    setState('player.currentTrackMeta', {
      type: 'file',
      title: descriptor.name.replace(/\.[^/.]+$/, '') || descriptor.name,
      name: descriptor.name,
      videoId: null,
      playlistId: null,
    });
  }
  clearManagedTimer(REMOTE_WAIT_TIMER);
  transition({
    type: 'FILE_PREPARE',
    variant: 'preload-match',
    index: descriptor.index,
    name: descriptor.name,
  });
  bus.emit('remote-file:ready', descriptor.index, descriptor.name);
  bus.emit('storage:use-preloaded', descriptor.index, descriptor.name);
}

async function handleRemoteFileShare(
  descriptor: RemoteFileSharePayload,
  conn?: DataConnection,
): Promise<void> {
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;
  if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) return;
  if (hasActiveRelay()) return;

  if (getState('network.connectionType') === 'unknown') {
    const resolved = await waitForGuestConnectionType(3000);
    if (resolved === 'local') return;
  } else if (!isRemoteGuest()) {
    return;
  }

  // Preload descriptor: silent pre-fetch, no playback interruption.
  if (descriptor.preload === true) {
    void downloadRemotePreload(descriptor);
    return;
  }

  if (isCurrentRemoteFileLoaded(descriptor)) {
    log.debug('[RemoteShare] Active descriptor already loaded, ignoring duplicate');
    clearManagedTimer(REMOTE_WAIT_TIMER);
    bus.emit('remote-file:ready', descriptor.index, descriptor.name);
    return;
  }

  // Fast-path: an active descriptor for a track we already preloaded — the
  // blob is in preload.nextFileBlob, just promote it. Skip the redundant
  // download (and the R2 cost it would incur).
  const preMeta = getState('preload.meta');
  const preBlob = getState('preload.nextFileBlob');
  if (preBlob && isPreloadedRemoteFile(descriptor, preBlob, preMeta)) {
    log.info(
      `[RemoteShare] Active descriptor matches preloaded blob (index ${descriptor.index}); promoting`,
    );

    const preMetaRecord = preMeta as Record<string, unknown>;
    const preservedMeta = {
      ...preMetaRecord,
      name: descriptor.name,
      title: descriptor.name.replace(/\.[^/.]+$/, ''),
      index: descriptor.index,
      size: preBlob.size,
      mime: (preMetaRecord.mime as string) || descriptor.mime,
      sessionId: descriptor.sessionId,
    };
    clearStaleRemotePlayback('remote-share-preload-promote');
    setPendingRecoveryTarget(descriptor.index, descriptor.name);
    setState('playlist.currentTrackIndex', descriptor.index);
    setState('preload.meta', preservedMeta);
    setState('preload.nextTrackIndex', descriptor.index);
    setState('transfer.meta', preservedMeta);
    const playlist = getState('playlist.items') || [];
    if (playlist[descriptor.index]) {
      setState('player.currentTrackMeta', playlist[descriptor.index]);
    } else {
      setState('player.currentTrackMeta', {
        type: 'file',
        title: descriptor.name.replace(/\.[^/.]+$/, '') || descriptor.name,
        name: descriptor.name,
        videoId: null,
        playlistId: null,
      });
    }
    clearManagedTimer(REMOTE_WAIT_TIMER);
    transition({
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      index: descriptor.index,
      name: descriptor.name,
    });
    bus.emit('remote-file:ready', descriptor.index, descriptor.name);
    bus.emit('storage:use-preloaded', descriptor.index, descriptor.name);
    return;
  }

  // Active descriptor: supersede any in-flight active download for a
  // DIFFERENT object (newer track wins). Same-object dedup is preserved.
  if (_activeDownload) {
    if (_activeDownload.objectId === descriptor.objectId) {
      log.debug('[RemoteShare] Duplicate active descriptor, ignoring');
      return;
    }
    log.info(
      `[RemoteShare] Newer active descriptor (index ${descriptor.index}) supersedes in-flight (index ${_activeDownload.index})`,
    );
    _activeDownload.abort.abort();
  }

  const abort = new AbortController();
  _activeDownload = {
    objectId: descriptor.objectId,
    index: descriptor.index,
    abort,
  };

  try {
    setState('share.remote', {
      ...getState('share.remote'),
      download: {
        status: 'fetching',
        progress: 0,
        blobUrl: null,
        error: null,
      },
    });

    prepareRemoteShareWait(descriptor.index, descriptor.name, descriptor.sessionId);
    showLoader(true, t('share.remote.downloading'));

    const file = await downloadRemoteFile(
      descriptor,
      (progress) => {
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
        bus.emit('remote-file:progress', 'download', progress);
      },
      abort.signal,
    );

    if (abort.signal.aborted) {
      log.debug('[RemoteShare] Active download finished but was superseded; discarding');
      return;
    }

    const previousBlobUrl = getState('share.remote').download.blobUrl;
    if (previousBlobUrl) URL.revokeObjectURL(previousBlobUrl);
    const objectUrl = URL.createObjectURL(file);
    const meta = {
      name: descriptor.name,
      title: descriptor.name.replace(/\.[^/.]+$/, ''),
      index: descriptor.index,
      size: file.size,
      mime: descriptor.mime,
      sessionId: descriptor.sessionId,
    };

    setState('preload.nextFileBlob', file);
    setState('preload.meta', meta);
    setState('preload.nextTrackIndex', descriptor.index);
    setState('files.currentTrack', { name: descriptor.name });
    setState('share.remote', {
      ...getState('share.remote'),
      download: {
        status: 'ready',
        progress: 1,
        blobUrl: objectUrl,
        error: null,
      },
    });

    clearManagedTimer(REMOTE_WAIT_TIMER);
    transition({ type: 'PRELOAD_FILE_READY', index: descriptor.index });
    bus.emit('remote-file:ready', descriptor.index, descriptor.name);
    bus.emit('storage:use-preloaded', descriptor.index, descriptor.name);
  } catch (error) {
    if (isAbortError(error)) {
      log.debug('[RemoteShare] Active download superseded — abort is expected');
      return;
    }
    const message = friendlyErrorMessage(error);
    setState('share.remote', {
      ...getState('share.remote'),
      download: {
        status: 'error',
        progress: 0,
        blobUrl: null,
        error: message,
      },
    });
    log.warn('[RemoteShare] Download/decrypt failed:', error);
    showToast(t('share.remote.download_failed', { msg: message }));
    showLoader(false);
  } finally {
    if (_activeDownload?.objectId === descriptor.objectId) {
      _activeDownload = null;
    }
  }
}

function handleRemoteFileUnavailable(
  data: Record<string, unknown>,
  conn?: DataConnection,
): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;
  if (!isRemoteGuest() && getState('network.connectionType') !== 'unknown') return;

  const index = Number(data.index);
  const sessionId = Number(data.sessionId);
  const name = (data.name as string) || '';
  if (!Number.isFinite(index) || index < 0 || !Number.isFinite(sessionId) || !name) return;

  const pendingTarget = getState('playback.pendingRecoveryTarget');
  const transferMeta = getState('transfer.meta');
  const activeSessionId = Number(transferMeta?.sessionId) || 0;
  const matchesPending = pendingTarget?.index === index && pendingTarget.name === name;
  const matchesSession = activeSessionId === 0 || activeSessionId === sessionId;
  const shouldAct =
    matchesPending &&
    matchesSession &&
    getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD;
  if (!shouldAct) return;

  if (_activeDownload?.index === index) {
    _activeDownload.abort.abort();
    _activeDownload = null;
  }

  const message = data.limited
    ? t('chat.remote_upload_limited_notice')
    : t('chat.remote_upload_failed_notice');
  clearManagedTimer(REMOTE_WAIT_TIMER);
  showLoader(false);
  showToast(message);
  setState('share.remote', {
    ...getState('share.remote'),
    download: {
      status: 'error',
      progress: 0,
      blobUrl: null,
      error: message,
    },
  });
  transition({ type: 'REMOTE_FILE_UNAVAILABLE' });
}

export function initRemoteShare(): void {
  registerHandlers({
    [MSG.REMOTE_FILE_SHARE]: handleRemoteFileShare,
    [MSG.REMOTE_FILE_UNAVAILABLE]: handleRemoteFileUnavailable,
  });

  bus.on('orchestrator:peer-joined', (peerId) => {
    const hostConn = getState('network.hostConn');
    if (hostConn || !isRemoteShareConfigured()) return;

    const peers = getState('network.connectedPeers') || [];
    const peer = peers.find((item) => item.id === peerId);
    if (!peer?.conn?.open) return;
    if (peer.connectionType === 'local') return;

    const currentBlob = getState('files.currentFileBlob');
    if (!(currentBlob instanceof File)) return;
    const sessionId = getState('transfer.currentSessionId') || getState('transfer.localSessionId');
    void shareRemoteFileIfNeeded(currentBlob, sessionId || null, peer.conn);
  });

  bus.on('state:network.sessionCode', (code) => {
    if (!code) {
      // Tear down any in-flight uploads/downloads so a new session starts clean.
      for (const entry of _activeUploads.values()) entry.abort.abort();
      _activeUploads.clear();
      _descriptorCache.clear();
      _activeDownload?.abort.abort();
      _activePreloadDownload?.abort.abort();
      _activeDownload = null;
      _activePreloadDownload = null;
      clearManagedTimer(REMOTE_WAIT_TIMER);
      const blobUrl = getState('share.remote').download.blobUrl;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
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
          blobUrl: null,
          error: null,
        },
      });
    }
  });

  log.info('[RemoteShare] Handlers registered');
}
