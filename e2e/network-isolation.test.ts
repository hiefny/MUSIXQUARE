import { expect, test } from '@playwright/test';
import { E2E_APP_HOST, E2E_APP_PORT, E2E_PEER_PORT } from './config.ts';
import { cleanupContexts, createHostGuestContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';

const ALLOWED_LOCAL_PORTS = new Set([String(E2E_APP_PORT), String(E2E_PEER_PORT)]);
const OBSERVABLE_NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

function isAllowedE2eRequest(requestUrl: string): boolean {
  const url = new URL(requestUrl);
  if (!OBSERVABLE_NETWORK_PROTOCOLS.has(url.protocol)) return true;
  return url.hostname === E2E_APP_HOST && ALLOWED_LOCAL_PORTS.has(url.port);
}

test('local host and guest setup reaches only the isolated app and Peer servers', async ({
  browser,
}) => {
  const pair = await createHostGuestContexts(browser);
  const unexpectedRequests: string[] = [];

  for (const context of [pair.hostContext, pair.guestContext]) {
    context.on('request', (request) => {
      if (!isAllowedE2eRequest(request.url())) {
        unexpectedRequests.push(request.url());
      }
    });
  }
  for (const page of [pair.hostPage, pair.guestPage]) {
    page.on('websocket', (webSocket) => {
      if (!isAllowedE2eRequest(webSocket.url())) {
        unexpectedRequests.push(webSocket.url());
      }
    });
  }

  try {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    expect(unexpectedRequests).toEqual([]);
  } finally {
    await cleanupContexts(pair);
  }
});
