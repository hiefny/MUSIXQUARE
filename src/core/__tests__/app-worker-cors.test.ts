import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import appWorker from '../../../cloudflare/app-worker.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function requestWithOrigin(origin: string): Request {
  return new Request('https://musixquare.com/api/get-turn-config', {
    headers: { Origin: origin },
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeTokenPayload(token: string): Record<string, unknown> {
  const encoded = token.split('.')[0] || '';
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))),
  ) as Record<string, unknown>;
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))),
  );
}

async function signCapabilityToken(secret: string, ip: string, scopes: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    scopes,
    iat: now,
    exp: now + 600,
    ip: await hmacSha256(secret, `ip:${ip}`),
  };
  const payloadPart = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${payloadPart}.${await hmacSha256(secret, payloadPart)}`;
}

async function solveProofOfWork(challenge: string, difficulty: number): Promise<string> {
  const encoder = new TextEncoder();
  for (let solution = 0; solution < 10_000_000; solution += 1) {
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(`mxqr-pow-v1:${challenge}:${solution}`)),
    );
    let remaining = difficulty;
    let valid = true;
    for (const byte of digest) {
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

async function requestProofOfWork(
  env: Record<string, unknown>,
  scopes: string[],
  ip: string,
): Promise<{ challenge: string; solution: string; expiresAt: number; difficulty: number }> {
  const response = await appWorker.fetch(
    new Request('https://musixquare.com/api/capability-challenge', {
      method: 'POST',
      headers: {
        Origin: 'https://musixquare.com',
        'Content-Type': 'application/json',
        'CF-Connecting-IP': ip,
      },
      body: JSON.stringify({ scopes }),
    }),
    env,
  );
  const payload = (await response.json()) as {
    challenge: string;
    expiresAt: number;
    difficulty: number;
  };
  expect(response.status).toBe(200);
  return {
    ...payload,
    solution: await solveProofOfWork(payload.challenge, payload.difficulty),
  };
}

async function mintWithProofOfWork(
  env: Record<string, unknown>,
  scopes: string[],
  ip: string,
  proof?: { challenge: string; solution: string },
): Promise<Response> {
  const resolvedProof = proof || (await requestProofOfWork(env, scopes, ip));
  return appWorker.fetch(
    new Request('https://musixquare.com/api/capability-token', {
      method: 'POST',
      headers: {
        Origin: 'https://musixquare.com',
        'Content-Type': 'application/json',
        'CF-Connecting-IP': ip,
      },
      body: JSON.stringify({ scopes, proofOfWork: resolvedProof }),
    }),
    env,
  );
}

describe('Cloudflare app worker CORS gate', () => {
  it('keeps workers.dev and preview URL exposure disabled in production config', async () => {
    const wrangler = await readFile(
      new URL('../../../cloudflare/wrangler.app.toml', import.meta.url),
      'utf8',
    );

    expect(wrangler).toMatch(/^workers_dev\s*=\s*false$/m);
    expect(wrangler).toMatch(/^preview_urls\s*=\s*false$/m);
    expect(wrangler).not.toMatch(/^MXQR_ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK\s*=\s*true$/m);
  });

  it('rejects broad Cloudflare preview origins by default', async () => {
    const pagesResponse = await appWorker.fetch(
      requestWithOrigin('https://random-preview.pages.dev'),
      {},
    );
    const workersResponse = await appWorker.fetch(
      requestWithOrigin('https://random-worker.workers.dev'),
      {},
    );

    expect(pagesResponse.status).toBe(403);
    expect(pagesResponse.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(workersResponse.status).toBe(403);
    expect(workersResponse.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows production, subdomain, local, and Toss origins', async () => {
    const origins = [
      'https://musixquare.com',
      'https://preview.musixquare.com',
      'http://localhost:3000',
      'https://musixquare.apps.tossmini.com',
      'https://toss.im',
      'https://toss-internal.com',
      'https://tossmini.com',
    ];

    for (const origin of origins) {
      const response = await appWorker.fetch(requestWithOrigin(origin), {});

      expect(response.status).not.toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }
  });

  it('allows exact configured preview origins only', async () => {
    const env = {
      TRUSTED_CORS_ORIGINS:
        'https://musixquare-review.pages.dev, https://musixquare-app.example.workers.dev',
    };

    const allowed = await appWorker.fetch(
      requestWithOrigin('https://musixquare-review.pages.dev'),
      env,
    );
    const denied = await appWorker.fetch(requestWithOrigin('https://other-review.pages.dev'), env);

    expect(allowed.status).not.toBe(403);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://musixquare-review.pages.dev',
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('sets anti-framing and same-origin form CSP directives on Worker responses', async () => {
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/security-config', {
        headers: { Origin: 'https://musixquare.com' },
      }),
      {},
    );
    const csp = response.headers.get('Content-Security-Policy') || '';

    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('Cloudflare app worker sensitive endpoint rate limit', () => {
  function installRateLimitCache() {
    const store = new Map<string, string>();
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async (request: Request) => {
          const value = store.get(request.url);
          return value === undefined ? undefined : new Response(value);
        }),
        put: vi.fn(async (request: Request, response: Response) => {
          store.set(request.url, await response.text());
        }),
      },
    });
  }

  function createAtomicRateLimitDb() {
    const buckets = new Map<string, { window: number; count: number }>();
    return {
      bucketKeys: buckets,
      prepare: vi.fn((sql: string) => {
        if (sql.includes('CREATE TABLE IF NOT EXISTS mxqr_api_rate_limits')) {
          return { run: vi.fn(async () => ({ success: true })) };
        }
        if (sql.includes('INSERT INTO mxqr_api_rate_limits')) {
          return {
            bind: vi.fn((key: string, window: number, _expiresAt: number, limit: number) => ({
              first: vi.fn(async () => {
                const current = buckets.get(key);
                if (current?.window === window && current.count >= limit) return null;
                const count = current?.window === window ? current.count + 1 : 1;
                buckets.set(key, { window, count });
                return { count };
              }),
            })),
          };
        }
        if (sql.includes('DELETE FROM mxqr_api_rate_limits')) {
          return {
            bind: vi.fn(() => ({ run: vi.fn(async () => ({ success: true })) })),
          };
        }
        throw new Error(`unexpected statement: ${sql}`);
      }),
    };
  }

  it('fails closed for paid endpoints when capability auth is not configured', async () => {
    const env = {
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
    };

    const requests = [
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: {
          Origin: 'https://musixquare.com',
          'CF-Connecting-IP': '203.0.113.19',
        },
      }),
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: {
          Host: 'musixquare.com',
          'Sec-Fetch-Site': 'same-origin',
          'CF-Connecting-IP': '203.0.113.19',
        },
      }),
    ];

    for (const request of requests) {
      const response = await appWorker.fetch(request, env);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'CAPABILITY_NOT_CONFIGURED' });
    }
  });

  it('allows legacy unguarded paid endpoints only with an explicit opt-in', async () => {
    const env = {
      MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
    };

    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: {
          Origin: 'https://musixquare.com',
          'CF-Connecting-IP': '203.0.113.18',
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({
      provider: 'metered-fallback',
    });
  });

  it('uses the atomic D1 coordinator for concurrent paid-resource requests', async () => {
    const env = {
      MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
      MXQR_RATE_LIMIT_HASH_SECRET: 'test-rate-limit-hash-secret-at-least-32-bytes',
      MUSIXQUARE_ADMIN_DB: createAtomicRateLimitDb(),
    };
    const responses = await Promise.all(
      Array.from({ length: 61 }, () =>
        appWorker.fetch(
          new Request('https://musixquare.com/api/get-turn-config', {
            headers: {
              Origin: 'https://musixquare.com',
              'CF-Connecting-IP': '203.0.113.91',
            },
          }),
          env,
        ),
      ),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(60);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  });

  it('stores only an HMAC-pseudonymous IP bucket and deletes expired rows', async () => {
    const ip = '203.0.113.191';
    const db = createAtomicRateLimitDb();
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: { Origin: 'https://musixquare.com', 'CF-Connecting-IP': ip },
      }),
      {
        MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
        MXQR_RATE_LIMIT_HASH_SECRET: 'test-rate-limit-hash-secret-at-least-32-bytes',
        TURN_USER: 'turn-user',
        TURN_PASS: 'turn-pass',
        MUSIXQUARE_ADMIN_DB: db,
      },
    );

    expect(response.status).toBe(200);
    const [bucketKey] = [...db.bucketKeys.keys()];
    expect(bucketKey).toMatch(/^turn-config\u001f[A-Za-z0-9_-]{43}$/);
    expect(bucketKey).not.toContain(ip);
    expect(db.prepare).toHaveBeenCalledWith(
      'DELETE FROM mxqr_api_rate_limits WHERE expires_at < ?',
    );
  });

  it('rejects cross-site requests before touching the authenticated quota bucket', async () => {
    const db = createAtomicRateLimitDb();
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: {
          Origin: 'https://attacker.example',
          'CF-Connecting-IP': '203.0.113.92',
        },
      }),
      {
        MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
        MUSIXQUARE_ADMIN_DB: db,
      },
    );

    expect(response.status).toBe(403);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('requires a capability token when capability auth is enabled', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
    };

    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: {
          Origin: 'https://musixquare.com',
          'CF-Connecting-IP': '203.0.113.20',
        },
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'CAPABILITY_REQUIRED' });
  });

  it('fails closed when a configured capability HMAC secret is shorter than 32 bytes', async () => {
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: { Origin: 'https://musixquare.com' },
      }),
      {
        MXQR_CAPABILITY_SECRET: 'weak-secret',
        TURN_USER: 'turn-user',
        TURN_PASS: 'turn-pass',
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'CAPABILITY_NOT_CONFIGURED' });
  });

  it('rejects multi-scope capability issuance and legacy multi-scope tokens', async () => {
    const secret = 'test-capability-secret-at-least-32-bytes';
    const ip = '203.0.113.93';
    const env = {
      MXQR_CAPABILITY_SECRET: secret,
      MXQR_TURNSTILE_DISABLED: 'true',
      MXQR_CAPABILITY_POW_DIFFICULTY: '8',
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
    };
    const headers = {
      Origin: 'https://musixquare.com',
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    };
    const challenge = await appWorker.fetch(
      new Request('https://musixquare.com/api/capability-challenge', {
        method: 'POST',
        headers,
        body: JSON.stringify({ scopes: ['turn', 'realtime'] }),
      }),
      env,
    );
    const mint = await appWorker.fetch(
      new Request('https://musixquare.com/api/capability-token', {
        method: 'POST',
        headers,
        body: JSON.stringify({ scopes: ['turn', 'realtime'] }),
      }),
      env,
    );
    const legacyToken = await signCapabilityToken(secret, ip, ['turn', 'realtime']);
    const useLegacy = await appWorker.fetch(
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: {
          Origin: 'https://musixquare.com',
          'CF-Connecting-IP': ip,
          'X-MXQR-Capability': legacyToken,
        },
      }),
      env,
    );

    expect(challenge.status).toBe(400);
    expect(mint.status).toBe(400);
    expect(useLegacy.status).toBe(401);
  });

  it('reports transparent proof-of-work when Turnstile is not configured', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
    };

    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/security-config', {
        headers: {
          Origin: 'https://musixquare.com',
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      capabilityRequired: true,
      turnstileSiteKey: '',
      turnstileRequired: false,
      proofOfWorkRequired: true,
      proofOfWorkDifficulty: 16,
      proofOfWorkTtl: 120,
      inferredFallback: false,
    });
  });

  it('rejects Turnstile tokens solved on an unexpected hostname', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              action: 'mxqr-capability',
              hostname: 'evil.example',
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
    };

    const mint = await appWorker.fetch(
      new Request('https://musixquare.com/api/capability-token', {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.25',
        },
        body: JSON.stringify({ scopes: ['turn'], turnstileToken: 'token' }),
      }),
      env,
    );

    expect(mint.status).toBe(403);
    expect(await mint.json()).toEqual({ error: 'TURNSTILE_FAILED' });
  });

  it('mints capability tokens for valid Turnstile action and hostname', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              action: 'mxqr-capability',
              hostname: 'musixquare.com',
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
    };

    const mint = await appWorker.fetch(
      new Request('https://musixquare.com/api/capability-token', {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.26',
        },
        body: JSON.stringify({ scopes: ['turn'], turnstileToken: 'token' }),
      }),
      env,
    );
    const payload = (await mint.json()) as { token?: string };

    expect(mint.status).toBe(200);
    expect(payload.token).toMatch(/\./);
  });

  it('honors configured Turnstile hostname wildcard allowlists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              action: 'mxqr-capability',
              hostname: 'preview.musixquare.com',
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
      MXQR_TURNSTILE_ALLOWED_HOSTNAMES: '*.musixquare.com',
    };

    const mint = await appWorker.fetch(
      new Request('https://musixquare.com/api/capability-token', {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.27',
        },
        body: JSON.stringify({ scopes: ['turn'], turnstileToken: 'token' }),
      }),
      env,
    );
    const payload = (await mint.json()) as { token?: string };

    expect(mint.status).toBe(200);
    expect(payload.token).toMatch(/\./);
  });

  it('rejects spoofable trusted-origin token minting by default when Turnstile is absent', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
    };
    const ip = '203.0.113.24';

    const mint = await appWorker.fetch(
      new Request('https://musixquare.com/api/capability-token', {
        method: 'POST',
        headers: {
          Host: 'musixquare.com',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': ip,
        },
        body: JSON.stringify({ scopes: ['turn'] }),
      }),
      env,
    );

    expect(mint.status).toBe(403);
    expect(await mint.json()).toEqual({ error: 'PROOF_OF_WORK_FAILED' });
  });

  it('never treats a trusted Origin header as capability proof, even with the legacy flag', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      MXQR_ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK: 'true',
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
    };
    const ip = '203.0.113.21';
    const mint = await appWorker.fetch(
      new Request('https://musixquare.com/api/capability-token', {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': ip,
        },
        body: JSON.stringify({ scopes: ['turn'] }),
      }),
      env,
    );
    expect(mint.status).toBe(403);
    expect(await mint.json()).toEqual({ error: 'PROOF_OF_WORK_FAILED' });
  });

  it('rejects same-origin-inferred capability fallback by default when Turnstile is configured', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
    };
    const ip = '203.0.113.22';

    const blocked = await appWorker.fetch(
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: {
          Host: 'musixquare.com',
          'CF-Connecting-IP': ip,
        },
      }),
      env,
    );
    expect(blocked.status).toBe(401);

    const mint = await appWorker.fetch(
      new Request('https://musixquare.com/api/capability-token', {
        method: 'POST',
        headers: {
          Host: 'musixquare.com',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': ip,
        },
        body: JSON.stringify({ scopes: ['turn'] }),
      }),
      env,
    );

    expect(mint.status).toBe(403);
    expect(await mint.json()).toEqual({ error: 'TURNSTILE_REQUIRED' });
  });

  it('allows same-origin-inferred capability fallback only when explicitly enabled', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      MXQR_ALLOW_INFERRED_CAPABILITY_FALLBACK: 'true',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
    };
    const ip = '203.0.113.23';

    const mint = await appWorker.fetch(
      new Request('https://musixquare.com/api/capability-token', {
        method: 'POST',
        headers: {
          Host: 'musixquare.com',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': ip,
        },
        body: JSON.stringify({ scopes: ['turn'] }),
      }),
      env,
    );
    const payload = (await mint.json()) as { token?: string };

    expect(mint.status).toBe(200);
    expect(payload.token).toMatch(/\./);

    const allowed = await appWorker.fetch(
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: {
          Host: 'musixquare.com',
          'CF-Connecting-IP': ip,
          'X-MXQR-Capability': payload.token || '',
        },
      }),
      env,
    );
    expect(allowed.status).toBe(200);
  });

  it('reports configured proof-of-work parameters while Turnstile is disabled', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      MXQR_TURNSTILE_DISABLED: 'true',
      MXQR_CAPABILITY_POW_DIFFICULTY: '9',
      MXQR_CAPABILITY_POW_TTL: '45',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
    };

    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/security-config', {
        headers: {
          Origin: 'https://musixquare.com',
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      capabilityRequired: true,
      turnstileSiteKey: '',
      turnstileRequired: false,
      proofOfWorkRequired: true,
      proofOfWorkDifficulty: 9,
      proofOfWorkTtl: 45,
      inferredFallback: false,
    });
  });

  it('mints and accepts an IP-bound proof-of-work capability while Turnstile is disabled', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      MXQR_TURNSTILE_DISABLED: 'true',
      MXQR_CAPABILITY_POW_DIFFICULTY: '8',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
    };
    const ip = '203.0.113.28';

    const mint = await mintWithProofOfWork(env, ['turn'], ip);
    const payload = (await mint.json()) as { token?: string };

    expect(mint.status).toBe(200);
    expect(payload.token).toMatch(/\./);

    const allowed = await appWorker.fetch(
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: {
          Origin: 'https://musixquare.com',
          'CF-Connecting-IP': ip,
          'X-MXQR-Capability': payload.token || '',
        },
      }),
      env,
    );
    expect(allowed.status).toBe(200);
  });

  it('binds proof-of-work challenges to the exact scope set and client IP', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      MXQR_TURNSTILE_DISABLED: 'true',
      MXQR_CAPABILITY_POW_DIFFICULTY: '8',
    };
    const proof = await requestProofOfWork(env, ['turn'], '203.0.113.40');

    const wrongScope = await mintWithProofOfWork(env, ['realtime'], '203.0.113.40', proof);
    const wrongIp = await mintWithProofOfWork(env, ['turn'], '203.0.113.41', proof);

    expect(wrongScope.status).toBe(403);
    expect(await wrongScope.json()).toEqual({ error: 'PROOF_OF_WORK_FAILED' });
    expect(wrongIp.status).toBe(403);
    expect(await wrongIp.json()).toEqual({ error: 'PROOF_OF_WORK_FAILED' });
  });

  it('makes same-proof reuse idempotent instead of extending capability expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      MXQR_TURNSTILE_DISABLED: 'true',
      MXQR_CAPABILITY_POW_DIFFICULTY: '8',
    };
    const ip = '203.0.113.42';
    const proof = await requestProofOfWork(env, ['turn'], ip);
    const first = await mintWithProofOfWork(env, ['turn'], ip, proof);
    const firstPayload = (await first.json()) as { token?: string; expiresAt?: number };

    vi.setSystemTime(new Date('2026-07-10T00:01:00.000Z'));
    const replay = await mintWithProofOfWork(env, ['turn'], ip, proof);
    const replayPayload = (await replay.json()) as { token?: string; expiresAt?: number };

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replayPayload).toEqual(firstPayload);
  });

  it('rejects expired proof-of-work and clamps unsafe env parameters', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
      MXQR_TURNSTILE_DISABLED: 'true',
      MXQR_CAPABILITY_POW_DIFFICULTY: '1',
      MXQR_CAPABILITY_POW_TTL: '1',
    };
    const config = await appWorker.fetch(
      new Request('https://musixquare.com/api/security-config', {
        headers: { Origin: 'https://musixquare.com' },
      }),
      env,
    );
    expect(await config.json()).toMatchObject({
      proofOfWorkDifficulty: 8,
      proofOfWorkTtl: 30,
    });

    const ip = '203.0.113.43';
    const proof = await requestProofOfWork(env, ['turn'], ip);
    vi.setSystemTime(new Date('2026-07-10T00:00:31.000Z'));
    const expired = await mintWithProofOfWork(env, ['turn'], ip, proof);

    expect(expired.status).toBe(403);
    expect(await expired.json()).toEqual({ error: 'PROOF_OF_WORK_FAILED' });
  });

  it('serves rate-limit rejections with the shared security headers', async () => {
    installRateLimitCache();
    const env = {
      MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
    };
    const request = () =>
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: {
          Origin: 'https://musixquare.com',
          'CF-Connecting-IP': '203.0.113.10',
        },
      });

    for (let i = 0; i < 60; i++) {
      expect((await appWorker.fetch(request(), env)).status).toBe(200);
    }

    const blocked = await appWorker.fetch(request(), env);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    expect(blocked.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(blocked.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(await blocked.json()).toEqual({ error: 'Too Many Requests' });
  });
});

describe('Cloudflare app worker bounded JSON bodies', () => {
  const capabilityEnv = {
    MXQR_CAPABILITY_SECRET: 'test-capability-secret-at-least-32-bytes',
    MXQR_TURNSTILE_DISABLED: 'true',
  };
  const realtimeEnv = {
    MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
    MXQR_REALTIME_SESSION_OWNER_SECRET: 'realtime-owner-secret-for-tests-at-least-32-bytes',
    CLOUDFLARE_REALTIME_APP_ID: 'realtime-app-id',
    CLOUDFLARE_REALTIME_APP_SECRET: 'realtime-app-secret',
  };
  const adminEnv = {
    MXQR_ADMIN_PASSWORD: 'admin-password',
    MXQR_ADMIN_SESSION_SECRET: 'admin-session-secret-for-tests',
  };
  const cases = [
    ['/api/capability-challenge', capabilityEnv],
    ['/api/capability-token', capabilityEnv],
    ['/api/cloudflare-realtime', realtimeEnv],
    ['/api/admin/login', adminEnv],
  ] as const;

  it('rejects an oversized Content-Length before consuming the request stream', async () => {
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/capability-challenge', {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          'Content-Length': '999999',
        },
        body: '{}',
      }),
      capabilityEnv,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Request body too large' });
  });

  it.each(cases)('counts the actual streamed bytes for %s', async (path, env) => {
    const response = await appWorker.fetch(
      new Request(`https://musixquare.com${path}`, {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          // Deliberately lie low: the stream counter, not this hint, must win.
          'Content-Length': '2',
        },
        body: JSON.stringify({ padding: 'x'.repeat(140 * 1024) }),
      }),
      env,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Request body too large' });
  });

  it.each(cases)('returns a stable invalid-JSON error for %s', async (path, env) => {
    const response = await appWorker.fetch(
      new Request(`https://musixquare.com${path}`, {
        method: 'POST',
        headers: { Origin: 'https://musixquare.com', 'Content-Type': 'application/json' },
        body: '{',
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });
});

describe('Cloudflare Realtime session ownership', () => {
  const env = {
    MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
    MXQR_REALTIME_SESSION_OWNER_SECRET: 'realtime-owner-secret-for-tests-at-least-32-bytes',
    CLOUDFLARE_REALTIME_APP_ID: 'realtime-app-id',
    CLOUDFLARE_REALTIME_APP_SECRET: 'realtime-app-secret',
  };

  function proxyRequest(body: Record<string, unknown>, ip = '203.0.113.60'): Request {
    return new Request('https://musixquare.com/api/cloudflare-realtime', {
      method: 'POST',
      headers: {
        Origin: 'https://musixquare.com',
        'Content-Type': 'application/json',
        'CF-Connecting-IP': ip,
      },
      body: JSON.stringify(body),
    });
  }

  it('rejects cross-session BOLA while allowing a legitimate IP handoff', async () => {
    let sessionCounter = 0;
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/sessions/new')) {
        sessionCounter += 1;
        return Response.json({ sessionId: `session-${sessionCounter}` });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', upstreamFetch);

    const first = await appWorker.fetch(proxyRequest({ action: 'new-session' }), env);
    const second = await appWorker.fetch(proxyRequest({ action: 'new-session' }), env);
    const firstPayload = (await first.json()) as {
      sessionId?: string;
      sessionOwnerToken?: string;
    };
    const secondPayload = (await second.json()) as {
      sessionId?: string;
      sessionOwnerToken?: string;
    };

    expect(first.status).toBe(200);
    expect(firstPayload).toMatchObject({ sessionId: 'session-1' });
    expect(firstPayload.sessionOwnerToken).toMatch(/\./);
    expect(secondPayload.sessionOwnerToken).toMatch(/\./);

    const upstreamCallsBeforeBola = upstreamFetch.mock.calls.length;
    const crossSession = await appWorker.fetch(
      proxyRequest({
        action: 'tracks-close',
        sessionId: firstPayload.sessionId,
        sessionOwnerToken: secondPayload.sessionOwnerToken,
        payload: { tracks: [{ mid: '0' }] },
      }),
      env,
    );
    const crossIp = await appWorker.fetch(
      proxyRequest(
        {
          action: 'renegotiate',
          sessionId: firstPayload.sessionId,
          sessionOwnerToken: firstPayload.sessionOwnerToken,
          payload: { sessionDescription: { type: 'answer', sdp: 'test' } },
        },
        '203.0.113.61',
      ),
      env,
    );
    const missing = await appWorker.fetch(
      proxyRequest({ action: 'tracks-new', sessionId: firstPayload.sessionId, payload: {} }),
      env,
    );

    expect(crossSession.status).toBe(403);
    expect(await crossSession.json()).toEqual({ error: 'SESSION_OWNERSHIP_REQUIRED' });
    expect(crossIp.status).toBe(200);
    expect(missing.status).toBe(403);
    expect(upstreamFetch).toHaveBeenCalledTimes(upstreamCallsBeforeBola + 1);

    const owned = await appWorker.fetch(
      proxyRequest({
        action: 'tracks-close',
        sessionId: firstPayload.sessionId,
        sessionOwnerToken: firstPayload.sessionOwnerToken,
        payload: { tracks: [{ mid: '0' }] },
      }),
      env,
    );
    expect(owned.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(upstreamCallsBeforeBola + 2);
  });

  it('renews an owned session across IP changes without extending an expired token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
    const shortEnv = {
      ...env,
      MXQR_REALTIME_SESSION_OWNER_TTL: '300',
      MXQR_REALTIME_SESSION_OWNER_ABSOLUTE_TTL: '600',
    };
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/sessions/new')
        ? Response.json({ sessionId: 'session-refresh' })
        : Response.json({ ok: true }),
    );
    vi.stubGlobal('fetch', upstreamFetch);

    const created = await appWorker.fetch(proxyRequest({ action: 'new-session' }), shortEnv);
    const original = (await created.json()) as {
      sessionOwnerToken: string;
      sessionOwnerExpiresAt: number;
    };

    vi.setSystemTime(new Date('2026-07-10T00:04:00.000Z'));
    const renewed = await appWorker.fetch(
      proxyRequest(
        {
          action: 'session-owner-refresh',
          sessionId: 'session-refresh',
          sessionOwnerToken: original.sessionOwnerToken,
        },
        '203.0.113.61',
      ),
      shortEnv,
    );
    const refreshed = (await renewed.json()) as {
      sessionOwnerToken: string;
      sessionOwnerExpiresAt: number;
    };

    expect(renewed.status).toBe(200);
    expect(refreshed.sessionOwnerToken).toMatch(/\./);
    expect(refreshed.sessionOwnerToken).not.toBe(original.sessionOwnerToken);
    expect(refreshed.sessionOwnerExpiresAt).toBeGreaterThan(original.sessionOwnerExpiresAt);
    const originalClaims = decodeTokenPayload(original.sessionOwnerToken);
    const refreshedClaims = decodeTokenPayload(refreshed.sessionOwnerToken);
    expect(refreshedClaims.orig).toBe(originalClaims.orig);
    expect(refreshedClaims.abs).toBe(originalClaims.abs);
    expect(Number(refreshedClaims.abs) - Number(refreshedClaims.orig)).toBe(600);
    // Refresh is local authorization work; it never reaches Cloudflare Realtime.
    expect(upstreamFetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-07-10T00:05:01.000Z'));
    const expired = await appWorker.fetch(
      proxyRequest({
        action: 'tracks-close',
        sessionId: 'session-refresh',
        sessionOwnerToken: original.sessionOwnerToken,
        payload: { tracks: [{ mid: '0' }] },
      }),
      shortEnv,
    );
    const current = await appWorker.fetch(
      proxyRequest(
        {
          action: 'tracks-close',
          sessionId: 'session-refresh',
          sessionOwnerToken: refreshed.sessionOwnerToken,
          payload: { tracks: [{ mid: '0' }] },
        },
        '203.0.113.62',
      ),
      shortEnv,
    );

    expect(expired.status).toBe(403);
    expect(current.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-07-10T00:08:00.000Z'));
    const finalWindow = await appWorker.fetch(
      proxyRequest({
        action: 'session-owner-refresh',
        sessionId: 'session-refresh',
        sessionOwnerToken: refreshed.sessionOwnerToken,
      }),
      shortEnv,
    );
    const finalCredential = (await finalWindow.json()) as {
      sessionOwnerToken: string;
      sessionOwnerExpiresAt: number;
    };
    expect(finalWindow.status).toBe(200);
    expect(finalCredential.sessionOwnerExpiresAt).toBe(Number(originalClaims.abs));

    vi.setSystemTime(new Date('2026-07-10T00:10:01.000Z'));
    const pastAbsoluteLifetime = await appWorker.fetch(
      proxyRequest({
        action: 'session-owner-refresh',
        sessionId: 'session-refresh',
        sessionOwnerToken: finalCredential.sessionOwnerToken,
      }),
      shortEnv,
    );
    expect(pastAbsoluteLifetime.status).toBe(403);
  });
});

describe('Cloudflare app worker YouTube search proxy', () => {
  it('decodes HTML entities in YouTube result metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          items: [
            {
              id: { videoId: 'dQw4w9WgXcQ' },
              snippet: {
                title: 'Ain&#39;t &amp; &quot;Too Cool&quot; &lt;Live&gt; &rsquo;',
                channelTitle: 'LunchMoney &amp; Crew',
                publishedAt: '2026-01-01T00:00:00Z',
                thumbnails: {
                  medium: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' },
                },
              },
            },
          ],
        }),
      ),
    );

    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/youtube-search?q=aint', {
        headers: {
          Origin: 'https://musixquare.com',
          'CF-Connecting-IP': '203.0.113.31',
        },
      }),
      {
        MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
        YOUTUBE_API_KEY: 'test-key',
      },
    );
    const payload = (await response.json()) as {
      results?: Array<{ title?: string; channelTitle?: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.results?.[0]?.title).toBe('Ain\'t & "Too Cool" <Live> \u2019');
    expect(payload.results?.[0]?.channelTitle).toBe('LunchMoney & Crew');
  });
});

