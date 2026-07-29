# File playback control-plane redesign

- **Status:** Accepted beta architecture; implementation in progress
- **Branch:** `mxqr_beta`
- **Stable baseline:** `ca342a324f0ee39c1b948b8938690688eaa441d9`
- **Production rule:** the tracked V2 production latch remains off
- **Scope:** replace the distributed V2 control plane while preserving the
  bounded delivery, decoder, renderer, and R2 work

## Decision

The next file-playback engine is not a patch to the current V2 state machines.
It combines:

1. the proven legacy room-control behavior for the first product slice;
2. the existing bounded `EncodedAudioSource` and renderer data plane; and
3. one new serialized room-playback actor with snapshot/resync semantics.

The room transport never becomes a child of playback. Playback may be reset,
resynchronized, or temporarily degraded without closing the chat, playlist,
membership, or room connection.

## User-visible contract

The redesign is accepted only if its internal state is reflected as one stable
interaction, not as protocol phases leaking into the UI:

- play acknowledges immediately and exposes one continuous loading state until
  audio is ready, cancelled, replaced, or fails;
- repeated play taps while that intent is pending are coalesced;
- pause and stop update the canonical timeline and visible controls
  immediately; renderer convergence never delays the button state;
- the seek bar is projected only from the canonical room timeline, so native
  decoder callbacks cannot pull it backward and forward;
- known duration comes from immutable media metadata and does not temporarily
  become `0:00` while a decoder prepares;
- late join applies one snapshot and keeps one loading state rather than
  flashing ready/loading or replaying historical protocol phases;
- an unsupported format selects the unchanged V1 path before bounded ownership
  is transferred; there is no mid-run engine flip; and
- every playback recovery keeps chat, playlist, membership, and the room
  connection alive.

## Why the current V2 failed

The current V2 has several mutable owners for overlapping authority:

- `FilePlaybackApplicationSessionManager` owns connection/session sequencing
  and physical teardown;
- `FilePlaybackProductSessionRouter` owns another connection record and
  lifecycle;
- host and guest media owners each own timeline, candidate, recovery, and
  physical source state;
- `FilePlaybackConnectionMediaSession` owns another current/candidate ledger;
  and
- `FilePlaybackProductRuntime` owns room-wide cohorts and transition barriers.

The wire receiver also advances sequence and binding authority before the
domain owner accepts the command. Once a later owner rejects a valid timing
race, ignoring the error would leave two ledgers disagreeing. The only safe
behavior available to that architecture is fail-close, so a playback race
tears down the actual room connection.

Observed failures such as these are consequences of that ownership model, not
independent codec defects:

- source preparation completing after a newer transition;
- recovery cancellation crossing pause, seek, stop, or replacement;
- timeline metadata arriving before a physical renderer commit;
- a same-run prepare being classified as an invalid successor;
- re-entry while layered cleanup callbacks call one another; and
- peer-range backpressure being promoted into a connection-fatal error.

## What stays

The following data-plane components are retained behind narrow adapters:

- `EncodedAudioSource` and its Blob, peer-range, and R2 implementations;
- independent authenticated R2 records and exact range reads;
- peer-range protocol, bounded request/response mechanics, and backpressure;
- MP3, AAC/ADTS, M4A, FLAC, and linear-PCM decoder adapters;
- bounded PCM workers, ring-capacity planning, and AudioWorklet renderer;
- `FilePlaybackManager` cutover primitives;
- asset/source staging primitives; and
- room-clock and rendezvous calculations as leaf mechanisms.

The existing PRO bounded-playback adapter proves that these components can be
driven by an external authority without installing the standard V2
application session.

## What is replaced

The following components are not extended as control authorities:

- standard V2 application session and handshake;
- `FilePlaybackProductSessionRouter`;
- standard host and guest media owners;
- `FilePlaybackConnectionMediaSession`;
- the application controller as a second timeline owner; and
- owner-level `closeConnection` or `onFatalConnection` callbacks.

Useful parsers, schemas, identity checks, and clock primitives may be extracted,
but their mutable ledgers are not reused.

## Target ownership

### Transport session

The only owner of the physical `DataConnection`, authentication, lane
serialization, clock calibration, and connection close.

It may close a connection for:

- failed authentication or authorization;
- malformed or forged frames;
- a wrong immutable room/session scope;
- incompatible protocol versions; or
- actual transport corruption.

