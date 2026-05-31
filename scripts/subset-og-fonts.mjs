#!/usr/bin/env node
/**
 * Pretendard Subsetter for Invite OG Cards
 *
 * Takes the full Pretendard-Bold.ttf / Pretendard-ExtraBold.ttf from
 * fonts/ and produces tiny subsets covering only the glyphs
 * used in the invite OG card template.
 *
 * Output: public/fonts/og-pretendard-{bold,extrabold}.ttf
 *
 * Subset target text — any character that appears in the rendered
 * invite card must be here. Update this string and re-run if you add
 * new copy. The final TTFs should land well under 50 KB each.
 *
 * Usage: node scripts/subset-og-fonts.mjs
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import subsetFont from "subset-font";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// ─── Target text (every glyph used anywhere in the OG card family) ─
// English-only since the invite card's Korean variant was dropped.
// Shared by invite-og (dynamic), og-roadmap, og-changelog, og-designsystem.
// Full Latin A–Z / a–z / 0–9 plus common punctuation — adds ~8 KB per
// weight but buys flexibility if card copy changes.
const TARGET_TEXT = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "·—→.,:;'\"() ",
].join("");

// ─── Input / Output ───────────────────────────────────────────────
const INPUT = {
  bold: path.join(repoRoot, "fonts/Pretendard-Bold.ttf"),
  extrabold: path.join(repoRoot, "fonts/Pretendard-ExtraBold.ttf"),
};
const OUTPUT_DIR = path.join(repoRoot, "public/fonts");
const OUTPUT = {
  bold: path.join(OUTPUT_DIR, "og-pretendard-bold.ttf"),
  extrabold: path.join(OUTPUT_DIR, "og-pretendard-extrabold.ttf"),
};

async function subsetOne(weightName, inPath, outPath) {
  const srcBuffer = await readFile(inPath);
  const srcSize = srcBuffer.byteLength;

  const subset = await subsetFont(srcBuffer, TARGET_TEXT, {
    targetFormat: "truetype",
  });

  await writeFile(outPath, subset);
  const outSize = subset.byteLength;

  const reduction = (100 * (1 - outSize / srcSize)).toFixed(1);
  console.log(
    `  ${weightName.padEnd(10)} ${fmtKB(srcSize).padStart(8)}  →  ${fmtKB(outSize).padStart(8)}  (${reduction}% smaller)`,
  );
}

function fmtKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  // Verify inputs
  for (const [name, p] of Object.entries(INPUT)) {
    try {
      await stat(p);
    } catch {
      console.error(`\n❌ Missing input: ${p}`);
      console.error(`   Place Pretendard-${name === "bold" ? "Bold" : "ExtraBold"}.ttf under fonts/`);
      process.exit(1);
    }
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(`\n▸ Subsetting Pretendard with ${TARGET_TEXT.length} chars`);
  console.log(`  Target: "${TARGET_TEXT}"\n`);
  console.log(`  ${"weight".padEnd(10)} ${"full".padStart(8)}     ${"subset".padStart(8)}`);
  console.log(`  ${"-".repeat(10)} ${"-".repeat(8)}     ${"-".repeat(8)}`);

  await subsetOne("Bold", INPUT.bold, OUTPUT.bold);
  await subsetOne("ExtraBold", INPUT.extrabold, OUTPUT.extrabold);

  console.log(`\n✓ Wrote subsets to public/fonts/\n`);
}

main().catch((err) => {
  console.error("\n❌ Subset failed:", err);
  process.exit(1);
});
