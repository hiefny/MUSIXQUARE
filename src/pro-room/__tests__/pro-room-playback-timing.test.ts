import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS,
  PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS,
  type ProRoomPlaybackTimingMode,
} from '../../../cloudflare/pro-room-playback-timing.ts';
import type { MusixquareProRoom } from '../../../cloudflare/pro-room-worker.ts';
import { PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS } from '../../youtube/constants.ts';
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
 * The App's 2.3 s barriered YouTube prepare budget, whose home is
 * src/youtube/constants.ts since Phase 6 6A-3 (C2-1), must fit inside the
 * barrier: the last two rows pin that order and the room it leaves for READY.
 * The budget stays an App value, out of this shared home, so a change to it
 * keeps an App-only release.
 *
 * App suites that model a PREPARE or a COMMIT cannot import the home: a suite
 * that loads Worker code belongs to the Worker coverage profile
 * (src/core/__tests__/ci-quality-gates.test.ts). Their copy is
 * __helpers__/pro-room-playback-timing-copy.ts, which the last row pins here.
 * Every App suite whose PREPARE or COMMIT uses the barrier or the lead reads
 * it from that copy and derives the numbers that follow from it, so a change
 * to the home fails here until the copy follows, and those suites then run
 * against the new values.
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

  it('keeps the copy App suites read, which load no Worker code, equal to the home', async () => {
    // Name for name and value for value: a change to the home fails here
    // until the copy follows, so no suite that reads the copy runs against a
    // stale Worker.
    const home = await import('../../../cloudflare/pro-room-playback-timing.ts');
    const copy = await import('./__helpers__/pro-room-playback-timing-copy.ts');
    expect({ ...copy }).toEqual({ ...home });
  });

  it("keeps the App's 2.3 s barriered YouTube prepare budget inside the 3 s barrier", () => {
    expect(PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS).toBeLessThan(
      PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS,
    );
  });

  it('leaves 700 ms between that budget and the barrier: the room for a READY, not the COMMIT lead', () => {
    // Fresh clock samples and the READY upload fit here before the deadline.
    // The COMMIT lead has the same value by chance and is not this room.
    const readyRoomMs =
      PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS - PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS;
    expect(readyRoomMs).toBe(700);
  });
});