It does not close a connection because a decoder, source, renderer, readiness
barrier, or playback transition failed.

### Room playback actor

The only mutable owner of:

- room playback epoch;
- authoritative event sequence;
- desired current media binding;
- canonical timeline and revision; and
- whether a replica needs a snapshot.

All commands, network events, timers, and async completions enter one FIFO
inbox. No callback mutates actor state directly.

### Control ledger

Admission is transactional:

```text
parse and canonicalize
        -> probe sequence/scope without mutation
        -> actor reduces the command
        -> commit sequence and state together
```

There is no sequence watermark mutation before the actor accepts the event.

### Guest renderer agent

Owns only local physical resources:

- source acquisition and preparation;
- `FilePlaybackManager`;
- staged and current renderer ports;
- decoder/worklet lifetime; and
- renderer evidence.

It reconciles physical output toward the actor's desired snapshot. It does not
own room truth and cannot close the room connection.

### Delivery provider

Owns one bounded byte source and its retry/integrity lifecycle. Delivery
failures retire or retry the exact media scope. They do not invalidate room
membership.

```ts
interface DeliveryScope {
  roomEpoch: string;
  actorGeneration: string;
  bindingId: string;
  descriptorId: string;
  descriptorVersion: number;
}

interface EncodedDeliveryProvider {
  open(input: {
    scope: DeliveryScope;
    descriptor: EncodedDeliveryDescriptor;
    signal: AbortSignal;
  }): Promise<EncodedAudioSource>;
  retire(scope: DeliveryScope): Promise<void>;
}
```

`open` transfers ownership of exactly one source to the caller. The source is
closed exactly once by either the renderer agent that accepted it or the
aborted opener that never published it. `retire` is joinable: completion means
all provider work for the exact scope is inert. It never revokes another
binding or actor generation.

### Legacy bounded playback port

The first product slice keeps the current V1 `PLAY`, `PAUSE`, queue identity,
late-join bootstrap, and recovery behavior while replacing whole-file
`AudioBuffer` ownership when a bounded source is available.

```ts
interface LegacyBoundedPortLease {
  roomEpoch: string;
  actorGeneration: string;
  bindingId: string;
  portGeneration: string;
}

interface LegacyBoundedFilePort {
  prepare(input: {
    lease: LegacyBoundedPortLease;
    source: EncodedAudioSource;
    positionSeconds: number;
  }): Promise<void>;
  play(input: {
    lease: LegacyBoundedPortLease;
    positionSeconds: number;
    startAtRoomTimeMs?: number;
  }): Promise<boolean>;
  pause(input: { lease: LegacyBoundedPortLease; positionSeconds: number }): Promise<boolean>;
  stop(lease: LegacyBoundedPortLease): Promise<void>;
  position(lease: LegacyBoundedPortLease): FilePlaybackPosition | null;
  retire(lease: LegacyBoundedPortLease): Promise<void>;
}
```

Every mutation is scoped to one immutable port capability. A late operation
from a replaced media binding or renderer generation is rejected before it can
touch the current port.

If no bounded port exists, the unchanged V1 `AudioBuffer` path remains the
compatibility fallback.

## Canonical replica state

```ts
interface FilePlaybackRoomReplica {
  schemaVersion: 1;
  roomEpoch: string;
  actorGeneration: string;
  appliedSequence: number;
  snapshotSequence: number; // late events covered by this snapshot are stale
  lastEventId: string | null;
  lastEventFingerprint: string | null;
  stateVersion: number;
  effectSerial: number;
  resyncSerial: number;
  timeline: FilePlaybackRoomTimeline;
  media: FilePlaybackMediaBinding | null;
  rendererStatus: 'idle' | 'reconciling' | 'ready' | 'degraded';
  activeRendererLease: EffectLease | null;
  resync: null | {
    generation: number;
    expectedSequence: number;
    highestObservedSequence: number;
    requestAttempt: number;
  };
}
```

`media` describes the source required by the desired timeline. Physical
preparation status is deliberately absent. A play command may be accepted
before a local source is ready; the renderer agent shows loading and converges
when preparation completes.

The timeline carries host canonical `anchorRoomTimeMs`, never a guest-local
`performance.now()` value. Each renderer maps room time through its current
clock lease at the scheduling boundary.

