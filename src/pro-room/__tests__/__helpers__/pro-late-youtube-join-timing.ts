/**
 * The App timing of a late PRO YouTube join, shared by the suites that pin it
 * (2026-10-30). Each value is a module constant of its home and is not
 * exported there (scripts/check-dead-exports.mts refuses an export only tests
 * use), so the suites keep this one copy instead of one each. The row named
 * with each value runs the real home and pins the copy to it; a suite that
 * only uses a value to script another module (when a scripted endpoint
 * fails, for example) therefore stays tied to that module. The RO-03 anchor
 * tests (docs/design/resource-ownership-registry.md) name the same rows as
 * this copy's parity tests.
 *
 * A value leaves this copy once its home exports it. Since Phase 6 6A-3 the
 * arm's release catch-up tolerance (40 ms) and release acknowledgement
 * (1.8 s) are YOUTUBE_ARM_TIMING in src/youtube/constants.ts, which the
 * suites import instead.
 *
 * Row titles and comments quote today's values (the 3 s lead) while the
 * bodies read them from here, so a change to a value renames those titles
 * and updates those comments in the same change, together with every
 * citation of a renamed title, here and in the RO-03 anchor tests.
 */

/**
 * LATE_YOUTUBE_COMMIT_LEAD_MS in src/pro-room/playback-controller.ts: with no
 * earlier rejoin sample, a late join's participant-local instant is exactly
 * this long after the COMMIT reaches the device, on the server clock. Pinned
 * by playback-late-cohort-join.test.ts '(c) joins a failed-READY device 3 s
 * after COMMIT on the server clock, mid-track, as a scheduled control'.
 */
export const LATE_YOUTUBE_COMMIT_LEAD_MS = 3_000;
