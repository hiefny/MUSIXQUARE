/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const integrationMocks = vi.hoisted(() => ({
  clearIntentionalNav: vi.fn(),
  getState: vi.fn(() => 'idle'),
  markIntentionalNav: vi.fn(),
  showDialog: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../log.ts', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('../page-lifecycle.ts', () => ({
  clearIntentionalNav: integrationMocks.clearIntentionalNav,
  markIntentionalNav: integrationMocks.markIntentionalNav,
}));
vi.mock('../state.ts', () => ({ getState: integrationMocks.getState }));
vi.mock('../../i18n/index.ts', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: integrationMocks.showDialog }));
vi.mock('../../ui/toast.ts', () => ({ showToast: integrationMocks.showToast }));
vi.mock('../timers.ts', () => ({ setManagedTimer: vi.fn() }));

interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn>;
}

// These integration workers intentionally model the pre-generation-protocol
// controller that a mixed-version upgrade can leave behind. The reset/pagehide
// contract must not wait for its 750 ms identity fallback.

interface IntegrationHarness {
  emitControllerChange(): void;
  reload: ReturnType<typeof vi.fn>;
  setController(controller: FakeWorker): void;
}

const actualWindow = globalThis.window;
const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
  actualWindow,
  'requestAnimationFrame',
);
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const originalReadyState = Object.getOwnPropertyDescriptor(document, 'readyState');

function installIntegrationHarness(
  initialController: FakeWorker,
  reload: ReturnType<typeof vi.fn> = vi.fn(),
): IntegrationHarness {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  let controller = initialController;
  const registration = {
    scope: 'https://musixquare.com/',
    installing: null,
    waiting: null,
    update: vi.fn(async () => undefined),
    addEventListener: vi.fn(),
  };
  const container = {
    get controller() {
      return controller;
    },
    register: vi.fn(async () => registration),
    addEventListener(type: string, listener: (event: unknown) => void) {
      const group = listeners.get(type) || [];
      group.push(listener);
      listeners.set(type, group);
    },
  };

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: container,
  });
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    value: 'complete',
  });
  Object.defineProperty(actualWindow, 'requestAnimationFrame', {
    configurable: true,
    value: undefined,
  });

  const locationProxy = new Proxy(
    { reload },
    {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        return Reflect.get(actualWindow.location, property, actualWindow.location);
      },
    },
  );
  const windowProxy = new Proxy({} as Window, {
    get(_target, property) {
      if (property === 'isSecureContext') return true;
      if (property === 'location') return locationProxy;
      if (property === 'setTimeout') return globalThis.setTimeout;
      if (property === 'clearTimeout') return globalThis.clearTimeout;
      const value = Reflect.get(actualWindow, property, actualWindow) as unknown;
      return typeof value === 'function' ? value.bind(actualWindow) : value;
    },
  });
  vi.stubGlobal('window', windowProxy);

  return {
    emitControllerChange() {
      for (const listener of listeners.get('controllerchange') || []) listener({});
    },
    reload,
    setController(nextController) {
      controller = nextController;
    },
  };
}

async function registerAndLoadCoordinator(): Promise<typeof import('../session-reset.ts')> {
  const [{ registerServiceWorker }, coordinator] = await Promise.all([
    import('../../sw-register.ts'),
    import('../session-reset.ts'),
  ]);
  registerServiceWorker();
  await vi.waitFor(() => expect(navigator.serviceWorker.register).toHaveBeenCalledOnce());
  return coordinator;
}

