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
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { fmtTime, getTrackPosition, seekTo } from '../player/transport.ts';
import { getPlaybackModeActivitySnapshot } from '../player/ownership.ts';
import { getFilePlaybackDuration } from '../player/media-element.ts';
import { syncRangeProgress } from './range-drag.ts';

function isSeekUnavailable(): boolean {
  const playback = getPlaybackModeActivitySnapshot();
  return playback.activity === 'idle' || playback.mode === 'system-audio';
}

function isSystemAudioMode(): boolean {
  return getPlaybackModeActivitySnapshot().mode === 'system-audio';
}

function shouldStopSeekLoop(): boolean {
  const playback = getPlaybackModeActivitySnapshot();
  return playback.activity === 'idle' || playback.activity === 'paused';
}

function isFileActivelyPlaying(): boolean {
  const playback = getPlaybackModeActivitySnapshot();
  return playback.mode === 'file' && playback.activity === 'playing';
}

function setSeekSliderValue(slider: HTMLInputElement, value: string): void {
  slider.value = value;
  syncRangeProgress(slider);
}

function setSeekSliderMax(slider: HTMLInputElement, value: string): void {
  slider.max = value;
  syncRangeProgress(slider);
}

// ─── Seek Bar Input Events ──────────────────────────────────────

function initSeekBarInput(): void {
  const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
  if (!slider) return;

  slider.addEventListener('mousedown', () => setState('player.isSeeking', true));
  slider.addEventListener('pointerdown', () => setState('player.isSeeking', true));
  slider.addEventListener('touchstart', () => setState('player.isSeeking', true), {
    passive: true,
  });
  slider.addEventListener('input', () => {
    if (isSeekUnavailable()) {
      setSeekSliderValue(slider, '0');
      return;
    }
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
    if (isSeekUnavailable()) {
      setSeekSliderValue(slider, '0');
      return;
    }
    const seekTime = parseFloat(slider.value);

    seekTo(seekTime);
  });

  slider.addEventListener('mouseup', releaseSeek);
  slider.addEventListener('pointerup', releaseSeek);
  slider.addEventListener('pointercancel', releaseSeek);
  slider.addEventListener('lostpointercapture', releaseSeek);
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
  if (isSystemAudioMode()) {
    if (!_systemAudioZerosApplied) {
      const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
      const tc = document.getElementById('time-curr');
      const tt = document.getElementById('time-dur');
      if (slider) {
        setSeekSliderValue(slider, '0');
        setSeekSliderMax(slider, '0');
      }
      if (tc) tc.innerText = '0:00';
      if (tt) tt.innerText = '0:00';
      _systemAudioZerosApplied = true;
    }
    _rafId = window.setTimeout(() => {
      _rafId = requestAnimationFrame(_seekRafLoop);
    }, SYSTEM_AUDIO_POLL_MS);
    return;
  }
  _systemAudioZerosApplied = false;

  const isSeeking = getState('player.isSeeking');
  // Only interpolate while the audio is actually playing. Without this guard
  // the loop kept advancing _rafAnchorTime + dt during the host's 3-second
  // autoPlayDelay, during decode, or while paused — so the thumb crawled
  // forward (the "drrrr" jitter), then snapped back to 0 once play(0) hit
  // and reset the anchor. PLAYING_SYSTEM_AUDIO short-circuits above, so this
  // narrowing to PLAYING_AUDIO covers the only state where wall-clock
  // interpolation is correct. PAUSED / IDLE / DECODING leave the thumb
  // wherever it last was, which matches user expectation.
  const isPlaying = isFileActivelyPlaying();
  if (!isSeeking && isPlaying) {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    if (slider) {
      const dt = (now - _rafAnchorTs) / 1000;
      const interpolated = Math.min(_rafAnchorTime + dt, parseFloat(slider.max) || 0);
      setSeekSliderValue(slider, String(interpolated));

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
    if (slider) {
      setSeekSliderMax(slider, String(duration));
    }
    if (tTotal) tTotal.innerText = fmtTime(duration);
  });

  _busScope.on('ui:seek-reset', () => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    if (slider) {
      setSeekSliderValue(slider, '0');
    }
    if (tc) tc.innerText = '0:00';
    clearManagedTimer('time-update-loop');
    _stopSeekRaf();
  });

  let _endedCheckCounter = 0;
  _busScope.on('ui:loop-start', () => {
    _endedCheckCounter = 0;
    _startSeekRaf();

    setManagedTimer(
      'time-update-loop',
      () => {
        if (shouldStopSeekLoop()) {
          clearManagedTimer('time-update-loop');
          _stopSeekRaf();
          return;
        }

        // Only refresh the rAF anchor when local audio is actually playing
        // and getTrackPosition reports a valid non-transient value. Without
        // these guards, two ways the anchor got stuck at 0 every 250ms —
        // jittering the thumb back to 0 and creating the "drrrr-snap-drrrr"
        // pattern users saw during the host's "오디오를 준비 중" window:
        //
        // 1. PLAYING_YOUTUBE / PLAYING_SYSTEM_AUDIO don't share this
        //    rAF interpolation model; getTrackPosition there returns
        //    0 (system audio) or routes through an async callback (YT)
        //    that is unrelated to the local-file thumb.
        // 2. Right after PLAYING_AUDIO is set but before player.startedAt
        //    or audioBuffer have settled, getTrackPosition can briefly
        //    return 0. Resetting the anchor to 0 in that window collapses
        //    the thumb back, then the rAF interpolation walks it forward
        //    until the next 250ms tick collapses it again. Treat 0 as
        //    transient and let the existing anchor (set by _startSeekRaf
        //    or by the previous valid tick) keep advancing via dt.
        if (isFileActivelyPlaying()) {
          const pos = getTrackPosition();
          if (pos > 0 && Number.isFinite(pos)) {
            _rafAnchorTime = pos;
            _rafAnchorTs = performance.now();
          }
        }

        _endedCheckCounter++;
        if (_endedCheckCounter >= 2) {
          _endedCheckCounter = 0;
          bus.emit('player:check-ended');
        }
      },
      250,
      { interval: true },
    );
  });

  _busScope.on('player:stop-all-media', () => {
    clearManagedTimer('time-update-loop');
    _stopSeekRaf();
  });

  // Mode-driven time display sync. The rAF system-audio zeroing branch is
  // unreachable on canonical entries (stopAllMedia kills the loop via
  // ui:seek-reset BEFORE mode flips), so entry zeroing must be deterministic
  // here. The 'file' repaint is its required pair: after an explicit
  // stop-sharing restore (or a guest resume from an existing buffer) no
  // ui:duration-update re-fires, so without it the display would stay 0:00.
  // ui:seek-reset deliberately stays duration-preserving (silent track-change
  // path depends on it) — do not move this logic there.
  _busScope.on('state:playback.mode', (mode) => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tDur = document.getElementById('time-dur');
    if (mode === 'system-audio') {
      const tc = document.getElementById('time-curr');
      if (slider) {
        setSeekSliderValue(slider, '0');
        setSeekSliderMax(slider, '0');
      }
      if (tc) tc.innerText = '0:00';
      if (tDur) tDur.innerText = '0:00';
    } else if (mode === 'file') {
      const duration = getFilePlaybackDuration();
      if (duration > 0) {
        if (slider) setSeekSliderMax(slider, String(duration));
        if (tDur) tDur.innerText = fmtTime(duration);
      }
    }
  });

  // YouTube time update (seek bar + time display)
  _busScope.on('ui:time-update', (currentFormatted, totalFormatted, currentTime, duration) => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    const tt = document.getElementById('time-dur');
    const isSeeking = getState('player.isSeeking');

    if (slider) {
      if (duration > 0) {
        setSeekSliderMax(slider, String(duration));
      }
      if (!isSeeking && duration > 0) {
        setSeekSliderValue(slider, String(currentTime));
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
