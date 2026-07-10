/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { PLAYBACK_STATE } from '../../core/constants.ts';
import { shouldRestoreDemoSnapshotMedia } from '../restore-policy.ts';

describe('demo exit snapshot restore guard', () => {
  it('restores media only when no new playback has claimed ownership', () => {
    expect(
      shouldRestoreDemoSnapshotMedia({ mode: null, activity: 'idle' }, PLAYBACK_STATE.IDLE),
    ).toBe(true);
  });

  it('does not restore stale media over a YouTube load started during exit', () => {
    expect(
      shouldRestoreDemoSnapshotMedia(
        { mode: 'youtube', activity: 'pending' },
        PLAYBACK_STATE.IDLE,
      ),
    ).toBe(false);
  });

  it('does not restore stale media over a local file load started during exit', () => {
    expect(
      shouldRestoreDemoSnapshotMedia({ mode: 'file', activity: 'pending' }, PLAYBACK_STATE.IDLE),
    ).toBe(false);
    expect(
      shouldRestoreDemoSnapshotMedia({ mode: null, activity: 'idle' }, PLAYBACK_STATE.DECODING),
    ).toBe(false);
  });
});
