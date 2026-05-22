/**
 * MUSIXQUARE — YouTube Search & URL Extraction
 *
 * Manages: Video/Playlist ID extraction, oEmbed preview fetch,
 * oEmbed title cache.
 */

import { log } from '../core/log.ts';
import {
  fetchWithCapability,
  isCapabilityChallengeCancelled,
  type CapabilityScope,
} from '../core/capability.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState } from '../core/state.ts';
import { MSG, DELAY } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer, delay } from '../core/timers.ts';
import { broadcast } from '../network/peer.ts';
import { updateSubItemTitlesBulk } from './_state.ts';
import type { I18nKey } from '../i18n/index.ts';
import {
  OEMBED_CACHE_MAX,
  OEMBED_CACHE_TTL_MS,
  OEMBED_FETCH_TIMEOUT_MS,
  OEMBED_INITIAL_BATCH_SIZE,
  OEMBED_BACKGROUND_THROTTLE_MS,
  OEMBED_PREVIEW_DEBOUNCE_MS,
} from './constants.ts';

const YOUTUBE_SEARCH_ENDPOINT = '/api/youtube-search';
const YOUTUBE_SEARCH_TIMEOUT_MS = 8000;
const YOUTUBE_SEARCH_CACHE_MAX = 25;
const YOUTUBE_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;

export type YouTubeInputKind =
  | 'empty'
  | 'video-url'
  | 'playlist-url'
  | 'search-query'
  | 'invalid-url';

export interface YouTubeInputIntent {
  kind: YouTubeInputKind;
  raw: string;
  videoId: string | null;
  playlistId: string | null;
  query: string | null;
}

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  publishedAt?: string;
  url: string;
}

interface YouTubeSearchErrorPayload {
  error?: string;
  upstreamStatus?: number;
  reason?: string;
  message?: string;
}

// ─── Fetch with Timeout ──────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  timeoutMs = OEMBED_FETCH_TIMEOUT_MS,
  externalSignal?: AbortSignal,
  init: RequestInit = {},
  capabilityScope?: CapabilityScope,
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
    const requestInit = { ...init, signal: controller.signal };
    return capabilityScope
      ? await fetchWithCapability(url, capabilityScope, requestInit)
      : await fetch(url, requestInit);
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

