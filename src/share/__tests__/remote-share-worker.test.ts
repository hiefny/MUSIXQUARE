import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

type RemoteShareWorker = {
  RemoteShareRateLimiter: new (state: { storage: FakeDurableObjectStorage }) => {
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
  };
  default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
};

const workerModule =
  (await import('../../../cloudflare/remote-share-worker.js')) as RemoteShareWorker;
const ORIGIN = 'https://musixquare.com';
const SIGNING_SECRET = 'remote-share-signing-secret-for-tests';
const CAPABILITY_SECRET = 'remote-share-capability-secret-for-tests';
const CLIENT_IP = '203.0.113.7';
const fixedLengthReadableBodies = new WeakSet<ReadableStream<Uint8Array>>();

class FakeFixedLengthStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(expectedBytes: number) {
    let receivedBytes = 0;
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > expectedBytes) {
          controller.error(new TypeError('FixedLengthStream received too many bytes'));
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (receivedBytes !== expectedBytes) {
          controller.error(new TypeError('FixedLengthStream received too few bytes'));
        }
      },
    });
    this.readable = stream.readable;
    this.writable = stream.writable;
    fixedLengthReadableBodies.add(this.readable);
  }
}

class FailingFixedLengthStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(_expectedBytes: number) {
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(_chunk, controller) {
        controller.error(new TypeError('simulated fixed-length pipe failure'));
      },
    });
    this.readable = stream.readable;
    this.writable = stream.writable;
    fixedLengthReadableBodies.add(this.readable);
  }
}

class FakeDurableObjectStorage {
  readonly values = new Map<string, unknown>();
  private transactionTail: Promise<void> = Promise.resolve();
  private alarmAt: number | null = null;

  async transaction<T>(callback: (transaction: this) => Promise<T>): Promise<T> {
    const prior = this.transactionTail;
    let release = (): void => undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await callback(this);
    } finally {
      release();
    }
  }

  async get(key: string): Promise<unknown> {
    return this.values.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async list(options: { prefix: string }): Promise<Map<string, unknown>> {
    return new Map([...this.values].filter(([key]) => key.startsWith(options.prefix)));
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

class FakeDurableObjectNamespace {
  readonly objects = new Map<string, InstanceType<RemoteShareWorker['RemoteShareRateLimiter']>>();

  idFromName(name: string): string {
    return name;
  }

  get(id: string): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } {
    let object = this.objects.get(id);
    if (!object) {
      object = new workerModule.RemoteShareRateLimiter({
        storage: new FakeDurableObjectStorage(),
      });
      this.objects.set(id, object);
    }
    return {
      fetch: (input, init) => object.fetch(new Request(input, init)),
    };
  }
}

class FakeR2Bucket {
  readonly objects = new Map<
    string,
    {
      bytes: Uint8Array;
      customMetadata: Record<string, string>;
      etag: string;
      httpEtag: string;
    }
  >();
  readonly multipartUploads = new Map<
    string,
    {
      key: string;
      options: {
        httpMetadata?: Record<string, string>;
        customMetadata?: Record<string, string>;
      };
      parts: Map<number, { bytes: Uint8Array; etag: string }>;
    }
  >();
  requireFixedLengthBody = false;
  objectPutError: Error | null = null;
  completeCommitsThenThrowsOnce = false;
  multipartCompleteCalls = 0;
  multipartAbortCalls = 0;
  private nextEtag = 1;
  private nextUploadId = 1;
  private nextPartEtag = 1;
  readonly put = vi.fn(
    async (
      key: string,
      body: ReadableStream<Uint8Array> | null,
      options: {
        onlyIf?: Headers;
        customMetadata?: Record<string, string>;
      },
    ): Promise<{
      size: number;
      etag: string;
      httpEtag: string;
      customMetadata: Record<string, string>;
    } | null> => {
      if (options.onlyIf?.get('if-none-match') === '*' && this.objects.has(key)) return null;
      const ifMatch = options.onlyIf?.get('if-match');
      if (ifMatch && this.objects.get(key)?.httpEtag !== ifMatch) return null;
      if (key.startsWith('room/') && this.objectPutError) throw this.objectPutError;
      if (
        key.startsWith('room/') &&
        this.requireFixedLengthBody &&
        body !== null &&
        !fixedLengthReadableBodies.has(body)
      ) {
        throw new TypeError(
          'Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)',
        );
      }
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const etag = `fake-etag-${this.nextEtag++}`;
      const stored = {
        bytes,
        customMetadata: options.customMetadata ?? {},
        etag,
        httpEtag: `"${etag}"`,
      };
      this.objects.set(key, stored);
      return { size: bytes.byteLength, ...stored };
    },
  );

  async head(key: string): Promise<{
    size: number;
    customMetadata: Record<string, string>;
    etag: string;
    httpEtag: string;
  } | null> {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.byteLength, ...object } : null;
  }

  async get(key: string): Promise<{
    size: number;
    customMetadata: Record<string, string>;
    etag: string;
    httpEtag: string;
    body: ReadableStream<Uint8Array>;
  } | null>;
  async get(
    key: string,
    options?: { onlyIf?: Headers; range?: { offset: number; length: number } },
  ): Promise<{
    size: number;
    customMetadata: Record<string, string>;
    etag: string;
    httpEtag: string;
    body: ReadableStream<Uint8Array>;
  } | null>;
  async get(
    key: string,
    options: { onlyIf?: Headers; range?: { offset: number; length: number } } = {},
  ): Promise<{
    size: number;
    customMetadata: Record<string, string>;
    etag: string;
    httpEtag: string;
    body: ReadableStream<Uint8Array>;
  } | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const ifMatch = options.onlyIf?.get('if-match');
    if (ifMatch && object.httpEtag !== ifMatch) return null;
    const bytes = options.range
      ? object.bytes.slice(options.range.offset, options.range.offset + options.range.length)
      : object.bytes.slice();
    return {
      size: object.bytes.byteLength,
      ...object,
      body: new Blob([bytes.buffer as ArrayBuffer]).stream(),
    };
  }

  readonly createMultipartUpload = vi.fn(
    async (
      key: string,
      options: {
        httpMetadata?: Record<string, string>;
        customMetadata?: Record<string, string>;
      },
    ): Promise<{ key: string; uploadId: string; abort(): Promise<void> }> => {
      const uploadId = `fake-upload-${this.nextUploadId++}`;
      this.multipartUploads.set(uploadId, { key, options, parts: new Map() });
      return {
        key,
        uploadId,
        abort: async () => {
          this.multipartAbortCalls += 1;
          this.multipartUploads.delete(uploadId);
        },
      };
    },
  );

  async uploadMultipartPart(
    key: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<string> {
    const upload = this.multipartUploads.get(uploadId);
    if (!upload || upload.key !== key) throw new Error('NoSuchUpload');
    const etag = (this.nextPartEtag++).toString(16).padStart(32, '0');
    upload.parts.set(partNumber, { bytes: bytes.slice(), etag });
    return etag;
  }

  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): {
    complete(parts: Array<{ partNumber: number; etag: string }>): Promise<void>;
    abort(): Promise<void>;
  } {
    return {
      complete: async (parts) => {
        this.multipartCompleteCalls += 1;
        const upload = this.multipartUploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error('NoSuchUpload');
        if (parts.length !== upload.parts.size) throw new Error('InvalidPart');
        let totalBytes = 0;
        const ordered = [];
        for (const part of parts) {
          const stored = upload.parts.get(part.partNumber);
          if (!stored || stored.etag !== part.etag) throw new Error('InvalidPart');
          ordered.push(stored.bytes);
          totalBytes += stored.bytes.byteLength;
        }
        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const part of ordered) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        const etag = `fake-multipart-${this.nextEtag++}`;
        this.objects.set(key, {
          bytes,
          customMetadata: upload.options.customMetadata ?? {},
          etag,
          httpEtag: `"${etag}"`,
        });
        this.multipartUploads.delete(uploadId);
        if (this.completeCommitsThenThrowsOnce) {
          this.completeCommitsThenThrowsOnce = false;
          throw new Error('simulated lost completion response');
        }
      },
      abort: async () => {
        this.multipartAbortCalls += 1;
        const upload = this.multipartUploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error('NoSuchUpload');
        this.multipartUploads.delete(uploadId);
      },
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

interface UploadSession {
  protocolVersion: number;
  uploadMethod: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  uploadUrlExpiresAt: number;
  objectId: string;
  expiresAt: number;
  downloadUrl: string;
  cleanupToken: string;
  completeToken: string;
}

interface MultipartSession {
  protocolVersion: 4;
  objectId: string;
  controlToken: string;
  expiresAt: number;
  partUrlExpiresAt: number;
  downloadUrl: string;
  cleanupToken: string;
}

interface MultipartPartTarget {
  partNumber: number;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
}

interface MultipartPartRequest {
  partNumber: number;
  contentMd5: string;
}

const MIB = 1024 * 1024;
const MULTIPART_CHUNK_BYTES = 8 * MIB;
const MULTIPART_TAG_BYTES = 16;

function contentMd5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('base64');
}

