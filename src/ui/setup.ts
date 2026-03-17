/**
 * MUSIXQUARE 3.0 — Setup Flow (Orchestrator)
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
import { setManagedTimer, clearAllManagedTimers } from '../core/timers.ts';
import { showToast } from './toast.ts';
import { showDialog } from './dialog.ts';
import { updateRoleBadge } from './player-controls.ts';
import { leaveSession, joinSession } from '../network/peer.ts';

// ─── Sub-module imports ──────────────────────────────────────────
import { startHostFlow, setHostGoBack } from './setup-host.ts';
import { startGuestFlow, setGuestGoBack, handleSetupJoinWithRole } from './setup-guest.ts';
import {
  BACK_SVG,
  syncDesktopLeftPanel,
  setupEl,
  showSetupOverlay, hideSetupOverlay,
  setupShowCodeArea, setupShowJoinArea, setupShowRoleArea, setupShowWelcome,
  setupSetGuestJoinBusy,
  setupRenderActions,
  startObAutoSlide, updateObSlider,
  nextObSlide, prevObSlide,
  handleSetupRolePreview,
  // State accessors
  setCurrentObSlide, setPendingSetupRole, setPendingGuestRoleMode,
  incrementHostCodeFlowId,
  getSetupOverlayEverShown, getSetupOverlayAbort, setSetupOverlayAbort,
  getPendingGuestRoleMode,
  setPendingAutoJoinCode,
} from './setup-shared.ts';

// ─── Role Selection Buttons ──────────────────────────────────────

function showRoleSelectionButtons(): void {
  setupRenderActions([
    { id: 'btn-setup-host', text: t('setup.host_button'), kind: 'primary', onClick: startHostFlow },
    { id: 'btn-setup-guest', text: t('setup.guest_button'), kind: 'secondary', onClick: startGuestFlow },
  ], 'vertical');
}

// ─── Init Setup Overlay ──────────────────────────────────────────

function initSetupOverlay(): void {
  // Abort previous setup overlay listeners to prevent accumulation
  const prevAbort = getSetupOverlayAbort();
  if (prevAbort) prevAbort.abort();
  const abort = new AbortController();
  setSetupOverlayAbort(abort);
  const signal = abort.signal;

  incrementHostCodeFlowId();
  setPendingAutoJoinCode(null);  // Clear auto-join code when returning to onboarding
  const sliderArea = setupEl('ob-slider-area');
  if (sliderArea) sliderArea.style.display = 'block';

  setupShowCodeArea(false);
  setupShowJoinArea(false);
  setupShowRoleArea(false);
  setupShowWelcome(true);
  setupSetGuestJoinBusy(false);

  setState('network.appRole', 'idle');
  setState('network.sessionCode', '');
  setCurrentObSlide(0);
  setState('setup.sessionStarted', false);
  setPendingSetupRole(null);
  setPendingGuestRoleMode(null);

  updateRoleBadge();
  updateObSlider();
  showRoleSelectionButtons();

  const showAndStart = () => {
    showSetupOverlay();
    startObAutoSlide();
  };

  if (!getSetupOverlayEverShown()) {
    try { document.documentElement.classList.add('setup-boot-block'); } catch { /* ignore */ }
  }
  showAndStart();

  // Bind slider events (use addEventListener with signal for proper cleanup)
  const btnNext = setupEl('ob-next');
  if (btnNext) btnNext.addEventListener('click', () => nextObSlide(false), { signal });
  const btnPrev = setupEl('ob-prev');
  if (btnPrev) btnPrev.addEventListener('click', () => prevObSlide(), { signal });

  document.querySelectorAll<HTMLElement>('.ob-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
      const dotEl = (e.target as HTMLElement).closest('.ob-dot') as HTMLElement | null;
      const idx = parseInt(dotEl?.dataset?.idx || '', 10);
      if (isNaN(idx)) return;
      setCurrentObSlide(idx);
      updateObSlider();
      startObAutoSlide();
    }, { signal });
  });

  // Swipe (addEventListener + passive for better scroll perf)
  const viewport = setupEl('ob-slider-viewport');
  if (viewport) {
    let startX = 0;
    viewport.addEventListener('touchstart', (e: Event) => {
      startX = (e as TouchEvent).touches?.[0]?.clientX ?? 0;
    }, { passive: true, signal });
    viewport.addEventListener('touchend', (e: Event) => {
      const endX = (e as TouchEvent).changedTouches?.[0]?.clientX;
      if (endX == null) return;
      const diff = startX - endX;
      if (Math.abs(diff) > 50) {
        if (diff > 0) nextObSlide(false);
        else prevObSlide();
      }
    }, { signal });
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
  // Desktop layout listener
  try {
    const mql = window.matchMedia('(min-width: 1280px)');
    mql.addEventListener('change', () => syncDesktopLeftPanel());
  } catch { /* ignore */ }

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
    const SVG_ID_TO_MODE: Record<string, number> = { 'svg-spk-l': -1, 'svg-spk-r': 1, 'svg-spk-center': 0, 'svg-spk-woofer': 2 };
    const mode = SVG_ID_TO_MODE[item.id];
    if (mode !== undefined) handleSetupRolePreview(mode);
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

    // Mark session as started so guests can see QR / invite link in Connect tab
    setState('setup.sessionStarted', true);
    const joinCode = getState('network.lastJoinCode');
    if (joinCode) setState('network.sessionCode', joinCode);

    updateRoleBadge();
    hideSetupOverlay();
    // Clear pending join code & clean URL — connection succeeded
    setPendingAutoJoinCode(null);
    try { sessionStorage.removeItem('mxqr_pending_join'); } catch { /* noop */ }
    try {
      if (window.location.search.includes('join=')) {
        window.history.replaceState({}, '', window.location.pathname + window.location.hash);
      }
    } catch { /* noop */ }
  });

  bus.on('setup:guest-join-failure', (_error) => {
    setState('network.isConnecting', false);
    updateRoleBadge();
    showToast(t('network.cant_join_wifi'));

    // Always hide loader — auto-reconnect flow shows loader before joinSession,
    // so we must hide it on failure to prevent permanent loader display (#103).
    bus.emit('ui:show-loader', false);

    setupRenderActions([
      { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => startGuestFlow() },
      { id: 'btn-setup-confirm', text: t('common.start'), kind: 'primary', onClick: () => handleSetupJoinWithRole(getPendingGuestRoleMode() ?? null) },
    ], 'horizontal-with-back');

    const input = setupEl('setup-join-code') as HTMLInputElement | null;
    if (input) {
      input.disabled = false;
      input.focus();
    }
    setupSetGuestJoinBusy(false);
  });

  // Return to main event
  bus.on('app:return-to-main', () => {
    leaveSession();
    initSetupOverlay();
  });

  // Network error handling (connection failures, timeouts, etc.)
  bus.on('network:error', (error) => {
    const err = error as Record<string, unknown> | null;
    const msg = (err as Error | null)?.message || '';
    const peerType = (err && typeof err === 'object') ? String(err.type || '') : '';
    let userMsg = t('error.network_generic');

    // Our custom error messages
    if (msg === 'HOST_UNREACHABLE') userMsg = t('error.host_unreachable');
    else if (msg === 'HOST_DISCONNECTED') userMsg = t('error.host_disconnected');
    else if (msg === 'HOST_CONNECTION_ERROR') userMsg = t('error.host_conn_error');
    else if (msg === 'CONNECT_FAILED') userMsg = t('error.connect_failed');
    else if (msg === 'PEER_NOT_READY') userMsg = t('error.peer_not_ready');
    else if (msg === 'NETWORK_INIT_FAILED') userMsg = t('error.network_init_failed');
    else if (msg === 'NO_HOST_ID') userMsg = t('error.no_host_id');
    // PeerJS native error types
    else if (peerType === 'peer-unavailable') userMsg = t('error.peer_unavailable');
    else if (peerType === 'network') userMsg = t('error.network_issue');
    else if (peerType === 'server-error') userMsg = t('error.signal_server_fail');
    else if (peerType === 'socket-error' || peerType === 'socket-closed') userMsg = t('error.server_disconnected');
    else if (peerType === 'unavailable-id') userMsg = t('error.session_id_unavailable');
    else if (peerType === 'webrtc') userMsg = t('error.webrtc_failed');

    const isConnecting = getState('network.isConnecting');
    if (isConnecting) {
      // Still trying to join — emit failure for UI reset
      showToast(userMsg);
      bus.emit('setup:guest-join-failure', err);
    } else if (msg === 'HOST_DISCONNECTED' || msg === 'HOST_CONNECTION_ERROR') {
      // Post-connection disconnect: show dialog + re-enable join
      showDialog({
        title: t('network.disconnected'),
        message: `${userMsg}\n${t('dialog.reconnect_ask')}`,
        buttonText: t('dialog.reconnect'),
        secondaryText: t('dialog.go_back'),
      }).then(res => {
        if (res.action === 'ok') {
          // Auto-reconnect using the last join code
          const lastCode = getState('network.lastJoinCode') || '';
          if (lastCode) {
            log.info(`[Setup] Auto-reconnecting to ${lastCode} — resetting stale state`);

            // Reset stale state from previous session to prevent "frozen" reconnect
            clearAllManagedTimers();
            bus.emit('player:stop-all-media');
            setState('transfer.state', 'IDLE');
            setState('transfer.skipIncomingFile', false);
            setState('transfer.waitingForPreload', false);
            setState('transfer.receivedCount', 0);
            setState('transfer.meta', {});
            setState('recovery.pending', false);
            setState('recovery.retryCount', 0);
            setState('preload.isPreloading', false);
            setState('preload.nextFileBlob', null);
            setState('preload.meta', null);
            bus.emit('ui:show-loader', true, t('setup.joining'));

            // Note: isConnecting is set inside joinSession() — do NOT pre-set here
            joinSession(lastCode);
          } else {
            startGuestFlow();
          }
        } else {
          window.location.reload();
        }
      }).catch(e => log.warn('[Setup] Reconnect dialog error:', e));
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
    showDialog({ title: t('network.cant_join'), message: String(message) });
    startGuestFlow();
  });

  // Kicked from session (guest removed from host device list)
  bus.on('network:kicked-from-session', () => {
    showToast(t('toast.host_ended_connection'));
    bus.emit('app:return-to-main');
  });

  // Explicitly kicked by host (MSG.KICK_DEVICE)
  bus.on('network:kicked-explicitly', async () => {
    await showDialog({
      title: t('connect.kicked_title'),
      message: t('connect.kicked_message'),
      buttonText: t('common.ok'),
      dismissible: false,
    });
    bus.emit('app:return-to-main');
  });

  // Check for ?join=CODE in URL or sessionStorage (survives SW reload)
  const JOIN_CODE_KEY = 'mxqr_pending_join';
  try {
    const urlParams = new URLSearchParams(window.location.search);
    let joinCode = urlParams.get('join') || '';

    // Fallback: recover code from sessionStorage (SW reload may have wiped the URL)
    if (!joinCode || !/^\d{6}$/.test(joinCode)) {
      joinCode = sessionStorage.getItem(JOIN_CODE_KEY) || '';
    }

    if (joinCode && /^\d{6}$/.test(joinCode)) {
      log.info(`[Setup] Auto-join code detected: ${joinCode}`);

      // Persist code so it survives SW reload AND proceedToGuestCode() clearing
      sessionStorage.setItem(JOIN_CODE_KEY, joinCode);
      setPendingAutoJoinCode(joinCode);

      // Show overlay first, then jump to guest role selection
      setManagedTimer('auto-join-start', () => {
        showSetupOverlay();
        startGuestFlow();
      }, 200);
    } else {
      // Normal flow: show setup overlay
      initSetupOverlay();
    }
  } catch {
    initSetupOverlay();
  }

  log.info('[Setup] Initialized');
}

// ─── Re-exports ──────────────────────────────────────────────────
// External modules import from 'ui/setup.ts' — keep that contract.

export { startHostFlow, startSessionFromHost } from './setup-host.ts';
export { startGuestFlow, handleSetupJoinWithRole } from './setup-guest.ts';
export {
  BACK_SVG,
  showSetupOverlay,
  hideSetupOverlay,
  setupShowCodeArea,
  setupShowJoinArea,
  setupShowRoleArea,
  setupShowWelcome,
  setupSetCode,
  setupSetGuestJoinBusy,
  setupHighlightJoinRole,
  setupRenderActions,
  setupEl,
  syncDesktopLeftPanel,
  handleSetupRolePreview,
} from './setup-shared.ts';
