// @vitest-environment node
/**
 * The demo tour's two-column text takes the sizes of the app's text in the
 * same role (owner decision 2026-11-04, from pictures at 1920 and 1024 px):
 * the step title the desktop start carousel title's, the step copy the
 * carousel description's and the track names the playlist track name's.
 *
 * The carousel sizes are custom properties on #setup-overlay (css/desktop.css),
 * outside the demo overlay, so the demo writes the same values out. This test
 * keeps the two equal: a change to the start carousel fails here until the
 * demo follows or the owner parts them. The phone demo keeps its own sizes.
 */
import { readFileSync } from 'node:fs';
import { parse as parseCss, type AtRule, type Node, type Root } from 'postcss';
import { describe, expect, it } from 'vitest';

const TWO_COLUMNS = '@media (min-width: 720px)';
const SMALL_PHONES = '@media (max-width: 420px)';
const DESKTOP = '@media (min-width: 1280px) and (min-height: 720px)';

/** The at-rule a rule sits in, cascade layers aside; null at the top. */
function conditionOf(node: Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== 'atrule') continue;
    const atRule = parent as AtRule;
    if (atRule.name !== 'layer') return `@${atRule.name} ${atRule.params}`;
  }
  return null;
}

/** The declarations of the rules that list `selector` under `condition`. */
function declarations(root: Root, selector: string, condition: string | null) {
  const values: Record<string, string> = {};
  root.walkRules((rule) => {
    const selectors = rule.selectors.map((entry) => entry.replace(/\s+/gu, ' ').trim());
    if (!selectors.includes(selector) || conditionOf(rule) !== condition) return;
    rule.each((child) => {
      if (child.type === 'decl') values[child.prop] = child.value.replace(/\s+/gu, ' ').trim();
    });
  });
  return values;
}

describe('demo tour text in the two-column layout', () => {
  const app = parseCss(readFileSync('css/style.css', 'utf8'));
  const desktop = parseCss(readFileSync('css/desktop.css', 'utf8'));
  const carousel = declarations(desktop, '#setup-overlay', DESKTOP);
  const twoColumnSize = (selector: string) => declarations(app, selector, TWO_COLUMNS)['font-size'];

  it('gives the step title the desktop start carousel title size', () => {
    expect(carousel['--setup-ob-title']).toBe('clamp(22px, 2.2vw, 28px)');
    expect(twoColumnSize('.demo-step-copy h2')).toBe(carousel['--setup-ob-title']);
  });

  it('gives the step copy the desktop start carousel description size', () => {
    expect(carousel['--setup-ob-desc']).toBe('clamp(13px, 1.1vw, 15px)');
    expect(twoColumnSize('.demo-step-copy p')).toBe(carousel['--setup-ob-desc']);
    expect(twoColumnSize('.demo-step-body')).toBe(carousel['--setup-ob-desc']);
  });

  it('gives the track names the playlist track name size', () => {
    const trackName = declarations(app, '.track-name', null)['font-size'];
    expect(trackName).toBe('15px');
    expect(twoColumnSize('.demo-track-row strong')).toBe(trackName);
  });

  it('keeps the phone demo sizes', () => {
    expect(declarations(app, '.demo-step-copy h2', null)['font-size']).toBe('22px');
    expect(declarations(app, '.demo-step-copy p', null)['font-size']).toBe('14px');
    expect(declarations(app, '.demo-step-body', null)['font-size']).toBe('14px');
    expect(declarations(app, '.demo-track-row strong', null)['font-size']).toBe('14px');
    expect(declarations(app, '.demo-step-copy h2', SMALL_PHONES)['font-size']).toBe('20px');
  });
});
