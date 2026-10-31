/**
 * Browser-free label width harness for the chip label guard
 * (chip-label-width.test.ts) and the demo role icon threshold
 * (demo-role-icon.test.ts).
 *
 * It shapes one line of text with HarfBuzz the way Chromium lays it out:
 * - The font stack is the body's --font-sans for the document language,
 *   direction and Han order, resolved from the app sheets by
 *   scripts/fonts/font-stacks.mts with every var() expanded. System fonts in
 *   a stack are skipped.
 * - The faces are every @font-face of the app's sheets
 *   (src/i18n/app-font-contract.ts): the app declares all of them in every UI.
 * - Every grapheme cluster takes the first face in stack order whose
 *   unicode-range and cmap cover it (per-glyph fallback). A cluster no web face
 *   covers would fall back to a system font, which this harness cannot
 *   reproduce, so it is reported in `uncovered`.
 * - Runs are split by face, by script (common characters take their
 *   neighbours' script) and by a simplified UAX #9 bidi level in right-to-left
 *   documents, then shaped with the explicit script, direction and document
 *   language, kerning on, the wght variation of the CSS weight clamped to the
 *   face's declared range, and, where the face has an opsz axis
 *   (font-optical-sizing: auto), opsz at the used size times the face's
 *   size-adjust, clamped to the axis, which is what Chromium feeds it.
 * - Advances scale by the face's size-adjust.
 *
 * The chip copy study (2026-10-29) checked the Pretendard-era harness against
 * Chromium on all 42 locales: 14,112 widths at 10 to 14px and weights 500 and
 * 700 agreed within 0.07px, and WebKit text widths within 0.03px.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import * as hb from 'harfbuzzjs';

import { decodeFontBytes, parseFontFaceRules } from '../../../../scripts/fonts/font-files.mts';
import { readFontStacks } from '../../../../scripts/fonts/font-stacks.mts';
import { APP_FONT_SHEETS } from '../../app-font-contract.ts';

interface FontFaceRule {
  readonly family: string;
  readonly file: string;
  readonly weightMin: number;
  readonly weightMax: number;
  /** size-adjust as a ratio, 1 when the face sets none. */
  readonly sizeAdjust: number;
  readonly ranges: readonly (readonly [number, number])[];
}

interface Axis {
  readonly min: number;
  readonly max: number;
}

interface LoadedFace {
  readonly face: hb.Face;
  readonly cmap: ReadonlySet<number>;
  readonly upem: number;
  readonly wght: Axis | null;
  readonly opsz: Axis | null;
  readonly fonts: Map<string, hb.Font>;
}

/** html[data-mxqr-han-order]: the Han order other UIs take from the browser's languages. */
export type HanOrder = 'ja' | 'zh-hans' | 'zh-hant';

