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
import {
  REMOTE_SHARE_AES_GCM_TAG_BYTES,
  REMOTE_SHARE_MAX_BYTES,
  REMOTE_SHARE_MAX_ENCRYPTED_BYTES,
} from '../core/constants.ts';
import type { QueueItemId } from '../types/index.ts';

export interface RemoteUploadResponse {
  objectId: string;
  downloadUrl?: string;
  expiresAt: number;
  cleanupToken?: string;
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

export interface RemoteUploadMeta {
  roomId: string;
  name: string;
  mime: string;
  size: number;
  sessionId: number;
  queueItemId: QueueItemId;
}

export interface R2WholeBlobUploadMeta {
  readonly storageRoomId: string;
  readonly queueItemId: QueueItemId;
  readonly name: string;
  readonly mime: string;
  readonly plaintextSize: number;
}

export interface R2WholeBlobUploadResult {
  readonly objectId: string;
  readonly expiresAt: number;
  readonly cleanupToken: string;
}

export type R2WholeBlobDeleteResult = 'deleted' | 'not-found';

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
// Large files may legitimately take far longer than five minutes on mobile.
// Abort only when no bytes move for this window; steady slow transfers remain
// valid regardless of total wall-clock duration.
const REMOTE_SHARE_XHR_STALL_TIMEOUT_MS = 90_000;
const REMOTE_SHARE_SECURITY_CONFIG_CACHE_MS = 5 * 60_000;
const REMOTE_OBJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;
const CLEANUP_TOKEN_RE = REMOTE_OBJECT_ID_RE;
const MIME_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const MAX_NAME_LENGTH = 512;
const MAX_MIME_LENGTH = 128;
let remoteShareSecurityConfigCache: {
  endpoint: string;
  expiresAt: number;
  value: RemoteShareSecurityConfig;
} | null = null;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function assertV2Signal(signal: AbortSignal | undefined): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('REMOTE_SHARE_V2_SIGNAL_INVALID');
  }
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
}

function assertStorageRoomId(storageRoomId: unknown): asserts storageRoomId is string {
  if (typeof storageRoomId !== 'string' || !STORAGE_ROOM_ID_RE.test(storageRoomId)) {
    throw new Error('REMOTE_SHARE_V2_STORAGE_SCOPE_INVALID');
  }
}

