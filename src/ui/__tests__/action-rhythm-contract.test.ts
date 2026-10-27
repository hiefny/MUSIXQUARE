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

const read = (path: string): string => readFileSync(resolve(path), 'utf8');
const appCss = parseCss(read('css/style.css'));
const playCss = parseCss(read('css/playback-actions.css'));

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
    }).toEqual({
      dialogActions: ACTION_GAP,
      signedOutClose: ACTION_GAP,
      playActionRow: ACTION_GAP,
      playSecondaryArea: ACTION_GAP,
      setupActions: ACTION_GAP,
    });
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

    const markup = new DOMParser().parseFromString(read('index.html'), 'text/html');
    const actions = [
      ...markup.querySelectorAll<HTMLElement>(
        '.dialog :is(.dialog-actions, .adaptive-action-group, .account-dialog-login-actions) > :is(button, a)',
      ),
    ];
    expect(actions.length).toBeGreaterThanOrEqual(15);
    for (const action of actions) {
      const heights = [...action.classList].flatMap((name) =>
        baseValues(appCss, `.${name}`, 'min-height'),
      );
      expect(heights, `#${action.id} has no pill height`).not.toHaveLength(0);
      expect(new Set(heights), `#${action.id}`).toEqual(new Set([PILL_HEIGHT]));
    }
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
      /\.(?:dialog-primary|dialog-secondary|account-delete-button|account-google-button|dialog-actions|adaptive-action-group|account-dialog-actions|account-dialog-login-actions)\b/u;
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
