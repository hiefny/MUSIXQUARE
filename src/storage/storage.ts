/**
 * MUSIXQUARE — RAM-only storage adapter
 *
 * Same external API as the OPFS worker wrapper preserved on
 * `mxqr_slotpool_archive` (postWorkerCommand, readStoredFile,
 * cleanupStoredFile, sweepLegacyDiskFiles, …) so the rest of the codebase
 * stays branch-agnostic. Internally, every `STORAGE_*` command is dispatched
 * to the in-memory ramstore instead of a Web Worker — there is no
 * transfer.worker.ts here, no `navigator.storage.getDirectory()` writes,
 * no disk persistence.
 *
 * Why
 * ───
 * iOS WebKit defers OPFS disk reclaim until app suspension; the previous
 * approach (mxqr_slotpool_archive) tried to mitigate this with a fixed
 * slot pool but `/debug sweep` confirmed the deferred-reclaim mechanism
 * still grew the storage estimate inside a single PWA session. The
 * RAM-only path bypasses disk entirely: encoded chunks live in
 * `Uint8Array[]` per session, blobs are built with `new Blob([…])` on
 * finalize, and reads slice from the cached blob. iOS may still back
 * individual large Blob objects to its private storage, but that
 * allocation is GC-driven (frees with the JS reference) rather than tied
 * to the deferred-reclaim quirk.
 *
 * Memory characteristics
 * ──────────────────────
 *   - Active main blob:    ~5–15 MB typical mp3, up to ~50 MB hi-res
 *   - Preload blobs:       depth × track size (preload depth is 1–2)
 *   - Decoded AudioBuffer: ~80 MB / 4-min song (storage-strategy independent)
 * Foreground footprint typically lands at 100–150 MB — well inside the
 * iOS PWA budget. Long podcasts crash on AudioBuffer decode regardless
 * of storage strategy; that's a hard ceiling neither path can soften.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { TRANSFER_STATE } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { INSTANCE_ID, validateSessionId } from '../core/session.ts';
import type { WorkerCommand, WorkerResponse } from '../types/index.ts';
import { showLoader } from '../ui/toast.ts';
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

// ─── Worker References ──────────────────────────────────────────────
// Only the sync worker is real on RAM-only — it carries the video-sync
// timer. Storage commands stay in-process (see routeStorageCommand below).
//
// (`postWorkerCommand` is named for legacy parity with the slot-pool
// branch's worker wrapper — most STORAGE_* commands no longer hop a worker.)
let _syncWorker: Worker | null = null;

// ─── Worker Timer IDs ───────────────────────────────────────────────
const WORKER_TIMER_IDS = ['video-sync'];

// ─── Instance ID (same as core session) ─────────────────────────────
// INSTANCE_ID used directly (no alias needed)

// ─── Worker Initialization ──────────────────────────────────────────

export function setSyncWorker(worker: Worker): void {
  _syncWorker = worker;
  _syncWorker.onmessage = handleSyncWorkerMessage;
  // onerror is assigned in app.ts after this call; assigning here would be
  // silently overwritten (property assignment, not addEventListener). Keep
  // the single-owner convention in app.ts.
}

// ─── Command Dispatch ───────────────────────────────────────────────

/**
 * Send a command to the appropriate destination.
 * STORAGE_* commands → in-process ramstore (no worker hop).
 * Timer commands → syncWorker (still a real worker).
 */
