# Receiver credit windows: ordinary files and preload (2026-10-18)

Recommendation: retain the deployed **64 KiB local threshold + 128 KiB receiver
window** as the fixed default. Larger windows substantially shortened high-RTT
transfers, but all three failed playback preservation in both slow-link preload
passes. They did not shorten the slow-link transfer. This is a choice under the
tested workloads and conservative selection preferences, not a universal optimum.

## Scope and source identity

The owner requested a comparison, keeping the local next-send threshold at
64 KiB and varying receiver-confirmed outstanding payload between 128, 256,
384 and 512 KiB. This report records a local experiment, not a runtime change
or production release. App 8.11.20/cache v723 remains deployed with a 128 KiB
receiver window.

- Archived source: `707e9b21491ed56b4ef650080080f8afe66df1ce`.
- Runtime ancestor: `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3`, PR #399.
- Each of four independent source archives changes only `WINDOW_BYTES` in
  `src/network/transport/bulk-flow-control.ts`; the 128 KiB source patch is empty.
- The 64 KiB local buffered-amount threshold, 64 KiB chunks, 64 KiB receipt
  batch and 20 ms receipt delay remain identical. The window is unacknowledged
  payload credit, not a chunk size, rate limit, or total network queue bound.
- Actual product signaling, native RTC, transfer/storage and READY/preload ACK
  paths run on one Windows PC. The YouTube provider is controlled and advancing;
  Android policy is exercised through browser configuration, not a physical
  Android audio device or live YouTube.

Environment: Windows 11 Pro 10.0.26200 x64, Intel i7-13800H (20 logical
processors), Node 24.13.1, Playwright 1.63.0 and Chromium headless shell
153.0.8010.12 (revision 1243). `env.json` records the installed and queried
browser version after measurement; this is not the release workflow's Node
environment or a Linux benchmark.

Scratch evidence is retained under
`scratch/receiver-credit-window-sweep-2026-10-18/`. The runner hash is
`6a1e5f7bd3f01ebb6874d757923aa244c1ace2594a68005deffbe2ff69fa3993`;
the frozen matrix hash is
`085bb1c004f0a799b9ea1032dc5f8a52d1972d01fefe1f2dd600f62c6e39a3d2`.
Source and build manifests verify all four variants. Every browser checks the
served/loaded lazy peer module against its manifest, avoiding accidental reuse
of another window's build.

The final `evidence-manifest.json` freezes 174 primary evidence files totaling
729,116,256 bytes. Its SHA-256 is
`9d468854e1b7b129e3d8a8b466208f642bf73b6dfa7757eacb8e8d43e6269ad2`.
It covers raw events, execution logs, harness/configuration, frozen plans,
source/build manifests and environment data. Independent audit summaries are
separate derived evidence, not silently added to this frozen manifest.

## Frozen comparison protocol

The primary matrix contains 48 fresh rooms: four windows × ordinary transfer
or preload × three profiles × two passes. The second pass reverses both block
and window order. Network shaping affects native RTC traffic while leaving
HTTP/WebSocket signaling unshaped; configured loss and reordering are zero.

| Profile | Receivers | Shaping |
| --- | --- | --- |
| direct8 | 8 | No artificial bandwidth/latency limit |
| slow2 | 3 | Receiver 3: 2 Mbps, 100 ms in each direction |
| highrtt8 | 3 | Receiver 3: 8 Mbps, 100 ms in each direction |

The file is 23,040,044 bytes / 352 chunks, SHA-256
`5749688e4e6306234de4add49e9191c5e8974e4d60de48671c4bd57dca4db83d`.
The WAV duration is 120 seconds; the controlled YouTube duration is 300 seconds.
Ordinary transfers must finish within a 110-second observation ceiling;
preload has 130 seconds. These limits avoid mistaking natural EOF for a
transfer-induced interruption. Every case has an 18-second no-file baseline
after warmup and shaping, then a uniform three-second completion tail and a
bounded control-message drain.

