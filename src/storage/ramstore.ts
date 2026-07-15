/**
 * MUSIXQUARE — RAM-only chunk store
 *
 * Sessions accumulate chunks until STORAGE_END, after which a Blob is
 * available for read. No `navigator.storage` access, no worker.
 *
 * Memory use scales with the active encoded blob, retained preload blobs, and
 * the decoded AudioBuffer owned by playback. The store has no persistent
 * spill path. Callers own obsolete-session release. The legacy engine accounts
 * for this memory but intentionally applies no predictive device-memory cap;
 * browser allocation/decode is best effort as documented in the ADR below.
 * Policy source (repository path, not a runtime URL):
 * docs/design/browser-media-storage-policy.md
 */

import { log } from '../core/log.ts';

// ─── Types ──────────────────────────────────────────────────────

interface RamSlot {
  /** Stable playlist-row identity. Filename is display metadata only. */
  queueItemId: string;
  filename: string;
  isPreload: boolean;
  sessionId: number;
  /** Declared media type, or a conservative filename-extension fallback. */
  mime: string;
  /** Chunks indexed by chunk index. Out-of-order arrival is normal here. */
  chunks: Map<number, Uint8Array>;
  /** Set on the first STORAGE_START, used to compute byte offsets for reads. */
  chunkSize: number;
  /** Set on STORAGE_END; null while writing. */
  totalSize: number | null;
  /** True after STORAGE_END has produced a finalizedBlob. */
  finalized: boolean;
  /**
   * Concatenated final blob. Created lazily by ramEnd; reused on read.
   * Chunks are dropped after this is set so we don't double-account.
   */
  finalizedBlob: Blob | null;
}

const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  caf: 'audio/x-caf',
});

function declaredMime(mime?: string): string {
  const value = typeof mime === 'string' ? mime.trim() : '';
  const essence = value.split(';', 1)[0]?.trim().toLowerCase();
  if (essence === 'application/octet-stream' || essence === 'binary/octet-stream') return '';
  return value;
}

function inferAudioMimeFromFilename(filename: string): string {
  const match = /\.([^.\\/]+)$/.exec(filename.trim().toLowerCase());
  return match ? (AUDIO_MIME_BY_EXTENSION[match[1] ?? ''] ?? '') : '';
}

function resolveStoredMime(filename: string, mime?: string): string {
  return declaredMime(mime) || inferAudioMimeFromFilename(filename);
}

// ─── State ──────────────────────────────────────────────────────

/** Single main slot — at most one main-channel transfer in flight. */
let mainSlot: RamSlot | null = null;
/** Preload slots keyed by exact transfer session. */
const preloadBySid = new Map<number, RamSlot>();
/** Secondary index used only for explicit queue-item cleanup. */
const preloadSidsByQueueItemId = new Map<string, Set<number>>();

function addPreloadSlot(slot: RamSlot): void {
  preloadBySid.set(slot.sessionId, slot);
  const sessions = new Set(preloadSidsByQueueItemId.get(slot.queueItemId) ?? []);
  sessions.add(slot.sessionId);
  preloadSidsByQueueItemId.set(slot.queueItemId, sessions);
}

function removePreloadSlot(sessionId: number): void {
  const slot = preloadBySid.get(sessionId);
  if (!slot) return;
  preloadBySid.delete(sessionId);
  const sessions = new Set(preloadSidsByQueueItemId.get(slot.queueItemId) ?? []);
  sessions.delete(sessionId);
  if (sessions.size > 0) preloadSidsByQueueItemId.set(slot.queueItemId, sessions);
  else preloadSidsByQueueItemId.delete(slot.queueItemId);
}

function makeSlot(
  queueItemId: string,
  filename: string,
  isPreload: boolean,
  sessionId: number,
  chunkSize: number,
  mime?: string,
): RamSlot {
  return {
    queueItemId,
    filename,
    isPreload,
    sessionId,
    mime: resolveStoredMime(filename, mime),
    chunks: new Map(),
    chunkSize,
    totalSize: null,
    finalized: false,
    finalizedBlob: null,
  };
}

