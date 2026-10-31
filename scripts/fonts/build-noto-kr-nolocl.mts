#!/usr/bin/env node
/**
 * Build the shipped Noto Sans KR shards: Google's v40 shards without the
 * Korean locl lookup.
 *
 * Every Google shard registers locl for the KOR language system of every
 * script, so with html lang="ko" a mark such as U+203C next to Hangul takes a
 * Korean form it does not take in any other UI. Removing that one lookup
 * makes the Korean and the English UI shape every character alike.
 *
 *   npm run generate:noto-kr -- --source <folder with Google's shards> [--record]
 *   npm run generate:noto-kr -- --check
 *
 * With --source, each downloaded shard must match its source digest in
 * fonts/font-sources.json. The harfbuzz subsetter (subset-font on harfbuzzjs)
 * re-encodes it with its whole cmap (keepAllGlyphs) and every GSUB and GPOS
 * feature except locl, which drops only the Korean forms that locl alone
 * produced. The copy is checked before it is written:
 * - its cmap equals the source's;
 * - every mapped character keeps the source's advance, extents and outline
 *   at wght 400 and 700;
 * - every mapped character shapes in the copy with the Korean and the
 *   English language exactly as the source shapes it with locl turned off:
 *   alone in Hangul and Latin runs, horizontally and vertically, with the
 *   optional halt, palt, vrt2, vhal and vpal features, and next to two other
 *   characters of the shard (four shards also registered locl for Latin text
 *   in every language; it no longer applies there either);
 * - no locl lookup is left, and no feature is added.
 * The copy must then equal the recorded shipped digest. --record writes new
 * shipped digests (a first build, or a deliberate toolchain change) together
 * with the tool versions.
 *
 * --check needs no download: it verifies the shipped files against the record
 * and that none of them carries locl.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as hb from 'harfbuzzjs';
import subsetFont from 'subset-font';

import {
  digestOf,
  fontCodePoints,
  fontLayoutFeatures,
  openFontBytes,
  readFontSources,
  verifyShippedFontFiles,
  writeFontSources,
  type RecordedFontFace,
} from './font-files.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL_PACKAGES = ['subset-font', 'harfbuzzjs', 'fontverter', 'wawoff2'] as const;
const WEIGHTS = [400, 700] as const;
const SHAPING_SCRIPTS = ['Hang', 'Latn'] as const;
const SHAPING_DIRECTIONS = [hb.Direction.LTR, hb.Direction.TTB] as const;

interface GlyphSnapshot {
  readonly advance: number;
  readonly extents: string;
  readonly outline: string;
}

class FontView {
  readonly #font: hb.Font;
  readonly #outlines = new Map<number, string>();

  constructor(face: hb.Face, weight?: number) {
    this.#font = new hb.Font(face);
    if (weight !== undefined) this.#font.setVariations([new hb.Variation('wght', weight)]);
  }

  outline(glyph: number): string {
    let outline = this.#outlines.get(glyph);
    if (outline === undefined) {
      outline = this.#font.glyphToPath(glyph);
      this.#outlines.set(glyph, outline);
    }
    return outline;
  }

  glyph(codePoint: number): GlyphSnapshot | null {
    const glyph = this.#font.nominalGlyph(codePoint);
    if (glyph === undefined) return null;
    return {
      advance: this.#font.glyphHAdvance(glyph),
      extents: JSON.stringify(this.#font.glyphExtents(glyph) ?? null),
      outline: this.outline(glyph),
    };
  }

  /** Shaped glyphs compared by outline and position, never by glyph id. */
  shape(
    text: string,
    script: string,
    direction: hb.Direction,
    language: string,
    features: readonly hb.Feature[] = [],
  ): string {
    const buffer = new hb.Buffer();
    buffer.addText(text);
    buffer.setDirection(direction);
    buffer.setScript(script);
    buffer.setLanguage(language);
    hb.shape(this.#font, buffer, [...features]);
    return JSON.stringify(
      buffer
        .getGlyphInfosAndPositions()
        .map(({ codepoint, xAdvance, yAdvance, xOffset, yOffset }) => [
          this.outline(codepoint),
          xAdvance,
          yAdvance,
          xOffset,
          yOffset,
        ]),
    );
  }
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** Features a browser applies only on request (font-feature-settings, text-spacing-trim). */
const OPTIONAL_FEATURES = [
  ['halt', hb.Direction.LTR],
  ['palt', hb.Direction.LTR],
  ['vrt2', hb.Direction.TTB],
  ['vhal', hb.Direction.TTB],
  ['vpal', hb.Direction.TTB],
] as const;

interface ShapingCase {
  readonly text: string;
  readonly script: string;
  readonly direction: hb.Direction;
  readonly features: readonly hb.Feature[];
}

/**
 * Every character alone in Hangul and Latin runs, both directions, with the
 * default features and with each optional feature, and next to two other
 * characters of the shard in a Hangul run.
 */
function shapingCases(codePoints: ReadonlySet<number>): ShapingCase[] {
  const sorted = [...codePoints].sort((left, right) => left - right);
  const partners = [sorted[0], sorted[Math.floor(sorted.length / 2)]].flatMap((codePoint) =>
    codePoint === undefined ? [] : [String.fromCodePoint(codePoint)],
  );
  const cases: ShapingCase[] = [];
  for (const codePoint of sorted) {
    const text = String.fromCodePoint(codePoint);
    for (const script of SHAPING_SCRIPTS) {
      for (const direction of SHAPING_DIRECTIONS)
        cases.push({ text, script, direction, features: [] });
    }
    for (const [tag, direction] of OPTIONAL_FEATURES) {
      cases.push({ text, script: 'Hang', direction, features: [new hb.Feature(tag, 1)] });
    }
    for (const partner of partners) {
      for (const pair of [`${text}${partner}`, `${partner}${text}`]) {
        cases.push({ text: pair, script: 'Hang', direction: hb.Direction.LTR, features: [] });
      }
    }
  }
  return cases;
}

/** Throws unless the copy draws and shapes every character like the source without Korean. */
async function compareCopy(
  file: string,
  source: Uint8Array,
  copy: Uint8Array,
): Promise<readonly string[]> {
  const sourceFace = await openFontBytes(source);
  const copyFace = await openFontBytes(copy);
  const codePoints = fontCodePoints(sourceFace);
  if (!sameSet(codePoints, fontCodePoints(copyFace))) throw new Error(`${file}: cmap changed`);

  for (const weight of WEIGHTS) {
    const before = new FontView(sourceFace, weight);
    const after = new FontView(copyFace, weight);
    for (const codePoint of codePoints) {
      if (JSON.stringify(before.glyph(codePoint)) !== JSON.stringify(after.glyph(codePoint))) {
        throw new Error(`${file}: U+${codePoint.toString(16)} changed at wght ${weight}`);
      }
    }
  }

  const before = new FontView(sourceFace);
  const after = new FontView(copyFace);
  const withoutLocl = new hb.Feature('locl', 0);
  for (const { text, script, direction, features } of shapingCases(codePoints)) {
    const expected = before.shape(text, script, direction, 'en', [withoutLocl, ...features]);
    for (const language of ['en', 'ko']) {
      if (after.shape(text, script, direction, language, features) !== expected) {
        const layout = direction === hb.Direction.TTB ? 'vertical' : 'horizontal';
        const requested = features.map((feature) => feature.tag).join(', ') || 'default features';
        const codes = [...text].map((character) => character.codePointAt(0)?.toString(16));
        throw new Error(
          `${file}: U+${codes.join(' U+')} shapes differently in a ${layout} ${script} run with ${language} (${requested})`,
        );
      }
    }
  }

  const sourceFeatures = fontLayoutFeatures(sourceFace);
  const copyFeatures = fontLayoutFeatures(copyFace);
  if (copyFeatures.has('locl')) throw new Error(`${file}: locl is still present`);
  const added = [...copyFeatures].filter((feature) => !sourceFeatures.has(feature));
  if (added.length) throw new Error(`${file}: features added: ${added.join(', ')}`);
  // The subsetter drops a feature whose lookups reached only glyphs that
  // locl alone produced; the shaping comparison above shows it was inert.
  return [...sourceFeatures].filter((feature) => feature !== 'locl' && !copyFeatures.has(feature));
}

async function buildCopy(source: Uint8Array): Promise<Buffer> {
  const features = [...fontLayoutFeatures(await openFontBytes(source))].filter(
    (feature) => feature !== 'locl',
  );
  return subsetFont(source, null, {
    keepAllGlyphs: true,
    keepFeatures: features,
    targetFormat: 'woff2',
  });
}

async function toolVersions(): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const name of TOOL_PACKAGES) {
    const manifest: unknown = JSON.parse(
      await readFile(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'),
    );
    const version =
      typeof manifest === 'object' && manifest !== null && 'version' in manifest
        ? manifest.version
        : undefined;
    if (typeof version !== 'string') throw new Error(`Cannot read the ${name} version`);
    versions[name] = version;
  }
  return versions;
}

