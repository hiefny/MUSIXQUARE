/**
 * MUSIXQUARE — File Recovery
 *
 * Manages: Recovery request with progressive backoff,
 * host-side file serving (handleRequestCurrentFile, handleRequestDataRecovery).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import {
  MSG,
  CHUNK_SIZE,
  MAX_RECOVERY_RETRIES,
  RECOVERY_BACKOFF,
  TRANSFER_STATE,
  PLAYBACK_STATE,
} from '../core/constants.ts';
import { nextSessionId } from '../core/session.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { ensureNamedFile } from './storage.ts';
import { ramContiguousCount } from './ramstore.ts';
import { sendFileDeliveryUnavailable, unicastFile } from './transfer.ts';
import { isPeerConnectionCurrent } from './chunk-pump.ts';
import { registerHandlers } from '../network/protocol.ts';
import {
  beginFileRequest,
  isFileRequestId,
  resetFileRequestAuthority,
  sendFileRequest,
} from '../network/file-request-authority.ts';
import { isRemoteGuest, safeSend } from '../network/peer.ts';
import { canSendFileTo } from '../network/peer-state.ts';
import { isRemoteShareConfigured } from '../share/r2-client.ts';
import { shareRemoteFileIfNeeded } from '../share/remote-share.ts';
import {
  isConnectionFileDeliveryPending,
  isConnectionFileDeliveryUnsupported,
} from '../share/file-delivery-policy.ts';
import { t } from '../i18n/index.ts';
import type { DataConnection, ResidentFile } from '../types/index.ts';
import { showToast, showLoader } from '../ui/toast.ts';
import {
  createFileTrackMeta,
  isYouTubeOwner,
  setPlaybackTransferState,
  setPlaybackTrackMeta,
} from '../player/ownership.ts';
import { setPendingRecoveryTarget } from '../player/_state.ts';
import { legacyBoundedFileV1Product } from '../player/legacy-bounded-file-v1-product.ts';
import { isProRoomPersistentPlaylistFile } from '../pro-room/legacy-media-hooks.ts';

let recoveryRequestGeneration = 0;

// ─── Guest: Send Recovery Request ───────────────────────────────────

/**
 * Send a recovery request with progressive backoff.
 * Requests a resend from the host when direct local file transfer is available.
 */
