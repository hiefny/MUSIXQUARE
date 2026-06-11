/**
 * Remote file sharing over temporary encrypted object storage.
 *
 * This is intentionally a side path: LAN P2P transfer remains the primary
 * path, while remote/unknown guests receive an encrypted R2 descriptor.
 *
 * MSG.REMOTE_FILE_SHARE carries only the active CURRENT track descriptor.
 * Remote speculative preload is intentionally disabled: mobile guests avoid
 * extra R2 downloads, decrypted Blob retention, battery/GC churn, and URL
 * expiry races. Legacy `preload: true` descriptors are accepted on the wire
 * for compatibility but ignored by this client.
 *
 * Concurrency: only ONE active descriptor download runs at a time. A newer
 * active descriptor cancels the in-flight one via AbortController.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, PLAYBACK_STATE } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import { sendSystemNotice } from '../chat/protocol.ts';
import { registerHandlers } from '../network/protocol.ts';
import { broadcast, isRemoteGuest, safeSend, waitForGuestConnectionType } from '../network/peer.ts';
import { transition } from '../player/lifecycle.ts';
import { createFileTrackMeta, isExternalOwner, setPlaybackTrackMeta } from '../player/ownership.ts';
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
import { isCapabilityChallengeCancelled } from '../core/capability.ts';
import { isDemoTrackName } from '../demo/tracks.ts';
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
  /** Latest descriptor received for this object — the PUBLISH context.
   *  Same objectId = same bytes, but the playback context (index/sessionId)
   *  can move mid-download when the host re-selects a duplicate playlist
   *  entry; completion must publish under the latest context (EXT-4). */
  descriptor: RemoteFileSharePayload;
  abort: AbortController;
}

// Upload tracking stays keyed by playback request so existing cancellation
// semantics remain narrow while an upload is still in flight.
//
// DELIBERATE: there is NO per-track navigate-away cancel. In-flight uploads
// run to completion even when the host moves on — staleness is enforced at
// COMPLETION time by the broadcast-gate triplet in shareRemoteFileIfNeeded
// (hasRemoteTargets / isHostActiveFile / isExternalOwner, HET-3) and
// absorbed guest-side by the monotonic context gates (EXT-5/6/7). The
// abandoned-upload bandwidth is the accepted price for (a) descriptor-cache
// warm-up — a rapid A↔B re-selection re-shares instantly instead of
// re-encrypting + re-uploading — and (b) the shared in-flight promise that
// targeted recovery sends await (HET-6): aborting an entry would reject ALL
// awaiters, and isAbortError swallows that silently (no toast, no
// REMOTE_FILE_UNAVAILABLE) — a remote-guest dead end. The only upload aborts
// are the true teardown boundaries: no-remote-targets-remain
// (abortActiveUploadsIfNoRemoteTargets) and session-code teardown.
const _activeUploads = new Map<string, UploadEntry>();
// Completed descriptors are keyed by file fingerprint so revisiting a track
// can reuse the already-encrypted R2 object until it expires.
const _descriptorCache = new Map<string, RemoteFileSharePayload>();

// Only one active (foreground) download at a time. A newer one supersedes
// the in-flight one via abort.
let _activeDownload: DownloadEntry | null = null;

// Monotonic context gate that outlives the in-flight window (EXT-6): the
// last playback context adopted from any descriptor. R2 completion timing is
// independent of control-message order, so a late composed-stale
// REQUEST_CURRENT_FILE response can land AFTER _activeDownload was cleared —
// it must not rewind the wait or start a redundant re-download. Reset on any
// session boundary (a new host's sessionId space restarts).
let _lastAdoptedRemoteContext: { objectId: string; index: number; sessionId: number } | null =
  null;

function adoptRemoteContext(descriptor: RemoteFileSharePayload): void {
  _lastAdoptedRemoteContext = {
    objectId: descriptor.objectId,
    index: descriptor.index,
    sessionId: Number(descriptor.sessionId) || 0,
  };
}
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

