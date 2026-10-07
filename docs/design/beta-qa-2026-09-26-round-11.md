# Beta QA — 2026-09-26, round 11

Baseline: `mxqr_beta` at `00acd703`. Scope: current/preload file handoff during
selection changes, PRO asset download ownership, remote receive lifetime, and
bounded decoder cancellation. Work remains on beta; no main update, production
deployment, or app/cache version change.

## Confirmed findings

### 1. Server-authoritative PRO selection discarded a partially downloaded preload

The PRO playback PREPARE enters the real playlist endpoint with server authority.
The existing pending-preload adoption branch excluded that authority, so it ran
only on the legacy selection path. Before selecting the new current occurrence,
`clearPreloadState()` cancelled its in-flight background download. Resolving the
selected file then requested the same asset again from the beginning.

A regression uses the production PRO runtime, playback preparation endpoint and
media transfer with a real Response ReadableStream paused after part of its body.
On the baseline, preparation aborted that body, cancelled its reader, and opened
a second GET. The fix lets server PREPARE adopt the existing pending download.
The separate legacy autoplay branch remains excluded: recursive preparation
preserves the server's paused preparation options and waits for COMMIT to play.
Three new tests cover completion of the original partial stream through the
production preparation/decode path, supersession by another PREPARE, and room
departure. Only native decode is controlled in the completion case: it receives
the original complete bytes, publishes the correct resident, reports ready,
and leaves playback paused without creating an output source. The related
runtime suite finishes with **12 passed**.

The first full-suite run also exposed a stale playlist-unit expectation. It
captured the previous resident at the synchronous entry to a mocked resolver
and described this as retaining audible playback until COMMIT. The baseline
actually stopped output before that call and cleared the resident/PCM immediately
afterward, before awaiting the receive. Independent review confirmed this is
not an audible-policy change. That unit now checks the stable pending state:
old bytes/PCM are released, decoding has not started, and the lifecycle is
pending. Its existing server-authoritative decode assertions remain. The two
playlist/runtime suites pass **126 tests** together; the real streamed-body
regression establishes the separate no-second-GET claim.

### 2. Reusing an active remote download could restore an obsolete absolute timeout

A standard-room guest can still be receiving A when the host selects B and then
returns to A before B's descriptor is published. Reusing A's cached remote
object correctly preserves the GET and updates its playback session. However,
updating the wait state rearmed the room's 315-second descriptor/admission timer,
even though the download already had the transport's progress-aware 90-second
stall watchdog. A healthy, slow transfer could therefore time out solely because
its playback session changed.

The regression runs the production FILE_PREPARE and descriptor handlers through
the real remote download client with a controlled native XHR and clock. Progress
arrives every 60 seconds for six minutes. The baseline aborts the one GET at the
room deadline, emits the timeout toast, and never publishes the completed file.

The download owner now records whether transport has started. Rebinding an
already-started exact owner clears the obsolete room timer; waiting for memory
admission still retains that deadline. Four regression/control cases cover
successful progress beyond six minutes, admission timeout before GET, genuine
transport stall with its existing single retry, and host replacement with no
stale completion or toast. Six related receive/admission suites finish with
**149 passed**.

## Other investigation

- Standard-room current/preload send priority, Blob read completion, capacity
  waits, recovery takeover, connection replacement, and exact-owner cleanup:
  six existing suites, **126 passed**. No additional confirmed defect.
- Bounded track preparation, reader retirement, playback window ownership,
  native/worker decode cancellation, and bounded/native source replacement:
  six existing suites, **166 passed**. No additional confirmed defect.
- The current stored-file read implementation is RAM-backed. Artificially
  delaying an already-resolved Promise was not treated as a real I/O race.

## Verification

- Independent read-only review confirmed both production entry paths, the
  baseline failures, exact-owner checks, and the added completion/cancel controls.
- Repository typecheck and lint passed. Test typecheck, targeted lint and
  formatting also cover the final added regression/control cases.
- Import graph, dead exports, bus pairing, lifecycle writes, source complexity,
  room authority boundaries, and shared chunk-pump guards passed without
  baseline changes.
- Final Chromium selection: **22 passed**, covering native/bounded MP3/M4A/AAC
  playback, paused late join, rapid seek, large-to-small engine replacement,
  current file transfer, preload readiness, and next/previous navigation.
- Local production build and all eight artifact guards passed: test-hook
  exclusion, security configuration, legacy TV syntax, service worker, UI kit,
  transfer budget, fonts, and app-shell completeness. App `8.6.61` and cache
  `v630` remain unchanged. This build did not deploy production.
- Final full unit suite: **468 files, 9,727 passed, 1 skipped**, including seven
  new regressions/controls. The existing release-deployment-state test requires
  `jq`, unavailable in this Windows environment; CI does not permit that skip.
  The initial full run found only the stale playlist-unit expectation described
  above. After correcting that test and passing its focused suites, the complete
  suite was rerun on the final frozen code and passed.

## Limits

Controlled streams, XHR events and timers reproduce asynchronous ownership and
liveness boundaries; they do not measure production bandwidth or Cloudflare
latency. Chromium tests use local RTC and fixture media. They do not establish
physical iPhone behavior or acoustic synchronization accuracy. Beta pushes do
not run the main-only CI workflow or deploy production.
