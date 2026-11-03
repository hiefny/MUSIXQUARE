import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Node, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// Owner decision (2026-11-03, the input system): every text field in the app
// is one quiet underline field. Fields differ only by size step:
//   - display L, the start-screen invite code: 32 / 700, 24 on a 32px line at
//     359px wide or less for the join code only (the host's read-only code has
//     no clear button and keeps 32px), box 56;
//   - display M, values in dialogs and panels (PIN halves, manual sync):
//     24 / 700 on a 32px line, boxes 50;
//   - entry, typed text (nickname, YouTube, message): 16 / 400 on a 20px line,
//     so no field is below 16px.
// Labels above a field are 13 / 600 --text-sub in sentence case at normal
// tracking. The one line under a field (the setup code line, the dialog hint
// and the YouTube status line) is 12px on an 18px line, 8px under the field:
// hints 400 --text-sub, progress, result and error lines 600, errors the one
// danger red. The underline is --surface-3 at rest and --primary on focus,
// the only focus mark; a wrong value turns it --danger-foreground. In Windows
// forced colours, where red is not shown, a wrong value thickens the edge.
// The rules read existing roles only: no new token, palette or component.

const SHEET_PATHS = [
  'css/style.css',
  'css/desktop.css',
  'css/rtl.css',
  'css/playback-actions.css',
] as const;
const APP = 'css/style.css';
const BASE = '@layer base';
const COMPONENTS = '@layer components';
const FORCED = '@media (forced-colors: active)';
const NARROW = `${BASE} > @media (max-width: 359px)`;

// The values a pinned rule may read through var(): the roles the field family
// is built from.
const ALLOWED_VARS = new Set([
  '--text-main',
  '--text-sub',
  '--text-muted',
  '--surface-3',
  '--primary',
  '--danger-foreground',
  '--font-weight-title',
  '--font-weight-selected',
  '--font-weight-unselected',
  '--font-weight-label',
  '--font-weight-body',
]);

const LINE = ':is(.setup-inline-error, .dialog-hint, .yt-preview-meta)';
const LINE_ERROR = ':is(.setup-inline-error, .dialog-hint.error, .yt-preview-meta.error)';
const LINE_CENTRED = ':is(.setup-inline-error, .dialog-input-split + .dialog-hint)';
const JOIN_NARROW = '.setup-join-input:not(.yt-intro-text):not([readonly])';
const SYNC_INVALID = ".sync-manual-input-wrapper:has([aria-invalid='true'])";
const ENTRY_LINE = '.chat-input:not(.sync-manual-input)';
const FORCED_INVALID =
  ":is(input:not([type='range']):not([type='hidden']), [contenteditable='true'], [role='textbox'], [role='combobox'])[aria-invalid='true']";
const FORCED_FIELDS =
  ":is(input:not([type='range']):not([type='hidden']), textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox'], [role='combobox'])";
const HALF_TEXT = 'color-mix(in srgb, var(--text-main) 50%, transparent)';
const YOUTUBE_STATUS_WEIGHT =
  ".yt-preview-meta:is([data-i18n='youtube.searching'], [data-i18n='youtube.fetching_info'], [data-i18n='youtube.search_no_results'], [data-i18n='youtube.invalid_link'], [data-i18n='youtube.search_failed'], [data-i18n='youtube.fetch_failed'])";

const read = (path: string): string => readFileSync(resolve(path), 'utf8');
const collapse = (value: string): string => value.replace(/\s+/gu, ' ').trim();
const normalizeSelector = (selector: string): string =>
  collapse(selector).replace(/\(\s+/gu, '(').replace(/\s+\)/gu, ')');

interface FoundRule {
  path: string;
  selectors: string[];
  /** The at-rules around the rule, outermost first; '' when unlayered. */
  context: string;
  /** Source order across the four sheets. */
  index: number;
  declarations: Record<string, string>;
  rule: Rule;
}

