/**
 * MUSIXQUARE — RAM-only storage adapter
 *
 * Routes STORAGE_* commands to the in-memory ramstore. Encoded chunks
 * live in `Uint8Array[]` per session, blobs are built with `new Blob([…])`
 * on finalize, and reads slice from the cached blob. There is no worker
 * hop, no `navigator.storage.getDirectory()` writes, no disk persistence.
 *
 * Memory characteristics
 * ──────────────────────
 *   - Active main blob:    ~5–15 MB typical mp3, up to ~50 MB hi-res
 *   - Preload blobs:       depth × track size (preload depth is 1–2)
 *   - Decoded AudioBuffer: ~80 MB / 4-min song
 * Foreground footprint typically lands at 100–150 MB — well inside the
 * iOS PWA budget. Long podcasts can still crash on AudioBuffer decode;
 * that's a hard ceiling no storage strategy softens.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { TRANSFER_STATE } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { INSTANCE_ID, validateSessionId } from '../core/session.ts';
import type { StorageCommand, StorageEvent } from '../types/index.ts';
import { showLoader } from '../ui/toast.ts';
import { setPlaybackTransferState } from '../player/ownership.ts';
import {
  ramStart,
  ramWrite,
  ramEnd,
  ramReadChunk,
  ramReadBlob,
  ramCleanup,
  ramResetSession,
  ramReset,
} from './ramstore.ts';

// ─── Instance ID (same as core session) ─────────────────────────────
// INSTANCE_ID used directly (no alias needed)

// ─── Command Dispatch ───────────────────────────────────────────────

/**
 * Validate, normalise, and dispatch a storage command. Storage commands
 * never hop a worker on RAM-only — they're routed in-process to ramstore.
 * Timer/worker commands live in network/sync-worker.ts.
 */
export function postCommand(payload: StorageCommand): void {
  if (!payload || !payload.command) return;

  const cmd = payload.command;

  if (
    cmd !== 'STORAGE_RESET' &&
    cmd !== 'STORAGE_RESET_SESSION' &&
    cmd !== 'STORAGE_CLEANUP'
  ) {
    if (!payload.filename) log.warn(`[Storage] Missing filename in ${cmd}`);

    payload.sessionId = validateSessionId(payload.sessionId ?? 0);

    const isCriticalOp = cmd === 'STORAGE_START' || cmd === 'STORAGE_WRITE' || cmd === 'STORAGE_END';
    if (isCriticalOp && !payload.sessionId) {
      log.error(`[Storage] Blocked ${cmd}: invalid sessionId`, payload);
      return;
    }
  }

  if (cmd === 'STORAGE_RESET_SESSION') {
    payload.sessionId = validateSessionId(payload.sessionId ?? 0);
    if (!payload.sessionId) {
      log.warn(`[Storage] Dropped STORAGE_RESET_SESSION: invalid sessionId`);
      return;
    }
  }

  routeStorageCommand(payload);
}

// ─── In-Process Bridge ──────────────────────────────────────────────
//
// Runs STORAGE_* commands against the ramstore and synthesizes the same
// response messages a worker would have posted, so the existing
// `handleStorageResponse` switch (and downstream bus events)
// stay unchanged. We `queueMicrotask` the dispatch to preserve the
// async-postMessage semantics consumers rely on — without it, ack
// callbacks could land before the calling stack frame returns and
// surprise call-chain logic.

function routeStorageCommand(payload: StorageCommand): void {
  queueMicrotask(() => {
    try {
      runStorageCommand(payload);
    } catch (err) {
      log.error('[Ramstore] command failed:', err);
    }
  });
}

