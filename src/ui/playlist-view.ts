/**
 * MUSIXQUARE — Playlist View (UI)
 *
 * Renders stable queue occurrences and delegates row actions by queueItemId.
 * Pointer/touch/keyboard reordering lives in playlist-reorder.ts.
 */

import { log } from '../core/log.ts';
import { bus, createBusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import type { PlaylistItem, QueueItemId } from '../types/index.ts';
import { findQueueItemIndex, getQueueItemById } from '../player/queue-model.ts';
import { escapeHtml } from './dom.ts';
import { t } from '../i18n/index.ts';
import { safeSend } from '../network/peer.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { showToast } from './toast.ts';
import { setSubItemsLoadError } from '../youtube/_state.ts';
import {
  createPlaylistReorderController,
  type PlaylistReorderController,
} from './playlist-reorder.ts';
import {
  createPlaylistRemovalController,
  type PlaylistRemovalController,
} from './playlist-removal.ts';
import {
  createPlaylistFollowController,
  type PlaylistFollowController,
} from './playlist-follow.ts';
import {
  createPlaylistCurrentJumpController,
  type PlaylistCurrentJumpController,
  type PlaylistCurrentSelection,
} from './playlist-current-jump.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import { beginProRoomTrackChangeIntent } from '../player/track-change-intent.ts';
import { applyUserTextFontFallback } from './user-text-font.ts';
import { getTrackDisplayTitle } from '../player/track-display.ts';

const SUB_ITEMS_LOAD_TIMEOUT_MS = 15000;
// A full YouTube playlist can contain 5,000 entries. Building every row in
// one task blocks touch/scroll input on mobile, so render one useful viewport
// immediately and yield between the remaining batches.
const SUB_ITEMS_INITIAL_RENDER_COUNT = 240;
const SUB_ITEMS_RENDER_BATCH_SIZE = 240;

let _pendingPlaylistUpdate = false;
let _deferredPlaylistUpdate = false;
let _playlistRaf = 0;
let _subPlaylistRenderGeneration = 0;
const _subPlaylistRenderFrames = new Set<number>();
const _renderedSubPlaylistIds = new WeakMap<HTMLUListElement, readonly string[]>();
let _domAbort: AbortController | null = null;
let _reorderController: PlaylistReorderController | null = null;
let _removalController: PlaylistRemovalController | null = null;
let _followController: PlaylistFollowController | null = null;
let _currentJumpController: PlaylistCurrentJumpController | null = null;
let _followList: HTMLElement | null = null;
let _followScrollContainer: HTMLElement | null = null;

// Expansion is view-local. It must not increment the authoritative playlist
// revision or clone a queue item while a drag owns that item's identity.
const _expansionOverrides = new Map<QueueItemId, boolean>();
const _busScope = createBusScope();

function canEditQueueStructure(): boolean {
  return hasRoomCapability('queue.mutate');
}

function resolveQueueIndex(queueItemId: QueueItemId): number {
  return findQueueItemIndex(queueItemId, getState('playlist.items'));
}

function isExpanded(item: PlaylistItem): boolean {
  return _expansionOverrides.get(item.queueItemId) ?? !!item.isExpanded;
}

function pruneExpansionOverrides(items: readonly PlaylistItem[]): void {
  const liveIds = new Set(items.map((item) => item.queueItemId));
  for (const id of _expansionOverrides.keys()) {
    if (!liveIds.has(id)) _expansionOverrides.delete(id);
  }
}

function playlistIsVisible(): boolean {
  const panel = document.getElementById('tab-playlist');
  if (!panel) return true;
  try {
    if (window.matchMedia('(min-width: 1280px)').matches) return true;
  } catch {
    /* matchMedia can be unavailable in tests. */
  }
  return panel.classList.contains('active');
}

function effectiveFollowSubIndex(
  playlist: readonly PlaylistItem[],
  queueItemId: QueueItemId | null,
  subIndex: number,
): number {
  if (!queueItemId || !Number.isSafeInteger(subIndex) || subIndex < 0) return -1;
  const current = playlist.find((item) => item.queueItemId === queueItemId);
  return current?.type === 'youtube' && !!current.playlistId && isExpanded(current) ? subIndex : -1;
}

function currentFollowSelection(
  playlist: readonly PlaylistItem[] = getState('playlist.items'),
): PlaylistCurrentSelection {
  const queueItemId = getState('playlist.currentQueueItemId');
  return {
    queueItemId,
    subIndex: effectiveFollowSubIndex(
      playlist,
      queueItemId,
      getState('youtube.currentSubIndex') ?? -1,
    ),
  };
}

function ensureFollowController(
  list: HTMLElement,
  scrollContainer: HTMLElement,
): PlaylistFollowController {
  if (_followController && _followList === list && _followScrollContainer === scrollContainer) {
    return _followController;
  }

  _followController?.destroy();
  _currentJumpController?.destroy();
  _followList = list;
  _followScrollContainer = scrollContainer;
  const isBlocked = () => !!_reorderController?.isActive || !!_removalController?.isActive;
  _followController = createPlaylistFollowController({
    list,
    scrollContainer,
    isVisible: playlistIsVisible,
    isBlocked,
  });

  const panel = document.getElementById('tab-playlist');
  _currentJumpController = panel
    ? createPlaylistCurrentJumpController({
        panel,
        list,
        scrollContainer,
        getSelection: currentFollowSelection,
        isVisible: () => playlistIsVisible() && getState('playback.mode') !== 'system-audio',
        isBlocked,
        onActivate: (selection) => {
          _followController?.forceSelection(selection.queueItemId, selection.subIndex);
          _followController?.afterRender();
        },
      })
    : null;
  return _followController;
}

function toggleExpansion(queueItemId: QueueItemId): void {
  const idx = resolveQueueIndex(queueItemId);
  const item = idx >= 0 ? getState('playlist.items')[idx] : undefined;
  if (!item) return;

  const expanding = !isExpanded(item);
  _expansionOverrides.set(queueItemId, expanding);
  updatePlaylistUI();

  const playlistId = item.playlistId;
  if (!playlistId) return;
  const timerKey = `sub-items-timeout-${queueItemId}`;

  if (expanding) {
    const subMap = getState('youtube.subItemsMap') || {};
    const existing = subMap[playlistId];
    if (existing?.loadError) setSubItemsLoadError(playlistId, false);
    bus.emit('youtube:populate-sub-items', playlistId, queueItemId);
    setManagedTimer(
      timerKey,
      () => {
        const currentMap = getState('youtube.subItemsMap') || {};
        const entry = currentMap[playlistId];
        if (!entry?.ids?.length) setSubItemsLoadError(playlistId, true);
      },
      SUB_ITEMS_LOAD_TIMEOUT_MS,
    );
  } else {
    clearManagedTimer(timerKey);
  }
}

function renderLeadingSlot(item: PlaylistItem, idx: number, canReorder: boolean): string {
  if (!canReorder) {
    return `<div class="track-leading track-leading-static" aria-hidden="true"><span class="track-idx">${idx + 1}</span></div>`;
  }

  const label = t('playlist.reorder_handle', {
    title: getTrackDisplayTitle(item),
    position: idx + 1,
  });
  return `
    <button type="button" class="track-leading playlist-reorder-handle"
      data-queue-item-id="${escapeHtml(item.queueItemId)}"
      aria-label="${escapeHtml(label)}" aria-grabbed="false"
      aria-keyshortcuts="Space Enter ArrowUp ArrowDown Home End Escape">
      <span class="track-idx" aria-hidden="true">${idx + 1}</span>
      <svg class="playlist-reorder-grip" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 8h14M5 12h14M5 16h14"/>
      </svg>
    </button>`;
}

function renderTrackIcon(item: PlaylistItem): string {
  if (item.type === 'youtube') {
    return item.playlistId
      ? '<svg class="type-icon" viewBox="0 0 24 24" aria-hidden="true" style="fill:#FF0033; transform: scale(1.2);"><path d="M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z"/></svg>'
      : '<svg class="type-icon" viewBox="0 0 24 24" aria-hidden="true" style="fill:#FF0033;"><path d="M21.582 6.186a2.5 2.5 0 0 0-1.768-1.768C18.254 4 12 4 12 4s-6.254 0-7.814.418a2.5 2.5 0 0 0-1.768 1.768C2 7.746 2 12 2 12s0 4.254.418 5.814a2.5 2.5 0 0 0 1.768 1.768C5.746 20 12 20 12 20s6.254 0 7.814-.418a2.5 2.5 0 0 0 1.768-1.768C22 16.254 22 12 22 12s0-4.254-.418-5.814ZM10 15.464V8.536L16 12l-6 3.464Z"/></svg>';
  }
  return '<svg class="type-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.16-1.75 4.45-4H15V6h4V3h-7Z"/></svg>';
}

function cancelSubPlaylistProgressiveRenders(): void {
  _subPlaylistRenderGeneration += 1;
  for (const frame of _subPlaylistRenderFrames) cancelAnimationFrame(frame);
  _subPlaylistRenderFrames.clear();
}

function createSubTrackItem(
  item: PlaylistItem,
  videoId: string,
  subIndex: number,
  title: string,
  isActiveSub: boolean,
): HTMLLIElement {
  const subItem = document.createElement('li');
  subItem.className = `sub-track-item ${isActiveSub ? 'active' : ''}`;
  subItem.dataset.queueItemId = item.queueItemId;
  subItem.dataset.subIndex = String(subIndex);
  subItem.dataset.videoId = videoId;
  subItem.setAttribute('role', 'button');
  subItem.tabIndex = 0;

  const subIdx = document.createElement('span');
  subIdx.className = 'sub-idx';
  subIdx.textContent = String(subIndex + 1);
  const subName = document.createElement('span');
  subName.className = 'sub-name';
  subName.textContent = title;
  applyUserTextFontFallback(subName, title);
  subItem.replaceChildren(subIdx, subName);
  return subItem;
}

function scheduleSubPlaylistBatch(
  subUl: HTMLUListElement,
  item: PlaylistItem,
  playlistId: string,
  ids: readonly string[],
  startIndex: number,
  isCurrent: boolean,
  currentYouTubeSubIndex: number,
  generation: number,
): void {
  let frame = 0;
  frame = requestAnimationFrame(() => {
    _subPlaylistRenderFrames.delete(frame);
    const latest = (getState('youtube.subItemsMap') || {})[playlistId];
    if (generation !== _subPlaylistRenderGeneration || !subUl.isConnected || latest?.ids !== ids) {
      return;
    }

    const endIndex = Math.min(ids.length, startIndex + SUB_ITEMS_RENDER_BATCH_SIZE);
    const fragment = document.createDocumentFragment();
    for (let subIndex = startIndex; subIndex < endIndex; subIndex += 1) {
      const title =
        latest.titles?.[subIndex] || t('playlist.video_fallback', { idx: subIndex + 1 });
      fragment.appendChild(
        createSubTrackItem(
          item,
          ids[subIndex] || '',
          subIndex,
          title,
          isCurrent && subIndex === currentYouTubeSubIndex,
        ),
      );
    }
    subUl.appendChild(fragment);
    _followController?.afterRender();

    if (endIndex < ids.length) {
      scheduleSubPlaylistBatch(
        subUl,
        item,
        playlistId,
        ids,
        endIndex,
        isCurrent,
        currentYouTubeSubIndex,
        generation,
      );
    } else {
      subUl.removeAttribute('aria-busy');
    }
  });
  _subPlaylistRenderFrames.add(frame);
}

function appendSubPlaylist(
  entry: HTMLLIElement,
  item: PlaylistItem,
  isCurrent: boolean,
  currentYouTubeSubIndex: number,
): void {
  const playlistId = item.playlistId;
  if (!playlistId || !isExpanded(item)) return;

  const subUl = document.createElement('ul');
  subUl.className = 'sub-playlist';
  subUl.dataset.playlistId = playlistId;
  const subData = (getState('youtube.subItemsMap') || {})[playlistId];

  if (subData?.ids) {
    const ids = subData.ids;
    subUl.dataset.renderState = 'items';
    subUl.dataset.itemCount = String(ids.length);
    _renderedSubPlaylistIds.set(subUl, ids);
    const initialEnd = Math.min(ids.length, SUB_ITEMS_INITIAL_RENDER_COUNT);
    const fragment = document.createDocumentFragment();
    for (let subIndex = 0; subIndex < initialEnd; subIndex += 1) {
      const title =
        subData.titles?.[subIndex] || t('playlist.video_fallback', { idx: subIndex + 1 });
      fragment.appendChild(
        createSubTrackItem(
          item,
          ids[subIndex] || '',
          subIndex,
          title,
          isCurrent && subIndex === currentYouTubeSubIndex,
        ),
      );
    }
    subUl.appendChild(fragment);

    if (ids.length <= 1) {
      const hintItem = document.createElement('li');
      hintItem.className = 'sub-track-item loading';
      const hint = document.createElement('span');
      hint.className = 'sub-name';
      hint.textContent = t('playlist.deferred_load_hint');
      hintItem.replaceChildren(hint);
      subUl.appendChild(hintItem);
    } else if (initialEnd < ids.length) {
      subUl.setAttribute('aria-busy', 'true');
      scheduleSubPlaylistBatch(
        subUl,
        item,
        playlistId,
        ids,
        initialEnd,
        isCurrent,
        currentYouTubeSubIndex,
        _subPlaylistRenderGeneration,
      );
    }
  } else if (subData?.loadError) {
    subUl.dataset.renderState = 'error';
    const error = document.createElement('li');
    error.className = 'sub-track-item error';
    error.textContent = t('playlist.sub_load_failed');
    subUl.appendChild(error);
  } else {
    subUl.dataset.renderState = 'loading';
    const loading = document.createElement('li');
    loading.className = 'sub-track-item loading';
    loading.textContent = t('playlist.loading_info');
    subUl.appendChild(loading);
  }
  entry.appendChild(subUl);
}

/**
 * Title fetches arrive one or a small batch at a time. Rebuilding a 5,000-row
 * playlist for each title creates quadratic DOM work. If the ID manifest is
 * unchanged, patch only mounted labels and let progressive batches read the
 * latest titles when they are created.
 */
function patchRenderedSubPlaylistTitles(list: HTMLElement): boolean {
  const subMap = getState('youtube.subItemsMap') || {};
  for (const subUl of list.querySelectorAll<HTMLUListElement>('.sub-playlist[data-playlist-id]')) {
    const playlistId = subUl.dataset.playlistId;
    if (!playlistId) return false;
    const latest = subMap[playlistId];
    if (!latest?.ids || subUl.dataset.renderState !== 'items') return false;

    const renderedIds = _renderedSubPlaylistIds.get(subUl);
    if (!renderedIds || renderedIds.length !== latest.ids.length) return false;
    if (renderedIds !== latest.ids) {
      if (!renderedIds.every((id, index) => id === latest.ids[index])) return false;
      // A progressive renderer still owns the old array identity. Restart it
      // rather than silently stopping the remaining batches on the next
      // identity guard.
      if (subUl.querySelectorAll('.sub-track-item[data-sub-index]').length < latest.ids.length) {
        return false;
      }
      _renderedSubPlaylistIds.set(subUl, latest.ids);
    }

    for (const row of subUl.querySelectorAll<HTMLElement>(
      '.sub-track-item[data-sub-index][data-video-id]',
    )) {
      const subIndex = Number(row.dataset.subIndex);
      if (
        !Number.isSafeInteger(subIndex) ||
        subIndex < 0 ||
        row.dataset.videoId !== latest.ids[subIndex]
      ) {
        return false;
      }
      const title =
        latest.titles?.[subIndex] || t('playlist.video_fallback', { idx: subIndex + 1 });
      const name = row.querySelector<HTMLElement>('.sub-name');
      if (name && name.textContent !== title) {
        name.textContent = title;
        applyUserTextFontFallback(name, title);
      }
    }
  }
  return true;
}

export function updatePlaylistUI(): void {
  const list = document.getElementById('playlist-ui');
  if (!list) return;
  if (_reorderController?.isActive) {
    _deferredPlaylistUpdate = true;
    return;
  }
  // A pending touch probe is not exposed as an active drag, but its timer must
  // never retain a row that this full render is about to detach.
  _reorderController?.cancel();
  cancelSubPlaylistProgressiveRenders();

  const playlist = getState('playlist.items');
  if (!Array.isArray(playlist)) {
    log.warn('[Playlist] playlist is not an array; render skipped');
    return;
  }

  pruneExpansionOverrides(playlist);
  const scrollContainer = list.closest<HTMLElement>('.tab-body') ?? list;
  const followController = ensureFollowController(list, scrollContainer);
  const savedScrollTop = scrollContainer.scrollTop;
  list.replaceChildren();

  if (playlist.length === 0) {
    followController.reset();
    _currentJumpController?.afterRender();
    const key = 'playlist.empty_hint';
    const empty = document.createElement('li');
    empty.className = 'list-empty-state';
    empty.setAttribute('data-i18n', key);
    empty.textContent = t(key);
    list.appendChild(empty);
    _reorderController?.afterRender();
    _removalController?.afterRender();
    return;
  }

  const currentQueueItemId = getState('playlist.currentQueueItemId');
  const currentYouTubeSubIndex = getState('youtube.currentSubIndex') ?? -1;
  const canEditPlaylist = canEditQueueStructure() && getState('playback.mode') !== 'system-audio';
  const canReorder = canEditPlaylist && playlist.length > 1;

  playlist.forEach((item, idx) => {
    const isCurrent = item.queueItemId === currentQueueItemId;
    const entry = document.createElement('li');
    entry.className = `playlist-entry ${item.playlistId ? 'is-playlist' : ''}`;
    entry.dataset.queueItemId = item.queueItemId;
    entry.dataset.playlistIndex = String(idx);

    const row = document.createElement('div');
    row.className = `track-item ${isCurrent ? 'active' : ''}`;
    row.dataset.queueItemId = item.queueItemId;
    const displayName = getTrackDisplayTitle(item, t('common.unknown'));
    const expandButton = item.playlistId
      ? `<button type="button" class="expand-toggle ${isExpanded(item) ? 'active' : ''}"
          data-action="expand" data-queue-item-id="${escapeHtml(item.queueItemId)}"
          aria-label="${escapeHtml(t('playlist.toggle'))}" aria-expanded="${isExpanded(item)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 9 5.5 5.5L17.5 9"/></svg>
        </button>`
      : '';
    const isRemovalSelected = _removalController?.isSelected(item.queueItemId) ?? false;
    const removeLabel = t(
      isRemovalSelected ? 'playlist.deselect_for_deletion' : 'playlist.select_for_deletion',
      { title: displayName },
    );
    const removeButton = canEditPlaylist
      ? `<button type="button" class="btn-playlist-remove${isRemovalSelected ? ' is-selected' : ''}" data-action="remove"
          data-queue-item-id="${escapeHtml(item.queueItemId)}"
          aria-pressed="${isRemovalSelected}"
          aria-label="${escapeHtml(removeLabel)}" title="${escapeHtml(removeLabel)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12Z"/></svg>
        </button>`
      : '';

    row.innerHTML = `
      ${renderLeadingSlot(item, idx, canReorder)}
      <button type="button" class="track-name" data-action="play"
        data-queue-item-id="${escapeHtml(item.queueItemId)}"
        ${isCurrent ? 'aria-current="true"' : ''}>${renderTrackIcon(item)}<span class="track-name-text">${escapeHtml(displayName)}</span></button>
      ${expandButton}
      ${removeButton}
    `;
    const renderedName = row.querySelector<HTMLElement>('.track-name-text');
    if (renderedName) applyUserTextFontFallback(renderedName, displayName);
    entry.appendChild(row);
    appendSubPlaylist(entry, item, isCurrent, currentYouTubeSubIndex);
    list.appendChild(entry);
  });

  // DOM replacement must not turn an in-flight follow into a false success.
  // Restore the current physical position first; the follow controller then
  // recenters the active occurrence on the next layout frame and survives any
  // immediate follow-up render.
  scrollContainer.scrollTop = savedScrollTop;
  const followSelection = currentFollowSelection(playlist);
  followController.updateSelection(followSelection.queueItemId, followSelection.subIndex);
  _reorderController?.afterRender();
  _removalController?.afterRender();
  followController.afterRender();
  _currentJumpController?.afterRender();
}

function queueItemIdFromElement(element: Element | null): QueueItemId | null {
  if (!(element instanceof HTMLElement)) return null;
  return element.dataset.queueItemId || null;
}

function playQueueItem(queueItemId: QueueItemId): void {
  if (!getQueueItemById(queueItemId)) return;
  if (!hasRoomCapability('playback.control')) {
    showToast(t('toast.host_only_control'));
    return;
  }
  const hostConn = getState('network.hostConn');
  if (!hostConn) bus.emit('playlist:play-track', queueItemId);
  else {
    const sent = safeSend(hostConn, { type: MSG.REQUEST_TRACK_CHANGE, queueItemId });
    const roomContext = getState('room.context');
    if (sent && roomContext.kind === 'pro' && roomContext.role === 'member') {
      beginProRoomTrackChangeIntent(queueItemId);
    }
  }
}

function seekSubItem(queueItemId: QueueItemId, subIndex: number): void {
  if (!Number.isSafeInteger(subIndex) || subIndex < 0 || !getQueueItemById(queueItemId)) return;
  if (!hasRoomCapability('playback.control')) {
    showToast(t('toast.host_only_control'));
    return;
  }
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    const isCurrent = queueItemId === getState('playlist.currentQueueItemId');
    bus.emit('youtube:sub-seek', queueItemId, subIndex, isCurrent);
  } else {
    safeSend(hostConn, { type: MSG.REQUEST_YOUTUBE_SUB_SEEK, queueItemId, subIdx: subIndex });
  }
}

