/**
 * Netlify Function: get-turn-config
 *
 * Returns Metered.ca TURN credentials to the client for WebRTC relay.
 * Environment variables: TURN_USER, TURN_PASS
 */

exports.handler = async (event) => {
  const username = process.env.TURN_USER || "";
  const credential = process.env.TURN_PASS || "";

  // CORS — same-origin + local dev
  const origin = (event?.headers?.origin || event?.headers?.Origin) || "";
  const host = event?.headers?.host || "";

  const sameOriginCandidates = [
    host ? `https://${host}` : "",
    host ? `http://${host}` : "",
  ].filter(Boolean);

  const isLocalDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  const allowOrigin = (sameOriginCandidates.includes(origin) || isLocalDev) ? origin : "";

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