export function sendRecoveryRequest(forceChunk: number | null = null): void {
  const selectedQueueItemId = getState('playlist.currentQueueItemId');
  const isProDirect = !!selectedQueueItemId && isProRoomPersistentPlaylistFile(selectedQueueItemId);
  // Remote guests receive files through remote-share descriptors; host resend is local-only.
  if (isRemoteGuest() && !isProDirect) {
    log.info('[Recovery] Remote guest - skipping direct host recovery');
    clearManagedTimer('chunkWatchdog');
    if (
      getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD &&
      getState('playback.pendingRecoveryTarget')
    ) {
      log.debug('[Recovery] Remote-share wait active - suppressing direct recovery UI');
      return;
    }
    setPlaybackTransferState(TRANSFER_STATE.IDLE);
    showLoader(false);
    showToast(t('share.remote.unavailable'));
    const name = getState('playback.pendingRecoveryTarget')?.name || '';
    setPlaybackTrackMeta(createFileTrackMeta(name));
    return;
  }

  const hostConn = getState('network.hostConn');
  const meta = getState('transfer.meta');
  const queueItemId = selectedQueueItemId || '';
  const metaOwnsSelection = meta?.queueItemId === queueItemId;
  const boundedSessionId = metaOwnsSelection
    ? (normalizeSessionId(meta.sessionId) ??
      normalizeSessionId(getState('transfer.localSessionId')) ??
      normalizeSessionId(getState('transfer.currentSessionId')))
    : undefined;
  if (
    hostConn?.open &&
    queueItemId &&
    boundedSessionId &&
    legacyBoundedFileV1Product.ownsGuestTransfer(hostConn, queueItemId, boundedSessionId)
  ) {
    log.debug('[Recovery] Exact bounded guest transfer owns recovery; suppressing legacy request');
    cancelPendingRecoveryRequest();
    clearManagedTimer('chunkWatchdog');
    return;
  }

  const pending = getState('recovery.pending');
  if (pending) {
    log.debug('[Recovery] Request already pending, skipping');
    return;
  }

  const retryCount = getState('recovery.retryCount');
  if (retryCount >= MAX_RECOVERY_RETRIES) {
    log.error(`[Recovery] Max retries (${MAX_RECOVERY_RETRIES}) exceeded. Giving up.`);
    clearManagedTimer('chunkWatchdog');
    setPlaybackTransferState(TRANSFER_STATE.IDLE);
    setState('recovery.pending', false);
    setState('recovery.retryCount', 0);
    showLoader(false);
    showToast(t('transfer.recovery_failed'));
    return;
  }

  if (!hostConn || !hostConn.open) {
    log.warn('[Recovery] No healthy connection for recovery');
    return;
  }

  const recoveryTarget = getState('playback.pendingRecoveryTarget');
  if (!queueItemId) {
    log.warn('[Recovery] Missing queue item identity; refusing metadata fallback');
    return;
  }
  const targetOwnsSelection = recoveryTarget?.queueItemId === queueItemId;
  const playlistItem = getState('playlist.items').find((item) => item.queueItemId === queueItemId);
  const fileName =
    (targetOwnsSelection ? recoveryTarget.name : '') ||
    (metaOwnsSelection ? (meta.name as string) : '') ||
    playlistItem?.name ||
    '';
  if (!fileName) {
    log.warn('[Recovery] Missing selected file name; refusing recovery request');
    return;
  }

  // Progressive backoff
  const backoffMs = RECOVERY_BACKOFF[Math.min(retryCount, RECOVERY_BACKOFF.length - 1)];
  const requestGeneration = recoveryRequestGeneration;
  setState('recovery.retryCount', retryCount + 1);
  setState('recovery.pending', true);

  log.debug(
    `[Recovery] Attempt ${retryCount + 1}/${MAX_RECOVERY_RETRIES} from Host: ${fileName} (backoff: ${backoffMs}ms)`,
  );

  setManagedTimer(
    'recovery-backoff',
    () => {
      if (requestGeneration !== recoveryRequestGeneration) return;
      setState('recovery.pending', false);

      // Re-fetch connection after backoff — the original reference may be stale
      const freshConn = getState('network.hostConn');

      if (!freshConn || !freshConn.open) {
        log.warn('[Recovery] No healthy connection after backoff');
        // Don't consume retry budget if request was never sent
        const currentRetry = getState('recovery.retryCount');
        if (currentRetry > 0) setState('recovery.retryCount', currentRetry - 1);
        return;
      }

      // Check if track changed during backoff
      const latestTarget = getState('playback.pendingRecoveryTarget');
      if (
        getState('playlist.currentQueueItemId') !== queueItemId ||
        (latestTarget !== null && latestTarget.queueItemId !== queueItemId)
      ) {
        log.debug('[Recovery] Track changed during backoff, aborting stale recovery');
        setState('recovery.retryCount', 0);
        return;
      }

      // Re-read sessionId after backoff — session may have advanced during delay
      const latestMeta = getState('transfer.meta');
      const latestMetaOwnsSelection = latestMeta?.queueItemId === queueItemId;
      const freshSid = latestMetaOwnsSelection
        ? (normalizeSessionId(latestMeta.sessionId) ??
          normalizeSessionId(getState('transfer.localSessionId')) ??
          normalizeSessionId(getState('transfer.currentSessionId')))
        : undefined;
      if (
        freshSid &&
        legacyBoundedFileV1Product.ownsGuestTransfer(freshConn, queueItemId, freshSid)
      ) {
        log.debug(
          '[Recovery] Exact bounded guest transfer claimed the target during backoff; suppressing legacy request',
        );
        cancelPendingRecoveryRequest();
        clearManagedTimer('chunkWatchdog');
        return;
      }

      // Re-read receivedCount after backoff — more chunks may have arrived during delay.
      // Clamp the control-plane counter to the exact RAM session's contiguous
      // prefix. A same-name slot from another session must force a full resend.
      let chunkToAsk = forceChunk;
      if (chunkToAsk === null) {
        const counterAsk = getState('transfer.receivedCount') || 0;
        chunkToAsk = Math.min(counterAsk, ramContiguousCount(queueItemId, false, freshSid ?? 0));
      }

      // Re-read the stable recovery target after backoff; its position may have changed.
      // The stable queue occurrence remains authoritative across the backoff;
      // its current position is only a UI projection.
      const owner = beginFileRequest(freshConn, queueItemId, freshSid);
      if (
        !sendFileRequest(owner, {
          type: MSG.REQUEST_DATA_RECOVERY,
          nextChunk: chunkToAsk,
          fileName,
        })
      ) {
        log.warn('[Recovery] Failed to send recovery request');
      }
    },
    backoffMs,
  );
}

