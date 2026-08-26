/**
 * MUSIXQUARE — RAM-only storage adapter
 *
 * Routes STORAGE_* commands to the in-memory ramstore. Encoded chunks
 * live in `Map<number, Uint8Array>` per session, blobs are built with `new Blob([…])`
 * on finalize, and reads slice from the cached blob. There is no worker
 * hop, no `navigator.storage.getDirectory()` writes, no disk persistence.
 *
 * Memory scales with the encoded active/preload blobs and the decoded PCM
 * retained by playback. There is no persistent fallback. Callers own cleanup;
 * playback records memory ownership but does not pre-reject a valid
 * file from a predicted device-memory ceiling.
 * Policy source (repository path, not a runtime URL):
 * docs/design/browser-media-storage-policy.md
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { CHUNK_SIZE, TRANSFER_STATE } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { INSTANCE_ID, validateSessionId } from '../core/session.ts';
import type { StorageCommand, StorageEvent } from '../types/index.ts';
import { showLoader } from '../ui/toast.ts';
import { setPlaybackTransferState } from '../player/ownership.ts';
import {
  bindEncodedReceiveReservationToBlob,
  reserveEncodedReceiveMemoryWithinBudget,
  type EncodedReceiveMemoryReservation,
} from '../player/decode-admission.ts';
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

interface StoredFileAdmission {
  queueItemId: string;
  filename: string;
  isPreload: boolean;
  sessionId: number;
  readonly totalSize: number;
  readonly reservation: EncodedReceiveMemoryReservation;
  readonly source: 'ram' | 'external';
  owner: 'storage' | 'preload-cache' | 'current';
  phase: 'assembling' | 'finalized' | 'resident';
  residentBlob?: Blob;
}

const storedFileAdmissions = new Map<string, StoredFileAdmission>();

function storedAdmissionKey(isPreload: boolean, sessionId: number): string {
  return `${isPreload ? 'p' : 'm'}:${sessionId}`;
}

function releaseStoredAdmissions(predicate: (entry: StoredFileAdmission) => boolean): void {
  for (const [key, entry] of storedFileAdmissions) {
    if (!predicate(entry)) continue;
    entry.reservation.release();
    storedFileAdmissions.delete(key);
  }
}

function isResidentAdmissionReferenced(entry: StoredFileAdmission): boolean {
  if (!entry.residentBlob || entry.owner === 'storage') return false;
  const preload = getState('preload.ready');
  const current = getState('files.current');
  const preloadReferenced =
    preload?.blob === entry.residentBlob &&
    preload.queueItemId === entry.queueItemId &&
    preload.sessionId === entry.sessionId;
  const currentReferenced =
    current?.blob === entry.residentBlob &&
    current.queueItemId === entry.queueItemId &&
    current.sessionId === entry.sessionId;
  return preloadReferenced || currentReferenced;
}

function releaseUnreferencedResidentAdmissions(): void {
  releaseStoredAdmissions(
    (entry) => entry.owner !== 'storage' && !isResidentAdmissionReferenced(entry),
  );
}

let residentPruneQueued = false;
function scheduleResidentAdmissionPrune(): void {
  if (residentPruneQueued) return;
  residentPruneQueued = true;
  queueMicrotask(() => {
    residentPruneQueued = false;
    releaseUnreferencedResidentAdmissions();
  });
}

// Blob references are the final ownership boundary. Deferring one microtask
// lets callers publish metadata and Blob in either order without exposing a
// transient gap, then releases any resident lease whose exact object vanished.
bus.on('state:preload.ready', scheduleResidentAdmissionPrune);
bus.on('state:files.current', scheduleResidentAdmissionPrune);

/**
 * Reserve the two-copy RAM assembly peak before a P2P receive accepts bytes.
 * Replacements are checked atomically while the superseded lease is excluded,
 * then the old storage ownership is released only after the new lease succeeds.
 */
