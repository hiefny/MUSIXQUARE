/**
 * Cloudflare Pages Function: /api/turn-config
 *
 * Returns Metered.ca TURN credentials to the client for WebRTC relay.
 * Env vars: TURN_USER, TURN_PASS (set in Pages dashboard).
 *
 * CORS: same-origin, local dev, Cloudflare Pages preview, Toss in-app.
 * Mirrors the Netlify Function it replaces — keep behavior identical
 * during the migration so client fallback chain stays unchanged.
 */

const trustedPatterns = [
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i,         // local dev
  /^https:\/\/[^/]*\.toss\.im$/i,                           // Toss in-app
  /^https:\/\/[^/]*\.toss-internal\.com$/i,                  // Toss internal
  /^https:\/\/[^/]*\.tossmini\.com$/i,                       // Apps in Toss WebView
  /^https:\/\/[^/]*\.pages\.dev$/i,                          // Cloudflare Pages preview/production
  /^https:\/\/[^/]*\.netlify\.app$/i,                        // legacy Netlify (during migration)
];

function corsHeadersFor(origin, host) {
  const sameOrigin =
    origin && (origin === `https://${host}` || origin === `http://${host}`);
  const trusted = sameOrigin || trustedPatterns.some((p) => p.test(origin));
  if (!trusted) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export const onRequest = async ({ request, env }) => {
  const origin = request.headers.get("origin") || "";
  const url = new URL(request.url);
  const corsHeaders = corsHeadersFor(origin, url.host);

  if (request.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: { ...corsHeaders, "Cache-Control": "no-store" },
    });
  }

  const username = env.TURN_USER || "";
  const credential = env.TURN_PASS || "";

  return new Response(JSON.stringify({ username, credential }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      ...corsHeaders,
    },
  });
};
