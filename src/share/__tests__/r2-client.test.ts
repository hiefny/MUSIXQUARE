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
  requestHeaders: Record<string, string> = {};
  sentBody: Document | XMLHttpRequestBodyInit | null = null;
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

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name.toLowerCase()] = value;
  }
  send(body: Document | XMLHttpRequestBodyInit | null = null): void {
    this.sendCalls += 1;
    this.sentBody = body;
  }
  abort(): void {
    this.abortCalls += 1;
  }
}

const roomId = '123456';
const objectId = '00000000-0000-4000-8000-000000000001';
const queueItemId = '10000000-0000-4000-8000-000000000001';
const expectedUrl = `https://share.example.test/download/${roomId}/${objectId}`;

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

describe('plain whole-object authorization', () => {
  it('keeps the read token out of the URL and sends it only as a bearer header', async () => {
    const plainUrl = `https://share.example.test/v3/plain/download/${roomId}/${objectId}`;
    const downloadToken = `${'p'.repeat(40)}.${'s'.repeat(43)}`;
    const { downloadPlainObject } = await import('../r2-client.ts');
    const pending = downloadPlainObject(roomId, objectId, 4, downloadToken, plainUrl);
    const xhr = FakeXmlHttpRequest.instances.at(-1)!;

    expect(xhr.url).toBe(plainUrl);
    expect(xhr.url).not.toContain(downloadToken);
    expect(xhr.requestHeaders.authorization).toBe(`Bearer ${downloadToken}`);

    xhr.responseURL = plainUrl;
    xhr.response = new ArrayBuffer(4);
    xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load'));
    await expect(pending).resolves.toBe(xhr.response);
  });

  it('uploads the original Blob through the advertised plaintext protocol', async () => {
    const endpoint = 'https://plain-upload-share.example.test';
    const plainUrl = `${endpoint}/v3/plain/download/${roomId}/${objectId}`;
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
      configurable: true,
      value: endpoint,
    });
    const downloadToken = `${'p'.repeat(40)}.${'s'.repeat(43)}`;
    let sessionBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/security-config')) {
          return Response.json({
            capabilityRequired: false,
            plainWholeObjectVersion: 1,
            downloadAuthorizationVersion: 1,
          });
        }
        if (url.endsWith('/v3/plain/session')) {
          sessionBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({
            uploadUrl: 'https://r2.example.test/plain-signed-put',
            uploadHeaders: { 'x-amz-meta-storage-format': 'plain-whole-v1' },
            uploadUrlExpiresAt: Date.now() + 60_000,
            completeToken: 'complete-token',
            objectId,
            expiresAt: Date.now() + 300_000,
            cleanupToken: 'cleanup-token',
          });
        }
        if (url.endsWith('/v3/plain/complete')) {
          return Response.json({
            objectId,
            downloadUrl: plainUrl,
            expiresAt: Date.now() + 300_000,
            cleanupToken: 'cleanup-token',
            downloadToken,
          });
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const source = new Blob(['data'], { type: 'audio/mpeg' });
    const { uploadPlainBlob } = await import('../r2-client.ts');
    const pending = uploadPlainBlob(source, {
      roomId,
      name: 'song.mp3',
      mime: 'audio/mpeg',
      size: source.size,
      sessionId: 1,
      queueItemId,
    });

    await vi.waitFor(() => expect(FakeXmlHttpRequest.instances).toHaveLength(1));
    const xhr = FakeXmlHttpRequest.instances[0]!;
    expect(sessionBody).toMatchObject({ roomId, size: 4 });
    expect(sessionBody).not.toHaveProperty('encryptedSize');
    expect(xhr.sentBody).toBe(source);
    expect(xhr.requestHeaders['x-amz-meta-storage-format']).toBe('plain-whole-v1');
    xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load'));

    await expect(pending).resolves.toMatchObject({
      objectId,
      downloadUrl: plainUrl,
      downloadToken,
    });
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
