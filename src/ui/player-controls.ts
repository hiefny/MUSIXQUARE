/**
 * MUSIXQUARE — Player Controls (UI)
 *
 * Manages: Play/pause/prev/next buttons, volume slider, seek bar,
 * mute toggle, role badge, media source popup, YouTube popup.
 */

import { log } from '../core/log.ts';
import { bus, createBusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG, PLAYBACK_STATE } from '../core/constants.ts';
import { IS_ANDROID, IS_IOS, canCaptureSystemAudio } from '../core/platform.ts';
import { getClockOffset, getHostNow, isClockCalibrated } from '../network/shared-clock.ts';
import { setManagedTimer, clearManagedTimer, getManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import type { I18nKey } from '../i18n/index.ts';
import { showToast } from './toast.ts';
import { showLoader } from './toast.ts';
import { switchTab } from './tabs.ts';
import {
  updateOverlayOpenClass,
  animateTransition,
  copyTextToClipboard,
  updateTitleWithMarquee,
  normalizeEmptyContentEditable,
} from './dom.ts';
import { showDialog } from './dialog.ts';
import { getTrackPosition, isFilePipelineBusyForPlay, togglePlay } from '../player/transport.ts';
import { toggleRepeat, toggleShuffle } from '../player/playlist.ts';
import { getCurrentAudioBuffer } from '../player/_state.ts';
import { hasPlayableFileSource } from '../player/file-playback-runtime.ts';
import { getCurrentQueueItemId, getCurrentQueueItemIndex } from '../player/queue-model.ts';
import { clearPreviewDebounce, clearYouTubeInputState } from '../youtube/search.ts';
import { broadcastYouTubeSync, guestRendezvousSync } from '../youtube/sync.ts';
import { getYouTubePlayer } from '../youtube/_state.ts';
import { initSeekBar } from './seekbar.ts';
import { installRangeDragGuard, syncRangeProgress } from './range-drag.ts';
import { markIntentionalNav } from '../core/page-lifecycle.ts';
import { getPlaybackModeActivitySnapshot, scopePlaybackModeActivity } from './_state-hooks.ts';
import {
  isPlaybackModeFile,
  isPlaybackModeSystemAudio,
  isPlaybackModeYouTube,
  isPlaybackPlayingFile,
} from '../player/ownership.ts';

// ─── Constants ───────────────────────────────────────────────────

const STANDARD_ROLE_MAP: Record<string, { labelKey: I18nKey; placementToastKey: I18nKey }> = {
  '0': { labelKey: 'common.original', placementToastKey: 'role.center_placement' },
  '-1': { labelKey: 'common.left', placementToastKey: 'role.left_placement' },
  '1': { labelKey: 'common.right', placementToastKey: 'role.right_placement' },
  '2': { labelKey: 'common.woofer', placementToastKey: 'role.center_placement' },
};

const ROLE_CLOCK_SECOND_MS = 1000;
const ROLE_CLOCK_PULSE_ON_MS = 120;
const ROLE_CLOCK_PULSE_GAP_MS = 120;
const ROLE_CLOCK_SECOND_PULSE_START_MS = ROLE_CLOCK_PULSE_ON_MS + ROLE_CLOCK_PULSE_GAP_MS;
const ROLE_CLOCK_SECOND_PULSE_END_MS = ROLE_CLOCK_SECOND_PULSE_START_MS + ROLE_CLOCK_PULSE_ON_MS;
const ROLE_CLOCK_PULSE_TIMER = 'role-clock-pulse';
const ROLE_CLOCK_PULSE_RESET_TIMER = 'role-clock-pulse-reset';
const LOCAL_FILE_SYNC_SCHEDULE_AHEAD_MS = 200;
let _ytPlayButtonLoading = false;
let _filePlayButtonLoading = false;

function isFilePlayButtonLoading(): boolean {
  const lifecycle = getState('playback.lifecycle');
  return (
    lifecycle === PLAYBACK_STATE.DOWNLOADING ||
    lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD ||
    lifecycle === PLAYBACK_STATE.DECODING
  );
}

function syncPlayButtonLoadingClass(): void {
  const btn = document.getElementById('play-btn');
  if (!btn) return;
  btn.classList.toggle('yt-syncing', _ytPlayButtonLoading || _filePlayButtonLoading);
  btn.setAttribute('aria-busy', String(_ytPlayButtonLoading || _filePlayButtonLoading));
}

function refreshFilePlayButtonLoading(): void {
  _filePlayButtonLoading = isFilePlayButtonLoading();
  syncPlayButtonLoadingClass();
}

export function getRoleLabelByChannelMode(mode: number): string {
  return t((STANDARD_ROLE_MAP[String(mode)] || STANDARD_ROLE_MAP['0']).labelKey);
}

export function getStandardRolePreset(mode: number): {
  labelKey: I18nKey;
  placementToastKey: I18nKey;
} {
  return STANDARD_ROLE_MAP[String(mode)] || STANDARD_ROLE_MAP['0'];
}

export function showPlacementToastForChannel(mode: number): void {
  showToast(t(getStandardRolePreset(mode).placementToastKey));
}

// ─── Volume ──────────────────────────────────────────────────────

let _preMuteVolume = 0.5;

function updateVolumeIcon(): void {
  const icon = document.getElementById('vol-icon-btn');
  if (!icon) return;

  const vol = getState('audio.masterVolume') ?? 1;
  const muted = vol === 0;
  icon.classList.toggle('is-muted', muted);
  icon.setAttribute('aria-pressed', String(muted));
}

/** Refresh the track title in the UI, considering network restrictions for remote guests. */
function refreshTrackTitle(): void {
  const item = getState('player.currentTrackMeta');
  if (!item) {
    updateTitleWithMarquee(t('player.no_media'));
    const artistEl = document.getElementById('track-artist');
    if (artistEl) artistEl.innerText = '';
    return;
  }

  // System audio mode: always use translated string (survives language switch)
  const title =
    item.name === 'system-audio'
      ? t('system_audio.sharing')
      : item.name === 'system-audio-receiving'
        ? t('system_audio.receiving')
        : item.title || item.name || t('common.unknown');

  updateTitleWithMarquee(title);

  // Also update Artist
  const artistEl = document.getElementById('track-artist');
  if (artistEl) {
    if (item.artist) {
      artistEl.innerText = item.artist;
    } else {
      const idx = getCurrentQueueItemIndex();
      artistEl.innerText =
        item.type === 'youtube'
          ? t('common.youtube_video')
          : t('playlist.track_fallback', { idx: idx >= 0 ? idx + 1 : 1 });
    }
  }
}

function onVolInput(val: number): void {
  bus.emit('audio:set-volume', val / 100);
}

function onVolChange(val: number): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    bus.emit('network:broadcast', { type: MSG.VOLUME, value: val / 100 });
    showToast(t('common.volume_percent', { val: Math.round(val) }));
  }
}

