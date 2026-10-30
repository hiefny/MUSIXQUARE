import { describe, expect, it } from 'vitest';
import { getCurrentLoadEpoch } from '../_state.ts';

// A file of its own: the load-epoch counter is module state with no reset, and
// any test that allocates an epoch moves it. Only a fresh module graph, which
// each test file gets, observes the initial value in any test order.
describe('getCurrentLoadEpoch', () => {
  it('returns 0 initially', () => {
    expect(getCurrentLoadEpoch()).toBe(0);
  });
});
