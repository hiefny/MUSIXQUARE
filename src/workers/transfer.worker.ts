/**
 * MUSIXQUARE 2.0 — Transfer Worker (OPFS File I/O)
 * Ported from js/transfer.worker.js
 *
 * Handles heavy file I/O operations with session-aware locking.
 */

'use strict';

// self is already typed as DedicatedWorkerGlobalScope in WebWorker lib

// ─── Types ──────────────────────────────────────────────────────

interface OpfsSlot {
  handle: FileSystemFileHandle | null;
  accessHandle: FileSystemSyncAccessHandle | null;
  writable: FileSystemWritableFileStream | null;
  mode: 'sync' | 'writable' | null;
  name: string | null;
  chunkSize: number;
  writtenChunks: number;
  sessionId: number | null;
  isLocked: boolean;
  lockTime: number;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_CHUNK_SIZE = 16384;
const LOCK_TIMEOUT_MS = 60000;
const PRELOAD_LOCK_TIMEOUT_MS = 20000;

// ─── State ──────────────────────────────────────────────────────

function createOpfsSlot(): OpfsSlot {
  return {
    handle: null,
    accessHandle: null,
    writable: null,
    mode: null,
    name: null,
    chunkSize: DEFAULT_CHUNK_SIZE,
    writtenChunks: 0,
    sessionId: null,
    isLocked: false,
    lockTime: 0,
  };
}

const currentFileOpfs = createOpfsSlot();
const preloadFileOpfs = createOpfsSlot();
let instanceId = 'default';

// ─── Queue ──────────────────────────────────────────────────────

let isProcessing = false;
const messageQueue: (Record<string, unknown> | null)[] = [];
let queueIndex = 0;

self.onmessage = (e: MessageEvent) => {
  messageQueue.push(e.data);
  if (!isProcessing) processQueue();
};

async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (queueIndex < messageQueue.length) {
      const data = messageQueue[queueIndex++];
      try {
        if (data) await handleMessage(data);
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
      messageQueue[queueIndex - 1] = null;
      if (queueIndex >= 128) {
        messageQueue.splice(0, queueIndex);
        queueIndex = 0;
      }
    }
  } finally {
    if (queueIndex > 0) {
      messageQueue.splice(0, queueIndex);
      queueIndex = 0;
    }
    isProcessing = false;
    if (messageQueue.length > 0) processQueue();
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

function nowMs(): number { return Date.now(); }

function isValidSessionId(sessionId: unknown): sessionId is number {
  return (typeof sessionId === 'number' && Number.isInteger(sessionId));
}

function sanitizeFilename(filename: string): string {
  return String(filename || '').replace(/[^a-z0-9._-]/gi, '_');
}

function buildSafeName(filename: string, isPreload: boolean): string {
  return (isPreload ? 'preload_' : 'current_') + sanitizeFilename(filename) + '_' + instanceId;
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

// ─── Lock ───────────────────────────────────────────────────────

async function cleanupHandle(opfsObj: OpfsSlot, reason: string): Promise<void> {
  if (opfsObj.accessHandle) {
    console.log(`[TransferWorker] Closing sync handle for ${opfsObj.name} (${reason})`);
    try {
      if (typeof opfsObj.accessHandle.flush === 'function') await opfsObj.accessHandle.flush();
      if (typeof opfsObj.accessHandle.close === 'function') await opfsObj.accessHandle.close();
    } catch (e: unknown) {
      console.warn('[TransferWorker] Sync handle cleanup warning:', (e as Error)?.message ?? e);
    } finally {
      opfsObj.accessHandle = null;
    }
  }
  if (opfsObj.writable) {
    console.log(`[TransferWorker] Closing writable stream for ${opfsObj.name} (${reason})`);
    try {
      if (typeof opfsObj.writable.close === 'function') await opfsObj.writable.close();
    } catch {
      try { if (typeof opfsObj.writable!.abort === 'function') await opfsObj.writable!.abort(); } catch { /* ignore */ }
    } finally {
      opfsObj.writable = null;
    }
  }
  opfsObj.mode = null;
  opfsObj.handle = null;
}

async function acquireLock(opfsObj: OpfsSlot, sessionId: number, filename: string, isPreload: boolean): Promise<boolean> {
  const now = nowMs();
  const timeout = isPreload ? PRELOAD_LOCK_TIMEOUT_MS : LOCK_TIMEOUT_MS;

  if (!isValidSessionId(sessionId)) {
    console.error(`[TransferWorker] Invalid sessionId type: ${typeof sessionId} (${sessionId})`);
    return false;
  }

  if (opfsObj.isLocked && opfsObj.name === filename) {
    if (sessionId === opfsObj.sessionId) {
      opfsObj.lockTime = now;
      return true;
    }
    if (sessionId < opfsObj.sessionId!) {
      console.warn(`[TransferWorker] Stale session ${sessionId} tried to renew lock held by ${opfsObj.sessionId}`);
      return false;
    }
    await cleanupHandle(opfsObj, `Preemption by session ${sessionId} (was ${opfsObj.sessionId})`);
  }

  if (opfsObj.isLocked && opfsObj.name !== filename) {
    const age = now - opfsObj.lockTime;
    if (sessionId >= opfsObj.sessionId!) {
      await cleanupHandle(opfsObj, `Preemption for new file by session ${sessionId}`);
    } else if (age < timeout) {
      return false;
    } else {
      await cleanupHandle(opfsObj, `Stale lock cleanup by session ${sessionId}`);
    }
  }

  opfsObj.sessionId = sessionId;
  opfsObj.name = filename;
  opfsObj.isLocked = true;
  opfsObj.lockTime = now;
  return true;
}

async function releaseLock(opfsObj: OpfsSlot): Promise<void> {
  const oldName = opfsObj.name;
  opfsObj.isLocked = false;
  opfsObj.sessionId = null;
  opfsObj.name = null;
  opfsObj.lockTime = 0;
  await cleanupHandle(opfsObj, `Manual release for ${oldName}`);
  opfsObj.writtenChunks = 0;
}

// ─── Message Handler ────────────────────────────────────────────

async function handleMessage(data: Record<string, unknown>): Promise<void> {
  const command = data.command as string | undefined;

  if (command === 'INIT_INSTANCE') {
    instanceId = (data.instanceId as string) || 'default';
    _lastMismatchKey = null;
    console.log(`[TransferWorker] Instance Initialized: ${instanceId}`);
    return;
  }

  if (command === 'OPFS_START') {
    const filename = data.filename as string;
    const isPreload = !!data.isPreload;
    const sessionId = data.sessionId as number;
    const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

    if (!filename) {
      safePost({ type: 'OPFS_ERROR', error: 'Missing filename', filename, isPreload, code: 'BAD_ARGS' });
      return;
    }

    if (!(await acquireLock(opfsObj, sessionId, filename, isPreload))) {
      safePost({ type: 'OPFS_ERROR', error: 'Lock Collision', filename, isPreload, code: 'LOCKED' });
      return;
    }

    opfsObj.chunkSize = normalizeChunkSize(data.size);
    opfsObj.writtenChunks = 0;

    try {
      await cleanupHandle(opfsObj, 'New start');
      const root = await navigator.storage.getDirectory();
      const safeName = buildSafeName(filename, isPreload);

      if (!data.keepExisting) {
        try { await root.removeEntry(safeName); } catch { /* file may not exist */ }
      }

      opfsObj.handle = await root.getFileHandle(safeName, { create: true });

      let opened = false;
      if (opfsObj.handle && typeof (opfsObj.handle as unknown as Record<string, unknown>).createSyncAccessHandle === 'function') {
        try {
          opfsObj.accessHandle = await (opfsObj.handle as unknown as { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }).createSyncAccessHandle();
          opfsObj.mode = 'sync';
          opened = true;
        } catch (e: unknown) {
          console.warn('[TransferWorker] createSyncAccessHandle failed, falling back:', (e as Error)?.message ?? e);
        }
      }

      if (!opened) {
        if (opfsObj.handle && typeof opfsObj.handle.createWritable === 'function') {
          opfsObj.writable = await opfsObj.handle.createWritable({ keepExistingData: !!data.keepExisting });
          opfsObj.mode = 'writable';
          opened = true;
        }
      }

      if (!opened) throw new Error('No supported OPFS write interface');

      safePost({ type: 'OPFS_STARTED', filename, isPreload, sessionId });
    } catch (e: unknown) {
      await releaseLock(opfsObj);
      safePost({ type: 'OPFS_ERROR', error: (e as Error)?.message ?? String(e), filename, isPreload, code: 'START_FAILED' });
    }
    return;
  }

  if (command === 'OPFS_WRITE') {
    const filename = data.filename as string;
    const isPreload = !!data.isPreload;
    const sessionId = data.sessionId as number;
    const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

    if (sessionId !== opfsObj.sessionId) {
      postSessionMismatch({
        type: 'SESSION_MISMATCH', command: 'OPFS_WRITE',
        expected: opfsObj.sessionId, received: sessionId, filename, isPreload,
      });
      return;
    }

    if (!filename || opfsObj.name !== filename) return;

    const index = normalizeIndex(data.index);
    if (index === null) {
      safePost({ type: 'OPFS_WRITE_ERROR', error: 'Invalid index', filename, chunk: data.index, isPreload });
      return;
    }

    const chunk = normalizeChunk(data.chunk);
    if (!chunk) {
      safePost({ type: 'OPFS_WRITE_ERROR', error: 'Invalid chunk', filename, chunk: index, isPreload });
      return;
    }

    try {
      const offset = index * opfsObj.chunkSize;
      if (opfsObj.mode === 'sync' && opfsObj.accessHandle) {
        opfsObj.accessHandle.write(chunk, { at: offset });
        opfsObj.writtenChunks++;
        opfsObj.lockTime = nowMs();
        if (opfsObj.writtenChunks % 100 === 0 && typeof opfsObj.accessHandle.flush === 'function') {
          await opfsObj.accessHandle.flush();
        }
      } else if (opfsObj.mode === 'writable' && opfsObj.writable) {
        await opfsObj.writable.write({ type: 'write', position: offset, data: chunk as unknown as BufferSource });
        opfsObj.writtenChunks++;
        opfsObj.lockTime = nowMs();
      }
    } catch (e: unknown) {
      safePost({ type: 'OPFS_WRITE_ERROR', error: (e as Error)?.message ?? String(e), filename, chunk: index, isPreload });
      try { await releaseLock(opfsObj); } catch { /* ignore */ }
    }
    return;
  }

  if (command === 'OPFS_END') {
    const filename = data.filename as string;
    const isPreload = !!data.isPreload;
    const sessionId = data.sessionId as number;
    const totalSize = data.totalSize as number | undefined;
    const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

    if (sessionId !== opfsObj.sessionId) {
      if (opfsObj.sessionId !== null) {
        postSessionMismatch({
          type: 'SESSION_MISMATCH', command: 'OPFS_END',
          expected: opfsObj.sessionId, received: sessionId, filename, isPreload,
        });
      }
      return;
    }

    try {
      if (opfsObj.mode === 'sync' && opfsObj.accessHandle) {
        if (typeof opfsObj.accessHandle.flush === 'function') await opfsObj.accessHandle.flush();
        if (totalSize) {
          const actualSize = await opfsObj.accessHandle.getSize();
          if (actualSize !== totalSize) {
            if (actualSize > totalSize && typeof opfsObj.accessHandle.truncate === 'function') {
              try {
                await opfsObj.accessHandle.truncate(totalSize);
                const resized = await opfsObj.accessHandle.getSize();
                if (resized !== totalSize) throw new Error(`Integrity Fail: ${resized}/${totalSize}`);
              } catch { throw new Error(`Integrity Fail: ${actualSize}/${totalSize}`); }
            } else {
              throw new Error(`Integrity Fail: ${actualSize}/${totalSize}`);
            }
          }
        }
      } else if (opfsObj.mode === 'writable' && opfsObj.writable) {
        await opfsObj.writable.close();
        opfsObj.writable = null;
        if (totalSize && opfsObj.handle) {
          const f = await opfsObj.handle.getFile();
          if (f.size !== totalSize) {
            if (f.size > totalSize) {
              const w = await opfsObj.handle.createWritable({ keepExistingData: true });
              await w.write({ type: 'truncate', size: totalSize });
              await w.close();
              const f2 = await opfsObj.handle.getFile();
              if (f2.size !== totalSize) throw new Error(`Integrity Fail: ${f2.size}/${totalSize}`);
            } else {
              throw new Error(`Integrity Fail: ${f.size}/${totalSize}`);
            }
          }
        }
      } else {
        throw new Error('No open handle for OPFS_END');
      }

      const sidSnapshot = opfsObj.sessionId;
      await releaseLock(opfsObj);
      safePost({ type: 'OPFS_FILE_READY', filename, isPreload, sessionId: sidSnapshot });
    } catch (e: unknown) {
      await releaseLock(opfsObj);
      safePost({ type: 'OPFS_ERROR', error: (e as Error)?.message ?? String(e), filename, isPreload, code: 'INTEGRITY_FAIL' });
    }
    return;
  }

  if (command === 'OPFS_RESET') {
    const isPreload = !!data.isPreload;
    await releaseLock(isPreload ? preloadFileOpfs : currentFileOpfs);
    safePost({ type: 'OPFS_RESET_COMPLETE', isPreload });
    return;
  }

  if (command === 'OPFS_CLEANUP') {
    const filename = data.filename as string;
    const isPreload = !!data.isPreload;
    const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

    if (!filename) {
      safePost({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload });
      return;
    }

    if (opfsObj.isLocked && opfsObj.name === filename) {
      safePost({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload, skipped: true });
      return;
    }

    const safeName = buildSafeName(filename, isPreload);
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(safeName);
    } catch { /* file may not exist */ }
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
      safePost({ type: 'OPFS_READ_ERROR', error: 'BAD_ARGS', filename, index: data.index, requestId });
      return;
    }

    const safeName = buildSafeName(filename, isPreload);

    try {
      const activeOpfs = isPreload ? preloadFileOpfs : currentFileOpfs;
      const chunkSize = activeOpfs.chunkSize || DEFAULT_CHUNK_SIZE;
      const offset = index * chunkSize;

      // Preferred: reuse existing SyncAccessHandle
      if (activeOpfs.isLocked && activeOpfs.name === filename && activeOpfs.mode === 'sync' && activeOpfs.accessHandle) {
        const buffer = new Uint8Array(chunkSize);
        const bytesRead = activeOpfs.accessHandle.read(buffer, { at: offset });
        const chunk = (bytesRead === chunkSize) ? buffer : buffer.slice(0, bytesRead);
        safePost({ type: 'OPFS_READ_COMPLETE', chunk, index, filename, requestId, sessionId }, [chunk.buffer]);
        return;
      }

      // Otherwise open fresh handle
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(safeName);

      if (fileHandle && typeof (fileHandle as unknown as Record<string, unknown>).createSyncAccessHandle === 'function') {
        let ah: FileSystemSyncAccessHandle | null = null;
        try {
          ah = await (fileHandle as unknown as { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }).createSyncAccessHandle();
        } catch (lockErr: unknown) {
          console.warn('[TransferWorker] SyncAccessHandle unavailable for read, using File fallback:', (lockErr as Error)?.message);
        }
        if (ah) {
          try {
            const buffer = new Uint8Array(chunkSize);
            const bytesRead = ah.read(buffer, { at: offset });
            const chunk = (bytesRead === chunkSize) ? buffer : buffer.slice(0, bytesRead);
            safePost({ type: 'OPFS_READ_COMPLETE', chunk, index, filename, requestId, sessionId }, [chunk.buffer]);
          } finally {
            try { await ah.close(); } catch { /* ignore */ }
          }
          return;
        }
      }

      // Fallback: async File slicing
      const file = await fileHandle.getFile();
      const slice = file.slice(offset, offset + chunkSize);
      const buf = await slice.arrayBuffer();
      const chunk = new Uint8Array(buf);
      safePost({ type: 'OPFS_READ_COMPLETE', chunk, index, filename, requestId, sessionId }, [chunk.buffer]);
    } catch (e: unknown) {
      safePost({ type: 'OPFS_READ_ERROR', error: (e as Error)?.message ?? String(e), filename, index, requestId });
    }
  }
}

// ─── Global Safety ──────────────────────────────────────────────

self.addEventListener('error', (e) => {
  safePost({
    type: 'WORKER_ERROR', scope: 'transfer', command: 'WORKER_ERROR',
    error: e?.message ?? 'Worker error',
  });
});

self.addEventListener('unhandledrejection', (e) => {
  const reason = e?.reason as Error | undefined;
  safePost({
    type: 'WORKER_ERROR', scope: 'transfer', command: 'UNHANDLED_REJECTION',
    error: reason?.message ?? String(reason),
  });
});

self.addEventListener('messageerror', () => {
  safePost({
    type: 'WORKER_ERROR', scope: 'transfer', command: 'MESSAGE_ERROR',
    error: 'Message deserialization failed',
  });
});
