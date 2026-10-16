import { createBusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { formatSystemAudioProfileLabel } from '../core/system-audio-profile.ts';
import { getResolvedLanguage, t } from '../i18n/index.ts';
import { languageDirection } from '../i18n/locales.ts';
import { getTrackDisplayTitle } from '../player/track-display.ts';
import { getUiElement, onWindowBack, syncOverlayState } from './dom.ts';
import { showToast } from './toast.ts';
import { beginScreensaverEntry, type ScreensaverEntry } from './screensaver-entry.ts';

const OVERLAY_ID = 'screensaver-overlay';
const CLOSE_TIMER = 'screensaver-close';
let activeCleanup: (() => void) | null = null;

function youtubeIsSelected(): boolean {
  return (
    getState('playback.mode') === 'youtube' ||
    getState('player.currentTrackMeta')?.type === 'youtube'
  );
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

export function openScreensaver(pendingEntry?: ScreensaverEntry): void {
  if (youtubeIsSelected()) {
    pendingEntry?.release();
    showToast(t('toast.screensaver_youtube'));
    return;
  }
  if (activeCleanup) {
    pendingEntry?.release();
    return;
  }
  const entry = pendingEntry || beginScreensaverEntry();
  if (!entry || entry.closed) return;
  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

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
    opacity: motion?.matches ? '1' : '0',
    transition: motion?.matches ? 'none' : 'opacity 420ms cubic-bezier(.4, 0, .2, 1)',
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
    textShadow: 'none',
    boxShadow: 'none',
  });
  overlay.append(frame, fallbackBack);

  const scope = createBusScope();
  let ready = false;
  let disposed = false;
  let closing = false;
  let entryFrame: number | null = null;
  let lastPayload = '';
  const sendUpdate = (force = false): void => {
    if (disposed || closing || !ready) return;
    const lang = getResolvedLanguage();
    const payload = {
      backLabel: t('screensaver.back'),
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

  const finishClose = (): void => {
    if (disposed) return;
    disposed = true;
    if (entryFrame !== null) cancelAnimationFrame(entryFrame);
    clearManagedTimer(CLOSE_TIMER);
    scope.dispose();
    subtitleObserver.disconnect();
    window.removeEventListener('message', onMessage);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('keydown', onKey, true);
    overlay.removeEventListener('transitionend', onTransitionEnd);
    motion?.removeEventListener('change', onMotionChange);
    removeExitListener();
    entry.release();
    overlay.remove();
    syncOverlayState();
    if (activeCleanup === cleanup) activeCleanup = null;
    if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) {
      previousFocus.focus({ preventScroll: true });
    }
  };
  const cleanup = (immediate = false): void => {
    if (disposed) return;
    if (immediate || motion?.matches || overlay.style.opacity === '0') {
      finishClose();
      return;
    }
    if (closing) return;
    closing = true;
    if (entryFrame !== null) cancelAnimationFrame(entryFrame);
    overlay.style.opacity = '0';
    setManagedTimer(CLOSE_TIMER, finishClose, 500);
  };
  const onTransitionEnd = (event: TransitionEvent): void => {
    if (closing && event.target === overlay && event.propertyName === 'opacity') finishClose();
  };
  const onMotionChange = (): void => {
    if (!motion?.matches) return;
    overlay.style.transition = 'none';
    if (closing) finishClose();
    else overlay.style.opacity = '1';
  };
  const onPageHide = (): void => cleanup(true);
  const removeExitListener = entry.onExit(() => cleanup());
  const enforcePlayback = (): void => {
    if (disposed) return;
    if (youtubeIsSelected()) {
      cleanup(true);
      showToast(t('toast.screensaver_youtube'));
    } else sendUpdate();
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (
      disposed ||
      closing ||
      event.origin !== window.location.origin ||
      event.source !== frame.contentWindow
    )
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
      if (!overlay.closest('[inert]')) frame.focus();
    } else if (data.type === 'mxqr:screensaver:close') {
      if (!overlay.closest('[inert]')) cleanup();
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.isComposing || overlay.closest('[inert]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      cleanup();
    } else if (event.key === 'Tab' && !ready) {
      event.preventDefault();
      fallbackBack.focus();
    }
  };
  fallbackBack.addEventListener('click', () => cleanup());
  // The overlay leaves the DOM when it closes, and its listener with it.
  onWindowBack(overlay, () => {
    cleanup();
    return true;
  });
  scope.on('state:playback.mode', enforcePlayback);
  scope.on('state:player.currentTrackMeta', enforcePlayback);
  scope.on('state:files.current', () => sendUpdate());
  scope.on('audio:ready', () => sendUpdate());
  scope.on('i18n:changed', () => sendUpdate());
  scope.on('state:setup.sessionStarted', (started) => {
    if (!started) cleanup(true);
  });
  window.addEventListener('message', onMessage);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('transitionend', onTransitionEnd);
  motion?.addEventListener('change', onMotionChange);
  activeCleanup = cleanup;
  entry.container.appendChild(overlay);
  syncOverlayState(OVERLAY_ID);
  fallbackBack.focus({ preventScroll: true });
  if (!motion?.matches) {
    void overlay.offsetWidth;
    entryFrame = requestAnimationFrame(() => {
      entryFrame = null;
      if (!disposed && !closing) overlay.style.opacity = '1';
    });
  }
}
