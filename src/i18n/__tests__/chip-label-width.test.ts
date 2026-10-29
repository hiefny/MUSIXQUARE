import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

import { APP_DICTIONARIES } from '../catalogs.ts';
import { LANGUAGE_OPTIONS } from '../locales.ts';
import { createLabelWidthHarness, type LabelWidthHarness } from './helpers/label-width-harness.ts';

/**
 * Chip label width guard (owner decision 2026-10-29, chip copy study). Every
 * fixed label of the 14 selection groups, in all 42 locales, shaped at the
 * selected weight 700 with the app's web fonts, must fit its group's
 * narrowest label box with at least 4px to spare. The groups read their keys
 * from index.html, so the guard follows the markup.
 *
 * It checks width, not line count: a single word that does not fit never
 * wraps in a 1fr chip column or a flex: 1 pill, it widens its own column and
 * squeezes the others, and the bottom navigation and the demo step indicator
 * cut their labels off with an ellipsis instead of wrapping.
 *
 * The boxes are worked out from the CSS (font size, columns, gaps, padding,
 * border, icon) at the screen that gives each group its narrowest box, and
 * written here as fixed numbers. The demo role switch reads the one width
 * the CSS sets for it, the container width below which its icon hides.
 * Widths come from helpers/label-width-harness.ts, which matched Chromium
 * within 0.07px on all 42 locales; the 4px spare also absorbs iOS Safari's
 * subpixel differences, which the study could not measure.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SPARE = 4;
/** --font-weight-selected: a chip's label at its widest, in its selected state. */
const SELECTED_WEIGHT = 700;

interface LabelBox {
  /** The screen that gives the box. */
  readonly screen: string;
  readonly fontSize: number;
  readonly width: number;
  /**
   * The demo step indicator's hidden ::before digit keeps its room beside
   * the label in this box: .demo-step-nav button:not(.demo-step-next)::before
   * { content: attr(data-demo-step); font-size: 14px; font-weight: 500 }.
   */
  readonly lessStepDigit?: true;
}

interface ChipGroup {
  readonly name: string;
  /** The group's label elements in index.html. */
  readonly labels: string;
  readonly boxes: readonly LabelBox[];
}

const STEP_DIGIT = { fontSize: 14, weight: 500 } as const;

/**
 * Settings choice chips at 320×568 (css/style.css): .section-group { margin:
 * 0 44px } leaves 320 − 2 × 44 = 232px; .channel-grid { grid-template-columns:
 * 1fr 1fr; gap: 12px } gives (232 − 12) / 2 = 110px chips; .ch-opt { padding:
 * 18px 12px; border: 2px } leaves 110 − 2 × 12 − 2 × 2 = 82px at
 * --button-label-chip-size, 14px. The icon sits above the label. Wider
 * layouts give 132px (desktop) and more.
 */
const SETTINGS_CHIP_BOXES: readonly LabelBox[] = [{ screen: '320×568', fontSize: 14, width: 82 }];

/** Two-column demo layouts read --demo-panel-max: clamp(340px, 40vw, 640px). */
const DEMO_PANEL_SHARE = 0.4;

/**
 * The demo role switch boxes (css/style.css .demo-role-segmented). Four
 * columns of minmax(0, 1fr) with an 8px gap share the container. The icon is
 * 19px, inline, 6px from the label on phones and clamp(5px, 0.8vw, 9px) from
 * 720px; buttons have no border and 8px inline padding. Where the icon hides,
 * the container rule sets padding-inline 4px and phones up to 420px set
 * padding 0 5px.
 */
function demoRoleBoxes(iconHiddenUpTo: number): LabelBox[] {
  const column = (container: number) => (container - 3 * 8) / 4;
  const vw = iconHiddenUpTo / DEMO_PANEL_SHARE;
  const twoColumnGap = Math.min(9, Math.max(5, 0.008 * vw));
  const twoColumnFont = Math.min(14.5, Math.max(12.5, vw / 100));
  return [
    // @media (max-width: 420px): font-size 12px, padding 0 5px, no icon. The
    // demo shell's 10px padding and the control stage's 18px inset leave
    // 320 − 2 × 10 − 2 × 18 = 264px.
    { screen: '320×568', fontSize: 12, width: column(264) - 2 * 5 },
    // Two columns from 720px: the shell (padding 18px, column gap 21.6px)
    // gives the control stage a 331.2px column, which its −18px end margin
    // widens to 349.2px; less its 2 × 28.8px padding: 291.6px, under the
    // icon threshold.
    { screen: '720×360', fontSize: 12.5, width: column(291.6) - 2 * 4 },
    // The narrowest container that shows the icon, on a phone (13px)...
    {
      screen: `${iconHiddenUpTo}px container, phone`,
      fontSize: 13,
      width: column(iconHiddenUpTo) - 2 * 8 - 19 - 6,
    },
    // ...and in the two-column layout, where the container is 40vw.
    {
      screen: `${iconHiddenUpTo}px container, ${Math.round(vw)}px wide`,
      fontSize: twoColumnFont,
      width: column(iconHiddenUpTo) - 2 * 8 - 19 - twoColumnGap,
    },
    // Desktop: 1280px (12.8px, 512px container, 9px icon gap) and 1480px
    // (the 14.5px cap, 592px container).
    { screen: '1280×800', fontSize: 12.8, width: column(512) - 2 * 8 - 19 - 9 },
    { screen: '1480×720', fontSize: 14.5, width: column(592) - 2 * 8 - 19 - 9 },
  ];
}

