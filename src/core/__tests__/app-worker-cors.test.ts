import { afterEach, describe, expect, it, vi } from 'vitest';
import appWorker, {
  readResponseBodyLimitedForTests,
  purgeProRoomAccountAuthorityForTests,
  reconcileOwnerTransferSagasForTests,
  reconcileStaleAdminProRoomActivationsForTests,
  sanitizeSoroArticleHtmlForTests,
} from '../../../cloudflare/app-worker.js';
import { deriveDeveloperApiKeyDigest } from '../../../cloudflare/developer-api-worker.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Cloudflare app Worker PRO activation projection repair', () => {
  it('selects the oldest 25 stale projections instead of starving later room codes', async () => {
    const statusReads: string[] = [];
    const db = {
      prepare: vi.fn(() => ({
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
        bind: vi.fn(() => ({
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        })),
      })),
    };
    const env = {
      PRO_ROOM_ADMIN_ROOMS: {
        idFromName: vi.fn((roomCode: string) => roomCode),
        get: vi.fn(() => ({
          fetch: vi.fn(async (request: Request) => {
            const roomCode = request.headers.get('x-mxqr-pro-room-code') || '';
            statusReads.push(roomCode);
            return Response.json({
              roomCode,
              roomGeneration: 0,
              provisioned: true,
              status: 'active',
            });
          }),
        })),
      },
    };
    const rooms = Array.from({ length: 26 }, (_, index) => ({
      roomCode: String(index).padStart(6, '0'),
      roomGeneration: 0,
      status: 'registered',
      activationState: 'unactivated',
      updatedAt: 200 + index,
    }));
    // The final room code is oldest. A room-code-first slice would never
    // inspect it while the lower 25 remain canonically unactivated.
    rooms[25].updatedAt = 100;

    await expect(
      reconcileStaleAdminProRoomActivationsForTests(env, db, rooms, 100_000),
    ).resolves.toBe(true);
    expect(statusReads).toHaveLength(25);
    expect(statusReads).toContain('000025');
    expect(statusReads).not.toContain('000024');
  });
});

function requestWithOrigin(origin: string): Request {
  return new Request('https://musixquare.com/api/get-turn-config', {
    headers: { Origin: origin },
  });
}

function adminMutationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Origin: 'https://musixquare.com',
    'Content-Type': 'application/json',
    'X-MXQR-Admin-CSRF': '1',
    ...extra,
  };
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

describe('Soro bounded response reads', () => {
  it('counts UTF-8 bytes and cancels as soon as a chunk crosses the cap', async () => {
    const multibyteChunk = new TextEncoder().encode('한');
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(multibyteChunk);
          controller.enqueue(multibyteChunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readResponseBodyLimitedForTests(response, 5)).rejects.toThrow(
      'Response body exceeds 5 bytes',
    );
    expect(cancelled).toBe(true);
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

  async function runScheduled(env: Record<string, unknown>, event: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => pending.push(Promise.resolve(promise))),
    };
    await appWorker.scheduled(event, env, ctx);
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

  it('keeps the RSS deadline armed until the response body finishes', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null = null;
    let bodyCancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_resource: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal as AbortSignal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('<?xml version="1.0"?><rss>'));
            },
            cancel() {
              bodyCancelled = true;
            },
          }),
          { headers: { 'Content-Type': 'application/rss+xml' } },
        );
      }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { env, backup } = createScheduledEnv(vi.fn(async () => ({ success: true })));

    const { pending } = await runScheduled(env);
    await vi.advanceTimersByTimeAsync(2_501);

    await expect(Promise.all(pending)).resolves.toHaveLength(3);
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(bodyCancelled).toBe(true);
    expect(backup.put).not.toHaveBeenCalledWith('soro-rss-latest-good.xml', expect.anything());
  });

  it('cancels a chunked oversized image before reading the remaining body', async () => {
    const imageSource = 'https://app.trysoro.com/images/scheduled-article.webp';
    const rssWithImage = rss.replace(
      '<content:encoded>',
      `<enclosure url="${imageSource}" type="image/webp" /><content:encoded>`,
    );
    const imageChunk = new Uint8Array(1024 * 1024);
    let imagePulls = 0;
    let imageCancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (resource: RequestInfo | URL) => {
        if (String(resource) !== imageSource) {
          return new Response(rssWithImage, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              imagePulls += 1;
              if (imagePulls <= 8) controller.enqueue(imageChunk);
              else controller.close();
            },
            cancel() {
              imageCancelled = true;
            },
          }),
          { headers: { 'Content-Type': 'image/webp' } },
        );
      }),
    );
    const imagePut = vi.fn(async () => undefined);
    const { env } = createScheduledEnv(vi.fn(async () => ({ success: true })));
    Object.assign(env, {
      SORO_IMAGE_BUCKET: {
        head: vi.fn(async () => null),
        put: imagePut,
      },
    });

    const { pending } = await runScheduled(env);
    await expect(Promise.all(pending)).resolves.toHaveLength(3);

    expect(imageCancelled).toBe(true);
    expect(imagePulls).toBeLessThan(8);
    expect(imagePut).not.toHaveBeenCalled();
  });

  it('uses the minute trigger only to resume durable account deletion jobs', async () => {
    const all = vi.fn(async () => ({ results: [] }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const { ctx, pending } = await runScheduled(
      { MUSIXQUARE_AUTH_DB: { prepare } },
      { cron: '* * * * *' },
    );

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(pending);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('FROM mxqr_account_deletions'));
  });

  it('retires reverse edges when a room alarm completed decommissioning without admin polling', async () => {
    const authRuns: Array<{ sql: string; values: unknown[] }> = [];
    const authDb = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          all: async () => ({ results: [] }),
          run: async () => {
            authRuns.push({ sql, values });
            return { success: true, meta: { changes: 1 } };
          },
        }),
      }),
    };
    const adminDb = {
      prepare: (_sql: string) => ({
        bind: (..._values: unknown[]) => ({
          all: async () => ({
            results: [{ room_code: '000123', room_generation: 7 }],
          }),
        }),
      }),
    };
    const { ctx, pending } = await runScheduled(
      {
        MUSIXQUARE_AUTH_DB: authDb,
        MUSIXQUARE_ADMIN_DB: adminDb,
      },
      { cron: '* * * * *' },
    );

    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
    await Promise.all(pending);
    expect(authRuns).toEqual([
      {
        sql: expect.stringContaining('DELETE FROM mxqr_account_pro_room_generations'),
        values: ['000123', 7],
      },
    ]);
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

