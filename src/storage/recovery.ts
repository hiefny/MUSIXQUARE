/**
 * MUSIXQUARE 2.0 — File Recovery
 * Extracted from original app.js lines 9072-9173, 9778-9845
 *
 * Manages: Recovery request with progressive backoff,
 * host-side file serving (handleRequestCurrentFile, handleRequestDataRecovery).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, MAX_RECOVERY_RETRIES, RECOVERY_BACKOFF, APP_STATE, TRANSFER_STATE } from '../core/constants.ts';
import { nextSessionId } from '../core/session.ts';
import { clearManagedTimer } from '../core/timers.ts';
import { ensureNamedFile } from './opfs.ts';
import { unicastFile } from './transfer.ts';
import { registerHandlers } from '../network/protocol.ts';
import type { DataConnection } from '../types/index.ts';

// ─── Guest: Send Recovery Request ───────────────────────────────────

/**
 * Send a recovery request with progressive backoff.
 * Targets relay or host depending on what's available.
 */
export function sendRecoveryRequest(forceChunk: number | null = null): void {
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
    bus.emit('ui:show-loader', false);
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
  const pendingFileIndex = getState('recovery.pendingFileIndex');
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const receivedCount = getState('transfer.receivedCount');
  const localSid = getState('transfer.localSessionId');
  const currentTransferSid = getState('transfer.currentSessionId');

  const fileName = (meta?.name as string) || pendingFileName || '';
  const index = pendingFileIndex !== undefined ? pendingFileIndex : currentTrackIndex;
  const currentSid = localSid || currentTransferSid;

  let chunkToAsk = forceChunk;
  if (chunkToAsk === null) {
    chunkToAsk = receivedCount || 0;
  }

  // Progressive backoff
  const backoffMs = RECOVERY_BACKOFF[Math.min(retryCount, RECOVERY_BACKOFF.length - 1)];
  setState('recovery.retryCount', retryCount + 1);
  setState('recovery.pending', true);

  const sourceLabel = targetConn === upstreamDataConn ? 'Relay' : 'Host';
  log.debug(`[Recovery] Attempt ${retryCount + 1}/${MAX_RECOVERY_RETRIES} from ${sourceLabel}: ${fileName} (Chunk: ${chunkToAsk}, backoff: ${backoffMs}ms)`);

  setTimeout(() => {
    setState('recovery.pending', false);

    // Re-check connection after backoff
    if (!targetConn.open) {
      log.warn('[Recovery] Connection closed during backoff');
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

    try {
      targetConn.send({
        type: MSG.REQUEST_DATA_RECOVERY,
        nextChunk: chunkToAsk,
        fileName,
        index,
        sessionId: currentSid,
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

  log.info('[Recovery] Handlers registered');
}