/** The container width up to which the demo role switch hides its icon. */
function demoRoleIconThreshold(css: string): number {
  const match = /@container\s+demo-role-options\s+\(max-width:\s*([\d.]+)px\)/u.exec(css);
  if (!match?.[1]) throw new Error('css/style.css: no @container demo-role-options rule');
  return Number(match[1]);
}

function chipGroups(css: string): readonly ChipGroup[] {
  const settings = (id: string): ChipGroup => ({
    name: id,
    labels: `#${id} .ch-opt > span[data-i18n]`,
    boxes: SETTINGS_CHIP_BOXES,
  });
  return [
    settings('grid-lang'),
    settings('grid-theme'),
    settings('grid-ui-sounds'),
    settings('grid-settings-sync'),
    settings('grid-standard'),
    settings('grid-reverb'),
    settings('grid-eq'),
    settings('grid-virtual-effects'),
    {
      // .setup-card { padding: 32px 28px 24px } and .onboarding-card > div
      // { padding: 0 28px } leave 320 − 4 × 28 = 208px; the grid keeps
      // .setup-card-tight's padding 0, so two 1fr columns with the 12px gap
      // give 98px chips and 98 − 2 × 12 − 2 × 2 = 70px at 14px.
      name: 'setup-role-grid',
      labels: '#setup-role-grid .ch-opt > span[data-i18n]',
      boxes: [{ screen: '320×568', fontSize: 14, width: 70 }],
    },
    {
      // Demo effect cards: 264px (as for the role switch) in
      // repeat(2, minmax(0, 1fr)) with an 8px gap gives 128px cards, less
      // the @media (max-width: 420px) padding 16px 10px and the 2px border:
      // 104px at --button-label-tab-size, 13px. From 720px the cards take
      // 14px and padding 12px in the 291.6px panel: (291.6 − 8) / 2 − 2 × 12
      // − 2 × 2 = 113.8px.
      name: 'demo-effects',
      labels: '.demo-large-actions .ch-opt.demo-choice > span[data-i18n]',
      boxes: [
        { screen: '320×568', fontSize: 13, width: 104 },
        { screen: '720×360', fontSize: 14, width: (291.6 - 8) / 2 - 2 * 12 - 2 * 2 },
      ],
    },
    {
      // Phones: .bottom-nav { padding: 10px 16px } shares 320 − 32 = 288px
      // among five flex: 1 .nav-item buttons with no padding: 57.6px at
      // 10px, the icon above. Two-column side rail (css/style.css): 200px
      // wide with 20px inline padding, buttons with padding 0 12px, an 18px
      // icon and a 10px gap: 160 − 24 − 18 − 10 = 108px at 13px.
      name: 'nav-item',
      labels: '.bottom-nav .nav-item > span[data-i18n]',
      boxes: [
        { screen: '320×568', fontSize: 10, width: 288 / 5 },
        { screen: '720×360', fontSize: 13, width: 108 },
      ],
    },
    {
      // Desktop settings sub-tabs (css/desktop.css): #tab-settings is the
      // 420px third column with 4px padding; .settings-subtab-nav { margin:
      // 0 20px; padding: 16px 20px 0; gap: 4px } leaves 412 − 40 − 40 =
      // 332px for four flex: 1 pills with no inline padding: (332 − 12) / 4
      // = 80px at the tab role's 13px.
      name: 'subtab-pill',
      labels: '.settings-subtab-nav .subtab-pill[data-i18n]',
      boxes: [{ screen: '1280×800', fontSize: 13, width: 80 }],
    },
    {
      name: 'demo-role-segmented',
      labels: '.demo-role-segmented button > span[data-i18n]',
      boxes: demoRoleBoxes(demoRoleIconThreshold(css)),
    },
    {
      // The current step's pill at 320×568: --demo-step-pill-size
      // clamp(100px, 100vw − 2 × 14.4 − 3 × 52 − 3 × 6.4, 184px) = 116px,
      // less padding clamp(8px, 2.6vw, 14px) = 8.32px and the 1px border
      // each side: 97.36px at 13px, steps 1 to 3 also less their digit.
      // From 1500px the label takes 15px and its span's max-width 128px.
      name: 'demo-step-nav',
      labels: '.demo-step-nav button > span[data-i18n]',
      boxes: [
        {
          screen: '320×568',
          fontSize: 13,
          width: 116 - 2 * 8.32 - 2 * 1,
          lessStepDigit: true,
        },
        { screen: '1536×864', fontSize: 15, width: 128 },
      ],
    },
  ];
}

