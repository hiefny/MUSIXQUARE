/**
 * Cloudflare R2 remote-share client.
 *
 * Endpoint discovery order:
 * 1. window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__
 * 2. localStorage "musixquare-remote-share-endpoint"
 * 3. https://share.musixquare.com on the production domain
 */

import {
  getCapabilityHeaders,
  invalidateCapabilityToken,
  isCapabilityChallengeCancelled,
} from '../core/capability.ts';

export interface RemoteUploadResponse {
  objectId: string;
  downloadUrl?: string;
  expiresAt: number;
}

export interface RemoteUploadSessionResponse {
  token?: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  uploadUrlExpiresAt: number;
  completeToken: string;
  objectId: string;
  downloadUrl?: string;
  expiresAt: number;
  cleanupToken?: string;
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

declare global {
  interface Window {
    __MUSIXQUARE_REMOTE_SHARE_ENDPOINT__?: unknown;
  }
}

interface RemoteShareSecurityConfig {
  capabilityRequired: boolean;
}

const ENDPOINT_STORAGE_KEY = 'musixquare-remote-share-endpoint';
const PROD_ENDPOINT = 'https://share.musixquare.com';
const REMOTE_SHARE_XHR_TIMEOUT_MS = 5 * 60_000;
const REMOTE_SHARE_SECURITY_CONFIG_CACHE_MS = 5 * 60_000;
let remoteShareSecurityConfigCache:
  | { endpoint: string; expiresAt: number; value: RemoteShareSecurityConfig }
  | null = null;

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
  const injected = normalizeEndpoint(window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__);
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

async function getRemoteShareSecurityConfig(
  endpoint: string,
  signal?: AbortSignal,
): Promise<RemoteShareSecurityConfig> {
  if (
    remoteShareSecurityConfigCache &&
    remoteShareSecurityConfigCache.endpoint === endpoint &&
    remoteShareSecurityConfigCache.expiresAt > Date.now()
  ) {
    return remoteShareSecurityConfigCache.value;
  }

  try {
    const response = await fetch(`${endpoint}/security-config`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) throw new Error(`REMOTE_SHARE_SECURITY_CONFIG_HTTP_${response.status}`);

    const payload = (await response.json()) as Record<string, unknown>;
    const value = { capabilityRequired: payload.capabilityRequired === true };
    remoteShareSecurityConfigCache = {
      endpoint,
      expiresAt: Date.now() + REMOTE_SHARE_SECURITY_CONFIG_CACHE_MS,
      value,
    };
    return value;
  } catch {
    return { capabilityRequired: false };
  }
}

/** Drop the cached remote-share security-config so the next probe re-fetches.
 *  Used on a 401 retry — a 401 means /session really required capability, so a
 *  cached `capabilityRequired:false` (e.g. from a failed-open probe) was wrong. */
function invalidateRemoteShareSecurityConfig(endpoint: string): void {
  if (remoteShareSecurityConfigCache?.endpoint === endpoint) {
    remoteShareSecurityConfigCache = null;
  }
}

async function getRemoteShareSessionHeaders(
  endpoint: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const config = await getRemoteShareSecurityConfig(endpoint, signal);
  if (!config.capabilityRequired) return {};
  return getCapabilityHeaders(new URL('/api/capability-token', location.origin), ['remote-share']);
}

async function requestUploadSession(
  endpoint: string,
  encryptedBlob: Blob,
  meta: RemoteUploadMeta,
  signal?: AbortSignal,
): Promise<RemoteUploadSessionResponse> {
  try {
    const requestBody = JSON.stringify({
      roomId: meta.roomId,
      sessionId: meta.sessionId,
      index: meta.index,
      name: meta.name,
      mime: meta.mime || 'application/octet-stream',
      size: meta.size,
      encryptedSize: encryptedBlob.size,
    });
    const capabilityTarget = new URL('/api/capability-token', location.origin);
    let capabilityHeaders = await getRemoteShareSessionHeaders(endpoint, signal);
    let response = await fetch(`${endpoint}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...capabilityHeaders },
      body: requestBody,
      signal,
    });

    // 401 on /session: either a stale capability token, or we sent none because
    // the remote-share security-config probe failed open. Invalidate the cached
    // config + token, re-probe, and retry once. Same shape as
    // fetchWithCapability's 401 retry path.
    if (response.status === 401) {
      if (capabilityHeaders['X-MXQR-Capability']) invalidateCapabilityToken(capabilityTarget);
      invalidateRemoteShareSecurityConfig(endpoint);
      capabilityHeaders = await getRemoteShareSessionHeaders(endpoint, signal);
      response = await fetch(`${endpoint}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...capabilityHeaders },
        body: requestBody,
        signal,
      });
    }

    if (!response.ok) {
      throw new Error(`REMOTE_SHARE_SESSION_HTTP_${response.status}`);
    }

    const body = (await response.json()) as Partial<RemoteUploadSessionResponse> | null;
    if (
      typeof body?.uploadUrl !== 'string' ||
      typeof body.completeToken !== 'string' ||
      typeof body.objectId !== 'string' ||
      typeof body.expiresAt !== 'number' ||
      typeof body.uploadUrlExpiresAt !== 'number' ||
      !body.uploadHeaders ||
      typeof body.uploadHeaders !== 'object'
    ) {
      throw new Error('REMOTE_SHARE_BAD_SESSION_RESPONSE');
    }
    return {
      token: body.token,
      uploadUrl: body.uploadUrl,
      uploadHeaders: body.uploadHeaders as Record<string, string>,
      uploadUrlExpiresAt: body.uploadUrlExpiresAt,
      completeToken: body.completeToken,
      objectId: body.objectId,
      downloadUrl: body.downloadUrl,
      expiresAt: body.expiresAt,
      cleanupToken: body.cleanupToken,
    };
  } catch (error) {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    // User-initiated Turnstile cancel propagates with its own name so callers
    // can treat it as a silent dismiss instead of a "network error" toast.
    if (isCapabilityChallengeCancelled(error)) throw error;
    if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) throw error;
    throw new Error('REMOTE_SHARE_SESSION_NETWORK', { cause: error });
  }
}

