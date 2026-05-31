/**
 * Tests for src/player/lifecycle.ts — the playback state machine.
 *
 * Coverage goal: every row of the transition table in
 * docs/design/playback-state-machine.md Section 4.
 *
 * Organized by source state so a failing test points directly at the design
 * doc row that's off.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PLAYBACK_STATE, LOAD_SOURCE, type PlaybackStateValue } from '../../core/constants.ts';
import { getState, setState, resetState } from '../../core/state.ts';
import {
  setPlaybackFilePlaying,
  setPlaybackSystemAudioPlaying,
  setPlaybackYouTubePlaying,
} from '../ownership.ts';
import { transition, peekTransition, __testing, type PlaybackEvent } from '../lifecycle.ts';

const { resolve } = __testing;

// ─── Helpers ───────────────────────────────────────────────────────

/** Force the lifecycle into a specific state for test setup. */
function forceState(s: PlaybackStateValue): void {
  setState('playback.lifecycle', s);
}

/** Run a transition via the pure resolver (no state tree side effects). */
function step(from: PlaybackStateValue, ev: PlaybackEvent) {
  return resolve(from, ev);
}

beforeEach(() => {
  resetState();
  // Default to PLAYING_AUDIO mode so lifecycle transitions aren't gated.
  setPlaybackFilePlaying();
});

// ─── FROM IDLE ─────────────────────────────────────────────────────

describe('lifecycle: from IDLE', () => {
  const FROM = PLAYBACK_STATE.IDLE;

  it('FILE_PREPARE fresh → DOWNLOADING with fresh loadSource', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'fresh', index: 0, name: 'a.mp3' });
    expect(r).toEqual({ next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH });
  });

  it('FILE_PREPARE resume → DOWNLOADING with recovery-resume loadSource', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'resume', index: 0, name: 'a.mp3' });
    expect(r).toEqual({
      next: PLAYBACK_STATE.DOWNLOADING,
      loadSource: LOAD_SOURCE.RECOVERY_RESUME,
    });
  });

  it('FILE_PREPARE preload-match → DECODING (promoted)', () => {
    const r = step(FROM, {
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      index: 0,
      name: 'a.mp3',
    });
    expect(r).toEqual({ next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED });
  });

  it('FILE_PREPARE demo → AWAITING_PRELOAD (HTTP fetch path)', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'demo', index: 0, name: 'demo.mp3' });
    expect(r).toEqual({
      next: PLAYBACK_STATE.AWAITING_PRELOAD,
      loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
    });
  });

  it('FILE_PREPARE preload-waiting → AWAITING_PRELOAD (preload session active, blob not ready)', () => {
    const r = step(FROM, {
      type: 'FILE_PREPARE',
      variant: 'preload-waiting',
      index: 0,
      name: 'a.mp3',
    });
    expect(r).toEqual({
      next: PLAYBACK_STATE.AWAITING_PRELOAD,
      loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
    });
  });

  it('FILE_PREPARE same-file → stay (rare in IDLE)', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'same-file', index: 0, name: 'a.mp3' });
    expect(r).toEqual({ stay: true });
  });

  it('PLAY_PRELOADED blob-ready → DECODING', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-ready',
      index: 1,
      name: 'b.mp3',
    });
    expect(r).toEqual({ next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED });
  });

  it('PLAY_PRELOADED blob-waiting → AWAITING_PRELOAD', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-waiting',
      index: 1,
      name: 'b.mp3',
    });
    expect(r).toEqual({
      next: PLAYBACK_STATE.AWAITING_PRELOAD,
      loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
    });
  });

  it('PLAY_PRELOADED no-session → DOWNLOADING (fallback to recovery)', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'no-session',
      index: 1,
      name: 'b.mp3',
    });
    expect(r).toEqual({ next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH });
  });

  it('PLAY (late-join bootstrap) → stay (store pendingPlayTime)', () => {
    const r = step(FROM, { type: 'PLAY', time: 1.5, index: 0, sameTrack: false });
    expect(r).toEqual({ stay: true });
  });

  it('PAUSE (time only) → stay', () => {
    const r = step(FROM, { type: 'PAUSE', time: 10, endOfPlaylist: false });
    expect(r).toEqual({ stay: true });
  });

  it('PAUSE endOfPlaylist → IDLE + loadSource cleared', () => {
    const r = step(FROM, { type: 'PAUSE', time: 0, endOfPlaylist: true });
    expect(r).toEqual({ next: PLAYBACK_STATE.IDLE, loadSource: null });
  });

  it('PRELOAD_* events → stay (lifecycle unaffected by background preload)', () => {
    expect(step(FROM, { type: 'PRELOAD_START' })).toEqual({ stay: true });
    expect(step(FROM, { type: 'PRELOAD_CHUNK' })).toEqual({ stay: true });
    expect(step(FROM, { type: 'PRELOAD_END' })).toEqual({ stay: true });
    expect(step(FROM, { type: 'PRELOAD_FILE_READY', index: 1 })).toEqual({ stay: true });
  });

  it('DECODE_SUCCESS in IDLE is absorbed (stale dataChannel buffered message)', () => {
    expect(step(FROM, { type: 'DECODE_SUCCESS' })).toEqual({ stay: true });
  });

  it('FILE_END in IDLE is absorbed (stale dataChannel buffered message)', () => {
    expect(step(FROM, { type: 'FILE_END' })).toEqual({ stay: true });
  });

  it('TRACK_ENDED in IDLE is absorbed (end signal after stop cleanup)', () => {
    expect(step(FROM, { type: 'TRACK_ENDED' })).toEqual({ stay: true });
  });
});

