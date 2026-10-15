# Desktop action button width — 2026-10-16

## Scope

Owner-approved preview: Sync and Media should keep their existing maximum
160px width from the 1280px desktop breakpoint. Their height remains 56px and
their shared gap remains 12px. Mobile styling and sharing animation ownership
are unchanged.

The desktop action row already has a 332px preferred width inside an inset
secondary rail. Its additional `max-width: calc(100% - 80px)` narrowed that row
to 263px at a 1280×800 viewport, producing two 125.5px buttons. Use `max-width:
100%` so the existing parent rail provides the inset once. The row remains
centered and can still fit its parent. Sharing motion reads the resulting row
width through its existing ResizeObserver.

Release scope is App only, **8.10.27 / v693**, with Developer API D1 application
disabled. There are no dependency, schema, secret, binding or protocol changes.
Mixed client versions are compatible. Reverting this CSS change restores the
previous narrower desktop buttons; existing release recovery floors apply.

## Verification

Tested source: `213ed1fbae8e40bd40db74800b7cb56338fa0fb6`, clean local tree.
Environment: Windows 11, Node 24.13.1 (repository/CI pin: 24.20.0), Vitest
5.0.3 and Playwright 1.63.0. These local results are not the exact-main release
candidate.

| Check | Result |
| --- | --- |
| Full unit suite, `npm test -- --maxWorkers=4` | 567 files, 12,768 pass / 0 fail / 0 skip, 478.62 s |
| Six initially failing files, `vitest run ... --maxWorkers=1` | 635 pass / 0 fail / 0 skip, 260.21 s |
| Typecheck | Passed on `2384a09d`; the only subsequent runtime change is the HTML bootstrap cache query corrected below |
| Lint, formatting, App Worker syntax, Developer API boundary, D1 and operations-drift source guards | Passed |
| Committed-runtime `build:checked` | Passed, including cache history, transfer budget, production security and all 95 app-shell assets |
| Critical Chromium E2E | 29 pass / 0 fail / 0 skip, 1.4 min |
| Existing sharing motion-failure and stationary-hover E2E | 3 pass / 0 fail / 0 skip, 29.1 s |
| Temporary viewport matrix | 36 geometry observations passed: Chromium/WebKit × Korean/Arabic × nine viewports |
| Synthetic sharing geometry | Chromium Korean/Arabic: 332px merged control, then two 160px controls; both passed |

The viewport matrix covered 390×844, 1279×800, 1280×600, 1280×800,
1360×800, 1440×900, 1920×1080, 2560×1440 and 3840×2160. The desktop row
measured 332 logical CSS pixels with two 160px buttons, without overflowing its
parent. Existing large-screen UI scale was retained. Mobile navigation stayed
visible below 1280px and hidden at/above it. The language and computed text
direction were asserted. The 1280px Chromium and WebKit captures were visually
inspected.

Chromium used a local Standard room and synthetic audio, without an OS capture
picker. Windows Playwright WebKit has no WebRTC: the temporary harness first
failed in host creation (PeerJS explicitly reported unsupported WebRTC and the
synthetic RTC proxy had no target). The corrected WebKit lane follows the
existing WebKit UI sentinel: initialize the app, expose its settled shell and
measure the real CSS without claiming a connected room or audio capture.
WebKit sharing/transport and physical devices are not covered. The complete
640-test serial E2E suite was not rerun for this single desktop CSS constraint.

### Initial failures and controlled revalidation

The initial `2384a09d` unit run overlapped with `build:checked` and typecheck:
12,756 passed / 12 failed across 567 files in 390.68 s. One assertion exposed
an actual preparation omission: `index.html` still requested the bootstrap
with `cache=v692` while the canonical epoch was v693. The production app-shell
build guard independently rejected the same mismatch. Commit `213ed1fb` fixes
that mirror; no assertions or timeout limits were relaxed.

The other eleven failures were elapsed-time limits, not differing assertions:
six temporary-Git cache-guard cases, two temporary-Git release-state cases,
one ESLint configuration load, one synthetic 100-device PRO Worker case, and
the dead-export analyzer subprocess. The Git fixtures and synthetic Worker
cases do not depend on the changed CSS or product version. They passed when
the same six files ran serially, followed by the complete suite with four
workers and no concurrent build/typecheck. The analyzer went from its 110 s
timeout to 33.13 s serially (45.14 s in the bounded full suite); the ESLint
file went from 60.71 s to 1.60 s (2.24 s in the bounded suite). Worker startup
averaged 4.69 s initially and 1.15 s in the bounded suite.

This establishes timeout failures under the initial overlapping workload and
passing checks under the recorded execution limits. It does not identify a
specific OS, CPU, disk or antivirus mechanism. Keep heavy local checks
sequential for this release and retain the failed-run evidence rather than
calling the first attempt green. Raw logs are in the task-local temporary
directory `mxqr-desktop-width-release-20261016`; they are not production logs.

## Release and recovery

