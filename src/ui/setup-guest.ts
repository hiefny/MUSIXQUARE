/**
 * MUSIXQUARE — Setup Guest Flow
 *
 * Guest join: code entry -> join session.
 *
 * IMPORTANT: This file must NOT import from setup.ts (circular dependency).
 * It imports shared helpers from setup-shared.ts instead.
 */

import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { PEER_NAME_PREFIX } from '../core/constants.ts';
import { clearManagedTimer } from '../core/timers.ts';
import { joinSession } from '../network/peer.ts';
import {
  t,
  bus,
  showToast,
  updateRoleBadge,
  updateInviteCodeUI,
  activateNoSleep,
  selectStandardChannelButton,
  BACK_SVG,
  setPendingSetupRole,
  getPendingGuestRoleMode,
  setPendingGuestRoleMode,
  getPendingAutoJoinCode,
  setupSetAutoJoinCode,
  setOnInviteLinkRoleSelected,
  setupEl,
  stopObAutoSlide,
  setupShowCodeArea,
  setupShowAutoJoinArea,
  setupShowJoinArea,
  setupShowWelcome,
  setupShowRoleArea,
  setupHighlightJoinRole,
  setupSetGuestJoinBusy,
  setupRenderActions,
} from './setup-shared.ts';
import { animateTransition } from './dom.ts';
import { markIntentionalNav } from '../core/page-lifecycle.ts';
import { showDialog } from './dialog.ts';
import { markAppUsed } from '../demo/storage.ts';
import { primeYouTubePlayer, precreateYouTubePlayer } from '../youtube/player.ts';

// ─── Guest Flow ──────────────────────────────────────────────────

/** goBack callback — set by the orchestrator to avoid circular imports */
let _goBack: () => void = () => {};
let _pendingPasswordJoin: { code: string; mode: number; inviteLink: boolean } | null = null;
let _roomPasswordPromptOpen = false;
const DEFAULT_SETUP_ROLE = 0;

export function setGuestGoBack(fn: () => void): void {
  _goBack = fn;
}

// Register invite-link role-selected callback
setOnInviteLinkRoleSelected(() => _renderInviteLinkActions());

export function startGuestFlow(): void {
  markAppUsed();
  bus.emit('audio:activate');
  _pendingPasswordJoin = null;
  _roomPasswordPromptOpen = false;

  // Cancel any in-flight join attempt (back button pressed during connecting)
  if (getState('network.isConnecting')) {
    clearManagedTimer('join-timeout');
    clearManagedTimer('join-retry');
    setState('network.isConnecting', false);
    setState('network.isIntentionalDisconnect', true);
    const hostConn = getState('network.hostConn');
    if (hostConn) {
      try {
        hostConn.close();
      } catch {
        /* noop */
      }
      setState('network.hostConn', null);
    }
  }

  setState('network.appRole', 'guest');
  setState('setup.sessionStarted', false);

  // Eagerly pre-create the hidden iOS YouTube prime player now (async), well
  // before the join tap, so a ready player exists for the gesture-bound bounce
  // in the join handlers. No-op off iOS / in C mode.
  precreateYouTubePlayer();
  // The role picker is parked for now; default guests to the center speaker.
  // Keep setup-role-area wired so explicit role selection can return later.
  setPendingSetupRole(DEFAULT_SETUP_ROLE);
  setPendingGuestRoleMode(DEFAULT_SETUP_ROLE);

  updateInviteCodeUI();

  try {
    selectStandardChannelButton(DEFAULT_SETUP_ROLE);
    bus.emit('audio:set-channel-mode', DEFAULT_SETUP_ROLE);
    setupHighlightJoinRole(DEFAULT_SETUP_ROLE);
  } catch (e) {
    log.warn('[Setup] set default guest role failed', e);
  }

  animateTransition(() => {
    setupShowCodeArea(false);
    setupShowJoinArea(false);
    setupShowAutoJoinArea(false);
    setupShowWelcome(false);
    setupShowRoleArea(false);
  });

  setupSetGuestJoinBusy(false);

  const sliderArea = setupEl('ob-slider-area');
  if (sliderArea) {
    sliderArea.style.display = 'none';
    stopObAutoSlide();
  }

  setState('network.myDeviceLabel', t('common.guest'));
  updateRoleBadge();

  const autoCode = getPendingAutoJoinCode();
  if (autoCode) {
    setupSetAutoJoinCode(autoCode);
    animateTransition(() => {
      setupShowAutoJoinArea(true);
    });
    _renderInviteLinkActions();
  } else {
    proceedToGuestCode(DEFAULT_SETUP_ROLE);
  }
}

