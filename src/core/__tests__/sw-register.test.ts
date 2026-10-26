/**
 * @vitest-environment jsdom
 *
 * The update machine in src/sw-register.ts (registry RO-22) against the real
 * page navigation owner, src/core/session-reset.ts (RO-23), with navigation.ts
 * and the PRO claim fence it reloads through (navigation.ts's returnToRoomStart
 * is wrapped to record each request, then runs as written). Replaced: the
 * service-worker container (SKIP_WAITING is the recorded postMessage of each
 * fake worker),
 * the location sinks (recorded no-op navigations, __helpers__/navigation-sinks.ts),
 * the update dialog, app state, room authority and i18n (keys). A navigation
 * the machine asks for shows as the owner holding the page
 * (`isSessionResetPending`), the reset message, and one sink call once the
 * reset screen has painted. The transition table of the same machine is in
 * sw-update-transitions.integration.test.ts.
 */

import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubNavigationSinks, type NavigationSinks } from './__helpers__/navigation-sinks.ts';
import type { HardResetClaim, HardResetClaimRequest } from '../../sw-register.ts';
import { HARD_RESET_CLAIM_EVENT } from './__helpers__/hard-reset-port.ts';
import { createFloorReadStub, type FloorReadStub } from './__helpers__/app-build-floor-read.ts';
import {
  APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS,
  APP_BUILD_FLOOR_READ_TIMEOUT_MS,
} from '../../sw-update-coordination.ts';

const moduleMocks = vi.hoisted(() => ({
  getState: vi.fn((_key?: string): unknown => undefined),
  roomLifecycleListeners: new Set<() => void>(),
  showDialog: vi.fn(),
  // The options of each update reload the machine asked returnToRoomStart for.
  roomStartReturns: [] as Array<{ onRecovered?: () => void }>,
  // Where update news could leak besides the dialog: a toast, a chat notice
  // or a message to peers. afterEach checks every case left them unused.
  notices: {
    showToast: vi.fn(),
    broadcastSystemMessage: vi.fn(),
    announceSystemMessageLocally: vi.fn(),
    sendSystemMessage: vi.fn(),
    broadcast: vi.fn(),
    broadcastExcept: vi.fn(),
    safeSend: vi.fn(),
    sendProRoomRealtime: vi.fn(),
  },
}));

