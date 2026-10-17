# Standard YouTube heartbeat correction — 2026-10-17

| Field | Value |
| --- | --- |
| Status | Released App 8.11.14/v716; local and exact-main CI, operational smokes, public assets and post-release automated drift checks passed |
| Tested runtime SHA | Initial `ed6fe2057acab9c29604934c49df5c8a2d99173b`; review follow-up `995c10d7de1a5654ed68f5ee1af62359491cec56`; exact-main candidate `e47d0bb5216c9d66bbbc7e28a0cc1cf52bb72c1b` |
| Base | `600f60467e16e8e73610a35052f52965cd54d4ce`, including the separately deployed 8.11.13 QR fix |
| Product / cache | 8.11.14 / v716 (v715 was the unpublished first revision) |
| Owner scope | Fix both reproduced correction paths, verify reproduction and existing tests, deploy |
| Sources | [sync.ts](../../src/youtube/sync.ts), [regression tests](../../src/youtube/__tests__/sync-heartbeat-delay-repro.test.ts) |
| Prior evidence | [Unmodified-runtime reproduction](youtube-heartbeat-delay-reproduction-2026-10-17.md) |

## Problem and behavior

An ordinary Standard-room YouTube heartbeat describes the host's position at
`hostClock`. The small-drift detector already projected this position to the
current host clock, but coarse correction and Android BUFFERING recovery used
the original position. A delayed heartbeat could rewind an already aligned
guest; Android recovery could seek to an old target with only 200 ms of delay.
The prior report records six failing cases across these two paths.

All three correction decisions now use one projected canonical host position.
Projection adds `max(0, getHostNow() - hostClock)` only for PLAYING, with a
calibrated SharedClock and finite timestamp/elapsed time. Paused, BUFFERING and
CUED host snapshots do not advance. Missing or invalid timestamps and an
uncalibrated clock retain the existing raw-position fallback. A timestamp ahead
of the local estimate adds zero, never negative elapsed time.

The projected position is passed to existing manual-offset and output-delay
helpers, so Android's 250 ms is applied once. Existing duration clamps, output
tail hold, and the 150 ms pause/seek/play interval remain in place. Raw snapshot
storage, advertisement detection, video replacement, PRO, file transfer,
protocol fields, dependencies, bindings, secrets and database schemas are
unchanged. No new automatic retry or timestamp-expiration policy was added.

## Verification

Local environment: Windows, Node 24.13.1, npm 11.8.0, Vitest 5.0.3. Remote CI
uses the repository's pinned release toolchain; local evidence does not replace
its exact-main candidate.

The original 21 reproduction assertions remain. An additional 26 cases cover
host pause/buffering/cued states, positive/negative manual offsets, missing and
non-finite timestamps, future timestamps, uncalibrated clocks, nonzero true host
clock offsets, and projected duration/end-hold boundaries.

- Initial focused regression and related tests: **360 pass / 0 fail / 0 skip** across
  five files, including **47/47** in the new regression file.
- Independent code and test review initially found no actionable issues. GitHub
  Codex subsequently found one valid P2 tail-hold boundary; see below.
- Typecheck, full app/tooling lint and formatting passed. Worker syntax,
  Developer API/D1/operations contracts, import graph, dead exports, event
  pairing, source complexity, Standard-room hot path and storage guards passed.
- Chromium YouTube E2E: **6 pass / 0 fail / 0 skip**, 34.1 seconds, two browser
  contexts with local PeerJS and a fake YouTube provider. Isolated app/peer ports
  4197/9027 were used. This is provider-mocked browser coverage, not real audio.
- The first full local run had **13,027 pass / 1 fail / 0 skip** in 580 files.
  The failure was deterministic: the cache constant was advanced to v715 but
  `index.html` still referenced `bootstrap.js?cache=v714`. The existing claim
  bootstrap ordering test could not find the expected v715 script. The HTML
  reference was updated, the runtime commit amended, and all 36 tests in that
  file passed. This was a release identity omission, not an unexplained timing
  failure. The final full-suite run passed as recorded below.
- An initial checked build stopped at the documentation brand guard because
  local report filenames used lowercase branding. Their Windows path spelling
  in the reproduction report was normalized; no runtime change was involved.
