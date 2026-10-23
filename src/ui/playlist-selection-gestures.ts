/**
 * MUSIXQUARE — Playlist drag selection
 *
 * Two range-selection gestures for the playlist's edit mode, in the manner of
 * iOS Mail and Files:
 *
 * - Pressing a row's check circle and dragging along the check column sets
 *   every row the pointer passes to the opposite of the first row's state
 *   (select from an unselected row, deselect from a selected one). Mouse, pen
 *   and touch share Pointer Events; the column is `touch-action: none`, so it
 *   never starts a native scroll.
 * - On touch screens, two fingers moving vertically over the list set every
 *   row between the starting row and the current one the same way: selected
 *   from an unselected starting row, deselected from a selected one. While
 *   they move, native scrolling (and zoom, which the app shell already
 *   blocks) is prevented; one-finger scrolling is untouched.
 *
 * Both gestures recompute the selection from the selection that existed when
 * they began, so moving back un-selects rows the gesture added. Holding near
 * the visible pane's top or bottom edge auto-scrolls by the same rules as a
 * reorder drag (playlist-motion.ts). A short press without movement is left
 * to the check circle's own click.
 */

import type { QueueItemId } from '../types/index.ts';
import { PLAYLIST_MOVE_TOLERANCE_PX, edgeAutoScrollVelocity } from './playlist-motion.ts';

const SELECT_BUTTON_SELECTOR = '.btn-playlist-select[data-queue-item-id]';
const ENTRY_SELECTOR = '.playlist-entry';
/** A larger change in finger spread than this reads as a pinch, not a pan. */
const PINCH_SPREAD_PX = 48;
/** The click that ends a range drag; a reorder drop suppresses its own for longer. */
const RANGE_DRAG_CLICK_SUPPRESSION_MS = 400;

interface PlaylistSelectionGestureOptions {
  list: HTMLElement;
  canSelect: () => boolean;
  isSelected: (queueItemId: QueueItemId) => boolean;
  toggle: (queueItemId: QueueItemId) => void;
}

interface Gesture {
  startClientY: number;
  topEdgeArmed: boolean;
  bottomEdgeArmed: boolean;
  kind: 'pointer' | 'two-finger';
  /** The check-column drag's pointer, or the pan's two touches. */
  pointerId: number;
  touchIds: readonly [number, number] | null;
  anchorId: QueueItemId;
  startSpread: number;
  lastClientY: number;
  /** Set once the press has moved far enough to become a drag. */
  base: ReadonlySet<QueueItemId> | null;
  selecting: boolean;
  lastRangeKey: string;
}

interface Row {
  queueItemId: QueueItemId;
  top: number;
  bottom: number;
}

function touchById(touches: TouchList, identifier: number): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch?.identifier === identifier) return touch;
  }
  return null;
}