function toggleMute(): void {
  const masterVolume = getState('audio.masterVolume') ?? 1;
  if (masterVolume > 0) {
    _preMuteVolume = masterVolume;
    bus.emit('audio:set-volume', 0);
    showToast(t('common.muted'));
    const hostConn = getState('network.hostConn');
    if (!hostConn) bus.emit('network:broadcast', { type: MSG.VOLUME, value: 0 });
  } else {
    bus.emit('audio:set-volume', _preMuteVolume || 0.5);
    const newVol = _preMuteVolume || 0.5;
    showToast(t('common.volume_percent', { val: Math.round(newVol * 100) }));
    const hostConn = getState('network.hostConn');
    if (!hostConn) bus.emit('network:broadcast', { type: MSG.VOLUME, value: newVol });
  }
}

// ─── Role Badge ──────────────────────────────────────────────────
// Badge text is intentionally English-only (HOST, PEER, GUEST, etc.)
// — treated as a brand/UI label, not translatable content.

function getRoleClockDot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#role-badge .role-dot');
}

function shouldPulseRoleClock(): boolean {
  if (document.visibilityState === 'hidden') return false;
  const appRole = getState('network.appRole');
  if (appRole === 'host') return true;
  return !!getState('network.hostConn') && isClockCalibrated();
}

function stopRoleClockPulse(): void {
  clearManagedTimer(ROLE_CLOCK_PULSE_TIMER);
  clearManagedTimer(ROLE_CLOCK_PULSE_RESET_TIMER);
  const dot = getRoleClockDot();
  if (dot) dot.classList.remove('clock-beat');
}

function scheduleRoleClockPulse(realign = false): void {
  if (!shouldPulseRoleClock()) {
    stopRoleClockPulse();
    return;
  }
  if (!realign && getManagedTimer(ROLE_CLOCK_PULSE_TIMER)) return;

  clearManagedTimer(ROLE_CLOCK_PULSE_TIMER);
  clearManagedTimer(ROLE_CLOCK_PULSE_RESET_TIMER);

  const dot = getRoleClockDot();
  if (!dot || !shouldPulseRoleClock()) {
    stopRoleClockPulse();
    return;
  }

  const hostNow = getHostNow();
  const phase = ((hostNow % ROLE_CLOCK_SECOND_MS) + ROLE_CLOCK_SECOND_MS) % ROLE_CLOCK_SECOND_MS;

  let activeUntilMs = 0;
  let nextPulseDelayMs = ROLE_CLOCK_SECOND_MS - phase;
  if (phase < ROLE_CLOCK_PULSE_ON_MS) {
    activeUntilMs = ROLE_CLOCK_PULSE_ON_MS;
    nextPulseDelayMs = ROLE_CLOCK_SECOND_PULSE_START_MS - phase;
  } else if (phase < ROLE_CLOCK_SECOND_PULSE_START_MS) {
    nextPulseDelayMs = ROLE_CLOCK_SECOND_PULSE_START_MS - phase;
  } else if (phase < ROLE_CLOCK_SECOND_PULSE_END_MS) {
    activeUntilMs = ROLE_CLOCK_SECOND_PULSE_END_MS;
  }

  if (activeUntilMs > phase) {
    dot.classList.add('clock-beat');
    setManagedTimer(
      ROLE_CLOCK_PULSE_RESET_TIMER,
      () => {
        dot.classList.remove('clock-beat');
      },
      Math.max(1, activeUntilMs - phase),
    );
  } else {
    dot.classList.remove('clock-beat');
  }

  setManagedTimer(
    ROLE_CLOCK_PULSE_TIMER,
    () => {
      scheduleRoleClockPulse(true);
    },
    Math.max(1, nextPulseDelayMs),
  );
}

