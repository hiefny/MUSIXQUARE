/**
 * The App suites' copy of the PRO playback transition timing (resource
 * ownership RO-03, docs/design/resource-ownership-registry.md). Its home is
 * cloudflare/pro-room-playback-timing.ts, which the PRO Worker imports. A
 * suite that loads Worker code belongs to the Worker coverage profile
 * (src/core/__tests__/ci-quality-gates.test.ts), so every App suite whose
 * PREPARE or COMMIT uses the barrier or the lead reads it here instead. Such
 * a suite derives the numbers that follow from these values (a PREPARE's
 * deadline, an executeAt, a schedule delay, a wait to or past the deadline or
 * the start, the zero-start lead of PRO Workers before PRO snapshot
 * schemaVersion 2, one below the lead) instead of retyping them. The
 * copy keeps the home's names, and the RO-03 timing-home anchor test,
 * src/pro-room/__tests__/pro-room-playback-timing.test.ts, pins it to the home
 * name for name and value for value. Titles and comments in the suites that
 * read it quote today's values and numbers derived from them (the commit plus
 * 700 ms, a late join's 2.3 s room position, a commit 200 ms before
 * executeAt, the 699 ms lead), so a change to a value updates them in the
 * same change, together with every citation of a renamed title.
 */

/** The rendezvous barrier: how long after its PREPARE a transition commits anyway. */
export const PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS = 3_000;

/** How long after the Worker sends a COMMIT its devices execute it. */
export const PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS = 700;
