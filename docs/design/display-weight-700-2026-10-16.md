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

App **8.11.2/v699** shipped through
[Production Release 38866744699](https://github.com/hiefny/MUSIXQUARE/actions/runs/38866744699),
attempt 1, target `app`, Developer API D1 application `false`. The deploy job
completed successfully at **2026-10-16 16:24:23 KST** using the immutable
candidate from exact-main CI
[38866050515](https://github.com/hiefny/MUSIXQUARE/actions/runs/38866050515) for
`c6ccfa03b2f0aa4b549ad24ed38bff899aa876a6`. No rollback was needed; the recovery job was skipped.

- Exact-main CI ran 11 jobs: 570 unit files, 12,844 passed / 0 failed / 1
  skipped (the Windows-only cross-drive path check on Linux), 17 candidate
  browser and 40 critical browser tests passed, and every coverage, static and
  build gate passed. Pull request CI passed all 11 jobs and the Codex review
  completed with no findings.
- App version `065ead32-e74a-4e47-b3ad-d5643ae20744` became
  `26de6257-dadf-4cae-ac3e-872d67bd4ee3`. Final deployment ownership was
  verified at 16:24:18.408 KST, and the coherent production marker records the
  exact SHA and target `app`.
- The partial-release compatibility recheck at 16:23:50.840 KST was
  compatible. The five unselected Workers were not deployed and keep the
  `d9364cd9` identities in `docs/release-record.md` §1; the PRO smoke re-read
  pro-room `8d5d44c0`. The new App deployment identity is in the 90-day run
  artifact `production-deployments-c6ccfa03b2f0aa4b549ad24ed38bff899aa876a6-38866744699-1`.
- App generation (`main-DpdM8Dpu.js`, three consecutive reads, 29 assets
  converged), anonymous App account boundary, current PRO public boundary and
  Standard HTTPS signaling smokes passed. Out-of-scope Worker smokes were
  skipped, not counted as passes. The seven existing App D1 baselines were
  applied and verified idempotently; Developer API D1 steps were skipped.
- Public checks at 16:26 KST returned HTTP 200 for `/`, the v699 service worker,
  `bootstrap.js?cache=v699`, `main-DpdM8Dpu.js` and `main-C5ULjsC0.css`. The
  public stylesheet defines `--font-weight-display` once, as 700, with no
  Japanese/Chinese override. The public design system token is 700, the design
  page reads `28 / 700` and `24 / 700`, and the type-scale preview uses the
  token.
- [Operations Drift Audit 38867088682](https://github.com/hiefny/MUSIXQUARE/actions/runs/38867088682)
  succeeded. Its 16:25:30.358 KST report records **31 pass / 0 fail / 5
  manual-only**; manual checks are not treated as completed.

The immutable recovery checkpoint captured at 16:23:03.832 KST
(`production-recovery-checkpoint-c6ccfa03b2f0aa4b549ad24ed38bff899aa876a6-38866744699-1`)
preserves the previous App `cedc0b04707ed619647a3897f54bc1c3bcfd64e2`,
8.11.1/v698, version `065ead32-e74a-4e47-b3ad-d5643ae20744`, deployment
`c9f13516-65a3-4c86-96be-e44798d17dd2`. Rolling back to it restores the 800
display weight and the Japanese/Chinese 700 exception. Mixed versions are safe
because only CSS changed. The checkpoint is not a user-data backup; no data
migration is needed and existing recovery floors remain binding.
