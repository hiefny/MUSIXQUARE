/**
 * MUSIXQUARE About page language preference bootstrap.
 *
 * Resolves the language before first paint so localized About copy and the
 * footer selector start in the same state.
 */

interface StaticLanguageResolver {
  resolve(fallback: string): string;
  htmlLang(language: string): string;
  direction(language: string): 'ltr' | 'rtl';
  ensureFont?(language: string): void;
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
    hi: 'hi-IN',
    bn: 'bn-BD',
    ta: 'ta-IN',
    te: 'te-IN',
    ms: 'ms-MY',
    fil: 'fil-PH',
    ar: 'ar',
    ur: 'ur-PK',
    he: 'he-IL',
    uk: 'uk-UA',
    ro: 'ro-RO',
    cs: 'cs-CZ',
    el: 'el-GR',
    fa: 'fa-IR',
    mr: 'mr-IN',
    gu: 'gu-IN',
    kn: 'kn-IN',
    ml: 'ml-IN',
    pa: 'pa-IN',
    sv: 'sv-SE',
    da: 'da-DK',
    nb: 'nb-NO',
    fi: 'fi-FI',
    hu: 'hu-HU',
    bg: 'bg-BG',
  };

  function normalizeFallback(value: unknown): string | null {
    const raw = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/_/gu, '-');
    if (!raw || raw === 'system') return null;
    if (Object.prototype.hasOwnProperty.call(fallbackHtmlLang, raw)) return raw;
    if (raw === 'zh-hans' || raw.startsWith('zh-hans-')) return 'zh-hans';
    if (raw === 'zh-hant' || raw.startsWith('zh-hant-')) return 'zh-hant';
    if (raw.startsWith('zh')) {
      return /(?:tw|hk|mo|hant)/u.test(raw) ? 'zh-hant' : 'zh-hans';
    }
    if (raw === 'pt' || raw.startsWith('pt-')) return 'pt-br';
    if (raw === 'in' || raw.startsWith('in-')) return 'id';
    if (raw === 'iw' || raw.startsWith('iw-')) return 'he';
    if (raw === 'no' || raw.startsWith('no-')) return 'nb';
    if (raw === 'tl' || raw.startsWith('tl-')) return 'fil';
    const [primary] = raw.split('-');
    return primary && Object.prototype.hasOwnProperty.call(fallbackHtmlLang, primary)
      ? primary
      : null;
  }

  try {
    if (landingWindow.MXQRStaticLang) {
      lang = landingWindow.MXQRStaticLang.resolve('en');
    } else {
      // Localized About URLs own their language even when the shared resolver fails.
      const pathname = location.pathname.toLowerCase().replace(/\/+$/gu, '') || '/';
      const pathLanguage = normalizeFallback(/^\/([^/]+)\/about(?:\.html)?$/u.exec(pathname)?.[1]);
      const fromPath =
        pathname === '/about' || pathname === '/about.html'
          ? 'en'
          : pathLanguage !== 'en'
            ? pathLanguage
            : null;
      const qLang = new URLSearchParams(location.search).get('lang');
      let resolved = fromPath || normalizeFallback(qLang);
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
  document.documentElement.dir = landingWindow.MXQRStaticLang
    ? landingWindow.MXQRStaticLang.direction(lang)
    : lang === 'ar' || lang === 'fa' || lang === 'he' || lang === 'ur'
      ? 'rtl'
      : 'ltr';
  landingWindow.MXQRStaticLang?.ensureFont?.(lang);

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
