# Final requested beta QA — 2026-10-04

| Field           | Value                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status          | Complete local final QA; no new confirmed product defect                                                                                                                         |
| Tested checkout | `mxqr_beta`, `36deb60d2ee415fed0a06a11a51d61562b7f014e`                                                                                                                          |
| Product code    | Unchanged from `45c7ef7a4e0fef5b788efe11cb72d54c9b221929`                                                                                                                        |
| Main reference  | `35759e8b07f1ee0b272afbd0af03c770a858889e`, unchanged                                                                                                                            |
| Environment     | Windows; pinned Node 24.20.0/npm 12.0.2; Vitest 5/jsdom/local Worker; Playwright 1.63 Chromium and Windows WebKit; local PeerJS                                                  |
| Related records | [Living beta release record](../beta-release-readiness.md), [preceding complete QA](beta-large-qa-2026-10-04.md), [preceding focused QA](beta-sequence-qa-2026-10-04-round-2.md) |

## Decision and executed scope

The owner requested one last QA round and an end to further defect discovery
if this round also confirmed zero new defects. **No new product defect is
confirmed.** The final selected executions pass, and additional discovery ends
here under that instruction. This decision does not end the competition freeze
or mark production promotion ready.

The round combines a fresh complete maintained unit run with new failure/
successor compositions, selected Chromium regressions, the complete configured
WebKit UI lane and rebuilt production-artifact smoke. Product source, maintained
tests, dependencies and test thresholds are unchanged. Raw evidence and replay
tools remain in ignored `scratch/final-qa-2026-10-04/`; paths below are relative
to that directory.

| Lane                                                 | Final result                                                                   | Evidence                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Complete maintained unit                             | 510 files; 10,637 pass / fail·skip·todo 0; exit 0                              | `full-unit.json`, `full-unit-run.json`, log                    |
| New media/transfer compositions                      | 1 file; 12 pass / fail·skip 0; exit 0                                          | `media/final.json`, `REPORT.md`, `evidence-summary.json`       |
| New PRO/client/Worker compositions                   | 2 files; 8 pass / fail 0; 323 copied baseline assertions name-filtered; exit 0 | `pro/final.json`, `REPORT.md`, `results.json`                  |
| New foreground/account/modal/fullscreen compositions | 1 file; 12 pass / fail·skip 0; exit 0                                          | `ui-lifecycle/final.json`, `REPORT.md`, `final-metadata.json`  |
| Root independent module replays                      | Same 32 cases pass; not added again                                            | Each lane's `root-replay.json`, log and `root-replay-run.json` |
| Native seek/FIFO-delay conditions                    | 4 conditions; 4 pass / fail·skip·flaky·retry 0; exit 0                         | `browser/native.json`, `native-summary.json`, artifacts        |
| Maintained Chromium selection                        | 6 files; 43 pass / fail·skip·flaky·retry 0; exit 0                             | `browser/chromium-regression.json`, run/log                    |
| Configured Windows WebKit UI lane                    | 66 pass / fail·flaky·retry 0; existing desktop-only 3 skip; exit 0             | `browser/webkit.json`, run/log                                 |
| Production-artifact browser smoke                    | Chromium 9 + WebKit Service Worker 1 pass; fail·skip·flaky·retry 0; exit 0     | `browser/production.json`, `production-webkit.json`, run/log   |
| Production build and artifact guards                 | Build and all eight original guards pass                                       | `production-build-run.json`, individual logs                   |

`summary.json` reconciles assertion statuses and browser results, including
runner errors and retries. New modules total **12 + 8 + 12 = 32**. PRO's
`-t FQA` filter excludes 11 copied runtime and 312 copied Worker baseline
assertions; they are not passing executions in that probe. Their maintained
originals are covered by the complete unit run. New media and UI probes have
no name filter or `it.skip`.

Additional maintained media 6-file/265-pass and UI 7-file/376-pass selections
are subsets of the complete 10,637-case run, not extra unique coverage.
Chromium's 43 maintained cases cover Luna sequences, critical browser flows,
background resume, reconnection, playback sync and browser XHR. This is not
another complete 568-case Chromium run. Coverage profiles, complete static/
security checks and six Worker dry-run bundles were not repeated; the preceding
large-QA record remains their dated evidence.

## New failure and successor boundaries

