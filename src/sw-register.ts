/**
 * MUSIXQUARE 2.0 — Service Worker Registration
 *
 * Registers the service worker and handles update checks.
 * The service-worker.js itself remains in public/ as plain JS (outside Vite build).
 */

import { log } from './core/log.ts';

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    log.info('[SW] Service Worker not supported');
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((reg) => {
        log.info('[SW] Registered:', reg.scope);

        // Check for updates periodically (every 60 minutes)
        setInterval(() => {
          reg.update().catch(() => { /* ignore */ });
        }, 60 * 60 * 1000);

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
              log.info('[SW] New version activated');
            }
          });
        });
      })
      .catch((err) => {
        log.warn('[SW] Registration failed:', err);
      });
  });
}
