# File Playback V2 Product Integration Plan

- **Status:** Accepted implementation plan
- **Parent decisions:** `streaming-playback-engine-v2.md` and
  `universal-bounded-streaming-engine.md`
- **Rollback baseline:** `9a9db6fd8e26d7e96a33ce8212263f023b8ced5d`
- **Deployment rule:** local commits only until the owner approves the final
  `main` push

> **Scope update (2026-07-13):** Whole-Blob ordinary-codec decode remains only
> a gated legacy/bootstrap behavior while the universal bounded adapters are
> implemented. It is not the target architecture for long-form media. The
> slices below preserve the FLAC-first integration order; current format status
> is authoritative only in `universal-bounded-streaming-engine.md`.

## Production release status (2026-07-29)

This section is authoritative for current production routing. The rollback
baseline, local-only deployment rule, and milestone slices retained elsewhere
in this document describe the historical rollout plan rather than the deployed
state.

- Production boots the fixed `legacy-current` profile. The tracked production
  latch is OFF, so stale or still-configured remote V2 and universal flags
  cannot install the V2 application session, handshake, peer-range transport,
  or renderer ownership.
- The rollback followed repeated field failures where valid timing races were
  classified as V2 state-machine violations and a playback adoption error was
  coupled to full host-connection teardown. Production reliability takes
  precedence over continuing the rollout.
- V2 remains available only through the exact development opt-in and isolated
  E2E artifacts. Re-enablement requires a nonfatal recovery boundary, a
  connection-preserving playback reset path, and adversarial late-join,
  pause/stop, seek, re-entry, and reordered-message validation.
- The universal bounded delivery implementation and its semantic cohort remain
  in source for isolated development; they do not own playback in the
  production artifact while the tracked latch is OFF.

## Purpose

This plan defines how the tested V2 playback primitives enter the existing
MUSIXQUARE product without allowing the legacy AudioBuffer transport and the
new cutover manager to own one file at the same time.

The product has one file-playback timeline and one audible file owner. In an
enabled standard-room V2 document, native FLAC, supported WAVE/AIFF/CAF linear
PCM, MP3, ADTS, and M4A use the installed universal bounded-route policy. All
bounded formats use the same rendezvous, cutover manager, product audio graph,
queue identity, and UI projection. MediaElement, OPFS, IndexedDB media bodies,
and a second playback clock are not fallback paths. PRO rooms use their own
server clock and authority, but reuse the bounded decoder/renderer only behind
an explicit PRO adapter; they never install the standard application session.

## Fixed bootstrap gate

Engine selection is a document-lifetime decision:

- development enables V2 only with one exact `?fileEngineV2=1` parameter;
- production ignores URL parameters and requires both the exact build flag
  `VITE_MUSIXQUARE_FILE_ENGINE_V2=1` and the tracked
  `FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED` latch;
- while that latch is off, every production flag combination selects the
  legacy engine; after it turns on, the optional exact universal flag selects
  the universal profile and its absence preserves V2/current;
- exact `e2e-universal` is the only latch-off exception and still requires both
  exact build flags;
- duplicate, conflicting, malformed, or unavailable configuration selects the
  legacy engine; and
- no code may re-read configuration or switch engines after bootstrap.

The first production enablement changes only the tracked latch line to `true`.
Rollback changes the same line back to `false` and rebuilds the static
application; reverting to the recorded baseline remains the deployment-level
fallback and does not require a Worker rollback.

Application-session hooks are installed only when the fixed gate is on. They
must be installed before `initProtocol()` and before a connection can deliver
data. Gate-off production therefore sends no V2 handshake or frame and keeps
the rollback build's network behavior unchanged.

## Ownership layers

The following identities remain independent:

| Scope    | Authority                           | Owns                                         |
| -------- | ----------------------------------- | -------------------------------------------- |
| Queue    | `queueItemId`                       | one queue occurrence across reorder          |
| Transfer | `transferSessionId`                 | one byte acquisition attempt                 |
| Asset    | room asset lease + `sourceIdentity` | Blob or bounded encoded-source factory       |
| Run      | `{ queueItemId, runId }`            | prepared media selected for playback         |
| State    | run + `revision`                    | one canonical pause/play/seek/stop state     |
| Attempt  | state + `rendezvousId`              | one physical ARM/FINALIZE operation          |
| Renderer | opaque manager port                 | one silent candidate or exact current output |

An array index, filename, file size, prepare ID, or DataConnection object may
not substitute for any other scope.

## Integration slices

### Slice 1: local idle-to-first-file

The first executable product slice is deliberately small:

- one host document;
- no connected guest;
- playback currently idle;
- one local file selected from the queue; and
- no pause, seek, replay, next-track, preload promotion, or cross-mode
  transition yet.

The slice admits the Blob into the room asset registry, stages one exact
source behind a silent manager gate, runs local ARM -> FINALIZE, waits for
backend start evidence, commits the exact attempt, and only then publishes UI
state. In this original slice, current-route files decoded on activation while
native FLAC preparation stayed bounded.

This slice must not call `stopAllMedia()`, `loadAndBroadcastFile()`, legacy
`play()`, or send `FILE_PREPARE`/`PLAY`. The legacy load path publishes an
AudioBuffer shadow into the same manager, and the manager correctly rejects a
V2 candidate while that legacy ownership exists.

