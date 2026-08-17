# Realtime Browser Runtime Ownership

- **Status:** Accepted
- **Decision date:** 2026-08-18
- **Applies to:** standard-room browser control, synchronization, and peer liveness

## Decision

The browser realtime runtime keeps one public bootstrap facade, `initSync()`,
while separating three independent ownership domains behind it:

| Module | Sole responsibility |
| --- | --- |
| `src/network/sync.ts` | host-relative clock samples, sync protocol frames, manual offsets, and file-drift correction |
| `src/network/room-control.ts` | authorized participant removal and delegated chat-administration commands |
| `src/network/heartbeat-monitor.ts` | heartbeat leases, RTC transport grace, stale-peer fencing, and disconnect publication |

`initSync()` remains the compatibility composition point because bootstrap,
existing focused tests, and standard-room startup already treat it as the
single eager network initializer. It may wire these domains together, but it
must not duplicate their internal authority, state, or cleanup implementations.

## Authority rules

- Room-control handlers accept mutations only through the exact current live
  connection and the canonical room capability model.
- `RequestedKickScope` is declared by `room-control.ts`; compatibility facades
  import that type rather than redefining the authority shape.
- Heartbeat observations are keyed by connection identity, not only peer ID, so
  a reconnect cannot inherit a superseded connection's lease.
- Synchronization accepts `SYNC_PONG` only from the exact current host
  connection and does not own participant-administration handlers.

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
- focused room-control and synchronization regression tests;
- broad, critical-runtime, and Worker coverage ratchets;
- the exact-SHA production candidate build; and
- the blocking critical Chromium browser gate.
