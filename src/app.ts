/**
 * MUSIXQUARE — Application Bootstrap
 *
 * Module initialization order:
 * 1. core/   — constants, log, events, state, platform, session, blob-manager, timers
 * 2. audio/  — engine, effects, channel
 * 3. network/ — peer, protocol, sync, relay
 * 4. storage/ — storage, transfer, preload, recovery
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
import { getState, setState, snapshot } from './core/state.ts';
import { APP_STATE } from './core/constants.ts';
import { BlobURLManager } from './core/blob-manager.ts';
import { setManagedTimer } from './core/timers.ts';
import {
  initPageLifecycleHandlers,
  markIntentionalNav,
  isIntentionalNav,
} from './core/page-lifecycle.ts';

// ── Audio ──
import { initAudio, isAudioReady, getAudioContext } from './audio/engine.ts';
import { applySettings, applySettingsAsync, initEffectsHandlers } from './audio/effects.ts';
import { setChannelMode } from './audio/channel.ts';

// ── Network ──
import { initProtocol } from './network/protocol.ts';
import { initPeerHandlers, leaveSession } from './network/peer.ts';
import { initSync } from './network/sync.ts';
import { initRelay } from './network/relay.ts';
import { initOrchestrator } from './network/orchestrator.ts';
import { registerSystemCaptureListeners } from './audio/system-capture.ts';
import { registerSystemAudioHostListeners } from './network/system-audio-host.ts';
import { registerSystemAudioGuestListeners } from './network/system-audio-guest.ts';
// ── Storage ──
// RAM-only dispatches STORAGE_* commands in-process — no transfer worker.
import { initTransfer } from './storage/transfer.ts';
import { initPreload } from './storage/preload.ts';
import { initRecovery } from './storage/recovery.ts';
import { initRemoteShare } from './share/remote-share.ts';
import { setSyncWorker } from './network/sync-worker.ts';

// ── Player ──
import { initPlayback } from './player/playback.ts';
import { initPlaylist } from './player/playlist.ts';
import { initDecodeHandlers } from './player/decode.ts';
import { initMediaSession } from './player/media-session.ts';

// ── YouTube ──
import { initYouTube } from './youtube/player.ts';
import { initYouTubeSync } from './youtube/sync.ts';

// ── Audio: Beat Detection ──
import { initBeatDetector } from './audio/beat-detector.ts';

// ── UI ──
import { initOverlayObservers } from './ui/dom.ts';
import { initEmailCopyLinks } from './ui/copy-email.ts';
import { initToast } from './ui/toast.ts';
import { initDialog, showDialog } from './ui/dialog.ts';
import { initTabs } from './ui/tabs.ts';
import { initI18n } from './i18n/index.ts';
import { t } from './i18n/index.ts';
import { initVisualizer } from './ui/visualizer.ts';
import { initBeatVibration } from './ui/party-mode.ts';
import { initChat } from './ui/chat.ts';
import { initPlaylistView } from './ui/playlist-view.ts';
import { initPlayerControls } from './ui/player-controls.ts';
import { initAllCustomScrollbars } from './ui/custom-scrollbar.ts';
import { initSettings } from './ui/settings.ts';
import { initConnect } from './ui/connect.ts';
import { initSetup } from './ui/setup.ts';

// ── Service Worker ──
import { registerServiceWorker } from './sw-register.ts';
import { showToast } from './ui/toast.ts';

// ── System Compatibility Check ──

function checkSystemCompatibility(): void {
  let allPassed = true;

  // HTTPS check
  if (!window.isSecureContext) {
    allPassed = false;
    showToast(t('error.https_required'));
    log.warn('[App] Not a secure context');
  }

  if (allPassed) {
    log.info('[App] System compatibility check passed');
  }
}

// ── Keyboard Shortcuts ──

function initKeyboardShortcuts(): void {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    // If another handler already claimed this key, don't also treat it as a global shortcut
    if (e.defaultPrevented) return;

    // Don't intercept when focused on text input elements
    const active = document.activeElement;
    const activeTag = active?.tagName;
    if (activeTag && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) return;
    if (active && (active as HTMLElement).isContentEditable) return;

    // Don't hijack Space on interactive controls (important for a11y)
    const interactive = (e.target as Element)?.closest?.(
      'button, a, [role="button"], input, textarea, select, [contenteditable="true"]',
    );
    if ((e.key === ' ' || e.code === 'Space') && interactive) return;

    // Don't intercept modifier key combos (Ctrl+S, Cmd+P, etc.)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const currentState = getState('appState');
    const isPlaying =
      currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_YOUTUBE;

    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      bus.emit('player:toggle-play');
    } else if (e.key === 'p' || e.key === 'P') {
      if (!isPlaying) bus.emit('player:toggle-play');
    } else if (e.key === 's' || e.key === 'S') {
      if (isPlaying) bus.emit('player:toggle-play');
    } else if (e.key === 'c' || e.key === 'C') {
      bus.emit('ui:toggle-chat-drawer');
    }
  });

  log.info('[App] Keyboard shortcuts registered');
}

// ── Wake Lock (native API) ──
// Enabled once when session starts, never disabled.
// Re-acquired automatically when tab becomes visible again.

let _wakeLockActive = false;

async function acquireWakeLock(): Promise<void> {
  if (!('wakeLock' in navigator)) return;
  try {
    await navigator.wakeLock.request('screen');
    log.debug('[App] Wake Lock acquired');
  } catch (err) {
    log.warn('[App] Wake Lock request failed:', err);
  }
}

export function activateNoSleep(): void {
  if (_wakeLockActive) return;
  _wakeLockActive = true;
  acquireWakeLock();
}

function initWakeLock(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    // Re-acquire wake lock
    if (_wakeLockActive) acquireWakeLock();

    // iOS audio interruption recovery: resume suspended AudioContext
    if (isAudioReady()) {
      const ctx = getAudioContext();
      if (ctx && (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted')) {
        log.info(`[App] AudioContext ${ctx.state} — attempting resume`);
        ctx
          .resume()
          .then(() => {
            log.info('[App] AudioContext resumed successfully');
            const currentState = getState('appState');
            if (currentState === APP_STATE.PLAYING_AUDIO) {
              applySettingsAsync();
            }
          })
          .catch((err) => {
            log.warn('[App] AudioContext resume failed:', err);
          });
      }
    }
  });

  log.info('[App] Wake Lock initialized (native API)');
}

// ── Global Error Handlers ──

// addEventListener (not `window.onerror = ...`) so we don't clobber any
// host-injected handler the embedding wrapper (e.g. a WebView bridge)
// might have installed before our bootstrap ran.
window.addEventListener('error', (e) => {
  log.error(`[Global] ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  log.error('[Global] Unhandled rejection:', e.reason);
});

// Page-lifecycle (beforeunload / pagehide / pageshow) handling lives in
// `core/page-lifecycle.ts`. It's dependency-injected so the branching can
// be unit-tested without dragging in the full bootstrap graph. See that
// file for the rationale behind each branch and the app-wide rule about
// `markIntentionalNav()`.

// ── Back-Button Guard ──
//
// `beforeunload` above can't actually catch the back button cleanly — by the
// time the dialog shows, the browser has already begun tearing down the
// page (PeerJS DataChannel / RTCPeerConnection get pulled out from under
// us, and even if the user picks "stay", the session is unrecoverable).
//
// History API trick: when a session goes active, push one guard entry onto
// the stack. When the user presses back the browser pops that entry and
// fires `popstate` — NOT a real page unload — so the page stays intact and
// we show a custom dialog instead. On dialog confirm we call leaveSession()
// explicitly; on cancel we re-push the guard entry so the next back press
// re-fires popstate rather than escaping to the real previous page.
//
// Arming is event-driven (idle → non-idle) rather than seeded at bootstrap:
// seeding at bootstrap would make the back button in the landing/idle view
// silently consume the guard entry on first press, which looks broken.
//
// Complements (does not replace) `beforeunload`: tab close, refresh, and
// direct URL changes still route through the beforeunload confirmation.
function initBackButtonGuard(): void {
  let _confirmInFlight = false;
  let _guardActive = false;

  const seedGuard = () => {
    try {
      history.pushState({ mxqrGuard: true }, '', location.href);
      _guardActive = true;
    } catch (e) {
      log.warn('[App] Back-button guard seed failed:', e);
    }
  };

  // Arm the guard the moment we enter a session. Re-arming later (e.g.
  // role flips host↔guest mid-session) is a no-op because the guard is
  // already active.
  bus.on('state:network.appRole', () => {
    const role = getState('network.appRole');
    if (role !== 'idle' && !_guardActive) {
      seedGuard();
    }
  });

  window.addEventListener('popstate', () => {
    // Any popstate consumes a stack entry — our guard included.
    _guardActive = false;

    const role = getState('network.appRole');
    if (role === 'idle') return; // landing / not in a session
    if (_confirmInFlight) return;

    // Re-seed so the NEXT back press re-fires popstate rather than
    // escaping to the real previous page while the dialog is open.
    seedGuard();

    _confirmInFlight = true;
    void (async () => {
      try {
        const result = await showDialog({
          // "어디로" 돌아가는지는 브라우저 history에 따라 사용자마다 다르니
          // (랜딩, 외부 사이트, 빈 탭…) 문구는 "무엇이" 일어나는지만 말한다.
          title: t('dialog.return_home_title'),
          message: t('dialog.return_home_detail'),
          buttonText: t('common.leave'),
          secondaryText: t('common.stay'),
          defaultFocus: 'secondary',
        });
        if (result.action === 'ok') {
          try {
            leaveSession();
          } catch (e) {
            log.warn('[App] leaveSession failed:', e);
          }
          markIntentionalNav();
          // The user explicitly chose "leave" — actually navigate them
          // out. The history stack at this point is roughly:
          //   [referrer] → [musixquare:session] → [guard entry]
          //                                       ↑ current
          // A naïve `location.replace('/')` would only swap the current
          // entry, leaving the session entry behind:
          //   [referrer] → [musixquare:session] → [musixquare:home]
          // …so the user has to press back TWICE to actually leave the
          // app (and a forward press could resurrect the ghost session).
          //
          // `history.go(-2)` pops both the guard and the session entry
          // in one shot, landing on the referrer (the natural "before
          // musixquare" page). For users who entered directly (no
          // referrer, stack too shallow) `go(-2)` is a no-op — detect
          // that and fall back to a hard replace to the home page.
          const beforeUrl = location.href;
          try {
            history.go(-2);
          } catch {
            /* noop */
          }
          setManagedTimer(
            'app:back-button-go-fallback',
            () => {
              if (location.href === beforeUrl) {
                window.location.replace('/');
              }
            },
            150,
          );
        }
      } catch (e) {
        log.warn('[App] Back-button dialog failed:', e);
      } finally {
        _confirmInFlight = false;
      }
    })();
  });
}

