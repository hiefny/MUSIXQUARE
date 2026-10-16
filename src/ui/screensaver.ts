import { createBusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { formatSystemAudioProfileLabel } from '../core/system-audio-profile.ts';
import { getResolvedLanguage, t } from '../i18n/index.ts';
import { languageDirection } from '../i18n/locales.ts';
import { getTrackDisplayTitle } from '../player/track-display.ts';
import { getUiElement, syncOverlayState } from './dom.ts';
import { showToast } from './toast.ts';

const OVERLAY_ID = 'screensaver-overlay';
const MUSIC_PREFERENCE_KEY = 'mxqr:screensaver:music';
let activeCleanup: (() => void) | null = null;

function youtubeIsSelected(): boolean {
  return (
    getState('playback.mode') === 'youtube' ||
    getState('player.currentTrackMeta')?.type === 'youtube'
  );
}

function musicPreference(): boolean {
  try {
    return localStorage.getItem(MUSIC_PREFERENCE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function saveMusicPreference(enabled: boolean): void {
  try {
    localStorage.setItem(MUSIC_PREFERENCE_KEY, enabled ? 'on' : 'off');
  } catch {
    return;
  }
}

function currentMusic(): { title: string; subtitle: string } {
  const track = getState('player.currentTrackMeta');
  if (!track || track.type === 'youtube') return { title: '', subtitle: '' };
  const systemAudio = track.systemAudioMode || track.systemAudioPlaceholder;
  const title = systemAudio
    ? track.name === 'system-audio-receiving'
      ? 'Receiving system audio'
      : 'System audio'
    : getTrackDisplayTitle(track);
  const fallback = systemAudio
    ? formatSystemAudioProfileLabel(track.systemAudioSurface)
    : /\.([a-z0-9]{1,8})$/i.exec(track.name || '')?.[1]?.toUpperCase() || '';
  return {
    title,
    subtitle: getUiElement('track-artist')?.textContent?.trim() || fallback,
  };
}

export function openScreensaver(): void {
  if (youtubeIsSelected()) {
    showToast(t('toast.screensaver_youtube'));
    return;
  }
  if (activeCleanup) return;

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'active';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Screensaver');
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '0',
    right: '0',
    bottom: '0',
    left: '0',
    zIndex: '5500',
    background: '#02081b',
    overflow: 'hidden',
  });
  const frame = document.createElement('iframe');
  frame.title = 'Screensaver';
  frame.src = '/screensaver.html';
  frame.allow = "geolocation 'self'; fullscreen 'self'";
  frame.allowFullscreen = true;
  frame.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  );
  Object.assign(frame.style, { width: '100%', height: '100%', border: '0', display: 'block' });
  const fallbackBack = document.createElement('button');
  fallbackBack.type = 'button';
  fallbackBack.textContent = t('screensaver.back');
  Object.assign(fallbackBack.style, {
    position: 'absolute',
    top: 'max(20px, env(safe-area-inset-top))',
    left: '50%',
    transform: 'translateX(-50%)',
    color: '#fff',
    background: 'transparent',
    border: '0',
    padding: '12px 20px',
    font: 'inherit',
    cursor: 'pointer',
  });
  overlay.append(frame, fallbackBack);

  const scope = createBusScope();
  let showMusic = musicPreference();
  let ready = false;
  let disposed = false;
  let lastPayload = '';
  const sendUpdate = (force = false): void => {
    if (disposed || !ready) return;
    const lang = getResolvedLanguage();
    const payload = {
      backLabel: t('screensaver.back'),
      musicLabel: t('screensaver.show_music'),
      showMusic,
      ...currentMusic(),
      lang,
      dir: languageDirection(lang),
    };
    const serialized = JSON.stringify(payload);
    if (!force && serialized === lastPayload) return;
    lastPayload = serialized;
    frame.contentWindow?.postMessage(
      { type: 'mxqr:screensaver:update', payload },
      window.location.origin,
    );
    fallbackBack.textContent = payload.backLabel;
  };

  const subtitleObserver = new MutationObserver(() => sendUpdate());
  const subtitle = getUiElement('track-artist');
  if (subtitle)
    subtitleObserver.observe(subtitle, { childList: true, characterData: true, subtree: true });

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    scope.dispose();
    subtitleObserver.disconnect();
    window.removeEventListener('message', onMessage);
    document.removeEventListener('keydown', onKey, true);
    if (document.fullscreenElement && overlay.contains(document.fullscreenElement)) {
      document.exitFullscreen().catch(() => {});
    }
    overlay.remove();
    syncOverlayState();
    if (activeCleanup === cleanup) activeCleanup = null;
    if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) {
      previousFocus.focus({ preventScroll: true });
    }
  };
  const enforcePlayback = (): void => {
    if (youtubeIsSelected()) {
      cleanup();
      showToast(t('toast.screensaver_youtube'));
    } else sendUpdate();
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (disposed || event.origin !== window.location.origin || event.source !== frame.contentWindow)
      return;
    const data = event.data;
    if (typeof data !== 'object' || data === null || !('type' in data)) return;
    if (data.type === 'mxqr:screensaver:ready') {
      if (youtubeIsSelected()) {
        enforcePlayback();
        return;
      }
      ready = true;
      sendUpdate(true);
      fallbackBack.hidden = true;
      if (!overlay.hasAttribute('inert')) frame.focus();
    } else if (data.type === 'mxqr:screensaver:close') {
      if (!overlay.hasAttribute('inert')) cleanup();
    } else if (
      data.type === 'mxqr:screensaver:music-toggle' &&
      'enabled' in data &&
      typeof data.enabled === 'boolean'
    ) {
      if (overlay.hasAttribute('inert')) return;
      showMusic = data.enabled;
      saveMusicPreference(showMusic);
      sendUpdate();
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.isComposing || overlay.hasAttribute('inert')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      cleanup();
    } else if (event.key === 'Tab' && !ready) {
      event.preventDefault();
      fallbackBack.focus();
    }
  };
  fallbackBack.addEventListener('click', cleanup);
  scope.on('state:playback.mode', enforcePlayback);
  scope.on('state:player.currentTrackMeta', enforcePlayback);
  scope.on('state:files.current', () => sendUpdate());
  scope.on('audio:ready', () => sendUpdate());
  scope.on('i18n:changed', () => sendUpdate());
  scope.on('state:setup.sessionStarted', (started) => {
    if (!started) cleanup();
  });
  window.addEventListener('message', onMessage);
  document.addEventListener('keydown', onKey, true);
  activeCleanup = cleanup;
  document.body.appendChild(overlay);
  syncOverlayState(OVERLAY_ID);
  fallbackBack.focus({ preventScroll: true });
}
