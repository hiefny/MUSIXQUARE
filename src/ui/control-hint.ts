/**
 * The one owner of control hover hints (`title`).
 *
 * A hint shows only what a control's shape cannot say: why it cannot be used
 * right now, or the mode a press starts. Names stay in aria-label and are not
 * repeated as tooltips, and visible text needs no hint.
 *
 * Hints are written when the control's state changes, never when a pointer
 * arrives. The browser exposes `title` as the accessible description when the
 * control has no aria-describedby, so an unavailable control's reason is
 * usually there for keyboard and screen reader users already. Where it is
 * not (a group whose own controls are natively disabled, a group whose
 * aria-describedby outranks title, or a reader that skips titles), the
 * `describe` option also makes the reason a description, or a sentence that
 * gives it when the control's own description is read right after.
 * src/ui/__tests__/hover-hint-policy.test.ts keeps every other title write out
 * of the app, except titles that name or complete content.
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

interface UnavailableOptions {
  /**
   * Also make the reason the control's description: a hidden
   * `#<id>-reason` node (authored, or made beside the control) that
   * aria-describedby lists first, ahead of any description the control has.
   * `true` describes it with the reason itself. A string is the sentence to
   * describe it with instead: a screen reader joins descriptions with a
   * single space, so a reason read ahead of another description is a
   * description sentence key, not the hint's phrase
   * (docs/i18n-translation-guide.md §2 rule 10). Either way the node empties
   * once the control is available again, or unavailable without a reason.
   */
  readonly describe?: boolean | string;
}

function describeReason(element: Element, reason: string): void {
  if (!element.id) return;
  const id = `${element.id}-reason`;
  const ownerDocument = element.ownerDocument;
  let node = ownerDocument.getElementById(id);
  if (!node && reason) {
    node = ownerDocument.createElement('span');
    node.id = id;
    node.hidden = true;
    element.after(node);
  }
  if (node && node.textContent !== reason) node.textContent = reason;
  const others = (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/u)
    .filter((token) => token && token !== id);
  const tokens = (reason ? [id, ...others] : others).join(' ');
  if (!tokens) element.removeAttribute('aria-describedby');
  else if (element.getAttribute('aria-describedby') !== tokens) {
    element.setAttribute('aria-describedby', tokens);
  }
}

/**
 * Mark a control unavailable with the reason it cannot be used, or available
 * again with `null`. An empty reason marks it unavailable without a hint, for
 * a state the control already shows itself (an empty queue, for example).
 */
export function setControlUnavailable(
  element: Element,
  reason: string | null,
  options: UnavailableOptions = {},
): void {
  const state = stateOf(element);
  state.reason = reason;
  const disabled = String(reason !== null);
  if (element.getAttribute('aria-disabled') !== disabled) {
    element.setAttribute('aria-disabled', disabled);
  }
  render(element, state);
  // Checked by type, so an empty sentence still empties the node.
  if (typeof options.describe === 'string') {
    describeReason(element, reason ? options.describe : '');
  } else if (options.describe) {
    describeReason(element, reason ?? '');
  }
}

/** Set or clear the mode a press starts; an unavailable reason takes priority. */
export function setControlHint(element: Element, hint: string | null): void {
  const state = stateOf(element);
  state.hint = hint || null;
  render(element, state);
}
