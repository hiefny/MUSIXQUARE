import { bus, createBusScope } from '../core/events.ts';
import QRCode from 'qrcode';
import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import { loadDemoFile } from '../player/decode.ts';
import {
  getCurrentAudioBuffer,
  incrementLoadToken,
  setCurrentAudioBuffer,
} from '../player/_state.ts';
import {
  getPlaybackModeActivitySnapshot,
  setPlaybackFilePaused,
  setPlaybackTrackMeta,
} from '../player/ownership.ts';
import { pause, play, stopAllMedia } from '../player/transport.ts';
import { applySettingsAsync } from '../audio/effects.ts';
import { hideSetupOverlay } from '../ui/setup-shared.ts';
import { showDialog } from '../ui/dialog.ts';
import { showLoader, showToast, updateLoader } from '../ui/toast.ts';
import { updateOverlayOpenClass } from '../ui/dom.ts';
import type { TrackMeta } from '../types/index.ts';
import {
  DEMO_TRACK,
  createDemoTrackMeta,
  getDemoTrackByIndex,
  getNextDemoTrackIndex,
  type DemoTrack,
} from './tracks.ts';
import { hasAppUseRecord, hasSeenDemoPrompt, markAppUsed, markDemoPromptSeen } from './storage.ts';

type DemoSnapshot = {
  channelMode: number;
  reverbMix: number;
  reverbDecay: number;
  reverbPreDelay: number;
  reverbLowCut: number;
  reverbHighCut: number;
  eqValues: number[];
  virtualBass: number;
  userPreampGain: number;
  subFreq: number;
  currentTrackMeta: TrackMeta | null;
  currentTrackIndex: number;
  currentFileBlob: File | Blob | null;
  currentAudioBuffer: AudioBuffer | null;
  pausedAt: number;
  duration: number;
  hadFilePlayback: boolean;
  visualizerMode: 'circular' | 'spectrum';
};

const WARM_EQ = [5, 3, 0, -2, -3];
const MOBILE_QUERY = '(max-width: 1279px)';
const SYNC_ICON_PATH =
  'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z';
const MEDIA_ICON_PATH =
  'M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM9 8l7 4-7 4V8z';
const INFO_ICON_PATH =
  'M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h5V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-5h-2v5z';
const EXIT_ICON_PATH =
  'M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z';
const _busScope = createBusScope();

let _snapshot: DemoSnapshot | null = null;
let _visualizerPlaceholder: Comment | null = null;
let _promptInFlight = false;
let _suppressFirstRunPrompt = false;
let _demoStep = 1;
let _demoTrackIndex = 0;
let _demoLoadToken = 0;
const _demoBlobCache = new Map<string, Blob>();
const _demoPreloadInFlight = new Map<string, Promise<Blob>>();

export function shouldShowFirstRunDemoPrompt(): boolean {
  if (_suppressFirstRunPrompt || hasSeenDemoPrompt()) return false;
  if (/^\/\d{6}$/.test(window.location.pathname)) return false;
  if (getState('network.appRole') !== 'host') return false;
  if (!getState('setup.sessionStarted')) return false;
  if (document.getElementById('setup-overlay')?.classList.contains('active')) return false;
  return true;
}

function getCurrentVisualizerMode(): 'circular' | 'spectrum' {
  return document.body.classList.contains('viz-spectrum') ? 'spectrum' : 'circular';
}

function syncVisualizerModeButtons(mode: 'circular' | 'spectrum'): void {
  document
    .querySelectorAll('#grid-visualizer .ch-opt')
    .forEach((el) => el.classList.remove('active'));
  document.querySelector(`#grid-visualizer .ch-opt[data-viz="${mode}"]`)?.classList.add('active');
}

function setVisualizerMode(mode: 'circular' | 'spectrum'): void {
  syncVisualizerModeButtons(mode);
  bus.emit('visualizer:set-type', mode);
}

