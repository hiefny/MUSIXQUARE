import { describe, expect, it, vi } from 'vitest';
import {
  isLoopbackBrowserHref,
  isLoopbackHostname,
  localFirstApiEndpoints,
  localProductionApiFallbackEnabled,
} from '../api-endpoints.ts';

describe('local-first API endpoints', () => {
  it('enables local production fallback only for the validated true string', () => {
    expect(localProductionApiFallbackEnabled(undefined)).toBe(false);
    expect(localProductionApiFallbackEnabled(false)).toBe(false);
    expect(localProductionApiFallbackEnabled('')).toBe(false);
    expect(localProductionApiFallbackEnabled('1')).toBe(false);
    expect(localProductionApiFallbackEnabled('false')).toBe(false);
    expect(localProductionApiFallbackEnabled(' TRUE ')).toBe(true);
  });

  it('fails closed to the local origin in E2E builds', () => {
    expect(
      localFirstApiEndpoints('/api/get-turn-config', 'e2e', 'http://localhost:4183/', 'true'),
    ).toEqual(['/api/get-turn-config']);
  });

  it('retains the canonical production fallback outside E2E builds', () => {
    expect(localFirstApiEndpoints('/api/get-turn-config', 'production')).toEqual([
      '/api/get-turn-config',
      'https://musixquare.com/api/get-turn-config',
    ]);
  });

  it('does not retry the same Worker route twice on the canonical production origin', () => {
    expect(
      localFirstApiEndpoints(
        '/api/cloudflare-realtime',
        'production',
        'https://musixquare.com/room/123456',
      ),
    ).toEqual(['/api/cloudflare-realtime']);
  });

  it('keeps the production fallback on public staging origins', () => {
    expect(
      localFirstApiEndpoints(
        '/api/cloudflare-realtime',
        'production',
        'https://preview.musixquare.com/room/123456',
      ),
    ).toEqual(['/api/cloudflare-realtime', 'https://musixquare.com/api/cloudflare-realtime']);
  });

  it.each([
    'http://localhost:3000/',
    'http://localhost.:3000/',
    'http://app.localhost:3000/',
    'http://nested.app.localhost.:3000/',
    'http://127.0.0.1:3000/',
    'http://127.0.0.2:3000/',
    'http://[::1]:3000/',
    'http://[::ffff:127.0.0.1]:3000/',
  ])('recognizes and isolates the loopback browser origin %s', (baseHref) => {
    expect(isLoopbackBrowserHref(baseHref)).toBe(true);
    expect(
      localFirstApiEndpoints('/api/cloudflare-realtime', 'development', baseHref, 'false'),
    ).toEqual(['/api/cloudflare-realtime']);
  });

  it.each([
    'localhost',
    'localhost.',
    'app.localhost',
    'nested.app.localhost.',
    '127.0.0.1',
    '127.0.0.2',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '[::ffff:7f00:1]',
  ])('recognizes the loopback hostname %s', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  it.each(['localhost.example.com', '128.0.0.1', '::2', '::ffff:8000:1', ''])(
    'rejects the public or malformed hostname %s',
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(false);
    },
  );

  it('restores the canonical retry on loopback only after explicit opt-in', () => {
    expect(
      localFirstApiEndpoints(
        '/api/get-turn-config',
        'development',
        'http://127.0.0.1:3000/',
        ' TRUE ',
      ),
    ).toEqual(['/api/get-turn-config', 'https://musixquare.com/api/get-turn-config']);
  });

  it.each(['/api/get-turn-config', '/api/cloudflare-realtime'] as const)(
    'never lets a default loopback consumer fetch production for %s',
    async (path) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 503 }));

      for (const endpoint of localFirstApiEndpoints(
        path,
        'development',
        'http://localhost:3000/',
        'false',
      )) {
        await fetchMock(endpoint);
      }

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(path);
      expect(
        fetchMock.mock.calls.every(
          ([input]) => !String(input).startsWith('https://musixquare.com'),
        ),
      ).toBe(true);
    },
  );
});
