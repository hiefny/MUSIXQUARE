# Preload recovery and current adaptive-window multi-receiver validation

Date: 2026-10-21. Local branch validation and approved release preparation.

## Scope and source

Base: `e028ec658a992579eb4f278ef28bf2228ca6d42c` (App 8.11.35).
Runtime/test fix: `180c489cd6da78edc83c1a52ec265d3b264746e8`.
Final build/native candidate: `70f35919967beb87d0d46a0ec3daf69644b84c41`.
The latter only adds the covering cache epoch `v761` and matching bootstrap
URL; runtime and test sources are identical to `180c489c`. The product version
remains 8.11.35 pending release preparation. This is not an exact-main release
candidate, a production deployment, or evidence that current main CI passed.

The request covers two suspected preload recovery gaps, plus ordinary and
preload transfers to multiple receivers under the current adaptive policy.
It does not change 64 KiB chunks/local threshold, the 128→192→256 KiB policy,
control connection negotiation, timing thresholds, or any server binding,
schema, dependency, secret, or protocol. PRO/R2 is outside this change.

## Two confirmed recovery gaps

1. **Interruption while waiting behind a current-file transfer.** The chunk
   pump's predicate already suspended the exact broadcast lane. Cleanup of
   the foreground-priority wait then treated that suspension as cancellation,
   erased the recovery record, and sent `PRELOAD_ABORT`. On the unmodified
   base, the reproduction observes START followed by ABORT instead of keeping
   the lane eligible to restart.
2. **A second interruption during the resumed unicast.** The original recovery
   record was consumed when the first restart began. The unicast did not
   register another recoverable interruption. If the receiver's 15-second
   no-progress watchdog discarded its partial file, the later suffix and END
   could not complete it without a new START. The reproduction replays actual
   sender frames and their timing through the real guest protocol, watchdog,
   and RAM file store: the base produces no file; the fix produces the exact
   expected SHA-256 and a fresh restart from chunk zero.

The second reproduction models a logically live connection with a recoverable
ICE interruption and a payload silence longer than the watchdog. Payload
silence and ICE-disconnect grace have different starting points. This proves
the conditional code defect, not that every 16-second network outage preserves
a connection or that a real Wi-Fi/mobile transition was reproduced here.

Both broadcast and unicast now share the same exact-connection/source/item/
session suspension check. Priority-wait cleanup preserves a suspension it
already recorded. Recoverable lanes are retained only while they match the
existing current or next resident file (at most two per receiver). Recovery
starts the current file first and uses the existing priority gate for the next
file. Repeated requests deduplicate; source retirement, cancel, replacement,
and connection close prevent revival of obsolete work. No new timer, message,
general queue, or whole-room scheduler was added. Recovery still restarts at
chunk zero; it is not byte-offset resume. Providers that do not report recovery
keep their existing behavior.

An intermediate implementation retained only one paused tuple per receiver.
Independent review and two failing tests showed that current and next lanes
could overwrite each other in either suspension order. The final bounded
two-resident registry fixes this before acceptance; that intermediate failure
is retained in the local evidence, not omitted from the investigation.

## Local regression and build evidence

Windows x64, Node 24.20.0, repository-locked dependencies. No production
environment or deployment credentials were used by the tests.

| Check                                                                     | Source                   | Result                                      |
| ------------------------------------------------------------------------- | ------------------------ | ------------------------------------------- |
| Original two reproductions plus existing ownership cases                  | base runtime + new tests | 25 pass / **2 fail** / 0 skip               |
| Single-slot intermediate regression                                       | intermediate runtime     | 34 pass / **2 fail** / 0 skip               |
| Final recovery/lifecycle file                                             | `180c489c`               | **37 pass** / 0 fail / 0 skip               |
| Targeted storage/transport regression                                     | `180c489c`               | **360 pass**, 12 files / 0 fail / 0 skip    |
| All storage, network, and player unit files                               | `180c489c`               | **3,623 pass**, 143 files / 0 fail / 0 skip |
| App and test TypeScript checks                                            | `180c489c`               | pass                                        |
| Changed-file ESLint/Prettier, chunk-pump, complexity, import graph guards | `180c489c`               | pass                                        |
| Production `build:checked` including all build guards                     | `70f35919`               | pass                                        |

The 37-case file contains 12 new cases, including cancellation/source release/
replacement/close after a second interruption, exact-file promotion, repeated
recovery during pending delivery authorization, providers without recovery
reports, both current/next suspension orders, and stale-resident pruning.
The narrower 37 and 360 counts overlap the 3,623 total; they are not additive.
This was not the repository's entire unit or browser suite.

The first checked build stopped at the cache-history guard because the runtime
commit was newer than v760. A cache-only follow-up first missed the bootstrap
URL, which the final app-shell guard rejected. Matching both values to v761
resolved these two deterministic build failures; all original logs remain.
Neither failure was retried unchanged or attributed to the environment.

Local raw regression evidence is under the ignored
`docs/private/transfer-recovery-qa-2026-10-21/` directory; filenames include
`red-original`, `red-single-slot-draft`, `green-final-lifecycle`,
`targeted-regression`, `related-unit`, and `checks-build3`.

