/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetDocumentReloadForTests,
  registerPendingClaimReloadPreparation,
  requestDocumentReload,
} from '../../core/document-reload.ts';

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

type DocumentReloadAttempt = Parameters<Parameters<typeof requestDocumentReload>[0]>[0];

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

    for (const claim of claims) {
      __resetDocumentReloadForTests();
      mocks.takeClaims.mockReturnValue(claim);
      const prepare = vi.fn(() => vi.fn());
      registerPendingClaimReloadPreparation(prepare);
      await expect(enterProRoomFromSetup('000001')).resolves.toBe('reload-required');
      let attempt: DocumentReloadAttempt | undefined;
      requestDocumentReload((value) => {
        attempt = value;
      });
      attempt!.navigate(vi.fn());
      expect(prepare).toHaveBeenCalledOnce();
      attempt!.recover();
    }

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
