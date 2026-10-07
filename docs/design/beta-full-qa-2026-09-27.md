# Full beta QA — 2026-09-27

| Field           | Value                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Status          | Dated evidence; QA complete, one product defect and three test/configuration issues unrepaired                       |
| Tested checkout | `dd55d3bc51c98ca4837038a53616c4e7f80ba9e4`, `mxqr_beta`                                                              |
| Product source  | `c242bfd17f652f1480a6e79731d5130b5b6f6c19`; no product changes during this QA                                        |
| Environment     | Windows, Node 24.20.0, Vitest 5, Playwright 1.63.0; bundled revisions `chromium-1243` and `webkit-2359`              |
| Related record  | [Beta release readiness](../beta-release-readiness.md), [XS01–XS04 repair](extreme-manual-sync-repair-2026-09-27.md) |

This round runs the existing complete test suites and independently reviews the
recent synchronization changes. It does not modify product code, tracked tests,
coverage profiles, thresholds, timeouts, version/cache, main, or production.
New exploratory probes and raw results remain in ignored
`scratch/full-beta-qa-2026-09-27/`.

## Findings

| ID     | Classification       | Finding                                                                                                             | State                 |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------- |
| FQA01  | Product defect       | A Standard YouTube guest's external start recovery and a manual Sync rendezvous can concurrently own the iframe     | Confirmed, unrepaired |
| QA-T01 | E2E assertion timing | Late-join/delete test uses a minimum-count wait for a decreasing playlist, then reads an older snapshot immediately | Confirmed, unrepaired |
| QA-T02 | Coverage selection   | Critical profile omits the existing device-failure sequence tests                                                   | Confirmed, unrepaired |
| QA-T03 | Coverage selection   | Worker profile omits the existing cookie-ordering tests                                                             | Confirmed, unrepaired |

There is **one newly confirmed product defect**, not four. Test-selection and
test-timing problems are reported separately. Passing the existing full unit
suite does not supersede the new failing discovery probe.

## FQA01: manual Sync competes with external start recovery

### Reachable sequence

1. A guest has a negative YouTube manual offset. Its iframe is not ready within
   the host's bounded 2,300 ms PREPARE decision window.
2. The real COMMIT excludes that guest from the prepared cohort. The guest enters
   external fallback recovery; the controller's phase is `error`, while the
   fallback still owns mute/pause/seek and its delayed start.
3. The iframe becomes ready and waits for its negative-offset release deadline.
   The ordinary heartbeat guard correctly leaves that owner alone.
4. The guest presses the real Sync button shortly before the deadline. Both eager
   and deferred UI admission check only `isYouTubeZeroStartProtocolActive()`;
   `guestRendezvousSync` likewise does not exclude the external recovery owner.
5. Manual rendezvous seeks to a future target. The old fallback later interprets
   that nonzero position as failed start preparation and resets the player to 0.
   The surviving rendezvous timer plays from 0 instead of its intended target.

With `-9999 ms`, the deterministic module probe leaves an additional **501 ms**
error. Four real heartbeat-handler calls over the following 12 seconds do not
repair it because it is below the ordinary 3-second drift-correction threshold.
The same module run also incorrectly updates the latency learner from 0 to
150 ms. These are consequences of the same competing ownership, not separate
defects.

Two independent Chromium runs reproduced the actual button-click sequence on
the built app with local PeerJS. Only fake IFrame API load/play response delays
were changed to model slow preparation; no app phase, fallback flag, or manual
offset state was injected. The offset was entered through the real editor and
the host's actual COMMIT cohort was observed. The guest retained an additional
**569 ms / 563 ms** error across four subsequent playback observations. This is
browser/runtime evidence with a simulated YouTube player, not a physical speaker
or real YouTube service measurement.

The module control without pressing Sync starts correctly. `-250 ms` and
`-1000 ms` probes also show competing pause/seek/play commands, but their final
positions recover. Their strict original-start-deadline assertion is not alone
proof of a defect: an accepted manual resync can legitimately take longer. The
decisive evidence is competing owners and the incorrect final position.

An auxiliary `sync:auto-sync` bus probe stalls briefly and recovers on a later
heartbeat. Its exact Reset-button reachability was not established, so it is
not counted as another UI defect or as a permanent hang. An initial browser
attempt delaying load alone did not exclude the already-reused iframe from the
cohort; it is setup evidence, not a successful reproduction.

### Repair boundary

