/**
 * MUSIXQUARE 2.0 — Service Worker Registration
 *
 * Registers the service worker and handles update checks.
 * The service-worker.js itself remains in public/ as plain JS (outside Vite build).
 */

import { log } from './core/log.ts';
import { showDialog } from './ui/dialog.ts';

let _swWantsReload = false;
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
    // Relative URL resolved against current location (works under subpath deployments)
    const swUrl = new URL('service-worker.js', window.location.href);

    try {
      const reg = await navigator.serviceWorker.register(swUrl, { scope: './' });
      log.info('[SW] Registered:', reg.scope);

      // Listen for controller changes — reload only when we explicitly want to
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!_swWantsReload || _swReloading) return;
        _swReloading = true;
        window.location.reload();
      });

      // Update flow
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', async () => {
          // "installed" with an existing controller means: update is ready
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            try {
              const result = await showDialog({
                title: '업데이트',
                message: '새 버전이 준비되었습니다. 새로고침하면 업데이트가 적용됩니다.',
                buttonText: '새로고침',
                dismissible: true,
              });

              // Only proceed if user clicked OK
              if (!result || result.action !== 'ok') return;

              _swWantsReload = true;
              if (reg.waiting) {
                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
              } else {
                // Fallback: reload directly
                if (!_swReloading) {
                  _swReloading = true;
                  window.location.reload();
                }
              }
            } catch {
              // If dialog fails, do nothing
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

  // Handle case where 'load' already fired (readyState complete)
  if (document.readyState === 'complete') {
    doRegister();
  } else {
    window.addEventListener('load', doRegister, { once: true });
  }
}
