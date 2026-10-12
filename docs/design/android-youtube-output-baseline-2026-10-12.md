# Android YouTube output baseline — 2026-10-12

Status: local implementation and verification; not deployed.

## Decision and scope

The owner reported audio approximately 250 ms behind video on two Android
tablets, five Galaxy devices and a Xiaomi device, and requested a fixed Android
baseline on all YouTube playing paths. This is the application's chosen default,
not independent proof that every Android browser, Bluetooth route or future
YouTube implementation has the same delay.

Both Standard and PRO use a common canonical position `T`. Each endpoint targets
`T + its bounded manual setting + its own fixed output correction`. Host/guest
platform differences are not part of the new compensation policy. In Standard,
the host removes its actually applied local delta before exporting canonical
time. Changing that host's manual setting must not move any other participant.

Only the local branch changes. No production or customer-room operations,
release identity bump, remote push, PR, merge or deployment were performed.
The earlier clock safety and C11 commits on the branch remain separate work.

## Implementation

- `output-latency.ts` reads the single Android 250 ms policy constant. Explicit
  Android user agent or Android client-hint platform is accepted; a Linux touch
  device is not guessed to be Android. iPad desktop mode remains iOS.
- Standard zero-start schedules host and guests using each device's own output
  lead. Only the actually applied host advance is removed from outgoing time.
  Existing startup learning remains separate from the fixed baseline.
  At PLAYING, the media position is sampled against the signed canonical
  position; notification delay is not treated as media delay. Small uncorrected
  timer lateness and real delayed media progress do not rebase the shared clock.
- PRO prepared starts, resume, seek and Sync retain the fixed output lead.
  Available future time supplies an early call; when that interval is too short,
  only the missing fixed output component advances media position. Missing
  positive learned startup time is not converted into a seek.
- Standard immediate/state/heartbeat recovery, changed-video loading, ad recovery
  and zero-start fallback compose the same local correction. Timestamped
  bootstrap positions are projected from `hostClock` to `hostPlayAt`; older
  frames without a timestamp retain their existing interpretation.
- Host/PRO manual edits, reset and rollback retain the automatic component.
  The user input limit remains ±9.999 seconds and does not clip the automatic
  correction. A negative target before media zero waits locally; the Standard
  host continues publishing the canonical playing timeline while it waits.
- Standard host physical ENDED can precede the common endpoint by the applied
  automatic output advance. An occurrence-scoped hold preserves canonical time
  until normal next/repeat processing. Pause, seek, stop, load or identity changes
  retire stale work. Manual end neutralization excludes the automatic component.
  Guest recovery does not restart an automatically advanced, completed tail.
- Paused targets receive no playing output advance. Media-boundary guards avoid
  converting a still-playing target into an exact ENDED seek.
- Standard rendezvous learning removes the known output contribution and keeps
  its Android floor. PRO observation removes the physical-to-canonical conversion
  before evaluating startup residual. Existing C11 callback/clock guards remain.

No new `hostPlatform` field was added to ordinary STATE/SYNC frames. The existing
zero-start field remains for that protocol's original startup calibration.

## Verification

Environment: Windows local checkout, pinned Node 24.20.0, Vitest 5.0.3,
Playwright 1.63.0. The local jq executable was supplied through
`MXQR_TEST_JQ_PATH`, so the Windows jq-dependent regression was exercised.
Tested source: **`80b92c99f4581396ab2d37b89c981ea8324cfe18`**, parent
`fa82737f6d6f3fe9a19ac108b325a776561d36a9`, branch
`agent/pro-start-clock-safety`. Tests ran against its local source tree before
the commit; the subsequent report commit changes documentation only. No
exact-main CI candidate or remote/production validation is claimed.

| Check | Result |
| --- | --- |
| Full `vitest run` | 548 files, **12,043 passed / 0 failed / 0 skipped**, 149.24 s |
| App, test and E2E TypeScript configurations | Passed |
| Prettier on changed TypeScript and E2E | Passed |
| Full app ESLint and the new E2E test's tooling lint | Passed, zero warnings |
| Chromium output-delay, YouTube sync and playback-sync E2E | **13 passed / 0 failed / 0 skipped / 0 flaky**, 2.3 min |
| Production `npm run build` | Passed |
| `npm run build:e2e` | Passed |
| Checked-build guards, run individually against the production build | 22 passed, 2 pending release checks failed as detailed below |

The regression matrix includes Standard/PRO scheduled and direct paths,
host/guest Android combinations, manual extremes, reset and rollback, delayed
release and stale cancellation, end/repeat ownership, and Android identification.
The zero-start matrix has 27 OS/manual combinations. Additional jitter pins
separate timer lateness, PLAYING notification delay and actual delayed media
progress. Fifteen player integration cases exercise the real callback registered
by `initYouTube`, including both manual extremes.

