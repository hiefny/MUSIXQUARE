import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS,
  PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS,
  type ProRoomPlaybackTimingMode,
} from '../../../cloudflare/pro-room-playback-timing.ts';
import type { MusixquareProRoom } from '../../../cloudflare/pro-room-worker.ts';
import type { ProRoomPlaybackCommitEvent, ProRoomPlaybackPrepareEvent } from '../api.ts';
import type { ProPlaybackTimingMode } from '../playback-authority-hooks.ts';

/**
 * RO-03: the timing home of a PRO playback transition that the PRO Worker and
 * the App share (cloudflare/pro-room-playback-timing.ts): the rendezvous
 * barrier of a PREPARE, the lead of a COMMIT and the start-kind union.
 *
 * Every PRO Worker before PRO snapshot schemaVersion 2 marked a zero-start
 * transition one millisecond below each value, a 2999 ms deadline and a 699 ms
 * COMMIT lead. Neither side reads that encoding any more: the App reads only
 * the start kind a COMMIT or PREPARE names, and the PRO Worker reads a stored
 * transition that names no kind as a scheduled control. The encoding was never
 * in the home, which holds only values that outlive it.
 *
 * The App's 2.3 s barriered YouTube prepare budget must fit inside the
 * barrier. That ordering test waits for Phase 0d C2-1, which moves the budget
 * to src/youtube/constants.ts: today it is a module constant of
 * src/youtube/iframe.ts and src/youtube/authority-arm.ts, and a test-only
 * export is not allowed (scripts/check-dead-exports.mts).
 */

describe('PRO playback transition timing (RO-03)', () => {
  it('keeps the barrier and the lead the Worker and the App share, and nothing else', async () => {
    expect(PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS).toBe(3_000);
    expect(PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS).toBe(700);
    const home = await import('../../../cloudflare/pro-room-playback-timing.ts');
    expect(Object.keys(home).sort()).toEqual([
      'PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS',
      'PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS',
    ]);
  });

  it('gives the Worker and the App one start-kind union', () => {
    type WorkerTimingMode = NonNullable<
      NonNullable<Parameters<MusixquareProRoom['preparePlaybackTransition']>[3]>['timingMode']
    >;
    expectTypeOf<WorkerTimingMode>().toEqualTypeOf<ProRoomPlaybackTimingMode>();
    expectTypeOf<ProPlaybackTimingMode>().toEqualTypeOf<ProRoomPlaybackTimingMode>();
    expectTypeOf<
      NonNullable<ProRoomPlaybackPrepareEvent['timingMode']>
    >().toEqualTypeOf<ProRoomPlaybackTimingMode>();
    expectTypeOf<
      NonNullable<ProRoomPlaybackCommitEvent['timingMode']>
    >().toEqualTypeOf<ProRoomPlaybackTimingMode>();
    const kinds: readonly ProRoomPlaybackTimingMode[] = ['zero-start', 'scheduled-control'];
    expect(new Set(kinds).size).toBe(2);
  });
});
