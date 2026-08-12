/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { YouTubePlayerInstance } from '../_state.ts';
import { createLazyYouTubeLandscapeSizeReconciler } from '../ios-landscape-size-reconcile-lazy.ts';
import type {
  YouTubeLandscapeSizeReconciler,
  YouTubeLandscapeSizeReconcilerDependencies,
} from '../ios-landscape-size-reconcile.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(ios = true) {
  const load = vi.fn<() => Promise<typeof import('../ios-landscape-size-reconcile.ts')>>();
  const reconciler: YouTubeLandscapeSizeReconciler = {
    start: vi.fn(),
    refresh: vi.fn(),
    refreshAfterFirstMediaState: vi.fn(),
    stop: vi.fn(),
  };
  const create = vi.fn(() => reconciler);
  const reconcilerDependencies = {} as YouTubeLandscapeSizeReconcilerDependencies;
  const lazy = createLazyYouTubeLandscapeSizeReconciler({
    isIOS: () => ios,
    load,
    reconcilerDependencies,
  });
  const module = {
    createYouTubeLandscapeSizeReconciler: create,
  } as unknown as typeof import('../ios-landscape-size-reconcile.ts');
  const container = document.createElement('div');
  const first = {} as YouTubePlayerInstance;
  const second = {} as YouTubePlayerInstance;
  return { load, reconciler, create, lazy, module, container, first, second };
}

async function flushImport(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('lazy iOS landscape YouTube reconciler', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('does not load the iOS-only chunk on other platforms', () => {
    const harness = createHarness(false);

    harness.lazy.start(harness.first, 1, harness.container);

    expect(harness.load).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
  });

  it('uses one cached import and activates only the latest pending player/session', async () => {
    const harness = createHarness();
    const loading = deferred<typeof harness.module>();
    harness.load.mockReturnValue(loading.promise);

    harness.lazy.start(harness.first, 1, harness.container);
    harness.lazy.start(harness.second, 2, harness.container);
    loading.resolve(harness.module);
    await flushImport();

    expect(harness.load).toHaveBeenCalledOnce();
    expect(harness.create).toHaveBeenCalledOnce();
    expect(harness.reconciler.start).toHaveBeenCalledOnce();
    expect(harness.reconciler.start).toHaveBeenCalledWith(harness.second, 2, harness.container);
  });

  it('does not start a stale owner when stop wins the pending-import race', async () => {
    const harness = createHarness();
    const loading = deferred<typeof harness.module>();
    harness.load.mockReturnValue(loading.promise);

    harness.lazy.start(harness.first, 1, harness.container);
    harness.lazy.stop();
    loading.resolve(harness.module);
    await flushImport();

    expect(harness.load).toHaveBeenCalledOnce();
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.reconciler.start).not.toHaveBeenCalled();

    harness.lazy.start(harness.second, 2, harness.container);
    expect(harness.load).toHaveBeenCalledOnce();
    expect(harness.reconciler.start).toHaveBeenCalledWith(harness.second, 2, harness.container);
  });

  it('replays a matching first-media signal after the pending import starts', async () => {
    const harness = createHarness();
    const loading = deferred<typeof harness.module>();
    harness.load.mockReturnValue(loading.promise);

    harness.lazy.start(harness.first, 8, harness.container);
    harness.lazy.refresh();
    harness.lazy.refreshAfterFirstMediaState(harness.first, 8);
    harness.lazy.refreshAfterFirstMediaState(harness.second, 8);
    loading.resolve(harness.module);
    await flushImport();

    expect(harness.reconciler.start).toHaveBeenCalledOnce();
    expect(harness.reconciler.refreshAfterFirstMediaState).toHaveBeenCalledOnce();
    expect(harness.reconciler.refreshAfterFirstMediaState).toHaveBeenCalledWith(harness.first, 8);
    expect(harness.reconciler.refresh).not.toHaveBeenCalled();
  });

  it('contains a chunk-load rejection and does not retry the same URL', async () => {
    const harness = createHarness();
    harness.load.mockRejectedValue(new Error('offline'));

    harness.lazy.start(harness.first, 1, harness.container);
    await flushImport();
    harness.lazy.start(harness.second, 2, harness.container);
    await flushImport();

    expect(harness.load).toHaveBeenCalledOnce();
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.reconciler.start).not.toHaveBeenCalled();
  });
});
