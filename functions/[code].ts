/**
 * Cloudflare Pages Function: /{6-digit-code}
 *
 * When a crawler (KakaoTalk, Facebook, Twitter/X, Slack, Discord,
 * LinkedIn) fetches /{code}, the SPA fallback would serve the stock
 * index.html with the homepage OG tags. This function intercepts and
 * rewrites og:* / twitter:* meta so the preview card reflects the
 * invite instead:
 *
 *   og:image     → /og/invite/{code}.png   (dynamic, generated)
 *   og:title     → "Session {code} · MUSIXQUARE"
 *   og:desc      → English join prompt with the code
 *   og:url       → https://musixquare.com/{code}
 *   og:image:alt → accessibility text with the code
 *
 * English-only copy. Korean variant was dropped for legibility.
 *
 * Cache: browser 60s, CDN 15m.
 *
 * Path matching: this file catches every single-segment URL. Any path
 * that isn't 6 digits passes through via context.next() so the static
 * asset / SPA fallback handles it as before.
 */

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

export const onRequest: PagesFunction = async ({ request, next }) => {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return next();

  const code = segments[0];
  if (!/^\d{6}$/.test(code)) return next();

  // Defer to the static asset / SPA fallback for the body, then rewrite
  // its OG meta. Anything below this point that throws should NOT kill
  // the response — crawlers fall back to the homepage card, which is
  // the same graceful-degradation behavior they'd get without this fn.
  const response = await next();
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;

  try {
    const html = await response.text();
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
    headers.delete("Content-Length"); // body byte length changed

    return new Response(rewritten, { status: response.status, headers });
  } catch (err) {
    const headers = new Headers(response.headers);
    headers.set("X-Invite-Rewrite-Error", err instanceof Error ? err.message : "unknown");
    headers.delete("Content-Length");
    return new Response(response.body, { status: response.status, headers });
  }
};
