/**
 * MUSIXQUARE 3.0 — YouTube Shared Module State
 *
 * Leaf-node module: holds module-level state and getters/setters
 * so that iframe.ts, handlers.ts, and player.ts can all share state
 * without circular dependencies.
 */

import { SessionScope } from '../core/session-scope.ts';

// ─── Module State ──────────────────────────────────────────────────

let _youtubePlayer: any = null;
let _currentYouTubeSessionId = 0;
let _ytScriptLoading = false;
let _ytIOSWatchdog: number | null = null;
let _ytScope: SessionScope | null = null;
let _ytLoadInProgress = false;

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

export function setCachedYtDuration(duration: number): void {
  _cachedYtDuration = duration;
}

export function setCachedYtPlaylistIdx(idx: number): void {
  _cachedYtPlaylistIdx = idx;
}
