/**
 * MUSIXQUARE — Player Controls (UI)
 *
 * Manages: Play/pause/prev/next buttons, volume slider, seek bar,
 * mute toggle, role badge, media source popup, YouTube popup.
 */

import { log } from '../core/log.ts';
import { bus, createBusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MAX_SYSTEM_AUDIO_DEVICES, PLAYBACK_STATE } from '../core/constants.ts';
import { IS_ANDROID, IS_IOS, canCaptureSystemAudio } from '../core/platform.ts';
import { getClockOffset, getHostNow, isClockCalibrated } from '../network/shared-clock.ts';
import { setManagedTimer, clearManagedTimer, getManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import type { I18nKey } from '../i18n/index.ts';
import { showToast } from './toast.ts';
import { applyUserTextFontFallback } from './user-text-font.ts';
import { switchTab } from './tabs.ts';
import {
  syncOverlayState,
  animateTransition,
  copyTextToClipboard,
  updateTitleWithMarquee,
  normalizeEmptyContentEditable,
} from './dom.ts';
import { showDialog } from './dialog.ts';
import { isFilePipelineBusyForPlay, togglePlay } from '../player/transport.ts';
import { toggleRepeat, toggleShuffle } from '../player/playlist.ts';
import { getCurrentAudioBuffer } from '../player/_state.ts';
import { exitYouTubeFullscreen } from '../player/video.ts';
import { getCurrentQueueItemId, getCurrentQueueItemIndex } from '../player/queue-model.ts';
import { AUDIO_FILE_ACCEPT } from '../media/audio-file.ts';
import {
  clearPreviewDebounce,
  clearYouTubeInputState,
  getYouTubeInputIntent,
} from '../youtube/search.ts';
import { primeYouTubePlayer, waitForPendingYouTubePrimeBounce } from '../youtube/iframe.ts';
import { YOUTUBE_PRIME_BOUNCE_TIMEOUT_MS } from '../youtube/constants.ts';
import { broadcastYouTubeSync, guestRendezvousSync } from '../youtube/sync.ts';
import { getYouTubePlayer } from '../youtube/_state.ts';
import { isYouTubeZeroStartProtocolActive } from '../youtube/zero-start.ts';
import { initSeekBar } from './seekbar.ts';
import { installRangeDragGuard, syncRangeProgress } from './range-drag.ts';
import { initTabTitleMarquee, setTabTitlePlaying, setTabTitleTrack } from './tab-title-marquee.ts';
import { getTrackDisplayTitle } from '../player/track-display.ts';
import type { ProPlaybackUiControlKind, YouTubeSyncLoadingOwner } from '../types/index.ts';
import { scheduleSessionReset } from '../core/session-reset.ts';
import { navigateToAppHome } from '../core/navigation.ts';
import { scopePlaybackModeActivity } from './_state-hooks.ts';
import {
  isPlaybackModeFile,
  isPlaybackModeSystemAudio,
  isPlaybackModeYouTube,
} from '../player/ownership.ts';
import {
  getRoomContext,
  hasRoomCapability,
  isActiveStandardRoomCoordinator,
  isCoordinator,
} from '../rooms/authority.ts';
import {
  roomCapabilityRequiredMessage,
  showRoomCapabilityRequired,
} from '../rooms/permission-feedback.ts';
import {
  clearProRoomTrackChangeIntent,
  isProRoomTrackChangeIntentPending,
} from '../player/track-change-intent.ts';
import { hasSystemAudioDeviceCapacity } from '../audio/system-audio-policy.ts';
import {
  canPublishProSystemAudioWithCurrentCoordinator,
  getProSystemAudioOwnerDisplayName,
  getProSystemAudioViewState,
  isLocalProSystemAudioOwner,
} from '../pro-room/system-audio-bridge.ts';
import { getAccountSnapshot } from '../account/state.ts';
import { openAccountDialog } from './account.ts';
import { getProRoomServerNow, proRoomServerBridge } from '../pro-room/network-bridge.ts';
import {
  canPublishSynchronizedSettings,
  isSettingsSyncEnabled,
  isSynchronizedVolumeLocked,
} from '../audio/effects.ts';

// ─── Constants ───────────────────────────────────────────────────

const STANDARD_ROLE_MAP: Record<string, { labelKey: I18nKey; placementToastKey: I18nKey }> = {
  '0': { labelKey: 'common.original', placementToastKey: 'role.center_placement' },
  '-1': { labelKey: 'common.left', placementToastKey: 'role.left_placement' },
  '1': { labelKey: 'common.right', placementToastKey: 'role.right_placement' },
  '2': { labelKey: 'common.woofer', placementToastKey: 'role.subwoofer_placement' },
};

const ROLE_CLOCK_SECOND_MS = 1000;
const ROLE_CLOCK_PULSE_ON_MS = 120;
const ROLE_CLOCK_PULSE_GAP_MS = 120;
const ROLE_CLOCK_SECOND_PULSE_START_MS = ROLE_CLOCK_PULSE_ON_MS + ROLE_CLOCK_PULSE_GAP_MS;
const ROLE_CLOCK_SECOND_PULSE_END_MS = ROLE_CLOCK_SECOND_PULSE_START_MS + ROLE_CLOCK_PULSE_ON_MS;
const ROLE_CLOCK_PULSE_TIMER = 'role-clock-pulse';
const ROLE_CLOCK_PULSE_RESET_TIMER = 'role-clock-pulse-reset';
let _ytPlayButtonLoading = false;
const _ytSyncLoadingOwners = new Set<YouTubeSyncLoadingOwner | 'legacy'>();
let _filePlayButtonLoading = false;
let _proPlaybackControlLoading = false;
let _proPlaybackTransitionLoading = false;
let _proPlaybackControlToken: number | null = null;
let _proPlaybackControlKind: ProPlaybackUiControlKind | null = null;
let _manualSyncPreviousFocus: HTMLElement | null = null;
let _mediaSourcePreviousFocus: HTMLElement | null = null;
let _youtubePopupPreviousFocus: HTMLElement | null = null;
let _playButtonMediaEnabled = false;
let _mainSyncPending = false;
let _mainSyncRequestToken = 0;

function isFilePlayButtonLoading(): boolean {
  const lifecycle = getState('playback.lifecycle');
  return (
    isProRoomTrackChangeIntentPending() ||
    lifecycle === PLAYBACK_STATE.DOWNLOADING ||
    lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD ||
    lifecycle === PLAYBACK_STATE.DECODING
  );
}

function syncPlayButtonLoadingClass(): void {
  const btn = document.getElementById('play-btn');
  const iframeOwnedLoading =
    _ytPlayButtonLoading || _proPlaybackControlLoading || _proPlaybackTransitionLoading;
  const loading = iframeOwnedLoading || _filePlayButtonLoading;
  if (btn) {
    btn.classList.toggle('yt-syncing', loading);
    btn.setAttribute('aria-busy', String(loading));
  }
  bus.emit('ui:play-loading-state', loading);

  const videoWrapper = document.querySelector<HTMLElement>('.video-wrapper');
  const youtubeContainer = document.getElementById('youtube-player-container');
  const overlay = document.getElementById('youtube-sync-loading-overlay');
  // File preparation never makes the YouTube iframe inert. The iframe shield
  // is owned only by YouTube and PRO transition feedback.
  const showYouTubeOverlay = iframeOwnedLoading && getState('playback.mode') === 'youtube';
  if (videoWrapper) videoWrapper.setAttribute('aria-busy', String(showYouTubeOverlay));
  if (youtubeContainer instanceof HTMLElement) {
    youtubeContainer.toggleAttribute('inert', showYouTubeOverlay);
  }
  if (overlay) {
    overlay.hidden = !showYouTubeOverlay;
    overlay.setAttribute('aria-hidden', String(!showYouTubeOverlay));
  }
}

function syncPlayButtonAuthority(): void {
  const btn = document.getElementById('play-btn');
  const context = getRoomContext();
  const roomAuthorityApplies = context.kind === 'pro' || getState('network.appRole') !== 'idle';
  const hasAuthority = !roomAuthorityApplies || hasRoomCapability('playback.control');
  const authorityMessage = roomCapabilityRequiredMessage('playback.control');
  if (btn) {
    btn.setAttribute('aria-disabled', String(!_playButtonMediaEnabled || !hasAuthority));
    if (!hasAuthority) btn.title = authorityMessage;
    else btn.removeAttribute('title');
  }
  for (const id of ['btn-prev', 'btn-next']) {
    const transportButton = document.getElementById(id);
    if (!transportButton) continue;
    transportButton.setAttribute('aria-disabled', String(!hasAuthority));
    if (!hasAuthority) transportButton.title = authorityMessage;
    else transportButton.removeAttribute('title');
  }
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
        : getTrackDisplayTitle(item, t('common.unknown'));

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

function getTabTitleTrack(): string {
  const item = getState('player.currentTrackMeta');
  if (!item) return '';

  return item.name === 'system-audio'
    ? t('system_audio.sharing')
    : item.name === 'system-audio-receiving'
      ? t('system_audio.receiving')
      : getTrackDisplayTitle(item);
}

function getTabTitlePlaying(): boolean | undefined {
  const mode = getState('playback.mode');
  const activity = getState('playback.activity');
  if (activity !== 'playing') return false;
  if (mode !== 'youtube') return true;

  const playerState = getYouTubePlayer()?.getPlayerState?.();
  if (playerState === 1) return true;
  if (playerState === 0 || playerState === 2) return false;

  // During iframe creation, background restoration, or BUFFERING, YouTube may
  // not expose a stable state. Preserve the last confirmed marquee state until
  // ui:update-play-state supplies the next authoritative transition.
  return undefined;
}

function getTabTitleSnapshot(): { track: string; playing?: boolean } {
  const playing = getTabTitlePlaying();

  return {
    track: getTabTitleTrack(),
    ...(playing === undefined ? {} : { playing }),
  };
}

function onVolInput(val: number): void {
  if (isSynchronizedVolumeLocked()) {
    syncVolumeSlider();
    return;
  }
  bus.emit('audio:set-volume', val / 100);
}

function onVolChange(val: number): void {
  if (isSynchronizedVolumeLocked()) {
    syncVolumeSlider();
    return;
  }
  showToast(t('common.volume_percent', { val: Math.round(val) }));
  if (isSettingsSyncEnabled() && canPublishSynchronizedSettings()) {
    bus.emit('settings-sync:publish-local');
  }
}

function toggleMute(): void {
  if (isSynchronizedVolumeLocked()) return;
  const masterVolume = getState('audio.masterVolume') ?? 1;
  if (masterVolume > 0) {
    _preMuteVolume = masterVolume;
    bus.emit('audio:set-volume', 0);
    showToast(t('common.muted'));
  } else {
    bus.emit('audio:set-volume', _preMuteVolume || 0.5);
    const newVol = _preMuteVolume || 0.5;
    showToast(t('common.volume_percent', { val: Math.round(newVol * 100) }));
  }
  if (isSettingsSyncEnabled() && canPublishSynchronizedSettings()) {
    bus.emit('settings-sync:publish-local');
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
  if (getRoomContext().kind === 'pro') return proRoomServerBridge.connected;
  const appRole = getState('network.appRole');
  if (appRole === 'host') return true;
  return !!getState('network.hostConn') && isClockCalibrated();
}

function getRoleClockNow(): number {
  return getRoomContext().kind === 'pro' ? getProRoomServerNow() : getHostNow();
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

  const roomNow = getRoleClockNow();
  const phase = ((roomNow % ROLE_CLOCK_SECOND_MS) + ROLE_CLOCK_SECOND_MS) % ROLE_CLOCK_SECOND_MS;

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

  const snapshot = getAccountSnapshot();
  const isAuthenticated = snapshot.status === 'authenticated' && snapshot.account !== null;
  const canOfferLogin = snapshot.status === 'anonymous' && snapshot.configured !== false;
  const nickname =
    isAuthenticated && snapshot.account.profileComplete ? snapshot.account.nickname.trim() : '';
  const roleLabel = getRoomContext().kind !== 'pro' && isCoordinator() ? 'HOST' : 'PEER';
  // Loading/unavailable is not an anonymous session verdict. Calling it LOGIN
  // during startup or a bounded account outage falsely tells an authenticated
  // room member that they were signed out, and obscures the fact that the
  // existing room identity remains leased while the read recovers.
  const displayText =
    nickname ||
    (isAuthenticated ? roleLabel : canOfferLogin ? 'LOGIN' : t('account.account_title'));

  badge.classList.remove('connected', 'remote', 'pro-equal', 'account-authenticated');
  badge.classList.toggle('account-authenticated', isAuthenticated);
  text.textContent = displayText;
  applyUserTextFontFallback(text, text.textContent);
  const accountLabel = isAuthenticated
    ? `${t('account.account_title')}: ${displayText}`
    : canOfferLogin
      ? t('account.login_title')
      : snapshot.status === 'loading'
        ? `${t('account.account_title')}: ${t('common.wait')}`
        : t('account.unavailable');
  badge.setAttribute('aria-label', accountLabel);
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

function rememberOverlayOpener(fallbackId: string): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  return document.getElementById(fallbackId);
}

function restoreOverlayOpener(opener: HTMLElement | null, overlay: HTMLElement): void {
  queueMicrotask(() => {
    const active = document.activeElement;
    if (
      opener?.isConnected &&
      (!active || active === document.body || active === overlay || overlay.contains(active))
    ) {
      opener.focus({ preventScroll: true });
    }
  });
}

function getOverlayFocusableElements(overlay: HTMLElement): HTMLElement[] {
  return Array.from(
    overlay.querySelectorAll<HTMLElement>(
      'button, input, textarea, select, a[href], [contenteditable="true"], [tabindex]',
    ),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute('disabled') &&
      !element.hidden &&
      element.getAttribute('aria-hidden') !== 'true',
  );
}

function handleFullscreenOverlayKeydown(
  overlay: HTMLElement,
  event: KeyboardEvent,
  onClose: () => void,
): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = getOverlayFocusableElements(overlay);
  if (focusable.length === 0) {
    event.preventDefault();
    overlay.focus({ preventScroll: true });
    return;
  }
  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
  const nextIndex = event.shiftKey
    ? currentIndex <= 0
      ? focusable.length - 1
      : currentIndex - 1
    : currentIndex < 0 || currentIndex === focusable.length - 1
      ? 0
      : currentIndex + 1;
  event.preventDefault();
  focusable[nextIndex]?.focus({ preventScroll: true });
}

function isKeyboardLikeActivation(event: Event): boolean {
  return !(event instanceof MouseEvent) || event.detail === 0;
}

function openMediaSourcePopup(focusFirstAction = true): void {
  if (!hasRoomCapability('media.add') && !hasRoomCapability('asset.upload')) {
    showRoomCapabilityRequired('media.add');
    return;
  }
  const systemAudioButton = document.getElementById('btn-system-audio');
  if (systemAudioButton) {
    systemAudioButton.hidden =
      !hasRoomCapability('system-audio.publish') ||
      !(isCoordinator() || getRoomContext().kind === 'pro');
  }
  _mediaSourcePreviousFocus = rememberOverlayOpener('btn-media-source');
  syncSystemAudioSourceButton();
  animateTransition(() => {
    const overlay = document.getElementById('media-source-overlay');
    if (overlay) {
      overlay.classList.add('active');
      syncOverlayState('media-source-overlay');
      setManagedTimer(
        'media-source-focus',
        () => {
          const focusTarget = focusFirstAction
            ? (getOverlayFocusableElements(overlay)[0] ?? overlay)
            : overlay;
          focusTarget.focus({ preventScroll: true });
        },
        0,
      );
    }
  });
}

function showProSystemAudioOwnerToast(): void {
  const view = getProSystemAudioViewState();
  const name = getProSystemAudioOwnerDisplayName();
  if (view.localRequestPending || (view.isLocalOwner && view.phase === 'preparing')) {
    showToast(t('system_audio.pro_preparing'));
  } else if (name && view.phase === 'preparing') {
    showToast(t('system_audio.owner_preparing', { name }));
  } else if (name && view.phase === 'live') {
    showToast(t('system_audio.owner_active', { name }));
  } else {
    showToast(t('system_audio.pro_publish_failed'));
  }
}

function syncSystemAudioSourceButton(): void {
  const button = document.getElementById('btn-system-audio') as HTMLButtonElement | null;
  if (!button) return;
  const label = button.querySelector<HTMLElement>('.media-source-label-text');
  const isProRoom = getRoomContext().kind === 'pro';
  const view = getProSystemAudioViewState();
  const pending = isProRoom && view.localRequestPending;
  button.disabled = pending;
  button.setAttribute('aria-busy', String(pending));
  if (!label) return;
  const key: I18nKey = pending ? 'system_audio.pro_preparing' : 'system_audio.button';
  label.textContent = t(key);
  label.setAttribute('data-i18n', key);
}

function syncMediaSourceButtonAuthority(): void {
  const canSelectMedia = hasRoomCapability('media.add') || hasRoomCapability('asset.upload');
  for (const id of ['btn-media-source', 'btn-add-media']) {
    const mediaBtn = document.getElementById(id);
    if (!mediaBtn) continue;
    const canStopSystemAudio =
      id === 'btn-media-source' &&
      isPlaybackModeSystemAudio() &&
      (getRoomContext().kind === 'pro'
        ? isLocalProSystemAudioOwner()
        : !getState('network.hostConn'));
    const enabled =
      id === 'btn-add-media'
        ? canSelectMedia
        : isPlaybackModeSystemAudio()
          ? canStopSystemAudio
          : canSelectMedia;
    mediaBtn.setAttribute('aria-disabled', String(!enabled));
    mediaBtn.style.opacity = enabled ? '' : '0.15';
    if (enabled) {
      mediaBtn.removeAttribute('title');
    } else {
      mediaBtn.title = isPlaybackModeSystemAudio()
        ? t('system_audio.sharing')
        : roomCapabilityRequiredMessage('media.add');
    }
  }
}

function canConfigureQueueMode(): boolean {
  return hasRoomCapability('queue.mutate');
}

function syncQueueModeButtonAuthority(): void {
  const enabled = canConfigureQueueMode();
  for (const id of ['btn-repeat', 'btn-shuffle']) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.setAttribute('aria-disabled', String(!enabled));
    button.style.opacity = enabled ? '' : '0.15';
  }
}

function closeMediaSourcePopup(restoreFocus = true): void {
  clearManagedTimer('media-source-focus');
  const returnFocus = _mediaSourcePreviousFocus;
  _mediaSourcePreviousFocus = null;
  animateTransition(() => {
    const overlay = document.getElementById('media-source-overlay');
    if (overlay) {
      overlay.classList.remove('active');
      syncOverlayState();
      if (restoreFocus) restoreOverlayOpener(returnFocus, overlay);
    }
  });
}

function openYouTubePopup(returnFocus?: HTMLElement | null): void {
  if (!hasRoomCapability('media.add')) {
    showRoomCapabilityRequired('media.add');
    return;
  }
  invalidateYouTubeGestureSubmit();
  _youtubePopupPreviousFocus =
    returnFocus ?? rememberOverlayOpener('btn-youtube-source') ?? _mediaSourcePreviousFocus;
  // This click is a second explicit iOS gesture after room setup. If the
  // eager primer was not ready for the setup tap (or its first bounce timed
  // out), retry it here before the user spends time entering a URL.
  primeYouTubePlayer();
  animateTransition(() => {
    const overlay = document.getElementById('youtube-url-overlay');
    if (overlay) {
      overlay.classList.add('active');
      syncOverlayState('youtube-url-overlay');
    }
    clearYouTubeInputState();
    const input = document.getElementById('youtube-url-input') as HTMLElement | null;
    if (input) setManagedTimer('yt-url-focus', () => input.focus(), 100);
  });
}

let youtubeGestureSubmitGeneration = 0;
let youtubeGestureSubmitOwner: number | null = null;

function invalidateYouTubeGestureSubmit(): void {
  youtubeGestureSubmitGeneration++;
  youtubeGestureSubmitOwner = null;
  document.getElementById('youtube-play-btn')?.removeAttribute('aria-busy');
}

function submitYouTubeSearch(input: HTMLElement): void {
  const searchButton = document.getElementById('youtube-search-btn') as HTMLButtonElement | null;
  if (!searchButton || searchButton.disabled) return;
  bus.emit('youtube:search-from-input');
  if (IS_IOS || IS_ANDROID) input.blur();
}

function submitYouTubeFromGesture(input: HTMLElement): void {
  if (youtubeGestureSubmitOwner !== null) return;

  // Non-iOS and already-primed clients stay in this synchronous branch, so a
  // concrete video load still runs in the original click/Enter call stack.
  // retryPending makes this FINAL gesture call playVideo() again instead of
  // merely waiting for an older popup-open attempt that may still time out.
  const mustWaitForPrimeProof = primeYouTubePlayer({ retryPending: true });
  if (!mustWaitForPrimeProof) {
    bus.emit('youtube:load-from-input');
    if (IS_IOS || IS_ANDROID) input.blur();
    return;
  }

  // If popup-open priming was still pending, or its timeout re-armed a retry,
  // spend this final gesture on the silent bounce first. Once PLAYING proves
  // WebKit accepted it, the resident iframe remains unlocked for the concrete
  // async load. A bounded failure simply falls through to the visible tap
  // fallback rather than trapping the submit action.
  const submitGeneration = ++youtubeGestureSubmitGeneration;
  youtubeGestureSubmitOwner = submitGeneration;
  const submittedText = input.textContent || '';
  const playButton = document.getElementById('youtube-play-btn') as HTMLButtonElement | null;
  if (playButton) {
    playButton.disabled = true;
    playButton.setAttribute('aria-busy', 'true');
  }

  void waitForPendingYouTubePrimeBounce(YOUTUBE_PRIME_BOUNCE_TIMEOUT_MS)
    .catch((error) => log.debug('[YouTube Prime] submit wait failed:', error))
    .then(() => {
      if (
        youtubeGestureSubmitGeneration !== submitGeneration ||
        youtubeGestureSubmitOwner !== submitGeneration
      ) {
        return;
      }
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay && !overlay.classList.contains('active')) return;
      if ((input.textContent || '') !== submittedText) return;
      bus.emit('youtube:load-from-input');
      if (IS_IOS || IS_ANDROID) input.blur();
    })
    .finally(() => {
      if (
        youtubeGestureSubmitGeneration !== submitGeneration ||
        youtubeGestureSubmitOwner !== submitGeneration
      ) {
        return;
      }
      youtubeGestureSubmitOwner = null;
      if (playButton?.isConnected) {
        playButton.removeAttribute('aria-busy');
        // A changed input owns its newer preview gate; only restore the exact
        // submission whose text is still present.
        if ((input.textContent || '') === submittedText) playButton.disabled = false;
      }
    });
}

