/**
 * MUSIXQUARE 2.0 — Application Bootstrap
 *
 * Module initialization order:
 * 1. core/   — constants, log, events, state, platform, session, blob-manager, timers
 * 2. audio/  — engine, effects, channel
 * 3. network/ — peer, protocol, sync, relay
 * 4. storage/ — opfs, transfer, preload, recovery
 * 5. player/ — playback, playlist, video, media-session
 * 6. youtube/ — player, sync, search
 * 7. ui/     — dom, toast, dialog, tabs, i18n, visualizer, chat, playlist-view,
 *              player-controls, settings, setup
 * 8. sw-register
 */

// ── Core ──
import { log } from './core/log.ts';
import { bus } from './core/events.ts';
import { initPlatform } from './core/platform.ts';
import { INSTANCE_ID } from './core/session.ts';
import { getState, snapshot } from './core/state.ts';
import { APP_STATE } from './core/constants.ts';
import { BlobURLManager } from './core/blob-manager.ts';

// ── Audio ──
import { initAudio, isAudioReady } from './audio/engine.ts';
import { applySettings, initEffectsHandlers } from './audio/effects.ts';
import { setChannelMode } from './audio/channel.ts';

// ── Network ──
import { initProtocol } from './network/protocol.ts';
import { initPeerHandlers, leaveSession } from './network/peer.ts';
import { initSync } from './network/sync.ts';
import { initRelay } from './network/relay.ts';

// ── Storage ──
import { setSyncWorker, setTransferWorker } from './storage/opfs.ts';
import { initTransfer } from './storage/transfer.ts';
import { initPreload } from './storage/preload.ts';
import { initRecovery } from './storage/recovery.ts';

// ── Player ──
import { initPlayback } from './player/playback.ts';
import { initPlaylist } from './player/playlist.ts';
import { initVideo } from './player/video.ts';
import { initMediaSession } from './player/media-session.ts';

// ── YouTube ──
import { initYouTube } from './youtube/player.ts';
import { initYouTubeSync } from './youtube/sync.ts';

// ── UI ──
import { initOverlayOpenObserver } from './ui/dom.ts';
import { initToast } from './ui/toast.ts';
import { initDialog } from './ui/dialog.ts';
import { initTabs } from './ui/tabs.ts';
import { initI18n } from './ui/i18n.ts';
import { initVisualizer } from './ui/visualizer.ts';
import { initChat } from './ui/chat.ts';
import { initPlaylistView } from './ui/playlist-view.ts';
import { initPlayerControls } from './ui/player-controls.ts';
import { initSettings } from './ui/settings.ts';
import { initSetup } from './ui/setup.ts';

// ── Service Worker ──
import { registerServiceWorker } from './sw-register.ts';

// ── System Compatibility Check ──

function checkSystemCompatibility(): void {
  // HTTPS check
  if (!window.isSecureContext) {
    bus.emit('ui:show-toast', 'HTTPS 필수: 보안 연결에서만 작동합니다.');
    log.warn('[App] Not a secure context');
  }

  // OPFS support check
  if (!(navigator.storage && navigator.storage.getDirectory)) {
    bus.emit('ui:show-toast', '브라우저를 업데이트해 주세요 (iOS 15.2+, Chrome 86+)');
    log.warn('[App] OPFS not supported');
  }

  // Vendor library check
  const errors: string[] = [];

  if (typeof (window as unknown as Record<string, unknown>).Tone === 'undefined') {
    errors.push('Tone.js (오디오 엔진)');
  }
  if (typeof (window as unknown as Record<string, unknown>).Peer === 'undefined') {
    errors.push('PeerJS (P2P 연결)');
  }

  if (errors.length > 0) {
    log.error('[App] Missing dependencies:', errors.join(', '));
    bus.emit('ui:show-toast', `필수 라이브러리를 불러오지 못했어요: ${errors.join(', ')}. 네트워크를 확인해 주세요.`);
  } else {
    log.info('[App] System compatibility check passed');
  }
}

// ── Keyboard Shortcuts ──

function initKeyboardShortcuts(): void {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    // If another handler already claimed this key, don't also treat it as a global shortcut
    if (e.defaultPrevented) return;

    // Don't intercept when focused on text input elements
    const activeTag = document.activeElement?.tagName;
    if (activeTag && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) return;

    // Don't hijack Space on interactive controls (important for a11y)
    const interactive = (e.target as Element)?.closest?.(
      'button, a, [role="button"], input, textarea, select, [contenteditable="true"]'
    );
    if ((e.key === ' ' || e.code === 'Space') && interactive) return;

    const currentState = getState<string>('appState');
    const isPlaying = currentState === APP_STATE.PLAYING_AUDIO ||
                      currentState === APP_STATE.PLAYING_VIDEO ||
                      currentState === APP_STATE.PLAYING_YOUTUBE;

    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      bus.emit('player:toggle-play');
    } else if (e.key === 'p' || e.key === 'P') {
      if (!isPlaying) bus.emit('player:toggle-play');
    } else if (e.key === 's' || e.key === 'S') {
      if (isPlaying) bus.emit('player:toggle-play');
    }
  });

  log.info('[App] Keyboard shortcuts registered');
}

