/**
 * MUSIXQUARE — Service Worker Registration
 *
 * Registers the service worker and handles update checks.
 * Vite compiles the strict service-worker TypeScript source to the stable /service-worker.js URL.
 */

import { log } from './core/log.ts';
import { bus } from './core/events.ts';
import { t, type I18nKey } from './i18n/index.ts';
import { getState } from './core/state.ts';
import { showDialog } from './ui/dialog.ts';
import { showToast } from './ui/toast.ts';
import { setManagedTimer } from './core/timers.ts';
import { isStandaloneDisplayMode } from './core/platform.ts';
import { isSessionResetPending, scheduleDocumentReload } from './core/session-reset.ts';
import { announceSystemMessageLocally } from './chat/protocol.ts';
import { getRoomContext, subscribeRoomAuthorityLifecycle } from './rooms/authority.ts';
import {
  createServiceWorkerGenerationResolver,
  createServiceWorkerUpdateLedger,
} from './sw-update-coordination.ts';

const SW_UPDATE_KEY = 'sw-updated-at';
const SW_CONTROLLER_CONFIRMED_KEY = 'sw-controller-confirmed-at';
// Avoid a second update prompt when controller activation and reload overlap.
const SW_COOLDOWN_MS = 30_000;
// Let an in-place leave, the demo exit curtain, or a reset navigation settle
// before a prompt that a room or the demo deferred is offered on setup.
// Native timer: leaveSession() clears managed timers.
const DEFERRED_PROMPT_SETTLE_MS = 1_000;
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

/**
 * Owner policy (2026-10-11): rooms and the demo never get the blocking update
 * dialog. A live event must not be interrupted, and accepting would reload
 * this device out of the room. They get a local chat notice instead.
 */
function isUpdatePromptDeferred(): boolean {
  return isRoomSessionActive() || isDemoStateActive() || isDemoSurfaceVisible();
}

/** A deferral that only waits for a transient leave/exit to finish. */
function isDeferralTransient(): boolean {
  return !isRoomSessionActive() && !isDemoStateActive();
}

function updateNoticeKey(): I18nKey {
  // A home-screen app has no reload control; it applies on its next launch.
  return isStandaloneDisplayMode()
    ? 'chat.update_available_app_system_message'
    : 'chat.update_available_tab_system_message';
}

function isChatSurfaceAvailable(): boolean {
  // Chat is a room surface: outside a room (a demo with no room) it cannot be
  // opened, and while setup still covers a provisional room (creating a code,
  // joining) it is hidden, so the notice would not be seen there.
  return (
    isRoomSessionActive() &&
    document.getElementById('chat-messages') !== null &&
    document.getElementById('setup-overlay')?.classList.contains('active') !== true
  );
}

/**
 * Show the update notice on this device only. It never goes to peers: the
 * update state is per device, and a broadcast would tell every guest to
 * reload. Without a chat surface it falls back to a toast (unless this
 * generation already had one), never a dialog. Returns whether the room chat
 * now shows it.
 */
