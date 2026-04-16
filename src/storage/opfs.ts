/**
 * MUSIXQUARE — OPFS Worker Wrapper
 *
 * Manages: transfer.worker communication, OPFS commands routing,
 * session ID validation for worker commands, cleanup helpers.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { TRANSFER_STATE } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { INSTANCE_ID, validateSessionId } from '../core/session.ts';
import type { WorkerCommand, WorkerResponse } from '../types/index.ts';
import { showLoader } from '../ui/toast.ts';

// ─── Worker References ──────────────────────────────────────────────
let _transferWorker: Worker | null = null;
let _syncWorker: Worker | null = null;

// ─── Worker Timer IDs ───────────────────────────────────────────────
const WORKER_TIMER_IDS = ['video-sync'];

// ─── OPFS Instance ID (same as core session) ───────────────────────
// INSTANCE_ID used directly (no alias needed)

// ─── Worker Initialization ──────────────────────────────────────────

export function setTransferWorker(worker: Worker): void {
  _transferWorker = worker;
  _transferWorker.onmessage = handleTransferWorkerMessage;
  worker.onerror = (e) => { log.error('[Worker] Unhandled error:', e); };
}

export function setSyncWorker(worker: Worker): void {
  _syncWorker = worker;
  _syncWorker.onmessage = handleSyncWorkerMessage;
  worker.onerror = (e) => { log.error('[Worker] Unhandled error:', e); };
}

// ─── Command Dispatch ───────────────────────────────────────────────

/**
 * Send a command to the appropriate worker.
 * OPFS commands go to transferWorker; timer commands go to syncWorker.
 */
export function postWorkerCommand(payload: WorkerCommand, transfers?: Transferable[]): void {
  if (!payload || !payload.command) return;

  const cmd = payload.command;

  // OPFS commands require filename + valid numeric sessionId
  if (cmd.startsWith('OPFS_') && cmd !== 'OPFS_RESET' && cmd !== 'OPFS_CLEANUP') {
    if (!payload.filename) log.warn(`[Worker] Missing filename in ${cmd}`);

    payload.sessionId = validateSessionId(payload.sessionId ?? 0);

    // For critical write-path operations, never send with sid=0
    const isCriticalOp = (cmd === 'OPFS_START' || cmd === 'OPFS_WRITE' || cmd === 'OPFS_END');
    if (isCriticalOp && !payload.sessionId) {
      log.error(`[Worker] Blocked ${cmd}: invalid sessionId`, payload);
      return;
    }
  }

  if (cmd.startsWith('OPFS_')) {
    if (_transferWorker) {
      _transferWorker.postMessage(payload, transfers || []);
    } else {
      log.warn(`[Worker] TransferWorker not ready. Dropping command: ${cmd}`);
    }
  } else {
    if (_syncWorker) {
      _syncWorker.postMessage(payload, transfers || []);
    } else {
      log.warn(`[Worker] SyncWorker not ready. Dropping command: ${cmd}`);
    }
  }
}

// ─── OPFS Helpers ───────────────────────────────────────────────────

/**
 * Build the OPFS entry name used by transfer.worker.js.
 */
export function buildSafeOpfsName(filename: string, isPreload = false): string {
  const sanitized = String(filename || '').replace(/[^a-z0-9._-]/gi, '_');
  return (isPreload ? 'preload_' : 'current_') + sanitized + '_' + INSTANCE_ID;
}

/**
 * Cleanup OPFS file in worker.
 * Fire-and-forget with a 10s watchdog — if the worker doesn't confirm
 * cleanup in time, we log a warning and move on (non-blocking).
 */
export function cleanupOPFSInWorker(filename: string, isPreload: boolean): void {
  if (!filename) return;

  const expectedOpfsName = buildSafeOpfsName(filename, isPreload);
  const watchdogName = `opfs-cleanup-watchdog-${expectedOpfsName}`;

  setManagedTimer(watchdogName, () => {
    log.warn(`[OPFS] Cleanup watchdog: no response for "${filename}" after 10s — moving on`);
    unsub();
  }, 10_000);

  const unsub = bus.on('opfs:cleanup-complete', (cleanedFile: unknown) => {
    if (cleanedFile === filename || cleanedFile === expectedOpfsName) {
      clearManagedTimer(watchdogName);
      unsub();
    }
  });

  postWorkerCommand({
    command: 'OPFS_CLEANUP',
    filename,
    isPreload,
    instanceId: INSTANCE_ID,
  });
}

/**
 * Read a finalized file from OPFS.
 */
export async function readFileFromOpfs(filename: string, isPreload: boolean): Promise<File | null> {
  if (!filename) return null;
  if (!(navigator.storage && navigator.storage.getDirectory)) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const safeName = buildSafeOpfsName(filename, isPreload);
    const fileHandle = await root.getFileHandle(safeName);
    return await fileHandle.getFile();
  } catch (err) {
    log.error('[OPFS] readFileFromOpfs failed:', err);
    return null;
  }
}

// ─── Stop Background Worker Timers ──────────────────────────────────

export function stopBackgroundWorkerTimers(): void {
  WORKER_TIMER_IDS.forEach((id) => {
    try { postWorkerCommand({ command: 'STOP_TIMER', id }); } catch { /* noop */ }
  });
}

// ─── Worker Message Handlers ────────────────────────────────────────

