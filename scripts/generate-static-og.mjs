#!/usr/bin/env node
/**
 * Static OG PNG generator for /roadmap and /changelog.
 *
 * Unlike the invite card which renders per-request at the edge, these
 * two pages have fixed copy — so we render them once here and commit
 * the resulting PNGs under public/. The runtime cost of this is zero.
 *
 * Output:
 *   public/og-roadmap.png
 *   public/og-changelog.png
 *
 * Cards share the invite card's visual language (blue gradient, white
 * Pretendard) so the /musixquare.com namespace reads as one family.
 *
 * Usage: node scripts/generate-static-og.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// ─── Card templates ──────────────────────────────────────────────
function card({ eyebrow, headline, tagline }) {
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
              fontSize: 32,
              fontWeight: 700,
              opacity: 0.75,
              letterSpacing: 4,
            },
            children: eyebrow,
          },
        },
        {
          type: "div",
          props: {
            style: {
              fontSize: 132,
              fontWeight: 800,
              marginTop: 24,
              letterSpacing: -3,
            },
            children: headline,
          },
        },
        {
          type: "div",
          props: {
            style: {
              fontSize: 30,
              fontWeight: 700,
              marginTop: 32,
              opacity: 0.85,
              letterSpacing: -0.2,
            },
            children: tagline,
          },
        },
      ],
    },
  };
}

const CARDS = [
  {
    outFile: "public/og-roadmap.png",
    props: {
      eyebrow: "MUSIXQUARE",
      headline: "Roadmap",
      tagline: "Every known limit · Documented",
    },
  },
  {
    outFile: "public/og-changelog.png",
    props: {
      eyebrow: "MUSIXQUARE",
      headline: "Changelog",
      tagline: "The build log · Oct 2025 → now",
    },
  },
];

async function main() {
  const [bold, extrabold, wasm] = await Promise.all([
    readFile(path.join(repoRoot, "public/fonts/og-pretendard-bold.ttf")),
    readFile(path.join(repoRoot, "public/fonts/og-pretendard-extrabold.ttf")),
    readFile(path.join(repoRoot, "node_modules/@resvg/resvg-wasm/index_bg.wasm")),
  ]);
  await initWasm(wasm);

  for (const { outFile, props } of CARDS) {
    const t0 = performance.now();
    const svg = await satori(card(props), {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Pretendard", data: bold, weight: 700, style: "normal" },
        { name: "Pretendard", data: extrabold, weight: 800, style: "normal" },
      ],
    });
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
    const png = resvg.render().asPng();
    const t1 = performance.now();

    const absOut = path.join(repoRoot, outFile);
    await writeFile(absOut, png);

    console.log(
      `  ${outFile.padEnd(28)}  ${(t1 - t0).toFixed(0).padStart(4)} ms  ${(png.length / 1024).toFixed(1).padStart(6)} KB`,
    );
  }

  console.log(`\n✓ Wrote ${CARDS.length} static OG PNGs.\n`);
}

main().catch((err) => {
  console.error("\n❌ Static OG generation failed:", err);
  process.exit(1);
});
