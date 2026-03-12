/**
 * MUSIXQUARE 3.0 — Playback Shared Module State
 *
 * Leaf-node module: holds module-level state and getters/setters
 * so that decode.ts, transport.ts, and playback.ts can all share state
 * without circular dependencies.
 */

import { SessionScope } from '../core/session-scope.ts';
import type { ToneBufferSource } from 'tone';

// ─── Module State ──────────────────────────────────────────────────

let _playerNode: ToneBufferSource | null = null;
let _currentAudioBuffer: AudioBuffer | null = null;
let _currentLoadToken = 0;
let _activeLoadSessionId = 0;
let _isPlayLocked = false;
let _pendingPlayTime: number | undefined;
let _pendingPlayDepth = 0;
let _playPreloadedInProgress = false;
let _lastClearedTrackName = '';
let _loadScope: SessionScope | null = null;

// ─── PlayerNode ────────────────────────────────────────────────────

export function getPlayerNode(): ToneBufferSource | null {
  return _playerNode;
}

export function setPlayerNode(v: ToneBufferSource | null): void {
  _playerNode = v;
}

// ─── AudioBuffer ───────────────────────────────────────────────────

export function getCurrentAudioBuffer(): AudioBuffer | null {
  return _currentAudioBuffer;
}

export function setCurrentAudioBuffer(buf: AudioBuffer | null): void {
  _currentAudioBuffer = buf;
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
  return _pendingPlayTime;
}

export function setPendingPlayTime(time: number | undefined): void {
  _pendingPlayTime = time;
}

export function getPendingPlayDepth(): number {
  return _pendingPlayDepth;
}

export function setPendingPlayDepth(d: number): void {
  _pendingPlayDepth = d;
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

// ─── Load Scope ────────────────────────────────────────────────────

export function getLoadScope(): SessionScope | null {
  return _loadScope;
}

export function setLoadScope(scope: SessionScope | null): void {
  _loadScope = scope;
}

export function replaceLoadScope(): SessionScope {
  _loadScope = SessionScope.replace(_loadScope);
  return _loadScope;
}