interface AcceptedLabel {
  readonly locale: string;
  readonly group: string;
  readonly key: string;
  /** The accepted text, exactly. */
  readonly text: string;
  /** Its width at weight 700 in the group's first (narrowest) box. */
  readonly width: number;
  readonly box: number;
  readonly why: string;
}

/**
 * Labels kept below the 4px spare, with no padding change, each listed with its
 * text and width: the ones the owner accepted (decisions 2026-10-29 (d) and
 * (e)), and the Tamil Manual chips of decision (c), whose catalog word கைமுறை
 * leaves 2.31px, like the near misses of (e). A changed text, or a width that
 * moves, is checked again.
 */
const ACCEPTED: readonly AcceptedLabel[] = [
  {
    locale: 'ta',
    group: 'grid-reverb',
    key: 'settings.rvb_studio',
    text: 'ஸ்டூடியோ',
    width: 80.96,
    box: 82,
    why: 'no shorter Tamil word for the Studio preset; one line',
  },
  {
    locale: 'ml',
    group: 'grid-reverb',
    key: 'settings.rvb_studio',
    text: 'സ്റ്റുഡിയോ',
    width: 80.21,
    box: 82,
    why: 'no shorter Malayalam spelling for the Studio preset; one line',
  },
  {
    locale: 'ta',
    group: 'grid-reverb',
    key: 'settings.rvb_advanced',
    text: 'கைமுறை',
    width: 79.69,
    box: 82,
    why: "Manual (decision (c)) in the catalog's word, as in கைமுறை ஒத்திசைவு; one line",
  },
  {
    locale: 'ta',
    group: 'grid-eq',
    key: 'settings.eq_advanced',
    text: 'கைமுறை',
    width: 79.69,
    box: 82,
    why: 'the same word as the reverb chip; one line',
  },
  {
    locale: 'ko',
    group: 'demo-step-nav',
    key: 'demo.step_effects',
    text: '3. 고급 음향 효과',
    width: 87.72,
    box: 88.61,
    why: 'the Korean the owner kept on 2026-10-28; one line, not cut off',
  },
  {
    locale: 'id',
    group: 'nav-item',
    key: 'nav.settings_compact',
    text: 'Pengaturan',
    width: 54.5,
    box: 57.6,
    why: "the catalog's one word for Settings; not cut off",
  },
  {
    locale: 'id',
    group: 'nav-item',
    key: 'nav.connect_compact',
    text: 'Hubungkan',
    width: 54.44,
    box: 57.6,
    why: 'the same word as the desktop Connect tab; not cut off',
  },
  {
    locale: 'uk',
    group: 'nav-item',
    key: 'nav.settings_compact',
    text: 'Параметри',
    width: 54.89,
    box: 57.6,
    why: 'the standard Ukrainian name for Settings; not cut off',
  },
  {
    locale: 'es',
    group: 'demo-role-segmented',
    key: 'common.left',
    text: 'Izquierda',
    width: 52.53,
    box: 50,
    why: 'shared with the chat role names; accepted at 320px',
  },
  {
    locale: 'es',
    group: 'demo-role-segmented',
    key: 'common.right',
    text: 'Derecha',
    width: 47.32,
    box: 50,
    why: 'shared with the chat role names; accepted at 320px',
  },
  {
    locale: 'pt-br',
    group: 'demo-role-segmented',
    key: 'common.left',
    text: 'Esquerda',
    width: 53.38,
    box: 50,
    why: 'shared with the chat role names; accepted at 320px',
  },
  {
    locale: 'el',
    group: 'demo-role-segmented',
    key: 'common.left',
    text: 'Αριστερό',
    width: 55.42,
    box: 50,
    why: 'shared with the chat role names; no shorter Greek word; accepted at 320px',
  },
];

interface Check {
  readonly locale: string;
  readonly group: string;
  readonly key: string;
  readonly text: string;
  readonly screen: string;
  readonly box: number;
  readonly width: number;
  readonly uncovered: readonly string[];
}

