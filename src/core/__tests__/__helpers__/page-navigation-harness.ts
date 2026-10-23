/**
 * Native-seam fakes and the app.ts wiring for the page navigation
 * characterization suite (C6-2, Phase 0c):
 * src/core/__tests__/page-navigation-owner.integration.test.ts
 *
 * Real, with no module mocks: core/session-reset.ts, core/document-reload.ts,
 * core/page-lifecycle.ts, core/inert-ownership.ts, ui/dom.ts (modal stack,
 * overlay observers, the Back offer, the fullscreen portal),
 * core/back-button-guard.ts, core/back-button-history.ts, core/navigation.ts,
 * core/reload-recovery-latch.ts, core/sw-hard-reset.ts with
 * core/sw-update-completion.ts, and pro-room/claim-fragment.ts where a test
 * takes a claim.
 *
 * `bootPageNavigationShell` wires them the way src/app.ts bootstrap does, in
 * its order: OverlayObservers (app.ts:1131), then PageLifecycle (the release
 * handler, initPageLifecycleHandlers and initPageNavigation, app.ts:1301-1324),
 * then BackButtonGuard (initBackButtonGuard, app.ts:915-990). The navigation
 * owner's page-transition dispatch (pagehide, pageshow and visibilitychange)
 * uses the capture phase, so it runs before the guard's bubble-phase resume
 * whatever the init order; `initOrder: 'guard-first'` boots the guard first to
 * show that. ServiceWorker registration (app.ts:1287) is not wired; the update
 * machine against the real reset is covered by
 * sw-register-recovery.integration.test.ts.
 *
 * That wiring, and the logo action in `logoHardReset`
 * (player-controls.ts:1086-1101), are copies: app.ts bootstrap and the logo
 * handler cannot run in isolation. page-navigation-harness-parity.test.ts pins
 * the copied guard function, PageLifecycle block and logo action whole, and
 * the init order as a subsequence. An increment that changes them (C6-6 the
 * page-transition dispatch and its init position, C6-8 the logo action, C6-12
 * the guard subscriptions) updates the copy here in the same change, then that
 * parity pin.
 *
 * One module instance serves the whole test file. ui/dom.ts installs permanent
 * capture listeners on `document` once per module instance (the legacy inert
 * guard), so a fresh module graph per test would stack stale guards. Each boot
 * instead resets every owner through its existing test seam, and `dispose`
 * removes every listener the wiring added.
 *
 * Each section below says what the fake models, what it is calibrated
 * against, and what it leaves out.
 */
import { vi, type Mock } from 'vitest';
import * as swHardReset from '../../sw-hard-reset.ts';
import { stubNavigationSinks, type NavigationSinks } from './navigation-sinks.ts';
import { createBackButtonGuardController, isGuardedSession } from '../../back-button-guard.ts';
import { createBackButtonHistory } from '../../back-button-history.ts';
import { __resetDocumentReloadForTests } from '../../document-reload.ts';
import { navigateToAppHome } from '../../navigation.ts';
import { __resetIntentionalNavForTests, initPageLifecycleHandlers } from '../../page-lifecycle.ts';
import { createReloadRecoveryLatch } from '../../reload-recovery-latch.ts';
import {
  __resetSessionResetForTests,
  initPageNavigation,
  isSessionResetPending,
  scheduleDocumentReload,
  scheduleSessionReset,
  setSessionResetReleaseHandler,
} from '../../session-reset.ts';
import {
  __resetModalStackForTests,
  hasOpenWindow,
  initOverlayObservers,
  offerBackToTopWindow,
  onOverlayStackChange,
  onWindowBack,
  syncOverlayState,
  syncOverlayStateAfterExternalLock,
  whenBackSurfaceSettled,
} from '../../../ui/dom.ts';

export type { NavigationSinks, SinkCall } from './navigation-sinks.ts';

/** i18n is not wired: requesters pass the keys app.ts would translate. */
export const MSG_REFRESHING = 'dialog.refreshing_session';
export const MSG_LEAVING = 'dialog.leaving_session';

