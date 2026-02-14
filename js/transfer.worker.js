// transfer.worker.js - File & OPFS Storage with session-aware locking (Improved)
// Handles heavy file I/O operations including preloading.
//
// Goals of this improvement:
// - Keep protocol backward-compatible with existing app.js
// - Reduce queue overhead (no Array.shift O(n) on large transfers)
// - Stronger input validation (index/chunk/session)
// - Optional fallback when createSyncAccessHandle is unavailable
// - Safer cleanup (supports both SyncAccessHandle and WritableFileStream)
// - Reduce SESSION_MISMATCH spam (dedupe)

'use strict';

// -----------------------------
// OPFS State (per slot)
// -----------------------------
const DEFAULT_CHUNK_SIZE = 16384;

function createOpfsSlot() {
  return {
    handle: null,
    accessHandle: null,   // FileSystemSyncAccessHandle (preferred)
    writable: null,       // FileSystemWritableFileStream (fallback)
    mode: null,           // 'sync' | 'writable' | null

    name: null,
    chunkSize: DEFAULT_CHUNK_SIZE,
    writtenChunks: 0,

    sessionId: null,
    isLocked: false,
    lockTime: 0
  };
}

let currentFileOpfs = createOpfsSlot();
let preloadFileOpfs = createOpfsSlot();

let instanceId = 'default';

// -----------------------------
// Queue (fast)
// -----------------------------
let isProcessing = false;
const messageQueue = [];
let queueIndex = 0;

self.onmessage = function (e) {
  messageQueue.push(e.data);
  // Don't await here; just kick the processor.
  if (!isProcessing) processQueue();
};

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (queueIndex < messageQueue.length) {
      const data = messageQueue[queueIndex++];
      try {
        await handleMessage(data);
      } catch (err) {
        console.error('[TransferWorker] Message error:', err);
        safePost({
          type: 'WORKER_ERROR',
          scope: 'transfer',
          error: err && err.message ? err.message : String(err),
          command: data && data.command ? data.command : undefined,
          stack: err && err.stack ? err.stack : undefined
        });
      }
    }
  } finally {
    // Compact the queue
    messageQueue.length = 0;
    queueIndex = 0;
    isProcessing = false;
  }
}

function safePost(msg, transfers) {
  try {
    if (transfers) self.postMessage(msg, transfers);
    else self.postMessage(msg);
  } catch (e) {
    // If posting fails (rare), last resort console.
    console.error('[TransferWorker] postMessage failed:', e);
  }
}

// -----------------------------
// Lock Lifecycle Constants
// -----------------------------
const LOCK_TIMEOUT_MS = 60000;         // 60s for main transfers
const PRELOAD_LOCK_TIMEOUT_MS = 20000; // 20s for preloads

function nowMs() { return Date.now(); }

function isValidSessionId(sessionId) {
  return (typeof sessionId === 'number' && Number.isInteger(sessionId));
}

/**
 * Centralized Lock Acquisition
 * - Keeps existing "newer session can preempt" behavior (needed for churn recovery)
 * - Rejects only when another session is actively locked and still fresh.
 */
function acquireLock(opfsObj, sessionId, filename, isPreload) {
  const now = nowMs();
  const timeout = isPreload ? PRELOAD_LOCK_TIMEOUT_MS : LOCK_TIMEOUT_MS;

  if (!isValidSessionId(sessionId)) {
    console.error(`[TransferWorker] Invalid sessionId type: ${typeof sessionId} (${sessionId})`);
    return false;
  }

  // If already locked on same filename, treat as renewal.
  if (opfsObj.isLocked && opfsObj.name === filename) {
    opfsObj.sessionId = sessionId;
    opfsObj.lockTime = now;
    return true;
  }

  if (opfsObj.isLocked) {
    const age = now - opfsObj.lockTime;

    // If lock is fresh and current session is newer? Allow preempt (original behavior)
    if (sessionId >= opfsObj.sessionId) {
      // Permit preemption even when fresh to avoid deadlocks on fast session churn.
      // Old session messages will be rejected by SESSION_MISMATCH guards.
    } else if (age < timeout) {
      // Older session cannot steal a fresh lock.
      return false;
    }
  }

  opfsObj.sessionId = sessionId;
  opfsObj.name = filename;
  opfsObj.isLocked = true;
  opfsObj.lockTime = now;
  return true;
}

async function releaseLock(opfsObj) {
  const oldName = opfsObj.name;
  opfsObj.isLocked = false;
  opfsObj.sessionId = null;
  opfsObj.name = null;
  opfsObj.lockTime = 0;

  await cleanupHandle(opfsObj, `Manual release for ${oldName}`);
  opfsObj.writtenChunks = 0;
}

