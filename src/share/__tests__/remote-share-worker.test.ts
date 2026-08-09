import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.js';
import { createAtomicRateControlBinding } from '../../core/__tests__/service-control-rate-limit-fixture.ts';

type RemoteShareWorker = {
  default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
  RemoteShareQuota: new (
    state: { storage: FakeQuotaStorage },
    env: Record<string, unknown>,
  ) => {
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
  };
};

const remoteShareWorkerModulePath = '../../../cloudflare/remote-share-worker.js';
const workerModule = (await import(remoteShareWorkerModulePath)) as RemoteShareWorker;
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

interface R2LifecycleRule {
  id: string;
  enabled: boolean;
  conditions: { prefix: string };
  deleteObjectsTransition: {
    condition: { type: string; maxAge: number };
  };
}

const r2CorsPolicy = JSON.parse(
  await readFile(new URL('../../../cloudflare/r2-cors.remote-share.json', import.meta.url), 'utf8'),
) as { rules: R2CorsRule[] };
const r2LifecyclePolicy = JSON.parse(
  await readFile(
    new URL('../../../cloudflare/r2-lifecycle.remote-share.json', import.meta.url),
    'utf8',
  ),
) as { rules: R2LifecycleRule[] };
const liveSmokeSource = await readFile(
  new URL('../../../scripts/live-remote-share-smoke.ts', import.meta.url),
  'utf8',
);
const remoteShareWranglerSource = await readFile(
  new URL('../../../cloudflare/wrangler.remote-share.toml', import.meta.url),
  'utf8',
);
const releaseWorkflowSource = await readFile(
  new URL('../../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const productionSecurityGuardSource = await readFile(
  new URL('../../../scripts/assert-production-security-config.mjs', import.meta.url),
  'utf8',
);
const remoteShareContractVersion = (
  await readFile(
    new URL('../../../cloudflare/remote-share-contract-version.txt', import.meta.url),
    'utf8',
  )
).trim();

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

function decodeSignedTokenPayload(token: unknown): Record<string, unknown> {
  const payloadPart = String(token).split('.')[0] || '';
  const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
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

async function sessionProofObjectName(requestId: string, actorId: string): Promise<string> {
  const authorityScope = await hmacSha256(
    SIGNING_SECRET,
    `remote-share-client-actor:v3\u0000${actorId}`,
  );
  const receipt = `rs_${await hmacSha256(
    SIGNING_SECRET,
    `upload-session-request:v3\u0000${authorityScope}\u0000${requestId}`,
  )}`;
  return `session-proof-v3:${receipt}`;
}

async function createCapabilityToken(
  scopes = ['remote-share'],
  options: { ip?: string; jti?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ip = options.ip ?? CLIENT_IP;
  const payload = {
    v: 1,
    scopes,
    iat: now,
    exp: now + 600,
    ip: await hmacSha256(CAPABILITY_SECRET, `ip:${ip}`),
    method: 'test',
    ...(options.jti ? { jti: options.jti } : {}),
  };
  const payloadPart = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSha256(CAPABILITY_SECRET, payloadPart);
  return `${payloadPart}.${signature}`;
}

async function createMalformedUtf8CapabilityToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const prefix = new TextEncoder().encode(
    `{"v":1,"scopes":["remote-share"],"iat":${now},"exp":${now + 600},"ip":"${await hmacSha256(
      CAPABILITY_SECRET,
      `ip:${CLIENT_IP}`,
    )}","method":"`,
  );
  const suffix = new TextEncoder().encode('"}');
  const bytes = new Uint8Array(prefix.byteLength + 2 + suffix.byteLength);
  bytes.set(prefix, 0);
  bytes.set([0xc3, 0x28], prefix.byteLength);
  bytes.set(suffix, prefix.byteLength + 2);
  const payloadPart = base64UrlEncode(bytes);
  return `${payloadPart}.${await hmacSha256(CAPABILITY_SECRET, payloadPart)}`;
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
    MXQR_ALLOW_STATELESS_REMOTE_SHARE_SESSION: 'true',
    MXQR_CAPABILITY_SECRET: CAPABILITY_SECRET,
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
    R2_BUCKET_NAME: 'test-bucket',
    ...extra,
  });
}

class FakeQuotaStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get(key: string): Promise<unknown> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarmAt = timestamp;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

interface FakeQuotaInstance {
  object: InstanceType<RemoteShareWorker['RemoteShareQuota']>;
  storage: FakeQuotaStorage;
}

interface FakeQuotaNamespace {
  idFromName(name: string): string;
  get(id: string): { fetch(request: Request): Promise<Response> };
  instance(name: string): FakeQuotaInstance;
}

function attachQuotaNamespace(workerEnv: Record<string, unknown>): FakeQuotaNamespace {
  const instances = new Map<string, FakeQuotaInstance>();
  const instance = (name: string): FakeQuotaInstance => {
    let current = instances.get(name);
    if (!current) {
      const storage = new FakeQuotaStorage();
      current = {
        object: new workerModule.RemoteShareQuota({ storage }, workerEnv),
        storage,
      };
      instances.set(name, current);
    }
    return current;
  };
  const namespace: FakeQuotaNamespace = {
    idFromName: (name) => name,
    get: (id) => ({ fetch: (quotaRequest) => instance(id).object.fetch(quotaRequest) }),
    instance,
  };
  workerEnv.REMOTE_SHARE_QUOTA = namespace;
  return namespace;
}

function directUploadQuotaEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const workerEnv = directUploadEnv(extra);
  attachQuotaNamespace(workerEnv);
  return workerEnv;
}

function sessionRequestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    roomId: '123456',
    sessionId: 7,
    queueItemId: QUEUE_ITEM_ID,
    name: 'song.wav',
    mime: 'audio/wav',
    size: 20,
    ...overrides,
  });
}

async function signTestToken(payload: Record<string, unknown>, secret = SIGNING_SECRET) {
  const payloadPart = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${payloadPart}.${await hmacSha256(secret, payloadPart)}`;
}

function customMetadataFromUploadHeaders(
  uploadHeaders: Record<string, string>,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(uploadHeaders)) {
    const prefix = 'x-amz-meta-';
    if (name.startsWith(prefix)) metadata[name.slice(prefix.length)] = value;
  }
  return metadata;
}

interface QuotaObject {
  key: string;
  size: number;
  customMetadata: Record<string, string>;
  etag?: string;
  httpEtag?: string;
}

function createQuotaBucket(initialObjects: QuotaObject[] = []) {
  const objects = new Map(initialObjects.map((object) => [object.key, object]));
  let etagSequence = 0;
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
    put: vi.fn(
      async (
        key: string,
        body: Uint8Array,
        options: {
          customMetadata?: Record<string, string>;
          onlyIf?: { etagDoesNotMatch?: string; etagMatches?: string };
        } = {},
      ) => {
        if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
        const current = objects.get(key);
        if (
          options.onlyIf?.etagMatches &&
          options.onlyIf.etagMatches !== current?.etag &&
          options.onlyIf.etagMatches !== current?.httpEtag
        ) {
          return null;
        }
        etagSequence += 1;
        const etag = etagSequence.toString(16).padStart(32, '0');
        const object = {
          key,
          size: body.byteLength,
          customMetadata: { ...(options.customMetadata || {}) },
          etag,
          httpEtag: `"${etag}"`,
        };
        objects.set(key, object);
        return object;
      },
    ),
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

interface SessionResponse {
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  uploadUrlExpiresAt: number;
  completeToken: string;
  objectId: string;
  expiresAt: number;
  cleanupToken: string;
}

type LiveSmokeRequestSession = (
  token: string,
  roomId: string,
  queueItemId: string,
  sessionId: number,
  sourceFile: File,
  requestId: string,
  actorId: string,
) => Promise<SessionResponse & { queueItemId: string; sessionId: number }>;

let liveSmokeRequestSession: LiveSmokeRequestSession | undefined;

async function loadLiveSmokeRequestSession(): Promise<LiveSmokeRequestSession> {
  if (liveSmokeRequestSession) return liveSmokeRequestSession;
  const entrypoint = 'await main();';
  if (liveSmokeSource.split(entrypoint).length !== 2) {
    throw new Error('live remote-share smoke entrypoint is not uniquely instrumentable');
  }
  const captureName = '__mxqrLiveSmokeRequestSession';
  const instrumented = liveSmokeSource.replace(
    entrypoint,
    `globalThis[${JSON.stringify(captureName)}] = requestSession;`,
  );
  const compiled = ts.transpileModule(instrumented, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`);
  const captured = (globalThis as typeof globalThis & Record<string, unknown>)[captureName];
  delete (globalThis as typeof globalThis & Record<string, unknown>)[captureName];
  if (typeof captured !== 'function') {
    throw new Error('live remote-share smoke requestSession capture failed');
  }
  liveSmokeRequestSession = captured as LiveSmokeRequestSession;
  return liveSmokeRequestSession;
}

function liveSmokeSessionResponse(status: number, payload: object): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'access-control-allow-origin': ORIGIN,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

const validLiveSmokeSession: SessionResponse = {
  uploadUrl: 'https://example.r2.cloudflarestorage.com/upload',
  uploadHeaders: { 'if-match': '"placeholder-etag"' },
  uploadUrlExpiresAt: 1_800_000_600_000,
  completeToken: 'complete.token',
  objectId: '00000000-0000-4000-8000-000000000001',
  expiresAt: 1_800_003_600_000,
  cleanupToken: 'cleanup.token',
};

function callLiveSmokeRequestSession(requestSession: LiveSmokeRequestSession) {
  return requestSession(
    'capability.token',
    '123456',
    QUEUE_ITEM_ID,
    1_800_000_000_000,
    new File([new Uint8Array([1, 2, 3, 4])], 'smoke.wav', { type: 'audio/wav' }),
    `rs3_${'r'.repeat(43)}`,
    `rsa_${'a'.repeat(43)}`,
  );
}

