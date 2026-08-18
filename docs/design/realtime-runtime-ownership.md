# Realtime Browser Runtime Ownership

- **Status:** Accepted
- **Decision date:** 2026-08-18
- **Applies to:** standard-room browser control, synchronization, and peer liveness

## Decision

The browser realtime runtime keeps one public bootstrap facade, `initSync()`,
while separating three independent ownership domains behind it:

| Module                             | Sole responsibility                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/network/sync.ts`              | sync-frame orchestration, manual offsets, and file-drift correction; host-relative sample state remains in `shared-clock.ts` |
| `src/network/room-control.ts`      | authorized participant removal and delegated chat-administration commands                                                    |
| `src/network/heartbeat-monitor.ts` | heartbeat leases, RTC transport grace, stale-peer fencing, and disconnect publication                                        |

`initSync()` remains the compatibility composition point because bootstrap,
existing focused tests, and standard-room startup already treat it as the
single eager network initializer. It may wire these domains together, but it
must not duplicate their internal authority, state, or cleanup implementations.

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
  90 seconds to tolerate browser background timer suspension.
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
- focused room-control and heartbeat-monitor tests plus synchronization
  integration regressions through the `initSync()` compatibility facade;
- broad, critical-runtime, and Worker coverage ratchets;
- the exact-SHA production candidate build; and
- the blocking critical Chromium browser gate.
