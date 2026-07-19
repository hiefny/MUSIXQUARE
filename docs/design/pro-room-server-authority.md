# ADR: Coordinator-free server authority for PRO rooms

- **Status:** Accepted; implementation checkpoint complete (local validation)
- **Decision date:** 2026-07-20
- **Applies to:** persistent PRO rooms in the reserved `0xxxxx` namespace
- **Does not apply to:** ordinary temporary rooms
- **Compatibility:** the PRO cutover does not support the former
  browser-coordinator protocol. Ordinary rooms keep their existing protocol.

## Context

A PRO room is persistent: its URL, playlist, R2 media, playback position, and
sleep/wake behavior survive the departure of every browser. The superseded
implementation nevertheless elected one browser as a coordinator and projected
that browser into the ordinary-room `host` role. That browser became the live
playback clock, command executor, Developer API executor, message fan-out
point, and recovery checkpoint writer.

This contradicts the persistent-room product model. A backgrounded, suspended,
reloaded, or disconnected coordinator can temporarily remain authoritative,
publish a stale media clock, or force every other browser to rebuild its
topology. Coordinator election also exposes an implementation detail as a
user-visible role even though every authenticated PRO participant is intended
to have the same live-room controls.

PRO already has one serialized Durable Object per room, authenticated
participant sessions, persistent queue state, direct R2 downloads, and a
server-side clock. The room server is therefore the natural single authority.

## Decision

### 1. Authority boundary

PRO rooms have **no browser coordinator and no browser host**. The
`MusixquareProRoom` Durable Object is the only manager of:

- canonical playback state and ordering;
- playback command authorization and idempotency;
- transition creation and supersession;
- the PREPARE/READY/COMMIT/CANCEL barrier;
- automatic advance arbitration;
- persistent sleep and wake state; and
- authoritative PRO presence and the source events consumed by live-room
  fan-out.

Every authenticated PRO participant is equal in the live playback plane. Any
participant may play, pause, seek, select, skip, and use the shared queue
controls allowed by the room policy. The owner credential remains meaningful
for PIN and recovery security, while Access-protected operators retain
suspension and permanent-deletion lifecycle authority. Neither receives a
stronger playback clock or command precedence. A temporary system-audio
publisher lease identifies the media source only and never creates a room
manager.

The server manages state; browsers still download, decode, render, apply audio
effects, and schedule output locally. This decision does not stream decoded
audio through the Durable Object.

### 2. Ordinary rooms remain host-authoritative P2P rooms

Ordinary rooms keep their temporary host/guest contract and current P2P data
path. Their host remains the playback authority, and the room ends when that
host ends it. Signaling continues to provide admission and SDP/ICE without
becoming a persistent playback dependency.

The two room types may share frame types, revision checks, clock sampling, and
the local media executor, but they must not share an authority implementation:

| Room type | Authority           | Control transport                              | Persistence                  |
| --------- | ------------------- | ---------------------------------------------- | ---------------------------- |
| Ordinary  | browser host        | existing P2P host/guest transport              | none                         |
| PRO       | room Durable Object | authenticated hibernatable signaling WebSocket | canonical queue and timeline |

This preserves ordinary-room privacy and availability: an established P2P room
does not begin sending its playback history to the server and does not lose all
controls merely because the PRO control service is unavailable.

### 3. PRO control transport

Each participant opens one authenticated, room-scoped event WebSocket and uses
the cookie-authenticated room API for idempotent mutations. The physical
WebSocket and its hibernatable attachments belong to the signaling Durable
Object. The PRO room Durable Object does not keep browser sockets: it owns the
canonical state and reducer, then calls the signaling object to fan out a
bounded server event. The WebSocket upgrade uses a short-lived, one-use ticket
bound to the current participant, server-issued presence incarnation, presence
revision, control incarnation, and monotonically increasing per-session ticket
sequence. Its socket attachment, rather than a client-supplied identity field,
authenticates every later realtime frame.

