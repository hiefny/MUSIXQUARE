/**
 * MUSIXQUARE 3.0 — Seekbar Module
 *
 * Manages: Seek slider, rAF interpolation loop, time display,
 * duration updates, YouTube time sync, ended-check polling.
 *
 * Extracted from player-controls.ts for single-responsibility.
 */

import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { fmtTime, getTrackPosition, seekTo } from '../player/transport.ts';
import { isIdleOrPaused } from '../player/video.ts';

// ─── Seek Bar Input Events ──────────────────────────────────────

function initSeekBarInput(): void {
  const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
  if (!slider) return;

  slider.addEventListener('mousedown', () => setState('player.isSeeking', true));
  slider.addEventListener('touchstart', () => setState('player.isSeeking', true), { passive: true });
  slider.addEventListener('input', () => {
    const currentState = getState('appState');
    if (currentState === APP_STATE.IDLE || currentState === APP_STATE.PLAYING_SYSTEM_AUDIO) { slider.value = '0'; return; }
    const formatted = fmtTime(parseFloat(slider.value));
    const tc = document.getElementById('time-curr');
    if (tc) tc.innerText = formatted;
    slider.setAttribute('aria-valuetext', formatted);
  });

  function releaseSeek() {
    if (slider) {
      _rafAnchorTime = parseFloat(slider.value) || 0;
      _rafAnchorTs = performance.now();
    }
    setState('player.isSeeking', false);
  }

  slider.addEventListener('change', () => {
    releaseSeek();
    const currentState = getState('appState');
    if (currentState === APP_STATE.IDLE || currentState === APP_STATE.PLAYING_SYSTEM_AUDIO) { slider.value = '0'; return; }
    const seekTime = parseFloat(slider.value);

    seekTo(seekTime);
  });

  slider.addEventListener('mouseup', releaseSeek);
  slider.addEventListener('touchend', releaseSeek, { passive: true });
  slider.addEventListener('touchcancel', releaseSeek, { passive: true });
  slider.addEventListener('contextmenu', releaseSeek);
}

// ─── rAF Interpolation Loop ─────────────────────────────────────

let _rafId = 0;
let _rafAnchorTime = 0;
let _rafAnchorTs = 0;
let _rafLastFmtSec = -1;

function _seekRafLoop(now: number): void {
  // System audio: no seek position — keep at 0
  if (getState('appState') === APP_STATE.PLAYING_SYSTEM_AUDIO) {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    if (slider) slider.value = '0';
    if (tc) tc.innerText = '0:00';
    _rafId = requestAnimationFrame(_seekRafLoop);
    return;
  }

  const isSeeking = getState('player.isSeeking');
  if (!isSeeking) {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    if (slider) {
      const dt = (now - _rafAnchorTs) / 1000;
      const interpolated = Math.min(_rafAnchorTime + dt, parseFloat(slider.max) || 0);
      slider.value = String(interpolated);

      const sec = Math.floor(interpolated);
      if (sec !== _rafLastFmtSec) {
        _rafLastFmtSec = sec;
        const fmt = fmtTime(interpolated);
        slider.setAttribute('aria-valuetext', fmt);
        if (tc) tc.innerText = fmt;
      }
    }
  }
  _rafId = requestAnimationFrame(_seekRafLoop);
}

function _startSeekRaf(): void {
  if (_rafId) return;
  _rafAnchorTime = getTrackPosition();
  _rafAnchorTs = performance.now();
  _rafLastFmtSec = -1;
  _rafId = requestAnimationFrame(_seekRafLoop);
}

function _stopSeekRaf(): void {
  if (_rafId) {
    cancelAnimationFrame(_rafId);
    _rafId = 0;
  }
}

// ─── Bus Event Handlers ─────────────────────────────────────────

function initSeekBarBusHandlers(): void {
  // Duration update
  bus.on('ui:duration-update', (duration) => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tTotal = document.getElementById('time-dur');
    if (slider) { slider.max = String(duration); }
    if (tTotal) tTotal.innerText = fmtTime(duration);
  });

  // Seek reset
  bus.on('ui:seek-reset', () => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    if (slider) { slider.value = '0'; }
    if (tc) tc.innerText = '0:00';
    clearManagedTimer('time-update-loop');
    _stopSeekRaf();
  });

  // UI loop start (playback begins)
  let _endedCheckCounter = 0;
  bus.on('ui:loop-start', () => {
    _endedCheckCounter = 0;
    _startSeekRaf();

    setManagedTimer('time-update-loop', () => {
      const currentState = getState('appState');
      if (isIdleOrPaused(currentState)) {
        clearManagedTimer('time-update-loop');
        _stopSeekRaf();
        return;
      }

      _rafAnchorTime = getTrackPosition();
      _rafAnchorTs = performance.now();

      _endedCheckCounter++;
      if (_endedCheckCounter >= 2) {
        _endedCheckCounter = 0;
        bus.emit('player:check-ended');
      }
    }, 250, { interval: true });
  });

  // Clean up when playback stops
  bus.on('player:stop-all-media', () => {
    clearManagedTimer('time-update-loop');
    _stopSeekRaf();
  });

  // YouTube time update (seek bar + time display)
  bus.on('ui:time-update', (currentFormatted, totalFormatted, currentTime, duration) => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    const tt = document.getElementById('time-dur');
    const isSeeking = getState('player.isSeeking');

    if (slider && duration > 0) {
      slider.max = String(duration);
      if (!isSeeking) {
        slider.value = String(currentTime);
        slider.setAttribute('aria-valuetext', currentFormatted);
      }
    }
    if (tc && !isSeeking) tc.innerText = currentFormatted;
    if (tt) tt.innerText = totalFormatted;
  });
}

// ─── Public Init ────────────────────────────────────────────────

export function initSeekBar(): void {
  initSeekBarInput();
  initSeekBarBusHandlers();
}