function closeYouTubePopup(): void {
  invalidateYouTubeGestureSubmit();
  clearManagedTimer('yt-url-focus');
  clearPreviewDebounce();
  clearYouTubeInputState();
  const ytInput = document.getElementById('youtube-url-input');
  if (ytInput) ytInput.textContent = '';
  const returnFocus = _youtubePopupPreviousFocus;
  _youtubePopupPreviousFocus = null;
  animateTransition(() => {
    const overlay = document.getElementById('youtube-url-overlay');
    if (overlay) {
      overlay.classList.remove('active');
      syncOverlayState();
      restoreOverlayOpener(returnFocus, overlay);
    }
  });
}

// ─── File Selector ───────────────────────────────────────────────

function openFileSelector(): void {
  if (!hasRoomCapability('asset.upload')) {
    showRoomCapabilityRequired('asset.upload');
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
  if (!overlay) return;

  if (!overlay.classList.contains('show')) {
    _manualSyncPreviousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : document.getElementById('btn-sync');
  }

  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  syncOverlayState('manual-sync-overlay');
  setManagedTimer(
    'manual-sync-focus',
    () => {
      if (!overlay.classList.contains('show')) return;
      document.getElementById('btn-sync-done')?.focus();
    },
    0,
  );
}

function closeManualSyncOverlay(): void {
  const overlay = document.getElementById('manual-sync-overlay');
  if (!overlay) return;
  const wasShown = overlay.classList.contains('show');
  clearManagedTimer('manual-sync-focus');
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  syncOverlayState();

  const previousFocus = _manualSyncPreviousFocus;
  _manualSyncPreviousFocus = null;
  if (!wasShown) return;

  const fallback = document.getElementById('btn-sync');
  const target = previousFocus?.isConnected ? previousFocus : fallback;
  target?.focus();
}

function handleManualSyncOverlayKeydown(event: KeyboardEvent): void {
  const overlay = document.getElementById('manual-sync-overlay');
  if (!overlay?.classList.contains('show')) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeManualSyncOverlay();
    return;
  }

  if (event.key !== 'Tab') return;
  const focusables = Array.from(
    overlay.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
  if (focusables.length === 0) return;

  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey) {
    if (active === first || !overlay.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !overlay.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

function canUseManualSyncPanel(): boolean {
  const hostConn = getState('network.hostConn');
  const room = getRoomContext();
  const isProRoom = room.kind === 'pro';
  if (!hostConn?.open && !isProRoom && !isActiveStandardRoomCoordinator()) return false;
  if (isPlaybackModeSystemAudio()) return false;
  if (isPlaybackModeYouTube()) {
    if (!hostConn && !isProRoom && isActiveStandardRoomCoordinator()) return false;
    return !isYouTubeZeroStartProtocolActive();
  }
  return isPlaybackModeFile() && !!getCurrentAudioBuffer();
}

type MainSyncUnavailableReason = 'no-media' | 'not-ready' | 'system-audio';

function getMainSyncUnavailableReason(): MainSyncUnavailableReason | null {
  if (_mainSyncPending) return 'not-ready';
  if (isPlaybackModeSystemAudio()) return 'system-audio';
  if (isPlaybackModeYouTube() && isYouTubeZeroStartProtocolActive()) return 'not-ready';

  const hostConn = getState('network.hostConn');
  const room = getRoomContext();
  const isProRoom = room.kind === 'pro';
  const hasMedia = isPlaybackModeFile() || isPlaybackModeYouTube();
  if (!hasMedia) return hostConn ? 'not-ready' : 'no-media';
  if (hostConn && !hostConn.open) return 'not-ready';
  if (!hostConn && !isProRoom && !isActiveStandardRoomCoordinator()) return 'not-ready';

  if (isPlaybackModeFile()) {
    if (isFilePipelineBusyForPlay()) return 'not-ready';
    if (hostConn && !getCurrentAudioBuffer()) return 'not-ready';
    if (!hostConn && !isProRoom && (!getCurrentQueueItemId() || !getCurrentAudioBuffer())) {
      return 'not-ready';
    }
  }
  return null;
}

function getMainSyncUnavailableMessage(reason: MainSyncUnavailableReason): string {
  if (reason === 'system-audio') return t('toast.sync_not_in_system_audio');
  if (reason === 'no-media') return t('toast.sync_no_media');
  return t('toast.sync_not_ready');
}

function syncMainSyncButtonState(): void {
  const button = document.getElementById('btn-sync');
  if (!button) return;
  const reason = getMainSyncUnavailableReason();
  button.setAttribute('aria-disabled', String(reason !== null));
  button.setAttribute('aria-busy', String(_mainSyncPending));
  if (reason) {
    button.title = getMainSyncUnavailableMessage(reason).replace(/\n/g, ' ');
  } else {
    button.removeAttribute('title');
  }

  const label = button.querySelector<HTMLElement>('span');
  if (!label) return;
  const key: I18nKey = _mainSyncPending ? 'toast.yt_sync_start' : 'common.sync';
  label.textContent = t(key);
  label.setAttribute('data-i18n', key);
}

function beginMainSyncRequest(): number {
  _mainSyncRequestToken += 1;
  _mainSyncPending = true;
  syncMainSyncButtonState();
  return _mainSyncRequestToken;
}

function finishMainSyncRequest(token: number): void {
  if (token !== _mainSyncRequestToken) return;
  _mainSyncPending = false;
  syncMainSyncButtonState();
}

function handleMainSyncBtn(): void {
  // aria-disabled is advisory for custom-styled controls; synthetic clicks,
  // keyboard activation, and a state change between paint and dispatch can
  // still reach this handler. Re-evaluate the same predicate used to render
  // the button and fail closed with the matching user-facing reason.
  const unavailableReason = getMainSyncUnavailableReason();
  if (unavailableReason) {
    closeManualSyncOverlay();
    showToast(getMainSyncUnavailableMessage(unavailableReason));
    return;
  }

  if (_mainSyncPending) {
    showToast(t('toast.sync_not_ready'));
    return;
  }

  // System Audio sharing: nudge sync still not meaningful (WebRTC realtime stream)
  if (isPlaybackModeSystemAudio()) {
    showToast(t('toast.sync_not_in_system_audio'));
    return;
  }

  // Manual Sync publishes a new room rendezvous. Keep it fenced through the
  // post-release timeline calibration as well as iframe preparation: the
  // underlying broadcaster intentionally rejects while the protocol identity
  // is active, so enabling this surface earlier would create a bright no-op.
  if (isPlaybackModeYouTube() && isYouTubeZeroStartProtocolActive()) {
    closeManualSyncOverlay();
    showToast(t('toast.sync_not_ready'));
    return;
  }

  const hostConn = getState('network.hostConn');
  const room = getRoomContext();
  const isProRoom = room.kind === 'pro';
  if (!hostConn && !isPlaybackModeFile() && !isPlaybackModeYouTube()) {
    showToast(t('toast.sync_no_media'));
    return;
  }

  // Every PRO participant is a local playback endpoint, regardless of whether
  // it may issue room commands. Sync is therefore a participant-local server
  // reconciliation followed by a speaker nudge, never a command sent to
  // another browser.
  if (isProRoom) {
    const roomId = room.roomId;
    const requestToken = beginMainSyncRequest();
    void import('../pro-room/runtime.ts')
      .then(({ requestActiveProRoomPlaybackReconciliation }) =>
        requestActiveProRoomPlaybackReconciliation(),
      )
      .then((reconciled) => {
        const currentRoom = getRoomContext();
        if (currentRoom.kind !== 'pro' || currentRoom.roomId !== roomId) return;
        if (!reconciled) {
          showToast(t('toast.sync_not_ready'));
          return;
        }
        openManualSyncOverlay();
      })
      .catch((error) => {
        const currentRoom = getRoomContext();
        if (currentRoom.kind !== 'pro' || currentRoom.roomId !== roomId) return;
        log.warn('[PRO Playback] Manual synchronization failed', error);
        showToast(t('toast.sync_not_ready'));
      })
      .finally(() => {
        finishMainSyncRequest(requestToken);
      });
    return;
  }

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
    if (!getCurrentQueueItemId() || !getCurrentAudioBuffer()) {
      showToast(t('toast.sync_not_ready'));
      return;
    }
    // transport.ts keeps getTrackPosition() canonical while applying the
    // manual offset only to the local AudioBuffer source.
    openManualSyncOverlay();
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

    // A hard same-origin replacement clears in-memory media without leaving an
    // invite/PRO auto-join route behind in browser history.
    scheduleSessionReset(t('dialog.leaving_session'), navigateToAppHome);
  } finally {
    _logoNavBusy = false;
  }
}

// ─── Android Range Drag Guard ────────────────────────────────────

function installAndroidRangeScrollFix(signal: AbortSignal): void {
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
        if (prevOverflowY === null) return;
        scrollParent.style.overflowY = prevOverflowY;
        prevOverflowY = null;
      };

      range.addEventListener('touchstart', lock, { passive: true, signal });
      range.addEventListener('touchend', unlock, { passive: true, signal });
      range.addEventListener('touchcancel', unlock, { passive: true, signal });
      signal.addEventListener('abort', unlock, { once: true });
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

function syncVolumeAuthorityUI(): void {
  const locked = isSynchronizedVolumeLocked();
  const slider = document.getElementById('volume-slider') as HTMLInputElement | null;
  const mute = document.getElementById('vol-icon-btn') as HTMLButtonElement | null;
  if (slider) {
    slider.disabled = locked;
    slider.setAttribute('aria-disabled', locked ? 'true' : 'false');
  }
  if (mute) {
    mute.disabled = locked;
    mute.setAttribute('aria-disabled', locked ? 'true' : 'false');
  }
}

// ─── Module State ───────────────────────────────────────────────

// ─── Init ────────────────────────────────────────────────────────

const _busScope = createBusScope();
let _domAbort: AbortController | null = null;

export function initPlayerControls(): void {
  // Release prior-init subscriptions and replaceable DOM listeners so HMR /
  // future re-init paths don't stack duplicate handlers. Matches the pattern
  // in connect.ts and playlist-view.ts.
  _busScope.dispose();
  _domAbort?.abort();
  _domAbort = new AbortController();
  const { signal: domSignal } = _domAbort;
  _ytSyncLoadingOwners.clear();
  _ytPlayButtonLoading = false;
  _filePlayButtonLoading = false;
  _proPlaybackControlLoading = false;
  _proPlaybackTransitionLoading = false;
  _proPlaybackControlToken = null;
  _proPlaybackControlKind = null;
  _playButtonMediaEnabled =
    document.getElementById('play-btn')?.getAttribute('aria-disabled') === 'false';
  // Re-initialization must never inherit an interaction shield owned by a
  // disposed subscription scope.
  syncPlayButtonLoadingClass();
  initTabTitleMarquee(getTabTitleSnapshot);

  const $on = (id: string, evt: string, fn: EventListener) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn, { signal: domSignal });
  };

  // These overlay handlers are intentionally one-shot DOM bindings. Their
  // dataset guards must outlive the replaceable listener scope above.
  const manualSyncOverlay = document.getElementById('manual-sync-overlay');
  if (manualSyncOverlay && manualSyncOverlay.dataset.keyboardBound !== '1') {
    manualSyncOverlay.dataset.keyboardBound = '1';
    manualSyncOverlay.addEventListener('keydown', handleManualSyncOverlayKeydown);
  }

  const mediaSourceOverlay = document.getElementById('media-source-overlay');
  if (mediaSourceOverlay && mediaSourceOverlay.dataset.keyboardBound !== '1') {
    mediaSourceOverlay.dataset.keyboardBound = '1';
    mediaSourceOverlay.addEventListener('keydown', (event) => {
      handleFullscreenOverlayKeydown(mediaSourceOverlay, event, () => closeMediaSourcePopup());
    });
  }

  const youtubeUrlOverlay = document.getElementById('youtube-url-overlay');
  if (youtubeUrlOverlay && youtubeUrlOverlay.dataset.keyboardBound !== '1') {
    youtubeUrlOverlay.dataset.keyboardBound = '1';
    youtubeUrlOverlay.addEventListener('keydown', (event) => {
      handleFullscreenOverlayKeydown(youtubeUrlOverlay, event, () => closeYouTubePopup());
    });
  }

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
      // A native fullscreen request can reject after playback has already
      // advanced to a local file. Never let that late rejection resurrect the
      // YouTube-only fake fullscreen shell around non-YouTube playback.
      if (getState('playback.mode') !== 'youtube') return;
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
          target.requestFullscreen().then(() => {
            // A fullscreen request may settle after Next has already handed
            // playback to a local file. Teardown again now that the browser
            // has actually installed the fullscreen element.
            if (getState('playback.mode') !== 'youtube') exitYouTubeFullscreen();
          }, enterFake);
        } else if (target.webkitRequestFullscreen) {
          target.webkitRequestFullscreen();
          // webkit's call is sync and silent on failure — verify after a tick.
          setManagedTimer(
            'webkit-fullscreen-fallback',
            () => {
              if (getState('playback.mode') !== 'youtube') {
                exitYouTubeFullscreen();
                return;
              }
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
    roleBadge.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        openAccountDialog();
      },
      { signal: domSignal },
    );
  }

  // Logo — native <button>, so Enter/Space auto-fires click (no keydown handler needed)
  const logo = document.getElementById('app-logo') || document.querySelector('.app-logo');
  if (logo) {
    logo.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleLogoReturnToMain();
      },
      { signal: domSignal },
    );
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
  $on('btn-media-source', 'click', (event) => {
    if (isPlaybackModeSystemAudio()) {
      if (getRoomContext().kind === 'pro') {
        if (!isLocalProSystemAudioOwner()) {
          showProSystemAudioOwnerToast();
          return;
        }
      } else if (getState('network.hostConn')) {
        showRoomCapabilityRequired('system-audio.publish');
        return;
      }
      bus.emit('system-audio:stop');
    } else {
      openMediaSourcePopup(isKeyboardLikeActivation(event));
    }
  });

  // Playlist tab
  $on('btn-repeat', 'click', () => {
    if (!canConfigureQueueMode()) {
      showRoomCapabilityRequired('queue.mutate');
      return;
    }
    bus.emit('playlist:toggle-repeat');
  });
  $on('btn-shuffle', 'click', () => {
    if (!canConfigureQueueMode()) {
      showRoomCapabilityRequired('queue.mutate');
      return;
    }
    bus.emit('playlist:toggle-shuffle');
  });
  $on('btn-add-media', 'click', (event) => openMediaSourcePopup(isKeyboardLikeActivation(event)));

  // Media source popup
  $on('btn-local-file', 'click', () => openFileSelector());
  $on('btn-youtube-source', 'click', () => {
    const returnFocus = _mediaSourcePreviousFocus;
    closeMediaSourcePopup(false);
    openYouTubePopup(returnFocus);
  });
  $on('btn-system-audio', 'click', () => {
    const isProRoom = getRoomContext().kind === 'pro';
    if (!hasRoomCapability('system-audio.publish')) {
      showRoomCapabilityRequired('system-audio.publish');
      return;
    }
    if (!isProRoom && !isCoordinator()) {
      showRoomCapabilityRequired('system-audio.publish');
      return;
    }
    if (isProRoom) {
      const view = getProSystemAudioViewState();
      if (view.localRequestPending || (view.initialized && view.phase !== 'idle')) {
        showProSystemAudioOwnerToast();
        return;
      }
      if (!canPublishProSystemAudioWithCurrentCoordinator()) {
        showToast(t('system_audio.coordinator_update_required'));
        return;
      }
    }
    if (canCaptureSystemAudio()) {
      if (!isProRoom && !hasSystemAudioDeviceCapacity()) {
        showToast(t('system_audio.device_limit', { count: MAX_SYSTEM_AUDIO_DEVICES }));
        return;
      }
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
    ytInput.addEventListener(
      'input',
      (e) => {
        invalidateYouTubeGestureSubmit();
        // Stray-<br> placeholder restore — shared helper, see dom.ts.
        normalizeEmptyContentEditable(ytInput, e);
        const inputText = ytInput.textContent || '';
        applyUserTextFontFallback(ytInput, inputText);
        const searchButton = document.getElementById(
          'youtube-search-btn',
        ) as HTMLButtonElement | null;
        if (searchButton) {
          searchButton.disabled = getYouTubeInputIntent(inputText).kind !== 'search-query';
          searchButton.removeAttribute('aria-busy');
        }
        bus.emit('youtube:preview', inputText);
      },
      { signal: domSignal },
    );
    ytInput.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') {
          if (e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          const searchButton = document.getElementById(
            'youtube-search-btn',
          ) as HTMLButtonElement | null;
          if (searchButton && !searchButton.disabled) {
            submitYouTubeSearch(ytInput);
            return;
          }
          // URL preview deliberately keeps this button disabled while a
          // playlist manifest is being prefetched. A fast Enter press must
          // honor the same gate as a physical button click, otherwise iOS falls
          // back to the asynchronous iframe indexer and loses this gesture.
          const playButton = document.getElementById(
            'youtube-play-btn',
          ) as HTMLButtonElement | null;
          if (playButton?.disabled) return;
          submitYouTubeFromGesture(ytInput);
        }
      },
      { signal: domSignal },
    );
    ytInput.addEventListener(
      'paste',
      (e) => {
        e.preventDefault();
        const clipboard = (e as ClipboardEvent).clipboardData;
        const text =
          clipboard?.getData('text/plain') ||
          clipboard?.getData('text/uri-list') ||
          clipboard?.getData('URL') ||
          '';
        document.execCommand('insertText', false, text);
      },
      { signal: domSignal },
    );
  }
  $on('btn-yt-cancel', 'click', () => closeYouTubePopup());
  if (ytInput) {
    $on('youtube-search-btn', 'click', () => submitYouTubeSearch(ytInput));
    $on('youtube-play-btn', 'click', () => submitYouTubeFromGesture(ytInput));
  }

  // Seek bar
  initSeekBar(domSignal);

  // Range sliders use their own dataset-backed one-shot installation and must
  // remain live when the replaceable listener scope is aborted.
  installRangeDragGuard();

  syncVolumeSlider();
  syncVolumeAuthorityUI();

  // Prevent range drags from scrolling the containing tab on Android.
  installAndroidRangeScrollFix(domSignal);

  // Volume sync
  _busScope.on('audio:volume-changed', () => {
    syncVolumeSlider();
  });
  _busScope.on('settings-sync:changed', () => syncVolumeAuthorityUI());
  _busScope.on('state:network.standardRoomCapabilities', () => syncVolumeAuthorityUI());
  _busScope.on('state:room.context', () => syncVolumeAuthorityUI());
  _busScope.on('state:setup.sessionStarted', () => syncVolumeAuthorityUI());

  // Role badge update events
  _busScope.on('network:role-badge-update', () => {
    updateRoleBadge();
    syncVolumeAuthorityUI();
  });
  _busScope.on('state:network.myDeviceLabel', () => {
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

  document.addEventListener(
    'visibilitychange',
    () => {
      scheduleRoleClockPulse(true);
    },
    { signal: domSignal },
  );

  // Ordinary guests cannot select media, while every authenticated PRO
  // controller can. Derive the visual affordance from the same capability
  // guard as the click handler instead of the legacy host/guest topology.
  _busScope.on('state:network.hostConn', () => {
    syncMediaSourceButtonAuthority();
    syncPlayButtonAuthority();
    syncMainSyncButtonState();
  });
  _busScope.on('state:network.appRole', () => {
    updateRoleBadge();
    syncMediaSourceButtonAuthority();
    syncQueueModeButtonAuthority();
    syncPlayButtonAuthority();
    syncMainSyncButtonState();
  });
  _busScope.on('state:network.standardRoomCapabilities', () => {
    syncMediaSourceButtonAuthority();
    syncQueueModeButtonAuthority();
    syncPlayButtonAuthority();
  });
  _busScope.on('state:room.context', () => {
    updateRoleBadge();
    syncMediaSourceButtonAuthority();
    syncQueueModeButtonAuthority();
    syncPlayButtonAuthority();
    syncMainSyncButtonState();
  });
  updateRoleBadge();
  syncMediaSourceButtonAuthority();
  syncQueueModeButtonAuthority();
  syncPlayButtonAuthority();
  syncMainSyncButtonState();

  // Language switch → refresh translated track title + tab title
  // i18n:changed fires after DOM translation, so playback metadata wins over placeholders.
  const refreshPlayerText = () => {
    refreshTrackTitle();
    setTabTitleTrack(getTabTitleTrack());
    syncMediaSourceButtonAuthority();
    syncMainSyncButtonState();
  };
  _busScope.on('i18n:changed', refreshPlayerText);
  _busScope.on('ui:player-panel-visible', refreshPlayerText);

  // Peer disconnected: update UI
  _busScope.on('network:peer-disconnected', (peerId) => {
    log.info(`[UI] Peer disconnected: ${peerId}`);
    updateRoleBadge();
  });

  // Invite code container click delegation
  document.addEventListener(
    'click',
    (e) => {
      const target = (e.target as HTMLElement)?.closest?.('.invite-code-container');
      if (target) {
        e.preventDefault();
        copyInviteCode();
      }
    },
    { signal: domSignal },
  );

  // Invite code update events
  _busScope.on('ui:settings-tab-opened', () => {
    updateInviteCodeUI();
  });

  // File input handler
  const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
  if (fileInput) {
    fileInput.accept = AUDIO_FILE_ACCEPT;
    fileInput.addEventListener(
      'change',
      (e) => {
        closeMediaSourcePopup();
        bus.emit('app:files-selected', (e.target as HTMLInputElement).files);
        (e.target as HTMLInputElement).value = '';
      },
      { signal: domSignal },
    );
  }

  // Storage error handler (prevent silent error swallowing)
  _busScope.on('storage:error', (error, filename) => {
    log.error(`[Storage] Error for ${filename}:`, error);
    showToast(t('toast.file_save_error', { name: filename || t('common.unknown') }));
  });

  _busScope.on('storage:read-error', (data) => {
    const d = data as Record<string, unknown>;
    log.error('[Storage] Read error:', d?.filename, d?.error);
    showToast(t('toast.file_read_error', { name: String(d?.filename || t('common.unknown')) }));
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
  // (the empty-playlist hint) that real `disabled` would silence.
  _busScope.on('ui:play-btn-state', (enabled) => {
    // Media readiness and room authority change independently. Preserve the
    // former across an administrator grant/revoke, then project both into the
    // actual affordance so a room.context update cannot leave stale UI.
    _playButtonMediaEnabled = enabled;
    syncPlayButtonAuthority();
  });

  // Play/Pause visual state — derived from playback activity + YouTube play event
  function updatePlayIcon(playing: boolean): void {
    if (_proPlaybackControlKind === 'pause') {
      playing = false;
    }
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
      syncMainSyncButtonState();
      syncMediaSourceButtonAuthority();
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
        _ytSyncLoadingOwners.clear();
        _ytPlayButtonLoading = false;
      }
      // The composite loading state may outlive a mode boundary (notably a
      // PRO transition). Reconcile the iframe shield on every mode change so
      // it appears only while the active engine is YouTube.
      syncPlayButtonLoadingClass();

      // System audio: host gets "공유 중지", guest keeps "미디어 재생" (dimmed)
      const mediaBtn = document.getElementById('btn-media-source');
      const mediaBtnLabel = mediaBtn?.querySelector('span');
      const isGuest = !!getState('network.hostConn');
      const canStopSystemAudio =
        getRoomContext().kind === 'pro' ? isLocalProSystemAudioOwner() : !isGuest;
      if (mediaBtnLabel) {
        if (playback.mode === 'system-audio') {
          if (!canStopSystemAudio) {
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
            syncMediaSourceButtonAuthority();
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
  _busScope.on('youtube:sync-loading', (loading, owner) => {
    if (owner) {
      if (loading) _ytSyncLoadingOwners.add(owner);
      else _ytSyncLoadingOwners.delete(owner);
    } else if (loading) {
      _ytSyncLoadingOwners.add('legacy');
    } else {
      // An unscoped false is the teardown hard reset used by mode/session
      // owners that invalidate every outstanding synchronization operation.
      _ytSyncLoadingOwners.clear();
    }
    _ytPlayButtonLoading = _ytSyncLoadingOwners.size > 0;
    syncPlayButtonLoadingClass();
    // Keep readiness projection current across busy transitions. Manual Sync
    // remains disabled until the protocol itself reaches idle; onPhaseChange
    // emits the final readiness event for that later boundary.
    syncMainSyncButtonState();
  });

  // Coordinator-free PRO playback has a server-owned PREPARE barrier rather
  // than the legacy YouTube rendezvous. Reflect that shared wait on every
  // participant, including file transitions and devices that did not initiate
  // the selection themselves.
  _busScope.on('pro-playback:transition-loading', (loading) => {
    _proPlaybackTransitionLoading = !!loading;
    syncPlayButtonLoadingClass();
  });

  _busScope.on('pro-playback:ui-control-pending', (event) => {
    _proPlaybackControlToken = event.token;
    _proPlaybackControlKind = event.kind;
    _proPlaybackControlLoading =
      event.kind === 'play' || (event.kind === 'seek' && event.wasPlaying);
    if (event.kind === 'pause') updatePlayIcon(false);
    syncPlayButtonLoadingClass();
  });

  _busScope.on('pro-playback:ui-control-settled', (event) => {
    if (_proPlaybackControlToken !== event.token) return;
    _proPlaybackControlToken = null;
    _proPlaybackControlKind = null;
    _proPlaybackControlLoading = false;
    syncPlayButtonLoadingClass();

    if (event.status !== 'applied') {
      const mode = getState('playback.mode');
      const activity = getState('playback.activity');
      const playing =
        mode === 'youtube'
          ? getYouTubePlayer()?.getPlayerState?.() === 1
          : mode !== null && activity === 'playing';
      updatePlayIcon(playing);
    }
  });

  refreshFilePlayButtonLoading();
  _busScope.on('state:playback.lifecycle', () => {
    refreshFilePlayButtonLoading();
    syncMainSyncButtonState();
  });
  _busScope.on('state:network.pendingTrackChangeQueueItemId', () => {
    refreshFilePlayButtonLoading();
    syncMainSyncButtonState();
  });
  _busScope.on('state:network.hostConn', (hostConn) => {
    if (!hostConn && isProRoomTrackChangeIntentPending()) {
      clearProRoomTrackChangeIntent();
    }
  });
  _busScope.on('state:network.isOperator', (isOperator) => {
    if (!isOperator && isProRoomTrackChangeIntentPending()) {
      clearProRoomTrackChangeIntent();
    }
    // A standard-room ADMIN grant/revoke changes media-source capabilities
    // without changing hostConn or room.context.
    syncMediaSourceButtonAuthority();
    syncQueueModeButtonAuthority();
    syncPlayButtonAuthority();
  });
  _busScope.on('state:room.context', () => {
    const context = getState('room.context');
    if (
      isProRoomTrackChangeIntentPending() &&
      (context.kind !== 'pro' || context.role !== 'member')
    ) {
      clearProRoomTrackChangeIntent();
    }
    syncSystemAudioSourceButton();
    syncMediaSourceButtonAuthority();
    syncQueueModeButtonAuthority();
    syncMainSyncButtonState();
  });
  _busScope.on('pro-system-audio:state-changed', () => {
    syncSystemAudioSourceButton();
    syncMediaSourceButtonAuthority();
  });
  _busScope.on('state:playlist.items', () => {
    const pendingQueueItemId = getState('network.pendingTrackChangeQueueItemId');
    if (
      pendingQueueItemId &&
      !getState('playlist.items').some((item) => item.queueItemId === pendingQueueItemId)
    ) {
      clearProRoomTrackChangeIntent();
    }
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
  _busScope.on('sync:close-manual', closeManualSyncOverlay);

  const closeManualSyncIfInvalid = () => {
    const overlay = document.getElementById('manual-sync-overlay');
    if (!overlay?.classList.contains('show')) return;
    if (!canUseManualSyncPanel()) closeManualSyncOverlay();
  };
  const reconcileStandardRoomSyncAvailability = () => {
    closeManualSyncIfInvalid();
    // Standard-host readiness also depends on these two setup fields. During
    // reload recovery, restored playback can render first and room activation
    // can settle later; without repainting here aria-disabled/title stay stale
    // even though the click guard correctly sees an active coordinator.
    syncMainSyncButtonState();
  };
  _busScope.on('state:playback.mode', closeManualSyncIfInvalid);
  _busScope.on('state:playback.activity', closeManualSyncIfInvalid);
  _busScope.on('state:network.hostConn', closeManualSyncIfInvalid);
  _busScope.on('state:network.appRole', closeManualSyncIfInvalid);
  _busScope.on('state:room.context', closeManualSyncIfInvalid);
  _busScope.on('state:setup.sessionStarted', reconcileStandardRoomSyncAvailability);
  _busScope.on('state:network.sessionCode', reconcileStandardRoomSyncAvailability);
  _busScope.on('player:buffer-changed', () => {
    closeManualSyncIfInvalid();
    syncMainSyncButtonState();
  });
  _busScope.on('youtube:zero-start-readiness-changed', syncMainSyncButtonState);

  // YouTube time update — handled by seekbar.ts

  // ── Tab Title Marquee ───────────────────────────────────────────

  // Metadata can arrive before or after the remote playback state. Keeping
  // title and motion as independent inputs makes both event orders converge.
  setTabTitleTrack(getTabTitleTrack());
  _busScope.on('state:player.currentTrackMeta', () => {
    setTabTitleTrack(getTabTitleTrack());
  });

  scopePlaybackModeActivity(
    _busScope,
    () => {
      const playing = getTabTitlePlaying();
      if (playing !== undefined) setTabTitlePlaying(playing);
    },
    { immediate: true },
  );

  // YouTube pause/play doesn't change playback activity — handle via play-state event
  _busScope.on('ui:update-play-state', (playing) => {
    if (!isPlaybackModeYouTube()) return;
    setTabTitlePlaying(playing);
  });

  log.info('[PlayerControls] Initialized');
}
