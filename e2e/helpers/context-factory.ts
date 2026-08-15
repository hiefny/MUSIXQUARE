/**
 * Creates isolated host + guest browser contexts for E2E tests.
 * Each context gets its own page with PeerJS server injection.
 * Also provides runtime error tracking for all pages.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { injectPeerServer } from './peer-server.ts';

export interface HostGuestPair {
  hostContext: BrowserContext;
  guestContext: BrowserContext;
  hostPage: Page;
  guestPage: Page;
}

const _pageErrors = new WeakMap<Page, Error[]>();
const ANONYMOUS_ACCOUNT_SESSION = JSON.stringify({
  configured: true,
  authenticated: false,
  account: null,
  statsScope: null,
});

export async function useAnonymousAccountSession(...pages: Page[]): Promise<void> {
  // The local Vite API boundary deliberately returns 503 for unmocked account
  // routes. Tests that assert signed-out UI must opt into an explicit account
  // verdict instead of accidentally exercising the service-outage fallback.
  await Promise.all(
    pages.map((page) =>
      page.route('**/api/auth/session', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: ANONYMOUS_ACCOUNT_SESSION,
        }),
      ),
    ),
  );
}

/**
 * Attach a pageerror listener to track uncaught JS errors.
 * Call this right after creating a page.
 */
export function trackPageErrors(page: Page): void {
  const errors: Error[] = [];
  _pageErrors.set(page, errors);
  page.on('pageerror', (err) => errors.push(err));
}

/**
 * Returns all uncaught JS errors collected since trackPageErrors() was called.
 * Filters out known non-critical errors (e.g., service worker issues).
 */
export function getPageErrors(page: Page): Error[] {
  const errors = _pageErrors.get(page) || [];
  return errors.filter(
    (e) =>
      !e.message.includes('service-worker') &&
      !e.message.includes('ServiceWorker') &&
      !e.message.includes('ResizeObserver'),
  );
}

export async function createHostGuestContexts(browser: Browser): Promise<HostGuestPair> {
  const [hostContext, guestContext] = await Promise.all([
    browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    }),
    browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    }),
  ]);

  const [hostPage, guestPage] = await Promise.all([hostContext.newPage(), guestContext.newPage()]);

  trackPageErrors(hostPage);
  trackPageErrors(guestPage);

  await Promise.all([injectPeerServer(hostPage), injectPeerServer(guestPage)]);

  return { hostContext, guestContext, hostPage, guestPage };
}

export async function cleanupContexts(pair: HostGuestPair): Promise<void> {
  const pageErrors = [
    ...getPageErrors(pair.hostPage).map((error) => `host: ${error.message}`),
    ...getPageErrors(pair.guestPage).map((error) => `guest: ${error.message}`),
  ];

  await Promise.all([
    pair.hostContext.close().catch(() => {}),
    pair.guestContext.close().catch(() => {}),
  ]);

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught browser errors:\n${pageErrors.join('\n')}`);
  }
}
