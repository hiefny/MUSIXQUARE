import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { PRO_ROOM_R2_HOST, type ProRoomMediaDownload } from '../api.ts';
import { PRO_ROOM_MAX_ASSET_BYTES, type ProRoomR2Source } from '../contracts.ts';
import {
  ProRoomMediaTransfer,
  type ProRoomMediaApiForTests as ProRoomMediaApi,
} from '../media-transfer.ts';

const ROOM_CODE = '000001';
const ASSET_ID = 'asset_00000000001';
const WINDOW_BYTES = 1024 * 1024;
const STABLE_ETAG = '"mxqr-pro-object-v1"';

type RangeSource = ReturnType<ProRoomMediaTransfer['createRangeSource']>;

const openSources: RangeSource[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  await Promise.allSettled(openSources.splice(0).map((source) => source.close()));
  clearAllManagedTimers();
  vi.useRealTimers();
});

function source(overrides: Partial<ProRoomR2Source> = {}): ProRoomR2Source {
  return {
    kind: 'pro-r2',
    assetId: ASSET_ID,
    version: 1,
    byteLength: 4,
    mime: 'audio/flac',
    ...overrides,
  };
}

function apiHarness() {
  const createMediaReservation = vi.fn<ProRoomMediaApi['createMediaReservation']>();
  const completeMedia = vi.fn<ProRoomMediaApi['completeMedia']>();
  const getMediaDownload = vi.fn<ProRoomMediaApi['getMediaDownload']>();
  const deleteMedia = vi.fn<ProRoomMediaApi['deleteMedia']>();
  const api: ProRoomMediaApi = {
    createMediaReservation,
    completeMedia,
    getMediaDownload,
    deleteMedia,
  };
  return { api, getMediaDownload };
}

function presignedUrl(path = '/pro-media/private-object'): string {
  const url = new URL(`https://${PRO_ROOM_R2_HOST}${path}`);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', 'credential');
  url.searchParams.set('X-Amz-Date', '20260728T000000Z');
  url.searchParams.set('X-Amz-Expires', '900');
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  url.searchParams.set('X-Amz-Signature', 'a'.repeat(64));
  return url.toString();
}

function descriptor(asset: ProRoomR2Source, url = presignedUrl()): ProRoomMediaDownload {
  return {
    asset: { ...asset },
    url,
    expiresAtMs: Date.now() + 60_000,
  };
}

function byteAt(offset: number): number {
  return (offset * 17 + 11) % 251;
}

function bytesFor(offset: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => byteAt(offset + index));
}

interface RangeResponseOptions {
  offset: number;
  length: number;
  total: number;
  status?: number;
  body?: Uint8Array[];
  contentRange?: string | null;
  contentLength?: string | null;
  etag?: string | null;
  contentEncoding?: string;
}

function rangeResponse(options: RangeResponseOptions): Response {
  const {
    offset,
    length,
    total,
    status = 206,
    body = [bytesFor(offset, length)],
    contentRange = `bytes ${offset}-${offset + length - 1}/${total}`,
    contentLength = String(length),
    etag = STABLE_ETAG,
    contentEncoding,
  } = options;
  const headers = new Headers({ 'content-type': 'application/octet-stream' });
  if (contentRange !== null) headers.set('content-range', contentRange);
  if (contentLength !== null) headers.set('content-length', contentLength);
  if (etag !== null) headers.set('etag', etag);
  if (contentEncoding !== undefined) headers.set('content-encoding', contentEncoding);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of body) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status, headers },
  );
}

function parseRequestedRange(init?: RequestInit): { offset: number; length: number } {
  const raw = new Headers(init?.headers).get('range');
  const match = raw?.match(/^bytes=([0-9]+)-([0-9]+)$/);
  if (!match) throw new Error(`Unexpected Range header: ${String(raw)}`);
  const offset = Number(match[1]);
  const end = Number(match[2]);
  return { offset, length: end - offset + 1 };
}

function exactRangeFetch(total: number, etag = STABLE_ETAG) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const { offset, length } = parseRequestedRange(init);
    return rangeResponse({ offset, length, total, etag });
  });
}

