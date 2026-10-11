# PRO PIN two-step dialog — 2026-10-11

Status: implemented and verified locally on branch `agent/pro-pin-two-step`,
based on main `23d2f758`, as App `8.9.1` / PWA cache `v652`. Not merged or
deployed; production remains App `8.9.0` / `v651` at `d76b1432`
([release record](../release-record.md)). Release target `app`. PRO rooms
only; the `POST /pin` contract and every Worker are unchanged.

## Owner decision (2026-10-11)

The 8.9.0 PIN dialog ([membership choice](pro-pin-member-choice-2026-10-11.md))
put a "지금 방에 있는 사람" radio group under the PIN input. The owner keeps
both choices, because different events need different answers, but the
group clipped on small phones and in mobile landscape and did not match the
design system. The owner asked for:

1. The PIN dialog back to its minimal look, with "취소 / 다음" instead of
   "취소 / 확인".
2. "다음" opens a second page whose title, in the same slot and hierarchy as
   "방 암호 설정", reads "현재 참여자를 어떻게 할까요?". No subtitle.
3. Two rows, "그대로 두기" and "모두 재입장", marked by a check on the right
   like the language list, with the corner radius of the settings choice
   buttons (`.ch-opt`, `--radius-m`), in the owner's wording:

| Row | Korean (owner's text) | English |
| --- | --- | --- |
| title | 현재 참여자를 어떻게 할까요? | What should happen to current participants? |
| keep (default) | 그대로 두기 — 다시 입장하거나, 새로 참여하는 기기만 암호를 입력하면 돼요. | Keep everyone — Only devices that rejoin or join for the first time need to enter the password. |
| re-enter | 모두 재입장 — 모두가 다시 들어와야 해요. 모르는 사람들을 한번에 내보내려면 이 방식을 추천해요. | Everyone rejoins — Everyone has to join again. Recommended for removing people you don't know all at once. |

The owner's third request in the same message, making standard rooms use an
owner-set password with the same two-step choice, is not part of this
change.

## Change

### Flow (`src/ui/connect.ts`)

- Step 1: "방 암호 설정" (enabling) or "방 암호 변경" (changing), "새 8자리
  암호를 설정해 주세요.", the 8-digit input, and 취소 / 다음. 다음 runs the
  same PIN validator that 확인 did. Turning protection off still has no
  dialog.
- Step 2: the title becomes "현재 참여자를 어떻게 할까요?", the message and
  input are hidden, and the rows appear with "그대로 두기" checked. 이전
  returns to step 1 with the typed PIN and the choice kept, and focus on the
  PIN input. 확인 resolves the dialog once with the PIN and the choice.
- Mapping is unchanged: "그대로 두기" sends `existingParticipants:
  "keep_present"`; "모두 재입장" sends the legacy `{pin}` body. The
  keep-unavailable dialog ("암호를 바꾸지 못했어요") for a Worker that refuses
  `keep_present`, the removal-reason notices, and the no-silent-rejoin kick
  handling from 8.9.0 are untouched.

### Shared dialog (`src/ui/dialog.ts`)

`showDialog()` replaces 8.9.0's `choiceField` with `choiceStep` (`title`,
`name`, `defaultValue`, `options[{value, label, detail?}]`, `buttonText`,
`backText`). The page swaps in place inside the same dialog: the overlay is
never closed and reopened, so the backdrop and slide-in animation do not
replay. Only the incoming page fades (0.24 s, off under reduced motion).

- Rows: each is a `<label>` holding a native radio and a painted surface. The
  radio stays focusable and announced but transparent; the surface after it
  draws the state. The group is `role="radiogroup"` named by the dialog
  title. Each radio is named by its label span and described by its detail
  span (id references), and the painted surface is `aria-hidden`, so a
  screen reader reads the label and then the detail once, in focus and in
  browse mode.
