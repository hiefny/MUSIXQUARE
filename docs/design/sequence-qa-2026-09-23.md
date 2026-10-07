# Sequence QA — 2026-09-23

## Scope and execution boundary

Baseline: local `mxqr_beta` at `cc979c82` (8.6.61 / cache v630), including
the bounded AAC engine. This audit runs locally during the competition freeze.
It does not publish a branch, advance `main`, re-enable Operations Drift Audit,
or deploy an application update.

Two GPT-6 Luna agents generate and exercise additional scenarios in parallel.
The primary agent reviews their fixtures, assertions, generated combinations,
and alleged defects independently. A test-harness failure is not classified as
a product defect without a valid reproduction through the production path.

## Additional scenario contracts

- **Standard-room admission:** an existing playing guest remains connected
  while another guest reconnects and a third joins. Vary transport open,
  bootstrap HELLO/APPLIED, and delayed close/error events from the old exact
  connection. Check both live connection ownership and messages sent to the
  existing guest.
- **Decoder completion ordering:** a deliberately non-cooperative decoder
  finishes after pause, stop, source takeover, or a newer load. Check that
  obsolete success/failure cannot publish audio, show an obsolete error, or
  keep the pending-start state set. Permute three load completions as well as
  their stale success/failure results.
- **Browser action sequences:** use independent real browser contexts and local
  WebRTC signaling. Combine lifecycle operations with actual playback, queue,
  and administrator controls. Save the plan and action history as a Playwright
  attachment so a failure can be reproduced from its case identifier.
- **PRO authority:** exercise the real playback controller around pending
  preparation/commit and room, epoch, or permission changes. Assertions must
  distinguish client lifetime fencing from the server's permission checks.

Matrix dimensions are explicit Cartesian products or explicit action orders.
Different labels, codec names over the same mocked decoder, or delays that
execute an identical order do not count as different scenarios. Generated
browser plans and admission cases reject duplicate plan signatures.
The browser test's `seed` field is a stable case identifier for an explicit
plan, not a claim of random fuzzing or exhaustive state-space exploration.

## Independent review

The primary review also checked the standard-room queue/YouTube mutation
authorization boundary, exact-connection ownership, PRO controller commit
callers, bounded PCM scheduling, and playback-resource ownership.

One suspected PRO stale-commit path depended on calling a low-level hook
without its optional `isCurrent` callback. Both production controller commit
paths provide that callback and fence the room/generation/authority. That
hypothesis was not accepted as a reachable product defect.

Initial generated tests contained harness errors: correlated matrix axes,
duplicate completion patterns, invalid fixtures, a nonexistent message enum,
and browser comparisons that included a host-only `File`. These were corrected
in the tests. The admission assertion was also strengthened to reject each
individual forbidden frame, rather than only a set of frames appearing
together. None of these findings is counted as an application bug.

## Confirmed defect and correction

The additional host-loss browser case exposed one **local PeerJS adapter**
defect. Closing the host's browser context left the guest with aggregate
`RTCPeerConnection.connectionState === 'failed'`, while its ICE state stayed
`disconnected` and its data channel still reported `open`. The native PeerJS
1.5.5 handler observes ICE state only, so no terminal connection event reached
the application. One recorded run remained in `PLAYING_AUDIO` with a retained
host connection and no disconnect dialog for more than 90 seconds.

The adapter now also observes terminal aggregate states (`failed`/`closed`)
for incoming and outgoing data connections. It closes the exact connection
through the ordinary application teardown path, removes its listener on close,
and leaves transient `disconnected` states alone. Five additional unit cases
cover both directions, transient recovery, caller-handler registration, and
old-connection cleanup without affecting a replacement. The four initial
regressions failed before the fix; the final six-case adapter file passes.

This is **not a newly established public-service outage**. Non-loopback hosts
are forced to the Cloudflare transport by `transport/config.ts`; that adapter
already handles aggregate terminal state and its bounded recovery policy.
Its existing tests and the UI stop-before-disconnect-dialog tests were rerun.
No recovery duration or public-room policy was changed.

The pre-fix timeline establishes transport and application-state failure,
not measured speaker output. Local audio uses Web Audio; the page's dummy
HTML audio element is not the active track. Post-fix browser assertions check
the terminal dialog, released host connection, stopped playback projection,
and reset playback offset, alongside the unit-tested media-stop path.
The first post-fix browser run reached that terminal state at 16.187 seconds
after host-context closure; this is a measured local run, not a universal
disconnect-detection deadline.

## Validation boundaries

The full Chromium suite complements the new cases with existing join/rejoin,
multi-guest, playlist/preload, local playback, demo, chat, permissions,
YouTube-transition, system-audio-control, and UI regressions. Real media-codec
fixtures cover the native/bounded playback work. Worker tests exercise local
Worker implementations and simulated service dependencies.

