/**
 * MUSIXQUARE — Playlist View (UI)
 *
 * Manages: Playlist DOM rendering, track highlighting,
 * sub-playlist expansion, title/artist update.
 */

import { log } from '../core/log.ts';
import { bus, createBusScope } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { escapeHtml } from './dom.ts';
import { t } from '../i18n/index.ts';
import { showDialog } from './dialog.ts';
import { safeSend } from '../network/peer.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';

const SUB_ITEMS_LOAD_TIMEOUT_MS = 15000;

// ─── Expansion Toggle ────────────────────────────────────────────

function toggleExpansion(idx: number): void {
  const playlist = getState('playlist.items');
  if (!playlist[idx]) return;

  const expanding = !playlist[idx].isExpanded;
  const updated = [...playlist];
  updated[idx] = { ...updated[idx], isExpanded: expanding };
  setState('playlist.items', updated);

  const playlistId = updated[idx].playlistId;
  if (!playlistId) return;

  const timerKey = `sub-items-timeout-${playlistId}`;

  if (expanding) {
    // Clear any stale loadError flag from a previous failed attempt
    const subMap = getState('youtube.subItemsMap') || {};
    const existing = subMap[playlistId];
    if (existing?.loadError) {
      setState('youtube.subItemsMap', {
        ...subMap,
        [playlistId]: { ids: existing.ids || [], titles: existing.titles || [] },
      });
    }

    bus.emit('youtube:populate-sub-items', playlistId, idx);

    // Mark as errored if sub-items don't arrive in time, so the UI can
    // replace the "loading..." row with a fallback message instead of
    // spinning forever on YouTube API throttling or network failure.
    setManagedTimer(timerKey, () => {
      const currentMap = getState('youtube.subItemsMap') || {};
      const entry = currentMap[playlistId];
      if (!entry || !entry.ids || entry.ids.length === 0) {
        setState('youtube.subItemsMap', {
          ...currentMap,
          [playlistId]: { ids: [], titles: [], loadError: true },
        });
      }
    }, SUB_ITEMS_LOAD_TIMEOUT_MS);
  } else {
    clearManagedTimer(timerKey);
  }
}

// ─── Remove Track Dialog ─────────────────────────────────────────

async function handleRemoveTrack(idx: number): Promise<void> {
  const result = await showDialog({
    title: t('playlist.remove_title'),
    message: t('playlist.remove_message'),
    buttonText: t('playlist.remove_yes'),
    secondaryText: t('playlist.remove_no'),
  });
  if (result.action !== 'ok') return;
  bus.emit('playlist:remove-track', idx);
}

// ─── Playlist UI Render ──────────────────────────────────────────

