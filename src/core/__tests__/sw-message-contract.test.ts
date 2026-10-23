/**
 * The page and the service worker exchange these message types across builds
 * that cannot import each other: browser/service-worker.ts and
 * browser/classic-runtime/bootstrap.ts compile apart from src/. Each copy is
 * read from its source and compared with the page constant, or, where the page
 * keeps the type private, with the message the page actually sends.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_CLIENT_STATUS,
  CACHE_STATUS_PROBE,
  CACHE_STATUS_REQUEST,
  createServiceWorkerGenerationResolver,
} from '../../sw-update-coordination.ts';

const serviceWorkerSource = readFileSync(resolve('browser/service-worker.ts'), 'utf8');
const bootstrapSource = readFileSync(resolve('browser/classic-runtime/bootstrap.ts'), 'utf8');

/** The literal a top-level `const NAME = '…';` in browser/service-worker.ts holds. */
function serviceWorkerConstant(name: string): string {
  const match = new RegExp(`^const ${name} = '([^']+)';$`, 'mu').exec(serviceWorkerSource);
  if (!match?.[1]) throw new Error(`browser/service-worker.ts no longer declares ${name}`);
  return match[1];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('page and service-worker message types', () => {
  it('lets the worker answer the cache-status messages the page sends and reads', () => {
    expect(serviceWorkerConstant('CACHE_STATUS_REQUEST')).toBe(CACHE_STATUS_REQUEST);
    expect(serviceWorkerConstant('CACHE_CLIENT_STATUS')).toBe(CACHE_CLIENT_STATUS);
    expect(serviceWorkerConstant('CACHE_STATUS_PROBE')).toBe(CACHE_STATUS_PROBE);
  });

  it('gives the classic bootstrap the same request and probe types', () => {
    expect(bootstrapSource).toContain(`data.type !== '${CACHE_STATUS_REQUEST}'`);
    expect(bootstrapSource).toContain(`postMessage({ type: '${CACHE_STATUS_PROBE}' })`);
  });

  it('lets the worker answer the generation request the page resolver sends', async () => {
    vi.useFakeTimers();
    const resolver = createServiceWorkerGenerationResolver();
    const postMessage = vi.fn();
    const worker = { postMessage, scriptURL: '/service-worker.js' } as unknown as ServiceWorker;

    const generation = resolver.resolve(worker);
    const request = postMessage.mock.calls[0]?.[0] as { type: string; requestId: string };
    expect(request.type).toBe(serviceWorkerConstant('SW_GENERATION_REQUEST'));
    expect(
      resolver.consumeMessage({
        type: serviceWorkerConstant('SW_GENERATION_RESPONSE'),
        requestId: request.requestId,
        cacheVersion: 'v494',
      }),
    ).toBe(true);

    await expect(generation).resolves.toEqual({ cacheVersion: 'v494', promptIdentity: 'v494' });
  });

  it('activates the worker on the SKIP_WAITING type every page send posts', () => {
    // The page posts the literal at each send (sw-register.ts and
    // core/sw-hard-reset.ts; the resource-ownership guard counts the sends, and
    // sw-register.test.ts and sw-hard-reset.test.ts pin each message).
    expect(serviceWorkerSource).toContain("if (data.type === 'SKIP_WAITING') {");
    for (const path of ['src/sw-register.ts', 'src/core/sw-hard-reset.ts']) {
      const source = readFileSync(resolve(path), 'utf8');
      const posted = [...source.matchAll(/postMessage\(\{ type: '([A-Z_]+)' \}\)/gu)].map(
        (match) => match[1],
      );
      expect(posted.length, path).toBeGreaterThan(0);
      expect(new Set(posted), path).toEqual(new Set(['SKIP_WAITING']));
    }
  });
});
