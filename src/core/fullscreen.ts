/**
 * Resource owner: RO-26 (top-document fullscreen state).
 *
 * Shared Fullscreen API helpers for every app surface that enters or leaves
 * top-document fullscreen: the screensaver entry, the YouTube player and the
 * Back and modal-portal readers in dom.ts. It lives in core so player and ui
 * modules can share it without a ui layering exception.
 */

export type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitCurrentFullScreenElement?: Element | null;
  /** Legacy WebKit can report fullscreen without exposing the element. */
  webkitIsFullScreen?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitCancelFullScreen?: () => Promise<void> | void;
};

export type FullscreenTarget = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitRequestFullScreen?: () => Promise<void> | void;
};

/**
 * Bound for a fullscreen request or exit that the browser never settles: a
 * legacy WebKit call returns no promise and can fail without an event.
 */
export const FULLSCREEN_SETTLEMENT_MS = 1_500;

export const FULLSCREEN_CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'] as const;
export const FULLSCREEN_ERROR_EVENTS = ['fullscreenerror', 'webkitfullscreenerror'] as const;

export function getFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return (
    doc.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.webkitCurrentFullScreenElement ||
    null
  );
}

type FullscreenOwner = 'screensaver' | 'youtube';

/**
 * 'matching' leaves through the door the state was entered by: the standard
 * exit while the standard element is set, otherwise the prefixed exit first.
 * 'standard-first' is the YouTube player's historical order.
 */
type FullscreenExitOrder = 'matching' | 'standard-first';

function resolveFullscreenExit(order: FullscreenExitOrder): {
  invoke: () => Promise<void> | void;
  errorEvent: (typeof FULLSCREEN_ERROR_EVENTS)[number];
} | null {
  const doc = document as FullscreenDocument;
  const standard = doc.exitFullscreen;
  const prefixed = doc.webkitExitFullscreen || doc.webkitCancelFullScreen;
  const exit =
    order === 'standard-first' || doc.fullscreenElement
      ? standard || prefixed
      : prefixed || standard;
  return typeof exit === 'function'
    ? {
        invoke: () => exit.call(doc),
        errorEvent: exit === standard ? 'fullscreenerror' : 'webkitfullscreenerror',
      }
    : null;
}

interface FullscreenExitAttempt {
  /** The owner whose exit issued the native call; joiners do not replace it. */
  readonly owner: FullscreenOwner;
  readonly element: Element | null;
  readonly observers: Set<() => void>;
  finish(): void;
}

/**
 * The one exit in flight for the document (C8-I9). There is one top-document
 * fullscreen state, so any owner's exit for the same element joins it instead
 * of issuing a second native exit; an exit for another element means the
 * earlier element already left, so it settles the earlier attempt first.
 */
let activeExit: FullscreenExitAttempt | null = null;

function notifyExitObserver(observer: (() => void) | undefined): void {
  try {
    observer?.();
  } catch {
    // A surface observer cannot strand the native exit or its other observers.
  }
}

/**
 * Leaves top-document fullscreen held by `element` (null: legacy WebKit that
 * reports fullscreen only through webkitIsFullScreen) and calls `onSettled`
 * once the exit settles: on the promise, on a change event that leaves the
 * element, on an error event of the exit method's own type at the document or
 * the element, on pagehide, or after FULLSCREEN_SETTLEMENT_MS. The bound is a
 * native timer because leaving a room clears every managed timer. An exit for
 * the element already being exited joins that one exit. Callers keep their own
 * request policy and ownership checks; only this module calls a native exit.
 */
export function exitFullscreenFor(
  owner: FullscreenOwner,
  element: Element | null,
  options: { exitOrder: FullscreenExitOrder; onSettled?: () => void },
): void {
  const { onSettled } = options;
  const exit = resolveFullscreenExit(options.exitOrder);
  if (!exit) {
    notifyExitObserver(onSettled);
    return;
  }
  if (activeExit && activeExit.element === element) {
    if (onSettled) activeExit.observers.add(onSettled);
    return;
  }
  activeExit?.finish();

  let finished = false;
  let timer = 0;
  const stillFullscreen = (): boolean =>
    element
      ? getFullscreenElement() === element
      : (document as FullscreenDocument).webkitIsFullScreen === true;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    window.clearTimeout(timer);
    for (const name of FULLSCREEN_CHANGE_EVENTS) document.removeEventListener(name, onChange);
    for (const name of FULLSCREEN_ERROR_EVENTS) document.removeEventListener(name, onError);
    window.removeEventListener('pagehide', finish);
    if (activeExit === attempt) activeExit = null;
    const observers = [...attempt.observers];
    attempt.observers.clear();
    for (const observer of observers) notifyExitObserver(observer);
  };
  const onChange = (): void => {
    if (!stillFullscreen()) finish();
  };
  // The spec fires no error for an exit, so an error here comes from a
  // request. Only one of this exit's own type at the document or the element
  // settles it; a queued error from another API's rejected request does not.
  const onError = (event: Event): void => {
    if (event.type !== exit.errorEvent) return;
    if (event.target === document || (element !== null && event.target === element)) finish();
  };
  const attempt: FullscreenExitAttempt = {
    owner,
    element,
    observers: new Set(onSettled ? [onSettled] : []),
    finish,
  };
  activeExit = attempt;
  for (const name of FULLSCREEN_CHANGE_EVENTS) document.addEventListener(name, onChange);
  for (const name of FULLSCREEN_ERROR_EVENTS) document.addEventListener(name, onError);
  window.addEventListener('pagehide', finish);
  timer = window.setTimeout(finish, FULLSCREEN_SETTLEMENT_MS);

  try {
    const result = exit.invoke();
    if (result && typeof result.then === 'function') result.then(finish, finish);
    else if (!stillFullscreen()) finish();
  } catch {
    // Fullscreen teardown is best-effort on older WebKit.
    finish();
  }
}
