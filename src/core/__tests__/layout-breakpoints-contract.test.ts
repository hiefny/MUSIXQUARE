import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseCss } from 'postcss';
import { describe, expect, it } from 'vitest';
import {
  COMPACT_LAYOUT_QUERY,
  DESKTOP_LAYOUT_QUERY,
  isDesktopLayoutSize,
  NOT_DESKTOP_LAYOUT_QUERY,
  SHORT_DESKTOP_LAYOUT_QUERY,
} from '../layout-breakpoints.ts';

const CSS_FILES = ['css/style.css', 'css/desktop.css', 'css/playback-actions.css', 'css/rtl.css'];
const LAYOUT_FEATURE =
  /\((?:min|max)-width:\s*12(?:79|80)px\)|\(min-height:\s*720px\)|\(max-height:\s*(?:719|899)px\)/u;

/** Apply extra media features to every branch of a query list. */
function withFeatures(query: string, features: string): string {
  return query
    .split(', ')
    .map((branch) => `${branch} and ${features}`)
    .join(', ');
}

const ALLOWED_PRELUDES = new Set([
  DESKTOP_LAYOUT_QUERY,
  NOT_DESKTOP_LAYOUT_QUERY,
  COMPACT_LAYOUT_QUERY,
  SHORT_DESKTOP_LAYOUT_QUERY,
  withFeatures(NOT_DESKTOP_LAYOUT_QUERY, '(hover: none) and (pointer: coarse)'),
  // A portrait viewport is never at least 1280px wide and under 720px tall,
  // so these width-only portrait branches already agree with the bands.
  '(max-width: 1279px) and (max-height: 720px) and (orientation: portrait)',
  '(min-width: 720px) and (max-width: 1279px) and (orientation: portrait)',
]);

function layoutPreludes(): string[] {
  const preludes: string[] = [];
  for (const file of CSS_FILES) {
    parseCss(readFileSync(resolve(file), 'utf8')).walkAtRules('media', (rule) => {
      // Formatting may wrap a long query list across lines.
      const prelude = rule.params.replace(/\s+/gu, ' ');
      if (LAYOUT_FEATURE.test(prelude)) preludes.push(prelude);
    });
  }
  return preludes;
}

/** Evaluate a width/height-only media query list for one viewport size. */
function evaluate(query: string, width: number, height: number): boolean {
  return query.split(', ').some((branch) =>
    branch.split(' and ').every((feature) => {
      const match = /^\((min|max)-(width|height):\s*(\d+)px\)$/u.exec(feature);
      if (!match) throw new Error(`Unsupported media feature: ${feature}`);
      const value = match[2] === 'width' ? width : height;
      const limit = Number(match[3]);
      return match[1] === 'min' ? value >= limit : value <= limit;
    }),
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !/(?:^|[\\/])__tests__[\\/]/u.test(file))
    .map((file) => join(dir, file));
}

describe('layout breakpoint contract', () => {
  it('uses only the shared layout bands in every stylesheet', () => {
    const preludes = layoutPreludes();
    expect(preludes.filter((prelude) => !ALLOWED_PRELUDES.has(prelude))).toEqual([]);
    for (const query of [
      DESKTOP_LAYOUT_QUERY,
      NOT_DESKTOP_LAYOUT_QUERY,
      COMPACT_LAYOUT_QUERY,
      SHORT_DESKTOP_LAYOUT_QUERY,
    ]) {
      expect(preludes, query).toContain(query);
    }
  });

  it('keeps layout breakpoint literals out of runtime modules', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      if (file.replaceAll('\\', '/') === 'src/core/layout-breakpoints.ts') continue;
      const source = readFileSync(resolve(file), 'utf8');
      if (LAYOUT_FEATURE.test(source) || /[<>]=?\s*12(?:79|80)\b/u.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('partitions every viewport into one layout band', () => {
    for (const width of [360, 719, 720, 1024, 1279, 1280, 1440, 1920, 2560]) {
      for (const height of [320, 500, 539, 540, 620, 719, 720, 768, 800, 899, 900, 1440]) {
        const size = `${width}x${height}`;
        const desktop = evaluate(DESKTOP_LAYOUT_QUERY, width, height);
        expect(evaluate(NOT_DESKTOP_LAYOUT_QUERY, width, height), size).toBe(!desktop);
        expect(evaluate(COMPACT_LAYOUT_QUERY, width, height), size).toBe(width >= 720 && !desktop);
        expect(evaluate(SHORT_DESKTOP_LAYOUT_QUERY, width, height), size).toBe(
          desktop && height < 900,
        );
        expect(isDesktopLayoutSize(width, height), size).toBe(desktop);
      }
    }
  });

  it('forces the compact layout below 720px and narrows the header below 900px', () => {
    expect(evaluate(COMPACT_LAYOUT_QUERY, 1440, 700)).toBe(true);
    expect(evaluate(SHORT_DESKTOP_LAYOUT_QUERY, 1440, 800)).toBe(true);
    expect(evaluate(SHORT_DESKTOP_LAYOUT_QUERY, 1366, 768)).toBe(true);
    expect(evaluate(SHORT_DESKTOP_LAYOUT_QUERY, 1280, 720)).toBe(true);
    expect(evaluate(DESKTOP_LAYOUT_QUERY, 1440, 900)).toBe(true);
    expect(evaluate(SHORT_DESKTOP_LAYOUT_QUERY, 1440, 900)).toBe(false);
    expect(evaluate(COMPACT_LAYOUT_QUERY, 1024, 700)).toBe(true);

    const desktop = readFileSync(resolve('css/desktop.css'), 'utf8');
    expect(desktop).toMatch(
      /@media \(min-width: 1280px\) and \(min-height: 720px\) and \(max-height: 899px\)\s*\{\s*body\s*\{[^}]*grid-template-areas:\s*'header tab-playlist tab-settings'\s*'tab-play tab-playlist tab-settings'\s*'tab-play tab-chat tab-settings';/u,
    );
  });
});
