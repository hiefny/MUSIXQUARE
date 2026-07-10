import { getState, setState } from '../core/state.ts';
import { createChunkEncryptionPlan, encryptFileChunk } from './crypto.ts';
import { contentMd5Base64 } from './md5.ts';
import {
  REMOTE_SHARE_MAX_PLAINTEXT_BYTES,
  abortMultipartUpload,
  completeMultipartUpload,
  requestMultipartPartUrls,
  requestMultipartUploadSession,
  uploadMultipartPart,
  type RemoteMultipartSession,
  type RemoteUploadedPart,
} from './r2-client.ts';
import type { RemoteFileSharePayload } from '../types/index.ts';

interface UploadRemoteFileOptions {
  onUploadProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

const PART_UPLOAD_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [250, 1000] as const;

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('REMOTE_SHARE_ABORTED'));
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(finish, ms);
    function finish(): void {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(new Error('REMOTE_SHARE_ABORTED'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function setUploadProgress(status: 'encrypting' | 'uploading', progress: number): void {
  const remote = getState('share.remote');
  setState('share.remote', {
    ...remote,
    upload: {
      ...remote.upload,
      status,
      progress,
    },
  });
}

async function uploadPartWithRetry(
  session: RemoteMultipartSession,
  partNumber: number,
  contentMd5: string,
  encrypted: ArrayBuffer,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<RemoteUploadedPart> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PART_UPLOAD_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
    try {
      const [target] = await requestMultipartPartUrls(
        session,
        [{ partNumber, contentMd5 }],
        signal,
      );
      if (!target) throw new Error('REMOTE_SHARE_BAD_PART_URL_RESPONSE');
      return await uploadMultipartPart(target, encrypted, onProgress, signal);
    } catch (error) {
      lastError = error;
      if (
        signal?.aborted ||
        (error instanceof Error &&
          (error.message === 'REMOTE_SHARE_ABORTED' ||
            /^REMOTE_SHARE_PART_URL_HTTP_4(?!29)/.test(error.message) ||
            /^REMOTE_SHARE_UPLOAD_HTTP_(?:400|401|404|409|413|422)$/.test(error.message)))
      ) {
        throw error;
      }
      if (attempt + 1 < PART_UPLOAD_ATTEMPTS) {
        await delayWithAbort(RETRY_BACKOFF_MS[attempt] ?? 1000, signal);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('REMOTE_SHARE_UPLOAD_NETWORK');
}

async function completeWithRecovery(
  session: RemoteMultipartSession,
  roomId: string,
  parts: RemoteUploadedPart[],
  signal?: AbortSignal,
) {
  try {
    return await completeMultipartUpload(session, roomId, parts, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (
      signal?.aborted ||
      (message !== 'REMOTE_SHARE_COMPLETE_NETWORK' &&
        !/^REMOTE_SHARE_COMPLETE_HTTP_5\d\d$/.test(message))
    ) {
      throw error;
    }
    await delayWithAbort(500, signal);
    return completeMultipartUpload(session, roomId, parts, signal);
  }
}

export async function uploadRemoteFile(
  file: File,
  sessionId: number,
  index: number,
  options?: UploadRemoteFileOptions | ((progress: number) => void),
): Promise<RemoteFileSharePayload> {
  const opts: UploadRemoteFileOptions =
    typeof options === 'function' ? { onUploadProgress: options } : (options ?? {});
  const { onUploadProgress, signal } = opts;
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > REMOTE_SHARE_MAX_PLAINTEXT_BYTES
  ) {
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

  const plan = await createChunkEncryptionPlan(file);
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
  const meta = {
    roomId,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    sessionId,
    index,
  };
  const multipart = await requestMultipartUploadSession(meta, plan, signal);
  let completed = false;
  try {
    setUploadProgress('uploading', 0);
    const parts: RemoteUploadedPart[] = [];
    let uploadedBytes = 0;

    // Each URL is requested only after its ciphertext digest exists. Encryption,
    // hashing and upload stay serial so iOS holds one bounded record at a time.
    for (let chunkIndex = 0; chunkIndex < plan.chunkCount; chunkIndex += 1) {
      const partNumber = chunkIndex + 1;
      const encrypted = await encryptFileChunk(file, plan, chunkIndex, signal);
      const expectedPlain = Math.min(plan.chunkSize, plan.plainSize - chunkIndex * plan.chunkSize);
      if (encrypted.byteLength !== expectedPlain + plan.tagBytes) {
        throw new Error('REMOTE_SHARE_CRYPTO_SIZE_MISMATCH');
      }
      const contentMd5 = await contentMd5Base64(encrypted, signal);
      const uploaded = await uploadPartWithRetry(
        multipart,
        partNumber,
        contentMd5,
        encrypted,
        (partProgress) => {
          const progress = Math.min(
            0.999,
            (uploadedBytes + partProgress * encrypted.byteLength) / plan.encryptedSize,
          );
          setUploadProgress('uploading', progress);
          onUploadProgress?.(progress);
        },
        signal,
      );
      parts.push(uploaded);
      uploadedBytes += encrypted.byteLength;
    }

    if (parts.length !== plan.chunkCount || uploadedBytes !== plan.encryptedSize) {
      throw new Error('REMOTE_SHARE_UPLOAD_SIZE_MISMATCH');
    }
    const uploaded = await completeWithRecovery(multipart, roomId, parts, signal);
    completed = true;

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
      downloadUrl: uploaded.downloadUrl || multipart.downloadUrl,
      keyB64: plan.keyB64,
      ivB64: plan.ivB64,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      encryptedSize: plan.encryptedSize,
      index,
      sessionId,
      expiresAt: uploaded.expiresAt,
      cryptoVersion: 2,
      chunkSize: plan.chunkSize,
      chunkCount: plan.chunkCount,
      tagBytes: plan.tagBytes,
    };
  } finally {
    if (!completed) {
      await abortMultipartUpload(multipart, roomId).catch(() => undefined);
    }
  }
}
