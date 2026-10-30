/**
 * A focus target available now: connected, enabled, outside any hidden,
 * aria-hidden or inert subtree, and not display: none or visibility: hidden.
 * Focus traps filter their Tab candidates with it, so a control the page
 * keeps in a hidden container never stalls the cycle.
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