export function updateRoleBadge(): void {
  const badge = document.getElementById('role-badge');
  const text = document.getElementById('role-text');
  if (!badge || !text) return;

  badge.classList.remove('connected', 'remote');

  const isConnecting = getState('network.isConnecting');
  if (isConnecting) {
    text.innerText = 'CONNECTING';
    scheduleRoleClockPulse();
    return;
  }

  const hostConn = getState('network.hostConn');
  if (hostConn) {
    const myDeviceLabel = getState('network.myDeviceLabel') || '';
    const label = myDeviceLabel.trim() || 'PEER';
    const latency = getState('sync.lastLatencyMs') || 0;
    // Escape required: myDeviceLabel comes from rename dialog (connect.ts) whose
    // validator only checks reserved/duplicate/profanity (no HTML strip), AND
    // from a host broadcast in network/guest.ts. Without escape, a label like
    // "<svg onload=...>" (≤20 chars passes maxLength) would execute on the
    // labeled device's own role badge. Stored-XSS surface for guests too.
    const ping = document.createElement('span');
    ping.className = 'badge-ping';
    ping.textContent = `(${latency}ms)`;
    text.replaceChildren(document.createTextNode(`${label} `), ping);
    badge.classList.add('connected');
    if (getState('network.connectionType') === 'remote') {
      badge.classList.add('remote');
    }
    scheduleRoleClockPulse();
    return;
  }

  // Role badge text is INTENTIONALLY English-only ('HOST', 'GUEST', 'SETUP').
  // The device list UI also uses English labels ('Host', 'Peer 1', etc.),
  // so translating the badge to Korean ('호스트') creates a visual mismatch.
  // Do NOT i18n-ize these — they are identity labels, not UI copy.
  const appRole = getState('network.appRole');
  if (appRole === 'host') {
    text.innerText = 'HOST';
    badge.classList.add('connected');
    scheduleRoleClockPulse();
    return;
  }

  if (appRole === 'guest') {
    text.innerText = 'GUEST';
    scheduleRoleClockPulse();
    return;
  }

  text.innerText = 'SETUP';
  scheduleRoleClockPulse();
}

// ─── Invite Code ─────────────────────────────────────────────────

export function getInviteCode(): string {
  const sessionCode = getState('network.sessionCode') || '';
  const lastJoinCode = getState('network.lastJoinCode') || '';
  if (sessionCode && /^\d{6}$/.test(sessionCode)) return sessionCode;
  if (lastJoinCode && /^\d{6}$/.test(lastJoinCode)) return lastJoinCode;
  return '------';
}

export function updateInviteCodeUI(): void {
  const code = getInviteCode();
  const elements = document.querySelectorAll('.invite-code-value');
  elements.forEach((el) => {
    el.textContent = code;
    el.setAttribute('data-code', code);
  });
}

function getConnectedDeviceCount(): number {
  const lastKnownDeviceList = getState('network.lastKnownDeviceList');
  if (Array.isArray(lastKnownDeviceList) && lastKnownDeviceList.length) {
    return lastKnownDeviceList.filter((d) => d && d.status === 'connected').length;
  }
  const connectedPeers = getState('network.connectedPeers');
  const hostConn = getState('network.hostConn');
  const appRole = getState('network.appRole');
  const sessionStarted = getState('setup.sessionStarted');
  const peerConnected = Array.isArray(connectedPeers)
    ? connectedPeers.filter((p) => p && p.status === 'connected').length
    : 0;
  if (!hostConn && (appRole === 'host' || sessionStarted || peerConnected > 0)) {
    return 1 + peerConnected;
  }
  if (hostConn && hostConn.open) return 2;
  return 1;
}

async function copyInviteCode(): Promise<void> {
  const code = getInviteCode();
  if (code === '------') return;

  const ok = await copyTextToClipboard(code);
  if (ok) {
    const cnt = getConnectedDeviceCount();
    showToast(t('toast.invite_code_info', { count: cnt, code }));
    document.querySelectorAll('.invite-code-value').forEach((el) => {
      el.classList.add('copied');
      setManagedTimer(
        'copied-feedback',
        () => {
          document
            .querySelectorAll('.invite-code-value')
            .forEach((e) => e.classList.remove('copied'));
        },
        600,
      );
    });
  } else {
    showToast(t('toast.copy_failed'));
  }
}

// ─── Media Source Popup ──────────────────────────────────────────

function openMediaSourcePopup(): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    showToast(t('toast.host_only_media'));
    return;
  }
  animateTransition(() => {
    const overlay = document.getElementById('media-source-overlay');
    if (overlay) {
      overlay.classList.add('active');
      updateOverlayOpenClass();
    }
  });
}

function closeMediaSourcePopup(): void {
  animateTransition(() => {
    const overlay = document.getElementById('media-source-overlay');
    if (overlay) {
      overlay.classList.remove('active');
      updateOverlayOpenClass();
    }
  });
}

function openYouTubePopup(): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    showToast(t('toast.host_only_youtube'));
    return;
  }
  animateTransition(() => {
    const overlay = document.getElementById('youtube-url-overlay');
    if (overlay) {
      overlay.classList.add('active');
      updateOverlayOpenClass();
    }
    clearYouTubeInputState();
    const input = document.getElementById('youtube-url-input') as HTMLElement | null;
    if (input) setManagedTimer('yt-url-focus', () => input.focus(), 100);
  });
}

