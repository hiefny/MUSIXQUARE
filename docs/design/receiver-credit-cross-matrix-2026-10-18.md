# Local buffer and receiver-credit cross comparison (2026-10-18)

Status: 36 discovery and 12 reverse confirmation cases completed and
independently audited. Functional totals: 45 pass / three retained playback
preservation failures. No challenger qualifies for promotion.
Production remains App 8.11.20 / cache v723, with 64 KiB chunk payload,
64 KiB local next-send threshold and 128 KiB receiver credit.

## Question and scope

The owner requested a controlled cross comparison after the fixed-window and
adaptive experiments. The initial preload 256-to-64 KiB comparison reduced the
local `bufferedAmount` admission threshold, not chunk payload size, before
receiver credit existed. Ordinary transfer's later local-threshold reduction
also had comparisons that added receiver credit at the same time. Neither
establishes the best local threshold when both gates operate together.

The experiment holds 64 KiB chunk payload, 64 KiB receipt batching, partial-tail
20ms receipt flush and playback/clock logic fixed. It crosses local thresholds
64/128/256 KiB with receiver-credit windows 128/256 KiB. All ordinary broadcast,
ordinary unicast and preload local threshold declarations change consistently.
Source baseline is `2a0ed4a08b24f5a187f47122f866d34997cf7457`; its runtime
matches deployed `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3`.
Adaptive and clock-quality candidates from the previous investigation are not
part of these variants. PRO and R2 routes are outside this direct-RTC experiment.

## Execution and measurement contract

Environment: Windows 11 Pro 10.0.26200, Intel Core i7-13800H (20 logical
processors), 68,535,443,456 bytes physical memory; Node v24.13.1,
Playwright 1.63.0 and Chromium 153.0.8010.12. Chromium's version is recorded
by `browser.version()` in the raw result, not inferred from the package range.

The first stage has 36 cases: six policies, ordinary/preload workloads and
direct8/slow2/highrtt8 network profiles. Direct8 uses eight recipients. The
shaped profiles use three, with guest 3 at 2 or 8 Mbps and configured 100ms
latency each way. Configured latency is separate from observed baseline RTT.
Policy order rotates across the six workload/profile blocks.
The existing scratch helper installs Chromium
`Network.emulateNetworkConditionsByRule` before peer socket creation, with an
empty-pattern global P2P rule and explicit HTTP/HTTPS/WebSocket exemptions.
Shaped upload and download rates are both 250,000 or 1,000,000 bytes/s; configured
packet loss is zero and reordering is disabled. Local signaling and asset
loading are not included in that P2P throttle. No OS network setting changes.

The second stage compares current L64/C128 with a selected challenger across
all six blocks in the reverse restricted order: 12 further cases. Selection
prioritizes file/protocol/playback validity, then control latency, high-RTT
completion and regressions elsewhere. The frozen scratch acceptance contract
defines budgets and the explicitly ineligible diagnostic fallback if no
challenger satisfies every gate. No production winner is mandatory.

The inherited 100ms/250ms comparison budgets mean candidate-minus-anchor
differences after each run's own no-bulk baseline correction, within the same
phase/profile/workload/peer/message type/direction. For each usable group,
`excess = max(0, loaded delay - that run's no-bulk median)`. The candidate's
excess p95 may increase by at most 100ms and excess maximum by at most 250ms
against L64/C128; raw application maximum must also remain at most 1000ms.
Both no-bulk groups need at least six deliveries, and p95 comparisons need at
least 20 loaded samples on both sides. Missing comparisons remain unavailable.
The recipient's own file-transfer interval and the room-wide transfer interval
are evaluated separately; failing cells are unioned, not averaged. The latter
retains control deliveries to fast recipients after their own file completes.
This interpretation follows the prior frozen window plan's explicit
"Relative to 128 KiB" wording; it does not turn the relative budgets into
absolute no-bulk excess ceilings. Absolute excess is still reported as load.

Existing-event observation distinguishes local-only, credit-only and combined
capacity waits. These are last-observed interval estimates, not a direct
measurement of when native queues drained. Receipt arrival, credit application,
low-water events, fallback checks, wait completion and accepted native send
must remain distinguishable. Connection wait unions avoid counting concurrent
waiters as additional wall-clock time. Local buffered bytes include application
headers; receiver credit counts payload. Neither represents every network queue.

## Results

