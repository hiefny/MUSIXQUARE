/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCss, type Root, type Rule } from 'postcss';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetState } from '../../core/state.ts';

// The selection check and minus are one angular family, like the app's X
// buttons and chevrons: butt ends and a mitred corner. The check's end points
// sit past the old round-capped ones so its ink keeps the old box and centre.
// The minus's butt-ended path is its ink: 10 of 24 units, about 9.2px at
// 22px, like the old 16px remove X (UI audit item 9, 2026-10-27).
const CHECK_PATH = 'M4.65 11.95l4.55 4.55L19.35 6.35';
const MINUS_PATH = 'M7 12h10';
// The first round check, and the 9.0.5 minus that kept the round minus's
// 10.9px ink.
const RETIRED_PATHS = ['M5 12.5l4.2 4.2L19 6.9', 'M6.05 12h11.9'];
const FAMILY_SELECTOR =
  /playlist-select-(?:minus|mark)|language-option-check|dialog-choice-check|playlist-slot-select-mark/u;
// The row's line icons (both chevrons and the minus) share one weight; the
// check is heavier on purpose, as the selected mark (UI audit item 8).
const LINE_ICON_STROKE = '1.8';
const CHECK_STROKE_WIDTH = '2.4';
const STROKE_TARGETS = {
  chevron: /(?:^|[\s>+~])\.expand-toggle(?![\w-])[^\s>+~]*\s+svg$/u,
  deviceChevron: /(?:^|[\s>+~])\.device-expand-toggle(?![\w-])[^\s>+~]*\s+svg$/u,
  minus: /\.playlist-select-minus(?![\w-])[^\s>+~]*$/u,
  check: /\.playlist-select-mark(?![\w-])[^\s>+~]*$/u,
} as const;

let appSource: string;
let appStylesheet: string;
let designStylesheet: string;

function rulesMatching(stylesheet: string, selector: RegExp): string[] {
  const rules: string[] = [];
  for (const match of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = (match[1] ?? '').replace(/\/\*[\s\S]*?\*\//gu, '');
    if (selector.test(selectors)) rules.push(match[2] ?? '');
  }
  return rules;
}

/** Every rule that gives the target a stroke width, with the width. */
function strokeWidthRules(root: Root, target: RegExp): { rule: Rule; value: string }[] {
  const found: { rule: Rule; value: string }[] = [];
  root.walkDecls('stroke-width', (declaration) => {
    const rule = declaration.parent;
    if (rule?.type !== 'rule') return;
    if ((rule as Rule).selectors.some((selector) => target.test(selector.trim()))) {
      found.push({ rule: rule as Rule, value: declaration.value });
    }
  });
  return found;
}

function strokeRule(stylesheet: string): string {
  const rule = stylesheet.match(
    /(?:^|\n)\s*\.playlist-select-minus,\s*\.playlist-select-mark\s*\{([^}]*)\}/u,
  )?.[1];
  expect(rule, 'shared minus/check stroke rule').toBeTruthy();
  return rule ?? '';
}

function expectAngularStandaloneCheck(path: Element | null | undefined): void {
  expect(path, 'check path').toBeTruthy();
  expect(path?.getAttribute('d')).toBe(CHECK_PATH);
  expect(path?.getAttribute('fill')).toBe('none');
  expect(path?.getAttribute('stroke')).toBe('currentColor');
  expect(path?.getAttribute('stroke-width')).toBe('2.4');
  expect(path?.getAttribute('stroke-linecap')).toBe('butt');
  expect(path?.getAttribute('stroke-linejoin')).toBe('miter');
}

beforeAll(() => {
  appSource = readFileSync(resolve('index.html'), 'utf8');
  appStylesheet = readFileSync(resolve('css/style.css'), 'utf8');
  designStylesheet = readFileSync(resolve('public/editorial-design.css'), 'utf8');
});

