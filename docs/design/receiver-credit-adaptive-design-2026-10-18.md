# Adaptive receiver credit and uncertainty-aware realignment (2026-10-18)

Status: experimental design and local comparison completed; adaptive candidate
A rejected under the frozen latency budget, Q retained as an unshipped precision-
correction candidate. No production change is authorized or claimed by this
report. The deployed fixed policy
remains a 64 KiB local next-send threshold and 128 KiB receiver credit.

## Question and baseline

The owner requested additional design and testing after the
[fixed-window comparison](receiver-credit-window-comparison-2026-10-18.md).
Increasing the fixed credit to 256 KiB shortened the 23 MB high-RTT transfer
from about 65 to 27 seconds, but added slow-link control delay and caused
unnecessary automatic YouTube realignment. The experiment must distinguish
transport improvement from merely suppressing that visible correction.

Baseline source is `60defdeee1aaf4025b8a91d66915baeada008c99`, whose runtime
matches deployed `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3` / App 8.11.20 /
cache v723. Candidate changes are isolated in source archives under
`scratch/receiver-credit-adaptive-design-2026-10-18/`; primary app source in
the working checkout is unchanged. The base archive SHA-256 is
`c685ad71d56057998cb969d2775c492a5cdbf4fc0a8afd3299c27d3116ff435f`.

## Design separation

The sender observes existing cumulative receipts, local monotonic send times,
and acknowledged progress. Send-to-receipt age includes transport, queues,
receiver decoding, receipt batching and reverse-path delivery. It is not a
measurement of pure RTT or one-way queue delay. The current receipt format
has no receiver timestamp and validates its exact fields, so adding a field
would require a distinct compatibility design.

Candidate A therefore keeps the wire format and receiver behavior unchanged.
It starts at 128 KiB, probes 192 and then at most 256 KiB, and accepts an
increase only after measured delivery gain and bounded receipt-age inflation.
The probe itself can briefly add queueing; every such delay remains in the
comparison interval. Shrinking changes admission for future sends, never
forgives bytes already outstanding. Credit, failure cooldown and cancellation
remain connection-owned. Metadata is bounded and contains no payload copies.

Candidate Q leaves shared-clock selection and playback commands unchanged.
It qualifies automatic small-drift precision realignment using the selected
clock sample's uncertainty, freshness and continuity. For observed drift d
and clock uncertainty U, a midpoint correction leaves uncertainty U; merely
proving `abs(d) > U` does not prove improvement. The conservative admission
requires `abs(d) > existing_threshold + 2U`, with `U = selected_RTT / 2 + 5ms`.
This depends on a common clock epoch, accurate timestamps and nonnegative
transport delays. It does not prove audible accuracy or bound subsequent
device-clock drift. If the evidence is ambiguous, the automatic precision
attempt is withheld rather than spending its cooldown or retry budget.

Manual Sync, explicit PLAY/PAUSE, state recovery, the large-drift heartbeat
seek and local-file drift correction are separate paths. Candidate Q is not
a general solution to every timing or network delay problem.

## Validation contract

Before measured runs, candidate source patches, builds, fixture identities,
runner and the matrix were frozen. New observations must not overwrite the
fixed-window evidence or turn a failed functional gate into a pass. A changed
design starts a separately identified candidate rather than replacing an
unfavorable result.

The local checks cover bounded credit and negotiation, stale/invalid receipts,
compressed ACK delivery, prior-window samples, cancellation debt, connection
replacement, cooldown persistence, bandwidth decline, clock discontinuities,
more than 120 seconds of congestion, genuine drift and explicit user actions.
Actual-product browser comparisons retain native RTC/storage, file hashes,
READY/ACK checks, unchanged wire matching and per-peer latency. A reduced
automatic-pause count cannot compensate for a failed network-delay budget.

In particular, a window decrease may temporarily leave old debt above its new
target. The invariant is each new send's `outstanding + next_payload <= target`
at admission, with old debt draining honestly; retrospectively requiring all
old bytes to fit the new target would be a false failure.

