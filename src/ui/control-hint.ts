/**
 * The one owner of control hover hints (`title`).
 *
 * A hint shows only what a control's shape cannot say: why it cannot be used
 * right now, or the mode a press starts. Names stay in aria-label and are not
 * repeated as tooltips, and visible text needs no hint.
 *
 * Hints are written when the control's state changes, never when a pointer
 * arrives. The browser exposes `title` as the accessible description, so an
 * unavailable control's reason is already there for keyboard and screen
 * reader users. src/ui/__tests__/hover-hint-policy.test.ts keeps every other
 * title write out of the app, except titles that name or complete content.
 */
interface ControlHintState {
  reason: string | null;
  hint: string | null;
}

const states = new WeakMap<Element, ControlHintState>();

function stateOf(element: Element): ControlHintState {
  let state = states.get(element);
  if (!state) {
    state = { reason: null, hint: null };
    states.set(element, state);
  }
  return state;
}

function render(element: Element, { reason, hint }: ControlHintState): void {
  // An unavailable control shows its reason or nothing, never a mode hint.
  const text = reason === null ? hint : reason;
  if (text) {
    if (element.getAttribute('title') !== text) element.setAttribute('title', text);
  } else if (element.hasAttribute('title')) {
    element.removeAttribute('title');
  }
}

/**
 * Mark a control unavailable with the reason it cannot be used, or available
 * again with `null`. An empty reason marks it unavailable without a hint, for
 * a state the control already shows itself (an empty queue, for example).
 */
export function setControlUnavailable(element: Element, reason: string | null): void {
  const state = stateOf(element);
  state.reason = reason;
  const disabled = String(reason !== null);
  if (element.getAttribute('aria-disabled') !== disabled) {
    element.setAttribute('aria-disabled', disabled);
  }
  render(element, state);
}

/** Set or clear the mode a press starts; an unavailable reason takes priority. */
export function setControlHint(element: Element, hint: string | null): void {
  const state = stateOf(element);
  state.hint = hint || null;
  render(element, state);
}
