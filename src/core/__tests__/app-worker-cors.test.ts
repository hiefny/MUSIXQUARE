import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('requires a capability token when capability auth is enabled', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
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

  it('reports Turnstile as required when capability auth has no fallback', async () => {
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
      turnstileRequired: true,
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
    expect(await mint.json()).toEqual({ error: 'TURNSTILE_REQUIRED' });
  });

  it('mints short-lived capability tokens for trusted origins only with explicit fallback', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
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
    const payload = (await mint.json()) as { token?: string };

    expect(mint.status).toBe(200);
    expect(payload.token).toMatch(/\./);

    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/get-turn-config', {
        headers: {
          Origin: 'https://musixquare.com',
          'CF-Connecting-IP': ip,
          'X-MXQR-Capability': payload.token || '',
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({
      provider: 'metered-fallback',
    });
  });

  it('rejects same-origin-inferred capability fallback by default when Turnstile is configured', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
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
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
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

  it('reports Turnstile as disabled during the grace period even when keys exist', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
      MXQR_TURNSTILE_DISABLED: 'true',
      MXQR_ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK: 'true',
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
      inferredFallback: false,
    });
  });

  it('mints trusted-origin capability tokens while Turnstile is disabled', async () => {
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
      MXQR_TURNSTILE_DISABLED: 'true',
      MXQR_ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK: 'true',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
      TURN_USER: 'turn-user',
      TURN_PASS: 'turn-pass',
    };
    const ip = '203.0.113.28';

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
            new Response('<html><head></head><body><div id="soro-blog"></div></body></html>', {
              headers: { 'Content-Type': 'text/html' },
            }),
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
    expect(backupXml).toContain('Hidden Article');
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
