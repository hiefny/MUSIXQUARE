import { describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.ts';

const PREVIEW_PATH = '/designsystem/preview/buttons-icon.html';
const DESIGN_SYSTEM_ASSET_PATH = '/designsystem/index.html';

function createAssetEnv() {
  return {
    ASSETS: {
      fetch: vi.fn(async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname !== PREVIEW_PATH && pathname !== DESIGN_SYSTEM_ASSET_PATH) {
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
});
