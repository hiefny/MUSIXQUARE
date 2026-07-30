# File playback control-plane redesign

- **Status:** Bounded V1-control vertical slice promoted for standard rooms
- **Branch:** merged from `mxqr_beta` into `main`
- **Stable baseline:** `ca342a324f0ee39c1b948b8938690688eaa441d9`
- **Production rule:** the tracked V2 production latch is off. The redesigned
  bounded V1-control path must use its own production gate and must never
  activate the retired V2 application-session control plane.
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

## Current rollout (2026-07-30)

The first production enablement accidentally selected the retired V2
ApplicationSession/ProductRuntime control plane. A field failure confirmed
that its guest media-owner invariant could still close the room connection,
so that release was first returned to the stable `legacy-current` profile.

The corrected release promotes `legacyBoundedFileV1` through an independent,
exact production artifact and tracked latch. Standard rooms retain the V1 room
control plane while supported files may use the bounded renderer/data path.
The retired V2 latch and both of its production flags remain off. Capability
discovery and data-path failures fall back per connection to stable V1 without
owning room liveness; PRO rooms remain on their established V1 route.

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
  bridgeGeneration: string;
  bindingId: string;
  queueItemId: QueueItemId;
  sourceIdentity: string;
}

interface EncodedDeliveryProvider {
  open(input: {
    scope: DeliveryScope;
    descriptor: EncodedDeliveryDescriptorRef;
    signal: AbortSignal;
  }): Promise<EncodedAudioSource>;
  retire(scope: DeliveryScope): Promise<void>;
}
```

`open` transfers ownership of exactly one source to the caller. The source is
closed exactly once by either the renderer agent that accepted it or the
aborted opener that never published it. Logical retirement makes the exact
scope inert immediately; a source constructor that ignores cancellation is
cleaned up when it eventually settles. Retirement of one scope never revokes
another binding or bridge generation.

The public scope binds the same immutable asset tuple used by the stable
playlist path: queue occurrence, source identity, and transfer-session binding.
Registration rejects publication metadata that disagrees with any element of
that tuple. Descriptor IDs are tombstoned inside their full scope rather than
globally, and a registry admits at most 1,024 live-plus-retired exact
descriptors before failing closed. `dispose()` is the only operation that
releases those tombstones for the retired bridge lifetime.

For the current encrypted R2 record layout, a one-byte logical preflight still
downloads and authenticates the first complete record (up to 8 MiB). The V1
bridge must not repeat that cost on every pause/resume. It should either retain
the already-owned source while safe, introduce a bounded shared record cache,
or treat decoder preparation itself as readiness evidence.

### Legacy bounded playback port

The first product slice keeps the current V1 `PLAY`, `PAUSE`, queue identity,
late-join bootstrap, and recovery behavior while replacing whole-file
`AudioBuffer` ownership when a bounded source is available.

```ts
interface LegacyBoundedPortLease {
  // Intentionally fieldless. Runtime authority lives in a WeakMap owned by
  // the exact LegacyBoundedFilePort instance.
}