- `src/ui/player-controls.ts` and `src/ui/manual-sync-overlay-runtime.ts`:
  availability currently excludes the scheduled protocol but not external recovery.
- `src/network/sync.ts`: manual/reset admission has the same incomplete check.
- `src/youtube/sync.ts`: new/current rendezvous ownership checks omit fallback.
- `src/youtube/player.ts`: fallback readiness cleanup resets the player after
  another writer has moved it.

Use one complete ownership contract for admission, or explicitly and atomically
transfer ownership before accepting a manual request. UI-only masking or clearing
one timer after issuing seek would not address all entry points and learning.
Preserve ordinary snapshot refresh, explicit newer transport-command cancellation,
and existing XS01–XS04 guarantees. No repair is included in this QA record.

## QA-T01: late join while deleting a track

The unchanged test at `e2e/chaos-scenarios-2.test.ts`, “guest joins while host is
removing a track”, also failed in **3/3 isolated repetitions**. Its
`waitForPlaylistCount(guest, 2)` helper checks `children.length >= 2`; the previous
three-item list satisfies that condition before the newer snapshot arrives.

Read-only browser traces show the host immediately at two items/revision 4 and
the guest initially at three items/revision 3. Without another user action, the
guest converged to the exact two surviving IDs, revision 4 and two DOM rows after
**1.931 / 3.160 / 3.328 seconds** in three diagnostic repetitions. No persistent
stale-playlist product defect was reproduced. The peer was already connected
when deletion occurred; do not attribute these traces to a specific bootstrap
APPLIED branch without further evidence.

Repair this test by polling the exact expected surviving queue IDs/revision,
then assert the UI. Keep the global minimum-count helper's existing semantics
for callers that intentionally wait for at least a given count. Tracked tests
remain unchanged in this round.

## Unit and coverage results

All runs used two workers and the existing assertions, timeouts and thresholds.
These profiles overlap; do not add their counts together.

| Run                                                              | Files |   Pass | Fail | Skip | Exit / interpretation                         |
| ---------------------------------------------------------------- | ----: | -----: | ---: | ---: | --------------------------------------------- |
| Complete unit suite                                              |   495 | 10,249 |    0 |    1 | 0; no isolated retry needed                   |
| Complete suite with broad coverage                               |   495 | 10,249 |    0 |    1 | 0; coverage thresholds pass                   |
| Critical coverage, tracked selection                             |    49 |  1,708 |    0 |    0 | 1; one file-specific function threshold fails |
| Tooling coverage, tracked selection                              |    13 |    341 |    0 |    1 | 0; all thresholds pass                        |
| Worker coverage, tracked selection                               |    25 |  1,697 |    0 |    0 | 1; one file-specific function threshold fails |
| Diagnostic critical selection plus existing device-failure suite |    50 |  1,772 |    0 |    0 | 0; original thresholds retained               |
| Diagnostic Worker selection plus existing cookie-ordering suite  |    26 |  1,726 |    0 |    0 | 0; original thresholds retained               |

The unique complete unit result is **10,249 pass / 0 fail / 1 existing skip**.
The skip is the GitHub-inventory release classification fixture guarded by
`!jqAvailable && !process.env.CI`; this Windows environment lacks standalone `jq`.
There are no new skips. JSON assertion success in a coverage report does not
override a failing coverage command's exit code.

Broad coverage: statements **86.24%**, branches **79.82%**, functions **90.90%**,
lines **89.95%**.

### QA-T02 and QA-T03 causal verification

- `vitest.critical.config.ts` omits
  `src/pro-room/__tests__/device-failure-sequence-qa.test.ts` (64 tests).
  `playback-controller.ts` functions are **119/140 = 85%**, below **87%**.
  Adding only this existing file in an ignored diagnostic config produces
  **127/140 = 90.71%**, and the original gate passes. Broad coverage covers
  **129/140 = 92.14%**. This is profile selection drift, not a failing assertion.
- `vitest.workers.config.ts` omits
  `src/core/__tests__/account-cookie-ordering.test.ts` (29 tests).
  `account-auth.ts` functions are **121/133 = 90.97%**, below **93%**.
  The analogous one-file diagnostic addition produces **125/133 = 93.98%** and
  passes the original gate. The four added functions are predecessor-cookie
  map/filter/map callbacks and cookie-order sorting.

Both omitted suites passed in the normal full run. No thresholds or tracked
profiles were changed. The two original coverage commands therefore remain
failing release prerequisites despite successful diagnostic configurations.