// ── Wake Lock (Screen) ──

let _wakeLock: WakeLockSentinel | null = null;

async function requestWakeLock(): Promise<void> {
  try {
    if ('wakeLock' in navigator) {
      _wakeLock = await navigator.wakeLock.request('screen');
      log.debug('[App] Screen Wake Lock active');
      _wakeLock.addEventListener('release', () => {
        log.debug('[App] Screen Wake Lock released');
        _wakeLock = null;
      });
    }
  } catch (err: unknown) {
    log.warn(`[App] Wake Lock failed: ${(err as Error).name}, ${(err as Error).message}`);
  }
}

function ensureSilentAudioLoop(): void {
  const el = document.getElementById('silent-trigger') as HTMLAudioElement | null;
  if (el && el.paused) {
    el.play().catch(e => log.debug('[App] Silent audio play failed', e));
  }
}

function initWakeLock(): void {
  // Request wake lock initially
  requestWakeLock();

  // iOS fallback: keep silent audio loop alive to prevent screen sleep
  ensureSilentAudioLoop();

  // Re-request wake lock when app becomes visible (e.g. after tab switch)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (_wakeLock === null) requestWakeLock();
      ensureSilentAudioLoop();
    }
  });

  log.info('[App] Wake Lock initialized');
}

// ── Global Error Handlers ──

window.onerror = (msg, src, line, col, err) => {
  log.error(`[Global] ${msg} at ${src}:${line}:${col}`, err);
  return false;
};
window.addEventListener('unhandledrejection', (e) => {
  log.error('[Global] Unhandled rejection:', e.reason);
});

// ── Beforeunload Cleanup ──

function initBeforeUnload(): void {
  window.addEventListener('beforeunload', () => {
    try { leaveSession(); } catch { /* noop */ }
  });
}

// ── Bootstrap ──

function bootstrap(): void {
  log.info(`[App] MUSIXQUARE 2.0 bootstrap (instance: ${INSTANCE_ID})`);

  // 1. Platform detection & viewport height
  initPlatform();

  // 2. Core UI init (must run before other UI modules)
  try { initOverlayOpenObserver(); } catch { /* ignore */ }
  initToast();
  initDialog();
  initTabs();
  initI18n();

  // 3. Player & Media
  initPlayback();
  initPlaylist();
  initVideo();
  initMediaSession();

  // 4. Audio engine (deferred init — actual Tone.js init on user interaction)
  // Engine, effects, channel register bus listeners at import time
  initEffectsHandlers();

  // 5. Network (registers bus listeners; PeerJS init deferred to host/guest flow)
  // initNetwork() is called from setup.ts via createHostSessionWithShortCode() or joinSession()
  initProtocol();
  initPeerHandlers();
  initSync();
  initRelay();

  // 6. Workers & Storage
  try {
    const syncW = new Worker(
      new URL('./workers/sync.worker.ts', import.meta.url),
      { type: 'module' },
    );
    setSyncWorker(syncW);
    syncW.postMessage({ command: 'INIT_INSTANCE', instanceId: INSTANCE_ID });
    log.info('[App] SyncWorker started');
  } catch (e) {
    log.warn('[App] SyncWorker failed:', e);
  }

  let transferWorkerReady = false;
  try {
    const transferW = new Worker(
      new URL('./workers/transfer.worker.ts', import.meta.url),
      { type: 'module' },
    );
    setTransferWorker(transferW);
    transferWorkerReady = true;
    transferW.postMessage({ command: 'INIT_INSTANCE', instanceId: INSTANCE_ID });
    log.info('[App] TransferWorker started');
  } catch (e) {
    log.warn('[App] TransferWorker failed:', e);
  }

  if (transferWorkerReady) {
    initTransfer();
    initPreload();
    initRecovery();
  } else {
    log.warn('[App] Skipping transfer/preload/recovery init — worker unavailable');
  }

  // 7. YouTube
  initYouTube();
  initYouTubeSync();

  // 8. UI modules (binds DOM events)
  initVisualizer();
  initChat();
  initPlaylistView();
  initPlayerControls();
  initSettings();
  initSetup();

  // 9. Service Worker
  registerServiceWorker();

  // 10. Blob URL cleanup on disconnect
  bus.on('blob:revoke-all', () => BlobURLManager.revokeAllNow('session-end'));

  // 11. Keyboard shortcuts, Wake Lock & Cleanup
  initKeyboardShortcuts();
  initWakeLock();

  // Re-trigger silent audio on setup complete (user gesture context)
  bus.on('setup:hide-overlay', () => ensureSilentAudioLoop());

  initBeforeUnload();

  // 12. System compatibility check (deferred to not block bootstrap)
  setTimeout(checkSystemCompatibility, 100);

  // 13. Expose debug helpers on window
  const debugObj = {
    state: snapshot,
    bus,
    initAudio,
    isAudioReady,
    applySettings,
    setChannelMode,
  };
  (window as unknown as Record<string, unknown>).__MXQR = debugObj;

  log.info('[App] Bootstrap complete — all modules loaded');
}

// Run bootstrap
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
