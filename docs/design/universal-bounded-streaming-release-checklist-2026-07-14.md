# Universal bounded streaming release checklist — 2026-07-14

- **Status:** retained physical-device checklist; not fully executed
- **Applies to:** the universal bounded file-playback candidate
- **Decision parent:** `universal-bounded-streaming-engine.md`
- **Storage parent:** `browser-media-storage-policy.md`
- **Production route:** **ON for the private-beta progressive release approved 2026-07-28**

> The production owner explicitly approved progressive activation after the
> automated codec, cohort, lifecycle, and build gates passed. This exception
> does not convert any unexecuted physical-device row into PASS. The matrix
> below remains the required evidence before a general-availability claim.

## Gate rule

This is the current physical-device release checklist for the universal
bounded streaming engine. Historical checklists remain historical evidence and
do not satisfy this gate.

For general availability, an incomplete, failed, or blocked checklist remains
a release blocker. Private-beta tests may use the production progressive
cohort or an explicitly identified candidate origin. A passing subset, a
supported format on only one browser, or a successful desktop-only run cannot
be represented as completion of this checklist. Activation and rollback remain
separate, auditable releases.

The tracked production latch
`FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED` is already enabled for the
deployed `v2-current` engine. Remote environment flags cannot override a
disabled latch: every production flag combination stays `legacy-current` while
it is off. With the latch on, the exact V2 flag selects `v2-current`, and the
additional exact universal flag selects `v2-universal-v1`. This release enables
the universal workflow flag. Its narrow rollback disables that flag, bumps the
service-worker cache generation, and rebuilds the static application; disabling
the tracked latch remains the wider rollback to `legacy-current`. The exact
`e2e-universal` mode is the only latch-off exception, remains isolated from
production, and still requires both exact flags.

Attach three-artifact build evidence to every candidate: exact
`e2e-universal` selecting the universal profile/cohort, production with the
V2 flag on and universal flag off selecting legacy/V2-current according to the
latch, and production with both flags on selecting legacy/universal according
to the same latch.

Allowed result values are exact:

- **PASS:** every required step and measurement in the run passed, and all
  required evidence is attached.
- **FAIL:** at least one behavior, measurement, ownership, cleanup, or storage
  requirement failed. Retrying does not erase the failed record.
- **BLOCKED:** the run could not reach the claimed bounded engine, including a
  missing browser decoder capability. A blocked mandatory run is not a pass.
- **NOT RUN:** no valid attempt exists.

There are no `N/A` cells in the mandatory matrix. If a claimed format cannot
run on a mandatory device, either add the admitted bounded fallback or keep
the production gate off. Unsupported format variants must fail closed with a
clear capability result and must never enter a whole-file or `MediaElement`
fallback.

## Non-negotiable policy checks

- Media bodies and decoded PCM are **RAM-only**.
- Product playback must not write media bodies, decoded PCM, indexes, or
  partial transfer artifacts to OPFS or IndexedDB.
- OPFS is not a pressure-relief fallback. If a device cannot remain inside the
  bounded RAM budget, that participant fails gracefully without stopping the
  healthy cohort.
- Browser-managed HTTP/app-shell caches are outside the media-body rule, but
  an app-owned cache must not retain media bytes under another name.
- No bounded route may construct a whole-file `ArrayBuffer`, a whole-track
  `AudioBuffer`, or a duration-sized decoded PCM allocation.
- All supported formats use the shared PCM renderer and room clock. A format
  may not select a less precise playback clock.
- Source, decoder generation, PCM ring, timers, range requests, and peer
  handles close exactly once after removal, replacement, leave, failure, or
  room teardown.
- Natural EOF retires each exact physical renderer before stopped room truth is
  rendered. A suspended or interrupted iOS AudioContext must not block this
  retirement.
- A fatal media owner closes only its exact failed connection, after the active
  router mutation stack has unwound. It must not stop the healthy cohort or
  obscure the primary error with router re-entry.
