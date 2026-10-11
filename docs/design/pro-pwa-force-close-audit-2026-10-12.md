# PRO PWA force-close and relaunch — 2026-10-12

Initial read-only investigation at `c5eae104` (product tree `f5c7a514`), Windows,
Node 24.20.0 / Vitest 5.0.3. The owner subsequently approved the copy change and
deployment of the accumulated PRO repairs on 2026-10-12. Release evidence is
recorded below and in the release record.

The owner observed the active-tab dialog after force-killing an installed
iPhone PWA and opening it again. A missing exit notification explains this
under the existing presence policy; it is separate from the repaired Retry
button lifecycle. Physical iPhone termination was not reproduced locally.

## Verified path

- Non-persisted `pagehide` starts an exact-incarnation keepalive presence-close
  before local teardown. Mobile app-manager termination need not dispatch that
  event; see [MDN pagehide usage notes](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event#usage_notes)
  and [WebKit issue 199854](https://bugs.webkit.org/show_bug.cgi?id=199854).
- Hidden/background is deliberately not leave: playback must survive screen
  lock and app switching.
- Checked-in PRO presence TTL is 45 seconds after last liveness; normal client
  heartbeat cadence is 15 seconds. A PRO signaling WebSocket close removes its
  socket from the signaling map, not authoritative PRO presence.
- A new document retains its session cookie but loses the API's in-memory
  presence identity. Ordinary resume rejects an existing presence with
  `PRESENCE_ACTIVE_ELSEWHERE`; setup retries after 750 ms, then offers takeover.
- Confirmed takeover replaces only that session's presence incarnation. It
  preserves the participant identity and room epoch and fences old requests.
  It is not a room-wide reconnect.

## Local evidence

Two scratch probes against the real PRO room Worker pass: without close or
heartbeat, resume is rejected at 0 / 750 / 44,999 ms and succeeds at 45,000 ms;
a heartbeat at 30,000 ms moves that boundary to 75,000 ms. These assert the
existing lease behavior, not a fix. The harness copied existing test helpers;
405 unrelated cases were excluded by name filter, not skipped for missing
dependencies. Source/log: `scratch/pro-pwa-force-close-2026-10-12/`.
The temporary test was removed from `src`. No live room, provider setting,
physical iPhone, remote CI or full suite was exercised in this investigation.

## Approved copy change

Keep explicit takeover, but describe an unresolved previous connection instead
of asserting that another tab is alive. All 42 locales use the meaning of the
approved Korean copy: "이전 연결이 남아 있어요" / "여기서 계속하면 기존 연결이
종료돼요." / "여기서 계속" and the existing Cancel action. The former "강제로 계속"
already performed this session-scoped continuation; no takeover or lease policy
changes are included. Existing translation and responsive-action tests cover
the new labels.

Do not leave on every visibility-hidden event, shorten the global presence
lease merely to hide the warning, or silently take over based only on PWA mode
or a durable route hint. Current tests deliberately prohibit silent takeover
from a durable PWA relaunch hint; a same-context OAuth return is a narrower
exception. Automatic recovery needs a separate exact-session/liveness design;
an unanswered browser-to-browser probe alone cannot prove the old tab is dead.
This release changes wording, not automatic recovery policy. Product version
`8.9.4` / cache `v655` covers the copy and the preceding local runtime repairs.
The release scope is `all` because both App and signaling runtime changed;
Developer API D1 application remains disabled. No schema, secret, binding,
admission limit, authentication or recovery-floor change is needed.

## Release verification

Tested product commit: `a67e192b827d6e1bc21942e17715d62825c7e89e`, Windows,
Node 24.20.0 / npm 12.0.2 / Vitest 5.0.3 / Playwright 1.63.0 / jq 1.8.2.
This includes the earlier clock-budget, current-incarnation admission and
same-page entry-retry repairs. Main already contains the undeployed PRO PIN
two-step dialog (#293), so the production bundle includes it too.

- Complete typecheck, lint, formatting and committed-HEAD `build:checked`: passed.
- App Worker syntax, Developer API boundary, D1 and operations-drift source
  contracts: passed.
- Independent review of the accumulated runtime and regression-test diff:
  no actionable findings. Locale wording was reviewed separately.
- The first full unit execution shared the PC with lint, formatting and build
  processes and used Vitest's default worker count. Account-session setup and
  repository-wide source scanners exceeded their time budgets; that execution
  was stopped and retained as failed/incomplete evidence (`unit.log`). The
  next execution limited workers to four but still overlapped other checks and
  completed with 11,389 passes / 6 timeout failures in 596.40 seconds. After all
  other checks finished, the six implicated files from both runs passed as a
  single-worker group: 465 passes / 0 failures / 0 skips in 67.97 seconds. The
  source scan that exceeded 110 seconds took 19.9 seconds, release-fixture work
  took 7.8 seconds, playlist focus cases 1.6–1.7 seconds, retirement cases
  1.4–2.3 seconds, and the 129-login case 274 ms. No source, assertion or timeout
  change was needed. This supports execution contention, not a production
  behavior failure; neither unsuccessful full local run is counted as green.
- Local Chromium: 33 / 33 passed across critical-browser, release-smoke,
  remote-upload-browser, background-resume, adaptive-actions, pro-entry-retry
  and pro-entry-password. Includes 42-locale 320px / 200%-text actions.
- [PR CI 38150749210](https://github.com/hiefny/MUSIXQUARE/actions/runs/38150749210):
  all 11 jobs passed at `dcf5eb8d`. Full unit/coverage: 536 files, 11,394 passes
  and one intentional Linux skip for the Windows-only cross-drive artifact
  test. That Windows case passed locally; no missing-jq skip remains locally.
- Merge commit: `a440e1848bf63e7e274fff4b7bfd96c6f1d8130e`, PR
  [#295](https://github.com/hiefny/MUSIXQUARE/pull/295). Its product tree matches
  `a67e192b`; subsequent pre-merge changes only record QA/approval documentation.

- [Exact-main CI 38151183534](https://github.com/hiefny/MUSIXQUARE/actions/runs/38151183534):
  all 11 jobs passed on the merge SHA, including the complete two-shard unit
  coverage run and critical browser gate. This is the production candidate;
  local and PR results are not substituted for it.

Logs are under `scratch/pro-reconnect-release-2026-10-12/`.
Physical iPhone PWA termination, real acoustic alignment and a live 30-device
arrival are not covered by local automation. The separately observed PRO
end-of-track stall when the authorized controller sleeps is not repaired by
these changes.

## Production deployment

[Production Release 38151658686](https://github.com/hiefny/MUSIXQUARE/actions/runs/38151658686)
attempt 1 succeeded at 2026-10-12 00:37 KST. It reused exact-main CI
`38151183534`, deployed `a440e184` to all six Workers with Developer API D1
application disabled, and passed all ten live smokes, final deployment ownership,
PRO generation readiness and the coherent production commit marker. Recovery
was not needed; the recovery job was skipped.

Read-only public GET verification after deployment returned HTTP 200 for the
root document and `/service-worker.js`; the document requests
`bootstrap.js?cache=v655` and the service worker contains `v655`. No customer
room was entered for this manual check. The previous deployment was
`d76b1432` (8.9.0 / v651); the PIN two-step UI from #293 and local 8.9.2–8.9.3
repairs were released together as 8.9.4, not as separate deployments.

This completes the deployment hold, pending #293 deployment, clock/admission
and same-page retry release items. Physical PWA behavior and the separate
sleeping-controller observation remain explicitly open in the release record.
Operations Drift Audit remains active; its latest run `38131341194` passed
31 automatic checks with five manual controls before this deployment. The
first audit after 8.9.4 is still pending.
