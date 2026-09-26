# Beta QA round 19 — pending media authority and SFU attachment failure

Date: 2026-09-27 (KST)

Branch: `mxqr_beta`

Baseline: `d359c8966ea3ef67c6192c72fde978350145e6b8`

## Scope and method

This round reviewed asynchronous chat/media submission, PRO persistent media
mutations and uploads, system-audio reception, and related demo, output-recovery,
and update lifecycles. Three independent review lanes supplied test-only
reproductions; the primary agent made product changes and the reviewers checked
them independently. Existing round-18 fixes were preserved.

Four concrete defects were confirmed across three areas. Reproductions control
asynchronous completion boundaries: a YouTube playback-proof wait, a native
streamed HTTP Response with real client/runtime reconciliation, a modeled XHR
PUT through real media-transfer code, and audio resume failure. Healthy controls
distinguish cancellation of old
work from legitimate fresh actions. These are not claims of physical-device
reproduction or exhaustive coverage of every possible schedule.

## Confirmed defects and changes

### 1. A pending YouTube Add could survive permission loss and reconnect

The iOS final Add gesture can wait up to 1,500 ms for the silent iframe prime
proof. Input edits and popup closure invalidated that wait, but authority changes
did not. Revoking and restoring media permission before proof completion let
the old gesture submit under the later grant. Replacing the standard host
connection, or advancing the PRO room epoch, had the same stale-owner problem.

The pending gesture now owns its room/epoch, exact host connection, standard
role, session, and media permission. Lifecycle notifications retire that owner
when it is no longer current. Cleanup releases only its own busy/button state;
it cannot overwrite a newer input's preview gate. Fresh clicks after restored
permission work normally, and an ordinary same-room snapshot refresh does not
cancel a valid gesture. The synchronous already-primed path stays unchanged.

Five new regression cases failed before the fix. Together with a healthy
snapshot-refresh control, all six pass. The complete player-controls suite has
**190 passing tests**. The authority-boundary guard passes without increasing
legacy access allowances.

### 2. Queued PRO playlist writes could resume under a different grant

The playlist manager serializes writes, while authority heartbeat processing
continues separately. Runtime hooks supplied only a room-lifetime AbortSignal.
An admitted write waiting behind an earlier HTTP response therefore survived
revocation, account replacement, and later regrant in the same room. This affected
removal, reordering, metadata edits, YouTube append, and queued file upload.

Writes now capture the uninterrupted queue-mutation grant's lifetime. Losing
that grant aborts its queued work and retires the upload queue and its loaders.
Restoration creates a fresh lifetime/queue for new actions. Upload availability
also requires its existing asset-upload capability. Old retry dialogs retain
the exact queue owner and cannot restart work in a successor queue. Read-only
downloads, cache, playlist projection, and account hook-registration ownership
are preserved.

An already committed server result may still become canonical; cancelling a
later human intent does not undo an accepted server change. The regression
holds a real response body while heartbeat observes that accepted change, then
revokes/restores authority before the queued operation could run. An account
case follows conflict, detachment, and successor attachment. An active-upload
case uses the real media transfer with a pending XHR PUT test double, checking abort,
reservation cleanup, discarded waiting rows, and successful fresh upload.

All **nine new cases** pass. The related asset, upload, manager, account, and
preload slice passes **150 tests in ten files**.

### 3. PRO SFU audio initialization failure could leave a silent subscription

The subscriber consumes a received RTC track once per subscription. Its service
logged an audio-attachment rejection but did not retire the subscription or
enter recovery. A later identical subscribe reused that connection and emitted
no new track, so restoring audio readiness did not itself repair the output.

A current attachment failure now uses the existing subscriber-failure cleanup
and 2,500 ms retry path. Both the exact transport owner and the room/publication
identity must still match. Late failures after transport replacement,
publication replacement, or room departure do not stop the successor.

The failing reproduction uses the actual `ensureRunning()` deadline with a
controlled pending `AudioContext.resume()` promise. Transport tests also establish
that identical subscribe is idempotent and stop/reopen delivers a fresh track.
Direct-route failure handling was already present and was retained.

### 4. Standard SFU audio attachment failure could retain a dead receive attempt

The standard SFU adapter had the same log-only catch, retaining its PC and
pending receive state until a separate watchdog stopped it. The already consumed
track could not repair that attachment. A missing audio graph also returned
silently instead of entering failure handling.

Only a still-current PC may now handle the error: it releases the failed
transport and pending receive state and uses the existing receive-failed
message. A fresh authenticated START/READY can establish a new receiver. This
does not add automatic standard-room retry or alter direct/SFU route selection.
Late errors from stopped or replaced receivers do not clear newer state.

The native-resume rejection and missing-graph cases pass, as do fresh-share
recovery and stale completion controls. Two older healthy-path tests used a
missing graph merely to bypass attachment; they now install a valid graph,
with a dedicated negative test preserving explicit missing-graph coverage.
Older PRO track-event fixtures now provide the transport's required `isCurrent`
callback. The combined system-audio, direct-route, and demo slice passes
**354 tests in ten files**.

## Other review and verification

- Chat rendering, whispers, BOT ownership, signaling payload/socket fencing,
  search, drop/dialog ownership, and stale indexing callbacks: **795 existing
  tests in 15 files passed**; no additional verified defect in that lane.
- Manual-sync controls, Media Session, local-output rejoin, and output-health:
  **216 tests in eight files passed**.
- Service-worker update coordination, completion, registration recovery, and
  hard reset: **95 tests in five files passed**.
- Local Chromium: **13 checks passed** across YouTube search/quick-add, setup
  activation, administrator upload cancellation, and system-audio controls.
- Final full unit run: **482 files passed; 9,851 tests passed, one skipped**.
  The existing deployment-artifact classifier case skips locally without `jq`;
  no new case is skipped. The final run limited parallel workers to four and
  retained every existing timeout. The nine mutation cases also passed again
  after the last test-only progress callback typing correction.
- Full repository typecheck and app/tooling lint passed. Final changed-file
  formatting, lint, and diff checks passed.
- Seven source guards passed: import graph, dead exports, bus pairing, lifecycle
  writes, source complexity, room authority, and chunk pump.
- A local production build and eight artifact guards passed: production hooks,
  security, legacy TV, service worker, UI kit, initial transfer budget, fonts,
  and app shell. The shell check verified 90 assets. The build was not deployed.

Focused baseline failures and verification logs are retained locally in the
ignored `scratch/qa-beta-round19-2026-09-27/` directory. Earlier aggregate runs
exposed the corrected healthy audio fixtures, the authority-seam guard, and
tooling timeouts under concurrent load; final results above refer to the final
source and fixtures. No assertion or test timeout was weakened to obtain a pass.

## Limits and publication

The browser tests use local Chromium, local signaling, and controlled media.
The PRO server/permission races use controlled responses through real runtime
and client paths. Audio tests simulate native failure/completion boundaries;
they do not measure acoustic synchronization or exercise real Cloudflare media
transport, a physical iPhone, or a physical network handover. In particular,
standard-room failure cleanup is not a promise of automatic retry.

Work stays on `mxqr_beta`, with beta commit/push authorized. UI design, room
policy, app **8.6.61**, and cache **v630** remain unchanged. No pull request,
main advancement, production deployment, or Operations Drift Audit
re-enablement belongs to this round.
