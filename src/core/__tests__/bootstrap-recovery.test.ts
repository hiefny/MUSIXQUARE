import vm from 'node:vm';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

const BOOTSTRAP_ASSET = CLASSIC_RUNTIME_ASSETS.find(
  (candidate) => candidate.outputPath === 'bootstrap.js',
);
if (!BOOTSTRAP_ASSET) throw new Error('Classic bootstrap runtime is missing from the manifest.');
const BOOTSTRAP_SOURCE = (await compileClassicRuntimeAsset(resolve('.'), BOOTSTRAP_ASSET)).code;

interface ScheduledTask {
  callback: () => void;
  delay: number;
}

interface ScriptStub {
  async?: boolean;
  onerror?: (() => void) | null;
  onload?: (() => void) | null;
  removed: boolean;
  src?: string;
  remove(): void;
  setAttribute(name: string, value: string): void;
}

function bootstrapHarness(options: { readyState?: string; visibility?: string } = {}) {
  let nextTimerId = 0;
  let visibilityState = options.visibility ?? 'visible';
  let activeScript: ScriptStub | null = null;
  const appendedScripts: ScriptStub[] = [];
  const attributes = new Map<string, string>();
  const timers = new Map<number, ScheduledTask>();
  const windowListeners = new Map<string, Array<(event: unknown) => void>>();
  const documentListeners = new Map<string, Array<(event: unknown) => void>>();
  const workerListeners = new Map<string, Array<(event: unknown) => void>>();
  const postedWorkerMessages: unknown[] = [];

  function addListener(
    listeners: Map<string, Array<(event: unknown) => void>>,
    type: string,
    listener: (event: unknown) => void,
  ) {
    const current = listeners.get(type) ?? [];
    current.push(listener);
    listeners.set(type, current);
  }

  function dispatch(listeners: Map<string, Array<(event: unknown) => void>>, event: unknown) {
    const type = (event as { type?: string }).type ?? '';
    for (const listener of listeners.get(type) ?? []) listener(event);
  }

  const documentElement = {
    style: {} as Record<string, string>,
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
  };
  const documentObject = {
    documentElement,
    readyState: options.readyState ?? 'complete',
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      addListener(documentListeners, type, listener);
    },
    createElement(tagName: string): ScriptStub {
      expect(tagName).toBe('script');
      const attributes = new Map<string, string>();
      const script: ScriptStub = {
        removed: false,
        remove() {
          script.removed = true;
          if (activeScript === script) activeScript = null;
        },
        setAttribute(name: string, value: string) {
          attributes.set(name, value);
        },
      };
      return script;
    },
    head: {
      appendChild(script: ScriptStub) {
        activeScript = script;
        appendedScripts.push(script);
        return script;
      },
    },
    querySelector(selector: string) {
      return selector === 'script[data-mxqr-primary-font-runtime]' ? activeScript : null;
    },
    querySelectorAll() {
      return [];
    },
  };

  class TestCustomEvent<T> {
    constructor(
      readonly type: string,
      readonly init: { detail: T },
    ) {}

    get detail(): T {
      return this.init.detail;
    }
  }

  const location = { hash: '', pathname: '/', search: '' };
  const history = { state: null, replaceState() {} };
  const navigatorObject = {
    language: 'en',
    languages: ['en'],
    userAgent: 'test',
    serviceWorker: {
      addEventListener(type: string, listener: (event: unknown) => void) {
        addListener(workerListeners, type, listener);
      },
      controller: {
        postMessage(message: unknown) {
          postedWorkerMessages.push(message);
        },
      },
    },
  };
  const windowObject: Record<string, unknown> = {
    document: documentObject,
    history,
    location,
    matchMedia: () => ({ matches: false }),
    addEventListener(type: string, listener: (event: unknown) => void) {
      addListener(windowListeners, type, listener);
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    dispatchEvent(event: unknown) {
      dispatch(windowListeners, event);
      return true;
    },
    setTimeout(callback: () => void, delay = 0) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
  };
  windowObject.window = windowObject;

  vm.runInContext(
    BOOTSTRAP_SOURCE,
    vm.createContext({
      CustomEvent: TestCustomEvent,
      URLSearchParams,
      document: documentObject,
      history,
      localStorage: { getItem: () => null },
      location,
      navigator: navigatorObject,
      window: windowObject,
    }),
  );

  function runTimer(delay: number) {
    const entry = [...timers.entries()].find(([, task]) => task.delay === delay);
    expect(entry, `missing ${delay} ms timer`).toBeDefined();
    timers.delete(entry![0]);
    entry![1].callback();
  }

  return {
    appendedScripts,
    attributes,
    postedWorkerMessages,
    timers,
    dispatchDocument(type: string) {
      dispatch(documentListeners, { type });
    },
    dispatchWindow(type: string) {
      dispatch(windowListeners, { type });
    },
    onWindow(type: string, listener: (event: unknown) => void) {
      addListener(windowListeners, type, listener);
    },
    postWorkerMessage(data: unknown) {
      dispatch(workerListeners, { type: 'message', data });
    },
    runTimer,
    setVisibility(value: string) {
      visibilityState = value;
    },
  };
}

