import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parse as parseCss, type AtRule, type Node, type Root } from 'postcss';
import { beforeAll, describe, expect, it } from 'vitest';

import { APP_DICTIONARIES } from '../../i18n/catalogs.ts';
import { LANGUAGE_OPTIONS } from '../../i18n/locales.ts';
import { createLabelWidthHarness } from '../../i18n/__tests__/helpers/label-width-harness.ts';

/**
 * The demo role switch hides its inline icon whenever a label beside it would
 * have less than 4px to spare (owner decision 2026-10-29). Its four buttons
 * share the .demo-role-segmented container, so css/style.css hides the icon
 * up to one container width. This test works out that width from the CSS the
 * switch is built from and every locale's widest label at the selected
 * weight, and checks both ways: from the threshold on, every label has 4px
 * beside the icon, and 8px narrower some label would not, so the icon never
 * hides where it fits. chip-label-width.test.ts checks the labels in the
 * boxes this gives.
 */

const SPARE = 4;
const SELECTED_WEIGHT = 700;
const TWO_COLUMNS = '@media (min-width: 720px)';
const SMALL_PHONES = '@media (max-width: 420px)';

/** The at-rule a rule sits in, cascade layers aside. */
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
    rule.walkDecls((declaration) => {
      values[declaration.prop] = declaration.value;
    });
  });
  return values;
}

/** The container width up to which the switch hides its icon. */
function iconThreshold(root: Root): { readonly width: number; readonly condition: string } {
  const rules: AtRule[] = [];
  root.walkAtRules('container', (rule) => {
    if (/^demo-role-options\b/u.test(rule.params)) rules.push(rule);
  });
  expect(rules, '@container demo-role-options rules').toHaveLength(1);
  const params = rules[0]!.params;
  const width = /^demo-role-options \(max-width: ([\d.]+)px\)$/u.exec(params)?.[1];
  expect(width, params).toBeDefined();
  return { width: Number(width), condition: `@container ${params}` };
}

/** Four minmax(0, 1fr) columns with 8px gaps. */
const column = (container: number): number => (container - 3 * 8) / 4;

/** The label box beside the icon: 8px padding each side, the 19px icon and its gap. */
const besideIcon = (container: number, iconGap: number): number =>
  column(container) - 2 * 8 - 19 - iconGap;

/**
 * The two-column layout's container is the panel, --demo-panel-max:
 * clamp(340px, 40vw, 640px), so a container width gives the viewport, and
 * the viewport gives the icon gap clamp(5px, 0.8vw, 9px) and the font size
 * clamp(12.5px, 1vw, 14.5px).
 */
function twoColumnsAt(container: number): { readonly fontSize: number; readonly iconGap: number } {
  const vw = container / 0.4;
  return {
    fontSize: Math.min(14.5, Math.max(12.5, vw / 100)),
    iconGap: Math.min(9, Math.max(5, 0.008 * vw)),
  };
}

interface Label {
  readonly locale: string;
  readonly key: string;
  readonly text: string;
  readonly width: (fontSize: number) => number;
}

