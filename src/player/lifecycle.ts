/**
 * MUSIXQUARE — Playback Lifecycle State Machine
 *
 * Guest-side track lifecycle. See `.workshop/design/playback-state-machine.md`
 * for the design doc, transition table, and migration plan.
 *
 * Contract:
 *   - All reads of `playback.lifecycle` are OK anywhere.
 *   - All WRITES to `playback.lifecycle` go through `transition()` in this
 *     module. Direct setState calls are forbidden and grep-enforced in CI.
 *   - Rejected transitions (disallowed event/state combo) are logged at
 *     error level and leave the state unchanged. We never throw — a single
 *     bug in the transition table should not kill the app.
 *
 * This module is PURE LOGIC:
 *   - It does not touch the DOM, audio engine, or network layer.
 *   - Side effects (setState, bus emits, timer management) live in the
 *     handlers that call transition() — this file only decides which state
 *     is next and applies pending-data field updates.
 *
 * Phase 4 complete (2026-04-29): the legacy flags `transfer.waitingForPreload`
 * and `transfer.skipIncomingFile` are gone. Receive-side guards derive from
 * this state machine via `shouldSkipIncomingFile()` in transfer-receive.ts.
 */

import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import {
  PLAYBACK_STATE,
  LOAD_SOURCE,
  type PlaybackStateValue,
  type LoadSourceValue,
} from '../core/constants.ts';
import { isFilePlaybackBlockedByExternalMode } from './ownership.ts';

// ─── Event Types ───────────────────────────────────────────────────
//
// Every external signal that can move playback state is modeled as a
// PlaybackEvent. Network messages are lifted into events at the handler
// boundary (e.g. handleFilePrepare builds a FilePrepareEvent and calls
// transition(event)).
//
// Some events carry "same file" / "diff file" distinctions that would be
// error-prone if computed separately in each handler. We compute them once
// at the boundary and pass the enum literal in `variant`.

export type PlaybackEvent =
  // ── File transfer (main pipeline) ──
  // Variants:
  //   fresh          — no preload match; start new download
  //   same-file      — already loaded; replay-current path
  //   preload-match  — preload blob is assembled; go straight to DECODING
  //   preload-waiting — preload session exists but blob not yet ready (transfer-receive race)
  //   demo           — demo file served via HTTP fetch (preload-style load)
  //   resume         — FILE_PREPARE of a file whose receivedCount > 0 (recovery resume)
  | {
      type: 'FILE_PREPARE';
      variant: 'fresh' | 'same-file' | 'preload-match' | 'preload-waiting' | 'demo' | 'resume';
      index: number;
      name: string;
    }
  | { type: 'FILE_START'; sessionId: number }
  | { type: 'FILE_CHUNK' } // progress tick; handler dedup/drop logic owns specifics
  | { type: 'FILE_END' }
  | { type: 'FILE_RESUME'; startChunk: number }
  // ── Preload pipeline ──
  | {
      type: 'PLAY_PRELOADED';
      variant: 'blob-ready' | 'blob-waiting' | 'no-session';
      index: number;
      name: string;
    }
  | { type: 'PRELOAD_START' }
  | { type: 'PRELOAD_CHUNK' }
  | { type: 'PRELOAD_END' }
  | { type: 'PRELOAD_FILE_READY'; index: number } // Storage-assembled blob available
  // ── Playback control ──
  | { type: 'PLAY'; time: number; index?: number; sameTrack: boolean }
  | { type: 'PAUSE'; time: number; endOfPlaylist: boolean }
  | { type: 'TRACK_ENDED' } // natural end of current audio buffer
  // ── Decode outcomes ──
  | { type: 'DECODE_SUCCESS' }
  | { type: 'DECODE_TIMEOUT' }
  | { type: 'DECODE_ERROR' }
  // ── Watchdogs / internal ──
  | { type: 'CHUNK_WATCHDOG_STALL' }
  | { type: 'PREPARE_WATCHDOG_TIMEOUT' }
  | { type: 'PRELOAD_STALL' }
  | { type: 'PRELOAD_CEILING' }
  | { type: 'LOAD_TOKEN_MISMATCH' }
  | { type: 'REMOTE_FILE_UNAVAILABLE' }
  // ── Host-side control (host is guest-of-itself for this machine) ──
  | { type: 'HOST_AUTO_ADVANCE' };