export function admitIncomingStoredFile(options: {
  queueItemId: string;
  filename: string;
  isPreload: boolean;
  sessionId: number;
  totalSize: number;
  retainedPcmBytes?: number;
}): void {
  const { queueItemId, filename, isPreload, sessionId, totalSize, retainedPcmBytes = 0 } = options;
  if (
    !queueItemId ||
    !filename ||
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    !Number.isSafeInteger(totalSize) ||
    totalSize <= 0
  ) {
    throw new Error('INVALID_INCOMING_FILE_ADMISSION');
  }

  const exactKey = storedAdmissionKey(isPreload, sessionId);
  const exact = storedFileAdmissions.get(exactKey);
  if (exact) {
    if (
      exact.queueItemId !== queueItemId ||
      exact.filename !== filename ||
      exact.totalSize !== totalSize
    ) {
      throw new Error('INCOMING_FILE_IDENTITY_MISMATCH');
    }
    if (exact.phase === 'assembling') return;
  }

  const replaced = [...storedFileAdmissions.values()].filter((entry) => {
    if (entry.isPreload !== isPreload) return false;
    if (entry === exact) return true;
    if (!isPreload) return entry.owner === 'storage' || !isResidentAdmissionReferenced(entry);
    return (
      entry.sessionId === sessionId ||
      entry.queueItemId === queueItemId ||
      (entry.owner !== 'storage' && !isResidentAdmissionReferenced(entry))
    );
  });
  const reservation = reserveEncodedReceiveMemoryWithinBudget(totalSize, {
    fileName: filename,
    retainedPcmBytes,
    excludeReservationIds: replaced.map((entry) => entry.reservation.id),
  });

  for (const entry of replaced) {
    entry.reservation.release();
    storedFileAdmissions.delete(storedAdmissionKey(entry.isPreload, entry.sessionId));
  }
  storedFileAdmissions.set(exactKey, {
    queueItemId,
    filename,
    isPreload,
    sessionId,
    totalSize,
    reservation,
    source: 'ram',
    owner: 'storage',
    phase: 'assembling',
  });
}

/** @internal Test-only reset for the storage-owned receive lease registry. */
export function resetStoredFileAdmissionsForTests(): void {
  releaseStoredAdmissions(() => true);
}

/** @internal Test-only registry snapshot. */
export function storedFileAdmissionStatsForTests(): Array<{
  queueItemId: string;
  filename: string;
  isPreload: boolean;
  sessionId: number;
  owner: StoredFileAdmission['owner'];
  phase: StoredFileAdmission['phase'];
  source: StoredFileAdmission['source'];
}> {
  return [...storedFileAdmissions.values()].map((entry) => ({
    queueItemId: entry.queueItemId,
    filename: entry.filename,
    isPreload: entry.isPreload,
    sessionId: entry.sessionId,
    owner: entry.owner,
    phase: entry.phase,
    source: entry.source,
  }));
}

/**
 * Mark a finalized RAM file as retained by an application Blob reference.
 * Ordinary physical-slot resets keep this lease until the exact Blob leaves
 * preload/current state; explicit cleanup and room teardown still release it.
 */
export function retainStoredFileAdmission(
  queueItemId: string,
  filename: string,
  isPreload: boolean,
  sessionId: number,
  blob: Blob,
): boolean {
  const entry = storedFileAdmissions.get(storedAdmissionKey(isPreload, sessionId));
  if (
    !entry ||
    entry.queueItemId !== queueItemId ||
    entry.filename !== filename ||
    entry.totalSize !== blob.size
  )
    return false;
  entry.owner = isPreload ? 'preload-cache' : 'current';
  entry.phase = 'resident';
  entry.residentBlob = blob;
  bindEncodedReceiveReservationToBlob(blob, entry.reservation.id);
  return true;
}

