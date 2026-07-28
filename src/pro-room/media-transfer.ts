import { resolveAudioMime } from '../media/audio-file.ts';
import type {
  CompleteProRoomMediaInput,
  CreateProRoomMediaReservationInput,
  DeleteProRoomMediaInput,
  ProRoomMediaDownload,
  ProRoomMediaReservation,
} from './api.ts';
import { PRO_ROOM_R2_HOST } from './api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  type ProRoomQuotaSnapshot,
  type ProRoomR2Source,
} from './contracts.ts';
import { createProRoomIdempotencyKey } from './idempotency.ts';
import { ProRoomAssetCache } from './media-cache.ts';
import { createIdleWatchdog, createLinkedAbortScope } from '../core/request-lifetime.ts';
import {
  PeerRangeEncodedAudioSource,
  type PeerRangeReadRequest,
  type PeerRangeTransport,
} from '../player/sources/peer-range-encoded-audio-source.ts';
import { BlobEncodedAudioSource } from '../player/sources/blob-encoded-audio-source.ts';
import type { EncodedAudioSource } from '../player/sources/encoded-audio-source.ts';

export type ProRoomMediaProgress = (fraction: number) => void;

interface ProRoomMediaApi {
  createMediaReservation(
    input: CreateProRoomMediaReservationInput,
    signal?: AbortSignal,
  ): Promise<ProRoomMediaReservation>;
  completeMedia(
    input: CompleteProRoomMediaInput,
    signal?: AbortSignal,
  ): Promise<{ asset: ProRoomR2Source; quota: ProRoomQuotaSnapshot }>;
  getMediaDownload(
    code: string,
    assetId: string,
    signal?: AbortSignal,
  ): Promise<ProRoomMediaDownload>;
  deleteMedia(
    input: DeleteProRoomMediaInput,
    signal?: AbortSignal,
  ): Promise<{ assetId: string; quota: ProRoomQuotaSnapshot }>;
}

export type { ProRoomMediaApi as ProRoomMediaApiForTests };

export interface UploadProRoomMediaInput {
  code: string;
  file: File;
  sha256?: string;
  onProgress?: ProRoomMediaProgress;
  signal?: AbortSignal;
}

interface DownloadProRoomMediaInput {
  code: string;
  name: string;
  source: ProRoomR2Source;
  onProgress?: ProRoomMediaProgress;
  signal?: AbortSignal;
  /** Encoded bytes still owned by active playback but no longer bounded by this LRU. */
  retainedEncodedBytes?: number;
}

interface CreateProRoomMediaRangeSourceInput {
  code: string;
  name: string;
  source: ProRoomR2Source;
}

export interface ProRoomMediaUploadResult {
  asset: ProRoomR2Source;
  quota: ProRoomQuotaSnapshot;
}

interface DeleteTransferredProRoomMediaInput {
  code: string;
  assetId: string;
  signal?: AbortSignal;
}

class ProRoomMediaTransferError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = 'ProRoomMediaTransferError';
    this.code = code;
  }
}

/**
 * A deployment/capability failure for which the caller may deliberately use
 * the legacy whole-object path. Integrity and canonical-identity failures use
 * ProRoomMediaTransferError instead and must never be hidden by a fallback.
 */
export class ProRoomMediaRangeCompatibilityError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = 'ProRoomMediaRangeCompatibilityError';
    this.code = code;
  }
}

type XhrFactory = () => XMLHttpRequest;
type IdempotencyKeyFactory = () => string;
const OPAQUE_ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PRO_ROOM_MEDIA_MIME_RE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const PRO_ROOM_MEDIA_SHA256_RE = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
// A transfer may take arbitrarily long while bytes keep moving. Only a fully
// idle connection is abandoned; there is deliberately no total-size deadline.
const PRO_ROOM_MEDIA_IDLE_TIMEOUT_MS = 60_000;
const PRO_ROOM_RANGE_PRESIGN_SAFETY_WINDOW_MS = 10_000;
const PRO_ROOM_RANGE_PRESIGN_MAX_MONOTONIC_FRESH_MS = 5 * 60_000;
const PRO_ROOM_RANGE_READ_IDLE_TIMEOUT_MS = 15_000;
const PRO_ROOM_RANGE_WINDOW_BYTES = 1024 * 1024;
const PRO_ROOM_RANGE_MAX_RESIDENT_WINDOWS = 2;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_ABORTED');
}

function readWithAbort<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function settleWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function reportProgress(callback: ProRoomMediaProgress | undefined, fraction: number): void {
  try {
    callback?.(Math.max(0, Math.min(1, fraction)));
  } catch {
    // Progress is an observer; it must never decide transfer integrity.
  }
}

