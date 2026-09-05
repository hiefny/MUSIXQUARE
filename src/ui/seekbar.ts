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
import {
  fmtTime,
  getTrackPosition,
  isFilePipelineBusyForPlay,
  seekTo,
} from '../player/transport.ts';
import { getPlaybackModeActivitySnapshot } from '../player/ownership.ts';
import { getCurrentAudioBuffer } from '../player/_state.ts';
import { getCurrentQueueItemId } from '../player/queue-model.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import {
  roomCapabilityRequiredMessage,
  showRoomCapabilityRequired,
} from '../rooms/permission-feedback.ts';
import { t } from '../i18n/index.ts';
import { isYouTubeZeroStartInFlight } from '../youtube/zero-start.ts';
import { isProPlaybackTrackSelectionPending } from '../pro-room/playback-authority-hooks.ts';
import type { ProPlaybackUiControlPendingEvent, QueueItemId } from '../types/index.ts';
import { syncRangeProgress } from './range-drag.ts';
import { showToast } from './toast.ts';

type SeekUnavailableReason = 'no-media' | 'not-ready' | 'permission' | 'system-audio';

function getSeekUnavailableReason(): SeekUnavailableReason | null {
  if (isProPlaybackTrackSelectionPending() || _proPlaybackTransitionLoading) return 'not-ready';
  const playback = getPlaybackModeActivitySnapshot();
  if (playback.activity === 'idle') return 'no-media';
  if (playback.mode === 'system-audio') return 'system-audio';
  if (playback.mode === 'file' && isFilePipelineBusyForPlay()) return 'not-ready';
  if (playback.mode === 'youtube' && isYouTubeZeroStartInFlight()) return 'not-ready';

  // Idle/demo playback intentionally remains locally seekable. Once a room
  // role exists, however, project the same capability that transport.seekTo
  // uses before the thumb can move, so a denied drag never snaps back later.
  const roomAuthorityApplies =
    getRoomContext().kind === 'pro' || getState('network.appRole') !== 'idle';
  if (roomAuthorityApplies && !hasRoomCapability('playback.control')) return 'permission';
  return null;
}

function getSeekUnavailableMessage(reason: SeekUnavailableReason): string {
  if (reason === 'permission') return roomCapabilityRequiredMessage('playback.control');
  if (reason === 'system-audio') return t('player.seek_unavailable_system_audio');
  if (reason === 'not-ready') return t('toast.sync_not_ready');
  return t('player.no_media');
}

const UNAVAILABLE_TIME_TEXT = '-:--';

function getTimelineUnavailableReason(): 'no-media' | 'system-audio' | null {
  const mode = getPlaybackModeActivitySnapshot().mode;
  if (mode === 'system-audio') return 'system-audio';
  if (mode === null) return 'no-media';
  return null;
}