### Slice 2: complete local transport

Pause, paused seek, playing seek, resume, replay, stop, replacement, and end
move together behind a file-playback product facade. The facade is the only
file branch used by playlist actions, controls, Media Session, sync correction,
and ended handling.

Acquisition/preparation state is separated from audible timeline state before
replacement is enabled. Preparing the next candidate must not change the old
current renderer from `playing` to a legacy `DOWNLOADING`/`DECODING` owner.

### Slice 3: queue and UI projection

The facade exposes JSON-safe projections for:

- current queue item, run, revision, phase, and backend;
- exact manager cutover position and duration;
- buffered-ahead, underrun, armed, audible, paused, and ended state; and
- acquisition/preparation progress separately from playback activity.

Reorder preserves the asset, run, renderer, and transfer because
`queueItemId` is unchanged. Removal fences each removed ID before successor
selection and retires its candidate, run, renderer, asset, and late
continuations. A current-route whole-Blob preload owns only the Blob asset; it
does not decode PCM until activation.

### Slice 4: whole-Blob LAN compatibility

The existing RAM-only chunk assembler may initially remain an acquisition
adapter for admitted files. `FILE_START`/chunk/end assembles a Blob only; it
does not select a track, stop playback, change the timeline, or replay current
media. Completion publishes the Blob to the exact source offer/run binding.

Legacy `finalizeGuestFile()` and `loadPreloadedTrack()` are not used by V2.

### Slice 5: peer-range bounded sources

The original slice introduced the per-connection media session with large LAN
FLAC:

1. host publishes an exact source offer;
2. guest accepts the offer under its live channel token;
3. host publishes the run binding;
4. guest commits the binding against the authoritative timeline;
5. guest creates a peer-range asset/source and reports source-ready;
6. host includes the ready guest in ARM -> FINALIZE; and
7. request/response frames stay on their defined control/bulk lanes.

The media session owns the offer registry, run authority, state/attempt
leases, peer-range client or responder, epoch, and abort signal for exactly
one DataConnection. Revocation closes that record before the channel lease is
released. A new connection object is required for re-entry.

The peer-range transport is no longer native-FLAC-only. Supported FLAC and
linear-PCM formats use direct bounded ranges. Implemented optional compressed
routes use either direct ranges or an authenticated manifest-prefixed range
handle when bounded guest reconstruction needs host-derived timeline evidence.
MP3, ADTS, and M4A still retain their current route unless the immutable
bounded-route policy explicitly enables them; a current-route
`decodeAudioData()` fallback requires the complete encoded body.

### Slice 6: R2 records

R2 V2 is a separate transport milestone: 8 MiB independent AES-GCM records,
multipart upload, authenticated exact range reads, one-record plaintext cache,
and additive Worker endpoints. It does not reuse the current whole-object
cipher descriptor and does not silently raise the 200 MiB product limit.

## Legacy double-play fence

V2 activation is not complete until every file-specific legacy entry point is
routed through the product facade. The migration is atomic by category:

| Category  | Legacy behavior to fence for a V2 file                               |
| --------- | -------------------------------------------------------------------- |
| Transport | play, pause, stop, seek, toggle, skip                                |
| Protocol  | `PLAY`, `PAUSE`, `PLAY_PRELOADED`, late-join file bootstrap          |
| Playlist  | same-track replay, local load, end, repeat-one, next/previous        |
| Sync      | `SYNC_PONG` calls that restart legacy `play()`                       |
| Controls  | manual-sync direct `PLAY`/`PAUSE` sends                              |
| Receive   | transfer side effects that stop/select/replay while assembling bytes |

`initPlayback()` and `initSync()` remain enabled because they also own
YouTube, system audio, heartbeat, chat, and other product behavior. Only their
file branches are redirected.

## Product audio graph

Every manager gate connects to the stable file-playback route input. The route
owns downstream mode selection:

```text
manager gate -> file route input
                         +-> stereo path -> effects -> master -> analyser
                         `-> surround splitter -> selected channel -> effects
```

Changing stereo/surround never reconnects or recreates the playback source.
No backend connects directly to `AudioContext.destination`.

## Timeline and health

The canonical host monotonic timeline advances at the finalized target. A
participant that is late, interrupted, backgrounded, or disconnected cannot
hold healthy outputs. Recovery uses the same state revision with a new
unicast rendezvous ID.

Visibility alone is not failure. Sustained renderer, clock, or transport
degradation emits one gray system message and attempts recovery. Automatic
events never replace the pinned human/operator notice.

## Verification per slice

Every slice must prove:

1. gate-off behavior is byte/protocol compatible with the rollback build;
2. one and only one file renderer can become audible;
3. stale queue, asset, run, attempt, connection, and decoder continuations are
   inert;
4. previous current audio survives candidate failure before the target;
5. source and construction leases release exactly once;
6. manager position/duration/ended state reaches the existing UI without a
   fake AudioBuffer;
7. YouTube and system-audio behavior is unchanged; and
8. teardown leaves no worker, worklet, port, range request, timer, or media
   body in persistent browser storage.

The final pre-push gate additionally requires the full unit/type/lint/format,
production build and security guards, host/guest browser E2E, and the physical
iOS Safari/PWA plus Windows fixture checklist in the parent ADR.
