/**
 * MUSIXQUARE About page language preference bootstrap.
 *
 * Resolves the language before first paint so localized About copy and the
 * footer selector start in the same state.
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
          /* Storage may be unavailable in private or restricted contexts. */
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
    /* Keep the English document default when language APIs fail. */
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
    /* Standalone detection is optional. */
  }

  window.__landingLang = lang;
})();
