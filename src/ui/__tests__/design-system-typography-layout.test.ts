/**
 * The layout rules of the design system's Typography section
 * (public/editorial-design.css #typography): its blocks share one sample
 * column, so a sample, a face name and a leading sample start at the same
 * left edge at every width, and Scale, the one block without a closing
 * note, closes on the gap the section uses inside a block, so it reads with
 * Leading below it. The rendered edges are measured by
 * e2e/public-fonts/design-system-typography.lab.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const SHEET = 'public/editorial-design.css';
const PHONE = '(max-width: 720px)';

const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();

/** The declarations of the rules with exactly this selector, in or out of one media query. */
function declarations(selector: string, media: string | null): Map<string, string> {
  const found = new Map<string, string>();
  postcss.parse(readFileSync(resolve(SHEET), 'utf8')).walkRules((rule: Rule) => {
    if (normalize(rule.selector) !== selector) return;
    const parent = rule.parent;
    const query = parent?.type === 'atrule' ? normalize((parent as AtRule).params) : null;
    if (query !== media) return;
    rule.walkDecls((declaration) => {
      if (declaration.parent === rule) found.set(declaration.prop, normalize(declaration.value));
    });
  });
  return found;
}

/** The column gap a rule sets, from column-gap or the gap shorthand. */
function columnGap(rule: Map<string, string>): string | undefined {
  const gaps = rule.get('gap')?.split(' ');
  return rule.get('column-gap') ?? gaps?.[1] ?? gaps?.[0];
}

/**
 * The first grid track plus the column gap, where the second column
 * starts: the media query's rule over the rule outside it.
 */
function sampleColumn(selector: string, media: string | null): string {
  const base = declarations(selector, null);
  const rule = media === null ? base : declarations(selector, media);
  const columns = rule.get('grid-template-columns') ?? base.get('grid-template-columns');
  const [track] = (columns ?? '').split(' ');
  return `${track || '?'} + ${columnGap(rule) ?? columnGap(base) ?? '?'}`;
}

describe('the Typography section layout', () => {
  it('starts the Scale samples, the face names and the leading samples at one edge', () => {
    expect(sampleColumn('.spec', null)).toBe('140px + 20px');
    expect(sampleColumn('#typography .typo-face', null)).toBe('140px + 20px');
    expect(sampleColumn('#typography .typo-lead', null)).toBe('140px + 20px');
  });

  it('keeps the Scale samples and the face names on one edge on a phone', () => {
    // The widest face glyph, ก ع א क at 28px, is about 91px wide, so the
    // shared phone column is the Faces one.
    expect(sampleColumn('#typography .typo-face', PHONE)).toBe('96px + 16px');
    expect(sampleColumn('.spec', PHONE)).toBe(sampleColumn('#typography .typo-face', PHONE));
  });

  it('closes Scale on the in-block gap, as Han closes its glyph row', () => {
    // Han's glyph row: margin 12px 0 <bottom>.
    const hanMargin = declarations('#typography .typo-han-forms', null).get('margin') ?? '';
    const hanGap = /^\S+ \S+ (clamp\([^)]*\))$/u.exec(hanMargin)?.[1];
    expect(hanGap).toBe('clamp(56px, 7vw, 96px)');
    expect(declarations('#typography .typo-block.typo-scale', null).get('margin-bottom')).toBe(
      hanGap,
    );
  });

  it('keeps no rule for the retired display glyph', () => {
    const sheet = readFileSync(resolve(SHEET), 'utf8');
    expect(sheet).not.toMatch(/\.display-glyph\b/u);
    expect(readFileSync(resolve('public/designsystem/index.html'), 'utf8')).not.toMatch(
      /display-glyph/u,
    );
  });
});
