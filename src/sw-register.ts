// Resource owner: RO-22 (waiting service worker activation).
/**
 * MUSIXQUARE — Service Worker Registration
 *
 * Registers the service worker and handles update checks.
 * Vite compiles the strict service-worker TypeScript source to the stable /service-worker.js URL.
 */

import { log } from './core/log.ts';
import { t, type I18nKey } from './i18n/index.ts';
import { getState } from './core/state.ts';
import { showDialog, type DialogResult } from './ui/dialog.ts';
import { setManagedTimer } from './core/timers.ts';
import {
  isSessionResetPending,
  onNavigationPendingChange,
  scheduleDocumentReload,
} from './core/session-reset.ts';
import { returnToRoomStart } from './core/navigation.ts';
import {
  getRoomContext,
  isStandardRoomRole,
  subscribeRoomAuthorityLifecycle,
} from './rooms/authority.ts';
import {
  CACHE_CLIENT_STATUS,
  CACHE_STATUS_PROBE,
  CACHE_STATUS_REQUEST,
  UPDATE_CHECK_INTERVAL_MS,
  createServiceWorkerGenerationResolver,
  createServiceWorkerUpdateLedger,
} from './sw-update-coordination.ts';
import { SW_CONTROLLER_CONFIRMED_KEY, SW_UPDATE_KEY } from './core/navigation-contract.ts';

// Avoid a second update prompt when controller activation and reload overlap.
const SW_COOLDOWN_MS = 30_000;
// Measured in Chromium (2026-10-17): SKIP_WAITING sent while the active worker
// still served the page's first loads took 43-66 s to activate, and sending it
// again did not shorten that; sent once those loads had settled, it took under
// 1.5 s. A waiting update found when the page opens is therefore offered once
// the page's own requests have been quiet for a moment, so Apply is prompt.
const STARTUP_PROMPT_QUIET_MS = 1_000;
const STARTUP_PROMPT_MAX_WAIT_MS = 6_000;
const STARTUP_PROMPT_POLL_MS = 250;
export const NAVIGATION_SOURCE_EVENT = 'mxqr:navigation-source';

type NavigationSource = 'network' | 'cache-fallback';

/** Where the update prompt stands: the machine's state while no update reload is scheduled. */
type PromptPhase = 'passive' | 'prompting' | 'awaiting-local-controller';

/**
 * The update reload the machine asked the navigation owner for. `reload` is
 * the identity that reload's one recovery callback carries: only that
 * recovery releases this state, so a stale recovery cannot release a
 * successor. A prompt still answering while the reload is pending (it lost its
 * lease, failed, or was answered) leaves its phase in `prompt`: that phase
 * decides whether a newly waiting worker is taken up, and the page returns to
 * it if the reload recovers, as before C6-9.
 */
interface ReloadScheduled {
  readonly phase: 'reload-scheduled';
  readonly reload: object;
  readonly prompt: PromptPhase | null;
}

/**
 * The update machine's one state (RO-22, Phase 3 C6-9): a prompt phase, or
 * the scheduled reload (the only object variant).
 */
type ActivationState = PromptPhase | ReloadScheduled;

/**
 * The update machine's one SKIP_WAITING sink. The callers write the
 * next-document markers themselves, before it: an Apply and the logo's hard
 * reset record their request, the quiet promotions (cooldown, same
 * generation) record nothing.
 */
function activateWaitingWorker(worker: ServiceWorker): void {
  worker.postMessage({ type: 'SKIP_WAITING' });
}

/**
 * The logo reset's port into the update machine (RO-22, Phase 3 C6-10): the
 * lazy core/sw-hard-reset.ts dispatches this event on the page's service-worker
 * container in the reset's prepare step, and the machine answers in
 * `detail.claim` before dispatchEvent returns; the hard reset then waits for
 * the activation. An event, not an import: importing this module statically
 * from the logo (player-controls.ts) or from the lazy chunk reorders the eager
 * bundle (measured on 2026-10-24: +0.7 KB eager gzip either way, against
 * +0.3 KB for the whole of C6-10 with the event). core/sw-hard-reset.ts keeps
 * its own copy of the name; the tests pin both
 * (src/core/__tests__/__helpers__/hard-reset-port.ts).
 */
const HARD_RESET_CLAIM_EVENT = 'mxqr:hard-reset-claim';

/**
 * The machine's answer (owner decisions P3-8 A, P3-9 A and P3-12 A,
 * 2026-10-24): 'promoted' (it applied the waiting update without asking,
 * through its one sink, and withdrew a prompt shown or queued),
 * 'apply-in-flight' (an Apply already sent SKIP_WAITING: the hard reset waits
 * for that activation and sends nothing), 'none' (no waiting worker, or the
 * page's loads are not quiet yet: the logo goes home on time and the next page
 * offers the update) or 'unavailable' (no machine yet, the page is quiet: the
 * hard reset's own promotion runs).
 */
