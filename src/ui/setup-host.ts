/**
 * MUSIXQUARE — Setup Host Flow
 *
 * Host session creation: assign the default Center role, generate a code, and
 * start the session.
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
  getHostCodeFlowId,
  incrementHostCodeFlowId,
  setupEl,
  setupShowJoinArea,
  setupShowAutoJoinArea,
  setupShowCodeArea,
  setupShowWelcome,
  setupShowRoleArea,
  setupHighlightJoinRole,
  setupSetHostError,
  setupSetCode,
  setupRenderActions,
  hideSetupOverlay,
} from './setup-shared.ts';
import { animateTransition } from './dom.ts';
import { precreateYouTubePlayer } from '../youtube/player.ts';
import { prepareSetupStartFromGesture } from './setup-start.ts';

// ─── Host Flow ───────────────────────────────────────────────────

/** goBack callback — set by the orchestrator to avoid circular imports */
let _goBack: () => void = () => {};
const DEFAULT_SETUP_ROLE = 0;

export function setHostGoBack(fn: () => void): void {
  _goBack = fn;
}

export function startHostFlow(): void {
  incrementHostCodeFlowId();
  setupSetHostError(null);

  setState('network.appRole', 'host');
  setState('setup.sessionStarted', false);

  // Eagerly pre-create the hidden iOS YouTube prime player now (async), well
  // before the "Start" tap, so a ready player exists for the gesture-bound
  // bounce in startSessionFromHost(). No-op off iOS / in C mode.
  precreateYouTubePlayer();
  // Role selection is not exposed in the current setup, so default hosts to
  // the center speaker while keeping the existing role-area state coherent.
  try {
    selectStandardChannelButton(DEFAULT_SETUP_ROLE);
    setupHighlightJoinRole(DEFAULT_SETUP_ROLE);
  } catch (e) {
    log.warn(e);
  }

  // Apply the welcome-to-host-flow DOM changes in one transition snapshot.
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
  }

  void proceedToHostCode(DEFAULT_SETUP_ROLE);
}

async function proceedToHostCode(mode: number): Promise<void> {
  const appRole = getState('network.appRole');
  if (appRole !== 'host') return;

  const flowId = incrementHostCodeFlowId();
  setupSetHostError(null);

  try {
    selectStandardChannelButton(mode);
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
      {
        id: 'btn-setup-back',
        html: BACK_SVG,
        ariaLabel: t('dialog.go_back'),
        kind: 'icon-only',
        onClick: () => _goBack(),
      },
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
        {
          id: 'btn-setup-back',
          html: BACK_SVG,
          ariaLabel: t('dialog.go_back'),
          kind: 'icon-only',
          onClick: () => _goBack(),
        },
        {
          id: 'btn-setup-confirm',
          text: t('common.start'),
          kind: 'primary',
          onClick: () => startSessionFromHost(mode),
        },
      ],
      'horizontal-with-back',
    );
  } catch (e) {
    // User navigated away — ignore the error silently
    if (flowId !== getHostCodeFlowId()) return;

    log.error('[Setup] Host session init failed', e);
    setupSetHostError(t('error.session_create_fail'));
    setupRenderActions(
      [
        {
          id: 'btn-setup-back',
          html: BACK_SVG,
          ariaLabel: t('dialog.go_back'),
          kind: 'icon-only',
          onClick: () => _goBack(),
        },
        {
          id: 'btn-setup-confirm',
          text: t('common.retry'),
          kind: 'primary',
          onClick: () => void proceedToHostCode(mode),
        },
      ],
      'horizontal-with-back',
    );
  }
}

function startSessionFromHost(mode: number = DEFAULT_SETUP_ROLE): void {
  const appRole = getState('network.appRole');
  if (appRole !== 'host' || getState('setup.sessionStarted')) return;

  prepareSetupStartFromGesture();

  try {
    selectStandardChannelButton(mode);
    bus.emit('audio:set-channel-mode', mode);
  } catch (e) {
    log.warn(e);
  }

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
