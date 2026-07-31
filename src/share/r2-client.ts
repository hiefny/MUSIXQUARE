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
import { REMOTE_SHARE_MAX_BYTES, REMOTE_SHARE_MAX_ENCRYPTED_BYTES } from '../core/constants.ts';
import type { QueueItemId } from '../types/index.ts';
import { withRequestDeadline } from '../core/request-lifetime.ts';

export interface RemoteUploadResponse {
  objectId: string;
  downloadUrl?: string;
  expiresAt: number;
  cleanupToken?: string;
  downloadToken?: string;
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

export type ProgressHandler = (progress: number) => void;

/** Keep transport liveness byte-accurate while bounding presentation updates. */
function createDisplayProgressReporter(callback?: ProgressHandler): ProgressHandler {
  let previousPercent = -1;
  return (fraction): void => {
    const normalized = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    const percent = normalized >= 1 ? 100 : Math.floor(normalized * 100);
    if (percent === previousPercent) return;
    previousPercent = percent;
    callback?.(percent / 100);
  };
}

declare global {
  interface Window {
    __MUSIXQUARE_REMOTE_SHARE_ENDPOINT__?: unknown;
  }
}

interface RemoteShareSecurityConfig {
  capabilityRequired: boolean;
  plainWholeObjectVersion: number;
  downloadAuthorizationVersion: number;
}

const ENDPOINT_STORAGE_KEY = 'musixquare-remote-share-endpoint';
const PROD_ENDPOINT = 'https://share.musixquare.com';
// Large files may legitimately take far longer than five minutes on mobile.
// Abort only when no bytes move for this window; steady slow transfers remain
// valid regardless of total wall-clock duration.
const REMOTE_SHARE_XHR_STALL_TIMEOUT_MS = 90_000;
const REMOTE_SHARE_SECURITY_CONFIG_CACHE_MS = 5 * 60_000;
const REMOTE_SHARE_CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const REMOTE_SHARE_CONTROL_RESPONSE_MAX_BYTES = 64 * 1024;
const REMOTE_OBJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAIN_DOWNLOAD_TOKEN_MAX_LENGTH = 2048;
const PLAIN_DOWNLOAD_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
let remoteShareSecurityConfigCache: {
  endpoint: string;
  expiresAt: number;
  value: RemoteShareSecurityConfig;
} | null = null;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function readBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      finish();
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        finish();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      },
    );
  });
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('REMOTE_SHARE_CONTROL_RESPONSE_TOO_LARGE');
    }
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readBodyChunk(reader, signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error('REMOTE_SHARE_CONTROL_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Native fetch streams unlock after abort; a non-cooperative test or
      // custom stream must not keep the public request promise pinned.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new Error('REMOTE_SHARE_CONTROL_RESPONSE_INVALID', { cause: error });
  }
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

function expectedPlainDownloadUrl(roomId: string, objectId: string): URL {
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  return new URL(
    `${endpoint}/v3/plain/download/${encodeURIComponent(roomId)}/${encodeURIComponent(objectId)}`,
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

function buildPlainDownloadUrl(roomId: string, objectId: string, downloadUrl?: string): string {
  const expected = expectedPlainDownloadUrl(roomId, objectId);
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
    const payload = await withRequestDeadline(
      async (requestSignal) => {
        const response = await fetch(`${endpoint}/security-config`, {
          headers: { Accept: 'application/json' },
          signal: requestSignal,
        });
        if (!response.ok) {
          // This endpoint has no error-body contract. Release a streaming or
          // attacker-sized body before falling back to the conservative config.
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`REMOTE_SHARE_SECURITY_CONFIG_HTTP_${response.status}`);
        }
        return (await readBoundedJson(response, 8 * 1024, requestSignal)) as Record<
          string,
          unknown
        >;
      },
      {
        signal,
        timeoutMs: REMOTE_SHARE_CONTROL_REQUEST_TIMEOUT_MS,
        timeoutReason: 'REMOTE_SHARE_SECURITY_CONFIG_TIMEOUT',
      },
    );
    const value = {
      capabilityRequired: payload.capabilityRequired === true,
      plainWholeObjectVersion:
        payload.plainWholeObjectVersion === 1 ? payload.plainWholeObjectVersion : 0,
      downloadAuthorizationVersion:
        payload.downloadAuthorizationVersion === 1 ? payload.downloadAuthorizationVersion : 0,
    };
    remoteShareSecurityConfigCache = {
      endpoint,
      expiresAt: Date.now() + REMOTE_SHARE_SECURITY_CONFIG_CACHE_MS,
      value,
    };
    return value;
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      capabilityRequired: false,
      plainWholeObjectVersion: 0,
      downloadAuthorizationVersion: 0,
    };
  }
}