- First repaired full unit suite at `ed6fe205`: **580 files / 13,028 pass / 0 fail /
  0 skip**, 253.55 seconds, `--maxWorkers=4`. The preceding failing run used two
  workers and took 460.99 seconds; its single failed assertion is retained above.
- `npm run build:checked` passed against the committed runtime, including v715
  history, production hooks/security, bundle budget and **97 app-shell assets**.
  A later review follow-up changes the tail guard and advances the cache to v716.

### GitHub review follow-up

PR #387's Codex review found that an already ENDED Android guest fell out of the
tail hold when a delayed final PLAYING heartbeat projected exactly to or past
the duration. This was confirmed before changing the guard: **52 cases / 50
pass / 2 fail / 0 skip**; 125 ms and 500 ms frame ages wrongly caused a
pause/seek-to-end/play sequence. Removing only `rawManualTime < duration` keeps
that completed occurrence held. The host retains authority over the next
occurrence; the client does not advance the queue itself.

Eight additional pins cover before/equal/past EOF, positive/negative manual
offsets within the tail, a negative offset before the tail that must still
recover, the same video in the next queue occurrence, and an explicit host
play/seek command. At `995c10d7`, focused tests passed **368 / 0 / 0** across
five files, including **55/55** in the reproduction file. Independent review
confirmed the minimal guard change and ownership controls.

Final local verification of the reviewed runtime at `995c10d7`:

- Full unit suite: **580 files / 13,036 pass / 0 fail / 0 skip**, 266.26 seconds,
  `--maxWorkers=4`. Results: `scratch/youtube-heartbeat-unit-reviewed.json`.
- Chromium YouTube E2E: **6 pass / 0 fail / 0 skip**, 34.9 seconds. The same
  local PeerJS and fake-provider limits apply; this is not a physical audio test.
- Typecheck, lint and formatting passed again. `npm run build:checked` passed
  with cache **v716** and **97 app-shell assets**, including production-hook,
  security, bundle and Service Worker checks.

### PR and exact-main release candidate

