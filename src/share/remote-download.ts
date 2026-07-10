import {
  REMOTE_SHARE_LEGACY_MAX_PLAINTEXT_BYTES,
  REMOTE_SHARE_STREAM_THRESHOLD_BYTES,
} from '../core/constants.ts';
import { decryptChunkedStreamToMemory, decryptToFile } from './crypto.ts';
import { downloadEncryptedObject, downloadEncryptedObjectStream } from './r2-client.ts';
import { createRemoteMediaFile, type RemoteMediaFile } from './remote-media.ts';
import type { RemoteFileSharePayload } from '../types/index.ts';

export async function downloadRemoteFile(
  descriptor: RemoteFileSharePayload,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<File | RemoteMediaFile> {
  if (descriptor.cryptoVersion === 2) {
    if (
      !descriptor.chunkSize ||
      !descriptor.chunkCount ||
      !descriptor.tagBytes ||
      signal?.aborted
    ) {
      throw new Error(
        signal?.aborted ? 'REMOTE_SHARE_ABORTED' : 'REMOTE_SHARE_CRYPTO_METADATA_INVALID',
      );
    }

    // Large plaintext never becomes a browser File. The media element asks
    // for exact plaintext ranges through the service worker, which fetches
    // and authenticates one ciphertext record at a time.
    if (descriptor.size >= REMOTE_SHARE_STREAM_THRESHOLD_BYTES) {
      const remote = await createRemoteMediaFile(descriptor, { signal });
      onProgress?.(1);
      return remote;
    }

    const body = await downloadEncryptedObjectStream(
      descriptor.roomId,
      descriptor.objectId,
      descriptor.downloadUrl,
      descriptor.encryptedSize,
      signal,
    );
    return decryptChunkedStreamToMemory({
      body,
      keyB64: descriptor.keyB64,
      noncePrefixB64: descriptor.ivB64,
      plainSize: descriptor.size,
      encryptedSize: descriptor.encryptedSize,
      chunkSize: descriptor.chunkSize,
      chunkCount: descriptor.chunkCount,
      tagBytes: descriptor.tagBytes,
      name: descriptor.name,
      mime: descriptor.mime,
      signal,
      onProgress,
    });
  }

  // Whole-file AES-GCM is rolling compatibility only and must never be
  // allowed to scale to the multipart product limit in JS heap memory.
  if (descriptor.size > REMOTE_SHARE_LEGACY_MAX_PLAINTEXT_BYTES) {
    throw new Error('REMOTE_SHARE_LEGACY_TOO_LARGE');
  }
  const encrypted = await downloadEncryptedObject(
    descriptor.roomId,
    descriptor.objectId,
    descriptor.downloadUrl,
    onProgress,
    signal,
    descriptor.encryptedSize,
  );
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
  return decryptToFile(
    encrypted,
    descriptor.keyB64,
    descriptor.ivB64,
    descriptor.name,
    descriptor.mime,
  );
}