function multipartPartRequest(partNumber: number, bytes: Uint8Array): MultipartPartRequest {
  return { partNumber, contentMd5: contentMd5(bytes) };
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacBytes(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const keyData = new Uint8Array(new ArrayBuffer(keyBytes.byteLength));
  keyData.set(keyBytes);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

async function sha256Hex(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  );
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function verifyPresignedMultipartTarget(
  target: MultipartPartTarget,
  bodyBytes: number,
): Promise<boolean> {
  const url = new URL(target.uploadUrl);
  const signature = url.searchParams.get('X-Amz-Signature') || '';
  const credential = url.searchParams.get('X-Amz-Credential') || '';
  const amzDate = url.searchParams.get('X-Amz-Date') || '';
  const signedHeaderNames = (url.searchParams.get('X-Amz-SignedHeaders') || '')
    .split(';')
    .filter(Boolean);
  const scope = credential.split('/').slice(1).join('/');
  if (!signature || !scope || !amzDate) return false;
  const effectiveHeaders: Record<string, string> = {
    host: url.host,
    'content-length': String(bodyBytes),
    'content-md5': target.uploadHeaders['content-md5'] || '',
    'content-type': target.uploadHeaders['content-type'] || '',
  };
  if (signedHeaderNames.some((name) => effectiveHeaders[name] === undefined)) return false;
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${effectiveHeaders[name].trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const queryEntries = [...url.searchParams.entries()]
    .filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([keyA, valueA], [keyB, valueB]) => {
      if (keyA < keyB) return -1;
      if (keyA > keyB) return 1;
      if (valueA < valueB) return -1;
      if (valueA > valueB) return 1;
      return 0;
    });
  const canonicalQuery = queryEntries.map(([key, value]) => `${key}=${value}`).join('&');
  const canonicalRequest = [
    'PUT',
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join(
    '\n',
  );
  const [dateStamp] = scope.split('/');
  const dateKey = await hmacBytes(
    new TextEncoder().encode(`AWS4${'test-secret-access-key'}`),
    dateStamp,
  );
  const regionKey = await hmacBytes(dateKey, 'auto');
  const serviceKey = await hmacBytes(regionKey, 's3');
  const signingKey = await hmacBytes(serviceKey, 'aws4_request');
  return signature === hex(await hmacBytes(signingKey, stringToSign));
}

async function createCapabilityToken(scopes = ['remote-share']): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    scopes,
    iat: now,
    exp: now + 600,
    ip: await hmacSha256(CAPABILITY_SECRET, `ip:${CLIENT_IP}`),
    method: 'test',
  };
  const payloadPart = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSha256(CAPABILITY_SECRET, payloadPart);
  return `${payloadPart}.${signature}`;
}

function env(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    REMOTE_SHARE_SIGNING_SECRET: SIGNING_SECRET,
    ...extra,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('origin', ORIGIN);
  return new Request(`https://share.musixquare.com${path}`, {
    ...init,
    headers,
  });
}

function uploadEnvironment(extra: Record<string, unknown> = {}): {
  bucket: FakeR2Bucket;
  rateLimiter: FakeDurableObjectNamespace;
  workerEnv: Record<string, unknown>;
} {
  const bucket = new FakeR2Bucket();
  const rateLimiter = new FakeDurableObjectNamespace();
  return {
    bucket,
    rateLimiter,
    workerEnv: env({
      MXQR_ALLOW_UNGUARDED_REMOTE_SHARE: 'true',
      REMOTE_SHARE_BUCKET: bucket,
      REMOTE_SHARE_RATE_LIMITER: rateLimiter,
      R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      R2_ACCESS_KEY_ID: 'test-access-key',
      R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
      R2_BUCKET_NAME: 'musixquare-remote-share',
      ...extra,
    }),
  };
}

async function createUploadSession(
  workerEnv: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Promise<{ response: Response; session: UploadSession | null }> {
  const response = await workerModule.default.fetch(
    request('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': CLIENT_IP },
      body: JSON.stringify({
        protocolVersion: 2,
        roomId: '123456',
        sessionId: 7,
        index: 0,
        name: 'track.mp3',
        mime: 'audio/mpeg',
        size: 4,
        encryptedSize: 4,
        ...overrides,
      }),
    }),
    workerEnv,
  );
  return {
    response,
    session: response.ok ? ((await response.json()) as UploadSession) : null,
  };
}