async function cleanupHandle(opfsObj, reason) {
  // Close SyncAccessHandle if present
  if (opfsObj.accessHandle) {
    console.log(`[TransferWorker] Closing sync handle for ${opfsObj.name} (${reason})`);
    try {
      // flush/close may throw if already closed; ignore.
      if (typeof opfsObj.accessHandle.flush === 'function') {
        await opfsObj.accessHandle.flush();
      }
      if (typeof opfsObj.accessHandle.close === 'function') {
        await opfsObj.accessHandle.close();
      }
    } catch (e) {
      console.warn('[TransferWorker] Sync handle cleanup warning:', e && e.message ? e.message : e);
    } finally {
      opfsObj.accessHandle = null;
    }
  }

  // Close Writable stream fallback if present
  if (opfsObj.writable) {
    console.log(`[TransferWorker] Closing writable stream for ${opfsObj.name} (${reason})`);
    try {
      if (typeof opfsObj.writable.close === 'function') {
        await opfsObj.writable.close();
      }
    } catch (e) {
      console.warn('[TransferWorker] Writable cleanup warning:', e && e.message ? e.message : e);
      try {
        // Some implementations support abort()
        if (typeof opfsObj.writable.abort === 'function') {
          await opfsObj.writable.abort();
        }
      } catch (_) {
        // ignore
      }
    } finally {
      opfsObj.writable = null;
    }
  }

  opfsObj.mode = null;
  opfsObj.handle = null;
}

function sanitizeFilename(filename) {
  // Must match main thread safeName generation.
  return String(filename || '').replace(/[^a-z0-9._-]/gi, '_');
}

function buildSafeName(filename, isPreload) {
  return (isPreload ? 'preload_' : 'current_') + sanitizeFilename(filename) + '_' + instanceId;
}

function normalizeChunkSize(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK_SIZE;
  // Clamp to something reasonable. (CHUNK_SIZE is expected to be 16384)
  return Math.max(256, Math.floor(n));
}

function normalizeIndex(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function normalizeChunk(chunk) {
  // Accept Uint8Array / ArrayBuffer / ArrayBufferView
  if (!chunk) return null;
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk) && chunk.buffer) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return null;
}

// Dedupe session mismatch spam
let _lastMismatchKey = null;
function postSessionMismatch(payload) {
  const key = `${payload.command}|${payload.expected}|${payload.received}|${payload.filename}`;
  if (key === _lastMismatchKey) return;
  _lastMismatchKey = key;
  safePost(payload);
}

