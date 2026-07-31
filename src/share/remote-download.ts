import { downloadWholeObject } from './r2-client.ts';
import type { RemoteFileSharePayload } from '../types/index.ts';

/** Download one authenticated whole object and materialize it as a browser File. */
export async function downloadRemoteFile(
  descriptor: RemoteFileSharePayload,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  if (descriptor.storedSize !== descriptor.size) {
    throw new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
  }
  const bytes = await downloadWholeObject(
    descriptor.roomId,
    descriptor.objectId,
    descriptor.storedSize,
    descriptor.downloadToken,
    descriptor.downloadUrl,
    onProgress,
    signal,
  );
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
  if (bytes.byteLength !== descriptor.size) {
    throw new Error('REMOTE_SHARE_OBJECT_SIZE_MISMATCH');
  }
  return new File([bytes], descriptor.name, {
    type: descriptor.mime || 'application/octet-stream',
  });
}