export function installPlaylistSelectionGestures(
  options: PlaylistSelectionGestureOptions,
): () => void {
  const { list } = options;
  const scrollContainer = list.closest<HTMLElement>('.tab-body') ?? list;
  const abort = new AbortController();
  const { signal } = abort;
  let gesture: Gesture | null = null;
  let autoScrollFrame = 0;
  let suppressClicksUntil = 0;

  function rows(): Row[] {
    return Array.from(list.querySelectorAll<HTMLElement>(SELECT_BUTTON_SELECTOR), (button) => {
      const rect = (button.closest(ENTRY_SELECTOR) ?? button).getBoundingClientRect();
      return { queueItemId: button.dataset.queueItemId!, top: rect.top, bottom: rect.bottom };
    });
  }

  function rowIndexAt(all: readonly Row[], y: number): number {
    // Rows are in document order; a point in a gap belongs to the row below.
    const index = all.findIndex((row) => y < row.bottom);
    return index < 0 ? all.length - 1 : index;
  }

  function rowIdAt(y: number): QueueItemId | null {
    const all = rows();
    return all.length ? all[rowIndexAt(all, y)]!.queueItemId : null;
  }

  function applyRange(): void {
    const state = gesture;
    if (!state?.base) return;
    const all = rows();
    const anchor = all.findIndex((row) => row.queueItemId === state.anchorId);
    // A render that drops the anchor row ends the gesture where it stands.
    if (anchor < 0 || !options.canSelect()) {
      end();
      return;
    }
    const current = rowIndexAt(all, state.lastClientY);
    const from = Math.min(anchor, current);
    const to = Math.max(anchor, current);
    const rangeKey = `${from}:${to}:${all.length}`;
    if (rangeKey === state.lastRangeKey) return;
    state.lastRangeKey = rangeKey;
    // Additions first, so a gesture never empties the selection (which
    // would end edit mode) on its way to a non-empty one.
    const changes = all
      .map((row, index) => ({
        queueItemId: row.queueItemId,
        selected: index >= from && index <= to ? state.selecting : state.base!.has(row.queueItemId),
      }))
      .filter((change) => change.selected !== options.isSelected(change.queueItemId))
      .sort((a, b) => Number(b.selected) - Number(a.selected));
    for (const change of changes) options.toggle(change.queueItemId);
  }

  function begin(state: Gesture): void {
    state.base = new Set(
      rows()
        .map((row) => row.queueItemId)
        .filter((queueItemId) => options.isSelected(queueItemId)),
    );
    state.topEdgeArmed = false;
    state.bottomEdgeArmed = false;
    applyRange();
    syncAutoScroll();
  }

  function move(y: number): void {
    if (!gesture) return;
    gesture.lastClientY = y;
    applyRange();
    syncAutoScroll();
  }

  function stopAutoScroll(): void {
    if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = 0;
  }

  function autoScrollStep(): void {
    autoScrollFrame = 0;
    const state = gesture;
    if (!state?.base) return;
    const velocity = edgeAutoScrollVelocity(scrollContainer, state);
    if (velocity === 0) return;
    const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    const next = Math.min(maxScroll, Math.max(0, scrollContainer.scrollTop + velocity));
    if (next !== scrollContainer.scrollTop) {
      scrollContainer.scrollTop = next;
      applyRange();
    }
    autoScrollFrame = requestAnimationFrame(autoScrollStep);
  }

  function syncAutoScroll(): void {
    const state = gesture;
    if (!state?.base || edgeAutoScrollVelocity(scrollContainer, state) === 0) {
      stopAutoScroll();
      return;
    }
    if (!autoScrollFrame) autoScrollFrame = requestAnimationFrame(autoScrollStep);
  }

  function end(): void {
    const state = gesture;
    gesture = null;
    stopAutoScroll();
    if (!state) return;
    if (state.kind === 'pointer') {
      try {
        if (list.hasPointerCapture(state.pointerId)) list.releasePointerCapture(state.pointerId);
      } catch {
        /* Capture may already be gone with the pointer. */
      }
    }
    // The press that became a drag must not also toggle or play a row.
    if (state.base) suppressClicksUntil = performance.now() + RANGE_DRAG_CLICK_SUPPRESSION_MS;
  }

  function newGesture(
    kind: Gesture['kind'],
    anchorId: QueueItemId,
    y: number,
    selecting: boolean,
  ): Gesture {
    return {
      kind,
      pointerId: -1,
      touchIds: null,
      anchorId,
      startClientY: y,
      startSpread: 0,
      lastClientY: y,
      base: null,
      selecting,
      lastRangeKey: '',
      topEdgeArmed: false,
      bottomEdgeArmed: false,
    };
  }

  // ── Check-column drag (mouse, pen and touch) ──────────────────────────
  list.addEventListener(
    'pointerdown',
    (event) => {
      if (gesture || !event.isPrimary || event.button !== 0 || !options.canSelect()) return;
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest<HTMLElement>(SELECT_BUTTON_SELECTOR);
      const anchorId = button?.dataset.queueItemId;
      if (!button || !anchorId || !list.contains(button)) return;
      gesture = newGesture('pointer', anchorId, event.clientY, !options.isSelected(anchorId));
      gesture.pointerId = event.pointerId;
    },
    { signal },
  );

  document.addEventListener(
    'pointermove',
    (event) => {
      const state = gesture;
      if (state?.kind !== 'pointer' || event.pointerId !== state.pointerId) return;
      if (!state.base) {
        if (Math.abs(event.clientY - state.startClientY) < PLAYLIST_MOVE_TOLERANCE_PX) return;
        try {
          // Rows keep receiving the drag when it leaves the narrow column.
          list.setPointerCapture(event.pointerId);
        } catch {
          /* Capture is a reliability boost, not a requirement. */
        }
        state.lastClientY = event.clientY;
        begin(state);
        return;
      }
      if (event.cancelable) event.preventDefault();
      move(event.clientY);
    },
    { capture: true, signal },
  );

  for (const type of ['pointerup', 'pointercancel'] as const) {
    document.addEventListener(
      type,
      (event) => {
        if (gesture?.kind === 'pointer' && event.pointerId === gesture.pointerId) end();
      },
      { capture: true, signal },
    );
  }

  document.addEventListener(
    'selectstart',
    (event) => {
      if (gesture) event.preventDefault();
    },
    { capture: true, signal },
  );

  // ── Two-finger pan (touch) ───────────────────────────────────────────
  list.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length > 2) {
        end();
        return;
      }
      if (event.touches.length !== 2 || gesture?.kind === 'two-finger') return;
      // A second finger ends a check-column drag; the pair starts over.
      end();
      if (!options.canSelect()) return;
      const first = event.touches.item(0)!;
      const second = event.touches.item(1)!;
      if (!list.contains(first.target as Node) || !list.contains(second.target as Node)) return;
      const midY = (first.clientY + second.clientY) / 2;
      const anchorId = rowIdAt(midY);
      if (!anchorId) return;
      const state = newGesture('two-finger', anchorId, midY, !options.isSelected(anchorId));
      state.touchIds = [first.identifier, second.identifier];
      state.startSpread = Math.hypot(
        first.clientX - second.clientX,
        first.clientY - second.clientY,
      );
      gesture = state;
    },
    { passive: true, signal },
  );

  list.addEventListener(
    'touchmove',
    (event) => {
      const state = gesture;
      if (state?.kind !== 'two-finger' || !state.touchIds) return;
      const first = touchById(event.touches, state.touchIds[0]);
      const second = touchById(event.touches, state.touchIds[1]);
      if (!first || !second) return;
      if (!event.cancelable) {
        // The page is already scrolling natively; never fight it.
        if (!state.base) gesture = null;
        return;
      }
      event.preventDefault();
      const midY = (first.clientY + second.clientY) / 2;
      if (!state.base) {
        const spread = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
        if (Math.abs(spread - state.startSpread) > PINCH_SPREAD_PX) {
          gesture = null;
          return;
        }
        if (Math.abs(midY - state.startClientY) < PLAYLIST_MOVE_TOLERANCE_PX) return;
        state.lastClientY = midY;
        begin(state);
        return;
      }
      move(midY);
    },
    { passive: false, signal },
  );

  for (const type of ['touchend', 'touchcancel'] as const) {
    document.addEventListener(
      type,
      (event) => {
        const state = gesture;
        if (state?.kind !== 'two-finger' || !state.touchIds) return;
        const ids = state.touchIds;
        if (Array.from(event.changedTouches).some((touch) => ids.includes(touch.identifier))) {
          end();
        }
      },
      { capture: true, signal },
    );
  }

  document.addEventListener(
    'click',
    (event) => {
      if (performance.now() >= suppressClicksUntil) return;
      if (!(event.target instanceof Node) || !list.contains(event.target)) return;
      suppressClicksUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true, signal },
  );

  return () => {
    end();
    abort.abort();
  };
}