function assertStorageObjectScope(
  storageRoomId: unknown,
  objectId: unknown,
): asserts objectId is string {
  assertStorageRoomId(storageRoomId);
  if (typeof objectId !== 'string' || !REMOTE_OBJECT_ID_RE.test(objectId)) {
    throw new Error('REMOTE_SHARE_V2_STORAGE_SCOPE_INVALID');
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function assertUploadMeta(meta: R2WholeBlobUploadMeta, encryptedBlob: Blob): void {
  if (!meta || typeof meta !== 'object') throw new TypeError('REMOTE_SHARE_V2_UPLOAD_META_INVALID');
  assertStorageRoomId(meta.storageRoomId);
  if (
    !QUEUE_ITEM_ID_RE.test(meta.queueItemId) ||
    typeof meta.name !== 'string' ||
    meta.name.trim().length === 0 ||
    meta.name.length > MAX_NAME_LENGTH ||
    containsControlCharacter(meta.name) ||
    typeof meta.mime !== 'string' ||
    meta.mime.length > MAX_MIME_LENGTH ||
    !MIME_PATTERN.test(meta.mime) ||
    !Number.isSafeInteger(meta.plaintextSize) ||
    meta.plaintextSize <= 0 ||
    meta.plaintextSize > REMOTE_SHARE_MAX_BYTES ||
    encryptedBlob.size !== meta.plaintextSize + REMOTE_SHARE_AES_GCM_TAG_BYTES
  ) {
    throw new Error('REMOTE_SHARE_V2_UPLOAD_META_INVALID');
  }
}

function createTransportSessionId(): number {
  const values = crypto.getRandomValues(new Uint32Array(2));
  const high = (values[0] ?? 0) & 0x1fffff;
  const low = values[1] ?? 0;
  const value = high * 0x1_0000_0000 + low;
  return value > 0 ? value : 1;
}

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

function expectedObjectUrl(roomId: string, objectId: string): URL {
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  return new URL(
    `${endpoint}/object/${encodeURIComponent(roomId)}/${encodeURIComponent(objectId)}`,
  );
}

/** V2-safe construction from the local configured endpoint; no wire URL is accepted. */
export function buildExactRemoteObjectDownloadUrl(storageRoomId: string, objectId: string): string {
  assertStorageObjectScope(storageRoomId, objectId);
  return expectedDownloadUrl(storageRoomId, objectId).toString();
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

function hasExactResponseUrl(response: Response, expectedUrl: string): boolean {
  if (response.redirected) return false;
  if (response.url === '') return true;
  try {
    return new URL(response.url).toString() === expectedUrl;
  } catch {
    return false;
  }
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
      typeof body.expiresAt !== 'number' ||
      (typeof body.cleanupToken === 'string' &&
        typeof session.cleanupToken === 'string' &&
        body.cleanupToken !== session.cleanupToken)
    ) {
      throw new Error('REMOTE_SHARE_BAD_COMPLETE_RESPONSE');
    }
    return {
      objectId: body.objectId,
      downloadUrl: body.downloadUrl,
      expiresAt: body.expiresAt,
      cleanupToken:
        typeof body.cleanupToken === 'string' ? body.cleanupToken : session.cleanupToken,
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

/**
 * V2 whole-Blob upload wrapper. The Worker-only numeric session identity is
 * generated internally, and endpoint/cleanup capabilities never enter offers.
 */
export async function uploadR2WholeBlobObject(
  encryptedBlob: Blob,
  meta: R2WholeBlobUploadMeta,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<Readonly<R2WholeBlobUploadResult>> {
  if (!(encryptedBlob instanceof Blob)) throw new TypeError('REMOTE_SHARE_V2_BLOB_INVALID');
  assertV2Signal(signal);
  assertUploadMeta(meta, encryptedBlob);
  const uploaded = await uploadEncryptedBlob(
    encryptedBlob,
    {
      roomId: meta.storageRoomId,
      name: meta.name,
      mime: meta.mime,
      size: meta.plaintextSize,
      sessionId: createTransportSessionId(),
      queueItemId: meta.queueItemId,
    },
    onProgress,
    signal,
  );
  assertV2Signal(signal);
  if (
    !REMOTE_OBJECT_ID_RE.test(uploaded.objectId) ||
    !Number.isSafeInteger(uploaded.expiresAt) ||
    uploaded.expiresAt <= 0 ||
    typeof uploaded.cleanupToken !== 'string' ||
    !CLEANUP_TOKEN_RE.test(uploaded.cleanupToken)
  ) {
    throw new Error('REMOTE_SHARE_V2_UPLOAD_RESULT_INVALID');
  }
  return freezeCanonical({
    objectId: uploaded.objectId,
    expiresAt: uploaded.expiresAt,
    cleanupToken: uploaded.cleanupToken,
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

/** V2 download entry point that cannot consume a host-supplied URL. */
export function downloadR2WholeBlobObject(
  storageRoomId: string,
  objectId: string,
  expectedEncryptedSize: number,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  assertStorageObjectScope(storageRoomId, objectId);
  assertV2Signal(signal);
  return downloadEncryptedObject(
    storageRoomId,
    objectId,
    expectedEncryptedSize,
    undefined,
    onProgress,
    signal,
  );
}

/** Best-effort exact-origin cleanup capability retained only by the host owner. */
export async function deleteR2WholeBlobObject(
  storageRoomId: string,
  objectId: string,
  cleanupToken: string,
  signal?: AbortSignal,
): Promise<R2WholeBlobDeleteResult> {
  assertStorageObjectScope(storageRoomId, objectId);
  if (typeof cleanupToken !== 'string' || !CLEANUP_TOKEN_RE.test(cleanupToken)) {
    throw new Error('REMOTE_SHARE_V2_CLEANUP_TOKEN_INVALID');
  }
  assertV2Signal(signal);
  const requestUrl = expectedObjectUrl(storageRoomId, objectId).toString();
  try {
    const response = await fetch(requestUrl, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        'x-mxqr-cleanup-token': cleanupToken,
      },
      redirect: 'error',
      signal,
    });
    assertV2Signal(signal);
    if (!hasExactResponseUrl(response, requestUrl)) {
      throw new Error('REMOTE_SHARE_DELETE_ORIGIN_INVALID');
    }
    if (response.status === 404) return 'not-found';
    if (response.status >= 200 && response.status < 300) return 'deleted';
    throw new Error(`REMOTE_SHARE_DELETE_HTTP_${response.status}`);
  } catch (error) {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) throw error;
    throw new Error('REMOTE_SHARE_DELETE_NETWORK', { cause: error });
  }
}
