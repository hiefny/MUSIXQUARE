/**
 * MUSIXQUARE 3.0 — Player Controls (UI)
 *
 * Manages: Play/pause/prev/next buttons, volume slider, seek bar,
 * mute toggle, role badge, media source popup, YouTube popup.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { APP_STATE, MSG } from '../core/constants.ts';
import { IS_ANDROID, canCaptureSystemAudio } from '../core/platform.ts';
import { setManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import type { I18nKey } from '../i18n/index.ts';
import { showToast } from './toast.ts';
import { showLoader, updateLoader } from './toast.ts';
import { switchTab } from './tabs.ts';
import { updateOverlayOpenClass, animateTransition, copyTextToClipboard, updateTitleWithMarquee } from './dom.ts';
import { showDialog } from './dialog.ts';
import { togglePlay } from '../player/transport.ts';
import { toggleRepeat, toggleShuffle } from '../player/playlist.ts';
import { clearPreviewDebounce } from '../youtube/search.ts';
import { initSeekBar } from './seekbar.ts';

// ─── Constants ───────────────────────────────────────────────────

const STANDARD_ROLE_MAP: Record<string, { labelKey: I18nKey; placementToastKey: I18nKey }> = {
  '0': { labelKey: 'common.original', placementToastKey: 'role.center_placement' },
  '-1': { labelKey: 'common.left', placementToastKey: 'role.left_placement' },
  '1': { labelKey: 'common.right', placementToastKey: 'role.right_placement' },
  '2': { labelKey: 'common.woofer', placementToastKey: 'role.center_placement' },
};

export function getRoleLabelByChannelMode(mode: number): string {
  return t((STANDARD_ROLE_MAP[String(mode)] || STANDARD_ROLE_MAP['0']).labelKey);
}

export function getStandardRolePreset(mode: number): { labelKey: I18nKey; placementToastKey: I18nKey } {
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
  const path = icon.querySelector('path');
  if (!path) return;

  const vol = getState('audio.masterVolume') ?? 1;
  if (vol === 0) {
    path.setAttribute('d', 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z');
  } else {
    path.setAttribute('d', 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z');
  }
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
  let title = item.name === 'system-audio'
    ? t('system_audio.sharing')
    : item.name === 'system-audio-receiving'
      ? t('system_audio.receiving')
      : (item.title || item.name || t('common.unknown'));

  // Remote Guest + Local File + No Blob = Show Wi-Fi Warning instead of real title
  const isRemote = getState('network.connectionType') === 'remote';
  const isLocalFile = item.type === 'file';
  const hasNoBlob = !getState('files.currentFileBlob');
  const isGuest = !!getState('network.hostConn');

  if (isGuest && isRemote && isLocalFile && hasNoBlob) {
    title = t('toast.same_wifi_file_title');
  }

  updateTitleWithMarquee(title);

  // Also update Artist
  const artistEl = document.getElementById('track-artist');
  if (artistEl) {
    if (item.artist) {
      artistEl.innerText = item.artist;
    } else {
      const idx = getState('playlist.currentTrackIndex');
      artistEl.innerText = (item.type === 'youtube') ? t('common.youtube_video') : t('playlist.track_fallback', { idx: idx + 1 });
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

export function updateRoleBadge(): void {
  const badge = document.getElementById('role-badge');
  const text = document.getElementById('role-text');
  if (!badge || !text) return;

  badge.classList.remove('connected', 'remote');

  const isConnecting = getState('network.isConnecting');
  if (isConnecting) {
    text.innerText = 'CONNECTING';
    return;
  }

  const hostConn = getState('network.hostConn');
  if (hostConn) {
    const myDeviceLabel = getState('network.myDeviceLabel') || '';
    const label = myDeviceLabel.trim() || 'PEER';
    const latency = getState('sync.lastLatencyMs') || 0;
    text.innerHTML = `${label} <span class="badge-ping">(${latency}ms)</span>`;
    badge.classList.add('connected');
    if (getState('network.connectionType') === 'remote') {
      badge.classList.add('remote');
    }
    return;
  }

  const appRole = getState('network.appRole');
  if (appRole === 'host') {
    text.innerText = 'HOST';
    badge.classList.add('connected');
    return;
  }

  if (appRole === 'guest') {
    text.innerText = 'GUEST';
    return;
  }

  text.innerText = 'SETUP';
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
  elements.forEach(el => {
    el.textContent = code;
    el.setAttribute('data-code', code);
  });
}

function getConnectedDeviceCount(): number {
  const lastKnownDeviceList = getState('network.lastKnownDeviceList');
  if (Array.isArray(lastKnownDeviceList) && lastKnownDeviceList.length) {
    return lastKnownDeviceList.filter(d => d && d.status === 'connected').length;
  }
  const connectedPeers = getState('network.connectedPeers');
  const hostConn = getState('network.hostConn');
  const appRole = getState('network.appRole');
  const sessionStarted = getState('setup.sessionStarted');
  const peerConnected = Array.isArray(connectedPeers) ? connectedPeers.filter(p => p && p.status === 'connected').length : 0;
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
    document.querySelectorAll('.invite-code-value').forEach(el => {
      el.classList.add('copied');
      setManagedTimer('copied-feedback', () => {
        document.querySelectorAll('.invite-code-value').forEach(e => e.classList.remove('copied'));
      }, 600);
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
    const input = document.getElementById('youtube-url-input') as HTMLElement | null;
    if (input) setManagedTimer('yt-url-focus', () => input.focus(), 100);
  });
}

function closeYouTubePopup(): void {
  clearPreviewDebounce();
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

let _syncCooldownUntil = 0;

function handleMainSyncBtn(): void {
  // Debounce: ignore rapid taps (3s cooldown)
  const now = Date.now();
  if (now < _syncCooldownUntil) return;
  _syncCooldownUntil = now + 3000;

  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_SYSTEM_AUDIO) {
    showToast(t('system_audio.no_precision_sync'));
    return;
  }

  const hostConn = getState('network.hostConn');

  // YouTube mode: host-only precision sync, guest blocked
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    if (hostConn) {
      showToast(t('youtube.no_precision_sync'));
      return;
    }
    bus.emit('youtube:precision-sync');
    return;
  }

  // File mode: host broadcasts resync, guest auto-syncs
  if (!hostConn) {
    showToast(t('toast.resync_all'));
    bus.emit('network:broadcast', { type: MSG.GLOBAL_RESYNC_REQUEST });
  } else {
    bus.emit('sync:auto-sync');
  }
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
    setTimeout(() => window.location.reload(), 300);
  } finally {
    _logoNavBusy = false;
  }
}

// ─── Android Range Scroll Fix ────────────────────────────────────

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
        scrollParent.style.overflowY = (prevOverflowY !== null) ? prevOverflowY : '';
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

// ─── Seek Bar (extracted to src/ui/seekbar.ts) ──────────────────

// ─── Volume Sync ─────────────────────────────────────────────────

function syncVolumeSlider(): void {
  const vol = getState('audio.masterVolume') ?? 1;
  const vSlider = document.getElementById('volume-slider') as HTMLInputElement | null;
  if (vSlider) vSlider.value = String(vol * 100);
  updateVolumeIcon();
}

// ─── Init ────────────────────────────────────────────────────────

export function initPlayerControls(): void {
  const $on = (id: string, evt: string, fn: EventListener) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  };

  // Header
  $on('btn-help', 'click', () => switchTab('guide'));
  $on('btn-fullscreen', 'click', () => {
    try {
      const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      const videoWrapper = document.querySelector('.video-wrapper') as HTMLElement & { webkitRequestFullscreen?: () => void } | null;
      const target = videoWrapper || el;

      const isFullscreen = !!(document.fullscreenElement || doc.webkitFullscreenElement);
      if (!isFullscreen) {
        if (target.requestFullscreen) target.requestFullscreen();
        else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      }
    } catch { /* ignore */ }
  });

  // Role badge
  const roleBadge = document.getElementById('role-badge');
  if (roleBadge) {
    roleBadge.setAttribute('role', 'button');
    roleBadge.setAttribute('tabindex', '0');
    const onShowCode = async (e?: Event) => {
      try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch { /* ignore */ }
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

  // Logo
  const logo = document.getElementById('app-logo') || document.querySelector('.app-logo');
  if (logo) {
    logo.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleLogoReturnToMain();
    });
    logo.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter' && (e as KeyboardEvent).key !== ' ') return;
      e.preventDefault();
      handleLogoReturnToMain();
    });
  }

  // Player buttons
  $on('btn-prev', 'click', () => bus.emit('playlist:prev-track'));
  $on('play-btn', 'click', () => bus.emit('player:toggle-play'));
  $on('btn-next', 'click', () => bus.emit('playlist:next-track'));
  $on('vol-icon-btn', 'click', () => toggleMute());
  $on('vol-icon-btn', 'keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Enter' && (e as KeyboardEvent).key !== ' ') return;
    (e as KeyboardEvent).preventDefault();
    toggleMute();
  });
  $on('volume-slider', 'input', function (this: HTMLInputElement) { onVolInput(Number(this.value)); });
  $on('volume-slider', 'change', function (this: HTMLInputElement) { onVolChange(Number(this.value)); });
  $on('btn-sync', 'click', () => handleMainSyncBtn());
  $on('btn-media-source', 'click', () => {
    if (getState('appState') === APP_STATE.PLAYING_SYSTEM_AUDIO) {
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
  $on('btn-youtube-source', 'click', () => { closeMediaSourcePopup(); openYouTubePopup(); });
  $on('btn-system-audio', 'click', () => {
    if (canCaptureSystemAudio()) {
      closeMediaSourcePopup();
      bus.emit('system-audio:start');
    } else {
      showToast(t('system_audio.desktop_only'));
    }
  });
  $on('btn-close-media-popup', 'click', () => closeMediaSourcePopup());

  // Demo button (Help tab — desktop + mobile)
  $on('btn-demo-media', 'click', () => { bus.emit('app:load-demo'); });
  $on('btn-demo-media-mobile', 'click', () => { bus.emit('app:load-demo'); });

  // YouTube popup (contenteditable)
  const ytInput = document.getElementById('youtube-url-input');
  if (ytInput) {
    ytInput.addEventListener('input', () => { bus.emit('youtube:preview', ytInput.textContent || ''); });
    ytInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); bus.emit('youtube:load-from-input'); }
    });
    ytInput.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') || '';
      document.execCommand('insertText', false, text);
    });
  }
  $on('btn-yt-cancel', 'click', () => closeYouTubePopup());
  $on('youtube-play-btn', 'click', () => bus.emit('youtube:load-from-input'));

  // Seek bar
  initSeekBar();

  // Android fix
  installAndroidRangeScrollFix();

  // Volume sync
  bus.on('audio:volume-changed', () => {
    syncVolumeSlider();
  });

  // Role badge update events
  bus.on('network:role-badge-update', () => {
    updateRoleBadge();
  });

  // Latency update → refresh role badge to show latency value
  bus.on('sync:latency-update', () => {
    updateRoleBadge();
  });

  // Connection type updated (e.g. ICE resolved) → Re-trigger title update to check for Wi-Fi warning
  bus.on('state:network.connectionType', () => {
    refreshTrackTitle();
  });

  // Guest: dim media source button (host-only action)
  bus.on('state:network.hostConn', () => {
    const mediaBtn = document.getElementById('btn-media-source');
    if (mediaBtn) {
      mediaBtn.style.opacity = getState('network.hostConn') ? '0.15' : '';
    }
  });

  // Language switch → refresh translated track title + tab title
  new MutationObserver(() => {
    refreshTrackTitle();
    const item = getState('player.currentTrackMeta');
    if (item) {
      _tabTitleTrack = item.name === 'system-audio'
        ? t('system_audio.sharing')
        : item.name === 'system-audio-receiving'
          ? t('system_audio.receiving')
          : (item.title || item.name || '');
    }
  }).observe(document.documentElement, { attributeFilter: ['lang'] });

  // Peer disconnected: update UI
  bus.on('network:peer-disconnected', (peerId) => {
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
  bus.on('ui:settings-tab-opened', () => {
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

  // OPFS error handler (prevent silent error swallowing)
  bus.on('opfs:error', (error, filename) => {
    log.error(`[OPFS] Error for ${filename}:`, error);
    showToast(t('toast.file_save_error', { name: filename || 'unknown' }));
  });

  bus.on('opfs:read-error', (data) => {
    const d = data as Record<string, unknown>;
    log.error('[OPFS] Read error:', d?.filename, d?.error);
    showToast(t('toast.file_read_error', { name: String(d?.filename || 'unknown') }));
  });

  bus.on('opfs:session-mismatch', (data) => {
    const d = data as Record<string, unknown>;
    log.warn('[OPFS] Session mismatch:', d?.filename);
    showToast(t('toast.session_mismatch'));
  });

  // ── Bus Event Bridge ──────────────────────────────────────────

  // Toast
  bus.on('ui:show-toast', (message) => {
    showToast(message);
  });

  // Loader
  bus.on('ui:show-loader', (visible, label) => {
    showLoader(visible, label);
  });

  bus.on('ui:update-loader', (percent) => {
    updateLoader(percent);
  });

  // Play button state (enabled/disabled)
  bus.on('ui:play-btn-state', (enabled) => {
    const btn = document.getElementById('play-btn');
    if (btn) {
      (btn as HTMLButtonElement).disabled = !enabled;
      btn.style.opacity = enabled ? '1' : '0.4';
    }
  });

  // Play/Pause visual state — derived from appState + YouTube play event
  function updatePlayIcon(playing: boolean): void {
    const btn = document.getElementById('play-btn');
    const icon = btn?.querySelector('path');
    if (icon) {
      icon.setAttribute('d', playing
        ? 'M6 19h4V5H6v14zm8-14v14h4V5h-4z'  // pause icon
        : 'M8 5v14l11-7z');                    // play icon
    }
  }

  bus.on('state:appState', () => {
    const state = getState('appState');
    const playing = state === APP_STATE.PLAYING_AUDIO || state === APP_STATE.PLAYING_VIDEO || state === APP_STATE.PLAYING_YOUTUBE || state === APP_STATE.PLAYING_SYSTEM_AUDIO;
    updatePlayIcon(playing);

    // System audio: host gets "공유 중지", guest keeps "미디어 재생" (dimmed)
    const mediaBtn = document.getElementById('btn-media-source');
    const mediaBtnLabel = mediaBtn?.querySelector('span');
    const isGuest = !!getState('network.hostConn');
    if (mediaBtnLabel) {
      if (state === APP_STATE.PLAYING_SYSTEM_AUDIO) {
        if (isGuest) {
          // Guest: keep original label + color (opacity already set by hostConn listener)
          if (mediaBtn) mediaBtn.classList.add('sys-audio-guest');
        } else {
          // Host: show stop button
          mediaBtnLabel.textContent = t('system_audio.stop');
          mediaBtnLabel.removeAttribute('data-i18n');
        }
      } else {
        if (!mediaBtnLabel.getAttribute('data-i18n')) {
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
  });

  // YouTube pause/play doesn't change appState — still need this event
  bus.on('ui:update-play-state', (playing) => {
    if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) {
      updatePlayIcon(playing);
    }
  });

  // Player actions
  bus.on('player:toggle-play', () => {
    togglePlay();
  });

  // Playlist actions
  bus.on('playlist:toggle-repeat', () => {
    toggleRepeat();
  });

  bus.on('playlist:toggle-shuffle', () => {
    toggleShuffle();
  });

  // Metadata update (track title in player UI)
  bus.on('state:player.currentTrackMeta', () => {
    refreshTrackTitle();
  });

  // Sync display update (manual-sync-value element)
  bus.on('sync:display-update', () => {
    const localOffset = getState('sync.localOffset') || 0;
    const autoSyncOffset = getState('sync.autoSyncOffset') || 0;
    const total = localOffset + autoSyncOffset;
    const el = document.getElementById('manual-sync-value');
    if (el) el.innerText = `${total >= 0 ? '+' : ''}${(total * 1000).toFixed(0)}ms`;
  });

  // YouTube time update — handled by seekbar.ts

  // ── Tab Title Marquee ───────────────────────────────────────────

  const DEFAULT_TITLE = 'MUSIXQUARE - 뮤직스퀘어';
  const MARQUEE_PAUSE_START = 3; // 3s pause at start
  const MARQUEE_PAUSE_END = 1;   // 1s pause at end
  let _tabTitleTrack = '';
  let _tabTitleInterval: ReturnType<typeof setInterval> | null = null;

  function startTabTitleMarquee(): void {
    if (_tabTitleInterval) return;

    let scrollPos = 0;
    let startPause = 0;
    let endPause = 0;

    _tabTitleInterval = setInterval(() => {
      const state = getState('appState');
      if (state === APP_STATE.IDLE) {
        stopTabTitleMarquee();
        return;
      }

      const name = _tabTitleTrack || 'MUSIXQUARE';
      if (state === APP_STATE.PAUSED) {
        stopTabTitleMarquee();
        document.title = `${name} | MUSIXQUARE`;
        return;
      }

      const suffix = ' | MUSIXQUARE';
      const full = name + suffix;

      // Phase 1: start pause (3s)
      if (scrollPos === 0 && startPause < MARQUEE_PAUSE_START) {
        document.title = full;
        startPause++;
        return;
      }

      // Phase 3: end pause (1s)
      const maxScroll = name.length + 3; // " | " length
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
    }, 1000);
  }

  function stopTabTitleMarquee(): void {
    if (_tabTitleInterval) {
      clearInterval(_tabTitleInterval);
      _tabTitleInterval = null;
    }
    document.title = _tabTitleTrack
      ? `${_tabTitleTrack} | MUSIXQUARE`
      : DEFAULT_TITLE;
  }

  bus.on('state:player.currentTrackMeta', () => {
    const item = getState('player.currentTrackMeta');
    if (item) {
      _tabTitleTrack = item.name === 'system-audio'
        ? t('system_audio.sharing')
        : item.name === 'system-audio-receiving'
          ? t('system_audio.receiving')
          : (item.title || item.name || '');
    } else {
      _tabTitleTrack = '';
      document.title = DEFAULT_TITLE;
    }
  });

  bus.on('state:appState', () => {
    const state = getState('appState');
    if (state === APP_STATE.PLAYING_AUDIO || state === APP_STATE.PLAYING_VIDEO || state === APP_STATE.PLAYING_YOUTUBE || state === APP_STATE.PLAYING_SYSTEM_AUDIO) {
      startTabTitleMarquee();
    } else {
      stopTabTitleMarquee();
    }
  });

  // YouTube pause/play doesn't change appState — handle via play-state event
  bus.on('ui:update-play-state', (playing) => {
    if (getState('appState') !== APP_STATE.PLAYING_YOUTUBE) return;
    if (playing) {
      startTabTitleMarquee();
    } else {
      stopTabTitleMarquee();
      const name = _tabTitleTrack || 'MUSIXQUARE';
      document.title = `${name} | MUSIXQUARE`;
    }
  });

  log.info('[PlayerControls] Initialized');
}
