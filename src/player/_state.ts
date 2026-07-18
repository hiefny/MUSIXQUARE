/**
 * MUSIXQUARE — Playback Shared Module State
 *
 * Leaf-node module: holds module-level state and getters/setters
 * so that decode.ts, transport.ts, and playback.ts can all share state
 * without circular dependencies.
 */

import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import type { PlaylistItem, QueueItemId, QueueTarget } from '../types/index.ts';
// ─── Module State ──────────────────────────────────────────────────
//
// pendingPlayTime, pendingPlayTimeSetAt, and failedTrackKeys live in the
// state tree. The accessor functions below wrap state reads/writes so callers
// stay stable and the immutable-update rule for Sets is enforced in one place
// (markTrackFailed).
//
// ─── Concurrency-mechanism inventory ──────────────────────────────
//
// Load supersession, node-start exclusion, preload activation, and deferred
// play use distinct ownership scopes. Their allocation/check/clear matrix and
// pendingPlayTime policy live in
// docs/design/playback-concurrency-invariants.md. The contract is covered by
// __tests__/concurrency-invariants.test.ts and
// scripts/check-lifecycle-writes.mjs.
//
//   M1 _loadEpoch               — user/track-change intent. Allocated only at
//                                 pipeline entry points (playlist.ts playTrack +
//                                 repeat-one, playback.ts handlers,
//                                 transport.ts cancelInFlight + watchdog,
//                                 demo/mode.ts); load functions only validate.
//   M2 _activeLoadSessionId     — load invocation counter. Guest finalization
//                                 checks this and an entry snapshot of
//                                 transfer.localSessionId, but not M1, so a
//                                 watchdog epoch bump cannot abort an in-flight
//                                 guest finalize. It is distinct from transfer,
//                                 preload, and storage session identifiers.
//   M3 _isPlayLocked            — node-start mutual exclusion + 15s watchdog;
//                                 transport-local invocation generation owns
//                                 every watchdog/finally/unlock mutation
//                                 (transport.ts). Watchdog expiry unlocks,
//                                 clears deferred play, stops the node, advances
//                                 M1, and returns playback to semantic IDLE.
//   M4 _playPreloadedInProgress — preload-activation window flag, ownership
//                                 managed by the compare-before-clear owner
//                                 handle in decode.ts (beginPreloadActivation/
//                                 finishPreloadActivation). stopAllMedia may
//                                 also clear the flag during teardown.
//   M6 pendingPlayTime          — deferred-play mailbox, not a guard. Preserve
//                                 or clear it according to the abort-cause
//                                 policy documented in the design file.

let _playerNode: AudioBufferSourceNode | null = null;
let _currentAudioBuffer: AudioBuffer | null = null;
let _loadEpoch = 0;
let _activeLoadSessionId = 0;
let _isPlayLocked = false;
let _playPreloadedInProgress = false;
let _lastClearedQueueItemId: QueueItemId | null = null;

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

// WeakRef tracking of every AudioBuffer ever surfaced through this setter.
// Lets `/debug memory` distinguish "iOS hasn't GC'd yet" (live count > 1)
// from "we're holding a hard reference somewhere" (count grows unbounded).
// Each entry is a WeakRef so adding to the list never *prevents* GC.
//
// `_decodedBufferTotal` is the cumulative count for the session — diff
// against `liveAudioBufferCount()` to see how many decoded buffers iOS
// has released.
const _audioBufferRefs: Array<WeakRef<AudioBuffer>> = [];
const _trackedAudioBuffers = new WeakSet<AudioBuffer>();
let _decodedBufferTotal = 0;

/** Track native PCM immediately after decode, even before publication. */
export function trackDecodedAudioBufferForAdmission(buffer: AudioBuffer): void {
  if (_trackedAudioBuffers.has(buffer)) return;
  _trackedAudioBuffers.add(buffer);
  if (typeof WeakRef !== 'undefined') {
    _audioBufferRefs.push(new WeakRef(buffer));
  }
  _decodedBufferTotal++;
}

