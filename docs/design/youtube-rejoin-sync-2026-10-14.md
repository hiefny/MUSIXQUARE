# YouTube rejoin synchronization — 2026-10-14

## Scope and evidence

The owner reported two PRO-room YouTube symptoms: a mid-session joiner
sometimes did not start properly, and after a seek every device was aligned
while pressing Sync on any one device (including a controller) left only that
device slightly off until every device pressed Sync.

The server checkpoint is exact. A COMMIT stores the target position with
`updatedAtMs = executeAtMs`, the running position is
`position + (serverNow - updatedAtMs)`, and neither the Worker nor the client
parser rounds either value. Seek, resume and track changes prepare every
participant at the exact COMMIT target, so release only presses play and every
device shares the same small start latency.

Every participant-local rejoin instead seeked at the release instant:

- Manual Sync and the tap-to-play rejoin prepared at the current position and
  committed a position that had advanced during preparation. The arm then
  seeked during release and YouTube started late by its seek latency, which is
  never compensated. PRO YouTube has no running drift correction, so the offset
  stayed until the next server transition.
- Foreground recovery and a Play pressed while the room already played used the
  direct seek-and-play path.
- A late-join restore prepared at the stale checkpoint anchor (song start or the
  last seek, possibly minutes old) and released immediately with a far,
  unbuffered seek. Release ACK took longer than 1.8 s on slow networks, which
  failed the commit.
- The restore catch-up reused the `snapshot_<revision>` authority, so it only
  observed the cached failed preparation. The participant stayed silent until
  the next 15 s heartbeat.
- The YouTube prepare budget (2.3 s) also had to cover the first IFrame API and
  player load on non-iOS clients, which pre-create no player.
- A never-primed iOS iframe returned `audio-locked` with no prompt.

A desktop Chromium reference measurement (youtube.com watch page, the player API
used by the embed, 480p, data already buffered) showed the size of the gap:

| Release | Media start relative to the planned instant |
| --- | --- |
| Settled at the target, then play only (seek path) | −52 to −56 ms, stable |
| Seek and play at the release instant (Sync path) | −131 to −478 ms, up to −832 ms near the buffer edge |
| Far unbuffered seek and play (late-join path) | PLAYING after 621 ms, −647 ms |

Standard rooms rendezvous differently (pre-seek a future host position, buffer
gate, play only, learned start latency), so Sync is precise there. Their gap is
the buffer-gate fallback: when the target is not buffered within about 1.35 s
the guest starts with a plain seek and play, and heartbeat correction only acts
above 3 s.

## Change

PRO (participant-local; no Worker, protocol or schema change):

- A YouTube manual Sync or tap-to-play rejoin picks its release instant before
  preparing, settles at that exact position and releases only by play. The lead
  is sized from this session's measured YouTube preparation durations
  (1.5–4 s, default 2 s); only preparation time is learned, never media timing.
  An overrun re-arms once at a fresh instant; a second overrun keeps the
  previous rebased release. File playback keeps its existing timing.
- Foreground recovery and an unchanged Play now rejoin through that rendezvous.
- A restore or delayed COMMIT whose instant is past or under 1.5 s away
  prepares the position of a participant-local instant at least 3 s ahead. An
  overrun, or a YouTube release later than the arm's 40 ms no-seek tolerance,
  re-arms through the catch-up path instead of seeking during release.
- A failed YouTube restore preparation is released before its catch-up, so the
  catch-up genuinely retries. File failures keep one attempt per request.
- Commit follow-ups keep the requester's clock lease, and a reconciliation waits
  for an in-flight commit of the same revision instead of reporting not ready.
- The arm seeks to its target before the muted warm-up play, so PLAYING proves
  the release region is loaded. A paused iframe otherwise reports a settled
  target before that region is buffered.
- Restores, catch-ups and local rejoins (no server READY barrier) allow 10 s
  for YouTube preparation. A server PREPARE keeps 2.3 s.
- A never-primed iOS PRO endpoint shows TAP TO PLAY; that tap unlocks the exact
  iframe for preparation.
