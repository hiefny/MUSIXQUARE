# Screensaver caption glow and combined centering — 2026-10-17

The owner requested the seconds digits' weak blue glow on slide descriptions,
while keeping the back button, music footer, and buttons free of shadows.
Weather, air quality, and moon should center their primary and secondary content
as one group. Clock and calendar retain their existing optical alignment.
The owner also authorized production deployment and reconciliation of the local
checkout with remote `main` without losing its older documentation work.

## Scope and identity

- Implementation baseline: `82c3f11eef2d9b7bbcb6d6900fcbd2c403c13955`.
- Production baseline: `5cbfaadf709c25bd66f9bf45e23e532e0955ca09`, App
  `8.11.9` / `v708`; this report does not replace its deployment evidence.
- Released identity: `8.11.10` / `v709`, target `app`, Developer API
  D1 disabled. Product source `1214dfb9`, initial test checkpoint `7bdbcb66`,
  and corrected-test checkpoint `3d175246` are identified below. PR #379 merged
  as `68fb3f9cda90d566d99e60535f944ee1eb8e010b`; its exact-main candidate passed
  all 11 CI jobs and was deployed as recorded below.
- The grouped caption layer receives a weak `rgb(140,205,255)` glow with the
  seconds effect's opacity and size-relative blur radius. The existing complete
  caption ink remains a separate sharp layer; the change does not restore the
  per-letter textures associated with the earlier missing-stroke report.
- Weather, AQI, and moon remove the small-content optical offset, centering the
  combined primary and secondary layout width. The side-by-side hierarchy stays
  intact; this is not the discarded experiment with captions below the main text.
- Clock and calendar alignment, large-content directional effects, seconds
  morphing, background manifest and image assets, and control shadowlessness are
  preserved. The already approved lighter diffusion clock image is unchanged.
- No new dependency, API/protocol, stored-data schema, secret, binding, permission,
  CSP, or provider integration is introduced. Lazy loading, location consent,
  YouTube exclusion, fullscreen restoration, and control idle behavior keep their
  existing contracts.

## Local documentation reconciliation

The primary checkout was at `a09058a3` with local changes only to
`docs/README.md`, `docs/release-record.md`, and the untracked
`docs/design/screensaver-safari-filter-diagnosis-2026-10-16.md`.
Their exact originals, binary patch, base SHA, and hashes were backed up under
the operator's `preserved/local-main-before-sync-2026-10-17/` directory.
The same three files were then saved in stash commit
`50168f1a670746e9c970f3a7a3758db42783c4da`; the primary checkout fast-forwarded
to `82c3f11e` and was clean at that checkpoint.

The [original Safari diagnosis](screensaver-safari-filter-diagnosis-2026-10-16.md)
is now included and indexed. Its complete 89-line body was preserved, verified
by comparison with line endings normalized; a clearly dated addendum links the
subsequent 8.11.4 compatibility release and 8.11.5 caption repair. Its old local
release-record item describing an unimplemented compatibility correction is
superseded by those releases, rather than reopening an already shipped repair.
Physical iPhone verification remains outside the historical evidence and stays
in the current release record. The backup and stash remain available until the
new integration and final local/remote synchronization have been verified.
At this report's writing checkpoint, 11:46 KST after product deployment, the
primary checkout had fast-forwarded to `68fb3f9c` and was clean and equal to
`origin/main`. The operator will fast-forward and verify the final diff after
this release-documentation PR merges, retaining that synchronization evidence
outside the repository rather than creating a self-referential documentation
commit. The preserved stash is retained.

## Verification

Local verification uses product source `1214dfb9` and test commit `7bdbcb66`,
whose runtime is identical, on Windows with Node 24.13.1 and npm 11.8.0.
The pinned CI environment remains authoritative for a production candidate.

- Full typecheck, lint, and final format checks passed. The first format check
  overlapped test edits and reported `e2e/screensaver.test.ts`; formatting was
  corrected before the final passing check. Auxiliary browser types, E2E
  typecheck, and E2E ESLint also passed.
- Worker syntax, Developer API boundaries, D1 migration contracts, and
  source-only operations contracts passed. The reconciliation-only brand
  capitalization guard and `git diff --check` also passed.
- The full `npm test -- --maxWorkers=2` run passed 575 files / 12,898 tests,
  with zero failures and zero skips, in 463.66 seconds.
- Committed `build:checked` passed at `7bdbcb66`, including production security,
  legacy-TV compatibility, the v709 cache guard, and 97 app-shell assets.
- Two focused Chromium caption cases passed, followed by all 16 focused
  screensaver integration cases. The 16-case suite retains lazy-loading,
  YouTube exclusion, fullscreen, caption integrity, scene-change, and lifecycle
  coverage; the two earlier cases are not counted as additional unique cases.
