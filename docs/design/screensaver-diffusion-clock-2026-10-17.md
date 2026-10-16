# Screensaver diffusion clock background — 2026-10-17

The owner selected the original, pre-darkening diffusion option 01 for the
production clock scene after comparing it with a darker version that showed
visible banding on their display. This change uses that approved image and its
existing baked output; it does not regenerate or darken the selected artwork.

## Scope and provenance

- Product source: `802f5afc2bbf5b33fe6bb3af4f4c9a778dce3a25`, based on
  `14022256` (current production App source `4d1e0011`).
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
- Local evidence: `musixquare-screensaver/diffusion-clock/built-clock-report.json`
  and its four screenshots under this task's visualization evidence directory;
  ignored `scratch/` logs hold the local checks and original timeout output.

## Release and recovery

The owner authorized the App deployment on 2026-10-17. The PR and successful
exact-main-SHA CI candidate are required before Production Release. Production
deployment and public asset verification are not yet claimed by this preparation.

No API, schema, secrets, bindings, permissions, CSP or recovery-floor changes.
Restoring the prior compatible App candidate restores the previous clock
background; local original and darker previews are preserved separately. Existing
provider, physical-device and other release-record limitations remain open.

Browser captures cannot prove the absence of banding on every physical display;
the user's approved lighter source is used without further shadow adjustment.
