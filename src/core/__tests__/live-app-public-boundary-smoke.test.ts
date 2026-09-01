import { describe, expect, it, vi } from 'vitest';

import {
  APP_PUBLIC_BOUNDARY_TIMEOUT_MS,
  verifyAnonymousAccountSessionBoundary,
  verifyLocalizedSeoBoundary,
  verifyProductionCapabilityBoundary,
  verifyProductionOriginBoundary,
} from '../../../scripts/live-app-public-boundary-smoke.mts';
import { LANGUAGE_OPTIONS } from '../../i18n/locales.ts';

describe('live app public boundary smoke', () => {
  it('accepts the representative localized SEO matrix only with canonical metadata and cache policy', async () => {
    const records = [
      ['/', 'en', 'MUSIXQUARE', 'https://musixquare.com/', 'no-store'],
      ['/en/', 'en', 'MUSIXQUARE', 'https://musixquare.com/', 'no-store'],
      ['/ko/', 'ko', '뮤직스퀘어 · MUSIXQUARE', 'https://musixquare.com/ko/', 'no-store'],
      ['/ja/', 'ja', 'ミュージックスクエア · MUSIXQUARE', 'https://musixquare.com/ja/', 'no-store'],
      [
        '/zh-hans/about',
        'zh-Hans',
        '关于 MUSIXQUARE',
        'https://musixquare.com/zh-hans/about',
        'public, s-maxage=86400',
      ],
      [
        '/pt-br/about',
        'pt-BR',
        'Sobre o MUSIXQUARE',
        'https://musixquare.com/pt-br/about',
        'public, s-maxage=86400',
      ],
      [
        '/th/about',
        'th',
        'เกี่ยวกับ MUSIXQUARE',
        'https://musixquare.com/th/about',
        'public, s-maxage=86400',
      ],
    ] as const;
    const read = vi.fn(async () =>
      records.map(([path, lang, title, canonical, cacheControl]) => ({
        path,
        status: 200,
        cacheControl,
        lang,
        title,
        canonical,
        description: 'Localized product description',
        openGraphUrl: canonical,
        alternateCount: LANGUAGE_OPTIONS.length + 1,
        xDefault: path.includes('/about')
          ? 'https://musixquare.com/about'
          : 'https://musixquare.com/',
      })),
    );

    await expect(verifyLocalizedSeoBoundary({ read })).resolves.toEqual({
      localizedSeoReady: true,
      pages: 7,
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it('rejects localized SEO metadata drift', async () => {
    await expect(
      verifyLocalizedSeoBoundary({
        read: async () => [
          {
            path: '/ko/',
            status: 200,
            cacheControl: 'no-store',
            lang: 'ko',
            title: 'MUSIXQUARE',
            canonical: 'https://musixquare.com/',
            description: '',
            openGraphUrl: 'https://musixquare.com/',
            alternateCount: 0,
            xDefault: '',
          },
        ],
      }),
    ).rejects.toThrow('incomplete page matrix');
  });

  it('accepts only the no-store anonymous account-session projection', async () => {
    const read = vi.fn(async () => ({
      status: 200,
      cacheControl: 'no-store, max-age=0',
      setCookie: null,
      payload: { configured: true, authenticated: false, account: null },
    }));

    await expect(verifyAnonymousAccountSessionBoundary({ read })).resolves.toEqual({
      configured: true,
      anonymousSessionRejected: true,
    });
    expect(read).toHaveBeenCalledOnce();
    expect(APP_PUBLIC_BOUNDARY_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it.each([
    {
      status: 200,
      cacheControl: 'no-store',
      setCookie: null,
      payload: { configured: true, authenticated: true, account: {} },
    },
    {
      status: 200,
      cacheControl: 'public, max-age=60',
      setCookie: null,
      payload: { configured: true, authenticated: false, account: null },
    },
    {
      status: 200,
      cacheControl: 'no-store',
      setCookie: '__Host-mxqr_account=unexpected',
      payload: { configured: true, authenticated: false, account: null },
    },
  ])('rejects a permissive or cacheable boundary %#', async (result) => {
    await expect(
      verifyAnonymousAccountSessionBoundary({ read: async () => result }),
    ).rejects.toThrow();
  });

  it('allows unrelated infrastructure cookies', async () => {
    const read = vi.fn(async () => ({
      status: 200,
      cacheControl: 'private, no-store',
      setCookie: '__cf_bm=opaque; Path=/; Secure; HttpOnly',
      payload: { configured: true, authenticated: false, account: null },
    }));

    await expect(verifyAnonymousAccountSessionBoundary({ read })).resolves.toEqual({
      configured: true,
      anonymousSessionRejected: true,
    });
  });

  it('requires production capability auth and an anonymous paid-API rejection', async () => {
    const read = vi.fn(async () => ({
      configStatus: 200,
      config: { capabilityRequired: true },
      paidStatus: 401,
      paid: { error: 'CAPABILITY_REQUIRED' },
    }));

    await expect(verifyProductionCapabilityBoundary({ read })).resolves.toEqual({
      capabilityRequired: true,
      anonymousPaidApiRejected: true,
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    {
      configStatus: 200,
      config: { capabilityRequired: false },
      paidStatus: 503,
      paid: { error: 'TURN_CONFIG_UNAVAILABLE' },
    },
    {
      configStatus: 200,
      config: { capabilityRequired: true },
      paidStatus: 200,
      paid: { turn: true },
    },
  ])('fails closed on production capability drift %#', async (result) => {
    await expect(
      verifyProductionCapabilityBoundary({ read: async () => result }),
    ).rejects.toThrow();
  });

  it.each([401, 403])(
    'requires the live App Worker to reject unrelated Toss app origins with HTTP %i',
    async (status) => {
      const read = vi.fn(async () => ({ status, allowOrigin: null }));

      await expect(verifyProductionOriginBoundary({ read })).resolves.toEqual({
        unrelatedTossOriginRejected: true,
      });
      expect(read).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { status: 200, allowOrigin: null },
    { status: 403, allowOrigin: 'https://unrelated.apps.tossmini.com' },
    { status: 403, allowOrigin: '*' },
  ])('fails closed when the live App origin boundary is permissive %#', async (result) => {
    await expect(verifyProductionOriginBoundary({ read: async () => result })).rejects.toThrow(
      'Production App still trusts an unrelated Toss app origin',
    );
  });
});
