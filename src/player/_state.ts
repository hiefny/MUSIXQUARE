/**
 * MUSIXQUARE — Playback Shared Module State
 *
 * Leaf-node module: holds module-level state and getters/setters
 * so that decode.ts, transport.ts, and playback.ts can all share state
 * without circular dependencies.
 */

import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import type { PlaylistItem } from '../types/index.ts';
// ─── Module State ──────────────────────────────────────────────────
//
// pendingPlayTime, pendingPlayTimeSetAt, and failedTrackKeys live in the
// state tree (Phase 4-B). The accessor functions below now wrap state
// reads/writes — kept as functions so all existing callers stay
// untouched and the immutable-update rule for Sets is enforced in one
// place (markTrackFailed).

let _playerNode: AudioBufferSourceNode | null = null;
let _currentAudioBuffer: AudioBuffer | null = null;
let _currentLoadToken = 0;
let _activeLoadSessionId = 0;
let _isPlayLocked = false;
let _playPreloadedInProgress = false;
let _lastClearedTrackName = '';

// ─── PlayerNode ────────────────────────────────────────────────────

export function getPlayerNode(): AudioBufferSourceNode | null {
  return _playerNode;
}

export function setPlayerNode(v: AudioBufferSourceNode | null): void {
  _playerNode = v;
}

// ─── AudioBuffer ───────────────────────────────────────────────────

export function getCurrentAudioBuffer(): AudioBuffer | null {
  return _currentAudioBuffer;
}

export function setCurrentAudioBuffer(buf: AudioBuffer | null): void {
  const prev = _currentAudioBuffer;
  _currentAudioBuffer = buf;
  if (buf && buf !== prev) {
    bus.emit('player:buffer-changed');
  }
}

// ─── Load Token ────────────────────────────────────────────────────

export function getLoadToken(): number {
  return _currentLoadToken;
}

export function incrementLoadToken(): number {
  return ++_currentLoadToken;
}

// ─── Load Session ID ───────────────────────────────────────────────

export function getActiveLoadSessionId(): number {
  return _activeLoadSessionId;
}

export function incrementLoadSessionId(): number {
  return ++_activeLoadSessionId;
}

// ─── Play Lock ─────────────────────────────────────────────────────

export function isPlayLocked(): boolean {
  return _isPlayLocked;
}

export function setPlayLocked(v: boolean): void {
  _isPlayLocked = v;
}

// ─── Pending Play ──────────────────────────────────────────────────

export function getPendingPlayTime(): number | undefined {
  return getState('playback.pendingPlayTime');
}

export function setPendingPlayTime(time: number | undefined, setAt?: number): void {
  setState('playback.pendingPlayTime', time);
  setState('playback.pendingPlayTimeSetAt', time === undefined ? 0 : (setAt ?? Date.now()));
}

export function getPendingPlayTimeSetAt(): number {
  return getState('playback.pendingPlayTimeSetAt');
}

/**
 * Seconds elapsed since pendingPlayTime was set. Consumers add this to
 * the stored time to estimate the host's current playback position —
 * important when decode/fetch takes several seconds (e.g. remote guest's
 * HTTP fetch for the demo), during which the host keeps playing forward.
 */
export function getPendingPlayTimeAge(): number {
  const time = getState('playback.pendingPlayTime');
  const setAt = getState('playback.pendingPlayTimeSetAt');
  if (time === undefined || setAt === 0) return 0;
  return (Date.now() - setAt) / 1000;
}

// ─── Preloaded In Progress ─────────────────────────────────────────

export function isPlayPreloadedInProgress(): boolean {
  return _playPreloadedInProgress;
}

export function setPlayPreloadedInProgress(v: boolean): void {
  _playPreloadedInProgress = v;
}

// ─── Last Cleared Track ────────────────────────────────────────────

export function getLastClearedTrackName(): string {
  return _lastClearedTrackName;
}

export function setLastClearedTrackName(name: string): void {
  _lastClearedTrackName = name;
}

// ─── Failed Track Tracking ────────────────────────────────────────
// Remembers which tracks failed to decode (timeout, corrupt, unsupported) so
// we can skip them on auto-advance without looping forever.
//
// Keys are content-based, not index-based, so removing/reordering/adding
// tracks mid-session doesn't invalidate the memory:
//   • Local file  → "file:{name}:{size}:{lastModified}"
//                   (three fields together give effectively unique identity
//                    — same name with different size or mtime is a different
//                    file, so user re-uploading a modified version retries)
//   • YouTube     → "yt:{videoId}"
//   • Name-only   → "name:{name}" (fallback when file handle isn't attached,
//                   e.g. guest viewing a remote playlist entry)
//
// The Set is cleared in two cases:
//   1. When getFailedTrackCount() reaches playlist.length — every track
//      failed, so we stop and reset for the next attempt.
//   2. Never elsewhere — keys naturally become irrelevant if the underlying
//      track is removed from the playlist (the key still lives in the Set
//      but nothing will check for it).

export function getTrackKeyFromFile(file: File | Blob | null | undefined): string | null {
  if (!file) return null;
  const f = file as File;
  if (typeof f.name === 'string' && typeof f.lastModified === 'number') {
    return `file:${f.name}:${f.size}:${f.lastModified}`;
  }
  // Blob without name/lastModified — size-only fallback (very low uniqueness,
  // but better than nothing for the rare guest-side raw-Blob path)
  return `blob:${file.size}`;
}

export function getTrackKeyFromItem(item: PlaylistItem | null | undefined): string | null {
  if (!item) return null;
  if (item.type === 'youtube') {
    return item.videoId ? `yt:${item.videoId}` : null;
  }
  if (item.type === 'file' && item.file) {
    return getTrackKeyFromFile(item.file);
  }
  // File handle not attached (e.g. remote playlist view on guest) — fall back
  // to name. Less unique but still allows same-session skip behaviour.
  return item.name ? `name:${item.name}` : null;
}

export function markTrackFailed(key: string | null | undefined): void {
  if (!key) return;
  // Immutable update — direct Set.add() on the returned reference would
  // not propagate to subscribers and would create stale snapshots.
  const current = getState('playback.failedTrackKeys');
  if (current.has(key)) return;
  setState('playback.failedTrackKeys', new Set([...current, key]));
}

export function isTrackFailed(key: string | null | undefined): boolean {
  if (!key) return false;
  return getState('playback.failedTrackKeys').has(key);
}

export function getFailedTrackCount(): number {
  return getState('playback.failedTrackKeys').size;
}

export function clearFailedTracks(): void {
  // Skip the setState if already empty so we don't churn subscribers.
  if (getState('playback.failedTrackKeys').size === 0) return;
  setState('playback.failedTrackKeys', new Set<string>());
}
