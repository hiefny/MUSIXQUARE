/**
 * MUSIXQUARE landing — language detection bootstrap
 *
 * Synchronously sets `<html lang>` BEFORE the stylesheet loads, so
 * `:lang(ko)` CSS rules apply on first paint (no flash of English
 * letterforms before the Korean variant kicks in).
 *
 * Resolution order: ?lang= query > localStorage > navigator.language.
 *
 * Extracted from inline <script> in landing.html so the production CSP
 * can drop `script-src 'unsafe-inline'`.
 */

(function () {
  var STORE_KEY = 'mxqr-landing-lang';
  var lang = 'en';
  try {
    var qLang = new URLSearchParams(location.search).get('lang');
    if (qLang === 'en' || qLang === 'ko') {
      lang = qLang;
    } else {
      var stored = null;
      try {
        stored = localStorage.getItem(STORE_KEY);
      } catch (e) {
        /* private mode */
      }
      if (stored === 'en' || stored === 'ko') {
        lang = stored;
      } else {
        var nav = (navigator.language || 'en').toLowerCase();
        if (nav.indexOf('ko') === 0) lang = 'ko';
      }
    }
  } catch (e) {
    /* defensive: any failure → English fallback */
  }
  document.documentElement.lang = lang;

  try {
    var standalone =
      window.matchMedia &&
      window.matchMedia('(display-mode: standalone)').matches;
    if (navigator.standalone) {
      standalone = true;
      document.documentElement.classList.add('ios-standalone');
    }
    if (standalone) document.documentElement.classList.add('standalone');
  } catch (e) {
    /* noop */
  }

  window.__landingLang = lang;
})();
