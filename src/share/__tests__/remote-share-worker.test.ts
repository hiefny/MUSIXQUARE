import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.js';

type RemoteShareWorker = {
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
const QUEUE_ITEM_ID = '10000000-0000-4000-8000-000000000001';

interface R2CorsRule {
  allowed: {
    origins: string[];
    methods: string[];
    headers: string[];
  };
}

const r2CorsPolicy = JSON.parse(
  await readFile(new URL('../../../cloudflare/r2-cors.remote-share.json', import.meta.url), 'utf8'),
) as { rules: R2CorsRule[] };
const liveSmokeSource = await readFile(
  new URL('../../../scripts/live-remote-share-smoke.ts', import.meta.url),
  'utf8',
);

function directPutCorsRule(): R2CorsRule | undefined {
  return r2CorsPolicy.rules.find((rule) =>
    rule.allowed.methods.some((method) => method.toUpperCase() === 'PUT'),
  );
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

async function solveProofOfWork(challenge: string, difficulty: number): Promise<string> {
  const encoder = new TextEncoder();
  for (let solution = 0; solution < 10_000_000; solution += 1) {
    const bytes = new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(`mxqr-pow-v1:${challenge}:${solution}`)),
    );
    let remaining = difficulty;
    let valid = true;
    for (const byte of bytes) {
      if (remaining <= 0) break;
      const bits = Math.min(8, remaining);
      if ((byte & (0xff << (8 - bits))) !== 0) {
        valid = false;
        break;
      }
      remaining -= bits;
    }
    if (valid && remaining <= 0) return String(solution);
  }
  throw new Error('test proof-of-work solution not found');
}

async function createPoWCapabilityToken(scopes = ['remote-share']): Promise<string> {
  const appEnv = {
    MXQR_CAPABILITY_SECRET: CAPABILITY_SECRET,
    MXQR_TURNSTILE_DISABLED: 'true',
    MXQR_CAPABILITY_POW_DIFFICULTY: '8',
  };
  const challengeResponse = await appWorker.fetch(
    new Request('https://musixquare.com/api/capability-challenge', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'cf-connecting-ip': CLIENT_IP,
      },
      body: JSON.stringify({ scopes }),
    }),
    appEnv,
  );
  const challenge = (await challengeResponse.json()) as {
    challenge: string;
    difficulty: number;
  };
  expect(challengeResponse.status).toBe(200);
  const solution = await solveProofOfWork(challenge.challenge, challenge.difficulty);
  const tokenResponse = await appWorker.fetch(
    new Request('https://musixquare.com/api/capability-token', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'cf-connecting-ip': CLIENT_IP,
      },
      body: JSON.stringify({
        scopes,
        proofOfWork: { challenge: challenge.challenge, solution },
      }),
    }),
    appEnv,
  );
  const payload = (await tokenResponse.json()) as { token?: string };
  expect(tokenResponse.status).toBe(200);
  expect(payload.token).toMatch(/\./);
  return payload.token!;
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

function directUploadEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return env({
    MXQR_CAPABILITY_SECRET: CAPABILITY_SECRET,
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
    R2_BUCKET_NAME: 'test-bucket',
    ...extra,
  });
}

function sessionRequestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    roomId: '123456',
    sessionId: 7,
    queueItemId: QUEUE_ITEM_ID,
    name: 'song.wav',
    mime: 'audio/wav',
    size: 4,
    encryptedSize: 20,
    ...overrides,
  });
}

interface QuotaObject {
  key: string;
  size: number;
  customMetadata: Record<string, string>;
}

function createQuotaBucket(initialObjects: QuotaObject[] = []) {
  const objects = new Map(initialObjects.map((object) => [object.key, object]));
  return {
    objects,
    head: vi.fn(async (key: string) => objects.get(key) || null),
    list: vi.fn(
      async ({
        prefix,
        cursor,
        limit = 1000,
      }: {
        prefix: string;
        cursor?: string;
        limit?: number;
      }) => {
        const matches = [...objects.values()]
          .filter((object) => object.key.startsWith(prefix))
          .sort((left, right) => left.key.localeCompare(right.key));
        const start = cursor ? Number(cursor) : 0;
        const page = matches.slice(start, start + limit);
        const next = start + page.length;
        return {
          objects: page,
          truncated: next < matches.length,
          ...(next < matches.length ? { cursor: String(next) } : {}),
        };
      },
    ),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    }),
  };
}