function uploadRequest(
  session: UploadSession,
  bytes: Uint8Array,
  extraHeaders: Record<string, string> = {},
  method = 'POST',
): Request {
  const body = bytes.slice().buffer as ArrayBuffer;
  return request(new URL(session.uploadUrl).pathname + new URL(session.uploadUrl).search, {
    method,
    headers: { ...session.uploadHeaders, ...extraHeaders, 'cf-connecting-ip': CLIENT_IP },
    body: new Blob([body], { type: 'application/octet-stream' }),
  });
}

async function directR2Put(
  bucket: FakeR2Bucket,
  session: UploadSession,
  bytes: Uint8Array,
  headerOverrides: Record<string, string> = {},
): Promise<Response> {
  const headers = new Headers({ ...session.uploadHeaders, ...headerOverrides });
  const expectedBytes = Number(headers.get('x-amz-meta-encrypted-size'));
  if (bytes.byteLength !== expectedBytes) {
    return new Response('SignatureDoesNotMatch', { status: 403 });
  }
  const url = new URL(session.uploadUrl);
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const key = segments.slice(1).join('/');
  const customMetadata: Record<string, string> = {};
  for (const [header, value] of headers) {
    if (header.startsWith('x-amz-meta-')) customMetadata[header.slice(11)] = value;
  }
  const stored = await bucket.put(key, new Blob([bytes.slice().buffer as ArrayBuffer]).stream(), {
    onlyIf: new Headers({ 'if-match': headers.get('if-match') || '' }),
    customMetadata,
  });
  return stored
    ? new Response(null, { status: 200, headers: { etag: stored.httpEtag } })
    : new Response('PreconditionFailed', { status: 412 });
}

function completeRequest(session: UploadSession): Request {
  return request('/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomId: '123456',
      objectId: session.objectId,
      completeToken: session.completeToken,
    }),
  });
}

async function createMultipartSession(
  workerEnv: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Promise<{ response: Response; session: MultipartSession | null }> {
  const size = Number(overrides.size ?? MULTIPART_CHUNK_BYTES + 3);
  const chunkCount = Number(overrides.chunkCount ?? Math.ceil(size / MULTIPART_CHUNK_BYTES));
  const encryptedSize = Number(overrides.encryptedSize ?? size + chunkCount * MULTIPART_TAG_BYTES);
  const response = await workerModule.default.fetch(
    request('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': CLIENT_IP },
      body: JSON.stringify({
        protocolVersion: 4,
        roomId: '123456',
        sessionId: 7,
        index: 0,
        name: 'long-track.wav',
        mime: 'audio/wav',
        size,
        encryptedSize,
        chunkSize: MULTIPART_CHUNK_BYTES,
        chunkCount,
        tagBytes: MULTIPART_TAG_BYTES,
        ...overrides,
      }),
    }),
    workerEnv,
  );
  return {
    response,
    session: response.ok ? ((await response.json()) as MultipartSession) : null,
  };
}

async function requestMultipartParts(
  workerEnv: Record<string, unknown>,
  session: MultipartSession,
  parts: MultipartPartRequest[],
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return workerModule.default.fetch(
    request('/parts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objectId: session.objectId,
        controlToken: session.controlToken,
        parts,
        ...overrides,
      }),
    }),
    workerEnv,
  );
}

async function directMultipartPartPut(
  bucket: FakeR2Bucket,
  target: MultipartPartTarget,
  bytes: Uint8Array,
): Promise<Response> {
  const url = new URL(target.uploadUrl);
  const signedHeaders = new Set(
    (url.searchParams.get('X-Amz-SignedHeaders') || '').split(';').filter(Boolean),
  );
  if (
    !signedHeaders.has('content-length') ||
    !signedHeaders.has('content-md5') ||
    !signedHeaders.has('content-type') ||
    !signedHeaders.has('host') ||
    !target.uploadHeaders['content-md5'] ||
    target.uploadHeaders['content-type'] !== 'application/octet-stream' ||
    !(await verifyPresignedMultipartTarget(target, bytes.byteLength))
  ) {
    return new Response('SignatureDoesNotMatch', { status: 403 });
  }
  if (contentMd5(bytes) !== target.uploadHeaders['content-md5']) {
    return new Response('BadDigest', { status: 400 });
  }
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const key = segments.slice(1).join('/');
  const uploadId = url.searchParams.get('uploadId') || '';
  const partNumber = Number(url.searchParams.get('partNumber'));
  try {
    const etag = await bucket.uploadMultipartPart(key, uploadId, partNumber, bytes);
    return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
  } catch {
    return new Response('NoSuchUpload', { status: 404 });
  }
}

function multipartCompleteRequest(
  session: MultipartSession,
  parts: Array<{ partNumber: number; etag: string }>,
): Request {
  return request('/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomId: '123456',
      objectId: session.objectId,
      controlToken: session.controlToken,
      parts,
    }),
  });
}

