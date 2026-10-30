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
 */

/**
 * LATE_YOUTUBE_COMMIT_LEAD_MS in src/pro-room/playback-controller.ts: with no
 * earlier rejoin sample, a late join's participant-local instant is exactly
 * this long after the COMMIT reaches the device, on the server clock. Pinned
 * by playback-late-cohort-join.test.ts '(c) joins a failed-READY device 3 s
 * after COMMIT on the server clock, mid-track, as a scheduled control'.
 */
export const LATE_YOUTUBE_COMMIT_LEAD_MS = 3_000;

/**
 * LATE_YOUTUBE_RELEASE_TOLERANCE_MS in src/pro-room/playback-controller.ts,
 * which mirrors TIMING.catchUpToleranceMs in src/youtube/authority-arm.ts.
 * Pinned for the controller by playback-late-cohort-join.test.ts '(d)
 * releases a device ready %i ms after executeAt from its transition without a
 * catch-up' and '(d) re-arms a device ready 41 ms after executeAt for a
 * mid-track join 3 s later', and for the arm by authority-arm.test.ts '(d)
 * releases a commit $lateMs ms past its prepared 0:00 target with $seeks
 * seek'.
 */
export const LATE_YOUTUBE_RELEASE_TOLERANCE_MS = 40;

/**
 * TIMING.releaseAckTimeoutMs in src/youtube/authority-arm.ts: how long a
 * release waits for PLAYING before it pauses and fails. Pinned by
 * authority-arm.test.ts '(b) pauses an unacknowledged release after exactly
 * 1.8 s without re-muting it'.
 */
export const RELEASE_ACK_TIMEOUT_MS = 1_800;