Playback commands and READY reports use HTTP because their typed response,
idempotency receipt, and conflict snapshot are part of the mutation contract.
Canonical PREPARE/COMMIT/CANCEL events and presence invalidation originate in
the PRO room Durable Object and are delivered by the signaling Durable Object.
Chat fan-out and clock sampling terminate directly at the signaling object, but
cannot mutate the canonical queue or playback anchor. This is one logical
control plane, not a browser-to-browser authority path.

Queue-addition system rows originate from the room server event and are
rendered once by each participant; browsers do not relay that event back into
the room. The few remaining client-originated system rows use an exact
signaling allowlist with fixed localization keys and schemas, so arbitrary
participant text cannot impersonate a system message.

The PRO control channel is independent from ordinary-room signaling and from
media delivery. SDP/ICE or Cloudflare Realtime negotiation may use a separate
transport, but those transports cannot originate playback authority events.
No PRO playback event is trusted because it arrived through a peer connection.

The minimal frame families are:

| Transport              | Operation                       | Purpose                                                          |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------- |
| room API               | snapshot / heartbeat            | deliver canonical state after connect, gap, or recovery          |
| WebSocket              | clock request / response        | estimate server-clock offset and RTT                             |
| room API               | playback command                | idempotent play, pause, seek, select, next, or previous intent   |
| room API response      | command result                  | accepted revision or typed conflict for the caller               |
| WebSocket server event | playback PREPARE                | identify an exact target and bounded readiness decision          |
| room API               | playback READY                  | prove that this presence incarnation armed that exact transition |
| WebSocket server event | playback COMMIT                 | publish the sole audible start/paused anchor                     |
| WebSocket server event | playback CANCEL                 | cancel a superseded or invalid transition                        |
| room API               | ended / unavailable observation | submit a revision-fenced media observation                       |
| snapshot + local prep  | late-join catch-up              | project the current anchor without restarting the room           |

Frames use an exact-key schema and a protocol version. Payload sizes, numeric
ranges, target kinds, and string formats are validated before state access.
Unknown or stale frames are rejected without mutating the room.

### 4. Canonical timeline and fences

The Durable Object stores a non-ticking anchor rather than writing once per
second. The first schema retains several transitional wire names:

```text
presence.coordinatorEpoch       room/control incarnation fence
playback.revision               canonical playback revision
playlistRevision                canonical queue revision
runtime                         awake | sleeping
playback.state                  idle | paused | playing
playback.queueItemId            queue occurrence or null
playback.youtubeVideoId/index   immutable YouTube identity when applicable
playback.positionSeconds        position at the anchor
playback.updatedAtMs            anchor server time
pendingPlaybackTransition       null | persisted PREPARE/cohort/READY descriptor
```

For a playing state, canonical position at server time `t` is:

```text
playback.positionSeconds + (t - playback.updatedAtMs) / 1000
```

Paused and sleeping states do not advance. The server rewrites the anchor only
on a meaningful mutation, sleep boundary, or accepted recovery action. Browser
observations may be telemetry, but they cannot overwrite the anchor.

Every mutating request is authenticated to the current member and presence
incarnation. It also carries a cryptographically random idempotency key and the
base revision required by that endpoint: playback commands use
`playback.revision`, queue snapshots use the room CAS revision, and effects or
queue-mode writes use their own revision contract. The server serializes the
mutation, stores a bounded idempotency receipt where the endpoint requires one,
and returns either the accepted state or a typed revision conflict. Reusing the
same key can therefore recover a lost response without repeating a seek, skip,
or queue transition.

The following fences are independent and all must match where applicable:

- `coordinatorEpoch` (control incarnation): advances at empty-room sleep/wake
  and hard security/lifecycle boundaries; explicit tab takeover rotates only
  that participant's presence incarnation; it is never an elected-participant
  epoch;
- `presenceIncarnationId`: fences an older tab using the same cookie session;
- `playbackRevision`: orders every canonical playback mutation;
- room and playlist revisions: serialize queue mutations and projections;
- server-issued `transitionId` plus `basePlaybackRevision`: identify one
  readiness barrier; and