function createRangeSource(options: {
  asset?: ProRoomR2Source;
  fetch: typeof fetch;
  getMediaDownload?: ProRoomMediaApi['getMediaDownload'];
  name?: string;
}): { source: RangeSource; getMediaDownload: ReturnType<typeof apiHarness>['getMediaDownload'] } {
  const asset = options.asset ?? source();
  const harness = apiHarness();
  if (options.getMediaDownload) {
    harness.getMediaDownload.mockImplementation(options.getMediaDownload);
  } else {
    harness.getMediaDownload.mockResolvedValue(descriptor(asset));
  }
  const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: options.fetch });
  const created = transfer.createRangeSource({
    code: ROOM_CODE,
    name: options.name ?? 'orchestra.flac',
    source: asset,
  });
  openSources.push(created);
  return { source: created, getMediaDownload: harness.getMediaDownload };
}

describe('PRO R2 immutable range source', () => {
  it('snapshots the canonical asset tuple instead of retaining caller-owned mutable state', async () => {
    const mutable = source();
    const initial = { ...mutable };
    const fetchMock = exactRangeFetch(initial.byteLength);
    const harness = apiHarness();
    harness.getMediaDownload.mockResolvedValue(descriptor(initial));
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });
    const created = transfer.createRangeSource({
      code: ROOM_CODE,
      name: 'immutable.flac',
      source: mutable,
    });
    openSources.push(created);

    mutable.assetId = 'asset_mutated_00001';
    mutable.version = 2;
    mutable.byteLength = 9;
    mutable.mime = 'audio/mpeg';

    await expect(created.readAt(0, 4, new AbortController().signal)).resolves.toEqual(
      bytesFor(0, 4),
    );
    expect(created.size).toBe(4);
    expect(created.identity).toBe(`pro-r2:${ASSET_ID}:v1:b4`);
    expect(created.metadata).toEqual({ name: 'immutable.flac', mime: 'audio/flac' });
    expect(harness.getMediaDownload).toHaveBeenCalledWith(
      ROOM_CODE,
      ASSET_ID,
      expect.any(AbortSignal),
    );
  });

  it('reuses an exact whole-file cache hit as the same bounded identity without network', async () => {
    const canonical = source();
    const harness = apiHarness();
    const fetchMock = vi.fn<typeof fetch>();
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });
    transfer.cache.put(
      canonical,
      new File([Uint8Array.of(11, 22, 33, 44)], 'warm.flac', {
        type: 'audio/flac',
      }),
    );

    const created = transfer.createRangeSource({
      code: ROOM_CODE,
      name: 'renamed.flac',
      source: canonical,
    });
    openSources.push(created);

    expect(created.kind).toBe('blob');
    expect(created.identity).toBe(`pro-r2:${ASSET_ID}:v1:b4`);
    expect(created.metadata).toEqual({
      name: 'renamed.flac',
      mime: 'audio/flac',
    });
    await expect(created.readAt(1, 2, new AbortController().signal)).resolves.toEqual(
      Uint8Array.of(22, 33),
    );
    expect(harness.getMediaDownload).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    await created.close();
    await expect(created.readAt(0, 1, new AbortController().signal)).rejects.toMatchObject({
      name: 'EncodedSourceClosedError',
    });
  });

  it('requires an exact credentialless 206 response and returns only the requested bytes', async () => {
    const fetchMock = exactRangeFetch(4);
    const { source: created } = createRangeSource({ fetch: fetchMock });

    await expect(created.readAt(0, 4, new AbortController().signal)).resolves.toEqual(
      bytesFor(0, 4),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(presignedUrl());
    expect(init).toEqual(
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
      }),
    );
    const headers = new Headers(init?.headers);
    expect(headers.get('range')).toBe('bytes=0-3');
    expect(headers.get('accept')).toBe('application/octet-stream');
    expect(headers.get('authorization')).toBeNull();
  });

  it('classifies a whole-object 200 response as a compatibility failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      rangeResponse({
        offset: 0,
        length: 4,
        total: 4,
        status: 200,
        contentRange: null,
      }),
    );
    const { source: created } = createRangeSource({ fetch: fetchMock });

    await expect(created.readAt(0, 4, new AbortController().signal)).rejects.toMatchObject({
      name: 'ProRoomMediaRangeCompatibilityError',
      code: 'PRO_ROOM_MEDIA_RANGE_UNSUPPORTED',
    });
  });

  it.each([
    ['missing Content-Range', { contentRange: null }, 'PRO_ROOM_MEDIA_RANGE_CONTENT_MISMATCH'],
    [
      'wrong Content-Range start',
      { contentRange: 'bytes 1-4/4' },
      'PRO_ROOM_MEDIA_RANGE_CONTENT_MISMATCH',
    ],
    [
      'malformed Content-Range',
      { contentRange: 'bytes 0-3/*' },
      'PRO_ROOM_MEDIA_RANGE_CONTENT_MISMATCH',
    ],
    ['missing Content-Length', { contentLength: null }, 'PRO_ROOM_MEDIA_RANGE_LENGTH_MISMATCH'],
    ['padded Content-Length', { contentLength: '04' }, 'PRO_ROOM_MEDIA_RANGE_LENGTH_MISMATCH'],
    ['wrong Content-Length', { contentLength: '5' }, 'PRO_ROOM_MEDIA_RANGE_LENGTH_MISMATCH'],
    ['encoded response', { contentEncoding: 'gzip' }, 'PRO_ROOM_MEDIA_RANGE_ENCODING_MISMATCH'],
    ['missing ETag', { etag: null }, 'PRO_ROOM_MEDIA_RANGE_ETAG_MISSING'],
  ] as const)('rejects a %s response before trusting its body', async (_label, override, code) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(rangeResponse({ offset: 0, length: 4, total: 4, ...override }));
    const { source: created } = createRangeSource({ fetch: fetchMock });

    await expect(created.readAt(0, 4, new AbortController().signal)).rejects.toMatchObject({
      code,
    });
  });

  it.each([
    ['short', [new Uint8Array([1, 2, 3])]],
    ['overlong', [new Uint8Array([1, 2, 3, 4, 5])]],
  ])('rejects a %s response body as an integrity failure', async (_label, body) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(rangeResponse({ offset: 0, length: 4, total: 4, body }));
    const { source: created } = createRangeSource({ fetch: fetchMock });

    await expect(created.readAt(0, 4, new AbortController().signal)).rejects.toMatchObject({
      code: 'PRO_ROOM_MEDIA_DOWNLOAD_SIZE_MISMATCH',
    });
  });

  it('fails closed when the refreshed descriptor does not match the canonical asset', async () => {
    const canonical = source();
    const fetchMock = vi.fn<typeof fetch>();
    const { source: created } = createRangeSource({
      asset: canonical,
      fetch: fetchMock,
      getMediaDownload: vi
        .fn<ProRoomMediaApi['getMediaDownload']>()
        .mockResolvedValue(descriptor(source({ version: 2 }))),
    });

    await expect(created.readAt(0, 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'PRO_ROOM_MEDIA_RANGE_ASSET_MISMATCH',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an untrusted or malformed presigned URL before issuing a byte request', async () => {
    const canonical = source();
    const fetchMock = vi.fn<typeof fetch>();
    const { source: created } = createRangeSource({
      asset: canonical,
      fetch: fetchMock,
      getMediaDownload: vi
        .fn<ProRoomMediaApi['getMediaDownload']>()
        .mockResolvedValue(descriptor(canonical, 'https://evil.example/audio.flac')),
    });

    await expect(created.readAt(0, 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'PRO_ROOM_MEDIA_URL_INVALID',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed source before asking the API for a capability', () => {
    const harness = apiHarness();
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: vi.fn<typeof fetch>() });

    expect(() =>
      transfer.createRangeSource({
        code: ROOM_CODE,
        name: 'invalid.flac',
        source: source({ byteLength: PRO_ROOM_MAX_ASSET_BYTES + 1 }),
      }),
    ).toThrow(expect.objectContaining({ code: 'PRO_ROOM_MEDIA_INVALID_SOURCE' }));
    expect(harness.getMediaDownload).not.toHaveBeenCalled();
  });
});