export type HardResetClaim = 'promoted' | 'apply-in-flight' | 'none' | 'unavailable';

/** The detail of HARD_RESET_CLAIM_EVENT. */
export interface HardResetClaimRequest {
  claim?: HardResetClaim;
  /**
   * The URL of the hard reset's own chunk: the browser loaded it for this tap,
   * so its load does not count as the page still loading.
   */
  chunk?: string;
}

function publishNavigationSource(navigationFallback: boolean): void {
  const source: NavigationSource = navigationFallback ? 'cache-fallback' : 'network';
  document.documentElement.dataset.mxqrNavigationSource = source;
  window.dispatchEvent(
    new CustomEvent<{ source: NavigationSource }>(NAVIGATION_SOURCE_EVENT, { detail: { source } }),
  );
}

function readSessionMarker(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSessionMarker(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // Storage can be denied in private/embedded contexts; updates must proceed.
  }
}

/**
 * Where an update reload returns. Anyone in a room except a standard-room host
 * goes back to that room's Start screen (its /CODE invite page), so entering
 * again takes one tap; the reload cannot enter by itself, because the browser
 * needs that tap before it plays sound. A host reopens the room from the start
 * screen, and a page outside a room reloads in place (null). returnToRoomStart
 * checks the code and reloads in place for anything but a room code.
 */
function updateReturnCode(): unknown {
  if (isStandardRoomRole('host')) return null;
  if (!getState('setup.sessionStarted') && getRoomContext().roomId === null) return null;
  return getState('network.lastJoinCode');
}

/** This tab asked a waiting worker to activate (Apply, or the logo's hard reset). */
function markActivationRequested(): void {
  writeSessionMarker(SW_UPDATE_KEY, String(Date.now()));
  try {
    globalThis.sessionStorage?.removeItem(SW_CONTROLLER_CONFIRMED_KEY);
  } catch {
    // Best-effort marker cleanup only.
  }
}

/**
 * This tab saw the new controller. Both markers carry the same moment, so a
 * new document can tell this from the legacy v267 flow, which reloaded before
 * activation completed.
 */
function markControllerConfirmed(): void {
  const confirmedAt = String(Date.now());
  writeSessionMarker(SW_UPDATE_KEY, confirmedAt);
  writeSessionMarker(SW_CONTROLLER_CONFIRMED_KEY, confirmedAt);
}

/**
 * Ask the navigation owner for the update reload. `onRecovered` runs at most
 * once, if this document stays (the reload never committed, or another
 * navigation held the page).
 */
function reloadForServiceWorkerUpdate(onRecovered: () => void): void {
  // Every caller reaches this seam only after controllerchange (or after
  // proving that navigator.serviceWorker.controller already changed).
  markControllerConfirmed();

  const message = t('dialog.refreshing_session');
  returnToRoomStart(updateReturnCode(), {
    message,
    // setup's join error reads the room after the reload, as for a reconnect.
    reconnect: true,
    fallback: () => scheduleDocumentReload(message, onRecovered),
    onRecovered,
  });
}

/** When this tab last asked for an activation it has not seen land yet, or 0. */
function unconfirmedActivationRequest(): number {
  const updatedAt = Number(readSessionMarker(SW_UPDATE_KEY) || '0');
  return Number(readSessionMarker(SW_CONTROLLER_CONFIRMED_KEY) || '0') < updatedAt ? updatedAt : 0;
}

function isUnconfirmedRecentUpdateReload(): boolean {
  try {
    const navigation = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    if (navigation?.type !== 'reload') return false;
  } catch {
    return false;
  }
  const updatedAt = unconfirmedActivationRequest();
  const age = Date.now() - updatedAt;
  return updatedAt > 0 && age >= 0 && age < SW_COOLDOWN_MS;
}

/**
 * Whether this tab is in a room (standard or PRO), including a provisional one
 * that setup is still creating or joining. `network.appRole` alone is not
 * enough: PRO presence re-entry (after a phone wakes from a lock longer than
 * the presence TTL, or an account detach) projects `idle` for two network
 * round trips while the room UI, `setup.sessionStarted`, and the PRO room
 * context stay up. A real leave clears all three together.
 */
function isRoomSessionActive(): boolean {
  if (getState('network.appRole') !== 'idle') return true;
  return getState('setup.sessionStarted') || getRoomContext().roomId !== null;
}

