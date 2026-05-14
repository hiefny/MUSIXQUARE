/**
 * MUSIXQUARE — early HTML bootstrap (index.html, head)
 *
 * Synchronous setup that must run before first paint:
 *   1. Android: strip viewport-fit=cover so the system nav bar doesn't
 *      clip bottom content on some Android tablets / WebViews.
 *   2. Theme preflight: resolve dark/light from localStorage + system
 *      preference, apply data-theme + theme-color so first paint matches
 *      the resolved theme. Avoids a flash of light → dark on PWA boot.
 *
 * Loaded as the first <script> in <head>, before the FOUC guard <style>
 * tag and the stylesheet links. The FOUC guard cleanup runs from a
 * separate file (fouc-cleanup.js) loaded after the guard tag.
 *
 * Extracted from inline <script> blocks in index.html so the production
 * CSP can drop `script-src 'unsafe-inline'`.
 */

(function () {
  // 1. Android viewport-fit fix
  if (/Android/i.test(navigator.userAgent)) {
    var m = document.querySelector('meta[name="viewport"]');
    if (m) {
      var c = m.getAttribute('content') || '';
      // Remove regardless of formatting: ", viewport-fit=cover" or "viewport-fit=cover".
      c = c.replace(/(?:,?\s*)viewport-fit=cover/g, '');
      // Cleanup possible trailing commas/spaces.
      c = c.replace(/,\s*,/g, ',').replace(/,\s*$/g, '').trim();
      m.setAttribute('content', c);
    }
  }
})();

(function () {
  // 2. Theme preflight
  try {
    var mode = localStorage.getItem('musixquare-theme') || 'system';
    var resolved =
      mode === 'dark'
        ? 'dark'
        : mode === 'light'
          ? 'light'
          : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light';

    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.style.colorScheme = resolved;

    // Match status-bar / address-bar color on first paint
    var themeColor = resolved === 'dark' ? '#212121' : '#ffffff';
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      meta.setAttribute('content', themeColor);
    });

    document.querySelectorAll('meta[name="color-scheme"]').forEach(function (meta) {
      meta.setAttribute('content', resolved);
    });
  } catch (e) {
    /* localStorage / matchMedia denied — fall back to whatever default the HTML/CSS picks */
  }
})();
