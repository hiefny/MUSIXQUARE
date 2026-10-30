/**
 * The App suites' copy of the PRO playback transition timing (resource
 * ownership RO-03, docs/design/resource-ownership-registry.md). Its home is
 * cloudflare/pro-room-playback-timing.ts, which the PRO Worker imports. A
 * suite that loads Worker code belongs to the Worker coverage profile
 * (src/core/__tests__/ci-quality-gates.test.ts), so an App suite that models
 * the Worker's PREPARE and COMMIT reads this copy instead. Only the late
 * YouTube join pins of 2026-10-30 do so today; older App suites still retype
 * 3000 and 700 and are not tied to the home. The copy keeps the home's names,
 * and the RO-03 timing-home anchor test,
 * src/pro-room/__tests__/pro-room-playback-timing.test.ts, pins it to the home
 * name for name and value for value.
 */

/** The rendezvous barrier: how long after its PREPARE a transition commits anyway. */
export const PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS = 3_000;

/** How long after the Worker sends a COMMIT its devices execute it. */
export const PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS = 700;