PR [#387](https://github.com/hiefny/MUSIXQUARE/pull/387) was merged into
`e47d0bb5216c9d66bbbc7e28a0cc1cf52bb72c1b`. Final PR head
`e2e5798a824685d0fe8e27077cd1eefe22ff747d` passed all 11 jobs in
[CI 39038187701](https://github.com/hiefny/MUSIXQUARE/actions/runs/39038187701).
The separate exact-main push run
[CI 39038651880](https://github.com/hiefny/MUSIXQUARE/actions/runs/39038651880)
also passed all **11 jobs** at that merged SHA; this is the release candidate,
not the local or PR result.

The exact-main Linux run used Node **24.20.0** and npm **11.19.0**. It passed
**580 unit files / 13,035 tests / 0 fail / 1 skip**, the candidate browser and
Service Worker smoke (**17 pass**), and the critical browser paths (**55 pass**).
The single skip is the existing Windows-only cross-drive rejection test in
`src/pro-room/__tests__/pro-grant-campaign-cli.test.ts`; it passed on local
Windows. Coverage, type/source guards, lint/formatting, release candidate build
and static checks all passed. The complete CI log is saved locally as
`scratch/youtube-heartbeat-main-ci.log`.

Commands and local artifacts:

```powershell
npm test -- --maxWorkers=4 --reporter=json --outputFile=scratch/youtube-heartbeat-unit-reviewed.json
npm run typecheck
npm run lint
npm run format:check
npm run build:e2e
# MXQR_E2E_APP_PORT=4197 and MXQR_E2E_PEER_PORT=9027
npx playwright test e2e/youtube-sync.test.ts --project=chromium --reporter=line
npm run build:checked
```

The full serial Playwright suite was not rerun. The targeted YouTube
browser suite and the successful exact-main candidate browser gates cover the
release scope; real provider/audio verification remains outside these tests.

## Release scope and recovery

Production Release
[39039136092](https://github.com/hiefny/MUSIXQUARE/actions/runs/39039136092)
attempt 1 succeeded at **2026-10-17 23:05:49 KST** (14:05:49 UTC), deploying
only `app` from `e47d0bb5216c9d66bbbc7e28a0cc1cf52bb72c1b`, with
`apply_developer_api_d1=false`. It consumed the exact-main CI candidate
[artifact 12103321355](https://github.com/hiefny/MUSIXQUARE/actions/runs/39038651880/artifacts/12103321355).
The ordinary App idempotent D1 baseline checks ran; this change adds no migration.
No maintenance switch or forced client replacement was introduced. Existing
clients receive the normal update dialog/cache migration.

- App **version ID**: `0d55bd02-5802-47e4-97fe-491914594f08`;
  **deployment ID**: `4ffedfd7-51a4-456c-9c7f-4ff126f13cd5`.
- All five unselected Workers remained compatible at **23:05:16.528 KST**.
  They were not redeployed.
- All four selected operational smokes passed: App generation, anonymous App
  account boundary, existing PRO public boundary, and Standard HTTPS signaling.
  Unselected Worker smokes were outside this release scope.
- Final production ownership was verified at **23:05:44.474 KST**. The exact
  SHA/App coherent marker was then persisted. Evidence:
  [deployment records 12103496878](https://github.com/hiefny/MUSIXQUARE/actions/runs/39039136092/artifacts/12103496878),
  [coherent marker 12103626183](https://github.com/hiefny/MUSIXQUARE/actions/runs/39039136092/artifacts/12103626183).
- The pre-mutation recovery checkpoint was captured at **23:04:36.807 KST**:
  [artifact 12102834762](https://github.com/hiefny/MUSIXQUARE/actions/runs/39039136092/artifacts/12102834762).
  It preserves prior App **8.11.13/v714**, SHA
  `600f60467e16e8e73610a35052f52965cd54d4ce`, version
  `cbc2d87f-ea98-42a5-b64b-a678d2de03c6`, deployment
  `fb477d6d-ef0d-4234-a44b-a553707e080c`. Rollback was not needed or run.
  A future rollback requires the existing compatibility-floor and ownership
  checks and would restore the two known heartbeat-correction bugs.

### Public asset receipt

At **2026-10-17 23:06:01.715 KST**, all six public GETs returned HTTP **200**;
their byte counts and SHA-256 matched the exact-main candidate. Local receipt:
`scratch/youtube-heartbeat-public-receipt.json`.

| Public path | Bytes | SHA-256 |
| --- | ---: | --- |
| `/` | 140,676 | `11b5963eaf858bb1de4f4d83836cdef7ce04a0a12435d74591800f895ef4da06` |
| `/service-worker.js` | 39,149 | `029ad63a385c3d4912c006e921f2220455205a77b996c52e9f63905f90c48f97` |
| `/bootstrap.js?cache=v716` | 10,196 | `23c52fb5e68902dae1411a342209c381dc607f0e35ebec423fa2c098962cdf51` |
| `/assets/main-n-Ssc9mY.js` | 437,531 | `aa1f75a96264d77428577bfee0c0eba0d2be0cdf52b217ed9e2c3bf6908f70c1` |
| `/assets/sync-BLXggMJo.js` | 79,460 | `2461cd0d881505d67c8cc8656f5f28f3a65464181474a72ae81e1c182a6ade2e` |
| `/assets/sync-flight-recorder-BUq6pP_m.js` | 7,413 | `b6ad8540475c1afa17d3fc20c80b79352005ee929fdb0a8a668c48c82489539f` |

The post-release Operations Drift Audit
[39039325203](https://github.com/hiefny/MUSIXQUARE/actions/runs/39039325203)
attempt 1 succeeded at the deployed SHA. Its report, generated at
**23:06:42.160 KST**, is `automated-checks-passed`: **31 pass / 0 fail /
5 manual-only**. The five manual checks remain manual; this result does not
claim they were run. Evidence:
[artifact 12103840196](https://github.com/hiefny/MUSIXQUARE/actions/runs/39039325203/artifacts/12103840196),
local `scratch/youtube-heartbeat-drift/report.json`.

## Limits

The deterministic tests run the real handler and SharedClock with a fake iframe.
They prove seek target behavior for the injected timing and BUFFERING states.
They do not establish whether the reported file preload caused congestion,
main-thread delay or buffering on the actual Android device, nor do they
measure physical audible synchronization. That incident-causation limit remains
open after this repair.
