/**
 * MUSIXQUARE — YouTube Search & URL Extraction
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
import { updateSubItemTitlesBulk } from './_state.ts';
import {
  OEMBED_CACHE_MAX,
  OEMBED_CACHE_TTL_MS,
  OEMBED_FETCH_TIMEOUT_MS,
  OEMBED_INITIAL_BATCH_SIZE,
  OEMBED_BACKGROUND_THROTTLE_MS,
  OEMBED_PREVIEW_DEBOUNCE_MS,
} from './constants.ts';

// ─── Fetch with Timeout ──────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  timeoutMs = OEMBED_FETCH_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const id = window.setTimeout(() => controller.abort(), timeoutMs);
  // Forward external abort to our controller
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      window.clearTimeout(id);
      controller.abort();
    } else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
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
  /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
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

const _oEmbedTitleCache = new Map<string, { title: string; ts: number }>();
const _oEmbedInFlight = new Map<string, Promise<string | null>>();

function _oEmbedCacheGet(key: string): string | null {
  const entry = _oEmbedTitleCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > OEMBED_CACHE_TTL_MS) {
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
      const title = data && typeof data.title === 'string' ? data.title.trim() : '';
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

let _previewAbort: AbortController | null = null;

/** Clear any pending preview debounce timer (call on overlay close). */
export function clearPreviewDebounce(): void {
  clearManagedTimer('yt-preview-debounce');
  if (_previewAbort) {
    _previewAbort.abort();
    _previewAbort = null;
  }
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
    statusText.style.color = 'var(--danger, #ef4444)';
    setPlayBtnEnabled(false);
    return;
  }

  statusText.style.display = 'block';
  statusText.innerText = t('youtube.fetching_info');
  statusText.style.color = 'var(--text-sub)';
  setPlayBtnEnabled(false);

  setManagedTimer(
    'yt-preview-debounce',
    async () => {
      // Re-query DOM refs (overlay may have been destroyed and recreated during debounce)
      const freshPreview = document.getElementById('youtube-preview');
      const freshStatus = document.getElementById('youtube-preview-status');
      const freshPlayBtn = document.getElementById('youtube-play-btn') as HTMLButtonElement | null;
      const freshSetPlayBtnEnabled = (enabled: boolean): void => {
        if (!freshPlayBtn) return;
        freshPlayBtn.disabled = !enabled;
        freshPlayBtn.style.opacity = enabled ? '1' : '0.5';
      };
      if (!freshPreview || !freshStatus) return;

      // Cancel previous in-flight fetch to prevent stale results overwriting newer ones
      if (_previewAbort) _previewAbort.abort();
      const abort = new AbortController();
      _previewAbort = abort;

      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const response = await fetchWithTimeout(oembedUrl, OEMBED_FETCH_TIMEOUT_MS, abort.signal);
        if (abort.signal.aborted) return;
        if (!response.ok) throw new Error('Video not found');
        const data = await response.json();
        if (abort.signal.aborted) return;

        const thumb = document.getElementById('youtube-preview-thumb') as HTMLImageElement | null;
        const title = document.getElementById('youtube-preview-title');
        const chan = document.getElementById('youtube-preview-channel');
        if (thumb) {
          if (data.thumbnail_url) {
            // Always keep the thumb visible. If the actual fetch fails
            // (CSP, referrer policy, regional ytimg block, SW cache
            // mismatch on iOS WebView, etc.) the .yt-preview-thumb CSS
            // already paints a black 16:9 box via `background: #000` —
            // far better UX than collapsing the row entirely. Earlier
            // versions ran an onerror that hid the element, but that
            // turned every transient image-fetch hiccup into a stuck
            // empty card, which is what the launch-day reports caught.
            thumb.style.display = '';
            thumb.onerror = null;
            thumb.onload = null;
            thumb.src = data.thumbnail_url;
          } else {
            thumb.style.display = 'none';
          }
        }
        if (title) title.innerText = typeof data.title === 'string' ? data.title : '';
        if (chan) chan.innerText = typeof data.author_name === 'string' ? data.author_name : '';

        freshPreview.style.display = 'block';
        freshStatus.style.display = 'none';
        freshSetPlayBtnEnabled(true);
      } catch (e) {
        if (abort.signal.aborted) return;
        log.error('[YouTube Preview] Error:', e);
        freshPreview.style.display = 'none';
        freshStatus.style.display = 'block';
        freshStatus.innerText = t('youtube.fetch_failed');
        freshStatus.style.color = 'var(--danger, #ef4444)';
        freshSetPlayBtnEnabled(false);
      }
    },
    OEMBED_PREVIEW_DEBOUNCE_MS,
  );
}

