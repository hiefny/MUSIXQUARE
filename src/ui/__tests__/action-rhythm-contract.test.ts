/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Node, type Root } from 'postcss';
import { describe, expect, it } from 'vitest';

// Owner decisions (2026-10-27, revised 2026-10-28): action pills keep 10px
// between their painted surfaces side by side and 12px when one sits below
// another, and every action pill is 56px tall, in dialogs, on the play tab and
// on the setup screens. A pill group's gap shorthand is therefore `12px 10px`
// (row gap, then column gap). Spacing is a recipe rather than an exported root
// token (see the design-system page's component token note), so this contract
// binds the equal values instead of a shared custom property. Change them
// together or not at all.
const ACTION_GAP_ACROSS = '10px';
const ACTION_GAP_DOWN = '12px';
const ACTION_GAP = `${ACTION_GAP_DOWN} ${ACTION_GAP_ACROSS}`;
const PILL_HEIGHT = '56px';
// Owner decision (2026-10-28): at 360px and below dialog pills take 24px side
// padding instead of 28px; min-width stays, and the account actions keep their
// own padding.
const NARROW_DIALOG = '@media (max-width: 360px)';
const NARROW_DIALOG_PADDING = 'padding-inline: 24px';

// Role=dialog surfaces in index.html whose actions deliberately stay outside
// the shared rhythm, with the reason. The scan below fails on any other
// surface without a checked action row, and on a stale entry here. None stays
// outside: the manual sync panel's Reset / Done pair joined the rhythm with
// the adaptive action recipe (2026-10-27).
const OUTSIDE_RHYTHM: Readonly<Record<string, string>> = {};

// Viewport conditions that may size an action row or pill away from the
// shared values, other than short-screen compression, with the reason.
const CONDITIONAL_EXCEPTIONS: ReadonlyArray<{
  condition: string;
  element: string;
  declaration: string;
  reason: string;
}> = [
  {
    condition:
      '@media (min-width: 720px) and (max-width: 1279px), (min-width: 1280px) and (max-height: 719px)',
    element: '#btn-close-media-popup',
    declaration: 'height: 40px',
    reason:
      'On two-column screens the media source Close becomes a 40px icon circle ' +
      'in the header; it is no longer an action pill.',
  },
];

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

/** The row (down) and column (across) gaps that gap declarations set. */
function gapAxes(declarations: readonly string[]): { down: string[]; across: string[] } {
  const axes = { down: [] as string[], across: [] as string[] };
  for (const declaration of declarations) {
    const [property, value] = declaration.split(/:\s*/u) as [string, string];
    const parts = value.trim().split(/\s+/u);
    if (property === 'gap') {
      axes.down.push(parts[0]!);
      axes.across.push(parts[1] ?? parts[0]!);
    } else if (property === 'row-gap') {
      axes.down.push(value.trim());
    } else if (property === 'column-gap') {
      axes.across.push(value.trim());
    }
  }
  return axes;
}