/** A synthetic PRO room path (six digits, leading zero). */
export const ROOM_PATH = '/000001';

const actualWindow = globalThis.window;

// ─── Frames ─────────────────────────────────────────────────────────
// Models requestAnimationFrame as a visible 60 Hz tab: one frame every 16 ms on
// the fake clock. The reset therefore paints after two frames (32 ms) instead
// of its 120 ms native fallback, and the Back guard re-arms two frames after
// its surface settles. Leaves out hidden-tab frame suspension (the reset's
// fallback timer covers that case and other suites pin it).

/** Two 16 ms frames: when a scheduled reset runs its action. */
export const PAINT_MS = 32;

function installFrameClock(): () => void {
  const raf = Object.getOwnPropertyDescriptor(actualWindow, 'requestAnimationFrame');
  const caf = Object.getOwnPropertyDescriptor(actualWindow, 'cancelAnimationFrame');
  Object.defineProperty(actualWindow, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback): number =>
      globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number,
  });
  Object.defineProperty(actualWindow, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (id: number): void => globalThis.clearTimeout(id),
  });
  return () => {
    // Fake-timer teardown must still be able to restore the native APIs.
    for (const [name, descriptor] of [
      ['requestAnimationFrame', raf],
      ['cancelAnimationFrame', caf],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(actualWindow, name, { ...descriptor, configurable: true });
      } else {
        Reflect.deleteProperty(actualWindow, name);
      }
    }
  };
}

// ─── Browser history for the Back guard ─────────────────────────────
// Models the session history the guard reads and writes: entries with state,
// replaceState, pushState, and history.back() as a traversal queued as a task
// (TRAVERSAL_TASK_MS on the fake clock). The browser Back button is `pressBack`, the same traversal
// delivered as the current task. A same-document traversal dispatches popstate
// on the real window; a traversal into another document only records a
// departure (the test dispatches pagehide/pageshow to model unload and the
// back-forward cache); a traversal past the edge of the stack is a no-op,
// which is the "rejected or no-op history traversal" the reset recovers from.
// Leaves out URL changes on traversal and the jsdom history used by the PRO
// claim fragment, which stays real and separate.

/** When a queued history.back() traversal runs. */
export const TRAVERSAL_TASK_MS = 1;

interface HistoryEntry {
  readonly document: 'app' | 'previous';
  readonly state: unknown;
  readonly url: string;
}

export class FakeBackHistory {
  private entries: HistoryEntry[];
  private index: number;
  readonly departures: Array<'back' | 'forward'> = [];
  readonly pushes: number[] = [];

  constructor(previousDocument: boolean) {
    const app: HistoryEntry = { document: 'app', state: null, url: ROOM_PATH };
    this.entries = previousDocument
      ? [{ document: 'previous', state: null, url: 'https://example.test/' }, app]
      : [app];
    this.index = this.entries.length - 1;
  }

  get state(): unknown {
    return this.entries[this.index]?.state ?? null;
  }

  replaceState(data: unknown, _unused: string, url?: string | URL | null): void {
    const entry = this.entries[this.index];
    this.entries[this.index] = {
      ...entry,
      state: data,
      url: url == null ? entry.url : String(url),
    };
  }

  pushState(data: unknown, _unused: string, url?: string | URL | null): void {
    const entry = this.entries[this.index];
    this.entries.splice(this.index + 1);
    this.entries.push({ document: 'app', state: data, url: url == null ? entry.url : String(url) });
    this.index += 1;
    this.pushes.push(this.index);
  }

  back(): void {
    globalThis.setTimeout(() => this.traverse(-1), TRAVERSAL_TASK_MS);
  }

  pressBack(): void {
    this.traverse(-1);
  }