The final observer preparation passed 22 helper/collector pins and 11 offline
aggregation pins on Windows/Node 24.13.1, with no failures or skips. Earlier
iterations remain separately preserved; repeated passes are not additional
independent tests. Six isolated Vite builds succeeded and each source/build
manifest was checked. These are experiment builds, not release candidates.

One excluded L64/C128 high-RTT preload preflight passed all three files' hashes,
ordered 352-chunk sequences, receipt/ACK checks, local admission and playback
preservation. The shaped guest completed in 64.724 seconds, measured baseline
RTT approximately 218ms. The host observer retained 15,570 events and 2,112 waits,
with zero dropped records, exceptions or predicate/observation divergences.
Handler cost was 94.2ms across the recording, excluding helper-side reads and
the other inherited harness instrumentation.

For this one shaped guest, last-observed connection-union waits were 44.553s
with both gates blocked, 18.434s credit-only and 0.818s local-only. None of 951
fallback checks resumed a wait. These exploratory observations do not establish
that removing one gate will remove all intervals in which it was blocked.
The raw preflight SHA-256 is
`641de9aea100359d7df19af13a3e6cc6c90b4c687666c83868db2a78ee1b3b2c`.

Preflight exposed an offline attribution presentation issue: control-channel
low-water events and events before any active bulk waiter could produce a large
event-to-next-send interval. They must be retained but separated from data-lane
wakeups that actually release an existing wait. Likewise, the last ready check
before send does not bound time since the first ready check before a Blob read.
These distinctions are corrected in a separately versioned offline analysis;
the original freeze and preflight are preserved. Source/build behavior is not
changed to improve a result.

### Discovery: 36 cases

Each cell below is the slowest recipient's file completion in seconds. This is
one observation per cell, not a confidence interval. All 168 received files
passed the harness's SHA, ordered chunks and receipt/final-readiness checks.
Functional totals are 33 pass / three fail; these must not be called all green.
An independent audit of all 36 cases verified 168 files, 59,136 ordered chunks
and 3,870,727,392 payload bytes, with zero integrity/identity/observation issues.
The three playback failures were confirmed separately from transfer success.

| Local / credit KiB | direct8 ordinary | direct8 preload | slow2 ordinary | slow2 preload | highrtt8 ordinary | highrtt8 preload |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 64 / 128 (current) | 8.251 | 6.219 | 97.305 | 97.200 | 64.450 | 64.990 |
| 64 / 256 | 8.304 | 6.243 | 97.204 | 97.238 **F** | 27.145 | 27.360 |
| 128 / 128 | 6.868 | 6.343 | 97.189 | 97.129 | 64.339 | 64.896 |
| 128 / 256 | 6.852 | 6.160 | 97.225 | 97.161 **F** | 27.155 | 27.117 |
| 256 / 128 | 6.665 | 6.260 | 97.202 | 97.123 | 65.344 | 65.076 |
| 256 / 256 | 6.545 | 6.217 | 97.212 | 97.131 **F** | 27.197 | 27.309 |

**F** means the file completed but YouTube playback preservation failed.
All three failures were slow2/preload with credit256, one for each local
threshold. Their additional player calls were 3/5/5 for local64/128/256,
respectively; calls are not counts of complete corrections. They remain
failures even though the transfer and observation checks passed.

In highrtt8 ordinary L256C128, the shaped connection's last-observed union
was 64.530s credit-only, zero local-only and zero both, with 987 fallback
checks and zero fallback resumes. Receipt-to-next-send p95 was 2.4ms, maximum
18.1ms; these intervals may include reads and scheduling after credit becomes
available. This directly observes that local admission was not binding there;
it does not identify every underlying SCTP/OS/network queue. The 65.344s file
time persisted while local waits were absent. The reverse confirmation below
retains essentially the same file completion time.

### Confirmation selection, fixed before its execution

No challenger passed every discovery gate. Credit256 failed playback
preservation. The remaining credit128 candidates failed only the matched
maximum-delay budget in these cells (shaped guest3, downward `sync-pong`):

| Candidate / cell | Candidate / anchor raw max ms | Candidate / anchor excess max ms | Excess max increase ms | Excess p95 increase ms |
| --- | ---: | ---: | ---: | ---: |
| L128C128 slow2 ordinary | 719 / 438 | 608 / 324 | **284** | 7 |
| L128C128 slow2 preload | 905 / 628 | 799 / 521 | **278** | 3 |
| L256C128 slow2 preload | 912 / 628 | 800 / 521 | **279** | -12 |