interface LegacyBoundedFilePort {
  prepare(input: {
    scope: LegacyBoundedFileScope;
    open(signal: AbortSignal): Promise<{
      source: FilePlaybackCutoverSource;
      destination: AudioNode;
    } | null>;
  }): {
    lease: LegacyBoundedPortLease;
    ready: Promise<LegacyBoundedFilePrepareOutcome>;
  };
  commitPlay(input: {
    lease: LegacyBoundedPortLease;
    scope: LegacyBoundedFileScope;
    positionSeconds: number;
    startAtRoomTimeMs: number;
  }): Promise<LegacyBoundedFileControlOutcome>;
  pause(/* exact lease, scope, and V1 room time */): Promise<LegacyBoundedFileControlOutcome>;
  seek(/* exact lease, scope, position, and V1 room time */): Promise<LegacyBoundedFileControlOutcome>;
  stop(/* exact lease, scope, and V1 room time */): Promise<LegacyBoundedFileControlOutcome>;
  retire(/* exact lease and scope */): Promise<void>;
}
```

`prepare` only opens and silently stages a bounded renderer. It deliberately
does not prime a position. `commitPlay` receives a fresh V1 canonical position
for that exact attempt, primes the staged renderer, and only then creates its
rendezvous schedule. Slow preparation therefore cannot revive an old seek or
late-join position.

Every mutation is scoped to one immutable, fieldless port capability plus the
full frozen scope. A late operation from a replaced media binding or bridge
generation is rejected before it can touch the current port. Logical
retirement cannot be held hostage by an opener that ignores `AbortSignal`; a
source that appears after retirement is destroyed without regaining authority.

If no bounded port exists, the unchanged V1 `AudioBuffer` path remains the
compatibility fallback. Fallback is allowed only before a bounded renderer
obtains audible ownership. Resume or playing-seek may prepare a fresh bounded
candidate and atomically replace the previous renderer rather than mutating an
already audible decoder in place.

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

### Phase 0: stable reset (historical)

- `main` remained on the production rollback with the V2 latch off.
- `mxqr_beta` started from the exact same stable commit.

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

Production remained on the stable engine until the implementation gates below
were reviewed. Physical-device evidence continues as part of the monitored
rollout:

1. the new actor is the only playback state owner;
2. wire admission and actor commit are atomic;
3. playback code has no connection-close capability;
4. V1 fallback remains byte/protocol compatible;
5. all deterministic adversarial tests pass;
6. focused browser tests cover host, multiple guests, late join, seek, pause,
   stop, replace, background/resume, LAN, and R2;
7. physical iOS Safari/PWA and Windows checks pass; and
8. rollback remains a one-latch static-app release.

### Current production promotion state

The `v316` bounded-V1 promotion was conservatively rolled back to stable V1 at
cache epoch `v317` after the first live R2 publication observer reported a
request failure. Exact-candidate replay established two independent facts:

1. the observer treated a recovered upload-authority retry and the intentional
   response-body cancellation after successful record-set cleanup as fatal
   request failures; and
2. terminal guest retirement passed the seven-field renderer bridge scope to
   the five-field R2 delivery provider, so exact scope validation could report
   `FILE_PLAYBACK_R2_RECORD_SCOPE_INVALID` after STOP.

The `v318` promotion separates those scopes, isolates synchronous retirement
failures inside settled cleanup, and requires request-identity-aware R2 canary
evidence. Production enables only the bounded V1-control path:

1. `LEGACY_BOUNDED_FILE_PRODUCTION_RELEASE_ENABLED` is `true`;
2. `FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED` and both retired V2 build
   flags remain off;
3. the exact candidate must pass focused host/guest terminal-retirement proof;
   and
4. the live canary must distinguish a completed 2xx request from a response
   whose body was later aborted, allow only bounded same-record per-route
   retries within the product retry budgets, reject duplicate successful
   publication, and still fail closed on unrecovered R2, runtime, fallback, or
   connection-liveness failure.

Changing only an environment flag or only the latch is not an operational
rollback: production artifacts require the exact gate identity, and the service
worker version bump is the cache migration boundary for already-open clients.

## Current implementation checkpoint

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

The Phase 2 foundation is selected in standard rooms by an exact production
gate and remains available through a separately isolated beta artifact:

- the production artifact requires its exact mode, bounded flag, generated
  artifact identity, and tracked production latch;
- the former V2 and universal production routes remain false, and conflicting
  build flags are rejected before an artifact can be emitted;
- one separately emitted `beta-bounded` artifact proves beta/production gate
  isolation without granting authority to ordinary E2E or universal artifacts;
- an R2-record descriptor registry keeps keys, nonce material, and object
  records module-private and exposes only a frozen body-free reference;
- its delivery provider supports exact-scope abort, retirement, sequential
  fresh-source reopening, and bounded source preflight;
- `LegacyBoundedFilePort` owns one dedicated `FilePlaybackManager`, issues
  opaque process-local leases, stages silently, primes only from the fresh
  commit-time V1 position, and fences every native transition; and
- playback/source/renderer failure has no room transport callback.

The narrow V1 bridge is wired into standard-room production and the isolated
beta artifact:

- the bridge is the sole bounded-file authority in standard rooms; the former
  V2 application session, router, host owner, guest owner, and controller stay
  disabled;
- host Blob preparation publishes one encrypted, generation-scoped R2 record
  descriptor and retains the exact source for local replay;
- capability and descriptor negotiation happens per connection, so one old or
  incompatible guest falls back to unchanged V1 without changing the engine
  selected by other guests;
- the descriptor/legacy selection boundary settles before PLAY or PAUSE is
  released to that peer, including late join and delayed connection
  classification;
- play and playing-seek use a schedule-then-started rendezvous, while pause,
  stop, and terminal deselection update canonical V1 UI state immediately and
  drain native output behind exact incarnation fences;
- a replacement, queue removal, empty snapshot, end of playlist, owner switch,
  connection replacement, room exit, or failed preparation retires only the
  captured queue-item/session/source tuple;
- an unmarked stable-V1 prepare cannot adopt its AudioBuffer until an unrelated
  bounded predecessor has physically retired; and
- decoder, source, renderer, and fallback failures remain playback-local and
  have no room-connection close capability.

The promoted standard-room source policy admits native FLAC and linear PCM plus
bounded MP3 and M4A AAC-LC. Raw ADTS `.aac` deliberately remains on unchanged V1:
without an authenticated frame-index sidecar, its WebCodecs admission scan must
read the complete object before readiness and would defeat the early-start and
multi-device bandwidth goals of this slice. Unsupported content and missing
WebCodecs capability choose V1 before audible bounded ownership.

This first product slice remains limited to standard rooms because their R2
publication identity is already application-session and transfer-generation
scoped. PRO rooms remain on stable V1 until a separate adapter can bind its
persistent media generation, server playback revision, credential lifetime,
and range-source ownership without reintroducing the rolled-back layered
controller.

The initial production promotion requires targeted candidate and live R2
smokes. Multi-guest late join, background resume, repeated seek/pause/play,
mixed bounded/V1 peers, and iOS autoplay recovery remain part of the monitored
physical-device rollout. Production builds must keep the beta artifact absent,
prove the exact production artifact identity, and reject every conflicting
retired-V2 flag or latch combination.
