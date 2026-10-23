import { describe, expect, it } from 'vitest';
import {
  LEAVE_FALLBACK_MS,
  NAVIGATION_COMMIT_TIMEOUT_MS,
  RECONNECT_TARGET_KEY,
  RESET_PAINT_FALLBACK_MS,
  SW_CONTROLLER_CONFIRMED_KEY,
  SW_UPDATE_KEY,
  UPDATE_COMPLETION_KEY,
} from '../navigation-contract.ts';

describe('page navigation timing contract (RO-23, RO-30)', () => {
  it('runs the Back leave fallback inside the reset commit window', () => {
    // A confirmed Back leave runs inside a reset: history.back(), then the
    // fallback navigation home after LEAVE_FALLBACK_MS. The fallback must start
    // before the reset gives up on the traversal and makes the page
    // interactive again, or the page leaves after it looked recovered.
    expect(LEAVE_FALLBACK_MS).toBeLessThan(NAVIGATION_COMMIT_TIMEOUT_MS);
  });

  it('runs the reset action well inside the commit window when frames are suspended', () => {
    expect(RESET_PAINT_FALLBACK_MS).toBeLessThan(LEAVE_FALLBACK_MS);
  });
});

describe('next-document sessionStorage markers', () => {
  it('keeps the key strings that the previous and the next version read and write', () => {
    // Version N writes these during the very update reload that installs
    // version N+1, which reads them; a renamed key silently drops the marker.
    expect({
      RECONNECT_TARGET_KEY,
      SW_UPDATE_KEY,
      SW_CONTROLLER_CONFIRMED_KEY,
      UPDATE_COMPLETION_KEY,
    }).toEqual({
      RECONNECT_TARGET_KEY: 'mxqr_reconnect_target',
      SW_UPDATE_KEY: 'sw-updated-at',
      SW_CONTROLLER_CONFIRMED_KEY: 'sw-controller-confirmed-at',
      UPDATE_COMPLETION_KEY: 'mxqr-swu',
    });
  });
});