describe('PRO R2 capability refresh and object pinning', () => {
  it('lets one descriptor waiter abort promptly while a sibling keeps the single-flight alive', async () => {
    const canonical = source();
    const capability = deferred<ProRoomMediaDownload>();
    const harness = apiHarness();
    harness.getMediaDownload.mockImplementation(() => capability.promise);
    const fetchMock = exactRangeFetch(canonical.byteLength);
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });
    const created = transfer.createRangeSource({
      code: ROOM_CODE,
      name: 'shared-capability.flac',
      source: canonical,
    });
    openSources.push(created);

    const cancelledController = new AbortController();
    const cancelled = created.readAt(0, 1, cancelledController.signal);
    const surviving = created.readAt(1, 1, new AbortController().signal);
    await vi.waitFor(() => expect(harness.getMediaDownload).toHaveBeenCalledOnce());

    cancelledController.abort(new DOMException('candidate deadline', 'AbortError'));
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.getMediaDownload).toHaveBeenCalledOnce();

    capability.resolve(descriptor(canonical));
    await expect(surviving).resolves.toEqual(Uint8Array.of(byteAt(1)));
    expect(harness.getMediaDownload).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reuses the monotonic presign lease across a realistic +595s client clock skew', async () => {
    const canonical = source({ byteLength: WINDOW_BYTES * 2 });
    const harness = apiHarness();
    const tenMinuteUrl = new URL(presignedUrl());
    tenMinuteUrl.searchParams.set('X-Amz-Expires', '600');
    harness.getMediaDownload.mockResolvedValue({
      ...descriptor(canonical, tenMinuteUrl.toString()),
      // A ten-minute server capability appears to have only five seconds left
      // when the client wall clock is 595 seconds ahead. The signed TTL must
      // still provide one conservative monotonic lease instead of causing a
      // presign refresh for every disjoint range window.
      expiresAtMs: Date.now() + 5_000,
    });
    const fetchMock = exactRangeFetch(canonical.byteLength);
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });
    const created = transfer.createRangeSource({
      code: ROOM_CODE,
      name: 'ahead-clock.flac',
      source: canonical,
    });
    openSources.push(created);

    await expect(created.readAt(0, 1, new AbortController().signal)).resolves.toEqual(
      Uint8Array.of(byteAt(0)),
    );
    await expect(created.readAt(WINDOW_BYTES, 1, new AbortController().signal)).resolves.toEqual(
      Uint8Array.of(byteAt(WINDOW_BYTES)),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.getMediaDownload).toHaveBeenCalledOnce();
  });

  it.each([401, 403])(
    'refreshes once after HTTP %s and succeeds with the new capability',
    async (status) => {
      const canonical = source();
      const firstUrl = presignedUrl('/pro-media/expired');
      const secondUrl = presignedUrl('/pro-media/refreshed');
      const harness = apiHarness();
      harness.getMediaDownload
        .mockResolvedValueOnce(descriptor(canonical, firstUrl))
        .mockResolvedValueOnce(descriptor(canonical, secondUrl));
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(rangeResponse({ offset: 0, length: 4, total: 4 }));
      const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });
      const created = transfer.createRangeSource({
        code: ROOM_CODE,
        name: 'refresh.flac',
        source: canonical,
      });
      openSources.push(created);

      await expect(created.readAt(0, 4, new AbortController().signal)).resolves.toEqual(
        bytesFor(0, 4),
      );
      expect(harness.getMediaDownload).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([firstUrl, secondUrl]);
    },
  );

  it('never performs a third attempt when the one authenticated retry also fails', async () => {
    const canonical = source();
    const harness = apiHarness();
    harness.getMediaDownload
      .mockResolvedValueOnce(descriptor(canonical, presignedUrl('/pro-media/expired')))
      .mockResolvedValueOnce(descriptor(canonical, presignedUrl('/pro-media/retry')));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });
    const created = transfer.createRangeSource({
      code: ROOM_CODE,
      name: 'retry-once.flac',
      source: canonical,
    });
    openSources.push(created);

    await expect(created.readAt(0, 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'PRO_ROOM_MEDIA_RANGE_HTTP_403',
    });
    expect(harness.getMediaDownload).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('single-flights a capability refresh across concurrent failed windows', async () => {
    const canonical = source({ byteLength: WINDOW_BYTES * 2 });
    const firstUrl = presignedUrl('/pro-media/shared-expired');
    const secondUrl = presignedUrl('/pro-media/shared-refreshed');
    let resolveRefresh!: (value: ProRoomMediaDownload) => void;
    const refresh = new Promise<ProRoomMediaDownload>((resolve) => {
      resolveRefresh = resolve;
    });
    const harness = apiHarness();
    harness.getMediaDownload
      .mockResolvedValueOnce(descriptor(canonical, firstUrl))
      .mockImplementationOnce(() => refresh);
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (url === firstUrl) return new Response(null, { status: 401 });
      const { offset, length } = parseRequestedRange(init);
      return rangeResponse({ offset, length, total: canonical.byteLength });
    });
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });
    const created = transfer.createRangeSource({
      code: ROOM_CODE,
      name: 'single-flight.flac',
      source: canonical,
    });
    openSources.push(created);

    const first = created.readAt(0, 1, new AbortController().signal);
    const second = created.readAt(WINDOW_BYTES, 1, new AbortController().signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.getMediaDownload).toHaveBeenCalledTimes(2));
    resolveRefresh(descriptor(canonical, secondUrl));

    await expect(Promise.all([first, second])).resolves.toEqual([
      Uint8Array.of(byteAt(0)),
      Uint8Array.of(byteAt(WINDOW_BYTES)),
    ]);
    expect(harness.getMediaDownload).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.filter(([url]) => url === secondUrl)).toHaveLength(2);
  });

  it('lets a final waiter abort a hanging 401 refresh while a successor reuses that single-flight', async () => {
    const canonical = source();
    const firstUrl = presignedUrl('/pro-media/refresh-abort-expired');
    const secondUrl = presignedUrl('/pro-media/refresh-abort-renewed');
    const refresh = deferred<ProRoomMediaDownload>();
    const harness = apiHarness();
    harness.getMediaDownload
      .mockResolvedValueOnce(descriptor(canonical, firstUrl))
      .mockImplementationOnce(() => refresh.promise);
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (url === firstUrl) return new Response(null, { status: 401 });
      const { offset, length } = parseRequestedRange(init);
      return rangeResponse({ offset, length, total: canonical.byteLength });
    });
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });
    const created = transfer.createRangeSource({
      code: ROOM_CODE,
      name: 'refresh-abort.flac',
      source: canonical,
    });
    openSources.push(created);

    const cancelledController = new AbortController();
    const cancelled = created.readAt(0, 1, cancelledController.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.getMediaDownload).toHaveBeenCalledTimes(2));

    cancelledController.abort(new DOMException('prepare superseded', 'AbortError'));
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    const successor = created.readAt(1, 1, new AbortController().signal);
    await Promise.resolve();
    expect(harness.getMediaDownload).toHaveBeenCalledTimes(2);
    refresh.resolve(descriptor(canonical, secondUrl));

    await expect(successor).resolves.toEqual(Uint8Array.of(byteAt(1)));
    expect(harness.getMediaDownload).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([firstUrl, secondUrl]);
  });

  it('pins the first ETag and rejects a later window from a different object revision', async () => {
    const canonical = source({ byteLength: WINDOW_BYTES * 2 });
    let request = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const { offset, length } = parseRequestedRange(init);
      request += 1;
      return rangeResponse({
        offset,
        length,
        total: canonical.byteLength,
        etag: request === 1 ? '"object-v1"' : '"object-v2"',
      });
    });
    const { source: created } = createRangeSource({ asset: canonical, fetch: fetchMock });

    await expect(created.readAt(0, 1, new AbortController().signal)).resolves.toEqual(
      Uint8Array.of(byteAt(0)),
    );
    await expect(
      created.readAt(WINDOW_BYTES, 1, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'PRO_ROOM_MEDIA_RANGE_ETAG_MISMATCH',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('PRO R2 bounded range lifetime and read-ahead', () => {
  it('starts a fresh physical load when a same-window read follows the final waiter abort', async () => {
    const canonical = source();
    const firstController = new AbortController();
    let created!: RangeSource;
    let successor: Promise<Uint8Array> | undefined;
    let requestCount = 0;
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      requestCount += 1;
      if (requestCount > 1) {
        return Promise.resolve(
          rangeResponse({ offset: 0, length: canonical.byteLength, total: canonical.byteLength }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          'abort',
          () => {
            // Reenter while the cancelled physical load is still unwinding.
            // The successor must not inherit that already-aborted window.
            successor = created.readAt(2, 1, new AbortController().signal);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    ({ source: created } = createRangeSource({ asset: canonical, fetch: fetchMock }));

    const first = created.readAt(0, 1, firstController.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    firstController.abort(new DOMException('caller cancelled', 'AbortError'));

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(successor).toBeDefined());
    await expect(successor).resolves.toEqual(Uint8Array.of(byteAt(2)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight request when the source closes and rejects subsequent reads', async () => {
    const canonical = source();
    let fetchSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), {
            once: true,
          });
        }),
    );
    const { source: created } = createRangeSource({ asset: canonical, fetch: fetchMock });
    const pending = created.readAt(0, 1, new AbortController().signal);
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());

    const rejection = expect(pending).rejects.toMatchObject({
      name: 'EncodedSourceClosedError',
    });
    await created.close();

    await rejection;
    expect(fetchSignal?.aborted).toBe(true);
    await expect(created.readAt(0, 1, new AbortController().signal)).rejects.toMatchObject({
      name: 'EncodedSourceClosedError',
    });
  });

  it('times out a fetch that never produces response headers', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const { source: created } = createRangeSource({ fetch: fetchMock });

    const pending = created.readAt(0, 1, new AbortController().signal);
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'ProRoomMediaRangeCompatibilityError',
      code: 'PRO_ROOM_MEDIA_RANGE_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
  });

  it('times out a response body that stops making byte progress', async () => {
    vi.useFakeTimers();
    const stalledResponse = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }),
      {
        status: 206,
        headers: {
          'content-range': 'bytes 0-3/4',
          'content-length': '4',
          etag: STABLE_ETAG,
        },
      },
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(stalledResponse);
    const { source: created } = createRangeSource({ fetch: fetchMock });

    const pending = created.readAt(0, 1, new AbortController().signal);
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'ProRoomMediaRangeCompatibilityError',
      code: 'PRO_ROOM_MEDIA_RANGE_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
  });

  it('uses aligned 1 MiB read-ahead, reuses hot windows, and evicts at a two-window bound', async () => {
    const canonical = source({ byteLength: WINDOW_BYTES * 3 + 17 });
    const fetchMock = exactRangeFetch(canonical.byteLength);
    const { source: created } = createRangeSource({ asset: canonical, fetch: fetchMock });
    const signal = new AbortController().signal;

    await expect(created.readAt(123, 4, signal)).resolves.toEqual(bytesFor(123, 4));
    await expect(created.readAt(800_000, 3, signal)).resolves.toEqual(bytesFor(800_000, 3));
    await expect(created.readAt(WINDOW_BYTES + 13, 2, signal)).resolves.toEqual(
      bytesFor(WINDOW_BYTES + 13, 2),
    );
    await expect(created.readAt(7, 2, signal)).resolves.toEqual(bytesFor(7, 2));
    await expect(created.readAt(WINDOW_BYTES * 2 + 9, 2, signal)).resolves.toEqual(
      bytesFor(WINDOW_BYTES * 2 + 9, 2),
    );
    await expect(created.readAt(WINDOW_BYTES + 5, 1, signal)).resolves.toEqual(
      bytesFor(WINDOW_BYTES + 5, 1),
    );

    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('range'))).toEqual(
      [
        `bytes=0-${WINDOW_BYTES - 1}`,
        `bytes=${WINDOW_BYTES}-${WINDOW_BYTES * 2 - 1}`,
        `bytes=${WINDOW_BYTES * 2}-${WINDOW_BYTES * 3 - 1}`,
        `bytes=${WINDOW_BYTES}-${WINDOW_BYTES * 2 - 1}`,
      ],
    );
  });
});
