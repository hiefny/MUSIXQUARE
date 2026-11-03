// @vitest-environment node
/**
 * Every number the design system's Typography section prints, and every
 * number its drawings are built from, comes from the app's own record: the
 * line box and the face sizes from src/i18n/font-metrics.ts, the subsets from
 * fonts/app-faces.json and fonts/hangul-faces.json, Inter's version and axes
 * from fonts/font-sources.json, the device-font gap from
 * scripts/fonts/uncovered-code-points.txt, the script faces from
 * src/i18n/app-font-contract.ts, and the sizes, leading, tracking and weights
 * from the app's stylesheets. A change to any of them fails here until the
 * section says the same.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import {
  isHangul,
  parseFontFaceRules,
  parseUnicodeRange,
} from '../../../scripts/fonts/font-files.mts';
import { APP_FONT_SHEETS } from '../../i18n/app-font-contract.ts';
import { CJK_FACE_METRICS, HANGUL_LINE_BOX, INTER_FACE_METRICS } from '../../i18n/font-metrics.ts';

const read = (path: string): string => readFileSync(resolve(path), 'utf8');
const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const document = new JSDOM(read('public/designsystem/index.html')).window.document;
const section = document.querySelector<HTMLElement>('#typography');

const text = (element: Element | null | undefined): string => normalize(element?.textContent ?? '');

/** The section's text, whitespace collapsed (CSS-generated text excluded). */
const sectionText = text(section);

/** The block under the h3 that names it. */
function block(title: string): HTMLElement {
  const heading = [...(section?.querySelectorAll('.typo-block > h3') ?? [])].find(
    (candidate) => text(candidate) === title,
  );
  const found = heading?.parentElement;
  if (!found) throw new Error(`No ${title} block in the Typography section`);
  return found;
}

/** The declarations of the rules with exactly this selector, in source order. */
function declarations(path: string, selector: string): Map<string, string> {
  const found = new Map<string, string>();
  postcss.parse(read(path)).walkRules((rule: Rule) => {
    if (normalize(rule.selector) !== selector) return;
    rule.walkDecls((declaration) => {
      if (declaration.parent === rule) found.set(declaration.prop, normalize(declaration.value));
    });
  });
  return found;
}

const SECTION_SHEET = 'public/editorial-design.css';
const sectionRule = (selector: string) => declarations(SECTION_SHEET, `#typography ${selector}`);
const app = (selector: string) => declarations('css/style.css', selector);
const box = HANGUL_LINE_BOX;

/** The line box of `line-height: normal` at a size, as the browser rounds ascent and descent. */
function normalLine(size: number): number {
  return (
    Math.round((size * box.ascender) / box.unitsPerEm) +
    Math.round((size * box.descender) / box.unitsPerEm)
  );
}

/** A px value as the section prints it: at most two decimals, no trailing zero. */
const px = (value: number): string => `${Number(value.toFixed(2))} px`;

interface InterSource {
  readonly inter: { readonly version: string; readonly sourceCss: string };
}

const inter = (JSON.parse(read('fonts/font-sources.json')) as InterSource).inter;
const [, OPSZ_MIN, OPSZ_MAX] = /opsz,wght@(\d+)\.\.(\d+),/u.exec(inter.sourceCss) ?? [];

