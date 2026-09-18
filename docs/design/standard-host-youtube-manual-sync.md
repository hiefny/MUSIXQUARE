# Standard-host YouTube manual synchronization

The host's manual offset belongs to that device. Changing it must not pause,
seek, or reschedule the guests. PRO participants share the local input,
rendezvous, and verification mechanism while retaining the server-owned timeline.

## Input and ownership

The network controls distinguish user input from internal offset corrections.
Plus/minus inputs update the displayed value immediately and wait one second
after the last input before touching the iframe. Numeric confirmation and Reset
commit immediately. Internal callers that omit the input mode retain the
immediate correction path, including the end-of-media guard.

Waiting for input does not reserve the playback gate. Once a transaction starts,
the gate owns its iframe commands through verification or recovery. Further user
edits retain only the latest value and start after the active transaction
settles. They cannot cancel a preparation halfway through or overwrite the
physically verified offset. The pending value is fenced by player, session,
room generation, queue occurrence, video, and playlist sub-index.

## Host-only rendezvous

For a playing host, the runtime anchors the advancing canonical room clock,
pauses the host iframe, and waits for its acknowledgement. A native playlist
is detached when required before preparing the selected video. The host then
seeks to the canonical position 1.5 seconds ahead plus its requested offset.
Playback resumes at that deadline, advanced by the existing device play-latency
estimate. A host that was already paused receives a local seek and stays paused.

The anchor keeps the room timeline advancing while the host prepares. The
existing gate prevents preparation callbacks from becoming room transport
commands. Once playback settles, the runtime stores the observed physical
offset, rather than assuming that YouTube achieved the requested value exactly.
Consequently the host's physical repositioning does not shift the canonical
timeline broadcast to guests.

Preparation has a two-second acknowledgement limit. A play callback arriving
more than 150 milliseconds after its deadline must not play the obsolete
target. Missing readiness, late execution, and media-end conflicts enter the
existing verified rollback path. Media replacement or authority loss cancels
the plan and its timer without issuing a command to replacement media.

## PRO participant offsets and Reset

PRO plus/minus edits, numeric confirmation, and Reset use the same input modes
and physical verification as the Standard host. They affect only the requesting
participant. They create no server playback command, room-wide rendezvous, or
playback revision; the legacy `standard-host-manual-offset-*` exports remain the
shared local-media gate.

PRO anchors from the exact applied server checkpoint and calibrated server
clock, never from a potentially drifted iframe position. Reset commits a zero
offset through the same preparation and verification, so it also corrects
preexisting local drift. Paused server playback remains paused. If the current
checkpoint, calibrated clock, or settled playback owner is unavailable, the
operation issues no iframe command and retains the previous verified offset.

The read-only timeline provider is registered by the PRO playback controller.
Its liveness binds the room incarnation, runtime generation, playlist lease,
and applied playback revision. A newer accepted PREPARE/COMMIT cancels local
timers before its endpoint commands. Same-media server work retains the
participant's requested offset; stale or wrong-room work cannot cancel it.
Neither polling an unchanged checkpoint nor ordinary presence updates create
a new local playback transaction.

## Verification boundary

Unit coverage exercises batching, serialization, finite values, stale identity,
playlist preparation, late execution, paused intent, and rollback. PRO coverage
also verifies drifted zero-offset Reset, server-clock projection, runtime and
revision fencing, and canonical work superseding local preparation. Real iframe
checks must additionally measure host commands, guest playback, and continuity
of the canonical clock. Iframe time observations do not establish audible
speaker synchronization or guarantee millisecond accuracy on every device.
