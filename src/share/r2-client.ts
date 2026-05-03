/**
 * Cloudflare R2 remote-share client.
 *
 * Endpoint discovery order:
 * 1. window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__
 * 2. localStorage "musixquare-remote-share-endpoint"
 * 3. https://share.musixquare.com on the production domain
 */

export interface RemoteUploadResponse {
  objectId: string;
  downloadUrl?: string;
  expiresAt: number;
}

export interface RemoteUploadSessionResponse {
  token: string;
  expiresAt: number;
}

export interface RemoteUploadMeta {
  roomId: string;
  name: string;
  mime: string;
  size: number;
  sessionId: number;
  index: number;
}

export type ProgressHandler = (progress: number) => void;

const ENDPOINT_STORAGE_KEY = 'musixquare-remote-share-endpoint';
const PROD_ENDPOINT = 'https://share.musixquare.com';
const REMOTE_SHARE_XHR_TIMEOUT_MS = 5 * 60_000;

function normalizeEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return null;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function getRemoteShareEndpoint(): string | null {
  const injected = normalizeEndpoint(
    (window as unknown as Record<string, unknown>).__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__,
  );
  if (injected) return injected;

  try {
    const stored = normalizeEndpoint(localStorage.getItem(ENDPOINT_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    /* ignore */
  }

  if (location.hostname === 'musixquare.com' || location.hostname.endsWith('.musixquare.com')) {
    return PROD_ENDPOINT;
  }
  return null;
}

export function isRemoteShareConfigured(): boolean {
  return getRemoteShareEndpoint() !== null;
}

export function buildDownloadUrl(roomId: string, objectId: string, downloadUrl?: string): string {
  if (downloadUrl) return downloadUrl;
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  return `${endpoint}/download/${encodeURIComponent(roomId)}/${encodeURIComponent(objectId)}`;
}

/**
 * Wire an AbortSignal to an XHR. Resolves the abort path before the network
 * stack has a chance to fire onload/onerror — without this, an aborted
 * download could still resolve with a partial buffer (or worse, a fully
 * decrypted-but-stale blob would land in preload.nextFileBlob and be
 * promoted as the active track on a track-2 supersede race).
 */
function wireAbort(
  xhr: XMLHttpRequest,
  reject: (err: Error) => void,
  signal?: AbortSignal,
): (() => void) | undefined {
  if (!signal) return undefined;
  if (signal.aborted) {
    xhr.abort();
    reject(new Error('REMOTE_SHARE_ABORTED'));
    return undefined;
  }
  const onAbort = (): void => {
    try {
      xhr.abort();
    } catch {
      /* ignore */
    }
    reject(new Error('REMOTE_SHARE_ABORTED'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

async function requestUploadSession(
  endpoint: string,
  encryptedBlob: Blob,
  meta: RemoteUploadMeta,
  signal?: AbortSignal,
): Promise<RemoteUploadSessionResponse> {
  try {
    const response = await fetch(`${endpoint}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: meta.roomId,
        sessionId: meta.sessionId,
        index: meta.index,
        size: meta.size,
        encryptedSize: encryptedBlob.size,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`REMOTE_SHARE_SESSION_HTTP_${response.status}`);
    }

    const body = (await response.json()) as Partial<RemoteUploadSessionResponse> | null;
    if (typeof body?.token !== 'string' || typeof body.expiresAt !== 'number') {
      throw new Error('REMOTE_SHARE_BAD_SESSION_RESPONSE');
    }
    return { token: body.token, expiresAt: body.expiresAt };
  } catch (error) {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) throw error;
    throw new Error('REMOTE_SHARE_SESSION_NETWORK', { cause: error });
  }
}

export async function uploadEncryptedBlob(
  encryptedBlob: Blob,
  meta: RemoteUploadMeta,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<RemoteUploadResponse> {
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');

  const session = await requestUploadSession(endpoint, encryptedBlob, meta, signal);

  return new Promise((resolve, reject) => {
    const url = new URL(`${endpoint}/upload`);
    url.searchParams.set('roomId', meta.roomId);
    url.searchParams.set('sessionId', String(meta.sessionId));
    url.searchParams.set('index', String(meta.index));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url.toString(), true);
    xhr.responseType = 'json';
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-mxqr-name', encodeURIComponent(meta.name));
    xhr.setRequestHeader('x-mxqr-mime', meta.mime || 'application/octet-stream');
    xhr.setRequestHeader('x-mxqr-size', String(meta.size));
    xhr.setRequestHeader('x-mxqr-session-token', session.token);

    const detachAbort = wireAbort(xhr, reject, signal);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      detachAbort?.();
      if (xhr.status >= 200 && xhr.status < 300) {
        const body = xhr.response as Partial<RemoteUploadResponse> | null;
        if (body?.objectId && typeof body.expiresAt === 'number') {
          onProgress?.(1);
          resolve({
            objectId: body.objectId,
            downloadUrl: body.downloadUrl,
            expiresAt: body.expiresAt,
          });
          return;
        }
        reject(new Error('REMOTE_SHARE_BAD_UPLOAD_RESPONSE'));
        return;
      }
      reject(new Error(`REMOTE_SHARE_UPLOAD_HTTP_${xhr.status}`));
    };
    xhr.onerror = () => {
      detachAbort?.();
      reject(new Error('REMOTE_SHARE_UPLOAD_NETWORK'));
    };
    xhr.ontimeout = () => {
      detachAbort?.();
      reject(new Error('REMOTE_SHARE_UPLOAD_TIMEOUT'));
    };
    xhr.timeout = REMOTE_SHARE_XHR_TIMEOUT_MS;
    xhr.send(encryptedBlob);
  });
}

export function downloadEncryptedObject(
  roomId: string,
  objectId: string,
  downloadUrl?: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', buildDownloadUrl(roomId, objectId, downloadUrl), true);
    xhr.responseType = 'arraybuffer';

    const detachAbort = wireAbort(xhr, reject, signal);

    xhr.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      detachAbort?.();
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response instanceof ArrayBuffer) {
        onProgress?.(1);
        resolve(xhr.response);
        return;
      }
      reject(new Error(`REMOTE_SHARE_DOWNLOAD_HTTP_${xhr.status}`));
    };
    xhr.onerror = () => {
      detachAbort?.();
      reject(new Error('REMOTE_SHARE_DOWNLOAD_NETWORK'));
    };
    xhr.ontimeout = () => {
      detachAbort?.();
      reject(new Error('REMOTE_SHARE_DOWNLOAD_TIMEOUT'));
    };
    xhr.timeout = REMOTE_SHARE_XHR_TIMEOUT_MS;
    xhr.send();
  });
}
