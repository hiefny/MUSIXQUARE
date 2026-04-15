/**
 * MUSIXQUARE 3.0 — Setup Host Flow
 *
 * Host session creation: role selection -> code generation -> session start.
 *
 * IMPORTANT: This file must NOT import from setup.ts (circular dependency).
 * It imports shared helpers from setup-shared.ts instead.
 */

import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { setManagedTimer } from '../core/timers.ts';
import { createHostSessionWithShortCode, broadcastDeviceList } from '../network/peer.ts';
import {
  t, bus, showToast,
  updateRoleBadge, updateInviteCodeUI, selectStandardChannelButton,
  BACK_SVG,
  getPendingSetupRole, setPendingSetupRole,
  getHostCodeFlowId, incrementHostCodeFlowId,
  setupEl, stopObAutoSlide,
  setupShowJoinArea, setupShowCodeArea, setupShowWelcome, setupShowRoleArea,
  setupHighlightJoinRole, setupSetCode, setupRenderActions,
  hideSetupOverlay,
} from './setup-shared.ts';
import { animateTransition } from './dom.ts';

// ─── Host Flow ───────────────────────────────────────────────────

/** goBack callback — set by the orchestrator to avoid circular imports */
let _goBack: () => void = () => {};

export function setHostGoBack(fn: () => void): void {
  _goBack = fn;
}

export function startHostFlow(): void {
  incrementHostCodeFlowId();
  bus.emit('audio:activate');

  setState('network.appRole', 'host');
  setState('setup.sessionStarted', false);
  setPendingSetupRole(null);

  // Single transition for the whole welcome→role swap so the four DOM
  // flips snapshot together instead of superseding each other.
  animateTransition(() => {
    setupShowJoinArea(false);
    setupShowCodeArea(false);
    setupShowWelcome(false);
    setupShowRoleArea(true);
  });

  setupHighlightJoinRole(null);

  const sliderArea = setupEl('ob-slider-area');
  if (sliderArea) {
    sliderArea.style.display = 'none';
    stopObAutoSlide();
  }

  setupRenderActions([
    { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => _goBack() },
    {
      id: 'btn-setup-next', text: t('common.next'), kind: 'secondary',
      onClick: () => {
        const role = getPendingSetupRole();
        if (role !== null) proceedToHostCode(role);
        else showToast(t('setup.select_role'));
      },
    },
  ], 'horizontal-with-back');
}

async function proceedToHostCode(mode: number): Promise<void> {
  const appRole = getState('network.appRole');
  if (appRole !== 'host') return;

  const flowId = incrementHostCodeFlowId();

  try {
    selectStandardChannelButton(mode);
    bus.emit('audio:set-channel-mode', mode);
  } catch (e) { log.warn(e); }

  animateTransition(() => {
    setupShowRoleArea(false);
    setupShowCodeArea(true);
  });

  const codeEl = setupEl('setup-code');
  if (codeEl) {
    if (codeEl.tagName === 'INPUT') (codeEl as HTMLInputElement).value = '------';
    else codeEl.textContent = '------';
  }

  setupRenderActions([
    { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => startHostFlow() },
    { id: 'btn-setup-confirm', text: t('common.wait'), kind: 'secondary', disabled: true },
  ], 'horizontal-with-back');

  try {
    const code = await createHostSessionWithShortCode();

    // User navigated away while code was loading — discard stale result
    if (flowId !== getHostCodeFlowId()) {
      log.info('[Setup] Host code flow cancelled (user navigated away)');
      return;
    }

    setState('network.sessionCode', code);
    setupSetCode(code);
    updateInviteCodeUI();
    setState('network.myDeviceLabel', 'HOST');
    updateRoleBadge();

    setupRenderActions([
      { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => startHostFlow() },
      { id: 'btn-setup-confirm', text: t('common.start'), kind: 'primary', onClick: () => startSessionFromHost() },
    ], 'horizontal-with-back');
  } catch (e) {
    // User navigated away — ignore the error silently
    if (flowId !== getHostCodeFlowId()) return;

    log.error('[Setup] Host session init failed', e);
    showToast(t('error.session_create_fail'));
    startHostFlow();
  }
}

export function startSessionFromHost(): void {
  const appRole = getState('network.appRole');
  if (appRole !== 'host' || getState('setup.sessionStarted')) return;

  setState('setup.sessionStarted', true);
  hideSetupOverlay();
  updateRoleBadge();

  // Show host in device list immediately (don't wait for a guest to connect)
  broadcastDeviceList();

  // Delay toast until View Transition completes to prevent transform conflict
  setManagedTimer('host-start-toast', () => {
    showToast(t('toast.invite_code_settings'));
  }, 350);

  setManagedTimer('host-start-blink', () => {
    const btn = document.getElementById('btn-media-source');
    if (btn) {
      btn.classList.add('blink-hint');
      btn.addEventListener('animationend', () => {
        btn.classList.remove('blink-hint');
      }, { once: true });
    }
  }, 400);
}
