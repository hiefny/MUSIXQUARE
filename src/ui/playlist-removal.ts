import type { PlaylistItem, QueueItemId } from '../types/index.ts';
import { getTrackDisplayTitle } from '../player/track-display.ts';
import { t } from '../i18n/index.ts';

const REMOVE_BUTTON_SELECTOR = '.btn-playlist-remove[data-queue-item-id]';

/** How long the Undo pill stays before the deletion is really sent. */
const PLAYLIST_REMOVAL_UNDO_MS = 3000;
/** Shared length of the Delete → Undo morph and the exit slides. */
const MORPH_MS = 300;
const MORPH_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/**
 * Remote paths (PRO server, Standard host) answer asynchronously. Keep the
 * committed rows hidden until the canonical playlist drops them, but give a
 * rejected or lost request back to the list instead of hiding it forever.
 */
const REMOTE_CONFIRMATION_TIMEOUT_MS = 10_000;

const UNDO_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>';

interface PlaylistRemovalControllerOptions {
  list: HTMLElement;
  canRemove: () => boolean;
  isPlaylistVisible: () => boolean;
  /** Canonical playlist, including rows hidden by a pending deletion. */
  getItems: () => readonly PlaylistItem[];
  onDelete: (queueItemIds: QueueItemId[]) => void;
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
  /** The Undo pill appeared or went away. */
  onUndoChange?: () => void;
}

export interface PlaylistRemovalController {
  readonly isActive: boolean;
  /** True while the Undo pill is offered. */
  readonly hasPendingDeletion: boolean;
  isSelected(queueItemId: QueueItemId): boolean;
  /** Rows the list must not render: pending undo or awaiting remote removal. */
  isHidden(queueItemId: QueueItemId): boolean;
  toggle(queueItemId: QueueItemId): void;
  afterRender(): void;
  cancel(options?: { restoreFocus?: boolean }): void;
  notifyPlaylistHidden(focusTarget?: HTMLElement | null): void;
  /** Send a pending deletion now (page hide, a newer deletion). */
  commitPendingDeletion(): void;
  /** Forget a pending deletion and show its rows again (room or authority loss). */
  dropPendingDeletion(): void;
  destroy(): void;
}

type BarState = 'hidden' | 'select' | 'undo';

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

