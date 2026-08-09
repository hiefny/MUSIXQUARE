/** Keep visual selection classes and their assistive-technology state in sync. */

export function setPressedState(
  element: Element,
  pressed: boolean,
  visuallyActive = pressed,
): void {
  element.classList.toggle('active', visuallyActive);
  element.setAttribute('aria-pressed', String(pressed));
}

export function syncExclusivePressedState<T extends Element>(
  elements: Iterable<T>,
  isPressed: (element: T) => boolean,
): void {
  for (const element of elements) setPressedState(element, isPressed(element));
}

export function setCurrentState(element: Element, current: boolean): void {
  element.classList.toggle('active', current);
  if (current) element.setAttribute('aria-current', 'true');
  else element.removeAttribute('aria-current');
}