- Keyboard: Tab reaches the checked option, then 이전, then 확인 (focus trap);
  arrow keys move the choice natively; Enter on an option confirms; Escape
  closes from either page with no change, as the language list closes on
  Escape. A pointer 다음 does not paint a keyboard ring on the checked row
  (the language list's rule for its first focus); the next key restores it.
- Double press: 다음/확인 and 취소/이전 share their buttons, and the taller
  step 2 re-centres under the cursor. For 400 ms after a page swap the dialog
  ignores action presses and pointer clicks on rows, and it ignores repeated
  Enter keydowns. A double click on 다음 therefore stops on step 2 with
  "그대로 두기" still checked.
- Removed: the fieldset/legend group, its CSS, its `#dialog-message-text`
  description wrapper, and `pro.pin_members_legend` in all 42 locales.

### Design (`css/style.css`)

- Rows use the language list's language: end-edge check (the same SVG path),
  `--surface-2` for the chosen row with a `--primary` label and check,
  `--text-sub` detail, 15/750 label and 13/500 detail, 6 px row gap, rows
  aligned with the title edge and the copy inset 22 px like the language
  label. Corner radius is `--radius-m` (20 px), the `.ch-opt` value. No new
  tokens or colors.
- Logical properties put the check on the reading end edge, so it moves left
  in Arabic, Hebrew, Persian and Urdu. Forced colors highlight the chosen row
  with `Highlight` / `HighlightText`.
- Only the list scrolls when a viewport cannot fit both rows; the title and
  the actions stay visible, and the language list's edge fades mark the
  hidden end. At heights up to 480 px a stepped dialog uses the account
  dialog's short-height spacing (12 px overlay inset, tighter header and
  action padding, 48 px buttons, 12 px row padding) on both pages, so the
  title does not jump between them.
- The stepped title and row copy keep Korean words whole (`keep-all`), wrap
  Japanese and Chinese between characters (the existing `ja`/`zh` override
  group), and use `text-wrap: pretty`.
- The rules stay inside the Chromium 79 (legacy TV) CSS subset: no inline
  offsets or uneven inline shorthands, which compile to `:is()` fallbacks.

### Copy

New keys in all 42 locales: `pro.pin_members_title`, `dialog.step_next`
("다음" / "Next") and `dialog.step_back` ("이전" / "Back"). The existing
`common.next` and `common.previous` are the onboarding's "다음으로" / "이전
설명" in Korean, so they were not reused. `pro.pin_members_keep`,
`pro.pin_members_keep_detail`, `pro.pin_members_reenter` and
`pro.pin_members_reenter_detail` carry the owner's text above; every other
locale has its own translation in the register of its existing PIN copy.
`pro.pin_keep_unavailable` is unchanged.

## Release identity and compatibility

- App `8.9.0` to `8.9.1` (a backward-compatible fix to an 8.9.0 feature) in
  `package.json`, both `package-lock.json` product fields, the admin shell
  (`browser/classic-runtime/admin.ts`) and the App Worker admin constant
  (`cloudflare/app-worker.ts`). PWA cache `v651` to `v652` with the
  `index.html` bootstrap query.
- Release target `app`. Against the deployed SHA `d76b1432`,
  `changedRuntimePaths()` from `scripts/release-deployment-state.mts` finds
  no runtime path for `pro-room`, `remote-share`, `signaling`,
  `developer-api-facade` or `developer-api`, and 49 for `app` (42 locale
  files, `css/style.css`, `src/ui/connect.ts`, `src/ui/dialog.ts`,
  `index.html`, `scripts/service-worker-asset.ts`, and the two admin version
  mirrors). `changedAppRuntimeDependencies()` is empty.
- No API, protocol, D1, R2, secret, binding or Durable Object change. Rolling
  the App back to 8.9.0 restores the in-dialog group; requests stay the same,
  so there is no new recovery floor.

## Verification

Tested code: `3b0e8823` on `agent/pro-pin-two-step` (main `23d2f758` plus
`fdb309c6` copy, `f2a8b65a` dialog and flow, `564c6e66` legend removal,
`66714dc0` browser test, `ecdbbcbf` setup motion test, `49304740` legacy CSS
subset, `1ad49af5` browse-mode reading, `3b0e8823` App 8.9.1 / v652). Windows
11, Node 24.13.1, npm 11.8.0, Playwright 1.63.0 Chromium, dependencies from
the main checkout's `node_modules` (Vite 8.3.3, Vitest 5.0.3) through a
junction. All runs are local; none is an exact-main CI candidate.

| Command | Result |
| --- | --- |
| `npm run typecheck`, `tsc -p tsconfig.test.json`, `tsc -p tsconfig.e2e.json` | pass |
| `npm run lint` | pass, zero warnings |
| `npm run format:check` | pass |
| `npx vitest run src/ui src/pro-room src/i18n` | 176 files, 3,591 passed |
| `npm test` | 536 files, 11,352 passed, 0 failed, 1 skipped¹ |
| `npm run test:coverage:critical` | 58 files, 1,958 passed; thresholds met (81.77 / 76.39 / 88.03 / 85.90) |
| `npm run guard:dead-exports` | pass |
| `npm run guard:release-identity` | pass; `8.9.1` / `v652` |
| `npm run guard:sw-cache-version` | pass; `v652` (`3b0e8823`) covers every committed PWA runtime change |
| `guard:bus-pairing`, `import-graph`, `lifecycle-writes`, `brand-capitalization`, `font-assets`, `source-complexity`, `room-authority-boundaries` | pass |
| i18n catalog tests (`translation-catalog`, `translation-community-catalog`, `translation-community`, `locale-recovery-assets`, `apply-translation-suggestions`) | 5 files, 145 passed |
| `npm run build:checked` | pass, including `guard:legacy-tv-build` (Chromium 79) |
| `npm run build:e2e`, then `npx playwright test e2e/pro-entry-password.test.ts e2e/dialog-locale-layout.test.ts --project=chromium` | 12 passed (local Chromium, synthetic PRO API fixture; outside CI by design) |

