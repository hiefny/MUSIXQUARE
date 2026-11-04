// @vitest-environment node
/**
 * Two start-screen text rules that drew nothing, and the size property only
 * one of them read, are gone (owner decisions 2026-11-04: the fixed
 * half-pixel sizes, and removing --setup-guide-desc):
 * - .setup-inner-desc (11.5px; 12px inside .setup-unified-item, the guide
 *   description size in the desktop diagram area, and its entries in the
 *   Japanese line-breaking list). Its markup left index.html with the QR
 *   onboarding (2026-08-21), and nothing builds the class since.
 * - The 15.5px of the base .ob-desc rule. Every .ob-desc is a start carousel
 *   description inside an .ob-slide, whose rule in the same layer sets 14px,
 *   and from 720px the desktop diagram area's rule sets --setup-ob-desc, so
 *   the base size never applied. The rest of the base rule stays.
 * - The guide description size --setup-guide-desc (12px from 720px, and
 *   clamp(14px, 1.3vw, 18px) in the desktop layout), which only the
 *   .setup-inner-desc rule read.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { parse as parseCss, type AtRule, type Node, type Root } from 'postcss';
import { describe, expect, it } from 'vitest';

// css/app.css imports these four files; together they are the app stylesheet.
const SHEETS = ['css/style.css', 'css/desktop.css', 'css/rtl.css', 'css/playback-actions.css'];
const RETIRED = /\.setup-inner-desc(?![\w-])/u;

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

/** The cascade layer a rule sits in. */
function layerOf(node: Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && (parent as AtRule).name === 'layer') {
      return (parent as AtRule).params;
    }
  }
  return null;
}

/** The rules whose selector is exactly `selector`, with their layer, condition and declarations. */
function rulesFor(root: Root, selector: string) {
  const found: {
    layer: string | null;
    condition: string | null;
    values: Record<string, string>;
  }[] = [];
  root.walkRules((rule) => {
    if (rule.selector.replace(/\s+/gu, ' ').trim() !== selector) return;
    const values: Record<string, string> = {};
    rule.each((child) => {
      if (child.type === 'decl') values[child.prop] = child.value;
    });
    found.push({ layer: layerOf(rule), condition: conditionOf(rule), values });
  });
  return found;
}

/** Production sources under a folder, tests left out. */
function sources(folder: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') files.push(...sources(path));
    } else if (/\.(?:ts|tsx|html|json)$/u.test(name) && !/\.test\.ts$/u.test(name)) {
      files.push(path);
    }
  }
  return files;
}

describe('start screen text rules that drew nothing', () => {
  const app = parseCss(read('css/style.css'));

  it('keeps no rule or selector for .setup-inner-desc', () => {
    const selectors: string[] = [];
    for (const path of SHEETS) {
      parseCss(read(path)).walkRules((rule) => {
        for (const selector of rule.selectors) {
          if (RETIRED.test(selector)) selectors.push(`${path}: ${selector.replace(/\s+/gu, ' ')}`);
        }
      });
    }
    expect(selectors).toEqual([]);
  });

  it('has no markup or source that gives an element the class', () => {
    expect(read('index.html')).not.toContain('inner-desc');
    const carriers = sources(resolve('src')).filter((path) =>
      readFileSync(path, 'utf8').includes('inner-desc'),
    );
    expect(carriers).toEqual([]);
  });

  it('keeps no --setup-guide-desc, which only the .setup-inner-desc rule read', () => {
    const found: string[] = [];
    for (const path of SHEETS) {
      parseCss(read(path)).walkDecls((declaration) => {
        if (`${declaration.prop}:${declaration.value}`.includes('--setup-guide-desc')) {
          found.push(`${path}: ${declaration.prop}: ${declaration.value}`);
        }
      });
    }
    expect(found).toEqual([]);
    expect(read('index.html')).not.toContain('--setup-guide-desc');
    const carriers = sources(resolve('src')).filter((path) =>
      readFileSync(path, 'utf8').includes('--setup-guide-desc'),
    );
    expect(carriers).toEqual([]);
  });

  it('keeps the base .ob-desc rule without its size', () => {
    expect(rulesFor(app, '.ob-desc')).toEqual([
      {
        layer: 'base',
        condition: null,
        values: {
          color: 'var(--text-sub)',
          'line-height': '1.6',
          'word-break': 'keep-all',
          padding: '0 16px',
        },
      },
    ]);
  });

  it('sizes every carousel description in its slide', () => {
    const markup = new JSDOM(read('index.html')).window.document;
    const descriptions = [...markup.querySelectorAll('.ob-desc')];
    expect(descriptions).toHaveLength(4);
    expect(descriptions.every((element) => element.closest('.ob-slide'))).toBe(true);
    const carriers = sources(resolve('src')).filter((path) =>
      readFileSync(path, 'utf8').includes('ob-desc'),
    );
    expect(carriers).toEqual([]);

    // The slide rule shares the base rule's layer and outranks it, and the
    // desktop diagram area's rule sits in a later layer.
    expect(rulesFor(app, '.ob-slide .ob-desc')).toEqual([
      expect.objectContaining({
        layer: 'base',
        condition: null,
        values: expect.objectContaining({ 'font-size': '14px' }),
      }),
    ]);
    expect(rulesFor(app, '.desktop-diagram-area .ob-slide .ob-desc')).toEqual([
      expect.objectContaining({
        layer: 'responsive',
        condition: '@media (min-width: 720px)',
        values: expect.objectContaining({ 'font-size': 'var(--setup-ob-desc)' }),
      }),
    ]);
  });
});
