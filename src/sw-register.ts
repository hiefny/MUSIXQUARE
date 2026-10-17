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
import { scheduleDocumentReload, scheduleSessionReset } from './core/session-reset.ts';
import {
  getRoomContext,
  isStandardRoomRole,
  subscribeRoomAuthorityLifecycle,
} from './rooms/authority.ts';
import {
  createServiceWorkerGenerationResolver,
  createServiceWorkerUpdateLedger,
} from './sw-update-coordination.ts';

const SW_UPDATE_KEY = 'sw-updated-at';
const SW_CONTROLLER_CONFIRMED_KEY = 'sw-controller-confirmed-at';
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
// Read by setup's join error after the reload, as for a reconnect.
const RECONNECT_TARGET_KEY = 'mxqr_reconnect_target';
const CACHE_STATUS_REQUEST = 'MXQR_CACHE_STATUS_REQUEST';
const CACHE_CLIENT_STATUS = 'MXQR_CACHE_CLIENT_STATUS';
const CACHE_STATUS_PROBE = 'MXQR_CACHE_STATUS_PROBE';
export const NAVIGATION_SOURCE_EVENT = 'mxqr:navigation-source';

type NavigationSource = 'network' | 'cache-fallback';

let _swReloading = false;
let _swReloadAttempt: object | null = null;

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

function removeSessionMarker(key: string): void {
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    // Best-effort marker cleanup only.
  }
}

/**
 * Where an update reload returns. Anyone in a room except a standard-room host
 * goes back to that room's Start screen (its /CODE invite page), so entering
 * again takes one tap; the reload cannot enter by itself, because the browser
 * needs that tap before it plays sound. A host reopens the room from the start
 * screen, and a page outside a room reloads in place.
 */
function updateReturnPath(): string | null {
  if (isStandardRoomRole('host')) return null;
  if (!getState('setup.sessionStarted') && getRoomContext().roomId === null) return null;
  const code = getState('network.lastJoinCode');
  return typeof code === 'string' && /^\d{6}$/.test(code) ? `/${code}` : null;
}

function reloadForServiceWorkerUpdate(onRecovered: () => void): void {
  if (_swReloading) return;
  const reloadAttempt = {};
  _swReloading = true;
  _swReloadAttempt = reloadAttempt;
  const confirmedAt = Date.now();
  writeSessionMarker(SW_UPDATE_KEY, String(confirmedAt));
  // Every caller reaches this seam only after controllerchange (or after
  // proving that navigator.serviceWorker.controller already changed). A new
  // document can therefore distinguish this aligned reload from the legacy
  // v267 flow, which reloaded before activation completed.
  writeSessionMarker(SW_CONTROLLER_CONFIRMED_KEY, String(confirmedAt));
  const recoverReloadAttempt = () => {
    // A late recovery signal from an abandoned predecessor must never release
    // a successor's reload latch or activation state.
    if (_swReloadAttempt !== reloadAttempt) return;
    _swReloadAttempt = null;
    _swReloading = false;
    onRecovered();
  };

  const returnPath = updateReturnPath();
  if (returnPath) {
    writeSessionMarker(RECONNECT_TARGET_KEY, returnPath.slice(1));
    const resetHandle = scheduleSessionReset(t('dialog.refreshing_session'), () => {
      window.location.href = returnPath;
    });
    if (resetHandle) resetHandle.onRecovered(recoverReloadAttempt);
    else recoverReloadAttempt();
    return;
  }
  scheduleDocumentReload(t('dialog.refreshing_session'), recoverReloadAttempt);
}

function isReloadNavigation(): boolean {
  try {
    const navigation = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    return navigation?.type === 'reload';
  } catch {
    return false;
  }
}

