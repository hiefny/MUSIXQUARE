/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChunkEncryptionPlan } from '../crypto.ts';

const originalXhr = globalThis.XMLHttpRequest;
const OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONTENT_MD5 = 'AAAAAAAAAAAAAAAAAAAAAA==';

class FakeUploadRequest {
  static instances: FakeUploadRequest[] = [];
  static outcome: 'load' | 'error' | 'timeout' = 'load';
  static status = 200;
  static etag = '0123456789abcdef0123456789abcdef';

  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  readonly headers = new Map<string, string>();
  method = '';
  url = '';
  status = FakeUploadRequest.status;
  timeout = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  sentBody: XMLHttpRequestBodyInit | null = null;

  constructor() {
    FakeUploadRequest.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'etag' ? `"${FakeUploadRequest.etag}"` : null;
  }

  send(body?: XMLHttpRequestBodyInit | null): void {
    this.sentBody = body ?? null;
    queueMicrotask(() => {
      if (FakeUploadRequest.outcome === 'error') return this.onerror?.();
      if (FakeUploadRequest.outcome === 'timeout') return this.ontimeout?.();
      this.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 4 } as ProgressEvent);
      this.onload?.();
    });
  }

  abort(): void {
    // Test double.
  }
}

class FakeDownloadRequest {
  static readonly HEADERS_RECEIVED = 2;
  static contentLength: string | null = '4';
  static response = new Uint8Array([1, 2, 3, 4]).buffer;

  readonly upload = { onprogress: null };
  method = '';
  url = '';
  status = 200;
  responseType = '';
  response = FakeDownloadRequest.response;
  readyState = 0;
  timeout = 0;
  aborted = false;
  onreadystatechange: (() => void) | null = null;
  onprogress: ((event: ProgressEvent) => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'content-length' ? FakeDownloadRequest.contentLength : null;
  }

  send(): void {
    queueMicrotask(() => {
      this.readyState = XMLHttpRequest.HEADERS_RECEIVED;
      this.onreadystatechange?.();
      if (this.aborted) return;
      this.onprogress?.({ lengthComputable: true, loaded: 4, total: 4 } as ProgressEvent);
      if (this.aborted) return;
      this.response = FakeDownloadRequest.response;
      this.onload?.();
    });
  }

  abort(): void {
    this.aborted = true;
  }
}

const plan: ChunkEncryptionPlan = {
  keyB64: 'a'.repeat(44),
  ivB64: 'b'.repeat(12),
  cryptoVersion: 2,
  plainSize: 8,
  encryptedSize: 24,
  chunkSize: 8 * 1024 * 1024,
  chunkCount: 1,
  tagBytes: 16,
};

const meta = {
  roomId: '123456',
  name: 'track.wav',
  mime: 'audio/wav',
  size: 8,
  sessionId: 7,
  index: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  FakeUploadRequest.instances = [];
  FakeUploadRequest.outcome = 'load';
  FakeUploadRequest.status = 200;
  FakeUploadRequest.etag = '0123456789abcdef0123456789abcdef';
  FakeDownloadRequest.contentLength = '4';
  FakeDownloadRequest.response = new Uint8Array([1, 2, 3, 4]).buffer;
  delete window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__;
  localStorage.clear();
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    value: originalXhr,
  });
});