function createProgressReporter(callback?: ProRoomMediaProgress): ProRoomMediaProgress {
  let previousPercent = -1;
  return (fraction): void => {
    const normalized = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    const percent = normalized >= 1 ? 100 : Math.floor(normalized * 100);
    if (percent === previousPercent) return;
    previousPercent = percent;
    reportProgress(callback, percent / 100);
  };
}

function effectiveMime(name: string, mime?: string): string {
  return resolveAudioMime(name, mime) || 'application/octet-stream';
}

function validateSource(source: ProRoomR2Source): void {
  if (
    source.kind !== 'pro-r2' ||
    !OPAQUE_ASSET_ID_RE.test(source.assetId) ||
    !Number.isSafeInteger(source.byteLength) ||
    source.byteLength <= 0 ||
    source.byteLength > PRO_ROOM_MAX_ASSET_BYTES ||
    !Number.isSafeInteger(source.version) ||
    source.version <= 0 ||
    !PRO_ROOM_MEDIA_MIME_RE.test(source.mime) ||
    (source.sha256 !== undefined && !PRO_ROOM_MEDIA_SHA256_RE.test(source.sha256))
  ) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_INVALID_SOURCE');
  }
}

function snapshotSource(source: ProRoomR2Source): Readonly<ProRoomR2Source> {
  let snapshot: ProRoomR2Source;
  try {
    const kind = source.kind;
    const assetId = source.assetId;
    const version = source.version;
    const byteLength = source.byteLength;
    const mime = source.mime;
    const sha256 = source.sha256;
    snapshot = {
      kind,
      assetId,
      version,
      byteLength,
      mime,
      ...(sha256 === undefined ? {} : { sha256 }),
    };
  } catch (error) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_INVALID_SOURCE', { cause: error });
  }
  validateSource(snapshot);
  return Object.freeze(snapshot);
}

function validateReservation(reservation: ProRoomMediaReservation, expectedBytes: number): void {
  if (
    !OPAQUE_ASSET_ID_RE.test(reservation.assetId) ||
    !Number.isSafeInteger(reservation.version) ||
    reservation.version <= 0 ||
    reservation.byteLength !== expectedBytes ||
    reservation.upload.method !== 'PUT'
  ) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_RESERVATION_MISMATCH');
  }
}

function sameAsset(left: ProRoomR2Source, right: ProRoomR2Source): boolean {
  return (
    left.kind === 'pro-r2' &&
    right.kind === 'pro-r2' &&
    left.assetId === right.assetId &&
    left.version === right.version &&
    left.byteLength === right.byteLength &&
    left.mime === right.mime &&
    left.sha256 === right.sha256
  );
}

function assertPresignedR2Url(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_URL_INVALID', { cause: error });
  }
  const requiredSignatureFields = [
    'X-Amz-Algorithm',
    'X-Amz-Credential',
    'X-Amz-Date',
    'X-Amz-Expires',
    'X-Amz-SignedHeaders',
    'X-Amz-Signature',
  ];
  if (
    url.protocol !== 'https:' ||
    url.hostname !== PRO_ROOM_R2_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
    requiredSignatureFields.some((field) => url.searchParams.getAll(field).length !== 1)
  ) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_URL_INVALID');
  }
  return url;
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return false;
  }
}

