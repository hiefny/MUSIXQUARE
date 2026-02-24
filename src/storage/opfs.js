// @ts-check
/**
 * MUSIXQUARE 2.0 - OPFS Storage Manager
 *
 * Origin Private File System을 통한 미디어 캐싱.
 * transfer.worker.js와의 통신을 캡슐화.
 *
 * Events emitted:
 *   bus.emit('opfs:ready', { filename, isPreload })
 *   bus.emit('opfs:error', { filename, error })
 *   bus.emit('opfs:progress', { filename, written, total })
 */

import { bus } from '../core/events.js';
import { log } from '../core/log.js';

let worker = null;
let instanceId = 'default';

/**
 * Initialize the transfer worker.
 * @param {string} [id] - Instance ID for OPFS file namespacing
 */
export function initWorker(id = 'default') {
  instanceId = id;

  if (worker) {
    worker.terminate();
  }

  worker = new Worker('js/transfer.worker.js');

  worker.onmessage = (e) => {
    const data = e.data;
    if (!data || !data.type) return;

    switch (data.type) {
      case 'OPFS_STARTED':
        log.debug('[OPFS] Started:', data.filename);
        break;

      case 'OPFS_FILE_READY':
        log.info('[OPFS] File ready:', data.filename);
        bus.emit('opfs:ready', { filename: data.filename, isPreload: data.isPreload, sessionId: data.sessionId });
        break;

      case 'OPFS_ERROR':
        log.error('[OPFS] Error:', data.filename, data.error);
        bus.emit('opfs:error', { filename: data.filename, error: data.error, code: data.code });
        break;

      case 'OPFS_READ_COMPLETE':
        bus.emit('opfs:read', data);
        break;

      case 'OPFS_READ_ERROR':
        bus.emit('opfs:read-error', data);
        break;

      case 'SESSION_MISMATCH':
        log.warn('[OPFS] Session mismatch:', data);
        break;

      case 'WORKER_ERROR':
        log.error('[OPFS] Worker error:', data.error);
        break;
    }
  };

  worker.onerror = (e) => {
    log.error('[OPFS] Worker crashed:', e.message);
  };

  _post({ command: 'INIT_INSTANCE', instanceId });
}

/**
 * Start writing a file to OPFS.
 * @param {{ filename: string, sessionId: number, chunkSize?: number, isPreload?: boolean }} opts
 */
export function startFile(opts) {
  _post({
    command: 'OPFS_START',
    filename: opts.filename,
    sessionId: opts.sessionId,
    size: opts.chunkSize || 16384,
    isPreload: !!opts.isPreload,
  });
}

/**
 * Write a chunk to the current OPFS file.
 * @param {{ filename: string, sessionId: number, index: number, chunk: Uint8Array, isPreload?: boolean }} opts
 */
export function writeChunk(opts) {
  _post({
    command: 'OPFS_WRITE',
    filename: opts.filename,
    sessionId: opts.sessionId,
    index: opts.index,
    chunk: opts.chunk,
    isPreload: !!opts.isPreload,
  });
}

/**
 * Finalize and verify a completed file.
 * @param {{ filename: string, sessionId: number, totalSize: number, isPreload?: boolean }} opts
 */
export function endFile(opts) {
  _post({
    command: 'OPFS_END',
    filename: opts.filename,
    sessionId: opts.sessionId,
    totalSize: opts.totalSize,
    isPreload: !!opts.isPreload,
  });
}

/**
 * Read a chunk from OPFS (for catch-up streaming).
 * @param {{ filename: string, sessionId: number, index: number, requestId?: string, isPreload?: boolean }} opts
 */
export function readChunk(opts) {
  _post({
    command: 'OPFS_READ',
    filename: opts.filename,
    sessionId: opts.sessionId,
    index: opts.index,
    requestId: opts.requestId,
    isPreload: !!opts.isPreload,
  });
}

/** Reset an OPFS slot. */
export function reset(isPreload = false) {
  _post({ command: 'OPFS_RESET', isPreload });
}

/** Cleanup a specific file from OPFS. */
export function cleanup(filename, isPreload = false) {
  _post({ command: 'OPFS_CLEANUP', filename, isPreload });
}

/** Terminate the worker. */
export function destroy() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

// ── Internal ──

function _post(msg) {
  if (!worker) {
    log.warn('[OPFS] Worker not initialized');
    return;
  }
  worker.postMessage(msg);
}
