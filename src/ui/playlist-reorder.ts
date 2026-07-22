import { getBodyRenderedScale, viewportLengthToBodyCssPixels } from '../core/platform.ts';

const ENTRY_SELECTOR = '.playlist-entry[data-queue-item-id]';
const ROW_SELECTOR = '.track-item';
const HANDLE_SELECTOR = '.playlist-reorder-handle';
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, [contenteditable="true"], .sub-track-item';

const PLAYLIST_LONG_PRESS_MS = 700;
const PLAYLIST_TOUCH_MOVE_TOLERANCE_PX = 8;
const PLAYLIST_REORDER_HINT_MS = 2000;

const MOMENTUM_SETTLE_MS = 140;
const CLICK_SUPPRESSION_MS = 500;
const EDGE_ZONE_MAX_PX = 72;
const EDGE_ZONE_MIN_PX = 40;
const EDGE_SCROLL_MAX_PX = 18;
const REORDER_REFLOW_MS = 220;
const REORDER_DROP_MS = 180;
const REORDER_HANDOFF_DELAY_MS = REORDER_DROP_MS;
const REORDER_HANDOFF_MS = 90;
const REORDER_HANDLE_RETURN_MS = 140;
const REORDER_MOTION_SAFETY_MS = 32;
const REORDER_MOTION_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

type DragInput = 'handle' | 'long-press';

interface DragState {
  sourceId: string;
  sourceEntry: HTMLElement;
  originalBeforeId: string | null;
  beforeId: string | null;
  input: DragInput;
  pointerId: number | null;
  touchId: number | null;
  lastClientX: number;
  lastClientY: number;
  grabOffsetY: number;
  ghost: HTMLElement;
  ghostOriginTop: number;
}

interface KeyboardState {
  sourceId: string;
  sourceEntry: HTMLElement;
  originalBeforeId: string | null;
  beforeId: string | null;
}

interface TouchProbeState {
  touchId: number;
  sourceId: string;
  sourceEntry: HTMLElement;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startScrollTop: number;
  disqualified: boolean;
  suppressClickOnEnd: boolean;
  scrollConfirmed: boolean;
  longPressTimer: number | null;
}

interface ScopedClickSuppression {
  sourceId: string;
  until: number;
}

interface SettlingState {
  ghost: HTMLElement | null;
  sourceEntry: HTMLElement | null;
  frame: number | null;
  timer: number | null;
  didRequestCommit: boolean;
}

interface EntryRect {
  left: number;
  top: number;
}

interface PlaylistReorderOptions {
  list: HTMLElement;
  canReorder: () => boolean;
  onCommit: (queueItemId: string, beforeQueueItemId: string | null) => void;
  getAnnouncement: (queueItemId: string, position: number, total: number) => string;
  getHandleLabel?: (queueItemId: string, position: number) => string;
  onInteractionEnd?: (didRequestCommit: boolean) => void;
  isPlaylistVisible?: () => boolean;
}

export interface PlaylistReorderController {
  readonly isActive: boolean;
  readonly isSettling: boolean;
  cancel: () => void;
  destroy: () => void;
  afterRender: () => void;
  notifyItemsAdded: () => void;
  notifyPlaylistEntered: () => void;
  notifyPlaylistHidden: () => void;
}

function asElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function getEntryId(entry: Element | null): string | null {
  if (!(entry instanceof HTMLElement)) return null;
  const id = entry.dataset.queueItemId;
  return id && id.length > 0 ? id : null;
}

function getTouchById(list: TouchList, touchId: number): Touch | null {
  for (let i = 0; i < list.length; i++) {
    const touch = list.item(i);
    if (touch?.identifier === touchId) return touch;
  }
  return null;
}

