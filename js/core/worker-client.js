import { log } from './log.js';

/**
 * Session ID Normalization
 * - OPFS lock requires sessionId to be number & integer
 * - PeerJS/DOM may deliver as string, so always coerce to integer
 * - Returns 0 if invalid (0 = 'no-session' sentinel)
 */
const _warnedBadSessionIds = new Set();
export function validateSessionId(id, strict = false) {
    const n = Number(id);
    const sid = Number.isFinite(n) ? Math.trunc(n) : 0;

    const ok = Number.isSafeInteger(sid) && sid > 0;
    if (!ok) {
        const key = String(id);
        if (_warnedBadSessionIds.size > 200) _warnedBadSessionIds.clear();
        if (!_warnedBadSessionIds.has(key)) {
            _warnedBadSessionIds.add(key);
            log.warn(`[Session] Invalid sessionId (${typeof id}):`, id);
        }
        if (strict) throw new Error(`Invalid sessionId: ${id}`);
        return 0;
    }
    return sid;
}

/**
 * Centralized Worker Command Router
 * Routes commands to either SyncWorker (timers) or TransferWorker (OPFS)
 * based on command prefix.
 */
export function postWorkerCommand(payload, transfers) {
    if (!payload || !payload.command) return;

    const cmd = payload.command;

    // OPFS commands require filename + valid numeric sessionId
    if (cmd.startsWith('OPFS_') && cmd !== 'OPFS_RESET' && cmd !== 'OPFS_CLEANUP') {
        if (!payload.filename) log.warn(`[Worker] Missing filename in ${cmd}`);

        payload.sessionId = validateSessionId(payload.sessionId);

        const isCriticalOp = (cmd === 'OPFS_START' || cmd === 'OPFS_WRITE' || cmd === 'OPFS_END');
        if (isCriticalOp && !payload.sessionId) {
            log.error(`[Worker] Blocked ${cmd}: invalid sessionId`, payload);
            return;
        }
    }

    if (cmd.startsWith('OPFS_')) {
        const tw = window.transferWorker;
        if (tw && typeof tw.postMessage === 'function') {
            tw.postMessage(payload, transfers);
        } else {
            log.warn(`[Worker] TransferWorker not ready. Dropping command: ${cmd}`);
        }
    } else {
        const sw = window.syncWorker;
        if (sw && typeof sw.postMessage === 'function') {
            sw.postMessage(payload, transfers);
        } else {
            log.warn(`[Worker] SyncWorker not ready. Dropping command: ${cmd}`);
        }
    }
}