¹ The `release-deployment-state` shell-plan contract test skips when `jq` is
not installed, as on this machine. It does not exercise this change.

The first `build:checked` failed `guard:legacy-tv-build`: the radio's
`inset-inline-start` and the surface's uneven `padding-inline` compiled to
`:is(:lang(...))` direction fallbacks. `49304740` fixed it without changing
the rendered rows, and a CSS test now rejects those declarations. The first
full `npm test` also failed one pin in `setup-carousel-motion.test.ts`, which
expected the language-list fade rules to name no other selector; `ecdbbcbf`
lets them list the shared choice fades.

New and changed tests: the dialog `choiceStep` suite (page swap, title and
action copy, no subtitle, radiogroup and per-option name and description,
`aria-hidden` surface, end-edge check, invalid PIN stays on step 1, Back
keeps the PIN and the choice, keyboard path, Escape from either page,
double-press and key-repeat guards, focus trap, pointer ring suppression,
teardown on close and abort, default fallback, CSS, CJK wrapping and the
short-height rules), the locale refresh of step 2 and Back, connect's step
options and "nothing is sent" on Escape, Back-then-Cancel and supersession,
the 42-locale step-label and legend-removal checks, and the browser cases in
`e2e/pro-entry-password.test.ts`.

### Screenshots and layout measurements

Captured with Playwright Chromium from the e2e build of `3b0e8823`, signed in
as a PRO owner of a public room (synthetic API fixture), PIN typed as
`1234-5678`. Phone sizes use touch emulation at device scale 2. Files are in
the owner's local scratch folder `scratch/pin-two-step-screens/` (not in the
repository):

- Korean, steps 1 and 2: 390x844 (light and dark), 360x640, 320x568, 844x390,
  740x360, 1280x800.
- Step 2 at 390x844: English, Japanese, Simplified Chinese, Arabic (RTL),
  German.

Every capture, and the extra 320x568 step-2 checks in Russian, Filipino,
Tamil, Hebrew and Traditional Chinese, measured no horizontal overflow in the
panel or the page, a panel inside the viewport with no panel scroll, and both
actions visible and hit-testable at their centre. Step 2 list:

| Viewport (step 2) | Panel height | Rows fully visible | List scroll |
| --- | --- | --- | --- |
| ko 390x844, 360x640 | 389 px | 2 of 2 | none |
| ko 320x568 | 451 px | 2 of 2 | none |
| ko 844x390, 740x360 | 328 px | 2 of 2 | none |
| ko 1280x800 | 370 px | 2 of 2 | none |
| en, de, ja, ar 390x844 | 413–468 px | 2 of 2 | none |
| zh-Hans 390x844, zh-Hant / he 320x568 | 394–495 px | 2 of 2 | none |
| ru 320x568 | 520 px | 1 of 2 | 31 px, bottom fade |
| fil 320x568 | 520 px | 1 of 2 | 88 px, bottom fade |
| ta 320x568 | 520 px | 1 of 2 | 260 px, bottom fade |

The check sat at the row's right edge in every left-to-right capture and at
the left edge in Arabic and Hebrew. Chromium's accessibility tree for step 2
(ko, en, ar) showed the dialog named by the step title with no description,
a radiogroup with the same name, two radios named by their labels and
described by their details, focus on the checked radio, and no duplicate
text nodes.

### Limits

- No real device. Safari and iOS WebKit, the soft keyboard (which shrinks
  the viewport on step 1), and screen readers themselves were not exercised;
  the layout and accessibility evidence is headless Chromium.
- At 320 px the longest translations (Russian, Filipino, Tamil) scroll the
  list; the actions stay visible.
- The blue box around the focused PIN segment in the step 1 captures is the
  app's existing focus-visible ring on text inputs, unchanged here.
- Translations were written for this change without native-speaker review.
- The browser test and the captures use a synthetic API fixture, not a
  production Worker or a real customer room.
- Local Node 24.13.1, not the pinned 24.20.0; PR CI remains the reference.
