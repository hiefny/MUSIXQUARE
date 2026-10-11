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

> **Amendment (App 8.10.0, 2026-10-11).** The owner's third request shipped in
> [Standard-room owner PIN](standard-room-owner-pin-2026-10-11.md), which also
> changes this flow for PRO: step 2 is skipped when no other device is in the
> room (step 1's primary action then reads 확인 and "그대로 두기" is sent), and
> when a skipped step meets a PRO Worker that refuses `keep_present` while the
> owner is still alone, the App retries once with the legacy `{pin}` body
> instead of pointing at a row the owner never saw. The choice group's radio
> name became `room-pin-existing-participants`, shared with Standard rooms.
> The forced-colors limit below (the language list's vanishing active text) is
> fixed there too.

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
  radio stays focusable and announced but transparent, and it covers the
  whole row, so touch exploration, the screen reader's focus outline,
  scroll-into-view and taps all use the row's bounds; the surface under it
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
  step 2 moves them down under the cursor. For 400 ms after a page swap the
  dialog ignores action presses and pointer clicks on rows, and it ignores
  repeated Enter keydowns. A double click on 다음 therefore stops on step 2 with
  "그대로 두기" still checked.
- Position: the panel is centred, so the taller step 2 would re-centre and
  move the title up. The dialog keeps the top edge that step 1 had instead
  (a relative `--dialog-step-offset` on the panel), so the title stays where
  it was and the page grows downwards. Where the viewport is too short for
  that, the panel moves up only as far as it must to stay inside the overlay.
  A resize or locale change re-centres it, and the next swap anchors again.
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
  in Arabic, Hebrew, Persian and Urdu. Rows carry the language rows'
  transparent 1 px border (padding 13 px, 11 px at short heights, so the
  measured heights are unchanged), which forced colors paint as a row
  outline. The chosen row gets a `Highlight` fill and border and a
  `HighlightText` check. Its copy keeps the OS text colors, because Chromium
  paints a `Canvas` backplate behind text in forced colors and
  `HighlightText` on that backplate disappeared (the language list's active
  row still does; see Limits). The QR-only `forced-color-adjust` policy is
  unchanged.
- Only the list scrolls when a viewport cannot fit both rows; the title and
  the actions stay visible, and the language list's edge fades mark the
  hidden end. At heights up to 480 px a stepped dialog uses the account
  dialog's short-height spacing (12 px overlay inset, tighter header and
  action padding, 48 px buttons, 11 px row padding plus the 1 px border) on
  both pages, so the title keeps its offset inside the panel.
- The stepped title and row copy keep Korean words whole (`keep-all`), wrap
  Japanese and Chinese between characters (the existing `ja`/`zh` override
  group), and use `text-wrap: pretty`. The stepped title has line height 1.3
  (the row labels' value), so a wrapped question is set at 26 px per line in
  every script; the font's `normal` was about 41 px per line in Arabic.
- The rules stay inside the Chromium 79 (legacy TV) CSS subset: no logical
  inline offsets or uneven inline shorthands, which compile to `:is()`
  fallbacks. The radio's full-row stretch uses direction-neutral physical
  `top`/`left` with 100 % width and height.

### Copy

New keys in all 42 locales: `pro.pin_members_title`, `dialog.step_next`
("다음" / "Next") and `dialog.step_back` ("이전" / "Back"). The existing
`common.next` and `common.previous` are the onboarding's "다음으로" / "이전
설명" in Korean, so they were not reused. `pro.pin_members_keep`,
`pro.pin_members_keep_detail`, `pro.pin_members_reenter` and
`pro.pin_members_reenter_detail` carry the owner's text above; every other
locale has its own translation in the register of its existing PIN copy.
`pro.pin_keep_unavailable`, the message for a Worker that refuses
`keep_present`, now ends by naming the row it sends the owner to, quoted in
each locale's own label and quote style (ko "…잠시 후 다시 시도하거나 “모두
재입장”을 선택해 주세요.", en "…Try again later, or choose “Everyone
rejoins”."). A test checks that every locale's message contains its
`pro.pin_members_reenter` label.

## Review follow-ups (2026-10-11)

A review of the first version raised six points (two were the same copy
point). All were taken:

| Finding | Change |
| --- | --- |
| Each radio was a 1 px box in the row's corner with `pointer-events: none` while the visible copy was `aria-hidden`, so touch exploration, the screen reader's focus outline and scroll-into-view used that box | The radio covers the row (`top: 0; left: 0; width: 100%; height: 100%`) and is hit-tested itself. Browser test: the point at each row's centre is that row's radio and the radio's box equals the row's. In Russian, Filipino and Urdu at 320x568, ArrowDown now scrolls the second row fully into view |
| The step-2 title had the font's `normal` line height (about 2 in Arabic) | Line height 1.3 on the stepped title; Arabic, Persian and Urdu captured at 390x844 and 320x568 |
| Pressing 다음 re-centred the panel, so the title moved up 29–76 px; the CSS comment and this report said it did not move | The panel keeps step 1's top edge; the title moves 0 px where the viewport has room and as little as possible where it does not (table below). Comments and this report corrected |
| Choice rows had no border, so forced colors drew no row outline, unlike the language rows | Transparent 1 px border with 1 px less padding; the chosen row's border follows `Highlight`. The forced-colors capture also showed the chosen row's `HighlightText` copy vanishing on Chromium's `Canvas` text backplate, fixed as described under Design |
| `pro.pin_keep_unavailable` still described the other option in the 8.9.0 wording | It now quotes the row label in all 42 locales (see Copy) |

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

Tested code: `5f76db04` on `agent/pro-pin-two-step` (main `23d2f758` plus
`fdb309c6` copy, `f2a8b65a` dialog and flow, `564c6e66` legend removal,
`66714dc0` browser test, `ecdbbcbf` setup motion test, `49304740` legacy CSS
subset, `1ad49af5` browse-mode reading, `10d92775` full-row radio, border,
title line height and top-edge anchoring, `e76dad24` forced-colors
readability, `28fcabf3` keep-unavailable copy, `5f76db04` App 8.9.1 / v652).
Windows 11, Node 24.13.1, npm 11.8.0, Playwright 1.63.0 Chromium,
dependencies from the main checkout's `node_modules` (Vite 8.3.3, Vitest
5.0.3) through a junction. All runs are local; none is an exact-main CI
candidate.

| Command | Result |
| --- | --- |
| `npm run typecheck`, `tsc -p tsconfig.test.json`, `tsc -p tsconfig.e2e.json` | pass |
| `npm run lint` | pass, zero warnings |
| `npm run format:check` | pass |
| `npx vitest run src/ui src/pro-room src/i18n` | 176 files, 3,593 passed |
| `npm test` | 536 files, 11,354 passed, 0 failed, 1 skipped¹ |
| `npm run test:coverage:critical` | 58 files, 1,958 passed; thresholds met (81.77 / 76.39 / 88.03 / 85.90) |
| `npm run guard:dead-exports` | pass |
| `npm run guard:release-identity` | pass; `8.9.1` / `v652` |
| `npm run guard:sw-cache-version` | pass; `v652` (`5f76db04`) covers every committed PWA runtime change |
| `guard:bus-pairing`, `import-graph`, `lifecycle-writes`, `brand-capitalization`, `font-assets`, `source-complexity`, `room-authority-boundaries` | pass |
| i18n catalog tests (`translation-catalog`, `translation-community-catalog`, `translation-community`, `locale-recovery-assets`, `apply-translation-suggestions`) | 5 files, 145 passed |
| `npm run build:checked` | pass, including `guard:legacy-tv-build` (Chromium 79) |
| `npm run build:e2e`, then `npx playwright test e2e/pro-entry-password.test.ts e2e/dialog-locale-layout.test.ts --project=chromium` | 12 passed (local Chromium, synthetic PRO API fixture; outside CI by design) |

¹ The `release-deployment-state` shell-plan contract test skips when `jq` is
not installed, as on this machine. It does not exercise this change.

In the review round, a first full `npm test` failed
`contrast-accessibility.test.ts`, which allows `forced-color-adjust: none`
only on the QR artwork; an interim fix had opted the chosen row out. The
committed fix (`e76dad24`) keeps the OS palette instead. The first
`guard:sw-cache-version` run then failed because the review fixes were
newer than the `v652` commit; the unpushed branch was reordered so the
release-identity commit follows them, with an identical final tree.

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
`e2e/pro-entry-password.test.ts`. The review round added: the full-row radio,
border, forced-colors, title line-height and panel-offset CSS pins; a
direct radio click inside the double-press guard; the top-edge anchoring
and clamping with a resize reset and teardown; the keep-unavailable label
check in every locale; and, in the browser, an unchanged title position on
다음 at 390 px and a radio under each row's centre at every tested size.

### Screenshots and layout measurements

Captured with Playwright Chromium from the e2e build of `5f76db04`'s tree,
signed in as a PRO owner of a public room (synthetic API fixture), PIN typed
as `1234-5678`. Phone sizes use touch emulation at device scale 2. Files are
in the owner's local scratch folder `scratch/pin-two-step-screens/` (not in
the repository), regenerated after the review fixes:

- Korean, steps 1 and 2: 390x844 (light and dark), 360x640, 320x568, 844x390,
  740x360, 1280x800; step 2 at 390x844 in forced colors.
- Step 2 at 390x844: English, Japanese, Simplified Chinese, Arabic, Persian,
  Urdu, German; step 2 at 320x568: Arabic, Persian, Urdu.
- The keep-unavailable dialog in Korean at 390x844 (Worker answering 400
  `INVALID_REQUEST`).

Every capture, and the extra 320x568 step-2 checks in Russian, Filipino,
Tamil, Hebrew and Traditional Chinese, measured on both pages no horizontal
overflow in the panel or the page, a panel inside the viewport with no panel
scroll, both actions visible and hit-testable at their centre, and on step 2
a radio under the centre of every fully visible row. The title moved by the
"Title move" column when 다음 was pressed (negative is up; before the review
it moved up 29–76 px at every size):

| Viewport (step 2) | Panel height | Title move | Rows fully visible | List scroll |
| --- | --- | --- | --- | --- |
| ko 390x844, 360x640, dark, forced colors | 391 px | 0 px | 2 of 2 | none |
| ko 1280x800 | 372 px | 0 px | 2 of 2 | none |
| en, de, ar, fa 390x844 | 436 px | 0 px | 2 of 2 | none |
| ja, zh-Hans, ur 390x844 | 391–417 px | 0 px | 2 of 2 | none |
| ko 844x390 | 330 px | −11 px | 2 of 2 | none |
| ko 740x360 | 330 px | −26 px | 2 of 2 | none |
| ko, zh-Hant 320x568 | 455 px | −45 px | 2 of 2 | none |
| fa, he 320x568 | 474–493 px | −51, −70 px | 2 of 2 | none |
| ar 320x568 | 512 px | −101 px | 2 of 2 | none |
| ur 320x568 | 520 px | −52 px | 1 of 2 | 18 px, bottom fade |
| ru 320x568 | 520 px | −52 px | 1 of 2 | 37 px, bottom fade |
| fil 320x568 | 520 px | −52 px | 1 of 2 | 94 px, bottom fade |
| ta 320x568 | 520 px | −28 px | 1 of 2 | 260 px, bottom fade |

