/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeXmlHttpRequest {
  static instances: FakeXmlHttpRequest[] = [];

  method = '';
  url = '';
  status = 200;
  response: unknown = null;
  responseURL = '';
  responseType: XMLHttpRequestResponseType = '';
  timeout = 0;
  sendCalls = 0;
  abortCalls = 0;
  upload = {} as XMLHttpRequestUpload;
  onload: ((this: XMLHttpRequest, ev: ProgressEvent<EventTarget>) => unknown) | null = null;
  onerror: ((this: XMLHttpRequest, ev: ProgressEvent<EventTarget>) => unknown) | null = null;
  ontimeout: ((this: XMLHttpRequest, ev: ProgressEvent<EventTarget>) => unknown) | null = null;
  onprogress: ((this: XMLHttpRequest, ev: ProgressEvent<EventTarget>) => unknown) | null = null;

  constructor() {
    FakeXmlHttpRequest.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(): void {}
  send(): void {
    this.sendCalls += 1;
  }
  abort(): void {
    this.abortCalls += 1;
  }
}

const roomId = '123456';
const objectId = '00000000-0000-4000-8000-000000000001';
const queueItemId = '10000000-0000-4000-8000-000000000001';
const expectedUrl = `https://share.example.test/download/${roomId}/${objectId}`;
const recordSize = 8 * 1024 * 1024;
const setId = '20000000-0000-4000-8000-000000000001';
const recordSetMeta = {
  storageRoomId: roomId,
  applicationSessionId: 'application-session',
  queueItemId,
  sourceIdentity: 'source-identity',
  name: 'recorded-song.mp3',
  mime: 'audio/mpeg',
  plaintextSize: 20,
  recordSize,
  recordCount: 1,
} as const;

function stalledJsonResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

function recordSetSuccessResponse(origin = 'https://share.example.test'): Response {
  return Response.json({
    v: 2,
    setId,
    recordSize,
    recordCount: 1,
    expiresAt: Date.now() + 60_000,
    setToken: 's'.repeat(32),
    cleanupToken: '30000000-0000-4000-8000-000000000001',
    records: [
      {
        index: 0,
        objectId,
        plaintextSize: 20,
        encryptedSize: 36,
        downloadUrl: `${origin}/download/${roomId}/${objectId}`,
      },
    ],
  });
}

beforeEach(() => {
  FakeXmlHttpRequest.instances.length = 0;
  vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
  Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
    configurable: true,
    value: 'https://share.example.test',
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__');
});

describe('R2 record-set control deadlines', () => {
  it('gives non-idempotent record-set creation its full 30-second attempt', async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://create-timeout-share.example.test',
    });
    let createSignal: AbortSignal | undefined;
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/security-config')) {
        return Response.json({ capabilityRequired: false });
      }
      if (url.endsWith('/v2/sets')) {
        createSignal = init?.signal ?? undefined;
        markCreateStarted();
        return stalledJsonResponse();
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createR2RecordSet } = await import('../r2-client.ts');
    const pending = createR2RecordSet(recordSetMeta);
    let settled = false;
    const outcome = pending.then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    void outcome.then(() => {
      settled = true;
    });
    await createStarted;
    expect(createSignal).toBeDefined();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);
    expect(createSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    expect(createSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await outcome;
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('REMOTE_SHARE_RECORD_SET_CREATE_TIMEOUT');
    expect(createSignal?.aborted).toBe(true);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v2/sets')),
    ).toHaveLength(1);
  });

  it('never downgrades a publisher-owned intent to the legacy unkeyed create route', async () => {
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://unsupported-intent-share.example.test',
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/security-config')) {
        return Response.json({
          capabilityRequired: false,
          recordSetCreateIdempotency: false,
        });
      }
      return new Response('unexpected mutation', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createR2RecordSet } = await import('../r2-client.ts');
    await expect(
      createR2RecordSet({
        ...recordSetMeta,
        publicationIntentId: '40000000-0000-4000-8000-000000000010',
      }),
    ).rejects.toThrow('REMOTE_SHARE_RECORD_SET_IDEMPOTENCY_UNSUPPORTED');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/v2/sets'))).toBe(false);
  });

  it('retries an ambiguous keyed create with the exact same intent and body', async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://keyed-create-share.example.test',
    });
    const publicationIntentId = '40000000-0000-4000-8000-000000000001';
    let createAttempts = 0;
    let markFirstCreateStarted!: () => void;
    const firstCreateStarted = new Promise<void>((resolve) => {
      markFirstCreateStarted = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/security-config')) {
        return Response.json({
          capabilityRequired: false,
          recordSetCreateIdempotency: true,
        });
      }
      if (url.endsWith('/v2/sets/idempotent')) {
        createAttempts += 1;
        if (createAttempts === 1) {
          markFirstCreateStarted();
          return stalledJsonResponse();
        }
        return recordSetSuccessResponse('https://keyed-create-share.example.test');
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createR2RecordSet } = await import('../r2-client.ts');
    const pending = createR2RecordSet({
      ...recordSetMeta,
      publicationIntentId,
    });
    await firstCreateStarted;
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(150);

    await expect(pending).resolves.toMatchObject({ setId, recordCount: 1 });
    const createCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/v2/sets/idempotent'),
    );
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]![1]?.headers).toMatchObject({
      'X-MXQR-Idempotency-Key': publicationIntentId,
    });
    expect(createCalls[1]![1]?.headers).toMatchObject({
      'X-MXQR-Idempotency-Key': publicationIntentId,
    });
    expect(createCalls[1]![1]?.body).toBe(createCalls[0]![1]?.body);
  });

  it('preserves the Worker idempotency-conflict code for publisher fencing', async () => {
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://conflicting-intent-share.example.test',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/security-config')) {
          return Response.json({
            capabilityRequired: false,
            recordSetCreateIdempotency: true,
          });
        }
        if (url.endsWith('/v2/sets/idempotent')) {
          return Response.json({ code: 'IDEMPOTENCY_CONFLICT' }, { status: 409 });
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { createR2RecordSet } = await import('../r2-client.ts');
    await expect(
      createR2RecordSet({
        ...recordSetMeta,
        publicationIntentId: '40000000-0000-4000-8000-000000000011',
      }),
    ).rejects.toThrow('REMOTE_SHARE_RECORD_SET_CREATE_IDEMPOTENCY_CONFLICT');
  });

  it('keeps a keyed create intent poisoned when a 409 response body is malformed', async () => {
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://malformed-conflict-share.example.test',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/security-config')) {
          return Response.json({
            capabilityRequired: false,
            recordSetCreateIdempotency: true,
          });
        }
        if (url.endsWith('/v2/sets/idempotent')) {
          return new Response('{', {
            status: 409,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { createR2RecordSet } = await import('../r2-client.ts');
    await expect(
      createR2RecordSet({
        ...recordSetMeta,
        publicationIntentId: '40000000-0000-4000-8000-000000000012',
      }),
    ).rejects.toThrow('REMOTE_SHARE_RECORD_SET_CREATE_IDEMPOTENCY_CONFLICT');
  });

  it('still aborts record-set creation immediately when its owner cancels', async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://create-owner-cancel-share.example.test',
    });
    let createSignal: AbortSignal | undefined;
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        if (url.endsWith('/v2/sets')) {
          createSignal = init?.signal ?? undefined;
          markCreateStarted();
          return stalledJsonResponse();
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { createR2RecordSet } = await import('../r2-client.ts');
    const controller = new AbortController();
    const pending = createR2RecordSet(recordSetMeta, controller.signal);
    await createStarted;
    expect(createSignal).toBeDefined();

    controller.abort(new Error('owner cancelled'));

    await expect(pending).rejects.toThrow('REMOTE_SHARE_ABORTED');
    expect(createSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fences a keyed create intent after owner cancellation', async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://keyed-cancel-share.example.test',
    });
    const publicationIntentId = '40000000-0000-4000-8000-000000000002';
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    let markCancelStarted!: (init: RequestInit | undefined) => void;
    const cancelStarted = new Promise<RequestInit | undefined>((resolve) => {
      markCancelStarted = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/security-config')) {
          return Response.json({
            capabilityRequired: false,
            recordSetCreateIdempotency: true,
          });
        }
        if (url.endsWith('/v2/sets/idempotent')) {
          markCreateStarted();
          return stalledJsonResponse();
        }
        if (url.endsWith('/v2/sets/intents/cancel')) {
          markCancelStarted(init);
          return Response.json({ ok: true });
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { createR2RecordSet } = await import('../r2-client.ts');
    const controller = new AbortController();
    const pending = createR2RecordSet(
      {
        ...recordSetMeta,
        publicationIntentId,
      },
      controller.signal,
    );
    await createStarted;
    controller.abort(new Error('owner cancelled'));

    await expect(pending).rejects.toThrow('REMOTE_SHARE_ABORTED');
    const cancelInit = await cancelStarted;
    expect(cancelInit?.headers).toMatchObject({
      'X-MXQR-Idempotency-Key': publicationIntentId,
    });
    expect(cancelInit?.keepalive).toBe(true);
  });

  it('treats a cancel-route 404 as rollback expiry cleanup after a fresh false probe', async () => {
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://rollback-cancel-share.example.test',
    });
    let configCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/security-config')) {
        configCalls += 1;
        return Response.json({
          capabilityRequired: false,
          recordSetCreateIdempotency: configCalls === 1,
        });
      }
      if (url.endsWith('/v2/sets/intents/cancel')) {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { cancelR2RecordSetCreateIntent } = await import('../r2-client.ts');
    await expect(
      cancelR2RecordSetCreateIntent({
        ...recordSetMeta,
        publicationIntentId: '40000000-0000-4000-8000-000000000012',
      }),
    ).resolves.toBeUndefined();
    expect(configCalls).toBe(2);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v2/sets/intents/cancel')),
    ).toHaveLength(1);
  });

  it('keeps record upload-authority requests on the shared 15-second deadline', async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://authority-timeout-share.example.test',
    });
    let authoritySignal: AbortSignal | undefined;
    let markAuthorityStarted!: () => void;
    const authorityStarted = new Promise<void>((resolve) => {
      markAuthorityStarted = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/records/0/upload')) {
          authoritySignal = init?.signal ?? undefined;
          markAuthorityStarted();
          return stalledJsonResponse();
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { requestR2RecordUploadAuthority } = await import('../r2-client.ts');
    const pending = requestR2RecordUploadAuthority(
      {
        v: 2,
        storageRoomId: roomId,
        setId,
        recordSize,
        recordCount: 1,
        expiresAt: Date.now() + 60_000,
        setToken: 's'.repeat(32),
        cleanupToken: '30000000-0000-4000-8000-000000000001',
        records: [
          {
            index: 0,
            objectId,
            plaintextSize: 20,
            encryptedSize: 36,
            downloadUrl: expectedUrl,
          },
        ],
      },
      0,
    );
    let settled = false;
    const outcome = pending.then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    void outcome.then(() => {
      settled = true;
    });
    await authorityStarted;
    expect(authoritySignal).toBeDefined();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    expect(authoritySignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await outcome;
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('REMOTE_SHARE_RECORD_UPLOAD_AUTHORITY_TIMEOUT');
    expect(authoritySignal?.aborted).toBe(true);
  });
});