async function handleMessage(data) {
  const command = data && data.command;

  if (command === 'INIT_INSTANCE') {
    instanceId = data.instanceId || 'default';
    console.log(`[TransferWorker] Instance Initialized: ${instanceId}`);
    return;
  }

  // -----------------------------
  // OPFS Commands
  // -----------------------------
  if (command === 'OPFS_START') {
    const filename = data.filename;
    const isPreload = !!data.isPreload;
    const sessionId = data.sessionId;
    const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

    if (!filename) {
      safePost({ type: 'OPFS_ERROR', error: 'Missing filename', filename, isPreload, code: 'BAD_ARGS' });
      return;
    }

    if (!acquireLock(opfsObj, sessionId, filename, isPreload)) {
      safePost({ type: 'OPFS_ERROR', error: 'Lock Collision', filename, isPreload, code: 'LOCKED' });
      return;
    }

    opfsObj.chunkSize = normalizeChunkSize(data.size);
    opfsObj.writtenChunks = 0;

    try {
      // Close any existing handles before starting.
      await cleanupHandle(opfsObj, 'New start');

      const root = await navigator.storage.getDirectory();
      const safeName = buildSafeName(filename, isPreload);

      if (!data.keepExisting) {
        try { await root.removeEntry(safeName); } catch (_) { /* file may not exist */ }
      }

      opfsObj.handle = await root.getFileHandle(safeName, { create: true });

      // Preferred: SyncAccessHandle
      let opened = false;
      if (opfsObj.handle && typeof opfsObj.handle.createSyncAccessHandle === 'function') {
        try {
          opfsObj.accessHandle = await opfsObj.handle.createSyncAccessHandle();
          opfsObj.mode = 'sync';
          opened = true;
        } catch (e) {
          // Fall through to writable
          console.warn('[TransferWorker] createSyncAccessHandle failed, falling back to createWritable:', e && e.message ? e.message : e);
        }
      }

      if (!opened) {
        if (opfsObj.handle && typeof opfsObj.handle.createWritable === 'function') {
          opfsObj.writable = await opfsObj.handle.createWritable({ keepExistingData: !!data.keepExisting });
          opfsObj.mode = 'writable';
          opened = true;
        }
      }

      if (!opened) {
        throw new Error('No supported OPFS write interface (createSyncAccessHandle/createWritable missing)');
      }

      safePost({ type: 'OPFS_STARTED', filename, isPreload, sessionId });
    } catch (e) {
      await releaseLock(opfsObj);
      safePost({ type: 'OPFS_ERROR', error: e && e.message ? e.message : String(e), filename, isPreload, code: 'START_FAILED' });
    }

    return;
  }

  if (command === 'OPFS_WRITE') {
    const filename = data.filename;
    const isPreload = !!data.isPreload;
    const sessionId = data.sessionId;
    const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

    if (sessionId !== opfsObj.sessionId) {
      // Notify once per unique mismatch to avoid floods
      postSessionMismatch({
        type: 'SESSION_MISMATCH',
        command: 'OPFS_WRITE',
        expected: opfsObj.sessionId,
        received: sessionId,
        filename
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

        // Periodic flush for safety (especially large files)
        if (opfsObj.writtenChunks % 100 === 0 && typeof opfsObj.accessHandle.flush === 'function') {
          await opfsObj.accessHandle.flush();
        }
      } else if (opfsObj.mode === 'writable' && opfsObj.writable) {
        // Random-position write using WriteParams
        await opfsObj.writable.write({ type: 'write', position: offset, data: chunk });
        opfsObj.writtenChunks++;
        opfsObj.lockTime = nowMs();
      } else {
        // No open handle; ignore (caller should restart)
        return;
      }
    } catch (e) {
      safePost({ type: 'OPFS_WRITE_ERROR', error: e && e.message ? e.message : String(e), filename, chunk: index, isPreload });
    }

    return;
  }

  if (command === 'OPFS_END') {
    const filename = data.filename;
    const isPreload = !!data.isPreload;
    const sessionId = data.sessionId;
    const totalSize = data.totalSize;
    const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

    if (sessionId !== opfsObj.sessionId) {
      if (opfsObj.sessionId !== null) {
        postSessionMismatch({
          type: 'SESSION_MISMATCH',
          command: 'OPFS_END',
          expected: opfsObj.sessionId,
          received: sessionId,
          filename
        });
      }
      return;
    }

    try {
      // Ensure data is committed
      if (opfsObj.mode === 'sync' && opfsObj.accessHandle) {
        if (typeof opfsObj.accessHandle.flush === 'function') {
          await opfsObj.accessHandle.flush();
        }

        // Integrity check
        if (totalSize) {
          const actualSize = await opfsObj.accessHandle.getSize();
          if (actualSize !== totalSize) {
            // If file is too large, try truncating down (salvage)
            if (actualSize > totalSize && typeof opfsObj.accessHandle.truncate === 'function') {
              try {
                await opfsObj.accessHandle.truncate(totalSize);
                const resized = await opfsObj.accessHandle.getSize();
                if (resized !== totalSize) {
                  throw new Error(`Integrity Fail: ${resized}/${totalSize}`);
                }
              } catch (_) {
                throw new Error(`Integrity Fail: ${actualSize}/${totalSize}`);
              }
            } else {
              throw new Error(`Integrity Fail: ${actualSize}/${totalSize}`);
            }
          }
        }

      } else if (opfsObj.mode === 'writable' && opfsObj.writable) {
        // Close stream first, then verify size using getFile()
        await opfsObj.writable.close();
        opfsObj.writable = null;

        if (totalSize && opfsObj.handle) {
          const f = await opfsObj.handle.getFile();
          const actualSize = f.size;
          if (actualSize !== totalSize) {
            if (actualSize > totalSize) {
              // Salvage by truncating down
              const w = await opfsObj.handle.createWritable({ keepExistingData: true });
              await w.write({ type: 'truncate', size: totalSize });
              await w.close();
              const f2 = await opfsObj.handle.getFile();
              if (f2.size !== totalSize) {
                throw new Error(`Integrity Fail: ${f2.size}/${totalSize}`);
              }
            } else {
              throw new Error(`Integrity Fail: ${actualSize}/${totalSize}`);
            }
          }
        }

      } else {
        throw new Error('No open handle for OPFS_END');
      }

      const sidSnapshot = opfsObj.sessionId;

      await cleanupHandle(opfsObj, 'Finalizing');
      safePost({ type: 'OPFS_FILE_READY', filename, isPreload, sessionId: sidSnapshot });
      await releaseLock(opfsObj);

    } catch (e) {
      await releaseLock(opfsObj);
      safePost({ type: 'OPFS_ERROR', error: e && e.message ? e.message : String(e), filename, isPreload, code: 'INTEGRITY_FAIL' });
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
    const filename = data.filename;
    const isPreload = !!data.isPreload;
    const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

    if (!filename) {
      safePost({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload });
      return;
    }

    // If currently locked on the same file, skip physical deletion.
    if (opfsObj.isLocked && opfsObj.name === filename) {
      safePost({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload, skipped: true });
      return;
    }

    const safeName = buildSafeName(filename, isPreload);
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(safeName);
    } catch (_) {
      // file may not exist
    } finally {
      safePost({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload });
    }

    return;
  }

  if (command === 'OPFS_READ') {
    const filename = data.filename;
    const isPreload = !!data.isPreload;
    const sessionId = data.sessionId;
    const requestId = data.requestId;

    const index = normalizeIndex(data.index);
    if (!filename || index === null) {
      safePost({ type: 'OPFS_READ_ERROR', error: 'BAD_ARGS', filename, index: data.index, requestId });
      return;
    }

    const safeName = buildSafeName(filename, isPreload);

    try {
      // Reuse existing handle if this file is currently open for writing.
      const activeOpfs = isPreload ? preloadFileOpfs : currentFileOpfs;
      const chunkSize = activeOpfs.chunkSize || DEFAULT_CHUNK_SIZE;
      const offset = index * chunkSize;

      // Preferred path: SyncAccessHandle read
      if (activeOpfs.isLocked && activeOpfs.name === filename && activeOpfs.mode === 'sync' && activeOpfs.accessHandle) {
        const buffer = new Uint8Array(chunkSize);
        const bytesRead = activeOpfs.accessHandle.read(buffer, { at: offset });
        const chunk = (bytesRead === chunkSize) ? buffer : buffer.slice(0, bytesRead);

        safePost({
          type: 'OPFS_READ_COMPLETE',
          chunk,
          index,
          filename,
          requestId,
          sessionId
        }, [chunk.buffer]);
        return;
      }

      // Otherwise open file handle and read.
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(safeName);

      if (fileHandle && typeof fileHandle.createSyncAccessHandle === 'function') {
        // Use a temporary sync handle if available
        const ah = await fileHandle.createSyncAccessHandle();
        try {
          const buffer = new Uint8Array(chunkSize);
          const bytesRead = ah.read(buffer, { at: offset });
          const chunk = (bytesRead === chunkSize) ? buffer : buffer.slice(0, bytesRead);

          safePost({
            type: 'OPFS_READ_COMPLETE',
            chunk,
            index,
            filename,
            requestId,
            sessionId
          }, [chunk.buffer]);
        } finally {
          try { await ah.close(); } catch (_) { /* ignore */ }
        }
        return;
      }

      // Fallback: async File slicing
      const file = await fileHandle.getFile();
      const slice = file.slice(offset, offset + chunkSize);
      const buf = await slice.arrayBuffer();
      const chunk = new Uint8Array(buf);

      safePost({
        type: 'OPFS_READ_COMPLETE',
        chunk,
        index,
        filename,
        requestId,
        sessionId
      }, [chunk.buffer]);

    } catch (e) {
      safePost({ type: 'OPFS_READ_ERROR', error: e && e.message ? e.message : String(e), filename, index, requestId });
    }

    return;
  }

  // Unknown commands are ignored for forward compatibility.
}

// Defensive error reporting (won't break app.js if unhandled)
self.addEventListener('unhandledrejection', (event) => {
  safePost({
    type: 'WORKER_ERROR',
    scope: 'transfer',
    error: event && event.reason && event.reason.message ? event.reason.message : String(event.reason),
    command: 'unhandledrejection'
  });
});


// Global safety: surface unexpected worker errors without crashing.
self.addEventListener('error', (e) => {
  safePost({
    type: 'WORKER_ERROR',
    scope: 'transfer',
    command: 'WORKER_ERROR',
    error: (e && e.message) ? e.message : 'Worker error'
  });
});

self.addEventListener('unhandledrejection', (e) => {
  const reason = e && e.reason;
  safePost({
    type: 'WORKER_ERROR',
    scope: 'transfer',
    command: 'UNHANDLED_REJECTION',
    error: reason && reason.message ? reason.message : String(reason)
  });
});

self.addEventListener('messageerror', () => {
  safePost({
    type: 'WORKER_ERROR',
    scope: 'transfer',
    command: 'MESSAGE_ERROR',
    error: 'Message deserialization failed'
  });
});
