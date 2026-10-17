# Phone portrait setup centered by its visible edges — 2026-10-18

## Report

After 8.11.15 ([report](setup-mobile-centering-2026-10-18.md)), the owner saw
the middle block of the phone portrait setup screens sit slightly low, closer
to the actions than to the header, and asked whether empty space inside the
header or the block caused it.

## Cause

It did. 8.11.15 made the gaps between the element boxes equal, but each box
holds a different amount of empty space. Measured from screenshots (the first
and last rows of visible pixels, 390×844):

| Hidden space | First screen | 방 만들기 | 방 참여하기 |
| --- | --- | --- | --- |
| Under the header's last text line (line spacing) | 5.3px | 5.3px | 5.3px |
| Top of the block, inside its box | 0 | 17.8px (the QR's transparent two-module margin, 8% of the square) | 17.3px (the scan button fills 84% of its square) |
| Bottom of the block, inside its box | 0.5px | 17.6px (under the code digits) | 0.1px (the code field's underline is the edge) |
| Visible offset of the block toward the actions | 2.3px | 2.8px | 11.3px |

The other three phone sizes showed the same pattern: about 11–12px on 방
참여하기 and 2–4px on the other two screens.

## Change

The auto margins still split the free space; the bottom paddings now balance
the hidden space on each side, in the responsive layer for
`(max-width: 719px) and (orientation: portrait)`:

- 방 만들기: `padding-bottom: calc(27.5px + 0.08 * min(272px, 56vw, 36dvh))`
  (56 + 5 + the QR inset − 16 − 17.5), with a `36vh` fallback line like the
  QR square's own width.
- 방 참여하기: `padding-bottom: calc(45px + 0.08 * min(272px, 56vw, 36dvh))`
  (56 + 5 + the scanner inset − 16).
- First screen: `padding-bottom: 41px` (56 + 5 + 4 − 8 − 16).
- The inset follows the square's size, which depends on the screen width and
  height. The 8% holds for the host QR because `MUSIXQUARE.COM/` plus six
  digits fits a 21-module code with a two-module margin.
- App 8.11.16 / service-worker cache v718. Nothing else changed.

## Verification

Base `d51eb367` (main after #389). Tested runtime source: `b7d62107`, rebased
onto `31d11d59` (main after the docs-only #390) as `05479264` with the same
runtime files. Local Windows checks used Node 24.13.1 / npm 11.8.0. These are
local branch results, not the exact-main release candidate.

### Visible gaps

Playwright 1.63.0 headless Chromium on a Vite dev server of the worktree,
dark theme, device scale 2, reduced motion, a test-only fixed room code. The
gaps run from the header's last visible pixel row to the block's first, and
from the block's last to the first button's first (px, above / below):

| Phone | First screen 8.11.15 → now | 방 만들기 8.11.15 → now | 방 참여하기 8.11.15 → now |
| --- | --- | --- | --- |
| 390×844 | 158.5 / 154 → 156.5 / 156 | 180 / 174.5 → 177 / 176.5 | 179.5 / 157 → 168.5 / 168 |
| 375×667 | 70.5 / 65 → 67.5 / 68 | 94.5 / 90.5 → 92.5 / 92.5 | 94.5 / 73 → 83.5 / 83 |
| 360×780 | 115.5 / 110 → 113.5 / 113 | 154.5 / 150.5 → 152.5 / 152.5 | 154.5 / 133 → 144.5 / 144 |
| 430×932 | 202.5 / 198 → 200.5 / 200 | 215 / 207.5 → 211 / 210.5 | 214.5 / 190 → 202.5 / 202 |

The remaining differences are within 0.5px. The header's top and bottom and
the buttons stay where they were. 320×568, whose content is taller than the
screen, lays out as before and scrolls.

### Checks

On `b7d62107`, `typecheck`, `typecheck:tests`, `lint`, `format:check`, and
`build:checked` passed. `build:checked` includes the service-worker cache
version (v718 covers every committed runtime change), legacy TV build
(Chromium 79), and app-shell (97 assets) guards. The full unit run passed 581
of 581 files and 13,038 of 13,038 tests. On a `build:e2e` bundle,
`e2e/connection.test.ts` and `e2e/setup-carousel-autoplay.test.ts` passed 15
of 15 in Chromium.

`src/ui/__tests__/setup-mobile-centering.test.ts`
now pins the three paddings and the values they derive from: the header's
56px gap and 16px / 1.5 subtitle, the actions' 16px top padding, the carousel
viewport and nav-row margins, the QR and scanner square size, the 84% scan
button, the code field's 8px padding and 32px digits, and the invite QR's
payload root and two-module margin.

### Not covered

- Real devices, other locales (other fonts can change the ~5px and ~17.5px
  text spacing by a pixel or two), and the light theme.

## Limits

- The text spacing values are fixed pixel amounts for the current fonts and
  sizes. A font, size, or line-height change on the header subtitle or the
  code digits needs the paddings updated together (the test lists them).
- A longer invite payload would need a larger QR code with a smaller relative
  margin, and the 8% would then shift the block by about a pixel.
