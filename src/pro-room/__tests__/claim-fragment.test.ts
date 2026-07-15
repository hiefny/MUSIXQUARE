import { describe, expect, it, vi } from 'vitest';
import { takeProRoomClaimsFromFragment } from '../claim-fragment.ts';

const VALID_CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;

function harness(hash: string, search = '') {
  const replaceState = vi.fn();
  const location = { hash, pathname: '/000001', search };
  const history = { state: { test: true }, replaceState };
  return { location, history, replaceState };
}

describe('PRO room one-time claim fragments', () => {
  it('returns a valid activation fragment claim and scrubs it immediately', () => {
    const { location, history, replaceState } = harness(`#pro-claim=${VALID_CLAIM}`);

    expect(takeProRoomClaimsFromFragment(location, history)).toEqual({
      activationClaimToken: VALID_CLAIM,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
    });
    expect(replaceState).toHaveBeenCalledWith({ test: true }, '', '/000001');
  });

  it('consumes activation and recovery claims together while preserving the query', () => {
    const { location, history, replaceState } = harness(
      `#view=setup&pro-claim=${VALID_CLAIM}&pro-recovery=${VALID_CLAIM}`,
      '?lang=ko',
    );

    expect(takeProRoomClaimsFromFragment(location, history)).toEqual({
      activationClaimToken: VALID_CLAIM,
      ownerRecoveryClaimToken: VALID_CLAIM,
      ownerRecoveryClaimPresent: true,
    });
    expect(replaceState).toHaveBeenCalledWith({ test: true }, '', '/000001?lang=ko');
  });

  it('scrubs malformed or duplicated recovery claims but records the attempted path', () => {
    const { location, history, replaceState } = harness(
      `#pro-recovery=too-short&pro-recovery=${VALID_CLAIM}`,
    );

    expect(takeProRoomClaimsFromFragment(location, history)).toEqual({
      activationClaimToken: null,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: true,
    });
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it('does not read either claim from the query string', () => {
    const { location, history, replaceState } = harness(
      '',
      `?pro-claim=${VALID_CLAIM}&pro-recovery=${VALID_CLAIM}`,
    );

    expect(takeProRoomClaimsFromFragment(location, history)).toEqual({
      activationClaimToken: null,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
    });
    expect(replaceState).not.toHaveBeenCalled();
  });
});
