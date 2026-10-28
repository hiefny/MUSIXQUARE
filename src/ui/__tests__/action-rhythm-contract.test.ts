/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Node, type Root, type Rule } from 'postcss';
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

const SHORT_SCREEN = '@media (max-height: 350px)';
// Owner decisions (2026-10-28): the manual sync panel trims its own spacing
// at 360px tall and below (option C), and the app keeps one height threshold
// there: the compact sidebar yields its wordmark at the same 360px.
const SHORT_PANEL = '@media (max-height: 360px)';

// Short-screen compressions: where an action row or pill trades the shared
// rhythm for reachable actions on a short landscape phone, with the reason.
// The scan below fails on any other short-screen value and on an entry it no
// longer finds.
const SHORT_SCREEN_COMPRESSIONS: ReadonlyArray<{
  condition: string;
  element: string;
  declaration: string;
  reason: string;
}> = [
  {
    condition: SHORT_SCREEN,
    element: '#account-dialog-actions',
    declaration: 'gap: 6px',
    reason: 'Account dialog: both views keep every action reachable without scrolling.',
  },
  {
    condition: SHORT_SCREEN,
    element: ':is(#account-dialog-actions, #account-dialog-login-actions) > :is(button, a)',
    declaration: 'min-height: 44px',
    reason: 'Account dialog: 44px touch-target pills in the signed-in and signed-out views.',
  },
  {
    condition: '@media (max-height: 480px)',
    element: '#dialog-overlay.dialog-stepped .dialog-actions > button',
    declaration: 'min-height: 48px',
    reason: 'Stepped dialog: both choices usually fit without scrolling (runtime class).',
  },
  {
    condition: SHORT_SCREEN,
    element: '#manual-sync-overlay .sync-bottom-row',
    declaration: 'gap: 6px',
    reason:
      "Manual sync pair (owner option C, 2026-10-28): the account dialog's gap, " +
      'without a keyboard guard so the value field stays put while it is edited.',
  },
  {
    condition: SHORT_SCREEN,
    element: '#manual-sync-overlay .sync-bottom-row > button',
    declaration: 'min-height: 44px',
    reason: "Manual sync pair (owner option C, 2026-10-28): the account dialog's pills.",
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

/** The innermost cascade layer around a node, or null outside every layer. */
function layerOf(node: Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && (parent as AtRule).name === 'layer') {
      return (parent as AtRule).params;
    }
  }
  return null;
}

/** Rules of the app sheets whose nearest condition is `condition`. */
function rulesUnder(condition: string): Rule[] {
  const rules: Rule[] = [];
  for (const sheet of appSheets) {
    sheet.walkRules((rule) => {
      if (conditionOf(rule) === condition) rules.push(rule);
    });
  }
  return rules;
}

