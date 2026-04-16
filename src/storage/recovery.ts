/**
 * MUSIXQUARE — File Recovery
 *
 * Manages: Recovery request with progressive backoff,
 * host-side file serving (handleRequestCurrentFile, handleRequestDataRecovery).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, MAX_RECOVERY_RETRIES, RECOVERY_BACKOFF, APP_STATE, TRANSFER_STATE } from '../core/constants.ts';
import { nextSessionId } from '../core/session.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { ensureNamedFile } from './opfs.ts';
import { unicastFile } from './transfer.ts';
import { registerHandlers } from '../network/protocol.ts';
import { isRemoteGuest, hasActiveRelay } from '../network/peer.ts';
import { t } from '../i18n/index.ts';
import type { DataConnection } from '../types/index.ts';
import { showToast, showLoader } from '../ui/toast.ts';

// ─── Guest: Send Recovery Request ───────────────────────────────────

/**
 * Send a recovery request with progressive backoff.
 * Targets relay or host depending on what's available.
 */
export function sendRecoveryRequest(forceChunk: number | null = null): void {
  // Remote guest with no relay: recovery from Host is futile (no direct data channel)
  if (isRemoteGuest() && !hasActiveRelay()) {
    log.info('[Recovery] Remote guest without relay — skipping recovery, showing WiFi guidance');
    clearManagedTimer('chunkWatchdog');
    setState('transfer.state', TRANSFER_STATE.IDLE);
    showLoader(false);
    showToast(t('toast.same_wifi_only'));
    setState('player.currentTrackMeta', {
      type: 'file',
      title: t('toast.same_wifi_file_title'),
      name: '',
      videoId: null,
      playlistId: null,
    });
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
    setState('transfer.state', TRANSFER_STATE.IDLE);
    setState('recovery.pending', false);
    setState('recovery.retryCount', 0);
    showLoader(false);
    showToast(t('transfer.recovery_failed'));
    return;
  }

  // Find best connection
  const upstreamDataConn = getState('relay.upstreamDataConn');
  const hostConn = getState('network.hostConn');
  const targetConn = (upstreamDataConn && upstreamDataConn.open) ? upstreamDataConn : hostConn;

  if (!targetConn || !targetConn.open) {
    log.warn('[Recovery] No healthy connection for recovery');
    return;
  }

  const meta = getState('transfer.meta');
  const pendingFileName = getState('recovery.pendingFileName');
  const fileName = (meta?.name as string) || pendingFileName || '';

  // Progressive backoff
  const backoffMs = RECOVERY_BACKOFF[Math.min(retryCount, RECOVERY_BACKOFF.length - 1)];
  setState('recovery.retryCount', retryCount + 1);
  setState('recovery.pending', true);

  const sourceLabel = targetConn === upstreamDataConn ? 'Relay' : 'Host';
  log.debug(`[Recovery] Attempt ${retryCount + 1}/${MAX_RECOVERY_RETRIES} from ${sourceLabel}: ${fileName} (backoff: ${backoffMs}ms)`);

  setManagedTimer('recovery-backoff', () => {
    setState('recovery.pending', false);

    // Re-fetch connection after backoff — the original reference may be stale
    const freshUpstream = getState('relay.upstreamDataConn');
    const freshHostConn = getState('network.hostConn');
    const freshConn = (freshUpstream && freshUpstream.open) ? freshUpstream : freshHostConn;

    if (!freshConn || !freshConn.open) {
      log.warn('[Recovery] No healthy connection after backoff');
      // Don't consume retry budget if request was never sent
      const currentRetry = getState('recovery.retryCount');
      if (currentRetry > 0) setState('recovery.retryCount', currentRetry - 1);
      return;
    }

    // Check if track changed during backoff
    const latestMeta = getState('transfer.meta');
    const latestName = (latestMeta?.name as string) || getState('recovery.pendingFileName') || '';
    if (latestName && fileName && latestName !== fileName) {
      log.debug('[Recovery] Track changed during backoff, aborting stale recovery');
      setState('recovery.retryCount', 0);
      return;
    }

    // Re-read receivedCount after backoff — more chunks may have arrived during delay
    let chunkToAsk = forceChunk;
    if (chunkToAsk === null) {
      chunkToAsk = getState('transfer.receivedCount') || 0;
    }

    // Re-read sessionId after backoff — session may have advanced during delay
    const freshLocalSid = getState('transfer.localSessionId');
    const freshTransferSid = getState('transfer.currentSessionId');
    const freshSid = freshLocalSid || freshTransferSid;

    // Re-read index after backoff — track position may have changed during delay
    const freshPendingFileIndex = getState('recovery.pendingFileIndex');
    const freshCurrentTrackIndex = getState('playlist.currentTrackIndex');
    const freshIndex = freshPendingFileIndex !== undefined ? freshPendingFileIndex : freshCurrentTrackIndex;

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
  }, backoffMs);
}

// ─── Host: Handle File Requests ─────────────────────────────────────

