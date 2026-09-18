# Changes since 8.6.39 and local-file selection audit

Reviewed on 2026-09-19. Baseline: `6f16b58eda322ca69314c08df097938b83942d50`
(8.6.39 / v606), confirmed by successful Production Release run `35240826838`.
The reviewed endpoint was `20271a3313c1946fb2e83cc78d3fcdd52d7017bb`
(8.6.43 / v610). This is a change-focused audit, with adjacent transfer and
playback paths inspected to address the reported behavior; it is not a claim
that every possible device/network race has been eliminated.

## Change inventory

All merge times below are Korea Standard Time on 2026-09-18.

| Time  | Commit / PR       | Version       | Changes                                                                                                                                                                                               |
| ----- | ----------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 06:13 | `b97cbc3d` / #220 | 8.6.39 / v606 | Added a guest playlist readiness wait to the advanced playback E2E fixture. This observes playlist propagation after upload; it does not fix ICE routing or transfer runtime.                         |
| 07:36 | `3ade3142` / #221 | 8.6.40 / v607 | Shortened action labels in five translations and adjusted adaptive-action layout test tolerances after Linux failures.                                                                                |
| 08:27 | `3a79aad2` / #222 | 8.6.41 / v608 | Further concise navigation labels and a wider subpixel allowance in the navigation test.                                                                                                              |
| 23:04 | `cf0da0db` / #223 | 8.6.42 / v609 | Retained final YouTube seek synchronization intent during cooldown/buffering; added server-checkpoint-based local PRO offset rendezvous and Reset behavior, ownership guards, tests and design notes. |
| 23:47 | `20271a33` / #224 | 8.6.43 / v610 | Fenced YouTube rendezvous, rough-play timers, repeat-one and ENDED cleanup across timeline changes and near-end targets; corrected the browser fixture's invalid 13-character video ID.               |

The translation files changed in this range are `da`, `fil`, `hu`, `kn`, `nb`,
`nl`, `pl`, `sv`, and `uk`. The UI still uses full navigation accessible names.
No local-file transfer, remote-share or decode runtime changed in this range.
Worker/admin edits in these releases mirror the product version; this range
does not change their backend behavior.

## Confirmed defects and corrections

### Selected local file was announced only after host decoding

For a fresh Standard-room file, `playTrack` selected/stopped on the host, then
awaited `loadAndBroadcastFile`. Only after audio initialization and native
decoding did the debounced sender publish `FILE_PREPARE`. Guests could therefore
continue the outgoing track throughout host preparation. Once admitted, the
guest PREPARE path already updates the title before its own download completes;
the main delay was the host announcement, not a universal download-end title rule.

An accepted selection now publishes existing authenticated, session-scoped
`FILE_PREPARE` before host decoding. Guest playback stops and metadata updates
when that frame arrives. Bytes are still coalesced and sent only after successful
current-owner decoding; a stale/failed decode cannot publish PLAY for a successor.
A parked predecessor broadcast is canceled immediately on a new file selection.
Unclassified peers receive control metadata without prematurely choosing their
byte route. The post-decode announcement remains for late peers and route changes.

This adds no message type or backend contract. An operator still requests the
selection through host authority. Resident replay and prepared-file fast paths
retain their existing identity checks. PRO's server-authoritative preparation
already adopts a selection before participant download/decode.

### Guest admission and preparation must preserve the newest transfer

Unknown-route classification must not postpone stopping the outgoing media or
leave old transfer frames authoritative. PREPARE admission now checks the latest
transfer metadata session as well as the local receive session, and establishes
the accepted selection before an asynchronous classification wait. Repeated
announcements must retain same-session receive/decode work.

Host preparation and stalled incoming bytes are different phases. Early PREPARE
must not exhaust chunk recovery merely because native host decoding is slow.
Preparation uses the existing source-wait recovery path; chunk progress monitoring
belongs to an actual started transfer.
The old fresh-prepare path already indirectly cleared its chunk watchdog during
previous-track cleanup. The explicit phase separation is hardening verified with
a 60-second delayed preparation, not proof that the old path exhausted retries.

A further failing regression exposed a route-ownership defect: an unmarked
PREPARE that timed out waiting for ICE recorded its conservative remote fallback
as a binding R2 delivery decision. Later confirmed-local FILE_START was then
rejected. Only an explicit host delivery marker or authenticated remote descriptor
now binds that lane; a temporary classification fallback can recover to local.
Explicit host R2 offload remains binding even on physically local connections.
This was reproduced independently in a focused test; the earlier browser setup
failure did not retain enough routing evidence to attribute it to this cause.

### PRO personal pause was lost when editing an offset

Introduced by #223: the shared local offset runtime used the server's playing
state even when the participant had personally paused. Numeric edits and Reset
could call `playVideo`. A personal offset is not a rejoin command. An initially
paused participant now stays paused; a newer personal pause invalidates an
already scheduled replay and preserves the requested and last verified offset.
No room-wide playback command is added.

### Layout test could accept visible clipping

The #222 navigation allowance of 4.5 pixels accepted a demonstrated three-pixel
overflow with CSS ellipsis. This establishes weakened test coverage, not a claim
that current production labels are clipped. The test now compares fractional
rendered text Range width with the actual label box, with a 0.5-pixel allowance;
it no longer uses a large tolerance to mask integer measurement rounding.

## Validation boundaries

Focused regressions cover pending host decoding, superseded announcements,
unresolved route notification, guest transfer ownership, slow preparation and
PRO personal pause. Browser tests use real separate host/guest contexts and a
controlled native decode-completion delay. The translation/layout probe covers
all 42 catalog locales at a 320-pixel viewport; action controls also exercise
200% text. Its five isolated tests now run in the critical browser gate on every
Linux PR/main CI run, alongside the existing runtime scenarios.

The end-boundary YouTube fixes were reviewed again across accepted PREPARE,
pause, replacement media, PRO revision ownership and delayed callbacks; no
additional reproducible defect was found in that reviewed scope. Automated
tests do not establish physical iPhone speaker alignment or mobile-radio handoff
quality.
