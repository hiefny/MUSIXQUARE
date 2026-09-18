# YouTube precision synchronization recovery

Reviewed on 2026-09-18 for Standard-room seeks and PRO participant-local
millisecond adjustment, including the synchronization Reset action.

## Standard room: retain the final precision request

A host or administrator seek runs through the host's two-stage scheduler.
Stage 1 applies the new transport position immediately; Stage 2 requests
precision guest rendezvous two seconds later. A newer seek cancels an active
guest countdown, but intentionally retains the iframe's three-second
rendezvous cooldown.

Previously, Stage 2 ignored the `busy` result from `guestRendezvousSync()`.
If the previous countdown had just been cancelled, the replacement precision
request disappeared and only periodic drift correction remained.

The final request now uses the existing bounded readiness retry mechanism.
It respects the cooldown, reads the latest matching host position, and owns
only its original connection, queue occurrence, and YouTube sub-video. Newer
explicit transport intent supersedes it. Incidental iframe buffering reports
must not be mistaken for a replacement user action. A participant's later
local pause must also remain paused.

## PRO room: verify local compensation against the server timeline

PRO millisecond adjustment and Reset previously called `seekTo()` immediately
and recorded the theoretical requested displacement as already applied.
Buffering and delayed iframe commands could make that record inaccurate.

PRO now shares the deferred local transaction used by the Standard host:
repeated increments settle after one second, while numeric confirmation and
Reset commit immediately. Playing endpoints prepare a future position and
resume on a deadline; paused endpoints remain paused. Verification records the
observed physical residual and retains the existing rollback behavior.

PRO obtains its baseline from the currently applied server checkpoint and
calibrated server clock. Reset therefore removes preexisting local drift as
well as the selected offset. A read-only provider fences that baseline by the
controller lifecycle, playlist lease, room incarnation, and playback revision.
Accepted canonical media work retires the local transaction before it can
write to the endpoint. No local adjustment creates a room command or changes
the server revision.

## History evidence

Dates below are commit dates in Asia/Seoul, not proof of when a particular
device first exhibited the problem. No historical browser bisect was run.

- `dea108708486` (2026-04-12) cancelled an active guest rendezvous on newer play.
- `af64b8bbfa2a` (2026-04-13) introduced the three-second rendezvous cooldown.
- `b52ef8e80dc9` and `b4b2a0915b7d` (2026-04-15) established the unchecked manual
  rendezvous call and the two-second precision request after seek. These are
  the earliest identified ingredients of the lost-request mechanism.
- `7298af33900c` (2026-07-17) introduced direct PRO coordinator iframe nudges;
  `d4b208cc48ab` (2026-07-20) extended that behavior to all PRO participants.
- `15947883f510` (2026-08-29) added the verified Standard-host local transaction.
  `494af91799db` (2026-09-13) added its scheduled user-input path while retaining
  PRO's immediate path. It did not newly introduce the Standard seek defect.

## Verification scope

Regression tests exercise cooldown replacement, newer intent, connection and
media replacement, local pause, PRO server-time correction, zero-offset Reset,
paused playback, and canonical authority preemption. Deterministic iframe
tests prove command order and lifecycle ownership; they do not measure actual
YouTube decoder or speaker latency on physical devices.
