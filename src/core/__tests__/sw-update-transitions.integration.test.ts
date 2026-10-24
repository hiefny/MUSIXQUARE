/**
 * @vitest-environment jsdom
 *
 * The service-worker update machine (src/sw-register.ts, registry RO-22) on
 * the real page navigation owner (src/core/session-reset.ts, RO-23): its
 * transition table (Phase 3, C6-9 increment 1, tests only on unchanged code),
 * and the stuck-Apply-then-logo characterization (C6-9 increment 2, the input
 * of C6-10 / P3-10).
 *
 * Real: sw-register.ts with sw-update-coordination.ts and sw-prompt-lock.ts;
 * session-reset.ts with document-reload.ts and page-lifecycle.ts, wired once
 * per document with initPageNavigation as app.ts wires it; navigation.ts; the
 * lazy sw-hard-reset.ts with sw-update-completion.ts. Replaced: the browser's
 * service-worker registration (one model shared by every document of the tab,
 * see "Service-worker registration" below), the location sinks (recorded no-op
 * navigations, __helpers__/navigation-sinks.ts), the clock (fake timers, so
 * frames are 16 ms and the reset paints after two), the update dialog (open
 * until a test answers it), app state, room authority, i18n (keys) and the
 * hourly update-check timer.
 *
 * The logo request below is a copy of the one in src/ui/player-controls.ts
 * (handleLogoReturnToMain), as in __helpers__/page-navigation-harness.ts;
 * page-navigation-harness-parity.test.ts pins that source and both copies, so
 * a change there updates both copies.
 *
 * How to read a row: `from` is the machine state before the event, `then` the
 * state the event leaves, and `effects` everything the row observed, from the
 * first step to the last: every SKIP_WAITING with the document that sent it
 * and its worker, every navigation the page asked for (sink calls; "reload
 * (threw)" is a reload sink that threw), every update dialog, and the
 * next-document markers (timestamps as milliseconds after the row started,
 * t+0). The states are those of `activationState` in sw-register.ts. "latched"
 * means the update reload is still scheduled while the prompt has left the
 * named phase: on main 08003954 the module reload latch (_swReloading) under
 * that state, since C6-9 the `prompt` of the one 'reload-scheduled' state.
 *
 * The machine's state is private to sw-register.ts, so `then` is not read: a
 * row checks it only through a later step that behaves differently in that
 * state, such as the probe steps of S1b and S2b, and rows X12b to X19, which
 * send the next event while the reload is still latched. Where a row has no
 * such step, its `then` is the reading of the code, not a checked outcome.
 * Rows labelled "[keeps: C6-9]" have the same effects on main 08003954 and
 * after C6-9 replaced the latch with the typed state.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  NAVIGATION_COMMIT_TIMEOUT_MS,
  NAVIGATION_PREPARE_TIMEOUT_MS,
} from '../navigation-contract.ts';
import { stubNavigationSinks, type NavigationSinks } from './__helpers__/navigation-sinks.ts';

// ─── App state, dialogs and module mocks ─────────────────────────────

interface AppModel {
  role: 'idle' | 'host' | 'guest';
  sessionStarted: boolean;
  roomId: string | null;
  joinCode: string;
}

interface OpenDialog {
  readonly doc: number;
  readonly message: string;
  /** How it closed: the answer, or 'superseded' when the machine withdrew it. */
  readonly outcome: string | undefined;
  answer(action: 'ok' | 'secondary'): void;
}

const mocks = vi.hoisted(() => {
  const app = { role: 'idle', sessionStarted: false, roomId: null, joinCode: '' } as {
    role: string;
    sessionStarted: boolean;
    roomId: string | null;
    joinCode: string;
  };
  const dialogs: Array<{
    doc: number;
    message: string;
    outcome: string | undefined;
    answer(action: string): void;
  }> = [];
  const page = { doc: 0 };
  return {
    app,
    dialogs,
    page,
    getState(key: string): unknown {
      if (key === 'network.appRole') return app.role;
      if (key === 'network.lastJoinCode') return app.joinCode;
      if (key === 'setup.sessionStarted') return app.sessionStarted;
      if (key === 'demo.active' || key === 'demo.loading') return false;
      return undefined;
    },
    /** The update dialog: open until answered, or until its signal aborts it. */
    showDialog(options: {
      message: string | (() => string);
      signal?: AbortSignal;
    }): Promise<{ action: string }> {
      return new Promise((resolve) => {
        const message = typeof options.message === 'function' ? options.message() : options.message;
        const entry = {
          doc: page.doc,
          message,
          outcome: undefined as string | undefined,
          answer: (action: string): void => finish(action),
        };
        const finish = (action: string): void => {
          if (entry.outcome !== undefined) return;
          entry.outcome = action;
          resolve({ action });
        };
        dialogs.push(entry);
        if (options.signal?.aborted) finish('superseded');
        options.signal?.addEventListener('abort', () => finish('superseded'), { once: true });
      });
    },
  };
});

vi.mock('../log.ts', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../state.ts', () => ({ getState: (key: string) => mocks.getState(key) }));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../ui/dialog.ts', () => ({
  showDialog: (options: { message: string | (() => string); signal?: AbortSignal }) =>
    mocks.showDialog(options),
}));
vi.mock('../timers.ts', () => ({ setManagedTimer: vi.fn() }));
vi.mock('../../rooms/authority.ts', () => ({
  getRoomContext: () => ({ kind: 'standard', roomId: mocks.app.roomId }),
  isStandardRoomRole: (role: string) => mocks.app.role === role,
  subscribeRoomAuthorityLifecycle: () => () => undefined,
}));

const MSG_REFRESHING = 'dialog.refreshing_session';
const MSG_LEAVING = 'dialog.leaving_session';
const MSG_APPLY = 'dialog.sw_update_apply_msg';
const MSG_GUEST = 'dialog.sw_update_room_guest_msg';
const MSG_HOST = 'dialog.sw_update_room_host_msg';
/** A synthetic room code. */
const ROOM_CODE = '000001';
const OUTSIDE: AppModel = { role: 'idle', sessionStarted: false, roomId: null, joinCode: '' };
const ROOM_GUEST: AppModel = {
  role: 'guest',
  sessionStarted: true,
  roomId: ROOM_CODE,
  joinCode: ROOM_CODE,
};
const ROOM_HOST: AppModel = {
  role: 'host',
  sessionStarted: true,
  roomId: ROOM_CODE,
  joinCode: ROOM_CODE,
};

/** The fake clock's start; every row runs from t+0. */
const T0 = Date.parse('2026-10-24T00:00:00.000Z');
/** Long enough for the reset to paint and run its navigation (two 16 ms frames). */
const PAINT_MS = 100;
/** The prompt election without Web Locks settles for 50 ms. */
const PROMPT_MS = 100;
/** The navigation owner recovers a navigation that has not committed by then. */
const COMMIT_DEADLINE_MS = NAVIGATION_COMMIT_TIMEOUT_MS;

const actualWindow = globalThis.window;

// ─── Service-worker registration ─────────────────────────────────────
// Models one tab's view of the origin's registration: the active worker
// (controller), one waiting worker and an installing one, shared by every
// document the tab loads. Each document gets its own container and
// registration objects with their own listeners, as a browser gives each
// document its own ServiceWorkerContainer. A worker answers the generation
// request (MXQR_SW_GENERATION_REQUEST) with its cache version at once, as the
// worker in browser/service-worker.ts does; `silent` models a pre-protocol
// worker that never answers. SKIP_WAITING is recorded and activates nothing:
// a test activates the waiting worker with `activate()` when the row says the
// browser did, so a stalled activation (Chromium took 43-66 s while the page
// was loading, 2026-10-17) is a row that never calls it. Leaves out the
// worker's own install and activate events, clients.claim() timing and the
// cache-status protocol (answered by nothing here).

