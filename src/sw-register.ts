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
// Avoid a second update prompt when controller activation and reload overlap.
const SW_COOLDOWN_MS = 30_000;
const CACHE_STATUS_REQUEST = 'MXQR_CACHE_STATUS_REQUEST';
const CACHE_CLIENT_STATUS = 'MXQR_CACHE_CLIENT_STATUS';
const CACHE_STATUS_PROBE = 'MXQR_CACHE_STATUS_PROBE';

let _swReloading = false;

function reloadForServiceWorkerUpdate(): void {
  if (_swReloading) return;
  _swReloading = true;
  sessionStorage.setItem(SW_UPDATE_KEY, String(Date.now()));
  scheduleSessionReset(t('dialog.refreshing_session'), () => window.location.reload());
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
    const swUrl = new URL('service-worker.js', window.location.href);
    let hadController = Boolean(navigator.serviceWorker.controller);
    // Controller under which the JS currently executing in this tab loaded.
    // If the active controller changes without a reload, this page may still
    // import old Vite-hashed chunks and cannot approve old-cache retirement.
    let pageController = navigator.serviceWorker.controller;
    let cacheSafeForCurrentController = true;

    const probeCacheStatus = () => {
      navigator.serviceWorker.controller?.postMessage({ type: CACHE_STATUS_PROBE });
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
      const reg = await navigator.serviceWorker.register(swUrl, { scope: './' });
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

        // controllerchange fires in EVERY controlled same-origin tab when any
        // one of them accepts the update (skipWaiting activation migrates all
        // clients). Do not auto-reload another tab that is hosting or joined
        // to a live room; markIntentionalNav would also suppress its leave
        // prompt.
        // Defer for in-session tabs; the update applies on their next natural
        // load. The page/worker cache-status handshake marks this controller
        // switch as unsafe, so prior-version caches (including old Vite-hashed
        // lazy chunks) remain until every live tab has naturally reloaded.
        // NOTE: this gate must stay OUT of reloadForServiceWorkerUpdate() —
        // the dialog-OK path below is explicit same-tab consent and must keep
        // reloading even mid-session.
        if (getState('network.appRole') !== 'idle') {
          cacheSafeForCurrentController = false;
          probeCacheStatus();
          log.info('[SW] Update activated elsewhere — deferring reload (session active)');
          showToast(t('dialog.sw_update_msg'));
          return;
        }

        cacheSafeForCurrentController = false;
        reloadForServiceWorkerUpdate();
      });

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', async () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // Evaluate cooldown at event time (not registration time) to avoid stale closure
            const lastUpdate = Number(sessionStorage.getItem(SW_UPDATE_KEY) || '0');
            const inCooldown = Date.now() - lastUpdate < SW_COOLDOWN_MS;

            // During cooldown: silently activate, no dialog
            if (inCooldown) {
              log.debug('[SW] Update found during cooldown — silently activating');
              if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
              return;
            }

            try {
              const result = await showDialog({
                title: t('dialog.sw_update_title'),
                message: t('dialog.sw_update_msg'),
                buttonText: t('common.refresh'),
                secondaryText: t('common.later'),
              });

              // Activate + reload only if user clicked Refresh.
              if (result && result.action === 'ok') {
                if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                reloadForServiceWorkerUpdate();
              }
            } catch {
              // Dialog dismissed or failed — do NOT activate the waiting worker.
              // The update will be applied on next natural page load.
              log.debug('[SW] Update dialog dismissed — skipping activation');
            }
          }
        });
      });

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