function contextOf(node: Node): string | null {
  const atRules: string[] = [];
  for (let parent = node.parent; parent && parent.type !== 'root'; parent = parent.parent) {
    if (parent.type !== 'atrule') continue;
    const atRule = parent as AtRule;
    if (/keyframes$/u.test(atRule.name)) return null;
    atRules.unshift(`@${atRule.name} ${collapse(atRule.params)}`);
  }
  return atRules.join(' > ');
}

const RULES: FoundRule[] = [];
for (const path of SHEET_PATHS) {
  parseCss(read(path)).walkRules((rule) => {
    const context = contextOf(rule);
    if (context === null) return;
    const declarations: Record<string, string> = {};
    rule.each((node) => {
      if (node.type !== 'decl') return;
      declarations[node.prop] = `${collapse(node.value)}${node.important ? ' !important' : ''}`;
    });
    RULES.push({
      path,
      selectors: rule.selectors.map(normalizeSelector),
      context,
      index: RULES.length,
      declarations,
      rule,
    });
  });
}

const describeRule = (found: FoundRule): string =>
  `${found.path}:${found.rule.source?.start?.line ?? '?'} ${found.context || '(unlayered)'} | ${found.selectors.join(', ')}`;

function rulesFor(selector: string, context?: string, path: string = APP): FoundRule[] {
  return RULES.filter(
    (found) =>
      found.path === path &&
      found.selectors.includes(selector) &&
      (context === undefined || found.context === context),
  );
}

/** The one rule with this selector in this context. */
function theRule(selector: string, context: string): FoundRule {
  const found = rulesFor(selector, context);
  expect(found.map(describeRule), `${context} ${selector}`).toHaveLength(1);
  return found[0]!;
}

function pick(found: FoundRule, properties: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(properties.map((property) => [property, found.declarations[property]]));
}

/** Drop the arguments of :not(...): a negated class does not style that class. */
function withoutNegations(selector: string): string {
  let result = '';
  for (let index = 0; index < selector.length; index += 1) {
    if (!selector.startsWith(':not(', index)) {
      result += selector[index];
      continue;
    }
    index = closingParen(selector, index + 4);
  }
  return result;
}

function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length - 1;
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of list) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

type Specificity = [number, number, number];

const higher = (left: Specificity, right: Specificity): boolean =>
  left[0] !== right[0]
    ? left[0] > right[0]
    : left[1] !== right[1]
      ? left[1] > right[1]
      : left[2] > right[2];

const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/** Selectors Level 4 specificity, enough for the selectors this contract reads. */
function specificity(selector: string): Specificity {
  const total: Specificity = [0, 0, 0];
  const identEnd = (from: number): number => {
    let index = from;
    while (index < selector.length && /[\w-]/u.test(selector[index]!)) index += 1;
    return index;
  };
  let index = 0;
  while (index < selector.length) {
    const character = selector[index]!;
    if (character === '#') {
      total[0] += 1;
      index = identEnd(index + 1);
    } else if (character === '.') {
      total[1] += 1;
      index = identEnd(index + 1);
    } else if (character === '[') {
      total[1] += 1;
      index = selector.indexOf(']', index) + 1;
    } else if (character === ':' && selector[index + 1] === ':') {
      total[2] += 1;
      index = identEnd(index + 2);
      if (selector[index] === '(') index = closingParen(selector, index) + 1;
    } else if (character === ':') {
      const end = identEnd(index + 1);
      const name = selector.slice(index + 1, end).toLowerCase();
      if (selector[end] === '(') {
        const close = closingParen(selector, end);
        if (['is', 'not', 'has', 'matches'].includes(name)) {
          let max: Specificity = [0, 0, 0];
          for (const argument of splitTopLevel(selector.slice(end + 1, close))) {
            const candidate = specificity(argument);
            if (higher(candidate, max)) max = candidate;
          }
          total[0] += max[0];
          total[1] += max[1];
          total[2] += max[2];
        } else if (name !== 'where') total[1] += 1;
        index = close + 1;
      } else {
        if (LEGACY_PSEUDO_ELEMENTS.has(name)) total[2] += 1;
        else total[1] += 1;
        index = end;
      }
    } else if (/[a-z]/iu.test(character)) {
      total[2] += 1;
      index = identEnd(index);
    } else index += 1;
  }
  return total;
}