async function build(sourceFolder: string, record: boolean): Promise<void> {
  const sources = await readFontSources(repoRoot);
  const family = sources.notoSansKr;
  const directory = path.join(repoRoot, family.directory);
  await mkdir(directory, { recursive: true });
  const faces: RecordedFontFace[] = [];
  const mismatches: string[] = [];
  for (const face of family.faces) {
    const source = await readFile(path.join(sourceFolder, face.file));
    const sourceDigest = digestOf(source);
    if (sourceDigest.sha256 !== face.source.sha256 || sourceDigest.bytes !== face.source.bytes) {
      throw new Error(`${face.file}: the download differs from its recorded source digest`);
    }
    const copy = await buildCopy(source);
    const dropped = await compareCopy(face.file, source, copy);
    const shipped = digestOf(copy);
    if (
      face.shipped &&
      !record &&
      (face.shipped.sha256 !== shipped.sha256 || face.shipped.bytes !== shipped.bytes)
    ) {
      mismatches.push(face.file);
      faces.push(face);
      continue;
    }
    await writeFile(path.join(directory, face.file), copy);
    faces.push({ ...face, shipped });
    console.log(
      `#${face.subset.padStart(3)} ${String(face.source.bytes).padStart(6)} B -> ${String(shipped.bytes).padStart(6)} B` +
        (dropped.length ? `  (inert features dropped: ${dropped.join(', ')})` : ''),
    );
  }
  if (mismatches.length) {
    throw new Error(
      `The rebuilt copies differ from their recorded shipped digests: ${mismatches.join(', ')}. ` +
        'The toolchain changed; check the copies and rerun with --record to accept them.',
    );
  }
  const changed = faces.some(
    (face, index) => face.shipped?.sha256 !== family.faces[index]?.shipped?.sha256,
  );
  if (record || changed) {
    await writeFontSources(repoRoot, {
      ...sources,
      tools: await toolVersions(),
      notoSansKr: { ...family, faces },
    });
  }
  const total = faces.reduce((sum, face) => sum + (face.shipped?.bytes ?? 0), 0);
  console.log(`Wrote ${faces.length} Noto Sans KR shards without locl (${total} B).`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      record: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
    },
  });
  if (values.check) {
    const failures = await verifyShippedFontFiles(repoRoot, undefined, ['notoSansKr']);
    if (failures.length) {
      console.error(
        `Noto Sans KR check failed:\n${failures.map((line) => `  - ${line}`).join('\n')}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('Noto Sans KR shards match their record and carry no locl.');
    return;
  }
  if (!values.source)
    throw new Error('Pass --source <folder with the downloaded shards> or --check');
  await build(path.resolve(values.source), values.record);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
