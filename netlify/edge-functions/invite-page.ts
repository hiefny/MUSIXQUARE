/**
 * Netlify Edge Function: invite-page
 *
 * When a crawler (KakaoTalk, Facebook, Twitter/X, Slack, Discord,
 * LinkedIn) fetches /{6-digit-code}, Netlify's SPA fallback would
 * serve the stock index.html with the homepage OG tags. This function
 * intercepts that response and rewrites the og:* / twitter:* meta so
 * the preview card reflects the invite instead:
 *
 *   og:image     → /og/invite/{code}.png   (dynamic, generated)
 *   og:title     → "You're invited · Code {code} · MUSIXQUARE"
 *   og:desc      → English join prompt including the code
 *   og:url       → https://musixquare.com/{code}
 *   og:image:alt → accessibility text with the code
 *
 * Copy is English-only. The Korean variant was dropped because the
 * Korean invite text read as spammy and the subsetted Korean glyphs
 * rendered poorly at card size.
 *
 * Cache policy:
 *   Browser 60s, CDN 15m. Same code → same rewrite, so aggressive
 *   caching is safe. Short-ish to let copy fixes roll out without
 *   waiting a week.
 *
 * Non-HTML responses (e.g. if Netlify routes /123456 to an asset for
 * any reason) pass through untouched.
 */

// Netlify's bundler auto-maps this to https://edge.netlify.com/v1/index.ts
// via the edge-bundler import map — see build log's resolved importMapData.
import type { Context } from "@netlify/edge-functions";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildMeta(code: string, origin: string) {
  const imageUrl = `${origin}/og/invite/${code}.png`;
  const pageUrl = `${origin}/${code}`;
  const title = `Session ${code} · MUSIXQUARE`;
  const description = `Join a MUSIXQUARE session with code ${code}.`;
  const alt = `MUSIXQUARE · Session ${code}`;

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

  // Let Netlify's pipeline (SPA fallback) resolve to index.html first.
  // Anything below this point that throws should NOT kill the page —
  // crawlers get the original (homepage) OG card, which is the same
  // graceful-degradation behavior they'd have if this function didn't
  // exist at all.
  const response = await context.next();
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;

  try {
    const html = await response.text();
    // Use the request's origin so OG URLs stay on the same host the
    // crawler was visiting. On production this is musixquare.com; on
    // Deploy Preview it's deploy-preview-*.netlify.app. This is what
    // lets SNS debuggers actually preview the card on a PR branch.
    const { imageUrl, pageUrl, title, description, alt } = buildMeta(code, url.origin);

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
    headers.delete("Content-Length"); // response body byte length changed

    return new Response(rewritten, {
      status: response.status,
      headers,
    });
  } catch (err) {
    // Fall through to the original response unchanged. The crawler gets
    // the homepage card; the join flow still works for the actual user
    // because SPA JS reads window.location.pathname client-side.
    const headers = new Headers(response.headers);
    headers.set("X-Invite-Rewrite-Error", err instanceof Error ? err.message : "unknown");
    headers.delete("Content-Length");
    return new Response(response.body, { status: response.status, headers });
  }
}

export const config = {
  // Match single-segment paths. Handler regex filters to 6-digit codes.
  // Known static single-segment paths short-circuited here to skip
  // invocations on high-traffic pages.
  path: "/:code",
  excludedPath: [
    "/about",
    "/privacy",
    "/terms",
    "/history",
    "/faq",
    "/landing",
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
