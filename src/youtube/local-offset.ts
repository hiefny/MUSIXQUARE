/**
 * PRO coordinator YouTube time conversion.
 *
 * A PRO coordinator is both the room's transport worker and a normal speaker.
 * Its manual nudge must move only that local iframe while every wire message
 * continues to describe the room's canonical timeline.
 */

import { MANUAL_SYNC_OFFSET_LIMIT_SEC } from '../core/constants.ts';
import { getState } from '../core/state.ts';
import { getManagedTimer } from '../core/timers.ts';
import { getRoomContext } from '../rooms/authority.ts';

export const PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER = 'yt-pro-coordinator-local-nudge';

interface ProCoordinatorYouTubeTarget {
  canonicalTime: number;
  localTime: number;
  requestedOffset: number;
  effectiveOffset: number;
}

interface ProCoordinatorYouTubeNudgeAnchor {
  canonicalTime: number;
  capturedAtMs: number;
  playing: boolean;
}

let _nudgeAnchor: ProCoordinatorYouTubeNudgeAnchor | null = null;

function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) return 0;
  if (Number.isFinite(duration) && duration > 0) {
    return Math.max(0, Math.min(time, duration));
  }
  return Math.max(0, time);
}

function clampOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(-MANUAL_SYNC_OFFSET_LIMIT_SEC, Math.min(MANUAL_SYNC_OFFSET_LIMIT_SEC, offset));
}

export function isProCoordinatorYouTubeEndpoint(): boolean {
  const room = getRoomContext();
  return room.kind === 'pro' && room.role === 'coordinator';
}

function getEffectiveProCoordinatorYouTubeOffset(): number {
  if (!isProCoordinatorYouTubeEndpoint()) return 0;
  return clampOffset(getState('sync.youtubeCoordinatorAppliedOffset') || 0);
}

function readActiveNudgeAnchor(duration: number, nowMs = Date.now()): number | null {
  if (!_nudgeAnchor) return null;
  if (!getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER)) {
    _nudgeAnchor = null;
    return null;
  }
  const elapsedSeconds = _nudgeAnchor.playing
    ? Math.max(0, nowMs - _nudgeAnchor.capturedAtMs) / 1000
    : 0;
  return clampTime(_nudgeAnchor.canonicalTime + elapsedSeconds, duration);
}

/**
 * Freeze the room timeline while an iframe-local nudge settles. YouTube may
 * keep returning the pre-seek local position for a short time; without this
 * anchor, a rapid second click or play/pause action would mistake that stale
 * local value for a change to the room's canonical position.
 */
export function beginProCoordinatorYouTubeNudge(
  localTime: number,
  duration: number,
  playing: boolean,
): number {
  const nowMs = Date.now();
  const existingAnchor = readActiveNudgeAnchor(duration, nowMs);
  const existingPlaying = _nudgeAnchor?.playing;
  const canonicalTime =
    existingAnchor ?? clampTime(localTime - getEffectiveProCoordinatorYouTubeOffset(), duration);
  _nudgeAnchor = {
    canonicalTime,
    capturedAtMs: nowMs,
    playing: existingAnchor === null ? playing : (existingPlaying ?? playing),
  };
  return canonicalTime;
}

export function clearProCoordinatorYouTubeNudgeAnchor(): void {
  _nudgeAnchor = null;
}

/** Rebase an active settling window after an explicit local play/pause state change. */
export function rebaseProCoordinatorYouTubeNudgeAnchor(
  canonicalTime: number,
  duration: number,
  playing: boolean,
): void {
  if (!isProCoordinatorYouTubeEndpoint()) return;
  if (!getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER)) return;
  _nudgeAnchor = {
    canonicalTime: clampTime(canonicalTime, duration),
    capturedAtMs: Date.now(),
    playing,
  };
}

/** Convert an iframe-local position to the room timeline. */
export function toCanonicalYouTubeTime(localTime: number, duration = 0): number {
  if (!isProCoordinatorYouTubeEndpoint()) return localTime;
  const anchoredTime = readActiveNudgeAnchor(duration);
  if (anchoredTime !== null) return anchoredTime;
  return clampTime(localTime - getEffectiveProCoordinatorYouTubeOffset(), duration);
}

/**
 * Resolve a canonical room position to the coordinator's local iframe.
 * `effectiveOffset` intentionally reflects what can actually be applied at
 * the media boundaries, not merely what was requested.
 */
export function resolveProCoordinatorYouTubeTarget(
  canonicalTime: number,
  requestedOffset: number,
  duration = 0,
): ProCoordinatorYouTubeTarget {
  const canonical = clampTime(canonicalTime, duration);
  const requested = clampOffset(requestedOffset);
  const local = clampTime(canonical + requested, duration);
  return {
    canonicalTime: canonical,
    localTime: local,
    requestedOffset: requested,
    effectiveOffset: local - canonical,
  };
}
