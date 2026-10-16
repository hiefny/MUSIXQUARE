import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Owner decision (2026-10-16): no text anywhere in the project renders above
// weight 700, including titles, codes and badges. Heavier weights lose
// legibility on low-resolution screens.
const MAX_TEXT_WEIGHT = 700;
const ROOTS = [
  'index.html',
  'e2e/report-viewer.html',
  'css',
  'public',
  '.workshop',
  'browser',
  'cloudflare',
  'src',
  'scripts',
];
const TEXT_FILE = /\.(?:css|html|svg|ts|tsx|mts|js|mjs)$/u;
const SKIPPED = /(?:^|[\\/])(?:__tests__|node_modules|dist|src_ref)(?:[\\/]|$)/u;
const WEIGHT_PATTERNS = [
  // CSS declarations; an @font-face range such as `100 900` is not text.
  /font-weight\s*:\s*(\d{3})\b(?!\s+\d)/gu,
  /font-weight\s*=\s*["']?(\d{3})\b/gu,
  /fontWeight\s*[:=]\s*["'`]?(\d{3})\b/gu,
  /\bfont\s*:\s*(\d{3})\s/gu,
  // Canvas and FontFaceSet font strings such as '700 15px "Pretendard"'.
  /["'`](\d{3})\s+\d+(?:\.\d+)?(?:px|rem|em)\b/gu,
  /["']wght["']\s*,?\s*(\d{3})\b/gu,
];

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of ROOTS) {
    if (TEXT_FILE.test(root)) {
      files.push(root);
      continue;
    }
    for (const entry of await readdir(root, { recursive: true })) {
      const file = path.join(root, entry);
      if (TEXT_FILE.test(file) && !SKIPPED.test(file)) files.push(file);
    }
  }
  return files;
}

describe('maximum text weight', () => {
  it('keeps every text weight at 700 or below', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles()) {
      const source = await readFile(file, 'utf8');
      for (const pattern of WEIGHT_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          if (Number(match[1]) > MAX_TEXT_WEIGHT) violations.push(`${file}: ${match[0]}`);
        }
      }
      if (/font-weight\s*:\s*bolder/u.test(source)) violations.push(`${file}: bolder`);
    }

    expect(violations).toEqual([]);
  });
});
