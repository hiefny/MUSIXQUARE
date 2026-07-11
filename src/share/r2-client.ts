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
import { REMOTE_SHARE_MAX_ENCRYPTED_BYTES } from '../core/constants.ts';
import type { QueueItemId } from '../types/index.ts';

interface RemoteUploadResponse {
  objectId: string;
  downloadUrl?: string;
  expiresAt: number;
}

interface RemoteUploadSessionResponse {
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  uploadUrlExpiresAt: number;
  completeToken: string;
  objectId: string;
  downloadUrl?: string;
  expiresAt: number;
  cleanupToken?: string;
}

interface RemoteUploadMeta {
  roomId: string;
  name: string;
  mime: string;
  size: number;
  sessionId: number;
  queueItemId: QueueItemId;
}

type ProgressHandler = (progress: number) => void;

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
// Large files may legitimately take far longer than five minutes on mobile.
// Abort only when no bytes move for this window; steady slow transfers remain
// valid regardless of total wall-clock duration.
const REMOTE_SHARE_XHR_STALL_TIMEOUT_MS = 90_000;
const REMOTE_SHARE_SECURITY_CONFIG_CACHE_MS = 5 * 60_000;
const REMOTE_OBJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let remoteShareSecurityConfigCache: {
  endpoint: string;
  expiresAt: number;
  value: RemoteShareSecurityConfig;
} | null = null;

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

function getRemoteShareEndpoint(): string | null {
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

function expectedDownloadUrl(roomId: string, objectId: string): URL {
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  return new URL(
    `${endpoint}/download/${encodeURIComponent(roomId)}/${encodeURIComponent(objectId)}`,
  );
}

function buildDownloadUrl(roomId: string, objectId: string, downloadUrl?: string): string {
  const expected = expectedDownloadUrl(roomId, objectId);
  if (!downloadUrl) return expected.toString();

  let candidate: URL;
  try {
    candidate = new URL(downloadUrl);
  } catch {
    throw new Error('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID');
  }
  if (
    candidate.origin !== expected.origin ||
    candidate.pathname !== expected.pathname ||
    candidate.search !== '' ||
    candidate.hash !== '' ||
    candidate.username !== '' ||
    candidate.password !== ''
  ) {
    throw new Error('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID');
  }
  return candidate.toString();
}

/**
 * Wire an AbortSignal to an XHR. The abort rejection wins over later network
 * callbacks so stale or partial responses cannot resolve the operation.
 */
function wireAbort(
  xhr: XMLHttpRequest,
  reject: (err: Error) => void,
  signal?: AbortSignal,
  beforeAbort?: () => void,
): (() => void) | null | undefined {
  if (!signal) return undefined;
  if (signal.aborted) {
    xhr.abort();
    reject(new Error('REMOTE_SHARE_ABORTED'));
    return null;
  }
  const handleAbort = (): void => {
    beforeAbort?.();
    try {
      xhr.abort();
    } catch {
      /* ignore */
    }
    reject(new Error('REMOTE_SHARE_ABORTED'));
  };
  signal.addEventListener('abort', handleAbort, { once: true });
  return () => signal.removeEventListener('abort', handleAbort);
}

function createXhrStallWatchdog(
  xhr: XMLHttpRequest,
  reject: (err: Error) => void,
  errorCode: string,
): { reset: () => void; clear: () => void } {
  let handle: ReturnType<typeof globalThis.setTimeout> | null = null;
  const clear = (): void => {
    if (handle === null) return;
    globalThis.clearTimeout(handle);
    handle = null;
  };
  const reset = (): void => {
    clear();
    handle = globalThis.setTimeout(() => {
      handle = null;
      try {
        xhr.abort();
      } catch {
        /* ignore */
      }
      reject(new Error(errorCode));
    }, REMOTE_SHARE_XHR_STALL_TIMEOUT_MS);
  };
  reset();
  return { reset, clear };
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
  } catch (error) {
    if (signal?.aborted) throw error;
    return { capabilityRequired: false };
  }
}

