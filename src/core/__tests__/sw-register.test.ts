/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const moduleMocks = vi.hoisted(() => ({
  getState: vi.fn(() => 'idle'),
  scheduleSessionReset: vi.fn(),
  showDialog: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../state.ts', () => ({ getState: moduleMocks.getState }));
vi.mock('../../i18n/index.ts', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: moduleMocks.showDialog }));
vi.mock('../../ui/toast.ts', () => ({ showToast: moduleMocks.showToast }));
vi.mock('../timers.ts', () => ({ setManagedTimer: vi.fn() }));
vi.mock('../session-reset.ts', () => ({
  scheduleSessionReset: moduleMocks.scheduleSessionReset,
}));

interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn>;
}

interface SwHarness {
  setController(worker: FakeWorker | null): void;
  emit(type: 'controllerchange' | 'message', event?: unknown): void;
  installUpdate(): {
    emitInstalled(): void;
    waitingWorker: FakeWorker;
  };
  register: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
}

function installServiceWorkerHarness(initialController: FakeWorker | null): SwHarness {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const registrationListeners = new Map<string, Array<() => void>>();
  let controller = initialController;
  const reload = vi.fn();
  const registration = {
    scope: 'https://musixquare.com/',
    installing: null as null | {
      state: ServiceWorkerState;
      addEventListener(type: string, listener: () => void): void;
    },
    waiting: null as FakeWorker | null,
    update: vi.fn(async () => undefined),
    addEventListener(type: string, listener: () => void) {
      const group = registrationListeners.get(type) || [];
      group.push(listener);
      registrationListeners.set(type, group);
    },
  };
  const register = vi.fn(async () => registration);
  const container = {
    get controller() {
      return controller;
    },
    register,
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
  vi.stubGlobal('window', {
    isSecureContext: true,
    location: {
      href: 'https://musixquare.com/',
      reload,
    },
    addEventListener: vi.fn(),
  });
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });

  return {
    setController(worker) {
      controller = worker;
    },
    emit(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
    installUpdate() {
      const workerListeners = new Map<string, Array<() => void>>();
      const waitingWorker: FakeWorker = { postMessage: vi.fn() };
      const installingWorker = {
        state: 'installing' as ServiceWorkerState,
        addEventListener(type: string, listener: () => void) {
          const group = workerListeners.get(type) || [];
          group.push(listener);
          workerListeners.set(type, group);
        },
      };
      registration.installing = installingWorker;
      registration.waiting = waitingWorker;
      for (const listener of registrationListeners.get('updatefound') || []) listener();

      return {
        emitInstalled() {
          installingWorker.state = 'installed';
          for (const listener of workerListeners.get('statechange') || []) listener();
        },
        waitingWorker,
      };
    },
    register,
    reload,
  };
}

async function registerWithHarness(harness: SwHarness): Promise<void> {
  const { registerServiceWorker } = await import('../../sw-register.ts');
  registerServiceWorker();
  await vi.waitFor(() => expect(harness.register).toHaveBeenCalledOnce());
}

describe('service-worker cache-retirement client handshake', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionStorage.clear();
    moduleMocks.getState.mockReturnValue('idle');
    moduleMocks.showDialog.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not approve a new controller before controllerchange reaches the page', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    moduleMocks.getState.mockReturnValue('host');
    await registerWithHarness(harness);

    harness.setController(newController);
    // clients.claim() may update navigator.serviceWorker.controller before the
    // page receives controllerchange. Equality with pageController must still
    // report false, keeping old hashed chunks alive through this race.
    harness.emit('message', {
      data: { type: 'MXQR_CACHE_STATUS_REQUEST', cacheVersion: 'v133' },
    });

    expect(newController.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_CLIENT_STATUS',
      cacheVersion: 'v133',
      ready: false,
      replyToRequest: true,
    });

    harness.emit('controllerchange');
    expect(newController.postMessage).toHaveBeenCalledWith({ type: 'MXQR_CACHE_STATUS_PROBE' });
  });

  it('approves a first controller claim because the uncontrolled page loaded the same build', async () => {
    const controller: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(null);
    await registerWithHarness(harness);

    harness.setController(controller);
    harness.emit('controllerchange');
    harness.emit('message', {
      data: { type: 'MXQR_CACHE_STATUS_REQUEST', cacheVersion: 'v133', proactive: true },
    });

    expect(controller.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_CLIENT_STATUS',
      cacheVersion: 'v133',
      ready: true,
      replyToRequest: false,
    });
  });

  it('probes the active worker on every natural page load to recover a restarted ready set', async () => {
    const controller: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(controller);
    await registerWithHarness(harness);

    expect(controller.postMessage).toHaveBeenCalledWith({ type: 'MXQR_CACHE_STATUS_PROBE' });
  });

  it('routes an idle controlled-tab controller change through the reset coordinator', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledWith(
      'dialog.refreshing_session',
      expect.any(Function),
    );
    const resetAction = moduleMocks.scheduleSessionReset.mock.calls[0]?.[1];
    expect(resetAction).toBeTypeOf('function');
    resetAction?.();
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it('activates an approved update and routes its reload through the reset coordinator', async () => {
    const controller: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(controller);
    moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
    await registerWithHarness(harness);

    const update = harness.installUpdate();
    update.emitInstalled();

    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
    expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledWith(
      'dialog.refreshing_session',
      expect.any(Function),
    );
    const resetAction = moduleMocks.scheduleSessionReset.mock.calls[0]?.[1];
    expect(resetAction).toBeTypeOf('function');
    resetAction?.();
    expect(harness.reload).toHaveBeenCalledOnce();
  });
});
