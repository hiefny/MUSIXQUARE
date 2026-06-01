/**
 * MUSIXQUARE — early HTML bootstrap (index.html, head)
 *
 * Synchronous setup that must run before first paint:
 *   1. Android: strip viewport-fit=cover so the system nav bar doesn't
 *      clip bottom content on some Android tablets / WebViews.
 *   2. Language preflight: resolve localStorage + system language and set
 *      html[lang] before CSS so locale font stacks match the first frame.
 *   3. Theme preflight: resolve dark/light from localStorage + system
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
  // 2. Language preflight
  try {
    var htmlLangByCode = {
      en: 'en',
      ko: 'ko',
      ja: 'ja',
      'zh-hans': 'zh-Hans',
      'zh-hant': 'zh-Hant',
      es: 'es',
      'pt-br': 'pt-BR',
      fr: 'fr',
      de: 'de',
      it: 'it',
      pl: 'pl',
      ru: 'ru',
      tr: 'tr',
      id: 'id',
      vi: 'vi',
      th: 'th',
    };

    function matchLanguage(value) {
      var normalized = String(value || '')
        .trim()
        .replace(/_/g, '-')
        .toLowerCase();
      if (!normalized) return null;

      if (normalized === 'zh-hans' || normalized.indexOf('zh-hans-') === 0) return 'zh-hans';
      if (normalized === 'zh-hant' || normalized.indexOf('zh-hant-') === 0) return 'zh-hant';
      if (normalized.indexOf('zh') === 0) {
        if (
          normalized.indexOf('tw') !== -1 ||
          normalized.indexOf('hk') !== -1 ||
          normalized.indexOf('mo') !== -1 ||
          normalized.indexOf('hant') !== -1
        ) {
          return 'zh-hant';
        }
        return 'zh-hans';
      }

      if (normalized === 'pt-br' || normalized.indexOf('pt-br-') === 0) return 'pt-br';
      if (normalized === 'pt' || normalized.indexOf('pt-') === 0) return 'pt-br';

      var primary = normalized.split('-')[0];
      return htmlLangByCode[primary] ? primary : null;
    }

    var savedLang = localStorage.getItem('musixquare-lang') || 'system';
    var resolvedLang = savedLang === 'system' ? null : matchLanguage(savedLang);

    if (!resolvedLang) {
      var languages =
        navigator.languages && navigator.languages.length
          ? navigator.languages
          : [navigator.language || ''];
      for (var i = 0; i < languages.length; i += 1) {
        resolvedLang = matchLanguage(languages[i]);
        if (resolvedLang) break;
      }
    }

    document.documentElement.setAttribute('lang', htmlLangByCode[resolvedLang || 'en'] || 'en');
  } catch (e) {
    /* localStorage / navigator denied - keep the HTML default */
  }
})();

(function () {
  // 3. Theme preflight
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
    var themeColor = resolved === 'dark' ? '#1a1a1a' : '#ffffff';
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
