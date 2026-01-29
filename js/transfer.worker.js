// transfer.worker.js - File & OPFS Storage with session-aware locking
// Handles all heavy file I/O operations including preloading.

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
            console.error("[TransferWorker] Global Catch:", err);
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

    if (typeof sessionId !== 'number' || !Number.isInteger(sessionId)) {
        console.error(`[TransferWorker] Invalid sessionId type: ${typeof sessionId} (${sessionId})`);
        return false;
    }

    if (opfsObj.isLocked && opfsObj.name === filename) {
        opfsObj.sessionId = sessionId;
        opfsObj.lockTime = now;
        return true;
    }

    if (opfsObj.isLocked) {
        if (sessionId > opfsObj.sessionId) {
            console.log(`[TransferWorker] Preempting session ${opfsObj.sessionId} with ${sessionId}`);
        } else if (now - opfsObj.lockTime < timeout) {
            return false;
        }
    }

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
    opfsObj.isLocked = false;
    opfsObj.sessionId = null;
    opfsObj.name = null;
    opfsObj.lockTime = 0;

    await cleanupHandle(opfsObj, `Manual release for ${oldName}`);
    opfsObj.writtenChunks = 0;
}

/**
 * 🔧 Safe Handle Cleanup
 */
async function cleanupHandle(opfsObj, reason) {
    if (opfsObj.accessHandle) {
        console.log(`[TransferWorker] Closing handle for ${opfsObj.name} (${reason})`);
        try {
            await opfsObj.accessHandle.flush();
            await opfsObj.accessHandle.close();
        } catch (e) {
            console.warn("[TransferWorker] Handle Cleanup Warning:", e.message);
        } finally {
            opfsObj.accessHandle = null;
        }
    }
    opfsObj.handle = null;
}

async function handleMessage(data) {
    const { command } = data;

    if (command === 'INIT_INSTANCE') {
        instanceId = data.instanceId;
        console.log(`[TransferWorker] Instance Initialized: ${instanceId}`);
    }
    // --- OPFS Commands ---
    else if (command === 'OPFS_START') {
        const { filename, isPreload, size, sessionId } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        if (!acquireLock(opfsObj, sessionId, filename, isPreload)) {
            self.postMessage({ type: 'OPFS_ERROR', error: 'Lock Collision', filename, code: 'LOCKED' });
            return;
        }

        if (size) opfsObj.chunkSize = size;
        opfsObj.writtenChunks = 0;

        try {
            await cleanupHandle(opfsObj, "New start");
            const root = await navigator.storage.getDirectory();
            const safeName = (isPreload ? "preload_" : "current_") +
                filename.replace(/[^a-z0-9._-]/gi, '_') + "_" + instanceId;

            if (!data.keepExisting) {
                try { await root.removeEntry(safeName); } catch (e) { }
            }

            opfsObj.handle = await root.getFileHandle(safeName, { create: true });
            opfsObj.accessHandle = await opfsObj.handle.createSyncAccessHandle();
            self.postMessage({ type: 'OPFS_STARTED', filename, isPreload, sessionId });

        } catch (e) {
            await releaseLock(opfsObj);
            self.postMessage({ type: 'OPFS_ERROR', error: e.message, filename, code: 'START_FAILED' });
        }
    }
    else if (command === 'OPFS_WRITE') {
        const { chunk, index, isPreload, filename, sessionId } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        if (sessionId !== opfsObj.sessionId) {
            self.postMessage({ type: 'SESSION_MISMATCH', command: 'OPFS_WRITE', expected: opfsObj.sessionId, received: sessionId, filename });
            return;
        }

        if (!opfsObj.accessHandle || opfsObj.name !== filename) return;

        try {
            opfsObj.accessHandle.write(chunk, { at: index * opfsObj.chunkSize });
            opfsObj.writtenChunks++;
            opfsObj.lockTime = Date.now();
            if (opfsObj.writtenChunks % 100 === 0) await opfsObj.accessHandle.flush();
        } catch (e) {
            self.postMessage({ type: 'OPFS_WRITE_ERROR', error: e.message, filename, chunk: index, isPreload });
        }
    }
    else if (command === 'OPFS_END') {
        const { filename, isPreload, sessionId, totalSize } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        if (sessionId !== opfsObj.sessionId) {
            if (opfsObj.sessionId !== null) {
                self.postMessage({ type: 'SESSION_MISMATCH', command: 'OPFS_END', expected: opfsObj.sessionId, received: sessionId, filename });
            }
            return;
        }

        try {
            await opfsObj.accessHandle.flush();
            if (totalSize) {
                const actualSize = await opfsObj.accessHandle.getSize();
                if (actualSize !== totalSize) throw new Error(`Integrity Fail: ${actualSize}/${totalSize}`);
            }

            const sidSnapshot = opfsObj.sessionId;
            await cleanupHandle(opfsObj, "Finalizing");
            self.postMessage({ type: 'OPFS_FILE_READY', filename, isPreload, sessionId: sidSnapshot });
            await releaseLock(opfsObj);
        } catch (e) {
            await releaseLock(opfsObj);
            self.postMessage({ type: 'OPFS_ERROR', error: e.message, filename, isPreload, code: 'INTEGRITY_FAIL' });
        }
    }
    else if (command === 'OPFS_RESET') {
        await releaseLock(data.isPreload ? preloadFileOpfs : currentFileOpfs);
        self.postMessage({ type: 'OPFS_RESET_COMPLETE', isPreload: data.isPreload });
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
        } catch (e) { } finally {
            self.postMessage({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload });
        }
    }
    else if (command === 'OPFS_READ') {
        const { filename, index, isPreload, sessionId, requestId } = data;
        const safeName = (isPreload ? "preload_" : "current_") +
            filename.replace(/[^a-z0-9._-]/gi, '_') + "_" + instanceId;

        try {
            // [FIX] Reuse existing Handle if already open for writing (Prevents Lock Collision)
            const activeOpfs = isPreload ? preloadFileOpfs : currentFileOpfs;
            let accessHandle = null;
            let shouldClose = false;

            if (activeOpfs.isLocked && activeOpfs.name === filename && activeOpfs.accessHandle) {
                accessHandle = activeOpfs.accessHandle;
                // console.log(`[TransferWorker] Reusing active handle for READ: ${filename}`);
            } else {
                // Not open, create temp handle
                const root = await navigator.storage.getDirectory();
                const fileHandle = await root.getFileHandle(safeName);
                accessHandle = await fileHandle.createSyncAccessHandle();
                shouldClose = true;
            }

            const chunkSize = activeOpfs.chunkSize || 16384;
            const buffer = new Uint8Array(chunkSize);
            const bytesRead = accessHandle.read(buffer, { at: index * chunkSize });

            const chunk = bytesRead === chunkSize ? buffer : buffer.slice(0, bytesRead);

            self.postMessage({
                type: 'OPFS_READ_COMPLETE',
                chunk: chunk,
                index,
                filename,
                requestId,
                sessionId
            }, [chunk.buffer]);

            if (shouldClose) {
                await accessHandle.close();
            }
        } catch (e) {
            self.postMessage({ type: 'OPFS_READ_ERROR', error: e.message, filename, index, requestId });
        }
    }
}
