import { decryptToFile } from './crypto.ts';
import { downloadEncryptedObject } from './r2-client.ts';
import type { RemoteFileSharePayload } from '../types/index.ts';

export async function downloadRemoteFile(
  descriptor: RemoteFileSharePayload,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  const encrypted = await downloadEncryptedObject(
    descriptor.roomId,
    descriptor.objectId,
    descriptor.downloadUrl,
    onProgress,
    signal,
  );
  // Late-abort guard: signal may have fired between the network resolving
  // and the decrypt step starting. Without this, we'd waste WebCrypto work
  // on a buffer destined to be discarded — and worse, the resolved File
  // could race past the abort check in the caller and leak into
  // preload.nextFileBlob for a track the user has already left.
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
  return decryptToFile(
    encrypted,
    descriptor.keyB64,
    descriptor.ivB64,
    descriptor.name,
    descriptor.mime,
  );
}