function isUnconfirmedRecentUpdateReload(): boolean {
  if (!isReloadNavigation()) return false;
  const updatedAt = Number(readSessionMarker(SW_UPDATE_KEY) || '0');
  const controllerConfirmedAt = Number(readSessionMarker(SW_CONTROLLER_CONFIRMED_KEY) || '0');
  const age = Date.now() - updatedAt;
  return updatedAt > 0 && age >= 0 && age < SW_COOLDOWN_MS && controllerConfirmedAt < updatedAt;
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

/** Resolve once no page resource has finished for a moment, or at the cap. */
function waitForQuietPageLoad(): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const check = () => {
      const now = performance.now();
      let lastResponseEnd = startedAt;
      try {
        for (const entry of performance.getEntriesByType('resource')) {
          lastResponseEnd = Math.max(
            lastResponseEnd,
            (entry as PerformanceResourceTiming).responseEnd || 0,
          );
        }
      } catch {
        // Without resource timing the quiet period starts with the wait.
      }
      if (
        now - lastResponseEnd >= STARTUP_PROMPT_QUIET_MS ||
        now - startedAt >= STARTUP_PROMPT_MAX_WAIT_MS
      ) {
        resolve();
        return;
      }
      globalThis.setTimeout(check, STARTUP_PROMPT_POLL_MS);
    };
    check();
  });
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
    let activationState:
      'passive' | 'prompting' | 'awaiting-local-controller' | 'reload-scheduled' = 'passive';
    // Generations put off with Later (or Back) in this document. The same
    // dialog returns the next time the app opens.
    const dismissedPromptIdentities = new Set<string>();
    // Generations another tab already applied, offered as a reload once.
    const offeredActivatedUpdates = new Set<string>();

    const probeCacheStatus = () => {
      navigator.serviceWorker.controller?.postMessage({ type: CACHE_STATUS_PROBE });
    };

    const scheduleControllerAlignedReload = () => {
      if (activationState === 'reload-scheduled' || _swReloading) return;
      activationState = 'reload-scheduled';
      reloadForServiceWorkerUpdate(() => {
        // The same document is still alive, so a failed/no-op/cancelled reset
        // may accept one later controllerchange. A committed pagehide never
        // resolves the reset handle and therefore remains first-wins.
        if (activationState === 'reload-scheduled') activationState = 'passive';
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
      if (_swReloading || activationState === 'reload-scheduled') return false;

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

      // controllerchange fires in EVERY controlled same-origin tab when any
      // one of them accepts the update (skipWaiting activation migrates all
      // clients). Do not auto-reload another tab that is hosting or joined
      // to a live room, or running the demo; markIntentionalNav would also
      // suppress its leave prompt. It asks with the update dialog instead,
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

    if (pageController) {
      const initialController = pageController;
      observedControllerObjects.add(initialController);
      generationResolver
        .resolve(initialController)
        .then((generation) => {
          if (pageController !== initialController || !generation.cacheVersion) return;
          pageCacheVersion = generation.cacheVersion;
          handledControllerGenerations.add(generation.cacheVersion);
        })
        .catch(() => {
          /* the cache-status probe remains the fallback generation source */
        });
    }

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

        if (_swReloading || activationState === 'reload-scheduled') {
          pendingControllerAfterReload = controller;
          return;
        }
        handledControllerGenerations.add(actionIdentity);
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
          if (controller) {
            observedControllerObjects.add(controller);
            generationResolver
              .resolve(controller)
              .then((generation) => {
                if (pageController !== controller || !generation.cacheVersion) return;
                pageCacheVersion = generation.cacheVersion;
                handledControllerGenerations.add(generation.cacheVersion);
              })
              .catch(() => {
                /* the cache-status message can still identify this generation */
              });
          }
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
        if (_swReloading || activationState === 'reload-scheduled') {
          // Record the newest exact controller synchronously. Recovery must
          // not depend on an old/mixed worker's generation timeout before it
          // can reserve the successor reload and pagehide boundary.
          pendingControllerAfterReload = controller;
        } else if (activationState === 'prompting') {
          controllerChangedWhilePrompting = true;
          controllerChangesWithReservedAction.add(controller);
        } else if (activationState === 'awaiting-local-controller') {
          controllerChangesWithReservedAction.add(controller);
          scheduleControllerAlignedReload();
        } else if (activationState === 'passive' && handlePassiveControllerChange(false)) {
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
        if (activationState !== 'passive') return;
        handledWaitingWorker = worker;
        updateFoundInThisDocument = true;
        const waitingWorkerIsCurrent = () =>
          handledWaitingWorker === worker && reg.waiting === worker && worker.state === 'installed';
        const continueWithReplacement = () => {
          const replacement = reg.waiting;
          if (!replacement || replacement === worker || activationState !== 'passive') return;
          handleWaitingWorker(replacement).catch((error) => {
            log.warn('[SW] Replacement waiting worker handling failed', error);
          });
        };

        if (!waitingWorkerIsCurrent()) {
          continueWithReplacement();
          return;
        }

        const lastUpdate = Number(readSessionMarker(SW_UPDATE_KEY) || '0');
        if (Date.now() - lastUpdate < SW_COOLDOWN_MS) {
          log.debug('[SW] Update found during cooldown. Silently activating');
          worker.postMessage({ type: 'SKIP_WAITING' });
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
          worker.postMessage({ type: 'SKIP_WAITING' });
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
          if (_swReloading || activationState !== 'passive') return;
        }
        const promptAbort = new AbortController();
        if (!(await updateLedger.acquirePrompt(generation, () => promptAbort.abort()))) {
          log.debug('[SW] Waiting worker prompt owned by another app client');
          return;
        }
        if (!waitingWorkerIsCurrent() || activationState !== 'passive') {
          updateLedger.releasePrompt(generation);
          continueWithReplacement();
          return;
        }

        activationState = 'prompting';
        controllerChangedWhilePrompting = false;
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
          activationState = 'passive';
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
            activationState = 'awaiting-local-controller';
            const requestedAt = Date.now();
            writeSessionMarker(SW_UPDATE_KEY, String(requestedAt));
            removeSessionMarker(SW_CONTROLLER_CONFIRMED_KEY);
            replacement.postMessage({ type: 'SKIP_WAITING' });
            return;
          }

          activationState = 'passive';
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
          if (_swReloading) return;
          activationState = 'awaiting-local-controller';
          const requestedAt = Date.now();
          writeSessionMarker(SW_UPDATE_KEY, String(requestedAt));
          removeSessionMarker(SW_CONTROLLER_CONFIRMED_KEY);

          if (
            controllerChangedWhilePrompting ||
            navigator.serviceWorker.controller !== pageController
          ) {
            scheduleControllerAlignedReload();
            return;
          }

          worker.postMessage({ type: 'SKIP_WAITING' });
          return;
        }

        activationState = 'passive';
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

      // Check for updates periodically (every 60 minutes)
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
        60 * 60 * 1000,
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