/** True only when the deployed Worker supports the isolated authenticated path. */
export async function supportsPlainWholeObjectUpload(signal?: AbortSignal): Promise<boolean> {
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) return false;
  const config = await getRemoteShareSecurityConfig(endpoint, signal);
  return config.plainWholeObjectVersion === 1 && config.downloadAuthorizationVersion === 1;
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
  uploadBlob: Blob,
  meta: RemoteUploadMeta,
  signal?: AbortSignal,
  storageFormat: 'aes-gcm-whole-v1' | 'plain-whole-v1' = 'aes-gcm-whole-v1',
): Promise<RemoteUploadSessionResponse> {
  try {
    const requestBody = JSON.stringify({
      roomId: meta.roomId,
      sessionId: meta.sessionId,
      queueItemId: meta.queueItemId,
      name: meta.name,
      mime: meta.mime || 'application/octet-stream',
      size: meta.size,
      ...(storageFormat === 'aes-gcm-whole-v1' ? { encryptedSize: uploadBlob.size } : {}),
    });
    const capabilityTarget = new URL('/api/capability-token', location.origin);
    const requestOnce = (capabilityHeaders: Record<string, string>) =>
      withRequestDeadline(
        async (requestSignal) => {
          const response = await fetch(
            `${endpoint}${storageFormat === 'plain-whole-v1' ? '/v3/plain/session' : '/session'}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...capabilityHeaders },
              body: requestBody,
              signal: requestSignal,
            },
          );
          let body: Partial<RemoteUploadSessionResponse> | null = null;
          try {
            body = (await readBoundedJson(
              response,
              REMOTE_SHARE_CONTROL_RESPONSE_MAX_BYTES,
              requestSignal,
            )) as Partial<RemoteUploadSessionResponse> | null;
          } catch (error) {
            // Invalid/oversized JSON remains an ordinary invalid response, but
            // an intrinsic deadline must escape so the caller can distinguish
            // a stalled control plane from a malformed completed response.
            if (requestSignal.aborted) throw error;
          }
          return { response, body };
        },
        {
          signal,
          timeoutMs: REMOTE_SHARE_CONTROL_REQUEST_TIMEOUT_MS,
          timeoutReason: 'REMOTE_SHARE_SESSION_TIMEOUT',
        },
      );
    let capabilityHeaders = await getRemoteShareSessionHeaders(endpoint, signal);
    let { response, body } = await requestOnce(capabilityHeaders);

    // A 401 may mean the token is stale or the capability probe was inaccurate.
    // Invalidate both caches, probe again, and retry once.
    if (response.status === 401) {
      if (capabilityHeaders['X-MXQR-Capability']) invalidateCapabilityToken(capabilityTarget);
      invalidateRemoteShareSecurityConfig(endpoint);
      capabilityHeaders = await getRemoteShareSessionHeaders(endpoint, signal);
      ({ response, body } = await requestOnce(capabilityHeaders));
    }

    if (!response.ok) {
      throw new Error(`REMOTE_SHARE_SESSION_HTTP_${response.status}`);
    }

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
  storageFormat: 'aes-gcm-whole-v1' | 'plain-whole-v1' = 'aes-gcm-whole-v1',
): Promise<RemoteUploadResponse> {
  try {
    const { response, body } = await withRequestDeadline(
      async (requestSignal) => {
        const response = await fetch(
          `${endpoint}${storageFormat === 'plain-whole-v1' ? '/v3/plain/complete' : '/complete'}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              roomId: meta.roomId,
              objectId: session.objectId,
              completeToken: session.completeToken,
            }),
            signal: requestSignal,
          },
        );
        let body: Partial<RemoteUploadResponse> | null = null;
        try {
          body = (await readBoundedJson(
            response,
            REMOTE_SHARE_CONTROL_RESPONSE_MAX_BYTES,
            requestSignal,
          )) as Partial<RemoteUploadResponse> | null;
        } catch (error) {
          if (requestSignal.aborted) throw error;
        }
        return { response, body };
      },
      {
        signal,
        timeoutMs: REMOTE_SHARE_CONTROL_REQUEST_TIMEOUT_MS,
        timeoutReason: 'REMOTE_SHARE_COMPLETE_TIMEOUT',
      },
    );

    if (!response.ok) throw new Error(`REMOTE_SHARE_COMPLETE_HTTP_${response.status}`);
    if (
      typeof body?.objectId !== 'string' ||
      body.objectId !== session.objectId ||
      typeof body.expiresAt !== 'number' ||
      (storageFormat === 'plain-whole-v1' &&
        (typeof body.downloadToken !== 'string' ||
          body.downloadToken.length < 32 ||
          body.downloadToken.length > PLAIN_DOWNLOAD_TOKEN_MAX_LENGTH ||
          !PLAIN_DOWNLOAD_TOKEN_RE.test(body.downloadToken))) ||
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
      downloadToken: typeof body.downloadToken === 'string' ? body.downloadToken : undefined,
    };
  } catch (error) {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) throw error;
    throw new Error('REMOTE_SHARE_COMPLETE_NETWORK', { cause: error });
  }
}

