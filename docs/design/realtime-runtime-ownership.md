# Realtime Browser Runtime Ownership

- **Status:** Accepted
- **Decision date:** 2026-08-18
- **Amended:** 2026-10-24, the transport-health read rule (Phase 4, C5-4)
- **Applies to:** standard-room browser control, synchronization, and peer liveness

## Decision

The browser realtime runtime keeps one public bootstrap facade, `initSync()`,
while separating three independent ownership domains behind it:

| Module                             | Sole responsibility                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/network/sync.ts`              | sync-frame orchestration, manual offsets, and file-drift correction; host-relative sample state remains in `shared-clock.ts` |
| `src/network/room-control.ts`      | authorized participant removal and delegated chat-administration commands                                                    |
| `src/network/heartbeat-monitor.ts` | heartbeat leases, stale-peer fencing, and disconnect publication; it reads RTC transport grace from `transport-health.ts`    |

`initSync()` remains the compatibility composition point because bootstrap,
existing focused tests, and standard-room startup already treat it as the
single eager network initializer. It may wire these domains together, but it
must not duplicate their internal authority, state, or cleanup implementations.

## Transport-health read rule

Amended 2026-10-24 (Phase 4, C5-4). `src/network/transport-health.ts` is the
one read path from a data connection's raw RTC state (the peer connection's
`connectionState` and `iceConnectionState`, the data and control channel
states, and the provider's ICE recovery deadline) to the decisions made on it.
A caller takes one snapshot with `readTransportHealth()` and asks a pure
predicate:

- `isBulkWritable`: the bulk (chunk) senders, through
  `isBulkTransferWritablePeer` in `src/storage/chunk-pump.ts`. Either field
  disconnected, failed, or closed blocks the lane.
- `isRecoverablyInterrupted`: the preload lanes in `src/storage/preload.ts`
  pause instead of aborting. Either field disconnected or failed counts.
- `heartbeatStaleThreshold` and `honoursRecoveryLease`: the heartbeat
  monitor's stale threshold and its bounded ICE recovery lease. Neither reads
  `iceConnectionState`. The threshold reads whether the connection is open,
  the peer connection's `connectionState`, and the data and control channel
  states. The lease reads whether the connection is open, the data and
  control channel states, and the provider's recovery deadline; it reads no
  peer connection state.

The module owns no state, timer, or lifecycle. Callers keep their own currency
checks (the connection is still the peer's current one). The heartbeat
monitor keeps its leases, check cadence, fencing, and disconnect publication;
only the transport classification and its stale-threshold values moved.
`npm run guard:transport-health` (`scripts/check-transport-health.mts`, run
in CI) allows no raw `connectionState` or `iceConnectionState` read in
`src/storage/**` or `heartbeat-monitor.ts`, except the stale-peer warning,
which prints the peer connection's state and decides nothing. Media-PC readers
(system audio) and the provider's own liveness readers in
`src/network/transport/` are outside this rule.

## Authority rules

- Participant-removal handlers accept mutations only through the exact current
  live connection and the canonical room capability model. PRO physical-device
  removal remains server-authoritative and is not exposed through the browser
  physical-kick frame.
- Delegated chat administration preserves its transport-specific authorization
  boundary: standard rooms verify the required capability on the requesting
  connection, while the retained PRO compatibility path requires the peer
  record bound to that connection to carry the operator projection. This is not
  the server-authoritative PRO participant-removal path.
- `RequestedKickScope` is declared by `room-control.ts`; compatibility facades
  import that type rather than redefining the authority shape.
- Heartbeat observations are keyed by connection identity, not only peer ID, so
  a reconnect cannot inherit a superseded connection's lease.
- Synchronization accepts `SYNC_PONG` only from the exact current host
  connection and does not own participant-administration handlers.

## Lifecycle and compatibility ports

- `initSync()` composes room control and heartbeat monitoring before registering
  the synchronization handlers. `registerHandlers()` merges handlers by message
  type, so this split does not replace either handler set.
- Heartbeat monitoring follows `setup.sessionStarted` transitions and also
  reconciles the current snapshot during initialization. It stops when the
  browser becomes a guest and acquires `hostConn`, no later than the next
  monitor tick.
- A missing or closed transport uses the 8-second stale threshold. A recovering
  RTC transport receives 30 seconds, and a fully connected transport receives
  90 seconds to tolerate browser background timer suspension. These values
  live with the classification in `transport-health.ts`.
- `sync:request-immediate-ping` remains the internal compatibility port for an
  out-of-band guest ping. `sync:force-resync` first resets clock samples and
  arms the next valid `SYNC_PONG`, then requests the ping through that port.
  Callers therefore do not depend on the ping implementation living inside
  `sync.ts`.

## Product invariants

This boundary change does not alter UI, UX, room flows, playback behavior,
manual-sync behavior, or user-visible copy.

Browser media remains best-effort and RAM-only under the existing storage ADR.
MUSIXQUARE does not pre-reject a load from a predicted per-device RAM budget;
transfer and native decode continue until the browser/device succeeds or
returns an actual allocation/decode failure. The 200 MiB remote-share value is
a wire and private-storage protocol ceiling, not a device-memory admission
limit.

## Verification

The repository guards this decision through:

- TypeScript declaration-ownership and import-graph checks;
- the transport-health read-path guard, the bulk-writability golden truth
  table (`src/storage/__tests__/__fixtures__/bulk-writable-truth-table.txt`),
  and `transport-health.test.ts` in the critical-runtime coverage profile;
- focused room-control and heartbeat-monitor tests plus synchronization
  integration regressions through the `initSync()` compatibility facade;
- broad, critical-runtime, and Worker coverage ratchets;
- the exact-SHA production candidate build; and
- the blocking critical Chromium browser gate.
