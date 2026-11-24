import type { PlaylistItem, QueueItemId } from '../types/index.ts';
import { t } from '../i18n/index.ts';
import { setControlHint } from './control-hint.ts';
import type { PlaylistSelectionMorph } from './playlist-selection-morph.ts';
import { PLAYLIST_ROW_EASING, prefersReducedMotion } from './playlist-motion.ts';
import { getBodyRenderedScale } from '../core/platform.ts';
import { scrollToWithPreferredMotion } from './scroll-motion.ts';

const SELECT_BUTTON_SELECTOR = '.btn-playlist-select[data-queue-item-id]';
/** The visible count title, which also names the selection bar. */
const SELECTION_TITLE_ID = 'playlist-selection-title';
const ENTRY_SELECTOR = ':scope > .playlist-entry[data-queue-item-id]';

/**
 * Survivors glide into the rows the deleted ones left. The selection pills'
 * morph (playlist-selection-morph.ts) is a different motion with its own time.
 */
const GLIDE_MS = 300;
/** Deleted rows slide out toward the inline end; survivors close up behind them. */
const EXIT_MS = 260;
const EXIT_EASING = 'cubic-bezier(0.5, 0, 0.75, 0)';
/** The copies are gone from sight before what follows moves in. */
const EXIT_FADE_MS = 200;
const EXIT_FADE_EASING = 'cubic-bezier(0.3, 0, 0.6, 1)';
const EXIT_STAGGER_MS = 24;
const EXIT_STAGGER_LIMIT = 8;
/** The pills shrink and fade where they are when the mode ends. */
const BAR_EXIT_MS = 220;
const BAR_EXIT_EASING = 'cubic-bezier(0.4, 0, 0.9, 0.6)';
/**
 * The bar takes room under the last track, and that room goes with the bar.
 * The removal scrolls into it when the bar would cover a selected track and
 * back out before it goes, with the browser's smooth scroll: about 0.13 s in
 * Chromium and 0.09 s in WebKit for the bar's 84 px (measured 2026-11-24),
 * inside the pills' fade. A render stops such a scroll, and the removal starts
 * it again, and a slower exit scroll keeps the faded bar and its room until
 * it arrives, but neither past this time from the scroll's start, so a
 * scroll that never arrives cannot hold the list or the room.
 */
const ROOM_SCROLL_LIMIT_MS = 600;
/**
 * A phone toast that moves above the bar keeps this far from it, the same
 * gap the fallback in css/style.css keeps above the floating bar (the layout
 * contract test pins the two together).
 */
export const TOAST_CLEARANCE_PX = 16;
/** The tab header crossfades between its normal and selection controls. */
const HEADER_FADE_OUT_MS = 180;
const HEADER_FADE_IN_MS = 240;
// The header's own curve. It equals the row easing today but is not a row
// motion, so it stays here.
const HEADER_FADE_IN_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/**
 * Remote paths (PRO server, Standard host) answer asynchronously. Keep the
 * deleted rows hidden until the canonical playlist drops them, but give a
 * rejected or lost request back to the list instead of hiding it forever.
 */
const REMOTE_CONFIRMATION_TIMEOUT_MS = 10_000;

interface PlaylistRemovalControllerOptions {
  list: HTMLElement;
  canRemove: () => boolean;
  isPlaylistVisible: () => boolean;
  /** Canonical playlist, including rows hidden while a removal is confirmed. */
  getItems: () => readonly PlaylistItem[];
  onDelete: (queueItemIds: QueueItemId[]) => void;
  /**
   * The canonical playlist no longer holds any row of a deletion this
   * controller sent. Only the deleting device hears this.
   */
  onDeleted?: (count: number) => void;
  /** The set of hidden rows changed; the owner must re-render the list. */
  onHiddenChange?: () => void;
  /**
   * True when `onDelete` updates the canonical playlist synchronously (the
   * Standard host). Remote deletions keep their rows hidden until the
   * authoritative snapshot removes them.
   */
  isRemovalLocal?: () => boolean;
  onSelectionStart?: () => void;
  onSelectionEnd?: () => void;
  /**
   * Delete was tapped: the owner finishes any other row motion (a reorder's
   * drop settle) before the leaving rows are copied, so the list renders the
   * deletion at once and the survivors glide from where they are.
   */
  onBeforeDelete?: () => void;
  /** True when the room has other playlists to copy or move tracks to. */
  canMove?: () => boolean;
  /** Open the move dialog for the selected tracks, in playlist order. */
  onMove?: (queueItemIds: readonly QueueItemId[]) => void;
}

export interface PlaylistRemovalController {
  readonly isActive: boolean;
  /** The selection has ended, but its bar, and the room it takes, are still going. */
  readonly isLeaving: boolean;
  isSelected(queueItemId: QueueItemId): boolean;
  /** Rows the list must not render while their remote removal is confirmed. */
  isHidden(queueItemId: QueueItemId): boolean;
  toggle(queueItemId: QueueItemId): void;
  afterRender(): void;
  cancel(options?: { restoreFocus?: boolean }): void;
  notifyPlaylistHidden(focusTarget?: HTMLElement | null): void;
  destroy(): void;
}

type BarState = 'hidden' | 'select' | 'leaving';

function canAnimate(element: Element): boolean {
  return typeof (element as HTMLElement).animate === 'function' && !prefersReducedMotion();
}

function forcedColors(): boolean {
  try {
    return window.matchMedia('(forced-colors: active)').matches;
  } catch {
    return false;
  }
}

function createBar(list: HTMLElement): {
  bar: HTMLElement;
  moveButton: HTMLButtonElement;
  deleteButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
} {
  const bar = document.createElement('div');
  bar.className = 'playlist-selection-bar';
  bar.setAttribute('role', 'group');
  bar.hidden = true;
  // Material Symbols "place_item" (its own 960 grid) and Material "delete"
  // and "close" icons; their names come from renderBarLabels.
  bar.innerHTML = `
    <button type="button" class="playlist-selection-action playlist-selection-move" data-selection-action="move" hidden><svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M200-120q-33 0-56.5-23.5T120-200v-400q0-33 23.5-56.5T200-680h160v80H200v400h560v-400H600v-80h160q33 0 56.5 23.5T840-600v400q0 33-23.5 56.5T760-120H200Zm280-200L320-480l56-56 64 63v-487h80v487l64-63 56 56-160 160Z"/></svg></button>
    <button type="button" class="playlist-selection-action playlist-selection-delete" data-selection-action="delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
    <button type="button" class="playlist-selection-action playlist-selection-cancel" data-selection-action="cancel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12Z"/></svg></button>`;
  // The bar follows the last track in the scrolling list body; CSS makes it
  // sticky, so a list taller than the view keeps it floating at the bottom.
  list.insertAdjacentElement('afterend', bar);
  return {
    bar,
    moveButton: bar.querySelector<HTMLButtonElement>('.playlist-selection-move')!,
    deleteButton: bar.querySelector<HTMLButtonElement>('.playlist-selection-delete')!,
    cancelButton: bar.querySelector<HTMLButtonElement>('.playlist-selection-cancel')!,
  };
}

