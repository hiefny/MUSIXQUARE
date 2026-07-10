/** Cloudflare R2 multipart remote-share client. */

import {
  getCapabilityHeaders,
  invalidateCapabilityToken,
  isCapabilityChallengeCancelled,
} from '../core/capability.ts';
import {
  REMOTE_SHARE_MAX_ENCRYPTED_BYTES,
  REMOTE_SHARE_MAX_PLAINTEXT_BYTES,
} from '../core/constants.ts';
import type { ChunkEncryptionPlan } from './crypto.ts';

export { REMOTE_SHARE_MAX_ENCRYPTED_BYTES, REMOTE_SHARE_MAX_PLAINTEXT_BYTES };

interface RemoteUploadMeta {
  roomId: string;
  name: string;
  mime: string;
  size: number;
  sessionId: number;
  index: number;
}

export interface RemoteUploadedPart {
  partNumber: number;
  etag: string;
}

interface RemoteMultipartPartRequest {
  partNumber: number;
  contentMd5: string;
}

export interface RemoteMultipartSession {
  protocolVersion: 4;
  endpoint: string;
  objectId: string;
  controlToken: string;
  downloadUrl: string;
  expiresAt: number;
  cleanupToken?: string;
  uploadUrlExpiresAt?: number;
}

interface RemoteUploadResponse {
  objectId: string;
  downloadUrl?: string;
  expiresAt: number;
}

interface RemotePartUploadTarget {
  partNumber: number;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
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
const REMOTE_SHARE_XHR_TIMEOUT_MS = 5 * 60_000;
const REMOTE_SHARE_SECURITY_CONFIG_CACHE_MS = 5 * 60_000;
const MAX_PART_URL_BATCH = 16;

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
    const localHttp =
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.hash) {
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
    // Storage can be disabled in private contexts. Production discovery still works.
  }
  if (location.hostname === 'musixquare.com' || location.hostname.endsWith('.musixquare.com')) {
    return PROD_ENDPOINT;
  }
  return null;
}

export function isRemoteShareConfigured(): boolean {
  return getRemoteShareEndpoint() !== null;
}

export function resolveRemoteDownloadUrl(
  roomId: string,
  objectId: string,
  downloadUrl?: string,
): string {
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  const expected = new URL(
    `/download/${encodeURIComponent(roomId)}/${encodeURIComponent(objectId)}`,
    endpoint,
  );
  if (!downloadUrl) return expected.toString();

  let candidate: URL;
  try {
    candidate = new URL(downloadUrl);
  } catch (error) {
    throw new Error('REMOTE_SHARE_BAD_DOWNLOAD_URL', { cause: error });
  }
  if (candidate.username || candidate.password || candidate.hash) {
    throw new Error('REMOTE_SHARE_BAD_DOWNLOAD_URL');
  }
  if (
    candidate.origin === expected.origin &&
    candidate.pathname === expected.pathname &&
    candidate.protocol === expected.protocol
  ) {
    return candidate.toString();
  }

  // Narrow rolling compatibility for descriptors issued by the oldest R2
  // direct-download implementation.
  if (candidate.protocol === 'https:' && candidate.hostname.endsWith('.r2.cloudflarestorage.com')) {
    let segments: string[];
    try {
      segments = candidate.pathname
        .split('/')
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));
    } catch {
      throw new Error('REMOTE_SHARE_BAD_DOWNLOAD_URL');
    }
    if (segments.includes(roomId) && segments.includes(objectId)) return candidate.toString();
  }
  throw new Error('REMOTE_SHARE_BAD_DOWNLOAD_URL');
}

