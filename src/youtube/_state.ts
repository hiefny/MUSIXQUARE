/**
 * MUSIXQUARE 3.0 — YouTube Shared Module State
 *
 * Leaf-node module: holds module-level state and getters/setters
 * so that iframe.ts, handlers.ts, and player.ts can all share state
 * without circular dependencies.
 */

import { SessionScope } from '../core/session-scope.ts';
import { getState, setState } from '../core/state.ts';

// ─── Module State ──────────────────────────────────────────────────

export interface YouTubePlayerInstance {
  loadVideoById(videoId: string): void;
  loadPlaylist(args: { list: string; listType: string; index?: number; startSeconds?: number }): void;
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
}

let _youtubePlayer: YouTubePlayerInstance | null = null;
let _currentYouTubeSessionId = 0;
let _ytScriptLoading = false;
let _ytIOSWatchdog: number | null = null;
let _ytScope: SessionScope | null = null;
let _ytLoadInProgress = false;

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

export function getYtAutoplayIntent(): boolean {
  return _ytAutoplayIntent;
}

export function getCachedYtDuration(): number {
  return _cachedYtDuration;
}

export function getCachedYtPlaylistIdx(): number {
  return _cachedYtPlaylistIdx;
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

export function setYtAutoplayIntent(autoplay: boolean): void {
  _ytAutoplayIntent = autoplay;
}

export function setCachedYtDuration(duration: number): void {
  _cachedYtDuration = duration;
}

export function setCachedYtPlaylistIdx(idx: number): void {
  _cachedYtPlaylistIdx = idx;
}

/**
 * Central function: update YouTube sub-index + refresh playlist UI.
 * All code paths that change the current sub-video within a YouTube playlist
 * MUST use this function instead of calling setState directly.
 */
export function setYouTubeSubIndex(index: number): void {
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
  _cachedYtDuration = 0;
  _cachedYtPlaylistIdx = -1;
}

// ─── SubItemsMap Centralized Updaters ─────────────────────────────

type SubItemsMap = Record<string, { ids: string[]; titles: string[] }>;
const MAX_SUB_ITEMS_ENTRIES = 10; // FIFO limit — evict oldest inserted when full

function _getSubMap(): SubItemsMap {
  return getState('youtube.subItemsMap') || {};
}

/** Prune map to MAX entries, evicting the oldest inserted keys first (FIFO). */
function _pruneSubMap(subMap: SubItemsMap): SubItemsMap {
  const keys = Object.keys(subMap);
  if (keys.length <= MAX_SUB_ITEMS_ENTRIES) return subMap;
  // Remove oldest entries (first keys in object)
  const pruned = { ...subMap };
  const excess = keys.length - MAX_SUB_ITEMS_ENTRIES;
  for (let i = 0; i < excess; i++) {
    delete pruned[keys[i]];
  }
  return pruned;
}

/** Set playlist IDs for a YouTube playlist (preserves existing titles). */
export function updateSubItemIds(playlistId: string, ids: string[]): void {
  const subMap = { ..._getSubMap() };
  subMap[playlistId] = { ids: [...ids], titles: subMap[playlistId]?.titles || [] };
  setState('youtube.subItemsMap', _pruneSubMap(subMap));
}

/** Update a single sub-item title by index (shallow copy — avoids deep triple spread). */
export function updateSubItemTitle(playlistId: string, subIdx: number, title: string): void {
  const subMap = _getSubMap();
  const entry = subMap[playlistId];
  if (!entry) return;
  // Only setState if title actually changed
  if (entry.titles[subIdx] === title) return;
  const newTitles = [...entry.titles];
  while (newTitles.length <= subIdx) newTitles.push('');
  newTitles[subIdx] = title;
  setState('youtube.subItemsMap', _pruneSubMap({ ...subMap, [playlistId]: { ...entry, titles: newTitles } }));
}

/** Set full sub-item data (IDs + titles) for a playlist. */
export function setSubItemsData(playlistId: string, ids: string[], titles: string[]): void {
  const subMap = { ..._getSubMap() };
  subMap[playlistId] = { ids: ids || [], titles: titles || [] };
  setState('youtube.subItemsMap', _pruneSubMap(subMap));
}