export function isYouTubeLiveUrl(url: string): boolean {
  return /(?:^|\/\/|www\.)youtube\.com\/live\/[a-zA-Z0-9_-]{11}(?:[/?#&]|$)/i.test(
    String(url || ''),
  );
}

export function extractYouTubePlaylistId(url: string): string | null {
  const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^www\./i.test(value);
}

function normalizeSearchQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function getYouTubeInputIntent(value: string): YouTubeInputIntent {
  const raw = normalizeSearchQuery(value || '');
  if (!raw) {
    return { kind: 'empty', raw, videoId: null, playlistId: null, query: null };
  }

  const videoId = extractYouTubeVideoId(raw);
  const playlistId = extractYouTubePlaylistId(raw);

  if (videoId) {
    return { kind: 'video-url', raw, videoId, playlistId, query: null };
  }
  if (playlistId) {
    return { kind: 'playlist-url', raw, videoId: null, playlistId, query: null };
  }
  if (looksLikeUrl(raw)) {
    return { kind: 'invalid-url', raw, videoId: null, playlistId: null, query: null };
  }

  return { kind: 'search-query', raw, videoId: null, playlistId: null, query: raw };
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

// YouTube Search (Data API proxy)

const _searchResultCache = new Map<string, { ts: number; results: YouTubeSearchResult[] }>();
let _searchAbort: AbortController | null = null;
let _selectedSearchResult: YouTubeSearchResult | null = null;
let _selectedSearchQuery = '';
let _latestSearchQuery = '';

function cacheKeyForQuery(query: string): string {
  return normalizeSearchQuery(query).toLocaleLowerCase();
}

function searchCacheGet(query: string): YouTubeSearchResult[] | null {
  const key = cacheKeyForQuery(query);
  const cached = _searchResultCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts > YOUTUBE_SEARCH_CACHE_TTL_MS) {
    _searchResultCache.delete(key);
    return null;
  }
  _searchResultCache.delete(key);
  _searchResultCache.set(key, cached);
  return cached.results;
}

function searchCacheSet(query: string, results: YouTubeSearchResult[]): void {
  const key = cacheKeyForQuery(query);
  if (_searchResultCache.size >= YOUTUBE_SEARCH_CACHE_MAX) {
    const oldest = _searchResultCache.keys().next().value;
    if (oldest !== undefined) _searchResultCache.delete(oldest);
  }
  _searchResultCache.set(key, { ts: Date.now(), results });
}

function normalizeSearchResults(value: unknown): YouTubeSearchResult[] {
  const payload = value as { results?: unknown };
  if (!Array.isArray(payload?.results)) return [];

  return payload.results
    .map((item): YouTubeSearchResult | null => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const videoId = typeof row.videoId === 'string' ? row.videoId : '';
      if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
      return {
        videoId,
        title: typeof row.title === 'string' ? row.title : '',
        channelTitle: typeof row.channelTitle === 'string' ? row.channelTitle : '',
        // https:// whitelist: own /api/youtube-search returns i.ytimg.com URLs,
        // but defense-in-depth blocks data:/javascript: if backend ever drifts.
        // Empty string falls back to canonical mqdefault.jpg in the renderer.
        // (10차 audit Phase 4 finding.)
        thumbnailUrl:
          typeof row.thumbnailUrl === 'string' && row.thumbnailUrl.startsWith('https://')
            ? row.thumbnailUrl
            : '',
        publishedAt: typeof row.publishedAt === 'string' ? row.publishedAt : undefined,
        url:
          typeof row.url === 'string' && row.url.includes(videoId)
            ? row.url
            : `https://www.youtube.com/watch?v=${videoId}`,
      };
    })
    .filter((item): item is YouTubeSearchResult => !!item);
}

export async function fetchYouTubeSearchResults(
  query: string,
  externalSignal?: AbortSignal,
): Promise<YouTubeSearchResult[]> {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) return [];

  const cached = searchCacheGet(normalizedQuery);
  if (cached) return cached;

  const endpoint = `${YOUTUBE_SEARCH_ENDPOINT}?q=${encodeURIComponent(normalizedQuery)}`;
  const response = await fetchWithTimeout(
    endpoint,
    YOUTUBE_SEARCH_TIMEOUT_MS,
    externalSignal,
    {},
    'youtube-search',
  );
  if (!response.ok) {
    let payload: YouTubeSearchErrorPayload = {};
    try {
      payload = (await response.json()) as YouTubeSearchErrorPayload;
    } catch {
      /* ignore malformed error bodies */
    }
    const reason = payload.reason || payload.error || 'unknown';
    const detail = payload.message ? `: ${payload.message}` : '';
    throw new Error(`YouTube search HTTP ${response.status} (${reason})${detail}`);
  }

  const results = normalizeSearchResults(await response.json());
  searchCacheSet(normalizedQuery, results);
  return results;
}

function getStatusText(): HTMLElement | null {
  return document.getElementById('youtube-preview-status');
}

function getPreviewContainer(): HTMLElement | null {
  return document.getElementById('youtube-preview');
}

function getSearchResultsContainer(): HTMLElement | null {
  return document.getElementById('youtube-search-results');
}

function updateSearchScrollMask(): void {
  const resultsEl = getSearchResultsContainer();
  if (!resultsEl || resultsEl.hidden) return;

  const maxScrollTop = Math.max(0, resultsEl.scrollHeight - resultsEl.clientHeight);
  const hasOverflow = maxScrollTop > 2;
  const scrollTop = resultsEl.scrollTop;

  resultsEl.classList.toggle('can-scroll-up', hasOverflow && scrollTop > 2);
  resultsEl.classList.toggle(
    'can-scroll-down',
    hasOverflow && scrollTop < maxScrollTop - 2,
  );
}

