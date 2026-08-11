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

interface FakeResetHandle {
  onRecovered(listener: () => void): () => void;
  emitRecovered(): void;
}

function createFakeResetHandle(): FakeResetHandle {
  const listeners = new Set<() => void>();
  return {
    onRecovered(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitRecovered() {
      for (const listener of [...listeners]) listener();
    },
  };
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
  waitingWorker: FakeWorker | null;
}

function installServiceWorkerHarness(
  initialController: FakeWorker | null,
  navigationType: NavigationTimingType = 'navigate',
  hasWaitingWorker = false,
): SwHarness {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const registrationListeners = new Map<string, Array<() => void>>();
  let controller = initialController;
  const initialWaitingWorker: FakeWorker | null = hasWaitingWorker
    ? { postMessage: vi.fn() }
    : null;
  const reload = vi.fn();
  const registration = {
    scope: 'https://musixquare.com/',
    installing: null as null | {
      state: ServiceWorkerState;
      addEventListener(type: string, listener: () => void): void;
    },
    waiting: initialWaitingWorker,
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
  vi.stubGlobal('performance', {
    getEntriesByType: vi.fn((type: string) =>
      type === 'navigation' ? [{ type: navigationType }] : [],
    ),
  });
  vi.stubGlobal('window', {
    isSecureContext: true,
    location: {
      href: 'https://musixquare.com/',
      reload,
    },
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
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
    waitingWorker: initialWaitingWorker,
  };
}

async function registerWithHarness(harness: SwHarness): Promise<void> {
  const { registerServiceWorker } = await import('../../sw-register.ts');
  registerServiceWorker();
  await vi.waitFor(() => expect(harness.register).toHaveBeenCalledOnce());
  expect(harness.register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' });
}

describe('service-worker cache-retirement client handshake', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionStorage.clear();
    delete document.documentElement.dataset.mxqrNavigationSource;
    moduleMocks.getState.mockReturnValue('idle');
    moduleMocks.scheduleSessionReset.mockImplementation(() => createFakeResetHandle());
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

  it('publishes a cached-navigation startup as degraded page state', async () => {
    const controller: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(controller);
    await registerWithHarness(harness);

    harness.emit('message', {
      data: {
        type: 'MXQR_CACHE_STATUS_REQUEST',
        cacheVersion: 'v416',
        proactive: true,
        navigationFallback: true,
      },
    });

    expect(document.documentElement.dataset.mxqrNavigationSource).toBe('cache-fallback');
    expect(controller.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_CLIENT_STATUS',
      cacheVersion: 'v416',
      ready: true,
      replyToRequest: false,
    });
  });

  it('prompts for a worker that was already waiting before registration listeners attach', async () => {
    const controller: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(controller, 'navigate', true);
    await registerWithHarness(harness);

    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalled();
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

  it('accepts exactly one later controllerchange after its reset attempt recovers', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const firstController: FakeWorker = { postMessage: vi.fn() };
    const secondController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    await registerWithHarness(harness);

    harness.setController(firstController);
    harness.emit('controllerchange');
    harness.emit('controllerchange');
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();

    const firstHandle = moduleMocks.scheduleSessionReset.mock.results[0]?.value as FakeResetHandle;
    firstHandle.emitRecovered();
    harness.setController(secondController);
    harness.emit('controllerchange');
    harness.emit('controllerchange');

    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale recovery release a successor reload attempt', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const firstController: FakeWorker = { postMessage: vi.fn() };
    const secondController: FakeWorker = { postMessage: vi.fn() };
    const thirdController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    await registerWithHarness(harness);

    harness.setController(firstController);
    harness.emit('controllerchange');
    const firstHandle = moduleMocks.scheduleSessionReset.mock.results[0]?.value as FakeResetHandle;
    firstHandle.emitRecovered();

    harness.setController(secondController);
    harness.emit('controllerchange');
    const secondHandle = moduleMocks.scheduleSessionReset.mock.results[1]?.value as FakeResetHandle;
    firstHandle.emitRecovered();

    harness.setController(thirdController);
    harness.emit('controllerchange');
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledTimes(2);

    secondHandle.emitRecovered();
    harness.emit('controllerchange');
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledTimes(3);
  });

  it('keeps another tab update non-disruptive while this tab has an active session', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    moduleMocks.getState.mockReturnValue('host');
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    expect(moduleMocks.showToast).toHaveBeenCalledOnce();
    expect(moduleMocks.showToast).toHaveBeenCalledWith('dialog.sw_update_msg');
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it('waits for controllerchange before reloading an approved active-session update', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    moduleMocks.getState.mockReturnValue('host');
    moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
    await registerWithHarness(harness);

    const update = harness.installUpdate();
    update.emitInstalled();

    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
    );
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    expect(moduleMocks.showToast).not.toHaveBeenCalled();

    harness.setController(newController);
    harness.emit('controllerchange');

    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();
    expect(moduleMocks.showToast).not.toHaveBeenCalled();
    expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledWith(
      'dialog.refreshing_session',
      expect.any(Function),
    );
    const resetAction = moduleMocks.scheduleSessionReset.mock.calls[0]?.[1];
    expect(resetAction).toBeTypeOf('function');
    resetAction?.();
    expect(harness.reload).toHaveBeenCalledOnce();

    // A duplicate/late lifecycle signal cannot turn the same accepted update
    // into a second update toast or reload.
    harness.emit('controllerchange');
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();
    expect(moduleMocks.showToast).not.toHaveBeenCalled();
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it('continues update activation when sessionStorage is unavailable', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => {
        throw new DOMException('denied', 'SecurityError');
      }),
      setItem: vi.fn(() => {
        throw new DOMException('denied', 'SecurityError');
      }),
      removeItem: vi.fn(() => {
        throw new DOMException('denied', 'SecurityError');
      }),
    });
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
    await registerWithHarness(harness);

    const update = harness.installUpdate();
    update.emitInstalled();
    await vi.waitFor(() =>
      expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
    );

    harness.setController(newController);
    harness.emit('controllerchange');
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();
  });

  it('honors Refresh when another tab activates the worker while the dialog is open', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    moduleMocks.getState.mockReturnValue('host');
    let resolveDialog!: (value: { action: 'ok' }) => void;
    moduleMocks.showDialog.mockReturnValue(
      new Promise((resolve) => {
        resolveDialog = resolve;
      }),
    );
    await registerWithHarness(harness);

    const update = harness.installUpdate();
    update.emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    harness.setController(newController);
    harness.emit('controllerchange');
    expect(moduleMocks.showToast).not.toHaveBeenCalled();
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();

    resolveDialog({ action: 'ok' });
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
    expect(moduleMocks.showToast).not.toHaveBeenCalled();
    expect(update.waitingWorker.postMessage).not.toHaveBeenCalled();
  });

  it('finishes a legacy pre-activation reload without showing a duplicate update toast', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController, 'reload');
    moduleMocks.getState.mockReturnValue('host');
    sessionStorage.setItem('sw-updated-at', String(Date.now()));
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    expect(moduleMocks.showToast).not.toHaveBeenCalled();
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();
    expect(Number(sessionStorage.getItem('sw-controller-confirmed-at'))).toBeGreaterThan(0);
  });

  it('does not treat a controller-confirmed reload as a legacy activation handoff', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController, 'reload');
    moduleMocks.getState.mockReturnValue('host');
    const confirmedAt = Date.now();
    sessionStorage.setItem('sw-updated-at', String(confirmedAt));
    sessionStorage.setItem('sw-controller-confirmed-at', String(confirmedAt));
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    expect(moduleMocks.showToast).toHaveBeenCalledWith('dialog.sw_update_msg');
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
  });
});
