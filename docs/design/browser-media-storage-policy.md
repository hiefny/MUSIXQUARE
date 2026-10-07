# ADR: Browser Media Storage Is RAM-Only

- **Status:** Accepted
- **Decision date:** 2026-07-10
- **Last implementation check:** 2026-07-15
- **Latest beta implementation check:** 2026-09-23 (`mxqr_beta`; not deployed)
- **Applies to:** production file-transfer, preload, remote-share receive, and
  file-playback paths

## Context

MUSIXQUARE depends on long-running, synchronized sessions on iOS Safari and
installed iOS PWAs. Earlier browser-local persistent media storage added a
second lifecycle for partially written files, abandoned sessions, quota
pressure, and cleanup. In long iOS sessions that lifecycle was associated with
unacceptable memory growth and WebContent/PWA crashes.

The current implementation keeps incoming encoded chunks, finalized media
blobs, preloads, and decoded playback buffers in memory. That design has a
clearer lifetime: leaving or replacing a session drops app-owned references and
makes its browser-local working set eligible for browser reclamation, without a
disk-recovery path. The browser still controls the actual reclamation timing.

Temporary private objects in Cloudflare R2 are outside the scope of this
decision. They are participant-authorized server-side handoff objects with
their own TTL and cleanup contract, not browser-local playback storage.

## Decision

The shipping browser media pipeline is **RAM-only**.

- Do not write media payload bytes, media chunks, preloaded tracks,
  or decoded PCM to OPFS or IndexedDB in production playback paths.
- Keep one playback/storage behavior across supported browsers. A device must
  not silently switch to a different playback clock because persistent browser
  storage is available.
- Treat OPFS as a deferred implementation option, not a permanently forbidden
  platform API. There must be no repository-wide token/import guard that makes
  future experiments artificially impossible.
- This decision does **not** ban IndexedDB. Small non-media metadata, such as a
  future resumable-upload identifier or completed-part manifest, may use
  IndexedDB after its own lifecycle and privacy review. Storing media bodies in
  it remains outside the current decision.
- Cache Storage, local storage for preferences, and storage-usage diagnostics
  are also not prohibited by the term RAM-only. The boundary is the media
  working set used for transfer and synchronized playback.

This is an operational architecture decision, documented and reviewed through
normal code review. It is intentionally not enforced by a broad static search
for `navigator.storage`, `indexedDB`, or OPFS-related names; such a guard would
also block diagnostics and legitimate future metadata work.

## Consequences

RAM-only media still has a device-dependent physical capacity ceiling.
Persistent storage alone would not remove the PCM required by a whole-track
AudioBuffer. Ordinary files continue to use that engine. P2P receive/preload
and remote upload/download still handle complete encoded files, so a bounded
PCM decoder does not bound the entire browser media working set.

Playback does **not** reject a file solely because its predicted memory exceeds
a device tier. The beta uses that track's estimate to select a decoder before
preparation; allocation, parsing, codec support, and actual decoding can still
fail on a particular device.

**Implementation note (2026-07-15, partially superseded on 2026-08-31):** the
shared memory ledger remains for ownership, cleanup, diagnostics, and future
policy review, but production budgets are effectively unbounded for every file
a browser can materialize. At the time of this note, metadata duration/channel
probes were skipped because their only production use was conservative
pre-rejection.

**Beta update (2026-09-23, supersedes the 2026-08-31 advisory):** the owner chose
to keep the whole-track AudioBuffer engine permanently as the default and add
a second engine only for memory-heavy tracks. The new engine reads the resident
File/Blob incrementally, decodes MP3/FLAC/AAC in WASM workers or uses a supported
PCM decoder, and schedules short AudioBuffers against the same
AudioContext clock and playback route. It does not use a media-element output
clock, OPFS, IndexedDB media storage, or a new network streaming protocol.

The AAC beta path covers AAC-LC, HE-AAC v1, and HE-AAC v2 in M4A/MP4 or ADTS
framing. It reads container timing/trim information and primes preceding frames
for seeks; it does not treat every `.aac` or `.m4a` file as an accepted profile.
Actual decoded channels and sample rate determine the output, including SBR/PS
expansion. Long ADTS files need an initial frame-index scan, and the resulting
parser metadata is additional memory beyond the bounded PCM window. Browser
`AudioDecoder` availability is not required by this AAC worker path.

Selection uses estimated PCM or that track's own decode footprint, not the
aggregate ledger including previous tracks and concurrent transfers. Each new
track is evaluated independently, so a small track after a large one returns
to the original engine. Uncertain metadata uses a known encoded size above
200 MiB as a fallback signal; the ledger's unknown-duration expansion estimate
does not by itself switch engines. See the exact thresholds and lifecycle in
[the hybrid-engine design](large-local-audio-streaming-proposal.md).

The numeric predicted-memory message remains removed. Only after a large
track's initial preparation succeeds does its device show the local guidance
that this track is very large and some operations may be delayed. This message
is deduplicated per queue occurrence/session (or per demo Blob), is not broadcast,
and does not accompany the old Standard-room size warning on that path.
The legacy size-warning condition remains for the original engine. A successful
ordinary AudioBuffer is still measured after decode for accounting only and is
not discarded for crossing a tier.