function runStorageCommand(payload: StorageCommand): void {
  const cmd = payload.command;
  const filename = (payload.filename as string) || '';
  const isPreload = !!payload.isPreload;
  const sessionId = (payload.sessionId as number) || 0;

  switch (cmd) {
    case 'STORAGE_START': {
      const chunkSize = (payload.size as number) || 16384;
      const keepExisting = !!payload.keepExisting;
      const result = ramStart(filename, isPreload, sessionId, chunkSize, keepExisting);
      if (result.ok) {
        dispatchStorageEvent({ type: 'STORAGE_STARTED', filename, isPreload, sessionId });
      } else {
        dispatchStorageEvent({
          type: 'STORAGE_ERROR',
          error: result.reason || 'start failed',
          filename,
          isPreload,
          code: 'START_FAILED',
        });
      }
      return;
    }

    case 'STORAGE_WRITE': {
      const rawChunk = payload.chunk as unknown;
      const chunk =
        rawChunk instanceof Uint8Array
          ? rawChunk
          : rawChunk instanceof ArrayBuffer
            ? new Uint8Array(rawChunk)
            : ArrayBuffer.isView(rawChunk) && (rawChunk as ArrayBufferView).buffer
              ? new Uint8Array(
                  (rawChunk as ArrayBufferView).buffer,
                  (rawChunk as ArrayBufferView).byteOffset,
                  (rawChunk as ArrayBufferView).byteLength,
                )
              : null;
      if (!chunk) {
        dispatchStorageEvent({
          type: 'STORAGE_WRITE_ERROR',
          error: 'Invalid chunk',
          filename,
          index: payload.index as number | undefined,
          isPreload,
        });
        return;
      }
      const index = payload.index as number;
      const result = ramWrite(filename, isPreload, sessionId, index, chunk);
      if (!result.ok && result.reason === 'Session mismatch') {
        dispatchStorageEvent({
          type: 'SESSION_MISMATCH',
          command: 'STORAGE_WRITE',
          expected: result.expectedSid ?? null,
          received: sessionId,
          filename,
          isPreload,
        });
        dispatchStorageEvent({
          type: 'STORAGE_WRITE_ERROR',
          error: 'Session mismatch',
          filename,
          index,
          isPreload,
          code: 'SESSION_MISMATCH',
        });
      }
      // Other failure modes (Session not found / Filename mismatch /
      // Already finalized) are silently dropped, matching the worker.
      return;
    }

    case 'STORAGE_END': {
      const totalSize = payload.totalSize as number | undefined;
      const expectedChunks = payload.total as number | undefined;
      const result = ramEnd(filename, isPreload, sessionId, totalSize, expectedChunks);
      if (result.blob) {
        dispatchStorageEvent({ type: 'STORAGE_FILE_READY', filename, isPreload, sessionId });
      } else if (result.reason && result.reason.startsWith('Integrity Fail')) {
        dispatchStorageEvent({
          type: 'STORAGE_ERROR',
          error: result.reason,
          filename,
          isPreload,
          code: 'INTEGRITY_FAIL',
        });
      } else if (result.reason === 'Session mismatch') {
        dispatchStorageEvent({
          type: 'SESSION_MISMATCH',
          command: 'STORAGE_END',
          expected: result.expectedSid ?? null,
          received: sessionId,
          filename,
          isPreload,
        });
      }
      return;
    }

    case 'STORAGE_RESET': {
      ramReset(isPreload);
      dispatchStorageEvent({ type: 'STORAGE_RESET_COMPLETE', isPreload });
      return;
    }

    case 'STORAGE_RESET_SESSION': {
      // RAM-only contract: per-sid cleanup is preload-only (mirrors the
      // worker behaviour where this command targets `preloadSlots`).
      ramResetSession(sessionId, true);
      // No response — matches worker.
      return;
    }

    case 'STORAGE_CLEANUP': {
      const result = ramCleanup(filename, isPreload);
      dispatchStorageEvent({
        type: 'STORAGE_CLEANUP_COMPLETE',
        filename,
        isPreload,
        skipped: result.skipped,
      });
      return;
    }

    case 'STORAGE_READ': {
      const index = payload.index as number;
      const requestId = payload.requestId;
      // ramReadChunk is async (slices a Blob → ArrayBuffer). Don't block
      // the calling microtask; resolve and dispatch when ready.
      ramReadChunk(filename, isPreload, sessionId, index)
        .then((chunk) => {
          if (chunk) {
            dispatchStorageEvent({
              type: 'STORAGE_READ_COMPLETE',
              chunk,
              index,
              filename,
              requestId,
              sessionId,
            });
          } else {
            dispatchStorageEvent({
              type: 'STORAGE_READ_ERROR',
              error: 'Slot not found',
              filename,
              index,
              requestId,
            });
          }
        })
        .catch((e) => {
          dispatchStorageEvent({
            type: 'STORAGE_READ_ERROR',
            error: (e as Error)?.message ?? String(e),
            filename,
            index,
            requestId,
          });
        });
      return;
    }

    default:
      log.warn(`[Ramstore] Unknown storage command: ${cmd}`);
  }
}

