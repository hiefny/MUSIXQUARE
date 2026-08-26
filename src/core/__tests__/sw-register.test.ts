/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const moduleMocks = vi.hoisted(() => ({
  getState: vi.fn(() => 'idle'),
  scheduleDocumentReload: vi.fn(),
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
  scheduleDocumentReload: moduleMocks.scheduleDocumentReload,
  scheduleSessionReset: moduleMocks.scheduleSessionReset,
}));

interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn>;
  scriptURL?: string;
  state?: ServiceWorkerState;
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
  setController(worker: FakeWorker | null, clearWaiting?: boolean, cacheVersion?: string): void;
  emit(type: 'controllerchange' | 'message', event?: unknown): void;
  installUpdate(cacheVersion?: string): {
    emitInstalled(): void;
    waitingWorker: FakeWorker;
  };
  register: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  waitingWorker: FakeWorker | null;
}

function installServiceWorkerHarness(
  initialController: FakeWorker | null,
  navigationType: NavigationTimingType = 'navigate',
  hasWaitingWorker = false,
  initialCacheGeneration = 493,
  waitingCacheGeneration = initialCacheGeneration + 1,
): SwHarness {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const registrationListeners = new Map<string, Array<() => void>>();
  let cacheGeneration = initialCacheGeneration;
  let controller = initialController;
  const initialWaitingWorker: FakeWorker | null = hasWaitingWorker
    ? { postMessage: vi.fn() }
    : null;
  const reload = vi.fn();

  const configureWorker = (
    worker: FakeWorker | null,
    cacheVersion: string,
    state: ServiceWorkerState,
  ) => {
    if (!worker) return;
    worker.scriptURL = 'https://musixquare.com/service-worker.js';
    worker.state = state;
    worker.postMessage.mockImplementation((data: unknown) => {
      if (
        data &&
        typeof data === 'object' &&
        (data as { type?: unknown }).type === 'MXQR_SW_GENERATION_REQUEST'
      ) {
        const requestId = (data as { requestId?: unknown }).requestId;
        for (const listener of listeners.get('message') || []) {
          listener({
            data: {
              type: 'MXQR_SW_GENERATION_RESPONSE',
              requestId,
              cacheVersion,
            },
            source: worker,
          });
        }
      }
    });
  };
  configureWorker(controller, `v${cacheGeneration}`, 'activated');
  configureWorker(initialWaitingWorker, `v${waitingCacheGeneration}`, 'installed');
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
    setController(worker, clearWaiting = false, exactCacheVersion) {
      cacheGeneration += 1;
      configureWorker(worker, exactCacheVersion || `v${cacheGeneration}`, 'activated');
      controller = worker;
      if (clearWaiting) registration.waiting = null;
    },
    emit(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
    installUpdate(cacheVersion = `v${cacheGeneration + 1}`) {
      const workerListeners = new Map<string, Array<() => void>>();
      const waitingWorker: FakeWorker = { postMessage: vi.fn() };
      configureWorker(waitingWorker, cacheVersion, 'installed');
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
    update: registration.update,
    waitingWorker: initialWaitingWorker,
  };
}

async function registerWithHarness(harness: SwHarness): Promise<void> {
  const { registerServiceWorker } = await import('../../sw-register.ts');
  registerServiceWorker();
  await vi.waitFor(() => expect(harness.register).toHaveBeenCalledOnce());
  expect(harness.register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' });
}

async function flushAsyncControllerChange(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('service-worker cache-retirement client handshake', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    delete document.documentElement.dataset.mxqrNavigationSource;
    moduleMocks.getState.mockReturnValue('idle');
    moduleMocks.scheduleSessionReset.mockImplementation(() => createFakeResetHandle());
    moduleMocks.scheduleDocumentReload.mockImplementation(
      (message: string, onRecovered?: () => void) => {
        const handle = moduleMocks.scheduleSessionReset(message, () => window.location.reload());
        if (!handle) {
          onRecovered?.();
          return;
        }
        handle.onRecovered(() => onRecovered?.());
      },
    );
    moduleMocks.showDialog.mockResolvedValue({ action: 'secondary' });
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
      pageCacheVersion: 'v493',
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
      pageCacheVersion: 'v133',
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
      pageCacheVersion: 'v416',
      replyToRequest: false,
    });
  });

  it('prompts for a worker that was already waiting before registration listeners attach', async () => {
    const controller: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(controller, 'navigate', true);
    await registerWithHarness(harness);

    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MXQR_SW_GENERATION_REQUEST' }),
    );
    expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalledWith({
      type: 'SKIP_WAITING',
    });
  });

  it('silently clears an impossible same-cache-generation waiting worker', async () => {
    const harness = installServiceWorkerHarness(
      { postMessage: vi.fn() },
      'navigate',
      true,
      493,
      493,
    );
    await registerWithHarness(harness);

    await vi.waitFor(() =>
      expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
    );
    expect(moduleMocks.showDialog).not.toHaveBeenCalled();
  });

  it('compares a churned waiting worker with the current controller, not the page-load controller', async () => {
    const pageLoadController: FakeWorker = { postMessage: vi.fn() };
    const currentController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(pageLoadController);
    moduleMocks.getState.mockReturnValue('host');
    await registerWithHarness(harness);

    harness.setController(currentController);
    harness.emit('controllerchange');
    await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledOnce());

    const churned = harness.installUpdate('v494');
    churned.emitInstalled();

    await vi.waitFor(() =>
      expect(churned.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
    );
    expect(moduleMocks.showDialog).not.toHaveBeenCalled();
  });

  it('drops a stale waiting-worker continuation when a newer install replaces it', async () => {
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(harness);

    const stale = harness.installUpdate('v494');
    let staleRequestId: unknown;
    stale.waitingWorker.postMessage.mockImplementation(
      (data: { type?: unknown; requestId?: unknown }) => {
        if (data.type === 'MXQR_SW_GENERATION_REQUEST') staleRequestId = data.requestId;
      },
    );
    stale.emitInstalled();
    await flushAsyncControllerChange();
    expect(staleRequestId).toBeTypeOf('string');

    const replacement = harness.installUpdate('v495');
    replacement.emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    harness.emit('message', {
      data: {
        type: 'MXQR_SW_GENERATION_RESPONSE',
        requestId: staleRequestId,
        cacheVersion: 'v494',
      },
      source: stale.waitingWorker,
    });
    await flushAsyncControllerChange();

    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    expect(stale.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('applies an open-dialog Refresh choice to the latest replacement worker', async () => {
    let resolveDialog!: (value: { action: 'ok' }) => void;
    moduleMocks.showDialog.mockReturnValue(
      new Promise((resolve) => {
        resolveDialog = resolve;
      }),
    );
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(harness);

    const stale = harness.installUpdate('v494');
    stale.emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    const replacement = harness.installUpdate('v495');
    replacement.emitInstalled();
    resolveDialog({ action: 'ok' });

    await vi.waitFor(() =>
      expect(replacement.waitingWorker.postMessage).toHaveBeenCalledWith({
        type: 'SKIP_WAITING',
      }),
    );
    expect(stale.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
  });

  it('applies an open-dialog Later choice to the latest replacement without re-prompting', async () => {
    let resolveDialog!: (value: { action: 'secondary' }) => void;
    moduleMocks.showDialog.mockReturnValue(
      new Promise((resolve) => {
        resolveDialog = resolve;
      }),
    );
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(harness);

    const stale = harness.installUpdate('v494');
    stale.emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    const replacement = harness.installUpdate('v495');
    replacement.emitInstalled();
    resolveDialog({ action: 'secondary' });
    await flushAsyncControllerChange();

    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    expect(replacement.waitingWorker.postMessage).not.toHaveBeenCalledWith({
      type: 'SKIP_WAITING',
    });

    vi.resetModules();
    const reopened = installServiceWorkerHarness(
      { postMessage: vi.fn() },
      'navigate',
      true,
      493,
      495,
    );
    await registerWithHarness(reopened);
    await flushAsyncControllerChange();
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
  });

  it('converges to one active-room toast when another client activates the prompted worker', async () => {
    let resolveDialog!: (value: { action: 'secondary' }) => void;
    moduleMocks.showDialog.mockReturnValue(
      new Promise((resolve) => {
        resolveDialog = resolve;
      }),
    );
    moduleMocks.getState.mockReturnValue('host');
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(harness);

    const update = harness.installUpdate('v494');
    update.emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    harness.setController(update.waitingWorker, true);
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    resolveDialog({ action: 'secondary' });

    await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledOnce());
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
  });

  it('still performs one bounded update check while an older worker is waiting', async () => {
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(harness);

    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledOnce());
  });

  it('does not re-prompt an explicitly dismissed waiting generation after an app reopen', async () => {
    const first = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(first);
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    vi.resetModules();
    const reopened = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(reopened);
    await flushAsyncControllerChange();

    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    expect(reopened.waitingWorker?.postMessage).not.toHaveBeenCalledWith({
      type: 'SKIP_WAITING',
    });
  });

  it('prompts immediately when a newer waiting generation replaces a dismissed one', async () => {
    const first = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(first);
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    vi.resetModules();
    const replacement = installServiceWorkerHarness(
      { postMessage: vi.fn() },
      'navigate',
      true,
      494,
    );
    await registerWithHarness(replacement);

    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledTimes(2));
  });

  it('lets only one app client present a prompt for the same waiting generation', async () => {
    let keepPromptOpen!: () => void;
    moduleMocks.showDialog.mockReturnValue(
      new Promise((resolve) => {
        keepPromptOpen = () => resolve({ action: 'secondary' });
      }),
    );
    const first = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(first);
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    vi.resetModules();
    const second = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(second);
    await flushAsyncControllerChange();

    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    keepPromptOpen();
  });

  it('briefly cools down a failed prompt presentation without hiding a newer generation', async () => {
    moduleMocks.showDialog.mockRejectedValueOnce(new Error('dialog unavailable'));
    const first = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(first);
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    vi.resetModules();
    const reopened = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(reopened);
    await flushAsyncControllerChange();
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();

    vi.resetModules();
    const replacement = installServiceWorkerHarness(
      { postMessage: vi.fn() },
      'navigate',
      true,
      494,
    );
    await registerWithHarness(replacement);
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledTimes(2));
  });

  it('deduplicates explicit boot-time update checks across app clients', async () => {
    const first = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(first);
    await vi.waitFor(() => expect(first.update).toHaveBeenCalledOnce());

    vi.resetModules();
    const second = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(second);
    await flushAsyncControllerChange();

    expect(second.update).not.toHaveBeenCalled();
  });

  it('routes an idle controlled-tab controller change through the reset coordinator', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledWith(
      'dialog.refreshing_session',
      expect.any(Function),
    );
    const resetAction = moduleMocks.scheduleSessionReset.mock.calls[0]?.[1];
    expect(resetAction).toBeTypeOf('function');
    resetAction?.();
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it('reserves an idle reset before the replacement generation replies', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    await registerWithHarness(harness);

    harness.setController(newController);
    newController.postMessage.mockImplementation(() => undefined);
    harness.emit('controllerchange');

    // This assertion is intentionally synchronous. A pre-protocol controller
    // can take 750 ms to resolve, but pagehide must see the reset coordinator
    // from the controllerchange turn itself.
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();
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
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());

    const firstHandle = moduleMocks.scheduleSessionReset.mock.results[0]?.value as FakeResetHandle;
    firstHandle.emitRecovered();
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();
    harness.setController(secondController);
    harness.emit('controllerchange');
    harness.emit('controllerchange');

    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledTimes(2));
  });

  it('reserves an unresolved successor immediately when the current reload recovers', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const firstController: FakeWorker = { postMessage: vi.fn() };
    const unresolvedSuccessor: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    await registerWithHarness(harness);

    harness.setController(firstController);
    harness.emit('controllerchange');
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();
    const firstHandle = moduleMocks.scheduleSessionReset.mock.results[0]?.value as FakeResetHandle;

    harness.setController(unresolvedSuccessor);
    unresolvedSuccessor.postMessage.mockImplementation(() => undefined);
    harness.emit('controllerchange');
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();

    firstHandle.emitRecovered();

    // The second reset is claimed inside recovery, without waiting for the
    // mixed-version successor's generation timeout.
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
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
    const firstHandle = moduleMocks.scheduleSessionReset.mock.results[0]?.value as FakeResetHandle;
    firstHandle.emitRecovered();

    harness.setController(secondController);
    harness.emit('controllerchange');
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledTimes(2));
    const secondHandle = moduleMocks.scheduleSessionReset.mock.results[1]?.value as FakeResetHandle;
    firstHandle.emitRecovered();

    harness.setController(thirdController);
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledTimes(2);

    secondHandle.emitRecovered();
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledTimes(3));
  });

  it('drops a same-generation rapid successor before a no-op reload recovers', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const staleController: FakeWorker = { postMessage: vi.fn() };
    const successorController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    await registerWithHarness(harness);

    let staleRequestId: unknown;
    harness.setController(staleController, false, 'v494');
    staleController.postMessage.mockImplementation(
      (data: { type?: unknown; requestId?: unknown }) => {
        if (data.type === 'MXQR_SW_GENERATION_REQUEST') staleRequestId = data.requestId;
      },
    );
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    expect(staleRequestId).toBeTypeOf('string');
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();

    harness.setController(successorController, false, 'v494');
    harness.emit('controllerchange');
    harness.emit('message', {
      data: {
        type: 'MXQR_SW_GENERATION_RESPONSE',
        requestId: staleRequestId,
        cacheVersion: 'v494',
      },
      source: staleController,
    });
    await vi.waitFor(() =>
      expect(successorController.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'MXQR_SW_GENERATION_REQUEST' }),
      ),
    );

    const firstHandle = moduleMocks.scheduleSessionReset.mock.results[0]?.value as FakeResetHandle;
    firstHandle.emitRecovered();
    await flushAsyncControllerChange();

    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();
  });

  it('keeps another tab update non-disruptive while this tab has an active session', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    moduleMocks.getState.mockReturnValue('host');
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledOnce());
    expect(moduleMocks.showToast).toHaveBeenCalledWith('dialog.sw_update_msg');
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it('deduplicates active-room toasts across controller wrappers for one generation', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const firstWrapper: FakeWorker = { postMessage: vi.fn() };
    const secondWrapper: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    moduleMocks.getState.mockReturnValue('host');
    await registerWithHarness(harness);

    harness.setController(firstWrapper, false, 'v494');
    harness.emit('controllerchange');
    await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledOnce());

    harness.setController(secondWrapper, false, 'v494');
    harness.emit('controllerchange');
    await flushAsyncControllerChange();

    expect(moduleMocks.showToast).toHaveBeenCalledOnce();
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
  });

  it('drops a stale generation continuation when a newer controller wins the race', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const staleController: FakeWorker = { postMessage: vi.fn() };
    const winningController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    moduleMocks.getState.mockReturnValue('host');
    await registerWithHarness(harness);

    let staleRequestId: unknown;
    harness.setController(staleController);
    staleController.postMessage.mockImplementation(
      (data: { type?: unknown; requestId?: unknown }) => {
        if (data.type === 'MXQR_SW_GENERATION_REQUEST') staleRequestId = data.requestId;
      },
    );
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    expect(staleRequestId).toBeTypeOf('string');

    harness.setController(winningController);
    harness.emit('controllerchange');
    harness.emit('message', {
      data: {
        type: 'MXQR_SW_GENERATION_RESPONSE',
        requestId: staleRequestId,
        cacheVersion: 'v494',
      },
      source: staleController,
    });

    await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledOnce());
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
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

    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
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
    await flushAsyncControllerChange();
    expect(moduleMocks.showToast).not.toHaveBeenCalled();
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();

    resolveDialog({ action: 'ok' });
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
    expect(moduleMocks.showToast).not.toHaveBeenCalled();
    expect(update.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
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

    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
    expect(moduleMocks.showToast).not.toHaveBeenCalled();
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

    await vi.waitFor(() =>
      expect(moduleMocks.showToast).toHaveBeenCalledWith('dialog.sw_update_msg'),
    );
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
  });
});