const describeCheck = (check: Check): string =>
  `${check.locale} ${check.key} '${check.text}' ${check.width.toFixed(2)}px, box ${check.box.toFixed(2)}px ` +
  `(${check.screen}, ${check.group})`;

const acceptedFor = (check: Pick<Check, 'locale' | 'group' | 'key'>) =>
  ACCEPTED.find(
    (entry) =>
      entry.locale === check.locale && entry.group === check.group && entry.key === check.key,
  );

describe('chip label width guard', () => {
  const css = readFileSync(`${REPO_ROOT}css/style.css`, 'utf8');
  const markup = new JSDOM(readFileSync(`${REPO_ROOT}index.html`, 'utf8')).window.document;
  const groups = chipGroups(css);
  const dictionaries = APP_DICTIONARIES as Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  const checks: Check[] = [];
  let harness: LabelWidthHarness;

  beforeAll(async () => {
    harness = createLabelWidthHarness({ repoRoot: REPO_ROOT });
    for (const group of groups) {
      const labels = [...markup.querySelectorAll(group.labels)];
      for (const label of labels) {
        const key = label.getAttribute('data-i18n') ?? '';
        const button = label.closest('button');
        const digit = button?.classList.contains('demo-step-next')
          ? ''
          : (button?.getAttribute('data-demo-step') ?? '');
        for (const option of LANGUAGE_OPTIONS) {
          const text = dictionaries[option.code]?.[key] ?? '';
          const measure = (value: string, fontSize: number, weight: number) =>
            harness.measure(value, {
              locale: option.code,
              htmlLang: option.htmlLang,
              fontSize,
              weight,
            });
          for (const box of group.boxes) {
            const digitWidth =
              box.lessStepDigit && digit
                ? (await measure(digit, STEP_DIGIT.fontSize, STEP_DIGIT.weight)).width
                : 0;
            const measured = await measure(text, box.fontSize, SELECTED_WEIGHT);
            checks.push({
              locale: option.code,
              group: group.name,
              key,
              text,
              screen: box.screen,
              box: box.width - digitWidth,
              width: measured.width,
              uncovered: measured.uncovered,
            });
          }
        }
      }
    }
  }, 120_000);

  it('reads the 14 groups and their labels from index.html', () => {
    const counts = Object.fromEntries(
      groups.map((group) => [group.name, markup.querySelectorAll(group.labels).length]),
    );
    expect(counts).toEqual({
      'grid-lang': 2,
      'grid-theme': 2,
      'grid-ui-sounds': 2,
      'grid-settings-sync': 2,
      'grid-standard': 4,
      'grid-reverb': 4,
      'grid-eq': 4,
      'grid-virtual-effects': 4,
      'setup-role-grid': 4,
      'demo-effects': 4,
      'nav-item': 5,
      'subtab-pill': 4,
      'demo-role-segmented': 4,
      'demo-step-nav': 4,
    });
    expect(LANGUAGE_OPTIONS).toHaveLength(42);
    expect(checks.length).toBeGreaterThan(0);
  });

  it('draws every label with the web fonts, never a system fallback', () => {
    const fallbacks = checks
      .filter((check) => check.uncovered.length > 0)
      .map((check) => `${describeCheck(check)}: ${check.uncovered.join(' ')}`);
    expect([...new Set(fallbacks)]).toEqual([]);
  });

  it('fits every label with 4px to spare at weight 700 in all 42 locales', () => {
    const tooWide = checks
      .filter((check) => check.width + SPARE > check.box && !acceptedFor(check))
      .map(describeCheck);
    expect(tooWide).toEqual([]);
  });

  it('keeps each accepted label at its recorded text and width', () => {
    const problems: string[] = [];
    for (const entry of ACCEPTED) {
      const label = `${entry.locale} ${entry.key} (${entry.group})`;
      const own = checks.filter(
        (check) =>
          check.locale === entry.locale && check.group === entry.group && check.key === entry.key,
      );
      const first = own[0];
      if (!first) {
        problems.push(`${label}: the group no longer shows this key`);
        continue;
      }
      if (first.text !== entry.text) {
        problems.push(
          `${label}: the text is now '${first.text}', not the accepted '${entry.text}' ` +
            `(${entry.why}); check it again`,
        );
        continue;
      }
      if (Math.abs(first.width - entry.width) > 0.05 || Math.abs(first.box - entry.box) > 0.05) {
        problems.push(
          `${label}: ${first.width.toFixed(2)}px in ${first.box.toFixed(2)}px, ` +
            `recorded ${entry.width}px in ${entry.box}px`,
        );
      }
      if (own.every((check) => check.width + SPARE <= check.box)) {
        problems.push(`${label}: fits with 4px to spare now, remove the exception`);
      }
    }
    expect(problems).toEqual([]);
  });
});
