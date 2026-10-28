import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Declaration, type Root, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { LANGUAGE_OPTIONS, type LanguageCode } from '../../i18n/locales.ts';

// Owner decision (2026-10-28): titles and display values track by script.
// Every rule on the title weight (weight-role-contract.test.ts) reads
// --title-letter-spacing, which is -0.02em for Latin, Cyrillic and Greek UI
// languages and 0 for Korean, Japanese, Chinese, Thai, the Indic scripts,
// Arabic, Urdu, Persian and Hebrew, chosen with :lang() on the document
// language. Every other negative letter-spacing in the app is 0; deliberate
// positive tracking stays (invite code and PIN digits, the code entry fields
// and small labels). The body kerns its text (font-kerning: normal), and the
// font shorthand only ever resets a control to inherit, so the kerning
// reaches every control that resets its font.
const TOKEN = '--title-letter-spacing';
const TOKEN_READ = `var(${TOKEN})`;
const TITLE_WEIGHT_READ = 'var(--font-weight-title)';
const LABEL_TRACKING_READ = 'var(--button-label-letter-spacing)';
const TIGHT = '-0.02em';
const FLAT = '0';

// Every app language, by the script of its UI text.
const SCRIPTS: Readonly<Record<string, { tracking: string; locales: readonly LanguageCode[] }>> = {
  Latin: {
    tracking: TIGHT,
    locales: [
      'en',
      'es',
      'pt-br',
      'fr',
      'de',
      'nl',
      'it',
      'pl',
      'tr',
      'id',
      'vi',
      'ms',
      'fil',
      'ro',
      'cs',
      'sv',
      'da',
      'nb',
      'fi',
      'hu',
    ],
  },
  Cyrillic: { tracking: TIGHT, locales: ['ru', 'uk', 'bg'] },
  Greek: { tracking: TIGHT, locales: ['el'] },
  Korean: { tracking: FLAT, locales: ['ko'] },
  Japanese: { tracking: FLAT, locales: ['ja'] },
  Chinese: { tracking: FLAT, locales: ['zh-hans', 'zh-hant'] },
  Thai: { tracking: FLAT, locales: ['th'] },
  Indic: { tracking: FLAT, locales: ['hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'pa'] },
  Arabic: { tracking: FLAT, locales: ['ar'] },
  Urdu: { tracking: FLAT, locales: ['ur'] },
  Persian: { tracking: FLAT, locales: ['fa'] },
  Hebrew: { tracking: FLAT, locales: ['he'] },
};

// Display values on the title weight that keep their own tracking: codes and
// digits are read one by one, so they never tighten. `null` sets none.
const OWN_TRACKING_TITLES: Readonly<Record<string, { tracking: string | null; reason: string }>> = {
  '.room-password-code': { tracking: '0.1em', reason: 'The PRO room PIN digits.' },
  '.room-password-code.is-placeholder': {
    tracking: '0.02em',
    reason: 'The PIN placeholder dashes before a PIN is set.',
  },
  '.invite-meta-value': { tracking: '0.1em', reason: "The header's invite code digits." },
  '.setup-join-input': {
    tracking: '0.12em',
    reason: "The invite code field: the host's code and the guest's code entry digits.",
  },
  '.dialog-input-segment': { tracking: '0.12em', reason: 'The room PIN entry digits.' },
  '.dialog-input-separator': {
    tracking: null,
    reason: 'The hyphen between the PIN entry halves.',
  },
  '.sync-col-value': {
    tracking: FLAT,
    reason: 'The manual sync value, typed digits; its tracking is 0 like every other negative.',
  },
};

// The titles the owner named, in the mobile and desktop rules.
const NAMED_TITLES = [
  'css/style.css .tab-title',
  'css/style.css .track-title',
  'css/style.css .chat-drawer-title',
  'css/style.css .dialog-title',
  'css/style.css .section-title',
  'css/style.css .ob-title',
  'css/style.css .setup-header-text h2',
  'css/style.css .desktop-step-header h2',
  'css/desktop.css .tab-title',
  'css/desktop.css .chat-drawer-title',
  'css/desktop.css .track-title',
  'css/desktop.css .section-title',
];

// The only positive tracking in the app, by rule, with the reason.
const POSITIVE_TRACKING: Readonly<Record<string, { value: string; reason: string }>> = {
  'css/style.css .invite-code-value': { value: '0.1em', reason: 'Invite code digits.' },
  'css/style.css .room-password-code': { value: '0.1em', reason: 'Room PIN digits.' },
  'css/style.css .room-password-code.is-placeholder': {
    value: '0.02em',
    reason: 'The PIN placeholder dashes.',
  },
  'css/style.css .dialog-input-segment': { value: '0.12em', reason: 'Room PIN entry digits.' },
  'css/style.css .setup-code-label': {
    value: '0.05em',
    reason: 'The small uppercase label above the invite code.',
  },
  'css/style.css .setup-join-input': { value: '0.12em', reason: 'Invite code entry digits.' },
  'css/style.css .sync-col-label': {
    value: '0.3px',
    reason: 'The small manual sync field label.',
  },
  'css/style.css .invite-meta-label': {
    value: '0.1em',
    reason: "The header's small 'invite code' label.",
  },
  'css/style.css .invite-meta-value': {
    value: '0.1em',
    reason: "The header's invite code digits.",
  },
  'css/style.css .onboarding-diagnostics-action': {
    value: '0.06em',
    reason: 'The small monospace diagnostics actions.',
  },
};

// Tracking values any rule may set besides the title token and the listed
// positive tracking.
const NEUTRAL_TRACKING = new Set(['0', 'normal', 'inherit', LABEL_TRACKING_READ]);

const APP_SHEETS = [
  'css/style.css',
  'css/desktop.css',
  'css/rtl.css',
  'css/playback-actions.css',
  'css/pretendard.css',
] as const;

const read = (path: string): string => readFileSync(resolve(path), 'utf8');
const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();

interface Sheet {
  path: string;
  root: Root;
}

interface StyleRule {
  path: string;
  /** The whole selector list, whitespace collapsed. */
  selector: string;
  selectors: string[];
  /** The at-rules around the rule, outermost first. */
  context: string;
  rule: Rule;
}

const sheet = (path: string): Sheet => ({ path, root: parseCss(read(path)) });
const appSheets = APP_SHEETS.map(sheet);

/** The style blocks of an HTML page, as one sheet. */
function pageStyles(path: string): Sheet {
  const css = [...read(path).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)]
    .map((match) => match[1])
    .join('\n');
  return { path, root: parseCss(css) };
}

function styleRules(sheets: readonly Sheet[]): StyleRule[] {
  const rules: StyleRule[] = [];
  for (const { path, root } of sheets) {
    root.walkRules((rule) => {
      const atRules: string[] = [];
      for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
        if (parent.type !== 'atrule') continue;
        const atRule = parent as AtRule;
        if (/keyframes$/u.test(atRule.name)) return;
        atRules.unshift(`@${atRule.name} ${atRule.params}`);
      }
      const selectors = rule.selectors.map(normalize);
      rules.push({
        path,
        selector: selectors.join(', '),
        selectors,
        context: atRules.join(' > '),
        rule,
      });
    });
  }
  return rules;
}

