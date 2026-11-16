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
  /\((?:min|max)-width:\s*12(?:79(?:\.\d+)?|80)px\)|\(min-height:\s*720px\)|\(max-height:\s*(?:719|899)(?:\.\d+)?px\)/u;

// Layout bands carry no input features: whether the user can hover is one
// runtime flag (src/ui/hover-pointer.ts), not a media query.
const ALLOWED_PRELUDES = new Set([
  DESKTOP_LAYOUT_QUERY,
  NOT_DESKTOP_LAYOUT_QUERY,
  COMPACT_LAYOUT_QUERY,
  SHORT_DESKTOP_LAYOUT_QUERY,
]);

// The phone band has no shared string: its rules sit beside the two-column
// rules, which start at 720px.
const PHONE_FEATURE = /\(max-width:\s*719(?:\.\d+)?px\)/u;
const TWO_COLUMNS = '(min-width: 720px)';

function layoutPreludes(feature = LAYOUT_FEATURE): string[] {
  const preludes: string[] = [];
  for (const file of CSS_FILES) {
    parseCss(readFileSync(resolve(file), 'utf8')).walkAtRules('media', (rule) => {
      // Formatting may wrap a long query list across lines.
      const prelude = rule.params.replace(/\s+/gu, ' ');
      if (feature.test(prelude)) preludes.push(prelude);
    });
  }
  return preludes;
}

/** Evaluate a width/height-only media query list for one viewport size. */
function evaluate(query: string, width: number, height: number): boolean {
  return query.split(', ').some((branch) =>
    branch.split(' and ').every((feature) => {
      const match = /^\((min|max)-(width|height):\s*(\d+(?:\.\d+)?)px\)$/u.exec(feature);
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
    // Display scaling and browser zoom give fractional viewports: 1599 device
    // pixels at 125% are 1279.2px. The max sides stop at .98, so the fractions
    // here stay below it; the gap left above .98 is theoretical, as common
    // scales put no viewport inside it.
    for (const width of [
      360, 719, 719.2, 719.5, 720, 1024, 1279, 1279.2, 1279.33, 1279.5, 1280, 1440, 1920, 2560,
    ]) {
      for (const height of [
        320, 500, 539, 540, 620, 719, 719.2, 719.5, 720, 768, 800, 899, 899.2, 899.5, 900, 1440,
      ]) {
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

  it('leaves no width between the phone band and the two-column rules', () => {
    // Every width takes the phone rules or the two-column rules, never
    // neither, and every phone rule writes its band the same way.
    const phoneBands = new Set(
      layoutPreludes(PHONE_FEATURE).map((prelude) => PHONE_FEATURE.exec(prelude)![0]),
    );
    for (const phone of phoneBands) {
      for (const width of [719, 719.2, 719.5, 720]) {
        const bands = [phone, TWO_COLUMNS].filter((query) => evaluate(query, width, 900));
        expect(bands, `${phone} at ${width}px`).toHaveLength(1);
      }
    }
    expect([...phoneBands]).toEqual(['(max-width: 719.98px)']);
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
      /@media \(min-width: 1280px\) and \(min-height: 720px\) and \(max-height: 899\.98px\)\s*\{\s*body\s*\{[^}]*grid-template-areas:\s*'header tab-playlist tab-settings'\s*'tab-play tab-playlist tab-settings'\s*'tab-play tab-chat tab-settings';/u,
    );
  });
});
