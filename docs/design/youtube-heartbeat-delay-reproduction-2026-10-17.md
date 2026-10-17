# Standard YouTube heartbeat delay reproduction — 2026-10-17

Historical pre-fix results are preserved below. Subsequent repair and release
evidence are recorded in [the follow-up](youtube-heartbeat-delay-fix-2026-10-17.md).

| Field | Value |
| --- | --- |
| Status | Dated QA evidence; two correction paths reproduced, not repaired |
| Tested runtime SHA | `97873950e2d4e726913247ff8faea8cb9a61b3e6` plus the new local reproduction test; no runtime edits |
| Production relationship | `src/` has no committed diff from deployed `336e80cdcad1ef35ce063540297a99e2e331d841` to the tested HEAD; App 8.11.12 / cache v712 |
| Environment | Local Windows, Node 24.13.1, npm 11.8.0, Vitest 5.0.3, jsdom; not the pinned Node 24.20.0 release environment |
| Scope | Owner requested reproduction of the two code-review findings, without a runtime fix or deployment |
| Test | [sync-heartbeat-delay-repro.test.ts](../../src/youtube/__tests__/sync-heartbeat-delay-repro.test.ts) |
| Related state | [Release record](../release-record.md#2-열린-확인-항목) |

## Method

The test invokes the production `YOUTUBE_SYNC` handler registered by
`initYouTubeSync()`. State, playback ownership, SharedClock, and managed timers
are real modules. The network dispatch boundary is captured; the YouTube iframe
API is a deterministic fake with a progressing media clock and an API call log.
Android detection is selected explicitly per case.

Three symmetric 4 ms RTT samples establish a calibrated zero-offset SharedClock.
The host snapshot is position 60 seconds at its recorded host clock. Before
delivery, fake time and the already-playing guest advance by the chosen frame
age. Android starts at 60.25 seconds to include the existing 250 ms output
policy. Assertions verify alignment before the handler receives the message.

For BUFFERING cases, the fake player changes to state 3 at delivery after this
aligned progression. The test does not freeze the guest for the entire network
delay. The same media, room, host connection and queue identity remain selected;
there is no advertisement, manual offset, active start operation, or cooldown.

## Results

| Input | Expected behavior / control | Observed result |
| --- | --- | --- |
| Aligned PLAYING; frame age 0 / 2,999 / 3,000 ms; Android and other platform | No player mutation | 6 pass |
| Aligned PLAYING; age 3,001 / 4,000 ms; Android and other platform | No player mutation | 4 fail: `seekTo(60)` or `seekTo(60.25)` despite already aligned playback |
| Fresh frame; actual guest lead of 4 seconds; both platforms | Correct the real lead | 2 pass: exactly one seek |
| Android BUFFERING; fresh frame | Existing output-compensated recovery | 1 pass: pause, seek 60.25, play |
| Android BUFFERING; age 200 / 500 ms | Recovery seek includes elapsed host playback | 2 fail: seeks 60.25 instead of 60.45 / 60.75 |
| Other platform BUFFERING; age 0 / 200 / 500 ms | Existing resume without old-position seek | 3 pass: play only |
| Android remains PLAYING; age 0 / 200 / 500 ms | No recovery mutation | 3 pass |

The new file has **21 tests: 15 pass / 6 fail / 0 skip**. These are normal failing
assertions for desired behavior, not skipped tests or expected-failure wrappers.
They remain red until the production correction is repaired. Six failing cases
represent two faulty paths, not six unrelated defects.

In the Android BUFFERING tests, API calls occur at arrival +0 ms (pause and seek)
and +150 ms (play). The target assertion compares positions at **seek time**;
the existing 150 ms pause/play gap is separate from the missing frame age. These
numbers do not measure actual audible latency.

## Cause established by the tests

`src/youtube/sync.ts:1153` projects a playing host snapshot to the current host
clock for small-drift detection. The coarse correction at lines 1438–1473 instead
uses the snapshot's original `hostTime`. A frame older than the 3-second threshold
therefore makes a synchronized player look ahead and causes a rewind.

The state-recovery branch at lines 1480–1484 sends the same unprojected `hostTime`
to `executeImmediate()` when Android is not PLAYING, including BUFFERING. The
fresh-frame control confirms the existing pause/seek/play behavior; delayed
frames expose the missing elapsed time even below the coarse correction threshold.

## Verification

Executed commands:

```powershell
npm test -- src/youtube/__tests__/sync.test.ts src/youtube/__tests__/sync-integration.test.ts src/storage/__tests__/preload-reorder-residency.test.ts --reporter=dot
npx vitest run src/youtube/__tests__/sync-heartbeat-delay-repro.test.ts --reporter=json --outputFile=C:/Users/HEVC/AppData/Local/Temp/MUSIXQUARE-youtube-heartbeat-repro-2026-10-17.json
npx vitest run src/youtube/__tests__/sync-heartbeat-delay-repro.test.ts src/youtube/__tests__/sync.test.ts src/youtube/__tests__/sync-integration.test.ts src/storage/__tests__/preload-reorder-residency.test.ts --reporter=json --outputFile=C:/Users/HEVC/AppData/Local/Temp/MUSIXQUARE-youtube-heartbeat-combined-2026-10-17.json
npm run typecheck:tests
```

- Existing three files: **281 pass / 0 fail / 0 skip**.
- Final combined run: **302 tests, 296 pass / 6 fail / 0 skip**, exit code 1.
  All six failures belong to the reproduction file, with the calls described
  above. No caught handler error was reported by the test's error-log assertion.
- The test author and an independent reviewer checked the setup and control
  cases. An independent execution confirmed the same six failures.
- ESLint for the new test, `npm run typecheck:tests`, and `git diff --check`
  passed; Prettier was applied to the new test.
- No full-suite, browser E2E, remote CI, runtime repair, commit, push or deployment.

## Limits and next boundary

This proves incorrect application seek targets for the injected timing/state
conditions. It does **not** prove that file preload caused those conditions in
the user's event, nor does it simulate real Android audio, YouTube buffering,
network congestion, SCTP delivery, CPU stalls or memory pressure.

The preceding code review found ordinary next-file preload isolated from current
YouTube ownership. Bulk and control traffic use separate ordered RTCDataChannels
on one peer connection. File finalization still uses the main thread, and shared
resource pressure remains a hypothesis requiring runtime evidence.

Follow-up repair should give playing-heartbeat corrections a consistent current
target, retaining calibrated-clock, freshness, paused-host, media identity,
manual-offset and end-boundary behavior. This report does not authorize or claim
that repair. Release record §1 and release history remain unchanged.
