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
import { unicastFile } from './transfer.ts';
import { isPeerConnectionCurrent } from './chunk-pump.ts';
import { registerHandlers } from '../network/protocol.ts';
import { isRemoteGuest } from '../network/peer.ts';
import { canSendFileTo } from '../network/peer-state.ts';
import { isRemoteShareConfigured } from '../share/r2-client.ts';
import { shareRemoteFileIfNeeded } from '../share/remote-share.ts';
import { isDemoTrackName } from '../demo/tracks.ts';
import { t } from '../i18n/index.ts';
import type { DataConnection, FileMeta } from '../types/index.ts';
import { showToast, showLoader } from '../ui/toast.ts';
import {
  createFileTrackMeta,
  isYouTubeOwner,
  setPlaybackTransferState,
  setPlaybackTrackMeta,
} from '../player/ownership.ts';

// ─── Guest: Send Recovery Request ───────────────────────────────────

/**
 * Send a recovery request with progressive backoff.
 * Requests a resend from the host when direct local file transfer is available.
 */
export function sendRecoveryRequest(forceChunk: number | null = null): void {
  // Remote guests receive files through remote-share descriptors; host resend is local-only.
  if (isRemoteGuest()) {
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

  const hostConn = getState('network.hostConn');

  if (!hostConn || !hostConn.open) {
    log.warn('[Recovery] No healthy connection for recovery');
    return;
  }

  const meta = getState('transfer.meta');
  const recoveryTarget = getState('playback.pendingRecoveryTarget');
  const fileName = (meta?.name as string) || recoveryTarget?.name || '';

  // Progressive backoff
  const backoffMs = RECOVERY_BACKOFF[Math.min(retryCount, RECOVERY_BACKOFF.length - 1)];
  setState('recovery.retryCount', retryCount + 1);
  setState('recovery.pending', true);

  log.debug(
    `[Recovery] Attempt ${retryCount + 1}/${MAX_RECOVERY_RETRIES} from Host: ${fileName} (backoff: ${backoffMs}ms)`,
  );

  setManagedTimer(
    'recovery-backoff',
    () => {
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
      const latestMeta = getState('transfer.meta');
      const latestTarget = getState('playback.pendingRecoveryTarget');
      const latestName = (latestMeta?.name as string) || latestTarget?.name || '';
      if (latestName && fileName && latestName !== fileName) {
        log.debug('[Recovery] Track changed during backoff, aborting stale recovery');
        setState('recovery.retryCount', 0);
        return;
      }

      // Re-read sessionId after backoff — session may have advanced during delay
      const freshLocalSid = getState('transfer.localSessionId');
      const freshTransferSid = getState('transfer.currentSessionId');
      const freshSid = freshLocalSid || freshTransferSid;

      // Re-read receivedCount after backoff — more chunks may have arrived during delay.
      // Clamp the control-plane counter to the exact RAM session's contiguous
      // prefix. A same-name slot from another session must force a full resend.
      let chunkToAsk = forceChunk;
      if (chunkToAsk === null) {
        const counterAsk = getState('transfer.receivedCount') || 0;
        chunkToAsk = Math.min(counterAsk, ramContiguousCount(latestName, false, freshSid));
      }

      // Re-read index after backoff — track position may have changed during delay.
      // setPendingRecoveryTarget() guarantees target is null OR a valid pair, so
      // optional-chain returns either a non-negative index or undefined.
      const freshIndex =
        getState('playback.pendingRecoveryTarget')?.index ?? getState('playlist.currentTrackIndex');

      try {
        freshConn.send({
          type: MSG.REQUEST_DATA_RECOVERY,
          nextChunk: chunkToAsk,
          fileName,
          index: freshIndex,
          sessionId: freshSid,
        });
      } catch {
        log.warn('[Recovery] Failed to send recovery request');
      }
    },
    backoffMs,
  );
}

// ─── Host: Handle File Requests ─────────────────────────────────────

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
    try {
      conn.send({ type: MSG.FILE_WAIT, message: 'Host is playing YouTube' });
    } catch {
      /* noop */
    }
    return;
  }

  const reqName = data.name ? String(data.name) : '';
  const requestsAuthoritativeCurrent =
    data.reason === 'missing_transfer_identity' && data.index === undefined;
  // The guest deliberately omits an index only for identity repair. Snapshot
  // the host's current slot at request handling time; guest-supplied names are
  // display fallback only and never select bytes.
  const reqIndex = requestsAuthoritativeCurrent
    ? getState('playlist.currentTrackIndex')
    : typeof data.index === 'number'
      ? data.index
      : undefined;

  // Find matching blob
  const match = findMatchingBlob(reqIndex);
  if (!match) {
    try {
      conn.send({
        type: MSG.FILE_WAIT,
        message: 'Host file is not ready yet',
        ...(requestsAuthoritativeCurrent ? { reason: 'missing_transfer_identity' } : {}),
      });
    } catch {
      /* noop */
    }
    return;
  }

  const sid = ensureValidSessionId(match.sessionId);
  match.sessionId = sid;
  const fallbackName = getBlobFallbackName(match, reqName);
  const fileToSend = ensureNamedFile(match.blob, fallbackName);
  if (!fileToSend) return;

  // Direct unicast is local-only. Remote guests receive a refreshed descriptor;
  // the encrypted bytes continue to travel through object storage.
  const canDirect = await canSendFileTo(conn);
  if (!conn.open || !isPeerConnectionCurrent(conn.peer, conn) || !isCachedBlobMatchCurrent(match))
    return;
  if (canDirect) {
    await unicastFile(conn, fileToSend, 0, sid, {
      trackIndex: match.index,
      skipTransportGuard: true,
      isSourceCurrent: () => isCachedBlobMatchCurrent(match),
    });
    return;
  }
  if (
    isRemoteShareConfigured() &&
    fileToSend instanceof File &&
    !isDemoTrackName(fileToSend.name)
  ) {
    void shareRemoteFileIfNeeded(fileToSend, sid, conn, { index: match.index });
    return;
  }
  // Demo track or share unconfigured: at least tell the guest to wait so its
  // FILE_WAIT timeout path gives feedback instead of silence.
  try {
    conn.send({ type: MSG.FILE_WAIT, message: 'Host cannot serve this peer directly' });
  } catch {
    /* noop */
  }
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
  const reqIndex = typeof data.index === 'number' ? data.index : undefined;
  const reqSessionId = normalizeSessionId(data.sessionId);

  const match = findMatchingBlob(reqIndex, reqSessionId);
  if (!match) {
    try {
      conn.send({ type: MSG.FILE_WAIT, message: 'Host has no cached file for recovery yet' });
    } catch {
      /* noop */
    }
    return;
  }

  // Clamp chunk index
  const total = Math.ceil(match.blob.size / CHUNK_SIZE);
  if (!Number.isFinite(total) || total <= 0) {
    try {
      conn.send({ type: MSG.FILE_WAIT, message: 'Invalid file size' });
    } catch {
      /* noop */
    }
    return;
  }
  if (startChunk >= total) startChunk = Math.max(0, total - 1);

  const sid = ensureValidSessionId(match.sessionId);
  match.sessionId = sid;
  const fallbackName = getBlobFallbackName(match, reqName);
  const fileToSend = ensureNamedFile(match.blob, fallbackName);
  if (fileToSend) {
    await unicastFile(conn, fileToSend, startChunk, sid, {
      trackIndex: match.index,
      isSourceCurrent: () => isCachedBlobMatchCurrent(match),
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

interface CachedBlobMatch {
  blob: Blob;
  meta: Readonly<Partial<FileMeta>>;
  sessionId: number | undefined;
  index: number;
  source: 'current' | 'preload';
}

function normalizeIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeSessionId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
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
function findMatchingBlob(
  reqIndex: number | undefined,
  reqSessionId?: number,
): CachedBlobMatch | null {
  const index = normalizeIndex(reqIndex);
  if (index === undefined) return null;

  const currentFileBlob = getState('files.currentFileBlob');
  const meta = getState('transfer.meta');
  const nextFileBlob = getState('preload.nextFileBlob');
  const nextMeta = getState('preload.meta');
  const playlist = getState('playlist.items');
  const playlistFile = playlist[index]?.file;
  const currentIndex = getState('playlist.currentTrackIndex');

  if (currentFileBlob && meta && currentIndex === index) {
    const metaSessionId = normalizeSessionId(meta.sessionId);
    const stateSessionId = normalizeSessionId(getState('transfer.currentSessionId'));
    const sessionsCoherent =
      metaSessionId === undefined ||
      stateSessionId === undefined ||
      metaSessionId === stateSessionId;
    const candidateSessionId = metaSessionId ?? stateSessionId;
    const objectMatches = !playlistFile || playlistFile === currentFileBlob;
    if (
      meta.index === index &&
      sessionsCoherent &&
      objectMatches &&
      sessionMatches(reqSessionId, candidateSessionId)
    ) {
      return {
        blob: currentFileBlob,
        meta,
        sessionId: candidateSessionId,
        index,
        source: 'current',
      };
    }
  }

  // A preload may serve the main channel only after that playlist slot has
  // become the host's authoritative current track. Sending a future preload
  // while another track is current would combine correct bytes with the wrong
  // playback ownership.
  if (
    nextFileBlob &&
    nextMeta &&
    currentIndex === index &&
    getState('preload.nextTrackIndex') === index
  ) {
    const candidateSessionId = normalizeSessionId(nextMeta.sessionId);
    const objectMatches = !playlistFile || playlistFile === nextFileBlob;
    if (
      nextMeta.index === index &&
      objectMatches &&
      sessionMatches(reqSessionId, candidateSessionId)
    ) {
      return {
        blob: nextFileBlob,
        meta: nextMeta,
        sessionId: candidateSessionId,
        index,
        source: 'preload',
      };
    }
  }

  return null;
}

function isCachedBlobMatchCurrent(match: CachedBlobMatch): boolean {
  if (getState('playlist.currentTrackIndex') !== match.index) return false;
  if (match.source === 'current') {
    const meta = getState('transfer.meta');
    const metaSessionId = normalizeSessionId(meta?.sessionId);
    const stateSessionId = normalizeSessionId(getState('transfer.currentSessionId'));
    const sessionsCoherent =
      metaSessionId === undefined ||
      stateSessionId === undefined ||
      metaSessionId === stateSessionId;
    const currentSessionId = metaSessionId ?? stateSessionId;
    return (
      sessionsCoherent &&
      getState('files.currentFileBlob') === match.blob &&
      meta?.index === match.index &&
      currentSessionId === match.sessionId
    );
  }

  const meta = getState('preload.meta');
  return (
    getState('preload.nextFileBlob') === match.blob &&
    getState('preload.nextTrackIndex') === match.index &&
    meta?.index === match.index &&
    normalizeSessionId(meta?.sessionId) === match.sessionId
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
  if (typeof match.meta.name === 'string' && match.meta.name) return match.meta.name;
  if (typeof File !== 'undefined' && match.blob instanceof File && match.blob.name) {
    return match.blob.name;
  }
  return reqName || 'Track';
}

// ─── Register Handlers ──────────────────────────────────────────────

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
  bus.on('state:network.sessionCode', () => {
    setState('recovery.pending', false);
    setState('recovery.retryCount', 0);
    clearManagedTimer('recovery-backoff');
  });

  log.info('[Recovery] Handlers registered');
}