type Event = PlaybackEvent;

// ─── Transition Result ─────────────────────────────────────────────

type TransitionResult =
  | { next: PlaybackStateValue; loadSource?: LoadSourceValue | null }
  | { reject: string } // disallowed — log and stay
  | { stay: true }; // deliberate no-op (e.g. dedup, data-only update)

// ─── Resolver ──────────────────────────────────────────────────────
//
// Pure function. No side effects. Returns the next state OR an indication to
// stay/reject. The caller (transition() below) applies side effects.
//
// Keep this function mirrored 1:1 with Section 4 of the design doc. If you
// add a branch here, add the corresponding row in the doc. If you remove a
// doc row, remove the branch here.

function resolve(from: PlaybackStateValue, ev: Event): TransitionResult {
  // ── Global transitions (apply from ANY state) ──
  // PAUSE with endOfPlaylist flag wipes us back to IDLE regardless of where we were.
  if (ev.type === 'PAUSE' && ev.endOfPlaylist) {
    return { next: PLAYBACK_STATE.IDLE, loadSource: null };
  }

  // ── From IDLE ──
  if (from === PLAYBACK_STATE.IDLE) {
    switch (ev.type) {
      case 'FILE_PREPARE':
        if (ev.variant === 'preload-match')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'preload-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        if (ev.variant === 'demo')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        if (ev.variant === 'same-file') return { stay: true }; // rare; replay-current path
        if (ev.variant === 'resume')
          return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.RECOVERY_RESUME };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PLAY_PRELOADED':
        if (ev.variant === 'blob-ready')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'blob-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH }; // no-session fallback
      case 'PLAY':
        return { stay: true }; // late-join bootstrap: store pendingPlayTime
      case 'PAUSE':
        return { stay: true }; // store pausedAt
      case 'PRELOAD_START':
      case 'PRELOAD_CHUNK':
      case 'PRELOAD_END':
      case 'PRELOAD_FILE_READY':
        return { stay: true }; // preload machinery can progress alongside IDLE lifecycle
      case 'FILE_END':
      case 'DECODE_SUCCESS':
        // Stale messages buffered in dataChannel from a transfer the receiver
        // already disengaged from (e.g. host endOfPlaylist or rapid track-change
        // race). Harmless on idle state; the next FILE_PREPARE will re-engage
        // the pipeline cleanly. Suppressed so the reject log doesn't drown out
        // real signal during multi-peer debugging.
        return { stay: true };
      default:
        return { reject: `${ev.type} not expected in IDLE` };
    }
  }

  // ── From DOWNLOADING ──
  if (from === PLAYBACK_STATE.DOWNLOADING) {
    switch (ev.type) {
      case 'FILE_START':
      case 'FILE_CHUNK':
      case 'FILE_RESUME':
        return { stay: true }; // intra-state progress
      case 'FILE_END':
        return { next: PLAYBACK_STATE.DECODING }; // loadSource carried from entry
      case 'CHUNK_WATCHDOG_STALL':
      case 'PREPARE_WATCHDOG_TIMEOUT':
        return { stay: true }; // recovery request emitted by handler; state unchanged
      case 'FILE_PREPARE':
        if (ev.variant === 'same-file') return { stay: true }; // resume branch; or rare intra-session same-file ack
        if (ev.variant === 'preload-match')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'preload-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH }; // supersede
      case 'PLAY_PRELOADED':
        if (ev.variant === 'blob-ready')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'blob-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PLAY':
        return { stay: true }; // defer
      case 'PAUSE':
        return { stay: true }; // defer
      case 'PRELOAD_START':
      case 'PRELOAD_CHUNK':
      case 'PRELOAD_END':
        return { stay: true }; // next-track preload runs alongside the current download
      case 'PRELOAD_FILE_READY':
        return { next: PLAYBACK_STATE.DECODING }; // Safety promotion: if HTTP demo fetch finishes during P2P download
      case 'LOAD_TOKEN_MISMATCH':
        return { stay: true }; // handler aborts; machine unchanged
      default:
        return { reject: `${ev.type} not expected in DOWNLOADING` };
    }
  }

  // ── From AWAITING_PRELOAD (the state that kills the bug) ──
  if (from === PLAYBACK_STATE.AWAITING_PRELOAD) {
    switch (ev.type) {
      case 'PRELOAD_CHUNK':
      case 'PRELOAD_END':
      case 'PRELOAD_START':
        return { stay: true }; // progress drives the waiter
      case 'PRELOAD_FILE_READY':
        return { next: PLAYBACK_STATE.DECODING }; // promote blob
      case 'PRELOAD_STALL':
      case 'PRELOAD_CEILING':
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'FILE_PREPARE':
        if (ev.variant === 'same-file') return { stay: true }; // dedup on re-broadcast
        if (ev.variant === 'preload-match')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'preload-waiting' || ev.variant === 'demo') return { stay: true }; // already awaiting same preload/demo
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH }; // supersede
      case 'PLAY_PRELOADED':
        if (ev.variant === 'blob-ready')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'blob-waiting') return { stay: true }; // already awaiting
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PLAY':
        return { stay: true }; // store pendingPlayTime, no recovery
      case 'PAUSE':
        return { stay: true }; // store pausedAt
      case 'LOAD_TOKEN_MISMATCH':
        return { stay: true };
      case 'REMOTE_FILE_UNAVAILABLE':
        return { next: PLAYBACK_STATE.FAILED };
      default:
        return { reject: `${ev.type} not expected in AWAITING_PRELOAD` };
    }
  }

  // ── From DECODING ──
  if (from === PLAYBACK_STATE.DECODING) {
    switch (ev.type) {
      case 'DECODE_SUCCESS':
        return { next: PLAYBACK_STATE.READY };
      case 'DECODE_TIMEOUT':
      case 'DECODE_ERROR':
        return { next: PLAYBACK_STATE.FAILED };
      case 'FILE_PREPARE':
        if (ev.variant === 'same-file') return { stay: true };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH }; // supersede; decode aborts via load-token
      case 'PLAY_PRELOADED':
        if (ev.variant === 'blob-ready') return { stay: true }; // likely dedup for same track
        if (ev.variant === 'blob-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PLAY':
        return { stay: true }; // defer
      case 'PAUSE':
        return { stay: true }; // defer
      case 'PRELOAD_START':
      case 'PRELOAD_CHUNK':
      case 'PRELOAD_END':
      case 'PRELOAD_FILE_READY':
        return { stay: true }; // preload for next track coexists
      case 'LOAD_TOKEN_MISMATCH':
        return { stay: true };
      default:
        return { reject: `${ev.type} not expected in DECODING` };
    }
  }

  // ── From READY ──
  if (from === PLAYBACK_STATE.READY) {
    switch (ev.type) {
      case 'PLAY':
        return { next: PLAYBACK_STATE.PLAYING };
      case 'PAUSE':
        return { next: PLAYBACK_STATE.PAUSED };
      case 'FILE_PREPARE':
        if (ev.variant === 'same-file') return { stay: true }; // replay-current, stays READY
        if (ev.variant === 'preload-match')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'preload-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PLAY_PRELOADED':
        if (ev.variant === 'blob-ready')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'blob-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PRELOAD_START':
      case 'PRELOAD_CHUNK':
      case 'PRELOAD_END':
      case 'PRELOAD_FILE_READY':
        return { stay: true };
      default:
        return { reject: `${ev.type} not expected in READY` };
    }
  }

  // ── From PLAYING ──
  if (from === PLAYBACK_STATE.PLAYING) {
    switch (ev.type) {
      case 'PAUSE':
        return { next: PLAYBACK_STATE.PAUSED };
      case 'PLAY':
        if (ev.sameTrack) return { stay: true }; // seek / restart on same track
        return {
          reject: 'PLAY for different track must arrive via FILE_PREPARE/PLAY_PRELOADED first',
        };
      case 'TRACK_ENDED':
        return { next: PLAYBACK_STATE.IDLE, loadSource: null };
      case 'FILE_PREPARE':
        if (ev.variant === 'same-file') return { stay: true };
        if (ev.variant === 'preload-match')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'preload-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PLAY_PRELOADED':
        if (ev.variant === 'blob-ready')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'blob-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PRELOAD_START':
      case 'PRELOAD_CHUNK':
      case 'PRELOAD_END':
      case 'PRELOAD_FILE_READY':
        return { stay: true };
      default:
        return { reject: `${ev.type} not expected in PLAYING` };
    }
  }

  // ── From PAUSED ──
  if (from === PLAYBACK_STATE.PAUSED) {
    switch (ev.type) {
      case 'PLAY':
        return { next: PLAYBACK_STATE.PLAYING };
      case 'PAUSE':
        return { stay: true }; // update pausedAt
      case 'FILE_PREPARE':
        if (ev.variant === 'same-file') return { stay: true }; // replay-current handles it
        if (ev.variant === 'preload-match')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'preload-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PLAY_PRELOADED':
        if (ev.variant === 'blob-ready')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'blob-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PRELOAD_START':
      case 'PRELOAD_CHUNK':
      case 'PRELOAD_END':
      case 'PRELOAD_FILE_READY':
        return { stay: true };
      default:
        return { reject: `${ev.type} not expected in PAUSED` };
    }
  }

  // ── From FAILED ──
  if (from === PLAYBACK_STATE.FAILED) {
    switch (ev.type) {
      case 'FILE_PREPARE':
        if (ev.variant === 'preload-match')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'preload-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PLAY_PRELOADED':
        if (ev.variant === 'blob-ready')
          return { next: PLAYBACK_STATE.DECODING, loadSource: LOAD_SOURCE.PRELOAD_PROMOTED };
        if (ev.variant === 'blob-waiting')
          return {
            next: PLAYBACK_STATE.AWAITING_PRELOAD,
            loadSource: LOAD_SOURCE.PRELOAD_PROMOTED,
          };
        return { next: PLAYBACK_STATE.DOWNLOADING, loadSource: LOAD_SOURCE.FRESH };
      case 'PAUSE':
        return { next: PLAYBACK_STATE.IDLE, loadSource: null };
      case 'HOST_AUTO_ADVANCE':
        return { stay: true }; // host-side logic picks next track via FILE_PREPARE
      case 'PRELOAD_START':
      case 'PRELOAD_CHUNK':
      case 'PRELOAD_END':
      case 'PRELOAD_FILE_READY':
        return { stay: true };
      default:
        return { reject: `${ev.type} not expected in FAILED` };
    }
  }

  // Unreachable if PlaybackStateValue union is exhaustive
  return { reject: `unknown state ${from}` };
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Drive the playback lifecycle forward.
 *
 * Returns the state after the transition (or unchanged state for stay/reject).
 * Handlers can use the return value to decide their follow-up side effects
 * (e.g. cancel timers, start decode, emit bus events).
 *
 * This function is **idempotent with respect to stay-transitions**: calling
 * it with an event that resolves to `stay` has no state-tree effect.
 *
 * **Gate: external playback modes.** The lifecycle machine is guest-side
 * local-file only. When YouTube or system-audio owns playback, transition()
 * is a no-op. Those modes own their own state paths.
 */
