/**
 * MUSIXQUARE — RAM-only chunk store (mxqr_beta branch)
 *
 * Drop-in replacement for the OPFS worker on the slot-pool main branch.
 * Keeps the same logical contract — sessions accumulate chunks until
 * OPFS_END, after which a Blob is available for read — but never
 * touches `navigator.storage` and never spawns a worker.
 *
 * Why this exists
 * ───────────────
 * iOS WebKit's OPFS doesn't reclaim disk pages on `removeEntry()` until
 * the app suspends; main branch fixed the on-disk *count* by switching
 * to a fixed slot pool, but `/debug sweep` showed deleted-but-retained
 * pages still grew the storage estimate. mxqr_beta sidesteps the iOS
 * quirk entirely: encoded blobs live in RAM, decoded AudioBuffers live
 * in RAM (as before), there is no disk path. iOS may still back large
 * Blob objects to its own internal storage but that allocation is GC-
 * driven and tied to the JS reference's lifetime — not stuck behind the
 * OPFS deferred-reclaim quirk.
 *
 * Memory ceiling
 * ──────────────
 * Bounded by the active set of held blobs:
 *   - One main-channel blob (~5–15 MB for typical mp3, up to ~50 MB for hi-res)
 *   - Up to a handful of preload blobs (preload depth × track size)
 *   - Plus the decoded AudioBuffer for the playing track (~80 MB / 4-min song)
 * Typical foreground footprint lands around 100–150 MB, well inside the
 * iOS PWA budget (~600 MB+). Long podcasts crash on AudioBuffer decode
 * regardless of storage strategy — that's a hard ceiling neither path
 * can soften.
 */

import { log } from '../core/log.ts';

// ─── Types ──────────────────────────────────────────────────────

interface RamSlot {
  filename: string;
  isPreload: boolean;
  sessionId: number;
  /** Chunks indexed by chunk index. Out-of-order arrival is normal here. */
  chunks: Map<number, Uint8Array>;
  /** Set on the first OPFS_START, used to compute byte offsets for reads. */
  chunkSize: number;
  /** Set on OPFS_END; null while writing. */
  totalSize: number | null;
  /** True after OPFS_END has produced a finalizedBlob. */
  finalized: boolean;
  /**
   * Concatenated final blob. Created lazily by ramEnd; reused on read.
   * Chunks are dropped after this is set so we don't double-account.
   */
  finalizedBlob: Blob | null;
}

// ─── State ──────────────────────────────────────────────────────

/** Single main slot — at most one main-channel transfer in flight. */
let mainSlot: RamSlot | null = null;
/** Preload slots keyed by both sessionId (write path) and filename (read path). */
const preloadBySid = new Map<number, RamSlot>();
const preloadByName = new Map<string, RamSlot>();

function makeSlot(
  filename: string,
  isPreload: boolean,
  sessionId: number,
  chunkSize: number,
): RamSlot {
  return {
    filename,
    isPreload,
    sessionId,
    chunks: new Map(),
    chunkSize,
    totalSize: null,
    finalized: false,
    finalizedBlob: null,
  };
}

// ─── Write Path ─────────────────────────────────────────────────

export function ramStart(
  filename: string,
  isPreload: boolean,
  sessionId: number,
  chunkSize: number,
  keepExisting: boolean,
): { ok: boolean; reason?: string } {
  if (!filename) return { ok: false, reason: 'Missing filename' };
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return { ok: false, reason: 'Invalid sessionId' };
  }

  if (!isPreload) {
    // If keepExisting + same filename + same session → resume.
    if (keepExisting && mainSlot && mainSlot.filename === filename && mainSlot.sessionId === sessionId) {
      return { ok: true };
    }
    mainSlot = makeSlot(filename, isPreload, sessionId, chunkSize);
    return { ok: true };
  }

  // Preload — reuse existing slot if filename + session match (resume).
  const existing = preloadBySid.get(sessionId);
  if (existing && existing.filename === filename && keepExisting) {
    return { ok: true };
  }

  // If a different session held this filename, drop it.
  const stale = preloadByName.get(filename);
  if (stale && stale.sessionId !== sessionId) {
    preloadBySid.delete(stale.sessionId);
    preloadByName.delete(filename);
  }

  // Drop any prior slot under this sessionId (rare retry path).
  if (existing && existing.filename !== filename) {
    preloadByName.delete(existing.filename);
    preloadBySid.delete(sessionId);
  }

  const slot = makeSlot(filename, isPreload, sessionId, chunkSize);
  preloadBySid.set(sessionId, slot);
  preloadByName.set(filename, slot);
  return { ok: true };
}

