import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { PRO_ROOM_R2_HOST, type ProRoomMediaReservation } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomQuotaSnapshot,
  type ProRoomR2Source,
} from '../contracts.ts';
import { ProRoomAssetCache } from '../media-cache.ts';
import {
  ProRoomMediaTransfer,
  type ProRoomMediaApiForTests as ProRoomMediaApi,
} from '../media-transfer.ts';

const ROOM_CODE = '000001';
const ASSET_ID = 'asset_00000000001';

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

const quota: ProRoomQuotaSnapshot = {
  limitBytes: PRO_ROOM_QUOTA_BYTES,
  perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
  usedBytes: 4,
  reservedBytes: 0,
};

function presignedUrl(path = '/pro-media/private-object'): string {
  const url = new URL(`https://${PRO_ROOM_R2_HOST}${path}`);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', 'credential');
  url.searchParams.set('X-Amz-Date', '20260716T000000Z');
  url.searchParams.set('X-Amz-Expires', '900');
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  url.searchParams.set('X-Amz-Signature', 'a'.repeat(64));
  return url.toString();
}

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

function reservation(): ProRoomMediaReservation {
  return {
    assetId: ASSET_ID,
    version: 1,
    byteLength: 4,
    expiresAtMs: 1_900_000_000_000,
    upload: {
      method: 'PUT',
      url: presignedUrl(),
      headers: {
        'content-type': 'audio/flac',
        'x-amz-meta-version': '1',
      },
    },
    quota: { ...quota, usedBytes: 0, reservedBytes: 4 },
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
  return { api, createMediaReservation, completeMedia, getMediaDownload, deleteMedia };
}

class FakeXhr {
  readonly headers = new Map<string, string>();
  readonly upload = {
    onprogress: null as ((event: ProgressEvent) => void) | null,
  };
  method = '';
  url = '';
  async = false;
  withCredentials = true;
  status = 0;
  responseURL = '';
  sent: Document | XMLHttpRequestBodyInit | null = null;
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string, async: boolean): void {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.sent = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

async function waitForSend(xhr: FakeXhr): Promise<void> {
  await vi.waitFor(() => expect(xhr.sent).not.toBeNull());
}

function finishPut(xhr: FakeXhr, status = 200): void {
  xhr.status = status;
  xhr.responseURL = xhr.url;
  xhr.onload?.();
}

function makeDownloadResponse(chunks: Uint8Array[], contentLength: string | null = '4'): Response {
  const headers = new Headers({ 'content-type': 'application/octet-stream' });
  if (contentLength !== null) headers.set('content-length', contentLength);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers },
  );
}