interface FakeWorker {
  readonly version: string;
  readonly scriptURL: string;
  state: ServiceWorkerState;
  readonly postMessage: Mock<(message: unknown) => void>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

type Listener = (event: unknown) => void;

interface PageDocument {
  readonly index: number;
  readonly owner: typeof import('../session-reset.ts');
  /** Another navigation holds the page: a direct reset that leaves for home. */
  leave(): void;
  /** The logo reset, as player-controls.ts asks for it. */
  logoReset(): void;
  pagehide(persisted?: boolean): void;
  pageshow(persisted?: boolean): void;
  visible(): void;
  /** The window load event of a document opened with `loaded: false`. */
  load(): Promise<void>;
}

interface Tab {
  readonly sinks: NavigationSinks;
  readonly skipWaiting: string[];
  readonly controller: FakeWorker | null;
  readonly waiting: FakeWorker | null;
  /**
   * Open a document in this tab; the previous one is gone without running
   * anything more. `build` is the cache generation of the code the document
   * runs (a production build's __MXQR_BUILD_CACHE_VERSION__); unknown if left
   * out, as in every other test build.
   */
  open(options: {
    app?: AppModel;
    navigation?: NavigationTimingType;
    build?: string;
    /** false: the window load event has not fired yet, so registration waits for it. */
    loaded?: boolean;
  }): Promise<PageDocument>;
  /** One of the live document's resources finishes loading now (a resource timing entry). */
  finishResource(): void;
  /** Close the tab's live document the same way. */
  close(): void;
  /** A newer worker installs and waits. */
  install(version: string, options?: { silent?: boolean }): FakeWorker;
  /** The waiting worker activates and takes control (this tab's SKIP_WAITING, or another tab's). */
  activate(): void;
  /** Another tab applied `version`: a worker this document never saw takes control. */
  replaceController(version: string, options?: { silent?: boolean }): FakeWorker;
  /** The registration is gone: the page has no controller any more. */
  dropController(): void;
  /** The next reload sink call throws. */
  failNextReload(): void;
  navigations(): string[];
}

function createTab(activeVersion: string): Tab {
  let liveDoc = 0;
  const containerListeners = new Map<number, Map<string, Set<Listener>>>();
  const registrationListeners = new Map<number, Map<string, Set<Listener>>>();
  const docSinkStart = new Map<number, number>();
  const skipWaiting: string[] = [];
  let controller: FakeWorker | null = null;
  let waiting: FakeWorker | null = null;
  let installing: FakeWorker | null = null;
  let closeLiveDocument: (() => void) | null = null;
  // The live document's resource timing: when each of its resources finished.
  const resourceEnds: number[] = [];

  const emit = (map: Map<number, Map<string, Set<Listener>>>, type: string, event: unknown) => {
    for (const listener of [...(map.get(liveDoc)?.get(type) ?? [])]) listener(event);
  };
  const listen = (map: Map<number, Map<string, Set<Listener>>>, doc: number) => ({
    add(type: string, listener: Listener) {
      const byType = map.get(doc) ?? new Map<string, Set<Listener>>();
      map.set(doc, byType);
      const set = byType.get(type) ?? new Set<Listener>();
      byType.set(type, set);
      set.add(listener);
    },
    remove(type: string, listener: Listener) {
      map.get(doc)?.get(type)?.delete(listener);
    },
  });

  const stateListeners = new WeakMap<FakeWorker, Set<() => void>>();
  const fireStateChange = (worker: FakeWorker): void => {
    for (const listener of [...(stateListeners.get(worker) ?? [])]) listener();
  };
  const createWorker = (version: string, state: ServiceWorkerState, silent = false): FakeWorker => {
    const listeners = new Set<() => void>();
    const worker: FakeWorker = {
      version,
      scriptURL: 'https://musixquare.com/service-worker.js',
      state,
      postMessage: vi.fn((message: unknown) => {
        const data = message as { type?: unknown; requestId?: unknown } | null;
        if (data?.type === 'SKIP_WAITING') {
          skipWaiting.push(`doc${liveDoc} → ${version}`);
          return;
        }
        if (data?.type === 'MXQR_SW_GENERATION_REQUEST' && !silent) {
          emit(containerListeners, 'message', {
            data: {
              type: 'MXQR_SW_GENERATION_RESPONSE',
              requestId: data.requestId,
              cacheVersion: version,
            },
            source: worker,
          });
        }
      }),
      addEventListener(type, listener) {
        if (type === 'statechange') listeners.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === 'statechange') listeners.delete(listener);
      },
    };
    stateListeners.set(worker, listeners);
    return worker;
  };

  controller = createWorker(activeVersion, 'activated');
  const listeners: TrackedListener[] = [];
  const sinks = stubSecureNavigationSinks(listeners);
  for (const target of [document, globalThis] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      listeners.push({ target, type, listener, options });
      add(type, listener, options);
    });
  }

  const tab: Tab = {
    sinks,
    skipWaiting,
    get controller() {
      return controller;
    },
    get waiting() {
      return waiting;
    },
    async open({ app = OUTSIDE, navigation = 'navigate', build, loaded = true }) {
      closeLiveDocument?.();
      vi.resetModules();
      vi.stubGlobal('__MXQR_BUILD_CACHE_VERSION__', build);
      resourceEnds.length = 0;
      liveDoc += 1;
      const doc = liveDoc;
      mocks.page.doc = doc;
      Object.assign(mocks.app, app);
      docSinkStart.set(doc, sinks.calls.length);
      document.body.innerHTML = '';
      document.documentElement.lang = 'en';
      setVisibility('visible', false);

      const container = listen(containerListeners, doc);
      const registrationEvents = listen(registrationListeners, doc);
      const registration = {
        scope: 'https://musixquare.com/',
        get installing() {
          return installing;
        },
        get waiting() {
          return waiting;
        },
        update: vi.fn(async () => undefined),
        addEventListener: registrationEvents.add,
      };
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          get controller() {
            return controller;
          },
          register: vi.fn(async () => registration),
          getRegistration: vi.fn(async () => registration),
          addEventListener: container.add,
          removeEventListener: container.remove,
          // The hard reset's port (HARD_RESET_CLAIM_EVENT) is an event the
          // page dispatches on its own container.
          dispatchEvent: (event: Event) => {
            emit(containerListeners, event.type, event);
            return true;
          },
        },
      });
      vi.stubGlobal('performance', {
        now: () => Date.now() - T0,
        getEntriesByType: (type: string) =>
          type === 'navigation'
            ? [{ type: navigation }]
            : type === 'resource'
              ? resourceEnds.map((responseEnd) => ({ responseEnd }))
              : [],
      });

      // Every listener this document adds on the window or the document goes
      // when the tab opens the next one, as an unloaded document's do.
      const firstListener = listeners.length;

      Object.defineProperty(document, 'readyState', {
        configurable: true,
        value: loaded ? 'complete' : 'loading',
      });
      const owner = await import('../session-reset.ts');
      const navigationIntents = await import('../navigation.ts');
      const hardResetModule = await import('../sw-hard-reset.ts');
      const { registerServiceWorker } = await import('../../sw-register.ts');
      // app.ts:1301-1324: the navigation owner's back-forward cache recovery.
      owner.initPageNavigation({
        getRole: () => mocks.app.role,
        bfcacheReloadMessage: () => MSG_REFRESHING,
        log: { info: () => undefined },
      });
      registerServiceWorker();
      await vi.advanceTimersByTimeAsync(0);

      closeLiveDocument = () => {
        closeLiveDocument = null;
        for (const { target, type, listener, options } of listeners.splice(firstListener)) {
          target.removeEventListener(type, listener, options);
        }
        // Its timers (the reset's paint and commit deadline, the hard reset's
        // activation wait) die with it. Clearing them also rewinds the fake
        // clock to its start, so the time is put back.
        const now = Date.now();
        vi.clearAllTimers();
        vi.setSystemTime(now);
        document.body.innerHTML = '';
        document.documentElement.className = '';
      };

      const dispatch = (type: 'pagehide' | 'pageshow', persisted: boolean) =>
        actualWindow.dispatchEvent(new PageTransitionEvent(type, { persisted }));
      return {
        index: doc,
        owner,
        leave() {
          owner.scheduleSessionReset(MSG_LEAVING, () => navigationIntents.navigateToAppHome());
        },
        logoReset() {
          // src/ui/player-controls.ts handleLogoReturnToMain, after its
          // "return home?" question; page-navigation-harness-parity.test.ts
          // pins this copy. The chunk is preloaded for this document.
          const loadHardReset = () => Promise.resolve(hardResetModule);
          owner.scheduleSessionReset(MSG_LEAVING, {
            async prepare(signal) {
              const hardReset = await loadHardReset();
              if (!signal.aborted) await hardReset.default(signal);
            },
            navigate: () => navigationIntents.navigateToAppHome(),
          });
        },
        pagehide(persisted = false) {
          dispatch('pagehide', persisted);
          setVisibility('hidden');
        },
        pageshow(persisted = false) {
          setVisibility('visible', false);
          dispatch('pageshow', persisted);
        },
        visible() {
          setVisibility('visible');
        },
        async load() {
          Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
          actualWindow.dispatchEvent(new Event('load'));
          await vi.advanceTimersByTimeAsync(0);
        },
      };
    },
    close() {
      closeLiveDocument?.();
    },
    finishResource() {
      resourceEnds.push(Date.now() - T0);
    },
    install(version, { silent = false } = {}) {
      const worker = createWorker(version, 'installing', silent);
      installing = worker;
      emit(registrationListeners, 'updatefound', {});
      const previous = waiting;
      worker.state = 'installed';
      installing = null;
      waiting = worker;
      if (previous) {
        previous.state = 'redundant';
        fireStateChange(previous);
      }
      fireStateChange(worker);
      return worker;
    },
    activate() {
      const next = waiting;
      if (!next) throw new Error('no waiting worker to activate');
      if (controller) {
        controller.state = 'redundant';
      }
      next.state = 'activated';
      waiting = null;
      controller = next;
      fireStateChange(next);
      emit(containerListeners, 'controllerchange', {});
    },
    replaceController(version, { silent = false } = {}) {
      const next = createWorker(version, 'activated', silent);
      if (waiting?.version === version) waiting = null;
      controller = next;
      emit(containerListeners, 'controllerchange', {});
      return next;
    },
    dropController() {
      controller = null;
      emit(containerListeners, 'controllerchange', {});
    },
    failNextReload() {
      const record = sinks.reload.getMockImplementation();
      sinks.reload.mockImplementationOnce(() => {
        record?.();
        failedReloads.add(sinks.calls.length - 1);
        throw new Error('reload failed');
      });
    },
    navigations() {
      return sinks.calls.map((call, index) => {
        let doc = 1;
        for (const [candidate, start] of docSinkStart) if (index >= start) doc = candidate;
        const target = call.url === null ? '' : ` ${call.url}`;
        return `doc${doc} ${call.op}${target}${failedReloads.has(index) ? ' (threw)' : ''}`;
      });
    },
  };
  const failedReloads = new Set<number>();
  return tab;
}

