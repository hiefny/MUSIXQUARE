import { decryptToFile } from './crypto.ts';
import { downloadEncryptedObject, downloadPlainObject } from './r2-client.ts';
import type { RemoteFileSharePayload } from '../types/index.ts';

/**
 * Download and decrypt a remote object using whole-file buffers. XHR resolves
 * only after the complete encrypted ArrayBuffer is resident; decryptToFile then
 * allocates the complete plaintext while that encrypted input is still live.
 *
 * The signal can abort the in-flight XHR and is checked before and after
 * decryption. Web Crypto itself is not cancellable, so an abort after
 * decryption starts does not stop that work or release its buffers
 * immediately, but its result is never returned to the caller.
 */
export async function downloadRemoteFile(
  descriptor: RemoteFileSharePayload,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  if (descriptor.storageFormat === 'plain-whole-v1') {
    if (descriptor.storedSize !== descriptor.size) {
      throw new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
    }
    const plaintext = await downloadPlainObject(
      descriptor.roomId,
      descriptor.objectId,
      descriptor.storedSize,
      descriptor.downloadToken,
      descriptor.downloadUrl,
      onProgress,
      signal,
    );
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
    if (plaintext.byteLength !== descriptor.size) {
      throw new Error('REMOTE_SHARE_PLAINTEXT_SIZE_MISMATCH');
    }
    return new File([plaintext], descriptor.name, {
      type: descriptor.mime || 'application/octet-stream',
    });
  }

  const encrypted = await downloadEncryptedObject(
    descriptor.roomId,
    descriptor.objectId,
    descriptor.encryptedSize,
    descriptor.downloadUrl,
    onProgress,
    signal,
  );
  // The signal may fire after download but before decryption. Recheck it so a
  // superseded operation cannot publish a decrypted file.
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
  if (encrypted.byteLength !== descriptor.encryptedSize) {
    throw new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
  }
  const file = await decryptToFile(
    encrypted,
    descriptor.keyB64,
    descriptor.ivB64,
    descriptor.name,
    descriptor.mime,
  );
  // Web Crypto cannot be interrupted once decryption starts. Discard its
  // result if the owning playback context was superseded in that window.
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
  if (file.size !== descriptor.size) {
    throw new Error('REMOTE_SHARE_PLAINTEXT_SIZE_MISMATCH');
  }
  return file;
}