// ─── FROM DOWNLOADING ──────────────────────────────────────────────

describe('lifecycle: from DOWNLOADING', () => {
  const FROM = PLAYBACK_STATE.DOWNLOADING;

  it('FILE_START → stay (intra-state chunk pipeline progress)', () => {
    expect(step(FROM, { type: 'FILE_START', sessionId: 1 })).toEqual({ stay: true });
  });

  it('FILE_CHUNK → stay', () => {
    expect(step(FROM, { type: 'FILE_CHUNK' })).toEqual({ stay: true });
  });

  it('FILE_RESUME → stay (resume from startChunk)', () => {
    expect(step(FROM, { type: 'FILE_RESUME', startChunk: 50 })).toEqual({ stay: true });
  });

  it('FILE_END → DECODING', () => {
    expect(step(FROM, { type: 'FILE_END' })).toEqual({ next: PLAYBACK_STATE.DECODING });
  });

  it('CHUNK_WATCHDOG_STALL → stay (handler sends REQUEST_DATA_RECOVERY)', () => {
    expect(step(FROM, { type: 'CHUNK_WATCHDOG_STALL' })).toEqual({ stay: true });
  });

  it('PREPARE_WATCHDOG_TIMEOUT → stay (handler sends recovery)', () => {
    expect(step(FROM, { type: 'PREPARE_WATCHDOG_TIMEOUT' })).toEqual({ stay: true });
  });

  it('FILE_PREPARE different file → DOWNLOADING (supersede)', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'fresh', index: 2, name: 'c.mp3' });
    expect(r).toEqual({ next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH });
  });

  it('FILE_PREPARE same-file → stay (resume/dedup)', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'same-file', index: 0, name: 'a.mp3' });
    expect(r).toEqual({ stay: true });
  });

  it('FILE_PREPARE preload-match → DECODING (promote mid-download)', () => {
    const r = step(FROM, {
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      index: 0,
      name: 'a.mp3',
    });
    expect(r).toEqual({ next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED });
  });

  it('PLAY_PRELOADED blob-ready → DECODING', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-ready',
      index: 1,
      name: 'b.mp3',
    });
    expect(r).toEqual({ next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED });
  });

  it('PLAY_PRELOADED blob-waiting → AWAITING_PRELOAD', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-waiting',
      index: 1,
      name: 'b.mp3',
    });
    expect(r).toEqual({
      next: PLAYBACK_STATE.AWAITING_PRELOAD,
      loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
    });
  });

  it('PLAY → stay (defer via pendingPlayTime)', () => {
    expect(step(FROM, { type: 'PLAY', time: 5, sameTrack: false })).toEqual({ stay: true });
  });

  it('PAUSE time-only → stay (defer via pausedAt)', () => {
    expect(step(FROM, { type: 'PAUSE', time: 3, endOfPlaylist: false })).toEqual({ stay: true });
  });

  it('PAUSE endOfPlaylist → IDLE (global rule)', () => {
    const r = step(FROM, { type: 'PAUSE', time: 0, endOfPlaylist: true });
    expect(r).toEqual({ next: PLAYBACK_STATE.IDLE, loadSource: null });
  });

  it('PRELOAD_* (for next track) → stay', () => {
    expect(step(FROM, { type: 'PRELOAD_START' })).toEqual({ stay: true });
    expect(step(FROM, { type: 'PRELOAD_CHUNK' })).toEqual({ stay: true });
    expect(step(FROM, { type: 'PRELOAD_END' })).toEqual({ stay: true });
  });

  it('LOAD_TOKEN_MISMATCH → stay (handler aborts)', () => {
    expect(step(FROM, { type: 'LOAD_TOKEN_MISMATCH' })).toEqual({ stay: true });
  });

  it('DECODE_SUCCESS in DOWNLOADING is rejected', () => {
    expect(step(FROM, { type: 'DECODE_SUCCESS' })).toHaveProperty('reject');
  });
});

