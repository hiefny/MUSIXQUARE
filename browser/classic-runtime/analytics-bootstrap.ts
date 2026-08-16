/**
 * Production-only Cloudflare Web Analytics loader for standalone public pages.
 * Keep this first-party guard aligned with the app's early bootstrap policy.
 */
(function installStandaloneAnalytics() {
  const ANALYTICS_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
  const ANALYTICS_INTEGRITY =
    'sha384-RPC48PglHYv6iOCN3mmnZnP3gNOZVwfDZ7lX5wedb4S/ZijsfoDPi/hoEMk+9Nyw';
  const ANALYTICS_TOKEN = '80608f4cdc3849d589d14bdcf48f19f9';

  try {
    const hostname = String(window.location.hostname || '')
      .trim()
      .toLowerCase();
    const isProductionHost = hostname === 'musixquare.com' || hostname.endsWith('.musixquare.com');
    const pathname = String(window.location.pathname || '');
    const search = String(window.location.search || '');
    const hash = String(window.location.hash || '');
    if (!isProductionHost || search !== '' || hash !== '' || /^\/\d{6}\/?$/u.test(pathname)) {
      return;
    }

    const referrer = String(document.referrer || '');
    if (referrer) {
      const referrerUrl = new URL(referrer);
      if (referrerUrl.search !== '' || /^\/\d{6}\/?$/u.test(referrerUrl.pathname)) return;
    }

    const script = document.createElement('script');
    script.async = true;
    script.src = ANALYTICS_SRC;
    script.integrity = ANALYTICS_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.setAttribute('data-cf-beacon', JSON.stringify({ token: ANALYTICS_TOKEN, spa: false }));
    document.head.appendChild(script);
  } catch {
    // Missing or constrained browser APIs fail closed without analytics.
  }
})();
