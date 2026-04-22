/**
 * Netlify Edge Function: invite-page
 *
 * When a crawler (KakaoTalk, Facebook, Twitter/X, Slack, Discord,
 * LinkedIn) fetches /{6-digit-code}, Netlify's SPA fallback would
 * serve the stock index.html with the homepage OG tags. This function
 * intercepts that response and rewrites the og:* / twitter:* meta so
 * the preview card reflects the invite instead:
 *
 *   og:image     → /og/invite/{code}.png?l={lang}   (dynamic, generated)
 *   og:title     → "You're invited · Code {code} · MUSIXQUARE"
 *   og:desc      → bilingual join prompt including the code
 *   og:url       → https://musixquare.com/{code}
 *   og:image:alt → accessibility text with the code
 *
 * Lang selection: ?l=en → English-led copy; anything else (default) →
 * Korean-led copy. The app's share-URL builder (ui/connect.ts) appends
 * ?l=ko|en based on the host's resolved language, so Korean hosts
 * produce Korean preview cards and English hosts produce English ones.
 *
 * Cache policy:
 *   Browser 60s, CDN 15m. Same code → same rewrite, so aggressive
 *   caching is safe. Short-ish to let copy fixes roll out without
 *   waiting a week.
 *
 * Non-HTML responses (e.g. if Netlify routes /123456 to an asset for
 * any reason) pass through untouched.
 */

import type { Context } from "@netlify/edge-functions";

const ORIGIN = "https://musixquare.com";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildMeta(code: string, lang: "ko" | "en") {
  const imageUrl = `${ORIGIN}/og/invite/${code}.png?l=${lang}`;
  const pageUrl = `${ORIGIN}/${code}${lang === "en" ? "?l=en" : ""}`;

  const title =
    lang === "ko"
      ? `초대됐어요 · ${code} · MUSIXQUARE`
      : `You're invited · Code ${code} · MUSIXQUARE`;

  const description =
    lang === "ko"
      ? `${code} 코드로 MUSIXQUARE 세션에 참여하세요 · Join with code ${code}`
      : `Join a MUSIXQUARE session with code ${code} · ${code} 코드로 함께 들어요`;

  const alt = lang === "ko" ? `MUSIXQUARE 초대 · 코드 ${code}` : `MUSIXQUARE invite · Code ${code}`;

  return { imageUrl, pageUrl, title, description, alt };
}

export default async function handler(
  request: Request,
  context: Context,
): Promise<Response | undefined> {
  const url = new URL(request.url);

  // Only single-segment paths. Multi-segment (e.g. /fonts/x.ttf) passes through.
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return;

  const code = segments[0];
  if (!/^\d{6}$/.test(code)) return;

  const lang: "ko" | "en" = url.searchParams.get("l") === "en" ? "en" : "ko";

  // Let Netlify's pipeline (SPA fallback) resolve to index.html, then rewrite.
  const response = await context.next();
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;

  const html = await response.text();
  const { imageUrl, pageUrl, title, description, alt } = buildMeta(code, lang);

  const rewritten = html
    .replace(
      /<meta property="og:url" content="[^"]*">/,
      `<meta property="og:url" content="${esc(pageUrl)}">`,
    )
    .replace(
      /<meta property="og:title" content="[^"]*">/,
      `<meta property="og:title" content="${esc(title)}">`,
    )
    .replace(
      /<meta property="og:description" content="[^"]*">/,
      `<meta property="og:description" content="${esc(description)}">`,
    )
    .replace(
      /<meta property="og:image" content="[^"]*">/,
      `<meta property="og:image" content="${esc(imageUrl)}">`,
    )
    .replace(
      /<meta property="og:image:alt" content="[^"]*">/,
      `<meta property="og:image:alt" content="${esc(alt)}">`,
    )
    .replace(
      /<meta name="twitter:title" content="[^"]*">/,
      `<meta name="twitter:title" content="${esc(title)}">`,
    )
    .replace(
      /<meta name="twitter:description" content="[^"]*">/,
      `<meta name="twitter:description" content="${esc(description)}">`,
    )
    .replace(
      /<meta name="twitter:image" content="[^"]*">/,
      `<meta name="twitter:image" content="${esc(imageUrl)}">`,
    );

  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=60, s-maxage=900");
  headers.set("X-Invite-Rewrite", code);
  headers.set("X-Invite-Lang", lang);
  headers.delete("Content-Length"); // response body byte length changed

  return new Response(rewritten, {
    status: response.status,
    headers,
  });
}

export const config = {
  // Match single-segment paths. Handler regex filters to 6-digit codes.
  // Known static single-segment paths short-circuited here to skip
  // invocations on high-traffic pages.
  path: "/:code",
  excludedPath: [
    "/roadmap",
    "/changelog",
    "/designsystem",
    "/beat-lab.html",
    "/favicon.ico",
    "/favicon.svg",
    "/robots.txt",
    "/sitemap.xml",
    "/manifest.webmanifest",
    "/service-worker.js",
    "/demo_track.mp3",
    "/dummy_audio.mp3",
    "/og-image.png",
    "/og-resvg.wasm",
  ],
};
