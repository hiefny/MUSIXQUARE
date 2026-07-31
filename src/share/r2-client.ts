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

export interface R2RecordSetCreateMeta {
  readonly storageRoomId: string;
  readonly applicationSessionId: string;
  /**
   * Publisher-owned logical publication identity. It is carried only in the
   * Idempotency-Key header and never enters a public descriptor or signed set
   * token.
   */
  readonly publicationIntentId?: string;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly name: string;
  readonly mime: string;
  readonly plaintextSize: number;
  readonly recordSize: number;
  readonly recordCount: number;
}

export interface R2RecordSetRecord {
  readonly index: number;
  readonly objectId: string;
  readonly plaintextSize: number;
  readonly encryptedSize: number;
  readonly downloadUrl: string;
}

/**
 * Upload authority is host-private. Only the public geometry, exact record
 * URLs and the separate crypto secret descriptor may cross signaling.
 */
export interface R2RecordSetUploadSession {
  readonly v: 2;
  readonly storageRoomId: string;
  readonly setId: string;
  readonly recordSize: number;
  readonly recordCount: number;
  readonly expiresAt: number;
  readonly setToken: string;
  readonly cleanupToken: string;
  readonly records: readonly Readonly<R2RecordSetRecord>[];
}

export interface R2RecordUploadAuthority {
  readonly v: 2;
  readonly setId: string;
  readonly index: number;
  readonly objectId: string;
  readonly plaintextSize: number;
  readonly encryptedSize: number;
  readonly uploadUrl: string;
  readonly uploadHeaders: Readonly<Record<string, string>>;
  readonly uploadUrlExpiresAt: number;
  readonly expiresAt: number;
  readonly downloadUrl: string;
}

