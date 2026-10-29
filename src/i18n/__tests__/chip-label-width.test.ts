import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { parse as parseCss, type AtRule, type Node, type Root } from 'postcss';
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
 * written here as fixed numbers. LABEL_BOX_SOURCES records every declaration
 * a box is worked out from, as written, and the guard reads them back from
 * the stylesheets with postcss: a change to a recorded declaration fails here
 * until the box is worked out again. Only those declarations are read, so a
 * new rule, or a more specific or later one, that narrows a box or spaces
 * its letters does not fail here; work the box out again when adding one.
 * The demo role switch reads the one width the CSS sets for it, the
 * container width below which its icon hides, and demo-role-icon.test.ts
 * pins the switch's own declarations.
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

type Stylesheet = 'css/style.css' | 'css/desktop.css';

/** A rule's declarations that a label box is worked out from. */
interface BoxSource {
  readonly file: Stylesheet;
  readonly selector: string;
  /** The at-rule the rule sits in, cascade layers aside; null at the top. */
  readonly condition: string | null;
  /** The declarations, as written (whitespace collapsed). */
  readonly values: Readonly<Record<string, string>>;
}

const PHONES = '@media (max-width: 420px)';
const TWO_COLUMNS = '@media (min-width: 720px)';
const SIDE_RAIL =
  '@media (min-width: 720px) and (max-width: 1279px), (min-width: 1280px) and (max-height: 719px)';
const DESKTOP = '@media (min-width: 1280px) and (min-height: 720px)';

const source = (
  file: Stylesheet,
  selector: string,
  condition: string | null,
  values: Readonly<Record<string, string>>,
): BoxSource => ({ file, selector, condition, values });

const TOKEN_SOURCES = [
  source('css/style.css', ':root', null, {
    '--font-weight-selected': `${SELECTED_WEIGHT}`,
    '--font-weight-unselected': `${STEP_DIGIT.weight}`,
    '--button-label-chip-size': '14px',
    '--button-label-tab-size': '13px',
    // The harness measures without letter spacing.
    '--button-label-letter-spacing': 'normal',
  }),
];

const CHIP_SOURCES = [
  source('css/style.css', '.channel-grid', null, {
    'grid-template-columns': '1fr 1fr',
    gap: '12px',
  }),
  source('css/style.css', '.ch-opt', null, {
    padding: '18px 12px',
    border: '2px solid transparent',
    'font-size': 'var(--button-label-chip-size)',
    'letter-spacing': 'var(--button-label-letter-spacing)',
  }),
];

/** The demo panel at 320×568 (264px) and 720×360 (291.6px). */
const DEMO_PANEL_SOURCES = [
  source('css/style.css', '.demo-mobile-shell', null, { '--demo-panel-max': '520px' }),
  source('css/style.css', '.demo-mobile-shell', PHONES, {
    'padding-inline-start': '10px',
    'padding-inline-end': '10px',
    '--demo-control-inset': '18px',
  }),
  source('css/style.css', '.demo-control-stage', null, {
    padding: 'var(--demo-control-pad-top) var(--demo-control-inset) clamp(18px, 5vw, 28px)',
  }),
  source('css/style.css', '.demo-step-content', null, { 'max-width': 'var(--demo-panel-max)' }),
  source('css/style.css', '.demo-mobile-shell', TWO_COLUMNS, {
    '--demo-shell-pad-inline': 'clamp(18px, 3.6vmin, 40px)',
    '--demo-control-pad-inline': 'clamp(28px, 4vw, 56px)',
    '--demo-panel-max': 'clamp(340px, 40vw, 640px)',
    '--demo-column-gap': 'clamp(18px, 3vw, 44px)',
    'grid-template-columns': 'minmax(0, 1fr) minmax(0, 1fr)',
    'column-gap': 'var(--demo-column-gap)',
    padding:
      'calc(var(--demo-shell-pad-block) + var(--safe-top)) calc(var(--demo-shell-pad-inline) + var(--safe-right)) calc(var(--demo-shell-pad-block) + var(--safe-bottom)) calc(var(--demo-shell-pad-inline) + var(--safe-left))',
  }),
  source('css/style.css', '.demo-control-stage', TWO_COLUMNS, {
    margin:
      'calc(0px - var(--demo-shell-pad-block) - var(--safe-top)) calc(0px - var(--demo-shell-pad-inline) - var(--safe-right)) calc(0px - var(--demo-shell-pad-block) - var(--safe-bottom)) 0',
    padding:
      'calc(var(--demo-shell-pad-block) + var(--safe-top) + var(--demo-control-pad-block)) calc(var(--demo-control-pad-inline) + var(--safe-right)) calc(var(--demo-shell-pad-block) + var(--safe-bottom) + var(--demo-control-pad-block)) var(--demo-control-pad-inline)',
  }),
];