function defaultIsPlaylistVisible(list: HTMLElement): boolean {
  const panel = list.closest<HTMLElement>('.tab-content');
  if (!panel) return true;
  try {
    if (window.matchMedia('(min-width: 1280px)').matches) return true;
  } catch {
    /* matchMedia can be unavailable in jsdom and old browsers. */
  }
  return panel.classList.contains('active');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function createPlaylistReorderController(
  options: PlaylistReorderOptions,
): PlaylistReorderController {
  const { list } = options;
  const scrollContainer = list.closest<HTMLElement>('.tab-body') ?? list;
  const abort = new AbortController();
  const { signal } = abort;

  let drag: DragState | null = null;
  let keyboard: KeyboardState | null = null;
  let settling: SettlingState | null = null;
  let touchProbe: TouchProbeState | null = null;
  let touchHintEntry: HTMLElement | null = null;
  let hintTimer: number | null = null;
  let hintPendingUntilVisible = false;
  let touchHintFrame: number | null = null;
  let touchHintClientX = 0;
  let touchHintClientY = 0;
  let autoScrollFrame: number | null = null;
  let lastScrollAt = Number.NEGATIVE_INFINITY;
  let suppressClicksUntil = 0;
  let scopedClickSuppression: ScopedClickSuppression | null = null;
  let touchSequenceBlocked = false;
  let pendingFocusId: string | null = null;
  let destroyed = false;
  const reflowAnimations = new Map<HTMLElement, Animation>();
  const reflowFrames = new Map<HTMLElement, number>();
  const reflowTimers = new Map<HTMLElement, number>();

  const liveRegion = document.createElement('div');
  liveRegion.className = 'playlist-reorder-live';
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  list.insertAdjacentElement('afterend', liveRegion);

  const isVisible = (): boolean => options.isPlaylistVisible?.() ?? defaultIsPlaylistVisible(list);

  function entries(): HTMLElement[] {
    return Array.from(list.querySelectorAll<HTMLElement>(ENTRY_SELECTOR));
  }

  function entryForId(queueItemId: string): HTMLElement | null {
    return entries().find((entry) => getEntryId(entry) === queueItemId) ?? null;
  }

  function currentBeforeId(sourceEntry: HTMLElement): string | null {
    const all = entries();
    const sourceIndex = all.indexOf(sourceEntry);
    return sourceIndex >= 0 ? getEntryId(all[sourceIndex + 1] ?? null) : null;
  }

  function syncPreviewPositions(): void {
    const all = entries();
    all.forEach((entry, index) => {
      const position = index + 1;
      entry.dataset.playlistIndex = String(index);
      entry.querySelector<HTMLElement>('.track-idx')?.replaceChildren(String(position));
      const handle = entry.querySelector<HTMLElement>(HANDLE_SELECTOR);
      const queueItemId = getEntryId(entry);
      if (!handle || !queueItemId) return;
      handle.setAttribute('aria-posinset', String(position));
      handle.setAttribute('aria-setsize', String(all.length));
      const label = options.getHandleLabel?.(queueItemId, position);
      if (label) handle.setAttribute('aria-label', label);
    });
  }

  function captureEntryRects(): Map<HTMLElement, EntryRect> {
    const rects = new Map<HTMLElement, EntryRect>();
    for (const entry of entries()) {
      const rect = entry.getBoundingClientRect();
      rects.set(entry, { left: rect.left, top: rect.top });
    }
    return rects;
  }

  function clearEntryMotion(entry: HTMLElement): void {
    const animation = reflowAnimations.get(entry);
    if (animation) {
      reflowAnimations.delete(entry);
      animation.cancel();
    }
    const frame = reflowFrames.get(entry);
    if (frame !== undefined) {
      reflowFrames.delete(entry);
      window.cancelAnimationFrame(frame);
    }
    const timer = reflowTimers.get(entry);
    if (timer !== undefined) {
      reflowTimers.delete(entry);
      window.clearTimeout(timer);
    }
    entry.style.removeProperty('transition');
    entry.style.removeProperty('transform');
    entry.style.removeProperty('will-change');
  }

  function clearAllEntryMotion(): void {
    const animatedEntries = new Set<HTMLElement>([
      ...entries(),
      ...reflowAnimations.keys(),
      ...reflowFrames.keys(),
      ...reflowTimers.keys(),
    ]);
    for (const entry of animatedEntries) clearEntryMotion(entry);
  }

  function animateEntriesFromCleanLayout(
    firstRects: Map<HTMLElement, EntryRect>,
    duration = REORDER_REFLOW_MS,
    excludedEntry: HTMLElement | null = null,
  ): void {
    if (duration <= 0 || prefersReducedMotion()) return;

    for (const entry of entries()) {
      if (entry === excludedEntry) continue;
      const first = firstRects.get(entry);
      if (!first) continue;
      const last = entry.getBoundingClientRect();
      // DOMRects are post-transform viewport pixels. CSS transforms on rows
      // are body-local lengths and will be scaled by the desktop body again.
      const deltaX = viewportLengthToBodyCssPixels(first.left - last.left);
      const deltaY = viewportLengthToBodyCssPixels(first.top - last.top);
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;

      const from = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
      const animate = entry.animate;
      if (typeof animate === 'function') {
        const animation = animate.call(entry, [{ transform: from }, { transform: 'none' }], {
          duration,
          easing: REORDER_MOTION_EASING,
        });
        reflowAnimations.set(entry, animation);
        const clearAnimation = (): void => {
          if (reflowAnimations.get(entry) === animation) reflowAnimations.delete(entry);
        };
        animation.onfinish = clearAnimation;
        animation.oncancel = clearAnimation;
        continue;
      }

      entry.style.transition = 'none';
      entry.style.transform = from;
      entry.style.willChange = 'transform';
      void entry.offsetWidth;
      const frame = window.requestAnimationFrame(() => {
        if (reflowFrames.get(entry) !== frame) return;
        reflowFrames.delete(entry);
        entry.style.transition = `transform ${duration}ms ${REORDER_MOTION_EASING}`;
        entry.style.transform = 'translate3d(0, 0, 0)';
        const timer = window.setTimeout(() => {
          if (reflowTimers.get(entry) !== timer) return;
          reflowTimers.delete(entry);
          entry.style.removeProperty('transition');
          entry.style.removeProperty('transform');
          entry.style.removeProperty('will-change');
        }, duration + 32);
        reflowTimers.set(entry, timer);
      });
      reflowFrames.set(entry, frame);
    }
  }

  function moveSourcePreview(sourceEntry: HTMLElement, beforeId: string | null): void {
    if (currentBeforeId(sourceEntry) === beforeId) return;
    const firstRects = captureEntryRects();
    clearAllEntryMotion();
    const savedScrollTop = scrollContainer.scrollTop;
    const beforeEntry = beforeId ? entryForId(beforeId) : null;
    if (beforeEntry && beforeEntry !== sourceEntry) {
      list.insertBefore(sourceEntry, beforeEntry);
    } else if (!beforeId) {
      list.appendChild(sourceEntry);
    }
    if (scrollContainer.scrollTop !== savedScrollTop) scrollContainer.scrollTop = savedScrollTop;
    syncPreviewPositions();
    animateEntriesFromCleanLayout(firstRects);
  }

  function settleEntriesToLayout(sourceEntry: HTMLElement, excludeSource = false): DOMRect {
    const firstRects = captureEntryRects();
    clearAllEntryMotion();
    const row = sourceEntry.querySelector<HTMLElement>(ROW_SELECTOR) ?? sourceEntry;
    const targetRect = row.getBoundingClientRect();
    animateEntriesFromCleanLayout(
      firstRects,
      REORDER_REFLOW_MS,
      excludeSource ? sourceEntry : null,
    );
    return targetRect;
  }

  function reorderable(): boolean {
    return !destroyed && !settling && options.canReorder() && entries().length > 1;
  }

  function clearLongPressTimer(): void {
    if (touchProbe?.longPressTimer !== null && touchProbe?.longPressTimer !== undefined) {
      window.clearTimeout(touchProbe.longPressTimer);
      touchProbe.longPressTimer = null;
    }
  }

  function clearTouchHint(): void {
    if (touchHintFrame !== null) {
      window.cancelAnimationFrame(touchHintFrame);
      touchHintFrame = null;
    }
    touchHintEntry?.classList.remove('is-touch-scroll-hint');
    touchHintEntry = null;
  }

  function clearGlobalHint(): void {
    if (hintTimer !== null) {
      window.clearTimeout(hintTimer);
      hintTimer = null;
    }
    list.classList.remove('show-reorder-hints');
  }

  function showGlobalHint(): void {
    if (!reorderable()) return;
    if (!isVisible()) {
      hintPendingUntilVisible = true;
      return;
    }
    hintPendingUntilVisible = false;
    clearGlobalHint();
    list.classList.add('show-reorder-hints');
    hintTimer = window.setTimeout(() => {
      hintTimer = null;
      list.classList.remove('show-reorder-hints');
    }, PLAYLIST_REORDER_HINT_MS);
  }

  function announce(queueItemId: string, beforeId: string | null): void {
    const remaining = entries().filter((entry) => getEntryId(entry) !== queueItemId);
    const beforeIndex = beforeId
      ? remaining.findIndex((entry) => getEntryId(entry) === beforeId)
      : remaining.length;
    const position = clamp(
      beforeIndex < 0 ? remaining.length + 1 : beforeIndex + 1,
      1,
      remaining.length + 1,
    );
    liveRegion.textContent = '';
    window.requestAnimationFrame(() => {
      if (!destroyed) {
        liveRegion.textContent = options.getAnnouncement(
          queueItemId,
          position,
          remaining.length + 1,
        );
      }
    });
  }

  function originalBeforeId(sourceEntry: HTMLElement): string | null {
    const all = entries();
    const index = all.indexOf(sourceEntry);
    return index >= 0 ? getEntryId(all[index + 1] ?? null) : null;
  }

  function markSource(sourceEntry: HTMLElement): void {
    sourceEntry.classList.add('is-reorder-source');
    sourceEntry.querySelector<HTMLElement>(HANDLE_SELECTOR)?.setAttribute('aria-grabbed', 'true');
  }

  function beforeIdAtY(sourceId: string, clientY: number): string | null {
    const candidates = entries().filter((entry) => getEntryId(entry) !== sourceId);
    const listRect = list.getBoundingClientRect();
    for (const entry of candidates) {
      const row = entry.querySelector<HTMLElement>(ROW_SELECTOR) ?? entry;
      const rect = row.getBoundingClientRect();
      // FLIP temporarily transforms rows from their old visual position into
      // the new slot. Hit testing against that moving box would immediately
      // reverse a just-crossed target. offsetTop/offsetHeight stay anchored to
      // the destination layout, so the swap threshold remains stable while
      // the visible rows glide into place. jsdom has no layout metrics, hence
      // the rect fallback used by the interaction tests.
      const hasLayoutMetrics = entry.offsetHeight > 0 && row.offsetHeight > 0;
      const ownScrollOffset = scrollContainer === list ? list.scrollTop : 0;
      const renderedScale = getBodyRenderedScale();
      const top = hasLayoutMetrics
        ? listRect.top + (entry.offsetTop - ownScrollOffset) * renderedScale
        : rect.top;
      const height = hasLayoutMetrics ? row.offsetHeight * renderedScale : rect.height;
      if (clientY < top + height / 2) return getEntryId(entry);
    }
    return null;
  }

  function updateDragTarget(): void {
    if (!drag) return;
    const beforeId = beforeIdAtY(drag.sourceId, drag.lastClientY);
    if (beforeId === drag.beforeId) return;
    drag.beforeId = beforeId;
    moveSourcePreview(drag.sourceEntry, beforeId);
  }

  function updateGhostPosition(): void {
    if (!drag) return;
    const targetTop = drag.lastClientY - drag.grabOffsetY;
    const translateY = viewportLengthToBodyCssPixels(targetTop - drag.ghostOriginTop);
    drag.ghost.style.transform = `translate3d(0, ${translateY}px, 0) scale(1.015)`;
  }

  function visibleScrollBounds(): { top: number; bottom: number } {
    const rect = scrollContainer.getBoundingClientRect();
    let bottom = rect.bottom;
    const bottomNav = document.querySelector<HTMLElement>('.bottom-nav');
    if (bottomNav) {
      const style = window.getComputedStyle(bottomNav);
      const navRect = bottomNav.getBoundingClientRect();
      const overlapsHorizontally = navRect.right > rect.left && navRect.left < rect.right;
      const overlapsVertically = navRect.bottom > rect.top && navRect.top < rect.bottom;
      if (
        style.display !== 'none' &&
        navRect.height > 0 &&
        overlapsHorizontally &&
        overlapsVertically
      ) {
        bottom = Math.min(bottom, navRect.top);
      }
    }
    return { top: rect.top, bottom };
  }

  function autoScrollStep(): void {
    autoScrollFrame = null;
    if (!drag) return;

    const { top, bottom } = visibleScrollBounds();
    const height = Math.max(1, bottom - top);
    const zone = clamp(height * 0.16, EDGE_ZONE_MIN_PX, EDGE_ZONE_MAX_PX);
    let velocity = 0;
    if (drag.lastClientY < top + zone) {
      const ratio = clamp((top + zone - drag.lastClientY) / zone, 0, 1);
      velocity = -EDGE_SCROLL_MAX_PX * ratio * ratio;
    } else if (drag.lastClientY > bottom - zone) {
      const ratio = clamp((drag.lastClientY - (bottom - zone)) / zone, 0, 1);
      velocity = EDGE_SCROLL_MAX_PX * ratio * ratio;
    }

    if (velocity !== 0) {
      const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      const next = clamp(scrollContainer.scrollTop + velocity, 0, maxScroll);
      if (next !== scrollContainer.scrollTop) {
        scrollContainer.scrollTop = next;
        updateDragTarget();
      }
    }
    autoScrollFrame = window.requestAnimationFrame(autoScrollStep);
  }

  function startAutoScroll(): void {
    if (autoScrollFrame === null) autoScrollFrame = window.requestAnimationFrame(autoScrollStep);
  }

  function stopAutoScroll(): void {
    if (autoScrollFrame !== null) {
      window.cancelAnimationFrame(autoScrollFrame);
      autoScrollFrame = null;
    }
  }

  function makeGhost(row: HTMLElement): { ghost: HTMLElement; originTop: number } {
    const rect = row.getBoundingClientRect();
    const bodyRect = document.body.getBoundingClientRect();
    const renderedScale = getBodyRenderedScale();
    const ghost = row.cloneNode(true) as HTMLElement;
    ghost.classList.remove('active');
    ghost.classList.add('playlist-reorder-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.querySelectorAll<HTMLElement>('[id]').forEach((el) => el.removeAttribute('id'));
    ghost.querySelectorAll<HTMLElement>('button, [tabindex]').forEach((el) => {
      el.setAttribute('tabindex', '-1');
    });
    // A transformed body is the containing block for this fixed descendant.
    // Convert the viewport box back into that body's local CSS coordinate
    // space; otherwise 1.2x/1.5x density scales the position and width twice.
    ghost.style.left = `${(rect.left - bodyRect.left) / renderedScale}px`;
    ghost.style.top = `${(rect.top - bodyRect.top) / renderedScale}px`;
    ghost.style.width = `${rect.width / renderedScale}px`;
    document.body.appendChild(ghost);
    return { ghost, originTop: rect.top };
  }

  function startDrag(
    sourceEntry: HTMLElement,
    clientX: number,
    clientY: number,
    input: DragInput,
    pointerId: number | null,
    touchId: number | null,
  ): void {
    if (!reorderable() || drag || keyboard) return;
    const sourceId = getEntryId(sourceEntry);
    const row = sourceEntry.querySelector<HTMLElement>(ROW_SELECTOR);
    if (!sourceId || !row) return;

    clearLongPressTimer();
    clearTouchHint();
    clearGlobalHint();
    const rowRect = row.getBoundingClientRect();
    const { ghost, originTop: ghostOriginTop } = makeGhost(row);
    drag = {
      sourceId,
      sourceEntry,
      originalBeforeId: originalBeforeId(sourceEntry),
      beforeId: originalBeforeId(sourceEntry),
      input,
      pointerId,
      touchId,
      lastClientX: clientX,
      lastClientY: clientY,
      grabOffsetY: clamp(clientY - rowRect.top, 0, rowRect.height),
      ghost,
      ghostOriginTop,
    };
    list.classList.add('is-reordering');
    scrollContainer.classList.add('is-playlist-reordering');
    document.body.classList.add('playlist-reorder-active');
    markSource(sourceEntry);
    updateGhostPosition();
    startAutoScroll();

    if (input === 'long-press') {
      try {
        navigator.vibrate?.(10);
      } catch {
        /* Haptics are optional. */
      }
    }
  }

  function clearSourceState(sourceEntry: HTMLElement | null): void {
    sourceEntry?.classList.remove(
      'is-reorder-source',
      'is-reorder-settling-source',
      'is-reorder-handoff',
    );
    sourceEntry?.querySelector<HTMLElement>(HANDLE_SELECTOR)?.setAttribute('aria-grabbed', 'false');
  }

  function finishSettling(notify = true): void {
    if (!settling) return;
    const state = settling;
    settling = null;
    if (state.frame !== null) window.cancelAnimationFrame(state.frame);
    if (state.timer !== null) window.clearTimeout(state.timer);
    state.ghost?.remove();
    clearSourceState(state.sourceEntry);
    if (notify && !destroyed) options.onInteractionEnd?.(state.didRequestCommit);
  }

  function beginSettling(
    ghost: HTMLElement | null,
    targetRect: DOMRect | null,
    didRequestCommit: boolean,
    sourceEntry: HTMLElement | null = null,
    releaseRect: DOMRect | null = null,
  ): void {
    finishSettling(false);
    const state: SettlingState = {
      ghost,
      sourceEntry,
      frame: null,
      timer: null,
      didRequestCommit,
    };
    settling = state;

    const reducedMotion = prefersReducedMotion();
    const settleMs =
      Math.max(REORDER_REFLOW_MS, REORDER_DROP_MS, REORDER_HANDOFF_DELAY_MS + REORDER_HANDOFF_MS) +
      REORDER_MOTION_SAFETY_MS;
    const schedule = (delay: number, next: () => void): void => {
      state.timer = window.setTimeout(() => {
        state.timer = null;
        if (settling === state) next();
      }, delay);
    };
    const complete = (): void => finishSettling();
    const beginHandleReturn = (): void => {
      state.ghost?.remove();
      state.ghost = null;
      clearSourceState(state.sourceEntry);
      state.sourceEntry = null;
      // Keep the preview DOM alive while the grip fades back to its number.
      // The authoritative render runs from onInteractionEnd only after this
      // transition, otherwise replaceChildren() would cut it off next frame.
      schedule(REORDER_HANDLE_RETURN_MS + REORDER_MOTION_SAFETY_MS, complete);
    };

    if (reducedMotion) {
      state.ghost?.remove();
      state.ghost = null;
      clearSourceState(state.sourceEntry);
      state.sourceEntry = null;
      // Keep the settle state through the current task so onCommit always runs
      // before onInteractionEnd, even when motion is disabled.
      schedule(0, complete);
      return;
    }

    if (ghost && targetRect && releaseRect) {
      // WebKit can commit a transform reset before a simultaneous top/left
      // transition, briefly exposing the drag origin. Freeze the exact release
      // box, establish it as a rendered baseline, then let one transform own
      // the entire trip to the destination.
      const bodyRect = document.body.getBoundingClientRect();
      const renderedScale = getBodyRenderedScale();
      const targetX = (targetRect.left - releaseRect.left) / renderedScale;
      const targetY = (targetRect.top - releaseRect.top) / renderedScale;
      ghost.style.transition = 'none';
      ghost.style.transformOrigin = '0 0';
      ghost.style.left = `${(releaseRect.left - bodyRect.left) / renderedScale}px`;
      ghost.style.top = `${(releaseRect.top - bodyRect.top) / renderedScale}px`;
      ghost.style.transform = 'translate3d(0px, 0px, 0px) scale(1.015)';
      ghost.classList.remove('playlist-reorder-ghost');
      ghost.classList.add('playlist-reorder-settle');
      void ghost.offsetWidth;
      state.frame = window.requestAnimationFrame(() => {
        if (settling !== state) return;
        ghost.style.removeProperty('transition');
        state.frame = window.requestAnimationFrame(() => {
          if (settling !== state) return;
          state.frame = null;
          ghost.style.opacity = '0';
          ghost.style.transform = `translate3d(${targetX}px, ${targetY}px, 0px) scale(1)`;
          sourceEntry?.classList.add('is-reorder-handoff');
          schedule(settleMs, beginHandleReturn);
        });
      });
      return;
    }

    schedule(settleMs, state.sourceEntry ? beginHandleReturn : complete);
  }

  function cleanupDrag(preserveGhost = false): HTMLElement | null {
    if (!drag) return null;
    const sourceEntry = drag.sourceEntry;
    const ghost = drag.ghost;
    if (!preserveGhost) ghost.remove();
    drag = null;
    if (preserveGhost) {
      sourceEntry
        .querySelector<HTMLElement>(HANDLE_SELECTOR)
        ?.setAttribute('aria-grabbed', 'false');
    } else {
      clearSourceState(sourceEntry);
    }
    stopAutoScroll();
    list.classList.remove('is-reordering');
    scrollContainer.classList.remove('is-playlist-reordering');
    document.body.classList.remove('playlist-reorder-active');
    return preserveGhost ? ghost : null;
  }

  function finishDrag(commit: boolean): void {
    if (!drag) return;
    const state = drag;
    const sourceId = state.sourceId;
    const beforeId = state.beforeId;
    const changed = beforeId !== state.originalBeforeId;
    const shouldCommit = commit && changed && options.canReorder();
    stopAutoScroll();
    const releaseRect = state.ghost.getBoundingClientRect();
    if (!shouldCommit && changed) {
      moveSourcePreview(state.sourceEntry, state.originalBeforeId);
      state.beforeId = state.originalBeforeId;
    }
    state.sourceEntry.classList.add('is-reorder-settling-source');
    const targetRect = settleEntriesToLayout(state.sourceEntry, true);
    const ghost = cleanupDrag(true);
    touchProbe = null;
    suppressClicksUntil = performance.now() + CLICK_SUPPRESSION_MS;
    beginSettling(ghost, targetRect, shouldCommit, state.sourceEntry, releaseRect);
    if (shouldCommit) {
      pendingFocusId = sourceId;
      options.onCommit(sourceId, beforeId);
      announce(sourceId, beforeId);
    }
  }

  function keyboardRemainingIds(sourceId: string): string[] {
    return entries()
      .map((entry) => getEntryId(entry))
      .filter((id): id is string => !!id && id !== sourceId);
  }

  function keyboardPosition(state: KeyboardState): number {
    const remaining = keyboardRemainingIds(state.sourceId);
    if (state.beforeId === null) return remaining.length;
    const index = remaining.indexOf(state.beforeId);
    return index >= 0 ? index : remaining.length;
  }

  function startKeyboard(sourceEntry: HTMLElement): void {
    if (!reorderable() || drag || keyboard) return;
    const sourceId = getEntryId(sourceEntry);
    if (!sourceId) return;
    clearGlobalHint();
    keyboard = {
      sourceId,
      sourceEntry,
      originalBeforeId: originalBeforeId(sourceEntry),
      beforeId: originalBeforeId(sourceEntry),
    };
    list.classList.add('is-keyboard-reordering');
    scrollContainer.classList.add('is-playlist-reordering');
    markSource(sourceEntry);
    announce(sourceId, keyboard.beforeId);
  }

  function moveKeyboard(delta: number | 'home' | 'end'): void {
    if (!keyboard) return;
    const remaining = keyboardRemainingIds(keyboard.sourceId);
    const currentPosition = keyboardPosition(keyboard);
    const nextPosition =
      delta === 'home'
        ? 0
        : delta === 'end'
          ? remaining.length
          : clamp(currentPosition + delta, 0, remaining.length);
    keyboard.beforeId = remaining[nextPosition] ?? null;
    moveSourcePreview(keyboard.sourceEntry, keyboard.beforeId);
    // Reparenting a focused node may blur it in WebKit. Keep subsequent
    // arrow/drop keys owned by the same handle after every preview move.
    keyboard.sourceEntry
      .querySelector<HTMLElement>(HANDLE_SELECTOR)
      ?.focus({ preventScroll: true });
    announce(keyboard.sourceId, keyboard.beforeId);
    keyboard.sourceEntry.scrollIntoView({ block: 'nearest' });
  }

  function cleanupKeyboard(): void {
    if (!keyboard) return;
    const sourceEntry = keyboard.sourceEntry;
    keyboard = null;
    clearSourceState(sourceEntry);
    list.classList.remove('is-keyboard-reordering');
    scrollContainer.classList.remove('is-playlist-reordering');
  }

  function finishKeyboard(commit: boolean): void {
    if (!keyboard) return;
    const state = keyboard;
    const sourceId = state.sourceId;
    const beforeId = state.beforeId;
    const changed = beforeId !== state.originalBeforeId;
    const shouldCommit = commit && changed && options.canReorder();
    const announcedBeforeId = shouldCommit ? beforeId : state.originalBeforeId;
    if (!shouldCommit && changed) {
      moveSourcePreview(state.sourceEntry, state.originalBeforeId);
      state.beforeId = state.originalBeforeId;
    }
    settleEntriesToLayout(state.sourceEntry);
    pendingFocusId = sourceId;
    cleanupKeyboard();
    suppressClicksUntil = performance.now() + CLICK_SUPPRESSION_MS;
    beginSettling(null, null, shouldCommit);
    if (shouldCommit) options.onCommit(sourceId, beforeId);
    announce(sourceId, announcedBeforeId);
  }

  function focusPendingHandle(): void {
    if (!pendingFocusId || destroyed) return;
    const entry = entryForId(pendingFocusId);
    const handle = entry?.querySelector<HTMLElement>(HANDLE_SELECTOR);
    if (!handle) return;
    pendingFocusId = null;
    handle.focus({ preventScroll: true });
  }

  function cancel(): void {
    clearLongPressTimer();
    clearTouchHint();
    touchProbe = null;
    if (drag) finishDrag(false);
    if (keyboard) finishKeyboard(false);
    else if (settling) finishSettling();
  }

  function scheduleTouchHint(clientX: number, clientY: number): void {
    touchHintClientX = clientX;
    touchHintClientY = clientY;
    if (touchHintFrame !== null) return;
    touchHintFrame = window.requestAnimationFrame(() => {
      touchHintFrame = null;
      if (!touchProbe?.scrollConfirmed || drag) return;
      const hit = document.elementFromPoint?.(touchHintClientX, touchHintClientY);
      const entry = hit?.closest<HTMLElement>(ENTRY_SELECTOR) ?? null;
      const next = entry && list.contains(entry) ? entry : null;
      if (touchHintEntry === next) return;
      touchHintEntry?.classList.remove('is-touch-scroll-hint');
      touchHintEntry = next;
      touchHintEntry?.classList.add('is-touch-scroll-hint');
    });
  }

  function onPointerDown(event: PointerEvent): void {
    const target = asElement(event.target);
    const handle = target?.closest<HTMLElement>(HANDLE_SELECTOR);
    if (!handle || !list.contains(handle) || event.button !== 0 || !event.isPrimary) return;
    const entry = handle.closest<HTMLElement>(ENTRY_SELECTOR);
    if (!entry || !reorderable()) return;
    event.preventDefault();
    event.stopPropagation();
    handle.focus({ preventScroll: true });
    try {
      // The source entry is physically reinserted while FLIP opens its new
      // slot. Capturing on that moving handle makes Chromium release capture
      // during the reparent, turning a valid drop into pointercancel. The list
      // is stationary for the whole gesture and therefore owns capture.
      list.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer capture is a reliability boost, not a hard dependency. */
    }
    startDrag(entry, event.clientX, event.clientY, 'handle', event.pointerId, null);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || drag.pointerId === null || event.pointerId !== drag.pointerId) return;
    if (event.cancelable) event.preventDefault();
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;
    updateGhostPosition();
    updateDragTarget();
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || drag.pointerId === null || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    finishDrag(true);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (!drag || drag.pointerId === null || event.pointerId !== drag.pointerId) return;
    finishDrag(false);
  }

  function onTouchStart(event: TouchEvent): void {
    if (touchSequenceBlocked || !reorderable() || drag || keyboard || event.touches.length !== 1) {
      return;
    }
    const target = asElement(event.target);
    const row = target?.closest<HTMLElement>(ROW_SELECTOR);
    const entry = row?.closest<HTMLElement>(ENTRY_SELECTOR);
    if (!row || !entry || !list.contains(entry)) return;
    if (target?.closest(INTERACTIVE_SELECTOR)) return;

    const touch = event.touches.item(0);
    const sourceId = getEntryId(entry);
    if (!touch || !sourceId) return;
    clearTouchHint();
    const momentumActive = performance.now() - lastScrollAt < MOMENTUM_SETTLE_MS;
    touchProbe = {
      touchId: touch.identifier,
      sourceId,
      sourceEntry: entry,
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      startScrollTop: scrollContainer.scrollTop,
      disqualified: momentumActive,
      suppressClickOnEnd: momentumActive,
      scrollConfirmed: false,
      longPressTimer: null,
    };
    if (!momentumActive) {
      touchProbe.longPressTimer = window.setTimeout(() => {
        const probe = touchProbe;
        if (!probe) return;
        probe.longPressTimer = null;
        const scrollChanged = scrollContainer.scrollTop !== probe.startScrollTop;
        const momentumActiveNow = performance.now() - lastScrollAt < MOMENTUM_SETTLE_MS;
        if (scrollChanged || momentumActiveNow) {
          probe.disqualified = true;
          probe.suppressClickOnEnd = true;
        }
        if (probe.disqualified) return;
        startDrag(probe.sourceEntry, probe.lastX, probe.lastY, 'long-press', null, probe.touchId);
      }, PLAYLIST_LONG_PRESS_MS);
    }
  }

  function onTouchMove(event: TouchEvent): void {
    if (drag?.touchId !== null && drag?.touchId !== undefined) {
      const touch = getTouchById(event.touches, drag.touchId);
      if (!touch) return;
      if (event.cancelable) event.preventDefault();
      drag.lastClientX = touch.clientX;
      drag.lastClientY = touch.clientY;
      updateGhostPosition();
      updateDragTarget();
      return;
    }
    if (!touchProbe) return;
    const touch = getTouchById(event.touches, touchProbe.touchId);
    if (!touch) return;
    touchProbe.lastX = touch.clientX;
    touchProbe.lastY = touch.clientY;
    const distance = Math.hypot(
      touch.clientX - touchProbe.startX,
      touch.clientY - touchProbe.startY,
    );
    if (distance >= PLAYLIST_TOUCH_MOVE_TOLERANCE_PX) {
      touchProbe.suppressClickOnEnd = true;
    }
    if (scrollContainer.scrollTop !== touchProbe.startScrollTop) {
      touchProbe.suppressClickOnEnd = true;
    }
    if (
      distance >= PLAYLIST_TOUCH_MOVE_TOLERANCE_PX ||
      scrollContainer.scrollTop !== touchProbe.startScrollTop
    ) {
      touchProbe.disqualified = true;
      clearLongPressTimer();
    }
    if (touchProbe.scrollConfirmed) scheduleTouchHint(touch.clientX, touch.clientY);
  }

  function finishTouch(commit: boolean, event: TouchEvent): void {
    if (drag?.touchId !== null && drag?.touchId !== undefined) {
      const ended = getTouchById(event.changedTouches, drag.touchId);
      if (ended) finishDrag(commit);
    }
    if (touchProbe) {
      const ended = getTouchById(event.changedTouches, touchProbe.touchId);
      if (ended) {
        const sourceId = touchProbe.sourceId;
        const shouldSuppressClick = commit && touchProbe.suppressClickOnEnd;
        clearLongPressTimer();
        touchProbe = null;
        if (shouldSuppressClick) {
          scopedClickSuppression = {
            sourceId,
            until: performance.now() + CLICK_SUPPRESSION_MS,
          };
        }
      }
    }
    clearTouchHint();
  }

  function onDocumentTouchStart(event: TouchEvent): void {
    if (event.touches.length <= 1) return;
    touchSequenceBlocked = true;
    clearTouchHint();
    if (touchProbe) {
      touchProbe.disqualified = true;
      touchProbe.suppressClickOnEnd = true;
      clearLongPressTimer();
    }
    if (drag) finishDrag(false);
  }

  function onDocumentTouchFinish(event: TouchEvent): void {
    if (event.touches.length === 0) touchSequenceBlocked = false;
  }

  function onScroll(): void {
    lastScrollAt = performance.now();
    if (!touchProbe || drag) return;
    touchProbe.disqualified = true;
    touchProbe.suppressClickOnEnd = true;
    touchProbe.scrollConfirmed = true;
    clearLongPressTimer();
    scheduleTouchHint(touchProbe.lastX, touchProbe.lastY);
  }

  function onKeyDown(event: KeyboardEvent): void {
    const target = asElement(event.target);
    const handle = target?.closest<HTMLElement>(HANDLE_SELECTOR);
    if (!handle || !list.contains(handle)) return;
    const entry = handle.closest<HTMLElement>(ENTRY_SELECTOR);
    if (!entry) return;

    if (!keyboard) {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      startKeyboard(entry);
      return;
    }
    if (getEntryId(entry) !== keyboard.sourceId) return;

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        moveKeyboard(-1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveKeyboard(1);
        break;
      case 'Home':
        event.preventDefault();
        moveKeyboard('home');
        break;
      case 'End':
        event.preventDefault();
        moveKeyboard('end');
        break;
      case ' ':
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        finishKeyboard(true);
        break;
      case 'Escape':
        event.preventDefault();
        finishKeyboard(false);
        break;
      case 'Tab':
        // Let focus advance normally, but never leave a hidden keyboard grab
        // active after its owning handle loses focus.
        finishKeyboard(false);
        break;
    }
  }

  function onDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || (!drag && !keyboard)) return;
    event.preventDefault();
    cancel();
  }

  function onClickCapture(event: MouseEvent): void {
    const target = asElement(event.target);
    let shouldSuppressScopedClick = false;
    if (scopedClickSuppression) {
      if (performance.now() >= scopedClickSuppression.until) {
        scopedClickSuppression = null;
      } else {
        const clickedEntry = target?.closest<HTMLElement>(ENTRY_SELECTOR) ?? null;
        if (getEntryId(clickedEntry) === scopedClickSuppression.sourceId) {
          shouldSuppressScopedClick = true;
          scopedClickSuppression = null;
        }
      }
    }
    if (
      target?.closest(HANDLE_SELECTOR) ||
      performance.now() < suppressClicksUntil ||
      shouldSuppressScopedClick
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  list.addEventListener('pointerdown', onPointerDown, { signal });
  list.addEventListener('pointermove', onPointerMove, { signal });
  list.addEventListener('pointerup', onPointerUp, { signal });
  list.addEventListener('pointercancel', onPointerCancel, { signal });
  list.addEventListener('lostpointercapture', onPointerCancel, { signal });
  list.addEventListener('touchstart', onTouchStart, { passive: true, signal });
  list.addEventListener('touchmove', onTouchMove, { passive: false, signal });
  list.addEventListener('touchend', (event) => finishTouch(true, event), { signal });
  list.addEventListener('touchcancel', (event) => finishTouch(false, event), { signal });
  list.addEventListener('keydown', onKeyDown, { signal });
  list.addEventListener('click', onClickCapture, { capture: true, signal });
  scrollContainer.addEventListener('scroll', onScroll, { passive: true, signal });
  document.addEventListener('touchstart', onDocumentTouchStart, {
    capture: true,
    passive: true,
    signal,
  });
  document.addEventListener('touchend', onDocumentTouchFinish, { capture: true, signal });
  document.addEventListener('touchcancel', onDocumentTouchFinish, { capture: true, signal });
  document.addEventListener('keydown', onDocumentKeyDown, { signal });
  window.addEventListener('blur', cancel, { signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState !== 'visible') cancel();
    },
    { signal },
  );

  return {
    get isActive() {
      return !!drag || !!keyboard || !!settling;
    },
    get isSettling() {
      return !!settling;
    },
    cancel,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancel();
      finishSettling(false);
      clearAllEntryMotion();
      clearGlobalHint();
      clearTouchHint();
      stopAutoScroll();
      scrollContainer.classList.remove('is-playlist-reordering');
      abort.abort();
      liveRegion.remove();
    },
    afterRender() {
      syncPreviewPositions();
      focusPendingHandle();
      if (hintPendingUntilVisible && isVisible()) showGlobalHint();
    },
    notifyItemsAdded() {
      hintPendingUntilVisible = true;
      if (isVisible()) showGlobalHint();
    },
    notifyPlaylistEntered() {
      showGlobalHint();
    },
    notifyPlaylistHidden() {
      cancel();
      clearTouchHint();
    },
  };
}