// ─── FROM AWAITING_PRELOAD (the bug-fix state) ─────────────────────

describe('lifecycle: from AWAITING_PRELOAD ⭐', () => {
  const FROM = PLAYBACK_STATE.AWAITING_PRELOAD;

  it('PRELOAD_FILE_READY → DECODING ⭐ THE FIX', () => {
    const r = step(FROM, { type: 'PRELOAD_FILE_READY', index: 0 });
    expect(r).toEqual({ next: PLAYBACK_STATE.DECODING });
  });

  it('PRELOAD_CHUNK → stay (progress drives the waiter)', () => {
    expect(step(FROM, { type: 'PRELOAD_CHUNK' })).toEqual({ stay: true });
  });

  it('PRELOAD_END → stay (wait for storage finalize)', () => {
    expect(step(FROM, { type: 'PRELOAD_END' })).toEqual({ stay: true });
  });

  it('PRELOAD_STALL → DOWNLOADING (recovery fallback)', () => {
    const r = step(FROM, { type: 'PRELOAD_STALL' });
    expect(r).toEqual({ next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH });
  });

  it('PRELOAD_CEILING → DOWNLOADING (recovery fallback)', () => {
    const r = step(FROM, { type: 'PRELOAD_CEILING' });
    expect(r).toEqual({ next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH });
  });

  it('FILE_PREPARE same-file (dedup on re-broadcast) → stay', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'same-file', index: 0, name: 'a.mp3' });
    expect(r).toEqual({ stay: true });
  });

  it('FILE_PREPARE preload-waiting (dedup, already awaiting same preload) → stay', () => {
    const r = step(FROM, {
      type: 'FILE_PREPARE',
      variant: 'preload-waiting',
      index: 0,
      name: 'a.mp3',
    });
    expect(r).toEqual({ stay: true });
  });

  it('FILE_PREPARE different file → DOWNLOADING (supersede)', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'fresh', index: 2, name: 'c.mp3' });
    expect(r).toEqual({ next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH });
  });

  it('FILE_PREPARE preload-match → DECODING', () => {
    const r = step(FROM, {
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      index: 0,
      name: 'a.mp3',
    });
    expect(r).toEqual({ next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED });
  });

  it('PLAY_PRELOADED blob-ready (blob now assembled) → DECODING', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-ready',
      index: 0,
      name: 'a.mp3',
    });
    expect(r).toEqual({ next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED });
  });

  it('PLAY_PRELOADED blob-waiting (dedup, already awaiting) → stay', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-waiting',
      index: 0,
      name: 'a.mp3',
    });
    expect(r).toEqual({ stay: true });
  });

  it('PLAY ⭐ THE FIX → stay (store pendingPlayTime, NO recovery)', () => {
    const r = step(FROM, { type: 'PLAY', time: 0, index: 0, sameTrack: true });
    expect(r).toEqual({ stay: true });
  });

  it('PAUSE time-only → stay (defer)', () => {
    expect(step(FROM, { type: 'PAUSE', time: 0, endOfPlaylist: false })).toEqual({ stay: true });
  });

  it('PAUSE endOfPlaylist → IDLE', () => {
    const r = step(FROM, { type: 'PAUSE', time: 0, endOfPlaylist: true });
    expect(r).toEqual({ next: PLAYBACK_STATE.IDLE, loadSource: null });
  });

  it('DECODE_SUCCESS in AWAITING_PRELOAD is rejected', () => {
    expect(step(FROM, { type: 'DECODE_SUCCESS' })).toHaveProperty('reject');
  });
});

// ─── FROM DECODING ─────────────────────────────────────────────────

