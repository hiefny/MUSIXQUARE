# YouTube manual offset across zero-start — 2026-09-27

| Field | Value |
| --- | --- |
| Status | Investigation evidence; confirmed S01 and S02 remain unfixed |
| Reviewed beta | `ae98afc34790789174babfef0dcbefaee0741505` |
| Compared main | `35759e8b07f1ee0b272afbd0af03c770a858889e` |
| Environment | Windows, Node 24.20.0, Vitest 5; Chromium with local PeerJS and a deterministic YouTube facade |
| Scope | Manual YouTube sync on host/guest, subsequent track start/repeat, Standard and PRO |

The owner clarified that manual synchronization followed by a track transition,
not Bluetooth attachment, was the suspected trigger. The previous Bluetooth
output-delay explanation was a hypothesis and is not the diagnosis of this
report. No product source, tracked test, main branch, or production deployment
was changed during this investigation.

## Confirmed S01: a negative offset remains displayed but loses its effect

A negative manual offset works during an existing song. Starting the next song
at zero replaces its actual applied offset with zero while keeping the requested
negative setting. The correction is not automatically restored after the media
timeline passes the beginning. This affects both Standard endpoints and PRO
participants, including the owner and member paths.

The Standard browser reproduction used actual Sync button/editor/Enter/Done
interactions and a host playlist selection, not direct state mutation. One
host and one guest ran the actual application and communicated over local
PeerJS. YouTube's iframe was replaced with a progressing fake player; the
reported milliseconds below measure its timeline, not physical sound.

| Standard guest setting | Before next track: guest minus host | After next start | About 10.5 seconds into next track | After reopening sync and reapplying |
| --- | ---: | ---: | ---: | ---: |
| -250 ms | -264 ms | +6 ms | +6 ms, setting still -250 ms | -269 ms |
| +250 ms, control | +237 ms | +254 ms | Not sampled at 10 seconds; +254 ms at 4.5 seconds | Not required |
| 0, control | -8 ms | +7 ms | Not sampled at 10 seconds; +7 ms at 4.5 seconds | Not required |

The host-only -250 ms UI case likewise changed guest-minus-host from +251 ms
before the transition to +9 ms afterward, still +9 ms at 10.5 seconds. The
host kept requested -250 ms and actual applied 0 ms. Merely reopening the host
panel and submitting the same displayed value did not restore it in this run;
the guest's panel entry itself performs a rendezvous, whereas the host's does
not perform a local rendezvous. Do not promise identical same-value recovery
through the two UIs. A host +250 ms control retained its intended displacement.

The small differences around the intended values include browser scheduling and
mock play-command latency. The evidence is the loss of the requested 250 ms
displacement, not a claim of real speaker precision.

With both endpoints requesting -250 ms, the next start also recorded actual
applied zero on each endpoint through 10.5 seconds. Their raw positions were
equal, illustrating why comparing only host-versus-guest playback can hide a
lost individual correction when both devices have the same setting.

PRO module integration reproduced requested -3,000/-250/-10 ms becoming actual
0 ms at the next zero start. At five seconds the negative setting was still
unapplied; explicitly applying it again restored it. The same simulation's
positive and zero controls behaved as designed. It used actual local manual
transactions, authority preparation, COMMIT handling and arm scheduling, with
an injected server timeline and fake iframe; it was not a live PRO server test.

## Mechanism

1. Standard [`player.ts`](../../src/youtube/player.ts) resolves a zero-start
   target as the canonical position plus the participant's requested offset.
   PRO's [`iframe.ts`](../../src/youtube/iframe.ts) preparation and player COMMIT
   use the same [`local-offset.ts`](../../src/youtube/local-offset.ts) conversion.
2. At canonical zero, a negative target is clamped to media position zero. The
   effective applied offset becomes zero. Keeping a media seek nonnegative is
   necessary; the omission is that no delayed-start representation preserves
   the negative setting.
3. [`zero-start.ts`](../../src/youtube/zero-start.ts) and
   [`authority-arm.ts`](../../src/youtube/authority-arm.ts) schedule release from
   platform/timeline lead. Manual offset changes the media target, not that
   release deadline.
4. Standard zero-start learning removes the actual applied offset before
   comparing canonical positions. Both positions therefore look aligned after
   the negative setting was clamped away. Learning does not restore it.
5. Standard legacy heartbeat correction compares the requested target but seeks
   only for drift greater than three seconds (`DRIFT_SEEK_THRESHOLD_SEC`). A
   missing 250 ms adjustment can persist. PRO likewise records a zero applied
   offset and has no automatic post-start handoff that restores the request in
   the tested path.

The affected timing core is the same on main and beta. The Standard simulations
ran each branch's controller and AST-extracted production integration callbacks;
all 296 paired traces agreed.

Positive settings are different: +250 ms is represented by beginning at media
position 0.25 seconds. The displacement survives the next track, but the first
250 ms of content is skipped. This is existing positional-offset behavior, not
evidence that positive inputs corrupt the start protocol or its learner.

## Confirmed S02: an open guest editor can lose an edit just after repeat-one

This is a separate Standard guest race, reproduced with normal editor input:

1. Open the guest Sync editor and leave it open.
2. Let the host finish the track with repeat-one enabled.
3. After the new zero-start releases its input gate, enter +250 ms and press
   Enter before the next ordinary host heartbeat arrives.
4. The displayed/requested value changes, but the local rendezvous cannot begin
   and is not retried when that heartbeat arrives.