export interface MeasureOptions {
  /** The document language, which picks the font stack and shaping language. */
  readonly htmlLang: string;
  readonly fontSize: number;
  readonly weight: number;
  readonly letterSpacing?: number;
  /** The startup Han order; absent means Korean first. */
  readonly hanOrder?: HanOrder;
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

function parseFontFaces(repoRoot: string, sheetPath: string): FontFaceRule[] {
  const cssPath = join(repoRoot, sheetPath);
  return parseFontFaceRules(readFileSync(cssPath, 'utf8')).map((rule) => {
    const weights = (rule.declarations.get('font-weight') ?? '400').split(/\s+/u).map(Number);
    const sizeAdjust = rule.declarations.get('size-adjust');
    return {
      family: rule.family,
      file: resolve(dirname(cssPath), rule.url),
      weightMin: weights[0] ?? 400,
      weightMax: weights[1] ?? weights[0] ?? 400,
      sizeAdjust: sizeAdjust ? Number.parseFloat(sizeAdjust) / 100 : 1,
      ranges: rule.unicodeRange ? parseRanges(rule.unicodeRange) : [[0, 0x10ffff]],
    };
  });
}

const inRanges = (ranges: FontFaceRule['ranges'], codePoint: number): boolean =>
  ranges.some(([from, to]) => codePoint >= from && codePoint <= to);

const isIgnorable = (codePoint: number): boolean =>
  (codePoint >= 0x200b && codePoint <= 0x200f) ||
  (codePoint >= 0x2060 && codePoint <= 0x206f) ||
  (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
  codePoint === 0xfeff;

const clamp = (value: number, axis: Axis): number => Math.min(axis.max, Math.max(axis.min, value));

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

export function createLabelWidthHarness({
  repoRoot,
}: {
  readonly repoRoot: string;
}): LabelWidthHarness {
  const faces = APP_FONT_SHEETS.flatMap(({ path }) => parseFontFaces(repoRoot, path));
  const fontStacks = readFontStacks(repoRoot);
  const orderedByStack = new Map<string, readonly FontFaceRule[]>();
  const loaded = new Map<string, Promise<LoadedFace>>();
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

  /** The faces in stack order for a document language, direction and Han order. */
  function orderedFaces(htmlLang: string, hanOrder: HanOrder | undefined): readonly FontFaceRule[] {
    const key = `${htmlLang}|${hanOrder ?? ''}`;
    let ordered = orderedByStack.get(key);
    if (!ordered) {
      const stack = fontStacks.fontSans({
        htmlLang,
        dir: RTL_LANGUAGES.has(htmlLang.split('-')[0]!.toLowerCase()) ? 'rtl' : 'ltr',
        attributes: hanOrder ? { 'data-mxqr-han-order': hanOrder } : {},
      });
      ordered = [...new Set(stack)].flatMap((family) =>
        faces.filter((face) => face.family === family),
      );
      orderedByStack.set(key, ordered);
    }
    return ordered;
  }

  function loadFace(rule: FontFaceRule): Promise<LoadedFace> {
    let pending = loaded.get(rule.file);
    if (!pending) {
      // decodeFontBytes runs one WOFF2 decode at a time; the decoder is not
      // reentrant.
      pending = decodeFontBytes(readFileSync(rule.file)).then((sfnt) => {
        const face = new hb.Face(new hb.Blob(sfnt), 0);
        const axes = face.getAxisInfos();
        const axis = (tag: string): Axis | null => {
          const info = axes[tag];
          return info ? { min: info.min, max: info.max } : null;
        };
        return {
          face,
          cmap: new Set(face.collectUnicodes()),
          upem: face.upem,
          wght: axis('wght'),
          opsz: axis('opsz'),
          fonts: new Map<string, hb.Font>(),
        };
      });
      loaded.set(rule.file, pending);
    }
    return pending;
  }

  function fontAt(entry: LoadedFace, rule: FontFaceRule, weight: number, size: number): hb.Font {
    const clampedWeight = Math.min(rule.weightMax, Math.max(rule.weightMin, weight));
    const opsz = entry.opsz ? clamp(size * rule.sizeAdjust, entry.opsz) : null;
    const key = `${clampedWeight}|${opsz ?? ''}`;
    let font = entry.fonts.get(key);
    if (!font) {
      font = new hb.Font(entry.face);
      const variations: hb.Variation[] = [];
      if (entry.wght) variations.push(new hb.Variation('wght', clamp(clampedWeight, entry.wght)));
      if (opsz !== null) variations.push(new hb.Variation('opsz', opsz));
      if (variations.length > 0) font.setVariations(variations);
      entry.fonts.set(key, font);
    }
    return font;
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
    const { htmlLang, fontSize, weight, letterSpacing = 0, hanOrder } = options;
    const ordered = orderedFaces(htmlLang, hanOrder);

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
      hb.shape(fontAt(entry, run.face, weight, fontSize), buffer);
      const advance = buffer
        .getGlyphPositions()
        .reduce((sum, position) => sum + position.xAdvance, 0);
      width += (advance * fontSize * run.face.sizeAdjust) / entry.upem;
    }
    width += letterSpacing * clusters.length;
    return { width, uncovered };
  }

  return { measure };
}
