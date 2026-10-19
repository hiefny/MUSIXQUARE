# Delay-based receipt window candidate

Status: experimental candidate for native qualification. It is not a release
record, not an exact-main candidate, and not evidence that any native gate
passes. Production remains App 8.11.20/cache v723 (`416f5ee4`). The branch
`agent/delay-based-credit-window` starts from the PR #410 head `6a5afaae`
(control isolation, App 8.11.22/cache v731 candidate identity) and replaces
only that head's A192 sender policy. The product version is deliberately
unchanged, so builds must be told apart by commit SHA. Original runtime
candidate: `4b83ba14064f7efa76bb0042ad745f0f53ffdb07`. The
[evidence-freshness hardening](#evidence-freshness) on branch
`claude/db-credit-safety-c309eb` is runtime
`efec5a8981cdc221d56a5ce24de3f213a6360131`; it is prepared for the combined
Standard-room native round and is not native evidence either.

## Why fixed and stepped windows stalled

Receipt credit admits a 64 KiB chunk only while earlier chunks are
unacknowledged. Throughput is therefore window / credit loop, where the loop is
send → bottleneck → receiver decode → receipt over the isolated control
association. Full chunks are receipted at once; the 20 ms batch applies only to
a partial tail. With a single shared FIFO bottleneck, every byte beyond the
path's bandwidth-delay product (BDP) waits in the queue that control packets
share.

With 100 ms each way, the BDP differs roughly fourfold between the two native
profiles: about 4 chunks at 8 Mbps and about 2 chunks at 2 Mbps (one 64 KiB chunk
alone is 65.5 ms at 8 Mbps and 262 ms at 2 Mbps). No single window fits both.
The isolation study already shows both sides of this:

- S256 (isolation + fixed 256 KiB) finished highRTT8 preload in 28.125 s versus
  B128's 72.566 s with a 153.4 ms sync-pong maximum, but failed slow2 because
  excess p95 rose by 432.3 ms. Its timing decomposition (send → receipt
  548.0 → 1,098.3 ms) matches the 2 Mbps standing queue of the extra two chunks.
- SA192 passed every screen at about 40 s; its 192 KiB cap is below the 8 Mbps
  BDP, so it cannot fill that path.

The window should follow the measured path instead of a constant.

## Policy

All constants live in `src/network/transport/bulk-flow-control.ts`. The wire
format, receiver, 128 KiB floor, activation only after the isolated control
handoff, lifetime debt accounting and legacy behavior are unchanged from #410.
The controller schedules no timers; every rule runs on a send or receipt event.
The arithmetic below reasons about one shared FIFO bottleneck with a fixed
feedback delay. Its estimates are not worst-case bounds for SCTP, browsers or
real links.

| Rule | Value | Purpose |
| --- | --- | --- |
| Sample | age of each full, window-limited chunk: its send → its receipt | Credit loop including any queueing; app-limited and coalesced receipts never decide |
| Warmup | skip the first 128 KiB flight after activation/idle and everything sent before any window change | First flights queue behind themselves |
| Block | median of 5 samples | One jittered receipt cannot decide |
| Rate gate | grow only if `64 KiB × loop / window ≤ 250 ms` | Little's-law estimate, from the last median, of the queueing one more chunk would add on an already full FIFO path; not a worst-case bound. 2 Mbps (estimate ≈274 ms) stays at 128 KiB, as SA192 did |
| Step | +64 KiB, cap 256 KiB | Credit is consumed in whole chunks. `ADAPTIVE_MAX_BYTES` is the only cap constant |
| Accept | loop rise ≤ 50% of one chunk's estimated delay and loop ≤ 128 KiB baseline + 60 ms | The added chunk mostly entered the pipe, not the queue |
| Reject | revert one chunk, hold 10 s, remember the failed window | |
| Re-probe | same window only after its loop improves by ¼ chunk-delay, or after 60 s | No periodic spikes on paths already full |
| Safety | one receipt > level + 200 ms → 128 KiB; two consecutive > level + 100 ms → −64 KiB; block > baseline + 100 ms → −64 KiB; then hold 10 s | Bandwidth collapse or drift |
| Evidence | above 128 KiB: newest sample at most 2 s old and at most 16 chunks (1 MiB) of credit released since it or the last window change; else 128 KiB, no hold, no probe memory | A larger window never outlives its evidence |
| Idle | first send after > 1 s without debt relearns from 128 KiB (no hold) | Path may have changed |

The first flight after a growth step is judged by the probe median, not the
per-receipt safety, because the extra chunk queues behind its partner. The
evidence rule still bounds that flight in time.

## Evidence freshness

Review of `a85831d4` found that after growth, receipts that are not samples
(app-limited, partial tail, coalesced, untracked or warmup) still release
credit, and the A192 phase watchdog was gone, so a window above 128 KiB could
outlive its evidence indefinitely. Current receivers send one receipt per full
chunk, so this was not an observed continuous-transfer failure. The path model
reproduces it with a receiver that acknowledges two chunks per receipt from 8 s
to 16 s: before this change the window stayed at 256 KiB through all 8 s
without a single sample.

The hardening adds one rule to `AdaptiveCreditController`
(`ADAPTIVE_EVIDENCE_MS = 2000`, `ADAPTIVE_EVIDENCE_BYTES = 16 × 64 KiB`):

- Evidence is what the block decisions already use: a full, tracked,
  current-epoch, post-warmup chunk sent window-limited and acknowledged by
  exactly one receipt. Such a sample counts whatever its age; a long age is for
  the safety and probe rules to judge. Timed app-limited receipts still feed the
  per-receipt safety but do not refresh evidence.
- The bound restarts at each such sample and at each window change (growth,
  shrink, hold, fallback, activation, idle reset).
- Above 128 KiB, every send and receipt checks it: more than 2,000 ms since the
  restart is `evidence-stale`; more than 16 chunks of released credit is
  `evidence-sparse`. Either returns the window to 128 KiB in `measure`, clears
  the base and reference loops, and treats everything already sent as warmup.
- Missing evidence is not a measured failure: no hold starts, no failed probe
  is recorded, an existing hold or failed-probe memory is left as it was, and
  regrowth needs a fresh 128 KiB block of five samples.
- A receipt is checked before its released credit wakes the sender. A send is
  checked when it is recorded, after its own admission.
- Diagnostics add `evidenceAtMs` and `releasedSinceEvidenceBytes`. Lifetime debt,
  wire format, receiver, activation and the 128 KiB floor are unchanged, and no
  timer is added. The two constants do not depend on `ADAPTIVE_MAX_BYTES`, so a
  192 KiB variant still changes one line.

New pins in `bulk-flow-control-adaptive.test.ts`: the 2 s edge with on-time
app-limited receipts (kept at exactly 2,000 ms, shed at 2,001 ms); 16 coalesced
chunks kept and 18 shed, with no regrowth while receipts stay coalesced; 420
window-limited chunks across 20 file tails without a shed; a burst after an
app-limited trickle limited to 128 KiB; expiry with no event admitting exactly
one chunk, with unchanged lifetime debt as late receipts drain it; a drop that
coincides with the 192 KiB probe (`loop-spike`, failed probe kept, no re-probe
until the 60 s memory expires); a drop that stalls the probe's receipts beyond
2 s (`evidence-stale`, no hold or probe memory); receipts after deactivation
releasing debt without touching evidence, and reactivation restarting it. The
path model now also requires every window-limited profile to stay within half
of each bound and to make no `evidence-*` decision.

Limits:

- 2 s and 16 chunks are chosen, not derived. In the repository path model the
  newest sample was never older than 632 ms or more than 3 released chunks while
  above 128 KiB: under a third of the time bound and a fifth of the byte bound.
  Native SCTP, browser scheduling or a sender with a long main-thread stall may
  use more of the margin; a shed then costs a relearn of about 2 s at a smaller
  window at 8 Mbps, not safety.
- Earning the window again can be slower than keeping it. In the paired-receipt
  profile the transfer took 34.2 s against 27.0 s before the hardening, because
  the window shed at 9.6 s and the 256 KiB probe after recovery was rejected.
- A sender that is app-limited at the larger window but window-limited at
  128 KiB oscillates: it relearns, probes, and sheds again after the bound. The
  extra credit is unused during that time, so this costs little throughput and
  no queue.
- Evidence can expire with no send or receipt at all. The next send then uses
  the old window for that one chunk before its check sheds it (pinned); a
  receipt arriving first sheds before any reuse.
- A drop that coincides with a probe but keeps receipts within 2 s is still
  judged by the probe or the per-receipt safety and keeps the 60 s failed-probe
  memory, so regrowth after a quick recovery can wait up to 60 s. That behavior
  is unchanged and now pinned.
- A scratch extension of the same model, outside the repository, also checked
  producers: one chunk every 300 ms at 8 Mbps shed `evidence-stale` 2 s after the
  last sample and accepted 256 KiB again 2.2 s after the trickle ended (33.7 s,
  previously 33.1 s; queue maximum 131 ms, previously 197 ms); with a slower
  trickle and an 8→2 Mbps drop during it, both runtimes met the following burst
  at 128 KiB; 0.9 s producer pauses every 2 s caused no `evidence-*` decision
  (largest gap 1,161 ms). Those pauses do trigger the existing per-receipt
  `loop-increase` shed after each burst (256→192 KiB, 10 s hold), because a burst
  from an empty pipe queues behind itself; this change does not alter that.

## Model limit: sudden bandwidth collapse

In the single-FIFO model with a fixed feedback delay, receipts for data already
past the bottleneck keep arriving at the old rate for about one feedback delay
(~214 ms here), and the sender refills at that rate. In that model, any window
that fills an 8 Mbps × 200 ms path adds roughly `(k − 1) × feedback delay` of
transient queue when bandwidth suddenly drops by `k`, regardless of detection
logic, and B128 avoids it only by never filling that path. So, within the model,
25–28 s on highRTT8 and an unchanged 8→2 Mbps transient are mutually exclusive.
This is a property of the model, not a proven limit of SCTP, browsers, shapers
or real links. The container-native A/B observed a transient of the predicted
size, which is consistent with the model but does not prove the general claim.
`ADAPTIVE_MAX_BYTES` is the knob.

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
| 8 Mbps, receipts in pairs 8–16 s | 50.8 s | 34.2 s | 63.5 → 84.1 ms | 131 → 131 ms | `evidence-sparse` at 9.6 s; 192 at 16.9 s; 256 probe rejected at 18.3 s, 192 kept |

The hardening leaves every earlier row unchanged: identical decisions, times
and queue values. The paired-receipt row is new; before the hardening that
profile kept 256 KiB throughout and finished in 27.0 s (queue p95 106.1 ms).

Cap comparison in the same model: 192 KiB gives 33.3 s at 8 Mbps and a
634 ms collapse maximum; 256 KiB 25.4 s and 835 ms; 320 KiB 25.4 s and 827 ms
(the probe to 320 KiB is rejected because 256 KiB already fills the path).

## Verification

### Evidence-freshness hardening

Windows 11 Pro, Node 24.20.0 (official build, SHA-256 checked) with npm 12.0.2
through Corepack, as pinned by `.node-version` and `packageManager`; a full
clone. Runtime `efec5a8981cdc221d56a5ce24de3f213a6360131`. Not native evidence.

- Focused: controller unit tests 44/44 (8 new), path model 7/7 (1 new; five
  existing profiles now also check the evidence margin), isolation adapter
  16/16, and the other two bulk-flow files 11/11 and 11/11.
- Mutation check: disabling the time bound, the byte bound, the send-side check
  or the restart on window change each makes at least one new pin fail.
- Full unit suite: 595 files, 13,367 passed, 0 failed, 0 skipped with
  `--maxWorkers=6` (300 s). With the default worker count on this shared
  20-thread machine, while two other sessions were busy, the same commit ended
  with 13,363 passed and 4 failures outside transport: three load timeouts and
  one real-clock per-minute rate-guard test. Those 4 files then passed alone,
  420/420.
- `npm run typecheck`, `npm run lint` and `npm run format:check` pass.
- `npm run build:checked` refuses at `guard:sw-cache-version`: committed runtime
  changes to `bulk-flow-control.ts` are newer than the v731 bump at `6a5afaae`.
  The refusal already holds at this branch's base `6bd28c50` because of
  `4b83ba14`; the version and cache bump are left to the integration, which
  bumps once. Run one by one, every other `build:checked` step passes,
  including the production build.
- Not run: the native shaped harness or any timed measurement (the combined
  round runs later and serially), Playwright, physical devices, audible sync
  and live providers.

### Original candidate

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
`lastDecision`, `baseAgeMs`, `referenceAgeMs`, `failedProbe`, `evidenceAtMs`,
`releasedSinceEvidenceBytes`) beside the existing route/credit ledgers.
Expected from the model and prior evidence: highRTT8 near S256's 28 s, slow2
unchanged from 128 KiB, and a dynamic collapse maximum above SA192's; if the
dynamic budget must hold, rerun with `ADAPTIVE_MAX_BYTES = 192 * 1024` to
isolate the faster ramp from the larger cap. A drop that coincides with a probe
can delay regrowth up to 60 s through the failed-probe memory.

For the evidence rule, the combined round should also show:

- no `evidence-stale` or `evidence-sparse` during steady highRTT8 ordinary and
  preload transfers, and the same 256 KiB ramp as before;
- the 8→2→8 collapse handled by the `loop-*` rules, not by evidence, with
  regrowth after recovery;
- preload starting, pausing and stopping around playback, including local-file
  playback during preload: which of `producer-idle`, `evidence-stale` and
  `loop-increase` occur, with zero unwanted sync corrections;
- consecutive files and a concurrent direct transfer with preload, whose tails
  must not cause `evidence-sparse`;
- the shared host uplink and mixed receivers, each connection deciding alone.

A first container-native comparison (Chromium 141, userspace bottleneck) is
recorded in [native-shaped-credit-ab-2026-10-19.md](native-shaped-credit-ab-2026-10-19.md);
it ran the original runtime `4b83ba14`, not the hardening, and does not replace
the team's frozen native runs.

The release record is unchanged: this branch changes no release scope until a
native run qualifies it.
