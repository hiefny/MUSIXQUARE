/**
 * Cloudflare R2 remote-share client.
 *
 * Endpoint discovery policy:
 * 1. https://share.musixquare.com is pinned on the production domain.
 * 2. Runtime overrides are accepted only by development/E2E builds or on a
 *    trusted loopback host.
 */

import {
  getCapabilityHeaders,
  invalidateCapabilityToken,
  isCapabilityChallengeCancelled,
} from '../core/capability.ts';
import { REMOTE_SHARE_MAX_BYTES } from '../core/constants.ts';
import { log } from '../core/log.ts';
import type { QueueItemId } from '../types/index.ts';
import { cancelResponseBody, withRequestDeadline } from '../core/request-lifetime.ts';
import { resolveRemoteShareEndpointPolicy } from './remote-share-endpoint.ts';
import type { RemoteShareUploadAssertionRequest } from '../network/transport/types.ts';

export interface RemoteUploadResponse {
  objectId: string;
  downloadUrl?: string;
  storedSize: number;
  expiresAt: number;
  cleanupToken: string;
  downloadToken: string;
}

interface RemoteUploadSessionResponse {
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  uploadUrlExpiresAt: number;
  completeToken: string;
  objectId: string;
  expiresAt: number;
  cleanupToken: string;
}

export interface RemoteUploadMeta {
  roomId: string;
  name: string;
  mime: string;
  size: number;
  sessionId: number;
  queueItemId: QueueItemId;
  requestRoomUploadAssertion?: (
    request: RemoteShareUploadAssertionRequest,
    signal?: AbortSignal,
  ) => Promise<string | null>;
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
    try {
      callback?.(percent / 100);
    } catch {
      // Presentation observers cannot decide the authoritative transfer outcome.
    }
  };
}

declare global {
  interface Window {
    __MUSIXQUARE_REMOTE_SHARE_ENDPOINT__?: unknown;
    __MUSIXQUARE_REMOTE_SHARE_UPLOAD_HOST__?: unknown;
  }
}

interface RemoteShareSecurityConfig {
  capabilityRequired: boolean;
  workerContractVersion: number;
  sessionReplayRequired: boolean;
  sessionReplayEnabled: boolean;
  wholeObjectVersion: number;
  downloadAuthorizationVersion: number;
  roomUploadAssertionVersion: 1;
  roomUploadAssertionMode: 'optional' | 'required';
}

