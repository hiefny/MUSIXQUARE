/**
 * MUSIXQUARE FAQ - language detection bootstrap.
 *
 * Matches the landing page language flow:
 * ?lang= query > localStorage > navigator.language.
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
    /* defensive fallback */
  }
  document.documentElement.lang = lang;
  window.__faqLang = lang;
})();