- A stopped queue occurrence may retain one reusable encoded asset for replay;
  decoder, Worker, port, ring, and playback-source ownership must still return
  to the room baseline, and room teardown must return every asset to the page
  baseline.

Record policy-review evidence before device testing:

| Field                                                  | Evidence                           |
| ------------------------------------------------------ | ---------------------------------- |
| Candidate commit                                       | `[full SHA]`                       |
| Candidate build ID and asset digest                    | `[value]`                          |
| Semantic cohort guard and full `semrev` digest         | `[PASS and s1-… value]`            |
| Candidate origin                                       | `[URL]`                            |
| Production gate-off proof                              | `[config/build log or screenshot]` |
| RAM-only code-review result                            | `[PASS/FAIL — review link]`        |
| OPFS/IndexedDB media-write review                      | `[PASS/FAIL — review link]`        |
| Whole-file allocation review                           | `[PASS/FAIL — review link]`        |
| Declared encoded-read, PCM-message, and ring byte caps | `[values and source lines]`        |
| Known-good rollback commit/build/deployment            | `[full identifiers]`               |

The semantic-cohort evidence must include the exact hashed integration-root
list and a clean repository-wide critical reverse-caller audit. A new product
caller may not ship merely because the closed decoder core stayed unchanged.
The currently broad roots intentionally make some unrelated edits revision
bearing; narrow them only after dedicated integration adapters preserve the
same host/guest/session/start/seek/pause/resume coverage.

## Device and role matrix

Use the same Windows machine and the same iPhone for the paired comparison
unless a defect specifically requires a second device. Record exact hardware,
OS, browser, and installed-PWA build data; labels such as "latest" are not
evidence.

| ID  | Host              | Guest             | Required transport                               |
| --- | ----------------- | ----------------- | ------------------------------------------------ |
| T1  | Windows browser   | iOS Safari tab    | Real product signaling and peer-range media path |
| T2  | iOS Safari tab    | Windows browser   | Real product signaling and peer-range media path |
| T3  | Windows browser   | Installed iOS PWA | Real product signaling and peer-range media path |
| T4  | Installed iOS PWA | Windows browser   | Real product signaling and peer-range media path |

Environment record:

| Field                        | T1        | T2        | T3        | T4        |
| ---------------------------- | --------- | --------- | --------- | --------- |
| Windows model / RAM          | `[value]` | `[value]` | `[value]` | `[value]` |
| Windows version / build      | `[value]` | `[value]` | `[value]` | `[value]` |
| Windows browser / version    | `[value]` | `[value]` | `[value]` | `[value]` |
| iPhone model / RAM class     | `[value]` | `[value]` | `[value]` | `[value]` |
| iOS version / build          | `[value]` | `[value]` | `[value]` | `[value]` |
| Safari version               | `[value]` | `[value]` | `[value]` | `[value]` |
| PWA install date / app build | `—`       | `—`       | `[value]` | `[value]` |
| Network topology             | `[value]` | `[value]` | `[value]` | `[value]` |
| Host participant name        | `[value]` | `[value]` | `[value]` | `[value]` |
| Guest participant name       | `[value]` | `[value]` | `[value]` | `[value]` |

Safari and the installed PWA are separate execution environments. A Safari
PASS cannot be copied into the PWA column, even when both report the same
WebKit version.