export function postWorkerCommand(payload: WorkerCommand, transfers?: Transferable[]): void {
  if (!payload || !payload.command) return;

  const cmd = payload.command;

  // Same validation contract as the worker branch — keeps callers
  // consistent across main / mxqr_beta. Critical write-path commands
  // require sessionId; STORAGE_RESET / RESET_SESSION / CLEANUP are exempt
  // from the filename gate.
  if (
    cmd.startsWith('STORAGE_') &&
    cmd !== 'STORAGE_RESET' &&
    cmd !== 'STORAGE_RESET_SESSION' &&
    cmd !== 'STORAGE_CLEANUP'
  ) {
    if (!payload.filename) log.warn(`[Worker] Missing filename in ${cmd}`);

    payload.sessionId = validateSessionId(payload.sessionId ?? 0);

    const isCriticalOp = cmd === 'STORAGE_START' || cmd === 'STORAGE_WRITE' || cmd === 'STORAGE_END';
    if (isCriticalOp && !payload.sessionId) {
      log.error(`[Worker] Blocked ${cmd}: invalid sessionId`, payload);
      return;
    }
  }

  if (cmd === 'STORAGE_RESET_SESSION') {
    payload.sessionId = validateSessionId(payload.sessionId ?? 0);
    if (!payload.sessionId) {
      log.warn(`[Worker] Dropped STORAGE_RESET_SESSION: invalid sessionId`);
      return;
    }
  }

  if (cmd.startsWith('STORAGE_')) {
    routeStorageCommand(payload);
    return;
  }

  if (_syncWorker) {
    _syncWorker.postMessage(payload, transfers || []);
  } else {
    log.warn(`[Worker] SyncWorker not ready. Dropping command: ${cmd}`);
  }
}

// ─── In-Process Bridge ──────────────────────────────────────────────
//
// Runs STORAGE_* commands against the ramstore and synthesizes the same
// response messages a worker would have posted, so the existing
// `handleTransferWorkerMessage` switch (and downstream bus events)
// stay unchanged. We `queueMicrotask` the dispatch to preserve the
// async-postMessage semantics consumers rely on — without it, ack
// callbacks could land before the calling stack frame returns and
// surprise call-chain logic.

function routeStorageCommand(payload: WorkerCommand): void {
  queueMicrotask(() => {
    try {
      runStorageCommand(payload);
    } catch (err) {
      log.error('[Ramstore] command failed:', err);
    }
  });
}