async function cleanupUploadSession(
  endpoint: string,
  session: RemoteUploadSessionResponse,
  meta: RemoteUploadMeta,
  storageFormat: 'aes-gcm-whole-v1' | 'plain-whole-v1' = 'aes-gcm-whole-v1',
): Promise<void> {
  if (!session.cleanupToken) return;
  try {
    await withRequestDeadline(
      async (signal) => {
        const response = await fetch(
          storageFormat === 'plain-whole-v1'
            ? `${endpoint}/v3/plain/object/${encodeURIComponent(meta.roomId)}/${encodeURIComponent(session.objectId)}`
            : `${endpoint}/object/${encodeURIComponent(meta.roomId)}/${encodeURIComponent(session.objectId)}`,
          {
            method: 'DELETE',
            headers: { 'x-mxqr-cleanup-token': session.cleanupToken! },
            keepalive: true,
            signal,
          },
        );
        // Best-effort cleanup has no response payload contract. Cancel the
        // bounded body instead of materializing an attacker-sized error page.
        await response.body?.cancel();
      },
      {
        timeoutMs: REMOTE_SHARE_CONTROL_REQUEST_TIMEOUT_MS,
        timeoutReason: 'REMOTE_SHARE_CLEANUP_TIMEOUT',
      },
    );
  } catch {
    // The object expires server-side even when this best-effort cleanup loses
    // a race with the direct PUT or the browser closes before it completes.
    // Cleanup is best effort and must never replace the original upload error.
  }
}

