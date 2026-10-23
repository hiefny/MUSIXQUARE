import { beginBackSurfaceTransition } from './dom.ts';
import {
  FULLSCREEN_CHANGE_EVENTS,
  FULLSCREEN_ERROR_EVENTS,
  FULLSCREEN_SETTLEMENT_MS,
  exitFullscreenFor,
  getFullscreenElement,
  type FullscreenTarget,
} from '../core/fullscreen.ts';

export interface ScreensaverEntry {
  readonly container: HTMLElement;
  readonly closed: boolean;
  onExit(listener: () => void): () => void;
  release(): void;
}

let currentEntry: ScreensaverEntry | null = null;

/** Keep the gesture-bound fullscreen request ahead of the lazy renderer import. */
export function beginScreensaverEntry(): ScreensaverEntry | null {
  if (currentEntry) return null;
  const previousFullscreen = getFullscreenElement();
  const target = document.documentElement as FullscreenTarget;
  const listeners = new Set<() => void>();
  // The request bound is a native timer: leaving a room clears every managed
  // timer, which would strand a silent WebKit request and keep the entry lock
  // until some later fullscreen event. The exit is bounded by its owner.
  let requestTimer = 0;
  let closed = false;
  let requestPending = false;
  let exitPending = false;
  let sawFullscreen = Boolean(previousFullscreen);
  let requested = false;
  let requestGeneration = 0;
  let requestErrorEvent: string | null = null;
  let rejectActiveRequest: (() => void) | null = null;

  const finish = (): void => {
    if (!closed || requestPending || exitPending) return;
    for (const event of FULLSCREEN_CHANGE_EVENTS)
      document.removeEventListener(event, onFullscreenChange);
    for (const event of FULLSCREEN_ERROR_EVENTS)
      document.removeEventListener(event, onFullscreenError);
    window.clearTimeout(requestTimer);
    if (currentEntry === entry) currentEntry = null;
  };
  const restore = (): void => {
    if (!requested || previousFullscreen || getFullscreenElement() !== target || exitPending) {
      finish();
      return;
    }
    exitPending = true;
    const finishBackSurface = beginBackSurfaceTransition();
    // Leave only the state this entry acquired, through the door it entered.
    exitFullscreenFor('screensaver', target, () => {
      exitPending = false;
      finishBackSurface();
      finish();
    });
  };
  const release = (): void => {
    if (closed) return;
    closed = true;
    listeners.clear();
    restore();
  };
  const settleRequest = (): void => {
    requestGeneration++;
    requestPending = false;
    requestErrorEvent = null;
    rejectActiveRequest = null;
    window.clearTimeout(requestTimer);
    if (closed) restore();
  };
  const onFullscreenChange = (): void => {
    const fullscreen = getFullscreenElement();
    const expected = previousFullscreen || (requested ? target : null);
    if (expected && fullscreen === expected) {
      sawFullscreen = true;
      if (requestPending) settleRequest();
      else if (closed) restore();
    } else if (sawFullscreen && !closed) {
      const callbacks = [...listeners];
      release();
      for (const listener of callbacks) listener();
    } else finish();
  };
  const onFullscreenError = (event: Event): void => {
    if (event.target !== document && event.target !== target) return;
    if (requestPending && event.type === requestErrorEvent) rejectActiveRequest?.();
  };
  const entry: ScreensaverEntry = {
    container:
      previousFullscreen instanceof HTMLElement && previousFullscreen !== document.documentElement
        ? previousFullscreen
        : document.body,
    get closed() {
      return closed;
    },
    onExit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release,
  };
  currentEntry = entry;
  for (const event of FULLSCREEN_CHANGE_EVENTS)
    document.addEventListener(event, onFullscreenChange);
  for (const event of FULLSCREEN_ERROR_EVENTS) document.addEventListener(event, onFullscreenError);

  const requests = [
    { invoke: target.requestFullscreen, errorEvent: 'fullscreenerror' },
    {
      invoke: target.webkitRequestFullscreen || target.webkitRequestFullScreen,
      errorEvent: 'webkitfullscreenerror',
    },
  ].filter(
    (request): request is { invoke: () => Promise<void> | void; errorEvent: string } =>
      typeof request.invoke === 'function',
  );
  const requestAt = (index: number): void => {
    const request = requests[index];
    if (!request || closed || getFullscreenElement()) {
      settleRequest();
      return;
    }
    requested = true;
    requestPending = true;
    requestErrorEvent = request.errorEvent;
    const generation = ++requestGeneration;
    const rejected = (): void => {
      if (generation !== requestGeneration) return;
      requested = false;
      if (!closed && requests[index + 1]) requestAt(index + 1);
      else settleRequest();
    };
    rejectActiveRequest = rejected;
    try {
      const result = request.invoke.call(target);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then(() => {
          if (generation !== requestGeneration) return;
          if (getFullscreenElement() === target) sawFullscreen = true;
          settleRequest();
        }, rejected);
      } else if (getFullscreenElement() === target) {
        sawFullscreen = true;
        settleRequest();
      } else if (generation === requestGeneration) {
        window.clearTimeout(requestTimer);
        requestTimer = window.setTimeout(settleRequest, FULLSCREEN_SETTLEMENT_MS);
      }
    } catch {
      rejected();
    }
  };
  if (!previousFullscreen) requestAt(0);
  return entry;
}
