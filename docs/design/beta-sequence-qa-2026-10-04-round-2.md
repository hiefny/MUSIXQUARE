# Beta follow-up sequence QA — 2026-10-04

| Field           | Value                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| Status          | Complete focused local QA; no new confirmed product defect                                                    |
| Tested checkout | `mxqr_beta`, `1dc2d9115d0f81202f22dd84b7d817b27bf23c51`, source and maintained tests unchanged                |
| Product code    | `45c7ef7a4e0fef5b788efe11cb72d54c9b221929`                                                                    |
| Main reference  | `35759e8b07f1ee0b272afbd0af03c770a858889e`, unchanged                                                         |
| Environment     | Windows; pinned Node 24.20.0/npm 12.0.2; Vitest 5/jsdom; Playwright 1.63 Chromium; local PeerJS               |
| Related records | [Living beta release record](../beta-release-readiness.md), [preceding large QA](beta-large-qa-2026-10-04.md) |

## Result and scope

This round follows the complete local QA with new combinations at boundaries
that earlier tests often exercised separately. **63 new admitted module cases,
18 new browser plans and 1,014 unique selected maintained cases passed.** Root
independently replayed all 63 admitted module cases. An additional ordered
2.3-second control-channel delay scenario passed three repetitions. Repeated
cases and copied baseline cases are not counted again.

**No new product defect is confirmed.** One state-projection-only capture
diagnostic remains failed and explicitly excluded from admitted user paths;
real teardown controls explain that exclusion. Native browser observations
also reproduced a short post-seek position divergence of about 2.3 seconds,
followed by automatic alignment. Its duration, recovery and observability
limits remain recorded below rather than being hidden by passing test totals.

This is focused sequence evidence. The complete unit/coverage, Chromium,
WebKit, static/security, Worker bundles and production smoke remain the
separate preceding large-QA record; they were not all rerun in this round.
The previous security/cache promotion gates remain unresolved.

Raw evidence and replay scripts are retained under ignored
`scratch/sequence-qa-2026-10-04-round-2/`. Paths below are relative to that
directory. Only this report, the release record and its documentation index
are changed by this round.

## Executed counts

| Lane                                      | Selected result                                                                     | Evidence                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| New media/storage                         | 1 file; 10 pass / fail·skip 0; exit 0                                               | `media/final.json`, `REPORT.md`, `evidence-summary.json`              |
| New PRO/account/Worker                    | 2 files; 18 pass / fail·selected skip 0; exit 0; 340 copied baseline cases filtered | `pro/final.json`, `REPORT.md`, `results.json`                         |
| New YouTube/capture/demo/UI               | 6 files; 35 admitted pass; one separate projection diagnostic filtered; exit 0      | `youtube/final-admitted-results.json`, `REPORT.md`, `assessment.json` |
| Unfiltered YouTube/capture diagnostic run | 35 pass / 1 diagnostic fail / skip 0; exit 1, retained                              | `youtube/final-unfiltered-results.json`, `final-command-results.json` |
| Existing media selection                  | 6 files; 192 pass / fail·skip 0                                                     | `media/existing-lanes.json`                                           |
| Existing PRO selection                    | 5 full files, 136 pass; 1 Worker file, 10 selected pass, 302 others filtered        | `pro/maintained.json`, `worker-selected.json`                         |
| Existing YouTube/capture/UI selection     | 6 full files; 676 pass / fail·skip 0                                                | `youtube/selected-results.json`                                       |
| New desktop host/mobile-view guest plans  | 18 distinct plans; 18 pass / fail·skip·flaky 0; retry 0; exit 0                     | `browser/mobile.json`, `mobile-run.json`, `native-summary.json`       |
| Unmodified outlier-seed replay            | Same one seed repeated 3 times; 3 pass; no automatic retries                        | `browser/outlier-repeat3.json`                                        |
| Continuous post-seek observation          | Same one seed repeated 3 times; 3 pass; no automatic retries                        | `browser/settling.json`, artifacts                                    |
| Ordered-delay recovery control            | One additional scenario repeated 3 times; 3 pass; no automatic retries              | `browser/delayed-control.json`, artifacts                             |
| Build preparation/restoration             | E2E build, final production rebuild and production-hook guard pass                  | `e2e-build-result.json`, `production-restore-result.json`             |

