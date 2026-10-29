// Timing home of a PRO playback transition, shared by the PRO room Worker and
// the App (resource ownership RO-03, see
// docs/design/resource-ownership-registry.md). A playback command that needs
// every device ready first opens a transition: the Worker sends a PREPARE,
// the devices report READY, and the Worker commits once all have answered or
// the barrier has passed. The COMMIT names its instant one lead after the
// Worker sends it. The test (src/pro-room/__tests__/pro-room-playback-timing.test.ts)
// pins these values and their relations.
//
// Deliberately not here: the zero-start encoding of PRO Workers before PRO
// snapshot schemaVersion 2 (a 2999 ms deadline and a 699 ms COMMIT lead, one
// below each value), which the Worker and src/pro-room/playback-controller.ts
// keep in their own files. Each side drops it in a different release, so an
// export here would go dead between them, and changing this file, which is
// on both the pro-room and the app runtime paths, makes a release target all.

/** The rendezvous barrier: how long after its PREPARE a transition commits anyway. */
export const PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS = 3_000;

/** How long after the Worker sends a COMMIT its devices execute it. */
export const PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS = 700;

/**
 * The start kind of a transition. A zero-start lets each device add its
 * learned startup lead; every other start follows the running timeline.
 */
export type ProRoomPlaybackTimingMode = 'zero-start' | 'scheduled-control';
