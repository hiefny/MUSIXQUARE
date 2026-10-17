/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const moduleMocks = vi.hoisted(() => ({
  getState: vi.fn((_key?: string): unknown => undefined),
  roomLifecycleListeners: new Set<() => void>(),
  scheduleDocumentReload: vi.fn(),
  scheduleSessionReset: vi.fn(),
  showDialog: vi.fn(),
}));

vi.mock('../log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../state.ts', () => ({ getState: moduleMocks.getState }));
vi.mock('../../i18n/index.ts', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: moduleMocks.showDialog }));
vi.mock('../timers.ts', () => ({ setManagedTimer: vi.fn() }));
vi.mock('../session-reset.ts', () => ({
  scheduleDocumentReload: moduleMocks.scheduleDocumentReload,
  scheduleSessionReset: moduleMocks.scheduleSessionReset,
}));
vi.mock('../../rooms/authority.ts', () => ({
  getRoomContext: () => moduleMocks.getState('room.context'),
  isStandardRoomRole: (role: string) =>
    (moduleMocks.getState('room.context') as { kind?: string } | undefined)?.kind !== 'pro' &&
    moduleMocks.getState('network.appRole') === role,
  subscribeRoomAuthorityLifecycle: (listener: () => void) => {
    moduleMocks.roomLifecycleListeners.add(listener);
    return () => moduleMocks.roomLifecycleListeners.delete(listener);
  },
}));

const DISMISSAL_KEY = 'mxqr-sw-update-dismissal-v1';
const RECONNECT_TARGET_KEY = 'mxqr_reconnect_target';
// A PRO room's ID is its 0xxxxx room code.
const PRO_ROOM_ID = '012345';

interface AppState {
  role?: string;
  demoActive?: boolean;
  sessionStarted?: boolean;
  roomId?: string | null;
  roomKind?: 'standard' | 'pro';
  joinCode?: string;
}

function setAppState(state: AppState): void {
  moduleMocks.getState.mockImplementation((key?: string) => {
    if (key === 'network.appRole') return state.role ?? 'idle';
    if (key === 'network.lastJoinCode') return state.joinCode ?? '';
    if (key === 'setup.sessionStarted') return state.sessionStarted === true;
    if (key === 'room.context') {
      return { kind: state.roomKind ?? 'standard', roomId: state.roomId ?? null };
    }
    if (key === 'demo.active') return state.demoActive === true;
    if (key === 'demo.loading') return false;
    return undefined;
  });
}

/** Setup or a room moved on: the room-authority lifecycle signal. */
function emitRoomLifecycle(): void {
  for (const listener of [...moduleMocks.roomLifecycleListeners]) listener();
}

/** Dialog copy given as text, or as a callback read now (as the dialog re-reads it). */
function readsAs(text: string) {
  return {
    asymmetricMatch: (actual: unknown) =>
      (typeof actual === 'function' ? (actual as () => unknown)() : actual) === text,
    toString: () => `ReadsAs<${text}>`,
    toAsymmetricMatcher: () => `ReadsAs<${text}>`,
  };
}

/** The one update dialog, with the message for where this page is. */
function updateDialog(message: string) {
  return expect.objectContaining({
    title: 'dialog.sw_update_title',
    message: readsAs(message),
    buttonText: 'dialog.sw_update_apply',
    secondaryText: 'common.later',
    refreshOn: expect.any(Function),
  });
}

/**
 * Stands in for the real dialog: it subscribes through `refreshOn`, records
 * the message each time it renders it, and stays open until answered.
 */
function holdRenderingDialog() {
  const rendered: string[] = [];
  let answer!: (result: { action: string }) => void;
  moduleMocks.showDialog.mockImplementationOnce(
    (options: { message: () => string; refreshOn: (refresh: () => void) => () => void }) =>
      new Promise((resolve) => {
        const render = () => rendered.push(options.message());
        render();
        const unsubscribe = options.refreshOn(render);
        answer = (result) => {
          unsubscribe();
          resolve(result);
        };
      }),
  );
  return { rendered, answer: (action: string) => answer({ action }) };
}

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
  registrationGate?: Promise<void>,
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
  const register = vi.fn(async () => {
    if (registrationGate) await registrationGate;
    return registration;
  });
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
    // Vitest 5 also reads this clock while evaluating the first dynamic import.
    now: nodePerformance.now.bind(nodePerformance),
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