## Event contract

Every authoritative mutation carries:

```ts
interface RoomEventEnvelope {
  roomEpoch: string;
  sequence: number;
  eventId: string;
}
```

The initial implementation has three event kinds:

- `media-bound`: replaces the desired media binding;
- `timeline-transition`: applies one canonical play/pause/seek/stop intent; and
- `snapshot`: atomically replaces media, timeline, and the applied sequence.

Transport-local replay protection may retain a separate connection sequence.
It must not substitute for the room event sequence.

## Sequence and resync rules

- `sequence < appliedSequence`: acknowledge and ignore as stale.
- exact same event at `sequence === appliedSequence`: acknowledge and ignore as
  a duplicate.
- a conflicting event at the same sequence: request a snapshot.
- `sequence === appliedSequence + 1`: reduce normally.
- `sequence > appliedSequence + 1`: retain the old canonical state, enter a
  bounded resync state, and request a snapshot.
- while resync is pending, later mutations do not partially apply, but their
  maximum observed sequence raises `highestObservedSequence`.
- a snapshot below `highestObservedSequence` cannot clear resync; the actor
  requests a newer snapshot using a bounded retry budget.
- an authoritative snapshot covering the high-water mark atomically replaces
  replica state and clears resync.
- late events received after that snapshot are stale and inert.

A sequence gap, duplicate, reordered transition, stale recovery completion, or
missing local source is never connection-fatal.

## Snapshot and late join

A snapshot contains:

- room epoch and authoritative snapshot sequence;
- canonical host-room-time timeline; and
- current media binding, including immutable source identity, delivery kind,
  descriptor ID/version, encoded size, MIME type, and known duration.

The descriptor body and secrets are not copied into playback state. The
transport session owns an immutable, epoch-scoped descriptor registry.
`descriptorId + descriptorVersion + bindingId` resolves exactly one frozen
descriptor; it never consults mutable queue position or a room-code-wide
record.

For a late join, the authenticated snapshot envelope carries the descriptor
as a transport sidecar. Transport canonicalizes the sidecar, installs it under
the exact room/actor/binding scope, and only then submits the detached playback
snapshot to the actor. Reinstalling an identical descriptor is idempotent;
reusing the same scoped ID with different bytes rejects the envelope before
playback admission. A snapshot rejection may leave only an unreachable
immutable registry entry, which the transport generation later retires.

Late join does not replay historical PREPARE, ARM, FINALIZE, and recovery
messages.

1. Apply the current snapshot.
2. If stopped, remain idle.
3. If paused, acquire and prepare the media silently.
4. If playing, acquire/prepare and start a new unicast recovery attempt at the
   position derived from the current host timeline.

An old connection's receipts and effect completions carry an obsolete local
lease and cannot modify the new actor generation.

## Error taxonomy

| Failure                           | Playback action                  | Transport action           |
| --------------------------------- | -------------------------------- | -------------------------- |
| transient R2/peer read failure    | retry or request another route   | keep open                  |
| unsupported or failed decoder     | retire media / use V1 fallback   | keep open                  |
| renderer/worklet failure          | reset local renderer and recover | keep open                  |
| sequence gap or state race        | request authoritative snapshot   | keep open                  |
| stale async completion            | release stale resources          | keep open                  |
| stale local room/actor epoch      | discard stale effect             | keep open                  |
| media-byte integrity failure      | retire exact media binding       | keep open                  |
| malformed/forged control frame    | not admitted to playback         | transport policy may close |
| wrong authenticated room scope    | not admitted to playback         | transport policy may close |
| authentication failure            | not admitted to playback         | transport policy may close |
| physical RTC/WebSocket corruption | none                             | transport closes           |

Transport classification happens before the playback boundary. No playback
failure kind, disposition, component, or callback contains a transport field
or a callable connection-close capability.

## Async effect leases

Every renderer or delivery effect captures:

```ts
interface EffectLease {
  roomEpoch: string;
  actorGeneration: string;
  effectSerial: number;
  effectId: string;
}
```

Only one renderer lease is active in an actor generation. Completion is a
typed local actor event, not an out-of-band callback. The actor atomically
compares the full lease with `activeRendererLease`; a stale completion can
only emit a cleanup effect for its own resources and cannot publish state,
audio, UI, or network commands.

