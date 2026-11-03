/**
 * What the public-page font train retired, and where Pretendard may still
 * load or be named as a font. The app draws with Inter, MUSIXQUARE Hangul
 * and Noto since 9.0.29 and 9.0.33, and every page outside the app since
 * the public-page font train (scripts/lib/public-font-pages.mts), so nothing
 * a page, the app or a Worker ships loads Pretendard any more, and the files
 * only those pages used are gone.
 *
 * The checks look only where a text loads or names a font: a font-family,
 * font or font stack value, a fontFamily property, an @font-face rule, a
 * url(), a link, or a path to a Pretendard font file or sheet. Text that
 * credits Pretendard (the design system's Typography section, the READMEs,
 * the licence lines, comments) is none of these and stays.
 *
 * What stays on purpose: fonts/PretendardVariable.woff2, the recorded source
 * of the MUSIXQUARE Hangul faces (fonts/hangul-faces.json) and the coverage
 * reference of guard:font-assets, which no page loads; the share-image
 * generator's Bold file, its subset and the licence; the maintenance page's
 * font names (cloudflare/service-maintenance.ts ships with every Worker); a
 * frozen ad record. scripts/check-app-font.mts runs these checks over the
 * repository and the build; src/core/__tests__/font-retirement.test.ts pins
 * them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { builtAssetStem } from './app-font-guard.mts';
import { parseFontFaceRules, parseUnicodeRange } from '../fonts/font-files.mts';

/** Files and folders the train deleted; none may come back. */
export const RETIRED_FONT_PATHS: readonly string[] = [
  // The deployed copy of the Hangul source and the Pretendard sheets.
  'public/designsystem/fonts',
  'public/designsystem/src_ref',
  'css/pretendard.css',
  // Google's Noto Sans Cyrillic and Greek sheets and files: Inter draws both
  // scripts in every UI and on every page.
  'css/fonts/noto-cyrillic.css',
  'css/fonts/noto-greek.css',
  'fonts/noto/noto-sans-cyrillic',
  'fonts/noto/noto-sans-greek',
];

/**
 * Google's sheets kept as inputs of scripts/fonts/build-font-sheets.mts. The
 * generator reads only their numbered CJK shards and the Thai face, so their
 * other faces (Latin, Latin Extended, Cyrillic, Vietnamese) are not shipped,
 * as the Noto Sans KR record lists shards it does not ship.
 */
export const GENERATOR_INPUT_SHEETS: readonly string[] = [
  'css/fonts/noto-jp.css',
  'css/fonts/noto-sc.css',
  'css/fonts/noto-tc.css',
  'css/fonts/noto-thai.css',
];

/** The repository files of a generator input sheet's faces that are not shipped. */
export function unshippedFaceFiles(sheet: string, css: string): string[] {
  return parseFontFaceRules(css)
    .filter(
      (rule) =>
        !/\.\d+\.woff2$/u.test(rule.file) &&
        !parseUnicodeRange(rule.unicodeRange ?? '').has(0x0e01),
    )
    .map((rule) => path.posix.normalize(path.posix.join(path.posix.dirname(sheet), rule.url)));
}

/** Shipped text files that may still load or name Pretendard as a font, with the reason. */
export const PRETENDARD_ALLOWLIST: Readonly<Record<string, string>> = {
  'cloudflare/service-maintenance.ts':
    'the maintenance page names its fonts but loads none; every Worker imports this module, so it changes only when the Workers ship anyway',
  '.workshop/promo/manifest.json':
    'the frozen record of a past ad render, which lists the files it read; no page or Worker reads it',
};

/** The Pretendard files that stay, with the reason. */
export const PRETENDARD_FILE_ALLOWLIST: Readonly<Record<string, string>> = {
  'fonts/PretendardVariable.woff2':
    'the source the MUSIXQUARE Hangul faces are cut from (fonts/hangul-faces.json) and the coverage reference of guard:font-assets; not deployed',
  'fonts/Pretendard-Bold.ttf': 'the share-image generator source',
  'public/fonts/og-pretendard-bold.ttf':
    'the share-image subset the OG generator renders from; no page loads it',
  'fonts/PRETENDARD_LICENSE.txt': 'the licence of the files above and of MUSIXQUARE Hangul',
};

/** Where shipped text lives: the app, the public pages and the Workers. */
const SCAN_ROOTS = [
  'index.html',
  'vite.config.ts',
  '.workshop',
  'public',
  'css',
  'src',
  'browser',
  'cloudflare',
  'e2e/report-viewer.html',
] as const;

/** Where a Pretendard file could hide. */
const FILE_NAME_ROOTS = ['fonts', 'public', 'css', 'src', 'browser', 'cloudflare', '.workshop'];

const TEXT_FILE = /\.(?:html|css|ts|mts|tsx|js|mjs|json|md|txt|svg|webmanifest|xml|toml|ya?ml)$/iu;

/**
 * The places a text loads or names a font as Pretendard. Comments of CSS
 * and HTML do not count; a path to a file that stays (PRETENDARD_FILE_ALLOWLIST,
 * by its repository path) does not either.
 */
