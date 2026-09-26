# Beta QA — 2026-09-26, round 4

Baseline: `mxqr_beta` at `eb6f01ba`. Scope: overlapping playback commands,
manual offsets during bounded decoding, YouTube synchronization ownership,
demo transitions and applied-settings projection, and clock/reconnect state.
This remains beta work without a production release or app/cache version bump.

## Confirmed findings

1. **Demo effect buttons could contradict this device's applied audio.**
   `DEMO_ENTER` copied the host's four effect flags even when the recipient had
   opted out of settings synchronization. A related valid case is an opted-out
   host experimenting locally while an opted-in guest retains the room's
   canonical settings. In both cases, the flags could mark the guest's effects
   ON despite its actual audio being OFF. The receiver now derives those
   buttons from its applied audio settings using the existing projection
   helper. The sender's wire fields remain for compatibility; no effect is
   applied against the device's synchronization preference.
2. **An offset edit during bounded playback preparation could commit stale
   output timing.** A pending start captured the old manual offset before
   awaiting PCM preparation. Editing while still paused correctly stored the
   new preference without queuing another replay, but the pending start then
   used its old offset while position reads used the new one. Preparation now
   checks for an effective-offset change across that await and primes the new
   audible position before committing the source and its logical timing.
   The native path has no await after its offset capture and is unchanged.

## Other investigation

- Three YouTube interleavings were examined: rapid seek/pause/manual-offset
  changes during rendezvous, successor/authority changes during ZeroStart,
  and playlist/repeat occurrences with retained or obsolete iframe callbacks.
  No additional confirmed defect was found. Eleven focused suites passed
  **535 cases**.
- Clock reset and drift/bootstrap ownership, delayed ping responses, and
  sync-worker fallback paths were reviewed. Four focused suites passed
  **128 cases**. Existing identity, expiry, and cancellation guards covered
  the examined cases without clock-algorithm or retry-policy changes.
- Baseline local Chromium selection passed **25 cases**: multi-participant
  disconnect/late-join/queue chaos, demo download ordering and shared start,
  background output recovery, and controlled YouTube synchronization.

## Verification

- Both findings were reproduced before correction: two demo preference cases
  and two bounded-offset boundary cases failed. The corrected demo selection
  passed **341 cases across 11 suites**; the corrected file selection passed
  **194 cases across six suites**.
- Additional regressions cover a later canonical settings snapshot, ON/OFF
  preference changes, exit/re-entry, repeated offset edits with an absolute
  start deadline, and pause cancelling the replacement preparation. Independent
  review confirmed the existing cancellation watchdog, timing, and output-only
  recovery behavior remain intact.
- Full repository typecheck and lint passed, as did import graph, dead exports,
  bus pairing, lifecycle-write discipline, source complexity, and room-authority
  boundary guards. No guard baselines were weakened.
- Final full unit suite: **464 files, 9,673 passed, 1 skipped**, including six
  new regression cases. The existing release-deployment-state test requires
  `jq`, unavailable in this Windows environment; CI does not allow that skip.
- Final rebuilt Chromium selection: **36 passed**, including native/bounded
  hybrid participants, paused late join and seeking, small/large/small file
  transitions, demo output recovery and exit, and manual-sync controls. Combined
  with the baseline selection, this is 61 successful executions of 56 distinct
  browser cases.
- Local production-mode build and all eight artifact guards passed: test-hook
  exclusion, security configuration, legacy TV syntax, service worker, UI kit,
  transfer budget, fonts, and service-worker app shell. Changed-file formatting
  and diff checks passed. App `8.6.61` and cache `v630` remain unchanged; this
  verification did not deploy production.

## Limits

The browser checks use local Chromium and local signaling. YouTube timing is
exercised with controlled iframe fixtures; delayed decoder and settings events
are also deterministic fixtures. This does not establish physical-device audio
alignment, real YouTube/network behavior, iPhone Safari/PWA behavior, or all
possible session orderings. Beta pushes alone do not trigger the `main` CI
workflow and are not production deployment.
