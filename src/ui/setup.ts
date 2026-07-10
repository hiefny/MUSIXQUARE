/**
 * MUSIXQUARE — Setup Flow (Orchestrator)
 *
 * Manages: Setup overlay initialization, onboarding, bus event wiring,
 * and re-exports from setup-host / setup-guest / setup-shared.
 *
 * Sub-modules:
 *   setup-shared.ts  — shared state, UI helpers, constants
 *   setup-host.ts    — host session creation flow
 *   setup-guest.ts   — guest join flow
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { cancelCapabilityChallenge } from '../core/capability.ts';
import { isPlaybackModeYouTube } from '../player/ownership.ts';
import { setManagedTimer } from '../core/timers.ts';
import { onCompactLandscapeChange } from '../core/platform.ts';
import { showToast, showLoader } from './toast.ts';
import { showDialog } from './dialog.ts';
import { updateRoleBadge } from './player-controls.ts';

// ─── Sub-module imports ──────────────────────────────────────────
import { startHostFlow, setHostGoBack } from './setup-host.ts';
import {
  startGuestFlow,
  setGuestGoBack,
  handleSetupJoinWithRole,
  promptForRoomPassword,
  clearPendingRoomPasswordJoin,
} from './setup-guest.ts';
import { animateTransition } from './dom.ts';
import { markIntentionalNav } from '../core/page-lifecycle.ts';
import {
  BACK_SVG,
  syncDesktopLeftPanel,
  setupEl,
  showSetupOverlay,
  hideSetupOverlay,
  setupShowCodeArea,
  setupShowJoinArea,
  setupShowAutoJoinArea,
  setupShowRoleArea,
  setupShowWelcome,
  setupSetGuestJoinBusy,
  setupRenderActions,
  startObAutoSlide,
  updateObSlider,
  nextObSlide,
  prevObSlide,
  handleSetupRolePreview,
  // State accessors
  setCurrentObSlide,
  setPendingGuestRoleMode,
  incrementHostCodeFlowId,
  getSetupOverlayEverShown,
  getSetupOverlayAbort,
  setSetupOverlayAbort,
  getPendingGuestRoleMode,
  getPendingAutoJoinCode,
  setPendingAutoJoinCode,
} from './setup-shared.ts';

// ─── Role Selection Buttons ──────────────────────────────────────

function showRoleSelectionButtons(): void {
  setupRenderActions(
    [
      {
        id: 'btn-setup-host',
        text: t('setup.host_button'),
        kind: 'primary',
        onClick: startHostFlow,
      },
      {
        id: 'btn-setup-guest',
        text: t('setup.guest_button'),
        kind: 'secondary',
        onClick: startGuestFlow,
      },
    ],
    'vertical',
  );
}

// ─── App Entrance Animation ─────────────────────────────────────

/** Entrance config: [selector, direction, delay_ms] */
const ENTRANCE_TARGETS: [string, string, number][] = [
  ['#main-header', 'down', 0],
  ['#visualizerCanvas', 'up', 50],
  ['.track-box', 'up', 100],
  ['.progress-bar', 'up', 150],
  ['.play-controls-left', 'up', 200],
  ['#chat-preview-btn', 'up', 300],
  ['.play-action-buttons', 'up', 350],
  ['.bottom-nav', 'up', 400],
  // Desktop panels (mobile ones are display:none, harmless)
  ['#tab-playlist', 'down', 100],
  ['#tab-settings', 'left', 150],
];

function _applyEntranceClasses(): void {
  for (const [sel, dir, delay] of ENTRANCE_TARGETS) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) continue;
    el.classList.add('app-entrance', `app-entrance-${dir}`);
    el.classList.remove('app-entered');
    el.style.setProperty('--entrance-delay', `${delay}ms`);
  }
}

function triggerAppEntrance(): void {
  requestAnimationFrame(() => {
    for (const [sel] of ENTRANCE_TARGETS) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) el.classList.add('app-entered');
    }
    // Desktop chat: separate animation (mobile drawer conflicts with app-entrance)
    const chatDrawer = document.querySelector('.chat-drawer') as HTMLElement | null;
    if (chatDrawer && window.matchMedia('(min-width: 1280px)').matches) {
      chatDrawer.classList.add('app-chat-entrance');
    }
    // Cleanup after all transitions complete
    setManagedTimer(
      'app-entrance-cleanup',
      () => {
        for (const [sel] of ENTRANCE_TARGETS) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) {
            el.classList.remove(
              'app-entrance',
              'app-entrance-down',
              'app-entrance-up',
              'app-entrance-left',
              'app-entrance-right',
              'app-entered',
            );
            el.style.removeProperty('--entrance-delay');
          }
        }
        if (chatDrawer) chatDrawer.classList.remove('app-chat-entrance');
        // Wake visualizer after layout settles (iOS: canvas may have been 0-sized during setup)
        bus.emit('visualizer:start');
      },
      1200,
    ); // max delay(400) + duration(900) + buffer
  });
}