const ENDPOINT_STORAGE_KEY = 'musixquare-remote-share-endpoint';
const SESSION_ACTOR_STORAGE_KEY = 'musixquare-remote-share-session-actor-v3';
const SESSION_ACTOR_SECRET_RE = /^[A-Za-z0-9_-]{43}$/u;
// Large files may legitimately take far longer than five minutes on mobile.
// Abort only when no bytes move for this window; steady slow transfers remain
// valid regardless of total wall-clock duration.
const REMOTE_SHARE_XHR_STALL_TIMEOUT_MS = 90_000;
const REMOTE_SHARE_SECURITY_CONFIG_CACHE_MS = 5 * 60_000;
const REMOTE_SHARE_CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const REMOTE_SHARE_UPLOAD_ASSERTION_MAX_LENGTH = 4096;
const REMOTE_SHARE_UPLOAD_ASSERTION_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const REMOTE_SHARE_CONTROL_RESPONSE_MAX_BYTES = 64 * 1024;
const REMOTE_SHARE_R2_PRODUCTION_HOST = '01353882e4eea3a5acaa0c45e8336af4.r2.cloudflarestorage.com';
const REMOTE_SHARE_R2_BUCKET = 'musixquare-remote-share';
const REMOTE_SHARE_UPLOAD_URL_MAX_LENGTH = 8192;
const REMOTE_SHARE_UPLOAD_TTL_MAX_SECONDS = 10 * 60;
const REMOTE_SHARE_UPLOAD_HEADER_VALUE_MAX_BYTES = 2048;
const REMOTE_SHARE_UPLOAD_HEADERS_MAX_BYTES = 16 * 1024;
const REMOTE_SHARE_SIGNED_TOKEN_MAX_LENGTH = 8192;
const REMOTE_SHARE_UPLOAD_HEADER_NAMES = Object.freeze([
  'content-type',
  'if-match',
  'x-amz-meta-cleanup-token',
  'x-amz-meta-expires-at',
  'x-amz-meta-format-version',
  'x-amz-meta-mime',
  'x-amz-meta-name',
  'x-amz-meta-object-id',
  'x-amz-meta-room-id',
  'x-amz-meta-stored-size',
]);
const REMOTE_SHARE_SIGNED_HEADER_NAMES = Object.freeze(
  [...REMOTE_SHARE_UPLOAD_HEADER_NAMES, 'content-length', 'host'].sort(),
);
const REMOTE_SHARE_UPLOAD_QUERY_NAMES = Object.freeze([
  'X-Amz-Algorithm',
  'X-Amz-Content-Sha256',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-Signature',
  'X-Amz-SignedHeaders',
]);
const REMOTE_SHARE_UPLOAD_ETAG_RE = /^"[\x21\x23-\x7e]{1,128}"$/u;
const REMOTE_SHARE_UPLOAD_SIGNATURE_RE = /^[a-f0-9]{64}$/u;
const REMOTE_SHARE_UPLOAD_ACCESS_KEY_RE = /^[A-Za-z0-9]{16,128}$/u;
const REMOTE_OBJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOWNLOAD_TOKEN_MAX_LENGTH = 2048;
const DOWNLOAD_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const CLEANUP_TOKEN_MAX_LENGTH = 2048;
const CLEANUP_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
let remoteShareSecurityConfigCache: {
  endpoint: string;
  expiresAt: number;
  value: RemoteShareSecurityConfig;
} | null = null;
let fallbackSessionActorSecret: string | null = null;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function cancelReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): void {
  try {
    void Promise.resolve(reader.cancel(reason)).catch(() => undefined);
  } catch {
    // Cleanup must not replace the bounded protocol outcome.
  }
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
      reject(abortReason(signal));
      cancelReaderBestEffort(reader, signal.reason);
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
      cancelResponseBody(response).catch(() => {
        // Body cancellation is best effort; retain the authoritative size error.
      });
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
        cancelReaderBestEffort(reader, 'REMOTE_SHARE_CONTROL_RESPONSE_TOO_LARGE');
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new Error('REMOTE_SHARE_CONTROL_RESPONSE_INVALID', { cause: error });
  }
}

function getRemoteShareEndpoint(): string | null {
  const hostname = location.hostname;
  const allowRuntimeOverrides = import.meta.env.DEV || import.meta.env.MODE === 'e2e';

  let stored: unknown;
  try {
    stored = localStorage.getItem(ENDPOINT_STORAGE_KEY);
  } catch {
    /* ignore */
  }

  return resolveRemoteShareEndpointPolicy({
    hostname,
    injected: window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__,
    stored,
    allowRuntimeOverrides,
  });
}

function isProductionAppHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'musixquare.com' || normalized.endsWith('.musixquare.com');
}

function explicitDevelopmentUploadHost(): string | null {
  // Vite folds this gate out of a production build. Even if an attacker can
  // create the mutable global at runtime, production never consults it.
  const allowOverride =
    import.meta.env.DEV || import.meta.env.MODE === 'test' || import.meta.env.MODE === 'e2e';
  if (!allowOverride) return null;
  const candidate = window.__MUSIXQUARE_REMOTE_SHARE_UPLOAD_HOST__;
  if (typeof candidate !== 'string') return null;
  const normalized = candidate.trim().toLowerCase();
  if (!normalized || normalized.includes('/') || normalized.includes(':')) return null;
  try {
    const url = new URL(`https://${normalized}`);
    return url.hostname === normalized && url.port === '' && url.pathname === '/'
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function expectedRemoteShareUploadHost(): string | null {
  if (isProductionAppHostname(location.hostname)) return REMOTE_SHARE_R2_PRODUCTION_HOST;
  return explicitDevelopmentUploadHost() ?? REMOTE_SHARE_R2_PRODUCTION_HOST;
}

function encodedRemoteShareMetadata(value: string, fallback: string): string {
  const raw = String(value || fallback)
    .replace(/[\r\n]/g, ' ')
    .trim();
  return encodeURIComponent(raw).slice(0, 512) || fallback;
}

function parseAmzDate(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  const timestamp = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  if (!Number.isSafeInteger(timestamp)) return null;
  const canonical = new Date(timestamp).toISOString().replace(/[-:]|\.000/g, '');
  return canonical === value ? timestamp : null;
}

function isExactStringRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key)) &&
    keys.every((key) => typeof (value as Record<string, unknown>)[key] === 'string')
  );
}

