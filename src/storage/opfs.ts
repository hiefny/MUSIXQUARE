/**
 * MUSIXQUARE 2.0 — OPFS Worker Wrapper
 * Extracted from original app.js lines 304-340, 1376-1712
 *
 * Manages: transfer.worker communication, OPFS commands routing,
 * session ID validation for worker commands, cleanup helpers.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { TRANSFER_STATE } from '../core/constants.ts';
import { INSTANCE_ID, validateSessionId } from '../core/session.ts';
import type { WorkerCommand, WorkerResponse } from '../types/index.ts';

// ─── Worker References ──────────────────────────────────────────────
let _transferWorker: Worker | null = null;
let _syncWorker: Worker | null = null;

// ─── Worker Timer IDs ───────────────────────────────────────────────
const WORKER_TIMER_IDS = ['heartbeat', 'ping', 'video-sync'];

// ─── OPFS Instance ID (same as core session) ───────────────────────
const OPFS_INSTANCE_ID = INSTANCE_ID;

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

export function getTransferWorker(): Worker | null { return _transferWorker; }
export function getSyncWorker(): Worker | null { return _syncWorker; }

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
  return (isPreload ? 'preload_' : 'current_') + sanitized + '_' + OPFS_INSTANCE_ID;
}

/**
 * Cleanup OPFS file in worker.
 */
export function cleanupOPFSInWorker(filename: string, isPreload: boolean): void {
  if (!filename) return;
  postWorkerCommand({
    command: 'OPFS_CLEANUP',
    filename,
    isPreload,
    instanceId: OPFS_INSTANCE_ID,
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

  switch (data.type) {
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
      break;

    case 'OPFS_READ_ERROR':
      log.error(`[OPFS] Read error for ${data.filename}:`, data.error);
      bus.emit('opfs:read-error', data);
      break;

    case 'OPFS_ERROR':
      log.error(`[OPFS] Worker error: ${data.error} (${data.filename})`);
      bus.emit('opfs:error', data.error || '', data.filename || '');
      break;

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
          const transferState = getState<string>('transfer.state');
          if (transferState === TRANSFER_STATE.PROCESSING) {
            log.warn('[OPFS] OPFS_END dropped — resetting stuck PROCESSING state');
            setState('transfer.state', TRANSFER_STATE.READY);
            bus.emit('ui:show-loader', false);
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
      break;

    default:
      log.debug(`[OPFS] Unknown worker message: ${data.type}`);
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