function multipartAbortRequest(session: MultipartSession): Request {
  return request('/abort', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomId: '123456',
      objectId: session.objectId,
      controlToken: session.controlToken,
    }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('remote-share Worker capability gate', () => {
  it('reports whether session capability is required', async () => {
    const response = await workerModule.default.fetch(
      request('/security-config'),
      env({ MXQR_CAPABILITY_SECRET: CAPABILITY_SECRET }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      capabilityRequired: true,
      scope: 'remote-share',
    });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('fails closed when capability secret is missing in production', async () => {
    // Parity with app-worker.guardSensitiveRequest: a missing capability
    // secret blocks /session with 503 unless MXQR_ALLOW_UNGUARDED_REMOTE_SHARE
    // is explicitly set. (14차 audit F-1402.)
    const response = await workerModule.default.fetch(
      request('/session', { method: 'POST', body: 'not-json' }),
      env(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'CAPABILITY_NOT_CONFIGURED' });
  });

  it('allows /session without capability when MXQR_ALLOW_UNGUARDED_REMOTE_SHARE is set', async () => {
    const response = await workerModule.default.fetch(
      request('/session', { method: 'POST', body: 'not-json' }),
      env({ MXQR_ALLOW_UNGUARDED_REMOTE_SHARE: 'true' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid json' });
  });

  it('requires a valid remote-share capability token when configured', async () => {
    const response = await workerModule.default.fetch(
      request('/session', { method: 'POST', body: 'not-json' }),
      env({ MXQR_CAPABILITY_SECRET: CAPABILITY_SECRET }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'CAPABILITY_REQUIRED' });
  });

  it('accepts an app-issued remote-share capability token for session requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00.000Z'));
    const token = await createCapabilityToken();
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        body: 'not-json',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'x-mxqr-capability': token,
        },
      }),
      env({ MXQR_CAPABILITY_SECRET: CAPABILITY_SECRET }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid json' });
  });
});

describe('remote-share Worker protocol v3 direct R2 upload', () => {
  it('maps the unversioned 200 MiB production client to rolling direct R2', async () => {
    const { workerEnv } = uploadEnvironment();
    const plaintextBytes = 200 * 1024 * 1024;
    const { response, session } = await createUploadSession(workerEnv, {
      protocolVersion: undefined,
      size: plaintextBytes,
      encryptedSize: plaintextBytes + 16,
    });

    expect(response.status).toBe(200);
    expect(session).toMatchObject({ protocolVersion: 3, uploadMethod: 'PUT' });
    expect(session?.uploadUrl).toContain('.r2.cloudflarestorage.com/');
  });

  it('accepts uploads above 64 MiB and signs the exact size, CAS, and metadata headers', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    const plaintextBytes = 200 * 1024 * 1024;
    const encryptedBytes = plaintextBytes + 16;
    const { response, session } = await createUploadSession(workerEnv, {
      protocolVersion: 3,
      size: plaintextBytes,
      encryptedSize: encryptedBytes,
    });

    expect(response.status).toBe(200);
    expect(session).toMatchObject({ protocolVersion: 3, uploadMethod: 'PUT' });
    expect(session?.uploadUrl).toMatch(
      /^https:\/\/0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com\//,
    );
    if (!session) throw new Error('missing direct upload session');
    const signedHeaders = new URL(session.uploadUrl).searchParams
      .get('X-Amz-SignedHeaders')
      ?.split(';');
    expect(signedHeaders).toEqual([
      'cache-control',
      'content-length',
      'content-type',
      'host',
      'if-match',
      'x-amz-meta-cleanup-token',
      'x-amz-meta-encrypted-size',
      'x-amz-meta-expires-at',
      'x-amz-meta-mime',
      'x-amz-meta-name',
      'x-amz-meta-object-id',
      'x-amz-meta-room-id',
      'x-amz-meta-size-bytes',
      'x-amz-meta-upload-nonce',
      'x-amz-meta-upload-state',
    ]);
    expect(session.uploadHeaders).toMatchObject({
      'cache-control': 'no-store',
      'content-type': 'application/octet-stream',
      'if-match': expect.stringMatching(/^"fake-etag-\d+"$/),
      'x-amz-meta-cleanup-token': session.cleanupToken,
      'x-amz-meta-encrypted-size': String(encryptedBytes),
      'x-amz-meta-room-id': '123456',
      'x-amz-meta-size-bytes': String(plaintextBytes),
      'x-amz-meta-upload-state': 'uploaded',
    });
    expect(session.uploadHeaders).not.toHaveProperty('content-length');
    const reservation = [...bucket.objects.entries()].find(
      ([key]) => key.startsWith('room/') && !key.endsWith('.ready'),
    );
    expect(reservation?.[1].bytes).toHaveLength(0);
    expect(reservation?.[1].customMetadata).toMatchObject({
      uploadState: 'pending',
      encryptedSize: String(encryptedBytes),
      cleanupToken: session.cleanupToken,
    });
  });

  it('caps only at R2 safe single-PUT limits for protocol v3', async () => {
    const { workerEnv } = uploadEnvironment();
    const maxEncryptedBytes = 5 * 1024 * 1024 * 1024 - 5 * 1024 * 1024;
    const maxPlaintextBytes = maxEncryptedBytes - 16;
    const accepted = await createUploadSession(workerEnv, {
      protocolVersion: 3,
      size: maxPlaintextBytes,
      encryptedSize: maxEncryptedBytes,
    });
    expect(accepted.response.status).toBe(200);
    expect(new URL(accepted.session?.uploadUrl || '').searchParams.get('X-Amz-Expires')).toBe(
      '5235',
    );
    expect(Number(accepted.session?.expiresAt) - Number(accepted.session?.uploadUrlExpiresAt)).toBe(
      12 * 60 * 60 * 1000,
    );

    const rejected = await createUploadSession(workerEnv, {
      protocolVersion: 3,
      sessionId: 8,
      size: maxPlaintextBytes + 1,
      encryptedSize: maxEncryptedBytes,
    });
    expect(rejected.response.status).toBe(400);
  });

  it('keeps the placeholder private until exact completion', async () => {
    const { workerEnv } = uploadEnvironment();
    const { session } = await createUploadSession(workerEnv, { protocolVersion: 3 });
    if (!session) throw new Error('missing direct upload session');

    const download = await workerModule.default.fetch(
      request(`/download/123456/${session.objectId}`),
      workerEnv,
    );
    expect(download.status).toBe(404);

    const completion = await workerModule.default.fetch(completeRequest(session), workerEnv);
    expect(completion.status).toBe(409);
    expect(await completion.json()).toEqual({ error: 'upload not complete' });
  });

  it('publishes once, completes idempotently, downloads, deletes, and cannot re-arm the URL', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    const { session } = await createUploadSession(workerEnv, { protocolVersion: 3 });
    if (!session) throw new Error('missing direct upload session');
    const bytes = new Uint8Array([1, 2, 3, 4]);

    expect((await directR2Put(bucket, session, bytes)).status).toBe(200);
    expect((await directR2Put(bucket, session, new Uint8Array([9, 9, 9, 9]))).status).toBe(412);

    const completed = await workerModule.default.fetch(completeRequest(session), workerEnv);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ objectId: session.objectId });
    const repeatedCompletion = await workerModule.default.fetch(
      completeRequest(session),
      workerEnv,
    );
    expect(repeatedCompletion.status).toBe(200);

    const downloaded = await workerModule.default.fetch(
      request(`/download/123456/${session.objectId}`),
      workerEnv,
    );
    expect(downloaded.status).toBe(200);
    expect([...new Uint8Array(await downloaded.arrayBuffer())]).toEqual([...bytes]);

    const deniedDelete = await workerModule.default.fetch(
      request(`/object/123456/${session.objectId}`, { method: 'DELETE' }),
      workerEnv,
    );
    expect(deniedDelete.status).toBe(403);
    const deleted = await workerModule.default.fetch(
      request(`/object/123456/${session.objectId}`, {
        method: 'DELETE',
        headers: { 'x-mxqr-cleanup-token': session.cleanupToken },
      }),
      workerEnv,
    );
    expect(deleted.status).toBe(200);
    expect([...bucket.objects.keys()].filter((key) => key.includes(session.objectId))).toEqual([]);
    expect((await directR2Put(bucket, session, bytes)).status).toBe(412);
    expect(
      (
        await workerModule.default.fetch(
          request(`/object/123456/${session.objectId}`, { method: 'DELETE' }),
          workerEnv,
        )
      ).status,
    ).toBe(200);
  });

  it('rejects and removes a direct object whose signed metadata is not exact', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    const { session } = await createUploadSession(workerEnv, { protocolVersion: 3 });
    if (!session) throw new Error('missing direct upload session');

    expect(
      (
        await directR2Put(bucket, session, new Uint8Array([1, 2, 3, 4]), {
          'x-amz-meta-room-id': 'tampered-room',
        })
      ).status,
    ).toBe(200);
    const completion = await workerModule.default.fetch(completeRequest(session), workerEnv);
    expect(completion.status).toBe(403);
    expect(await completion.json()).toEqual({ error: 'invalid uploaded object' });
    expect([...bucket.objects.keys()].some((key) => key.includes(session.objectId))).toBe(false);
  });
});

