/**
 * MUSIXQUARE — Seekbar Module
 *
 * Manages: Seek slider, rAF interpolation loop, time display,
 * duration updates, YouTube time sync, ended-check polling.
 *
 * Extracted from player-controls.ts for single-responsibility.
 */

import { bus, createBusScope } from '../core/events.ts';
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
let _systemAudioZerosApplied = false;
const SYSTEM_AUDIO_POLL_MS = 1000;

function _seekRafLoop(now: number): void {
  // System audio: no seek position — write zeros ONCE then poll at 1Hz.
  // Previously this branch wrote the same zeros every frame at 60fps, which
  // was wasted DOM work (and battery on mobile) for a static display.
  // We still need to poll so the loop can resume normal interpolation when
  // the user exits system-audio mode.
  if (getState('appState') === APP_STATE.PLAYING_SYSTEM_AUDIO) {
    if (!_systemAudioZerosApplied) {
      const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
      const tc = document.getElementById('time-curr');
      const tt = document.getElementById('time-total');
      if (slider) { slider.value = '0'; slider.max = '0'; }
      if (tc) tc.innerText = '0:00';
      if (tt) tt.innerText = '0:00';
      _systemAudioZerosApplied = true;
    }
    _rafId = window.setTimeout(
      () => { _rafId = requestAnimationFrame(_seekRafLoop); },
      SYSTEM_AUDIO_POLL_MS,
    );
    return;
  }
  _systemAudioZerosApplied = false;

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
    // _rafId may hold either a RAF id or a setTimeout id (system-audio
    // throttle path). Clearing both is safe — the unused handle is a no-op.
    cancelAnimationFrame(_rafId);
    clearTimeout(_rafId);
    _rafId = 0;
  }
  _systemAudioZerosApplied = false;
}

// ─── Bus Event Handlers ─────────────────────────────────────────

const _busScope = createBusScope();

function initSeekBarBusHandlers(): void {
  _busScope.dispose();

  _busScope.on('ui:duration-update', (duration) => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tTotal = document.getElementById('time-dur');
    if (slider) { slider.max = String(duration); }
    if (tTotal) tTotal.innerText = fmtTime(duration);
  });

  _busScope.on('ui:seek-reset', () => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    if (slider) { slider.value = '0'; }
    if (tc) tc.innerText = '0:00';
    clearManagedTimer('time-update-loop');
    _stopSeekRaf();
  });

  let _endedCheckCounter = 0;
  _busScope.on('ui:loop-start', () => {
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

  _busScope.on('player:stop-all-media', () => {
    clearManagedTimer('time-update-loop');
    _stopSeekRaf();
  });

  // YouTube time update (seek bar + time display)
  _busScope.on('ui:time-update', (currentFormatted, totalFormatted, currentTime, duration) => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    const tt = document.getElementById('time-dur');
    const isSeeking = getState('player.isSeeking');

    if (slider) {
      if (duration > 0) {
        slider.max = String(duration);
      }
      if (!isSeeking && duration > 0) {
        slider.value = String(currentTime);
        slider.setAttribute('aria-valuetext', currentFormatted);
      }
    }
    // Always update time text — even during duration=0 (new video loading),
    // so the user sees "0:03" ticking instead of a frozen display.
    if (tc && !isSeeking) tc.innerText = currentFormatted;
    if (tt && duration > 0) tt.innerText = totalFormatted;
  });
}

// ─── Public Init ────────────────────────────────────────────────

export function initSeekBar(): void {
  initSeekBarInput();
  initSeekBarBusHandlers();
}
