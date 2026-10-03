# Beta sequence QA, round 2 — 2026-10-03

| Field | Value |
| --- | --- |
| Status | Dated discovery evidence, followed by the SQ02–SQ04 repair addendum below |
| Tested checkout | `mxqr_beta`, `c46b5b5ec43da223049ffa0e345271de6d4dc544` |
| Product code | `53cbf60fd5f475a9beef2cfaa1d7023c9b456eea` — includes the SQ01 repair |
| Main reference | `35759e8b07f1ee0b272afbd0af03c770a858889e` |
| Environment | Windows, Node 24.20.0, Vitest, Chromium, local PeerJS, controlled external media boundaries |
| Related records | [Living release record](../beta-release-readiness.md), [previous sequence QA and SQ01 repair](beta-sequence-qa-2026-10-03.md) |

## Result and scope

This section preserves the original discovery result. For current repair status,
see the [repair addendum](#repair-addendum--2026-10-03); its later validation does
not change the failing observations recorded here.

**Three new defects were confirmed.** This round explored delayed responses,
recovery and playback-owner changes after the SQ01 repair. It did not repeat
the entire regression suite. Product code and tracked tests remain unchanged;
only discovery records are published to beta. Main and production remain frozen.

| ID | Priority | Confirmed effect | Verified scope |
| --- | --- | --- | --- |
| SQ02 | P2 | Late resume header rolls back partial receive progress, requiring another suffix transfer | Standard direct file recovery |
| SQ03 | P2 | Old file recovery replaces the system-audio receive placeholder, preventing a late incoming stream from passing its reception gate | Standard file → system-audio transition |
| SQ04 | P2 | Pending YouTube automatic start overrides a newer seek, returning playback to the beginning | Standard host seek during next-track preparation, legacy and v2 paths |

SQ01 remains repaired. The causes above are separate from its delayed PREPARE
state reset. These are reproducible code/sequence defects, not measurements of
production incidence. They do not establish the same failures in PRO/R2 paths.
The introducing commits were not bisected in this round.

## SQ02 — a late RESUME rewinds valid partial progress

The actual sender transmits `FILE_RESUME` on the control channel, waits 100 ms,
then sends suffix chunks and END on the separate bulk channel. Per-channel FIFO
does not guarantee the header arrives before those chunks.

The probe starts a real broadcast, lets chunk 0 through, then models an outbound
data channel staying above the buffer limit. The real pump times out, while the
guest's actual watchdog/backoff issues a recovery request for chunk 1. That
request is fed to the real host protocol/recovery handler. Its encoded response
is replayed without changing the ordering within either channel.

For the same queue occurrence, session and metadata:

1. One or two suffix chunks arrive before RESUME. RAM and the logical cursor
   advance to prefix 2 or 3.
2. `handleFileResume` calculates `min(startChunk, ramContiguousCount(...))`.
   Since the requested offset was 1, it rewrites the cursor/count to 1 and
   clears the reorder buffer.
3. RAM still contains the already received prefix. Remaining chunks now wait
   behind positions whose bytes have already arrived; END cannot finalize.
4. After another 2,000 ms recovery backoff, the receiver requests chunk 1 again.
   A header-first replay of that response completes byte-for-byte and decodes once.

Observed file size: **196,615 bytes / four chunks**. Both intermediate arrival
orders fail the no-extra-recovery invariant. Header-first and all-three-suffix-
chunks-before-header controls pass; the latter reaches the finalized-file guard.

**Impact:** extra waiting and redundant suffix transfer. The test does not show
permanent corruption, lost RAM bytes, or an unrecoverable playback failure.
The 100 ms sender lead reduces likelihood but cannot establish cross-channel order.

Decisive sources:

- [Receive](../../src/storage/transfer-receive.ts): `handleFileResume`, especially
  the partial-prefix calculation around line 1608 and subsequent cursor reset.
- [Sender](../../src/storage/transfer-send.ts): `unicastFile` resume header and suffix.
- [Transport](../../src/network/transport/cloudflare-signaling.ts): channel selection.
- [Recovery](../../src/storage/recovery.ts): watchdog/backoff and requested offset.

The same cursor calculation exists in main source. Unlike the previous SQ01
round, this round did not execute an extracted main build, so that comparison
is source evidence only.

## SQ03 — file recovery survives system-audio takeover

This is a different boundary from SQ02; no cross-channel reordering is required.

1. A guest has a partial local file and its real recovery watchdog has scheduled
   the 2-second retry backoff.
2. The host starts system audio. Its real `stopAllMediaAsync` emits PAUSE with
   `reason: transition`, retains the selected queue/file for later restoration,
   and then the normal system-audio START is delivered.
3. The guest stops prior media and clears received file RAM. Neither this path
   nor the preceding PAUSE cancels the already pending recovery backoff.
4. The backoff still sees the same queue/session. With RAM cleared, it requests
   `nextChunk: 0`. The host still has the resident file and answers with FILE_START.
5. The receive handler's same-session recovery exception bypasses its external-
   playback skip. It replaces the system-audio placeholder with the old file's
   metadata and marks transfer state RECEIVING.
6. A later stream now finds no system-audio placeholder. The real
   `awaitTrustedSystemAudioReceptionBoundary` waits for a new START generation
   and returns false after its 30-second timeout.

The root replay includes both the actual host stop/PAUSE and authenticated
guest START handler. A second independent source review checked these preceding
steps and the retained host file. A healthy takeover before recovery is pending
retains the placeholder and immediately admits the stream boundary.

**Impact:** incorrect title/pending state and refusal of a late system-audio
stream. Ownership itself remains `system-audio` in the reproduction; subsequent
file chunks are skipped and file decode is never called. This is **not** evidence
that the old file resumes or that every system-audio transition fails. The
stream must reach the reception boundary after the stale file response.

Decisive sources:

- [Host start](../../src/audio/system-capture.ts): stop around line 672, claim and
  START around lines 782/855; [transport](../../src/player/transport.ts) preserves
  selection/resident file and emits transition PAUSE.
- [Guest PAUSE](../../src/player/playback.ts): `handlePauseMsg` does not retire recovery.
- [Recovery](../../src/storage/recovery.ts): `recovery-backoff` and
  `handleRequestDataRecovery` retain the obsolete file operation across mode change.
- [Receive](../../src/storage/transfer-receive.ts): `isRecoveryResend` around
  lines 1447–1454 bypasses `shouldSkipIncomingFile`; target adoption follows.
- [System-audio guest](../../src/network/system-audio-guest.ts):
  `commitTrustedSystemAudioReception` and `awaitTrustedSystemAudioReceptionBoundary`.

This is a deterministic protocol/module reproduction with the real stream gate;
the late native audio stream itself was not reproduced in a physical device.
Separate healthy multi-browser system-audio cycles passed below.

## SQ04 — a late YouTube start supersedes the latest seek

Selecting the next YouTube occurrence arms pending autoplay/synchronization for
its initial position. The pending owner validates room, queue and generation,
but a newer explicit seek on that same occurrence does not replace that intent.

The module probe completes the new video's physical cue, delays only its CUED
notification, and uses the real enabled seekbar handler to seek to 70 seconds.
Releasing CUED consumes the older pending start:

- **Legacy fallback:** the host remains around 70.1 seconds but emits a newer
  `YOUTUBE_STATE` for time 0. Replaying the actual frames through the guest state
  handler returns the guest to 0.
- **v2-capable peer:** a fresh zero-start sequence returns the host to the
  beginning (about 1.1 seconds at the final module observation).

A separate Chromium host/guest pair uses real queue-row and seek-slider UI,
current v2 capability negotiation, and local PeerJS. The external iframe fixture
delays preparation while preserving **cue → seek** command order. The enabled
slider accepts 70; the subsequent stale automatic start rewinds **both** players
to approximately 0.5 seconds. Root independently repeats the module and browser
scenarios. No runtime state is injected to force the final result.

Controls pass: ordinary next-track start, latest local pause during pending cue,
and seek after the initial start has completed. A weaker exploratory probe that
could reorder external commands was replaced by the FIFO/event-only probes;
it is not counted as evidence.

Decisive sources:

- [YouTube player](../../src/youtube/player.ts): pending auto-sync ownership and
  consumption near lines 85–205, and `seekYouTubeFromApp` near lines 1518–1553.
- [Playlist selection](../../src/player/playlist.ts): next-track initial
  auto-sync options near lines 1257–1271.
- [Iframe events](../../src/youtube/iframe.ts): CUED consumes pending automatic
  start around lines 2918–2920.
- [Seekbar](../../src/ui/seekbar.ts): the new seek is permitted before the initial
  zero-start barrier has begun.

**Impact:** a legitimate seek is undone, or legacy host/guest positions disagree.
Actual YouTube service response timing and physical speaker alignment were not
measured. This is an application-state defect exposed through a controlled
iframe boundary, not proof of a particular YouTube outage or device failure rate.

## Verification ledger

All counts below are unique final probes; independent repetitions are not added.
Failing acceptance assertions are deliberately preserved as discovery evidence,
not marked successful or weakened to make the suite green.

| Probe group | Result | Boundary |
| --- | --- | --- |
| Direct receive/recovery | 6 total: 3 pass / 3 fail / 0 skip | Two failures are SQ02; one is SQ03; root final run includes preceding PAUSE |
| YouTube module sequences | 5 total: 3 pass / 2 fail / 0 skip | Legacy and v2 failures share SQ04 |
| Audio lifecycle/codec sequences | 16 pass / 0 fail / 0 skip | Eight lifecycle cases plus eight real WASM codec/cursor/worker cases |
| Chromium system-audio cycles | 4 pass / 0 fail / 0 skip / 0 flaky | File/YouTube × UI/native-ended stop; two cycles each, host plus two guests including a late joiner |
| Chromium YouTube preparation/seek | 3 total: 2 pass / 1 fail / 0 skip / 0 flaky | SQ04 plus no-seek and settled-seek controls; retries disabled |
| E2E build | Pass | Current checkout, not a production build or release candidate |

Module probes total **27: 22 pass / 5 fail**; browser probes total
**7: 6 pass / 1 fail**. These six assertion failures represent **three causes**.

Audio checks cover same-name queue occurrences, native/bounded-engine switches,
obsolete decoder success/failure, cancelled output/seek work, and memory-lease
retirement. Real fixture decoding covers MP3, FLAC, LC/iTunes M4A, HE ADTS AAC and
HEv2 M4A. Final PCM offsets/sample prefixes match fresh controls; workers and
tracked audio resources return to baseline. Native AudioContext scheduling is
modeled in Node; this is not giant-file physical-device or acoustic validation.
An intentionally unsupported AAC edit-list fixture and an incomplete initial
AudioContext mock were corrected as harness issues, not reported as product bugs.

The receive simulation captures real encoded host frames and reconstructs
equivalent guest state because modules use a singleton store. Its data-channel
timing is controlled, not simultaneous native WebRTC packet-loss E2E. Browser
system-audio tests use real local media/RTC graphs with a synthetic capture source;
no private desktop content or microphone audio was recorded. YouTube is modeled,
external service requests are blocked, and no live provider state was changed.

## Local evidence and reproduction

Ignored evidence root: `scratch/qa2-2026-10-03/`. These files stay on this
workstation; the report records the portable finding and scope. Promote the
minimal probes into tracked regression tests when implementing repairs.

- `receive/resume-late.test.ts`, `receive/vitest.config.ts`,
  `receive/root-verified.json`, `receive/root-verified.log`.
- `youtube/cue-latest-intent.test.ts`, `youtube/vitest.config.ts`,
  `youtube/root-module.json`, `youtube/root-module.log`.
- `youtube/browser/cue-latest-intent.test.ts`, `youtube/root-playwright.config.ts`,
  `youtube/root-browser.json`, `youtube/root-browser.log`, browser attachments.
- `audio/root-results.json`, `audio/root-run.log`, two audio probe files and
  `audio/report.txt`; `audio/receive-review.txt` is an independent SQ02 review.
- `browser/share-cycle.test.ts`, `playwright.config.ts`, `browser.json`,
  `browser.log`, and `build-e2e.log`.

From the repository root, put the existing pinned Node 24.20.0 directory first
on PATH, then run the relevant local probe:

```powershell
node node_modules/vitest/vitest.mjs run --config scratch/qa2-2026-10-03/receive/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config scratch/qa2-2026-10-03/youtube/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config scratch/qa2-2026-10-03/audio/vitest.config.ts
npm run build:e2e
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\scratch\beta-upgrade-2026-09-09\playwright-browsers"
$env:MXQR_E2E_APP_PORT = '4202'
$env:MXQR_E2E_PEER_PORT = '9032'
node node_modules/@playwright/test/cli.js test --config scratch/qa2-2026-10-03/playwright.config.ts
$env:MXQR_E2E_APP_PORT = '4203'
$env:MXQR_E2E_PEER_PORT = '9033'
node node_modules/@playwright/test/cli.js test --config scratch/qa2-2026-10-03/youtube/root-playwright.config.ts
```

## Remaining actions

Repair SQ03/SQ04 before promotion because they can prevent intended playback;
also repair SQ02 to preserve forward progress during file recovery. Keep UI,
permissions, supported media policy and protocol compatibility unchanged. Each
repair needs the positive sequence and neighboring cancellation/identity controls,
followed by affected regression suites. The existing dependency-security,
version/cache, physical-device and exact-main-SHA release gates still apply.
No production deployment, workflow reactivation or main advancement is authorized
by this QA result.

## Repair addendum — 2026-10-03

The owner requested reproduction/revalidation followed by repair. All three
causes reproduced before the corresponding fixes. The repair changes only the
App client and regression tests; UI, media policy, permissions, wire formats,
dependencies, Worker/D1/secret/binding contracts and release identity remain
unchanged. Main and production remain frozen.

Tested product/test commit: `1c26dc4ea10263790fedd345f9c20950d09dfc13` on `mxqr_beta`. Documentation is recorded
after that commit. Windows, pinned Node 24.20.0, Vitest and local Chromium/PeerJS
were used. This is not an exact-main-SHA production release candidate.

### What changed

- **SQ02:** a same-identity RESUME keeps the entire committed RAM prefix and
  its still-uncommitted sparse chunks. The request's older start offset cannot
  roll back progress. Different queue/session/metadata still clears the receive
  state, and missing actual prefix still requests the required bytes.
- **SQ03:** an external playback owner retires pending recovery, correlated
  request authority and any host resend authorization/pump. This retirement is
  generation-bound, so a file → external media → same-file return cannot revive
  an old async send. Late FILE_START is rejected before its same-session recovery
  exception can overwrite external track metadata. A fresh recovery after
  legitimate return to the file remains supported, including paused playback.
- **SQ04:** while a selected YouTube cue is pending, seek changes its retained
  target without discarding readiness or media identity. Explicit PLAY changes
  the intended state without borrowing the previous iframe's position. PAUSE,
  stop, replacement occurrence and owner changes retire obsolete start work.
  The existing manual-offset transaction guard remains in force.

Independent review of the first SQ04 candidate exposed two adjacent hazards:
using a previous native video's position for an implicit PLAY, and ignoring an
explicit PLAY during paused restoration. These were corrected before commit.
The latter was separately reproduced (two failing cases), then passed with
state-only promotion. The tests also preserve paused seek without accidental
autoplay and normal zero-start when no seek occurs.

### Regression evidence

| Check | Result and interpretation |
| --- | --- |
| Whole unit run, then affected revalidation | 501 unique files / 10,425 pass, final fail/skip 0. Initial run: 10,418 pass / 1 obsolete test assertion failure. Final affected storage/player/network/YouTube run: 157 files / 4,030 pass; final YouTube run after the last guard/fixture correction: 37 files / 1,002 pass. Results replace matching files; overlapping counts are not added |
| SQ02 new channel-order tests | 18 pass; lane-FIFO interleavings, delayed/duplicate headers, sparse holes, real missing prefix, wrong connection/queue/session and byte-exact completion. Original four reproduction/control cases also pass |
| SQ03 recovery tests | New eight integration cases plus five host lifetime regressions (41 tests in the extended existing recovery file). Actual protocol/codec/RAM/stop/reception gate and sender pump are exercised; native decode is stubbed. Original failing gate now succeeds |
| SQ04 new module tests | 20 pass; legacy/v2, event/watchdog readiness, physical cue FIFO, repeated/relative seeks, host offset, pending PLAY, paused restore and cancellation controls. Original five probes pass |
| Chromium affected browser suite | 62 pass / 0 fail / 0 skip / 0 flaky, retry 0, across 12 files; includes the four new pending-cue UI cases and existing file/preload/reconnection/system-audio/YouTube/manual-sync controls |
| Static checks | App/test/E2E TypeScript; App lint and changed E2E lint; changed source formatting; source complexity, room-authority, chunk-pump and Playwright API guards pass |
| Builds | E2E and production builds pass; all eight production artifact guards pass. No deployment or release-identity increment |

The old `transfer-priority` test asserted that a delayed RESUME reduced the
counter from three to one. That assertion encoded SQ02. It now uses two stronger
controls: only genuinely new suffix bytes earn preload grace; repeated headers
and duplicate prefix chunks cannot extend the lease. A later stalled transfer
still expires. No runtime watchdog tolerance was relaxed. New test fixture type
omissions and a formatting issue were also corrected before final verification.

Tracked reproductions and controls:

- [RESUME channel ordering](../../src/storage/__tests__/transfer-resume-channel-ordering.test.ts)
- [Recovery owner transitions](../../src/storage/__tests__/recovery-owner-transition.test.ts)
- [Host recovery lifetime](../../src/storage/__tests__/recovery.test.ts)
- [Main/preload progress watchdog](../../src/storage/__tests__/transfer-priority.test.ts)
- [Pending YouTube intent](../../src/youtube/__tests__/pending-cue-seek-intent.test.ts)
- [Chromium pending-cue seek](../../e2e/youtube-pending-seek.test.ts)

Ignored raw evidence is in `scratch/sq02-sq04-repair-2026-10-03/`: `receive/`,
`recovery/`, `youtube/`, `full-unit.json`, `final-affected-unit.json`,
`final-youtube-unit.json`, `e2e.json` and build/static-check logs. The discovery
evidence above remains unchanged. The browser test uses actual host/guest
queue-row and seek-slider UI with a FIFO-controlled fake YouTube iframe. This
does not validate live YouTube timing, physical speaker alignment, actual iPhone
Safari/PWA, or native Bluetooth. The full E2E/coverage/Worker/live-service suites
were not rerun in this repair round.

SQ02–SQ04 are resolved within the tested scope. The pre-existing dependency
security, version/cache, physical-device and final-main-SHA release gates in the
[living release record](../beta-release-readiness.md) still apply. There is no
new migration or special recovery step; use the existing release checkpoint and
rollback procedure when publication is eventually authorized.
