/**
 * Creates isolated host + guest browser contexts for E2E tests.
 * Each context gets its own page with PeerJS server injection.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { injectPeerServer } from './peer-server.ts';

export interface HostGuestPair {
  hostContext: BrowserContext;
  guestContext: BrowserContext;
  hostPage: Page;
  guestPage: Page;
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

  const [hostPage, guestPage] = await Promise.all([
    hostContext.newPage(),
    guestContext.newPage(),
  ]);

  // Inject PeerJS server config before any navigation
  await Promise.all([
    injectPeerServer(hostPage),
    injectPeerServer(guestPage),
  ]);

  return { hostContext, guestContext, hostPage, guestPage };
}

export async function cleanupContexts(pair: HostGuestPair): Promise<void> {
  await Promise.all([
    pair.hostContext.close().catch(() => {}),
    pair.guestContext.close().catch(() => {}),
  ]);
}