/** Whether the guided demo is running or loading. */
function isDemoStateActive(): boolean {
  return getState('demo.active') === true || getState('demo.loading') === true;
}

/** The demo surface stays up during its exit curtain, after the state clears. */
function isDemoSurfaceVisible(): boolean {
  try {
    return document.body?.classList.contains('mode-demo') === true;
  } catch {
    return false;
  }
}

/** Whether a reload would take this device out of a room or the demo. */
function isRoomOrDemoActive(): boolean {
  return isRoomSessionActive() || isDemoStateActive() || isDemoSurfaceVisible();
}

/**
 * When this page's latest resource finished, or `since` if later or unknown;
 * the resource at `except` (the URL of the hard reset's own chunk) is left out.
 */
function lastResponseEnd(since: number, except?: string): number {
  let last = since;
  try {
    for (const entry of performance.getEntriesByType('resource')) {
      if (entry.name === except) continue;
      last = Math.max(last, (entry as PerformanceResourceTiming).responseEnd || 0);
    }
  } catch {
    // Without resource timing the quiet period starts at `since`.
  }
  return last;
}

/**
 * Owner decision (2026-10-17): every update is offered with the same dialog,
 * rooms and the demo included, and nothing promises that a browser reload
 * applies it. In a room the text says what applying costs: a standard-room
 * host's room closes (its code ends with the page even before Start), and
 * anyone else in a room has to enter it again.
 */
function updateDialogMessageKey(): I18nKey {
  if (isStandardRoomRole('host')) return 'dialog.sw_update_room_host_msg';
  if (getState('setup.sessionStarted') || getRoomContext().roomId !== null) {
    return 'dialog.sw_update_room_guest_msg';
  }
  return 'dialog.sw_update_apply_msg';
}

/**
 * The update dialog. Its message is re-read whenever the room lifecycle
 * changes: a join can finish while it is open, and 적용하기 then returns to
 * that room's Start screen, so the copy must already say so.
 */