function handleTransferWorkerMessage(e: MessageEvent<WorkerResponse>): void {
  const data = e.data;
  if (!data || !data.type) return;

  // Wrap entire switch in try/catch — an uncaught exception here kills
  // ALL subsequent worker message processing, permanently breaking file
  // transfer for the rest of the session.
  try { switch (data.type) {
    case 'OPFS_STARTED':
      log.debug(`[OPFS] Session started: ${data.filename} (SID: ${data.sessionId})`);
      break;

    case 'OPFS_FILE_READY':
      log.debug(`[OPFS] File finalized: ${data.filename} (SID: ${data.sessionId})`);
      bus.emit('opfs:file-ready', data.filename || '', data.sessionId || 0, data.isPreload || false);
      break;

    case 'OPFS_READ_COMPLETE':
      bus.emit('opfs:read-complete', data);
      break;

    case 'OPFS_WRITE_ERROR':
      log.warn(`[OPFS] Write error for ${data.filename} chunk ${data.index}:`, data.error);
      // Notify transfer module so it can trigger recovery instead of silently
      // continuing with a corrupted file (missing chunk data).
      bus.emit('opfs:write-error', { filename: data.filename || '', chunkIndex: data.index, isPreload: data.isPreload || false });
      break;

    case 'OPFS_READ_ERROR':
      log.error(`[OPFS] Read error for ${data.filename}:`, data.error);
      bus.emit('opfs:read-error', data);
      break;

    case 'OPFS_ERROR': {
      const isPreload = !!data.isPreload;
      log.error(`[OPFS] Worker error: ${data.error} (${data.filename}, code: ${data.code})`);
      bus.emit('opfs:error', data.error || '', data.filename || '');

      if (!isPreload) {
        if (data.code === 'INTEGRITY_FAIL') {
          // File finalization failed — trigger recovery to re-fetch the file
          log.warn('[OPFS] Integrity fail — requesting recovery');
          bus.emit('storage:request-recovery');
        } else if (data.code === 'START_FAILED' || data.code === 'LOCKED') {
          // Lock acquisition failed — reset transfer state to prevent stuck loader.
          // Check both RECEIVING and PROCESSING: with fast transfers, main thread
          // may detect completion (PROCESSING) before the worker reports START_FAILED.
          const transferState = getState('transfer.state');
          if (transferState === TRANSFER_STATE.RECEIVING || transferState === TRANSFER_STATE.PROCESSING) {
            log.warn(`[OPFS] Start/lock failed — resetting stuck ${transferState} state`);
            setState('transfer.state', TRANSFER_STATE.IDLE);
            showLoader(false);
          }
        }
      }
      break;
    }

    case 'SESSION_MISMATCH': {
      const isPreload = !!data.isPreload;
      log.warn(`[OPFS] Session Mismatch: ${data.filename} cmd=${data.command} (${isPreload ? 'preload' : 'current'})`);
      // Preload mismatches are non-fatal
      if (!isPreload) {
        bus.emit('opfs:session-mismatch', data);

        // Safety net: if OPFS_END was dropped while state is PROCESSING,
        // the transfer is stuck forever (no watchdog, no OPFS_FILE_READY).
        // Reset state so the UI doesn't stay on "수신 중... 100%".
        if (data.command === 'OPFS_END') {
          const transferState = getState('transfer.state');
          if (transferState === TRANSFER_STATE.PROCESSING) {
            log.warn('[OPFS] OPFS_END dropped — resetting stuck PROCESSING state');
            setState('transfer.state', TRANSFER_STATE.READY);
            showLoader(false);
          }
        }
      }
      break;
    }

    case 'WORKER_ERROR':
      log.error(`[OPFS] Worker error: ${data.error} (command: ${data.command})`);
      break;

    case 'OPFS_RESET_COMPLETE':
      log.debug('[OPFS] Reset complete');
      break;

    case 'OPFS_CLEANUP_COMPLETE':
      log.debug(`[OPFS] Cleanup complete: ${data.filename}`);
      bus.emit('opfs:cleanup-complete', data.filename || '');
      break;

    default:
      log.debug(`[OPFS] Unknown worker message: ${data.type}`);
  } } catch (err) {
    log.error(`[OPFS] Worker message handler crashed on ${data.type}:`, err);
  }
}

function handleSyncWorkerMessage(e: MessageEvent): void {
  const data = e.data;
  if (!data) return;

  if (data.type === 'TICK') {
    bus.emit('worker:timer-tick', data.id);
  } else if (data.type === 'WORKER_ERROR') {
    log.warn('[SyncWorker] Error:', data.error);
  }
}

// ─── Ensure Named File ──────────────────────────────────────────────

/**
 * Ensure a blob has a name property (wraps in File if needed).
 */
export function ensureNamedFile(blob: Blob | File | null, fallbackName: string): File | Blob | null {
  if (!blob) return null;
  try {
    if ('name' in blob && typeof blob.name === 'string' && blob.name) return blob;
    const name = (fallbackName && String(fallbackName).trim()) ? String(fallbackName).trim() : 'Track';
    return new File([blob], name, { type: blob.type || '' });
  } catch {
    return blob;
  }
}

// ─── Bus Event Handlers ─────────────────────────────────────────

/** Forward sync commands from bus to the sync worker */
bus.on('worker:sync-command', (payload: { command: string; id: string; interval?: number }) => {
  if (payload && payload.command) {
    postWorkerCommand(payload);
  }
});
