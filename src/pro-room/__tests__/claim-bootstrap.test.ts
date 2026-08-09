import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const BOOTSTRAP_SOURCE = readFileSync(resolve('public/bootstrap.js'), 'utf8');
const INDEX_SOURCE = readFileSync(resolve('index.html'), 'utf8');
const SERVICE_WORKER_SOURCE = readFileSync(resolve('public/service-worker.js'), 'utf8');
const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
const HANDOFF_KEY = '__mxqrTakeProRoomFragmentClaims';
const ANALYTICS_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
const CLAIM_ALIAS_CASES = [
  ['claim_token', 'activation'],
  ['claim-token', 'activation'],
  ['pro_claim', 'activation'],
  ['proclaim', 'activation'],
  ['pro_recovery', 'recovery'],
  ['prorecovery', 'recovery'],
  ['pro_transfer', 'transfer'],
  ['protransfer', 'transfer'],
] as const;

interface FakeScript {
  async?: boolean;
  crossOrigin?: string;
  integrity?: string;
  src?: string;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
}

function runBootstrap(
  hash: string,
  options: {
    hostname?: string;
    paramsFail?: boolean;
    pathname?: string;
    replaceFails?: boolean;
    search?: string;
    expectedScrubUrl?: string;
  } = {},
) {
  const events: string[] = [];
  const appendedScripts: FakeScript[] = [];
  const location = {
    hash,
    hostname: options.hostname ?? 'musixquare.com',
    pathname: options.pathname ?? '/000001',
    search: options.search ?? '?lang=ko',
  };
  const history = {
    state: { test: true },
    replaceState(_state: unknown, _unused: string, url: string) {
      events.push('scrub');
      if (options.replaceFails) throw new Error('history unavailable');
      expect(url).toBe(options.expectedScrubUrl ?? '/000001?lang=ko');
      const parsed = new URL(url, 'https://musixquare.com');
      location.search = parsed.search;
      location.hash = parsed.hash;
    },
  };
  const documentElement = {
    style: {} as Record<string, string>,
    setAttribute() {},
  };
  const document = {
    documentElement,
    head: {
      appendChild(script: FakeScript) {
        events.push('analytics');
        appendedScripts.push(script);
        return script;
      },
    },
    createElement(tagName: string): FakeScript {
      expect(tagName).toBe('script');
      return {
        attributes: {},
        setAttribute(name: string, value: string) {
          this.attributes[name] = value;
        },
      };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const windowObject: Record<string, unknown> = {
    document,
    history,
    location,
    matchMedia: () => ({ matches: false }),
  };
  windowObject.window = windowObject;

  const context = vm.createContext({
    URLSearchParams: options.paramsFail
      ? class {
          constructor() {
            throw new Error('URLSearchParams unavailable');
          }
        }
      : URLSearchParams,
    document,
    history,
    localStorage: { getItem: () => null },
    location,
    navigator: { language: 'en', languages: ['en'], userAgent: 'test' },
    window: windowObject,
  });
  vm.runInContext(BOOTSTRAP_SOURCE, context);

  return { appendedScripts, events, history, location, windowObject };
}

describe('early PRO claim bootstrap', () => {
  it('keeps the self-hosted scrubber ahead of app code and removes the static analytics tag', () => {
    const cacheVersion = SERVICE_WORKER_SOURCE.match(/const CACHE_VERSION = '(v\d+)';/)?.[1];
    const bootstrapSource = `/bootstrap.js?cache=${cacheVersion}`;
    const bootstrapIndex = INDEX_SOURCE.indexOf(`<script src="${bootstrapSource}"></script>`);
    const appIndex = INDEX_SOURCE.indexOf('<script type="module" src="/src/app.ts"></script>');

    expect(cacheVersion).toMatch(/^v\d+$/);
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeLessThan(appIndex);
    expect(SERVICE_WORKER_SOURCE).toContain(
      'const BOOTSTRAP_CACHE_KEY = `./bootstrap.js?cache=${CACHE_VERSION}`;',
    );
    expect(SERVICE_WORKER_SOURCE).toContain('BOOTSTRAP_CACHE_KEY,');
    expect(INDEX_SOURCE).not.toContain(`src="${ANALYTICS_SRC}"`);
  });

  it('scrubs before exposing a one-use non-enumerable handoff and keeps room analytics off', () => {
    const harness = runBootstrap(
      `#view=setup&pro-claim=${CLAIM}&pro-recovery=${CLAIM}&pro-transfer=${CLAIM}`,
    );
    const descriptor = Object.getOwnPropertyDescriptor(harness.windowObject, HANDOFF_KEY);

    expect(harness.location.hash).toBe('');
    expect(harness.events).toEqual(['scrub']);
    expect(harness.appendedScripts).toEqual([]);
    expect(descriptor).toMatchObject({ configurable: false, enumerable: false, writable: false });
    expect(typeof descriptor?.value).toBe('function');
    expect(Object.keys(harness.windowObject)).not.toContain(HANDOFF_KEY);
    expect(
      Object.values(harness.windowObject).some(
        (value) => typeof value === 'string' && value.includes(CLAIM),
      ),
    ).toBe(false);

    const take = descriptor?.value as () => unknown;
    expect(take()).toEqual({
      activationClaim: CLAIM,
      activationPresent: true,
      recoveryClaim: CLAIM,
      recoveryPresent: true,
      transferClaim: CLAIM,
      transferPresent: true,
    });
    expect(harness.events).toEqual(['scrub']);
    expect(harness.appendedScripts).toHaveLength(0);
    expect(take()).toBeNull();
    expect(harness.appendedScripts).toHaveLength(0);
  });

  it('fails closed when a credential-bearing fragment cannot be scrubbed', () => {
    const harness = runBootstrap(`#pro-claim=${CLAIM}`, { replaceFails: true });

    expect(harness.location.hash).toBe(`#pro-claim=${CLAIM}`);
    expect(harness.appendedScripts).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(harness.windowObject, HANDOFF_KEY)).toBe(false);
  });

  it('does not start analytics for a credential-like hash when parsing is unavailable', () => {
    const harness = runBootstrap(`#pro-transfer=${CLAIM}`, { paramsFail: true });

    expect(harness.appendedScripts).toEqual([]);
    expect(harness.location.hash).toBe(`#pro-transfer=${CLAIM}`);
  });

  it('rejects and scrubs query-string claims before analytics while preserving safe URL state', () => {
    const harness = runBootstrap('#view=setup', {
      search: `?lang=ko&pro-transfer=${CLAIM}`,
      expectedScrubUrl: '/000001?lang=ko#view=setup',
    });
    const descriptor = Object.getOwnPropertyDescriptor(harness.windowObject, HANDOFF_KEY);

    expect(harness.location.search).toBe('?lang=ko');
    expect(harness.location.hash).toBe('#view=setup');
    expect(harness.events).toEqual(['scrub']);
    expect(harness.appendedScripts).toEqual([]);
    expect(typeof descriptor?.value).toBe('function');

    const take = descriptor?.value as () => unknown;
    expect(take()).toEqual({
      activationClaim: null,
      activationPresent: false,
      recoveryClaim: null,
      recoveryPresent: false,
      transferClaim: null,
      transferPresent: true,
    });
    expect(harness.events).toEqual(['scrub']);
    expect(harness.appendedScripts).toEqual([]);
  });

  it('invalidates a fragment claim when any query credential contaminates the URL', () => {
    const harness = runBootstrap(`#pro-transfer=${CLAIM}`, {
      search: `?PRO-CLAIM=${CLAIM}&lang=ko`,
      expectedScrubUrl: '/000001?lang=ko',
    });
    const take = Object.getOwnPropertyDescriptor(harness.windowObject, HANDOFF_KEY)
      ?.value as () => Record<string, unknown> | null;

    expect(harness.location.search).toBe('?lang=ko');
    expect(harness.location.hash).toBe('');
    expect(take()).toEqual({
      activationClaim: null,
      activationPresent: true,
      recoveryClaim: null,
      recoveryPresent: false,
      transferClaim: null,
      transferPresent: true,
    });
    expect(
      Object.values(harness.windowObject).some(
        (value) => typeof value === 'string' && value.includes(CLAIM),
      ),
    ).toBe(false);
  });

  it('keeps analytics and handoff disabled when a query credential cannot be scrubbed', () => {
    const harness = runBootstrap('', {
      search: `?pro-recovery=${CLAIM}`,
      replaceFails: true,
    });

    expect(harness.location.search).toContain(CLAIM);
    expect(harness.appendedScripts).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(harness.windowObject, HANDOFF_KEY)).toBe(false);
  });

  it.each(CLAIM_ALIAS_CASES)(
    'scrubs fragment claim alias %s without accepting its value',
    (alias, purpose) => {
      const harness = runBootstrap(`#view=setup&${alias}=${CLAIM}`, {
        pathname: '/about',
        search: '',
        expectedScrubUrl: '/about',
      });
      const take = Object.getOwnPropertyDescriptor(harness.windowObject, HANDOFF_KEY)
        ?.value as () => Record<string, unknown> | null;
      const handoff = take();

      expect(harness.location.hash).toBe('');
      expect(handoff).toMatchObject({
        [`${purpose}Claim`]: null,
        [`${purpose}Present`]: true,
      });
      expect(harness.events).toEqual(['scrub']);
      expect(JSON.stringify(handoff)).not.toContain(CLAIM);
      expect(take()).toBeNull();
    },
  );

  it.each(CLAIM_ALIAS_CASES)(
    'scrubs query claim alias %s and never enables analytics for that navigation',
    (alias, purpose) => {
      const harness = runBootstrap('#view=setup', {
        pathname: '/about',
        search: `?lang=ko&${alias}=${CLAIM}`,
        expectedScrubUrl: '/about?lang=ko#view=setup',
      });
      const take = Object.getOwnPropertyDescriptor(harness.windowObject, HANDOFF_KEY)
        ?.value as () => Record<string, unknown> | null;

      expect(harness.location.search).toBe('?lang=ko');
      expect(harness.location.hash).toBe('#view=setup');
      expect(take()).toMatchObject({
        [`${purpose}Claim`]: null,
        [`${purpose}Present`]: true,
      });
      expect(harness.events).toEqual(['scrub']);
      expect(harness.appendedScripts).toEqual([]);
    },
  );

  it.each(['musixquare.com', 'listen.musixquare.com'])(
    'keeps the main SPA analytics-free on production host %s',
    (hostname) => {
      const harness = runBootstrap('#view=setup', {
        hostname,
        pathname: '/about',
        search: '',
      });

      expect(harness.events).toEqual([]);
      expect(harness.appendedScripts).toEqual([]);
      expect(Object.prototype.hasOwnProperty.call(harness.windowObject, HANDOFF_KEY)).toBe(false);
    },
  );

  it.each(['/000001', '/000001/'])(
    'keeps Cloudflare Analytics disabled on six-digit room path %s',
    (pathname) => {
      const harness = runBootstrap('', { pathname, search: '' });

      expect(harness.events).toEqual([]);
      expect(harness.appendedScripts).toEqual([]);
    },
  );

  it.each(['?lang=ko', '?safe=1', '?'])('fails closed for nonempty query %s', (search) => {
    const harness = runBootstrap('', { pathname: '/about', search });

    expect(harness.events).toEqual([]);
    expect(harness.appendedScripts).toEqual([]);
  });

  it.each(['localhost', '127.0.0.1', '[::1]', '::1', 'preview.example.com', ''])(
    'keeps Cloudflare Analytics disabled outside production on host %s',
    (hostname) => {
      const harness = runBootstrap('#view=setup', { hostname, pathname: '/about', search: '' });

      expect(harness.events).toEqual([]);
      expect(harness.appendedScripts).toEqual([]);
      expect(Object.prototype.hasOwnProperty.call(harness.windowObject, HANDOFF_KEY)).toBe(false);
    },
  );
});