// ─── Host: Handle File Requests ─────────────────────────────────────

function routeProRoomFileRequest(
  data: Record<string, unknown>,
  conn: DataConnection,
  queueItemId: string,
): boolean {
  if (!isProRoomPersistentPlaylistFile(queueItemId)) return false;
  const resident = getState('files.current');
  if (
    resident?.queueItemId !== queueItemId ||
    getState('playlist.currentQueueItemId') !== queueItemId
  ) {
    sendFileWait(conn, data, 'PRO room file is not ready yet');
    return true;
  }

  const sessionId = ensureValidSessionId(resident.sessionId);
  safeSend(conn, {
    type: MSG.FILE_PREPARE,
    name: resident.name,
    mime: resident.mime || resident.blob.type || 'application/octet-stream',
    size: resident.blob.size,
    queueItemId,
    sessionId,
    autoPlayDelayMs: 0,
  });
  return true;
}

async function handleRequestCurrentFile(
  data: Record<string, unknown>,
  conn: DataConnection,
): Promise<void> {
  // Only Host serves files directly
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Guest ignores
  if (!conn || !conn.open) return;

  // If Host is in YouTube mode, no local file to serve
  if (isYouTubeOwner()) {
    sendFileWait(conn, data, 'Host is playing YouTube');
    return;
  }

  const reqName = data.name ? String(data.name) : '';
  const queueItemId = typeof data.queueItemId === 'string' ? data.queueItemId : '';
  if (!queueItemId) return;
  if (routeProRoomFileRequest(data, conn, queueItemId)) return;
  const reqSessionId = normalizeSessionId(data.sessionId);

  // Find matching blob
  const match = findMatchingBlob(queueItemId, reqSessionId);
  if (!match) {
    sendFileWait(
      conn,
      data,
      'Host file is not ready yet',
      data.reason === 'missing_transfer_identity' ? 'missing_transfer_identity' : undefined,
    );
    return;
  }

  const sid = ensureValidSessionId(match.sessionId);
  match.sessionId = sid;
  const fallbackName = getBlobFallbackName(match, reqName);
  const fileToSend = ensureNamedFile(match.blob, fallbackName);
  if (!fileToSend) return;

  // Follow the frozen per-session route. New remote peers receive a refreshed
  // descriptor; an already-direct connection stays on its current engine.
  const canDirect = await canSendFileTo(conn, sid);
  if (!conn.open || !isPeerConnectionCurrent(conn.peer, conn) || !isCachedBlobMatchCurrent(match))
    return;
  if (canDirect) {
    await unicastFile(conn, fileToSend, 0, sid, {
      queueItemId: match.queueItemId,
      skipTransportGuard: true,
      isSourceCurrent: () => isCachedBlobMatchCurrent(match),
    });
    return;
  }
  if (isConnectionFileDeliveryPending(conn, sid)) {
    sendFileWait(conn, data, 'Host is still evaluating the file delivery route');
    return;
  }
  if (isConnectionFileDeliveryUnsupported(conn, sid)) {
    sendFileDeliveryUnavailable(conn, { name: fallbackName, queueItemId: match.queueItemId }, sid);
    return;
  }
  if (isRemoteShareConfigured() && fileToSend instanceof File) {
    void shareRemoteFileIfNeeded(fileToSend, sid, conn, { queueItemId: match.queueItemId });
    return;
  }
  // Share unconfigured: tell the guest to wait so its FILE_WAIT timeout path
  // gives feedback instead of silence.
  sendFileWait(conn, data, 'Host cannot serve this peer directly');
}

