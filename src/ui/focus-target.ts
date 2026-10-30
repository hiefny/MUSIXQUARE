/**
 * A focus target available now, by these checks only: the element is
 * connected; neither it nor an ancestor has the hidden, aria-hidden="true" or
 * inert attribute; it is not :disabled or aria-disabled="true"; and its own
 * computed display is not none and its computed visibility is not hidden or
 * collapse. Ancestors' computed display is not read, so a control inside a
 * container that only a CSS rule hides still passes.
 */
export function isAvailableFocusTarget(element: HTMLElement | null): element is HTMLElement {
  if (
    !element?.isConnected ||
    element.matches(':disabled, [aria-disabled="true"]') ||
    element.closest('[hidden], [aria-hidden="true"], [inert]')
  )
    return false;
  const style = getComputedStyle(element);
  return (
    style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
  );
}