beforeEach(() => {
  resetState();
  const parsed = new DOMParser().parseFromString(appSource, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
});

describe('selection check and minus', () => {
  it('give the minus/check toggle butt ends and a mitred corner in every stylesheet', () => {
    for (const stylesheet of [appStylesheet, designStylesheet]) {
      const rule = strokeRule(stylesheet);
      expect(rule).toMatch(/stroke-linecap:\s*butt;/u);
      expect(rule).toMatch(/stroke-linejoin:\s*miter;/u);
      // No later or more specific rule puts a round end back on the family.
      for (const declarations of rulesMatching(stylesheet, FAMILY_SELECTOR)) {
        expect(declarations).not.toMatch(/stroke-line(?:cap|join):\s*round/u);
      }
    }
    // The app draws the toggle from one rule; the move dialog keeps no copy.
    expect(
      rulesMatching(appStylesheet, FAMILY_SELECTOR).filter((rule) =>
        /stroke-line(?:cap|join)/u.test(rule),
      ),
    ).toHaveLength(1);
  });

  it("gives the minus the chevrons' line weight from one rule and keeps the check heavier", () => {
    for (const [file, stylesheet] of [
      ['css/style.css', appStylesheet],
      ['public/editorial-design.css', designStylesheet],
    ] as const) {
      const root = parseCss(stylesheet);
      const minus = strokeWidthRules(root, STROKE_TARGETS.minus);
      const chevron = strokeWidthRules(root, STROKE_TARGETS.chevron);
      const deviceChevron = strokeWidthRules(root, STROKE_TARGETS.deviceChevron);
      const check = strokeWidthRules(root, STROKE_TARGETS.check);
      // One rule owns the line weight: no family default, override or copy
      // gives the minus or a chevron another width.
      expect(minus, `${file} minus`).toHaveLength(1);
      expect(minus[0]?.value, `${file} minus`).toBe(LINE_ICON_STROKE);
      expect(
        chevron.map(({ rule }) => rule),
        `${file} chevron`,
      ).toEqual([minus[0]?.rule]);
      expect(
        deviceChevron.map(({ rule }) => rule),
        `${file} device chevron`,
      ).toEqual([minus[0]?.rule]);
      // The check, the selected mark, keeps its heavier 2.4 (2.2px at 22px),
      // the same width the standalone check carries.
      expect(check, `${file} check`).toHaveLength(1);
      expect(check[0]?.value, `${file} check`).toBe(CHECK_STROKE_WIDTH);
    }
  });

  it('draws the minus as its own ink, shorter than the chevron and centred', () => {
    const shared = readFileSync(resolve('src/ui/selection-mark.ts'), 'utf8');
    const path = /const MINUS_PATH = '([^']+)';/u.exec(shared)?.[1] ?? '';
    const minus = /^M(?<x>[\d.]+) (?<y>[\d.]+)h(?<length>[\d.]+)$/u.exec(path)?.groups;
    expect(minus, path).toBeTruthy();
    const x = Number(minus?.x);
    const length = Number(minus?.length);
    // Butt ends add no ink past the path: 10 of 24 units is about 9.2px at
    // 22px. The chevron m6.5 9 5.5 5.5L17.5 9 spans 11 units plus its ends.
    expect(length).toBe(10);
    expect((length * 22) / 24).toBeCloseTo(9.17, 2);
    expect(x + length / 2).toBe(12);
    expect(Number(minus?.y)).toBe(12);
  });

  it('draws the playlist switcher check and the move dialog toggle from the shared paths', async () => {
    const { openPlaylistSlotsDialog, openPlaylistTransferDialog } =
      await import('../playlist-slots-dialog.ts');

    openPlaylistSlotsDialog();
    const switcher = document.querySelector('#playlist-slots-list .playlist-slot-option.active');
    expectAngularStandaloneCheck(switcher?.querySelector('.language-option-check svg path'));

    openPlaylistTransferDialog(['00000000-0000-4000-8000-000000000001'], () => {});
    const mark = document.querySelector('#playlist-transfer-list .playlist-slot-select-mark svg');
    expect(mark?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(mark?.querySelector('path.playlist-select-minus')?.getAttribute('d')).toBe(MINUS_PATH);
    expect(mark?.querySelector('path.playlist-select-mark')?.getAttribute('d')).toBe(CHECK_PATH);
    // The toggle takes its stroke from the shared stylesheet rule only.
    for (const path of mark?.querySelectorAll('path') ?? []) {
      expect(path.hasAttribute('stroke-linecap')).toBe(false);
      expect(path.hasAttribute('stroke-linejoin')).toBe(false);
    }
  });

  it('leaves no source drawing its own or a retired round mark', () => {
    const sources = [
      'src/ui/settings.ts',
      'src/ui/dialog.ts',
      'src/ui/playlist-view.ts',
      'src/ui/playlist-slots-dialog.ts',
    ].map((file) => [file, readFileSync(resolve(file), 'utf8')] as const);
    for (const [file, source] of sources) {
      expect(source, file).not.toContain(CHECK_PATH);
      expect(source, file).not.toContain(MINUS_PATH);
      for (const retired of RETIRED_PATHS) expect(source, file).not.toContain(retired);
    }
    const shared = readFileSync(resolve('src/ui/selection-mark.ts'), 'utf8');
    expect(shared).toContain(`'${CHECK_PATH}'`);
    expect(shared).toContain(`'${MINUS_PATH}'`);
    expect(shared).not.toMatch(/['"]round['"]/u);

    const designPage = readFileSync(resolve('public/designsystem/index.html'), 'utf8');
    for (const retired of RETIRED_PATHS) expect(designPage).not.toContain(retired);
  });
});