vi.mock('../log.ts', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../state.ts', () => ({ getState: moduleMocks.getState }));
vi.mock('../../i18n/index.ts', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: moduleMocks.showDialog }));
vi.mock('../timers.ts', () => ({ setManagedTimer: vi.fn() }));
vi.mock('../../ui/toast.ts', () => ({ showToast: moduleMocks.notices.showToast }));
vi.mock('../../chat/protocol.ts', () => ({
  broadcastSystemMessage: moduleMocks.notices.broadcastSystemMessage,
  announceSystemMessageLocally: moduleMocks.notices.announceSystemMessageLocally,
  sendSystemMessage: moduleMocks.notices.sendSystemMessage,
}));
vi.mock('../../network/peer-state.ts', () => ({
  broadcast: moduleMocks.notices.broadcast,
  broadcastExcept: moduleMocks.notices.broadcastExcept,
  safeSend: moduleMocks.notices.safeSend,
}));
vi.mock('../../pro-room/realtime-sender.ts', () => ({
  sendProRoomRealtime: moduleMocks.notices.sendProRoomRealtime,
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

interface SwHarness {
  setController(worker: FakeWorker | null, clearWaiting?: boolean, cacheVersion?: string): void;
  emit(type: 'controllerchange' | 'message' | 'mxqr:hard-reset-claim', event?: unknown): void;
  installUpdate(cacheVersion?: string): {
    emitInstalled(): void;
    waitingWorker: FakeWorker;
  };
  register: ReturnType<typeof vi.fn>;
  /** The location sinks the navigation owner calls. */
  sinks: NavigationSinks;
  reload: NavigationSinks['reload'];
  update: ReturnType<typeof vi.fn>;
  waitingWorker: FakeWorker | null;
}

const actualWindow = globalThis.window;

/** The recorded location sinks, on a window that reports a secure context. */
function stubSecureNavigationSinks(): NavigationSinks {
  const sinks = stubNavigationSinks();
  const sinkWindow = globalThis.window;
  vi.stubGlobal(
    'window',
    new Proxy({} as Window, {
      get(_target, property) {
        if (property === 'isSecureContext') return true;
        return Reflect.get(sinkWindow, property) as unknown;
      },
    }),
  );
  return sinks;
}

/** The recorded location sinks, on a window that reports a secure context or not. */
function stubSinks(secure: boolean): NavigationSinks {
  const sinks = stubNavigationSinks();
  const sinkWindow = globalThis.window;
  vi.stubGlobal(
    'window',
    new Proxy({} as Window, {
      get(_target, property) {
        if (property === 'isSecureContext') return secure;
        return Reflect.get(sinkWindow, property) as unknown;
      },
    }),
  );
  return sinks;
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
  const sinks = stubSecureNavigationSinks();
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
    sinks,
    reload: sinks.reload,
    update: registration.update,
    waitingWorker: initialWaitingWorker,
  };
}

type NavigationOwner = typeof import('../session-reset.ts');

/** The navigation owners of the documents this test registered; afterEach releases them. */
const loadedOwners: NavigationOwner[] = [];
/** The navigation owner of the document registered last. */
let owner: NavigationOwner;

async function registerWithHarness(harness: SwHarness): Promise<void> {
  // returnToRoomStart runs as written, on this document's own navigation
  // owner, and records each request. (A vi.mock factory's module would outlive
  // vi.resetModules and keep the first document's owner.)
  vi.doMock('../navigation.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../navigation.ts')>();
    return {
      ...actual,
      returnToRoomStart: (...args: Parameters<typeof actual.returnToRoomStart>) => {
        moduleMocks.roomStartReturns.push(args[1]);
        return actual.returnToRoomStart(...args);
      },
    };
  });
  const { registerServiceWorker } = await import('../../sw-register.ts');
  // The same module graph as sw-register's, so the same owner instance.
  owner = await import('../session-reset.ts');
  loadedOwners.push(owner);
  registerServiceWorker();
  await vi.waitFor(() => expect(harness.register).toHaveBeenCalledOnce());
  expect(harness.register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' });
}

async function flushAsyncControllerChange(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Each navigation the page made, once the reset screen painted: 'reload' or 'href /CODE'. */
function navigations(harness: SwHarness): string[] {
  return harness.sinks.calls.map((call) =>
    call.url === null ? call.op : `${call.op} ${call.url}`,
  );
}

/** The machine asked the navigation owner for nothing: the page is not held and nothing navigated. */
function expectNoNavigation(harness: SwHarness): void {
  expect(owner.isSessionResetPending()).toBe(false);
  expect(navigations(harness)).toEqual([]);
}

/** The message on the reset screen the last navigation showed. */
function resetMessage(): string | null {
  return document.getElementById('session-reset-message')?.textContent ?? null;
}

/**
 * The navigation the page holds did not take this document away: once its
 * sink has run (`navigated` sink calls so far), the document leaves and comes
 * back (pagehide, then pageshow), and the owner settles the attempt as
 * recovered, exactly once.
 */
async function recoverNavigation(harness: SwHarness, navigated: number): Promise<void> {
  await vi.waitFor(() => expect(harness.sinks.calls).toHaveLength(navigated));
  expect(owner.isSessionResetPending()).toBe(true);
  actualWindow.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  actualWindow.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
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

/** The forced variant of the one update dialog: Apply only, Back keeps it. */
function forcedUpdateDialog(message: string) {
  return expect.objectContaining({
    title: 'dialog.sw_update_title',
    message: readsAs(message),
    buttonText: 'dialog.sw_update_apply',
    closeOnBack: false,
    refreshOn: expect.any(Function),
  });
}

/**
 * The App build floor read of the start and resume check (forced update
 * Inc 7). Every case installs it as `fetch`: a page with a build reads the
 * floor at load and on each return, and by default the answer is 0 (no
 * floor). Any other URL still meets the unit network guard.
 */
let floorReads: FloorReadStub;

interface AddedListener {
  readonly target: EventTarget;
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}

/**
 * The listeners each case's documents add on the window and the document
 * (the floor check's return triggers among them), removed after the case as
 * an unloaded document's are, so no case's listeners act in the next one.
 */
const addedListeners: AddedListener[] = [];
const listenerSpies: Array<{ mockRestore(): void }> = [];

function trackAddedListeners(): void {
  for (const target of [document, actualWindow] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    listenerSpies.push(
      vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
        addedListeners.push({ target, type, listener, options });
        add(type, listener, options);
      }),
    );
  }
}

function removeAddedListeners(): void {
  for (const spy of listenerSpies.splice(0)) spy.mockRestore();
  for (const { target, type, listener, options } of addedListeners.splice(0)) {
    target.removeEventListener(type, listener, options);
  }
}

describe('service-worker cache-retirement client handshake', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    document.body.innerHTML = '';
    document.documentElement.className = '';
    delete document.documentElement.dataset.mxqrNavigationSource;
    document.body.classList.remove('mode-demo');
    moduleMocks.roomLifecycleListeners.clear();
    moduleMocks.roomStartReturns.length = 0;
    setAppState({});
    moduleMocks.showDialog.mockResolvedValue({ action: 'secondary' });
    floorReads = createFloorReadStub();
    vi.stubGlobal('fetch', floorReads.fetch);
    trackAddedListeners();
  });

  afterEach(() => {
    // Owner decision 2026-10-17: update news stays in the update dialog (no
    // "refresh to apply" notice), in every case of this file.
    for (const [name, notice] of Object.entries(moduleMocks.notices)) {
      expect(notice, name).not.toHaveBeenCalled();
    }
    // Release every navigation the page still holds. A recovery can start the
    // machine's next reload, which the next pass releases in turn.
    for (const loaded of loadedOwners.splice(0)) {
      for (let pass = 0; pass < 5; pass += 1) {
        loaded.__resetPageNavigationForTests();
        if (!loaded.isSessionResetPending()) break;
      }
    }
    removeAddedListeners();
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
    expectNoNavigation(harness);

    // The reload waits for the new controller, so the next document is new.
    harness.setController(harness.waitingWorker!, true, 'v494');
    harness.emit('controllerchange');
    expect(owner.isSessionResetPending()).toBe(true);
    expect(resetMessage()).toBe('dialog.refreshing_session');
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));
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
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));
    expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBeNull();
  });

  describe('a waiting worker found within the update-reload cooldown', () => {
    // reloadForServiceWorkerUpdate() wrote both markers a moment ago.
    const markUpdateReload = () => {
      const at = String(Date.now() - 1_000);
      sessionStorage.setItem('sw-updated-at', at);
      sessionStorage.setItem('sw-controller-confirmed-at', at);
    };

    it('activates without asking again, once the page is quiet (P3-9 A), and reloads an idle page', async () => {
      markUpdateReload();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'reload', true);
      await registerWithHarness(harness);

      // Not while the page's loads may still run (C6-10, owner decision P3-9 A).
      await waitMs(STARTUP_PROMPT_QUIET_MS / 2);
      expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      await vi.waitFor(
        () =>
          expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({
            type: 'SKIP_WAITING',
          }),
        STARTUP_PROMPT_WAIT,
      );
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
      harness.setController(harness.waitingWorker!, true, 'v494');
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));
      await flushAsyncControllerChange();
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    });

    it('asks before reloading a room once the activated worker takes over', async () => {
      markUpdateReload();
      setAppState({ role: 'host', sessionStarted: true });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'reload', true);
      await registerWithHarness(harness);

      await vi.waitFor(
        () =>
          expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({
            type: 'SKIP_WAITING',
          }),
        STARTUP_PROMPT_WAIT,
      );
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
      harness.setController(harness.waitingWorker!, true, 'v494');
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      expect(moduleMocks.showDialog).toHaveBeenCalledWith(
        updateDialog('dialog.sw_update_room_host_msg'),
      );
      await flushAsyncControllerChange();
      expectNoNavigation(harness);
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
      expectNoNavigation(harness);
    },
  );

  it('waits for page loads to go quiet before offering a startup worker', async () => {
    let lastResponseEnd = performance.now();
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
    // Keep page resources finishing for a while after registration.
    vi.mocked(performance.getEntriesByType).mockImplementation((type: string) =>
      type === 'resource'
        ? [
            {
              name: 'https://musixquare.com/assets/page.js',
              responseEnd: lastResponseEnd,
            } as unknown as PerformanceResourceTiming,
          ]
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

  it('silently clears an impossible same-cache-generation waiting worker, once the page is quiet (P3-9 A)', async () => {
    const harness = installServiceWorkerHarness(
      { postMessage: vi.fn() },
      'navigate',
      true,
      493,
      493,
    );
    await registerWithHarness(harness);

    await waitMs(STARTUP_PROMPT_QUIET_MS / 2);
    expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    await vi.waitFor(
      () =>
        expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith({
          type: 'SKIP_WAITING',
        }),
      STARTUP_PROMPT_WAIT,
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

    await vi.waitFor(
      () =>
        expect(churned.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      STARTUP_PROMPT_WAIT,
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
      expectNoNavigation(harness);

      resolveDialog({ action });
      await flushAsyncControllerChange();
      await flushAsyncControllerChange();
      // Later already answered this generation; Apply reloads.
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
      expect(owner.isSessionResetPending()).toBe(resets > 0);
      await vi.waitFor(() => expect(navigations(harness)).toHaveLength(resets));
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
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));
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

    expect(owner.isSessionResetPending()).toBe(true);
    expect(resetMessage()).toBe('dialog.refreshing_session');
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));
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
    expectNoNavigation(harness);
    expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    finishRegistration();
    await flushAsyncControllerChange();
    await flushAsyncControllerChange();

    expect(owner.isSessionResetPending()).toBe(scenario.reset > 0);
    await vi.waitFor(() => expect(navigations(harness)).toHaveLength(scenario.reset));
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
    expect(owner.isSessionResetPending()).toBe(scenario.reset > 0);
    expect(navigations(harness)).toHaveLength(scenario.reset);
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
    expect(owner.isSessionResetPending()).toBe(true);
    expect(resetMessage()).toBe('dialog.refreshing_session');
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

    await recoverNavigation(harness, 1);
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    expect(owner.isSessionResetPending()).toBe(false);
    expect(navigations(harness)).toEqual(['reload']);
    harness.setController(secondController);
    harness.emit('controllerchange');
    harness.emit('controllerchange');

    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload', 'reload']));
  });

  it('reserves an unresolved successor immediately when the current reload recovers', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const firstController: FakeWorker = { postMessage: vi.fn() };
    const unresolvedSuccessor: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    await registerWithHarness(harness);

    harness.setController(firstController);
    harness.emit('controllerchange');
    expect(owner.isSessionResetPending()).toBe(true);

    harness.setController(unresolvedSuccessor);
    unresolvedSuccessor.postMessage.mockImplementation(() => undefined);
    harness.emit('controllerchange');

    await recoverNavigation(harness, 1);

    // The second reset is claimed inside recovery, without waiting for the
    // mixed-version successor's generation timeout.
    expect(owner.isSessionResetPending()).toBe(true);
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload', 'reload']));
  });

  it('does not let a stale recovery release a successor reload attempt', async () => {
    // The owner settles each attempt once (the next case), so today no stale
    // recovery reaches the machine through it. This hands the machine one
    // directly, to pin its own check that only the scheduled reload's
    // recovery releases it.
    const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
    await registerWithHarness(harness);

    harness.setController({ postMessage: vi.fn() });
    harness.emit('controllerchange');
    await recoverNavigation(harness, 1);
    harness.setController({ postMessage: vi.fn() });
    harness.emit('controllerchange');
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload', 'reload']));
    expect(moduleMocks.roomStartReturns).toHaveLength(2);

    // The first reload's recovery runs again while the successor is pending.
    moduleMocks.roomStartReturns[0]?.onRecovered?.();
    harness.setController({ postMessage: vi.fn() });
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    // The successor still holds the machine: the newer controller waits for
    // the successor's own recovery instead of asking for a third reload now.
    expect(moduleMocks.roomStartReturns).toHaveLength(2);

    await recoverNavigation(harness, 2);
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload', 'reload', 'reload']));
    expect(moduleMocks.roomStartReturns).toHaveLength(3);
  });

  it('settles a reload attempt once: a document return while the successor navigates releases nothing', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const firstController: FakeWorker = { postMessage: vi.fn() };
    const secondController: FakeWorker = { postMessage: vi.fn() };
    const thirdController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController);
    await registerWithHarness(harness);

    harness.setController(firstController);
    harness.emit('controllerchange');
    await recoverNavigation(harness, 1);

    harness.setController(secondController);
    harness.emit('controllerchange');
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload', 'reload']));
    // The first attempt's recovery signals arrive again. The owner settled
    // that attempt once; a return of the document while the successor is
    // still navigating (not 'left') settles nothing.
    actualWindow.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(owner.isSessionResetPending()).toBe(true);

    harness.setController(thirdController);
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    expect(navigations(harness)).toEqual(['reload', 'reload']);

    await recoverNavigation(harness, 2);
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload', 'reload', 'reload']));
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
    expect(owner.isSessionResetPending()).toBe(true);

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

    await recoverNavigation(harness, 1);
    await flushAsyncControllerChange();

    expect(owner.isSessionResetPending()).toBe(false);
    expect(navigations(harness)).toEqual(['reload']);
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
    expectNoNavigation(harness);
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
    expectNoNavigation(harness);
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
    expectNoNavigation(harness);
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
    expectNoNavigation(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    expect(owner.isSessionResetPending()).toBe(true);
    expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(resetMessage()).toBe('dialog.refreshing_session');
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));
    expect(harness.reload).toHaveBeenCalledOnce();

    // A duplicate/late lifecycle signal cannot turn the same accepted update
    // into a second dialog or reload.
    harness.emit('controllerchange');
    await flushAsyncControllerChange();
    expect(navigations(harness)).toEqual(['reload']);
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
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));
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
    expectNoNavigation(harness);

    resolveDialog({ action: 'ok' });
    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));
    expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    expect(update.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('finishes an update reload that left before its controller change without asking again', async () => {
    const oldController: FakeWorker = { postMessage: vi.fn() };
    const newController: FakeWorker = { postMessage: vi.fn() };
    const harness = installServiceWorkerHarness(oldController, 'reload');
    setAppState({ role: 'host' });
    // An earlier document of this tab asked for an activation (an Apply, or
    // the forced Apply without a waiting worker) and reloaded before it saw
    // the controller change.
    sessionStorage.setItem('sw-updated-at', String(Date.now()));
    await registerWithHarness(harness);

    harness.setController(newController);
    harness.emit('controllerchange');

    await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));
    await flushAsyncControllerChange();
    expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    expect(Number(sessionStorage.getItem('sw-controller-confirmed-at'))).toBeGreaterThan(0);
  });

  it('does not treat a controller-confirmed reload as an unfinished update reload', async () => {
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
    expectNoNavigation(harness);
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
      expectNoNavigation(harness);
    });

    it('keeps a room on Later and asks again on the next open', async () => {
      setAppState({ role: 'host', sessionStarted: true });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      harness.installUpdate('v494').emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      await flushAsyncControllerChange();
      expectNoNavigation(harness);

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
      expect(resetMessage()).toBe('dialog.refreshing_session');
      // The host opens the room again from the start screen.
      await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));
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
      expect(owner.isSessionResetPending()).toBe(true);
      expect(resetMessage()).toBe('dialog.refreshing_session');
      // setup's join error reads this after the reload, as for a reconnect.
      expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBe(code);
      expect(Number(sessionStorage.getItem('sw-controller-confirmed-at'))).toBeGreaterThan(0);
      // The /CODE invite page waits for Start: the browser needs that tap
      // before it plays sound.
      await vi.waitFor(() => expect(navigations(harness)).toEqual([`href /${code}`]));
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
      expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBeNull();
      // A reload in place: no /CODE navigation.
      await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));
      expect(harness.reload).toHaveBeenCalledOnce();
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
        expectNoNavigation(harness);
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

      await vi.waitFor(() => expect(owner.isSessionResetPending()).toBe(true));
      expect(moduleMocks.showDialog).toHaveBeenCalledWith(
        updateDialog('dialog.sw_update_room_guest_msg'),
      );
      expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBe('123456');
      await vi.waitFor(() => expect(navigations(harness)).toEqual(['href /123456']));
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
      expectNoNavigation(harness);
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
      expect(owner.isSessionResetPending()).toBe(true);
      expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBe('123456');
      await vi.waitFor(() => expect(navigations(harness)).toEqual(['href /123456']));
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
      expectNoNavigation(harness);
    });

    it('keeps update news in this dialog: no chat notice, toast, or peer message', async () => {
      // A hosted room gets update news three ways: a waiting update it puts
      // off, one another tab applies, and an Apply that reloads the room.
      setAppState({ role: 'host', sessionStarted: true, joinCode: '123456' });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      harness.installUpdate('v494').emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      await flushAsyncControllerChange();

      moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
      harness.setController({ postMessage: vi.fn() }, false, 'v495');
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(navigations(harness)).toEqual(['reload']));

      // Only the dialog and the reset screen carried it.
      expect(resetMessage()).toBe('dialog.refreshing_session');
      for (const notice of Object.values(moduleMocks.notices))
        expect(notice).not.toHaveBeenCalled();
    });
  });

  // Phase 3 C6-10: the logo reset's port. The lazy core/sw-hard-reset.ts asks
  // with this event on the page's container and reads the answer synchronously
  // (sw-hard-reset.test.ts drives that side; the transition table drives both
  // on the real navigation owner).
  describe('the logo hard reset port (C6-10)', () => {
    /**
     * The hard reset's request: by default on a page whose loads are quiet.
     * The hard reset measures that itself, leaving out its own chunk
     * (sw-hard-reset.test.ts pins the measurement).
     */
    async function claimForHardReset(
      harness: SwHarness,
      request: HardResetClaimRequest = { quiet: true },
    ): Promise<HardResetClaim | undefined> {
      // The machine keeps its own copy of the event name; this pins it.
      harness.emit(
        HARD_RESET_CLAIM_EVENT,
        new CustomEvent<HardResetClaimRequest>(HARD_RESET_CLAIM_EVENT, { detail: request }),
      );
      return request.claim;
    }

    it('before the window load event answers that there is no machine, on a quiet page only (P3-12 A, P3-9 A)', async () => {
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
      const { registerServiceWorker } = await import('../../sw-register.ts');
      registerServiceWorker();
      expect(harness.register).not.toHaveBeenCalled();

      expect(await claimForHardReset(harness)).toBe('unavailable');
      expect(await claimForHardReset(harness, { quiet: false })).toBe('none');
      // A request that does not say the page is quiet counts as still loading.
      expect(await claimForHardReset(harness, {})).toBe('none');
      expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalledWith({
        type: 'SKIP_WAITING',
      });
    });

    it('promotes a waiting worker through the machine, records the request and asks nothing (P3-8 A)', async () => {
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      expect(await claimForHardReset(harness)).toBe('none');

      const update = harness.installUpdate('v494');
      // Put off with Later in this page: the logo still applies it.
      update.emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      await flushAsyncControllerChange();
      expect(update.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

      expect(await claimForHardReset(harness)).toBe('promoted');
      expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      expect(sessionStorage.getItem('sw-updated-at')).not.toBeNull();
      expect(sessionStorage.getItem('sw-controller-confirmed-at')).toBeNull();
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    });

    it('promotes nothing while the page is still loading (P3-9 A)', async () => {
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      const update = harness.installUpdate('v494');
      update.emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      await flushAsyncControllerChange();

      expect(await claimForHardReset(harness, { quiet: false })).toBe('none');
      expect(await claimForHardReset(harness, {})).toBe('none');
      expect(update.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      expect(sessionStorage.getItem('sw-updated-at')).toBeNull();

      // Once the hard reset reads the page as quiet, the same worker goes.
      expect(await claimForHardReset(harness)).toBe('promoted');
      expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    });

    it('promotes nothing while an update reload is scheduled (a defensive check: the reset surface keeps the page inert then)', async () => {
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      // Another tab's update takes over this idle page: its aligned reload is scheduled.
      harness.setController({ postMessage: vi.fn() });
      harness.emit('controllerchange');
      expect(owner.isSessionResetPending()).toBe(true);
      const confirmedAt = sessionStorage.getItem('sw-controller-confirmed-at');
      expect(confirmedAt).not.toBeNull();

      // A newer worker waits; the machine has not taken it up yet.
      const update = harness.installUpdate('v495');
      expect(await claimForHardReset(harness)).toBe('none');
      expect(update.waitingWorker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      // No request recorded: the reload's markers stand.
      expect(sessionStorage.getItem('sw-controller-confirmed-at')).toBe(confirmedAt);
    });

    it('waits for an Apply in flight instead of sending a second SKIP_WAITING (P3-8 A)', async () => {
      moduleMocks.showDialog.mockResolvedValue({ action: 'ok' });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      const update = harness.installUpdate('v494');
      update.emitInstalled();
      await vi.waitFor(() =>
        expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      );

      expect(await claimForHardReset(harness)).toBe('apply-in-flight');
      const skipWaitingSends = update.waitingWorker.postMessage.mock.calls.filter(
        ([message]) => (message as { type?: unknown }).type === 'SKIP_WAITING',
      );
      expect(skipWaitingSends).toHaveLength(1);
    });

    it('withdraws the update prompt shown or queued, then applies the update without asking (P3-8 A)', async () => {
      const prompt = holdRenderingDialog();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      const update = harness.installUpdate('v494');
      update.emitInstalled();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      const { signal } = moduleMocks.showDialog.mock.calls[0]![0] as { signal: AbortSignal };
      expect(signal.aborted).toBe(false);

      expect(await claimForHardReset(harness)).toBe('promoted');
      expect(signal.aborted).toBe(true);
      prompt.answer('superseded');
      await flushAsyncControllerChange();
      expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    });

    it("asks a room about the logo's activation only once its navigation leaves the page (P3-8 A)", async () => {
      setAppState({ role: 'guest', sessionStarted: true, joinCode: '123456' });
      // The startup prompt closes without an answer (a generation put off with
      // Later in this page would not be asked about again).
      moduleMocks.showDialog.mockResolvedValueOnce({ action: 'superseded' });
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() }, 'navigate', true);
      await registerWithHarness(harness);
      await vi.waitFor(
        () => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(),
        STARTUP_PROMPT_WAIT,
      );
      await flushAsyncControllerChange();

      // The logo reset holds the page and the machine promotes the worker,
      // which activates.
      owner.scheduleSessionReset('dialog.leaving_session', () => window.location.replace('/'));
      expect(await claimForHardReset(harness)).toBe('promoted');
      harness.setController(harness.waitingWorker!, true, 'v494');
      harness.emit('controllerchange');
      await waitMs(PROMPT_ELECTION_SETTLE_MS);
      // No update dialog under the reset screen, no navigation asked for.
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();

      // The navigation does not take the page away: the room is asked once.
      await recoverNavigation(harness, 1);
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledTimes(2));
      expect(moduleMocks.showDialog).toHaveBeenLastCalledWith(
        updateDialog('dialog.sw_update_room_guest_msg'),
      );
      await waitMs(PROMPT_ELECTION_SETTLE_MS);
      expect(moduleMocks.showDialog).toHaveBeenCalledTimes(2);
      expect(navigations(harness)).toEqual(['replace /']);
    });
  });
  /**
   * The forced update (RO-22, train 9.0.14) on a page with no update machine:
   * registerServiceWorker installs the port's handler before its support
   * checks, so a refusal still shows the forced dialog, and Apply reloads.
   */
  describe('the forced update without an update machine (train 9.0.14)', () => {
    it.each([
      {
        name: 'no service worker support',
        setup: () => {
          Reflect.deleteProperty(navigator, 'serviceWorker');
          return { sinks: stubSinks(true), register: null };
        },
      },
      {
        name: 'an insecure context',
        setup: () => {
          const register = vi.fn();
          Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: { controller: null, register, addEventListener: vi.fn() },
          });
          return { sinks: stubSinks(false), register };
        },
      },
    ])(
      'F9 $name: the early handler shows the forced dialog, and Apply reloads in place',
      async ({ setup }) => {
        const { sinks, register } = setup();
        vi.stubGlobal('__MXQR_BUILD_CACHE_VERSION__', 'v785');
        let answer!: (result: { action: string }) => void;
        moduleMocks.showDialog.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        );
        const { registerServiceWorker } = await import('../../sw-register.ts');
        owner = await import('../session-reset.ts');
        loadedOwners.push(owner);
        const port = await import('../app-build.ts');
        registerServiceWorker();

        expect(
          port.requestForcedAppUpdate({ minAppBuild: 786, admitted: false, returnCode: null }),
        ).toBe(true);
        expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
        const options = moduleMocks.showDialog.mock.calls[0]![0] as Record<string, unknown>;
        expect(options).toEqual(forcedUpdateDialog('dialog.sw_update_apply_msg'));
        expect(options).not.toHaveProperty('secondaryText');
        expect(options.dismissible).not.toBe(true);
        expect(port.isForcedAppUpdatePending()).toBe(true);

        answer({ action: 'ok' });
        await vi.waitFor(() => expect(sinks.calls.map((call) => call.op)).toEqual(['reload']));
        expect(sessionStorage.getItem('mxqr-forced-apply')).toBe('785:786');
        expect(sessionStorage.getItem('sw-updated-at')).not.toBeNull();
        expect(sessionStorage.getItem('sw-controller-confirmed-at')).toBeNull();
        if (register) expect(register).not.toHaveBeenCalled();
      },
    );
  });

  /**
   * The start and resume floor check (forced update Inc 7, owner decision
   * 2026-10-25 ~22:00): a page with a build reads the effective App build
   * floor at the window load moment and on every return to the foreground
   * (visibilitychange to visible, pageshow with persisted, online), and below
   * the floor enters the forced update at once (at start, once the page's
   * own loads are quiet). Its read gate allows two starts per minute window,
   * and a read that got an answer or hit its deadline ends the window. The
   * page runs build 785 (__MXQR_BUILD_CACHE_VERSION__ 'v785'); another tab
   * holds the hourly check lease, so every reg.update() counted here is the
   * forced update's.
   */
  describe('the start and resume floor check (forced update Inc 7)', () => {
    const PAGE_BUILD = 'v785';
    /** A synthetic room code. */
    const ROOM_CODE = '000001';
    const FLOOR_T0 = Date.parse('2026-10-26T00:00:00.000Z');

    interface HeldDialog {
      readonly options: Record<string, unknown>;
      outcome: string | undefined;
      answer(action: string): void;
    }

    /** Every dialog stays open until answered, or until its signal withdraws it ('superseded'). */
    function holdDialogs(): HeldDialog[] {
      const held: HeldDialog[] = [];
      moduleMocks.showDialog.mockImplementation(
        (options: Record<string, unknown>) =>
          new Promise((resolve) => {
            const entry: HeldDialog = {
              options,
              outcome: undefined,
              answer(action) {
                if (entry.outcome !== undefined) return;
                entry.outcome = action;
                resolve({ action });
              },
            };
            held.push(entry);
            const signal = options.signal as AbortSignal | undefined;
            if (signal?.aborted) entry.answer('superseded');
            signal?.addEventListener('abort', () => entry.answer('superseded'), { once: true });
          }),
      );
      return held;
    }

    /** Each dialog asked for: 'later' or 'forced', and how it closed. */
    function dialogKinds(held: readonly HeldDialog[]): string[] {
      return held.map(
        (entry) =>
          `${entry.options.secondaryText === undefined ? 'forced' : 'later'}` +
          (entry.outcome === undefined ? '' : ` -> ${entry.outcome}`),
      );
    }

    function setVisibility(state: DocumentVisibilityState, dispatch = true): void {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
      if (dispatch) document.dispatchEvent(new Event('visibilitychange'));
    }

    function setOnline(online: boolean): void {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
    }

    /** A return from the background: hidden, then visible again. */
    function bounce(): void {
      setVisibility('hidden');
      setVisibility('visible');
    }

    function pageshow(persisted: boolean): void {
      actualWindow.dispatchEvent(new PageTransitionEvent('pageshow', { persisted }));
    }

    /** Let a read that already has its answer settle. */
    async function settleReads(): Promise<void> {
      await flushAsyncControllerChange();
      await flushAsyncControllerChange();
    }

    /** The clock moves to the end of the current read window. */
    function pastWindow(): void {
      vi.setSystemTime(Date.now() + APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS);
    }

    async function livePort(): Promise<typeof import('../app-build.ts')> {
      return import('../app-build.ts');
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: FLOOR_T0 });
      vi.stubGlobal('__MXQR_BUILD_CACHE_VERSION__', PAGE_BUILD);
      setVisibility('visible', false);
      setOnline(true);
      localStorage.setItem(
        'mxqr-sw-update-check-lease-v1',
        JSON.stringify({
          owner: 'client:another-tab',
          updatedAt: Date.now(),
          expiresAt: Date.now() + 3_600_000,
        }),
      );
    });

    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(document, 'visibilityState');
      Reflect.deleteProperty(navigator, 'onLine');
    });

    it('C18 the default: a loaded, visible document with a build reads the floor exactly once at load, gets 0 and shows nothing', async () => {
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      expect(floorReads.reads()).toBe(1);
      expect(floorReads.requests[0]).toMatchObject({
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      await waitMs(STARTUP_PROMPT_QUIET_MS + 500);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
      expect(harness.update).not.toHaveBeenCalled();
      expect(floorReads.reads()).toBe(1);
    });

    it('C1 at load, visible and online: exactly one read; a floor above this build shows the forced dialog once the loads are quiet, and asks for the update once', async () => {
      holdDialogs();
      floorReads.answer(786);
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      expect(floorReads.reads()).toBe(1);
      await waitMs(STARTUP_PROMPT_QUIET_MS - 400);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();

      await vi.waitFor(
        () => expect(moduleMocks.showDialog).toHaveBeenCalledOnce(),
        STARTUP_PROMPT_WAIT,
      );
      const options = moduleMocks.showDialog.mock.calls[0]![0] as Record<string, unknown>;
      expect(options).toEqual(forcedUpdateDialog('dialog.sw_update_apply_msg'));
      expect(options).not.toHaveProperty('secondaryText');
      expect(harness.update).toHaveBeenCalledOnce();
      expect(floorReads.reads()).toBe(1);
      expect((await livePort()).isForcedAppUpdatePending()).toBe(true);
    });

    it('C2 hidden at load: no read; the first visible return reads once', async () => {
      setVisibility('hidden', false);
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      expect(floorReads.reads()).toBe(0);

      setVisibility('visible');
      expect(floorReads.reads()).toBe(1);
      await settleReads();
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    });

    it('C3 ten returns inside the window read nothing more; one return after it reads once', async () => {
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await settleReads();
      expect(floorReads.reads()).toBe(1);

      for (let flip = 0; flip < 10; flip += 1) {
        bounce();
        await settleReads();
      }
      expect(floorReads.reads()).toBe(1);

      pastWindow();
      bounce();
      await settleReads();
      expect(floorReads.reads()).toBe(2);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    });

    it('C4 pageshow with persisted on the same return as visibilitychange reads once; a pageshow without persisted reads nothing, and one with persisted alone reads', async () => {
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await settleReads();
      expect(floorReads.reads()).toBe(1);

      pastWindow();
      setVisibility('hidden');
      setVisibility('visible');
      pageshow(true);
      await settleReads();
      expect(floorReads.reads()).toBe(2);

      pastWindow();
      pageshow(false);
      await settleReads();
      expect(floorReads.reads()).toBe(2);
      pageshow(true);
      await settleReads();
      expect(floorReads.reads()).toBe(3);
    });

    it('C5 offline at a return: no read and the gate is untouched; coming back online reads once', async () => {
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await settleReads();
      expect(floorReads.reads()).toBe(1);

      pastWindow();
      setOnline(false);
      // Three offline returns: had they claimed the gate, its two starts would be gone.
      for (let flip = 0; flip < 3; flip += 1) {
        bounce();
        await settleReads();
      }
      expect(floorReads.reads()).toBe(1);

      setOnline(true);
      actualWindow.dispatchEvent(new Event('online'));
      await settleReads();
      expect(floorReads.reads()).toBe(2);
    });

    it.each([
      { name: 'a 500', answer: { status: 500, body: '{}' }, spent: true },
      { name: 'a malformed body', answer: { status: 200, body: 'not json' }, spent: true },
      { name: 'no answer (the read deadline)', answer: 'no-answer' as const, spent: true },
      { name: 'a network error', answer: 'network-error' as const, spent: false },
    ])(
      'C6 $name: no dialog, no toast and no read without a trigger; a return within the minute reads again only when the read was released',
      async ({ answer, spent }) => {
        vi.useFakeTimers({
          now: FLOOR_T0,
          toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        floorReads.answer(answer);
        const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
        await registerWithHarness(harness);
        expect(floorReads.reads()).toBe(1);
        await vi.advanceTimersByTimeAsync(APP_BUILD_FLOOR_READ_TIMEOUT_MS);

        bounce();
        await vi.advanceTimersByTimeAsync(APP_BUILD_FLOOR_READ_TIMEOUT_MS);
        expect(floorReads.reads()).toBe(spent ? 1 : 2);
        // Two starts per window: a second released read leaves none.
        bounce();
        await vi.advanceTimersByTimeAsync(APP_BUILD_FLOOR_READ_TIMEOUT_MS);
        expect(floorReads.reads()).toBe(spent ? 1 : 2);

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(floorReads.reads()).toBe(spent ? 1 : 2);
        expect(moduleMocks.showDialog).not.toHaveBeenCalled();
        expect(harness.update).not.toHaveBeenCalled();
      },
    );

    it.each([785, 0])('C7 a floor of %i: no dialog and no update check', async (floor) => {
      floorReads.answer(floor);
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await waitMs(STARTUP_PROMPT_QUIET_MS + 500);
      pastWindow();
      bounce();
      await settleReads();
      expect(floorReads.reads()).toBe(2);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
      expect(harness.update).not.toHaveBeenCalled();
    });

    it('C8 a return reads 786 while the ordinary prompt with Later is open: it is withdrawn and the same worker is offered without Later', async () => {
      const held = holdDialogs();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await settleReads();
      const update = harness.installUpdate('v786');
      update.emitInstalled();
      await vi.waitFor(() => expect(dialogKinds(held)).toEqual(['later']));

      pastWindow();
      floorReads.answer(786);
      bounce();
      await vi.waitFor(() => expect(dialogKinds(held)).toEqual(['later -> superseded', 'forced']));
      expect(held[1]!.options).toEqual(forcedUpdateDialog('dialog.sw_update_apply_msg'));

      held[1]!.answer('ok');
      await vi.waitFor(() =>
        expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      );
      expect(sessionStorage.getItem('mxqr-forced-apply')).toBe('785:786');
    });

    it('C9 the forced dialog already open: a return reads nothing', async () => {
      holdDialogs();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await settleReads();
      const port = await livePort();
      expect(
        port.requestForcedAppUpdate({ minAppBuild: 786, admitted: false, returnCode: null }),
      ).toBe(true);

      pastWindow();
      bounce();
      pageshow(true);
      actualWindow.dispatchEvent(new Event('online'));
      await settleReads();
      expect(floorReads.reads()).toBe(1);
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    });

    it('C9 an Apply waiting for its activation (an update on its way): a return reads nothing', async () => {
      const held = holdDialogs();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await settleReads();
      const update = harness.installUpdate('v786');
      update.emitInstalled();
      await vi.waitFor(() => expect(held).toHaveLength(1));
      held[0]!.answer('ok');
      await vi.waitFor(() =>
        expect(update.waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
      );

      pastWindow();
      bounce();
      await settleReads();
      expect(floorReads.reads()).toBe(1);
    });

    it('C9 the machine has scheduled its update reload: a return reads nothing', async () => {
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await settleReads();
      harness.setController({ postMessage: vi.fn() });
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(owner.isSessionResetPending()).toBe(true));

      pastWindow();
      bounce();
      await settleReads();
      expect(floorReads.reads()).toBe(1);
    });

    it('C10 the lineage key of this build at that floor: a read of 786 shows nothing and asks for no update', async () => {
      sessionStorage.setItem('mxqr-forced-apply', '785:786');
      floorReads.answer(786);
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await waitMs(STARTUP_PROMPT_QUIET_MS + 500);
      pastWindow();
      bounce();
      await settleReads();
      expect(floorReads.reads()).toBe(2);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
      expect(harness.update).not.toHaveBeenCalled();
    });

    it("C10 a refusal's higher floor stored (785:787): the clamped read of 786 shows nothing; a read of 788 shows the forced dialog once", async () => {
      holdDialogs();
      sessionStorage.setItem('mxqr-forced-apply', '785:787');
      floorReads.answer(786);
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await waitMs(STARTUP_PROMPT_QUIET_MS + 500);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();

      pastWindow();
      floorReads.answer(788);
      bounce();
      await vi.waitFor(() => expect(moduleMocks.showDialog).toHaveBeenCalledOnce());
      expect(harness.update).toHaveBeenCalledOnce();
      pastWindow();
      bounce();
      await settleReads();
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
    });

    it('C11 no build (no define, as in every other unit test): no read on any trigger', async () => {
      vi.stubGlobal('__MXQR_BUILD_CACHE_VERSION__', undefined);
      floorReads.answer(786);
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      pastWindow();
      bounce();
      pageshow(true);
      actualWindow.dispatchEvent(new Event('online'));
      await waitMs(STARTUP_PROMPT_QUIET_MS + 500);
      expect(floorReads.reads()).toBe(0);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: 'no service worker support',
        setup: () => {
          Reflect.deleteProperty(navigator, 'serviceWorker');
          return stubSinks(true);
        },
      },
      {
        name: 'an insecure context',
        setup: () => {
          Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: { controller: null, register: vi.fn(), addEventListener: vi.fn() },
          });
          return stubSinks(false);
        },
      },
    ])(
      'C12 $name: the check still reads at load, and the early handler shows the forced dialog without a worker; Apply reloads',
      async ({ setup }) => {
        const sinks = setup();
        Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
        floorReads.answer(786);
        const held = holdDialogs();
        const { registerServiceWorker } = await import('../../sw-register.ts');
        owner = await import('../session-reset.ts');
        loadedOwners.push(owner);
        registerServiceWorker();
        expect(floorReads.reads()).toBe(1);

        await vi.waitFor(() => expect(dialogKinds(held)).toEqual(['forced']), STARTUP_PROMPT_WAIT);
        expect(held[0]!.options).toEqual(forcedUpdateDialog('dialog.sw_update_apply_msg'));
        held[0]!.answer('ok');
        await vi.waitFor(() => expect(sinks.calls.map((call) => call.op)).toEqual(['reload']));
        expect(sessionStorage.getItem('mxqr-forced-apply')).toBe('785:786');
      },
    );

    it.each([
      {
        name: 'a Standard host in an open room: the host message, and Apply reloads in place',
        state: { role: 'host', sessionStarted: true, roomId: ROOM_CODE, joinCode: ROOM_CODE },
        message: 'dialog.sw_update_room_host_msg',
        navigation: 'reload',
      },
      {
        name: "a guest in a room: the room message, and Apply returns to the room's /CODE",
        state: { role: 'guest', sessionStarted: true, roomId: ROOM_CODE, joinCode: ROOM_CODE },
        message: 'dialog.sw_update_room_guest_msg',
        navigation: `href /${ROOM_CODE}`,
      },
    ])('C13 $name', async ({ state, message, navigation }) => {
      setAppState(state);
      const held = holdDialogs();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await settleReads();

      pastWindow();
      floorReads.answer(786);
      bounce();
      await vi.waitFor(() => expect(dialogKinds(held)).toEqual(['forced']));
      expect(held[0]!.options).toEqual(forcedUpdateDialog(message));
      held[0]!.answer('ok');
      await vi.waitFor(() => expect(navigations(harness)).toEqual([navigation]));
    });

    it('C14 a refusal arrives while the start check waits for quiet loads: one dialog', async () => {
      holdDialogs();
      floorReads.answer(786);
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      await settleReads();
      expect(floorReads.reads()).toBe(1);
      const port = await livePort();
      expect(
        port.requestForcedAppUpdate({ minAppBuild: 786, admitted: false, returnCode: null }),
      ).toBe(true);
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
      await waitMs(STARTUP_PROMPT_QUIET_MS + 500);
      expect(moduleMocks.showDialog).toHaveBeenCalledOnce();
      expect(harness.update).toHaveBeenCalledOnce();
    });

    it('C15 the page goes hidden with a read in flight: the read is abandoned with no dialog and the gate released; the next return reads once', async () => {
      floorReads.hold();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      expect(floorReads.reads()).toBe(1);

      setVisibility('hidden');
      expect(floorReads.requests[0]!.signal?.aborted).toBe(true);
      await settleReads();
      floorReads.release(786);
      await settleReads();
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();

      floorReads.answer(0);
      setVisibility('visible');
      await settleReads();
      expect(floorReads.reads()).toBe(2);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    });

    it('C16 a hide abandons a second read in the same minute: the third return in that minute reads nothing', async () => {
      floorReads.hold();
      const harness = installServiceWorkerHarness({ postMessage: vi.fn() });
      await registerWithHarness(harness);
      setVisibility('hidden');
      await settleReads();
      setVisibility('visible');
      expect(floorReads.reads()).toBe(2);
      setVisibility('hidden');
      await settleReads();
      setVisibility('visible');
      await settleReads();
      expect(floorReads.reads()).toBe(2);

      pastWindow();
      floorReads.release(0);
      bounce();
      await settleReads();
      expect(floorReads.reads()).toBe(3);
      expect(moduleMocks.showDialog).not.toHaveBeenCalled();
    });

    it('C17 the activated-elsewhere offer is open in a room: a return reading 786 withdraws it; the forced dialog is the only open one, and Apply makes the aligned reload', async () => {
      setAppState({ role: 'guest', sessionStarted: true, roomId: ROOM_CODE, joinCode: ROOM_CODE });
      const held = holdDialogs();
      const controller: FakeWorker = { postMessage: vi.fn() };
      const harness = installServiceWorkerHarness(controller);
      await registerWithHarness(harness);
      await settleReads();
      harness.setController({ postMessage: vi.fn() });
      harness.emit('controllerchange');
      await vi.waitFor(() => expect(dialogKinds(held)).toEqual(['later']));

      pastWindow();
      floorReads.answer(786);
      bounce();
      await vi.waitFor(() => expect(dialogKinds(held)).toEqual(['later -> superseded', 'forced']));
      expect(held[1]!.options).toEqual(forcedUpdateDialog('dialog.sw_update_room_guest_msg'));

      held[1]!.answer('ok');
      await vi.waitFor(() => expect(navigations(harness)).toEqual([`href /${ROOM_CODE}`]));
      expect(harness.update).not.toHaveBeenCalled();
      expect(harness.waitingWorker).toBeNull();
    });
  });
});