The mandatory AAC/M4A matrix uses iOS/Safari 26 or newer because Safari 26 is
the first WebKit release with `AudioDecoder`. Version alone is not a PASS: each
ADTS and M4A run must record successful `isConfigSupported()` and exact canary
decode evidence. An older Safari, or a newer implementation that fails the
canary, is outside the admitted AAC decoder cohort and must show a clear
unsupported result without entering a whole-file `AudioBuffer`, `MediaElement`,
or persistent-storage fallback. Other bounded formats retain their own
capability results; lack of AAC capability must not be misreported as a room or
connection failure. Reference:
[WebKit Safari 26 features](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
and [Safari 26 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes).

## Fixture contract

Prepare two independently decodable, non-sparse fixtures for every format:

- **S (short):** 30–120 seconds, using a common supported sample rate and
  channel layout. The complete file must play through at least twice.
- **L (long/high-stress):** a real long-duration recording, not a zero-filled
  or sparse size balloon. For FLAC and linear PCM, prefer at least 60 minutes
  at 96 kHz/24-bit or a more demanding admitted configuration. For MP3 and AAC
  families, prefer at least two hours at the highest admitted ordinary
  bitrate. The fixture must be large enough to demonstrate that whole-file
  decode is not being used.

Each fixture record must include a SHA-256 digest. File extension alone does
not identify a fixture or prove the selected adapter.

| Fixture ID | Required content                        | SHA-256   | Bytes     | Duration  | Rate / bits / channels | Codec/container details          |
| ---------- | --------------------------------------- | --------- | --------- | --------- | ---------------------- | -------------------------------- |
| FLAC-S     | Native FLAC                             | `[value]` | `[value]` | `[value]` | `[value]`              | `[blocks/subset]`                |
| FLAC-L     | Long/high-resolution native FLAC        | `[value]` | `[value]` | `[value]` | `[value]`              | `[blocks/subset]`                |
| WAV-S      | RIFF WAVE linear PCM or IEEE float      | `[value]` | `[value]` | `[value]` | `[value]`              | `[RIFF/RF64/BW64, encoding]`     |
| WAV-L      | Long/high-resolution WAVE               | `[value]` | `[value]` | `[value]` | `[value]`              | `[RIFF/RF64/BW64, encoding]`     |
| AIFF-S     | AIFF integer PCM                        | `[value]` | `[value]` | `[value]` | `[value]`              | `[NONE]`                         |
| AIFF-L     | Long/high-resolution AIFF               | `[value]` | `[value]` | `[value]` | `[value]`              | `[NONE]`                         |
| AIFC-S     | AIFC admitted linear PCM/float          | `[value]` | `[value]` | `[value]` | `[value]`              | `[twos/sowt/fl32/fl64]`          |
| AIFC-L     | Long/high-resolution AIFC               | `[value]` | `[value]` | `[value]` | `[value]`              | `[twos/sowt/fl32/fl64]`          |
| CAF-S      | CAF LPCM                                | `[value]` | `[value]` | `[value]` | `[value]`              | `[lpcm flags]`                   |
| CAF-L      | Long/high-resolution CAF LPCM           | `[value]` | `[value]` | `[value]` | `[value]`              | `[lpcm flags]`                   |
| MP3-S      | MPEG Layer III                          | `[value]` | `[value]` | `[value]` | `[value]`              | `[CBR/VBR, Xing/Info/VBRI, ID3]` |
| MP3-L      | Long-duration MPEG Layer III            | `[value]` | `[value]` | `[value]` | `[value]`              | `[CBR/VBR, Xing/Info/VBRI, ID3]` |
| ADTS-S     | Raw ADTS MPEG-4 AAC-LC                  | `[value]` | `[value]` | `[value]` | `[value]`              | `[CRC/blocks/leading ID3]`       |
| ADTS-L     | Long-duration raw ADTS AAC-LC           | `[value]` | `[value]` | `[value]` | `[value]`              | `[CRC/blocks/leading ID3]`       |
| M4A-S      | Non-fragmented M4A AAC-LC               | `[value]` | `[value]` | `[value]` | `[value]`              | `[ASC/edit/gapless/tables]`      |
| M4A-L      | Long-duration non-fragmented M4A AAC-LC | `[value]` | `[value]` | `[value]` | `[value]`              | `[ASC/edit/gapless/tables]`      |

At least one MP3 fixture and one ADTS fixture must contain a valid leading
ID3v2 tag. Record the exact physical audio start offset. For ADTS and M4A,
record the selected AAC backend profile and canary result on every device.

## Mandatory action sequence for every matrix cell

Every fixture/topology cell below is one independent run. Start from a fresh
room and collect one evidence record. Do not infer a long-file result from the
short fixture.

1. Clear prior room state without clearing evidence. Confirm zero live media
   owners, sources, decoder generations, rings, pending reads, and retry timers.
2. Start the host room, join the named guest, and confirm the guest's gray
   system message says the participant **entered** the room. Record join time.
3. Add the fixture and one different-format next track. Confirm both peers bind
   the same `queueItemId`, source identity, media revision, duration, and format
   adapter.
4. Wait for exact source/decoder/ring readiness on both peers. Record ready
   timestamps and buffered-ahead values. A visually full progress bar is not
   readiness evidence.
5. Start through the room rendezvous. Record arm, finalize, first output frame,
   audible-start error, and clock sample count for host and guest.
6. Play the S fixture through to EOF twice. For an L fixture, play continuously
   for at least ten minutes and seek to 25%, 50%, and 90% before reaching the
   final 30 seconds.
7. Pause for ten seconds, then resume. Position must remain frozen while paused
   and both peers must resume the same revision without a second download or
   stale generation.
8. Seek backward, seek forward, and seek near EOF. Each seek must create only
   the expected fresh decoder generation and must not replay stale PCM.
9. Reach EOF and replay from the beginning. Confirm the dedicated natural-end
   successor arrives before stopped timeline publication, both physical
   renderers retire, and replay does not report missing media or switch to
   another playback backend.
10. Switch to the queued next track while the first track is active. Confirm a
    single atomic cutover, no cross-track audio, and no duration-sized memory
    spike.
11. Remove a non-current queued item, then remove the current item during an
    active read/decode. Also cancel one already-armed rendezvous. Confirm exact
    attempt cancellation, physical candidate retirement before re-staging,
    exactly one fresh `SOURCE_READY`, and no repeated file offer, run binding,
    download, or whole-file decode. Delay the first ARM receipt beyond its
    finalize deadline, require a projected-position replacement ARM, then
    accept the original canonical timeline base without disagreement. Keep the
    recovered track playing longer than one renderer-health lease and confirm
    multiple attempt-scoped renewals, no third rendezvous, correct next-track
    selection, preserved current playback where applicable, and no resurrection
    from late range or decoder callbacks. While a recovery ARM or FINALIZE is
    pending, exercise the reachable pause, stop, and natural-end transitions;
    separately verify the defensive paused-seek receiver contract. Confirm the
    transition-scoped CANCEL registers its cleanup barrier before ACK, retires
    the exact physical candidate before the successor runs, publishes no
    replacement `SOURCE_READY`, and never commits the cancelled recovery
    afterward. Queue a recovery rejection immediately before host CANCEL and
    verify the host sends CANCEL before retiring its exact attempt or staging a
    replacement ARM. Inject null-return and throw send failures; each must make
    one CANCEL attempt, retire the captured lease, and then fail-close only
    that connection without deleting a successor record. Verify that the
    successor is applied only when the captured old
    current port still survives exactly and recovery is not required. Inject
    cleanup rejection, target-crossed rollback, current-port loss, and an
    explicit recovery-required result; each must fail-close only that guest,
    retain the exact ports for close fallback, and leave the host and healthy
    peers running. Deterministically admit one exact ARM immediately before
    the guest clock's three-second freshness boundary, finish physical ARM
    after that boundary, and require its bounded `ARMED` -> matching
    `FINALIZE`/`CANCEL` -> `FINALIZED` corridor without disconnecting. Prove a
    new ARM, source-ready claim, renderer-health claim, wrong rendezvous,
    retired attempt, expired corridor, and explicit wake cannot reuse that
    continuation and do not allocate an outbound control sequence.
    Also drop ordinary guest clock freshness immediately after an accepted
    `FINALIZE`: the exact Worklet `started` record must still succeed before the
    renderer's captured target-frame-plus-2.5-second local deadline. Withhold
    `started` and prove a single bounded timeout with no rescheduling; cancel
    that attempt and prove its old deadline cannot reject a revision-2
    successor. Automatic freshness renewal may preserve only the original
    exact corridor; explicit wake must still invalidate it immediately.
12. Leave the room, close/reopen the playback surface, and verify all counters
    return to baseline. Inspect app-owned storage and confirm the candidate
    fixture/user-media byte delta is zero in OPFS, IndexedDB, app-owned Cache
    Storage, and every other persistent store. The prepackaged
    `dummy_audio.mp3` app-shell primer is recorded in the baseline and is not
    candidate media evidence.

For each topology and format, collect at least ten valid start samples across
the S and L runs. A sample discarded as a measurement error remains in the log
with its reason.

## Format × topology execution ledger

Each cell contains `[PASS/FAIL/BLOCKED/NOT RUN — run ID — evidence link]`.

| Fixture | T1 Win→Safari | T2 Safari→Win | T3 Win→PWA | T4 PWA→Win |
| ------- | ------------- | ------------- | ---------- | ---------- |
| FLAC-S  | `[result]`    | `[result]`    | `[result]` | `[result]` |
| FLAC-L  | `[result]`    | `[result]`    | `[result]` | `[result]` |
| WAV-S   | `[result]`    | `[result]`    | `[result]` | `[result]` |
| WAV-L   | `[result]`    | `[result]`    | `[result]` | `[result]` |
| AIFF-S  | `[result]`    | `[result]`    | `[result]` | `[result]` |
| AIFF-L  | `[result]`    | `[result]`    | `[result]` | `[result]` |
| AIFC-S  | `[result]`    | `[result]`    | `[result]` | `[result]` |
| AIFC-L  | `[result]`    | `[result]`    | `[result]` | `[result]` |
| CAF-S   | `[result]`    | `[result]`    | `[result]` | `[result]` |
| CAF-L   | `[result]`    | `[result]`    | `[result]` | `[result]` |
| MP3-S   | `[result]`    | `[result]`    | `[result]` | `[result]` |
| MP3-L   | `[result]`    | `[result]`    | `[result]` | `[result]` |
| ADTS-S  | `[result]`    | `[result]`    | `[result]` | `[result]` |
| ADTS-L  | `[result]`    | `[result]`    | `[result]` | `[result]` |
| M4A-S   | `[result]`    | `[result]`    | `[result]` | `[result]` |
| M4A-L   | `[result]`    | `[result]`    | `[result]` | `[result]` |

## Background, interruption, and recovery matrix

Run this section with one L linear-PCM/FLAC fixture and one L compressed
fixture in all four topologies. Repeat any codec-specific failure with that
codec's L fixture.

| ID  | Action                                                                         | Required result                                                                                                                                                                | Evidence                 |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| R1  | Put the iOS browser/PWA in the background for 30 seconds while it is the guest | Healthy peers continue. The iOS participant either remains synced or enters bounded recovery; the room does not globally pause.                                                | `[result/run/artifacts]` |
| R2  | Lock the iPhone screen for 90 seconds while it is the guest                    | Interruption is detected without a crash. Unlock triggers recalibration, prime, and a fresh unicast rendezvous for the current revision.                                       | `[result/run/artifacts]` |
| R3  | Background and lock the iPhone while it is the host                            | State remains authoritative or fails explicitly according to the host policy; no guest plays a stale revision or wrong track. Recovery does not create a duplicate room owner. | `[result/run/artifacts]` |
| R4  | Cause an iOS audio interruption/route change, then release it                  | Interruption and recovery are observable. No stale AudioContext, worklet, or decoder remains after recovery.                                                                   | `[result/run/artifacts]` |
| R5  | Disable the active network on the guest for 15 seconds, then restore it        | Other peers keep playing. The guest reuses the participant/resume identity inside the grace window and catches up through one recovery rendezvous.                             | `[result/run/artifacts]` |
| R6  | Switch the iPhone between Wi-Fi and cellular during playback                   | Reads abort or resume cleanly; request IDs and source handles do not cross connections. Recovery is bounded and the selected track remains correct.                            | `[result/run/artifacts]` |
| R7  | Hard-close the guest after grace begins, then rejoin after grace expires       | Old sources and timers close. The new join receives current queue/revision once, with no stale audio or duplicate transfer.                                                    | `[result/run/artifacts]` |
| R8  | Rejoin three times, then close the room during an active read                  | Every cycle returns live-owner/source/decoder/ring/read/timer counters to baseline. No callback revives the retired room.                                                      | `[result/run/artifacts]` |

For sustained degradation, verify exactly one gray `CHAT_SYSTEM` row per
incident, not a pinned `CHAT_NOTICE`. In Korean with the participant named
`Peer 1`, the expected text is:

```text
Peer 1 님의 연결이 불안정해요. 복구를 시도중이에요.
```

Record the exact displayed text for every tested locale. The system message
must not displace a human room notice. A single participant's interruption
must not stop the healthy cohort.

## Measurement and acceptance limits

Measure from engine/room-clock diagnostics, not from progress-bar animation.
Attach raw samples in addition to summaries.

| Signal                      | Required sample                                                        | PASS limit                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Audible start error         | At least 10 starts per topology × format                               | Absolute p95 ≤ 50 ms; no sample > 150 ms on the stable test network                                                                              |
| Steady-state timeline drift | At least 60 one-second samples after each start/seek recovery window   | Absolute p95 ≤ 50 ms; no sustained excursion above 150 ms for more than 2 seconds                                                                |
| Underrun                    | Counter before/after every stable segment and recovery                 | Delta is 0 after readiness on the stable network; recovery-only increments stop when the participant returns to `SYNCED`                         |
| Buffered audio              | Minimum, median, maximum, and configured byte/time cap                 | Never negative or above the declared cap; no unbounded growth; no zero-buffer stall after readiness except EOF or an injected interruption       |
| Encoded reads               | Maximum physical read, concurrent reads, and bytes retained            | Every read and concurrency value remains within the declared source limits; no whole-file read                                                   |
| Memory                      | Baseline, post-prime, 10 min, 30 min, 60 min, post-cleanup             | Declared media-byte/object counters stay within fixed caps and do not increase with duration; all live counters return to baseline after cleanup |
| Crash/termination           | OS/browser observation for every run                                   | Zero tab reloads, jetsam/OS terminations, PWA exits, browser crashes, and unrecoverable audio-context failures                                   |
| Cleanup                     | Owners, sources, workers, ports, rings, pending reads, retries, timers | Exact baseline after each run and each of three rejoin cycles                                                                                    |

For the 60-minute memory checkpoint, run every L fixture at least once with
iOS as the playback device in Safari and once in the installed PWA. Across the
complete soak set, iOS must appear as both host and guest. If the candidate
does not expose the required byte/object counters, memory validation is
**BLOCKED**, not estimated as a pass from the absence of a visible crash.

Browser heap numbers may be noisy or unavailable on iOS. They are supporting
evidence, not a substitute for engine-owned counters. A strictly increasing
retained media-byte or live-object series at 10, 30, and 60 minutes is a FAIL.
Memory pressure must never trigger an OPFS, IndexedDB, whole-file decode, or
`MediaElement` fallback.

## Exact run evidence form

Copy this block for every matrix and recovery run. Do not overwrite a failed
attempt; create a new run ID for the rerun and link both records.

```text
Run ID:
Date/time/timezone:
Tester:
Candidate full commit SHA:
Build ID / asset digest / candidate origin:
Production gate-off evidence:
Topology ID:
Host device / OS / browser-or-PWA / app build:
Guest device / OS / browser-or-PWA / app build:
Network path and impairment tool/settings:
Fixture ID / SHA-256 / bytes / duration:
Detected container / codec / bounded adapter / decoder backend profile:
queueItemId / source identity / media revision:

Join requested / established timestamps:
Host source-ready / decoder-ready / ring-ready timestamps:
Guest source-ready / decoder-ready / ring-ready timestamps:
Arm / finalize / first-output timestamps:
Start-error samples (raw) / p50 / p95 / max:
Drift samples link / count / p50 / p95 / max:
Underrun before / after / recovery-only delta:
Buffered-ahead min / median / max / configured cap:
Physical read max / max concurrent reads / max retained encoded bytes:
Memory baseline / prime / 10m / 30m / 60m / cleanup:
Live owners/sources/workers/ports/rings/reads/retries/timers before and after:
OPFS / IndexedDB / app-owned Cache Storage candidate-media delta (excluding the baseline app-shell primer):
Background/interruption start / detected / message / recovered timestamps:
Exact system-message text and row type:
Queue switch/remove result:
Leave/rejoin/cleanup result:
Crash, reload, memory-warning, or audio-context event:

Console/debug export:
Clock/engine diagnostics:
Screen/audio recording:
Network trace:
Storage screenshots:
Related defect links:

Result: PASS | FAIL | BLOCKED
Failed requirement or blocker (required unless PASS):
Reviewer / review date:
```

## Final release decision

The production enable commit may be proposed only when all of the following
are true:

- every fixture/topology cell is PASS;
- every R1–R8 row is PASS in Safari and the installed PWA where applicable;
- all measurement thresholds pass with raw evidence;
- all RAM-only, OPFS/IndexedDB, whole-file-allocation, and cleanup checks pass;
- automated unit, type, lint, format, production-build, security, lifecycle,
  and full E2E gates pass at the same candidate commit;
- required codec dependency licenses, corresponding source, relink material,
  artifact manifests, and digests are attached to the release; and
- the known-good static-app and infrastructure rollback identifiers have been
  rehearsed and remain deployable.

Final decision record:

| Field                         | Value                                         |
| ----------------------------- | --------------------------------------------- |
| Mandatory matrix              | `[PASS/FAIL/BLOCKED — evidence index]`        |
| Recovery matrix               | `[PASS/FAIL/BLOCKED — evidence index]`        |
| Memory/storage policy         | `[PASS/FAIL/BLOCKED — evidence index]`        |
| Automated gates               | `[PASS/FAIL/BLOCKED — CI/local log]`          |
| Open release-blocking defects | `[none or links]`                             |
| Rollback rehearsal            | `[PASS/FAIL — timestamp/log]`                 |
| Release decision              | `[KEEP OFF / APPROVE SEPARATE ENABLE COMMIT]` |
| Owner / reviewer / timestamp  | `[values]`                                    |

## Rollback gate after enablement

Even after this checklist passes, enablement is one separate, reversible
change. Before its deployment, record the exact previous static-app deployment
and every infrastructure deployment changed by the candidate. Do not delete
the rollback assets or compatibility endpoints during the acceptance window.

Immediately restore the recorded known-good deployment if the production
smoke shows any of these conditions:

- a host or guest cannot join or become ready;
- a supported file selects an unbounded, whole-file, persistent-storage, or
  `MediaElement` fallback;
- wrong-track audio, stale PCM, duplicate start, or cohort-wide pause occurs;
- iOS Safari or PWA crashes, reloads, loses its audio engine permanently, or
  exhibits duration-proportional retained memory;
- stable-network start/drift or underrun limits fail on two consecutive runs;
- removal, leave, rejoin, or room close leaves a live owner, source, worker,
  port, ring, read, retry, or timer; or
- the recovery system message is promoted to a pinned notice or repeated
  without a new incident.

Rollback evidence must contain the incident run ID, failed requirement,
enablement deployment ID, restored deployment ID, start/end timestamps,
post-rollback T1 and T3 short-FLAC smoke results, and confirmation that the
production route is off again. Cleanup of candidate-only infrastructure is a
separate follow-up and must not delay restoring the known-good static app.