function toRemoteShareMessage(descriptor: RemoteFileSharePayload): AnyProtocolMsg {
  return { type: MSG.REMOTE_FILE_SHARE, ...descriptor } as AnyProtocolMsg;
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

function uploadRequestKey(file: File, sessionId: number, index: number): string {
  return JSON.stringify([
    sessionId,
    index,
    file.name,
    file.size,
    file.lastModified,
    file.type || '',
  ]);
}

function currentRemoteShareRoomId(): string {
  return getState('network.sessionCode') || getState('network.myId') || 'room';
}

function descriptorCacheKey(file: File, roomId: string): string {
  return JSON.stringify([roomId, file.name, file.size, file.lastModified, file.type || '']);
}

function withPlaybackContext(
  descriptor: RemoteFileSharePayload,
  sessionId: number,
  index: number,
): RemoteFileSharePayload {
  if (descriptor.sessionId === sessionId && descriptor.index === index) return descriptor;
  return { ...descriptor, sessionId, index };
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
  const key = limited ? 'chat.remote_upload_limited_notice' : 'chat.remote_upload_failed_notice';
  for (const conn of targets) {
    sendSystemNotice(conn, key);
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.message === 'REMOTE_SHARE_ABORTED') return true;
  // Treat a Turnstile cancel the same as an abort: user-initiated dismiss,
  // no toast, no failure notice to peers. Pairs with the cancel propagation
  // added in r2-client.requestUploadSession (15차 audit F-1601).
  return isCapabilityChallengeCancelled(error);
}

function resetRemoteDownloadState(message: string | null = null): void {
  const remote = getState('share.remote');
  const blobUrl = remote.download.blobUrl;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  setState('share.remote', {
    ...remote,
    download: {
      status: 'idle',
      progress: 0,
      blobUrl: null,
      error: message,
    },
  });
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

function abortActiveUploadsIfNoRemoteTargets(reason: string): void {
  if (getState('network.hostConn')) return;
  if (hasRemoteTargets()) return;
  if (_activeUploads.size === 0) return;

  for (const entry of _activeUploads.values()) {
    entry.abort.abort();
  }
  _activeUploads.clear();
  resetRemoteUploadState();
  showLoader(false, undefined, REMOTE_UPLOAD_LOADER);
  log.info(`[RemoteShare] Active upload cancelled (${reason})`);
}

export function cancelRemoteShareWait(reason: string): void {
  const hadActiveDownload = !!_activeDownload;

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
}

export function shouldWaitForRemoteShare(): boolean {
  return isRemoteShareConfigured();
}

interface ShareRemoteFileOptions {
  /**
   * Override for the index recorded on the wire. Omitted active shares
   * default to playlist.currentTrackIndex.
   */
  index?: number;
}

/**
 * Host-side: encrypt + upload the file and broadcast the descriptor to
 * remote guests. Completed uploads are reused for the same file while fresh,
 * rebasing the wire descriptor to the current playback session/index.
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
  if (!isRemoteShareConfigured()) return;
  if (sessionId === null) return;
  if (!targetConn && !hasRemoteTargets()) return;

  const index =
    options?.index !== undefined
      ? options.index
      : (getState('playlist.currentTrackIndex') as number);
  if (!Number.isFinite(index) || index < 0) return;

  const roomId = currentRemoteShareRoomId();
  const uploadKey = uploadRequestKey(file, sessionId, index);
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
        showUploadProgress(t('share.remote.uploading'));
        descriptor = await inFlight.promise;
      } else {
        const abort = new AbortController();
        const promise = uploadRemoteFile(file, sessionId, index, {
          signal: abort.signal,
          onUploadProgress: (progress) => {
            showUploadProgress(t('share.remote.uploading'), progress);
          },
        });

        const entry: UploadEntry = { key: uploadKey, promise, abort };
        _activeUploads.set(uploadKey, entry);

        showToast(t('share.remote.encrypting'));
        showUploadProgress(t('share.remote.encrypting'));

        try {
          descriptor = await promise;
          _descriptorCache.set(cacheKey, descriptor);
        } finally {
          if (_activeUploads.get(uploadKey) === entry) _activeUploads.delete(uploadKey);
        }
      }
    }

    showLoader(false, undefined, REMOTE_UPLOAD_LOADER);

    // Stale-track guard (broadcast-mode only): if the host moved on during
    // the upload, suppress the broadcast so guests don't get a descriptor
    // for a track they already advanced past.
    if (!targetConn) {
      if (!hasRemoteTargets()) {
        log.debug(
          '[RemoteShare] Upload completed but no remote targets remain; descriptor not broadcast',
        );
        return;
      }
      if (!isHostActiveFile(file, index)) {
        log.debug(
          '[RemoteShare] Active upload completed for stale track; descriptor not broadcast',
        );
        return;
      }
      // Mode sibling of the check above: isHostActiveFile passes on blob
      // identity even after a file→YouTube/system-audio switch (the switch
      // doesn't clear files.currentFileBlob), which would broadcast a
      // descriptor for a track nobody is playing — remote guests would stomp
      // their index/title UI and burn mobile data on a download that aborts
      // at activation. If the host flips back to file mode before the upload
      // completes, this stays false and the broadcast proceeds (and the
      // descriptor cache makes the return-to-file re-share instant).
      if (isExternalOwner()) {
        log.debug(
          '[RemoteShare] Upload completed but external playback mode owns the room; descriptor not broadcast',
        );
        return;
      }
    }

    const outboundDescriptor = withPlaybackContext(descriptor, sessionId, index);
    const msg = toRemoteShareMessage(outboundDescriptor);
    if (targetConn) {
      safeSend(targetConn, msg);
    } else {
      broadcast(msg);
    }
    log.info(`[RemoteShare] Shared encrypted descriptor for ${outboundDescriptor.name}`);
    showToast(t('share.remote.upload_ready'));
  } catch (error) {
    if (isAbortError(error)) {
      log.debug('[RemoteShare] Upload superseded — abort path is expected');
      return;
    }
    showLoader(false, undefined, REMOTE_UPLOAD_LOADER);
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
    maybeNotifyRemoteUploadFailure(error, file, sessionId, index, targetConn);
    showToast(t('share.remote.upload_failed', { msg: message }));
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
    setPlaybackTrackMeta(playlist[index]);
  } else {
    setPlaybackTrackMeta(createFileTrackMeta(name));
  }

  transition({ type: 'FILE_PREPARE', variant: 'preload-waiting', index, name });
  showLoader(true, t('share.remote.waiting'));

  clearManagedTimer(REMOTE_WAIT_TIMER);
  setManagedTimer(
    REMOTE_WAIT_TIMER,
    () => {
      const readyBlob = getState('preload.nextFileBlob');
      const readyMeta = getState('preload.meta');
      if (readyBlob && readyMeta && Number(readyMeta.index) === index && readyMeta.name === name) {
        return;
      }
      log.warn('[RemoteShare] Wait timed out before descriptor/download completed');
      showToast(t('share.remote.timeout'));
      showLoader(false);
      // Release the lifecycle gate (DV-2 hardening): without this the guest
      // stayed AWAITING_PRELOAD forever — every later PLAY deferred, the
      // SYNC_PONG bootstrap skipped, and the local play button busy-blocked.
      // FAILED is inert and lets the next host PLAY re-drive recovery.
      if (getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD) {
        transition({ type: 'REMOTE_FILE_UNAVAILABLE' });
      }
    },
    REMOTE_WAIT_MS,
  );
}

function isCurrentRemoteFileLoaded(descriptor: RemoteFileSharePayload): boolean {
  const currentBlob = getState('files.currentFileBlob');
  const meta = getState('transfer.meta');
  if (!currentBlob || !meta) return false;
  const metaSessionId = Number(meta.sessionId);
  const sessionMatches = !Number.isFinite(metaSessionId) || metaSessionId === descriptor.sessionId;
  return (
    Number(meta.index) === descriptor.index &&
    meta.name === descriptor.name &&
    currentBlob.size === descriptor.size &&
    sessionMatches
  );
}

function isPreloadedRemoteFile(
  descriptor: RemoteFileSharePayload,
  blob: Blob,
  meta: unknown,
): boolean {
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

async function handleRemoteFileShare(
  descriptor: RemoteFileSharePayload,
  conn?: DataConnection,
): Promise<void> {
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  if (getState('network.connectionType') === 'unknown') {
    const resolved = await waitForGuestConnectionType(3000);
    if (resolved === 'local') return;
  } else if (!isRemoteGuest()) {
    return;
  }

  // Remote speculative preload is disabled. Ignore legacy descriptors from
  // mixed-version hosts; the active descriptor will arrive when selected.
  if (descriptor.preload === true) {
    log.debug('[RemoteShare] Ignoring remote preload descriptor; policy is active-only');
    return;
  }

  if (isDemoTrackName(descriptor.name)) {
    log.debug('[RemoteShare] Ignoring demo descriptor; demo uses the HTTP fallback path');
    return;
  }

  if (isCurrentRemoteFileLoaded(descriptor)) {
    log.debug('[RemoteShare] Active descriptor already loaded, ignoring duplicate');
    clearManagedTimer(REMOTE_WAIT_TIMER);
    return;
  }

  // Fast-path: an active descriptor for a track we already have in the
  // preload slot. Skip the redundant download and promote the existing blob.
  const preMeta = getState('preload.meta');
  const preBlob = getState('preload.nextFileBlob');
  if (preBlob && isPreloadedRemoteFile(descriptor, preBlob, preMeta)) {
    log.info(
      `[RemoteShare] Active descriptor matches preloaded blob (index ${descriptor.index}); promoting`,
    );

    adoptRemoteContext(descriptor);
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
      setPlaybackTrackMeta(playlist[descriptor.index]);
    } else {
      setPlaybackTrackMeta(createFileTrackMeta(descriptor.name));
    }
    clearManagedTimer(REMOTE_WAIT_TIMER);
    transition({
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      index: descriptor.index,
      name: descriptor.name,
    });
    bus.emit('storage:use-preloaded', descriptor.index, descriptor.name);
    return;
  }

  // Monotonic context gate beyond the in-flight window (EXT-6): a late
  // composed-stale response (same/older sessionId, different index) arriving
  // after _activeDownload was cleared would otherwise enter the fresh-download
  // path below and rewind the wait via prepareRemoteShareWait — plus re-fetch
  // bytes already on device. A re-send of the SAME playback context stays
  // allowed so failure recovery (e.g. decode-failure re-request) can retry.
  if (_lastAdoptedRemoteContext) {
    const last = _lastAdoptedRemoteContext;
    const incomingSid = Number(descriptor.sessionId);
    const isNewerContext = Number.isFinite(incomingSid) && incomingSid > last.sessionId;
    // Same playback context = same index + sessionId. objectId is
    // deliberately NOT compared (EXT-7): when the host's descriptor cache
    // expired, the recovery path re-uploads the SAME track as a NEW R2
    // object under the same sid/index — that re-issue must pass or the
    // guest can never recover. Rewind protection only needs to block a
    // DIFFERENT index at a same/older sessionId.
    const isSameContextResend =
      descriptor.index === last.index && incomingSid === last.sessionId;
    if (!isNewerContext && !isSameContextResend) {
      log.debug(
        `[RemoteShare] Stale descriptor context ignored (index ${descriptor.index}, sid ${descriptor.sessionId} ≤ adopted ${last.sessionId})`,
      );
      return;
    }
  }

  // Active descriptor: supersede any in-flight active download for a
  // DIFFERENT object (newer track wins). Same-object dedup keeps the
  // in-flight download but must adopt the NEW playback context.
  if (_activeDownload) {
    if (_activeDownload.objectId === descriptor.objectId) {
      // Same bytes — keep downloading. But a duplicate playlist entry or a
      // host re-click re-sends the cached descriptor rebased to a new
      // index/sessionId; dropping it wholesale made completion publish the
      // ORIGINAL context, so the guest adopted a stale track identity and
      // the wait timer (keyed on the new index) fired a spurious timeout
      // toast (EXT-4). Re-point the publish context + wait machinery
      // (prepareRemoteShareWait is idempotent for an identical context).
      //
      // Adopt only a STRICTLY NEWER context (EXT-5): host re-selection
      // always bumps sessionId, while a late targeted REQUEST_CURRENT_FILE
      // response is composed as (current sid, requested — possibly stale —
      // index): findMatchingBlob name-matches across indices and targeted
      // sends bypass the broadcast-only stale-track guard. Adopting it
      // unconditionally would rewind the wait to the old index. The channel
      // is ordered, so a genuinely newer broadcast always lands before any
      // later-composed response — strict monotonic sid covers every
      // interleaving.
      const trackedSid = Number(_activeDownload.descriptor.sessionId);
      const incomingSid = Number(descriptor.sessionId);
      const isNewerContext =
        Number.isFinite(incomingSid) && (!Number.isFinite(trackedSid) || incomingSid > trackedSid);
      if (isNewerContext) {
        _activeDownload.descriptor = descriptor;
        adoptRemoteContext(descriptor);
        prepareRemoteShareWait(descriptor.index, descriptor.name, descriptor.sessionId);
        log.debug('[RemoteShare] Duplicate active descriptor — download kept, context re-pointed');
      } else {
        log.debug('[RemoteShare] Duplicate active descriptor (same/older context), ignoring');
      }
      return;
    }
    log.info(
      `[RemoteShare] Newer active descriptor (index ${descriptor.index}) supersedes in-flight (index ${_activeDownload.descriptor.index})`,
    );
    _activeDownload.abort.abort();
  }

  const abort = new AbortController();
  _activeDownload = {
    objectId: descriptor.objectId,
    descriptor,
    abort,
  };
  adoptRemoteContext(descriptor);

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

    // One bounded retry on transient failures (network blip / timeout): the
    // local P2P pipeline gets a 3-retry recovery loop, but a remote guest's
    // failed download was terminal — silent until the host changed tracks.
    // Non-transient errors (404/expired/429), supersede-aborts, and expired
    // descriptors never retry.
    let file: File;
    for (let attempt = 1; ; attempt++) {
      try {
        file = await downloadRemoteFile(descriptor, onDownloadProgress, abort.signal);
        break;
      } catch (error) {
        const raw = rawRemoteShareError(error);
        const transient =
          raw === 'REMOTE_SHARE_DOWNLOAD_NETWORK' || raw === 'REMOTE_SHARE_DOWNLOAD_TIMEOUT';
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

    // No object URL here on purpose: share.remote.download.blobUrl had ZERO
    // consumers, and createObjectURL pinned the full decrypted file until
    // document unload — one leaked track (up to 200MB) per remote→remote
    // switch, because the next descriptor's fetch-start nulled the field
    // without revoking. Playback consumes the File via preload.nextFileBlob →
    // storage:use-preloaded → decode.ts, which manages its own URL.
    // Publish under the LATEST context received for this object — a
    // same-object descriptor may have re-pointed it mid-download (EXT-4).
    // The closure `descriptor` is only the transport context (URL/key);
    // track identity comes from the active entry.
    const publishDescriptor =
      _activeDownload?.objectId === descriptor.objectId ? _activeDownload.descriptor : descriptor;

    const meta = {
      name: publishDescriptor.name,
      title: publishDescriptor.name.replace(/\.[^/.]+$/, ''),
      index: publishDescriptor.index,
      size: file.size,
      mime: publishDescriptor.mime,
      sessionId: publishDescriptor.sessionId,
    };

    setState('preload.nextFileBlob', file);
    setState('preload.meta', meta);
    setState('preload.nextTrackIndex', publishDescriptor.index);
    setState('files.currentTrack', { name: publishDescriptor.name });
    setState('share.remote', {
      ...getState('share.remote'),
      download: {
        status: 'ready',
        progress: 1,
        blobUrl: null,
        error: null,
      },
    });

    clearManagedTimer(REMOTE_WAIT_TIMER);
    transition({ type: 'PRELOAD_FILE_READY', index: publishDescriptor.index });
    bus.emit('storage:use-preloaded', publishDescriptor.index, publishDescriptor.name);
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

function handleRemoteFileUnavailable(data: Record<string, unknown>, conn?: DataConnection): void {
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

  if (_activeDownload?.descriptor.index === index) {
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

  bus.on('orchestrator:peer-evaluated', () => {
    abortActiveUploadsIfNoRemoteTargets('all-peers-local');
  });

  bus.on('state:network.sessionCode', (code) => {
    // Any session boundary invalidates the adopted-context gate — a new
    // host's sessionId space restarts. Not keyed on the falsy branch below:
    // a reconnect can change the code truthy→truthy (M13).
    _lastAdoptedRemoteContext = null;
    if (!code) {
      // Tear down any in-flight uploads/downloads so a new session starts clean.
      for (const entry of _activeUploads.values()) entry.abort.abort();
      _activeUploads.clear();
      _descriptorCache.clear();
      _activeDownload?.abort.abort();
      _activeDownload = null;
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
