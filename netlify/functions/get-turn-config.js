/**
 * Netlify Function: get-turn-config
 *
 * MUSIXQUARE는 WebRTC 연결 안정성을 높이기 위해 TURN 서버를 선택적으로 사용합니다.
 * 이 함수는 클라이언트에 TURN 인증 정보를 전달합니다.
 *
 * IMPORTANT (보안):
 * - 장기/고정 TURN 계정 정보를 그대로 내려주는 방식은 외부 유출 시 악용될 수 있습니다.
 * - 가능하다면 공급자(Twilio/Metered 등)의 "ephemeral credential"(단기 토큰) 발급 API를
 *   서버에서 호출하고, 만료가 짧은 자격증명만 내려주세요.
 *
 * 현재 기본 구현은 환경변수에서 값을 읽어 전달합니다.
 * - TURN_USERNAME
 * - TURN_CREDENTIAL
 */

exports.handler = async (event) => {
  const username = process.env.TURN_USERNAME || "";
  const credential = process.env.TURN_CREDENTIAL || "";

  // ---------------------------
  // CORS
  // ---------------------------
  // 기본 정책: 같은 Origin만 허용(권장).
  // 필요 시 ALLOWED_ORIGINS 환경변수(콤마 구분)로 허용 목록을 지정하세요.
  // 예: https://yourdomain.com,https://staging-yourdomain.netlify.app
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const host = (event && event.headers && event.headers.host) || "";

  const allowList = (process.env.ALLOWED_ORIGINS || "")
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  let allowOrigin = "";
  const sameOriginCandidates = [
    host ? `https://${host}` : "",
    host ? `http://${host}` : "",
  ].filter(Boolean);

  const isLocalDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);

  if (origin) {
    if (allowList.length > 0) {
      if (allowList.includes(origin)) allowOrigin = origin;
    } else {
      // If no allow-list is provided, default to same-origin (+ local dev)
      if (sameOriginCandidates.includes(origin) || isLocalDev) allowOrigin = origin;
    }
  }

  const corsHeaders = allowOrigin
    ? {
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
      }
    : {};

  // Preflight
  if (event && event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-store, max-age=0",
        "Pragma": "no-cache",
      },
      body: "",
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // TURN 자격증명은 절대 캐시되면 안 됩니다.
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      ...corsHeaders,
    },
    body: JSON.stringify({ username, credential }),
  };
};
