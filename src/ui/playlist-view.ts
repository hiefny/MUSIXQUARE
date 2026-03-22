/**
 * MUSIXQUARE 3.0 — Playlist View (UI)
 *
 * Manages: Playlist DOM rendering, track highlighting,
 * sub-playlist expansion, title/artist update.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { escapeHtml } from './dom.ts';
import { updateTitleWithMarquee } from './dom.ts';
import { t } from '../i18n/index.ts';
import { showDialog } from './dialog.ts';
import { safeSend } from '../network/peer.ts';

// ─── Expansion Toggle ────────────────────────────────────────────

function toggleExpansion(idx: number): void {
  const playlist = getState('playlist.items');
  if (!playlist[idx]) return;

  const updated = [...playlist];
  updated[idx] = { ...updated[idx], isExpanded: !updated[idx].isExpanded };
  setState('playlist.items', updated);

  // When expanding a YouTube playlist, trigger sub-item population
  if (updated[idx].isExpanded && updated[idx].playlistId) {
    bus.emit('youtube:populate-sub-items', updated[idx].playlistId, idx);
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
    ul.innerHTML = `<li class="list-empty-state">${escapeHtml(t('playlist.empty_hint'))}</li>`;
    return;
  }

  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const currentYouTubeSubIndex = getState('youtube.currentSubIndex') ?? -1;
  const subItemsMap = getState('youtube.subItemsMap') || {};

  playlist.forEach((item, idx) => {
    const isCurrent = (idx === currentTrackIndex);
    const li = document.createElement('li');
    li.className = `track-item ${isCurrent ? 'active' : ''} ${item.playlistId ? 'is-playlist' : ''}`;

    let expandBtn = '';
    if (item.playlistId) {
      expandBtn = `
        <button type="button" class="expand-toggle ${item.isExpanded ? 'active' : ''}" data-expand-idx="${idx}" aria-label="${escapeHtml(t('playlist.toggle'))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>
        </button>
      `;
    }

    const icon = item.type === 'youtube'
      ? '<svg class="type-icon" viewBox="0 0 24 24" style="fill:#ff0000;"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47-.13-1.33-.22-2.65-.28-1.3-.07-2.49-.1-3.59-.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z"/></svg>'
      : '<svg class="type-icon" viewBox="0 0 24 24"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.16-1.75 4.45-4H15V6h4V3h-7z"/></svg>';

    const displayName = item.name || item.title || t('common.unknown');
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
      : `<div class="playing-indicator">
           <div class="bar"></div>
           <div class="bar"></div>
           <div class="bar"></div>
         </div>`;

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
            <div class="playing-indicator">
              <div class="bar"></div>
              <div class="bar"></div>
              <div class="bar"></div>
            </div>
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
      } else {
        subUl.innerHTML = `<li class="sub-track-item loading">${escapeHtml(t('playlist.loading_info'))}</li>`;
      }
      ul.appendChild(subUl);
    }
  });

  // Update title/artist display
  const meta = getState('transfer.meta');
  if (currentTrackIndex !== -1 && currentTrackIndex < playlist.length) {
    const currentItem = playlist[currentTrackIndex];
    let displayTitle = t('common.unknown');
    if (meta && meta.index === currentTrackIndex && meta.name) {
      displayTitle = meta.name as string;
    } else if (currentItem) {
      displayTitle = currentItem.name || currentItem.title || t('common.unknown');
    }

    updateTitleWithMarquee(displayTitle);

    const artistEl = document.getElementById('track-artist');
    if (artistEl) {
      if (currentItem?.artist) {
        artistEl.innerText = currentItem.artist;
      } else {
        artistEl.innerText = (currentItem && currentItem.type === 'youtube') ? t('common.youtube_video') : t('playlist.track_fallback', { idx: currentTrackIndex + 1 });
      }
    }
  }

  // Restore scroll position after DOM rebuild
  if (savedScrollTop > 0) ul.scrollTop = savedScrollTop;
}

// ─── Init ────────────────────────────────────────────────────────

let _pendingPlaylistUpdate = false;

export function initPlaylistView(): void {
  // Subscribe to playlist state changes (debounced via rAF to batch rapid updates)
  const debouncedUpdate = () => {
    if (_pendingPlaylistUpdate) return;
    _pendingPlaylistUpdate = true;
    requestAnimationFrame(() => {
      _pendingPlaylistUpdate = false;
      updatePlaylistUI();
    });
  };
  bus.on('state:playlist.items', debouncedUpdate);
  bus.on('state:playlist.currentTrackIndex', debouncedUpdate);
  bus.on('state:youtube.currentSubIndex', debouncedUpdate);
  bus.on('state:appState', debouncedUpdate);

  log.info('[PlaylistView] Initialized');
}