describe('remote-share Worker protocol v4 direct R2 multipart upload', () => {
  it('creates an exact 8 MiB-record multipart plan and accepts 5 GiB plaintext', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00.000Z'));
    const { workerEnv, bucket } = uploadEnvironment();
    const size = 5 * 1024 * 1024 * 1024;
    const chunkCount = 640;
    const encryptedSize = size + chunkCount * MULTIPART_TAG_BYTES;
    const { response, session } = await createMultipartSession(workerEnv, {
      size,
      chunkCount,
      encryptedSize,
    });

    expect(response.status).toBe(200);
    expect(session).toMatchObject({
      protocolVersion: 4,
      objectId: expect.any(String),
      controlToken: expect.any(String),
      partUrlExpiresAt: expect.any(Number),
    });
    expect(session).not.toHaveProperty('uploadId');
    expect(bucket.createMultipartUpload).toHaveBeenCalledTimes(1);
    const upload = [...bucket.multipartUploads.values()][0];
    expect(upload.options.customMetadata).toMatchObject({
      uploadState: 'multipart',
      protocolVersion: '4',
      sizeBytes: String(size),
      encryptedSize: String(encryptedSize),
      chunkSize: String(MULTIPART_CHUNK_BYTES),
      chunkCount: '640',
      tagBytes: '16',
    });
    if (!session) throw new Error('missing multipart session');
    const lastPart = await requestMultipartParts(workerEnv, session, [
      multipartPartRequest(640, new Uint8Array(MULTIPART_CHUNK_BYTES + MULTIPART_TAG_BYTES)),
    ]);
    expect(lastPart.status).toBe(200);
    const lastPartBody = (await lastPart.json()) as {
      parts: MultipartPartTarget[];
      expiresAt: number;
    };
    const lastPartUrl = new URL(lastPartBody.parts[0].uploadUrl);
    expect(lastPartUrl.searchParams.get('partNumber')).toBe('640');
    expect(lastPartUrl.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(lastPartBody.expiresAt).toBe(Date.now() + 15 * 60 * 1000);
    expect(lastPartBody.expiresAt).toBeLessThan(session.partUrlExpiresAt);

    const overLimit = await createMultipartSession(workerEnv, {
      sessionId: 8,
      size: size + 1,
      chunkCount: 641,
      encryptedSize: size + 1 + 641 * MULTIPART_TAG_BYTES,
    });
    expect(overLimit.response.status).toBe(400);
  });

  it('rejects forged multipart crypto geometry before creating an R2 upload', async () => {
    const variants = [
      { chunkSize: MULTIPART_CHUNK_BYTES / 2 },
      { tagBytes: 15 },
      { chunkCount: 1 },
      { encryptedSize: MULTIPART_CHUNK_BYTES + 3 + MULTIPART_TAG_BYTES },
    ];
    for (const overrides of variants) {
      const { workerEnv, bucket } = uploadEnvironment();
      const result = await createMultipartSession(workerEnv, overrides);
      expect(result.response.status).toBe(400);
      expect(bucket.createMultipartUpload).not.toHaveBeenCalled();
    }
  });

  it('binds part MD5 and rejects request, body, query, header, size, and token tampering', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    const { session } = await createMultipartSession(workerEnv);
    if (!session) throw new Error('missing multipart session');
    const firstBytes = new Uint8Array(MULTIPART_CHUNK_BYTES + MULTIPART_TAG_BYTES);
    const finalBytes = new Uint8Array(3 + MULTIPART_TAG_BYTES);
    const partRequests = [multipartPartRequest(1, firstBytes), multipartPartRequest(2, finalBytes)];

    const partsResponse = await requestMultipartParts(workerEnv, session, partRequests);
    expect(partsResponse.status).toBe(200);
    const partBody = (await partsResponse.json()) as {
      parts: MultipartPartTarget[];
      expiresAt: number;
    };
    expect(partBody.parts).toHaveLength(2);
    expect(partBody.parts[0].uploadHeaders).toEqual({
      'content-md5': partRequests[0].contentMd5,
      'content-type': 'application/octet-stream',
    });
    for (const [index, target] of partBody.parts.entries()) {
      const url = new URL(target.uploadUrl);
      expect(url.searchParams.get('partNumber')).toBe(String(index + 1));
      expect(url.searchParams.get('uploadId')).toMatch(/^fake-upload-/);
      expect([...url.searchParams.keys()].filter((key) => key !== 'X-Amz-Signature')).toEqual([
        'X-Amz-Algorithm',
        'X-Amz-Content-Sha256',
        'X-Amz-Credential',
        'X-Amz-Date',
        'X-Amz-Expires',
        'X-Amz-SignedHeaders',
        'partNumber',
        'uploadId',
      ]);
      expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual([
        'content-length',
        'content-md5',
        'content-type',
        'host',
      ]);
    }

    expect(
      (
        await directMultipartPartPut(
          bucket,
          partBody.parts[0],
          new Uint8Array(MULTIPART_CHUNK_BYTES + MULTIPART_TAG_BYTES - 1),
        )
      ).status,
    ).toBe(403);
    const queryTampered = {
      ...partBody.parts[0],
      uploadUrl: partBody.parts[0].uploadUrl.replace('partNumber=1', 'partNumber=2'),
    };
    expect((await directMultipartPartPut(bucket, queryTampered, firstBytes)).status).toBe(403);
    const headerTampered = {
      ...partBody.parts[0],
      uploadHeaders: {
        ...partBody.parts[0].uploadHeaders,
        'content-type': 'text/plain',
      },
    };
    expect((await directMultipartPartPut(bucket, headerTampered, firstBytes)).status).toBe(403);

    const digestHeaderTampered = {
      ...partBody.parts[0],
      uploadHeaders: {
        ...partBody.parts[0].uploadHeaders,
        'content-md5': contentMd5(finalBytes),
      },
    };
    expect((await directMultipartPartPut(bucket, digestHeaderTampered, firstBytes)).status).toBe(
      403,
    );
    const alteredSameLength = firstBytes.slice();
    alteredSameLength[0] = 1;
    expect(
      (await directMultipartPartPut(bucket, partBody.parts[0], alteredSameLength)).status,
    ).toBe(400);
    expect((await directMultipartPartPut(bucket, partBody.parts[0], firstBytes)).status).toBe(200);
    // A same-body replay can repeat the request cost during the 15-minute bearer window,
    // but Content-MD5 ensures that it cannot replace the accepted ciphertext content.
    expect((await directMultipartPartPut(bucket, partBody.parts[0], firstBytes)).status).toBe(200);

    expect(
      (await requestMultipartParts(workerEnv, session, [partRequests[1], partRequests[0]])).status,
    ).toBe(400);
    expect(
      (await requestMultipartParts(workerEnv, session, [partRequests[0], partRequests[0]])).status,
    ).toBe(400);
    expect(
      (await requestMultipartParts(workerEnv, session, [{ ...partRequests[0], partNumber: 3 }]))
        .status,
    ).toBe(400);
    expect(
      (
        await requestMultipartParts(workerEnv, session, [
          { partNumber: 1, contentMd5: 'A'.repeat(21) + 'B==' },
        ])
      ).status,
    ).toBe(400);
    expect(
      (
        await requestMultipartParts(workerEnv, session, partRequests.slice(0, 1), {
          parts: [{ ...partRequests[0], unexpected: true }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await requestMultipartParts(workerEnv, session, partRequests.slice(0, 1), {
          parts: undefined,
          partNumbers: [1],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await requestMultipartParts(workerEnv, session, partRequests.slice(0, 1), {
          controlToken: `${session.controlToken.slice(0, -1)}x`,
        })
      ).status,
    ).toBe(403);
  });

  it('completes, publishes once, recovers exact ranges, and keeps completion idempotent', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    const { session } = await createMultipartSession(workerEnv);
    if (!session) throw new Error('missing multipart session');
    const firstBytes = new Uint8Array(MULTIPART_CHUNK_BYTES + MULTIPART_TAG_BYTES);
    firstBytes[0] = 11;
    firstBytes[firstBytes.length - 1] = 12;
    const finalBytes = new Uint8Array(3 + MULTIPART_TAG_BYTES);
    finalBytes[0] = 21;
    finalBytes[finalBytes.length - 1] = 22;
    const partsResponse = await requestMultipartParts(workerEnv, session, [
      multipartPartRequest(1, firstBytes),
      multipartPartRequest(2, finalBytes),
    ]);
    const { parts } = (await partsResponse.json()) as { parts: MultipartPartTarget[] };
    const firstPut = await directMultipartPartPut(bucket, parts[0], firstBytes);
    const finalPut = await directMultipartPartPut(bucket, parts[1], finalBytes);
    expect(firstPut.status).toBe(200);
    expect(finalPut.status).toBe(200);
    const uploadedParts = [firstPut, finalPut].map((response, index) => ({
      partNumber: index + 1,
      etag: response.headers.get('etag') || '',
    }));

    const beforeComplete = await workerModule.default.fetch(
      request(`/download/123456/${session.objectId}`),
      workerEnv,
    );
    expect(beforeComplete.status).toBe(404);

    const completed = await workerModule.default.fetch(
      multipartCompleteRequest(session, uploadedParts),
      workerEnv,
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ objectId: session.objectId });
    expect(bucket.multipartCompleteCalls).toBe(1);

    const repeated = await workerModule.default.fetch(
      multipartCompleteRequest(session, uploadedParts),
      workerEnv,
    );
    expect(repeated.status).toBe(200);
    expect(bucket.multipartCompleteCalls).toBe(1);

    const range = await workerModule.default.fetch(
      request(`/download/123456/${session.objectId}`, { headers: { range: 'bytes=1-4' } }),
      workerEnv,
    );
    expect(range.status).toBe(206);
    expect(range.headers.get('accept-ranges')).toBe('bytes');
    expect(range.headers.get('content-range')).toBe(
      `bytes 1-4/${firstBytes.byteLength + finalBytes.byteLength}`,
    );
    expect(range.headers.get('content-length')).toBe('4');
    expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([...firstBytes.slice(1, 5)]);

    const suffix = await workerModule.default.fetch(
      request(`/download/123456/${session.objectId}`, { headers: { range: 'bytes=-3' } }),
      workerEnv,
    );
    expect(suffix.status).toBe(206);
    expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([...finalBytes.slice(-3)]);
    const invalid = await workerModule.default.fetch(
      request(`/download/123456/${session.objectId}`, { headers: { range: 'bytes=999999999-' } }),
      workerEnv,
    );
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe(
      `bytes */${firstBytes.byteLength + finalBytes.byteLength}`,
    );
    const multiple = await workerModule.default.fetch(
      request(`/download/123456/${session.objectId}`, {
        headers: { range: 'bytes=0-1,3-4' },
      }),
      workerEnv,
    );
    expect(multiple.status).toBe(416);
    const abortAfterComplete = await workerModule.default.fetch(
      multipartAbortRequest(session),
      workerEnv,
    );
    expect(abortAfterComplete.status).toBe(200);
    expect(await abortAfterComplete.json()).toEqual({ ok: true, completed: true });
    expect(bucket.objects.has(`room/123456/${session.objectId}`)).toBe(true);
  });

  it('validates the complete ETag list before R2 and fails closed on wrong R2 ETags', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    const { session } = await createMultipartSession(workerEnv, {
      size: 1,
      chunkCount: 1,
      encryptedSize: 17,
    });
    if (!session) throw new Error('missing multipart session');
    const bytes = new Uint8Array(17);
    const partsResponse = await requestMultipartParts(workerEnv, session, [
      multipartPartRequest(1, bytes),
    ]);
    const { parts } = (await partsResponse.json()) as { parts: MultipartPartTarget[] };
    const put = await directMultipartPartPut(bucket, parts[0], bytes);
    const etag = put.headers.get('etag') || '';

    const malformed = await workerModule.default.fetch(
      multipartCompleteRequest(session, [{ partNumber: 1, etag: 'not-an-etag' }]),
      workerEnv,
    );
    expect(malformed.status).toBe(400);
    expect(bucket.multipartCompleteCalls).toBe(0);
    const wrong = await workerModule.default.fetch(
      multipartCompleteRequest(session, [{ partNumber: 1, etag: 'f'.repeat(32) }]),
      workerEnv,
    );
    expect(wrong.status).toBe(409);
    expect(bucket.multipartCompleteCalls).toBe(1);
    const valid = await workerModule.default.fetch(
      multipartCompleteRequest(session, [{ partNumber: 1, etag }]),
      workerEnv,
    );
    expect(valid.status).toBe(200);
  });

  it('recovers when R2 commits multipart completion but its response is lost', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    const { session } = await createMultipartSession(workerEnv, {
      size: 1,
      chunkCount: 1,
      encryptedSize: 17,
    });
    if (!session) throw new Error('missing multipart session');
    const bytes = new Uint8Array(17);
    const partsResponse = await requestMultipartParts(workerEnv, session, [
      multipartPartRequest(1, bytes),
    ]);
    const { parts } = (await partsResponse.json()) as { parts: MultipartPartTarget[] };
    const put = await directMultipartPartPut(bucket, parts[0], bytes);
    const uploadedParts = [{ partNumber: 1, etag: put.headers.get('etag') || '' }];
    bucket.completeCommitsThenThrowsOnce = true;

    const completed = await workerModule.default.fetch(
      multipartCompleteRequest(session, uploadedParts),
      workerEnv,
    );
    expect(completed.status).toBe(200);
    expect(bucket.multipartCompleteCalls).toBe(1);
    expect([...bucket.objects.keys()].some((key) => key.endsWith('.ready'))).toBe(true);
    const repeated = await workerModule.default.fetch(
      multipartCompleteRequest(session, uploadedParts),
      workerEnv,
    );
    expect(repeated.status).toBe(200);
    expect(bucket.multipartCompleteCalls).toBe(1);
  });

  it('aborts active multipart uploads idempotently without deleting completed objects', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    const { session } = await createMultipartSession(workerEnv, {
      size: 1,
      chunkCount: 1,
      encryptedSize: 17,
    });
    if (!session) throw new Error('missing multipart session');
    expect(
      (await workerModule.default.fetch(multipartAbortRequest(session), workerEnv)).status,
    ).toBe(200);
    expect(bucket.multipartUploads.size).toBe(0);
    expect(
      (await workerModule.default.fetch(multipartAbortRequest(session), workerEnv)).status,
    ).toBe(200);
    expect(bucket.multipartAbortCalls).toBe(2);
    const completion = await workerModule.default.fetch(
      multipartCompleteRequest(session, [{ partNumber: 1, etag: '0'.repeat(32) }]),
      workerEnv,
    );
    expect(completion.status).toBe(409);
    expect([...bucket.objects.keys()].some((key) => key.includes(session.objectId))).toBe(false);
  });
});

