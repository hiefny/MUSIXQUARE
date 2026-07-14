# ADR: Browser Media Storage Is RAM-Only

- **Status:** Accepted
- **Decision date:** 2026-07-10
- **Last implementation check:** 2026-07-14
- **Applies to:** production file-transfer, preload, remote-share receive, and
  file-playback paths

## Context

MUSIXQUARE depends on long-running, synchronized sessions on iOS Safari and
installed iOS PWAs. Earlier browser-local persistent media storage added a
second lifecycle for partially written files, abandoned sessions, quota
pressure, and cleanup. In long iOS sessions that lifecycle was associated with
unacceptable memory growth and WebContent/PWA crashes.

The current implementation keeps incoming encoded chunks, finalized media
blobs, preloads, current-route decoded buffers, and every bounded-engine working
set in memory. That design has a clearer lifetime: leaving or replacing a
session drops app-owned references and makes its browser-local working set
eligible for browser reclamation, without a disk-recovery path. The browser
still controls the actual reclamation timing. Mentioning the implemented
bounded engine here does not claim its product policy or deployment gate is
enabled.

Temporary encrypted objects in Cloudflare R2 are outside the scope of this
decision. They are server-side handoff objects with their own TTL and cleanup
contract, not browser-local playback storage.

## Decision

The shipping browser media pipeline is **RAM-only**.

- Do not write media payload bytes, encrypted media chunks, preloaded tracks,
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

RAM-only media has a device-dependent capacity ceiling. File admission must
therefore account for the decoded audio footprint, not merely the encoded file
size. Persistent storage would not remove the memory required by a
legacy/current-route whole-file `AudioBuffer` decode, nor the explicitly
bounded working set required by the streaming engine.

**Implementation note (2026-07-14):** a local, demo, preload, or received file
that enters the legacy/current-route whole-Blob decoder passes the same
`AudioBuffer` admission check before `arrayBuffer()` and native decode
allocation. The check probes duration with an off-DOM muted
`HTMLAudioElement` used only for metadata; it is never played or connected to
the audio graph. It estimates Float32 PCM with headroom at a conservative 48
kHz floor, raised to the active AudioContext output rate when that rate is
higher. A bounded WAVE, AIFF, CAF, FLAC, Ogg, MP3, AAC, or MP4 header probe
supplies the channel count; MP4 metadata is accepted only from verified box
hierarchy and all verified audio tracks contribute to the maximum. An unknown
layout reserves a conservative 32 channels. The estimate includes encoded
copies, still-reachable decoded buffers, and concurrent whole-file remote
transport in one in-flight memory ledger, then validates the actual
`AudioBuffer` footprint again before publication. Missing duration metadata
fails closed on iOS and other constrained devices; desktop tiers use a
conservative encoded-size expansion. Bounded streaming routes use their own
fixed encoded-read, decoder-message, and PCM-ring budgets instead of this
whole-track admission estimate.

Current whole-Blob PCM / decode-working-set ceilings are 192/320 MiB on iOS,
256/448 MiB on constrained or other mobile devices, 384/768 MiB on standard
desktop devices, and 512 MiB/1 GiB on desktops reporting at least 8 GiB of
device memory. These are playback-memory budgets, not encoded-file limits.
Remote sharing retains a fixed 200 MiB protocol/storage ceiling, but its
effective admission ceiling can be lower when the device's RAM budget or other
in-flight work cannot safely hold the required whole-file copies.

The current-route tradeoff is to reject a whole-Blob file that cannot fit the
supported memory budget rather than introduce a persistent-storage or
different-clock fallback. Implemented bounded adapters can remove the
duration-proportional `AudioBuffer` allocation after their independent product
gates pass, but they remain RAM-only and do not make OPFS a fallback. The
discarded large-file/OPFS implementation is not retained in production code or
Cloudflare resources. Any future reconsideration starts as a separate proposal
and implementation; it must not revive the discarded branch or wire old
artifacts into the browser media path.

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
  Fall back to RAM only when the existing RAM admission check passes; otherwise
  show a specific, recoverable file-capacity error.
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