- immutable target identity: `queueItemId` plus the canonical R2 asset or
  YouTube video/sub-index identity derived by the server.

An ordinary participant joining or leaving an already-awake, non-empty room
does not advance the control incarnation. The empty-room sleep boundary and
first-member wake do. There is no election epoch because there is no elected
authority.

### 5. Server clock synchronization

Audible scheduling uses the server clock, not another browser's clock. The
client sends a `pro-clock` request ID and `clientSentAtMs` over its signaling
socket; signaling echoes those fields with `serverTimeMs`. The browser computes
an NTP-style midpoint offset and RTT, keeps the lowest-RTT sample in the current
sampling window, samples at 0/120/300/700/1,500 ms after connect, refreshes the
window every 30 seconds, and maps PREPARE deadlines and COMMIT timestamps
through that offset. A sample is READY-fresh for five seconds.

A browser may prepare media without a fresh sample, but it reports READY only
after calibration is fresh at the decision boundary; otherwise it reports
failed and later uses exact-checkpoint catch-up. READY v1 reports only
`ready | failed`, not an asserted uncertainty value. Existing platform-specific
YouTube output-delay compensation remains local execution data and must not
change the canonical room timeline.

### 6. PREPARE → READY → COMMIT

Commands that can begin or relocate audible playback—select, play/resume,
playing seek, next/previous, automatic advance, and wake—use one server-owned
transition:

1. The server aborts any older transition, resolves the target from the
   canonical queue, increments `playbackRevision`, persists a PREPARE descriptor,
   and broadcasts `playback.prepare`.
2. The candidate set is the bounded authoritative active-presence set at
   PREPARE, represented by server-issued presence-incarnation IDs. It is not
   derived by asking the PRO object to enumerate signaling sockets. A presence
   that joins later cannot delay that transition; a departing presence is
   removed from the cohort.
3. Each browser loads or resolves the exact server-fixed source, seeks
   silently, calibrates its clock, and sends one `playback.ready` result. The
   server fences it to the authenticated presence incarnation, transition ID,
   and base playback revision; the local preparation token carries the target
   identity.
4. When every candidate is ready, or the bounded decision deadline arrives,
   the server fixes the canonical target and chooses a future `executeAtMs`
   using the configured COMMIT lead.
5. The server persists the playing anchor and broadcasts one
   `playback.commit`. Only that frame may make a prepared client audible.
6. A candidate that did not become ready is excluded; the room starts without
   it, and it later follows the catch-up path.

Pause is a server-ordered sound-off commit and does not wait for readiness.
Seeking while paused updates a paused anchor without making sound. A later play
still uses the barrier.

A newly accepted command atomically supersedes an in-flight transition. The
server publishes `playback.cancel` for the old `transitionId`; late READY,
COMMIT, timer, report, and media callbacks for it are harmless because their
fences no longer match.

The readiness deadline is bounded by policy (initially the existing three
second user-facing budget), and every COMMIT receives a fixed 700 ms future
lead from the server decision time. Normal all-ready transitions commit
immediately. The PRO room Durable Object persists that deadline and installs a
one-shot alarm; there is no client deadline-nudge endpoint and no recurring
server timer. If persistence completes after the nominal deadline, alarm
scheduling uses a next-tick deadline so PREPARE cannot remain stranded.

### 7. Late join and recovery

A late participant receives the canonical snapshot, opens the signaling
channel, and starts a clock-sample burst. It downloads the same R2 object or
resolves the same YouTube identity, then prepares a local catch-up fenced to
the current control incarnation, playback revision, and target. This is not a
new server transition and does not add the participant to an already-frozen
PREPARE cohort.

- For paused playback, it seeks to the canonical paused position and remains
  paused.
