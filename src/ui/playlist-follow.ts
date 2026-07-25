import type { QueueItemId } from '../types/index.ts';
import { getEffectiveScrollViewport } from './scroll-viewport.ts';

const FOLLOW_SETTLE_MS = 440;
const FOLLOW_TOLERANCE_PX = 2;
const MAX_SMOOTH_RETRIES = 1;

interface FollowRequest {
  queueItemId: QueueItemId;
  subIndex: number;
  token: number;
  retries: number;
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

function scrollContainerTo(
  scrollContainer: HTMLElement,
  top: number,
  behavior: ScrollBehavior,
): void {
  if (typeof scrollContainer.scrollTo === 'function') {
    try {
      scrollContainer.scrollTo({ top, behavior });
      return;
    } catch {
      // Older WebKit builds can reject the options object. The assignment is
      // intentionally kept as a compatibility fallback.
    }
  }
  scrollContainer.scrollTop = top;
}

/**
 * Keeps one active queue occurrence centered without coupling scroll success
 * to a particular DOM render. A pending request survives list replacement and
 * retries once if native smooth scrolling is interrupted by momentum scrolling
 * or a browser compositor handoff.
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
  let settleTimer = 0;
  let destroyed = false;

  function cancelScheduledWork(): void {
    if (frame) window.cancelAnimationFrame(frame);
    if (settleTimer) window.clearTimeout(settleTimer);
    frame = 0;
    settleTimer = 0;
  }

  function replaceRequest(queueItemId: QueueItemId | null, subIndex: number): void {
    cancelScheduledWork();
    request = queueItemId
      ? {
          queueItemId,
          subIndex: normalizeSubIndex(subIndex),
          token: ++nextToken,
          retries: 0,
        }
      : null;
  }

  function performFollow(token: number): void {
    frame = 0;
    const current = request;
    if (
      destroyed ||
      !current ||
      current.token !== token ||
      !options.isVisible() ||
      options.isBlocked?.()
    ) {
      return;
    }

    const target = targetForRequest(options.list, current);
    if (!target) return;
    const top = desiredScrollTop(options.scrollContainer, target);
    if (top === null) return;

    if (Math.abs(options.scrollContainer.scrollTop - top) <= FOLLOW_TOLERANCE_PX) {
      request = null;
      return;
    }

    if (prefersReducedMotion()) {
      scrollContainerTo(options.scrollContainer, top, 'auto');
      options.scrollContainer.scrollTop = top;
      request = null;
      return;
    }

    scrollContainerTo(options.scrollContainer, top, 'smooth');
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      const pending = request;
      if (destroyed || !pending || pending.token !== token) return;

      const latestTarget = targetForRequest(options.list, pending);
      const latestTop = latestTarget
        ? desiredScrollTop(options.scrollContainer, latestTarget)
        : null;
      if (latestTop === null) return;
      if (Math.abs(options.scrollContainer.scrollTop - latestTop) <= FOLLOW_TOLERANCE_PX) {
        request = null;
        return;
      }

      if (pending.retries < MAX_SMOOTH_RETRIES) {
        pending.retries += 1;
        scheduleFollow();
        return;
      }

      // A second ignored smooth scroll usually means WebKit still owns an old
      // momentum transaction. Finish deterministically instead of permanently
      // recording a follow that never reached its row.
      scrollContainerTo(options.scrollContainer, latestTop, 'auto');
      options.scrollContainer.scrollTop = latestTop;
      request = null;
    }, FOLLOW_SETTLE_MS);
  }

  function scheduleFollow(): void {
    const current = request;
    if (
      destroyed ||
      !current ||
      !options.isVisible() ||
      options.isBlocked?.() ||
      frame ||
      settleTimer
    ) {
      return;
    }
    const token = current.token;
    frame = window.requestAnimationFrame(() => performFollow(token));
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
  const interactionOptions = { passive: true, signal: interactionController.signal };
  options.scrollContainer.addEventListener('wheel', cancelForUserInteraction, interactionOptions);
  options.scrollContainer.addEventListener(
    'touchstart',
    cancelForUserInteraction,
    interactionOptions,
  );
  options.scrollContainer.addEventListener(
    'pointerdown',
    cancelForUserInteraction,
    interactionOptions,
  );

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
