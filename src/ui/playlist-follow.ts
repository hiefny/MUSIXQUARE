import type { QueueItemId } from '../types/index.ts';
import { getEffectiveScrollViewport } from './scroll-viewport.ts';
import { cancelNativeSmoothScroll, scrollToWithPreferredMotion } from './scroll-motion.ts';

const FOLLOW_TOLERANCE_PX = 2;
const FOLLOW_SCROLL_IDLE_MS = 160;
const KEYBOARD_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

interface FollowRequest {
  queueItemId: QueueItemId;
  subIndex: number;
  token: number;
}

interface ActiveFollow {
  token: number;
  targetTop: number;
  target: HTMLElement;
}

interface PlaylistFollowOptions {
  list: HTMLElement;
  scrollContainer: HTMLElement;
  isVisible: () => boolean;
  isBlocked?: () => boolean;
}

export interface PlaylistFollowController {
  readonly isFollowing: boolean;
  readonly isScrolling: boolean;
  updateSelection: (queueItemId: QueueItemId | null, subIndex: number) => void;
  forceSelection: (queueItemId: QueueItemId | null, subIndex: number) => void;
  afterRender: () => void;
  reset: () => void;
  destroy: () => void;
}

function normalizeSubIndex(subIndex: number): number {
  return Number.isSafeInteger(subIndex) && subIndex >= 0 ? subIndex : -1;
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

/**
 * Keeps one active queue occurrence centered without coupling scroll success
 * to a particular DOM render. A pending request survives list replacement.
 *
 * Playlist follows intentionally use the same native smooth-scroll path as the
 * chat jump control. No watchdog or forced final assignment is allowed here:
 * long compositor animations may take longer, but they must never end in a
 * visible JavaScript snap.
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
  let activeFollow: ActiveFollow | null = null;
  let scrollIdleTimer = 0;
  let destroyed = false;

  function cancelScheduledFrame(): void {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
  }

  function clearScrollIdleTimer(): void {
    if (scrollIdleTimer) window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = 0;
  }

  function clearActiveFollow(): void {
    clearScrollIdleTimer();
    activeFollow = null;
  }

  function interruptActiveFollow(): void {
    if (!activeFollow) return;
    clearActiveFollow();
    cancelNativeSmoothScroll(options.scrollContainer);
  }

  function completeActiveFollow(): void {
    const active = activeFollow;
    if (!active) return;
    clearActiveFollow();

    const current = request;
    if (!current || current.token !== active.token) return;
    const target = targetForRequest(options.list, current);
    const top = target ? desiredScrollTop(options.scrollContainer, target) : null;
    if (top !== null && Math.abs(options.scrollContainer.scrollTop - top) <= FOLLOW_TOLERANCE_PX) {
      request = null;
      return;
    }

    // A DOM replacement or an unrelated scrollTop write can cancel a native
    // smooth scroll and still emit scrollend. Treat that as an interruption,
    // not success: the selection request remains authoritative until the
    // current render's target is actually reached.
    scheduleFollow();
  }

  function replaceRequest(queueItemId: QueueItemId | null, subIndex: number): void {
    cancelScheduledFrame();
    interruptActiveFollow();
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
      return null;
    }
    return current;
  }

  function performFollow(token: number): void {
    frame = 0;
    const current = canContinue(token);
    if (!current) {
      interruptActiveFollow();
      return;
    }

    const target = targetForRequest(options.list, current);
    if (!target) {
      interruptActiveFollow();
      return;
    }
    const top = desiredScrollTop(options.scrollContainer, target);
    if (top === null) {
      interruptActiveFollow();
      return;
    }

    const distance = Math.abs(options.scrollContainer.scrollTop - top);
    if (distance <= FOLLOW_TOLERANCE_PX) {
      request = null;
      clearActiveFollow();
      return;
    }

    if (
      activeFollow?.token === token &&
      activeFollow.target === target &&
      Math.abs(activeFollow.targetTop - top) <= FOLLOW_TOLERANCE_PX
    ) {
      return;
    }

    interruptActiveFollow();
    const behavior = scrollToWithPreferredMotion(options.scrollContainer, top);
    if (behavior === 'auto') {
      request = null;
      return;
    }
    activeFollow = { token, targetTop: top, target };
  }

  function scheduleFollow(): void {
    const current = request;
    if (destroyed || !current) {
      return;
    }
    if (!options.isVisible() || options.isBlocked?.()) {
      cancelScheduledFrame();
      interruptActiveFollow();
      return;
    }
    if (frame) return;
    const token = current.token;
    frame = window.requestAnimationFrame(() => performFollow(token));
  }

  function reset(): void {
    cancelScheduledFrame();
    interruptActiveFollow();
    observedQueueItemId = undefined;
    observedSubIndex = undefined;
    request = null;
  }

  const cancelForUserInteraction = (): void => {
    if (!request) return;
    cancelScheduledFrame();
    interruptActiveFollow();
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
  options.scrollContainer.addEventListener(
    'scroll',
    () => {
      if (!activeFollow) return;
      clearScrollIdleTimer();
      scrollIdleTimer = window.setTimeout(completeActiveFollow, FOLLOW_SCROLL_IDLE_MS);
    },
    {
      passive: true,
      signal: interactionController.signal,
    },
  );
  options.scrollContainer.addEventListener('scrollend', completeActiveFollow, {
    signal: interactionController.signal,
  });

  return {
    get isFollowing() {
      return request !== null || activeFollow !== null;
    },
    get isScrolling() {
      return activeFollow !== null;
    },
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
