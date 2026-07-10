import { decryptToFile } from './crypto.ts';
import { downloadEncryptedObject } from './r2-client.ts';
import type { RemoteFileSharePayload } from '../types/index.ts';

/**
 * Download and decrypt a remote object using whole-file buffers. XHR resolves
 * only after the complete encrypted ArrayBuffer is resident; decryptToFile then
 * allocates the complete plaintext while that encrypted input is still live.
 *
 * The signal can abort the in-flight XHR and is checked once before decryption.
 * Web Crypto itself is not cancellable, so an abort after decryption starts
 * does not stop that work or release its buffers immediately. There is no
 * post-decrypt signal check, so this Promise may still resolve; callers must
 * recheck the signal before publishing the File.
 */
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
  // The signal may fire after download but before decryption. Recheck it so a
  // superseded operation cannot publish a decrypted file.
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
  return decryptToFile(
    encrypted,
    descriptor.keyB64,
    descriptor.ivB64,
    descriptor.name,
    descriptor.mime,
  );
}