Related primary references: [RFC 6817](https://www.rfc-editor.org/rfc/rfc6817)
describes delay-sensitive background transfer and measurement limitations;
[RFC 8831](https://www.rfc-editor.org/rfc/rfc8831) describes WebRTC data-channel
transport. These candidates are application-level policies over existing
RTC, not an implementation or conformance claim for LEDBAT.

## Results

### Code and deterministic checks

Candidate A passed 39 focused controller/protocol/adapter tests: 17 new policy
pins plus 22 existing tests. The policy tests drive explicit send/receipt times;
they prove bounded state transitions and credit ownership, not native network
throughput. The runtime file SHA-256 is
`a1711f9077ede2c4ddb84d10925bb049ee3569190001bc9d24b9ab4435b5596b`.

Candidate Q passed the complete YouTube directory and existing/new shared-clock
regressions: 48 files, 1,525 tests, zero failures or skips. App/test TypeScript,
targeted lint and formatting passed. These are focused archive checks, not the
repository's full suite or a release candidate. The tests retain the real clock
selector and production heartbeat handler with a controlled player and virtual
time. In the 190-second congestion reproduction, the unchanged baseline made
three unnecessary automatic realignments for an aligned player in both Android
and non-Android cases; the candidate made none. Separate pins cover genuine
drift, stale/discontinuous clocks, attempt budgets and explicit controls.

The Q runtime SHA-256 values are
`b1f4d96d37f0ae9b0afd63bfa1dc8c90ef9d519a760a4611515c3337ff78fc04`
(`shared-clock.ts`) and
`e3ac45728b2c1681128d252f8262720a25944e7c601531d346e501e081c69621`
(`youtube/sync.ts`). Independent source review found no P1/P2 in this limited
scope. The quality decision is made at admission: a later clock change during
the rendezvous countdown, an unobserved remote clock step, or a local wall/
monotonic discrepancy within the existing 100ms allowance is not thereby ruled
out. The selected offset itself is unchanged, and the guard does not certify it
as correct.

### Native browser comparison

Four isolated builds separate the questions: B128 is unchanged fixed 128 KiB;
A changes only the sender controller; F256 changes only the fixed window to
256 KiB; Q256 adds the quality gate to that fixed-256 control. All retain the
64 KiB local threshold, 64 KiB receipt batching and existing 20ms receipt timer.
Source manifests verify the allowed file differences against the exact archive;
loaded lazy peer assets are also checked against each build's SHA-256 manifest.

The execution freeze SHA-256 is
`d781b1cf9dd1465ce532f994d51118de1a0f86c380beb1cfe293eaf07e982ad2`,
runner SHA-256
`b0cb828803f2ae24d0bd3efdd8454d5b8fb3a98a990fbaa536e8a890add1516b`,
and staged matrix SHA-256
`de9c5325cef2eb5b5fc90573e7392c1bb093e7e24e83cc62f25d75d163551b2d`.
The matrix is a conditional menu, not a claim that every listed case ran.

One excluded preflight verified three native file receipts, final ACKs, exact
per-send admission, recorder collection and actual 128→192→256 transitions.
It is not counted as a performance confirmation.

The first static pass completed all 12 cases and all 56 file receipts. Native
file integrity, cumulative credit, final ACK/READY and applicable playback
checks passed. A's performance acceptance **failed**; these functional passes
must not be described as all-green acceptance.

| Condition / workload                 | B128 completion | A completion | B128 app-control max down/up | A app-control max down/up |
| ------------------------------------ | --------------: | -----------: | ---------------------------: | ------------------------: |
| Direct, 8 recipients / ordinary      |         8.421 s |      8.403 s |                   61 / 66 ms |                26 / 60 ms |
| Direct, 8 recipients / preload       |         7.918 s |      7.898 s |                   48 / 66 ms |                57 / 62 ms |
| 2 Mbps slow recipient / ordinary     |        97.307 s |     97.368 s |                 436 / 115 ms |              701 / 116 ms |
| 2 Mbps slow recipient / preload      |        97.199 s |     97.251 s |                 628 / 124 ms |              697 / 117 ms |
| 8 Mbps high-RTT recipient / ordinary |        65.411 s |     29.095 s |                 299 / 116 ms |              226 / 114 ms |
| 8 Mbps high-RTT recipient / preload  |        65.101 s |     29.310 s |                 709 / 123 ms |              710 / 114 ms |

Completion is the slowest recipient's first native SEND→last RECEIVE interval.
Shaped cases have three recipients, only the third shaped with 100ms configured
latency each way; measured no-file RTT was about 217–219ms. Down/up maxima
include application controls, not private receipts, over the supplemental
room-wide transfer interval. They are descriptive; the acceptance comparison
uses the same peer, message type and direction after each case's own no-file
baseline. Ordinary-file checks do not require retaining the previous YouTube
mode. Every preload case retained its original video with no added playback
mutation.

The failing comparison was slow2 ordinary guest 3, downlink `sync-pong`:
baseline-adjusted maximum 323→597ms, **+274ms**, exceeding the predeclared
+250ms allowance. Both cases had 97 messages; the p95 increase was only 17ms,
and raw maximum remained below the separate 1,000ms ceiling. This is one
specific tail-latency failure, not a claim that every control became slower.
At 2 Mbps A repeatedly tried 192 KiB, detected receipt-age inflation, and
returned to 128 KiB with cooldown; the trial itself added queueing without
shortening file completion. At high RTT A reached and retained 256 KiB and
shortened completion by approximately 55% in both workloads.

The conditional reverse-order confirmation, dynamic-bandwidth, A-long,
lifecycle and mixed-legacy stages are **not run** after this acceptance failure.
Their presence in the frozen menu is not evidence of execution. This single
exploratory pass supports rejecting this candidate under the chosen budget,
not a stable population estimate of a 55% improvement.

An already-frozen B128 long-preload case was added as an unconditional current-
default anchor before any long results existed, recorded in
`execution-amendments.json`. It is independent of A eligibility. Long B128,
F256 and Q256 each received the same 42,240,044-byte / 645-chunk / 220-second
WAV, with a 600-second advancing fake video so EOF could not mimic a failure.
The short fixture is 23,040,044 bytes / 352 chunks / 120 seconds. Their SHA-256
values are respectively
`eed9a74e30b7f1039733096a586b14b86bd7c0b7a4442b5231bc2168e4f6b638`
and `5749688e4e6306234de4add49e9191c5e8974e4d60de48671c4bd57dca4db83d`.

| Long slow-link preload | Slow recipient completion | App-control maximum down/up | Added player calls | Playback preserved |
| ---------------------- | ------------------------: | --------------------------: | -----------------: | ------------------ |
| Current B128           |                 177.670 s |                633 / 120 ms |                  0 | Yes                |
| F256, no quality gate  |                 177.721 s |                986 / 128 ms |                  5 | **No**             |
| Q256, quality gate     |                 177.735 s |                989 / 124 ms |                  0 | Yes                |

All nine long-run file receipts passed SHA, ordered payload, cumulative credit
and final ACK checks. F256's playback failure remains a failure. Its slow
recipient called `pauseVideo` and `seekTo` at +69.006 seconds, then `playVideo`
at +70.263 seconds relative to measurement start. The selected clock was about
−301ms with RTT 820ms. A second `pauseVideo`/`seekTo` pair at +182.315 seconds
occurred after offset recovery to about +2ms. Observation ended before its
`playVideo`; this is one completed rendezvous plus one started but unfinished
rendezvous, **not two completed interruptions**. Independent reconstruction
using the single PC's common wall clock and accounting for the fixture's
Android 250ms position lead found approximately zero logical player residual
before the first pause and about −309ms after it. The later
attempt addressed that residual after clock recovery; it is not a second
false-positive. These are logical fake-media positions, not physical audio
measurements. No user action, video or queue replacement, channel closure or
recorded error explained the five calls.

Q256 retained playback without making delivery faster: 986→989ms maximum
downlink control age and essentially identical completion times demonstrate
that separation. Native timing and recorder observations support the code-path
comparison, but the gate's read-only getter itself emits no branch event. This
is not a direct acoustic measurement or a claim that the biased clock estimate
was repaired. Genuine drift and manual actions were separately pinned in the
deterministic suite, not deliberately injected into this native long run.

In total, 16 native executions comprise one excluded preflight, 12 static cases
and three long comparisons. All **68/68 file receipts** passed integrity/credit
checks: 56 static, nine long, three preflight. Functional outcomes were 15 pass
and one retained negative-control playback failure; excluding preflight, 14
pass and one failure. A's separate performance acceptance failed as above.
Twenty-three conditional menu cases were not executed. No retries replaced a
failed measurement.

## Environment, audits and limits

Measurements ran on one Windows 11 Pro 10.0.26200 PC, Intel Core i7-13800H,
20 logical processors and approximately 64 GiB memory. Local Node was
24.13.1, Playwright 1.63.0 and Chromium 153.0.8010.12. This is not the pinned
production CI Node runtime. Guest Android UA/touch emulation is not physical
Android testing. The signaling, native RTC and storage paths were real local
product paths; the YouTube player advanced under the controlled helper.
Builds and unrelated tests finished before timing began. No other agent ran
large raw-file analysis during the reserved measurement interval.

Independent analysis reconstructed the same +274ms failure and completion
times. Paired no-file baselines needed at least six messages of the same type
and direction; loaded p95 comparisons needed at least 20 messages in both
variants. The short direct8 transfer intervals had no p95-eligible groups.
Seven paired type/direction groups across ordinary cases lacked a comparable
baseline and are retained as unavailable, not silently zeroed. All application
message types still contribute to raw maximum measurements.

The frozen matrix contains LF-text config hashes, while Python wrote Windows
CRLF bytes. This metadata normalization discrepancy was discovered during the
independent audits, not hidden by rewriting the frozen matrix. The separate
pre-execution freeze hashes the actual file bytes; executed raw records match
those exact hashes, and normalized JSON/text match the matrix. The executed
configuration did not change during measurement. Both hash forms and the
diagnosis remain in the audit output.

The integrity audit independently matched 68 files, 26,573 chunks,
1,739,522,992 payload bytes and 68 final application ACKs. It found two unobserved
late `sync-ping` deliveries in the high-RTT B128 cases: they were sent 4,041 and
4,014ms after the last bulk receipt, leaving only 67 and 62ms before capture
ended on a path shaped to 100ms one way. These are outside both scored bulk
intervals; no scored control was unmatched. Their subsequent delivery is
unobserved, not silently counted as successful. Full-window observation is
therefore distinguished from the explicit transfer-latency scoring interval.

Raw records, source patches, manifests, fixture hashes, freeze, scoped scripts
and derived audits remain under the scratch root named above. Performance audit:
`analysis-audit.{mjs,json,md}` and `analysis-audit-groups.csv`. Integrity/quality
audit: `independent-integrity-quality-audit.{py,json,md}`. Candidate unit evidence:
`adaptive-focused-tests.log`, `adaptive-source-manifest.json`,
`quality-validation.md` and `quality-candidate-manifest.json`. No runtime source,
dependency, wire format, Worker, schema, secret, binding, version or cache change
was promoted to the main checkout or production by this experiment.

The final `primary-evidence-manifest.json` seals 116 files / 407,018,062 bytes,
with SHA-256
`8239424265f3efa228a944f93736b8b7d8fabdd7215c9aacca6e8f52450439b3`.
It includes the raw runs, frozen configurations, fixtures, source/build
identities, loaded browser assets, environment and cleanup evidence; mutable
derived audits are excluded. All 67 files from the pre-execution freeze were
rehashed successfully. The independent integrity/quality audit Markdown has
SHA-256 `eaa5e0623309cf7df411540ea2806e828a494155edf2e7e553b364012cde91e5`.

The five experiment-owned server sessions were stopped after measurement.
`cleanup-before.json` and `cleanup-result.json` confirm their PIDs exited and
ports 4394–4397 / 8801 had no remaining listeners at 05:48:35 UTC. Source
archives, raw evidence and the earlier retained worktree were preserved.

The native tests are exploratory single-PC comparisons, not independent-device
population trials. No full repository unit/E2E suite, remote candidate runtime
CI, physical Android, audible synchronization, live YouTube, TURN, packet loss,
radio contention, or more than eight recipients was tested. CPU observations
include harness cost and unequal durations; they do not isolate ACK overhead.
The automatic quality gate does not cover the separate large-drift/file paths
or a subsequent clock change during countdown. The original real-device
incident and broader latency/throughput limits remain open.

Q can withhold real moderate drift as well as false drift when clock evidence
is uncertain. For example, a genuine 309ms error with RTT 218ms is below its
378ms threshold. The deterministic positive cases do not establish that every
real error will be corrected. The native comparison used Q with fixed 256 KiB,
not the deployed 128 KiB policy; Q remains a separate candidate for later
review, not an approved runtime change from this experiment.

### Follow-up design boundary

A read-only A2 discussion considered refusing an upward probe when its added
bytes divided by observed delivery rate already exceed the 250ms comparison
budget. This is a plausible conservative heuristic, not an implemented fix or
tested bound. Receipt rate is not necessarily link capacity, and a later rate
drop can strand bytes that were already admitted. A rollback cannot recall
those bytes. Any budget for 256 KiB would also need to count its total increase
over 128 KiB, not grant a fresh 250ms allowance to each 64 KiB step. No A2 source
or threshold tuning was introduced after seeing A's result. No dynamic failure
is claimed from this analytic risk; the dynamic tests remain unexecuted.
