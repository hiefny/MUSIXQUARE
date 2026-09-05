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
const productionEndpoint = 'https://share.musixquare.com';
const uploadHost = 'r2.example.test';
const endpointStorageKey = 'musixquare-remote-share-endpoint';
const sessionActorStorageKey = 'musixquare-remote-share-session-actor-v3';
const roomId = '123456';
const objectId = '00000000-0000-4000-8000-000000000001';
const queueItemId = '10000000-0000-4000-8000-000000000001';
const downloadUrl = `${endpoint}/download/${roomId}/${objectId}`;
const downloadToken = `${'p'.repeat(40)}.${'s'.repeat(43)}`;
const completeToken = `${'q'.repeat(40)}.${'r'.repeat(43)}`;

function presignedUpload(
  uploadHeaders: Record<string, string>,
  options: { host?: string; object?: string; room?: string; expiresSeconds?: number } = {},
): { uploadUrl: string; uploadUrlExpiresAt: number } {
  const signingTime = Math.floor(Date.now() / 1000) * 1000;
  const amzDate = new Date(signingTime).toISOString().replace(/[-:]|\.000/g, '');
  const expiresSeconds = options.expiresSeconds ?? 600;
  const signedHeaders = [...Object.keys(uploadHeaders), 'content-length', 'host'].sort().join(';');
  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
    'X-Amz-Credential': `R2TESTACCESSKEY123456789/${amzDate.slice(0, 8)}/auto/s3/aws4_request`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-Signature': 'a'.repeat(64),
    'X-Amz-SignedHeaders': signedHeaders,
  });
  return {
    uploadUrl:
      `https://${options.host ?? uploadHost}/musixquare-remote-share/room/` +
      `${options.room ?? roomId}/${options.object ?? objectId}?${params}`,
    uploadUrlExpiresAt: signingTime + expiresSeconds * 1000,
  };
}

function canonicalUploadHeaders(
  expiresAt: number,
  cleanupToken: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    'content-type': 'application/octet-stream',
    'if-match': '"placeholder-etag"',
    'x-amz-meta-cleanup-token': cleanupToken,
    'x-amz-meta-expires-at': String(expiresAt),
    'x-amz-meta-format-version': 'whole-object-v1',
    'x-amz-meta-mime': 'audio%2Fmpeg',
    'x-amz-meta-name': 'song.mp3',
    'x-amz-meta-object-id': objectId,
    'x-amz-meta-room-id': roomId,
    'x-amz-meta-stored-size': '4',
    ...overrides,
  };
}

function securityConfig(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    capabilityRequired: false,
    workerContractVersion: 3,
    sessionReplayRequired: true,
    sessionReplayEnabled: true,
    wholeObjectVersion: 1,
    downloadAuthorizationVersion: 1,
    roomUploadAssertionVersion: 1,
    roomUploadAssertionMode: 'optional',
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
  Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_UPLOAD_HOST__', {
    configurable: true,
    value: uploadHost,
  });
  localStorage.removeItem(endpointStorageKey);
  sessionStorage.removeItem(sessionActorStorageKey);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__');
  Reflect.deleteProperty(window, '__MUSIXQUARE_REMOTE_SHARE_UPLOAD_HOST__');
  localStorage.removeItem(endpointStorageKey);
  sessionStorage.removeItem(sessionActorStorageKey);
});

