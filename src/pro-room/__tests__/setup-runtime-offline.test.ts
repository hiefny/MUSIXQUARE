/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  throw new TypeError('Failed to fetch dynamically imported module: /assets/runtime-X.js');
});

const ROOM_CODE = '012345';

/** The browser's own network report, as navigator.onLine gives it. */
function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

/**
 * A fresh document. setup-flow.ts latches a failed runtime import for its
 * module lifetime, so each row loads it, and the modules it shares state
 * with, from a new module registry.
 */
async function loadDocument() {
  vi.resetModules();
  const [setupFlow, lazyFeatureFailure, documentReload] = await Promise.all([
    import('../setup-flow.ts'),
    import('../../core/lazy-feature-failure.ts'),
    import('../../core/document-reload.ts'),
  ]);
  return {
    enterProRoomFromSetup: setupFlow.enterProRoomFromSetup,
    isLazyFeatureLoadError: lazyFeatureFailure.isLazyFeatureLoadError,
    registerPendingClaimReloadPreparation: documentReload.registerPendingClaimReloadPreparation,
    capturePendingClaimReloadGuard: documentReload.capturePendingClaimReloadGuard,
  };
}

/** The errors this document reported for the PRO runtime, in order. */
function reportedRuntimeFailures(): unknown[] {
  return mocks.emit.mock.calls
    .filter(
      ([event, feature]) => event === 'app:lazy-feature-load-failed' && feature === 'pro-room',
    )
    .map(([, , error]) => error);
}

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

afterEach(() => {
  Reflect.deleteProperty(navigator, 'onLine');
});

// Offline room guidance: while this version's PRO runtime is not downloaded,
// an offline entry keeps the Refresh needed dialog and the setup screen's
// Refresh, and only the dialog body names the network. The runtime import
// fails before any request, so its record is the network state of that moment.
describe('a PRO runtime import that failed offline', () => {
  it('marks a runtime import that failed offline as a network failure and still requires a reload', async () => {
    const page = await loadDocument();
    page.registerPendingClaimReloadPreparation(vi.fn(() => vi.fn()));
    setOnline(false);

    await expect(page.enterProRoomFromSetup(ROOM_CODE)).resolves.toBe('reload-required');

    expect(mocks.evaluations).toBe(1);
    expect(mocks.showDialog).not.toHaveBeenCalled();
    // The claim stays held for the reload that the dialog offers.
    expect(page.capturePendingClaimReloadGuard()).not.toBeNull();
    const [failure] = reportedRuntimeFailures();
    expect(page.isLazyFeatureLoadError(failure)).toBe(true);

    // The network returns: the failure keeps the state of the moment it failed,
    // and a later entry in this document meets the same latched failure.
    setOnline(true);
    expect(failure).toMatchObject({ whileOffline: true });
    await expect(page.enterProRoomFromSetup(ROOM_CODE)).resolves.toBe('reload-required');
    expect(mocks.evaluations).toBe(1);
    expect(reportedRuntimeFailures().at(-1)).toBe(failure);
  });

  it('keeps a runtime import that failed online as an update when the entry is retried offline', async () => {
    const page = await loadDocument();

    await expect(page.enterProRoomFromSetup(ROOM_CODE)).resolves.toBe('reload-required');
    const [failure] = reportedRuntimeFailures();
    setOnline(false);
    await expect(page.enterProRoomFromSetup(ROOM_CODE)).resolves.toBe('reload-required');

    expect(mocks.evaluations).toBe(1);
    expect(reportedRuntimeFailures().at(-1)).toBe(failure);
    expect(page.isLazyFeatureLoadError(failure)).toBe(true);
    expect(failure).not.toMatchObject({ whileOffline: true });
  });
});