Controls are matched by unchanged native wire payload, peer, direction and
message type. Application latency excludes private `mxqr-bulk-flow` frames.
The scored interval starts at each peer's first bulk send and ends at its last
bulk receive; controls sent inside it count even if received later. Idle
post-completion samples do not dilute the results. Baseline and transfer
latency are compared only for the same peer/direction/type with at least six
baseline deliveries. RTT/2 is not subtracted from one-way measurements.
The p95 of fewer than 20 samples is descriptive, not a selection criterion.

Completion is measured from first bulk send to last bulk receive, separately
from join, readiness, tail and hashing. Finalized Blob SHA, product READY/ACK,
ordered chunks, live connection nonce and cumulative sender/receiver/ACK
counters must agree. Credit must remain within each configured window. SHA
calculation happens after timing probes stop. CDP task duration, event-loop
lag, estimated heap and endpoint RTC statistics are secondary diagnostics;
they are not mobile-device or whole-OS CPU measurements.

Before results, the selection preferences were fixed as: all functional
gates pass; relative to 128 KiB, per-type excess p95 increase at most 100 ms,
excess maximum increase at most 250 ms, and raw application maximum at most
one second; at least 20% faster high-RTT completion in each workload/pass,
with no more than 10% regression elsewhere. Among eligible alternatives,
choose the smallest within 10% of the fastest in every high-RTT cell. These
are conservative experiment preferences, not product SLOs or audible limits.
No eligible alternative means retain 128 KiB, not declare a universal optimum.

## Execution deviations retained as evidence

The first preflight failed before transfer: the `tsx` launch path inserted
an unavailable `__name` helper into browser evaluation. Native Node TypeScript
execution removed that harness issue without changing the frozen runner.
Both preflights are retained; neither is part of the comparison matrix.

Two independent raw-analysis reads overlapped the first direct8 ordinary
block, one of them at 03:04:26.2–26.9 UTC. Their exact CPU influence is not
known. The original four cases remain exploratory evidence; an additional
clean four-window block after the original 48 supplies the formal first-pass
direct8 ordinary comparison. This makes 52 comparison executions. No result
was repeated merely for being unfavorable. Subsequent heavy parsing/builds
were deferred until measurement completion.

Candidate playback interruptions remain failures. Once the first interruption
was traced to the existing automatic realignment path, remaining conditions
were allowed to continue only when that same failure was the sole failed gate.
File integrity, connection, credit or an unclassified failure still required
stopping for diagnosis. No playback assertion was removed or changed to pass.

## Results

All 52 comparison executions completed: **46 pass / 6 fail / 0 skip**, with
**256/256 final files** passing SHA, ordered payload, product ACK and credit
checks. The formal 48-case set is 42 pass / 6 fail; the four superseded first
block cases also passed and remain exploratory evidence. Every failure was
playback preservation on receiver 3 of slow2/preload at 256, 384 or 512 KiB,
once in each pass. None was reclassified as a pass because its file arrived.
An independent native-event audit found no discrepancy in these counts,
connection ledgers or file receipts. It cross-checked the browser-computed Blob
SHA against the fixture; raw JSON does not contain the final Blob bytes for a
second independent hash calculation.

Each completion below is the slowest recipient's first-bulk-send to final-bulk-
receive interval. The ranges retain the two passes rather than averaging them.

| Receiver window | High-RTT ordinary completion | High-RTT preload completion | 2 Mbps completion, both workloads | Slow-link preload preservation |
| --- | --- | --- | --- | --- |
| 128 KiB | 64.754–65.428 s | 65.038–65.340 s | 97.244–97.312 s | Pass 2/2 |
| 256 KiB | 27.229–27.312 s | 27.138–27.400 s | 97.216–97.321 s | Fail 2/2 |
| 384 KiB | 25.361–25.404 s | 25.382–25.406 s | 97.244–97.337 s | Fail 2/2 |
| 512 KiB | 25.269–25.278 s | 25.337–25.395 s | 97.229–97.356 s | Fail 2/2 |

The largest application-message delivery times on the 2 Mbps profile were:

| Window | Ordinary down, pass 1 / 2 | Preload down, pass 1 / 2 | Maximum up across both workloads/passes |
| --- | --- | --- | --- |
| 128 KiB | 440 / 432 ms | 728 / 736 ms | 129 ms |
| 256 KiB | 979 / 981 ms | 979 / 984 ms | 122 ms |
| 384 KiB | 1,544 / 1,534 ms | 1,537 / 1,533 ms | 128 ms |
| 512 KiB | 2,082 / 2,086 ms | 2,081 / 2,088 ms | 125 ms |

