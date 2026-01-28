// worker.js - ROBUST VERSION
// Handles background timers and OPFS writes with enhanced locking & session safety

const timers = {};

// OPFS State with session-aware locking
let currentFileOpfs = {
    handle: null,
    accessHandle: null,
    name: null,
    chunkSize: 16384,
    writtenChunks: 0,
    sessionId: null,
    isLocked: false,
    lockTime: 0
};

let preloadFileOpfs = {
    handle: null,
    accessHandle: null,
    name: null,
    chunkSize: 16384,
    writtenChunks: 0,
    sessionId: null,
    isLocked: false,
    lockTime: 0
};

let isProcessing = false;
const messageQueue = [];
let instanceId = 'default';

// 🔧 Lock Lifecycle Constants
const LOCK_TIMEOUT_MS = 60000; // 60 seconds (Support for large files)
const PRELOAD_LOCK_TIMEOUT_MS = 20000; // 20 seconds for preloads (Safety margin)

self.onmessage = function (e) {
    messageQueue.push(e.data);
    processQueue();
};

async function processQueue() {
    if (isProcessing || messageQueue.length === 0) return;
    isProcessing = true;

    while (messageQueue.length > 0) {
        const data = messageQueue.shift();
        try {
            await handleMessage(data);
        } catch (err) {
            console.error("[Worker] Global Catch:", err);
            self.postMessage({
                type: 'WORKER_ERROR',
                error: err.message,
                command: data.command,
                stack: err.stack
            });
        }
    }

    isProcessing = false;
}

/**
 * 🔧 Centralized Lock Acquisition
 */
function acquireLock(opfsObj, sessionId, filename, isPreload) {
    const now = Date.now();
    const timeout = isPreload ? PRELOAD_LOCK_TIMEOUT_MS : LOCK_TIMEOUT_MS;

    // 🔧 [Strict Type Validation] Reject any non-integer or string "123"
    if (typeof sessionId !== 'number' || !Number.isInteger(sessionId)) {
        console.error(`[Worker] Invalid sessionId type/format: ${typeof sessionId} (${sessionId})`);
        return false;
    }

    // [Fix #2] Idempotency: If same filename, allow lock refresh (newer session takes over)
    if (opfsObj.isLocked && opfsObj.name === filename) {
        console.log(`[Worker] Lock Refresh: ${filename} (sid: ${opfsObj.sessionId} -> ${sessionId})`);
        opfsObj.sessionId = sessionId;
        opfsObj.lockTime = now;
        return true;
    }

    // Check if locked and NOT expired
    if (opfsObj.isLocked) {
        // [Optimization] If it's a NEWER session, allow preemption immediately
        if (sessionId > opfsObj.sessionId) {
            console.log(`[Worker] Preempting stale session ${opfsObj.sessionId} with newer session ${sessionId}`);
        } else if (now - opfsObj.lockTime < timeout) {
            return false;
        } else {
            console.warn(`[Worker] Lock timeout for ${opfsObj.name}. Force resetting.`);
        }
    }

    // [Safety] Save identity fields BEFORE setting lock flag
    opfsObj.sessionId = sessionId;
    opfsObj.name = filename;
    opfsObj.isLocked = true;
    opfsObj.lockTime = now;
    return true;
}

/**
 * 🔧 Centralized Resource Release
 */
async function releaseLock(opfsObj) {
    const oldName = opfsObj.name;
    // 1. [Critical] Release lock and clear identity SYNC to prevent race conditions
    opfsObj.isLocked = false;
    opfsObj.sessionId = null;
    opfsObj.name = null;
    opfsObj.lockTime = 0;

    // 2. Perform ASYNC cleanup (handles etc)
    await cleanupHandle(opfsObj, `Manual release for ${oldName}`);
    opfsObj.writtenChunks = 0;
}

/**
 * 🔧 Safe Handle Cleanup
 */
async function cleanupHandle(opfsObj, reason) {
    if (opfsObj.accessHandle) {
        console.log(`[Worker] Closing handle for ${opfsObj.name} (${reason})`);
        try {
            await opfsObj.accessHandle.flush();
            await opfsObj.accessHandle.close();
        } catch (e) {
            console.warn("[Worker] Handle Cleanup Warning:", e.message);
        } finally {
            opfsObj.accessHandle = null;
        }
    }
    opfsObj.handle = null;
}