function directPut(
  reservation: ProRoomMediaReservation,
  file: File,
  xhrFactory: XhrFactory,
  onProgress?: ProRoomMediaProgress,
  signal?: AbortSignal,
): Promise<void> {
  const requestUrl = assertPresignedR2Url(reservation.upload.url).toString();
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastLoaded = 0;
    let xhr: XMLHttpRequest;
    let idleExpired = false;
    let idleWatchdog: ReturnType<typeof createIdleWatchdog> | null = null;

    const settle = (error?: ProRoomMediaTransferError): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      idleWatchdog?.cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleAbort = (): void => {
      try {
        xhr.abort();
      } catch {
        // The abort outcome below remains authoritative.
      }
      settle(
        new ProRoomMediaTransferError(
          idleExpired ? 'PRO_ROOM_MEDIA_UPLOAD_NETWORK' : 'PRO_ROOM_MEDIA_ABORTED',
        ),
      );
    };

    try {
      xhr = xhrFactory();
      xhr.open('PUT', requestUrl, true);
      xhr.withCredentials = false;
      for (const [name, value] of Object.entries(reservation.upload.headers)) {
        xhr.setRequestHeader(name, value);
      }
    } catch (error) {
      settle(new ProRoomMediaTransferError('PRO_ROOM_MEDIA_UPLOAD_NETWORK', { cause: error }));
      return;
    }

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener('abort', handleAbort, { once: true });
    idleWatchdog = createIdleWatchdog(() => {
      idleExpired = true;
      try {
        xhr.abort();
      } catch {
        // settle() below owns the observable outcome.
      }
      settle(new ProRoomMediaTransferError('PRO_ROOM_MEDIA_UPLOAD_NETWORK'));
    }, PRO_ROOM_MEDIA_IDLE_TIMEOUT_MS);

    xhr.upload.onprogress = (event): void => {
      if (settled) return;
      if (
        event.loaded < lastLoaded ||
        event.loaded > file.size ||
        (event.lengthComputable && event.total !== file.size)
      ) {
        const error = new ProRoomMediaTransferError('PRO_ROOM_MEDIA_UPLOAD_SIZE_MISMATCH');
        settle(error);
        try {
          xhr.abort();
        } catch {
          // Ignore; the settled integrity error is authoritative.
        }
        return;
      }
      // Browsers and intermediaries may emit duplicate/zero-progress events.
      // Only real byte progress may renew the idle lease; otherwise a stalled
      // upload could remain pending forever while producing empty callbacks.
      if (event.loaded > lastLoaded) {
        lastLoaded = event.loaded;
        idleWatchdog?.touch();
        reportProgress(onProgress, event.loaded / file.size);
      }
    };
    xhr.onload = (): void => {
      if (settled) return;
      if (xhr.status < 200 || xhr.status >= 300) {
        settle(new ProRoomMediaTransferError(`PRO_ROOM_MEDIA_UPLOAD_HTTP_${xhr.status}`));
        return;
      }
      if (!xhr.responseURL || !sameUrl(xhr.responseURL, requestUrl)) {
        settle(new ProRoomMediaTransferError('PRO_ROOM_MEDIA_UPLOAD_REDIRECTED'));
        return;
      }
      settle();
    };
    xhr.onerror = (): void =>
      settle(new ProRoomMediaTransferError('PRO_ROOM_MEDIA_UPLOAD_NETWORK'));
    xhr.onabort = (): void =>
      settle(
        new ProRoomMediaTransferError(
          signal?.aborted ? 'PRO_ROOM_MEDIA_ABORTED' : 'PRO_ROOM_MEDIA_UPLOAD_NETWORK',
        ),
      );

    try {
      xhr.send(file);
    } catch (error) {
      settle(
        new ProRoomMediaTransferError(
          signal?.aborted ? 'PRO_ROOM_MEDIA_ABORTED' : 'PRO_ROOM_MEDIA_UPLOAD_NETWORK',
          { cause: error },
        ),
      );
    }
  });
}

function parseExpectedContentLength(response: Response, expectedBytes: number): void {
  const rawLength = response.headers.get('content-length');
  if (rawLength === null || !/^\d+$/.test(rawLength)) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_LENGTH_MISSING');
  }
  const length = Number(rawLength);
  if (
    !Number.isSafeInteger(length) ||
    length !== expectedBytes ||
    length > PRO_ROOM_MAX_ASSET_BYTES
  ) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_SIZE_MISMATCH');
  }
  const contentEncoding = response.headers.get('content-encoding');
  if (contentEncoding !== null && contentEncoding.trim().toLowerCase() !== 'identity') {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_ENCODING_UNSUPPORTED');
  }
  if (response.headers.has('content-range')) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_RANGE_UNEXPECTED');
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The original validation/HTTP failure remains authoritative.
  }
}

async function readExactBody(
  response: Response,
  expectedBytes: number,
  onProgress?: ProRoomMediaProgress,
  signal?: AbortSignal,
  onProgressBytes?: () => void,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_BODY_MISSING');
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(new ArrayBuffer(expectedBytes));
  let offset = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      // A zero-length chunk is legal but is not network progress. In
      // particular it must not keep an otherwise stalled response alive.
      if (!value || value.byteLength === 0) continue;
      if (
        offset + value.byteLength > expectedBytes ||
        offset + value.byteLength > PRO_ROOM_MAX_ASSET_BYTES
      ) {
        await reader.cancel();
        throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_SIZE_MISMATCH');
      }
      bytes.set(value, offset);
      offset += value.byteLength;
      onProgressBytes?.();
      reportProgress(onProgress, offset / expectedBytes);
    }
  } catch (error) {
    if (signal?.aborted) {
      void reader.cancel().catch(() => undefined);
      throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_ABORTED', { cause: error });
    }
    if (error instanceof ProRoomMediaTransferError) throw error;
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_NETWORK', { cause: error });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An implementation may retain a pending read while cancellation is
      // propagating. The abort still owns this transfer's observable lifetime.
    }
  }

  throwIfAborted(signal);
  if (offset !== expectedBytes) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_SIZE_MISMATCH');
  }
  return bytes;
}

