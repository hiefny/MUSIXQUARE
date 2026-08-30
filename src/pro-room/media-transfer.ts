import { resolveAudioMime } from '../media/audio-file.ts';
import type {
  CompleteProRoomMediaInput,
  CreateProRoomMediaReservationInput,
  DeleteProRoomMediaInput,
  ProRoomMediaDownload,
  ProRoomMediaReservation,
} from './api.ts';
import { parseProRoomMediaTransferUrl } from './api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  type ProRoomQuotaSnapshot,
  type ProRoomR2Source,
} from './contracts.ts';
import { createProRoomIdempotencyKey } from './idempotency.ts';
import { ProRoomAssetCache } from './media-cache.ts';
import {
  cancelResponseBody,
  createIdleWatchdog,
  createLinkedAbortScope,
  raceWithAbortSignal,
} from '../core/request-lifetime.ts';

export type ProRoomMediaProgress = (fraction: number) => void;

interface ProRoomMediaApi {
  readonly endpoint?: string;
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

type XhrFactory = () => XMLHttpRequest;
type IdempotencyKeyFactory = () => string;
const OPAQUE_ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PRO_ROOM_MEDIA_MIME_RE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const PRO_ROOM_MEDIA_SHA256_RE = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
// A transfer may take arbitrarily long while bytes keep moving. Only a fully
// idle connection is abandoned; there is deliberately no total-size deadline.
const PRO_ROOM_MEDIA_IDLE_TIMEOUT_MS = 60_000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_ABORTED');
}

function cancelReaderBestEffort<T>(reader: ReadableStreamDefaultReader<T>, reason?: unknown): void {
  try {
    void Promise.resolve(reader.cancel(reason)).catch(() => undefined);
  } catch {
    // Cleanup must not replace the transfer's authoritative error code.
  }
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

function assertMediaTransferUrl(rawUrl: string, endpoint?: string): URL {
  const parsed = parseProRoomMediaTransferUrl(rawUrl, endpoint);
  if (!parsed) throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_URL_INVALID');
  return new URL(parsed);
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
  endpoint?: string,
  onProgress?: ProRoomMediaProgress,
  signal?: AbortSignal,
): Promise<void> {
  const requestUrl = assertMediaTransferUrl(reservation.upload.url, endpoint).toString();
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
        cancelReaderBestEffort(reader, 'PRO_ROOM_MEDIA_DOWNLOAD_SIZE_MISMATCH');
        throw new ProRoomMediaTransferError('PRO_ROOM_MEDIA_DOWNLOAD_SIZE_MISMATCH');
      }
      bytes.set(value, offset);
      offset += value.byteLength;
      onProgressBytes?.();
      reportProgress(onProgress, offset / expectedBytes);
    }
  } catch (error) {
    if (signal?.aborted) {
      cancelReaderBestEffort(reader, signal.reason);
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
      await directPut(
        reservation,
        input.file,
        this.#xhrFactory,
        this.#api.endpoint,
        report,
        input.signal,
      );
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
    const url = assertMediaTransferUrl(descriptor.url, this.#api.endpoint).toString();

    const transferScope = createLinkedAbortScope(input.signal, 0);
    let idleExpired = false;
    const idleWatchdog = createIdleWatchdog(() => {
      idleExpired = true;
      transferScope.abort(new Error('PRO_ROOM_MEDIA_DOWNLOAD_IDLE_TIMEOUT'));
    }, PRO_ROOM_MEDIA_IDLE_TIMEOUT_MS);
    try {
      const requestInit: RequestInit = {
        method: 'GET',
        headers: { Accept: 'application/octet-stream' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        signal: transferScope.signal,
      };
      const response = await raceWithAbortSignal(
        this.#fetch(url, requestInit),
        transferScope.signal,
        cancelResponseBody,
      );
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
