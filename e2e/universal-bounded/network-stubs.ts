import type { BrowserContext, Route } from '@playwright/test';

const UNIVERSAL_E2E_ORIGIN = 'http://127.0.0.1:4174';

const SECURITY_CONFIG = Object.freeze({
  capabilityRequired: false,
  turnstileSiteKey: '',
  turnstileRequired: false,
  proofOfWorkRequired: false,
  proofOfWorkDifficulty: 0,
  proofOfWorkTtl: 0,
  ttl: 600,
});

const TURN_CONFIG = Object.freeze({
  iceServers: Object.freeze([]),
  provider: 'universal-e2e-local',
});

const ANNOUNCEMENT = Object.freeze({
  enabled: false,
  id: '',
  message: '',
});

function isMusixquareHost(hostname: string): boolean {
  return hostname === 'musixquare.com' || hostname.endsWith('.musixquare.com');
}

async function fulfillJson(route: Route, payload: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    headers: {
      'access-control-allow-origin': UNIVERSAL_E2E_ORIGIN,
      'access-control-allow-credentials': 'true',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Keeps the candidate lane hermetic while retaining real local PeerJS and
 * WebRTC traffic. Product API probes receive fixed body-free responses; any
 * other request or WebSocket to a Musixquare production host is blocked.
 */
export async function installUniversalNetworkStubs(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isProductApiHost = url.origin === UNIVERSAL_E2E_ORIGIN || isMusixquareHost(url.hostname);

    if (request.method() === 'OPTIONS' && isMusixquareHost(url.hostname)) {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': UNIVERSAL_E2E_ORIGIN,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET,HEAD,OPTIONS',
          'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '',
          'cache-control': 'no-store',
        },
      });
      return;
    }

    if (isProductApiHost && url.pathname === '/api/security-config') {
      await fulfillJson(route, SECURITY_CONFIG);
      return;
    }
    if (isProductApiHost && url.pathname === '/api/get-turn-config') {
      await fulfillJson(route, TURN_CONFIG);
      return;
    }
    if (isProductApiHost && url.pathname === '/api/announcement/current') {
      await fulfillJson(route, ANNOUNCEMENT);
      return;
    }

    if (url.hostname === 'cloudflareinsights.com') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': UNIVERSAL_E2E_ORIGIN,
          'cache-control': 'no-store',
        },
      });
      return;
    }

    if (isMusixquareHost(url.hostname)) {
      await route.abort('blockedbyclient');
      return;
    }
    if (url.origin === UNIVERSAL_E2E_ORIGIN && url.pathname.startsWith('/api/')) {
      await fulfillJson(route, { error: 'UNIVERSAL_E2E_UNSTUBBED_API' }, 404);
      return;
    }

    await route.continue();
  });

  await context.routeWebSocket(
    /^wss:\/\/(?:[^/]+\.)?musixquare\.com(?::\d+)?\//u,
    async (webSocket) => {
      await webSocket.close({ code: 1008, reason: 'Universal E2E blocks production signaling' });
    },
  );
}
