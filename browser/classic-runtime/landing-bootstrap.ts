/**
 * MUSIXQUARE About page language preference bootstrap.
 *
 * Resolves the language before first paint so localized About copy and the
 * footer selector start in the same state.
 */

interface StaticLanguageResolver {
  resolve(fallback: string): string;
  htmlLang(language: string): string;
}

interface LandingRuntimeWindow extends Window {
  MXQRStaticLang?: StaticLanguageResolver;
  __landingLang?: string;
}

(function applyInitialLandingPreferences() {
  const landingWindow = window as LandingRuntimeWindow;
  let lang = 'en';
  const fallbackHtmlLang: Readonly<Record<string, string>> = {
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

  function normalizeFallback(value: unknown): string | null {
    const raw = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/_/gu, '-');
    if (!raw || raw === 'system') return null;
    if (fallbackHtmlLang[raw]) return raw;
    if (raw === 'zh-hans' || raw.startsWith('zh-hans-')) return 'zh-hans';
    if (raw === 'zh-hant' || raw.startsWith('zh-hant-')) return 'zh-hant';
    if (raw.startsWith('zh')) {
      return /(?:tw|hk|mo|hant)/u.test(raw) ? 'zh-hant' : 'zh-hans';
    }
    if (raw === 'pt' || raw.startsWith('pt-')) return 'pt-br';
    const [primary] = raw.split('-');
    return primary && fallbackHtmlLang[primary] ? primary : null;
  }

  try {
    if (landingWindow.MXQRStaticLang) {
      lang = landingWindow.MXQRStaticLang.resolve('en');
    } else {
      const qLang = new URLSearchParams(location.search).get('lang');
      let resolved = normalizeFallback(qLang);
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
        const navs =
          navigator.languages && navigator.languages.length
            ? navigator.languages
            : [navigator.language || ''];
        for (const navigationLanguage of navs) {
          resolved = normalizeFallback(navigationLanguage);
          if (resolved) break;
        }
      }
      lang = resolved || 'en';
    }
  } catch {
    /* Keep the English document default when language APIs fail. */
  }

  document.documentElement.lang = landingWindow.MXQRStaticLang
    ? landingWindow.MXQRStaticLang.htmlLang(lang)
    : fallbackHtmlLang[lang] || 'en';

  try {
    let standalone =
      Boolean(window.matchMedia) && window.matchMedia('(display-mode: standalone)').matches;
    if ((navigator as Navigator & { readonly standalone?: boolean }).standalone) {
      standalone = true;
      document.documentElement.classList.add('ios-standalone');
    }
    if (standalone) document.documentElement.classList.add('standalone');
  } catch {
    /* Standalone detection is optional. */
  }

  landingWindow.__landingLang = lang;
})();