function runStorageCommand(payload: WorkerCommand): void {
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
        dispatchWorkerResponse({ type: 'STORAGE_STARTED', filename, isPreload, sessionId });
      } else {
        dispatchWorkerResponse({
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
        dispatchWorkerResponse({
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
        dispatchWorkerResponse({
          type: 'SESSION_MISMATCH',
          command: 'STORAGE_WRITE',
          expected: result.expectedSid ?? null,
          received: sessionId,
          filename,
          isPreload,
        });
        dispatchWorkerResponse({
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
      const result = ramEnd(filename, isPreload, sessionId, totalSize);
      if (result.blob) {
        dispatchWorkerResponse({ type: 'STORAGE_FILE_READY', filename, isPreload, sessionId });
      } else if (result.reason && result.reason.startsWith('Integrity Fail')) {
        dispatchWorkerResponse({
          type: 'STORAGE_ERROR',
          error: result.reason,
          filename,
          isPreload,
          code: 'INTEGRITY_FAIL',
        });
      } else if (result.reason === 'Session mismatch') {
        dispatchWorkerResponse({
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
      dispatchWorkerResponse({ type: 'STORAGE_RESET_COMPLETE', isPreload });
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
      dispatchWorkerResponse({
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
            dispatchWorkerResponse({
              type: 'STORAGE_READ_COMPLETE',
              chunk,
              index,
              filename,
              requestId,
              sessionId,
            });
          } else {
            dispatchWorkerResponse({
              type: 'STORAGE_READ_ERROR',
              error: 'Slot not found',
              filename,
              index,
              requestId,
            });
          }
        })
        .catch((e) => {
          dispatchWorkerResponse({
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
 * Synthesize the MessageEvent shape that `handleTransferWorkerMessage`
 * expects, so all the existing bus.emit / state mutation logic in that
 * switch keeps running unchanged.
 */
function dispatchWorkerResponse(response: WorkerResponse): void {
  handleTransferWorkerMessage({
    data: response,
  } as MessageEvent<WorkerResponse>);
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

  postWorkerCommand({
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

// ─── OPFS Sweep ─────────────────────────────────────────────────────
//
// Walks the OPFS root and removes any `preload_*` / `current_*` files.
// On the RAM-only branch we never *create* OPFS entries, so this exists
// purely as a one-shot legacy migration helper:
//
//   1. Cleans up files left behind from a prior app load that ran the
//      OPFS-based code (slot pool layout `preload_slot_<i>_<INSTANCE>`
//      or the older per-filename `preload_<safe>_<oldInstance>`).
//   2. Frees the disk space those files were holding (subject to iOS
//      WebKit's deferred reclaim — `removeEntry` returns immediately
//      but pages may stay until the app suspends).
//
// Two call sites:
//   - App startup: excludeCurrentInstance=true. Defensive — the RAM
//     branch shouldn't have files matching the current INSTANCE_ID at
//     startup, but we keep the filter to avoid a regression if something
//     downstream ever creates one before the sweep runs.
//   - Session leave: excludeCurrentInstance=false. Drops everything,
//     including any legacy current-instance files.
//
// Fire-and-forget; do not await. Performance scales with surviving disk
// debris and is bounded by the iOS quota.
export async function sweepLegacyDiskFiles(opts: {
  excludeCurrentInstance?: boolean;
  reason: string;
}): Promise<void> {
  if (!navigator.storage?.getDirectory) return;
  let root: FileSystemDirectoryHandle;
  try {
    root = await navigator.storage.getDirectory();
  } catch (e) {
    log.warn(`[OPFS] Sweep ${opts.reason}: getDirectory failed:`, e);
    return;
  }
  const toRemove: { name: string; size: number }[] = [];
  try {
    const dir = root as unknown as {
      values(): AsyncIterable<{
        kind: string;
        name: string;
        getFile?: () => Promise<{ size: number }>;
      }>;
    };
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file') continue;
      const name = entry.name;
      if (!name.startsWith('preload_') && !name.startsWith('current_')) continue;
      if (opts.excludeCurrentInstance && name.endsWith(`_${INSTANCE_ID}`)) continue;
      let size = 0;
      try {
        if (entry.getFile) {
          const f = await entry.getFile();
          size = f.size;
        }
      } catch {
        /* ignore — size is for stats only */
      }
      toRemove.push({ name, size });
    }
  } catch (e) {
    log.warn(`[OPFS] Sweep ${opts.reason}: enumeration failed:`, e);
    return;
  }
  if (toRemove.length === 0) {
    log.debug(`[OPFS] Sweep ${opts.reason}: nothing to remove`);
    return;
  }
  const totalMB = toRemove.reduce((s, e) => s + e.size, 0) / 1048576;
  log.info(
    `[OPFS] Sweep ${opts.reason}: removing ${toRemove.length} files (~${totalMB.toFixed(1)}MB)`,
  );
  let removed = 0;
  for (const entry of toRemove) {
    try {
      await root.removeEntry(entry.name);
      removed++;
    } catch (e) {
      log.warn(`[OPFS] Sweep ${opts.reason}: removeEntry(${entry.name}) failed:`, e);
    }
  }
  log.info(
    `[OPFS] Sweep ${opts.reason}: ${removed}/${toRemove.length} files removed`,
  );
}

// ─── Stop Background Worker Timers ──────────────────────────────────

export function stopBackgroundWorkerTimers(): void {
  WORKER_TIMER_IDS.forEach((id) => {
    try {
      postWorkerCommand({ command: 'STOP_TIMER', id });
    } catch {
      /* noop */
    }
  });
}

// ─── Worker Message Handlers ────────────────────────────────────────

function handleTransferWorkerMessage(e: MessageEvent<WorkerResponse>): void {
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
              setState('transfer.state', TRANSFER_STATE.IDLE);
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
              setState('transfer.state', TRANSFER_STATE.IDLE);
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

// ─── Bus Event Handlers ─────────────────────────────────────────

/** Forward sync commands from bus to the sync worker */
bus.on('worker:sync-command', (payload: { command: string; id: string; interval?: number }) => {
  if (payload && payload.command) {
    postWorkerCommand(payload);
  }
});