function validateRemoteShareUploadHeaders(
  value: unknown,
  body: Partial<RemoteUploadSessionResponse>,
  meta: RemoteUploadMeta,
): Record<string, string> | null {
  if (!isExactStringRecord(value, REMOTE_SHARE_UPLOAD_HEADER_NAMES)) return null;
  let totalBytes = 0;
  for (const [name, headerValue] of Object.entries(value)) {
    const valueBytes = new TextEncoder().encode(headerValue).byteLength;
    totalBytes += new TextEncoder().encode(`${name}:${headerValue}\n`).byteLength;
    if (
      valueBytes > REMOTE_SHARE_UPLOAD_HEADER_VALUE_MAX_BYTES ||
      totalBytes > REMOTE_SHARE_UPLOAD_HEADERS_MAX_BYTES ||
      /[\r\n]/u.test(headerValue)
    ) {
      return null;
    }
  }
  if (
    value['content-type'] !== 'application/octet-stream' ||
    !REMOTE_SHARE_UPLOAD_ETAG_RE.test(value['if-match']) ||
    value['x-amz-meta-cleanup-token'] !== body.cleanupToken ||
    value['x-amz-meta-expires-at'] !== String(body.expiresAt) ||
    value['x-amz-meta-format-version'] !== 'whole-object-v1' ||
    value['x-amz-meta-mime'] !==
      encodedRemoteShareMetadata(meta.mime, 'application/octet-stream') ||
    value['x-amz-meta-name'] !== encodedRemoteShareMetadata(meta.name, 'track') ||
    value['x-amz-meta-object-id'] !== body.objectId ||
    value['x-amz-meta-room-id'] !== meta.roomId ||
    value['x-amz-meta-stored-size'] !== String(meta.size)
  ) {
    return null;
  }
  return value;
}

function validateRemoteShareUploadUrl(
  value: string,
  body: Partial<RemoteUploadSessionResponse>,
  meta: RemoteUploadMeta,
  headers: Record<string, string>,
): string | null {
  if (value.length === 0 || value.length > REMOTE_SHARE_UPLOAD_URL_MAX_LENGTH) return null;
  const expectedHost = expectedRemoteShareUploadHost();
  if (!expectedHost) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const expectedPath = `/${REMOTE_SHARE_R2_BUCKET}/room/${meta.roomId}/${body.objectId}`;
  if (
    !value.startsWith(`https://${expectedHost}${expectedPath}?`) ||
    url.protocol !== 'https:' ||
    url.hostname !== expectedHost ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.pathname !== expectedPath
  ) {
    return null;
  }

  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== REMOTE_SHARE_UPLOAD_QUERY_NAMES.length ||
    new Set(entries.map(([name]) => name)).size !== REMOTE_SHARE_UPLOAD_QUERY_NAMES.length ||
    entries.some(([name]) => !REMOTE_SHARE_UPLOAD_QUERY_NAMES.includes(name))
  ) {
    return null;
  }
  const algorithm = url.searchParams.get('X-Amz-Algorithm');
  const contentSha = url.searchParams.get('X-Amz-Content-Sha256');
  const credential = url.searchParams.get('X-Amz-Credential') || '';
  const amzDate = url.searchParams.get('X-Amz-Date') || '';
  const expiresValue = url.searchParams.get('X-Amz-Expires') || '';
  const signature = url.searchParams.get('X-Amz-Signature') || '';
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
  const credentialParts = credential.split('/');
  const amzTimestamp = parseAmzDate(amzDate);
  const expiresSeconds = Number(expiresValue);
  if (
    algorithm !== 'AWS4-HMAC-SHA256' ||
    contentSha !== 'UNSIGNED-PAYLOAD' ||
    credentialParts.length !== 5 ||
    !REMOTE_SHARE_UPLOAD_ACCESS_KEY_RE.test(credentialParts[0] || '') ||
    credentialParts[1] !== amzDate.slice(0, 8) ||
    credentialParts[2] !== 'auto' ||
    credentialParts[3] !== 's3' ||
    credentialParts[4] !== 'aws4_request' ||
    amzTimestamp === null ||
    !/^[1-9]\d{0,5}$/u.test(expiresValue) ||
    !Number.isSafeInteger(expiresSeconds) ||
    expiresSeconds > REMOTE_SHARE_UPLOAD_TTL_MAX_SECONDS ||
    body.uploadUrlExpiresAt !== amzTimestamp + expiresSeconds * 1000 ||
    body.uploadUrlExpiresAt > Number(body.expiresAt) ||
    !REMOTE_SHARE_UPLOAD_SIGNATURE_RE.test(signature) ||
    signedHeaders !== REMOTE_SHARE_SIGNED_HEADER_NAMES.join(';') ||
    headers['x-amz-meta-object-id'] !== body.objectId
  ) {
    return null;
  }
  // Preserve the exact signed serialization. URL parsing above proves the
  // semantic contract, but reserialization must not become part of SigV4.
  return value;
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
    const payload = await withRequestDeadline(
      async (requestSignal) => {
        const response = await fetch(`${endpoint}/security-config`, {
          headers: { Accept: 'application/json' },
          signal: requestSignal,
        });
        if (!response.ok) {
          // This endpoint has no error-body contract. Release a streaming or
          // attacker-sized body before falling back to the conservative config.
          await cancelResponseBody(response);
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
    const roomUploadAssertionVersion = payload.roomUploadAssertionVersion;
    const roomUploadAssertionMode = payload.roomUploadAssertionMode;
    if (
      roomUploadAssertionVersion !== 1 ||
      (roomUploadAssertionMode !== 'optional' && roomUploadAssertionMode !== 'required')
    ) {
      throw new Error('REMOTE_SHARE_PROTOCOL_UNAVAILABLE');
    }
    const value: RemoteShareSecurityConfig = {
      capabilityRequired: payload.capabilityRequired === true,
      workerContractVersion:
        payload.workerContractVersion === 3 ? payload.workerContractVersion : 0,
      sessionReplayRequired: payload.sessionReplayRequired === true,
      sessionReplayEnabled: payload.sessionReplayEnabled === true,
      wholeObjectVersion: payload.wholeObjectVersion === 1 ? payload.wholeObjectVersion : 0,
      downloadAuthorizationVersion:
        payload.downloadAuthorizationVersion === 1 ? payload.downloadAuthorizationVersion : 0,
      roomUploadAssertionVersion: 1,
      roomUploadAssertionMode,
    };
    remoteShareSecurityConfigCache = {
      endpoint,
      expiresAt: Date.now() + REMOTE_SHARE_SECURITY_CONFIG_CACHE_MS,
      value,
    };
    return value;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.message === 'REMOTE_SHARE_PROTOCOL_UNAVAILABLE')
      throw error;
    throw new Error('REMOTE_SHARE_PROTOCOL_UNAVAILABLE', { cause: error });
  }
}

