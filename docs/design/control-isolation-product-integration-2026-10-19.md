# Standard control isolation: product integration

Status: the owner resumed qualification on 2026-10-19 and explicitly withheld
deployment. The earlier safe pause and its standalone preload arm are preserved
below. Remaining tests and a read-only review of the separate delay-based credit
branch are authorized; this work does not authorize a production release.
This is not evidence of a production release. The owner's earlier conditional
release approval is superseded by the current deployment hold. The starting main is
`deb52829930d0b8a4b87e70b05f84aa7c242c799`; production remains `416f5ee4`,
App 8.11.20/cache v723 until an actual release is recorded. The proposed product
is 8.11.22/cache v731. No dependencies, Worker protocol, schema, secret, binding,
CSP, admission policy or media format are changed. App release scope includes
the previously merged, undeployed YouTube clock-quality lease protections.

## Resumption and separate candidate review

On resumption, server ownership, six served asset hashes and the original
34 frozen inputs matched. The interrupted candidate preload arm remains
standalone. A fresh consecutive C9→baseline pair uses new `resume-r2` IDs,
unchanged fixtures/runner/gates, and freeze SHA256
`c405c187d32f53a13369b4ff68101aa9e63ec49df403e9a943ff73a0ae6b7db1`.
Deployment remains withheld even if qualification succeeds.

The owner also requested a read-only review of remote
`agent/delay-based-credit-window`, captured at `a85831d4` (runtime `4b83ba14`,
based on C9). That branch replaces A192 with five-sample median receipt-delay
decisions and a 256 KiB ceiling. It is a worthwhile independent experiment,
especially a 192 KiB-capped variant that separates faster adaptation from a
larger maximum. It is not part of the current tested runtime. Its deterministic
FIFO model omits SCTP/browser effects and does not establish native performance.
Review identified a safety boundary to test: after expansion, ineligible or
coalesced receipts release credit without supplying observations, and the old
phase watchdog is absent. This can retain the larger window without renewed
evidence. Current full-chunk receivers normally emit one receipt per chunk;
network batching does not itself merge those application frames, so this is
not an observed continuous-file failure. Expanded-window sparse/coalesced ACK,
idle-to-burst and bandwidth-drop-at-probe cases merit pins and native checks.
The branch's estimated chunk delay is not a worst-case bound, and its physical
impossibility claims must stay scoped to the stated FIFO/feedback model.
No source edits or tests were made on that separate branch during this review.

### Resumed qualification result

The planned remaining local qualification is complete on runtime
`6a5afaaefe2c301b3b37a4f5c43ebe2ef36a01f2` (C9). No product source changed during
resumption. Windows/Chromium exercised the actual product RTC negotiation and
file paths, with a controlled YouTube provider. The unchanged gates pass:

| Comparison | Baseline → C9 completion | Maximum control delay, baseline → C9 |
| --- | --- | --- |
| High-RTT ordinary (before pause) | 73.565 → 52.326 s | 1,679.1 → 217.4 ms |
| High-RTT preload (fresh resumed pair) | 72.041 → 51.454 s | 1,226.2 → 179.2 ms |
| Slow 2 Mbps preload | 102.444 → 103.770 s | 1,245.3 → 348.2 ms |
| Dynamic 8→2→8 Mbps preload | 156.439 → 126.724 s | 1,216.6 → 565.5 ms |
| Shared host upload preload, slow receiver | 108.225 → 109.266 s | 2,184.0 → 375.2 ms |
| Shared host upload preload, high-RTT receiver | 97.740 → 99.208 s | 1,347.2 → 305.8 ms |

All six mixed-version/lifecycle cases (ten files) and actual user-operated
Reconnect → Start (three completed files) independently pass the functional
contract. The shared-host pair retains 128 KiB on both candidate connections;
it demonstrates preserved throughput and lower control delay, not an adaptive
window expansion. Original harness/reader failures, sparse statistical groups,
the old-host setup-baseline overlap and invalid export-only rows remain recorded
below. These results do not claim real-device acoustic synchronization, live
YouTube behavior, unattended recovery or universal network performance.

Deployment remains explicitly withheld. Main, production and the other
experimental branch were not changed. Branch CI and local qualification are
not an exact-main release candidate.

## Chosen transport

The [study](control-association-isolation-2026-10-19.md) measured a separate real
RTC association for application controls and cumulative receipts, with the
original ordered association for bulk data. Keep 64 KiB logical chunks and the
64 KiB local send threshold. The existing A192 policy may expand the sender's
receipt window from 128 to 192 KiB only after the actual control handoff succeeds.
Disabling it preserves cumulative sent/acknowledged bytes, outstanding debt and
cooldown. No debt refund, EMA rewrite or fixed-256 policy is introduced.

This is Standard-only. PRO and remote HTTP/R2 transfer do not acquire an extra
PC merely by joining. A Standard logical connection advertises support only
after the existing APPLIED admission boundary; the first direct-file capacity
request starts negotiation (including the permitted operator-upload bulk pump).
Operator-upload chunks retain their existing accounting; this change does not
claim newly added receipt credit for that chunk type. The legacy 1-second discovery grace and old
non-credit bypass remain compatible. A peer without the new capability keeps
its original control route and existing credit behavior.

## Ownership and handoff

