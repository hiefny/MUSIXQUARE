import { describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.ts';

const PREVIEW_PATH = '/designsystem/preview/buttons-icon.html';
const DESIGN_SYSTEM_ASSET_PATH = '/designsystem/index.html';
const LOADING_PREVIEW_ASSET_PATH = '/designsystem/loading.html';

function createAssetEnv() {
  return {
    ASSETS: {
      fetch: vi.fn(async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (
          pathname !== PREVIEW_PATH &&
          pathname !== DESIGN_SYSTEM_ASSET_PATH &&
          pathname !== LOADING_PREVIEW_ASSET_PATH
        ) {
          return new Response('not found', { status: 404 });
        }
        return new Response(
          request.method === 'HEAD' ? null : '<!doctype html><title>Preview</title>',
          {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          },
        );
      }),
    },
  };
}

describe('design system preview indexing policy', () => {
  it.each(['GET', 'HEAD'] as const)('marks preview HTML as noindex for %s', async (method) => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(
      new Request(`https://musixquare.com${PREVIEW_PATH}`, { method }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
    const assetRequest = env.ASSETS.fetch.mock.calls[0]?.[0] as Request;
    expect(new URL(assetRequest.url).pathname).toBe(PREVIEW_PATH);
    expect(await response.text()).toBe(
      method === 'HEAD' ? '' : '<!doctype html><title>Preview</title>',
    );
  });

  it('keeps the public design system document indexable', async () => {
    const env = createAssetEnv();
    const response = await appWorker.fetch(new Request('https://musixquare.com/designsystem'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
    const assetRequest = env.ASSETS.fetch.mock.calls[0]?.[0] as Request;
    expect(new URL(assetRequest.url).pathname).toBe(DESIGN_SYSTEM_ASSET_PATH);
  });

  it.each(['GET', 'HEAD'] as const)(
    'serves /designsystem/loading as noindex, nofollow with strict CSP for %s',
    async (method) => {
      const env = createAssetEnv();
      const response = await appWorker.fetch(
        new Request('https://musixquare.com/designsystem/loading', { method }),
        env,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self';");
      expect(response.headers.get('Content-Security-Policy')).not.toContain('googleapis.com');
      expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
      const assetRequest = env.ASSETS.fetch.mock.calls[0]?.[0] as Request;
      expect(new URL(assetRequest.url).pathname).toBe(LOADING_PREVIEW_ASSET_PATH);
      expect(await response.text()).toBe(
        method === 'HEAD' ? '' : '<!doctype html><title>Preview</title>',
      );
    },
  );

  it.each(['/designsystem/loading/', '/designsystem/loading.html', '/DesignSystem/Loading/'])(
    'canonically redirects %s to /designsystem/loading',
    async (pathname) => {
      const env = createAssetEnv();
      const response = await appWorker.fetch(
        new Request(`https://musixquare.com${pathname}?ref=ds`),
        env,
      );

      expect(response.status).toBe(301);
      expect(response.headers.get('Location')).toBe(
        'https://musixquare.com/designsystem/loading?ref=ds',
      );
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    },
  );
});
