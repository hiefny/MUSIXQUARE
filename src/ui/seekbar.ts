/**
 * MUSIXQUARE — Seekbar Module
 *
 * Manages: Seek slider, rAF interpolation loop, time display,
 * duration updates, YouTube time sync, ended-check polling.
 *
 * Keeps seek and time-display state isolated from the broader player controls.
 */

import { bus, createBusScope } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { fmtTime, getTrackPosition, seekTo } from '../player/transport.ts';
import { getPlaybackModeActivitySnapshot } from '../player/ownership.ts';
import { getCurrentAudioBuffer } from '../player/_state.ts';
import { getCurrentQueueItemId } from '../player/queue-model.ts';
import { legacyBoundedFileV1Product } from '../player/legacy-bounded-file-v1-product.ts';
import type {
  ProPlaybackUiControlPendingEvent,
  QueueItemId,
  V2HostSeekPendingEvent,
} from '../types/index.ts';
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

const SEEK_DRAFT_RELEASE_TIMER = 'seekbar-draft-release';
const SEEK_DRAFT_RELEASE_FALLBACK_MS = 350;
let _seekDraftActive = false;

function anchorSeekDraft(slider: HTMLInputElement): void {
  const value = Number.parseFloat(slider.value);
  if (!Number.isFinite(value) || value < 0) return;
  _rafAnchorTime = value;
  _rafAnchorTs = performance.now();
}

function beginSeekDraft(slider: HTMLInputElement): void {
  clearManagedTimer(SEEK_DRAFT_RELEASE_TIMER);
  anchorSeekDraft(slider);
  if (_seekDraftActive && getState('player.isSeeking')) return;
  _seekDraftActive = true;
  setState('player.isSeeking', true);
}

function finishSeekDraft(slider?: HTMLInputElement): void {
  clearManagedTimer(SEEK_DRAFT_RELEASE_TIMER);
  if (slider) anchorSeekDraft(slider);
  _seekDraftActive = false;
  setState('player.isSeeking', false);
}

function scheduleSeekDraftRelease(slider: HTMLInputElement): void {
  if (!_seekDraftActive && !getState('player.isSeeking')) return;
  anchorSeekDraft(slider);
  // iOS may deliver pointerup before the range input's change event. Hold the
  // draft across that render opportunity so the old physical position cannot
  // repaint between release and command admission.
  setManagedTimer(
    SEEK_DRAFT_RELEASE_TIMER,
    () => finishSeekDraft(slider),
    SEEK_DRAFT_RELEASE_FALLBACK_MS,
  );
}

// ─── Seek Bar Input Events ──────────────────────────────────────

function initSeekBarInput(): void {
  const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
  if (!slider) return;

  slider.addEventListener('mousedown', () => beginSeekDraft(slider));
  slider.addEventListener('pointerdown', () => beginSeekDraft(slider));
  slider.addEventListener('touchstart', () => beginSeekDraft(slider), {
    passive: true,
  });
  slider.addEventListener('input', () => {
    if (isSeekUnavailable()) {
      setSeekSliderValue(slider, '0');
      return;
    }
    // Keyboard seeks do not have a pointerdown/touchstart boundary.
    beginSeekDraft(slider);
    const formatted = fmtTime(parseFloat(slider.value));
    const tc = document.getElementById('time-curr');
    if (tc) tc.innerText = formatted;
    slider.setAttribute('aria-valuetext', formatted);
  });

  slider.addEventListener('change', () => {
    beginSeekDraft(slider);
    if (isSeekUnavailable()) {
      setSeekSliderValue(slider, '0');
      finishSeekDraft(slider);
      return;
    }
    const seekTime = parseFloat(slider.value);
    try {
      // PRO command admission emits its pending token synchronously. Release
      // the input draft only after that longer-lived projection can take over.
      seekTo(seekTime);
    } finally {
      finishSeekDraft(slider);
    }
  });

  slider.addEventListener('mouseup', () => scheduleSeekDraftRelease(slider));
  slider.addEventListener('pointerup', () => scheduleSeekDraftRelease(slider));
  slider.addEventListener('lostpointercapture', () => scheduleSeekDraftRelease(slider));
  slider.addEventListener('touchend', () => scheduleSeekDraftRelease(slider), { passive: true });
  slider.addEventListener('pointercancel', () => finishSeekDraft(slider));
  slider.addEventListener('touchcancel', () => finishSeekDraft(slider), { passive: true });
  slider.addEventListener('contextmenu', () => finishSeekDraft(slider));
  slider.addEventListener('blur', () => finishSeekDraft(slider));
}

// ─── rAF Interpolation Loop ─────────────────────────────────────

let _rafId = 0;
let _rafAnchorTime = 0;
let _rafAnchorTs = 0;
let _rafLastFmtSec = -1;
let _systemAudioZerosApplied = false;
interface PendingSeekProjection {
  readonly owner: 'pro' | 'v2';
  readonly token: number;
  readonly queueItemId: QueueItemId | null;
  readonly targetSeconds: number;
  readonly order: number;
}