/**
 * Synthesize the MessageEvent shape that `handleStorageResponse`
 * expects, so all the existing bus.emit / state mutation logic in that
 * switch keeps running unchanged.
 */
function dispatchStorageEvent(response: StorageEvent): void {
  handleStorageResponse({
    data: response,
  } as MessageEvent<StorageEvent>);
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Cleanup a stored file by logical filename. Fire-and-forget with a 10 s
 * watchdog — if the cleanup ack doesn't come back in time we log and
 * release the listener so the bus subscription doesn't leak.
 *
 * The watchdog's managed-timer key is prefixed by `p`/`c` (preload vs
 * current pool) and the filename so two simultaneous cleanups for the
 * same logical name on different pools don't share a timer slot.
 */
export function cleanupStoredFile(filename: string, isPreload: boolean): void {
  if (!filename) return;

  const watchdogName = `cleanup-watchdog-${isPreload ? 'p' : 'c'}-${filename}`;

  setManagedTimer(
    watchdogName,
    () => {
      log.warn(`[Storage] Cleanup watchdog: no response for "${filename}" after 10s — moving on`);
      unsub();
    },
    10_000,
  );

  const unsub = bus.on('storage:cleanup-complete', (cleanedFile: unknown) => {
    if (cleanedFile === filename) {
      clearManagedTimer(watchdogName);
      unsub();
    }
  });

  postCommand({
    command: 'STORAGE_CLEANUP',
    filename,
    isPreload,
    instanceId: INSTANCE_ID,
  });
}

/**
 * Read a finalized file from the ramstore. Wrapped as a `File` so callers
 * that introspect `.name` continue to work — same return-type contract as
 * the worker branch where `getFile()` already gave them a File.
 */
export async function readStoredFile(filename: string, isPreload: boolean): Promise<File | null> {
  if (!filename) return null;
  const blob = ramReadBlob(filename, isPreload);
  if (!blob) return null;
  try {
    return new File([blob], filename, { type: blob.type || '' });
  } catch (err) {
    log.error('[Ramstore] readStoredFile wrap failed:', err);
    return null;
  }
}

// ─── Worker Message Handlers ────────────────────────────────────────