export async function uploadEncryptedBlob(
  encryptedBlob: Blob,
  meta: RemoteUploadMeta,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<RemoteUploadResponse> {
  return uploadWholeBlob(encryptedBlob, meta, 'aes-gcm-whole-v1', onProgress, signal);
}

/** Upload one private plaintext object when the Worker advertises whole-object support. */
export async function uploadPlainBlob(
  plainBlob: Blob,
  meta: RemoteUploadMeta,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<RemoteUploadResponse & { downloadToken: string }> {
  if (plainBlob.size !== meta.size) throw new Error('REMOTE_SHARE_PLAINTEXT_SIZE_MISMATCH');
  if (!(await supportsPlainWholeObjectUpload(signal))) {
    throw new Error('REMOTE_SHARE_PLAIN_PROTOCOL_UNAVAILABLE');
  }
  const uploaded = await uploadWholeBlob(plainBlob, meta, 'plain-whole-v1', onProgress, signal);
  if (typeof uploaded.downloadToken !== 'string') {
    throw new Error('REMOTE_SHARE_BAD_COMPLETE_RESPONSE');
  }
  return { ...uploaded, downloadToken: uploaded.downloadToken };
}

async function uploadWholeBlob(
  uploadBlob: Blob,
  meta: RemoteUploadMeta,
  storageFormat: 'aes-gcm-whole-v1' | 'plain-whole-v1',
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<RemoteUploadResponse> {
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');

  const session = await requestUploadSession(endpoint, uploadBlob, meta, signal, storageFormat);
  const reportProgress = createDisplayProgressReporter(onProgress);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let xhrFinalized = false;
    const xhrLifecycle: {
      stall?: ReturnType<typeof createXhrStallWatchdog>;
      detachAbort?: (() => void) | null;
    } = {};
    const finalizeXhr = (): void => {
      if (xhrFinalized) return;
      xhrFinalized = true;
      xhrLifecycle.stall?.clear();
      xhrLifecycle.detachAbort?.();
      xhrLifecycle.detachAbort = undefined;
    };
    const rejectWithCleanup = (error: Error): void => {
      if (settled) return;
      settled = true;
      finalizeXhr();
      void cleanupUploadSession(endpoint, session, meta, storageFormat);
      reject(error);
    };
    try {
      xhr.open('PUT', session.uploadUrl, true);
      for (const [header, value] of Object.entries(session.uploadHeaders)) {
        xhr.setRequestHeader(header, value);
      }
    } catch (error) {
      rejectWithCleanup(new Error('REMOTE_SHARE_UPLOAD_NETWORK', { cause: error }));
      return;
    }

    xhrLifecycle.stall = createXhrStallWatchdog(
      xhr,
      rejectWithCleanup,
      'REMOTE_SHARE_UPLOAD_STALLED',
    );
    xhrLifecycle.detachAbort = wireAbort(xhr, rejectWithCleanup, signal, finalizeXhr);
    if (xhrLifecycle.detachAbort === null) {
      finalizeXhr();
      return;
    }

    let lastUploadedBytes = 0;
    xhr.upload.onprogress = (event) => {
      if (event.loaded > lastUploadedBytes) {
        lastUploadedBytes = event.loaded;
        xhrLifecycle.stall?.reset();
      }
      if (event.lengthComputable && onProgress) {
        reportProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      finalizeXhr();
      if (xhr.status >= 200 && xhr.status < 300) {
        void completeDirectUpload(endpoint, session, meta, signal, storageFormat).then((body) => {
          if (settled) return;
          settled = true;
          reportProgress(1);
          resolve(body);
        }, rejectWithCleanup);
        return;
      }
      rejectWithCleanup(new Error(`REMOTE_SHARE_DIRECT_UPLOAD_HTTP_${xhr.status}`));
    };
    xhr.onerror = () => {
      rejectWithCleanup(new Error('REMOTE_SHARE_UPLOAD_NETWORK'));
    };
    try {
      xhr.send(uploadBlob);
    } catch (error) {
      rejectWithCleanup(
        signal?.aborted
          ? new Error('REMOTE_SHARE_ABORTED', { cause: error })
          : new Error('REMOTE_SHARE_UPLOAD_NETWORK', { cause: error }),
      );
    }
  });
}

/** Download one private encrypted whole object. */
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
    const reportProgress = createDisplayProgressReporter(onProgress);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', requestUrl, true);
    xhr.responseType = 'arraybuffer';

    let settled = false;
    let xhrFinalized = false;
    const xhrLifecycle: {
      stall?: ReturnType<typeof createXhrStallWatchdog>;
      detachAbort?: (() => void) | null;
    } = {};
    const finalizeXhr = (): void => {
      if (xhrFinalized) return;
      xhrFinalized = true;
      xhrLifecycle.stall?.clear();
      xhrLifecycle.detachAbort?.();
      xhrLifecycle.detachAbort = undefined;
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      finalizeXhr();
      reject(error);
    };
    const resolveOnce = (value: ArrayBuffer): void => {
      if (settled) return;
      settled = true;
      finalizeXhr();
      resolve(value);
    };

    xhrLifecycle.stall = createXhrStallWatchdog(xhr, rejectOnce, 'REMOTE_SHARE_DOWNLOAD_STALLED');
    xhrLifecycle.detachAbort = wireAbort(xhr, rejectOnce, signal, finalizeXhr);
    if (xhrLifecycle.detachAbort === null) {
      finalizeXhr();
      return;
    }

    let lastDownloadedBytes = 0;
    xhr.onprogress = (event) => {
      if (
        event.loaded > expectedEncryptedSize ||
        (event.lengthComputable && event.total !== expectedEncryptedSize)
      ) {
        finalizeXhr();
        try {
          xhr.abort();
        } catch {
          /* ignore */
        }
        rejectOnce(new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'));
        return;
      }
      if (event.loaded > lastDownloadedBytes) {
        lastDownloadedBytes = event.loaded;
        xhrLifecycle.stall?.reset();
      }
      if (event.lengthComputable && onProgress) {
        reportProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      finalizeXhr();
      try {
        if (
          !xhr.responseURL ||
          buildDownloadUrl(roomId, objectId, xhr.responseURL) !== new URL(requestUrl).toString()
        ) {
          rejectOnce(new Error('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID'));
          return;
        }
      } catch {
        rejectOnce(new Error('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID'));
        return;
      }
      if (
        xhr.status >= 200 &&
        xhr.status < 300 &&
        xhr.response instanceof ArrayBuffer &&
        xhr.response.byteLength === expectedEncryptedSize
      ) {
        reportProgress(1);
        resolveOnce(xhr.response);
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response instanceof ArrayBuffer) {
        rejectOnce(new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'));
        return;
      }
      rejectOnce(new Error(`REMOTE_SHARE_DOWNLOAD_HTTP_${xhr.status}`));
    };
    xhr.onerror = () => {
      rejectOnce(new Error('REMOTE_SHARE_DOWNLOAD_NETWORK'));
    };
    try {
      xhr.send();
    } catch (error) {
      rejectOnce(
        signal?.aborted
          ? new Error('REMOTE_SHARE_ABORTED', { cause: error })
          : new Error('REMOTE_SHARE_DOWNLOAD_NETWORK', { cause: error }),
      );
    }
  });
}

/** Download one private plaintext object with participant-delivered read authority. */
export function downloadPlainObject(
  roomId: string,
  objectId: string,
  expectedSize: number,
  downloadToken: string,
  downloadUrl?: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize <= 0 ||
      expectedSize > REMOTE_SHARE_MAX_BYTES
    ) {
      reject(new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'));
      return;
    }
    if (
      typeof downloadToken !== 'string' ||
      downloadToken.length < 32 ||
      downloadToken.length > PLAIN_DOWNLOAD_TOKEN_MAX_LENGTH ||
      !PLAIN_DOWNLOAD_TOKEN_RE.test(downloadToken)
    ) {
      reject(new Error('REMOTE_SHARE_DOWNLOAD_AUTH_INVALID'));
      return;
    }

    const requestUrl = buildPlainDownloadUrl(roomId, objectId, downloadUrl);
    const reportProgress = createDisplayProgressReporter(onProgress);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', requestUrl, true);
    xhr.setRequestHeader('Authorization', `Bearer ${downloadToken}`);
    xhr.responseType = 'arraybuffer';

    let settled = false;
    let xhrFinalized = false;
    const xhrLifecycle: {
      stall?: ReturnType<typeof createXhrStallWatchdog>;
      detachAbort?: (() => void) | null;
    } = {};
    const finalizeXhr = (): void => {
      if (xhrFinalized) return;
      xhrFinalized = true;
      xhrLifecycle.stall?.clear();
      xhrLifecycle.detachAbort?.();
      xhrLifecycle.detachAbort = undefined;
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      finalizeXhr();
      reject(error);
    };
    const resolveOnce = (value: ArrayBuffer): void => {
      if (settled) return;
      settled = true;
      finalizeXhr();
      resolve(value);
    };

    xhrLifecycle.stall = createXhrStallWatchdog(xhr, rejectOnce, 'REMOTE_SHARE_DOWNLOAD_STALLED');
    xhrLifecycle.detachAbort = wireAbort(xhr, rejectOnce, signal, finalizeXhr);
    if (xhrLifecycle.detachAbort === null) {
      finalizeXhr();
      return;
    }

    let lastDownloadedBytes = 0;
    xhr.onprogress = (event) => {
      if (event.loaded > expectedSize || (event.lengthComputable && event.total !== expectedSize)) {
        finalizeXhr();
        try {
          xhr.abort();
        } catch {
          /* ignore */
        }
        rejectOnce(new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'));
        return;
      }
      if (event.loaded > lastDownloadedBytes) {
        lastDownloadedBytes = event.loaded;
        xhrLifecycle.stall?.reset();
      }
      if (event.lengthComputable && onProgress) reportProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      finalizeXhr();
      try {
        if (
          !xhr.responseURL ||
          buildPlainDownloadUrl(roomId, objectId, xhr.responseURL) !==
            new URL(requestUrl).toString()
        ) {
          rejectOnce(new Error('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID'));
          return;
        }
      } catch {
        rejectOnce(new Error('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID'));
        return;
      }
      if (
        xhr.status >= 200 &&
        xhr.status < 300 &&
        xhr.response instanceof ArrayBuffer &&
        xhr.response.byteLength === expectedSize
      ) {
        reportProgress(1);
        resolveOnce(xhr.response);
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response instanceof ArrayBuffer) {
        rejectOnce(new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'));
        return;
      }
      rejectOnce(new Error(`REMOTE_SHARE_DOWNLOAD_HTTP_${xhr.status}`));
    };
    xhr.onerror = () => rejectOnce(new Error('REMOTE_SHARE_DOWNLOAD_NETWORK'));
    try {
      xhr.send();
    } catch (error) {
      rejectOnce(
        signal?.aborted
          ? new Error('REMOTE_SHARE_ABORTED', { cause: error })
          : new Error('REMOTE_SHARE_DOWNLOAD_NETWORK', { cause: error }),
      );
    }
  });
}
