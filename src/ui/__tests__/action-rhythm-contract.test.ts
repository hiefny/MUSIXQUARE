/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Node, type Root, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// Owner decision (2026-10-27): action pills that sit next to or below each
// other keep 12px between their painted surfaces, and every action pill is
// 56px tall, in dialogs, on the play tab and on the setup screens. Spacing is
// a recipe rather than an exported root token (see the design-system page's
// component token note), so this contract binds the equal values instead of
// a shared custom property. Change them together or not at all.
const ACTION_GAP = '12px';
const PILL_HEIGHT = '56px';

// Role=dialog surfaces in index.html whose actions deliberately stay outside
// the shared rhythm, with the reason. The scan below fails on any other
// surface without a checked action row, and on a stale entry here.
const OUTSIDE_RHYTHM: Readonly<Record<string, string>> = {
  'manual-sync-overlay':
    'The manual sync panel is a compact tool panel. Its Reset / Done pair ' +
    '(52px, 8px apart) follows the 44px nudge chips and 8px rows above it; ' +
    'the 2026-10-27 rhythm covers the account, move/copy and confirm dialogs.',
};

const read = (path: string): string => readFileSync(resolve(path), 'utf8');
const appCss = parseCss(read('css/style.css'));
const playCss = parseCss(read('css/playback-actions.css'));
// css/app.css imports these four files; together they are the app stylesheet.
const appSheets = [
  appCss,
  parseCss(read('css/desktop.css')),
  parseCss(read('css/rtl.css')),
  playCss,
];
const SHORT_SCREEN = '@media (max-height: 350px)';

function inlineStyles(path: string): Root {
  const styles = [...read(path).matchAll(/<style>([\s\S]*?)<\/style>/gu)].map((match) => match[1]);
  expect(styles.length, `${path} has no inline styles`).toBeGreaterThan(0);
  return parseCss(styles.join('\n'));
}

/** The nearest conditional at-rule around a node; cascade layers apply everywhere. */
function conditionOf(node: Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== 'atrule') continue;
    const atRule = parent as AtRule;
    if (atRule.name !== 'layer') return `@${atRule.name} ${atRule.params}`;
  }
  return null;
}

/** Values of `property` in rules that list `selector` itself and apply at every viewport. */
function baseValues(root: Root, selector: string, property: string): string[] {
  const values: string[] = [];
  root.walkRules((rule) => {
    if (!rule.selectors.includes(selector) || conditionOf(rule) !== null) return;
    rule.each((node) => {
      if (node.type === 'decl' && node.prop === property) values.push(node.value);
    });
  });
  return values;
}

function baseValue(root: Root, selector: string, property: string): string | undefined {
  const values = baseValues(root, selector, property);
  expect(new Set(values).size, `${selector} declares ${property} in conflicting ways`).toBe(
    values.length > 0 ? 1 : 0,
  );
  return values[0];
}

function appMarkup(): Document {
  return new DOMParser().parseFromString(read('index.html'), 'text/html');
}

/**
 * Every `property` value that the app stylesheet applies to `element` from
 * rules whose condition is `condition` (null: every viewport), in any cascade
 * layer and through any selector shape, including descendant overrides and
 * one-off utility classes. Rules under `:root[dir='rtl']` are checked in a
 * second right-to-left pass. Rules gated on runtime-only classes or states
 * (keyboard-open, :hover) do not match the static markup and are not seen.
 */
function appliedValues(
  element: Element,
  properties: readonly string[],
  condition: string | null = null,
): string[] {
  const root = element.ownerDocument.documentElement;
  const direction = root.getAttribute('dir');
  const values = new Set<string>();
  try {
    for (const dir of ['ltr', 'rtl']) {
      root.setAttribute('dir', dir);
      for (const sheet of appSheets) {
        sheet.walkRules((rule) => {
          if (conditionOf(rule) !== condition) return;
          const declarations = rule.nodes.filter(
            (node) => node.type === 'decl' && properties.includes(node.prop),
          );
          if (declarations.length === 0) return;
          // Pseudo-element rules style generated boxes, not the action itself.
          const matches = rule.selectors.some(
            (selector) => !selector.includes('::') && element.matches(selector),
          );
          if (!matches) return;
          for (const node of declarations) {
            if (node.type === 'decl') values.add(`${node.prop}: ${node.value}`);
          }
        });
      }
    }
  } finally {
    if (direction === null) root.removeAttribute('dir');
    else root.setAttribute('dir', direction);
  }
  return [...values];
}

function describeElement(element: Element): string {
  return element.id
    ? `#${element.id}`
    : `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`;
}

