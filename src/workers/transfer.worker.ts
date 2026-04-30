/**
 * MUSIXQUARE — Transfer Worker (OPFS File I/O)
 *
 * Slot-pool architecture
 * ──────────────────────
 * Earlier versions allocated one OPFS file per logical filename
 * (`preload_<safe-name>_<INSTANCE>` and `current_<safe-name>_<INSTANCE>`)
 * and called `removeEntry()` to clean up. On iOS WebKit this turned out
 * to be a long-tail bug: `removeEntry()` returns immediately but the
 * underlying disk pages are NOT reclaimed in real time. `/debug sweep`
 * confirmed it — wiping 17.2 MB of OPFS files left
 * `navigator.storage.estimate().usage` unchanged at 217 MB. The deferred
 * reclaim only fires when the app suspends, so a long PWA session with
 * many track switches accumulates ghost storage until iOS kills the tab.
 *
 * The fix is structural: never create more than a fixed pool of OPFS
 * files. We back the API with N pre-named slots that get truncated and
 * reused instead of removed and recreated. Each slot has:
 *   - a stable index (0..N-1) that picks its disk filename
 *     (`preload_slot_<i>_<INSTANCE>` or `current_slot_0_<INSTANCE>`)
 *   - the *logical* name currently mapped to it (the filename callers
 *     speak in), which changes every time the slot is reused
 *   - the OPFS handle and the read/write state
 *
 * Allocation:
 *   - Main pool: 1 slot. Always slot 0.
 *   - Preload pool: PRELOAD_POOL_SIZE slots. Allocator looks up the
 *     filename → if mapped, return that slot (resume). Else find an
 *     unused slot. Else LRU-evict an unlocked finalized slot.
 *   - All-locked exhaustion is rejected back to the caller; preload
 *     depth in production is 1–2 so this requires a pathological burst.
 *
 * Disk usage with a pool of size 1+4 ≈ 50 MB upper bound (max song size
 * × pool size). Compare with the previous unbounded growth that hit
 * 245 MB / 39 GB quota over ~3 minutes of testing.
 */

// self is already typed as DedicatedWorkerGlobalScope in WebWorker lib

// ─── Types ──────────────────────────────────────────────────────

interface PoolSlot {
  /** Stable position within its pool; picks the disk filename. */
  index: number;
  /** True for preload pool, false for the single main slot. */
  isPreload: boolean;
  /**
   * Disk filename. Computed lazily on first use because instanceId is
   * only known after INIT_INSTANCE arrives. Once set, never changes.
   */
  diskName: string;

  /** Current caller-visible filename held by this slot, or null if free. */
  logicalName: string | null;

  /** OPFS handles. */
  handle: FileSystemFileHandle | null;
  accessHandle: FileSystemSyncAccessHandle | null;
  writable: FileSystemWritableFileStream | null;
  mode: 'sync' | 'writable' | null;

  /** Transfer state. */
  chunkSize: number;
  writtenChunks: number;
  sessionId: number | null;
  isLocked: boolean;
  lockTime: number;