/** Render actions for invite-link flow: back icon + primary start.
 *  The back icon does a hard navigation to '/' so a user who landed here via /CODE
 *  can start fresh if the host is gone or they want to leave the invite flow. */
function _renderInviteLinkActions(): void {
  setupRenderActions(
    [
      {
        id: 'btn-setup-back',
        html: BACK_SVG,
        kind: 'icon-only',
        onClick: () => {
          markIntentionalNav();
          window.location.href = '/';
        },
      },
      {
        id: 'btn-setup-confirm',
        text: t('common.start'),
        kind: 'primary',
        onClick: () => _handleInviteLinkJoin(DEFAULT_SETUP_ROLE),
      },
    ],
    'horizontal-with-back',
  );
}

/** Join directly using the invite code from URL (skip code input step) */
async function _handleInviteLinkJoin(mode: number): Promise<void> {
  const autoCode = getPendingAutoJoinCode();
  if (!autoCode || !/^\d{6}$/.test(autoCode)) {
    showToast(t('toast.no_invite_code'));
    return;
  }

  primeYouTubePlayer();

  setPendingGuestRoleMode(mode);
  setState('network.lastJoinCode', autoCode);
  updateInviteCodeUI();
  activateNoSleep();

  try {
    selectStandardChannelButton(mode);
    bus.emit('audio:set-channel-mode', mode);
  } catch (e) {
    log.warn('[Setup] setChannelMode failed', e);
  }

  setState('network.myDeviceLabel', PEER_NAME_PREFIX);
  updateRoleBadge();

  setupSetGuestJoinBusy(true);

  setupRenderActions(
    [
      {
        id: 'btn-setup-back',
        html: BACK_SVG,
        kind: 'icon-only',
        onClick: () => {
          markIntentionalNav();
          window.location.href = '/';
        },
        disabled: true,
      },
      { id: 'btn-setup-confirm', text: t('setup.joining'), kind: 'primary', disabled: true },
    ],
    'horizontal-with-back',
  );

  _pendingPasswordJoin = { code: autoCode, mode, inviteLink: true };
  joinSession(autoCode);
}

function proceedToGuestCode(mode: number): void {
  setPendingGuestRoleMode(mode);

  animateTransition(() => {
    setupShowRoleArea(false);
    setupShowAutoJoinArea(false);
    setupShowJoinArea(true);
  });

  setupRenderActions(
    [
      { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => _goBack() },
      {
        id: 'btn-setup-confirm',
        text: t('common.start'),
        kind: 'primary',
        onClick: () => handleSetupJoinWithRole(getPendingGuestRoleMode()),
      },
    ],
    'horizontal-with-back',
  );

  const input = setupEl('setup-join-code') as HTMLInputElement | null;
  if (input) {
    // Restore auto-join code from QR scan (if any), otherwise clear
    const autoCode = getPendingAutoJoinCode();
    if (autoCode) {
      input.value = autoCode;
    } else {
      input.value = '';
    }
    input.focus();
  }
}

