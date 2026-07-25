import type { QueueItemId } from '../types/index.ts';
import { getEffectiveScrollViewport } from './scroll-viewport.ts';

const FOLLOW_TOLERANCE_PX = 2;
const FOLLOW_MIN_DURATION_MS = 180;
const FOLLOW_MAX_DURATION_MS = 320;
const FOLLOW_DURATION_STEP_MS = 44;
const KEYBOARD_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

interface FollowRequest {
  queueItemId: QueueItemId;
  subIndex: number;
  token: number;
}

interface FollowAnimation {
  token: number;
  startedAt: number;
  startTop: number;
  durationMs: number;
}

interface PlaylistFollowOptions {
  list: HTMLElement;
  scrollContainer: HTMLElement;
  isVisible: () => boolean;
  isBlocked?: () => boolean;
}

export interface PlaylistFollowController {
  updateSelection: (queueItemId: QueueItemId | null, subIndex: number) => void;
  forceSelection: (queueItemId: QueueItemId | null, subIndex: number) => void;
  afterRender: () => void;
  reset: () => void;
  destroy: () => void;
}

function normalizeSubIndex(subIndex: number): number {
  return Number.isSafeInteger(subIndex) && subIndex >= 0 ? subIndex : -1;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function entryForQueueItem(list: HTMLElement, queueItemId: QueueItemId): HTMLElement | null {
  for (const child of list.children) {
    if (child instanceof HTMLElement && child.dataset.queueItemId === queueItemId) return child;
  }
  return null;
}

function targetForRequest(list: HTMLElement, request: FollowRequest): HTMLElement | null {
  const entry = entryForQueueItem(list, request.queueItemId);
  if (!entry) return null;

  if (request.subIndex >= 0) {
    for (const subItem of entry.querySelectorAll<HTMLElement>('.sub-track-item[data-sub-index]')) {
      if (Number(subItem.dataset.subIndex) === request.subIndex) return subItem;
    }
    // An expanded YouTube playlist can render its loading row before the
    // requested sub-track arrives. Keep the request pending across that DOM
    // replacement instead of treating the parent row as a successful follow.
    return null;
  }

  return entry.querySelector<HTMLElement>('.track-item') ?? entry;
}

function desiredScrollTop(scrollContainer: HTMLElement, target: HTMLElement): number | null {
  const targetRect = target.getBoundingClientRect();
  const viewport = getEffectiveScrollViewport(scrollContainer);
  if (viewport.heightCss <= 0 || targetRect.height <= 0) return null;

  const targetCenterInContent =
    scrollContainer.scrollTop +
    (targetRect.top - viewport.rawTop + targetRect.height / 2) / viewport.renderedScale;
  const unclampedTop = targetCenterInContent - viewport.centerOffsetCss;
  const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
  return Math.min(maxScrollTop, Math.max(0, unclampedTop));
}

function followDurationMs(scrollContainer: HTMLElement, distance: number): number {
  const viewportHeight = Math.max(1, getEffectiveScrollViewport(scrollContainer).heightCss);
  const viewportCount = distance / viewportHeight;
  return Math.min(
    FOLLOW_MAX_DURATION_MS,
    FOLLOW_MIN_DURATION_MS + Math.log2(1 + viewportCount) * FOLLOW_DURATION_STEP_MS,
  );
}

function easeOutQuint(progress: number): number {
  return 1 - Math.pow(1 - progress, 5);
}

/**
 * Keeps one active queue occurrence centered without coupling scroll success
 * to a particular DOM render. A pending request survives list replacement.
 *
 * The controller owns the animation instead of relying on native smooth
 * scrolling. Chromium can stretch a long native scroll beyond 1.5 seconds,
 * while a fixed watchdog interrupts that scroll and visibly snaps the final
 * distance. A short, distance-capped animation keeps every jump responsive and
 * also avoids stale compositor momentum in WebKit.
 */
export function createPlaylistFollowController(
  options: PlaylistFollowOptions,
): PlaylistFollowController {
  const interactionController = new AbortController();
  let observedQueueItemId: QueueItemId | null | undefined;
  let observedSubIndex: number | undefined;
  let request: FollowRequest | null = null;
  let nextToken = 0;
  let frame = 0;
  let animation: FollowAnimation | null = null;
  let destroyed = false;

  function cancelScheduledWork(): void {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    animation = null;
  }

  function replaceRequest(queueItemId: QueueItemId | null, subIndex: number): void {
    cancelScheduledWork();
    request = queueItemId
      ? {
          queueItemId,
          subIndex: normalizeSubIndex(subIndex),
          token: ++nextToken,
        }
      : null;
  }

  function canContinue(token: number): FollowRequest | null {
    const current = request;
    if (
      destroyed ||
      !current ||
      current.token !== token ||
      !options.isVisible() ||
      options.isBlocked?.()
    ) {
      animation = null;
      return null;
    }
    return current;
  }

  function animateFollow(token: number, timestamp: number): void {
    frame = 0;
    const current = canContinue(token);
    const activeAnimation = animation;
    if (!current || !activeAnimation || activeAnimation.token !== token) return;

    const target = targetForRequest(options.list, current);
    if (!target) {
      animation = null;
      return;
    }
    const top = desiredScrollTop(options.scrollContainer, target);
    if (top === null) {
      animation = null;
      return;
    }

    const elapsed = Math.max(0, timestamp - activeAnimation.startedAt);
    const progress = Math.min(1, elapsed / activeAnimation.durationMs);
    const easedProgress = easeOutQuint(progress);
    options.scrollContainer.scrollTop =
      activeAnimation.startTop + (top - activeAnimation.startTop) * easedProgress;

    if (progress >= 1 || Math.abs(options.scrollContainer.scrollTop - top) <= FOLLOW_TOLERANCE_PX) {
      options.scrollContainer.scrollTop = top;
      request = null;
      animation = null;
      return;
    }

    frame = window.requestAnimationFrame((nextTimestamp) => animateFollow(token, nextTimestamp));
  }

  function performFollow(token: number, timestamp: number): void {
    frame = 0;
    const current = canContinue(token);
    if (!current) return;

    const target = targetForRequest(options.list, current);
    if (!target) return;
    const top = desiredScrollTop(options.scrollContainer, target);
    if (top === null) return;

    const distance = Math.abs(options.scrollContainer.scrollTop - top);
    if (distance <= FOLLOW_TOLERANCE_PX) {
      request = null;
      return;
    }

    if (prefersReducedMotion()) {
      options.scrollContainer.scrollTop = top;
      request = null;
      return;
    }

    animation = {
      token,
      startedAt: timestamp,
      startTop: options.scrollContainer.scrollTop,
      durationMs: followDurationMs(options.scrollContainer, distance),
    };
    frame = window.requestAnimationFrame((nextTimestamp) => animateFollow(token, nextTimestamp));
  }

  function scheduleFollow(): void {
    const current = request;
    if (
      destroyed ||
      !current ||
      !options.isVisible() ||
      options.isBlocked?.() ||
      frame ||
      animation
    ) {
      return;
    }
    const token = current.token;
    frame = window.requestAnimationFrame((timestamp) => performFollow(token, timestamp));
  }

  function reset(): void {
    cancelScheduledWork();
    observedQueueItemId = undefined;
    observedSubIndex = undefined;
    request = null;
  }

  const cancelForUserInteraction = (): void => {
    if (!request) return;
    cancelScheduledWork();
    request = null;
  };
  const interactionRoot = options.scrollContainer.parentElement ?? options.scrollContainer;
  const isScrollSurfaceTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Node)) return false;
    if (target === interactionRoot || options.scrollContainer.contains(target)) return true;
    const track = target instanceof Element ? target.closest('.cscroll-track') : null;
    return track?.parentElement === interactionRoot;
  };
  const cancelForScopedUserInteraction = (event: Event): void => {
    if (isScrollSurfaceTarget(event.target)) cancelForUserInteraction();
  };
  const cancelForKeyboardScroll = (event: KeyboardEvent): void => {
    if (
      !event.defaultPrevented &&
      KEYBOARD_SCROLL_KEYS.has(event.key) &&
      isScrollSurfaceTarget(event.target)
    ) {
      cancelForUserInteraction();
    }
  };
  const pointerInteractionOptions = {
    capture: true,
    passive: true,
    signal: interactionController.signal,
  };
  // The custom scrollbar is a sibling of the scroll container. Listen on their
  // shared parent in capture phase so thumb/track handlers that stop bubbling
  // still cancel an in-flight follow before changing scrollTop.
  interactionRoot.addEventListener(
    'wheel',
    cancelForScopedUserInteraction,
    pointerInteractionOptions,
  );
  interactionRoot.addEventListener(
    'touchstart',
    cancelForScopedUserInteraction,
    pointerInteractionOptions,
  );
  interactionRoot.addEventListener(
    'pointerdown',
    cancelForScopedUserInteraction,
    pointerInteractionOptions,
  );
  interactionRoot.addEventListener(
    'mousedown',
    cancelForScopedUserInteraction,
    pointerInteractionOptions,
  );
  interactionRoot.addEventListener('keydown', cancelForKeyboardScroll, {
    signal: interactionController.signal,
  });

  return {
    updateSelection(queueItemId, subIndex) {
      const normalizedSubIndex = normalizeSubIndex(subIndex);
      if (observedQueueItemId === queueItemId && observedSubIndex === normalizedSubIndex) {
        return;
      }
      observedQueueItemId = queueItemId;
      observedSubIndex = normalizedSubIndex;
      replaceRequest(queueItemId, normalizedSubIndex);
    },
    forceSelection(queueItemId, subIndex) {
      const normalizedSubIndex = normalizeSubIndex(subIndex);
      observedQueueItemId = queueItemId;
      observedSubIndex = normalizedSubIndex;
      replaceRequest(queueItemId, normalizedSubIndex);
    },
    afterRender: scheduleFollow,
    reset,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      interactionController.abort();
      reset();
    },
  };
}