// ─── Init Setup Overlay ──────────────────────────────────────────

function initSetupOverlay(): void {
  cancelCapabilityChallenge('Setup flow cancelled');

  // Abort previous setup overlay listeners to prevent accumulation
  const prevAbort = getSetupOverlayAbort();
  if (prevAbort) prevAbort.abort();
  const abort = new AbortController();
  setSetupOverlayAbort(abort);
  const signal = abort.signal;

  incrementHostCodeFlowId();
  setPendingAutoJoinCode(null); // Clear auto-join code when returning to onboarding
  const sliderArea = setupEl('ob-slider-area');
  if (sliderArea) sliderArea.style.display = 'block';

  // Single transition for the role/code/join→welcome swap so the
  // four DOM flips snapshot together instead of aborting each other.
  animateTransition(() => {
    setupShowCodeArea(false);
    setupShowJoinArea(false);
    setupShowAutoJoinArea(false);
    setupShowRoleArea(false);
    setupShowWelcome(true);
  });
  setupSetGuestJoinBusy(false);

  setState('network.appRole', 'idle');
  setState('network.sessionCode', '');
  setState('network.roomPasswordRequired', false);
  setState('network.roomPassword', '');
  setCurrentObSlide(0);
  setState('setup.sessionStarted', false);
  setPendingGuestRoleMode(null);

  updateRoleBadge();
  updateObSlider();
  showRoleSelectionButtons();

  const showAndStart = () => {
    showSetupOverlay();
    startObAutoSlide();
  };

  if (!getSetupOverlayEverShown()) {
    try {
      document.documentElement.classList.add('setup-boot-block');
    } catch {
      /* ignore */
    }
  }

  // Apply entrance animation classes to main UI elements
  _applyEntranceClasses();

  showAndStart();

  // Bind slider events (use addEventListener with signal for proper cleanup)
  const btnNext = setupEl('ob-next');
  if (btnNext) btnNext.addEventListener('click', () => nextObSlide(false), { signal });
  const btnPrev = setupEl('ob-prev');
  if (btnPrev) btnPrev.addEventListener('click', () => prevObSlide(), { signal });

  document.querySelectorAll<HTMLElement>('.ob-dot').forEach((dot) => {
    dot.addEventListener(
      'click',
      (e) => {
        const dotEl = (e.target as HTMLElement).closest('.ob-dot') as HTMLElement | null;
        const idx = parseInt(dotEl?.dataset?.idx || '', 10);
        if (isNaN(idx)) return;
        setCurrentObSlide(idx);
        updateObSlider();
        startObAutoSlide();
      },
      { signal },
    );
  });

  // Swipe (addEventListener + passive for better scroll perf)
  const viewport = setupEl('ob-slider-viewport');
  if (viewport) {
    let startX = 0;
    viewport.addEventListener(
      'touchstart',
      (e: Event) => {
        startX = (e as TouchEvent).touches?.[0]?.clientX ?? 0;
      },
      { passive: true, signal },
    );
    viewport.addEventListener(
      'touchend',
      (e: Event) => {
        const endX = (e as TouchEvent).changedTouches?.[0]?.clientX;
        if (endX == null) return;
        const diff = startX - endX;
        if (Math.abs(diff) > 50) {
          if (diff > 0) nextObSlide(false);
          else prevObSlide();
        }
      },
      { signal },
    );
  }
}

// ─── Wire goBack callbacks ───────────────────────────────────────
// Host/guest sub-modules need to navigate back to the onboarding screen,
// but cannot import initSetupOverlay (that would create a circular dep).
// We inject the callback at init time.
setHostGoBack(initSetupOverlay);
setGuestGoBack(initSetupOverlay);

// ─── Public Init ─────────────────────────────────────────────────

