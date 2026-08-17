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
  type ClaimPurpose = 'activation' | 'recovery' | 'transfer';

  const HANDOFF_KEY = '__mxqrTakeProRoomFragmentClaims';
  const ACTIVATION_KEY = 'pro-claim';
  const RECOVERY_KEY = 'pro-recovery';
  const TRANSFER_KEY = 'pro-transfer';

  let rawHash = window.location.hash || '';
  let fragment = rawHash.charAt(0) === '#' ? rawHash.slice(1) : rawHash;
  let rawSearch = window.location.search || '';
  let query = rawSearch.charAt(0) === '?' ? rawSearch.slice(1) : rawSearch;
  let fragmentParams: URLSearchParams | null;
  let queryParams: URLSearchParams | null;

  try {
    fragmentParams = new URLSearchParams(fragment);
    queryParams = new URLSearchParams(query);
  } catch {
    // URLSearchParams is universal in supported browsers. If parsing is
    // unavailable, do not guess whether an encoded query/hash key is a
    // credential or expose an unsafe handoff.
    return;
  }

  function claimPurpose(key: unknown): ClaimPurpose | '' {
    const normalized = String(key || '').toLowerCase();
    if (/^(?:claim(?:[-_]?token)?|pro[-_]?claim)$/.test(normalized)) return 'activation';
    if (/^pro[-_]?recovery$/.test(normalized)) return 'recovery';
    if (/^pro[-_]?transfer$/.test(normalized)) return 'transfer';
    return '';
  }

  const fragmentCounts: Record<ClaimPurpose, number> = {
    activation: 0,
    recovery: 0,
    transfer: 0,
  };
  const activationClaims: string[] = [];
  const recoveryClaims: string[] = [];
  const transferClaims: string[] = [];
  fragmentParams.forEach(function (value, key) {
    const purpose = claimPurpose(key);
    if (!purpose) return;
    fragmentCounts[purpose] += 1;
    // Only the canonical, case-sensitive fragment names are accepted. A
    // lookalike is still scrubbed and surfaced as a damaged link marker.
    if (key === ACTIVATION_KEY) activationClaims.push(value);
    if (key === RECOVERY_KEY) recoveryClaims.push(value);
    if (key === TRANSFER_KEY) transferClaims.push(value);
  });

  const queryCounts: Record<ClaimPurpose, number> = {
    activation: 0,
    recovery: 0,
    transfer: 0,
  };
  const queryClaimKeys: string[] = [];
  queryParams.forEach(function (_value, key) {
    const purpose = claimPurpose(key);
    if (!purpose) return;
    queryCounts[purpose] += 1;
    queryClaimKeys.push(key);
  });
  for (let queryKeyIndex = 0; queryKeyIndex < queryClaimKeys.length; queryKeyIndex += 1) {
    const queryClaimKey = queryClaimKeys[queryKeyIndex];
    if (queryClaimKey) queryParams.delete(queryClaimKey);
  }

  const hasFragmentCredential =
    fragmentCounts.activation > 0 || fragmentCounts.recovery > 0 || fragmentCounts.transfer > 0;
  const hasQueryCredential =
    queryCounts.activation > 0 || queryCounts.recovery > 0 || queryCounts.transfer > 0;
  const hasCredential = hasFragmentCredential || hasQueryCredential;

  if (!hasCredential) {
    return;
  }

  // Query credentials are never accepted, even if their token shape is valid.
  // Remove their keys while retaining unrelated query parameters. Fragment
  // credentials retain the existing stronger rule of removing the whole
  // fragment. If History API replacement fails, do not install a handoff while
  // any sensitive URL material remains visible.
  const cleanQuery = queryParams.toString();
  let cleanUrl = window.location.pathname + (cleanQuery ? '?' + cleanQuery : '');
  if (!hasFragmentCredential) cleanUrl += rawHash;
  try {
    window.history.replaceState(window.history.state, '', cleanUrl);
  } catch {
    return;
  }
  if (hasFragmentCredential && window.location.hash) return;

  // Confirm that History API replacement actually removed every query claim
  // key. Constrained shells can expose a no-op implementation without
  // throwing; the credential handoff must remain disabled in that case.
  if (hasQueryCredential) {
    try {
      const remainingQuery = new URLSearchParams((window.location.search || '').replace(/^\?/, ''));
      let queryStillSensitive = false;
      remainingQuery.forEach(function (_value, key) {
        if (claimPurpose(key)) queryStillSensitive = true;
      });
      if (queryStillSensitive) return;
    } catch {
      return;
    }
  }

  // The presence of any query credential invalidates the complete credential
  // set. Retain purpose booleans only, so setup renders the terminal damaged
  // link UX without ever accepting or preserving a query token value.
  let activationClaim =
    !hasQueryCredential && fragmentCounts.activation === 1 && activationClaims.length === 1
      ? (activationClaims[0] ?? null)
      : null;
  let activationPresent = fragmentCounts.activation > 0 || queryCounts.activation > 0;
  let recoveryClaim =
    !hasQueryCredential && fragmentCounts.recovery === 1 && recoveryClaims.length === 1
      ? (recoveryClaims[0] ?? null)
      : null;
  let recoveryPresent = fragmentCounts.recovery > 0 || queryCounts.recovery > 0;
  let transferClaim =
    !hasQueryCredential && fragmentCounts.transfer === 1 && transferClaims.length === 1
      ? (transferClaims[0] ?? null)
      : null;
  let transferPresent = fragmentCounts.transfer > 0 || queryCounts.transfer > 0;
  let consumed = false;

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
  // or an enumerable global. The closure is consumed at module evaluation.
  try {
    Object.defineProperty(window, HANDOFF_KEY, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: function () {
        if (consumed) return null;
        consumed = true;

        const handoff = Object.freeze({
          activationClaim: activationClaim,
          activationPresent: activationPresent,
          recoveryClaim: recoveryClaim,
          recoveryPresent: recoveryPresent,
          transferClaim: transferClaim,
          transferPresent: transferPresent,
        });
        clearClaimMemory();
        return handoff;
      },
    });
  } catch {
    // A conflicting/tampered bridge must not gain access to the credential.
    // Continue first-paint bootstrap without exposing the credential.
    clearClaimMemory();
  }
})();