`CloudflareDataConnection` retains its original PC, bulk channel, control channel,
media ownership and ICE-restart namespace. It owns one optional
`ControlIsolation` lifetime. SDP/candidates travel privately over the original
authenticated ordered channel, bound to both endpoints' fresh 128-bit nonces.
This does not reuse the signaling Worker's per-peer negotiation map. The smaller
nonce offers. Reserved frames from the bulk lane cannot negotiate a side route.
Both sides must support it; partial-reliability/unordered/wrong-label channels
are rejected. Async results recheck the exact PC/connection before applying.

Each endpoint starts queueing controls immediately before sending its ordered old-route fence. It
sends a side-route READY only after seeing both fences. Activation requires both
READY messages. Outgoing queued controls drain before capacity listeners are
woken; early side receives wait until the handoff completes. Old-route controls
after the remote fence fail the logical connection. Original control decoding
is serialized, so an asynchronous decode cannot overtake its fence. Receipts
use the same router as playback/sync, never a separate accidental old path.

Ordinary FILE_START/FILE_RESUME, PRELOAD_START and operator-upload START now use
the same ordered bulk lane as their chunks and terminal END/FINISH. Existing
receivers already accept them on either lane. This closes the new
cross-association header/chunk race without changing their payloads or the
FILE_PREPARE, PLAY_PRELOADED, abort, READY and final ACK contracts.

## Failure, reconnect, and bounds

- At most eight actual side PCs per signaling owner, not eight per timer or
  pending attempt. This independent resource cap also covers peers retained
  after later transfers choose R2. A full cap or unavailable fresh RTC config
  explicitly declines before handoff; released ownership returns capacity.
- One 10-second negotiation attempt per exact logical connection. Before either
  fence, setup failure sends an ordered decline and keeps the old route. Late
  callbacks cannot restart it. Crossing a decline with the other endpoint's
  fence closes the exact logical connection rather than mixing routes.
- After either fence, ambiguity/timeout/channel failure closes the exact logical
  connection and uses the existing reconnect owner. No private hot downgrade,
  independent side ICE-restart loop or file replay is added. Reconnection owns
  new nonces and counters. A side disconnected state has one 15-second grace.
- Foreground recovery also checks the side PC/channel. An original PC's
  redundant connected event cannot cancel the challenge of a potentially stale
  side route; the existing bounded exact SYNC_PONG proves liveness.
- SDP is at most 32 KiB, candidates at most 128 per direction with bounded
  fields. Handoff queues are at most 128 messages per direction. Their UTF-8
  budget is one largest valid existing text frame plus 2 MiB of other controls;
  the existing 16 Mi UTF-16-unit per-frame envelope gives a hard 50 MiB bound.
  This is not a claim of small worst-case memory: both directions across eight
  connections can theoretically retain 800 MiB of adversarial maximum text.
  Normal handoff controls are much smaller; overflow closes the exact connection.
  Native per-message SCTP limits remain independent and may reject a large
  frame earlier, just as the previous route did.

## Verification contract

Focused tests cover real module state transitions with paired fake PCs, native
send failures, nonce/lane validation, FIFO, early receives, timeout/fence races,
late callbacks and teardown. Adapter tests must cover actual routing and credit
activation. Existing signaling/media/ICE tests must pass unchanged in meaning.
Native browser tests must use the product's own negotiation and PCs: no study
broker, synthetic MessageEvent dispatch, private frame interception, or route
shim. The first transfer includes demand-triggered side-association setup and
queued-control cost, after ordinary room admission and the quiet baseline.

The controlled comparison is same-main B128 versus this product candidate,
ordinary and preload, high RTT and slow/dynamic links, multiple receivers,
cancellation, promotion, mixed versions and reconnect. Existing production
sanity is separate from that same-main comparison. Record exact build hashes,
pass/fail/skip and harness failures; do not relabel old experiment results as
product verification. Physical Android/iOS audio, live YouTube provider behavior
and arbitrary Internet bottlenecks remain limits unless separately measured.

## Evidence and release

Implementation checks run on Windows with pinned Node 24.20.0 / npm 12.0.2.
Runtime candidate `a30c3f2a191786cb743e82849275e9824191a158` passed the
committed production `build:checked`. With the subsequent test-only fixture
updates, the full local unit suite passed **594 files / 13,342 tests / zero
failures or skips** in 153.35 seconds. Independent source review found no P1/P2
blocker; it does not substitute for actual browser negotiation or performance.