/**
 * Every declaration the label boxes in chipGroups() are worked out from, by
 * box family, as the comments there describe them. When one of these
 * changes, work the family's boxes out again and record the new value here.
 */
const LABEL_BOX_SOURCES: Readonly<Record<string, readonly BoxSource[]>> = {
  tokens: TOKEN_SOURCES,
  'settings chips': [
    source('css/style.css', '.section-group', null, { margin: '0 44px' }),
    source('css/style.css', '#tab-settings .channel-grid', null, {
      'padding-inline-start': '0',
      'padding-inline-end': '0',
    }),
    ...CHIP_SOURCES,
  ],
  'setup role chips': [
    source('css/style.css', '.setup-card', null, { padding: '32px 28px 24px' }),
    source('css/style.css', '.onboarding-card > div:not(.ob-actions):not(.cscroll-track)', null, {
      padding: '0 28px',
    }),
    // @layer components, after #setup-role-grid.channel-grid's padding in base.
    source('css/style.css', '.setup-card-tight', null, { padding: '0' }),
    ...CHIP_SOURCES,
  ],
  'demo effect cards': [
    ...DEMO_PANEL_SOURCES,
    source('css/style.css', '.demo-large-actions', null, {
      'grid-template-columns': 'repeat(2, minmax(0, 1fr))',
    }),
    source('css/style.css', '.demo-effects-content .demo-large-actions', null, { gap: '8px' }),
    source(
      'css/style.css',
      '.demo-effects-content .demo-large-actions .ch-opt.demo-choice',
      PHONES,
      {
        padding: '16px 10px',
        'font-size': 'var(--button-label-tab-size)',
      },
    ),
    source(
      'css/style.css',
      '.demo-effects-content .demo-large-actions .ch-opt.demo-choice',
      TWO_COLUMNS,
      { padding: 'clamp(16px, 2vh, 20px) 12px' },
    ),
    // The cards' own padding replaces .ch-opt's; its border and size stay.
    source('css/style.css', '.ch-opt', null, {
      border: '2px solid transparent',
      'font-size': 'var(--button-label-chip-size)',
      'letter-spacing': 'var(--button-label-letter-spacing)',
    }),
  ],
  'demo role switch': [
    ...DEMO_PANEL_SOURCES,
    source('css/style.css', '.demo-role-segmented button', null, {
      'letter-spacing': 'var(--button-label-letter-spacing)',
    }),
    // The phone rule; demo-role-icon.test.ts pins the switch's other values.
    source('css/style.css', '.demo-role-segmented button', PHONES, {
      padding: '0 5px',
      'font-size': '12px',
    }),
  ],
  'bottom navigation': [
    source('css/style.css', '.bottom-nav', null, {
      padding: '10px 16px calc(10px + var(--safe-bottom) + var(--safe-nav-bottom, 0px))',
    }),
    source('css/style.css', '.nav-item', null, { flex: '1', padding: '0' }),
    source('css/style.css', '.nav-item span', null, { 'font-size': '10px' }),
    source('css/style.css', '.bottom-nav', SIDE_RAIL, {
      width: 'calc(200px + var(--safe-right))',
      padding: '8px 12px 8px 20px',
      'padding-inline-end': 'calc(20px + var(--safe-right))',
    }),
    source('css/style.css', '.bottom-nav button', SIDE_RAIL, { padding: '0 12px', gap: '10px' }),
    source('css/style.css', '.bottom-nav button svg', SIDE_RAIL, { width: '18px' }),
    source('css/style.css', '.bottom-nav button span', SIDE_RAIL, { 'font-size': '13px' }),
  ],
  'settings sub-tabs': [
    source('css/desktop.css', 'body', DESKTOP, {
      '--desktop-ui-scale': '1',
      'grid-template-columns': 'minmax(0, 3fr) minmax(420px, 1fr) minmax(420px, 1fr)',
    }),
    source('css/desktop.css', '#tab-settings', DESKTOP, { padding: '0 4px' }),
    source('css/desktop.css', '.settings-subtab-nav', DESKTOP, {
      margin: '0 20px',
      padding: '16px 20px 0',
      gap: '4px',
    }),
    source('css/desktop.css', '.subtab-pill', DESKTOP, {
      flex: '1',
      padding: '10px 0',
      'font-size': 'var(--button-label-tab-size)',
    }),
  ],
  'demo step pill': [
    source('css/style.css', '.demo-step-nav', null, {
      '--demo-step-nav-inset': 'clamp(14px, 4.5vw, 24px)',
      '--demo-step-gap': 'clamp(6px, 2vw, 8px)',
      '--demo-step-dot-size': 'clamp(52px, 12.5vw, 56px)',
      '--demo-step-pill-size':
        'clamp(100px, calc(100vw - var(--demo-step-nav-inset) - var(--demo-step-nav-inset) - var(--demo-step-dot-size) - var(--demo-step-dot-size) - var(--demo-step-dot-size) - var(--demo-step-gap) - var(--demo-step-gap) - var(--demo-step-gap)), 184px)',
    }),
    source('css/style.css', '.demo-step-nav button', null, {
      border: '1px solid transparent',
      'font-size': '13px',
      'letter-spacing': 'var(--button-label-letter-spacing)',
    }),
    source('css/style.css', '.demo-step-nav button:not(.demo-step-next)::before', null, {
      content: 'attr(data-demo-step)',
      'font-size': `${STEP_DIGIT.fontSize}px`,
      'font-weight': 'var(--font-weight-unselected)',
    }),
    source('css/style.css', '.demo-step-nav button.active', null, {
      'flex-basis': 'var(--demo-step-pill-size)',
      padding: '0 clamp(8px, 2.6vw, 14px)',
    }),
    source('css/style.css', '.demo-step-nav button.active', TWO_COLUMNS, {
      'font-size': 'clamp(13px, 1vw, 15px)',
    }),
    source('css/style.css', '.demo-step-nav button.active span', TWO_COLUMNS, {
      'max-width': '128px',
    }),
  ],
};