function captureSnapshot(): DemoSnapshot {
  return {
    channelMode: getState('audio.channelMode'),
    reverbMix: getState('audio.reverbMix'),
    reverbDecay: getState('audio.reverbDecay'),
    reverbPreDelay: getState('audio.reverbPreDelay'),
    reverbLowCut: getState('audio.reverbLowCut'),
    reverbHighCut: getState('audio.reverbHighCut'),
    eqValues: [...(getState('audio.eqValues') || [])],
    virtualBass: getState('audio.virtualBass'),
    userPreampGain: getState('audio.userPreampGain'),
    subFreq: getState('audio.subFreq'),
    currentTrackMeta: getState('player.currentTrackMeta') as TrackMeta | null,
    currentTrackIndex: getState('playlist.currentTrackIndex'),
    currentFileBlob: getState('files.currentFileBlob'),
    currentAudioBuffer: getCurrentAudioBuffer(),
    pausedAt: getState('player.pausedAt') || 0,
    duration: getCurrentAudioBuffer()?.duration || 0,
    hadFilePlayback: getPlaybackModeActivitySnapshot().mode === 'file',
    visualizerMode: getCurrentVisualizerMode(),
  };
}

function restoreSnapshot(snapshot: DemoSnapshot | null): void {
  if (!snapshot) return;
  setState('audio.channelMode', snapshot.channelMode);
  setState('audio.reverbMix', snapshot.reverbMix);
  setState('audio.reverbDecay', snapshot.reverbDecay);
  setState('audio.reverbPreDelay', snapshot.reverbPreDelay);
  setState('audio.reverbLowCut', snapshot.reverbLowCut);
  setState('audio.reverbHighCut', snapshot.reverbHighCut);
  setState('audio.eqValues', [...snapshot.eqValues]);
  setState('audio.virtualBass', snapshot.virtualBass);
  setState('audio.userPreampGain', snapshot.userPreampGain);
  setState('audio.subFreq', snapshot.subFreq);
  setState('playlist.currentTrackIndex', snapshot.currentTrackIndex);
  setPlaybackTrackMeta(snapshot.currentTrackMeta);
  if (snapshot.hadFilePlayback && snapshot.currentAudioBuffer && snapshot.currentFileBlob) {
    setState('files.currentFileBlob', snapshot.currentFileBlob);
    setCurrentAudioBuffer(snapshot.currentAudioBuffer);
    setState(
      'player.pausedAt',
      Math.min(snapshot.pausedAt, snapshot.duration || snapshot.pausedAt),
    );
    setPlaybackFilePaused();
    bus.emit('ui:play-btn-state', true);
    if (snapshot.duration > 0) bus.emit('ui:duration-update', snapshot.duration);
  } else {
    setState('files.currentFileBlob', null);
  }
  setVisualizerMode(snapshot.visualizerMode);
  void applySettingsAsync();
}

function getCurrentDemoTrack(): DemoTrack {
  return getDemoTrackByIndex(_demoTrackIndex);
}