**Media/transfer — 12 cases.** Actual file/preload senders emit START/RESUME,
binary CHUNK and END frames through the production Cloudflare transport codec.
Controlled RTC channels deliver them to actual protocol, queue, storage and
decode owners. Public playlist updates remove or empty a partially resumed
queue. Authoritative FILE_START controls select A → B → A with stable queue
IDs, newer transfer sessions and distinct controlled payload bytes of the same
filename/size. Retired tails cannot revive receipt or recovery. A current native
decode rejection arms recovery; queue removal retires that request. Old decode
rejection after replacement or preload promotion cannot evict the new resident,
report the new track failed or release its admission. Positive controls verify
exact successor bytes, resident identity, successful decoding and bounded
resource ledgers. Native codec/init and RTC boundaries are controlled; this
does not claim a particular valid WAV fails on physical hardware or measure
browser heap pressure.

**PRO — eight cases.** Six real client/router cases hold an HTTP 409/500
command response while advancing the same-media revision, selecting new media
or retiring/restoring authority. They then hold the forced canonical heartbeat
response and queue a fresh gesture during that refresh. The newest authorized
gesture uses the fresh revision and succeeds; obsolete unsent gestures cannot
reappear. Two real Worker/public API cases fill the bounded 256-receipt ledger
through accepted commands, then verify rollback of select/PREPARE and playing
stop/COMMIT at capacity, no persisted or published partial transition, exact
replay and conflicting-key rejection. Public heartbeat plus dedicated account
lease renewal keeps the owner live while crossing 599,999 → 600,000 ms receipt
expiry. The previously capacity-rejected key, READY/COMMIT, a distinct successor
selection and final session closure then succeed. Internal Worker state is
read for assertions, not used to seed capacity or mutate authority. Native HTTP
and Worker/provider models are explicit; this is not a live PRO service run.

**Foreground/UI — 12 cases.** Four real account focus/visibility/pageshow
sequences combine a hidden HTTP 503/429 response, coalesced foreground refresh
and an active modal. No hidden retry revives; current anonymous/authenticated
success remains usable without stealing focus. Four actual popup-close monitor
cases recover from API failure, including forced account chooser ordering: an
older identified success cannot publish identity or settle before the fresh
close-boundary session read. Four fullscreen failure/fallback cases retain
current account/common modal ownership, Escape and opener focus, then accept
a fresh native entry/exit. Native popup/fullscreen/HTTP boundaries are modeled.
Terminal timer assertions drain the actual pending range-progress animation
frame, identified by its timer type/callback, before requiring zero timers.

Initial failures are preserved and explained in each lane's report: an invalid
snapshot import in media; HTTP/canonical control expectations, lease-response
schema, stop-vs-select semantics and client-side post-close presence fencing
in PRO; chooser's required fresh close read and pending UI animation-frame
settlement in UI. Earlier UI timer attribution guesses are explicitly corrected
by the fake-clock heap and global RAF observation. No failing product assertion
was filtered out of the final admitted cases. The preceding round's unsupported
projection-only picker diagnostic is preserved there, not silently retested or
declared repaired here.

One exact-final UI root replay also exited before collecting any test:
zero suites/tests, `success:false`, exit 1 after 68.4 seconds. Its JSON-only
log gives no precise cause; a Worker startup/IPC timeout is only an inference
from the runner's 60-second start limit. The unchanged fixture/config replay
with verbose plus JSON reporters then passes all 12 cases in about 21 seconds.
`ui-lifecycle/root-collection-initial.json`, log and run metadata preserve the
unsuccessful attempt; it is not counted as a test pass or an assertion failure.
Root helper preparation/extraction mistakes are separately recorded in
`root-helper-errors.json`; neither executed a failing product assertion.

## Native timing observation and recovery

Four conditions reuse the seek → next → leave/rejoin composition with a mobile-
view guest. Transparent AudioBufferSource start/stop wrappers call the native
methods, and nominal 20-ms sampling begins **before calling the seek helper**.
Host and guest samples are paired within 40 ms and position-normalized to the
same wall-clock instant; actual maximum paired skew is 3 ms. The host either
sends normally or holds the first PLAY and every following connection message
in FIFO order, then flushes unchanged payloads through the original sender.