All six loaded group samples above contain 97 messages. These are maxima from
one exploratory run per cell, not a stable difference proven across devices.
The 250ms comparative maximum budget was fixed before measurements.
L256C128 has one failed cell and normalized worst budget 1.116, versus two
failed cells and 1.136 for L128C128. The frozen diagnostic fallback therefore
selects **L256C128, explicitly INELIGIBLE**, against current L64C128 for 12
reverse-order confirmation cases. Neither candidate has a substantial discovery
high-RTT gain. A later favorable repeat cannot erase these retained failures.

An independent room-wide robustness check found no additional failed cells
and did not change that ranking. Missing no-bulk groups for these credit128
candidates are transfer-only `preload-ack` messages: they have no honest
no-transfer counterpart and retain raw latency instead of a fabricated zero
excess. Some low-count groups cannot support p95 decisions; their usable
maximum-delay comparisons remain included. This is not full statistical
coverage of every message group.

### Reverse confirmation: 12 cases

Both policies passed all six functional cases, with zero unexpected player
mutations in preload. These passes do not erase discovery's three credit256
playback failures; credit256 was not selected for this second phase. The
following table keeps the two phases separate. File completion uses the
slowest recipient, while raw control maximum includes all recipients and both
own-file and room-wide observation intervals.
These are application control messages; private `mxqr-bulk-flow` HELLO/receipt
traffic is excluded from that control statistic and has separate capacity
and receipt timing records.

| Profile / workload | L64/C128 completion s | L256/C128 completion s | L64/C128 raw control max ms | L256/C128 raw control max ms |
| --- | ---: | ---: | ---: | ---: |
| direct8 ordinary | 6.661 | 6.608 | 52 | 30 |
| direct8 preload | 6.106 | 6.239 | 70 | 57 |
| slow2 ordinary | 97.197 | 97.164 | 424 | 478 |
| slow2 preload | 97.186 | 97.165 | 628 | 916 |
| highrtt8 ordinary | 64.327 | 64.539 | 264 | 358 |
| highrtt8 preload | 65.237 | 65.011 | 717 | 923 |

The apparent direct8 ordinary improvement in discovery (8.251→6.665s) did
not repeat when order was reversed (6.661→6.608s). This does not establish
which session/order effect caused the first difference. High-RTT completion
is unchanged in both phases. Slow2 preload again has essentially unchanged
completion and a larger raw maximum under local256. The independent audit
confirms the same maximum-delay budget failure in both phases:

| Slow2 preload, guest3/down/sync-pong | L64/C128 | L256/C128 | Candidate minus anchor |
| --- | ---: | ---: | ---: |
| Loaded samples / no-bulk samples | 97 / 18 | 97 / 18 | — |
| No-bulk median ms | 106 | 105 | -1 |
| Raw loaded maximum ms | 628 | 916 | +288 |
| Own-baseline excess maximum ms | 522 | 811 | **+289 (fails 250ms budget)** |
| Raw loaded p95 ms | 427 | 420 | -7 |
| Own-baseline excess p95 ms | 321 | 315 | -6 |

Own-file and room-wide comparisons agree. This is a repeated maximum-tail
regression, not a claim that typical latency rises by 289ms. Neither phase
shows a substantial high-RTT completion improvement from local256.
The confirmation comparison has 31 unavailable no-bulk groups, all
transfer-only `preload-ack`; they are not counted as passing excess checks.
Low-count p95 groups are also excluded explicitly rather than filled with zero.

All 103 confirmation freeze hashes, reversed order and unchanged source
configurations were verified. The 12 cases include 56 finalized files,
19,712 ordered chunks and 1,290,242,464 payload bytes, with zero audit issues.
Together the two phases contain **48 cases, 45 functional passes / three
functional failures, 224 valid files, 78,848 chunks and 5,160,969,856 payload
bytes**. The excluded preflight adds three files and is never pooled into
those totals or used to erase a failure. No fallback timer check resumed a
wait in either phase; observation loss, exceptions and divergences were zero.

### Decision