The first local run on `abd3d7e5` failed 193 assertions in nine files. Seven
existing fixture files assumed START/RESUME remained on control, or counted a
bulk metadata header as a payload chunk. Their updates retain explicit legacy
cross-channel replay and add current ordered-bulk cases. The other two failures
were the unsafe-cast guard and a stale bootstrap cache query; both were fixed in
`a30c3f2a`. That commit also fixes the technical private channel label's brand
guard annotation, which had failed the initial PR candidate build. Initial
PR CI [39167554202](https://github.com/hiefny/MUSIXQUARE/actions/runs/39167554202)
failed and is not a release candidate. Original failures are preserved under
`scratch/control-isolation-product-2026-10-19/root/`.

The product-native functional R2/R3 prefix independently passed ordinary and
preload transfers: each run received two 4,800,044-byte files with matching
resident SHA, READY and cumulative receipts. Both-direction controls crossed
the real ordered handoff, including queued controls; no private application
leak was observed. Closing the actual side PC with 65,536 bytes outstanding
retired the logical connection. These small functional runs are not throughput
comparisons.

The original full reconnect scenario R3 failed: it admitted
a fresh guest during YouTube playback, but sent no pending preload START or
payload (new connection S=A=0, side idle). `bootstrapLocalPeerFile` returned for
a YouTube current item before reaching the independent ready-preload branch.
That function has the same Git blob in baseline `deb52829` and candidate
`a30c3f2a`; the evidence identifies an existing late-join gap rather than lost
payload on the new association. The minimal fix separates current-file eligibility
from the independent next-file bootstrap, retaining PRO/R2 routing and exact
preload source/connection ownership. Seven new pins cover both admission events,
stale current-file exclusion, unchanged missing-selection guards and actual
PRELOAD_START/two chunks/END output. Five reproduction pins fail before the fix;
after it, both affected test files pass all 37 tests. The committed fix
`043fcb87` (cache v728) passed `build:checked`; native R4 completed all three
files, including the previously missing next-file delivery after fresh room
admission, with matching resident SHA/READY/receipts. R4 took 88.825 seconds
overall; that includes scenario setup and is not a throughput metric. R1's hidden
mobile chat selector and R2's probe access on initial about:blank were separate
harness errors and remain preserved, not reported as product regressions.
Raw runs, hashes, independent route audit and this failure's exact-state triage
are under `scratch/transport-isolation-product-qa-2026-10-19/`.

The earlier PR head `40d91772` passed all eleven jobs in
[CI 39168550135](https://github.com/hiefny/MUSIXQUARE/actions/runs/39168550135).
GitHub Codex completed its review of that head with no findings. Neither result
covers the subsequent late-join fix or constitutes an exact-main release candidate.
That fix's own [CI 39170147052](https://github.com/hiefny/MUSIXQUARE/actions/runs/39170147052)
also passed all eleven jobs; it remains a PR candidate only.

### First product performance qualification: failed

The first frozen same-main high-RTT ordinary-file comparison used baseline
`deb52829` and candidate `043fcb87`, Chromium 153.0.8010.12 on Windows, a
23,040,044-byte fixture, guest 8 Mbps/100 ms each way from before connection
creation, and cold product negotiation. Demand-to-final-native-receive time
was **73.879 versus 66.498 seconds: 9.99% improvement**, below the predeclared
20% requirement. The candidate's first-payload setup cost (2.163 seconds,
versus baseline 0.808 seconds) is included. This round failed; successful CI
and earlier research results do not override it.

Independent inspection passed exact file/chunk/hash/queue/session ownership,
real control handoff, cumulative receipt accounting and actual 192 KiB use.
Maximum measured application-control delay fell from 1,632.8 to 219.4 ms;
applicable absolute and baseline-relative control budgets passed. Sparse or
unavailable groups remain N/A. The two immutable raw SHA256 values are
`8293c0aed8ddaf8045a48793c9e9c2a0b374d34a30418d4f69bcb81c76568da9`
and `396769948967eed28b4916d18d0d50464dceea58077501e364aa2563062e3780`.
The full independent audit is
`scratch/transport-isolation-product-qa-2026-10-19/audit/performance-firstpair-independent-r1.json`
(SHA256 `23787b1e4e6d1c5a8ce0d433283194fe8b47ac1e4b532603e506da58c31ea686`).

The first expansion retired at approximately +18.820 seconds and incurred the
existing 30-second cooldown. Its saved baseline was 337,387.560 B/s with mean
receipt age 389.650 ms. Reconstruction of the next 14 native receipt boundaries
gave 402,974.184 B/s over 2,114.200 ms and age 387.407 ms: a 19.44% gain below
the unchanged 20% acceptance threshold, despite no age violation. Exact final
retired statistics are not retained by the controller; these probe values are
explicitly reconstructed, not claimed as exact controller output. The previous
13-receipt observation was above the rate threshold but not yet two seconds
long. The calculation and epoch separation are correct, and the policy matches
the earlier study. Changed codec/fragmentation does not explain the result:
both arms and the study used 352 frames with identical total payload/header
bytes. Whether the short-block variation arose from startup or ordinary network
variation is unresolved. This is a limitation of the short efficacy observation,
not proof of a browser bug or a translated-controller defect.

All remaining qualification cases were held at this failure. A new experimental
candidate will use a **uniform four-second/minimum-16-receipt initial probe**,
twice the existing baseline observation, instead of making a long cooldown
decision from its first two-second block. This is a prospective design change,
not a reinterpretation of the failed run. It has no special tolerance near
19.44%, no second-block-only selection, and no lowered acceptance threshold.
It keeps the 192 KiB maximum, 250 ms added-delay admission budget, per-receipt
100 ms age guard, ambiguity/idle rejection, eight-second absolute probe
watchdog and 30-second retirement cooldown. Baseline and already-accepted
monitoring retain their two-second/minimum-eight-receipt windows. This may
retain an inefficient but otherwise safe probe for up to two extra seconds;
it does not extend the absolute watchdog or excuse a safety violation. The
extra observation duration is not a physical queue-delay guarantee.

The changed policy must first pass generic boundary/lifecycle pins and a new
exact-source cold product comparison under the original qualification gates.
It is not yet a demonstrated performance fix. Eight new boundary tests produced
six expected failures and two passes against the previous policy (40 unrelated
tests filtered out). With the minimal phase-specific observation change, both
credit test files pass **59 tests, zero failures or skips**. These cover early
fast/slow sample bias, the minimum sample count, persistent 19% gain rejection,
the unchanged absolute deadline, accepted-phase cadence, immediate age rejection
and compressed receipts. Original failure evidence remains immutable. Further
matrix testing and deployment depend on the new evidence.

The committed policy candidate is `0b56607e` (cache v729); its production
`build:checked` passed. Its PR CI `39172208234` found one additional existing
adapter fixture that still expected acceptance after only 30 receipts at
100 ms intervals. The controller correctly remained in `probe`. The fixture
was reproduced locally before correction and now checks the intermediate
probe state, the 3.9-second boundary, then acceptance and exact cumulative debt
after four seconds. This is a test-only follow-up; the native artifact remains
the exact `0b56607e` runtime. The failed CI is retained and is not a candidate
release success. The test-only correction is `5f41abd3`. All 12 transport test
files pass 713 tests; the full local Windows suite then passed **594 files /
13,357 tests / zero failures or skips**. The initial npm CLI launch rejected
forwarded reporter flags before any test ran; that launcher log is preserved
separately from the successful direct pinned-Node Vitest run. Full-run JSON
SHA256 is `cc189685bcdea18cac12689fd008cf51795726d83f5cedf5ef76c9f8f7819877`.

The test-only head's [CI 39172724525](https://github.com/hiefny/MUSIXQUARE/actions/runs/39172724525)
passed all eleven jobs. This is still PR evidence, not an exact-main candidate.

### Uniform-probe candidate product qualification

The new cold H8 ordinary pair used the same baseline, fixture, browser and
acceptance gates, with exact candidate `0b56607e`. Primary completion improved
**73.634 to 52.706 seconds (28.42%)**. Maximum application-control delay was
1,654.2 versus 189.7 ms. Independent exact-byte/chunk/queue/session/lane/source,
receipt accounting, actual enlargement and applicable relative/absolute control
checks passed; twelve sparse/unavailable control groups remained N/A, and
ordinary media was N/A. No cooldown occurred. First observed acceptance was
20.688 seconds after first native payload (22.800 after demand); 276 chunks
were admitted while accepted at 192 KiB. This describes the startup/learning
cost in this run and does not identify every underlying transport delay.

The frozen inputs have SHA256
`05be39475feab7b56825fd435c12382e2f4bba034c77787f237b9f79ce7002e5`;
raw baseline/candidate hashes are
`df83515b7e6d7dd266a5d0653b066ddb62a381e534555358c240aa466c1bf8cd`
and `0c42ad51ebefa6a23b429fef2270247bec91a477433d04f7bf7b077b7948c1aa`.
Independent audit `performance-c4-firstpair-independent-r1.json` has SHA256
`5818e01eee2e90429beb6bb90fe4dcc4e7695589cfd18f0385115b5842b7e822`.
All paths remain under the product-QA scratch directory identified above.

Remaining six performance cases are separately frozen as
`execution-freeze-product-c4-remaining-six-r1.json`, SHA256
`4407e6c3c0d0d62547fc03c47179af471f468a3d7948aebd90e214166b41b3c3`:
candidate then baseline H8 preload, baseline then candidate slow2 preload,
candidate then baseline dynamic 8→2→8 preload. Each pair requires independent
qualification before continuing. The first preload pair was interrupted:
candidate collection completed in 52.675 seconds with matching resident SHA,
352 chunks and cumulative receipts, but the baseline stopped during setup before
the first warmup marker. The final media analyzer assumed a nonempty baseline
list and threw before raw evidence was written. Its secondary reporting defect
is confirmed; the original setup error was lost and remains unknown. The log
is preserved with SHA256
`88d66d581e0f5016f83526d3e7753e8bcf6f9c7200d4569ba2d3b80e7f588e1b`.
Candidate raw SHA256 is
`a2261af58da1573c5d524e240b60c52fb296c6ae862c8a5c82862ea841051d64`.
Its standalone independent audit passed source/file/route/credit checks:
52.675 seconds, maximum application-control delay 201.8 ms, and 274 admissions
with accepted 192 KiB credit and debt above 128 KiB. During the common baseline,
demand/bulk, tail and drain windows the controlled player's sampled residual
changed by at most 1 ms from its own baseline, with no unexpected mutations or
nonplaying samples. Two later guest export samples lack a sufficiently close
host reference after host observation stopped; they remain invalid in the
complete raw rows and are not presented as valid media evidence. Standalone
audit SHA256 is
`8b4afa73e102ac5ad5ffca011da411ff306b4034d02613203363490e91c0e049`;
its paired qualification field is deliberately null.
There is no paired preload qualification and no assertion that the lost error
was merely a harness setup problem. Original frozen inputs and failed evidence
remain unchanged.

### Readiness failure investigation

A separate reporting-only runner saves the original error immediately and writes
immutable endpoint evidence before calling an analyzer. Analyzer failures have a
separate artifact and cannot overwrite the original failure. Eight focused
reporting pins pass. A diagnostic baseline preload then completed in 73.822
seconds without reproducing the setup failure. This diagnostic is not a
replacement baseline or a paired performance pass.

A bounded setup-only reproduction used the same baseline build, two playback
intents and initial H8 shaping, without file payload. It stopped on the second
fresh room: the first succeeded, the second timed out waiting for the host to
play. The failed raw SHA256 is
`a59ea585369f8cd4f7b12d057f0508bed0a9499cf4bfd72a6d188f33fb9ceb5e`.
The helper adds a YouTube URL, which already requests automatic playback, then
immediately requests explicit replay of the same occurrence. In the successful
attempt readiness preceded replay. In the failed attempt replay called seek/play
while the fake player was still UNSTARTED; its later READY changed it to CUED,
with no subsequent host play call. It stayed there until the existing stuck
watchdog skipped the track about 19 seconds later, explaining the final idle
snapshot. Both observers recorded zero drops/exceptions and zero file payload.

Real application-module regression tests reproduce loss of the readiness-owned
intent under that controlled iframe boundary. Requiring readiness only in the
same-occurrence replay shortcut was insufficient: a poll/CUED path could still
consume the rearmed intent before READY. The minimal correction gates that
shortcut on player readiness and no active load, and makes the shared pending
consumer retain a valid current intent until the exact player is ready. Stale
owner cleanup, existing deadlines, normal READY consumption and already-ready
replay remain intact. No new retry loop is added. The affected integration file
passes 22 tests, including the two new boundary pins, and the existing normal
ready-replay pin also passes (125 unrelated tests filtered out). All three red
iterations are retained separately.

This identifies a reproduced readiness-contract defect in the baseline and C4
application, not a file-transfer failure. The fake provider exposes video metadata
before READY and controls the later CUED notification; identical live-provider
behavior is not established. The first lost-error attempt cannot be assigned this
cause conclusively. The next performance harness uses one natural chat-load
intent for both arms, matching the established E2E preparation, while a separate
native double-intent check verifies the readiness correction. Both are new frozen
runs; neither silently replaces old evidence. Current integration advances to
cache v730, with transport policy and all performance gates unchanged.

The committed readiness fix is `0387a64c`. Its committed production build,
full type and formatting checks, targeted lint and independent source review
passed. The first full Windows unit run found **13,343 passes and 16 failures**
across three existing YouTube/playlist test files, with no skips. The failed
report is retained as `root/full-unit-c6.json` under the integration scratch
directory. Thirteen failures consumed an intent to inspect it without marking
the mocked player ready; three resident-occurrence handoff fixtures omitted the
initial captured onReady event. The tests now supply that exact readiness
boundary, retain their original outcome assertions, and explicitly retain the
pre-ready intent where appropriate. No runtime gate is bypassed. Independent
fixture review passed, followed by all **423 tests in those three files**, with
zero failures or skips. The original full-suite failure remains recorded.
The complete Windows follow-up at `574624e1` passed **594 files / 13,359 tests /
zero failures or skips** (`root/full-unit-c7.json`, SHA256
`55e9b1e0c216f7b8c6c8d7ca21a6fc20cc0a1d5eccbc77b34bc2aa26a1bb8c54`).
Its CI found a separate type-only fixture error: the three new partial fake
players lack unused playlist methods required by the full player interface.
That correction (`b9eee17f`) follows the existing typed partial-fixture convention
and does not change product behavior. Full test types, the 118-test file, lint
and formatting passed.

The C6 native two-intent verification still failed on attempt two, after one
success. Both endpoints had zero observer drops/exceptions and no file payload.
The new raw evidence exposes a different remaining ordering: READY now starts
playback, but the same-target reload's deferred `cueVideoById` follows it by
2 ms and leaves the host CUED until the stuck-track watchdog. In the successful
attempt that cue preceded play by 8 ms. Exact source/served assets matched.
Independent audit `audit/setup-c6-independent-r1.json` has SHA256
`0f10f1161f3405ed7c41b18f42e104d569f75d53ec8a7041893c43fcbe4fc9b5`;
failed raw SHA256 is
`1cc4512e05ab4316d12436f96907b0e2ac917f26a825d726707191c75efef718`.
The callback itself was not separately traced; the deferred-cue attribution
combines these native calls with the source path. No performance pair followed.

A strengthened real-module test reproduces that ordering: READY immediately
after replay fails in three latest-intent variants, whereas READY after 100 ms
passes. The next minimal correction keeps the original load/session when a
same-occurrence, same-video, same-sub-index replay arrives before readiness.
It rearms the existing pending zero-start intent instead of reloading or
physically playing early; the ready fast path is unchanged. Later seek, pause,
stop and occurrence changes retain their existing intent/identity fences.
Cache advances to v731; transfer policy and performance gates are unchanged.
All 27 tests in the affected file pass, including both READY orderings,
latest-seek versus latest-replay, no duplicate physical load/session, and no
resurrection after pause/stop. Full test types, targeted lint and formatting
also pass. Their evidence manifest has SHA256
`21381151b7adfcd4c7d95b004df6389fd703797ebe4fcb3334e595db4144ba0f`.
The committed correction is `6a5afaae` (App 8.11.22/cache v731). Its committed
production build and full formatting check pass. The full Windows unit run
passes **594 files / 13,364 tests / zero failures or skips**;
`root/full-unit-c9.json` has SHA256
`5a9b24d57a72723137bbf655f6023e068b7931671bebfeea267d8aac982e4c59`.
Independent review confirms the only runtime delta from C6 is `playlist.ts`,
and all ten reviewed transport files remain identical to C4. The final branch
CI `39177262412` passes all eleven jobs; it is not an exact-main release candidate.
Before further measurements, the ordinary test order was
set to candidate then baseline: it replicates the prior C4 forward pass under
the unchanged transport implementation without duplicating both orders again.
This selection precedes any C9 numeric result and leaves all gates unchanged.

The unchanged native two-intent diagnostic then completed five fresh rooms.
Independent audit `audit/setup-c9-independent-r1.json` has SHA256
`978345562124e1a05f0a3738e957da4394ad4e3e0eeb5faf02e8de62c9f92074`.
All five finished with both endpoints PLAYING the same occurrence, with no
host cue/load after playback, browser errors, observer exceptions or drops.
Attempt three actually delivered the explicit replay before readiness; the
other four delivered it after playback had already started. Each guest still
performed its two initial rendezvous pause/seek/play sequences, so this result
does not claim uninterrupted guest playback or zero setup mutations. The
controlled-provider scope and the preserved C6 failure remain unchanged.

The C9 ordinary reverse pair independently passes the unchanged gates:
baseline **73.565 s** versus candidate **52.326 s**, a **28.8711%** reduction.
Maximum public-control delay is **1,679.1001 ms versus 217.3999 ms**. Exact
352-chunk file bytes/hash, queue/session identity, lane ownership, READY,
S=R=A accounting and cold control handoff all pass. There are 274 accepted
192 KiB sends above the old 128 KiB debt boundary. Applicable same-type
baseline-relative delay gates pass; fourteen duplicated whole/profile views
remain N/A due to sparse baseline samples or candidate-only acknowledgements.
Media analysis is N/A for ordinary transfer, not a playback-quality pass.
Independent audit `audit/performance-c9-ordinary-reverse-independent-r1.json`
has SHA256 `2e35ba7e685d30522d34ff0e4b0651ef6c3ba3b78345e15c01effe84e4cebe0c`;
manifest SHA256 is
`02e5fac247bf918849de81aed7d88f6862fb132b5fdf3146e847c0fc45c25200`.
Candidate raw SHA256 is
`889b7c915582ebfbfc3993165237d7461be9a3700342fbe093bdd5913470db43`,
baseline raw SHA256 is
`bf003e31b345231a5217c39df458cf9b700ca8d81a30b19d8a144be3c0922588`.

The fresh C9 H8 preload `resume-r2` pair also independently passes. Completion
is baseline **72.041 s** versus candidate **51.454 s** (**28.5768%** reduction);
maximum control delay is **1,226.200 ms versus 179.200 ms**. All 352 chunks,
23,040,044-byte S/R/reported/A accounting, file SHA, queue/session/lane identity,
37 frozen inputs and actual control handoff match. There are 277 accepted
192 KiB sends above the old debt limit. Applicable delay budgets pass; the
YouTube-control p95 comparison remains N/A with 24 baseline versus 17 candidate
samples. In the common measurement interval, the controlled provider has zero
unexpected mutations, non-playing samples or observation gaps, and residual
change from each own baseline is at most 1.05/1.00 ms. This is player-timeline
observation, not acoustic synchronization. Three candidate export-only tail
rows outside that interval remain invalid and are not silently discarded from
the raw record. Audit `audit/performance-c9-preload-resume-independent-r1.json`
has SHA256 `40599bfce4feaa4e8bc5166b0ac39d853a2dbcf69447729ad4d12ee0ca6b9f42`;
its manifest SHA256 is
`3c2e8b01ab9c733bbc9c2dfa87031f9fc68de71a6a8e4dcea4d9bac44c8af294`.

The fresh slow2 B→C preload pair independently passes. Completion is
**102.444 s versus 103.770 s** (+1.2944%, within the predeclared 10% limit);
payload-only time is 101.431 versus 101.626 s. Both remain at 128 KiB and
candidate expansion count is zero, as intended for this path. Maximum control
delay is **1,245.3 ms versus 348.2 ms**. File/accounting/route/freeze checks
and all applicable relative delay budgets pass (eight sparse views remain N/A).
Common media observation has zero unexpected mutations, non-playing samples,
gaps or invalid rows; the separate export-only invalid rows remain preserved.
Audit `audit/performance-c9-slow2-preload-independent-r1.json` has SHA256
`d4af4c2719733e900a3a69c8ca6b1b49e1ecde3b2ddf213552286c3f1e0a56ba`;
manifest SHA256 is
`e5e4533083f51db0a6ff543fc61acd5cc7d487c0b283206a4a4e2b1613683c48`.
The audit reader requires enlarged-window exposure for highRTT/dynamic only;
slow2's intended non-expansion is not a failure. This is a profile-correctness
fix to the reader, not a change to any numerical budget or product policy.

The fresh dynamic C→B preload pair independently passes. Completion is
**156.439 s versus 126.724 s** (18.9946% reduction; this profile requires no
more than 10% regression, not the H8-specific 20% gain). Maximum control delay
is **1,216.6 ms versus 565.5 ms**. Whole and individual-phase relative budgets
pass, including slow-phase pong excess maximum +124.1 ms within the 250 ms
limit; ten sparse views remain N/A. The fixed drop occurred at +30.008 s,
with matching endpoint/native-ledger boundaries proving accepted epoch 4,
192 KiB window and 196,608 bytes of actual debt. First observed fallback to
128 KiB is +30.793 s; accepted 192 KiB resumes at +97.662 s after recovery.
All three phases contain actual TX and RX. The exact 704-chunk / 46,080,044-byte
file, lifetime S/R/reported/A, source/routes and 42 frozen inputs pass.
Common media observations have no unexpected mutations, non-playing samples,
gaps or invalid rows; export-only invalid rows B3/C7 remain separate.
Audit `audit/performance-c9-dynamic-preload-independent-r1.json` has SHA256
`9b987a0ae4d6b8bb87963d77981201df424da8a391b945ca4773304c5ae0c7a9`;
manifest SHA256 is
`b0e075703ca442f34fb919b083c2313119b6b133f1c6ff17dc85a1b08203029c`.
The phase coverage helper was strengthened to check real guest RX as well as
host TX, preserving the original helper and adding missing-RX negative pins.
No product, shaping, timing or numerical acceptance value changed.

The resumed `product-c9-actual-reconnect-button-r2` functional run failed during
setup, before any injected side-connection failure or Reconnect click. Its first
ordinary file passed exact 74-chunk / 4,800,044-byte accounting, resident hash,
READY and route checks. The helper then added YouTube to the already nonempty
playlist and incorrectly waited for automatic playback. Raw events and source
confirm that adding to this queue preserves the current file, as intended;
neither endpoint made a YouTube player call. This is a confirmed test-helper
assumption error, not evidence of a product reconnect defect or a reconnect pass.
The failed raw SHA256 is
`085932f707b1fc2c5e9e0085fbbaac0084da016bfcff550388fa869bca5e441d`.
Independent triage `audit/reconnect-c9-r2-independent-triage.json` has SHA256
`ce6d52efea1383c63da7621f3fd82671ce716892c99b5feca82a5559eb397b2d`.

A separate functional-only helper now selects the newly added occurrence once
only when the preceding queue was nonempty and that occurrence is not already
current. Empty-room automatic startup, the frozen performance driver and all
product code are unchanged. The new helper and import-only runner revision
passed independent delta review, syntax and targeted strict types before the
new `r3` execution. Mixed-version cases start with an empty queue and retain
their existing driver. The original failure and its 25-input freeze remain
preserved; no timeout or product acceptance condition was relaxed.

The subsequent functional `r3` completed ordinary and preload files with exact
resident hashes, then closed the actual side connection with 65,536 bytes of
outstanding debt. The real Reconnect click navigated to the correct room URL,
changed the document time origin and completed bootstrap. The helper then
timed out waiting for a connection without pressing the invite screen's Start
button. Source confirms that `/CODE` opens that screen, and only its explicit
Start gesture calls `joinSession`. The new document recorded no PCs, logical
connections or native/application traffic. This second helper assumption error
does not demonstrate a reconnect transport defect, but the overall run remains
failed and does not qualify reconnection. The final invite DOM was not captured
in this run, so its visible state is a source inference, not direct raw evidence.
Raw SHA256 is
`ad5d265e07a604376dbc6df3d800b6d717f8f8bba58942d6fa7d83d4ba95576d`;
independent triage `audit/reconnect-c9-r3-independent-triage.json` has SHA256
`33293a122811cb451f4a7f928a6eb0038af9ba69f0be185f3cd07d9045f019f2`.
The next functional actor requires the exact visible room code and enabled Start,
clicks it once and preserves DOM/state even on failure. The contract is product
hard navigation followed by explicit user Start in the same Page/context,
not unattended automatic reconnection. Product code and acceptance limits remain
unchanged; the new actor/runner/analyzer delta passed independent reading.

Functional `r4` then completed the real Reconnect → exact invite Start sequence
and all three files. The original preliminary scorer reported
`exact-product-invite-code-not-proved` because it required the final URL to retain
`/CODE`. C9 intentionally cleans that URL to `/` after successful Standard join.
The preserved raw instead proves the exact pre-Start URL/visible code, one Start
click, and matching post-join room/host identity. Independent re-reading passes
that actual contract without another native retry; the original scorer failure
is retained. Raw SHA256 is
`12741e55e6e1d55bf00a79c122e7c1c1b36a8a193fde5dc3a2a10baa3df12ff3`.
The 31 frozen inputs, three 4,800,044-byte files with 74 exact chunks each,
queue/session/lane identity, S/R/A and resident SHA all match. The same browser
Page/context contains a new document and new connection/nonces; no send follows
the old logical close. This verifies user-operated recovery, not unattended
reconnection or uninterrupted media across navigation. Existing protected media
intervals have zero non-playing, invalid or unexpected mutation observations
(old 88/fresh 21 samples). Positive queue growth was not exposed in this run;
one initial fresh-bootstrap application entry lacks matching observation.
Those limits remain unavailable rather than being counted as passes.
Independent audit `audit/reconnect-c9-r4-independent-final-r1.json` has SHA256
`9d6eec8ee03047dbdac496754ad05fff8f0c708237fea5e6faf9ebe6b61d4a27`;
its manifest SHA256 is
`dad1b5668956406f36bd77ad0f70a32ea250c7317d660746a93af312151aebaf`.

The six mixed-version/lifecycle cases independently pass their functional
contract: new-host mixed old/new receivers for ordinary and preload, old-host
new receiver for both, cancellation/re-addition, and partial-preload promotion.
Ten received files each match 4,800,044 bytes / 74 exact chunks, resident SHA,
queue/session identity, native route and cumulative accounting. All 26 frozen
references and served C9/production-416 assets match. Mixed links retain the
128 KiB fallback; cancellation and promotion actually occur with 64 KiB partial
payload/debt, preserving accounting rather than testing only idle states.

One scope limit is explicit: the old-host preload run's labelled no-file
baseline overlaps its initial zero-start prepare/arm/commit. That produces
seven invalid paired samples (six host and five guest non-playing observations).
Both players start 2,577 ms before the first file demand; the protected file
interval then has 102 samples with zero invalid observations or unexpected
mutations. The frozen functional contract reports baseline observations but
does not impose the performance reader's additional uninterrupted-baseline gate.
The first independent reader's broader FAIL is preserved and corrected to the
original contract. Whole-baseline continuity is still false, and that interval
must not be reused as numeric performance evidence. Functional/route PASS is
not a claim of flawless playback throughout setup.
The independent result under `scratch/control-isolation-product-2026-10-19/`
is `compat/audit/compat-c9-independent-final-r2.json`, SHA256
`fe561443f0a1675c9f8a272abcd0c8b73a8a12c624561e3a3698b95402907a48`;
its manifest SHA256 is
`04066d3f3414113a99f415c7fc4048f185977c3ed440ff99bcf243aad82fca47`.

The constrained shared-host uplink preload B→C comparison independently passes. A single
4 Mbps host upload profile serves simultaneous slow2 and high-RTT receivers.
Their completion times are respectively **108.225→109.266 s** (+0.9619%) and
**97.740→99.208 s** (+1.5019%), within the unchanged 10% regression budget.
Whole-room maximum control delay falls from **2,184.0→375.2 ms** for slow2 and
**1,347.2→305.8 ms** for high RTT. All applicable own-transfer and whole-room
budgets pass across 29 groups; 17 sparse/unavailable views remain N/A.
The four files each have 352 exact chunks / 23,040,044 bytes with matching
resident SHA, S/R/A, READY/ACK and route ownership. Both candidate windows remain
128 KiB, with no expansion. Native selected-pair traffic is approximately
474/477 kB/s and aggregate receiver payload approximately 450/453 kB/s under the
single host profile, supporting actual shared load. These are not exact IP-wire
rates or a claim of saturation at every instant.

Common media and drain intervals have zero invalid/non-playing observations or
unexpected mutations; maximum change from each own baseline is 1.15 ms.
After-export guest-only invalid rows remain preserved (baseline 4/7, candidate
10/16). The final shared runner uses isolated type-only analyzer copies: two
runner annotations, an analyzer parameter annotation and corresponding import/
freeze names. Exact inverse edits recover the original files byte for byte.
Targeted strict types and all three syntax checks pass; no timing, expression
or acceptance budget changed, and prior frozen performance readers are intact.
The pair's 26-input freeze has SHA256
`b6964a8a4d00466f34b172f55a1b3dccee2167476ec9c6b4e3aeafe34a25f548`.
The final audit under `scratch/control-isolation-product-2026-10-19/` is
`shared-uplink/shared-c9-independent-final-r2.json`, SHA256
`a79702da5bf92199ffb41b98ff594bece5c27160b5c7dc0cba023793230920d5`;
its manifest SHA256 is
`6fd51907a4cffa5aa12068325b49e848f5cd62c460f9b4a8a382b3e58dc1cdb9`.
The owner has withheld deployment; passing these comparisons does not lift
that hold. No additional native run is required by this qualification plan.

At the owner's safe-pause request, only the already-running C9 H8 preload
candidate arm was completed, with raw export and browser closure at
2026-10-19 00:02:18.500 UTC. Its collector reports 52.621 s and exact
23,040,044-byte / 352-chunk S=R=A accounting. Raw SHA256 is
`4c2cdbbff66db55e89522685d6943d831a3efdfbdc175e89d2d6fbbcddf64f10`.
No independent audit or paired qualification was performed, and the baseline
arm was not started. The pause handoff has SHA256
`d602a17c2f2e2777928f7d4edc9e3e6ccfbc9408172166efc313e84cdb978d24`.
Existing approval/config files do not authorize execution during the pause.
The interruption must remain explicit when defining the resumed comparison.

All planned resumed product-native cases are now recorded above; future release
evidence will be added only after an authorized release. PR/local success cannot
replace the successful exact-main-SHA CI candidate.
An ordinary App release leaves Developer API D1 application disabled. Recovery
uses the immutable pre-release checkpoint and restores a compatible previous
App; rollback removes side isolation/adaptive expansion on refreshed clients,
while mixed clients retain the negotiated legacy route. No data migration.
