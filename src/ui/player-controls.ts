/**
 * MUSIXQUARE 2.0 — Player Controls (UI)
 * Extracted from original app.js lines 3090-3375, 5642-5710
 *
 * Manages: Play/pause/prev/next buttons, volume slider, seek bar,
 * mute toggle, role badge, media source popup, YouTube popup.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE, MSG } from '../core/constants.ts';
import { IS_ANDROID } from '../core/platform.ts';
import { showToast } from './toast.ts';
import { showLoader, updateLoader } from './toast.ts';
import { switchTab } from './tabs.ts';
import { updateOverlayOpenClass, animateTransition, copyTextToClipboard, updateTitleWithMarquee } from './dom.ts';
import { showDialog } from './dialog.ts';
import { fmtTime, getTrackPosition, togglePlay, play, skipTime } from '../player/playback.ts';
import { playNextTrack, playPrevTrack, toggleRepeat, toggleShuffle } from '../player/playlist.ts';
import { isIdleOrPaused } from '../player/video.ts';
import { broadcast } from '../network/peer.ts';
import { requestGlobalResyncDelayed } from '../network/sync.ts';
import type { DataConnection, PlaylistItem } from '../types/index.ts';

// ─── Constants ───────────────────────────────────────────────────

const STANDARD_ROLE_MAP: Record<string, { label: string; placementToast: string }> = {
  '0': { label: 'Original', placementToast: '기기를 중앙에 놓아주세요' },
  '-1': { label: 'Left', placementToast: '기기를 왼쪽에 놓아주세요' },
  '1': { label: 'Right', placementToast: '기기를 오른쪽에 놓아주세요' },
  '2': { label: 'Woofer', placementToast: '기기를 중앙에 놓아주세요' },
};

export function getRoleLabelByChannelMode(mode: number): string {
  return (STANDARD_ROLE_MAP[String(mode)] || STANDARD_ROLE_MAP['0']).label;
}

export function getStandardRolePreset(mode: number): { label: string; placementToast: string } {
  return STANDARD_ROLE_MAP[String(mode)] || STANDARD_ROLE_MAP['0'];
}

export function showPlacementToastForChannel(mode: number): void {
  showToast(getStandardRolePreset(mode).placementToast);
}

// ─── Volume ──────────────────────────────────────────────────────

let _preMuteVolume = 0.5;

function updateVolumeIcon(): void {
  const icon = document.getElementById('vol-icon-btn');
  if (!icon) return;
  const path = icon.querySelector('path');
  if (!path) return;

  const vol = getState<number>('audio.masterVolume') ?? 1;
  if (vol === 0) {
    path.setAttribute('d', 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z');
  } else {
    path.setAttribute('d', 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z');
  }
}

function onVolInput(val: number): void {
  bus.emit('audio:set-volume', val / 100);
}

function onVolChange(val: number): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (!hostConn) {
    bus.emit('network:broadcast', { type: MSG.VOLUME, value: val / 100 });
    showToast(`Volume: ${Math.round(val)}%`);
  }
}

function toggleMute(): void {
  const masterVolume = getState<number>('audio.masterVolume') ?? 1;
  if (masterVolume > 0) {
    _preMuteVolume = masterVolume;
    bus.emit('audio:set-volume', 0);
    showToast('Muted');
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (!hostConn) bus.emit('network:broadcast', { type: MSG.VOLUME, value: 0 });
  } else {
    bus.emit('audio:set-volume', _preMuteVolume || 0.5);
    const newVol = _preMuteVolume || 0.5;
    showToast(`Volume: ${Math.round(newVol * 100)}%`);
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (!hostConn) bus.emit('network:broadcast', { type: MSG.VOLUME, value: newVol });
  }
}

// ─── Role Badge ──────────────────────────────────────────────────

export function updateRoleBadge(): void {
  const badge = document.getElementById('role-badge');
  const text = document.getElementById('role-text');
  if (!badge || !text) return;

  badge.classList.remove('connected');

  const isConnecting = getState<boolean>('network.isConnecting');
  if (isConnecting) {
    text.innerText = '연결 중...';
    return;
  }

  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) {
    const lastLatencyMs = getState<number>('sync.lastLatencyMs');
    const latencyTxt = (lastLatencyMs && Number.isFinite(lastLatencyMs)) ? ` (${Math.round(lastLatencyMs)}ms)` : '';
    const myDeviceLabel = getState<string>('network.myDeviceLabel') || '';
    const label = myDeviceLabel.trim() || 'Peer';
    text.innerText = `${label}${latencyTxt}`;
    badge.classList.add('connected');
    return;
  }

  const appRole = getState<string>('network.appRole');
  if (appRole === 'host') {
    text.innerText = 'Host';
    badge.classList.add('connected');
    return;
  }

  if (appRole === 'guest') {
    text.innerText = 'Guest';
    return;
  }

  text.innerText = 'SETUP';
}

// ─── Invite Code ─────────────────────────────────────────────────

export function getInviteCode(): string {
  const sessionCode = getState<string>('network.sessionCode') || '';
  const lastJoinCode = getState<string>('network.lastJoinCode') || '';
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
  const lastKnownDeviceList = getState<Array<Record<string, unknown>>>('network.lastKnownDeviceList');
  if (Array.isArray(lastKnownDeviceList) && lastKnownDeviceList.length) {
    return lastKnownDeviceList.filter(d => d && d.status === 'connected').length;
  }
  const connectedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
  const hostConn = getState<DataConnection | null>('network.hostConn');
  const appRole = getState<string>('network.appRole');
  const sessionStarted = getState<boolean>('setup.sessionStarted');
  const peerConnected = connectedPeers.filter(p => p && p.status === 'connected').length;
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
    showToast(`연결된 기기 ${cnt}대 | 초대 코드 ${code}`);
    document.querySelectorAll('.invite-code-value').forEach(el => {
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1000);
    });
  } else {
    showToast('복사하지 못했어요');
  }
}

// ─── Media Source Popup ──────────────────────────────────────────

function openMediaSourcePopup(): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) {
    showToast('방장만 미디어를 추가할 수 있어요.');
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
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) {
    showToast('방장만 유튜브 링크를 추가할 수 있어요.');
    return;
  }
  animateTransition(() => {
    const overlay = document.getElementById('youtube-url-overlay');
    if (overlay) {
      overlay.classList.add('active');
      updateOverlayOpenClass();
    }
    const input = document.getElementById('youtube-url-input') as HTMLInputElement | null;
    if (input) setTimeout(() => input.focus(), 100);
  });
}

function closeYouTubePopup(): void {
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
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) {
    showToast('Host만 실행할 수 있습니다.');
    return;
  }
  const input = document.getElementById('file-input') as HTMLInputElement | null;
  if (!input) {
    log.warn('[UI] #file-input not found');
    showToast('파일을 선택할 수 없어요');
    return;
  }
  input.click();
}

// ─── Sync Button ─────────────────────────────────────────────────

function handleMainSyncBtn(): void {
  const currentState = getState<string>('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    showToast('YouTube 모드에서는 정밀 동기화를 지원하지 않아요');
    return;
  }

  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (!hostConn) {
    showToast('모든 기기 재동기화 요청...');
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

    const hostConn = getState<DataConnection | null>('network.hostConn');
    const appRole = getState<string>('network.appRole');
    const hasSession = !!(hostConn || appRole === 'host');
    if (hasSession) {
      const res = await showDialog({
        title: '초기 화면',
        message: '초기 화면으로 돌아갈까요?\n현재 세션과 연결이 끊어져요.',
        buttonText: '확인',
        secondaryText: '남아있기',
        defaultFocus: 'secondary',
      });
      if (res.action !== 'ok') return;
    }

    bus.emit('app:return-to-main');
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

// ─── Seek Bar ────────────────────────────────────────────────────

function initSeekBar(): void {
  const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
  if (!slider) {
    log.warn('[UI] #seek-slider not found');
    return;
  }

  slider.addEventListener('mousedown', () => setState('player.isSeeking', true));
  slider.addEventListener('touchstart', () => setState('player.isSeeking', true));
  slider.addEventListener('input', () => {
    const tc = document.getElementById('time-curr');
    if (tc) tc.innerText = fmtTime(parseFloat(slider.value));
  });

  slider.addEventListener('change', () => {
    setState('player.isSeeking', false);
    const t = parseFloat(slider.value);

    const hostConn = getState<DataConnection | null>('network.hostConn');
    const isOperator = getState<boolean>('network.isOperator');

    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return;

    // OP: request Host to seek
    if (hostConn && isOperator) {
      hostConn.send({ type: MSG.REQUEST_SEEK, time: t });
      return;
    }

    // YouTube mode: seek via YouTube API
    const currentState = getState<string>('appState');
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
      bus.emit('youtube:seek-to', t);
      return;
    }

    // Host: execute directly (playing or paused)
    if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
      bus.emit('player:seek', t);
    } else {
      // Paused state: just update position
      bus.emit('player:seek-to-time', t);
    }
  });

  slider.addEventListener('mouseup', () => setState('player.isSeeking', false));
  slider.addEventListener('touchend', () => setState('player.isSeeking', false));
}

// ─── Volume Sync ─────────────────────────────────────────────────

function syncVolumeSlider(): void {
  const vol = getState<number>('audio.masterVolume') ?? 1;
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
        showToast('초대 코드가 아직 없어요');
        return;
      }
      const ok = await copyTextToClipboard(code);
      if (ok) {
        const cnt = getConnectedDeviceCount();
        showToast(`연결된 기기 ${cnt}대 | 초대 코드 ${code}`);
      } else {
        showToast(`초대 코드: ${code}`);
      }
    };
    roleBadge.addEventListener('click', onShowCode);
    roleBadge.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter' && (e as KeyboardEvent).key !== ' ') return;
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
  $on('volume-slider', 'input', function (this: HTMLInputElement) { onVolInput(Number(this.value)); });
  $on('volume-slider', 'change', function (this: HTMLInputElement) { onVolChange(Number(this.value)); });
  $on('btn-sync', 'click', () => handleMainSyncBtn());
  $on('btn-media-source', 'click', () => openMediaSourcePopup());

  // Playlist tab
  $on('btn-repeat', 'click', () => bus.emit('playlist:toggle-repeat'));
  $on('btn-shuffle', 'click', () => bus.emit('playlist:toggle-shuffle'));
  $on('btn-add-media', 'click', () => openMediaSourcePopup());

  // Media source popup
  $on('btn-local-file', 'click', () => openFileSelector());
  $on('btn-youtube-source', 'click', () => { closeMediaSourcePopup(); openYouTubePopup(); });
  $on('btn-demo-media', 'click', () => { closeMediaSourcePopup(); bus.emit('app:load-demo'); });
  $on('btn-close-media-popup', 'click', () => closeMediaSourcePopup());

  // YouTube popup
  $on('youtube-url-input', 'input', function (this: HTMLInputElement) { bus.emit('youtube:preview', this.value); });
  $on('btn-yt-cancel', 'click', () => closeYouTubePopup());
  $on('youtube-play-btn', 'click', () => bus.emit('youtube:load-from-input'));

  // Guide tab
  $on('btn-demo-guide', 'click', () => { switchTab('play'); bus.emit('app:load-demo'); });

  // Seek bar
  initSeekBar();

  // Android fix
  installAndroidRangeScrollFix();

  // Volume sync
  bus.on('audio:volume-changed', ((..._args: unknown[]) => {
    syncVolumeSlider();
  }) as (...args: unknown[]) => void);

  // Role badge update events
  bus.on('network:role-badge-update', ((..._args: unknown[]) => {
    updateRoleBadge();
  }) as (...args: unknown[]) => void);

  // Latency update → refresh role badge to show latency value
  bus.on('sync:latency-update', ((..._args: unknown[]) => {
    updateRoleBadge();
  }) as (...args: unknown[]) => void);

  // Peer disconnected: update UI
  bus.on('network:peer-disconnected', ((...args: unknown[]) => {
    const peerId = args[0] as string;
    log.info(`[UI] Peer disconnected: ${peerId}`);
    updateRoleBadge();
    updateInviteCodeUI();
  }) as (...args: unknown[]) => void);

  // Invite code container click delegation
  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement)?.closest?.('.invite-code-container');
    if (target) {
      e.preventDefault();
      copyInviteCode();
    }
  });

  // Invite code update events
  bus.on('ui:settings-tab-opened', ((..._args: unknown[]) => {
    updateInviteCodeUI();
  }) as (...args: unknown[]) => void);

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
  bus.on('opfs:error', ((...args: unknown[]) => {
    const filename = args[0] as string;
    const error = args[1] as string;
    log.error(`[OPFS] Error for ${filename}:`, error);
    showToast(`파일 저장 오류: ${filename || 'unknown'}`);
  }) as (...args: unknown[]) => void);

  // ── Bus Event Bridge ──────────────────────────────────────────

  // Toast
  bus.on('ui:show-toast', ((...args: unknown[]) => {
    showToast(args[0] as string);
  }) as (...args: unknown[]) => void);

  // Loader
  bus.on('ui:show-loader', ((...args: unknown[]) => {
    showLoader(args[0] as boolean, args[1] as string | undefined);
  }) as (...args: unknown[]) => void);

  bus.on('ui:update-loader', ((...args: unknown[]) => {
    updateLoader(args[0] as number);
  }) as (...args: unknown[]) => void);

  // Play button state (enabled/disabled)
  bus.on('ui:play-btn-state', ((...args: unknown[]) => {
    const enabled = args[0] as boolean;
    const btn = document.getElementById('play-btn');
    if (btn) {
      (btn as HTMLButtonElement).disabled = !enabled;
      btn.style.opacity = enabled ? '1' : '0.4';
    }
  }) as (...args: unknown[]) => void);

  // Play/Pause visual state
  bus.on('ui:update-play-state', ((...args: unknown[]) => {
    const playing = args[0] as boolean;
    const btn = document.getElementById('play-btn');
    if (btn) btn.classList.toggle('playing', playing);
    const icon = btn?.querySelector('path');
    if (icon) {
      icon.setAttribute('d', playing
        ? 'M6 19h4V5H6v14zm8-14v14h4V5h-4z'  // pause icon
        : 'M8 5v14l11-7z');                    // play icon
    }
  }) as (...args: unknown[]) => void);

  // Duration update
  bus.on('ui:duration-update', ((...args: unknown[]) => {
    const dur = args[0] as number;
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tTotal = document.getElementById('time-dur');
    if (slider) { slider.max = String(dur); }
    if (tTotal) tTotal.innerText = fmtTime(dur);
  }) as (...args: unknown[]) => void);

  // Seek reset
  bus.on('ui:seek-reset', ((..._args: unknown[]) => {
    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    if (slider) { slider.value = '0'; }
    if (tc) tc.innerText = '0:00';
  }) as (...args: unknown[]) => void);

  // UI loop (seek bar + time update during playback)
  let _loopInterval: ReturnType<typeof setInterval> | null = null;
  let _endedCheckCounter = 0;
  bus.on('ui:loop-start', ((..._args: unknown[]) => {
    if (_loopInterval) clearInterval(_loopInterval);
    _endedCheckCounter = 0;
    _loopInterval = setInterval(() => {
      const currentState = getState<string>('appState');
      if (isIdleOrPaused(currentState)) {
        if (_loopInterval) { clearInterval(_loopInterval); _loopInterval = null; }
        return;
      }
      const pos = getTrackPosition();
      const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
      const tc = document.getElementById('time-curr');
      const td = document.getElementById('time-dur');
      const isSeeking = getState<boolean>('player.isSeeking');
      if (slider && !isSeeking) {
        slider.value = String(pos);
      }
      if (tc && !isSeeking) tc.innerText = fmtTime(pos);

      // Safety polling: check if track ended (every ~500ms, since loop runs at 250ms)
      _endedCheckCounter++;
      if (_endedCheckCounter >= 2) {
        _endedCheckCounter = 0;
        bus.emit('player:check-ended');
      }
    }, 250);
  }) as (...args: unknown[]) => void);

  // Player actions
  bus.on('player:toggle-play', ((..._args: unknown[]) => {
    togglePlay();
  }) as (...args: unknown[]) => void);

  bus.on('player:seek', ((...args: unknown[]) => {
    const time = args[0] as number;
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (!hostConn) {
      play(time);
      const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
      broadcast({ type: MSG.PLAY, time, index: currentTrackIndex });
      requestGlobalResyncDelayed();
    }
  }) as (...args: unknown[]) => void);

  bus.on('player:seek-to-time', ((...args: unknown[]) => {
    const time = args[0] as number;
    const hostConn = getState<DataConnection | null>('network.hostConn');
    const isOperator = getState<boolean>('network.isOperator');
    if (hostConn && isOperator) {
      hostConn.send({ type: MSG.REQUEST_SEEK, time });
    } else if (!hostConn) {
      const currentState = getState<string>('appState');
      const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
      if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
        play(time);
        broadcast({ type: MSG.PLAY, time, index: currentTrackIndex });
        requestGlobalResyncDelayed();
      } else {
        setState('player.pausedAt', time);
      }
    }
  }) as (...args: unknown[]) => void);

  // Playlist actions
  bus.on('playlist:toggle-repeat', ((..._args: unknown[]) => {
    toggleRepeat();
  }) as (...args: unknown[]) => void);

  bus.on('playlist:toggle-shuffle', ((..._args: unknown[]) => {
    toggleShuffle();
  }) as (...args: unknown[]) => void);

  // Metadata update (track title in player UI)
  bus.on('player:metadata-update', ((...args: unknown[]) => {
    const item = args[0] as PlaylistItem;
    if (!item) return;
    const title = item.title || item.name || 'Unknown';
    updateTitleWithMarquee(title);
  }) as (...args: unknown[]) => void);

  // YouTube time update (seek bar + time display)
  bus.on('ui:time-update', ((...args: unknown[]) => {
    const currFormatted = args[0] as string;
    const totalFormatted = args[1] as string;
    const currentTime = args[2] as number;
    const duration = args[3] as number;

    const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
    const tc = document.getElementById('time-curr');
    const tt = document.getElementById('time-dur');
    const isSeeking = getState<boolean>('player.isSeeking');

    if (slider && duration > 0) {
      slider.max = String(duration);
      if (!isSeeking) slider.value = String(currentTime);
    }
    if (tc && !isSeeking) tc.innerText = currFormatted;
    if (tt) tt.innerText = totalFormatted;
  }) as (...args: unknown[]) => void);

  log.info('[PlayerControls] Initialized');
}