Keep deployed **64 KiB payload / 64 KiB local threshold / 128 KiB receiver
credit**. The enlarged credit improves the shaped high-RTT throughput but
fails playback preservation on slow2; the selected L256/C128 challenger does
not preserve its apparent direct8 benefit in reverse order and repeats the
slow2 control tail failure. L128/C128 was not reverse-tested. No balanced
replacement meets the frozen criteria. This result
does not establish that the current policy has no remaining performance
limitations, or that every possible larger-window design will fail.

### Retained first playback-preservation failure

Discovery case 19, slow2/preload/L128C256, failed playback preservation and
paused the matrix for two independent reviews. All three files still passed
ordered 352-chunk delivery, matching final SHA, preload ACK, nonce/cumulative
receipt accounting and capacity gates. Each connection had
`S = R = A = 23,040,044` payload bytes and peak debt 262,144 bytes. Native
pre-send buffer maxima were 82,620/81,108/109,768 bytes, below local131,072.
Observer loss, exceptions, predicate divergence and connection errors were zero.

Only the shaped recipient made five additional player calls. At +65.889s
relative to transfer observation start it paused and sought, then played at
+67.139s. The selected clock offset was -292.5ms with RTT809ms after capacity
eviction of better samples. The controlled player's independent common-PC-time
position residual was -1.5ms before this first automatic realignment and
-293.5ms afterwards. Its reference includes host-frame position, common-PC
elapsed time and the emulated Android path's 250ms position lead. This is a
logical-position check, not an acoustic reading.
After the selected clock recovered to +4.5ms, a second pause/seek occurred at
+101.300s; observation ended at +102.029s before its play call. That second
attempt may be correcting the first induced residual, so five calls are not
five corrections, and both attempts must not be labelled unnecessary.

The raw failure is retained with SHA-256
`680efe3b95849ce841d54a0f398df9c719566bff5ddf326be0035b23036beb4b`.
Only remaining original cases were resumed. The recorded continuation policy
allowed repeated, classified automatic realignment-only failures to continue
as failures; any new file, credit, observer or unclassified failure would
pause again. No playback assertion, source policy or measurement result was
changed to obtain a pass.

## What the crossed factors establish

- **High RTT:** discovery completion follows the credit factor: approximately
  64–65s with credit128 versus 27s with credit256, at all three local thresholds
  and in both workloads. Raising only local64 to local256 removes the observed
  local restriction without removing the long completion time. Local64 is
  therefore not supported as the main cause of this condition's 65s transfer.
  Credit-only waits describe the last observed application admission condition,
  not unnecessary delay attributable entirely to the credit implementation.
- **Bandwidth-limited slow2:** 23,040,044 payload bytes alone require 92.160s
  at 2Mbps. The approximately 97s observed across all six policies is close to
  that configured throughput limit once protocol and processing costs are
  included. Larger gates do not materially improve completion there, while
  all credit256 preload variants fail playback preservation.
- **Unshaped direct8:** ordinary completion improves from 8.251s at L64/C128
  to 6.665s at L256/C128 in discovery, but the reverse comparison is
  6.661→6.608s. Preload stays near 6.2s. A repeatable throughput benefit from
  raising only the local threshold is not established by these two phases.
- **Fallback wakeups:** zero fallback checks resume a wait across all 36
  discovery cases. These observations do not support a 50ms polling penalty
  being added to every chunk. Full 64KiB receipts already trigger promptly;
  the 20ms partial-tail flush is not a per-full-chunk batching delay either.

The idealized `128KiB / 218ms` rate is about 4.81Mbps, implying 38.3s for this
payload. It assumes a continuously utilized window and uses a small control
message's unloaded RTT, not the full-chunk delivery/processing/receipt cycle.
It is not a prediction or guarantee for this transport. The remaining gap to
65s cannot be assigned to a particular SCTP, browser or ACK mechanism from
these application observations alone, and an inferred cycle time is not a
measured network RTT.

Native buffer bytes and receiver-confirmed payload debt are different counters.
Discovery observed a few credit-ready checks with native buffer131,538B
(ordinary) or131,380B (preload), above the 128KiB local threshold, despite
payload debt65,536B and next payload65,536B fitting credit128KiB. L256 allows
some such sends and L128 does not. This does not establish that headers alone
cause the measured speed difference: delivered-byte accounting and native
buffer updates can temporarily differ. A local threshold is checked before
the next send and is not a hard cap on the buffer after that send.

## Evidence identity