/** Fail closed unless the deployed Worker exposes the sole authenticated contract. */
async function supportsWholeObjectTransfer(signal?: AbortSignal): Promise<boolean> {
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) return false;
  const config = await getRemoteShareSecurityConfig(endpoint, signal);
  return (
    config.workerContractVersion === 3 &&
    config.sessionReplayRequired &&
    config.sessionReplayEnabled &&
    config.wholeObjectVersion === 1 &&
    config.downloadAuthorizationVersion === 1
  );
}

/** Invalidate cached security configuration after a 401 so the retry probes
 * the capability requirement again. */
function invalidateRemoteShareSecurityConfig(endpoint: string): void {
  if (remoteShareSecurityConfigCache?.endpoint === endpoint) {
    remoteShareSecurityConfigCache = null;
  }
}

async function getRemoteShareSessionHeaders(
  config: RemoteShareSecurityConfig,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  if (!config.capabilityRequired) return {};
  return getCapabilityHeaders(
    new URL('/api/capability-token', location.origin),
    ['remote-share'],
    signal,
  );
}

function randomSessionActorSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sessionActorSecret(): string {
  try {
    const stored = sessionStorage.getItem(SESSION_ACTOR_STORAGE_KEY) || '';
    if (SESSION_ACTOR_SECRET_RE.test(stored)) return stored;
    const created = randomSessionActorSecret();
    sessionStorage.setItem(SESSION_ACTOR_STORAGE_KEY, created);
    return created;
  } catch {
    fallbackSessionActorSecret ??= randomSessionActorSecret();
    return fallbackSessionActorSecret;
  }
}

async function signSessionActorValue(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
  );
  return bytesToBase64Url(digest);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function remoteShareSessionBodySha256(requestBody: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestBody));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function uploadSessionIdentity(
  meta: RemoteUploadMeta,
): Promise<{ actorId: string; requestId: string }> {
  const actorSecret = sessionActorSecret();
  const canonical = JSON.stringify([
    'remote-share-upload-session-v3',
    meta.roomId,
    meta.sessionId,
    meta.queueItemId,
    meta.name,
    meta.mime || 'application/octet-stream',
    meta.size,
  ]);
  const [actorId, requestId] = await Promise.all([
    signSessionActorValue(actorSecret, 'remote-share-session-actor-id:v3'),
    signSessionActorValue(actorSecret, canonical),
  ]);
  return { actorId: `rsa_${actorId}`, requestId: `rs3_${requestId}` };
}