export function initSetup(): void {
  // Desktop / compact landscape layout listener
  try {
    const mqlDesktop = window.matchMedia('(min-width: 1280px)');
    mqlDesktop.addEventListener('change', () => syncDesktopLeftPanel());
    onCompactLandscapeChange(() => syncDesktopLeftPanel());
  } catch {
    /* ignore */
  }

  // Role grid click handler (event delegation)
  const roleGrid = document.getElementById('setup-role-grid');
  if (roleGrid) {
    roleGrid.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.ch-opt') as HTMLElement | null;
      if (!item) return;
      const mode = parseInt(item.dataset.joinCh || '', 10);
      if (isNaN(mode)) return;
      handleSetupRolePreview(mode);
    });
  }

  // SVG speaker click
  function handleSpeakerClick(e: Event): void {
    const item = (e.target as HTMLElement).closest('.graphic-speaker') as HTMLElement | null;
    if (!item) return;
    const SVG_ID_TO_MODE: Record<string, number> = {
      'svg-spk-l': -1,
      'svg-spk-r': 1,
      'svg-spk-center': 0,
      'svg-spk-woofer': 2,
    };
    const roleMode = item.dataset.roleMode;
    const mode = roleMode !== undefined ? Number(roleMode) : SVG_ID_TO_MODE[item.id];
    if (Number.isFinite(mode)) handleSetupRolePreview(mode);
  }

  const roleArea = document.getElementById('setup-role-area');
  if (roleArea) roleArea.addEventListener('click', handleSpeakerClick);
  const desktopDiagramArea = document.getElementById('desktop-diagram-area');
  if (desktopDiagramArea) desktopDiagramArea.addEventListener('click', handleSpeakerClick);

  // Setup join code input
  const joinInput = document.getElementById('setup-join-code') as HTMLInputElement | null;
  if (joinInput) {
    joinInput.addEventListener('input', () => {
      const raw = joinInput.value || '';
      const digits = raw.replace(/\D+/g, '').slice(0, 6);
      if (raw !== digits) joinInput.value = digits;
    });
    joinInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const mode = getPendingGuestRoleMode();
      if (mode !== null) {
        handleSetupJoinWithRole(mode);
      }
    });
  }

  // PeerJS ready (peer ID assigned)
  bus.on('network:peer-ready', () => {
    updateRoleBadge();
  });

  // Guest join success/failure events
  bus.on('setup:guest-join-success', () => {
    setState('network.isConnecting', false);
    clearPendingRoomPasswordJoin();

    // Mark session as started so guests can see QR / invite link in Connect tab
    setState('setup.sessionStarted', true);
    const joinCode = getState('network.lastJoinCode');
    // Defense-in-depth: every legitimate writer of lastJoinCode (setup-guest.ts:174, 263)
    // already gates on /^\d{6}$/, but re-check at the sessionCode sink so a future
    // joinSession() caller that skips the format check can't poison the session
    // code that gets composed into the share URL at connect.ts:71.
    if (joinCode && /^\d{6}$/.test(joinCode)) setState('network.sessionCode', joinCode);

    updateRoleBadge();
    hideSetupOverlay();
    // Clear pending join code & clean URL — connection succeeded
    setPendingAutoJoinCode(null);
    try {
      if (/^\/\d{6}$/.test(window.location.pathname)) {
        window.history.replaceState({}, '', '/' + window.location.hash);
      }
    } catch {
      /* noop */
    }
  });

  // Restore the guest join UI (re-enable the code input / re-show actions, hide
  // loader, clear busy) after a failed OR cancelled join. The toast is the
  // caller's responsibility, so a user-initiated cancel can restore silently.
  const restoreGuestJoinInputUI = () => {
    setState('network.isConnecting', false);
    updateRoleBadge();

    // Always hide loader — auto-reconnect flow shows loader before joinSession,
    // so we must hide it on failure to prevent permanent loader display (#103).
    showLoader(false);

    if (getPendingAutoJoinCode()) {
      // Invite-link flow: go back to role selection (no code input step)
      startGuestFlow();
    } else {
      // Normal flow: re-show code input with editable field
      setupRenderActions(
        [
          {
            id: 'btn-setup-back',
            html: BACK_SVG,
            kind: 'icon-only',
            onClick: () => startGuestFlow(),
          },
          {
            id: 'btn-setup-confirm',
            text: t('common.start'),
            kind: 'primary',
            onClick: () => handleSetupJoinWithRole(getPendingGuestRoleMode() ?? null),
          },
        ],
        'horizontal-with-back',
      );

      const input = setupEl('setup-join-code') as HTMLInputElement | null;
      if (input) {
        input.disabled = false;
        input.focus();
      }
    }
    setupSetGuestJoinBusy(false);
  };

  bus.on('setup:guest-join-failure', () => {
    restoreGuestJoinInputUI();
    // network:error already selected and displayed the specific failure
    // (missing room, password, signaling outage, etc.) before emitting this
    // UI-reset event. A second generic toast here used to overwrite that
    // diagnosis with "session not found", hiding protocol/deploy regressions.
  });

  // F-2401: a user-cancelled capability/Turnstile challenge mid-join restores the
  // join UI WITHOUT a red error toast (the cancel is intentional, not a failure).
  bus.on('setup:guest-join-cancelled', () => {
    restoreGuestJoinInputUI();
  });

  // App entrance animation trigger
  bus.on('setup:app-entrance', () => {
    triggerAppEntrance();
  });

  // Network error handling (connection failures, timeouts, etc.)
  bus.on('network:error', (error) => {
    const err = error as Record<string, unknown> | null;
    const msg = (err as Error | null)?.message || '';
    const peerType = err && typeof err === 'object' ? String(err.type || '') : '';
    let userMsg = t('error.network_generic');
    const isRoomPasswordRequired =
      msg === 'ROOM_PASSWORD_REQUIRED' || peerType === 'room-password-required';
    const isRoomPasswordInvalid =
      msg === 'ROOM_PASSWORD_INVALID' || peerType === 'room-password-invalid';
    const isRoomPasswordAuthTimeout =
      msg === 'ROOM_PASSWORD_AUTH_TIMEOUT' || peerType === 'room-password-auth-timeout';
    const isRoomFull = msg === 'ROOM_GUEST_LIMIT_REACHED' || peerType === 'room-full';

    if (isRoomPasswordRequired || isRoomPasswordInvalid || isRoomPasswordAuthTimeout) {
      setState('network.isConnecting', false);
      updateRoleBadge();
      showLoader(false);
      if (isRoomPasswordAuthTimeout) {
        showToast(t('error.room_password_auth_timeout'));
      }
      const reason: 'required' | 'invalid' | 'timeout' = isRoomPasswordInvalid
        ? 'invalid'
        : isRoomPasswordAuthTimeout
          ? 'timeout'
          : 'required';
      promptForRoomPassword(reason).catch((e) =>
        log.warn('[Setup] Room password dialog error:', e),
      );
      return;
    }

    // Our custom error messages
    if (isRoomFull) userMsg = t('network.session_full');
    else if (msg === 'HOST_UNREACHABLE') userMsg = t('error.host_unreachable');
    else if (msg === 'HOST_DISCONNECTED') userMsg = t('error.host_disconnected');
    else if (msg === 'HOST_CONNECTION_ERROR') userMsg = t('error.host_conn_error');
    else if (msg === 'CONNECT_FAILED') userMsg = t('error.connect_failed');
    else if (msg === 'PEER_NOT_READY') userMsg = t('error.peer_not_ready');
    else if (msg === 'NETWORK_INIT_FAILED') userMsg = t('error.network_init_failed');
    else if (msg === 'NO_HOST_ID') userMsg = t('error.no_host_id');
    // PeerJS native error types
    else if (peerType === 'peer-unavailable') {
      // Context-aware: if this is a post-reconnect attempt (flag set by the
      // dialog handler before the hard-reset reload), the user clicked
      // Reconnect — not "I typed a code". Telling them to "double-check the
      // code" misleads. Show "host left" instead.
      let isReconnectAttempt = false;
      try {
        isReconnectAttempt = !!sessionStorage.getItem('mxqr_reconnect_target');
        sessionStorage.removeItem('mxqr_reconnect_target');
      } catch {
        /* noop */
      }
      userMsg = isReconnectAttempt ? t('error.host_left') : t('error.peer_unavailable');
    } else if (peerType === 'network') userMsg = t('error.network_issue');
    else if (peerType === 'server-error') userMsg = t('error.signal_server_fail');
    else if (peerType === 'socket-error' || peerType === 'socket-closed')
      userMsg = t('error.server_disconnected');
    else if (peerType === 'unavailable-id') userMsg = t('error.session_id_unavailable');
    else if (peerType === 'webrtc') userMsg = t('error.webrtc_failed');
    else if (peerType === 'browser-incompatible') userMsg = t('error.browser_unsupported');
    else if (peerType === 'ssl-unavailable') userMsg = t('error.ssl_required');
    else if (peerType === 'disconnected') userMsg = t('error.server_disconnected');
    else if (peerType === 'invalid-id') userMsg = t('error.session_id_unavailable');
    else if (peerType === 'invalid-key') userMsg = t('error.signal_server_fail');

    const isConnecting = getState('network.isConnecting');
    if (isConnecting) {
      // Still trying to join — emit failure for UI reset
      showToast(userMsg);
      bus.emit('setup:guest-join-failure', err);
    } else if (msg === 'HOST_DISCONNECTED' || msg === 'HOST_CONNECTION_ERROR') {
      // Clean up YouTube mode immediately — host is gone, no YOUTUBE_STOP will arrive
      if (isPlaybackModeYouTube()) {
        bus.emit('youtube:stop-mode');
      }
      // Post-connection disconnect: show dialog + re-enable join
      showDialog({
        title: t('network.disconnected'),
        message: `${userMsg}\n${t('dialog.reconnect_ask')}`,
        buttonText: t('dialog.reconnect'),
        secondaryText: t('dialog.go_back'),
      })
        .then((res) => {
          if (res.action === 'ok') {
            // Hard-reset reconnect: reload the page and auto-join via the
            // /CODE path. This guarantees a pristine state — no stale timers,
            // PeerJS connections, audio contexts, or sync runtime leftovers.
            // The auto-join URL detection in initSetupOverlay picks up the
            // code on bootstrap and enters guest flow automatically.
            const lastCode = getState('network.lastJoinCode') || '';
            // Defense-in-depth: re-validate format at the URL navigation sink.
            // Writers in setup-guest.ts already gate on /^\d{6}$/, but a future
            // joinSession() caller that bypasses validation could let lastCode
            // contain "../foo" — interpolated into `/` + lastCode it would
            // navigate off-origin or to an unintended path.
            if (lastCode && /^\d{6}$/.test(lastCode)) {
              log.info(`[Setup] Hard-reset reconnect → /${lastCode}`);
              // Mark this as a reconnect attempt — read after reload by the
              // peer-unavailable error branch to swap the misleading "check
              // your code" message for "host left".
              try {
                sessionStorage.setItem('mxqr_reconnect_target', lastCode);
              } catch {
                /* noop */
              }
              showLoader(true, t('setup.joining'));
              setManagedTimer(
                'reconnect-hard-reload',
                () => {
                  markIntentionalNav();
                  window.location.href = '/' + lastCode;
                },
                300,
              );
            } else {
              startGuestFlow();
            }
          } else {
            showLoader(true, t('dialog.leaving_session'));
            setManagedTimer(
              'reconnect-dialog-reload',
              () => {
                markIntentionalNav();
                window.location.reload();
              },
              300,
            );
          }
        })
        .catch((e) => log.warn('[Setup] Reconnect dialog error:', e));
    } else {
      showToast(userMsg);
      // If we're in guest setup flow but isConnecting was already cleared
      // (race condition), still reset the UI so the user isn't stuck (#102).
      const appRole = getState('network.appRole');
      if (appRole === 'guest' && !getState('setup.sessionStarted')) {
        bus.emit('setup:guest-join-failure', err);
      }
    }
  });

  // Session full (guest rejected by full host)
  bus.on('network:session-full', (msg) => {
    const message = (msg as string) || t('network.session_full');
    showSetupOverlay();
    startGuestFlow();
    showDialog({ title: t('network.session_full'), message: String(message) });
  });

  // Kicked from session (guest removed from host device list)
  bus.on('network:kicked-from-session', () => {
    showToast(t('toast.host_ended_connection'));
    showLoader(true, t('dialog.leaving_session'));
    setManagedTimer(
      'kicked-from-session-reload',
      () => {
        markIntentionalNav();
        window.location.reload();
      },
      300,
    );
  });

  // Explicitly kicked by host (MSG.KICK_DEVICE)
  bus.on('network:kicked-explicitly', () => {
    showDialog({
      title: t('connect.kicked_title'),
      message: t('connect.kicked_message'),
      buttonText: t('common.ok'),
      dismissible: false,
    })
      .catch((e) => log.warn('[Setup] Kick dialog error:', e))
      .finally(() => {
        showLoader(true, t('dialog.leaving_session'));
        setManagedTimer(
          'kicked-explicit-reload',
          () => {
            markIntentionalNav();
            window.location.reload();
          },
          300,
        );
      });
  });

  // Check for /CODE path (e.g. musixquare.com/123456)
  try {
    // Wipe any leftover join code from a previous (crashed/abandoned) session
    try {
      sessionStorage.removeItem('mxqr_pending_join');
    } catch {
      /* noop */
    }

    const pathMatch = window.location.pathname.match(/^\/(\d{6})$/);
    const joinCode = pathMatch?.[1] || '';

    if (joinCode && /^\d{6}$/.test(joinCode)) {
      log.info(`[Setup] Auto-join code detected: ${joinCode}`);
      setPendingAutoJoinCode(joinCode);

      // Show overlay first, then jump to guest role selection
      setManagedTimer(
        'auto-join-start',
        () => {
          showSetupOverlay();
          startGuestFlow();
        },
        200,
      );
    } else {
      // Normal flow: show setup overlay
      initSetupOverlay();
    }
  } catch {
    initSetupOverlay();
  }

  log.info('[Setup] Initialized');
}
