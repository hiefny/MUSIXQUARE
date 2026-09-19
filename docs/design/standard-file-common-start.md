# Standard local-file and demo common start

Reviewed on 2026-09-19.

## Timing contract

A Standard coordinator with an open participant connection schedules its own
decoded file source 200 ms ahead, after AudioContext and engine preparation.
There is no participant readiness barrier or decoder acknowledgement wait.
Solo and offline playback keep their immediate start. Guided demo playback
uses the same 200 ms lead through its separate host-owned `DEMO_PLAY` path.
PRO server commits and YouTube zero-start retain their existing authority paths;
the guided demo remains unavailable in PRO rooms.

The source's committed canonical start is captured before post-start callbacks.
`PLAY.hostStartAt` names the host-clock instant at which `PLAY.time` becomes the
shared position. Ready guests translate that instant through their calibrated
shared clock and use a Web Audio deadline. They can start from the
requested position together with the host instead of skipping ahead to join.
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

## Guided demo preparation

Demo tracks are identified by demo index and decoded buffer, without creating
an ordinary queue item. With an open participant connection, the host schedules
its source 200 ms ahead after its own download, decode and audio preparation
succeed. It captures the actual
scheduled source deadline as `DEMO_PLAY.hostStartAt`; `DEMO_PLAY.time` is the
position at that instant. A delayed output-recovery retry publishes a fresh
owned start only after the replacement source is successfully armed.

A track load pauses the old output before publishing the new demo index or
clearing its buffer. While the host is loading, late-join bootstrap sends PAUSE
and file PONGs cannot advertise the new demo as playing. A guest whose download
finishes first therefore waits for the host's authoritative start instead of
playing early and restarting when the host finishes. Once the host is armed,
pending-start PONGs include the same anchor as DEMO_PLAY.

Guests that finish later project the elapsed position from the retained command;
an already expired track stays paused until the next host command. Without a
calibrated clock, a new shared-start command uses a 200 ms receipt-relative
fallback and the existing clock-correction path. The host never waits for every
guest, and neither cold clocks nor late downloads guarantee a precise first
sample. Demo preloading caches encoded bytes rather than a second decoded
buffer.

Previous/next controls retain host authority and the existing load-generation
fences. Loading, pausing and exiting clear the pending host anchor. Output-only
nudge and recovery rebuilds preserve an already scheduled source deadline.
Manual synchronization values persist across demo entry, track changes and exit.

## Compatibility and verification

Both command families preserve their historical legacy timestamp meaning:

| Command     | Common start  | Legacy timestamp                    |
| ----------- | ------------- | ----------------------------------- |
| `PLAY`      | `hostStartAt` | `hostPlayAt = hostStartAt + 200 ms` |
| `DEMO_PLAY` | `hostStartAt` | `hostPlayAt = hostStartAt + 350 ms` |

Older ready-buffer guests therefore join 200 ms or 350 ms after the respective
common start at the correct elapsed position. Updated guests still understand
an older host's `hostPlayAt`-only message. The new `hostStartAt` field is optional
and must be positive and finite; DEMO_PLAY retains its existing required
`hostPlayAt` field. YouTube messages are unchanged. Older guests do not understand
the pending-start PONG extension and retain their former bootstrap behavior.

Deterministic regressions cover early/late decode, route waits, cold clocks,
legacy messages, slow engine preparation, pause cancellation, canonical end
timing, nonzero seek positions, and PONGs received during setup/start. Demo
regressions additionally cover a faster guest waiting through host download,
legacy 350 ms commands, expired commands, previous/next authority and persistent
manual offsets. Browser tests exercise real host/guest transport and Web Audio
source scheduling, including entry from a playing file while the host's demo
download is held and the guest receives a real PONG. These checks establish
application timing and cancellation, not identical speaker or
Bluetooth latency across physical devices.
