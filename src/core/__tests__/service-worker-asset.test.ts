import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as requestHttp } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BUILD_ENTRY_ASSETS_MARKER,
  OPTIONAL_PRIMARY_FONT_ASSETS_MARKER,
  SERVICE_WORKER_CACHE_VERSION,
  SERVICE_WORKER_CACHE_VERSION_SENTINEL,
  SERVICE_WORKER_OUTPUT_PATH,
  SERVICE_WORKER_SOURCE_PATH,
  assertServiceWorkerSourceCompleteness,
  compileServiceWorkerAsset,
} from '../../../scripts/service-worker-asset.ts';
import { serviceWorkerAsset } from '../../../vite.config.ts';
import { startViteMiddlewareTestServer } from './helpers/vite-middleware-test-server.ts';

const REPO_ROOT = resolve(process.cwd());

async function startServiceWorkerDevServer(): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  return startViteMiddlewareTestServer(
    {
      appType: 'custom',
      configFile: false,
      publicDir: false,
      root: REPO_ROOT,
      plugins: [serviceWorkerAsset()],
      optimizeDeps: { include: [], noDiscovery: true },
    },
    'Service worker',
  );
}

async function requestDevServer(
  origin: string,
  pathname: string,
  method: 'GET' | 'HEAD' | 'POST',
): Promise<{
  readonly body: string;
  readonly cacheControl: string | undefined;
  readonly contentType: string | undefined;
  readonly status: number;
}> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = requestHttp(new URL(pathname, origin), { method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', rejectRequest);
      response.once('end', () => {
        const contentType = response.headers['content-type'];
        const cacheControl = response.headers['cache-control'];
        resolveRequest({
          body: Buffer.concat(chunks).toString('utf8'),
          cacheControl: Array.isArray(cacheControl) ? cacheControl.join(', ') : cacheControl,
          contentType: Array.isArray(contentType) ? contentType.join(', ') : contentType,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.once('error', rejectRequest);
    request.end();
  });
}

function sourceFixture(): string {
  return [
    `const CACHE_VERSION = '${SERVICE_WORKER_CACHE_VERSION_SENTINEL}';`,
    `const BUILD_ENTRY_ASSETS = [${BUILD_ENTRY_ASSETS_MARKER}];`,
    `const OPTIONAL_PRIMARY_FONT_ASSETS = [${OPTIONAL_PRIMARY_FONT_ASSETS_MARKER}];`,
  ].join('\n');
}

describe('strict TypeScript service-worker asset', () => {
  it('owns the source and rejects a public JS or TS compiler bypass', async () => {
    await expect(assertServiceWorkerSourceCompleteness(REPO_ROOT)).resolves.toBeUndefined();

    const fixtureRoot = await mkdtemp(join(tmpdir(), 'mxqr-service-worker-'));
    const sourcePath = resolve(fixtureRoot, SERVICE_WORKER_SOURCE_PATH);
    const publicPath = resolve(fixtureRoot, 'public');
    try {
      await mkdir(resolve(sourcePath, '..'), { recursive: true });
      await mkdir(publicPath, { recursive: true });
      await writeFile(sourcePath, sourceFixture(), 'utf8');
      await expect(assertServiceWorkerSourceCompleteness(fixtureRoot)).resolves.toBeUndefined();

      await writeFile(resolve(publicPath, SERVICE_WORKER_OUTPUT_PATH), 'self.skipWaiting();\n');
      await expect(assertServiceWorkerSourceCompleteness(fixtureRoot)).rejects.toThrow(
        'publicDir bypasses the service-worker compiler',
      );
      await rm(resolve(publicPath, SERVICE_WORKER_OUTPUT_PATH));

      await writeFile(resolve(publicPath, 'service-worker.ts'), sourceFixture(), 'utf8');
      await expect(assertServiceWorkerSourceCompleteness(fixtureRoot)).rejects.toThrow(
        'publicDir bypasses the service-worker compiler',
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('compiles one executable classic worker with injected manifests and no sourcemap', async () => {
    const compiled = await compileServiceWorkerAsset(REPO_ROOT, {
      buildEntryAssets: ['./assets/app.js', './assets/app.css'],
      optionalPrimaryFontAssets: ['./primary-font.css'],
    });

    expect(compiled.sourcePath).toBe(SERVICE_WORKER_SOURCE_PATH);
    expect(compiled.outputPath).toBe(SERVICE_WORKER_OUTPUT_PATH);
    expect(compiled.cacheVersion).toBe(SERVICE_WORKER_CACHE_VERSION);
    expect(compiled.code).toMatch(
      new RegExp(`const CACHE_VERSION = ["']${SERVICE_WORKER_CACHE_VERSION}["'];`),
    );
    expect(compiled.code).toContain('"./assets/app.js"');
    expect(compiled.code).toContain('"./assets/app.css"');
    expect(compiled.code).toContain('"./primary-font.css"');
    expect(compiled.code).not.toContain(SERVICE_WORKER_CACHE_VERSION_SENTINEL);
    expect(compiled.code).not.toContain('sourceMappingURL');
    expect(compiled.code).not.toMatch(/^\s*(?:import|export)\b/mu);
    expect(() => Function(compiled.code)).not.toThrow();
  });

  it('serves only the stable GET/HEAD dev URL as generated JavaScript', async () => {
    const server = await startServiceWorkerDevServer();
    const expected = (await compileServiceWorkerAsset(REPO_ROOT)).code;
    try {
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await requestDevServer(
          server.origin,
          `/${SERVICE_WORKER_OUTPUT_PATH}?dev=1`,
          method,
        );

        expect(response.status).toBe(200);
        expect(response.contentType).toBe('text/javascript; charset=utf-8');
        expect(response.cacheControl).toBe('no-cache');
        expect(response.body).toBe(method === 'GET' ? expected : '');
      }

      const wrongPath = await requestDevServer(
        server.origin,
        `/${SERVICE_WORKER_OUTPUT_PATH}.map`,
        'GET',
      );
      expect(wrongPath.status).toBe(404);

      const post = await requestDevServer(server.origin, `/${SERVICE_WORKER_OUTPUT_PATH}`, 'POST');
      expect(post.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
