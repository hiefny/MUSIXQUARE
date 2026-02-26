/**
 * MUSIXQUARE 2.0 — Playlist View (UI)
 * Extracted from original app.js lines 3569-3707
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
import type { DataConnection, PlaylistItem } from '../types/index.ts';

// ─── Expansion Toggle ────────────────────────────────────────────

function toggleExpansion(idx: number): void {
  const playlist = getState<PlaylistItem[]>('playlist.items');
  if (!playlist[idx]) return;
  playlist[idx].isExpanded = !playlist[idx].isExpanded;

  // When expanding a YouTube playlist, trigger sub-item population
  if (playlist[idx].isExpanded && playlist[idx].playlistId) {
    bus.emit('youtube:populate-sub-items', playlist[idx].playlistId, idx);
  }

  updatePlaylistUI();
}

// ─── Playlist UI Render ──────────────────────────────────────────

export function updatePlaylistUI(): void {
  const ul = document.getElementById('playlist-ui');
  if (!ul) return;

  const playlist = getState<PlaylistItem[]>('playlist.items');

  if (!Array.isArray(playlist)) {
    log.warn('[Playlist] playlist is not an array. Resetting.');
    setState('playlist.items', []);
    return;
  }

  ul.innerHTML = '';
  if (playlist.length === 0) {
    ul.innerHTML = '<li class="list-empty-state">미디어를 추가해주세요.</li>';
    return;
  }

  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
  const currentYouTubeSubIndex = getState<number>('youtube.currentSubIndex') ?? -1;
  const hostConn = getState<DataConnection | null>('network.hostConn');
  const isOperator = getState<boolean>('network.isOperator');
  const subItemsMap = getState<Record<string, { ids?: string[]; titles?: string[] }>>('youtube.subItemsMap') || {};

  playlist.forEach((item, idx) => {
    const isCurrent = (idx === currentTrackIndex);
    const li = document.createElement('li');
    li.className = `track-item ${isCurrent ? 'active' : ''} ${item.playlistId ? 'is-playlist' : ''}`;

    let expandBtn = '';
    if (item.playlistId) {
      expandBtn = `
        <button type="button" class="expand-toggle ${item.isExpanded ? 'active' : ''}" data-expand-idx="${idx}" aria-label="플레이리스트 펼치기/접기">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>
        </button>
      `;
    }

    const icon = item.type === 'youtube'
      ? '<svg class="type-icon" viewBox="0 0 24 24" style="fill:#ff0000;"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47-.13-1.33-.22-2.65-.28-1.3-.07-2.49-.1-3.59-.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z"/></svg>'
      : '<svg class="type-icon" viewBox="0 0 24 24"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.16-1.75 4.45-4H15V6h4V3h-7z"/></svg>';

    const displayName = item.name || item.title || 'Unknown';
    li.onclick = () => {
      const hc = getState<DataConnection | null>('network.hostConn');
      const op = getState<boolean>('network.isOperator');
      if (!hc) bus.emit('playlist:play-track', idx);
      else if (op) hc.send({ type: MSG.REQUEST_TRACK_CHANGE, index: idx });
    };

    li.innerHTML = `
      <div class="track-idx">${idx + 1}</div>
      <div class="track-name">${icon} ${escapeHtml(displayName)}</div>
      ${expandBtn}
      <div class="playing-indicator">
        <div class="bar"></div>
        <div class="bar"></div>
        <div class="bar"></div>
      </div>
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

    // Sub-items
    if (item.playlistId && item.isExpanded) {
      const subUl = document.createElement('ul');
      subUl.className = 'sub-playlist';

      const subData = subItemsMap[item.playlistId];
      if (subData && subData.ids) {
        subData.ids.forEach((sid, sIdx) => {
          const sli = document.createElement('li');
          const isActiveSub = (isCurrent && sIdx === currentYouTubeSubIndex);
          sli.className = `sub-track-item ${isActiveSub ? 'active' : ''}`;

          const sTitle = (subData.titles && subData.titles[sIdx]) ? subData.titles[sIdx] : `Video ${sIdx + 1}`;
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
            const hc = getState<DataConnection | null>('network.hostConn');
            const op = getState<boolean>('network.isOperator');
            if (hc && !op) return;
            if (!hc) {
              bus.emit('youtube:sub-seek', idx, sIdx, isCurrent);
            } else {
              hc.send({ type: MSG.REQUEST_YOUTUBE_SUB_SEEK, playlistIdx: idx, subIdx: sIdx });
            }
          };
          subUl.appendChild(sli);
        });
      } else {
        subUl.innerHTML = '<li class="sub-track-item loading">재생 정보 대기 중...</li>';
      }
      ul.appendChild(subUl);
    }
  });

  // Update title/artist display
  const meta = getState<Record<string, unknown>>('transfer.meta');
  if (currentTrackIndex !== -1) {
    const currentItem = playlist[currentTrackIndex];
    let displayTitle = 'Unknown';
    if (meta && meta.index === currentTrackIndex && meta.name) {
      displayTitle = meta.name as string;
    } else if (currentItem) {
      displayTitle = currentItem.name || currentItem.title || 'Unknown';
    }

    updateTitleWithMarquee(displayTitle);

    const artistEl = document.getElementById('track-artist');
    if (artistEl) {
      if (currentItem?.artist) {
        artistEl.innerText = currentItem.artist;
      } else {
        artistEl.innerText = (currentItem && currentItem.type === 'youtube') ? 'YouTube Video' : `Track ${currentTrackIndex + 1}`;
      }
    }
  }
}

// ─── Init ────────────────────────────────────────────────────────

export function initPlaylistView(): void {
  // Listen for playlist UI update events
  bus.on('ui:update-playlist', ((..._args: unknown[]) => {
    updatePlaylistUI();
  }) as (...args: unknown[]) => void);

  log.info('[PlaylistView] Initialized');
}
