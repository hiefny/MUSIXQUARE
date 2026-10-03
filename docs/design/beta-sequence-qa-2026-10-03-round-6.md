# Beta sequence QA, round 6 — 2026-10-03

| Field             | Value                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Status            | Discovery evidence retained; SQ14–SQ15 repaired in the [repair addendum](#repair-addendum--2026-10-03)                          |
| Tested checkout   | `mxqr_beta`, `1341bafba76413f26c1500a6b48e508ffa3395c5`                                                                         |
| Product/test code | `f617c80325771ef7519878c385fd24f55f90bdb3` — includes SQ10–SQ13 repairs                                                         |
| Main reference    | `35759e8b07f1ee0b272afbd0af03c770a858889e`                                                                                      |
| Environment       | Windows, pinned Node 24.20.0, Vitest 5/jsdom, local Chromium and PeerJS; controlled HTTP, decoder and iframe boundaries         |
| Related records   | [Living release record](../beta-release-readiness.md), [previous discovery and repairs](beta-sequence-qa-2026-10-03-round-5.md) |

## Discovery result

**Two new defects were confirmed in PRO repeat/shuffle persistence.** They
share the required settings-read boundary but have independent causes:
discarding a valid first gesture and failing to schedule a retry after a read
error. Repeat and shuffle reproductions are variants, not additional defects.

| ID   | Priority | Confirmed effect                                                                                               | Trigger                                                                                        |
| ---- | -------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| SQ14 | P2       | The first repeat/shuffle gesture is replaced with the server's old value and a PUT sends that old value        | Initial queue-mode reads fail; the required read before the first write succeeds               |
| SQ15 | P2       | Repeat/shuffle remains changed locally but is never saved, even after connectivity and canonical reads recover | Playlist append requires a fresh queue-mode read; that read fails transiently before the write |

The primary agent independently replayed both findings and the healthy
controls. The adjacent volume/effects path passed its analogous initial-read
and transient-read probes. File reception, queue mutation, YouTube/shared-audio
handover, demo reentry and UI permission/search probes produced no new
confirmed cause within the tested scope. Earlier SQ01–SQ13 remain repaired
within their recorded scope.

At discovery, product code and tracked tests were unchanged.
Only repository evidence and release records are committed to beta. Main,
production, version/cache, dependencies, schemas, bindings, secrets and the
disabled Operations Drift Audit workflow are unchanged. No introduction commit
was bisected and no production incidence or physical-device prevalence was
measured.

## SQ14 — the first gesture is lost during initial hydration

1. A controller joins a PRO room with repeat off and shuffle off. The room
   session succeeds, but its initial queue-mode GET requests return a temporary
   error. The client therefore has no accepted queue-mode baseline yet.
2. Network access recovers. The controller clicks repeat or shuffle. The real
   playlist toggle immediately changes local state to repeat-all/shuffle-on and
   records the field's pending intent.
3. The debounced persistence task must GET the current queue mode before PUT.
   That read succeeds and returns the still-off server value.
4. Refresh treats the existing pending gesture as replaceable because
   `previousAccepted` is null and the gesture predates this GET. It changes the
   UI back to off. The subsequent PUT is constructed from this overwritten
   local state and sends off as well.

Healthy initial hydration preserves the first gesture; a second gesture after
the loss also succeeds. Revocation/regrant and a new gesture made _during_ the
GET were tested separately. The finding is not permission bypass or a failed
write being mistaken for an accepted write: the client sends the wrong value
through a valid write path.

Source at the audited code:

- [PRO runtime](../../src/pro-room/runtime.ts), lines 2242–2254: fetch the missing
  baseline before constructing the PUT.
- Same file, lines 2357–2387: `preserveField` cannot preserve a gesture from
  before this GET when the previous accepted baseline is null.
- Same file, lines 2263–2281: capture the now-overwritten local state for PUT.

Repair must retain the current authorized field intent during initial
hydration while preserving canonical values for untouched fields. A canceled
gesture or an intent from an old room/permission generation must stay retired.

## SQ15 — a failed required read leaves unsaved local state

1. Start with a successfully accepted queue-mode baseline, repeat/shuffle off.
2. Another participant appends a track. The new playlist revision invalidates
   the old queue-mode baseline. Refresh requests fail temporarily.
3. The controller changes repeat or shuffle. Its debounced persistence tries
   the required GET for the new playlist and receives another temporary error.
   No PUT is issued.
4. The connection recovers. Subsequent heartbeat-driven GET succeeds, and local
   pending intent is preserved because a previous accepted baseline exists.
   However, no persistence retry was scheduled: the local control stays on,
   while server repeat/shuffle stays off. The probe advances 16 seconds through
   recovery and still observes no saved change.

The pre-PUT GET at [runtime](../../src/pro-room/runtime.ts), lines 2247–2254, is
outside the write-error handler at lines 2266–2316. A thrown read error skips
`retryCurrentIntent`; the debounce callback only logs it. A read that returns
`false` does schedule a retry, so this is specifically the exception path.
Healthy post-append controls save correctly. A failed read with no user gesture
does not publish defaults.

The actual local PRO Worker public endpoints were used to generate before/after
append snapshots and queue-mode bodies, then feed those bodies through the
native client parser and runtime. With shuffle off, append increases
`playlistRevision` while leaving `queueModeRevision` unchanged; this is the
Worker's real contract, not an invalid test tuple. A shuffle-on control verifies
the separate queue-mode revision increment.

Repair must apply the existing bounded retry/error classification to the
required read as well as the write, preserve fresh field intent, and retire it
on terminal authority/session failure. A newer playlist, a newer gesture or a
different room must still supersede the old task.

## Executed evidence

Raw local evidence is under ignored `scratch/qa6-2026-10-03/`. Earlier exploratory
runs and independent replays are not added to final counts.

| Scope                                  | Final result                         | Evidence and boundary                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New PRO probes                         | 5 files, 19 pass / 4 fail / 0 skip   | `pro/root-final.json`: two failed repeat/shuffle cases for each of SQ14 and SQ15; includes 6 passing effects analogues and 2 public Worker contract controls                                     |
| Stronger PRO replay                    | 2 files, 6 pass / 4 fail / 0 skip    | `pro/root-worker-backed.json`: the same ten queue cases using actual public Worker snapshot bodies; duplicate evidence, not ten additional cases                                                 |
| File/transfer/large engine             | 11 files, 343 pass / fail·skip 0     | `file/queue-matrix.json` and `file/controls.json`: 32 new sequences, 46 retained composed pause controls, 265 existing focused controls. Root independently replayed the 78-case composed matrix |
| YouTube/shared-audio and demo probes   | 25 files, 65 pass / fail·skip 0      | `youtube/matrix-isolated-result.json` and independent `youtube/root-final.json`: 41 capture/zero-start/subindex cases and 24 isolated demo ordering/reentry/late-fetch cases                     |
| Existing PRO focused controls          | 7 files, 219 pass / fail·skip 0      | `pro/baseline.json`; playback observation/reconnect, account identity and queue/effects authority boundaries                                                                                     |
| Existing YouTube/capture/demo controls | 9 files, 244 pass / fail·skip 0      | `youtube/focused-existing-result.json`; capture stop, demo recovery/sync, rendezvous, manual-offset capture, native controls, pending cue and zero-start heartbeat ownership                     |
| Existing UI/account focused controls   | 8 files, 403 pass / fail·skip 0      | `ui-focused.json`; dialog ownership, account/session, player controls, file drop and playlist removal                                                                                            |
| New Chromium sequences                 | 1 file, 6 pass / fail·skip·flaky 0   | `browser/initial.json`; real host/guest OP revoke/regrant during pending/selected search, Enter/double-click, and obsolete success/error response after close/reopen                             |
| Existing Chromium controls             | 3 files, 12 pass / fail·skip·flaky 0 | `browser/regression.json`; operator controls, canceled operator upload, and search UI. Both browser runs use worker 1/retry 0                                                                    |
| Local E2E build                        | Pass                                 | `build-e2e.log`; no production release or exact-main candidate                                                                                                                                   |

PRO probes execute real join/toggle/runtime logic and native API response parsing
with controlled transport responses. Local Worker contract probes use public
request handlers with test persistence/auth fixtures. They do not contact live
accounts or rooms. File probes compose real sender frames, protocol, RAM
storage and finalization; RTC delivery and native decoding/output are modeled.
YouTube uses a controlled iframe, not live advertisements, autoplay enforcement
or a hardware audio clock. Chromium exercises actual DOM and local PeerJS with
controlled search/oEmbed/iframe service boundaries.

### Reproduction commands

Prepend the repository's pinned Node directory to `PATH`:
`scratch/beta-upgrade-2026-09-09/node-v24.20.0-win-x64`.
For Chromium also set `PLAYWRIGHT_BROWSERS_PATH` to the absolute
`scratch/beta-upgrade-2026-09-09/playwright-browsers` directory.

```text
node node_modules/vitest/vitest.mjs run --config scratch/qa6-2026-10-03/pro/vitest.config.ts scratch/qa6-2026-10-03/pro/queue-initial-read.test.ts scratch/qa6-2026-10-03/pro/queue-required-read.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config scratch/qa6-2026-10-03/file/vitest.config.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config scratch/qa6-2026-10-03/youtube/vitest.config.ts --maxWorkers=1
node node_modules/@playwright/test/cli.js test --config scratch/qa6-2026-10-03/browser/qa.config.ts --project=chromium --workers=1 --retries=0
```

Scratch probes are local evidence, not tracked regression tests. The numbered
steps and source ownership above are preserved in Git; an authorized repair
should add maintained regression coverage.

## Exclusions and limits

- The first file probe incorrectly attempted direct decoding while route
  classification was still unknown. Production intentionally treats unknown
  routes as remote. Correcting that assumption made the two failing cases pass;
  the initial failures are retained as harness evidence, not product findings.
- Initial YouTube probes misread `explicitPlaybackIntent: false` as a forced
  pause and modeled `stopVideo` with synchronous reentrant callbacks. Those
  assumptions were corrected to the actual intent and asynchronous iframe
  boundary before counting results.
- Demo probes require isolated module lifetimes and account for elapsed media
  position during delayed preparation. Initial harness failures are preserved
  separately from the final isolated matrix.
- PRO setup performs more than one initial read, and transplanted Worker
  snapshots require signaling tickets with the same presence incarnation.
  Initial harnesses violating those assumptions were corrected before the
  final original and Worker-backed replays; their setup failures are not findings.
- No new file or YouTube defect is inferred merely from manually seeded states
  without a reachable command sequence. A legacy preload-wait suspicion and a
  delayed already-loaded-module suspicion lacked that evidence and were excluded.
- This round is not a full unit/E2E/coverage rerun, a dependency-security audit,
  a physical Safari/PWA/Bluetooth test, or a production deployment. Existing
  security, version/cache, exact-main CI and physical-device release gates remain.

At the end of discovery, the newly confirmed unresolved scope was
**SQ14–SQ15, two defects**. The authorized repair below supersedes that status.

## Repair addendum — 2026-10-03

Repair code SHA: `45c7ef7a4e0fef5b788efe11cb72d54c9b221929`. The discovery and pre-repair observations above
remain historical evidence. SQ14 and SQ15 are repaired on `mxqr_beta`; the
recorded regression scope has no remaining confirmed defect.

Executable evidence: [queue persistence runtime](../../src/pro-room/runtime.ts),
[required-read regressions](../../src/pro-room/__tests__/runtime-queue-mode-read-recovery.test.ts),
[conflict recovery regressions](../../src/pro-room/__tests__/runtime-queue-mode-conflict-recovery.test.ts).

### Changes and independent verification

- **SQ14:** The first accepted queue-mode read preserves only the current
  controller's dirty, explicitly edited fields when no prior baseline exists.
  Untouched fields use canonical values. Canceled fields, old sessions and
  observers cannot publish defaults or revive an earlier gesture.
- **SQ15:** The required pre-PUT GET now shares the write's error handling.
  Transient read failures use the existing three retries at 1, 3 and 10 seconds.
  A failed read owns only its starting intent revision; a successful read may
  include a newer gesture in the ensuing PUT. Authority, generation, lease and
  abort checks still cancel stale work. HTTP 401/403 retires the rejected intent.
- **Adjacent conflict recovery:** A rejected CAS must retire its old field
  intent even if the reconciliation GET fails. Otherwise a later gesture can
  republish the rejected value. Independent old-code probes passed 1 and failed
  2 cases with GET 503/403. A stronger case also exposed an intermediate repair
  retaining a known-stale baseline: a newer repeat gesture sent that stale CAS
  and was lost (3 pass / 1 fail). The final code retires only fields owned by
  the rejected PUT and invalidates a baseline whose reconciliation throws, so
  the newer gesture performs a fresh required GET. All four controls pass.

The original Worker-body replay was rerun before editing: 6 pass / 4 fail.
After repair, the four defect assertions passed. One historical observational
control expected the second repeat press to reach 1 because the first press
had been lost. The original evidence is preserved; a repair-only copy expects
the correct 0 → 1 → 2 cycle. That ten-case replay now passes without relaxing
an error assertion. The same cycle has maintained regression coverage.

No UI, server conflict policy, wire format, endpoint, Worker, database,
dependency, secret or binding changed. This repair adds only App runtime logic
and regression tests. It preserves the freeze, version `8.6.61`, cache `v630`,
cumulative `target=all` and `apply_developer_api_d1=false` release inputs.

### Final evidence

Environment: Windows, pinned Node 24.20.0, Vitest 5/jsdom, jq 1.8.2 and
Playwright 1.63 Chromium/PeerJS. Raw local evidence is under ignored
`scratch/qa6-repair-2026-10-03/`.

| Scope                                              | Result                                        | Evidence                                                                                                          |
| -------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Maintained new read/conflict regressions           | 2 files, 31 pass / fail·skip 0                | `targeted-final.json`; 27 read/lifecycle cases and 4 native-parser conflict cases                                 |
| Existing queue authority controls                  | 10 pass / fail·skip 0                         | `authority.json`                                                                                                  |
| Worker-generated response replay                   | 10 pass / fail·skip 0                         | `worker-replay/final.json`; controlled runtime replay of local public Worker bodies                               |
| Full unit suite                                    | 510 files, 10,637 pass / fail·skip·todo 0     | `unit-full.json`; new tests included, targeted repeats are not added to this count                                |
| Chromium queue/operator controls                   | 3 files, 11 pass / fail·skip·flaky 0, retry 0 | `chromium.json`; actual Standard-room DOM and local PeerJS                                                        |
| App/test types, changed-source lint and formatting | Pass                                          | `typecheck-app-final.log`, `typecheck-tests-final.log`, `lint-final.log`; selected Prettier check                 |
| Source complexity and room authority boundaries    | Pass                                          | `guard-source-complexity.log`, `guard-room-authority-boundaries.log`                                              |
| E2E and production local builds                    | Pass                                          | `build-e2e.log`, `build-production.log`                                                                           |
| Production artifact guards                         | 8 pass                                        | `guard-*.log`: legacy TV, service worker, UI kit, transfer budget, production hooks/security, fonts and App shell |

The read matrix includes healthy controls, initial hydration, post-append
recovery, an untouched canonical field, retry exhaustion and a new retry
budget, held 200/401/403/503 reads with newer gestures, revoke/regrant, and
leave/rejoin. The conflict fixture uses the native response parser, a pending
409 response body, and actual base-revision comparison in its controlled
transport. It does not stub the outcome of the persistence operation.

```text
node node_modules/vitest/vitest.mjs run src/pro-room/__tests__/runtime-queue-mode-read-recovery.test.ts src/pro-room/__tests__/runtime-queue-mode-conflict-recovery.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=json --outputFile=scratch/qa6-repair-2026-10-03/unit-full.json
npm run build:e2e
node node_modules/@playwright/test/cli.js test e2e/playlist.test.ts e2e/operator.test.ts e2e/operator-upload-cancellation.test.ts --project=chromium --workers=1 --retries=0 --reporter=json
npm run build
```

Use the pinned Node/browser paths listed above and set `MXQR_TEST_JQ_PATH` to
the local `scratch/full-beta-repair-2026-09-27/tools/jq-windows-amd64.exe`.
The browser run used App port 4214 and PeerJS port 9044; the production build
was made only after the E2E run finished.

### Limits and release actions

The Chromium checks are adjacent Standard-room regressions, not a PRO browser
reproduction. PRO proof uses real runtime and native API parsing with
controlled transport/Worker bodies. No live room, account, hardware audio or
physical device was used. Full E2E, WebKit, coverage and dependency-security
audits were not rerun. Previously recorded security and cache-history gates
remain; local build success is not `build:checked` or an exact-main release
candidate. No main advance, PR, production deployment or Operations Drift Audit
reactivation occurred. Follow the living release record after the owner ends
the freeze.