export function ramWrite(
  filename: string,
  isPreload: boolean,
  sessionId: number,
  chunkIndex: number,
  chunk: Uint8Array,
): { ok: boolean; reason?: string; expectedSid?: number | null } {
  const slot = isPreload ? preloadBySid.get(sessionId) : mainSlot;
  if (!slot) return { ok: false, reason: 'Session not found', expectedSid: null };
  if (slot.sessionId !== sessionId) {
    return { ok: false, reason: 'Session mismatch', expectedSid: slot.sessionId };
  }
  if (slot.filename !== filename) {
    // Caller's session matches but filename diverged — likely a stale write
    // from a different transfer. Drop without ack.
    return { ok: false, reason: 'Filename mismatch' };
  }
  if (slot.finalized) {
    return { ok: false, reason: 'Already finalized' };
  }
  slot.chunks.set(chunkIndex, chunk);
  return { ok: true };
}

/**
 * Finalize a slot. Concatenates accumulated chunks in index order, applies
 * the optional totalSize cap (truncate if we wrote a tail beyond the
 * declared total), caches the resulting Blob, and frees the chunk map.
 * Returns null if the slot can't be found or session mismatches.
 */
export function ramEnd(
  filename: string,
  isPreload: boolean,
  sessionId: number,
  totalSize?: number,
): { blob: Blob | null; reason?: string; expectedSid?: number | null } {
  const slot = isPreload ? preloadBySid.get(sessionId) : mainSlot;
  if (!slot) return { blob: null, reason: 'Session not found', expectedSid: null };
  if (slot.sessionId !== sessionId) {
    return { blob: null, reason: 'Session mismatch', expectedSid: slot.sessionId };
  }
  if (slot.filename !== filename) {
    return { blob: null, reason: 'Filename mismatch' };
  }

  const sortedKeys = Array.from(slot.chunks.keys()).sort((a, b) => a - b);
  // BlobPart's strict type rejects `Uint8Array<ArrayBufferLike>` (the
  // generic introduced when SharedArrayBuffer is part of the union); we
  // cast through unknown so the strict check passes without changing
  // runtime behaviour — Blob constructor handles ArrayBufferView fine.
  const parts: BlobPart[] = [];
  for (const k of sortedKeys) {
    parts.push(slot.chunks.get(k)! as unknown as BlobPart);
  }
  let blob = new Blob(parts);

  // Tail-trim: in recovery scenarios the last chunk may overshoot when
  // host re-sends after partial receive. Match the worker's contract.
  if (typeof totalSize === 'number' && totalSize > 0 && blob.size > totalSize) {
    blob = blob.slice(0, totalSize);
  }
  if (typeof totalSize === 'number' && totalSize > 0 && blob.size < totalSize) {
    return {
      blob: null,
      reason: `Integrity Fail: ${blob.size}/${totalSize}`,
    };
  }

  slot.finalizedBlob = blob;
  slot.finalized = true;
  slot.totalSize = blob.size;
  // Drop chunk map — reads come from finalizedBlob. Keeps memory honest:
  // the same bytes shouldn't sit in both `chunks` and `finalizedBlob`.
  slot.chunks.clear();

  return { blob };
}

// ─── Read Path ──────────────────────────────────────────────────

