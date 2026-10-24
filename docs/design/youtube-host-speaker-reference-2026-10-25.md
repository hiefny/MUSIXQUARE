# YouTube host speaker reference after a zero-start — 2026-10-25

## Report

The owner reported, for Standard-room YouTube, that the first playback of a
YouTube occurrence left the room unstable: adding YouTube to an empty playlist,
switching from a local file to YouTube, and returning to YouTube after a local
file. While in that state the host could press Sync any number of times and the
room stayed misaligned; a guest pressing its own Sync came roughly into line.
After the host seeked once, Sync worked and the synchronization data was clean.
The owner asked whether the host and guest Sync paths differ, and why a seek
cleans the state.

## Cause

All three first-play cases start through the zero-start barrier
(`src/youtube/zero-start.ts`): the host releases its own iframe at the
committed instant, minus its fixed output lead, and every guest releases
against the same instant.

Since 8.10.2 (`80b92c99`, deployed 2026-10-13), the host's release callback
(`onPlaybackStarted` in `src/youtube/player.ts`) measured its local media
position minus the scheduled room position at the PLAYING callback and kept
the whole difference as `sync.youtubeCoordinatorAppliedOffset`. That
difference contains the real media startup lateness. `toCanonicalYouTubeTime`
removes the offset before the host publishes any position, so heartbeats,
manual Sync broadcasts and the zero-start TIMELINE frames published the
schedule while the host speaker played behind it by its startup lateness.
Nothing moves a Standard host's own iframe, so the gap stayed for the whole
occurrence:

- guest automatic realignment (8.10.18 onward) and every precision rendezvous
  moved guests onto the published schedule, away from the host speaker;
- host Sync re-sent the same published position, so pressing it again could
  not close the gap;
- zero-start guests learned their release lead against the published schedule.

A seek (`scheduleYtAutoSync`) sets the offset to the deliberate advance only
(manual offset plus output lead), so the published position became the host
speaker again and the following Stage 2 rendezvous aligned every guest to it.
That is why one seek cleaned the state.

### Measured media startup

A desktop Chromium probe of the real YouTube IFrame API (embedded player on a
localhost page, muted, test video `M7lc1UVf-VE`) fitted `getCurrentTime()`
against `performance.now()` over 1.5–4 s after `playVideo()`:

| Release | Media start after `playVideo()` | `getCurrentTime()` read error at PLAYING |
| --- | --- | --- |
| Paused and settled at 0 (on-time zero-start release), 4 runs | 44 ms each | 0–2 ms |
| Seek and play together (late zero-start release), 3 runs | 126, 138, 248 ms | 1–2 ms |

The PLAYING callback arrived 265–479 ms after the call, but the position read at
that callback was accurate, so the old measurement recorded the true startup
lateness, not a callback artifact. Mobile devices and a first, cold load are
expected to start later; this probe is one desktop reference.

## Host Sync and guest Sync

Both paths re-align guests to the host's published position and never touch
the host iframe:

- Host Sync (`handleMainSyncButtonRuntime` →
  `broadcastYouTubeSync(true)`) sends a fresh `YOUTUBE_SYNC{isManual:true}`;
  each guest stores it as its host snapshot and runs `guestRendezvousSync()`.
- Guest Sync runs the same `guestRendezvousSync()` on the latest heartbeat
  snapshot, extrapolated with the same host clock stamp.

The target formula, buffer gate, release timing and learning are identical, so
there is no defect specific to the host path. A new pin in
`sync-integration.test.ts` ("aligns to the same target at the same instant from
either button") drives the real `sync.ts` both ways on one host timeline: the
same seek target and the same play instant. The difference the owner saw comes
from what both paths align to: after a first play the published position was
not the host speaker. A guest's first precision rendezvous also starts late by
its own unlearned startup, which can land it near the host by coincidence;
repeated presses learn that startup and land exactly on the published position,
away from the host. This explains the observation only as a likely mechanism;
the owner's devices were not instrumented.

## Change

`onPlaybackStarted` for the host now removes only the advance the release
applied on purpose: the manual offset resolved for the release target plus the
release lead. This is the value the existing unreadable-position branch already
used and the value every seek sets. Media startup lateness stays in the
published room position, so heartbeats, Sync and the zero-start TIMELINE frames
describe what the host speaker plays, and guests align to it. Zero-start guests
again learn their release lead relative to the host's actual start.

This deliberately reverses one rule of the 2026-10-12
[Android output baseline](android-youtube-output-baseline-2026-10-12.md): "real
delayed media progress do not rebase the shared clock" for a Standard host's
zero-start. That rule assumed every endpoint would be corrected to the shared
position, but a Standard host is never re-aligned, and every other Standard
host path (seek, resume, legacy rendezvous, Stage 2) already defines the shared
position by the host iframe, startup lateness included. The Android 250 ms
baseline and the removal of the host's applied advance are unchanged.

The zero-start controller never begins in PRO rooms (it needs live Standard
guest connections), so PRO is unchanged. No wire format, timer, schema or
Worker changes. A mixed room (known-accepted #13) only changes which position a
new host publishes; old and new guests align to it the same way.

## Verification

| Item | Code SHA | Environment | Result |
| --- | --- | --- | --- |
| New regression: host publishes its own speaker after a 180 ms late media start, then a seek keeps the same reference (Android and other, manual −0.4/0/0.4) | `c61e7d50` test against unfixed source | vitest, Windows, Node 24.20.0 | 6/6 fail before the fix (published 180 ms ahead of the speaker) |
| Same test and updated residual matrix (late timer, late PLAYING ack, late media start × five manual offsets) | `c61e7d50` | vitest | `player.test.ts` 128/128 pass |
| YouTube, player, network, PRO, UI and diagnostics unit suites | `c61e7d50` | vitest | 374 files, 9,598 tests pass |

## Owner device check

Not done by this change; for the owner on real devices:

1. Standard room, host and at least one guest, empty playlist. Add YouTube and
   play. After about 10 s, listen for an echo between host and guest. Press
   Sync on the host two or three times; the guest should stay with the host.
2. Repeat with a local file playing first, then YouTube; then YouTube → local
   file → YouTube.
3. Judge by ear. A guest's `/debug sync` (`youtube-rendezvous-sample`
   `timelineDriftMs`) shows only how closely the guest follows the position the
   host publishes, which looked equally small before this change, so it cannot
   show a host-to-guest gap by itself.