// ─── Write Path ─────────────────────────────────────────────────

export function ramStart(
  queueItemId: string,
  filename: string,
  isPreload: boolean,
  sessionId: number,
  chunkSize: number,
  keepExisting: boolean,
  mime?: string,
): { ok: boolean; reason?: string } {
  if (!queueItemId) return { ok: false, reason: 'Missing queueItemId' };
  if (!filename) return { ok: false, reason: 'Missing filename' };
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return { ok: false, reason: 'Invalid sessionId' };
  }

  if (!isPreload) {
    // Resume can retain chunks only inside the exact same transfer session.
    // Filename equality does not prove byte identity across sessions.
    if (
      keepExisting &&
      mainSlot &&
      mainSlot.queueItemId === queueItemId &&
      mainSlot.filename === filename &&
      sessionId === mainSlot.sessionId
    ) {
      const resumedMime = declaredMime(mime);
      if (resumedMime) mainSlot.mime = resumedMime;
      return { ok: true };
    }
    mainSlot = makeSlot(queueItemId, filename, isPreload, sessionId, chunkSize, mime);
    return { ok: true };
  }

  // Preload — reuse existing slot if filename + session match (resume).
  const existing = preloadBySid.get(sessionId);
  if (
    existing &&
    existing.queueItemId === queueItemId &&
    existing.filename === filename &&
    keepExisting
  ) {
    const resumedMime = declaredMime(mime);
    if (resumedMime) existing.mime = resumedMime;
    return { ok: true };
  }

  // A session ID is bound to exactly one queue item for its lifetime.
  if (existing) removePreloadSlot(sessionId);

  const slot = makeSlot(queueItemId, filename, isPreload, sessionId, chunkSize, mime);
  addPreloadSlot(slot);
  return { ok: true };
}