async function handleRequestDataRecovery(
  data: Record<string, unknown>,
  conn: DataConnection,
): Promise<void> {
  // Only Host serves recovery directly
  const hostConn = getState('network.hostConn');
  if (hostConn) return;
  if (!conn || !conn.open) return;

  // Normalize start chunk
  let startChunk = 0;
  if (data.nextChunk !== undefined) {
    const n = Number(data.nextChunk);
    if (Number.isFinite(n) && n > 0) startChunk = Math.floor(n);
  }

  const reqName = data.fileName || data.name ? String(data.fileName || data.name) : '';
  const queueItemId = typeof data.queueItemId === 'string' ? data.queueItemId : '';
  if (!queueItemId) return;
  if (routeProRoomFileRequest(data, conn, queueItemId)) return;
  const reqSessionId = normalizeSessionId(data.sessionId);

  const match = findMatchingBlob(queueItemId, reqSessionId);
  if (!match) {
    sendFileWait(conn, data, 'Host has no cached file for recovery yet');
    return;
  }

  // Clamp chunk index
  const total = Math.ceil(match.blob.size / CHUNK_SIZE);
  if (!Number.isFinite(total) || total <= 0) {
    sendFileWait(conn, data, 'Invalid file size');
    return;
  }
  if (startChunk >= total) startChunk = Math.max(0, total - 1);

  const sid = ensureValidSessionId(match.sessionId);
  match.sessionId = sid;
  const fallbackName = getBlobFallbackName(match, reqName);
  const fileToSend = ensureNamedFile(match.blob, fallbackName);
  if (fileToSend) {
    const canDirect = await canSendFileTo(conn, sid);
    if (!conn.open || !isPeerConnectionCurrent(conn.peer, conn) || !isCachedBlobMatchCurrent(match))
      return;
    if (canDirect) {
      await unicastFile(conn, fileToSend, startChunk, sid, {
        queueItemId: match.queueItemId,
        skipTransportGuard: true,
        isSourceCurrent: () => isCachedBlobMatchCurrent(match),
      });
      return;
    }
    if (isConnectionFileDeliveryPending(conn, sid)) {
      sendFileWait(conn, data, 'Host is still evaluating the file delivery route');
      return;
    }
    if (isConnectionFileDeliveryUnsupported(conn, sid)) {
      sendFileDeliveryUnavailable(
        conn,
        { name: fallbackName, queueItemId: match.queueItemId },
        sid,
      );
      return;
    }
    if (isRemoteShareConfigured() && fileToSend instanceof File) {
      void shareRemoteFileIfNeeded(fileToSend, sid, conn, { queueItemId: match.queueItemId });
      return;
    }
    sendFileWait(conn, data, 'Host cannot serve this peer directly');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

interface CachedBlobMatch {
  entry: Readonly<ResidentFile>;
  blob: Blob;
  sessionId: number;
  queueItemId: string;
  source: 'current' | 'preload';
}

function normalizeSessionId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Echo the complete request tuple so a guest cannot accept a stale wait frame. */
function sendFileWait(
  conn: DataConnection,
  data: Record<string, unknown>,
  message: string,
  reason?: string,
): void {
  const requestId = data.requestId;
  const queueItemId = data.queueItemId;
  const sessionId = normalizeSessionId(data.sessionId);
  if (
    !isFileRequestId(requestId) ||
    typeof queueItemId !== 'string' ||
    queueItemId.length === 0 ||
    (data.sessionId !== undefined && sessionId === undefined)
  ) {
    log.warn('[Recovery] Refusing uncorrelated FILE_WAIT response');
    return;
  }

  try {
    conn.send({
      type: MSG.FILE_WAIT,
      message,
      requestId,
      queueItemId,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(reason === undefined ? {} : { reason }),
    });
  } catch {
    /* noop */
  }
}

function sessionMatches(
  requestedSessionId: number | undefined,
  candidateSessionId: number | undefined,
): boolean {
  return requestedSessionId === undefined || requestedSessionId === candidateSessionId;
}

/**
 * Resolve cached bytes by explicit playlist/session identity.
 *
 * Names are intentionally absent from this selector. They are display and
 * transport metadata, not content identity, so a name-only request must wait
 * for a fresh transfer instead of reusing possibly unrelated bytes.
 */
function findMatchingBlob(queueItemId: string, reqSessionId?: number): CachedBlobMatch | null {
  if (!queueItemId) return null;
  const current = getState('files.current');
  const preload = getState('preload.ready');
  const playlist = getState('playlist.items');
  const playlistItem = playlist.find((item) => item.queueItemId === queueItemId);
  const playlistFile = playlistItem?.file;
  const currentQueueItemId = getState('playlist.currentQueueItemId');

  if (current && currentQueueItemId === queueItemId) {
    const objectMatches = !playlistFile || playlistFile === current.blob;
    if (
      current.queueItemId === queueItemId &&
      objectMatches &&
      sessionMatches(reqSessionId, current.sessionId)
    ) {
      return {
        entry: current,
        blob: current.blob,
        sessionId: current.sessionId,
        queueItemId,
        source: 'current',
      };
    }
  }

  // A preload may serve the main channel only after that queue occurrence has
  // become the host's authoritative current track. Sending a future preload
  // while another track is current would combine correct bytes with the wrong
  // playback ownership.
  if (
    preload &&
    currentQueueItemId === queueItemId &&
    getState('preload.nextQueueItemId') === queueItemId
  ) {
    const objectMatches = !playlistFile || playlistFile === preload.blob;
    if (
      preload.queueItemId === queueItemId &&
      objectMatches &&
      sessionMatches(reqSessionId, preload.sessionId)
    ) {
      return {
        entry: preload,
        blob: preload.blob,
        sessionId: preload.sessionId,
        queueItemId,
        source: 'preload',
      };
    }
  }

  return null;
}

function isCachedBlobMatchCurrent(match: CachedBlobMatch): boolean {
  if (getState('playlist.currentQueueItemId') !== match.queueItemId) return false;
  if (match.source === 'current') {
    return getState('files.current') === match.entry;
  }

  return (
    getState('preload.ready') === match.entry &&
    getState('preload.nextQueueItemId') === match.queueItemId
  );
}

function ensureValidSessionId(preferredSessionId: number | undefined): number {
  const existing = normalizeSessionId(preferredSessionId);
  if (existing !== undefined) return existing;

  const sid = nextSessionId();
  setState('transfer.currentSessionId', sid);
  return sid;
}

function getBlobFallbackName(match: CachedBlobMatch, reqName: string): string {
  if (match.entry.name) return match.entry.name;
  if (typeof File !== 'undefined' && match.blob instanceof File && match.blob.name) {
    return match.blob.name;
  }
  return reqName || 'Track';
}

// ─── Register Handlers ──────────────────────────────────────────────

/** Reset guest recovery ownership at a replacement host boundary. */
function cancelPendingRecoveryRequest(): void {
  recoveryRequestGeneration += 1;
  clearManagedTimer('recovery-backoff');
  resetFileRequestAuthority();
  setState('recovery.pending', false);
  setState('recovery.retryCount', 0);
}

export function resetRecoveryAuthority(): void {
  cancelPendingRecoveryRequest();
  setPendingRecoveryTarget(null);
}

export function initRecovery(): void {
  registerHandlers({
    [MSG.REQUEST_CURRENT_FILE]: handleRequestCurrentFile,
    [MSG.REQUEST_DATA_RECOVERY]: handleRequestDataRecovery,
  });

  // Normalize the optional forced offset because ordinary recovery events do
  // not include one.
  bus.on('storage:request-recovery', (forceChunk?: number) => {
    sendRecoveryRequest(typeof forceChunk === 'number' ? forceChunk : null);
  });

  // Reset on every session-code change, including reconnects between two
  // non-empty codes, so pending state cannot cross session boundaries.
  bus.on('state:network.sessionCode', resetRecoveryAuthority);
  // A selection change also invalidates a scheduled backoff closure. Without
  // this, an old A callback could claim ownership again after B starts.
  bus.on('state:playlist.currentQueueItemId', cancelPendingRecoveryRequest);

  log.info('[Recovery] Handlers registered');
}
