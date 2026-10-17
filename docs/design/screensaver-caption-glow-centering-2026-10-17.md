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
- Prepared release identity: `8.11.10` / `v709`, target `app`, Developer API
  D1 disabled. Product source `1214dfb9` and test checkpoint `7bdbcb66` are
  identified below; the exact-main release candidate is still pending.
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

Evidence is retained under the operator's `caption-glow-centering/` directory:
`visual-report.json`, `visual-report-webkit.json`, the two initial-attempt reports,
`source-review.json`, screenshots, and the local check logs. Foreground source
pixels were measured independently of background/grain; screenshots show the
composition. Font and weather responses are deterministic fixtures. Accelerated
scene captures can retain a prior background during decoding/crossfade, so these
checks do not claim background-transition or performance coverage. Background
assets are unchanged. Root review inspected Chromium weather and WebKit weather
and FRI captures and found their visible text normal.

PR [#379](https://github.com/hiefny/MUSIXQUARE/pull/379) and its checks are in
progress. [CI 38994238332](https://github.com/hiefny/MUSIXQUARE/actions/runs/38994238332)
on `256557d5` is not recorded as passed at this checkpoint; a successful
exact-main CI candidate is still required. No production deployment success
is claimed here. Windows WebKit automation does not establish physical iPhone
Safari behavior, and synthetic weather or room fixtures do not establish
live-provider or audible multi-device behavior. The full serial E2E suite has
not been run for this change.

## Release and recovery

Not yet deployed. Merge review, PR checks, the successful exact-main-SHA CI
candidate, Production Release, public artifact verification, and final local
`main`/`origin/main` synchronization remain pending.

The intended scope is App-only. Other Workers and the existing compatibility
floor are unchanged. The release procedure must capture the actual prior App
checkpoint and verify its ownership and compatibility before any recovery. A
rollback to the production baseline restores the previous unlit captions and
optical offsets on weather/AQI/moon; it does not restore user data. No rollback
has been performed for this change.