/** Invalidate cached security configuration after a 401 so the retry probes
 * the capability requirement again. */
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
  return getCapabilityHeaders(
    new URL('/api/capability-token', location.origin),
    ['remote-share'],
    signal,
  );
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
      queueItemId: meta.queueItemId,
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

    // A 401 may mean the token is stale or the capability probe was inaccurate.
    // Invalidate both caches, probe again, and retry once.
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
      !REMOTE_OBJECT_ID_RE.test(body.objectId) ||
      typeof body.expiresAt !== 'number' ||
      typeof body.uploadUrlExpiresAt !== 'number' ||
      !body.uploadHeaders ||
      typeof body.uploadHeaders !== 'object'
    ) {
      throw new Error('REMOTE_SHARE_BAD_SESSION_RESPONSE');
    }
    return {
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
    if (
      typeof body?.objectId !== 'string' ||
      body.objectId !== session.objectId ||
      typeof body.expiresAt !== 'number'
    ) {
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

    const stall = createXhrStallWatchdog(xhr, reject, 'REMOTE_SHARE_UPLOAD_STALLED');
    const detachAbort = wireAbort(xhr, reject, signal, stall.clear);
    if (detachAbort === null) {
      stall.clear();
      return;
    }

    let lastUploadedBytes = 0;
    xhr.upload.onprogress = (event) => {
      if (event.loaded > lastUploadedBytes) {
        lastUploadedBytes = event.loaded;
        stall.reset();
      }
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      stall.clear();
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
      stall.clear();
      detachAbort?.();
      reject(new Error('REMOTE_SHARE_UPLOAD_NETWORK'));
    };
    try {
      xhr.send(encryptedBlob);
    } catch (error) {
      stall.clear();
      detachAbort?.();
      reject(
        signal?.aborted
          ? new Error('REMOTE_SHARE_ABORTED', { cause: error })
          : new Error('REMOTE_SHARE_UPLOAD_NETWORK', { cause: error }),
      );
    }
  });
}

export function downloadEncryptedObject(
  roomId: string,
  objectId: string,
  expectedEncryptedSize: number,
  downloadUrl?: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    if (
      !Number.isSafeInteger(expectedEncryptedSize) ||
      expectedEncryptedSize <= 0 ||
      expectedEncryptedSize > REMOTE_SHARE_MAX_ENCRYPTED_BYTES
    ) {
      reject(new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'));
      return;
    }

    const requestUrl = buildDownloadUrl(roomId, objectId, downloadUrl);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', requestUrl, true);
    xhr.responseType = 'arraybuffer';

    const stall = createXhrStallWatchdog(xhr, reject, 'REMOTE_SHARE_DOWNLOAD_STALLED');
    const detachAbort = wireAbort(xhr, reject, signal, stall.clear);
    if (detachAbort === null) {
      stall.clear();
      return;
    }

    let lastDownloadedBytes = 0;
    xhr.onprogress = (event) => {
      if (event.loaded > lastDownloadedBytes) {
        lastDownloadedBytes = event.loaded;
        stall.reset();
      }
      if (event.lengthComputable && event.total !== expectedEncryptedSize) {
        stall.clear();
        detachAbort?.();
        xhr.abort();
        reject(new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'));
        return;
      }
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      stall.clear();
      detachAbort?.();
      try {
        if (
          !xhr.responseURL ||
          buildDownloadUrl(roomId, objectId, xhr.responseURL) !== new URL(requestUrl).toString()
        ) {
          reject(new Error('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID'));
          return;
        }
      } catch {
        reject(new Error('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID'));
        return;
      }
      if (
        xhr.status >= 200 &&
        xhr.status < 300 &&
        xhr.response instanceof ArrayBuffer &&
        xhr.response.byteLength === expectedEncryptedSize
      ) {
        onProgress?.(1);
        resolve(xhr.response);
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response instanceof ArrayBuffer) {
        reject(new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'));
        return;
      }
      reject(new Error(`REMOTE_SHARE_DOWNLOAD_HTTP_${xhr.status}`));
    };
    xhr.onerror = () => {
      stall.clear();
      detachAbort?.();
      reject(new Error('REMOTE_SHARE_DOWNLOAD_NETWORK'));
    };
    try {
      xhr.send();
    } catch (error) {
      stall.clear();
      detachAbort?.();
      reject(
        signal?.aborted
          ? new Error('REMOTE_SHARE_ABORTED', { cause: error })
          : new Error('REMOTE_SHARE_DOWNLOAD_NETWORK', { cause: error }),
      );
    }
  });
}
