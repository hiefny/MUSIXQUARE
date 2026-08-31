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
import { isLazyFeatureLoadError } from '../core/lazy-feature-failure.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { cancelCapabilityChallenge } from '../core/capability.ts';
import { isPlaybackModeYouTube } from '../player/ownership.ts';
import { requestProRoomTransportRecovery } from '../pro-room/transport-recovery.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { onCompactLandscapeChange } from '../core/platform.ts';
import { showToast, showLoader } from './toast.ts';
import { showDialog } from './dialog.ts';
import { updateRoleBadge } from './player-controls.ts';
import { openLanguageDialog } from './settings.ts';

// ─── Sub-module imports ──────────────────────────────────────────
import { startHostFlow, setHostGoBack } from './setup-host.ts';
import {
  startGuestFlow,
  setGuestGoBack,
  handleSetupJoinWithRole,
  promptForRoomPassword,
  clearPendingRoomPasswordJoin,
  restoreGuestJoinControlsAfterFailure,
} from './setup-guest.ts';
import { animateTransition } from './dom.ts';
import { scheduleDocumentReload, scheduleSessionReset } from '../core/session-reset.ts';
import { cancelPendingSessionSetup } from '../network/peer.ts';
import {
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
  setupSetGuestJoinError,
  setupRenderActions,
  initObCarousel,
  notifyObCarouselGreetingReady,
  updateObSlider,
  handleSetupRolePreview,
  // State accessors
  setCurrentObSlide,
  setPendingGuestRoleMode,
  incrementHostCodeFlowId,
  getSetupOverlayEverShown,
  getSetupOverlayAbort,
  setSetupOverlayAbort,
  getPendingGuestRoleMode,
  setPendingAutoJoinCode,
} from './setup-shared.ts';
import { isProRoomCode } from '../pro-room/room-code.ts';
import { scheduleStandardRoomPrerequisiteWarmup } from '../network/standard-room-prerequisites.ts';
import { bindOnboardingDebugGesture } from './onboarding-debug-gesture.ts';
import { initOnboardingDiagnostics, openOnboardingDiagnostics } from './onboarding-diagnostics.ts';

function startSetupJoinWithRole(mode: number): void {
  handleSetupJoinWithRole(mode).catch((error) => {
    log.error('[Setup] Guest join operation escaped its flow boundary', error);
    bus.emit('setup:guest-join-failure', {
      error,
      userMessage: t('error.network_generic'),
    });
  });
}

// ─── Host / Guest Choice ─────────────────────────────────────────

function showHostGuestSelection(): void {
  setupRenderActions(
    [
      {
        id: 'btn-setup-host',
        textKey: 'setup.host_button',
        kind: 'primary',
        onClick: startHostFlow,
      },
      {
        id: 'btn-setup-guest',
        textKey: 'setup.guest_button',
        kind: 'secondary',
        onClick: startGuestFlow,
      },
    ],
    'vertical',
  );
}

// ─── App Entrance Animation ─────────────────────────────────────

type EntranceDirection = 'down' | 'up' | 'right' | 'left';

/** Entrance config: [selector, direction, delay_ms, desktop_only] */
const ENTRANCE_TARGETS: [string, EntranceDirection, number, boolean?][] = [
  ['#main-header', 'down', 0],
  ['#visualizerCanvas', 'up', 50],
  ['.track-title-wrapper', 'up', 100],
  ['#track-artist', 'up', 150],
  ['.progress-bar', 'up', 200],
  ['.play-controls-left', 'up', 250],
  ['#chat-preview-btn', 'up', 300],
  ['.play-action-buttons', 'up', 350],
  ['.bottom-nav', 'up', 400],
  // Desktop panels and settings cascade. Keeping the settings shell stationary
  // avoids compounding parent/child transforms while its contents sweep in.
  ['#tab-playlist', 'down', 100, true],
  ['#tab-settings > .tab-header', 'left', 100, true],
  ['#tab-settings > .settings-subtab-nav', 'left', 125, true],
  ['#settings-language-section', 'left', 150, true],
  ['#theme-section', 'left', 230, true],
  ['#ui-sounds-section', 'left', 310, true],
  ['#settings-sync-section', 'left', 400, true],
];

function clearEntranceClasses(el: HTMLElement): void {
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

function _applyEntranceClasses(): void {
  const isDesktop = window.matchMedia('(min-width: 1280px)').matches;
  for (const [sel, dir, delay, desktopOnly] of ENTRANCE_TARGETS) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) continue;
    if (desktopOnly && !isDesktop) {
      clearEntranceClasses(el);
      continue;
    }
    el.classList.add('app-entrance', `app-entrance-${dir}`);
    el.classList.remove('app-entered');
    el.style.setProperty('--entrance-delay', `${delay}ms`);
  }
}

