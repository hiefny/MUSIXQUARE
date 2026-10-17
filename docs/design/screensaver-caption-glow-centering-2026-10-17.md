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
  D1 disabled. The tested product SHA and final release candidate are pending.
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

Product validation is in progress. No new product test, browser comparison,
exact-main CI, or production deployment pass is claimed by this initial report.
The reconciliation-only brand capitalization guard and `git diff --check` passed
before the product verification round; they do not establish runtime correctness.

The final evidence must identify the tested SHA and environment, record actual
pass/fail/skip counts and any initial failures, and cover grouped-caption ink and
glow, weather/AQI/moon group centering, unchanged clock/calendar alignment, and
small/large viewports in Chromium and WebKit. Existing focused integration checks
must retain their lazy-loading, YouTube, fullscreen, and scene-change coverage.
Windows WebKit automation does not establish physical iPhone Safari behavior,
and synthetic weather or room fixtures do not establish live-provider or audible
multi-device behavior. Full serial E2E is not claimed unless explicitly run.

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
