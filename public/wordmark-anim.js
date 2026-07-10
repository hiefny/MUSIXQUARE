/**
 * MUSIXQUARE — wordmark animation timing wiring
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

(function () {
  function applyWordmarkTiming() {
    var nodes = document.querySelectorAll('[data-wt]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      el.style.setProperty('--wt', el.dataset.wt + 'ms');
      if (el.dataset.wd) el.style.setProperty('--wd', el.dataset.wd + 'ms');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyWordmarkTiming);
  } else {
    applyWordmarkTiming();
  }
})();
