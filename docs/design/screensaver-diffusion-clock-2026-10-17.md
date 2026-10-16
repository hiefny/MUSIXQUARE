# Screensaver diffusion clock background — 2026-10-17

The owner selected the original, pre-darkening diffusion option 01 for the
production clock scene after comparing it with a darker version that showed
visible banding on their display. This change uses that approved image and its
existing baked output; it does not regenerate or darken the selected artwork.

## Scope and provenance

- Product source: `802f5afc2bbf5b33fe6bb3af4f4c9a778dce3a25`, based on
  `14022256` (pre-release production App source `4d1e0011`).
- Release identity: `8.11.8` / `v707`; target `app`, Developer API D1 disabled.
- Original PNG SHA-256:
  `47754a732400308aac7329a5d8d534bdff6b02d09f000213e4db2ccef8379b1e`.
- The seven WebPs are copied byte-for-byte from the owner's approved
  `clock-diffusion-options/01-baked` output. They already contain the photo
  pipeline's blur, brightness 0.78, saturation 0.88 and veil. Runtime brightness
  stays at 1 to avoid applying those adjustments again.
- Clock `grainOpacity` changes from 0 to 0.62, matching the approved preview's
  live grain. The global film grain, text effects, layout and seconds morphing
  are unchanged.
- All other 22 background scene records and their assets, the screensaver
  runtime, lazy entry, parent bridge and child HTML remain unchanged.

| Variant | Pixels | Bytes | SHA-256 filename suffix |
| --- | --- | ---: | --- |
| portrait | 390 × 844 | 10,910 | `71cc2063` |
| portrait-large | 888 × 1920 | 35,630 | `262d3ec2` |
| landscape | 844 × 390 | 12,766 | `a76c08b3` |
| classic | 1024 × 768 | 23,116 | `0f20be57` |
| wide | 1920 × 1080 | 48,568 | `0bfd91a0` |
| square | 1080 × 1080 | 29,930 | `b928a4f9` |
| tiny | 160 × 160 | 1,722 | `5934eec5` |

The new set totals 162,642 bytes. The previous seven immutable clock files
(191,360 bytes) remain available so already-open older screensavers can request
another viewport variant after deployment. They are not referenced by the new
manifest and are not added to the initial app preload.

## Review and validation

Independent review identified that deleting the previous hashed files could
break an older open screensaver on resize. Commit `a26c670b` retains those exact
files; the follow-up review found no remaining blocker. All approved new image
hashes and sizes match, and the non-clock manifest entries are unchanged.

Local verification uses Windows, Node 24.13.1 and npm 11.8.0. The existing local
dependency tree matches the current lockfile excluding the root product version.
The pinned CI environment remains authoritative for the production candidate.

- Full typecheck, lint and format checks passed. No dependencies were changed.
- The initial local full unit run (product tree committed as `cf49833c`) had
  573 files: 12,867 tests passed and two timed out, with no skips. The affected
  release-deployment-state and SW-cache-guard files passed 141/141 with one
  worker and their original timeout values on the final product source. This
  is a full run plus focused recheck, not a single clean final full-suite pass.
- The first committed build correctly rejected retaining legacy runtime assets
  after the v706 bump. The final v707 advance covers that follow-up; committed
  `build:checked` then passed, including the 97-asset app-shell guard. Worker
  syntax, Developer API boundaries, D1 migrations and source-only operations
  drift contracts passed.
- The production-built child passed four visual checks: Chromium and WebKit
  at 1280×720/DPR1 and 390×844/DPR2. New clock asset selection, grain 0.62,
  loaded fonts, no viewport overflow and no page errors were checked. Both
  engines' captures were inspected. All seven new and seven legacy built
  assets matched their expected bytes and SHA-256 values.
- Browser checks use saved Google Sans responses and block other external
  requests. They do not test live weather, a full-stack room or a physical
  iPhone. The full serial browser suite was not run for this image change.
- Focused Chromium screensaver integration checks passed 16/16, including lazy
  loading, YouTube restrictions, fullscreen, caption integrity and scene changes.