describe('lifecycle: from DECODING', () => {
  const FROM = PLAYBACK_STATE.DECODING;

  it('DECODE_SUCCESS → READY', () => {
    expect(step(FROM, { type: 'DECODE_SUCCESS' })).toEqual({ next: PLAYBACK_STATE.READY });
  });

  it('DECODE_TIMEOUT → FAILED', () => {
    expect(step(FROM, { type: 'DECODE_TIMEOUT' })).toEqual({ next: PLAYBACK_STATE.FAILED });
  });

  it('DECODE_ERROR → FAILED', () => {
    expect(step(FROM, { type: 'DECODE_ERROR' })).toEqual({ next: PLAYBACK_STATE.FAILED });
  });

  it('FILE_PREPARE same-file → stay', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'same-file', index: 0, name: 'a.mp3' });
    expect(r).toEqual({ stay: true });
  });

  it('FILE_PREPARE preload-match → DECODING (host local switch while prior decode is in flight)', () => {
    const r = step(FROM, {
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      index: 2,
      name: 'c.mp3',
    });
    expect(r).toEqual({
      next: PLAYBACK_STATE.DECODING,
      loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
    });
  });

  it('rapid host local switch can accept the new decode success', () => {
    forceState(FROM);
    expect(
      transition({
        type: 'FILE_PREPARE',
        variant: 'preload-match',
        index: 2,
        name: 'c.mp3',
      }),
    ).toBe(PLAYBACK_STATE.DECODING);
    expect(transition({ type: 'DECODE_SUCCESS' })).toBe(PLAYBACK_STATE.READY);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.READY);
  });

  it('FILE_PREPARE different → DOWNLOADING (decode aborts via load-token)', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'fresh', index: 2, name: 'c.mp3' });
    expect(r).toEqual({ next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH });
  });

  it('PLAY_PRELOADED blob-ready (same track, dedup) → stay', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-ready',
      index: 0,
      name: 'a.mp3',
    });
    expect(r).toEqual({ stay: true });
  });

  it('PLAY_PRELOADED blob-waiting → AWAITING_PRELOAD', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-waiting',
      index: 0,
      name: 'a.mp3',
    });
    expect(r).toEqual({
      next: PLAYBACK_STATE.AWAITING_PRELOAD,
      loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
    });
  });

  it('PLAY → stay (defer)', () => {
    expect(step(FROM, { type: 'PLAY', time: 0, sameTrack: true })).toEqual({ stay: true });
  });

  it('PAUSE endOfPlaylist → IDLE', () => {
    const r = step(FROM, { type: 'PAUSE', time: 0, endOfPlaylist: true });
    expect(r).toEqual({ next: PLAYBACK_STATE.IDLE, loadSource: null });
  });
});

// ─── FROM READY ────────────────────────────────────────────────────

describe('lifecycle: from READY', () => {
  const FROM = PLAYBACK_STATE.READY;

  it('PLAY → PLAYING', () => {
    const r = step(FROM, { type: 'PLAY', time: 0, sameTrack: true });
    expect(r).toEqual({ next: PLAYBACK_STATE.PLAYING });
  });

  it('PAUSE → PAUSED', () => {
    const r = step(FROM, { type: 'PAUSE', time: 0, endOfPlaylist: false });
    expect(r).toEqual({ next: PLAYBACK_STATE.PAUSED });
  });

  it('FILE_PREPARE same-file → stay (replay-current)', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'same-file', index: 0, name: 'a.mp3' });
    expect(r).toEqual({ stay: true });
  });

  it('FILE_PREPARE different → DOWNLOADING (supersede)', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'fresh', index: 2, name: 'c.mp3' });
    expect(r).toEqual({ next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH });
  });

  it('PAUSE endOfPlaylist → IDLE', () => {
    const r = step(FROM, { type: 'PAUSE', time: 0, endOfPlaylist: true });
    expect(r).toEqual({ next: PLAYBACK_STATE.IDLE, loadSource: null });
  });
});

// ─── FROM PLAYING ──────────────────────────────────────────────────

