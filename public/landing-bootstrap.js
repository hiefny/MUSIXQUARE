/**
 * MUSIXQUARE About page language preference bootstrap.
 *
 * Resolves the language before first paint so localized About copy and the
 * footer selector start in the same state.
 */

(function () {
  var lang = 'en';
  var fallbackHtmlLang = {
    en: 'en',
    ko: 'ko',
    ja: 'ja',
    'zh-hans': 'zh-Hans',
    'zh-hant': 'zh-Hant',
    es: 'es',
    'pt-br': 'pt-BR',
    fr: 'fr',
    de: 'de',
    nl: 'nl',
    it: 'it',
    pl: 'pl',
    ru: 'ru',
    tr: 'tr',
    id: 'id',
    vi: 'vi',
    th: 'th',
  };

  function normalizeFallback(value) {
    var raw = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/_/g, '-');
    if (!raw || raw === 'system') return null;
    if (fallbackHtmlLang[raw]) return raw;
    if (raw === 'zh-hans' || raw.indexOf('zh-hans-') === 0) return 'zh-hans';
    if (raw === 'zh-hant' || raw.indexOf('zh-hant-') === 0) return 'zh-hant';
    if (raw.indexOf('zh') === 0) {
      return /(?:tw|hk|mo|hant)/.test(raw) ? 'zh-hant' : 'zh-hans';
    }
    if (raw === 'pt' || raw.indexOf('pt-') === 0) return 'pt-br';
    var primary = raw.split('-')[0];
    return fallbackHtmlLang[primary] ? primary : null;
  }

  try {
    if (window.MXQRStaticLang) {
      lang = window.MXQRStaticLang.resolve('en');
    } else {
      var qLang = new URLSearchParams(location.search).get('lang');
      var resolved = normalizeFallback(qLang);
      if (!resolved) {
        try {
          resolved =
            normalizeFallback(localStorage.getItem('mxqr-landing-lang')) ||
            normalizeFallback(localStorage.getItem('musixquare-lang'));
        } catch {
          /* Storage may be unavailable in private or restricted contexts. */
        }
      }
      if (!resolved) {
        var navs =
          navigator.languages && navigator.languages.length
            ? navigator.languages
            : [navigator.language || ''];
        for (var i = 0; i < navs.length; i++) {
          resolved = normalizeFallback(navs[i]);
          if (resolved) break;
        }
      }
      lang = resolved || 'en';
    }
  } catch {
    /* Keep the English document default when language APIs fail. */
  }

  document.documentElement.lang = window.MXQRStaticLang
    ? window.MXQRStaticLang.htmlLang(lang)
    : fallbackHtmlLang[lang] || 'en';

  try {
    var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    if (navigator.standalone) {
      standalone = true;
      document.documentElement.classList.add('ios-standalone');
    }
    if (standalone) document.documentElement.classList.add('standalone');
  } catch {
    /* Standalone detection is optional. */
  }

  window.__landingLang = lang;
})();
