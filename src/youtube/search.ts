/**
 * MUSIXQUARE 3.0 — YouTube Search & URL Extraction
 *
 * Manages: Video/Playlist ID extraction, oEmbed preview fetch,
 * oEmbed title cache.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { getState } from '../core/state.ts';
import { MSG, DELAY } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer, delay } from '../core/timers.ts';
import { broadcast } from '../network/peer.ts';
import { updateSubItemTitle } from './_state.ts';

// ─── Fetch with Timeout ──────────────────────────────────────────

async function fetchWithTimeout(url: string, timeoutMs = 5000, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const id = window.setTimeout(() => controller.abort(), timeoutMs);
  // Forward external abort to our controller
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) { window.clearTimeout(id); controller.abort(); }
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    window.clearTimeout(id);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

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
      const response = await fetchWithTimeout(oEmbedUrl);
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

/** Clear any pending preview debounce timer (call on overlay close). */
export function clearPreviewDebounce(): void {
  clearManagedTimer('yt-preview-debounce');
}

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

  clearManagedTimer('yt-preview-debounce');

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

  setManagedTimer('yt-preview-debounce', async () => {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const response = await fetchWithTimeout(oembedUrl);
      if (!response.ok) throw new Error('Video not found');
      const data = await response.json();

      const thumb = document.getElementById('youtube-preview-thumb') as HTMLImageElement | null;
      const title = document.getElementById('youtube-preview-title');
      const chan = document.getElementById('youtube-preview-channel');
      if (thumb) {
        if (data.thumbnail_url) {
          thumb.src = data.thumbnail_url;
          thumb.onerror = () => { thumb.style.display = 'none'; };
          thumb.style.display = '';
        } else {
          thumb.style.display = 'none';
        }
      }
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

let _subTitleAbort: AbortController | null = null;

/**
 * Background oEmbed fetcher for YouTube playlist sub-item titles.
 * Sequentially fetches titles with 200ms delay between requests.
 * Updates state, UI, and broadcasts to peers as titles arrive.
 *
 * Lazy mode (default): only fetches titles around the current sub-index
 * (±WINDOW items). Full 100-track fetches hammered the network with
 * 100 oEmbed requests, 100 setState spreads, and 100 broadcasts —
 * causing GC pressure and mobile crashes on long Mix sessions.
 *
 * When called again (e.g. playlist switch), the previous fetch loop
 * is cancelled via AbortController to avoid unnecessary network + setState.
 */
const LAZY_WINDOW = 5; // fetch current ± 5 titles (11 total max)

export async function fetchPlaylistSubTitles(
  playlistId: string,
  ids: string[],
  options?: { fullFetch?: boolean },
): Promise<void> {
  if (!ids || ids.length === 0) return;

  const subMap = getState('youtube.subItemsMap') || {};
  const data = subMap[playlistId];
  if (!data) return;

  // Abort any previous fetch loop
  if (_subTitleAbort) {
    _subTitleAbort.abort();
    _subTitleAbort = null;
  }
  const abort = new AbortController();
  _subTitleAbort = abort;

  // Determine which indices to fetch
  const currentSubIndex = getState('youtube.currentSubIndex') ?? 0;
  let startIdx = 0;
  let endIdx = ids.length;
  if (!options?.fullFetch) {
    startIdx = Math.max(0, currentSubIndex - LAZY_WINDOW);
    endIdx = Math.min(ids.length, currentSubIndex + LAZY_WINDOW + 1);
  }

  log.debug(`[YouTube Feed] Title fetch for ${playlistId}: indices ${startIdx}-${endIdx - 1} of ${ids.length}`);

  try {
    for (let i = startIdx; i < endIdx; i++) {
      if (abort.signal.aborted) return;

      const currentMap = getState('youtube.subItemsMap') || {};
      const currentData = currentMap[playlistId];
      if (!currentData) break;

      // Skip if already has title
      if (currentData.titles[i]) continue;

      try {
        const videoId = ids[i];
        const response = await fetchWithTimeout(
          `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`,
          5000,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (!response.ok) continue;
        const json = await response.json();

        if (abort.signal.aborted) return;

        if (json && json.title) {
          updateSubItemTitle(playlistId, i, json.title);

          log.debug(`[YouTube Feed] Fetched Title [${i}]: ${json.title}`);

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
        if (abort.signal.aborted) return;
        log.warn(`[YouTube Feed] Failed to fetch title for ${ids[i]}:`, e);
      }

      await delay(DELAY.RETRY);
    }
  } finally {
    if (_subTitleAbort === abort) _subTitleAbort = null;
  }
}
