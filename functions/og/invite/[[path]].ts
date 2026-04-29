/**
 * Cloudflare Pages Function: /og/invite/{6-digit-code}.png
 *
 * Dynamic OG card for invite links — Pretendard-rendered brand wordmark,
 * "You're invited" greeting, and the code in a tracked-out 96px box.
 * 1200×630 PNG, English-only copy.
 *
 * Pipeline (per worker isolate, lazy-cached):
 *   1. Fetch Resvg WASM from /og-resvg.wasm
 *   2. Fetch Pretendard Bold + ExtraBold subsets
 *   3. Fetch + recolor brand wordmark SVG (white fill)
 *   Cold-start ~200–400ms, warm ~80–230ms (Satori + Resvg).
 *
 * Cache: browser 24h, CDN 7d. Same code → same image.
 *
 * Errors return 500 + no-store so crawlers retry without pinning a
 * broken response.
 */

import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

// ─── Lazy-loaded assets (per isolate) ───────────────────────────
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
    // Pull brand wordmark from the design system, bake a white fill
    // (Satori's <img> doesn't propagate currentColor), and cache the
    // resulting data URL for the isolate lifetime.
    const resp = await fetch(new URL("/designsystem/assets/logo-wordmark.svg", origin));
    if (!resp.ok) throw new Error(`Wordmark fetch failed: HTTP ${resp.status}`);
    const raw = await resp.text();
    const white = raw.replace(/currentColor/g, "white");
    wordmarkDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(white)}`;
  }
}

// ─── Card template ──────────────────────────────────────────────
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
            src: wordmarkDataUrl,
            width: 712,
            height: 87,
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

// ─── Handler ────────────────────────────────────────────────────
export const onRequest: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/og\/invite\/(\d{6})\.png$/);
  if (!match) return new Response("Not found", { status: 404 });

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
};