interface TrackedListener {
  readonly target: EventTarget;
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}

/**
 * The recorded location sinks on a window that reports a secure context and
 * records the listeners a document adds, so the tab can remove them.
 */
function stubSecureNavigationSinks(listeners: TrackedListener[]): NavigationSinks {
  const sinks = stubNavigationSinks();
  const sinkWindow = globalThis.window;
  const addWindowListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void => {
    const target: EventTarget = actualWindow;
    listeners.push({ target, type, listener, options });
    target.addEventListener(type, listener, options);
  };
  vi.stubGlobal(
    'window',
    new Proxy({} as Window, {
      get(_target, property) {
        if (property === 'isSecureContext') return true;
        if (property === 'addEventListener') return addWindowListener;
        return Reflect.get(sinkWindow, property) as unknown;
      },
    }),
  );
  return sinks;
}

function setVisibility(state: DocumentVisibilityState, dispatch = true): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  if (dispatch) document.dispatchEvent(new Event('visibilitychange'));
}

// ─── Rows ────────────────────────────────────────────────────────────

/**
 * The next-document markers, by their literal keys: a version N page writes
 * what version N+1 reads, so the keys and the moments they are written stay
 * byte-identical (core/navigation-contract.ts).
 */
type MarkerKey =
  'sw-updated-at' | 'sw-controller-confirmed-at' | 'mxqr_reconnect_target' | 'mxqr-swu';

interface Effects {
  readonly skipWaiting: readonly string[];
  readonly navigations: readonly string[];
  readonly dialogs: readonly string[];
  readonly markers: Readonly<Record<MarkerKey, string | null>>;
}

function readMarkers(): Effects['markers'] {
  const read = (key: MarkerKey): string | null => {
    const value = sessionStorage.getItem(key);
    if (value === null || key === 'mxqr_reconnect_target' || key === 'mxqr-swu') return value;
    const offset = Number(value) - T0;
    return offset >= 0 ? `t+${offset}` : `t${offset}`;
  };
  return {
    'sw-updated-at': read('sw-updated-at'),
    'sw-controller-confirmed-at': read('sw-controller-confirmed-at'),
    mxqr_reconnect_target: read('mxqr_reconnect_target'),
    'mxqr-swu': read('mxqr-swu'),
  };
}

function observe(tab: Tab): Effects {
  return {
    skipWaiting: [...tab.skipWaiting],
    navigations: tab.navigations(),
    dialogs: mocks.dialogs.map((dialog) => `doc${dialog.doc} ${dialog.message}`),
    markers: readMarkers(),
  };
}

const NO_MARKERS: Effects['markers'] = {
  'sw-updated-at': null,
  'sw-controller-confirmed-at': null,
  mxqr_reconnect_target: null,
  'mxqr-swu': null,
};

/** Advance the fake clock to `ms` after the row's start. */
async function at(ms: number): Promise<void> {
  const now = Date.now() - T0;
  if (ms < now) throw new Error(`t+${ms} is in the past (now t+${now})`);
  await vi.advanceTimersByTimeAsync(ms - now);
}

function dialog(index: number): OpenDialog {
  const found = mocks.dialogs[index];
  if (!found) throw new Error(`no dialog #${index}`);
  return found as OpenDialog;
}

/**
 * sessionStorage denied, as in some private or embedded contexts: every read
 * and write throws. Returns the undo.
 */
function denySessionStorage(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const denied = (): never => {
    throw new DOMException('denied', 'SecurityError');
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: denied, setItem: denied, removeItem: denied },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  };
}

/** Another tab now owns the update prompt for `version`. */
function foreignPromptLease(version: string): void {
  const key = 'mxqr-sw-update-prompt-lease-v1';
  localStorage.setItem(
    key,
    JSON.stringify({
      identity: version,
      owner: 'client:another-tab',
      updatedAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    }),
  );
  globalThis.dispatchEvent(new StorageEvent('storage', { key }));
}

type State =
  | 'passive'
  | 'prompting'
  | 'awaiting-local-controller'
  | 'reload-scheduled'
  | 'passive, latched'
  | 'awaiting-local-controller, latched';

interface Row {
  readonly id: string;
  readonly from: State | 'none';
  readonly event: string;
  readonly then: State;
  readonly label: string;
  readonly run: (tab: Tab) => Promise<void>;
  readonly effects: Effects;
}

/** An idle page outside a room whose controller another tab replaced: reload-scheduled. */
async function scheduleOutsideReload(tab: Tab): Promise<PageDocument> {
  const page = await tab.open({ app: OUTSIDE });
  tab.replaceController('v494');
  await at(PAINT_MS);
  return page;
}

/**
 * A hosted room answers Apply on another tab's update while its own prompt
 * for a newer worker is open (X12 up to its Apply); the reload then recovers
 * at its commit deadline with that prompt still open.
 */
async function recoverWithPromptOpen(tab: Tab): Promise<void> {
  await tab.open({ app: ROOM_HOST });
  tab.replaceController('v494');
  await at(PROMPT_MS);
  tab.install('v495');
  await at(2 * PROMPT_MS);
  expect(mocks.dialogs).toHaveLength(2);
  dialog(0).answer('ok');
  await at(3_000);
  expect(tab.navigations()).toEqual(['doc1 reload']);
}

