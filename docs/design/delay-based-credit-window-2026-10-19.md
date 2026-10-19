# Delay-based receipt window candidate

Status: experimental candidate for native qualification. It is not a release
record, not an exact-main candidate, and not evidence that any native gate
passes. Production remains App 8.11.20/cache v723 (`416f5ee4`). The branch
`agent/delay-based-credit-window` starts from the PR #410 head `6a5afaae`
(control isolation, App 8.11.22/cache v731 candidate identity) and replaces
only that head's A192 sender policy. The product version is deliberately
unchanged, so builds must be told apart by commit SHA. Runtime candidate:
`4b83ba14064f7efa76bb0042ad745f0f53ffdb07`.

## Why fixed and stepped windows stalled

Receipt credit admits a 64 KiB chunk only while earlier chunks are
unacknowledged. Throughput is therefore window / credit loop, where the loop is
send → bottleneck → receiver decode → receipt over the isolated control
association. Full chunks are receipted at once; the 20 ms batch applies only to
a partial tail. Every byte beyond the path's bandwidth-delay product (BDP) waits
in the bottleneck queue that control packets share.

With 100 ms each way, the BDP differs roughly fourfold between the two native
profiles: about 4 chunks at 8 Mbps and about 2 chunks at 2 Mbps (one 64 KiB chunk
alone is 65.5 ms at 8 Mbps and 262 ms at 2 Mbps). No single window fits both.
The isolation study already shows both sides of this:

- S256 (isolation + fixed 256 KiB) finished highRTT8 preload in 28.125 s versus
  B128's 72.566 s with a 153.4 ms sync-pong maximum, but failed slow2 because
  excess p95 rose by 432.3 ms. Its timing decomposition (send → receipt
  548.0 → 1,098.3 ms) is the 2 Mbps standing queue of the extra two chunks.
- SA192 passed every screen at about 40 s; its 192 KiB cap is below the 8 Mbps
  BDP, so it cannot fill that path.

The window should follow the measured path instead of a constant.

## Policy

All constants live in `src/network/transport/bulk-flow-control.ts`. The wire
format, receiver, 128 KiB floor, activation only after the isolated control
handoff, lifetime debt accounting and legacy behavior are unchanged from #410.
The controller schedules no timers.

| Rule | Value | Purpose |
| --- | --- | --- |
| Sample | age of each full, window-limited chunk: its send → its receipt | Credit loop including any queueing; app-limited and coalesced receipts never decide |
| Warmup | skip the first 128 KiB flight after activation/idle and everything sent before any window change | First flights queue behind themselves |
| Block | median of 5 samples | One jittered receipt cannot decide |
| Rate gate | grow only if `64 KiB × loop / window ≤ 250 ms` | Little's law: worst-case cost of one more chunk. 2 Mbps (≈274 ms) stays at 128 KiB, as SA192 did |
| Step | +64 KiB, cap 256 KiB | Credit is consumed in whole chunks |
| Accept | loop rise ≤ 50% of one chunk's delay and loop ≤ 128 KiB baseline + 60 ms | The added chunk mostly entered the pipe, not the queue |
| Reject | revert one chunk, hold 10 s, remember the failed window | |
| Re-probe | same window only after its loop improves by ¼ chunk-delay, or after 60 s | No periodic spikes on paths already full |
| Safety | one receipt > level + 200 ms → 128 KiB; two consecutive > level + 100 ms → −64 KiB; block > baseline + 100 ms → −64 KiB; then hold 10 s | Bandwidth collapse or drift |
| Idle | first send after > 1 s without debt relearns from 128 KiB (no hold) | Path may have changed |

The first flight after a growth step is judged by the probe median, not the
per-receipt safety, because the extra chunk queues behind its partner.

## Physical limit: sudden bandwidth collapse

Receipts for data already past the bottleneck keep arriving at the old rate for
about one feedback delay (~214 ms here), and the sender refills at that rate.
Any window that fills an 8 Mbps × 200 ms path therefore adds roughly
`(k − 1) × feedback delay` of transient queue when bandwidth suddenly drops by
`k`, regardless of detection logic; B128 avoids it only by never filling that
path. With a shared FIFO bottleneck, 25–28 s on highRTT8 and an unchanged
8→2 Mbps transient are mutually exclusive. `ADAPTIVE_MAX_BYTES` is the knob.

## Path model