function createHeaderControls(container: Element | null): {
  header: HTMLElement | null;
  title: HTMLElement | null;
  status: HTMLElement | null;
  toggleButton: HTMLButtonElement | null;
} {
  const header = container?.querySelector<HTMLElement>(':scope > .tab-header') ?? null;
  if (!header) return { header: null, title: null, status: null, toggleButton: null };
  const title = document.createElement('span');
  title.className = 'tab-title playlist-selection-title';
  title.id = SELECTION_TITLE_ID;
  title.hidden = true;
  // Sighted users read the count here; the status cell below is the one copy
  // a screen reader meets. aria-labelledby still names the bar from it.
  title.setAttribute('aria-hidden', 'true');
  const baseTitle = header.querySelector(':scope > .tab-title');
  if (baseTitle) baseTitle.after(title);
  else header.prepend(title);
  // The count is announced from a screen-reader cell that stays in the
  // accessibility tree for the controller's life. The title appears with the
  // mode, and a region that appears and fills at once often goes unheard.
  const status = document.createElement('span');
  status.className = 'sr-only playlist-selection-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  title.after(status);

  const toggleButton = document.createElement('button');
  toggleButton.type = 'button';
  toggleButton.className = 'playlist-selection-toggle';
  toggleButton.dataset.selectionAction = 'select-all';
  toggleButton.hidden = true;
  (header.querySelector(':scope > .playlist-title-area') ?? header).appendChild(toggleButton);
  return { header, title, status, toggleButton };
}

function queueItemIdFromButton(button: Element | null): QueueItemId | null {
  if (!(button instanceof HTMLElement)) return null;
  return button.dataset.queueItemId || null;
}

/**
 * Multi-select deletion for the playlist.
 *
 * Selecting a row's check circle enters edit mode: the tab title becomes the
 * selected count, one text button toggles select all, and a trash/close icon
 * pair follows the last track. Selected rows share one fill, and CSS joins
 * consecutive ones into a single block. Dragging along the check column or
 * panning with two fingers selects ranges (playlist-selection-gestures.ts,
 * loaded after start). Delete sends `onDelete` at once through the PRO,
 * Standard guest/operator or host removal path and ends the mode. Whenever
 * the mode ends, the bar slides down and fades out as one unit.
 *
 * Remote paths keep the deleted rows hidden until the authoritative playlist
 * drops them (at most REMOTE_CONFIRMATION_TIMEOUT_MS; rows of a rejected or
 * lost request come back). `onDeleted` reports a deletion once none of its
 * rows remain, so a refused request never reads as done.
 */