Actor construction takes primitive epoch/generation values and builds its own
frozen state. `snapshot()` never exposes caller-owned mutable state. The inbox
is bounded, reducer exceptions reject the exact dispatch without wedging later
work, and observer re-entry is deferred to a subsequent microtask batch.

## Migration

### Phase 0: stable reset

- `main` remains on the production rollback with the V2 latch off.
- `mxqr_beta` starts from the exact same stable commit.

### Phase 1: executable model

- add the pure replica reducer and serialized actor;
- add snapshot/resync and error-boundary contracts;
- run deterministic duplicate, gap, reorder, re-entry, and late-join tests;
- do not wire the actor to production.

### Phase 2: V1-control bounded vertical slice

- keep the existing V1 room commands;
- add an additive body-only delivery descriptor;
- open one bounded R2 source through `EncodedDeliveryProvider`;
- drive it through a dedicated `LegacyBoundedFilePort`;
- branch at V1 play, pause, stop, and position boundaries; and
- preserve the legacy path when the port is absent or the format is unsupported.

### Phase 3: shadow actor

- feed canonical V1 room events into the new actor;
- compare actor projections with shipped V1 behavior;
- actor has no audible or network authority yet.

### Phase 4: renderer ownership

- let the actor drive the bounded renderer agent;
- retain V1 wire control and late-join bootstrap;
- add peer-range delivery after R2 is stable.

### Phase 5: snapshot/resync transport

- introduce versioned snapshot/resync messages;
- replace historical late-join replay with current-state restoration; and
- prove reconnection and stale-connection fencing.

### Phase 6: retire old V2 control

- remove duplicated session router, owners, ledgers, and fail-close callbacks;
- keep only reusable parsers/data-plane primitives; and
- consider production enablement only after all gates below pass.

## Required deterministic tests

- duplicate and stale event delivery;
- sequence gap followed by snapshot, then a late missing event;
- reordered recovery cancel with pause, seek, stop, ended, replay, and replace;
- finalize/effect completion after a newer transition;
- late join during every preparation/render phase;
- old-connection completion after new-connection snapshot;
- synchronous observer callback re-entry;
- one degraded guest while host and another guest continue;
- source/decoder/renderer failure without room teardown; and
- eventual host/guest convergence after all queues become idle.

## Re-enable gates

Production remains on the stable engine until:

1. the new actor is the only playback state owner;
2. wire admission and actor commit are atomic;
3. playback code has no connection-close capability;
4. V1 fallback remains byte/protocol compatible;
5. all deterministic adversarial tests pass;
6. focused browser tests cover host, multiple guests, late join, seek, pause,
   stop, replace, background/resume, LAN, and R2;
7. physical iOS Safari/PWA and Windows checks pass; and
8. rollback remains a one-latch static-app release.

## Current beta checkpoint

Phase 1 is implemented as an executable specification under
`src/player/__tests__/helpers/` rather than as reachable product code. This is
intentional: it lets the sequence, snapshot, fault-boundary, and actor
invariants harden without accidentally creating a second runtime owner.

The checkpoint currently proves:

- descriptor-safe event canonicalization;
- snapshot parsing without validate-then-reread access;
- atomic sequence/state reduction;
- duplicate fingerprint validation and stale-event idempotency;
- bounded, high-water-aware snapshot requests for a sequence gap;
- snapshot coverage of subsequently arriving old events;
- desired playback acceptance before local media readiness;
- coherent media/timeline reconciliation when a queue item changes;
- authoritative late-join restoration;
- canonical host-room-time projection without cross-device monotonic-clock
  assumptions;
- exact admission of current renderer completions and cleanup of stale leases;
- actor-generation fencing and constructor state ownership;
- bounded FIFO admission and next-microtask observer re-entry;
- observer-failure isolation;
- convergence across all permutations of a three-event
  media/play/pause sequence; and
- a normalized failure table where delivery, decoder, renderer, state-race,
  media-integrity, and stale-effect failures have no transport-close outcome.

The next product change is Phase 2: extract the PRO-style bounded renderer
adapter into a V1-controlled `LegacyBoundedFilePort`, initially for one R2
delivery path. Its capability/scoping contract is specified above; product
wiring is deliberately not part of this checkpoint. No current V2 router or
owner is used by that slice.