const FONT_REFERENCES: readonly RegExp[] = [
  // font-family, the font shorthand and font stack properties.
  /(?<![\w-])font(?:-family)?\s*:[^;{}<>\n]*pretendard[^;{}<>\n]*/giu,
  /--font[\w-]*\s*:[^;{}<>\n]*pretendard[^;{}<>\n]*/giu,
  // A style object's fontFamily.
  /\bfontFamily\s*[:=][^,;}\n]*pretendard[^,;}\n]*/giu,
  // A face, a url() and a link.
  /@font-face\s*\{[^}]*pretendard[^}]*\}/giu,
  /\burl\(\s*[^)]*pretendard[^)]*\)/giu,
  /<link\b[^>]*pretendard[^>]*>/giu,
];
const PRETENDARD_FILE_PATH = /(?<![\w./-])[\w./-]*pretendard[\w.-]*\.(?:woff2?|ttf|otf|css)\b/giu;

function withoutComments(file: string, text: string): string {
  if (/\.css$/iu.test(file)) return text.replace(/\/\*[\s\S]*?\*\//gu, ' ');
  if (/\.(?:html|svg|xml)$/iu.test(file)) {
    return text
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(
        /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/giu,
        (_match, open, css, close) =>
          `${open}${String(css).replace(/\/\*[\s\S]*?\*\//gu, ' ')}${close}`,
      );
  }
  return text;
}

/**
 * Where a text loads or names a font as Pretendard, as the matched snippets;
 * the file name tells which comments to skip. Credits in visible text or
 * comments are not reported.
 */
export function pretendardFontReferences(file: string, text: string): string[] {
  const code = withoutComments(file, text);
  const found = new Set<string>();
  for (const pattern of FONT_REFERENCES) {
    for (const match of code.matchAll(pattern)) found.add(match[0].replace(/\s+/gu, ' ').trim());
  }
  for (const match of code.matchAll(PRETENDARD_FILE_PATH)) {
    const reference = match[0].replace(/^\.\//u, '');
    if (!(reference in PRETENDARD_FILE_ALLOWLIST)) found.add(reference);
  }
  return [...found];
}

function isTestFile(relative: string): boolean {
  return /(?:^|\/)__tests__\//u.test(relative) || /\.test\.tsx?$/u.test(relative);
}

function walk(repoRoot: string, relative: string): string[] {
  const absolute = path.join(repoRoot, relative);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [relative];
  return readdirSync(absolute)
    .sort()
    .flatMap((entry) =>
      entry === 'node_modules' || entry === 'dist' ? [] : walk(repoRoot, `${relative}/${entry}`),
    );
}

/**
 * Where the shipped source loads or names Pretendard as a font outside the
 * allowlist, and the Pretendard files outside the file allowlist, each as
 * "repository path: what".
 */
export function pretendardMentions(repoRoot: string): string[] {
  const found = new Set<string>();
  for (const root of SCAN_ROOTS) {
    for (const file of walk(repoRoot, root)) {
      if (!TEXT_FILE.test(file) || isTestFile(file) || file in PRETENDARD_ALLOWLIST) continue;
      for (const reference of pretendardFontReferences(
        file,
        readFileSync(path.join(repoRoot, file), 'utf8'),
      )) {
        found.add(`${file}: ${reference}`);
      }
    }
  }
  for (const root of FILE_NAME_ROOTS) {
    for (const file of walk(repoRoot, root)) {
      if (/pretendard/iu.test(path.posix.basename(file)) && !(file in PRETENDARD_FILE_ALLOWLIST)) {
        found.add(`${file}: a Pretendard file`);
      }
    }
  }
  return [...found].sort();
}

/** The built sheets of the retired sheets and the generator inputs, by stem. */
const UNBUILT_SHEET_STEMS: ReadonlySet<string> = new Set(
  [...RETIRED_FONT_PATHS, ...GENERATOR_INPUT_SHEETS]
    .filter((file) => file.endsWith('.css'))
    .map((file) => path.posix.basename(file, '.css')),
);

/**
 * What of the retired fonts a build holds, by dist-relative path: a
 * Pretendard file other than the deployed share-image subset, a file under a
 * retired public folder, or a built copy of a retired or generator-input
 * sheet.
 */
export function retiredBuildFiles(files: readonly string[]): string[] {
  const deployedKeep = new Set(
    Object.keys(PRETENDARD_FILE_ALLOWLIST)
      .filter((file) => file.startsWith('public/'))
      .map((file) => file.slice('public/'.length)),
  );
  const retiredFolders = RETIRED_FONT_PATHS.filter((file) => file.startsWith('public/')).map(
    (file) => `${file.slice('public/'.length)}/`,
  );
  const problems: string[] = [];
  for (const file of files) {
    if (/pretendard/iu.test(path.posix.basename(file)) && !deployedKeep.has(file)) {
      problems.push(`${file} is a Pretendard file`);
    } else if (retiredFolders.some((folder) => file.startsWith(folder))) {
      problems.push(`${file} is under a retired folder`);
    } else if (file.endsWith('.css') && UNBUILT_SHEET_STEMS.has(builtAssetStem(file))) {
      problems.push(`${file} is a built copy of a sheet no page links`);
    }
  }
  return problems;
}
