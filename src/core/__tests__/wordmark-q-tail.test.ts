/**
 * The MUSIXQUARE wordmark's Q tail and R leg hang below its letters. The
 * letters fill y 12.8 to 35.3 of the glyph space; the Q's tail reaches y 38
 * and the R's leg y 36.4. A copy drawn in the letters' own box (viewBox
 * `43 12 214 24`, or the PRO wordmark's `43 12 170 24`) clips both unless its
 * svg keeps overflow visible, which every app wordmark does (`.logo-svg`, the
 * boot splash's `.boot-splash-logo`). The brand asset and the public pages draw
 * in `43 12 214 26` instead. Every copy in the repository takes one of the two
 * ways; an svg's default overflow is hidden.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const Q_TAIL_BOTTOM = 38;
// Every copy's Q is one path that starts at (147.2, 17.3).
const Q_PATH = String.raw`d=["']M147\.2`;
const SOURCE_FILE = /\.(?:html|svg|ts|tsx|mts)$/u;
const VISIBLE_OVERFLOW_CLASSES = new Set(['logo-svg', 'boot-splash-logo']);

function trackedSources(): string[] {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(
      (path) =>
        SOURCE_FILE.test(path) &&
        !path.startsWith('docs/') &&
        !/(?:^|\/)__tests__\//u.test(path) &&
        !/\.test\.tsx?$/u.test(path),
    );
}

function openingTag(source: string, at: number): string {
  return source.slice(at, source.indexOf('>', at) + 1).replace(/\s+/gu, ' ');
}

function enclosingContainer(source: string, index: number): string {
  const at = Math.max(source.lastIndexOf('<svg', index), source.lastIndexOf('<symbol', index));
  return openingTag(source, at);
}

function keepsTail(tag: string): boolean {
  const viewBox = tag
    .match(/viewBox=["']([^"']+)["']/u)?.[1]
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (viewBox?.length === 4 && viewBox[1]! + viewBox[3]! >= Q_TAIL_BOTTOM) return true;
  if (/\boverflow=["']visible["']/u.test(tag)) return true;
  if (/\bstyle=["'][^"']*overflow:\s*visible/u.test(tag)) return true;
  const classes = tag.match(/\bclass(?:Name)?=["']([^"']+)["']/u)?.[1]?.split(/\s+/u) ?? [];
  return classes.some((name) => VISIBLE_OVERFLOW_CLASSES.has(name));
}

/** Every svg that draws the wordmark's Q, directly or through <use>, as "path: tag". */
function wordmarkFrames(): string[] {
  const frames: string[] = [];
  for (const path of trackedSources()) {
    const source = readFileSync(path, 'utf8');
    if (!new RegExp(Q_PATH, 'u').test(source)) continue;
    const definitions = new Set<string>();
    for (const match of source.matchAll(new RegExp(Q_PATH, 'gu'))) {
      const container = enclosingContainer(source, match.index);
      if (/\bclass=["'][^"']*\bwordmark-definitions\b/u.test(container)) {
        const id = source.slice(0, match.index).match(/\bid=["']([\w-]+)["'][^<]*>[^]*$/u)?.[1];
        if (id) definitions.add(id);
        continue;
      }
      frames.push(`${path}: ${container}`);
    }
    for (const id of definitions) {
      for (const use of source.matchAll(new RegExp(`<use\\b[^>]*href=["']#${id}["']`, 'gu'))) {
        frames.push(`${path}: ${enclosingContainer(source, use.index)}`);
      }
    }
  }
  return frames;
}

describe('MUSIXQUARE wordmark Q tail', () => {
  it('finds the copies it guards', () => {
    const frames = wordmarkFrames();
    expect(frames.length).toBeGreaterThanOrEqual(15);
    expect(frames.some((frame) => frame.startsWith('index.html:'))).toBe(true);
    expect(
      frames.some((frame) => frame.startsWith('public/404.html: <svg class="cta-wordmark"')),
    ).toBe(true);
  });

  it('never clips the Q tail or the R leg', () => {
    expect(
      wordmarkFrames().filter((frame) => !keepsTail(frame.slice(frame.indexOf(': ') + 2))),
    ).toEqual([]);
  });

  it('keeps overflow visible on the app wordmark classes it trusts', () => {
    const appCss = readFileSync('css/style.css', 'utf8');
    expect(appCss).toMatch(/\n {2}\.logo-svg \{[^}]*\boverflow: visible;/u);
    const index = readFileSync('index.html', 'utf8');
    expect(index).toMatch(/\n {6}\.boot-splash-logo \{[^}]*\boverflow: visible;/u);
  });
});
