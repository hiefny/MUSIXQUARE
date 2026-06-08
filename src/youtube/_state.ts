/**
 * MUSIXQUARE — YouTube Shared Module State
 *
 * Leaf-node module: holds module-level state and getters/setters
 * so that iframe.ts, handlers.ts, and player.ts can all share state
 * without circular dependencies.
 */
import { SessionScope } from '../core/session-scope.ts';
import { getState, setState } from '../core/state.ts';
import { MAX_PLAYLIST_SUB_ITEMS } from './constants.ts';

// ─── Module State ──────────────────────────────────────────────────

export interface YouTubePlayerInstance {
  cueVideoById?(videoId: string, startSeconds?: number): void;
  loadVideoById(videoId: string, startSeconds?: number): void;
  loadPlaylist(args: {
    list: string;
    listType: string;
    index?: number;
    startSeconds?: number;
  }): void;
  cuePlaylist(args: {
    list: string;
    listType: string;
    index?: number;
    startSeconds?: number;
  }): void;
  pauseVideo(): void;
  playVideo(): void;
  stopVideo(): void;
  destroy(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getPlaylistIndex(): number;
  getVideoData(): { video_id?: string; title?: string; author?: string };
  getPlaylist(): string[];
  setVolume(volume: number): void;
  mute?(): void;
  unMute?(): void;
}

/**
 * YouTube IFrame API global namespace (`window.YT`). Declared by the IFrame
 * script loaded in `iframe.ts`. We type only the surface we actually use —
 * the `Player` constructor and the `PlayerState` enum.
 */
export interface YTPlayerConfig {
  width?: string | number;
  height?: string | number;
  videoId?: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: () => void;
    onStateChange?: (event: { data: number }) => void;
    onError?: (event: { data: number }) => void;
  };
}

export interface YTNamespace {
  Player: new (elementId: string | HTMLElement, config: YTPlayerConfig) => YouTubePlayerInstance;
  PlayerState: {
    readonly UNSTARTED: -1;
    readonly ENDED: 0;
    readonly PLAYING: 1;
    readonly PAUSED: 2;
    readonly BUFFERING: 3;
    readonly CUED: 5;
  };
}

let _youtubePlayer: YouTubePlayerInstance | null = null;
let _currentYouTubeSessionId = 0;
let _ytScriptLoading = false;
let _ytIOSWatchdog: number | null = null;
let _ytScope: SessionScope | null = null;
let _ytLoadInProgress = false;
let _isYtIndexing = false;
let _ytIndexingCallback: ((ids: string[]) => void) | null = null;
let _localYouTubePaused = false;
let _ytPrimed = false;
let _ytPriming = false;
let _ytPrimeReady = false;
let _ytPrimeBouncePending = false;

/**
 * Autoplay intent flag — set by createYouTubePlayer.
 * When false, the PLAYING state handler will immediately pause the video.
 * This handles the case where loadPlaylist() is async and pauseVideo()
 * on an UNSTARTED player is a no-op.
 * Reset to true after the pause-back fires (so subsequent user plays work).
 */
let _ytAutoplayIntent = true;

/**
 * Duration cache — locks after first valid read.
 * Reset only on explicit video change (load, stop, playlist index change).
 * Prevents YouTube API's getDuration() float jitter from flickering the UI.
 */
let _cachedYtDuration = 0;
let _cachedYtPlaylistIdx = -1;

// ─── Getters ───────────────────────────────────────────────────────

export function getYouTubePlayer(): YouTubePlayerInstance | null {
  return _youtubePlayer;
}

export function getCurrentSessionId(): number {
  return _currentYouTubeSessionId;
}

export function isYtScriptLoading(): boolean {
  return _ytScriptLoading;
}

export function getYtIOSWatchdog(): number | null {
  return _ytIOSWatchdog;
}

export function getYtScope(): SessionScope | null {
  return _ytScope;
}

export function isYtLoadInProgress(): boolean {
  return _ytLoadInProgress;
}

export function isLocalYouTubePaused(): boolean {
  return _localYouTubePaused;
}

export function getYtAutoplayIntent(): boolean {
  return _ytAutoplayIntent;
}

export function getCachedYtDuration(): number {
  return _cachedYtDuration;
}

export function getCachedYtPlaylistIdx(): number {
  return _cachedYtPlaylistIdx;
}