export function updatePlaylistUI(): void {
  const ul = document.getElementById('playlist-ui');
  if (!ul) return;

  const playlist = getState('playlist.items');

  if (!Array.isArray(playlist)) {
    log.warn('[Playlist] playlist is not an array. Resetting.');
    setState('playlist.items', []);
    return;
  }

  // Preserve scroll position across rebuild
  const savedScrollTop = ul.scrollTop;
  ul.innerHTML = '';
  if (playlist.length === 0) {
    const isHost = !getState('network.hostConn');
    const key = isHost ? 'playlist.empty_hint' : 'playlist.empty_hint_guest';
    ul.innerHTML = `<li class="list-empty-state">${escapeHtml(t(key))}</li>`;
    return;
  }

  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const currentYouTubeSubIndex = getState('youtube.currentSubIndex') ?? -1;
  const subItemsMap = getState('youtube.subItemsMap') || {};

  playlist.forEach((item, idx) => {
    const isCurrent = (idx === currentTrackIndex);
    const li = document.createElement('li');
    li.className = `track-item ${isCurrent ? 'active' : ''} ${item.playlistId ? 'is-playlist' : ''}`;

    const displayName = item.name || item.title || t('common.unknown');

    let expandBtn = '';
    if (item.playlistId) {
      expandBtn = `
        <button type="button" class="expand-toggle ${item.isExpanded ? 'active' : ''}" data-expand-idx="${idx}" aria-label="${escapeHtml(t('playlist.toggle'))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>
        </button>
      `;
    }

    let icon: string;
    if (item.type === 'youtube') {
      if (item.playlistId) {
        icon = '<svg class="type-icon" viewBox="0 0 24 24" style="fill:#FF0033; transform: scale(1.2);"><path d="M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z"/></svg>';
      } else {
        icon = '<svg class="type-icon" viewBox="0 0 24 24" style="fill:#FF0033;"><path d="M21.582,6.186c-0.23-0.86-0.908-1.538-1.768-1.768C18.254,4,12,4,12,4S5.746,4,4.186,4.418c-0.86,0.23-1.538,0.908-1.768,1.768C2,7.746,2,12,2,12s0,4.254,0.418,5.814c0.23,0.86,0.908,1.538,1.768,1.768C5.746,20,12,20,12,20s6.254,0,7.814-0.418c0.86-0.23,1.538-0.908,1.768-1.768C22,16.254,22,12,22,12S22,7.746,21.582,6.186z M10,15.464V8.536L16,12L10,15.464z"/></svg>';
      }
    } else {
      icon = '<svg class="type-icon" viewBox="0 0 24 24"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.16-1.75 4.45-4H15V6h4V3h-7z"/></svg>';
    }

    li.onclick = () => {
      const hc = getState('network.hostConn');
      const op = getState('network.isOperator');
      if (!hc) bus.emit('playlist:play-track', idx);
      else if (op) safeSend(hc, { type: MSG.REQUEST_TRACK_CHANGE, index: idx });
    };

    const isHost = !getState('network.hostConn');
    const trailingEl = isHost
      ? `<button type="button" class="btn-playlist-remove" data-remove-idx="${idx}" aria-label="${escapeHtml(t('playlist.remove_title'))}">
           <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
         </button>`
      : '';

    li.innerHTML = `
      <div class="track-idx">${idx + 1}</div>
      <div class="track-name">${icon}<span class="track-name-text">${escapeHtml(displayName)}</span></div>
      ${expandBtn}
      ${trailingEl}
    `;
    ul.appendChild(li);

    // Bind expand toggle
    const exp = li.querySelector('.expand-toggle[data-expand-idx]');
    if (exp) {
      exp.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleExpansion(idx);
      });
    }

    // Bind remove button (host only)
    const removeBtn = li.querySelector('.btn-playlist-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleRemoveTrack(idx);
      });
    }

    // Sub-items
    if (item.playlistId && item.isExpanded) {
      const subUl = document.createElement('ul');
      subUl.className = 'sub-playlist';

      const subData = subItemsMap[item.playlistId];
      if (subData && subData.ids) {
        subData.ids.forEach((_sid, sIdx) => {
          const sli = document.createElement('li');
          const isActiveSub = (isCurrent && sIdx === currentYouTubeSubIndex);
          sli.className = `sub-track-item ${isActiveSub ? 'active' : ''}`;

          const sTitle = (subData.titles && subData.titles[sIdx]) ? subData.titles[sIdx] : t('playlist.video_fallback', { idx: sIdx + 1 });
          sli.innerHTML = `
            <span class="sub-idx">${sIdx + 1}</span>
            <span class="sub-name">${escapeHtml(sTitle)}</span>

          `;

          sli.onclick = (e) => {
            e.stopPropagation();
            const hc = getState('network.hostConn');
            const op = getState('network.isOperator');
            if (hc && !op) return;
            if (!hc) {
              // Compute isCurrent at click time (not render time) to avoid stale closure
              const isCurrentNow = (idx === getState('playlist.currentTrackIndex'));
              bus.emit('youtube:sub-seek', idx, sIdx, isCurrentNow);
            } else {
              safeSend(hc, { type: MSG.REQUEST_YOUTUBE_SUB_SEEK, playlistIdx: idx, subIdx: sIdx });
            }
          };
          subUl.appendChild(sli);
        });

        // Deferred-add hint: when only the single-id placeholder is in the
        // map (i.e. indexing hasn't run yet because navigation hasn't
        // happened), the user just sees one row and could mistake the
        // playlist for a single-song entry. Append a non-clickable hint
        // line that explains the rest will load on play.
        if (subData.ids.length <= 1) {
          const hintLi = document.createElement('li');
          hintLi.className = 'sub-track-item loading';
          hintLi.innerHTML = `<span class="sub-name">${escapeHtml(t('playlist.deferred_load_hint'))}</span>`;
          subUl.appendChild(hintLi);
        }
      } else if (subData?.loadError) {
        subUl.innerHTML = `<li class="sub-track-item error">${escapeHtml(t('playlist.sub_load_failed'))}</li>`;
      } else {
        subUl.innerHTML = `<li class="sub-track-item loading">${escapeHtml(t('playlist.loading_info'))}</li>`;
      }
      ul.appendChild(subUl);
    }
  });

  // Restore scroll position after DOM rebuild
  if (savedScrollTop > 0) ul.scrollTop = savedScrollTop;
}

// ─── Init ────────────────────────────────────────────────────────

let _pendingPlaylistUpdate = false;

const _busScope = createBusScope();

export function initPlaylistView(): void {
  _busScope.dispose();

  // Subscribe to playlist state changes (debounced via rAF to batch rapid updates)
  const debouncedUpdate = () => {
    if (_pendingPlaylistUpdate) return;
    _pendingPlaylistUpdate = true;
    requestAnimationFrame(() => {
      _pendingPlaylistUpdate = false;
      updatePlaylistUI();
    });
  };
  _busScope.on('state:playlist.items', debouncedUpdate);
  _busScope.on('state:playlist.currentTrackIndex', debouncedUpdate);
  _busScope.on('state:youtube.currentSubIndex', debouncedUpdate);
  _busScope.on('state:youtube.subItemsMap', debouncedUpdate);
  _busScope.on('state:appState', debouncedUpdate);
  _busScope.on('state:network.connectionType', debouncedUpdate);

  log.info('[PlaylistView] Initialized');
}
