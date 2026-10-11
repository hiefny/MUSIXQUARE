# PRO file duration registration and backfill — 2026-10-12

## Decision

The owner chose to obtain file lengths during registration and retain them for
autonomous PRO playback. Existing uploaded libraries must survive unchanged;
ordinary listeners must not gain playback or timing authority. Product 8.9.6 /
cache v657 builds on 8.9.5's server-owned natural-completion reducer.

## Implementation

- Browser metadata inspection overlaps the R2 PUT. It has a five-second total
  budget and at most a 250 ms post-PUT tail. Failure or unknown duration never
  fails the upload. The adapter uses bounded Blob slices and the existing pure
  structural reader; no AudioContext, PCM decoding, external URL or new dependency.
- Upload completion accepts optional `durationSeconds` only from a creator who
  also has `playback.control`. An upload-only participant cannot set the ending
  boundary. Missing metadata queues one bounded R2 inspection, including files
  completed through the Developer API. Registration lookups are serialized,
  persisted, and run outside the room mutation lane.
- Private asset evidence carries version, byte length, room generation, source,
  timestamp and duration. It survives the 64-entry queue cache's eviction and a
  new occurrence of the same asset. Decoded controller evidence wins over server
  evidence, which wins over upload headers. Header lengths retain two seconds
  of end grace; decoded lengths do not add grace.
- Existing rooms move matching verified queue evidence onto assets lazily.
  Unmeasured files are learned through active server inspection or successful
  authorized preparation. There is no deployment-time scan of every room,
  reupload, file deletion, playlist reset or quota reset.
- A separate authenticated `POST /media/:assetId/duration` closes the READY
  deadline gap for slow preparation, late joins, local reconciliation and
  cancelled-checkpoint recovery. It requires active presence and
  `playback.control`, and checks the exact asset identity. Browser reporting is
  fire-and-forget, bounded to six seconds and 128 cached/in-flight records;
  transient failure may retry on later preparation after a 30-second backoff.
  Stale, cancelled, failed, replaced-source and ordinary-listener preparations
  do not report.
- Optional evidence and pending probe entries preserve 8 KiB of room-state
  headroom. A nearly-full legacy room remains loadable even when optional
  backfill cannot be retained. Metadata never becomes a public asset field.

## Limits and compatibility