// ─── Background Playlist Sub-Title Fetcher ─────────────────────────

let _subTitleAbort: AbortController | null = null;

/**
 * Cancel any in-flight background title fetch loop. Called by stopYouTubeMode
 * so a 100+ item playlist doesn't keep firing oEmbed requests + broadcasts
 * for ~80s after the user has left YouTube mode.
 */
export function cancelSubTitleFetch(): void {
  if (_subTitleAbort) {
    _subTitleAbort.abort();
    _subTitleAbort = null;
  }
}

/**
 * Background oEmbed fetcher for YouTube playlist sub-item titles.
 */
export async function fetchPlaylistSubTitles(
  playlistId: string,
  ids: string[],
  _options?: { fullFetch?: boolean },
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

  const currentSubIndex = getState('youtube.currentSubIndex') ?? 0;

  // Collect all indices that need fetching (missing titles)
  const pendingIndices = ids
    .map((_, index) => index)
    .filter((index) => !data.titles[index])
    // Priority sort: closest to current playback first
    .sort((a, b) => Math.abs(a - currentSubIndex) - Math.abs(b - currentSubIndex));

  if (pendingIndices.length === 0) return;

  log.debug(
    `[YouTube Feed] Background title fetch for ${playlistId}: ${pendingIndices.length} items pending`,
  );

  try {
    let processedCount = 0;
    let batchBuffer: { index: number; title: string }[] = [];
    const lastPendingIdx = pendingIndices[pendingIndices.length - 1];

    for (const i of pendingIndices) {
      if (abort.signal.aborted) return;

      // Double-check map entry still exists
      const currentMap = getState('youtube.subItemsMap') || {};
      const currentData = currentMap[playlistId];
      if (!currentData) break;

      // Skip if title arrived during the loop via another path (e.g. state broadcast)
      if (currentData.titles[i]) continue;

      try {
        const videoId = ids[i];
        const response = await fetchWithTimeout(
          `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`,
          OEMBED_FETCH_TIMEOUT_MS,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (!response.ok) continue;
        const json = await response.json();

        if (abort.signal.aborted) return;

        if (json && json.title) {
          batchBuffer.push({ index: i, title: json.title });
          log.debug(`[YouTube Feed] Buffered Title [${i}]: ${json.title}`);

          // Flush batch every OEMBED_INITIAL_BATCH_SIZE items (batch mode)
          // OR every item (initial phase) OR at the very end
          const isInitialPhase = processedCount < OEMBED_INITIAL_BATCH_SIZE;
          const isLast = i === lastPendingIdx;
          if (isInitialPhase || batchBuffer.length >= OEMBED_INITIAL_BATCH_SIZE || isLast) {
            updateSubItemTitlesBulk(playlistId, batchBuffer);

            const hostConn = getState('network.hostConn');
            if (!hostConn) {
              for (const update of batchBuffer) {
                broadcast({
                  type: MSG.YOUTUBE_SUB_TITLE_UPDATE,
                  playlistId,
                  subIdx: update.index,
                  title: update.title,
                });
              }
            }
            batchBuffer = [];
          }
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        log.warn(`[YouTube Feed] Failed to fetch title for ${ids[i]}:`, e);
      }

      processedCount++;
      // Adaptive throttling:
      // - First OEMBED_INITIAL_BATCH_SIZE items (High Priority window): standard RETRY (~200ms)
      // - Background items (Low Priority): OEMBED_BACKGROUND_THROTTLE_MS to ease network/GC
      const waitTime =
        processedCount <= OEMBED_INITIAL_BATCH_SIZE ? DELAY.RETRY : OEMBED_BACKGROUND_THROTTLE_MS;

      if (!abort.signal.aborted) {
        await delay(waitTime);
      }
    }
  } finally {
    if (_subTitleAbort === abort) _subTitleAbort = null;
  }
}
