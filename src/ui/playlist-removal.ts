import type { PlaylistItem, QueueItemId } from '../types/index.ts';
import { getTrackDisplayTitle } from '../player/track-display.ts';
import { t } from '../i18n/index.ts';

const REMOVE_BUTTON_SELECTOR = '.btn-playlist-remove[data-queue-item-id]';

/** Shared length of the survivors' glide and the pills' exit. */
const MORPH_MS = 300;
const MORPH_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
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
  deleteButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
} {
  const bar = document.createElement('div');
  bar.className = 'playlist-selection-bar';
  bar.setAttribute('role', 'group');
  bar.hidden = true;
  bar.innerHTML = `
    <button type="button" class="playlist-selection-pill playlist-selection-delete" data-selection-action="delete"></button>
    <button type="button" class="playlist-selection-pill playlist-selection-cancel" data-selection-action="cancel"></button>`;
  // The bar follows the last track in the scrolling list body; CSS makes it
  // sticky, so a list taller than the view keeps it floating at the bottom.
  list.insertAdjacentElement('afterend', bar);
  return {
    bar,
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
 * Selecting a row's X enters the mode: the tab title becomes the selected
 * count, one text button toggles select all, and a Delete/Cancel pill pair
 * follows the last track. Delete sends `onDelete` at once through the PRO,
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
  const { bar, deleteButton, cancelButton } = createBar(list);
  const { header, title, toggleButton } = createHeaderControls(container);
  const abortController = new AbortController();
  let lastTriggerQueueItemId: QueueItemId | null = null;
  let wasSelectionActive = false;
  let destroyed = false;
  let barState: BarState = 'hidden';
  let barAnimations: Animation[] = [];
  let barExitTimer = 0;

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
        `${REMOVE_BUTTON_SELECTOR}[data-queue-item-id="${queueItemId}"]`,
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
    deleteButton.textContent = t('common.delete');
    cancelButton.textContent = t('common.cancel');
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

    for (const button of list.querySelectorAll<HTMLButtonElement>(REMOVE_BUTTON_SELECTOR)) {
      const queueItemId = queueItemIdFromButton(button);
      const selected = !!queueItemId && selectedQueueItemIds.has(queueItemId);
      const item = queueItemId ? itemsById.get(queueItemId) : undefined;
      const rowTitle = item ? getTrackDisplayTitle(item, t('common.unknown')) : t('common.unknown');
      const label = t(
        selected ? 'playlist.deselect_for_deletion' : 'playlist.select_for_deletion',
        { title: rowTitle },
      );
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      setButtonLabel(button, label);
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
    glideRows(rowsBefore);
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

  function glideRows(before: Map<string, number> | null): void {
    if (!before) return;
    const timing = { duration: MORPH_MS, easing: MORPH_EASING };
    for (const handle of list.querySelectorAll<HTMLElement>('.playlist-reorder-handle')) {
      const entry = handle.closest<HTMLElement>('.playlist-entry');
      const id = handle.dataset.queueItemId;
      if (!entry || !id || !entry.getClientRects().length) continue;
      const top = before.get(id);
      if (top === undefined) {
        entry.animate([{ opacity: 0 }, { opacity: 1 }], timing);
        continue;
      }
      const dy = top - entry.getBoundingClientRect().top;
      if (Math.abs(dy) >= 1) {
        entry.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], timing);
      }
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
    else if (action === 'cancel') cancel({ restoreFocus: true });
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

  return {
    get isActive() {
      return selectedQueueItemIds.size > 0;
    },
    isSelected: (queueItemId) => selectedQueueItemIds.has(queueItemId),
    isHidden,
    toggle,
    afterRender: syncDom,
    cancel,
    notifyPlaylistHidden,
    destroy: () => {
      destroyed = true;
      for (const deletion of sentDeletions) window.clearTimeout(deletion.timer);
      sentDeletions.length = 0;
      stopBarAnimations();
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
