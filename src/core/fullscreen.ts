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

export function getFullscreenExit(): {
  invoke: () => Promise<void> | void;
  errorEvent: (typeof FULLSCREEN_ERROR_EVENTS)[number];
} | null {
  const doc = document as FullscreenDocument;
  const exit = doc.fullscreenElement
    ? doc.exitFullscreen || doc.webkitExitFullscreen || doc.webkitCancelFullScreen
    : doc.webkitExitFullscreen || doc.webkitCancelFullScreen || doc.exitFullscreen;
  return typeof exit === 'function'
    ? {
        invoke: () => exit.call(doc),
        errorEvent: exit === doc.exitFullscreen ? 'fullscreenerror' : 'webkitfullscreenerror',
      }
    : null;
}
