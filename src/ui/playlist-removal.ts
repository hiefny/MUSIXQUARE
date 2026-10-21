import type { PlaylistItem, QueueItemId } from '../types/index.ts';
import { getTrackDisplayTitle } from '../player/track-display.ts';
import { t } from '../i18n/index.ts';

const SELECT_BUTTON_SELECTOR = '.btn-playlist-select[data-queue-item-id]';

/** Shared length of the survivors' glide and the pills' exit. */
const MORPH_MS = 300;
const MORPH_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/** Deleted rows slide out toward the inline end; survivors close up behind them. */
const EXIT_MS = 280;
const EXIT_EASING = 'cubic-bezier(0.5, 0, 0.75, 0)';
const EXIT_STAGGER_MS = 24;
const EXIT_STAGGER_LIMIT = 8;
const SURVIVOR_DELAY_MS = 90;
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
  /** True when the room has other playlists to copy or move tracks to. */
  canMove?: () => boolean;
  /** Open the move dialog for the selected tracks, in playlist order. */
  onMove?: (queueItemIds: readonly QueueItemId[]) => void;
}

export interface PlaylistRemovalController {
  readonly isActive: boolean;
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

function setButtonLabel(button: HTMLButtonElement, label: string): void {
  button.setAttribute('aria-label', label);
  button.title = label;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function canAnimate(element: Element): boolean {
  return typeof (element as HTMLElement).animate === 'function' && !prefersReducedMotion();
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
  // Material "drive_file_move", "delete" and "close" icons; their names come
  // from renderBarLabels.
  bar.innerHTML = `
    <button type="button" class="playlist-selection-action playlist-selection-move" data-selection-action="move" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 12v-3h-4v-4h4V8l5 5-5 5z"/></svg></button>
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
  toggleButton: HTMLButtonElement | null;
} {
  const header = container?.querySelector<HTMLElement>(':scope > .tab-header') ?? null;
  if (!header) return { header: null, title: null, toggleButton: null };
  const title = document.createElement('span');
  title.className = 'tab-title playlist-selection-title';
  title.setAttribute('aria-live', 'polite');
  title.setAttribute('aria-atomic', 'true');
  title.hidden = true;
  const baseTitle = header.querySelector(':scope > .tab-title');
  if (baseTitle) baseTitle.after(title);
  else header.prepend(title);

  const toggleButton = document.createElement('button');
  toggleButton.type = 'button';
  toggleButton.className = 'playlist-selection-toggle';
  toggleButton.dataset.selectionAction = 'select-all';
  toggleButton.hidden = true;
  (header.querySelector(':scope > .playlist-title-area') ?? header).appendChild(toggleButton);
  return { header, title, toggleButton };
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
  const { header, title, toggleButton } = createHeaderControls(container);
  const abortController = new AbortController();
  let lastTriggerQueueItemId: QueueItemId | null = null;
  let wasSelectionActive = false;
  let destroyed = false;
  let barState: BarState = 'hidden';
  let barAnimations: Animation[] = [];
  let barExitTimer = 0;
  let exitLayer: HTMLElement | null = null;
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
  }

  function renderBarLabels(): void {
    setButtonLabel(moveButton, t('playlist.move_action'));
    setButtonLabel(deleteButton, t('common.delete'));
    setButtonLabel(cancelButton, t('common.cancel'));
    bar.setAttribute('aria-label', t('playlist.remove_title'));
  }

  function setBarState(state: BarState): void {
    if (state === barState && state !== 'select') return;
    stopBarAnimations();
    const reentering = barState === 'leaving' && state === 'select';
    barState = state;
    bar.dataset.state = state;
    if (reentering) {
      // Selecting again while the pills leave replays their entry instead of
      // snapping the half-faded bar back.
      bar.hidden = true;
      void bar.offsetWidth;
    }
    bar.hidden = state === 'hidden';
    // While the pills slide away the list keeps its selection-mode height,
    // so they leave from right under the last track.
    list.classList.toggle('has-removal-exit', state === 'leaving');
    renderBarLabels();
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
    // Hiding deleted rows moves the last track, and the bar with it, up.
    const dy = barTopBefore - bar.getBoundingClientRect().top;
    barAnimations.push(
      bar.animate(
        [
          { transform: `translateY(${dy}px)`, opacity: 1 },
          { transform: `translateY(${dy + 24}px)`, opacity: 0 },
        ],
        { duration: MORPH_MS, easing: MORPH_EASING, fill: 'forwards' },
      ),
    );
    barExitTimer = window.setTimeout(() => {
      barExitTimer = 0;
      if (barState === 'leaving') setBarState('hidden');
    }, MORPH_MS);
  }

  function syncHeader(
    active: boolean,
    selectedCount: number,
    totalCount: number,
    allSelected: boolean,
  ): void {
    header?.classList.toggle('is-removal-selecting', active);
    if (title) {
      title.hidden = !active;
      const text = active ? t('playlist.selected_count', { count: selectedCount }) : '';
      if (title.textContent !== text) title.textContent = text;
    }
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
    list.classList.toggle('has-removal-selection', active);
    moveButton.hidden = !(options.canMove?.() ?? false);

    for (const button of list.querySelectorAll<HTMLButtonElement>(SELECT_BUTTON_SELECTOR)) {
      const queueItemId = queueItemIdFromButton(button);
      const selected = !!queueItemId && selectedQueueItemIds.has(queueItemId);
      const item = queueItemId ? itemsById.get(queueItemId) : undefined;
      const rowTitle = item ? getTrackDisplayTitle(item, t('common.unknown')) : t('common.unknown');
      const label = t(
        selected ? 'playlist.deselect_for_deletion' : 'playlist.select_for_deletion',
        { title: rowTitle },
      );
      button.setAttribute('aria-pressed', String(selected));
      setButtonLabel(button, label);
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
    if (active) setBarState('select');
    else if (barState === 'select' && canAnimateBarExit()) {
      // Cancel, Deselect all, an outside tap or a tab change.
      const barTop = bar.getBoundingClientRect().top;
      setBarState('leaving');
      animateBarExit(barTop);
    } else if (barState !== 'leaving') setBarState('hidden');

    if (selectionEnded && options.isPlaylistVisible()) {
      // Playback may have advanced while follow-scrolling was intentionally
      // blocked by deletion mode. Resume it only after the selection UI has
      // fully released ownership of the playlist.
      queueMicrotask(() => {
        if (!destroyed && options.isPlaylistVisible()) options.onSelectionEnd?.();
      });
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
    for (const item of items) selectedQueueItemIds.add(item.queueItemId);
    syncDom();
  }

  function deleteSelected(): void {
    if (!options.canRemove() || selectedQueueItemIds.size === 0) return;
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
    const exiting = !destroyed && exitRows !== null && slideOutRows(exitRows);
    glideRows(rowsBefore, exiting ? SURVIVOR_DELAY_MS : 0);
    if (barTopBefore !== null) animateBarExit(barTopBefore);
    if (focusWasOnBar) releaseControlFocus(survivorQueueItemId);
  }

  // Survivors glide to their new rows when tracks are hidden or restored.
  function rowTops(): Map<string, number> | null {
    if (!canAnimate(list)) return null;
    const tops = new Map<string, number>();
    for (const handle of list.querySelectorAll<HTMLElement>('.playlist-reorder-handle')) {
      const entry = handle.closest<HTMLElement>('.playlist-entry');
      const id = handle.dataset.queueItemId;
      if (entry && id && entry.getClientRects().length) {
        tops.set(id, entry.getBoundingClientRect().top);
      }
    }
    return tops;
  }

  interface ExitRow {
    entry: HTMLElement;
    rect: DOMRect;
    fill: { top: string; bottom: string; radius: string };
  }

  // The list re-renders from scratch, so deleted rows leave as copies frozen
  // where they were, painted with the selection block shape they had.
  function captureExitRows(queueItemIds: ReadonlySet<QueueItemId>): ExitRow[] | null {
    if (!canAnimate(list)) return null;
    const rows: ExitRow[] = [];
    for (const entry of list.querySelectorAll<HTMLElement>(':scope > .playlist-entry')) {
      const id = entry.dataset.queueItemId;
      if (!id || !queueItemIds.has(id) || !entry.getClientRects().length) continue;
      const fill = getComputedStyle(entry, '::before');
      rows.push({
        entry,
        rect: entry.getBoundingClientRect(),
        fill: { top: fill.top, bottom: fill.bottom, radius: fill.borderRadius },
      });
    }
    return rows.length > 0 ? rows : null;
  }

  function removeExitLayer(): void {
    window.clearTimeout(exitTimer);
    exitLayer?.remove();
    exitLayer = null;
  }

  /** Slide the captured rows out; false when nothing could be shown. */
  function slideOutRows(rows: readonly ExitRow[]): boolean {
    removeExitLayer();
    const parent = bar.parentElement;
    if (!parent) return false;
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
    rows.forEach((row, index) => {
      const ghost = row.entry.cloneNode(true) as HTMLElement;
      ghost.classList.remove('is-removal-selected');
      ghost.classList.add('playlist-exit-ghost');
      ghost.removeAttribute('id');
      for (const element of ghost.querySelectorAll('[id]')) element.removeAttribute('id');
      ghost.style.left = `${row.rect.left - listRect.left}px`;
      ghost.style.top = `${row.rect.top - top}px`;
      ghost.style.width = `${row.rect.width}px`;
      ghost.style.height = `${row.rect.height}px`;
      ghost.style.setProperty('--exit-fill-top', row.fill.top);
      ghost.style.setProperty('--exit-fill-bottom', row.fill.bottom);
      ghost.style.setProperty('--exit-fill-radius', row.fill.radius);
      layer.appendChild(ghost);
      ghost.animate(
        [
          { transform: 'translateX(0)', opacity: 1 },
          { transform: `translateX(${direction * 100}%)`, opacity: 0 },
        ],
        {
          duration: EXIT_MS,
          delay: Math.min(index, EXIT_STAGGER_LIMIT) * EXIT_STAGGER_MS,
          easing: EXIT_EASING,
          fill: 'forwards',
        },
      );
    });
    exitLayer = layer;
    const lastDelay = Math.min(rows.length - 1, EXIT_STAGGER_LIMIT) * EXIT_STAGGER_MS;
    exitTimer = window.setTimeout(removeExitLayer, EXIT_MS + lastDelay);
    return true;
  }

  function glideRows(before: Map<string, number> | null, delay = 0): void {
    if (!before) return;
    const offsets = new Map<string, number | null>();
    for (const handle of list.querySelectorAll<HTMLElement>('.playlist-reorder-handle')) {
      const entry = handle.closest<HTMLElement>('.playlist-entry');
      const id = handle.dataset.queueItemId;
      if (!entry || !id || !entry.getClientRects().length) continue;
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
    if (elapsed >= glide.delay + MORPH_MS) {
      glide = null;
      return;
    }
    const timing: KeyframeAnimationOptions = {
      duration: MORPH_MS,
      easing: MORPH_EASING,
      delay: glide.delay,
      fill: 'backwards',
    };
    for (const handle of list.querySelectorAll<HTMLElement>('.playlist-reorder-handle')) {
      const entry = handle.closest<HTMLElement>('.playlist-entry');
      const id = handle.dataset.queueItemId;
      if (!entry || !id || !glide.offsets.has(id)) continue;
      const dy = glide.offsets.get(id);
      const animation = entry.animate(
        dy == null
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
        timing,
      );
      if (elapsed > 0) animation.currentTime = elapsed;
    }
  }

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
    isSelected: (queueItemId) => selectedQueueItemIds.has(queueItemId),
    isHidden,
    toggle,
    afterRender: () => {
      syncDom();
      continueGlide();
    },
    cancel,
    notifyPlaylistHidden,
    destroy: () => {
      destroyed = true;
      for (const deletion of sentDeletions) window.clearTimeout(deletion.timer);
      sentDeletions.length = 0;
      stopBarAnimations();
      removeExitLayer();
      glide = null;
      removeGestures?.();
      abortController.abort();
      selectedQueueItemIds.clear();
      list.classList.remove('has-removal-selection', 'has-removal-exit');
      header?.classList.remove('is-removal-selecting');
      bar.remove();
      title?.remove();
      toggleButton?.remove();
    },
  };
}
