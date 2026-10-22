/** One ledger for every surface that locks part of the page with `inert`. */

interface InertClaimOptions {
  /**
   * Also hold `aria-hidden="true"` and restore the saved value after the last
   * such owner releases. Defaults to true. Pass false for an owner that covers
   * windows writing their own aria-hidden while it holds them (the session
   * reset): `inert` already hides the subtree from assistive technology, and
   * restoring a value saved at the claim would overwrite the window's write.
   */
  readonly ariaHidden?: boolean;
}

interface ManagedInertState {
  readonly owners: Set<string>;
  readonly ariaHiddenOwners: Set<string>;
  readonly initiallyInert: boolean;
  /** Saved at the first aria-hidden claim; meaningful while such owners remain. */
  initialAriaHidden: string | null;
}

const _managedInert = new WeakMap<HTMLElement, ManagedInertState>();

/**
 * Own an element's inert state without clearing another surface's lock.
 *
 * Mobile chat, the modal stack and the session reset overlay can overlap.
 * Directly toggling `inert` from any of them lets the first one that closes
 * re-enable the page behind another, or restore a stale lock nobody owns.
 * Owners release only their own claim; a pre-existing unmanaged inert state
 * is also preserved.
 */
export function setElementInertForOwner(
  element: HTMLElement,
  owner: string,
  makeInert: boolean,
  options: InertClaimOptions = {},
): void {
  let state = _managedInert.get(element);
  if (makeInert) {
    if (!state) {
      state = {
        owners: new Set<string>(),
        ariaHiddenOwners: new Set<string>(),
        initiallyInert: Boolean(element.inert || element.hasAttribute('inert')),
        initialAriaHidden: null,
      };
      _managedInert.set(element, state);
    }
    state.owners.add(owner);
    element.inert = true;
    element.setAttribute('inert', '');
    if (options.ariaHidden !== false) {
      if (state.ariaHiddenOwners.size === 0) {
        state.initialAriaHidden = element.getAttribute('aria-hidden');
      }
      state.ariaHiddenOwners.add(owner);
      element.setAttribute('aria-hidden', 'true');
    }
    return;
  }

  if (!state) return;
  state.owners.delete(owner);
  if (state.ariaHiddenOwners.delete(owner) && state.ariaHiddenOwners.size === 0) {
    if (state.initialAriaHidden === null) element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', state.initialAriaHidden);
  }
  if (state.owners.size > 0) {
    element.inert = true;
    element.setAttribute('inert', '');
    if (state.ariaHiddenOwners.size > 0) element.setAttribute('aria-hidden', 'true');
    return;
  }

  element.inert = state.initiallyInert;
  if (state.initiallyInert) element.setAttribute('inert', '');
  else element.removeAttribute('inert');
  _managedInert.delete(element);
}