const values = (rule: Rule, property: string): string[] =>
  rule.nodes
    .filter((node): node is Declaration => node.type === 'decl' && node.prop === property)
    .map((declaration) => normalize(declaration.value));

const ruleKey = ({ path, selector }: StyleRule): string => `${path} ${selector}`;

function findRule(rules: readonly StyleRule[], selector: string): StyleRule {
  const found = rules.filter((rule) => rule.selector === selector);
  expect(found.map(ruleKey), selector).toHaveLength(1);
  return found[0]!;
}

const isNegative = (value: string): boolean => /^-\d|^-\.\d/u.test(value);

/** Every place a sheet defines the title tracking token. */
function tokenDefinitions(sheets: readonly Sheet[]): Array<{ rule: StyleRule; value: string }> {
  return styleRules(sheets).flatMap((rule) =>
    values(rule.rule, TOKEN).map((value) => ({ rule, value })),
  );
}

const LANG_SELECTOR = /^(?:html|:root):lang\(([a-z]{2,3}(?:-[a-z0-9]+)*)\)$/iu;

/** The language ranges of the rule that flattens the token, from its selectors. */
function flatRanges(definition: { rule: StyleRule }): string[] {
  return definition.rule.selectors.map((selector) => {
    const range = LANG_SELECTOR.exec(selector)?.[1];
    expect(range, `${selector} is not one html:lang() selector`).toBeTruthy();
    return range!.toLowerCase();
  });
}

