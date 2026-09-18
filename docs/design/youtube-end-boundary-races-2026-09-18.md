# YouTube end-boundary synchronization ownership

Reviewed on 2026-09-18 after a report that seeking near the end during repeat-one
could leave Standard-room guests on the outgoing timeline or close their player.
The report predates the preceding synchronization release; these findings do not
establish the first production occurrence or reproduce a physical device trace.

## Confirmed failure mechanisms

- Guest rendezvous extrapolated a target 1.5 seconds ahead without checking the
  video duration. The target could fall after the host had already repeated or
  advanced, including when a personal offset pushed only the guest past the end.
- Buffer, play and calibration callbacks shared one active boolean and fetched
  the current player again. A superseded callback could act on a newer attempt
  or replacement player, or clear its timers. Synchronous state callbacks also
  allowed an outgoing seek to continue after a newer command took ownership.
- Repeat-one can reuse the queue occurrence, video and iframe. An accepted
  zero-start PREPARE previously did not invalidate the outgoing legacy
  rendezvous or its host snapshot on this resident-player path.
- A guest ENDED callback armed a five-second fallback that checked only whether
  playback was still in YouTube mode. It could close a resumed/replacement video
  and clear its UI timer. Late ENDED events needed validation against live state
  and the current occurrence, not just the retained iframe object.
- A deferred host repeat could survive Stop, repeat-mode changes, a new session
  or a role/room transition. Missing iframe metadata could keep its poll alive.
- Repeated ENDED notifications could restart the same repeat-one transition
  multiple times before the iframe acknowledged leaving its ended state.
- Older rough-play timers could fire during a newer precision countdown. Slow
  playlist loads and incidental PLAYING notifications also needed to preserve
  the final precision intent without applying the new video's time to the old
  video.

These mechanisms were isolated with failing deterministic regressions before
their fixes. Their coexistence explains why a narrow end-of-track timing window
can produce several different symptoms; it does not prove which callback order
occurred on the reporting device.

## Runtime contract

Every guest precision attempt owns its exact connection, player, session, queue
occurrence and sub-video. Each delayed step and post-iframe-command continuation
checks that ownership. Cleanup can only retire the attempt that created it.
Calibration cannot persist measurements from a stopped, replaced or ended run.
Scheduled rough-play actions have their own generation, retired when a newer
accepted action or precision attempt takes over.

A future rendezvous target must be playable on both the canonical and local
timeline. If the end is too close, no pause or seek is issued: the existing
bounded final-intent retry waits for a usable host position. A newer transport
action supersedes that intent; a repeat PREPARE starts a new timeline and removes
the outgoing snapshot. Personal offsets and learned playback latency survive
that timeline invalidation.

Host Stage 2 broadcasts likewise belong to an action generation. A newer seek,
pause, cancellation or zero-start run retires the outgoing generation even when
the video and queue IDs stay unchanged.

The guest end fallback is restricted to the exact still-ended occurrence. Host
continuation retires its generation, and active synchronization prevents teardown.
The deferred Standard-host repeat is bounded and must still own an ended video
with repeat-one enabled when it finally executes.
Standard-host repeat-one consumes duplicate end notifications once per ended
episode; the next repeat becomes eligible after the iframe has actually left
that state.

## Verification boundary

Regression coverage includes near-end targets with positive/negative offsets,
same-video repeat PREPARE, replacement players/connections/sessions/queue items,
reentrant commands, late timers, calibration, stopped/file-mode transitions and
deferred repeat cancellation. Positive controls retain ordinary synchronization
and genuine end-of-queue cleanup.

Browser smoke tests use two real browser contexts and a local PeerJS broker with
a deterministic YouTube facade. They validate application/protocol behavior;
physical iPhone PWA buffering, decoder latency and audible synchronization still
require device testing. PRO retains its server-authoritative playback contract;
this change does not introduce room-wide personal-offset synchronization.
