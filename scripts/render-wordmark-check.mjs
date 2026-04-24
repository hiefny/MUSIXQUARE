#!/usr/bin/env node
/**
 * Renders the wordmark SVG alone at a large size to inspect the Q
 * tail rendering without any Satori layout interference.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

async function main() {
  const wasmBuffer = await readFile(
    path.join(repoRoot, "node_modules/@resvg/resvg-wasm/index_bg.wasm"),
  );
  await initWasm(wasmBuffer);

  const rawSvg = await readFile(
    path.join(repoRoot, "public/designsystem/assets/logo-wordmark.svg"),
    "utf8",
  );

  // Force dark theme rendering on a light background so we can see the glyphs.
  const svg = rawSvg
    .replace(/fill="currentColor"/g, 'fill="#1a1a1a"')
    .replace(/<svg /, '<svg style="background:#f5f5f5" ');

  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 2000 } });
  const png = resvg.render().asPng();
  const outPath = path.join(repoRoot, "scratch/wordmark-inspect.png");
  await writeFile(outPath, png);
  console.log(`Wrote ${path.relative(repoRoot, outPath)} (${(png.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error("\n❌ wordmark check failed:", err);
  process.exit(1);
});
