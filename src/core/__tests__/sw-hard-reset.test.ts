// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import activatePendingServiceWorkerForHardReset from '../sw-hard-reset.ts';

function installHarness(options: { controlled?: boolean; waiting?: boolean } = {}) {
  const events = new EventTarget();
  const previousController = options.controlled === false ? null : { id: 'old' };
  let controller: object | null = previousController;
  const waitingWorker =
    options.waiting === false ? null : { state: 'installed', postMessage: vi.fn() };
  const serviceWorkers = Object.assign(events, {
    getRegistration: vi.fn().mockResolvedValue({ waiting: waitingWorker }),
  });
  Object.defineProperty(serviceWorkers, 'controller', {
    configurable: true,
    get: () => controller,
  });
  vi.stubGlobal('navigator', { serviceWorker: serviceWorkers });
  return {
    waitingWorker,
    activate() {
      controller = { id: 'new' };
      events.dispatchEvent(new Event('controllerchange'));
    },
  };
}

describe('hard-reset service-worker activation', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ['without a controller', { controlled: false }],
    ['without a waiting worker', { waiting: false }],
  ] as const)('reports no pending update %s', async (_description, options) => {
    const harness = installHarness(options);

    await expect(activatePendingServiceWorkerForHardReset()).resolves.toBeUndefined();
    if (harness.waitingWorker) expect(harness.waitingWorker.postMessage).not.toHaveBeenCalled();
  });

  it('activates an installed waiting worker and waits until it controls the page', async () => {
    const harness = installHarness();
    let settled = false;
    const activation = activatePendingServiceWorkerForHardReset().then(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
    );

    expect(settled).toBe(false);
    harness.activate();

    await expect(activation).resolves.toBeUndefined();
    expect(sessionStorage.getItem('mxqr-swu')).toBe('Update applied');
  });

  it('fails open after a bounded wait when activation stalls', async () => {
    vi.useFakeTimers();
    const harness = installHarness();
    const activation = activatePendingServiceWorkerForHardReset();
    await Promise.resolve();
    expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    await vi.runAllTimersAsync();
    await expect(activation).resolves.toBeUndefined();
    expect(sessionStorage.getItem('mxqr-swu')).toBeNull();
  });
});