- For playing playback, the browser projects the non-ticking server anchor to
  its best current server-time estimate after local preparation, then joins at
  that projected position. A fresh clock sample is required to report on-time
  READY, but snapshot catch-up can use the receive-time fallback while
  calibration converges. A COMMIT received without a matching prepared run uses
  the same revision-and-target-exact catch-up path.
- If the room revision changes during preparation, catch-up is cancelled and
  restarted from the newer snapshot.

Late join never opens a new room-wide barrier and never rewinds participants
that are already playing.

### 8. ENDED and unavailable arbitration

Browsers report observations; they do not directly advance the room. Every
`ended` or `unavailable` command uses a unique idempotency key and includes the
exact locally accepted playback revision, queue/media identity, observed
position, and finite duration when the browser exposes one. The observation
revision is captured before entering the client command queue and is never
rebased onto a later canonical revision.

- An `ended` report is accepted only for the currently committed playing
  target. For finite media, both the observed cursor and server-projected anchor
  must be within `min(2 s, max(250 ms, duration * 1%))` of the declared end. For
  live/unknown-duration YouTube media, the revision must have played for at
  least 750 ms and the observed cursor must be within 10 seconds of the server
  projection. This narrow fallback avoids rejecting every legitimate
  live-stream end without accepting an immediate spurious event. The first
  accepted report performs one compare-and-swap advance; duplicates become
  stale after the revision changes.
- The initial `unavailable` policy preserves global skip, but exact revision,
  queue occurrence, media kind, and YouTube sub-item identity are checked before
  the one server reducer can advance. Per-device attribution and quorum policy
  remain a later product decision rather than an implied property of v1.
- Reports from a prior item, prior transition, replaced tab, prior control
  epoch, or already-advanced revision cannot affect playback.

Queue traversal, shuffle, repeat-one, repeat-all, and YouTube playlist
sub-index selection are server reducer operations. UI controls, ENDED reports,
BOT requests, and Developer API requests all invoke that same reducer.

### 9. Presence, sleep, and wake

Presence remains a server-owned membership concept and contains no coordinator
identity. The first snapshot schema retains only a
`coordinatorParticipantId: null` compatibility field. When the final
participant disappears, the Durable Object:

1. projects the current playing anchor to the server removal time;
2. records whether the room should resume playing;
3. aborts an unfinished transition;
4. changes the runtime to `sleeping`; and
5. persists once.

No departing browser supplies an authoritative final playback checkpoint. An
explicit HTTP presence close provides the best boundary. A dropped WebSocket
does not itself rewrite canonical presence; heartbeat expiry remains the
fail-safe for an abruptly vanished device.

The first returning participant wakes membership but does not unilaterally
start audio. If the frozen playback state is `playing`, the server creates a
wake PREPARE whose initial cohort contains that returning presence. It commits
when the cohort is all ready or when the bounded deadline alarm fires.
Additional participants do not enlarge that cohort and use the pending
transition or late catch-up path.

### 10. Hibernation and cost boundary

Hibernation has two separate ownership boundaries:

- the signaling Durable Object owns the hibernatable browser sockets and
  bounded authenticated attachments (room, participant, presence incarnation,
  control incarnation, ticket sequence, and rate-limit state); and
- the PRO room Durable Object owns the persisted canonical room state,
  transition descriptor, cohort, and READY map, but no browser sockets.

The signaling object validates its persisted authoritative presence high-water
mark when a socket is admitted or rehydrated. The PRO object reconstructs an
active transition from storage, not from signaling attachments.

Authoritative playback delivery is also durable. The PRO object persists a
bounded, revision-fenced PREPARE/CANCEL/COMMIT outbox in the same transaction
as the canonical state change. Signaling delivery is at-least-once; successful
fan-out removes the record, while timeout, partial fan-out, or service failure
is retried by alarm until a newer canonical revision supersedes it. Client
revision and transition fences make duplicate delivery harmless.

The canonical timeline advances mathematically from its stored timestamp; it
does not require heartbeat writes, a ticking interval, or continuous Durable
Object execution. Alarms are one-shot and used only for existing expiry/GC
work and an active transition deadline. A transition definition is durable;
READY is idempotent and may be resent after recovery.

