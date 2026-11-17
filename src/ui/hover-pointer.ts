/**
 * The app's one input owner. It answers two questions: can the user hover
 * right now, and is the user navigating by keyboard?
 *
 * Hover. It starts from `(any-hover: hover)` and follows that query's
 * changes, so a mouse or trackpad device hovers from start-up. Real input
 * then corrects it. A convertible in tablet posture (for example a Surface
 * Laptop Studio in stage or studio mode) disables its touchpad, so
 * `(any-hover: hover)` is false even while a pen or mouse hovers the page: a
 * mouse or pen movement turns hover on, from its first boundary event
 * (pointerover arrives before mouseenter and pointermove). A touch press
 * turns it off, so a tapped control never keeps a latched hover look.
 *
 * The answer is `<html data-hover-pointer>`. Every `:hover` rule in css/ sits
 * under `:where(html[data-hover-pointer])`, whose `:where()` adds no
 * specificity, so state rules keep winning exactly as before. Script hover
 * checks use `hasHoverPointer()` and `isHovered()`. Nothing else asks a hover
 * or pointer media query (src/ui/__tests__/hover-pointer.test.ts).
 *
 * Keyboard navigation (owner request 2026-11-18). A focus ring is for a
 * person navigating by keyboard, never for focus that a click, a tap or a
 * window opening moved. The answer is `<html data-keyboard-navigation>`,
 * `off` from start-up, so a window that opens by itself focuses its control
 * without a ring. A key that moves focus turns it `on`: Tab and Shift+Tab
 * anywhere, and the arrows, Home, End, Page Up and Page Down on a control,
 * where they move through a group (tabs, lists, the choice rows) or move the
 * control's value (sliders). Every pointer press, mouse, pen or touch, turns
 * it `off` again; moving a pointer does not. Other keys leave it as it is,
 * so a keyboard user keeps every ring: Space and Enter press the focused
 * control or, on the page or a panel, play or pause; Escape closes the top
 * window, whose owner puts focus back; typing edits a field, where the arrows
 * move the caret; and a key held with Ctrl or Cmd is a shortcut, as is Alt
 * with an arrow (Back and Forward).
 *
 * Every focus ring rule in css/ sits under
 * `:where(html:not([data-keyboard-navigation='off']))`, and one base rule
 * turns the browser's own ring off under `off`. A field's own focus mark (its
 * underline, and its forced-colours outline) is not a ring and shows on
 * every focus. A page where this script never ran has no attribute, so the
 * browser's :focus-visible decides there, as before. No timer is involved.
 */
let installed = false;

export function hasHoverPointer(): boolean {
  return document.documentElement.hasAttribute('data-hover-pointer');
}

/** Whether a hover pointer, not a latched touch press, is over the element. */
export function isHovered(element: Element): boolean {
  return hasHoverPointer() && element.matches(':hover');
}

function setHoverPointer(on: boolean): void {
  if (on !== hasHoverPointer()) {
    document.documentElement.toggleAttribute('data-hover-pointer', on);
  }
}

function setKeyboardNavigation(on: boolean): void {
  const value = on ? 'on' : 'off';
  if (document.documentElement.getAttribute('data-keyboard-navigation') !== value) {
    document.documentElement.setAttribute('data-keyboard-navigation', value);
  }
}

/** Keys that move focus through a group or move a control's value. */
const CONTROL_NAVIGATION_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** Input types whose arrows move a caret instead of focus or a value. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/**
 * Native controls and the ARIA widget roles. A panel, region, log, dialog or
 * message that holds focus is a container: its arrows scroll it.
 */
const CONTROL = [
  'a[href]',
  'button',
  'input',
  'select',
  'summary',
  ...[
    'button',
    'checkbox',
    'grid',
    'gridcell',
    'link',
    'listbox',
    'menu',
    'menubar',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'radiogroup',
    'separator',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'tablist',
    'toolbar',
    'tree',
    'treeitem',
  ].map((role) => `[role='${role}']`),
].join(', ');

function isTextEntry(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

/** Whether this key press is keyboard navigation (see the header). */
function navigatesByKeyboard(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey) return false;
  // Option+Tab moves to every control in Safari.
  if (event.key === 'Tab') return true;
  if (event.altKey || !CONTROL_NAVIGATION_KEYS.has(event.key)) return false;
  const target = event.target;
  return target instanceof Element && !isTextEntry(target) && target.matches(CONTROL);
}

export function initHoverPointer(): void {
  if (installed) return;
  installed = true;
  let query: MediaQueryList | undefined;
  try {
    query = window.matchMedia('(any-hover: hover)');
  } catch {
    /* matchMedia is absent only in old or synthetic DOMs */
  }
  if (query) {
    setHoverPointer(query.matches);
    const follow = (event: MediaQueryListEvent): void => setHoverPointer(event.matches);
    if (typeof query.addEventListener === 'function') query.addEventListener('change', follow);
    else query.addListener(follow);
  }
  setKeyboardNavigation(false);
  const markHoverInput = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') setHoverPointer(true);
  };
  document.addEventListener('pointermove', markHoverInput, { passive: true });
  document.addEventListener('pointerover', markHoverInput, { passive: true, capture: true });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType === 'touch') setHoverPointer(false);
      setKeyboardNavigation(false);
    },
    { passive: true, capture: true },
  );
  // Capture: the mark is set before the browser moves focus for this key.
  document.addEventListener(
    'keydown',
    (event) => {
      if (navigatesByKeyboard(event)) setKeyboardNavigation(true);
    },
    { capture: true },
  );
}
