/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const moduleMocks = vi.hoisted(() => ({
  announceSystemMessageLocally: vi.fn(),
  broadcastSystemMessage: vi.fn(),
  getState: vi.fn((_key?: string): unknown => undefined),
  isSessionResetPending: vi.fn(() => false),
  isStandaloneDisplayMode: vi.fn(() => false),
  promptContextListeners: [] as Array<() => void>,
  scheduleDocumentReload: vi.fn(),
  scheduleSessionReset: vi.fn(),
  sendSystemMessage: vi.fn(),
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
  isSessionResetPending: moduleMocks.isSessionResetPending,
  scheduleDocumentReload: moduleMocks.scheduleDocumentReload,
  scheduleSessionReset: moduleMocks.scheduleSessionReset,
}));
vi.mock('../platform.ts', () => ({
  isStandaloneDisplayMode: moduleMocks.isStandaloneDisplayMode,
}));
vi.mock('../../chat/protocol.ts', () => ({
  announceSystemMessageLocally: moduleMocks.announceSystemMessageLocally,
  broadcastSystemMessage: moduleMocks.broadcastSystemMessage,
  sendSystemMessage: moduleMocks.sendSystemMessage,
}));
vi.mock('../../rooms/authority.ts', () => ({
  getRoomContext: () => moduleMocks.getState('room.context'),
  isStandardRoomRole: (role: string) =>
    (moduleMocks.getState('room.context') as { kind?: string } | undefined)?.kind !== 'pro' &&
    moduleMocks.getState('network.appRole') === role,
  subscribeRoomAuthorityLifecycle: (listener: () => void) => {
    moduleMocks.promptContextListeners.push(listener);
    return () => undefined;
  },
}));
vi.mock('../events.ts', () => ({
  bus: {
    emit: vi.fn(),
    on: (event: string, listener: () => void) => {
      if (event === 'state:demo.active' || event === 'state:demo.loading') {
        moduleMocks.promptContextListeners.push(listener);
      }
      return () => undefined;
    },
  },
}));

const TAB_NOTICE = 'chat.update_available_tab_system_message';
const APP_NOTICE = 'chat.update_available_app_system_message';
const DISMISSAL_KEY = 'mxqr-sw-update-dismissal-v1';

/** Room or demo lifecycle change, as the room-authority seam and demo state report it. */
function emitPromptContextChange(): void {
  for (const listener of [...moduleMocks.promptContextListeners]) listener();
}

function setAppState(state: {
  role?: string;
  demoActive?: boolean;
  sessionStarted?: boolean;
  roomId?: string | null;
  isConnecting?: boolean;
  hostConn?: object | null;
}): void {
  moduleMocks.getState.mockImplementation((key?: string) => {
    if (key === 'network.appRole') return state.role ?? 'idle';
    if (key === 'network.isConnecting') return state.isConnecting === true;
    if (key === 'network.hostConn') return state.hostConn ?? null;
    if (key === 'setup.sessionStarted') return state.sessionStarted === true;
    if (key === 'room.context') return { roomId: state.roomId ?? null };
    if (key === 'demo.active') return state.demoActive === true;
    if (key === 'demo.loading') return false;
    return undefined;
  });
}

function mountChatSurface(): void {
  const chat = document.createElement('div');
  chat.id = 'chat-messages';
  document.body.append(chat);
}

