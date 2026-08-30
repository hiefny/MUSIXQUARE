import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';

import { E2E_APP_ORIGIN } from './config.ts';
import {
  waitForBootstrapCachedNavigationFallback,
  waitForBootstrapReady,
} from './helpers/bootstrap.ts';
import { getPageErrors, trackPageErrors } from './helpers/context-factory.ts';
import {
  NAVIGATION_OUTAGE_ARM_PATH,
  NAVIGATION_OUTAGE_CONTROL_HEADER,
  NAVIGATION_OUTAGE_CONTROL_VALUE,
  NAVIGATION_OUTAGE_QUERY_PARAMETER,
  NAVIGATION_OUTAGE_RELEASE_PATH,
  NAVIGATION_OUTAGE_STATUS_PATH,
  type NavigationOutageArm,
  type NavigationOutageRelease,
  type NavigationOutageStatus,
} from './helpers/navigation-outage-contract.ts';

const E2E_APP_HOST = new URL(E2E_APP_ORIGIN).host;
const WEBKIT_NAVIGATION_TIMEOUT_DIAGNOSTICS = new Set([
  JSON.stringify([
    'Fetch API cannot load http',
    `/${E2E_APP_HOST}/api/auth/session due to access control checks.`,
  ]),
  JSON.stringify([
    'Fetch API cannot load http',
    `/${E2E_APP_HOST}/designsystem/fonts/PretendardVariable.woff2 due to access control checks.`,
  ]),
]);

function pageErrorSignature(error: Error): string {
  return JSON.stringify([error.name, error.message.trim()]);
}

async function readCachedNavigationMarkers(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const markers: string[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const cachedRequest of await cache.keys()) {
        const url = new URL(cachedRequest.url);
        if (url.pathname.startsWith('/.mxqr-navigation-fallback/')) {
          markers.push(cachedRequest.url);
        }
      }
    }
    return markers;
  });
}

async function releaseWebKitNavigationOutage(
  request: APIRequestContext,
  token: string,
): Promise<void> {
  const releaseResponse = await request.post(
    `${NAVIGATION_OUTAGE_RELEASE_PATH}?token=${encodeURIComponent(token)}`,
    {
      headers: {
        [NAVIGATION_OUTAGE_CONTROL_HEADER]: NAVIGATION_OUTAGE_CONTROL_VALUE,
      },
    },
  );
  if (!releaseResponse.ok()) {
    throw new Error(`WEBKIT_OUTAGE_RELEASE_HTTP_${releaseResponse.status()}`);
  }
  const release = (await releaseResponse.json()) as NavigationOutageRelease;
  if (!release.released) throw new Error('WEBKIT_OUTAGE_RELEASE_NOT_OBSERVED');
}

async function armWebKitNavigationOutage(request: APIRequestContext, token: string): Promise<void> {
  const armResponse = await request.post(
    `${NAVIGATION_OUTAGE_ARM_PATH}?token=${encodeURIComponent(token)}`,
    {
      headers: {
        [NAVIGATION_OUTAGE_CONTROL_HEADER]: NAVIGATION_OUTAGE_CONTROL_VALUE,
      },
    },
  );
  if (!armResponse.ok()) throw new Error(`WEBKIT_OUTAGE_ARM_HTTP_${armResponse.status()}`);
  const arm = (await armResponse.json()) as NavigationOutageArm;
  if (!arm.armed) throw new Error('WEBKIT_OUTAGE_NOT_ARMED');
}

function expectNoUnexpectedPageErrors(errors: Error[], browserName: string): void {
  if (browserName !== 'webkit') {
    expect(errors).toEqual([]);
    return;
  }

  // WebKit reports these browser-authored diagnostics when aborting the one
  // deliberately stalled navigation fetch. Keep the exception local to this
  // timeout smoke, exact by origin/path/message, and bounded to one per URL.
  const signatures = errors.map(pageErrorSignature);
  expect(
    signatures.filter((signature) => !WEBKIT_NAVIGATION_TIMEOUT_DIAGNOSTICS.has(signature)),
  ).toEqual([]);
  expect(signatures.length).toBeLessThanOrEqual(WEBKIT_NAVIGATION_TIMEOUT_DIAGNOSTICS.size);
  expect(new Set(signatures).size).toBe(signatures.length);
}