function wireAbort(
  xhr: XMLHttpRequest,
  reject: (error: Error) => void,
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
      // Best effort.
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
    remoteShareSecurityConfigCache?.endpoint === endpoint &&
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

function invalidateRemoteShareSecurityConfig(endpoint: string): void {
  if (remoteShareSecurityConfigCache?.endpoint === endpoint) remoteShareSecurityConfigCache = null;
}

async function getRemoteShareSessionHeaders(
  endpoint: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const config = await getRemoteShareSecurityConfig(endpoint, signal);
  if (!config.capabilityRequired) return {};
  return getCapabilityHeaders(new URL('/api/capability-token', location.origin), ['remote-share']);
}

function asRemoteError(error: unknown, fallback: string, signal?: AbortSignal): Error {
  if (signal?.aborted) return new Error('REMOTE_SHARE_ABORTED', { cause: error });
  if (isCapabilityChallengeCancelled(error)) return error as Error;
  if (error instanceof Error && error.message.startsWith('REMOTE_SHARE_')) return error;
  return new Error(fallback, { cause: error });
}

export async function requestMultipartUploadSession(
  meta: RemoteUploadMeta,
  plan: ChunkEncryptionPlan,
  signal?: AbortSignal,
): Promise<RemoteMultipartSession> {
  const endpoint = getRemoteShareEndpoint();
  if (!endpoint) throw new Error('REMOTE_SHARE_ENDPOINT_MISSING');
  const requestBody = JSON.stringify({
    protocolVersion: 4,
    roomId: meta.roomId,
    sessionId: meta.sessionId,
    index: meta.index,
    name: meta.name,
    mime: meta.mime || 'application/octet-stream',
    size: meta.size,
    encryptedSize: plan.encryptedSize,
    chunkSize: plan.chunkSize,
    chunkCount: plan.chunkCount,
    tagBytes: plan.tagBytes,
  });

  try {
    const capabilityTarget = new URL('/api/capability-token', location.origin);
    let capabilityHeaders = await getRemoteShareSessionHeaders(endpoint, signal);
    const send = () =>
      fetch(`${endpoint}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...capabilityHeaders },
        body: requestBody,
        signal,
      });
    let response = await send();
    if (response.status === 401) {
      if (capabilityHeaders['X-MXQR-Capability']) invalidateCapabilityToken(capabilityTarget);
      invalidateRemoteShareSecurityConfig(endpoint);
      capabilityHeaders = await getRemoteShareSessionHeaders(endpoint, signal);
      response = await send();
    }
    if (!response.ok) throw new Error(`REMOTE_SHARE_SESSION_HTTP_${response.status}`);

    const body = (await response.json()) as Record<string, unknown> | null;
    if (
      body?.protocolVersion !== 4 ||
      typeof body.objectId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(body.objectId) ||
      typeof body.controlToken !== 'string' ||
      body.controlToken.length < 32 ||
      typeof body.expiresAt !== 'number' ||
      body.expiresAt <= Date.now() ||
      typeof body.downloadUrl !== 'string'
    ) {
      throw new Error('REMOTE_SHARE_BAD_SESSION_RESPONSE');
    }
    const downloadUrl = resolveRemoteDownloadUrl(meta.roomId, body.objectId, body.downloadUrl);
    return {
      protocolVersion: 4,
      endpoint,
      objectId: body.objectId,
      controlToken: body.controlToken,
      downloadUrl,
      expiresAt: body.expiresAt,
      cleanupToken: typeof body.cleanupToken === 'string' ? body.cleanupToken : undefined,
      uploadUrlExpiresAt:
        typeof body.uploadUrlExpiresAt === 'number' ? body.uploadUrlExpiresAt : undefined,
    };
  } catch (error) {
    throw asRemoteError(error, 'REMOTE_SHARE_SESSION_NETWORK', signal);
  }
}

function isCanonicalContentMd5(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(value)) return false;
  try {
    const decoded = atob(value);
    return decoded.length === 16 && btoa(decoded) === value;
  } catch {
    return false;
  }
}

function validatePartTarget(
  value: unknown,
  expected: RemoteMultipartPartRequest,
): RemotePartUploadTarget {
  const part = value as Record<string, unknown> | null;
  if (
    part?.partNumber !== expected.partNumber ||
    typeof part.uploadUrl !== 'string' ||
    !part.uploadHeaders ||
    typeof part.uploadHeaders !== 'object' ||
    Array.isArray(part.uploadHeaders)
  ) {
    throw new Error('REMOTE_SHARE_BAD_PART_URL_RESPONSE');
  }
  const url = new URL(part.uploadUrl);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.r2.cloudflarestorage.com') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('REMOTE_SHARE_BAD_PART_URL_RESPONSE');
  }
  const headers = part.uploadHeaders as Record<string, unknown>;
  if (
    !Object.entries(headers).every(([key, value]) => key.length > 0 && typeof value === 'string')
  ) {
    throw new Error('REMOTE_SHARE_BAD_PART_URL_RESPONSE');
  }
  const normalizedHeaders = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedHeaders.has(normalizedKey)) {
      throw new Error('REMOTE_SHARE_BAD_PART_URL_RESPONSE');
    }
    normalizedHeaders.set(normalizedKey, value as string);
  }
  if (normalizedHeaders.get('content-md5') !== expected.contentMd5) {
    throw new Error('REMOTE_SHARE_BAD_PART_URL_RESPONSE');
  }
  return {
    partNumber: expected.partNumber,
    uploadUrl: url.toString(),
    uploadHeaders: headers as Record<string, string>,
  };
}

export async function requestMultipartPartUrls(
  session: RemoteMultipartSession,
  parts: RemoteMultipartPartRequest[],
  signal?: AbortSignal,
): Promise<RemotePartUploadTarget[]> {
  if (
    parts.length < 1 ||
    parts.length > MAX_PART_URL_BATCH ||
    !parts.every(
      (part, index) =>
        Number.isSafeInteger(part.partNumber) &&
        part.partNumber >= 1 &&
        part.partNumber <= 10_000 &&
        isCanonicalContentMd5(part.contentMd5) &&
        (index === 0 || part.partNumber > (parts[index - 1]?.partNumber ?? 0)),
    )
  ) {
    throw new Error('REMOTE_SHARE_PART_REQUEST_INVALID');
  }
  try {
    const response = await fetch(`${session.endpoint}/parts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objectId: session.objectId,
        controlToken: session.controlToken,
        parts,
      }),
      signal,
    });
    if (!response.ok) throw new Error(`REMOTE_SHARE_PART_URL_HTTP_${response.status}`);
    const body = (await response.json()) as { parts?: unknown[] } | null;
    if (!Array.isArray(body?.parts) || body.parts.length !== parts.length) {
      throw new Error('REMOTE_SHARE_BAD_PART_URL_RESPONSE');
    }
    const byNumber = new Map<number, unknown>();
    for (const raw of body.parts) {
      const partNumber = Number((raw as Record<string, unknown> | null)?.partNumber);
      if (byNumber.has(partNumber)) throw new Error('REMOTE_SHARE_BAD_PART_URL_RESPONSE');
      byNumber.set(partNumber, raw);
    }
    return parts.map((part) => validatePartTarget(byNumber.get(part.partNumber), part));
  } catch (error) {
    throw asRemoteError(error, 'REMOTE_SHARE_PART_URL_NETWORK', signal);
  }
}