describe('lifecycle: from PLAYING', () => {
  const FROM = PLAYBACK_STATE.PLAYING;

  it('PAUSE → PAUSED', () => {
    const r = step(FROM, { type: 'PAUSE', time: 5, endOfPlaylist: false });
    expect(r).toEqual({ next: PLAYBACK_STATE.PAUSED });
  });

  it('PLAY same-track (seek) → stay', () => {
    const r = step(FROM, { type: 'PLAY', time: 10, sameTrack: true });
    expect(r).toEqual({ stay: true });
  });

  it('PLAY different-track without preceding FILE_PREPARE is rejected', () => {
    const r = step(FROM, { type: 'PLAY', time: 0, sameTrack: false });
    expect(r).toHaveProperty('reject');
  });

  it('TRACK_ENDED → IDLE', () => {
    const r = step(FROM, { type: 'TRACK_ENDED' });
    expect(r).toEqual({ next: PLAYBACK_STATE.IDLE, loadSource: null });
  });

  it('FILE_PREPARE same-file (user re-clicked current) → stay', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'same-file', index: 0, name: 'a.mp3' });
    expect(r).toEqual({ stay: true });
  });

  it('FILE_PREPARE different file → DOWNLOADING (supersede)', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'fresh', index: 2, name: 'c.mp3' });
    expect(r).toEqual({ next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH });
  });

  it('PLAY_PRELOADED blob-ready → DECODING', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-ready',
      index: 1,
      name: 'b.mp3',
    });
    expect(r).toEqual({ next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED });
  });

  it('PAUSE endOfPlaylist → IDLE', () => {
    const r = step(FROM, { type: 'PAUSE', time: 0, endOfPlaylist: true });
    expect(r).toEqual({ next: PLAYBACK_STATE.IDLE, loadSource: null });
  });
});

// ─── FROM PAUSED ───────────────────────────────────────────────────

describe('lifecycle: from PAUSED', () => {
  const FROM = PLAYBACK_STATE.PAUSED;

  it('PLAY → PLAYING (resume at time)', () => {
    const r = step(FROM, { type: 'PLAY', time: 5, sameTrack: true });
    expect(r).toEqual({ next: PLAYBACK_STATE.PLAYING });
  });

  it('PAUSE → stay (update pausedAt)', () => {
    expect(step(FROM, { type: 'PAUSE', time: 10, endOfPlaylist: false })).toEqual({ stay: true });
  });

  it('FILE_PREPARE same-file → stay', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'same-file', index: 0, name: 'a.mp3' });
    expect(r).toEqual({ stay: true });
  });

  it('PLAY_PRELOADED blob-waiting → AWAITING_PRELOAD', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-waiting',
      index: 1,
      name: 'b.mp3',
    });
    expect(r).toEqual({
      next: PLAYBACK_STATE.AWAITING_PRELOAD,
      loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
    });
  });

  it('PAUSE endOfPlaylist → IDLE', () => {
    const r = step(FROM, { type: 'PAUSE', time: 0, endOfPlaylist: true });
    expect(r).toEqual({ next: PLAYBACK_STATE.IDLE, loadSource: null });
  });
});

// ─── FROM FAILED ───────────────────────────────────────────────────

describe('lifecycle: from FAILED', () => {
  const FROM = PLAYBACK_STATE.FAILED;

  it('FILE_PREPARE (host advanced to next track) → DOWNLOADING', () => {
    const r = step(FROM, { type: 'FILE_PREPARE', variant: 'fresh', index: 1, name: 'next.mp3' });
    expect(r).toEqual({ next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH });
  });

  it('PLAY_PRELOADED blob-ready → DECODING', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-ready',
      index: 1,
      name: 'b.mp3',
    });
    expect(r).toEqual({ next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED });
  });

  it('PLAY_PRELOADED blob-waiting → AWAITING_PRELOAD', () => {
    const r = step(FROM, {
      type: 'PLAY_PRELOADED',
      variant: 'blob-waiting',
      index: 1,
      name: 'b.mp3',
    });
    expect(r).toEqual({
      next: PLAYBACK_STATE.AWAITING_PRELOAD,
      loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
    });
  });

  it('PAUSE → IDLE (clean exit)', () => {
    const r = step(FROM, { type: 'PAUSE', time: 0, endOfPlaylist: false });
    expect(r).toEqual({ next: PLAYBACK_STATE.IDLE, loadSource: null });
  });

  it('HOST_AUTO_ADVANCE → stay (host picks next via FILE_PREPARE)', () => {
    expect(step(FROM, { type: 'HOST_AUTO_ADVANCE' })).toEqual({ stay: true });
  });
});

// ─── Integration: transition() drives state tree correctly ─────────