interface ProRoomRangeDescriptor {
  readonly url: string;
  readonly expiresAtMs: number;
  readonly freshUntilMonotonicMs: number;
}

function presignFreshUntilMonotonicMs(url: URL, expiresAtMs: number): number {
  const rawSignedLifetimeSeconds = url.searchParams.get('X-Amz-Expires');
  if (!rawSignedLifetimeSeconds || !/^[1-9][0-9]{0,5}$/.test(rawSignedLifetimeSeconds)) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_URL_INVALID');
  }
  const signedLifetimeMs = Number(rawSignedLifetimeSeconds) * 1_000;
  if (!Number.isSafeInteger(signedLifetimeMs)) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_URL_INVALID');
  }

  // `expiresAtMs` is authoritative when the client's wall clock is sane. If
  // that clock is badly ahead, retain a conservative monotonic lease derived
  // from the signed URL TTL instead of re-presigning on every read. A 401/403
  // still invalidates this hint and refreshes the capability exactly once.
  const wallClockRemainingMs = expiresAtMs - Date.now();
  const boundedLifetimeMs = Math.min(
    signedLifetimeMs,
    PRO_ROOM_RANGE_PRESIGN_MAX_MONOTONIC_FRESH_MS,
    wallClockRemainingMs > PRO_ROOM_RANGE_PRESIGN_SAFETY_WINDOW_MS
      ? wallClockRemainingMs
      : Number.POSITIVE_INFINITY,
  );
  return (
    performance.now() + Math.max(0, boundedLifetimeMs - PRO_ROOM_RANGE_PRESIGN_SAFETY_WINDOW_MS)
  );
}

interface ProRoomRangeWindowLoad {
  readonly controller: AbortController;
  readonly promise: Promise<Uint8Array>;
  waiters: number;
  settled: boolean;
}

function parseExactContentRange(
  response: Response,
  offset: number,
  length: number,
  sourceSize: number,
): void {
  const raw = response.headers.get('content-range');
  const match = raw?.match(/^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/);
  const start = match ? Number(match[1]) : Number.NaN;
  const end = match ? Number(match[2]) : Number.NaN;
  const size = match ? Number(match[3]) : Number.NaN;
  if (
    !match ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(size) ||
    start !== offset ||
    end !== offset + length - 1 ||
    size !== sourceSize
  ) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_RANGE_CONTENT_MISMATCH');
  }
  const rawLength = response.headers.get('content-length');
  if (!rawLength || !/^(0|[1-9][0-9]*)$/.test(rawLength) || Number(rawLength) !== length) {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_RANGE_LENGTH_MISMATCH');
  }
  const encoding = response.headers.get('content-encoding');
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
    throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_RANGE_ENCODING_MISMATCH');
  }
}

/**
 * One immutable R2 object exposed as the existing exact-read source contract.
 *
 * Presigned URLs are capabilities, not identity. The transport therefore
 * refreshes them independently while every descriptor is rebound to the
 * canonical asset tuple before a byte request may use it.
 */
class ProRoomR2RangeTransport implements PeerRangeTransport {
  readonly #api: ProRoomMediaApi;
  readonly #fetch: typeof fetch;
  readonly #code: string;
  readonly #source: ProRoomR2Source;
  readonly #sourceIdentity: string;
  readonly #lifetime = new AbortController();
  #descriptor: ProRoomRangeDescriptor | null = null;
  #descriptorPromise: Promise<ProRoomRangeDescriptor> | null = null;
  #etag: string | null = null;
  readonly #windows = new Map<number, Uint8Array>();
  readonly #windowLoads = new Map<number, ProRoomRangeWindowLoad>();

  constructor(options: {
    api: ProRoomMediaApi;
    fetch: typeof fetch;
    code: string;
    source: ProRoomR2Source;
    sourceIdentity: string;
  }) {
    this.#api = options.api;
    this.#fetch = options.fetch;
    this.#code = options.code;
    this.#source = options.source;
    this.#sourceIdentity = options.sourceIdentity;
  }