export function isYtIndexing(): boolean {
  return _isYtIndexing;
}

export function getYtIndexingCallback(): ((ids: string[]) => void) | null {
  return _ytIndexingCallback;
}

export function isYtPrimed(): boolean {
  return _ytPrimed;
}

export function isYtPriming(): boolean {
  return _ytPriming;
}

export function isYtPrimeReady(): boolean {
  return _ytPrimeReady;
}

export function isYtPrimeBouncePending(): boolean {
  return _ytPrimeBouncePending;
}

// ─── Setters ───────────────────────────────────────────────────────

export function setYouTubePlayer(player: YouTubePlayerInstance | null): void {
  _youtubePlayer = player;
}

export function incrementSessionId(): number {
  _currentYouTubeSessionId++;
  return _currentYouTubeSessionId;
}

export function setYtScriptLoading(loading: boolean): void {
  _ytScriptLoading = loading;
}

export function setYtIOSWatchdog(value: number | null): void {
  _ytIOSWatchdog = value;
}

export function setYtScope(scope: SessionScope | null): void {
  _ytScope = scope;
}

export function replaceYtScope(): SessionScope {
  _ytScope = SessionScope.replace(_ytScope);
  return _ytScope;
}

export function setYtLoadInProgress(inProgress: boolean): void {
  _ytLoadInProgress = inProgress;
}

export function setLocalYouTubePaused(paused: boolean): void {
  _localYouTubePaused = paused;
}

export function setYtAutoplayIntent(autoplay: boolean): void {
  _ytAutoplayIntent = autoplay;
}

export function setCachedYtDuration(duration: number): void {
  _cachedYtDuration = duration;
}

export function setCachedYtPlaylistIdx(idx: number): void {
  _cachedYtPlaylistIdx = idx;
}

export function setYtIndexing(indexing: boolean): void {
  _isYtIndexing = indexing;
}

export function setYtIndexingCallback(cb: ((ids: string[]) => void) | null): void {
  _ytIndexingCallback = cb;
}

export function setYtPrimed(primed: boolean): void {
  _ytPrimed = primed;
}

export function setYtPriming(priming: boolean): void {
  _ytPriming = priming;
}

export function setYtPrimeReady(ready: boolean): void {
  _ytPrimeReady = ready;
}

export function setYtPrimeBouncePending(pending: boolean): void {
  _ytPrimeBouncePending = pending;
}

/**
 * Central function: update YouTube sub-index + refresh playlist UI.
 * All code paths that change the current sub-video within a YouTube playlist
 * MUST use this function instead of calling setState directly.
 */
export function setYouTubeSubIndex(index: number): void {
  const old = getState('youtube.currentSubIndex');
  if (old === index) return;
  setState('youtube.currentSubIndex', index);
}

/** Reset all module-level variables. Called on full app/session reset. */
export function resetYouTubeModuleState(): void {
  _youtubePlayer = null;
  _currentYouTubeSessionId = 0;
  _ytScriptLoading = false;
  _ytIOSWatchdog = null;
  _ytScope?.dispose();
  _ytScope = null;
  _ytLoadInProgress = false;
  _ytAutoplayIntent = true;
  _ytPrimed = false;
  _ytPriming = false;
  _ytPrimeReady = false;
  _ytPrimeBouncePending = false;
  _cachedYtDuration = 0;
  _cachedYtPlaylistIdx = -1;
  _isYtIndexing = false;
  _ytIndexingCallback = null;
}

// ─── SubItemsMap Centralized Updaters ─────────────────────────────

type SubItemsMap = Record<string, { ids: string[]; titles: string[]; loadError?: boolean }>;
const MAX_SUB_ITEMS_ENTRIES = 50;

function _getSubMap(): SubItemsMap {
  return getState('youtube.subItemsMap') || {};
}

function _touchSubMapEntry(
  subMap: SubItemsMap,
  playlistId: string,
  entry: SubItemsMap[string],
): SubItemsMap {
  const next = { ...subMap };
  delete next[playlistId];
  next[playlistId] = entry;
  return next;
}

function _getProtectedSubMapKeys(): Set<string> {
  const protectedKeys = new Set<string>();
  const currentIdx = getState('playlist.currentTrackIndex');
  const playlist = getState('playlist.items') || [];
  const currentItem = currentIdx >= 0 ? playlist[currentIdx] : undefined;
  const playlistId = currentItem?.playlistId;
  if (playlistId) protectedKeys.add(playlistId);
  return protectedKeys;
}

