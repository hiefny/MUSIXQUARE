// sync.worker.js - Timer & Heartbeat Background Tasks
const timers = {};

self.onmessage = function (e) {
    const data = e.data;
    const { command, id, interval } = data;

    if (command === 'START_TIMER') {
        if (timers[id]) clearInterval(timers[id]);
        timers[id] = setInterval(() => {
            self.postMessage({ type: 'TICK', id: id });
        }, interval);
        console.log(`[SyncWorker] Started timer: ${id} (${interval}ms)`);
    }
    else if (command === 'STOP_TIMER') {
        if (timers[id]) {
            clearInterval(timers[id]);
            delete timers[id];
            console.log(`[SyncWorker] Stopped timer: ${id}`);
        }
    }
    else if (command === 'INIT_INSTANCE') {
        // Kept for consistency if needed, though mostly used for OPFS filenames
        console.log(`[SyncWorker] Instance Initialized: ${data.instanceId}`);
    }
};
