/**
 * MUSIXQUARE — FOUC guard cleanup (index.html)
 *
 * Removes the inline `<style id="fouc-guard">` rule (body { opacity: 0 })
 * once the main stylesheet has loaded. Detected via the --bg CSS variable
 * that style.css defines on :root; falls back to a 3s timeout in case the
 * stylesheet never loads (offline / blocked by CSP / network failure).
 *
 * Loaded as a <script> AFTER the fouc-guard <style> tag in <head>, so
 * document.getElementById('fouc-guard') resolves on first try.
 *
 * Extracted from inline <script> in index.html so the production CSP can
 * drop `script-src 'unsafe-inline'`.
 */

(function () {
  var g = document.getElementById('fouc-guard');
  if (!g) return;
  function check() {
    if (getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()) {
      g.remove();
    } else {
      requestAnimationFrame(check);
    }
  }
  requestAnimationFrame(check);
  setTimeout(function () {
    if (g.parentNode) g.remove();
  }, 3000);
})();
