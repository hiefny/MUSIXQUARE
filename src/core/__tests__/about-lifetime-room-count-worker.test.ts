import { afterEach, describe, expect, it, vi } from 'vitest';

import appWorker from '../../../cloudflare/app-worker.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function createAssetBinding() {
  return {
    fetch: vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/about.html');
      expect(request.headers.get('If-None-Match')).toBeNull();
      expect(request.headers.get('If-Modified-Since')).toBeNull();
      return new Response('<!doctype html><html lang="en"><body>About</body></html>', {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': '60',
          'Content-Encoding': 'gzip',
          ETag: '"static-about"',
          'Last-Modified': 'Wed, 05 Aug 2026 00:00:00 GMT',
        },
      });
    }),
  };
}

function createLifetimeMetricsDb(count: number) {
  const first = vi.fn(async () => ({ count }));
  const bind = vi.fn((event: string) => {
    expect(event).toBe('room_opened');
    return { first };
  });
  const prepare = vi.fn((query: string) => {
    expect(query).toContain('FROM mxqr_lifetime_metric_totals');
    return { bind };
  });
  return { prepare, bind, first };
}

describe('About lifetime standard-room snapshot', () => {
  it('injects a validated D1 total into HTML and reuses the daily edge snapshot', async () => {
    const asset = createAssetBinding();
    const db = createLifetimeMetricsDb(1_610);
    let stored: Response | null = null;
    const match = vi.fn(async () => stored?.clone());
    const put = vi.fn(async (_key: Request, response: Response) => {
      stored = response.clone();
    });
    vi.stubGlobal('caches', { default: { match, put } });
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => pending.push(Promise.resolve(promise))),
    };
    const env = {
      ASSETS: asset,
      MUSIXQUARE_ADMIN_DB: { prepare: db.prepare },
    };

    const firstResponse = await appWorker.fetch(
      new Request('https://musixquare.com/about', {
        headers: {
          'If-None-Match': '"static-about"',
          'If-Modified-Since': 'Wed, 05 Aug 2026 00:00:00 GMT',
        },
      }),
      env,
      ctx,
    );
    await Promise.all(pending);
    const firstHtml = await firstResponse.text();

    expect(firstResponse.status).toBe(200);
    expect(firstHtml).toContain('<html lang="en" data-mxqr-rooms-opened="1610">');
    expect(firstResponse.headers.get('Cache-Control')).toContain('s-maxage=86400');
    expect(firstResponse.headers.get('Content-Length')).toBeNull();
    expect(firstResponse.headers.get('Content-Encoding')).toBeNull();
    expect(firstResponse.headers.get('ETag')).toBeNull();
    expect(firstResponse.headers.get('Last-Modified')).toBeNull();
    expect(db.first).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(new URL((put.mock.calls[0]?.[0] as Request).url).pathname).toMatch(
      /^\/\.well-known\/mxqr-cache\/about-room-count\/\d{4}-\d{2}-\d{2}$/,
    );

    const secondResponse = await appWorker.fetch(
      new Request('https://musixquare.com/about'),
      env,
      ctx,
    );
    expect(await secondResponse.text()).toContain('data-mxqr-rooms-opened="1610"');
    expect(db.first).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledTimes(2);
  });

  it('does not read D1 or rewrite a body for HEAD', async () => {
    const asset = createAssetBinding();
    const db = createLifetimeMetricsDb(1_610);
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/about', { method: 'HEAD' }),
      {
        ASSETS: asset,
        MUSIXQUARE_ADMIN_DB: { prepare: db.prepare },
      },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
    );
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(response.headers.get('ETag')).toBeNull();
    expect(response.headers.get('Last-Modified')).toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('keeps About available and injects an empty value when the counter is unavailable', async () => {
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/about'),
      { ASSETS: createAssetBinding() },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-mxqr-rooms-opened=""');
  });
});