## Native multi-receiver protocol

Four candidate-only cases use an archived e2e-mode build of `70f35919`, local
signaling, actual app create/join/file-input paths and negotiated native RTC
connections. No forced control route, shim, chunk override, or window override
is allowed. Chromium 153.0.8010.12, pinned Node 24.20.0; one case at a time,
without concurrent builds/unit tests. A controlled 600-second YouTube provider
is used only for preload media preservation; this does not test live YouTube
or audible output.

Two guests have 2 Mbps and 8 Mbps links, respectively, each with 100 ms latency
in each direction. Mixed cases leave host bandwidth unlimited. Shared cases
apply one host upload limit of 500,000 B/s (4 Mbps) across its connections.
Shaping is installed before connection creation; HTTP/WS service traffic is
exempt. New contexts are used per case. Each file is 23,040,044 bytes in 352
logical chunks: ordinary SHA-256
`7289abad3c0bccc02eba2f92d67e5b29d1a6a9ec6c49fe3647d3d33c31cc6f61`, preload
`5749688e4e6306234de4add49e9191c5e8974e4d60de48671c4bd57dca4db83d`.

The frozen protocol uses 10 s warmup, 2 s settle, 24 s no-file baseline, a
240 s transfer deadline, 30 s tail and 15 s final arrival drain. It requires
exact received hashes, complete cumulative receipts, matching native and app
routes, no observation loss, and per-peer raw control maxima ≤1,000 ms during
both its own transfer and the whole room's transfer. Ordinary playback
preservation is N/A because it deliberately starts the newly supplied file.
Preload requires no unintended player operations, no nonplaying samples or
coverage gaps >1 s, and ≤10 ms change from each guest's no-file baseline.

Mixed-case fast guests must actually send with accepted 256 KiB credit and
resulting debt >192 KiB; merely seeing the configured maximum is insufficient.
Shared contention must last at least 10 s while both guests remain unfinished,
with unique selected-pair aggregate host TX 350,000–600,000 B/s and independent
delivered payload RX 325,000–550,000 B/s, both guests progressing. These bounds
test that the host cap is shared, rather than accidentally copied per peer.
The shared cases need not grow beyond 128 KiB. Missing exposure is reported as
UNEXERCISED, not silently passed. Raw evidence is saved before analysis.

The first native attempt failed before room admission or file transfer with
`SERVICE_MAINTENANCE_STATUS_UNAVAILABLE`. The isolated local ServiceControl
SQLite path was 259 characters (263 for WAL/SHM); exact DO HEAD/GET calls
failed internally. Changing only the local persistence path to a shorter
fresh path made both calls and normal signaling succeed. The original wrapper
was restored byte-for-byte; there was no maintenance bypass or product edit.
This local persistence setup failure, its raw result, and diagnostics remain
preserved. Qualification restarts under fresh `-infra2` IDs with the same
source, profiles, order, durations, and gates.

## Native results and independent audit

All four qualification cases PASS, with no qualification failure, skipped
case, or required exposure left unexercised. The earlier admission failure
above is separate infrastructure evidence, not a passing fifth case.
The independent audit reconciles all eight real received file hashes,
352 ordered chunks per file, exact item/session identities, cumulative
sent = received = reported = acknowledged bytes, READY, and final preload ACKs.
Native and application routes agree without unmatched/extra frames or private
control frames reaching application handlers. Observation queues have no
skipped/dropped resource reads. All own-transfer and whole-room raw control
maxima pass; sparse per-message no-file baseline comparisons remain N/A.

Times below run from the UI file demand to payload completion, in seconds.
Each row uses a new room with two receivers and the same-size file. Control
columns are the whole-room transfer maxima, not averages or baseline-adjusted
values. Own-transfer maxima happened to match them in these four runs.

| Host uplink / workload   | 2 Mbps receiver | 8 Mbps receiver | Control max, slow / fast | Result |
| ------------------------ | --------------: | --------------: | -----------------------: | ------ |
| Unlimited / ordinary     |       103.440 s |        47.131 s |         341.9 / 234.5 ms | PASS   |
| Unlimited / preload      |        99.586 s |        47.986 s |         336.9 / 177.7 ms | PASS   |
| Shared 4 Mbps / ordinary |       113.180 s |        87.638 s |         400.4 / 415.7 ms | PASS   |
| Shared 4 Mbps / preload  |       110.040 s |        98.604 s |         397.4 / 375.3 ms | PASS   |

The two unlimited-host fast receivers genuinely used accepted 256 KiB credit:
221 ordinary and 213 preload sends had debt above 192 KiB in that state.
All slow receivers stayed at 128 KiB. Shared ordinary's fast receiver probed
256 KiB (eight probe sends above 192 KiB debt), then used 192 KiB in the
`measure` phase and later returned to 128 KiB; it did not use accepted 256 KiB
above 192 KiB debt. Shared
preload's fast receiver only probed 192 KiB and returned to 128 KiB. Thus the
shared runs must not be described as either fixed-256 tests or as both lanes
always staying at 128 KiB. Expansion was not a required gate on the shared
bottleneck, and the adaptive policy was unchanged.

