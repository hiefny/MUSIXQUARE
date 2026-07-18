/** Public file-transfer facade and protocol-handler registration. */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG, TRANSFER_STATE } from '../core/constants.ts';
import { registerHandlers, registerInboundRateLimitExemptionGuard } from '../network/protocol.ts';
import { resetAllStoredFiles } from './storage.ts';
import {
  cancelOutgoingFileTransferForPeer as cancelOutgoingFileTransferForPeerInternal,
  cancelOutgoingFileTransfers as cancelOutgoingFileTransfersInternal,
} from './transfer-send.ts';
import {
  handleFilePrepare,
  handleFileStart,
  handleFileResume,
  handleFileChunk,
  handleFileEnd,
  handleFileWait,
  isActiveHostFileChunkForRateLimit,
  resetIncomingTransferAuthority,
} from './transfer-receive.ts';

// ─── Re-exports ──────────────────────────────────────────────────────

export {
  broadcastFile,
  broadcastFileDebounced,
  sendFilePrepareByDelivery,
  sendFileDeliveryUnavailable,
  cancelPendingBroadcast,
  unicastFile,
  cancelOutgoingFileTransfers,
} from './transfer-send.ts';
export { cancelIncomingFileTransfer, resetIncomingTransferAuthority } from './transfer-receive.ts';
export { isArrayBuffer } from './transfer-shared.ts';

// ─── Register Handlers ──────────────────────────────────────────────

export function initTransfer(): void {
  registerInboundRateLimitExemptionGuard(MSG.FILE_CHUNK, isActiveHostFileChunkForRateLimit);
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
      | {
          queueItemId?: string;
          sessionId?: number;
          filename?: string;
          chunkIndex?: number;
          isPreload?: boolean;
        }
      | undefined;
    if (info?.isPreload) return; // Preload write errors are handled separately
    const transferState = getState('transfer.state');
    const meta = getState('transfer.meta');
    if (
      transferState === TRANSFER_STATE.RECEIVING &&
      !!info?.queueItemId &&
      info.queueItemId === meta?.queueItemId &&
      Number(info.sessionId) === Number(meta?.sessionId)
    ) {
      log.warn('[Transfer] Storage write failed — requesting recovery');
      bus.emit('storage:request-recovery');
    }
  });

  bus.on('state:network.sessionCode', () => {
    // File-transfer session ids and byte ownership are scoped to one room.
    // A direct truthy-to-truthy room switch is just as strong a boundary as
    // leaving through the empty-code state.
    cancelOutgoingFileTransfersInternal();
    resetIncomingTransferAuthority();
    resetAllStoredFiles();
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    cancelOutgoingFileTransferForPeerInternal(peerId);
  });
  bus.on('network:peer-connection-replaced', (peerId: string) => {
    cancelOutgoingFileTransferForPeerInternal(peerId);
  });

  log.info('[Transfer] Handlers registered');
}
