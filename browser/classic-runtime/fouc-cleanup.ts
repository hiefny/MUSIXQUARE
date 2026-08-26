/**
 * MUSIXQUARE FOUC guard cleanup (index.html)
 *
 * Adds `body.fouc-loaded` once the main stylesheet has parsed (detected
 * via the --bg CSS variable that style.css defines on :root). The stylesheet
 * has its own `body { opacity: 0 }` rule that gets overridden when the
 * class is added.
 *
 * Falls back to a 3s timeout in case the stylesheet never loads (offline /
 * network failure) so the page isn't permanently blank.
 *
 * The guard lives in style.css so the CSP does not require inline styles;
 * this script only toggles the reveal class.
 */

(function installFoucCleanup() {
  let revealed = false;
  let timedOut = false;

  function failOpenSetupBootGuard(): void {
    const root = document.documentElement;
    if (!root.classList.contains('setup-boot-block')) return;
    if (document.getElementById('setup-overlay')?.classList.contains('active')) return;
    root.classList.add('setup-boot-failed');
    root.classList.remove('setup-boot-block');
  }

  function handleEarlyAppModuleError(event: Event): void {
    const target = event.target as { src?: unknown; tagName?: unknown } | null;
    const failedEntryScript =
      target?.tagName === 'SCRIPT' &&
      typeof target.src === 'string' &&
      /\/(?:src\/app\.ts|assets\/main-[^/?]+\.js)(?:\?.*)?$/u.test(target.src);
    const filename = (event as ErrorEvent).filename;
    const failedEntryEvaluation =
      typeof filename === 'string' &&
      /\/(?:src\/app\.ts|assets\/main-[^/?]+\.js)(?:\?.*)?$/u.test(filename);
    if (failedEntryScript || failedEntryEvaluation) failOpenSetupBootGuard();
  }

  function reveal(): boolean {
    if (!document.body) return false;
    // Re-assert the class even after the first reveal. WebKit can restore a
    // cached document after rebuilding its render tree; pageshow/foreground
    // recovery must not trust the module-local flag more than the live DOM.
    document.body.classList.add('fouc-loaded');
    if (revealed) return true;
    revealed = true;
    return true;
  }

  function revealOnForeground(): void {
    if (document.hidden !== true) reveal();
  }

  function check(): void {
    // The timeout is the intentional CSS-failure escape hatch. Once it has
    // revealed the page, let the already-queued frame finish without starting
    // a permanent getComputedStyle/requestAnimationFrame loop.
    if (revealed) return;
    if (timedOut || getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()) {
      reveal();
    }
    if (!revealed) requestAnimationFrame(check);
  }

  // requestAnimationFrame and timers may stay suspended while an installed
  // iOS PWA is cold-restored in the background. Parser/lifecycle events give
  // the shell non-animation paths to become visible immediately.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reveal, { once: true });
  } else {
    reveal();
  }
  document.addEventListener('visibilitychange', revealOnForeground);
  window.addEventListener('pageshow', reveal);
  window.addEventListener('error', handleEarlyAppModuleError, true);

  requestAnimationFrame(check);
  setTimeout(() => {
    timedOut = true;
    reveal();
  }, 3000);
  // A hung module graph or bootstrap promise cannot report its own failure.
  // After a deliberately generous bound, replace the blank boot guard with a
  // reloadable failure surface. Normal setup removes the guard long before it.
  setTimeout(failOpenSetupBootGuard, 15_000);
})();