export function uploadMultipartPart(
  target: RemotePartUploadTarget,
  encryptedPart: ArrayBuffer,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<RemoteUploadedPart> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const resolve = (value: RemoteUploadedPart): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const reject = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', target.uploadUrl, true);
    for (const [header, value] of Object.entries(target.uploadHeaders)) {
      xhr.setRequestHeader(header, value);
    }
    const detachAbort = wireAbort(xhr, reject, signal);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      detachAbort?.();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`REMOTE_SHARE_UPLOAD_HTTP_${xhr.status}`));
        return;
      }
      const etag = String(xhr.getResponseHeader('etag') || '')
        .trim()
        .replace(/^"|"$/g, '');
      if (!/^[a-f0-9]{32}$/i.test(etag)) {
        reject(new Error('REMOTE_SHARE_BAD_PART_ETAG'));
        return;
      }
      onProgress?.(1);
      resolve({ partNumber: target.partNumber, etag });
    };
    xhr.onerror = () => {
      detachAbort?.();
      reject(
        signal?.aborted
          ? new Error('REMOTE_SHARE_ABORTED')
          : new Error('REMOTE_SHARE_UPLOAD_NETWORK'),
      );
    };
    xhr.ontimeout = () => {
      detachAbort?.();
      reject(
        signal?.aborted
          ? new Error('REMOTE_SHARE_ABORTED')
          : new Error('REMOTE_SHARE_UPLOAD_TIMEOUT'),
      );
    };
    xhr.timeout = REMOTE_SHARE_XHR_TIMEOUT_MS;
    xhr.send(new Blob([encryptedPart], { type: 'application/octet-stream' }));
  });
}