function createBar(container: Element | null): {
  bar: HTMLElement;
  primary: HTMLButtonElement;
  primaryLabel: HTMLElement;
  cancelButton: HTMLButtonElement;
} {
  const bar = document.createElement('div');
  bar.className = 'playlist-selection-bar';
  bar.setAttribute('role', 'group');
  bar.hidden = true;
  bar.innerHTML = `
    <button type="button" class="playlist-selection-pill playlist-selection-delete" data-selection-action="delete">
      ${UNDO_ICON}<span class="playlist-selection-pill-label"></span>
    </button>
    <button type="button" class="playlist-selection-pill playlist-selection-cancel" data-selection-action="cancel"></button>`;
  container?.appendChild(bar);
  return {
    bar,
    primary: bar.querySelector<HTMLButtonElement>('.playlist-selection-delete')!,
    primaryLabel: bar.querySelector<HTMLElement>('.playlist-selection-pill-label')!,
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
 * floats over the list. Delete hides the rows locally and morphs into an Undo
 * pill; only when the undo window closes does `onDelete` run, so the PRO,
 * Standard guest/operator and host removal paths stay unchanged.
 *
 * A pending deletion never outlives its authority: a room change, authority
 * loss or session end drops it (the rows come back), while a newer deletion,
 * a new selection, or the page going away commits it first so a deletion the
 * user did not undo is not lost. The current track may keep playing until the
 * commit; the host's normal removal path then picks the successor.
 */
export function createPlaylistRemovalController(
  options: PlaylistRemovalControllerOptions,
): PlaylistRemovalController {
  const { list } = options;
  const container = list.closest('#tab-playlist') ?? list.parentElement;
  const selectedQueueItemIds = new Set<QueueItemId>();
  const { bar, primary, primaryLabel, cancelButton } = createBar(container);
  const { header, title, toggleButton } = createHeaderControls(container);
  const abortController = new AbortController();
  let lastTriggerQueueItemId: QueueItemId | null = null;
  let wasSelectionActive = false;
  let destroyed = false;
  let barState: BarState = 'hidden';
  let barAnimations: Animation[] = [];
  let cancelExitTimer = 0;

  let pending: {
    queueItemIds: QueueItemId[];
    survivorQueueItemId: QueueItemId | null;
    timer: number;
    leaving: boolean;
  } | null = null;
  const awaitingRemoval = new Set<QueueItemId>();
  let awaitingTimer = 0;

  function canonicalItems(): readonly PlaylistItem[] {
    return options.getItems();
  }

  function isHidden(queueItemId: QueueItemId): boolean {
    return !!pending?.queueItemIds.includes(queueItemId) || awaitingRemoval.has(queueItemId);
  }

  function visibleItems(): readonly PlaylistItem[] {
    const items = canonicalItems();
    if (!pending && awaitingRemoval.size === 0) return items;
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
    if (cancelExitTimer) window.clearTimeout(cancelExitTimer);
    cancelExitTimer = 0;
    cancelButton.classList.remove('is-exiting');
    cancelButton.style.removeProperty('left');
    cancelButton.style.removeProperty('top');
    primary.classList.remove('is-leaving');
  }

  function renderBarLabels(state: BarState): void {
    const undo = state === 'undo';
    primary.dataset.selectionAction = undo ? 'undo' : 'delete';
    primary.classList.toggle('is-undo', undo);
    primaryLabel.textContent = t(undo ? 'common.undo' : 'common.delete');
    cancelButton.textContent = t('common.cancel');
    bar.setAttribute('aria-label', t('playlist.remove_title'));
  }

  /** Delete → Undo: Cancel slides away while the Delete pill turns into Undo. */
  function morphToUndo(): void {
    stopBarAnimations();
    const animate = canAnimate(primary) && !bar.hidden;
    const barBefore = animate ? bar.getBoundingClientRect() : null;
    const primaryBefore = animate ? primary.getBoundingClientRect() : null;
    const cancelBefore = animate ? cancelButton.getBoundingClientRect() : null;

    barState = 'undo';
    bar.dataset.state = 'undo';
    bar.hidden = false;
    renderBarLabels('undo');

    if (!animate || !barBefore || !primaryBefore || !cancelBefore) {
      cancelButton.hidden = true;
      return;
    }

    // The Cancel pill leaves the flow at once so the Undo pill can centre,
    // but stays painted where it was while it slides down.
    cancelButton.classList.add('is-exiting');
    const barAfter = bar.getBoundingClientRect();
    cancelButton.style.left = `${cancelBefore.left - barAfter.left}px`;
    cancelButton.style.top = `${cancelBefore.top - barAfter.top}px`;
    const primaryAfter = primary.getBoundingClientRect();
    const dx =
      primaryBefore.left + primaryBefore.width / 2 - (primaryAfter.left + primaryAfter.width / 2);
    const timing = { duration: MORPH_MS, easing: MORPH_EASING };
    barAnimations.push(
      primary.animate(
        [
          { transform: `translateX(${dx}px)`, width: `${primaryBefore.width}px` },
          { transform: 'translateX(0)', width: `${primaryAfter.width}px` },
        ],
        timing,
      ),
      cancelButton.animate(
        [
          { transform: 'translateY(0)', opacity: 1 },
          { transform: `translateY(${cancelBefore.height + 24}px)`, opacity: 0 },
        ],
        { ...timing, fill: 'forwards' },
      ),
    );
    cancelExitTimer = window.setTimeout(() => {
      cancelExitTimer = 0;
      if (barState !== 'undo') return;
      cancelButton.hidden = true;
      cancelButton.classList.remove('is-exiting');
      cancelButton.style.removeProperty('left');
      cancelButton.style.removeProperty('top');
    }, MORPH_MS);
  }

  function setBarState(state: BarState): void {
    if (state === barState && state !== 'select') return;
    if (state === 'undo') {
      morphToUndo();
      return;
    }
    stopBarAnimations();
    barState = state;
    bar.dataset.state = state;
    bar.hidden = state === 'hidden';
    cancelButton.hidden = state !== 'select';
    renderBarLabels(state);
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
      // The total in parentheses tells how many tracks the toggle affects.
      const label = t(allSelected ? 'playlist.deselect_all' : 'playlist.select_all');
      const text = `${label} (${totalCount})`;
      if (toggleButton.textContent !== text) toggleButton.textContent = text;
      toggleButton.dataset.selectionAction = allSelected ? 'deselect-all' : 'select-all';
    }
  }

  function pruneHidden(items: readonly PlaylistItem[]): void {
    const liveIds = new Set(items.map((item) => item.queueItemId));
    for (const queueItemId of awaitingRemoval) {
      if (!liveIds.has(queueItemId)) awaitingRemoval.delete(queueItemId);
    }
    if (awaitingRemoval.size === 0 && awaitingTimer) {
      window.clearTimeout(awaitingTimer);
      awaitingTimer = 0;
    }
    if (!pending) return;
    pending.queueItemIds = pending.queueItemIds.filter((queueItemId) => liveIds.has(queueItemId));
    if (pending.queueItemIds.length === 0) {
      // Someone else already removed every pending row. Nothing is left to
      // undo or send, so retire the pill quietly.
      window.clearTimeout(pending.timer);
      pending = null;
      setBarState('hidden');
      options.onUndoChange?.();
    }
  }

  function syncDom(): void {
    if (destroyed) return;
    const canonical = canonicalItems();
    pruneHidden(canonical);
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
    list.classList.toggle('has-removal-undo', !active && !!pending);

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
    else if (pending) {
      if (barState !== 'undo') setBarState('undo');
      else renderBarLabels('undo');
    } else setBarState('hidden');

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

  function releaseAwaiting(): void {
    if (awaitingTimer) window.clearTimeout(awaitingTimer);
    awaitingTimer = 0;
    if (awaitingRemoval.size === 0) return;
    awaitingRemoval.clear();
    options.onHiddenChange?.();
  }

  /** Send the pending deletion now, without the exit slide. */
  function commitPendingDeletion(): void {
    const owner = pending;
    if (!owner) return;
    window.clearTimeout(owner.timer);
    pending = null;
    const liveIds = new Set(canonicalItems().map((item) => item.queueItemId));
    const queueItemIds = owner.queueItemIds.filter((queueItemId) => liveIds.has(queueItemId));
    if (queueItemIds.length > 0 && options.canRemove()) {
      if (!options.isRemovalLocal?.()) {
        for (const queueItemId of queueItemIds) awaitingRemoval.add(queueItemId);
        if (awaitingTimer) window.clearTimeout(awaitingTimer);
        awaitingTimer = window.setTimeout(releaseAwaiting, REMOTE_CONFIRMATION_TIMEOUT_MS);
      }
      // Removing the current track can move the view to another tab, which
      // hands focus to that tab before the pill goes away.
      options.onDelete(queueItemIds);
    }
    const focusWasOnUndo = takeControlFocus();
    if (selectedQueueItemIds.size === 0) setBarState('hidden');
    options.onUndoChange?.();
    options.onHiddenChange?.();
    if (!destroyed) syncDom();
    if (focusWasOnUndo) releaseControlFocus(owner.survivorQueueItemId);
  }

  function dropPendingDeletion(): void {
    const hadPending = !!pending;
    if (pending) window.clearTimeout(pending.timer);
    pending = null;
    if (awaitingTimer) window.clearTimeout(awaitingTimer);
    awaitingTimer = 0;
    const hadAwaiting = awaitingRemoval.size > 0;
    awaitingRemoval.clear();
    if (!hadPending && !hadAwaiting) return;
    if (focusIsInsideControls() && selectedQueueItemIds.size === 0) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
    if (hadPending) options.onUndoChange?.();
    options.onHiddenChange?.();
    syncDom();
  }

  function undo(): void {
    const owner = pending;
    if (!owner) return;
    window.clearTimeout(owner.timer);
    pending = null;
    const focusWasOnUndo = takeControlFocus();
    setBarState('hidden');
    options.onUndoChange?.();
    options.onHiddenChange?.();
    syncDom();
    if (focusWasOnUndo) releaseControlFocus(owner.queueItemIds[0] ?? null);
  }

  function beginUndoExit(): void {
    const owner = pending;
    if (!owner || owner.leaving) return;
    owner.leaving = true;
    if (!canAnimate(primary) || bar.hidden || !options.isPlaylistVisible()) {
      commitPendingDeletion();
      return;
    }
    // The Undo pill swooshes down; only then is the deletion really sent.
    stopBarAnimations();
    primary.classList.add('is-leaving');
    barAnimations.push(
      primary.animate(
        [
          { transform: 'translateY(0)', opacity: 1 },
          { transform: `translateY(${primary.offsetHeight + 24}px)`, opacity: 0 },
        ],
        { duration: MORPH_MS, easing: MORPH_EASING, fill: 'forwards' },
      ),
    );
    owner.timer = window.setTimeout(() => {
      if (pending === owner) commitPendingDeletion();
    }, MORPH_MS);
  }

  function startSelection(queueItemId: QueueItemId): void {
    // The Undo pill is about to be replaced by Delete/Cancel, so the earlier
    // deletion can no longer be undone. Send it before selecting again.
    if (pending) commitPendingDeletion();
    lastTriggerQueueItemId = queueItemId;
  }

  function toggle(queueItemId: QueueItemId): void {
    if (!options.canRemove()) return;
    if (!visibleItems().some((item) => item.queueItemId === queueItemId)) return;
    const wasActive = selectedQueueItemIds.size > 0;
    if (!wasActive) startSelection(queueItemId);
    else lastTriggerQueueItemId = queueItemId;
    if (!visibleItems().some((item) => item.queueItemId === queueItemId)) return;
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
    if (pending) commitPendingDeletion();
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
    const owner = {
      queueItemIds: orderedQueueItemIds,
      survivorQueueItemId,
      timer: 0,
      leaving: false,
    };
    owner.timer = window.setTimeout(() => {
      if (pending === owner) beginUndoExit();
    }, PLAYLIST_REMOVAL_UNDO_MS);
    pending = owner;
    selectedQueueItemIds.clear();
    // The pressed Delete pill becomes the Undo pill, so keyboard focus stays
    // on it. A pointer press leaves focus where the browser put it.
    options.onUndoChange?.();
    options.onHiddenChange?.();
    syncDom();
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
    const target = event.target instanceof Element ? event.target : null;
    const action = target?.closest<HTMLElement>('[data-selection-action]')?.dataset.selectionAction;
    if (action === 'select-all' || action === 'deselect-all') toggleSelectAll();
    else if (action === 'delete') deleteSelected();
    else if (action === 'undo') undo();
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

  // A deletion the user did not undo must not be lost when the page goes away.
  window.addEventListener('pagehide', commitPendingDeletion, { signal: abortController.signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'hidden') commitPendingDeletion();
    },
    { signal: abortController.signal },
  );

  syncDom();

  return {
    get isActive() {
      return selectedQueueItemIds.size > 0;
    },
    get hasPendingDeletion() {
      return !!pending;
    },
    isSelected: (queueItemId) => selectedQueueItemIds.has(queueItemId),
    isHidden,
    toggle,
    afterRender: syncDom,
    cancel,
    notifyPlaylistHidden,
    commitPendingDeletion,
    dropPendingDeletion,
    destroy: () => {
      destroyed = true;
      if (pending) window.clearTimeout(pending.timer);
      pending = null;
      if (awaitingTimer) window.clearTimeout(awaitingTimer);
      awaitingRemoval.clear();
      stopBarAnimations();
      abortController.abort();
      selectedQueueItemIds.clear();
      list.classList.remove('has-removal-selection', 'has-removal-undo');
      header?.classList.remove('is-removal-selecting');
      bar.remove();
      title?.remove();
      toggleButton?.remove();
    },
  };
}
