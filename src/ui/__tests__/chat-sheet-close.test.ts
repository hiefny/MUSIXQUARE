/**
 * @vitest-environment jsdom
 *
 * Owner decision (2026-10-28): the phone and tablet chat sheet keeps its
 * outside-tap close and gains a visible Close at the top start. The desktop
 * chat panel is not a window and shows no Close.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Node, type Root } from 'postcss';
import { describe, expect, it } from 'vitest';

const SHEET_MEDIA = '(max-width: 1279px), (max-height: 719px)';

const markup = new DOMParser().parseFromString(
  readFileSync(resolve('index.html'), 'utf8'),
  'text/html',
);
const appCss = parseCss(readFileSync(resolve('css/style.css'), 'utf8'));
const desktopCss = parseCss(readFileSync(resolve('css/desktop.css'), 'utf8'));

function mediaOf(node: Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && (parent as AtRule).name === 'media') {
      return (parent as AtRule).params;
    }
  }
  return null;
}

/** `prop: value` declarations of rules that list `selector`, with their media. */
function declarations(root: Root, selector: string): { media: string | null; decl: string }[] {
  const found: { media: string | null; decl: string }[] = [];
  root.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.each((node) => {
      if (node.type === 'decl') {
        found.push({ media: mediaOf(rule), decl: `${node.prop}: ${node.value}` });
      }
    });
  });
  return found;
}

describe('chat sheet Close', () => {
  it('sits before the drag handle, not inside it, named Close chat', () => {
    const drawer = markup.getElementById('chat-drawer')!;
    const close = markup.getElementById('btn-chat-close')!;
    const header = drawer.querySelector('.chat-drawer-header')!;
    // The handle becomes a focusable separator or button on the sheet, so a
    // Close inside it would be a control nested in a control.
    expect(close.parentElement).toBe(drawer);
    expect(close.nextElementSibling).toBe(header);
    expect(header.contains(close)).toBe(false);
    expect(close.getAttribute('type')).toBe('button');
    expect(close.getAttribute('data-i18n-aria-label')).toBe('chat.close');
  });

  it('shows on the sheet at the top start of the handle row', () => {
    const sheetRules = [
      ...declarations(appCss, '.chat-drawer-close'),
      ...declarations(appCss, '#btn-chat-close'),
    ];
    expect(
      sheetRules.filter(({ decl }) => decl === 'display: none'),
      'the sheet hides its Close',
    ).toEqual([]);
    // A 36px icon button over the handle row's start: it takes no height of
    // its own, so the handle bar stays centred.
    const onSheet = sheetRules.filter(({ media }) => media === SHEET_MEDIA).map(({ decl }) => decl);
    expect(onSheet).toEqual(
      expect.arrayContaining([
        'align-self: flex-start',
        'width: 36px',
        'height: 36px',
        'margin-bottom: -36px',
      ]),
    );
    // The desktop panel is not a window.
    expect(declarations(desktopCss, '#btn-chat-close').map(({ decl }) => decl)).toContain(
      'display: none',
    );
  });
});