  /** Monotonic counter incremented on every touch — drives LRU eviction. */
  lastUsed: number;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_CHUNK_SIZE = 16384;
const LOCK_TIMEOUT_MS = 60000;
const PRELOAD_LOCK_TIMEOUT_MS = 20000;

/**
 * Number of OPFS files reserved for in-flight + finalized preloads.
 * Production preload depth is typically 1–2 ahead, so 4 leaves slack
 * for short LRU windows where a just-finalized preload can sit while
 * the next one starts streaming. Bumping this raises the disk-usage
 * ceiling proportionally — keep small.
 */
const PRELOAD_POOL_SIZE = 4;

// ─── State ──────────────────────────────────────────────────────

let instanceId = 'default';

let _useCounter = 0;
function nextLastUsed(): number {
  _useCounter++;
  return _useCounter;
}

function makeSlot(index: number, isPreload: boolean): PoolSlot {
  return {
    index,
    isPreload,
    diskName: '',
    logicalName: null,
    handle: null,
    accessHandle: null,
    writable: null,
    mode: null,
    chunkSize: DEFAULT_CHUNK_SIZE,
    writtenChunks: 0,
    sessionId: null,
    isLocked: false,
    lockTime: 0,
    lastUsed: 0,
  };
}

const mainSlot: PoolSlot = makeSlot(0, false);
const preloadPool: PoolSlot[] = Array.from({ length: PRELOAD_POOL_SIZE }, (_, i) =>
  makeSlot(i, true),
);

/** filename → preloadPool index. Single source of truth for resume lookups. */
const preloadNameToSlot = new Map<string, number>();
/** sessionId → preloadPool index. Lookup path for OPFS_WRITE / OPFS_END. */
const preloadSidToSlot = new Map<number, number>();

// ─── Slot Helpers ───────────────────────────────────────────────

function slotDiskName(slot: PoolSlot): string {
  if (!slot.diskName) {
    slot.diskName =
      (slot.isPreload ? 'preload_slot_' : 'current_slot_') + slot.index + '_' + instanceId;
  }
  return slot.diskName;
}

/** Lookup-only by sessionId — never registers a new slot. */
function findSlotBySessionId(isPreload: boolean, sessionId: number): PoolSlot | null {
  if (!isPreload) {
    return mainSlot.sessionId === sessionId ? mainSlot : null;
  }
  const idx = preloadSidToSlot.get(sessionId);
  return idx === undefined ? null : preloadPool[idx];
}

/** Lookup-only by logical filename — never registers a new slot. */
function findSlotByName(isPreload: boolean, filename: string): PoolSlot | null {
  if (!isPreload) {
    return mainSlot.logicalName === filename ? mainSlot : null;
  }
  const idx = preloadNameToSlot.get(filename);
  return idx === undefined ? null : preloadPool[idx];
}

/**
 * Resolve the slot that should handle a brand-new OPFS_START. For preload
 * this either resumes an existing mapping, picks a free slot, or evicts
 * the LRU unlocked entry. Returns null only when every preload slot is
 * actively locked — pathological burst, never observed in production.
 */
function findOrAllocateSlotForStart(
  filename: string,
  isPreload: boolean,
  sessionId: number,
): PoolSlot | null {
  if (!isPreload) {
    mainSlot.lastUsed = nextLastUsed();
    return mainSlot;
  }

  // Resume: filename already mapped to a slot.
  const existingIdx = preloadNameToSlot.get(filename);
  if (existingIdx !== undefined) {
    const slot = preloadPool[existingIdx];
    slot.lastUsed = nextLastUsed();
    // sessionId may have advanced; refresh the sid map.
    if (slot.sessionId !== sessionId) {
      if (slot.sessionId !== null) preloadSidToSlot.delete(slot.sessionId);
      preloadSidToSlot.set(sessionId, slot.index);
    }
    return slot;
  }

  // Free slot.
  for (const slot of preloadPool) {
    if (!slot.isLocked && slot.logicalName === null) {
      slot.lastUsed = nextLastUsed();
      slot.logicalName = filename;
      preloadNameToSlot.set(filename, slot.index);
      preloadSidToSlot.set(sessionId, slot.index);
      return slot;
    }
  }

  // LRU evict — pick the oldest unlocked slot. Locked slots (active write)
  // are protected from eviction so we don't corrupt an in-flight transfer.
  let victim: PoolSlot | null = null;
  for (const slot of preloadPool) {
    if (slot.isLocked) continue;
    if (!victim || slot.lastUsed < victim.lastUsed) victim = slot;
  }
  if (!victim) {
    // All slots locked. Caller will surface as OPFS_ERROR.
    return null;
  }

  // Drop old mappings before reassigning.
  if (victim.logicalName) preloadNameToSlot.delete(victim.logicalName);
  if (victim.sessionId !== null) preloadSidToSlot.delete(victim.sessionId);

  victim.lastUsed = nextLastUsed();
  victim.logicalName = filename;
  preloadNameToSlot.set(filename, victim.index);
  preloadSidToSlot.set(sessionId, victim.index);
  return victim;
}

// ─── Queue ──────────────────────────────────────────────────────

let isProcessing = false;
const messageQueue: Record<string, unknown>[] = [];

self.onmessage = (e: MessageEvent) => {
  messageQueue.push(e.data);
  if (!isProcessing) processQueue();
};

async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (messageQueue.length > 0) {
      const data = messageQueue.shift()!;
      try {
        await handleMessage(data);
      } catch (err: unknown) {
        const e2 = err as Error;
        console.error('[TransferWorker] Message error:', e2);
        safePost({
          type: 'WORKER_ERROR',
          scope: 'transfer',
          error: e2?.message ?? String(err),
          command: data?.command,
          stack: e2?.stack,
        });
      }
    }
  } finally {
    isProcessing = false;
    if (messageQueue.length > 0) setTimeout(() => processQueue(), 0);
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function safePost(msg: Record<string, unknown>, transfers?: Transferable[]): void {
  try {
    if (transfers) self.postMessage(msg, transfers);
    else self.postMessage(msg);
  } catch (e) {
    console.error('[TransferWorker] postMessage failed:', e);
  }
}

function nowMs(): number {
  return Date.now();
}

function isValidSessionId(sessionId: unknown): sessionId is number {
  return typeof sessionId === 'number' && Number.isInteger(sessionId);
}

function normalizeChunkSize(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK_SIZE;
  return Math.max(256, Math.floor(n));
}

function normalizeIndex(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function normalizeChunk(chunk: unknown): Uint8Array | null {
  if (!chunk) return null;
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk) && chunk.buffer) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return null;
}