  /** This document's guard marker kind at the current entry, as the guard reads it. */
  marker(): 'base' | 'guard' | 'none' {
    const state = this.state as { mxqrGuard?: { kind?: unknown } } | null;
    const kind = state?.mxqrGuard?.kind;
    return kind === 'base' || kind === 'guard' ? kind : 'none';
  }

  private traverse(delta: number): void {
    const next = this.index + delta;
    const entry = this.entries[next];
    if (!entry) return;
    if (entry.document !== 'app') {
      this.departures.push(delta < 0 ? 'back' : 'forward');
      return;
    }
    this.index = next;
    actualWindow.dispatchEvent(new PopStateEvent('popstate', { state: entry.state }));
  }
}

// ─── Service worker container (logo hard reset) ─────────────────────
// Models what core/sw-hard-reset.ts reads: getRegistration('/') with a waiting
// worker in state 'installed', the current controller, and controllerchange.
// `registrationDelayMs` delays getRegistration on the fake clock. The worker
// activates only when the test calls `activate()`, so "never" is the stalled
// activation that sw-hard-reset bounds at 1.5 s. Calibrated against
// sw-hard-reset.ts:6-41 and the Chromium SKIP_WAITING delay of 43-66 s while a
// page is loading (docs/design/update-apply-on-reopen-2026-10-16.md). Leaves
// out the update machine in sw-register.ts, which this harness does not
// register.

export interface ServiceWorkerFake {
  readonly waiting: { state: string; postMessage: Mock<(message: unknown) => void> };
  readonly getRegistration: Mock<(scope?: string) => Promise<unknown>>;
  activate(): void;
  restore(): void;
}

export function installServiceWorkerFake(
  options: { registrationDelayMs?: number } = {},
): ServiceWorkerFake {
  const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
  const listeners = new Set<() => void>();
  let controller: object = { generation: 'old' };
  const waiting = { state: 'installed', postMessage: vi.fn<(message: unknown) => void>() };
  const registration = { scope: 'http://localhost:3000/', waiting };
  const getRegistration = vi.fn(
    (_scope?: string) =>
      new Promise<unknown>((resolve) => {
        const delay = options.registrationDelayMs ?? 0;
        if (delay > 0) globalThis.setTimeout(() => resolve(registration), delay);
        else resolve(registration);
      }),
  );
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      get controller() {
        return controller;
      },
      getRegistration,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'controllerchange') listeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === 'controllerchange') listeners.delete(listener);
      },
    },
  });
  const fake: ServiceWorkerFake = {
    waiting,
    getRegistration,
    activate() {
      controller = { generation: 'new' };
      waiting.state = 'activated';
      for (const listener of [...listeners]) listener();
    },
    restore() {
      if (original) Object.defineProperty(navigator, 'serviceWorker', original);
      else Reflect.deleteProperty(navigator, 'serviceWorker');
    },
  };
  return fake;
}

// ─── Fullscreen element ─────────────────────────────────────────────
// Models document.fullscreenElement (read by core/fullscreen.ts) and
// document.exitFullscreen as a recorder. jsdom has no top layer: a test can
// only show where each surface sits in the tree; the browser paints the
// fullscreen element's subtree above every z-index outside it.

export interface FullscreenFake {
  readonly exitFullscreen: Mock<() => Promise<void>>;
  restore(): void;
}

export function enterFullscreen(element: Element): FullscreenFake {
  const exitFullscreen = vi.fn(async () => undefined);
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => element,
  });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
  return {
    exitFullscreen,
    restore() {
      Reflect.deleteProperty(document, 'fullscreenElement');
      Reflect.deleteProperty(document, 'exitFullscreen');
    },
  };
}