Presence liveness currently uses the bounded HTTP heartbeat/expiry lease. That
lease may wake the PRO object for membership durability, but playback
correctness does not depend on a browser checkpoint or on a periodically awake
coordinator.

### 11. Failure semantics

- **Control socket lost before COMMIT:** the browser cancels the prepared run
  and remains silent.
- **Control socket lost after COMMIT:** already committed playback may continue
  from the last canonical anchor. The client enters recovery, reconnects the
  realtime channel, and applies a heartbeat snapshot rather than promoting
  itself to authority.
- **Reconnect or revision gap:** fetch/apply a complete snapshot, discard all
  stale callbacks, then use late catch-up. Events are never applied across a
  revision gap by guesswork.
- **Command response lost:** a caller may retry the same idempotency key; the
  server replays the bounded receipt where that endpoint supports receipts.
- **PRO Durable Object isolate restart:** reload the persisted anchor,
  transition, cohort, and READY map. Existing signaling sockets remain owned by
  the signaling object; a reconnecting participant receives the pending
  PREPARE in its ticket response, while the persisted one-shot alarm still
  decides the transition deadline.
- **Signaling Durable Object isolate restart:** rehydrate sockets from their
  attachments, validate them against the persisted room/control and presence
  high-water fences, and close stale incarnations. Canonical playback remains
  in the PRO object.
- **Playback fan-out unavailable:** retain the persisted playback outbox and
  retry it in revision order. A failed PREPARE may be superseded by its COMMIT;
  an undelivered COMMIT is retained ahead of a later PREPARE so reconnecting
  clients never observe the newer transition without its canonical base.
- **Presence fan-out unavailable:** after the bounded immediate attempts, the
  PRO object persists the newest presence revision and retries it from its
  alarm with bounded exponential backoff. A newer full presence snapshot
  supersedes an older failed delivery, and a successful delivery clears the
  durable marker. Revoked sockets therefore do not depend on unrelated future
  room traffic to receive the new high-water fence.
- **Deadline alarm delayed:** synchronization remains correct because the
  server chooses a new future COMMIT time after waking; only the wait becomes
  longer. A delayed alarm never authorizes a past start.
- **R2 or YouTube unavailable:** keep the canonical transition fenced and apply
  the server's unavailable policy. A client never silently chooses another
  track.
- **PRO control service unavailable:** ordinary rooms are unaffected. PRO
  clients may finish the current committed segment locally, but no new state
  mutation is accepted until server authority returns.

### 12. Implementation boundary

Introduce shared abstractions instead of adding more `room.kind === 'pro'`
branches to the legacy host facade:

- `RoomRealtimeTransport`: connect, send intent/READY/report, receive events,
  expose presence, disconnect;
- `AuthenticatedEventSource`: server-authenticated actor/incarnation and
  capabilities;
- `AuthoritativeTimeline`: canonical anchor plus fences; and
- a source-neutral local playback executor that applies PREPARE, COMMIT, CANCEL,
  and catch-up.

The ordinary-room adapter remains the existing P2P host implementation. The
PRO adapter is the authenticated server channel. The coordinator election,
browser command executor, peer-star relay, and `connectProRoomTransport()`
authority path have been removed from the PRO runtime. Shared queue, chat,
effects, system-audio, file/R2, and YouTube modules now receive server-owned
PRO state through their dedicated adapters. Ordinary-room PeerJS behavior is
unchanged.

### 13. Transitional compatibility names

The first implementation checkpoint deliberately retains two internal names
without retaining their former authority semantics:

- persisted and wire-level `coordinatorEpoch` is the room/control incarnation
  fence; no participant ID is paired with it and no browser can advance it;
- local `network.appRole = 'host'` with `hostConn = null` is a compatibility
  mode for the shared media/UI shell; it creates no peer topology and grants no
  server capability.