// Dedupe session mismatch spam
let _lastMismatchKey: string | null = null;
function postSessionMismatch(payload: Record<string, unknown>): void {
  const key = `${payload.command}|${payload.expected}|${payload.received}|${payload.filename}|${payload.isPreload ? 'P' : 'C'}`;
  if (key === _lastMismatchKey) return;
  _lastMismatchKey = key;
  safePost(payload);
}

// ─── Lock / Handle Lifecycle ───────────────────────────────────

async function cleanupHandle(slot: PoolSlot, reason: string): Promise<void> {
  if (slot.accessHandle) {
    console.log(`[TransferWorker] Closing sync handle for slot ${slot.index} (${reason})`);
    try {
      if (typeof slot.accessHandle.flush === 'function') await slot.accessHandle.flush();
      if (typeof slot.accessHandle.close === 'function') await slot.accessHandle.close();
    } catch (e: unknown) {
      console.warn('[TransferWorker] Sync handle cleanup warning:', (e as Error)?.message ?? e);
    } finally {
      slot.accessHandle = null;
    }
  }
  if (slot.writable) {
    console.log(`[TransferWorker] Closing writable stream for slot ${slot.index} (${reason})`);
    try {
      if (typeof slot.writable.close === 'function') await slot.writable.close();
    } catch {
      try {
        if (typeof slot.writable!.abort === 'function') await slot.writable!.abort();
      } catch {
        /* ignore */
      }
    } finally {
      slot.writable = null;
    }
  }
  slot.mode = null;
  slot.handle = null;
}

/**
 * Attempt to acquire the slot for a session. Slot allocation already happened
 * upstream (`findOrAllocateSlotForStart`) — this just adjudicates between
 * concurrent OPFS_START messages targeting the same slot (e.g. a stale
 * retry racing the latest session). Returns false when the older request
 * loses to the newer.
 */
