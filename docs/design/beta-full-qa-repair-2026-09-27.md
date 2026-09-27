# Full beta QA repair and verification — 2026-09-27

| Field       | Value                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Status      | Repair complete; final local verification passed; production freeze active                              |
| Baseline    | `8c78a598121e2226f4ecfc4ed176e8e0704bed3d`, `mxqr_beta`                                                 |
| Environment | Windows; pinned Node 24.20.0, Vitest 5, Playwright 1.63.0, Chromium revision 1243, WebKit revision 2359 |
| Related     | [Discovery evidence](beta-full-qa-2026-09-27.md), [release readiness](../beta-release-readiness.md)     |

The discovery report remains the record of the original failures. This change
repairs FQA01 and QA-T01–QA-T03 on beta. It does not publish production, advance
main, reactivate Operations Drift Audit, or change room policy or manual-offset
limits.

## Runtime correction

`src/youtube/zero-start-ownership.ts` gives manual synchronization one shared
admission rule: both the zero-start protocol and its external player recovery
must retire before another synchronization operation may own the iframe.

The recovery's existing iframe-event suppression ends immediately before its
release command, allowing a genuine PLAYING event to reach the UI. Synchronization
ownership now lasts until that release is acknowledged or its bounded cleanup
finishes. The two lifetimes must remain distinct.

- Eager UI, the deferred manual editor, network nudge/value/reset handlers,
  rendezvous admission and delayed callbacks share the complete ownership rule.
- Ordinary heartbeats and auxiliary state messages still refresh the host
  snapshot, but cannot issue competing commands during release acknowledgement.
- Explicit newer pause/seek commands retire the pending recovery before applying
  the new action. The existing in-flight versus protocol/calibration distinction
  is retained for ordinary heartbeat handling.
- Recovery readiness notifications are coalesced after the cleanup/transfer
  stack and update Sync availability. An already-open editor stays open;
  attempted changes while recovery owns the player are rejected before offset
  mutation. Reinitialization first retires the previous integration's timers
  and retained player state.
- Adjacent host consumers use the same rule: an app seek during legacy recovery
  cancels that older retry, and a late joiner waits rather than receiving the
  host's temporary muted preparation state.

The focused module run passed **744 tests in eight files**. Nine new integration
cases cover negative offsets, rejected competing actions, delayed PLAYING,
heartbeat isolation, newer pause/seek in both held and acknowledgement phases,
and cleanup/reinitialization. The existing host-seek regression now enters
through the actual UI bus, and a host fallback/late-join case was added.

The tracked browser regression enters `-9999 ms` through the real editor,
delays only fake iframe responses to miss the actual PREPARE cohort, observes
the actual COMMIT, and clicks the real Sync button before delayed release. It
checks correct playback immediately and over later heartbeats, then verifies
that Sync can be used again. This prevents a permanent-disable workaround from
satisfying the test. The first targeted browser run passed both this case and
the repaired late-join/delete case.

## Test and configuration corrections

- **QA-T01:** the decreasing-playlist test waits for the exact surviving queue
  IDs, the removal revision, and corresponding DOM rows on host and guest.
  The shared minimum-count helper keeps its original meaning. No timeout was
  increased and no assertion was removed.
- **QA-T02:** critical coverage includes the existing
  `device-failure-sequence-qa.test.ts`.
- **QA-T03:** Worker coverage includes the existing
  `account-cookie-ordering.test.ts`.

All original coverage thresholds remain unchanged. Portable official jq 1.8.2
was verified against both the GitHub asset digest and published checksum before
execution. `MXQR_TEST_JQ_PATH` enables the formerly skipped Windows release
classification fixture without installing jq globally or changing its test.

## Verification results

| Run                                                       | Result                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Complete unit suite with broad coverage                   | 496 files; 10,264 pass, 0 fail, 0 skip; original thresholds pass                         |
| Critical coverage                                         | 50 files; 1,772 pass, 0 fail, 0 skip; original global and per-file thresholds pass       |
| Tooling coverage                                          | 13 files; 342 pass, 0 fail, 0 skip; original thresholds pass                             |
| Worker coverage                                           | 26 files; 1,726 pass, 0 fail, 0 skip; original thresholds pass                           |
| Targeted repaired browser cases                           | 2 pass, 0 fail, 0 skip                                                                   |
| Full Chromium selection                                   | 552 pass, 0 fail, 0 skip, 0 flaky across four isolated shards; all CLI exits 0           |
| Official Windows WebKit mobile lane                       | 60 pass, 0 fail, 3 existing desktop-context exclusions                                   |
| Production-build Chromium and WebKit Service Worker smoke | Chromium 9 pass; WebKit Service Worker 1 pass; 0 fail, 0 skip, 0 flaky; both CLI exits 0 |