function bindSearchScrollMask(): void {
  const resultsEl = getSearchResultsContainer();
  if (!resultsEl || resultsEl.dataset.scrollMaskBound === '1') return;
  resultsEl.dataset.scrollMaskBound = '1';
  resultsEl.addEventListener('scroll', () => updateSearchScrollMask(), { passive: true });
}

function setStatus(key: I18nKey, color = 'var(--text-sub)'): void {
  const status = getStatusText();
  if (!status) return;
  status.style.display = 'block';
  status.textContent = t(key);
  status.style.color = color;
}

function setYouTubePrimaryButton(enabled: boolean, labelKey: I18nKey = 'player.play_start'): void {
  const playBtn = document.getElementById('youtube-play-btn') as HTMLButtonElement | null;
  if (!playBtn) return;
  playBtn.disabled = !enabled;
  playBtn.style.opacity = enabled ? '1' : '0.5';
  playBtn.setAttribute('data-i18n', labelKey);
  playBtn.textContent = t(labelKey);
}

function scheduleSearchScrollbarRelayout(): void {
  window.requestAnimationFrame(() => {
    bus.emit('ui:scrollbar-relayout');
    updateSearchScrollMask();
  });
}

function hidePreviewCard(): void {
  const preview = getPreviewContainer();
  if (!preview) return;
  preview.hidden = true;
  preview.style.removeProperty('display');
}

function clearSearchResults(): void {
  _selectedSearchResult = null;
  _selectedSearchQuery = '';
  const resultsEl = getSearchResultsContainer();
  if (resultsEl) {
    resultsEl.hidden = true;
    resultsEl.replaceChildren();
    resultsEl.classList.remove('can-scroll-up', 'can-scroll-down');
    scheduleSearchScrollbarRelayout();
  }
}

function abortSearch(): void {
  if (_searchAbort) {
    _searchAbort.abort();
    _searchAbort = null;
  }
}

function selectSearchResult(result: YouTubeSearchResult, query: string): void {
  _selectedSearchResult = result;
  _selectedSearchQuery = normalizeSearchQuery(query);

  const resultsEl = getSearchResultsContainer();
  if (resultsEl) {
    for (const el of Array.from(resultsEl.querySelectorAll<HTMLElement>('.yt-search-result'))) {
      const isSelected = el.dataset.videoId === result.videoId;
      el.classList.toggle('selected', isSelected);
      el.setAttribute('aria-selected', String(isSelected));
    }
  }

  setStatus('youtube.search_selected');
  setYouTubePrimaryButton(true);
}

function renderSearchResults(query: string, results: YouTubeSearchResult[]): void {
  const resultsEl = getSearchResultsContainer();
  if (!resultsEl) return;

  resultsEl.replaceChildren();
  resultsEl.hidden = false;
  bindSearchScrollMask();
  scheduleSearchScrollbarRelayout();

  for (const result of results) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'yt-search-result';
    btn.dataset.videoId = result.videoId;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', 'false');

    const thumb = document.createElement('img');
    thumb.className = 'yt-search-thumb';
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.src = result.thumbnailUrl || `https://i.ytimg.com/vi/${result.videoId}/mqdefault.jpg`;

    const meta = document.createElement('span');
    meta.className = 'yt-search-meta';

    const title = document.createElement('span');
    title.className = 'yt-search-title';
    title.textContent = result.title || t('common.youtube_video');

    const channel = document.createElement('span');
    channel.className = 'yt-search-channel';
    channel.textContent = result.channelTitle || 'YouTube';

    meta.append(title, channel);
    btn.append(thumb, meta);
    btn.addEventListener('click', () => selectSearchResult(result, query));
    resultsEl.appendChild(btn);
  }

  if (results.length > 0) {
    selectSearchResult(results[0], query);
    resultsEl.scrollTop = 0;
    scheduleSearchScrollbarRelayout();
  } else {
    clearSearchResults();
    setStatus('youtube.search_no_results');
    setYouTubePrimaryButton(true, 'youtube.search_button');
  }
}