export function ramWrite(
  queueItemId: string,
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
  if (slot.queueItemId !== queueItemId) {
    return { ok: false, reason: 'Queue item mismatch' };
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
 * Finalize a slot. Two-tier integrity gate:
 *   1. expectedChunks (always known — host's FILE_START/FILE_CHUNK both
 *      carry `total`): structural check that all chunk indices arrived.
 *      Combined with the upstream chunkIndex bounds check, size match
 *      ⟹ keys are exactly [0..expectedChunks-1] (pigeonhole).
 *   2. totalSize (host-declared bytes; missing in the meta-recovery path
 *      where guest reconstructs meta from a chunk frame because FILE_START
 *      was lost): tail-trims overshoot, hard-fails undershoot.
 * Returns null if the slot can't be found, session mismatches, or either
 * gate detects corruption.
 */
export function ramEnd(
  queueItemId: string,
  filename: string,
  isPreload: boolean,
  sessionId: number,
  totalSize?: number,
  expectedChunks?: number,
): { blob: Blob | null; reason?: string; expectedSid?: number | null } {
  const slot = isPreload ? preloadBySid.get(sessionId) : mainSlot;
  if (!slot) return { blob: null, reason: 'Session not found', expectedSid: null };
  if (slot.sessionId !== sessionId) {
    return { blob: null, reason: 'Session mismatch', expectedSid: slot.sessionId };
  }
  if (slot.queueItemId !== queueItemId) {
    return { blob: null, reason: 'Queue item mismatch' };
  }
  if (slot.filename !== filename) {
    return { blob: null, reason: 'Filename mismatch' };
  }

  // Tier 1: structural completeness via chunk count.
  if (typeof expectedChunks === 'number' && expectedChunks > 0) {
    if (slot.chunks.size !== expectedChunks) {
      return {
        blob: null,
        reason: `Integrity Fail: ${slot.chunks.size}/${expectedChunks} chunks`,
      };
    }
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
  let blob = new Blob(parts, { type: slot.mime });

  // Tier 2: byte-size cap (when host declared a size). Tail-trim overshoot
  // from CHUNK_SIZE-aligned writes, hard-fail undershoot.
  if (typeof totalSize === 'number' && totalSize > 0) {
    if (blob.size > totalSize) blob = blob.slice(0, totalSize, slot.mime);
    else if (blob.size < totalSize) {
      return { blob: null, reason: `Integrity Fail: ${blob.size}/${totalSize}` };
    }
  }

  slot.finalizedBlob = blob;
  slot.finalized = true;
  slot.totalSize = blob.size;
  // Drop chunk map — reads come from finalizedBlob. Keeps memory honest:
  // the same bytes shouldn't sit in both `chunks` and `finalizedBlob`.
  slot.chunks.clear();

  return { blob };
}

/**
 * Contiguous-from-0 chunk count of the slot holding `filename` (0 if no
 * matching slot). This is the data-plane bound for resume counters and
 * recovery requests; neither may advance beyond the contiguous prefix.
 * Finalized slots report their full chunk count — the store holds every byte.
 *
 * This is a synchronous read. A caller in the same stack as a queued
 * STORAGE_WRITE will observe the state before that write drains. Main-channel
 * resume and recovery call it only after pending command work has yielded.
 */
export function ramContiguousCount(
  queueItemId: string,
  isPreload: boolean,
  sessionId: number,
): number {
  if (!queueItemId) return 0;
  const slot = findSlotForRead(queueItemId, isPreload, sessionId);
  if (!slot) return 0;
  if (slot.finalized) {
    // chunkSize guard: a 0/undefined chunkSize must not divide-by-zero.
    return Math.ceil((slot.totalSize ?? slot.finalizedBlob?.size ?? 0) / (slot.chunkSize || 1));
  }
  let count = 0;
  while (slot.chunks.has(count)) count++;
  return count;
}

// ─── Read Path ──────────────────────────────────────────────────

/**
 * Read a chunk from the slot using the STORAGE_READ contract:
 * caller passes chunk index, we slice from the finalized blob (or live
 * chunks if not yet finalized).
 */
export async function ramReadChunk(
  queueItemId: string,
  isPreload: boolean,
  sessionId: number,
  chunkIndex: number,
): Promise<Uint8Array | null> {
  const slot = findSlotForRead(queueItemId, isPreload, sessionId);
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
export function ramReadBlob(
  queueItemId: string,
  isPreload: boolean,
  sessionId: number,
): Blob | null {
  const slot = findSlotForRead(queueItemId, isPreload, sessionId);
  return slot?.finalizedBlob ?? null;
}

function findSlotForRead(
  queueItemId: string,
  isPreload: boolean,
  sessionId: number,
): RamSlot | null {
  if (!isPreload) {
    if (mainSlot && mainSlot.queueItemId === queueItemId && mainSlot.sessionId === sessionId) {
      return mainSlot;
    }
    return null;
  }
  const bySid = preloadBySid.get(sessionId);
  return bySid?.queueItemId === queueItemId ? bySid : null;
}

// ─── Reset / Cleanup ────────────────────────────────────────────

export function ramCleanup(
  queueItemId: string,
  isPreload: boolean,
  sessionId?: number,
): { skipped: boolean } {
  if (!isPreload) {
    if (
      mainSlot?.queueItemId === queueItemId &&
      (sessionId === undefined || mainSlot.sessionId === sessionId)
    ) {
      mainSlot = null;
    }
    return { skipped: false };
  }
  if (sessionId !== undefined) {
    const slot = preloadBySid.get(sessionId);
    if (slot?.queueItemId === queueItemId) removePreloadSlot(sessionId);
    return { skipped: false };
  }
  for (const sid of [...(preloadSidsByQueueItemId.get(queueItemId) ?? [])]) {
    removePreloadSlot(sid);
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
  if (slot) removePreloadSlot(sessionId);
}

export function ramReset(isPreload: boolean): void {
  if (isPreload) {
    preloadBySid.clear();
    preloadSidsByQueueItemId.clear();
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
  preloadSidsByQueueItemId.clear();
  log.debug('[Ramstore] reset for tests');
}