- A local YouTube rejoin whose preparation times out on a present player rejoins
  directly instead of staying paused. The arm pauses the iframe while preparing,
  and a heartbeat never re-applies an already applied revision, so production
  left the endpoint silent after a failed Sync.

Standard rooms (guest only; no message format change):

- One silent follow-up precision rendezvous after a buffer-gate fallback.
- An automatic silent precision rendezvous when the clock-extrapolated heartbeat
  drift is 150 ms–3 s with the same sign on two consecutive heartbeats; 30 s
  cooldown, at most 3 per occurrence, suppressed during host ads, local pause,
  zero-start and pending rendezvous work.

## Verification

Environment: Windows 11 Pro local worktree, Node 24.13.1 (the repository pins
24.20.0, which pull request CI uses), Vitest 5.0.3, Playwright 1.63.0 with
Chromium. jq was supplied through `MXQR_TEST_JQ_PATH`, so the jq-dependent
release test ran. Tested source:
**`75eec3686a52c4e979557e0514913fbf786b7fe7`** (8.10.18, cache epoch v684),
branch `agent/youtube-rejoin-sync`, clean tree. Later commits on the branch
change documentation only. These are local and branch results, not the
exact-main release candidate.

| Check | Result |
| --- | --- |
| Full `vitest run` | 563 files, **12,713 passed / 0 failed / 0 skipped**, 157.03 s |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed, zero warnings |
| `npm run format:check` | Passed |
| `npm run test:e2e:critical` | **29 passed / 0 failed / 0 skipped / 0 flaky**, 1.4 min |
| YouTube and playback-sync E2E (six files below) | **28 passed / 0 failed / 0 skipped / 0 flaky**, 9.0 min |
| Pull request CI on this SHA | 11 checks passed |

The browser run used `e2e/youtube-sync.test.ts`, `e2e/playback-sync.test.ts`,
`e2e/youtube-output-delay.test.ts`, `e2e/youtube-pending-seek.test.ts`,
`e2e/youtube-manual-zero-start.test.ts` and `e2e/sync-flight-recorder.test.ts`,
project `chromium`, after `npm run build:e2e`, with no retries.

New or updated pins: the arm warms at the release target; a manual rendezvous
commits its prepared position and re-arms once on overrun; a late restore
settles at a planned instant, re-arms on overrun and genuinely retries a failed
YouTube preparation; an unbarriered preparation gets the long budget; a
never-primed iOS PRO endpoint gets the tap gate and that tap unlocks it;
Standard follow-up and automatic realign rules (36 cases).

Not verified: physical iOS/Android devices, real speaker output, WebKit, and the
full serial E2E suite. Production before/after measurements are recorded below.

## Production measurements

Method: Claude's built-in Chromium, app volume 0 (muted), video `dQw4w9WgXcQ`.
Each value is the median of 25 samples over 1 s of
`getCurrentTime() * 1000 - Date.now()`; tabs share one wall clock and the
sampling spread was 1–3 ms. Standard values are guest minus host (negative is
behind). The 8.10.17 run used three tabs (host, guest, late joiner). The 8.10.18
run in room 674415 used two; each late join reloaded the guest tab and rejoined
while the host played. No 8.10.18 measurement window contained a hidden period.

| Scenario | 8.10.17 (before) | 8.10.18 (after) |
| --- | --- | --- |
| Standard: host seek, guest after Stage 2 | −8.5 ms | −8.1 ms |
| Standard: guest manual Sync | −19.7 ms | −7.8 ms |
| Standard: late join, 13 s / 29 s after joining | −386 ms (20 s); −877 / −878 ms | −4.9 / −5.2 ms; −11.6 / −11.9 ms |

While the 8.10.18 guest tab was being opened, the muted host video paused (the
hidden-tab artifact also noted in the 8.10.17 run) and paused the room. After the
host resumed, the guest re-aligned at −28.5 ms.

PRO values come from the flight recorder (`/debug sync`) of one participant in
the owner's room 020924 (YouTube `GKC1P0mCt4o`, room volume): `youtube-sample`
`timelineDriftMs` at 800 and 2000 ms, the media position against the server
timeline (negative is behind). Each session's clock estimate carries its own
error, so compare the paths rather than single values. After release this
member had no playback permission, so no server transition was measured.

