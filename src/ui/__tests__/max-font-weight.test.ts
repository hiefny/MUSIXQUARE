import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

function sourceFiles(repository = process.cwd()): string[] {
  // Match the authored JS/inline inventory: include new source before staging,
  // but not ignored local build copies (for example cloudflare/scratch/).
  // Tracked files remain in scope even if an ignore rule happens to match them.
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...ROOTS],
    { cwd: repository, encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => TEXT_FILE.test(file) && !SKIPPED.test(file))
    .filter((file) => {
      const absolute = path.join(repository, file);
      return existsSync(absolute) && statSync(absolute).isFile();
    });
}

describe('maximum text weight', () => {
  it('checks tracked and new authored sources without scanning ignored build copies', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'mxqr-text-weight-'));
    if (path.dirname(path.resolve(repository)) !== path.resolve(tmpdir())) {
      throw new Error('Refusing to use a fixture outside the temporary directory');
    }
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: repository });
      await mkdir(path.join(repository, 'cloudflare/scratch/app-bundle'), { recursive: true });
      await writeFile(path.join(repository, '.gitignore'), 'scratch/\n');
      await writeFile(path.join(repository, 'cloudflare/app-worker.ts'), 'fontWeight: 800');
      await writeFile(path.join(repository, 'cloudflare/new-page.ts'), 'fontWeight: 800');
      await writeFile(
        path.join(repository, 'cloudflare/scratch/app-bundle/app-worker.js'),
        'fontWeight: 800',
      );
      await writeFile(path.join(repository, 'cloudflare/scratch/tracked.ts'), 'fontWeight: 800');
      execFileSync('git', ['add', 'cloudflare/app-worker.ts'], { cwd: repository });
      execFileSync('git', ['add', '--force', 'cloudflare/scratch/tracked.ts'], { cwd: repository });

      expect(sourceFiles(repository).sort()).toEqual([
        'cloudflare/app-worker.ts',
        'cloudflare/new-page.ts',
        'cloudflare/scratch/tracked.ts',
      ]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('keeps every text weight at 700 or below', async () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
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