// A startup prompt waits until page loads have been quiet for 1 s. This
// harness reports no resource timing entries, so the quiet period starts at once.
const STARTUP_PROMPT_QUIET_MS = 1_000;
const STARTUP_PROMPT_WAIT = { timeout: 3_000 };
// Without Web Locks (as in jsdom) the prompt election settles for 50 ms
// before a dialog opens, so "no second dialog" must wait longer than that.
const PROMPT_ELECTION_SETTLE_MS = 200;

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('service-worker cache-retirement client handshake', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    delete document.documentElement.dataset.mxqrNavigationSource;
    document.body.classList.remove('mode-demo');
    moduleMocks.roomLifecycleListeners.clear();
    setAppState({});
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
    setAppState({ role: 'host' });
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

  it('offers a worker that was already waiting when the page opened, once page loads go quiet', async () => {
    moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(harness);

    // Apply sent while the page's own loads still run can stall for a minute.
    await waitMs(STARTUP_PROMPT_QUIET_MS / 2);
    expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    await vi.waitFor(
      () => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(),
      STARTUP_PROMPT_WAIT,
    );
    expect(moduleMocks.showDialog).toHaveBeenCalledWith(updateDialog('dialog.sw_update_apply_msg'));
    await vi.waitFor(() =>
      expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
    );
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();

    // The reload waits for the new controller, so the next document is new.
    harness.setController(harness.waitingWorker!, true, 'v494');
    harness.emit('controllerchange');
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
    expect(moduleMocks.scheduleDocumentReload).toHaveBeenCalledWith(
      'dialog.refreshing_session',
      expect.any(Function),
    );
    moduleMocks.scheduleSessionReset.mock.calls[0]?.[1]?.();
    expect(harness.reload).toHaveBeenCalledOnce();
    await flushAsyncControllerChange();
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
  });

  it('asks on an invite link before the Start tap, and Apply reloads that page', async () => {
    // setup.ts projects the guest role for /CODE while it waits for Start.
    setAppState({ role: 'guest', joinCode: '123456' });
    moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(harness);

    await vi.waitFor(
      () => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(),
      STARTUP_PROMPT_WAIT,
    );
    // Nothing was entered yet, so applying only reloads the invite page.
    expect(moduleMocks.showDialog).toHaveBeenCalledWith(updateDialog('dialog.sw_update_apply_msg'));
    await vi.waitFor(() =>
      expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
    );
    harness.setController(harness.waitingWorker!, true, 'v494');
    harness.emit('controllerchange');
    await vi.waitFor(() => expect(moduleMocks.scheduleDocumentReload).toHaveBeenCalledOnce());
    expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBeNull();
  });

  describe('a waiting worker found within the update-reload cooldown', () => {
    // reloadForServiceWorkerUpdate() wrote both markers a moment ago.
    const markUpdateReload = () => {
      const at = String(Date.now() - 1_000);
      sessionStorage.setItem('sw-updated-at', at);
      sessionStorage.setItem('sw-controller-confirmed-at', at);
    };

    it('activates without asking again and reloads an idle page', async () => {
      markUpdateReload();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'reload', true);
      await registerWithHarness(harness);

      await vi.waitFor(() =>
        expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      );
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
      harness.setController(harness.waitingWorker!, true, 'v494');
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
      await flushAsyncControllerChange();
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    });

    it('asks before reloading a room once the activated worker takes over', async () => {
      markUpdateReload();
      setAppState({ role: 'host', sessionStarted: true });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'reload', true);
      await registerWithHarness(harness);

      await vi.waitFor(() =>
        expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      );
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
      harness.setController(harness.waitingWorker!, true, 'v494');
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      expect(moduleMocks.showDialog).toHaveBeenCalledWith(
        updateDialog('dialog.sw_update_room_host_msg'),
      );
      await flushAsyncControllerChange();
      expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    });
  });

  it.each(['secondary', 'back'])(
    'puts an update off for this page only (%s), and asks again on the next open',
    async (action) => {
      moduleMocks.showDialog.mockResolvedValue({ action });
      const first = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(first);
      const update = first.installUpdate('v494');
      update.emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      await flushAsyncControllerChange();
      expect(update.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      // Nothing about Later outlives the page.
      expect(localStorage.getItem(DISMISSAL_KEY)).toBeNull();

      vi.resetModules();
      const reopened = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(reopened);

      await vi.waitFor(
        () => expect(moduleMocks.showDialog).toHaveBeenCalledTimes(2),
        STARTUP_PROMPT_WAIT,
      );
      expect(moduleMocks.showDialog).toHaveBeenLastCalledWith(
        updateDialog('dialog.sw_update_apply_msg'),
      );
      expect(reopened.waitingWorker?.postMessage).not.toHaveBeenCalledWith({
        type: 'SKIP_WAITING',
      });
    },
  );

  it.each<{ label: string; state: AppState; message: string }>([
    {
      label: 'a host room code (Create)',
      state: { role: 'host' },
      message: 'dialog.sw_update_room_host_msg',
    },
    {
      label: 'an entered guest room',
      state: { role: 'guest', sessionStarted: true, joinCode: '123456' },
      message: 'dialog.sw_update_room_guest_msg',
    },
  ])(
    'still asks, with the copy for $label, when it begins during the quiet wait',
    async ({ state, message }) => {
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(harness);
      // The user taps through setup before the page's loads go quiet.
      setAppState(state);

      await vi.waitFor(
        () => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(),
        STARTUP_PROMPT_WAIT,
      );
      expect(moduleMocks.showDialog).toHaveBeenCalledWith(updateDialog(message));
      await flushAsyncControllerChange();
      expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalledWith({
        type: 'SKIP_WAITING',
      });
      expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    },
  );

  it('waits for page loads to go quiet before offering a startup worker', async () => {
    let lastResponseEnd = performance.now();
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    // Keep page resources finishing for a while after registration.
    vi.mocked(performance.getEntriesByType).mockImplementation((type: string) =>
      type === 'resource'
        ? [{ responseEnd: lastResponseEnd } as unknown as PerformanceResourceTiming]
        : [],
    );
    const keepLoading = setInterval(() => {
      lastResponseEnd = performance.now();
    }, 200);
    try {
      await registerWithHarness(harness);
      await waitMs(STARTUP_PROMPT_QUIET_MS * 1.5);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    } finally {
      clearInterval(keepLoading);
    }

    await vi.waitFor(
      () => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(),
      STARTUP_PROMPT_WAIT,
    );
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
    setAppState({ role: 'host' });
    await registerWithHarness(harness);

    // Another tab applied v494 while this one shows a room code.
    harness.setController(currentController);
    harness.emit('controllerchange');
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    const churned = harness.installUpdate('v494');
    churned.emitInstalled();

    await vi.waitFor(() =>
      expect(churned.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
    );
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
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

  it('applies an open-dialog Apply choice to the latest replacement worker', async () => {
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

  it('applies an open-dialog Later choice to the latest replacement until the next open', async () => {
    let resolveDialog!: (value: { action: 'secondary' }) => void;
    moduleMocks.showDialog.mockReturnValueOnce(
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

    // Later lasted for that page only.
    vi.resetModules();
    const reopened = installServiceWorkerHarness(
      { postMessage: vi.fn() },
      'navigate',
      true,
      493,
      495,
    );
    await registerWithHarness(reopened);
    await vi.waitFor(
      () => expect(moduleMocks.showDialog).toHaveBeenCalledTimes(2),
      STARTUP_PROMPT_WAIT,
    );
  });

  it.each([
    { label: 'Later', action: 'secondary', resets: 0 },
    { label: 'Apply', action: 'ok', resets: 1 },
  ])(
    'asks a room once when another client applies the prompted update and the user picks $label',
    async ({ action, resets }) => {
      let resolveDialog!: (value: { action: string }) => void;
      moduleMocks.showDialog.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveDialog = resolve;
        }),
      );
      setAppState({ role: 'host', sessionStarted: true });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);

      const update = harness.installUpdate('v494');
      update.emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      expect(moduleMocks.showDialog).toHaveBeenCalledWith(
        updateDialog('dialog.sw_update_room_host_msg'),
      );

      // Another tab applies the same generation while this dialog is open.
      harness.setController(update.waitingWorker, true, 'v494');
      harness.emit('controllerchange');
      await flushAsyncControllerChange();
      expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();

      resolveDialog({ action });
      await flushAsyncControllerChange();
      await flushAsyncControllerChange();
      // Later already answered this generation; Apply reloads.
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
      expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledTimes(resets);
      expect(update.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    },
  );

  it('still performs one bounded update check while an older worker is waiting', async () => {
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(harness);

    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledOnce());
  });

  it('does not re-prompt a generation put off with Later in the same page', async () => {
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(harness);
    harness.installUpdate('v494').emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    await flushAsyncControllerChange();

    const again = harness.installUpdate('v494');
    again.emitInstalled();
    await waitMs(PROMPT_ELECTION_SETTLE_MS);

    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    expect(again.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('prompts immediately when a newer waiting generation replaces one put off with Later', async () => {
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(harness);
    harness.installUpdate('v494').emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    await flushAsyncControllerChange();

    harness.installUpdate('v495').emitInstalled();

    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledTimes(2));
  });

  it('lets only one app client present a prompt for the same waiting generation', async () => {
    let keepPromptOpen!: () => void;
    moduleMocks.showDialog.mockReturnValue(
      new Promise((resolve) => {
        keepPromptOpen = () => resolve({ action: 'secondary' });
      }),
    );
    const first = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(first);
    first.installUpdate('v494').emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    vi.resetModules();
    const second = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(second);
    second.installUpdate('v494').emitInstalled();
    await flushAsyncControllerChange();
    await flushAsyncControllerChange();

    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    keepPromptOpen();
  });

  it('retracts a late legacy ownership loser without recording a user dismissal or blocking reload', async () => {
    moduleMocks.showDialog.mockImplementation(
      (options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          options.signal.addEventListener('abort', () => resolve({ action: 'superseded' }), {
            once: true,
          });
        }),
    );
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', false, 703);
    await registerWithHarness(harness);
    const update = harness.installUpdate('v704');
    update.emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    const signal = moduleMocks.showDialog.mock.calls[0]![0].signal as AbortSignal;
    const key = 'mxqr-sw-update-prompt-lease-v1';
    const winner = JSON.stringify({
      identity: 'v704',
      owner: 'native-other-client',
      expiresAt: Date.now() + 300000,
    });
    localStorage.setItem(key, winner);
    globalThis.dispatchEvent(new StorageEvent('storage', { key }));
    await flushAsyncControllerChange();
    expect(signal.aborted).toBe(true);
    expect(localStorage.getItem(key)).toBe(winner);
    expect(localStorage.getItem(DISMISSAL_KEY)).toBeNull();
    expect(update.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    harness.setController(update.waitingWorker, true, 'v704');
    harness.emit('controllerchange');
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
  });

  it('briefly cools down a failed prompt presentation without hiding a newer generation', async () => {
    moduleMocks.showDialog.mockRejectedValueOnce(new Error('dialog unavailable'));
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(harness);
    harness.installUpdate('v494').emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    harness.installUpdate('v494').emitInstalled();
    await flushAsyncControllerChange();
    await flushAsyncControllerChange();
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();

    harness.installUpdate('v495').emitInstalled();
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
    expect(moduleMocks.showDialog).not.toHaveBeenCalled();
  });

  it.each([
    { role: 'idle', initiallyControlled: true, replaceController: true, reset: 1, dialog: 0 },
    { role: 'host', initiallyControlled: true, replaceController: true, reset: 0, dialog: 1 },
    { role: 'idle', initiallyControlled: false, replaceController: true, reset: 0, dialog: 0 },
    { role: 'idle', initiallyControlled: true, replaceController: false, reset: 0, dialog: 0 },
  ])('reconciles controller state after pending registration: %j', async (scenario) => {
    setAppState({ role: scenario.role });
    let finishRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    const originalController = scenario.initiallyControlled ? { postMessage: vi.fn() } : null;
    const harness = installServiceWorkerHarness(
      originalController,
      'navigate',
      false,
      493,
      494,
      registrationGate,
    );
    await registerWithHarness(harness);

    const nextController: FakeWorker = { postMessage: vi.fn() };
    if (scenario.replaceController) {
      harness.setController(nextController);
      harness.emit('controllerchange');
    }
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    finishRegistration();
    await flushAsyncControllerChange();
    await flushAsyncControllerChange();

    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledTimes(scenario.reset);
    expect(moduleMocks.showDialog).toHaveBeenCalledTimes(scenario.dialog);
    if (!scenario.initiallyControlled) {
      harness.emit('message', {
        data: { type: 'MXQR_CACHE_STATUS_REQUEST', cacheVersion: 'v494' },
        source: nextController,
      });
      expect(nextController.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'MXQR_CACHE_CLIENT_STATUS', ready: true }),
      );
    }
    // A later event for the already reconciled controller must not repeat the action.
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledTimes(scenario.reset);
    expect(moduleMocks.showDialog).toHaveBeenCalledTimes(scenario.dialog);
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

  it('asks instead of reloading when another tab applies an update while this tab hosts a room', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    setAppState({ role: 'host', sessionStarted: true });
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    expect(moduleMocks.showDialog).toHaveBeenCalledWith(
      updateDialog('dialog.sw_update_room_host_msg'),
    );
    await flushAsyncControllerChange();
    // Later keeps the room; the next open loads the new version.
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it('asks a room once across controller wrappers for one generation', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const firstWrapper: FakeWorker = { postMessage: vi.fn() };
    const secondWrapper: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    setAppState({ role: 'host' });
    await registerWithHarness(harness);

    harness.setController(firstWrapper, false, 'v494');
    harness.emit('controllerchange');
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    harness.setController(secondWrapper, false, 'v494');
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    await flushAsyncControllerChange();

    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
  });

  it('drops a stale generation continuation when a newer controller wins the race', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const staleController: FakeWorker = { postMessage: vi.fn() };
    const winningController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    setAppState({ role: 'host' });
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

    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    await flushAsyncControllerChange();
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
  });

  it('waits for controllerchange before reloading an approved update', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
    await registerWithHarness(harness);

    const update = harness.installUpdate();
    update.emitInstalled();

    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
    );
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();

    harness.setController(newController);
    harness.emit('controllerchange');

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

    // A duplicate/late lifecycle signal cannot turn the same accepted update
    // into a second dialog or reload.
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce();
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
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

  it('honors Apply when another tab activates the worker while the dialog is open', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
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
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();

    resolveDialog({ action: 'ok' });
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    expect(update.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('finishes a legacy pre-activation reload without asking again', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController, 'reload');
    setAppState({ role: 'host' });
    sessionStorage.setItem('sw-updated-at', String(Date.now()));
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
    await flushAsyncControllerChange();
    expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    expect(Number(sessionStorage.getItem('sw-controller-confirmed-at'))).toBeGreaterThan(0);
  });

  it('does not treat a controller-confirmed reload as a legacy activation handoff', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController, 'reload');
    setAppState({ role: 'host' });
    const confirmedAt = Date.now();
    sessionStorage.setItem('sw-updated-at', String(confirmedAt));
    sessionStorage.setItem('sw-controller-confirmed-at', String(confirmedAt));
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    // A room another tab updated is asked, not reloaded.
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
  });

  describe('one update dialog everywhere (owner decision 2026-10-17)', () => {
    it.each<{ label: string; state: AppState; message: string }>([
      { label: 'the home screen', state: {}, message: 'dialog.sw_update_apply_msg' },
      {
        label: 'a host showing a room code',
        state: { role: 'host' },
        message: 'dialog.sw_update_room_host_msg',
      },
      {
        label: 'a started host room',
        state: { role: 'host', sessionStarted: true },
        message: 'dialog.sw_update_room_host_msg',
      },
      {
        label: 'a guest still joining',
        state: { role: 'guest', joinCode: '123456' },
        message: 'dialog.sw_update_apply_msg',
      },
      {
        label: 'an entered guest room',
        state: { role: 'guest', sessionStarted: true, joinCode: '123456' },
        message: 'dialog.sw_update_room_guest_msg',
      },
      {
        label: 'a PRO room host',
        state: { role: 'host', sessionStarted: true, roomKind: 'pro', roomId: PRO_ROOM_ID },
        message: 'dialog.sw_update_room_guest_msg',
      },
      {
        // reenterAfterDetachedPresence() projects an idle role for two round trips.
        label: 'PRO presence re-entry',
        state: { role: 'idle', sessionStarted: true, roomKind: 'pro', roomId: PRO_ROOM_ID },
        message: 'dialog.sw_update_room_guest_msg',
      },
      { label: 'the demo', state: { demoActive: true }, message: 'dialog.sw_update_apply_msg' },
      {
        label: 'a room running the demo',
        state: { role: 'host', sessionStarted: true, demoActive: true },
        message: 'dialog.sw_update_room_host_msg',
      },
    ])('asks on $label with the copy for that place', async ({ state, message }) => {
      setAppState(state);
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      const update = harness.installUpdate('v494');
      update.emitInstalled();

      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      expect(moduleMocks.showDialog).toHaveBeenCalledWith(updateDialog(message));
      await flushAsyncControllerChange();
      // Later keeps the page as it is.
      expect(update.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    });

    it('keeps a room on Later and asks again on the next open', async () => {
      setAppState({ role: 'host', sessionStarted: true });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      harness.installUpdate('v494').emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      await flushAsyncControllerChange();
      expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();

      // The room ends with the page; the next open starts on the home screen.
      vi.resetModules();
      setAppState({});
      const reopened = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(reopened);
      await vi.waitFor(
        () => expect(moduleMocks.showDialog).toHaveBeenCalledTimes(2),
        STARTUP_PROMPT_WAIT,
      );
      expect(moduleMocks.showDialog).toHaveBeenLastCalledWith(
        updateDialog('dialog.sw_update_apply_msg'),
      );
    });

    it('reloads a host room in place on Apply', async () => {
      moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
      setAppState({ role: 'host', sessionStarted: true, joinCode: '123456' });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      const update = harness.installUpdate('v494');
      update.emitInstalled();
      await vi.waitFor(() =>
        expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      );

      harness.setController(update.waitingWorker, true, 'v494');
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(moduleMocks.scheduleDocumentReload).toHaveBeenCalledOnce());
      expect(moduleMocks.scheduleDocumentReload).toHaveBeenCalledWith(
        'dialog.refreshing_session',
        expect.any(Function),
      );
      // The host opens the room again from the start screen.
      moduleMocks.scheduleSessionReset.mock.calls[0]?.[1]?.();
      expect(harness.reload).toHaveBeenCalledOnce();
      expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBeNull();
    });

    it.each<{ label: string; state: AppState; code: string }>([
      {
        label: 'a guest',
        state: { role: 'guest', sessionStarted: true, joinCode: '123456' },
        code: '123456',
      },
      {
        label: 'a PRO room host',
        state: {
          role: 'host',
          sessionStarted: true,
          roomKind: 'pro',
          roomId: PRO_ROOM_ID,
          joinCode: '012345',
        },
        code: '012345',
      },
      {
        label: 'a PRO participant during presence re-entry',
        state: { role: 'idle', roomKind: 'pro', roomId: PRO_ROOM_ID, joinCode: '012345' },
        code: '012345',
      },
    ])('returns $label to the room Start screen on Apply', async ({ state, code }) => {
      moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
      setAppState(state);
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      const update = harness.installUpdate('v494');
      update.emitInstalled();
      await vi.waitFor(() =>
        expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      );

      harness.setController(update.waitingWorker, true, 'v494');
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
      expect(moduleMocks.scheduleDocumentReload).not.toHaveBeenCalled();
      expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledWith(
        'dialog.refreshing_session',
        expect.any(Function),
      );
      // setup's join error reads this after the reload, as for a reconnect.
      expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBe(code);
      expect(Number(sessionStorage.getItem('sw-controller-confirmed-at'))).toBeGreaterThan(0);
      // The /CODE invite page waits for Start: the browser needs that tap
      // before it plays sound.
      moduleMocks.scheduleSessionReset.mock.calls[0]?.[1]?.();
      expect(window.location.href).toBe(`/${code}`);
      expect(harness.reload).not.toHaveBeenCalled();
    });

    it('reloads in place on Apply when the room code is not a six-digit code', async () => {
      moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
      setAppState({ role: 'guest', sessionStarted: true, joinCode: '../123456' });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      const update = harness.installUpdate('v494');
      update.emitInstalled();
      await vi.waitFor(() =>
        expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      );

      harness.setController(update.waitingWorker, true, 'v494');
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(moduleMocks.scheduleDocumentReload).toHaveBeenCalledOnce());
      expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBeNull();
      moduleMocks.scheduleSessionReset.mock.calls[0]?.[1]?.();
      expect(harness.reload).toHaveBeenCalledOnce();
      expect(window.location.href).toBe('https://musixquare.com/');
    });

    it.each<{ label: string; state: AppState; curtain?: boolean; message: string }>([
      {
        label: 'a host room',
        state: { role: 'host', sessionStarted: true },
        message: 'dialog.sw_update_room_host_msg',
      },
      {
        label: 'PRO presence re-entry',
        state: { role: 'idle', sessionStarted: true, roomKind: 'pro', roomId: PRO_ROOM_ID },
        message: 'dialog.sw_update_room_guest_msg',
      },
      { label: 'the demo', state: { demoActive: true }, message: 'dialog.sw_update_apply_msg' },
      {
        // demo.active clears before the exit curtain removes body.mode-demo.
        label: 'the demo exit curtain',
        state: {},
        curtain: true,
        message: 'dialog.sw_update_apply_msg',
      },
    ])(
      'asks $label instead of reloading when another tab applies an update',
      async ({ state, curtain, message }) => {
        setAppState(state);
        if (curtain) document.body.classList.add('mode-demo');
        const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
        await registerWithHarness(harness);

        harness.setController({ postMessage: vi.fn() }, false, 'v494');
        harness.emit('controllerchange');

        await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
        expect(moduleMocks.showDialog).toHaveBeenCalledWith(updateDialog(message));
        await flushAsyncControllerChange();
        expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
        expect(harness.reload).not.toHaveBeenCalled();
      },
    );

    it('returns a guest to the room Start screen on Apply after another tab applied the update', async () => {
      moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
      setAppState({ role: 'guest', sessionStarted: true, joinCode: '123456' });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);

      harness.setController({ postMessage: vi.fn() }, false, 'v494');
      harness.emit('controllerchange');

      await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
      expect(moduleMocks.showDialog).toHaveBeenCalledWith(
        updateDialog('dialog.sw_update_room_guest_msg'),
      );
      expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBe('123456');
      moduleMocks.scheduleSessionReset.mock.calls[0]?.[1]?.();
      expect(window.location.href).toBe('/123456');
    });

    it('does not ask again when another tab applies a generation put off here', async () => {
      setAppState({ role: 'host', sessionStarted: true });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      const update = harness.installUpdate('v494');
      update.emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      await flushAsyncControllerChange();

      harness.setController(update.waitingWorker, true, 'v494');
      harness.emit('controllerchange');
      await flushAsyncControllerChange();
      await flushAsyncControllerChange();
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();

      // A newer generation applied elsewhere is news again.
      harness.setController({ postMessage: vi.fn() }, false, 'v495');
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledTimes(2));
      expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    });

    it('keeps an open dialog in step with a join that finishes under it', async () => {
      const dialog = holdRenderingDialog();
      // The guest tapped Start on the invite page; the join is still connecting.
      setAppState({ role: 'guest', joinCode: '123456' });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      const update = harness.installUpdate('v494');
      update.emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      expect(dialog.rendered).toEqual(['dialog.sw_update_apply_msg']);

      // The join completes while the dialog is still open.
      setAppState({ role: 'guest', sessionStarted: true, joinCode: '123456' });
      emitRoomLifecycle();
      expect(dialog.rendered).toEqual([
        'dialog.sw_update_apply_msg',
        'dialog.sw_update_room_guest_msg',
      ]);

      // 적용하기 then does what the dialog says: back to the room's Start screen.
      dialog.answer('ok');
      await vi.waitFor(() =>
        expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      );
      expect(moduleMocks.roomLifecycleListeners.size).toBe(0);
      harness.setController(update.waitingWorker, true, 'v494');
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
      expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBe('123456');
    });

    it('does not ask again when another tab applies an unidentified generation put off here', async () => {
      setAppState({ role: 'host', sessionStarted: true });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      const update = harness.installUpdate('v494');
      // A worker that never answers the generation request (a pre-protocol
      // build) is known by its script URL once the request times out.
      update.waitingWorker.postMessage.mockImplementation(() => undefined);
      update.emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(), {
        timeout: 3_000,
      });
      await flushAsyncControllerChange();

      // Another tab applies it, and this tab still cannot identify it.
      harness.setController(update.waitingWorker, true);
      update.waitingWorker.postMessage.mockImplementation(() => undefined);
      harness.emit('controllerchange');
      await waitMs(PROMPT_ELECTION_SETTLE_MS);

      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
      expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    });

    it('keeps update news in this dialog: no chat notice, toast, or peer message', () => {
      const source = readFileSync(resolvePath(process.cwd(), 'src/sw-register.ts'), 'utf8');
      expect(source).not.toMatch(/chat\/|ui\/toast|showToast|SystemMessage/);
      expect(source).not.toMatch(/safeSend|\bbroadcast\(|sendProRoomRealtime/);
    });
  });
});