describe('remote-share endpoint policy', () => {
  it('pins the canonical endpoint on production hosts before reading runtime overrides', async () => {
    vi.stubGlobal('location', { hostname: 'musixquare.com' });
    localStorage.setItem(endpointStorageKey, 'https://stored.example.test');
    const { downloadWholeObject } = await import('../r2-client.ts');
    const canonicalDownloadUrl = `${productionEndpoint}/download/${roomId}/${objectId}`;

    const pending = downloadWholeObject(roomId, objectId, 4, downloadToken, canonicalDownloadUrl);
    const xhr = FakeXmlHttpRequest.instances.at(-1)!;
    expect(xhr.url).toBe(canonicalDownloadUrl);
    expect(xhr.url).not.toContain('share.example.test');
    expect(xhr.url).not.toContain('stored.example.test');

    xhr.responseURL = canonicalDownloadUrl;
    xhr.response = new ArrayBuffer(4);
    xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load'));
    await expect(pending).resolves.toBe(xhr.response);
  });

  it('pins production subdomains and rejects overrides on untrusted production-build hosts', async () => {
    const { resolveRemoteShareEndpointPolicy } = await import('../remote-share-endpoint.ts');
    const overrides = {
      injected: endpoint,
      stored: 'https://stored.example.test',
      allowRuntimeOverrides: false,
    };

    expect(resolveRemoteShareEndpointPolicy({ hostname: 'www.musixquare.com', ...overrides })).toBe(
      productionEndpoint,
    );
    expect(
      resolveRemoteShareEndpointPolicy({ hostname: 'preview.example.com', ...overrides }),
    ).toBeNull();
  });

  it('allows explicit overrides only for trusted development contexts', async () => {
    const { resolveRemoteShareEndpointPolicy } = await import('../remote-share-endpoint.ts');

    expect(
      resolveRemoteShareEndpointPolicy({
        hostname: 'preview.example.com',
        injected: endpoint,
        allowRuntimeOverrides: true,
      }),
    ).toBe(endpoint);
    expect(
      resolveRemoteShareEndpointPolicy({
        hostname: '127.0.0.1',
        stored: 'http://127.0.0.1:8788/',
        allowRuntimeOverrides: false,
      }),
    ).toBe('http://127.0.0.1:8788');
  });
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

  it('settles a valid download even when its progress observer throws', async () => {
    const { downloadWholeObject } = await import('../r2-client.ts');
    const onProgress = vi.fn(() => {
      throw new Error('observer failed');
    });
    const pending = downloadWholeObject(
      roomId,
      objectId,
      4,
      downloadToken,
      downloadUrl,
      onProgress,
    );
    const xhr = FakeXmlHttpRequest.instances.at(-1)!;
    xhr.responseURL = downloadUrl;
    xhr.response = new ArrayBuffer(4);

    expect(() =>
      xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load')),
    ).not.toThrow();
    await expect(pending).resolves.toBe(xhr.response);
    expect(onProgress).toHaveBeenCalledWith(1);
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
    const expectedUploadHeaders = canonicalUploadHeaders(expiresAt, cleanupToken);
    const upload = presignedUpload(expectedUploadHeaders);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${endpoint}/security-config`) return securityConfig();
      if (url === `${endpoint}/session`) {
        sessionBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          uploadUrl: upload.uploadUrl,
          uploadHeaders: expectedUploadHeaders,
          uploadUrlExpiresAt: upload.uploadUrlExpiresAt,
          completeToken,
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
    expect(xhr.url).toBe(upload.uploadUrl);
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
      requestId: expect.stringMatching(/^rs3_[A-Za-z0-9_-]{43}$/),
      actorId: expect.stringMatching(/^rsa_[A-Za-z0-9_-]{43}$/),
    });
    expect(completeBody).toEqual({ roomId, objectId, completeToken });
  });

  it('binds an advertised room assertion to the exact session body and sends it only to /session', async () => {
    const expiresAt = Date.now() + 86_400_000;
    const cleanupToken = `${'c'.repeat(40)}.${'t'.repeat(43)}`;
    const expectedUploadHeaders = canonicalUploadHeaders(expiresAt, cleanupToken);
    const upload = presignedUpload(expectedUploadHeaders);
    const assertion = `${'a'.repeat(80)}.${'b'.repeat(43)}`;
    const requestRoomUploadAssertion = vi.fn(async (_request: unknown) => assertion);
    let sessionBody = '';
    let sessionHeaders = new Headers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${endpoint}/security-config`) {
        return securityConfig({
          roomUploadAssertionVersion: 1,
          roomUploadAssertionMode: 'required',
        });
      }
      if (url === `${endpoint}/session`) {
        sessionBody = String(init?.body);
        sessionHeaders = new Headers(init?.headers);
        return Response.json({
          uploadUrl: upload.uploadUrl,
          uploadHeaders: expectedUploadHeaders,
          uploadUrlExpiresAt: upload.uploadUrlExpiresAt,
          completeToken,
          objectId,
          expiresAt,
          cleanupToken,
        });
      }
      if (url === `${endpoint}/complete`) {
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

    const pending = uploadWholeObject(new Blob(['data'], { type: 'audio/mpeg' }), {
      roomId,
      name: 'song.mp3',
      mime: 'audio/mpeg',
      size: 4,
      sessionId: 7,
      queueItemId,
      requestRoomUploadAssertion,
    });
    await vi.waitFor(() => expect(FakeXmlHttpRequest.instances).toHaveLength(1));
    const xhr = FakeXmlHttpRequest.instances[0]!;
    xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load'));
    await expect(pending).resolves.toMatchObject({ objectId, storedSize: 4 });

    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionBody)),
    );
    let binary = '';
    for (const byte of digest) binary += String.fromCharCode(byte);
    const expectedBodySha256 = btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    expect(requestRoomUploadAssertion).toHaveBeenCalledOnce();
    expect(requestRoomUploadAssertion.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 7,
      queueItemId,
      size: 4,
      bodySha256: expectedBodySha256,
      actorId: expect.stringMatching(/^rsa_[A-Za-z0-9_-]{43}$/),
      requestId: expect.stringMatching(/^rs3_[A-Za-z0-9_-]{43}$/),
    });
    expect(sessionHeaders.get('x-mxqr-room-upload-assertion')).toBe(assertion);
    expect(xhr.requestHeaders).not.toHaveProperty('x-mxqr-room-upload-assertion');
  });

  it('fails before /session when the Remote Worker requires an unsupported assertion', async () => {
    const fetchMock = vi.fn(async () =>
      securityConfig({
        roomUploadAssertionVersion: 1,
        roomUploadAssertionMode: 'required',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
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
    ).rejects.toThrow('REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeXmlHttpRequest.instances).toHaveLength(0);
  });

  it('fails closed before /session when the Remote Worker disables the assertion contract', async () => {
    const fetchMock = vi.fn(async () =>
      securityConfig({
        roomUploadAssertionVersion: 0,
        roomUploadAssertionMode: 'disabled',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeXmlHttpRequest.instances).toHaveLength(0);
  });

  it('never downgrades after an assertion-aware security contract was observed', async () => {
    let securityConfigReads = 0;
    let sessionRequests = 0;
    const requestRoomUploadAssertion = vi.fn(async (_request: unknown) =>
      Promise.resolve(`${'a'.repeat(80)}.${'b'.repeat(43)}`),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${endpoint}/security-config`) {
        securityConfigReads += 1;
        return securityConfig(
          securityConfigReads === 1
            ? { roomUploadAssertionVersion: 1, roomUploadAssertionMode: 'optional' }
            : { roomUploadAssertionVersion: 0, roomUploadAssertionMode: 'disabled' },
        );
      }
      if (url === `${endpoint}/session`) {
        sessionRequests += 1;
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { uploadWholeObject } = await import('../r2-client.ts');

    await expect(
      uploadWholeObject(new Blob(['data']), {
        roomId,
        name: 'song.mp3',
        mime: 'audio/mpeg',
        size: 4,
        sessionId: 7,
        queueItemId,
        requestRoomUploadAssertion,
      }),
    ).rejects.toThrow('REMOTE_SHARE_PROTOCOL_UNAVAILABLE');
    expect(securityConfigReads).toBe(2);
    expect(sessionRequests).toBe(1);
    expect(requestRoomUploadAssertion).toHaveBeenCalledOnce();
    expect(FakeXmlHttpRequest.instances).toHaveLength(0);
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

  it('fails closed when worker v3 does not advertise durable session replay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => securityConfig({ sessionReplayEnabled: false })),
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

  it('fails closed on malformed UTF-8 in the security contract', async () => {
    const prefix = new TextEncoder().encode(
      '{"capabilityRequired":false,"workerContractVersion":3,"sessionReplayRequired":true,"sessionReplayEnabled":true,"wholeObjectVersion":1,"downloadAuthorizationVersion":1,"x":"',
    );
    const suffix = new TextEncoder().encode('"}');
    const bytes = new Uint8Array(prefix.byteLength + 2 + suffix.byteLength);
    bytes.set(prefix, 0);
    bytes.set([0xc3, 0x28], prefix.byteLength);
    bytes.set(suffix, prefix.byteLength + 2);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes)),
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
    const expiresAt = Date.now() + 86_400_000;
    const cleanupToken = '00000000-0000-4000-8000-000000000009';
    const uploadHeaders = canonicalUploadHeaders(expiresAt, cleanupToken);
    const upload = presignedUpload(uploadHeaders);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === `${endpoint}/security-config`) return securityConfig();
        return Response.json({
          uploadUrl: upload.uploadUrl,
          uploadHeaders,
          uploadUrlExpiresAt: upload.uploadUrlExpiresAt,
          completeToken,
          objectId,
          expiresAt,
          cleanupToken,
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

  it.each([
    ['an arbitrary destination', (url: string) => url.replace(uploadHost, 'evil.example')],
    ['embedded userinfo', (url: string) => url.replace('https://', 'https://user@')],
    ['an explicit default port', (url: string) => url.replace(uploadHost, `${uploadHost}:443`)],
    [
      'a normalized dot path',
      (url: string) =>
        url.replace('/musixquare-remote-share/room/', '/musixquare-remote-share/./room/'),
    ],
    [
      'a non-canonical object path',
      (url: string) => url.replace(`/room/${roomId}/${objectId}`, `/room/${roomId}/other`),
    ],
    ['an unknown query field', (url: string) => `${url}&redirect=1`],
    ['a URL fragment', (url: string) => `${url}#signed`],
  ])('rejects %s before creating a byte-carrying XHR', async (_label, mutateUrl) => {
    const expiresAt = Date.now() + 86_400_000;
    const cleanupToken = `${'c'.repeat(40)}.${'t'.repeat(43)}`;
    const uploadHeaders = canonicalUploadHeaders(expiresAt, cleanupToken);
    const upload = presignedUpload(uploadHeaders);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === `${endpoint}/security-config`) return securityConfig();
        return Response.json({
          uploadUrl: mutateUrl(upload.uploadUrl),
          uploadHeaders,
          uploadUrlExpiresAt: upload.uploadUrlExpiresAt,
          completeToken,
          objectId,
          expiresAt,
          cleanupToken,
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

  it.each([
    [
      'an unknown header',
      (headers: Record<string, string>) => ({ ...headers, 'x-unknown-upload-header': '1' }),
    ],
    [
      'an oversized header',
      (headers: Record<string, string>) => ({
        ...headers,
        'x-amz-meta-name': 'x'.repeat(2049),
      }),
    ],
  ])('rejects %s before sending local bytes', async (_label, mutateHeaders) => {
    const expiresAt = Date.now() + 86_400_000;
    const cleanupToken = `${'c'.repeat(40)}.${'t'.repeat(43)}`;
    const uploadHeaders = mutateHeaders(canonicalUploadHeaders(expiresAt, cleanupToken));
    const upload = presignedUpload(uploadHeaders);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === `${endpoint}/security-config`) return securityConfig();
        return Response.json({
          uploadUrl: upload.uploadUrl,
          uploadHeaders,
          uploadUrlExpiresAt: upload.uploadUrlExpiresAt,
          completeToken,
          objectId,
          expiresAt,
          cleanupToken,
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

  it('defaults localhost to the canonical account host shared with PRO', async () => {
    Reflect.deleteProperty(window, '__MUSIXQUARE_REMOTE_SHARE_UPLOAD_HOST__');
    const { proRoomR2HostForTests: PRO_ROOM_R2_HOST } = await import('../../pro-room/api.ts');
    expect(PRO_ROOM_R2_HOST).toBe('01353882e4eea3a5acaa0c45e8336af4.r2.cloudflarestorage.com');
    const expiresAt = Date.now() + 86_400_000;
    const cleanupToken = `${'c'.repeat(40)}.${'t'.repeat(43)}`;
    const uploadHeaders = canonicalUploadHeaders(expiresAt, cleanupToken);
    const upload = presignedUpload(uploadHeaders, { host: PRO_ROOM_R2_HOST });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${endpoint}/security-config`) return securityConfig();
        if (url === `${endpoint}/session`) {
          return Response.json({
            uploadUrl: upload.uploadUrl,
            uploadHeaders,
            uploadUrlExpiresAt: upload.uploadUrlExpiresAt,
            completeToken,
            objectId,
            expiresAt,
            cleanupToken,
          });
        }
        if (url.includes(`/object/${roomId}/${objectId}`))
          return new Response(null, { status: 204 });
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );
    const { uploadWholeObject } = await import('../r2-client.ts');
    const pending = uploadWholeObject(new Blob(['data']), {
      roomId,
      name: 'song.mp3',
      mime: 'audio/mpeg',
      size: 4,
      sessionId: 7,
      queueItemId,
    });
    await vi.waitFor(() => expect(FakeXmlHttpRequest.instances).toHaveLength(1));
    const xhr = FakeXmlHttpRequest.instances[0]!;
    expect(new URL(xhr.url).hostname).toBe(PRO_ROOM_R2_HOST);
    xhr.status = 500;
    xhr.onload?.call(xhr as unknown as XMLHttpRequest, new ProgressEvent('load'));
    await expect(pending).rejects.toThrow('REMOTE_SHARE_DIRECT_UPLOAD_HTTP_500');
  });

  it('ignores the mutable development host seam on production app hosts', async () => {
    vi.stubGlobal('location', {
      hostname: 'musixquare.com',
      origin: 'https://musixquare.com',
    });
    Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_UPLOAD_HOST__', {
      configurable: true,
      value: 'evil.example',
    });
    const expiresAt = Date.now() + 86_400_000;
    const cleanupToken = `${'c'.repeat(40)}.${'t'.repeat(43)}`;
    const uploadHeaders = canonicalUploadHeaders(expiresAt, cleanupToken);
    const upload = presignedUpload(uploadHeaders, { host: 'evil.example' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === `${productionEndpoint}/security-config`) return securityConfig();
        return Response.json({
          uploadUrl: upload.uploadUrl,
          uploadHeaders,
          uploadUrlExpiresAt: upload.uploadUrlExpiresAt,
          completeToken,
          objectId,
          expiresAt,
          cleanupToken,
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