describe('action pill rhythm contract', () => {
  it('keeps one gap between action pills in dialogs, on the play tab and on setup', () => {
    expect({
      dialogActions: baseValue(appCss, '.adaptive-action-group', 'gap'),
      // The signed-out account view stacks the Google pill and Close without
      // a flex group, so the close action's top margin is that surface gap.
      signedOutClose: baseValue(appCss, '.account-dialog-login-close', 'margin-top'),
      // Sync beside Media.
      playActionRow: baseValue(playCss, '.play-actions-row', '--play-action-gap'),
      // The chat preview above the Sync / Media pair.
      playSecondaryArea: baseValue(appCss, '.play-secondary-area', 'gap'),
      setupActions: baseValue(appCss, '.ob-actions', 'gap'),
      setupActionsWithBack: baseValue(appCss, '.ob-actions.horizontal-with-back', 'gap'),
    }).toEqual({
      dialogActions: ACTION_GAP,
      signedOutClose: ACTION_GAP_DOWN,
      playActionRow: ACTION_GAP_ACROSS,
      playSecondaryArea: ACTION_GAP_DOWN,
      setupActions: ACTION_GAP,
      setupActionsWithBack: ACTION_GAP,
    });
  });

  it('resolves the shared gap on every action row in the markup, utility classes included', () => {
    // A later layer or a one-off utility class on the row must not reopen a
    // different gap: every unconditional gap the row receives is the shared
    // 12px down and 10px across. The first-screen host / join stack
    // (.ob-actions.vertical, 16px) is added at runtime and stays the
    // owner-tuned exception.
    const rows = [
      ...appMarkup().querySelectorAll(':is(.adaptive-action-group, .dialog-actions, .ob-actions)'),
    ];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const gaps = appliedValues(row, ['gap', 'row-gap', 'column-gap']);
      expect(gaps, `${describeElement(row)} has no gap`).not.toHaveLength(0);
      const { down, across } = gapAxes(gaps);
      expect(new Set(down), describeElement(row)).toEqual(new Set([ACTION_GAP_DOWN]));
      expect(new Set(across), describeElement(row)).toEqual(new Set([ACTION_GAP_ACROSS]));
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
          '[role="dialog"] :is(.ob-actions, .adaptive-action-group) > :is(button, a)',
        ].join(', '),
      ),
    ];
    expect(actions.length).toBeGreaterThanOrEqual(20);
    // The manual sync panel's Reset / Done pair is checked like a dialog's.
    expect(actions.map((action) => action.id)).toEqual(
      expect.arrayContaining(['btn-auto-sync', 'btn-sync-done']),
    );
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
    expect(pixels(shortGap[0]!)).toBeLessThan(pixels(ACTION_GAP_ACROSS));
    expect(appliedValues(signedOutClose, ['margin-top'], SHORT_SCREEN)).toEqual([
      `margin-top: ${shortGap[0]}`,
    ]);

    const pills = [
      ...markup.querySelectorAll(
        ':is(#account-dialog-actions, #account-dialog-login-actions) > :is(button, a)',
      ),
    ];
    // Log out, Delete, Close; Google, Close, and Retry for the unavailable view.
    expect(pills.length).toBe(6);
    const shortPills = new Set(
      pills.flatMap((pill) => appliedValues(pill, ['height', 'min-height'], SHORT_SCREEN)),
    );
    expect(shortPills.size, [...shortPills].join(', ')).toBe(1);

    // While sign-in is unavailable, Close and Retry are one pair laid out by
    // the shared adaptive action group (account.ts adds the class): the group
    // gap separates them, short screens give it the signed-in view's gap, and
    // Close drops the stack margin.
    const signedOutRow = markup.getElementById('account-dialog-login-actions')!;
    signedOutRow.classList.add('adaptive-action-group');
    expect(appliedValues(signedOutRow, ['gap'], SHORT_SCREEN)).toEqual([`gap: ${shortGap[0]}`]);
    expect(appliedValues(signedOutClose, ['margin-top'], SHORT_SCREEN)).toEqual([]);
    expect(appliedValues(signedOutClose, ['margin-top'])).toContain('margin-top: 0');
    signedOutRow.classList.remove('adaptive-action-group');

    // While sign-in is loading or switched off, Close is the view's only
    // (primary) action and keeps no margin above it.
    signedOutClose.classList.add('dialog-primary');
    expect(appliedValues(signedOutClose, ['margin-top'], SHORT_SCREEN)).toEqual([]);
    expect(appliedValues(signedOutClose, ['margin-top'])).toContain('margin-top: 0');
  });

  it('gives dialog pills 24px side padding at 360px and below', () => {
    // Owner decision (2026-10-28): more localized pairs share one row on the
    // narrowest phones. The shared rule keeps 28px and its 100px min-width.
    for (const selector of ['.dialog-primary', '.dialog-secondary']) {
      expect(baseValue(appCss, selector, 'padding'), selector).toBe('0 28px');
      expect(baseValue(appCss, selector, 'min-width'), selector).toBe('100px');
    }
    const narrowRules: string[] = [];
    const conditions = new Set<string>();
    for (const sheet of appSheets) {
      sheet.walkDecls((declaration) => {
        if (!/^padding/u.test(declaration.prop) && declaration.prop !== 'min-width') return;
        const rule = declaration.parent;
        if (rule?.type !== 'rule') return;
        const selectors = (rule as unknown as { selectors: string[] }).selectors;
        if (
          !selectors.some((selector) => /\.dialog-(?:primary|secondary)(?![\w-])/u.test(selector))
        ) {
          return;
        }
        const condition = conditionOf(declaration);
        if (condition === null) return;
        conditions.add(condition);
        if (condition !== NARROW_DIALOG) return;
        let layer = 'no layer';
        for (let parent = rule.parent as Node | undefined; parent; parent = parent.parent as Node) {
          if (parent.type === 'atrule' && (parent as AtRule).name === 'layer') {
            layer = (parent as AtRule).params;
          }
        }
        narrowRules.push(
          `${selectors.join(', ')} { ${declaration.prop}: ${declaration.value} } in ${layer}`,
        );
      });
    }
    // One rule, in the base layer beside the shared rule, so the more specific
    // account action rule (.account-dialog-actions .dialog-primary, 18px)
    // still wins in the account dialog on the narrowest phones.
    expect(narrowRules).toEqual([
      `.dialog-primary, .dialog-secondary { ${NARROW_DIALOG_PADDING} } in base`,
    ]);
    expect([...conditions]).toEqual([NARROW_DIALOG]);
    const markup = appMarkup();
    for (const id of ['btn-dialog-ok', 'btn-dialog-secondary']) {
      expect(
        appliedValues(
          markup.getElementById(id)!,
          ['padding', 'padding-inline', 'padding-left', 'padding-right', 'min-width'],
          NARROW_DIALOG,
        ),
        id,
      ).toEqual([NARROW_DIALOG_PADDING]);
    }
    expect(baseValue(appCss, '.account-dialog-actions .dialog-secondary', 'padding-inline')).toBe(
      '18px',
    );
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
    // dialog). Any other viewport condition that resizes an action row or
    // pill, in any of the four app sheets and through any selector shape
    // (an ID, a container, a descendant rule), would split the rhythm again.
    const gaps = ['gap', 'row-gap', 'column-gap'];
    const heights = ['height', 'min-height'];
    const shared: Record<string, string> = {
      gap: ACTION_GAP,
      'row-gap': ACTION_GAP_DOWN,
      'column-gap': ACTION_GAP_ACROSS,
      height: PILL_HEIGHT,
      'min-height': PILL_HEIGHT,
    };
    const conditions = new Set<string>();
    for (const sheet of appSheets) {
      sheet.walkDecls((declaration) => {
        if (!(declaration.prop in shared)) return;
        const condition = conditionOf(declaration);
        if (condition !== null) conditions.add(condition);
      });
    }
    const markup = appMarkup();
    const rows = [
      ...markup.querySelectorAll(
        ':is(.adaptive-action-group, .dialog-actions, .ob-actions, .account-dialog-login-actions)',
      ),
    ];
    const pills = rows.flatMap((row) => [...row.querySelectorAll(':scope > :is(button, a)')]);
    expect(pills.length).toBeGreaterThanOrEqual(20);
    const overrides: string[] = [];
    const exceptionsSeen = new Set<string>();
    for (const condition of conditions) {
      for (const [elements, properties] of [
        [rows, gaps],
        [pills, heights],
      ] as const) {
        for (const element of elements) {
          for (const value of appliedValues(element, properties, condition)) {
            const [property, raw] = value.split(/:\s*/u) as [string, string];
            if (raw === shared[property]) continue;
            const exception = CONDITIONAL_EXCEPTIONS.find(
              (allowed) =>
                allowed.condition === condition &&
                element.matches(allowed.element) &&
                allowed.declaration === value,
            );
            if (exception) {
              exceptionsSeen.add(exception.element);
              continue;
            }
            const where = `${condition} ${describeElement(element)} ${value}`;
            overrides.push(where);
            expect(condition, where).toMatch(/^@media \(max-height: \d+px\)$/u);
            // Each compressed value is smaller than the shared value of its
            // axis (a one-value gap shorthand sets both axes).
            const reference = shared[property]!.trim().split(/\s+/u);
            const compressed = raw.trim().split(/\s+/u);
            for (const [index, limit] of reference.entries()) {
              const part = compressed[index] ?? compressed[0]!;
              expect(pixels(part), where).toBeLessThan(pixels(limit));
            }
          }
        }
      }
    }
    expect(overrides.length).toBeGreaterThan(0);
    expect([...exceptionsSeen].sort()).toEqual(
      CONDITIONAL_EXCEPTIONS.map((allowed) => allowed.element).sort(),
    );
  });

  it('wraps the manual sync pair at word boundaries with the adaptive action recipe', () => {
    // Malayalam's Reset (one 160px word) no longer fit beside Done once the
    // pair took the 15px label. The recipe sizes each pill by its label and
    // gives each one a full row only when the pair no longer fits.
    const row = appMarkup().querySelector('#manual-sync-overlay .sync-bottom-row')!;
    expect([...row.classList]).toEqual(['sync-bottom-row', 'adaptive-action-group']);
    for (const pill of row.querySelectorAll(':scope > button')) {
      expect(appliedValues(pill, ['flex', 'width', 'white-space']).sort()).toEqual([
        'flex: 1 1 max-content',
        'white-space: normal',
      ]);
    }
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
