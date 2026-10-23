/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPendingClaimReloadPreparation } from '../../core/document-reload.ts';
import { RESET_PAINT_FALLBACK_MS } from '../../core/navigation-contract.ts';
import { __resetPageNavigationForTests, scheduleDocumentReload } from '../../core/session-reset.ts';
import { stubNavigationSinks } from '../../core/__tests__/__helpers__/navigation-sinks.ts';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  evaluations: 0,
  showDialog: vi.fn(),
  takeClaims: vi.fn(),
}));

vi.mock('../../core/events.ts', () => ({ bus: { emit: mocks.emit } }));
vi.mock('../../core/state.ts', () => ({ getState: () => 'Owner' }));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: mocks.showDialog }));
vi.mock('../claim-fragment.ts', () => ({
  takeProRoomClaimsFromFragment: mocks.takeClaims,
}));
vi.mock('../runtime.ts', () => {
  mocks.evaluations += 1;
  throw new TypeError('chunk unavailable');
});

import { enterProRoomFromSetup } from '../setup-flow.ts';

const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
  window,
  'requestAnimationFrame',
);

afterEach(() => {
  __resetPageNavigationForTests();
  vi.unstubAllGlobals();
  if (originalRequestAnimationFrame) {
    Object.defineProperty(window, 'requestAnimationFrame', originalRequestAnimationFrame);
  }
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.evaluations = 0;
  mocks.takeClaims.mockReturnValue({
    activationClaimToken: `${'a'.repeat(32)}.${'b'.repeat(43)}`,
    activationClaimPresent: true,
    ownerRecoveryClaimToken: null,
    ownerRecoveryClaimPresent: false,
    ownerTransferClaimToken: null,
    ownerTransferClaimPresent: false,
  });
});

describe('PRO runtime terminal import failure', () => {
  it('preserves all three pre-mutation claims without re-evaluating the failed specifier', async () => {
    const claims = [
      {
        activationClaimToken: `${'a'.repeat(32)}.${'b'.repeat(43)}`,
        activationClaimPresent: true,
        ownerRecoveryClaimToken: null,
        ownerRecoveryClaimPresent: false,
        ownerTransferClaimToken: null,
        ownerTransferClaimPresent: false,
      },
      {
        activationClaimToken: null,
        activationClaimPresent: false,
        ownerRecoveryClaimToken: `${'a'.repeat(32)}.${'b'.repeat(43)}`,
        ownerRecoveryClaimPresent: true,
        ownerTransferClaimToken: null,
        ownerTransferClaimPresent: false,
      },
      {
        activationClaimToken: null,
        activationClaimPresent: false,
        ownerRecoveryClaimToken: null,
        ownerRecoveryClaimPresent: false,
        ownerTransferClaimToken: `${'a'.repeat(32)}.${'b'.repeat(43)}`,
        ownerTransferClaimPresent: true,
      },
    ];

    // Frames suspended: the reset runs its action on the paint fallback.
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const sinks = stubNavigationSinks();
    for (const claim of claims) {
      __resetPageNavigationForTests();
      mocks.takeClaims.mockReturnValue(claim);
      const prepare = vi.fn(() => vi.fn());
      registerPendingClaimReloadPreparation(prepare);
      await expect(enterProRoomFromSetup('000001')).resolves.toBe('reload-required');
      vi.useFakeTimers();
      // The app reloads through the navigation owner; the retained claim is
      // restored for that reload's sink.
      scheduleDocumentReload('dialog.refreshing_session');
      vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS);
      expect(prepare).toHaveBeenCalledOnce();
      vi.useRealTimers();
    }
    expect(sinks.count('reload')).toBe(3);

    expect(mocks.evaluations).toBe(1);
    expect(mocks.showDialog).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledTimes(3);
    expect(mocks.emit).toHaveBeenNthCalledWith(
      1,
      'app:lazy-feature-load-failed',
      'pro-room',
      expect.objectContaining({
        name: 'LazyFeatureLoadError',
        message: 'PRO_ROOM_RUNTIME_LOAD_FAILED_RELOAD_REQUIRED',
      }),
    );
  });
});