describe('remote-share Worker bounded upload path', () => {
  it('issues a same-origin Worker upload session without presigned R2 credentials', async () => {
    const { workerEnv } = uploadEnvironment();
    const { response, session } = await createUploadSession(workerEnv);

    expect(response.status).toBe(200);
    expect(session).not.toBeNull();
    expect(session?.uploadUrl).toMatch(
      /^https:\/\/share\.musixquare\.com\/upload\?roomId=123456&objectId=/,
    );
    expect(session?.uploadHeaders['x-mxqr-session-token']).toEqual(expect.any(String));
    expect(session).toMatchObject({ protocolVersion: 2, uploadMethod: 'POST' });
    expect(session?.completeToken).toEqual(expect.any(String));
    expect(session?.uploadUrl).not.toContain('r2.cloudflarestorage.com');
  });

  it('streams the exact signed byte count to a fixed key and rejects token replay atomically', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    bucket.requireFixedLengthBody = true;
    vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
    const { session } = await createUploadSession(workerEnv);
    if (!session) throw new Error('missing upload session');

    const first = await workerModule.default.fetch(
      uploadRequest(session, new Uint8Array([1, 2, 3, 4])),
      workerEnv,
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      objectId: session.objectId,
      expiresAt: session.expiresAt,
    });
    expect(bucket.objects.size).toBe(3);
    const uploadedEntry = [...bucket.objects.entries()].find(
      ([key]) => key.startsWith('room/') && !key.endsWith('.ready'),
    );
    if (!uploadedEntry) throw new Error('missing uploaded object');
    const [uploadedKey, stored] = uploadedEntry;
    expect([...stored.bytes]).toEqual([1, 2, 3, 4]);
    expect(stored.customMetadata).toMatchObject({
      roomId: '123456',
      name: 'track.mp3',
      mime: 'audio/mpeg',
      sizeBytes: '4',
    });
    expect(bucket.put.mock.calls[0]?.[0]).toMatch(/^upload-session\//);
    expect(bucket.put.mock.calls[0]?.[2].onlyIf).toBeInstanceOf(Headers);
    expect(bucket.put.mock.calls[0]?.[2].onlyIf?.get('if-none-match')).toBe('*');
    expect(bucket.put.mock.calls[1]?.[0]).toBe(uploadedKey);
    const uploadedBody = bucket.put.mock.calls[1]?.[1];
    if (!uploadedBody) throw new Error('missing uploaded body stream');
    expect(fixedLengthReadableBodies.has(uploadedBody)).toBe(true);

    const replay = await workerModule.default.fetch(
      uploadRequest(session, new Uint8Array([9, 9, 9, 9])),
      workerEnv,
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'upload session already used' });
    expect([...stored.bytes]).toEqual([1, 2, 3, 4]);

    // Object cleanup must not re-arm the signed token.
    bucket.objects.delete(uploadedKey);
    const replayAfterCleanup = await workerModule.default.fetch(
      uploadRequest(session, new Uint8Array([8, 8, 8, 8])),
      workerEnv,
    );
    expect(replayAfterCleanup.status).toBe(409);
    expect(bucket.objects.has(uploadedKey)).toBe(false);
  });

  it('keeps pre-v2 clients compatible through bounded Worker PUT + complete', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    const { session } = await createUploadSession(workerEnv);
    if (!session) throw new Error('missing upload session');

    const uploaded = await workerModule.default.fetch(
      uploadRequest(session, new Uint8Array([1, 2, 3, 4]), {}, 'PUT'),
      workerEnv,
    );
    expect(uploaded.status).toBe(200);

    const completed = await workerModule.default.fetch(
      request('/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId: '123456',
          objectId: session.objectId,
          completeToken: session.completeToken,
        }),
      }),
      workerEnv,
    );

    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      objectId: session.objectId,
      expiresAt: session.expiresAt,
    });
    expect([...bucket.objects.keys()].some((key) => key.startsWith('room/'))).toBe(true);
  });

  it('counts actual streamed bytes even when Content-Length matches the smaller signed claim', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    bucket.requireFixedLengthBody = true;
    vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
    const { session } = await createUploadSession(workerEnv);
    if (!session) throw new Error('missing upload session');

    const response = await workerModule.default.fetch(
      uploadRequest(session, new Uint8Array([1, 2, 3, 4, 5]), { 'content-length': '4' }),
      workerEnv,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid upload size' });
    expect([...bucket.objects.keys()].some((key) => key.startsWith('room/'))).toBe(false);
  });

  it('rejects an actual body shorter than the signed encrypted size', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    bucket.requireFixedLengthBody = true;
    vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
    const { session } = await createUploadSession(workerEnv);
    if (!session) throw new Error('missing upload session');

    const response = await workerModule.default.fetch(
      uploadRequest(session, new Uint8Array([1, 2, 3])),
      workerEnv,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid upload size' });
    expect([...bucket.objects.keys()].some((key) => key.startsWith('room/'))).toBe(false);
  });

  it('maps a fixed-length validation pipe failure to an invalid-size response', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    bucket.requireFixedLengthBody = true;
    vi.stubGlobal('FixedLengthStream', FailingFixedLengthStream);
    const { session } = await createUploadSession(workerEnv);
    if (!session) throw new Error('missing upload session');

    const response = await workerModule.default.fetch(
      uploadRequest(session, new Uint8Array([1, 2, 3, 4])),
      workerEnv,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid upload size' });
    expect([...bucket.objects.keys()].some((key) => key.startsWith('room/'))).toBe(false);
  });

  it('catches asynchronous R2 upload failures as JSON errors at the fetch boundary', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    bucket.objectPutError = new Error('simulated R2 outage');
    const { session } = await createUploadSession(workerEnv);
    if (!session) throw new Error('missing upload session');

    const response = await workerModule.default.fetch(
      uploadRequest(session, new Uint8Array([1, 2, 3, 4])),
      workerEnv,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'simulated R2 outage' });
  });

  it('keeps the rolling v2 Worker proxy hard-capped at 64 MiB', async () => {
    const { workerEnv } = uploadEnvironment({ MAX_UPLOAD_BYTES: String(200 * 1024 * 1024) });
    const { response } = await createUploadSession(workerEnv, {
      size: 64 * 1024 * 1024 + 1,
      encryptedSize: 64 * 1024 * 1024 + 17,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid upload session request' });
  });

  it('atomically admits only one concurrent session at an IP limit of one', async () => {
    const { workerEnv } = uploadEnvironment({ IP_SESSIONS_PER_WINDOW: '1' });

    const results = await Promise.all([
      createUploadSession(workerEnv, { sessionId: 8 }),
      createUploadSession(workerEnv, { sessionId: 9 }),
    ]);

    expect(results.map(({ response }) => response.status).sort()).toEqual([200, 429]);
    const rejected = results.find(({ response }) => response.status === 429);
    expect(rejected).toBeDefined();
    expect(await rejected?.response.json()).toMatchObject({
      error: 'rate limited',
      retryAfterSeconds: 3600,
    });
  });

  it('atomically reserves declared direct-upload bytes per IP window', async () => {
    const { workerEnv } = uploadEnvironment({
      IP_SESSIONS_PER_WINDOW: '10',
      IP_UPLOAD_BYTES_PER_WINDOW: '6',
    });

    const first = await createUploadSession(workerEnv, {
      protocolVersion: 3,
      sessionId: 8,
      size: 4,
      encryptedSize: 4,
    });
    const second = await createUploadSession(workerEnv, {
      protocolVersion: 3,
      sessionId: 9,
      size: 4,
      encryptedSize: 4,
    });

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(429);
    expect(await second.response.json()).toMatchObject({ error: 'upload byte rate limited' });
  });

  it('atomically admits only one concurrent upload at an IP limit of one', async () => {
    const { workerEnv } = uploadEnvironment({
      IP_SESSIONS_PER_WINDOW: '10',
      IP_UPLOADS_PER_WINDOW: '1',
    });

    const firstSession = await createUploadSession(workerEnv);
    const secondSession = await createUploadSession(workerEnv, { sessionId: 8 });
    expect(firstSession.response.status).toBe(200);
    expect(secondSession.response.status).toBe(200);
    if (!firstSession.session || !secondSession.session) throw new Error('missing upload session');

    const uploads = await Promise.all([
      workerModule.default.fetch(
        uploadRequest(firstSession.session, new Uint8Array([1, 2, 3, 4])),
        workerEnv,
      ),
      workerModule.default.fetch(
        uploadRequest(secondSession.session, new Uint8Array([1, 2, 3, 4])),
        workerEnv,
      ),
    ]);

    expect(uploads.map(({ status }) => status).sort()).toEqual([200, 429]);
  });

  it('does not let an unowned public room ID impose a shared upload quota', async () => {
    const { workerEnv } = uploadEnvironment({
      IP_SESSIONS_PER_WINDOW: '10',
      IP_UPLOADS_PER_WINDOW: '10',
      ROOM_UPLOADS_PER_WINDOW: '1',
    });
    const firstSession = await createUploadSession(workerEnv);
    const secondSession = await createUploadSession(workerEnv, { sessionId: 8 });
    if (!firstSession.session || !secondSession.session) throw new Error('missing upload session');

    const firstUpload = await workerModule.default.fetch(
      uploadRequest(firstSession.session, new Uint8Array([1, 2, 3, 4])),
      workerEnv,
    );
    const secondUpload = await workerModule.default.fetch(
      uploadRequest(secondSession.session, new Uint8Array([1, 2, 3, 4])),
      workerEnv,
    );

    expect(firstUpload.status).toBe(200);
    expect(secondUpload.status).toBe(200);
  });

  it('fails closed when the rate-limiter binding is missing', async () => {
    const { response } = await createUploadSession(
      env({ MXQR_ALLOW_UNGUARDED_REMOTE_SHARE: 'true' }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'rate limiter unavailable' });
  });

  it('rejects oversized session JSON before parsing or minting a token', async () => {
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(9 * 1024) }),
      }),
      env({ MXQR_ALLOW_UNGUARDED_REMOTE_SHARE: 'true' }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'request body too large' });
  });

  it('fails closed when an existing object has no cleanup-token metadata', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    const objectId = '11111111-1111-4111-8111-111111111111';
    const key = `room/123456/${objectId}`;
    bucket.objects.set(key, {
      bytes: new Uint8Array([1]),
      customMetadata: {},
      etag: 'legacy-no-metadata',
      httpEtag: '"legacy-no-metadata"',
    });

    const response = await workerModule.default.fetch(
      request(`/object/123456/${objectId}`, { method: 'DELETE' }),
      workerEnv,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(bucket.objects.has(key)).toBe(true);
  });

  it('deletes only with the matching cleanup token and keeps missing deletes idempotent', async () => {
    const { workerEnv, bucket } = uploadEnvironment();
    const objectId = '22222222-2222-4222-8222-222222222222';
    const key = `room/123456/${objectId}`;
    bucket.objects.set(key, {
      bytes: new Uint8Array([1]),
      customMetadata: { cleanupToken: 'cleanup-secret' },
      etag: 'legacy-cleanup',
      httpEtag: '"legacy-cleanup"',
    });

    const denied = await workerModule.default.fetch(
      request(`/object/123456/${objectId}`, { method: 'DELETE' }),
      workerEnv,
    );
    expect(denied.status).toBe(403);
    expect(bucket.objects.has(key)).toBe(true);

    const deleted = await workerModule.default.fetch(
      request(`/object/123456/${objectId}`, {
        method: 'DELETE',
        headers: { 'x-mxqr-cleanup-token': 'cleanup-secret' },
      }),
      workerEnv,
    );
    expect(deleted.status).toBe(200);
    expect(bucket.objects.has(key)).toBe(false);

    const repeated = await workerModule.default.fetch(
      request(`/object/123456/${objectId}`, { method: 'DELETE' }),
      workerEnv,
    );
    expect(repeated.status).toBe(200);
  });
});