- Independent source review of `1214dfb9` against `82c3f11e` found no actionable
  issue in caption alpha/tint handling, grouped ink, halo padding and disposal,
  steady-state repaint avoidance, unchanged clock/calendar geometry, or combined
  information bounds including the degree symbol. Review is separate from
  browser execution and does not establish physical-device behavior.
- Real-font Chromium and Windows WebKit visual checks passed for all five scenes
  at 390×844/DPR2 and 1280×720/DPR1.25: four engine/viewport configurations and
  20 screenshots. Sixteen caption samples had zero missing, unexpected, or
  clipped ink pixels and zero halo pixels touching their texture edges. Their
  maximum halo alpha was 32/255; at least 98.23% of measured halo pixels met the
  blue-tint check. Clock and calendar geometry matched baseline, and the back
  button, music text, and action button retained `none` for their text shadow,
  box shadow, and filter. All configurations had no page errors.
- The first external WebKit fixture failed at a `3.0000124px` versus `3px`
  raster-center boundary. A `3.01px` float tolerance addressed that boundary,
  but the 1280px weather scene then measured `+6.9404px` using an alpha≥160
  raster bounding box. Both initial reports and logs remain preserved; the
  threshold was not widened again to force a pass. This high-alpha bound includes
  the existing directionally softened glyph edges and does not define the full
  logical group extent.
- External-only instrumentation read the layout and independently unioned
  pre-effect glyph ink. Weather/AQI/moon logical centers were exactly zero at
  both WebKit widths; the independent ink unions were also zero within
  `2.9e-14px`. Instrumented and original saved-build raster bounds matched within
  `0.01px`, while preserving the `+6.9404px` thresholded raster result. No product
  code was changed in response to these diagnostic fixture observations.
