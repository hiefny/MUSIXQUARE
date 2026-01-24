// worker.js
// Handles background timers to prevent browser throttling

const timers = {};

self.onmessage = function (e) {
    const { command, id, interval } = e.data;

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
};
