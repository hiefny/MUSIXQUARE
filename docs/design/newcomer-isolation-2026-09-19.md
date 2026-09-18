# Newcomer isolation review

This review covers Standard and PRO admission, current-file bootstrap,
background preload, remote delivery, YouTube synchronization, demo participation,
and system-audio route promotion. It extends the
[Demo Day transition review](demo-day-transition-matrix-2026-09-19.md).

## Runtime boundaries corrected in 8.6.48

- **PRO system audio:** a newcomer requiring SFU delivery must not close healthy,
  committed LAN listeners before the authenticated replacement publication is
  accepted. Retained routes still undergo locality checks, roster/incarnation
  validation, and normal stop/lease-loss cleanup. Failed or unproven routes close
  immediately. SFU provisioning and retry can fail without discarding a healthy
  incumbent route.
- **PRO YouTube:** a controller's local iframe/API error or prolonged buffering
  does not establish room-wide content unavailability. Explicit content errors
  still use the existing authoritative path, as do accepted end/control events;
  stale revisions remain rejected. This applies equally to a newcomer after
  catch-up and to an established controller.
- **Standard zero-start:** replacing a newcomer connection outside the frozen
  preparation cohort invalidates that peer's capability only. It must not abort
  the active cohort or schedule room-wide fallback synchronization. Expected
  cohort member replacement retains its existing recovery behavior.
- **Standard preload:** background fanout and late bootstrap share one owner per
  exact connection, source blob, queue occurrence, and transfer session. A
  completed bootstrap lane is not replayed. Failed/cancelled/replaced lanes can
  retry. Exact, validated duplicate chunks from an older sender are discarded
  without consuming the ordinary control-message bucket; unrelated or malformed
  traffic retains admission and rate checks.
- **Standard remote delivery:** progress UI ownership is separate from each
  caller's failure recipients. A newcomer joining a shared upload cannot hide
  its failure from existing waiting recipients. Shared waiters notify each
  exact connection at most once, targeted requests remain targeted, and stale
  playback or cancelled uploads cannot affect their successors.

The transfer owners retain both a promoted current file and its speculative
successor across asynchronous send work. A failed START, chunk, or END send must not create a
completed preload fence. The shared chunk pump excludes only the peer whose
send failed, leaving other peers to finish normally.

## Regression evidence

Permanent tests accompany the relevant modules:

- `src/network/__tests__/pro-system-audio-direct.test.ts`
- `src/pro-room/__tests__/system-audio-service.test.ts`
- `src/pro-room/__tests__/runtime-server-playback.test.ts`
- `src/youtube/__tests__/{stale-async-guards,sync-integration,zero-start}.test.ts`
- `src/storage/__tests__/{preload-lane-ownership,preload-overlap-progress}.test.ts`
- `src/storage/__tests__/{chunk-pump,chunk-rate-limit-exemption}.test.ts`
- `src/share/__tests__/remote-share.test.ts`

The existing `src/player/__tests__/preload-queue-mode.test.ts` assertions remain
unchanged and verify that promotion does not cancel a current-file stream while
the next speculative preload begins.

The preload protocol regression includes paced duplicate traffic followed by a
PAUSE: 4.06 MiB over approximately 325 ms and 16 MiB over approximately 2.55 s.
These exercise actual sender/protocol/storage code with controlled time, rather
than measuring a physical network's throughput.

The exploratory three-browser matrix uses real local WebRTC and decoded audio
to cover joining during existing local playback/synchronization, paused local
playback, slow demo loading, and a host demo-track change during newcomer loading.
Each also checks that newcomer departure preserves the established pair.
The local harness does not provide production R2 or Cloudflare SFU services;
those failure boundaries use deterministic module tests.

An adversarial sender test also delays the transport-policy promise across
multiple turns. This is ownership stress coverage, not observed network latency:
the production session-aware policy check returns immediately, followed by a
microtask. Replaying that artificial reversed START order into the receiver can
replace the newer speculative snapshot with the older one. No production entry
sequence establishing that order was found; the normal ordered sender/receiver
replay passed. Receiver state-machine changes for this unproven trigger are not
part of this release.

## Scope and unchanged policy

The final local candidate passed 8,814 unit tests in 432 files, with one existing
skip, plus 26 Chromium browser tests (the four three-browser matrix cases and
22 existing preload, playback, and late-join cases). Type checks, lint,
formatting, Worker syntax, API boundaries, migration contracts, and source-only
operational-drift checks passed. Exact-commit CI and the production release
workflow provide the subsequent deployment evidence.

The reported momentary missed synchronization of an **already-playing local
guest** during newcomer admission was not reproduced. The confirmed preload
rate-limit issue affects the peer receiving duplicate bytes; it is not evidence
that another established guest lost synchronization. Do not treat this release
as proof of the original physical-device incident's root cause.

The four-device system-audio limit, metered-route time limit, and verified LAN
requirements remain unchanged. This is not a capacity increase or a promise of
gapless direct-to-SFU handover. The accepted iOS 17 Ogg limitation also remains.
Actual iPhone PWA behavior, venue network conditions, background suspension,
YouTube ads, and acoustic synchronization still require physical rehearsal.