## Browser, build and static verification

| Browser run                                        | Pass | Fail | Skip | Interpretation                                                          |
| -------------------------------------------------- | ---: | ---: | ---: | ----------------------------------------------------------------------- |
| Full existing Chromium suite                       |  550 |    1 |    0 | 551 cases, retries 0, 52.3 minutes. Sole failure is QA-T01 above        |
| Targeted Windows WebKit mobile lane                |   60 |    0 |    3 | Existing desktop-only exclusions in the mobile lane                     |
| Local production-build Chromium smoke              |    9 |    0 |    0 | Includes real Service Worker offline fallback and locale/session checks |
| Local production-build WebKit Service Worker smoke |    1 |    0 |    0 | Controlled navigation outage and real worker recovery                   |

The separately failing FQA01 discovery probes are not part of the tracked full
Chromium suite. Its 550 passing cases therefore do not contradict that finding.
Both E2E and production App builds succeeded. All **eight production-artifact
guards** passed: legacy-TV syntax, Service Worker, UI kit, initial transfer budget,
absence of mutable test hooks, production security, fonts, and app-shell coverage.
The final local `dist` contains the production build, not the E2E build; it was
not published. Browser and signaling processes started for this QA were cleaned up.

- Targeted Windows WebKit: **60 pass / 0 fail / 3 existing mobile-lane skips**.
  Skips cover desktop entrance timing, desktop arrow controls, and desktop hover.
- Initial WebKit attempts on temporary port 4190 could not navigate and were
  stopped. A minimal HTTP A/B test reproduced this WebKit port restriction;
  Chromium could use both ports. The unchanged full WebKit config passed on
  port 4196. This is a QA environment error, not an application defect or a new
  skip. The repository's default port is unaffected.
- **22** type/lint/format/security/source guard commands passed. Dependency audit
  reports zero vulnerabilities; 482 registry signatures verified, with 100
  attestations verified.
- All **six production Worker bundles** passed local Wrangler dry-run. Nothing
  was deployed.
- `guard:sw-cache-version` fails as the already-recorded promotion prerequisite:
  beta runtime changes still share version **8.6.61 / cache v630** with main.
  The competition freeze intentionally leaves that bump for authorized promotion.
  Do not report `build:checked` or release readiness as green.

Separate PRO review used the actual playback controller and local-output-rejoin
module with six additional probes: immediate/delayed resume during a negative
hold, newer canonical pause/play, teardown, and a newer pause overtaking resume.
**6/6 passed**, with no new confirmed PRO defect. Native/large local transport
ownership, stop/pause and canonical-end paths were also re-read; no additional
confirmed defect was found.

## Evidence and limits

Ignored evidence root: `scratch/full-beta-qa-2026-09-27/`.

- `unit-coverage-report.md`, `unit-full.{json,log}`, `coverage-*`:
  full results, original failed gates and successful one-file diagnostic additions.
- `standard-review/REPORT.md`, `results.json`, `root-replay.json`:
  module discovery repeated independently, **3 pass / 5 failed assertions** in
  eight probes, representing one product defect plus the qualified auxiliary and
  timing variants above. This is not five independent defects.
- `standard-review/browser/run.log`, `root-replay.log` and browser reports:
  independently repeated actual Sync-button reproduction.
- `pro-review/REPORT.md`, `results.json`, `latejoin-*`:
  six PRO probes, unchanged-test repeats and three exact-state convergence traces.
- `chromium.*`, `webkit-full.*`, `static-results.json`, `worker-bundles.log`:
  browser and static results; earlier failed-port WebKit attempts are preserved.
- `build-production.log`, `artifact-results.json`, `production-chromium.*`,
  `production-webkit.*`: production-mode local artifact checks and browser smoke.

Windows Chromium uses local room signaling, native Web Audio where the tests
specify it, and deterministic YouTube/media/API fixtures. WebKit here is a
Windows browser build with mobile viewport emulation, not an iPhone device.
Real iPhone/PWA/Bluetooth speaker alignment, real YouTube buffering, production
SFU/Workers and long physical-device sessions are not established by these counts.

Main remains `35759e8b07f1ee0b272afbd0af03c770a858889e`; Operations Drift Audit
was verified `disabled_manually`. This is beta QA evidence, not exact-main-SHA
CI, a production candidate approval, or deployment. The release runbook must
carry FQA01 and the three test-harness repairs into the next change.
