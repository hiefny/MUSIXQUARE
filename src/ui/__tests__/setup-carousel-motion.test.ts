/** @vitest-environment jsdom */

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
});