Local evidence is retained under
`scratch/receiver-credit-cross-matrix-2026-10-18/`; it is not a remote CI
artifact. The source archive, six built variants, frozen configuration order,
raw cases, observer source and independent reconstruction remain separate.
No failed case is replaced by a later pass. The 120-second, 48kHz stereo
16-bit WAV has 23,040,044 bytes and 352 payload chunks; its SHA-256 is
`5749688e4e6306234de4add49e9191c5e8974e4d60de48671c4bd57dca4db83d`.
The longer fixture listed in the scratch inventory is not used in this matrix.

| Evidence | SHA-256 |
| --- | --- |
| Baseline `source-2a0ed4a0.zip` | `33d5e78e706d95eb911e8ee7746f1ca6026254aaa4860ec310a326ef94293264` |
| Discovery `execution-freeze-v2.json` (84 files) | `4d429d390eae0db62aef5b1ccd433a0d6f7f7a1589e4791e627dc3bc463df21e` |
| Active `cross-product-runner-v2.mts` | `87b3a16af071b6d4a6540752639cb40dd8de79271f7f996eebda884664157c6f` |
| `root-acceptance-v1.md` | `70e3a22947a039a1f116cea75ece2482f56703990caefb2bceb4175ada48bb2e` |
| `independent-matrix-audit.py` | `39762f67e4ee37150494a4ab49329ffb47af5a42265581a926121c22d613d16d` |
| `independent-matrix-audit.json` | `c2114b0383baf3d3eb5dcca6df1a41d6ac3b582f39330ae0807ec90e74b250aa` |
| `independent-confirmation-audit.py` | `358f381c460825783d71635db1555aed7590613c8b3664903bde741669d521b5` |
| `independent-confirmation-audit.json` | `26e3b65cbb93003d1eacd35c6b256dab548fd314bac48d1d19f67200ea9e1db6` |
| `matrix-confirmation-frozen.json` | `e8d1882bd243f3b414bf4a21a7f66e0684d79dde82ee53cb14220b60eaec015e` |
| `execution-freeze-confirmation.json` (103 files) | `01f3c88f7ac104c29ae40d7bffebc59ec193885fbf6c20efc0da4e74517b7ddf` |

The confirmation freeze predates its first measurement. Each confirmation
configuration preserves its discovery source configuration except case identity
and stage. The independent audit checks served assets, lazy peer identity,
ordered send/receive metadata, nonce, sender/receiver-local cumulative receipt
invariants, final `S = R = A`, local admission and observer integrity. The final
Blob digest is reported by the browser and compared with the independently
hashed fixture; the raw JSON does not contain another full copy of each file.
The confirmation audit passed on its first execution with no audit-code repair.

The scratch execution entry point is `node .../run-stage-v2.mjs explore-static
<first> <last>`; ranges resume after a preserved failure has been classified.
`node .../run-confirmation.mjs 1 12` validates the second freeze before running
the selected reverse cases. Existing case IDs and logs cannot be overwritten
by these launchers. Independent reconstruction uses
`python .../independent-matrix-audit.py` followed by
`python .../independent-confirmation-audit.py`; the second retains the original
discovery audit. Here `...` is the scratch directory named above, not a command
to run a production or remote test.

## Limits and publication

Native RTC, signaling and storage run on one Windows PC with a controlled,
advancing YouTube provider. This is not physical Android, audible synchronization,
actual Wi-Fi, live YouTube, TURN, R2 or more-than-eight-recipient validation.
Only the measurement owner runs browsers or heavy processing during timed cases.
Observation overhead and any missing records must remain explicit.
Only ordinary broadcast and preload are exercised as throughput workloads;
consistent unicast constants do not constitute a unicast performance test.
This round does not rerun the product full unit/E2E suite, lifecycle
cancellation/promotion matrix, mixed-version admission, or remote production
smokes. It does not replace their earlier evidence. The experiment's owned
servers and browsers were closed after measurements; raw files and builds
remain preserved locally.
The first discovery runner began at 2026-10-18 06:39:54.154 UTC and the last
confirmation record completed at 08:10:04.745 UTC: approximately 90 minutes
including inter-case preparation, preserved failure analysis and selection,
not 90 minutes of uninterrupted file transfer. The earlier preflight and
final independent audit fall outside that elapsed interval.

This report authorizes no production deployment or runtime promotion. No schema,
dependency, secret, binding, app version or cache change is part of the task.