function manualSyncPanel() {
  const overlay = appMarkup().getElementById('manual-sync-overlay')!;
  const pair = overlay.querySelector('.sync-bottom-row')!;
  return {
    panel: overlay.querySelector('.sync-glass-panel')!,
    display: overlay.querySelector('.sync-manual-display')!,
    pair,
    pills: [...pair.querySelectorAll(':scope > button')],
  };
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
    // The manual sync panel's Done / Reset pair is checked like a dialog's.
    expect(actions.map((action) => action.id)).toEqual(
      expect.arrayContaining(['btn-sync-done', 'btn-auto-sync']),
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
    // Short landscape phones trade the rhythm for reachable actions, only in
    // the named SHORT_SCREEN_COMPRESSIONS (the account dialog, the stepped
    // dialog and the manual sync pair). Any other viewport condition that
    // resizes an action row or pill, in any of the four app sheets and
    // through any selector shape (an ID, a container, a descendant rule),
    // would split the rhythm again.
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
    // The generic dialog becomes a stepped dialog at runtime; let the scan see
    // that state's short-screen rules too.
    markup.getElementById('dialog-overlay')!.classList.add('dialog-stepped');
    const rows = [
      ...markup.querySelectorAll(
        ':is(.adaptive-action-group, .dialog-actions, .ob-actions, .account-dialog-login-actions)',
      ),
    ];
    const pills = rows.flatMap((row) => [...row.querySelectorAll(':scope > :is(button, a)')]);
    expect(pills.length).toBeGreaterThanOrEqual(20);
    const overrides: string[] = [];
    const exceptionsSeen = new Set<string>();
    const compressionsSeen = new Set<string>();
    const compressionKey = (entry: (typeof SHORT_SCREEN_COMPRESSIONS)[number]) =>
      `${entry.condition} ${entry.element} ${entry.declaration}`;
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
            const compression = SHORT_SCREEN_COMPRESSIONS.find(
              (named) =>
                named.condition === condition &&
                element.matches(named.element) &&
                named.declaration === value,
            );
            expect(compression, `${where} is not a named short-screen compression`).toBeDefined();
            compressionsSeen.add(compressionKey(compression!));
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
    expect([...compressionsSeen].sort()).toEqual(
      SHORT_SCREEN_COMPRESSIONS.map(compressionKey).sort(),
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

  it('puts the manual sync exit, Done, on the left of Reset', () => {
    // Owner policy (2026-10-28): in a two-button pair the exit is on the left
    // with the secondary look and the action on the right with the primary
    // fill; RTL mirrors the row with the document. One panel serves the
    // standard room, PRO and the demo.
    const row = appMarkup().querySelector('#manual-sync-overlay .sync-bottom-row')!;
    const [done, reset] = row.querySelectorAll(':scope > button');
    expect([done?.id, reset?.id]).toEqual(['btn-sync-done', 'btn-auto-sync']);
    expect(done?.getAttribute('data-i18n')).toBe('common.done');
    expect(reset?.getAttribute('data-i18n')).toBe('common.reset');
    expect(appliedValues(done!, ['background', 'color']).sort()).toEqual([
      'background: var(--surface-2)',
      'color: var(--text-sub)',
    ]);
    expect(appliedValues(reset!, ['background', 'color']).sort()).toEqual([
      'background: var(--primary-filled)',
      'color: white',
    ]);
  });

  it('trims only the manual sync panel spacing at 360px and below', () => {
    // Owner option C (2026-10-28), first step: the panel keeps 12px from the
    // screen edges and pulls in its own spacing, so the nudge row and the pair
    // stay on the first screen. Pill size and type keep the shared values.
    const { panel, display, pair, pills } = manualSyncPanel();
    expect(
      appliedValues(
        panel,
        ['max-height', 'padding', 'padding-block', 'padding-top', 'padding-bottom'],
        SHORT_PANEL,
      ),
    ).toEqual([
      'max-height: calc(100vh - 24px)',
      'max-height: calc(100dvh - 24px)',
      'padding-block: 12px',
    ]);
    expect(
      appliedValues(
        display,
        ['margin', 'margin-block', 'margin-top', 'margin-bottom'],
        SHORT_PANEL,
      ),
    ).toEqual(['margin-block: 4px 12px']);
    expect(appliedValues(pair, ['margin', 'margin-block', 'margin-top'], SHORT_PANEL)).toEqual([
      'margin-top: 12px',
    ]);
    for (const element of [pair, ...pills]) {
      expect(
        appliedValues(
          element,
          ['gap', 'row-gap', 'column-gap', 'height', 'min-height'],
          SHORT_PANEL,
        ),
        describeElement(element),
      ).toEqual([]);
    }
    // Both steps sit in the base layer beside the panel's own rules, and
    // neither declares type: the pair keeps the button label role.
    const syncRules = [SHORT_PANEL, SHORT_SCREEN].flatMap((condition) =>
      rulesUnder(condition).filter((rule) =>
        rule.selectors.some((selector) => selector.includes('.sync-')),
      ),
    );
    expect(syncRules).toHaveLength(5);
    for (const rule of syncRules) {
      expect(layerOf(rule), rule.selector).toBe('base');
      rule.walkDecls((declaration) => {
        expect(declaration.prop, rule.selector).not.toMatch(/^font|^letter-spacing$/u);
      });
    }
  });

  it("gives the manual sync pair the account dialog's short-screen pills at 350px and below", () => {
    // Owner option C (2026-10-28), second step: the pair joins the account
    // dialog's 350px trade instead of opening another pill threshold. The
    // account values are read, not repeated, so changing one side fails.
    const accountRow = appMarkup().getElementById('account-dialog-actions')!;
    const accountGap = appliedValues(accountRow, ['gap', 'row-gap', 'column-gap'], SHORT_SCREEN);
    const accountPills = [
      ...new Set(
        [...accountRow.querySelectorAll(':scope > :is(button, a)')].flatMap((pill) =>
          appliedValues(pill, ['height', 'min-height'], SHORT_SCREEN),
        ),
      ),
    ];
    expect(accountGap).toHaveLength(1);
    expect(accountPills).toHaveLength(1);

    const { pair, pills } = manualSyncPanel();
    expect(appliedValues(pair, ['gap', 'row-gap', 'column-gap'], SHORT_SCREEN)).toEqual(accountGap);
    expect(appliedValues(pair, ['margin', 'margin-block', 'margin-top'], SHORT_SCREEN)).toEqual([
      'margin-top: 8px',
    ]);
    expect(pills.map((pill) => pill.id)).toEqual(['btn-sync-done', 'btn-auto-sync']);
    for (const pill of pills) {
      expect(appliedValues(pill, ['height', 'min-height'], SHORT_SCREEN), pill.id).toEqual(
        accountPills,
      );
      // The shared pill size is a minimum, so the smaller minimum takes over
      // without a height reset and a wrapped label still grows the pill.
      expect(appliedValues(pill, ['height']), pill.id).toEqual([]);
    }
  });

  it('keeps the manual sync steps free of the keyboard guard the account dialog keeps', () => {
    // These rules change only spacing inside the fixed overlay, so they cannot
    // feed keyboard detection (the visual viewport height). A guard would grow
    // the pair back to 56px and 12px the moment the value field raises the
    // keyboard on a short landscape phone, moving the centred field while it
    // is edited, and shrink it again when the keyboard closes. The account
    // dialog keeps its guard; checking both blocks also catches a guard
    // dropped from, or added to, the wrong one.
    const syncSelectors = [SHORT_PANEL, SHORT_SCREEN].flatMap((condition) =>
      rulesUnder(condition)
        .flatMap((rule) => rule.selectors)
        .filter((selector) => selector.includes('.sync-')),
    );
    expect(syncSelectors).toHaveLength(6);
    for (const selector of syncSelectors) expect(selector).not.toContain('keyboard-open');

    const accountSelectors = rulesUnder(SHORT_SCREEN)
      .flatMap((rule) => rule.selectors)
      .filter((selector) => selector.includes('.account-'));
    expect(accountSelectors.length).toBeGreaterThan(0);
    for (const selector of accountSelectors) {
      // Prettier may wrap a long selector after the guard.
      expect(selector).toMatch(/^html:not\(\.keyboard-open\)\s/u);
    }
  });

  it('never sets the manual sync pair closer to the nudge row than to its own wrapped row', () => {
    // A wrapped Done sits below the nudge row by the pair's top margin and
    // above Reset by the pair's row gap. The margin stays at least the row gap
    // at every step (row-gap, since the two axes can differ), so the pair
    // never reads as part of the nudge row.
    const { pair } = manualSyncPanel();
    const steps: Array<{ condition: string | null; margin: number; rowGap: number }> = [];
    let margin = Number.NaN;
    let rowGap = Number.NaN;
    // Each step applies on top of the wider ones before it.
    for (const condition of [null, SHORT_PANEL, SHORT_SCREEN]) {
      const margins = appliedValues(pair, ['margin-top'], condition);
      const { down } = gapAxes(appliedValues(pair, ['gap', 'row-gap', 'column-gap'], condition));
      expect(margins.length, String(condition)).toBeLessThanOrEqual(1);
      expect(down.length, String(condition)).toBeLessThanOrEqual(1);
      if (margins[0]) margin = pixels(margins[0].replace(/^margin-top:\s*/u, ''));
      if (down[0]) rowGap = pixels(down[0]);
      steps.push({ condition, margin, rowGap });
      expect(margin, String(condition)).toBeGreaterThanOrEqual(rowGap);
    }
    expect(steps).toEqual([
      { condition: null, margin: 16, rowGap: Number.parseFloat(ACTION_GAP_DOWN) },
      { condition: SHORT_PANEL, margin: 12, rowGap: Number.parseFloat(ACTION_GAP_DOWN) },
      { condition: SHORT_SCREEN, margin: 8, rowGap: 6 },
    ]);
    // The 350px step must follow the 360px one to win where both apply.
    const pairRuleLine = (condition: string) =>
      rulesUnder(condition).find(
        (rule) => rule.selector === '.sync-bottom-row.adaptive-action-group',
      )?.source?.start?.line ?? -1;
    expect(pairRuleLine(SHORT_PANEL)).toBeGreaterThan(0);
    expect(pairRuleLine(SHORT_SCREEN)).toBeGreaterThan(pairRuleLine(SHORT_PANEL));
  });

  it("puts the manual sync spacing step on the compact sidebar's wordmark threshold", () => {
    // Owner decision (2026-10-28): one short-height threshold rather than a
    // new 360px one beside the sidebar's 370px wordmark rule. Above 360px the
    // five labelled sidebar tabs fit beside the wordmark in every locale
    // (measured 2026-10-29), so the wordmark rule moved to 360px and the
    // manual sync step shares it.
    const wordmarkHidden = new Set<string>();
    appCss.walkRules((rule) => {
      if (!rule.selectors.includes('html:not(.keyboard-open) #app-logo')) return;
      rule.walkDecls('display', (declaration) => {
        if (declaration.value === 'none') wordmarkHidden.add(conditionOf(rule) ?? 'always');
      });
    });
    expect([...wordmarkHidden]).toContain(SHORT_PANEL);
    const heightThresholds = new Set<string>();
    for (const sheet of appSheets) {
      sheet.walkAtRules('media', (rule) => {
        for (const match of rule.params.matchAll(/max-height:\s*(\d+)px/gu)) {
          heightThresholds.add(match[1]!);
        }
      });
    }
    expect(heightThresholds.has('360')).toBe(true);
    expect(heightThresholds.has('370')).toBe(false);
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
