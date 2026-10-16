# Maximum text weight 700 — 2026-10-16

## Scope

Owner decision (2026-10-16), after the 8.11.2 display-weight change and a
preview of the remaining heavy fields: the heaviest text anywhere in the
project is 700, the BETA badge included, because heavier weights lose
legibility on low-resolution screens.

- All 104 CSS declarations above 700 (750, 780, 800, 820 and 900) become 700,
  across 22 files:
  - App (7): the room password digits and the join code inputs (900), the BETA
    badge (800), and the playlist selection count, dialog choice labels, native
    language names and demo track titles (750).
  - Admin console (42), design page (14), about (9), events (5), editorial base
    (3), blog (3), history (1), account completion (1), legal pages (1), static
    language page (1), sitemap (1) and the Soro article page in the App Worker
    (2).
  - Design system previews (6 labels), the local-only UI kit (6) and the
    Playwright report viewer (2).
- Design system: the unused `--fw-extrabold` token and the 800 samples in the
  Weights row and the type-weights preview are removed, and the README states
  the rule.
- Static OG cards: the headline renders at 700 instead of 800. The generator now
  loads satori's CommonJS build, because satori 0.36.0's ESM bundle throws
  `__dirname is not defined` under Node ESM. It no longer loads ExtraBold, the
  subset script only produces Bold, and `fonts/Pretendard-ExtraBold.ttf` and
  `public/fonts/og-pretendard-extrabold.ttf` are removed. All 16 cards were
  regenerated. Before the change, re-rendering the old 800 template through the
  CommonJS build reproduced 12 of the 16 committed PNGs byte for byte; the
  invite, history, design system and blog cards predated the generator's
  current headline letter spacing, so they also pick up that spacing.
- Locale font preloads (`src/i18n/locale-fonts.ts`) ask for weight 700 instead
  of 750. The self-hosted fonts are variable, so the same files load; the unit
  and E2E probes follow.
- `strong` and `b` are pinned to 700 in `public/admin.css` and
  `public/events/event.css`. Those pages render dynamic `<strong>` values, and
  the browser default `bolder` turns a `<strong>` inside 600 text into 900.
- New unit test `src/ui/__tests__/max-font-weight.test.ts` scans the served
  sources (`index.html`, `e2e/report-viewer.html`, `css`, `public`,
  `.workshop`, `browser`, `cloudflare`, `src` and `scripts`, without tests or
  `src_ref`) for declared text weights above 700 (`font-weight`, SVG
  attributes, style objects, the `font` shorthand, canvas and FontFaceSet
  strings, `wght` settings) and for `bolder`. `@font-face` weight ranges are
  ignored. A probe file with `font-weight: 800` and `font: 900 12px` made it
  fail, and a `100 900` range did not. The report viewer joined the scan after
  the Codex review (P2) noted it was changed but not covered; restoring 800
  there made the test fail.
- Unchanged: the screensaver already tops out at 700 (Google Sans 500 and 700),
  the main `og-image.png` tagline is below 700, and landing photos are images.
- Release identity: App only, **8.11.3 / v700** (the App Worker's inline Soro
  page styles ship with the App target). No dependency, schema, secret, binding
  or protocol change. Mixed versions are compatible.

## Verification

Tested source: **`05fe7443`** (8.11.3, cache epoch v700), branch
`agent/max-weight-700`, clean tree. Environment: Windows 11 Pro, Node 24.13.1
(the repository pins 24.20.0, which CI uses), Vitest 5.0.3, Playwright 1.63.0
with Chromium. These are local and branch results, not the exact-main release
candidate.

| Check | Result |
| --- | --- |
| Full `vitest run` | 571 files, **12,846 passed / 0 failed / 0 skipped**, 188.44 s |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Passed |
| `guard:dead-exports`, `guard:room-authority-boundaries`, `guard:import-graph`, `guard:bus-pairing`, `guard:lifecycle-writes`, `guard:source-complexity` | Passed |
| `guard:sw-cache-version`, `guard:release-identity` | Passed (v700 covers every runtime change) |
| `guard:font-assets`, `npm run build:checked` | Passed, including the font build guard, the UI kit, initial transfer budget, production security and all 97 app-shell assets |
| `npm run test:e2e:critical` | **40 passed / 0 failed / 0 skipped / 0 flaky**, 2.7 min |

Computed-weight sweep, on a Vite dev server started from the worktree in the
desktop app's Chromium browser: for every element and every `::before` or
`::after` with content, the computed `font-weight`. The app shell (1,799
checks) and 35 other pages (404, account completion, blog, design system,
events, history, screensaver, the seven `.workshop` pages, 22 design system
previews and the UI kit) all topped out at 700 or below, with no element above
700. The screensaver's static page tops out at 500 and the nav-pill preview at
600.

All 16 regenerated OG cards were inspected on one contact sheet: the headline
renders at 700 and the layouts are otherwise unchanged.

## Limits

- The admin console and the Soro article page were not rendered in a browser
  (they need a signed-in admin or Worker data). The source scan covers their
  declarations, and the admin console pins `strong` and `b`.
- Dynamic content that is not in the static DOM was not rendered; the source
  scan and the `strong`/`b` pins cover it.
- No physical device was checked, and the complete serial E2E suite was not
  rerun.

## Release and recovery

App-only release (`target=app`). Recovery is the ordinary Production Release
rollback to the 8.11.2 checkpoint, which restores the previous weights and OG
cards.