export async function handleSetupJoinWithRole(mode: number | null): Promise<void> {
  if (mode === null || mode === undefined) {
    showToast(t('setup.select_role_alt'));
    return;
  }

  const appRole = getState('network.appRole');
  if (appRole !== 'guest') return;

  const input = setupEl('setup-join-code') as HTMLInputElement | null;
  const codeRaw = (input ? input.value : '').trim();
  const code = codeRaw.replace(/\s+/g, '');

  if (!/^\d{6}$/.test(code)) {
    showToast(t('setup.six_digit_enter'));
    if (input) input.focus();
    return;
  }

  primeYouTubePlayer();

  setState('network.lastJoinCode', code);
  updateInviteCodeUI();
  activateNoSleep();

  try {
    selectStandardChannelButton(mode);
    bus.emit('audio:set-channel-mode', mode);
  } catch (e) {
    log.warn('[Setup] setChannelMode failed', e);
  }

  setState('network.myDeviceLabel', PEER_NAME_PREFIX);
  updateRoleBadge();

  setupSetGuestJoinBusy(true);
  // Note: isConnecting is set inside joinSession() — do NOT pre-set here
  // (pre-setting would block joinSession's own guard)
  updateRoleBadge();

  setupRenderActions(
    [
      {
        id: 'btn-setup-back',
        html: BACK_SVG,
        kind: 'icon-only',
        onClick: () => _goBack(),
        disabled: true,
      },
      { id: 'btn-setup-confirm', text: t('setup.joining'), kind: 'primary', disabled: true },
    ],
    'horizontal-with-back',
  );

  _pendingPasswordJoin = { code, mode, inviteLink: false };
  joinSession(code);
}

function restoreJoinControlsAfterPasswordCancel(): void {
  setupSetGuestJoinBusy(false);

  if (_pendingPasswordJoin?.inviteLink) {
    _renderInviteLinkActions();
    return;
  }

  setupRenderActions(
    [
      { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => startGuestFlow() },
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
    if (_pendingPasswordJoin?.code) input.value = _pendingPasswordJoin.code;
    input.focus();
  }
}

function renderPasswordRetryBusy(inviteLink: boolean): void {
  setupSetGuestJoinBusy(true);
  setupRenderActions(
    [
      {
        id: 'btn-setup-back',
        html: BACK_SVG,
        kind: 'icon-only',
        onClick: inviteLink
          ? () => {
              markIntentionalNav();
              window.location.href = '/';
            }
          : () => _goBack(),
        disabled: true,
      },
      { id: 'btn-setup-confirm', text: t('setup.joining'), kind: 'primary', disabled: true },
    ],
    'horizontal-with-back',
  );
}

export async function promptForRoomPassword(
  reason: 'required' | 'invalid' | 'timeout' = 'required',
): Promise<void> {
  const pending = _pendingPasswordJoin;
  if (!pending || _roomPasswordPromptOpen) return;

  _roomPasswordPromptOpen = true;
  setupSetGuestJoinBusy(false);

  const messageKey =
    reason === 'invalid'
      ? 'dialog.room_password_retry_msg'
      : reason === 'timeout'
        ? 'dialog.room_password_timeout_msg'
        : 'dialog.room_password_msg';

  const result = await showDialog({
    title: t('dialog.room_password_title'),
    message: t(messageKey),
    inputField: {
      placeholder: t('dialog.room_password_placeholder'),
      maxLength: 8,
      inputMode: 'numeric',
      pattern: '[0-9]*',
      autocomplete: 'one-time-code',
      splitEvery: 4,
      separator: '-',
      validator: (value) =>
        /^\d{8}$/.test(value.trim()) ? null : t('connect.room_password_invalid'),
    },
    buttonText: t('common.ok'),
    secondaryText: t('common.cancel'),
    defaultFocus: 'primary',
  });

  _roomPasswordPromptOpen = false;

  if (result.action !== 'ok') {
    restoreJoinControlsAfterPasswordCancel();
    return;
  }

  const password = (result.inputValue || '').replace(/\D+/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(password)) {
    restoreJoinControlsAfterPasswordCancel();
    return;
  }

  setPendingGuestRoleMode(pending.mode);
  setState('network.lastJoinCode', pending.code);
  updateInviteCodeUI();
  renderPasswordRetryBusy(pending.inviteLink);
  joinSession(pending.code, password);
}

export function clearPendingRoomPasswordJoin(): void {
  _pendingPasswordJoin = null;
  _roomPasswordPromptOpen = false;
}
