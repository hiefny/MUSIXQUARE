# Standard YouTube heartbeat correction — 2026-10-17

| Field | Value |
| --- | --- |
| Status | Local repair verified; PR / exact-main CI / production release pending |
| Tested runtime SHA | `ed6fe2057acab9c29604934c49df5c8a2d99173b` |
| Base | `600f60467e16e8e73610a35052f52965cd54d4ce`, including the separately deployed 8.11.13 QR fix |
| Product / cache | 8.11.14 / v715 |
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

- Focused regression and related tests: **360 pass / 0 fail / 0 skip** across
  five files, including **47/47** in the new regression file.
- Independent code and test review: no actionable findings in the scoped fix.
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
- Final full unit suite at `ed6fe205`: **580 files / 13,028 pass / 0 fail /
  0 skip**, 253.55 seconds, `--maxWorkers=4`. The preceding failing run used two
  workers and took 460.99 seconds; its single failed assertion is retained above.
- `npm run build:checked` passed against the committed runtime, including v715
  history, production hooks/security, bundle budget and **97 app-shell assets**.
  Subsequent edits in this PR are repository evidence only.

Commands and local artifacts:

```powershell
npm test -- --maxWorkers=4 --reporter=json --outputFile=scratch/youtube-heartbeat-unit-final.json
npm run typecheck
npm run lint
npm run format:check
npm run build:e2e
# MXQR_E2E_APP_PORT=4197 and MXQR_E2E_PEER_PORT=9027
npx playwright test e2e/youtube-sync.test.ts --project=chromium --reporter=line
npm run build:checked
```

The full serial Playwright suite was not rerun. The existing targeted YouTube
browser suite and the upcoming exact-main candidate browser gates cover the
release scope; real provider/audio verification remains outside these tests.

## Release scope and recovery

Deploy only `app`, with `apply_developer_api_d1=false`, after reviewed PR merge
and a successful CI candidate for that exact current main SHA. The ordinary App
idempotent D1 baseline checks remain part of the established workflow; this
change adds no migration. No maintenance switch or forced client replacement
is required. Existing clients receive the normal update dialog/cache migration.

The workflow must retain the pre-mutation checkpoint, check compatibility with
unselected Workers, run the selected operational smokes, and verify final
deployment ownership. Record exact release evidence here after execution.
Rollback, if necessary and permitted by the existing compatibility floors,
restores the captured prior App and brings back the two known correction bugs.

## Limits

The deterministic tests run the real handler and SharedClock with a fake iframe.
They prove seek target behavior for the injected timing and BUFFERING states.
They do not establish whether the reported file preload caused congestion,
main-thread delay or buffering on the actual Android device, nor do they
measure physical audible synchronization. That incident-causation limit remains
open after this repair.
