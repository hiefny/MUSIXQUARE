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

Pending the reviewed PR, successful exact-main CI candidate and App release.