export interface R2RecordCompletion {
  readonly v: 2;
  readonly setId: string;
  readonly index: number;
  readonly objectId: string;
  readonly expiresAt: number;
  readonly readyRecordCount: number;
  readonly recordCount: number;
  readonly complete: boolean;
  readonly downloadUrl: string;
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
  recordSetCreateIdempotency: boolean;
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
// A keyed retry is safe after an ambiguous commit. Two bounded attempts retain
// the old 30-second total ceiling while recovering a lost first response.
const REMOTE_SHARE_RECORD_SET_CREATE_TIMEOUT_MS = 15_000;
const REMOTE_SHARE_RECORD_SET_CREATE_LEGACY_TIMEOUT_MS = 30_000;
const REMOTE_SHARE_RECORD_SET_CREATE_ATTEMPTS = 2;
const REMOTE_SHARE_RECORD_SET_CREATE_RETRY_DELAY_MS = 150;
const REMOTE_SHARE_RECORD_SET_CANCEL_TIMEOUT_MS = 10_000;
const REMOTE_SHARE_CONTROL_RESPONSE_MAX_BYTES = 64 * 1024;
const REMOTE_OBJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;
const CLEANUP_TOKEN_RE = REMOTE_OBJECT_ID_RE;
const MIME_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const MAX_NAME_LENGTH = 512;
const MAX_MIME_LENGTH = 128;
const R2_RECORD_SET_VERSION = 2 as const;
const R2_RECORD_PLAINTEXT_BYTES = 8 * 1024 * 1024;
const R2_RECORD_MAX_IDENTIFIER_LENGTH = 256;
const R2_RECORD_CONTROL_TOKEN_MAX_LENGTH = 8 * 1024;
const PLAIN_DOWNLOAD_TOKEN_MAX_LENGTH = 2048;
const PLAIN_DOWNLOAD_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
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

function isRecordIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= R2_RECORD_MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function assertRecordSetMeta(meta: R2RecordSetCreateMeta): void {
  if (!meta || typeof meta !== 'object') {
    throw new TypeError('REMOTE_SHARE_RECORD_SET_META_INVALID');
  }
  assertStorageRoomId(meta.storageRoomId);
  if (
    !/^[1-9]\d{5}$/u.test(meta.storageRoomId) ||
    !isRecordIdentifier(meta.applicationSessionId) ||
    (meta.publicationIntentId !== undefined &&
      !IDEMPOTENCY_KEY_RE.test(meta.publicationIntentId)) ||
    !QUEUE_ITEM_ID_RE.test(meta.queueItemId) ||
    !isRecordIdentifier(meta.sourceIdentity) ||
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
    meta.recordSize !== R2_RECORD_PLAINTEXT_BYTES ||
    !Number.isSafeInteger(meta.recordCount) ||
    meta.recordCount !== Math.ceil(meta.plaintextSize / meta.recordSize)
  ) {
    throw new Error('REMOTE_SHARE_RECORD_SET_META_INVALID');
  }
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

function expectedObjectUrl(roomId: string, objectId: string): URL {
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  return new URL(
    `${endpoint}/object/${encodeURIComponent(roomId)}/${encodeURIComponent(objectId)}`,
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
      recordSetCreateIdempotency: payload.recordSetCreateIdempotency === true,
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
      recordSetCreateIdempotency: false,
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

async function requestRecordSetControl(
  endpoint: string,
  path: string,
  init: {
    readonly method: 'POST';
    readonly body: string;
    readonly capability?: boolean;
    readonly headers?: Readonly<Record<string, string>>;
    readonly keepalive?: boolean;
    readonly timeoutMs?: number;
    readonly timeoutReason: string;
  },
  signal?: AbortSignal,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const capabilityTarget = new URL('/api/capability-token', location.origin);
  const requestOnce = (capabilityHeaders: Record<string, string>) =>
    withRequestDeadline(
      async (requestSignal) => {
        const response = await fetch(`${endpoint}${path}`, {
          method: init.method,
          headers: {
            Accept: 'application/json',
            'content-type': 'application/json',
            ...init.headers,
            ...capabilityHeaders,
          },
          body: init.body,
          keepalive: init.keepalive,
          signal: requestSignal,
        });
        let body: unknown = null;
        try {
          body = await readBoundedJson(
            response,
            REMOTE_SHARE_CONTROL_RESPONSE_MAX_BYTES,
            requestSignal,
          );
        } catch (error) {
          if (requestSignal.aborted) throw error;
        }
        return { response, body };
      },
      {
        signal,
        timeoutMs: init.timeoutMs ?? REMOTE_SHARE_CONTROL_REQUEST_TIMEOUT_MS,
        timeoutReason: init.timeoutReason,
      },
    );

  let capabilityHeaders = init.capability
    ? await getRemoteShareSessionHeaders(endpoint, signal)
    : {};
  let result = await requestOnce(capabilityHeaders);
  if (init.capability && result.response.status === 401) {
    if (capabilityHeaders['X-MXQR-Capability']) invalidateCapabilityToken(capabilityTarget);
    invalidateRemoteShareSecurityConfig(endpoint);
    capabilityHeaders = await getRemoteShareSessionHeaders(endpoint, signal);
    result = await requestOnce(capabilityHeaders);
  }
  return result;
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

/** Upload an unencrypted private object only when the Worker advertises v1 support. */
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
    await response.body?.cancel();
    if (response.status === 404) return 'not-found';
    if (response.status >= 200 && response.status < 300) return 'deleted';
    throw new Error(`REMOTE_SHARE_DELETE_HTTP_${response.status}`);
  } catch (error) {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) throw error;
    throw new Error('REMOTE_SHARE_DELETE_NETWORK', { cause: error });
  }
}

function isRecordControlToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 32 &&
    value.length <= R2_RECORD_CONTROL_TOKEN_MAX_LENGTH &&
    !containsControlCharacter(value)
  );
}

function isExactRecordDownloadUrl(
  storageRoomId: string,
  objectId: string,
  value: unknown,
): value is string {
  if (typeof value !== 'string') return false;
  try {
    return (
      buildDownloadUrl(storageRoomId, objectId, value) ===
      expectedDownloadUrl(storageRoomId, objectId).toString()
    );
  } catch {
    return false;
  }
}

