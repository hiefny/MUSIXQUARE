/**
 * MUSIXQUARE — early HTML bootstrap (index.html, head)
 *
 * Synchronous setup that must run before first paint:
 *   0. PRO owner claims: scrub fragment credentials and reject/scrub query
 *      lookalikes before any third-party script, then hand valid fragment
 *      claims to the app through one in-memory closure.
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
  var TRANSFER_KEY = 'pro-transfer';
  var ANALYTICS_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
  var ANALYTICS_TOKEN = '80608f4cdc3849d589d14bdcf48f19f9';
  var analyticsStarted = false;

  function isProductionAnalyticsHost() {
    try {
      var hostname = String(window.location.hostname || '')
        .trim()
        .toLowerCase();
      return hostname === 'musixquare.com' || hostname.endsWith('.musixquare.com');
    } catch (e) {
      return false;
    }
  }

  function startAnalytics() {
    // Analytics is an explicit production-only capability. Opaque URLs,
    // loopback servers, and preview hosts all remain silent by default.
    if (analyticsStarted || !isProductionAnalyticsHost()) return;
    analyticsStarted = true;

    var script = document.createElement('script');
    script.async = true;
    script.src = ANALYTICS_SRC;
    script.setAttribute('data-cf-beacon', JSON.stringify({ token: ANALYTICS_TOKEN }));
    document.head.appendChild(script);
  }

  var rawHash = window.location.hash || '';
  var fragment = rawHash.charAt(0) === '#' ? rawHash.slice(1) : rawHash;
  var rawSearch = window.location.search || '';
  var query = rawSearch.charAt(0) === '?' ? rawSearch.slice(1) : rawSearch;
  var fragmentParams;
  var queryParams;

  try {
    fragmentParams = new URLSearchParams(fragment);
    queryParams = new URLSearchParams(query);
  } catch (e) {
    // URLSearchParams is universal in supported browsers. If parsing is
    // unavailable, do not guess whether an encoded query/hash key is a
    // credential: keep analytics disabled instead of risking disclosure.
    return;
  }

  function claimPurpose(key) {
    var normalized = String(key || '').toLowerCase();
    if (normalized === ACTIVATION_KEY) return 'activation';
    if (normalized === RECOVERY_KEY) return 'recovery';
    if (normalized === TRANSFER_KEY) return 'transfer';
    return '';
  }

  var fragmentCounts = { activation: 0, recovery: 0, transfer: 0 };
  var activationClaims = [];
  var recoveryClaims = [];
  var transferClaims = [];
  fragmentParams.forEach(function (value, key) {
    var purpose = claimPurpose(key);
    if (!purpose) return;
    fragmentCounts[purpose] += 1;
    // Only the canonical, case-sensitive fragment names are accepted. A
    // lookalike is still scrubbed and surfaced as a damaged link marker.
    if (key === ACTIVATION_KEY) activationClaims.push(value);
    if (key === RECOVERY_KEY) recoveryClaims.push(value);
    if (key === TRANSFER_KEY) transferClaims.push(value);
  });

  var queryCounts = { activation: 0, recovery: 0, transfer: 0 };
  var queryClaimKeys = [];
  queryParams.forEach(function (_value, key) {
    var purpose = claimPurpose(key);
    if (!purpose) return;
    queryCounts[purpose] += 1;
    queryClaimKeys.push(key);
  });
  for (var queryKeyIndex = 0; queryKeyIndex < queryClaimKeys.length; queryKeyIndex += 1) {
    queryParams.delete(queryClaimKeys[queryKeyIndex]);
  }

  var hasFragmentCredential =
    fragmentCounts.activation > 0 || fragmentCounts.recovery > 0 || fragmentCounts.transfer > 0;
  var hasQueryCredential =
    queryCounts.activation > 0 || queryCounts.recovery > 0 || queryCounts.transfer > 0;
  var hasCredential = hasFragmentCredential || hasQueryCredential;

  if (!hasCredential) {
    startAnalytics();
    return;
  }

  // Query credentials are never accepted, even if their token shape is valid.
  // Remove their keys while retaining unrelated query parameters. Fragment
  // credentials retain the existing stronger rule of removing the whole
  // fragment. If History API replacement fails, install neither a handoff nor
  // analytics while any sensitive URL material remains visible.
  var cleanQuery = queryParams.toString();
  var cleanUrl = window.location.pathname + (cleanQuery ? '?' + cleanQuery : '');
  if (!hasFragmentCredential) cleanUrl += rawHash;
  try {
    window.history.replaceState(window.history.state, '', cleanUrl);
  } catch (e) {
    return;
  }
  if (hasFragmentCredential && window.location.hash) return;

  // Confirm that History API replacement actually removed every query claim
  // key. Constrained shells can expose a no-op implementation without
  // throwing; analytics must remain disabled in that case.
  if (hasQueryCredential) {
    try {
      var remainingQuery = new URLSearchParams((window.location.search || '').replace(/^\?/, ''));
      var queryStillSensitive = false;
      remainingQuery.forEach(function (_value, key) {
        if (claimPurpose(key)) queryStillSensitive = true;
      });
      if (queryStillSensitive) return;
    } catch (e) {
      return;
    }
  }

  // The presence of any query credential invalidates the complete credential
  // set. Retain purpose booleans only, so setup renders the terminal damaged
  // link UX without ever accepting or preserving a query token value.
  var activationClaim =
    !hasQueryCredential && fragmentCounts.activation === 1 && activationClaims.length === 1
      ? activationClaims[0]
      : null;
  var activationPresent = fragmentCounts.activation > 0 || queryCounts.activation > 0;
  var recoveryClaim =
    !hasQueryCredential && fragmentCounts.recovery === 1 && recoveryClaims.length === 1
      ? recoveryClaims[0]
      : null;
  var recoveryPresent = fragmentCounts.recovery > 0 || queryCounts.recovery > 0;
  var transferClaim =
    !hasQueryCredential && fragmentCounts.transfer === 1 && transferClaims.length === 1
      ? transferClaims[0]
      : null;
  var transferPresent = fragmentCounts.transfer > 0 || queryCounts.transfer > 0;
  var consumed = false;

  // Discard the parsed URL containers immediately. From this point until the
  // app consumes the bridge, only the at-most-one accepted value per purpose
  // remains in the private closure.
  activationClaims.length = 0;
  recoveryClaims.length = 0;
  transferClaims.length = 0;
  fragmentParams = null;
  queryParams = null;
  queryClaimKeys.length = 0;
  fragment = '';
  rawHash = '';
  query = '';
  rawSearch = '';

  function clearClaimMemory() {
    activationClaim = null;
    activationPresent = false;
    recoveryClaim = null;
    recoveryPresent = false;
    transferClaim = null;
    transferPresent = false;
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
          activationPresent: activationPresent,
          recoveryClaim: recoveryClaim,
          recoveryPresent: recoveryPresent,
          transferClaim: transferClaim,
          transferPresent: transferPresent,
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
      nl: 'nl',
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
