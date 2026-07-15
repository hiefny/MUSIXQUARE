/**
 * Browser-tab title marquee.
 *
 * Browsers heavily throttle intervals in background tabs. The rendered frame
 * therefore comes from elapsed wall-clock time instead of an interval tick
 * counter: a delayed callback (or a visibility resume) lands on the frame that
 * should be visible now rather than leaving the marquee permanently behind.
 */

import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';

const DEFAULT_TAB_TITLE = 'MUSIXQUARE · 뮤직스퀘어';

const BRAND_TITLE = 'MUSIXQUARE';
const TITLE_SUFFIX = ' · MUSIXQUARE';
const TIMER_NAME = 'tab-title-marquee';
const FRAME_MS = 1000;
const START_PAUSE_MS = 3000;
const END_PAUSE_MS = 1000;

let _track = '';
let _playing = false;
let _cycleStartedAt = 0;
let _visibilityController: AbortController | null = null;

function staticTitle(track: string): string {
  return track ? `${track}${TITLE_SUFFIX}` : DEFAULT_TAB_TITLE;
}

function getTabTitleMarqueeFrame(track: string, elapsedMs: number): string {
  if (!track) return DEFAULT_TAB_TITLE;

  const full = `${track}${TITLE_SUFFIX}`;
  const chars = Array.from(full);
  const scrollSteps = Array.from(track).length + Array.from(' · ').length;
  const scrollDurationMs = scrollSteps * FRAME_MS;
  const cycleDurationMs = START_PAUSE_MS + scrollDurationMs + END_PAUSE_MS;
  const safeElapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  let phaseMs = safeElapsedMs % cycleDurationMs;

  if (phaseMs < START_PAUSE_MS) return full;
  phaseMs -= START_PAUSE_MS;

  if (phaseMs >= scrollDurationMs) return BRAND_TITLE;

  // Advance one code point per frame. Array.from avoids slicing an emoji or
  // another surrogate pair in half. Leading whitespace is omitted because
  // browsers trim it from tab titles inconsistently.
  const step = Math.floor(phaseMs / FRAME_MS) + 1;
  return chars.slice(step).join('').trimStart() || BRAND_TITLE;
}

function render(now = Date.now()): void {
  if (!_playing || !_track) {
    document.title = staticTitle(_track);
    return;
  }

  document.title = getTabTitleMarqueeFrame(_track, now - _cycleStartedAt);
}

function ensureTimer(): void {
  if (!_playing || !_track || getManagedTimer(TIMER_NAME)) return;

  setManagedTimer(TIMER_NAME, () => render(), FRAME_MS, { interval: true });
}

/** Reset ownership and install one visibility-resume hook. Safe across re-init/HMR. */
export function initTabTitleMarquee(): () => void {
  _visibilityController?.abort();
  const controller = new AbortController();
  _visibilityController = controller;
  clearManagedTimer(TIMER_NAME);
  _track = '';
  _playing = false;
  _cycleStartedAt = Date.now();
  document.title = DEFAULT_TAB_TITLE;

  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState !== 'visible' && document.visibilityState !== 'hidden') return;

      // A background interval may be about to be delayed, or may have been
      // discarded already. Re-render at both edges from wall-clock time and
      // restore the cadence if needed.
      render();
      ensureTimer();
    },
    { signal: controller.signal },
  );

  return () => {
    controller.abort();
    if (_visibilityController !== controller) return;
    _visibilityController = null;
    _playing = false;
    clearManagedTimer(TIMER_NAME);
  };
}

/** Update metadata. A new track starts at its complete title for three seconds. */
export function setTabTitleTrack(track: string): void {
  const next = track.trim();
  const changed = next !== _track;
  _track = next;

  if (changed && _playing) _cycleStartedAt = Date.now();
  if (!_track) clearManagedTimer(TIMER_NAME);

  render();
  ensureTimer();
}

/** Start or stop marquee motion while preserving a static track title when paused. */
export function setTabTitlePlaying(playing: boolean): void {
  const changed = playing !== _playing;
  _playing = playing;

  if (playing && changed) _cycleStartedAt = Date.now();
  if (!playing) clearManagedTimer(TIMER_NAME);

  render();
  ensureTimer();
}