describe('Cloudflare app worker WebAssembly CSP', () => {
  function directive(csp: string, name: string): string[] {
    const match = csp
      .split(';')
      .map((value) => value.trim().split(/\s+/))
      .find(([directiveName]) => directiveName === name);
    return match ?? [];
  }

  it('allows WebAssembly compilation without enabling JavaScript eval or broadening workers', async () => {
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/security-config'),
      {},
    );
    const csp = response.headers.get('Content-Security-Policy') || '';
    const scriptSrc = directive(csp, 'script-src');
    const workerSrc = directive(csp, 'worker-src');

    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(workerSrc).toEqual(['worker-src', "'self'", 'blob:']);
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBeNull();
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBeNull();
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

  it('allows separate 100-device TURN and realtime capability bursts without raising unrelated scope limits', async () => {
    // Keep all sequential requests in one rate-limit bucket even when the full
    // suite starts this test immediately before a real wall-clock minute edge.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T00:00:30.000Z'));
    installRateLimitCache();
    const env = {
      MXQR_CAPABILITY_SECRET: 'test-capability-secret',
      MXQR_TURNSTILE_DISABLED: 'true',
      MXQR_CAPABILITY_POW_DIFFICULTY: '8',
    };
    const challengeRequest = (scopes: string[], ip: string) =>
      appWorker.fetch(
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
    const tokenRequest = (scopes: string[], ip: string) =>
      appWorker.fetch(
        new Request('https://musixquare.com/api/capability-token', {
          method: 'POST',
          headers: {
            Origin: 'https://musixquare.com',
            'Content-Type': 'application/json',
            'CF-Connecting-IP': ip,
          },
          // An absent proof is intentionally rejected after the rate gate. We
          // only assert that the room-sized burst is not rejected as 429.
          body: JSON.stringify({ scopes }),
        }),
        env,
      );

    for (const scope of ['turn', 'realtime']) {
      for (let index = 0; index < 100; index += 1) {
        expect((await challengeRequest([scope], '203.0.113.110')).status).toBe(200);
        expect((await tokenRequest([scope], '203.0.113.110')).status).toBe(403);
      }
    }

    for (let index = 0; index < 30; index += 1) {
      expect((await challengeRequest(['remote-share'], '203.0.113.111')).status).toBe(200);
    }
    expect((await challengeRequest(['remote-share'], '203.0.113.111')).status).toBe(429);
  });

  it('admits 100 same-NAT clients through TURN plus one full SFU recovery cycle', async () => {
    installRateLimitCache();
    const ip = '203.0.113.120';
    const capabilitySecret = 'same-nat-capability-secret';
    const env = {
      MXQR_CAPABILITY_SECRET: capabilitySecret,
      MXQR_TURNSTILE_DISABLED: 'true',
      CLOUDFLARE_TURN_KEY_ID: 'turn-key',
      CLOUDFLARE_TURN_API_TOKEN: 'turn-token',
      CLOUDFLARE_REALTIME_APP_ID: 'test-app',
      CLOUDFLARE_REALTIME_APP_SECRET: 'test-realtime-secret',
    };
    let nextSession = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/turn/keys/')) {
          return Response.json({
            iceServers: [
              {
                urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
                username: 'turn-user',
                credential: 'turn-credential',
              },
            ],
          });
        }
        if (url.includes('/sessions/new')) {
          nextSession += 1;
          return Response.json({ sessionId: `same-nat-session-${nextSession}` });
        }
        return Response.json({});
      }),
    );

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(capabilitySecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sign = async (value: string) => {
      const signature = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, encoder.encode(value)),
      );
      let binary = '';
      for (const byte of signature) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    };
    const encodePayload = (value: unknown) => {
      const bytes = encoder.encode(JSON.stringify(value));
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    };
    const now = Math.floor(Date.now() / 1000);
    const ipHash = await sign(`ip:${ip}`);
    const capabilityTokens = await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const payloadPart = encodePayload({
          v: 1,
          scopes: ['realtime', 'turn'],
          iat: now,
          exp: now + 600,
          ip: ipHash,
          jti: `same-nat-${index}`,
        });
        return `${payloadPart}.${await sign(payloadPart)}`;
      }),
    );
    const request = (url: string, token: string, body?: Record<string, unknown>) =>
      appWorker.fetch(
        new Request(url, {
          method: body ? 'POST' : 'GET',
          headers: {
            Origin: 'https://musixquare.com',
            'Content-Type': 'application/json',
            'CF-Connecting-IP': ip,
            'X-MXQR-Capability': token,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        env,
      );

    for (const token of capabilityTokens) {
      expect((await request('https://musixquare.com/api/get-turn-config', token)).status).toBe(200);
    }

    const sessions: Array<{ token: string; sessionId: string; sessionOwnerToken: string }> = [];
    // Every browser creates an initial subscription/publication session and
    // one successor for the single bounded host retry: 200 sessions behind
    // the same venue IP, still individually bounded by capability.
    for (let generation = 0; generation < 2; generation += 1) {
      for (const token of capabilityTokens) {
        const response = await request('https://musixquare.com/api/cloudflare-realtime', token, {
          action: 'new-session',
        });
        expect(response.status).toBe(200);
        const session = (await response.json()) as {
          sessionId: string;
          sessionOwnerToken: string;
        };
        sessions.push({ token, ...session });
      }
    }

    // Each initial/successor session performs tracks-new, renegotiate, and
    // explicit tracks-close. 600 mutations leave deliberate operating
    // headroom below the 650/IP recovery ceiling.
    for (let round = 0; round < 3; round += 1) {
      for (const session of sessions) {
        const response = await request(
          'https://musixquare.com/api/cloudflare-realtime',
          session.token,
          {
            action: 'renegotiate',
            sessionId: session.sessionId,
            sessionOwnerToken: session.sessionOwnerToken,
            payload: {},
          },
        );
        expect(response.status).toBe(200);
      }
    }
    // This deliberately executes 900 independently authenticated Worker
    // requests. WebCrypto shares a finite worker pool with Vitest, so a full
    // file-parallel run can take materially longer than the same spec in
    // isolation even though the assertions and production limits are
    // unchanged. Keep the regression realistic without making the suite
    // timing-sensitive to the runner's current CPU contention.
  }, 60_000);
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
        headers: adminMutationHeaders({ 'CF-Connecting-IP': '203.0.113.91' }),
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

  function installRealtimeRateLimitCache() {
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

  it('keeps the same-IP room burst bounded per browser capability', async () => {
    installRealtimeRateLimitCache();
    let nextSession = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        nextSession += 1;
        return Response.json({ sessionId: `rate-session-${nextSession}` });
      }),
    );
    const mint = await mintWithProofOfWork(env, ['realtime'], ip);
    const capabilityToken = ((await mint.json()) as { token: string }).token;

    for (let index = 0; index < 4; index += 1) {
      expect((await realtimeRequest(capabilityToken, { action: 'new-session' })).status).toBe(200);
    }
    const blocked = await realtimeRequest(capabilityToken, { action: 'new-session' });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'Too Many Requests' });
  });

  it('bounds mutations per issued session without restoring the old 30-request IP ceiling', async () => {
    installRealtimeRateLimitCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/sessions/new')
          ? Response.json({ sessionId: 'mutation-rate-session' })
          : Response.json({}),
      ),
    );
    const mint = await mintWithProofOfWork(env, ['realtime'], ip);
    const capabilityToken = ((await mint.json()) as { token: string }).token;
    const created = await realtimeRequest(capabilityToken, { action: 'new-session' });
    const publication = (await created.json()) as {
      sessionId: string;
      sessionOwnerToken: string;
    };

    for (let index = 0; index < 8; index += 1) {
      expect(
        (
          await realtimeRequest(capabilityToken, {
            action: 'renegotiate',
            sessionId: publication.sessionId,
            sessionOwnerToken: publication.sessionOwnerToken,
            payload: {},
          })
        ).status,
      ).toBe(200);
    }
    const blocked = await realtimeRequest(capabilityToken, {
      action: 'renegotiate',
      sessionId: publication.sessionId,
      sessionOwnerToken: publication.sessionOwnerToken,
      payload: {},
    });
    expect(blocked.status).toBe(429);
  });

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
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const upstreamUrl = new URL(String(input));
        expect(upstreamUrl.searchParams.has('key')).toBe(false);
        expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-key');
        return Response.json({
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
        });
      }),
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
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://www.googleapis.com/youtube/v3/playlistItems',
      );
      expect(url.searchParams.get('playlistId')).toBe('PL_VALID_01');
      expect(url.searchParams.get('maxResults')).toBe('50');
      expect(url.searchParams.has('key')).toBe(false);
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-key');
      return Response.json({
        nextPageToken: 'IGNORED_BY_FAST_ENTRY_ROUTE',
        pageInfo: { totalResults: 2 },
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

describe('Cloudflare app worker YouTube playlist manifest proxy', () => {
  const manifestRequest = (playlistId = 'PL_MANIFEST_01') =>
    new Request(
      `https://musixquare.com/api/youtube-playlist-manifest?playlistId=${encodeURIComponent(playlistId)}`,
      {
        headers: {
          Origin: 'https://musixquare.com',
          'CF-Connecting-IP': '203.0.113.91',
        },
      },
    );
  const env = {
    MXQR_ALLOW_UNGUARDED_PAID_APIS: 'true',
    YOUTUBE_API_KEY: 'test-key',
  };

  it('paginates the complete ordered playable manifest and preserves duplicate videos', async () => {
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('maxResults')).toBe('50');
      expect(url.searchParams.get('playlistId')).toBe('PL_MANIFEST_01');
      if (!url.searchParams.has('pageToken')) {
        return Response.json({
          pageInfo: { totalResults: 5 },
          nextPageToken: 'NEXT_PAGE',
          items: [
            {
              contentDetails: { videoId: 'AAAAAAAAAAA' },
              snippet: { title: 'First &amp; playable' },
              status: { privacyStatus: 'public' },
            },
            {
              contentDetails: { videoId: 'PRIVATE0001' },
              snippet: { title: 'Private video' },
              status: { privacyStatus: 'private' },
            },
            {
              contentDetails: { videoId: 'BBBBBBBBBBB' },
              snippet: { title: 'Second' },
              status: { privacyStatus: 'public' },
            },
          ],
        });
      }
      expect(url.searchParams.get('pageToken')).toBe('NEXT_PAGE');
      return Response.json({
        pageInfo: { totalResults: 5 },
        items: [
          {
            contentDetails: { videoId: 'CCCCCCCCCCC' },
            snippet: { title: 'Third' },
            status: { privacyStatus: 'public' },
          },
          {
            contentDetails: { videoId: 'CCCCCCCCCCC' },
            snippet: { title: 'Third again' },
            status: { privacyStatus: 'public' },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', upstreamFetch);

    const response = await appWorker.fetch(manifestRequest(), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      playlistId: 'PL_MANIFEST_01',
      videoId: 'AAAAAAAAAAA',
      videoIds: ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC', 'CCCCCCCCCCC'],
      title: 'First & playable',
    });
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly when the upstream manifest is too large or incomplete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ pageInfo: { totalResults: 5_001 }, items: [] })),
    );
    const tooLarge = await appWorker.fetch(manifestRequest(), env);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: 'YOUTUBE_PLAYLIST_MANIFEST_TOO_LARGE' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          pageInfo: { totalResults: 2 },
          items: [
            {
              contentDetails: { videoId: 'AAAAAAAAAAA' },
              snippet: { title: 'Only returned item' },
              status: { privacyStatus: 'public' },
            },
          ],
        }),
      ),
    );
    const incomplete = await appWorker.fetch(manifestRequest(), env);
    expect(incomplete.status).toBe(502);
    expect(await incomplete.json()).toEqual({ error: 'YOUTUBE_PLAYLIST_MANIFEST_INCOMPLETE' });
  });

  it('fails closed on malformed pages and preserves upstream failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ pageInfo: {}, items: [] })),
    );
    const malformed = await appWorker.fetch(manifestRequest(), env);
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toEqual({ error: 'YOUTUBE_PLAYLIST_MANIFEST_INCOMPLETE' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: { errors: [{ reason: 'backendError' }] } }, { status: 500 }),
      ),
    );
    const upstreamError = await appWorker.fetch(manifestRequest(), env);
    expect(upstreamError.status).toBe(502);
    expect(await upstreamError.json()).toEqual({
      error: 'YOUTUBE_PLAYLIST_RESOLUTION_FAILED',
      upstreamStatus: 500,
      reason: 'backendError',
    });
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
        headers: adminMutationHeaders({ 'CF-Connecting-IP': '203.0.113.80' }),
        body: JSON.stringify({ password: 'legacy-password' }),
      }),
      env,
    );
    expect(login.status).toBe(503);
    expect(await login.json()).toEqual({ error: 'ADMIN_NOT_CONFIGURED' });
  });

  it('rejects same-site and cross-site admin mutations without the exact JSON CSRF envelope', async () => {
    const env = {
      MXQR_ADMIN_PASSWORD: 'admin-pass',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret',
    };
    const cases = [
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: { Origin: 'https://pro.musixquare.com', 'Content-Type': 'text/plain' },
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: {
          Origin: 'https://pro.musixquare.com',
          'Content-Type': 'application/json',
          'X-MXQR-Admin-CSRF': '1',
        },
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: { Origin: 'https://musixquare.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
    ];

    const responses = await Promise.all(cases.map((request) => appWorker.fetch(request, env)));
    expect(responses.map((response) => response.status)).toEqual([415, 403, 403]);
    await expect(responses[0].json()).resolves.toEqual({ error: 'ADMIN_JSON_REQUIRED' });
    await expect(responses[1].json()).resolves.toEqual({ error: 'ADMIN_CSRF_REJECTED' });
    await expect(responses[2].json()).resolves.toEqual({ error: 'ADMIN_CSRF_REJECTED' });
  });

  it('sets an HttpOnly admin session cookie and serves current D1-backed metrics', async () => {
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
        { bucket_minute: nowMinute - 5, event: 'host_legacy_url_auth', count: 2 },
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
        headers: adminMutationHeaders({ 'CF-Connecting-IP': '203.0.113.81' }),
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
    expect(payload.summary?.last24?.host_legacy_url_auth).toBeUndefined();
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
        headers: adminMutationHeaders({ 'CF-Connecting-IP': '203.0.113.82' }),
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
        headers: adminMutationHeaders({ Cookie: cookie }),
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
        headers: adminMutationHeaders({ 'CF-Connecting-IP': '203.0.113.82' }),
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      env,
    );
    const cookie = login.headers.get('Set-Cookie')?.split(';')[0] || '';

    const pastExpiry = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/announcement', {
        method: 'POST',
        headers: adminMutationHeaders({ Cookie: cookie }),
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
        headers: adminMutationHeaders({ Cookie: cookie }),
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
      active?: boolean;
      history?: Array<{ action?: string; enabled?: boolean; message?: string }>;
    };

    expect(save.status).toBe(200);
    expect(saved.announcement?.enabled).toBe(true);
    expect(saved.active).toBe(true);
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
      active?: boolean;
      history?: Array<{ action?: string; enabled?: boolean; message?: string }>;
    };
    expect(adminPayload.active).toBe(true);
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
        headers: adminMutationHeaders({ Cookie: cookie }),
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
      suspension_reason?: string | null;
      activation_state: string;
      room_generation: number;
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
      roomGeneration: number;
      createdAt: number;
    }> = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        const executeRun = (...values: unknown[]) => {
          if (/INSERT OR IGNORE INTO mxqr_pro_room_registry/i.test(sql)) {
            const [roomCode, label, timestamp, limit] = values as [string, string, number, number?];
            if (rows.has(roomCode)) return { meta: { changes: 0 } };
            const activeCount = [...rows.values()].filter(
              (row) => row.status !== 'decommissioned',
            ).length;
            if (/SELECT COUNT\(\*\)/i.test(sql) && activeCount >= Number(limit)) {
              return { meta: { changes: 0 } };
            }
            rows.set(roomCode, {
              room_code: roomCode,
              label,
              status: /'provisioning'/i.test(sql) ? 'provisioning' : 'registered',
              activation_state: 'unactivated',
              room_generation: 0,
              created_at: timestamp,
              updated_at: timestamp,
            });
            return { meta: { changes: 1 } };
          }
          if (/^\s*INSERT INTO mxqr_pro_room_admin_audit/i.test(sql)) {
            if (failAudit) throw new Error('audit unavailable');
            const [actorId, action, result, roomCode, roomGeneration, createdAt] = values as [
              string,
              string,
              string,
              string,
              number,
              number,
            ];
            audits.push({ actorId, action, result, roomCode, roomGeneration, createdAt });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE/i.test(sql)) {
            const roomCode = String(values[0]);
            const row = rows.get(roomCode);
            if (
              row &&
              (!/room_generation = \?2/i.test(sql) || row.room_generation === Number(values[1]))
            ) {
              if (/SET status = 'registered'/i.test(sql)) {
                row.status = 'registered';
                row.suspension_reason = null;
                row.activation_state = String(values[2]);
                row.updated_at = Number(values[3]);
              } else if (/SET status = \?3/i.test(sql)) {
                row.status = String(values[2]);
                row.suspension_reason = values[3] == null ? null : String(values[3]);
                row.activation_state = 'active';
                row.updated_at = Number(values[4]);
              } else if (/SET status = 'suspended'/i.test(sql)) {
                row.status = 'suspended';
                row.suspension_reason = String(values[2]);
                row.activation_state = 'active';
                row.updated_at = Number(values[3]);
              } else {
                row.activation_state = 'active';
                row.updated_at = Number(values[2]);
              }
              return { meta: { changes: 1 } };
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
    const seen: Array<{
      roomCode: string;
      roomGeneration: string;
      url: string;
      authorization: string;
    }> = [];
    const provisionAttempts = new Map<string, number>();
    const namespace = {
      idFromName: vi.fn((roomCode: string) => roomCode),
      get: vi.fn((objectName: string) => ({
        fetch: vi.fn(async (request: Request) => {
          const url = new URL(request.url);
          const roomCode = request.headers.get('x-mxqr-pro-room-code') || '';
          const generationHeader = request.headers.get('x-mxqr-pro-room-generation');
          const roomGeneration = Number(generationHeader ?? '0');
          expect(generationHeader).toBe('0');
          seen.push({
            roomCode: objectName,
            roomGeneration: String(roomGeneration),
            url: url.pathname,
            authorization: request.headers.get('Authorization') || '',
          });
          if (url.pathname === '/internal/admin/provision') {
            const attempt = (provisionAttempts.get(roomCode) || 0) + 1;
            provisionAttempts.set(roomCode, attempt);
            if (roomCode === '000003' && attempt === 1) {
              return Response.json({ error: 'PROVISION_FAILED' }, { status: 503 });
            }
            return Response.json({
              ok: true,
              roomCode,
              roomGeneration,
              status: 'unactivated',
            });
          }
          if (url.pathname === '/internal/admin/status') {
            return Response.json({
              roomCode,
              roomGeneration,
              provisioned: true,
              status: 'active',
            });
          }
          if (url.pathname === '/internal/admin/suspend') {
            return Response.json({
              ok: true,
              roomCode,
              roomGeneration,
              status: 'suspended',
              suspensionReason: 'operator_suspended',
              changed: true,
            });
          }
          if (url.pathname === '/internal/admin/resume') {
            return Response.json({
              ok: true,
              roomCode,
              roomGeneration,
              status: 'active',
              suspensionReason: null,
              changed: true,
            });
          }
          if (url.pathname === '/internal/admin/owner-recovery-claim') {
            return Response.json({
              roomCode,
              roomGeneration,
              recoveryUrl:
                roomCode === '000005'
                  ? `https://musixquare.com.evil/${roomCode}#pro-recovery=v1.payload.signature`
                  : `https://musixquare.com/${roomCode}#pro-recovery=v1.payload.signature`,
              expiresAt: Date.now() + 10 * 60 * 1000,
              ownerAccountLinked: roomCode === '000002',
            });
          }
          if (roomCode === '000004') {
            return Response.json({ error: 'PRO_ROOM_ACTIVATION_UNAVAILABLE' }, { status: 409 });
          }
          return Response.json({
            roomCode,
            roomGeneration,
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

    const unauthenticatedRecovery = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000001/owner-recovery-claim', {
        method: 'POST',
        headers: adminMutationHeaders(),
        body: JSON.stringify({ roomGeneration: 0 }),
      }),
      env,
    );
    expect(unauthenticatedRecovery.status).toBe(401);
    expect(namespace.get).not.toHaveBeenCalled();

    const login = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: adminMutationHeaders({ 'CF-Connecting-IP': '203.0.113.83' }),
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      env,
    );
    const cookie = (login.headers.get('Set-Cookie') || '').split(';')[0];
    const adminHeaders = adminMutationHeaders({
      Cookie: cookie,
      'Cf-Access-Authenticated-User-Email': 'operator@example.com',
    });

    const list = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms', { headers: adminHeaders }),
      env,
    );
    expect(list.status).toBe(200);
    expect(list.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(await list.json()).toMatchObject({
      rooms: [{ roomCode: '000000' }],
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
        body: JSON.stringify({ roomGeneration: 0 }),
      }),
      env,
    );
    const claimPayload = (await claim.json()) as { activationUrl?: string };
    expect(claim.status).toBe(200);
    expect(claimPayload.activationUrl).toContain('#pro-claim=');

    rows.get('000002')!.activation_state = 'active';
    const recoveryClaim = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000002/owner-recovery-claim', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomGeneration: 0 }),
      }),
      env,
    );
    expect(recoveryClaim.status).toBe(200);
    expect(recoveryClaim.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(await recoveryClaim.json()).toMatchObject({
      roomCode: '000002',
      recoveryUrl: 'https://musixquare.com/000002#pro-recovery=v1.payload.signature',
      ownerAccountLinked: true,
    });

    const suspended = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000002/state', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomGeneration: 0, status: 'suspended' }),
      }),
      env,
    );
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toEqual({
      ok: true,
      roomCode: '000002',
      roomGeneration: 0,
      status: 'suspended',
      suspensionReason: 'operator_suspended',
      changed: true,
    });
    expect(rows.get('000002')).toMatchObject({ status: 'suspended', activation_state: 'active' });

    const resumed = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000002/state', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomGeneration: 0, status: 'active' }),
      }),
      env,
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({
      ok: true,
      roomCode: '000002',
      roomGeneration: 0,
      status: 'active',
      suspensionReason: null,
      changed: true,
    });
    expect(rows.get('000002')).toMatchObject({ status: 'registered', activation_state: 'active' });

    failAudit = true;
    const withheldClaim = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000002/owner-recovery-claim', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomGeneration: 0 }),
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
      room_generation: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const staleClaim = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000004/activation-claim', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomGeneration: 0 }),
      }),
      env,
    );
    expect(staleClaim.status).toBe(409);
    expect(rows.get('000004')?.activation_state).toBe('active');

    rows.set('000005', {
      room_code: '000005',
      label: 'Invalid recovery response room',
      status: 'registered',
      activation_state: 'active',
      room_generation: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const invalidRecoveryClaim = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000005/owner-recovery-claim', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomGeneration: 0 }),
      }),
      env,
    );
    expect(invalidRecoveryClaim.status).toBe(502);
    expect(await invalidRecoveryClaim.json()).toEqual({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' });

    for (let index = 1; index < 1000; index += 1) {
      const roomCode = `0${String(index).padStart(5, '0')}`;
      rows.set(roomCode, {
        room_code: roomCode,
        label: `Room ${roomCode}`,
        status: 'registered',
        activation_state: 'unactivated',
        room_generation: 0,
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
      {
        roomCode: '000002:generation:0',
        roomGeneration: '0',
        url: '/internal/admin/provision',
        authorization: '',
      },
      {
        roomCode: '000002:generation:0',
        roomGeneration: '0',
        url: '/internal/admin/activation-claim',
        authorization: '',
      },
      {
        roomCode: '000002:generation:0',
        roomGeneration: '0',
        url: '/internal/admin/owner-recovery-claim',
        authorization: '',
      },
      {
        roomCode: '000002:generation:0',
        roomGeneration: '0',
        url: '/internal/admin/suspend',
        authorization: '',
      },
      {
        roomCode: '000002:generation:0',
        roomGeneration: '0',
        url: '/internal/admin/resume',
        authorization: '',
      },
      {
        roomCode: '000002:generation:0',
        roomGeneration: '0',
        url: '/internal/admin/owner-recovery-claim',
        authorization: '',
      },
      {
        roomCode: '000003:generation:0',
        roomGeneration: '0',
        url: '/internal/admin/provision',
        authorization: '',
      },
      {
        roomCode: '000003:generation:0',
        roomGeneration: '0',
        url: '/internal/admin/provision',
        authorization: '',
      },
      {
        roomCode: '000004:generation:0',
        roomGeneration: '0',
        url: '/internal/admin/activation-claim',
        authorization: '',
      },
      {
        roomCode: '000004:generation:0',
        roomGeneration: '0',
        url: '/internal/admin/status',
        authorization: '',
      },
      {
        roomCode: '000005:generation:0',
        roomGeneration: '0',
        url: '/internal/admin/owner-recovery-claim',
        authorization: '',
      },
    ]);
    expect(claim.headers.has('Authorization')).toBe(false);
    expect(audits).toMatchObject([
      { action: 'room.register', result: 'created', roomCode: '000002', roomGeneration: 0 },
      {
        action: 'activation_claim.issue',
        result: 'issued',
        roomCode: '000002',
        roomGeneration: 0,
      },
      {
        action: 'owner_recovery_claim.issue',
        result: 'issued',
        roomCode: '000002',
        roomGeneration: 0,
      },
      { action: 'room.suspend', result: 'changed', roomCode: '000002', roomGeneration: 0 },
      { action: 'room.resume', result: 'changed', roomCode: '000002', roomGeneration: 0 },
      {
        action: 'room.register',
        result: 'provision_failed',
        roomCode: '000003',
        roomGeneration: 0,
      },
      {
        action: 'room.register',
        result: 'provisioning_recovered',
        roomCode: '000003',
        roomGeneration: 0,
      },
      {
        action: 'activation_claim.issue',
        result: 'service_rejected',
        roomCode: '000004',
        roomGeneration: 0,
      },
      {
        action: 'owner_recovery_claim.issue',
        result: 'invalid_service_response',
        roomCode: '000005',
        roomGeneration: 0,
      },
      {
        action: 'room.register',
        result: 'registry_capacity_reached',
        roomCode: '001000',
        roomGeneration: 0,
      },
    ]);
    expect(audits.every((entry) => /^admin_[A-Za-z0-9_-]{32}$/.test(entry.actorId))).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('secret-claim');
    expect(JSON.stringify(audits)).not.toContain('pro-claim');
    expect(JSON.stringify(audits)).not.toContain('operator@example.com');
  });

  it('preserves an unexpired owner transfer and reissues only after the authoritative claim expires', async () => {
    const targetAccountId = 'acct_0123456789abcdefghijkl';
    const room = {
      room_code: '000002',
      label: 'Pending transfer room',
      status: 'suspended',
      suspension_reason: 'ownership_transfer_pending' as string | null,
      activation_state: 'active',
      room_generation: 6,
      created_at: Date.now() - 10_000,
      updated_at: Date.now() - 1_000,
    };
    const auditResults: string[] = [];
    let transferIssuance: {
      target_account_id: string;
      state: string;
      expires_at: number;
    } | null = null;
    let issuanceLedgerConflict = false;
    let issuanceLedgerThrows = false;
    const registryDb = {
      prepare: vi.fn((sql: string) => {
        const executeRun = (...values: unknown[]) => {
          if (/^\s*INSERT INTO mxqr_pro_room_admin_audit/i.test(sql)) {
            auditResults.push(String(values[2]));
            return { meta: { changes: 1 } };
          }
          if (/UPDATE mxqr_pro_room_registry/i.test(sql) && /SET status = 'suspended'/i.test(sql)) {
            room.status = 'suspended';
            room.suspension_reason = String(values[2]);
            room.activation_state = 'active';
            room.updated_at = Number(values[3]);
            return { meta: { changes: 1 } };
          }
          if (/INSERT OR IGNORE INTO mxqr_pro_room_owner_transfer_issuances/i.test(sql)) {
            if (issuanceLedgerThrows) throw new Error('simulated issuance ledger outage');
            if (issuanceLedgerConflict) return { meta: { changes: 0 } };
            transferIssuance = {
              target_account_id: String(values[3]),
              state: 'issued',
              expires_at: Number(values[5]),
            };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        };
        return {
          run: vi.fn(async () => executeRun()),
          all: vi.fn(async () => ({
            results: /pragma table_info\(mxqr_pro_room_registry\)/i.test(sql)
              ? [{ name: 'room_generation' }, { name: 'suspension_reason' }]
              : /pragma table_info\(mxqr_pro_room_admin_audit\)/i.test(sql)
                ? [{ name: 'room_generation' }]
                : [],
          })),
          bind: vi.fn((...values: unknown[]) => ({
            run: vi.fn(async () => executeRun(...values)),
            first: vi.fn(async () => {
              if (/FROM mxqr_pro_room_registry/i.test(sql) && values[0] === room.room_code) {
                return { ...room };
              }
              if (/FROM mxqr_pro_room_owner_transfer_issuances/i.test(sql)) {
                return transferIssuance ? { ...transferIssuance } : null;
              }
              return null;
            }),
            all: vi.fn(async () => ({ results: [] })),
          })),
        };
      }),
    };
    let targetStoreThrows = false;
    const authDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((targetKey: string) => ({
          first: vi.fn(async () => {
            if (targetStoreThrows) throw new Error('simulated account store outage');
            return targetKey === targetAccountId ||
              (/nickname_key = \?1/i.test(sql) && targetKey === 'new owner')
              ? {
                  account_id: targetAccountId,
                  nickname: 'New owner',
                  nickname_key: 'new owner',
                }
              : null;
          }),
        })),
      })),
    };
    let existingTransferExpired = false;
    const claimCalls: Array<{ targetAccountId?: string }> = [];
    const namespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        fetch: vi.fn(async (request: Request) => {
          const pathname = new URL(request.url).pathname;
          if (pathname === '/internal/admin/status') {
            return Response.json({
              roomCode: room.room_code,
              roomGeneration: room.room_generation,
              provisioned: true,
              status: 'suspended',
              suspensionReason: 'ownership_transfer_pending',
            });
          }
          expect(pathname).toBe('/internal/admin/owner-transfer-claim');
          claimCalls.push((await request.json()) as { targetAccountId?: string });
          if (!existingTransferExpired) {
            return Response.json(
              { error: 'OWNER_TRANSFER_RECONCILIATION_REQUIRED' },
              { status: 409 },
            );
          }
          return Response.json({
            ok: true,
            roomCode: room.room_code,
            roomGeneration: room.room_generation,
            status: 'suspended',
            suspensionReason: 'ownership_transfer_pending',
            targetAccountId,
            claimGeneration: 7,
            transferUrl: `https://musixquare.com/${room.room_code}#pro-transfer=v1.payload.signature`,
            expiresAt: Date.now() + 5 * 60 * 1000,
          });
        }),
      })),
    };
    const env = {
      MXQR_ADMIN_PASSWORD: 'admin-pass',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret-at-least-32',
      MUSIXQUARE_ADMIN_DB: registryDb,
      MUSIXQUARE_AUTH_DB: authDb,
      PRO_ROOM_ADMIN_ROOMS: namespace,
    };
    const login = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: adminMutationHeaders({ 'CF-Connecting-IP': '203.0.113.108' }),
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      env,
    );
    const cookie = (login.headers.get('Set-Cookie') || '').split(';')[0];
    const issue = (targetAccount = targetAccountId) =>
      appWorker.fetch(
        new Request(
          `https://musixquare.com/api/admin/pro-rooms/${room.room_code}/owner-transfer-claim`,
          {
            method: 'POST',
            headers: adminMutationHeaders({ Cookie: cookie }),
            body: JSON.stringify({ roomGeneration: room.room_generation, targetAccount }),
          },
        ),
        env,
      );

    const malformed = await appWorker.fetch(
      new Request(
        `https://musixquare.com/api/admin/pro-rooms/${room.room_code}/owner-transfer-claim`,
        {
          method: 'POST',
          headers: adminMutationHeaders({ Cookie: cookie }),
          body: '{',
        },
      ),
      env,
    );
    expect(malformed.status).toBe(400);
    expect(auditResults).toEqual(['invalid_json']);

    targetStoreThrows = true;
    const targetStoreUnavailable = await issue();
    targetStoreThrows = false;
    expect(targetStoreUnavailable.status).toBe(503);
    await expect(targetStoreUnavailable.json()).resolves.toEqual({
      error: 'ACCOUNT_STORE_UNAVAILABLE',
    });
    expect(auditResults).toEqual(['invalid_json', 'target_store_unavailable']);

    const unavailable = await issue('Unknown exact nickname');
    expect(unavailable.status).toBe(409);
    await expect(unavailable.json()).resolves.toEqual({
      error: 'OWNER_TRANSFER_TARGET_UNAVAILABLE',
    });
    expect(claimCalls).toHaveLength(0);
    expect(auditResults).toEqual([
      'invalid_json',
      'target_store_unavailable',
      'target_unavailable',
    ]);

    const unexpired = await issue();
    expect(unexpired.status).toBe(409);
    expect(await unexpired.json()).toEqual({
      error: 'PRO_ROOM_OWNER_TRANSFER_RECONCILIATION_REQUIRED',
    });
    expect(auditResults).toEqual([
      'invalid_json',
      'target_store_unavailable',
      'target_unavailable',
      'reconcile_required',
    ]);

    existingTransferExpired = true;
    issuanceLedgerConflict = true;
    const ledgerConflict = await issue('New owner');
    issuanceLedgerConflict = false;
    expect(ledgerConflict.status).toBe(503);
    const ledgerConflictPayload = await ledgerConflict.json();
    expect(ledgerConflictPayload).toEqual({
      error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED',
    });
    expect(JSON.stringify(ledgerConflictPayload)).not.toContain('pro-transfer');
    expect(auditResults.at(-1)).toBe('issuance_ledger_conflict');

    issuanceLedgerThrows = true;
    const ledgerUnavailable = await issue('New owner');
    issuanceLedgerThrows = false;
    expect(ledgerUnavailable.status).toBe(503);
    const ledgerUnavailablePayload = await ledgerUnavailable.json();
    expect(ledgerUnavailablePayload).toEqual({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' });
    expect(JSON.stringify(ledgerUnavailablePayload)).not.toContain('pro-transfer');
    expect(auditResults.at(-1)).toBe('issuance_ledger_unavailable');

    const reissued = await issue('New owner');
    expect(reissued.status).toBe(200);
    expect(reissued.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(await reissued.json()).toMatchObject({
      roomCode: '000002',
      roomGeneration: 6,
      targetAccountId,
      targetNickname: 'New owner',
      transferUrl: 'https://musixquare.com/000002#pro-transfer=v1.payload.signature',
    });
    expect(claimCalls).toEqual(
      Array.from({ length: 4 }, () => ({ targetAccountId, roomGeneration: 6 })),
    );
    expect(auditResults.slice(-3)).toEqual([
      'issuance_ledger_conflict',
      'issuance_ledger_unavailable',
      'issued',
    ]);

    room.status = 'decommissioned';
    room.suspension_reason = null;
    const terminal = await issue();
    expect(terminal.status).toBe(410);
    await expect(terminal.json()).resolves.toEqual({
      error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED',
    });
    expect(auditResults.at(-1)).toBe('permanently_decommissioned');
  });

  it('updates only the current PRO room generation label with transactional audit', async () => {
    type RegistryRow = {
      room_code: string;
      label: string;
      status: string;
      activation_state: string;
      room_generation: number;
      created_at: number;
      updated_at: number;
    };
    const roomCode = '000001';
    const rows = new Map<string, RegistryRow>([
      [
        roomCode,
        {
          room_code: roomCode,
          label: 'Original label',
          status: 'registered',
          activation_state: 'active',
          room_generation: 4,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ],
    ]);
    const audits: Array<{
      actorId: string;
      action: string;
      result: string;
      roomCode: string;
      roomGeneration: number;
      createdAt: number;
    }> = [];
    let failAudit = false;
    let forceConflict = false;

    const executeRun = (sql: string, values: unknown[]) => {
      if (/INSERT OR IGNORE INTO mxqr_pro_room_registry/i.test(sql)) {
        const [seedCode, label, timestamp] = values as [string, string, number];
        if (rows.has(seedCode)) return { meta: { changes: 0 } };
        rows.set(seedCode, {
          room_code: seedCode,
          label,
          status: 'registered',
          activation_state: 'unactivated',
          room_generation: 0,
          created_at: timestamp,
          updated_at: timestamp,
        });
        return { meta: { changes: 1 } };
      }
      if (/^\s*INSERT INTO mxqr_pro_room_admin_audit/i.test(sql)) {
        if (failAudit) throw new Error('audit unavailable');
        const [actorId, action, result, auditRoomCode, roomGeneration, createdAt] =
          values.length === 4 && /'room\.label\.update', 'authorized'/i.test(sql)
            ? [values[0], 'room.label.update', 'authorized', values[1], values[2], values[3]]
            : values;
        audits.push({
          actorId: String(actorId),
          action: String(action),
          result: String(result),
          roomCode: String(auditRoomCode),
          roomGeneration: Number(roomGeneration),
          createdAt: Number(createdAt),
        });
        return { meta: { changes: 1 } };
      }
      if (/SET label = \?4, updated_at = \?5/i.test(sql)) {
        const [targetCode, roomGeneration, oldLabel, nextLabel, timestamp] = values as [
          string,
          number,
          string,
          string,
          number,
        ];
        const row = rows.get(targetCode);
        if (forceConflict && row) {
          forceConflict = false;
          row.label = 'Concurrent label';
          row.updated_at = timestamp - 1;
          return { meta: { changes: 0 } };
        }
        if (
          !row ||
          row.room_generation !== roomGeneration ||
          row.label !== oldLabel ||
          !['registered', 'suspended'].includes(row.status)
        ) {
          return { meta: { changes: 0 } };
        }
        row.label = nextLabel;
        row.updated_at = timestamp;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    };

    const db = {
      prepare: vi.fn((sql: string) => ({
        run: vi.fn(async () => executeRun(sql, [])),
        bind: vi.fn((...values: unknown[]) => ({
          run: vi.fn(async () => executeRun(sql, values)),
          first: vi.fn(async () => rows.get(String(values[0])) || null),
          all: vi.fn(async () => ({
            results: /WHERE room_code/i.test(sql)
              ? [rows.get(String(values[0]))].filter(Boolean)
              : [...rows.values()],
          })),
        })),
      })),
      batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => {
        const rowSnapshot = structuredClone([...rows.entries()]) as Array<[string, RegistryRow]>;
        const auditLength = audits.length;
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          return results;
        } catch (error) {
          rows.clear();
          for (const [key, value] of rowSnapshot) rows.set(key, value);
          audits.splice(auditLength);
          throw error;
        }
      }),
    };
    const env = {
      MXQR_ADMIN_PASSWORD: 'admin-pass',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret',
      MUSIXQUARE_ADMIN_DB: db,
    };

    const unauthenticated = await appWorker.fetch(
      new Request(`https://musixquare.com/api/admin/pro-rooms/${roomCode}/label`, {
        method: 'POST',
        headers: adminMutationHeaders(),
        body: JSON.stringify({ roomGeneration: 4, label: 'Updated label' }),
      }),
      env,
    );
    expect(unauthenticated.status).toBe(401);

    const login = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: adminMutationHeaders({ 'CF-Connecting-IP': '203.0.113.88' }),
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      env,
    );
    const headers = adminMutationHeaders({
      Cookie: (login.headers.get('Set-Cookie') || '').split(';')[0],
      'Cf-Access-Authenticated-User-Email': 'operator@example.com',
    });
    const updateLabel = (body: unknown) =>
      appWorker.fetch(
        new Request(`https://musixquare.com/api/admin/pro-rooms/${roomCode}/label`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
        env,
      );

    for (const invalidBody of [
      { roomGeneration: 4, label: '' },
      { roomGeneration: 4, label: 'x'.repeat(65) },
      { roomGeneration: 4, label: 'Unsafe\u202e label' },
      { roomGeneration: 4, label: 'Updated label', extra: true },
    ]) {
      const response = await updateLabel(invalidBody);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'INVALID_REQUEST' });
    }

    const updated = await updateLabel({ roomGeneration: 4, label: '  Updated label  ' });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      ok: true,
      roomCode,
      roomGeneration: 4,
      label: 'Updated label',
      changed: true,
    });
    expect(rows.get(roomCode)?.label).toBe('Updated label');

    const replay = await updateLabel({ roomGeneration: 4, label: 'Updated label' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ label: 'Updated label', changed: false });

    const stale = await updateLabel({ roomGeneration: 3, label: 'Stale edit' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'PRO_ROOM_GENERATION_MISMATCH' });
    expect(rows.get(roomCode)?.label).toBe('Updated label');

    failAudit = true;
    const unaudited = await updateLabel({ roomGeneration: 4, label: 'Never committed' });
    expect(unaudited.status).toBe(503);
    expect(await unaudited.json()).toEqual({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' });
    expect(rows.get(roomCode)?.label).toBe('Updated label');
    failAudit = false;

    forceConflict = true;
    const conflict = await updateLabel({ roomGeneration: 4, label: 'Conflicting label' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'PRO_ROOM_LABEL_CONFLICT' });
    expect(rows.get(roomCode)?.label).toBe('Concurrent label');

    rows.get(roomCode)!.status = 'provisioning';
    const provisioning = await updateLabel({ roomGeneration: 4, label: 'Too early' });
    expect(provisioning.status).toBe(409);
    expect(await provisioning.json()).toEqual({ error: 'PRO_ROOM_PROVISIONING_INCOMPLETE' });

    rows.get(roomCode)!.status = 'decommissioned';
    const terminal = await updateLabel({ roomGeneration: 4, label: 'Too late' });
    expect(terminal.status).toBe(410);
    expect(await terminal.json()).toEqual({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' });

    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'room.label.update', result: 'authorized' }),
        expect.objectContaining({ action: 'room.label.update', result: 'already_applied' }),
        expect.objectContaining({ action: 'room.label.update', result: 'generation_mismatch' }),
        expect.objectContaining({ action: 'room.label.update', result: 'provisioning_incomplete' }),
        expect.objectContaining({ action: 'room.label.update', result: 'room_closed' }),
      ]),
    );
    expect(audits.every((entry) => entry.roomGeneration >= 0)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('Updated label');
    expect(JSON.stringify(audits)).not.toContain('Concurrent label');
    expect(JSON.stringify(audits)).not.toContain('operator@example.com');
  });

  it('permanently decommissions a PRO room only after strict admin confirmation', async () => {
    type RegistryRow = {
      room_code: string;
      label: string;
      status: string;
      activation_state: string;
      room_generation: number;
      created_at: number;
      updated_at: number;
    };
    const roomCode = '000001';
    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    const registryRows = new Map<string, RegistryRow>([
      [
        roomCode,
        {
          room_code: roomCode,
          label: 'Friends & Family',
          status: 'registered',
          activation_state: 'active',
          room_generation: 0,
          created_at: Date.now() - 10_000,
          updated_at: Date.now() - 1_000,
        },
      ],
    ]);
    const generationHistory = new Map<
      string,
      {
        room_code: string;
        room_generation: number;
        status: string;
        decommissioned_at: number;
        request_id: string | null;
      }
    >();
    const generationAllocations = new Set<string>([`${roomCode}:0`]);
    const proAudits: Array<{
      action: string;
      result: string;
      roomCode: string;
      roomGeneration: number;
    }> = [];
    let generationCutoverStatus: 'disabled' | 'ready' = 'disabled';
    let generationCutoverEverEnabled = false;
    let disableCutoverAfterNextRead = false;
    const adminDb = {
      prepare: vi.fn((sql: string) => {
        const executeRun = (...values: unknown[]) => {
          if (/CREATE TABLE IF NOT EXISTS/i.test(sql)) return { meta: { changes: 0 } };
          if (/INSERT OR IGNORE INTO mxqr_pro_room_generation_allocations/i.test(sql)) {
            if (/FROM mxqr_pro_room_registry/i.test(sql)) {
              for (const row of registryRows.values()) {
                generationAllocations.add(`${row.room_code}:${row.room_generation}`);
              }
            } else if (/FROM mxqr_pro_room_generation_history/i.test(sql)) {
              for (const row of generationHistory.values()) {
                generationAllocations.add(`${row.room_code}:${row.room_generation}`);
              }
            }
            return { meta: { changes: 0 } };
          }
          if (/INSERT OR IGNORE INTO mxqr_pro_room_registry/i.test(sql)) {
            const [code, label, timestamp] = values as [string, string, number];
            if (registryRows.has(code)) return { meta: { changes: 0 } };
            if (
              /mxqr_pro_room_generation_allocations/i.test(sql) &&
              ([...generationAllocations].some((entry) => entry.startsWith(`${code}:`)) ||
                [...generationHistory.keys()].some((entry) => entry.startsWith(`${code}:`)))
            ) {
              return { meta: { changes: 0 } };
            }
            registryRows.set(code, {
              room_code: code,
              label,
              status: /'provisioning'/i.test(sql) ? 'provisioning' : 'registered',
              activation_state: 'unactivated',
              room_generation: 0,
              created_at: timestamp,
              updated_at: timestamp,
            });
            generationAllocations.add(`${code}:0`);
            return { meta: { changes: 1 } };
          }
          if (/INSERT OR IGNORE INTO mxqr_pro_room_generation_history/i.test(sql)) {
            if (/SELECT room_code, room_generation/i.test(sql)) {
              const [code, generation] = values as [string, number];
              const row = registryRows.get(code);
              if (!row || row.status !== 'decommissioned' || row.room_generation !== generation) {
                return { meta: { changes: 0 } };
              }
              const key = `${code}:${generation}`;
              if (generationHistory.has(key)) return { meta: { changes: 0 } };
              generationHistory.set(key, {
                room_code: code,
                room_generation: generation,
                status: 'decommissioned',
                decommissioned_at: row.updated_at,
                request_id: null,
              });
              return { meta: { changes: 1 } };
            }
            const [code, generation, historyRequestId, timestamp] = values as [
              string,
              number,
              string | null,
              number,
            ];
            const key = `${code}:${generation}`;
            if (generationHistory.has(key)) return { meta: { changes: 0 } };
            generationHistory.set(key, {
              room_code: code,
              room_generation: generation,
              status: 'decommissioned',
              decommissioned_at: timestamp,
              request_id: historyRequestId,
            });
            return { meta: { changes: 1 } };
          }
          if (/^\s*INSERT INTO mxqr_pro_room_admin_audit/i.test(sql)) {
            const [, action, result, code, roomGeneration] = values as [
              string,
              string,
              string,
              string,
              number,
              number,
            ];
            proAudits.push({ action, result, roomCode: code, roomGeneration });
            return { meta: { changes: 1 } };
          }
          if (/SET label = 'Decommissioned PRO room', status = 'decommissioned'/i.test(sql)) {
            const [code, generation, timestamp] = values as [string, number, number];
            const row = registryRows.get(code);
            if (!row || row.room_generation !== generation) return { meta: { changes: 0 } };
            row.label = 'Decommissioned PRO room';
            row.status = 'decommissioned';
            row.activation_state = 'unactivated';
            row.updated_at = timestamp;
            return { meta: { changes: 1 } };
          }
          if (/SET status = 'decommissioning'/i.test(sql)) {
            const [code, generation, timestamp] = values as [string, number, number];
            const row = registryRows.get(code);
            if (!row || row.room_generation !== generation || row.status === 'decommissioned') {
              return { meta: { changes: 0 } };
            }
            row.status = 'decommissioning';
            row.activation_state = 'unactivated';
            row.updated_at = timestamp;
            return { meta: { changes: 1 } };
          }
          if (/room_generation = room_generation \+ 1/i.test(sql)) {
            const [code, label, timestamp, generation, , limit] = values as [
              string,
              string,
              number,
              number,
              number,
              number,
            ];
            const row = registryRows.get(code);
            const activeCount = [...registryRows.values()].filter(
              (candidate) => candidate.status !== 'decommissioned',
            ).length;
            if (
              !row ||
              row.status !== 'decommissioned' ||
              row.room_generation !== generation ||
              activeCount >= limit ||
              !generationHistory.has(`${code}:${generation}`) ||
              generationCutoverStatus !== 'ready'
            ) {
              return { meta: { changes: 0 } };
            }
            row.label = label;
            row.status = 'provisioning';
            row.activation_state = 'unactivated';
            row.room_generation += 1;
            generationAllocations.add(`${code}:${row.room_generation}`);
            row.created_at = timestamp;
            row.updated_at = timestamp;
            return { meta: { changes: 1 } };
          }
          if (/SET status = 'registered'/i.test(sql)) {
            const [code, generation, activationState, timestamp] = values as [
              string,
              number,
              string,
              number,
            ];
            const row = registryRows.get(code);
            if (
              !row ||
              row.room_generation !== generation ||
              ['suspended', 'decommissioning', 'decommissioned'].includes(row.status)
            ) {
              return { meta: { changes: 0 } };
            }
            row.status = 'registered';
            row.activation_state = activationState;
            row.updated_at = timestamp;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        };
        return {
          run: vi.fn(async () => executeRun()),
          bind: vi.fn((...values: unknown[]) => ({
            run: vi.fn(async () => executeRun(...values)),
            first: vi.fn(async () => {
              if (/FROM mxqr_pro_room_generation_cutover/i.test(sql)) {
                if (generationCutoverStatus === 'ready') {
                  generationCutoverEverEnabled = true;
                }
                const cutover = {
                  status: generationCutoverStatus,
                  release_sha:
                    generationCutoverStatus === 'ready'
                      ? '1234567890abcdef1234567890abcdef12345678'
                      : null,
                  ever_enabled: generationCutoverEverEnabled ? 1 : 0,
                  floor_release_sha: generationCutoverEverEnabled
                    ? '1234567890abcdef1234567890abcdef12345678'
                    : null,
                };
                if (disableCutoverAfterNextRead) {
                  disableCutoverAfterNextRead = false;
                  generationCutoverStatus = 'disabled';
                }
                return cutover;
              }
              if (/AS has_allocation/i.test(sql) && /AS has_history/i.test(sql)) {
                const code = String(values[0]);
                const generation =
                  values.length > 1 && Number.isSafeInteger(Number(values[1]))
                    ? Number(values[1])
                    : null;
                const matches = (entry: string) =>
                  generation === null
                    ? entry.startsWith(`${code}:`)
                    : entry === `${code}:${generation}`;
                return {
                  has_allocation: [...generationAllocations].some(matches) ? 1 : 0,
                  has_history: [...generationHistory.keys()].some(matches) ? 1 : 0,
                };
              }
              return registryRows.get(String(values[0])) || null;
            }),
            all: vi.fn(async () => ({ results: [...registryRows.values()] })),
          })),
        };
      }),
    };

    let proRoomStatus: 'decommissioning' | 'decommissioned' = 'decommissioning';
    let rejectNextDecommission = true;
    const proRoomCalls: Array<{
      objectName: string;
      pathname: string;
      roomCodeHeader: string;
      roomGenerationHeader: string;
      body: unknown;
    }> = [];
    let activeObjectName = '';
    const proRoomFetch = vi.fn(async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      const roomGeneration = Number(request.headers.get('x-mxqr-pro-room-generation') ?? '0');
      proRoomCalls.push({
        objectName: activeObjectName,
        pathname,
        roomCodeHeader: request.headers.get('x-mxqr-pro-room-code') || '',
        roomGenerationHeader: String(roomGeneration),
        body: await request
          .clone()
          .json()
          .catch(() => null),
      });
      if (pathname === '/internal/admin/provision') {
        return Response.json({
          ok: true,
          roomCode,
          roomGeneration,
          status: 'unactivated',
        });
      }
      if (pathname !== '/internal/admin/decommission') {
        return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
      }
      if (rejectNextDecommission) {
        rejectNextDecommission = false;
        return Response.json({ error: 'PRO_ROOM_ADMIN_UNAVAILABLE' }, { status: 503 });
      }
      return Response.json(
        {
          ok: true,
          roomCode,
          roomGeneration,
          status: proRoomStatus,
          purgeAfterMs: Date.now() + 600_000,
          completedAtMs: proRoomStatus === 'decommissioned' ? Date.now() : null,
        },
        { status: proRoomStatus === 'decommissioned' ? 200 : 202 },
      );
    });
    const env = {
      MXQR_ADMIN_PASSWORD: 'admin-pass',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret-at-least-32',
      MUSIXQUARE_ADMIN_DB: adminDb,
      PRO_ROOM_ADMIN_ROOMS: {
        idFromName: vi.fn((code: string) => code),
        get: vi.fn((objectName: string) => {
          activeObjectName = objectName;
          return { fetch: proRoomFetch };
        }),
      },
    };

    const deleteRequest = (
      headers: Record<string, string>,
      body: unknown = { confirmRoomCode: roomCode, roomGeneration: 0, requestId },
    ) =>
      new Request(`https://musixquare.com/api/admin/pro-rooms/${roomCode}`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify(body),
      });

    const unauthenticated = await appWorker.fetch(deleteRequest(adminMutationHeaders()), env);
    expect(unauthenticated.status).toBe(401);
    expect(proRoomFetch).not.toHaveBeenCalled();

    const login = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: adminMutationHeaders({ 'CF-Connecting-IP': '203.0.113.95' }),
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      env,
    );
    const cookie = (login.headers.get('Set-Cookie') || '').split(';')[0];
    expect(login.status).toBe(200);

    const missingCsrf = await appWorker.fetch(
      deleteRequest({
        Origin: 'https://musixquare.com',
        'Content-Type': 'application/json',
        Cookie: cookie,
      }),
      env,
    );
    expect(missingCsrf.status).toBe(403);

    const wrongContentType = await appWorker.fetch(
      deleteRequest({
        Origin: 'https://musixquare.com',
        'Content-Type': 'text/plain',
        'X-MXQR-Admin-CSRF': '1',
        Cookie: cookie,
      }),
      env,
    );
    expect(wrongContentType.status).toBe(415);

    const adminHeaders = adminMutationHeaders({ Cookie: cookie });
    for (const invalidBody of [
      { confirmRoomCode: '000002', roomGeneration: 0, requestId },
      {
        confirmRoomCode: roomCode,
        roomGeneration: 0,
        requestId: '123e4567-e89b-12d3-a456-426614174000',
      },
      { confirmRoomCode: roomCode, roomGeneration: 0, requestId, extra: true },
      { confirmRoomCode: roomCode, requestId },
    ]) {
      const invalid = await appWorker.fetch(deleteRequest(adminHeaders, invalidBody), env);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'PRO_ROOM_DELETE_CONFIRMATION_MISMATCH' });
    }
    expect(proRoomFetch).not.toHaveBeenCalled();

    const unavailable = await appWorker.fetch(deleteRequest(adminHeaders), env);
    expect(unavailable.status).toBe(503);
    expect(registryRows.get(roomCode)).toMatchObject({
      status: 'registered',
      activation_state: 'active',
    });

    const accepted = await appWorker.fetch(deleteRequest(adminHeaders), env);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      roomCode,
      roomGeneration: 0,
      status: 'decommissioning',
      purgeAfterMs: expect.any(Number),
      completedAtMs: null,
    });
    expect(registryRows.get(roomCode)).toMatchObject({
      status: 'decommissioning',
      activation_state: 'unactivated',
    });
    expect(proRoomCalls).toEqual([
      {
        objectName: `${roomCode}:generation:0`,
        pathname: '/internal/admin/decommission',
        roomCodeHeader: roomCode,
        roomGenerationHeader: '0',
        body: { roomCode, roomGeneration: 0, requestId },
      },
      {
        objectName: `${roomCode}:generation:0`,
        pathname: '/internal/admin/decommission',
        roomCodeHeader: roomCode,
        roomGenerationHeader: '0',
        body: { roomCode, roomGeneration: 0, requestId },
      },
    ]);
    expect(proAudits).toContainEqual({
      action: 'room.delete',
      result: 'authorized',
      roomCode,
      roomGeneration: 0,
    });

    proRoomStatus = 'decommissioned';
    const completed = await appWorker.fetch(deleteRequest(adminHeaders), env);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      ok: true,
      roomCode,
      roomGeneration: 0,
      status: 'decommissioned',
      completedAtMs: expect.any(Number),
    });
    expect(registryRows.get(roomCode)).toMatchObject({
      label: 'Decommissioned PRO room',
      status: 'decommissioned',
      activation_state: 'unactivated',
      room_generation: 0,
    });
    expect(generationHistory.get(`${roomCode}:0`)).toMatchObject({
      room_code: roomCode,
      room_generation: 0,
      status: 'decommissioned',
      request_id: requestId,
    });

    const completedReplay = await appWorker.fetch(deleteRequest(adminHeaders), env);
    expect(completedReplay.status).toBe(200);
    expect((await completedReplay.json()) as { status?: string }).toMatchObject({
      status: 'decommissioned',
    });

    const provisionCallCount = proRoomCalls.filter(
      (call) => call.pathname === '/internal/admin/provision',
    ).length;
    const blockedReregister = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomCode, label: 'Recreated room' }),
      }),
      env,
    );
    expect(blockedReregister.status).toBe(503);
    expect(await blockedReregister.json()).toEqual({
      error: 'PRO_ROOM_GENERATION_CUTOVER_NOT_READY',
    });
    expect(registryRows.get(roomCode)).toMatchObject({
      status: 'decommissioned',
      room_generation: 0,
    });
    expect(
      proRoomCalls.filter((call) => call.pathname === '/internal/admin/provision'),
    ).toHaveLength(provisionCallCount);
    expect(proAudits).toContainEqual({
      action: 'room.register',
      result: 'generation_cutover_not_ready',
      roomCode,
      roomGeneration: 0,
    });

    generationCutoverStatus = 'ready';
    disableCutoverAfterNextRead = true;
    const cutoverRace = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomCode, label: 'Recreated room' }),
      }),
      env,
    );
    expect(cutoverRace.status).toBe(503);
    expect(await cutoverRace.json()).toEqual({
      error: 'PRO_ROOM_GENERATION_CUTOVER_NOT_READY',
    });
    expect(registryRows.get(roomCode)).toMatchObject({
      status: 'decommissioned',
      room_generation: 0,
    });

    generationCutoverStatus = 'ready';
    const reregister = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomCode, label: 'Recreated room' }),
      }),
      env,
    );
    expect(reregister.status).toBe(201);
    expect(await reregister.json()).toMatchObject({
      room: {
        roomCode,
        roomGeneration: 1,
        label: 'Recreated room',
        status: 'registered',
        activationState: 'unactivated',
      },
    });
    expect(registryRows.get(roomCode)).toMatchObject({
      label: 'Recreated room',
      status: 'registered',
      activation_state: 'unactivated',
      room_generation: 1,
    });
    expect(
      proRoomCalls.filter((call) => call.pathname === '/internal/admin/provision'),
    ).toHaveLength(provisionCallCount + 1);
    expect(proRoomCalls.at(-1)).toEqual({
      objectName: `${roomCode}:generation:1`,
      pathname: '/internal/admin/provision',
      roomCodeHeader: roomCode,
      roomGenerationHeader: '1',
      body: null,
    });
    expect(proAudits).toContainEqual({
      action: 'room.register',
      result: 'recreated',
      roomCode,
      roomGeneration: 1,
    });

    const callCountAfterReuse = proRoomCalls.length;
    const staleAdminRequests = [
      new Request(`https://musixquare.com/api/admin/pro-rooms/${roomCode}/activation-claim`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomGeneration: 0 }),
      }),
      new Request(`https://musixquare.com/api/admin/pro-rooms/${roomCode}/owner-recovery-claim`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomGeneration: 0 }),
      }),
      new Request(`https://musixquare.com/api/admin/pro-rooms/${roomCode}/state`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomGeneration: 0, status: 'suspended' }),
      }),
      deleteRequest(adminHeaders),
    ];
    for (const staleRequest of staleAdminRequests) {
      const staleResponse = await appWorker.fetch(staleRequest, env);
      expect(staleResponse.status).toBe(409);
      expect(await staleResponse.json()).toEqual({
        error: 'PRO_ROOM_GENERATION_MISMATCH',
      });
    }
    expect(proRoomCalls).toHaveLength(callCountAfterReuse);
    expect(registryRows.get(roomCode)).toMatchObject({
      room_generation: 1,
      status: 'registered',
    });

    // Simulate out-of-band pointer loss while immutable allocation/history
    // evidence survives. Registration must not silently mint generation zero
    // (or infer max(history)+1); the operator gets an explicit repair fence and
    // no Durable Object provisioning request is made.
    registryRows.delete(roomCode);
    const callCountBeforeRepairFence = proRoomCalls.length;
    const missingPointer = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ roomCode, label: 'Must not auto-repair' }),
      }),
      env,
    );
    expect(missingPointer.status).toBe(409);
    expect(await missingPointer.json()).toEqual({
      error: 'PRO_ROOM_REGISTRY_REPAIR_REQUIRED',
    });
    expect(registryRows.has(roomCode)).toBe(false);
    expect(proRoomCalls).toHaveLength(callCountBeforeRepairFence);
    expect(proAudits).toContainEqual({
      action: 'room.register',
      result: 'registry_repair_required',
      roomCode,
      roomGeneration: 0,
    });
  });

  it('keeps /admin unindexed and no-store cached', async () => {
    const response = await appWorker.fetch(new Request('https://musixquare.com/admin'), {
      MXQR_ADMIN_PASSWORD: 'admin-pass',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret',
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0, must-revalidate');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('/admin.css?v=8.3.3');
    expect(html).toContain('/admin.js?v=8.3.3');
    expect(html).toContain('data-admin-asset-version="8.3.3"');
    expect(html).toContain('Direct R2 uploads authorized before activation can still finish');
    expect(html).toContain('data-admin-tab="pro-rooms"');
    expect(html).toContain('data-pro-room-form');
    expect(html).toContain('Reusing a deleted number creates a new, isolated room.');
    expect(html).not.toContain('Reserve a permanent room number');
  });

  it('forces admin assets through no-store browser and CDN caching', async () => {
    const assetFetch = vi.fn(
      async () =>
        new Response('admin asset', {
          headers: { 'Cache-Control': 'public, max-age=86400' },
        }),
    );
    const env = { ASSETS: { fetch: assetFetch } };

    for (const path of ['/admin.js?v=8.3.3', '/admin.css?v=8.3.3']) {
      const response = await appWorker.fetch(new Request(`https://musixquare.com${path}`), env);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0, must-revalidate');
      expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
      expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    }
    expect(assetFetch).toHaveBeenCalledTimes(2);
  });
});