// ─── Page transitions and visibility ────────────────────────────────
// jsdom dispatches whatever order a test chooses.
//
// A departure is pagehide first, then visibilitychange(hidden), and only when
// the document was visible. Checked against:
// - the HTML standard, "unload a document"
//   (https://html.spec.whatwg.org/multipage/document-lifecycle.html#unload-a-document):
//   while page showing is true, fire pagehide, then update the visibility
//   state to "hidden" (sub-steps 2 and 3 of step 10 in the 2026-10 text);
//   updating to an unchanged state fires nothing;
// - Chromium, third_party/blink/renderer/core/dom/document.cc
//   Document::DispatchUnloadEvents: pagehide, then, only if the page was
//   visible, visibilitychange under kUnloadVisibilityChangeInProgress; for the
//   back-forward cache, core/exported/web_view_impl.cc
//   WebViewImpl::SetPageLifecycleStateInternal: DispatchPagehide in
//   `if (dispatching_pagehide)` before SetVisibilityState in `if (hiding_page)`;
// - WebKit, Source/WebCore/loader/FrameLoader.cpp
//   FrameLoader::dispatchUnloadEvents: dispatchPagehideEvent, then
//   setVisibilityHiddenDueToDismissal(true), which fires visibilitychange.
//
// The fake does not fix one return order. Current sources make the document
// visible before pageshow(persisted): Chromium's SetPageLifecycleStateInternal
// runs `if (showing_page)` SetVisibilityState before DispatchPersistedPageshow,
// and WebKit's Source/WebCore/history/CachedPage.cpp firePageShowEvent calls
// setVisibilityHiddenDueToDismissal(false) before dispatchPageshowEvent. Real
// iOS order is still a device check and Gecko is not checked, so tests that
// care name the order. 'pageshow-only' makes the document visible without a
// visibilitychange event: it isolates the pageshow listeners, whose order the
// later visibility resume would otherwise mask.

export type BfcacheReturnOrder = 'pageshow-first' | 'visible-first' | 'pageshow-only';

export function setVisibility(state: DocumentVisibilityState, dispatch = true): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  if (dispatch) document.dispatchEvent(new Event('visibilitychange'));
}

function dispatchPageTransition(type: 'pagehide' | 'pageshow', persisted: boolean): void {
  actualWindow.dispatchEvent(new PageTransitionEvent(type, { persisted }));
}

/** A departure in the platform order above. */
function departDocument(persisted: boolean): void {
  const wasVisible = document.visibilityState !== 'hidden';
  dispatchPageTransition('pagehide', persisted);
  if (wasVisible) setVisibility('hidden');
}

// ─── Document fixture ───────────────────────────────────────────────
// The body children the wired owners touch, in index.html order: the header,
// the play tab with the .video-wrapper the fullscreen button targets
// (player-controls.ts:1283-1286), the setup screen, the mounted reset overlay
// (index.html:2987-3000), the app dialog, and the toast.

const FIXTURE = [
  '<header id="main-header"><button id="logo">Home</button></header>',
  '<div id="tab-play" class="tab-content active"><div class="tab-body"><div class="playback-stage">',
  '<div class="video-wrapper" id="video-wrapper"><button id="video-control">Video</button></div>',
  '</div><button id="control">Control</button></div></div>',
  '<div id="setup-overlay" class="onboarding-overlay"><button id="setup-start">Start</button></div>',
  '<div id="session-reset-overlay" class="session-reset-overlay" role="status" aria-live="assertive"',
  ' aria-atomic="true" aria-hidden="true" tabindex="-1" hidden>',
  '<p id="session-reset-message" class="session-reset-message"></p></div>',
  '<div class="dialog-overlay" id="dialog-overlay" aria-hidden="true"><div class="dialog">',
  '<button id="btn-dialog-ok">OK</button></div></div>',
  '<div id="toast" class="toast"></div>',
].join('');

// ─── App state ──────────────────────────────────────────────────────
// Stands in for core/state (network.appRole, setup.sessionStarted) and
// rooms/authority (room.context roomId). `setAppState` notifies the guard
// synchronously, as the bus 'state:*' subscriptions do (app.ts:976-978), and
// `appEntrance` stands for the bus 'setup:app-entrance' event (app.ts:979).
// `leaveSession` applies the state reset of network/peer.ts leaveSession
// (peer.ts:1245-1260); it tears down nothing else.

