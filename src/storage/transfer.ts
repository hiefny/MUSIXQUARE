/**
 * MUSIXQUARE — File Transfer (Facade)
 *
 * Re-exports send/receive APIs and registers protocol handlers.
 * Sub-modules: transfer-send.ts (send), transfer-receive.ts (receive),
 * transfer-shared.ts (shared helpers).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG, TRANSFER_STATE } from '../core/constants.ts';
import { registerHandlers } from '../network/protocol.ts';
import {
  handleFilePrepare,
  handleFileStart,
  handleFileResume,
  handleFileChunk,
  handleFileEnd,
  handleFileWait,
  clearReceiveState,
} from './transfer-receive.ts';

// ─── Re-exports ──────────────────────────────────────────────────────

export { broadcastFile, unicastFile, cancelOutgoingFileTransfers } from './transfer-send.ts';
export { cancelIncomingFileTransfer, fetchDemoFromServer } from './transfer-receive.ts';
export { isArrayBuffer } from './transfer-shared.ts';

// ─── Register Handlers ──────────────────────────────────────────────

export function initTransfer(): void {
  registerHandlers({
    [MSG.FILE_PREPARE]: handleFilePrepare,
    [MSG.FILE_START]: handleFileStart,
    [MSG.FILE_RESUME]: handleFileResume,
    [MSG.FILE_CHUNK]: handleFileChunk,
    [MSG.FILE_END]: handleFileEnd,
    [MSG.FILE_WAIT]: handleFileWait,
  });

  // OPFS write failure: trigger recovery to re-request the corrupted chunk
  // instead of silently continuing with a hole in the file data.
  bus.on('opfs:write-error', (data: unknown) => {
    const info = data as
      | { filename?: string; chunkIndex?: number; isPreload?: boolean }
      | undefined;
    if (info?.isPreload) return; // Preload write errors are handled separately
    const transferState = getState('transfer.state');
    if (transferState === TRANSFER_STATE.RECEIVING) {
      log.warn('[Transfer] OPFS write failed — requesting recovery');
      bus.emit('storage:request-recovery');
    }
  });

  // Clean up reorder buffer when session ends
  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      clearReceiveState();
    }
  });

  log.info('[Transfer] Handlers registered');
}