async function handleMessage(data) {
    const { command, id, interval } = data;

    // --- Timer Commands ---
    if (command === 'START_TIMER') {
        if (timers[id]) clearInterval(timers[id]);
        timers[id] = setInterval(() => {
            self.postMessage({ type: 'TICK', id: id });
        }, interval);
        console.log(`[Worker] Started timer: ${id} (${interval}ms)`);
    }
    else if (command === 'STOP_TIMER') {
        if (timers[id]) {
            clearInterval(timers[id]);
            delete timers[id];
            console.log(`[Worker] Stopped timer: ${id}`);
        }
    }
    else if (command === 'INIT_INSTANCE') {
        instanceId = data.instanceId;
        console.log(`[Worker] Instance Initialized: ${instanceId}`);
    }

    // --- OPFS Commands ---
    else if (command === 'OPFS_START') {
        const { filename, isPreload, size, sessionId } = data;

        if (!sessionId) throw new Error('sessionId is required for OPFS_START');

        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        // Try to acquire lock
        if (!acquireLock(opfsObj, sessionId, filename, isPreload)) {
            console.error(`[Worker] Collision: ${filename} is locked.`);
            self.postMessage({
                type: 'OPFS_ERROR',
                error: 'Operation in progress (Lock)',
                filename,
                code: 'LOCKED'
            });
            return;
        }

        if (size) opfsObj.chunkSize = size;
        opfsObj.writtenChunks = 0;

        try {
            // Close old handles first
            await cleanupHandle(opfsObj, "New start");

            const root = await navigator.storage.getDirectory();
            const safeName = (isPreload ? "preload_" : "current_") +
                filename.replace(/[^a-z0-9._-]/gi, '_') + "_" + instanceId;

            if (!data.keepExisting) {
                try { await root.removeEntry(safeName); } catch (e) { }
            }

            opfsObj.handle = await root.getFileHandle(safeName, { create: true });
            opfsObj.accessHandle = await opfsObj.handle.createSyncAccessHandle();

            console.log(`[Worker] Ready: ${filename} (sid:${sessionId})`);
            self.postMessage({ type: 'OPFS_STARTED', filename, isPreload, sessionId });

        } catch (e) {
            console.error(`[Worker] START Error:`, e);
            await releaseLock(opfsObj);
            self.postMessage({
                type: 'OPFS_ERROR',
                error: e.message,
                filename,
                code: 'START_FAILED'
            });
        }
    }
    else if (command === 'OPFS_WRITE') {
        const { chunk, index, isPreload, filename, sessionId } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        // 🔧 [Fix #1] Enhanced Session ID validation with notification
        if (typeof sessionId !== 'number' || !Number.isInteger(sessionId) || sessionId !== opfsObj.sessionId) {
            console.warn(`[Worker] SID Mismatch (WRITE): ${filename} | Expected: ${opfsObj.sessionId}, Got: ${sessionId}`);
            self.postMessage({ type: 'SESSION_MISMATCH', command: 'OPFS_WRITE', expected: opfsObj.sessionId, received: sessionId, filename });
            return;
        }

        if (!opfsObj.accessHandle || opfsObj.name !== filename) {
            console.warn(`[Worker] Access Error: ${filename} (Active: ${opfsObj.name})`);
            return;
        }

        try {
            opfsObj.accessHandle.write(chunk, { at: index * opfsObj.chunkSize });
            opfsObj.writtenChunks++;

            // [Fix #6] Verify write order for early chunks
            if (index < 10 && opfsObj.writtenChunks !== index + 1) {
                console.warn(`[Worker] Out-of-order write: writtenChunks=${opfsObj.writtenChunks}, index=${index}`);
            }

            // Refresh lock time on active write
            opfsObj.lockTime = Date.now();

            // 🔧 [Performance/Safety] Batch flush every 100 chunks
            if (opfsObj.writtenChunks % 100 === 0) {
                await opfsObj.accessHandle.flush();
            }
        } catch (e) {
            console.error(`[Worker] WRITE Error:`, e);
            self.postMessage({
                type: 'OPFS_WRITE_ERROR',
                error: e.message,
                filename,
                chunk: index,
                isPreload
            });
        }
    }
    else if (command === 'OPFS_END') {
        const { filename, isPreload, sessionId, totalSize } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        // 🔧 [Fix #1] Enhanced Session ID validation with notification
        // Only warn if there's an active session (avoid noise from late messages after release)
        if (typeof sessionId !== 'number' || !Number.isInteger(sessionId) || sessionId !== opfsObj.sessionId) {
            if (opfsObj.sessionId !== null) {
                console.warn(`[Worker] SID Mismatch (END): ${filename} | Expected: ${opfsObj.sessionId}, Got: ${sessionId}`);
                self.postMessage({ type: 'SESSION_MISMATCH', command: 'OPFS_END', expected: opfsObj.sessionId, received: sessionId, filename });
            }
            // Silently ignore if already released (sessionId is null)
            return;
        }

        if (!opfsObj.accessHandle || opfsObj.name !== filename) {
            console.warn(`[Worker] END Access Error: ${filename}`);
            return;
        }

        try {
            await opfsObj.accessHandle.flush();

            if (totalSize) {
                const actualSize = await opfsObj.accessHandle.getSize();
                if (actualSize !== totalSize) {
                    throw new Error(`Integrity: expected ${totalSize}, got ${actualSize}`);
                }
            }

            // [Correct Exit Order] Capture Sid before release clears it
            const sidSnapshot = opfsObj.sessionId;
            await cleanupHandle(opfsObj, "Finalizing");

            self.postMessage({
                type: 'OPFS_FILE_READY',
                filename,
                isPreload,
                sessionId: sidSnapshot
            });

            // releaseLock will clear sessionId and name
            await releaseLock(opfsObj);
            console.log(`[Worker] End OK: ${filename}`);

        } catch (e) {
            console.error(`[Worker] END Error:`, e);
            await releaseLock(opfsObj);
            self.postMessage({
                type: 'OPFS_ERROR',
                error: e.message,
                filename,
                isPreload,
                code: 'INTEGRITY_FAIL'
            });
        }
    }
    else if (command === 'OPFS_RESET') {
        const { isPreload } = data;
        await releaseLock(isPreload ? preloadFileOpfs : currentFileOpfs);
        self.postMessage({ type: 'OPFS_RESET_COMPLETE', isPreload });
    }
    else if (command === 'OPFS_CLEANUP') {
        const { filename, isPreload } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        if (opfsObj.isLocked && opfsObj.name === filename) {
            self.postMessage({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload, skipped: true });
            return;
        }

        const safeName = (isPreload ? "preload_" : "current_") +
            filename.replace(/[^a-z0-9._-]/gi, '_') + "_" + instanceId;

        try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry(safeName);
        } catch (e) {
        } finally {
            self.postMessage({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload });
        }
    }
}