describe('R2 multipart remote-share client', () => {
  it('exports exact five-GiB plaintext and authenticated ciphertext limits', async () => {
    const { REMOTE_SHARE_MAX_ENCRYPTED_BYTES, REMOTE_SHARE_MAX_PLAINTEXT_BYTES } =
      await import('../r2-client.ts');
    expect(REMOTE_SHARE_MAX_PLAINTEXT_BYTES).toBe(5_368_709_120);
    expect(REMOTE_SHARE_MAX_ENCRYPTED_BYTES).toBe(5_368_719_360);
  });

  it('requests a v4 session with the complete fixed crypto plan', async () => {
    window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__ = 'https://share.example.test';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/security-config')) return json({ capabilityRequired: false });
      expect(url).toBe('https://share.example.test/session');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        protocolVersion: 4,
        encryptedSize: 24,
        chunkSize: 8 * 1024 * 1024,
        chunkCount: 1,
        tagBytes: 16,
      });
      return json({
        protocolVersion: 4,
        objectId: OBJECT_ID,
        controlToken: 'x'.repeat(64),
        expiresAt: Date.now() + 60_000,
        downloadUrl: `https://share.example.test/download/123456/${OBJECT_ID}`,
      });
    });
    const { requestMultipartUploadSession } = await import('../r2-client.ts');
    const session = await requestMultipartUploadSession(meta, plan);
    expect(session.objectId).toBe(OBJECT_ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('obtains exact part targets and uploads ciphertext directly to R2', async () => {
    window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__ = 'https://share.example.test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        parts: [
          {
            partNumber: 1,
            uploadUrl:
              'https://account.r2.cloudflarestorage.com/bucket/key?partNumber=1&uploadId=signed',
            uploadHeaders: {
              'content-type': 'application/octet-stream',
              'content-md5': CONTENT_MD5,
            },
          },
        ],
      }),
    );
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      value: FakeUploadRequest as unknown as typeof XMLHttpRequest,
    });
    const { requestMultipartPartUrls, uploadMultipartPart } = await import('../r2-client.ts');
    const session = {
      protocolVersion: 4 as const,
      endpoint: 'https://share.example.test',
      objectId: OBJECT_ID,
      controlToken: 'x'.repeat(64),
      downloadUrl: `https://share.example.test/download/123456/${OBJECT_ID}`,
      expiresAt: Date.now() + 60_000,
    };
    const [target] = await requestMultipartPartUrls(session, [
      { partNumber: 1, contentMd5: CONTENT_MD5 },
    ]);
    expect(target).toBeDefined();
    const progress = vi.fn();
    const uploaded = await uploadMultipartPart(
      target!,
      new Uint8Array([1, 2, 3, 4]).buffer,
      progress,
    );
    expect(uploaded).toEqual({ partNumber: 1, etag: FakeUploadRequest.etag });
    expect(FakeUploadRequest.instances[0]?.method).toBe('PUT');
    expect(FakeUploadRequest.instances[0]?.url).toContain('.r2.cloudflarestorage.com');
    expect(FakeUploadRequest.instances[0]?.headers.get('content-md5')).toBe(CONTENT_MD5);
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('rejects a multipart response that points outside R2', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        parts: [{ partNumber: 1, uploadUrl: 'https://evil.example/put', uploadHeaders: {} }],
      }),
    );
    const { requestMultipartPartUrls } = await import('../r2-client.ts');
    await expect(
      requestMultipartPartUrls(
        {
          protocolVersion: 4,
          endpoint: 'https://share.example.test',
          objectId: OBJECT_ID,
          controlToken: 'x'.repeat(64),
          downloadUrl: `https://share.example.test/download/123456/${OBJECT_ID}`,
          expiresAt: Date.now() + 60_000,
        },
        [{ partNumber: 1, contentMd5: CONTENT_MD5 }],
      ),
    ).rejects.toThrow('REMOTE_SHARE_BAD_PART_URL_RESPONSE');
  });

  it('rejects non-canonical digests and digest-mismatched targets', async () => {
    const { requestMultipartPartUrls } = await import('../r2-client.ts');
    const session = {
      protocolVersion: 4 as const,
      endpoint: 'https://share.example.test',
      objectId: OBJECT_ID,
      controlToken: 'x'.repeat(64),
      downloadUrl: `https://share.example.test/download/123456/${OBJECT_ID}`,
      expiresAt: Date.now() + 60_000,
    };
    await expect(
      requestMultipartPartUrls(session, [{ partNumber: 1, contentMd5: 'not-base64' }]),
    ).rejects.toThrow('REMOTE_SHARE_PART_REQUEST_INVALID');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        parts: [
          {
            partNumber: 1,
            uploadUrl:
              'https://account.r2.cloudflarestorage.com/bucket/key?partNumber=1&uploadId=signed',
            uploadHeaders: { 'content-md5': 'AQEBAQEBAQEBAQEBAQEBAQ==' },
          },
        ],
      }),
    );
    await expect(
      requestMultipartPartUrls(session, [{ partNumber: 1, contentMd5: CONTENT_MD5 }]),
    ).rejects.toThrow('REMOTE_SHARE_BAD_PART_URL_RESPONSE');
  });

  it('completes and aborts through the control Worker without sending file bytes', async () => {
    window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__ = 'https://share.example.test';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/complete')) {
        return json({
          objectId: OBJECT_ID,
          expiresAt: Date.now() + 60_000,
          downloadUrl: `https://share.example.test/download/123456/${OBJECT_ID}`,
        });
      }
      return json({ ok: true });
    });
    const { abortMultipartUpload, completeMultipartUpload } = await import('../r2-client.ts');
    const session = {
      protocolVersion: 4 as const,
      endpoint: 'https://share.example.test',
      objectId: OBJECT_ID,
      controlToken: 'x'.repeat(64),
      downloadUrl: `https://share.example.test/download/123456/${OBJECT_ID}`,
      expiresAt: Date.now() + 60_000,
    };
    await completeMultipartUpload(session, '123456', [
      { partNumber: 1, etag: '0123456789abcdef0123456789abcdef' },
    ]);
    await abortMultipartUpload(session, '123456');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://share.example.test/complete',
      'https://share.example.test/abort',
    ]);
  });
});

describe('R2 remote download validation', () => {
  it('rejects descriptor download URLs for another object', async () => {
    window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__ = 'https://share.example.test';
    const { downloadEncryptedObject } = await import('../r2-client.ts');
    await expect(
      downloadEncryptedObject(
        '123456',
        OBJECT_ID,
        'https://share.example.test/download/123456/22222222-2222-4222-8222-222222222222',
        undefined,
        undefined,
        4,
      ),
    ).rejects.toThrow('REMOTE_SHARE_BAD_DOWNLOAD_URL');
  });

  it('enforces exact Content-Length before resolving a legacy buffer', async () => {
    window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__ = 'https://share.example.test';
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      value: FakeDownloadRequest as unknown as typeof XMLHttpRequest,
    });
    const { downloadEncryptedObject } = await import('../r2-client.ts');
    await expect(
      downloadEncryptedObject('123456', OBJECT_ID, undefined, undefined, undefined, 4),
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]).buffer);

    FakeDownloadRequest.contentLength = '5';
    await expect(
      downloadEncryptedObject('123456', OBJECT_ID, undefined, undefined, undefined, 4),
    ).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
  });

  it('returns a validated bounded response stream', async () => {
    window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__ = 'https://share.example.test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { 'content-length': '4' },
      }),
    );
    const { downloadEncryptedObjectStream } = await import('../r2-client.ts');
    const stream = await downloadEncryptedObjectStream('123456', OBJECT_ID, undefined, 4);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(Array.from(first.value ?? [])).toEqual([1, 2, 3, 4]);
  });
});
