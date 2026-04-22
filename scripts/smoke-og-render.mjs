#!/usr/bin/env node
/**
 * Smoke test for the invite-og card template.
 *
 * Catches Satori errors (unsupported CSS, missing glyphs, flex mistakes)
 * locally before pushing to a Deploy Preview. Writes the output SVG to
 * scratch/invite-og-smoke.svg — open in a browser to visually check.
 *
 * Usage: node scripts/smoke-og-render.mjs [code] [lang]
 *   node scripts/smoke-og-render.mjs              → 839412 ko
 *   node scripts/smoke-og-render.mjs 123456 en    → 123456 en
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const code = process.argv[2] || "839412";
const lang = process.argv[3] === "en" ? "en" : "ko";

function buildCard({ code, lang }) {
  const greeting = lang === "ko" ? "초대됐어요" : "You're invited";

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
            style: { fontSize: 40, fontWeight: 700, opacity: 0.92, letterSpacing: -0.5 },
            children: greeting,
          },
        },
        {
          type: "div",
          props: {
            style: { fontSize: 88, fontWeight: 800, marginTop: 16, letterSpacing: -2 },
            children: "MUSIXQUARE",
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

async function main() {
  const bold = await readFile(path.join(repoRoot, "public/fonts/og-pretendard-bold.ttf"));
  const extrabold = await readFile(path.join(repoRoot, "public/fonts/og-pretendard-extrabold.ttf"));

  console.log(`▸ Rendering code=${code} lang=${lang}`);

  const t0 = performance.now();
  const svg = await satori(buildCard({ code, lang }), {
    width: 1200,
    height: 630,
    fonts: [
      { name: "Pretendard", data: bold, weight: 700, style: "normal" },
      { name: "Pretendard", data: extrabold, weight: 800, style: "normal" },
    ],
  });
  const t1 = performance.now();

  await mkdir(path.join(repoRoot, "scratch"), { recursive: true });
  const svgPath = path.join(repoRoot, `scratch/invite-og-smoke-${code}-${lang}.svg`);
  await writeFile(svgPath, svg);

  // Rasterize to PNG with resvg-wasm (same pipeline as the Edge Function)
  const wasmBuffer = await readFile(path.join(repoRoot, "node_modules/@resvg/resvg-wasm/index_bg.wasm"));
  await initWasm(wasmBuffer);
  const t2 = performance.now();
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
  const png = resvg.render().asPng();
  const t3 = performance.now();
  const pngPath = path.join(repoRoot, `scratch/invite-og-smoke-${code}-${lang}.png`);
  await writeFile(pngPath, png);

  console.log(`  satori: ${(t1 - t0).toFixed(0)} ms   svg=${(svg.length / 1024).toFixed(1)} KB`);
  console.log(`  resvg:  ${(t3 - t2).toFixed(0)} ms   png=${(png.length / 1024).toFixed(1)} KB`);
  console.log(`  svg:    ${path.relative(repoRoot, svgPath)}`);
  console.log(`  png:    ${path.relative(repoRoot, pngPath)}`);
  console.log(`\n✓ Both formats written to scratch/.\n`);
}

main().catch((err) => {
  console.error("\n❌ Smoke render failed:", err);
  process.exit(1);
});
