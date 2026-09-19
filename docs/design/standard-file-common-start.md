# Standard local-file common start

Reviewed on 2026-09-19.

## Timing contract

A Standard coordinator with an open participant connection schedules its own
decoded file source 200 ms ahead, after AudioContext and engine preparation.
There is no participant readiness barrier or decoder acknowledgement wait.
Solo and offline playback keep their immediate start. PRO server commits,
YouTube zero-start, and demo playback retain their existing authority paths.

The source's committed canonical start is captured before post-start callbacks.
`PLAY.hostStartAt` names the host-clock instant at which `PLAY.time` becomes the
shared position. Ready guests translate that instant through their calibrated
shared clock and use a Web Audio deadline. This preserves the first audio sample
instead of starting the host immediately and having guests skip ahead to join.
Manual output offsets continue to affect local output, not the canonical room
position, start message, or natural-end deadline.

The 200 ms is synchronization lead, not a bound on file download, decoding,
browser audio permission, or operating-system scheduling. The protocol does not
increase decoded PCM residency: `preload.ready` remains an encoded resident
file, which is decoded when activated. A precision-ready participant needs the
correct decoded buffer, usable audio output, and a calibrated shared clock.

## Preparation and cancellation

Each guest captures the timeline once before asynchronous route classification,
fetching or decoding. The existing pending-play mailbox retains the position
and its participant-local wall-time anchor, which may be in the future.
Completion before the anchor schedules the remaining lead; completion after it
joins at the elapsed position. Transport consumes an absolute monotonic deadline
after audio setup so setup time is not added twice.

A guest without clock samples never uses its raw clock as the host clock. It
uses a short local fallback and requests a clock sample; subsequent correction
remains responsible for alignment. Such a participant is not promised a precise
first-sample start and never delays the coordinator.

File sync still accepts clock samples during audio setup and a scheduled start,
but cannot replace the in-flight or armed source with an immediate correction.
Rearming initial sync retires the previous initial-correction flag. A host PONG
during the pending start includes the same canonical anchor, allowing a guest
that missed PLAY to bootstrap without beginning before the host. Accepted new
PLAY, PAUSE, selection, session and output-recovery paths retain their existing
invocation, occurrence and load-epoch fences.

## Compatibility and verification

PLAY also includes `hostPlayAt = hostStartAt + 200`. Older ready-buffer guests
therefore join 200 ms after the common start at the correct elapsed position.
Updated guests still understand an older host's `hostPlayAt`-only message.
Both timestamp extensions are optional and require positive finite values;
YouTube and demo messages are unchanged. Older guests do not understand the
pending-start PONG extension and retain their former bootstrap behavior.

Deterministic regressions cover early/late decode, route waits, cold clocks,
legacy messages, slow engine preparation, pause cancellation, canonical end
timing, nonzero seek positions, and PONGs received during setup/start. Browser
tests exercise real host/guest transport and Web Audio source scheduling. These
checks establish application timing and cancellation, not identical speaker or
Bluetooth latency across physical devices.
