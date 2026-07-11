/** Public file-transfer facade and protocol-handler registration. */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG, TRANSFER_STATE } from '../core/constants.ts';
import { registerHandlers } from '../network/protocol.ts';
import { resetAllStoredFiles } from './storage.ts';
import { cancelOutgoingFileTransferForPeer as cancelOutgoingFileTransferForPeerInternal } from './transfer-send.ts';
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

export {
  broadcastFile,
  broadcastFileDebounced,
  cancelPendingBroadcast,
  unicastFile,
  cancelOutgoingFileTransfers,
} from './transfer-send.ts';
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

  // A failed main-transfer write leaves an incomplete file; restart recovery
  // instead of allowing finalization with a missing chunk.
  bus.on('storage:write-error', (data: unknown) => {
    const info = data as
      | { filename?: string; chunkIndex?: number; isPreload?: boolean }
      | undefined;
    if (info?.isPreload) return; // Preload write errors are handled separately
    const transferState = getState('transfer.state');
    if (transferState === TRANSFER_STATE.RECEIVING) {
      log.warn('[Transfer] Storage write failed — requesting recovery');
      bus.emit('storage:request-recovery');
    }
  });

  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      clearReceiveState();
      resetAllStoredFiles();
    }
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    cancelOutgoingFileTransferForPeerInternal(peerId);
  });

  log.info('[Transfer] Handlers registered');
}