describe('service-worker reset recovery integration', () => {
  let coordinator: typeof import('../session-reset.ts') | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    coordinator = null;
    localStorage.clear();
    document.documentElement.className = '';
    document.body.innerHTML = '<main id="app"></main>';
    integrationMocks.getState.mockReturnValue('idle');
    integrationMocks.showDialog.mockResolvedValue(undefined);
  });

  afterEach(() => {
    coordinator?.__resetSessionResetForTests();
    vi.unstubAllGlobals();
    if (originalRequestAnimationFrame) {
      Object.defineProperty(actualWindow, 'requestAnimationFrame', originalRequestAnimationFrame);
    } else {
      Reflect.deleteProperty(actualWindow, 'requestAnimationFrame');
    }
    if (originalServiceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
    } else {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
    if (originalReadyState) {
      Object.defineProperty(document, 'readyState', originalReadyState);
    }
    vi.useRealTimers();
  });

  it('recovers a no-op reload and accepts exactly one later controllerchange', async () => {
    const harness = installIntegrationHarness({ postMessage: vi.fn() });
    coordinator = await registerAndLoadCoordinator();

    harness.setController({ postMessage: vi.fn() });
    harness.emitControllerChange();
    expect(coordinator.isSessionResetPending()).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(120);
    expect(integrationMocks.markIntentionalNav).toHaveBeenCalledOnce();
    expect(harness.reload).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(2_000);
    expect(coordinator.isSessionResetPending()).toBe(false);

    harness.setController({ postMessage: vi.fn() });
    harness.emitControllerChange();
    harness.emitControllerChange();
    vi.advanceTimersByTime(120);

    expect(harness.reload).toHaveBeenCalledTimes(2);
    expect(integrationMocks.markIntentionalNav).toHaveBeenCalledTimes(2);
  });

  it('recovers a throwing reload and accepts exactly one later controllerchange', async () => {
    const reload = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('reload failed');
      })
      .mockImplementation(() => undefined);
    const harness = installIntegrationHarness({ postMessage: vi.fn() }, reload);
    coordinator = await registerAndLoadCoordinator();

    harness.setController({ postMessage: vi.fn() });
    harness.emitControllerChange();
    expect(() => vi.advanceTimersByTime(120)).not.toThrow();
    expect(coordinator.isSessionResetPending()).toBe(false);

    harness.setController({ postMessage: vi.fn() });
    harness.emitControllerChange();
    harness.emitControllerChange();
    vi.advanceTimersByTime(120);

    expect(reload).toHaveBeenCalledTimes(2);
    expect(integrationMocks.markIntentionalNav).toHaveBeenCalledTimes(2);
  });

  it('keeps a pagehide-committed reload latched against later controllerchange', async () => {
    const harness = installIntegrationHarness({ postMessage: vi.fn() });
    coordinator = await registerAndLoadCoordinator();

    harness.setController({ postMessage: vi.fn() });
    harness.emitControllerChange();
    vi.advanceTimersByTime(120);
    actualWindow.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(10_000);

    harness.setController({ postMessage: vi.fn() });
    harness.emitControllerChange();
    vi.advanceTimersByTime(120);

    expect(coordinator.isSessionResetPending()).toBe(true);
    expect(harness.reload).toHaveBeenCalledOnce();
    expect(integrationMocks.clearIntentionalNav).not.toHaveBeenCalled();
  });

  it('releases a committed reload only after the old document returns', async () => {
    const harness = installIntegrationHarness({ postMessage: vi.fn() });
    coordinator = await registerAndLoadCoordinator();

    harness.setController({ postMessage: vi.fn() });
    harness.emitControllerChange();
    vi.advanceTimersByTime(120);
    actualWindow.dispatchEvent(new Event('pagehide'));
    actualWindow.dispatchEvent(new Event('pageshow'));
    expect(coordinator.isSessionResetPending()).toBe(false);

    harness.setController({ postMessage: vi.fn() });
    harness.emitControllerChange();
    harness.emitControllerChange();
    vi.advanceTimersByTime(120);

    expect(harness.reload).toHaveBeenCalledTimes(2);
  });

  it('cancels a pre-action committed reset before accepting one successor', async () => {
    const harness = installIntegrationHarness({ postMessage: vi.fn() });
    coordinator = await registerAndLoadCoordinator();

    harness.setController({ postMessage: vi.fn() });
    harness.emitControllerChange();
    actualWindow.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(1_000);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(coordinator.isSessionResetPending()).toBe(true);

    actualWindow.dispatchEvent(new Event('pageshow'));
    vi.advanceTimersByTime(1_000);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(coordinator.isSessionResetPending()).toBe(false);

    harness.setController({ postMessage: vi.fn() });
    harness.emitControllerChange();
    harness.emitControllerChange();
    vi.advanceTimersByTime(120);

    expect(harness.reload).toHaveBeenCalledOnce();
  });
});