function renderUnavailableTimeline(
  reason: 'no-media' | 'system-audio' = getTimelineUnavailableReason() ?? 'no-media',
): void {
  const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
  const current = document.getElementById('time-curr');
  const total = document.getElementById('time-dur');
  if (slider) {
    setSeekSliderValue(slider, '0');
    setSeekSliderMax(slider, '0');
    slider.setAttribute('aria-disabled', 'true');
    slider.setAttribute('aria-valuetext', getSeekUnavailableMessage(reason).replace(/\n/g, ' '));
  }
  if (current) current.innerText = UNAVAILABLE_TIME_TEXT;
  if (total) total.innerText = UNAVAILABLE_TIME_TEXT;
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
let _seekDenialFeedbackActive = false;
let _proPlaybackTransitionLoading = false;

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

function renderCanonicalSeekPosition(slider: HTMLInputElement): void {
  const projection = getPendingSeekProjection();
  const livePosition = getTrackPosition();
  const canonicalPosition =
    projection?.targetSeconds ??
    (Number.isFinite(livePosition) && livePosition >= 0 ? livePosition : 0);
  renderSeekPosition(canonicalPosition);
  syncRangeProgress(slider);
}

function showSeekUnavailableFeedback(reason: SeekUnavailableReason): void {
  if (_seekDenialFeedbackActive) return;
  _seekDenialFeedbackActive = true;
  if (reason === 'permission') {
    showRoomCapabilityRequired('playback.control');
  } else {
    showToast(getSeekUnavailableMessage(reason));
  }
}

function rejectSeekInteraction(slider: HTMLInputElement, announce = true): boolean {
  const reason = getSeekUnavailableReason();
  if (!reason) return false;
  finishSeekDraft();
  const timelineReason = getTimelineUnavailableReason();
  if (timelineReason) renderUnavailableTimeline(timelineReason);
  else renderCanonicalSeekPosition(slider);
  syncSeekAvailability(slider);
  if (announce) showSeekUnavailableFeedback(reason);
  return true;
}

function syncSeekAvailability(
  slider = document.getElementById('seek-slider') as HTMLInputElement | null,
): void {
  if (!slider) return;
  const reason = getSeekUnavailableReason();
  slider.setAttribute('aria-disabled', String(reason !== null));
  if (reason) {
    slider.title = getSeekUnavailableMessage(reason).replace(/\n/g, ' ');
  } else {
    slider.removeAttribute('title');
  }
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

function initSeekBarInput(signal?: AbortSignal): void {
  const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
  if (!slider) return;

  let activePointerId: number | null = null;
  const beginPointerDraft = (event: Event) => {
    _seekDenialFeedbackActive = false;
    if (rejectSeekInteraction(slider)) {
      event.preventDefault();
      return;
    }
    beginSeekDraft(slider);
  };
  slider.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || activePointerId !== null) return;
      activePointerId = event.pointerId;
      beginPointerDraft(event);
    },
    { signal },
  );
  // Pointer-enabled browsers dispatch compatibility mouse/touch events after
  // pointerdown. Keep the legacy listeners only as a fallback so one physical
  // drag cannot open the same permission feedback twice.
  slider.addEventListener(
    'mousedown',
    (event) => {
      if (typeof PointerEvent !== 'undefined') return;
      beginPointerDraft(event);
    },
    { signal },
  );
  slider.addEventListener(
    'touchstart',
    (event) => {
      if (typeof PointerEvent !== 'undefined') return;
      beginPointerDraft(event);
    },
    {
      passive: false,
      signal,
    },
  );
  slider.addEventListener(
    'input',
    () => {
      if (rejectSeekInteraction(slider)) return;
      // Keyboard seeks do not have a pointerdown/touchstart boundary.
      beginSeekDraft(slider);
      const formatted = fmtTime(parseFloat(slider.value));
      const tc = document.getElementById('time-curr');
      if (tc) tc.innerText = formatted;
      slider.setAttribute('aria-valuetext', formatted);
    },
    { signal },
  );

  slider.addEventListener(
    'change',
    () => {
      if (rejectSeekInteraction(slider)) return;
      beginSeekDraft(slider);
      const seekTime = parseFloat(slider.value);
      try {
        // PRO command admission emits its pending token synchronously. Release
        // the input draft only after that longer-lived projection can take over.
        seekTo(seekTime);
      } finally {
        finishSeekDraft(slider);
      }
    },
    { signal },
  );

  // A second touch can end or lose its implicit capture while the first still
  // owns the range. Keep the timeline draft with that same pointer owner.
  const finishPointerDraft = (event: PointerEvent) => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    activePointerId = null;
    if (event.type === 'pointercancel') finishSeekDraft(slider);
    else scheduleSeekDraftRelease(slider);
  };
  const finishLegacyDraft = (event: Event) => {
    if (typeof PointerEvent !== 'undefined') return;
    if (event.type === 'touchcancel') finishSeekDraft(slider);
    else scheduleSeekDraftRelease(slider);
  };
  slider.addEventListener('mouseup', finishLegacyDraft, { signal });
  slider.addEventListener('pointerup', finishPointerDraft, { signal });
  slider.addEventListener('lostpointercapture', finishPointerDraft, { signal });
  slider.addEventListener('touchend', finishLegacyDraft, {
    passive: true,
    signal,
  });
  slider.addEventListener('pointercancel', finishPointerDraft, { signal });
  slider.addEventListener('touchcancel', finishLegacyDraft, {
    passive: true,
    signal,
  });
  slider.addEventListener('contextmenu', () => finishSeekDraft(slider), { signal });
  slider.addEventListener('blur', () => finishSeekDraft(slider), { signal });
  slider.addEventListener(
    'keydown',
    (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
        return;
      }
      _seekDenialFeedbackActive = false;
      if (rejectSeekInteraction(slider)) event.preventDefault();
    },
    { signal },
  );
  slider.addEventListener(
    'keyup',
    () => {
      _seekDenialFeedbackActive = false;
    },
    { signal },
  );

  syncSeekAvailability(slider);
}

