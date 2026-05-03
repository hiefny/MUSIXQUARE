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

export function uploadEncryptedBlob(
  encryptedBlob: Blob,
  meta: RemoteUploadMeta,
  onProgress?: ProgressHandler,
): Promise<RemoteUploadResponse> {
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) return Promise.reject(new Error('REMOTE_SHARE_ENDPOINT_MISSING'));

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

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
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
    xhr.onerror = () => reject(new Error('REMOTE_SHARE_UPLOAD_NETWORK'));
    xhr.ontimeout = () => reject(new Error('REMOTE_SHARE_UPLOAD_TIMEOUT'));
    xhr.timeout = 120_000;
    xhr.send(encryptedBlob);
  });
}

export function downloadEncryptedObject(
  roomId: string,
  objectId: string,
  downloadUrl?: string,
  onProgress?: ProgressHandler,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', buildDownloadUrl(roomId, objectId, downloadUrl), true);
    xhr.responseType = 'arraybuffer';
    xhr.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response instanceof ArrayBuffer) {
        onProgress?.(1);
        resolve(xhr.response);
        return;
      }
      reject(new Error(`REMOTE_SHARE_DOWNLOAD_HTTP_${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('REMOTE_SHARE_DOWNLOAD_NETWORK'));
    xhr.ontimeout = () => reject(new Error('REMOTE_SHARE_DOWNLOAD_TIMEOUT'));
    xhr.timeout = 120_000;
    xhr.send();
  });
}