The simulated iframe emitted ENDED at its configured 300-second duration;
the actual application handled repeat and network synchronization. No heartbeat
was intercepted or delayed. Waiting an ordinary 800 ms before that endpoint
event changed the natural heartbeat phase enough to reach the window.

| Observed event | Timestamp (ms) |
| --- | ---: |
| Zero-start became idle and input became available | 1790488384402 |
| Actual editor Enter completed | 1790488384582 |
| First ordinary `youtube-sync` arrived | 1790488386623 |

About 6.5 seconds after the edit, host position was 9.435 seconds and guest
position was 9.439 seconds: only 4 ms apart despite requested +250 ms. In the
control where the heartbeat preceded Enter, the same UI produced approximately
+223 ms. A different-video transition closed the old editor, so that concrete
open-panel path did not reproduce S02; same-video repeat preserved the editor.

`invalidateGuestYouTubeTimeline()` clears the previous legacy host snapshot.
Zero-start has its own timeline messages and suppresses ordinary heartbeats
while active. When the editor becomes usable, a fresh legacy snapshot is not
necessarily present yet. `runManualOffsetApplyRendezvous()` in
[`sync.ts`](../../src/youtube/sync.ts) retries `busy` but clears the pending
application on `no-data`. The request was already stored, and the next
heartbeat does not resume the discarded application. A 250 ms discrepancy also
falls below the existing three-second drift correction threshold.

The `no-data` path does issue a toast; this is not a claim that every failure
has no feedback. The defect is that the saved setting and actual playback
remain different. The relevant handling is shared by main and beta, but this
browser reproduction ran beta only. PRO was not shown to have this specific
legacy-snapshot race.

## Other hypotheses and limits

- Manual values did not poison zero-start learning in tested delayed-PLAYING
  combinations. Host/guest delays 0/80, 80/0 and 40/120 ms were learned separately
  from manual offsets, and repeat starts removed the injected timing residual.
- Standard host input bursts, reset, pending replacement and session identity
  fences passed the focused probes. Normal controls reject adjustment during
  active zero-start; direct state injection during preparation is not evidence
  of a reachable UI race.
- PRO preparation/commit attempts to reset the manual value did not establish
  the suspected stale-target race: the real transaction rolls back while its
  canonical timeline provider is unavailable.
- The normal guest Sync button requires a successful rendezvous before opening
  a new editor. Six lower-level cold/warm-snapshot probes alone were therefore
  insufficient to establish S02; the already-open editor across repeat-one
  supplied the actual UI reachability described above.
- Real YouTube buffering, browser autoplay policy and acoustic/Bluetooth output
  were not reproduced. These simulations establish application state/timeline
  behavior only.

## Verification evidence

New ignored diagnostics live under
`scratch/youtube-manual-start-audit-2026-09-27/`:

| Probe | Result | Interpretation |
| --- | --- | --- |
| `standard/standard.test.ts` | 592 observations passed; root independently reran | 296 main/beta pairs; 256 deliberately bypass UI admission and are not user reproductions |
| `pro/pro-manual-start.test.ts` | 17 observations passed; root independently reran | Negative setting loss, positive controls and preparation/reset fences |
| `input/host-input-matrix.test.ts` | 69 passed | 48 input combinations, 21 identity replacement timings |
| `input/guest-first-input.test.ts` | 6 observations passed; root reran both input files | Cold/warm snapshot seam; UI reachability established separately |
| `browser/manual-start.test.ts` | Six scenarios completed across runs | Zero, host/guest positive and negative, both negative; actual UI with fake iframe and local PeerJS |
| `input/browser/reachability.test.ts` | Three observations across runs | Next-track closes editor; repeat-one with heartbeat before input applies; repeat-one input before heartbeat reproduces S02 |
| Existing `sync-integration`, `player`, `handlers-zero-start` | 244 passed in root run | Existing integration baseline, not coverage of S01 |

Passing an observational assertion that expects the defective result does not
mean the product is fixed. No full suite, physical-device or production
verification was performed. The E2E build completed from the reviewed beta.

Early diagnostic-only failures were excluded after fixing fixture fidelity:
the standard delayed-mute mock cancelled its own acknowledgements, and the
browser fake reported a native playlist index for standalone videos, causing
host rendezvous to fail detachment. The final browser wrapper reports -1 for
standalone videos and uses the actual UI instead of direct input bus calls.
The initial combined browser run completed five cases but overlapped the two
endpoints' manual operations in its both-negative case; the final isolated case
waited for those operations to settle. Browser evidence is retained in
`browser/run.log`, `browser/both-final.log` and the three input browser run logs.
Per-run Playwright result directories are overwritten by later runs, so those
directories are not a complete archive of all cases.

## Repair direction, not implemented

Preserve one participant-local timing contract across start and steady playback:
requested offset, actual applied offset, and release time must agree. At zero,
negative compensation needs scheduled delay rather than an impossible negative
seek. Changes to positive-offset prefix preservation would be a separate
behavior decision. Standard host room time must remain canonical while its
local output is delayed; do not broadcast the delayed iframe position as the
room clock or apply the same correction twice.

Do not lower the global three-second drift threshold as a substitute for fixing
the start transition. Keep input ownership, cancellation, late readiness,
repeat/end boundaries and PRO authority fences in the eventual regression set.

For S02, retain an accepted input while waiting a bounded time for a fresh,
trusted host snapshot, scoped to the same session, queue occurrence and playback
run. A newer input or playback action must supersede it. Do not retry every
`no-data` case indefinitely, or reuse the old run's snapshot just to avoid the
wait. This repair direction has not been implemented or validated as a fix.