describe('Cloudflare app worker admin dashboard', () => {
  function createMetricsDb(rows: Array<{ bucket_minute: number; event: string; count: number }>) {
    const rateLimits = new Map<string, { window: number; count: number }>();
    return {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('CREATE TABLE IF NOT EXISTS mxqr_api_rate_limits')) {
          return { run: vi.fn(async () => ({ success: true })) };
        }
        if (sql.includes('INSERT INTO mxqr_api_rate_limits')) {
          return {
            bind: vi.fn((key: string, window: number, _expiresAt: number, limit: number) => ({
              first: vi.fn(async () => {
                const current = rateLimits.get(key);
                if (current?.window === window && current.count >= limit) return null;
                const count = current?.window === window ? current.count + 1 : 1;
                rateLimits.set(key, { window, count });
                return { count };
              }),
            })),
          };
        }
        if (sql.includes('DELETE FROM mxqr_api_rate_limits')) {
          return {
            bind: vi.fn(() => ({ run: vi.fn(async () => ({ success: true })) })),
          };
        }
        return {
          bind: vi.fn((sinceMinute: number) => ({
            all: vi.fn(async () => ({
              results: rows.filter((row) => row.bucket_minute >= sinceMinute),
            })),
          })),
        };
      }),
    };
  }

  function createKvStore() {
    const store = new Map<string, string>();
    return {
      get: vi.fn(async (key: string) => store.get(key) || null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    };
  }

  function createSoroRss() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Visible Article</title>
      <link>https://musixquare.com/blog?post=visible-article</link>
      <description>Visible description</description>
      <pubDate>Thu, 18 Jun 2026 12:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>Visible body</p>]]></content:encoded>
    </item>
    <item>
      <title>Hidden Article</title>
      <link>https://musixquare.com/blog?post=hidden-article</link>
      <description>Hidden description</description>
      <pubDate>Wed, 17 Jun 2026 12:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>Hidden body</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;
  }

  function createSoroRssWithImage() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Fast Article</title>
      <link>https://musixquare.com/blog?post=fast-article</link>
      <description>Fast description</description>
      <pubDate>Thu, 18 Jun 2026 12:00:00 GMT</pubDate>
      <enclosure url="https://app.trysoro.com/images/fast-article.webp" type="image/webp" />
      <content:encoded><![CDATA[<p>Fast body</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;
  }

  function createSoroRssWithJsonLdBreakout() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title><![CDATA[Escape </script><style id="rss-pwned">body{display:none}</style>]]></title>
      <link>https://musixquare.com/blog?post=json-ld-breakout</link>
      <description><![CDATA[Description </script><script>globalThis.pwned=true</script>]]></description>
      <pubDate>Thu, 18 Jun 2026 12:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>Safe body</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;
  }

  it('sets an HttpOnly admin session cookie and serves D1-backed metrics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    const nowMinute = Math.floor(Date.now() / 60000);
    const env = {
      MXQR_ADMIN_PASSWORD: 'admin-pass',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret',
      MXQR_RATE_LIMIT_HASH_SECRET: 'test-rate-limit-hash-secret-at-least-32-bytes',
      MUSIXQUARE_ADMIN_DB: createMetricsDb([
        { bucket_minute: nowMinute - 31 * 24 * 60, event: 'guest_joined', count: 99 },
        { bucket_minute: nowMinute - 29 * 24 * 60, event: 'guest_joined', count: 4 },
        { bucket_minute: nowMinute - 5, event: 'room_opened', count: 3 },
        { bucket_minute: nowMinute - 4, event: 'guest_joined', count: 7 },
        { bucket_minute: nowMinute - 3, event: 'guest_auth_failed', count: 1 },
      ]),
    };

    const unauthenticated = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/metrics'),
      env,
    );
    expect(unauthenticated.status).toBe(401);

    const login = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.81' },
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      env,
    );
    const cookie = login.headers.get('Set-Cookie') || '';

    expect(login.status).toBe(200);
    expect(cookie).toContain('__Host-mxqr_admin=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');

    const metrics = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/metrics', {
        headers: { Cookie: cookie.split(';')[0] },
      }),
      env,
    );
    const payload = (await metrics.json()) as {
      cards?: Array<{ key: string; value: number }>;
      summary?: {
        last24?: Record<string, number>;
        daily?: Array<{ events: Record<string, number> }>;
        daily30?: Array<{ events: Record<string, number> }>;
      };
    };

    expect(metrics.status).toBe(200);
    expect(payload.summary?.last24?.room_opened).toBe(3);
    expect(payload.summary?.last24?.guest_joined).toBe(7);
    expect(payload.summary?.daily).toHaveLength(7);
    expect(payload.summary?.daily30).toHaveLength(30);
    expect(payload.summary?.daily30?.[0]?.events.guest_joined).toBe(4);
    expect(
      payload.summary?.daily30?.reduce((sum, bucket) => sum + bucket.events.guest_joined, 0),
    ).toBe(11);
    expect(payload.cards?.find((card) => card.key === 'guest_per_room')?.value).toBe(2.33);
  });

  it('lets admins hide Soro articles without mutating the RSS backup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(createSoroRss(), {
            headers: { 'Content-Type': 'application/rss+xml' },
          }),
      ),
    );
    const env = {
      MXQR_ADMIN_PASSWORD: 'admin-pass',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret',
      SORO_RSS_BACKUP: createKvStore(),
      ASSETS: {
        fetch: vi.fn(
          async () =>
            new Response(
              '<html><head></head><body id="top" class="editorial-page editorial-blog"><div id="soro-blog"></div></body></html>',
              {
                headers: { 'Content-Type': 'text/html' },
              },
            ),
        ),
      },
    };

    const login = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.82' },
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      env,
    );
    const cookie = login.headers.get('Set-Cookie')?.split(';')[0] || '';

    const articles = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/articles', {
        headers: { Cookie: cookie },
      }),
      env,
    );
    const before = (await articles.json()) as {
      articles?: Array<{ slug: string; hidden: boolean }>;
    };

    expect(articles.status).toBe(200);
    expect(before.articles?.map((article) => article.slug)).toEqual([
      'visible-article',
      'hidden-article',
    ]);

    const hide = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/articles/visibility', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'hidden-article', hidden: true }),
      }),
      env,
    );

    expect(hide.status).toBe(200);
    const hidePayload = (await hide.json()) as {
      cacheVersion?: string;
      hidden?: boolean;
    };
    expect(hidePayload.hidden).toBe(true);
    expect(hidePayload.cacheVersion).toMatch(/^[A-Za-z0-9._:-]+$/);

    const blog = await appWorker.fetch(new Request('https://musixquare.com/blog'), env);
    const blogHtml = await blog.text();
    const hiddenArticle = await appWorker.fetch(
      new Request('https://musixquare.com/blog/hidden-article'),
      env,
    );
    const visibleArticle = await appWorker.fetch(
      new Request('https://musixquare.com/blog/visible-article'),
      env,
    );
    const visibleArticleHtml = await visibleArticle.text();
    const backupXml = await env.SORO_RSS_BACKUP.get('soro-rss-latest-good.xml');

    expect(blog.status).toBe(200);
    expect(blog.headers.get('Cache-Control')).toBe('no-store, max-age=0, must-revalidate');
    expect(blog.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(blog.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(blog.headers.get('Pragma')).toBe('no-cache');
    expect(blog.headers.get('Expires')).toBe('0');
    expect(blog.headers.get('X-Soro-Blog-Cache-Version')).toBe(hidePayload.cacheVersion);
    expect(blog.headers.get('ETag')).toBe(`W/"soro-blog-${hidePayload.cacheVersion}"`);
    expect(blogHtml).toContain(
      `name="soro-blog-cache-version" content="${hidePayload.cacheVersion}"`,
    );
    expect(blogHtml).toContain('Visible Article');
    expect(blogHtml).not.toContain('Hidden Article');
    expect(hiddenArticle.status).toBe(404);
    expect(visibleArticle.status).toBe(200);
    expect(visibleArticleHtml).toContain(
      '<body id="top" class="editorial-page editorial-blog" data-soro-source="backup" data-soro-view="article">',
    );
    expect(backupXml).toContain('Hidden Article');
  });

  it('serves the public blog from RSS backup without blocking on live RSS or image R2 checks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>(() => {
            /* keep the background live refresh pending */
          }),
      ),
    );
    const env = {
      SORO_RSS_BACKUP: createKvStore(),
      SORO_IMAGE_BUCKET: {
        head: vi.fn(async () => {
          throw new Error('hot path must not head image objects');
        }),
        get: vi.fn(),
      },
      ASSETS: {
        fetch: vi.fn(
          async () =>
            new Response('<html><head></head><body><div id="soro-blog"></div></body></html>', {
              headers: { 'Content-Type': 'text/html' },
            }),
        ),
      },
    };
    await env.SORO_RSS_BACKUP.put('soro-rss-latest-good.xml', createSoroRssWithImage());

    const waitUntil = vi.fn();
    const response = await appWorker.fetch(new Request('https://musixquare.com/blog'), env, {
      waitUntil,
    } as any);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Soro-Index-Source')).toBe('backup');
    expect(response.headers.get('X-Soro-Backup-Status')).toBe('cached');
    expect(response.headers.get('X-Soro-Image-Status')).toBe('mapped:1');
    expect(html).toContain('Fast Article');
    expect(html).toContain('/soro-images/featured/fast-article.webp');
    expect(env.SORO_IMAGE_BUCKET.head).not.toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('keeps hostile RSS metadata inside JSON-LD in both shell and fallback renderers', async () => {
    const rss = createSoroRssWithJsonLdBreakout();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(rss, { headers: { 'Content-Type': 'application/rss+xml' } })),
    );

    for (const shellHtml of [
      '<html><head><title>Blog</title></head><body><div id="soro-blog"></div></body></html>',
      '',
    ]) {
      const backup = createKvStore();
      await backup.put('soro-rss-latest-good.xml', rss);
      const response = await appWorker.fetch(
        new Request('https://musixquare.com/blog/json-ld-breakout'),
        {
          SORO_RSS_BACKUP: backup,
          ASSETS: {
            fetch: vi.fn(async () =>
              shellHtml
                ? new Response(shellHtml, { headers: { 'Content-Type': 'text/html' } })
                : new Response('not found', {
                    status: 404,
                    headers: { 'Content-Type': 'text/plain' },
                  }),
            ),
          },
        },
      );
      const html = await response.text();
      const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];

      expect(response.status).toBe(200);
      expect(html).not.toContain('</script><style id="rss-pwned">');
      expect(html).not.toContain('</script><script>globalThis.pwned=true</script>');
      expect(jsonLd).toContain('\\u003c/script\\u003e');
      expect(JSON.parse(jsonLd || '{}')).toMatchObject({
        headline: 'Escape </script><style id="rss-pwned">body{display:none}</style>',
        description: 'Description </script><script>globalThis.pwned=true</script>',
      });
    }
  });

  it('lets admins publish a session announcement for active clients', async () => {
    const env = {
      MXQR_ADMIN_PASSWORD: 'admin-pass',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret',
      SORO_RSS_BACKUP: createKvStore(),
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));

    const login = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.82' },
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      env,
    );
    const cookie = login.headers.get('Set-Cookie')?.split(';')[0] || '';

    const pastExpiry = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/announcement', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          message: 'Maintenance starts in five minutes.',
          expiresAt: '2026-06-18T11:59:00.000Z',
        }),
      }),
      env,
    );

    expect(pastExpiry.status).toBe(400);
    expect(await pastExpiry.json()).toEqual({ error: 'EXPIRES_AT_IN_PAST' });

    const save = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/announcement', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          message: 'Maintenance starts in five minutes.',
          expiresAt: '2026-06-18T13:00:00.000Z',
        }),
      }),
      env,
    );
    const saved = (await save.json()) as {
      announcement?: { id?: string; enabled?: boolean; message?: string };
      history?: Array<{ action?: string; enabled?: boolean; message?: string }>;
    };

    expect(save.status).toBe(200);
    expect(saved.announcement?.enabled).toBe(true);
    expect(saved.announcement?.message).toBe('Maintenance starts in five minutes.');
    expect(saved.announcement?.id).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(saved.history?.[0]).toMatchObject({
      action: 'published',
      enabled: true,
      message: 'Maintenance starts in five minutes.',
    });

    const adminRead = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/announcement', {
        headers: { Cookie: cookie },
      }),
      env,
    );
    const adminPayload = (await adminRead.json()) as {
      history?: Array<{ action?: string; enabled?: boolean; message?: string }>;
    };
    expect(adminPayload.history?.[0]).toMatchObject({
      action: 'published',
      enabled: true,
      message: 'Maintenance starts in five minutes.',
    });

    const current = await appWorker.fetch(
      new Request('https://musixquare.com/api/announcement/current'),
      env,
    );
    const payload = (await current.json()) as {
      enabled?: boolean;
      id?: string;
      message?: string;
    };

    expect(current.status).toBe(200);
    expect(current.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(payload).toEqual({
      enabled: true,
      id: saved.announcement?.id,
      message: 'Maintenance starts in five minutes.',
      expiresAt: '2026-06-18T13:00:00.000Z',
    });

    vi.setSystemTime(new Date('2026-06-18T13:00:01.000Z'));
    const expired = await appWorker.fetch(
      new Request('https://musixquare.com/api/announcement/current'),
      env,
    );

    expect(await expired.json()).toEqual({ enabled: false });

    const clear = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/announcement', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, message: '', expiresAt: null }),
      }),
      env,
    );
    const cleared = (await clear.json()) as {
      history?: Array<{ action?: string; enabled?: boolean; message?: string }>;
    };
    expect(cleared.history?.[0]).toMatchObject({
      action: 'cleared',
      enabled: false,
      message: '',
    });
    expect(cleared.history?.[1]).toMatchObject({
      action: 'published',
      enabled: true,
      message: 'Maintenance starts in five minutes.',
    });
    vi.useRealTimers();
  });

  it('keeps /admin unindexed and no-store cached', async () => {
    const response = await appWorker.fetch(new Request('https://musixquare.com/admin'), {
      MXQR_ADMIN_PASSWORD: 'admin-pass',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret',
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('/admin.js');
  });
});