export async function completeMultipartUpload(
  session: RemoteMultipartSession,
  roomId: string,
  parts: RemoteUploadedPart[],
  signal?: AbortSignal,
): Promise<RemoteUploadResponse> {
  try {
    const response = await fetch(`${session.endpoint}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId,
        objectId: session.objectId,
        controlToken: session.controlToken,
        parts,
      }),
      signal,
    });
    if (!response.ok) throw new Error(`REMOTE_SHARE_COMPLETE_HTTP_${response.status}`);
    const body = (await response.json()) as Partial<RemoteUploadResponse> | null;
    if (body?.objectId !== session.objectId || typeof body.expiresAt !== 'number') {
      throw new Error('REMOTE_SHARE_BAD_COMPLETE_RESPONSE');
    }
    return {
      objectId: body.objectId,
      downloadUrl: body.downloadUrl
        ? resolveRemoteDownloadUrl(roomId, body.objectId, body.downloadUrl)
        : session.downloadUrl,
      expiresAt: body.expiresAt,
    };
  } catch (error) {
    throw asRemoteError(error, 'REMOTE_SHARE_COMPLETE_NETWORK', signal);
  }
}

export async function abortMultipartUpload(
  session: RemoteMultipartSession,
  roomId: string,
): Promise<void> {
  try {
    const response = await fetch(`${session.endpoint}/abort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId,
        objectId: session.objectId,
        controlToken: session.controlToken,
      }),
    });
    if (!response.ok && response.status !== 404 && response.status !== 409) {
      throw new Error(`REMOTE_SHARE_ABORT_HTTP_${response.status}`);
    }
  } catch (error) {
    throw asRemoteError(error, 'REMOTE_SHARE_ABORT_NETWORK');
  }
}

export function downloadEncryptedObject(
  roomId: string,
  objectId: string,
  downloadUrl?: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
  expectedBytes?: number,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const exactBytes =
      Number.isSafeInteger(expectedBytes) &&
      Number(expectedBytes) > 0 &&
      Number(expectedBytes) <= REMOTE_SHARE_MAX_ENCRYPTED_BYTES
        ? Number(expectedBytes)
        : null;
    if (exactBytes === null) {
      reject(new Error('REMOTE_SHARE_DOWNLOAD_SIZE_INVALID'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('GET', resolveRemoteDownloadUrl(roomId, objectId, downloadUrl), true);
    xhr.responseType = 'arraybuffer';
    const detachAbort = wireAbort(xhr, reject, signal);
    let sizeRejected = false;
    const rejectSize = (code: string): void => {
      if (sizeRejected) return;
      sizeRejected = true;
      detachAbort?.();
      try {
        xhr.abort();
      } catch {
        // Best effort.
      }
      reject(new Error(code));
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState < XMLHttpRequest.HEADERS_RECEIVED) return;
      const rawLength = xhr.getResponseHeader('content-length');
      if (rawLength === null) return;
      const contentLength = Number(rawLength);
      if (!Number.isSafeInteger(contentLength) || contentLength !== exactBytes) {
        rejectSize('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
      }
    };
    xhr.onprogress = (event) => {
      if (event.loaded > exactBytes || (event.lengthComputable && event.total !== exactBytes)) {
        rejectSize('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
        return;
      }
      onProgress?.(Math.min(1, event.loaded / exactBytes));
    };
    xhr.onload = () => {
      detachAbort?.();
      if (
        xhr.status >= 200 &&
        xhr.status < 300 &&
        xhr.response instanceof ArrayBuffer &&
        xhr.response.byteLength === exactBytes
      ) {
        onProgress?.(1);
        resolve(xhr.response);
        return;
      }
      reject(
        new Error(
          xhr.status >= 200 && xhr.status < 300
            ? 'REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'
            : `REMOTE_SHARE_DOWNLOAD_HTTP_${xhr.status}`,
        ),
      );
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

export async function downloadEncryptedObjectStream(
  roomId: string,
  objectId: string,
  downloadUrl: string | undefined,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    expectedBytes > REMOTE_SHARE_MAX_ENCRYPTED_BYTES
  ) {
    throw new Error('REMOTE_SHARE_DOWNLOAD_SIZE_INVALID');
  }
  let response: Response;
  try {
    response = await fetch(resolveRemoteDownloadUrl(roomId, objectId, downloadUrl), {
      method: 'GET',
      signal,
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED', { cause: error });
    throw new Error('REMOTE_SHARE_DOWNLOAD_NETWORK', { cause: error });
  }
  if (!response.ok) throw new Error(`REMOTE_SHARE_DOWNLOAD_HTTP_${response.status}`);
  const contentLength = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(contentLength) || contentLength !== expectedBytes) {
    await response.body?.cancel('size mismatch').catch(() => undefined);
    throw new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
  }
  if (response.headers.get('content-encoding')) {
    await response.body?.cancel('unexpected content encoding').catch(() => undefined);
    throw new Error('REMOTE_SHARE_DOWNLOAD_ENCODING_UNEXPECTED');
  }
  if (!response.body) throw new Error('REMOTE_SHARE_DOWNLOAD_BODY_MISSING');
  return response.body;
}
