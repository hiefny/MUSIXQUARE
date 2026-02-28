/**
 * MUSIXQUARE 2.0 — YouTube Search & URL Extraction
 * Extracted from original app.js lines 11232-11248, 11853-11926
 *
 * Manages: Video/Playlist ID extraction, oEmbed preview fetch,
 * oEmbed title cache.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, DELAY } from '../core/constants.ts';
import { broadcast } from '../network/peer.ts';

// ─── URL Extraction ────────────────────────────────────────────────

const VIDEO_PATTERNS = [
  /(?:youtube\.com\/watch\?(?:[^&]*&)*v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
];

export function extractYouTubeVideoId(url: string): string | null {
  for (const pattern of VIDEO_PATTERNS) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function extractYouTubePlaylistId(url: string): string | null {
  const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ─── oEmbed Title Cache (LRU + TTL) ───────────────────────────────

const OEMBED_CACHE_MAX = 100;
const OEMBED_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const _oEmbedTitleCache = new Map<string, { title: string; ts: number }>();
const _oEmbedInFlight = new Map<string, Promise<string | null>>();

function _oEmbedCacheGet(key: string): string | null {
  const entry = _oEmbedTitleCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > OEMBED_CACHE_TTL) {
    _oEmbedTitleCache.delete(key);
    return null;
  }
  // LRU: move to end
  _oEmbedTitleCache.delete(key);
  _oEmbedTitleCache.set(key, entry);
  return entry.title;
}

function _oEmbedCacheSet(key: string, title: string): void {
  // Evict oldest if at capacity
  if (_oEmbedTitleCache.size >= OEMBED_CACHE_MAX) {
    const oldest = _oEmbedTitleCache.keys().next().value;
    if (oldest !== undefined) _oEmbedTitleCache.delete(oldest);
  }
  _oEmbedTitleCache.set(key, { title, ts: Date.now() });
}

export async function fetchOEmbedTitle(url: string): Promise<string | null> {
  const key = String(url || '');
  if (!key) return null;

  const cached = _oEmbedCacheGet(key);
  if (cached) return cached;
  if (_oEmbedInFlight.has(key)) return _oEmbedInFlight.get(key)!;

  const p = (async (): Promise<string | null> => {
    try {
      const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(key)}&format=json`;
      const response = await fetch(oEmbedUrl);
      if (!response.ok) return null;
      const data = await response.json();
      const title = (data && typeof data.title === 'string') ? data.title.trim() : '';
      return title || null;
    } catch (e) {
      log.warn('[YouTube oEmbed] Fetch failed:', e);
      return null;
    } finally {
      _oEmbedInFlight.delete(key);
    }
  })();

  _oEmbedInFlight.set(key, p);
  const result = await p;
  if (result) _oEmbedCacheSet(key, result);
  return result;
}

// ─── oEmbed Preview Fetch (UI-bound) ───────────────────────────────

let _previewDebounce: ReturnType<typeof setTimeout> | null = null;

export function fetchYouTubePreview(url: string): void {
  const previewContainer = document.getElementById('youtube-preview');
  const statusText = document.getElementById('youtube-preview-status');
  const playBtn = document.getElementById('youtube-play-btn') as HTMLButtonElement | null;

  if (!previewContainer || !statusText) return;

  const setPlayBtnEnabled = (enabled: boolean): void => {
    if (!playBtn) return;
    playBtn.disabled = !enabled;
    playBtn.style.opacity = enabled ? '1' : '0.5';
  };

  if (_previewDebounce) clearTimeout(_previewDebounce);

  if (!url || url.trim() === '') {
    previewContainer.style.display = 'none';
    statusText.style.display = 'block';
    statusText.innerText = t('youtube.enter_link_placeholder');
    statusText.style.color = 'var(--text-sub)';
    setPlayBtnEnabled(false);
    return;
  }

  const videoId = extractYouTubeVideoId(url);
  const playlistId = extractYouTubePlaylistId(url);

  if (!videoId && !playlistId) {
    previewContainer.style.display = 'none';
    statusText.style.display = 'block';
    statusText.innerText = t('youtube.invalid_link');
    statusText.style.color = '#ef4444';
    setPlayBtnEnabled(false);
    return;
  }

  statusText.style.display = 'block';
  statusText.innerText = t('youtube.fetching_info');
  statusText.style.color = 'var(--text-sub)';
  setPlayBtnEnabled(false);

  _previewDebounce = setTimeout(async () => {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const response = await fetch(oembedUrl);
      if (!response.ok) throw new Error('Video not found');
      const data = await response.json();

      const thumb = document.getElementById('youtube-preview-thumb') as HTMLImageElement | null;
      const title = document.getElementById('youtube-preview-title');
      const chan = document.getElementById('youtube-preview-channel');
      if (thumb) thumb.src = data.thumbnail_url;
      if (title) title.innerText = data.title;
      if (chan) chan.innerText = data.author_name;

      previewContainer.style.display = 'block';
      statusText.style.display = 'none';
      setPlayBtnEnabled(true);
    } catch (e) {
      log.error('[YouTube Preview] Error:', e);
      previewContainer.style.display = 'none';
      statusText.style.display = 'block';
      statusText.innerText = t('youtube.fetch_failed');
      statusText.style.color = '#ef4444';
      setPlayBtnEnabled(false);
    }
  }, 500);
}

// ─── Background Playlist Sub-Title Fetcher ─────────────────────────

/** Dedup flag per playlistId to avoid parallel fetches */
const _isFetching = new Map<string, boolean>();
let _uiTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Background oEmbed fetcher for YouTube playlist sub-item titles.
 * Sequentially fetches titles with 200ms delay between requests.
 * Updates state, UI, and broadcasts to peers as titles arrive.
 * Ported from original app.js fetchPlaylistSubTitles().
 */
