import { getState, setState } from '../core/state.ts';
import { encryptFile } from './crypto.ts';
import { uploadEncryptedBlob } from './r2-client.ts';
import type { RemoteFileSharePayload } from '../types/index.ts';

export const REMOTE_SHARE_MAX_BYTES = 200 * 1024 * 1024;

export async function uploadRemoteFile(
  file: File,
  sessionId: number,
  index: number,
  onUploadProgress?: (progress: number) => void,
): Promise<RemoteFileSharePayload> {
  if (file.size > REMOTE_SHARE_MAX_BYTES) {
    throw new Error('REMOTE_SHARE_FILE_TOO_LARGE');
  }

  const roomId = getState('network.sessionCode') || getState('network.myId') || 'room';

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
  onUploadProgress?.(0);

  const encrypted = await encryptFile(file);

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

  const uploaded = await uploadEncryptedBlob(
    encrypted.encryptedBlob,
    {
      roomId,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      sessionId,
      index,
    },
    (progress) => {
      const remote = getState('share.remote');
      setState('share.remote', {
        ...remote,
        upload: {
          ...remote.upload,
          status: 'uploading',
          progress,
        },
      });
      onUploadProgress?.(progress);
    },
  );

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
    index,
    sessionId,
    expiresAt: uploaded.expiresAt,
  };
}