/** Collapses whitespace, including inside parentheses, as the sources are written. */
const normalizeValue = (value: string): string =>
  value.replace(/\s+/gu, ' ').replace(/\(\s/gu, '(').replace(/\s\)/gu, ')').trim();

/** The at-rule a rule sits in, cascade layers aside. */
function conditionOf(node: Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== 'atrule') continue;
    const atRule = parent as AtRule;
    if (atRule.name !== 'layer') return `@${atRule.name} ${normalizeValue(atRule.params)}`;
  }
  return null;
}

/** The declarations of the rules that list `selector` under `condition`. */
function declarationsOf(root: Root, selector: string, condition: string | null) {
  const values: Record<string, string> = {};
  root.walkRules((rule) => {
    const selectors = rule.selectors.map((entry) => entry.replace(/\s+/gu, ' ').trim());
    if (!selectors.includes(selector) || conditionOf(rule) !== condition) return;
    rule.each((child) => {
      if (child.type === 'decl') values[child.prop] = normalizeValue(child.value);
    });
  });
  return values;
}

interface AcceptedLabel {
  readonly locale: string;
  readonly group: string;
  readonly key: string;
  /** The box's screen, as chipGroups() names it. */
  readonly screen: string;
  /** The accepted text, exactly. */
  readonly text: string;
  /** Its width at weight 700 in that screen's box. */
  readonly width: number;
  readonly box: number;
  readonly why: string;
}

/**
 * Labels kept below the 4px spare, with no padding change, each listed with
 * its screen, text and width: the ones the owner accepted (decisions
 * 2026-10-29 (d) and (e)), the Tamil Manual chips of decision (c), whose
 * catalog word கைமுறை leaves 2.31px like the near misses of (e) and which the
 * owner confirmed on 2026-10-29, and the two demo role near misses at
 * 720×360. An entry covers only its own screen's box, so a label that is
 * accepted at 320px still has to fit every other box. A changed text, or a
 * width that moves, is checked again.
 */