These are maxima across **application control types**, not exclusively YouTube
heartbeats and not an audible synchronization error. Their per-type no-file
baselines and small-sample limits are retained for the independent audit.

In high-RTT preload, the roughly 711–728 ms application maxima were one early
`sync-pong` frame in each run, not sustained YouTube heartbeat delay. The wire
evidence does not establish a specific SCTP, OS or shaper cause. YouTube
heartbeat maxima across the two passes were 235–273 / 176–245 /
287–299 / 426–431 ms for 128 / 256 / 384 / 512 KiB. The independent audit
re-paired native frames and recomputed latency, credit and CPU statistics with
**zero discrepancies** against the raw records and runner summaries. All 560
recurring sync groups in the formal matrix had at least six baseline samples;
24 one-off preload-ACK groups had no baseline and retain raw maxima only.
Only 74 of 584 peer/type/direction groups reached 20 transfer samples, so most
p95 values do not qualify for the selection rule.

Eight unshaped recipients also showed no consistent throughput benefit:

| Window | Ordinary pass 1 (clean) / pass 2 | Preload pass 1 / pass 2 |
| --- | --- | --- |
| 128 KiB | 8.356 / 8.529 s | 7.905 / 7.940 s |
| 256 KiB | 8.461 / 8.509 s | 7.672 / 7.943 s |
| 384 KiB | 9.511 / 8.308 s | 7.821 / 7.758 s |
| 512 KiB | 8.430 / 8.289 s | 7.914 / 8.130 s |

The 9.511-second clean 384 KiB result is retained: it is 13.8% slower than the
matching 128 KiB run, exceeding the preregistered 10% preference. It was not
repeated to replace an unfavorable value. The original potentially confounded
ordinary pass-1 completion values were 8.496 / 8.421 / 8.299 / 8.270 seconds
for 128 / 256 / 384 / 512 KiB; they do not replace the clean values above.

High-RTT throughput alone favors 256 KiB as the smaller useful increase: it
captures most of the improvement, while 384/512 shave roughly another two
seconds. However, **no larger fixed window passes the functional gate across
profiles**. Retaining 128 KiB does not resolve its approximately 65-second
high-RTT wait. A conditional/adaptive policy is not implemented or validated by
these measurements; RTT alone cannot distinguish these two bandwidth profiles.

The comparison must not collapse bandwidth and RTT into a single notion of
"slow network." Both shaped profiles use the same configured propagation delay,
but 2 Mbps can drain much less outstanding data than 8 Mbps. A larger window
can keep the latter link occupied while acknowledgements travel; on the former,
it can add waiting data without shortening the bandwidth-bound transfer.
This is why a high-RTT-only throughput winner is not automatically a suitable
fixed default for every receiver.

Nor does receiver count multiply a single shared room credit limit: credit is
per connection. The eight direct recipients permit at most 1/2/3/4 MiB of
aggregate unacknowledged payload at the four candidate windows, respectively.
This is a ledger bound, not a browser-memory estimate. Larger windows do not
increase the receipt batch frequency per transferred byte; their higher
throughput can increase receipt arrival rate per second.

An additional room-wide interval, including the time after fast receivers
finished while the slow receiver continued, found fast-receiver application
maxima of 19 / 24 / 34 / 18 ms for the four windows. Thus these runs did not
show the slow receiver's second-scale delays spreading to the other recipients.
This supplemental view does not replace the fixed per-peer scoring interval or
establish behavior on a shared physical Wi-Fi radio.

CPU diagnostics also require the duration distinction: in high-RTT preload,
128 KiB used 3.306–3.390 host main-thread CPU seconds, or 0.047–0.048 CPU seconds
per observed second. At 384 KiB those values were 1.697–1.740 total and
0.056–0.058 per observed second. A shorter transfer reduced total observed CPU
while increasing its rate. Background player/timer/probe work is included;
this is not a measurement of pure ACK processing cost. Host, worst-recipient
and aggregate values for every case remain in `analysis-audit.json` and
`analysis-audit-cpu.csv`; `analysis-audit-groups.csv` retains per-type latency.

