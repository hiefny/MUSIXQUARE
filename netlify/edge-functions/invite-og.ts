/**
 * Netlify Edge Function: invite-og
 *
 * Serves dynamic OG images at /og/invite/{6-digit-code}.png with an
 * optional ?l=ko|en language hint. The image is a 1200×630 bilingual
 * invite card — Pretendard-rendered brand wordmark, "You're invited" /
 * "초대됐어요" greeting, and the code in a tracked-out 96px tabular-ish
 * numeral box.
 *
 * Pipeline (per container cold start):
 *   1. Fetch Resvg WASM from /og-resvg.wasm (one-time initWasm)
 *   2. Fetch Pretendard Bold + ExtraBold subsets from /fonts/
 *   3. Initialize WASM
 *   Cold-start cost ≈ 200–400 ms; warm requests only pay Satori render
 *   (~50–150 ms) plus Resvg rasterization (~30–80 ms).
 *
 * Cache policy:
 *   Browser 24 h, CDN 7 d. Same code → same image, so aggressive caching
 *   is safe. Each crawler (Facebookexternalhit, Twitterbot, KakaoTalk,
 *   LinkedInBot) hits once per code; subsequent hits are edge-cached.
 *
 * Error handling:
 *   Any failure in asset load / Satori / Resvg returns 500 with a plain
 *   text body and Cache-Control: no-store so crawlers retry without
 *   pinning a broken response.
 */

// URL imports (esm.sh) — npm: specifiers are flagged experimental by
// Netlify's Deno-based Edge Function runtime. Versions pinned to the
// exact devDependency versions so local smoke tests and edge deploy
// render with the same library build.
import satori from "https://esm.sh/satori@0.26.0";
import { Resvg, initWasm } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";

// ─── Lazy-loaded assets (per container) ──────────────────────────
let wasmReady: Promise<void> | null = null;
let boldFont: ArrayBuffer | null = null;
let extraboldFont: ArrayBuffer | null = null;
let wordmarkDataUrl: string | null = null;

async function loadAssets(origin: string): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const resp = await fetch(new URL("/og-resvg.wasm", origin));
      if (!resp.ok) throw new Error(`WASM fetch failed: HTTP ${resp.status}`);
      await initWasm(await resp.arrayBuffer());
    })();
  }
  await wasmReady;

  if (!boldFont) {
    const resp = await fetch(new URL("/fonts/og-pretendard-bold.ttf", origin));
    if (!resp.ok) throw new Error(`Bold font fetch failed: HTTP ${resp.status}`);
    boldFont = await resp.arrayBuffer();
  }
  if (!extraboldFont) {
    const resp = await fetch(new URL("/fonts/og-pretendard-extrabold.ttf", origin));
    if (!resp.ok) throw new Error(`ExtraBold font fetch failed: HTTP ${resp.status}`);
    extraboldFont = await resp.arrayBuffer();
  }
  if (!wordmarkDataUrl) {
    // Pull the brand wordmark from the design system, bake a white fill
    // (Satori's <img> doesn't propagate currentColor from the host tree),
    // and cache the resulting data URL for the container lifetime.
    const resp = await fetch(new URL("/designsystem/assets/logo-wordmark.svg", origin));
    if (!resp.ok) throw new Error(`Wordmark fetch failed: HTTP ${resp.status}`);
    const raw = await resp.text();
    const white = raw.replace(/currentColor/g, "white");
    wordmarkDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(white)}`;
  }
}

// ─── Card template ───────────────────────────────────────────────
interface CardProps {
  code: string;
}

function buildCard({ code }: CardProps): unknown {
  const greeting = "You're invited";

  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        background: "linear-gradient(135deg, #3b82f6 0%, #1e40af 100%)",
        color: "white",
        fontFamily: "Pretendard",
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              fontSize: 40,
              fontWeight: 700,
              opacity: 0.92,
              letterSpacing: -0.5,
            },
            children: greeting,
          },
        },
        {
          type: "img",
          props: {
            // Brand wordmark SVG (white fill). Width/height mirror the
            // previous 88px ExtraBold text weight at the card's aspect.
            src: wordmarkDataUrl,
            width: 712,
            height: 80,
            style: { marginTop: 16 },
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              marginTop: 56,
              padding: "28px 56px",
              background: "rgba(255, 255, 255, 0.22)",
              borderRadius: 24,
              fontSize: 96,
              fontWeight: 800,
              letterSpacing: 14,
            },
            children: code,
          },
        },
      ],
    },
  };
}

// ─── Handler ──────────────────────────────────────────────────────
export default async function handler(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/og\/invite\/(\d{6})\.png$/);
  if (!match) return;

  const code = match[1];

  try {
    await loadAssets(url.origin);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svg = await satori(buildCard({ code }) as any, {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Pretendard", data: boldFont!, weight: 700, style: "normal" },
        { name: "Pretendard", data: extraboldFont!, weight: 800, style: "normal" },
      ],
    });

    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
    const png = resvg.render().asPng();

    return new Response(png, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400, s-maxage=604800",
        "X-Invite-Code": code,
        "X-OG-Source": "satori",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`OG generation failed: ${message}`, {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
}

export const config = {
  // Wildcard match; the handler's regex is the authoritative filter.
  // Using a wildcard here (rather than `:code.png`) avoids ambiguity in
  // Netlify's URLPattern parser around dotted segment suffixes.
  path: "/og/invite/*",
};