async function requestUploadSession(
  endpoint: string,
  meta: RemoteUploadMeta,
  signal?: AbortSignal,
): Promise<RemoteUploadSessionResponse> {
  try {
    const { actorId, requestId } = await uploadSessionIdentity(meta);
    const requestBody = JSON.stringify({
      roomId: meta.roomId,
      sessionId: meta.sessionId,
      queueItemId: meta.queueItemId,
      name: meta.name,
      mime: meta.mime || 'application/octet-stream',
      size: meta.size,
      requestId,
      actorId,
    });
    const bodySha256 = await remoteShareSessionBodySha256(requestBody);
    const capabilityTarget = new URL('/api/capability-token', location.origin);
    const assertionRequest: RemoteShareUploadAssertionRequest = {
      actorId,
      requestId,
      sessionId: meta.sessionId,
      queueItemId: meta.queueItemId,
      size: meta.size,
      bodySha256,
    };
    const requestAssertionHeaders = async (
      config: RemoteShareSecurityConfig,
    ): Promise<Record<string, string>> => {
      const assertion = meta.requestRoomUploadAssertion
        ? await meta.requestRoomUploadAssertion(assertionRequest, signal)
        : null;
      if (!assertion) {
        if (config.roomUploadAssertionMode === 'required') {
          throw new Error('REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE');
        }
        return {};
      }
      if (
        assertion.length < 64 ||
        assertion.length > REMOTE_SHARE_UPLOAD_ASSERTION_MAX_LENGTH ||
        !REMOTE_SHARE_UPLOAD_ASSERTION_RE.test(assertion)
      ) {
        throw new Error('REMOTE_SHARE_UPLOAD_ASSERTION_INVALID');
      }
      return { 'X-MXQR-Room-Upload-Assertion': assertion };
    };
    const requestOnce = (authorizationHeaders: Record<string, string>) =>
      withRequestDeadline(
        async (requestSignal) => {
          const response = await fetch(`${endpoint}/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authorizationHeaders },
            body: requestBody,
            signal: requestSignal,
          });
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
    let securityConfig = await getRemoteShareSecurityConfig(endpoint, signal);
    let capabilityHeaders = await getRemoteShareSessionHeaders(securityConfig, signal);
    let assertionHeaders = await requestAssertionHeaders(securityConfig);
    let { response, body } = await requestOnce({ ...capabilityHeaders, ...assertionHeaders });

    // A 401 may mean the token is stale or the capability probe was inaccurate.
    // Invalidate both caches, probe again, and retry once.
    if (response.status === 401) {
      if (capabilityHeaders['X-MXQR-Capability']) invalidateCapabilityToken(capabilityTarget);
      invalidateRemoteShareSecurityConfig(endpoint);
      securityConfig = await getRemoteShareSecurityConfig(endpoint, signal);
      capabilityHeaders = await getRemoteShareSessionHeaders(securityConfig, signal);
      assertionHeaders = await requestAssertionHeaders(securityConfig);
      ({ response, body } = await requestOnce({ ...capabilityHeaders, ...assertionHeaders }));
    }

    if (!response.ok) {
      throw new Error(`REMOTE_SHARE_SESSION_HTTP_${response.status}`);
    }

    const nowMs = Date.now();
    const uploadHeaders = validateRemoteShareUploadHeaders(body?.uploadHeaders, body || {}, meta);
    const uploadUrl =
      typeof body?.uploadUrl === 'string' && uploadHeaders
        ? validateRemoteShareUploadUrl(body.uploadUrl, body, meta, uploadHeaders)
        : null;
    if (
      typeof body?.uploadUrl !== 'string' ||
      typeof body.completeToken !== 'string' ||
      body.completeToken.length < 32 ||
      body.completeToken.length > REMOTE_SHARE_SIGNED_TOKEN_MAX_LENGTH ||
      !DOWNLOAD_TOKEN_RE.test(body.completeToken) ||
      typeof body.objectId !== 'string' ||
      !REMOTE_OBJECT_ID_RE.test(body.objectId) ||
      !Number.isSafeInteger(body.expiresAt) ||
      Number(body.expiresAt) <= nowMs ||
      !Number.isSafeInteger(body.uploadUrlExpiresAt) ||
      Number(body.uploadUrlExpiresAt) <= nowMs ||
      typeof body.cleanupToken !== 'string' ||
      body.cleanupToken.length < 32 ||
      body.cleanupToken.length > CLEANUP_TOKEN_MAX_LENGTH ||
      !CLEANUP_TOKEN_RE.test(body.cleanupToken) ||
      !uploadHeaders ||
      !uploadUrl
    ) {
      throw new Error('REMOTE_SHARE_BAD_SESSION_RESPONSE');
    }
    return {
      uploadUrl,
      uploadHeaders,
      uploadUrlExpiresAt: body.uploadUrlExpiresAt as number,
      completeToken: body.completeToken,
      objectId: body.objectId,
      expiresAt: body.expiresAt as number,
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
    const { response, body } = await withRequestDeadline(
      async (requestSignal) => {
        const response = await fetch(`${endpoint}/complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            roomId: meta.roomId,
            objectId: session.objectId,
            completeToken: session.completeToken,
          }),
          signal: requestSignal,
        });
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
      !Number.isSafeInteger(body.storedSize) ||
      body.storedSize !== meta.size ||
      typeof body.expiresAt !== 'number' ||
      typeof body.downloadToken !== 'string' ||
      body.downloadToken.length < 32 ||
      body.downloadToken.length > DOWNLOAD_TOKEN_MAX_LENGTH ||
      !DOWNLOAD_TOKEN_RE.test(body.downloadToken) ||
      typeof body.cleanupToken !== 'string' ||
      body.cleanupToken.length < 32 ||
      body.cleanupToken.length > CLEANUP_TOKEN_MAX_LENGTH ||
      !CLEANUP_TOKEN_RE.test(body.cleanupToken) ||
      body.cleanupToken !== session.cleanupToken
    ) {
      throw new Error('REMOTE_SHARE_BAD_COMPLETE_RESPONSE');
    }
    return {
      objectId: body.objectId,
      downloadUrl: body.downloadUrl,
      storedSize: body.storedSize,
      expiresAt: body.expiresAt,
      cleanupToken: body.cleanupToken,
      downloadToken: body.downloadToken,
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
): Promise<void> {
  try {
    await withRequestDeadline(
      async (signal) => {
        const response = await fetch(
          `${endpoint}/object/${encodeURIComponent(meta.roomId)}/${encodeURIComponent(session.objectId)}`,
          {
            method: 'DELETE',
            headers: { 'x-mxqr-cleanup-token': session.cleanupToken },
            keepalive: true,
            signal,
          },
        );
        // Best-effort cleanup has no response payload contract. Cancel the
        // bounded body instead of materializing an attacker-sized error page.
        await cancelResponseBody(response);
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

/** Upload one private whole object through the canonical authenticated contract. */
export async function uploadWholeObject(
  blob: Blob,
  meta: RemoteUploadMeta,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<RemoteUploadResponse> {
  if (blob.size !== meta.size) throw new Error('REMOTE_SHARE_OBJECT_SIZE_MISMATCH');
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  if (!(await supportsWholeObjectTransfer(signal))) {
    throw new Error('REMOTE_SHARE_PROTOCOL_UNAVAILABLE');
  }

  const session = await requestUploadSession(endpoint, meta, signal);
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
      cleanupUploadSession(endpoint, session, meta).catch((cleanupError: unknown) => {
        log.warn('[RemoteShare] Upload cleanup task rejected unexpectedly', cleanupError);
      });
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
        void completeDirectUpload(endpoint, session, meta, signal).then((body) => {
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
      xhr.send(blob);
    } catch (error) {
      rejectWithCleanup(
        signal?.aborted
          ? new Error('REMOTE_SHARE_ABORTED', { cause: error })
          : new Error('REMOTE_SHARE_UPLOAD_NETWORK', { cause: error }),
      );
    }
  });
}

/** Download one private whole object with participant-delivered read authority. */
export function downloadWholeObject(
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
      downloadToken.length > DOWNLOAD_TOKEN_MAX_LENGTH ||
      !DOWNLOAD_TOKEN_RE.test(downloadToken)
    ) {
      reject(new Error('REMOTE_SHARE_DOWNLOAD_AUTH_INVALID'));
      return;
    }

    const requestUrl = buildDownloadUrl(roomId, objectId, downloadUrl);
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