describe('R2 download boundary', () => {
  it('rejects descriptor URLs outside the configured remote-share origin and object path', async () => {
    const { downloadEncryptedObject } = await import('../r2-client.ts');

    await expect(
      downloadEncryptedObject(roomId, objectId, 20, 'https://evil.example/collect'),
    ).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID');
    await expect(
      downloadEncryptedObject(roomId, objectId, 20, `${expectedUrl}?redirect=https://evil.example`),
    ).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID');
    expect(FakeXmlHttpRequest.instances).toHaveLength(0);
  });

  it('accepts only the descriptor-declared ciphertext length', async () => {
    const { downloadEncryptedObject } = await import('../r2-client.ts');
    const pending = downloadEncryptedObject(roomId, objectId, 20, expectedUrl);
    const xhr = FakeXmlHttpRequest.instances.at(-1)!;
    xhr.responseURL = expectedUrl;
    xhr.response = new ArrayBuffer(19);
    xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load'));

    await expect(pending).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
  });

  it('rejects a cross-origin redirect even when the response length matches', async () => {
    const { downloadEncryptedObject } = await import('../r2-client.ts');
    const pending = downloadEncryptedObject(roomId, objectId, 20, expectedUrl);
    const xhr = FakeXmlHttpRequest.instances.at(-1)!;
    xhr.responseURL = 'https://evil.example/collect';
    xhr.response = new ArrayBuffer(20);
    xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load'));

    await expect(pending).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID');
  });

  it('does not start an XHR when the owning operation is already aborted', async () => {
    const { downloadEncryptedObject } = await import('../r2-client.ts');
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadEncryptedObject(roomId, objectId, 20, expectedUrl, undefined, controller.signal),
    ).rejects.toThrow('REMOTE_SHARE_ABORTED');

    const xhr = FakeXmlHttpRequest.instances.at(-1)!;
    expect(xhr.abortCalls).toBe(1);
    expect(xhr.sendCalls).toBe(0);
  });

  it('times out only after a no-progress stall, not a fixed total duration', async () => {
    vi.useFakeTimers();
    const { downloadEncryptedObject } = await import('../r2-client.ts');
    const controller = new AbortController();
    const pending = downloadEncryptedObject(
      roomId,
      objectId,
      20,
      expectedUrl,
      undefined,
      controller.signal,
    );
    const xhr = FakeXmlHttpRequest.instances.at(-1)!;
    const rejected = expect(pending).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_STALLED');

    await vi.advanceTimersByTimeAsync(89_999);
    expect(xhr.abortCalls).toBe(0);
    xhr.onprogress?.call(
      xhr as unknown as XMLHttpRequest,
      new ProgressEvent('progress', { lengthComputable: true, loaded: 1, total: 20 }),
    );
    await vi.advanceTimersByTimeAsync(89_999);
    expect(xhr.abortCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    await rejected;
    expect(xhr.abortCalls).toBe(1);
    controller.abort();
    expect(xhr.abortCalls).toBe(1);
  });

  it('aborts immediately when bytes exceed the descriptor even without Content-Length', async () => {
    const { downloadEncryptedObject } = await import('../r2-client.ts');
    const controller = new AbortController();
    const pending = downloadEncryptedObject(
      roomId,
      objectId,
      20,
      expectedUrl,
      undefined,
      controller.signal,
    );
    const xhr = FakeXmlHttpRequest.instances.at(-1)!;

    xhr.onprogress?.call(
      xhr as unknown as XMLHttpRequest,
      new ProgressEvent('progress', { lengthComputable: false, loaded: 21 }),
    );

    await expect(pending).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
    expect(xhr.abortCalls).toBe(1);
    controller.abort();
    expect(xhr.abortCalls).toBe(1);
  });

  it('detaches its abort listener after a successful download', async () => {
    const { downloadEncryptedObject } = await import('../r2-client.ts');
    const controller = new AbortController();
    const pending = downloadEncryptedObject(
      roomId,
      objectId,
      20,
      expectedUrl,
      undefined,
      controller.signal,
    );
    const xhr = FakeXmlHttpRequest.instances.at(-1)!;
    xhr.responseURL = expectedUrl;
    xhr.response = new ArrayBuffer(20);
    xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load'));

    await expect(pending).resolves.toBe(xhr.response);
    controller.abort();
    expect(xhr.abortCalls).toBe(0);
  });

  it('does not extend the stall deadline for duplicate zero-progress events', async () => {
    vi.useFakeTimers();
    const { downloadEncryptedObject } = await import('../r2-client.ts');
    const pending = downloadEncryptedObject(roomId, objectId, 20, expectedUrl);
    const xhr = FakeXmlHttpRequest.instances.at(-1)!;
    const rejected = expect(pending).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_STALLED');

    await vi.advanceTimersByTimeAsync(45_000);
    const progress = new ProgressEvent('progress', {
      lengthComputable: true,
      loaded: 1,
      total: 20,
    });
    xhr.onprogress?.call(xhr as unknown as XMLHttpRequest, progress);
    await vi.advanceTimersByTimeAsync(45_000);
    xhr.onprogress?.call(xhr as unknown as XMLHttpRequest, progress);
    await vi.advanceTimersByTimeAsync(45_000);

    await rejected;
    expect(xhr.abortCalls).toBe(1);
  });
});