test.describe('Exact production candidate', () => {
  test('has no mutable test hooks and survives a Service Worker fallback navigation', async ({
    browserName,
    context,
    page,
    request,
  }) => {
    trackPageErrors(page);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await waitForBootstrapReady(page);

    const exposedHooks = await page.evaluate(() =>
      [
        '__MUSIXQUARE_GET_STATE__',
        '__MUSIXQUARE_SET_STATE__',
        '__MUSIXQUARE_BUS__',
        '__MUSIXQUARE_GET_PLAYBACK_PROJECTION__',
      ].filter((name) => name in window),
    );
    expect(exposedHooks).toEqual([]);

    await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) throw new Error('SERVICE_WORKER_UNSUPPORTED');
      await navigator.serviceWorker.ready;
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await waitForBootstrapReady(page);
    expect(getPageErrors(page)).toEqual([]);

    let chromiumOffline = false;
    let webkitOutageToken: string | null = null;
    let releaseFailure: Error | null = null;
    try {
      if (browserName === 'webkit') {
        webkitOutageToken = randomUUID();
        await armWebKitNavigationOutage(request, webkitOutageToken);
        const outageUrl = `/?${NAVIGATION_OUTAGE_QUERY_PARAMETER}=${encodeURIComponent(webkitOutageToken)}`;
        const navigationResponse = await page.goto(outageUrl, { waitUntil: 'domcontentloaded' });
        if (!navigationResponse) throw new Error('WEBKIT_OUTAGE_NAVIGATION_RESPONSE_MISSING');
        expect(navigationResponse.status()).toBe(200);
        expect(navigationResponse.fromServiceWorker()).toBe(true);

        const statusResponse = await request.get(
          `${NAVIGATION_OUTAGE_STATUS_PATH}?token=${encodeURIComponent(webkitOutageToken)}`,
          {
            headers: {
              [NAVIGATION_OUTAGE_CONTROL_HEADER]: NAVIGATION_OUTAGE_CONTROL_VALUE,
            },
          },
        );
        expect(statusResponse.ok()).toBe(true);
        const status = (await statusResponse.json()) as NavigationOutageStatus;
        expect(status.observedToken).toBe(true);
        expect(status.uniqueTokenCount).toBe(1);
        expect(status.outageAttempts).toBe(1);
        expect(status.stalledForMs).toBeGreaterThanOrEqual(2_500);
        expect(status.activeResponseCount).toBeLessThanOrEqual(1);

        const leakedCacheKeys = await page.evaluate(async (token) => {
          const leaked: string[] = [];
          for (const cacheName of await caches.keys()) {
            const cache = await caches.open(cacheName);
            for (const cachedRequest of await cache.keys()) {
              if (cachedRequest.url.includes(token)) leaked.push(cachedRequest.url);
            }
          }
          return leaked;
        }, webkitOutageToken);
        expect(leakedCacheKeys).toEqual([]);
      } else {
        await context.setOffline(true);
        chromiumOffline = true;
        const navigationResponse = await page.reload({ waitUntil: 'domcontentloaded' });
        expect(navigationResponse).not.toBeNull();
        expect(navigationResponse?.status()).toBe(200);
        expect(navigationResponse?.fromServiceWorker()).toBe(true);
      }

      await waitForBootstrapCachedNavigationFallback(page);
      await expect(page.locator('html')).toHaveAttribute(
        'data-mxqr-navigation-source',
        'cache-fallback',
      );
      await expect
        .poll(() => readCachedNavigationMarkers(page), { timeout: 5_000 })
        .toHaveLength(1);
      await expect(page.locator('#tab-play')).toBeVisible();
      expectNoUnexpectedPageErrors(getPageErrors(page), browserName);

      const fallbackErrorSignatures = getPageErrors(page).map(pageErrorSignature);
      if (browserName === 'webkit' && webkitOutageToken) {
        await releaseWebKitNavigationOutage(request, webkitOutageToken);
        webkitOutageToken = null;
      } else if (chromiumOffline) {
        await context.setOffline(false);
        chromiumOffline = false;
      }

      const relevantRequestFailures: string[] = [];
      const trackRelevantFailure = (failedRequest: Request): void => {
        if (browserName !== 'webkit') return;
        const pathname = new URL(failedRequest.url()).pathname;
        if (
          pathname === '/api/auth/session' ||
          pathname === '/designsystem/fonts/PretendardVariable.woff2'
        ) {
          relevantRequestFailures.push(failedRequest.url());
        }
      };
      page.on('requestfailed', trackRelevantFailure);
      try {
        const authResponsePromise = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/auth/session',
        );
        const cleanNavigationResponse = await page.goto('/', { waitUntil: 'domcontentloaded' });
        if (!cleanNavigationResponse) throw new Error('CLEAN_NAVIGATION_RESPONSE_MISSING');
        expect(cleanNavigationResponse.status()).toBe(200);
        expect(cleanNavigationResponse.fromServiceWorker()).toBe(true);
        await waitForBootstrapReady(page);
        await expect(page.locator('html')).toHaveAttribute(
          'data-mxqr-navigation-source',
          'network',
        );
        const authResponse = await authResponsePromise;
        expect(new URL(authResponse.url()).origin).toBe(E2E_APP_ORIGIN);
        await page.evaluate(async () => document.fonts.ready);
        await expect(page.locator('#tab-play')).toBeVisible();
        await expect.poll(() => readCachedNavigationMarkers(page), { timeout: 5_000 }).toEqual([]);
        expect(relevantRequestFailures).toEqual([]);
        expect(getPageErrors(page).map(pageErrorSignature)).toEqual(fallbackErrorSignatures);
      } finally {
        page.off('requestfailed', trackRelevantFailure);
      }
    } finally {
      if (webkitOutageToken) {
        try {
          await releaseWebKitNavigationOutage(request, webkitOutageToken);
        } catch (error) {
          releaseFailure =
            error instanceof Error ? error : new Error('WEBKIT_OUTAGE_RELEASE_FAILED');
        }
      }
      if (chromiumOffline) await context.setOffline(false).catch(() => undefined);
    }
    if (releaseFailure) throw releaseFailure;
  });
});