export async function fetchPlaylistSubTitles(playlistId: string, ids: string[]): Promise<void> {
  if (!ids || ids.length === 0) return;

  const subMap = getState('youtube.subItemsMap') || {};
  const data = subMap[playlistId];
  if (!data) return;

  if (_isFetching.get(playlistId)) return; // Dedupe
  _isFetching.set(playlistId, true);

  log.debug(`[YouTube Feed] Starting title fetch for playlist: ${playlistId} (${ids.length} items)`);

  try {
    for (let i = 0; i < ids.length; i++) {
      // Re-read state in case it was updated externally
      const currentMap = getState('youtube.subItemsMap') || {};
      const currentData = currentMap[playlistId];
      if (!currentData) break;

      // Skip if already has title
      if (currentData.titles[i]) continue;

      try {
        const videoId = ids[i];
        const response = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`
        );
        if (!response.ok) continue;
        const json = await response.json();

        if (json && json.title) {
          // Update state
          const freshMap = getState('youtube.subItemsMap') || {};
          if (!freshMap[playlistId]) freshMap[playlistId] = { ids: [], titles: [] };
          freshMap[playlistId].titles[i] = json.title;
          setState('youtube.subItemsMap', { ...freshMap });

          log.debug(`[YouTube Feed] Fetched Title [${i}]: ${json.title}`);

          // Debounced UI update to avoid rebuilding DOM per-title
          if (_uiTimer) clearTimeout(_uiTimer);
          _uiTimer = setTimeout(() => bus.emit('ui:update-playlist'), 200);

          // Only Host broadcasts to peers
          const hostConn = getState('network.hostConn');
          if (!hostConn) {
            broadcast({
              type: MSG.YOUTUBE_SUB_TITLE_UPDATE,
              playlistId,
              subIdx: i,
              title: json.title,
            });
          }
        }
      } catch (e) {
        log.warn(`[YouTube Feed] Failed to fetch title for ${ids[i]}:`, e);
      }

      // 200ms delay between requests to avoid rate limiting
      await new Promise(r => setTimeout(r, DELAY.RETRY));
    }
  } finally {
    _isFetching.delete(playlistId);
  }
}
