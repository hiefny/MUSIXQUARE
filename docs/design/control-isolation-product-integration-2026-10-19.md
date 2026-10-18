# Standard control isolation: product integration

Status: implementation and verification in progress. This is not evidence of a
production release. The owner authorized integration, remaining tests, and an
App release only if ordinary transfer and preload pass. The starting main is
`deb52829930d0b8a4b87e70b05f84aa7c242c799`; production remains `416f5ee4`,
App 8.11.20/cache v723 until an actual release is recorded. The proposed product
is 8.11.22/cache v726. No dependencies, Worker protocol, schema, secret, binding,
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

Implementation checks currently run on Windows with pinned Node 24.20.0.
Final tested SHA, native results and release evidence will be added after they
exist. PR/local success cannot replace the successful exact-main-SHA CI candidate.
An ordinary App release leaves Developer API D1 application disabled. Recovery
uses the immutable pre-release checkpoint and restores a compatible previous
App; rollback removes side isolation/adaptive expansion on refreshed clients,
while mixed clients retain the negotiated legacy route. No data migration.
