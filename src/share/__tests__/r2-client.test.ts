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
  sendCalls = 0;
  abortCalls = 0;
  requestHeaders: Record<string, string> = {};
  sentBody: Document | XMLHttpRequestBodyInit | null = null;
  upload = {} as XMLHttpRequestUpload;
  onload: ((this: XMLHttpRequest, ev: ProgressEvent<EventTarget>) => unknown) | null = null;
  onerror: ((this: XMLHttpRequest, ev: ProgressEvent<EventTarget>) => unknown) | null = null;
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

const endpoint = 'https://share.example.test';
const roomId = '123456';
const objectId = '00000000-0000-4000-8000-000000000001';
const queueItemId = '10000000-0000-4000-8000-000000000001';
const downloadUrl = `${endpoint}/download/${roomId}/${objectId}`;
const downloadToken = `${'p'.repeat(40)}.${'s'.repeat(43)}`;

function securityConfig(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    capabilityRequired: false,
    wholeObjectVersion: 1,
    downloadAuthorizationVersion: 1,
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetModules();
  FakeXmlHttpRequest.instances.length = 0;
  vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
  Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
    configurable: true,
    value: endpoint,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__');
});

describe('R2 authenticated whole-object download', () => {
  it('pins the canonical origin/path and keeps read authority in a bearer header', async () => {
    const { downloadWholeObject } = await import('../r2-client.ts');

    await expect(
      downloadWholeObject(roomId, objectId, 4, downloadToken, 'https://evil.example/collect'),
    ).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID');
    expect(FakeXmlHttpRequest.instances).toHaveLength(0);

    const pending = downloadWholeObject(roomId, objectId, 4, downloadToken, downloadUrl);
    const xhr = FakeXmlHttpRequest.instances.at(-1)!;
    expect(xhr.url).toBe(downloadUrl);
    expect(xhr.url).not.toContain(downloadToken);
    expect(xhr.requestHeaders.authorization).toBe(`Bearer ${downloadToken}`);

    xhr.responseURL = downloadUrl;
    xhr.response = new ArrayBuffer(4);
    xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load'));
    await expect(pending).resolves.toBe(xhr.response);
  });

  it('rejects invalid authority, redirects, and descriptor length mismatches', async () => {
    const { downloadWholeObject } = await import('../r2-client.ts');
    await expect(downloadWholeObject(roomId, objectId, 4, 'invalid')).rejects.toThrow(
      'REMOTE_SHARE_DOWNLOAD_AUTH_INVALID',
    );

    const redirected = downloadWholeObject(roomId, objectId, 4, downloadToken, downloadUrl);
    const redirectXhr = FakeXmlHttpRequest.instances.at(-1)!;
    redirectXhr.responseURL = 'https://evil.example/collect';
    redirectXhr.response = new ArrayBuffer(4);
    redirectXhr.onload?.call(redirectXhr as unknown as XMLHttpRequest, new ProgressEvent('load'));
    await expect(redirected).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID');

    const mismatched = downloadWholeObject(roomId, objectId, 4, downloadToken, downloadUrl);
    const mismatchXhr = FakeXmlHttpRequest.instances.at(-1)!;
    mismatchXhr.responseURL = downloadUrl;
    mismatchXhr.response = new ArrayBuffer(3);
    mismatchXhr.onload?.call(mismatchXhr as unknown as XMLHttpRequest, new ProgressEvent('load'));
    await expect(mismatched).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
  });

  it('aborts an already-cancelled owner before sending bytes', async () => {
    const { downloadWholeObject } = await import('../r2-client.ts');
    const abort = new AbortController();
    abort.abort();

    await expect(
      downloadWholeObject(roomId, objectId, 4, downloadToken, downloadUrl, undefined, abort.signal),
    ).rejects.toThrow('REMOTE_SHARE_ABORTED');
    const xhr = FakeXmlHttpRequest.instances.at(-1)!;
    expect(xhr.abortCalls).toBe(1);
    expect(xhr.sendCalls).toBe(0);
  });
});