interface CompleteResponse {
  downloadToken: string;
  downloadUrl: string;
  objectId: string;
  storedSize: number;
  expiresAt: number;
  cleanupToken: string;
}

async function createCompletedObject() {
  const bucket = createQuotaBucket();
  const get = vi.fn(async (key: string) => {
    const object = bucket.objects.get(key);
    return object ? { ...object, body: new Uint8Array([1, 2, 3, 4]) } : null;
  });
  Object.assign(bucket, { get });
  const workerEnv = directUploadQuotaEnv({
    REMOTE_SHARE_BUCKET: bucket,
    ROOM_STORAGE_QUOTA_BYTES: '32',
  });
  const capability = await createCapabilityToken();
  const sessionResponse = await workerModule.default.fetch(
    request('/session', {
      method: 'POST',
      headers: {
        'cf-connecting-ip': CLIENT_IP,
        'content-type': 'application/json',
        'x-mxqr-capability': capability,
      },
      body: sessionRequestBody({ size: 4 }),
    }),
    workerEnv,
  );
  expect(sessionResponse.status).toBe(200);
  const session = (await sessionResponse.json()) as SessionResponse;
  const key = `room/123456/${session.objectId}`;
  bucket.objects.set(key, {
    key,
    size: 4,
    customMetadata: customMetadataFromUploadHeaders(session.uploadHeaders),
  });
  const completeResponse = await workerModule.default.fetch(
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
  expect(completeResponse.status).toBe(200);
  const complete = (await completeResponse.json()) as CompleteResponse;
  return { bucket, complete, get, key, session, workerEnv };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('remote-share Worker capability gate', () => {
  it('keeps the live smoke inside the same standard-room namespace', () => {
    expect(liveSmokeSource).toContain('randomInt(100_000, 1_000_000)');
    expect(liveSmokeSource).not.toContain('`live-smoke-${');
  });

  it('fails production smoke when either capability boundary becomes permissive', () => {
    expect(liveSmokeSource).toContain('config.capabilityRequired !== true');
    expect(liveSmokeSource).toContain('production App capability protection is disabled');
    expect(liveSmokeSource).toContain('assertAnonymousSessionRejected');
    expect(liveSmokeSource).toContain('response.status !== 401');
    expect(liveSmokeSource).toContain('anonymousSessionRejected: true');
  });

  it('requires and exercises the actor-bound v3 session replay contract in production smoke', () => {
    expect(liveSmokeSource).toContain('config.workerContractVersion === 3');
    expect(liveSmokeSource).toContain('config.sessionReplayRequired === true');
    expect(liveSmokeSource).toContain('config.sessionReplayEnabled === true');
    expect(liveSmokeSource).toContain('replay.objectId !== session.objectId');
    expect(liveSmokeSource).toContain('replay.cleanupToken !== session.cleanupToken');
    expect(liveSmokeSource).toContain('replay.expiresAt !== session.expiresAt');
    expect(liveSmokeSource).toContain('replay.uploadUrlExpiresAt !== session.uploadUrlExpiresAt');
    expect(liveSmokeSource).toContain('replay.uploadUrl === session.uploadUrl');
    expect(liveSmokeSource).toContain('durableSessionReplay: true');
    expect(liveSmokeSource).toContain('replayPreservedAllocation: true');
    expect(liveSmokeSource).toContain('replayFreshUploadUrl: true');
    expect(liveSmokeSource).toContain("normalized['if-match']");
    expect(liveSmokeSource).toContain('JSON_RESPONSE_MAX_BYTES = 256 * 1024');
    expect(liveSmokeSource).toContain("new TextDecoder('utf-8', { fatal: true })");
    expect(liveSmokeSource).toContain('function cancelResponseBody(');
    expect(liveSmokeSource).not.toContain('await response.body?.cancel');
  });

  it('bounds deployment-propagation recovery to exact v3 quota and replay retries', () => {
    expect(liveSmokeSource).toContain('SESSION_PROPAGATION_TIMEOUT_MS = 30_000');
    expect(liveSmokeSource).toContain('SESSION_RETRY_INITIAL_MS = 250');
    expect(liveSmokeSource).toContain('SESSION_RETRY_MAX_MS = 2_000');
    expect(liveSmokeSource).toContain("'room storage quota unavailable'");
    expect(liveSmokeSource).toContain("'upload session replay unavailable'");
    expect(liveSmokeSource).toContain('const requestBody = JSON.stringify({');
    expect(liveSmokeSource).toContain('body: requestBody');
    expect(liveSmokeSource).toContain('response.status === 503');
    expect(liveSmokeSource).toContain('RETRYABLE_SESSION_ERRORS.has(session.error)');
    expect(liveSmokeSource).toContain('if (!retryable || Date.now() >= deadline)');
    expect(liveSmokeSource).toContain('retrying exact v3 request');
    expect(liveSmokeSource).not.toContain('response.status === 409 &&');
  });

  it('retries a transient quota 503 with the byte-identical v3 request and then succeeds', async () => {
    const requestSession = await loadLiveSmokeRequestSession();
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const requestBodies: string[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        requestBodies.push(String(init?.body));
        return liveSmokeSessionResponse(503, { error: 'room storage quota unavailable' });
      })
      .mockImplementationOnce(async (_input, init) => {
        requestBodies.push(String(init?.body));
        return liveSmokeSessionResponse(200, validLiveSmokeSession);
      });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = callLiveSmokeRequestSession(requestSession);
    await vi.advanceTimersByTimeAsync(250);

    await expect(outcome).resolves.toMatchObject(validLiveSmokeSession);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(JSON.parse(requestBodies[0] || '')).toMatchObject({
      requestId: `rs3_${'r'.repeat(43)}`,
      actorId: `rsa_${'a'.repeat(43)}`,
    });
  });

  it.each([
    [401, 'CAPABILITY_REQUIRED'],
    [409, 'upload session request conflict'],
    [503, 'rate limit unavailable'],
  ])('does not retry fatal session HTTP %i (%s)', async (status, error) => {
    const requestSession = await loadLiveSmokeRequestSession();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(liveSmokeSessionResponse(status, { error }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callLiveSmokeRequestSession(requestSession)).rejects.toThrow(
      `remote-share session HTTP ${status}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops exact-request quota retries at the 30-second propagation deadline', async () => {
    const requestSession = await loadLiveSmokeRequestSession();
    const startedAt = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      liveSmokeSessionResponse(503, {
        error: 'upload session replay unavailable',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const outcome = callLiveSmokeRequestSession(requestSession).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await outcome;

    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain('remote-share session HTTP 503');
    expect(Date.now() - startedAt).toBe(30_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(new Set(fetchMock.mock.calls.map(([, init]) => String(init?.body))).size).toBe(1);
  });

  it('bounds R2 CORS propagation retries to preflight 403 responses', () => {
    expect(liveSmokeSource).toContain('R2_CORS_PROPAGATION_TIMEOUT_MS = 45_000');
    expect(liveSmokeSource).toContain('R2_CORS_RETRY_INTERVAL_MS = 2_000');
    expect(liveSmokeSource).toContain('response.status !== 403 || Date.now() >= deadline');
    expect(liveSmokeSource).toContain(
      'throw new Error(`R2 CORS preflight HTTP ${response.status}`)',
    );
  });

  it('applies whole-object R2 CORS before remote-share deployment', () => {
    const corsStep = releaseWorkflowSource.indexOf('- name: Apply remote-share R2 CORS policy');
    const deployStep = releaseWorkflowSource.indexOf(
      '- name: Deploy and record remote-share Worker',
    );

    expect(corsStep).toBeGreaterThan(-1);
    expect(corsStep).toBeLessThan(deployStep);
    expect(releaseWorkflowSource).toContain('r2 bucket cors set musixquare-remote-share');
    expect(releaseWorkflowSource).toContain('--file cloudflare/r2-cors.remote-share.json');
    expect(releaseWorkflowSource).toContain('--force');
  });

  it('keeps one automatic lifecycle rule for the sole room/ object namespace', () => {
    expect(r2LifecyclePolicy.rules).toEqual([
      {
        id: 'Delete active remote share objects',
        enabled: true,
        conditions: { prefix: 'room/' },
        deleteObjectsTransition: {
          condition: { type: 'Age', maxAge: 86_400 },
        },
      },
    ]);
    expect(releaseWorkflowSource).toContain("grep -Fq 'prefix:   room/'");
    expect(releaseWorkflowSource).toContain('-ne 1');
  });

  it('forces the first incompatible app/Worker contract rollout through target all', () => {
    const guardStep = releaseWorkflowSource.indexOf(
      '- name: Require a full release for remote-share contract cutovers',
    );
    const remoteDeployStep = releaseWorkflowSource.indexOf(
      '- name: Deploy and record remote-share Worker',
    );
    const appDeployStep = releaseWorkflowSource.indexOf(
      '- name: Deploy and record app Worker with immutable dist',
    );

    expect(remoteShareContractVersion).toBe('canonical-whole-object-actor-replay-v3');
    expect(guardStep).toBeGreaterThan(-1);
    expect(guardStep).toBeLessThan(remoteDeployStep);
    expect(guardStep).toBeLessThan(appDeployStep);
    expect(releaseWorkflowSource).toContain(
      "contract_marker='cloudflare/remote-share-contract-version.txt'",
    );
    expect(releaseWorkflowSource).toContain(
      'git diff --quiet "$parent_sha" "$GITHUB_SHA" -- "$contract_marker"',
    );
    expect(releaseWorkflowSource).toContain(
      "A remote-share public contract cutover requires target 'all'",
    );
  });

  it('applies PRO media Range CORS only before a PRO deployment', () => {
    const corsStep = releaseWorkflowSource.indexOf('- name: Apply PRO media R2 CORS policy');
    const proRoomDeployStep = releaseWorkflowSource.indexOf(
      '- name: Deploy and record PRO room Worker',
    );
    const appDeployStep = releaseWorkflowSource.indexOf(
      '- name: Deploy and record app Worker with immutable dist',
    );

    expect(corsStep).toBeGreaterThan(-1);
    expect(corsStep).toBeLessThan(proRoomDeployStep);
    expect(appDeployStep).toBeGreaterThan(corsStep);
    expect(releaseWorkflowSource).toContain(
      "if: inputs.target == 'all' || inputs.target == 'pro-room'",
    );
    expect(releaseWorkflowSource).not.toContain(
      "if: inputs.target == 'all' || inputs.target == 'pro-room' || inputs.target == 'app'",
    );
    expect(releaseWorkflowSource).toContain('r2 bucket cors set musixquare-pro-media');
    expect(releaseWorkflowSource).toContain('--file cloudflare/r2-cors.pro-media.json');
    expect(releaseWorkflowSource).toContain('--config cloudflare/wrangler.pro-room.toml');
    expect(releaseWorkflowSource).toContain('--force');
    expect(releaseWorkflowSource).toContain('r2 bucket cors list musixquare-pro-media');
    expect(releaseWorkflowSource).toContain(
      'for required_header in range accept-ranges content-encoding content-range etag',
    );
    expect(releaseWorkflowSource).toContain(
      'PRO media R2 CORS read-back is missing ${required_header}.',
    );
    expect(releaseWorkflowSource).toContain('npm run smoke:live:pro-media-cors');
  });

  it('keeps checked-in R2 CORS aligned with every Worker production origin range', async () => {
    const corsRule = directPutCorsRule();
    expect(corsRule).toBeDefined();

    const originContract = [
      ['https://musixquare.com', 'https://musixquare.com'],
      ['https://www.musixquare.com', 'https://www.musixquare.com'],
      ['https://musixquare.apps.tossmini.com', 'https://musixquare.apps.tossmini.com'],
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

  it('reports the production capability and durable replay contract', async () => {
    const workerEnv = directUploadQuotaEnv({
      MXQR_ALLOW_STATELESS_REMOTE_SHARE_SESSION: 'false',
      ROOM_STORAGE_QUOTA_BYTES: '64',
    });
    const response = await workerModule.default.fetch(request('/security-config'), workerEnv);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      capabilityRequired: true,
      scope: 'remote-share',
      ttl: 600,
      workerContractVersion: 3,
      sessionReplayRequired: true,
      sessionReplayEnabled: true,
      wholeObjectVersion: 1,
      downloadAuthorizationVersion: 1,
    });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('pins production durable replay configuration in Wrangler', () => {
    expect(remoteShareWranglerSource).toContain('ROOM_STORAGE_QUOTA_BYTES = "1073741824"');
    expect(remoteShareWranglerSource).toContain('name = "REMOTE_SHARE_QUOTA"');
    expect(remoteShareWranglerSource).not.toContain('MXQR_ALLOW_STATELESS_REMOTE_SHARE_SESSION');
    expect(productionSecurityGuardSource).toContain("'MXQR_ALLOW_STATELESS_REMOTE_SHARE_SESSION'");
  });

  it('fails a production session closed when durable replay configuration drifts off', async () => {
    const token = await createCapabilityToken();
    const workerEnv = directUploadEnv({
      MXQR_ALLOW_STATELESS_REMOTE_SHARE_SESSION: 'false',
      ROOM_STORAGE_QUOTA_BYTES: '0',
    });
    const readiness = await workerModule.default.fetch(request('/security-config'), workerEnv);
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
      workerEnv,
    );

    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toMatchObject({
      sessionReplayRequired: true,
      sessionReplayEnabled: false,
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'upload session replay unavailable' });
  });

  it('keeps unexpected internal exception detail out of public 5xx bodies', async () => {
    const internalDetail = 'provider configuration super-secret detail';
    const workerEnv = new Proxy(env(), {
      get(target, property, receiver) {
        if (property === 'MXQR_CAPABILITY_SECRET') throw new Error(internalDetail);
        return Reflect.get(target, property, receiver);
      },
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await workerModule.default.fetch(request('/security-config'), workerEnv);

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'internal server error' });
    expect(body).not.toContain(internalDetail);
    expect(errorLog).toHaveBeenCalledWith('remote share request failed', 'Error');
  });

  it('converts asynchronous route failures into the stable JSON and CORS boundary', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
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
    const session = (await sessionResponse.json()) as SessionResponse;
    bucket.head.mockRejectedValueOnce(new Error('provider configuration super-secret detail'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

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
      workerEnv,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    await expect(response.json()).resolves.toEqual({ error: 'internal server error' });
    expect(errorLog).toHaveBeenCalledWith('remote share request failed', 'Error');
    errorLog.mockRestore();
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

  it('fails closed when a configured capability secret is below the HMAC minimum', async () => {
    const response = await workerModule.default.fetch(
      request('/session', { method: 'POST', body: 'not-json' }),
      env({ MXQR_CAPABILITY_SECRET: 'weak' }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'CAPABILITY_SECRET_INVALID' });
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

  it('rejects an otherwise valid capability payload containing malformed UTF-8', async () => {
    const token = await createMalformedUtf8CapabilityToken();
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        body: 'not-json',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'x-mxqr-capability': token,
        },
      }),
      directUploadEnv(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'CAPABILITY_REQUIRED' });
  });

  it('bounds a session JSON body that stalls after its first chunk', async () => {
    const token = await createCapabilityToken();
    vi.useFakeTimers();
    let bodyReadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyReadStarted = resolve;
    });
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode('{'));
            bodyReadStarted();
          }
          return new Promise<void>(() => {});
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const responsePromise = workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      directUploadEnv(),
    );
    let settled = false;
    void responsePromise.then(() => {
      settled = true;
    });

    await started;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const response = await responsePromise;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: 'request body timed out' });
    expect(cancel).toHaveBeenCalled();
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
    });
    expect(payload.uploadHeaders).toMatchObject({
      'x-amz-meta-format-version': 'whole-object-v1',
      'x-amz-meta-stored-size': '20',
      'x-amz-meta-room-id': '123456',
      'x-amz-meta-object-id': payload.objectId,
    });
    expect(payload.uploadHeaders).not.toHaveProperty('content-length');
    const uploadHeaders = payload.uploadHeaders as Record<string, string>;
    const uploadHeaderNames = Object.keys(uploadHeaders).map((header) => header.toLowerCase());
    const requiredUploadHeaders = [
      'content-type',
      'x-amz-meta-cleanup-token',
      'x-amz-meta-expires-at',
      'x-amz-meta-format-version',
      'x-amz-meta-mime',
      'x-amz-meta-name',
      'x-amz-meta-object-id',
      'x-amz-meta-room-id',
      'x-amz-meta-stored-size',
    ];
    expect(uploadHeaderNames.sort()).toEqual(requiredUploadHeaders.sort());

    const corsRule = directPutCorsRule();
    expect(corsRule).toBeDefined();
    const corsAllowedHeaders = new Set(
      corsRule!.allowed.headers.map((header) => header.toLowerCase()),
    );
    for (const header of uploadHeaderNames) expect(corsAllowedHeaders.has(header)).toBe(true);
    expect(corsAllowedHeaders.has('if-match')).toBe(true);

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
    const control = createAtomicRateControlBinding();

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
        directUploadEnv({ MUSIXQUARE_SERVICE_CONTROL: control.binding }),
      );

      expect(response.status, `roomId=${String(roomId)}`).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid upload session request' });
    }

    // Invalid room IDs fail before consuming an atomic rate-limit operation or touching R2.
    expect(control.rateFetchCount()).toBe(0);
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

  it('uses an HMAC pseudonym instead of a raw IP in atomic rate-limit object names', async () => {
    const token = await createCapabilityToken();
    const control = createAtomicRateControlBinding();
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
      directUploadEnv({ MUSIXQUARE_SERVICE_CONTROL: control.binding }),
    );

    const expectedKey = `musixquare-abuse-rate-v1:remote-share-upload:session-ip:${await hmacSha256(
      SIGNING_SECRET,
      `rate-limit-ip:${CLIENT_IP}`,
    )}`;
    expect(response.status).toBe(200);
    expect(control.objectNames()).toContain(expectedKey);
    expect(control.objectNames().join(' ')).not.toContain(CLIENT_IP);
  });

  it('coalesces barrier-concurrent identical sessions into one rate consume and receipt', async () => {
    const token = await createCapabilityToken();
    const control = createAtomicRateControlBinding(2);
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: createQuotaBucket(),
      ROOM_STORAGE_QUOTA_BYTES: '64',
      MUSIXQUARE_SERVICE_CONTROL: control.binding,
      IP_UPLOADS_PER_WINDOW: '1',
    });
    const body = sessionRequestBody({
      requestId: `rs3_${'E'.repeat(43)}`,
      actorId: `rsa_${'E'.repeat(43)}`,
    });
    const createSession = () =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body,
        }),
        workerEnv,
      );

    const pending = Promise.all([createSession(), createSession()]);
    await vi.waitFor(() => expect(control.rateFetchCount()).toBe(1));
    control.releaseRateBarrier();
    const responses = await pending;
    const sessions = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<SessionResponse>;

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(sessions[1]).toMatchObject({
      objectId: sessions[0]!.objectId,
      cleanupToken: sessions[0]!.cleanupToken,
      expiresAt: sessions[0]!.expiresAt,
      uploadHeaders: sessions[0]!.uploadHeaders,
    });
    expect(control.rateFetchCount()).toBe(1);
  });

  it('does not touch proof, room quota, or R2 after the atomic rate limit denies a v3 proof', async () => {
    const token = await createCapabilityToken();
    const control = createAtomicRateControlBinding();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '64',
      MUSIXQUARE_SERVICE_CONTROL: control.binding,
      IP_UPLOADS_PER_WINDOW: '1',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    const createSession = (requestId: string, actorId: string) =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body: sessionRequestBody({ requestId, actorId }),
        }),
        workerEnv,
      );

    const first = await createSession(`rs3_${'F'.repeat(43)}`, `rsa_${'F'.repeat(43)}`);
    expect(first.status).toBe(200);
    const quotaGet = vi.spyOn(namespace, 'get');
    bucket.put.mockClear();
    const deniedRequestId = `rs3_${'G'.repeat(43)}`;
    const deniedActorId = `rsa_${'G'.repeat(43)}`;

    const denied = await createSession(deniedRequestId, deniedActorId);

    expect(denied.status).toBe(429);
    await expect(denied.json()).resolves.toMatchObject({ error: 'rate limited' });
    expect(quotaGet).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(
      namespace.instance(await sessionProofObjectName(deniedRequestId, deniedActorId)).storage
        .values.size,
    ).toBe(0);
  });

  it('does not touch proof, room quota, or R2 when the atomic rate limiter is unavailable', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const control = createAtomicRateControlBinding();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '64',
      MUSIXQUARE_SERVICE_CONTROL: {
        idFromName: control.binding.idFromName,
        get: (id: string) => {
          const stub = control.binding.get(id);
          return {
            fetch: async (rateRequest: Request) => {
              if (new URL(rateRequest.url).pathname === '/internal/abuse-rate/v2/consume') {
                throw new Error('rate control unavailable');
              }
              return stub.fetch(rateRequest);
            },
          };
        },
      },
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    const quotaGet = vi.spyOn(namespace, 'get');
    const requestId = `rs3_${'H'.repeat(43)}`;
    const actorId = `rsa_${'H'.repeat(43)}`;

    const unavailable = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody({ requestId, actorId }),
      }),
      workerEnv,
    );

    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: 'rate limit unavailable' });
    expect(quotaGet).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(
      namespace.instance(await sessionProofObjectName(requestId, actorId)).storage.values.size,
    ).toBe(0);
  });

  it('enforces the exact whole-object schema and positive stored size at /session', async () => {
    const token = await createCapabilityToken();
    for (const body of [
      sessionRequestBody({ queueItemId: 'not-a-queue-item-id' }),
      sessionRequestBody({ size: 0 }),
      sessionRequestBody({ size: 4, storedSize: 20 }),
      sessionRequestBody({ size: 200 * 1024 * 1024 + 1 }),
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

  it('accepts the exact 200 MiB whole-object boundary without widening it', async () => {
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
        body: sessionRequestBody({ size: maxBytes }),
      }),
      directUploadEnv(),
    );

    expect(response.status).toBe(200);
  });

  it('fails closed when quota is enabled without its Durable Object binding', async () => {
    const token = await createCapabilityToken();
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
        REMOTE_SHARE_BUCKET: createQuotaBucket(),
        ROOM_STORAGE_QUOTA_BYTES: '32',
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'room storage quota unavailable' });
  });

  it('fails closed when quota response headers arrive but the JSON body stalls', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    vi.useFakeTimers();
    let quotaBodyReadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      quotaBodyReadStarted = resolve;
    });
    const cancel = vi.fn();
    let reserveCalls = 0;
    const quotaFetch = vi.fn(async (quotaRequest: Request) => {
      if (new URL(quotaRequest.url).pathname === '/release') {
        return Response.json({ released: false });
      }
      reserveCalls += 1;
      let pulls = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(new TextEncoder().encode('{'));
                quotaBodyReadStarted();
              }
              return new Promise<void>(() => {});
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const responsePromise = workerModule.default.fetch(
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
        REMOTE_SHARE_QUOTA: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: quotaFetch }),
        },
        ROOM_STORAGE_QUOTA_BYTES: '32',
      }),
    );
    let settled = false;
    void responsePromise.then(() => {
      settled = true;
    });

    await started;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'room storage quota unavailable' });
    expect(reserveCalls).toBe(1);
    expect(cancel).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(bucket.objects.size).toBe(1);
    expect([...bucket.objects.values()][0]).toMatchObject({
      size: 0,
      httpEtag: expect.stringMatching(/^"[^"]+"$/),
    });
  });

  it('serializes concurrent session reservations without changing the public response shape', async () => {
    const token = await createCapabilityToken();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: createQuotaBucket(),
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const createSession = (
      body = sessionRequestBody({
        requestId: `rs3_${'S'.repeat(43)}`,
        actorId: `rsa_${'S'.repeat(43)}`,
      }),
    ): Promise<Response> =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body,
        }),
        workerEnv,
      );

    const responses = await Promise.all([createSession(), createSession()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const payloads = (await Promise.all(responses.map((response) => response.json()))) as Record<
      string,
      unknown
    >[];
    expect(payloads[1]).toMatchObject({
      objectId: payloads[0]!.objectId,
      expiresAt: payloads[0]!.expiresAt,
      cleanupToken: payloads[0]!.cleanupToken,
      uploadHeaders: payloads[0]!.uploadHeaders,
    });

    const success = payloads[0]!;
    expect(Object.keys(success).sort()).toEqual(
      [
        'cleanupToken',
        'completeToken',
        'expiresAt',
        'objectId',
        'uploadHeaders',
        'uploadUrl',
        'uploadUrlExpiresAt',
      ].sort(),
    );
    expect(decodeSignedTokenPayload(success.completeToken)).toMatchObject({
      v: 1,
      quotaReservationVersion: 1,
      storageFormat: 'whole-object-v1',
      storedSize: 20,
    });
    expect(decodeSignedTokenPayload(success.cleanupToken)).toEqual({
      v: 1,
      kind: 'cleanup',
      aud: 'musixquare-remote-share',
      method: 'DELETE',
      roomId: '123456',
      objectId: success.objectId,
      key: `room/123456/${String(success.objectId)}`,
      iat: expect.any(Number),
      exp: success.expiresAt,
      nonce: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
  });

  it('durably replays one client requestId and rejects its reuse for different metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T00:00:00.000Z'));
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const control = createAtomicRateControlBinding();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '64',
      MUSIXQUARE_SERVICE_CONTROL: control.binding,
      IP_UPLOADS_PER_WINDOW: '1',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    const requestId = `rs3_${'A'.repeat(43)}`;
    const actorId = `rsa_${'A'.repeat(43)}`;
    const createSession = (overrides: Record<string, unknown> = {}) =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body: sessionRequestBody({ requestId, actorId, ...overrides }),
        }),
        workerEnv,
      );

    const first = await createSession();
    const firstPayload = await first.json();
    const replay = await createSession();

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      objectId: (firstPayload as Record<string, unknown>).objectId,
      expiresAt: (firstPayload as Record<string, unknown>).expiresAt,
      cleanupToken: (firstPayload as Record<string, unknown>).cleanupToken,
      uploadHeaders: (firstPayload as Record<string, unknown>).uploadHeaders,
    });
    const stored = namespace.instance('123456').storage.values.get('quota-state') as {
      reservations: Record<string, unknown>;
    };
    expect(Object.keys(stored.reservations)).toHaveLength(1);
    const serializedReceipt = JSON.stringify(stored);
    expect(serializedReceipt).not.toContain('uploadUrl');
    expect(serializedReceipt).not.toContain('completeToken');
    expect(serializedReceipt).not.toContain('X-Amz-Credential');
    expect(serializedReceipt).not.toContain(requestId);
    expect(serializedReceipt).not.toContain(actorId);
    expect(JSON.stringify(firstPayload)).not.toContain(requestId);
    expect(JSON.stringify(firstPayload)).not.toContain(actorId);
    const proofState = namespace
      .instance(await sessionProofObjectName(requestId, actorId))
      .storage.values.get('session-proof-state');
    expect(proofState).toMatchObject({
      v: 1,
      clientRequestId: expect.stringMatching(/^rs_[A-Za-z0-9_-]{43}$/),
      operationId: expect.stringMatching(/^rs_[A-Za-z0-9_-]{43}$/),
      expiresAt: (firstPayload as Record<string, unknown>).expiresAt,
    });
    expect(JSON.stringify(proofState)).not.toContain(requestId);
    expect(JSON.stringify(proofState)).not.toContain(actorId);
    expect(Object.values(stored.reservations)[0]).toMatchObject({
      uploadAuthorityExpiresAt: (firstPayload as Record<string, unknown>).uploadUrlExpiresAt,
    });

    const conflict = await createSession({ name: 'different.wav' });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: 'upload session request conflict' });
    const afterConflict = namespace.instance('123456').storage.values.get('quota-state') as {
      reservations: Record<string, unknown>;
    };
    expect(Object.keys(afterConflict.reservations)).toHaveLength(1);

    const crossRoomConflict = await createSession({ roomId: '654321' });
    expect(crossRoomConflict.status).toBe(409);
    await expect(crossRoomConflict.json()).resolves.toEqual({
      error: 'upload session request conflict',
    });
    expect(bucket.objects.size).toBe(1);
  });

  it('expires the room-independent proof fence at the session deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T00:00:00.000Z'));
    const token = await createCapabilityToken();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: createQuotaBucket(),
      ROOM_STORAGE_QUOTA_BYTES: '64',
      OBJECT_TTL_SECONDS: '10',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    const requestId = `rs3_${'I'.repeat(43)}`;
    const actorId = `rsa_${'I'.repeat(43)}`;

    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: sessionRequestBody({ requestId, actorId }),
      }),
      workerEnv,
    );
    const session = (await response.json()) as SessionResponse;
    const proofInstance = namespace.instance(await sessionProofObjectName(requestId, actorId));

    expect(response.status).toBe(200);
    expect(proofInstance.storage.alarmAt).toBe(session.expiresAt);
    vi.setSystemTime(session.expiresAt + 1);
    await proofInstance.object.alarm();
    expect(proofInstance.storage.values.has('session-proof-state')).toBe(false);
    expect(proofInstance.storage.alarmAt).toBeNull();
  });

  it('rolls back a new proof when its first alarm cannot be scheduled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T00:00:00.000Z'));
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '64',
      OBJECT_TTL_SECONDS: '10',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    const requestId = `rs3_${'K'.repeat(43)}`;
    const actorId = `rsa_${'K'.repeat(43)}`;
    const proofInstance = namespace.instance(await sessionProofObjectName(requestId, actorId));
    vi.spyOn(proofInstance.storage, 'setAlarm').mockRejectedValueOnce(
      new Error('temporary proof alarm outage'),
    );
    const createSession = () =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body: sessionRequestBody({ requestId, actorId }),
        }),
        workerEnv,
      );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const failed = await createSession();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'room storage quota unavailable' });
    expect(proofInstance.storage.values.has('session-proof-state')).toBe(false);
    expect(proofInstance.storage.alarmAt).toBeNull();
    expect(bucket.objects.size).toBe(0);

    const recovered = await createSession();
    const session = (await recovered.json()) as SessionResponse;
    expect(recovered.status).toBe(200);
    expect(proofInstance.storage.values.get('session-proof-state')).toMatchObject({
      expiresAt: session.expiresAt,
    });
    expect(proofInstance.storage.alarmAt).toBe(session.expiresAt);
    warn.mockRestore();
  });

  it('extends the proof fence through a delayed exact retry after setup fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T00:00:00.000Z'));
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    bucket.put.mockResolvedValueOnce({
      key: 'malformed-placeholder-result',
      size: 0,
      customMetadata: {},
      etag: '',
      httpEtag: '',
    });
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '64',
      OBJECT_TTL_SECONDS: '10',
      UPLOAD_TOKEN_TTL_SECONDS: '10',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    const requestId = `rs3_${'J'.repeat(43)}`;
    const actorId = `rsa_${'J'.repeat(43)}`;
    const createSession = (overrides: Record<string, unknown> = {}) =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body: sessionRequestBody({ requestId, actorId, ...overrides }),
        }),
        workerEnv,
      );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const failed = await createSession();
    const proofInstance = namespace.instance(await sessionProofObjectName(requestId, actorId));
    const initialProof = proofInstance.storage.values.get('session-proof-state') as {
      expiresAt: number;
    };

    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'room storage quota unavailable' });
    expect(bucket.objects.size).toBe(0);

    vi.setSystemTime(Date.now() + 9_000);
    vi.spyOn(proofInstance.storage, 'setAlarm').mockRejectedValueOnce(
      new Error('temporary replay alarm outage'),
    );
    const delayed = await createSession();
    const extendedAfterAlarmFailure = proofInstance.storage.values.get('session-proof-state') as {
      expiresAt: number;
    };

    expect(delayed.status).toBe(503);
    expect(await delayed.json()).toEqual({ error: 'room storage quota unavailable' });
    expect(extendedAfterAlarmFailure.expiresAt).toBeGreaterThan(initialProof.expiresAt);
    expect(proofInstance.storage.alarmAt).toBe(initialProof.expiresAt);

    vi.setSystemTime(initialProof.expiresAt + 1);
    await proofInstance.object.alarm();
    expect(proofInstance.storage.values.get('session-proof-state')).toMatchObject({
      expiresAt: extendedAfterAlarmFailure.expiresAt,
    });
    expect(proofInstance.storage.alarmAt).toBe(extendedAfterAlarmFailure.expiresAt);

    const retried = await createSession();
    const session = (await retried.json()) as SessionResponse;
    expect(retried.status).toBe(200);
    expect(session.expiresAt).toBeGreaterThan(extendedAfterAlarmFailure.expiresAt);
    expect(proofInstance.storage.values.get('session-proof-state')).toMatchObject({
      expiresAt: session.expiresAt,
    });
    expect(proofInstance.storage.alarmAt).toBe(session.expiresAt);

    const crossRoomConflict = await createSession({
      roomId: '654321',
      name: 'different.wav',
    });
    expect(crossRoomConflict.status).toBe(409);
    await expect(crossRoomConflict.json()).resolves.toEqual({
      error: 'upload session request conflict',
    });
    expect(bucket.objects.size).toBe(1);
    warn.mockRestore();
  });

  it('replays one private v3 actor across token/IP rotation but isolates another actor', async () => {
    const firstIp = CLIENT_IP;
    const secondIp = '203.0.113.8';
    const firstToken = await createCapabilityToken(['remote-share'], {
      ip: firstIp,
      jti: 'first-browser',
    });
    const sameIpDifferentToken = await createCapabilityToken(['remote-share'], {
      ip: firstIp,
      jti: 'same-nat-second-browser',
    });
    const secondIpToken = await createCapabilityToken(['remote-share'], {
      ip: secondIp,
      jti: 'different-network-browser',
    });
    const control = createAtomicRateControlBinding();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: createQuotaBucket(),
      ROOM_STORAGE_QUOTA_BYTES: '80',
      MUSIXQUARE_SERVICE_CONTROL: control.binding,
      IP_UPLOADS_PER_WINDOW: '2',
    });
    const firstActorBody = sessionRequestBody({
      requestId: `rs3_${'V'.repeat(43)}`,
      actorId: `rsa_${'V'.repeat(43)}`,
    });
    const secondActorBody = sessionRequestBody({
      requestId: `rs3_${'W'.repeat(43)}`,
      actorId: `rsa_${'W'.repeat(43)}`,
    });
    const createSession = (token: string, ip: string, body = firstActorBody) =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': ip,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body,
        }),
        workerEnv,
      );

    const firstResponse = await createSession(firstToken, firstIp);
    const first = (await firstResponse.json()) as SessionResponse;
    const exactReplayResponse = await createSession(firstToken, firstIp);
    const exactReplay = (await exactReplayResponse.json()) as SessionResponse;
    const sameIpOtherResponse = await createSession(sameIpDifferentToken, firstIp);
    const sameIpOther = (await sameIpOtherResponse.json()) as SessionResponse;
    const otherIpResponse = await createSession(secondIpToken, secondIp);
    const otherIp = (await otherIpResponse.json()) as SessionResponse;
    const otherActorResponse = await createSession(firstToken, firstIp, secondActorBody);
    const otherActor = (await otherActorResponse.json()) as SessionResponse;

    expect([
      firstResponse.status,
      exactReplayResponse.status,
      sameIpOtherResponse.status,
      otherIpResponse.status,
      otherActorResponse.status,
    ]).toEqual([200, 200, 200, 200, 200]);
    for (const replay of [exactReplay, sameIpOther, otherIp]) {
      expect(replay).toMatchObject({
        objectId: first.objectId,
        cleanupToken: first.cleanupToken,
        expiresAt: first.expiresAt,
      });
    }
    expect(otherActor.objectId).not.toBe(first.objectId);
    expect(otherActor.cleanupToken).not.toBe(first.cleanupToken);
    expect(otherActor.completeToken).not.toBe(first.completeToken);
    expect(otherActor.uploadUrl).not.toBe(first.uploadUrl);
    // Each request reaches the atomic limiter, while the private proof receipt
    // makes all four first-actor calls one idempotent rate operation.
    expect(control.rateFetchCount()).toBe(5);
  });

  it('accepts cached v2 request IDs without making them replay-authoritative', async () => {
    const token = await createCapabilityToken(['remote-share'], { jti: 'cached-v2-browser' });
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: createQuotaBucket(),
      ROOM_STORAGE_QUOTA_BYTES: '64',
    });
    const body = sessionRequestBody({ requestId: `rs_${'V'.repeat(43)}` });
    const createSession = () =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body,
        }),
        workerEnv,
      );

    const firstResponse = await createSession();
    const secondResponse = await createSession();
    const first = (await firstResponse.json()) as SessionResponse;
    const second = (await secondResponse.json()) as SessionResponse;

    expect([firstResponse.status, secondResponse.status]).toEqual([200, 200]);
    expect(second.objectId).not.toBe(first.objectId);
    expect(second.cleanupToken).not.toBe(first.cleanupToken);
    expect(second.completeToken).not.toBe(first.completeToken);
  });

  it('accepts six-field cached clients without making public metadata replay-authoritative', async () => {
    const token = await createCapabilityToken(['remote-share'], { jti: 'legacy-browser' });
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: createQuotaBucket(),
      ROOM_STORAGE_QUOTA_BYTES: '64',
    });
    const createSession = () =>
      workerModule.default.fetch(
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

    const firstResponse = await createSession();
    const secondResponse = await createSession();
    const first = (await firstResponse.json()) as SessionResponse;
    const second = (await secondResponse.json()) as SessionResponse;

    expect([firstResponse.status, secondResponse.status]).toEqual([200, 200]);
    expect(second.objectId).not.toBe(first.objectId);
    expect(second.cleanupToken).not.toBe(first.cleanupToken);
    expect(second.completeToken).not.toBe(first.completeToken);
  });

  it('fences a late direct PUT with the exact zero-byte placeholder ETag', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T00:00:00.000Z'));
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '64',
      OBJECT_TTL_SECONDS: '1',
    });
    const createSession = (suffix: string) =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body: sessionRequestBody({
            requestId: `rs3_${suffix.repeat(43)}`,
            actorId: `rsa_${suffix.repeat(43)}`,
          }),
        }),
        workerEnv,
      );

    const firstResponse = await createSession('P');
    const first = (await firstResponse.json()) as SessionResponse;
    const firstKey = `room/123456/${first.objectId}`;
    const firstPlaceholder = bucket.objects.get(firstKey);

    expect(firstResponse.status).toBe(200);
    expect(first.uploadHeaders['if-match']).toBe(firstPlaceholder?.httpEtag);
    expect(firstPlaceholder).toMatchObject({
      size: 0,
      customMetadata: { formatVersion: 'whole-object-upload-placeholder-v1' },
    });
    expect(new URL(first.uploadUrl).searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain(
      'if-match',
    );

    vi.setSystemTime(Date.now() + 1_001);
    const nextResponse = await createSession('Q');
    expect(nextResponse.status).toBe(200);
    expect(bucket.objects.has(firstKey)).toBe(false);

    // Model the commit point of a PUT that began before expiry. R2's signed
    // If-Match precondition is checked against current object state, so the
    // deleted placeholder ETag cannot recreate the expired object afterward.
    const lateCommit = await bucket.put(firstKey, new Uint8Array(20), {
      onlyIf: { etagMatches: first.uploadHeaders['if-match'] },
    });
    expect(lateCommit).toBeNull();
    expect(bucket.objects.has(firstKey)).toBe(false);
  });

  it('fails closed on a malformed active replay receipt and self-heals after expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T00:00:00.000Z'));
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: createQuotaBucket(),
      ROOM_STORAGE_QUOTA_BYTES: '64',
      OBJECT_TTL_SECONDS: '10',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    const body = sessionRequestBody({
      requestId: `rs3_${'D'.repeat(43)}`,
      actorId: `rsa_${'D'.repeat(43)}`,
    });
    const createSession = async () =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': await createCapabilityToken(),
          },
          body,
        }),
        workerEnv,
      );

    const firstResponse = await createSession();
    const first = (await firstResponse.json()) as SessionResponse;
    expect(firstResponse.status).toBe(200);
    const state = namespace.instance('123456').storage.values.get('quota-state') as {
      reservations: Record<string, Record<string, unknown>>;
    };
    state.reservations[first.objectId]!.uploadAuthorityExpiresAt = first.expiresAt + 1;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const corruptReplay = await createSession();
    expect(corruptReplay.status).toBe(503);
    await expect(corruptReplay.json()).resolves.toEqual({
      error: 'room storage quota unavailable',
    });

    vi.setSystemTime(first.expiresAt + 1);
    const recovered = await createSession();
    expect(recovered.status).toBe(200);
    expect(((await recovered.json()) as SessionResponse).objectId).not.toBe(first.objectId);
    warn.mockRestore();
  });

  it('replays a committed reservation through one idempotent rate operation', async () => {
    const token = await createCapabilityToken();
    const control = createAtomicRateControlBinding();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: createQuotaBucket(),
      ROOM_STORAGE_QUOTA_BYTES: '64',
      MUSIXQUARE_SERVICE_CONTROL: control.binding,
      IP_UPLOADS_PER_WINDOW: '1',
    });
    const body = sessionRequestBody({
      requestId: `rs3_${'B'.repeat(43)}`,
      actorId: `rsa_${'B'.repeat(43)}`,
    });
    const createSession = () =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body,
        }),
        workerEnv,
      );

    const first = await createSession();
    const replay = await createSession();

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(control.rateFetchCount()).toBe(2);
  });

  it('re-signs only inside the immutable initial PUT authority window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T00:00:00.000Z'));
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: createQuotaBucket(),
      ROOM_STORAGE_QUOTA_BYTES: '64',
      OBJECT_TTL_SECONDS: '3600',
      UPLOAD_TOKEN_TTL_SECONDS: '600',
    });
    const body = sessionRequestBody({
      requestId: `rs3_${'C'.repeat(43)}`,
      actorId: `rsa_${'C'.repeat(43)}`,
    });
    const createSession = async () => {
      const token = await createCapabilityToken();
      return workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body,
        }),
        workerEnv,
      );
    };

    const firstResponse = await createSession();
    const first = (await firstResponse.json()) as SessionResponse & {
      uploadUrl: string;
      uploadUrlExpiresAt: number;
      completeToken: string;
      cleanupToken: string;
    };
    vi.setSystemTime(Date.now() + 60_000);
    const replayResponse = await createSession();
    const replay = (await replayResponse.json()) as typeof first;

    expect(firstResponse.status).toBe(200);
    expect(replayResponse.status).toBe(200);
    expect(replay).toMatchObject({
      objectId: first.objectId,
      expiresAt: first.expiresAt,
      cleanupToken: first.cleanupToken,
    });
    expect(replay.uploadUrlExpiresAt).toBe(first.uploadUrlExpiresAt);
    expect(replay.uploadUrl).not.toBe(first.uploadUrl);
    expect(replay.completeToken).not.toBe(first.completeToken);

    vi.setSystemTime(first.uploadUrlExpiresAt + 1);
    const expiredReplay = await createSession();
    expect(expiredReplay.status).toBe(409);
    await expect(expiredReplay.json()).resolves.toEqual({
      error: 'upload session replay expired',
    });
  });

  it('rolls back a reservation when presigning cannot finish', async () => {
    const token = await createCapabilityToken();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: createQuotaBucket(),
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    delete workerEnv.R2_SECRET_ACCESS_KEY;

    const failed = await workerModule.default.fetch(
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

    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'r2 s3 config missing' });
    expect(namespace.instance('123456').storage.values.size).toBe(0);
    expect(namespace.instance('123456').storage.alarmAt).toBeNull();

    workerEnv.R2_SECRET_ACCESS_KEY = 'test-secret-access-key';
    const retried = await workerModule.default.fetch(
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
    expect(retried.status).toBe(200);
  });

  it('rolls back an ambiguous reserve commit when the Durable Object acknowledgement fails', async () => {
    const token = await createCapabilityToken();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: createQuotaBucket(),
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    const quotaInstance = namespace.instance('123456');
    vi.spyOn(quotaInstance.storage, 'setAlarm').mockRejectedValueOnce(
      new Error('alarm unavailable after storage put'),
    );

    const failed = await workerModule.default.fetch(
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

    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'room storage quota unavailable' });
    expect(quotaInstance.storage.values.size).toBe(0);
    expect(quotaInstance.storage.alarmAt).toBeNull();

    const retried = await workerModule.default.fetch(
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
    expect(retried.status).toBe(200);
  });

  it('retains the placeholder when ambiguous reserve and compensating release both fail', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    const quotaInstance = namespace.instance('123456');
    vi.spyOn(quotaInstance.storage, 'setAlarm').mockRejectedValueOnce(
      new Error('alarm unavailable after storage put'),
    );
    const originalGet = namespace.get;
    let rejectRelease = true;
    vi.spyOn(namespace, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        fetch: async (quotaRequest) => {
          if (rejectRelease && new URL(quotaRequest.url).pathname === '/release') {
            rejectRelease = false;
            throw new Error('compensating release unavailable');
          }
          return stub.fetch(quotaRequest);
        },
      };
    });
    const body = sessionRequestBody({
      requestId: `rs3_${'Y'.repeat(43)}`,
      actorId: `rsa_${'Y'.repeat(43)}`,
    });
    const createSession = () =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body,
        }),
        workerEnv,
      );

    const failed = await createSession();
    expect(failed.status).toBe(503);
    const stored = quotaInstance.storage.values.get('quota-state') as {
      reservations: Record<string, { objectId: string; uploadEtag: string }>;
    };
    const reservation = Object.values(stored.reservations)[0];
    expect(reservation).toMatchObject({
      objectId: expect.any(String),
      uploadEtag: expect.stringMatching(/^"[^"]+"$/),
    });
    expect(bucket.objects.get(`room/123456/${reservation.objectId}`)?.httpEtag).toBe(
      reservation.uploadEtag,
    );

    const retried = await createSession();
    const retriedPayload = (await retried.json()) as SessionResponse;
    expect(retried.status).toBe(200);
    expect(retriedPayload.objectId).toBe(reservation.objectId);
    expect(retriedPayload.uploadHeaders['if-match']).toBe(reservation.uploadEtag);
    expect(bucket.objects.size).toBe(1);
  });

  it('retains a usable placeholder when presigning and its compensating release both fail', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    const quotaInstance = namespace.instance('123456');
    const originalGet = namespace.get;
    let rejectRelease = true;
    vi.spyOn(namespace, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        fetch: async (quotaRequest) => {
          if (rejectRelease && new URL(quotaRequest.url).pathname === '/release') {
            rejectRelease = false;
            throw new Error('compensating release unavailable');
          }
          return stub.fetch(quotaRequest);
        },
      };
    });
    const configuredSecret = String(workerEnv.R2_SECRET_ACCESS_KEY);
    let secretReads = 0;
    Object.defineProperty(workerEnv, 'R2_SECRET_ACCESS_KEY', {
      configurable: true,
      enumerable: true,
      get() {
        secretReads += 1;
        if (secretReads === 2) throw new Error('presign unavailable after reserve');
        return configuredSecret;
      },
    });
    const body = sessionRequestBody({
      requestId: `rs3_${'P'.repeat(43)}`,
      actorId: `rsa_${'P'.repeat(43)}`,
    });
    const createSession = () =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body,
        }),
        workerEnv,
      );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const failed = await createSession();

    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: 'internal server error' });
    const stored = quotaInstance.storage.values.get('quota-state') as {
      reservations: Record<string, { objectId: string; uploadEtag: string }>;
    };
    const reservation = Object.values(stored.reservations)[0];
    expect(reservation).toMatchObject({
      objectId: expect.any(String),
      uploadEtag: expect.stringMatching(/^"[^"]+"$/),
    });
    expect(bucket.objects.get(`room/123456/${reservation.objectId}`)?.httpEtag).toBe(
      reservation.uploadEtag,
    );

    const retried = await createSession();
    const retriedPayload = (await retried.json()) as SessionResponse;
    expect(retried.status).toBe(200);
    expect(retriedPayload.objectId).toBe(reservation.objectId);
    expect(retriedPayload.uploadHeaders['if-match']).toBe(reservation.uploadEtag);
    expect(bucket.objects.size).toBe(1);
    warn.mockRestore();
    errorLog.mockRestore();
  });

  it('retains a reservation across cleanup and unexpected object reappearance until expiry', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const createSession = (body = sessionRequestBody()): Promise<Response> =>
      workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': token,
          },
          body,
        }),
        workerEnv,
      );
    const firstResponse = await createSession();
    const first = (await firstResponse.json()) as {
      cleanupToken: string;
      objectId: string;
      expiresAt: number;
    };
    expect(firstResponse.status).toBe(200);

    const cleanupBeforePut = await workerModule.default.fetch(
      request(`/object/123456/${first.objectId}`, {
        method: 'DELETE',
        headers: { 'x-mxqr-cleanup-token': first.cleanupToken },
      }),
      workerEnv,
    );
    expect(cleanupBeforePut.status).toBe(200);
    expect(await cleanupBeforePut.json()).toEqual({ ok: true });

    // Model an unexpected provider/operator write after cleanup. The canonical
    // client cannot do this because its signed If-Match no longer matches, but
    // the retained reservation remains a conservative second quota fence.
    const uploadedKey = `room/123456/${first.objectId}`;
    const lateUpload = quotaObject(uploadedKey, 20, first.expiresAt);
    lateUpload.customMetadata.cleanupToken = first.cleanupToken;
    bucket.objects.set(uploadedKey, lateUpload);

    bucket.head.mockClear();
    const wrongCleanup = await workerModule.default.fetch(
      request(`/object/123456/${first.objectId}`, {
        method: 'DELETE',
        headers: { 'x-mxqr-cleanup-token': crypto.randomUUID() },
      }),
      workerEnv,
    );
    expect(wrongCleanup.status).toBe(403);
    expect(bucket.head).not.toHaveBeenCalled();
    const competingSessionBody = sessionRequestBody({
      sessionId: 8,
      queueItemId: '10000000-0000-4000-8000-000000000002',
    });
    expect((await createSession(competingSessionBody)).status).toBe(409);

    const cleanup = await workerModule.default.fetch(
      request(`/object/123456/${first.objectId}`, {
        method: 'DELETE',
        headers: { 'x-mxqr-cleanup-token': first.cleanupToken },
      }),
      workerEnv,
    );
    expect(cleanup.status).toBe(200);
    expect(await cleanup.json()).toEqual({ ok: true });
    expect(bucket.objects.has(uploadedKey)).toBe(false);

    // Keep the reservation charged even after physical deletion, and continue
    // to account for any unexpected reappearance under the room prefix.
    expect((await createSession(competingSessionBody)).status).toBe(409);
    bucket.objects.set(uploadedKey, lateUpload);
    expect((await createSession(competingSessionBody)).status).toBe(409);
  });

  it('expires reservations and stale physical objects through the Durable Object alarm', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-07-22T00:00:00.000Z');
    vi.setSystemTime(startedAt);
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      OBJECT_TTL_SECONDS: '1',
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
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
      expiresAt: number;
      objectId: string;
    };
    expect(sessionResponse.status).toBe(200);
    bucket.objects.set(
      `room/123456/${session.objectId}`,
      quotaObject(`room/123456/${session.objectId}`, 20, session.expiresAt),
    );
    expect(namespace.instance('123456').storage.alarmAt).toBe(session.expiresAt);

    vi.setSystemTime(startedAt.getTime() + 1_001);
    await namespace.instance('123456').object.alarm();

    expect(bucket.objects.size).toBe(0);
    expect(namespace.instance('123456').storage.values.size).toBe(1);
    expect(namespace.instance('123456').storage.alarmAt).toBe(Date.now() + 60_000);

    // Natural expiry needs the same exact-key fence as explicit revocation:
    // a PUT may have started before its URL closed and finish after expiry.
    const lateKey = `room/123456/${session.objectId}`;
    bucket.objects.set(lateKey, quotaObject(lateKey, 20, session.expiresAt));
    vi.setSystemTime(Date.now() + 60_000);
    await namespace.instance('123456').object.alarm();
    expect(bucket.objects.size).toBe(0);
    const tombstoneState = namespace.instance('123456').storage.values.get('quota-state') as {
      reservations: Record<string, { tombstoneQuietSince: number }>;
    };
    expect(tombstoneState.reservations[session.objectId]?.tombstoneQuietSince).toBe(Date.now());

    vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
    await namespace.instance('123456').object.alarm();
    expect(namespace.instance('123456').storage.values.size).toBe(0);
    expect(namespace.instance('123456').storage.alarmAt).toBeNull();
  });

  it('reconciles a PUT committed after tombstone retirement before admitting new quota', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-07-22T00:00:00.000Z');
    vi.setSystemTime(startedAt);
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      OBJECT_TTL_SECONDS: '1',
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    const firstCapability = await createCapabilityToken();
    const firstResponse = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': firstCapability,
        },
        body: sessionRequestBody(),
      }),
      workerEnv,
    );
    const first = (await firstResponse.json()) as SessionResponse;
    const lateKey = `room/123456/${first.objectId}`;

    vi.setSystemTime(first.expiresAt + 1);
    await namespace.instance('123456').object.alarm();
    vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
    await namespace.instance('123456').object.alarm();
    expect(namespace.instance('123456').storage.values.size).toBe(0);

    // A PUT that began during its presigned start window can become visible
    // after the finite tombstone fence retired. The next admission scan must
    // remove that already-expired physical object before granting capacity.
    bucket.objects.set(lateKey, quotaObject(lateKey, 20, first.expiresAt));
    bucket.delete.mockClear();
    const freshCapability = await createCapabilityToken();
    const admitted = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': freshCapability,
        },
        body: sessionRequestBody(),
      }),
      workerEnv,
    );

    expect(admitted.status).toBe(200);
    expect(bucket.delete).toHaveBeenCalledWith([lateKey]);
    expect(bucket.objects.has(lateKey)).toBe(false);
  });

  it('keeps an expired reservation fail-closed when alarm cleanup must retry', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-07-22T00:00:00.000Z');
    vi.setSystemTime(startedAt);
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      OBJECT_TTL_SECONDS: '1',
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
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
      expiresAt: number;
      objectId: string;
    };
    const uploadedKey = `room/123456/${session.objectId}`;
    bucket.objects.set(uploadedKey, quotaObject(uploadedKey, 20, session.expiresAt));
    bucket.delete.mockRejectedValueOnce(new Error('temporary R2 outage'));

    vi.setSystemTime(startedAt.getTime() + 1_001);
    await namespace.instance('123456').object.alarm();

    expect(bucket.objects.has(uploadedKey)).toBe(true);
    expect(namespace.instance('123456').storage.values.size).toBe(1);
    expect(namespace.instance('123456').storage.alarmAt).toBe(Date.now() + 60_000);

    vi.setSystemTime(Date.now() + 60_000);
    await namespace.instance('123456').object.alarm();
    expect(bucket.objects.has(uploadedKey)).toBe(false);
    expect(namespace.instance('123456').storage.values.size).toBe(1);

    vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
    await namespace.instance('123456').object.alarm();
    expect(namespace.instance('123456').storage.values.size).toBe(0);
  });

  it('commits a validated object and retains its reservation after physical cleanup', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
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
        formatVersion: 'whole-object-v1',
        storedSize: '20',
        expiresAt: String(session.expiresAt),
        cleanupToken: session.cleanupToken,
      },
    });

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
    expect(complete.status).toBe(200);
    expect(Object.keys((await complete.json()) as object).sort()).toEqual(
      [
        'cleanupToken',
        'downloadToken',
        'downloadUrl',
        'expiresAt',
        'objectId',
        'storedSize',
      ].sort(),
    );
    const stored = namespace.instance('123456').storage.values.get('quota-state') as {
      reservations: Record<string, { status: string }>;
    };
    expect(stored.reservations[session.objectId]?.status).toBe('completed');

    const cleanup = await workerModule.default.fetch(
      request(`/object/123456/${session.objectId}`, {
        method: 'DELETE',
        headers: { 'x-mxqr-cleanup-token': session.cleanupToken },
      }),
      workerEnv,
    );
    expect(cleanup.status).toBe(200);
    expect(bucket.objects.has(uploadedKey)).toBe(false);
    expect(namespace.instance('123456').storage.values.size).toBe(1);
  });

  it('settles an issued atomic reservation after quota admission is disabled', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
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
        formatVersion: 'whole-object-v1',
        storedSize: '20',
        expiresAt: String(session.expiresAt),
        cleanupToken: session.cleanupToken,
      },
    });

    workerEnv.ROOM_STORAGE_QUOTA_BYTES = '0';
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

    expect(complete.status).toBe(200);
    const stored = namespace.instance('123456').storage.values.get('quota-state') as {
      reservations: Record<string, { status: string }>;
    };
    expect(stored.reservations[session.objectId]?.status).toBe('completed');
  });

  it('preserves a validated upload while the quota binding is temporarily unavailable', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
      REMOTE_SHARE_BUCKET: bucket,
      ROOM_STORAGE_QUOTA_BYTES: '32',
    });
    const namespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
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
        formatVersion: 'whole-object-v1',
        storedSize: '20',
        expiresAt: String(session.expiresAt),
        cleanupToken: session.cleanupToken,
      },
    });
    delete workerEnv.REMOTE_SHARE_QUOTA;
    const completeRequest = (): Promise<Response> =>
      workerModule.default.fetch(
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

    const unavailable = await completeRequest();
    expect(unavailable.status).toBe(503);
    expect(bucket.objects.has(uploadedKey)).toBe(true);

    workerEnv.REMOTE_SHARE_QUOTA = namespace;
    const retried = await completeRequest();
    expect(retried.status).toBe(200);
    expect(bucket.objects.has(uploadedKey)).toBe(true);
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
      directUploadQuotaEnv({
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
      directUploadQuotaEnv({
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
      directUploadQuotaEnv({
        REMOTE_SHARE_BUCKET: bucket,
        ROOM_STORAGE_QUOTA_BYTES: '32',
      }),
    );

    expect(response.status).toBe(409);
  });

  it('deletes a racing upload that exceeds the authoritative completion quota', async () => {
    const token = await createCapabilityToken();
    const bucket = createQuotaBucket();
    const workerEnv = directUploadQuotaEnv({
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
        formatVersion: 'whole-object-v1',
        storedSize: '20',
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
    const quotaNamespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
    expect(quotaNamespace.instance('123456').storage.values.size).toBe(1);
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
      directUploadQuotaEnv({
        REMOTE_SHARE_BUCKET: bucket,
        ROOM_STORAGE_QUOTA_BYTES: '32',
      }),
    );

    expect(response.status).toBe(200);
    // The canonical room prefix spans two bounded pages.
    expect(bucket.list).toHaveBeenCalledTimes(2);
    expect(bucket.delete).toHaveBeenCalledTimes(2);
    for (const [keys] of bucket.delete.mock.calls) {
      expect(Array.isArray(keys) ? keys.length : 1).toBeLessThanOrEqual(1000);
    }
    expect(bucket.objects.size).toBe(1);
    expect([...bucket.objects.values()][0]).toMatchObject({
      size: 0,
      customMetadata: { formatVersion: 'whole-object-upload-placeholder-v1' },
    });
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
      directUploadQuotaEnv({
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
      directUploadQuotaEnv({
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
          formatVersion: 'whole-object-v1',
          storedSize: '20',
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
          formatVersion: 'whole-object-v1',
          storedSize: '20',
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
            formatVersion: 'whole-object-v1',
            storedSize: '20',
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

  it('rejects unauthenticated downloads before reading object metadata', async () => {
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

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'DOWNLOAD_AUTHORIZATION_REQUIRED' });
    expect(bucket.get).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('never reads a valid whole object without a download bearer', async () => {
    const objectId = '00000000-0000-4000-8000-000000000001';
    const bucket = {
      get: vi.fn(async () => ({
        size: 20,
        body: new Uint8Array(20),
        customMetadata: {
          roomId: '123456',
          objectId,
          formatVersion: 'whole-object-v1',
          storedSize: '20',
          expiresAt: String(Date.now() + 60_000),
        },
      })),
      delete: vi.fn(async () => undefined),
    };
    const response = await workerModule.default.fetch(
      request(`/download/123456/${objectId}`),
      env({ REMOTE_SHARE_BUCKET: bucket }),
    );

    expect(response.status).toBe(401);
    expect(bucket.get).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  describe('canonical whole-object transport', () => {
    it('requires the exact canonical session schema', async () => {
      const capability = await createCapabilityToken();
      const bucket = createQuotaBucket();
      const workerEnv = directUploadQuotaEnv({
        REMOTE_SHARE_BUCKET: bucket,
        ROOM_STORAGE_QUOTA_BYTES: '32',
      });
      for (const body of [
        sessionRequestBody({ unexpected: true }),
        sessionRequestBody({ storageFormat: 'retired' }),
      ]) {
        const response = await workerModule.default.fetch(
          request('/session', {
            method: 'POST',
            headers: {
              'cf-connecting-ip': CLIENT_IP,
              'content-type': 'application/json',
              'x-mxqr-capability': capability,
            },
            body,
          }),
          workerEnv,
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: 'invalid upload session request',
        });
      }
      expect(bucket.list).not.toHaveBeenCalled();
    });

    it('uses neutral storage, settles exact-byte quota, and issues a scoped read bearer', async () => {
      const { complete, key, session, workerEnv } = await createCompletedObject();

      expect(new URL(session.uploadUrl).pathname).toContain(
        `/test-bucket/room/123456/${session.objectId}`,
      );
      expect(session.uploadHeaders).toMatchObject({
        'content-type': 'application/octet-stream',
        'x-amz-meta-format-version': 'whole-object-v1',
        'x-amz-meta-stored-size': '4',
      });
      expect(complete).toEqual({
        downloadToken: expect.any(String),
        downloadUrl: `https://share.musixquare.com/download/123456/${session.objectId}`,
        objectId: session.objectId,
        storedSize: 4,
        expiresAt: session.expiresAt,
        cleanupToken: session.cleanupToken,
      });
      expect(new URL(complete.downloadUrl).search).toBe('');

      const tokenPayload = decodeSignedTokenPayload(complete.downloadToken);
      expect(tokenPayload).toEqual({
        v: 1,
        kind: 'download',
        aud: 'musixquare-remote-share',
        method: 'GET',
        roomId: '123456',
        objectId: session.objectId,
        key,
        storedSize: 4,
        storageFormat: 'whole-object-v1',
        iat: expect.any(Number),
        exp: session.expiresAt,
      });
      expect(JSON.stringify(tokenPayload)).not.toContain(session.cleanupToken);

      const quotaNamespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
      const stored = quotaNamespace.instance('123456').storage.values.get('quota-state') as {
        reservations: Record<
          string,
          { objectKey: string; storedSize: number; status: string; cleanupToken: string }
        >;
      };
      expect(stored.reservations[session.objectId]).toMatchObject({
        objectKey: key,
        storedSize: 4,
        status: 'completed',
        cleanupToken: session.cleanupToken,
      });
    });

    it('authenticates before R2, rejects query credentials and Range, then streams one full object', async () => {
      const { complete, get, session, workerEnv } = await createCompletedObject();
      const path = `/download/123456/${session.objectId}`;

      const missing = await workerModule.default.fetch(request(path), workerEnv);
      expect(missing.status).toBe(401);
      expect(get).not.toHaveBeenCalled();

      const queryOnly = await workerModule.default.fetch(
        request(`${path}?token=${encodeURIComponent(complete.downloadToken)}`),
        workerEnv,
      );
      expect(queryOnly.status).toBe(400);
      expect(get).not.toHaveBeenCalled();

      const tokenPayload = decodeSignedTokenPayload(complete.downloadToken);
      const wrongPurposeToken = await signTestToken(tokenPayload);
      const wrongPurpose = await workerModule.default.fetch(
        request(path, { headers: { authorization: `Bearer ${wrongPurposeToken}` } }),
        workerEnv,
      );
      expect(wrongPurpose.status).toBe(401);
      expect(get).not.toHaveBeenCalled();

      const wrongObject = await workerModule.default.fetch(
        request('/download/123456/00000000-0000-4000-8000-000000000099', {
          headers: { authorization: `Bearer ${complete.downloadToken}` },
        }),
        workerEnv,
      );
      expect(wrongObject.status).toBe(401);
      expect(get).not.toHaveBeenCalled();

      const ranged = await workerModule.default.fetch(
        request(path, {
          headers: {
            authorization: `Bearer ${complete.downloadToken}`,
            range: 'bytes=0-0',
          },
        }),
        workerEnv,
      );
      expect(ranged.status).toBe(416);
      expect(await ranged.json()).toMatchObject({ code: 'RANGE_NOT_SUPPORTED' });
      expect(get).not.toHaveBeenCalled();

      const downloaded = await workerModule.default.fetch(
        request(path, { headers: { authorization: `Bearer ${complete.downloadToken}` } }),
        workerEnv,
      );
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('cache-control')).toBe('no-store');
      expect(downloaded.headers.get('accept-ranges')).toBe('none');
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(get).toHaveBeenCalledTimes(1);

      get.mockClear();
      vi.useFakeTimers();
      vi.setSystemTime(complete.expiresAt + 1);
      const expired = await workerModule.default.fetch(
        request(path, { headers: { authorization: `Bearer ${complete.downloadToken}` } }),
        workerEnv,
      );
      expect(expired.status).toBe(401);
      expect(get).not.toHaveBeenCalled();
    });

    it('keeps cleanup authority separate and deletes only the exact object incarnation', async () => {
      const { bucket, complete, key, session, workerEnv } = await createCompletedObject();
      const path = `/object/123456/${session.objectId}`;

      bucket.head.mockClear();
      const forbidden = await workerModule.default.fetch(
        request(path, {
          method: 'DELETE',
          headers: { 'x-mxqr-cleanup-token': crypto.randomUUID() },
        }),
        workerEnv,
      );
      expect(forbidden.status).toBe(403);
      expect(bucket.head).not.toHaveBeenCalled();
      expect(bucket.objects.has(key)).toBe(true);

      const wrongPurpose = await workerModule.default.fetch(
        request(path, {
          method: 'DELETE',
          headers: { 'x-mxqr-cleanup-token': complete.downloadToken },
        }),
        workerEnv,
      );
      expect(wrongPurpose.status).toBe(403);
      expect(bucket.head).not.toHaveBeenCalled();

      const deleted = await workerModule.default.fetch(
        request(path, {
          method: 'DELETE',
          headers: { 'x-mxqr-cleanup-token': complete.cleanupToken },
        }),
        workerEnv,
      );
      expect(deleted.status).toBe(200);
      expect(bucket.head).toHaveBeenCalledTimes(1);
      expect(await deleted.json()).toEqual({ ok: true });
      expect(bucket.objects.has(key)).toBe(false);
      expect(bucket.objects.has(`room/123456/${session.objectId}`)).toBe(false);
      const quotaNamespace = workerEnv.REMOTE_SHARE_QUOTA as FakeQuotaNamespace;
      const stored = quotaNamespace.instance('123456').storage.values.get('quota-state') as {
        reservations: Record<string, unknown>;
      };
      // The reservation remains charged until fixed expiry as a second fence,
      // even though deleting the key invalidates the canonical If-Match PUT.
      expect(stored.reservations).toHaveProperty(session.objectId);
    });

    it('counts every object under the canonical room prefix against one quota', async () => {
      const capability = await createCapabilityToken();
      const bucket = createQuotaBucket([
        quotaObject('room/123456/object-a', 16),
        quotaObject('room/123456/object-b', 16),
      ]);
      const response = await workerModule.default.fetch(
        request('/session', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': CLIENT_IP,
            'content-type': 'application/json',
            'x-mxqr-capability': capability,
          },
          body: sessionRequestBody({ size: 1 }),
        }),
        directUploadQuotaEnv({
          REMOTE_SHARE_BUCKET: bucket,
          ROOM_STORAGE_QUOTA_BYTES: '32',
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'ROOM_STORAGE_QUOTA_EXCEEDED' });
      expect(bucket.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'room/123456/' }));
      expect(bucket.list).toHaveBeenCalledTimes(1);
    });
  });
});