describe('the Typography section numbers', () => {
  it('has every block', () => {
    expect(section).not.toBeNull();
    expect([...(section?.querySelectorAll('.typo-block > h3') ?? [])].map(text)).toEqual([
      'Scripts',
      'Faces',
      'Han',
      'Line box',
      'Tracking',
      'Scale',
      'Leading',
      'Weights',
    ]);
  });

  it('prints the shared line box and draws its rules from it', () => {
    expect(box.lineGap).toBe(0);
    const lineBox = block('Line box');
    expect(lineBox.querySelector('.typo-box')?.getAttribute('aria-label')).toBe(
      `Ag, 한, 漢 and あ on one line box: ascent ${box.ascender}, baseline, descent ${box.descender}, of ${box.unitsPerEm} units`,
    );
    expect([...lineBox.querySelectorAll('.typo-box-rule .typo-label')].map(text)).toEqual([
      `Ascent ${box.ascender}`,
      'Baseline',
      `Descent ${box.descender}`,
    ]);
    expect(sectionText).toContain(
      `${box.ascender} units above the baseline and ${box.descender} below, of ${box.unitsPerEm}, with no line gap`,
    );
    expect(sectionRule('.typo-box-rule.is-baseline').get('top')).toBe(
      `calc(1em * ${box.ascender} / ${box.unitsPerEm})`,
    );
    expect(sectionRule('.typo-box-rule.is-descent').get('top')).toBe(
      `calc(1em * ${box.ascender + box.descender} / ${box.unitsPerEm})`,
    );
    expect(sectionRule('.typo-optical-ghost::after').get('top')).toBe(
      `calc(1em * ${box.ascender} / ${box.unitsPerEm} + 0.08em)`,
    );
  });

  it("prints the faces' sizes and the normal line height", () => {
    expect(sectionText).toContain(`Inter is scaled to ${INTER_FACE_METRICS.sizeAdjust}%`);
    expect(sectionText).toContain(`Noto CJK to ${CJK_FACE_METRICS.sizeAdjust}%`);
    const normal = ((box.ascender + box.descender) / box.unitsPerEm).toFixed(3);
    expect(sectionText).toContain(`line-height: normal is ${normal} em`);
    const measured = [...block('Line box').querySelectorAll('.typo-measure > div')].map((row) => ({
      type: text(row.querySelector('dt')),
      line: text(row.querySelector('dd')),
    }));
    expect(measured).toEqual(
      [13, 14.5, 15, 28].map((size) => ({
        type: `${size} px type`,
        line: `${normalLine(size)} px line`,
      })),
    );
  });

  it('prints the subsets, versions and axes the font records hold', () => {
    const faces = [...block('Faces').querySelectorAll('.typo-face')].map((row) => ({
      name: text(row.querySelector('.typo-face-name')),
      use: text(row.querySelector('.typo-face-use')),
    }));
    expect(faces).toHaveLength(4);

    const appFaces = JSON.parse(read('fonts/app-faces.json')) as {
      families: { family: string; faces: unknown[] }[];
    };
    const interSubsets = appFaces.families.find(({ family }) => family === 'Inter')?.faces.length;
    // The copy spells the count out.
    expect(interSubsets).toBe(7);
    expect(faces[0]).toEqual({
      name: `Inter ${inter.version.split('.')[0]}`,
      use: `Latin, Cyrillic, Greek, Vietnamese and digits. Seven subsets, with an optical size axis from ${OPSZ_MIN} to ${OPSZ_MAX}.`,
    });

    const hangul = JSON.parse(read('fonts/hangul-faces.json')) as {
      source: { version: string };
      faces: { unicodeRange: string }[];
    };
    expect(faces[1]?.use).toBe(
      `Hangul. Pretendard ${hangul.source.version.split(' ')[0]}, cut into ${hangul.faces.length} subsets and renamed, as its license requires.`,
    );

    // The Hangul Noto Sans KR declares that MUSIXQUARE Hangul does not draw.
    const hangulCodePoints = new Set<number>();
    for (const { unicodeRange } of hangul.faces) {
      for (const codePoint of parseUnicodeRange(unicodeRange)) hangulCodePoints.add(codePoint);
    }
    const leftToKorean = new Set<number>();
    for (const rule of parseFontFaceRules(read('css/fonts/app/font-noto-kr.css'))) {
      for (const codePoint of parseUnicodeRange(rule.unicodeRange ?? '')) {
        if (isHangul(codePoint) && !hangulCodePoints.has(codePoint)) leftToKorean.add(codePoint);
      }
    }
    expect(faces[2]?.use).toBe(
      `Han, kana and the symbols Inter lacks. Kana comes only from JP, and KR fills the ${leftToKorean.size} Hangul that Pretendard lacks.`,
    );

    const named = new Set([
      'Inter',
      'MUSIXQUARE Hangul',
      'Noto Sans KR',
      'Noto Sans JP',
      'Noto Sans SC',
      'Noto Sans TC',
      'Noto Sans Thai',
      'Noto Sans Arabic',
      'Noto Sans Hebrew',
    ]);
    expect(APP_FONT_SHEETS.filter(({ family }) => named.has(family))).toHaveLength(named.size);
    const indic = APP_FONT_SHEETS.filter(({ family }) => !named.has(family)).length;
    expect(faces[3]?.name).toBe(`Noto Sans Thai, Arabic, Hebrew and ${indic} Indic`);

    const uncovered = read('scripts/fonts/uncovered-code-points.txt')
      .split('\n')
      .filter((line) => /^U\+[0-9A-F]{4,6}\b/u.test(line)).length;
    expect(text(block('Faces').querySelector('.typo-note'))).toContain(
      `${new Intl.NumberFormat('en-US').format(uncovered)} listed rare characters`,
    );
  });

  it("prints Inter's optical sizes at the sizes the app's size-adjust gives them", () => {
    const tracking = block('Tracking');
    const scale = INTER_FACE_METRICS.sizeAdjust / 100;
    // A 15 px label is drawn at 15 × size-adjust px, so its opsz is that.
    const small = Number((15 * scale).toFixed(1));
    // The smallest whole px size whose drawn size reaches the axis maximum.
    const large = Math.ceil(Number(OPSZ_MAX) / scale);
    expect([...tracking.querySelectorAll('.typo-track-lab')].map(text)).toEqual([
      `opsz ${small}, as at 15 px`,
      `opsz ${OPSZ_MAX}, at ${large} px and up`,
      'Invite code · 0.1em · tabular figures',
    ]);
    expect(
      [...tracking.querySelectorAll<HTMLElement>('.typo-optical [style]')].map((element) =>
        element.style.getPropertyValue('--opsz').trim(),
      ),
    ).toEqual([String(small), String(OPSZ_MAX), String(OPSZ_MAX)]);
    expect(text(tracking.querySelector('.typo-note'))).toContain(
      `follows the type size from ${OPSZ_MIN} to ${OPSZ_MAX}`,
    );
    // The invite code's tracking and figures are the app's.
    const invite = app('.invite-code-value');
    expect(invite.get('letter-spacing')).toBe('0.1em');
    expect(invite.get('font-variant-numeric')).toBe('tabular-nums');
    const code = sectionRule('.is-code .typo-track-word');
    expect(code.get('letter-spacing')).toBe(invite.get('letter-spacing'));
    expect(code.get('font-variant-numeric')).toBe(invite.get('font-variant-numeric'));
  });

  it("draws the leading samples at the app's sizes and leading, and prints their pitch", () => {
    const leading = block('Leading');
    const tabTitle = app('.tab-title');
    const dialog = app('.dialog-message');
    const root = app(':root');
    const size = (value: string | undefined): number => Number.parseFloat(value ?? '');
    // The tab title sets no line height: it takes the shared box.
    expect(tabTitle.get('line-height')).toBeUndefined();
    const samples = [
      {
        meta: `Tab title, phone${px(size(tabTitle.get('font-size')))} type, normal`,
        selector: '.typo-lead-sample.is-title',
        size: tabTitle.get('font-size'),
        line: 'normal',
        pitch: `${normalLine(size(tabTitle.get('font-size')))} px line`,
      },
      {
        meta: `Dialog message${px(size(dialog.get('font-size')))} type, ${dialog.get('line-height')}`,
        selector: '.typo-lead-sample.is-message',
        size: dialog.get('font-size'),
        line: dialog.get('line-height'),
        pitch: `${px(size(dialog.get('font-size')) * Number(dialog.get('line-height')))} line`,
      },
      {
        meta: `Button label${px(size(root.get('--button-label-size')))} type, ${root.get('--button-label-line-height')}`,
        selector: '.typo-lead-sample.is-button',
        size: root.get('--button-label-size'),
        line: root.get('--button-label-line-height'),
        pitch: `${px(size(root.get('--button-label-size')) * Number(root.get('--button-label-line-height')))} line`,
      },
    ];
    expect(samples.map(({ pitch }) => pitch)).toEqual([
      '34 px line',
      '23.7 px line',
      '18.75 px line',
    ]);
    const leads = [...leading.querySelectorAll('.typo-lead')];
    expect(leads).toHaveLength(samples.length);
    for (const [index, sample] of samples.entries()) {
      const lead = leads[index];
      expect(text(lead?.querySelector('.typo-lead-meta')), sample.selector).toBe(sample.meta);
      const marks = [...(lead?.querySelectorAll('.typo-lead-mark') ?? [])];
      expect(marks.map((mark) => mark.getAttribute('data-pitch'))).toEqual([null, sample.pitch]);
      const rule = sectionRule(sample.selector);
      expect(rule.get('font-size'), sample.selector).toBe(sample.size);
      expect(rule.get('line-height'), sample.selector).toBe(sample.line);
    }

    // The titles that set their own leading, on a phone and on a desktop.
    const track = app('.track-title');
    const desktop = declarations('css/desktop.css', '.tab-title, .chat-drawer-title, .track-title');
    const desktopSize = size(desktop.get('font-size'));
    expect(text(leading.querySelector('.typo-note'))).toContain(
      `the phone track title is ${px(size(track.get('font-size')))} on a ${px(size(track.get('line-height')))} line, and on desktop the tab, chat and track titles are ${px(desktopSize)} on a ${px(desktopSize * Number(desktop.get('line-height')))} line`,
    );
  });

  it("names the weights by the app's weight roles", () => {
    const tokens = app(':root');
    const role = (name: string) => tokens.get(`--font-weight-${name}`);
    const weights = [...block('Weights').querySelectorAll('.weight-row .w')].map((row) => ({
      weight: row.querySelector<HTMLElement>('.gl')?.style.getPropertyValue('font-weight'),
      label: text(row.querySelector('.lab')),
    }));
    expect(weights).toEqual([
      { weight: 'var(--font-weight-body)', label: `${role('body')} Body` },
      { weight: 'var(--font-weight-unselected)', label: `${role('unselected')} Unselected` },
      { weight: 'var(--font-weight-label)', label: `${role('label')} Label` },
      { weight: 'var(--font-weight-title)', label: `${role('title')} Title, selected` },
    ]);
    expect(role('selected')).toBe(role('title'));
    const all = ['body', 'unselected', 'label', 'title', 'selected'].map((name) =>
      Number(role(name)),
    );
    expect(Math.max(...all)).toBe(700);
    expect(text(block('Weights').querySelector('.typo-note'))).toBe(
      `Five roles, four weights. Nothing goes above ${Math.max(...all)}.`,
    );
    expect(new Set(all).size).toBe(4);
  });
});
