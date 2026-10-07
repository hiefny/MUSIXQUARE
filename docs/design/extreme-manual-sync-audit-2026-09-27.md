# Extreme manual synchronization audit — 2026-09-27

| Field | Value |
| --- | --- |
| Status | Dated discovery evidence; four confirmed defects, not repaired in this audit |
| Reviewed checkout | `fe3fdb10f0ee4ffc4a028640cf198c52b488a810` |
| Product code | `c3eae88c` — previous S01/S02 repair included |
| Environment | Windows, Node 24.20.0, Vitest 5, pinned Chromium, local PeerJS |
| Scope | YouTube Standard/PRO; ordinary and large local-file playback, including shared demo transport; extreme signed offsets and lifecycle boundaries |
| Related | [Previous discovery and repair](youtube-manual-zero-start-audit-2026-09-27.md), [current release record](../beta-release-readiness.md) |

The owner requested discovery and simulation, not another implementation pass.
No runtime source, tracked test, main branch or production deployment was changed.
Diagnostics live in ignored `scratch/extreme-sync-audit-2026-09-27/`.

The owner subsequently authorized repair. See the separate
[XS01–XS04 repair record](extreme-manual-sync-repair-2026-09-27.md) for that work;
the counts and unrepaired behavior below describe the original audit baseline.

## Results

Four independent causes were confirmed. Failed combinations are not separate
bugs. The parent independently reran all three final module matrices and the
browser cases below. Final module matrices contain **863 cases: 823 passed,
40 failed, zero skipped**. These failures assert desired behavior and demonstrate
the unfixed defects; the successful cases do not certify all synchronization.

| Lane | Distinct module cases | Pass / fail | Confirmed cause |
| --- | ---: | ---: | --- |
| Standard YouTube | 266 | 264 / 2 | XS01 |
| Local files | 283 | 249 / 34 | XS02 |
| PRO YouTube | 314 | 310 / 4 | XS03, XS04 |

The range includes ±9,999 ms, intermediate signed values and zero. Combinations
include host/guest values, Standard platform branches, PRO owner/member
capabilities, very short and ordinary track durations, beginning/end seeks,
repeat, next/previous-run replacement, pause/reset, connection/player/resource
replacement, delayed preparation and late joining. Browser tests supply actual
UI reachability for XS01 and XS02; PRO uses actual application modules with a
fake iframe/server timeline rather than a live PRO server.

## XS01 — an ordinary heartbeat releases a waiting YouTube guest early

In Standard rooms a negatively offset guest can remain paused for its local
release while the host's shorter zero-start calibration has already finished.
The host resumes ordinary `youtube-sync` heartbeats. The receive handler's
[drift/state correction](../../src/youtube/sync.ts) does not respect the active
zero-start owner: host PLAYING plus guest PAUSED calls `playVideo()` immediately.

The actual UI reproduction used host 0 ms, guest -9,999 ms and the next track.
The iframe was deterministic; the app and local PeerJS were real. A timestamped
follow-up produced this sequence relative to the room COMMIT:

| Event | Room time |
| --- | ---: |
| Ordinary heartbeat starts the unmuted guest from zero | 4.676 s |
| Original delayed timer calls play again, already at media 5.296 s | 9.993 s |
| Later heartbeat seeks backward from 5.953 s to 0.649 s | 10.670 s |

The result is an early start followed by a large backward correction, not a
permanent lost track. The module reproduction also fails at -5,000 ms when an
ordinary heartbeat arrives during the remaining hold. Both-negative and
host-negative/guest-zero controls can pass because the host also waits and
therefore sends its first ordinary heartbeat later.

This is an uncovered interaction in the preceding S01 repair. The controller
in isolation preserves the delay; the ordinary receiver defeats it. Repair
must arbitrate iframe mutation with both the internal zero-start controller and
external fallback, while still accepting useful fresh snapshots. Do not merely
drop all messages or disable ordinary recovery permanently.

## XS02 — local-file negative correction disappears at the zero boundary

The common [file transport](../../src/player/transport.ts) clamps
`safeOffset + localOffset` to media position zero but does not add the residual
negative correction to the source's start time. Its logical `startedAt` still
includes the full requested offset; position queries cancel that value and
report a correct room position while physical output is incorrect.

This affects ordinary AudioBuffer and large-file playback through the same
transport, in Standard host/guest, PRO and demo module paths. Starting midway
through a track applies the negative correction correctly; returning to zero
loses it. Twelve valid heartbeat corrections do not restore it: the module
probe's logical time is 12 s, actual output 11 s, expected output 2.001 s for
-9,999 ms. After an initial correction the subsequent decisions are `observe`.

The parent independently used two Chromium pages, actual UI offset entry and
next-track selection, local PeerJS and real decoded 60-second PCM WAV files.
Observation wrappers recorded native AudioBufferSourceNode start/stop calls
without replacing their behavior. Source positions were calculated from their
actual audio-context clock and scheduled offset, not the app's position getter.

| Setting | Guest minus host before next file | About 12 s into next file | Intended difference |
| --- | ---: | ---: | ---: |
| Guest -9,999 ms | -10.021 s | -0.839 s | -9.999 s |
| Host -9,999 ms | +10.008 s | +0.021 s | +9.999 s |
| Guest +9,999 ms | +9.983 s | +9.9995 s | +9.999 s |
| Both zero | -0.002 s | +0.0015 s | 0 s |

