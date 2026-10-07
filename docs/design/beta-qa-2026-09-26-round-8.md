# Beta QA — 2026-09-26, round 8

Baseline: `mxqr_beta` at `bb9e31ff`. Scope: queue deletion/reordering,
repeat/shuffle changes, preload promotion, delayed file delivery, and PRO
queue-mode persistence across asynchronous responses. Work stays on beta
without a production deployment or app/cache version change.

## Confirmed findings

### A queue-mode change could abort delivery of the current file

The host can promote its preloaded File to the current playback resident while
a slower guest is still receiving that same file. Changing repeat or shuffle
then cleared the speculative preload state, but its unconditional transfer
cancellation also aborted the promoted current-file sender. The guest discarded
the partial preload and had to rely on subsequent recovery rather than finish
the original transfer.

The regression runs actual scheduling, chunk pumping, `playTrack`, preload
activation, and transport code while holding a real Blob chunk-read boundary.
The unchanged control completed its chunks and END; repeat-all, repeat-one,
and shuffle changes instead emitted an erroneous ABORT on the baseline.

A two-context Chromium regression reproduced the same failure through real
MP3 uploads, track selection, and repeat-button clicks. It records the actual
outbound frames without replacing transport. Before the fix, the current
queue/session received PRELOAD_ABORT while its first chunk read was pending.

Queue-mode changes and non-current row removal now request cancellation of
speculative transfers while preserving the exact current-file sender. The
existing queue ID, transfer session, and Blob identity must all match the
current resident. Broadcast and late-join unicast owners are checked
individually, so a different speculative sender is still aborted. Ordinary
navigation and forced teardown keep the existing full-cancellation behavior.

### PRO repeat persistence used an obsolete playlist revision

A participant can reorder, change repeat mode, and reorder again while the
queue-mode checkpoint's HTTP refresh is pending. The refresh correctly accepts
the newer playlist, but the following PUT still used the snapshot captured
before that await. The server rejected the old playlist revision and the
existing conflict recovery reverted the participant's repeat setting.

The checkpoint now rereads the manager snapshot after refresh and lease
validation, immediately before constructing the PUT. The existing handling of
genuine competing edits, failures, retries, and session cancellation remains
unchanged.

The regression uses the actual runtime, playlist manager, mutation scheduler,
and checkpoint timer, with controlled API responses that enforce the Worker's
playlist-revision conflict rule. Before correction, the PUT used revision 3
instead of 4 and both canonical and local repeat state reverted to 0. The
corrected request preserves the latest local repeat edit.

## Other investigation

Common playlist traversal, stable queue identity, current-item removal,
YouTube end/seek/repeat rendezvous ownership, and retained-player handoff were
reviewed. Seven focused unit suites passed 523 tests on the baseline. No
additional YouTube production defect was confirmed.

## Verification

- Final Chromium selection: **16 passed**, covering the new delayed-read
  regression, queue reorder/removal, next/previous MP3 playback, preload
  cancellation, host/guest playback state, and demo common start. Fourteen of
  these also passed on the baseline; they are not additional distinct cases.
- The final browser regression verifies both absence of an erroneous ABORT
  and delivery, decoding, and playback on the guest. An intermediate failure
  came from its diagnostic send wrapper dropping PeerJS's internal chunking
  argument. Forwarding every argument corrected the test instrumentation;
  it was not counted as a product defect.
- Full unit suite: **465 files, 9,700 passed, 1 skipped**, including 13 new
  tests. The existing release-deployment-state case needs `jq`, unavailable
  in this Windows environment; CI does not permit that skip.
- Full repository typecheck and lint passed. The final browser test also
  passed a subsequent E2E typecheck, targeted lint, and formatting check after
  its instrumentation correction.
- Import graph, dead exports, bus pairing, lifecycle writes, source
  complexity, room-authority boundary, and shared chunk-pump guards passed
  without baseline changes.
- Independent cross-review checked preserved sender ownership, completion
  cleanup, navigation/teardown cancellation, and PRO lease/conflict handling.
  No further product change was required.
- Local production-mode build and eight artifact guards passed: test-hook
  exclusion, security configuration, legacy TV syntax, service worker, UI kit,
  transfer budget, fonts, and app-shell completeness. App `8.6.61` and cache
  `v630` are unchanged; the build check did not deploy production.

## Limits

Browser checks use local Chromium, local signaling, and real fixture MP3
decoding; a controlled Blob read exposes the transfer overlap deterministically.
PRO race tests control API response timing rather than using live Cloudflare.
These checks do not establish physical-device synchronization accuracy,
real-world race frequency, or iPhone/WebKit behavior. Beta pushes do not trigger
the main-only CI workflow or deploy production.
