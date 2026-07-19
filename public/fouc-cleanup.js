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
  let revealed = false;
  let timedOut = false;

  function reveal() {
    if (revealed || !document.body) return false;
    revealed = true;
    document.body.classList.add('fouc-loaded');
    return true;
  }

  function check() {
    // The timeout is the intentional CSS-failure escape hatch. Once it has
    // revealed the page, let the already-queued frame finish without starting
    // a permanent getComputedStyle/requestAnimationFrame loop.
    if (revealed) return;
    if (timedOut || getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()) {
      reveal();
    }
    if (!revealed) requestAnimationFrame(check);
  }
  requestAnimationFrame(check);
  setTimeout(() => {
    timedOut = true;
    reveal();
  }, 3000);
})();
