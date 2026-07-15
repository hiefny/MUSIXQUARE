import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const BOOTSTRAP_SOURCE = readFileSync(resolve('public/bootstrap.js'), 'utf8');
const INDEX_SOURCE = readFileSync(resolve('index.html'), 'utf8');
const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
const HANDOFF_KEY = '__mxqrTakeProRoomFragmentClaims';
const ANALYTICS_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

interface FakeScript {
  async?: boolean;
  src?: string;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
}

function runBootstrap(
  hash: string,
  options: { paramsFail?: boolean; replaceFails?: boolean } = {},
) {
  const events: string[] = [];
  const appendedScripts: FakeScript[] = [];
  const location = { hash, pathname: '/000001', search: '?lang=ko' };
  const history = {
    state: { test: true },
    replaceState(_state: unknown, _unused: string, url: string) {
      events.push('scrub');
      if (options.replaceFails) throw new Error('history unavailable');
      expect(url).toBe('/000001?lang=ko');
      location.hash = '';
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
    const bootstrapIndex = INDEX_SOURCE.indexOf('<script src="/bootstrap.js"></script>');
    const appIndex = INDEX_SOURCE.indexOf('<script type="module" src="/src/app.ts"></script>');

    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeLessThan(appIndex);
    expect(INDEX_SOURCE).not.toContain(`src="${ANALYTICS_SRC}"`);
  });

  it('scrubs before exposing a one-use non-enumerable handoff or starting analytics', () => {
    const harness = runBootstrap(`#view=setup&pro-claim=${CLAIM}&pro-recovery=${CLAIM}`);
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
      recoveryClaim: CLAIM,
      recoveryPresent: true,
    });
    expect(harness.events).toEqual(['scrub', 'analytics']);
    expect(harness.appendedScripts).toHaveLength(1);
    expect(harness.appendedScripts[0]).toMatchObject({ async: true, src: ANALYTICS_SRC });
    expect(take()).toBeNull();
    expect(harness.appendedScripts).toHaveLength(1);
  });

  it('fails closed when a credential-bearing fragment cannot be scrubbed', () => {
    const harness = runBootstrap(`#pro-claim=${CLAIM}`, { replaceFails: true });

    expect(harness.location.hash).toBe(`#pro-claim=${CLAIM}`);
    expect(harness.appendedScripts).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(harness.windowObject, HANDOFF_KEY)).toBe(false);
  });

  it('does not start analytics for a credential-like hash when parsing is unavailable', () => {
    const harness = runBootstrap(`#pro-recovery=${CLAIM}`, { paramsFail: true });

    expect(harness.appendedScripts).toEqual([]);
    expect(harness.location.hash).toBe(`#pro-recovery=${CLAIM}`);
  });

  it('preserves Cloudflare Analytics for ordinary URLs without installing a handoff', () => {
    const harness = runBootstrap('#view=setup');

    expect(harness.events).toEqual(['analytics']);
    expect(harness.appendedScripts).toHaveLength(1);
    expect(harness.appendedScripts[0]?.attributes['data-cf-beacon']).toContain(
      '80608f4cdc3849d589d14bdcf48f19f9',
    );
    expect(Object.prototype.hasOwnProperty.call(harness.windowObject, HANDOFF_KEY)).toBe(false);
  });
});