function triggerAppEntrance(): void {
  requestAnimationFrame(() => {
    const isDesktop = window.matchMedia('(min-width: 1280px)').matches;
    for (const [sel, , , desktopOnly] of ENTRANCE_TARGETS) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && desktopOnly && !isDesktop) {
        clearEntranceClasses(el);
        continue;
      }
      if (el?.classList.contains('app-entrance')) el.classList.add('app-entered');
    }
    // Desktop chat: separate animation (mobile drawer conflicts with app-entrance)
    const chatDrawer = document.querySelector('.chat-drawer') as HTMLElement | null;
    if (chatDrawer && window.matchMedia('(min-width: 1280px)').matches) {
      chatDrawer.classList.add('app-chat-entrance');
    }
    // Cleanup just after the 1200ms visual timeline completes. Reduced-motion
    // users skip both the motion and its stagger, so release the classes early.
    const cleanupDelay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 50 : 1250;
    setManagedTimer(
      'app-entrance-cleanup',
      () => {
        for (const [sel] of ENTRANCE_TARGETS) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) clearEntranceClasses(el);
        }
        if (chatDrawer) chatDrawer.classList.remove('app-chat-entrance');
        // Wake visualizer after layout settles (iOS: canvas may have been 0-sized during setup)
        bus.emit('visualizer:start');
      },
      cleanupDelay,
    ); // max delay(400) + duration(800) + a small frame buffer
  });
}

// ─── Init Setup Overlay ──────────────────────────────────────────

const SETUP_GREETING_DELAY_MS = 0;
const SETUP_LOGO_DRAW_BASE_DELAY_MS = 500;
const SETUP_GREETING_FALLBACK_BUFFER_MS = 300;
const SETUP_GREETING_REVEAL_TIMER = 'setup-greeting-reveal';
const SETUP_GREETING_FALLBACK_TIMER = 'setup-greeting-fallback';

function revealSetupGreeting(): void {
  document.querySelectorAll<HTMLElement>('.setup-brand-greeting-stage').forEach((stage) => {
    stage.classList.add('is-greeting-visible');
    stage.querySelector<SVGElement>('.logo-welcome')?.setAttribute('aria-hidden', 'true');
  });
  document.querySelectorAll<HTMLElement>('.setup-greeting-row').forEach((row) => {
    row.classList.add('is-visible');
    row.setAttribute('aria-hidden', 'false');
  });
  notifyObCarouselGreetingReady();
}

function armSetupGreeting(signal: AbortSignal): void {
  clearManagedTimer(SETUP_GREETING_REVEAL_TIMER);
  clearManagedTimer(SETUP_GREETING_FALLBACK_TIMER);

  const greetingRows = document.querySelectorAll<HTMLElement>('.setup-greeting-row');
  if (greetingRows.length === 0) return;
  if (Array.from(greetingRows).some((row) => row.classList.contains('is-visible'))) {
    revealSetupGreeting();
    return;
  }

  const clearGreetingTimers = () => {
    clearManagedTimer(SETUP_GREETING_REVEAL_TIMER);
    clearManagedTimer(SETUP_GREETING_FALLBACK_TIMER);
  };
  signal.addEventListener('abort', clearGreetingTimers, { once: true });

  const revealAfterDelay = () => {
    setManagedTimer(SETUP_GREETING_REVEAL_TIMER, revealSetupGreeting, SETUP_GREETING_DELAY_MS);
  };

  let reducedMotion = false;
  try {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    /* Fall through to the animation-driven path. */
  }
  if (reducedMotion) {
    revealAfterDelay();
    return;
  }

  let longestDrawMs = 0;
  document.querySelectorAll<SVGSVGElement>('.logo-welcome').forEach((logo) => {
    logo.querySelectorAll<SVGElement>(':scope > .wl').forEach((stroke) => {
      const startMs = Number(stroke.dataset.wt) || 0;
      const durationMs = Number(stroke.dataset.wd) || 0;
      const endMs = startMs + durationMs;
      longestDrawMs = Math.max(longestDrawMs, endMs);
    });
  });

  let drawCompleted = false;
  const handleFinalDraw = (event: AnimationEvent) => {
    const stroke = event.target;
    if (!(stroke instanceof SVGElement) || !stroke.matches('.logo-welcome > .wl')) return;
    const endMs = (Number(stroke.dataset.wt) || 0) + (Number(stroke.dataset.wd) || 0);
    if (drawCompleted || endMs < longestDrawMs) return;
    drawCompleted = true;
    clearManagedTimer(SETUP_GREETING_FALLBACK_TIMER);
    revealAfterDelay();
  };
  document.addEventListener('animationend', handleFinalDraw, { signal });

  const fallbackMs =
    SETUP_LOGO_DRAW_BASE_DELAY_MS +
    longestDrawMs +
    SETUP_GREETING_DELAY_MS +
    SETUP_GREETING_FALLBACK_BUFFER_MS;
  setManagedTimer(SETUP_GREETING_FALLBACK_TIMER, revealSetupGreeting, fallbackMs);
}