Profiles overlap and their test counts must not be added. Tooling and Worker
profile results precede the final UI-only correction; their sources and coverage
configurations were unchanged, and all their tests also passed in the final
complete unit suite. The final four Chromium CLI
shards use separate preview/PeerJS ports, origins, contexts, JSON results and
output directories; each retains one worker and zero retries. They run the
unchanged official configuration's complete test selection.

All 23 static type/lint/format/security/source/syntax commands passed after the
implementation was finalized. An initial scan while editing caught a missing
Promise rejection handler and one unformatted test; both were corrected and
the full commands rerun, including their previously short-circuited tooling
stages. Full typecheck, lint and format checks were run again after the final
UI correction and all exited 0. The six Worker bundles also passed local
Wrangler dry-run. The final production build and all eight artifact guards
passed; its Chromium and WebKit smoke used that same build without E2E hooks.

Broad coverage: statements **86.24%**, branches **79.83%**, functions **90.88%**,
lines **89.95%**. This is the full unit suite, not a selected fast subset; a
separate duplicate invocation without coverage was unnecessary.

Final test review strengthened the reinitialization regression: EventBus catches
listener exceptions, so its callback records observations and assertions run
outside the callback. The resulting nine-case file, test typecheck, lint and
formatting passed. The first complete suite executed this fixture at 18:02:57 KST,
after its final edit at 17:58:00 KST. Runtime and configuration hashes remained
unchanged during that unit run; the one test-only delta is preserved in the
ignored source-identity evidence.

### Regression found during the first full browser run

The first Chromium shard completed 290 tests successfully. The second exposed
an actual UI regression in the unchanged `youtube-manual-repeat.test.ts`:
the new readiness listener closed an already-open manual Sync editor when
repeat-one started. This was not treated as a flaky test. Once its cause was
confirmed and the minimal fix was prepared, that obsolete-build run was stopped
at case 241/262; its failure log is preserved rather than reported as a completed
suite.

The readiness listener now only updates button availability, preserving the
existing open editor. Merely keeping the editor open cannot touch the player;
attempted nudge/value/reset actions during recovery are still rejected by the
shared network admission guard before changing the offset. The UI regression
test checks editor persistence through both protocol and external-recovery
states, no extra rendezvous, and usability after release. The original repeat
E2E was not altered. Focused UI/network tests passed **277/277**, with type,
lint and format checks.

After this correction the runtime was frozen again. Full Chromium, the supported
WebKit lane, production browser smoke and final static checks passed. The
initial four coverage runs and browser failure remain separate evidence, not
substitutions for final results.

A broad-coverage run concurrent with four Chromium shards and static analysis
completed with **10,263 pass / 1 fail / 0 skip**. Its sole failure was the
unchanged playlist-view progressive-focus rerender fixture exceeding the
existing 15-second limit (16.836 seconds), not an assertion mismatch. Source
hashes were unchanged throughout that run; no coverage summary was emitted, so
it is not counted as a coverage pass. After every browser/build/static process
completed, the entire broad suite passed **10,264/10,264**, with the same two
workers, original timeout and unchanged fixture. That rerender case took
**6.928 seconds** in this run; the observed difference is consistent with CPU
contention in the concurrent run. Final critical coverage also passed 1,772/1,772 and every original coverage floor. The
failure log remains under `final-unit/`, and final idle evidence under
`final-idle/`. Future local full-coverage runs on this PC should be separated
from full browser lanes to avoid this resource contention.

All 35 registered source/artifact guards were cross-checked against the CI and
nested npm scripts. Critical/runtime/release browser subsets are already covered
by the full Chromium selection. The full unit suite also exercises actual Vitest
blob merging and threshold failures in the CI coverage contract tests.

## Release scope and limits

This repair adds App client code and test/configuration changes. It requires
no new Worker contract, dependency, D1 migration, binding, secret or translated
copy. The accumulated beta release scope remains in the maintained runbook.

Public version **8.6.61** and cache **v630** remain unchanged during the freeze.
The cache-history guard remains a promotion prerequisite until an authorized
release includes a covering version/cache commit; its policy is not bypassed.
The current local guard was executed and exited 1 because beta runtime changes
are newer than the last cache increment. This is an outstanding release gate,
not a passing check or a runtime-test failure.

Browser synchronization checks use deterministic YouTube API fixtures and local
PeerJS. Native local-file tests use Chromium Web Audio where specified. Windows
WebKit uses a mobile viewport, not an iPhone device. These results do not establish
physical speaker/Bluetooth alignment, real YouTube service buffering, or live
production SFU/Worker behavior.

Ignored evidence: `scratch/full-beta-repair-2026-09-27/`. Focused ownership
regressions are additionally retained under
`scratch/full-beta-qa-2026-09-27/standard-review/repair-final*`.