describe('PRO room direct R2 upload orchestration', () => {
  it('reserves, PUTs with exact signed headers, completes, reports progress, and caches RAM bytes', async () => {
    const harness = apiHarness();
    harness.createMediaReservation.mockResolvedValue(reservation());
    harness.completeMedia.mockResolvedValue({ asset: source(), quota });
    const xhr = new FakeXhr();
    const keys = ['reserve-key-0001', 'complete-key-0002'];
    const progress: number[] = [];
    const transfer = new ProRoomMediaTransfer({
      api: harness.api,
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
      createIdempotencyKey: () => keys.shift()!,
    });
    const file = new File(['data'], 'orchestra.flac', {
      type: 'application/octet-stream',
    });

    const pending = transfer.upload({
      code: ROOM_CODE,
      file,
      onProgress: (value) => progress.push(value),
    });
    await waitForSend(xhr);
    xhr.upload.onprogress?.({
      loaded: 2,
      total: 4,
      lengthComputable: true,
    } as ProgressEvent);
    finishPut(xhr);

    await expect(pending).resolves.toEqual({ asset: source(), quota });
    expect(harness.createMediaReservation).toHaveBeenCalledWith(
      {
        code: ROOM_CODE,
        byteLength: 4,
        name: 'orchestra.flac',
        mime: 'audio/flac',
        idempotencyKey: 'reserve-key-0001',
      },
      undefined,
    );
    expect(xhr.method).toBe('PUT');
    expect(xhr.async).toBe(true);
    expect(xhr.withCredentials).toBe(false);
    expect(Object.fromEntries(xhr.headers)).toEqual(reservation().upload.headers);
    expect(xhr.sent).toBe(file);
    expect(harness.completeMedia).toHaveBeenCalledWith(
      {
        code: ROOM_CODE,
        assetId: ASSET_ID,
        idempotencyKey: 'complete-key-0002',
      },
      undefined,
    );
    expect(progress).toEqual([0.5, 1]);
    expect(transfer.cache.get(source(), 'orchestra.flac')).not.toBeNull();
  });

  it('best-effort releases a reservation after a failed PUT', async () => {
    const harness = apiHarness();
    harness.createMediaReservation.mockResolvedValue(reservation());
    harness.deleteMedia.mockResolvedValue({ assetId: ASSET_ID, quota });
    const xhr = new FakeXhr();
    const keys = ['reserve-key-0001', 'cleanup-key-0002'];
    const transfer = new ProRoomMediaTransfer({
      api: harness.api,
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
      createIdempotencyKey: () => keys.shift()!,
    });

    const pending = transfer.upload({ code: ROOM_CODE, file: new File(['data'], 'a.flac') });
    await waitForSend(xhr);
    finishPut(xhr, 503);

    await expect(pending).rejects.toMatchObject({
      code: 'PRO_ROOM_MEDIA_UPLOAD_HTTP_503',
    });
    expect(harness.deleteMedia).toHaveBeenCalledWith({
      code: ROOM_CODE,
      assetId: ASSET_ID,
      idempotencyKey: 'cleanup-key-0002',
    });
    expect(harness.completeMedia).not.toHaveBeenCalled();
  });

  it('abandons a fully stalled PUT without imposing a total transfer deadline', async () => {
    vi.useFakeTimers();
    const harness = apiHarness();
    harness.createMediaReservation.mockResolvedValue(reservation());
    harness.deleteMedia.mockResolvedValue({ assetId: ASSET_ID, quota });
    const xhr = new FakeXhr();
    const keys = ['reserve-key-0001', 'cleanup-key-0002'];
    const transfer = new ProRoomMediaTransfer({
      api: harness.api,
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
      createIdempotencyKey: () => keys.shift()!,
    });

    const pending = transfer.upload({ code: ROOM_CODE, file: new File(['data'], 'a.flac') });
    await waitForSend(xhr);
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'PRO_ROOM_MEDIA_UPLOAD_NETWORK',
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
    expect(xhr.aborted).toBe(true);
    expect(harness.deleteMedia).toHaveBeenCalledTimes(1);
  });

  it('does not treat duplicate zero-byte progress events as upload progress', async () => {
    vi.useFakeTimers();
    const harness = apiHarness();
    harness.createMediaReservation.mockResolvedValue(reservation());
    harness.deleteMedia.mockResolvedValue({ assetId: ASSET_ID, quota });
    const xhr = new FakeXhr();
    const keys = ['reserve-key-0001', 'cleanup-key-0002'];
    const progress: number[] = [];
    const transfer = new ProRoomMediaTransfer({
      api: harness.api,
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
      createIdempotencyKey: () => keys.shift()!,
    });

    const pending = transfer.upload({
      code: ROOM_CODE,
      file: new File(['data'], 'a.flac'),
      onProgress: (value) => progress.push(value),
    });
    await waitForSend(xhr);
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'PRO_ROOM_MEDIA_UPLOAD_NETWORK',
    });

    await vi.advanceTimersByTimeAsync(30_000);
    xhr.upload.onprogress?.({
      loaded: 0,
      total: 4,
      lengthComputable: true,
    } as ProgressEvent);
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(xhr.aborted).toBe(true);
    expect(progress).toEqual([]);
  });

  it('rejects a mismatched reservation descriptor before sending bytes', async () => {
    const harness = apiHarness();
    harness.createMediaReservation.mockResolvedValue({ ...reservation(), byteLength: 3 });
    const xhr = new FakeXhr();
    const transfer = new ProRoomMediaTransfer({
      api: harness.api,
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
      createIdempotencyKey: () => 'reserve-key-0001',
    });

    await expect(
      transfer.upload({ code: ROOM_CODE, file: new File(['data'], 'a.flac') }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_MEDIA_RESERVATION_MISMATCH' });
    expect(xhr.sent).toBeNull();
    expect(harness.completeMedia).not.toHaveBeenCalled();
    expect(harness.deleteMedia).not.toHaveBeenCalled();
  });

  it('does not delete an object after an ambiguous completion failure', async () => {
    const harness = apiHarness();
    harness.createMediaReservation.mockResolvedValue(reservation());
    harness.completeMedia.mockRejectedValue(new Error('response lost'));
    const xhr = new FakeXhr();
    const keys = ['reserve-key-0001', 'complete-key-0002'];
    const transfer = new ProRoomMediaTransfer({
      api: harness.api,
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
      createIdempotencyKey: () => keys.shift()!,
    });

    const pending = transfer.upload({ code: ROOM_CODE, file: new File(['data'], 'a.flac') });
    await waitForSend(xhr);
    finishPut(xhr);

    await expect(pending).rejects.toThrow('response lost');
    expect(harness.deleteMedia).not.toHaveBeenCalled();
  });

  it('aborts an in-flight PUT and releases its reservation', async () => {
    const harness = apiHarness();
    harness.createMediaReservation.mockResolvedValue(reservation());
    harness.deleteMedia.mockResolvedValue({ assetId: ASSET_ID, quota });
    const xhr = new FakeXhr();
    const controller = new AbortController();
    const keys = ['reserve-key-0001', 'cleanup-key-0002'];
    const transfer = new ProRoomMediaTransfer({
      api: harness.api,
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
      createIdempotencyKey: () => keys.shift()!,
    });

    const pending = transfer.upload({
      code: ROOM_CODE,
      file: new File(['data'], 'a.flac'),
      signal: controller.signal,
    });
    await waitForSend(xhr);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'PRO_ROOM_MEDIA_ABORTED' });
    expect(xhr.aborted).toBe(true);
    expect(harness.deleteMedia).toHaveBeenCalledOnce();
  });
});

