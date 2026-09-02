import { describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.ts';

const EVENT_TEMPLATE_PATH = '/events/index.html';
const CUSTOM_404_PATH = '/404.html';

function createAssetEnv() {
  return {
    ASSETS: {
      fetch: vi.fn(async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === EVENT_TEMPLATE_PATH) {
          return new Response('<!doctype html><meta name="robots" content="noindex, nofollow">', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        if (pathname === CUSTOM_404_PATH) {
          return new Response(
            '<!doctype html><h1>Invalid URL.</h1><a aria-label="Go to MUSIXQUARE"></a>',
            {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            },
          );
        }
        return new Response('not found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }),
    },
  };
}

describe('generic PRO campaign event pages', () => {
  it('keeps the published ASAMO URL mapped to the shared event template', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/events/asamo/0/'),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0, must-revalidate');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
    expect(new URL(env.ASSETS.fetch.mock.calls[0]![0].url).pathname).toBe(EVENT_TEMPLATE_PATH);
  });

  it('maps future community editions to the same template without a new static route', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/events/apple-community/12/'),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(new URL(env.ASSETS.fetch.mock.calls[0]![0].url).pathname).toBe(EVENT_TEMPLATE_PATH);
  });

  it('supports non-edition campaign slugs through the direct generic form', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/events/summer-beta/'),
      env,
    );

    expect(response.status).toBe(200);
    expect(new URL(env.ASSETS.fetch.mock.calls[0]![0].url).pathname).toBe(EVENT_TEMPLATE_PATH);
  });

  it('redirects a numeric-edition slug alias to the human-facing nested URL', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/events/ASAMO-1/?source=admin'),
      env,
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://musixquare.com/events/asamo/1/');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('preserves a hyphenated campaign namespace when canonicalizing an edition slug', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/events/apple-community-2/'),
      env,
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(
      'https://musixquare.com/events/apple-community/2/',
    );
  });

  it.each([
    '/events/bad_slug/',
    '/events/-leading/',
    '/events/trailing-/',
    '/events/community/not-a-number/',
    `/events/${'a'.repeat(65)}/`,
  ])(
    'rejects malformed campaign paths instead of falling back to the app shell: %s',
    async (path) => {
      const env = createAssetEnv();
      const response = await appWorker.fetch(
        new Request(`https://musixquare.com${path}`, {
          headers: { Accept: 'text/html' },
        }),
        env,
      );

      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0, must-revalidate');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      expect(await response.text()).toContain('Invalid URL.');
      expect(env.ASSETS.fetch).toHaveBeenCalledTimes(2);
      expect(new URL(env.ASSETS.fetch.mock.calls[0]![0].url).pathname).toBe(path);
      expect(new URL(env.ASSETS.fetch.mock.calls[1]![0].url).pathname).toBe(CUSTOM_404_PATH);
    },
  );
});