describe('transition() state tree integration', () => {
  it('moves playback.lifecycle on a valid transition', () => {
    forceState(PLAYBACK_STATE.IDLE);
    const result = transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 0, name: 'a.mp3' });
    expect(result).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playback.loadSource')).toBe(LOAD_SOURCE.FRESH);
  });

  it('stays on a no-op transition (does NOT fire state-change observers unnecessarily)', () => {
    forceState(PLAYBACK_STATE.DOWNLOADING);
    const result = transition({ type: 'FILE_CHUNK' });
    expect(result).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
  });

  it('rejects disallowed transition and leaves state unchanged (no throw)', () => {
    forceState(PLAYBACK_STATE.IDLE);
    const result = transition({ type: 'DECODE_SUCCESS' });
    expect(result).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  });

  it('is a no-op when YouTube owns playback', () => {
    setPlaybackYouTubePlaying();
    forceState(PLAYBACK_STATE.IDLE);
    const result = transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 0, name: 'a.mp3' });
    expect(result).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  });

  it('is a no-op when system audio owns playback', () => {
    setPlaybackSystemAudioPlaying();
    forceState(PLAYBACK_STATE.IDLE);
    const result = transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 0, name: 'a.mp3' });
    expect(result).toBe(PLAYBACK_STATE.IDLE);
  });

  it('is a no-op while system-audio placeholder owns playback', () => {
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
    });
    forceState(PLAYBACK_STATE.IDLE);
    const result = transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 0, name: 'a.mp3' });
    expect(result).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  });

  it('PAUSE endOfPlaylist from PLAYING → IDLE (global rule)', () => {
    forceState(PLAYBACK_STATE.PLAYING);
    const result = transition({ type: 'PAUSE', time: 0, endOfPlaylist: true });
    expect(result).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('playback.loadSource')).toBe(null);
  });
});

// ─── Regression: the exact bug sequence ────────────────────────────

describe('regression: preload-handoff bug', () => {
  it('AWAITING_PRELOAD + PLAY does NOT trigger stale-audio recovery path', () => {
    // Setup: guest is waiting on a preload blob to finalize.
    forceState(PLAYBACK_STATE.AWAITING_PRELOAD);

    // Host sends PLAY while the blob is still being written to storage.
    const result = transition({ type: 'PLAY', time: 0, index: 0, sameTrack: true });

    // Before the fix, this would have triggered stale-audio-recovery → full
    // re-download. After the fix, we stay in AWAITING_PRELOAD and the
    // handler is responsible for storing pendingPlayTime.
    expect(result).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
  });

  it('AWAITING_PRELOAD + PRELOAD_FILE_READY → DECODING (the happy path resolves)', () => {
    forceState(PLAYBACK_STATE.AWAITING_PRELOAD);
    const result = transition({ type: 'PRELOAD_FILE_READY', index: 0 });
    expect(result).toBe(PLAYBACK_STATE.DECODING);
  });

  it('end-to-end: IDLE → AWAITING_PRELOAD → DECODING → READY → PLAYING', () => {
    forceState(PLAYBACK_STATE.IDLE);
    expect(
      transition({ type: 'PLAY_PRELOADED', variant: 'blob-waiting', index: 0, name: 'a.mp3' }),
    ).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);

    // PLAY arrives while still awaiting — should NOT move state.
    expect(transition({ type: 'PLAY', time: 0, sameTrack: true })).toBe(
      PLAYBACK_STATE.AWAITING_PRELOAD,
    );

    // Blob finally finalizes.
    expect(transition({ type: 'PRELOAD_FILE_READY', index: 0 })).toBe(PLAYBACK_STATE.DECODING);
    expect(transition({ type: 'DECODE_SUCCESS' })).toBe(PLAYBACK_STATE.READY);
    expect(transition({ type: 'PLAY', time: 0, sameTrack: true })).toBe(PLAYBACK_STATE.PLAYING);
  });
});

// ─── Integration scenarios: the three cases from the design doc ────