/** :lang() matching: a range matches its tag and every tag that extends it. */
const langMatches = (tag: string, range: string): boolean => {
  const lower = tag.toLowerCase();
  return lower === range || lower.startsWith(`${range}-`);
};

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name).replace(/\\/gu, '/');
    if (/\/__tests__$/u.test(path)) continue;
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

const appRules = styleRules(appSheets);
const titleRules = appRules.filter((rule) =>
  values(rule.rule, 'font-weight').includes(TITLE_WEIGHT_READ),
);

describe('title tracking contract', () => {
  it('defines the title tracking once on the root and flattens it by script', () => {
    const definitions = tokenDefinitions(appSheets);
    expect(definitions.map(({ rule, value }) => `${rule.path} ${rule.context} | ${value}`)).toEqual(
      [`css/style.css @layer base | ${TIGHT}`, `css/style.css @layer base | ${FLAT}`],
    );
    const [tight, flat] = definitions;
    expect(tight!.rule.selector).toBe(':root');
    const ranges = flatRanges(flat!);

    // Every app language belongs to one script, and the document language
    // picks the script's tracking.
    const classified = Object.values(SCRIPTS).flatMap(({ locales }) => locales);
    expect([...classified].sort()).toEqual(LANGUAGE_OPTIONS.map(({ code }) => code).sort());
    const wrong: string[] = [];
    for (const [script, { tracking, locales }] of Object.entries(SCRIPTS)) {
      for (const code of locales) {
        const { htmlLang } = LANGUAGE_OPTIONS.find((option) => option.code === code)!;
        const resolved = ranges.some((range) => langMatches(htmlLang, range)) ? FLAT : TIGHT;
        if (resolved !== tracking) wrong.push(`${script} ${code} (${htmlLang}): ${resolved}`);
      }
    }
    expect(wrong).toEqual([]);
    // No stale range.
    for (const range of ranges) {
      expect(
        LANGUAGE_OPTIONS.some(({ htmlLang }) => langMatches(htmlLang, range)),
        range,
      ).toBe(true);
    }
  });

  it('gives every title and display value rule the title tracking', () => {
    const failures: string[] = [];
    const used = new Set<string>();
    for (const rule of titleRules) {
      const tracking = values(rule.rule, 'letter-spacing');
      const own = OWN_TRACKING_TITLES[rule.selector];
      if (own) {
        used.add(rule.selector);
        const expected = own.tracking === null ? [] : [own.tracking];
        if (tracking.join() !== expected.join()) {
          failures.push(`${ruleKey(rule)}: ${tracking.join(' ')} (own tracking)`);
        }
        continue;
      }
      if (tracking.join() !== TOKEN_READ) failures.push(`${ruleKey(rule)}: ${tracking.join(' ')}`);
    }
    expect(failures).toEqual([]);
    expect(Object.keys(OWN_TRACKING_TITLES).filter((selector) => !used.has(selector))).toEqual([]);
    for (const { reason } of Object.values(OWN_TRACKING_TITLES)) {
      expect(reason.length).toBeGreaterThan(15);
    }

    // The owner's named titles, mobile and desktop, read the token.
    const readers = titleRules.filter((rule) =>
      values(rule.rule, 'letter-spacing').includes(TOKEN_READ),
    );
    for (const named of NAMED_TITLES) {
      const [path, ...selector] = named.split(' ');
      expect(
        readers.some((rule) => rule.path === path && rule.selectors.includes(selector.join(' '))),
        named,
      ).toBe(true);
    }

    // Only title rules read the token, and no other rule retracks a title.
    const titleSelectors = new Set(
      titleRules
        .filter((rule) => !(rule.selector in OWN_TRACKING_TITLES))
        .flatMap((rule) => rule.selectors),
    );
    const strays: string[] = [];
    for (const rule of appRules) {
      const tracking = values(rule.rule, 'letter-spacing');
      if (tracking.length === 0 || titleRules.includes(rule)) continue;
      if (tracking.includes(TOKEN_READ)) strays.push(`${ruleKey(rule)} reads the title tracking`);
      const shared = rule.selectors.filter((selector) => titleSelectors.has(selector));
      if (shared.length > 0) strays.push(`${ruleKey(rule)} retracks ${shared.join(', ')}`);
    }
    expect(strays).toEqual([]);
  });

  it('sets no negative letter-spacing and only the listed positive tracking in the app', () => {
    const violations: string[] = [];
    const used = new Set<string>();
    for (const rule of appRules) {
      for (const value of values(rule.rule, 'letter-spacing')) {
        const key = ruleKey(rule);
        if (value === TOKEN_READ && titleRules.includes(rule)) continue;
        if (NEUTRAL_TRACKING.has(value)) continue;
        const positive = POSITIVE_TRACKING[key];
        if (positive && positive.value === value && !isNegative(value)) {
          used.add(key);
          continue;
        }
        violations.push(`${key}: letter-spacing: ${value}`);
      }
    }
    expect(violations).toEqual([]);
    expect(Object.keys(POSITIVE_TRACKING).filter((key) => !used.has(key))).toEqual([]);
    for (const { reason } of Object.values(POSITIVE_TRACKING)) {
      expect(reason.length).toBeGreaterThan(10);
    }

    // No custom property carries a negative tracking for a rule to read.
    const tokens: string[] = [];
    for (const { path, root } of appSheets) {
      root.walkDecls(/^--.*(?:letter-spacing|tracking)/u, (declaration) => {
        tokens.push(`${path} ${declaration.prop}: ${normalize(declaration.value)}`);
      });
    }
    expect(tokens).toEqual([
      `css/style.css ${TOKEN}: ${TIGHT}`,
      `css/style.css --button-label-letter-spacing: normal`,
      `css/style.css ${TOKEN}: ${FLAT}`,
    ]);

    // Markup and TypeScript set no tracking of their own.
    expect(read('index.html')).not.toMatch(/letter-spacing/u);
    const scripted = sourceFiles('src').filter((path) => /letter-?spacing/iu.test(read(path)));
    expect(scripted).toEqual([]);
  });

  it('kerns the body text and sets kerning nowhere else', () => {
    const kerning = appRules.flatMap((rule) =>
      values(rule.rule, 'font-kerning').map(
        (value) => `${ruleKey(rule)} ${rule.context} | ${value}`,
      ),
    );
    expect(kerning).toEqual(['css/style.css body @layer base | normal']);
  });

  it('puts the code entry digits on the title weight, like the invite code', () => {
    // Orchestrator decision (2026-10-28): the guest's invite code entry, the
    // room PIN entry and the manual sync value are display values.
    for (const selector of [
      '.setup-join-input',
      '.dialog-input-segment',
      '.dialog-input-separator',
      '.sync-col-value',
    ]) {
      expect(values(findRule(appRules, selector).rule, 'font-weight'), selector).toEqual([
        TITLE_WEIGHT_READ,
      ]);
    }
    // The host's read-only code no longer needs its own weight rule.
    expect(appRules.filter((rule) => rule.selector === '.setup-join-input[readonly]')).toEqual([]);
  });
});

