# Streaming Playback Engine V2

- **Status:** Accepted; implementation in progress
- **Decision date:** 2026-07-12
- **Applies to:** file playback, playback synchronization, remote file sharing,
  participant recovery, and playback-related system messages
- **Rollback baseline:** `9a9db6fd8e26d7e96a33ce8212263f023b8ced5d`

> **Scope update (2026-07-13):** The FLAC-only rollout and ordinary-codec
> AudioBuffer fallback described below are superseded by
> `universal-bounded-streaming-engine.md`. The synchronization, ownership,
> rendezvous, recovery, and rollback decisions in this document remain active.
> FLAC-only lab results and rollout steps below are retained as historical
> evidence, not as the current format-availability matrix.

## Production release status (2026-07-28)

This section records the current deployed route. The header's
“implementation in progress” label, FLAC-first milestones, and delivery
sequence below are preserved as historical design evidence.

- The immutable production selection is `v2-current`: the V2 release latch is
  enabled, and the optional universal bounded MP3/AAC/M4A flag is disabled.
- The engine is active only in standard rooms; PRO rooms continue to use the
  legacy playback and transport implementation.
- Host-only playback reads the local source directly. One or two guests with
  known-local topology use peer-range reads. Each remote or locality-unknown
  guest uses encrypted R2 records; once three or more connected guests are
  known-local, those local guests also use the shared R2 publication.
- Current V2 formats use bounded decoding. Ordinary current-route media and
  unsupported extensions retain V1-like behavior while universal compressed
  routing is disabled.
- R2 publication establishes record-0 readiness for the rendezvous and
  continues the remaining records in the background. Readers keep only one
  decrypted plaintext record and wait at most 60 seconds for a missing record
  before entering failure or recovery.

## Product goal

MUSIXQUARE must keep millisecond-class synchronized playback while accepting
high-resolution FLAC files whose fully decoded PCM would be too large for a
browser `AudioBuffer`. A slow, interrupted, or backgrounded participant must
not stop an otherwise healthy room.

The successful stream-engine lab proved a bounded-memory FLAC decoder, a
RAM-only PCM ring, output-frame scheduling, and a multi-step start barrier on
physical Windows and iOS devices. The lab is evidence for the primitives, not
a drop-in product implementation: it is FLAC-only, one-shot, 1:1, connects
directly to the destination, and does not implement pause, seek, replay,
preload, queue ownership, effects, or participant recovery.

## Decisions

### Original FLAC-first decoder decision (historical)

The product has one authoritative playback timeline and one rendezvous
coordinator. Decode/storage implementation is an adapter below that common
clock:

- `AudioBuffer` was retained for current-route ordinary formats in the initial
  product slice.
- A streaming FLAC backend reads encoded bytes in bounded chunks, decodes and
  resamples in a worker, and feeds a bounded `AudioWorklet` ring.

This is one synchronization engine, not two playback clocks. Both backends arm
against the same future output time, report the same readiness and renderer
health contract, and connect to the same existing MUSIXQUARE effects and
channel-routing graph. A fake `AudioBuffer` must never be used to disguise a
streaming source.

In that slice, the streaming backend was selected from verified FLAC metadata.
Unsupported or invalid FLAC input failed explicitly rather than falling
through to a `MediaElement` clock. The universal ADR now governs bounded
format selection; the `AudioBuffer` language here describes only the retained
legacy/current-route fallback, not the target engine for every non-FLAC file.

### RAM-only and bounded memory

The accepted RAM-only ADR remains authoritative. The production path does not
store media bodies or decoded PCM in OPFS or IndexedDB and does not construct a
Service Worker-backed virtual file.

The streaming path uses:

- 64 KiB sequential encoded reads;
- a decoder/resampler worker;
- a one-to-eight-channel PCM ring with a fixed capacity and explicit high/low water marks;
- transferable channel buffers between worker and worklet; and
- deterministic teardown of readers, WASM decoders, resamplers, ports,
  worklets, and source handles on supersession.

The ring is a playback working set, not a whole-track cache. Seek creates a new
decoder generation and primes from the requested FLAC position or an indexed
frame boundary. Superseded generations cannot publish PCM or state.

