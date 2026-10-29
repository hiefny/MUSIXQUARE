/**
 * Browser-free label width harness for the chip label guard
 * (chip-label-width.test.ts).
 *
 * It shapes one line of text with HarfBuzz the way Chromium lays it out:
 * - The font stack comes from css/style.css: the html:lang() rule that sets
 *   --font-sans for the document language, with var(--font-primary) as
 *   Pretendard. System fonts in a stack are skipped.
 * - The faces come from the @font-face rules the app loads for that language:
 *   css/pretendard.css plus the locale's css/fonts/noto-*.css, mapped in
 *   src/i18n/locale-fonts.ts (FONT_ASSET_BY_LOCALE).
 * - Every grapheme cluster takes the first face in stack order whose
 *   unicode-range and cmap cover it (per-glyph fallback). A cluster no web face
 *   covers would fall back to a system font, which this harness cannot
 *   reproduce, so it is reported in `uncovered`.
 * - Runs are split by face, by script (common characters take their
 *   neighbours' script) and by a simplified UAX #9 bidi level in right-to-left
 *   documents, then shaped with the explicit script, direction and document
 *   language, kerning on, and the wght variation of the CSS weight clamped to
 *   the face's declared range.
 *
 * The chip copy study (2026-10-29) checked it against Chromium on all 42
 * locales: 14,112 widths at 10 to 14px and weights 500 and 700 agree within
 * 0.07px, and WebKit text widths within 0.03px.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import * as hb from 'harfbuzzjs';

type DecompressWoff2 = (data: Uint8Array) => Promise<Uint8Array>;

const decompressWoff2 = createRequire(import.meta.url)('wawoff2/decompress.js') as DecompressWoff2;

interface FontFaceRule {
  readonly family: string;
  readonly file: string;
  readonly weightMin: number;
  readonly weightMax: number;
  readonly ranges: readonly (readonly [number, number])[];
}

interface LoadedFace {
  readonly face: hb.Face;
  readonly cmap: ReadonlySet<number>;
  readonly upem: number;
  readonly wght: { readonly min: number; readonly max: number } | null;
  readonly fonts: Map<number, hb.Font>;
}

export interface MeasureOptions {
  /** Catalog code, which picks the locale's font stylesheet. */
  readonly locale: string;
  /** The document language, which picks the font stack and shaping language. */
  readonly htmlLang: string;
  readonly fontSize: number;
  readonly weight: number;
  readonly letterSpacing?: number;
}

export interface Measurement {
  readonly width: number;
  /** Grapheme clusters no web face covers. */
  readonly uncovered: readonly string[];
}

export interface LabelWidthHarness {
  measure(text: string, options: MeasureOptions): Promise<Measurement>;
}

const SCRIPTS = [
  'Latin',
  'Hangul',
  'Han',
  'Hiragana',
  'Katakana',
  'Thai',
  'Arabic',
  'Hebrew',
  'Cyrillic',
  'Greek',
  'Devanagari',
  'Bengali',
  'Tamil',
  'Telugu',
  'Gujarati',
  'Kannada',
  'Malayalam',
  'Gurmukhi',
] as const;

const SCRIPT_PATTERNS = SCRIPTS.map(
  (script) => [script, new RegExp(`\\p{Script=${script}}`, 'u')] as const,
);

const SCRIPT_TAGS: Readonly<Record<string, string>> = {
  Latin: 'Latn',
  Hangul: 'Hang',
  Japanese: 'Hani',
  Thai: 'Thai',
  Arabic: 'Arab',
  Hebrew: 'Hebr',
  Cyrillic: 'Cyrl',
  Greek: 'Grek',
  Devanagari: 'Deva',
  Bengali: 'Beng',
  Tamil: 'Taml',
  Telugu: 'Telu',
  Gujarati: 'Gujr',
  Kannada: 'Knda',
  Malayalam: 'Mlym',
  Gurmukhi: 'Guru',
  Common: 'Zyyy',
};

const JAPANESE_SCRIPTS: ReadonlySet<string> = new Set(['Han', 'Hiragana', 'Katakana']);

/** src/i18n/locales.ts RTL_LANGUAGE_CODES. */
const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'fa', 'he', 'ur']);

const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '');

function parseRanges(value: string): (readonly [number, number])[] {
  return value
    .split(',')
    .map((token) => token.trim().replace(/^U\+/iu, ''))
    .filter(Boolean)
    .map((token) => {
      if (token.includes('?')) {
        return [
          parseInt(token.replace(/\?/gu, '0'), 16),
          parseInt(token.replace(/\?/gu, 'F'), 16),
        ] as const;
      }
      const [from = '', to] = token.split('-');
      return [parseInt(from, 16), parseInt(to ?? from, 16)] as const;
    });
}

