/**
 * MUSIXQUARE — early HTML bootstrap (index.html, head)
 *
 * Synchronous setup that must run before first paint:
 *   0. PRO owner claims: scrub fragment credentials before any third-party
 *      script, then hand them to the app through one in-memory closure.
 *   1. Android: strip viewport-fit=cover so the system nav bar doesn't
 *      clip bottom content on some Android tablets / WebViews.
 *   2. Language preflight: resolve localStorage + system language and set
 *      html[lang] before CSS so locale font stacks match the first frame.
 *   3. Theme preflight: resolve dark/light from localStorage + system
 *      preference, apply data-theme + theme-color so first paint matches
 *      the resolved theme. Avoids a flash of light → dark on PWA boot.
 *
 * Loaded as the first script in <head>, before stylesheet links. The FOUC
 * guard lives in style.css and fouc-cleanup.js reveals the body after that
 * stylesheet has parsed. Keeping this bootstrap external lets the production
 * CSP omit `script-src 'unsafe-inline'`.
 */

(function () {
  var HANDOFF_KEY = '__mxqrTakeProRoomFragmentClaims';
  var ACTIVATION_KEY = 'pro-claim';
  var RECOVERY_KEY = 'pro-recovery';
  var ANALYTICS_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
  var ANALYTICS_TOKEN = '80608f4cdc3849d589d14bdcf48f19f9';
  var analyticsStarted = false;

  function startAnalytics() {
    if (analyticsStarted) return;
    analyticsStarted = true;

    var script = document.createElement('script');
    script.async = true;
    script.src = ANALYTICS_SRC;
    script.setAttribute('data-cf-beacon', JSON.stringify({ token: ANALYTICS_TOKEN }));
    document.head.appendChild(script);
  }

  var rawHash = window.location.hash;
  var fragment = rawHash && rawHash.charAt(0) === '#' ? rawHash.slice(1) : rawHash;
  var params;

  try {
    params = new URLSearchParams(fragment || '');
  } catch (e) {
    // URLSearchParams is universal in supported browsers. On an obsolete or
    // tampered runtime, conservatively suppress analytics when the raw hash
    // even resembles a credential instead of risking disclosure.
    if (!/(?:^|&)(?:pro-claim|pro-recovery)(?:=|&|$)/i.test(fragment || '')) {
      startAnalytics();
    }
    return;
  }

  var activationClaims = params.getAll(ACTIVATION_KEY);
  var recoveryClaims = params.getAll(RECOVERY_KEY);
  var hasCredential = activationClaims.length > 0 || recoveryClaims.length > 0;

  if (!hasCredential) {
    startAnalytics();
    return;
  }

  // Scrub before retaining or validating a credential. If History API
  // replacement fails, fail closed: neither a handoff nor analytics is
  // installed while the sensitive fragment remains visible.
  try {
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
  } catch (e) {
    return;
  }
  if (window.location.hash) return;

  var activationClaim = activationClaims.length === 1 ? activationClaims[0] : null;
  var recoveryClaim = recoveryClaims.length === 1 ? recoveryClaims[0] : null;
  var recoveryPresent = recoveryClaims.length > 0;
  var consumed = false;

  // Discard the parsed URL containers immediately. From this point until the
  // app consumes the bridge, only the at-most-one accepted value per purpose
  // remains in the private closure.
  activationClaims.length = 0;
  recoveryClaims.length = 0;
  params = null;
  fragment = '';
  rawHash = '';

  function clearClaimMemory() {
    activationClaim = null;
    recoveryClaim = null;
    recoveryPresent = false;
  }

  // No credential is stored in DOM, Web Storage, cookies, a query parameter,
  // or an enumerable global. The closure is consumed at module evaluation;
  // analytics starts only after its credential variables have been cleared.
  try {
    Object.defineProperty(window, HANDOFF_KEY, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: function () {
        if (consumed) return null;
        consumed = true;

        var handoff = Object.freeze({
          activationClaim: activationClaim,
          recoveryClaim: recoveryClaim,
          recoveryPresent: recoveryPresent,
        });
        clearClaimMemory();
        startAnalytics();
        return handoff;
      },
    });
  } catch (e) {
    // A conflicting/tampered bridge must not gain access to the credential.
    // Continue first-paint bootstrap, but keep analytics disabled for this URL.
    clearClaimMemory();
  }
})();

(function () {
  // 1. Android viewport-fit fix
  if (/Android/i.test(navigator.userAgent)) {
    var m = document.querySelector('meta[name="viewport"]');
    if (m) {
      var c = m.getAttribute('content') || '';
      // Accept both comma-delimited and standalone viewport-fit formatting.
      c = c.replace(/(?:,?\s*)viewport-fit=cover/g, '');
      // Normalize separators left by the removal.
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

    // Match browser chrome to the first painted theme.
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
