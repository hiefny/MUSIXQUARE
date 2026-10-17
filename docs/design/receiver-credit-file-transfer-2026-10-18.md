# Receiver-confirmed flow control for direct file transfers

- Date: 2026-10-18 KST.
- Status: implementation and comparative validation in progress; not deployed.
- Baseline: `d09e0d00fe72712ca3a2a4a5963378e032757d3b` (runtime `eea5a842`).
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
attempt. No application open or decoded-data event is emitted after that
failure closes the connection.

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
  its focused post-repair tests: 21 passed. The full suite remains required.
- The initial full-unit attempt was interrupted after identifying an obsolete
  capture/replay fixture: it awaited four chunks before creating its receiver,
  without advancing fake time through the new legacy negotiation grace. This
  cannot receive credit and is not a live-peer deadlock. Seven old wire fixtures
  now explicitly assert the private hello and advance the real legacy grace;
  application ordering assertions remain intact. Final suite results are pending.
- A separate read-only review found no additional P1/P2 after the internal
  control-send failure repair. A race pin was requested for credit consumed by
  another lane between capacity wakeup and send.
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
  code remains identical to the candidate build's source manifest.
- The first mixed-version product case then found a **production compatibility
  defect** in that candidate: a new host sent its private hello before WELCOME,
  and the old guest's strict join bootstrap rejected it and closed the connection.
  This is not a flaky entry timeout: native send/receive timestamps prove the
  sequence. Testing stopped; the failed raw and the 16 completed pre-fix
  performance cases were retained. The repair moves negotiation to the explicit
  application bootstrap-complete boundary above. The original performance build
  is not the final release candidate; new/new and mixed-version retests are required.

The product A/B run uses a pinned baseline and source/asset manifests for the
candidate, on an exclusive local CPU slot. It covers ordinary sends and preload,
eight recipients in both A/B orders, one shaped slow recipient, high RTT, mixed
versions, cancellation/re-add and promotion. Application-control percentiles
exclude new receipt frames so receipt frequency cannot dilute the comparison.
Transfers use the actual file input, native RTC and product send/receive paths;
preload uses a controlled YouTube renderer to isolate the transfer. This run does
not measure the external YouTube provider or physical Android audible alignment.
Results, final source SHA and final pass/fail/skip counts are pending.

Completed pre-repair product comparisons (maximum matched application heartbeat
delivery time: SYNC_PONG for ordinary files, YOUTUBE_SYNC for preload; receipts
excluded):

| Condition | Baseline | Candidate |
| --- | ---: | ---: |
| Ordinary file, eight guests, A then B | 5,652 ms | 34 ms |
| Ordinary file, eight guests, B then A | 7,045 ms | 24 ms |
| Preload, eight guests, A then B | 1,420 ms | 25 ms |
| Preload, eight guests, B then A | 4,507 ms | 21 ms |
| Ordinary file, one 2 Mbps guest among three | 20,083 ms | 425 ms |
| Preload, one 2 Mbps guest among three | 19,692 ms | 418 ms |
| Preload heartbeat, one 8 Mbps guest / ~100 ms RTT | 4,884 ms | 114 ms |
| Preload heartbeat, one 8 Mbps guest / ~220 ms RTT | 4,805 ms | 250 ms |

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
faster. Compatibility and repaired-build confirmation remain pending.

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

Local/PR evidence cannot substitute for the successful exact-main CI candidate
required by the production release workflow.

## Release and recovery

Planned identity: App 8.11.20 / cache v723, target app,
`apply_developer_api_d1=false`. No production release has run for this change.
Rollback to the recorded previous App loses receiver credit and returns ordinary
file local thresholds to 512/256 KiB, while its preload threshold remains 64 KiB.
Rolling old/new peers retain the compatibility path above; no stored-data migration.