/** Adopt the retained lease produced by a remote transport handoff. */
export function adoptExternalStoredFileAdmission(options: {
  queueItemId: string;
  filename: string;
  isPreload: boolean;
  sessionId: number;
  blob: Blob;
  reservation: EncodedReceiveMemoryReservation;
}): void {
  const { queueItemId, filename, isPreload, sessionId, blob, reservation } = options;
  if (
    !queueItemId ||
    !filename ||
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    !Number.isSafeInteger(blob.size) ||
    blob.size <= 0
  ) {
    reservation.release();
    throw new Error('INVALID_EXTERNAL_FILE_ADMISSION');
  }

  releaseUnreferencedResidentAdmissions();
  const key = storedAdmissionKey(isPreload, sessionId);
  const collision = storedFileAdmissions.get(key);
  if (collision) {
    reservation.release();
    if (
      collision.residentBlob === blob &&
      collision.queueItemId === queueItemId &&
      collision.filename === filename
    )
      return;
    throw new Error('EXTERNAL_FILE_IDENTITY_MISMATCH');
  }

  bindEncodedReceiveReservationToBlob(blob, reservation.id);
  storedFileAdmissions.set(key, {
    queueItemId,
    filename,
    isPreload,
    sessionId,
    totalSize: blob.size,
    reservation,
    source: 'external',
    owner: isPreload ? 'preload-cache' : 'current',
    phase: 'resident',
    residentBlob: blob,
  });
}

/** Re-key a resident object when a newer descriptor reuses exact Blob identity. */
export function rebindResidentStoredFileAdmission(options: {
  blob: Blob;
  queueItemId: string;
  filename: string;
  isPreload: boolean;
  sessionId: number;
}): boolean {
  const { blob, queueItemId, filename, isPreload, sessionId } = options;
  const found = [...storedFileAdmissions.entries()].find(
    ([, entry]) => entry.residentBlob === blob && entry.owner !== 'storage',
  );
  if (!found || !queueItemId || !Number.isSafeInteger(sessionId) || sessionId <= 0 || !filename)
    return false;
  const [oldKey, entry] = found;
  const newKey = storedAdmissionKey(isPreload, sessionId);
  const collision = storedFileAdmissions.get(newKey);
  if (collision && collision !== entry) {
    if (isResidentAdmissionReferenced(collision)) return false;
    collision.reservation.release();
    storedFileAdmissions.delete(newKey);
  }
  storedFileAdmissions.delete(oldKey);
  entry.queueItemId = queueItemId;
  entry.filename = filename;
  entry.isPreload = isPreload;
  entry.sessionId = sessionId;
  entry.owner = isPreload ? 'preload-cache' : 'current';
  entry.phase = 'resident';
  storedFileAdmissions.set(newKey, entry);
  return true;
}

/** Move one exact retained preload lease to current-file ownership. */
export function promoteStoredFileAdmission(
  queueItemId: string,
  filename: string,
  sessionId: number,
  blob: Blob,
): boolean {
  const preloadKey = storedAdmissionKey(true, sessionId);
  const entry = storedFileAdmissions.get(preloadKey);
  if (
    !entry ||
    entry.queueItemId !== queueItemId ||
    entry.filename !== filename ||
    entry.owner !== 'preload-cache' ||
    entry.residentBlob !== blob
  ) {
    return false;
  }

  // Promotion replaces the single main channel. Release every prior main
  // registry owner before dropping its physical slot so no stale lease remains.
  releaseStoredAdmissions((candidate) => !candidate.isPreload);
  const mainKey = storedAdmissionKey(false, sessionId);

  // The File object owns the encoded bytes from this point. Physical slots
  // can be dropped without releasing the moved ledger entry.
  ramReset(false);
  if (entry.source === 'ram') ramResetSession(sessionId, true);
  storedFileAdmissions.delete(preloadKey);
  entry.isPreload = false;
  entry.owner = 'current';
  entry.phase = 'resident';
  storedFileAdmissions.set(mainKey, entry);
  return true;
}

/** Release the exact resident Blob and any RAM slot it originated from. */
export function discardResidentStoredFileAdmission(blob: Blob): boolean {
  const found = [...storedFileAdmissions.entries()].find(
    ([, entry]) => entry.residentBlob === blob && entry.owner !== 'storage',
  );
  if (!found) return false;
  const [key, entry] = found;
  entry.reservation.release();
  storedFileAdmissions.delete(key);
  if (entry.source === 'ram') ramResetSession(entry.sessionId, entry.isPreload);
  return true;
}

/** Room teardown is stronger than ordinary slot reset: no Blob may survive. */
export function resetAllStoredFiles(): void {
  releaseStoredAdmissions(() => true);
  ramReset(false);
  ramReset(true);
}

// ─── Instance ID (same as core session) ─────────────────────────────