(function () {
  // A cached navigation is intentionally paintable, but it is not proof that
  // account/room APIs are reachable. Probe the controlling worker before the
  // module graph boots so app readiness can distinguish this degraded launch
  // from an online response. The worker persists the result by client ID, so
  // its later registration probe receives the same answer after suspension.
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', function (event) {
    const data = event && event.data;
    if (
      !data ||
      data.type !== 'MXQR_CACHE_STATUS_REQUEST' ||
      typeof data.navigationFallback !== 'boolean'
    ) {
      return;
    }
    const source = data.navigationFallback ? 'cache-fallback' : 'network';
    document.documentElement.setAttribute('data-mxqr-navigation-source', source);
    window.dispatchEvent(new CustomEvent('mxqr:navigation-source', { detail: { source: source } }));
  });

  const controller = navigator.serviceWorker.controller;
  if (controller) controller.postMessage({ type: 'MXQR_CACHE_STATUS_PROBE' });
})();

(function () {
  const runtimeWindow: Window & { __mxqrPrimaryFontRuntime?: unknown } = window;

  // Keep the optional full-font runtime outside the main module graph. A
  // cancelled classic-script request can be removed and retried at the same
  // stable URL without inheriting a failed dynamic-import module-map entry.
  const RUNTIME_URL = '/primary-font-loader.js';
  const RUNTIME_TIMEOUT_MS = 8000;
  const IDLE_TIMEOUT_MS = 2000;
  let loading = false;
  let started = false;
  let failures = 0;
  let retryTimer = 0;

  function clearRetry() {
    if (!retryTimer) return;
    window.clearTimeout(retryTimer);
    retryTimer = 0;
  }

  function retryLater() {
    if (retryTimer || loading || document.visibilityState === 'hidden') return;
    const delay = Math.min(30000, 1000 * Math.pow(3, failures));
    failures += 1;
    retryTimer = window.setTimeout(function () {
      retryTimer = 0;
      loadRuntime();
    }, delay);
  }

  function loadRuntime() {
    if (loading || runtimeWindow.__mxqrPrimaryFontRuntime || document.visibilityState === 'hidden')
      return;
    clearRetry();
    loading = true;

    const previous = document.querySelector('script[data-mxqr-primary-font-runtime]');
    if (previous) previous.remove();

    const script = document.createElement('script');
    let settled = false;
    const deadline = window.setTimeout(function () {
      finish(false);
    }, RUNTIME_TIMEOUT_MS);

    function finish(succeeded: boolean) {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      script.onload = null;
      script.onerror = null;
      loading = false;
      if (succeeded) {
        failures = 0;
        return;
      }
      script.remove();
      retryLater();
    }

    script.async = true;
    script.src = RUNTIME_URL;
    script.setAttribute('data-mxqr-primary-font-runtime', '');
    script.onload = function () {
      finish(true);
    };
    script.onerror = function () {
      finish(false);
    };
    document.head.appendChild(script);
  }

  function retryNow() {
    if (!started || loading || runtimeWindow.__mxqrPrimaryFontRuntime) return;
    clearRetry();
    loadRuntime();
  }

  function afterIdle() {
    if (started || typeof window.setTimeout !== 'function') return;
    started = true;
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(loadRuntime, { timeout: IDLE_TIMEOUT_MS });
    } else {
      window.setTimeout(loadRuntime, 0);
    }
  }

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('online', retryNow);
    window.addEventListener('pageshow', retryNow);
  }
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') retryNow();
    });
  }

  if (document.readyState === 'loading' && typeof window.addEventListener === 'function') {
    window.addEventListener('load', afterIdle, { once: true });
  } else {
    afterIdle();
  }
})();

