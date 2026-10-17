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

Hello is sent before application open handlers run. During a bounded 1-second
negotiation grace, the first 128 KiB can be sent. An older peer that does not
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

The product A/B run uses a pinned baseline and source/asset manifests for the
candidate, on an exclusive local CPU slot. It covers ordinary sends and preload,
eight recipients in both A/B orders, one shaped slow recipient, high RTT, mixed
versions, cancellation/re-add and promotion. Application-control percentiles
exclude new receipt frames so receipt frequency cannot dilute the comparison.
Results, final source SHA and final pass/fail/skip counts are pending.

Local/PR evidence cannot substitute for the successful exact-main CI candidate
required by the production release workflow.

## Release and recovery

Planned identity: App 8.11.20 / cache v722, target app,
`apply_developer_api_d1=false`. No production release has run for this change.
Rollback to the recorded previous App loses receiver credit and returns ordinary
file local thresholds to 512/256 KiB, while its preload threshold remains 64 KiB.
Rolling old/new peers retain the compatibility path above; no stored-data migration.
