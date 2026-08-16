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
 * Usage: node scripts/subset-og-fonts.mts
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import subsetFont from 'subset-font';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// ─── Target text (every glyph used anywhere in the OG card family) ─
// Invite OG card copy is English-only.
// Shared by invite-og (dynamic), og-history, and og-designsystem.
// Full Latin A–Z / a–z / 0–9 plus common punctuation — adds ~8 KB per
// weight but buys flexibility if card copy changes.
const TARGET_TEXT = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  '·—→.,:;\'"() ',
].join('');

// ─── Input / Output ───────────────────────────────────────────────
const INPUT = {
  bold: path.join(repoRoot, 'fonts/Pretendard-Bold.ttf'),
  extrabold: path.join(repoRoot, 'fonts/Pretendard-ExtraBold.ttf'),
};
const OUTPUT_DIR = path.join(repoRoot, 'public/fonts');
const OUTPUT = {
  bold: path.join(OUTPUT_DIR, 'og-pretendard-bold.ttf'),
  extrabold: path.join(OUTPUT_DIR, 'og-pretendard-extrabold.ttf'),
};

export async function createOgFontSubset(source: Uint8Array): Promise<Uint8Array> {
  const subset = await subsetFont(source, TARGET_TEXT, { targetFormat: 'truetype' });
  if (!Buffer.isBuffer(subset)) {
    throw new TypeError('subset-font returned a non-Buffer result');
  }
  return subset;
}

async function subsetOne(weightName: string, inPath: string, outPath: string): Promise<void> {
  const srcBuffer = await readFile(inPath);
  const srcSize = srcBuffer.byteLength;

  const subset = await createOgFontSubset(srcBuffer);

  await writeFile(outPath, subset);
  const outSize = subset.byteLength;

  const reduction = (100 * (1 - outSize / srcSize)).toFixed(1);
  console.log(
    `  ${weightName.padEnd(10)} ${fmtKB(srcSize).padStart(8)}  →  ${fmtKB(outSize).padStart(8)}  (${reduction}% smaller)`,
  );
}

function fmtKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main(): Promise<void> {
  // Verify inputs
  for (const [name, p] of Object.entries(INPUT)) {
    try {
      await stat(p);
    } catch {
      console.error(`\n❌ Missing input: ${p}`);
      console.error(
        `   Place Pretendard-${name === 'bold' ? 'Bold' : 'ExtraBold'}.ttf under fonts/`,
      );
      process.exit(1);
    }
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(`\n▸ Subsetting Pretendard with ${TARGET_TEXT.length} chars`);
  console.log(`  Target: "${TARGET_TEXT}"\n`);
  console.log(`  ${'weight'.padEnd(10)} ${'full'.padStart(8)}     ${'subset'.padStart(8)}`);
  console.log(`  ${'-'.repeat(10)} ${'-'.repeat(8)}     ${'-'.repeat(8)}`);

  await subsetOne('Bold', INPUT.bold, OUTPUT.bold);
  await subsetOne('ExtraBold', INPUT.extrabold, OUTPUT.extrabold);

  console.log(`\n✓ Wrote subsets to public/fonts/\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error('\n❌ Subset failed:', error);
    process.exit(1);
  });
}