async function completeDirectUpload(
  endpoint: string,
  session: RemoteUploadSessionResponse,
  meta: RemoteUploadMeta,
  signal?: AbortSignal,
): Promise<RemoteUploadResponse> {
  try {
    const response = await fetch(`${endpoint}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: meta.roomId,
        objectId: session.objectId,
        completeToken: session.completeToken,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`REMOTE_SHARE_COMPLETE_HTTP_${response.status}`);
    }

    const body = (await response.json()) as Partial<RemoteUploadResponse> | null;
    if (typeof body?.objectId !== 'string' || typeof body.expiresAt !== 'number') {
      throw new Error('REMOTE_SHARE_BAD_COMPLETE_RESPONSE');
    }
    return {
      objectId: body.objectId,
      downloadUrl: body.downloadUrl,
      expiresAt: body.expiresAt,
    };
  } catch (error) {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) throw error;
    throw new Error('REMOTE_SHARE_COMPLETE_NETWORK', { cause: error });
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
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', session.uploadUrl, true);
    for (const [header, value] of Object.entries(session.uploadHeaders)) {
      xhr.setRequestHeader(header, value);
    }

    const detachAbort = wireAbort(xhr, reject, signal);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      detachAbort?.();
      if (xhr.status >= 200 && xhr.status < 300) {
        void completeDirectUpload(endpoint, session, meta, signal).then((body) => {
          onProgress?.(1);
          resolve(body);
        }, reject);
        return;
      }
      reject(new Error(`REMOTE_SHARE_DIRECT_UPLOAD_HTTP_${xhr.status}`));
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
