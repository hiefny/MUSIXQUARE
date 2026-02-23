import { log } from './log.js';
import { MSG, DELAY } from './constants.js';

const CHUNK_SIZE = 16384;

export const FileTransferManager = {
    CHUNK_SIZE,

    // Callbacks provided by app.js or other modules
    onProgress: null,
    onStatus: null,
    onToast: null,
    postWorkerCommand: null, // Callback to postWorkerCommand in worker-client
    validateSessionId: null,

    // Internal state
    activeBroadcastSession: null,
    opfsCatchupPumps: new Map(),
    localTransferSessionId: 0,

    async unicastFile(conn, file, startChunkIndex = 0, sessionId = null) {
        if (!conn || !conn.open) {
            log.error("[FileTransfer] Connection is not open");
            this._toast("연결 오류: 파일 전송 실패");
            return;
        }

        const effectiveSessionId = sessionId;
        const total = Math.ceil(file.size / CHUNK_SIZE);
        const isResume = startChunkIndex > 0;
        const msgType = isResume ? 'file-resume' : 'file-start';

        try {
            conn.send({
                type: msgType,
                name: file.name,
                mime: file.type,
                total: total,
                size: file.size,
                startChunk: startChunkIndex,
                sessionId: effectiveSessionId
            });
        } catch (e) {
            log.error(`[FileTransfer] Failed to send ${msgType}:`, e);
            return;
        }

        if (isResume) {
            this._toast(`Resuming transfer from ${startChunkIndex}...`);
        }

        await new Promise(r => setTimeout(r, 100));

        try {
            for (let i = startChunkIndex; i < total; i++) {
                // Connection Guard
                if (!conn.open) return;

                // Back-pressure
                while (conn.dataChannel && conn.dataChannel.bufferedAmount > 64 * 1024) {
                    await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
                }

                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                const chunkBlob = file.slice(start, end);
                const chunkBuf = await chunkBlob.arrayBuffer();
                const chunk = new Uint8Array(chunkBuf);

                conn.send({
                    type: MSG.FILE_CHUNK,
                    chunk: chunk,
                    index: i,
                    sessionId: effectiveSessionId,
                    total: total,
                    name: file.name
                });

                if (i % 50 === 0) {
                    await new Promise(r => setTimeout(r, DELAY.TICK));
                }
            }

            if (conn.open) {
                conn.send({ type: MSG.FILE_END, name: file.name, mime: file.type, sessionId: effectiveSessionId });
            }
        } catch (e) {
            log.error("[FileTransfer] Unicast error:", e);
        }
    },

    async broadcastFile(file, peers, sessionId, options = {}) {
        const total = Math.ceil(file.size / CHUNK_SIZE);
        const header = {
            type: MSG.FILE_START,
            name: file.name,
            mime: file.type,
            total: total,
            size: file.size,
            index: options.trackIndex,
            sessionId: sessionId
        };

        const eligiblePeers = peers.filter(p => p.conn && p.conn.open);
        if (eligiblePeers.length === 0) return;

        this.activeBroadcastSession = sessionId;

        // Initialize send queues for peers
        eligiblePeers.forEach(p => this._ensureSendQueue(p));

        // Send header
        eligiblePeers.forEach(p => {
            try { p.conn.send(header); } catch (e) { }
        });

        for (let i = 0; i < total; i++) {
            if (this.activeBroadcastSession !== sessionId) break;

            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunkBlob = file.slice(start, end);
            const chunkBuf = await chunkBlob.arrayBuffer();
            const chunk = new Uint8Array(chunkBuf);

            const chunkMsg = {
                type: MSG.FILE_CHUNK,
                chunk: chunk,
                index: i,
                sessionId: sessionId,
                total: total,
                name: file.name
            };

            eligiblePeers.forEach(p => {
                if (p.chunkQueue) p.chunkQueue.push(chunkMsg);
                this._processPeerQueue(p);
            });

            if (i % 10 === 0) {
                await new Promise(r => setTimeout(r, 0)); // Yield
            }
        }

        if (this.activeBroadcastSession === sessionId) {
            const endMsg = { type: MSG.FILE_END, name: file.name, mime: file.type, sessionId: sessionId };
            eligiblePeers.forEach(p => {
                if (p.chunkQueue) p.chunkQueue.push(endMsg);
                this._processPeerQueue(p);
            });
        }
    },

    _ensureSendQueue(p) {
        if (p.chunkQueue) return;
        p.chunkQueue = [];
        p.isSending = false;
    },

    async _processPeerQueue(p) {
        if (p.isSending || !p.chunkQueue || p.chunkQueue.length === 0) return;
        p.isSending = true;

        try {
            while (p.chunkQueue.length > 0) {
                if (!p.conn || !p.conn.open) {
                    p.chunkQueue = [];
                    break;
                }

                // Back-pressure
                while (p.conn.dataChannel && p.conn.dataChannel.bufferedAmount > 512 * 1024) {
                    await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
                }

                const msg = p.chunkQueue.shift();
                p.conn.send(msg);
            }
        } finally {
            p.isSending = false;
        }
    },

    // OPFS Catchup Pump Logic
    startOpfsCatchupStream(conn, { filename, sessionId, startIndex = 0, endIndexExclusive = 0, isPreload = false } = {}) {
        if (!conn || !conn.peer) return;
        const peerId = conn.peer;

        this.stopOpfsCatchupStream(peerId, 'restart');

        const sid = this.validateSessionId ? this.validateSessionId(sessionId) : sessionId;
        if (!sid) {
            log.warn(`[FileTransfer] Invalid sessionId for OPFS catchup: ...${peerId.slice(-4)}`);
            return;
        }

        const pump = {
            peerId,
            conn,
            filename,
            sessionId: sid,
            isPreload: !!isPreload,
            nextIndex: Math.max(0, startIndex | 0),
            endIndex: Math.max(0, endIndexExclusive | 0),
            awaiting: false,
            awaitingIndex: null,
            lastActivity: Date.now(),
            active: true,
            _timer: null
        };

        this.opfsCatchupPumps.set(peerId, pump);
        this._scheduleOpfsCatchupPump(pump, 0);
    },

    stopOpfsCatchupStream(peerId, reason = '') {
        const pump = this.opfsCatchupPumps.get(peerId);
        if (!pump) return;
        pump.active = false;
        if (pump._timer) {
            clearTimeout(pump._timer);
            pump._timer = null;
        }
        this.opfsCatchupPumps.delete(peerId);
        if (reason) log.debug(`[FileTransfer] Stop OPFS Catchup ...${String(peerId).slice(-4)}: ${reason}`);
    },

    _scheduleOpfsCatchupPump(pump, delayMs) {
        if (!pump || !pump.active) return;
        if (pump._timer) clearTimeout(pump._timer);
        pump._timer = setTimeout(() => this._runOpfsCatchupPump(pump), Math.max(0, delayMs | 0));
    },

    _runOpfsCatchupPump(pump) {
        if (!pump || !pump.active) return;

        const conn = pump.conn;
        if (!conn || !conn.open) {
            this.stopOpfsCatchupStream(pump.peerId, 'peer closed');
            return;
        }

        if (pump.sessionId && pump.sessionId < this.localTransferSessionId) {
            this.stopOpfsCatchupStream(pump.peerId, 'session advanced');
            return;
        }

        if (!pump.filename || pump.nextIndex >= pump.endIndex) {
            this.stopOpfsCatchupStream(pump.peerId, 'complete');
            return;
        }

        if (pump.awaiting) {
            const stuckMs = Date.now() - pump.lastActivity;
            if (stuckMs > 6000 && pump.awaitingIndex !== null) {
                pump.awaiting = false;
                pump.nextIndex = pump.awaitingIndex;
                pump.awaitingIndex = null;
            }
            this._scheduleOpfsCatchupPump(pump, DELAY.BACKPRESSURE);
            return;
        }

        const bufAmt = conn.dataChannel ? conn.dataChannel.bufferedAmount : 0;
        if (bufAmt > 256 * 1024) {
            this._scheduleOpfsCatchupPump(pump, DELAY.BACKPRESSURE);
            return;
        }

        const idx = pump.nextIndex;
        pump.nextIndex++;
        pump.awaiting = true;
        pump.awaitingIndex = idx;
        pump.lastActivity = Date.now();

        if (this.postWorkerCommand) {
            this.postWorkerCommand({
                command: 'OPFS_READ',
                filename: pump.filename,
                index: idx,
                isPreload: pump.isPreload,
                sessionId: pump.sessionId,
                requestId: `${pump.peerId}|catchup`
            });
        }
    },

    onOpfsReadComplete(peerId, sessionId, requestTag) {
        const pump = this.opfsCatchupPumps.get(peerId);
        if (!pump || !pump.active) return;
        if (requestTag !== 'catchup') return;

        // Session mismatch guard: stale OPFS response from a previous session
        if (sessionId && pump.sessionId && sessionId !== pump.sessionId) {
            this.stopOpfsCatchupStream(peerId, 'session mismatch');
            return;
        }

        pump.awaiting = false;
        pump.awaitingIndex = null;
        pump.lastActivity = Date.now();
        this._scheduleOpfsCatchupPump(pump, 0);
    },

    _toast(msg) {
        if (this.onToast) this.onToast(msg);
    }
};
