# Streaming Playback Engine V2

- **Status:** Accepted; implementation in progress
- **Decision date:** 2026-07-12
- **Applies to:** file playback, playback synchronization, remote file sharing,
  participant recovery, and playback-related system messages
- **Rollback baseline:** `9a9db6fd8e26d7e96a33ce8212263f023b8ced5d`

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

### One playback coordinator, multiple decode backends

The product has one authoritative playback timeline and one rendezvous
coordinator. Decode/storage implementation is an adapter below that common
clock:

- `AudioBuffer` remains the decode backend for supported ordinary formats.
- A streaming FLAC backend reads encoded bytes in bounded chunks, decodes and
  resamples in a worker, and feeds a bounded `AudioWorklet` ring.

This is one synchronization engine, not two playback clocks. Both backends arm
against the same future output time, report the same readiness and renderer
health contract, and connect to the same existing MUSIXQUARE effects and
channel-routing graph. A fake `AudioBuffer` must never be used to disguise a
streaming source.

The streaming backend is selected from verified FLAC metadata. Unsupported or
invalid FLAC input fails explicitly; it does not fall through to a
`MediaElement` clock. MP3, AAC, WAV, AIFF, CAF, Ogg, and MP4 retain their
existing decode support under the common coordinator.

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

`queueItemId` remains the immutable identity of one queue occurrence.
`playbackRevision` orders playback intent, `runId` identifies one audible
play/seek/resume run, `rendezvousId` identifies one cohort joining that run,
and file-transfer `sessionId` remains independent.

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

The host emits the joined-room system message only after `SESSION_APPLIED`, not
merely after a socket or data channel opens. There is no legacy positional
queue-ID fallback.

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