describe('R2 canonical whole-object upload', () => {
  it('uses only root control routes and validates the complete stored size', async () => {
    let sessionBody: Record<string, unknown> | null = null;
    let completeBody: Record<string, unknown> | null = null;
    const expiresAt = Date.now() + 86_400_000;
    const cleanupToken = `${'c'.repeat(40)}.${'t'.repeat(43)}`;
    const expectedUploadHeaders = {
      'content-type': 'application/octet-stream',
      'x-amz-meta-cleanup-token': cleanupToken,
      'x-amz-meta-expires-at': String(expiresAt),
      'x-amz-meta-format-version': 'whole-object-v1',
      'x-amz-meta-mime': 'audio%2Fmpeg',
      'x-amz-meta-name': 'song.mp3',
      'x-amz-meta-object-id': objectId,
      'x-amz-meta-room-id': roomId,
      'x-amz-meta-stored-size': '4',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${endpoint}/security-config`) return securityConfig();
      if (url === `${endpoint}/session`) {
        sessionBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          uploadUrl: 'https://r2.example.test/signed-put',
          uploadHeaders: expectedUploadHeaders,
          uploadUrlExpiresAt: Date.now() + 60_000,
          completeToken: 'complete-token',
          objectId,
          expiresAt,
          cleanupToken,
        });
      }
      if (url === `${endpoint}/complete`) {
        completeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          objectId,
          downloadUrl,
          storedSize: 4,
          expiresAt,
          cleanupToken,
          downloadToken,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { uploadWholeObject } = await import('../r2-client.ts');
    const source = new Blob(['data'], { type: 'audio/mpeg' });

    const pending = uploadWholeObject(source, {
      roomId,
      name: 'song.mp3',
      mime: 'audio/mpeg',
      size: 4,
      sessionId: 7,
      queueItemId,
    });
    await vi.waitFor(() => expect(FakeXmlHttpRequest.instances).toHaveLength(1));
    const xhr = FakeXmlHttpRequest.instances[0]!;
    expect(xhr.method).toBe('PUT');
    expect(xhr.sentBody).toBe(source);
    expect(xhr.requestHeaders).toEqual(expectedUploadHeaders);
    xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load'));

    await expect(pending).resolves.toMatchObject({ objectId, storedSize: 4, downloadToken });
    expect(sessionBody).toEqual({
      roomId,
      sessionId: 7,
      queueItemId,
      name: 'song.mp3',
      mime: 'audio/mpeg',
      size: 4,
    });
    expect(completeBody).toEqual({ roomId, objectId, completeToken: 'complete-token' });
  });

  it('fails closed when the Worker does not advertise the sole contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => securityConfig({ wholeObjectVersion: 0 })),
    );
    const { uploadWholeObject } = await import('../r2-client.ts');

    await expect(
      uploadWholeObject(new Blob(['data']), {
        roomId,
        name: 'song.mp3',
        mime: 'audio/mpeg',
        size: 4,
        sessionId: 7,
        queueItemId,
      }),
    ).rejects.toThrow('REMOTE_SHARE_PROTOCOL_UNAVAILABLE');
    expect(FakeXmlHttpRequest.instances).toHaveLength(0);
  });

  it('rejects an unsigned cleanup authority before opening the direct PUT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === `${endpoint}/security-config`) return securityConfig();
        return Response.json({
          uploadUrl: 'https://r2.example.test/signed-put',
          uploadHeaders: { 'content-type': 'application/octet-stream' },
          uploadUrlExpiresAt: Date.now() + 60_000,
          completeToken: 'complete-token',
          objectId,
          expiresAt: Date.now() + 60_000,
          cleanupToken: '00000000-0000-4000-8000-000000000009',
        });
      }),
    );
    const { uploadWholeObject } = await import('../r2-client.ts');

    await expect(
      uploadWholeObject(new Blob(['data']), {
        roomId,
        name: 'song.mp3',
        mime: 'audio/mpeg',
        size: 4,
        sessionId: 7,
        queueItemId,
      }),
    ).rejects.toThrow('REMOTE_SHARE_BAD_SESSION_RESPONSE');
    expect(FakeXmlHttpRequest.instances).toHaveLength(0);
  });
});
