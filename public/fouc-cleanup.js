/**
 * MUSIXQUARE — FOUC guard cleanup (index.html)
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

(function () {
  function reveal() {
    if (document.body) document.body.classList.add('fouc-loaded');
  }

  function check() {
    if (getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()) {
      reveal();
    } else {
      requestAnimationFrame(check);
    }
  }
  requestAnimationFrame(check);
  setTimeout(reveal, 3000);
})();