export function getSelectedYouTubeSearchResult(inputValue?: string): YouTubeSearchResult | null {
  if (!_selectedSearchResult) return null;
  if (inputValue !== undefined && normalizeSearchQuery(inputValue) !== _selectedSearchQuery) {
    return null;
  }
  return _selectedSearchResult;
}

export async function searchYouTubeFromInput(inputValue: string): Promise<void> {
  const intent = getYouTubeInputIntent(inputValue);
  if (intent.kind !== 'search-query' || !intent.query) return;

  abortSearch();
  hidePreviewCard();
  clearSearchResults();
  _latestSearchQuery = intent.query;
  setStatus('youtube.searching');
  setYouTubePrimaryButton(false, 'youtube.search_button');

  const abort = new AbortController();
  _searchAbort = abort;

  try {
    const results = await fetchYouTubeSearchResults(intent.query, abort.signal);
    if (abort.signal.aborted) return;
    renderSearchResults(intent.query, results);
  } catch (e) {
    if (abort.signal.aborted) return;
    // User-initiated Turnstile cancel is not a search failure — silently
    // restore the idle state instead of flashing the red error toast.
    if (isCapabilityChallengeCancelled(e)) {
      clearSearchResults();
      setStatus('youtube.enter_link_prompt');
      setYouTubePrimaryButton(false);
      return;
    }
    log.warn('[YouTube Search] Fetch failed:', e);
    clearSearchResults();
    setStatus('youtube.search_failed', 'var(--danger, #ef4444)');
    setYouTubePrimaryButton(true, 'youtube.search_button');
  } finally {
    if (_searchAbort === abort) _searchAbort = null;
  }
}

export function clearYouTubeInputState(): void {
  clearPreviewDebounce();
  abortSearch();
  clearSearchResults();
  _latestSearchQuery = '';
  hidePreviewCard();
  setStatus('youtube.enter_link_prompt');
  setYouTubePrimaryButton(false);

  const thumb = document.getElementById('youtube-preview-thumb') as HTMLImageElement | null;
  const title = document.getElementById('youtube-preview-title');
  const channel = document.getElementById('youtube-preview-channel');
  if (thumb) thumb.removeAttribute('src');
  if (title) title.textContent = '';
  if (channel) channel.textContent = '';
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

  if (!previewContainer || !statusText) return;

  clearManagedTimer('yt-preview-debounce');
  const intent = getYouTubeInputIntent(url);

  if (intent.kind === 'empty') {
    abortSearch();
    clearSearchResults();
    hidePreviewCard();
    setStatus('youtube.enter_link_placeholder');
    setYouTubePrimaryButton(false);
    return;
  }

  if (intent.kind === 'search-query') {
    hidePreviewCard();
    if (intent.query !== _latestSearchQuery) {
      abortSearch();
      clearSearchResults();
      _latestSearchQuery = '';
    }
    setStatus('youtube.search_prompt');
    setYouTubePrimaryButton(true, 'youtube.search_button');
    return;
  }

  abortSearch();
  clearSearchResults();

  const videoId = intent.videoId;
  const playlistId = intent.playlistId;

  if (intent.kind === 'invalid-url' || (!videoId && !playlistId)) {
    hidePreviewCard();
    setStatus('youtube.invalid_link', 'var(--danger, #ef4444)');
    setYouTubePrimaryButton(false);
    return;
  }

  setStatus('youtube.fetching_info');
  setYouTubePrimaryButton(false);

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
        freshPlayBtn.setAttribute('data-i18n', 'player.play_start');
        freshPlayBtn.textContent = t('player.play_start');
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

        freshPreview.style.removeProperty('display');
        freshPreview.hidden = false;
        freshStatus.style.display = 'none';
        freshSetPlayBtnEnabled(true);
      } catch (e) {
        if (abort.signal.aborted) return;
        log.error('[YouTube Preview] Error:', e);
        freshPreview.hidden = true;
        freshPreview.style.removeProperty('display');
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
