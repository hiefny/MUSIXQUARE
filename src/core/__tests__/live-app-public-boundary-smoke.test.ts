import { describe, expect, it, vi } from 'vitest';

import {
  verifyAppBuildFloorClientReadBoundary,
  type AppBuildFloorClientReadBoundaryRead,
} from '../../../scripts/live-app-public-boundary-smoke.mts';
import {
  APP_PUBLIC_BOUNDARY_TIMEOUT_MS,
  REJECTED_TOSS_ORIGINS,
  verifyAnonymousAccountSessionBoundary,
  verifyLocalizedSeoBoundary,
  verifyProductionCapabilityBoundary,
  verifyProductionOriginBoundary,
  verifyUnknownHtmlRouteBoundary,
} from '../../../scripts/live-app-public-boundary-smoke.mts';
import ja from '../../i18n/ja.ts';
import ko from '../../i18n/ko.ts';
import { LANGUAGE_OPTIONS } from '../../i18n/locales.ts';

describe('live app public boundary smoke', () => {
  it('accepts the representative localized SEO matrix only with canonical metadata and cache policy', async () => {
    const records = [
      ['/', 'en', 'MUSIXQUARE', 'https://musixquare.com/', 'no-store'],
      ['/en/', 'en', 'MUSIXQUARE', 'https://musixquare.com/', 'no-store'],
      ['/ko/', 'ko', ko['app.search_title'], 'https://musixquare.com/ko/', 'no-store'],
      ['/ja/', 'ja', ja['app.search_title'], 'https://musixquare.com/ja/', 'no-store'],
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

  it('requires unknown HTML GET and HEAD requests to remain true 404 responses', async () => {
    const read = vi.fn(async () => [
      {
        method: 'GET' as const,
        status: 404,
        contentType: 'text/html; charset=utf-8',
        cacheControl: 'no-store, max-age=0, must-revalidate',
        robotsTag: 'noindex, nofollow',
        body: '<h1>Invalid URL.</h1><a aria-label="Go to MUSIXQUARE"></a>',
      },
      {
        method: 'HEAD' as const,
        status: 404,
        contentType: 'text/html; charset=utf-8',
        cacheControl: 'no-store, max-age=0, must-revalidate',
        robotsTag: 'noindex, nofollow',
        body: '',
      },
    ]);

    await expect(verifyUnknownHtmlRouteBoundary({ read })).resolves.toEqual({
      unknownHtmlRoutesRejected: true,
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    {
      result: [
        {
          method: 'GET' as const,
          status: 200,
          contentType: 'text/html',
          cacheControl: 'no-store',
          robotsTag: 'noindex, nofollow',
          body: 'Invalid URL. aria-label="Go to MUSIXQUARE"',
        },
        {
          method: 'HEAD' as const,
          status: 404,
          contentType: 'text/html',
          cacheControl: 'no-store',
          robotsTag: 'noindex, nofollow',
          body: '',
        },
      ],
    },
    {
      result: [
        {
          method: 'GET' as const,
          status: 404,
          contentType: 'text/html',
          cacheControl: 'no-store',
          robotsTag: 'noindex, nofollow',
          body: 'Invalid URL. aria-label="Go to MUSIXQUARE"',
        },
      ],
    },
  ])('rejects a soft-404 or incomplete unknown HTML route matrix %#', async ({ result }) => {
    await expect(verifyUnknownHtmlRouteBoundary({ read: async () => result })).rejects.toThrow(
      'branded true 404 responses',
    );
  });

  it.each([
    { field: 'contentType', value: 'text/plain' },
    { field: 'cacheControl', value: 'public, max-age=300' },
    { field: 'robotsTag', value: '' },
    { field: 'body', value: '<h1>Not found</h1>' },
  ] as const)('rejects a branded 404 with invalid $field', async ({ field, value }) => {
    const get = {
      method: 'GET' as const,
      status: 404,
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-store',
      robotsTag: 'noindex, nofollow',
      body: '<h1>Invalid URL.</h1><a aria-label="Go to MUSIXQUARE"></a>',
      [field]: value,
    };
    const head = {
      method: 'HEAD' as const,
      status: 404,
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-store',
      robotsTag: 'noindex, nofollow',
      body: '',
    };

    await expect(verifyUnknownHtmlRouteBoundary({ read: async () => [get, head] })).rejects.toThrow(
      'branded true 404 responses',
    );
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

  it('probes the retired Apps-in-Toss origins and an unrelated Toss origin', () => {
    expect(REJECTED_TOSS_ORIGINS).toEqual([
      'https://musixquare.apps.tossmini.com',
      'https://musixquare.private-apps.tossmini.com',
      'https://unrelated.apps.tossmini.com',
    ]);
  });

  it.each([401, 403])(
    'requires the live App Worker to reject every Toss origin with HTTP %i',
    async (status) => {
      const read = vi.fn(async (_origin: string) => ({ status, allowOrigin: null }));

      await expect(verifyProductionOriginBoundary({ read })).resolves.toEqual({
        tossOriginsRejected: true,
      });
      expect(read.mock.calls.map(([origin]) => origin)).toEqual([...REJECTED_TOSS_ORIGINS]);
    },
  );

  it.each(REJECTED_TOSS_ORIGINS)(
    'fails closed when the live App Worker still reflects %s',
    async (trustedOrigin) => {
      const read = async (origin: string) => ({
        status: origin === trustedOrigin ? 401 : 403,
        allowOrigin: origin === trustedOrigin ? origin : null,
      });

      await expect(verifyProductionOriginBoundary({ read })).rejects.toThrow(
        `Production App still trusts the Toss origin ${trustedOrigin}`,
      );
    },
  );

  it.each([
    { status: 200, allowOrigin: null },
    { status: 403, allowOrigin: '*' },
  ])('fails closed when the live App origin boundary is permissive %#', async (result) => {
    await expect(verifyProductionOriginBoundary({ read: async () => result })).rejects.toThrow(
      `Production App still trusts the Toss origin ${REJECTED_TOSS_ORIGINS[0]}`,
    );
  });
});

describe('live App build floor client read boundary', () => {
  const RELEASE_BUILD = 785;
  const okRead = (overrides: Partial<AppBuildFloorClientReadBoundaryRead> = {}) => ({
    liveAppBuild: RELEASE_BUILD,
    status: 200,
    cacheControl: 'no-store',
    setCookie: null,
    body: JSON.stringify({ effectiveMinAppBuild: 785 }),
    ...overrides,
  });
  const verify = (
    read: AppBuildFloorClientReadBoundaryRead,
    log: (line: string) => void = () => undefined,
  ) =>
    verifyAppBuildFloorClientReadBoundary({
      read: async () => read,
      releaseBuild: () => RELEASE_BUILD,
      log,
    });

  it('accepts exactly {effectiveMinAppBuild} right after the release App deploy', async () => {
    await expect(verify(okRead())).resolves.toEqual({
      clientFloorRead: 'verified',
      strict: true,
      effectiveMinAppBuild: 785,
    });
    await expect(
      verify(okRead({ body: JSON.stringify({ effectiveMinAppBuild: 0 }) })),
    ).resolves.toMatchObject({ effectiveMinAppBuild: 0 });
  });

  it.each([
    ['an extra key', okRead({ body: JSON.stringify({ effectiveMinAppBuild: 785, extra: 1 }) })],
    ['a negative build', okRead({ body: JSON.stringify({ effectiveMinAppBuild: -1 }) })],
    ['a fractional build', okRead({ body: JSON.stringify({ effectiveMinAppBuild: 784.5 }) })],
    ['a string build', okRead({ body: JSON.stringify({ effectiveMinAppBuild: '785' }) })],
    ['a missing build', okRead({ body: JSON.stringify({}) })],
    ['a build above the App that answers', okRead({ body: '{"effectiveMinAppBuild":786}' })],
    ['a cacheable answer', okRead({ cacheControl: 'public, max-age=30' })],
    ['a session cookie', okRead({ setCookie: '__Host-mxqr_session=x; Path=/; Secure' })],
    ['a 404', okRead({ status: 404, body: '{"error":"NOT_FOUND"}' })],
    ['an HTML fallback', okRead({ body: '<!doctype html><title>MUSIXQUARE</title>' })],
    ['a maintenance answer', okRead({ status: 503, body: '{"error":"SERVICE_MAINTENANCE"}' })],
  ])('fails the release App smoke on %s', async (_label, read) => {
    await expect(verify(read)).rejects.toThrow('App build floor client read');
  });

  it('passes an older App without the read in a manual run and logs it', async () => {
    for (const read of [
      okRead({ liveAppBuild: 784, status: 404, body: '{"error":"NOT_FOUND"}' }),
      okRead({ liveAppBuild: 784, body: '<!doctype html>' }),
    ]) {
      const log = vi.fn();
      await expect(verify(read, log)).resolves.toEqual({
        clientFloorRead: 'absent-on-older-app',
        strict: false,
        effectiveMinAppBuild: null,
      });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('App without the client floor read'),
      );
    }
  });

  it('still requires the exact shape from any App that answers 200 JSON', async () => {
    await expect(
      verify(
        okRead({
          liveAppBuild: 784,
          body: JSON.stringify({ effectiveMinAppBuild: 784, minAppBuild: 785 }),
        }),
      ),
    ).rejects.toThrow('App build floor client read');
    await expect(
      verify(okRead({ liveAppBuild: 786, body: JSON.stringify({ effectiveMinAppBuild: 785 }) })),
    ).resolves.toEqual({ clientFloorRead: 'verified', strict: false, effectiveMinAppBuild: 785 });
  });

  it('fails when the live App build cannot be read', async () => {
    await expect(verify(okRead({ liveAppBuild: null }))).rejects.toThrow(
      'live App build is unreadable',
    );
  });
});
