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
 * checks use `hasHoverPointer()` and `isHovered()`, and a script that tells a
 * hover pointer's events from a touch asks `isHoverInput()`, the same test
 * that turns hover on. Nothing else asks a hover or pointer media query
 * (src/ui/__tests__/hover-pointer.test.ts).
 *
 * Keyboard navigation (owner request 2026-11-18). A focus ring is for a
 * person navigating by keyboard, never for focus that a click, a tap or a
 * window opening moved. The answer is `<html data-keyboard-navigation>`,
 * `off` from start-up, so a window that opens by itself focuses its control
 * without a ring. A key that moves focus, or a widget's value, turns it `on`:
 * - Tab and Shift+Tab anywhere, except a Tab that a text field takes for
 *   itself and keeps focus on: the chat's command completion calls
 *   preventDefault and focus stays in the field. A Tab that leaves a field,
 *   or that a dialog's focus trap takes and moves, counts.
 * - The arrows, Home, End, Page Up and Page Down on a widget they move
 *   through or move: a slider, a radio (the PIN dialog's choice rows), a
 *   select and the ARIA widget roles (the phone's tab bar, the chat sheet's
 *   resize handle).
 * - Any of those keys, wherever it was pressed, that moves focus in its own
 *   turn (below): a TV remote's D-pad under spatial navigation moves focus
 *   from the page, a panel or a plain button, and the playlist's keyboard
 *   reorder refocuses the row it moves. Pressed on a plain button, link,
 *   switch or checkbox, on the page, a panel or the chat log, they otherwise
 *   only scroll, and in a text field they move the caret, so there they do
 *   not count: a mouse user who clicks a track and scrolls with Page Down
 *   gets no ring.
 * Every pointer press, mouse, pen or touch, turns it `off` again; moving a
 * pointer does not. Other keys leave it as it is, so a keyboard user keeps
 * every ring: Space and Enter press the focused control or, on the page or a
 * panel, play or pause; Escape closes the top window, whose owner puts focus
 * back; typing edits a field; and a key held with Ctrl or Cmd is a shortcut,
 * as is Alt with an arrow (Back and Forward).
 *
 * WCAG 2.4.7: a keyboard user's rings show from their first Tab, or their
 * first arrow that moves focus or a value, on. In a window that opened by
 * itself, before any navigation, the controls ring from the person's first
 * Tab: it rings the control it moves to, or in a one-button window the same
 * button.
 *
 * Every focus ring rule in css/ sits under
 * `:where(html:not([data-keyboard-navigation='off']))`, and one base rule
 * turns the browser's own ring off under `off`. A field's own focus mark (its
 * underline, and its forced-colours outline) is not a ring and shows on
 * every focus. A page where this script never ran has no attribute, so the
 * browser's :focus-visible decides there, as before; so it does on an engine
 * without :where() (docs/known-accepted.md #20).
 *
 * A key's turn. A focus move counts for an arrow, Home, End or page key, or
 * for a Tab in a text field, only in that key's turn, which ends with its
 * keydown's task. Every focus move such a key makes happens in that task:
 * the browser's default action (spatial navigation, a Tab), an app
 * handler's focus() (the playlist's keyboard reorder) and a dialog's focus
 * trap. The keydown posts a message and sets a 0 ms timer, both of which run
 * in later tasks, and the first of them to run ends the turn. Chromium runs
 * the message first. WebKit hands it over a task later, after a 0 ms timer
 * set behind the post (review finding H6-R1), so there the timer ends the
 * turn. Timers keep their order, so in every browser a timer set after the
 * key's own runs once the turn has ended. The keyup, the next key, a pointer
 * press, any scroll in the document or the window losing focus end it too,
 * should one come first. So a window that opens by itself while the key is
 * still down draws no ring (review finding H-6): it opens from a later task
 * (a timer's, a network or service worker message's) and focuses its control
 * there (src/ui/dom.ts) or later (src/ui/dialog.ts, from a timer). A mouse
 * user's caret key or completion Tab in the chat field is down for about a
 * tenth of a second, and a page key held on a list or panel with nothing
 * left to scroll for the whole hold. A window can still come first from a
 * task queued before the key's, from one that the browser runs ahead of its
 * queue (a frame's callbacks, a DevTools command), or from a network or
 * service worker message that it runs ahead of the key's timer and message:
 * the HTML standard orders no task source against another.
 */
let installed = false;

export function hasHoverPointer(): boolean {
  return document.documentElement.hasAttribute('data-hover-pointer');
}

/** Whether a hover pointer, not a latched touch press, is over the element. */
export function isHovered(element: Element): boolean {
  return hasHoverPointer() && element.matches(':hover');
}

/**
 * Whether a pointer event comes from a pointer that can hover: a mouse or a
 * pen, never a touch. An event that names no pointer type (a synthetic one)
 * follows the gate, so it never turns hover on by itself.
 */
export function isHoverInput(event: PointerEvent): boolean {
  if (event.pointerType === 'mouse' || event.pointerType === 'pen') return true;
  return !event.pointerType && hasHoverPointer();
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

/** Keys that move through a widget or move its value, and otherwise scroll. */
const NAVIGATION_KEYS = new Set([
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
 * The ARIA widget roles whose arrows, Home, End and page keys move focus
 * within them or move their value. On a plain button, link, switch or
 * checkbox those keys scroll, as on a panel, a region, a log or a dialog.
 */
const ARROW_WIDGET = [
  'grid',
  'gridcell',
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
  'tab',
  'tablist',
  'toolbar',
  'tree',
  'treeitem',
]
  .map((role) => `[role='${role}']`)
  .join(', ');

function isTextEntry(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

/** Whether the arrows on this element move focus within it or move its value. */
function movesWithArrows(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    return element.type === 'range' || element.type === 'radio';
  }
  return element instanceof HTMLSelectElement || element.matches(ARROW_WIDGET);
}

/**
 * How a key press counts (see the header): it navigates; it navigates if focus
 * moves in its turn (`moves-focus`); it is a Tab in a text field, which
 * navigates unless the field keeps it (`field-tab`); or it does not count.
 */
function countKey(event: KeyboardEvent): 'navigates' | 'moves-focus' | 'field-tab' | null {
  if (event.ctrlKey || event.metaKey) return null;
  const target = event.target instanceof Element ? event.target : null;
  // Option+Tab moves to every control in Safari.
  if (event.key === 'Tab') return target && isTextEntry(target) ? 'field-tab' : 'navigates';
  if (event.altKey || !NAVIGATION_KEYS.has(event.key)) return null;
  return target && !isTextEntry(target) && movesWithArrows(target) ? 'navigates' : 'moves-focus';
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
  /** The key in its turn, whose focus move counts as navigation (see the header). */
  let heldKey: string | null = null;
  /** A Tab in a text field: it navigates unless the field keeps it. */
  let fieldTab: { event: KeyboardEvent; field: Element } | null = null;
  const releaseKey = (): void => {
    heldKey = null;
  };
  // A message posted at a keydown and a 0 ms timer set there each run in a
  // later task, so the first of them ends the key's turn with the keydown's
  // task: the message in Chromium, the timer in WebKit (see the header).
  const keyTask = new MessageChannel();
  keyTask.port1.onmessage = releaseKey;
  // Added during the Tab's own dispatch, this runs after every window
  // listener already there, a dialog's focus trap among them.
  const settleFieldTab = (event: KeyboardEvent): void => {
    const tab = fieldTab;
    fieldTab = null;
    if (tab?.event !== event) return;
    if (!event.defaultPrevented || document.activeElement !== tab.field) {
      setKeyboardNavigation(true);
    }
  };
  const markHoverInput = (event: PointerEvent): void => {
    if (isHoverInput(event)) setHoverPointer(true);
  };
  document.addEventListener('pointermove', markHoverInput, { passive: true });
  document.addEventListener('pointerover', markHoverInput, { passive: true, capture: true });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType === 'touch') setHoverPointer(false);
      releaseKey();
      setKeyboardNavigation(false);
    },
    { passive: true, capture: true },
  );
  // Capture: the mark is set before the browser moves focus for this key.
  document.addEventListener(
    'keydown',
    (event) => {
      releaseKey();
      fieldTab = null;
      window.removeEventListener('keydown', settleFieldTab);
      const count = countKey(event);
      if (count === 'navigates') {
        setKeyboardNavigation(true);
        return;
      }
      if (count === null) return;
      heldKey = event.key;
      keyTask.port2.postMessage(null);
      window.setTimeout(releaseKey, 0);
      if (count === 'field-tab' && event.target instanceof Element) {
        fieldTab = { event, field: event.target };
        window.addEventListener('keydown', settleFieldTab, { once: true });
      }
    },
    { capture: true },
  );
  document.addEventListener('keyup', releaseKey, { capture: true });
  // Any scroll in the document ends the key's turn, the key's own or another
  // (capture: an element's scroll event does not bubble). A focus move that a
  // scroll brings about (a button that hides under focus) is the page's, not
  // the key's, and a scroll event fires only with the next frame, after any
  // focus move the key makes in its own task.
  document.addEventListener('scroll', releaseKey, { capture: true, passive: true });
  window.addEventListener('blur', releaseKey);
  document.addEventListener(
    'focusin',
    () => {
      if (heldKey !== null) setKeyboardNavigation(true);
    },
    { capture: true },
  );
}