function closeYouTubePopup(): void {
  clearPreviewDebounce();
  clearYouTubeInputState();
  const ytInput = document.getElementById('youtube-url-input');
  if (ytInput) ytInput.textContent = '';
  animateTransition(() => {
    const overlay = document.getElementById('youtube-url-overlay');
    if (overlay) {
      overlay.classList.remove('active');
      updateOverlayOpenClass();
    }
  });
}

// ─── File Selector ───────────────────────────────────────────────

function openFileSelector(): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    showToast(t('toast.host_only'));
    return;
  }
  const input = document.getElementById('file-input') as HTMLInputElement | null;
  if (!input) {
    log.warn('[UI] #file-input not found');
    showToast(t('toast.cant_select_file'));
    return;
  }
  input.click();
}

// ─── Sync Button ─────────────────────────────────────────────────

function openManualSyncOverlay(): void {
  if (!canUseManualSyncPanel()) {
    showToast(t('toast.sync_not_ready'));
    closeManualSyncOverlay();
    return;
  }

  bus.emit('sync:display-update');
  const overlay = document.getElementById('manual-sync-overlay');
  if (overlay) overlay.classList.add('show');
}

function closeManualSyncOverlay(): void {
  const overlay = document.getElementById('manual-sync-overlay');
  if (overlay) overlay.classList.remove('show');
}

function canUseManualSyncPanel(): boolean {
  const hostConn = getState('network.hostConn');
  if (!hostConn?.open) return false;
  if (isPlaybackModeSystemAudio()) return false;
  if (isPlaybackModeYouTube()) return true;
  if (!isPlaybackModeFile()) return false;

  // Demo files deliberately have no queue occurrence/ResidentFile owner and
  // remain on their legacy AudioBuffer path.
  if (getState('demo.active')) return !!getCurrentAudioBuffer();

  const queueItemId = getCurrentQueueItemId();
  return !!queueItemId && hasPlayableFileSource(queueItemId);
}

function handleMainSyncBtn(): void {
  // System Audio sharing: nudge sync still not meaningful (WebRTC realtime stream)
  if (isPlaybackModeSystemAudio()) {
    showToast(t('toast.sync_not_in_system_audio'));
    return;
  }

  const hostConn = getState('network.hostConn');
  if (isPlaybackModeYouTube()) {
    if (!hostConn) {
      broadcastYouTubeSync(true);
      showToast(t('toast.host_sync_requested'));
      return;
    }
    if (!hostConn.open) {
      showToast(t('toast.sync_not_ready'));
      return;
    }

    guestRendezvousSync({
      suppressProgressToast: true,
      onComplete: () => {
        openManualSyncOverlay();
        if (canUseManualSyncPanel()) showToast(t('toast.yt_manual_sync_prompt'));
      },
    });
    return;
  }

  if (!hostConn) {
    // During track prep (DOWNLOADING/AWAITING_PRELOAD/
    // DECODING) getTrackPosition() reads 0 and the resident buffer is the
    // previous track's — broadcasting PLAY/PAUSE(time 0, new index) would
    // bounce ready guests to 0:00 while the host is still preparing.
    if (isFilePipelineBusyForPlay()) {
      showToast(t('toast.sync_not_ready'));
      return;
    }
    const queueItemId = getCurrentQueueItemId();
    if (!queueItemId) {
      showToast(t('toast.sync_not_ready'));
      return;
    }
    const time = getTrackPosition();
    if (isPlaybackPlayingFile()) {
      bus.emit('network:broadcast', {
        type: MSG.PLAY,
        time,
        queueItemId,
        hostPlayAt: getHostNow() + LOCAL_FILE_SYNC_SCHEDULE_AHEAD_MS,
      });
    } else {
      bus.emit('network:broadcast', { type: MSG.PAUSE, time, queueItemId, reason: 'seek' });
    }
    showToast(t('toast.host_sync_requested'));
    return;
  }
  if (!hostConn.open) {
    showToast(t('toast.sync_not_ready'));
    return;
  }

  if (!canUseManualSyncPanel()) {
    openManualSyncOverlay();
    return;
  }

  bus.emit('sync:force-resync');
  openManualSyncOverlay();
}

// ─── Logo Return to Main ─────────────────────────────────────────

let _logoNavBusy = false;

async function handleLogoReturnToMain(): Promise<void> {
  if (_logoNavBusy) return;
  _logoNavBusy = true;

  try {
    const setupOverlay = document.getElementById('setup-overlay');
    const isOnMain = !!(setupOverlay && setupOverlay.classList.contains('active'));
    if (isOnMain) {
      switchTab('play');
      return;
    }

    const hostConn = getState('network.hostConn');
    const appRole = getState('network.appRole');
    const hasSession = !!(hostConn || appRole === 'host');
    if (hasSession) {
      const res = await showDialog({
        title: t('dialog.return_home_title'),
        message: t('dialog.return_home_msg') + '\n' + t('dialog.return_home_detail'),
        buttonText: t('common.ok'),
        secondaryText: t('common.stay'),
        defaultFocus: 'secondary',
      });
      if (res.action !== 'ok') return;
    }

    // Hard reload — clears all in-memory blobs, audio buffers, and stale state
    showLoader(true, t('dialog.leaving_session'));
    setManagedTimer(
      'logo-nav-reload',
      () => {
        markIntentionalNav();
        window.location.reload();
      },
      300,
    );
  } finally {
    _logoNavBusy = false;
  }
}

