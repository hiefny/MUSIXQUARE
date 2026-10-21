# Full E2E dialog and touch-input repair — 2026-10-21

## Scope and current status

The scheduled [Full E2E run 39334520177](https://github.com/hiefny/MUSIXQUARE/actions/runs/39334520177)
at `3d409c9a85f1635ced6aa9090dba961459c89561`, started on 2026-10-20
07:22 KST, contained two separate failures:

- The local-app Chromium suite finished with 680 pass / 1 fail. The failing
  nested-scroll test did not activate the Play tab after its injected swipe.
- The production large-room R2 smoke failed while waiting for the common
  dialog overlay to disappear. This was a separate job, not the Chromium
  suite's one failed test. The WebKit job succeeded.

This round investigated both failures and changed test input and dialog
handling. Final test code is
`f2c0740c1ea60a1e03f7182942010d1989f44c6b`, based on main
`a1548d90` with product runtime `1e15f7c2a8e30baeaee4c103a703280a28258e08`
(App 8.11.38 / cache v763). There is no product, dependency, protocol, schema,
binding, secret, version, or production-deployment change in this round.

Focused local and remote checks below have passed. **The final full local and
remote suites were not run.** The final scope is local commits only, without
a pull request, main merge or production deployment. Full-suite verification
was deferred before it started. Branch repeats are not an exact-main release
candidate and do not erase the scheduled failure history.

The earlier October 13 YouTube focus failure is a different, already repaired
incident. Its product cause, fix and full-suite evidence remain in
[the focus repair report](youtube-popup-focus-repair-2026-10-13.md). It is not
reopened or treated as the cause of the October 20 failures.

## Production R2 smoke: a queued notice reused the overlay

The failed job's
[artifact 12225074962](https://github.com/hiefny/MUSIXQUARE/actions/runs/39334520177/artifacts/12225074962)
shows the first-media keep-open notice, rather than the R2 consent dialog,
in the still-visible common overlay. The test had clicked the valid R2
consent, then waited for `#dialog-overlay` to lose its `show` class. The
queued notice reused that container, so the condition timed out after ten
seconds.

The keep-open notice was introduced in `45850f44` / PR #354 on October 16.
It intentionally appears when a first-time visitor's room first holds media.
The production smoke had not adapted to that additional dialog. The failed
run recorded two successful R2 uploads and eighteen completed HTTP 200
downloads, two files for each of nine guests. Its assertion failure therefore
does not establish an R2 delivery outage. It stopped before the successor
promotion assertions, so those earlier downloads alone also do not prove the
whole scenario passed.

The repair identifies each expected dialog before acting:

1. Verify the large-room consent title, Cloudflare R2 reference, eight-guest
   direct-transfer boundary and Continue button; then accept the consent.
2. Wait for the specific first-media keep-open title, explanation and Got it
   button; then acknowledge that notice.
3. Require the overlay to close before continuing with the unchanged transfer
   and promotion assertions.

The initial tour dismissal also checks the expected title and Later button.
An arbitrary error or permission dialog is not clicked through. Three
synthetic browser regressions verify the shared-overlay handoff, refusal of an
unexpected consent dialog and refusal of an unexpected follow-up dialog.

The repaired production smoke passed on Windows against the deployed app:
nine host/host ICE connections, two uploads and eighteen complete downloads,
all nine guests advancing the successor timeline, and no additional GET on
promotion. Guest notices were not automatically dismissed. Test contexts were
closed at completion. This is one live smoke, not a load or radio-network
reliability study.

## Touch test: a moving release consumed the next tap

The affected test uses CDP touch events to check that playlist and chat
scrollers retain scrolling while the document and other controls retain their
own touch policy. Its original gesture moved the contact and immediately
released it. The subsequent tab tap could stop the remaining inertial scroll
without producing a click.

The instrumented Linux baseline at `64c969fe` reproduced the failure in
19 of 20 repeats. Pointer/touch events reached the navigation target, no
application `preventDefault()` was recorded for that tap, no click followed,
and a `scrollend` arrived immediately afterward. This separates the missing
activation from an application click handler receiving and rejecting a click.

A separate plain-page experiment without MUSIXQUARE reproduced one missing
click in ten moving-release trials. Ten rested-release trials had no missing
click. Together with the application traces, this supports the injected fling
and next-tap interaction as the test failure's cause. It does not establish a
general Chromium defect or diagnose physical iOS behavior.

The test now holds the contact at its final position for 250 ms and sends a
stationary `touchMove` before `touchEnd`. This defines a drag released at rest,
rather than adding an application-recovery delay after a failed tap. The
following tab action still uses touch input; no forced DOM click, extra tap,
assertion removal or retry was added.

In all twenty repaired Linux repeats, the Play-tab action from the playlist
recorded one click. The remote JSON report records twenty expected outcomes,
zero unexpected outcomes, zero skipped tests and zero flaky tests.

### A second input issue: the drawer's old coordinates

During the touch investigation, focused Windows repetition exposed a separate
chat-drawer failure: 3 fail / 2 pass. The helper captured the drawer's box
while it was opening from below the viewport. It kept checking the same old
contact point, `(195, 1119.25)`, even after the actual contact point had moved
to `(195, 697.25)`. Waiting longer could not make those old coordinates land
on the settled scroller.

The helper now recomputes the rectangle, contact point and hit target in each
poll, and requires two consecutive equal rectangles plus a hit inside the
scroller before injecting the gesture. Initial and final geometry are
attached even when readiness fails. This also preserves the existing guard
against native View Transition snapshots intercepting a gesture. All original
scroll-distance, document-scroll, range and drag-surface assertions remain.

## Verification evidence

Node 24.20.0 and repository-locked Playwright Chromium were used. Local runs
were on Windows; remote repeats used GitHub-hosted Linux. Repeats used one
worker and zero retries. Counts below describe separate runs and are not
added together as a full-suite total.

| Check                                | Code and environment                                                                           | Result                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Original scheduled Chromium suite    | `3d409c9a`, [39334520177](https://github.com/hiefny/MUSIXQUARE/actions/runs/39334520177)       | 680 pass / 1 fail; touch/tab case                                                           |
| Original scheduled production R2 job | Same run; live production app                                                                  | 1 fail; queued keep-open notice, later promotion checks not reached                         |
| Instrumented touch baseline          | `64c969fe`, Linux [39588609341](https://github.com/hiefny/MUSIXQUARE/actions/runs/39588609341) | 1 pass / 19 fail, 5.7 min                                                                   |
| Plain-page release comparison        | Windows Chromium, no application code                                                          | Moving release: 9 click / 1 missing click; rested release: 10 click / 0 missing click       |
| Chat-drawer geometry diagnosis       | Windows, intermediate diagnostic test                                                          | 2 pass / 3 fail, 1.2 min; stale offscreen contact coordinates                               |
| Geometry repair repeats              | Windows, intermediate test code                                                                | 8 pass / 0 fail, 42.7 s                                                                     |
| Repaired touch repeats               | `1f6236b6`, Linux [39589667754](https://github.com/hiefny/MUSIXQUARE/actions/runs/39589667754) | 20 pass / 0 fail / 0 skip / 0 flaky, 89.668 s                                               |
| Final touch repeats                  | Test implementation retained in `f2c0740c`, Windows                                            | 20 pass / 0 fail, 2.0 min                                                                   |
| R2 helper and observation tests      | Test implementation retained in `f2c0740c`, Windows                                            | 5 pass / 0 fail / 0 skip, 13.3 s; three new dialog cases and two existing observation cases |
| Repaired live R2 smoke               | Test implementation retained in `f2c0740c`, Windows against production                         | 1 pass / 0 fail / 0 skip, 1.0 min; transfer and promotion assertions reached                |
| Focused static checks                | Final four test files, Windows                                                                 | E2E TypeScript, targeted ESLint, formatting and diff whitespace checks passed               |
| Final full local and remote suites   | Not started; final scope is local commits only                                                 | Deferred; no full-suite success claimed                                                     |

The two remote diagnostic executions intentionally skipped the WebKit and
production R2 jobs and selected only the repeated touch diagnostic. Their
workflow/step names still include Full E2E, but these executions are **not**
full-suite runs. Those two skipped jobs are not counted as passing tests.
The successful live R2 check above was a separate local execution.

## Final change boundary and remaining checks

Relative to main `a1548d90`, the final implementation changes only:

- `e2e/app-touch-policy.test.ts`
- `e2e/helpers/production-r2-dialogs.ts`
- `e2e/production-live/large-room-r2.test.ts`
- `e2e/production-r2-observation.test.ts`

Temporary diagnostic tests were removed and the E2E workflow was restored to
the main version. Diagnostic probes and raw local artifacts remain outside
the published report; no real room codes or participant information are
included here.

Remaining work is the complete Windows and remote Linux suites, plus their
separately configured WebKit and production R2 jobs, with pass/fail/skip
limits recorded for the actual tested SHA. Physical iOS/PWA input, Android
input and real wireless-network behavior were not tested in this round.
The repaired test mechanics do not close unrelated release-record field
limitations or imply that a product deployment is necessary.