describe('Cloudflare app worker invite route', () => {
  function createAssetEnv() {
    return {
      ASSETS: {
        fetch: vi.fn(async (request: Request) => {
          const url = new URL(request.url);
          if (url.pathname !== '/index.html') {
            return new Response('not found', {
              status: 404,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          return new Response(
            [
              '<html><head>',
              '<meta property="og:url" content="https://musixquare.com/" />',
              '<meta property="og:title" content="MUSIXQUARE" />',
              '<meta property="og:description" content="Default description" />',
              '<meta property="og:image" content="https://musixquare.com/og-image.png" />',
              '<meta property="og:image:alt" content="MUSIXQUARE" />',
              '<meta name="twitter:title" content="MUSIXQUARE" />',
              '<meta name="twitter:description" content="Default description" />',
              '<meta name="twitter:image" content="https://musixquare.com/og-image.png" />',
              '</head><body><script type="module" src="/assets/main-test.js"></script></body></html>',
            ].join(''),
            {
              status: 200,
              headers: {
                'Content-Type': 'text/html',
                'Cache-Control': 'public, max-age=999',
              },
            },
          );
        }),
      },
    };
  }

  it('redirects HTTP invite URLs to HTTPS before serving the app shell', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(new Request('http://musixquare.com/123456'), env);

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://musixquare.com/123456');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('keeps localhost HTTP available for worker development', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(new Request('http://localhost:8787/123456'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Invite-Rewrite')).toBe('123456');
    expect(env.ASSETS.fetch).toHaveBeenCalled();
  });

  it('adds UTF-8 charset to the root app shell HTML response', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(new Request('https://musixquare.com/'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('serves invite pages for GET with fresh app-shell cache semantics', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(new Request('https://musixquare.com/123456'), env);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Invite-Rewrite')).toBe('123456');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(html).toContain('Session 123456 - MUSIXQUARE');
    expect(html).toContain('https://musixquare.com/123456');
    expect(html).toContain('/assets/main-test.js');
  });

  it('serves invite pages for HEAD instead of falling through to static 404', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/123456', { method: 'HEAD' }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Invite-Rewrite')).toBe('123456');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('');
  });
});