function estimateAudioBufferBytes(buffer: AudioBuffer): number {
  const sampleRate =
    Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0 ? buffer.sampleRate : 48_000;
  const channels =
    Number.isFinite(buffer.numberOfChannels) && buffer.numberOfChannels > 0
      ? buffer.numberOfChannels
      : 2;
  const frames =
    Number.isFinite(buffer.length) && buffer.length > 0
      ? buffer.length
      : Number.isFinite(buffer.duration) && buffer.duration > 0
        ? buffer.duration * sampleRate
        : 0;
  return Math.ceil(frames * channels * Float32Array.BYTES_PER_ELEMENT);
}

export function liveAudioBufferCount(): { live: number; everSeen: number } {
  // Compact dead refs in-place so the list doesn't grow unbounded across a
  // long session. Iterate from the end so splice doesn't shift our index.
  let live = 0;
  for (let i = _audioBufferRefs.length - 1; i >= 0; i--) {
    if (_audioBufferRefs[i].deref()) {
      live++;
    } else {
      _audioBufferRefs.splice(i, 1);
    }
  }
  return { live, everSeen: _decodedBufferTotal };
}

/**
 * Best-effort PCM footprint still reachable from this browsing context.
 *
 * iOS can retain retired native AudioBuffers beyond the track switch that
 * dropped the app's strong reference. Admission checks include those WeakRef
 * survivors so a long session stops before stacking another large decode on
 * top of buffers WebKit has not reclaimed yet.
 */
export function liveAudioBufferPcmBytes(exceptBuffer?: AudioBuffer): number {
  const seen = new Set<AudioBuffer>();
  let bytes = 0;

  for (let i = _audioBufferRefs.length - 1; i >= 0; i--) {
    const buffer = _audioBufferRefs[i].deref();
    if (!buffer) {
      _audioBufferRefs.splice(i, 1);
      continue;
    }
    if (buffer === exceptBuffer) continue;
    if (seen.has(buffer)) continue;
    seen.add(buffer);
    bytes += estimateAudioBufferBytes(buffer);
  }

  // WeakRef is not universal, and a just-created current buffer may not have
  // been observable through the list in a test/browser implementation.
  if (
    _currentAudioBuffer &&
    _currentAudioBuffer !== exceptBuffer &&
    !seen.has(_currentAudioBuffer)
  ) {
    bytes += estimateAudioBufferBytes(_currentAudioBuffer);
  }

  return bytes;
}

/** PCM bytes held by the current strong AudioBuffer reference only. */
export function currentAudioBufferPcmBytes(): number {
  return _currentAudioBuffer ? estimateAudioBufferBytes(_currentAudioBuffer) : 0;
}

export function setCurrentAudioBuffer(buf: AudioBuffer | null): void {
  const prev = _currentAudioBuffer;
  _currentAudioBuffer = buf;
  if (buf !== prev) {
    bus.emit('player:buffer-changed');
  }
  if (buf && buf !== prev) {
    trackDecodedAudioBufferForAdmission(buf);
  }
}

// ─── Load Epoch (M1 — single supersession authority) ───────────────
//
// This monotonic counter answers whether a newer logical file-load run has
// started. Preload-activation handles record the epoch that owns them.
//
// Allocation is restricted by scripts/check-lifecycle-writes.mjs:
// newLoadEpoch() may be called only at the outermost entry of a pipeline run:
//   playlist.ts   playTrack + repeat-one ended-advance
//   playback.ts   handlePlayMsg preload-match + storage:use-preloaded handler
//   transport.ts  stopAllMedia({cancelInFlight}) + 15s navigator-lock-watchdog
//   demo/mode.ts  loadDemoTrack entry
// Load functions in decode.ts only validate the epoch; allocating inside a
// load function would make it supersede itself after an asynchronous step.
//
// activeLoadSessionId remains separate because watchdog and cancellation epoch
// bumps must not abort an in-flight guest finalize.