  async #getDescriptor(): Promise<ProRoomRangeDescriptor> {
    throwIfAborted(this.#lifetime.signal);
    const resident = this.#descriptor;
    if (
      resident &&
      (resident.expiresAtMs - Date.now() > PRO_ROOM_RANGE_PRESIGN_SAFETY_WINDOW_MS ||
        performance.now() < resident.freshUntilMonotonicMs)
    ) {
      return resident;
    }
    if (this.#descriptorPromise) return this.#descriptorPromise;

    const pending = this.#api
      .getMediaDownload(this.#code, this.#source.assetId, this.#lifetime.signal)
      .then((descriptor) => {
        throwIfAborted(this.#lifetime.signal);
        if (!sameAsset(descriptor.asset, this.#source)) {
          throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_RANGE_ASSET_MISMATCH');
        }
        if (!Number.isSafeInteger(descriptor.expiresAtMs) || descriptor.expiresAtMs <= 0) {
          throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_RANGE_PRESIGN_EXPIRED');
        }
        const url = assertPresignedR2Url(descriptor.url);
        const next = Object.freeze({
          url: url.toString(),
          expiresAtMs: descriptor.expiresAtMs,
          freshUntilMonotonicMs: presignFreshUntilMonotonicMs(url, descriptor.expiresAtMs),
        });
        this.#descriptor = next;
        return next;
      })
      .finally(() => {
        if (this.#descriptorPromise === pending) this.#descriptorPromise = null;
      });
    this.#descriptorPromise = pending;
    return pending;
  }

  async #readOnce(
    request: PeerRangeReadRequest,
    descriptor: ProRoomRangeDescriptor,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const scope = createLinkedAbortScope(request.signal, 0);
    const onLifetimeAbort = () => scope.abort(this.#lifetime.signal.reason);
    this.#lifetime.signal.addEventListener('abort', onLifetimeAbort, { once: true });
    let idleExpired = false;
    const idleWatchdog = createIdleWatchdog(() => {
      idleExpired = true;
      scope.abort(new Error('PRO_ROOM_MEDIA_RANGE_IDLE_TIMEOUT'));
    }, PRO_ROOM_RANGE_READ_IDLE_TIMEOUT_MS);
    try {
      throwIfAborted(scope.signal);
      const end = offset + length - 1;
      const response = await settleWithAbort(
        this.#fetch(descriptor.url, {
          method: 'GET',
          headers: {
            Accept: 'application/octet-stream',
            Range: `bytes=${offset}-${end}`,
          },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          mode: 'cors',
          signal: scope.signal,
        }),
        scope.signal,
      );
      idleWatchdog.touch();
      if (response.redirected || (response.url !== '' && !sameUrl(response.url, descriptor.url))) {
        await cancelResponseBody(response);
        throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_RANGE_REDIRECTED');
      }
      if (response.status === 401 || response.status === 403) {
        await cancelResponseBody(response);
        throw new ProRoomMediaTransferError(`PRO_ROOM_MEDIA_RANGE_HTTP_${response.status}`);
      }
      if (response.status === 200) {
        await cancelResponseBody(response);
        throw new ProRoomMediaRangeCompatibilityError('PRO_ROOM_MEDIA_RANGE_UNSUPPORTED');
      }
      if (response.status !== 206) {
        await cancelResponseBody(response);
        throw new ProRoomMediaTransferError(`PRO_ROOM_MEDIA_RANGE_HTTP_${response.status}`);
      }
      try {
        parseExactContentRange(response, offset, length, this.#source.byteLength);
        const etag = response.headers.get('etag');
        if (!etag || etag.length > 512 || etag !== etag.trim()) {
          throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_RANGE_ETAG_MISSING');
        }
        if (this.#etag !== null && this.#etag !== etag) {
          throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_RANGE_ETAG_MISMATCH');
        }
        this.#etag ??= etag;
      } catch (error) {
        await cancelResponseBody(response);
        throw error;
      }
      return await readExactBody(response, length, undefined, scope.signal, () =>
        idleWatchdog.touch(),
      );
    } catch (error) {
      if (
        error instanceof ProRoomMediaTransferError ||
        error instanceof ProRoomMediaRangeCompatibilityError
      ) {
        if (
          idleExpired &&
          error instanceof ProRoomMediaTransferError &&
          error.code === 'PRO_ROOM_MEDIA_ABORTED'
        ) {
          throw new ProRoomMediaRangeCompatibilityError('PRO_ROOM_MEDIA_RANGE_TIMEOUT', {
            cause: error,
          });
        }
        throw error;
      }
      if (request.signal.aborted || this.#lifetime.signal.aborted) throw error;
      if (idleExpired) {
        throw new ProRoomMediaRangeCompatibilityError('PRO_ROOM_MEDIA_RANGE_TIMEOUT', {
          cause: error,
        });
      }
      // A browser CORS rejection is intentionally distinguishable from byte
      // integrity failures so a mixed rollout can use the legacy whole GET.
      throw new ProRoomMediaRangeCompatibilityError('PRO_ROOM_MEDIA_RANGE_NETWORK', {
        cause: error,
      });
    } finally {
      idleWatchdog.cleanup();
      this.#lifetime.signal.removeEventListener('abort', onLifetimeAbort);
      scope.cleanup();
    }
  }

  async #readPhysical(
    request: PeerRangeReadRequest,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    // Descriptor acquisition is shared across readers and remains bound to
    // the transport lifetime so one cancelled waiter cannot invalidate a
    // sibling. Each waiter must still be able to leave promptly when its
    // PREPARE/read deadline expires.
    let descriptor = await settleWithAbort(this.#getDescriptor(), request.signal);
    try {
      return await this.#readOnce(request, descriptor, offset, length);
    } catch (error) {
      const code =
        error instanceof ProRoomMediaTransferError ||
        error instanceof ProRoomMediaRangeCompatibilityError
          ? error.code
          : '';
      if (code !== 'PRO_ROOM_MEDIA_RANGE_HTTP_401' && code !== 'PRO_ROOM_MEDIA_RANGE_HTTP_403') {
        throw error;
      }
      // Exactly one retry receives a newly authenticated capability. A sibling
      // may already have replaced the failed URL; never clear that fresh
      // descriptor or amplify one expiry into a presign storm.
      const current = this.#descriptor;
      if (current && current !== descriptor) {
        descriptor = current;
      } else {
        if (current === descriptor) this.#descriptor = null;
        descriptor = await settleWithAbort(this.#getDescriptor(), request.signal);
      }
      return this.#readOnce(request, descriptor, offset, length);
    }
  }

  #touchWindow(start: number, bytes: Uint8Array): Uint8Array {
    this.#windows.delete(start);
    this.#windows.set(start, bytes);
    while (this.#windows.size > PRO_ROOM_RANGE_MAX_RESIDENT_WINDOWS) {
      const oldest = this.#windows.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#windows.delete(oldest);
    }
    return bytes;
  }

  async #joinWindowLoad(load: ProRoomRangeWindowLoad, signal: AbortSignal): Promise<Uint8Array> {
    load.waiters += 1;
    try {
      return await settleWithAbort(load.promise, signal);
    } finally {
      load.waiters -= 1;
      if (load.waiters === 0 && !load.settled && !load.controller.signal.aborted) {
        load.controller.abort(new DOMException('R2 range window has no readers', 'AbortError'));
      }
    }
  }

  async #readWindow(request: PeerRangeReadRequest, start: number): Promise<Uint8Array> {
    const resident = this.#windows.get(start);
    if (resident) return Promise.resolve(this.#touchWindow(start, resident));
    const pending = this.#windowLoads.get(start);
    if (pending && !pending.controller.signal.aborted) {
      return this.#joinWindowLoad(pending, request.signal);
    }
    if (pending && this.#windowLoads.get(start) === pending) {
      // The final waiter can cancel a physical read before its promise has
      // reached `finally()`. Do not let a rapid same-window successor inherit
      // that already-aborted operation; its finalizer is identity-guarded and
      // cannot delete the fresh replacement installed below.
      this.#windowLoads.delete(start);
    }
    if (this.#windowLoads.size >= PRO_ROOM_RANGE_MAX_RESIDENT_WINDOWS) {
      await settleWithAbort(
        Promise.race(
          [...this.#windowLoads.values()].map((load) =>
            load.promise.then(
              () => undefined,
              () => undefined,
            ),
          ),
        ),
        request.signal,
      );
      throwIfAborted(request.signal);
      throwIfAborted(this.#lifetime.signal);
      return this.#readWindow(request, start);
    }
    const length = Math.min(PRO_ROOM_RANGE_WINDOW_BYTES, this.#source.byteLength - start);
    const controller = new AbortController();
    const onLifetimeAbort = () => controller.abort(this.#lifetime.signal.reason);
    this.#lifetime.signal.addEventListener('abort', onLifetimeAbort, { once: true });
    const physicalRequest: PeerRangeReadRequest = {
      ...request,
      signal: controller.signal,
    };
    // The promise finalizer closes over this exact load record; assignment
    // necessarily follows promise construction even though it happens once.
    // eslint-disable-next-line prefer-const
    let load!: ProRoomRangeWindowLoad;
    const promise = this.#readPhysical(physicalRequest, start, length)
      .then((bytes) => {
        throwIfAborted(this.#lifetime.signal);
        return this.#touchWindow(start, bytes);
      })
      .finally(() => {
        load.settled = true;
        this.#lifetime.signal.removeEventListener('abort', onLifetimeAbort);
        if (this.#windowLoads.get(start) === load) this.#windowLoads.delete(start);
      });
    load = { controller, promise, waiters: 0, settled: false };
    this.#windowLoads.set(start, load);
    return this.#joinWindowLoad(load, request.signal);
  }

  async read(request: PeerRangeReadRequest): Promise<Uint8Array> {
    if (request.sourceIdentity !== this.#sourceIdentity) {
      throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_RANGE_IDENTITY_MISMATCH');
    }
    throwIfAborted(request.signal);
    const output = new Uint8Array(request.length);
    let sourceOffset = request.offset;
    let outputOffset = 0;
    while (outputOffset < request.length) {
      throwIfAborted(request.signal);
      const windowStart =
        Math.floor(sourceOffset / PRO_ROOM_RANGE_WINDOW_BYTES) * PRO_ROOM_RANGE_WINDOW_BYTES;
      const window = await this.#readWindow(request, windowStart);
      throwIfAborted(request.signal);
      const insideWindow = sourceOffset - windowStart;
      const copyLength = Math.min(request.length - outputOffset, window.length - insideWindow);
      if (copyLength <= 0) {
        throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_RANGE_WINDOW_MISMATCH');
      }
      output.set(window.subarray(insideWindow, insideWindow + copyLength), outputOffset);
      sourceOffset += copyLength;
      outputOffset += copyLength;
    }
    return output;
  }

  closeHandle(): void {
    if (!this.#lifetime.signal.aborted) {
      this.#lifetime.abort(new DOMException('PRO R2 range source closed', 'AbortError'));
    }
    this.#descriptor = null;
    this.#etag = null;
    this.#windows.clear();
    for (const load of this.#windowLoads.values()) {
      if (!load.controller.signal.aborted) {
        load.controller.abort(new DOMException('PRO R2 range source closed', 'AbortError'));
      }
    }
    this.#windowLoads.clear();
  }
}

export class ProRoomMediaTransfer {
  readonly #api: ProRoomMediaApi;
  readonly #cache: ProRoomAssetCache;
  readonly #fetch: typeof fetch;
  readonly #xhrFactory: XhrFactory;
  readonly #createIdempotencyKey: IdempotencyKeyFactory;

  constructor(options: {
    api: ProRoomMediaApi;
    cache?: ProRoomAssetCache;
    fetch?: typeof fetch;
    xhrFactory?: XhrFactory;
    createIdempotencyKey?: IdempotencyKeyFactory;
  }) {
    this.#api = options.api;
    this.#cache = options.cache ?? new ProRoomAssetCache();
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#xhrFactory = options.xhrFactory ?? (() => new XMLHttpRequest());
    this.#createIdempotencyKey = options.createIdempotencyKey ?? createProRoomIdempotencyKey;
  }

  get cache(): ProRoomAssetCache {
    return this.#cache;
  }

  createRangeSource(input: CreateProRoomMediaRangeSourceInput): EncodedAudioSource {
    const source = snapshotSource(input.source);
    const sourceIdentity = [
      'pro-r2',
      source.assetId,
      `v${source.version}`,
      `b${source.byteLength}`,
    ].join(':');
    // A legacy preload may already own the exact immutable object. Re-wrap
    // that cache entry with the same distributed source identity so the
    // bounded decoder reuses its bytes instead of issuing a second presign and
    // range GET. This preserves the established warm-next UX while avoiding
    // duplicate network traffic during the progressive PRO cutover.
    const cached = this.#cache.get(source, input.name);
    if (cached) {
      return new BlobEncodedAudioSource(cached, {
        identity: sourceIdentity,
        metadata: {
          name: input.name,
          mime: effectiveMime(input.name, source.mime),
        },
      });
    }
    const transport = new ProRoomR2RangeTransport({
      api: this.#api,
      fetch: this.#fetch,
      code: input.code,
      source,
      sourceIdentity,
    });
    return new PeerRangeEncodedAudioSource({
      size: source.byteLength,
      identity: sourceIdentity,
      metadata: {
        name: input.name,
        mime: effectiveMime(input.name, source.mime),
      },
      transport,
    });
  }

  async upload(input: UploadProRoomMediaInput): Promise<ProRoomMediaUploadResult> {
    throwIfAborted(input.signal);
    const report = createProgressReporter(input.onProgress);
    if (
      !Number.isSafeInteger(input.file.size) ||
      input.file.size <= 0 ||
      input.file.size > PRO_ROOM_MAX_ASSET_BYTES
    ) {
      throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_UPLOAD_SIZE_INVALID');
    }

    const mime = effectiveMime(input.file.name, input.file.type);
    const reservation = await this.#api.createMediaReservation(
      {
        code: input.code,
        byteLength: input.file.size,
        name: input.file.name,
        mime,
        ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
        idempotencyKey: this.#createIdempotencyKey(),
      },
      input.signal,
    );
    validateReservation(reservation, input.file.size);

    try {
      throwIfAborted(input.signal);
      await directPut(reservation, input.file, this.#xhrFactory, report, input.signal);
    } catch (error) {
      // A failed PUT cannot have a trusted completed asset. Ask the server to
      // release the reservation, without delaying the caller's cancellation.
      void this.#api
        .deleteMedia({
          code: input.code,
          assetId: reservation.assetId,
          idempotencyKey: this.#createIdempotencyKey(),
        })
        .catch(() => undefined);
      throw error;
    }

    // Do not delete after an ambiguous completion failure: the idempotent
    // server operation may already have committed, and cleanup could destroy a
    // playlist asset whose success response was merely lost.
    const completed = await this.#api.completeMedia(
      {
        code: input.code,
        assetId: reservation.assetId,
        idempotencyKey: this.#createIdempotencyKey(),
      },
      input.signal,
    );
    const expectedSource: ProRoomR2Source = {
      kind: 'pro-r2',
      assetId: reservation.assetId,
      version: reservation.version,
      byteLength: input.file.size,
      mime,
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
    };
    if (!sameAsset(completed.asset, expectedSource)) {
      throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_COMPLETE_MISMATCH');
    }

    if (input.file.size <= this.#cache.maxTotalBytes) this.#cache.put(completed.asset, input.file);
    report(1);
    return completed;
  }

  async download(input: DownloadProRoomMediaInput): Promise<File> {
    validateSource(input.source);
    throwIfAborted(input.signal);
    const report = createProgressReporter(input.onProgress);
    const cached = this.#cache.get(input.source, input.name);
    if (cached) {
      report(1);
      return cached;
    }

    const descriptor = await this.#api.getMediaDownload(
      input.code,
      input.source.assetId,
      input.signal,
    );
    if (!sameAsset(descriptor.asset, input.source)) {
      throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_ASSET_MISMATCH');
    }
    const url = assertPresignedR2Url(descriptor.url).toString();

    const transferScope = createLinkedAbortScope(input.signal, 0);
    let idleExpired = false;
    const idleWatchdog = createIdleWatchdog(() => {
      idleExpired = true;
      transferScope.abort(new Error('PRO_ROOM_MEDIA_DOWNLOAD_IDLE_TIMEOUT'));
    }, PRO_ROOM_MEDIA_IDLE_TIMEOUT_MS);
    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/octet-stream' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        signal: transferScope.signal,
      });
      idleWatchdog.touch();
      if (response.redirected || (response.url !== '' && !sameUrl(response.url, url))) {
        await cancelResponseBody(response);
        throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_REDIRECTED');
      }
      if (!response.ok || response.status !== 200) {
        await cancelResponseBody(response);
        throw new ProRoomMediaTransferError(`PRO_ROOM_MEDIA_DOWNLOAD_HTTP_${response.status}`);
      }
      try {
        parseExpectedContentLength(response, input.source.byteLength);
      } catch (error) {
        await cancelResponseBody(response);
        throw error;
      }
      // Make room only after the response and its declared size are verified,
      // but before readExactBody creates the incoming byte buffer. put() still
      // enforces the final ledger; this pre-eviction bounds the transient
      // old-cache + new-body overlap without discarding cache on network errors.
      this.#cache.prepareForIncoming(input.source.byteLength, input.retainedEncodedBytes ?? 0);
      const bytes = await readExactBody(
        response,
        input.source.byteLength,
        report,
        transferScope.signal,
        () => idleWatchdog.touch(),
      );
      const file = new File([bytes], input.name, {
        type: effectiveMime(input.name, input.source.mime),
      });
      if (file.size <= this.#cache.maxTotalBytes) this.#cache.put(input.source, file);
      report(1);
      return file;
    } catch (error) {
      if (error instanceof ProRoomMediaTransferError) {
        if (idleExpired && error.code === 'PRO_ROOM_MEDIA_ABORTED') {
          throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_NETWORK', { cause: error });
        }
        throw error;
      }
      throw new ProRoomMediaTransferError(
        input.signal?.aborted ? 'PRO_ROOM_MEDIA_ABORTED' : 'PRO_ROOM_MEDIA_DOWNLOAD_NETWORK',
        { cause: error },
      );
    } finally {
      idleWatchdog.cleanup();
      transferScope.cleanup();
    }
  }

  /**
   * Delete a completed or staged object through the authenticated room API.
   * The server refuses assets still referenced by the canonical playlist, so
   * this is also safe after an ambiguous snapshot response.
   */
  async deleteAsset(
    input: DeleteTransferredProRoomMediaInput,
  ): Promise<{ assetId: string; quota: ProRoomQuotaSnapshot }> {
    throwIfAborted(input.signal);
    const result = await this.#api.deleteMedia(
      {
        code: input.code,
        assetId: input.assetId,
        idempotencyKey: this.#createIdempotencyKey(),
      },
      input.signal,
    );
    this.#cache.deleteAsset(result.assetId);
    return result;
  }
}
