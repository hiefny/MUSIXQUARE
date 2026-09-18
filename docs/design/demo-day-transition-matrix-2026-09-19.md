# Demo Day media transition review

Baseline: `99b8c1b1`, MUSIXQUARE 8.6.46 / cache v613. This review extends
[the demo reliability review](demo-reliability-2026-09-19.md) to local files,
YouTube, playlist sub-items, system audio, and room transitions. The purpose
is to find reproducible ordering defects before rehearsal, not to claim that
all possible devices or event sequences have been exhausted.

## Test design

The matrix crosses the following boundaries. It is targeted interaction
coverage, not the full Cartesian product of every row.

| Dimension         | Cases reviewed or exercised                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Media             | Local MP3, YouTube single video, YouTube playlist inner item, system audio, demo                           |
| Authority         | Standard host, member, operator; PRO current and retired sessions                                          |
| Action            | Select, Previous, Next, seek, pause, stop, repeat off/all/one, shuffle, reorder, remove                    |
| Pending work      | Download, preload, native decode, iframe load, clock countdown, audio restore, late stream, refresh        |
| Superseding event | New queue occurrence, same video at a new inner index, room rejoin, disconnect, force-stop, clock reset    |
| Delivery          | Repeated frame, delayed callback, conflicting identity, overlapping background/unicast transfer            |
| Timing            | Immediate and delayed player commands; seeded rapid actions with 0–129 ms gaps; callbacks after retirement |

A pass requires an expected result, not merely an absence of console errors:

- The final accepted action owns the queue occurrence, media kind, inner
  index, playback activity, and concrete player.
- An outgoing timer, transfer, decode, or stream cannot mutate a successor.
- Paused/stopped media must not autoplay during video reconciliation.
- Transfer progress and received bytes survive a repeated announcement.
- File playback checks native Web Audio sources in the mixed-media harness;
  system-audio checks use real MediaStream/WebRTC reception with a synthetic
  input. YouTube's controllable backend is explicitly a mock.

## Confirmed defects corrected

| Boundary                                                       | Reproduced failure                                                                                                                                                        | Correction                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background preload overlapping a late peer bootstrap           | Both real sender lanes emit the same START. The second START rewinds progress and discards a received prefix. Duplicate drained chunks also retain an extra encoded copy. | Treat an exact active/completed START as idempotent; reject conflicting immutable session fields; ignore already-drained chunks. A skipped attempt can still accept a real retry. |
| Paused YouTube target differs from the resident video          | STATE and periodic SYNC load the new video through an autoplaying API despite the host being paused.                                                                      | Cue the authoritative target and time without playing it.                                                                                                                         |
| Stopped YouTube target differs from the resident video         | Video reconciliation runs before terminal STATE/SYNC handling.                                                                                                            | Apply terminal intent before any load/play reconciliation.                                                                                                                        |
| Adjacent playlist entries contain the same video               | The logical inner index changes, but a shared flag skips the required position update.                                                                                    | Update the index and apply the new occurrence's time even when the video ID is unchanged.                                                                                         |
| Zero-start preparation outlives its iframe or calibrated clock | A pending countdown can release a replacement player; audio restoration and fallback callbacks can touch it too.                                                          | Recheck the prepared iframe and video at delayed mutation boundaries and use existing bounded fallback when its ownership or clock proof is lost.                                 |
| Rejected YouTube PLAY overlaps a file transfer                 | The current host sends an unknown or wrong-kind queue ID. The handler cancels the current transfer before rejecting that ID.                                              | Validate accepted queue membership/type before changing pause intent, timers, or transfer ownership.                                                                              |

Standard ICE candidate refinement is a seventh confirmed boundary. Chromium's
native selected-pair snapshot can remain host/prflx after selected transport
statistics refine that same connection to host/host. The native fast path hid
the newer proof. Classification now reconciles only a unique transport-selected,
succeeded host/host pair with matching endpoint and generation evidence on the
same still-open connection.

The core failure paths were reproduced before their fixes; additional tests
preserve successful playback, cancellation, and retry behavior.
The final cross-review also reproduced reset, cancel, and ABORT cleanup
acting on a replacement iframe before the next release check. Cleanup now
retains the exact original audio-state owner before target loading, then the
prepared target owner. Detached audio-restore retries also stop when that
player or its verified video changes. Normal same-player cancellation still
restores the user's original audio state.

The preload regression uses actual senders, protocol admission, and RAM
storage, including a completed resident, one acknowledgement, skipped retry,
and conflicting session. YouTube admission tests run the real protocol
dispatcher and queue authority gate, with player/transfer effects observed.

