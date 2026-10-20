import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.ts';

function directive(response: Response, name: string): string[] {
  return (
    (response.headers.get('Content-Security-Policy') || '')
      .split(';')
      .map((value) => value.trim().split(/\s+/u))
      .find(([key]) => key === name) || []
  );
}

function assetEnvironment() {
  return {
    ASSETS: {
      fetch: vi.fn(
        async (request: Request) =>
          new Response(request.method === 'HEAD' ? null : '<html><body>Document</body></html>', {
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    },
  };
}

describe('screensaver document security boundary', () => {
  it.each(['GET', 'HEAD'])(
    'serves a same-origin-only child without location or third-party data access (%s)',
    async (method) => {
      const env = assetEnvironment();
      const response = await appWorker.fetch(
        new Request('https://musixquare.com/screensaver.html', { method }),
        env,
      );
      expect(response.status).toBe(200);
      expect(new URL(env.ASSETS.fetch.mock.calls[0]![0].url).pathname).toBe('/screensaver.html');
      expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
      expect(response.headers.get('Permissions-Policy')).toBe(
        'camera=(), microphone=(), display-capture=(), geolocation=(), payment=()',
      );
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
      expect(directive(response, 'default-src')).toEqual(['default-src', "'none'"]);
      expect(directive(response, 'script-src')).toEqual(['script-src', "'self'"]);
      expect(directive(response, 'frame-ancestors')).toEqual(['frame-ancestors', "'self'"]);
      expect(directive(response, 'frame-src')).toEqual(['frame-src', "'none'"]);
      expect(directive(response, 'connect-src')).toEqual(['connect-src', "'self'"]);
      expect(directive(response, 'style-src')).toEqual([
        'style-src',
        "'self'",
        "'unsafe-inline'",
        'https://fonts.googleapis.com',
      ]);
      expect(directive(response, 'font-src')).toEqual([
        'font-src',
        "'self'",
        'data:',
        'https://fonts.gstatic.com',
      ]);
      if (method === 'HEAD') expect(await response.text()).toBe('');
    },
  );

  it.each(['/', '/index.html', '/ko/', '/en/', '/123456'])(
    'permits the child only from an app document at %s',
    async (pathname) => {
      const response = await appWorker.fetch(
        new Request(`https://musixquare.com${pathname}`),
        assetEnvironment(),
      );
      expect(response.status).toBe(200);
      // The clock-only child needs no location, so app documents delegate none.
      expect(response.headers.get('Permissions-Policy')).toContain('geolocation=()');
      expect(directive(response, 'frame-src')).toEqual([
        'frame-src',
        "'self'",
        'https://www.youtube.com',
        'https://challenges.cloudflare.com',
      ]);
      expect(directive(response, 'frame-ancestors')).toEqual(['frame-ancestors', "'none'"]);
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(directive(response, 'connect-src')).not.toContain('https://api.open-meteo.com');
      expect(directive(response, 'script-src')).not.toContain("'unsafe-inline'");
    },
  );

  it.each([
    '/privacy',
    '/ko/about',
    '/account-complete.html',
    '/screensaver.js',
    '/api/security-config',
  ])('keeps unrelated surface restrictions at %s', async (pathname) => {
    const response = await appWorker.fetch(
      new Request(`https://musixquare.com${pathname}`),
      assetEnvironment(),
    );
    expect(response.headers.get('Permissions-Policy')).toContain('geolocation=()');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(directive(response, 'frame-src')).not.toContain("'self'");
    expect(directive(response, 'connect-src')).not.toContain('https://api.open-meteo.com');
  });

  it('keeps the child static-asset header rules aligned with the Worker', async () => {
    const source = await readFile(
      new URL('../../../cloudflare/app-static-assets/_headers', import.meta.url),
      'utf8',
    );
    const childRules = source.split(/\/screensaver\.html\r?\n/u)[1];
    if (!childRules) throw new Error('Missing screensaver static header rules.');
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/screensaver.html'),
      assetEnvironment(),
    );
    for (const line of childRules.trim().split(/\r?\n/u)) {
      const separator = line.indexOf(':');
      const name = line.slice(0, separator).trim();
      expect(response.headers.get(name), name).toBe(line.slice(separator + 1).trim());
    }
  });
});