const LINE_CLASS = /\.(?:setup-inline-error|dialog-hint|yt-preview-meta)(?![\w-])/u;
const TYPE_PROPERTY =
  /^(?:font|font-size|font-weight|line-height|color|margin(?:-(?:top|bottom|left|right|block|inline)(?:-(?:start|end))?)?)$/u;

describe('one field family (owner decision 2026-11-03)', () => {
  it('draws the line under every field from one shared rule', () => {
    expect(theRule(LINE, BASE).declarations).toEqual({
      margin: '8px 0 0',
      'padding-inline': '4px',
      color: 'var(--text-sub)',
      'font-size': '12px',
      'font-weight': 'var(--font-weight-body)',
      'line-height': '18px',
      'letter-spacing': 'normal',
      'text-align': 'start',
      'white-space': 'pre-line',
      'word-break': 'keep-all',
      'overflow-wrap': 'anywhere',
      transition: 'color 0.2s ease',
    });
  });

  it('turns an error line red at the label weight', () => {
    const shared = theRule(LINE, BASE);
    const error = theRule(LINE_ERROR, BASE);
    expect(error.declarations).toEqual({
      color: 'var(--danger-foreground)',
      'font-weight': 'var(--font-weight-label)',
    });
    expect(higher(specificity(LINE_ERROR), specificity(LINE))).toBe(true);
    expect(error.index).toBeGreaterThan(shared.index);
  });

  it('centres the line under a code or a PIN and keeps one dialog line of space', () => {
    const shared = theRule(LINE, BASE);
    expect(theRule(LINE_CENTRED, BASE).declarations).toEqual({
      'padding-inline': '0',
      'text-align': 'center',
    });
    expect(higher(specificity(LINE_CENTRED), specificity(LINE))).toBe(true);
    expect(theRule('.dialog-hint', BASE).declarations).toEqual({ 'min-height': '18px' });
    expect(rulesFor('.dialog-hint').map(describeRule)).toHaveLength(1);
    expect(theRule('.setup-inline-error', BASE).declarations).toEqual({ width: '100%' });
    expect(theRule('.setup-inline-error', BASE).index).toBeGreaterThan(shared.index);
  });

  it('lets no other rule restyle the size, line, colour, weight or margin of the line', () => {
    const styling = RULES.filter((found) =>
      Object.keys(found.declarations).some((property) => TYPE_PROPERTY.test(property)),
    ).flatMap((found) =>
      found.selectors
        .filter((selector) => LINE_CLASS.test(withoutNegations(selector)))
        .map((selector) => `${found.path} ${found.context} | ${selector}`),
    );
    // Source order: the base rules, then the components rules.
    expect(styling).toEqual([
      `${APP} ${BASE} | ${LINE}`,
      `${APP} ${BASE} | ${LINE_ERROR}`,
      `${APP} ${BASE} | .setup-auto-join-area .setup-inline-error`,
      `${APP} ${COMPONENTS} | .setup-join-area > .yt-preview-meta`,
      `${APP} ${COMPONENTS} | ${YOUTUBE_STATUS_WEIGHT}`,
    ]);
    expect(theRule('.setup-auto-join-area .setup-inline-error', BASE).declarations).toEqual({
      'margin-top': '0',
    });
    // The YouTube stack keeps its 10px gap; the line moves up 2px to sit 8px
    // under the underline like every other line.
    expect(theRule('.setup-join-area > .yt-preview-meta', COMPONENTS).declarations).toEqual({
      'margin-top': '-2px',
    });
    expect(theRule('.setup-join-area', BASE).declarations.gap).toBe('10px');
    expect(theRule(YOUTUBE_STATUS_WEIGHT, COMPONENTS).declarations).toEqual({
      'font-weight': 'var(--font-weight-label)',
    });
    // The old components rule (11px, a 4px margin) is gone.
    expect(rulesFor('.yt-preview-meta').map(describeRule)).toEqual([]);
  });

  it('breaks the line between any two characters in Japanese and Chinese', () => {
    const cjk = theRule('html:lang(ja) .dialog-message', BASE);
    for (const lang of ['ja', 'zh-Hans', 'zh-Hant']) {
      for (const line of ['.setup-inline-error', '.dialog-hint', '.yt-preview-meta']) {
        const selector = `html:lang(${lang}) ${line}`;
        expect(cjk.selectors, selector).toContain(selector);
        expect(higher(specificity(selector), specificity(LINE)), selector).toBe(true);
      }
    }
    expect(pick(cjk, ['word-break', 'overflow-wrap', 'line-break'])).toEqual({
      'word-break': 'normal',
      'overflow-wrap': 'anywhere',
      'line-break': 'strict',
    });
  });

  it('sets the display steps: the start-screen code and the values in dialogs and panels', () => {
    expect(
      pick(theRule('.setup-join-input', BASE), [
        'padding',
        'font-size',
        'font-weight',
        'letter-spacing',
        'font-variant-numeric',
        'transition',
      ]),
    ).toEqual({
      padding: '8px 0',
      'font-size': '32px',
      'font-weight': 'var(--font-weight-title)',
      'letter-spacing': '0.12em',
      'font-variant-numeric': 'tabular-nums',
      transition: 'border-bottom-color 0.2s ease',
    });

    // At 359px wide or less six join digits fit beside the clear button; the
    // box stays 56px (11 + 32 + 11 + 2). The host's read-only code keeps 32px.
    const narrow = RULES.filter(
      (found) =>
        found.context === NARROW &&
        found.selectors.some((selector) => selector.includes('.setup-join-input')),
    );
    expect(narrow.map(describeRule)).toHaveLength(1);
    expect(narrow[0]!.selectors).toEqual([JOIN_NARROW]);
    expect(narrow[0]!.declarations).toEqual({
      'padding-block': '11px',
      'font-size': '24px',
      'line-height': '32px',
    });
    const hostReaching = RULES.filter(
      (found) => found.context !== BASE || !found.selectors.includes('.setup-join-input'),
    )
      .filter((found) => 'font-size' in found.declarations)
      .flatMap((found) =>
        found.selectors
          .filter((selector) =>
            /\.setup-join-input(?![\w-])|#setup-code(?![\w-])|\.code-input-active(?![\w-])/u.test(
              selector,
            ),
          )
          .filter((selector) => !selector.includes(':not([readonly])'))
          .map((selector) => `${describeRule(found)} -> ${selector}`),
      );
    expect(hostReaching).toEqual([]);

    expect(
      pick(theRule('.dialog-input-segment', BASE), [
        'padding',
        'font-size',
        'font-weight',
        'line-height',
        'letter-spacing',
      ]),
    ).toEqual({
      padding: '8px 4px',
      'font-size': '24px',
      'font-weight': 'var(--font-weight-title)',
      'line-height': '32px',
      'letter-spacing': '0.12em',
    });
    expect(
      pick(theRule('.dialog-input-separator', BASE), [
        'color',
        'font-size',
        'line-height',
        'transform',
      ]),
    ).toEqual({
      color: 'var(--text-muted)',
      'font-size': '24px',
      'line-height': '32px',
      transform: 'translateY(4px)',
    });
    expect(
      pick(theRule('.sync-col-value', BASE), ['font-size', 'font-weight', 'line-height']),
    ).toEqual({
      'font-size': '24px',
      'font-weight': 'var(--font-weight-title)',
      'line-height': '32px',
    });
  });

  it('sets the entry step: typed text at 16px on a 20px line, nothing smaller', () => {
    expect(
      pick(theRule('.dialog-input', BASE), ['padding', 'font-size', 'font-weight', 'line-height']),
    ).toEqual({
      padding: '12px 4px',
      'font-size': '16px',
      'font-weight': 'var(--font-weight-body)',
      'line-height': '20px',
    });
    expect(
      pick(theRule('.yt-search-input-wrapper .yt-intro-text', COMPONENTS), [
        'padding',
        'font-size',
        'font-weight',
        'line-height',
        'font-variant-numeric',
      ]),
    ).toEqual({
      padding: '12px 4px 10px',
      'font-size': '16px',
      'font-weight': 'var(--font-weight-body)',
      'line-height': '20px',
      'font-variant-numeric': 'normal',
    });
    // The message composer and its command ghost text share the 20px line;
    // the manual sync value shares .chat-input and keeps its display line.
    const composer = theRule(ENTRY_LINE, BASE);
    expect(composer.selectors).toEqual([ENTRY_LINE, '.chat-cmd-ghost']);
    expect(composer.declarations).toEqual({ 'line-height': '20px' });
    expect(composer.index).toBeGreaterThan(theRule('.chat-input', BASE).index);

    // No entry field is below 16px, so iOS never zooms on focus.
    const belowEntry = (found: FoundRule): boolean => {
      const size = /^(\d+(?:\.\d+)?)px$/u.exec(found.declarations['font-size'] ?? '');
      return !size || Number(size[1]) < 16;
    };
    const small = RULES.filter(
      (found) => 'font-size' in found.declarations && belowEntry(found),
    ).flatMap((found) =>
      found.selectors
        .filter((selector) => !selector.includes('::'))
        .filter((selector) =>
          /\.(?:dialog-input|yt-intro-text|chat-input)(?![\w-])/u.test(withoutNegations(selector)),
        )
        .map((selector) => `${describeRule(found)} -> ${selector}`),
    );
    expect(small).toEqual([]);
  });

  it('labels a field in sentence case at 13 / 600 --text-sub', () => {
    expect(pick(theRule('.setup-code-label', BASE), ['font-size', 'font-weight', 'color'])).toEqual(
      {
        'font-size': '13px',
        'font-weight': 'var(--font-weight-label)',
        color: 'var(--text-sub)',
      },
    );
    const dressed = RULES.filter((found) =>
      found.selectors.some((selector) => /\.setup-code-label(?![\w-])/u.test(selector)),
    ).flatMap((found) =>
      ['text-transform', 'letter-spacing', 'opacity']
        .filter((property) => property in found.declarations)
        .map((property) => `${describeRule(found)} { ${property} }`),
    );
    expect(dressed).toEqual([]);
    expect(theRule('.sync-col-label', BASE).declarations).toEqual({
      'font-size': '13px',
      'font-weight': 'var(--font-weight-label)',
      color: 'var(--text-sub)',
      'letter-spacing': 'normal',
    });
    // The label sits 8px above the field, through the display's flex gap.
    expect(theRule('.sync-manual-display', BASE).declarations.gap).toBe('8px');
  });

  it('fades the manual sync placeholder like the start-screen code placeholder', () => {
    const placeholder = theRule('.sync-manual-input:empty::before', BASE);
    expect(placeholder.declarations).toEqual({ opacity: '0.3' });
    expect(theRule('.setup-join-input::placeholder', BASE).declarations.opacity).toBe('0.3');
    for (const shared of rulesFor('.chat-input:empty::before', BASE)) {
      expect(placeholder.index, describeRule(shared)).toBeGreaterThan(shared.index);
      expect(
        higher(specificity('.chat-input:empty::before'), specificity(placeholder.selectors[0]!)),
      ).toBe(false);
    }
  });

  it('turns the underline red for a wrong value and fades a disabled code once', () => {
    const invalid = theRule(SYNC_INVALID, BASE);
    const focused = theRule('.chat-input-wrapper:focus-within', BASE);
    expect(invalid.declarations).toEqual({ 'border-bottom-color': 'var(--danger-foreground)' });
    // Equal specificity: the red follows the focus blue in source order.
    expect(higher(specificity('.chat-input-wrapper:focus-within'), specificity(SYNC_INVALID))).toBe(
      false,
    );
    expect(invalid.index).toBeGreaterThan(focused.index);

    // Joining: the digits fade once (iOS WebKit dims disabled fields itself).
    expect(theRule('.setup-join-input:disabled', BASE).declarations).toEqual({
      opacity: '1',
      color: HALF_TEXT,
      '-webkit-text-fill-color': HALF_TEXT,
    });
    // The dialog fields keep their own invalid rules.
    expect(theRule('.dialog-input.invalid', BASE).declarations).toEqual({
      'border-bottom-color': 'var(--danger-foreground)',
    });
    expect(theRule('.dialog-input-split.invalid .dialog-input-segment', BASE).declarations).toEqual(
      { 'border-bottom-color': 'var(--danger-foreground)' },
    );
  });

  it('makes the blue underline the only focus mark and draws button rings inside', () => {
    const segmentFocus = theRule('.dialog-input-segment:focus-visible', BASE);
    expect(segmentFocus.declarations).toEqual({ outline: 'none' });
    expect(
      higher(specificity('.dialog-input-segment:focus-visible'), specificity(':focus-visible')),
    ).toBe(true);
    expect(theRule(':focus-visible', BASE).declarations.outline).toBe('2px solid var(--primary)');
    expect(theRule('.clearable-editor-button:focus-visible', BASE).declarations).toEqual({
      color: 'var(--text-main)',
      outline: '2px solid var(--primary)',
      'outline-offset': '-2px',
    });
    expect(theRule('.chat-send-btn:focus-visible', BASE).declarations).toEqual({
      outline: '2px solid var(--primary)',
      'outline-offset': '-2px',
    });
  });

  it('thickens a wrong field to a 2px edge in Windows forced colours', () => {
    const fields = theRule(FORCED_FIELDS, FORCED);
    const invalid = theRule(FORCED_INVALID, FORCED);
    expect(fields.declarations.outline).toBe('1px solid CanvasText');
    expect(invalid.declarations).toEqual({ 'outline-width': '2px' });
    expect(specificity(FORCED_INVALID)).toEqual([0, 3, 1]);
    expect(specificity(FORCED_FIELDS)).toEqual([0, 2, 1]);
    expect(invalid.index).toBeGreaterThan(fields.index);
  });

  it('reads only the existing roles in the rules it pins', () => {
    const pinned: Array<[string, string]> = [
      [LINE, BASE],
      [LINE_ERROR, BASE],
      [LINE_CENTRED, BASE],
      ['.dialog-hint', BASE],
      ['.setup-inline-error', BASE],
      ['.setup-join-input', BASE],
      ['.setup-join-input:disabled', BASE],
      [JOIN_NARROW, NARROW],
      ['.dialog-input', BASE],
      ['.dialog-input-segment', BASE],
      ['.dialog-input-segment:focus-visible', BASE],
      ['.dialog-input-separator', BASE],
      [ENTRY_LINE, BASE],
      ['.chat-send-btn:focus-visible', BASE],
      ['.clearable-editor-button:focus-visible', BASE],
      ['.setup-code-label', BASE],
      ['.sync-col-label', BASE],
      ['.sync-col-value', BASE],
      [SYNC_INVALID, BASE],
      ['.sync-manual-input:empty::before', BASE],
      ['.yt-search-input-wrapper .yt-intro-text', COMPONENTS],
      ['.setup-join-area > .yt-preview-meta', COMPONENTS],
      [FORCED_INVALID, FORCED],
    ];
    const strays: string[] = [];
    for (const [selector, context] of pinned) {
      const found = theRule(selector, context);
      for (const [property, value] of Object.entries(found.declarations)) {
        for (const match of value.matchAll(/var\(\s*(--[\w-]+)/gu)) {
          if (!ALLOWED_VARS.has(match[1]!))
            strays.push(`${describeRule(found)} ${property}: ${value}`);
        }
        if (property.startsWith('--')) strays.push(`${describeRule(found)} defines ${property}`);
      }
    }
    expect(strays).toEqual([]);
  });
});