// ─── Android Range Drag Guard ────────────────────────────────────

function installAndroidRangeScrollFix(): void {
  if (!IS_ANDROID) return;
  try {
    const ranges = Array.from(document.querySelectorAll('input[type="range"]'));
    ranges.forEach((range) => {
      const scrollParent = range.closest('.tab-content') as HTMLElement | null;
      if (!scrollParent) return;

      let prevOverflowY: string | null = null;
      const lock = () => {
        if (prevOverflowY === null) prevOverflowY = scrollParent.style.overflowY;
        scrollParent.style.overflowY = 'hidden';
      };
      const unlock = () => {
        scrollParent.style.overflowY = prevOverflowY !== null ? prevOverflowY : '';
        prevOverflowY = null;
      };

      range.addEventListener('touchstart', lock, { passive: true });
      range.addEventListener('touchend', unlock, { passive: true });
      range.addEventListener('touchcancel', unlock, { passive: true });
    });
  } catch (e) {
    log.debug('[Android] Range scroll fix init failed:', e);
  }
}

// ─── Seek Bar Delegation ────────────────────────────────────────

// ─── Volume Sync ─────────────────────────────────────────────────

function syncVolumeSlider(): void {
  const vol = getState('audio.masterVolume') ?? 1;
  const vSlider = document.getElementById('volume-slider') as HTMLInputElement | null;
  if (vSlider) {
    vSlider.value = String(vol * 100);
    syncRangeProgress(vSlider);
  }
  updateVolumeIcon();
}

// ─── Module State ───────────────────────────────────────────────

// ─── Init ────────────────────────────────────────────────────────

const _busScope = createBusScope();

