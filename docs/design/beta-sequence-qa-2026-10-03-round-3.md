# Beta sequence QA, round 3 — 2026-10-03

| Field | Value |
| --- | --- |
| Status | Dated discovery evidence, followed by the SQ05–SQ06 repair addendum below |
| Tested checkout | `mxqr_beta`, `60eb127322684b1a960a93910962192b7fc334f8` |
| Product/test code | `1c26dc4ea10263790fedd345f9c20950d09dfc13` — includes SQ02–SQ04 repairs |
| Main reference | `35759e8b07f1ee0b272afbd0af03c770a858889e` |
| Environment | Windows, Node 24.20.0, Vitest, Chromium, local PeerJS; controlled external service/media boundaries |
| Related records | [Living release record](../beta-release-readiness-archive-2026-10-10.md), [previous sequence QA and repairs](beta-sequence-qa-2026-10-03-round-2.md) |

## Result and scope

This section preserves the original discovery. Current disposition and later
verification are recorded in the [repair addendum](#repair-addendum--2026-10-03).

**Two new defects were confirmed and independently reproduced.** This round
examined demo interruption and settings authority, PRO live playback commits
versus persisted snapshots, remote download/decode ownership, and YouTube
preparation with native playback controls. Product code and tracked tests remain
unchanged. Only QA records are committed to beta; main and production remain
frozen.

| ID | Priority | Confirmed effect | Verified scope |
| --- | --- | --- | --- |
| SQ05 | P2 | Failed demo entry restores old audio effects over a newer accepted host settings snapshot | Standard guest, settings synchronization ON, same live room/connection |
| SQ06 | P2 | A current YouTube error or unknown-duration end observation is discarded between a live COMMIT and heartbeat snapshot hydration | PRO participant with playback control, exact current playback revision |

These are two causes, not seven defects inferred from failing assertions.
Production incidence and physical-device prevalence were not measured. The
introducing commits were not bisected. Prior SQ01–SQ04 repairs remain recorded
as completed; this round does not reopen them based on synthetic candidates.

## SQ05 — failed demo entry rolls back newer room effects

The guest accepts a canonical reverb value of 10%, then starts loading the
host's demo. Its entry snapshot captures that value. While the demo CDN request
or its built-in retry is pending, the same live host publishes a newer canonical
settings sequence with reverb 60%. The real effects handler accepts it. Both
demo requests fail, and the failure path exits demo with audio restoration.
After the exit curtain, the guest is back at 10% despite settings sync remaining
enabled. The same overwrite occurs when the newer snapshot arrives during the
curtain or follows operator revocation and host re-baselining.

The failure path in [demo mode](../../src/demo/mode.ts) requests
`restoreAudioSettings: true`. Its restore gate checks demo generation and room
identity, but not whether a newer settings authority superseded the captured
values. `restoreSnapshot` writes the older effects and refreshes their UI.
[Effects synchronization](../../src/audio/effects.ts) retains the newer
canonical snapshot, but demo rollback neither uses it nor requests its
reapplication.

This is local settings divergence, not a guest publishing unauthorized values.
A later accepted host settings snapshot restores consistency. Successful demo
completion preserves the latest values, sync-OFF guests retain their local
settings, and a replacement room connection is protected by the existing room
fence. Those controls pass. Read-only main comparison shows the old snapshot
restore structure there too; main was not executed for this finding, so no
precise introduction date is asserted.

Seven new sequences: **four healthy controls pass, three fail for this one
cause**. Both the agent run and primary-agent independent replay agree. Actual
demo orchestration, effects authority, protocol and state/UI projection run;
native audio, CDN transport and decode are controlled stand-ins.

## SQ06 — PRO loses one-shot media observations before snapshot catch-up

A valid live PRO playback COMMIT advances and applies local media revision N.
The corresponding heartbeat HTTP response is still being read, so the stored
room snapshot remains at N−2. Before it finishes, the actual iframe callback
reports error 150 (`unavailable`), or ENDED while duration is still unknown.
The observation correctly identifies the applied revision N.

In [the playback controller](../../src/pro-room/playback-controller.ts),
`submitPlaybackIntent` compares ended/unavailable's exact revision against the
older stored snapshot. It refreshes the heartbeat and returns without retaining
or replaying the observation. The neighboring `advance-sub-video` path already
uses the applied revision for this window. Receiving the completed snapshot
does not reissue the discarded event.

The stronger probe runs real session/join/runtime/controller hooks, the actual
bounded HTTP body parser and `applyProPlaybackYouTubeCommit`, then drives the
real [iframe callbacks](../../src/youtube/iframe.ts). After releasing the
heartbeat body, **20 seconds of timers and UI polling, including the ordinary
heartbeat interval, still produce no observation command**. The same events
after snapshot catch-up are submitted normally. Known-duration ENDED also
recovers through its existing canonical-boundary retry, so this is not a claim
that every track end stalls.

An affected playback controller can therefore fail to initiate the expected
error/end advancement. Another participant's valid observation or a later
explicit command may recover the room; the result does not prove every
participant stalls indefinitely. No server authorization or stale-revision
fence should be weakened to repair this client timing gap.

Two independent compositions cover the same five cases: **six pass, four fail
for one cause**. The primary agent independently reran both compositions with
the same result. HTTP and native YouTube behavior are modeled; no live PRO
service, account or public playlist was changed.

## Candidates not counted as confirmed defects

- **Remote descriptor during an older decode:** native and bounded-engine
  composition can discard the successor's completed GET if its descriptor
  arrives before any preparation while lifecycle remains DECODING. The local
  matrix exposes that boundary, but normal host selection sends PREPARE first
  on the same reliable channel, and its receiver changes lifecycle before
  awaiting route detection. Descriptor-only recovery source references alone
  do not establish a legitimate successor ordering. These failures are not
  counted as an end-user defect without a supported sender-to-receiver trace.
- **YouTube PAUSE/PLAY while the next cue is pending:** a direct-handler probe
  exposes stale native identity/position after cancellation. However, browser
  verification did not establish that an actual controller can send the
  required actions in that protected window. An earlier non-FIFO native model
  was also invalid and discarded. Neither probe is evidence of a confirmed
  regression. The two browser reachability probes failed their setup/action
  prerequisites, not a proved user-facing playback assertion.

## Verification and limits

| Check | Result / interpretation |
| --- | --- |
| Confirmed sequence probes | 17 tests: 10 pass / 7 fail / 0 skip, representing SQ05 and SQ06; independent primary-agent replay agrees |
| Existing demo/session controls | 7 files / 204 pass / 0 fail / 0 skip |
| Existing PRO/runtime/iframe controls | 4 files / 301 pass / 0 fail / 0 skip |
| Selected PRO Worker contracts | 4 pass / 0 fail; 308 other tests were excluded by the name filter, not executed |
| Remote audio exploratory matrix | 20 tests: 14 healthy/valid controls pass; 6 synthetic boundary failures remain unconfirmed, not release-blocking defect findings. Independent primary-agent replay agrees |
| Chromium focused controls | 4 files / 14 pass / 0 fail / 0 skip / 0 flaky, retries 0 |
| Build | E2E build passes; production build/deployment not run in this discovery round |

Chromium covered demo reliability/settings, remote-upload browser controls and
pending YouTube seeks using the existing tracked tests. External requests were
modeled or blocked. This is not a full-suite rerun, a live provider outage, a
physical codec test, or a measurement of acoustic alignment. Historical whole
unit/E2E results in the release record remain evidence for their stated SHA and
date and are not added to these totals.

Ignored evidence root: `scratch/qa3-2026-10-03/`:

- `session/demo-settings-sequence.test.ts`, `session/vitest.config.ts`,
  `session/root-results.json`, `session/controls-results.json`, `session/report.txt`.
- `pro/observation-heartbeat-order.test.ts`, `pro/runtime-observation-order.test.ts`,
  `pro/vitest.config.ts`, `pro/root-results.json`, `pro/controls-results.json`,
  `pro/server-contract-results.json`, `pro/report.md`.
- `audio/remote-decode-sequences.test.ts`, configs and result files preserve
  the unconfirmed boundary probes separately from confirmed findings. Final
  20-case evidence: `audio/completion-results.json`,
  `audio/completion-repeat-results.json`, `audio/root-final-results.json`;
  `audio/report.txt` explains the real FIFO and preload-activation controls.
- `youtube/` preserves rejected/reachability probes, their logs and browser
  attachments; `browser-controls.json`, `browser-controls.log` and
  `build-e2e.log` contain the passing tracked browser/build evidence.

From the repository root, use the existing pinned Node 24.20.0 on PATH:

```powershell
node node_modules/vitest/vitest.mjs run --config scratch/qa3-2026-10-03/session/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config scratch/qa3-2026-10-03/pro/vitest.config.ts
npm run build:e2e
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\scratch\beta-upgrade-2026-09-09\playwright-browsers"
$env:MXQR_E2E_APP_PORT = '4206'
$env:MXQR_E2E_PEER_PORT = '9036'
node node_modules/@playwright/test/cli.js test e2e/demo-reliability.test.ts e2e/demo-settings.test.ts e2e/youtube-pending-seek.test.ts e2e/remote-upload-browser.test.ts --project=chromium --workers=2 --retries=0
```

## Remaining work

Revalidate and repair SQ05–SQ06 before promotion, retaining same-room/newer
settings authority and exact-current media authority respectively. Promote
minimal reproductions and neighboring stale-owner/cancellation controls into
tracked tests with the repairs. There is no new dependency, schema, secret,
binding, migration, version/cache change or special recovery action from this
documentation-only round. Existing dependency-security, physical-device and
exact-main-SHA release gates remain in the living record. The competition
freeze still prohibits main advancement, production deployment and Operations
Drift Audit reactivation.

## Repair addendum — 2026-10-03

The owner requested repair. Both findings were reproduced before changing
their corresponding source. The fixes affect App client code and regression
tests only. UI, settings policy, permissions, messages, server contracts,
dependencies, release version/cache and deployment scope remain unchanged.
Main and production stay frozen.

Verification used Windows, pinned Node 24.20.0, Vitest and local Chromium/PeerJS.
Tested product/test code is `d4dd4bbb94c58624f50887d12dc5dd017fb95f7a`, based on
checkout `cb60292d5fb1b47000ec6ac6915faa466465cf25`. Subsequent edits only update
documentation. It is not an exact-main-SHA release candidate.

### SQ05: preserve newer applied effects during rollback

Effects synchronization now retains the identity and effects of the latest
authority actually applied on this device. Cached snapshots received while
synchronization is OFF do not claim that ownership. The coordinator's own
canonical publish is recorded too, and ending the session clears the record.

A demo entry captures that applied authority. If failed entry later restores
audio while synchronization is ON and a newer applied authority exists, room
effects come from the latter rather than the old entry snapshot. Device-local
channel role, preamp and subwoofer cutoff retain their existing rollback.
Master volume is not added to the demo snapshot or rollback. Normal demo exit,
local sync-OFF restoration and room/connection/generation guards remain intact.

Twelve new actual demo/protocol/effects regressions cover loading and curtain
timing, operator revocation, snapshot arrival after rollback, sync OFF, newer
connection, unchanged authority, stale/conflicting snapshots, every effect
including zero/false values, published coordinator edits and session cleanup.
Five existing fixture mocks expose the new authority getter; their assertions
were not weakened.

The new browser regression uses real host and guest contexts/data channels.
The host toggles bass using the demo UI while the guest's CDN request is held.
After that setting and the debounced demo flags arrive, two controlled HTTP
503 responses exhaust the guest's request and retry. Before the fix the guest
returned to bass 0 instead of 0.6; after it, both state and the main settings
chip retain 0.6. The successful-load/normal-exit control also passes. An early
fixture released the failure before the host's debounced entry frame arrived,
legitimately causing another demo attempt; the final test waits for that frame
instead of changing the product's retry behavior or loosening a count assertion.

### SQ06: use the current applied media revision for observations

The PRO controller extends its existing applied-revision check for
`advance-sub-video` to `ended` and `unavailable`. A successfully applied live
COMMIT is sufficient to submit the exact current observation while a stored
heartbeat snapshot catches up. The highest-known revision guard, room/epoch,
permissions and command/authority generations still reject obsolete work.
First-append selection retains its separate persisted-snapshot requirement.

Twenty-one new regressions compose real session/runtime/controller/API body
parsing and renderer/iframe callbacks. They cover immediate submission before
heartbeat completion, queued current observations, newer seek/pause/sub-video/
queue-item commits, a known but not yet applied successor, permission revocation
and restoration, and actual leave/rejoin of the same room and epoch.

Known-duration ENDED keeps its existing one-time canonical-boundary retry for
personal-offset timing. A fixture whose server always returns `unchanged` now
observes the initial event plus that retry; it is bounded at two and remains
on the same revision. The fix does not remove that recovery path to satisfy an
old assertion that only saw the retry after the initial event had been lost.

### Completed verification

| Check | Result |
| --- | --- |
| Whole unit suite | 503 unique files / 10,458 pass / 0 fail / 0 skip after the tool-path replay described below |
| New tracked module regressions | 33 pass / 0 fail / 0 skip; independent review/replay agrees |
| Focused Chromium | 9 files / 50 pass / 0 fail / 0 skip / 0 flaky, retries 0; includes the two new demo failure/success cases |
| Static checks | App, test and E2E TypeScript; App lint and new E2E lint; changed-code formatting; source complexity, room-authority and Playwright API guards pass |
| Builds | E2E and production builds pass; all eight production artifact guards pass |

The initial whole-unit run had 10,457 pass, zero failures and one explicit
local-tool skip. Setting `MXQR_TEST_JQ_PATH` to the already installed jq 1.8.2
enabled the skipped release-script case; its complete 97-test file passed.
Replacing that file's initial result yields 10,458 unique passing tests, not
the sum of both runs. No test source or expectation was changed for this replay.
`full-unit.json`, `jq-recheck.json` and `unit-reconciled.json` retain the counts.

Tracked regressions:

- [Demo authority rollback](../../src/demo/__tests__/mode-settings-recovery.test.ts)
- [PRO observation/heartbeat ordering](../../src/pro-room/__tests__/runtime-playback-observation-hydration.test.ts)
- [Browser demo settings recovery](../../e2e/demo-settings-recovery.test.ts)

Ignored raw evidence is in `scratch/sq05-sq06-repair-2026-10-03/` (browser
before/after, independent review, static checks and builds) and the preserved
`scratch/qa3-2026-10-03/{session,pro}/` repair-control results. Discovery
failures above remain unchanged. The PRO runtime regression models the server
and native YouTube API; it does not validate live service behavior or physical
speaker alignment. The entire E2E, WebKit, coverage and live-service suites
were not rerun in this repair round. Existing dependency-security,
physical-device, version/cache and final-main-SHA release gates remain.

SQ05–SQ06 are resolved within the tested scope. The excluded discovery
candidates remain unconfirmed and were not modified. No migration or special
recovery step is introduced; the existing eventual release/rollback runbook
still applies.
