import type { PlaylistItem, QueueItemId } from '../types/index.ts';
import { t } from '../i18n/index.ts';

const REMOVE_BUTTON_SELECTOR = '.btn-playlist-remove[data-queue-item-id]';

interface PlaylistRemovalControllerOptions {
  list: HTMLElement;
  canRemove: () => boolean;
  isPlaylistVisible: () => boolean;
  getItems: () => readonly PlaylistItem[];
  onDelete: (queueItemIds: QueueItemId[]) => void;
  onSelectionStart?: () => void;
}

export interface PlaylistRemovalController {
  readonly isActive: boolean;
  isSelected(queueItemId: QueueItemId): boolean;
  toggle(queueItemId: QueueItemId): void;
  afterRender(): void;
  cancel(options?: { restoreFocus?: boolean }): void;
  notifyPlaylistHidden(focusTarget?: HTMLElement | null): void;
  destroy(): void;
}

function selectionIcon(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path class="playlist-selection-frame" d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/>
    <path class="playlist-selection-symbol" d="m8.5 12 2.2 2.2 4.8-5"/>
  </svg>`;
}

function createPanel(list: HTMLElement): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'playlist-selection-pill';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = `
    <button type="button" class="playlist-selection-action" data-selection-action="select-all">
      ${selectionIcon()}
    </button>
    <button type="button" class="playlist-selection-action playlist-selection-delete" data-selection-action="delete">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12Zm2-10h8v10H8V9Zm7.5-5-1-1h-5l-1 1H5v2h14V4h-3.5Z"/>
      </svg>
      <span class="playlist-selection-count" aria-hidden="true"></span>
    </button>
    <button type="button" class="playlist-selection-action" data-selection-action="cancel">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m7 7 10 10M17 7 7 17"/>
      </svg>
    </button>`;

  const container = list.closest('#tab-playlist') ?? list.parentElement;
  container?.appendChild(panel);
  return panel;
}

function queueItemIdFromButton(button: Element | null): QueueItemId | null {
  if (!(button instanceof HTMLElement)) return null;
  return button.dataset.queueItemId || null;
}

export function createPlaylistRemovalController(
  options: PlaylistRemovalControllerOptions,
): PlaylistRemovalController {
  const { list } = options;
  const selectedQueueItemIds = new Set<QueueItemId>();
  const panel = createPanel(list);
  const abortController = new AbortController();
  let lastTriggerQueueItemId: QueueItemId | null = null;
  let pendingFocusQueueItemId: QueueItemId | null | undefined;
  let destroyed = false;

  const selectAllButton = panel.querySelector<HTMLButtonElement>(
    '[data-selection-action="select-all"]',
  );
  const deleteButton = panel.querySelector<HTMLButtonElement>('[data-selection-action="delete"]');
  const cancelButton = panel.querySelector<HTMLButtonElement>('[data-selection-action="cancel"]');
  const count = panel.querySelector<HTMLElement>('.playlist-selection-count');

  function liveItems(): readonly PlaylistItem[] {
    return options.getItems();
  }

  function restoreFocus(queueItemId: QueueItemId | null): void {
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

  function syncDom(): void {
    if (destroyed) return;
    const items = liveItems();
    const liveIds = new Set(items.map((item) => item.queueItemId));
    if (!options.canRemove()) selectedQueueItemIds.clear();
    for (const queueItemId of selectedQueueItemIds) {
      if (!liveIds.has(queueItemId)) selectedQueueItemIds.delete(queueItemId);
    }

    const selectedCount = selectedQueueItemIds.size;
    const active = selectedCount > 0;
    const allSelected = active && items.length > 0 && selectedCount === items.length;
    const itemsById = new Map(items.map((item) => [item.queueItemId, item]));
    list.classList.toggle('has-removal-selection', active);

    for (const button of list.querySelectorAll<HTMLButtonElement>(REMOVE_BUTTON_SELECTOR)) {
      const queueItemId = queueItemIdFromButton(button);
      const selected = !!queueItemId && selectedQueueItemIds.has(queueItemId);
      const item = queueItemId ? itemsById.get(queueItemId) : undefined;
      const title = item?.title || item?.name || t('common.unknown');
      const label = t(
        selected ? 'playlist.deselect_for_deletion' : 'playlist.select_for_deletion',
        { title },
      );
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', label);
      button.title = label;
      button.closest('.playlist-entry')?.classList.toggle('is-removal-selected', selected);
    }

    for (const handle of list.querySelectorAll<HTMLButtonElement>('.playlist-reorder-handle')) {
      handle.disabled = active;
      if (active) handle.removeAttribute('aria-keyshortcuts');
      else
        handle.setAttribute('aria-keyshortcuts', 'Space Enter ArrowUp ArrowDown Home End Escape');
    }

    panel.classList.toggle('is-visible', active);
    panel.setAttribute('aria-hidden', String(!active));
    panel.setAttribute('aria-label', t('playlist.remove_title'));
    if (selectAllButton) {
      const label = t(allSelected ? 'playlist.deselect_all' : 'playlist.select_all');
      selectAllButton.setAttribute('aria-label', label);
      selectAllButton.title = label;
      selectAllButton.setAttribute('aria-pressed', String(allSelected));
      selectAllButton.classList.toggle('is-selected', allSelected);
      selectAllButton.disabled = items.length === 0;
    }
    if (deleteButton) {
      const label = t('playlist.delete_selected', { count: selectedCount });
      deleteButton.disabled = !active;
      deleteButton.setAttribute('aria-label', label);
      deleteButton.title = label;
    }
    if (cancelButton) {
      const label = t('common.cancel');
      cancelButton.setAttribute('aria-label', label);
      cancelButton.title = label;
    }
    if (count) count.textContent = String(selectedCount);

    if (pendingFocusQueueItemId !== undefined) {
      const target = pendingFocusQueueItemId;
      pendingFocusQueueItemId = undefined;
      if (options.isPlaylistVisible()) {
        queueMicrotask(() => restoreFocus(target));
      }
    }
  }

  function cancel(options: { restoreFocus?: boolean } = {}): void {
    // A pending post-render restore belongs to the interaction being
    // cancelled. It must not fire after the playlist has been parked
    // off-screen by a mobile tab change.
    pendingFocusQueueItemId = undefined;
    const focusTarget = options.restoreFocus ? lastTriggerQueueItemId : null;
    if (options.restoreFocus || panel.contains(document.activeElement)) restoreFocus(focusTarget);
    selectedQueueItemIds.clear();
    syncDom();
  }

  function notifyPlaylistHidden(focusTarget: HTMLElement | null = null): void {
    const activeElement = document.activeElement;
    const focusWasInside =
      activeElement instanceof HTMLElement &&
      (list.contains(activeElement) || panel.contains(activeElement));

    pendingFocusQueueItemId = undefined;
    selectedQueueItemIds.clear();
    syncDom();

    if (!focusWasInside) return;
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    else activeElement.blur();
  }

  function toggle(queueItemId: QueueItemId): void {
    if (!options.canRemove()) return;
    if (!liveItems().some((item) => item.queueItemId === queueItemId)) return;
    const wasActive = selectedQueueItemIds.size > 0;
    lastTriggerQueueItemId = queueItemId;
    if (selectedQueueItemIds.has(queueItemId)) selectedQueueItemIds.delete(queueItemId);
    else selectedQueueItemIds.add(queueItemId);
    if (!wasActive && selectedQueueItemIds.size > 0) options.onSelectionStart?.();
    syncDom();
  }

  function toggleSelectAll(): void {
    if (!options.canRemove()) return;
    const items = liveItems();
    if (items.length === 0) return;
    if (items.every((item) => selectedQueueItemIds.has(item.queueItemId))) {
      cancel({ restoreFocus: true });
      return;
    }
    for (const item of items) selectedQueueItemIds.add(item.queueItemId);
    syncDom();
  }

  function deleteSelected(): void {
    if (!options.canRemove() || selectedQueueItemIds.size === 0) return;
    const items = liveItems();
    const orderedQueueItemIds = items
      .filter((item) => selectedQueueItemIds.has(item.queueItemId))
      .map((item) => item.queueItemId);
    if (orderedQueueItemIds.length === 0) {
      cancel();
      return;
    }

    const removedIds = new Set(orderedQueueItemIds);
    const firstRemovedIndex = items.findIndex((item) => removedIds.has(item.queueItemId));
    const survivors = items.filter((item) => !removedIds.has(item.queueItemId));
    const focusQueueItemId =
      survivors[Math.min(firstRemovedIndex, Math.max(0, survivors.length - 1))]?.queueItemId ??
      null;
    restoreFocus(focusQueueItemId);
    selectedQueueItemIds.clear();
    syncDom();
    pendingFocusQueueItemId = focusQueueItemId;
    options.onDelete(orderedQueueItemIds);
  }

  panel.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const action =
        target?.closest<HTMLElement>('[data-selection-action]')?.dataset.selectionAction;
      if (action === 'select-all') toggleSelectAll();
      else if (action === 'delete') deleteSelected();
      else if (action === 'cancel') cancel({ restoreFocus: true });
    },
    { signal: abortController.signal },
  );

  list.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || selectedQueueItemIds.size === 0) return;
      event.preventDefault();
      event.stopPropagation();
      cancel({ restoreFocus: true });
    },
    { signal: abortController.signal },
  );

  panel.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancel({ restoreFocus: true });
    },
    { signal: abortController.signal },
  );

  syncDom();

  return {
    get isActive() {
      return selectedQueueItemIds.size > 0;
    },
    isSelected: (queueItemId) => selectedQueueItemIds.has(queueItemId),
    toggle,
    afterRender: syncDom,
    cancel,
    notifyPlaylistHidden,
    destroy: () => {
      destroyed = true;
      abortController.abort();
      selectedQueueItemIds.clear();
      list.classList.remove('has-removal-selection');
      panel.remove();
    },
  };
}