export interface AppStateModel {
  role: 'idle' | 'host' | 'guest';
  sessionStarted: boolean;
  roomId: string | null;
}

export const IN_ROOM: AppStateModel = { role: 'host', sessionStarted: true, roomId: '000001' };
export const OUTSIDE_ROOM: AppStateModel = { role: 'idle', sessionStarted: false, roomId: null };

export interface LazyFeatureOutcomes {
  readonly events: string[];
  answer: 'accept' | 'decline';
}

export interface PageNavigationShell {
  readonly sinks: NavigationSinks;
  readonly history: FakeBackHistory;
  readonly app: Readonly<AppStateModel>;
  readonly leaveSession: Mock<() => void>;
  /** The initPageNavigation `log` dependency (app.ts passes core/log). */
  readonly lifecycleLog: Mock<(message: string, ...args: unknown[]) => void>;
  readonly leaveConfirmation: { requests: number; answer: boolean };
  readonly lazyFeature: LazyFeatureOutcomes;
  readonly console: Record<'debug' | 'info' | 'warn' | 'error', Mock>;
  setAppState(patch: Partial<AppStateModel>): void;
  /** The 'setup:app-entrance' event (setup-shared.ts:310) the guard listens to. */
  appEntrance(): void;
  pagehide(persisted: boolean): void;
  pageshow(persisted: boolean): void;
  /**
   * A departure: pagehide, then visibilitychange(hidden) if the document was
   * visible (the platform order; see "Page transitions and visibility").
   */
  leaveDocument(persisted: boolean): void;
  /** A back-forward cache return, with the two events in the given order. */
  returnFromBfcache(order: BfcacheReturnOrder): void;
  /** Dispatch a cancelable beforeunload; true when the page asked to confirm. */
  beforeunloadPrompts(): boolean;
  /** The logo hard reset, player-controls.ts:1086-1101. */
  logoHardReset(options?: { importDelayMs?: number }): void;
  /** Lazy feature recovery, app.ts:1061-1094, on the real reload-recovery latch. */
  requestLazyFeatureRecovery(feature: string): void;
  /** Open the app dialog the way dialog.ts:576-578 does. */
  openDialog(options?: { closeOnBack?: boolean }): void;
  /** Close it the way dialog.ts:150-152 does. */
  closeDialog(): void;
  element(id: string): HTMLElement;
  resetMessage(): string | null;
  /** Run `cleanup` on dispose (a service-worker or fullscreen fake's restore). */
  addCleanup(cleanup: () => void): void;
  dispose(): void;
}

export interface BootOptions {
  readonly app?: AppStateModel;
  /** Whether a previous document sits behind this one in history. */
  readonly previousDocument?: boolean;
  readonly leaveAnswer?: boolean;
  /**
   * 'app' boots in app.ts order; 'guard-first' boots BackButtonGuard before
   * PageLifecycle, to show that no outcome depends on that order.
   */
  readonly initOrder?: 'app' | 'guard-first';
}

