/**
 * MUSIXQUARE About page language selector bridge.
 *
 * The About copy is intentionally English-only for now. The footer picker
 * still stores the visitor's app language preference for the main app.
 */

(function () {
  var STORE_KEY = 'mxqr-landing-lang';
  var ENGLISH_TOASTS = {
    'code.toast_success': 'Invite link copied',
    'code.toast_fail': 'Copy failed',
  };

  function normalize(lang) {
    if (window.MXQRStaticLang) return window.MXQRStaticLang.normalize(lang) || 'en';
    return lang === 'ko' ? 'ko' : 'en';
  }

  function applySelection(lang) {
    var selected = normalize(lang);
    window.__landingLang = selected;
    document.documentElement.lang = 'en';
    if (window.MXQRStaticLang) window.MXQRStaticLang.update(selected);
  }

  function setLang(lang) {
    var selected = normalize(lang);
    if (window.MXQRStaticLang) {
      selected = window.MXQRStaticLang.persist(selected);
    } else {
      try {
        localStorage.setItem(STORE_KEY, selected);
      } catch (e) {
        /* ignore quota / disabled */
      }
    }
    applySelection(selected);
  }

  window.__landingT = function (key, fallback) {
    return ENGLISH_TOASTS[key] || fallback || key;
  };

  window.addEventListener('mxqr:static-language-change', function (event) {
    setLang(event.detail && event.detail.lang);
  });

  applySelection(window.__landingLang || (window.MXQRStaticLang && window.MXQRStaticLang.resolve('en')) || 'en');
})();
