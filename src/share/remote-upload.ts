import { getState, setState } from '../core/state.ts';
import { REMOTE_SHARE_AES_GCM_TAG_BYTES, REMOTE_SHARE_MAX_BYTES } from '../core/constants.ts';
import { encryptFile } from './crypto.ts';
import { uploadEncryptedBlob } from './r2-client.ts';
import {
  reserveRemoteTransportMemoryWithinBudget,
  resolveDecodeMemoryBudget,
} from '../player/decode-admission.ts';
import { currentAudioBufferPcmBytes, liveAudioBufferPcmBytes } from '../player/_state.ts';
import { isQueueItemId } from '../player/queue-model.ts';
import type { QueueItemId, RemoteFileSharePayload } from '../types/index.ts';

interface UploadRemoteFileOptions {
  onUploadProgress?: (progress: number) => void;
  onStageChange?: (stage: 'encrypting' | 'uploading') => void;
  signal?: AbortSignal;
  /** Keep speculative preload work out of the foreground remote-share UI state. */
  publishState?: boolean;
}

export async function uploadRemoteFile(
  file: File,
  sessionId: number,
  queueItemId: QueueItemId,
  options: UploadRemoteFileOptions = {},
): Promise<RemoteFileSharePayload> {
  const { onUploadProgress, onStageChange, signal, publishState = true } = options;

  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !isQueueItemId(queueItemId)) {
    throw new Error('REMOTE_SHARE_INVALID_IDENTITY');
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > REMOTE_SHARE_MAX_BYTES) {
    throw new Error('REMOTE_SHARE_FILE_TOO_LARGE');
  }
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');

  const memoryBudget = resolveDecodeMemoryBudget();
  const transportReservation = reserveRemoteTransportMemoryWithinBudget(file.size, {
    budget: memoryBudget,
    fileName: file.name,
    retainedPcmBytes:
      memoryBudget.tier === 'ios' ? liveAudioBufferPcmBytes() : currentAudioBufferPcmBytes(),
  });

  try {
    const roomId = getState('network.sessionCode') || getState('network.myId') || 'room';

    onStageChange?.('encrypting');
    if (publishState) {
      setState('share.remote', {
        ...getState('share.remote'),
        upload: {
          status: 'encrypting',
          progress: 0,
          objectId: null,
          expiresAt: null,
          error: null,
        },
      });
    }
    onUploadProgress?.(0);

    const encrypted = await encryptFile(file);
    if (encrypted.encryptedBlob.size !== file.size + REMOTE_SHARE_AES_GCM_TAG_BYTES) {
      throw new Error('REMOTE_SHARE_ENCRYPTED_SIZE_MISMATCH');
    }
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');

    onStageChange?.('uploading');
    if (publishState) {
      setState('share.remote', {
        ...getState('share.remote'),
        upload: {
          status: 'uploading',
          progress: 0,
          objectId: null,
          expiresAt: null,
          error: null,
        },
      });
    }

    const uploaded = await uploadEncryptedBlob(
      encrypted.encryptedBlob,
      {
        roomId,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        sessionId,
        queueItemId,
      },
      (progress) => {
        if (publishState) {
          const remote = getState('share.remote');
          setState('share.remote', {
            ...remote,
            upload: {
              ...remote.upload,
              status: 'uploading',
              progress,
            },
          });
        }
        onUploadProgress?.(progress);
      },
      signal,
    );

    if (publishState) {
      setState('share.remote', {
        ...getState('share.remote'),
        upload: {
          status: 'done',
          progress: 1,
          objectId: uploaded.objectId,
          expiresAt: uploaded.expiresAt,
          error: null,
        },
      });
    }
    onUploadProgress?.(1);

    return {
      roomId,
      objectId: uploaded.objectId,
      downloadUrl: uploaded.downloadUrl,
      keyB64: encrypted.keyB64,
      ivB64: encrypted.ivB64,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      encryptedSize: encrypted.encryptedBlob.size,
      queueItemId,
      sessionId,
      expiresAt: uploaded.expiresAt,
    };
  } finally {
    transportReservation.release();
  }
}
