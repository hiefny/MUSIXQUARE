/**
 * MUSIXQUARE — wordmark animation timing wiring
 *
 * The setup-screen wordmark is built out of 36 SVG <rect>/<polygon>
 * shards, each with its own staggered animation `--wt` (delay) and
 * `--wd` (duration). These used to live as inline `style="--wt:Xms;
 * --wd:Yms"` attributes, but inline style requires CSP `style-src
 * 'unsafe-inline'`. To drop that, the values were moved to
 * `data-wt` / `data-wd` integer attributes (milliseconds), and this
 * script copies them onto the element's CSS custom properties at boot.
 *
 * element.style.setProperty() is not classified as inline-style by the
 * CSP spec — it's a JS-mediated style mutation, which CSP gates via
 * `script-src` (already 'self' since Phase A2). No 'unsafe-hashes'
 * needed.
 *
 * Idempotent: if called twice (HMR / reload races), setProperty just
 * overwrites with the same value.
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
