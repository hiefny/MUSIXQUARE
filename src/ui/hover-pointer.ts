/**
 * The app's one answer to "can the user hover right now?".
 *
 * It starts from `(any-hover: hover)` and follows that query's changes, so a
 * mouse or trackpad device hovers from start-up. Real input then corrects it.
 * A convertible in tablet posture (for example a Surface Laptop Studio in
 * stage or studio mode) disables its touchpad, so `(any-hover: hover)` is
 * false even while a pen or mouse hovers the page: a mouse or pen movement
 * turns hover on. A touch press turns it off, so a tapped control never keeps
 * a latched hover look.
 *
 * The answer is `<html data-hover-pointer>`. Every `:hover` rule in css/ sits
 * under `:where(html[data-hover-pointer])`, whose `:where()` adds no
 * specificity, so state rules keep winning exactly as before. Script hover
 * checks use `hasHoverPointer()` and `isHovered()`. Nothing else asks a hover
 * or pointer media query (src/ui/__tests__/hover-pointer.test.ts).
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
  document.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType === 'mouse' || event.pointerType === 'pen') setHoverPointer(true);
    },
    { passive: true },
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType === 'touch') setHoverPointer(false);
    },
    { passive: true, capture: true },
  );
}
