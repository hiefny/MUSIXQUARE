// @vitest-environment node
/**
 * The join order beside a chat sender's name (' #1') is 9px (owner decision
 * 2026-11-04). It was 0.8em of the 11px sender line, a fixed 8.8px. It keeps
 * its half opacity and its 2px from the name, and no other rule sizes it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Node, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// css/app.css imports these four files; together they are the app stylesheet.
const SHEETS = ['css/style.css', 'css/desktop.css', 'css/rtl.css', 'css/playback-actions.css'];

const read = (path: string): string => readFileSync(resolve(path), 'utf8');

/** The at-rule a rule sits in, cascade layers aside; null at the top. */
function conditionOf(node: Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== 'atrule') continue;
    const atRule = parent as AtRule;
    if (atRule.name !== 'layer') return `@${atRule.name} ${atRule.params}`;
  }
  return null;
}

describe('chat join order', () => {
  it('is 9px at half opacity, 2px from the 11px sender name', () => {
    const rules: Record<string, Record<string, string>> = {};
    parseCss(read('css/style.css')).walkRules((rule) => {
      if (conditionOf(rule) !== null) return;
      if (rule.selector !== '.chat-join-order' && rule.selector !== '.chat-sender') return;
      const values = (rules[rule.selector] ??= {});
      rule.each((child) => {
        if (child.type === 'decl') values[child.prop] = child.value;
      });
    });
    expect(rules['.chat-join-order']).toEqual({
      'font-size': '9px',
      opacity: '0.5',
      'margin-inline-start': '2px',
    });
    expect(rules['.chat-sender']?.['font-size']).toBe('11px');
  });

  it('takes its size from that one rule', () => {
    const sizes: string[] = [];
    for (const path of SHEETS) {
      parseCss(read(path)).walkDecls((declaration) => {
        if (declaration.prop !== 'font-size' && declaration.prop !== 'font') return;
        if (declaration.parent?.type !== 'rule') return;
        const { selector } = declaration.parent as Rule;
        if (!/\.chat-join-order(?![\w-])/u.test(selector)) return;
        sizes.push(`${path} ${selector} ${declaration.value}`);
      });
    }
    expect(sizes).toEqual(['css/style.css .chat-join-order 9px']);
  });
});