async function handleRequestCurrentFile(data: Record<string, unknown>, conn: DataConnection): Promise<void> {
  // Only Host serves files directly
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Guest ignores
  if (!conn || !conn.open) return;

  // If Host is in YouTube mode, no local file to serve
  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    try { conn.send({ type: MSG.FILE_WAIT, message: 'Host is playing YouTube' }); } catch { /* noop */ }
    return;
  }

  const reqName = data.name ? String(data.name) : '';
  const reqIndex = data.index !== undefined ? Number(data.index) : undefined;

  // Find matching blob
  const blob = findMatchingBlob(reqName, reqIndex);
  if (!blob) {
    try { conn.send({ type: MSG.FILE_WAIT, message: 'Host file is not ready yet' }); } catch { /* noop */ }
    return;
  }

  const sid = ensureValidSessionId();
  const fallbackName = getBlobFallbackName(blob, reqName);
  const fileToSend = ensureNamedFile(blob, fallbackName);
  if (fileToSend) await unicastFile(conn, fileToSend, 0, sid);
}

async function handleRequestDataRecovery(data: Record<string, unknown>, conn: DataConnection): Promise<void> {
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
  const reqIndex = data.index !== undefined ? Number(data.index) : undefined;

  const blob = findMatchingBlob(reqName, reqIndex);
  if (!blob) {
    try { conn.send({ type: MSG.FILE_WAIT, message: 'Host has no cached file for recovery yet' }); } catch { /* noop */ }
    return;
  }

  // Clamp chunk index
  const total = Math.ceil(blob.size / CHUNK_SIZE);
  if (!Number.isFinite(total) || total <= 0) {
    try { conn.send({ type: MSG.FILE_WAIT, message: 'Invalid file size' }); } catch { /* noop */ }
    return;
  }
  if (startChunk >= total) startChunk = Math.max(0, total - 1);

  const sid = ensureValidSessionId();
  const fallbackName = getBlobFallbackName(blob, reqName);
  const fileToSend = ensureNamedFile(blob, fallbackName);
  if (fileToSend) await unicastFile(conn, fileToSend, startChunk, sid);
}

// ─── Helpers ────────────────────────────────────────────────────────

function findMatchingBlob(reqName: string, reqIndex: number | undefined): Blob | null {
  const currentFileBlob = getState('files.currentFileBlob');
  const meta = getState('transfer.meta');
  const nextFileBlob = getState('preload.nextFileBlob');
  const nextMeta = getState('preload.meta');

  let blob: Blob | null = null;

  if (currentFileBlob) {
    const matchByIndex = reqIndex !== undefined && meta && Number(meta.index) === reqIndex;
    const matchByName = reqName && meta && meta.name === reqName;
    const noHint = !reqName && reqIndex === undefined;
    if (matchByIndex || matchByName || noHint) blob = currentFileBlob;
  }

  if (!blob && nextFileBlob && nextMeta) {
    const matchNextByIndex = reqIndex !== undefined && Number(nextMeta.index) === reqIndex;
    const matchNextByName = reqName && nextMeta.name === reqName;
    if (matchNextByIndex || matchNextByName) blob = nextFileBlob;
  }

  return blob;
}

function ensureValidSessionId(): number {
  const meta = getState('transfer.meta');
  const currentTransferSessionId = getState('transfer.currentSessionId');
  let sid = (meta?.sessionId as number) || currentTransferSessionId;
  if (!sid || sid < 1) {
    sid = nextSessionId();
    setState('transfer.currentSessionId', sid);
  }
  return sid;
}

function getBlobFallbackName(blob: Blob, reqName: string): string {
  const currentFileBlob = getState('files.currentFileBlob');
  const meta = getState('transfer.meta');
  const nextFileBlob = getState('preload.nextFileBlob');
  const nextMeta = getState('preload.meta');

  if (blob === currentFileBlob && meta?.name) return meta.name as string;
  if (blob === nextFileBlob && nextMeta?.name) return nextMeta.name as string;
  return reqName || (meta?.name as string) || (nextMeta?.name as string) || 'Track';
}

// ─── Register Handlers ──────────────────────────────────────────────

export function initRecovery(): void {
  registerHandlers({
    [MSG.REQUEST_CURRENT_FILE]: handleRequestCurrentFile,
    [MSG.REQUEST_DATA_RECOVERY]: handleRequestDataRecovery,
  });

  // Listen for recovery events from other modules
  bus.on('storage:request-recovery', () => {
    sendRecoveryRequest();
  });

  // Clear recovery state on session leave OR new session (reconnect) to
  // prevent stale pending flag from blocking all future recovery requests.
  // M13: Previously only fired when code became falsy (session leave), but
  // reconnect changes code from one truthy value to another, skipping reset.
  bus.on('state:network.sessionCode', () => {
    setState('recovery.pending', false);
    setState('recovery.retryCount', 0);
    clearManagedTimer('recovery-backoff');
  });

  log.info('[Recovery] Handlers registered');
}