function quotaObject(key: string, size: number, expiresAt = Date.now() + 60_000): QuotaObject {
  return {
    key,
    size,
    customMetadata: {
      expiresAt: String(expiresAt),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('remote-share Worker capability gate', () => {
  it('keeps the live smoke inside the same standard-room namespace', () => {
    expect(liveSmokeSource).toContain('randomInt(100_000, 1_000_000)');
    expect(liveSmokeSource).not.toContain('`live-smoke-${');
  });

  it('keeps checked-in R2 CORS aligned with every Worker production origin range', async () => {
    const corsRule = directPutCorsRule();
    expect(corsRule).toBeDefined();

    const originContract = [
      ['https://musixquare.com', 'https://musixquare.com'],
      ['https://www.musixquare.com', 'https://www.musixquare.com'],
      ['https://tossmini.com', 'https://tossmini.com'],
      ['https://*.tossmini.com', 'https://music.tossmini.com'],
      ['https://toss.im', 'https://toss.im'],
      ['https://*.toss.im', 'https://music.toss.im'],
      ['https://toss-internal.com', 'https://toss-internal.com'],
      ['https://*.toss-internal.com', 'https://music.toss-internal.com'],
      ['http://localhost:4173', 'http://localhost:4173'],
      ['http://127.0.0.1:4173', 'http://127.0.0.1:4173'],
    ] as const;

    for (const [corsOrigin, requestOrigin] of originContract) {
      expect(corsRule!.allowed.origins).toContain(corsOrigin);

      const response = await workerModule.default.fetch(
        new Request('https://share.musixquare.com/session', {
          method: 'OPTIONS',
          headers: { origin: requestOrigin },
        }),
        env(),
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(requestOrigin);
    }
  });

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
    // Match the app Worker policy: missing capability configuration blocks the
    // session endpoint unless the explicit unguarded override is enabled.
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

  it('keeps direct R2 session creation operational with Turnstile disabled PoW', async () => {
    const token = await createPoWCapabilityToken();
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      directUploadEnv(),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).not.toHaveProperty('token');
    expect(payload).toMatchObject({
      objectId: expect.any(String),
      uploadUrl: expect.stringContaining('.r2.cloudflarestorage.com/'),
      completeToken: expect.any(String),
      downloadUrl: expect.stringContaining('/download/123456/'),
    });
    expect(payload.uploadHeaders).toMatchObject({
      'x-amz-meta-size-bytes': '4',
      'x-amz-meta-encrypted-size': '20',
      'x-amz-meta-room-id': '123456',
      'x-amz-meta-object-id': payload.objectId,
    });
    expect(payload.uploadHeaders).not.toHaveProperty('content-length');
    const uploadHeaders = payload.uploadHeaders as Record<string, string>;
    const uploadHeaderNames = Object.keys(uploadHeaders).map((header) => header.toLowerCase());
    const requiredUploadHeaders = [
      'content-type',
      'x-amz-meta-cleanup-token',
      'x-amz-meta-encrypted-size',
      'x-amz-meta-expires-at',
      'x-amz-meta-mime',
      'x-amz-meta-name',
      'x-amz-meta-object-id',
      'x-amz-meta-room-id',
      'x-amz-meta-size-bytes',
    ];
    expect(uploadHeaderNames.sort()).toEqual(requiredUploadHeaders.sort());

    const corsRule = directPutCorsRule();
    expect(corsRule).toBeDefined();
    const corsAllowedHeaders = new Set(
      corsRule!.allowed.headers.map((header) => header.toLowerCase()),
    );
    for (const header of uploadHeaderNames) expect(corsAllowedHeaders.has(header)).toBe(true);

    const signedHeaders = new Set(
      new URL(payload.uploadUrl as string).searchParams
        .get('X-Amz-SignedHeaders')
        ?.split(';')
        .map((header) => header.toLowerCase()) ?? [],
    );
    for (const header of [...uploadHeaderNames, 'content-length']) {
      expect(signedHeaders.has(header)).toBe(true);
    }
  });

  it('accepts only generated standard room codes and rejects the reserved PRO namespace', async () => {
    const token = await createCapabilityToken();
    const rateLimitStore = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };

    for (const roomId of [
      undefined,
      '',
      'room',
      '12345',
      '1234567',
      '12345x',
      '000000',
      '099999',
    ]) {
      const response = await workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body: sessionRequestBody({ roomId }),
        }),
        directUploadEnv({ REMOTE_SHARE_RATE_LIMIT: rateLimitStore }),
      );

      expect(response.status, `roomId=${String(roomId)}`).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid upload session request' });
    }

    // Invalid room IDs fail before consuming rate-limit writes or touching R2.
    expect(rateLimitStore.get).not.toHaveBeenCalled();
    expect(rateLimitStore.put).not.toHaveBeenCalled();
  });

  it('does not resolve download or cleanup object keys in the reserved PRO namespace', async () => {
    const objectId = '00000000-0000-4000-8000-000000000001';
    const bucket = {
      get: vi.fn(async () => null),
      head: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
    };

    const download = await workerModule.default.fetch(
      request(`/download/000001/${objectId}`),
      env({ REMOTE_SHARE_BUCKET: bucket }),
    );
    const cleanup = await workerModule.default.fetch(
      request(`/object/000001/${objectId}`, { method: 'DELETE' }),
      env({ REMOTE_SHARE_BUCKET: bucket }),
    );

    expect(download.status).toBe(404);
    expect(cleanup.status).toBe(200);
    expect(await cleanup.json()).toEqual({ ok: true });
    expect(bucket.get).not.toHaveBeenCalled();
    expect(bucket.head).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('rejects a reserved PRO room code before completion can touch R2', async () => {
    const capability = await createCapabilityToken();
    const sessionResponse = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': capability,
        },
        body: sessionRequestBody(),
      }),
      directUploadEnv(),
    );
    const session = (await sessionResponse.json()) as {
      objectId: string;
      completeToken: string;
    };
    expect(sessionResponse.status).toBe(200);

    const bucket = {
      head: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
    };
    const completion = await workerModule.default.fetch(
      request('/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId: '000001',
          objectId: session.objectId,
          completeToken: session.completeToken,
        }),
      }),
      directUploadEnv({ REMOTE_SHARE_BUCKET: bucket }),
    );

    expect(completion.status).toBe(403);
    expect(await completion.json()).toEqual({ error: 'invalid upload completion' });
    expect(bucket.head).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('stores an HMAC pseudonym instead of a plaintext IP in rate-limit KV keys', async () => {
    const token = await createCapabilityToken();
    const values = new Map<string, string>();
    const rateLimitStore = {
      get: vi.fn(async (key: string) => values.get(key) || null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    };
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      directUploadEnv({ REMOTE_SHARE_RATE_LIMIT: rateLimitStore }),
    );

    const expectedKey = `session-ip:${await hmacSha256(
      SIGNING_SECRET,
      `rate-limit-ip:${CLIENT_IP}`,
    )}`;
    expect(response.status).toBe(200);
    expect(rateLimitStore.get).toHaveBeenCalledWith(expectedKey);
    expect(rateLimitStore.put).toHaveBeenCalledWith(expectedKey, '1', {
      expirationTtl: 3600,
    });
    expect([...values.keys()].join(' ')).not.toContain(CLIENT_IP);
  });

  it('enforces positive plaintext and exact AES-GCM ciphertext sizes at /session', async () => {
    const token = await createCapabilityToken();
    for (const body of [
      sessionRequestBody({ queueItemId: 'not-a-queue-item-id' }),
      sessionRequestBody({ size: 0, encryptedSize: 16 }),
      sessionRequestBody({ size: 4, encryptedSize: 19 }),
      sessionRequestBody({ size: 200 * 1024 * 1024 + 1, encryptedSize: 200 * 1024 * 1024 + 17 }),
    ]) {
      const response = await workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body,
        }),
        directUploadEnv(),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid upload session request' });
    }
  });

  it('accepts the exact 200 MiB plaintext boundary without widening it', async () => {
    const token = await createCapabilityToken();
    const maxBytes = 200 * 1024 * 1024;
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody({ size: maxBytes, encryptedSize: maxBytes + 16 }),
      }),
      directUploadEnv(),
    );

    expect(response.status).toBe(200);
  });

  it('rejects a session before upload when the room would exceed its storage quota', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket([quotaObject('room/123456/existing', 20)]);
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      directUploadEnv({
        REMOTE_SHARE_BUCKET: bucket,
        ROOM_STORAGE_QUOTA_BYTES: '32',
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'room storage quota exceeded',
      code: 'ROOM_STORAGE_QUOTA_EXCEEDED',
      maxBytes: 32,
    });
  });

  it('admits an upload that lands exactly on the room storage quota', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket([quotaObject('room/123456/existing', 12)]);
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      directUploadEnv({
        REMOTE_SHARE_BUCKET: bucket,
        ROOM_STORAGE_QUOTA_BYTES: '32',
      }),
    );

    expect(response.status).toBe(200);
  });

  it('counts all active objects in the same room code and ignores other room prefixes', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket([
      quotaObject('room/123456/existing', 30),
      quotaObject('room/654321/unrelated-room', 1_000),
    ]);
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      directUploadEnv({
        REMOTE_SHARE_BUCKET: bucket,
        ROOM_STORAGE_QUOTA_BYTES: '32',
      }),
    );

    expect(response.status).toBe(409);
  });

  it('deletes a racing upload that exceeds the authoritative completion quota', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const sessionResponse = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      workerEnv,
    );
    const session = (await sessionResponse.json()) as {
      cleanupToken: string;
      completeToken: string;
      expiresAt: number;
      objectId: string;
    };
    const uploadedKey = `room/123456/${session.objectId}`;
    bucket.objects.set(uploadedKey, {
      key: uploadedKey,
      size: 20,
      customMetadata: {
        roomId: '123456',
        objectId: session.objectId,
        sizeBytes: '4',
        encryptedSize: '20',
        expiresAt: String(session.expiresAt),
        cleanupToken: session.cleanupToken,
      },
    });
    bucket.objects.set(
      'room/123456/00000000-0000-4000-8000-000000000099',
      quotaObject('room/123456/00000000-0000-4000-8000-000000000099', 20),
    );

    const complete = await workerModule.default.fetch(
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

    expect(complete.status).toBe(409);
    expect(bucket.objects.has(uploadedKey)).toBe(false);
    expect(bucket.objects.size).toBe(1);
  });

  it('paginates room usage and deletes more than 1,000 stale objects in safe chunks', async () => {
    const token = await createCapabilityToken();
    const expiredAt = Date.now() - 1;
    const bucket = createQuotaBucket(
      Array.from({ length: 1001 }, (_, index) =>
        quotaObject(`room/123456/stale-${String(index).padStart(4, '0')}`, 1, expiredAt),
      ),
    );
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      directUploadEnv({
        REMOTE_SHARE_BUCKET: bucket,
        ROOM_STORAGE_QUOTA_BYTES: '32',
      }),
    );

    expect(response.status).toBe(200);
    expect(bucket.list).toHaveBeenCalledTimes(2);
    expect(bucket.delete).toHaveBeenCalledTimes(2);
    for (const [keys] of bucket.delete.mock.calls) {
      expect(Array.isArray(keys) ? keys.length : 1).toBeLessThanOrEqual(1000);
    }
    expect(bucket.objects.size).toBe(0);
  });

  it('fails closed when stale objects cannot be removed from physical R2 storage', async () => {
    const token = await createCapabilityToken();
    const expiredAt = Date.now() - 1;
    const bucket = createQuotaBucket([quotaObject('room/123456/stale', 20, expiredAt)]);
    bucket.delete.mockRejectedValueOnce(new Error('R2 delete unavailable'));

    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      directUploadEnv({
        REMOTE_SHARE_BUCKET: bucket,
        ROOM_STORAGE_QUOTA_BYTES: '32',
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'room storage quota unavailable' });
    expect(bucket.objects.size).toBe(1);
  });

  it('fails closed after scanning more objects than the bounded quota audit allows', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket(
      Array.from({ length: 2001 }, (_, index) =>
        quotaObject(`room/123456/object-${String(index).padStart(4, '0')}`, 1),
      ),
    );

    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      directUploadEnv({
        REMOTE_SHARE_BUCKET: bucket,
        ROOM_STORAGE_QUOTA_BYTES: '10000',
      }),
    );

    expect(response.status).toBe(409);
    expect(bucket.list).toHaveBeenCalledTimes(3);
  });

  it('completes only when the R2 object metadata matches the signed session', async () => {
    const token = await createCapabilityToken();
    const sessionResponse = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      directUploadEnv(),
    );
    const session = (await sessionResponse.json()) as {
      objectId: string;
      expiresAt: number;
      cleanupToken: string;
      completeToken: string;
    };
    const bucket = {
      head: vi.fn(async () => ({
        size: 20,
        customMetadata: {
          roomId: '123456',
          objectId: session.objectId,
          sizeBytes: '4',
          encryptedSize: '20',
          expiresAt: String(session.expiresAt),
          cleanupToken: session.cleanupToken,
        },
      })),
      delete: vi.fn(async () => undefined),
    };
    const complete = await workerModule.default.fetch(
      request('/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId: '123456',
          objectId: session.objectId,
          completeToken: session.completeToken,
        }),
      }),
      directUploadEnv({ REMOTE_SHARE_BUCKET: bucket }),
    );

    expect(complete.status).toBe(200);
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('keeps completion valid past the PUT start window but never past object expiry', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-07-11T00:00:00.000Z');
    vi.setSystemTime(startedAt);
    const token = await createCapabilityToken();
    const workerEnv = directUploadEnv({
      UPLOAD_TOKEN_TTL_SECONDS: '600',
      OBJECT_TTL_SECONDS: '3600',
    });
    const sessionResponse = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      workerEnv,
    );
    const session = (await sessionResponse.json()) as {
      uploadUrl: string;
      uploadUrlExpiresAt: number;
      completeToken: string;
      objectId: string;
      expiresAt: number;
      cleanupToken: string;
    };
    const startedAtMs = startedAt.getTime();
    expect(sessionResponse.status).toBe(200);
    expect(new URL(session.uploadUrl).searchParams.get('X-Amz-Expires')).toBe('600');
    expect(session.uploadUrlExpiresAt).toBe(startedAtMs + 10 * 60_000);
    expect(session.expiresAt).toBe(startedAtMs + 60 * 60_000);

    const bucket = {
      head: vi.fn(async () => ({
        size: 20,
        customMetadata: {
          roomId: '123456',
          objectId: session.objectId,
          sizeBytes: '4',
          encryptedSize: '20',
          expiresAt: String(session.expiresAt),
          cleanupToken: session.cleanupToken,
        },
      })),
      delete: vi.fn(async () => undefined),
    };
    const completeRequest = (): Request =>
      request('/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId: '123456',
          objectId: session.objectId,
          completeToken: session.completeToken,
        }),
      });

    // The PUT began while its URL was valid and progressed for eleven minutes.
    vi.setSystemTime(startedAtMs + 11 * 60_000);
    const completed = await workerModule.default.fetch(
      completeRequest(),
      directUploadEnv({ ...workerEnv, REMOTE_SHARE_BUCKET: bucket }),
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      objectId: session.objectId,
      expiresAt: startedAtMs + 60 * 60_000,
    });

    // Completion authority ends with the original object lifetime; completing
    // once does not slide the expiry forward from completion time.
    vi.setSystemTime(startedAtMs + 60 * 60_000 + 1);
    const expired = await workerModule.default.fetch(
      completeRequest(),
      directUploadEnv({ ...workerEnv, REMOTE_SHARE_BUCKET: bucket }),
    );
    expect(expired.status).toBe(403);
    expect(await expired.json()).toEqual({ error: 'invalid upload completion' });
    expect(bucket.head).toHaveBeenCalledTimes(1);
  });

  it('rejects completion when object expiry passes while awaiting R2 HEAD', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-07-11T00:00:00.000Z');
    vi.setSystemTime(startedAt);
    const token = await createCapabilityToken();
    const workerEnv = directUploadEnv({ OBJECT_TTL_SECONDS: '1' });
    const sessionResponse = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody(),
      }),
      workerEnv,
    );
    const session = (await sessionResponse.json()) as {
      completeToken: string;
      objectId: string;
      expiresAt: number;
      cleanupToken: string;
    };
    expect(sessionResponse.status).toBe(200);

    vi.setSystemTime(startedAt.getTime() + 500);
    const bucket = {
      head: vi.fn(async () => {
        vi.setSystemTime(startedAt.getTime() + 1_001);
        return {
          size: 20,
          customMetadata: {
            roomId: '123456',
            objectId: session.objectId,
            sizeBytes: '4',
            encryptedSize: '20',
            expiresAt: String(session.expiresAt),
            cleanupToken: session.cleanupToken,
          },
        };
      }),
      delete: vi.fn(async () => undefined),
    };

    const response = await workerModule.default.fetch(
      request('/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId: '123456',
          objectId: session.objectId,
          completeToken: session.completeToken,
        }),
      }),
      directUploadEnv({ ...workerEnv, REMOTE_SHARE_BUCKET: bucket }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'expired' });
    expect(bucket.delete).toHaveBeenCalledOnce();
  });

  it('removes the legacy same-Worker proxy upload route', async () => {
    const response = await workerModule.default.fetch(
      request('/upload', { method: 'POST', body: new Uint8Array([1, 2, 3]) }),
      env(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
  });

  it('rejects oversized session JSON after capability verification', async () => {
    const token = await createCapabilityToken();
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: JSON.stringify({ roomId: 'room', padding: 'x'.repeat(8192) }),
      }),
      env({ MXQR_CAPABILITY_SECRET: CAPABILITY_SECRET }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'request body too large' });
  });

  it('rejects oversized completion JSON before token verification', async () => {
    const response = await workerModule.default.fetch(
      request('/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'room', padding: 'x'.repeat(8192) }),
      }),
      env({ REMOTE_SHARE_BUCKET: {} }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'request body too large' });
  });

  it('rejects stored objects without exact modern size and object metadata', async () => {
    const objectId = '00000000-0000-4000-8000-000000000001';
    const deleteObject = vi.fn(async () => undefined);
    const bucket = {
      get: vi.fn(async () => ({
        size: 20,
        body: new Uint8Array(20),
        customMetadata: { expiresAt: String(Date.now() + 60_000) },
      })),
      delete: deleteObject,
    };
    const response = await workerModule.default.fetch(
      request(`/download/123456/${objectId}`),
      env({ REMOTE_SHARE_BUCKET: bucket }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'invalid stored object' });
    expect(deleteObject).toHaveBeenCalledWith(`room/123456/${objectId}`);
  });

  it('serves a stored object only when object, plaintext, and ciphertext metadata agree', async () => {
    const objectId = '00000000-0000-4000-8000-000000000001';
    const bucket = {
      get: vi.fn(async () => ({
        size: 20,
        body: new Uint8Array(20),
        customMetadata: {
          roomId: '123456',
          objectId,
          sizeBytes: '4',
          encryptedSize: '20',
          expiresAt: String(Date.now() + 60_000),
        },
      })),
      delete: vi.fn(async () => undefined),
    };
    const response = await workerModule.default.fetch(
      request(`/download/123456/${objectId}`),
      env({ REMOTE_SHARE_BUCKET: bucket }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('20');
    expect((await response.arrayBuffer()).byteLength).toBe(20);
    expect(bucket.delete).not.toHaveBeenCalled();
  });
});