describe('integration: design-doc acceptance scenarios', () => {
  // Scenario (a): preload completes BEFORE host advances.
  // Expected flow: IDLE → DECODING → READY → PLAYING. No AWAITING_PRELOAD.
  it('(a) preload completes before advance → DECODING straight from IDLE', () => {
    forceState(PLAYBACK_STATE.IDLE);

    // Host sends PLAY_PRELOADED; guest has blob already.
    expect(
      transition({ type: 'PLAY_PRELOADED', variant: 'blob-ready', index: 1, name: 'b.mp3' }),
    ).toBe(PLAYBACK_STATE.DECODING);
    expect(getState('playback.loadSource')).toBe(LOAD_SOURCE.PRELOAD_PROMOTED);

    // Decode completes.
    expect(transition({ type: 'DECODE_SUCCESS' })).toBe(PLAYBACK_STATE.READY);

    // Host sends PLAY.
    expect(transition({ type: 'PLAY', time: 0, sameTrack: true })).toBe(PLAYBACK_STATE.PLAYING);
  });

  // Scenario (b): advance DURING preload — the bug we're fixing.
  // Expected flow: IDLE → AWAITING_PRELOAD → [stall while chunks arrive]
  //                → DECODING → READY → PLAYING.
  // Critical invariant: PLAY arriving mid-AWAITING_PRELOAD does NOT leave
  //                     AWAITING_PRELOAD (no stale-audio recovery trip).
  it('(b) ⭐ advance during preload → stays in AWAITING_PRELOAD until blob ready', () => {
    forceState(PLAYBACK_STATE.IDLE);

    // Host sends PLAY_PRELOADED; blob is still assembling.
    expect(
      transition({ type: 'PLAY_PRELOADED', variant: 'blob-waiting', index: 1, name: 'b.mp3' }),
    ).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);

    // Some PRELOAD_CHUNKs arrive while we wait — state unchanged.
    expect(transition({ type: 'PRELOAD_CHUNK' })).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
    expect(transition({ type: 'PRELOAD_CHUNK' })).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);

    // Host's PLAY arrives while we're still awaiting. THE FIX: we stay
    // in AWAITING_PRELOAD. Before the refactor this would have armed the
    // stale-audio-recovery timer and torpedoed the preload.
    expect(transition({ type: 'PLAY', time: 0, sameTrack: true })).toBe(
      PLAYBACK_STATE.AWAITING_PRELOAD,
    );

    // PRELOAD_END then storage finalize.
    expect(transition({ type: 'PRELOAD_END' })).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
    expect(transition({ type: 'PRELOAD_FILE_READY', index: 1 })).toBe(PLAYBACK_STATE.DECODING);

    // Decode → ready → play (pending play time will be consumed by the
    // handler calling loadPreloadedTrack, which reads pendingPlayTime).
    expect(transition({ type: 'DECODE_SUCCESS' })).toBe(PLAYBACK_STATE.READY);
    expect(transition({ type: 'PLAY', time: 0, sameTrack: true })).toBe(PLAYBACK_STATE.PLAYING);
  });

  // Scenario (c): advance BEFORE preload even started.
  // Expected flow: IDLE → DOWNLOADING (via PLAY_PRELOADED no-session fallback)
  //                → DECODING → READY → PLAYING.
  it('(c) advance before preload started → DOWNLOADING fallback', () => {
    forceState(PLAYBACK_STATE.IDLE);

    // PLAY_PRELOADED arrives but no matching session exists.
    expect(
      transition({ type: 'PLAY_PRELOADED', variant: 'no-session', index: 1, name: 'b.mp3' }),
    ).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playback.loadSource')).toBe(LOAD_SOURCE.FRESH);

    // Host's recovery path kicks in: FILE_PREPARE → FILE_START → chunks.
    // We're already DOWNLOADING; FILE_PREPARE (fresh) is a same-state
    // supersede that keeps us moving.
    expect(transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 1, name: 'b.mp3' })).toBe(
      PLAYBACK_STATE.DOWNLOADING,
    );

    // Chunks, then FILE_END.
    expect(transition({ type: 'FILE_START', sessionId: 1 })).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(transition({ type: 'FILE_CHUNK' })).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(transition({ type: 'FILE_END' })).toBe(PLAYBACK_STATE.DECODING);
    expect(transition({ type: 'DECODE_SUCCESS' })).toBe(PLAYBACK_STATE.READY);
    expect(transition({ type: 'PLAY', time: 0, sameTrack: true })).toBe(PLAYBACK_STATE.PLAYING);
  });
});

// ─── Edge-case integration tests ───────────────────────────────────