// ── Bootstrap ──

function bootstrap(): void {
  log.info(`[App] MUSIXQUARE bootstrap (instance: ${INSTANCE_ID})`);

  /** Wrap an init call so a single failure doesn't crash the entire bootstrap. */
  function safeInit(name: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      log.error(`[App] ${name} init failed:`, e);
    }
  }

  // 1. Platform detection & viewport height
  safeInit('Platform', initPlatform);

  // 2. Core UI init (must run before other UI modules)
  safeInit('OverlayObservers', initOverlayObservers);
  safeInit('Toast', initToast);
  safeInit('EmailCopy', initEmailCopyLinks);
  safeInit('Dialog', initDialog);
  safeInit('Tabs', initTabs);
  safeInit('I18n', initI18n);

  // 3. Player & Media
  safeInit('Playback', initPlayback);
  safeInit('Playlist', initPlaylist);
  safeInit('DecodeHandlers', initDecodeHandlers);
  safeInit('MediaSession', initMediaSession);

  // 4. Audio engine (deferred init — Web Audio API context on user interaction)
  // Engine, effects, channel register bus listeners at import time
  safeInit('EffectsHandlers', initEffectsHandlers);
  safeInit('BeatDetector', initBeatDetector);

  // 5. Network (registers bus listeners; PeerJS init deferred to host/guest flow)
  // initNetwork() is called from setup.ts via createHostSessionWithShortCode() or joinSession()
  safeInit('Protocol', initProtocol);
  safeInit('PeerHandlers', initPeerHandlers);
  safeInit('Sync', initSync);
  safeInit('Relay', initRelay);
  safeInit('Orchestrator', initOrchestrator);
  safeInit('SystemAudioCapture', registerSystemCaptureListeners);
  safeInit('SystemAudioHost', registerSystemAudioHostListeners);
  safeInit('SystemAudioGuest', registerSystemAudioGuestListeners);
  // SharedClock init removed — managed by sync.ts (unified sync)

  // 6. Workers & Storage
  try {
    const syncW = new Worker(new URL('./workers/sync.worker.ts', import.meta.url), {
      type: 'module',
    });
    setSyncWorker(syncW);
    syncW.onerror = (ev) => log.error('[App] SyncWorker error:', ev.message || ev);
    syncW.postMessage({ command: 'INIT_INSTANCE', instanceId: INSTANCE_ID });
    log.info('[App] SyncWorker started');
  } catch (e) {
    log.warn('[App] SyncWorker failed:', e);
  }

  // RAM-only: the transfer worker is gone. STORAGE_* commands are
  // dispatched in-process by storage/storage.ts → ramstore.ts.
  // Transfer / Preload / Recovery init unconditionally — there's no
  // worker readiness gate to fail.
  safeInit('Transfer', initTransfer);
  safeInit('Preload', initPreload);
  safeInit('Recovery', initRecovery);
  safeInit('RemoteShare', initRemoteShare);

  // 7. YouTube
  safeInit('YouTube', initYouTube);
  safeInit('YouTubeSync', initYouTubeSync);

  // 8. UI modules (binds DOM events)
  safeInit('Visualizer', initVisualizer);
  safeInit('BeatVibration', initBeatVibration);
  safeInit('Chat', initChat);
  safeInit('PlaylistView', initPlaylistView);
  safeInit('PlayerControls', initPlayerControls);
  safeInit('Settings', initSettings);
  safeInit('Connect', initConnect);
  safeInit('CustomScrollbars', initAllCustomScrollbars);
  safeInit('Setup', initSetup);

  // 9. Service Worker
  safeInit('ServiceWorker', registerServiceWorker);

  // 10. Blob URL cleanup on disconnect
  bus.on('blob:revoke-all', () => BlobURLManager.revokeAllNow('session-end'));

  // 11. Keyboard shortcuts, Wake Lock & Cleanup
  safeInit('KeyboardShortcuts', initKeyboardShortcuts);
  safeInit('WakeLock', initWakeLock);
  safeInit('PageLifecycle', () =>
    initPageLifecycleHandlers({
      getRole: () => getState('network.appRole'),
      leaveSession,
      reload: () => window.location.reload(),
      log,
    }),
  );
  safeInit('BackButtonGuard', initBackButtonGuard);

  // 12. System compatibility check (deferred to not block bootstrap)
  setManagedTimer('sys-compat-check', checkSystemCompatibility, 100);

  // 13. Expose debug helpers on window (dev only)
  if (import.meta.env?.DEV) {
    const debugObj = {
      state: snapshot,
      setState,
      bus,
      initAudio,
      isAudioReady,
      applySettings,
      setChannelMode,
      // Page-lifecycle flag bindings — exposed so devtools (and preview
      // sanity probes) touch the same module instance as the bootstrap.
      markIntentionalNav,
      isIntentionalNav,
    };
    (window as unknown as Record<string, unknown>).__MXQR = debugObj;
  }

  log.info('[App] Bootstrap complete — all modules loaded');
}

// Run bootstrap
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