`summary.json` checks actual file/assertion identities: the 18 maintained files
contain **1,014 distinct executed passing cases**, with zero duplicate keys.
New module totals are 10 + 18 + 35 = 63. Root replays
`media/root-replay.json`, `pro/root-replay.json` and `youtube/root-replay.json`
agree and are not added to those totals. Vitest reports name-filter exclusions
as pending/skipped; the 340, 302 and 1 exclusions above are not executed passes.
No admitted case uses `it.skip`. Browser runner errors and automatic retries
are zero; manual repetitions remain separate.

## New compositions and controls

**Media storage and hybrid retirement.** Actual RAM/admission storage feeds
the real guest decoder owner and production `BoundedAudioTrack`. A valid
3,600-second mono WAV selects hybrid preparation. Old SID 17 is blocked inside
a noninterruptible codec frame while the same queue occurrence and filename
receive SID 18 through either the current or preload route. Seek/pause intent
is pending, then the old frame succeeds or rejects. Eight variants require
correct cancellation, resource retirement, exact successor bytes/residency,
preserved intent and scoped cleanup; two normal hybrid controls also pass.
Teardown asserts zero tracks/readers/admissions. Native duration/codec/output
and transport boundaries are controlled; this is not physical large-file or
iOS memory-pressure evidence.

**Account, PRO upload and authority changes.** Eight client integration
cases combine real logout/re-login parsers, held HTTP responses, lease
renewal and an in-flight XHR upload with a queued successor. Six native API
cases invoke the actual Worker public routes through detach, 120-second lease
expiry or physical takeover, completion/replay/delete and same/different
account recovery. They verify reservation ownership by physical participant,
quota and exact returned asset. Four more combine settings/queue-mode CAS
with a PREPARE cohort and owner takeover, stale incarnation/revision rejection,
canonical fresh writes and remapped READY/COMMIT. Simulated R2/provider
responses are explicit; client cleanup-call observation does not assert that
a deployed server accepted deletion after logout.

**Native picker, iframe and UI lifetime.** Thirty-five cases combine picker
completion/denial order with successor capture, actual playlist changes and
actual `leaveSession`; repeated sync requests and keyboard drafts; three
iframe callback permutations; real rendezvous producer teardown and captured
retired callbacks; pending demo XHR retirement; and active/queued modal
AbortSignal ownership. Current-successor positive controls require fresh
capture, READY, sync, playback and dialog settlement to work. Native picker,
external YouTube, XHR and audio-node boundaries are controlled.

Initial invalid fixtures are preserved in each lane's report, including hybrid
metadata/selection assumptions, strict account/Worker response identities and
callback table/producer assumptions. These harness errors are not product
failures and do not contribute additional passing cases.

## Failed lower-level diagnostic and reachable teardown

The unfiltered diagnostic holds a controlled `getDisplayMedia` promise in
the real capture module, directly
projects standard room A → B → A with new epochs, then rejects the old picker
with `NotAllowedError`. It receives a stale cancellation toast. The rejection
catch checks capture/load epochs but does not compare the captured room
identity; the success counterpart retires the old stream.

This projection omits the actual transition owner. Production
`leaveSession` emits `system-audio:force-stop` and stop-all-media with
`cancelInFlight:true` before resetting network/room state. Four new cases
invoke that function before reclaiming the same or another room, then settle
old picker success/denial. All four suppress obsolete output/toasts. A current
denial still emits the expected toast. The raw diagnostic is retained, with
the exact exclusion `retires picker after standard room A-B-A with new epoch on reject`.
It is a lower-level defensive observation with no demonstrated user path,
rather than a confirmed room-change bug.

Similarly, mocked rendezvous completion after projection-only source changes
initially failed. Six controls use real `stopYouTubeMode`, the real rendezvous
producer and managed timers, then replay captured retired callbacks after a
successor begins. The old callback is inert and the successor remains usable.
Those initial failures are retained in `youtube/initial-diagnostic-results.json`.

## Native browser timing observation