Renaming these values belongs to a later snapshot/wire schema version. Until
then, new code must derive PRO permissions from `room.context.capabilities` and
must never infer PRO authority from `appRole`, `hostConn`, or the legacy field
name.

## Deployment and cutover

There is no mixed old/new PRO protocol. Use a short PRO-only maintenance window;
ordinary rooms remain live.

1. Back up/export PRO Durable Object and registry state and record the current
   Worker version IDs.
2. Enable a PRO maintenance gate that freezes each current anchor and rejects
   new old-protocol entry with a typed `PRO_PROTOCOL_UPGRADE_REQUIRED` result.
3. Deploy signaling changes that remove browser-coordinator authority, add the
   hibernatable equal-member socket path, and retain media/decommission
   dependencies required by the new server path.
4. Deploy the PRO Worker schema, canonical reducer, timeline, and transition
   alarms.
5. Deploy the app Worker facade changes needed to pass the same-origin
   WebSocket upgrade.
6. Deploy the client and service-worker version that contains only the
   server-authority PRO adapter. Cached old clients remain rejected rather than
   joining a split control plane.
7. Run the control, sleep/wake, late-join, YouTube zero-start, R2 file,
   Developer API, BOT, ENDED, unavailable, and physical iOS/Android smoke
   matrix. Reopen PRO entry only after version IDs and live results are saved.
8. After the observation window, rename transitional `coordinatorEpoch` and
   local-host compatibility symbols in a versioned schema change. Signaling
   tickets remain part of the server channel; former browser-coordinator
   election, command-dispatch/ACK storage, and peer-star branches do not.

A rollback cannot re-enable an old browser coordinator against already-mutated
server-authority state. During cutover, rollback means keeping PRO in
maintenance and restoring the matched Worker/client/data checkpoint, or
forward-fixing the new protocol.

## Rejected alternatives

### Keep coordinator election and improve failover

Rejected. Faster election reduces an outage window but does not remove the
wrong authority boundary, stale browser clocks, host-role projection, or
topology rebuilds caused by a manager tab.

### Make every room server-authoritative

Rejected. Ordinary rooms are intentionally ephemeral and host-owned. Applying
the PRO manager to them would add server cost, playback metadata exposure, and
a new outage dependency without providing persistent-room benefits.

### Store only periodic browser checkpoints

Rejected. A checkpoint is an observation taken after local execution. It
cannot serialize concurrent commands, fence ENDED, or provide a shared future
COMMIT time, and it becomes stale when the writer is backgrounded.

## Documentation alignment

The persistent-room operations document, heartbeat ADR/benchmark, and
historical full-project audit now distinguish the server-owned PRO control
plane from ordinary-room host behavior. In particular, a system-audio publisher
lease is not room authority, presence topology is not an election, and
hibernatable sockets belong to signaling rather than to the canonical-state
object.

The ordinary-room host descriptions in `README.md`,
`docs/design/playback-state-machine.md`, and
`docs/project-analysis/2026-05-24/*` are **not** conflicts when they describe
ordinary rooms. They should be labelled as ordinary-room/P2P behavior wherever
the scope could otherwise be mistaken for PRO.

## Acceptance criteria

- No PRO snapshot, ticket, UI state, or protocol event exposes a non-null
  coordinator participant or depends on one. The first schema may still expose
  `coordinatorParticipantId: null` and the transitional `coordinatorEpoch`
  control-incarnation name.
- No browser-originated timestamp or playback checkpoint can replace the
  canonical server anchor.
- Concurrent UI, BOT, Developer API, ENDED, and unavailable actions converge
  through one reducer and one monotonic revision order.
- A stale tab, old transition, old item, or duplicate command cannot mutate
  current playback.
- A late participant catches up without restarting or rewinding the room.
- Empty-room sleep and first-participant wake work without electing a browser.
- The PRO state object can remain inactive while playback is logically running,
  and the signaling object can hibernate with browser WebSockets attached.
- Ordinary rooms retain their host-P2P behavior and continue operating during
  a PRO control-plane outage.