describe('early degraded-launch and font recovery bootstrap', () => {
  it('covers both worker-response orderings with an attribute and a page event', () => {
    const lateResponse = bootstrapHarness();
    let eventSource = '';
    lateResponse.onWindow('mxqr:navigation-source', (event) => {
      eventSource = (event as { detail: { source: string } }).detail.source;
    });
    lateResponse.postWorkerMessage({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      navigationFallback: true,
    });

    expect(lateResponse.postedWorkerMessages).toContainEqual({
      type: 'MXQR_CACHE_STATUS_PROBE',
    });
    expect(lateResponse.attributes.get('data-mxqr-navigation-source')).toBe('cache-fallback');
    expect(eventSource).toBe('cache-fallback');

    const earlyResponse = bootstrapHarness();
    earlyResponse.postWorkerMessage({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      navigationFallback: true,
    });
    // This is the synchronous dataset branch consumed when app.ts evaluates
    // after the bootstrap event has already fired.
    expect(earlyResponse.attributes.get('data-mxqr-navigation-source')).toBe('cache-fallback');
  });

  it('removes a timed-out runtime script and retries immediately on online', () => {
    const harness = bootstrapHarness();
    harness.runTimer(0);
    expect(harness.appendedScripts).toHaveLength(1);
    const firstScript = harness.appendedScripts[0];
    expect(firstScript.src).toBe('/primary-font-loader.js');

    harness.runTimer(8_000);
    expect(firstScript.removed).toBe(true);
    expect([...harness.timers.values()].map(({ delay }) => delay)).toContain(1_000);

    harness.dispatchWindow('online');
    expect(harness.appendedScripts).toHaveLength(2);
    expect([...harness.timers.values()].map(({ delay }) => delay)).not.toContain(1_000);

    harness.dispatchWindow('online');
    expect(harness.appendedScripts).toHaveLength(2);
  });

  it('pauses background retry and resumes once on visible', () => {
    const harness = bootstrapHarness();
    harness.runTimer(0);
    harness.setVisibility('hidden');
    harness.runTimer(8_000);

    expect(harness.appendedScripts).toHaveLength(1);
    expect([...harness.timers.values()].map(({ delay }) => delay)).not.toContain(1_000);

    harness.setVisibility('visible');
    harness.dispatchDocument('visibilitychange');
    harness.dispatchDocument('visibilitychange');
    expect(harness.appendedScripts).toHaveLength(2);
  });

  it('keeps lifecycle retries behind the initial load and idle boundary', () => {
    const harness = bootstrapHarness({ readyState: 'loading' });
    expect([...harness.timers.values()]).toHaveLength(0);

    harness.dispatchWindow('pageshow');
    harness.dispatchWindow('online');
    expect([...harness.timers.values()]).toHaveLength(0);

    harness.dispatchWindow('load');
    expect([...harness.timers.values()].filter(({ delay }) => delay === 0)).toHaveLength(1);
  });
});
