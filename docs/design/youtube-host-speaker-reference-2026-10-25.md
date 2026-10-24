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

## Real YouTube lab

Two Chromium contexts on one Windows PC, an e2e build, local PeerJS signaling
(no production room), browser audio muted, test video `M7lc1UVf-VE`. The
host added the video from chat on an empty playlist (zero-start), then pressed
Sync four times, the guest pressed its own Sync twice, the host seeked to
120 s and pressed Sync once more, 7 s apart. Both pages share `Date.now()`,
so the value is the guest's media position minus the host's at the same
instant, averaged over 25 samples (positive: guest ahead).

| Step | Before (`cae7a118`) | After (`c61e7d50`) |
| --- | --- | --- |
| Host applied offset after the first play | −70 ms (startup lateness) | 0 ms |
| First play, 25 s in | −10 ms | +20 ms (playing throughout a 12 s trace) |
| Host Sync 1, 2, 3, 4 | −1, +16, +33, +27 ms | −92, −48, −46, −25 ms |
| Guest Sync 1, 2 | +25, +64 ms | −35, −29 ms |
| After the seek (offset reset to 0 on both) | −20 ms | −6 ms |
| Host Sync after the seek | −4 ms | −8 ms |

Each new browser starts with a learned start latency of 0, so its first
rendezvous lands late by its own startup and every further rendezvous learns
part of it. Before the fix that learning walked the guest away from the host,
towards the host's 70 ms startup lateness; after it the guest converges on the
host. Real devices keep the learned value in storage, so they start nearer
the end of that walk. One earlier run of each build (stopped by the lab
script, not the app) agreed: before −72/−66 ms host offset and +3, +22, +48 ms
after three host Syncs; after 0 ms.

## Verification

| Item | Code SHA | Environment | Result |
| --- | --- | --- | --- |
| New regression: host publishes its own speaker after a 180 ms late media start, release timer on time or 120 ms late (seek), then a seek keeps the same reference (Android and other, manual −0.4/0/0.4) | `de43660e` tests on the unfixed `player.ts` | vitest, Windows, Node 24.20.0 | 22 fail (published 180 ms ahead of the speaker); the 5 late-PLAYING-ack matrix cases cannot tell the versions apart |
| Same tests and the updated residual matrix | `de43660e` | vitest | `player.test.ts` 134/134 pass |
| Host Sync and guest Sync parity pin | `de43660e` | vitest | `sync-integration.test.ts` 232/232, twice |
| YouTube, player, network, PRO, UI and diagnostics unit suites | `c61e7d50` | vitest | 374 files, 9,598 tests pass |
| typecheck, lint, format | `6e274396` | Windows | pass |
| YouTube e2e: output delay, manual zero-start, sync, youtube, end transition, manual repeat, pending seek | e2e build of `c61e7d50` | Playwright Chromium, fake YouTube, local PeerJS | 39/39 pass |
| Independent review (separate agent, code only) | `c61e7d50` | — | No correctness defect; the low-severity notes are under Limits |
| PR #484 CI and Codex review | head `859beea3` (with #483 merged and the v780 bump) | GitHub Actions | 11/11 checks pass; Codex no findings on `de43660e` |
| Exact-main CI | main `8c3fdcab` (tree equal to `859beea3`) | [CI 40122288691](https://github.com/hiefny/MUSIXQUARE/actions/runs/40122288691) | 11 jobs success |

## Limits

- Guests' zero-start lead now learns their start relative to the host's
  previous start. A host start that was unusually late (a release more than
  40 ms late, which seeks and plays) is copied into every guest's next start
  until heartbeat or auto-realign corrects it. This was the behaviour before
  8.10.2.
- A guest that recovers through the late or app-owned zero-start fallback still
  aims at the signed schedule, which is now 44–250 ms ahead of the host, until
  the next heartbeat or auto-realign.
- The seek path's held local start (a negative manual offset) keeps up to
  40 ms of its timer lateness in the offset; zero-start now publishes that
  lateness. The two references differ by at most 40 ms.
- The lab is one desktop PC with real YouTube; phones, Bluetooth output and
  the owner's network were not measured.

## Release

Shipped as 9.0.8 / v780 together with #483 (iOS spectrum grid colour), owner
decision of 2026-10-25, in one App release from main `8c3fdcab` (PR #484
squash; #483 is `bd94075c`). 9.0.8 / v779 was never deployed, so only the cache
epoch moved to v780.

- [Release 40122870289](https://github.com/hiefny/MUSIXQUARE/actions/runs/40122870289)
  deployed App `bee2cc98`, then the Standard HTTPS signaling smoke's guest
  bridge returned `HTTP 502 STANDARD_SIGNALING_BRIDGE_UNAVAILABLE` (5,743 ms).
  The workflow rolled the App back to 9.0.7 `1afafcdd`; final boundary verified.
- [Release 40123156024](https://github.com/hiefny/MUSIXQUARE/actions/runs/40123156024)
  on the same SHA succeeded: App `1513bc69` at 04:00:37 KST, every smoke
  success (`bridgeOpenMs` host 945 ms, guest 478 ms), public `/` and
  `/service-worker.js` at v780, partial-release compatibility compatible,
  [Drift 40123389462](https://github.com/hiefny/MUSIXQUARE/actions/runs/40123389462)
  31 pass / 0 fail / 5 manual-only.
- Rollback to 9.0.7 / v778 is possible; it only brings back this defect and the
  iOS blue grid.

## Owner device check

Not done yet; for the owner on real devices with 9.0.8:

1. Standard room, host and at least one guest, empty playlist. Add YouTube and
   play. After about 10 s, listen for an echo between host and guest. Press
   Sync on the host two or three times; the guest should stay with the host.
2. Repeat with a local file playing first, then YouTube; then YouTube → local
   file → YouTube.
3. Judge by ear. A guest's `/debug sync` (`youtube-rendezvous-sample`
   `timelineDriftMs`) shows only how closely the guest follows the position the
   host publishes, which looked equally small before this change, so it cannot
   show a host-to-guest gap by itself.
