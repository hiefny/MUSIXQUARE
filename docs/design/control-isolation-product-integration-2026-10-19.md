# Standard control isolation: product integration

Status: implementation and verification in progress. This is not evidence of a
production release. The owner authorized integration, remaining tests, and an
App release only if ordinary transfer and preload pass. The starting main is
`deb52829930d0b8a4b87e70b05f84aa7c242c799`; production remains `416f5ee4`,
App 8.11.20/cache v723 until an actual release is recorded. The proposed product
is 8.11.22/cache v729. No dependencies, Worker protocol, schema, secret, binding,
CSP, admission policy or media format are changed. App release scope includes
the previously merged, undeployed YouTube clock-quality lease protections.

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
release success.

Remaining product-native results and release evidence will be added only after execution.
PR/local success cannot replace the successful exact-main-SHA CI candidate.
An ordinary App release leaves Developer API D1 application disabled. Recovery
uses the immutable pre-release checkpoint and restores a compatible previous
App; rollback removes side isolation/adaptive expansion on refreshed clients,
while mixed clients retain the negotiated legacy route. No data migration.