let _pendingSeekOrder = 0;
let _pendingProSeek: PendingSeekProjection | null = null;
let _pendingV2Seek: PendingSeekProjection | null = null;
const SYSTEM_AUDIO_POLL_MS = 1000;

function getPendingSeekProjection(): PendingSeekProjection | null {
  if (!_pendingProSeek) return _pendingV2Seek;
  if (!_pendingV2Seek) return _pendingProSeek;
  return _pendingProSeek.order > _pendingV2Seek.order ? _pendingProSeek : _pendingV2Seek;
}

function createPendingSeekProjection(
  owner: PendingSeekProjection['owner'],
  event: Readonly<ProPlaybackUiControlPendingEvent | V2HostSeekPendingEvent>,
): PendingSeekProjection {
  _pendingSeekOrder += 1;
  return {
    owner,
    token: event.token,
    queueItemId: event.queueItemId,
    targetSeconds: event.targetSeconds,
    order: _pendingSeekOrder,
  };
}

function clearPendingSeekProjections(): void {
  _pendingProSeek = null;
  _pendingV2Seek = null;
}

function keepOnlyCurrentQueueProjections(): PendingSeekProjection | null {
  const queueItemId = getCurrentQueueItemId();
  if (_pendingProSeek?.queueItemId !== queueItemId) _pendingProSeek = null;
  if (_pendingV2Seek?.queueItemId !== queueItemId) _pendingV2Seek = null;
  return getPendingSeekProjection();
}

function renderSeekPosition(positionSeconds: number): void {
  const safePosition = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0;
  const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
  const current = document.getElementById('time-curr');
  const formatted = fmtTime(safePosition);
  if (slider) {
    setSeekSliderValue(slider, String(safePosition));
    slider.setAttribute('aria-valuetext', formatted);
  }
  if (current) current.innerText = formatted;
  _rafLastFmtSec = Math.floor(safePosition);
}

