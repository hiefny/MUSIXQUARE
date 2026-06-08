/**
 * MUSIXQUARE — Setup Host Flow
 *
 * Host session creation: role selection -> code generation -> session start.
 *
 * IMPORTANT: This file must NOT import from setup.ts (circular dependency).
 * It imports shared helpers from setup-shared.ts instead.
 */

import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { setManagedTimer } from '../core/timers.ts';
import { clearLatestPinnedNotice } from '../chat/protocol.ts';
import { createHostSessionWithShortCode, broadcastDeviceList } from '../network/peer.ts';
import {
  t,
  bus,
  showToast,
  updateRoleBadge,
  updateInviteCodeUI,
  selectStandardChannelButton,
  BACK_SVG,
  setPendingSetupRole,
  getHostCodeFlowId,
  incrementHostCodeFlowId,
  setupEl,
  stopObAutoSlide,
  setupShowJoinArea,
  setupShowAutoJoinArea,
  setupShowCodeArea,
  setupShowWelcome,
  setupShowRoleArea,
  setupHighlightJoinRole,
  setupSetCode,
  setupRenderActions,
  hideSetupOverlay,
} from './setup-shared.ts';
import { animateTransition } from './dom.ts';
import { markAppUsed } from '../demo/storage.ts';
import { primeYouTubePlayer, precreateYouTubePlayer } from '../youtube/player.ts';

// ─── Host Flow ───────────────────────────────────────────────────

/** goBack callback — set by the orchestrator to avoid circular imports */
let _goBack: () => void = () => {};
const DEFAULT_SETUP_ROLE = 0;

export function setHostGoBack(fn: () => void): void {
  _goBack = fn;
}

export function startHostFlow(): void {
  markAppUsed();
  incrementHostCodeFlowId();
  bus.emit('audio:activate');

  setState('network.appRole', 'host');
  setState('setup.sessionStarted', false);

  // Eagerly pre-create the hidden iOS YouTube prime player now (async), well
  // before the "Start" tap, so a ready player exists for the gesture-bound
  // bounce in startSessionFromHost(). No-op off iOS / in C mode.
  precreateYouTubePlayer();
  // The role picker is parked for now; default hosts to the center speaker.
  // Keep setup-role-area wired so explicit role selection can return later.
  setPendingSetupRole(DEFAULT_SETUP_ROLE);

  try {
    selectStandardChannelButton(DEFAULT_SETUP_ROLE);
    bus.emit('audio:set-channel-mode', DEFAULT_SETUP_ROLE);
    setupHighlightJoinRole(DEFAULT_SETUP_ROLE);
  } catch (e) {
    log.warn(e);
  }

  // Single transition for the whole welcome→role swap so the four DOM
  // flips snapshot together instead of superseding each other.
  animateTransition(() => {
    setupShowJoinArea(false);
    setupShowAutoJoinArea(false);
    setupShowCodeArea(false);
    setupShowWelcome(false);
    setupShowRoleArea(false);
  });

  const sliderArea = setupEl('ob-slider-area');
  if (sliderArea) {
    sliderArea.style.display = 'none';
    stopObAutoSlide();
  }

  void proceedToHostCode(DEFAULT_SETUP_ROLE);
}

async function proceedToHostCode(mode: number): Promise<void> {
  const appRole = getState('network.appRole');
  if (appRole !== 'host') return;

  const flowId = incrementHostCodeFlowId();

  try {
    selectStandardChannelButton(mode);
    bus.emit('audio:set-channel-mode', mode);
  } catch (e) {
    log.warn(e);
  }

  animateTransition(() => {
    setupShowRoleArea(false);
    setupShowCodeArea(true);
  });

  const codeEl = setupEl('setup-code');
  if (codeEl) {
    if (codeEl.tagName === 'INPUT') (codeEl as HTMLInputElement).value = '------';
    else codeEl.textContent = '------';
  }

  setupRenderActions(
    [
      { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => _goBack() },
      { id: 'btn-setup-confirm', text: t('common.wait'), kind: 'secondary', disabled: true },
    ],
    'horizontal-with-back',
  );

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

    setupRenderActions(
      [
        { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => _goBack() },
        {
          id: 'btn-setup-confirm',
          text: t('common.start'),
          kind: 'primary',
          onClick: () => startSessionFromHost(),
        },
      ],
      'horizontal-with-back',
    );
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

  primeYouTubePlayer();

  // The pinned-notice cache is module-scoped, so a new host session starts clean.
  clearLatestPinnedNotice();
  setState('setup.sessionStarted', true);
  hideSetupOverlay();
  updateRoleBadge();

  // Show host in device list immediately (don't wait for a guest to connect)
  broadcastDeviceList();

  // Delay toast until View Transition completes to prevent transform conflict
  setManagedTimer(
    'host-start-toast',
    () => {
      showToast(t('toast.invite_code_settings'));
    },
    350,
  );

  setManagedTimer(
    'host-start-blink',
    () => {
      const btn = document.getElementById('btn-media-source');
      if (btn) {
        btn.classList.add('attention-hint');
        btn.addEventListener(
          'animationend',
          () => {
            btn.classList.remove('attention-hint');
          },
          { once: true },
        );
      }
    },
    400,
  );
}
