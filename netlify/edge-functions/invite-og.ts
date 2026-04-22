/**
 * Netlify Edge Function: invite-og
 *
 * Serves per-invite-code OG images at /og/invite/{code}.png
 *
 * Phase 2 (current): Returns the main og-image.png as a placeholder so the
 *   routing, caching, and response pipeline can be verified on Deploy
 *   Preview before we wire up Satori + Resvg.
 *
 * Phase 3+: Replaces the fetch fallback with a Satori-rendered 1200×630
 *   PNG containing the 6-digit code and a bilingual "You're invited ·
 *   초대됐어요" line.
 *
 * Cache policy:
 *   - Browser: 24h (max-age=86400)
 *   - CDN: 7 days (s-maxage=604800)
 *   Same code resolves to the same image, so aggressive caching is safe.
 *   Crawlers (Facebookexternalhit, Twitterbot, KakaoTalk) each hit once
 *   per unique code; subsequent requests are served from CDN without
 *   re-invoking the function.
 */

export default async function handler(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/og\/invite\/(\d{6})\.png$/);
  if (!match) return;

  const code = match[1];
  const lang = url.searchParams.get("l") === "en" ? "en" : "ko";

  // Phase 2 placeholder: fetch the main og-image and return it as-is.
  // Phase 3 will replace this block with Satori JSX → SVG → Resvg → PNG.
  const placeholderUrl = new URL("/og-image.png", url.origin);
  const upstream = await fetch(placeholderUrl);

  if (!upstream.ok) {
    return new Response("Placeholder fetch failed", { status: 502 });
  }

  const body = await upstream.arrayBuffer();

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400, s-maxage=604800",
      "X-Invite-Code": code,
      "X-Invite-Lang": lang,
      "X-OG-Source": "placeholder-phase-2",
    },
  });
}

export const config = {
  // Wildcard match; the handler's regex is the authoritative filter.
  // Using a wildcard here (rather than `:code.png`) avoids ambiguity in
  // Netlify's URLPattern parser around dotted segment suffixes.
  path: "/og/invite/*",
};