- PR review [comment 4300881590](https://github.com/hiefny/MUSIXQUARE/pull/379#discussion_r4300881590)
  on `256557d5` proposed a runtime recentering fix for that WebKit raster offset.
  Independent adjudication did not confirm a product defect: the pre-effect
  `actualBoundingBox` ink union, including the degree symbol, spans
  `281.6888–998.3112px` and centers at exactly `640px`. Alpha≥160 omits
  approximately `17.81px` on the left and `3.92px` on the right because of the
  existing directional effect. Moving the runtime to center that thresholded
  subset would offset the requested combined content. The maintained E2E test's
  alpha-threshold centering assertion was therefore corrected to measure
  the pre-effect glyph union in `3d175246`, without a wider tolerance or a runtime shift.
  Both corrected focused caption tests passed in 15.9 seconds at 390px/DPR2 and
  1280px/DPR1.25. E2E typecheck, targeted ESLint, Prettier, and diff checks passed;
  independent reviews of the test correction found no remaining issue. The
  original failures and the review finding remain in the evidence.
- The corrected tests loaded the exact built runtime with SHA-256
  `b77aac1a6020cd909e94c4854accab975ee727d99ff44f29ea3245f4c25f2227`,
  matching the local production `dist`; instrumentation was added only to the
  test-served response. The first scratch fixture was incomplete and returned
  HTTP 404, causing setup to time out before test assertions. The complete
  scratch E2E build then passed in 2.11 seconds, followed by the two passing
  caption cases above. The initial and corrected logs are retained as
  `local/centering-probe-e2e.log` and
  `local/centering-probe-focused-e2e.log`. Product code remains `1214dfb9`.

Evidence is retained under the operator's `caption-glow-centering/` directory:
`visual-report.json`, `visual-report-webkit.json`, the two initial-attempt reports,
`source-review.json`, screenshots, and the local check logs. Foreground source
pixels were measured independently of background/grain; screenshots show the
composition. Font and weather responses are deterministic fixtures. Accelerated
scene captures can retain a prior background during decoding/crossfade, so these
checks do not claim background-transition or performance coverage. Background
assets are unchanged. Root review inspected Chromium weather and WebKit weather
and FRI captures and found their visible text normal.

PR [#379](https://github.com/hiefny/MUSIXQUARE/pull/379)'s earlier
[CI 38994374726](https://github.com/hiefny/MUSIXQUARE/actions/runs/38994374726)
on `fb3b119e` passed all 11 jobs. The final corrected-test head
`3d17524612a39db4edfd73a4ae6ae64b500e86d5` then passed all 11 jobs in
[CI 38995057681](https://github.com/hiefny/MUSIXQUARE/actions/runs/38995057681)
before merge. The automatic review raised the one P2 finding adjudicated above;
it is not recorded as a review with zero findings. The PR merged as
`68fb3f9cda90d566d99e60535f944ee1eb8e010b`, whose
[exact-main CI 38995509028](https://github.com/hiefny/MUSIXQUARE/actions/runs/38995509028)
passed all 11 jobs on attempt 1: 575 unit files / 12,897 pass / 0 fail / one
Linux skip for a Windows-only different-drive path rejection case, candidate
browser 17 pass, and critical browser 45 pass. Coverage, type, lint, static,
build, and security gates passed. The accepted manifest identifies Node
24.20.0, npm 11.19.0, and Wrangler 4.148.0. Windows WebKit automation does not establish physical iPhone
Safari behavior, and synthetic weather or room fixtures do not establish
live-provider or audible multi-device behavior. The full serial E2E suite has
not been run for this change.

## Release and recovery

Production Release [38995961690](https://github.com/hiefny/MUSIXQUARE/actions/runs/38995961690)
attempt 1 deployed exact main `68fb3f9cda90d566d99e60535f944ee1eb8e010b`,
target `app`, with Developer API D1 disabled. The deploy job completed at
2026-10-17 11:44:26 KST. It used the successful exact-main CI
[candidate 12086918277](https://github.com/hiefny/MUSIXQUARE/actions/runs/38995509028/artifacts/12086918277),
whose manifest binds the SHA, CI run `38995509028` attempt 1, `main-ci`
validation profile, and `8.11.10` / `v709` identity.

The new App version is `af52bdca-f2ed-4b46-9c36-b2114f414d6c`, deployment
`c6cdaf66-b028-42bc-b278-40386c25997f`. Final release ownership was verified at
11:44:22.663 KST, followed by the coherent production commit marker. The
11:43:54.063 KST compatibility recheck confirmed the five unselected Workers
still match their recorded deployments, all with `d9364cd9` provenance; none
was redeployed. Deployment evidence is
[artifact 12087191609](https://github.com/hiefny/MUSIXQUARE/actions/runs/38995961690/artifacts/12087191609),
and the coherent marker is
[artifact 12087291334](https://github.com/hiefny/MUSIXQUARE/actions/runs/38995961690/artifacts/12087291334).

All four operating smoke steps passed: App generation, anonymous App account
boundaries, the current PRO public boundary, and Standard HTTPS signaling.
App generation converged over three consecutive reads to
`/assets/main-YXqhdZl0.js` (435,676 bytes) and 29 verified assets. The existing
seven App D1 baseline apply/verify steps passed idempotently; Developer API D1
and out-of-scope Worker smoke steps were skipped. No new dependency, schema,
secret, binding, permission, protocol, or compatibility floor was introduced.

Read-only public verification at 11:45:01–05 KST passed 19/19 GET checks:
index, service worker, `bootstrap.js?cache=v709`, screensaver HTML/runtime,
the seven approved clock images, and seven retained legacy clock images.
Every request returned HTTP 200 and matched the exact-main candidate's byte
count and SHA-256; the approved clock set also matches its source processing
output. The runtime is `/assets/screensaver-runtime-b77aac1a.js`, 231,119 bytes,
SHA-256 `b77aac1a6020cd909e94c4854accab975ee727d99ff44f29ea3245f4c25f2227`,
identical to the original built runtime used by the corrected local caption
tests. HTML is 19,033 bytes and the service worker is 39,149 bytes with `v709`.
Evidence is retained in `caption-glow-centering/live-assets.json`.

The 11:43:15.624 KST recovery checkpoint
[artifact 12087445286](https://github.com/hiefny/MUSIXQUARE/actions/runs/38995961690/artifacts/12087445286)
preserves prior App `5cbfaadf709c25bd66f9bf45e23e532e0955ca09` (8.11.9/v708),
version `c9afffa3-34b8-4d7e-aee7-66b96da95622`, deployment
`537f7c48-0aa0-4321-b50f-8bab3a142e40`. At 11:43:17.681 KST, the captured
floor was ready: release floor `d9364cd94ef036c5202ebf20cf5fff0b68d8cacf`,
generation floor `4c5612d5fc4c5548781eb7d5b26d6904969c051c`, generation and
entitlement enabled. The prior App is a verified release ancestor and is
generation-, entitlement-, and Developer API authority-aware. Rollback was
unnecessary and not run; the independent recovery job was skipped. Recovery
would restore the previous unlit captions and weather/AQI/moon optical offsets,
subject to fresh ownership and floor checks; this is not a user-data backup.

No new Operations Drift Audit or full serial E2E run was performed after this
deployment. The older Drift success `38978419041` belongs to `5cbfaadf` and
is not evidence for this release; the existing full-suite and physical-device
limits remain. Production and public verification are complete. The 11:46 KST
local/remote checkpoint above precedes this document's merge; the final
fast-forward and diff verification follow that merge and are recorded externally.