// ─── Command Dispatch ───────────────────────────────────────────────

/**
 * Validate, normalise, and dispatch a storage command. Storage commands
 * never hop a worker on RAM-only — they're routed in-process to ramstore.
 * Timer/worker commands live in network/sync-worker.ts.
 */
export function postCommand(payload: StorageCommand): void {
  if (!payload || !payload.command) return;

  const cmd = payload.command;

  if (cmd !== 'STORAGE_RESET' && cmd !== 'STORAGE_RESET_SESSION' && cmd !== 'STORAGE_CLEANUP') {
    if (!payload.filename) log.warn(`[Storage] Missing filename in ${cmd}`);
    if (!payload.queueItemId) log.warn(`[Storage] Missing queueItemId in ${cmd}`);

    payload.sessionId = validateSessionId(payload.sessionId ?? 0);

    const isCriticalOp =
      cmd === 'STORAGE_START' || cmd === 'STORAGE_WRITE' || cmd === 'STORAGE_END';
    if (isCriticalOp && !payload.sessionId) {
      log.error(`[Storage] Blocked ${cmd}: invalid sessionId`, payload);
      return;
    }
    if (isCriticalOp && !payload.queueItemId) {
      log.error(`[Storage] Blocked ${cmd}: invalid queueItemId`, payload);
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

  if (cmd === 'STORAGE_CLEANUP' && !payload.queueItemId) {
    log.warn('[Storage] Dropped STORAGE_CLEANUP: invalid queueItemId');
    return;
  }

  if (cmd === 'STORAGE_RESET') {
    // A replacement may reserve its session before the queued RAM reset runs.
    // Preserve only that explicitly tagged lease; ordinary teardown omits it.
    const preserveSessionId =
      Number.isSafeInteger(payload.sessionId) && (payload.sessionId as number) > 0
        ? (payload.sessionId as number)
        : undefined;
    releaseStoredAdmissions(
      (entry) =>
        entry.isPreload === !!payload.isPreload &&
        entry.sessionId !== preserveSessionId &&
        !isResidentAdmissionReferenced(entry),
    );
  } else if (cmd === 'STORAGE_RESET_SESSION') {
    releaseStoredAdmissions(
      (entry) =>
        entry.isPreload &&
        entry.sessionId === (payload.sessionId as number) &&
        !isResidentAdmissionReferenced(entry),
    );
  } else if (cmd === 'STORAGE_CLEANUP' && payload.queueItemId) {
    releaseStoredAdmissions(
      (entry) =>
        entry.isPreload === !!payload.isPreload &&
        entry.queueItemId === payload.queueItemId &&
        (payload.sessionId === undefined || entry.sessionId === payload.sessionId),
    );
  }

  routeStorageCommand(payload);
}

// ─── In-Process Bridge ──────────────────────────────────────────────
//
// Runs STORAGE_* commands against ramstore and emits the established
// StorageEvent contract. queueMicrotask preserves asynchronous acknowledgement
// ordering for callers.

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
  const queueItemId = (payload.queueItemId as string) || '';
  const isPreload = !!payload.isPreload;
  const sessionId = (payload.sessionId as number) || 0;

  switch (cmd) {
    case 'STORAGE_START': {
      const chunkSize = (payload.size as number) || CHUNK_SIZE;
      const keepExisting = !!payload.keepExisting;
      const mime = typeof payload.mime === 'string' ? payload.mime : '';
      const result = ramStart(
        queueItemId,
        filename,
        isPreload,
        sessionId,
        chunkSize,
        keepExisting,
        mime,
      );
      if (result.ok) {
        dispatchStorageEvent({
          type: 'STORAGE_STARTED',
          filename,
          queueItemId,
          isPreload,
          sessionId,
        });
      } else {
        releaseStoredAdmissions(
          (entry) => entry.isPreload === isPreload && entry.sessionId === sessionId,
        );
        dispatchStorageEvent({
          type: 'STORAGE_ERROR',
          error: result.reason || 'start failed',
          filename,
          queueItemId,
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
          queueItemId,
          chunkIndex: payload.chunkIndex as number | undefined,
          isPreload,
          sessionId,
        });
        return;
      }
      const chunkIndex = payload.chunkIndex as number;
      const result = ramWrite(queueItemId, filename, isPreload, sessionId, chunkIndex, chunk);
      if (
        !result.ok &&
        (result.reason === 'Session mismatch' || result.reason === 'Queue item mismatch')
      ) {
        dispatchStorageEvent({
          type: 'SESSION_MISMATCH',
          command: 'STORAGE_WRITE',
          expected: result.expectedSid ?? null,
          received: sessionId,
          filename,
          queueItemId,
          isPreload,
        });
        dispatchStorageEvent({
          type: 'STORAGE_WRITE_ERROR',
          error: result.reason,
          filename,
          queueItemId,
          chunkIndex,
          isPreload,
          sessionId,
          code: result.reason === 'Session mismatch' ? 'SESSION_MISMATCH' : 'IDENTITY_MISMATCH',
        });
      }
      // Other write failures are intentionally silent; their sessions are no
      // longer writable and recovery owns any follow-up.
      return;
    }

    case 'STORAGE_END': {
      const totalSize = payload.totalSize as number | undefined;
      const expectedChunks = payload.total as number | undefined;
      const result = ramEnd(queueItemId, filename, isPreload, sessionId, totalSize, expectedChunks);
      if (result.blob) {
        const admission = storedFileAdmissions.get(storedAdmissionKey(isPreload, sessionId));
        if (admission) {
          admission.reservation.markFinalized();
          admission.phase = 'finalized';
          bindEncodedReceiveReservationToBlob(result.blob, admission.reservation.id);
        }
        dispatchStorageEvent({
          type: 'STORAGE_FILE_READY',
          filename,
          queueItemId,
          isPreload,
          sessionId,
        });
      } else if (result.reason && result.reason.startsWith('Integrity Fail')) {
        dispatchStorageEvent({
          type: 'STORAGE_ERROR',
          error: result.reason,
          filename,
          queueItemId,
          isPreload,
          code: 'INTEGRITY_FAIL',
        });
      } else if (result.reason === 'Session mismatch' || result.reason === 'Queue item mismatch') {
        dispatchStorageEvent({
          type: 'SESSION_MISMATCH',
          command: 'STORAGE_END',
          expected: result.expectedSid ?? null,
          received: sessionId,
          filename,
          queueItemId,
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
      // Per-session cleanup targets preload slots; the main slot is reset as a
      // whole by STORAGE_RESET.
      ramResetSession(sessionId, true);
      // Per-session reset has no response event by contract.
      return;
    }

    case 'STORAGE_CLEANUP': {
      const result = ramCleanup(queueItemId, isPreload, payload.sessionId);
      dispatchStorageEvent({
        type: 'STORAGE_CLEANUP_COMPLETE',
        filename,
        queueItemId,
        isPreload,
        sessionId: payload.sessionId,
        skipped: result.skipped,
      });
      return;
    }

    case 'STORAGE_READ': {
      const chunkIndex = payload.chunkIndex as number;
      const requestId = payload.requestId;
      // ramReadChunk is async (slices a Blob → ArrayBuffer). Don't block
      // the calling microtask; resolve and dispatch when ready.
      ramReadChunk(queueItemId, isPreload, sessionId, chunkIndex)
        .then((chunk) => {
          if (chunk) {
            dispatchStorageEvent({
              type: 'STORAGE_READ_COMPLETE',
              chunk,
              chunkIndex,
              filename,
              queueItemId,
              requestId,
              sessionId,
            });
          } else {
            dispatchStorageEvent({
              type: 'STORAGE_READ_ERROR',
              error: 'Slot not found',
              filename,
              queueItemId,
              chunkIndex,
              requestId,
            });
          }
        })
        .catch((e) => {
          dispatchStorageEvent({
            type: 'STORAGE_READ_ERROR',
            error: (e as Error)?.message ?? String(e),
            filename,
            queueItemId,
            chunkIndex,
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
 * Wrap a StorageEvent in the MessageEvent-shaped internal dispatch contract.
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
export function cleanupStoredFile(
  queueItemId: string,
  filename: string,
  isPreload: boolean,
  sessionId?: number,
): void {
  if (!queueItemId || !filename) return;

  const watchdogName = `cleanup-watchdog-${isPreload ? 'p' : 'c'}-${queueItemId}-${sessionId ?? 'all'}`;

  setManagedTimer(
    watchdogName,
    () => {
      log.warn(`[Storage] Cleanup watchdog: no response for "${filename}" after 10s. Moving on`);
      unsub();
    },
    10_000,
  );

  const unsub = bus.on(
    'storage:cleanup-complete',
    (cleanedQueueItemId: unknown, cleanedSessionId: unknown) => {
      if (
        cleanedQueueItemId === queueItemId &&
        (sessionId === undefined || cleanedSessionId === sessionId)
      ) {
        clearManagedTimer(watchdogName);
        unsub();
      }
    },
  );

  postCommand({
    command: 'STORAGE_CLEANUP',
    queueItemId,
    filename,
    isPreload,
    sessionId,
    instanceId: INSTANCE_ID,
  });
}

/**
 * Read a finalized file from the ramstore. Wrap it as a `File` so callers can
 * rely on the storage API's named-file return contract.
 */
export async function readStoredFile(
  queueItemId: string,
  filename: string,
  isPreload: boolean,
  sessionId: number,
): Promise<File | null> {
  if (!queueItemId || !filename || !Number.isSafeInteger(sessionId) || sessionId <= 0) return null;
  const blob = ramReadBlob(queueItemId, isPreload, sessionId);
  if (!blob) return null;
  try {
    const file = new File([blob], filename, { type: blob.type });
    const admission = storedFileAdmissions.get(storedAdmissionKey(isPreload, sessionId));
    if (admission?.queueItemId === queueItemId) {
      bindEncodedReceiveReservationToBlob(file, admission.reservation.id);
    }
    return file;
  } catch (err) {
    log.error('[Ramstore] readStoredFile wrap failed:', err);
    return null;
  }
}

// ─── Storage Event Handlers ────────────────────────────────────────

function handleStorageResponse(e: MessageEvent<StorageEvent>): void {
  const data = e.data;
  if (!data || !data.type) return;

  // Keep one malformed response from breaking later storage event handling.
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
          data.queueItemId || '',
        );
        break;

      case 'STORAGE_READ_COMPLETE':
        // Reads resolve through readStoredFile; this event needs no bus fanout.
        break;

      case 'STORAGE_WRITE_ERROR':
        log.warn(
          `[Storage] Write error for ${data.filename} chunk ${data.chunkIndex}:`,
          data.error,
        );
        // Notify transfer module so it can trigger recovery instead of silently
        // continuing with a corrupted file (missing chunk data).
        bus.emit('storage:write-error', data);
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
            log.warn('[Storage] Integrity fail. Requesting recovery');
            bus.emit('storage:request-recovery');
          } else if (data.code === 'START_FAILED' || data.code === 'LOCKED') {
            // Lock acquisition failed — reset transfer state to prevent stuck loader.
            // Check both RECEIVING and PROCESSING: with fast transfers, main thread
            // may detect completion (PROCESSING) before storage reports START_FAILED.
            const transferState = getState('transfer.state');
            if (
              transferState === TRANSFER_STATE.RECEIVING ||
              transferState === TRANSFER_STATE.PROCESSING
            ) {
              log.warn(`[Storage] Start/lock failed. Resetting stuck ${transferState} state`);
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

          // A rejected STORAGE_END leaves the RAM slot unfinalized. Return to
          // IDLE rather than advertising an unplayable file as READY.
          if (data.command === 'STORAGE_END') {
            const transferState = getState('transfer.state');
            if (transferState === TRANSFER_STATE.PROCESSING) {
              log.warn('[Storage] STORAGE_END dropped. Resetting stuck PROCESSING state');
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
          // The slot is still in use. The fire-and-forget caller has moved on,
          // so retain it and report the skipped cleanup.
          log.warn(`[Storage] Cleanup skipped (file still locked): ${data.filename}`);
        } else {
          log.debug(`[Storage] Cleanup complete: ${data.filename}`);
        }
        bus.emit(
          'storage:cleanup-complete',
          data.queueItemId || '',
          data.sessionId,
          data.filename || '',
        );
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
