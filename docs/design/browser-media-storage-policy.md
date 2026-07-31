# ADR: Browser Media Storage Is RAM-Only

- **Status:** Accepted
- **Decision date:** 2026-07-10
- **Last implementation check:** 2026-07-15
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

RAM-only media still has a device-dependent physical capacity ceiling, and
persistent storage would not remove the PCM required by the current AudioBuffer
playback engine. The legacy engine nevertheless does **not** impose a predicted
per-device RAM ceiling. Local decode, P2P receive/preload, and whole-file remote
upload/download proceed on a best-effort basis and rely on the browser's actual
allocation and `decodeAudioData` outcome.

**Implementation note (2026-07-15):** the shared memory ledger remains for
ownership, cleanup, diagnostics, and future media-engine work, but production
budgets are effectively unbounded for every file a browser can materialize.
Metadata duration/channel probes are skipped because their only production use
was conservative pre-rejection. A successful AudioBuffer is measured after
decode for accounting only; it is not discarded for crossing a device tier.

Remote sharing retains its fixed 200 MiB protocol/storage ceiling. P2P also
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

The accepted tradeoff is explicit: files that conservative estimates previously
rejected are now attempted, but a memory-constrained browser may reject an
allocation, terminate the tab/PWA, or be killed by the OS. The discarded
large-file/OPFS implementation is not retained in production code or Cloudflare
resources. Any future reconsideration starts as a separate proposal and
implementation; it must not revive the discarded branch or wire old artifacts
into the browser media path.

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
  current legacy RAM path is best effort and has no predictive admission gate.
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