describe('R2 upload progress watchdog', () => {
  it('cancels a non-success security-config body before using the safe fallback', async () => {
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://security-error-share.example.test',
    });
    const cancelSecurityBody = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/security-config')) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
              cancel: cancelSecurityBody,
            }),
            { status: 503 },
          );
        }
        if (url.endsWith('/session')) return new Response('{}', { status: 503 });
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { uploadEncryptedBlob } = await import('../r2-client.ts');
    await expect(
      uploadEncryptedBlob(new Blob([new Uint8Array(20)]), {
        roomId,
        name: 'security-error.mp3',
        mime: 'audio/mpeg',
        size: 4,
        sessionId: 9,
        queueItemId,
      }),
    ).rejects.toThrow('REMOTE_SHARE_SESSION_HTTP_503');

    expect(cancelSecurityBody).toHaveBeenCalledOnce();
    expect(FakeXmlHttpRequest.instances).toHaveLength(0);
  });

  it('releases a session request whose JSON body stalls after response headers', async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://stalled-share.example.test',
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/security-config')) {
        return Response.json({ capabilityRequired: false });
      }
      if (url.endsWith('/session')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { uploadEncryptedBlob } = await import('../r2-client.ts');
    const pending = uploadEncryptedBlob(new Blob([new Uint8Array(20)]), {
      roomId,
      name: 'stalled.mp3',
      mime: 'audio/mpeg',
      size: 4,
      sessionId: 5,
      queueItemId,
    });
    const rejected = expect(pending).rejects.toThrow('REMOTE_SHARE_SESSION_TIMEOUT');
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'https://stalled-share.example.test/session',
        expect.objectContaining({ method: 'POST' }),
      ),
    );

    await vi.advanceTimersByTimeAsync(15_000);

    await rejected;
    expect(FakeXmlHttpRequest.instances).toHaveLength(0);
  });

  it('bounds a completed session control response before creating the upload XHR', async () => {
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: 'https://oversized-share.example.test',
    });
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        if (url.endsWith('/session')) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([123, 125]));
                controller.close();
              },
              cancel,
            }),
            {
              headers: {
                'content-type': 'application/json',
                'content-length': String(64 * 1024 + 1),
              },
            },
          );
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { uploadEncryptedBlob } = await import('../r2-client.ts');
    await expect(
      uploadEncryptedBlob(new Blob([new Uint8Array(20)]), {
        roomId,
        name: 'oversized.mp3',
        mime: 'audio/mpeg',
        size: 4,
        sessionId: 6,
        queueItemId,
      }),
    ).rejects.toThrow('REMOTE_SHARE_BAD_SESSION_RESPONSE');

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(FakeXmlHttpRequest.instances).toHaveLength(0);
  });

  it('stalls on no new uploaded bytes and ignores duplicate progress events', async () => {
    vi.useFakeTimers();
    let cleanupCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        if (url.endsWith('/session')) {
          return Response.json({
            uploadUrl: 'https://r2.example.test/signed-put',
            uploadHeaders: {},
            uploadUrlExpiresAt: Date.now() + 60_000,
            completeToken: 'complete-token',
            objectId,
            expiresAt: Date.now() + 300_000,
            cleanupToken: 'cleanup-token',
          });
        }
        if (url.includes('/object/')) {
          cleanupCalls += 1;
          expect(init?.method).toBe('DELETE');
          expect(new Headers(init?.headers).get('x-mxqr-cleanup-token')).toBe('cleanup-token');
          return Response.json({ ok: true });
        }
        return new Response('unexpected', { status: 500 });
      }),
    );
    const { uploadEncryptedBlob } = await import('../r2-client.ts');
    const controller = new AbortController();
    const pending = uploadEncryptedBlob(
      new Blob([new Uint8Array(20)]),
      {
        roomId,
        name: 'song.mp3',
        mime: 'audio/mpeg',
        size: 4,
        sessionId: 7,
        queueItemId,
      },
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(FakeXmlHttpRequest.instances).toHaveLength(1));
    const xhr = FakeXmlHttpRequest.instances[0];
    const rejected = expect(pending).rejects.toThrow('REMOTE_SHARE_UPLOAD_STALLED');
    const upload = xhr.upload as XMLHttpRequestUpload & {
      onprogress?: (event: ProgressEvent<EventTarget>) => void;
    };

    await vi.advanceTimersByTimeAsync(45_000);
    const progress = new ProgressEvent('progress', {
      lengthComputable: true,
      loaded: 1,
      total: 20,
    });
    upload.onprogress?.(progress);
    await vi.advanceTimersByTimeAsync(45_000);
    upload.onprogress?.(progress);
    await vi.advanceTimersByTimeAsync(45_000);

    await rejected;
    expect(xhr.abortCalls).toBe(1);
    controller.abort();
    expect(xhr.abortCalls).toBe(1);
    await vi.waitFor(() => expect(cleanupCalls).toBe(1));
  });

  it('completes a steadily progressing PUT after its ten-minute start URL expires', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-07-11T00:00:00.000Z');
    vi.setSystemTime(startedAt);
    let completeCalls = 0;
    let cleanupCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        if (url.endsWith('/session')) {
          return Response.json({
            uploadUrl: 'https://r2.example.test/signed-put',
            uploadHeaders: {},
            uploadUrlExpiresAt: startedAt.getTime() + 10 * 60_000,
            completeToken: 'complete-token',
            objectId,
            expiresAt: startedAt.getTime() + 60 * 60_000,
            cleanupToken: 'cleanup-token',
          });
        }
        if (url.endsWith('/complete')) {
          completeCalls++;
          return Response.json({
            objectId,
            downloadUrl: expectedUrl,
            expiresAt: startedAt.getTime() + 60 * 60_000,
          });
        }
        if (url.includes('/object/')) {
          cleanupCalls += 1;
          return Response.json({ ok: true });
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { uploadEncryptedBlob } = await import('../r2-client.ts');
    const pending = uploadEncryptedBlob(new Blob([new Uint8Array(20)]), {
      roomId,
      name: 'slow.wav',
      mime: 'audio/wav',
      size: 4,
      sessionId: 8,
      queueItemId,
    });
    await vi.waitFor(() => expect(FakeXmlHttpRequest.instances).toHaveLength(1));
    const xhr = FakeXmlHttpRequest.instances[0];
    const upload = xhr.upload as XMLHttpRequestUpload & {
      onprogress?: (event: ProgressEvent<EventTarget>) => void;
    };

    for (let minute = 1; minute <= 11; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      upload.onprogress?.(
        new ProgressEvent('progress', {
          lengthComputable: true,
          loaded: minute,
          total: 20,
        }),
      );
    }
    expect(Date.now()).toBeGreaterThanOrEqual(startedAt.getTime() + 11 * 60_000);
    expect(xhr.abortCalls).toBe(0);

    xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load'));
    await expect(pending).resolves.toMatchObject({ objectId, downloadUrl: expectedUrl });
    expect(completeCalls).toBe(1);
    expect(cleanupCalls).toBe(0);
  });
});