export async function createR2RecordSet(
  meta: R2RecordSetCreateMeta,
  signal?: AbortSignal,
): Promise<Readonly<R2RecordSetUploadSession>> {
  assertV2Signal(signal);
  assertRecordSetMeta(meta);
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  const requestBody = JSON.stringify({
    roomId: meta.storageRoomId,
    sessionId: meta.applicationSessionId,
    queueItemId: meta.queueItemId,
    sourceIdentity: meta.sourceIdentity,
    name: meta.name,
    mime: meta.mime,
    size: meta.plaintextSize,
    recordSize: meta.recordSize,
    recordCount: meta.recordCount,
  });
  let requestStarted = false;
  let idempotencyKey: string | null = null;
  let idempotencySupported = false;
  try {
    const securityConfig = await getRemoteShareSecurityConfig(endpoint, signal);
    idempotencySupported = securityConfig.recordSetCreateIdempotency;
    if (meta.publicationIntentId && !idempotencySupported) {
      // Product publishers own a stable logical intent. Never silently
      // downgrade that intent to the legacy unkeyed endpoint: an ambiguous
      // legacy commit could be repeated by a later publish attempt.
      throw new Error('REMOTE_SHARE_RECORD_SET_IDEMPOTENCY_UNSUPPORTED');
    }
    if (idempotencySupported) {
      idempotencyKey = meta.publicationIntentId ?? crypto.randomUUID();
      if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
        throw new Error('REMOTE_SHARE_RECORD_SET_IDEMPOTENCY_KEY_INVALID');
      }
    }

    const attempts = idempotencySupported ? REMOTE_SHARE_RECORD_SET_CREATE_ATTEMPTS : 1;
    let lastError: unknown = new Error('REMOTE_SHARE_RECORD_SET_CREATE_NETWORK');
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        requestStarted = true;
        const { response, body } = await requestRecordSetControl(
          endpoint,
          idempotencySupported ? '/v2/sets/idempotent' : '/v2/sets',
          {
            method: 'POST',
            capability: true,
            headers: idempotencyKey ? { 'X-MXQR-Idempotency-Key': idempotencyKey } : undefined,
            timeoutMs: idempotencySupported
              ? REMOTE_SHARE_RECORD_SET_CREATE_TIMEOUT_MS
              : REMOTE_SHARE_RECORD_SET_CREATE_LEGACY_TIMEOUT_MS,
            timeoutReason: 'REMOTE_SHARE_RECORD_SET_CREATE_TIMEOUT',
            body: requestBody,
          },
          signal,
        );
        if (
          response.status === 409 &&
          body &&
          typeof body === 'object' &&
          (body as { code?: unknown }).code === 'IDEMPOTENCY_CONFLICT'
        ) {
          throw new Error('REMOTE_SHARE_RECORD_SET_CREATE_IDEMPOTENCY_CONFLICT');
        }
        if (
          response.status === 409 &&
          body &&
          typeof body === 'object' &&
          (body as { code?: unknown }).code === 'ROOM_STORAGE_QUOTA_EXCEEDED'
        ) {
          throw new Error('REMOTE_SHARE_RECORD_SET_CREATE_QUOTA_EXCEEDED');
        }
        if (idempotencySupported && response.status === 409) {
          // A keyed conflict response with a missing or malformed body must remain
          // bound to this intent. Rotating the UUID could otherwise bypass a real
          // idempotency conflict whose response body was lost in transit.
          throw new Error('REMOTE_SHARE_RECORD_SET_CREATE_IDEMPOTENCY_CONFLICT');
        }
        if (
          response.status === 410 &&
          body &&
          typeof body === 'object' &&
          (body as { code?: unknown }).code === 'CREATE_INTENT_CANCELED'
        ) {
          throw new Error('REMOTE_SHARE_RECORD_SET_CREATE_INTENT_CANCELED');
        }
        if (!response.ok) {
          throw new Error(`REMOTE_SHARE_RECORD_SET_CREATE_HTTP_${response.status}`);
        }
        return parseR2RecordSetCreateResponse(meta, body);
      } catch (error) {
        lastError = error;
        if (
          attempt === attempts - 1 ||
          signal?.aborted ||
          isCapabilityChallengeCancelled(error) ||
          !isRetryableRecordSetCreateError(error)
        ) {
          break;
        }
        await waitForRecordSetCreateRetry(signal);
      }
    }
    throw lastError;
  } catch (error) {
    if (signal?.aborted) {
      if (idempotencySupported && idempotencyKey && requestStarted) {
        void sendR2RecordSetCreateIntentCancellation(endpoint, requestBody, idempotencyKey).catch(
          () => undefined,
        );
      }
      throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    }
    if (isCapabilityChallengeCancelled(error)) throw error;
    if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) throw error;
    throw new Error('REMOTE_SHARE_RECORD_SET_CREATE_NETWORK', { cause: error });
  }
}

