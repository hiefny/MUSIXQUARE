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

let _youtubePlayer: any = null;
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

export function getYouTubePlayer(): any {
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

export function setYouTubePlayer(player: any): void {
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

// ─── SubItemsMap Centralized Updaters ─────────────────────────────

type SubItemsMap = Record<string, { ids: string[]; titles: string[] }>;

function _getSubMap(): SubItemsMap {
  return getState('youtube.subItemsMap') || {};
}

/** Set playlist IDs for a YouTube playlist (preserves existing titles). */
export function updateSubItemIds(playlistId: string, ids: string[]): void {
  const subMap = { ..._getSubMap() };
  subMap[playlistId] = { ids: [...ids], titles: subMap[playlistId]?.titles || [] };
  setState('youtube.subItemsMap', subMap);
}

/** Update a single sub-item title by index. */
export function updateSubItemTitle(playlistId: string, subIdx: number, title: string): void {
  const subMap = { ..._getSubMap() };
  const oldEntry = subMap[playlistId] || { ids: [], titles: [] };
  const newTitles = [...oldEntry.titles];
  newTitles[subIdx] = title;
  setState('youtube.subItemsMap', { ...subMap, [playlistId]: { ...oldEntry, titles: newTitles } });
}

/** Set full sub-item data (IDs + titles) for a playlist. */
export function setSubItemsData(playlistId: string, ids: string[], titles: string[]): void {
  const subMap = { ..._getSubMap() };
  subMap[playlistId] = { ids: ids || [], titles: titles || [] };
  setState('youtube.subItemsMap', subMap);
}