function postLocalUpdateNotice(toastShown: boolean): boolean {
  const key = updateNoticeKey();
  if (isChatSurfaceAvailable()) {
    try {
      announceSystemMessageLocally(key);
      return true;
    } catch (error) {
      log.warn('[SW] Chat update notice failed; using a toast', error);
    }
  }
  if (!toastShown) showToast(t(key));
  return false;
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
    // Generations already announced in this document, so a waiting worker, a
    // re-check, and another tab's activation of that generation share one notice.
    // 'toast' marks a notice that only a toast could show (setup still covering
    // a provisional room, or a demo with no room). A toast does not use up the
    // chat notice: the room chat still gets it once it can be seen.
    const announcedUpdateNotices = new Map<string, 'chat' | 'toast'>();
    let noticeUpgradeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    // The open prompt, so entering a room or the demo can retract it.
    let activePromptAbort: AbortController | null = null;
    let activePromptIdentity: string | null = null;
    let activePromptDeferredByRoom = false;
    // A waiting worker whose prompt a room or the demo deferred. No dismissal
    // was stored, so returning to setup offers it once.
    let deferredPromptWorker: ServiceWorker | null = null;
    let deferredPromptTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

    const probeCacheStatus = () => {
      navigator.serviceWorker.controller?.postMessage({ type: CACHE_STATUS_PROBE });
    };

    const announceAvailableUpdate = (identity: string): void => {
      const announced = announcedUpdateNotices.get(identity);
      if (announced === 'chat') return;
      if (announced === 'toast' && !isChatSurfaceAvailable()) return;
      announcedUpdateNotices.set(
        identity,
        postLocalUpdateNotice(announced === 'toast') ? 'chat' : 'toast',
      );
    };

    // Setup starts a room and hides its overlay in the same task, so look
    // once the lifecycle signal's task has finished. The copy names no
    // version, so one chat row covers every generation that had only a toast.
    const upgradeToastNotices = (): void => {
      noticeUpgradeTimer = null;
      if (!isChatSurfaceAvailable()) return;
      const toastOnly = [...announcedUpdateNotices]
        .filter(([, channel]) => channel === 'toast')
        .map(([identity]) => identity);
      const [first, ...rest] = toastOnly;
      if (first === undefined) return;
      announceAvailableUpdate(first);
      if (announcedUpdateNotices.get(first) !== 'chat') return;
      for (const identity of rest) announcedUpdateNotices.set(identity, 'chat');
    };
    const scheduleToastNoticeUpgrade = (): void => {
      if (noticeUpgradeTimer !== null) return;
      if (![...announcedUpdateNotices.values()].includes('toast')) return;
      noticeUpgradeTimer = globalThis.setTimeout(upgradeToastNotices, 0);
    };
    // The user's own answer to the dialog replaces a toast-only notice.
    const forgetToastNotice = (identity: string): void => {
      if (announcedUpdateNotices.get(identity) === 'toast') {
        announcedUpdateNotices.delete(identity);
      }
    };

    const announceActivatedUpdate = (identity: string | null): void => {
      if (identity) {
        announceAvailableUpdate(identity);
        return;
      }
      const controller = navigator.serviceWorker.controller;
      if (!controller) {
        announceAvailableUpdate('unknown-controller');
        return;
      }
      // Cached per worker: an exact generation dedupes with the waiting
      // worker's notice for the same release.
      generationResolver.resolve(controller).then(
        (generation) => {
          announceAvailableUpdate(
            generation.cacheVersion ||
              unknownControllerIdentities.get(controller) ||
              'unknown-controller',
          );
        },
        () => announceAvailableUpdate('unknown-controller'),
      );
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

    const handlePassiveControllerChange = (
      notifyActiveRoom = true,
      controllerIdentity: string | null = null,
    ): boolean => {
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
      // suppress its leave prompt. It gets the same local notice as a
      // waiting update, once per generation.
      if (isUpdatePromptDeferred()) {
        if (!notifyActiveRoom) return false;
        log.info('[SW] Update activated elsewhere. Deferring reload (room or demo active)');
        announceActivatedUpdate(controllerIdentity);
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
        handlePassiveControllerChange(true, actionIdentity);
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

      const handleWaitingWorker = async (worker: ServiceWorker): Promise<void> => {
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
        // An automatic "Later" for a room or the demo. Storing no dismissal
        // keeps this generation eligible for one prompt back on setup.
        const deferPromptForRoom = (promptIdentity: string) => {
          deferredPromptWorker = worker;
          announceAvailableUpdate(promptIdentity);
          if (isDeferralTransient()) armDeferredPromptRetry();
        };

        if (!waitingWorkerIsCurrent()) {
          continueWithReplacement();
          return;
        }

        const lastUpdate = Number(readSessionMarker(SW_UPDATE_KEY) || '0');
        const inCooldown = Date.now() - lastUpdate < SW_COOLDOWN_MS;
        if (inCooldown) {
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
        if (updateLedger.isDismissed(generation)) {
          log.debug('[SW] Waiting worker prompt already dismissed for this generation');
          return;
        }
        if (isUpdatePromptDeferred()) {
          log.info('[SW] Update waiting in a room or the demo. Posting a local notice');
          deferPromptForRoom(generation.promptIdentity);
          return;
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
        if (isUpdatePromptDeferred()) {
          // The election can take a few frames; a room or demo may start meanwhile.
          updateLedger.releasePrompt(generation);
          deferPromptForRoom(generation.promptIdentity);
          return;
        }

        activationState = 'prompting';
        controllerChangedWhilePrompting = false;
        activePromptAbort = promptAbort;
        activePromptIdentity = generation.promptIdentity;
        activePromptDeferredByRoom = false;
        let result: Awaited<ReturnType<typeof showDialog>> | undefined;
        try {
          result = await showDialog({
            title: t('dialog.sw_update_title'),
            message: t('dialog.sw_update_msg'),
            buttonText: t('common.refresh'),
            secondaryText: t('common.later'),
            signal: promptAbort.signal,
          });
        } catch {
          result = undefined;
        }
        const deferredByRoom = activePromptDeferredByRoom;
        activePromptAbort = null;
        activePromptIdentity = null;
        activePromptDeferredByRoom = false;
        updateLedger.releasePrompt(generation);

        if (promptAbort.signal.aborted) {
          // Losing a best-effort legacy election is not a user dismissal and
          // must not suppress the winning tab's prompt or a newer generation.
          // Neither is a prompt retracted because a room or the demo started.
          activationState = 'passive';
          if (deferredByRoom && waitingWorkerIsCurrent()) {
            deferPromptForRoom(generation.promptIdentity);
          }
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
            if (result?.action === 'ok') scheduleControllerAlignedReload();
            else handlePassiveControllerChange();
            return;
          }

          if (replacement) {
            const replacementGeneration = await generationResolver.resolve(replacement);
            if (reg.waiting === replacement && replacement.state === 'installed') {
              handledWaitingWorker = replacement;
              if (result?.action === 'secondary') {
                updateLedger.rememberDismissal(replacementGeneration);
                forgetToastNotice(replacementGeneration.promptIdentity);
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
        if (result?.action === 'secondary') {
          updateLedger.rememberDismissal(generation);
          forgetToastNotice(generation.promptIdentity);
        } else {
          updateLedger.rememberPresentationFailure(generation);
        }
        log.debug('[SW] Update dialog dismissed. Skipping local activation');
        if (controllerChangedWhilePrompting) {
          controllerChangedWhilePrompting = false;
          handlePassiveControllerChange();
        }
      };

      // Back on setup after a room or the demo: offer a deferred, undismissed
      // generation once through the normal path (cooldown, generation checks,
      // dismissal ledger, and cross-tab election all still apply).
      const retryDeferredPrompt = () => {
        deferredPromptTimer = null;
        if (!deferredPromptWorker) return;
        // Back in a room or the demo: the next lifecycle change re-arms this.
        if (!isDeferralTransient()) return;
        // A leave or reset navigation is still committing, or the demo
        // curtain is still up. A reload makes the next document decide.
        if (isSessionResetPending() || isDemoSurfaceVisible()) {
          armDeferredPromptRetry();
          return;
        }
        deferredPromptWorker = null;
        // A reload is already on its way, or a prompt is already up.
        if (_swReloading || activationState !== 'passive') return;
        const waiting = reg.waiting;
        if (!waiting || waiting.state !== 'installed' || !navigator.serviceWorker.controller)
          return;
        handledWaitingWorker = null;
        handleWaitingWorker(waiting).catch((error) => {
          log.warn('[SW] Deferred waiting worker prompt failed', error);
        });
      };
      function armDeferredPromptRetry(): void {
        if (deferredPromptTimer !== null) globalThis.clearTimeout(deferredPromptTimer);
        deferredPromptTimer = globalThis.setTimeout(retryDeferredPrompt, DEFERRED_PROMPT_SETTLE_MS);
      }
      const handleUpdatePromptContextChange = () => {
        if (isUpdatePromptDeferred() && activationState === 'prompting' && activePromptAbort) {
          // Entering a room or the demo retracts an open or queued prompt.
          // Post the notice now; a queued dialog resolves only when it is
          // dequeued.
          activePromptDeferredByRoom = true;
          if (activePromptIdentity) announceAvailableUpdate(activePromptIdentity);
          activePromptAbort.abort();
          scheduleToastNoticeUpgrade();
          return;
        }
        if (deferredPromptWorker && isDeferralTransient()) armDeferredPromptRetry();
        scheduleToastNoticeUpgrade();
      };
      subscribeRoomAuthorityLifecycle(handleUpdatePromptContextChange);
      bus.on('state:demo.active', handleUpdatePromptContextChange);
      bus.on('state:demo.loading', handleUpdatePromptContextChange);

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
        handleWaitingWorker(reg.waiting).catch((error) => {
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