### Source abstraction

Encoded bytes are represented by an explicit source handle rather than by a
mandatory resident `Blob`:

```ts
interface EncodedAudioSource {
  readonly kind: 'blob' | 'peer-range' | 'r2-records';
  readonly size: number;
  readonly identity: string;
  readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}
```

The first adapter covers local `File` objects and fully received LAN/P2P
`Blob`s. A bounded peer-range adapter then replaces whole-file receive for
large LAN transfers: the guest requests exact encoded ranges on the control
lane and the host returns bounded chunks on the bulk lane, keyed by source,
request, offset, and chunk index. It supports backpressure, cancellation, and
random reads for seek without retaining the whole encoded file.

The R2 adapter is a separate transport milestone because the current
single-tag AES-GCM object cannot be authenticated or decrypted by range.

R2 V2 uses 8 MiB independent AES-GCM records and multipart upload. One record
is one multipart part. The guest validates and authenticates a complete record
before exposing its plaintext to the decoder, retains at most one plaintext
record cache, and rechecks cancellation before and after every fetch and
decrypt operation. It uses direct, exact `Range` reads; no browser-local
persistent media store is involved.

Encryption authority is deliberately asymmetric. `createEncryptor(objectId,
size)` is the only API that can generate an upload key/nonce domain; an
arbitrary received descriptor can create only a decryptor. The encryptor moves
strictly from record 0 through record N-1 and issues one opaque ciphertext
lease at a time. Upload retry reuses the exact leased bytes, and the next record
cannot be encrypted until the current lease is acknowledged. Once WebCrypto
has been invoked, abort or failure poisons that encryptor and requires a new
key, nonce prefix, manifest, and multipart upload. This prevents accidental
AES-GCM nonce reuse even across retry paths.

R2 object metadata is redacted and contains no key. The protected signaling
descriptor adds `keyB64`; the runtime cipher imports it into a non-extractable
`CryptoKey` and does not expose it through enumerable instance state. Disposal
zeros the retained nonce bytes, releases the key reference and record lease,
and permanently closes the instance. JavaScript strings and `CryptoKey`
objects cannot promise physical memory erasure, so the protected descriptor is
kept short-lived and never stored beside ciphertext.

### Existing audio graph is preserved

Every file backend connects to the product graph input in `src/audio/engine.ts`.
It must preserve widener, preamp, channel split/routing, EQ, reverb, virtual
bass, exciter, master gain, analyser, and surround selection. A backend must
not connect directly to `AudioContext.destination`.

Channel selection remains a downstream product concern. The lab's private
left/right output mode is not ported.

The product backend supports one through eight FLAC channels instead of
silently discarding channels after stereo. Ring capacity is fixed in seconds
and therefore scales predictably with the verified channel count. Files beyond
the supported channel contract fail before decoder publication.

### Canonical monotonic timeline

The room's truth is a monotonic host timeline, not the audible position of the
host speaker:

```ts
interface PlaybackTimeline {
  playbackRevision: number;
  runId: string | null;
  queueItemId: QueueItemId | null;
  mode: 'file' | 'youtube' | 'system-audio' | null;
  activity: 'idle' | 'paused' | 'playing';
  anchorHostTime: number;
  mediaPositionAtAnchor: number;
  rate: number;
}
```

The host output is a participant. If the host AudioContext is interrupted, the
timeline and healthy guest outputs continue.

`queueItemId` remains the immutable identity of one queue occurrence. Playback
identity is deliberately split into three nested scopes:

```ts
type PlaybackRun = { queueItemId: QueueItemId; runId: string };
type PlaybackState = PlaybackRun & { revision: number };
type PlaybackAttempt = PlaybackState & { rendezvousId: string };
```

- A run binds one selected queue occurrence to its prepared media. Pause,
  seek, and resume do not invent a different media binding.
- A state is one semantic timeline revision. The first applied state is
  positive; every subsequent state transition is exactly `revision + 1`.
