// worker.js
// Handles background timers and OPFS writes to prevent UI throttling

const timers = {};
// OPFS State inside Worker (Optimization: Use SyncAccessHandle)
let currentFileOpfs = { handle: null, accessHandle: null, name: null, chunkSize: 16384 };
let preloadFileOpfs = { handle: null, accessHandle: null, name: null, chunkSize: 16384 };

let isProcessing = false;
const messageQueue = [];
let instanceId = 'default'; // Unique ID for this tab/worker session
let currentSessionId = null;
let preloadSessionId = null;

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
            console.error("[Worker] Message processing error:", err);
        }
    }

    isProcessing = false;
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
        console.log(`[Worker] Initialized with Instance ID: ${instanceId}`);
    }

    // --- OPFS Commands (Optimized with SyncAccessHandle) ---
    else if (command === 'OPFS_START') {
        const { filename, isPreload, size, sessionId } = data;
        const sid = sessionId || Date.now();

        if (isPreload) preloadSessionId = sid;
        else currentSessionId = sid;

        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;
        if (size) opfsObj.chunkSize = size;

        try {
            // Cleanup previous if same type
            if (opfsObj.accessHandle) {
                console.log(`[Worker] Closing existing handle for ${opfsObj.name}...`);
                try {
                    opfsObj.accessHandle.close();
                } catch (e) {
                    console.warn("[Worker] Error closing handle:", e);
                }
                opfsObj.accessHandle = null;
            }
            opfsObj.handle = null;

            const root = await navigator.storage.getDirectory();
            // [Fix] Append instanceId to prevent collisions across tabs logic
            const safeName = (isPreload ? "preload_" : "current_") + filename.replace(/[^a-z0-9._-]/gi, '_') + "_" + instanceId;

            // Delete existing file before start for fresh write unless keepExisting is true
            if (!data.keepExisting) {
                try {
                    await root.removeEntry(safeName);
                } catch (e) { }
            }

            opfsObj.handle = await root.getFileHandle(safeName, { create: true });

            // Use SyncAccessHandle for maximum performance (Worker only)
            console.log(`[Worker] Creating SyncAccessHandle for ${safeName}...`);
            opfsObj.accessHandle = await opfsObj.handle.createSyncAccessHandle();
            opfsObj.name = filename;

            console.log(`[Worker-Sync] Started ${isPreload ? 'preload' : 'current'} file: ${filename}`);
            self.postMessage({ type: 'OPFS_STARTED', filename, isPreload });
        } catch (e) {
            console.error(`[Worker-Sync] Start failed for ${filename}:`, e);
            self.postMessage({ type: 'OPFS_ERROR', error: e.message, filename });
        }
    }
    else if (command === 'OPFS_WRITE') {
        const { chunk, index, isPreload, filename, sessionId } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        // [Fix #1] Session ID Verification: Prevent data corruption from stale/zombie chunks
        const expectedSid = isPreload ? preloadSessionId : currentSessionId;
        if (sessionId && sessionId !== expectedSid) {
            console.warn(`[Worker] Session mismatch for ${filename}. Expected ${expectedSid}, got ${sessionId}. Ignoring chunk.`);
            return;
        }

        // [Security Fix] Race Condition Guard: Verify filename matches open handle
        if (opfsObj.accessHandle && opfsObj.name === filename) {
            try {
                // Synchronous write in worker!
                opfsObj.accessHandle.write(chunk, { at: index * opfsObj.chunkSize });
            } catch (e) {
                console.error(`[Worker-Sync] Write failed at ${index} for ${filename}:`, e);
            }
        } else if (opfsObj.accessHandle) {
            console.warn(`[Worker-Sync] Ignoring write for stale filename: ${filename} (Active: ${opfsObj.name})`);
        }
    }
    else if (command === 'OPFS_END') {
        const { filename, isPreload, sessionId } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        if (opfsObj.accessHandle && opfsObj.name === filename) {
            try {
                opfsObj.accessHandle.flush();
                opfsObj.accessHandle.close();
                opfsObj.accessHandle = null;

                console.log(`[Worker-Sync] Finished: ${filename}`);

                // Notify main thread
                self.postMessage({
                    type: 'OPFS_FILE_READY',
                    filename,
                    isPreload,
                    sessionId
                });
            } catch (e) {
                console.error(`[Worker-Sync] End failed for ${filename}:`, e);
            }
        }
    }
    else if (command === 'OPFS_RESET') {
        const { isPreload } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        try {
            if (opfsObj.accessHandle) {
                opfsObj.accessHandle.close();
                opfsObj.accessHandle = null;
            }
            opfsObj.handle = null;
            opfsObj.name = null;

            console.log(`[Worker] Reset ${isPreload ? 'preload' : 'current'} OPFS state`);
            self.postMessage({ type: 'OPFS_RESET_COMPLETE', isPreload });
        } catch (e) {
            console.error('[Worker] Reset failed:', e);
        }
    }
    else if (command === 'OPFS_CLEANUP') {
        const { filename, isPreload } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        // ✅ 사용 중인 파일은 정리하지 않음
        if (opfsObj.accessHandle && opfsObj.name === filename) {
            console.warn(`[Worker] Cannot cleanup ${filename} - still in use`);
            return;
        }

        const safeName = (isPreload ? "preload_" : "current_") + filename.replace(/[^a-z0-9._-]/gi, '_') + "_" + instanceId;

        try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry(safeName);
            console.log(`[Worker OPFS] Cleaned up: ${safeName}`);

            // [Fix #2] Notify main thread that cleanup is complete to prevent handle conflicts
            self.postMessage({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload });
        } catch (e) {
            console.warn(`[Worker OPFS] Cleanup failed for ${safeName}:`, e);
            self.postMessage({ type: 'OPFS_CLEANUP_COMPLETE', filename, isPreload }); // Always notify even if fails
        }
    }
}