The 18 new plans cross reconnect, late join and leave/rejoin with both action
orders for removal → seek, pause → next and seek → next. They use a desktop
host and 390×844 touch/mobile-view Chromium guests, actual MP3 files, queue/UI
commands and local PeerJS. All 18 plan signatures differ from the 24 maintained
Luna plans. Transparent wrappers call the original native AudioBufferSource
start/stop methods and record source offsets plus AudioContext progress.

There are **108 captured host/guest pairs: 101 playing and 7 paused**. One
playing pair in seed 480016 has native difference **2.365133 seconds**; the other
100 are at most **23.3 ms**. That seed is playback-first: the observation is
after seek and before next/leave/rejoin, not after re-entry. Existing 2.5-second
browser convergence tolerance is retained, so this observation does not make
the 18-case suite fail.

The unchanged seed repeated three times passes with 15 recorded native pairs,
maximum 23.1 ms. Continuous 100-ms nominal sampling after seek also passes
three repetitions. One of those reproduces **2.329567 seconds** initially:
it remains above two seconds through observation elapsed 216 ms, then aligns
by 328 ms and stays within **2.167 ms** for the remaining approximately six
seconds. This is observed automatic recovery of a repeated transient. The
observation window starts after the seek convergence poll, so 328 ms is not
the total time from the user's seek. No sustained divergence is established.

An additional control waits for an actual accepted sync PONG, then delays the
host's first PLAY and all subsequent connection messages in FIFO order for
2.3 seconds, flushing original payloads through the original send method.
All three repeats pass. Their post-poll samples are already aligned, maximum
7.5 ms and final at most 3.167 ms. This shows eventual ordered-delay recovery;
it does not measure the initial peak or directly prove the fallback branch.

Source suggests a possible explanation: `file-play-timing.ts` uses a local
lead when a calibrated anchor is outside its two-second window; sync later
arms initial correction and hard-corrects drift above two seconds. Neither
the original outlier nor the delayed control records the selected clock
offset at actual PLAY receipt, so that remains an inference. A raw PONG's
offset is not the selected best clock offset. Independent extraction and
limits are in `browser/browser-independent-notes.md` and its two summary JSONs.
These results measure native PCM scheduling/progress, not speaker latency or
physical iOS/Android/Bluetooth synchronization. The transient should remain a
target of device/latency QA before promotion.

## Replay and release boundary

Prepend `scratch/beta-upgrade-2026-09-09/node-v24.20.0-win-x64` to PATH.
For browser runs, set `PLAYWRIGHT_BROWSERS_PATH` to its sibling browser
directory, `PLAYWRIGHT_JSON_OUTPUT_NAME` to a fresh absolute output path and
the recorded app/PeerJS ports before execution.

```text
node node_modules/vitest/vitest.mjs run --config scratch/sequence-qa-2026-10-04-round-2/media/vitest.config.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config scratch/sequence-qa-2026-10-04-round-2/pro/vitest.config.ts --maxWorkers=1 -t R2QA
powershell -File scratch/sequence-qa-2026-10-04-round-2/youtube/run-final.ps1
node scratch/sequence-qa-2026-10-04-round-2/prepare-mobile.mjs
node node_modules/@playwright/test/cli.js test --config=scratch/sequence-qa-2026-10-04-round-2/browser/mobile.config.ts --workers=1 --retries=0
node scratch/sequence-qa-2026-10-04-round-2/summarize.mjs
```

Browser ports are 4496/9296, 4497/9297, 4498/9298 and 4499/9299; each saved
`*-run.json` records its command/exit. Shared E2E `dist` stayed unchanged during
browser execution. Production `dist` was restored afterward and the mutable
test-hook guard passed. Own local servers were cleaned up.
`final-verification.json` confirms unchanged package/lock/config/maintained-test
hashes, empty runtime/test diff, no owned test-port listeners and the restored
production index hash equal to the preceding production build.

Product source, maintained tests, dependencies, contracts, schema/secrets/
bindings, version/cache and recovery procedures are unchanged. Cumulative
`target=all` / `apply_developer_api_d1=false`, competition freeze and disabled
Operations Drift Audit remain. No main advancement, deployment or live
provider mutation occurred. The preceding nine-package security findings,
cache-history gate, physical-device/live-service checks and exact-main-SHA
CI candidate remain in the living release record.