/** Setup still covering the app, as while a code is created or a join runs. */
function mountActiveSetupOverlay(): HTMLElement {
  const setupOverlay = document.createElement('div');
  setupOverlay.id = 'setup-overlay';
  setupOverlay.className = 'active';
  document.body.append(setupOverlay);
  return setupOverlay;
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

// A startup apply asks once page loads have been quiet for 1 s. This harness
// reports no resource timing entries, so the quiet period starts at once.
const STARTUP_APPLY_QUIET_WAIT_MS = 1_000;
const STARTUP_APPLY_WAIT = { timeout: 3_000 };

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** setup.ts opens an invite link (/CODE) on its Start screen. */
function openInviteLinkPage(): void {
  Object.assign(window.location, { pathname: '/123456' });
}

describe('service-worker cache-retirement client handshake', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    delete document.documentElement.dataset.mxqrNavigationSource;
    document.getElementById('chat-messages')?.remove();
    document.getElementById('setup-overlay')?.remove();
    document.body.classList.remove('mode-demo');
    moduleMocks.promptContextListeners.length = 0;
    moduleMocks.isSessionResetPending.mockReturnValue(false);
    moduleMocks.isStandaloneDisplayMode.mockReturnValue(false);
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

  it('applies a worker that was already waiting when the page opened, without a prompt', async () => {
    const controller: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(controller, 'navigate', true);
    await registerWithHarness(harness);

    // It waits for the page's own loads to go quiet before asking.
    await waitMs(STARTUP_APPLY_QUIET_WAIT_MS / 2);
    expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    await vi.waitFor(
      () =>
        expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      STARTUP_APPLY_WAIT,
    );
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();

    // The reload waits for the new controller, so the next document is new.
    harness.setController(harness.waitingWorker!, true, 'v494');
    harness.emit('controllerchange');
    await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledWith(
      'dialog.refreshing_session',
      expect.any(Function),
    );
    await flushAsyncControllerChange();
    expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    expect(moduleMocks.showToast).not.toHaveBeenCalled();
    expect(moduleMocks.announceSystemMessageLocally).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'on open', afterUpdateReload: false },
    { label: 'right after an update reload', afterUpdateReload: true },
  ])(
    'applies a waiting worker on an invite link before the Start tap ($label)',
    async ({ afterUpdateReload }) => {
      if (afterUpdateReload) {
        // reloadForServiceWorkerUpdate() writes both markers, and a newer worker
        // can already be waiting when the reloaded page opens (cooldown path).
        const at = String(Date.now() - 1_000);
        sessionStorage.setItem('sw-updated-at', at);
        sessionStorage.setItem('sw-controller-confirmed-at', at);
      }
      // setup.ts projects the guest role for /CODE while it waits for Start.
      setAppState({ role: 'guest' });
      mountChatSurface();
      mountActiveSetupOverlay();
      const harness = installServiceWorkerHarness(
        { postMessage: vi.fn() },
        afterUpdateReload ? 'reload' : 'navigate',
        true,
      );
      openInviteLinkPage();
      await registerWithHarness(harness);

      await vi.waitFor(
        () =>
          expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({
            type: 'SKIP_WAITING',
          }),
        STARTUP_APPLY_WAIT,
      );
      harness.setController(harness.waitingWorker!, true, 'v494');
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledOnce());
      await flushAsyncControllerChange();
      expect(moduleMocks.showToast).not.toHaveBeenCalled();
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    },
  );

  it('applies a waiting generation the user dismissed with Later once the app reopens', async () => {
    const first = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(first);
    first.installUpdate('v494').emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem(DISMISSAL_KEY)).not.toBeNull());

    vi.resetModules();
    const reopened = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(reopened);

    await vi.waitFor(
      () =>
        expect(reopened.waitingWorker?.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      STARTUP_APPLY_WAIT,
    );
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: 'joining from the invite link',
      state: { role: 'guest', isConnecting: true },
      invite: true,
    },
    { label: 'connected to a host', state: { role: 'guest', hostConn: {} }, invite: true },
    { label: 'showing a host room code', state: { role: 'host' }, invite: false },
    { label: 'Join on the home screen', state: { role: 'guest' }, invite: false },
  ])(
    'does not reload a page that began $label before the startup update activated',
    async ({ state, invite }) => {
      mountChatSurface();
      mountActiveSetupOverlay();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      if (invite) openInviteLinkPage();
      await registerWithHarness(harness);
      await vi.waitFor(
        () =>
          expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({
            type: 'SKIP_WAITING',
          }),
        STARTUP_APPLY_WAIT,
      );

      setAppState(state);
      harness.setController(harness.waitingWorker!, true, 'v494');
      harness.emit('controllerchange');

      await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledWith(TAB_NOTICE));
      await flushAsyncControllerChange();
      expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
      expect(harness.reload).not.toHaveBeenCalled();
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    },
  );

  it('keeps the notice when Join starts on the home screen while the page loads', async () => {
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(harness);
    // The user taps Join before the page's loads go quiet.
    setAppState({ role: 'guest' });

    await vi.waitFor(
      () => expect(moduleMocks.showToast).toHaveBeenCalledWith(TAB_NOTICE),
      STARTUP_APPLY_WAIT,
    );
    await flushAsyncControllerChange();
    expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    expect(localStorage.getItem(DISMISSAL_KEY)).toBeNull();
  });

  it('waits for page loads to go quiet before asking a startup worker to activate', async () => {
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
      await waitMs(STARTUP_APPLY_QUIET_WAIT_MS * 1.5);
      expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalledWith({
        type: 'SKIP_WAITING',
      });
    } finally {
      clearInterval(keepLoading);
    }

    await vi.waitFor(
      () =>
        expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      STARTUP_APPLY_WAIT,
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

  it('converges to one room notice when another client activates the prompted worker and a room starts', async () => {
    moduleMocks.showDialog.mockImplementation(
      (options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          options.signal.addEventListener('abort', () => resolve({ action: 'superseded' }), {
            once: true,
          });
        }),
    );
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(harness);

    const update = harness.installUpdate('v494');
    update.emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());

    harness.setController(update.waitingWorker, true, 'v494');
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    // The tab joins a room while the idle-screen prompt is still up.
    setAppState({ role: 'host' });
    emitPromptContextChange();

    await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledOnce());
    await flushAsyncControllerChange();
    expect(moduleMocks.showToast).toHaveBeenCalledWith(TAB_NOTICE);
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    expect(localStorage.getItem(DISMISSAL_KEY)).toBeNull();
  });

  it('still performs one bounded update check while an older worker is waiting', async () => {
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    await registerWithHarness(harness);

    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledOnce());
  });

  it('does not re-prompt an explicitly dismissed generation found again in the same page', async () => {
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(harness);
    harness.installUpdate('v494').emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem(DISMISSAL_KEY)).not.toBeNull());

    const again = harness.installUpdate('v494');
    again.emitInstalled();
    await flushAsyncControllerChange();
    await flushAsyncControllerChange();

    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    expect(again.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('prompts immediately when a newer waiting generation replaces a dismissed one', async () => {
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(harness);
    harness.installUpdate('v494').emitInstalled();
    await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem(DISMISSAL_KEY)).not.toBeNull());

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
    expect(localStorage.getItem('mxqr-sw-update-dismissal-v1')).toBeNull();
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
  });

  it.each([
    { role: 'idle', initiallyControlled: true, replaceController: true, reset: 1, toast: 0 },
    { role: 'host', initiallyControlled: true, replaceController: true, reset: 0, toast: 1 },
    { role: 'idle', initiallyControlled: false, replaceController: true, reset: 0, toast: 0 },
    { role: 'idle', initiallyControlled: true, replaceController: false, reset: 0, toast: 0 },
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
    expect(moduleMocks.showToast).not.toHaveBeenCalled();
    finishRegistration();
    await flushAsyncControllerChange();
    await flushAsyncControllerChange();

    expect(moduleMocks.scheduleSessionReset).toHaveBeenCalledTimes(scenario.reset);
    expect(moduleMocks.showToast).toHaveBeenCalledTimes(scenario.toast);
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
    expect(moduleMocks.showToast).toHaveBeenCalledTimes(scenario.toast);
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
    setAppState({ role: 'host' });
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    // No chat surface is mounted here, so the notice falls back to a toast.
    await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledOnce());
    expect(moduleMocks.showToast).toHaveBeenCalledWith(TAB_NOTICE);
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it('deduplicates active-room toasts across controller wrappers for one generation', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const firstWrapper: FakeWorker = { postMessage: vi.fn() };
    const secondWrapper: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    setAppState({ role: 'host' });
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

    await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledOnce());
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
  });

  it('waits for controllerchange before reloading an approved update', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    // Rooms never see the dialog (see the in-room policy below); approval
    // happens on the idle screen.
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
    setAppState({ role: 'host' });
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
    setAppState({ role: 'host' });
    const confirmedAt = Date.now();
    sessionStorage.setItem('sw-updated-at', String(confirmedAt));
    sessionStorage.setItem('sw-controller-confirmed-at', String(confirmedAt));
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledWith(TAB_NOTICE));
    expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
  });

  describe('in-room update notice (owner policy 2026-10-11)', () => {
    const PROMPT_LEASE_KEY = 'mxqr-sw-update-prompt-lease-v1';
    // Longer than the 1 s settle delay after a room or demo ends.
    const SETTLE_WAIT_MS = 1_300;
    const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const holdDialogUntilAborted = () => {
      moduleMocks.showDialog.mockImplementation(
        (options: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            options.signal.addEventListener('abort', () => resolve({ action: 'superseded' }), {
              once: true,
            });
          }),
      );
    };
    const expectNoPeerTraffic = () => {
      expect(moduleMocks.broadcastSystemMessage).not.toHaveBeenCalled();
      expect(moduleMocks.sendSystemMessage).not.toHaveBeenCalled();
    };

    it.each(['host', 'guest'])(
      'posts one local chat notice instead of the dialog in a %s room',
      async (role) => {
        setAppState({ role, sessionStarted: true });
        mountChatSurface();
        const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
        await registerWithHarness(harness);

        await vi.waitFor(() =>
          expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce(),
        );
        await flushAsyncControllerChange();
        expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledWith(TAB_NOTICE);
        expect(moduleMocks.showDialog).not.toHaveBeenCalled();
        expect(moduleMocks.showToast).not.toHaveBeenCalled();
        expectNoPeerTraffic();
        // An automatic "Later": no dismissal and no cross-tab prompt lease.
        expect(localStorage.getItem(DISMISSAL_KEY)).toBeNull();
        expect(localStorage.getItem(PROMPT_LEASE_KEY)).toBeNull();
        expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalledWith({
          type: 'SKIP_WAITING',
        });
        expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
      },
    );

    it('defers the dialog in the demo and uses a toast when no room chat exists', async () => {
      setAppState({ demoActive: true });
      mountChatSurface();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(harness);

      await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledOnce());
      await flushAsyncControllerChange();
      expect(moduleMocks.showToast).toHaveBeenCalledWith(TAB_NOTICE);
      expect(moduleMocks.announceSystemMessageLocally).not.toHaveBeenCalled();
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
      expect(localStorage.getItem(DISMISSAL_KEY)).toBeNull();
    });

    it('posts the room chat notice while a room runs the demo', async () => {
      setAppState({ role: 'host', demoActive: true });
      mountChatSurface();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(harness);

      await vi.waitFor(() =>
        expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledWith(TAB_NOTICE),
      );
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
      expect(moduleMocks.showToast).not.toHaveBeenCalled();
    });

    it.each(['host', 'guest'])(
      'uses a toast while setup still covers a provisional %s room, then the chat notice once the room starts',
      async (role) => {
        setAppState({ role, isConnecting: role === 'guest' });
        mountChatSurface();
        const setupOverlay = mountActiveSetupOverlay();
        const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
        await registerWithHarness(harness);

        await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledWith(TAB_NOTICE));
        expect(moduleMocks.announceSystemMessageLocally).not.toHaveBeenCalled();
        expect(moduleMocks.showDialog).not.toHaveBeenCalled();

        // A lifecycle change while setup still covers the room adds nothing.
        emitPromptContextChange();
        await flushAsyncControllerChange();
        expect(moduleMocks.showToast).toHaveBeenCalledOnce();
        expect(moduleMocks.announceSystemMessageLocally).not.toHaveBeenCalled();

        // Setup marks the room started and hides its overlay in one task.
        setAppState({ role, sessionStarted: true });
        emitPromptContextChange();
        setupOverlay.classList.remove('active');
        await vi.waitFor(() =>
          expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce(),
        );
        expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledWith(TAB_NOTICE);

        emitPromptContextChange();
        await flushAsyncControllerChange();
        expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce();
        expect(moduleMocks.showToast).toHaveBeenCalledOnce();
        expect(moduleMocks.showDialog).not.toHaveBeenCalled();
        expect(localStorage.getItem(DISMISSAL_KEY)).toBeNull();
        expectNoPeerTraffic();
      },
    );

    it('does not re-post a toast-only notice after the user answered the dialog on setup', async () => {
      setAppState({ role: 'guest', isConnecting: true });
      mountChatSurface();
      const setupOverlay = mountActiveSetupOverlay();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(harness);
      await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledOnce());

      // The join is cancelled back to the idle setup screen; "Later" there
      // is the user's own choice.
      setAppState({});
      emitPromptContextChange();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(), {
        timeout: 3_000,
      });
      await vi.waitFor(() => expect(localStorage.getItem(DISMISSAL_KEY)).not.toBeNull());

      setAppState({ role: 'guest', sessionStarted: true });
      emitPromptContextChange();
      setupOverlay.classList.remove('active');
      await flushAsyncControllerChange();
      await flushAsyncControllerChange();
      expect(moduleMocks.announceSystemMessageLocally).not.toHaveBeenCalled();
      expect(moduleMocks.showToast).toHaveBeenCalledOnce();
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    });

    describe('PRO presence re-entry (role projected idle, room still up)', () => {
      const PRO_ROOM_ID = 'pro-room-1';

      it.each([
        { label: 'session started', sessionStarted: true, roomId: null },
        { label: 'PRO room context', sessionStarted: false, roomId: PRO_ROOM_ID },
        { label: 'both', sessionStarted: true, roomId: PRO_ROOM_ID },
      ])(
        'offers no dialog while only the role is idle ($label), then once after a real leave',
        async ({ sessionStarted, roomId }) => {
          setAppState({ role: 'host', sessionStarted: true, roomId: PRO_ROOM_ID });
          mountChatSurface();
          const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
          await registerWithHarness(harness);
          await vi.waitFor(() =>
            expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce(),
          );

          // reenterAfterDetachedPresence(): the bridge disconnect projects an
          // idle role for enterPresence + createSignalingTicket.
          setAppState({ role: 'idle', sessionStarted, roomId });
          emitPromptContextChange();
          await settle(SETTLE_WAIT_MS);
          expect(moduleMocks.showDialog).not.toHaveBeenCalled();
          expect(moduleMocks.showToast).not.toHaveBeenCalled();
          expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce();

          // Re-entry completes: the role is host again.
          setAppState({ role: 'host', sessionStarted: true, roomId: PRO_ROOM_ID });
          emitPromptContextChange();
          await settle(SETTLE_WAIT_MS);
          expect(moduleMocks.showDialog).not.toHaveBeenCalled();

          // A real leave clears the role, the session, and the room together.
          setAppState({});
          emitPromptContextChange();
          await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(), {
            timeout: 3_000,
          });
          expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce();
          expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
        },
      );

      it('never auto-reloads the tab when another tab activates an update during re-entry', async () => {
        setAppState({ role: 'idle', sessionStarted: true, roomId: PRO_ROOM_ID });
        mountChatSurface();
        const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
        await registerWithHarness(harness);

        const newController: FakeWorker = { postMessage: vi.fn() };
        harness.setController(newController, false, 'v494');
        harness.emit('controllerchange');

        await vi.waitFor(() =>
          expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledWith(TAB_NOTICE),
        );
        await flushAsyncControllerChange();
        expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
        expect(harness.reload).not.toHaveBeenCalled();
        expect(moduleMocks.showToast).not.toHaveBeenCalled();
        expectNoPeerTraffic();
      });
    });

    it('keeps the update dialog for an update found on the idle setup screen', async () => {
      mountChatSurface();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      harness.installUpdate('v494').emitInstalled();

      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      expect(moduleMocks.showDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'dialog.sw_update_title',
          message: 'dialog.sw_update_msg',
          buttonText: 'common.refresh',
          secondaryText: 'common.later',
        }),
      );
      expect(moduleMocks.announceSystemMessageLocally).not.toHaveBeenCalled();
      expect(moduleMocks.showToast).not.toHaveBeenCalled();
    });

    it.each([
      { standalone: false, chat: true, key: TAB_NOTICE },
      { standalone: true, chat: true, key: APP_NOTICE },
      { standalone: false, chat: false, key: TAB_NOTICE },
      { standalone: true, chat: false, key: APP_NOTICE },
    ])('uses the browser-tab or home-screen copy: %j', async ({ standalone, chat, key }) => {
      moduleMocks.isStandaloneDisplayMode.mockReturnValue(standalone);
      setAppState({ role: 'guest', sessionStarted: true });
      if (chat) mountChatSurface();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(harness);

      const channel = chat ? moduleMocks.announceSystemMessageLocally : moduleMocks.showToast;
      const other = chat ? moduleMocks.showToast : moduleMocks.announceSystemMessageLocally;
      await vi.waitFor(() => expect(channel).toHaveBeenCalledOnce());
      expect(channel).toHaveBeenCalledWith(key);
      expect(other).not.toHaveBeenCalled();
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    });

    it('announces each generation once across re-checks and another tab activating it', async () => {
      setAppState({ role: 'host' });
      mountChatSurface();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);

      const first = harness.installUpdate('v494');
      first.emitInstalled();
      await vi.waitFor(() =>
        expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce(),
      );

      // A second worker object for the same generation is a re-check.
      const again = harness.installUpdate('v494');
      again.emitInstalled();
      await flushAsyncControllerChange();
      await flushAsyncControllerChange();
      expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce();

      // Another tab accepts that generation: same notice, no reload, no toast.
      harness.setController(again.waitingWorker, true, 'v494');
      harness.emit('controllerchange');
      await flushAsyncControllerChange();
      await flushAsyncControllerChange();
      expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce();
      expect(moduleMocks.showToast).not.toHaveBeenCalled();
      expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();

      // A newer generation is news again.
      const newer = harness.installUpdate('v495');
      newer.emitInstalled();
      await vi.waitFor(() =>
        expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledTimes(2),
      );
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
      expectNoPeerTraffic();
    });

    it('stays quiet in a room for a generation the user already dismissed', async () => {
      const first = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(first);
      first.installUpdate('v494').emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(localStorage.getItem(DISMISSAL_KEY)).not.toBeNull());

      vi.resetModules();
      moduleMocks.promptContextListeners.length = 0;
      setAppState({ role: 'host' });
      mountChatSurface();
      const reopened = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(reopened);
      await flushAsyncControllerChange();
      await flushAsyncControllerChange();

      expect(moduleMocks.announceSystemMessageLocally).not.toHaveBeenCalled();
      expect(moduleMocks.showToast).not.toHaveBeenCalled();
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    });

    it('replaces the other-tab update toast with a local chat notice in a room', async () => {
      setAppState({ role: 'host' });
      mountChatSurface();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);

      const newController: FakeWorker = { postMessage: vi.fn() };
      harness.setController(newController, false, 'v494');
      harness.emit('controllerchange');

      await vi.waitFor(() =>
        expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce(),
      );
      expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledWith(TAB_NOTICE);
      expect(moduleMocks.showToast).not.toHaveBeenCalled();
      expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
      expect(harness.reload).not.toHaveBeenCalled();
      expectNoPeerTraffic();
    });

    it('never auto-reloads a tab running the demo when another tab activates an update', async () => {
      setAppState({ demoActive: true });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);

      const newController: FakeWorker = { postMessage: vi.fn() };
      harness.setController(newController, false, 'v494');
      harness.emit('controllerchange');

      await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledWith(TAB_NOTICE));
      expect(moduleMocks.scheduleSessionReset).not.toHaveBeenCalled();
      expect(harness.reload).not.toHaveBeenCalled();
    });

    it('offers the deferred generation once after the tab leaves the room', async () => {
      setAppState({ role: 'host' });
      mountChatSurface();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(harness);
      await vi.waitFor(() =>
        expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce(),
      );

      setAppState({ role: 'idle' });
      // leaveSession publishes several lifecycle fields in one teardown.
      emitPromptContextChange();
      emitPromptContextChange();
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(), {
        timeout: 3_000,
      });
      // This "Later" is the user's own choice and is remembered.
      await vi.waitFor(() => expect(localStorage.getItem(DISMISSAL_KEY)).not.toBeNull());

      emitPromptContextChange();
      await settle(SETTLE_WAIT_MS);
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
      expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce();
    });

    it('waits while a leave or reload is still committing', async () => {
      setAppState({ role: 'guest', sessionStarted: true });
      mountChatSurface();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(harness);
      await vi.waitFor(() =>
        expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce(),
      );

      moduleMocks.isSessionResetPending.mockReturnValue(true);
      setAppState({ role: 'idle' });
      emitPromptContextChange();
      await settle(SETTLE_WAIT_MS);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();

      // The navigation did not commit and this document stayed on setup.
      moduleMocks.isSessionResetPending.mockReturnValue(false);
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(), {
        timeout: 3_000,
      });
    });

    it('waits for the demo exit curtain before offering the deferred prompt', async () => {
      setAppState({ demoActive: true });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(harness);
      await vi.waitFor(() => expect(moduleMocks.showToast).toHaveBeenCalledOnce());

      // demo.active clears before the curtain removes body.mode-demo.
      document.body.classList.add('mode-demo');
      setAppState({});
      emitPromptContextChange();
      await settle(SETTLE_WAIT_MS);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();

      document.body.classList.remove('mode-demo');
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(), {
        timeout: 3_000,
      });
      expect(moduleMocks.showToast).toHaveBeenCalledOnce();
    });

    it('retracts an open idle prompt when a room starts, without a dismissal', async () => {
      holdDialogUntilAborted();
      mountChatSurface();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      const update = harness.installUpdate('v494');
      update.emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      const signal = moduleMocks.showDialog.mock.calls[0]![0].signal as AbortSignal;

      setAppState({ role: 'host' });
      emitPromptContextChange();
      expect(signal.aborted).toBe(true);
      expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce();
      await flushAsyncControllerChange();
      expect(moduleMocks.announceSystemMessageLocally).toHaveBeenCalledOnce();
      expect(localStorage.getItem(DISMISSAL_KEY)).toBeNull();
      expect(localStorage.getItem(PROMPT_LEASE_KEY)).toBeNull();
      expect(update.waitingWorker.postMessage).not.toHaveBeenCalledWith({
        type: 'SKIP_WAITING',
      });

      moduleMocks.showDialog.mockResolvedValue({ action: 'secondary' });
      setAppState({ role: 'idle' });
      emitPromptContextChange();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledTimes(2), {
        timeout: 3_000,
      });
    });

    it('never sends the update notice to peers', () => {
      const source = readFileSync(resolvePath(process.cwd(), 'src/sw-register.ts'), 'utf8');
      expect(source).toContain(
        "import { announceSystemMessageLocally } from './chat/protocol.ts';",
      );
      expect(source).not.toMatch(
        /broadcastSystemMessage|sendSystemMessage|safeSend|\bbroadcast\(|sendProRoomRealtime/,
      );
    });
  });
});