| Requested FIFO delay | Actual hold | First fresh guest output from helper checkpoint | Peak difference with the new guest source | Maximum difference in final 1 second |
| -------------------- | ----------- | ----------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| 0 ms                 | 0 ms        | 238 ms                                          | 10.867 ms                                 | 2.667 ms                             |
| 1,800 ms             | 1,812 ms    | 1,862 ms                                        | 10.933 ms                                 | 2.500 ms                             |
| 2,200 ms             | 2,205 ms    | 2,258 ms                                        | 17.800 ms                                 | 6.833 ms                             |
| 3,200 ms             | 3,204 ms    | 3,437 ms                                        | 3.210267 seconds                          | 3.167 ms                             |

All four require at least 20 usable final-second pairs and every such pair
within 100 ms; each supplies 50 pairs. The deliberately undelivered seek leaves
the guest playing its previous position while the host jumps about 33 seconds.
That expected pre-delivery gap is retained in raw evidence and separated from
the new-source timing figures above.

In the 3.2-second-delay condition, the guest observes PLAY at helper-checkpoint
elapsed 3,239 ms. The real sync diagnostics record a **hard correction** at
4,229 ms: expected position 39.001 s versus local 35.7934 s. Native difference
is last above 100 ms at 4,216 ms and stays below it from 4,237 ms; an initial
correction follows at 5,231 ms. This directly observes recovery in the controlled
delay condition. It does not establish the historical cause of the previous
round's nominal 2.3-second transient or expose the exact selected clock offset
at PLAY receipt.

These checkpoints precede the helper's UI readiness checks and are not exact
user-input timestamps. Measurements cover native PCM scheduling/progress,
not speaker latency, physical iOS/Android/Bluetooth or real WAN jitter. The
earlier transient and physical first-output/latency checks remain promotion
items. Independent reconstruction is in `media/native-independent-summary.json`
and `media/native-independent-review.mjs`; root extraction is in
`browser/native-summary.json` and `analyze-native.mjs` at the raw evidence root.

## Reproduction and release boundary

Prepend `scratch/beta-upgrade-2026-09-09/node-v24.20.0-win-x64` to PATH.
Set `MXQR_TEST_JQ_PATH` to
`scratch/full-beta-repair-2026-09-27/tools/jq-windows-amd64.exe` for the complete
unit run. Browser commands also use the sibling pinned Playwright browser
directory and recorded fresh app/PeerJS ports; no remote service is required.
Use fresh output paths when replaying to preserve the original dated evidence.

```text
node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=json --outputFile=scratch/final-qa-2026-10-04/full-unit.json
node node_modules/vitest/vitest.mjs run --config scratch/final-qa-2026-10-04/media/vitest.config.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config scratch/final-qa-2026-10-04/pro/vitest.config.ts --maxWorkers=1 -t FQA
node node_modules/vitest/vitest.mjs run --config scratch/final-qa-2026-10-04/ui-lifecycle/vitest.config.mts --maxWorkers=1
npm run build:e2e
node scratch/final-qa-2026-10-04/prepare-native.mjs
node node_modules/@playwright/test/cli.js test --config=scratch/final-qa-2026-10-04/browser/native.config.ts --workers=1 --retries=0
npm run build
node scratch/final-qa-2026-10-04/summarize.mjs
```

Production `dist` is restored, with index SHA256
`C4F924259F0E5B6144289EAE5E7B225B83F6AD94345AC01266F24A952B0647A3`,
equal to the preceding production build. All eight artifact guards and the
9+1 browser smoke pass on that artifact. `environment.json` and
`final-verification.json` record 1,129 protected tracked-file hashes; their
comparison and the baseline runtime/test diff are empty. `port-cleanup.json`
confirms no listeners on owned app/PeerJS ports 4500–4504 and 9300–9304.

Only this report, the documentation index and living release record are
tracked changes. Version/cache `8.6.61`/`v630`, contracts, schema/secrets/
bindings, recovery procedure and cumulative `target=all` /
`apply_developer_api_d1=false` remain. Existing nine-package dependency
security findings, cache-history promotion gate, physical/live checks and
exact-main-SHA CI candidate remain unresolved; this round did not reaudit those
gates. Main and production are unchanged; Operations Drift Audit remains
`disabled_manually`. No PR, deployment, live provider mutation or follow-up
automation was created.