async function acquireSlotLock(
  slot: PoolSlot,
  sessionId: number,
  filename: string,
  isPreload: boolean,
): Promise<boolean> {
  const now = nowMs();
  const timeout = isPreload ? PRELOAD_LOCK_TIMEOUT_MS : LOCK_TIMEOUT_MS;

  if (!isValidSessionId(sessionId)) {
    console.error(`[TransferWorker] Invalid sessionId type: ${typeof sessionId} (${sessionId})`);
    return false;
  }

  if (slot.isLocked && slot.logicalName === filename) {
    if (sessionId === slot.sessionId) {
      slot.lockTime = now;
      return true;
    }
    if (slot.sessionId != null && sessionId < slot.sessionId) {
      console.warn(
        `[TransferWorker] Stale session ${sessionId} tried to renew lock held by ${slot.sessionId}`,
      );
      return false;
    }
    await cleanupHandle(slot, `Preemption by session ${sessionId} (was ${slot.sessionId})`);
  }

  if (slot.isLocked && slot.logicalName !== filename) {
    const age = now - slot.lockTime;
    if (slot.sessionId == null || sessionId >= slot.sessionId) {
      await cleanupHandle(slot, `Preemption for new file by session ${sessionId}`);
    } else if (age < timeout) {
      return false;
    } else {
      await cleanupHandle(slot, `Stale lock cleanup by session ${sessionId}`);
    }
  }

  slot.sessionId = sessionId;
  slot.logicalName = filename;
  slot.isLocked = true;
  slot.lockTime = now;
  return true;
}

async function releaseSlotLock(slot: PoolSlot): Promise<void> {
  const oldName = slot.logicalName;
  slot.isLocked = false;
  slot.sessionId = null;
  slot.lockTime = 0;
  await cleanupHandle(slot, `Manual release for ${oldName}`);
  slot.writtenChunks = 0;
}

/**
 * Free a slot — handles closed, lock released, name unmapped, file
 * truncated. After this the slot is available for the next allocator
 * pass. Never calls `removeEntry()` — the disk file persists with size
 * 0 so iOS doesn't have to reclaim anything.
 */
async function freeSlot(slot: PoolSlot): Promise<void> {
  await cleanupHandle(slot, `Free slot ${slot.index}`);

  if (slot.logicalName) {
    if (slot.isPreload) preloadNameToSlot.delete(slot.logicalName);
    slot.logicalName = null;
  }
  if (slot.sessionId !== null) {
    if (slot.isPreload) preloadSidToSlot.delete(slot.sessionId);
    slot.sessionId = null;
  }
  slot.isLocked = false;
  slot.lockTime = 0;
  slot.writtenChunks = 0;

  // Truncate the slot's disk file to 0 so it doesn't keep its previous
  // contents around. The file itself stays on disk — that's the whole
  // point of the slot pool. Truncate is best-effort: the file may not
  // exist yet (slot never used) and that's fine.
  await truncateSlotFileToZero(slot);
}

async function truncateSlotFileToZero(slot: PoolSlot): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(slotDiskName(slot)).catch(() => null);
    if (!handle) return;

    // Prefer SyncAccessHandle.truncate — runs in worker, no async writable
    // overhead and doesn't allocate a separate writable stream.
    if (
      typeof (handle as unknown as Record<string, unknown>).createSyncAccessHandle === 'function'
    ) {
      try {
        const ah = await (
          handle as unknown as {
            createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
          }
        ).createSyncAccessHandle();
        try {
          ah.truncate(0);
          if (typeof ah.flush === 'function') await ah.flush();
        } finally {
          await ah.close();
        }
        return;
      } catch (e) {
        console.warn(
          '[TransferWorker] truncate via sync handle failed, falling back:',
          (e as Error)?.message,
        );
      }
    }

    // Fallback: open writable with keepExistingData=false (which truncates).
    if (typeof handle.createWritable === 'function') {
      try {
        const w = await handle.createWritable({ keepExistingData: false });
        await w.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore — best-effort */
  }
}

// ─── Message Handler ────────────────────────────────────────────