- An attempt is one physical ARM/FINALIZE exchange. Renderer recovery may use
  a fresh rendezvous ID for the same state without fabricating a new timeline
  revision.
- `controlSequence` prevents replay on one ordered connection. It is not a
  playback revision, run ID, or rendezvous ID.
- File-transfer `sessionId` remains independent of all three playback scopes.

The transition policy is binding:

| Command                 | Run     | Revision | Rendezvous                   |
| ----------------------- | ------- | -------- | ---------------------------- |
| first play              | new     | +1       | new                          |
| pause                   | same    | +1       | none                         |
| paused seek             | same    | +1       | none                         |
| playing seek            | same    | +1       | new                          |
| resume                  | same    | +1       | new                          |
| renderer recovery       | same    | same     | new, target participant only |
| restart or track change | new     | +1       | new                          |
| stop                    | retired | +1       | none                         |
| exact transport retry   | same    | same     | same, idempotent             |

An attempt-specific cancellation includes the rendezvous ID and can retire
only that silent candidate. A logical stop targets the state/run separately.
Neither operation is represented by the other.

### Atomic audible cutover

Prepared media and audible renderers have different lifetimes. A prepared
encoded asset owns the stable Blob, peer-range handle, or R2 manifest and can
issue bounded reader leases. The playback manager owns at most two live
renderer instances for one output lane:

```text
AUDIBLE (gain 1) + CANDIDATE (gain 0) -> FINALIZE at one context frame -> new AUDIBLE
```

ARM always builds and primes a separate silent candidate. It never seeks,
stops, disconnects, or mutates the currently audible renderer. Before the
target frame, candidate rejection or cancellation destroys only the candidate
and leaves the old renderer intact. At a successful target, the manager opens
the candidate gate and closes the old gate at the same AudioContext time, then
destroys the old renderer only after start evidence belongs to the finalized
attempt. Same-media recovery may use a short 20-50 ms fade to avoid clicks;
track changes retain an exact scheduled boundary rather than blending songs.

After the canonical target has passed, an output failure must not resurrect
the old timeline. That participant starts a same-state, new-rendezvous recovery
while healthy participants continue. Asset close aborts all leases and releases
a peer-range handle exactly once; individual renderer teardown must not consume
a new host handle or close a handle still used by its sibling.

The renderer port returns the exact local target chosen by its backend. The
manager schedules both outer gates against that same AudioContext frame; it
does not independently remap room time. Streaming FLAC reports an observed
Worklet start frame, while a legacy/current-route `AudioBuffer` fallback
reports only that its Web Audio schedule boundary has passed. Those evidence
classes remain distinct and neither is upgraded into a stronger claim by the
manager.

### Clock quality and rendezvous

File synchronization uses four-timestamp NTP samples based on
`performance.now()`, a best-five median offset, and freshness, spread, and RTT
quality leases. `Date.now()` is not used for frame scheduling.

The playback barrier is:

```text
MEDIA_PREPARE -> MEDIA_READY
RENDEZVOUS_PROPOSE -> RENDEZVOUS_ARMED -> RENDEZVOUS_FINALIZE
```

An armed renderer remains silent until finalized. If finalization is absent or
stale at the target, that participant cancels and stays silent. A newer
revision cancels every older reservation.

Lead time is dynamic:

```text
clamp(max(450 ms, max cohort(2 * RTT p95 + arm p95 + 200 ms)), 450 ms, 2500 ms)
```

Cold download/decode belongs in `MEDIA_PREPARE`; it is not added to every play
button press. The coordinator proposes in parallel to participants with a
valid READY lease, finalizes those armed before the deadline, and never waits
for a numerical majority. The canonical timeline advances at the target even
when one participant is late.

### Session and lane rules

Production keeps the existing Cloudflare signaling transport and separate
ordered control and bulk RTC data channels. The PeerJS lab transport is not
ported.

New control messages use a versioned session/connection envelope and a
monotonic control sequence. Bulk transfer messages do not share that sequence:
they remain ordered by transfer `sessionId` and chunk index because ordering
across two RTC data channels is not defined.

Room application is explicit:

```text
SESSION_HELLO -> SESSION_WELCOME -> SESSION_SNAPSHOT -> SESSION_APPLIED
```

Each established connection owns a bounded registry of at most two playback
state bindings: committed current and staged candidate. Attempt-scoped frames
also carry an exact rendezvous lease, so same-state recovery may keep its old
and new attempts distinct. Known retired bindings are bounded tombstones and
late frames are dropped as stale; malformed, forged, wrong-scope, or unknown
bindings remain connection-fatal.

The application-session layer never consumes a validated wire frame by itself.
After validation and sequence commit it must synchronously hand one detached
event, with the exact live channel lease, to the single playback application
controller. Missing, throwing, duplicate, or re-entrant adoption fails closed.
Session revocation reaches that controller before the channel and room-clock
leases are closed, preventing late asynchronous work from reviving authority.

The host emits the joined-room system message only after `SESSION_APPLIED`, not
merely after a socket or data channel opens. There is no legacy positional
queue-ID fallback.

### Application-controller room boundary

The file-playback application controller is installed exactly once before
`initProtocol()` or any host/guest connection can begin. A `DataConnection`
object is a one-shot authority: after revocation or a requested close, that
same object can never establish another application epoch. Reconnection uses a
new transport object and a new connection ID.

One browser document has one room role per controller generation. The first
established connection binds that generation to `host` or `guest`; mixed-role
connections fail closed without changing the existing room timeline. Only an
explicit `controller.beginRoom()` clears that role and permits a lower revision
from a different room.

Room startup ordering is binding:

1. Application hooks are already installed during bootstrap.
2. A host first calls `ApplicationSessionManager.beginHostRoom()`, which
   revokes the old session and creates the new host room clock, then calls
   `controller.beginRoom()` synchronously before accepting a guest connection.
   The initial host timeline is anchored in that new room-clock domain.
3. A guest calls `controller.beginRoom(stopped revision 0)` before
   `ApplicationSessionManager.beginGuestConnection()`, because HELLO delivery
   may complete synchronously in a test or loopback transport.
4. Leaving ends application sessions first so revocation reaches the
   controller while each channel lease is still inspectable; the subsequent
   controller room reset fences every late continuation.

Controller mutation, transport notification, and user callbacks are separate
boundaries. Internal records and epochs commit first. Abort and close callbacks
run only after that mutation finishes. A guest product baseline commits its
timeline durably, invokes the synchronous application-session ACK exactly once,
and only then publishes user-facing callbacks. Callback failure can retire the
exact connection but cannot roll back an acknowledged timeline.

### Participant health and recovery

Transport, clock, media readiness, and renderer health are tracked separately.
The participant state is:

```text
SYNCED | DEGRADED | REJOINING | OFFLINE
```

`document.hidden` alone is not a failure. Health considers AudioContext state,
worklet render-frame progress, underruns, clock quality, RTC state, and status
leases.

After a sustained degradation, the room gets one gray system message:

```text
{{name}} 님의 연결이 불안정해요. 복구를 시도중이에요.
```

Recovery recalibrates the clock, primes the current media position, arms a new
unicast rendezvous for the same playback revision, fades in over 20-50 ms, and
then reports recovery. Other participants never stop for this process.

Unexpected transport close starts a recovery grace period and retains the
participant identity. Reconnection within the grace uses the same
participant/resume identity and does not emit another join message. Explicit
leave or grace expiry emits the leave message.

Automatic playback, transfer, join/leave, and health events use gray
`CHAT_SYSTEM` rows. Pinned `CHAT_NOTICE` is reserved for human room notices and
MUSIXQUARE operations announcements.

## Remote-share V2 contract

The existing capability challenge, presigned URLs, HMAC completion token,
origin validation, queue/session ownership, cancellation gates, and temporary
object cleanup are retained.

The new object contract adds:

- 8 MiB plaintext records, each with a 16-byte AES-GCM tag;
- a random 8-byte nonce prefix plus big-endian record index as the 12-byte IV;
- immutable authenticated metadata for format version, object identity,
  plaintext size, record size/count, and record index;