## Candidate interruption: queue-biased clock and automatic realignment

The first failing case was pass 1 / slow2 / preload / 256 KiB. All three
recipients completed the file and its SHA, ordered chunks, final ACK and credit
checks. Receiver 3 alone failed playback preservation: approximately 68.973
seconds after measurement start (67.954 seconds after that receiver's first
bulk send), `pauseVideo` and `seekTo` were followed by `playVideo`
1,259 ms later. The video/queue identity remained unchanged, no channel closed,
and the controlled 300-second video had not ended. Guest event-loop lag peaked
at 17.2 ms, which does not explain that pause.

The immediately preceding nonmanual YouTube heartbeat arrived 783 ms after its
host send. Before the action, the controlled player's 97.0355-second position
agreed with the same-PC wall-clock reference plus the existing Android output
advance. Replaying unchanged native PING/PONG frames through the shared-clock
selection explains the apparent drift:

1. The clock keeps at most 60 samples. Its last good low-RTT samples aged out
   by **count**, not the separate two-minute age limit.
2. Around measurement +61.001 s, selection moved to RTT 367 ms / offset −82.5 ms;
   around +63.205 s, to RTT 815 ms / offset −302.5 ms.
3. Two subsequent heartbeats therefore appeared roughly 302 ms ahead against
   the estimated clock. The existing 150 ms / two-confirmation automatic
   realignment policy admitted a precision rendezvous on the second heartbeat.
4. That rendezvous produced the observed pause → seek → play sequence. Its
   seek target and pause duration agree with the existing scheduling margin.

The source paths are `src/network/shared-clock.ts` (sample capacity/min-RTT
selection) and `src/youtube/sync.ts` (small-drift confirmation/rendezvous).
`failure-case14-clock-reconstruction.json` retains the reconstruction. Native
receive stamps precede the actual handler by approximately 0–2 ms, so this is
an approximate reconstruction, not a captured internal offset getter.

This identifies a failure of the **256 KiB experimental candidate** under the
controlled workload. It does not establish that deployed 128 KiB clients or
the owner's physical Android incident followed that same path. Increasing
credit can enlarge the queue asymmetry that the existing clock/automatic
correction policy sees; the file-transfer protocol itself still met integrity
and credit invariants. Keeping those two findings separate is essential.

## Lifecycle and verification limits

The actual controller and codec were separately exercised at all four window
boundaries with an EventTarget channel adapter: saturation, shared ordinary/
preload credit, control/end messages, cancellation debt, replacement connection,
malformed/stale/non-monotone receipts and final partial-chunk handling. That
adapter is not a native RTC end-to-end test. All four parameter rows passed
their eight recorded boundary checks (32 checks in total). The probe
uses source SHA `707e9b21`; its script SHA-256 is
`3be16c251bb74f8f68c7d7f34741ad070112275907a11c8ae5316906576189d1`.

The selected incumbent 128 KiB then passed two separate actual-product native
RTC scenarios with three receivers: cancel → re-add and preload → active-file
promotion, including the shaped slow receiver. All six additional final files
passed SHA/ACK/credit checks. Cancellation kept outstanding credit accounting;
promotion handed the transfer to active playback without granting a second
window. In the native cancellation scenario, the remaining old credit drained
before the replacement began; simultaneous outstanding old/new payload is
covered by the controller adapter, not claimed for that native case. These
six files are separate from the 256 comparison files. The
successful preflight's eight files are likewise separate.

The independent integrity/lifecycle audit cross-checked all 262 comparison and
lifecycle file receipts. Its script and results are retained as
`independent-integrity-lifecycle-audit.{py,json,md}`. Together with
`analysis-audit.{mjs,json,md}`, these derived audits preserve the calculation
paths as well as the conclusions. Experiment-owned servers on ports
4390–4393 and 8800 were stopped after measurement; raw evidence remains local.

No full unit/E2E suite, production release, remote CI benchmark, live YouTube,
physical Android, audible synchronization, TURN, packet loss, radio contention,
or more than eight direct recipients is claimed by this sweep. A repeated
single-PC controlled experiment does not establish a universal latency bound
or identify every cause of the owner's original real-device report.
