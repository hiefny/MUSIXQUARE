/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetState } from '../../core/state.ts';

// The selection check and minus are one angular family, like the app's X
// buttons and chevrons: butt ends and a mitred corner. Their end points sit
// past the old round-capped ones so the ink keeps the old box and centre.
const CHECK_PATH = 'M4.65 11.95l4.55 4.55L19.35 6.35';
const MINUS_PATH = 'M6.05 12h11.9';
const RETIRED_PATHS = ['M5 12.5l4.2 4.2L19 6.9', 'M7 12h10'];
const FAMILY_SELECTOR =
  /playlist-select-(?:minus|mark)|language-option-check|dialog-choice-check|playlist-slot-select-mark/u;

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
      expect(rule).toMatch(/stroke-width:\s*2\.4;/u);
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