| PRO scenario | 8.10.17 (before) | 8.10.18 (after) |
| --- | --- | --- |
| Server seek (prepared, no release seek) | −71 ms | not measured (no playback permission) |
| Manual Sync / local rendezvous | −1062 ms (2.23 s release seek, ACK 1252 ms) | −62, −64 ms (no release seek, ACK 271–280 ms) |
| Resume COMMIT after an overrun preparation | −1003 ms (18.5 s release seek, ACK 1220 ms) | not reproduced (needs a server transition) |
| Foreground recovery | −149, −343 ms (direct seek and play); several not playing | −84 ms (no release seek; hidden→visible simulated with `visibilitychange`) |
| Late join | 9 restore attempts in 2 min, no release (silent) | −75, −66 ms (no release seek); audible 5.6 s and 4.8 s after `session-start` |
| Manual Sync failure | "not ready" toast, endpoint left paused | not observed (2 of 2 succeeded) |

After release every measured PRO YouTube rejoin started without a release seek at
−62 to −84 ms, the range of the 8.10.17 server-seek reference (−71 ms) that
shares the play-only release. These are single-browser desktop measurements.
This release does not change the join handshake before `session-start`, which
took 11.1 s and 6.6 s after the join tap here.

Pressing the transport button on the silent 8.10.17 late-joined endpoint paused the
whole room: the button follows the participant's local playback state, which
had stayed "playing" while the iframe was not. This is recorded as a follow-up;
the rejoin fixes remove the silent state that exposed it.

## Release and recovery

App **8.10.18/v684** shipped through
[Production Release 38566206816](https://github.com/hiefny/MUSIXQUARE/actions/runs/38566206816),
attempt 1, target `app`, Developer API D1 application `false`. The deploy job
completed successfully at **2026-10-14 21:47:35 KST** using the immutable candidate
from exact-main CI `38565478458` for `cb81a89c6728a94fd8ae63253189888bc45d13ac`.
No rollback was needed; the recovery job was skipped.

- App version `92b9d320-5a02-453e-ad91-76d4773fb3b4` became
  `71aa66e3-3154-451f-86bb-2f4558bc863e`. Final deployment ownership was verified
  at 21:47:29.887 KST, and the coherent production marker records the exact SHA
  and target `app`.
- The partial-release compatibility recheck at 21:46:49.660 KST was compatible,
  and the five unselected Workers were not changed. Per-Worker deployment
  identities are in the run artifact
  `production-deployments-cb81a89c6728a94fd8ae63253189888bc45d13ac-38566206816-1`.
- App generation (`main-Ct34UoSY.js`, 27 assets converged), anonymous App account
  boundary, current PRO public boundary (pro-room
  `8d5d44c0-c925-4495-86d7-29bf11a0958e`) and Standard HTTPS signaling smokes
  passed. Out-of-scope Worker smokes were skipped, not counted as passes.
- Public checks at 22:01:02 KST returned HTTP 200 for `/`, the v684 service
  worker, `bootstrap.js?cache=v684`, `main-Ct34UoSY.js` and `main-BNiplmKU.css`.
  A tab open before deployment reloaded into the new bundle and showed the normal
  update dialog for the waiting service worker; Refresh activated it.
- [Operations Drift Audit 38566627830](https://github.com/hiefny/MUSIXQUARE/actions/runs/38566627830)
  succeeded. Its 21:48:40.861 KST report records **31 pass / 0 fail / 5 manual-only**;
  manual checks are not treated as completed.

The immutable recovery checkpoint captured at 21:46:09.984 KST
(`production-recovery-checkpoint-cb81a89c6728a94fd8ae63253189888bc45d13ac-38566206816-1`)
preserves the previous App `75fceac17615abf1dbff2a64ef513300ae3450d7`, 8.10.17/v683,
version `92b9d320-5a02-453e-ad91-76d4773fb3b4`. Rolling back to it restores the
release seeks, the silent restores and the late Standard starts measured above.
Mixed versions are safe because every change is participant-local. The
checkpoint is not a user-data backup; no data migration is needed and existing
recovery floors remain binding.