export function transition(ev: PlaybackEvent): PlaybackStateValue {
  if (isFilePlaybackBlockedByExternalMode()) {
    // No-op in other modes. Caller is responsible for not trying to drive
    // playback lifecycle from YouTube/system-audio handlers anyway — this is
    // belt-and-suspenders.
    return getState('playback.lifecycle');
  }

  const from = getState('playback.lifecycle');
  const result = resolve(from, ev);

  if ('reject' in result) {
    log.error(`[Lifecycle] Rejected transition from ${from} on event ${ev.type}: ${result.reject}`);
    return from;
  }

  if ('stay' in result) {
    // Deliberate no-op. Data fields (pendingPlayTime, pausedAt) are managed
    // by the handler that called transition(), not by this helper.
    return from;
  }

  // Actual transition.
  setState('playback.lifecycle', result.next);
  if (result.loadSource !== undefined) {
    setState('playback.loadSource', result.loadSource);
  }
  log.debug(`[Lifecycle] ${from} -> ${result.next} (event: ${ev.type})`);
  return result.next;
}

/**
 * Peek: what state would this event move us to, without applying?
 * Useful for pre-flight checks in handlers (e.g. "will this event supersede
 * my current download? if so, cancel the storage write first").
 */
export function peekTransition(from: PlaybackStateValue, ev: PlaybackEvent): PlaybackStateValue {
  const result = resolve(from, ev);
  if ('next' in result) return result.next;
  return from;
}

/**
 * Test helper: exposed for unit tests only. NOT for production use.
 * Production code uses transition() which reads from state tree.
 */
export const __testing = { resolve };