The bounded reader supports the same unambiguous MP3, FLAC, PCM/RF64 WAV,
M4A/MP4 and AAC ADTS metadata as 8.9.5. Ogg and other unsupported/ambiguous
containers remain unknown until an authorized playback preparation supplies
the actual duration. A raw Ogg final-granule shortcut was rejected: nonzero
initial PCM offsets can make the final position differ from stream length
([Opus RFC 7845 §4.5](https://www.rfc-editor.org/rfc/rfc7845.html#section-4.5)).
Inspection budgets also mean some unindexed large files remain unknown.

This does not guarantee controller-free progression through every previously
unmeasured file. If both server inspection and authorized preparation are
unavailable, the server still does not guess an ending boundary. Empty-room
freeze, ordinary-listener permissions, YouTube timing policy and Standard rooms
are unchanged.

Deploy App and PRO together (`all`); no secret, binding, D1 schema or recovery
floor changes. Old clients continue bodyless completion. A new client retries
completion once without metadata only after explicit 400 `INVALID_REQUEST`;
ambiguous failures do not trigger that fallback. The optional late report
cannot fail playback, and old-server 404 `NOT_FOUND` disables it until lifecycle
reset. Rolling PRO back to 8.9.5 leaves its existing queue-cache/metadata/READY
behavior in place; newly persisted private asset fields are not used there.

## Verification

Runtime source: `0a273542b13632990cb26b9cdd61e02256c6a47f`, based on
`a873629715cbe1b9889b5a31d338455c0344765c`.
Environment: Windows, pinned Node 24.20.0 / npm 12.0.2, jq 1.8.2.
Logs: `scratch/pro-file-duration-2026-10-12/` (local, not committed).

Focused checks during implementation (overlapping counts, not additive):

- Worker plus natural-completion integration: 446/446 pass; the subsequent
  explicit capacity-response change passed 17 targeted cases.
- API, transfer, local upload reader and shared structural reader: 189/189 pass.
- Controller/hook/runtime: 173/173 pass before two additional reporting cases;
  final dedicated reporting suite 18/18 pass.
- Actual bundled Blob adapter: Chromium 153.0.8010.12 8/8 and WebKit 26.6 8/8.
  MP3, FLAC, M4A, edited M4A, raw AAC, safe unknown Opus, pre-abort and in-flight
  cancellation passed, with zero page errors and whole-file reads. WebKit's
  M4A probe took up to 378 ms; a very fast PUT may deliberately defer that
  metadata to the server after the 250 ms tail.
- Critical Chromium browser suite: 22/22 pass. This is the release subset,
  not the entire E2E suite or an iPhone physical-device run.
- Full typecheck, lint and formatting passed. Production build and all six
  Worker dry-run bundles passed. Source complexity, authority boundaries,
  Developer API, D1 and Operations Drift source contracts passed.

Independent review caught and fixed an alarm hot loop while an active-file
probe waited behind registration inspection. Tests hold the metadata read and
assert watchdog scheduling. Optional late-report capacity refusal returns 409
instead of falsely acknowledging storage, allowing a later bounded retry.
The initial full unit run had 11,573 pass / 17 fail across 542 files: one
redundant exported type and sixteen failures from two controller suites that
use partial snapshots without the optional report port. Its unused export was
removed without raising the dead-export guard baseline. The controller now
returns before accessing metadata when reporting is not installed; production
snapshot validation was not loosened. Those two suites and the reporting suite
then passed 38/38. The final full run uses the fixed, frozen source above.

A separate pre-existing PIN test intermittently returned 401. Its fixture
deleted all hashes beginning with `F`, including real random owner-session
hashes with that prefix (approximately 1/64). Cleanup now removes only the
synthetic hashes it inserted. Two reviewers confirmed the cause; three isolated
repeat runs passed. No production session-eviction policy changed.

Final local results at the frozen runtime SHA above:

| Check | Result |
| --- | --- |
| Full unit, four workers | 542 files, 11,590 pass / 0 fail / 0 skip, 265.49 s |
| Critical Chromium E2E | 22 pass / 0 fail / 0 skip, 57.7 s |
| Production build | `build:checked` passed, including cache history, legacy output, initial transfer budget, security and app shell |
| Type validation | Full project typecheck passed; final App, test and PRO projects rechecked after final fixes |
| Worker bundles | Six production Worker dry-run bundles passed; no deployment by this check |
| Lint and format | Full checks passed; final changed files checked again |

The 16 real-browser metadata checks are separate from the critical E2E counts.
The first PR CI (`38160297339`) found function coverage below the unchanged
floors in media-transfer (85.71% / 86%) and playback-controller (85% / 87%).
The dedicated duration-report tests had not been listed in the critical
profile. They and the upload-reader tests are now included. Two transfer tests
also verify a real FLAC through the default adapter and metadata rejection
without upload failure. The former waits on the actual probe while PUT is
pending, so slow CI imports do not turn the optional 250 ms tail into a flaky
test requirement. The final local critical profile passes: transfer functions
88.09%, controller functions 90.62%; global statements 81.97%, branches 76.78%,
functions 88.15%, lines 86.08%. Only tests/profile changed after the frozen
runtime SHA and full local run; remote full CI verifies those additions.
Local/branch tests are not a successful exact-main-SHA production candidate.
Physical iPhone/Android playback and actual customer rooms remain manual checks.

## Production verification

- Runtime PR [#300](https://github.com/hiefny/MUSIXQUARE/pull/300) merged to
  `8307f12ba05683a0738d6f0e4cb293afa7968070`.
- Final PR [CI 38160713245](https://github.com/hiefny/MUSIXQUARE/actions/runs/38160713245)
  and exact-main [CI 38161158889](https://github.com/hiefny/MUSIXQUARE/actions/runs/38161158889)
  each passed all eleven jobs, attempt 1. Main uses Node 24.20.0 on Ubuntu:
  542 files, 11,591 pass / 0 fail / 1 skip (the Windows-only cross-drive CLI test).
  Critical runtime 2,038 tests, Worker 2,148 and release-tooling 345 tests pass;
  broad coverage was merged from the two unit shards. Candidate/Service Worker
  Chromium 17 and critical Chromium 22 browser checks passed.
- [Production Release 38161550040](https://github.com/hiefny/MUSIXQUARE/actions/runs/38161550040)
  succeeded at 2026-10-11 17:58:59 UTC (2026-10-12 02:58:59 KST), attempt 1,
  `target=all`, Developer API D1 application `false`. All six Workers used the
  exact-main candidate; ten live smoke steps passed, deployment ownership and
  PRO readiness were restored/verified, and the coherent production marker was
  persisted. No recovery was required.
- Independent public GETs returned HTTP 200 for the landing page and service
  worker, with `bootstrap.js?cache=v657` and the `v657` service-worker cache.
  No customer room was entered or modified for this verification.
- Post-release [Operations Drift Audit 38161918085](https://github.com/hiefny/MUSIXQUARE/actions/runs/38161918085)
  passed on the same deployed SHA: 31 pass / 0 fail / 5 manual. All 64 source
  binding contracts matched actively serving Worker versions. The five existing
  manual controls remain open; automated success does not verify those controls.

| Worker | Deployed version |
| --- | --- |
| App | `d60b4127-d012-49f1-8d5a-d65ef6cb4a64` |
| PRO | `b58ea516-af5f-44f8-b1f0-112a3300436b` |
| Remote Share | `0f3946c5-74af-45a6-85ff-04ed63a05ad0` |
| Signaling | `6c548c48-5cc3-4b44-b6da-a8e1cfc88b64` |
| Developer API facade | `df517d08-5ef4-434a-8d15-8bbd0b7e7e3d` |
| Developer API | `80d3b025-06d3-47e7-b474-b4a82a9125bd` |

This release did not run the entire serial E2E suite or physical-device tests.
Those limits and the unknown-duration behavior remain explicit open checks in
the release record.
