# Display title weight 700 — 2026-10-16

## Scope

Owner decision (2026-10-16): the 800 display weight reads too heavy, first
noticed on the dark Settings header, so every display use moves to 700. Before
deciding, the owner reviewed an 800 / 750 / 700 comparison rendered with the
real Pretendard Variable file at the desktop and mobile title sizes.

- `--font-weight-display` changes from 800 to 700 in `css/style.css`. The
  Japanese and Chinese override (`html:lang(ja)`, `zh-Hans`, `zh-Hant` set to
  700, added in `55ba20d8` because Han glyphs looked dense at 800) is removed
  because every locale now uses 700.
- All 22 uses follow the token: tab titles (including the desktop
  `.chat-drawer-title` and `.track-title`), dialog titles, onboarding and setup
  titles, the invite code digits, PIN segments and separators, the room
  password placeholder, the repeat-one badge, sub-track and device indexes,
  device status, the sync column values, the YouTube chat label, demo titles and
  step controls, and the account dialog nickname.
- Section titles were already 700. Titles and section titles now differ by size
  only (24 / 17px on desktop, 28 / 18px on mobile), as Japanese and Chinese
  already did.
- Design system: `colors_and_type.css` sets the token to 700, and its
  `.tab-title` / `.type-display`, `.type-h2` and `.type-code` classes use the
  token instead of `--fw-extrabold`. On the design page, the 28 and 24 scale
  specimens, the display glyph and the dialog title sample use the token, and
  the scale labels read `28 / 700` and `24 / 700`. The type-scale, type-family,
  invite-code and toast-dialog previews use the token for their title, display
  and code specimens.
- Unchanged on purpose: `--fw-extrabold` (800) stays in the weight scale and the
  Weights row, because the BETA pill still uses 800 in the app and on the design
  page. Design-page chrome labels keep their own 800, and the room password code
  keeps 900. The screensaver (`public/screensaver.html`, its own font and
  weights) is not touched, per the owner.
- Release identity: App only, **8.11.2 / v699**, Developer API D1 application
  disabled. No dependency, schema, secret, binding or protocol change. Mixed
  client versions are compatible because only CSS changes. Rolling back
  restores 800 and the Japanese/Chinese exception.

## Verification

Tested source: **`4fa1ba21`** (8.11.2, cache epoch v699), branch
`agent/display-weight-700`, clean tree. Environment: Windows 11 Pro, Node
24.13.1 (the repository pins 24.20.0, which CI uses), Vitest 5.0.3, Playwright
1.63.0 with Chromium. These are local and branch results, not the exact-main
release candidate.

| Check | Result |
| --- | --- |
| Full `vitest run` | 570 files, **12,845 passed / 0 failed / 0 skipped**, 199.66 s |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Passed |
| `guard:dead-exports`, `guard:room-authority-boundaries`, `guard:import-graph`, `guard:bus-pairing`, `guard:lifecycle-writes`, `guard:source-complexity` | Passed |
| `guard:sw-cache-version`, `guard:release-identity` | Passed (v699 covers every runtime change) |
| `npm run build:checked` | Passed, including the UI kit, initial transfer budget, production security, font build and all 97 app-shell assets |
| `npm run test:e2e:critical` | **40 passed / 0 failed / 0 skipped / 0 flaky**, 2.4 min |

Browser checks ran against a Vite dev server started from the worktree, in the
desktop app's Chromium browser:

- At 1024×768, `--font-weight-display` and the computed weight of the tab title,
  section title, dialog title and invite code were 700 for `ko`, `en`, `ja`,
  `zh-Hans`, `zh-Hant`, `th` and `ar`.
- At 1440×900, the tab and chat titles were 700 at 24px, section titles 700 at
  17px and the setup step title 700 at 32px; the visible greeting and onboarding
  titles were 700.
- On the design page the token resolved to 700. The 28 and 24 specimens, the
  display glyph, the dialog title sample and the YouTube chat label were 700,
  the scale labels read `28 / 700` and `24 / 700`, and the BETA pill stayed 800.
  The four edited previews resolved their specimens to 700. The Typography
  section was inspected visually at 1440×900.

## Limits

- No physical phone or tablet was checked. The font file is self-hosted, so the
  weight does not depend on the platform, but it was not inspected on devices.
- Only the dark theme was inspected visually; the weight does not depend on the
  theme.
- The complete serial E2E suite was not rerun for this CSS token change.

## Release and recovery

App-only release (`target=app`). Recovery is the ordinary Production Release
rollback to the 8.11.1 checkpoint, which restores the 800 display weight and
the Japanese/Chinese 700 exception.