export function initPlayerControls(): void {
  // Release any prior-init subscriptions so HMR / future re-init paths
  // don't stack duplicate handlers. Matches the pattern in connect.ts
  // and playlist-view.ts.
  _busScope.dispose();
  _ytPlayButtonLoading = false;
  _filePlayButtonLoading = false;

  const $on = (id: string, evt: string, fn: EventListener) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  };

  // Header
  $on('btn-help', 'click', () => switchTab('guide'));
  $on('btn-fullscreen', 'click', () => {
    const doc = document as Document & {
      webkitFullscreenElement?: Element;
      webkitExitFullscreen?: () => void;
    };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    const videoWrapper = document.querySelector('.video-wrapper') as
      | (HTMLElement & { webkitRequestFullscreen?: () => void })
      | null;
    const target = videoWrapper || el;

    const enterFake = () => {
      videoWrapper?.classList.add('fake-fullscreen');
      document.body.classList.add('has-fake-fullscreen');
    };
    const exitFake = () => {
      videoWrapper?.classList.remove('fake-fullscreen');
      document.body.classList.remove('has-fake-fullscreen');
    };

    const isFakeFullscreen = videoWrapper?.classList.contains('fake-fullscreen');
    const isFullscreen = !!(
      document.fullscreenElement ||
      doc.webkitFullscreenElement ||
      isFakeFullscreen
    );

    try {
      if (!isFullscreen) {
        if (target.requestFullscreen) {
          target.requestFullscreen().catch(enterFake);
        } else if (target.webkitRequestFullscreen) {
          target.webkitRequestFullscreen();
          // webkit's call is sync and silent on failure — verify after a tick.
          setManagedTimer(
            'webkit-fullscreen-fallback',
            () => {
              if (!document.fullscreenElement && !doc.webkitFullscreenElement) enterFake();
            },
            100,
          );
        } else {
          enterFake();
        }
      } else if (isFakeFullscreen) {
        exitFake();
      } else if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      }
    } catch {
      // Synchronous webkit call can throw — fall back to fake fullscreen toggle.
      if (isFakeFullscreen) exitFake();
      else enterFake();
    }
  });

  // Role badge
  const roleBadge = document.getElementById('role-badge');
  if (roleBadge) {
    roleBadge.setAttribute('role', 'button');
    roleBadge.setAttribute('tabindex', '0');
    const onShowCode = async (e?: Event) => {
      try {
        e?.preventDefault?.();
        e?.stopPropagation?.();
      } catch {
        /* ignore */
      }
      const code = getInviteCode();
      if (!code || code === '------') {
        showToast(t('toast.no_invite_code'));
        return;
      }
      const ok = await copyTextToClipboard(code);
      if (ok) {
        const cnt = getConnectedDeviceCount();
        showToast(t('toast.invite_code_info', { count: cnt, code }));
      } else {
        showToast(t('toast.invite_code', { code }));
      }
    };
    roleBadge.addEventListener('click', onShowCode);
    roleBadge.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter' && (e as KeyboardEvent).key !== ' ') return;
      e.preventDefault(); // Prevent page scroll on Space key
      onShowCode(e);
    });
  }

  // Logo — native <button>, so Enter/Space auto-fires click (no keydown handler needed)
  const logo = document.getElementById('app-logo') || document.querySelector('.app-logo');
  if (logo) {
    logo.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleLogoReturnToMain();
    });
  }

  // Player buttons
  $on('btn-prev', 'click', () => bus.emit('playlist:prev-track'));
  $on('play-btn', 'click', () => bus.emit('player:toggle-play'));
  $on('btn-next', 'click', () => bus.emit('playlist:next-track'));
  // Mute button — native <button>, so Enter/Space auto-fires click
  $on('vol-icon-btn', 'click', () => toggleMute());
  $on('volume-slider', 'input', function (this: HTMLInputElement) {
    onVolInput(Number(this.value));
  });
  $on('volume-slider', 'change', function (this: HTMLInputElement) {
    onVolChange(Number(this.value));
  });
  $on('btn-sync', 'click', () => handleMainSyncBtn());
  $on('btn-media-source', 'click', () => {
    if (isPlaybackModeSystemAudio()) {
      if (getState('network.hostConn')) {
        showToast(t('toast.host_only_media'));
        return;
      }
      bus.emit('system-audio:stop');
    } else {
      openMediaSourcePopup();
    }
  });

  // Playlist tab
  $on('btn-repeat', 'click', () => bus.emit('playlist:toggle-repeat'));
  $on('btn-shuffle', 'click', () => bus.emit('playlist:toggle-shuffle'));
  $on('btn-add-media', 'click', () => openMediaSourcePopup());

  // Media source popup
  $on('btn-local-file', 'click', () => openFileSelector());
  $on('btn-youtube-source', 'click', () => {
    closeMediaSourcePopup();
    openYouTubePopup();
  });
  $on('btn-system-audio', 'click', () => {
    if (canCaptureSystemAudio()) {
      closeMediaSourcePopup();
      bus.emit('system-audio:start');
    } else {
      showToast(t('system_audio.desktop_only'));
    }
  });
  if (!canCaptureSystemAudio()) {
    document.getElementById('btn-system-audio')?.classList.add('unsupported');
  }
  $on('btn-close-media-popup', 'click', () => closeMediaSourcePopup());

  // Demo button (Help tab — desktop + mobile)
  $on('btn-demo-media', 'click', () => {
    bus.emit('demo:enter');
  });
  $on('btn-demo-media-mobile', 'click', () => {
    bus.emit('demo:enter');
  });

  // YouTube popup (contenteditable)
  const ytInput = document.getElementById('youtube-url-input');
  if (ytInput) {
    ytInput.addEventListener('input', (e) => {
      // Stray-<br> placeholder restore — shared helper, see dom.ts.
      normalizeEmptyContentEditable(ytInput, e);
      bus.emit('youtube:preview', ytInput.textContent || '');
    });
    ytInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        bus.emit('youtube:load-from-input');
        if (IS_IOS || IS_ANDROID) ytInput.blur();
      }
    });
    ytInput.addEventListener('paste', (e) => {
      e.preventDefault();
      const clipboard = (e as ClipboardEvent).clipboardData;
      const text =
        clipboard?.getData('text/plain') ||
        clipboard?.getData('text/uri-list') ||
        clipboard?.getData('URL') ||
        '';
      document.execCommand('insertText', false, text);
    });
  }
  $on('btn-yt-cancel', 'click', () => closeYouTubePopup());
  $on('youtube-play-btn', 'click', () => bus.emit('youtube:load-from-input'));

  // Seek bar
  initSeekBar();

  // Range sliders
  installRangeDragGuard();

  syncVolumeSlider();

  // Prevent range drags from scrolling the containing tab on Android.
  installAndroidRangeScrollFix();

  // Volume sync
  _busScope.on('audio:volume-changed', () => {
    syncVolumeSlider();
  });

  // Role badge update events
  _busScope.on('network:role-badge-update', () => {
    updateRoleBadge();
  });

  // Latency update → refresh role badge + clock offset display
  _busScope.on('sync:latency-update', () => {
    updateRoleBadge();
    scheduleRoleClockPulse(true);
    const autoEl = document.getElementById('auto-sync-value');
    if (autoEl) {
      const offset = getClockOffset();
      const ms = Math.round(offset);
      autoEl.innerText = ms > 0 ? `+${ms}` : `${ms}`;
    }
  });

  // Connection type updated (e.g. ICE resolved) → Re-trigger title update to check for Wi-Fi warning
  _busScope.on('state:network.connectionType', () => {
    refreshTrackTitle();
    updateRoleBadge();
  });

  document.addEventListener('visibilitychange', () => {
    scheduleRoleClockPulse(true);
  });

  // Guest: dim media source button (host-only action)
  _busScope.on('state:network.hostConn', () => {
    const mediaBtn = document.getElementById('btn-media-source');
    if (mediaBtn) {
      mediaBtn.style.opacity = getState('network.hostConn') ? '0.15' : '';
    }
  });

  // Language switch → refresh translated track title + tab title
  // i18n:changed fires after DOM translation, so playback metadata wins over placeholders.
  const refreshPlayerText = () => {
    refreshTrackTitle();
    const item = getState('player.currentTrackMeta');
    if (item) {
      _tabTitleTrack =
        item.name === 'system-audio'
          ? t('system_audio.sharing')
          : item.name === 'system-audio-receiving'
            ? t('system_audio.receiving')
            : item.title || item.name || '';
    } else {
      _tabTitleTrack = '';
    }
  };
  _busScope.on('i18n:changed', refreshPlayerText);
  _busScope.on('ui:player-panel-visible', refreshPlayerText);

  // Peer disconnected: update UI
  _busScope.on('network:peer-disconnected', (peerId) => {
    log.info(`[UI] Peer disconnected: ${peerId}`);
    updateRoleBadge();
  });

  // Invite code container click delegation
  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement)?.closest?.('.invite-code-container');
    if (target) {
      e.preventDefault();
      copyInviteCode();
    }
  });

  // Invite code update events
  _busScope.on('ui:settings-tab-opened', () => {
    updateInviteCodeUI();
  });

  // File input handler
  const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      closeMediaSourcePopup();
      bus.emit('app:files-selected', (e.target as HTMLInputElement).files);
      (e.target as HTMLInputElement).value = '';
    });
  }

  // Storage error handler (prevent silent error swallowing)
  _busScope.on('storage:error', (error, filename) => {
    log.error(`[Storage] Error for ${filename}:`, error);
    showToast(t('toast.file_save_error', { name: filename || 'unknown' }));
  });

  _busScope.on('storage:read-error', (data) => {
    const d = data as Record<string, unknown>;
    log.error('[Storage] Read error:', d?.filename, d?.error);
    showToast(t('toast.file_read_error', { name: String(d?.filename || 'unknown') }));
  });

  _busScope.on('storage:session-mismatch', (data) => {
    const d = data as Record<string, unknown>;
    log.warn('[Storage] Session mismatch:', d?.filename);
    showToast(t('toast.session_mismatch'));
  });

  // ── Bus Event Bridge ──────────────────────────────────────────

  // Toast
  _busScope.on('ui:show-toast', (message) => {
    showToast(message);
  });

  // Play button state (enabled/disabled)
  // aria-disabled instead of HTML `disabled` so the click handler still
  // fires when there's no media — _internalPlay surfaces a toast hint
  // ("미디어를 추가해주세요") that real `disabled` would silence.
  _busScope.on('ui:play-btn-state', (enabled) => {
    const btn = document.getElementById('play-btn');
    if (btn) {
      btn.setAttribute('aria-disabled', String(!enabled));
    }
  });

  // Play/Pause visual state — derived from playback activity + YouTube play event
  function updatePlayIcon(playing: boolean): void {
    const btn = document.getElementById('play-btn');
    const icon = btn?.querySelector('path');
    if (icon) {
      icon.setAttribute(
        'd',
        playing
          ? 'M6 19h4V5H6v14zm8-14v14h4V5h-4z' // pause icon
          : 'M8 5v14l11-7z',
      ); // play icon
    }
  }

  scopePlaybackModeActivity(
    _busScope,
    (playback) => {
      let playing = playback.activity === 'playing' && playback.mode !== null;
      if (playback.mode === 'youtube') {
        // The playback mode transitions to youtube the moment iframe creation
        // starts (setEngineMode in iframe.ts), well before the video actually
        // plays — assuming "playing" here would briefly show the pause icon
        // over a silent loading iframe. Defer to the iframe's real PlayerState
        // (1 = PLAYING). ui:update-play-state below refines this once YT
        // emits its first PLAYING/PAUSED transition.
        const ytPlayer = getYouTubePlayer();
        playing = ytPlayer?.getPlayerState?.() === 1;
      }
      updatePlayIcon(playing);

      // Clear YouTube sync spinner when leaving YouTube mode
      if (playback.mode !== 'youtube') {
        _ytPlayButtonLoading = false;
        syncPlayButtonLoadingClass();
      }

      // System audio: host gets "공유 중지", guest keeps "미디어 재생" (dimmed)
      const mediaBtn = document.getElementById('btn-media-source');
      const mediaBtnLabel = mediaBtn?.querySelector('span');
      const isGuest = !!getState('network.hostConn');
      if (mediaBtnLabel) {
        if (playback.mode === 'system-audio') {
          if (isGuest) {
            // Guest: keep original label + color (opacity already set by hostConn listener)
            if (mediaBtn) mediaBtn.classList.add('sys-audio-guest');
          } else {
            // Host: show stop button. Keep data-i18n in sync so the
            // language-switch retranslation picks the right key instead of
            // treating this node as untranslated.
            mediaBtnLabel.textContent = t('system_audio.stop');
            mediaBtnLabel.setAttribute('data-i18n', 'system_audio.stop');
          }
        } else {
          const currentKey = mediaBtnLabel.getAttribute('data-i18n');
          if (!currentKey || currentKey === 'system_audio.stop') {
            mediaBtnLabel.textContent = t('player.play_media');
            mediaBtnLabel.setAttribute('data-i18n', 'player.play_media');
          }
          if (mediaBtn) {
            // Restore host opacity only — guest stays dimmed via hostConn listener
            if (!getState('network.hostConn')) mediaBtn.style.opacity = '';
            mediaBtn.classList.remove('sys-audio-guest');
          }
        }
      }
    },
    { immediate: true },
  );

  // YouTube pause/play doesn't change playback activity — still need this event
  _busScope.on('ui:update-play-state', (playing) => {
    if (isPlaybackModeYouTube()) {
      updatePlayIcon(playing);
    }
  });

  // YouTube auto-sync loading spinner on play button
  _busScope.on('youtube:sync-loading', (loading) => {
    _ytPlayButtonLoading = !!loading;
    syncPlayButtonLoadingClass();
  });

  refreshFilePlayButtonLoading();
  _busScope.on('state:playback.lifecycle', () => {
    refreshFilePlayButtonLoading();
  });

  // Player actions
  _busScope.on('player:toggle-play', () => {
    togglePlay();
  });

  // Playlist actions
  _busScope.on('playlist:toggle-repeat', () => {
    toggleRepeat();
  });

  _busScope.on('playlist:toggle-shuffle', () => {
    toggleShuffle();
  });

  // Metadata update (track title in player UI)
  _busScope.on('state:player.currentTrackMeta', () => {
    refreshTrackTitle();
  });

  // Sync display update (dual: auto + manual)
  // Unit ("ms") is shown in the column label, not appended to the value,
  // so 4-digit offsets (e.g. +1022) don't visually crowd the small tile.
  const fmtMs = (ms: number) => (ms > 0 ? `+${ms}` : `${ms}`);

  _busScope.on('sync:display-update', () => {
    const localOffset = isPlaybackModeYouTube()
      ? getState('sync.youtubeLocalOffset') || 0
      : getState('sync.localOffset') || 0;
    const manualEl = document.getElementById('manual-sync-value');
    const autoEl = document.getElementById('auto-sync-value');
    if (manualEl) manualEl.innerText = fmtMs(Math.round(localOffset * 1000));
    if (autoEl) autoEl.innerText = fmtMs(Math.round(getClockOffset()));
  });

  const closeManualSyncIfInvalid = () => {
    const overlay = document.getElementById('manual-sync-overlay');
    if (!overlay?.classList.contains('show')) return;
    if (!canUseManualSyncPanel()) closeManualSyncOverlay();
  };
  _busScope.on('state:playback.mode', closeManualSyncIfInvalid);
  _busScope.on('state:playback.activity', closeManualSyncIfInvalid);
  _busScope.on('state:network.hostConn', closeManualSyncIfInvalid);
  _busScope.on('state:network.sessionCode', closeManualSyncIfInvalid);
  _busScope.on('player:buffer-changed', closeManualSyncIfInvalid);

  // YouTube time update — handled by seekbar.ts

  // ── Tab Title Marquee ───────────────────────────────────────────

  const DEFAULT_TITLE = 'MUSIXQUARE · 뮤직스퀘어';
  const MARQUEE_PAUSE_START = 3; // 3s pause at start
  const MARQUEE_PAUSE_END = 1; // 1s pause at end
  let _tabTitleTrack = '';
  function startTabTitleMarquee(): void {
    if (getManagedTimer('tab-title-marquee')) return;

    let scrollPos = 0;
    let startPause = 0;
    let endPause = 0;

    setManagedTimer(
      'tab-title-marquee',
      () => {
        const playback = getPlaybackModeActivitySnapshot();
        if (playback.activity === 'idle' || playback.activity === 'pending') {
          stopTabTitleMarquee();
          return;
        }

        const name = _tabTitleTrack || 'MUSIXQUARE';
        if (playback.activity === 'paused') {
          stopTabTitleMarquee();
          document.title = `${name} · MUSIXQUARE`;
          return;
        }

        const suffix = ' · MUSIXQUARE';
        const full = name + suffix;

        // Phase 1: start pause (3s)
        if (scrollPos === 0 && startPause < MARQUEE_PAUSE_START) {
          document.title = full;
          startPause++;
          return;
        }

        // Phase 3: end pause (1s)
        const maxScroll = name.length + 3; // " · " length
        if (scrollPos >= maxScroll) {
          if (endPause < MARQUEE_PAUSE_END) {
            document.title = 'MUSIXQUARE';
            endPause++;
            return;
          }
          scrollPos = 0;
          startPause = 0;
          endPause = 0;
          return;
        }

        // Phase 2: scrolling — skip leading whitespace to prevent browser trimming
        while (scrollPos < full.length && /\s/.test(full[scrollPos])) scrollPos++;
        if (scrollPos >= maxScroll) {
          scrollPos = maxScroll;
          document.title = 'MUSIXQUARE';
          return;
        }
        document.title = full.slice(scrollPos);
        scrollPos++;
      },
      1000,
      { interval: true },
    );
  }

  function stopTabTitleMarquee(): void {
    clearManagedTimer('tab-title-marquee');
    document.title = _tabTitleTrack ? `${_tabTitleTrack} · MUSIXQUARE` : DEFAULT_TITLE;
  }

  _busScope.on('state:player.currentTrackMeta', () => {
    const item = getState('player.currentTrackMeta');
    if (item) {
      _tabTitleTrack =
        item.name === 'system-audio'
          ? t('system_audio.sharing')
          : item.name === 'system-audio-receiving'
            ? t('system_audio.receiving')
            : item.title || item.name || '';
    } else {
      _tabTitleTrack = '';
      document.title = DEFAULT_TITLE;
    }
  });

  scopePlaybackModeActivity(
    _busScope,
    (playback) => {
      if (playback.activity === 'playing') {
        startTabTitleMarquee();
      } else {
        stopTabTitleMarquee();
      }
    },
    { immediate: true },
  );

  // YouTube pause/play doesn't change playback activity — handle via play-state event
  _busScope.on('ui:update-play-state', (playing) => {
    if (!isPlaybackModeYouTube()) return;
    if (playing) {
      startTabTitleMarquee();
    } else {
      stopTabTitleMarquee();
      const name = _tabTitleTrack || 'MUSIXQUARE';
      document.title = `${name} · MUSIXQUARE`;
    }
  });

  log.info('[PlayerControls] Initialized');
}