describe('Cloudflare app worker Developer API key administration', () => {
  type DeveloperKeyRow = {
    key_id: string;
    room_code: string;
    room_generation: number;
    authority_epoch: number;
    label: string;
    secret_digest: string;
    digest_version: number;
    scope_mask: number;
    status: 'active' | 'revoked';
    created_at: number;
    updated_at: number;
    expires_at: number;
    revoked_at: number | null;
    last_used_hour: number | null;
  };

  function createDeveloperApiAdminEnv(
    options: {
      roomStatus?: string;
      roomGeneration?: number;
      simulateConcurrentIssue?: boolean;
      developerAuthorityEpoch?: number;
      advanceAuthorityEpochAfterIssue?: boolean;
    } = {},
  ) {
    const now = Date.now();
    const registryRows = new Map([
      [
        '000001',
        {
          room_code: '000001',
          label: 'Friends & Family',
          status: options.roomStatus || 'registered',
          suspension_reason: options.roomStatus === 'suspended' ? 'operator_suspended' : null,
          activation_state: 'active',
          room_generation: options.roomGeneration ?? 0,
          created_at: now - 1_000,
          updated_at: now - 1_000,
        },
      ],
    ]);
    const registryDb = {
      prepare: vi.fn((sql: string) => {
        const executeRun = (...values: unknown[]) => {
          if (/INSERT OR IGNORE INTO mxqr_pro_room_registry/i.test(sql)) {
            const [roomCode, label, createdAt] = values as [string, string, number];
            if (!registryRows.has(roomCode)) {
              registryRows.set(roomCode, {
                room_code: roomCode,
                label,
                status: 'registered',
                suspension_reason: null,
                activation_state: 'unactivated',
                room_generation: 0,
                created_at: createdAt,
                updated_at: createdAt,
              });
              return { meta: { changes: 1 } };
            }
          }
          if (/UPDATE mxqr_pro_room_registry/i.test(sql)) {
            const roomCode = String(values[0]);
            const row = registryRows.get(roomCode);
            if (
              row &&
              (!/room_generation = \?2/i.test(sql) || row.room_generation === Number(values[1]))
            ) {
              if (/SET status = 'suspended'/i.test(sql)) {
                row.status = 'suspended';
                row.suspension_reason = String(values[2]);
                row.activation_state = 'active';
                row.updated_at = Number(values[3]);
              } else if (/SET status = 'registered'/i.test(sql)) {
                row.status = 'registered';
                row.suspension_reason = null;
                row.activation_state = String(values[2]);
                row.updated_at = Number(values[3]);
              } else if (/SET status = \?3/i.test(sql)) {
                row.status = String(values[2]);
                row.suspension_reason = values[3] == null ? null : String(values[3]);
                row.activation_state = 'active';
                row.updated_at = Number(values[4]);
              }
              return { meta: { changes: 1 } };
            }
          }
          return { meta: { changes: 0 } };
        };
        return {
          run: vi.fn(async () => executeRun()),
          bind: vi.fn((...values: unknown[]) => ({
            run: vi.fn(async () => executeRun(...values)),
            first: vi.fn(async () => registryRows.get(String(values[0])) || null),
            all: vi.fn(async () => ({ results: [...registryRows.values()] })),
          })),
        };
      }),
    };

    const keyRows = new Map<string, DeveloperKeyRow>();
    const audits: Array<{
      actorId: string;
      action: string;
      result: string;
      keyId: string;
      roomCode: string;
      roomGeneration: number;
      createdAt: number;
    }> = [];
    let failAudit = false;
    let simulateConcurrentIssue = options.simulateConcurrentIssue === true;
    let developerAuthorityEpoch = options.developerAuthorityEpoch ?? 0;

    const developerDb = {
      prepare: vi.fn((sql: string) => {
        const executeRun = (...values: unknown[]) => {
          if (/SET status = 'revoked',\s+revoked_at = expires_at/i.test(sql)) {
            const [roomCode, roomGeneration, timestamp] = values as [string, number, number];
            const triggerCompatibleUpdate =
              /updated_at = CASE\s+WHEN updated_at > expires_at THEN updated_at\s+ELSE expires_at\s+END/i.test(
                sql,
              );
            let changes = 0;
            for (const row of keyRows.values()) {
              if (
                row.room_code === roomCode &&
                row.room_generation === roomGeneration &&
                row.status === 'active' &&
                row.expires_at <= timestamp
              ) {
                row.status = 'revoked';
                row.revoked_at = row.expires_at;
                row.updated_at = triggerCompatibleUpdate
                  ? Math.max(row.updated_at, row.expires_at)
                  : timestamp;
                if (
                  triggerCompatibleUpdate &&
                  !audits.some(
                    (entry) => entry.keyId === row.key_id && entry.action === 'key.expire',
                  )
                ) {
                  audits.push({
                    actorId: 'system:expiry',
                    action: 'key.expire',
                    result: 'expired',
                    keyId: row.key_id,
                    roomCode: row.room_code,
                    roomGeneration: row.room_generation,
                    createdAt: row.expires_at,
                  });
                }
                changes += 1;
              }
            }
            return { meta: { changes } };
          }
          if (/INSERT INTO mxqr_developer_api_keys/i.test(sql)) {
            const [
              keyId,
              roomCode,
              roomGeneration,
              authorityEpoch,
              label,
              digest,
              scopeMask,
              createdAt,
              expiresAt,
            ] = values as [string, string, number, number, string, string, number, number, number];
            const concurrentRow: DeveloperKeyRow = {
              key_id: keyId,
              room_code: roomCode,
              room_generation: roomGeneration,
              authority_epoch: authorityEpoch,
              label,
              secret_digest: digest,
              digest_version: 1,
              scope_mask: scopeMask,
              status: 'active',
              created_at: createdAt,
              updated_at: createdAt,
              expires_at: expiresAt,
              revoked_at: null,
              last_used_hour: null,
            };
            if (simulateConcurrentIssue) {
              simulateConcurrentIssue = false;
              const error = new Error('duplicate key id') as Error & {
                concurrentRow?: DeveloperKeyRow;
              };
              error.concurrentRow = concurrentRow;
              throw error;
            }
            const activeCount = [...keyRows.values()].filter(
              (row) =>
                row.room_code === roomCode &&
                row.room_generation === roomGeneration &&
                row.status === 'active',
            ).length;
            if (activeCount >= 3) throw new Error('developer_api_active_key_limit');
            if (keyRows.has(keyId)) throw new Error('duplicate key id');
            keyRows.set(keyId, concurrentRow);
            if (options.advanceAuthorityEpochAfterIssue) developerAuthorityEpoch += 1;
            return { meta: { changes: 1 } };
          }
          if (
            /INSERT(?: OR IGNORE)? INTO mxqr_developer_api_admin_audit/i.test(sql) &&
            /SELECT \?1, 'key\.issue', 'issued'/i.test(sql)
          ) {
            if (failAudit) throw new Error('audit unavailable');
            const [actorId, keyId, roomCode, roomGeneration, digest, createdAt, auditAt] =
              values as [string, string, string, number, string, number, number];
            const row = keyRows.get(keyId);
            if (
              !row ||
              row.room_code !== roomCode ||
              row.room_generation !== roomGeneration ||
              row.secret_digest !== digest ||
              row.status !== 'active' ||
              row.created_at !== createdAt
            ) {
              return { meta: { changes: 0 } };
            }
            audits.push({
              actorId,
              action: 'key.issue',
              result: 'issued',
              keyId,
              roomCode,
              roomGeneration,
              createdAt: auditAt,
            });
            return { meta: { changes: 1 } };
          }
          if (/INSERT(?: OR IGNORE)? INTO mxqr_developer_api_admin_audit/i.test(sql)) {
            if (failAudit) throw new Error('audit unavailable');
            const [actorId, action, result, keyId, roomCode, roomGeneration, createdAt] =
              values as [string, string, string, string, string, number, number];
            audits.push({
              actorId,
              action,
              result,
              keyId,
              roomCode,
              roomGeneration,
              createdAt,
            });
            return { meta: { changes: 1 } };
          }
          if (/DELETE FROM mxqr_developer_api_keys/i.test(sql)) {
            const [keyId, roomCode, roomGeneration, digest] = values as [
              string,
              string,
              number,
              string,
            ];
            const row = keyRows.get(keyId);
            if (
              row?.room_code === roomCode &&
              row.room_generation === roomGeneration &&
              row.secret_digest === digest
            ) {
              keyRows.delete(keyId);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (
            /SET status = 'revoked', revoked_at = \?4/i.test(sql) &&
            /expires_at > \?4/i.test(sql)
          ) {
            const [roomCode, roomGeneration, keyId, timestamp] = values as [
              string,
              number,
              string,
              number,
            ];
            const row = keyRows.get(keyId);
            if (
              row?.room_code === roomCode &&
              row.room_generation === roomGeneration &&
              row.status === 'active' &&
              row.expires_at > timestamp
            ) {
              row.status = 'revoked';
              row.revoked_at = timestamp;
              row.updated_at = timestamp;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (/SET status = 'active', revoked_at = NULL/i.test(sql)) {
            const [roomCode, roomGeneration, keyId, timestamp] = values as [
              string,
              number,
              string,
              number,
            ];
            const row = keyRows.get(keyId);
            if (
              row?.room_code === roomCode &&
              row.room_generation === roomGeneration &&
              row.status === 'revoked' &&
              row.revoked_at === timestamp
            ) {
              row.status = 'active';
              row.revoked_at = null;
              row.updated_at = timestamp;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 0 } };
        };
        const bound = (...values: unknown[]) => ({
          run: vi.fn(async () => executeRun(...values)),
          first: vi.fn(async () => {
            const [roomCode, roomGeneration, keyId] = values as [string, number, string];
            const row = keyRows.get(keyId);
            return row?.room_code === roomCode && row.room_generation === roomGeneration
              ? { ...row }
              : null;
          }),
          all: vi.fn(async () => {
            const roomCode = String(values[0]);
            const roomGeneration = Number(values[1]);
            return {
              results: [...keyRows.values()]
                .filter(
                  (row) => row.room_code === roomCode && row.room_generation === roomGeneration,
                )
                .sort((left, right) => right.created_at - left.created_at)
                .map((row) => ({ ...row })),
            };
          }),
        });
        return { bind: vi.fn(bound), run: vi.fn(async () => executeRun()) };
      }),
      batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => {
        const rowSnapshot = new Map(
          [...keyRows.entries()].map(([key, value]) => [key, { ...value }] as const),
        );
        const auditCount = audits.length;
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          return results;
        } catch (error) {
          keyRows.clear();
          for (const [key, value] of rowSnapshot) keyRows.set(key, value);
          audits.splice(auditCount);
          const concurrentRow = (error as Error & { concurrentRow?: DeveloperKeyRow })
            .concurrentRow;
          if (concurrentRow) keyRows.set(concurrentRow.key_id, concurrentRow);
          throw error;
        }
      }),
    };

    return {
      env: {
        MXQR_ADMIN_PASSWORD: 'admin-pass',
        MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret-at-least-32',
        MXQR_DEVELOPER_API_KEY_PEPPER: 'developer-api-test-pepper-at-least-32',
        MUSIXQUARE_ADMIN_DB: registryDb,
        DEVELOPER_API_DB: developerDb,
        PRO_ROOM_ADMIN_ROOMS: {
          idFromName: vi.fn((roomCode: string) => roomCode),
          get: vi.fn((objectName: string) => ({
            fetch: vi.fn(async (request: Request) => {
              expect(new URL(request.url).pathname).toBe('/internal/admin/status');
              const roomCode = request.headers.get('x-mxqr-pro-room-code') || '';
              const roomGeneration = Number(
                request.headers.get('x-mxqr-pro-room-generation') ?? '0',
              );
              expect(objectName).toBe(`${roomCode}:generation:${roomGeneration}`);
              const row = registryRows.get(roomCode);
              if (!row) return Response.json({ error: 'ROOM_NOT_FOUND' }, { status: 404 });
              const status =
                row.status === 'suspended'
                  ? 'suspended'
                  : row.activation_state === 'active'
                    ? 'active'
                    : 'unactivated';
              return Response.json({
                roomCode,
                roomGeneration,
                provisioned: true,
                status,
                suspensionReason: status === 'suspended' ? 'operator_suspended' : null,
                developerAuthorityEpoch,
              });
            }),
          })),
        },
      },
      keyRows,
      audits,
      registryRows,
      setFailAudit(value: boolean) {
        failAudit = value;
      },
      setDeveloperAuthorityEpoch(value: number) {
        developerAuthorityEpoch = value;
      },
    };
  }

  async function loginDeveloperApiAdmin(env: Record<string, unknown>) {
    const login = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: adminMutationHeaders({ 'CF-Connecting-IP': '203.0.113.94' }),
        body: JSON.stringify({ password: 'admin-pass' }),
      }),
      env,
    );
    expect(login.status).toBe(200);
    return (login.headers.get('Set-Cookie') || '').split(';')[0];
  }

  function issueDeveloperApiKeyRequest(
    cookie: string,
    body: unknown,
    requestId = crypto.randomUUID(),
    roomGeneration = 0,
  ) {
    const requestBody =
      body && typeof body === 'object' && !Array.isArray(body)
        ? { ...body, roomGeneration, requestId }
        : body;
    return new Request('https://musixquare.com/api/admin/pro-rooms/000001/api-keys', {
      method: 'POST',
      headers: adminMutationHeaders({
        Cookie: cookie,
        'Cf-Access-Authenticated-User-Email': 'operator@example.com',
      }),
      body: JSON.stringify(requestBody),
    });
  }

  function revokeDeveloperApiKeyRequest(
    cookie: string,
    roomCode: string,
    keyId: string,
    roomGeneration = 0,
  ) {
    return new Request(`https://musixquare.com/api/admin/pro-rooms/${roomCode}/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: adminMutationHeaders({ Cookie: cookie }),
      body: JSON.stringify({ roomGeneration }),
    });
  }

  it('requires admin auth and strictly validates room-bound key issuance', async () => {
    const { env, keyRows, registryRows } = createDeveloperApiAdminEnv();
    const unauthenticated = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000001/api-keys'),
      env,
    );
    expect(unauthenticated.status).toBe(401);
    expect(keyRows.size).toBe(0);

    const cookie = await loginDeveloperApiAdmin(env);
    for (const invalidBody of [
      { label: '', scopes: ['room:read'] },
      { label: 'Bot', days: 0, scopes: ['room:read'] },
      { label: 'Bot', days: 366, scopes: ['room:read'] },
      { label: 'Bot', scopes: ['room:read', 'room:read'] },
      { label: 'Bot', scopes: ['unknown:scope'] },
      { label: 'Bot', scopes: ['room:read'], extra: true },
    ]) {
      const response = await appWorker.fetch(issueDeveloperApiKeyRequest(cookie, invalidBody), env);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'INVALID_REQUEST' });
    }

    const missingRoom = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000009/api-keys', {
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(missingRoom.status).toBe(404);

    registryRows.get('000001')!.status = 'suspended';
    registryRows.get('000001')!.suspension_reason = 'operator_suspended';
    const suspended = await appWorker.fetch(
      issueDeveloperApiKeyRequest(cookie, { label: 'Bot', scopes: ['room:read'] }),
      env,
    );
    expect(suspended.status).toBe(409);
    expect(await suspended.json()).toEqual({ error: 'PRO_ROOM_SUSPENDED' });
    expect(keyRows.size).toBe(0);
  });

  it('issues a one-time secret, preserves exact v1 digest, and lists no secret material', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
    const { env, keyRows, audits, registryRows } = createDeveloperApiAdminEnv();
    const cookie = await loginDeveloperApiAdmin(env);
    const requestId = crypto.randomUUID();
    const issueBody = {
      label: 'Friend bot',
      scopes: ['room:read', 'queue:write', 'effects:control'],
    };
    const response = await appWorker.fetch(
      issueDeveloperApiKeyRequest(cookie, issueBody, requestId),
      env,
    );
    const payload = (await response.json()) as {
      roomCode: string;
      roomGeneration: number;
      apiKey: string;
      key: {
        keyId: string;
        roomGeneration: number;
        scopes: string[];
        status: string;
        expiresAt: number;
      };
    };
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(payload.roomCode).toBe('000001');
    expect(payload.roomGeneration).toBe(0);
    expect(payload.apiKey).toMatch(/^mxqr_live_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(payload.key).toMatchObject({
      keyId: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
      roomGeneration: 0,
      scopes: ['room:read', 'queue:write', 'effects:control'],
      status: 'active',
      expiresAt: Date.now() + 90 * 86_400_000,
    });

    const [, keyMaterial] = payload.apiKey.split('mxqr_live_');
    const [keyId, secret] = keyMaterial.split('.');
    const stored = keyRows.get(keyId)!;
    expect(stored.room_code).toBe('000001');
    expect(stored.secret_digest).toBe(
      await deriveDeveloperApiKeyDigest(String(env.MXQR_DEVELOPER_API_KEY_PEPPER), keyId, secret),
    );
    expect(stored.scope_mask).toBe(1 | 16 | 128);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'key.issue',
      result: 'issued',
      keyId,
      roomCode: '000001',
      roomGeneration: 0,
    });
    expect(audits[0].actorId).toMatch(/^admin_[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(audits)).not.toContain('operator@example.com');
    expect(JSON.stringify(audits)).not.toContain(secret);

    const replay = await appWorker.fetch(
      issueDeveloperApiKeyRequest(cookie, issueBody, requestId),
      env,
    );
    const replayedPayload = (await replay.json()) as { apiKey?: string };
    expect(replay.status).toBe(200);
    expect(replayedPayload.apiKey).toBe(payload.apiKey);
    expect(keyRows.size).toBe(1);
    expect(audits).toHaveLength(1);

    registryRows.get('000001')!.status = 'suspended';
    registryRows.get('000001')!.suspension_reason = 'operator_suspended';
    const suspendedReplay = await appWorker.fetch(
      issueDeveloperApiKeyRequest(cookie, issueBody, requestId),
      env,
    );
    expect(suspendedReplay.status).toBe(409);
    await expect(suspendedReplay.json()).resolves.toEqual({ error: 'PRO_ROOM_NOT_READY' });

    const conflict = await appWorker.fetch(
      issueDeveloperApiKeyRequest(
        cookie,
        { ...issueBody, label: 'Changed integration' },
        requestId,
      ),
      env,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'DEVELOPER_API_IDEMPOTENCY_CONFLICT' });
    expect(keyRows.size).toBe(1);

    const expiryConflict = await appWorker.fetch(
      issueDeveloperApiKeyRequest(cookie, { ...issueBody, days: 30 }, requestId),
      env,
    );
    expect(expiryConflict.status).toBe(409);
    expect(await expiryConflict.json()).toEqual({
      error: 'DEVELOPER_API_IDEMPOTENCY_CONFLICT',
    });

    const list = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000001/api-keys', {
        headers: { Cookie: cookie },
      }),
      env,
    );
    const listText = await list.text();
    const listed = JSON.parse(listText) as {
      roomCode: string;
      maxActiveKeys: number;
      keys: Array<{ keyId: string; scopes: string[]; status: string }>;
    };
    expect(list.status).toBe(200);
    expect(listed).toMatchObject({
      roomCode: '000001',
      roomGeneration: 0,
      maxActiveKeys: 3,
      keys: [{ keyId, scopes: ['room:read', 'queue:write', 'effects:control'], status: 'active' }],
    });
    expect(listText).not.toContain(payload.apiKey);
    expect(listText).not.toContain(secret);
    expect(listText).not.toContain(stored.secret_digest);
    expect(listText).not.toContain('secret_digest');
  });

  it('never exposes a key when owner authority advances across issuance or replay', async () => {
    const raced = createDeveloperApiAdminEnv({ advanceAuthorityEpochAfterIssue: true });
    const racedCookie = await loginDeveloperApiAdmin(raced.env);
    const racedResponse = await appWorker.fetch(
      issueDeveloperApiKeyRequest(
        racedCookie,
        { label: 'Raced owner key', scopes: ['room:read'] },
        crypto.randomUUID(),
      ),
      raced.env,
    );
    expect(racedResponse.status).toBe(409);
    await expect(racedResponse.json()).resolves.toEqual({
      error: 'DEVELOPER_API_AUTHORITY_CHANGED',
    });
    expect(raced.keyRows.size).toBe(0);
    expect(raced.audits.map(({ action, result }) => ({ action, result }))).toEqual([
      { action: 'key.issue', result: 'issued' },
      { action: 'key.issue', result: 'authority_changed' },
    ]);

    const replayed = createDeveloperApiAdminEnv({ developerAuthorityEpoch: 4 });
    const replayCookie = await loginDeveloperApiAdmin(replayed.env);
    const requestId = crypto.randomUUID();
    const body = { label: 'Replay-bound key', scopes: ['room:read'] };
    const issued = await appWorker.fetch(
      issueDeveloperApiKeyRequest(replayCookie, body, requestId),
      replayed.env,
    );
    expect(issued.status).toBe(201);
    const issuedPayload = (await issued.json()) as { apiKey: string };
    expect(issuedPayload.apiKey).toMatch(/^mxqr_live_/);
    replayed.setDeveloperAuthorityEpoch(5);

    const staleReplay = await appWorker.fetch(
      issueDeveloperApiKeyRequest(replayCookie, body, requestId),
      replayed.env,
    );
    expect(staleReplay.status).toBe(409);
    await expect(staleReplay.json()).resolves.toEqual({
      error: 'DEVELOPER_API_AUTHORITY_CHANGED',
    });
    expect(replayed.keyRows.size).toBe(0);
    expect(replayed.audits.at(-1)).toMatchObject({
      action: 'key.issue',
      result: 'authority_changed',
    });
  });

  it('recovers the same raw key when an identical issuance wins a concurrent insert race', async () => {
    const { env, keyRows } = createDeveloperApiAdminEnv({ simulateConcurrentIssue: true });
    const cookie = await loginDeveloperApiAdmin(env);
    const response = await appWorker.fetch(
      issueDeveloperApiKeyRequest(
        cookie,
        { label: 'Concurrent bot', days: 180, scopes: ['room:read', 'queue:write'] },
        crypto.randomUUID(),
      ),
      env,
    );
    const payload = (await response.json()) as { apiKey?: string; key?: { status?: string } };

    expect(response.status).toBe(200);
    expect(payload.apiKey).toMatch(/^mxqr_live_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(payload.key?.status).toBe('active');
    expect(keyRows.size).toBe(1);
  });

  it('isolates recycled-room key administration from every earlier generation', async () => {
    const fixture = createDeveloperApiAdminEnv({ roomGeneration: 1 });
    const cookie = await loginDeveloperApiAdmin(fixture.env);
    const now = Date.now();
    fixture.keyRows.set('LegacyKeyId00001', {
      key_id: 'LegacyKeyId00001',
      room_code: '000001',
      room_generation: 0,
      authority_epoch: 0,
      label: 'Retired integration',
      secret_digest: 'L'.repeat(43),
      digest_version: 1,
      scope_mask: 1,
      status: 'active',
      created_at: now - 2_000,
      updated_at: now - 2_000,
      expires_at: now + 86_400_000,
      revoked_at: null,
      last_used_hour: null,
    });

    const list = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000001/api-keys', {
        headers: { Cookie: cookie },
      }),
      fixture.env,
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      roomCode: '000001',
      roomGeneration: 1,
      keys: [],
    });

    const staleIssue = await appWorker.fetch(
      issueDeveloperApiKeyRequest(
        cookie,
        { label: 'Stale tab', scopes: ['room:read'] },
        crypto.randomUUID(),
        0,
      ),
      fixture.env,
    );
    expect(staleIssue.status).toBe(409);
    await expect(staleIssue.json()).resolves.toEqual({
      error: 'PRO_ROOM_GENERATION_CONFLICT',
    });

    const issued = await appWorker.fetch(
      issueDeveloperApiKeyRequest(
        cookie,
        { label: 'Current integration', scopes: ['room:read'] },
        crypto.randomUUID(),
        1,
      ),
      fixture.env,
    );
    const issuedPayload = (await issued.json()) as {
      roomGeneration?: number;
      key?: { keyId?: string };
    };
    expect(issued.status).toBe(201);
    expect(issuedPayload.roomGeneration).toBe(1);
    const currentKeyId = issuedPayload.key?.keyId || '';
    expect(fixture.keyRows.get(currentKeyId)).toMatchObject({
      room_code: '000001',
      room_generation: 1,
      status: 'active',
    });

    const staleRevoke = await appWorker.fetch(
      revokeDeveloperApiKeyRequest(cookie, '000001', currentKeyId, 0),
      fixture.env,
    );
    expect(staleRevoke.status).toBe(409);
    expect(fixture.keyRows.get(currentKeyId)?.status).toBe('active');

    const revoked = await appWorker.fetch(
      revokeDeveloperApiKeyRequest(cookie, '000001', currentKeyId, 1),
      fixture.env,
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      ok: true,
      roomCode: '000001',
      roomGeneration: 1,
      keyId: currentKeyId,
    });
    expect(fixture.keyRows.get(currentKeyId)?.status).toBe('revoked');
    expect(fixture.keyRows.get('LegacyKeyId00001')?.status).toBe('active');
  });

  it('cleans expired keys, distinguishes list statuses, revokes idempotently, and binds IDs to rooms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
    const { env, keyRows, audits } = createDeveloperApiAdminEnv();
    const cookie = await loginDeveloperApiAdmin(env);
    const base = Date.now() - 10_000;
    keyRows.set('ExpiredKeyId0001', {
      key_id: 'ExpiredKeyId0001',
      room_code: '000001',
      room_generation: 0,
      authority_epoch: 0,
      label: 'Expired bot',
      secret_digest: 'A'.repeat(43),
      digest_version: 1,
      scope_mask: 1 | 2,
      status: 'active',
      created_at: base,
      updated_at: base,
      expires_at: Date.now() - 1,
      revoked_at: null,
      last_used_hour: null,
    });
    keyRows.set('RevokedKeyId0001', {
      key_id: 'RevokedKeyId0001',
      room_code: '000001',
      room_generation: 0,
      authority_epoch: 0,
      label: 'Revoked bot',
      secret_digest: 'B'.repeat(43),
      digest_version: 1,
      scope_mask: 8,
      status: 'revoked',
      created_at: base,
      updated_at: base + 2,
      expires_at: Date.now() + 86_400_000,
      revoked_at: base + 2,
      last_used_hour: base,
    });
    keyRows.set('ActiveKeyId00001', {
      key_id: 'ActiveKeyId00001',
      room_code: '000001',
      room_generation: 0,
      authority_epoch: 0,
      label: 'Active bot',
      secret_digest: 'C'.repeat(43),
      digest_version: 1,
      scope_mask: 64 | 128,
      status: 'active',
      created_at: base + 3,
      updated_at: base + 3,
      expires_at: Date.now() + 86_400_000,
      revoked_at: null,
      last_used_hour: base,
    });

    const list = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/pro-rooms/000001/api-keys', {
        headers: { Cookie: cookie },
      }),
      env,
    );
    const payload = (await list.json()) as {
      keys: Array<{ keyId: string; status: string; scopes: string[]; lastUsedAt: number | null }>;
    };
    expect(payload.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyId: 'ExpiredKeyId0001',
          status: 'expired',
          scopes: ['room:read', 'playback:read'],
        }),
        expect.objectContaining({
          keyId: 'RevokedKeyId0001',
          status: 'revoked',
          scopes: ['queue:read'],
          lastUsedAt: base,
        }),
        expect.objectContaining({
          keyId: 'ActiveKeyId00001',
          status: 'active',
          scopes: ['effects:read', 'effects:control'],
        }),
      ]),
    );
    expect(keyRows.get('ExpiredKeyId0001')).toMatchObject({
      status: 'revoked',
      revoked_at: Date.now() - 1,
      updated_at: Date.now() - 1,
    });
    expect(audits).toContainEqual({
      actorId: 'system:expiry',
      action: 'key.expire',
      result: 'expired',
      keyId: 'ExpiredKeyId0001',
      roomCode: '000001',
      roomGeneration: 0,
      createdAt: Date.now() - 1,
    });

    const wrongRoom = await appWorker.fetch(
      revokeDeveloperApiKeyRequest(cookie, '000000', 'ActiveKeyId00001'),
      env,
    );
    expect(wrongRoom.status).toBe(404);
    expect(await wrongRoom.json()).toEqual({ error: 'DEVELOPER_API_KEY_NOT_FOUND' });

    const revoke = await appWorker.fetch(
      revokeDeveloperApiKeyRequest(cookie, '000001', 'ActiveKeyId00001'),
      env,
    );
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({
      ok: true,
      roomCode: '000001',
      roomGeneration: 0,
      keyId: 'ActiveKeyId00001',
    });
    expect(keyRows.get('ActiveKeyId00001')?.status).toBe('revoked');
    expect(audits.at(-1)).toMatchObject({
      action: 'key.revoke',
      result: 'revoked',
      keyId: 'ActiveKeyId00001',
    });

    const repeat = await appWorker.fetch(
      revokeDeveloperApiKeyRequest(cookie, '000001', 'ActiveKeyId00001'),
      env,
    );
    expect(repeat.status).toBe(200);
    expect(audits.filter((entry) => entry.action === 'key.revoke')).toHaveLength(1);
  });

  it('maps the active-key trigger to 409 and never returns a raw key when audit fails', async () => {
    const fixture = createDeveloperApiAdminEnv();
    const cookie = await loginDeveloperApiAdmin(fixture.env);
    const makeRow = (index: number): DeveloperKeyRow => ({
      key_id: `ExistingKey0000${index}`,
      room_code: '000001',
      room_generation: 0,
      authority_epoch: 0,
      label: `Existing ${index}`,
      secret_digest: String(index).repeat(43),
      digest_version: 1,
      scope_mask: 1,
      status: 'active',
      created_at: Date.now() - 1_000,
      updated_at: Date.now() - 1_000,
      expires_at: Date.now() + 86_400_000,
      revoked_at: null,
      last_used_hour: null,
    });
    fixture.keyRows.set('ExistingKey00001', makeRow(1));
    fixture.keyRows.set('ExistingKey00002', makeRow(2));
    fixture.keyRows.set('ExistingKey00003', makeRow(3));
    const limited = await appWorker.fetch(
      issueDeveloperApiKeyRequest(cookie, { label: 'Fourth', scopes: ['room:read'] }),
      fixture.env,
    );
    expect(limited.status).toBe(409);
    expect(await limited.json()).toEqual({ error: 'DEVELOPER_API_ACTIVE_KEY_LIMIT' });

    fixture.keyRows.delete('ExistingKey00003');
    fixture.setFailAudit(true);
    const failedIssue = await appWorker.fetch(
      issueDeveloperApiKeyRequest(cookie, { label: 'No audit', scopes: ['room:read'] }),
      fixture.env,
    );
    const failedText = await failedIssue.text();
    expect(failedIssue.status).toBe(503);
    expect(JSON.parse(failedText)).toEqual({ error: 'DEVELOPER_API_AUDIT_UNAVAILABLE' });
    expect(failedText).not.toContain('mxqr_live_');
    expect(fixture.keyRows.size).toBe(2);
    expect(fixture.audits).toHaveLength(0);

    const before = { ...fixture.keyRows.get('ExistingKey00001')! };
    const failedRevoke = await appWorker.fetch(
      revokeDeveloperApiKeyRequest(cookie, '000001', 'ExistingKey00001'),
      fixture.env,
    );
    expect(failedRevoke.status).toBe(503);
    expect(await failedRevoke.json()).toEqual({ error: 'DEVELOPER_API_AUDIT_UNAVAILABLE' });
    expect(fixture.keyRows.get('ExistingKey00001')).toEqual(before);
  });
});

describe('Cloudflare app worker PRO room facade', () => {
  it('acks each exact owner-removal projection and never replays a stale deletion over a new owner', async () => {
    const roomCode = '000020';
    const roomGeneration = 6;
    const accountId = 'acct_0123456789abcdefghijkl';
    const registryRow: {
      room_code: string;
      label: string;
      status: string;
      suspension_reason: string | null;
      activation_state: string;
      room_generation: number;
      created_at: number;
      updated_at: number;
    } = {
      room_code: roomCode,
      label: 'Owner removal race room',
      status: 'registered',
      suspension_reason: null,
      activation_state: 'active',
      room_generation: roomGeneration,
      created_at: Date.now() - 10_000,
      updated_at: Date.now() - 1_000,
    };
    let registryWrites = 0;
    let auditWrites = 0;
    const adminDb = {
      prepare: vi.fn((sql: string) => {
        const executeRun = (...values: unknown[]) => {
          if (/^\s*INSERT INTO mxqr_pro_room_admin_audit/i.test(sql)) {
            auditWrites += 1;
            return { meta: { changes: 1 } };
          }
          if (/UPDATE mxqr_pro_room_registry/i.test(sql) && /SET status = \?3/i.test(sql)) {
            registryWrites += 1;
            registryRow.status = String(values[2]);
            registryRow.suspension_reason = values[3] == null ? null : String(values[3]);
            registryRow.activation_state = 'active';
            registryRow.updated_at = Number(values[4]);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        };
        return {
          run: vi.fn(async () => executeRun()),
          all: vi.fn(async () => ({
            results: /pragma table_info\(mxqr_pro_room_registry\)/i.test(sql)
              ? [{ name: 'room_generation' }, { name: 'suspension_reason' }]
              : /pragma table_info\(mxqr_pro_room_admin_audit\)/i.test(sql)
                ? [{ name: 'room_generation' }]
                : [],
          })),
          bind: vi.fn((...values: unknown[]) => ({
            run: vi.fn(async () => executeRun(...values)),
            first: vi.fn(async () =>
              /FROM mxqr_pro_room_registry/i.test(sql) ? { ...registryRow } : null,
            ),
            all: vi.fn(async () => ({ results: [] })),
          })),
        };
      }),
    };

    let developerKeyStatus: 'active' | 'revoked' = 'active';
    let authorityFence: {
      status: 'active' | 'cleared';
      reason: string;
      fence_digest: string;
    } | null = null;
    const fenceDigests: string[] = [];
    const developerDb = {
      prepare: vi.fn((sql: string) => {
        const bound = (...values: unknown[]) => ({
          run: vi.fn(async () => {
            if (/INSERT INTO mxqr_developer_api_room_authority_fences/i.test(sql)) {
              const nextDigest = String(values[3]);
              fenceDigests.push(nextDigest);
              authorityFence =
                authorityFence?.fence_digest === nextDigest && authorityFence.status === 'cleared'
                  ? authorityFence
                  : { status: 'active', reason: String(values[2]), fence_digest: nextDigest };
              return { meta: { changes: 1 } };
            }
            if (/UPDATE mxqr_developer_api_keys/i.test(sql)) {
              const changed = developerKeyStatus === 'active' ? 1 : 0;
              developerKeyStatus = 'revoked';
              return { meta: { changes: changed } };
            }
            if (/INSERT OR IGNORE INTO mxqr_developer_api_admin_audit/i.test(sql)) {
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }),
          first: vi.fn(async () =>
            /FROM mxqr_developer_api_room_authority_fences/i.test(sql) && authorityFence
              ? { ...authorityFence, fenced_at: Date.now(), updated_at: Date.now() }
              : null,
          ),
          all: vi.fn(async () => ({
            results:
              /FROM mxqr_developer_api_keys/i.test(sql) &&
              developerKeyStatus === 'active' &&
              authorityFence?.status === 'active'
                ? [{ key_id: 'ActiveKey0000001' }]
                : [],
          })),
        });
        return { bind: vi.fn(bound), run: vi.fn(async () => bound().run()) };
      }),
      batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      }),
    };

    type Removal = { removalId: string; epoch: number; fencedEpoch: number; acked: boolean };
    let roomStatus: 'active' | 'suspended' = 'suspended';
    let removal: Removal | null = {
      removalId: 'removal_abcdefghijklmnopqrstuv',
      epoch: 2,
      fencedEpoch: 3,
      acked: false,
    };
    let failFirstAck = true;
    const authorityCallOrder: string[] = [];
    const adminFetch = vi.fn(async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/internal/admin/account-authority/classify') {
        throw new Error('owner deletion must not use a split classify request');
      }
      if (pathname === '/internal/admin/account-authority/purge') {
        authorityCallOrder.push('purge');
        if (!removal) {
          return Response.json({
            ok: true,
            roomCode,
            roomGeneration,
            status: roomStatus,
            suspensionReason: roomStatus === 'active' ? null : 'owner_account_deleted',
            ownerAuthorityRemoved: false,
            removalId: null,
            removedOwnerAuthorityEpoch: null,
            fencedCoordinatorEpoch: null,
            projectionAcked: true,
            removedSessions: 0,
          });
        }
        return Response.json({
          ok: true,
          roomCode,
          roomGeneration,
          status: 'suspended',
          suspensionReason: 'owner_account_deleted',
          ownerAuthorityRemoved: true,
          removalId: removal.removalId,
          removedOwnerAuthorityEpoch: removal.epoch,
          fencedCoordinatorEpoch: removal.fencedEpoch,
          projectionAcked: removal.acked,
          removedSessions: 1,
        });
      }
      expect(pathname).toBe('/internal/admin/account-authority/purge/ack');
      authorityCallOrder.push('ack');
      const body = (await request.json()) as {
        accountId: string;
        removalId: string;
        removedOwnerAuthorityEpoch: number;
        fencedCoordinatorEpoch: number;
      };
      expect(body).toEqual({
        accountId,
        removalId: removal?.removalId,
        removedOwnerAuthorityEpoch: removal?.epoch,
        fencedCoordinatorEpoch: removal?.fencedEpoch,
        roomGeneration,
      });
      if (failFirstAck) {
        failFirstAck = false;
        return Response.json({ error: 'ACK_UNAVAILABLE' }, { status: 503 });
      }
      if (!removal) {
        return Response.json({ error: 'OWNER_AUTHORITY_REMOVAL_MISMATCH' }, { status: 409 });
      }
      const changed = !removal.acked;
      removal.acked = true;
      return Response.json({
        ok: true,
        roomCode,
        roomGeneration,
        status: 'suspended',
        suspensionReason: 'owner_account_deleted',
        ownerAuthorityRemoved: true,
        removalId: removal.removalId,
        removedOwnerAuthorityEpoch: removal.epoch,
        fencedCoordinatorEpoch: removal.fencedEpoch,
        projectionAcked: true,
        changed,
      });
    });
    let signalingAttempts = 0;
    let forceInvalidStaleProof = false;
    const signalingFetch = vi.fn(async (request: Request) => {
      authorityCallOrder.push('signaling');
      signalingAttempts += 1;
      const body = (await request.json()) as {
        roomCode: string;
        roomGeneration: number;
        removalId: string;
        removedOwnerAuthorityEpoch: number;
        fencedCoordinatorEpoch: number;
      };
      expect(body).toEqual({
        roomCode,
        roomGeneration,
        removalId: removal?.removalId,
        removedOwnerAuthorityEpoch: removal?.epoch,
        fencedCoordinatorEpoch: removal?.fencedEpoch,
      });
      const staleProof = forceInvalidStaleProof || signalingAttempts === 2;
      return Response.json({
        ok: true,
        roomCode,
        roomGeneration,
        status: 'suspended',
        reason: 'owner_account_deleted',
        fenceStatus: staleProof ? 'stale' : 'installed',
        changed: !staleProof,
        removalId: body.removalId,
        removedOwnerAuthorityEpoch: body.removedOwnerAuthorityEpoch,
        fencedCoordinatorEpoch: body.fencedCoordinatorEpoch,
        effectiveCoordinatorEpoch:
          body.fencedCoordinatorEpoch + (staleProof && !forceInvalidStaleProof ? 1 : 0),
      });
    });
    const env = {
      MUSIXQUARE_ADMIN_DB: adminDb,
      DEVELOPER_API_DB: developerDb,
      MXQR_DEVELOPER_API_KEY_PEPPER: 'developer-pepper-for-tests-at-least-32-bytes',
      MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: 'assertion-secret-for-tests-at-least-32-bytes',
      PRO_ROOM_ADMIN_ROOMS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch: adminFetch })),
      },
      PRO_SIGNALING_ROOMS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch: signalingFetch })),
      },
    };

    await expect(
      purgeProRoomAccountAuthorityForTests({ accountId, roomCode, roomGeneration }, env),
    ).resolves.toBe(false);
    expect(removal?.acked).toBe(false);
    expect(registryRow).toMatchObject({
      status: 'suspended',
      suspension_reason: 'owner_account_deleted',
    });
    expect(authorityFence).toMatchObject({ status: 'active', reason: 'owner_account_deleted' });
    expect(developerKeyStatus).toBe('revoked');
    expect(authorityCallOrder.slice(0, 3)).toEqual(['purge', 'signaling', 'ack']);

    await expect(
      purgeProRoomAccountAuthorityForTests({ accountId, roomCode, roomGeneration }, env),
    ).resolves.toBe(true);
    expect(removal?.acked).toBe(true);
    const firstRemovalDigest = fenceDigests.at(-1);

    // A stale response is accepted only when it proves a strictly newer
    // effective authority boundary. Merely labeling the same epoch as stale
    // must stop before any D1 projection or acknowledgement write.
    forceInvalidStaleProof = true;
    const writesBeforeInvalidProof = {
      registryWrites,
      auditWrites,
      fences: fenceDigests.length,
    };
    await expect(
      purgeProRoomAccountAuthorityForTests({ accountId, roomCode, roomGeneration }, env),
    ).resolves.toBe(false);
    expect({ registryWrites, auditWrites, fences: fenceDigests.length }).toEqual(
      writesBeforeInvalidProof,
    );
    forceInvalidStaleProof = false;

    // A completed transfer clears the old removal tuple. A late account-delete
    // retry for the previous owner must become a non-owner no-op and must not
    // overwrite the new active registry/fence/key projection.
    removal = null;
    roomStatus = 'active';
    registryRow.status = 'registered';
    registryRow.suspension_reason = null;
    const transferredFence = authorityFence as {
      status: 'active' | 'cleared';
      reason: string;
      fence_digest: string;
    } | null;
    if (transferredFence) transferredFence.status = 'cleared';
    developerKeyStatus = 'active';
    const writesBeforeStaleRetry = {
      registryWrites,
      auditWrites,
      fences: fenceDigests.length,
      signalingCalls: signalingFetch.mock.calls.length,
    };
    await expect(
      purgeProRoomAccountAuthorityForTests({ accountId, roomCode, roomGeneration }, env),
    ).resolves.toBe(true);
    expect({
      registryWrites,
      auditWrites,
      fences: fenceDigests.length,
      signalingCalls: signalingFetch.mock.calls.length,
    }).toEqual(writesBeforeStaleRetry);
    expect(registryRow.status).toBe('registered');
    expect(developerKeyStatus).toBe('active');

    // If the same account later owns the room and is deleted again, the new
    // DO removal tuple must derive a fresh fence instead of replaying the old
    // cleared digest.
    removal = {
      removalId: 'removal_qrstuvwxyzABCDEFGHIJKL',
      epoch: 4,
      fencedEpoch: 6,
      acked: false,
    };
    roomStatus = 'suspended';
    await expect(
      purgeProRoomAccountAuthorityForTests({ accountId, roomCode, roomGeneration }, env),
    ).resolves.toBe(true);
    expect(fenceDigests.at(-1)).not.toBe(firstRemovalDigest);
    expect(authorityFence).toMatchObject({ status: 'active', reason: 'owner_account_deleted' });
    expect(developerKeyStatus).toBe('revoked');
    expect(registryRow).toMatchObject({
      status: 'suspended',
      suspension_reason: 'owner_account_deleted',
    });
  });

  it('re-suspends a committed transfer when the target account is deleted during finalization', async () => {
    const roomCode = '000021';
    const roomGeneration = 7;
    const targetAccountId = 'acct_0123456789abcdefghijkl';
    const previousOwnerAccountId = 'acct_abcdefghijkl0123456789';
    const registryRow: {
      room_code: string;
      label: string;
      status: string;
      suspension_reason: string | null;
      activation_state: string;
      room_generation: number;
      created_at: number;
      updated_at: number;
    } = {
      room_code: roomCode,
      label: 'Owner recovery room',
      status: 'suspended',
      suspension_reason: 'owner_account_deleted',
      activation_state: 'active',
      room_generation: roomGeneration,
      created_at: Date.now() - 10_000,
      updated_at: Date.now() - 1_000,
    };
    const registryAudits: Array<{ action: string; result: string }> = [];
    let sagaRow: Record<string, unknown> | null = null;
    let issuanceRow: Record<string, unknown> | null = null;
    const adminDb = {
      prepare: vi.fn((sql: string) => {
        const executeRun = (...values: unknown[]) => {
          if (/^\s*INSERT INTO mxqr_pro_room_admin_audit/i.test(sql)) {
            registryAudits.push({ action: String(values[1]), result: String(values[2]) });
            return { meta: { changes: 1 } };
          }
          if (/INSERT OR IGNORE INTO mxqr_pro_room_owner_transfer_sagas/i.test(sql)) {
            sagaRow ||= {
              room_code: values[0],
              room_generation: values[1],
              claim_generation: null,
              transfer_id: null,
              request_id: values[2],
              target_account_id: values[3],
              previous_owner_account_id: null,
              fence_digest: null,
              state: 'intent',
              intent_at: values[4],
              prepared_at: null,
              expires_at: values[5],
              updated_at: values[4],
            };
            return { meta: { changes: 1 } };
          }
          if (/INSERT OR IGNORE INTO mxqr_pro_room_owner_transfer_issuances/i.test(sql)) {
            issuanceRow ||= {
              room_code: values[0],
              room_generation: values[1],
              claim_generation: values[2],
              target_account_id: values[3],
              transfer_id: values[4],
              request_id: values[5],
              state: 'prepared',
              issued_at: values[6],
              expires_at: values[7],
              updated_at: values[8],
            };
            return { meta: { changes: 1 } };
          }
          if (/UPDATE mxqr_pro_room_owner_transfer_issuances/i.test(sql)) {
            if (issuanceRow) issuanceRow.state = 'prepared';
            return { meta: { changes: issuanceRow ? 1 : 0 } };
          }
          if (/UPDATE mxqr_pro_room_owner_transfer_sagas/i.test(sql)) {
            if (sagaRow) {
              if (/SET claim_generation = \?4/i.test(sql)) {
                sagaRow.claim_generation = values[3];
                sagaRow.transfer_id = values[4];
                sagaRow.previous_owner_account_id = values[6];
                sagaRow.fence_digest = values[7];
                sagaRow.state = 'prepared';
                sagaRow.prepared_at = values[8];
                sagaRow.expires_at = values[9];
                sagaRow.updated_at = values[10];
              } else {
                sagaRow.state = String(values[4]);
                sagaRow.updated_at = values[5];
              }
            }
            return { meta: { changes: sagaRow ? 1 : 0 } };
          }
          if (/UPDATE mxqr_pro_room_registry/i.test(sql)) {
            if (/SET status = 'suspended'/i.test(sql) && values.length >= 4) {
              registryRow.status = 'suspended';
              registryRow.suspension_reason = String(values[2]);
              registryRow.activation_state = 'active';
              registryRow.updated_at = Number(values[3]);
              return { meta: { changes: 1 } };
            }
            if (/SET status = \?3/i.test(sql)) {
              registryRow.status = String(values[2]);
              registryRow.suspension_reason = values[3] == null ? null : String(values[3]);
              registryRow.activation_state = 'active';
              registryRow.updated_at = Number(values[4]);
              return { meta: { changes: 1 } };
            }
          }
          return { meta: { changes: 0 } };
        };
        return {
          run: vi.fn(async () => executeRun()),
          all: vi.fn(async () => ({
            results: /pragma table_info\(mxqr_pro_room_registry\)/i.test(sql)
              ? [{ name: 'room_generation' }, { name: 'suspension_reason' }]
              : /pragma table_info\(mxqr_pro_room_admin_audit\)/i.test(sql)
                ? [{ name: 'room_generation' }]
                : [],
          })),
          bind: vi.fn((...values: unknown[]) => ({
            run: vi.fn(async () => executeRun(...values)),
            first: vi.fn(async () => {
              if (/FROM mxqr_pro_room_registry/i.test(sql) && values[0] === roomCode) {
                return { ...registryRow };
              }
              if (/FROM mxqr_pro_room_owner_transfer_sagas/i.test(sql)) {
                return sagaRow ? { ...sagaRow } : null;
              }
              return null;
            }),
            all: vi.fn(async () => ({ results: [] })),
          })),
        };
      }),
    };

    let targetChecks = 0;
    const linkedAccounts = new Set([previousOwnerAccountId]);
    const authDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          first: vi.fn(async () => {
            if (/FROM mxqr_account_sessions s/i.test(sql)) {
              return {
                session_hash: 'session-hash',
                account_id: targetAccountId,
                last_seen_at: Date.now(),
                expires_at: Date.now() + 60_000,
                nickname: 'Target owner',
                profile_complete: 1,
                status: 'active',
              };
            }
            if (/FROM mxqr_accounts AS account/i.test(sql)) {
              targetChecks += 1;
              return targetChecks <= 2
                ? { account_id: targetAccountId, nickname: 'Target owner' }
                : null;
            }
            return null;
          }),
          run: vi.fn(async () => {
            if (/INSERT INTO mxqr_account_pro_room_generations/i.test(sql)) {
              linkedAccounts.add(String(values[0]));
              return { meta: { changes: 1 } };
            }
            if (/DELETE FROM mxqr_account_pro_room_generations/i.test(sql)) {
              linkedAccounts.delete(String(values[0]));
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }),
          all: vi.fn(async () => ({ results: [] })),
        })),
      })),
    };

    const developerKey = { status: 'active' as 'active' | 'revoked' };
    let authorityFence: {
      status: 'active' | 'cleared';
      reason: string;
      fence_digest: string;
      fenced_at: number;
      updated_at: number;
    } | null = null;
    const developerDb = {
      prepare: vi.fn((sql: string) => {
        const bound = (...values: unknown[]) => ({
          run: vi.fn(async () => {
            if (/INSERT INTO mxqr_developer_api_room_authority_fences/i.test(sql)) {
              authorityFence = {
                status: 'active',
                reason: String(values[2]),
                fence_digest: String(values[3]),
                fenced_at: Number(values[4]),
                updated_at: Number(values[4]),
              };
              return { meta: { changes: 1 } };
            }
            if (/UPDATE mxqr_developer_api_keys/i.test(sql)) {
              const changed = developerKey.status === 'active' ? 1 : 0;
              developerKey.status = 'revoked';
              return { meta: { changes: changed } };
            }
            if (/INSERT OR IGNORE INTO mxqr_developer_api_admin_audit/i.test(sql)) {
              return { meta: { changes: 1 } };
            }
            if (/SET status = 'cleared'/i.test(sql)) {
              const currentFence = authorityFence;
              if (currentFence && currentFence.fence_digest === values[2]) {
                currentFence.status = 'cleared';
              }
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }),
          first: vi.fn(async () =>
            /FROM mxqr_developer_api_room_authority_fences/i.test(sql) && authorityFence
              ? { ...authorityFence }
              : null,
          ),
          all: vi.fn(async () => ({
            results:
              /FROM mxqr_developer_api_keys/i.test(sql) &&
              developerKey.status === 'active' &&
              authorityFence?.status === 'active'
                ? [{ key_id: 'ActiveKey0000001' }]
                : [],
          })),
        });
        return { bind: vi.fn(bound), run: vi.fn(async () => bound().run()) };
      }),
      batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      }),
    };

    let durableStatus: 'suspended' | 'active' = 'suspended';
    let durableSuspensionReason: string | null = 'ownership_transfer_pending';
    const adminNamespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        fetch: vi.fn(async (request: Request) => {
          const pathname = new URL(request.url).pathname;
          if (pathname === '/internal/admin/status') {
            return Response.json({
              roomCode,
              roomGeneration,
              provisioned: true,
              status: durableStatus,
              suspensionReason: durableSuspensionReason,
            });
          }
          if (pathname === '/internal/admin/owner-transfer/commit') {
            expect(linkedAccounts.has(targetAccountId)).toBe(true);
            durableStatus = 'active';
            durableSuspensionReason = null;
            const headers = new Headers({ 'Content-Type': 'application/json' });
            headers.append(
              'Set-Cookie',
              `__Host-mxqr_pro_session_${roomCode}=session-secret; Path=/; HttpOnly; Secure`,
            );
            headers.append(
              'Set-Cookie',
              `__Host-mxqr_pro_owner_${roomCode}=owner-secret; Path=/; HttpOnly; Secure`,
            );
            return new Response(
              JSON.stringify({
                ok: true,
                roomCode,
                roomGeneration,
                status: 'active',
                suspensionReason: null,
                transferId: 'transfer_abcdefghijklmnopqrstuv',
                replayed: false,
                snapshot: { roomCode, status: 'active' },
                session: { expiresAtMs: Date.now() + 60_000 },
              }),
              { headers },
            );
          }
          if (pathname === '/internal/admin/account-authority/classify') {
            throw new Error('owner deletion must not use a split classify request');
          }
          if (pathname === '/internal/admin/account-authority/purge') {
            durableStatus = 'suspended';
            durableSuspensionReason = 'owner_account_deleted';
            return Response.json({
              ok: true,
              roomCode,
              roomGeneration,
              status: 'suspended',
              suspensionReason: 'owner_account_deleted',
              ownerAuthorityRemoved: true,
              removalId: 'removal_abcdefghijklmnopqrstuv',
              removedOwnerAuthorityEpoch: 9,
              fencedCoordinatorEpoch: 12,
              projectionAcked: false,
              removedSessions: 1,
            });
          }
          expect(pathname).toBe('/internal/admin/account-authority/purge/ack');
          return Response.json({
            ok: true,
            roomCode,
            roomGeneration,
            status: 'suspended',
            suspensionReason: 'owner_account_deleted',
            ownerAuthorityRemoved: true,
            removalId: 'removal_abcdefghijklmnopqrstuv',
            removedOwnerAuthorityEpoch: 9,
            fencedCoordinatorEpoch: 12,
            projectionAcked: true,
            changed: true,
          });
        }),
      })),
    };
    let forwardedPrepare: Request | null = null;
    let prepareAttempts = 0;
    const publicFetch = vi.fn(async (request: Request) => {
      forwardedPrepare = request;
      prepareAttempts += 1;
      expect(linkedAccounts.has(targetAccountId)).toBe(false);
      if (prepareAttempts === 1) {
        return Response.json({ error: 'OWNER_TRANSFER_CLAIM_INVALID' }, { status: 401 });
      }
      if (prepareAttempts === 2) {
        return Response.json({ error: 'OWNER_TRANSFER_TARGET_ACCOUNT_MISMATCH' }, { status: 409 });
      }
      const preparedAtMs = Date.now();
      const expiresAtMs = preparedAtMs + 5 * 60 * 1000;
      return Response.json({
        ok: true,
        roomCode,
        roomGeneration,
        status: 'suspended',
        suspensionReason: 'ownership_transfer_pending',
        transferId: 'transfer_abcdefghijklmnopqrstuv',
        commitProof: 'P'.repeat(43),
        targetAccountId,
        previousOwnerAccountId,
        claimGeneration: 11,
        preparedAtMs,
        expiresAtMs,
        committedAtMs: null,
        replayUntilMs: expiresAtMs,
        replayed: false,
      });
    });
    const env = {
      GOOGLE_OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
      MXQR_AUTH_SESSION_PEPPER: 'session-pepper-for-tests-at-least-32-bytes',
      MXQR_AUTH_SUBJECT_PEPPER: 'subject-pepper-for-tests-at-least-32-bytes',
      MXQR_OAUTH_STATE_SECRET: 'state-secret-for-tests-at-least-32-bytes',
      MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: 'assertion-secret-for-tests-at-least-32-bytes',
      MXQR_DEVELOPER_API_KEY_PEPPER: 'developer-pepper-for-tests-at-least-32-bytes',
      MUSIXQUARE_AUTH_DB: authDb,
      MUSIXQUARE_ADMIN_DB: adminDb,
      DEVELOPER_API_DB: developerDb,
      PRO_ROOM_ADMIN_ROOMS: adminNamespace,
      PRO_SIGNALING_ROOMS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          fetch: vi.fn(async (request: Request) => {
            const body = (await request.json()) as {
              removalId: string;
              removedOwnerAuthorityEpoch: number;
              fencedCoordinatorEpoch: number;
            };
            return Response.json({
              ok: true,
              roomCode,
              roomGeneration,
              status: 'suspended',
              reason: 'owner_account_deleted',
              fenceStatus: 'installed',
              changed: true,
              removalId: body.removalId,
              removedOwnerAuthorityEpoch: body.removedOwnerAuthorityEpoch,
              fencedCoordinatorEpoch: body.fencedCoordinatorEpoch,
              effectiveCoordinatorEpoch: body.fencedCoordinatorEpoch,
            });
          }),
        })),
      },
      PRO_ROOM_PUBLIC_API: { fetch: publicFetch },
    };

    const transferRequest = () =>
      new Request(`https://musixquare.com/api/pro-room/v1/rooms/${roomCode}/owner-transfer`, {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          Cookie: `__Host-mxqr_account=${'S'.repeat(43)}`,
        },
        body: JSON.stringify({
          claimToken: `v1.${'C'.repeat(43)}.${'D'.repeat(43)}`,
          newPin: '20020924',
          requestId: 'request_12345678',
        }),
      });

    const invalid = await appWorker.fetch(transferRequest(), env);
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toEqual({ error: 'OWNER_TRANSFER_CLAIM_INVALID' });
    expect(linkedAccounts.has(targetAccountId)).toBe(false);

    const mismatch = await appWorker.fetch(transferRequest(), env);
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toEqual({
      error: 'OWNER_TRANSFER_TARGET_ACCOUNT_MISMATCH',
    });
    expect(linkedAccounts.has(targetAccountId)).toBe(false);

    const response = await appWorker.fetch(transferRequest(), env);

    await expect(response.json()).resolves.toEqual({
      error: 'OWNER_TRANSFER_TARGET_UNAVAILABLE',
    });
    expect(response.status).toBe(409);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(publicFetch).toHaveBeenCalledTimes(3);
    expect(new URL(forwardedPrepare!.url).pathname).toBe(
      `/v1/rooms/${roomCode}/owner-transfer/prepare`,
    );
    expect(forwardedPrepare!.headers.get('X-MXQR-Account-Assertion')).not.toBeNull();
    expect(targetChecks).toBe(3);
    expect(registryRow).toMatchObject({
      status: 'suspended',
      suspension_reason: 'owner_account_deleted',
      activation_state: 'active',
    });
    expect(durableStatus).toBe('suspended');
    expect(durableSuspensionReason).toBe('owner_account_deleted');
    expect(authorityFence).toMatchObject({
      status: 'active',
      reason: 'owner_account_deleted',
    });
    expect(developerKey.status).toBe('revoked');
    expect(linkedAccounts.has(previousOwnerAccountId)).toBe(false);
    expect(linkedAccounts.has(targetAccountId)).toBe(true);
    expect(registryAudits).toEqual(
      expect.arrayContaining([
        { action: 'owner_transfer.prepare', result: 'success' },
        { action: 'room.suspend', result: 'owner_account_deleted' },
        { action: 'owner_transfer.commit', result: 'target_deleted_during_finalize' },
      ]),
    );
  });

  it('adopts a prepared DO transfer after the D1 saga fill fails and reconciles without persisting secrets', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-07-20T12:00:00.000Z');
    vi.setSystemTime(startedAtMs);
    const roomCode = '000022';
    const roomGeneration = 8;
    const targetAccountId = 'acct_0123456789abcdefghijkl';
    const previousOwnerAccountId = 'acct_abcdefghijkl0123456789';
    const transferId = 'transfer_abcdefghijklmnopqrstuv';
    const originalRequestId = 'request_12345678';
    const preparedAtMs = startedAtMs - 30_000;
    const expiresAtMs = startedAtMs + 5 * 60_000;
    const committedAtMs = startedAtMs;
    const replayUntilMs = committedAtMs + 10 * 60 * 1000;
    const registryRow: {
      room_code: string;
      label: string;
      status: string;
      suspension_reason: string | null;
      activation_state: string;
      room_generation: number;
      created_at: number;
      updated_at: number;
    } = {
      room_code: roomCode,
      label: 'Replay recovery room',
      status: 'suspended',
      suspension_reason: 'owner_account_deleted',
      activation_state: 'active',
      room_generation: roomGeneration,
      created_at: startedAtMs - 10_000,
      updated_at: startedAtMs - 1_000,
    };
    const registryAudits: Array<{ action: string; result: string }> = [];
    const adminDbBinds: unknown[][] = [];
    let sagaRow: Record<string, unknown> | null = null;
    let issuanceRow: Record<string, unknown> | null = null;
    let failSagaFillOnce = true;
    const adminDb = {
      prepare: vi.fn((sql: string) => {
        const executeRun = (...values: unknown[]) => {
          if (/^\s*INSERT INTO mxqr_pro_room_admin_audit/i.test(sql)) {
            registryAudits.push({ action: String(values[1]), result: String(values[2]) });
            return { meta: { changes: 1 } };
          }
          if (/INSERT OR IGNORE INTO mxqr_pro_room_owner_transfer_sagas/i.test(sql)) {
            sagaRow ||= {
              room_code: values[0],
              room_generation: values[1],
              claim_generation: null,
              transfer_id: null,
              request_id: values[2],
              target_account_id: values[3],
              previous_owner_account_id: null,
              fence_digest: null,
              state: 'intent',
              intent_at: values[4],
              prepared_at: null,
              expires_at: values[5],
              updated_at: values[4],
            };
            return { meta: { changes: 1 } };
          }
          if (/INSERT OR IGNORE INTO mxqr_pro_room_owner_transfer_issuances/i.test(sql)) {
            issuanceRow ||= {
              room_code: values[0],
              room_generation: values[1],
              claim_generation: values[2],
              target_account_id: values[3],
              transfer_id: values[4],
              request_id: values[5],
              state: 'prepared',
              issued_at: values[6],
              expires_at: values[7],
              updated_at: values[8],
            };
            return { meta: { changes: 1 } };
          }
          if (/UPDATE mxqr_pro_room_owner_transfer_issuances/i.test(sql)) {
            if (issuanceRow) issuanceRow.state = 'prepared';
            return { meta: { changes: issuanceRow ? 1 : 0 } };
          }
          if (/UPDATE mxqr_pro_room_owner_transfer_sagas/i.test(sql)) {
            if (sagaRow) {
              if (/SET claim_generation = \?4/i.test(sql)) {
                if (failSagaFillOnce) {
                  failSagaFillOnce = false;
                  throw new Error('simulated saga fill failure after DO prepare');
                }
                sagaRow.claim_generation = values[3];
                sagaRow.transfer_id = values[4];
                sagaRow.previous_owner_account_id = values[6];
                sagaRow.fence_digest = values[7];
                sagaRow.state = 'prepared';
                sagaRow.prepared_at = values[8];
                sagaRow.expires_at = values[9];
                sagaRow.updated_at = values[10];
              } else {
                sagaRow.state = String(values[4]);
                sagaRow.updated_at = values[5];
              }
            }
            return { meta: { changes: sagaRow ? 1 : 0 } };
          }
          if (/UPDATE mxqr_pro_room_registry/i.test(sql)) {
            if (/SET status = 'suspended'/i.test(sql)) {
              registryRow.status = 'suspended';
              registryRow.suspension_reason = String(values[2]);
              registryRow.activation_state = 'active';
              registryRow.updated_at = Number(values[3]);
              return { meta: { changes: 1 } };
            }
            if (/SET status = \?3/i.test(sql)) {
              registryRow.status = String(values[2]);
              registryRow.suspension_reason = values[3] == null ? null : String(values[3]);
              registryRow.activation_state = 'active';
              registryRow.updated_at = Number(values[4]);
              return { meta: { changes: 1 } };
            }
          }
          return { meta: { changes: 0 } };
        };
        return {
          run: vi.fn(async () => executeRun()),
          all: vi.fn(async () => ({
            results: /pragma table_info\(mxqr_pro_room_registry\)/i.test(sql)
              ? [{ name: 'room_generation' }, { name: 'suspension_reason' }]
              : /pragma table_info\(mxqr_pro_room_admin_audit\)/i.test(sql)
                ? [{ name: 'room_generation' }]
                : /FROM mxqr_pro_room_owner_transfer_sagas/i.test(sql) &&
                    /state NOT IN/i.test(sql) &&
                    sagaRow &&
                    !['complete', 'target_deleted', 'expired', 'superseded'].includes(
                      String(sagaRow.state),
                    )
                  ? [{ ...sagaRow }]
                  : [],
          })),
          bind: vi.fn((...values: unknown[]) => {
            adminDbBinds.push(values);
            return {
              run: vi.fn(async () => executeRun(...values)),
              first: vi.fn(async () => {
                if (/FROM mxqr_pro_room_registry/i.test(sql) && values[0] === roomCode) {
                  return { ...registryRow };
                }
                if (/FROM mxqr_pro_room_owner_transfer_sagas/i.test(sql)) {
                  return sagaRow ? { ...sagaRow } : null;
                }
                return null;
              }),
              all: vi.fn(async () => ({ results: [] })),
            };
          }),
        };
      }),
    };

    const linkedAccounts = new Set([previousOwnerAccountId]);
    let failPreviousOwnerCleanup = false;
    const authDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          first: vi.fn(async () => {
            if (/FROM mxqr_account_sessions s/i.test(sql)) {
              return {
                session_hash: 'session-hash',
                account_id: targetAccountId,
                last_seen_at: Date.now(),
                expires_at: Date.now() + 60_000,
                nickname: 'Target owner',
                profile_complete: 1,
                status: 'active',
              };
            }
            if (/FROM mxqr_accounts AS account/i.test(sql)) {
              return { account_id: targetAccountId, nickname: 'Target owner' };
            }
            return null;
          }),
          run: vi.fn(async () => {
            if (/INSERT INTO mxqr_account_pro_room_generations/i.test(sql)) {
              linkedAccounts.add(String(values[0]));
              return { meta: { changes: 1 } };
            }
            if (/DELETE FROM mxqr_account_pro_room_generations/i.test(sql)) {
              const accountId = String(values[0]);
              if (accountId === previousOwnerAccountId && failPreviousOwnerCleanup) {
                failPreviousOwnerCleanup = false;
                throw new Error('simulated response-loss boundary');
              }
              linkedAccounts.delete(accountId);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }),
          all: vi.fn(async () => ({ results: [] })),
        })),
      })),
    };

    const developerKey = { status: 'active' as 'active' | 'revoked' };
    let authorityFence: {
      status: 'active' | 'cleared';
      reason: string;
      fence_digest: string;
      fenced_at: number;
      updated_at: number;
    } | null = null;
    const developerDb = {
      prepare: vi.fn((sql: string) => {
        const bound = (...values: unknown[]) => ({
          run: vi.fn(async () => {
            if (/INSERT INTO mxqr_developer_api_room_authority_fences/i.test(sql)) {
              authorityFence = {
                status: 'active',
                reason: String(values[2]),
                fence_digest: String(values[3]),
                fenced_at: Number(values[4]),
                updated_at: Number(values[4]),
              };
              return { meta: { changes: 1 } };
            }
            if (/UPDATE mxqr_developer_api_keys/i.test(sql)) {
              const changed = developerKey.status === 'active' ? 1 : 0;
              developerKey.status = 'revoked';
              return { meta: { changes: changed } };
            }
            if (/INSERT OR IGNORE INTO mxqr_developer_api_admin_audit/i.test(sql)) {
              return { meta: { changes: 1 } };
            }
            if (/SET status = 'cleared'/i.test(sql)) {
              const currentFence = authorityFence;
              if (currentFence && currentFence.fence_digest === values[2]) {
                currentFence.status = 'cleared';
              }
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }),
          first: vi.fn(async () =>
            /FROM mxqr_developer_api_room_authority_fences/i.test(sql) && authorityFence
              ? { ...authorityFence }
              : null,
          ),
          all: vi.fn(async () => ({
            results:
              /FROM mxqr_developer_api_keys/i.test(sql) &&
              developerKey.status === 'active' &&
              authorityFence?.status === 'active'
                ? [{ key_id: 'ActiveKey0000001' }]
                : [],
          })),
        });
        return { bind: vi.fn(bound), run: vi.fn(async () => bound().run()) };
      }),
      batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      }),
    };

    let durableStatus: 'suspended' | 'active' = 'suspended';
    let durableSuspensionReason: string | null = 'ownership_transfer_pending';
    let prepared = false;
    let committed = false;
    let commitCalls = 0;
    let reconcileCalls = 0;
    const adminNamespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        fetch: vi.fn(async (request: Request) => {
          const pathname = new URL(request.url).pathname;
          if (pathname === '/internal/admin/status') {
            return Response.json({
              roomCode,
              roomGeneration,
              provisioned: true,
              status: durableStatus,
              suspensionReason: durableSuspensionReason,
              ownerTransferReconciliation: committed
                ? {
                    phase: 'completed',
                    transferId,
                    claimGeneration: null,
                    requestId: originalRequestId,
                    targetAccountId,
                    previousOwnerAccountId,
                    preparedAtMs,
                    expiresAtMs,
                    committedAtMs,
                    replayUntilMs,
                  }
                : prepared
                  ? {
                      phase: 'pending',
                      transferId,
                      claimGeneration: 12,
                      requestId: originalRequestId,
                      targetAccountId,
                      previousOwnerAccountId,
                      preparedAtMs,
                      expiresAtMs,
                      committedAtMs: null,
                      replayUntilMs: expiresAtMs,
                    }
                  : null,
            });
          }
          expect([
            '/internal/admin/owner-transfer/commit',
            '/internal/admin/owner-transfer/reconcile',
          ]).toContain(pathname);
          const body = (await request.json()) as Record<string, unknown>;
          expect(body.requestId).toBe(originalRequestId);
          if (pathname === '/internal/admin/owner-transfer/reconcile') {
            reconcileCalls += 1;
            expect(Object.keys(body).sort()).toEqual(
              [
                'requestId',
                'revocationReceipt',
                'roomGeneration',
                'targetAccountId',
                'transferId',
              ].sort(),
            );
            expect(body).not.toHaveProperty('commitProof');
          } else {
            commitCalls += 1;
            expect(body.commitProof).toBe('P'.repeat(43));
          }
          committed = true;
          durableStatus = 'active';
          durableSuspensionReason = null;
          if (pathname === '/internal/admin/owner-transfer/reconcile') {
            return Response.json({
              ok: true,
              roomCode,
              roomGeneration,
              status: 'active',
              suspensionReason: null,
              transferId,
              requestId: originalRequestId,
              targetAccountId,
              previousOwnerAccountId,
              replayed: false,
            });
          }
          const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
          responseHeaders.append(
            'Set-Cookie',
            `__Host-mxqr_pro_session_${roomCode}=session-secret; Path=/; HttpOnly; Secure`,
          );
          responseHeaders.append(
            'Set-Cookie',
            `__Host-mxqr_pro_owner_${roomCode}=owner-secret; Path=/; HttpOnly; Secure`,
          );
          return new Response(
            JSON.stringify({
              ok: true,
              roomCode,
              roomGeneration,
              status: 'active',
              suspensionReason: null,
              transferId,
              replayed: commitCalls > 1,
              snapshot: { roomCode, status: 'active' },
              session: { expiresAtMs: Date.now() + 60 * 60 * 1000 },
            }),
            { headers: responseHeaders },
          );
        }),
      })),
    };
    const prepareRequestIds: string[] = [];
    const publicFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as { requestId: string };
      prepareRequestIds.push(body.requestId);
      if (!committed) {
        expect(sagaRow).toMatchObject({
          state: 'intent',
          transfer_id: null,
          request_id: originalRequestId,
          target_account_id: targetAccountId,
        });
      }
      if (committed && body.requestId !== originalRequestId) {
        return Response.json({ error: 'OWNER_TRANSFER_CLAIM_USED' }, { status: 409 });
      }
      prepared = true;
      return Response.json({
        ok: true,
        roomCode,
        roomGeneration,
        status: committed ? 'active' : 'suspended',
        suspensionReason: committed ? null : 'ownership_transfer_pending',
        transferId,
        commitProof: 'P'.repeat(43),
        targetAccountId,
        previousOwnerAccountId,
        claimGeneration: committed ? null : 12,
        preparedAtMs,
        expiresAtMs,
        committedAtMs: committed ? committedAtMs : null,
        replayUntilMs: committed ? replayUntilMs : expiresAtMs,
        replayed: committed,
      });
    });
    const env = {
      GOOGLE_OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
      MXQR_AUTH_SESSION_PEPPER: 'session-pepper-for-tests-at-least-32-bytes',
      MXQR_AUTH_SUBJECT_PEPPER: 'subject-pepper-for-tests-at-least-32-bytes',
      MXQR_OAUTH_STATE_SECRET: 'state-secret-for-tests-at-least-32-bytes',
      MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: 'assertion-secret-for-tests-at-least-32-bytes',
      MXQR_DEVELOPER_API_KEY_PEPPER: 'developer-pepper-for-tests-at-least-32-bytes',
      MUSIXQUARE_AUTH_DB: authDb,
      MUSIXQUARE_ADMIN_DB: adminDb,
      DEVELOPER_API_DB: developerDb,
      PRO_ROOM_ADMIN_ROOMS: adminNamespace,
      PRO_ROOM_PUBLIC_API: { fetch: publicFetch },
    };
    const transferRequest = (requestId = originalRequestId) =>
      new Request(`https://musixquare.com/api/pro-room/v1/rooms/${roomCode}/owner-transfer`, {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          Cookie: `__Host-mxqr_account=${'S'.repeat(43)}`,
        },
        body: JSON.stringify({
          claimToken: `v1.${'C'.repeat(43)}.${'D'.repeat(43)}`,
          newPin: '20020924',
          requestId,
        }),
      });

    const lost = await appWorker.fetch(transferRequest(), env);
    expect(lost.status).toBe(503);
    await expect(lost.json()).resolves.toEqual({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' });
    expect(lost.headers.get('Set-Cookie')).toBeNull();
    expect(prepared).toBe(true);
    expect(committed).toBe(false);
    expect(commitCalls).toBe(0);
    expect(reconcileCalls).toBe(0);
    expect(sagaRow).toMatchObject({ state: 'intent', transfer_id: null });
    expect(registryRow.status).toBe('suspended');
    expect(linkedAccounts.has(previousOwnerAccountId)).toBe(true);
    expect(authorityFence).toBeNull();

    vi.setSystemTime(startedAtMs + 10_000);
    const reconciliationCount = await reconcileOwnerTransferSagasForTests(
      env,
      adminDb,
      startedAtMs + 10_000,
    );
    expect(reconciliationCount).toBe(1);
    expect(committed).toBe(true);
    expect(commitCalls).toBe(0);
    expect(reconcileCalls).toBe(1);
    expect(sagaRow).toMatchObject({ state: 'complete' });
    expect(linkedAccounts.has(previousOwnerAccountId)).toBe(false);
    expect(linkedAccounts.has(targetAccountId)).toBe(true);
    expect(authorityFence).toMatchObject({ status: 'cleared' });

    const replay = await appWorker.fetch(transferRequest(), env);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({
      snapshot: { roomCode, status: 'active' },
    });
    expect(replay.headers.get('Set-Cookie')).toContain(
      `__Secure-mxqr_pro_session_${roomCode}=session-secret`,
    );
    expect(replay.headers.get('Set-Cookie')).toContain(
      `__Secure-mxqr_pro_owner_${roomCode}=owner-secret`,
    );
    expect(commitCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
    expect(linkedAccounts.has(previousOwnerAccountId)).toBe(false);
    expect(linkedAccounts.has(targetAccountId)).toBe(true);
    expect(authorityFence).toMatchObject({ status: 'cleared' });
    expect(registryAudits).toEqual(
      expect.arrayContaining([
        { action: 'owner_transfer.prepare', result: 'reconcile_required' },
        { action: 'owner_transfer.commit', result: 'success' },
      ]),
    );

    const differentRequest = await appWorker.fetch(transferRequest('request_abcdefgh'), env);
    expect(differentRequest.status).toBe(409);
    await expect(differentRequest.json()).resolves.toEqual({
      error: 'OWNER_TRANSFER_CLAIM_USED',
    });
    expect(differentRequest.headers.get('Set-Cookie')).toBeNull();
    expect(commitCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
    expect(authorityFence).toMatchObject({ status: 'cleared' });
    expect(prepareRequestIds).toEqual([originalRequestId, originalRequestId, 'request_abcdefgh']);
    const serializedBinds = JSON.stringify(adminDbBinds);
    expect(serializedBinds).not.toContain('20020924');
    expect(serializedBinds).not.toContain('P'.repeat(43));
    expect(serializedBinds).not.toContain('session-secret');
    expect(serializedBinds).not.toContain('owner-secret');
    expect(serializedBinds).not.toContain('C'.repeat(43));
  });

  it('naturally expires unopened claims and pending sagas exactly once during cron reconciliation', async () => {
    const nowMs = 300;
    const issuance = {
      room_code: '000023',
      room_generation: 9,
      claim_generation: 13,
      target_account_id: 'acct_0123456789abcdefghijkl',
      transfer_id: 'transfer_abcdefghijklmnopqrstuv',
      request_id: 'request_12345678',
      state: 'issued',
      issued_at: 100,
      expires_at: 200,
      updated_at: 100,
    };
    const saga = {
      room_code: issuance.room_code,
      room_generation: issuance.room_generation,
      claim_generation: issuance.claim_generation,
      transfer_id: issuance.transfer_id,
      request_id: issuance.request_id,
      target_account_id: issuance.target_account_id,
      previous_owner_account_id: 'acct_abcdefghijkl0123456789',
      fence_digest: 'F'.repeat(43),
      state: 'prepared',
      intent_at: 90,
      prepared_at: 100,
      expires_at: 200,
      updated_at: 100,
    };
    const audits: Array<{ action: string; result: string }> = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        const run = (...values: unknown[]) => {
          if (/^\s*INSERT INTO mxqr_pro_room_admin_audit/i.test(sql)) {
            audits.push({ action: String(values[1]), result: String(values[2]) });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE mxqr_pro_room_owner_transfer_issuances/i.test(sql)) {
            if (issuance.state !== 'issued') return { meta: { changes: 0 } };
            const nextState = /SET state = 'expired'/i.test(sql) ? 'expired' : String(values[3]);
            if (issuance.state === 'issued' && nextState === 'expired') {
              audits.push({ action: 'owner_transfer_claim.expire', result: 'expired' });
            }
            issuance.state = nextState;
            issuance.updated_at = Number(values.at(-1));
            return { meta: { changes: 1 } };
          }
          if (/UPDATE mxqr_pro_room_owner_transfer_sagas/i.test(sql)) {
            const previousState = saga.state;
            saga.state = String(values[4]);
            saga.updated_at = Number(values[5]);
            if (previousState === 'prepared' && saga.state === 'expired') {
              audits.push({ action: 'owner_transfer.prepare', result: 'expired' });
            }
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        };
        const topLevelResults = () => {
          if (/pragma table_info\(mxqr_pro_room_registry\)/i.test(sql)) {
            return [{ name: 'room_generation' }, { name: 'suspension_reason' }];
          }
          if (/pragma table_info\(mxqr_pro_room_admin_audit\)/i.test(sql)) {
            return [{ name: 'room_generation' }];
          }
          if (/FROM mxqr_pro_room_owner_transfer_sagas/i.test(sql) && /state NOT IN/i.test(sql)) {
            return ['complete', 'target_deleted', 'expired', 'superseded'].includes(saga.state)
              ? []
              : [{ ...saga }];
          }
          return [];
        };
        return {
          run: vi.fn(async () => run()),
          all: vi.fn(async () => ({ results: topLevelResults() })),
          bind: vi.fn((...values: unknown[]) => ({
            run: vi.fn(async () => run(...values)),
            first: vi.fn(async () =>
              /FROM mxqr_pro_room_owner_transfer_sagas/i.test(sql) ? { ...saga } : null,
            ),
            all: vi.fn(async () => ({
              results:
                /FROM mxqr_pro_room_owner_transfer_issuances/i.test(sql) &&
                /state = 'issued'/i.test(sql) &&
                issuance.state === 'issued' &&
                issuance.expires_at <= Number(values[0])
                  ? [{ ...issuance }]
                  : [],
            })),
          })),
        };
      }),
    };
    const env = {
      MUSIXQUARE_ADMIN_DB: db,
      PRO_ROOM_ADMIN_ROOMS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          fetch: vi.fn(async () =>
            Response.json({
              roomCode: saga.room_code,
              roomGeneration: saga.room_generation,
              provisioned: true,
              status: 'suspended',
              suspensionReason: 'ownership_transfer_pending',
              ownerTransferReconciliation: {
                phase: 'pending',
                transferId: saga.transfer_id,
                claimGeneration: saga.claim_generation,
                requestId: saga.request_id,
                targetAccountId: saga.target_account_id,
                previousOwnerAccountId: saga.previous_owner_account_id,
                preparedAtMs: saga.prepared_at,
                expiresAtMs: saga.expires_at,
                committedAtMs: null,
                replayUntilMs: saga.expires_at,
              },
            }),
          ),
        })),
      },
    };

    await expect(reconcileOwnerTransferSagasForTests(env, db, nowMs)).resolves.toBe(1);
    expect(issuance.state).toBe('expired');
    expect(saga.state).toBe('expired');
    expect(audits).toEqual([
      { action: 'owner_transfer_claim.expire', result: 'expired' },
      { action: 'owner_transfer.prepare', result: 'expired' },
    ]);
    await expect(reconcileOwnerTransferSagasForTests(env, db, nowMs + 1)).resolves.toBe(0);
    expect(audits).toHaveLength(2);
  });

  it('exposes a cookie-free same-origin health check through the service binding', async () => {
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://pro-room.internal/health');
      expect(request.method).toBe('GET');
      expect(request.headers.get('Accept')).toBe('application/json');
      expect(request.headers.get('Cookie')).toBeNull();
      expect(request.headers.get('Origin')).toBeNull();
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'musixquare-pro-room',
          workerVersionId: 'version-123',
        }),
        {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=60',
            'Set-Cookie': '__Host-must-not-escape=secret; Path=/; HttpOnly; Secure',
          },
        },
      );
    });
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/health', {
        headers: {
          Cookie: '__Host-mxqr_admin=must-not-leak',
          Origin: 'https://evil.example',
          'X-MXQR-Pro-IP-Hash': 'spoofed',
        },
      }),
      { PRO_ROOM_PUBLIC_API: { fetch: upstreamFetch } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: 'musixquare-pro-room',
      workerVersionId: 'version-123',
    });

    const rejectedMethod = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/health', { method: 'POST' }),
      {},
    );
    expect(rejectedMethod.status).toBe(405);
    expect(rejectedMethod.headers.get('Allow')).toBe('GET, HEAD');

    const rejectedQuery = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/health?cache-bust=1'),
      {},
    );
    expect(rejectedQuery.status).toBe(400);

    const headResponse = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/health', { method: 'HEAD' }),
      { PRO_ROOM_PUBLIC_API: { fetch: upstreamFetch } },
    );
    expect(headResponse.status).toBe(200);
    expect(await headResponse.text()).toBe('');
    expect(headResponse.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it('forwards the public route through the PRO Worker and scopes its cookies to one room', async () => {
    let forwarded: Request | null = null;
    const upstreamFetch = vi.fn(async (request: Request) => {
      forwarded = request;
      const headers = new Headers({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      headers.append(
        'Set-Cookie',
        '__Host-mxqr_pro_session_000001=session-token; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Strict',
      );
      headers.append(
        'Set-Cookie',
        '__Host-mxqr_pro_owner_000001=owner-token; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Strict',
      );
      return new Response(JSON.stringify({ ok: true }), { headers });
    });
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/v1/rooms/000001/sessions', {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          Cookie:
            '__Host-mxqr_admin=must-not-leak; __Secure-mxqr_pro_session_000001=facade-session; __Secure-mxqr_pro_owner_000001=facade-owner; __Secure-mxqr_pro_session_000002=other-room',
          'CF-Connecting-IP': '203.0.113.10',
          'X-MXQR-Pro-Room-Code': '000999',
          'X-MXQR-Pro-IP-Hash': 'spoofed',
        },
        body: JSON.stringify({ pin: '00000001', displayName: 'Peer 1' }),
      }),
      { PRO_ROOM_PUBLIC_API: { fetch: upstreamFetch } },
    );

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.url).toBe('https://pro-room.internal/v1/rooms/000001/sessions');
    expect(forwarded!.headers.get('Origin')).toBe('https://musixquare.com');
    expect(forwarded!.headers.get('CF-Connecting-IP')).toBe('203.0.113.10');
    expect(forwarded!.headers.get('X-MXQR-Pro-Room-Code')).toBeNull();
    expect(forwarded!.headers.get('X-MXQR-Pro-IP-Hash')).toBeNull();
    expect(forwarded!.headers.get('Cookie')).toBe(
      '__Host-mxqr_pro_session_000001=facade-session; __Host-mxqr_pro_owner_000001=facade-owner',
    );
    await expect(forwarded!.json()).resolves.toEqual({
      pin: '00000001',
      displayName: 'Peer 1',
    });

    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] })
      .getSetCookie;
    const setCookies = getSetCookie
      ? getSetCookie.call(response.headers)
      : [response.headers.get('Set-Cookie') || ''];
    expect(setCookies.join('\n')).toContain(
      '__Secure-mxqr_pro_session_000001=session-token; Path=/api/pro-room/v1/rooms/000001;',
    );
    expect(setCookies.join('\n')).toContain(
      '__Secure-mxqr_pro_owner_000001=owner-token; Path=/api/pro-room/v1/rooms/000001;',
    );
    expect(setCookies.join('\n')).not.toContain('__Host-mxqr_pro_');
  });

  it('finishes a bounded PRO mutation body before invoking the room service', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstreamFetch = vi.fn(async (request: Request) => {
      await expect(request.json()).resolves.toEqual({ pin: '12345678' });
      return Response.json({ ok: true });
    });
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        controller.enqueue(new TextEncoder().encode('{"pin":"1234'));
      },
    });
    const responsePromise = appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/v1/rooms/000001/sessions', {
        method: 'POST',
        headers: { Origin: 'https://musixquare.com', 'Content-Type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      { PRO_ROOM_PUBLIC_API: { fetch: upstreamFetch } },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(upstreamFetch).not.toHaveBeenCalled();
    controller.enqueue(new TextEncoder().encode('5678"}'));
    controller.close();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it('rejects stalled and oversized PRO bodies without entering the room service', async () => {
    vi.useFakeTimers();
    const upstreamFetch = vi.fn(async () => Response.json({ ok: true }));
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"pin":"'));
      },
    });
    const stalledPromise = appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/v1/rooms/000001/sessions', {
        method: 'POST',
        headers: { Origin: 'https://musixquare.com', 'Content-Type': 'application/json' },
        body: stalledBody,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      { PRO_ROOM_PUBLIC_API: { fetch: upstreamFetch } },
    );
    await vi.advanceTimersByTimeAsync(10_001);
    const stalled = await stalledPromise;
    expect(stalled.status).toBe(408);
    await expect(stalled.json()).resolves.toEqual({ error: 'PRO_ROOM_REQUEST_BODY_TIMEOUT' });
    expect(upstreamFetch).not.toHaveBeenCalled();

    vi.useRealTimers();
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const oversized = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/v1/rooms/000001/snapshot', {
        method: 'PUT',
        headers: { Origin: 'https://musixquare.com', 'Content-Type': 'application/json' },
        body: oversizedBody,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      { PRO_ROOM_PUBLIC_API: { fetch: upstreamFetch } },
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      error: 'PRO_ROOM_REQUEST_BODY_TOO_LARGE',
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('preserves a supplied Origin for the PRO Worker to reject and fails closed', async () => {
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get('Origin')).toBe('https://evil.example');
      return new Response(JSON.stringify({ error: 'FORBIDDEN_ORIGIN' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
    const rejected = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/v1/rooms/000001/bootstrap', {
        headers: { Origin: 'https://evil.example' },
      }),
      { PRO_ROOM_PUBLIC_API: { fetch: upstreamFetch } },
    );
    expect(rejected.status).toBe(403);

    const unavailable = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/v1/rooms/000001/bootstrap'),
      {},
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Cache-Control')).toBe('no-store');
    await expect(unavailable.json()).resolves.toEqual({ error: 'PRO_ROOM_API_UNAVAILABLE' });

    const malformed = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/internal/admin/status'),
      { PRO_ROOM_PUBLIC_API: { fetch: upstreamFetch } },
    );
    expect(malformed.status).toBe(404);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the zero-byte presence entry used by an existing session', async () => {
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST');
      expect(request.headers.get('Origin')).toBe('https://musixquare.com');
      expect(request.headers.get('Cookie')).toBe('__Host-mxqr_pro_session_000001=session-token');
      await expect(request.text()).resolves.toBe('');
      return new Response(JSON.stringify({ snapshot: { roomCode: '000001' } }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/v1/rooms/000001/presence/enter', {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          Cookie: '__Secure-mxqr_pro_session_000001=session-token',
        },
      }),
      { PRO_ROOM_PUBLIC_API: { fetch: upstreamFetch } },
    );

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('does not manufacture an Origin for mutation requests that omit it', async () => {
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST');
      expect(request.headers.get('Origin')).toBeNull();
      return new Response(JSON.stringify({ error: 'FORBIDDEN_ORIGIN' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/v1/rooms/000001/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '00000001', displayName: 'Peer 1' }),
      }),
      { PRO_ROOM_PUBLIC_API: { fetch: upstreamFetch } },
    );

    expect(response.status).toBe(403);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });
});