export function createPlaylistRemovalController(
  options: PlaylistRemovalControllerOptions,
): PlaylistRemovalController {
  const { list } = options;
  const container = list.closest('#tab-playlist') ?? list.parentElement;
  const selectedQueueItemIds = new Set<QueueItemId>();
  const { bar, moveButton, deleteButton, cancelButton } = createBar(list);
  const { header, title, status, toggleButton } = createHeaderControls(container);
  // The bar reads as the visible count: "2 selected: Move, Delete, Cancel".
  if (title) bar.setAttribute('aria-labelledby', title.id);
  const abortController = new AbortController();
  let lastTriggerQueueItemId: QueueItemId | null = null;
  let wasSelectionActive = false;
  let destroyed = false;
  let barState: BarState = 'hidden';
  let barAnimations: Animation[] = [];
  let barExitTimer = 0;
  /** The list body the bar floats in; it scrolls to make and close the bar's room. */
  const scroller = list.closest<HTMLElement>('.tab-body');
  /**
   * The removal's own smooth scroll into the bar's room (a reveal) or out of
   * it (an exit): its target, and until when a render that stops it starts it
   * again. A press, wheel or key on the list body ends it.
   */
  let roomScroll: { kind: 'reveal' | 'exit'; top: number; until: number } | null = null;
  /** A deletion closes its room once the pills have faded, as its survivors move. */
  let closeRoomAfterFade = false;
  let roomExitFrame = 0;
  /** Primary presses down on the list; room for a selection one made waits for it. */
  const pressedPointers = new Set<number>();
  let revealAfterPress = false;
  let revealFrame = 0;
  /** The release of a press that started the mode has not sent its click yet. */
  let releaseClickPending = false;
  /** The mode ended while the bar leaves; its owner hears once the room is gone. */
  let selectionEndPending = false;
  let exitLayer: HTMLElement | null = null;
  let headerFadeLayer: HTMLElement | null = null;
  let headerFadeTimer = 0;
  /** The toast keeps clear of the bar while it is up (keepToastClear). */
  const toast = document.getElementById('toast');
  let toastClearBottom: string | null = null;
  let toastClearObserver: ResizeObserver | null = null;
  // Selection blocks morph as whole pills once this loads after the list
  // mounts (docs/design/initial-bundle-loading-policy.md); until then, and
  // with reduced motion or forced colors, each row's fill changes in place.
  let morph: PlaylistSelectionMorph | null = null;
  void import('./playlist-selection-morph.ts').then(
    ({ createPlaylistSelectionMorph }) => {
      if (!destroyed) morph = createPlaylistSelectionMorph(list);
    },
    () => {},
  );

  /** Note the drawn blocks before a selection change; false if none can morph. */
  function captureMorph(): boolean {
    if (!morph || !options.isPlaylistVisible() || !canAnimate(list) || forcedColors()) {
      return false;
    }
    morph.capture();
    return true;
  }
  let exitTimer = 0;
  /** Survivors' offsets from their old rows while they glide into place. */
  let glide: {
    offsets: ReadonlyMap<string, number | null>;
    startedAt: number;
    delay: number;
  } | null = null;

  interface SentDeletion {
    queueItemIds: ReadonlySet<QueueItemId>;
    /** Remote removals hide their rows until the room confirms them. */
    hidden: boolean;
    timer: number;
  }
  const sentDeletions: SentDeletion[] = [];

  function canonicalItems(): readonly PlaylistItem[] {
    return options.getItems();
  }

  function isHidden(queueItemId: QueueItemId): boolean {
    return sentDeletions.some(
      (deletion) => deletion.hidden && deletion.queueItemIds.has(queueItemId),
    );
  }

  function visibleItems(): readonly PlaylistItem[] {
    const items = canonicalItems();
    if (!sentDeletions.some((deletion) => deletion.hidden)) return items;
    return items.filter((item) => !isHidden(item.queueItemId));
  }

  function focusRow(queueItemId: QueueItemId | null): void {
    if (!options.isPlaylistVisible()) return;
    if (queueItemId) {
      const button = list.querySelector<HTMLButtonElement>(
        `${SELECT_BUTTON_SELECTOR}[data-queue-item-id="${queueItemId}"]`,
      );
      if (button) {
        button.focus();
        return;
      }
    }
    list.tabIndex = -1;
    list.focus();
  }

  /**
   * Release focus from a pill that is about to go away. Returns whether it
   * held focus so the caller can hand it to a row once the list is rebuilt.
   */
  function takeControlFocus(): boolean {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !bar.contains(activeElement)) return false;
    activeElement.blur();
    return true;
  }

  /** Give focus taken from a pill to a row, but never into a hidden list. */
  function releaseControlFocus(queueItemId: QueueItemId | null): void {
    if (options.isPlaylistVisible()) focusRow(queueItemId);
  }

  function stopBarAnimations(): void {
    for (const animation of barAnimations) animation.cancel();
    barAnimations = [];
    if (barExitTimer) window.clearTimeout(barExitTimer);
    barExitTimer = 0;
    if (roomExitFrame) window.cancelAnimationFrame(roomExitFrame);
    roomExitFrame = 0;
  }

  /** The bar's top, in viewport pixels, once its entrance slide has settled. */
  function restingBarTop(scale: number): number {
    const top = bar.getBoundingClientRect().top;
    if (typeof DOMMatrixReadOnly !== 'function') return top;
    try {
      // The slide's offset is in the bar's own CSS pixels.
      return top - new DOMMatrixReadOnly(getComputedStyle(bar).transform).m42 * scale;
    } catch {
      return top;
    }
  }

  /**
   * A phone toast keeps clear of the bar. On a long list the bar floats above
   * the nav, but on a short one it follows the last track, so no single place
   * suits the toast: while the bar is up the toast stays at its usual place
   * unless the bar comes within TOAST_CLEARANCE_PX of it there, and then sits
   * that far above the bar's top. The toast's own height counts, so a message
   * long enough to reach the bar moves too. CSS applies the place on a phone
   * only (css/style.css), and falls back to the floating bar's when unset.
   */
  function keepToastClear(): void {
    if (!toast) return;
    let value: string | null = null;
    const rest =
      barState === 'select'
        ? Number.parseFloat(getComputedStyle(toast).getPropertyValue('--toast-rest-bottom'))
        : Number.NaN;
    if (Number.isFinite(rest)) {
      const scale = getBodyRenderedScale();
      const barTop = restingBarTop(scale);
      const barBottom = barTop + bar.offsetHeight * scale;
      // The toast's usual place, in viewport pixels, for its current message.
      const restBottom = window.innerHeight - rest;
      const restTop = restBottom - toast.offsetHeight;
      const clear =
        barBottom + TOAST_CLEARANCE_PX <= restTop + 0.5 ||
        barTop - TOAST_CLEARANCE_PX >= restBottom - 0.5;
      value = clear
        ? 'var(--toast-rest-bottom)'
        : `calc(100% - ${Math.round(barTop - TOAST_CLEARANCE_PX)}px)`;
    }
    if (value === toastClearBottom) return;
    toastClearBottom = value;
    if (value === null) toast.style.removeProperty('--toast-clear-bottom');
    else toast.style.setProperty('--toast-clear-bottom', value);
  }

  /**
   * While the bar is up, a new message's height, the list's length and the
   * view's size can each bring the toast and the bar together (scrolling the
   * end of a long list is followed separately).
   */
  function watchToastClearance(on: boolean): void {
    if (!on) {
      toastClearObserver?.disconnect();
      return;
    }
    if (!toast || typeof ResizeObserver !== 'function') return;
    toastClearObserver ??= new ResizeObserver(keepToastClear);
    toastClearObserver.observe(toast);
    toastClearObserver.observe(list);
    if (scroller) toastClearObserver.observe(scroller);
  }

  function scrollRoom(kind: 'reveal' | 'exit', top: number): void {
    if (!scroller) return;
    roomScroll = { kind, top, until: performance.now() + ROOM_SCROLL_LIMIT_MS };
    scrollToWithPreferredMotion(scroller, top);
  }

  /**
   * The bar arrives over the bottom of the view, and below the last track it
   * takes room of its own. When it would cover the lowest selected track in
   * sight, the list scrolls that track up above it, the bar's top margin
   * apart, as at the end of the list.
   */
  function revealSelection(): void {
    revealAfterPress = false;
    if (!scroller || barState !== 'select' || !options.isPlaylistVisible()) return;
    // Rects are in viewport pixels. The wide desktop scales the body, and the
    // scroll position, sizes and margins stay in its CSS pixels.
    const scale = getBodyRenderedScale();
    const barTop = restingBarTop(scale);
    const barBottom = barTop + bar.offsetHeight * scale;
    // A selected track wholly below the bar (under the navigation, or out of
    // sight after a range drag) was not in view, so it is not brought up.
    const rows = [...list.querySelectorAll<HTMLElement>(`${ENTRY_SELECTOR}.is-removal-selected`)]
      .map((entry) => entry.getBoundingClientRect())
      .filter((rect) => rect.top < barBottom);
    const lowest = rows[rows.length - 1];
    if (!lowest || lowest.bottom - barTop < 1) return;
    const gap = parseFloat(getComputedStyle(bar).marginTop) || 0;
    const top = Math.min(
      scroller.scrollHeight - scroller.clientHeight,
      scroller.scrollTop + (lowest.bottom - barTop) / scale + gap,
    );
    if (top - scroller.scrollTop >= 1) scrollRoom('reveal', top);
  }

  /**
   * The bar's room goes when the bar does. A list scrolled into it scrolls
   * back out, to where the list will end without it: as the pills fade when
   * the mode ends, or as the survivors close up after a deletion.
   */
  function closeRoom(): void {
    if (!scroller) return;
    // The end of the list's own box in the body's content, in its CSS pixels
    // (rows gliding after a deletion move by transform, outside the box). The
    // body is positioned, so it anchors the list's offsets.
    const listEnd =
      list.offsetParent === scroller
        ? list.offsetTop + list.offsetHeight
        : (list.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top) /
            getBodyRenderedScale() -
          scroller.clientTop +
          scroller.scrollTop;
    const end = listEnd + (parseFloat(getComputedStyle(scroller).paddingBottom) || 0);
    const top = Math.max(0, end - scroller.clientHeight);
    if (scroller.scrollTop - top >= 1) scrollRoom('exit', top);
  }

  // A render writes the scroll position back, which stops a smooth scroll on
  // its way (a deletion renders again a frame later, and another device can
  // change the playlist at any time), so the removal starts it again.
  function continueRoomScroll(): void {
    const scroll = roomScroll;
    if (!scroll || !scroller || performance.now() >= scroll.until) return;
    if (Math.abs(scroller.scrollTop - scroll.top) >= 1) {
      scrollToWithPreferredMotion(scroller, scroll.top);
    }
  }

  // The pills have faded. Their room goes once the list is out of it, so a
  // scroll still on its way is not cut short by the list's end moving up.
  function hideBarAfterRoom(): void {
    roomExitFrame = 0;
    if (barState !== 'leaving') return;
    if (closeRoomAfterFade) {
      // A deletion's survivors begin to close up about now; its room goes with them.
      closeRoomAfterFade = false;
      closeRoom();
    }
    const exit = roomScroll?.kind === 'exit' ? roomScroll : null;
    if (exit && scroller && scroller.scrollTop - exit.top >= 1 && performance.now() < exit.until) {
      roomExitFrame = window.requestAnimationFrame(hideBarAfterRoom);
      return;
    }
    setBarState('hidden');
  }

  /** The selection UI has let go of the playlist: follow may resume. */
  function releaseSelection(): void {
    if (!destroyed && options.isPlaylistVisible()) options.onSelectionEnd?.();
  }

  function renderBarLabels(): void {
    // Named, not titled: a tooltip would only repeat the icon's name.
    moveButton.setAttribute('aria-label', t('playlist.move_action'));
    deleteButton.setAttribute('aria-label', t('common.delete'));
    cancelButton.setAttribute('aria-label', t('common.cancel'));
  }

  function setBarState(state: BarState): void {
    if (state === barState && state !== 'select') return;
    stopBarAnimations();
    const wasUp = barState === 'select';
    const reentering = barState === 'leaving' && state === 'select';
    if (state !== barState) {
      // The room's own scroll belongs to the state it started in.
      roomScroll = null;
      closeRoomAfterFade = false;
    }
    barState = state;
    bar.dataset.state = state;
    if (reentering) {
      // Selecting again while the pills leave replays their entry instead of
      // snapping the half-faded bar back. The bar stays in flow meanwhile, so
      // its room, and a list scrolled into it, stay where they are.
      bar.style.animation = 'none';
      void bar.offsetWidth;
      bar.style.removeProperty('animation');
    }
    bar.hidden = state === 'hidden';
    // While the pills slide away the list keeps its selection-mode height,
    // so they leave from right under the last track.
    list.classList.toggle('has-removal-exit', state === 'leaving');
    renderBarLabels();
    if (state === 'select') selectionEndPending = false;
    else if (state === 'hidden' && selectionEndPending) {
      selectionEndPending = false;
      queueMicrotask(releaseSelection);
    }
    if (state !== 'select') watchToastClearance(false);
    else if (!wasUp) watchToastClearance(true);
    keepToastClear();
  }

  function canAnimateBarExit(): boolean {
    return !bar.hidden && canAnimate(bar) && options.isPlaylistVisible();
  }

  /**
   * The whole bar slides down a little and fades out as one unit, starting
   * where it stood before the mode ended. It never delays the deletion.
   */
  function animateBarExit(barTopBefore: number): void {
    if (barState !== 'leaving') return;
    // Hiding deleted rows moves the last track, and the bar with it, up; the
    // pills stay where they were and shrink away there.
    const dy = barTopBefore - bar.getBoundingClientRect().top;
    barAnimations.push(
      bar.animate(
        [
          { transform: `translateY(${dy}px) scale(1)`, opacity: 1 },
          { transform: `translateY(${dy}px) scale(0.72)`, opacity: 0 },
        ],
        { duration: BAR_EXIT_MS, easing: BAR_EXIT_EASING, fill: 'forwards' },
      ),
    );
    barExitTimer = window.setTimeout(() => {
      barExitTimer = 0;
      hideBarAfterRoom();
    }, BAR_EXIT_MS);
  }

  // The header's visible controls in each mode: the playlist title (or its
  // switcher) with the icon actions, or the count title with its toggle.
  function headerControls(selecting: boolean): HTMLElement[] {
    if (!header) return [];
    const controls = selecting
      ? [title, toggleButton]
      : [
          header.querySelector<HTMLElement>(':scope > .tab-title:not(.playlist-selection-title)'),
          header.querySelector<HTMLElement>(':scope > .playlist-switch-button'),
          ...header.querySelectorAll<HTMLElement>('.playlist-title-area > .tab-action-btn'),
        ];
    return controls.filter(
      (control): control is HTMLElement => !!control && control.getClientRects().length > 0,
    );
  }

  function removeHeaderFade(): void {
    window.clearTimeout(headerFadeTimer);
    headerFadeLayer?.remove();
    headerFadeLayer = null;
  }

  // Entering or leaving the mode swaps the header's controls in one layout
  // step. The outgoing ones stay as frozen copies fading out where they were
  // while the incoming ones fade in, so the swap reads as a crossfade.
  function crossfadeHeader(selecting: boolean, swap: () => void): void {
    if (!header || !canAnimate(header) || !options.isPlaylistVisible()) {
      removeHeaderFade();
      swap();
      return;
    }
    removeHeaderFade();
    // Copy before the swap, which empties the count title it hides.
    const outgoing = headerControls(!selecting).map((control) => ({
      copy: control.cloneNode(true) as HTMLElement,
      rect: control.getBoundingClientRect(),
    }));
    swap();

    const layer = document.createElement('div');
    layer.className = 'playlist-header-fade';
    layer.setAttribute('aria-hidden', 'true');
    layer.inert = true;
    header.appendChild(layer);
    layer.style.left = '0px';
    layer.style.top = '0px';
    const origin = layer.getBoundingClientRect();
    for (const { copy, rect } of outgoing) {
      copy.removeAttribute('id');
      for (const element of copy.querySelectorAll('[id]')) element.removeAttribute('id');
      copy.hidden = false;
      copy.style.left = `${rect.left - origin.left}px`;
      copy.style.top = `${rect.top - origin.top}px`;
      copy.style.width = `${rect.width}px`;
      copy.style.height = `${rect.height}px`;
      layer.appendChild(copy);
      copy.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: HEADER_FADE_OUT_MS,
        easing: 'ease-out',
        fill: 'forwards',
      });
    }
    for (const control of headerControls(selecting)) {
      control.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: HEADER_FADE_IN_MS,
        easing: HEADER_FADE_IN_EASING,
      });
    }
    headerFadeLayer = layer;
    headerFadeTimer = window.setTimeout(removeHeaderFade, HEADER_FADE_OUT_MS);
  }

  function syncHeader(
    active: boolean,
    selectedCount: number,
    totalCount: number,
    allSelected: boolean,
  ): void {
    if (header && active !== header.classList.contains('is-removal-selecting')) {
      crossfadeHeader(active, () => applyHeader(active, selectedCount, totalCount, allSelected));
    } else applyHeader(active, selectedCount, totalCount, allSelected);
  }

  function applyHeader(
    active: boolean,
    selectedCount: number,
    totalCount: number,
    allSelected: boolean,
  ): void {
    header?.classList.toggle('is-removal-selecting', active);
    const count = active ? t('playlist.selected_count', { count: selectedCount }) : '';
    if (title) {
      title.hidden = !active;
      if (title.textContent !== count) title.textContent = count;
    }
    if (status && status.textContent !== count) status.textContent = count;
    if (toggleButton) {
      toggleButton.hidden = !active;
      // Select all shows how many tracks it would take; Deselect all needs no
      // count because the title beside it already shows the selection size.
      const text = allSelected
        ? t('playlist.deselect_all')
        : `${t('playlist.select_all')} (${totalCount})`;
      if (toggleButton.textContent !== text) toggleButton.textContent = text;
      toggleButton.dataset.selectionAction = allSelected ? 'deselect-all' : 'select-all';
    }
  }

  function retireDeletion(deletion: SentDeletion): void {
    window.clearTimeout(deletion.timer);
    const index = sentDeletions.indexOf(deletion);
    if (index >= 0) sentDeletions.splice(index, 1);
  }

  /** A sent deletion is done once the canonical playlist holds none of its rows. */
  function settleDeletions(items: readonly PlaylistItem[]): void {
    if (sentDeletions.length === 0) return;
    const liveIds = new Set(items.map((item) => item.queueItemId));
    // Leaving the room or losing edit authority also empties the list, so
    // only a deletion settled while this device can still edit is reported.
    const canConfirm = options.canRemove();
    for (const deletion of [...sentDeletions]) {
      if ([...deletion.queueItemIds].some((queueItemId) => liveIds.has(queueItemId))) continue;
      retireDeletion(deletion);
      if (canConfirm) options.onDeleted?.(deletion.queueItemIds.size);
    }
  }

  function expireDeletion(deletion: SentDeletion): void {
    if (!sentDeletions.includes(deletion)) return;
    retireDeletion(deletion);
    // The room never confirmed it: show the rows that are still there.
    if (deletion.hidden && !destroyed) options.onHiddenChange?.();
  }

  function syncDom(): void {
    if (destroyed) return;
    settleDeletions(canonicalItems());
    const items = visibleItems();
    const itemsById = new Map(items.map((item) => [item.queueItemId, item]));
    if (!options.canRemove()) selectedQueueItemIds.clear();
    for (const queueItemId of selectedQueueItemIds) {
      if (!itemsById.has(queueItemId)) selectedQueueItemIds.delete(queueItemId);
    }

    const selectedCount = selectedQueueItemIds.size;
    const active = selectedCount > 0;
    const selectionEnded = wasSelectionActive && !active;
    wasSelectionActive = active;
    const allSelected = active && items.length > 0 && selectedCount === items.length;
    // Where the pills are now, read before the list and header leave the mode:
    // without the mode the list stretches and would put them at the bottom.
    const barTopBefore =
      !active && barState === 'select' && canAnimateBarExit()
        ? bar.getBoundingClientRect().top
        : null;
    list.classList.toggle('has-removal-selection', active);
    moveButton.hidden = !(options.canMove?.() ?? false);

    // The view names each minus once ("Select {{title}}"); only its pressed
    // state follows the selection. Outside the mode its hint says a press
    // also starts the mode; inside, a press only picks.
    const modeHint = active ? null : t('playlist.select_mode_hint');
    for (const button of list.querySelectorAll<HTMLButtonElement>(SELECT_BUTTON_SELECTOR)) {
      const queueItemId = queueItemIdFromButton(button);
      const selected = !!queueItemId && selectedQueueItemIds.has(queueItemId);
      button.setAttribute('aria-pressed', String(selected));
      setControlHint(button, modeHint);
      const row = button.closest('.track-item');
      // In the mode a title press picks its row, so the title carries the
      // same state, and the keyboard passes each row once, on its minus.
      const rowTitle = row?.querySelector<HTMLElement>(':scope > .track-name');
      if (rowTitle && active) {
        rowTitle.setAttribute('aria-pressed', String(selected));
        rowTitle.setAttribute('tabindex', '-1');
      } else if (rowTitle) {
        rowTitle.removeAttribute('aria-pressed');
        rowTitle.removeAttribute('tabindex');
      }
      // CSS joins consecutive selected entries into one painted block.
      button.closest('.playlist-entry')?.classList.toggle('is-removal-selected', selected);
    }

    for (const handle of list.querySelectorAll<HTMLButtonElement>('.playlist-reorder-handle')) {
      handle.disabled = active;
      if (active) handle.removeAttribute('aria-keyshortcuts');
      else
        handle.setAttribute('aria-keyshortcuts', 'Space Enter ArrowUp ArrowDown Home End Escape');
    }

    syncHeader(active, selectedCount, items.length, allSelected);
    const entering = active && barState !== 'select';
    if (active) setBarState('select');
    else if (barTopBefore !== null) {
      // Cancel, Deselect all, an outside tap or a tab change.
      setBarState('leaving');
      animateBarExit(barTopBefore);
      // No row moves, so the list leaves the room as the pills fade.
      closeRoom();
    } else if (barState !== 'leaving') setBarState('hidden');
    if (entering) {
      // A long press or a range drag that started the mode is still down:
      // the rows stay under it until it lets go.
      if (pressedPointers.size > 0) revealAfterPress = true;
      else revealSelection();
    }

    if (selectionEnded && options.isPlaylistVisible()) {
      // Playback may have advanced while follow-scrolling was intentionally
      // blocked by deletion mode. Resume it only after the selection UI has
      // fully released ownership of the playlist: once a leaving bar, and the
      // room it takes, are gone.
      if (barState === 'leaving') selectionEndPending = true;
      else queueMicrotask(releaseSelection);
    }
  }

  function focusIsInsideControls(): boolean {
    const activeElement = document.activeElement;
    return (
      activeElement instanceof Node &&
      (bar.contains(activeElement) || !!toggleButton?.contains(activeElement))
    );
  }

  function cancel(cancelOptions: { restoreFocus?: boolean } = {}): void {
    // Cancel, Deselect all and an outside tap clear the blocks as they are.
    if (!captureMorph()) morph?.stop();
    const focusTarget = cancelOptions.restoreFocus ? lastTriggerQueueItemId : null;
    const hadSelection = selectedQueueItemIds.size > 0;
    if (cancelOptions.restoreFocus || (hadSelection && focusIsInsideControls())) {
      focusRow(focusTarget);
    }
    selectedQueueItemIds.clear();
    syncDom();
  }

  function notifyPlaylistHidden(focusTarget: HTMLElement | null = null): void {
    const activeElement = document.activeElement;
    const focusWasInside =
      activeElement instanceof HTMLElement &&
      (list.contains(activeElement) ||
        bar.contains(activeElement) ||
        !!toggleButton?.contains(activeElement));

    morph?.stop();
    selectedQueueItemIds.clear();
    syncDom();

    if (!focusWasInside) return;
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    else activeElement.blur();
  }

  function toggle(queueItemId: QueueItemId): void {
    if (!options.canRemove()) return;
    if (!visibleItems().some((item) => item.queueItemId === queueItemId)) return;
    const wasActive = selectedQueueItemIds.size > 0;
    lastTriggerQueueItemId = queueItemId;
    captureMorph();
    if (selectedQueueItemIds.has(queueItemId)) selectedQueueItemIds.delete(queueItemId);
    else selectedQueueItemIds.add(queueItemId);
    if (!wasActive && selectedQueueItemIds.size > 0) options.onSelectionStart?.();
    syncDom();
  }

  function toggleSelectAll(): void {
    if (!options.canRemove()) return;
    const items = visibleItems();
    if (items.length === 0) return;
    if (items.every((item) => selectedQueueItemIds.has(item.queueItemId))) {
      // Deselect all empties the selection, which ends deletion mode.
      cancel({ restoreFocus: true });
      return;
    }
    captureMorph();
    for (const item of items) selectedQueueItemIds.add(item.queueItemId);
    syncDom();
  }

  function deleteSelected(): void {
    if (!options.canRemove() || selectedQueueItemIds.size === 0) return;
    options.onBeforeDelete?.();
    morph?.stop();
    const items = visibleItems();
    const orderedQueueItemIds = items
      .filter((item) => selectedQueueItemIds.has(item.queueItemId))
      .map((item) => item.queueItemId);
    if (orderedQueueItemIds.length === 0) {
      cancel();
      return;
    }

    const firstRemovedIndex = items.findIndex((item) => selectedQueueItemIds.has(item.queueItemId));
    const survivors = items.filter((item) => !selectedQueueItemIds.has(item.queueItemId));
    const survivorQueueItemId =
      survivors[Math.min(firstRemovedIndex, Math.max(0, survivors.length - 1))]?.queueItemId ??
      null;
    const rowsBefore = rowTops();
    const exitRows = captureExitRows(new Set(orderedQueueItemIds));
    const barTopBefore = canAnimateBarExit() ? bar.getBoundingClientRect().top : null;
    selectedQueueItemIds.clear();
    if (barTopBefore !== null) setBarState('leaving');

    const deletion: SentDeletion = {
      queueItemIds: new Set(orderedQueueItemIds),
      hidden: !options.isRemovalLocal?.(),
      timer: 0,
    };
    deletion.timer = window.setTimeout(
      () => expireDeletion(deletion),
      REMOTE_CONFIRMATION_TIMEOUT_MS,
    );
    sentDeletions.push(deletion);
    // Removing the current track can move the view to another tab, which
    // hands focus to that tab before the pills go away.
    options.onDelete(orderedQueueItemIds);
    const focusWasOnBar = takeControlFocus();
    options.onHiddenChange?.();
    if (!destroyed) syncDom();
    // What follows the deletion (survivors closing up, an emptied list's
    // hint) waits until the leaving rows have faded.
    const exitDelay = !destroyed && exitRows !== null ? slideOutRows(exitRows) : 0;
    glideRows(rowsBefore, exitDelay);
    if (barTopBefore !== null) {
      // Not under the leaving rows: the room closes as the survivors move in.
      closeRoomAfterFade = true;
      animateBarExit(barTopBefore);
    }
    if (focusWasOnBar) releaseControlFocus(survivorQueueItemId);
  }

  // Survivors glide to their new rows when tracks are hidden or restored.
  function rowTops(): Map<string, number> | null {
    if (!canAnimate(list)) return null;
    const tops = new Map<string, number>();
    for (const entry of list.querySelectorAll<HTMLElement>(ENTRY_SELECTOR)) {
      const id = entry.dataset.queueItemId;
      if (id && entry.getClientRects().length) tops.set(id, entry.getBoundingClientRect().top);
    }
    return tops;
  }

  interface ExitRow {
    entry: HTMLElement;
    rect: DOMRect;
    fill: { top: string; bottom: string; radius: string };
    /** Rows that touch share a run: a joined block leaves in one piece. */
    run: number;
  }

  // The list re-renders from scratch, so deleted rows leave as copies frozen
  // where they were, painted with the selection block shape they had.
  function captureExitRows(queueItemIds: ReadonlySet<QueueItemId>): ExitRow[] | null {
    if (!canAnimate(list)) return null;
    const rows: ExitRow[] = [];
    let run = -1;
    let previous: Element | null = null;
    for (const entry of list.querySelectorAll<HTMLElement>(':scope > .playlist-entry')) {
      const id = entry.dataset.queueItemId;
      if (!id || !queueItemIds.has(id) || !entry.getClientRects().length) continue;
      // Consecutive siblings are the rows the selection CSS joins.
      if (!previous || entry.previousElementSibling !== previous) run += 1;
      previous = entry;
      const fill = getComputedStyle(entry, '::before');
      rows.push({
        entry,
        rect: entry.getBoundingClientRect(),
        fill: { top: fill.top, bottom: fill.bottom, radius: fill.borderRadius },
        run,
      });
    }
    return rows.length > 0 ? rows : null;
  }

  function removeExitLayer(): void {
    window.clearTimeout(exitTimer);
    exitLayer?.remove();
    exitLayer = null;
  }

  /**
   * Slide the captured rows out, each joined block in one piece. Returns how
   * long what follows should wait, or 0 when nothing could be shown.
   */
  function slideOutRows(rows: readonly ExitRow[]): number {
    removeExitLayer();
    const parent = bar.parentElement;
    if (!parent) return 0;
    const listRect = list.getBoundingClientRect();
    const top = Math.min(listRect.top, ...rows.map((row) => row.rect.top));
    const bottom = Math.max(...rows.map((row) => row.rect.bottom));
    const layer = document.createElement('div');
    layer.className = 'playlist-exit-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.inert = true;
    // After the bar, so no list or bar sibling rule sees the layer.
    bar.after(layer);
    // The layer clips the slide to the list's width. Pin it to its containing
    // block's origin first, so the measured point is where top/left count
    // from whichever ancestor that is, then move it over the rows.
    layer.style.left = '0px';
    layer.style.top = '0px';
    const origin = layer.getBoundingClientRect();
    layer.style.left = `${listRect.left - origin.left}px`;
    layer.style.top = `${top - origin.top}px`;
    layer.style.width = `${listRect.width}px`;
    layer.style.height = `${bottom - top}px`;

    const direction = getComputedStyle(list).direction === 'rtl' ? -1 : 1;
    const runs = rows[rows.length - 1]!.run + 1;
    for (let run = 0; run < runs; run += 1) {
      const members = rows.filter((row) => row.run === run);
      const first = members[0]!.rect;
      const runBottom = members[members.length - 1]!.rect.bottom;
      const group = document.createElement('div');
      group.className = 'playlist-exit-run';
      group.style.left = `${first.left - listRect.left}px`;
      group.style.top = `${first.top - top}px`;
      group.style.width = `${first.width}px`;
      group.style.height = `${runBottom - first.top}px`;
      for (const row of members) {
        const ghost = row.entry.cloneNode(true) as HTMLElement;
        ghost.classList.remove('is-removal-selected');
        ghost.classList.add('playlist-exit-ghost');
        ghost.removeAttribute('id');
        for (const element of ghost.querySelectorAll('[id]')) element.removeAttribute('id');
        ghost.style.left = `${row.rect.left - first.left}px`;
        ghost.style.top = `${row.rect.top - first.top}px`;
        ghost.style.width = `${row.rect.width}px`;
        ghost.style.height = `${row.rect.height}px`;
        ghost.style.setProperty('--exit-fill-top', row.fill.top);
        ghost.style.setProperty('--exit-fill-bottom', row.fill.bottom);
        ghost.style.setProperty('--exit-fill-radius', row.fill.radius);
        group.appendChild(ghost);
      }
      layer.appendChild(group);
      // The block slides on, accelerating, while it fades out sooner, so it is
      // gone from sight before the survivors move into its place.
      const delay = Math.min(run, EXIT_STAGGER_LIMIT) * EXIT_STAGGER_MS;
      group.animate(
        [{ transform: 'translateX(0)' }, { transform: `translateX(${direction * 100}%)` }],
        { duration: EXIT_MS, delay, easing: EXIT_EASING, fill: 'forwards' },
      );
      group.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: EXIT_FADE_MS,
        delay,
        easing: EXIT_FADE_EASING,
        fill: 'forwards',
      });
    }
    exitLayer = layer;
    const lastDelay = Math.min(runs - 1, EXIT_STAGGER_LIMIT) * EXIT_STAGGER_MS;
    exitTimer = window.setTimeout(removeExitLayer, EXIT_MS + lastDelay);
    return EXIT_FADE_MS + lastDelay;
  }

  function glideRows(before: Map<string, number> | null, delay = 0): void {
    if (!before) return;
    const offsets = new Map<string, number | null>();
    for (const entry of list.querySelectorAll<HTMLElement>(ENTRY_SELECTOR)) {
      const id = entry.dataset.queueItemId;
      if (!id || !entry.getClientRects().length) continue;
      const top = before.get(id);
      if (top === undefined) {
        offsets.set(id, null);
        continue;
      }
      const dy = top - entry.getBoundingClientRect().top;
      if (Math.abs(dy) >= 1) offsets.set(id, dy);
    }
    glide = { offsets, startedAt: performance.now(), delay };
    continueGlide();
  }

  // The committed playlist usually re-renders the list again a frame later,
  // which replaces every row. Each render picks the glide up at the same
  // point on the new rows, so survivors finish closing the gap.
  function continueGlide(): void {
    if (!glide) return;
    const elapsed = performance.now() - glide.startedAt;
    if (elapsed >= glide.delay + GLIDE_MS) {
      glide = null;
      return;
    }
    const timing: KeyframeAnimationOptions = {
      duration: GLIDE_MS,
      easing: PLAYLIST_ROW_EASING,
      delay: glide.delay,
      fill: 'backwards',
    };
    for (const entry of list.querySelectorAll<HTMLElement>(ENTRY_SELECTOR)) {
      const id = entry.dataset.queueItemId;
      if (!id || !glide.offsets.has(id)) continue;
      const dy = glide.offsets.get(id);
      const animation = entry.animate(
        dy == null
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
        timing,
      );
      if (elapsed > 0) animation.currentTime = elapsed;
    }
    // An emptied list's hint arrives after the leaving rows, not over them.
    const hint = list.querySelector<HTMLElement>(':scope > .list-empty-state');
    if (hint) {
      const animation = hint.animate(
        [
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'none' },
        ],
        timing,
      );
      if (elapsed > 0) animation.currentTime = elapsed;
    }
  }

  // The release of a press that started the mode (a long press, a range drag)
  // may still send a click, under the pointer, onto what slid in there: a pill
  // of the bar, or the body beside it, which would act or end the mode. A
  // click with no press or key of its own since that release is that click.
  // On the rows, the reorder and the range drag already swallow it.
  // Registered before the outside-tap listener below, so it runs first.
  for (const type of ['pointerdown', 'keydown']) {
    document.addEventListener(
      type,
      () => {
        releaseClickPending = false;
      },
      { capture: true, signal: abortController.signal },
    );
  }
  document.addEventListener(
    'click',
    (event) => {
      if (!releaseClickPending) return;
      releaseClickPending = false;
      if (event.target instanceof Node && list.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true, signal: abortController.signal },
  );

  // Deletion mode belongs to the track list. Any tap or click elsewhere
  // (another tab, the player, empty space under the list) ends it, while the
  // mode's own header button and pills keep it.
  document.addEventListener(
    'click',
    (event) => {
      if (selectedQueueItemIds.size === 0) return;
      const target = event.target;
      if (!(target instanceof Node) || !target.isConnected) return;
      if (list.contains(target) || bar.contains(target) || toggleButton?.contains(target)) return;
      if (target instanceof Element && target.closest('.cscroll-track')) return;
      cancel();
    },
    { capture: true, signal: abortController.signal },
  );

  const handleAction = (event: Event) => {
    // Pills on their way out no longer act.
    if (barState === 'leaving') return;
    const target = event.target instanceof Element ? event.target : null;
    const action = target?.closest<HTMLElement>('[data-selection-action]')?.dataset.selectionAction;
    if (action === 'select-all' || action === 'deselect-all') toggleSelectAll();
    else if (action === 'delete') deleteSelected();
    else if (action === 'move') {
      const selected = visibleItems()
        .map((item) => item.queueItemId)
        .filter((queueItemId) => selectedQueueItemIds.has(queueItemId));
      if (selected.length > 0) options.onMove?.(selected);
    } else if (action === 'cancel') cancel({ restoreFocus: true });
  };
  bar.addEventListener('click', handleAction, { signal: abortController.signal });
  toggleButton?.addEventListener('click', handleAction, { signal: abortController.signal });

  const handleEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || selectedQueueItemIds.size === 0) return;
    event.preventDefault();
    event.stopPropagation();
    cancel({ restoreFocus: true });
  };
  list.addEventListener('keydown', handleEscape, { signal: abortController.signal });
  bar.addEventListener('keydown', handleEscape, { signal: abortController.signal });
  toggleButton?.addEventListener('keydown', handleEscape, { signal: abortController.signal });

  // A tap selects on its click, after the press has ended. A long press or a
  // range drag selects while it is still down, and the room for that
  // selection waits until it lets go: scrolling under a press would move what
  // it is over. It comes a frame after the release. A press the browser takes
  // for scrolling leaves the rows to it.
  const releasePress = (pointerId: number, cancelled: boolean) => {
    if (!pressedPointers.delete(pointerId)) return;
    if (cancelled) revealAfterPress = false;
    if (pressedPointers.size > 0 || !revealAfterPress) return;
    releaseClickPending = true;
    if (revealFrame) return;
    revealFrame = window.requestAnimationFrame(() => {
      revealFrame = 0;
      if (revealAfterPress) revealSelection();
    });
  };
  // Leaving the window can swallow a release. (A context menu does not end a
  // press: Android sends one in the middle of every long press.)
  const forgetPresses = () => {
    pressedPointers.clear();
    revealAfterPress = false;
  };
  list.addEventListener(
    'pointerdown',
    (event) => {
      // The primary button, a finger or a pen; the presses the row gestures take.
      if (event.button === 0) pressedPointers.add(event.pointerId);
    },
    { capture: true, signal: abortController.signal },
  );
  document.addEventListener('pointerup', (event) => releasePress(event.pointerId, false), {
    capture: true,
    signal: abortController.signal,
  });
  document.addEventListener('pointercancel', (event) => releasePress(event.pointerId, true), {
    capture: true,
    signal: abortController.signal,
  });
  window.addEventListener('blur', forgetPresses, { signal: abortController.signal });

  // The user taking the list body over (or its custom scrollbar, beside it)
  // ends the removal's own scroll: a render no longer starts it again, and a
  // leaving bar no longer waits for it.
  const interactionRoot = scroller?.parentElement ?? scroller;
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    interactionRoot?.addEventListener(
      type,
      () => {
        roomScroll = null;
      },
      { capture: true, passive: true, signal: abortController.signal },
    );
  }

  // At the end of a long list the bar leaves its floating place and rides up
  // with the last track, and the toast keeps clear of it on the way.
  scroller?.addEventListener(
    'scroll',
    () => {
      if (barState === 'select') keepToastClear();
    },
    { passive: true, signal: abortController.signal },
  );
  window.addEventListener(
    'resize',
    () => {
      if (barState === 'select') keepToastClear();
    },
    { signal: abortController.signal },
  );

  syncDom();

  // Drag selection is an accelerator over the check circles, which already
  // work by tap, click and keyboard, so it loads off the critical path.
  let removeGestures: (() => void) | null = null;
  void import('./playlist-selection-gestures.ts').then(
    ({ installPlaylistSelectionGestures }) => {
      if (destroyed) return;
      removeGestures = installPlaylistSelectionGestures({
        list,
        canSelect: options.canRemove,
        isSelected: (queueItemId) => selectedQueueItemIds.has(queueItemId),
        toggle,
      });
    },
    () => {},
  );

  return {
    get isActive() {
      return selectedQueueItemIds.size > 0;
    },
    get isLeaving() {
      return barState === 'leaving';
    },
    isSelected: (queueItemId) => selectedQueueItemIds.has(queueItemId),
    isHidden,
    toggle,
    afterRender: () => {
      syncDom();
      continueGlide();
      continueRoomScroll();
      morph?.afterRender();
    },
    cancel,
    notifyPlaylistHidden,
    destroy: () => {
      destroyed = true;
      for (const deletion of sentDeletions) window.clearTimeout(deletion.timer);
      sentDeletions.length = 0;
      stopBarAnimations();
      if (revealFrame) window.cancelAnimationFrame(revealFrame);
      revealFrame = 0;
      pressedPointers.clear();
      roomScroll = null;
      toastClearObserver?.disconnect();
      toastClearObserver = null;
      if (toastClearBottom !== null) toast?.style.removeProperty('--toast-clear-bottom');
      toastClearBottom = null;
      removeExitLayer();
      removeHeaderFade();
      morph?.destroy();
      morph = null;
      glide = null;
      removeGestures?.();
      abortController.abort();
      selectedQueueItemIds.clear();
      list.classList.remove('has-removal-selection', 'has-removal-exit');
      header?.classList.remove('is-removal-selecting');
      bar.remove();
      title?.remove();
      status?.remove();
      toggleButton?.remove();
    },
  };
}
