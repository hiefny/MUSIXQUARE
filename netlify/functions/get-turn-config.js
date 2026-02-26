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
    /^https:\/\/musixquare\.netlify\.app$/i,                  // production
  ];

  const sameOrigin = origin && (
    origin === `https://${host}` || origin === `http://${host}`
  );

  const isTrusted = sameOrigin || trustedPatterns.some(p => p.test(origin));
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
    return { statusCode: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" }, body: "" };
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