[PR #358](https://github.com/hiefny/MUSIXQUARE/pull/358) merged as
`0d08447cb1447edb3a32a49fb872da450db793bf`. The
[PR CI](https://github.com/hiefny/MUSIXQUARE/actions/runs/38813961353) passed all
11 jobs, and Codex review completed without findings. The separate
[exact-main CI 38814552948](https://github.com/hiefny/MUSIXQUARE/actions/runs/38814552948)
attempt 1 passed all 11 jobs: 567 unit files, 12,767 passed / 0 failed / 1
skipped (the Windows-only different-drive path check on Linux), production
candidate browser/Service Worker 17 passed, critical browser 29 passed, and
all coverage, static and build gates passed. The broad coverage report merges
the two unit shards; it is not an additional test execution.

[Production Release 38815146392](https://github.com/hiefny/MUSIXQUARE/actions/runs/38815146392)
attempt 1 used that exact-main candidate with `target=app` and Developer API
D1 application disabled. The deploy job completed successfully at
**2026-10-16 07:11:59 KST** (`2026-10-15T22:11:59Z`). The App target still
applied and verified its ordinary idempotent App D1 baselines.

| Evidence | Recorded result |
| --- | --- |
| App deployment | `106ea65b-12c6-4800-bac0-926be3d6965b` |
| App version | `66b01d9f-4fa2-4441-9fd7-60c1b032aab0` |
| Previous deployment / version | `98c9ee44-0aaf-42d2-b338-31d0af8d65ec` / `a4b4004f-5be3-47fd-a048-836085fb177b` |
| Final ownership | `verified` at 07:11:52.258 KST; deployment, version and `git:0d08447cb1447edb3a32a49fb872da450db793bf` matched |
| Coherent marker | `production-committed.json`, schema 1, exact deployed SHA, `target=app` |
| Partial-release recheck | `compatible` at 07:11:15.065 KST; all five unselected Workers retained their recorded deployment/version and `d9364cd94ef036c5202ebf20cf5fff0b68d8cacf` provenance |

The unselected Worker identities below are explicitly **version ID / deployment
ID**, as recorded by `partial-release-compatibility-recheck.json`:

| Worker | Version ID | Deployment ID |
| --- | --- | --- |
| signaling | `c25e8be3-bb42-465f-a66b-77360b3a5f1a` | `052c9597-cc96-44ea-91cb-40469840d760` |
| pro-room | `8d5d44c0-c925-4495-86d7-29bf11a0958e` | `e5049949-cbcf-4210-b736-92541dfadddf` |
| remote-share | `b7150b48-2e77-4db0-a908-718fe341bd5f` | `8b306664-f898-463a-aeb3-f4a083ae0d5a` |
| developer-api | `c4069dcd-524d-4752-baa0-364aba94679a` | `5bf2cebe-69f1-4cdc-847c-e9b3e0c28e5d` |
| developer-api-facade | `d4b348cd-3323-4f48-8bbb-4f49a3680110` | `44f54bd6-1af9-4da3-9829-48d28d4c7037` |

All four selected live smokes passed: App generation convergence on
`/assets/main-V_6oR3WG.js` with 27 verified assets and three consecutive reads,
anonymous App account boundary, current PRO public boundary, and Standard
HTTPS signaling host/guest admission with offer/answer relay. PRO smoke
confirmed the existing `8d5d44c0` version. Smokes for unselected deployment
scopes were skipped.

After deployment, the canonical public `/`, `/service-worker.js` (v693),
`/bootstrap.js?cache=v693`, `/assets/main-V_6oR3WG.js` and
`/assets/main-DmP57Ip4.css` all returned HTTP 200. A fresh Chromium browser
entered a real Standard host room at `https://musixquare.com/`, without a CSS
override. At 1280×800, 1360×800 and 1440×800, both buttons measured 160×56px;
the row measured 332px with `max-width: 100%` and a 12px gap. The 1280px
production screenshot was visually inspected. These production checks did not
exercise sharing capture or physical devices; those limits remain separate
from the local synthetic sharing results above.

[Operations Drift Audit 38815569546](https://github.com/hiefny/MUSIXQUARE/actions/runs/38815569546)
attempt 1 passed on the deployed SHA. Its report generated at
07:13:27.343 KST (`2026-10-15T22:13:27.343Z`) records
`automated-checks-passed`: 31 pass / 0 fail / 5 manual-only. Manual-only checks
are not counted as passes.

Recovery was not needed and the independent recovery job was skipped. The
immutable checkpoint captured at 07:10:36.286 KST preserves the previous App
deployment/version above and SHA `476e42b11aa504a935b38e318e9c0ea328cd4345`
(`8.10.26/v692`). Restoring that baseline restores the narrower desktop
buttons. Mixed client versions remain compatible; recovery still requires
fresh ownership and floor verification. The checkpoint is release recovery
evidence, not a user-data backup. The captured generation floor remains
`4c5612d5fc4c5548781eb7d5b26d6904969c051c`, with entitlement and Developer API
authority awareness verified for the previous App; no new floor was added.

The release run retains these artifacts for 90 days:

- `production-deployments-0d08447cb1447edb3a32a49fb872da450db793bf-38815146392-1`
  contains App before/after state, final ownership verification and the
  partial-release compatibility recheck.
- `production-recovery-checkpoint-0d08447cb1447edb3a32a49fb872da450db793bf-38815146392-1`
  contains the immutable pre-mutation App and floor checkpoint.
- `production-commit-0d08447cb1447edb3a32a49fb872da450db793bf-38815146392-1`
  contains the coherent commit marker.

Task-local `public-assets.json`, `production-geometry.json` and
`production-1280.png` retain the public HTTP, measurement and screenshot
evidence in `mxqr-desktop-width-release-20261016`. The current state and this
release's one history row link here. The follow-up documentation commit does
not change the deployed code SHA and requires no App release.
