/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import {
  getRoleLabelByChannelMode,
  getStandardRolePreset,
  getInviteCode,
  updateRoleBadge,
} from '../player-controls.ts';

beforeEach(() => {
  resetState();
  document.body.innerHTML = '';
});

describe('getRoleLabelByChannelMode', () => {
  it('returns Original for mode 0', () => {
    expect(getRoleLabelByChannelMode(0)).toBe('Original');
  });

  it('returns Left for mode -1', () => {
    expect(getRoleLabelByChannelMode(-1)).toBe('Left');
  });

  it('returns Right for mode 1', () => {
    expect(getRoleLabelByChannelMode(1)).toBe('Right');
  });

  it('returns Woofer for mode 2', () => {
    expect(getRoleLabelByChannelMode(2)).toBe('Woofer');
  });

  it('falls back to Original for unknown mode', () => {
    expect(getRoleLabelByChannelMode(99)).toBe('Original');
  });
});

describe('getStandardRolePreset', () => {
  it('returns center preset for mode 0', () => {
    const preset = getStandardRolePreset(0);
    expect(preset.labelKey).toBe('common.original');
    expect(preset.placementToastKey).toBe('role.center_placement');
  });

  it('returns left preset for mode -1', () => {
    const preset = getStandardRolePreset(-1);
    expect(preset.labelKey).toBe('common.left');
    expect(preset.placementToastKey).toBe('role.left_placement');
  });

  it('returns right preset for mode 1', () => {
    const preset = getStandardRolePreset(1);
    expect(preset.labelKey).toBe('common.right');
    expect(preset.placementToastKey).toBe('role.right_placement');
  });

  it('falls back to Original preset for unknown mode', () => {
    const preset = getStandardRolePreset(99);
    expect(preset.labelKey).toBe('common.original');
    expect(preset.placementToastKey).toBe('role.center_placement');
  });
});

describe('getInviteCode', () => {
  it('returns sessionCode when valid 6-digit', () => {
    setState('network.sessionCode', '123456');
    expect(getInviteCode()).toBe('123456');
  });

  it('returns lastJoinCode when sessionCode is empty', () => {
    setState('network.sessionCode', '');
    setState('network.lastJoinCode', '654321');
    expect(getInviteCode()).toBe('654321');
  });

  it('returns ------ when both are empty', () => {
    setState('network.sessionCode', '');
    setState('network.lastJoinCode', '');
    expect(getInviteCode()).toBe('------');
  });

  it('returns ------ when sessionCode is invalid format', () => {
    setState('network.sessionCode', 'abc');
    setState('network.lastJoinCode', '');
    expect(getInviteCode()).toBe('------');
  });

  it('prefers sessionCode over lastJoinCode', () => {
    setState('network.sessionCode', '111111');
    setState('network.lastJoinCode', '222222');
    expect(getInviteCode()).toBe('111111');
  });
});

describe('updateRoleBadge', () => {
  function renderBadge(): HTMLElement {
    document.body.innerHTML = `
      <div class="role-badge" id="role-badge">
        <span id="role-text"></span>
      </div>
    `;
    return document.getElementById('role-badge') as HTMLElement;
  }

  it('marks a connected remote guest with the remote class', () => {
    const badge = renderBadge();
    setState('network.hostConn', { peer: 'host-1', open: true } as any);
    setState('network.myDeviceLabel', 'GUEST 1');
    setState('network.connectionType', 'remote');

    updateRoleBadge();

    expect(badge.classList.contains('connected')).toBe(true);
    expect(badge.classList.contains('remote')).toBe(true);
    expect(document.getElementById('role-text')?.textContent).toContain('GUEST 1');
  });

  it('keeps a connected local guest blue by clearing the remote class', () => {
    const badge = renderBadge();
    badge.classList.add('remote');
    setState('network.hostConn', { peer: 'host-1', open: true } as any);
    setState('network.myDeviceLabel', 'GUEST 1');
    setState('network.connectionType', 'local');

    updateRoleBadge();

    expect(badge.classList.contains('connected')).toBe(true);
    expect(badge.classList.contains('remote')).toBe(false);
  });
});
