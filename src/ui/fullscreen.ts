type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitCurrentFullScreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitCancelFullScreen?: () => Promise<void> | void;
};

export type FullscreenTarget = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitRequestFullScreen?: () => Promise<void> | void;
};

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
