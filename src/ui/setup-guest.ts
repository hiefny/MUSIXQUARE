/**
 * MUSIXQUARE 3.0 — Setup Guest Flow
 *
 * Guest join: role selection -> code entry -> join session.
 *
 * IMPORTANT: This file must NOT import from setup.ts (circular dependency).
 * It imports shared helpers from setup-shared.ts instead.
 */

import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { PEER_NAME_PREFIX } from '../core/constants.ts';
import { joinSession } from '../network/peer.ts';
import {
  t, bus, showToast,
  updateRoleBadge, updateInviteCodeUI,
  activateNoSleep, selectStandardChannelButton,
  BACK_SVG,
  getPendingSetupRole, setPendingSetupRole,
  getPendingGuestRoleMode, setPendingGuestRoleMode,
  getPendingAutoJoinCode,
  setupEl, stopObAutoSlide,
  setupShowCodeArea, setupShowJoinArea, setupShowWelcome, setupShowRoleArea,
  setupHighlightJoinRole, setupSetGuestJoinBusy, setupRenderActions,
} from './setup-shared.ts';

// ─── Guest Flow ──────────────────────────────────────────────────

/** goBack callback — set by the orchestrator to avoid circular imports */
let _goBack: () => void = () => {};

export function setGuestGoBack(fn: () => void): void {
  _goBack = fn;
}

export function startGuestFlow(): void {
  bus.emit('audio:activate');

  setState('network.appRole', 'guest');
  setState('setup.sessionStarted', false);
  setPendingSetupRole(null);

  updateInviteCodeUI();

  setupShowCodeArea(false);
  setupShowJoinArea(false);
  setupShowWelcome(false);
  setupShowRoleArea(true);

  setupHighlightJoinRole(null);
  setupSetGuestJoinBusy(false);

  const sliderArea = setupEl('ob-slider-area');
  if (sliderArea) {
    sliderArea.style.display = 'none';
    stopObAutoSlide();
  }

  setupRenderActions([
    { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => _goBack() },
    {
      id: 'btn-setup-next', text: t('common.next'), kind: 'primary',
      onClick: () => {
        const role = getPendingSetupRole();
        if (role !== null) proceedToGuestCode(role);
        else showToast(t('setup.select_role'));
      },
    },
  ], 'horizontal-with-back');

  setState('network.myDeviceLabel', t('common.guest'));
  updateRoleBadge();
}

function proceedToGuestCode(mode: number): void {
  setPendingGuestRoleMode(mode);

  setupShowRoleArea(false);
  setupShowJoinArea(true);

  setupRenderActions([
    { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => startGuestFlow() },
    { id: 'btn-setup-confirm', text: t('common.start'), kind: 'primary', onClick: () => handleSetupJoinWithRole(getPendingGuestRoleMode()) },
  ], 'horizontal-with-back');

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

  setState('network.lastJoinCode', code);
  updateInviteCodeUI();
  activateNoSleep();

  try {
    selectStandardChannelButton(mode);
    bus.emit('audio:set-channel-mode', mode);
  } catch (e) { log.warn('[Setup] setChannelMode failed', e); }

  setState('network.myDeviceLabel', PEER_NAME_PREFIX);
  updateRoleBadge();

  setupSetGuestJoinBusy(true);
  setState('network.isConnecting', true);
  updateRoleBadge();

  setupRenderActions([
    { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => startGuestFlow() },
    { id: 'btn-setup-confirm', text: t('setup.joining'), kind: 'primary', disabled: true },
  ], 'horizontal-with-back');

  joinSession(code);
}
