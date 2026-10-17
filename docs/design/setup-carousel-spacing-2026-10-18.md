# Welcome carousel spacing and a fainter dark icon circle — 2026-10-18

## Request

On the first setup screen's carousel, the owner saw a wide gap between the
title and the description and a narrow one between the description and the
page dots. After comparing mockups on a phone, the owner chose visible gaps
of 28px from the icon circle to the title, 20px from the title to the
description, and 36px from the description to the dots.

The owner also asked for the icon circle to sit on `--surface-1` in the dark
theme only. In light the circle is barely visible, while in dark it stood
out; it only evens out the icons' optical size, so it can be very faint. The
phone landscape, tablet, and desktop two-column layouts should get the same
dark circle and spacing in a similar ratio.

## Before

Every gap came from the slide's fixed 16px flex gap plus small margins: 8px
under the title on the phone, and on the two-column panel 3px under the
circle, 4–8px under the title, and a 12–24px nav row margin clamped by the
viewport height. The title-to-description gap also holds the line spacing
under the title and above the description text (about 8.5px on the phone).
On the phone, the nav row's margin collapses with the slider viewport's 4px
margin, so the description-to-dots gap got none of that extra space.

## Change

- Phone and the other single-column views: the slide's 16px gap is gone. The
  icon circle's bottom margin is 24.5px, the title's 11.5px, and the nav
  row's top margin 31.5px. With the space the title's line box adds (about
  3.5px above and below its text) and the description's (about 5px above,
  4.5px below), the visible gaps are 28, 20, and 36px.
- Two-column panel (720px and wider): the same rhythm relative to the title
  size T, about 7/6, 5/6, and 3/2 of T. The circle's margin is T, the
  title's 0.54T, and the nav row's 1.5T − 8px in the compact layout (no
  arrows) or 1.5T − 16px from 1280px, where the 22px arrows center the dots
  7px lower. The desktop slider's 1.1 and 1.2 transform scales apply to all
  of it. The `--setup-ob-title-mb` token and the height-clamped nav margin
  are gone.
- Icon circle color: a new `--ob-icon-circle-bg` token. Dark uses
  `--surface-1` (`#1a1a1a` on the `#121212` canvas, before `#202020`). Light
  keeps `--surface-2`, and so does more contrast (`data-contrast='more'` and
  `prefers-contrast: more`). Forced colors still use the system palette.
- Removed the `.ob-icon-circle` bottom margin of 4px, which the slide rule
  always overrode.
- App 8.11.17 / service-worker cache v719. Nothing else changed.

## Verification

Base `a2d81ac5` (main after #392). Tested runtime source: `ba698458` (the
style commit `cb6df977` plus the version bump). Local Windows checks used
Node 24.13.1 / npm 11.8.0. These are local branch results, not the
exact-main release candidate.

### Visible gaps

Playwright 1.63.0 headless Chromium on a Vite dev server of the worktree,
device scale 2, reduced motion, Korean, first slide. Each gap runs from the
last row of visible pixels to the next first row (icon circle to title,
title to description, description to dots), in on-screen px. T is the
title's size on screen. Readings move in 0.5px steps at device scale 2.

| Size | Layout | T | Before | After | After ÷ T |
| --- | --- | --- | --- | --- | --- |
| 390×844 | phone | 24 | 19.7 / 32.5 / 28.5 | 28.4 / 19.5 / 36.5 | 1.18 / 0.81 / 1.52 |
| 375×667 | phone | 24 | 19.2 / 32.5 / 28.5 | 27.9 / 20.5 / 36.5 | 1.16 / 0.85 / 1.52 |
| 844×390 | two-column | 20 | 22.5 / 26.5 / 21.5 | 22.6 / 17.5 / 30.5 | 1.13 / 0.88 / 1.53 |
| 932×430 | two-column | 20 | 22.4 / 26.5 / 22.5 | 22.6 / 17.5 / 30.5 | 1.13 / 0.88 / 1.53 |
| 768×1024 | two-column | 26 | 22.8 / 31.5 / 33.5 | 29.8 / 21.5 / 40.5 | 1.15 / 0.83 / 1.56 |
| 1024×768 | two-column | 26 | 22.7 / 31.5 / 32.5 | 29.9 / 21.5 / 40.5 | 1.15 / 0.83 / 1.56 |
| 1280×720 | desktop | 28 | 23.1 / 32 / 39.5 | 32.1 / 23 / 41.5 | 1.15 / 0.82 / 1.48 |
| 1440×900 | desktop, ×1.2 | 33.6 | 28.4 / 38.5 / 49 | 39.2 / 28 / 51 | 1.17 / 0.83 / 1.52 |
| 1920×1080 | desktop, ×1.2 | 33.6 | 28.1 / 38.5 / 49 | 38.9 / 28 / 51 | 1.16 / 0.83 / 1.52 |

The phone's 28 / 20 / 36px under a 24px title is 1.17 / 0.83 / 1.5. 360×780
and 430×932 phones measured 27.6–28.4 / 19.5–20.5 / 36.5px after the change.
The light theme matched within 0.5px (390×844 28.4 / 19.5 / 37, 1280×720
32.1 / 23.5 / 42). The computed circle color is `rgb(26, 26, 26)` in dark
(before `rgb(32, 32, 32)`) and `rgb(239, 241, 243)` in light, unchanged.

The phone carousel grew 3.5px. The first screen's auto margins still center
it: the visible gaps above and below the block are 154.5 / 154px at 390×844,
66.5 / 66 at 375×667, 111.5 / 111 at 360×780, and 198.5 / 198 at 430×932,
each 1–2px shorter than in 8.11.16 on both sides. The 41px centering padding
depends only on the block's edges (the viewport's 4px top margin and the
nav row's 8px bottom margin), which did not change. The two-column block
changed height by 5px or less and stays centered in its panel.

### Checks

On `ba698458`, `typecheck` (which includes `typecheck:tests`), `lint`,
`format:check`, and `build:checked` passed. `build:checked` includes the
service-worker cache version (v719 covers every committed runtime change),
legacy TV build (Chromium 79), and app-shell (97 assets) guards. The full
unit run passed 582 of 582 files and 13,041 of 13,041 tests. On a
`build:e2e` bundle, `e2e/connection.test.ts` and
`e2e/setup-carousel-autoplay.test.ts` passed 15 of 15 in Chromium.

`src/ui/__tests__/setup-carousel-spacing.test.ts` pins the phone margins and
the absence of a slide gap, the two-column multipliers and nav margins with
the arrow setting they depend on, and the circle token for dark, light, and
both more-contrast paths. `setup-mobile-centering.test.ts` now pins only the
nav row's 8px bottom margin, the one nav value its padding derives from.

### Not covered

- Real devices and other locales. Latin text has descenders, which shorten
  the description-to-dots gap by a pixel or two, and longer copy wraps
  differently.
- On 360px-wide phones, slide 2's Korean description wraps to four lines.
  The track is as tall as the tallest slide so the dots stay put, which
  leaves the other slides one line (about 22px) more space above the dots
  (58.5px instead of 36.5px). This was already so before the change.

## Limits

- The two-column multipliers fold in the space the title's line box adds
  around its text (about 0.15 × T on each side) with the current fonts at
  20–28px. A font, size, or line-height change on the carousel needs a new
  measurement, as do the phone's fixed values.