function parseR2RecordSetCreateResponse(
  meta: R2RecordSetCreateMeta,
  body: unknown,
): Readonly<R2RecordSetUploadSession> {
  const value = body as Partial<R2RecordSetUploadSession> | null;
  if (
    value?.v !== R2_RECORD_SET_VERSION ||
    !REMOTE_OBJECT_ID_RE.test(String(value.setId ?? '')) ||
    value.recordSize !== meta.recordSize ||
    value.recordCount !== meta.recordCount ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt ?? 0) <= Date.now() ||
    !isRecordControlToken(value.setToken) ||
    !CLEANUP_TOKEN_RE.test(String(value.cleanupToken ?? '')) ||
    !Array.isArray(value.records) ||
    value.records.length !== meta.recordCount
  ) {
    throw new Error('REMOTE_SHARE_RECORD_SET_CREATE_RESPONSE_INVALID');
  }
  const records = value.records.map((record, index) => {
    const expectedPlaintextSize =
      index === meta.recordCount - 1
        ? meta.plaintextSize - index * meta.recordSize
        : meta.recordSize;
    if (
      !record ||
      record.index !== index ||
      !REMOTE_OBJECT_ID_RE.test(record.objectId) ||
      record.plaintextSize !== expectedPlaintextSize ||
      record.encryptedSize !== expectedPlaintextSize + REMOTE_SHARE_AES_GCM_TAG_BYTES ||
      !isExactRecordDownloadUrl(meta.storageRoomId, record.objectId, record.downloadUrl)
    ) {
      throw new Error('REMOTE_SHARE_RECORD_SET_CREATE_RESPONSE_INVALID');
    }
    return freezeCanonical({
      index,
      objectId: record.objectId,
      plaintextSize: record.plaintextSize,
      encryptedSize: record.encryptedSize,
      downloadUrl: expectedDownloadUrl(meta.storageRoomId, record.objectId).toString(),
    });
  });
  return freezeCanonical({
    v: R2_RECORD_SET_VERSION,
    storageRoomId: meta.storageRoomId,
    setId: value.setId as string,
    recordSize: meta.recordSize,
    recordCount: meta.recordCount,
    expiresAt: value.expiresAt as number,
    setToken: value.setToken as string,
    cleanupToken: value.cleanupToken as string,
    records: Object.freeze(records),
  });
}

function isRetryableRecordSetCreateError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return (
    error.message === 'REMOTE_SHARE_RECORD_SET_CREATE_TIMEOUT' ||
    error.message === 'REMOTE_SHARE_RECORD_SET_CREATE_NETWORK' ||
    error.message === 'REMOTE_SHARE_RECORD_SET_CREATE_RESPONSE_INVALID' ||
    /^REMOTE_SHARE_RECORD_SET_CREATE_HTTP_(?:408|425|500|502|503|504)$/u.test(error.message) ||
    !error.message.startsWith('REMOTE_SHARE_')
  );
}

function waitForRecordSetCreateRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal ? abortReason(signal) : new DOMException('Aborted', 'AbortError'));
    };
    const timer = globalThis.setTimeout(finish, REMOTE_SHARE_RECORD_SET_CREATE_RETRY_DELAY_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function sendR2RecordSetCreateIntentCancellation(
  endpoint: string,
  body: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<void> {
  const { response } = await requestRecordSetControl(
    endpoint,
    '/v2/sets/intents/cancel',
    {
      method: 'POST',
      body,
      capability: true,
      headers: { 'X-MXQR-Idempotency-Key': idempotencyKey },
      keepalive: true,
      timeoutMs: REMOTE_SHARE_RECORD_SET_CANCEL_TIMEOUT_MS,
      timeoutReason: 'REMOTE_SHARE_RECORD_SET_CANCEL_TIMEOUT',
    },
    signal,
  );
  if (!response.ok) {
    throw new Error(`REMOTE_SHARE_RECORD_SET_CANCEL_HTTP_${response.status}`);
  }
}

/**
 * Fence a publisher-owned create intent that never yielded cleanup authority.
 * Exact retries are safe; unsupported legacy Workers are left to their fixed
 * object expiry because they never admitted the idempotency contract.
 */
export async function cancelR2RecordSetCreateIntent(
  meta: R2RecordSetCreateMeta,
  signal?: AbortSignal,
): Promise<void> {
  assertV2Signal(signal);
  assertRecordSetMeta(meta);
  if (!meta.publicationIntentId) {
    throw new Error('REMOTE_SHARE_RECORD_SET_IDEMPOTENCY_KEY_INVALID');
  }
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  const securityConfig = await getRemoteShareSecurityConfig(endpoint, signal);
  const body = JSON.stringify({
    roomId: meta.storageRoomId,
    sessionId: meta.applicationSessionId,
    queueItemId: meta.queueItemId,
    sourceIdentity: meta.sourceIdentity,
    name: meta.name,
    mime: meta.mime,
    size: meta.plaintextSize,
    recordSize: meta.recordSize,
    recordCount: meta.recordCount,
  });
  try {
    await sendR2RecordSetCreateIntentCancellation(endpoint, body, meta.publicationIntentId, signal);
  } catch (error) {
    if (error instanceof Error && error.message === 'REMOTE_SHARE_RECORD_SET_CANCEL_HTTP_404') {
      if (!securityConfig.recordSetCreateIdempotency) return;
      // A cached `true` can outlive a Worker rollback. Re-probe once so a
      // rollback Worker without the cancellation route falls back to the
      // immutable object-expiry fence instead of making room teardown fail.
      invalidateRemoteShareSecurityConfig(endpoint);
      const refreshedConfig = await getRemoteShareSecurityConfig(endpoint, signal);
      if (!refreshedConfig.recordSetCreateIdempotency) return;
    }
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    if (isCapabilityChallengeCancelled(error)) throw error;
    if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) throw error;
    throw new Error('REMOTE_SHARE_RECORD_SET_CANCEL_NETWORK', { cause: error });
  }
}

export async function requestR2RecordUploadAuthority(
  session: Readonly<R2RecordSetUploadSession>,
  recordIndex: number,
  signal?: AbortSignal,
): Promise<Readonly<R2RecordUploadAuthority>> {
  assertStorageRoomId(session.storageRoomId);
  if (
    session.v !== R2_RECORD_SET_VERSION ||
    !REMOTE_OBJECT_ID_RE.test(session.setId) ||
    !isRecordControlToken(session.setToken) ||
    !Number.isSafeInteger(recordIndex) ||
    recordIndex < 0 ||
    recordIndex >= session.recordCount
  ) {
    throw new Error('REMOTE_SHARE_RECORD_UPLOAD_AUTHORITY_INVALID');
  }
  assertV2Signal(signal);
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  const path = `/v2/sets/${encodeURIComponent(session.storageRoomId)}/${encodeURIComponent(session.setId)}/records/${recordIndex}/upload`;
  try {
    const { response, body } = await requestRecordSetControl(
      endpoint,
      path,
      {
        method: 'POST',
        timeoutReason: 'REMOTE_SHARE_RECORD_UPLOAD_AUTHORITY_TIMEOUT',
        body: JSON.stringify({ setToken: session.setToken }),
      },
      signal,
    );
    if (!response.ok) {
      throw new Error(`REMOTE_SHARE_RECORD_UPLOAD_AUTHORITY_HTTP_${response.status}`);
    }
    const value = body as Partial<R2RecordUploadAuthority> | null;
    const record = session.records[recordIndex];
    if (
      !record ||
      value?.v !== R2_RECORD_SET_VERSION ||
      value.setId !== session.setId ||
      value.index !== recordIndex ||
      value.objectId !== record.objectId ||
      value.plaintextSize !== record.plaintextSize ||
      value.encryptedSize !== record.encryptedSize ||
      typeof value.uploadUrl !== 'string' ||
      !value.uploadHeaders ||
      typeof value.uploadHeaders !== 'object' ||
      !Number.isSafeInteger(value.uploadUrlExpiresAt) ||
      (value.uploadUrlExpiresAt ?? 0) <= Date.now() ||
      value.expiresAt !== session.expiresAt ||
      !isExactRecordDownloadUrl(session.storageRoomId, record.objectId, value.downloadUrl)
    ) {
      throw new Error('REMOTE_SHARE_RECORD_UPLOAD_AUTHORITY_RESPONSE_INVALID');
    }
    let uploadUrl: URL;
    try {
      uploadUrl = new URL(value.uploadUrl);
    } catch {
      throw new Error('REMOTE_SHARE_RECORD_UPLOAD_URL_INVALID');
    }
    if (
      uploadUrl.protocol !== 'https:' ||
      uploadUrl.username !== '' ||
      uploadUrl.password !== '' ||
      uploadUrl.hash !== ''
    ) {
      throw new Error('REMOTE_SHARE_RECORD_UPLOAD_URL_INVALID');
    }
    const uploadHeaders: Record<string, string> = Object.create(null);
    for (const [key, headerValue] of Object.entries(value.uploadHeaders)) {
      if (
        typeof headerValue !== 'string' ||
        key.length === 0 ||
        containsControlCharacter(key) ||
        containsControlCharacter(headerValue)
      ) {
        throw new Error('REMOTE_SHARE_RECORD_UPLOAD_AUTHORITY_RESPONSE_INVALID');
      }
      uploadHeaders[key] = headerValue;
    }
    return freezeCanonical({
      v: R2_RECORD_SET_VERSION,
      setId: session.setId,
      index: recordIndex,
      objectId: record.objectId,
      plaintextSize: record.plaintextSize,
      encryptedSize: record.encryptedSize,
      uploadUrl: uploadUrl.toString(),
      uploadHeaders: freezeCanonical(uploadHeaders),
      uploadUrlExpiresAt: value.uploadUrlExpiresAt as number,
      expiresAt: session.expiresAt,
      downloadUrl: expectedDownloadUrl(session.storageRoomId, record.objectId).toString(),
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) throw error;
    throw new Error('REMOTE_SHARE_RECORD_UPLOAD_AUTHORITY_NETWORK', { cause: error });
  }
}

/**
 * Upload one immutable ciphertext lease. A retry must call this again with
 * this exact Blob; the crypto layer forbids producing a second ciphertext for
 * the same record nonce.
 */
export function uploadR2RecordCiphertext(
  authority: Readonly<R2RecordUploadAuthority>,
  ciphertext: Blob,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<void> {
  assertV2Signal(signal);
  if (
    !(ciphertext instanceof Blob) ||
    ciphertext.size !== authority.encryptedSize ||
    typeof authority.uploadUrl !== 'string' ||
    !authority.uploadHeaders ||
    typeof authority.uploadHeaders !== 'object'
  ) {
    return Promise.reject(new Error('REMOTE_SHARE_RECORD_UPLOAD_INPUT_INVALID'));
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', authority.uploadUrl, true);
    for (const [key, value] of Object.entries(authority.uploadHeaders)) {
      xhr.setRequestHeader(key, value);
    }
    const reportProgress = createDisplayProgressReporter(onProgress);
    let settled = false;
    let uploadedBytes = 0;
    // `wireAbort` may synchronously call `finish`, so this must be initialized
    // before its right-hand side runs rather than declared as a `const`.
    let detachAbort: (() => void) | null | undefined = undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      watchdog.clear();
      detachAbort?.();
      if (error) reject(error);
      else resolve();
    };
    const watchdog = createXhrStallWatchdog(
      xhr,
      (error) => finish(error),
      'REMOTE_SHARE_RECORD_UPLOAD_STALLED',
    );
    detachAbort = wireAbort(xhr, (error) => finish(error), signal, watchdog.clear);
    if (detachAbort === null) {
      watchdog.clear();
      return;
    }
    xhr.upload.onprogress = (event) => {
      if (event.loaded > uploadedBytes) {
        uploadedBytes = event.loaded;
        watchdog.reset();
      }
      if (event.lengthComputable && event.total === ciphertext.size) {
        reportProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        reportProgress(1);
        finish();
      } else {
        finish(new Error(`REMOTE_SHARE_RECORD_UPLOAD_HTTP_${xhr.status}`));
      }
    };
    xhr.onerror = () => finish(new Error('REMOTE_SHARE_RECORD_UPLOAD_NETWORK'));
    try {
      xhr.send(ciphertext);
    } catch (error) {
      finish(
        signal?.aborted
          ? new Error('REMOTE_SHARE_ABORTED', { cause: error })
          : new Error('REMOTE_SHARE_RECORD_UPLOAD_NETWORK', { cause: error }),
      );
    }
  });
}

export async function completeR2RecordUpload(
  session: Readonly<R2RecordSetUploadSession>,
  recordIndex: number,
  signal?: AbortSignal,
): Promise<Readonly<R2RecordCompletion>> {
  assertV2Signal(signal);
  const record = session.records[recordIndex];
  if (!record || !isRecordControlToken(session.setToken)) {
    throw new Error('REMOTE_SHARE_RECORD_COMPLETE_INPUT_INVALID');
  }
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  const path = `/v2/sets/${encodeURIComponent(session.storageRoomId)}/${encodeURIComponent(session.setId)}/records/${recordIndex}/complete`;
  try {
    const { response, body } = await requestRecordSetControl(
      endpoint,
      path,
      {
        method: 'POST',
        timeoutReason: 'REMOTE_SHARE_RECORD_COMPLETE_TIMEOUT',
        body: JSON.stringify({ setToken: session.setToken }),
      },
      signal,
    );
    if (!response.ok) throw new Error(`REMOTE_SHARE_RECORD_COMPLETE_HTTP_${response.status}`);
    const value = body as Partial<R2RecordCompletion> | null;
    if (
      value?.v !== R2_RECORD_SET_VERSION ||
      value.setId !== session.setId ||
      value.index !== recordIndex ||
      value.objectId !== record.objectId ||
      value.expiresAt !== session.expiresAt ||
      !Number.isSafeInteger(value.readyRecordCount) ||
      (value.readyRecordCount ?? -1) < 1 ||
      (value.readyRecordCount ?? 0) > session.recordCount ||
      value.recordCount !== session.recordCount ||
      typeof value.complete !== 'boolean' ||
      value.complete !== (value.readyRecordCount === session.recordCount) ||
      !isExactRecordDownloadUrl(session.storageRoomId, record.objectId, value.downloadUrl)
    ) {
      throw new Error('REMOTE_SHARE_RECORD_COMPLETE_RESPONSE_INVALID');
    }
    return freezeCanonical({
      v: R2_RECORD_SET_VERSION,
      setId: session.setId,
      index: recordIndex,
      objectId: record.objectId,
      expiresAt: session.expiresAt,
      readyRecordCount: value.readyRecordCount as number,
      recordCount: session.recordCount,
      complete: value.complete,
      downloadUrl: expectedDownloadUrl(session.storageRoomId, record.objectId).toString(),
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) throw error;
    throw new Error('REMOTE_SHARE_RECORD_COMPLETE_NETWORK', { cause: error });
  }
}

export function downloadR2RecordObject(
  storageRoomId: string,
  objectId: string,
  expectedEncryptedSize: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  assertStorageObjectScope(storageRoomId, objectId);
  assertV2Signal(signal);
  return downloadEncryptedObject(
    storageRoomId,
    objectId,
    expectedEncryptedSize,
    undefined,
    undefined,
    signal,
  );
}

export async function deleteR2RecordSet(
  session: Pick<Readonly<R2RecordSetUploadSession>, 'cleanupToken' | 'setId' | 'storageRoomId'>,
  signal?: AbortSignal,
): Promise<void> {
  assertStorageRoomId(session.storageRoomId);
  if (!REMOTE_OBJECT_ID_RE.test(session.setId) || !CLEANUP_TOKEN_RE.test(session.cleanupToken)) {
    throw new Error('REMOTE_SHARE_RECORD_SET_CLEANUP_INPUT_INVALID');
  }
  assertV2Signal(signal);
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  const requestUrl = `${endpoint}/v2/sets/${encodeURIComponent(session.storageRoomId)}/${encodeURIComponent(session.setId)}`;
  try {
    const response = await withRequestDeadline(
      (requestSignal) =>
        fetch(requestUrl, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
            'x-mxqr-cleanup-token': session.cleanupToken,
          },
          keepalive: true,
          signal: requestSignal,
        }),
      {
        signal,
        timeoutMs: REMOTE_SHARE_CONTROL_REQUEST_TIMEOUT_MS,
        timeoutReason: 'REMOTE_SHARE_RECORD_SET_CLEANUP_TIMEOUT',
      },
    );
    if (!hasExactResponseUrl(response, requestUrl)) {
      throw new Error('REMOTE_SHARE_RECORD_SET_CLEANUP_ORIGIN_INVALID');
    }
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) {
      throw new Error(`REMOTE_SHARE_RECORD_SET_CLEANUP_HTTP_${response.status}`);
    }
  } catch (error) {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) throw error;
    throw new Error('REMOTE_SHARE_RECORD_SET_CLEANUP_NETWORK', { cause: error });
  }
}