Independent selected-pair accounting sums the four host PCs once each and
checks separately delivered payload at both guests. Rates below cover only
valid simultaneous unfinished-transfer intervals, weighted by duration.

| Shared workload | Valid interval | Host native TX sum | Independently received payload sum |
| --------------- | -------------: | -----------------: | ---------------------------------: |
| Ordinary        |       84.400 s |        496,295 B/s |                        472,108 B/s |
| Preload         |       94.517 s |        476,562 B/s |                        452,775 B/s |

Both pass the predeclared shared-exposure bounds. Native TX is approximately
3.97/3.81 Mbps against the one 4 Mbps host limit, rather than separate 4 Mbps
limits per receiver. The independent reader uses first-SEND overlap; the
qualifier uses first-RECEIVE overlap and obtains ordinary 82.392 s,
498.2/475.7 kB/s and preload 92.507 s, 484.5/461.2 kB/s. The slightly different
intervals are retained, not mixed or treated as conflicting runs. Two initial
selected-pair intervals in ordinary and one in preload lack a usable pair and
are explicitly excluded from rate calculation, while retained in raw data.

Controlled-player preload preservation passes both runs. Unlimited-host guest
baseline medians were 1.900/2.500 ms and maximum changes from those medians
were 0.950/1.050 ms (521 protected samples per guest). Shared-host baselines
were −8.100/−0.600 ms, with maximum changes 0.900/1.100 ms (562/563 samples).
Neither run has an unexpected playback/seek operation, nonplaying sample,
invalid protected sample, coverage gap above 1 s, or drain-time mutation.
These are changes in independently observed controlled-player position, not
proof of zero absolute offset, actual speaker synchronization, or live
YouTube buffering behavior. Ordinary playback precision remains N/A.
Export-only rows after the common observation boundary are retained separately
and are not reclassified as protected playback samples.

The only native first-attempt failure was the diagnosed local admission
setup failure; no performance gate was widened, and no successful case was
selected from repeated attempts. These four single runs validate the stated
conditions, not a speed improvement against an older build. The slow and fast
receivers finishing at different times also does not by itself establish
fairness across every possible bandwidth distribution or room size.

### Evidence identifiers

Local native evidence is retained under ignored
`scratch/db256-multi-2026-10-21/`. Raw result IDs are
`db256-current-<case>-candidate-r3-infra2`; corresponding independent audits
are `audit/<case>-r3-infra2.audit.json`. The independent compact summary and
window-attribution files preserve the decisions separately from raw data.

| Case            | Raw SHA-256                                                        | Independent audit SHA-256                                          |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| mixed-ordinary  | `ff4affba073785451b315449c2bf71d466d31a59f73680702e2d2b01d60f073d` | `06dc72384ebc813652631c25a8c67ae5040280c80c5252cf84ee850239755d36` |
| mixed-preload   | `241df7a681bc2773622ff06a737c47713f96730d683ea3b8449f5911fff629db` | `4c10845aebd18a8b08068aece0cf204abca824b705e97899b9dfc6319ac7c05b` |
| shared-ordinary | `3c02f442d15847d58fcc967aecc8e379d7c31b7a3e707edbb7938df3fb96d9f8` | `1868d964cbd52ccfcfaa86d45195554cbbbf0fcf87f44c31072bd14680d5c3b6` |
| shared-preload  | `57d63820e97117eb8549d5fee2cc5f36dfe457e535dcae9bfcf2fc9ccd1f8d72` | `87925fd8fd6317f6a28a740a94e35964ed3ffc13daeb962f1575096dad91b88b` |

Common build-manifest SHA-256:
`18c356e94d9c30bd29a54d12ece70a01b7c71b813f3347996d23436e690368f4`.
Source-manifest SHA-256:
`341ec114326f30c9980850e623f3943102adfa586e8f132ed99caa8302c3ec65`.
The served HTML, main JS/CSS, and peer asset hashes match the archived build.
Each config freezes its harness/readers, procedure and source manifests before
execution. Test servers on localhost 4506/8886 and the worker inspector were
stopped after checking their owned process identities; raw files and archives
remain available.
The final local evidence handoff is `final-handoff.json`, SHA-256
`a1ca937406e08badda89a5c873574e64962f47490bd4765b99d205e59949bb14`.

## Remaining limits

Local unit models do not prove radio migration behavior. Four native runs with
two guests are not a large-room soak or a repeatability/speed-improvement A/B.
Physical Android/iOS, Wi-Fi/mobile changes, TURN, live providers, acoustics,
mixed deployed versions, and production operational smokes remain outside
this round. Existing release-record field limitations stay open.
The owner lifted the deployment hold after reviewing these results. Release
preparation incorporates main `89dd02a7` and advances the product to 8.11.37,
cache/bootstrap to v762. That main change only fixes playlist-selection morph
geometry after a rebuild; transfer runtime is unchanged from the native source
above. The four native results retain their original source identity and do
not substitute for the final exact-main CI candidate or operational smokes.
