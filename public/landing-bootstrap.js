/**
 * MUSIXQUARE About page language preference bootstrap.
 *
 * About keeps the page copy in English, but resolves the user's language
 * preference early so the footer selector renders in the right state.
 */

(function () {
  var lang = 'en';
  try {
    if (window.MXQRStaticLang) {
      lang = window.MXQRStaticLang.resolve('en');
    } else {
      var qLang = new URLSearchParams(location.search).get('lang');
      if (qLang === 'en' || qLang === 'ko') {
        lang = qLang;
      } else {
        var stored = null;
        try {
          stored = localStorage.getItem('mxqr-landing-lang');
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
    }
  } catch (e) {
    /* defensive fallback */
  }

  document.documentElement.lang = window.MXQRStaticLang ? window.MXQRStaticLang.htmlLang(lang) : lang;

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