function installDomDelegation(list: HTMLElement): void {
  _domAbort?.abort();
  _domAbort = new AbortController();
  const { signal } = _domAbort;

  list.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('.playlist-reorder-handle')) return;

      const expand = target.closest<HTMLElement>('[data-action="expand"]');
      if (expand) {
        event.preventDefault();
        event.stopPropagation();
        const id = queueItemIdFromElement(expand);
        if (id) toggleExpansion(id);
        return;
      }
      const remove = target.closest<HTMLElement>('[data-action="remove"]');
      if (remove) {
        event.preventDefault();
        event.stopPropagation();
        const id = queueItemIdFromElement(remove);
        if (id) _removalController?.toggle(id);
        return;
      }
      const subItem = target.closest<HTMLElement>('.sub-track-item[data-sub-index]');
      if (subItem) {
        event.preventDefault();
        event.stopPropagation();
        const id = queueItemIdFromElement(subItem);
        if (id) seekSubItem(id, Number(subItem.dataset.subIndex));
        return;
      }
      const row = target.closest<HTMLElement>('.track-item[data-queue-item-id]');
      const id = queueItemIdFromElement(row);
      if (row && id) playQueueItem(id);
    },
    { signal },
  );

  list.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target instanceof Element ? event.target : null;
      const subItem = target?.closest<HTMLElement>('.sub-track-item[data-sub-index]');
      if (!subItem) return;
      event.preventDefault();
      const id = queueItemIdFromElement(subItem);
      if (id) seekSubItem(id, Number(subItem.dataset.subIndex));
    },
    { signal },
  );
}

