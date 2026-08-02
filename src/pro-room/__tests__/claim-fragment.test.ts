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
      activationClaimPresent: true,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    });
    expect(replaceState).toHaveBeenCalledWith({ test: true }, '', '/000001');
  });

  it('consumes activation, recovery, and transfer claims together while preserving the query', () => {
    const { location, history, replaceState } = harness(
      `#view=setup&pro-claim=${VALID_CLAIM}&pro-recovery=${VALID_CLAIM}&pro-transfer=${VALID_CLAIM}`,
      '?lang=ko',
    );

    expect(takeProRoomClaimsFromFragment(location, history)).toEqual({
      activationClaimToken: VALID_CLAIM,
      activationClaimPresent: true,
      ownerRecoveryClaimToken: VALID_CLAIM,
      ownerRecoveryClaimPresent: true,
      ownerTransferClaimToken: VALID_CLAIM,
      ownerTransferClaimPresent: true,
    });
    expect(replaceState).toHaveBeenCalledWith({ test: true }, '', '/000001?lang=ko');
  });

  it('scrubs malformed or duplicated recovery claims but records the attempted path', () => {
    const { location, history, replaceState } = harness(
      `#pro-recovery=too-short&pro-recovery=${VALID_CLAIM}`,
    );

    expect(takeProRoomClaimsFromFragment(location, history)).toEqual({
      activationClaimToken: null,
      activationClaimPresent: false,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: true,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    });
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it('scrubs a malformed activation claim while recording that activation was attempted', () => {
    const { location, history, replaceState } = harness('#pro-claim=too-short');

    expect(takeProRoomClaimsFromFragment(location, history)).toEqual({
      activationClaimToken: null,
      activationClaimPresent: true,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    });
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it('rejects and scrubs every query-string claim without retaining its value', () => {
    const { location, history, replaceState } = harness(
      '',
      `?lang=ko&pro-claim=${VALID_CLAIM}&pro-recovery=${VALID_CLAIM}&pro-transfer=${VALID_CLAIM}`,
    );

    expect(takeProRoomClaimsFromFragment(location, history)).toEqual({
      activationClaimToken: null,
      activationClaimPresent: true,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: true,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: true,
    });
    expect(replaceState).toHaveBeenCalledWith({ test: true }, '', '/000001?lang=ko');
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain(VALID_CLAIM);
  });

  it('rejects a valid fragment when a query claim is also present', () => {
    const { location, history, replaceState } = harness(
      `#pro-transfer=${VALID_CLAIM}`,
      `?PRO-CLAIM=${VALID_CLAIM}&lang=ko`,
    );

    expect(takeProRoomClaimsFromFragment(location, history)).toEqual({
      activationClaimToken: null,
      activationClaimPresent: true,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: true,
    });
    expect(replaceState).toHaveBeenCalledWith({ test: true }, '', '/000001?lang=ko');
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain(VALID_CLAIM);
  });

  it('scrubs a malformed transfer claim while recording that the transfer path was attempted', () => {
    const { location, history, replaceState } = harness('#pro-transfer=too-short');

    expect(takeProRoomClaimsFromFragment(location, history)).toEqual({
      activationClaimToken: null,
      activationClaimPresent: false,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: true,
    });
    expect(replaceState).toHaveBeenCalledOnce();
  });
});
