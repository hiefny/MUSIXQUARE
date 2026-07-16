import { afterEach, describe, expect, it, vi } from 'vitest';
import appWorker, { sanitizeSoroArticleHtmlForTests } from '../../../cloudflare/app-worker.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function requestWithOrigin(origin: string): Request {
  return new Request('https://musixquare.com/api/get-turn-config', {
    headers: { Origin: origin },
  });
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
): Promise<{ challenge: string; solution: string }> {
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
  const payload = (await response.json()) as { challenge: string; difficulty: number };
  expect(response.status).toBe(200);
  return {
    challenge: payload.challenge,
    solution: await solveProofOfWork(payload.challenge, payload.difficulty),
  };
}

async function mintWithProofOfWork(
  env: Record<string, unknown>,
  scopes: string[],
  ip: string,
  proofOfWork?: { challenge: string; solution: string },
): Promise<Response> {
  const resolvedProof = proofOfWork ?? (await requestProofOfWork(env, scopes, ip));
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

describe('Soro article HTML sanitizer', () => {
  it('preserves ordinary article structure and a narrow set of safe attributes', () => {
    const html = sanitizeSoroArticleHtmlForTests(`
      <h2 class="section-title">Listening together</h2>
      <p lang="en"><strong>Lossless</strong> audio with <em>friends</em>.</p>
      <a href="https://example.com/listen?a=1&amp;b=2" target="_blank" title="Read more">Link</a>
      <figure><img src="https://app.trysoro.com/image.webp" alt="Waveform" width="1200" height="675" loading="lazy"><figcaption>Caption</figcaption></figure>
      <ul><li>One</li><li>Two</li></ul>
      <table><tbody><tr><th scope="col">Format</th><td colspan="2">FLAC</td></tr></tbody></table>
    `);

    expect(html).toContain('<h2 class="section-title">Listening together</h2>');
    expect(html).toContain(
      '<p lang="en"><strong>Lossless</strong> audio with <em>friends</em>.</p>',
    );
    expect(html).toContain(
      '<a href="https://example.com/listen?a=1&amp;b=2" target="_blank" title="Read more" rel="noopener noreferrer">Link</a>',
    );
    expect(html).toContain(
      '<img src="https://app.trysoro.com/image.webp" alt="Waveform" width="1200" height="675" loading="lazy">',
    );
    expect(html).toContain('<figcaption>Caption</figcaption>');
    expect(html).toContain('<th scope="col">Format</th><td colspan="2">FLAC</td>');
  });

  it('drops executable elements, event handlers, inline styles, and unsafe URLs', () => {
    const html = sanitizeSoroArticleHtmlForTests(`
      <script><img src=x onerror=alert(1)></script>
      <style>@import 'https://evil.example/x.css';</style>
      <iframe srcdoc="<script>alert(1)</script>"></iframe>
      <svg><a href="javascript:alert(1)">SVG link</a></svg>
      <input type="text" value="ignored"><p>Content after a blocked void tag</p>
      <p style="background:url(javascript:alert(1))" onclick="alert(1)">Safe paragraph</p>
      <a href="java&#x73;cript:alert(1)" onmouseover=alert(1)>Numeric entity</a>
      <a href="jav&colon;ascript:alert(1)">Named entity</a>
      <a href="jav&#9;ascript:alert(1)">Control entity</a>
      <a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;:alert(1)">Encoded protocol</a>
      <a href="data:text/html,<script>alert(1)</script>">Data URL</a>
      <img src="data:image/svg+xml,<svg onload=alert(1)></svg>" onerror="alert(1)" alt="Unsafe image">
    `);

    expect(html).not.toMatch(/<(?:script|style|iframe|svg)\b/i);
    expect(html).not.toContain('<input');
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/(?:javascript|data):/i);
    expect(html).toContain('<p>Safe paragraph</p>');
    expect(html).toContain('<p>Content after a blocked void tag</p>');
    expect(html).toContain('<a>Numeric entity</a>');
    expect(html).toContain('<a>Named entity</a>');
    expect(html).toContain('<a>Control entity</a>');
    expect(html).toContain('<a>Encoded protocol</a>');
    expect(html).toContain('<a>Data URL</a>');
    expect(html).toContain('<img alt="Unsafe image">');
  });

  it('fails closed for comments and malformed raw-text or quoted markup', () => {
    const unclosedScript = sanitizeSoroArticleHtmlForTests(
      '<p>Before</p><!-- hidden --><script><img src="https://evil.example/pixel">',
    );
    const unclosedAttribute = sanitizeSoroArticleHtmlForTests(
      '<p>Before</p><img src="https://evil.example/pixel onerror=alert(1)><p>After</p>',
    );

    expect(unclosedScript).toBe('<p>Before</p>');
    expect(unclosedAttribute).not.toContain('<img');
    expect(unclosedAttribute).not.toMatch(/\bonerror\s*=/i);
    expect(unclosedAttribute).not.toContain('&lt;img');
    expect(unclosedAttribute).toContain('<p>After</p>');
  });

  it('keeps script-boundary and line-separator characters as article text only', () => {
    const html = sanitizeSoroArticleHtmlForTests(
      '<p>Before</p></script><p>Boundary \u2028 \u2029 text</p><p>After</p>',
    );

    expect(html).toBe('<p>Before</p><p>Boundary \u2028 \u2029 text</p><p>After</p>');
  });
});