describe('Cloudflare app worker invite route', () => {
  function createAssetEnv() {
    return {
      ASSETS: {
        fetch: vi.fn(async (request: Request) => {
          const url = new URL(request.url);
          if (url.pathname === '/developers.html') {
            return new Response('<!doctype html><title>Developer API · MUSIXQUARE</title>', {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            });
          }
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

  it('canonicalizes every www route to the apex so host-only auth cookies and tabs share one origin', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(
      new Request('https://www.musixquare.com/000001?panel=connect#account'),
      env,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe(
      'https://musixquare.com/000001?panel=connect#account',
    );
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('combines HTTP upgrade and www canonicalization into one redirect', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(new Request('http://www.musixquare.com/123456'), env);

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://musixquare.com/123456');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('combines protocol, host, and invite-path canonicalization into one redirect', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(
      new Request('http://www.musixquare.com/123456/?panel=connect'),
      env,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://musixquare.com/123456?panel=connect');
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
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0, must-revalidate');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('keeps the direct service-worker app shell request out of browser and CDN caches', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(new Request('https://musixquare.com/index.html'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0, must-revalidate');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('serves the canonical Developer API document with static-page cache policy', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(new Request('https://musixquare.com/developers'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
    );
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(await response.text()).toContain('Developer API · MUSIXQUARE');
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
    const assetRequest = env.ASSETS.fetch.mock.calls[0]?.[0] as Request;
    expect(new URL(assetRequest.url).pathname).toBe('/developers.html');
  });

  it('redirects mixed-case Developer API document URLs to the canonical path', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(new Request('https://musixquare.com/Developers'), env);

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://musixquare.com/developers');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('serves invite pages for GET with fresh app-shell cache semantics', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(new Request('https://musixquare.com/123456'), env);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Invite-Rewrite')).toBe('123456');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0, must-revalidate');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(html).toContain('Session 123456 - MUSIXQUARE');
    expect(html).toContain('https://musixquare.com/123456');
    expect(html).toContain('/assets/main-test.js');
  });

  it('redirects trailing-slash invite URLs to the canonical room address', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/123456/?panel=connect'),
      env,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://musixquare.com/123456?panel=connect');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('serves invite pages for HEAD instead of falling through to static 404', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/123456', { method: 'HEAD' }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Invite-Rewrite')).toBe('123456');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0, must-revalidate');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('');
  });
});