function initSetupOverlay(): void {
  // This callback is wired only to pre-session setup controls. Refuse to
  // downgrade a live room to `idle` if a future caller invokes it by mistake;
  // active sessions must leave through the explicit hard-reset flow instead.
  if (getState('setup.sessionStarted')) {
    log.warn('[Setup] Ignored onboarding reset while a session is active');
    return;
  }

  cancelCapabilityChallenge('Setup flow cancelled');

  // The setup back action is a soft UI reset, but a provisional signaling
  // identity may already exist. Mark the flow idle first so any in-flight
  // network initialization self-cancels, then explicitly release resources
  // that have already opened.
  setState('network.appRole', 'idle');
  cancelPendingSessionSetup();
  setState('setup.sessionStarted', false);

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

  setState('network.sessionCode', '');
  setState('network.roomPasswordRequired', false);
  setState('network.roomPassword', '');
  setCurrentObSlide(0);
  setPendingGuestRoleMode(null);

  updateRoleBadge();
  updateObSlider();
  showHostGuestSelection();

  if (!getSetupOverlayEverShown()) {
    try {
      document.documentElement.classList.add('setup-boot-block');
    } catch {
      /* ignore */
    }
  }

  // Apply entrance animation classes to main UI elements
  _applyEntranceClasses();

  showSetupOverlay();
  armSetupGreeting(signal);
  scheduleStandardRoomPrerequisiteWarmup();
  initObCarousel(signal);
  bindOnboardingDebugGesture({
    // Keep the hidden support gesture on the passive slide viewport so rapid
    // use of Prev/Next/dots can never count as a developer unlock sequence.
    target: setupEl('ob-slider-viewport'),
    signal,
    onOpen: openOnboardingDiagnostics,
  });

  setupEl('setup-overlay')?.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('[data-setup-language-trigger]')) return;
      openLanguageDialog(event);
    },
    { signal },
  );
}

// ─── Wire goBack callbacks ───────────────────────────────────────
// Host/guest sub-modules need to navigate back to the onboarding screen,
// but cannot import initSetupOverlay (that would create a circular dep).
// We inject the callback at init time.
setHostGoBack(initSetupOverlay);
setGuestGoBack(initSetupOverlay);

// ─── Public Init ─────────────────────────────────────────────────