describe('design-system title tracking mirror', () => {
  const tokenSheet = sheet('public/designsystem/colors_and_type.css');
  const tokenRules = styleRules([tokenSheet]);
  const editorial = sheet('public/editorial-design.css');
  const editorialRules = styleRules([editorial]);
  const kitRules = styleRules([sheet('browser/ui-kit/static/app/app.css')]);
  const previewDirectory = 'public/designsystem/preview';
  const previews = readdirSync(resolve(previewDirectory))
    .filter((name) => name.endsWith('.html'))
    .map((name) => pageStyles(`${previewDirectory}/${name}`));
  const previewRules = styleRules(previews);

  it('mirrors the token, its script overrides and the body kerning in the token sheet', () => {
    const app = tokenDefinitions(appSheets);
    const mirror = tokenDefinitions([tokenSheet]);
    expect(mirror.map(({ rule, value }) => `${rule.selector} | ${value}`)).toEqual([
      `:root | ${TIGHT}`,
      `${mirror[1]?.rule.selector} | ${FLAT}`,
    ]);
    expect(flatRanges(mirror[1]!).sort()).toEqual(flatRanges(app[1]!).sort());
    expect(values(findRule(tokenRules, 'body').rule, 'font-kerning')).toEqual(['normal']);
  });

  it('keeps the title samples on the title tracking and the app samples off negative tracking', () => {
    // The token sheet's type helpers read the role tokens; codes keep their
    // positive tracking.
    for (const selector of ['.tab-title, .type-display', '.type-h2', '.track-title, .type-title']) {
      const rule = findRule(tokenRules, selector).rule;
      expect(values(rule, 'font-weight'), selector).toEqual([TITLE_WEIGHT_READ]);
      expect(values(rule, 'letter-spacing'), selector).toEqual([TOKEN_READ]);
    }
    expect(
      tokenRules.flatMap((rule) =>
        values(rule.rule, 'letter-spacing')
          .filter(isNegative)
          .map((value) => `${rule.selector}: ${value}`),
      ),
    ).toEqual([]);
    expect(read('public/designsystem/colors_and_type.css')).not.toMatch(/--ls-tight/u);

    // The design page's samples of app titles and display values.
    for (const selector of [
      '.spec .s28',
      '.spec .s24',
      '.spec .s20',
      '.dialog-title',
      '.range-slider-header strong',
      '.range-eq-value',
    ]) {
      expect(values(findRule(editorialRules, selector).rule, 'letter-spacing'), selector).toEqual([
        TOKEN_READ,
      ]);
    }
    // Negative tracking stays only on the design page's own editorial
    // headings and specimens, which are not app samples.
    const editorialChrome = [
      '.theme-palette-title',
      '.palette-text strong, .palette-text code',
      '.palette-band strong',
      '.display-glyph',
      '.weight-row .gl',
      '.embed h3',
    ];
    expect(
      editorialRules
        .filter((rule) => values(rule.rule, 'letter-spacing').some(isNegative))
        .map((rule) => rule.selector),
    ).toEqual(editorialChrome);

    // The preview cards.
    for (const [path, selector] of [
      ['public/designsystem/preview/type-scale.html', '.s28'],
      ['public/designsystem/preview/type-scale.html', '.s24'],
      ['public/designsystem/preview/type-scale.html', '.s20'],
      ['public/designsystem/preview/toast-dialog.html', '.dtitle'],
      ['public/designsystem/preview/section-group.html', '.title'],
      ['public/designsystem/preview/type-family.html', '.display'],
    ] as const) {
      const rule = findRule(
        previewRules.filter((entry) => entry.path === path),
        selector,
      ).rule;
      expect(values(rule, 'font-weight'), `${path} ${selector}`).toEqual([TITLE_WEIGHT_READ]);
      expect(values(rule, 'letter-spacing'), `${path} ${selector}`).toEqual([TOKEN_READ]);
    }
    expect(
      previewRules
        .filter((rule) => values(rule.rule, 'letter-spacing').some(isNegative))
        .map(ruleKey),
    ).toEqual(['public/designsystem/preview/type-weights.html .sp']);

    // The UI kit's titles read the token with the production value as a
    // fallback, and its invite code keeps its positive tracking.
    const kitFallback = `var(${TOKEN}, ${TIGHT})`;
    const kitTitles = kitRules.filter((rule) =>
      values(rule.rule, 'font-weight').some((value) => value.startsWith('var(--font-weight-title')),
    );
    expect(
      kitTitles.map((rule) => `${rule.selector} | ${values(rule.rule, 'letter-spacing').join()}`),
    ).toEqual([
      `.mq-title | ${kitFallback}`,
      `.mq-card-hdr h3 | ${kitFallback}`,
      `.mq-track .title | ${kitFallback}`,
      `.mq-setting-header h3 | ${kitFallback}`,
      '.mq-invite .code | 0.12em',
    ]);
    expect(kitRules.filter((rule) => values(rule.rule, 'letter-spacing').some(isNegative))).toEqual(
      [],
    );
  });
});