describe('demo role switch icon threshold', () => {
  const root = parseCss(readFileSync('css/style.css', 'utf8'));
  const markup = new JSDOM(readFileSync('index.html', 'utf8')).window.document;
  const keys = [...markup.querySelectorAll('.demo-role-segmented button > span[data-i18n]')].map(
    (label) => label.getAttribute('data-i18n') ?? '',
  );
  const dictionaries = APP_DICTIONARIES as Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  const labels: Label[] = [];

  beforeAll(async () => {
    const harness = createLabelWidthHarness({ repoRoot: process.cwd() });
    // Inter's optical size follows the font size, so widths do not scale
    // linearly: measure at every size the checks below use.
    const { width: from } = iconThreshold(root);
    const sizes = [13, twoColumnsAt(from).fontSize, twoColumnsAt(from - 8).fontSize];
    for (const option of LANGUAGE_OPTIONS) {
      for (const key of keys) {
        const text = dictionaries[option.code]?.[key] ?? '';
        const widths = new Map<number, number>();
        for (const fontSize of sizes) {
          const { width } = await harness.measure(text, {
            htmlLang: option.htmlLang,
            fontSize,
            weight: SELECTED_WEIGHT,
          });
          widths.set(fontSize, width);
        }
        labels.push({
          locale: option.code,
          key,
          text,
          width: (fontSize) => {
            const width = widths.get(fontSize);
            if (width === undefined) throw new Error(`${text} was not measured at ${fontSize}px`);
            return width;
          },
        });
      }
    }
  }, 120_000);

  it('builds the switch from the values the threshold is worked out from', () => {
    expect(keys).toEqual([
      'common.left',
      'demo.role_bass_short',
      'demo.role_center_short',
      'common.right',
    ]);
    expect(declarations(root, '.demo-role-segmented', null)).toMatchObject({
      container: 'demo-role-options / inline-size',
      'grid-template-columns': 'repeat(4, minmax(0, 1fr))',
      gap: '8px',
    });
    expect(declarations(root, '.demo-role-segmented button', null)).toMatchObject({
      border: 'none',
      gap: '6px',
      padding: '0 8px',
      'font-size': '13px',
    });
    expect(declarations(root, '.demo-role-segmented svg', null)).toMatchObject({
      width: '19px',
      flex: 'none',
    });
    expect(declarations(root, '.demo-role-segmented button', TWO_COLUMNS)).toMatchObject({
      gap: 'clamp(5px, 0.8vw, 9px)',
      'font-size': 'clamp(12.5px, 1vw, 14.5px)',
    });
    expect(declarations(root, '.demo-mobile-shell', TWO_COLUMNS)).toMatchObject({
      '--demo-panel-max': 'clamp(340px, 40vw, 640px)',
    });
    // Phones up to 420px wide drop the icon on their own.
    expect(declarations(root, '.demo-role-segmented svg', SMALL_PHONES)).toMatchObject({
      display: 'none',
    });
  });

  it('hides the icon and its gap up to the threshold', () => {
    const threshold = iconThreshold(root);
    expect(declarations(root, '.demo-role-segmented svg', threshold.condition)).toEqual({
      display: 'none',
    });
    expect(declarations(root, '.demo-role-segmented button', threshold.condition)).toEqual({
      gap: '0',
      'padding-inline': '4px',
    });
    expect(threshold.width).toBe(448);
  });

  it('leaves every label 4px beside the icon from the threshold on', () => {
    const { width: from } = iconThreshold(root);
    const twoColumns = twoColumnsAt(from);
    const layouts = [
      { name: 'phone', fontSize: 13, box: besideIcon(from, 6) },
      {
        name: 'two columns',
        fontSize: twoColumns.fontSize,
        box: besideIcon(from, twoColumns.iconGap),
      },
    ];
    const tooWide = layouts.flatMap((layout) =>
      labels
        .filter((label) => label.width(layout.fontSize) + SPARE > layout.box)
        .map(
          (label) =>
            `${label.locale} ${label.key} '${label.text}' ${label.width(layout.fontSize).toFixed(2)}px ` +
            `beside the icon in ${layout.box.toFixed(2)}px (${from}px container, ${layout.name})`,
        ),
    );
    expect(tooWide).toEqual([]);
    expect(labels).toHaveLength(42 * 4);
  });

  it('hides the icon only where some label would not fit beside it', () => {
    const { width: from } = iconThreshold(root);
    const narrower = from - 8;
    const twoColumns = twoColumnsAt(narrower);
    const phoneBox = besideIcon(narrower, 6);
    const twoColumnBox = besideIcon(narrower, twoColumns.iconGap);
    const crowded = labels.filter(
      (label) =>
        label.width(13) + SPARE > phoneBox ||
        label.width(twoColumns.fontSize) + SPARE > twoColumnBox,
    );
    expect(
      crowded.map((label) => `${label.locale} ${label.text}`),
      `every label fits beside the icon at ${narrower}px: the threshold can come down`,
    ).not.toEqual([]);
  });
});