function readCanonicalBoundedFileTimeline(): Readonly<{
  durationSeconds: number;
  positionSeconds: number;
}> | null {
  const snapshot = legacyBoundedFileV1Product.snapshot();
  const current = snapshot.current;
  if (
    !snapshot.active ||
    (snapshot.role !== 'host' && snapshot.role !== 'guest') ||
    !current ||
    current.state !== 'ready' ||
    current.queueItemId !== getCurrentQueueItemId() ||
    !Number.isFinite(current.durationSeconds) ||
    (current.durationSeconds ?? 0) <= 0
  ) {
    return null;
  }

  const livePosition = legacyBoundedFileV1Product.positionSeconds();
  const pausedAt = getState('player.pausedAt');
  const positionSeconds =
    current.phase === 'stopped'
      ? pausedAt
      : livePosition !== null && Number.isFinite(livePosition)
        ? livePosition
        : current.positionSeconds;
  return Object.freeze({
    durationSeconds: current.durationSeconds!,
    positionSeconds: Math.min(
      current.durationSeconds!,
      Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0,
    ),
  });
}

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
  if (!isSeeking && !getPendingSeekProjection() && isPlaying) {
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
  _rafAnchorTime = getPendingSeekProjection()?.targetSeconds ?? getTrackPosition();
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
  finishSeekDraft();
  clearPendingSeekProjections();

  _busScope.on('ui:duration-update', (duration) => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tTotal = document.getElementById('time-dur');
    if (slider) {
      setSeekSliderMax(slider, String(duration));
    }
    if (tTotal) tTotal.innerText = fmtTime(duration);
  });

  _busScope.on('ui:seek-reset', () => {
    finishSeekDraft();
    clearManagedTimer('time-update-loop');
    _stopSeekRaf();
    // PRO and V2 playing seeks may intentionally tear down and re-prepare the
    // same resident media. Their internal stop emits seek-reset, but the
    // initiating browser keeps the requested target until canonical apply.
    const projection = keepOnlyCurrentQueueProjections();
    if (projection) {
      renderSeekPosition(projection.targetSeconds);
      return;
    }
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    if (slider) {
      setSeekSliderValue(slider, '0');
    }
    if (tc) tc.innerText = '0:00';
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
        if (!getPendingSeekProjection() && isFileActivelyPlaying()) {
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

  _busScope.on('state:playback.activity', (activity) => {
    if (activity !== 'paused' || getPlaybackModeActivitySnapshot().mode !== 'file') return;
    // Stop interpolation immediately at the exact physical pause evidence.
    // Waiting for the 250 ms safety poll leaves a visible fractional drift and
    // can let a quick resume reuse the pre-pause rAF timestamp.
    clearManagedTimer('time-update-loop');
    _stopSeekRaf();
    const projection = getPendingSeekProjection();
    const exactPosition = getTrackPosition();
    const pausedAt = getState('player.pausedAt');
    const positionSeconds =
      projection?.targetSeconds ?? (exactPosition > 0 || pausedAt <= 0 ? exactPosition : pausedAt);
    _rafAnchorTime = Number.isFinite(positionSeconds) && positionSeconds >= 0 ? positionSeconds : 0;
    _rafAnchorTs = performance.now();
    renderSeekPosition(_rafAnchorTime);
  });

  _busScope.on('player:stop-all-media', () => {
    finishSeekDraft();
    clearManagedTimer('time-update-loop');
    _stopSeekRaf();
    const projection = keepOnlyCurrentQueueProjections();
    if (projection) {
      renderSeekPosition(projection.targetSeconds);
      return;
    }
  });

  _busScope.on('pro-playback:ui-control-pending', (event) => {
    if (event.kind !== 'seek') return;
    _pendingProSeek = createPendingSeekProjection('pro', event);
    _rafAnchorTime = event.targetSeconds;
    _rafAnchorTs = performance.now();
    renderSeekPosition(event.targetSeconds);
  });

  _busScope.on('pro-playback:ui-control-settled', (event) => {
    if (event.kind !== 'seek' || _pendingProSeek?.token !== event.token) return;
    const projectedPosition = _pendingProSeek.targetSeconds;
    _pendingProSeek = null;
    const remainingProjection = getPendingSeekProjection();
    if (remainingProjection) {
      _rafAnchorTime = remainingProjection.targetSeconds;
      _rafAnchorTs = performance.now();
      renderSeekPosition(remainingProjection.targetSeconds);
      return;
    }
    const livePosition = getTrackPosition();
    const canonicalPosition = Number.isFinite(event.positionSeconds)
      ? event.positionSeconds
      : undefined;
    // PREPARE teardown can transiently report 0 even though the previous
    // resident timeline is about to be restored. Never manufacture a 0 flash
    // on a rejected/cancelled command: leave the user's projection in place
    // until the next real engine time sample repaints it.
    const position =
      canonicalPosition ??
      (event.status === 'applied' || livePosition > 0 ? livePosition : projectedPosition);
    _rafAnchorTime = Math.max(0, position);
    _rafAnchorTs = performance.now();
    renderSeekPosition(position);
  });

  _busScope.on('player:v2-host-seek-pending', (event) => {
    _pendingV2Seek = createPendingSeekProjection('v2', event);
    _rafAnchorTime = event.targetSeconds;
    _rafAnchorTs = performance.now();
    renderSeekPosition(event.targetSeconds);
  });

  _busScope.on('player:v2-host-seek-settled', (event) => {
    if (_pendingV2Seek?.token !== event.token || _pendingV2Seek.queueItemId !== event.queueItemId) {
      return;
    }
    _pendingV2Seek = null;
    const remainingProjection = getPendingSeekProjection();
    if (remainingProjection) {
      _rafAnchorTime = remainingProjection.targetSeconds;
      _rafAnchorTs = performance.now();
      renderSeekPosition(remainingProjection.targetSeconds);
      return;
    }
    const positionSeconds =
      Number.isFinite(event.positionSeconds) && event.positionSeconds >= 0
        ? event.positionSeconds
        : 0;
    _rafAnchorTime = positionSeconds;
    _rafAnchorTs = performance.now();
    renderSeekPosition(positionSeconds);
  });

  _busScope.on('state:playlist.currentQueueItemId', (queueItemId) => {
    if (_pendingProSeek && _pendingProSeek.queueItemId !== queueItemId) {
      _pendingProSeek = null;
    }
    if (_pendingV2Seek && _pendingV2Seek.queueItemId !== queueItemId) {
      _pendingV2Seek = null;
    }
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
      const bounded = readCanonicalBoundedFileTimeline();
      if (bounded) {
        if (slider) setSeekSliderMax(slider, String(bounded.durationSeconds));
        if (tDur) tDur.innerText = fmtTime(bounded.durationSeconds);
        renderSeekPosition(bounded.positionSeconds);
        return;
      }
      const buf = getCurrentAudioBuffer();
      if (buf && Number.isFinite(buf.duration) && buf.duration > 0) {
        if (slider) setSeekSliderMax(slider, String(buf.duration));
        if (tDur) tDur.innerText = fmtTime(buf.duration);
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
      if (!isSeeking && !getPendingSeekProjection() && duration > 0) {
        setSeekSliderValue(slider, String(currentTime));
        slider.setAttribute('aria-valuetext', currentFormatted);
      }
    }
    // Always update time text — even during duration=0 (new video loading),
    // so the user sees "0:03" ticking instead of a frozen display.
    if (tc && !isSeeking && !getPendingSeekProjection()) tc.innerText = currentFormatted;
    if (tt && duration > 0) tt.innerText = totalFormatted;
  });
}

// ─── Public Init ────────────────────────────────────────────────

export function initSeekBar(): void {
  initSeekBarInput();
  initSeekBarBusHandlers();
}