function createReorderController(list: HTMLElement): PlaylistReorderController {
  _reorderController?.destroy();
  const controller = createPlaylistReorderController({
    list,
    canReorder: () =>
      canEditQueueStructure() &&
      getState('playback.mode') !== 'system-audio' &&
      !_removalController?.isActive &&
      getState('playlist.items').length > 1,
    isPlaylistVisible: playlistIsVisible,
    onCommit: (queueItemId, beforeQueueItemId) => {
      bus.emit(
        'playlist:reorder-track',
        queueItemId,
        beforeQueueItemId,
        getState('playlist.revision'),
      );
    },
    getAnnouncement: (queueItemId, position, total) => {
      const item = getQueueItemById(queueItemId);
      return t('playlist.reorder_position', {
        title: item ? getTrackDisplayTitle(item, t('common.unknown')) : t('common.unknown'),
        position,
        total,
      });
    },
    getHandleLabel: (queueItemId, position) => {
      const item = getQueueItemById(queueItemId);
      return t('playlist.reorder_handle', {
        title: item ? getTrackDisplayTitle(item, t('common.unknown')) : t('common.unknown'),
        position,
      });
    },
    onInteractionEnd: (didRequestCommit) => {
      _currentJumpController?.refresh();
      if (!didRequestCommit && !_deferredPlaylistUpdate) return;
      _deferredPlaylistUpdate = false;
      schedulePlaylistUpdate();
    },
  });
  _reorderController = controller;
  return controller;
}