If the selected large-track engine has no supported incremental decoder or
fails to prepare, it follows the existing playback failure path. It does not
automatically retry with full-track decode, which would recreate the allocation
that engine selection was meant to avoid. This is a local beta implementation;
real iPhone Safari/PWA verification is not yet complete.

Standard remote sharing and PRO retain their fixed 200 MiB per-file
protocol/storage ceiling. P2P also
retains integrity limits for positive safe sizes, exact chunk totals, 64 KiB
frames, and at most 200,000 chunks. These are protocol bounds, not predictive
RAM admission.

Inbound `FILE_CHUNK` and `PRELOAD_CHUNK` frames bypass the generic per-peer
message bucket only after the receiver can bind the frame to the exact current
host connection and an active `(sessionId, queueItemId)` transfer. The frame
index and byte length must also remain inside the declared transfer bounds.
Unknown sessions, stale connections, mismatched queue occurrences, and chunks
that arrive before their transfer header use the ordinary message bucket. This
keeps legitimate high-throughput media flowing without turning a message type
alone into an unlimited ingress exemption.

The accepted tradeoff is explicit: the beta bounds the app's decoded playback
window for large tracks and permits extra preparation/seek latency, while
encoded-file storage and browser/decoder allocations can still exhaust memory.
A memory-constrained browser may reject an allocation, terminate the tab/PWA,
or be killed by the OS. This independent RAM-only decoder does not revive the
discarded large-file/OPFS branch or its Cloudflare resources. Reconsidering
persistent media storage still requires the separate gates below.

## OPFS Re-evaluation Gate

OPFS may be proposed again only in a separate, reversible change. Passing unit
or desktop-browser tests is not sufficient. Before production enablement, the
proposal must satisfy every gate below on a production-equivalent HTTPS test
origin.

### 1. Supported-device matrix

Run the complete matrix in both a normal Safari tab and an installed Home
Screen PWA:

- the oldest iOS/iPadOS major release the product supports;
- the latest production iOS/iPadOS release;
- the lowest-memory supported physical device; and
- a current physical iPhone or iPad.

Simulators and desktop Safari may supplement this matrix but cannot replace a
physical-device result. If one device covers more than one row, record that
fact explicitly.

### 2. Foreground and lifecycle soak

Each browser mode must complete both runs without a spontaneous reload,
WebContent crash, PWA termination, corrupt read, or lost playable track:

- **Foreground soak:** at least 8 continuous hours, including at least 100
  receive/replace/preload/cleanup operations.
- **Lifecycle soak:** at least 8 hours with at least 30 foreground/background
  transitions and 25 complete host-or-guest leave/rejoin cycles. Include device
  lock/unlock, network loss/recovery, and reopening the PWA from its icon.

Run the lifecycle soak with files representative of the largest proposed
production workload, not only small fixtures.

### 3. Storage reclamation

After explicit leave/cleanup and after a fresh app launch:

- every app-owned OPFS directory must be enumerable and empty;
- no partial-session or superseded-track artifact may become playable;
- on an isolated test origin, `navigator.storage.estimate().usage` must show no
  positive trend across the final 10 cleanup cycles; and
- after a 10-minute settle and one reload, origin usage must return to the
  measured static-app baseline plus no more than 32 MiB.

Record the baseline, per-cycle usage, quota, and directory inventory. A cleanup
that merely makes stale files unreachable does not pass.

### 4. Crash and memory evidence

The experimental build must collect privacy-preserving diagnostics sufficient
to distinguish a clean close from an unexpected restart. At minimum, record:

- browser mode, OS/device class, build, session/run identifier, and visibility
  transitions;
- operation counts and app-owned RAM/OPFS byte counters;
- storage quota/usage snapshots before and after cleanup;
- storage exceptions, decode failures, and incomplete-run markers recovered on
  the next launch; and
- OS/WebKit crash or jetsam evidence when it is available from the test device.

Acceptance requires zero unexplained restarts or crashes in the required
matrix, zero unreclaimed OPFS artifacts, and no monotonic retained-byte growth
over the final 20 operations of either soak. Missing telemetry is a failed
gate, not evidence of stability.

### 5. Fallback and rollback

The first production-capable implementation must be isolated behind a runtime
flag that defaults to RAM-only and can be disabled without a data or Cloudflare
migration.

- Decide the storage mode before accepting a media item; never change playback
  engines or backing stores in the middle of a synchronized track.
- On OPFS open/write/read/quota failure, remove any app-owned partial artifact.
  A future proposal must define its own explicit fallback-capacity policy; the
  current RAM path is best effort and has no predictive admission gate.
- A single configuration change or deployment revert must restore RAM-only
  behavior for new sessions.
- Rollback verification must include opening the downgraded build with old
  experimental artifacts present, confirming that it ignores and can remove
  them without blocking room entry or playback.

## Change Control

An OPFS proposal must update or replace this ADR and attach the device matrix,
soak logs, cleanup measurements, and rollback rehearsal results. It must land
separately from signaling, authentication, font, Cloudflare migration, and
playback-engine changes so a storage regression can be reverted independently.