The WebKit lane runs the repository's mobile browser checks on Windows. It is
not a physical iPhone/PWA test or proof of iOS WebRTC behavior. YouTube and
capture tests use the repository's controlled fixtures where specified; they
do not establish live-provider or real microphone/speaker timing guarantees.

No run here reproduces every mobile radio handoff, every router topology,
audible multi-device clock alignment, or a multi-day session. Passing this
suite means no defect was found under the executed conditions, not that all
possible action sequences are safe.

## Results

Added 133 distinct regression cases: admission 64, decoder ordering 27,
PRO authority 6, queue acknowledgements 6, browser sequences 25, and adapter
terminal state 5. These are additional cases, not the sum of repeated runs.

| Run                                                                | Result                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| Full Vitest run, including admission and media matrices            | 452 files; 9,289 passed, 1 skipped                     |
| Primary-agent rerun of all four new unit files                     | 103 passed: admission 64, media 27, PRO 6, queue ACK 6 |
| Windows WebKit mobile lane                                         | 60 passed, 3 skipped                                   |
| Full existing Chromium browser suite, before the local adapter fix | 478 passed                                             |
| Additional Chromium action sequences, final assertions             | 25 passed; no retries, skips, or flaky results         |
| Post-fix focused units, including transport and disconnect UI      | 8 files; 313 passed                                    |
| Post-fix Chromium join/reconnect/background/playback regressions   | 24 passed                                              |
| App/test TypeScript / targeted ESLint / source complexity          | Passed                                                 |

The WebKit skips are the desktop entrance timing, mobile-hidden carousel
arrows, and desktop hover interaction. They are not failed mobile checks.
The unit skip is the existing release-marker `jq` check when that executable
is unavailable outside CI.

The full unit run started before the additional PRO/queue authority files were
complete. Their final focused results are reported separately, without counting
overlapping reruns as extra coverage. Scratch logs live under
`scratch/luna-qa/` and the two agent-specific scratch directories.

### Local reproduction

Use the repository's pinned Node 24.20.0 environment and installed dependencies.
The full baseline browser run started before the new browser test was added;
future unfiltered runs also include that file.

```powershell
npm run build:e2e
node node_modules/@playwright/test/cli.js test --project=chromium --reporter=line
node node_modules/vitest/vitest.mjs run --maxWorkers=2
node node_modules/@playwright/test/cli.js test --config=playwright.webkit.config.ts --reporter=line
```

Run these browser commands sequentially with the default ports, or assign
distinct `MXQR_E2E_APP_PORT` and `MXQR_E2E_PEER_PORT` pairs when running lanes
concurrently. This audit used 4183/9010 for the baseline, 4184/9110 for the new
browser sequences, 4186/9130 for WebKit, and 4185/9120 for post-fix regressions.
The E2E build was refreshed after the adapter fix, with no browser lane active
during the rebuild.

```powershell
node node_modules/vitest/vitest.mjs run src/network/__tests__/luna-session-ordering.test.ts src/network/__tests__/luna-queue-ack-ordering.test.ts src/player/__tests__/luna-media-ordering.test.ts src/pro-room/__tests__/luna-playback-controller-ordering.test.ts --maxWorkers=2
node node_modules/@playwright/test/cli.js test e2e/luna-session-sequences.test.ts --project=chromium --reporter=line
```

Select one browser case with `--grep 'seed 470006:'`. The matrix test saves
action histories and runtime diagnostics as Playwright attachments. Unit
cases name their action/completion order directly. No randomized timeout or
retry is used to turn a failing test green.

### Evidence retained locally

- `scratch/luna-qa/unit-full.log`: full unit baseline.
- `scratch/luna-qa/full-e2e.log`: 478-case Chromium baseline.
- `scratch/luna-qa/webkit.log`: Windows WebKit mobile lane.
- `scratch/luna-qa/peerjs-before.log`: four red adapter regression cases.
- `scratch/luna-qa/final-focused.log`: 313 post-fix unit cases.
- `scratch/luna-qa/post-fix-e2e.log`: 24 post-fix browser regressions.
- `scratch/luna-join-qa/host-loss-timeline-before-adapter-fix.json`:
  failed transport retained for more than 90 seconds before the fix.
- `scratch/luna-join-qa/final-report.json`, `results/`, and `host-loss-timeline.json`:
  additional browser-run report, per-case action histories, and terminal-state
  observations. Later runs may replace these scratch outputs; committed tests
  remain the reproducible contract.

The final browser matrix requires a seek target more than five seconds from
the previous offset and exact expected next-track IDs on both host and guest.
Matching the same stale state is insufficient. The final host-loss run reached
the stopped state at 16.200 seconds, with the terminal dialog visible, host
connection cleared, and playback offset reset to zero.

## Outcome

One confirmed defect in the local development/test adapter was fixed and
verified. No additional public-service defect was established by this audit.
The regression tests join the normal Vitest and Playwright file discovery;
they require no recurring automation or production change. All changes remain
local on `mxqr_beta`, with `main` and the production release unchanged.