function schedulePlaylistUpdate(): void {
  if (_reorderController?.isActive) {
    _deferredPlaylistUpdate = true;
    return;
  }
  if (_pendingPlaylistUpdate) return;
  _pendingPlaylistUpdate = true;
  _playlistRaf = requestAnimationFrame(() => {
    _pendingPlaylistUpdate = false;
    _playlistRaf = 0;
    updatePlaylistUI();
  });
}

function updateSubPlaylistUI(): void {
  if (_reorderController?.isActive) {
    _deferredPlaylistUpdate = true;
    return;
  }
  const list = document.getElementById('playlist-ui');
  if (!list || !patchRenderedSubPlaylistTitles(list)) {
    schedulePlaylistUpdate();
  }
}

export function initPlaylistView(): void {
  _busScope.dispose();
  _domAbort?.abort();
  _domAbort = null;
  _reorderController?.destroy();
  _reorderController = null;
  _removalController?.destroy();
  _removalController = null;
  _followController?.destroy();
  _followController = null;
  _currentJumpController?.destroy();
  _currentJumpController = null;
  _followList = null;
  _followScrollContainer = null;
  if (_playlistRaf) cancelAnimationFrame(_playlistRaf);
  cancelSubPlaylistProgressiveRenders();
  _playlistRaf = 0;
  _pendingPlaylistUpdate = false;
  _deferredPlaylistUpdate = false;

  const list = document.getElementById('playlist-ui');
  if (list) {
    installDomDelegation(list);
    createReorderController(list);
    _removalController = createPlaylistRemovalController({
      list,
      canRemove: () => canEditQueueStructure() && getState('playback.mode') !== 'system-audio',
      isPlaylistVisible: playlistIsVisible,
      getItems: () => getState('playlist.items'),
      onDelete: (queueItemIds) => bus.emit('playlist:remove-tracks', queueItemIds),
      onSelectionStart: () => {
        _reorderController?.cancel();
        _currentJumpController?.refresh();
      },
      // Selection mode blocks follow without discarding its pending request.
      // Resume only that request: forcing the current row here would recenter
      // an unchanged playlist and fight deletion's survivor-focus restore.
      onSelectionEnd: () => {
        _followController?.afterRender();
        _currentJumpController?.refresh();
      },
    });
  }

  const initialRoomContext = getRoomContext();
  let queueEditBoundary = {
    kind: initialRoomContext.kind,
    roomId: initialRoomContext.roomId,
    epoch: initialRoomContext.epoch,
    canEdit: canEditQueueStructure(),
  };

  _busScope.on('state:playlist.items', () => {
    if (_reorderController?.isActive && !_reorderController.isSettling) {
      _reorderController.cancel();
    }
    schedulePlaylistUpdate();
  });
  _busScope.on('state:playlist.currentQueueItemId', schedulePlaylistUpdate);
  _busScope.on('state:youtube.currentSubIndex', schedulePlaylistUpdate);
  _busScope.on('state:youtube.subItemsMap', updateSubPlaylistUI);
  _busScope.on('playlist:refresh-requested', schedulePlaylistUpdate);
  _busScope.on('state:network.hostConn', () => {
    _reorderController?.cancel();
    _removalController?.cancel();
    schedulePlaylistUpdate();
  });
  _busScope.on('state:network.isOperator', (isOperator) => {
    // Standard-room ADMIN grants and revocations do not change hostConn or
    // room.context. Re-render from the capability source itself so queue edit
    // controls appear immediately on grant and an in-flight edit is cancelled
    // immediately on revoke.
    if (!isOperator || !canEditQueueStructure()) {
      _reorderController?.cancel();
      _removalController?.cancel();
    }
    schedulePlaylistUpdate();
  });
  _busScope.on('state:network.standardRoomCapabilities', () => {
    if (!canEditQueueStructure()) {
      _reorderController?.cancel();
      _removalController?.cancel();
    }
    schedulePlaylistUpdate();
  });
  _busScope.on('state:room.context', () => {
    const context = getRoomContext();
    const nextBoundary = {
      kind: context.kind,
      roomId: context.roomId,
      epoch: context.epoch,
      canEdit: canEditQueueStructure(),
    };
    const roomChanged =
      queueEditBoundary.kind !== nextBoundary.kind ||
      queueEditBoundary.roomId !== nextBoundary.roomId ||
      queueEditBoundary.epoch !== nextBoundary.epoch;
    const editAuthorityLost = queueEditBoundary.canEdit && !nextBoundary.canEdit;

    // Snapshot revision pulses and unrelated capability updates do not own an
    // in-progress queue interaction. Invalidate it only when its room changes
    // or the user actually loses structural-edit authority.
    if (roomChanged || editAuthorityLost) {
      _reorderController?.cancel();
      _removalController?.cancel();
    }
    if (roomChanged || queueEditBoundary.canEdit !== nextBoundary.canEdit) {
      schedulePlaylistUpdate();
    }
    queueEditBoundary = nextBoundary;
  });
  _busScope.on('state:playback.mode', () => {
    if (getState('playback.mode') === 'system-audio') _removalController?.cancel();
    schedulePlaylistUpdate();
  });
  _busScope.on('i18n:changed', schedulePlaylistUpdate);
  _busScope.on('playlist:items-added', () => _reorderController?.notifyItemsAdded());

  _busScope.on('ui:playlist-tab-opened', () => {
    const selection = currentFollowSelection();
    _followController?.forceSelection(selection.queueItemId, selection.subIndex);
    updatePlaylistUI();
    _reorderController?.notifyPlaylistEntered();
  });
  _busScope.on('ui:tab-changed', (tabId) => {
    if (tabId !== 'playlist') {
      _reorderController?.notifyPlaylistHidden();
      if (!playlistIsVisible()) {
        // Narrow layouts genuinely park the playlist off-screen. The wide
        // desktop dashboard keeps it visible, so a playback-driven logical
        // tab change must not discard an in-progress deletion selection.
        const destination = Array.from(
          document.querySelectorAll<HTMLElement>('.nav-item[data-tab]'),
        ).find((item) => item.dataset.tab === tabId);
        _removalController?.notifyPlaylistHidden(destination ?? null);
      }
    }
    _currentJumpController?.refresh();
  });
  _busScope.on('state:network.appRole', (role: unknown) => {
    if (role === 'idle') {
      _followController?.reset();
      _expansionOverrides.clear();
      _reorderController?.cancel();
      _removalController?.cancel();
      _currentJumpController?.refresh();
    }
  });
  updatePlaylistUI();
  log.info('[PlaylistView] Initialized');
}
