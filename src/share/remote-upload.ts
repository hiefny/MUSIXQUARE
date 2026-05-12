import { getState, setState } from '../core/state.ts';
import { encryptFile } from './crypto.ts';
import { uploadEncryptedBlob } from './r2-client.ts';
import type { RemoteFileSharePayload } from '../types/index.ts';

export const REMOTE_SHARE_MAX_BYTES = 200 * 1024 * 1024;

export interface UploadRemoteFileOptions {
  onUploadProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

export async function uploadRemoteFile(
  file: File,
  sessionId: number,
  index: number,
  options?: UploadRemoteFileOptions | ((progress: number) => void),
): Promise<RemoteFileSharePayload> {
  // Backward-compat: callers used to pass onUploadProgress directly as the 4th arg.
  const opts: UploadRemoteFileOptions =
    typeof options === 'function' ? { onUploadProgress: options } : (options ?? {});
  const { onUploadProgress, signal } = opts;

  if (file.size > REMOTE_SHARE_MAX_BYTES) {
    throw new Error('REMOTE_SHARE_FILE_TOO_LARGE');
  }
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');

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
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');

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
    signal,
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
