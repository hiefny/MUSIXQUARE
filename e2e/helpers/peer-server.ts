/**
 * Inject local PeerJS server config into the page before app JS runs.
 * Uses the existing __MUSIXQUARE_PEER_SERVER__ hook in src/network/peer.ts.
 */
import type { Page } from '@playwright/test';

const PEER_CONFIG = {
  host: 'localhost',
  port: 9000,
  path: '/',
  secure: false,
  key: 'peerjs',
};

export async function injectPeerServer(page: Page): Promise<void> {
  await page.addInitScript((config) => {
    (window as unknown as Record<string, unknown>).__MUSIXQUARE_PEER_SERVER__ = config;
  }, PEER_CONFIG);
}
