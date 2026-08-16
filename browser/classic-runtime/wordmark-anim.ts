/**
 * MUSIXQUARE wordmark animation timing wiring
 *
 * The setup-screen wordmark is built from SVG shards with staggered
 * `data-wt` and `data-wd` timing values. This script copies those integer
 * milliseconds into CSS custom properties at boot, keeping static style
 * attributes out of the CSP-controlled document.
 *
 * element.style.setProperty() is not classified as inline-style by the
 * CSP spec; it is a JS-mediated style mutation governed by `script-src`.
 *
 * Repeated execution is safe because each property receives the same value.
 */

(function installWordmarkTiming() {
  function applyWordmarkTiming(): void {
    const nodes = document.querySelectorAll<HTMLElement>('[data-wt]');
    for (const element of nodes) {
      // The selector establishes that `wt` exists; the assertion preserves the
      // original script's exact mutation instead of introducing a fallback.
      element.style.setProperty('--wt', `${element.dataset.wt!}ms`);
      if (element.dataset.wd) {
        element.style.setProperty('--wd', `${element.dataset.wd}ms`);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyWordmarkTiming);
  } else {
    applyWordmarkTiming();
  }
})();