function parseFontFaces(repoRoot: string, cssPath: string): FontFaceRule[] {
  const css = stripCssComments(readFileSync(cssPath, 'utf8'));
  const faces: FontFaceRule[] = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/gu)) {
    const body = match[1] ?? '';
    const property = (name: string): string | undefined =>
      new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`, 'u').exec(body)?.[1]?.trim();
    const family = (property('font-family') ?? '').replace(/['"]/gu, '');
    const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/u.exec(property('src') ?? '')?.[1];
    if (!family || !url) throw new Error(`${cssPath}: @font-face without a family or url`);
    const file = url.startsWith('/')
      ? resolve(repoRoot, 'public', url.slice(1))
      : resolve(dirname(cssPath), url);
    const weights = (property('font-weight') ?? '400').split(/\s+/u).map(Number);
    const unicodeRange = property('unicode-range');
    faces.push({
      family,
      file,
      weightMin: weights[0] ?? 400,
      weightMax: weights[1] ?? weights[0] ?? 400,
      ranges: unicodeRange ? parseRanges(unicodeRange) : [[0, 0x10ffff]],
    });
  }
  return faces;
}

const inRanges = (ranges: FontFaceRule['ranges'], codePoint: number): boolean =>
  ranges.some(([from, to]) => codePoint >= from && codePoint <= to);

const isIgnorable = (codePoint: number): boolean =>
  (codePoint >= 0x200b && codePoint <= 0x200f) ||
  (codePoint >= 0x2060 && codePoint <= 0x206f) ||
  (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
  codePoint === 0xfeff;

function scriptOf(cluster: string): string {
  for (const [script, pattern] of SCRIPT_PATTERNS) if (pattern.test(cluster)) return script;
  return 'Common';
}

type BidiClass = 'R' | 'EN' | 'L' | 'N';

function bidiClass(cluster: string): BidiClass {
  if (
    /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/u.test(cluster) &&
    /\p{L}|\p{M}/u.test(cluster)
  ) {
    return 'R';
  }
  if (/[0-9٠-٩۰-۹]/u.test(cluster)) return 'EN';
  return /\p{L}/u.test(cluster) ? 'L' : 'N';
}

/**
 * Bidi levels (UAX #9, simplified to what labels contain). In a right-to-left
 * document, right-to-left letters sit at level 1, left-to-right letters and
 * European or Arabic-Indic digits at level 2, and a neutral takes level 2 only
 * between left-to-right letters on both sides (digits count as right-to-left
 * for neutrals, rule N1). Chromium shapes each level run on its own, so a
 * digit never kerns with the period after it in a "1. ..." step label.
 */
function bidiLevels(classes: readonly BidiClass[], rtlDocument: boolean): number[] {
  const strongNeighbour = (from: number, step: 1 | -1): 'L' | 'R' => {
    for (let index = from + step; index >= 0 && index < classes.length; index += step) {
      const cls = classes[index];
      if (cls !== 'N') return cls === 'L' ? 'L' : 'R';
    }
    return 'R';
  };
  return classes.map((cls, index) => {
    if (!rtlDocument) return cls === 'R' ? 1 : 0;
    if (cls === 'R') return 1;
    if (cls === 'L' || cls === 'EN') return 2;
    return strongNeighbour(index, -1) === 'L' && strongNeighbour(index, 1) === 'L' ? 2 : 1;
  });
}

/** Locale code to its font stylesheet, read from src/i18n/locale-fonts.ts. */
function localeFontStylesheets(repoRoot: string): Map<string, string> {
  const source = readFileSync(join(repoRoot, 'src/i18n/locale-fonts.ts'), 'utf8');
  const assetCss = new Map<string, string>();
  for (const match of source.matchAll(
    /(\w+):\s*\{\s*load:\s*createRetryableStylesheet\(\s*'[^']+',\s*\(\)\s*=>\s*import\('([^']+)'\)/gu,
  )) {
    assetCss.set(match[1] ?? '', resolve(join(repoRoot, 'src/i18n'), match[2] ?? ''));
  }
  const byLocale = new Map<string, string>();
  const table = source.slice(source.indexOf('FONT_ASSET_BY_LOCALE'));
  for (const match of table.matchAll(/'?([a-z]{2,3}(?:-[a-z]+)?)'?:\s*FONT_ASSETS\.(\w+)/gu)) {
    const css = assetCss.get(match[2] ?? '');
    if (!css) throw new Error(`locale-fonts.ts: no stylesheet for FONT_ASSETS.${match[2]}`);
    byLocale.set(match[1] ?? '', css);
  }
  if (byLocale.size === 0) throw new Error('locale-fonts.ts: FONT_ASSET_BY_LOCALE not found');
  return byLocale;
}

/** The font stack for a document language, read from css/style.css. */
function fontStacks(repoRoot: string): (htmlLang: string) => readonly string[] {
  const css = stripCssComments(readFileSync(join(repoRoot, 'css/style.css'), 'utf8'));
  const rootBlock = css.slice(css.indexOf('--font-primary:'));
  const fontPrimary = /--font-primary:\s*([^;]+);/u.exec(rootBlock)?.[1]?.trim() ?? '';
  const variables = new Map<string, string>();
  for (const match of rootBlock.matchAll(/(--font-sans(?:-[\w-]+)?):\s*([^;]+);/gu)) {
    const name = match[1] ?? '';
    if (!variables.has(name)) variables.set(name, (match[2] ?? '').replace(/\s+/gu, ' ').trim());
  }
  const expand = (value: string): string[] =>
    value
      .replace(/var\(--font-primary\)/gu, fontPrimary)
      .replace(/var\((--font-sans[\w-]*)\)/gu, (_, name: string) =>
        expand(variables.get(name) ?? '').join(', '),
      )
      .split(',')
      .map((family) => family.trim().replace(/^['"]|['"]$/gu, ''))
      .filter(Boolean);
  const rules: { readonly langs: readonly string[]; readonly stack: readonly string[] }[] = [];
  for (const match of css.matchAll(
    /((?:html:lang\([^)]+\)\s*,?\s*)+)\{\s*--font-sans:\s*var\((--font-sans[\w-]*)\);\s*\}/gu,
  )) {
    const langs = [...(match[1] ?? '').matchAll(/html:lang\(([^)]+)\)/gu)].map((lang) =>
      (lang[1] ?? '').trim().toLowerCase(),
    );
    rules.push({ langs, stack: expand(`var(${match[2]})`) });
  }
  const defaultStack = expand(variables.get('--font-sans') ?? '');
  if (!fontPrimary || defaultStack.length === 0 || rules.length === 0) {
    throw new Error('css/style.css: font stacks not found');
  }
  return (htmlLang) => {
    const lang = htmlLang.toLowerCase();
    let stack: readonly string[] = defaultStack;
    for (const rule of rules) {
      if (rule.langs.some((range) => lang === range || lang.startsWith(`${range}-`))) {
        stack = rule.stack;
      }
    }
    return stack;
  };
}

export function createLabelWidthHarness({
  repoRoot,
}: {
  readonly repoRoot: string;
}): LabelWidthHarness {
  const stylesheetByLocale = localeFontStylesheets(repoRoot);
  const pretendardFaces = parseFontFaces(repoRoot, join(repoRoot, 'css/pretendard.css'));
  const stackFor = fontStacks(repoRoot);
  const loaded = new Map<string, Promise<LoadedFace>>();
  const facesByLocale = new Map<string, readonly FontFaceRule[]>();
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

  /**
   * A face's font file as SFNT bytes. The faces one guard run needs
   * decompress in well under a second, so nothing is cached on disk.
   */
  async function readSfnt(file: string): Promise<Uint8Array> {
    const raw = readFileSync(file);
    return file.endsWith('.woff2') ? decompressWoff2(raw) : raw;
  }

  function loadFace(rule: FontFaceRule): Promise<LoadedFace> {
    let pending = loaded.get(rule.file);
    if (!pending) {
      pending = readSfnt(rule.file).then((sfnt) => {
        const face = new hb.Face(new hb.Blob(sfnt), 0);
        const wght = face.getAxisInfos()['wght'];
        return {
          face,
          cmap: new Set(face.collectUnicodes()),
          upem: face.upem,
          wght: wght ? { min: wght.min, max: wght.max } : null,
          fonts: new Map<number, hb.Font>(),
        };
      });
      loaded.set(rule.file, pending);
    }
    return pending;
  }

  function fontAt(entry: LoadedFace, rule: FontFaceRule, weight: number): hb.Font {
    const clamped = Math.min(rule.weightMax, Math.max(rule.weightMin, weight));
    let font = entry.fonts.get(clamped);
    if (!font) {
      font = new hb.Font(entry.face);
      if (entry.wght) {
        const value = Math.min(entry.wght.max, Math.max(entry.wght.min, clamped));
        font.setVariations([new hb.Variation('wght', value)]);
      }
      entry.fonts.set(clamped, font);
    }
    return font;
  }

  function facesFor(locale: string): readonly FontFaceRule[] {
    let faces = facesByLocale.get(locale);
    if (!faces) {
      const stylesheet = stylesheetByLocale.get(locale);
      faces = [...pretendardFaces, ...(stylesheet ? parseFontFaces(repoRoot, stylesheet) : [])];
      facesByLocale.set(locale, faces);
    }
    return faces;
  }

  /**
   * Whether a face draws a whole cluster. The unicode-range is checked first,
   * so a face (a CJK shard, say) loads only when the text falls in its range,
   * as in the browser.
   */
  async function covers(rule: FontFaceRule, codePoints: readonly number[]): Promise<boolean> {
    if (!codePoints.every((cp) => isIgnorable(cp) || inRanges(rule.ranges, cp))) return false;
    const { cmap } = await loadFace(rule);
    return codePoints.every((cp) => isIgnorable(cp) || cmap.has(cp));
  }

  /** Best effort for an uncovered cluster: the first face that has its base character. */
  async function baseFace(
    ordered: readonly FontFaceRule[],
    base: number,
  ): Promise<FontFaceRule | null> {
    for (const rule of ordered) {
      if (!inRanges(rule.ranges, base)) continue;
      if ((await loadFace(rule)).cmap.has(base)) return rule;
    }
    return null;
  }

  async function measure(text: string, options: MeasureOptions): Promise<Measurement> {
    const { locale, htmlLang, fontSize, weight, letterSpacing = 0 } = options;
    const faces = facesFor(locale);
    const ordered: FontFaceRule[] = [];
    for (const family of stackFor(htmlLang)) {
      for (const face of faces) if (face.family === family) ordered.push(face);
    }

    const clusters = [...segmenter.segment(text)].map((segment) => segment.segment);
    const uncovered: string[] = [];
    const assigned: { cluster: string; face: FontFaceRule | null; script: string }[] = [];
    for (const cluster of clusters) {
      const codePoints = [...cluster].map((char) => char.codePointAt(0) ?? 0);
      let chosen: FontFaceRule | null = null;
      for (const face of ordered) {
        if (await covers(face, codePoints)) {
          chosen = face;
          break;
        }
      }
      if (!chosen) {
        uncovered.push(cluster);
        chosen = await baseFace(ordered, codePoints[0] ?? 0);
      }
      assigned.push({ cluster, face: chosen, script: scriptOf(cluster) });
    }

    // Common characters take the script of the run they sit in.
    let previous: string | null = null;
    for (const item of assigned) {
      if (item.script === 'Common') item.script = previous ?? 'Common';
      else previous = item.script;
    }
    let next: string | null = null;
    for (let index = assigned.length - 1; index >= 0; index -= 1) {
      const item = assigned[index]!;
      if (item.script === 'Common') item.script = next ?? 'Common';
      else next = item.script;
    }

    const rtlDocument = RTL_LANGUAGES.has(htmlLang.split('-')[0]!.toLowerCase());
    const levels = bidiLevels(
      assigned.map((item) => bidiClass(item.cluster)),
      rtlDocument,
    );
    const runs: { face: FontFaceRule | null; scriptKey: string; level: number; text: string }[] =
      [];
    assigned.forEach((item, index) => {
      const scriptKey = JAPANESE_SCRIPTS.has(item.script) ? 'Japanese' : item.script;
      const level = levels[index] ?? 0;
      const last = runs.at(-1);
      if (last && last.face === item.face && last.scriptKey === scriptKey && last.level === level) {
        last.text += item.cluster;
      } else {
        runs.push({ face: item.face, scriptKey, level, text: item.cluster });
      }
    });

    let width = 0;
    for (const run of runs) {
      if (!run.face) continue;
      const entry = await loadFace(run.face);
      const buffer = new hb.Buffer();
      buffer.addText(run.text);
      buffer.guessSegmentProperties();
      // The run's resolved script, as Chromium passes it: a run of common
      // characters takes its neighbours' script (an Arabic-script run kerns
      // its period and space, a Hebrew one does not).
      buffer.setScript(SCRIPT_TAGS[run.scriptKey] ?? 'Zyyy');
      buffer.setDirection(run.level % 2 ? hb.Direction.RTL : hb.Direction.LTR);
      buffer.setLanguage(htmlLang);
      hb.shape(fontAt(entry, run.face, weight), buffer);
      const advance = buffer
        .getGlyphPositions()
        .reduce((sum, position) => sum + position.xAdvance, 0);
      width += (advance * fontSize) / entry.upem;
    }
    width += letterSpacing * clusters.length;
    return { width, uncovered };
  }

  return { measure };
}
