/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';

const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
const HANDOFF_KEY = '__mxqrTakeProRoomFragmentClaims';

afterEach(() => {
  Reflect.deleteProperty(window, HANDOFF_KEY);
  vi.resetModules();
});

describe('PRO claim module handoff', () => {
  it('consumes the bootstrap closure at module evaluation and releases it to setup once', async () => {
    const takeEarly = vi.fn(() => ({
      activationClaim: CLAIM,
      recoveryClaim: null,
      recoveryPresent: false,
    }));
    Object.defineProperty(window, HANDOFF_KEY, {
      configurable: true,
      enumerable: false,
      value: takeEarly,
    });
    vi.resetModules();

    const { takeProRoomClaimsFromFragment } = await import('../claim-fragment.ts');

    expect(takeEarly).toHaveBeenCalledOnce();
    expect(takeProRoomClaimsFromFragment()).toEqual({
      activationClaimToken: CLAIM,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
    });
    expect(takeProRoomClaimsFromFragment()).toEqual({
      activationClaimToken: null,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
    });
  });
});
