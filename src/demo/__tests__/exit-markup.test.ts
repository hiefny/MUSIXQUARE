/**
 * @vitest-environment jsdom
 *
 * The tour's visible exits (owner policy 2026-10-28): a persistent exit at
 * the top start of the header on every step, and the step-4 pair with its
 * exit on the left.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Node } from 'postcss';
import { describe, expect, it } from 'vitest';

const markup = new DOMParser().parseFromString(
  readFileSync(resolve('index.html'), 'utf8'),
  'text/html',
);
const stylesheet = parseCss(readFileSync(resolve('css/style.css'), 'utf8'));

/** Whether a conditional at-rule wraps `node`; cascade layers apply everywhere. */
function isConditional(node: Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && (parent as AtRule).name !== 'layer') return true;
  }
  return false;
}

/** Values of `property` in unconditional rules that list `selector` itself. */
function declared(selector: string, property: string): string[] {
  const values: string[] = [];
  stylesheet.walkRules((rule) => {
    if (!rule.selectors.includes(selector) || isConditional(rule)) return;
    rule.each((node) => {
      if (node.type === 'decl' && node.prop === property) values.push(node.value);
    });
  });
  return values;
}

describe('demo tour exits', () => {
  it('puts a persistent exit first in the header, outside the step panels', () => {
    const header = markup.querySelector('#demo-overlay .demo-track-header')!;
    const exit = header.firstElementChild as HTMLButtonElement | null;
    expect(exit?.id).toBe('btn-demo-exit');
    expect(exit?.tagName).toBe('BUTTON');
    expect(exit?.type).toBe('button');
    expect(exit?.closest('[data-demo-panel]')).toBeNull();
    // An icon button named by the existing Exit Tour label.
    expect(exit?.getAttribute('data-i18n-aria-label')).toBe('demo.exit');
    expect(exit?.getAttribute('aria-label')).toBe('Exit Tour');
    const stepFourExit = markup.querySelector('[data-demo-panel="4"] [data-demo-exit]');
    expect(exit?.querySelector('svg path')?.getAttribute('d')).toBe(
      stepFourExit?.querySelector('svg path')?.getAttribute('d'),
    );
    expect(exit?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('lays the header out as exit, settings, then the track copy', () => {
    expect(declared('.demo-track-header', 'grid-template-columns')).toEqual([
      '44px 44px minmax(0, 1fr)',
    ]);
    expect(declared('.demo-exit-corner', 'grid-column')).toEqual(['1']);
    expect(declared('.demo-controls-pill', 'grid-column')).toEqual(['2 / -1']);
    expect(declared('.demo-track-copy', 'grid-column')).toEqual(['3']);
    // The open settings pill slides over the exit's place (44px plus the
    // 12px gap) with its own back arrow, keeping its full width; the exit
    // steps aside until the pill closes.
    expect(declared('.demo-controls-expanded .demo-controls-pill', 'margin-inline-start')).toEqual([
      '-56px',
    ]);
    expect(declared('.demo-controls-expanded .demo-exit-corner', 'visibility')).toEqual(['hidden']);
  });

  it('puts Exit Tour on the left of Track info on the last step', () => {
    const actions = markup.querySelector('[data-demo-panel="4"] .demo-large-actions')!;
    const buttons = Array.from(actions.querySelectorAll(':scope > button'));
    expect(buttons.map((button) => button.hasAttribute('data-demo-exit'))).toEqual([true, false]);
    expect(buttons[1]?.hasAttribute('data-demo-info')).toBe(true);
  });
});