`src/network/transport/__tests__/bulk-flow-control-delay-model.test.ts` drives
the real controller with a deterministic 1 ms model: one FIFO bottleneck,
100 ms forward and 114 ms receipt return delay, 23,040,044 bytes. It does not
model SCTP congestion control, delayed SACK, the startup acknowledgment race or
browser scheduling, which is why its B128 highRTT8 time (49.2 s) is much shorter
than native (72.5 s). Queue values are the wait of a control packet behind
queued bulk bytes, sampled every 10 ms.

| Profile | B128 | Candidate | Queue p95 | Queue max | Decisions |
| --- | ---: | ---: | ---: | ---: | --- |
| 8 Mbps | 49.2 s | 25.4 s | 59.5 → 63.5 ms | 131 → 131 ms | 192 at 1.1 s, 256 at 1.8 s, accepted 2.4 s |
| 2 Mbps | 92.4 s | 92.4 s | 298.7 → 298.7 ms | 524 → 524 ms | none (rate gate) |
| 4 Mbps | 60.8 s | 46.6 s | 122 → 177 ms | 262 → 311 ms | 192 kept; one failed 256 probe |
| 2.5 Mbps | 74.6 s | 74.6 s | 200 → 206 ms | 419 → 419 ms | one failed probe per minute |
| 50 Mbps / 5 ms | 3.7 s | 3.7 s | 11.5 → 11.7 ms | 21 → 21 ms | one rejected probe |
| 8 Mbps, 0–30 ms receipt jitter, 1% +120 ms | 52.4 s | 27.5 s | 60 → 74 ms | 131 → 172 ms | 256, no fallback |
| 8→2 Mbps at 8 s, back at 16 s | 53.0 s | 32.8 s | 229 → 277 ms | 455 → 827 ms | fallback 0.5 s after drop; 256 again at 20.1 s |
| 8→2 Mbps at 20 s | 68.0 s | 39.8 s | 290 → 293 ms | 452 → 835 ms | fallback 0.5 s after drop |

Cap comparison in the same model: 192 KiB gives 33.3 s at 8 Mbps and a
634 ms collapse maximum; 256 KiB 25.4 s and 835 ms; 320 KiB 25.4 s and 827 ms
(the probe to 320 KiB is rejected because 256 KiB already fills the path).

## Verification in this change

Linux container, Node 24.20.0 / npm 11.19.0, shallow clone. Not the release
runtime environment and not native evidence.

- Focused: controller unit tests 36/36, path model 6/6, isolation adapter 16/16.
- Full unit suite: 595 files, 13,354 passed, 1 skipped (the Windows-only
  drive-path check), 3 failed in `release-worker-floor-state.test.ts` because
  the clone was shallow. The same 3 fail on the unmodified #410 head in that
  clone; after `git fetch --unshallow` the file passes 26/26.
- `npm run build:checked` passes with full history (its cache-version guard
  refuses shallow history).
- `tsc --noEmit`, `tsc -p tsconfig.test.json`, ESLint and Prettier on changed
  files, and source guards (complexity, dead exports, chunk pump, Standard hot
  path, import graph, brand capitalization, lifecycle writes) pass.
- Not run: the native shaped harness, Playwright (its E2E transport is PeerJS
  and never reaches this controller), physical devices, audible sync, live
  providers.

## Native qualification to run

Compare this branch with #410's SA192 and same-main B128, both orders, using
the existing frozen budgets: highRTT8 ordinary and preload, slow2, dynamic
8→2→8, initially shaped highRTT8, two mixed receivers and the shared host
uplink. Read `bulkFlowControl.diagnosticSnapshot` (`windowBytes`,
`lastDecision`, `baseAgeMs`, `referenceAgeMs`, `failedProbe`) beside the
existing route/credit ledgers. Expected from the model and prior evidence:
highRTT8 near S256's 28 s, slow2 unchanged from 128 KiB, and a dynamic
collapse maximum above SA192's; if the dynamic budget must hold, rerun with
`ADAPTIVE_MAX_BYTES = 192 * 1024` to isolate the faster ramp from the larger
cap. A drop that coincides with a probe can delay regrowth up to 60 s through
the failed-probe memory.

A first container-native comparison (Chromium 141, userspace bottleneck) is
recorded in [native-shaped-credit-ab-2026-10-19.md](native-shaped-credit-ab-2026-10-19.md);
it does not replace the team's frozen native runs.

The release record is unchanged: this branch changes no release scope until a
native run qualifies it.