Where the title still moves, step 2 is taller than the room below step 1's
top edge, and the panel stops at the overlay inset. Wrapped step-2 titles
measured 26 px per line in every locale, Arabic, Persian and Urdu included.
Row heights matched the first version (for example 89.2 and 108 px for
Korean at 390x844), so the border did not change the layout. The keep-
unavailable dialog had no overflow and no panel scroll at 320x568 in ko, en,
zh-Hans, zh-Hant, ja, th, de, ta, ar and fr.

The check sat at the row's right edge in every left-to-right capture and at
the left edge in Arabic, Persian, Urdu and Hebrew. Chromium's accessibility
tree for step 2 (ko, en, ar) showed the dialog named by the step title with
no description, a radiogroup with the same name, two radios named by their
labels and described by their details, each radio's box equal to its row's,
and focus on the checked radio.

### Limits

- No real device. Safari and iOS WebKit, the soft keyboard (which shrinks
  the viewport on step 1), and screen readers themselves (VoiceOver and
  TalkBack touch exploration included) were not exercised; the layout and
  accessibility evidence is headless Chromium. If closing the keyboard
  resizes the window, step 2 re-centres instead of keeping step 1's edge.
- Forced colors were checked only with Chromium's emulation. The language
  list's active row has the same vanishing-text problem in that emulation;
  it predates this change and is left for a separate fix.
- At 320 px the longest translations (Urdu, Russian, Filipino, Tamil)
  scroll the list; the actions stay visible.
- The blue box around the focused PIN segment in the step 1 captures is the
  app's existing focus-visible ring on text inputs, unchanged here.
- Translations were written for this change without native-speaker review.
- The browser test and the captures use a synthetic API fixture, not a
  production Worker or a real customer room.
- Local Node 24.13.1, not the pinned 24.20.0; PR CI remains the reference.