/**
 * Read a chunk from the slot. Mirrors the worker's OPFS_READ contract:
 * caller passes chunk index, we slice from the finalized blob (or live
 * chunks if not yet finalized).
 */
export async function ramReadChunk(
  filename: string,
  isPreload: boolean,
  sessionId: number | undefined,
  chunkIndex: number,
): Promise<Uint8Array | null> {
  const slot = findSlotForRead(filename, isPreload, sessionId);
  if (!slot) return null;

  if (slot.finalizedBlob) {
    const offset = chunkIndex * slot.chunkSize;
    const slice = slot.finalizedBlob.slice(offset, offset + slot.chunkSize);
    const buf = await slice.arrayBuffer();
    return new Uint8Array(buf);
  }

  // Live read — return the chunk if we have it.
  const live = slot.chunks.get(chunkIndex);
  return live ? live : null;
}

/**
 * Return the finalized blob for a logical filename. Used by
 * `readStoredFile` callers (decode promote / preload promote paths).
 */
export function ramReadBlob(filename: string, isPreload: boolean): Blob | null {
  const slot = findSlotForRead(filename, isPreload);
  return slot?.finalizedBlob ?? null;
}

function findSlotForRead(
  filename: string,
  isPreload: boolean,
  sessionId?: number,
): RamSlot | null {
  if (!isPreload) {
    if (mainSlot && mainSlot.filename === filename) return mainSlot;
    return null;
  }
  if (typeof sessionId === 'number') {
    const bySid = preloadBySid.get(sessionId);
    if (bySid && bySid.filename === filename) return bySid;
  }
  return preloadByName.get(filename) ?? null;
}

// ─── Reset / Cleanup ────────────────────────────────────────────

export function ramCleanup(filename: string, isPreload: boolean): { skipped: boolean } {
  if (!isPreload) {
    if (mainSlot && mainSlot.filename === filename) {
      mainSlot = null;
    }
    return { skipped: false };
  }
  const slot = preloadByName.get(filename);
  if (slot) {
    preloadByName.delete(filename);
    preloadBySid.delete(slot.sessionId);
  }
  return { skipped: false };
}

export function ramResetSession(sessionId: number, isPreload: boolean): void {
  if (!isPreload) {
    if (mainSlot && mainSlot.sessionId === sessionId) {
      mainSlot = null;
    }
    return;
  }
  const slot = preloadBySid.get(sessionId);
  if (slot) {
    preloadBySid.delete(sessionId);
    preloadByName.delete(slot.filename);
  }
}

export function ramReset(isPreload: boolean): void {
  if (isPreload) {
    preloadBySid.clear();
    preloadByName.clear();
  } else {
    mainSlot = null;
  }
}

// ─── Diagnostics ────────────────────────────────────────────────

export function ramStats(): {
  mainBytes: number;
  preloadCount: number;
  preloadBytes: number;
  finalizedCount: number;
  inFlightCount: number;
} {
  let mainBytes = 0;
  if (mainSlot) {
    if (mainSlot.finalizedBlob) mainBytes = mainSlot.finalizedBlob.size;
    else for (const c of mainSlot.chunks.values()) mainBytes += c.byteLength;
  }
  let preloadBytes = 0;
  let finalizedCount = 0;
  let inFlightCount = 0;
  for (const slot of preloadBySid.values()) {
    if (slot.finalized && slot.finalizedBlob) {
      preloadBytes += slot.finalizedBlob.size;
      finalizedCount++;
    } else {
      for (const c of slot.chunks.values()) preloadBytes += c.byteLength;
      inFlightCount++;
    }
  }
  return {
    mainBytes,
    preloadCount: preloadBySid.size,
    preloadBytes,
    finalizedCount,
    inFlightCount,
  };
}

/** @internal Test-only — clears all slots. */
export function __resetRamStoreForTests(): void {
  mainSlot = null;
  preloadBySid.clear();
  preloadByName.clear();
  log.debug('[Ramstore] reset for tests');
}
