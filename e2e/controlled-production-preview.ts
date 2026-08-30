import { preview, type Plugin, type PreviewServer } from 'vite';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';

import { E2E_APP_HOST, E2E_APP_PORT } from './config.ts';
import {
  isNavigationOutageToken,
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

function readSingleHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

const NAVIGATION_OUTAGE_LEASE_MS = 120_000;
interface NavigationOutageState {
  activeResponses: Map<ServerResponse, number>;
  armedAt: number;
  attempts: number;
  longestStallMs: number;
  observed: boolean;
}
const navigationOutages = new Map<string, NavigationOutageState>();
const previewOrigin = `http://${E2E_APP_HOST}:${E2E_APP_PORT}`;
const previewHost = `${E2E_APP_HOST}:${E2E_APP_PORT}`;

function isAuthorizedControlRequest(request: { headers: IncomingHttpHeaders }): boolean {
  return (
    readSingleHeader(
      request.headers[NAVIGATION_OUTAGE_CONTROL_HEADER] as string | string[] | undefined,
    ) === NAVIGATION_OUTAGE_CONTROL_VALUE
  );
}

function releaseStalledNavigation(outage: NavigationOutageState): void {
  for (const stalledResponse of outage.activeResponses.keys()) {
    if (!stalledResponse.destroyed && !stalledResponse.writableEnded) {
      stalledResponse.statusCode = 503;
      stalledResponse.setHeader('Cache-Control', 'no-store');
      stalledResponse.setHeader('Content-Type', 'text/plain; charset=utf-8');
      stalledResponse.end('Controlled navigation outage');
    }
  }
  outage.activeResponses.clear();
}

function pruneExpiredNavigationOutages(now: number): void {
  for (const [token, outage] of navigationOutages) {
    if (now - outage.armedAt <= NAVIGATION_OUTAGE_LEASE_MS) continue;
    navigationOutages.delete(token);
    releaseStalledNavigation(outage);
  }
}

function navigationOutageStalledForMs(outage: NavigationOutageState, now: number): number {
  let stalledForMs = outage.longestStallMs;
  for (const startedAt of outage.activeResponses.values()) {
    stalledForMs = Math.max(stalledForMs, now - startedAt);
  }
  return stalledForMs;
}

const controlledNavigationOutage = (): Plugin => ({
  name: 'controlled-navigation-outage',
  enforce: 'pre',
  configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      const now = Date.now();
      pruneExpiredNavigationOutages(now);
      let url: URL;
      try {
        url = new URL(request.url ?? '/', previewOrigin);
      } catch {
        next();
        return;
      }

      if (readSingleHeader(request.headers.host) !== previewHost) {
        next();
        return;
      }

      if (request.method === 'POST' && url.pathname === NAVIGATION_OUTAGE_ARM_PATH) {
        const authorized = isAuthorizedControlRequest(request);
        const token = url.searchParams.get('token');
        if (!authorized || !isNavigationOutageToken(token)) {
          response.statusCode = 404;
          response.end();
          return;
        }

        const previous = navigationOutages.get(token);
        if (previous) releaseStalledNavigation(previous);
        navigationOutages.set(token, {
          activeResponses: new Map(),
          armedAt: now,
          attempts: 0,
          longestStallMs: 0,
          observed: false,
        });
        const arm: NavigationOutageArm = { armed: true };
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(arm));
        return;
      }

      if (request.method === 'GET' && url.pathname === NAVIGATION_OUTAGE_STATUS_PATH) {
        const authorized = isAuthorizedControlRequest(request);
        const token = url.searchParams.get('token');
        if (!authorized || !isNavigationOutageToken(token)) {
          response.statusCode = 404;
          response.end();
          return;
        }

        const outage = navigationOutages.get(token);
        const status: NavigationOutageStatus = {
          activeResponseCount: outage?.activeResponses.size ?? 0,
          observedToken: outage?.observed ?? false,
          outageAttempts: outage?.attempts ?? 0,
          stalledForMs: outage ? navigationOutageStalledForMs(outage, now) : 0,
          uniqueTokenCount: [...navigationOutages.values()].filter(
            (candidate) => candidate.observed,
          ).length,
        };
        // The release endpoint owns lifecycle cleanup. Keeping this evidence
        // until then makes cleanup idempotent even if WebKit closes the stalled
        // response before the test asks the harness to release it.
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(status));
        return;
      }

      if (request.method === 'POST' && url.pathname === NAVIGATION_OUTAGE_RELEASE_PATH) {
        const authorized = isAuthorizedControlRequest(request);
        const token = url.searchParams.get('token');
        if (!authorized || !isNavigationOutageToken(token)) {
          response.statusCode = 404;
          response.end();
          return;
        }

        const outage = navigationOutages.get(token);
        if (outage) releaseStalledNavigation(outage);
        const release: NavigationOutageRelease = {
          released: navigationOutages.delete(token),
        };
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(release));
        return;
      }

      const token = url.searchParams.get(NAVIGATION_OUTAGE_QUERY_PARAMETER);
      const acceptsHtml = readSingleHeader(request.headers.accept)?.includes('text/html') ?? false;
      const outage = isNavigationOutageToken(token) ? navigationOutages.get(token) : undefined;
      if (request.method === 'GET' && url.pathname === '/' && acceptsHtml && outage) {
        outage.observed = true;
        outage.attempts += 1;
        outage.activeResponses.set(response, now);
        response.once('close', () => {
          const startedAt = outage.activeResponses.get(response);
          if (startedAt !== undefined) {
            outage.longestStallMs = Math.max(outage.longestStallMs, Date.now() - startedAt);
          }
          outage.activeResponses.delete(response);
        });
        return;
      }

      next();
    });
  },
});

const previewServer: PreviewServer = await preview({
  mode: 'production',
  plugins: [controlledNavigationOutage()],
  preview: {
    host: E2E_APP_HOST,
    port: E2E_APP_PORT,
    strictPort: true,
  },
});
previewServer.printUrls();

let closing = false;
async function shutdown(exitCode: number): Promise<void> {
  if (closing) return;
  closing = true;
  // A manual shutdown has no next browser case to protect. Close any synthetic
  // outage sockets before asking Vite to drain its HTTP server.
  for (const outage of navigationOutages.values()) {
    for (const response of outage.activeResponses.keys()) response.destroy();
  }
  navigationOutages.clear();
  await previewServer.close();
  process.exit(exitCode);
}

process.once('SIGINT', () => {
  shutdown(130).catch((error: unknown) => {
    console.error('[controlled-preview] shutdown failed:', error);
    process.exit(1);
  });
});
process.once('SIGTERM', () => {
  shutdown(143).catch((error: unknown) => {
    console.error('[controlled-preview] shutdown failed:', error);
    process.exit(1);
  });
});
