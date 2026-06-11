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
import { markIntentionalNav } from './core/page-lifecycle.ts';

const SW_UPDATE_KEY = 'sw-updated-at';
const SW_COOLDOWN_MS = 30_000; // suppress update dialog for 30s after a SW reload

let _swReloading = false;

function reloadForServiceWorkerUpdate(): void {
  if (_swReloading) return;
  _swReloading = true;
  sessionStorage.setItem(SW_UPDATE_KEY, String(Date.now()));
  markIntentionalNav();
  window.location.reload();
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

    try {
      const reg = await navigator.serviceWorker.register(swUrl, { scope: './' });
      log.info('[SW] Registered:', reg.scope);

      // Listen for controller changes — reload only when an already-controlled
      // page switches to another controller. A first-time `clients.claim()`
      // should not bounce the setup screen back to the app entrance.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) {
          hadController = true;
          log.debug('[SW] Controller claimed page for the first time — skipping reload');
          return;
        }

        // controllerchange fires in EVERY controlled same-origin tab when any
        // one of them accepts the update (skipWaiting activation migrates all
        // clients) — auto-reloading here silently killed live sessions in the
        // other tabs (markIntentionalNav even suppresses the leave prompt).
        // Defer for in-session tabs; the update applies on their next natural
        // load. Cost of keeping old JS under the new SW: production DOES ship
        // lazy chunks (i18n locale dicts, locale font CSS, the peerjs
        // adapter), and the new SW's activate handler purges prior-version
        // caches, so a deferred tab can 404 an old hashed chunk under deploy
        // skew. Each degrades gracefully: i18n falls back to English per-key
        // and stays retryable (re-select / 'online' — no negative caching),
        // fonts fall back to system faces, and the peerjs import rejection
        // propagates to the transport-fallback caller. Acceptable cost
        // versus auto-reload killing live sessions.
        // NOTE: this gate must stay OUT of reloadForServiceWorkerUpdate() —
        // the dialog-OK path below is explicit same-tab consent and must keep
        // reloading even mid-session.
        if (getState('network.appRole') !== 'idle') {
          log.info('[SW] Update activated elsewhere — deferring reload (session active)');
          showToast(t('dialog.sw_update_msg'));
          return;
        }

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