function showUpdateDialog(signal?: AbortSignal): Promise<DialogResult> {
  return showDialog({
    title: t('dialog.sw_update_title'),
    message: () => t(updateDialogMessageKey()),
    buttonText: t('dialog.sw_update_apply'),
    secondaryText: t('common.later'),
    refreshOn: subscribeRoomAuthorityLifecycle,
    ...(signal ? { signal } : {}),
  });
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    log.info('[SW] Service Worker not supported');
    return;
  }

  if (!window.isSecureContext) {
    log.info('[SW] Not a secure context, skipping registration');
    return;
  }

  /**
   * No resource of this page finished within STARTUP_PROMPT_QUIET_MS, so a
   * SKIP_WAITING sent now activates at once (the Chromium rule above).
   */
  const isPageQuietNow = (except?: string): boolean =>
    performance.now() - lastResponseEnd(-Infinity, except) >= STARTUP_PROMPT_QUIET_MS;

  /** Resolve once no page resource has finished for a moment, or at the cap. */
  const waitForQuietPageLoad = (): Promise<void> =>
    new Promise((resolve) => {
      const startedAt = performance.now();
      const check = () => {
        const now = performance.now();
        if (
          now - lastResponseEnd(startedAt) >= STARTUP_PROMPT_QUIET_MS ||
          now - startedAt >= STARTUP_PROMPT_MAX_WAIT_MS
        ) {
          resolve();
          return;
        }
        globalThis.setTimeout(check, STARTUP_PROMPT_POLL_MS);
      };
      check();
    });

  // The logo's hard reset asks here (HARD_RESET_CLAIM_EVENT). Until the
  // machine exists (the window load event, then registration) it may promote
  // on its own, once the page's loads are quiet (P3-12 A, P3-9 A).
  let claimForHardReset = (chunk?: string): HardResetClaim =>
    isPageQuietNow(chunk) ? 'unavailable' : 'none';
  navigator.serviceWorker.addEventListener(HARD_RESET_CLAIM_EVENT, (event) => {
    const request = (event as CustomEvent<HardResetClaimRequest>).detail;
    request.claim = claimForHardReset(request.chunk);
  });

  const doRegister = async () => {
    // Room invite pages live at /CODE. Keep one origin-wide registration
    // instead of resolving the worker and scope relative to that invite URL.
    const swUrl = '/service-worker.js';
    let hadController = Boolean(navigator.serviceWorker.controller);
    // Controller under which the JS currently executing in this tab loaded.
    // If the active controller changes without a reload, this page may still
    // import old Vite-hashed chunks and cannot approve old-cache retirement.
    let pageController = navigator.serviceWorker.controller;
    let cacheSafeForCurrentController = true;
    let updateFoundInThisDocument = false;
    let controllerChangedWhilePrompting = false;
    let handledWaitingWorker: ServiceWorker | null = null;
    let pageCacheVersion: string | null = null;
    let controllerChangeQueue = Promise.resolve();
    let pendingControllerAfterReload: ServiceWorker | null = null;
    let unknownControllerSequence = 0;
    const generationResolver = createServiceWorkerGenerationResolver();
    const updateLedger = createServiceWorkerUpdateLedger();
    const observedControllerObjects = new WeakSet<ServiceWorker>();
    const controllerChangesWithReservedAction = new WeakSet<ServiceWorker>();
    const unknownControllerIdentities = new WeakMap<ServiceWorker, string>();
    const handledControllerGenerations = new Set<string>();
    let handleControllerGeneration: (controller: ServiceWorker) => Promise<void> = async () =>
      undefined;
    let activationState: ActivationState = 'passive';
    const isReloadScheduled = (): boolean => typeof activationState === 'object';
    /** The prompt's phase: what it last left, also while a reload is scheduled. */
    const promptPhase = (): PromptPhase | ReloadScheduled['phase'] =>
      typeof activationState === 'object'
        ? activationState.prompt || activationState.phase
        : activationState;
    /**
     * The abort of the latest prompt: the logo and an absorbed activation
     * withdraw a prompt still shown or queued (aborting a finished one does
     * nothing).
     */
    let openPrompt: AbortController | null = null;
    /**
     * Put a controller change's decision off while a navigation holds the
     * page: it runs if that navigation releases the page in this document,
     * and never if it commits (Phase 3 C6-10, owner decision P3-8 A).
     */
    const deferWhileNavigating = (decide: () => void): boolean => {
      if (!isSessionResetPending()) return false;
      const stopWatching = onNavigationPendingChange(() => {
        if (isSessionResetPending()) return;
        stopWatching();
        decide();
      });
      return true;
    };
    /**
     * The generation of this page's code while an earlier document of this
     * tab asked for an activation (Apply, or the logo's hard reset) and did
     * not see it land: that activation, arriving here, is absorbed (C6-10,
     * owner decision P3-10 A). Null outside a production build.
     */
    let absorbGeneration =
      typeof __MXQR_BUILD_CACHE_VERSION__ === 'string' && unconfirmedActivationRequest()
        ? __MXQR_BUILD_CACHE_VERSION__
        : null;
    /** The prompt moves on; while a reload is scheduled, that waits for the reload's recovery. */
    const setPromptPhase = (phase: PromptPhase): void => {
      activationState =
        typeof activationState === 'object' ? { ...activationState, prompt: phase } : phase;
    };
    // Generations put off with Later (or Back) in this document. The same
    // dialog returns the next time the app opens.
    const dismissedPromptIdentities = new Set<string>();
    // Generations another tab already applied, offered as a reload once.
    const offeredActivatedUpdates = new Set<string>();

    const probeCacheStatus = () => {
      navigator.serviceWorker.controller?.postMessage({ type: CACHE_STATUS_PROBE });
    };

    const scheduleControllerAlignedReload = () => {
      if (isReloadScheduled()) return;
      const reload = {};
      activationState = { phase: 'reload-scheduled', reload, prompt: null };
      reloadForServiceWorkerUpdate(() => {
        // A late recovery from an abandoned predecessor must never release a
        // successor's reload.
        if (typeof activationState !== 'object' || activationState.reload !== reload) return;
        // The same document is still alive, so a failed/no-op/cancelled reset
        // may accept one later controllerchange. A committed pagehide never
        // resolves the reset handle and therefore remains first-wins.
        activationState = activationState.prompt || 'passive';
        const pendingController = pendingControllerAfterReload;
        pendingControllerAfterReload = null;
        if (pendingController && navigator.serviceWorker.controller === pendingController) {
          // A second controller may arrive while the first reload is still
          // waiting to commit. If that reload recovers/no-ops, reserve the
          // successor alignment immediately; an old successor worker may not
          // answer the generation protocol for another 750 ms.
          controllerChangesWithReservedAction.add(pendingController);
          scheduleControllerAlignedReload();
          controllerChangeQueue = controllerChangeQueue
            .then(() => handleControllerGeneration(pendingController))
            .catch((error) => {
              log.warn('[SW] Pending controller generation handling failed', error);
            });
        }
      });
    };

    /**
     * Another tab applied an update while this one is in a room or the demo.
     * This page still runs the old code until it reloads, so ask with the
     * same dialog instead of reloading out of the room. Later keeps the room;
     * the next open loads the new version.
     */
    const offerActivatedUpdate = (promptIdentity: string): void => {
      if (
        offeredActivatedUpdates.has(promptIdentity) ||
        dismissedPromptIdentities.has(promptIdentity)
      ) {
        return;
      }
      offeredActivatedUpdates.add(promptIdentity);
      showUpdateDialog()
        .then((result) => {
          if (result.action === 'ok') scheduleControllerAlignedReload();
        })
        .catch((error) => {
          log.warn('[SW] Activated update dialog failed', error);
        });
    };

    const offerActivatedControllerUpdate = (): void => {
      const controller = navigator.serviceWorker.controller;
      if (!controller) return;
      // Keyed as the waiting prompt is (an unidentified worker by its script
      // URL), so a generation put off with 나중에 there is not offered again
      // here. The resolution is cached per worker.
      generationResolver.resolve(controller).then(
        (generation) => offerActivatedUpdate(generation.promptIdentity),
        (error) => log.warn('[SW] Activated update generation failed', error),
      );
    };

    const handlePassiveControllerChange = (notifyActiveRoom = true): boolean => {
      if (isReloadScheduled()) return false;

      // Transitional recovery for the version that introduced this fix:
      // v267 could reload before skipWaiting/clients.claim completed. The new
      // document then receives the SAME activation as a late controllerchange.
      // Require a real reload navigation and the absence of a controller-
      // confirmed marker, so normal future updates and cloned sessionStorage
      // in newly opened tabs keep the cross-tab notification behavior.
      if (!updateFoundInThisDocument && isUnconfirmedRecentUpdateReload()) {
        log.info('[SW] Completing a pre-activation update reload without a duplicate notice');
        scheduleControllerAlignedReload();
        return true;
      }

      // A navigation holds the page, such as the logo's hard reset after its
      // own activation: no update dialog under its reset screen and no second
      // reload request; the decision waits for the page. This tab saw the new
      // controller, which the markers record now, as the aligned reload this
      // replaces recorded it when it queued.
      if (deferWhileNavigating(handlePassiveControllerChange)) {
        markControllerConfirmed();
        return true;
      }

      // controllerchange fires in EVERY controlled same-origin tab when any
      // one of them accepts the update (skipWaiting activation migrates all
      // clients). Do not auto-reload another tab that is hosting or joined
      // to a live room, or running the demo; the reload's unload-exemption
      // claim would also suppress its leave prompt. It asks with the update dialog instead,
      // once per generation.
      if (isRoomOrDemoActive()) {
        if (!notifyActiveRoom) return false;
        log.info('[SW] Update activated elsewhere. Asking before reloading (room or demo active)');
        offerActivatedControllerUpdate();
        return true;
      }

      scheduleControllerAlignedReload();
      return true;
    };

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (generationResolver.consumeMessage(event.data)) return;
      const data = event.data as {
        type?: unknown;
        cacheVersion?: unknown;
        proactive?: unknown;
        navigationFallback?: unknown;
      } | null;
      if (!data || data.type !== CACHE_STATUS_REQUEST || typeof data.cacheVersion !== 'string') {
        return;
      }

      if (typeof data.navigationFallback === 'boolean') {
        publishNavigationSource(data.navigationFallback);
      }

      const controller = navigator.serviceWorker.controller;
      if (cacheSafeForCurrentController && controller === pageController) {
        pageCacheVersion = data.cacheVersion;
        handledControllerGenerations.add(data.cacheVersion);
      }
      controller?.postMessage({
        type: CACHE_CLIENT_STATUS,
        cacheVersion: data.cacheVersion,
        ready: cacheSafeForCurrentController && controller === pageController,
        pageCacheVersion,
        replyToRequest: data.proactive !== true,
      });
    });

    /** The page's code loaded under `controller`: record that worker's generation as the page's. */
    const adoptPageGeneration = (controller: ServiceWorker): void => {
      observedControllerObjects.add(controller);
      generationResolver
        .resolve(controller)
        .then((generation) => {
          if (pageController !== controller || !generation.cacheVersion) return;
          pageCacheVersion = generation.cacheVersion;
          handledControllerGenerations.add(generation.cacheVersion);
        })
        .catch(() => {
          /* the cache-status probe and message remain the fallback generation source */
        });
    };

    if (pageController) adoptPageGeneration(pageController);

    try {
      const reg = await navigator.serviceWorker.register(swUrl, { scope: '/' });
      log.info('[SW] Registered:', reg.scope);
      probeCacheStatus();

      // Listen for controller changes — reload only when an already-controlled
      // page switches to another controller. A first-time `clients.claim()`
      // should not bounce the setup screen back to the app entrance.
      handleControllerGeneration = async (controller: ServiceWorker): Promise<void> => {
        const generation = await generationResolver.resolve(controller);
        if (navigator.serviceWorker.controller !== controller) {
          // The lifecycle action for an idle/prompt hand-off was already
          // reserved synchronously. Preserve a late exact identity so a rapid
          // replacement using that same generation cannot schedule a second
          // action after a no-op reload recovers. Active-room continuations do
          // not reserve an action and must leave the winning controller free
          // to emit its one generation-scoped toast.
          if (generation.cacheVersion && controllerChangesWithReservedAction.has(controller)) {
            handledControllerGenerations.add(generation.cacheVersion);
          }
          return;
        }
        let actionIdentity = generation.cacheVersion;
        if (!actionIdentity) {
          actionIdentity = unknownControllerIdentities.get(controller) || null;
          if (!actionIdentity) {
            actionIdentity = `unknown-controller:${(unknownControllerSequence += 1).toString(36)}`;
            unknownControllerIdentities.set(controller, actionIdentity);
          }
        }
        if (handledControllerGenerations.has(actionIdentity)) {
          // A rapid successor can be recorded as the pending controller while
          // the current reload is still latched. Once its exact generation is
          // proven to be the generation whose lifecycle action already won,
          // suppress that redundant successor reload before recovery consumes
          // the pending slot. Unknown/mixed workers intentionally stay pending.
          if (pendingControllerAfterReload === controller) {
            pendingControllerAfterReload = null;
          }
          return;
        }

        // Idle reloads and prompt/approval hand-offs reserve their lifecycle
        // action synchronously in controllerchange. CACHE_VERSION is an
        // asynchronous protocol (and an old worker may need the full timeout),
        // so it must only finish cross-object generation bookkeeping here. In
        // particular, do not leave a 750 ms window in which pagehide can beat
        // installation of the reset coordinator's commit listener.
        if (controllerChangesWithReservedAction.has(controller)) {
          handledControllerGenerations.add(actionIdentity);
          return;
        }

        if (isReloadScheduled()) {
          pendingControllerAfterReload = controller;
          return;
        }
        handledControllerGenerations.add(actionIdentity);
        if (actionIdentity === absorbGeneration) {
          // The activation an earlier document of this tab asked for, and
          // this page already runs that generation's code: no reload, no
          // update dialog, no toast (owner decision P3-10 A). The page is now
          // aligned with its controller, as after the aligned reload.
          absorbGeneration = null;
          pageController = controller;
          cacheSafeForCurrentController = true;
          markControllerConfirmed();
          if (openPrompt) openPrompt.abort();
          probeCacheStatus();
          return;
        }
        if (activationState === 'prompting') {
          controllerChangedWhilePrompting = true;
          return;
        }
        if (activationState === 'awaiting-local-controller') {
          scheduleControllerAlignedReload();
          return;
        }
        handlePassiveControllerChange(true);
      };

      const handleControllerChange = () => {
        const controller = navigator.serviceWorker.controller;
        if (!hadController) {
          hadController = true;
          pageController = controller;
          cacheSafeForCurrentController = true;
          probeCacheStatus();
          if (controller) adoptPageGeneration(controller);
          log.debug('[SW] Controller claimed page for the first time. Skipping reload');
          return;
        }

        if (!controller || observedControllerObjects.has(controller)) return;
        observedControllerObjects.add(controller);
        cacheSafeForCurrentController = false;
        probeCacheStatus();

        // Reserve navigation-sensitive work before asking the worker for its
        // generation. New workers normally answer immediately, but mixed-version
        // upgrades legitimately time out. Active-room notifications remain
        // generation-gated so two wrapper objects for one controller generation
        // cannot produce duplicate update toasts.
        if (isReloadScheduled()) {
          // Record the newest exact controller synchronously. Recovery must
          // not depend on an old/mixed worker's generation timeout before it
          // can reserve the successor reload and pagehide boundary.
          pendingControllerAfterReload = controller;
        } else if (activationState === 'awaiting-local-controller') {
          controllerChangesWithReservedAction.add(controller);
          // While a navigation holds the page (the logo's hard reset waiting
          // for this Apply), the Apply's reload waits for it (P3-8 A); the
          // markers record the new controller now, as that reload would.
          if (deferWhileNavigating(scheduleControllerAlignedReload)) markControllerConfirmed();
          else scheduleControllerAlignedReload();
        } else if (absorbGeneration) {
          // Whether this is the activation an earlier document of this tab
          // asked for needs the worker's generation (P3-10 A): decided there.
        } else if (activationState === 'prompting') {
          controllerChangedWhilePrompting = true;
          controllerChangesWithReservedAction.add(controller);
        } else if (handlePassiveControllerChange(false)) {
          controllerChangesWithReservedAction.add(controller);
        }

        controllerChangeQueue = controllerChangeQueue
          .then(() => handleControllerGeneration(controller))
          .catch((error) => {
            log.warn('[SW] Controller generation handling failed', error);
          });
      };
      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
      // Another tab can activate a controller while register() is pending.
      // Reconcile the current identity after subscribing so that change is not lost.
      if (navigator.serviceWorker.controller !== pageController) handleControllerChange();

      const handleWaitingWorker = async (
        worker: ServiceWorker,
        foundAtStartup = false,
      ): Promise<void> => {
        if (!navigator.serviceWorker.controller || handledWaitingWorker === worker) return;
        if (promptPhase() !== 'passive') return;
        handledWaitingWorker = worker;
        updateFoundInThisDocument = true;
        const waitingWorkerIsCurrent = () =>
          handledWaitingWorker === worker && reg.waiting === worker && worker.state === 'installed';
        const continueWithReplacement = () => {
          const replacement = reg.waiting;
          if (!replacement || replacement === worker || promptPhase() !== 'passive') return;
          handleWaitingWorker(replacement).catch((error) => {
            log.warn('[SW] Replacement waiting worker handling failed', error);
          });
        };

        // The quiet promotions (cooldown, same generation) send once the
        // page's own loads have settled (owner decision P3-9 A), if the worker
        // is still this one's to handle (the logo's hard reset takes it).
        const activateWhenQuiet = async (): Promise<void> => {
          await waitForQuietPageLoad();
          if (waitingWorkerIsCurrent()) activateWaitingWorker(worker);
        };

        if (!waitingWorkerIsCurrent()) {
          continueWithReplacement();
          return;
        }

        const lastUpdate = Number(readSessionMarker(SW_UPDATE_KEY) || '0');
        if (Date.now() - lastUpdate < SW_COOLDOWN_MS) {
          log.debug('[SW] Update found during cooldown. Silently activating');
          await activateWhenQuiet();
          return;
        }

        const generation = await generationResolver.resolve(worker);
        if (worker.state === 'activated' || worker.state === 'redundant') return;
        let activeController = navigator.serviceWorker.controller;
        let activeGeneration = activeController
          ? await generationResolver.resolve(activeController)
          : null;
        if (navigator.serviceWorker.controller !== activeController) {
          activeController = navigator.serviceWorker.controller;
          activeGeneration = activeController
            ? await generationResolver.resolve(activeController)
            : null;
        }
        if (navigator.serviceWorker.controller !== activeController) return;
        if (!waitingWorkerIsCurrent()) {
          continueWithReplacement();
          return;
        }
        const activeCacheVersion =
          activeGeneration?.cacheVersion ||
          (activeController === pageController ? pageCacheVersion : null);
        if (generation.cacheVersion && activeCacheVersion === generation.cacheVersion) {
          log.warn('[SW] Waiting worker reused the active cache generation; activating silently');
          await activateWhenQuiet();
          return;
        }
        if (dismissedPromptIdentities.has(generation.promptIdentity)) {
          log.debug('[SW] Update put off with Later in this page');
          return;
        }
        if (updateLedger.isDismissed(generation)) {
          log.debug('[SW] Waiting worker prompt cooling down for this generation');
          return;
        }
        // A worker already waiting when this page opened is offered once the
        // page's own loads settle, so Apply is not held up behind them.
        if (foundAtStartup) {
          await waitForQuietPageLoad();
          if (navigator.serviceWorker.controller !== activeController) return;
          if (!waitingWorkerIsCurrent()) {
            continueWithReplacement();
            return;
          }
          if (activationState !== 'passive') return;
        }
        const promptAbort = new AbortController();
        if (!(await updateLedger.acquirePrompt(generation, () => promptAbort.abort()))) {
          log.debug('[SW] Waiting worker prompt owned by another app client');
          return;
        }
        if (!waitingWorkerIsCurrent() || promptPhase() !== 'passive') {
          updateLedger.releasePrompt(generation);
          continueWithReplacement();
          return;
        }

        setPromptPhase('prompting');
        controllerChangedWhilePrompting = false;
        openPrompt = promptAbort;
        let result: Awaited<ReturnType<typeof showDialog>> | undefined;
        try {
          result = await showUpdateDialog(promptAbort.signal);
        } catch {
          result = undefined;
        }
        updateLedger.releasePrompt(generation);
        // History Back on the prompt is the same choice as Later.
        const dismissedByUser = result?.action === 'secondary' || result?.action === 'back';

        if (promptAbort.signal.aborted) {
          // Losing a best-effort legacy election is not a user dismissal and
          // must not suppress the winning tab's prompt or a newer generation.
          setPromptPhase('passive');
          if (controllerChangedWhilePrompting) handlePassiveControllerChange();
          continueWithReplacement();
          return;
        }

        if (!waitingWorkerIsCurrent()) {
          const replacement =
            reg.waiting && reg.waiting !== worker && reg.waiting.state === 'installed'
              ? reg.waiting
              : null;
          const controllerAlreadyChanged =
            controllerChangedWhilePrompting ||
            navigator.serviceWorker.controller !== pageController;

          if (result?.action === 'ok' && replacement) {
            handledWaitingWorker = replacement;
            setPromptPhase('awaiting-local-controller');
            markActivationRequested();
            activateWaitingWorker(replacement);
            return;
          }

          setPromptPhase('passive');
          if (controllerAlreadyChanged) {
            controllerChangedWhilePrompting = false;
            if (result?.action === 'ok') {
              scheduleControllerAlignedReload();
              return;
            }
            // Later already answered this generation; a room is not asked twice.
            if (dismissedByUser) dismissedPromptIdentities.add(generation.promptIdentity);
            handlePassiveControllerChange();
            return;
          }

          if (replacement) {
            const replacementGeneration = await generationResolver.resolve(replacement);
            if (reg.waiting === replacement && replacement.state === 'installed') {
              handledWaitingWorker = replacement;
              if (dismissedByUser) {
                dismissedPromptIdentities.add(replacementGeneration.promptIdentity);
              } else {
                updateLedger.rememberPresentationFailure(replacementGeneration);
              }
            }
          }
          return;
        }

        if (result?.action === 'ok') {
          if (isReloadScheduled()) return;
          activationState = 'awaiting-local-controller';
          markActivationRequested();

          if (
            controllerChangedWhilePrompting ||
            navigator.serviceWorker.controller !== pageController
          ) {
            scheduleControllerAlignedReload();
            return;
          }

          activateWaitingWorker(worker);
          return;
        }

        setPromptPhase('passive');
        // Later lasts for this page only: the next open asks again.
        if (dismissedByUser) {
          dismissedPromptIdentities.add(generation.promptIdentity);
        } else {
          updateLedger.rememberPresentationFailure(generation);
        }
        log.debug('[SW] Update dialog dismissed. Skipping local activation');
        if (controllerChangedWhilePrompting) {
          controllerChangedWhilePrompting = false;
          handlePassiveControllerChange();
        }
      };

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            handleWaitingWorker(reg.waiting || newWorker).catch((error) => {
              log.warn('[SW] Waiting worker prompt failed', error);
            });
          }
        });
      });

      // updatefound only reports future installations. A worker can already
      // be waiting after a prior "Later" choice or a background-tab update.
      if (reg.waiting && navigator.serviceWorker.controller) {
        handleWaitingWorker(reg.waiting, true).catch((error) => {
          log.warn('[SW] Existing waiting worker prompt failed', error);
        });
      }

      // The machine answers the logo now. A worker it promotes is the hard
      // reset's: no prompt or quiet promotion of this document takes it up.
      claimForHardReset = (chunk) => {
        if (activationState === 'awaiting-local-controller') return 'apply-in-flight';
        const worker = reg.waiting;
        if (
          isReloadScheduled() ||
          !worker ||
          worker.state !== 'installed' ||
          !isPageQuietNow(chunk)
        ) {
          return 'none';
        }
        if (openPrompt) openPrompt.abort();
        handledWaitingWorker = null;
        markActivationRequested();
        activateWaitingWorker(worker);
        return 'promoted';
      };

      // Check for updates periodically (every 60 minutes, the check lease interval).
      setManagedTimer(
        'sw-update-check',
        () => {
          if (
            document.visibilityState === 'hidden' ||
            navigator.onLine === false ||
            !updateLedger.claimUpdateCheck()
          ) {
            return;
          }
          reg.update().catch(() => {
            /* ignore */
          });
        },
        UPDATE_CHECK_INTERVAL_MS,
        { interval: true },
      );
      // Immediate update check
      if (
        document.visibilityState !== 'hidden' &&
        navigator.onLine !== false &&
        updateLedger.claimUpdateCheck()
      ) {
        reg.update().catch(() => {
          /* ignore */
        });
      }
    } catch (err) {
      log.warn('[SW] Registration failed:', err);
    }
  };

  const startRegistration = (): void => {
    doRegister().catch((error) => {
      log.warn('[SW] Registration escaped its internal failure boundary', error);
    });
  };

  if (document.readyState === 'complete') startRegistration();
  else window.addEventListener('load', startRegistration, { once: true });
}