export function initSetup(): void {
  initOnboardingDiagnostics();

  // Desktop / compact landscape layout listener
  try {
    const mqlDesktop = window.matchMedia('(min-width: 1280px)');
    mqlDesktop.addEventListener('change', () => {
      syncDesktopLeftPanel();
      if (setupEl('setup-overlay')?.classList.contains('active')) {
        _applyEntranceClasses();
      }
    });
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
      setupSetGuestJoinError(null);
      const raw = joinInput.value || '';
      const digits = raw.replace(/\D+/g, '').slice(0, 6);
      if (raw !== digits) joinInput.value = digits;
    });
    joinInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const mode = getPendingGuestRoleMode();
      if (mode !== null) {
        startSetupJoinWithRole(mode);
      }
    });
  }

  // Network peer ready (signaling identity assigned).
  bus.on('network:peer-ready', () => {
    updateRoleBadge();
  });

  // Guest join success/failure events
  bus.on('setup:guest-join-success', () => {
    setState('network.isConnecting', false);
    clearPendingRoomPasswordJoin();
    setupSetGuestJoinError(null);
    try {
      sessionStorage.removeItem('mxqr_reconnect_target');
    } catch {
      /* noop */
    }

    // Mark session as started so guests can see QR / invite link in Connect tab
    setState('setup.sessionStarted', true);
    const joinCode = getState('network.lastJoinCode');
    // Defense-in-depth: every legitimate writer of lastJoinCode in setup-guest.ts
    // already gates on /^\d{6}$/, but re-check at the sessionCode sink so a future
    // joinSession() caller that skips the format check can't poison the session
    // code that gets composed into the share URL in connect.ts.
    if (joinCode && /^\d{6}$/.test(joinCode)) setState('network.sessionCode', joinCode);
    const isProRoom = isProRoomCode(joinCode);

    updateRoleBadge();
    hideSetupOverlay();
    // Clear pending join code & clean URL — connection succeeded
    setPendingAutoJoinCode(null);
    try {
      if (!isProRoom && /^\/\d{6}\/?$/.test(window.location.pathname)) {
        window.history.replaceState({}, '', '/' + window.location.hash);
      }
    } catch {
      /* noop */
    }
  });

  // Restore the guest join UI after a failed OR cancelled join. Failures keep
  // their diagnosis and explicit retry action on the same screen; a
  // user-initiated cancel restores silently.
  const restoreGuestJoinInputUI = (message: string | null) => {
    setState('network.isConnecting', false);
    updateRoleBadge();

    // Always hide the loader: auto-reconnect shows it before joinSession, so a
    // failure must clear it rather than leave the setup UI permanently busy.
    showLoader(false);
    restoreGuestJoinControlsAfterFailure(message);
  };

  bus.on('setup:guest-join-failure', (failure) => {
    if (isLazyFeatureLoadError(failure.error)) {
      setState('network.isConnecting', false);
      updateRoleBadge();
      showLoader(false);
      restoreGuestJoinControlsAfterFailure(t('dialog.sw_update_msg'), true);
      return;
    }
    restoreGuestJoinInputUI(failure.userMessage);
  });

  // A user-cancelled capability/Turnstile challenge mid-join restores the
  // join UI WITHOUT a red error toast (the cancel is intentional, not a failure).
  bus.on('setup:guest-join-cancelled', () => {
    restoreGuestJoinInputUI(null);
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
    if (isLazyFeatureLoadError(error)) {
      setState('network.isConnecting', false);
      updateRoleBadge();
      showLoader(false);
      restoreGuestJoinControlsAfterFailure(t('dialog.sw_update_msg'), true);
      return;
    }
    if (
      (msg === 'HOST_DISCONNECTED' || msg === 'HOST_CONNECTION_ERROR') &&
      requestProRoomTransportRecovery()
    ) {
      // A coordinator-free PRO room outlives any one transport connection.
      // Keep media/playlist/UI intact while the runtime reconnects its
      // server control channel.
      return;
    }
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
    // Provider-compatible connection error types.
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
      bus.emit('setup:guest-join-failure', { error: err, userMessage: userMsg });
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
            // transport connections, audio contexts, or sync runtime leftovers.
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
              scheduleSessionReset(t('dialog.refreshing_session'), () => {
                window.location.href = '/' + lastCode;
              });
            } else {
              startGuestFlow();
            }
          } else {
            scheduleDocumentReload(t('dialog.leaving_session'));
          }
        })
        .catch((e) => log.warn('[Setup] Reconnect dialog error:', e));
    } else {
      // If guest setup already cleared isConnecting in a race, still reset the
      // UI so the user is not left in a non-interactive state.
      const appRole = getState('network.appRole');
      if (appRole === 'guest' && !getState('setup.sessionStarted')) {
        bus.emit('setup:guest-join-failure', { error: err, userMessage: userMsg });
      } else {
        showToast(userMsg);
      }
    }
  });

  // Session full (guest rejected by full host)
  bus.on('network:session-full', (msg) => {
    const message = (msg as string) || t('network.session_full');
    showSetupOverlay();
    startGuestFlow();
    showDialog({ title: t('network.session_full'), message: String(message) }).catch((error) => {
      log.warn('[Setup] Session-full dialog failed', error);
    });
  });

  // Kicked from session (guest removed from host device list)
  bus.on('network:kicked-from-session', () => {
    showToast(t('toast.host_ended_connection'));
    scheduleDocumentReload(t('dialog.leaving_session'));
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
        scheduleDocumentReload(t('dialog.leaving_session'));
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

    const pathMatch = window.location.pathname.match(/^\/(\d{6})\/?$/);
    const joinCode = pathMatch?.[1] || '';

    if (joinCode && /^\d{6}$/.test(joinCode)) {
      log.info(`[Setup] Auto-join code detected: ${joinCode}`);
      setPendingAutoJoinCode(joinCode);

      // Direct invite URLs bypass initSetupOverlay(), so hide the app surface
      // immediately instead of letting the 200ms auto-join delay flash it.
      _applyEntranceClasses();

      // Show the overlay, then open the URL-code guest flow.
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
