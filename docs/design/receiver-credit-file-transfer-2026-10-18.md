# Receiver-confirmed flow control for direct file transfers

- Date: 2026-10-18 KST.
- Status: deployed successfully; local, PR, exact-main and production checks complete. Physical-device and throughput limits remain explicit below.
- Baseline: `d09e0d00fe72712ca3a2a4a5963378e032757d3b` (runtime `eea5a842`).
- Repaired runtime: `fd1ce373aca8c0c9b56cd7e41335512ccb7818e0`.
- Release main: `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3` (PR #399).
- Owner instruction: apply the 64 KiB local threshold to ordinary file sends,
  add receiver-confirmed flow control to ordinary sends and preload, test both,
  and deploy only if the comparison demonstrates a clear improvement.
- Related: [prior native experiment](preload-control-queue-root-cause-2026-10-18.md),
  [previous preload release](preload-capacity-validation-2026-10-18.md),
  [current production record](../release-record.md).

## Contract and scope

All four standard-room direct send paths (current file and speculative preload,
broadcast and unicast/resume) use a 64 KiB local `bufferedAmount` threshold.
This is a next-send threshold, not a limit on every browser/OS/network queue.
Chunk size stays 64 KiB. The Cloudflare RTC adapter additionally limits the sum
of sent but unconfirmed FILE_CHUNK/PRELOAD_CHUNK payload to 128 KiB per exact
DataConnection. Existing JSON/binary frame headers are outside the payload cap.

Both file lanes share this credit. Cancelling a transfer, changing a queue item,
resuming a suffix, or promoting preload does not erase already-sent bytes.
Only receipts from that exact connection release its credit. Replacing the
connection creates new counters and a new nonce. No chunk copies or file-attempt
registries are retained by the credit controller.

The transport-owned control frame is `mxqr-bulk-flow`, version 1:

- `hello`: `{ type, version, kind: 'hello', nonce }`, a random 32-hex nonce.
- `receipt`: `{ type, version, kind: 'receipt', nonce, receivedBytes }`, cumulative
  payload bytes with the sender's nonce echoed back.

The frames are consumed inside the adapter, on the exact control channel, before
application protocol dispatch. Unknown versions, extra fields, invalid integers,
wrong nonces, replay/regression and receipts beyond bytes actually sent are
ignored. Repeated hello cannot reset the connection or create a response loop.
This is flow control between authenticated endpoints, not proof of durable storage
or a defense against a recipient lying about its own received bytes.

Receipt accounting runs after successful bulk decoding and before app dispatch.
Consequently a cancelled/stale chunk the app intentionally discards still releases
network credit. FILE_END/PRELOAD_END stay on the ordered bulk lane; the existing
PRELOAD_ACK and file readiness checks are unchanged. Network receipt must never
be treated as a playable, verified or persisted file.

The controller reports every 64 KiB of newly received payload and flushes a small
tail after at most 20 ms of available JavaScript execution. There is at most one
receipt timer per connection, no per-packet timeout, and no room-wide ACK barrier.
For the normal full-size chunks this is one small cumulative receipt per chunk;
small pieces can be coalesced. Device suspension can delay timers.

The optional transport capacity port lets the shared storage waiter combine local
drain and remote receipt events. Bounded polling still observes owner cancellation.
Every sender rechecks capacity synchronously after awaits and immediately before
send; the adapter also rejects a credited send that exceeds its window. One read
per peer is retained while waiting. Existing current-file priority over speculative
preload and per-peer stall/cancellation ownership remain in force.

## Compatibility and boundaries

Hello is activated only after the application has completed its ordered join
bootstrap, before its playback/file bootstrap events. The guest has successfully
sent APPLIED and the host has accepted APPLIED and completed queue catch-up.
The same ordered control channel prevents the new frame from overtaking those
legacy bootstrap frames. RTC open alone never sends the new hello. A remote
hello received before local activation is retained without sending a reply.
During a bounded 1-second negotiation grace starting at activation, the first
128 KiB can be sent. An older peer that does not
advertise support then uses the local 64 KiB threshold alone. Lifetime counters
include this grace/fallback interval: a late valid hello activates the window
without pretending that previously sent bytes were received. A negotiated peer
never silently falls back when receipts stop; existing sender stall/recovery paths
own that failure. Old senders remain readable by new receivers.

If the native control send for hello/receipt throws, the exact connection is
retired and the existing reconnect/recovery path takes over. Merely cancelling
the current file would leave lifetime debt behind and could block every later
attempt. RTC open has already occurred before activation. Activation failure
closes the connection and suppresses subsequent application join-success and
playback/file bootstrap events. No decoded-data event is emitted after closure.

The new frame is additive and requires no Worker protocol, binding, schema, secret,
permission or dependency update. Non-Cloudflare transports without the optional
port use the existing local-capacity behavior. PRO private-R2 and standard remote
HTTP/R2 delivery are outside this RTC change. Operator-upload chunks and audio
media are outside the credited FILE/PRELOAD payload types.

Product direct delivery currently caps direct recipients at eight and routes
additional eligible peers through its existing R2 policy. A 100-controller unit
stress test therefore does not mean a 100-device product download test. No claim
is made about physical Android audio, the original wireless incident, or a global
latency bound. A fixed outstanding window can limit throughput on a high-bandwidth,
high-RTT path; comparison must report completion time as well as control latency.

## Validation evidence

Windows / Node 24.20.0 initial implementation validation:

- Full typecheck, lint, formatting and production `build:checked`: passed.
- Existing shared waiter/pump/priority tests: 65 passed; new storage credit
  lifecycle tests: 20 passed before the final concurrent-credit pin.
- Adapter/controller tests: 205 passed before the internal-send-failure repair;
  its focused post-repair tests: 21 passed. These intermediate results are
  superseded by the final full-suite results below.
- The initial full-unit attempt was interrupted after identifying an obsolete
  capture/replay fixture: it awaited four chunks before creating its receiver,
  without advancing fake time through the new legacy negotiation grace. This
  cannot receive credit and is not a live-peer deadlock. Seven old wire fixtures
  explicitly activate/assert the private hello and advance the real legacy grace;
  application ordering assertions remain intact. The final full suite below
  passed with these fixtures.
- A separate read-only review found no additional P1/P2 after the internal
  control-send failure repair. Final storage pins cover credit consumed by
  another lane between capacity wakeup and send, and during the Blob read.
- Initial PR CI `39078104427` found one additional fixture mismatch in
  `audio/effects`: its deliberately failing **first native send** now failed
  the new hello instead of the intended settings publish, correctly closing
  the connection. The test now asserts a successful hello before injecting the
  application-send failure. No production change was needed. The failed unit
  shard reported 6,872 pass / 1 fail / 1 platform skip; its logs are retained.
- PR head `1a55867fbf6bfebfab7e439f06d70aebde41d301` passed all 11 jobs of
  [CI 39078472956](https://github.com/hiefny/MUSIXQUARE/actions/runs/39078472956),
  including both whole-unit shards, merged coverage and critical browser gate.
  GitHub Codex reviewed runtime commit `4c0f9498` with no findings. The subsequent
  commit only fixes the audio test fixture and records its evidence; production
  code at that stage remained identical to the pre-repair candidate manifest.
- The first mixed-version product case then found a **production compatibility
  defect** in that candidate: a new host sent its private hello before WELCOME,
  and the old guest's strict join bootstrap rejected it and closed the connection.
  This is not a flaky entry timeout: native send/receive timestamps prove the
  sequence. Testing stopped; the failed raw and the 16 completed pre-fix
  performance cases were retained. The repair moves negotiation to the explicit
  application bootstrap-complete boundary above. The original performance build
  is not the final release candidate; the repaired new/new and mixed-version
  retests below passed on their separate build.
- Final Windows suite on the exact `fd1ce373` tree: **587 files / 13,115 pass /
  0 fail / 0 skip**, 165.24 seconds. Full typecheck, lint, formatting, committed-HEAD
  `build:checked` and fresh `build:e2e` all passed. Adapter pins cover no hello at
  RTC open, early hello without an early reply and APPLIED before activation;
  host/guest pins cover activation before file/sync events and no join success
  after activation closes the connection. No retry was needed for this full run.
- Repaired runtime PR [CI 39080368618](https://github.com/hiefny/MUSIXQUARE/actions/runs/39080368618)
  passed all 11 jobs, including merged coverage and the browser gate.
- Final local Chromium E2E: **24 pass / 0 fail / 0 skip**, 2.1 minutes, covering
  file transfer, preload, queue/mode cancellation and late join through the
  existing PeerJS path. The native Cloudflare product comparisons below are
  separate. The entire serial E2E suite and physical Android were not rerun.
- PR #399 merged as exact main `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3`.
  [CI 39081289549](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081289549)
  completed successfully with **11/11 jobs**. Linux unit results: **587 files /
  13,114 pass / 0 fail / 1 skip**; the skipped case requires Windows to reject a
  path on another drive. Candidate browser **17** and critical browser **55**
  passed, alongside merged coverage, type/source guards, lint/formatting, static
  checks and the production release candidate. This exact-main result is the
  eligible CI candidate; local and PR evidence do not substitute for it.

The product A/B run uses a pinned baseline and source/asset manifests for the
candidate, on an exclusive local CPU slot. It covers ordinary sends and preload,
eight recipients in both A/B orders, one shaped slow recipient, high RTT, mixed
versions, cancellation/re-add and promotion. Application-control percentiles
exclude new receipt frames so receipt frequency cannot dilute the comparison.
Transfers use the actual file input, native RTC and product send/receive paths;
preload uses a controlled YouTube renderer to isolate the transfer. This run does
not measure the external YouTube provider or physical Android audible alignment.
The initial performance build and repaired runtime have separate manifests and
results below; none of the initial failed evidence is overwritten.

Completed pre-repair product comparisons (maximum matched application heartbeat
delivery time: SYNC_PONG for ordinary files, YOUTUBE_SYNC for preload; receipts
excluded):

| Condition                                         |  Baseline | Candidate |
| ------------------------------------------------- | --------: | --------: |
| Ordinary file, eight guests, A then B             |  5,652 ms |     34 ms |
| Ordinary file, eight guests, B then A             |  7,045 ms |     24 ms |
| Preload, eight guests, A then B                   |  1,420 ms |     25 ms |
| Preload, eight guests, B then A                   |  4,507 ms |     21 ms |
| Ordinary file, one 2 Mbps guest among three       | 20,083 ms |    425 ms |
| Preload, one 2 Mbps guest among three             | 19,692 ms |    418 ms |
| Preload heartbeat, one 8 Mbps guest / ~100 ms RTT |  4,884 ms |    114 ms |
| Preload heartbeat, one 8 Mbps guest / ~220 ms RTT |  4,805 ms |    250 ms |

All 16 performance cases verified 88 file hashes, readiness/final ACK and all 44
candidate credit connections (maximum 131,072 payload bytes outstanding). The
eight-guest subset verified 64 files across eight runs. In the first
ordinary A/B pair, baseline completion ranged from 3.9 to 22.9 seconds while
candidate completion ranged from 8.3 to 8.5 seconds: some previously fast
recipients became slower, while the slowest and whole-group completion improved.
The 2 Mbps ordinary-file completion was 96.845 → 96.415 seconds; preload was
96.703 → 96.303 seconds. These are controlled same-PC observations, not physical
Android or arbitrary-network guarantees. Ordinary-file A/B changes both the
local threshold and credit; preload retains 64 KiB in both variants and isolates
the credit change. At 8 Mbps and roughly 100 ms RTT, the slow guest's completion
was 24.198 → 31.684 seconds; at roughly 220 ms RTT it was 24.495 → 64.540 seconds.
The fixed credit window deliberately trades high-RTT throughput for much shorter
control queues. These results do not support a claim that downloads are always
faster. The repaired-build confirmation below retains this improvement while
fixing the observed bootstrap incompatibility.

Eight-guest ordinary-file page task time increased about 4–7% and maximum guest
event-loop lag was about 71 ms versus 30–32 ms. Diagnostic receipt recording is
part of that cost; these numbers neither isolate application CPU nor measure
native Blob/RTC memory. Do not claim a universal CPU reduction or a 100-device
load result. No preload-induced controlled-YouTube mutation occurred. Application
metadata can have a different tail from the heartbeat table (high-RTT candidate
app-down max 710 ms, heartbeat max 250 ms). Configured shaper delays are not RTT:
the high-RTT pair's no-file native ping samples were approximately 216–231 ms.

Raw evidence is retained under `scratch/receiver-flow-validation-2026-10-18/`:
`actual-product-pre-fix-results-r1.md`, `r1-evidence-manifest.json`,
`candidate-r1-commit-binding.json` and `compatibility-bootstrap-failure-r1.md`.
The source binding checks all 506 runtime files against `4c0f9498`; baseline is
the clean `d09e0d00` checkout. Local tests, build logs and CI logs are under
`scratch/receiver-credit-2026-10-18/`. Receipt accounting proves transport delivery,
not storage durability; received Blob SHA-256 and final app readiness are separate
assertions. The ordinary-file high-RTT case is not independently measured.

### Repaired runtime product confirmation

The separate `fd1ce373` build (App 8.11.20 / v723) passed **8/8 cases and 26/26
final file hashes** without retry: new host/old guest and old host/new guest,
each with ordinary file and preload; eight new/new guests in both file lanes;
mid-transfer cancel/re-add; and preload promotion with one 2 Mbps guest among
three. These are distinct from the 16 pre-repair performance cases above.

- Eight-guest ordinary transfer: heartbeat max **26 ms**, completion
  **8.038–8.183 seconds**, all READY and credit assertions passed.
- Eight-guest preload: heartbeat max **20 ms**, completion **7.229–7.359 seconds**,
  all final ACK and credit assertions passed.
- Cancel/re-add: all three final file hashes and new-item ACKs passed; slow
  completion approximately 100 seconds from workload start, including cancel,
  the 1.5-second wait and re-add, not a single uninterrupted transfer time.
  No old-item send after one second past
  cancellation. Connection-lifetime debt did not reset or strand the new file.
- Promotion: all three final hashes, current queue identity, READY and credit
  passed; slow completion approximately 96.3 seconds, heartbeat max 734 ms.
  The 110-second observation ends before the 120-second fixture naturally ends;
  the prior 125-second plan and revised runner hash are retained. This change
  preceded execution and did not turn a failed run into a pass.
- Mixed versions provide functional compatibility, not equivalent performance:
  old host/new guest ordinary-file heartbeat max was **2.483 seconds**. An old
  sender retains its old queue policy. New host/old guest uses bounded legacy
  fallback and likewise has no receiver-credit guarantee.
- Controlled YouTube had no mutation during ordinary preload or cancellation.
  Promotion intentionally pauses/stops it to enter local-file playback.
- An independent read-only review checked the repaired manifest and raw
  assertions: 22 new/new files have exact cumulative receipts and the 128 KiB
  cap; four mixed files are correctly excluded from that credit guarantee.
  All-direction application control max was 35 ms (ordinary) / 33 ms (preload),
  separate from the heartbeat table. Eight-guest preload had three overlapping
  heartbeat samples per guest; mixed preload had none during its short transfer,
  so it supplies compatibility evidence only. No additional release blocker.

The original mixed-version failure remains an observed failure, with a confirmed
cause and a passing same-path repair. Do not summarize the whole investigation
as failure-free or count the original runtime as release-ready.

Final comparison evidence under `scratch/receiver-flow-validation-2026-10-18/`:
`actual-product-bootstrap-fixed-results-r2.md`, `analysis-postfix-r2.json`,
`candidate-bootstrap-fix-manifest.json`, `postfix-evidence-manifest.json`,
`postfix-bootstrap-wire-order.json` and `postfix-matrix-r2.log`. The fixed build
manifest binds the clean `fd1ce373` source and served assets; the wire-order
record preserves APPLIED before private hello in both mixed-version directions.
These eight repaired-build cases add 26 final hashes to the earlier 88: **114
verified final file hashes across 24 successful cases**, plus the retained,
understood compatibility failure. This is not 24 cases on the final runtime.

## Release and recovery

App **8.11.20 / cache v723** deployed successfully on 2026-10-18 at
**09:11:20 KST** (deploy job completion), target `app`,
`apply_developer_api_d1=false`:

- Runtime PR [#399](https://github.com/hiefny/MUSIXQUARE/pull/399), main
  `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3`.
- Exact-main push [CI 39081289549](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081289549)
  attempt 1, all 11 jobs successful. Immutable candidate
  [12118986426](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081289549/artifacts/12118986426)
  records Node 24.20.0, npm 11.19.0 and Wrangler 4.148.0. The released App was
  taken from this candidate without rebuilding. Neither PR nor local checks
  substituted for that exact-main identity.
- [Production Release 39081701815](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081701815)
  attempt 1 succeeded. App version `d9f64847-408c-4a7b-a13c-8c744a41c7c6`,
  deployment `930bbc83-b7c1-4fbc-b178-afd7de96478a`, 100%, canonical message
  `git:416f5ee48e3708ae33d82aa1c6d925a72bcab6f3`.
- Final ownership verified at **09:11:16.794 KST**. Partial-release compatibility
  recheck completed at 09:10:49.540 KST; the five unselected Workers retained
  `d9364cd94ef036c5202ebf20cf5fff0b68d8cacf` provenance and their captured versions.
  [Deployment evidence 12119341521](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081701815/artifacts/12119341521)
  and [coherent marker 12119456150](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081701815/artifacts/12119456150)
  are retained.
- Four selected live smokes passed: App generation, anonymous public/account
  boundaries, existing PRO public boundaries and Standard HTTPS signaling.
  Out-of-scope Worker smoke steps were skipped. Existing seven App D1 baselines
  applied/verified; no schema change or Developer API D1 application was introduced.
- At **09:12:00.794 KST**, all eight public GETs returned HTTP 200 and matched
  the immutable candidate's size and SHA-256: `/` (140,676 B), service worker
  (39,149 B, v723), bootstrap cache-v723 (10,196 B), main JS (437,646 B), main
  CSS (324,945 B), `peer-ZE0BU1c_.js` (349,157 B), preload (31,888 B) and helper
  (1,599 B). The deployed adapter contains `mxqr-bulk-flow`. The verifier and
  `public-verification.json` are retained under the local evidence directory.
- [Operations Drift Audit 39081868540](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081868540)
  attempt 1 on the same main SHA completed **09:12:20 KST**: automated-checks-passed,
  **31 pass / 0 fail / 5 manual-only**. Manual-only checks were not automatically
  verified. Audit remains active.

Recovery was not needed or run. The immutable
[checkpoint 12119445999](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081701815/artifacts/12119445999)
captured **09:10:11.359 KST** preserves App 8.11.19 / v721,
`eea5a842c1d1b9cd51b845f95de24b1059378bae`, version
`89f8574e-88e3-4268-bc63-f16d302b535b`, deployment
`9d3dfb4d-c050-4c6f-b69f-e424c64fd3f2`. The 09:10:13.363 KST floor checkpoint
is ready, release floor `d9364cd94ef036c5202ebf20cf5fff0b68d8cacf`, generation
floor `4c5612d5fc4c5548781eb7d5b26d6904969c051c`, generation/entitlement true.
The captured baseline is a verified release ancestor and aware of existing
generation, entitlement and Developer API authority boundaries. No new floor.

Rollback to that previous App loses receiver credit and returns ordinary file
local thresholds to 512/256 KiB; preload remains 64 KiB. Rolling old/new peers
retain the compatibility path above. No stored-data migration is required.
Recovery must recheck ownership and floors; the checkpoint is not a user-data
backup. Repository-only release-record updates do not cause another App release.

The physical Android/provider and high-RTT tradeoffs remain open as recorded in
[the current release record](../release-record.md#2-열린-확인-항목). Deployment
success does not close those limits.

## Local evidence cleanup

The experiment servers on 4386, 4387, 4388 and 8797 were stopped. Automatic
approval review rejected deletion of the clean temporary baseline worktree with
`blocked by policy`, without a specific reason. No bypass was attempted:
`scratch/receiver-flow-validation-2026-10-18/baseline-source` is preserved.
`cleanup-result.json` and `blocked-cleanup-command.txt` retain the result. Other
tasks' worktrees, stashes and dependency branches are outside this cleanup.
