import { decryptToFile } from './crypto.ts';
import { downloadEncryptedObject } from './r2-client.ts';
import type { RemoteFileSharePayload } from '../types/index.ts';

export async function downloadRemoteFile(
  descriptor: RemoteFileSharePayload,
  onProgress?: (progress: number) => void,
): Promise<File> {
  const encrypted = await downloadEncryptedObject(
    descriptor.roomId,
    descriptor.objectId,
    descriptor.downloadUrl,
    onProgress,
  );
  return decryptToFile(
    encrypted,
    descriptor.keyB64,
    descriptor.ivB64,
    descriptor.name,
    descriptor.mime,
  );
}
