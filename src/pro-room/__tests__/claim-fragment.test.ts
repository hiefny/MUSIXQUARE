import { describe, expect, it, vi } from 'vitest';
import { takeProRoomClaimFromFragment } from '../claim-fragment.ts';

const VALID_CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;

function harness(hash: string, search = '') {
  const replaceState = vi.fn();
  const location = { hash, pathname: '/000001', search };
  const history = { state: { test: true }, replaceState };
  return { location, history, replaceState };
}

describe('PRO room activation claim fragment', () => {
  it('returns a valid fragment claim and scrubs it immediately', () => {
    const { location, history, replaceState } = harness(`#pro-claim=${VALID_CLAIM}`);

    expect(takeProRoomClaimFromFragment(location, history)).toBe(VALID_CLAIM);
    expect(replaceState).toHaveBeenCalledWith({ test: true }, '', '/000001');
  });

  it('preserves a non-secret query while removing the complete fragment', () => {
    const { location, history, replaceState } = harness(
      `#view=setup&pro-claim=${VALID_CLAIM}`,
      '?lang=ko',
    );

    expect(takeProRoomClaimFromFragment(location, history)).toBe(VALID_CLAIM);
    expect(replaceState).toHaveBeenCalledWith({ test: true }, '', '/000001?lang=ko');
  });

  it('scrubs malformed claims but never accepts them', () => {
    const { location, history, replaceState } = harness('#pro-claim=too-short');

    expect(takeProRoomClaimFromFragment(location, history)).toBeNull();
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it('does not read a claim from the query string', () => {
    const { location, history, replaceState } = harness('', `?pro-claim=${VALID_CLAIM}`);

    expect(takeProRoomClaimFromFragment(location, history)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