## Existing protections reverified

- Signaling-only loss through the full bounded reconnect sequence preserves a
  working data channel and pending/file/system-audio playback for members and
  operators.
- A system-audio initialization or stream callback arriving after force-stop
  or connection closure cannot replace successor file playback.
- PRO preload/foreground completion, refresh, and heartbeat from a retired
  same-room session cannot overwrite a rejoined session, even with reused
  queue identity.
- File selection/decode and queue reorder/removal retain occurrence and load
  ownership; there was no reason to duplicate the earlier early-selection fix.
- The new browser end-transition matrix first observes the guest receive a
  near-end seek, then ends/repeats the host and either keeps the repeat, seeks
  again, or selects a local file. It checks both immediate and delayed guest
  players, then crosses the outgoing timer windows to detect late regression.

## Evidence and scope

The complete local unit run passed 8,739 tests in 430 files, with one existing
skip. The final focused YouTube run passed 746 tests. The subsequent ICE
refinement added 32 cases; its focused peer/host/guest run passed all 143 tests.
Type/source checks, lint, formatting, Worker syntax, Developer API boundaries,
D1 migration contracts, and operational-drift contracts passed.

Baseline browser tests: 45 passed across advanced playback, preload,
YouTube sync, system-audio controls, reconnection, and late join. The final
six-case end-transition matrix passed on the corrected candidate. These
end/repeat cases verify the earlier release's protections; they are not
counted as six newly discovered defects. The final candidate browser run
passed all 64 cases, including demo output recovery and late participation.

The exploratory mixed-media run used one Standard host and one guest, actual
local WebRTC, real MP3 decoding, controlled YouTube, and synthetic system audio.
One directed matrix and four deterministic seeds (`919`, `613`, `227`, `8689`)
passed on both the baseline and final corrected candidate: 190 checked
checkpoints per run (46 directed and 36 per seed). Each seed contains 30 bursts
of 2–5 rapid select/Previous/Next actions
followed by an explicit final target; system capture is interleaved and stopped
through both app and native-ended paths. Native sources and receiver state are
checked after convergence. Logical MP3 fixtures share the same encoded bytes;
this is not broad codec coverage.

Local diagnostic logs are intentionally untracked under
`scratch/transition-audit-{files,network,mixed,mixed-final}` and
`scratch/transition-audit-*.log`. The permanent regression tests live beside
their domains; the browser boundary cases are in
`e2e/youtube-end-transition.test.ts`.

The browser end-transition test explicitly injects guest ENDED (the fake player
does not generate it from elapsed time), verifies takeover precedes the
outgoing precision-broadcast deadline, and preloads the successor file before
the race. It verifies the final seek target as well as host/guest agreement.
Run it with `npm run build:e2e`, then
`node node_modules/@playwright/test/cli.js test e2e/youtube-end-transition.test.ts`.
It belongs to the default browser suite; this review does not expand the
separate CI critical-browser list or duplicate release gates.

An intermediate candidate browser run had two setup failures before the target
media race: host-side local classification and a guest's first file download.
The host selected remote delivery while the static local preview had no R2
service. A separate native Chromium experiment then isolated the cause: hold
the real remote host candidate until the data channel opens, then deliver it.
Selected transport statistics refine prflx to host while the native pair
snapshot retains prflx, with unchanged ports and continuing byte counters.

The correction requires fresh selected host/host proof; it never treats prflx,
an SSID, or an unselected local candidate as local. Exact connection/transport,
endpoint, and available generation evidence must remain stable across the
stats read. Native candidate dictionaries can be freshly allocated per call;
dictionary reference equality is not an ICE generation proof. See
[the route contract](signaling-liveness.md). This reproduction does not prove
the cause of an earlier physical-device incident without its trace, nor does
the local harness test production R2 delivery.

## Physical rehearsal still needed

These deterministic results do not prove iPhone PWA audio behavior, actual
YouTube ads/autoplay/decoder timing, cellular handover, venue Wi-Fi, acoustic
synchronization, long background suspension, or participant capacity. No
production load test or policy/capacity change is part of this audit.

For rehearsal, record device/browser, app version, room type, host/guest role,
last three actions, and whether the sound, title, spinner, and queue row agree.
Prioritize iPhone PWA and Android/desktop guests joining during demo download,
screen lock and return, Wi-Fi/data handover, rapid local/YouTube switches,
repeat-one seek near the end, and leaving during system audio. A timing bug
needs the event sequence and approximate delays more than an error screenshot.
