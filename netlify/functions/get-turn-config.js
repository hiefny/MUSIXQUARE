/**
 * Netlify Function: get-turn-config
 *
 * Returns Metered.ca TURN credentials to the client for WebRTC relay.
 * Environment variables: TURN_USER, TURN_PASS
 *
 * CORS: same-origin, local dev, and trusted cross-origin (Toss in-app etc.)
 */

exports.handler = async (event) => {
  const username = process.env.TURN_USER || "";
  const credential = process.env.TURN_PASS || "";

  const origin = (event?.headers?.origin || event?.headers?.Origin) || "";
  const host = event?.headers?.host || "";

  // Trusted origins for cross-origin TURN credential requests
  const trustedPatterns = [
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i,        // local dev
    /^https:\/\/[^/]*\.toss\.im$/i,                          // Toss in-app
    /^https:\/\/[^/]*\.toss-internal\.com$/i,                 // Toss internal
    /^https:\/\/[^/]*\.tossmini\.com$/i,                      // Apps in Toss WebView (e.g. musixquare.apps.tossmini.com)
    /^https:\/\/musixquare\.netlify\.app$/i,                  // production
  ];

  const sameOrigin = origin && (
    origin === `https://${host}` || origin === `http://${host}`
  );

  // Sec-Fetch-Site is browser-attached (curl / server-side fetchers don't
  // emit it by default), so it's a stronger same-origin signal than Origin
  // alone. Browsers don't always include the Origin header on same-origin
  // GET requests — without this fallback the credential gate would 403
  // legitimate page loads from musixquare.com. The threat model (curl /
  // scraper exfiltrating long-lived TURN creds) stays addressed because
  // those callers don't set Sec-Fetch-Site.
  const fetchSite = (event?.headers?.['sec-fetch-site'] || event?.headers?.['Sec-Fetch-Site'] || '').toLowerCase();
  const browserSameOrigin = fetchSite === 'same-origin';

  const isTrusted = sameOrigin || browserSameOrigin || trustedPatterns.some(p => p.test(origin));
  const allowOrigin = isTrusted ? origin : "";

  const corsHeaders = allowOrigin
    ? {
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin",
      }
    : {};

  if (event?.httpMethod === "OPTIONS") {
    // Preflight: trusted-origin responses get CORS headers; everything else
    // gets a bare 204 (no Allow-Origin → browser blocks the actual request).
    return { statusCode: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" }, body: "" };
  }

  // Gate the credential body on origin trust. CORS alone doesn't stop
  // server-side / curl callers from scraping long-lived TURN credentials.
  if (!isTrusted) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Forbidden" }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      ...corsHeaders,
    },
    body: JSON.stringify({ username, credential }),
  };
};