- multipart create/part/complete/abort operations with bounded retry;
- exact part length, checksum, ETag, and completion verification;
- aligned single-range downloads with strict `206`, `Content-Range`, length,
  encoding, redirect, ETag, origin, and expiry validation; and
- separate upload-window and playback/share expiry contracts.

The upload state machine never encrypts the same `(key, nonce-prefix,
record-index)` twice. A successful ciphertext stays in one immutable upload
lease until the Worker acknowledges that exact part; a transport retry sends
the same bytes. A crypto failure after invocation aborts the multipart upload
and starts with a fresh secret descriptor. Download decryptors remain
random-access and may authenticate records in seek order.

The client V2 path has no V1 fallback. During the first live rollout only, the
Cloudflare Worker may keep the current endpoints additively so reverting the
static app restores the baseline immediately. The old endpoints and resources
are removed only after the physical-device acceptance run succeeds.

Opening the encoded-size ceiling is a separate abuse and capacity decision.
Multipart support does not silently change the current 200 MiB product limit.

## Concurrency invariants

The existing load epoch, active load session, play lock, pending-play mailbox,
queue ownership, and lifecycle FSM remain binding. New decoder, source,
reservation, and rendezvous generations must compose with them:

1. A stale load or decoder generation cannot publish media, status, a timer, or
   PCM.
2. A removed `queueItemId` cannot be revived by a late source read, transfer,
   decode callback, or rendezvous response.
3. Only the newest playback revision may arm or finalize.
4. Pause, seek, stop, owner change, and track replacement cancel the old run
   before publishing the new state.
5. Preload promotion preserves its `queueItemId` and source handle and does not
   redownload or restart decoding when the array index changes.
6. Teardown is idempotent and leaves no worker, port, source read, retry, or
   scheduled output frame alive.

## Delivery sequence

Each stage is committed and validated independently. Nothing is pushed until
the owner explicitly approves the final production test.

The FLAC-specific steps in this original sequence are historical milestones.
The universal ADR supplies the current codec rollout and release gate.

1. Freeze the rollback baseline and notification semantics.
2. Add source, clock, timeline, and backend contracts with unit tests.
3. Port the bounded FLAC worker/worklet and connect it to the product graph.
4. Implement prepare, pause, resume, seek, replay, end, preload promotion, and
   teardown for local `File` and LAN `Blob` sources, then add bounded peer-range
   reads for large LAN playback.
5. Add the rendezvous barrier and migrate file playback from `hostPlayAt`.
6. Add non-blocking participant health and late rejoin.
7. Add R2 V2 record encryption, multipart upload, range source, and additive
   Worker endpoints.
8. Bring YouTube under the same coordinator while retaining its explicitly
   lower iframe timing class; system audio shares only health policy.
9. Delete superseded clocks, fixed-stage synchronization, and temporary
   compatibility code.
10. Run the full automated and physical-device acceptance matrix.

## Verification gates

Before a push is offered, the local branch must pass:

The FLAC items below are retained from the original milestone and are additive
to, not a replacement for, the universal format matrix.

- all unit, type, formatting, import, lifecycle, security, font, and production
  build guards;
- deterministic clock-quality and rendezvous cancellation tests;
- worker/worklet ring tests for prime, exact arm, finalize, pause, seek,
  underrun, overflow, EOF, and stale generation;
- local-vs-R2 FLAC output frame count and PCM hash checks;
- record tamper, range, retry, abort, expiry, and multipart recovery tests;
- host plus multiple guest tests where one guest is slow, interrupted, late,
  or reconnecting without stopping the healthy cohort;
- reorder/removal/preload ownership regression tests; and
- a production-build browser run covering ordinary formats and streaming FLAC.

The physical production-origin acceptance after approved push must cover iOS
Safari, installed iOS PWA, and Windows with the 352.8 kHz/24-bit FLAC fixture,
repeat playback, pause/seek/replay, foreground/background recovery, LAN and R2
sharing, and bounded-memory observation. Failure triggers immediate static-app
rollback to the recorded baseline; additive V1 Worker endpoints make that
rollback independent of the V2 cleanup step.