const ACCEPTED: readonly AcceptedLabel[] = [
  {
    locale: 'ta',
    group: 'grid-reverb',
    key: 'settings.rvb_studio',
    screen: '320×568',
    text: 'ஸ்டூடியோ',
    width: 80.96,
    box: 82,
    why: 'no shorter Tamil word for the Studio preset; one line',
  },
  {
    locale: 'ml',
    group: 'grid-reverb',
    key: 'settings.rvb_studio',
    screen: '320×568',
    text: 'സ്റ്റുഡിയോ',
    width: 80.21,
    box: 82,
    why: 'no shorter Malayalam spelling for the Studio preset; one line',
  },
  {
    locale: 'ta',
    group: 'grid-reverb',
    key: 'settings.rvb_advanced',
    screen: '320×568',
    text: 'கைமுறை',
    width: 79.69,
    box: 82,
    why: "Manual (decision (c)) in the catalog's word, as in கைமுறை ஒத்திசைவு; owner-confirmed; one line",
  },
  {
    locale: 'ta',
    group: 'grid-eq',
    key: 'settings.eq_advanced',
    screen: '320×568',
    text: 'கைமுறை',
    width: 79.69,
    box: 82,
    why: 'the same word as the reverb chip; one line',
  },
  {
    locale: 'ko',
    group: 'demo-step-nav',
    key: 'demo.step_effects',
    screen: '320×568',
    text: '3. 고급 음향 효과',
    width: 87.72,
    box: 88.61,
    why: 'the Korean the owner kept on 2026-10-28; one line, not cut off',
  },
  {
    locale: 'id',
    group: 'nav-item',
    key: 'nav.settings_compact',
    screen: '320×568',
    text: 'Pengaturan',
    width: 54.5,
    box: 57.6,
    why: "the catalog's one word for Settings; not cut off",
  },
  {
    locale: 'id',
    group: 'nav-item',
    key: 'nav.connect_compact',
    screen: '320×568',
    text: 'Hubungkan',
    width: 54.44,
    box: 57.6,
    why: 'the same word as the desktop Connect tab; not cut off',
  },
  {
    locale: 'uk',
    group: 'nav-item',
    key: 'nav.settings_compact',
    screen: '320×568',
    text: 'Параметри',
    width: 54.89,
    box: 57.6,
    why: 'the standard Ukrainian name for Settings; not cut off',
  },
  {
    locale: 'es',
    group: 'demo-role-segmented',
    key: 'common.left',
    screen: '320×568',
    text: 'Izquierda',
    width: 52.53,
    box: 50,
    why: 'shared with the chat role names; accepted at 320px',
  },
  {
    locale: 'es',
    group: 'demo-role-segmented',
    key: 'common.right',
    screen: '320×568',
    text: 'Derecha',
    width: 47.32,
    box: 50,
    why: 'shared with the chat role names; accepted at 320px',
  },
  {
    locale: 'pt-br',
    group: 'demo-role-segmented',
    key: 'common.left',
    screen: '320×568',
    text: 'Esquerda',
    width: 53.38,
    box: 50,
    why: 'shared with the chat role names; accepted at 320px',
  },
  {
    locale: 'el',
    group: 'demo-role-segmented',
    key: 'common.left',
    screen: '320×568',
    text: 'Αριστερό',
    width: 55.42,
    box: 50,
    why: 'shared with the chat role names; no shorter Greek word; accepted at 320px',
  },
  {
    locale: 'el',
    group: 'demo-role-segmented',
    key: 'common.left',
    screen: '720×360',
    text: 'Αριστερό',
    width: 57.73,
    box: 58.9,
    why: 'the word accepted at 320px; a near miss in the two-column layout; one line',
  },
  {
    locale: 'pt-br',
    group: 'demo-role-segmented',
    key: 'common.left',
    screen: '720×360',
    text: 'Esquerda',
    width: 55.6,
    box: 58.9,
    why: 'the word accepted at 320px; a near miss in the two-column layout; one line',
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

const sameLabelBox = (
  entry: Pick<Check, 'locale' | 'group' | 'key' | 'screen'>,
  check: Pick<Check, 'locale' | 'group' | 'key' | 'screen'>,
): boolean =>
  entry.locale === check.locale &&
  entry.group === check.group &&
  entry.key === check.key &&
  entry.screen === check.screen;

const acceptedFor = (check: Check) => ACCEPTED.find((entry) => sameLabelBox(entry, check));

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

  it('works the label boxes out from the CSS values recorded for them', () => {
    const roots = {
      'css/style.css': parseCss(css),
      'css/desktop.css': parseCss(readFileSync(`${REPO_ROOT}css/desktop.css`, 'utf8')),
    } satisfies Record<Stylesheet, Root>;
    const changed: string[] = [];
    for (const [family, sources] of Object.entries(LABEL_BOX_SOURCES)) {
      for (const { file, selector, condition, values } of sources) {
        const actual = declarationsOf(roots[file], selector, condition);
        for (const [property, expected] of Object.entries(values)) {
          if (actual[property] === expected) continue;
          changed.push(
            `${family}: ${file} ${condition ? `${condition} ` : ''}${selector} { ${property}: ` +
              `${actual[property] ?? '(none)'} }, the boxes were worked out from '${expected}'; ` +
              'work them out again',
          );
        }
      }
    }
    expect(changed).toEqual([]);
  });

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
      const label = `${entry.locale} ${entry.key} (${entry.screen}, ${entry.group})`;
      const first = checks.find((check) => sameLabelBox(entry, check));
      if (!first) {
        problems.push(`${label}: the group no longer shows this key on this screen`);
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
      if (first.width + SPARE <= first.box) {
        problems.push(`${label}: fits with 4px to spare now, remove the exception`);
      }
    }
    expect(problems).toEqual([]);
  });
});