function handleStorageResponse(e: MessageEvent<StorageEvent>): void {
  const data = e.data;
  if (!data || !data.type) return;

  // Wrap entire switch in try/catch — an uncaught exception here kills
  // ALL subsequent worker message processing, permanently breaking file
  // transfer for the rest of the session.
  try {
    switch (data.type) {
      case 'STORAGE_STARTED':
        log.debug(`[Storage] Session started: ${data.filename} (SID: ${data.sessionId})`);
        break;

      case 'STORAGE_FILE_READY':
        log.debug(`[Storage] File finalized: ${data.filename} (SID: ${data.sessionId})`);
        bus.emit(
          'storage:file-ready',
          data.filename || '',
          data.sessionId || 0,
          data.isPreload || false,
        );
        break;

      case 'STORAGE_READ_COMPLETE':
        bus.emit('storage:read-complete', data);
        break;

      case 'STORAGE_WRITE_ERROR':
        log.warn(`[Storage] Write error for ${data.filename} chunk ${data.index}:`, data.error);
        // Notify transfer module so it can trigger recovery instead of silently
        // continuing with a corrupted file (missing chunk data).
        bus.emit('storage:write-error', {
          filename: data.filename || '',
          chunkIndex: data.index,
          isPreload: data.isPreload || false,
        });
        break;

      case 'STORAGE_READ_ERROR':
        log.error(`[Storage] Read error for ${data.filename}:`, data.error);
        bus.emit('storage:read-error', data);
        break;

      case 'STORAGE_ERROR': {
        const isPreload = !!data.isPreload;
        log.error(`[Storage] Worker error: ${data.error} (${data.filename}, code: ${data.code})`);
        bus.emit('storage:error', data.error || '', data.filename || '');

        if (!isPreload) {
          if (data.code === 'INTEGRITY_FAIL') {
            // File finalization failed — trigger recovery to re-fetch the file
            log.warn('[Storage] Integrity fail — requesting recovery');
            bus.emit('storage:request-recovery');
          } else if (data.code === 'START_FAILED' || data.code === 'LOCKED') {
            // Lock acquisition failed — reset transfer state to prevent stuck loader.
            // Check both RECEIVING and PROCESSING: with fast transfers, main thread
            // may detect completion (PROCESSING) before the worker reports START_FAILED.
            const transferState = getState('transfer.state');
            if (
              transferState === TRANSFER_STATE.RECEIVING ||
              transferState === TRANSFER_STATE.PROCESSING
            ) {
              log.warn(`[Storage] Start/lock failed — resetting stuck ${transferState} state`);
              setPlaybackTransferState(TRANSFER_STATE.IDLE);
              showLoader(false);
            }
          }
        }
        break;
      }

      case 'SESSION_MISMATCH': {
        const isPreload = !!data.isPreload;
        log.warn(
          `[Storage] Session Mismatch: ${data.filename} cmd=${data.command} (${isPreload ? 'preload' : 'current'})`,
        );
        // Preload mismatches are non-fatal
        if (!isPreload) {
          bus.emit('storage:session-mismatch', data);

          // Safety net: if STORAGE_END was dropped while state is PROCESSING,
          // the transfer is stuck forever (no watchdog, no STORAGE_FILE_READY).
          // Reset state so the UI doesn't stay on "수신 중... 100%".
          //
          // Use IDLE (not READY) for symmetry with the START_FAILED/LOCKED
          // branch above: the worker dropped the END command, so the file
          // on disk is unfinalized and NOT actually playable. Marking READY
          // would lie about playability; any caller that keys off transfer
          // state would think the file is ready when it isn't.
          if (data.command === 'STORAGE_END') {
            const transferState = getState('transfer.state');
            if (transferState === TRANSFER_STATE.PROCESSING) {
              log.warn('[Storage] STORAGE_END dropped — resetting stuck PROCESSING state');
              setPlaybackTransferState(TRANSFER_STATE.IDLE);
              showLoader(false);
            }
          }
        }
        break;
      }

      case 'WORKER_ERROR':
        log.error(`[Storage] Worker error: ${data.error} (command: ${data.command})`);
        break;

      case 'STORAGE_RESET_COMPLETE':
        log.debug('[Storage] Reset complete');
        break;

      case 'STORAGE_CLEANUP_COMPLETE':
        if (data.skipped) {
          // The worker held a lock on this filename and bailed without removing
          // it. The file stays on disk; without a follow-up the entry orphans.
          // The fire-and-forget caller already moved on, so the best we can do
          // here is log loudly. Real recovery happens when the next STORAGE_RESET
          // for this file releases the lock and a subsequent cleanup succeeds.
          log.warn(`[Storage] Cleanup skipped (file still locked): ${data.filename}`);
        } else {
          log.debug(`[Storage] Cleanup complete: ${data.filename}`);
        }
        bus.emit('storage:cleanup-complete', data.filename || '');
        break;

      default:
        log.debug(`[Storage] Unknown worker message: ${data.type}`);
    }
  } catch (err) {
    log.error(`[Storage] Worker message handler crashed on ${data.type}:`, err);
  }
}

// ─── Ensure Named File ──────────────────────────────────────────────

/**
 * Ensure a blob has a name property (wraps in File if needed).
 */
export function ensureNamedFile(
  blob: Blob | File | null,
  fallbackName: string,
): File | Blob | null {
  if (!blob) return null;
  try {
    if ('name' in blob && typeof blob.name === 'string' && blob.name) return blob;
    const name =
      fallbackName && String(fallbackName).trim() ? String(fallbackName).trim() : 'Track';
    return new File([blob], name, { type: blob.type || '' });
  } catch {
    return blob;
  }
}
