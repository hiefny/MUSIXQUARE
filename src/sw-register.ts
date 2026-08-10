/**
 * MUSIXQUARE — Service Worker Registration
 *
 * Registers the service worker and handles update checks.
 * The service-worker.js itself remains in public/ as plain JS (outside Vite build).
 */

import { log } from './core/log.ts';
import { t } from './i18n/index.ts';
import { getState } from './core/state.ts';
import { showDialog } from './ui/dialog.ts';
import { showToast } from './ui/toast.ts';
import { setManagedTimer } from './core/timers.ts';
import { scheduleSessionReset } from './core/session-reset.ts';

const SW_UPDATE_KEY = 'sw-updated-at';
const SW_CONTROLLER_CONFIRMED_KEY = 'sw-controller-confirmed-at';
// Avoid a second update prompt when controller activation and reload overlap.
const SW_COOLDOWN_MS = 30_000;
const CACHE_STATUS_REQUEST = 'MXQR_CACHE_STATUS_REQUEST';
const CACHE_CLIENT_STATUS = 'MXQR_CACHE_CLIENT_STATUS';
const CACHE_STATUS_PROBE = 'MXQR_CACHE_STATUS_PROBE';

let _swReloading = false;
let _swReloadAttempt: object | null = null;

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
  const resetHandle = scheduleSessionReset(t('dialog.refreshing_session'), () =>
    window.location.reload(),
  );

  const recoverReloadAttempt = () => {
    // A late recovery signal from an abandoned predecessor must never release
    // a successor's reload latch or activation state.
    if (_swReloadAttempt !== reloadAttempt) return;
    _swReloadAttempt = null;
    _swReloading = false;
    onRecovered();
  };

  if (!resetHandle) {
    recoverReloadAttempt();
    return;
  }
  resetHandle.onRecovered(recoverReloadAttempt);
}

function isReloadNavigation(): boolean {
  try {
    const navigation = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
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
    let activationState:
      | 'passive'
      | 'prompting'
      | 'awaiting-local-controller'
      | 'reload-scheduled' = 'passive';

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
      });
    };

    const handlePassiveControllerChange = () => {
      if (_swReloading || activationState === 'reload-scheduled') return;

      // Transitional recovery for the version that introduced this fix:
      // v267 could reload before skipWaiting/clients.claim completed. The new
      // document then receives the SAME activation as a late controllerchange.
      // Require a real reload navigation and the absence of a controller-
      // confirmed marker, so normal future updates and cloned sessionStorage
      // in newly opened tabs keep the cross-tab notification behavior.
      if (!updateFoundInThisDocument && isUnconfirmedRecentUpdateReload()) {
        log.info('[SW] Completing a pre-activation update reload without a duplicate notice');
        scheduleControllerAlignedReload();
        return;
      }

      // controllerchange fires in EVERY controlled same-origin tab when any
      // one of them accepts the update (skipWaiting activation migrates all
      // clients). Do not auto-reload another tab that is hosting or joined
      // to a live room; markIntentionalNav would also suppress its leave
      // prompt.
      if (getState('network.appRole') !== 'idle') {
        log.info('[SW] Update activated elsewhere — deferring reload (session active)');
        showToast(t('dialog.sw_update_msg'));
        return;
      }

      scheduleControllerAlignedReload();
    };

    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data as {
        type?: unknown;
        cacheVersion?: unknown;
        proactive?: unknown;
      } | null;
      if (!data || data.type !== CACHE_STATUS_REQUEST || typeof data.cacheVersion !== 'string') {
        return;
      }

      const controller = navigator.serviceWorker.controller;
      controller?.postMessage({
        type: CACHE_CLIENT_STATUS,
        cacheVersion: data.cacheVersion,
        ready: cacheSafeForCurrentController && controller === pageController,
        replyToRequest: data.proactive !== true,
      });
    });

    try {
      const reg = await navigator.serviceWorker.register(swUrl, { scope: '/' });
      log.info('[SW] Registered:', reg.scope);
      probeCacheStatus();

      // Listen for controller changes — reload only when an already-controlled
      // page switches to another controller. A first-time `clients.claim()`
      // should not bounce the setup screen back to the app entrance.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) {
          hadController = true;
          pageController = navigator.serviceWorker.controller;
          cacheSafeForCurrentController = true;
          probeCacheStatus();
          log.debug('[SW] Controller claimed page for the first time — skipping reload');
          return;
        }

        cacheSafeForCurrentController = false;
        probeCacheStatus();

        if (_swReloading || activationState === 'reload-scheduled') return;

        // An update may be activated by another tab while this tab's dialog is
        // still open. Defer the decision until the user chooses Refresh/Later
        // so a local Refresh remains authoritative and never produces a toast.
        if (activationState === 'prompting') {
          controllerChangedWhilePrompting = true;
          return;
        }

        if (activationState === 'awaiting-local-controller') {
          scheduleControllerAlignedReload();
          return;
        }

        handlePassiveControllerChange();
      });

      const handleWaitingWorker = async (worker: ServiceWorker): Promise<void> => {
        if (!navigator.serviceWorker.controller || handledWaitingWorker === worker) return;
        if (activationState !== 'passive') return;
        handledWaitingWorker = worker;
        updateFoundInThisDocument = true;

        const lastUpdate = Number(readSessionMarker(SW_UPDATE_KEY) || '0');
        const inCooldown = Date.now() - lastUpdate < SW_COOLDOWN_MS;
        if (inCooldown) {
          log.debug('[SW] Update found during cooldown — silently activating');
          worker.postMessage({ type: 'SKIP_WAITING' });
          return;
        }

        activationState = 'prompting';
        controllerChangedWhilePrompting = false;
        let result: Awaited<ReturnType<typeof showDialog>> | undefined;
        try {
          result = await showDialog({
            title: t('dialog.sw_update_title'),
            message: t('dialog.sw_update_msg'),
            buttonText: t('common.refresh'),
            secondaryText: t('common.later'),
          });
        } catch {
          result = undefined;
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
        log.debug('[SW] Update dialog dismissed — skipping local activation');
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
            void handleWaitingWorker(reg.waiting || newWorker);
          }
        });
      });

      // updatefound only reports future installations. A worker can already
      // be waiting after a prior "Later" choice or a background-tab update.
      if (reg.waiting && navigator.serviceWorker.controller) {
        void handleWaitingWorker(reg.waiting);
      }

      // Check for updates periodically (every 60 minutes)
      setManagedTimer(
        'sw-update-check',
        () => {
          reg.update().catch(() => {
            /* ignore */
          });
        },
        60 * 60 * 1000,
        { interval: true },
      );
      // Immediate update check
      reg.update().catch(() => {
        /* ignore */
      });
    } catch (err) {
      log.warn('[SW] Registration failed:', err);
    }
  };

  if (document.readyState === 'complete') {
    doRegister();
  } else {
    window.addEventListener('load', doRegister, { once: true });
  }
}
