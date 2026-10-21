import vm from 'node:vm';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

const LOADER_ASSET = CLASSIC_RUNTIME_ASSETS.find(
  (candidate) => candidate.outputPath === 'primary-font-loader.js',
);
if (!LOADER_ASSET) throw new Error('Primary font runtime is missing from the manifest.');
const LOADER_SOURCE = (await compileClassicRuntimeAsset(resolve('.'), LOADER_ASSET)).code;

interface LinkStub {
  rel?: string;
  href?: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

/**
 * Runs the classic loader against a network where neither the stylesheet nor
 * the font download ever finishes, as on a very slow link without the PWA
 * cache. Every attempt therefore ends at its own deadline.
 */
function loaderHarness() {
  let nextTimerId = 0;
  let visibilityState = 'visible';
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const windowListeners = new Map<string, Array<() => void>>();
  const documentListeners = new Map<string, Array<() => void>>();
  let fetches = 0;

  const documentObject = {
    get visibilityState() {
      return visibilityState;
    },
    documentElement: { setAttribute() {} },
    head: {
      appendChild(link: LinkStub) {
        return link;
      },
    },
    fonts: { load: () => new Promise(() => {}), add() {} },
    querySelector: () => null,
    createElement(): LinkStub {
      return { onload: null, onerror: null, setAttribute() {}, remove() {} };
    },
    addEventListener(type: string, listener: () => void) {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
    },
  };
  const windowObject: Record<string, unknown> = {
    addEventListener(type: string, listener: () => void) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
    setTimeout(callback: () => void, delay = 0) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  };
  windowObject.window = windowObject;

  vm.runInContext(
    LOADER_SOURCE,
    vm.createContext({
      AbortController,
      document: documentObject,
      fetch(_url: string, init: { signal: AbortSignal }) {
        fetches += 1;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
      window: windowObject,
    }),
  );

  const pendingDelays = () => [...timers.values()].map(({ delay }) => delay);

  return {
    fetches: () => fetches,
    pendingDelays,
    /** Fire the only pending timer and let the attempt settle. */
    async runOnlyTimer(): Promise<number> {
      expect(timers.size, `pending timers: ${pendingDelays().join(', ')}`).toBe(1);
      const [id, task] = [...timers.entries()][0]!;
      timers.delete(id);
      task.callback();
      await new Promise((settle) => setTimeout(settle, 0));
      return task.delay;
    },
    setVisibility(value: string) {
      visibilityState = value;
      for (const listener of documentListeners.get('visibilitychange') ?? []) listener();
    },
  };
}

describe('lazy primary font runtime', () => {
  it('lengthens later attempt deadlines and backs off to a few minutes', async () => {
    const harness = loaderHarness();
    const deadlines: number[] = [];
    const retries: number[] = [];

    for (let attempt = 0; attempt < 9; attempt += 1) {
      deadlines.push(await harness.runOnlyTimer());
      retries.push(await harness.runOnlyTimer());
    }

    expect(deadlines).toEqual([
      8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
    ]);
    expect(retries).toEqual([
      1_000, 3_000, 10_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000,
    ]);
    // The first attempt goes through the stylesheet; every retry, including
    // the tenth attempt the last timer started, downloads the face itself.
    expect(harness.fetches()).toBe(9);
  });

  it('waits while hidden and retries at once when the page is shown', async () => {
    const harness = loaderHarness();
    harness.setVisibility('hidden');

    expect(await harness.runOnlyTimer()).toBe(8_000);
    expect(harness.pendingDelays()).toEqual([]);

    harness.setVisibility('visible');
    // The immediate retry is the second attempt, with its longer deadline.
    expect(harness.pendingDelays()).toEqual([16_000]);
    expect(harness.fetches()).toBe(1);
  });
});