The browser run used `e2e/youtube-output-delay.test.ts`,
`e2e/youtube-sync.test.ts` and `e2e/playback-sync.test.ts`, project `chromium`,
local app port 4338 and PeerJS port 9018. Both servers were cleaned up afterward.
The new cases use separate Chromium contexts for Android/other, other/Android
and Android/Android, including natural zero-start, real Sync UI, seek,
pause/resume and a host-only +400 ms edit followed by two ordinary heartbeats.

- Largest absolute modeled audible difference across stages: **28.5 ms**
  (assertion limit 120 ms, small enough to reject a missing 250 ms baseline).
- Zero-start maximum: **7 ms**; Sync-button maximum: **5.5 ms**.
- Host +400 ms edit: host media advances **372–376 ms** relative to its
  independently captured prior wall-clock trajectory. Guest trajectory change
  is below **0.000001 ms** in the deterministic media model, and the guest
  receives **zero additional playback/seek/load commands**.
- After accounting for only the requested host manual value, modeled relative
  audio error is at most **5.5 ms**. The test does not read the implementation's
  applied-offset register to construct that independent assertion.

These are media-clock model measurements, not actual speaker accuracy claims.

Local full-unit log: `scratch/android-canonical-unit-final-2026-10-12.log`.
Production build/budget logs: `scratch/android-canonical-build-2026-10-12.log`
and `scratch/android-canonical-budget-2026-10-12.log`. Scratch files are local
evidence, not committed report attachments.
Browser line and JSON evidence:
`scratch/android-output-common-t-e2e-2026-10-12.log` and `.json`.

The two failed release checks are explicit:

- `guard:sw-cache-version`: committed runtime changes follow the last v659 bump
  at `95e9092c`. This task intentionally does not select a release version.
- `guard:initial-transfer-budget`: eager JavaScript gzip **471,480 B > 468,160 B**
  maintenance ceiling (+3,320 B), eager total **544,539 B > 543,400 B** (+1,139 B).
  Architectural budgets remain 492,800 B / 572,000 B; the 5% reserve check fails.
  No thresholds were widened. Optimize initial loading and recheck before release.

Intermediate runs are not silently counted as the final result: the discarded
host-relative implementation's unit/E2E pass is superseded; its unused exports
and old changed-video assertion were cleaned up, and an ad-resume acknowledgement
race was repaired. During the canonical rewrite, a temporary test role type and
zero-delay fake-timer fixture were corrected before this full passing run.

## Mixed-version compatibility: unresolved before release

The deployed `95e9092c` and this branch advertise zero-start capability v2 and use
PREPARE/COMMIT v1. These versions do not distinguish the old host-relative audible
interpretation from the new independent canonical interpretation. `hostPlatform`
describes hardware and is not a compatibility negotiation.

With an Android host, a prepared zero-start and no manual/startup/jitter residual:

| Host | Guest | Guest sound relative to host |
| --- | --- | --- |
| Deployed old | Deployed old | No difference from this baseline policy |
| Deployed old | New | 250 ms early |
| New | Deployed old | 250 ms late |
| New | New | No difference from this baseline policy |

This table holds regardless of the guest platform. A non-Android host has no
baseline difference attributable to this change. Old guest startup calibration
compares against its old expected lead; new guest calibration compares against
its new expected lead. Both can report zero residual despite this mixed-version
audible difference. Repeating Sync is therefore not a general compatibility fix.

An old Android host also exports its uncompensated media position in ordinary
SYNC; a new guest can remain 250 ms early relative to that host's sound. The
reverse direction is path-specific: old rendezvous already uses the guest's
own total lead and can align to a new host, while old STATE/heartbeat recovery
lacks the fixed position advance. Do not generalize the zero-start table to
every recovery path.

Before release, require a verified versioned compatibility policy or a verified
same-version re-entry boundary. A notice alone does not force cached open clients
to update. This local task does not silently change protocol versions or treat
same-version tests as proof of mixed-version safety.

## Remaining limits and release preparation

- Browser tests use actual local app contexts and PeerJS transport with a fake,
  advancing YouTube player. Their acoustic model is `media position - fixed
  output delay`; no real sound is recorded. Test the new code on the owner's
  devices, including first note, resume, seek, Sync/reset, tail and repeat.
- Android hidden as Linux in both UA and client hints remains unidentified.
  PRO startup learning is still session-local. No speculative touch heuristic,
  automatic Sync retry, learned-value migration or new persistent setting is added.
- A physically late/unready renderer cannot replay an already missed first
  sample. The fixed correction does not promise exact acoustic timing through
  buffering, device sleep, ads or an unknown output route.
- App/SW release versions and an exact-main CI candidate are still required.
  Initial transfer maintenance headroom is an additional release check; final
  measured results are recorded with the verification evidence.

See [current release state](../release-record.md) and
[compensation policy](../system-sync-compensation.md).
