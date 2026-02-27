/**
 * MUSIXQUARE 2.0 — Service Worker Registration
 *
 * Registers the service worker and handles update checks.
 * The service-worker.js itself remains in public/ as plain JS (outside Vite build).
 */

import { log } from './core/log.ts';
import { showDialog } from './ui/dialog.ts';

const SW_UPDATE_KEY = 'sw-updated-at';
const SW_COOLDOWN_MS = 30_000; // suppress update dialog for 30s after a SW reload

let _swReloading = false;

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

    try {
      const reg = await navigator.serviceWorker.register(swUrl, { scope: './' });
      log.info('[SW] Registered:', reg.scope);

      // Listen for controller changes — reload only once
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (_swReloading) return;
        _swReloading = true;
        sessionStorage.setItem(SW_UPDATE_KEY, String(Date.now()));
        window.location.reload();
      });

      // Check if we just reloaded from a SW update — skip dialog during cooldown
      const lastUpdate = Number(sessionStorage.getItem(SW_UPDATE_KEY) || '0');
      const inCooldown = Date.now() - lastUpdate < SW_COOLDOWN_MS;

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', async () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // During cooldown: silently activate, no dialog
            if (inCooldown) {
              log.debug('[SW] Update found during cooldown — silently activating');
              if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
              return;
            }

            try {
              const result = await showDialog({
                title: '업데이트',
                message: '새 버전이 준비되었습니다. 새로고침하면 업데이트가 적용됩니다.',
                buttonText: '새로고침',
                dismissible: true,
              });

              // Activate waiting worker regardless
              if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });

              // Reload only if user clicked OK
              if (result && result.action === 'ok') {
                if (!_swReloading) {
                  _swReloading = true;
                  sessionStorage.setItem(SW_UPDATE_KEY, String(Date.now()));
                  window.location.reload();
                }
              }
            } catch {
              if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            }
          }
        });
      });

      // Check for updates periodically (every 60 minutes)
      setInterval(() => {
        reg.update().catch(() => { /* ignore */ });
      }, 60 * 60 * 1000);
      // Immediate update check
      reg.update().catch(() => { /* ignore */ });
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