async function handleMessage(data: Record<string, unknown>): Promise<void> {
  const command = data.command as string | undefined;

  if (command === 'INIT_INSTANCE') {
    instanceId = (data.instanceId as string) || 'default';
    _lastMismatchKey = null;
    // Force disk-name regeneration in case INIT_INSTANCE arrives twice with
    // different IDs (e.g. test harness reusing a worker).
    mainSlot.diskName = '';
    for (const slot of preloadPool) slot.diskName = '';
    console.log(`[TransferWorker] Instance Initialized: ${instanceId}`);
    return;
  }

  if (command === 'OPFS_START') {
    const filename = data.filename as string;
    const isPreload = !!data.isPreload;
    const sessionId = data.sessionId as number;

    if (!filename) {
      safePost({
        type: 'OPFS_ERROR',
        error: 'Missing filename',
        filename,
        isPreload,
        code: 'BAD_ARGS',
      });
      return;
    }

    const slot = findOrAllocateSlotForStart(filename, isPreload, sessionId);
    if (!slot) {
      safePost({
        type: 'OPFS_ERROR',
        error: 'Preload pool exhausted',
        filename,
        isPreload,
        code: 'POOL_EXHAUSTED',
      });
      return;
    }

    if (!(await acquireSlotLock(slot, sessionId, filename, isPreload))) {
      safePost({
        type: 'OPFS_ERROR',
        error: 'Lock Collision',
        filename,
        isPreload,
        code: 'LOCKED',
      });
      return;
    }

    slot.chunkSize = normalizeChunkSize(data.size);
    slot.writtenChunks = 0;

    try {
      await cleanupHandle(slot, 'New start');
      const root = await navigator.storage.getDirectory();
      const diskName = slotDiskName(slot);

      // Slot files are persistent — we do NOT call removeEntry. Instead the
      // file is opened and truncated in-place (sync handle) or recreated
      // with keepExistingData=false (writable fallback). On iOS this is
      // critical: removeEntry doesn't reclaim disk for the deleted file
      // until the app suspends, so removing-and-recreating leaks pages.
      slot.handle = await root.getFileHandle(diskName, { create: true });

      let opened = false;
      if (
        slot.handle &&
        typeof (slot.handle as unknown as Record<string, unknown>).createSyncAccessHandle ===
          'function'
      ) {
        try {
          slot.accessHandle = await (
            slot.handle as unknown as {
              createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
            }
          ).createSyncAccessHandle();
          slot.mode = 'sync';
          // Truncate any leftover bytes from the slot's previous tenant.
          // `keepExisting` from the caller is honored — recovery reuses the
          // same filename and wants whatever already-written prefix remains.
          if (!data.keepExisting) {
            slot.accessHandle.truncate(0);
            if (typeof slot.accessHandle.flush === 'function') {
              await slot.accessHandle.flush();
            }
          }
          opened = true;
        } catch (e: unknown) {
          console.warn(
            '[TransferWorker] createSyncAccessHandle failed, falling back:',
            (e as Error)?.message ?? e,
          );
        }
      }

      if (!opened) {
        if (slot.handle && typeof slot.handle.createWritable === 'function') {
          // keepExistingData=false performs the truncate for us; for recovery
          // we keep existing bytes so already-received chunks are preserved.
          slot.writable = await slot.handle.createWritable({
            keepExistingData: !!data.keepExisting,
          });
          slot.mode = 'writable';
          opened = true;
        }
      }

      if (!opened) throw new Error('No supported OPFS write interface');

      safePost({ type: 'OPFS_STARTED', filename, isPreload, sessionId });
    } catch (e: unknown) {
      await releaseSlotLock(slot);
      // Drop the just-allocated mapping so the caller's retry can grab a
      // fresh slot instead of bouncing off our own stale entry.
      if (isPreload) {
        if (slot.logicalName) preloadNameToSlot.delete(slot.logicalName);
        if (slot.sessionId !== null) preloadSidToSlot.delete(slot.sessionId);
        slot.logicalName = null;
        slot.sessionId = null;
      } else {
        slot.logicalName = null;
        slot.sessionId = null;
      }
      safePost({
        type: 'OPFS_ERROR',
        error: (e as Error)?.message ?? String(e),
        filename,
        isPreload,
        code: 'START_FAILED',
      });
    }
    return;
  }

  if (command === 'OPFS_WRITE') {
    const filename = data.filename as string;
    const isPreload = !!data.isPreload;
    const sessionId = data.sessionId as number;

    const slot = findSlotBySessionId(isPreload, sessionId);
    if (!slot) {
      postSessionMismatch({
        type: 'SESSION_MISMATCH',
        command: 'OPFS_WRITE',
        expected: null,
        received: sessionId,
        filename,
        isPreload,
      });
      safePost({
        type: 'OPFS_WRITE_ERROR',
        error: 'Session not found',
        filename,
        index: data.index,
        isPreload,
        code: 'SESSION_MISMATCH',
      });
      return;
    }

    if (sessionId !== slot.sessionId) {
      postSessionMismatch({
        type: 'SESSION_MISMATCH',
        command: 'OPFS_WRITE',
        expected: slot.sessionId,
        received: sessionId,
        filename,
        isPreload,
      });
      safePost({
        type: 'OPFS_WRITE_ERROR',
        error: 'Session mismatch',
        filename,
        index: data.index,
        isPreload,
        code: 'SESSION_MISMATCH',
      });
      return;
    }

    if (!filename || slot.logicalName !== filename) return;
    if (!slot.isLocked) return;

    const index = normalizeIndex(data.index);
    if (index === null) {
      safePost({
        type: 'OPFS_WRITE_ERROR',
        error: 'Invalid index',
        filename,
        index: data.index,
        isPreload,
      });
      return;
    }

    const chunk = normalizeChunk(data.chunk);
    if (!chunk) {
      safePost({ type: 'OPFS_WRITE_ERROR', error: 'Invalid chunk', filename, index, isPreload });
      return;
    }

    try {
      const offset = index * slot.chunkSize;
      if (slot.mode === 'sync' && slot.accessHandle) {
        slot.accessHandle.write(chunk, { at: offset });
        slot.writtenChunks++;
        slot.lockTime = nowMs();
        if (slot.writtenChunks % 100 === 0 && typeof slot.accessHandle.flush === 'function') {
          await slot.accessHandle.flush();
        }
      } else if (slot.mode === 'writable' && slot.writable) {
        await slot.writable.write({
          type: 'write',
          position: offset,
          data: chunk as unknown as BufferSource,
        });
        slot.writtenChunks++;
        slot.lockTime = nowMs();
      }
    } catch (e: unknown) {
      safePost({
        type: 'OPFS_WRITE_ERROR',
        error: (e as Error)?.message ?? String(e),
        filename,
        index,
        isPreload,
      });
    }
    return;
  }

  if (command === 'OPFS_END') {
    const filename = data.filename as string;
    const isPreload = !!data.isPreload;
    const sessionId = data.sessionId as number;
    const totalSize = data.totalSize as number | undefined;

    const slot = findSlotBySessionId(isPreload, sessionId);
    if (!slot || sessionId !== slot.sessionId) {
      postSessionMismatch({
        type: 'SESSION_MISMATCH',
        command: 'OPFS_END',
        expected: slot?.sessionId ?? null,
        received: sessionId,
        filename,
        isPreload,
      });
      return;
    }

    try {
      if (slot.mode === 'sync' && slot.accessHandle) {
        if (typeof slot.accessHandle.flush === 'function') await slot.accessHandle.flush();
        if (totalSize) {
          const actualSize = await slot.accessHandle.getSize();
          if (actualSize !== totalSize) {
            if (actualSize > totalSize && typeof slot.accessHandle.truncate === 'function') {
              try {
                await slot.accessHandle.truncate(totalSize);
                const resized = await slot.accessHandle.getSize();
                if (resized !== totalSize)
                  throw new Error(`Integrity Fail: ${resized}/${totalSize}`);
              } catch {
                throw new Error(`Integrity Fail: ${actualSize}/${totalSize}`);
              }
            } else {
              throw new Error(`Integrity Fail: ${actualSize}/${totalSize}`);
            }
          }
        }
      } else if (slot.mode === 'writable' && slot.writable) {
        await slot.writable.close();
        slot.writable = null;
        if (totalSize && slot.handle) {
          const f = await slot.handle.getFile();
          if (f.size !== totalSize) {
            if (f.size > totalSize) {
              let w: FileSystemWritableFileStream | null = null;
              try {
                w = await slot.handle.createWritable({ keepExistingData: true });
                await w.write({ type: 'truncate', size: totalSize });
                await w.close();
                w = null;
                const f2 = await slot.handle.getFile();
                if (f2.size !== totalSize)
                  throw new Error(`Integrity Fail: ${f2.size}/${totalSize}`);
              } finally {
                if (w) {
                  try {
                    await w.abort();
                  } catch {
                    /* best-effort */
                  }
                }
              }
            } else {
              throw new Error(`Integrity Fail: ${f.size}/${totalSize}`);
            }
          }
        }
      } else {
        throw new Error('No open handle for OPFS_END');
      }

      const sidSnapshot = slot.sessionId;
      // Release the lock but KEEP the slot mapping — the consumer still
      // needs to read this file via OPFS_READ. Cleanup happens later via
      // OPFS_CLEANUP / OPFS_RESET / LRU eviction in the next allocator pass.
      await cleanupHandle(slot, 'OPFS_END finalize');
      slot.isLocked = false;
      slot.lockTime = 0;
      slot.writtenChunks = 0;
      safePost({ type: 'OPFS_FILE_READY', filename, isPreload, sessionId: sidSnapshot });
    } catch (e: unknown) {
      // On integrity failure, free the slot and truncate so the next
      // tenant gets a clean file.
      await freeSlot(slot);
      safePost({
        type: 'OPFS_ERROR',
        error: (e as Error)?.message ?? String(e),
        filename,
        isPreload,
        code: 'INTEGRITY_FAIL',
      });
    }
    return;
  }

  if (command === 'OPFS_RESET') {
    const isPreload = !!data.isPreload;
    if (isPreload) {
      // Free every preload slot — closes handles, unmaps names, truncates
      // disk files to 0 (we keep the slot files themselves for reuse).
      for (const slot of preloadPool) {
        await freeSlot(slot);
      }
      // Defensive: name/sid maps should already be empty after the loop,
      // but a stray entry pointing to a slot we just freed would silently
      // wedge the next allocator pass — wipe them too.
      preloadNameToSlot.clear();
      preloadSidToSlot.clear();
    } else {
      await freeSlot(mainSlot);
    }
    safePost({ type: 'OPFS_RESET_COMPLETE', isPreload });
    return;
  }

  // Per-sid preload slot release (called by PRELOAD_ABORT cleanup on guest).
  // Was: per-sessionId removeEntry that left the underlying disk pages
  // allocated on iOS. Now: free the slot — no disk delete, just truncate
  // and unmap. The slot file is reused by the next allocator pass.
  if (command === 'OPFS_RESET_SESSION') {
    const sessionId = data.sessionId as number;
    if (!isValidSessionId(sessionId)) return;
    const slot = findSlotBySessionId(true, sessionId);
    if (slot) await freeSlot(slot);
    return;
  }

  if (command === 'OPFS_CLEANUP') {
    const filename = data.filename as string;
    const isPreload = !!data.isPreload;

    if (!filename) {
      safePost({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload });
      return;
    }

    const slot = findSlotByName(isPreload, filename);
    // No slot mapped to this filename — already gone, treat as success.
    if (!slot) {
      safePost({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload });
      return;
    }

    // Slot is currently locked for this filename — the caller probably
    // raced an in-flight write. Bail with skipped=true so the upstream
    // logic knows to retry once the write finishes (matches old contract).
    if (slot.isLocked && slot.logicalName === filename) {
      safePost({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload, skipped: true });
      return;
    }

    await freeSlot(slot);
    safePost({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload });
    return;
  }

  if (command === 'OPFS_READ') {
    const filename = data.filename as string;
    const isPreload = !!data.isPreload;
    const sessionId = data.sessionId as number | undefined;
    const requestId = data.requestId;

    const index = normalizeIndex(data.index);
    if (!filename || index === null) {
      safePost({
        type: 'OPFS_READ_ERROR',
        error: 'BAD_ARGS',
        filename,
        index: data.index,
        requestId,
      });
      return;
    }

    // Preferred path: the caller's session is still mapped and the slot's
    // sync handle is open from OPFS_START → reuse it directly.
    const sidSlot =
      sessionId !== undefined ? findSlotBySessionId(isPreload, sessionId as number) : null;
    if (
      sidSlot &&
      sidSlot.isLocked &&
      sidSlot.logicalName === filename &&
      sidSlot.mode === 'sync' &&
      sidSlot.accessHandle
    ) {
      try {
        const chunkSize = sidSlot.chunkSize || DEFAULT_CHUNK_SIZE;
        const offset = index * chunkSize;
        const buffer = new Uint8Array(chunkSize);
        const bytesRead = sidSlot.accessHandle.read(buffer, { at: offset });
        const chunk = bytesRead === chunkSize ? buffer : buffer.slice(0, bytesRead);
        safePost({ type: 'OPFS_READ_COMPLETE', chunk, index, filename, requestId, sessionId }, [
          chunk.buffer,
        ]);
      } catch (e: unknown) {
        safePost({
          type: 'OPFS_READ_ERROR',
          error: (e as Error)?.message ?? String(e),
          filename,
          index,
          requestId,
        });
      }
      return;
    }

    // Otherwise the slot has been finalized (lock released after OPFS_END)
    // or the caller is reading a sibling slot. Open a fresh handle on the
    // slot's disk file.
    const slot = findSlotByName(isPreload, filename);
    if (!slot) {
      safePost({
        type: 'OPFS_READ_ERROR',
        error: 'No slot mapped for filename',
        filename,
        index,
        requestId,
      });
      return;
    }

    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(slotDiskName(slot));

      const chunkSize = slot.chunkSize || DEFAULT_CHUNK_SIZE;
      const offset = index * chunkSize;

      if (
        fileHandle &&
        typeof (fileHandle as unknown as Record<string, unknown>).createSyncAccessHandle ===
          'function'
      ) {
        let ah: FileSystemSyncAccessHandle | null = null;
        try {
          ah = await (
            fileHandle as unknown as {
              createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
            }
          ).createSyncAccessHandle();
        } catch (lockErr: unknown) {
          console.warn(
            '[TransferWorker] SyncAccessHandle unavailable for read, using File fallback:',
            (lockErr as Error)?.message,
          );
        }
        if (ah) {
          try {
            const buffer = new Uint8Array(chunkSize);
            const bytesRead = ah.read(buffer, { at: offset });
            const chunk = bytesRead === chunkSize ? buffer : buffer.slice(0, bytesRead);
            safePost({ type: 'OPFS_READ_COMPLETE', chunk, index, filename, requestId, sessionId }, [
              chunk.buffer,
            ]);
          } finally {
            try {
              await ah.close();
            } catch {
              /* ignore */
            }
          }
          return;
        }
      }

      // Fallback: async File slicing.
      const file = await fileHandle.getFile();
      const slice = file.slice(offset, offset + chunkSize);
      const buf = await slice.arrayBuffer();
      const chunk = new Uint8Array(buf);
      safePost({ type: 'OPFS_READ_COMPLETE', chunk, index, filename, requestId, sessionId }, [
        chunk.buffer,
      ]);
    } catch (e: unknown) {
      safePost({
        type: 'OPFS_READ_ERROR',
        error: (e as Error)?.message ?? String(e),
        filename,
        index,
        requestId,
      });
    }
  }
}

// ─── Global Safety ──────────────────────────────────────────────

self.addEventListener('error', (e) => {
  safePost({
    type: 'WORKER_ERROR',
    scope: 'transfer',
    command: 'WORKER_ERROR',
    error: e?.message ?? 'Worker error',
  });
});

self.addEventListener('unhandledrejection', (e) => {
  const reason = e?.reason as Error | undefined;
  safePost({
    type: 'WORKER_ERROR',
    scope: 'transfer',
    command: 'UNHANDLED_REJECTION',
    error: reason?.message ?? String(reason),
  });
});

self.addEventListener('messageerror', () => {
  safePost({
    type: 'WORKER_ERROR',
    scope: 'transfer',
    command: 'MESSAGE_ERROR',
    error: 'Message deserialization failed',
  });
});