function pixels(value: string): number {
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(value.trim());
  expect(match, `${value} is not a pixel length`).not.toBeNull();
  return Number(match![1]);
}

describe('action pill rhythm contract', () => {
  it('keeps one gap between action pills in dialogs, on the play tab and on setup', () => {
    expect({
      dialogActions: baseValue(appCss, '.adaptive-action-group', 'gap'),
      // The signed-out account view stacks the Google pill and Close without
      // a flex group, so the close action's top margin is that surface gap.
      signedOutClose: baseValue(appCss, '.account-dialog-login-close', 'margin-top'),
      playActionRow: baseValue(playCss, '.play-actions-row', '--play-action-gap'),
      playSecondaryArea: baseValue(appCss, '.play-secondary-area', 'gap'),
      setupActions: baseValue(appCss, '.ob-actions', 'gap'),
      setupActionsWithBack: baseValue(appCss, '.ob-actions.horizontal-with-back', 'gap'),
    }).toEqual({
      dialogActions: ACTION_GAP,
      signedOutClose: ACTION_GAP,
      playActionRow: ACTION_GAP,
      playSecondaryArea: ACTION_GAP,
      setupActions: ACTION_GAP,
      setupActionsWithBack: ACTION_GAP,
    });
  });

  it('resolves the shared gap on every action row in the markup, utility classes included', () => {
    // A later layer or a one-off utility class on the row must not reopen a
    // different gap: every unconditional gap the row receives is the shared
    // one. The first-screen host / join stack (.ob-actions.vertical, 16px) is
    // added at runtime and stays the owner-tuned exception.
    const rows = [
      ...appMarkup().querySelectorAll(':is(.adaptive-action-group, .dialog-actions, .ob-actions)'),
    ];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const gaps = appliedValues(row, ['gap', 'row-gap', 'column-gap']);
      expect(gaps, `${describeElement(row)} has no gap`).not.toHaveLength(0);
      expect(
        gaps.filter((gap) => !gap.endsWith(`: ${ACTION_GAP}`)),
        describeElement(row),
      ).toEqual([]);
    }
  });

  it('gives every dialog action the play-tab and setup pill height', () => {
    expect({
      playActions: baseValue(
        playCss,
        '.play-action-buttons :is(#btn-sync, #btn-media-source)',
        'min-height',
      ),
      setupPrimary: baseValue(appCss, '.btn-ob-primary', 'height'),
      setupSecondary: baseValue(appCss, '.btn-ob-secondary', 'height'),
      listRow: baseValue(appCss, ':root', '--list-row-height'),
    }).toEqual({
      playActions: PILL_HEIGHT,
      setupPrimary: PILL_HEIGHT,
      setupSecondary: PILL_HEIGHT,
      listRow: PILL_HEIGHT,
    });

    // Every unconditional height the action receives, from its own classes or
    // from a descendant rule such as `.some-dialog .dialog-primary`, is the
    // shared pill height. Setup-style rows inside dialogs count too.
    const actions = [
      ...appMarkup().querySelectorAll<HTMLElement>(
        [
          '.dialog :is(.dialog-actions, .adaptive-action-group, .account-dialog-login-actions) > :is(button, a)',
          '[role="dialog"] .ob-actions > :is(button, a)',
        ].join(', '),
      ),
    ];
    expect(actions.length).toBeGreaterThanOrEqual(18);
    for (const action of actions) {
      const heights = appliedValues(action, ['height', 'min-height']);
      expect(heights, `${describeElement(action)} has no pill height`).not.toHaveLength(0);
      expect(
        heights.filter((height) => !height.endsWith(`: ${PILL_HEIGHT}`)),
        describeElement(action),
      ).toEqual([]);
    }
  });

  it('names every dialog surface whose actions stay outside the rhythm', () => {
    const checkedRows =
      ':is(.adaptive-action-group, .dialog-actions, .ob-actions, .account-dialog-login-actions)';
    const unchecked = [...appMarkup().querySelectorAll('[role="dialog"], [role="alertdialog"]')]
      .filter((surface) => surface.querySelector(checkedRows) === null)
      .map((surface) => surface.closest('[id]')?.id ?? describeElement(surface));
    expect(unchecked.sort()).toEqual(Object.keys(OUTSIDE_RHYTHM).sort());
  });

  it('compresses both account views alike on very short screens', () => {
    // The signed-in actions and the signed-out Google / Close stack share one
    // short-screen trade: the same smaller surface gap and the same smaller
    // pills, so neither view keeps a full-size gap next to compressed pills.
    const markup = appMarkup();
    const signedIn = markup.getElementById('account-dialog-actions')!;
    const signedOutClose = markup.getElementById('btn-account-login-close')!;
    const shortGap = appliedValues(signedIn, ['gap'], SHORT_SCREEN).map((value) =>
      value.replace(/^gap: /u, ''),
    );
    expect(shortGap).toHaveLength(1);
    expect(pixels(shortGap[0]!)).toBeLessThan(pixels(ACTION_GAP));
    expect(appliedValues(signedOutClose, ['margin-top'], SHORT_SCREEN)).toEqual([
      `margin-top: ${shortGap[0]}`,
    ]);

    const pills = [
      ...markup.querySelectorAll(
        ':is(#account-dialog-actions, #account-dialog-login-actions) > :is(button, a)',
      ),
    ];
    expect(pills.length).toBe(5);
    const shortPills = new Set(
      pills.flatMap((pill) => appliedValues(pill, ['height', 'min-height'], SHORT_SCREEN)),
    );
    expect(shortPills.size, [...shortPills].join(', ')).toBe(1);

    // While sign-in is loading or unavailable, Close is the view's only
    // (primary) action and keeps no margin above it.
    signedOutClose.classList.add('dialog-primary');
    expect(appliedValues(signedOutClose, ['margin-top'], SHORT_SCREEN)).toEqual([]);
    expect(appliedValues(signedOutClose, ['margin-top'])).toContain('margin-top: 0');
  });

  it('lets two dialog actions keep their natural content-sized split', () => {
    // Owner decision (2026-10-27): a two-action row such as Stay / Leave sizes
    // each pill by its label and wraps only when the pair no longer fits.
    // Equal-width pairs are deliberately not forced.
    expect(baseValue(appCss, '.adaptive-action-group > :is(button, a):not([hidden])', 'flex')).toBe(
      '1 1 max-content',
    );
    expect(baseValue(appCss, '.adaptive-action-group', 'flex-wrap')).toBe('wrap');
  });

  it('lets only short screens compress dialog actions below the shared rhythm', () => {
    // Short landscape phones trade the rhythm for reachable actions (44px
    // pills and a 6px gap in the account dialog, 48px pills in the stepped
    // dialog). Any other viewport condition that resizes dialog actions
    // would split the rhythm again.
    const dialogAction =
      /\.(?:dialog-primary|dialog-secondary|account-google-button|dialog-actions|adaptive-action-group|account-dialog-actions|account-dialog-login-actions)\b/u;
    const shared: Record<string, number> = {
      gap: pixels(ACTION_GAP),
      'row-gap': pixels(ACTION_GAP),
      'column-gap': pixels(ACTION_GAP),
      'min-height': pixels(PILL_HEIGHT),
      height: pixels(PILL_HEIGHT),
    };
    const overrides: string[] = [];
    appCss.walkDecls((declaration) => {
      const rule = declaration.parent as Rule | undefined;
      if (rule?.type !== 'rule' || !(declaration.prop in shared)) return;
      if (!dialogAction.test(rule.selector)) return;
      const media = conditionOf(rule);
      if (media === null) return;
      overrides.push(`${media} ${declaration.prop}: ${declaration.value}`);
      expect(media, `${rule.selector} overrides ${declaration.prop}`).toMatch(
        /^@media \(max-height: \d+px\)$/u,
      );
      expect(pixels(declaration.value)).toBeLessThan(shared[declaration.prop]!);
    });
    expect(overrides.length).toBeGreaterThan(0);
  });

  it('shows the same dialog rhythm on the design-system page and the sign-in completion card', () => {
    const designCss = parseCss(read('public/editorial-design.css'));
    const previewCss = inlineStyles('public/designsystem/preview/toast-dialog.html');
    const completionCss = parseCss(read('public/account-complete.css'));

    expect({
      designGap: baseValue(designCss, '.dialog-actions', 'gap'),
      designPrimary: baseValue(designCss, '.dialog-primary', 'min-height'),
      designSecondary: baseValue(designCss, '.dialog-secondary', 'min-height'),
      previewGap: baseValue(previewCss, '.drow', 'gap'),
      previewPill: baseValue(previewCss, '.db', 'height'),
      completionPill: baseValue(completionCss, 'button', 'min-height'),
    }).toEqual({
      designGap: ACTION_GAP,
      designPrimary: PILL_HEIGHT,
      designSecondary: PILL_HEIGHT,
      previewGap: ACTION_GAP,
      previewPill: PILL_HEIGHT,
      completionPill: PILL_HEIGHT,
    });
  });
});
