/** @vitest-environment jsdom */

import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearManagedTimer: vi.fn(),
  setManagedTimer: vi.fn(),
}));

vi.mock('../../core/timers.ts', () => ({
  clearManagedTimer: mocks.clearManagedTimer,
  setManagedTimer: mocks.setManagedTimer,
}));

vi.mock('../../core/platform.ts', () => ({
  isCompactLandscape: vi.fn(() => false),
}));

vi.mock('../dom.ts', () => ({
  animateTransition: vi.fn((apply: () => void) => apply()),
  updateOverlayOpenClass: vi.fn(),
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
}));

vi.mock('../player-controls.ts', () => ({
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  showPlacementToastForChannel: vi.fn(),
}));

vi.mock('../../core/wake-lock.ts', () => ({
  activateNoSleep: vi.fn(),
}));

vi.mock('../settings.ts', () => ({
  selectStandardChannelButton: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

import { setupRenderActions, setupSetGuestJoinError, startObAutoSlide } from '../setup-shared.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('onboarding carousel motion preference', () => {
  it('keeps normal automatic advancement when reduced motion is not requested', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });

    startObAutoSlide();

    expect(mocks.clearManagedTimer).toHaveBeenCalledWith('obAutoSlideTimer');
    expect(mocks.setManagedTimer).toHaveBeenCalledWith(
      'obAutoSlideTimer',
      expect.any(Function),
      5000,
      { interval: true },
    );
  });

  it('does not start automatic advancement for reduced-motion users', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });

    startObAutoSlide();

    expect(mocks.clearManagedTimer).toHaveBeenCalledWith('obAutoSlideTimer');
    expect(mocks.setManagedTimer).not.toHaveBeenCalled();
  });
});

describe('setup recovery accessibility', () => {
  it('links an inline failure state to the code field and labels icon-only Back', () => {
    document.body.innerHTML = `
      <input id="setup-join-code" aria-describedby="setup-guest-error">
      <p id="setup-guest-error" role="alert" hidden></p>
      <p id="setup-auto-join-error" role="alert" hidden></p>
      <div id="setup-actions"></div>
    `;

    setupSetGuestJoinError('Could not reach the room.');
    setupRenderActions([
      {
        id: 'btn-setup-back',
        html: '<svg></svg>',
        ariaLabel: 'Go back',
        kind: 'icon-only',
      },
    ]);

    const input = document.getElementById('setup-join-code');
    const error = document.getElementById('setup-guest-error');
    const back = document.getElementById('btn-setup-back');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-describedby')).toBe('setup-guest-error');
    expect(error?.hidden).toBe(false);
    expect(error?.getAttribute('role')).toBe('alert');
    expect(back?.getAttribute('aria-label')).toBe('Go back');

    setupSetGuestJoinError(null);
    expect(input?.hasAttribute('aria-invalid')).toBe(false);
    expect(error?.hidden).toBe(true);
  });

  it('keeps invite-link failures in the dedicated alert without invalidating the code field', () => {
    document.body.innerHTML = `
      <input id="setup-join-code" aria-describedby="setup-guest-error">
      <p id="setup-guest-error" role="alert" hidden></p>
      <p id="setup-auto-join-error" role="alert" hidden></p>
    `;

    setupSetGuestJoinError('Could not reach the PRO room.', true);

    const input = document.getElementById('setup-join-code');
    const codeError = document.getElementById('setup-guest-error');
    const inviteError = document.getElementById('setup-auto-join-error');
    expect(input?.hasAttribute('aria-invalid')).toBe(false);
    expect(codeError?.hidden).toBe(true);
    expect(inviteError?.hidden).toBe(false);
    expect(inviteError?.textContent).toBe('Could not reach the PRO room.');
    expect(inviteError?.getAttribute('role')).toBe('alert');
  });

  it('centers the invite-link failure panel in the desktop setup layout', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const desktopSetupStart = stylesheet.indexOf('/* Content areas: center vertically */');
    const desktopSetupEnd = stylesheet.indexOf('/* Content padding inside right panel */');
    expect(desktopSetupStart).toBeGreaterThanOrEqual(0);
    expect(desktopSetupEnd).toBeGreaterThan(desktopSetupStart);

    const centeredAreaRules = stylesheet.slice(desktopSetupStart, desktopSetupEnd);
    expect(centeredAreaRules).toContain('#setup-overlay #setup-auto-join-area');
    expect(centeredAreaRules).toContain('justify-content: center !important');
  });
});