/** Prune map to MAX entries, evicting least-recently touched non-current keys first. */
function _pruneSubMap(subMap: SubItemsMap): SubItemsMap {
  const keys = Object.keys(subMap);
  if (keys.length <= MAX_SUB_ITEMS_ENTRIES) return subMap;
  const pruned = { ...subMap };
  const protectedKeys = _getProtectedSubMapKeys();
  for (const key of keys) {
    if (Object.keys(pruned).length <= MAX_SUB_ITEMS_ENTRIES) break;
    if (protectedKeys.has(key)) continue;
    delete pruned[key];
  }
  return pruned;
}

/** Set playlist IDs for a YouTube playlist (preserves existing titles). */
export function updateSubItemIds(playlistId: string, ids: string[]): void {
  const subMap = _getSubMap();
  const nextIds = [...ids];
  setState(
    'youtube.subItemsMap',
    _pruneSubMap(
      _touchSubMapEntry(subMap, playlistId, {
        ids: nextIds,
        titles: (subMap[playlistId]?.titles || []).slice(0, nextIds.length),
        loadError: subMap[playlistId]?.loadError,
      }),
    ),
  );
}

/** Update a single sub-item title by index (shallow copy — avoids deep triple spread). */
export function updateSubItemTitle(playlistId: string, subIdx: number, title: string): void {
  const subMap = _getSubMap();
  const entry = subMap[playlistId];
  if (!entry) return;
  // Cap the index so a hostile/buggy YOUTUBE_SUB_TITLE_UPDATE can't pad the
  // titles array to billions of empty slots (OOM). Sibling sinks (setEQ) guard
  // their own array index the same way; the validator also caps subIdx < 5000.
  if (subIdx >= MAX_PLAYLIST_SUB_ITEMS) return;
  // Only setState if title actually changed
  if (entry.titles[subIdx] === title) return;
  const newTitles = [...entry.titles];
  while (newTitles.length <= subIdx) newTitles.push('');
  newTitles[subIdx] = title;
  setState(
    'youtube.subItemsMap',
    _pruneSubMap(_touchSubMapEntry(subMap, playlistId, { ...entry, titles: newTitles })),
  );
}

/** Set full sub-item data (IDs + titles) for a playlist. */
export function setSubItemsData(playlistId: string, ids: string[], titles: string[]): void {
  const subMap = _getSubMap();
  const nextIds = ids || [];
  setState(
    'youtube.subItemsMap',
    _pruneSubMap(
      _touchSubMapEntry(subMap, playlistId, {
        ids: nextIds,
        titles: (titles || []).slice(0, nextIds.length),
        loadError: subMap[playlistId]?.loadError,
      }),
    ),
  );
}

export function setSubItemsLoadError(playlistId: string, loadError: boolean): void {
  const subMap = _getSubMap();
  const entry = subMap[playlistId] || { ids: [], titles: [] };
  const nextEntry = loadError
    ? { ...entry, loadError: true }
    : { ids: entry.ids || [], titles: entry.titles || [] };

  setState('youtube.subItemsMap', _pruneSubMap(_touchSubMapEntry(subMap, playlistId, nextEntry)));
}

/** Update multiple sub-item titles at once (minimizes setState calls). */
export function updateSubItemTitlesBulk(
  playlistId: string,
  updates: { index: number; title: string }[],
): void {
  const subMap = _getSubMap();
  const entry = subMap[playlistId];
  if (!entry || updates.length === 0) return;

  const newTitles = [...entry.titles];
  let changed = false;

  for (const update of updates) {
    // Same OOM cap as updateSubItemTitle — skip out-of-range indices.
    if (update.index < 0 || update.index >= MAX_PLAYLIST_SUB_ITEMS) continue;
    while (newTitles.length <= update.index) newTitles.push('');
    if (newTitles[update.index] !== update.title) {
      newTitles[update.index] = update.title;
      changed = true;
    }
  }

  if (changed) {
    setState(
      'youtube.subItemsMap',
      _pruneSubMap(_touchSubMapEntry(subMap, playlistId, { ...entry, titles: newTitles })),
    );
  }
}