The loss remains after the requested delay has elapsed, so it is not just an
unavoidable clamp at the first sample. These values are browser output timelines,
not microphone measurements of speakers. Main has the same native start/clamp
arithmetic; this was not introduced by the preceding YouTube patch. The beta
large-file engine inherits it. A repair must keep room time, actual local output
and effective correction separate through zero-boundary waiting and rebuilds.

## XS03 — PRO local PAUSE is overwritten by an older delayed start

A PRO member with -9,999 ms can pause their own output from the system media
controls while a prepared COMMIT or direct snapshot start is waiting. The actual
registered Media Session PAUSE handler sets `localPaused=true` and pauses the
iframe. The older release still calls `playVideo()` and returns success, leaving
the flag true while media is playing.

The [local pause handler](../../src/youtube/player.ts) cancels Standard work but
does not revoke the PRO authority arm or direct delayed-start generation. The
direct wait rechecks room/player/queue identity, but not newer local pause
intent. The server-current callback also stays true because a participant-local
pause does not change the room revision.

Both manifestations were independently reproduced through `initMediaSession()`
and its registered action, not just a synthetic local-pause event. A control
with a newer authoritative room PAUSE cancels correctly. The prepared-arm race
was already possible inside its shorter scheduled lead; the new negative hold
widens the window. The direct snapshot's new wait introduces that additional
window. Repair must acknowledge local output intent without treating it as an
ordinary failed commit: the controller's failure catch-up could otherwise
restart the same media again.

## XS04 — a late PRO release timer starts from an obsolete position

When the prepared PRO arm's release callback arrives late, it plays the target
computed at COMMIT. [authority-arm.ts](../../src/youtube/authority-arm.ts) does
not account for elapsed time at callback delivery. The direct snapshot path
does rebase at release and passes the same delay control.

Injecting a 1.5-second delay into only the release callback, with the page
remaining visible and immediate PLAYING acknowledgement, produced:

| Requested correction | Position 60 s after release | Required position | Error |
| --- | ---: | ---: | ---: |
| -9,999 ms | 60 s | 61.5 s | -1.5 s |
| +9,999 ms | 69.999 s | 71.499 s | -1.5 s |

The real [lead learner](../../src/youtube/pro-lead-learner.ts) runs but adjusts
future starts, not this one. The ordinary post-COMMIT heartbeat follow-up was
source-traced: an applied revision without a canceled checkpoint is not reapplied
by [playback-controller.ts](../../src/pro-room/playback-controller.ts). It was
not replayed against a live server. A visibility-change recovery can correct
the position, so this is specifically a delayed callback without that separate
recovery trigger. This vulnerability predates the new negative hold. A repair
should rebase from the scheduled canonical deadline and preserve cancellation,
manual correction and learning semantics.

## Verification interpretation

- Standard UI extreme matrix: eight cases, six passed and two failed (XS01:
  guest -9,999; host +9,999 / guest -9,999). Initial offsets were entered through
  the actual Sync editor and worked before the next track.
- A separate timestamped YouTube browser run observed early play, original
  release and later correction. Its completed observation is not a passing
  desired-behavior assertion.
- Four native local-file browser observations completed; two demonstrate XS02
  and two are controls. They must not be called four correct synchronization
  cases merely because their observation scripts completed.
- One real-UI cross-source browser case passed: file +9,999 ms → YouTube
  -9,999 ms → another YouTube start → return to file while release is waiting.
  Thirteen seconds later the old iframe remained destroyed/stopped, current
  file output was running, and both source-specific preferences were retained.
- Existing six local-file suites: 352 passed. These are separate baseline
  checks, not additional newly explored combinations. No full suite was rerun
  for this investigation, and no physical iPhone, live YouTube, Bluetooth audio
  or live PRO service validation is claimed.
- PRO short-duration combinations exercise bounded targets and scheduling in
  the fake iframe; they do not reproduce real YouTube automatic end events.
- The first native browser harness omitted the required initial Play click and
  was stopped after setup failures. The Standard pause/resume fixture initially
  omitted the host's second precision stage and failed even at zero offset.
  Both fixture errors were corrected before the final counts above; neither is
  a product finding.

No further independent defect was confirmed in the tested cancellation,
identity replacement, short-file completion, asynchronous PCM preparation or
source-switching combinations. That does not establish safety for every device
or ordering.

### Reproduction artifacts

All paths below are under `scratch/extreme-sync-audit-2026-09-27/` and ignored by Git:

- `standard/root-final-results.json`, `standard/heartbeat-ownership.test.ts`
- `local/root-final-results.json`, `local/transport-boundaries.test.ts`
- `pro/root-final-results.json`, `pro/pro-extreme.test.ts`, `pro/findings.md`
- `browser/extremes.log`, `browser/guest-trace.log`, `browser/local-output-valid.log`,
  `browser/cross-source.log`

Run each lane with the pinned Node runtime and `node_modules/vitest/vitest.mjs run
--config scratch/extreme-sync-audit-2026-09-27/<lane>/vitest.config.ts --maxWorkers=1`;
the PRO config extension is `.mts`. Red tests are expected until repair.
Browser tests require `npm run build:e2e`, the scratch Playwright config and
distinct local app/PeerJS ports. Nothing in this audit authorizes main promotion,
workflow reactivation or production deployment.