(function () {
  // 1. Android viewport-fit fix
  if (/Android/i.test(navigator.userAgent)) {
    const m = document.querySelector('meta[name="viewport"]');
    if (m) {
      let c = m.getAttribute('content') || '';
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
    const htmlLangByCode = {
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

    type AppLanguageCode = keyof typeof htmlLangByCode;

    function isAppLanguageCode(value: string): value is AppLanguageCode {
      return Object.prototype.hasOwnProperty.call(htmlLangByCode, value);
    }

    function matchLanguage(value: unknown): AppLanguageCode | null {
      const normalized = String(value || '')
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

      const primary = normalized.split('-')[0];
      return primary && isAppLanguageCode(primary) ? primary : null;
    }

    function browserLanguageCandidates(): unknown[] {
      try {
        const languages = navigator.languages;
        if (languages && languages.length) return Array.from(languages);
      } catch {
        /* fall through to the independent navigator.language surface */
      }
      try {
        const language = navigator.language;
        return language ? [language] : [];
      } catch {
        return [];
      }
    }

    // Storage can be denied independently of navigator/DOM access (private
    // browsing, embedded contexts, or hardened browser policies). Treat that
    // as an unsaved `system` preference instead of abandoning locale
    // resolution and the manifest observer altogether.
    let savedLang = 'system';
    try {
      savedLang = localStorage.getItem('musixquare-lang') || 'system';
    } catch {
      /* continue with the browser language */
    }
    let resolvedLang = savedLang === 'system' ? null : matchLanguage(savedLang);

    if (!resolvedLang) {
      const languages = browserLanguageCandidates();
      for (let i = 0; i < languages.length; i += 1) {
        resolvedLang = matchLanguage(languages[i]);
        if (resolvedLang) break;
      }
    }

    function syncManifest(code: AppLanguageCode): void {
      const manifest = document.querySelector('link#app-manifest[rel~="manifest"]');
      if (!manifest) return;
      const href = `/manifests/${code}.webmanifest`;
      if (manifest.getAttribute('href') !== href) manifest.setAttribute('href', href);
    }

    const initialLanguage = resolvedLang || 'en';
    document.documentElement.setAttribute('lang', htmlLangByCode[initialLanguage] || 'en');
    // The parser has already created the href-less manifest link immediately
    // before this script. Assigning its href only after locale resolution
    // avoids an eager fetch of the wrong language's install metadata.
    syncManifest(initialLanguage);

    // Language changes after startup update html[lang]. Keep the install
    // metadata aligned as well, without coupling the classic bootstrap to the
    // app module graph or its event bus.
    if (typeof MutationObserver === 'function') {
      const manifestObserver = new MutationObserver(function () {
        syncManifest(matchLanguage(document.documentElement.getAttribute('lang')) || 'en');
      });
      manifestObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['lang'],
      });
    }
  } catch {
    // Unexpected DOM/runtime failures must not leave the href-less link
    // unusable. Expected storage and navigator getter failures are isolated
    // above so they still reach normal html/manifest synchronization.
    try {
      const manifest = document.querySelector('link#app-manifest[rel~="manifest"]');
      if (manifest && !manifest.getAttribute('href')) {
        manifest.setAttribute('href', '/manifests/en.webmanifest');
      }
    } catch {
      /* keep the HTML default when even DOM access is unavailable */
    }
  }
})();

(function () {
  // 3. Theme preflight
  try {
    const mode = localStorage.getItem('musixquare-theme') || 'system';
    const resolved =
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
    const themeColor = resolved === 'dark' ? '#1a1a1a' : '#ffffff';
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      meta.setAttribute('content', themeColor);
    });

    document.querySelectorAll('meta[name="color-scheme"]').forEach(function (meta) {
      meta.setAttribute('content', resolved);
    });
  } catch {
    /* localStorage / matchMedia denied — fall back to whatever default the HTML/CSS picks */
  }
})();