const ROWS: readonly Row[] = [
  // ── SKIP_WAITING sends ──────────────────────────────────────────────
  {
    id: 'S1a',
    from: 'passive',
    event:
      'a worker is waiting when the page opens within 30 s of an update reload (cooldown): quiet SKIP_WAITING once the page has been quiet for 1 s; it activates (outside a room)',
    then: 'reload-scheduled',
    label:
      '[keeps: C6-9] [flips: C6-10, owner decision P3-9 A: the quiet promotion waits until the page loads are quiet]',
    async run(tab) {
      sessionStorage.setItem('sw-updated-at', String(T0 - 1_000));
      sessionStorage.setItem('sw-controller-confirmed-at', String(T0 - 1_000));
      tab.install('v494');
      await tab.open({ app: OUTSIDE, navigation: 'reload' });
      await at(900);
      expect(tab.skipWaiting).toEqual([]);
      await at(1_500);
      tab.activate();
      await at(1_500 + PAINT_MS);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 reload'],
      dialogs: [],
      markers: { ...NO_MARKERS, 'sw-updated-at': 't+1500', 'sw-controller-confirmed-at': 't+1500' },
    },
  },
  {
    id: 'S1c',
    from: 'passive',
    event:
      "as S1a, but the page's resources keep finishing until t+1200: the quiet SKIP_WAITING waits until no resource has finished for 1 s",
    then: 'reload-scheduled',
    label: '[added: C6-10, owner decision P3-9 A]',
    async run(tab) {
      sessionStorage.setItem('sw-updated-at', String(T0 - 1_000));
      sessionStorage.setItem('sw-controller-confirmed-at', String(T0 - 1_000));
      tab.install('v494');
      const page = tab.open({ app: OUTSIDE, navigation: 'reload' });
      tab.finishResource();
      await page;
      for (const ms of [400, 800, 1_200]) {
        await at(ms);
        tab.finishResource();
      }
      await at(2_100);
      expect(tab.skipWaiting).toEqual([]);
      await at(2_500);
      expect(tab.skipWaiting).toEqual(['doc1 → v494']);
      tab.activate();
      await at(2_500 + PAINT_MS);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 reload'],
      dialogs: [],
      markers: { ...NO_MARKERS, 'sw-updated-at': 't+2500', 'sw-controller-confirmed-at': 't+2500' },
    },
  },
  {
    id: 'S1b',
    from: 'passive',
    event: 'the same cooldown promotion in a hosted room; it activates',
    then: 'passive',
    label:
      '[keeps: C6-9] [flips: C6-10, owner decision P3-9 A: the quiet promotion waits until the page loads are quiet]',
    async run(tab) {
      sessionStorage.setItem('sw-updated-at', String(T0 - 1_000));
      sessionStorage.setItem('sw-controller-confirmed-at', String(T0 - 1_000));
      tab.install('v494');
      await tab.open({ app: ROOM_HOST, navigation: 'reload' });
      await at(1_500);
      tab.activate();
      await at(1_500 + PAINT_MS);
      // Probe: passive, so another tab's update is offered too.
      tab.replaceController('v495');
      await at(2_000);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: [],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't-1000',
        'sw-controller-confirmed-at': 't-1000',
      },
    },
  },
  {
    id: 'S2a',
    from: 'passive',
    event:
      'a waiting worker reuses the active cache generation: quiet SKIP_WAITING once the page has been quiet for 1 s; it activates (outside a room)',
    then: 'reload-scheduled',
    label:
      '[keeps: C6-9] [flips: C6-10, owner decision P3-9 A: the quiet promotion waits until the page loads are quiet]',
    async run(tab) {
      tab.install('v493');
      await tab.open({ app: OUTSIDE });
      await at(900);
      expect(tab.skipWaiting).toEqual([]);
      await at(1_500);
      tab.activate();
      await at(1_500 + PAINT_MS);
    },
    effects: {
      skipWaiting: ['doc1 → v493'],
      navigations: ['doc1 reload'],
      dialogs: [],
      markers: { ...NO_MARKERS, 'sw-updated-at': 't+1500', 'sw-controller-confirmed-at': 't+1500' },
    },
  },
  {
    id: 'S2b',
    from: 'passive',
    event: 'the same same-generation promotion in a hosted room; it activates',
    then: 'passive',
    label:
      '[keeps: C6-9] [flips: C6-10, owner decision P3-9 A: the quiet promotion waits until the page loads are quiet]',
    async run(tab) {
      tab.install('v493');
      await tab.open({ app: ROOM_HOST });
      await at(1_500);
      tab.activate();
      await at(1_500 + PAINT_MS);
      // Probe: passive, so another tab's update is offered.
      tab.replaceController('v495');
      await at(2_000);
    },
    effects: {
      skipWaiting: ['doc1 → v493'],
      navigations: [],
      dialogs: [`doc1 ${MSG_HOST}`],
      markers: NO_MARKERS,
    },
  },
  {
    id: 'S3a',
    from: 'prompting',
    event: 'Apply outside a room; the worker activates',
    then: 'reload-scheduled',
    label: '[keeps: C6-9]',
    async run(tab) {
      await tab.open({ app: OUTSIDE });
      tab.install('v494');
      await at(PROMPT_MS);
      dialog(0).answer('ok');
      await at(1_000);
      expect(readMarkers()['sw-updated-at']).toBe(`t+${PROMPT_MS}`);
      expect(readMarkers()['sw-controller-confirmed-at']).toBeNull();
      tab.activate();
      await at(1_000 + PAINT_MS);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 reload'],
      dialogs: [`doc1 ${MSG_APPLY}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+1000',
        'sw-controller-confirmed-at': 't+1000',
      },
    },
  },
  {
    id: 'S3b',
    from: 'prompting',
    event:
      'Apply as a room guest; the worker activates (awaiting-local-controller reloads without asking)',
    then: 'reload-scheduled',
    label: '[keeps: C6-9]',
    async run(tab) {
      await tab.open({ app: ROOM_GUEST });
      tab.install('v494');
      await at(PROMPT_MS);
      dialog(0).answer('ok');
      await at(1_000);
      tab.activate();
      await at(1_000 + PAINT_MS);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: [`doc1 href /${ROOM_CODE}`],
      dialogs: [`doc1 ${MSG_GUEST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+1000',
        'sw-controller-confirmed-at': 't+1000',
        mxqr_reconnect_target: ROOM_CODE,
      },
    },
  },
  {
    id: 'S4',
    from: 'prompting',
    event: 'Apply after a newer worker replaced the prompted one; the newer worker activates',
    then: 'reload-scheduled',
    label: '[keeps: C6-9]',
    async run(tab) {
      await tab.open({ app: OUTSIDE });
      tab.install('v494');
      await at(PROMPT_MS);
      tab.install('v495');
      dialog(0).answer('ok');
      await at(1_000);
      expect(readMarkers()['sw-updated-at']).toBe(`t+${PROMPT_MS}`);
      tab.activate();
      await at(1_000 + PAINT_MS);
    },
    effects: {
      skipWaiting: ['doc1 → v495'],
      navigations: ['doc1 reload'],
      dialogs: [`doc1 ${MSG_APPLY}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+1000',
        'sw-controller-confirmed-at': 't+1000',
      },
    },
  },
  {
    id: 'S5a',
    from: 'passive',
    event:
      'the logo reset outside a room with an update put off with Later: the update machine sends SKIP_WAITING for it (on main, the hard reset itself) and the worker activates inside the 1.5 s wait; the navigation home commits',
    then: 'passive',
    label: '[keeps: C6-9] [keeps effects: C6-10, owner decision P3-8 A]',
    async run(tab) {
      const page = await tab.open({ app: OUTSIDE });
      tab.install('v494');
      await at(PROMPT_MS);
      dialog(0).answer('secondary');
      await at(1_000);
      page.logoReset();
      await at(1_300);
      tab.activate();
      await at(1_400);
      page.pagehide();
      await at(8_000);
    },
    // Until C6-10 the update machine read the hard reset's activation as a
    // passive controller change and asked for its aligned reload, which waited
    // behind the logo navigation and never ran once that navigation committed.
    // Since C6-10 the machine asks for nothing while the logo's navigation holds
    // the page (no second reload request) and writes the same markers.
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 replace /'],
      dialogs: [`doc1 ${MSG_APPLY}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+1300',
        'sw-controller-confirmed-at': 't+1300',
        'mxqr-swu': 'Update applied',
      },
    },
  },
  {
    id: 'S5e',
    from: 'passive',
    event:
      'as S5a, but the navigation home does not commit within its 2 s deadline: the aligned reload then runs (on main the one queued behind it, since C6-10 the decision put off until the page was released)',
    then: 'reload-scheduled',
    label:
      '[keeps: C6-9] [keeps navigations: C6-10, owner decision P3-8 A: outside a room, an aligned reload; the markers carry the moment the decision ran]',
    async run(tab) {
      const page = await tab.open({ app: OUTSIDE });
      tab.install('v494');
      await at(PROMPT_MS);
      dialog(0).answer('secondary');
      await at(1_000);
      page.logoReset();
      await at(1_300);
      tab.activate();
      await at(1_300 + COMMIT_DEADLINE_MS + PAINT_MS);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 replace /', 'doc1 reload'],
      dialogs: [`doc1 ${MSG_APPLY}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+3300',
        'sw-controller-confirmed-at': 't+3300',
        'mxqr-swu': 'Update applied',
      },
    },
  },
  {
    id: 'S5b',
    from: 'passive',
    event:
      'the logo reset as a room guest while another tab owns the prompt: the worker activates and the navigation home commits',
    then: 'passive',
    label:
      '[keeps: C6-9] [flips: C6-10, owner decision P3-8 A: no update dialog under the reset screen]',
    async run(tab) {
      const page = await tab.open({ app: ROOM_GUEST });
      foreignPromptLease('v494');
      tab.install('v494');
      await at(1_000);
      page.logoReset();
      await at(1_300);
      tab.activate();
      await at(1_400);
      page.pagehide();
      await at(8_000);
    },
    // On main a room asked about the passive controller change, so an update
    // dialog opened under the reset screen while the page left. The markers
    // are new since C6-10: the machine records the logo's request and the
    // activation it saw, as for an Apply.
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 replace /'],
      dialogs: [],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+1300',
        'sw-controller-confirmed-at': 't+1300',
        'mxqr-swu': 'Update applied',
      },
    },
  },
  {
    id: 'S5f',
    from: 'passive',
    event:
      'as S5b, but the navigation home does not commit within its 2 s deadline: once the page is released, the room asks once',
    then: 'passive',
    label:
      '[keeps dialogs: C6-9] [C6-10, owner decision P3-8 A: the room is asked when the page stays, not under the reset screen]',
    async run(tab) {
      const page = await tab.open({ app: ROOM_GUEST });
      foreignPromptLease('v494');
      tab.install('v494');
      await at(1_000);
      page.logoReset();
      await at(1_300);
      tab.activate();
      await at(1_400);
      expect(page.owner.isSessionResetPending()).toBe(true);
      expect(mocks.dialogs).toHaveLength(0);
      await at(1_300 + COMMIT_DEADLINE_MS + PAINT_MS);
      expect(page.owner.isSessionResetPending()).toBe(false);
      await at(8_000);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 replace /'],
      dialogs: [`doc1 ${MSG_GUEST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+1300',
        'sw-controller-confirmed-at': 't+1300',
        'mxqr-swu': 'Update applied',
      },
    },
  },
  {
    id: 'S5c',
    from: 'passive',
    event:
      "the logo reset with a waiting update whose activation stalls: the update machine's SKIP_WAITING, then after the 1.5 s wait the hard reset's own (temporary, P3-12 A); home at the prepare deadline, no toast",
    then: 'passive',
    label:
      '[keeps: C6-9] [flips: C6-10, owner decisions P3-11 A, P3-12 A: the machine records the request; a second SKIP_WAITING from the temporary timeout fallback]',
    async run(tab) {
      const page = await tab.open({ app: OUTSIDE });
      tab.install('v494');
      await at(PROMPT_MS);
      dialog(0).answer('secondary');
      await at(1_000);
      page.logoReset();
      await at(4_000);
      page.pagehide();
      await at(8_000);
    },
    effects: {
      skipWaiting: ['doc1 → v494', 'doc1 → v494'],
      navigations: ['doc1 replace /'],
      dialogs: [`doc1 ${MSG_APPLY}`],
      markers: { ...NO_MARKERS, 'sw-updated-at': 't+1024' },
    },
  },
  {
    id: 'S5d',
    from: 'awaiting-local-controller',
    event:
      'the logo reset during a stalled Apply: it waits for that activation and sends no second SKIP_WAITING (on main it sent one); the worker activates inside the wait',
    then: 'awaiting-local-controller',
    label: '[keeps: C6-9] [flips: C6-10, owner decision P3-8 A]',
    async run(tab) {
      const page = await tab.open({ app: OUTSIDE });
      tab.install('v494');
      await at(PROMPT_MS);
      dialog(0).answer('ok');
      await at(3_000);
      page.logoReset();
      await at(3_300);
      tab.activate();
      await at(3_400);
      page.pagehide();
      await at(10_000);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 replace /'],
      dialogs: [`doc1 ${MSG_APPLY}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+3300',
        'sw-controller-confirmed-at': 't+3300',
        'mxqr-swu': 'Update applied',
      },
    },
  },
  {
    id: 'S5g',
    from: 'passive',
    event:
      "the logo reset while the page's own loads are still finishing: nothing is promoted and the page goes home at once; the next page offers the update with the usual dialog",
    then: 'passive',
    label: '[added: C6-10, owner decision P3-9 A]',
    async run(tab) {
      const page = await tab.open({ app: OUTSIDE });
      tab.install('v494');
      await at(PROMPT_MS);
      dialog(0).answer('secondary');
      await at(1_000);
      tab.finishResource();
      await at(1_300);
      page.logoReset();
      await at(1_300 + PAINT_MS);
      expect(tab.navigations()).toEqual(['doc1 replace /']);
      page.pagehide();
      await tab.open({ app: OUTSIDE });
      await at(1_300 + PAINT_MS + 1_000 + PROMPT_MS);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 replace /'],
      dialogs: [`doc1 ${MSG_APPLY}`, `doc2 ${MSG_APPLY}`],
      markers: NO_MARKERS,
    },
  },
  {
    id: 'S5h',
    from: 'prompting',
    event:
      'the logo reset while the update prompt is open (queued behind the return-home question): the prompt is withdrawn, the update machine applies the update, the navigation home commits',
    then: 'passive',
    label: '[added: C6-10, owner decision P3-8 A: no update dialog under the reset screen]',
    async run(tab) {
      const page = await tab.open({ app: OUTSIDE });
      tab.install('v494');
      await at(1_000);
      expect(mocks.dialogs).toHaveLength(1);
      page.logoReset();
      await at(1_100);
      expect(dialog(0).outcome).toBe('superseded');
      tab.activate();
      await at(1_200);
      page.pagehide();
      await at(8_000);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 replace /'],
      dialogs: [`doc1 ${MSG_APPLY}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+1100',
        'sw-controller-confirmed-at': 't+1100',
        'mxqr-swu': 'Update applied',
      },
    },
  },
  {
    id: 'S5i',
    from: 'none',
    event:
      'the logo reset before the window load event, so there is no update machine yet: the hard reset promotes on its own once the page is quiet; the worker activates',
    then: 'passive',
    label: '[keeps: C6-9] [owner decision P3-12 A: the no-machine promotion stays]',
    async run(tab) {
      tab.install('v494');
      const page = await tab.open({ app: OUTSIDE, loaded: false });
      await at(1_000);
      page.logoReset();
      await at(1_300);
      tab.activate();
      await at(1_400);
      page.pagehide();
      await at(8_000);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 replace /'],
      dialogs: [],
      markers: { ...NO_MARKERS, 'mxqr-swu': 'Update applied' },
    },
  },
  {
    id: 'S5j',
    from: 'none',
    event:
      'as S5i, but a resource of the page finished 300 ms before: nothing is promoted (the page is still loading), and the page goes home at once',
    then: 'passive',
    label: '[added: C6-10, owner decision P3-9 A]',
    async run(tab) {
      tab.install('v494');
      const page = await tab.open({ app: OUTSIDE, loaded: false });
      await at(1_000);
      tab.finishResource();
      await at(1_300);
      page.logoReset();
      await at(1_300 + PAINT_MS);
      expect(tab.navigations()).toEqual(['doc1 replace /']);
      page.pagehide();
      await at(8_000);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 replace /'],
      dialogs: [],
      markers: NO_MARKERS,
    },
  },

  // ── Exits from reload-scheduled ─────────────────────────────────────
  {
    id: 'X1',
    from: 'reload-scheduled',
    event:
      'no pagehide within the 2 s commit deadline (a no-op reload); later another update activates',
    then: 'passive',
    label: '[keeps: C6-9]',
    async run(tab) {
      await scheduleOutsideReload(tab);
      await at(3_000);
      tab.replaceController('v495');
      await at(3_000 + PAINT_MS);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+3000',
        'sw-controller-confirmed-at': 't+3000',
      },
    },
  },
  {
    id: 'X2',
    from: 'reload-scheduled',
    event: 'the reload sink throws; later another update activates',
    then: 'passive',
    label: '[keeps: C6-9]',
    async run(tab) {
      tab.failNextReload();
      await scheduleOutsideReload(tab);
      await at(1_000);
      tab.replaceController('v495');
      await at(1_000 + PAINT_MS);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload (threw)', 'doc1 reload'],
      dialogs: [],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+1000',
        'sw-controller-confirmed-at': 't+1000',
      },
    },
  },
  {
    id: 'X3a',
    from: 'reload-scheduled',
    event:
      'pagehide, then the same document returns (pageshow, not persisted); later another update activates',
    then: 'passive',
    label: '[keeps: C6-9]',
    async run(tab) {
      const page = await scheduleOutsideReload(tab);
      page.pagehide();
      await at(500);
      page.pageshow();
      await at(1_000);
      tab.replaceController('v495');
      await at(1_000 + PAINT_MS);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+1000',
        'sw-controller-confirmed-at': 't+1000',
      },
    },
  },
  {
    id: 'X3b',
    from: 'reload-scheduled',
    event:
      'pagehide, then the same document is only made visible again (iOS); later another update activates',
    then: 'passive',
    label: '[keeps: C6-9]',
    async run(tab) {
      const page = await scheduleOutsideReload(tab);
      page.pagehide();
      await at(500);
      page.visible();
      await at(1_000);
      tab.replaceController('v495');
      await at(1_000 + PAINT_MS);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+1000',
        'sw-controller-confirmed-at': 't+1000',
      },
    },
  },
  {
    id: 'X4',
    from: 'reload-scheduled',
    event: 'pagehide and no return (the reload committed); another update activates',
    then: 'reload-scheduled',
    label: '[keeps: C6-9]',
    async run(tab) {
      const page = await scheduleOutsideReload(tab);
      page.pagehide();
      await at(5_000);
      tab.replaceController('v495');
      await at(10_000);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload'],
      dialogs: [],
      markers: { ...NO_MARKERS, 'sw-updated-at': 't+0', 'sw-controller-confirmed-at': 't+0' },
    },
  },
  {
    id: 'X5',
    from: 'reload-scheduled',
    event:
      'the back-forward cache returns the document (pageshow persisted): the owner settles the update reload and makes its own bounded reload, which then recovers; later another update activates',
    then: 'passive',
    label: '[keeps: C6-9]',
    async run(tab) {
      const page = await scheduleOutsideReload(tab);
      page.pagehide(true);
      await at(500);
      page.pageshow(true);
      await at(500 + PAINT_MS + COMMIT_DEADLINE_MS + 100);
      tab.replaceController('v495');
      await at(3_000 + PAINT_MS);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload', 'doc1 reload', 'doc1 reload'],
      dialogs: [],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+2700',
        'sw-controller-confirmed-at': 't+2700',
      },
    },
  },
  {
    id: 'X6',
    from: 'reload-scheduled',
    event:
      'another update activates while the reload is pending (the successor is recorded); the reload then recovers at its commit deadline',
    then: 'reload-scheduled',
    label: '[keeps: C6-9]',
    async run(tab) {
      await scheduleOutsideReload(tab);
      await at(500);
      tab.replaceController('v495');
      await at(1_000);
      expect(tab.navigations()).toEqual(['doc1 reload']);
      await at(2_500);
    },
    // The successor's reload is reserved inside the recovery, at the deadline.
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+2032',
        'sw-controller-confirmed-at': 't+2032',
      },
    },
  },
  {
    id: 'X7',
    from: 'reload-scheduled',
    event:
      'a successor of the same cache generation activates while the reload is pending; the reload recovers; later a newer update activates',
    then: 'passive',
    label: '[keeps: C6-9]',
    async run(tab) {
      await scheduleOutsideReload(tab);
      await at(500);
      tab.replaceController('v494');
      await at(3_000);
      expect(tab.navigations()).toEqual(['doc1 reload']);
      tab.replaceController('v495');
      await at(3_000 + PAINT_MS);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+3000',
        'sw-controller-confirmed-at': 't+3000',
      },
    },
  },
  {
    id: 'X8',
    from: 'reload-scheduled',
    event:
      'a successor activates while the reload is pending, then the page loses its controller; the reload recovers; later a newer update activates',
    then: 'passive',
    label: '[keeps: C6-9]',
    async run(tab) {
      await scheduleOutsideReload(tab);
      await at(500);
      tab.replaceController('v495');
      await at(600);
      tab.dropController();
      await at(3_000);
      expect(tab.navigations()).toEqual(['doc1 reload']);
      tab.replaceController('v496');
      await at(3_000 + PAINT_MS);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+3000',
        'sw-controller-confirmed-at': 't+3000',
      },
    },
  },
  {
    id: 'X9',
    from: 'awaiting-local-controller',
    event:
      "a room guest's Apply activates while another navigation holds the page; that navigation then recovers: the Apply's /CODE return runs then (on main it was refused at once and lost); it recovers too; later another update activates",
    then: 'passive',
    label:
      '[flips: C6-10, owner decision P3-8 A: a decision put off while a navigation holds the page runs when the page is released]',
    async run(tab) {
      const page = await tab.open({ app: ROOM_GUEST });
      tab.install('v494');
      await at(PROMPT_MS);
      dialog(0).answer('ok');
      await at(1_000);
      page.leave();
      await at(1_050);
      tab.activate();
      expect(page.owner.isSessionResetPending()).toBe(true);
      await at(1_050 + PAINT_MS + COMMIT_DEADLINE_MS + 100);
      expect(tab.navigations()).toEqual(['doc1 replace /', `doc1 href /${ROOM_CODE}`]);
      await at(6_000);
      expect(page.owner.isSessionResetPending()).toBe(false);
      tab.replaceController('v495');
      await at(7_000);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 replace /', `doc1 href /${ROOM_CODE}`],
      dialogs: [`doc1 ${MSG_GUEST}`, `doc1 ${MSG_GUEST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+3024',
        'sw-controller-confirmed-at': 't+3024',
        mxqr_reconnect_target: ROOM_CODE,
      },
    },
  },
  {
    id: 'X10a',
    from: 'reload-scheduled',
    event:
      'the update reload outside a room waits behind another navigation, which recovers: the reload then runs (on main queued at once, since C6-10 asked for when the page is released); another update activates during it',
    then: 'reload-scheduled',
    label:
      '[keeps navigations: C6-9, C6-10] [C6-10, owner decision P3-8 A: the markers carry the moment the reload was asked for]',
    async run(tab) {
      const page = await tab.open({ app: OUTSIDE });
      page.leave();
      await at(50);
      tab.replaceController('v494');
      await at(50 + PAINT_MS + COMMIT_DEADLINE_MS + 50);
      expect(tab.navigations()).toEqual(['doc1 replace /', 'doc1 reload']);
      tab.replaceController('v495');
      await at(3_000);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 replace /', 'doc1 reload'],
      dialogs: [],
      markers: { ...NO_MARKERS, 'sw-updated-at': 't+2032', 'sw-controller-confirmed-at': 't+2032' },
    },
  },
  {
    id: 'X10b',
    from: 'reload-scheduled',
    event:
      'the update reload outside a room waits behind another navigation, which commits: the reload never runs (since C6-10 it is never asked for)',
    then: 'passive',
    label:
      '[keeps navigations: C6-9, C6-10] [C6-10: a later controller change in the departed document only records its markers]',
    async run(tab) {
      const page = await tab.open({ app: OUTSIDE });
      page.leave();
      await at(50);
      tab.replaceController('v494');
      await at(50 + PAINT_MS);
      page.pagehide();
      await at(5_000);
      tab.replaceController('v495');
      await at(6_000);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 replace /'],
      dialogs: [],
      markers: { ...NO_MARKERS, 'sw-updated-at': 't+5000', 'sw-controller-confirmed-at': 't+5000' },
    },
  },
  {
    id: 'X11',
    from: 'reload-scheduled',
    event:
      'the update reload waits behind a navigation that left, and the back-forward cache returns the document: the owner drops the queued reload (its caller hears), makes its own bounded reload, which recovers; later another update activates',
    then: 'passive',
    label: '[keeps: C6-9]',
    async run(tab) {
      const page = await tab.open({ app: OUTSIDE });
      page.leave();
      await at(50);
      tab.replaceController('v494');
      await at(50 + PAINT_MS);
      page.pagehide(true);
      await at(500);
      page.pageshow(true);
      await at(500 + PAINT_MS + COMMIT_DEADLINE_MS + 100);
      tab.replaceController('v495');
      await at(3_000 + PAINT_MS);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 replace /', 'doc1 reload', 'doc1 reload'],
      dialogs: [],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+2700',
        'sw-controller-confirmed-at': 't+2700',
      },
    },
  },
  {
    id: 'X12',
    from: 'reload-scheduled',
    event:
      "a hosted room: another tab's update is applied from its dialog while this tab's own prompt for a newer worker is open; that prompt then loses its lease to a third tab; a still newer worker installs",
    then: 'passive, latched',
    label:
      '[keeps: C6-9] [flips timing: C6-10, owner decision P3-9 A: the quiet promotion waits until the page loads are quiet]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.install('v495');
      await at(2 * PROMPT_MS);
      expect(mocks.dialogs).toHaveLength(2);
      dialog(0).answer('ok');
      await at(2 * PROMPT_MS + 50);
      foreignPromptLease('v495');
      await at(2 * PROMPT_MS + 100);
      // While latched, a waiting worker is still taken up: the cooldown
      // promotion sends a quiet SKIP_WAITING once the page is quiet.
      tab.install('v496');
      await at(1_500);
    },
    effects: {
      skipWaiting: ['doc1 → v496'],
      navigations: ['doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: { ...NO_MARKERS, 'sw-updated-at': 't+200', 'sw-controller-confirmed-at': 't+200' },
    },
  },
  {
    id: 'X13',
    from: 'reload-scheduled',
    event:
      'as X12, but the open prompt is answered Later while the reload is pending (not reachable by a user: the reset screen keeps the dialog inert); a newer worker installs',
    then: 'passive, latched',
    label:
      '[keeps: C6-9] [flips timing: C6-10, owner decision P3-9 A: the quiet promotion waits until the page loads are quiet]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.install('v495');
      await at(2 * PROMPT_MS);
      dialog(0).answer('ok');
      await at(2 * PROMPT_MS + 50);
      dialog(1).answer('secondary');
      await at(2 * PROMPT_MS + 100);
      tab.install('v496');
      await at(1_500);
    },
    effects: {
      skipWaiting: ['doc1 → v496'],
      navigations: ['doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: { ...NO_MARKERS, 'sw-updated-at': 't+200', 'sw-controller-confirmed-at': 't+200' },
    },
  },
  {
    id: 'X14',
    from: 'reload-scheduled',
    event:
      'as X12, but a newer worker replaces the prompted one and the prompt is answered Apply while the reload is pending (not reachable by a user); the reload recovers, then the newer worker activates',
    then: 'awaiting-local-controller, latched',
    label: '[keeps: C6-9]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.install('v495');
      await at(2 * PROMPT_MS);
      dialog(0).answer('ok');
      await at(2 * PROMPT_MS + 50);
      tab.install('v496');
      dialog(1).answer('ok');
      await at(2 * PROMPT_MS + 100);
      expect(readMarkers()['sw-controller-confirmed-at']).toBeNull();
      await at(3_000);
      tab.activate();
      await at(3_000 + PAINT_MS);
    },
    // After the recovery the page is awaiting the newer worker, so its
    // activation reloads a hosted room without asking.
    effects: {
      skipWaiting: ['doc1 → v496'],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+3000',
        'sw-controller-confirmed-at': 't+3000',
      },
    },
  },
  {
    id: 'X15',
    from: 'reload-scheduled',
    event:
      'as X12, but the prompt (its worker still waiting) is answered Apply while the reload is pending (not reachable by a user); the reload recovers; later another update activates',
    then: 'reload-scheduled',
    label: '[keeps: C6-9]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.install('v495');
      await at(2 * PROMPT_MS);
      dialog(0).answer('ok');
      await at(2 * PROMPT_MS + 50);
      dialog(1).answer('ok');
      await at(3_000);
      tab.replaceController('v496');
      await at(3_000 + PAINT_MS);
    },
    // The Apply is dropped: no SKIP_WAITING, and the prompted worker stays
    // waiting, not asked about again in this page.
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: { ...NO_MARKERS, 'sw-updated-at': 't+200', 'sw-controller-confirmed-at': 't+200' },
    },
  },
  // ── Events while the update reload is still latched ─────────────────
  // X12 to X14 leave a latched state but end before anything that behaves
  // differently with or without the latch. These rows send the next event
  // before the reload's commit-deadline recovery (t+2224): a newer controller
  // waits for that recovery, which then reloads for it without asking (X12b,
  // X12c, X13b, X14b, X18, X19); a second approved reload is refused (X16); a
  // prompt that lets go while the reload is pending still takes up a newer
  // waiting worker (X12d) but does not ask about a controller change again
  // (X17).
  {
    id: 'X12b',
    from: 'passive, latched',
    event:
      'X12, then the quietly promoted worker activates before the reload recovers (activation within milliseconds of SKIP_WAITING)',
    then: 'reload-scheduled',
    label:
      '[keeps: C6-9] [flips timing: C6-10, owner decision P3-9 A: the quiet promotion waits until the page loads are quiet]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.install('v495');
      await at(2 * PROMPT_MS);
      dialog(0).answer('ok');
      await at(2 * PROMPT_MS + 50);
      foreignPromptLease('v495');
      await at(2 * PROMPT_MS + 100);
      tab.install('v496');
      await at(1_400);
      tab.activate();
      await at(5_000);
    },
    effects: {
      skipWaiting: ['doc1 → v496'],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+2224',
        'sw-controller-confirmed-at': 't+2224',
      },
    },
  },
  {
    id: 'X12c',
    from: 'passive, latched',
    event:
      'X12 where sessionStorage is denied: with no cooldown the newer worker is offered while the reload is latched; its Apply is dropped (as X15), and another tab applies it before the reload recovers',
    then: 'reload-scheduled',
    label: '[keeps: C6-9]',
    async run(tab) {
      const restoreSessionStorage = denySessionStorage();
      try {
        await tab.open({ app: ROOM_HOST });
        tab.replaceController('v494');
        await at(PROMPT_MS);
        tab.install('v495');
        await at(2 * PROMPT_MS);
        dialog(0).answer('ok');
        await at(2 * PROMPT_MS + 50);
        foreignPromptLease('v495');
        await at(2 * PROMPT_MS + 100);
        tab.install('v496');
        await at(2 * PROMPT_MS + 300);
        expect(mocks.dialogs).toHaveLength(3);
        dialog(2).answer('ok');
        await at(600);
        tab.activate();
        await at(5_000);
      } finally {
        restoreSessionStorage();
      }
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: NO_MARKERS,
    },
  },
  {
    id: 'X12d',
    from: 'reload-scheduled',
    event:
      'as X12, but the newer worker installs before the prompt loses its lease: the prompt lets go and takes up the newer worker with a quiet SKIP_WAITING',
    then: 'passive, latched',
    label:
      '[keeps: C6-9] [flips timing: C6-10, owner decision P3-9 A: the quiet promotion waits until the page loads are quiet]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.install('v495');
      await at(2 * PROMPT_MS);
      dialog(0).answer('ok');
      await at(2 * PROMPT_MS + 50);
      tab.install('v496');
      await at(2 * PROMPT_MS + 100);
      foreignPromptLease('v495');
      await at(1_500);
    },
    effects: {
      skipWaiting: ['doc1 → v496'],
      navigations: ['doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+200',
        'sw-controller-confirmed-at': 't+200',
      },
    },
  },
  {
    id: 'X13b',
    from: 'passive, latched',
    event: 'X13, then the quietly promoted worker activates before the reload recovers',
    then: 'reload-scheduled',
    label:
      '[keeps: C6-9] [flips timing: C6-10, owner decision P3-9 A: the quiet promotion waits until the page loads are quiet]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.install('v495');
      await at(2 * PROMPT_MS);
      dialog(0).answer('ok');
      await at(2 * PROMPT_MS + 50);
      dialog(1).answer('secondary');
      await at(2 * PROMPT_MS + 100);
      tab.install('v496');
      await at(1_400);
      tab.activate();
      await at(5_000);
    },
    effects: {
      skipWaiting: ['doc1 → v496'],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+2224',
        'sw-controller-confirmed-at': 't+2224',
      },
    },
  },
  {
    id: 'X14b',
    from: 'awaiting-local-controller, latched',
    event: 'X14, but the newer worker activates before the reload recovers',
    then: 'reload-scheduled',
    label: '[keeps: C6-9]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.install('v495');
      await at(2 * PROMPT_MS);
      dialog(0).answer('ok');
      await at(2 * PROMPT_MS + 50);
      tab.install('v496');
      dialog(1).answer('ok');
      await at(2 * PROMPT_MS + 100);
      tab.activate();
      await at(5_000);
    },
    effects: {
      skipWaiting: ['doc1 → v496'],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+2224',
        'sw-controller-confirmed-at': 't+2224',
      },
    },
  },
  {
    id: 'X16',
    from: 'reload-scheduled',
    event:
      "a hosted room asks about two updates other tabs applied; both offers are answered Apply, the second while the first Apply's reload is pending",
    then: 'reload-scheduled',
    label: '[keeps: C6-9]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.replaceController('v495');
      await at(2 * PROMPT_MS);
      expect(mocks.dialogs).toHaveLength(2);
      dialog(0).answer('ok');
      await at(2 * PROMPT_MS + 20);
      dialog(1).answer('ok');
      await at(5_000);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+200',
        'sw-controller-confirmed-at': 't+200',
      },
    },
  },
  {
    id: 'X17',
    from: 'reload-scheduled',
    event:
      "a hosted room: another tab applies an update while this tab's own prompt is open; the earlier offer is answered Apply; the prompt then loses its lease while the reload is pending",
    then: 'passive, latched',
    label: '[keeps: C6-9]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.install('v495');
      await at(2 * PROMPT_MS);
      expect(mocks.dialogs).toHaveLength(2);
      tab.replaceController('v496');
      await at(2 * PROMPT_MS + 50);
      dialog(0).answer('ok');
      await at(2 * PROMPT_MS + 100);
      foreignPromptLease('v495');
      await at(5_000);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+250',
        'sw-controller-confirmed-at': 't+250',
      },
    },
  },
  {
    id: 'X18',
    from: 'reload-scheduled',
    event:
      'as X12, but another tab activates the prompted worker while the reload is pending, and the prompt is then answered Later (not reachable by a user)',
    then: 'passive, latched',
    label: '[keeps: C6-9]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.install('v495');
      await at(2 * PROMPT_MS);
      dialog(0).answer('ok');
      await at(2 * PROMPT_MS + 50);
      tab.replaceController('v495');
      await at(2 * PROMPT_MS + 100);
      dialog(1).answer('secondary');
      await at(5_000);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+2224',
        'sw-controller-confirmed-at': 't+2224',
      },
    },
  },

  {
    id: 'X19',
    from: 'reload-scheduled',
    event:
      "a hosted room: while another tab's update is offered, a pre-protocol worker (it never answers the generation request) takes over; the offer is answered Apply before that worker's generation request times out",
    then: 'reload-scheduled',
    label: '[keeps: C6-9]',
    async run(tab) {
      await tab.open({ app: ROOM_HOST });
      tab.replaceController('v494');
      await at(PROMPT_MS);
      tab.replaceController('v495', { silent: true });
      await at(2 * PROMPT_MS);
      dialog(0).answer('ok');
      await at(5_000);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+2224',
        'sw-controller-confirmed-at': 't+2224',
      },
    },
  },

  // ── The reload recovers while the prompt is still open ──────────────
  // Scheduling the reload set aside the open prompt's phase, so the recovery
  // returns the page to passive with that prompt still open (the design's
  // overwrite path). The prompt is answered only after the recovery.
  {
    id: 'X20',
    from: 'passive',
    event:
      'X12 up to its Apply; the reload recovers with the prompt open; the prompt is answered Later; another tab then applies a newer update',
    then: 'passive',
    label: '[keeps: C6-9]',
    async run(tab) {
      await recoverWithPromptOpen(tab);
      dialog(1).answer('secondary');
      await at(3_500);
      tab.replaceController('v496');
      await at(4_000);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+200',
        'sw-controller-confirmed-at': 't+200',
      },
    },
  },
  {
    id: 'X21',
    from: 'passive',
    event:
      "as X20, but the prompt is answered Apply: another tab's update already took over, so the page reloads for it without SKIP_WAITING; the prompted worker activates while that reload is pending",
    then: 'reload-scheduled',
    label: '[keeps: C6-9]',
    async run(tab) {
      await recoverWithPromptOpen(tab);
      dialog(1).answer('ok');
      await at(3_500);
      tab.activate();
      await at(4_000);
    },
    effects: {
      skipWaiting: [],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+3000',
        'sw-controller-confirmed-at': 't+3000',
      },
    },
  },
  {
    id: 'X22',
    from: 'passive',
    event:
      'as X20, but a newer worker installs before the prompt is answered Apply: one SKIP_WAITING, the Apply to the replacement (on main the cooldown promotion sent one first; since C6-10 it waits for quiet and finds the worker taken)',
    then: 'reload-scheduled',
    label: '[flips: C6-10, owner decision P3-9 A]',
    async run(tab) {
      await recoverWithPromptOpen(tab);
      tab.install('v496');
      await at(3_200);
      dialog(1).answer('ok');
      await at(3_500);
      tab.activate();
      await at(4_000);
    },
    effects: {
      skipWaiting: ['doc1 → v496'],
      navigations: ['doc1 reload', 'doc1 reload'],
      dialogs: [`doc1 ${MSG_HOST}`, `doc1 ${MSG_HOST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+3500',
        'sw-controller-confirmed-at': 't+3500',
      },
    },
  },
  {
    id: 'P3-7',
    from: 'reload-scheduled',
    event:
      "a room guest's Apply: the /CODE return recovers at its commit deadline; the same generation is then seen again (a duplicate controllerchange, a successor of the same generation); later a newer update activates",
    then: 'passive',
    label: '[keeps: C6-9] [owner decision P3-7 A: a recovered Apply stays passive]',
    async run(tab) {
      await tab.open({ app: ROOM_GUEST });
      tab.install('v494');
      await at(PROMPT_MS);
      dialog(0).answer('ok');
      await at(500);
      tab.activate();
      await at(500 + PAINT_MS + COMMIT_DEADLINE_MS + 100);
      expect(tab.navigations()).toEqual([`doc1 href /${ROOM_CODE}`]);
      // The same generation does not bring the dialog back.
      tab.replaceController('v494');
      await at(3_500);
      expect(mocks.dialogs).toHaveLength(1);
      tab.replaceController('v495');
      await at(4_000);
    },
    effects: {
      skipWaiting: ['doc1 → v494'],
      navigations: [`doc1 href /${ROOM_CODE}`],
      dialogs: [`doc1 ${MSG_GUEST}`, `doc1 ${MSG_GUEST}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+500',
        'sw-controller-confirmed-at': 't+500',
        mxqr_reconnect_target: ROOM_CODE,
      },
    },
  },
];

// ─── Suite ───────────────────────────────────────────────────────────

let tab: Tab | null = null;
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const originalReadyState = Object.getOwnPropertyDescriptor(document, 'readyState');

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  sessionStorage.clear();
  localStorage.clear();
  mocks.dialogs.length = 0;
  Object.assign(mocks.app, OUTSIDE);
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
  tab = null;
});

afterEach(() => {
  tab?.close();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.documentElement.className = '';
  Reflect.deleteProperty(document, 'visibilityState');
  if (originalServiceWorker)
    Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
  else Reflect.deleteProperty(navigator, 'serviceWorker');
  if (originalReadyState) Object.defineProperty(document, 'readyState', originalReadyState);
  sessionStorage.clear();
  localStorage.clear();
  vi.useRealTimers();
});

describe('update machine transition table on the real navigation owner (C6-9 increment 1)', () => {
  it.each(ROWS)('$id $from: $event -> $then $label', async (row) => {
    tab = createTab('v493');
    await row.run(tab);
    expect(observe(tab)).toEqual(row.effects);
  });
});

/**
 * The stalled-Apply-then-logo case: C6-9 increment 2 recorded it as the input
 * of C6-10 (owner decision P3-10 A, "absorb an already-approved late
 * activation, only if reproduced first"), and C6-10 flipped it. Apply sends
 * SKIP_WAITING and the activation stalls (as Chromium's did for 43-66 s while
 * a page was loading, 2026-10-17). On main 08003954 and C6-9 the logo reset
 * sent a second SKIP_WAITING, waited its 1.5 s and went home; the new home
 * document opened under the old controller with the worker still waiting, and
 * when the late activation reached it, it reloaded once more (within the 30 s
 * cooldown, after promoting the worker a third time) or asked again and
 * reloaded on the answer (after it). Since C6-10 the logo waits for the Apply's
 * activation until its prepare window closes and sends nothing (P3-8 A); the
 * new document, which already runs that generation's code (navigation is
 * network-first, browser/service-worker.ts), absorbs the late activation: no
 * reload, no dialog, no toast (P3-10 A). A document that runs older code (a
 * cache fallback) still reloads.
 */
describe('a stalled Apply, then the logo reset (C6-9 input, flipped by C6-10 / P3-10 A)', () => {
  /** Apply in an idle page, a stalled activation, then the logo reset home, which commits. */
  async function stallApplyThenLogoHome(): Promise<Tab> {
    const stalled = createTab('v493');
    tab = stalled;
    const page = await stalled.open({ app: OUTSIDE });
    stalled.install('v494');
    await at(PROMPT_MS);
    dialog(0).answer('ok');
    await at(3_000);
    page.logoReset();
    await at(3_000 + PAINT_MS + 1_500);
    // The logo waits for the Apply's activation, sending nothing (P3-8 A)...
    expect(stalled.navigations()).toEqual([]);
    expect(stalled.skipWaiting).toEqual(['doc1 → v494']);
    // ...until its prepare window closes, then goes home.
    await at(3_000 + PAINT_MS + NAVIGATION_PREPARE_TIMEOUT_MS);
    expect(stalled.navigations()).toEqual(['doc1 replace /']);
    expect(stalled.skipWaiting).toEqual(['doc1 → v494']);
    page.pagehide();
    return stalled;
  }

  it('within the 30 s cooldown, the new document absorbs the late activation of the generation it runs: no reload, no dialog [flipped: C6-10, owner decision P3-10 A]', async () => {
    const stalled = await stallApplyThenLogoHome();
    await stalled.open({ app: OUTSIDE, navigation: 'navigate', build: 'v494' });
    await at(6_000);
    stalled.activate();
    await at(9_000);

    // Until C6-10: three SKIP_WAITING sends for one Apply, and the new home
    // document reloaded once more (navigations doc1 replace /, doc2 reload).
    expect(observe(stalled)).toEqual({
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 replace /'],
      dialogs: [`doc1 ${MSG_APPLY}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+6000',
        'sw-controller-confirmed-at': 't+6000',
      },
    });
  });

  it('a new document that runs the older code (a cache fallback) is not absorbed: it reloads for the late activation [added: C6-10, owner decision P3-10 A]', async () => {
    const stalled = await stallApplyThenLogoHome();
    await stalled.open({ app: OUTSIDE, navigation: 'navigate', build: 'v493' });
    await at(6_000);
    stalled.activate();
    await at(6_000 + PAINT_MS);

    expect(observe(stalled)).toEqual({
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 replace /', 'doc2 reload'],
      dialogs: [`doc1 ${MSG_APPLY}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+6000',
        'sw-controller-confirmed-at': 't+6000',
      },
    });
  });

  it('after the cooldown, the new document asks about the waiting update as usual; the late activation then withdraws that dialog and needs no reload [flipped: C6-10, owner decision P3-10 A]', async () => {
    const stalled = await stallApplyThenLogoHome();
    await at(40_000);
    await stalled.open({ app: OUTSIDE, navigation: 'navigate', build: 'v494' });
    // The startup prompt waits for the page's loads to go quiet (1 s).
    await at(40_000 + 1_000 + PROMPT_MS);
    expect(mocks.dialogs).toHaveLength(2);
    stalled.activate();
    await at(42_000);
    expect(dialog(1).outcome).toBe('superseded');
    dialog(1).answer('ok');
    await at(42_000 + PAINT_MS);

    // Until C6-10 the activation waited for the dialog, and its Apply then
    // reloaded the new document (navigations doc1 replace /, doc2 reload).
    expect(observe(stalled)).toEqual({
      skipWaiting: ['doc1 → v494'],
      navigations: ['doc1 replace /'],
      dialogs: [`doc1 ${MSG_APPLY}`, `doc2 ${MSG_APPLY}`],
      markers: {
        ...NO_MARKERS,
        'sw-updated-at': 't+41100',
        'sw-controller-confirmed-at': 't+41100',
      },
    });
  });
});