export function getCurrentLoadEpoch(): number {
  return _loadEpoch;
}

export function newLoadEpoch(): number {
  return ++_loadEpoch;
}

export function isCurrentLoadEpoch(epoch: number): boolean {
  return epoch === _loadEpoch;
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

// ─── Local File Pause (guest lock-screen / hardware-button pause) ───
// A non-OP guest can locally pause/resume file playback from the lock screen
// or hardware media buttons (see media-session.ts). Without this flag the
// host's periodic SYNC_PONG auto-resumes them within ~1s via the
// bootstrap/drift branch in network/sync.ts. Mirrors youtube/_state.ts's
// `_localYouTubePaused`. Set on local guest pause; cleared on local resume, on
// any authoritative host PLAY/PAUSE (playback.ts), and on sync reset.

let _localFilePaused = false;

export function isLocalFilePaused(): boolean {
  return _localFilePaused;
}

export function setLocalFilePaused(v: boolean): void {
  _localFilePaused = v;
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

// ─── Pending Recovery Target ──────────────────────────────────────
//
// Centralized writer for `playback.pendingRecoveryTarget`. Position is only a
// diagnostic hint; queueItemId is the owner that survives reorder.

export function setPendingRecoveryTarget(target: QueueTarget | null | undefined): void {
  if (
    target &&
    typeof target.queueItemId === 'string' &&
    target.queueItemId.length > 0 &&
    Number.isSafeInteger(target.indexHint) &&
    target.indexHint >= 0 &&
    typeof target.name === 'string' &&
    target.name.length > 0
  ) {
    setState('playback.pendingRecoveryTarget', { ...target });
    return;
  }
  setState('playback.pendingRecoveryTarget', null);
}

// ─── Preloaded In Progress ─────────────────────────────────────────

export function isPlayPreloadedInProgress(): boolean {
  return _playPreloadedInProgress;
}

export function setPlayPreloadedInProgress(v: boolean): void {
  _playPreloadedInProgress = v;
}

// ─── Last Cleared Track ────────────────────────────────────────────

export function getLastClearedQueueItemId(): QueueItemId | null {
  return _lastClearedQueueItemId;
}

export function setLastClearedQueueItemId(queueItemId: QueueItemId | null): void {
  _lastClearedQueueItemId = queueItemId;
}

// ─── Failed Track Tracking ────────────────────────────────────────
// Remembers which tracks failed to decode (timeout, corrupt, unsupported) so
// we can skip them on auto-advance without looping forever.
//
// Queue entries use queueItemId so two occurrences of the same File or YouTube
// video fail independently. Raw media outside the queue (for example demo
// blobs) still uses browser object identity. File metadata is never identity.
//
// The Set is cleared in two cases:
//   1. When every playlist track has failed (decode.ts counts the non-failed
//      remainder) — we stop and reset for the next attempt.
//   2. Never elsewhere — keys naturally become irrelevant if the underlying
//      track is removed from the playlist (the key still lives in the Set
//      but nothing will check for it).

const _mediaTrackKeys = new WeakMap<Blob, string>();
let _nextTrackIdentity = 1;

function identityKey<T extends object>(map: WeakMap<T, string>, value: T, prefix: string): string {
  let key = map.get(value);
  if (!key) {
    key = `${prefix}:${_nextTrackIdentity++}`;
    map.set(value, key);
  }
  return key;
}

export function getTrackKeyFromFileForTests(file: File | Blob | null | undefined): string | null {
  return file ? identityKey(_mediaTrackKeys, file, 'media') : null;
}

export function getTrackKeyFromItem(item: PlaylistItem | null | undefined): string | null {
  if (!item) return null;
  return item.queueItemId ? `queue:${item.queueItemId}` : null;
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

export function clearFailedTracks(): void {
  // Skip the setState if already empty so we don't churn subscribers.
  if (getState('playback.failedTrackKeys').size === 0) return;
  setState('playback.failedTrackKeys', new Set<string>());
}