export function bootPageNavigationShell(options: BootOptions = {}): PageNavigationShell {
  // Every owner starts from its idle state.
  __resetSessionResetForTests();
  __resetDocumentReloadForTests();
  __resetIntentionalNavForTests();
  __resetModalStackForTests();
  document.documentElement.className = '';
  document.documentElement.lang = 'en';
  document.body.className = '';
  document.body.innerHTML = FIXTURE;
  sessionStorage.clear();
  actualWindow.history.replaceState(null, '', ROOM_PATH);

  const consoleSpies = {
    debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
  setVisibility('visible', false);
  const restoreFrames = installFrameClock();
  const sinks = stubNavigationSinks();

  const app: AppStateModel = { ...(options.app ?? OUTSIDE_ROOM) };
  const stateListeners = new Set<() => void>();
  const appEntranceListeners = new Set<() => void>();
  const setAppState = (patch: Partial<AppStateModel>): void => {
    Object.assign(app, patch);
    for (const listener of [...stateListeners]) listener();
  };
  const leaveSession = vi.fn(() => setAppState({ ...OUTSIDE_ROOM }));
  const lifecycleLog = vi.fn<(message: string, ...args: unknown[]) => void>();
  const history = new FakeBackHistory(options.previousDocument ?? true);
  const leaveConfirmation = { requests: 0, answer: options.leaveAnswer ?? true };
  const listeners = new AbortController();
  const disposers: Array<() => void> = [];

  // app.ts:1131 'OverlayObservers'.
  initOverlayObservers();

  // app.ts:1301-1324 'PageLifecycle'.
  const initPageLifecycle = (): void => {
    setSessionResetReleaseHandler(syncOverlayStateAfterExternalLock);
    const lifecycle = { getRole: () => app.role, leaveSession };
    const handlers = initPageLifecycleHandlers(lifecycle);
    disposers.push(() => handlers.dispose());
    const navigation = initPageNavigation({
      getRole: lifecycle.getRole,
      bfcacheReloadMessage: () => MSG_REFRESHING,
      log: { info: lifecycleLog },
    });
    disposers.push(() => navigation.dispose());
  };
  const signal = listeners.signal;
  if (options.initOrder !== 'guard-first') initPageLifecycle();

  // app.ts:915-990 'BackButtonGuard'. Changes: the history fake, the fixed
  // leave answer for showDialog, console for core/log, and the model's
  // listener sets for the bus.
  const backHistory = createBackButtonHistory({
    navigateHome: () => window.location.replace('/'),
    history,
    onNavigationError: (error) => console.warn('[App] Back navigation failed:', error),
  });
  disposers.push(() => backHistory.dispose());
  const controller = createBackButtonGuardController({
    isSessionActive: () =>
      isGuardedSession({ sessionStarted: app.sessionStarted, role: app.role, roomId: app.roomId }),
    hasOpenWindow,
    closeTopWindow: offerBackToTopWindow,
    whenSurfaceSettled: whenBackSurfaceSettled,
    isSurfaceReady: () =>
      !app.sessionStarted ||
      !document.getElementById('setup-overlay')?.classList.contains('active'),
    isDocumentVisible: () => document.visibilityState === 'visible',
    isNavigationPending: isSessionResetPending,
    currentHistoryPosition: backHistory.current,
    pushGuard: backHistory.pushGuard,
    navigateBack: () => history.back(),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    requestLeaveConfirmation: async () => {
      leaveConfirmation.requests += 1;
      return leaveConfirmation.answer;
    },
    onLeaveConfirmed: () => {
      const reset = scheduleSessionReset(MSG_LEAVING, () => {
        try {
          leaveSession();
        } catch (e) {
          console.warn('[App] leaveSession failed:', e);
        }
        backHistory.leave();
      });
      reset?.onRecovered(() => {
        backHistory.cancelLeave();
        controller.recoverNavigation();
      });
    },
    onSeedError: (error) => console.warn('[App] Back-button guard seed failed:', error),
    onConfirmationError: (error) => console.warn('[App] Back-button dialog failed:', error),
  });
  stateListeners.add(controller.handleStateChange);
  appEntranceListeners.add(controller.handleStateChange);
  disposers.push(onOverlayStackChange(controller.handleStateChange));
  window.addEventListener('popstate', controller.handlePopState, { signal });
  window.addEventListener('pagehide', controller.suspend, { signal });
  window.addEventListener('pageshow', controller.resume, { signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'hidden') controller.suspend();
      else controller.resume();
    },
    { signal },
  );
  controller.handleStateChange();
  if (options.initOrder === 'guard-first') initPageLifecycle();

  const lazyFeature: LazyFeatureOutcomes = { events: [], answer: 'accept' };
  const runLazyFeatureRecovery = createReloadRecoveryLatch<{ feature: string }>({
    async present() {
      lazyFeature.events.push('prompt');
      return lazyFeature.answer;
    },
    reload(_failure, onRecovered) {
      scheduleDocumentReload(MSG_REFRESHING, onRecovered);
    },
    onDeclined() {
      lazyFeature.events.push('declined');
    },
    onRecovered({ feature }) {
      lazyFeature.events.push(`recovered:${feature}`);
    },
    onPresentationFailure() {
      lazyFeature.events.push('presentation-failed');
    },
  });

  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`missing #${id}`);
    return found;
  };
  const closeDialog = (): void => {
    const dialog = element('dialog-overlay');
    dialog.classList.remove('show');
    dialog.setAttribute('aria-hidden', 'true');
    syncOverlayState();
  };

  return {
    sinks,
    history,
    app,
    leaveSession,
    lifecycleLog,
    leaveConfirmation,
    lazyFeature,
    console: consoleSpies,
    setAppState,
    appEntrance() {
      for (const listener of [...appEntranceListeners]) listener();
    },
    pagehide: (persisted) => dispatchPageTransition('pagehide', persisted),
    pageshow: (persisted) => dispatchPageTransition('pageshow', persisted),
    leaveDocument: departDocument,
    returnFromBfcache(order) {
      if (order === 'pageshow-first') {
        dispatchPageTransition('pageshow', true);
        setVisibility('visible');
      } else {
        setVisibility('visible', order === 'visible-first');
        dispatchPageTransition('pageshow', true);
      }
    },
    beforeunloadPrompts() {
      const event = new Event('beforeunload', { cancelable: true });
      actualWindow.dispatchEvent(event);
      return event.defaultPrevented;
    },
    logoHardReset({ importDelayMs = 0 } = {}) {
      // player-controls.ts loads this chunk with import(). The module is
      // preloaded here; `importDelayMs` charges a cold chunk load to the clock.
      const loadHardReset = () =>
        new Promise<typeof swHardReset>((resolve) => {
          if (importDelayMs > 0) globalThis.setTimeout(() => resolve(swHardReset), importDelayMs);
          else resolve(swHardReset);
        });
      let resetCurrent = true;
      const navigateIfCurrent = () => {
        if (resetCurrent) navigateToAppHome();
      };
      const resetHandle = scheduleSessionReset(MSG_LEAVING, () => {
        void loadHardReset()
          .then((module) => {
            if (resetCurrent) return module.default();
          })
          .then(navigateIfCurrent, navigateIfCurrent);
      });
      resetHandle?.onRecovered(() => {
        resetCurrent = false;
      });
    },
    requestLazyFeatureRecovery: (feature) => runLazyFeatureRecovery({ feature }),
    openDialog({ closeOnBack = false } = {}) {
      const dialog = element('dialog-overlay');
      if (closeOnBack) {
        // dialog.ts:871 closes on Back unless the dialog opts out.
        onWindowBack(
          dialog,
          () => {
            closeDialog();
            return true;
          },
          signal,
        );
      }
      dialog.classList.add('show');
      dialog.setAttribute('aria-hidden', 'false');
      syncOverlayState('dialog-overlay');
    },
    closeDialog,
    element,
    resetMessage: () => document.getElementById('session-reset-message')?.textContent ?? null,
    addCleanup(cleanup) {
      disposers.push(cleanup);
    },
    dispose() {
      listeners.abort();
      stateListeners.clear();
      appEntranceListeners.clear();
      for (const dispose of disposers.splice(0).reverse()) dispose();
      setSessionResetReleaseHandler(() => undefined);
      __resetSessionResetForTests();
      __resetDocumentReloadForTests();
      __resetIntentionalNavForTests();
      __resetModalStackForTests();
      vi.unstubAllGlobals();
      restoreFrames();
      Reflect.deleteProperty(document, 'visibilityState');
      for (const spy of Object.values(consoleSpies)) spy.mockRestore();
      document.body.innerHTML = '';
      document.documentElement.className = '';
      sessionStorage.clear();
      actualWindow.history.replaceState(null, '', '/');
    },
  };
}
