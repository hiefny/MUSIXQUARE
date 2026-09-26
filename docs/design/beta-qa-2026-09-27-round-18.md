# Beta QA — 2026-09-27, round 18

Baseline: `mxqr_beta` at `29b8af9d`. Scope: file transfer and preloading,
large-file decoder failures, PRO command serialization, and seek gestures across
track, room, and permission changes. Three independent review lanes examined
these boundaries; product changes were made and reviewed by the primary agent.

## Confirmed findings

### 1. A captured seek gesture could seek a newly selected track

The range control retains pointer capture while another device changes the
track. Resetting the seekbar's visual draft did not retire that gesture. If the
replacement became ready before pointer release, subsequent movement and the
final change event sought the replacement track using the old gesture.

A local Chromium host/administrator pair reproduced this through real mouse
input, normal administrator assignment, two MP3 fixtures, and RTC traffic.
Before the fix, the replacement track jumped to **70.5 seconds** when the held
pointer was released at 80%. The same test now leaves the replacement near its
start and confirms that a new gesture can seek it normally.

The seekbar now retires a pending gesture when its source occurrence, YouTube
sub-video, room identity, host connection, mode, or playback authority changes.
A revoke/regrant cycle cannot revive the held gesture. The cancellation survives
pointer release and the existing 350 ms visual-draft fallback so a delayed
native change is also discarded. Its actual change event consumes the gesture;
a new pointer, keyboard, or accessibility adjustment remains usable.

Independent review caught and corrected a regression in the initial patch:
leaving the cancellation flag after a completed gesture would block later
accessibility input/change events that have no pointerdown or keydown. Two tests
failed against that intermediate patch and pass after consuming gesture
ownership on change. Existing delayed-change checks remain intact. The final
seekbar/range suites pass **45 tests**, including the new source, permission,
sub-video, keyboard, and accessibility cases. The generic range guard and control
appearance are unchanged.

### 2. PRO command queues retained obsolete authority and seek targets

Commands wait behind earlier HTTP operations. The existing room/session
generation did not change when playback permission was revoked and restored.
A command queued under the previous grant could therefore be sent after the
regrant. A retry of an older request had the same local-authority problem.
Separately, a queued seek was rebased onto the newest playback revision without
checking that the revision still described the occurrence/sub-video originally
being sought. A remote track selection could turn an old seek into a seek of
the successor.

Regression tests use the real API client's streamed HTTP response handling,
honor AbortSignal, and use HTTP fixtures that assert current authority and base
revisions. A healthy retry control verifies idempotency-key reuse. Both original
failure cases were red before the fix: a second
obsolete command reached the server, and the replacement track moved to the old
42-second seek position. Unchanged-authority controls continued to work.

Queued submissions and bounded retries now retain their local authority
lifetime. Seeks also retain their media lifetime and occurrence/sub-video
identity. A→B→A does not revive the earlier A seek. Already-admitted canonical
responses and realtime PREPARE/COMMIT messages are still reconciled for viewers;
local permission loss is not permission to ignore server playback state.

The command identity tracks accepted COMMIT checkpoints immediately, even while
the follow-up heartbeat is pending. A stale persisted snapshot cannot roll that
identity back. Tests distinguish obsolete A seeks from fresh B seeks during
this gap and preserve valid seeks across newer revisions of the same source.
The expanded regression file has **11 cases**, with healthy retry and normal
queued-command controls; the six authority-ordering tests also pass.

Older tests that sought from an empty idle checkpoint were updated to establish
a real current media checkpoint before seeking. The local permission-loss test
now requires cancellation before sending rather than a redundant server denial.
Assertions for canonical application, revision ordering, timing, and UI-token
settlement remain in place. The command-clock fixture now grants playback control
only for its human-command case; listener-only recovery fixtures stay unchanged.

### 3. A terminal custom-decoder failure could leave its WASM worker alive

Mediabunny serializes custom decoder operations on one promise chain. Rejecting
an init/decode/flush operation poisons that chain, also skipping its queued
close operation. Our adapters threw on actual codec error responses, so a
malformed file could fail playback while retaining its worker and producing an
unhandled rejection.

The regression uses actual Mediabunny demuxing and AAC/FLAC WASM workers. It
preserves the container/sample metadata and damages encoded samples; it does
not replace decoder output with an invented rejection. Corrupt AAC originally
left its worker unterminated and produced an unhandled rejection. Valid files
serve as disposal controls. A second actual corrupt-FLAC case verifies the same
failure boundary.

A shared operation wrapper now closes the adapter immediately and reports the
original failure through CustomAudioDecoder.onError, keeping the serialized
close reachable. It covers AAC, MP3, and FLAC init/decode/flush. Closed adapters
discard later work; successful decoding, channel order, timestamps, and bounded
buffer policy are unchanged. MP3 tolerated the explored damaged payload, so no
claim of a reproduced MP3 content-error leak is made.

All four real-worker disposal cases pass with no unhandled rejection. The
extended large-audio/transport/source selection run passes **202 tests in 13
files**. Browser codec comparisons and hybrid host/guest tests pass **34 checks**,
covering MP3/FLAC/AAC output timing, seeks and tails, AAC profiles/containers,
small→large→small transitions, and native/bounded participant combinations.

## Other investigation

- Standard transfer, current-track priority, preload promotion/reordering,
  connection replacement, file-read ownership, and late bootstrap: 13 existing
  suites, **297 tests passed**.
- HTTP/XHR download recovery, retry/failure ownership, and file READY/PLAY start
  timing: seven existing suites, **168 tests passed**. No new transport product
  defect was confirmed in this lane.
- Initial PRO/native preparation and runtime ordering checks: eight suites,
  **243 tests passed** before the product fix.

## Verification

- Final full unit run: **481 files passed; 9,829 tests passed, 1 skipped**.
  The existing deployment-artifact classifier test skips locally without `jq`;
  this environment limitation is unchanged. No newly added regression is skipped.
- Local Chromium: **36 checks passed** — two real host/administrator drag checks
  plus 34 codec/hybrid checks. The drag pair was rebuilt and rerun after the
  final gesture-lifetime refinement.
- Full repository typecheck and app/tooling lint passed. Final changed TypeScript
  formatting, focused lint after the last refinements, and diff checks passed.
- Seven source guards passed: import graph, dead exports, bus pairing, lifecycle
  writes, source complexity, room authority, and chunk pump. Bus pairing and
  source complexity were also rerun against the final patch.
- Local production build and eight artifact guards passed: production hooks and
  security, legacy TV, service worker, UI kit, initial transfer budget, fonts,
  and app shell. The artifact checks verified 90 app-shell assets and no E2E
  hooks. These local builds were not deployed.
- An independent review checked the report's PRO claims against the actual
  fixture boundaries. Baseline failures and final outputs are retained locally
  in `scratch/qa-beta-round18-2026-09-27/` (ignored by Git).

## Limits

The browser runs use local Chromium, local signaling, and fixture media. PRO
races use controlled server responses through the real client/runtime. Native
worker tests use Node workers and a PCM storage shim; browser tests separately
check real Web Audio output. Delayed iOS and accessibility event ordering is
covered at the input-handler boundary, not claimed as a physical iPhone or
VoiceOver run. No live service, physical network handover, or acoustic sync
measurement was performed, and this is not exhaustive proof of all schedules.

Work stays on `mxqr_beta`. UI design, room policy, app **8.6.61**, and cache
**v630** stay unchanged. No main advancement, production deployment, pull
request, or Operations Drift Audit re-enablement is part of this round.