describe('Cloudflare app worker scheduled maintenance', () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><item>
  <title>Scheduled article</title>
  <link>https://musixquare.com/blog?post=scheduled-article</link>
  <description>Scheduled description</description>
  <pubDate>Thu, 18 Jun 2026 12:00:00 GMT</pubDate>
  <content:encoded><![CDATA[<p>Scheduled body</p>]]></content:encoded>
</item></channel></rss>`;

  function createScheduledEnv(run: () => Promise<unknown>) {
    const store = new Map<string, string>();
    const backup = {
      get: vi.fn(async (key: string) => store.get(key) || null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    };
    const bind = vi.fn((_cutoffMinute: number) => ({ run }));
    const prepare = vi.fn((_query: string) => ({ bind }));
    return {
      env: {
        SORO_RSS_BACKUP: backup,
        MUSIXQUARE_ADMIN_DB: { prepare },
      },
      backup,
      bind,
      prepare,
    };
  }

  async function runScheduled(env: Record<string, unknown>) {
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => pending.push(Promise.resolve(promise))),
    };
    await appWorker.scheduled({}, env, ctx);
    return { ctx, pending };
  }

  it('deletes metric buckets and 365-day PRO admin audits in independent scheduled tasks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(rss, { headers: { 'Content-Type': 'application/rss+xml' } })),
    );
    const run = vi.fn(async () => ({ success: true }));
    const { env, backup, bind, prepare } = createScheduledEnv(run);

    const { ctx, pending } = await runScheduled(env);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(3);
    await Promise.all(pending);
    expect(prepare).toHaveBeenCalledWith(
      'DELETE FROM mxqr_metric_buckets WHERE bucket_minute < ?1',
    );
    expect(prepare).toHaveBeenCalledWith(
      'DELETE FROM mxqr_pro_room_admin_audit WHERE created_at < ?1',
    );
    expect(bind).toHaveBeenCalledWith(Math.floor(Date.now() / 60000) - 90 * 24 * 60);
    expect(bind).toHaveBeenCalledWith(Date.now() - 365 * 24 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(backup.put).toHaveBeenCalledWith('soro-rss-latest-good.xml', rss);
  });

  it('does not reject or block the Soro refresh when metric retention cleanup fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(rss, { headers: { 'Content-Type': 'application/rss+xml' } })),
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const run = vi.fn(async () => {
      throw new Error('D1 temporarily unavailable');
    });
    const { env, backup } = createScheduledEnv(run);

    const { pending } = await runScheduled(env);

    await expect(Promise.all(pending)).resolves.toHaveLength(3);
    expect(backup.put).toHaveBeenCalledWith('soro-rss-latest-good.xml', rss);
    expect(warning).toHaveBeenCalledWith(
      '[AdminMetrics] retention cleanup failed:',
      'D1 temporarily unavailable',
    );
    expect(warning).toHaveBeenCalledWith(
      '[PRO Admin Audit] retention cleanup failed:',
      'D1 temporarily unavailable',
    );
  });
});

describe('Cloudflare app worker CORS gate', () => {
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

  it('fails closed for paid endpoints when capability auth is not configured', async () => {
    const env = {};

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

  it('lets the explicit unguarded override reach provider resolution', async () => {
    const env = {
      MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
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

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'TURN_CONFIG_UNAVAILABLE' });
  });

  it('requires a capability token when capability auth is enabled', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
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

  it('reports transparent proof-of-work when Turnstile is not configured', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
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
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
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
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
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
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
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
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
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

  it('never treats a trusted Origin header as proof even when the retired flag is set', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
      MXQR_ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK: 'true',
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
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
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

  it('ignores the retired same-origin-inferred authentication flag', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
      MXQR_ALLOW_INFERRED_CAPABILITY_FALLBACK: 'true',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
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
    expect(mint.status).toBe(403);
    expect(await mint.json()).toEqual({ error: 'TURNSTILE_REQUIRED' });
  });

  it('reports proof-of-work while Turnstile remains disabled even when keys exist', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
      MXQR_TURNSTILE_DISABLED: 'true',
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
      proofOfWorkDifficulty: 16,
      proofOfWorkTtl: 120,
    });
  });

  it('mints PoW capability tokens and keeps YouTube search operational with Turnstile disabled', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
      MXQR_TURNSTILE_DISABLED: 'true',
      MXQR_CAPABILITY_POW_DIFFICULTY: '8',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
      YOUTUBE_API_KEY: 'youtube-key',
    };
    const ip = '203.0.113.28';
    const mint = await mintWithProofOfWork(env, ['youtube-search', 'remote-share'], ip);
    const payload = (await mint.json()) as { token?: string };

    expect(mint.status).toBe(200);
    expect(payload.token).toMatch(/\./);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ items: [] })),
    );
    const allowed = await appWorker.fetch(
      new Request('https://musixquare.com/api/youtube-search?q=test', {
        headers: {
          Origin: 'https://musixquare.com',
          'CF-Connecting-IP': ip,
          'X-MXQR-Capability': payload.token || '',
        },
      }),
      env,
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ query: 'test', results: [] });
  });

  it('binds proof-of-work to the exact scope set and client IP', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
      MXQR_TURNSTILE_DISABLED: 'true',
      MXQR_CAPABILITY_POW_DIFFICULTY: '8',
    };
    const proof = await requestProofOfWork(env, ['remote-share'], '203.0.113.40');

    const wrongScope = await mintWithProofOfWork(env, ['youtube-search'], '203.0.113.40', proof);
    const wrongIp = await mintWithProofOfWork(env, ['remote-share'], '203.0.113.41', proof);

    expect(wrongScope.status).toBe(403);
    expect(await wrongScope.json()).toEqual({ error: 'PROOF_OF_WORK_FAILED' });
    expect(wrongIp.status).toBe(403);
    expect(await wrongIp.json()).toEqual({ error: 'PROOF_OF_WORK_FAILED' });
  });

  it('serves rate-limit rejections with the shared security headers', async () => {
    installRateLimitCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          iceServers: [
            {
              urls: 'turn:turn.cloudflare.com:3478?transport=udp',
              username: 'turn-user',
              credential: 'turn-credential',
            },
          ],
        }),
      ),
    );
    const env = {
      MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
      CLOUDFLARE_TURN_KEY_ID: 'turn-key',
      CLOUDFLARE_TURN_API_TOKEN: 'turn-token',
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

describe('Cloudflare app worker JSON body limits', () => {
  it('rejects oversized capability and admin bodies before parsing', async () => {
    const capability = await appWorker.fetch(
      new Request('https://musixquare.com/api/capability-token', {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.90',
        },
        body: JSON.stringify({ scopes: ['remote-share'], padding: 'x'.repeat(8192) }),
      }),
      {
        MXQR_CAPABILITY_SECRET: 'test-capability-secret',
        MXQR_ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK: 'true',
      },
    );
    const admin = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.91',
        },
        body: JSON.stringify({ password: 'admin-pass', padding: 'x'.repeat(8192) }),
      }),
      {
        MXQR_ADMIN_PASSWORD: 'admin-pass',
        MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret',
      },
    );

    expect(capability.status).toBe(413);
    expect(await capability.json()).toEqual({ error: 'Request body too large' });
    expect(admin.status).toBe(413);
    expect(await admin.json()).toEqual({ error: 'Request body too large' });
  });

  it('bounds chunked realtime JSON even without a Content-Length header', async () => {
    const oversized = JSON.stringify({
      action: 'new-session',
      payload: { padding: 'x'.repeat(128 * 1024) },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(oversized);
        controller.enqueue(bytes.slice(0, 64 * 1024));
        controller.enqueue(bytes.slice(64 * 1024));
        controller.close();
      },
    });
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/cloudflare-realtime', {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.92',
        },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      {
        MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
        CLOUDFLARE_REALTIME_APP_ID: 'test-app',
        CLOUDFLARE_REALTIME_APP_SECRET: 'test-secret',
      },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Request body too large' });
  });
});

describe('Cloudflare Realtime session ownership boundary', () => {
  const ip = '203.0.113.93';
  const env = {
    MXQR_CAPABILITY_SECRET: 'test-capability-secret',
    MXQR_TURNSTILE_DISABLED: 'true',
    MXQR_CAPABILITY_POW_DIFFICULTY: '8',
    CLOUDFLARE_REALTIME_APP_ID: 'test-app',
    CLOUDFLARE_REALTIME_APP_SECRET: 'test-realtime-secret',
  };

  async function realtimeRequest(
    capabilityToken: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return appWorker.fetch(
      new Request('https://musixquare.com/api/cloudflare-realtime', {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': ip,
          'X-MXQR-Capability': capabilityToken,
        },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  it('does not let a generic PoW capability mutate a disclosed publication session', async () => {
    let nextSession = 0;
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sessions/new')) {
        nextSession += 1;
        return Response.json({ sessionId: `session-${nextSession}` });
      }
      return Response.json({ tracks: [] });
    });
    vi.stubGlobal('fetch', upstreamFetch);

    const mint = await mintWithProofOfWork(env, ['realtime'], ip);
    const capabilityToken = ((await mint.json()) as { token: string }).token;
    expect(mint.status).toBe(200);

    const victimCreate = await realtimeRequest(capabilityToken, { action: 'new-session' });
    const victim = (await victimCreate.json()) as {
      sessionId: string;
      sessionOwnerToken: string;
    };
    expect(victimCreate.status).toBe(200);
    expect(victim.sessionOwnerToken).toMatch(/\./);

    for (const action of ['tracks-new', 'renegotiate', 'tracks-close']) {
      const attack = await realtimeRequest(capabilityToken, {
        action,
        sessionId: victim.sessionId,
        payload: {},
      });
      expect(attack.status).toBe(403);
      expect(await attack.json()).toEqual({ error: 'REALTIME_SESSION_CAPABILITY_REQUIRED' });
    }

    const attackerCreate = await realtimeRequest(capabilityToken, { action: 'new-session' });
    const attacker = (await attackerCreate.json()) as {
      sessionId: string;
      sessionOwnerToken: string;
    };
    const crossSessionAttack = await realtimeRequest(capabilityToken, {
      action: 'tracks-close',
      sessionId: victim.sessionId,
      sessionOwnerToken: attacker.sessionOwnerToken,
      payload: { tracks: [{ mid: '0' }], force: true },
    });
    expect(crossSessionAttack.status).toBe(403);

    const ownerClose = await realtimeRequest(capabilityToken, {
      action: 'tracks-close',
      sessionId: victim.sessionId,
      sessionOwnerToken: victim.sessionOwnerToken,
      payload: { tracks: [{ mid: '0' }], force: true },
    });
    expect(ownerClose.status).toBe(200);

    // Only the two session creations and the legitimate owner close reach
    // Cloudflare; all arbitrary-session mutations stop at our edge worker.
    expect(upstreamFetch).toHaveBeenCalledTimes(3);
    const ownerCloseUpstream = upstreamFetch.mock.calls[2];
    expect(JSON.parse(String(ownerCloseUpstream[1]?.body))).toEqual({
      tracks: [{ mid: '0' }],
      force: true,
    });
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

describe('Cloudflare app worker YouTube playlist entry proxy', () => {
  const playlistRequest = (playlistId = 'PL_VALID_01', ip = '203.0.113.81') =>
    new Request(
      `https://musixquare.com/api/youtube-playlist-entry?playlistId=${encodeURIComponent(playlistId)}`,
      {
        headers: {
          Origin: 'https://musixquare.com',
          'CF-Connecting-IP': ip,
        },
      },
    );

  it('returns the first concrete public entry with an exact, minimal response shape', async () => {
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://www.googleapis.com/youtube/v3/playlistItems',
      );
      expect(url.searchParams.get('playlistId')).toBe('PL_VALID_01');
      expect(url.searchParams.get('maxResults')).toBe('50');
      return Response.json({
        items: [
          {
            contentDetails: { videoId: 'PRIVATE0001' },
            snippet: { title: 'Private video' },
            status: { privacyStatus: 'private' },
          },
          {
            contentDetails: { videoId: 'DELETED0001' },
            snippet: { title: 'Deleted video' },
            status: { privacyStatus: 'public' },
          },
          {
            contentDetails: { videoId: 'PLAYABLE001' },
            snippet: { title: 'First &amp; Playable' },
            status: { privacyStatus: 'public' },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', upstreamFetch);

    const response = await appWorker.fetch(playlistRequest(), {
      MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
      YOUTUBE_API_KEY: 'test-key',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      playlistId: 'PL_VALID_01',
      videoId: 'PLAYABLE001',
      title: 'First & Playable',
    });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed without capability configuration and rejects malformed IDs', async () => {
    const guarded = await appWorker.fetch(playlistRequest(), { YOUTUBE_API_KEY: 'test-key' });
    expect(guarded.status).toBe(503);
    expect(await guarded.json()).toEqual({ error: 'CAPABILITY_NOT_CONFIGURED' });

    const malformed = await appWorker.fetch(playlistRequest('bad/id'), {
      MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
      YOUTUBE_API_KEY: 'test-key',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'INVALID_YOUTUBE_PLAYLIST_ID' });
  });

  it('applies an independent twenty-request per-minute guard', async () => {
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
    const upstreamFetch = vi.fn(async () =>
      Response.json({
        items: [
          {
            contentDetails: { videoId: 'PLAYABLE001' },
            snippet: { title: 'Playable' },
            status: { privacyStatus: 'public' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', upstreamFetch);
    const env = {
      MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
      YOUTUBE_API_KEY: 'test-key',
    };

    for (let index = 0; index < 20; index += 1) {
      expect((await appWorker.fetch(playlistRequest(), env)).status).toBe(200);
    }
    const limited = await appWorker.fetch(playlistRequest(), env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(upstreamFetch).toHaveBeenCalledTimes(20);
  });
});

describe('Cloudflare app worker admin dashboard', () => {
  function createMetricsDb(rows: Array<{ bucket_minute: number; event: string; count: number }>) {
    return {
      prepare: vi.fn(() => ({
        bind: vi.fn((sinceMinute: number) => ({
          all: vi.fn(async () => ({
            results: rows.filter((row) => row.bucket_minute >= sinceMinute),
          })),
        })),
      })),
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

  function createSoroRssWithScriptBoundaryCharacters() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title><![CDATA[Boundary </script><script src="https://app.trysoro.com/pwn.js"></script> <tag> & \u2028 \u2029]]></title>
      <link>https://musixquare.com/blog?post=boundary-article</link>
      <description><![CDATA[Description </script> <tag> & \u2028 \u2029]]></description>
      <pubDate>Thu, 18 Jun 2026 12:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>Boundary body</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;
  }

  function createSoroRssWithUnsafeArticleHtml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Sanitized Article</title>
      <link>https://musixquare.com/blog?post=sanitized-article</link>
      <description>Sanitized description</description>
      <pubDate>Thu, 18 Jun 2026 12:00:00 GMT</pubDate>
      <content:encoded><![CDATA[
        <h2>Safe heading</h2>
        <p onclick="alert(1)" style="display:none">Safe body</p>
        <script>alert('rss')</script>
        <a href="javascript:alert(1)">Unsafe link</a>
        <a href="https://example.com/read?a=1&amp;b=2" target="_blank">Safe link</a>
      ]]></content:encoded>
    </item>
  </channel>
</rss>`;
  }

  it('does not treat the legacy unsalted SHA-256 fallback as an admin credential', async () => {
    const env = {
      MXQR_ADMIN_PASSWORD_SHA256: 'sha256:legacy-digest',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret',
    };

    const page = await appWorker.fetch(new Request('https://musixquare.com/admin'), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-admin-configured="false"');

    const login = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.80' },
        body: JSON.stringify({ password: 'legacy-password' }),
      }),
      env,
    );
    expect(login.status).toBe(503);
    expect(await login.json()).toEqual({ error: 'ADMIN_NOT_CONFIGURED' });
  });

  it('sets an HttpOnly admin session cookie and serves D1-backed metrics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    const nowMinute = Math.floor(Date.now() / 60000);
    const env = {
      MXQR_ADMIN_PASSWORD: 'admin-pass',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret',
      MUSIXQUARE_ADMIN_DB: createMetricsDb([
        { bucket_minute: nowMinute - 31 * 24 * 60, event: 'guest_joined', count: 99 },
        { bucket_minute: nowMinute - 29 * 24 * 60, event: 'guest_joined', count: 4 },
        { bucket_minute: nowMinute - 5, event: 'room_opened', count: 3 },
        { bucket_minute: nowMinute - 4, event: 'guest_joined', count: 7 },
        { bucket_minute: nowMinute - 3, event: 'guest_auth_failed', count: 1 },
        { bucket_minute: nowMinute - 2, event: 'guest_room_full', count: 2 },
        { bucket_minute: nowMinute - 2, event: 'guest_reconnect_denied', count: 5 },
        { bucket_minute: nowMinute - 2, event: 'guest_reconnect_conflict', count: 8 },
        { bucket_minute: nowMinute - 2, event: 'guest_pending_capacity', count: 6 },
        { bucket_minute: nowMinute - 2, event: 'guest_identity_capacity', count: 7 },
        { bucket_minute: nowMinute - 1, event: 'ws_message_oversized', count: 3 },
        { bucket_minute: nowMinute, event: 'ws_message_rate_limited', count: 4 },
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
    expect(payload.summary?.last24?.guest_room_full).toBe(2);
    expect(payload.summary?.last24?.guest_reconnect_denied).toBe(5);
    expect(payload.summary?.last24?.guest_reconnect_conflict).toBe(8);
    expect(payload.summary?.last24?.guest_pending_capacity).toBe(6);
    expect(payload.summary?.last24?.guest_identity_capacity).toBe(7);
    expect(payload.summary?.last24?.ws_message_oversized).toBe(3);
    expect(payload.summary?.last24?.ws_message_rate_limited).toBe(4);
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

  it('sanitizes untrusted RSS article HTML before inserting it into the blog shell', async () => {
    const env = {
      SORO_RSS_BACKUP: createKvStore(),
      ASSETS: {
        fetch: vi.fn(
          async () =>
            new Response('<html><head></head><body><div id="soro-blog"></div></body></html>', {
              headers: { 'Content-Type': 'text/html' },
            }),
        ),
      },
    };
    await env.SORO_RSS_BACKUP.put('soro-rss-latest-good.xml', createSoroRssWithUnsafeArticleHtml());

    const response = await appWorker.fetch(
      new Request('https://musixquare.com/blog/sanitized-article'),
      env,
      { waitUntil: vi.fn() } as any,
    );
    const html = await response.text();
    const articleContent =
      html.match(/<div class="soro-blog-article-content">([\s\S]*?)<\/div>/)?.[1] || '';

    expect(response.status).toBe(200);
    expect(articleContent).toContain('<h2>Safe heading</h2>');
    expect(articleContent).toContain('<p>Safe body</p>');
    expect(articleContent).toContain('<a>Unsafe link</a>');
    expect(articleContent).toContain(
      '<a href="https://example.com/read?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Safe link</a>',
    );
    expect(articleContent).not.toMatch(/<(?:script|style|iframe|object|svg|math)\b/i);
    expect(articleContent).not.toMatch(/\bon[a-z]+\s*=|\sstyle\s*=|javascript:/i);
  });

  it.each([
    {
      renderer: 'blog shell template',
      contentType: 'text/html',
      shell: '<html><head></head><body><div id="soro-blog"></div></body></html>',
    },
    {
      renderer: 'standalone fallback',
      contentType: 'application/octet-stream',
      shell: '',
    },
  ])(
    'escapes JSON-LD script boundaries in the $renderer renderer',
    async ({ contentType, shell }) => {
      const env = {
        SORO_RSS_BACKUP: createKvStore(),
        ASSETS: {
          fetch: vi.fn(
            async () =>
              new Response(shell, {
                headers: { 'Content-Type': contentType },
              }),
          ),
        },
      };
      await env.SORO_RSS_BACKUP.put(
        'soro-rss-latest-good.xml',
        createSoroRssWithScriptBoundaryCharacters(),
      );

      const response = await appWorker.fetch(
        new Request('https://musixquare.com/blog/boundary-article'),
        env,
      );
      const html = await response.text();
      const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);

      expect(response.status).toBe(200);
      const cspDirectives = (response.headers.get('Content-Security-Policy') || '')
        .split(';')
        .map((directive) => directive.trim());
      expect(cspDirectives.find((directive) => directive.startsWith('script-src'))).not.toContain(
        'trysoro.com',
      );
      expect(cspDirectives.find((directive) => directive.startsWith('frame-src'))).not.toContain(
        'trysoro.com',
      );
      expect(jsonLdMatch).not.toBeNull();
      const serializedJsonLd = jsonLdMatch?.[1] || '';
      expect(serializedJsonLd).not.toMatch(/[<>&\u2028\u2029]/u);
      expect(serializedJsonLd).toContain('\\u003c/script\\u003e');
      expect(serializedJsonLd).toContain('\\u003ctag\\u003e');
      expect(serializedJsonLd).toContain('\\u0026');
      expect(serializedJsonLd).toContain('\\u2028');
      expect(serializedJsonLd).toContain('\\u2029');
      expect(JSON.parse(serializedJsonLd)).toMatchObject({
        headline:
          'Boundary </script><script src="https://app.trysoro.com/pwn.js"></script> <tag> & \u2028 \u2029',
        description: 'Description </script> <tag> & \u2028 \u2029',
      });
    },
  );

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

  it('registers PRO rooms and issues claims through the cross-script Durable Object binding', async () => {
    type RegistryRow = {
      room_code: string;
      label: string;
      status: string;
      activation_state: string;
      created_at: number;
      updated_at: number;
    };
    const rows = new Map<string, RegistryRow>();
    let failAudit = false;
    const audits: Array<{
      actorId: string;
      action: string;
      result: string;
      roomCode: string;
      createdAt: number;
    }> = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        const executeRun = (...values: unknown[]) => {
          if (/INSERT OR IGNORE/i.test(sql)) {
            const [roomCode, label, timestamp, limit] = values as [string, string, number, number?];
            if (rows.has(roomCode)) return { meta: { changes: 0 } };
            if (/SELECT COUNT\(\*\)/i.test(sql) && rows.size >= Number(limit)) {
              return { meta: { changes: 0 } };
            }
            rows.set(roomCode, {
              room_code: roomCode,
              label,
              status: /'provisioning'/i.test(sql) ? 'provisioning' : 'registered',
              activation_state: 'unactivated',
              created_at: timestamp,
              updated_at: timestamp,
            });
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO mxqr_pro_room_admin_audit/i.test(sql)) {
            if (failAudit) throw new Error('audit unavailable');
            const [actorId, action, result, roomCode, createdAt] = values as [
              string,
              string,
              string,
              string,
              number,
            ];
            audits.push({ actorId, action, result, roomCode, createdAt });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE/i.test(sql)) {
            const roomCode = String(values[0]);
            const row = rows.get(roomCode);
            if (row) {
              if (/SET status = 'registered'/i.test(sql)) {
                row.status = 'registered';
                row.activation_state = String(values[1]);
                row.updated_at = Number(values[2]);
              } else {
                row.activation_state = 'active';
                row.updated_at = Number(values[1]);
              }
            }
          }
          return { meta: { changes: 0 } };
        };
        const statement = {
          run: vi.fn(async () => executeRun()),
          bind: vi.fn((...values: unknown[]) => ({
            run: vi.fn(async () => executeRun(...values)),
            first: vi.fn(async () => rows.get(String(values[0])) || null),
            all: vi.fn(async () => ({
              results: /WHERE room_code/i.test(sql)
                ? [rows.get(String(values[0]))].filter(Boolean)
                : [...rows.values()].sort((left, right) =>
                    left.room_code.localeCompare(right.room_code),
                  ),
            })),
          })),
        };
        return statement;
      }),
    };
    const seen: Array<{ roomCode: string; url: string; authorization: string }> = [];
    const provisionAttempts = new Map<string, number>();
    const namespace = {
      idFromName: vi.fn((roomCode: string) => roomCode),
      get: vi.fn((roomCode: string) => ({
        fetch: vi.fn(async (request: Request) => {
          const url = new URL(request.url);
          seen.push({
            roomCode,
            url: url.pathname,
            authorization: request.headers.get('Authorization') || '',
          });
          if (url.pathname === '/internal/admin/provision') {
            const attempt = (provisionAttempts.get(roomCode) || 0) + 1;
            provisionAttempts.set(roomCode, attempt);
            if (roomCode === '000003' && attempt === 1) {
              return Response.json({ error: 'PROVISION_FAILED' }, { status: 503 });
            }
            return Response.json({ ok: true, roomCode, status: 'unactivated' });
          }
          if (url.pathname === '/internal/admin/status') {
            return Response.json({ roomCode, provisioned: true, status: 'active' });
          }
          if (roomCode === '000004') {
            return Response.json({ error: 'PRO_ROOM_ACTIVATION_UNAVAILABLE' }, { status: 409 });
          }
          return Response.json({
            roomCode,
            activationUrl: `https://musixquare.com/${roomCode}#pro-claim=secret-claim`,
            expiresAt: Date.now() + 15 * 60 * 1000,
          });
        }),
      })),
    };
    const env = {
      MXQR_ADMIN_PASSWORD: 'admin-pass',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret',
      MUSIXQUARE_ADMIN_DB: db,
      PRO_ROOM_ADMIN_ROOMS: namespace,
    };

    const unauthenticated = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms'),
      env,
    );
    expect(unauthenticated.status).toBe(401);
    expect(namespace.get).not.toHaveBeenCalled();

    const login = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.83' },
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      env,
    );
    const cookie = (login.headers.get('Set-Cookie') || '').split(';')[0];
    const adminHeaders = {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Cf-Access-Authenticated-User-Email': 'operator@example.com',
    };

    const list = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms', { headers: adminHeaders }),
      env,
    );
    expect(list.status).toBe(200);
    expect(list.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(await list.json()).toMatchObject({
      rooms: [{ roomCode: '000000' }, { roomCode: '000001' }],
    });

    const registered = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomCode: '000002', label: 'Friends' }),
      }),
      env,
    );
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({ room: { roomCode: '000002' } });

    const claim = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000002/activation-claim', {
        method: 'POST',
        headers: adminHeaders,
        body: '{}',
      }),
      env,
    );
    const claimPayload = (await claim.json()) as { activationUrl?: string };
    expect(claim.status).toBe(200);
    expect(claimPayload.activationUrl).toContain('#pro-claim=');

    failAudit = true;
    const withheldClaim = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000002/activation-claim', {
        method: 'POST',
        headers: adminHeaders,
        body: '{}',
      }),
      env,
    );
    expect(withheldClaim.status).toBe(503);
    expect(await withheldClaim.json()).toEqual({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' });
    failAudit = false;

    const incomplete = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomCode: '000003', label: 'Retry room' }),
      }),
      env,
    );
    expect(incomplete.status).toBe(503);
    expect(rows.get('000003')?.status).toBe('provisioning');

    const pendingList = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms', { headers: adminHeaders }),
      env,
    );
    const pendingPayload = (await pendingList.json()) as { rooms?: unknown[] };
    expect(pendingPayload.rooms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roomCode: '000003', status: 'provisioning' }),
      ]),
    );

    const recovered = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomCode: '000003', label: 'Retry room' }),
      }),
      env,
    );
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      room: { roomCode: '000003', status: 'registered' },
    });

    rows.set('000004', {
      room_code: '000004',
      label: 'Already active room',
      status: 'registered',
      activation_state: 'unactivated',
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const staleClaim = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000004/activation-claim', {
        method: 'POST',
        headers: adminHeaders,
        body: '{}',
      }),
      env,
    );
    expect(staleClaim.status).toBe(409);
    expect(rows.get('000004')?.activation_state).toBe('active');

    for (let index = 4; index < 1000; index += 1) {
      const roomCode = `0${String(index).padStart(5, '0')}`;
      rows.set(roomCode, {
        room_code: roomCode,
        label: `Room ${roomCode}`,
        status: 'registered',
        activation_state: 'unactivated',
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    }
    expect(rows.size).toBe(1000);
    const capacityReached = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomCode: '001000', label: 'Over capacity' }),
      }),
      env,
    );
    expect(capacityReached.status).toBe(409);
    expect(await capacityReached.json()).toEqual({ error: 'PRO_ROOM_REGISTRY_CAPACITY_REACHED' });

    expect(seen).toEqual([
      { roomCode: '000002', url: '/internal/admin/provision', authorization: '' },
      { roomCode: '000002', url: '/internal/admin/activation-claim', authorization: '' },
      { roomCode: '000002', url: '/internal/admin/activation-claim', authorization: '' },
      { roomCode: '000003', url: '/internal/admin/provision', authorization: '' },
      { roomCode: '000003', url: '/internal/admin/provision', authorization: '' },
      { roomCode: '000004', url: '/internal/admin/activation-claim', authorization: '' },
      { roomCode: '000004', url: '/internal/admin/status', authorization: '' },
    ]);
    expect(claim.headers.has('Authorization')).toBe(false);
    expect(audits).toMatchObject([
      { action: 'room.register', result: 'created', roomCode: '000002' },
      { action: 'activation_claim.issue', result: 'issued', roomCode: '000002' },
      { action: 'room.register', result: 'provision_failed', roomCode: '000003' },
      { action: 'room.register', result: 'provisioning_recovered', roomCode: '000003' },
      { action: 'activation_claim.issue', result: 'service_rejected', roomCode: '000004' },
      { action: 'room.register', result: 'registry_capacity_reached', roomCode: '001000' },
    ]);
    expect(audits.every((entry) => /^admin_[A-Za-z0-9_-]{32}$/.test(entry.actorId))).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('secret-claim');
    expect(JSON.stringify(audits)).not.toContain('pro-claim');
    expect(JSON.stringify(audits)).not.toContain('operator@example.com');
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
    expect(html).toContain('data-admin-tab="pro-rooms"');
    expect(html).toContain('data-pro-room-form');
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
