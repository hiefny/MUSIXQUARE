/**
 * Hover affordances for hybrid devices whose hover-capable input the browser
 * does not report.
 *
 * A convertible in tablet posture (for example a Surface Laptop Studio in
 * stage or studio mode) disables its touchpad, so `(any-hover: hover)` is
 * false even while a pen or mouse hovers the page. A real mouse or pen
 * movement marks the document with `data-hover-pointer`, which the stylesheet
 * treats like `any-hover`; a touch press clears it so tapped rows never keep a
 * latched hover look.
 */
let installed = false;

export function initHoverPointer(): void {
  if (installed) return;
  installed = true;
  const root = document.documentElement;
  document.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
        root.dataset.hoverPointer = '';
      }
    },
    { passive: true },
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType === 'touch') delete root.dataset.hoverPointer;
    },
    { passive: true, capture: true },
  );
}