function fetchDemoBlob(track: DemoTrack, reportProgress: boolean): Promise<Blob> {
  const cached = _demoBlobCache.get(track.id);
  if (cached) return Promise.resolve(cached);
  const inFlight = _demoPreloadInFlight.get(track.id);
  if (inFlight) return inFlight;

  return new Promise<Blob>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', track.url, true);
    xhr.responseType = 'blob';
    xhr.timeout = 30000;
    xhr.onprogress = (event) => {
      if (!reportProgress || !event.lengthComputable) return;
      updateLoader(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const blob = xhr.response as Blob;
        _demoBlobCache.set(track.id, blob);
        resolve(blob);
      } else {
        reject(new Error(`HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network Error'));
    xhr.ontimeout = () => reject(new Error('Request Timeout'));
    xhr.send();
  }).finally(() => {
    _demoPreloadInFlight.delete(track.id);
  });
}

function preloadDemoTrack(index: number): void {
  const track = getDemoTrackByIndex(index);
  if (_demoBlobCache.has(track.id) || _demoPreloadInFlight.has(track.id)) return;
  const request = fetchDemoBlob(track, false).catch((error) => {
    log.warn(`[Demo] Preload failed for ${track.id}`, error);
    throw error;
  });
  _demoPreloadInFlight.set(track.id, request);
}

async function loadDemoTrack(index: number, options: { autoplay: boolean }): Promise<void> {
  const track = getDemoTrackByIndex(index);
  const token = ++_demoLoadToken;
  _demoTrackIndex = index;
  setState('playlist.currentTrackIndex', index);
  setPlaybackTrackMeta(createDemoTrackMeta(track));
  syncDesktopDemoText();

  showLoader(true, t('transfer.demo_loading_short'));
  updateLoader(0);
  const blob = await fetchDemoBlob(track, true);
  if (token !== _demoLoadToken || !getState('demo.active')) return;

  const file = new File([blob], track.fileName, { type: track.mime });
  await loadDemoFile(file, createDemoTrackMeta(track), incrementLoadToken());
  if (token !== _demoLoadToken || !getState('demo.active')) return;

  preloadDemoTrack(getNextDemoTrackIndex(index));
  if (options.autoplay) await play(0);
}

function mountVisualizerForMobile(): void {
  const slot = document.getElementById('demo-visualizer-slot');
  const wrapper = document.querySelector<HTMLElement>('.vinyl-wrapper');
  if (!slot || !wrapper || wrapper.parentElement === slot) return;

  _visualizerPlaceholder = document.createComment('demo-visualizer-placeholder');
  wrapper.parentNode?.insertBefore(_visualizerPlaceholder, wrapper);
  slot.appendChild(wrapper);
}

function restoreVisualizer(): void {
  const wrapper = document.querySelector<HTMLElement>('.vinyl-wrapper');
  if (!_visualizerPlaceholder || !wrapper) return;
  _visualizerPlaceholder.parentNode?.insertBefore(wrapper, _visualizerPlaceholder);
  _visualizerPlaceholder.parentNode?.removeChild(_visualizerPlaceholder);
  _visualizerPlaceholder = null;
}

function setDemoDomActive(active: boolean): void {
  document.body.classList.toggle('mode-demo', active);
  document.body.classList.toggle('demo-mobile', active);

  const overlay = document.getElementById('demo-overlay');
  if (overlay) {
    overlay.classList.toggle('active', active);
    overlay.setAttribute('aria-hidden', String(!active));
  }

  if (active) mountVisualizerForMobile();
  else restoreVisualizer();

  updateOverlayOpenClass();
  syncDesktopDemoText(active);
  syncDemoSessionCopy();
  syncDemoStep();
}

function syncDesktopDemoText(active = getState('demo.active')): void {
  const track = getCurrentDemoTrack();
  document.querySelectorAll<HTMLElement>('.demo-track-title, .demo-desktop-title').forEach((el) => {
    el.textContent = track.title;
  });
  document
    .querySelectorAll<HTMLElement>('.demo-track-artist, .demo-desktop-artist')
    .forEach((el) => {
      el.textContent = track.artist;
    });

  const demoInfo = document.getElementById('demo-desktop-track-info');
  if (demoInfo) demoInfo.setAttribute('aria-hidden', String(!active));

  const playlistTitle = document.querySelector<HTMLElement>('#tab-playlist .tab-title');
  if (playlistTitle) {
    playlistTitle.textContent = active ? t('demo.track_info') : t('nav.playlist');
    playlistTitle.setAttribute('data-i18n', active ? 'demo.track_info' : 'nav.playlist');
  }

  const syncLabel = document.querySelector<HTMLElement>('#btn-sync span');
  if (syncLabel) {
    syncLabel.textContent = active ? t('demo.track_info') : t('common.sync');
    syncLabel.setAttribute('data-i18n', active ? 'demo.track_info' : 'common.sync');
  }

  const mediaLabel = document.querySelector<HTMLElement>('#btn-media-source span');
  if (mediaLabel) {
    mediaLabel.textContent = active ? t('demo.exit') : t('player.play_media');
    mediaLabel.setAttribute('data-i18n', active ? 'demo.exit' : 'player.play_media');
  }

  const syncIcon = document.querySelector<SVGPathElement>('#btn-sync svg path');
  if (syncIcon) syncIcon.setAttribute('d', active ? INFO_ICON_PATH : SYNC_ICON_PATH);

  const mediaIcon = document.querySelector<SVGPathElement>('#btn-media-source svg path');
  if (mediaIcon) mediaIcon.setAttribute('d', active ? EXIT_ICON_PATH : MEDIA_ICON_PATH);

  syncDemoTrackList();
}

function syncDemoTrackList(): void {
  document.querySelectorAll<HTMLElement>('[data-demo-track-index]').forEach((row) => {
    const active = Number(row.dataset.demoTrackIndex) === _demoTrackIndex;
    row.classList.toggle('active', active);
    row.setAttribute('aria-current', active ? 'true' : 'false');
  });
}

function getDemoSessionCode(): string {
  const code = getState('network.sessionCode') || getState('network.lastJoinCode');
  return /^\d{6}$/.test(code) ? code : '------';
}

function getDemoDeviceCount(): number {
  const deviceList = getState('network.lastKnownDeviceList') as unknown;
  if (Array.isArray(deviceList) && deviceList.length > 0) {
    const connected = deviceList.filter((peer) => {
      if (!peer || typeof peer !== 'object') return false;
      const status = (peer as { status?: unknown }).status;
      return status !== 'disconnected';
    }).length;
    if (connected > 0) return connected;
  }

  const peers = getState('network.connectedPeers') as unknown;
  if (!Array.isArray(peers)) return 1;
  const connectedGuests = peers.filter((peer) => {
    if (!peer || typeof peer !== 'object') return false;
    return (peer as { status?: unknown }).status !== 'disconnected';
  }).length;
  return Math.max(1, connectedGuests + (getState('network.hostConn') ? 0 : 1));
}

function syncDemoSessionCopy(): void {
  const code = getDemoSessionCode();
  const count = getDemoDeviceCount();
  document.querySelectorAll<HTMLElement>('[data-demo-session-title]').forEach((el) => {
    el.textContent = t('demo.session_title', { code });
  });
  document.querySelectorAll<HTMLElement>('[data-demo-session-subtitle]').forEach((el) => {
    el.textContent = t('demo.session_subtitle');
  });
  document.querySelectorAll<HTMLElement>('[data-demo-session-body]').forEach((el) => {
    el.textContent =
      count > 1 ? t('demo.session_body_connected', { count }) : t('demo.session_body_alone');
  });
  void renderDemoQRCode(code);
}

async function renderDemoQRCode(code: string): Promise<void> {
  const container = document.getElementById('demo-session-qr');
  if (!container) return;
  if (!/^\d{6}$/.test(code)) {
    const p = document.createElement('p');
    p.className = 'demo-session-qr-placeholder';
    p.textContent = t('connect.no_session');
    container.replaceChildren(p);
    return;
  }

  try {
    const svgString = await QRCode.toString(`MUSIXQUARE.COM/${code}`, {
      type: 'svg',
      margin: 2,
      errorCorrectionLevel: 'L',
      color: {
        dark: '#000000',
        light: '#00000000',
      },
    });
    container.innerHTML = svgString;
    const svg = container.querySelector('svg');
    if (svg) {
      svg.classList.add('qr-svg');
      svg.removeAttribute('width');
      svg.removeAttribute('height');
    }
  } catch (error) {
    log.warn('[Demo] QR generation failed', error);
  }
}

function syncDemoStep(step = _demoStep): void {
  _demoStep = Math.min(4, Math.max(1, Number(step) || 1));
  document.querySelectorAll<HTMLElement>('[data-demo-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.demoPanel === String(_demoStep));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-step]').forEach((btn) => {
    const active = btn.dataset.demoStep === String(_demoStep);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
}

function syncRoleButtons(): void {
  const mode = getState('audio.channelMode');
  document.querySelectorAll<HTMLElement>('[data-demo-role]').forEach((btn) => {
    const active = Number(btn.dataset.demoRole) === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  document
    .querySelectorAll<HTMLElement>('[data-role-diagram="demo"] .graphic-speaker[data-role-mode]')
    .forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.roleMode) === mode);
    });
}

function syncEffectButtons(): void {
  const reverbOn = getState('demo.reverbOn');
  const bassOn = getState('demo.bassBoostOn');
  document.querySelectorAll<HTMLElement>('[data-demo-effect="reverb"]').forEach((btn) => {
    btn.classList.toggle('active', reverbOn);
    btn.setAttribute('aria-pressed', String(reverbOn));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-effect="bass"]').forEach((btn) => {
    btn.classList.toggle('active', bassOn);
    btn.setAttribute('aria-pressed', String(bassOn));
  });
}

function isDemoPlaying(): boolean {
  const playback = getPlaybackModeActivitySnapshot();
  return getState('demo.active') && playback.mode === 'file' && playback.activity === 'playing';
}

function syncPlayButton(): void {
  const playing = isDemoPlaying();
  document.querySelectorAll<HTMLElement>('[data-demo-play-icon]').forEach((path) => {
    path.setAttribute('d', playing ? 'M6 19h4V5H6v14zm8-14v14h4V5h-4z' : 'M8 5v14l11-7z');
  });
}

async function enterDemoMode(): Promise<void> {
  if (getState('demo.loading')) return;
  if (getState('demo.active')) {
    setDemoDomActive(true);
    return;
  }

  markDemoPromptSeen();
  markAppUsed();
  _snapshot = captureSnapshot();
  _demoStep = 1;
  _demoTrackIndex = 0;
  _demoLoadToken++;
  setVisualizerMode('spectrum');

  setState('demo.active', true);
  setState('demo.loading', true);
  setState('demo.reverbOn', false);
  setState('demo.bassBoostOn', false);
  setState('playlist.currentTrackIndex', 0);
  setPlaybackTrackMeta(createDemoTrackMeta(getCurrentDemoTrack()));
  hideSetupOverlay();
  bus.emit('ui:switch-tab', 'play');
  setDemoDomActive(true);
  syncRoleButtons();
  syncEffectButtons();

  try {
    await loadDemoTrack(0, { autoplay: true });
    showToast(t('transfer.demo_loaded'));
  } catch (error: unknown) {
    log.error('[Demo] Enter failed:', error);
    showToast(`${t('transfer.demo_load_fail')} ${(error as Error).message || ''}`.trim());
    exitDemoMode();
  } finally {
    setState('demo.loading', false);
    showLoader(false);
  }
}

function exitDemoMode(): void {
  if (!getState('demo.active') && !getState('demo.loading')) return;
  _demoLoadToken++;
  stopAllMedia({ cancelInFlight: true });
  setCurrentAudioBuffer(null);
  setState('demo.active', false);
  setState('demo.loading', false);
  setState('demo.reverbOn', false);
  setState('demo.bassBoostOn', false);
  setDemoDomActive(false);
  restoreSnapshot(_snapshot);
  _snapshot = null;
  bus.emit('ui:seek-reset');
}

function openDemoInfo(): void {
  window.open(DEMO_TRACK.infoUrl, '_blank', 'noopener');
}

function requestDemoExit(): void {
  if (getState('network.hostConn')) {
    showToast(t('demo.host_only_exit'));
    return;
  }
  exitDemoMode();
}

function getPlacementToastKey(mode: number): Parameters<typeof t>[0] {
  if (mode === -1) return 'role.left_placement';
  if (mode === 1) return 'role.right_placement';
  return 'role.center_placement';
}

function setDemoRole(mode: number): void {
  if (!Number.isFinite(mode)) return;
  bus.emit('audio:set-channel-mode', mode);
  syncRoleButtons();
  showToast(t(getPlacementToastKey(mode)));
}

function toggleDemoReverb(): void {
  const next = !getState('demo.reverbOn');
  setState('demo.reverbOn', next);
  bus.emit('audio:reverb-type-change', next ? 'arena' : 'off');
  syncEffectButtons();
}

function toggleDemoBass(): void {
  const next = !getState('demo.bassBoostOn');
  setState('demo.bassBoostOn', next);
  if (next) {
    WARM_EQ.forEach((value, band) => bus.emit('audio:set-eq', band, value));
    bus.emit('audio:update-effect', 'vbass', 'mix', 60, false);
  } else {
    bus.emit('audio:reset-eq');
    bus.emit('audio:update-effect', 'vbass', 'mix', 0, false);
  }
  syncEffectButtons();
}

function toggleDemoPlay(): void {
  if (!getState('demo.active')) return;
  if (isDemoPlaying()) {
    pause(undefined, { showToast: false });
    syncPlayButton();
    return;
  }
  const offset = getState('player.pausedAt') || 0;
  void play(offset);
}

function playNextDemoTrack(): void {
  if (!getState('demo.active') || getState('demo.loading')) return;
  const nextIndex = getNextDemoTrackIndex(_demoTrackIndex);
  setState('demo.loading', true);
  void loadDemoTrack(nextIndex, { autoplay: true })
    .catch((error: unknown) => {
      log.warn('[Demo] Failed to advance demo track', error);
      showToast(`${t('transfer.demo_load_fail')} ${(error as Error).message || ''}`.trim());
    })
    .finally(() => {
      setState('demo.loading', false);
      showLoader(false);
    });
}

function bindDemoDom(): void {
  if (document.body.dataset.demoBound === '1') return;
  document.body.dataset.demoBound = '1';

  document.querySelectorAll<HTMLElement>('[data-demo-role]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:set-role', Number(btn.dataset.demoRole)));
  });
  document
    .querySelectorAll<HTMLElement>('[data-role-diagram="demo"] .graphic-speaker[data-role-mode]')
    .forEach((el) => {
      el.addEventListener('click', () => bus.emit('demo:set-role', Number(el.dataset.roleMode)));
    });
  document.querySelectorAll<HTMLElement>('[data-demo-effect="reverb"]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:toggle-reverb'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-effect="bass"]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:toggle-bass'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-info]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:open-info'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-exit]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:request-exit'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-play]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:toggle-play'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-step]').forEach((btn) => {
    btn.addEventListener('click', () => syncDemoStep(Number(btn.dataset.demoStep)));
  });
}

function maybeShowFirstRunPrompt(): void {
  if (_promptInFlight || !shouldShowFirstRunDemoPrompt()) return;
  _promptInFlight = true;
  showDialog({
    title: t('demo.prompt_title'),
    message: t('demo.prompt_message'),
    buttonText: t('demo.prompt_cta'),
    secondaryText: t('demo.prompt_later'),
    defaultFocus: 'primary',
  })
    .then((result) => {
      markDemoPromptSeen();
      if (result.action === 'ok') {
        bus.emit('demo:enter');
      } else {
        showToast(t('demo.try_later_toast'));
      }
    })
    .catch((error) => log.warn('[Demo] Prompt failed:', error))
    .finally(() => {
      _promptInFlight = false;
    });
}

export function initDemoMode(): void {
  _busScope.dispose();
  bindDemoDom();
  _suppressFirstRunPrompt = hasAppUseRecord();

  _busScope.on('demo:enter', () => {
    void enterDemoMode();
  });
  _busScope.on('demo:exit', () => exitDemoMode());
  _busScope.on('demo:request-exit', () => requestDemoExit());
  _busScope.on('demo:open-info', () => openDemoInfo());
  _busScope.on('demo:toggle-play', () => toggleDemoPlay());
  _busScope.on('demo:set-role', (mode) => setDemoRole(mode));
  _busScope.on('demo:toggle-reverb', () => toggleDemoReverb());
  _busScope.on('demo:toggle-bass', () => toggleDemoBass());
  _busScope.on('state:audio.channelMode', () => syncRoleButtons());
  _busScope.on('state:demo.reverbOn', () => syncEffectButtons());
  _busScope.on('state:demo.bassBoostOn', () => syncEffectButtons());
  _busScope.on('state:playback.activity', () => syncPlayButton());
  _busScope.on('player:ended', () => {
    if (!getState('demo.active')) return;
    setState('player.pausedAt', 0);
    syncPlayButton();
    playNextDemoTrack();
  });
  _busScope.on('i18n:changed', () => {
    syncDesktopDemoText();
    syncDemoSessionCopy();
  });
  _busScope.on('network:device-list-update', () => syncDemoSessionCopy());
  _busScope.on('state:network.connectedPeers', () => syncDemoSessionCopy());
  _busScope.on('state:network.sessionCode', () => syncDemoSessionCopy());
  _busScope.on('state:network.lastJoinCode', () => syncDemoSessionCopy());
  _busScope.on('state:network.appRole', (role) => {
    if (role === 'guest') _suppressFirstRunPrompt = true;
  });
  _busScope.on('state:setup.sessionStarted', (started) => {
    if (!started || getState('network.appRole') !== 'host') return;
    clearManagedTimer('demo-first-run-prompt');
    setManagedTimer('demo-first-run-prompt', maybeShowFirstRunPrompt, 700);
  });

  try {
    const mql = window.matchMedia(MOBILE_QUERY);
    mql.addEventListener('change', () => {
      if (getState('demo.active')) setDemoDomActive(true);
    });
  } catch {
    window.addEventListener('resize', () => {
      if (getState('demo.active')) setDemoDomActive(true);
    });
  }

  clearManagedTimer('demo-first-run-prompt');
}