describe('integration: edge cases', () => {
  // Rapid track switch: user hits Next A→B→C→D within 100ms. Each new
  // FILE_PREPARE supersedes. The final state reflects the last track.
  it('rapid supersede: A → B → C → D, only D survives', () => {
    forceState(PLAYBACK_STATE.PLAYING); // was playing A

    // User clicks Next → host broadcasts FILE_PREPARE for B.
    expect(transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 1, name: 'b.mp3' })).toBe(
      PLAYBACK_STATE.DOWNLOADING,
    );

    // Before B finishes, user clicks Next again → C.
    expect(transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 2, name: 'c.mp3' })).toBe(
      PLAYBACK_STATE.DOWNLOADING,
    );

    // And again → D.
    expect(transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 3, name: 'd.mp3' })).toBe(
      PLAYBACK_STATE.DOWNLOADING,
    );

    // D's chunks complete → D plays.
    expect(transition({ type: 'FILE_END' })).toBe(PLAYBACK_STATE.DECODING);
    expect(transition({ type: 'DECODE_SUCCESS' })).toBe(PLAYBACK_STATE.READY);
    expect(transition({ type: 'PLAY', time: 0, sameTrack: true })).toBe(PLAYBACK_STATE.PLAYING);
  });

  // Load-token mismatch happens when an async decode completes after a
  // newer load has started. The machine stays wherever the newer flow
  // put it — the stale decode's DECODE_SUCCESS never fires because the
  // handler guards with a token check before calling transition().
  it('load-token mismatch: stale event leaves state untouched', () => {
    forceState(PLAYBACK_STATE.DOWNLOADING);
    expect(transition({ type: 'LOAD_TOKEN_MISMATCH' })).toBe(PLAYBACK_STATE.DOWNLOADING);
  });

  // Preload stall: the 10s no-progress watchdog fires mid-wait. We
  // fall back to fresh download via REQUEST_DATA_RECOVERY.
  it('preload stall → fresh download fallback', () => {
    forceState(PLAYBACK_STATE.AWAITING_PRELOAD);
    expect(transition({ type: 'PRELOAD_STALL' })).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playback.loadSource')).toBe(LOAD_SOURCE.FRESH);
  });

  // Decode timeout in DECODING → FAILED; guest waits for host's next FILE_PREPARE.
  it('decode timeout recovery: FAILED → wait for host → new track', () => {
    forceState(PLAYBACK_STATE.DECODING);
    expect(transition({ type: 'DECODE_TIMEOUT' })).toBe(PLAYBACK_STATE.FAILED);

    // Host auto-advanced to the next track.
    expect(transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 2, name: 'next.mp3' })).toBe(
      PLAYBACK_STATE.DOWNLOADING,
    );
  });

  // Host sends PAUSE(endOfPlaylist=true) at any point in the pipeline.
  // Global rule: always → IDLE + loadSource null.
  it('PAUSE endOfPlaylist is a global reset regardless of current state', () => {
    const states: PlaybackStateValue[] = [
      PLAYBACK_STATE.DOWNLOADING,
      PLAYBACK_STATE.AWAITING_PRELOAD,
      PLAYBACK_STATE.DECODING,
      PLAYBACK_STATE.READY,
      PLAYBACK_STATE.PLAYING,
      PLAYBACK_STATE.PAUSED,
    ];
    for (const s of states) {
      forceState(s);
      expect(transition({ type: 'PAUSE', time: 0, endOfPlaylist: true })).toBe(PLAYBACK_STATE.IDLE);
      expect(getState('playback.loadSource')).toBe(null);
    }
  });

  // Preload for the NEXT track (not current) arriving while we're PLAYING
  // must not disturb the PLAYING state.
  it('PRELOAD_FILE_READY for next track while PLAYING → stay', () => {
    forceState(PLAYBACK_STATE.PLAYING);
    expect(transition({ type: 'PRELOAD_FILE_READY', index: 99 })).toBe(PLAYBACK_STATE.PLAYING);
  });
});

// ─── peekTransition (read-only) ────────────────────────────────────

describe('peekTransition', () => {
  it('returns the next state without applying', () => {
    forceState(PLAYBACK_STATE.IDLE);
    const peek = peekTransition(PLAYBACK_STATE.IDLE, {
      type: 'FILE_PREPARE',
      variant: 'fresh',
      index: 0,
      name: 'a.mp3',
    });
    expect(peek).toBe(PLAYBACK_STATE.DOWNLOADING);
    // State tree NOT touched.
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  });

  it('returns current state for stay transitions', () => {
    const peek = peekTransition(PLAYBACK_STATE.DOWNLOADING, { type: 'FILE_CHUNK' });
    expect(peek).toBe(PLAYBACK_STATE.DOWNLOADING);
  });

  it('returns current state for rejected transitions', () => {
    const peek = peekTransition(PLAYBACK_STATE.IDLE, { type: 'DECODE_SUCCESS' });
    expect(peek).toBe(PLAYBACK_STATE.IDLE);
  });
});