describe('PRO room signed R2 download orchestration', () => {
  it('enforces the descriptor and byte count, preserves name/MIME, and uses credentialless fetch', async () => {
    const harness = apiHarness();
    harness.getMediaDownload.mockResolvedValue({
      asset: source(),
      url: presignedUrl(),
      expiresAtMs: 1_900_000_000_000,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(makeDownloadResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])]));
    const progress: number[] = [];
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });

    const file = await transfer.download({
      code: ROOM_CODE,
      name: 'orchestra.flac',
      source: source(),
      onProgress: (value) => progress.push(value),
    });

    expect(file.name).toBe('orchestra.flac');
    expect(file.type).toBe('audio/flac');
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3, 4]);
    expect(progress).toEqual([0.5, 1]);
    expect(fetchMock).toHaveBeenCalledWith(
      presignedUrl(),
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(new Headers(init?.headers).get('accept')).toBe('application/octet-stream');
  });

  it('serves subsequent names from the versioned RAM cache without another network request', async () => {
    const harness = apiHarness();
    harness.getMediaDownload.mockResolvedValue({
      asset: source(),
      url: presignedUrl(),
      expiresAtMs: 1_900_000_000_000,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(makeDownloadResponse([new Uint8Array([1, 2, 3, 4])]));
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });

    await transfer.download({ code: ROOM_CODE, name: 'first.flac', source: source() });
    const cached = await transfer.download({
      code: ROOM_CODE,
      name: 'renamed.flac',
      source: source(),
    });

    expect(cached.name).toBe('renamed.flac');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(harness.getMediaDownload).toHaveBeenCalledOnce();
  });

  it('abandons a GET only after the response body makes no progress for the idle window', async () => {
    vi.useFakeTimers();
    const harness = apiHarness();
    harness.getMediaDownload.mockResolvedValue({
      asset: source(),
      url: presignedUrl(),
      expiresAtMs: 1_900_000_000_000,
    });
    const stalledResponse = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': '4',
        },
      },
    );
    const transfer = new ProRoomMediaTransfer({
      api: harness.api,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(stalledResponse),
    });

    const pending = transfer.download({ code: ROOM_CODE, name: 'a.flac', source: source() });
    await Promise.resolve();
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'PRO_ROOM_MEDIA_DOWNLOAD_NETWORK',
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
  });

  it('settles caller cancellation even when the signed GET ignores its abort signal', async () => {
    const harness = apiHarness();
    harness.getMediaDownload.mockResolvedValue({
      asset: source(),
      url: presignedUrl(),
      expiresAtMs: 1_900_000_000_000,
    });
    let linkedSignal: AbortSignal | null = null;
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      linkedSignal = init?.signal ?? null;
      return new Promise<Response>(() => undefined);
    });
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });
    const controller = new AbortController();

    const pending = transfer.download({
      code: ROOM_CODE,
      name: 'a.flac',
      source: source(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error('caller stopped'));

    await expect(pending).rejects.toMatchObject({ code: 'PRO_ROOM_MEDIA_ABORTED' });
    expect((linkedSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('bounds stalled response headers and releases a late response without awaiting cancellation', async () => {
    vi.useFakeTimers();
    const harness = apiHarness();
    harness.getMediaDownload.mockResolvedValue({
      asset: source(),
      url: presignedUrl(),
      expiresAtMs: 1_900_000_000_000,
    });
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });

    const pending = transfer.download({ code: ROOM_CODE, name: 'a.flac', source: source() });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'PRO_ROOM_MEDIA_DOWNLOAD_NETWORK',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;

    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    resolveFetch({ body: { cancel } } as unknown as Response);
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not treat zero-byte stream chunks as download progress', async () => {
    vi.useFakeTimers();
    const harness = apiHarness();
    harness.getMediaDownload.mockResolvedValue({
      asset: source(),
      url: presignedUrl(),
      expiresAtMs: 1_900_000_000_000,
    });
    let emitted = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted >= 2) return new Promise<void>(() => undefined);
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              emitted += 1;
              controller.enqueue(new Uint8Array(0));
              resolve();
            }, 20_000);
          });
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': '4',
        },
      },
    );
    const progress: number[] = [];
    const transfer = new ProRoomMediaTransfer({
      api: harness.api,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    });

    const pending = transfer.download({
      code: ROOM_CODE,
      name: 'a.flac',
      source: source(),
      onProgress: (value) => progress.push(value),
    });
    await Promise.resolve();
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'PRO_ROOM_MEDIA_DOWNLOAD_NETWORK',
    });

    await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
    expect(emitted).toBe(2);
    expect(progress).toEqual([]);
  });

  it.each([
    ['missing', null, [new Uint8Array([1, 2, 3, 4])]],
    ['declared mismatch', '5', [new Uint8Array([1, 2, 3, 4])]],
    ['streamed short', '4', [new Uint8Array([1, 2, 3])]],
    ['streamed long', '4', [new Uint8Array([1, 2, 3, 4, 5])]],
  ])('rejects a %s download length', async (_label, length, chunks) => {
    const harness = apiHarness();
    harness.getMediaDownload.mockResolvedValue({
      asset: source(),
      url: presignedUrl(),
      expiresAtMs: 1_900_000_000_000,
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(makeDownloadResponse(chunks, length));
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });

    await expect(
      transfer.download({ code: ROOM_CODE, name: 'a.flac', source: source() }),
    ).rejects.toMatchObject({
      code:
        length === null
          ? 'PRO_ROOM_MEDIA_DOWNLOAD_LENGTH_MISSING'
          : 'PRO_ROOM_MEDIA_DOWNLOAD_SIZE_MISMATCH',
    });
    expect(transfer.cache.size).toBe(0);
  });

  it('does not let non-cooperative stream cleanup pin a size mismatch', async () => {
    const harness = apiHarness();
    harness.getMediaDownload.mockResolvedValue({
      asset: source(),
      url: presignedUrl(),
      expiresAtMs: 1_900_000_000_000,
    });
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
        },
        cancel,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': '4',
        },
      },
    );
    const transfer = new ProRoomMediaTransfer({
      api: harness.api,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    });

    await expect(
      transfer.download({ code: ROOM_CODE, name: 'a.flac', source: source() }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_MEDIA_DOWNLOAD_SIZE_MISMATCH' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transfer.cache.size).toBe(0);
  });

  it('rejects a descriptor swap and an untrusted signed URL before downloading bytes', async () => {
    const harness = apiHarness();
    harness.getMediaDownload.mockResolvedValueOnce({
      asset: source({ version: 2 }),
      url: presignedUrl(),
      expiresAtMs: 1_900_000_000_000,
    });
    const fetchMock = vi.fn<typeof fetch>();
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock });

    await expect(
      transfer.download({ code: ROOM_CODE, name: 'a.flac', source: source() }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_MEDIA_DOWNLOAD_ASSET_MISMATCH' });

    harness.getMediaDownload.mockResolvedValueOnce({
      asset: source(),
      url: 'https://evil.example/audio.flac',
      expiresAtMs: 1_900_000_000_000,
    });
    await expect(
      transfer.download({ code: ROOM_CODE, name: 'a.flac', source: source() }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_MEDIA_URL_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects assets beyond the product boundary before calling the API', async () => {
    const harness = apiHarness();
    const transfer = new ProRoomMediaTransfer({ api: harness.api });
    await expect(
      transfer.download({
        code: ROOM_CODE,
        name: 'too-large.wav',
        source: source({ byteLength: PRO_ROOM_MAX_ASSET_BYTES + 1 }),
      }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_MEDIA_INVALID_SOURCE' });
    expect(harness.getMediaDownload).not.toHaveBeenCalled();
  });

  it('can use a smaller explicit cache without turning it into an admission limit', async () => {
    const harness = apiHarness();
    harness.getMediaDownload.mockResolvedValue({
      asset: source(),
      url: presignedUrl(),
      expiresAtMs: 1_900_000_000_000,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(makeDownloadResponse([new Uint8Array([1, 2, 3, 4])]));
    const cache = new ProRoomAssetCache(2);
    const transfer = new ProRoomMediaTransfer({ api: harness.api, fetch: fetchMock, cache });

    await expect(
      transfer.download({ code: ROOM_CODE, name: 'a.flac', source: source() }),
    ).resolves.toBeInstanceOf(File);
    expect(cache.size).toBe(0);
  });
});

describe('PRO room media cleanup', () => {
  it('deletes through the authenticated API and evicts every cached asset version', async () => {
    const harness = apiHarness();
    harness.deleteMedia.mockResolvedValue({ assetId: ASSET_ID, quota });
    const transfer = new ProRoomMediaTransfer({
      api: harness.api,
      createIdempotencyKey: () => 'delete-key-0001',
    });
    transfer.cache.put(source(), new File(['data'], 'cached.flac', { type: 'audio/flac' }));

    await expect(transfer.deleteAsset({ code: ROOM_CODE, assetId: ASSET_ID })).resolves.toEqual({
      assetId: ASSET_ID,
      quota,
    });

    expect(harness.deleteMedia).toHaveBeenCalledWith(
      { code: ROOM_CODE, assetId: ASSET_ID, idempotencyKey: 'delete-key-0001' },
      undefined,
    );
    expect(transfer.cache.size).toBe(0);
  });
});