// ─── rAF Interpolation Loop ─────────────────────────────────────

let _rafId: number | null = null;
let _systemAudioPollTimer: number | null = null;
let _rafAnchorTime = 0;
let _rafAnchorTs = 0;
let _rafLastFmtSec = -1;
let _systemAudioZerosApplied = false;
interface PendingSeekProjection {
  readonly token: number;
  readonly queueItemId: QueueItemId | null;
  readonly targetSeconds: number;
}

let _pendingProSeek: PendingSeekProjection | null = null;
const SYSTEM_AUDIO_POLL_MS = 1000;

function getPendingSeekProjection(): PendingSeekProjection | null {
  return _pendingProSeek;
}

function createPendingSeekProjection(
  event: Readonly<ProPlaybackUiControlPendingEvent>,
): PendingSeekProjection {
  return {
    token: event.token,
    queueItemId: event.queueItemId,
    targetSeconds: event.targetSeconds,
  };
}

function clearPendingSeekProjections(): void {
  _pendingProSeek = null;
}

function keepOnlyCurrentQueueProjections(): PendingSeekProjection | null {
  const queueItemId = getCurrentQueueItemId();
  if (_pendingProSeek?.queueItemId !== queueItemId) _pendingProSeek = null;
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

function _seekRafLoop(now: number): void {
  _rafId = null;
  // System audio has no seekable timeline — render the unavailable state once
  // and then poll at 1Hz so leaving the mode resumes ordinary interpolation.
  // Previously this branch wrote the same zeros every frame at 60fps, which
  // was wasted DOM work (and battery on mobile) for a static display.
  // We still need to poll so the loop can resume normal interpolation when
  // the user exits system-audio mode.
  if (isSystemAudioMode()) {
    if (!_systemAudioZerosApplied) {
      renderUnavailableTimeline('system-audio');
      _systemAudioZerosApplied = true;
    }
    _systemAudioPollTimer = window.setTimeout(() => {
      _systemAudioPollTimer = null;
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
  if (_rafId !== null || _systemAudioPollTimer !== null) return;
  _rafAnchorTime = getPendingSeekProjection()?.targetSeconds ?? getTrackPosition();
  _rafAnchorTs = performance.now();
  _rafLastFmtSec = -1;
  _rafId = requestAnimationFrame(_seekRafLoop);
}

function _stopSeekRaf(): void {
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
  // rAF and timer handles have separate namespaces and may share a number.
  if (_systemAudioPollTimer !== null) {
    window.clearTimeout(_systemAudioPollTimer);
    _systemAudioPollTimer = null;
  }
  _systemAudioZerosApplied = false;
}

// ─── Bus Event Handlers ─────────────────────────────────────────

const _busScope = createBusScope();

function initSeekBarBusHandlers(): void {
  _busScope.dispose();
  finishSeekDraft();
  clearPendingSeekProjections();
  _proPlaybackTransitionLoading = false;

  const refreshAvailability = () => {
    syncSeekAvailability();
    const timelineReason = getTimelineUnavailableReason();
    if (timelineReason) renderUnavailableTimeline(timelineReason);
  };
  _busScope.on('state:playback.mode', refreshAvailability);
  _busScope.on('state:playback.activity', refreshAvailability);
  _busScope.on('state:network.appRole', refreshAvailability);
  _busScope.on('state:network.hostConn', refreshAvailability);
  _busScope.on('state:network.isOperator', refreshAvailability);
  _busScope.on('state:network.standardRoomCapabilities', refreshAvailability);
  _busScope.on('state:room.context', refreshAvailability);
  _busScope.on('state:playback.lifecycle', refreshAvailability);
  _busScope.on('youtube:zero-start-readiness-changed', refreshAvailability);
  // Zero-start keeps its protocol identity alive briefly after PLAYING so
  // timeline calibration can finish, but iframe ownership ends at PLAYING.
  // Busy=false is the exact boundary that must repaint an otherwise unchanged
  // YouTube playback state and release the seek affordance immediately.
  _busScope.on('youtube:sync-loading', refreshAvailability);
  _busScope.on('i18n:changed', refreshAvailability);
  _busScope.on('pro-playback:transition-loading', (loading) => {
    _proPlaybackTransitionLoading = loading;
    if (loading) finishSeekDraft();
    refreshAvailability();
  });

  _busScope.on('ui:duration-update', (duration) => {
    const timelineReason = getTimelineUnavailableReason();
    if (timelineReason) {
      renderUnavailableTimeline(timelineReason);
      return;
    }
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
    // A PRO playing seek may intentionally tear down and re-prepare the same
    // resident media. Its internal stop emits seek-reset, but the
    // initiating browser keeps the requested target until canonical apply.
    const projection = keepOnlyCurrentQueueProjections();
    if (projection) {
      renderSeekPosition(projection.targetSeconds);
      return;
    }
    const timelineReason = getTimelineUnavailableReason();
    if (timelineReason) {
      renderUnavailableTimeline(timelineReason);
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
    _pendingProSeek = createPendingSeekProjection(event);
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

  _busScope.on('state:playlist.currentQueueItemId', (queueItemId) => {
    if (_pendingProSeek && _pendingProSeek.queueItemId !== queueItemId) {
      _pendingProSeek = null;
    }
  });

  // Mode-driven time display sync. The rAF system-audio unavailable branch is
  // unreachable on canonical entries (stopAllMedia kills the loop via
  // ui:seek-reset BEFORE mode flips), so entry zeroing must be deterministic
  // here. The 'file' repaint is its required pair: after an explicit
  // stop-sharing restore (or a guest resume from an existing buffer) no
  // ui:duration-update re-fires, so without it the unavailable display would persist.
  // ui:seek-reset deliberately stays duration-preserving (silent track-change
  // path depends on it) — do not move this logic there.
  _busScope.on('state:playback.mode', (mode) => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tDur = document.getElementById('time-dur');
    if (mode === 'system-audio' || mode === null) {
      renderUnavailableTimeline(mode === 'system-audio' ? 'system-audio' : 'no-media');
    } else if (mode === 'file') {
      const buf = getCurrentAudioBuffer();
      if (buf && Number.isFinite(buf.duration) && buf.duration > 0) {
        if (slider) setSeekSliderMax(slider, String(buf.duration));
        if (tDur) tDur.innerText = fmtTime(buf.duration);
      }
      const exactPosition = getTrackPosition();
      const pausedAt = getState('player.pausedAt');
      const positionSeconds = exactPosition > 0 || pausedAt <= 0 ? exactPosition : pausedAt;
      if (Number.isFinite(positionSeconds) && positionSeconds >= 0) {
        renderSeekPosition(positionSeconds);
      }
    }
  });

  // YouTube time update (seek bar + time display)
  _busScope.on('ui:time-update', (currentFormatted, totalFormatted, currentTime, duration) => {
    const timelineReason = getTimelineUnavailableReason();
    if (timelineReason) {
      renderUnavailableTimeline(timelineReason);
      return;
    }
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

export function initSeekBar(signal?: AbortSignal): void {
  initSeekBarInput(signal);
  initSeekBarBusHandlers();
  const timelineReason = getTimelineUnavailableReason();
  if (timelineReason) renderUnavailableTimeline(timelineReason);
}
