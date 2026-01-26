// worker.js
// Handles background timers and OPFS writes to prevent UI throttling

const timers = {};
// OPFS State inside Worker (Optimization: Use SyncAccessHandle)
let currentFileOpfs = { handle: null, accessHandle: null, name: null, chunkSize: 16384 };
let preloadFileOpfs = { handle: null, accessHandle: null, name: null, chunkSize: 16384 };

self.onmessage = async function (e) {
    const data = e.data;
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

    // --- OPFS Commands (Optimized with SyncAccessHandle) ---
    else if (command === 'OPFS_START') {
        const { filename, isPreload, size } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;
        if (size) opfsObj.chunkSize = size;

        try {
            // Cleanup previous if same type
            if (opfsObj.accessHandle) {
                opfsObj.accessHandle.close();
                opfsObj.accessHandle = null;
            }
            if (opfsObj.handle) {
                opfsObj.handle = null; // ✅ 추가: handle 참조 해제
            }

            const root = await navigator.storage.getDirectory();
            const safeName = (isPreload ? "preload_" : "current_") + filename.replace(/[^a-z0-9._-]/gi, '_');

            // Delete existing file before start for fresh write unless keepExisting is true
            if (!data.keepExisting) {
                try {
                    await root.removeEntry(safeName);
                } catch (e) { }
            }

            opfsObj.handle = await root.getFileHandle(safeName, { create: true });

            // Use SyncAccessHandle for maximum performance (Worker only)
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
        const { chunk, index, isPreload } = data;
        const opfsObj = isPreload ? preloadFileOpfs : currentFileOpfs;

        if (opfsObj.accessHandle) {
            try {
                // CHUNK size is dynamic (default 16384)
                // Synchronous write in worker!
                opfsObj.accessHandle.write(chunk, { at: index * opfsObj.chunkSize });
                // Optional: Use flush() sparingly or only at END for maximum speed
                // opfsObj.accessHandle.flush(); 
            } catch (e) {
                console.error(`[Worker-Sync] Write failed at ${index}:`, e);
            }
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
            if (opfsObj.handle) {
                opfsObj.handle = null;
            }
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

        const safeName = (isPreload ? "preload_" : "current_") + filename.replace(/[^a-z0-9._-]/gi, '_');

        try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry(safeName);
            console.log(`[Worker OPFS] Cleaned up: ${safeName}`);
        } catch (e) {
            console.warn(`[Worker OPFS] Cleanup failed for ${safeName}:`, e);
        }
    }
};
