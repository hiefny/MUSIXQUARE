# Demo playback reliability review

This review covers the standard-room demo in MUSIXQUARE 8.6.46. Demo playback
uses local decoded audio without an ordinary playlist item. Recovery must
recognize that ownership explicitly; inventing a queue item would conflate the
demo with the playlist saved underneath it. PRO rooms remain outside the demo
contract.

## Reverified defects and corrections

| Boundary | Confirmed failure | Correction |
| --- | --- | --- |
| Track download | Failure of an older request discarded a newer host track command. | Keep the latest owned intent and drain it after the old load settles. |
| Audio output | Queue-only recovery guards skipped demo audio after an interruption or failed PLAY. | Identify demo output by room, track index, load epoch, and decoded buffer; reuse the existing recovery UI and transport. |
| Native media controls | Native PLAY could not resume a fresh demo with no queue item. A guest's local pause could also survive a later host PLAY and suppress synchronization. | Route host controls through demo authority, keep guest native controls local, and clear local pause for a new authoritative command. |
| Lazy runtime import | An import failure consumed entry/play commands on an otherwise healthy connection. | Retain the latest command and retry at bounded intervals, then show the existing load-failure message. |
| Deferred exit | ENTER followed by EXIT during a cold import could later stop successor media. | Retire deferred entry immediately, before the runtime is available. Recheck the room and connection before replay. |
| Cached bytes | An undecodable cached response was reused by the next attempt. | Evict only the exact owned Blob rejected with a native `EncodingError`. Permission, resume, memory, and stale-owner failures do not invalidate valid bytes. |
| Delayed start | A command older than the scheduling window restarted at its original position after a slow download. | Project from the calibrated host timeline, with a receipt-time fallback. An expired track waits for the next host command instead of wrapping. |
| Pause during load | Decode completion reset the host's paused position to zero. | Retain the latest pause intent and publish its position after decode, including the transport's already-paused READY state. |

The playback review also caught a wall-clock versus monotonic-clock deadline
mismatch. Audio transport deadlines use `performance.now()`; host clock values
are used only to calculate a relative delay and position. A host announces demo
PLAY only after its own output has started successfully, including delayed
gesture recovery. Retired recovery callbacks cannot announce an old track.

## Ownership and failure boundaries

- Local-file recovery retains ordinary queue/resident-file checks. Demo recovery
  has a separate identity and is retired on track, buffer, room, session, or demo
  changes.
- A queued remote command belongs to the exact host connection and room epoch.
  Reconnection, authority replacement, session exit, and DEMO_EXIT retire it.
- Lazy-import retries use 500, 1,500, and 3,000 ms delays after the initial
  attempt. Incoming frames replace the latest intent without resetting that
  retry budget.
- Native previous/next/seek controls do not manipulate the saved ordinary
  playlist while the demo overlay owns playback.
- No transport frame, server policy, room capacity, or storage schema changed.

## Verification scope

Regression tests cover failures before and after loading, latest-command
replacement, real protocol dispatch, paused READY transport, delayed starts,
native media actions, output interruption, and stale recovery callbacks.
Browser regressions use actual host/guest data channels and Web Audio decoding,
with controlled download and audio-resume failures. Native MediaSession tests
invoke the handlers actually registered by the application; they do not emulate
hardware media buttons or an operating system lock screen.

The Chromium run passed all 14 selected cases across `demo-track`,
`demo-reliability`, `demo-output-recovery`, and `background-resume`. The recovery
cases reject native `AudioContext.resume()` rather than manually emitting an
application recovery event, and confirm real source starts and clock progress
after the recovery button is clicked.

These checks cannot establish all-device reliability. This Windows machine's
Playwright WebKit lacks the Web Audio/WebRTC capabilities needed for a faithful
iPhone PWA session. Physical iPhone/Safari audio output, Wi-Fi-to-cellular
handover, venue congestion, and large participant counts still require rehearsal
on representative devices. Do not present a small local browser matrix as a
capacity test or a measurement of acoustic synchronization.
