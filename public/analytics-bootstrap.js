/**
 * Production-only Cloudflare Web Analytics loader for standalone public pages.
 * Keep this first-party guard aligned with the app's early bootstrap policy.
 */
(function () {
  var ANALYTICS_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
  var ANALYTICS_INTEGRITY =
    'sha384-RPC48PglHYv6iOCN3mmnZnP3gNOZVwfDZ7lX5wedb4S/ZijsfoDPi/hoEMk+9Nyw';
  var ANALYTICS_TOKEN = '80608f4cdc3849d589d14bdcf48f19f9';

  try {
    var hostname = String(window.location.hostname || '')
      .trim()
      .toLowerCase();
    var isProductionHost = hostname === 'musixquare.com' || hostname.endsWith('.musixquare.com');
    var pathname = String(window.location.pathname || '');
    var search = String(window.location.search || '');
    var hash = String(window.location.hash || '');
    if (!isProductionHost || search !== '' || hash !== '' || /^\/\d{6}\/?$/.test(pathname)) return;
    var referrer = String(document.referrer || '');
    if (referrer) {
      var referrerUrl = new URL(referrer);
      if (referrerUrl.search !== '' || /^\/\d{6}\/?$/.test(referrerUrl.pathname)) return;
    }

    var script = document.createElement('script');
    script.async = true;
    script.src = ANALYTICS_SRC;
    script.integrity = ANALYTICS_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.setAttribute('data-cf-beacon', JSON.stringify({ token: ANALYTICS_TOKEN, spa: false }));
    document.head.appendChild(script);
  } catch (e) {
    // Missing or constrained browser APIs fail closed without analytics.
  }
})();