- Initial PR CI `38948718087` rejected a lowercase brand token in the local
  evidence path below. The documentation path was shortened; product code was
  unchanged. Final PR head `271ae0aa` passed all 11 jobs in
  [CI 38949092767](https://github.com/hiefny/MUSIXQUARE/actions/runs/38949092767).
- Local evidence: `diffusion-clock/built-clock-report.json`
  and its four screenshots under this task's visualization evidence directory;
  ignored `scratch/` logs hold the local checks and original timeout output.

## Release and recovery

The owner authorized the App deployment on 2026-10-17. PR
[#375](https://github.com/hiefny/MUSIXQUARE/pull/375) merged as
`e0d717314c496feed645ed9c0c7848ffdc85472d`. Exact-main push
[CI 38950054085](https://github.com/hiefny/MUSIXQUARE/actions/runs/38950054085)
attempt 1 passed all 11 jobs: 573 unit files, 12,868 passed / 0 failed / 1 skipped,
candidate browser 17 and critical browser 45 passed, with coverage, source,
formatting, production build and security gates passed. The skip is the
Windows-only other-drive path rejection test on Linux. Release used that run's
[candidate artifact 12068086279](https://github.com/hiefny/MUSIXQUARE/actions/runs/38950054085/artifacts/12068086279),
not a local build or the PR candidate.

[Production Release 38950797624](https://github.com/hiefny/MUSIXQUARE/actions/runs/38950797624)
attempt 1 completed successfully at 2026-10-17 03:55:42 KST, target `app`,
Developer API D1 disabled, version `8.11.8` / cache `v707`. App version is
`1257c8a7-24cd-494f-9ef6-17b21c4fe0ac`, deployment
`6de2f7cb-71c6-4075-a625-2feaeeb2fff6`. Final ownership was verified at
03:55:36.211 KST and the coherent production marker was persisted. The five
unselected Workers retained their `d9364cd9` provenance; the compatibility
recheck passed at 03:55:09.692 KST. All four App-target operating smokes passed:
generation convergence (`/assets/main-ChYbIARs.js`, three consecutive reads,
29 assets), anonymous App account boundary, existing PRO public boundary and
Standard HTTPS signaling host/guest admission with offer/answer relay. The seven
existing App D1 baseline apply/verify steps passed; Developer API D1 and
out-of-scope Worker smokes were skipped. Deployment evidence is
[artifact 12069365547](https://github.com/hiefny/MUSIXQUARE/actions/runs/38950797624/artifacts/12069365547)
and the coherent marker is
[artifact 12069200801](https://github.com/hiefny/MUSIXQUARE/actions/runs/38950797624/artifacts/12069200801).

At 03:56:15–21 KST, public HTTPS GET verification passed 19/19: index, service
worker, bootstrap, screensaver HTML, its runtime and all seven new plus seven
legacy clock images returned HTTP 200 with bytes and SHA-256 matching the
exact-main candidate. The new seven also match the approved diffusion 01 output.
The deployed screensaver runtime is `/assets/screensaver-runtime-5e659d61.js`
(230,301 bytes); service worker cache is v707. This read-only check is recorded
in `diffusion-clock/live-assets.json`, with CI facts in
`diffusion-clock/main-ci-facts.json` and `diffusion-clock/pr-ci-facts.json`.
It does not constitute a live full-room browser or physical-screen test.

Rollback was unnecessary and was not run; the independent recovery job was
skipped. The checkpoint captured at 03:54:34.091 KST,
[artifact 12068566888](https://github.com/hiefny/MUSIXQUARE/actions/runs/38950797624/artifacts/12068566888),
preserves the preceding App `4d1e001105bb1a7a1aa52fa2ef1bf5df551b89d9`
(`8.11.7` / `v705`), version `673f3697-c6ed-43cf-8963-88f71c302fc5`, deployment
`5945bc86-b69e-4862-97b3-c79a968d63f7`. Its verified release ancestry and
generation, entitlement and Developer API authority awareness passed the floor
checkpoint at 03:54:35.800 KST. Release floor `d9364cd9` and generation floor
`4c5612d5` remain active; this change introduces no new floor. Restoring that
compatible App restores the previous gradient-based clock image and clock grain
setting, subject to the normal ownership and floor rechecks. A checkpoint is not
a user-data backup. Local original and darker previews remain preserved.

No API, schema, secrets, bindings, permissions or CSP changed. No new Operations
Drift Audit ran after this release: latest successful
[38945544840](https://github.com/hiefny/MUSIXQUARE/actions/runs/38945544840)
belongs to the earlier `4d1e0011` deployment (31 pass / 0 fail / 5 manual-only).
The latest main Full E2E remains failed run
[38328670967](https://github.com/hiefny/MUSIXQUARE/actions/runs/38328670967)
at `4854e392`; the separate branch success `38405378201` at `749f0a6a` is not
evidence for this release. Existing provider, physical-device and other
release-record limitations remain open.

Browser captures cannot prove the absence of banding on every physical display;
the user's approved lighter source is used without further shadow adjustment.
