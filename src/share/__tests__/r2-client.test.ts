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
    const pending = downloadEncryptedObject(roomId, objectId, 20, expectedUrl);
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
  it('stalls on no new uploaded bytes and ignores duplicate progress events', async () => {
    vi.useFakeTimers();
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
            uploadUrlExpiresAt: Date.now() + 60_000,
            completeToken: 'complete-token',
            objectId,
            expiresAt: Date.now() + 300_000,
          });
        }
        return new Response('unexpected', { status: 500 });
      }),
    );
    const { uploadEncryptedBlob } = await import('../r2-client.ts');
    const pending = uploadEncryptedBlob(new Blob([new Uint8Array(20)]), {
      roomId,
      name: 'song.mp3',
      mime: 'audio/mpeg',
      size: 4,
      sessionId: 7,
      queueItemId,
    });
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
  });

  it('completes a steadily progressing PUT after its ten-minute start URL expires', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-07-11T00:00:00.000Z');
    vi.setSystemTime(startedAt);
    let completeCalls = 0;
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
  });
});
