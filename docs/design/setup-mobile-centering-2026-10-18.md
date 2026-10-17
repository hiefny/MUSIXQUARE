# Phone portrait setup with a centered middle block — 2026-10-18

## Report

The owner described the three phone portrait setup screens as three blocks
each: the header (a), the middle block (b), and the actions (c).

| Screen | a | b | c |
| --- | --- | --- | --- |
| First screen | 안녕하세요 / 방을 만들거나 참여해 주세요 | The carousel (초대와 공유, ...) | 방 만들기, 방 참여하기 |
| 방 만들기 | 시작해볼까요? / 이제 다른 기기들과 연결해 주세요 | The invite QR and the room code | Back, 시작하기 |
| 방 참여하기 | The same header | The QR scanner and the code field | Back, 시작하기 |

a and b sat together at the top and c sat far below. The owner asked for b to
sit in the middle between a and c, sharing the space equally, while the space
above a and below c stays as it is.

## Cause

Each setup area fills the height between the top of the setup view and the
actions, and its children stacked from the top: the header with its 56px
bottom margin, then the middle block. All the free space was left between b
and the actions. On the first screen, the carousel block also grew to fill
that space (`flex: 1`), but its slides are top-aligned, so its content still
sat right below the header.

## Change

In the responsive layer, for `(max-width: 719px) and (orientation: portrait)`:

- 방 만들기 and 방 참여하기: the QR stage (or the QR scanner) gets
  `margin-top: auto`, and the code block below it gets `margin-bottom: auto`
  with `padding-bottom: 40px` (was 20px). The two auto margins split the free
  space equally.
- First screen: the carousel block no longer grows (`flex: none`) and gets
  `margin-block: auto` with `padding-bottom: 36px`.
- The bottom paddings make the minimum gap below b match the one above it.
  Above b there is the header's 56px margin (plus the carousel viewport's 4px
  top margin on the first screen); below it the actions add 16px of top
  padding, and the carousel's nav row adds an 8px bottom margin. So 40px =
  56 − 16 and 36px = 56 + 4 − 8 − 16. When the content does not fit, the auto
  margins resolve to zero and the area scrolls as before.
- The rules sit in the responsive layer because the carousel's `flex: 1` is in
  the components layer, which outranks any base-layer rule whatever its
  specificity. The first attempt, in the base layer's phone portrait block,
  centered the two code screens but left the first screen unchanged.
- Unchanged: the header's top (48px into the setup view), the actions'
  positions, the invite-link Start screen (it has no middle block), and the
  tablet (720–1279px portrait), landscape, and desktop layouts.
- App 8.11.15 / service-worker cache v717. No dependency, protocol, schema,
  secret, binding, CSP, or copy change.

## Verification

Base `256f1f92` (main after #388). Tested runtime source: `bc384b20`. Local
Windows checks used Node 24.13.1 / npm 11.8.0. These are local branch
results, not the exact-main release candidate.

On `bc384b20`, `typecheck`, `typecheck:tests`, `lint`, `format:check`, and
`build:checked` passed. `build:checked` includes the service-worker cache
version (v717 covers every committed runtime change), legacy TV build
(Chromium 79), and app-shell (97 assets) guards. The full unit run passed 581
of 581 files and 13,038 of 13,038 tests.

### Layout measurement

Playwright 1.63.0 headless Chromium on a Vite dev server of the worktree, dark
theme, device scale 2, reduced motion (the carousel holds its first slide). No
room was opened: a test-only rewrite of the served `src/ui/setup-host.ts`
returned a fixed code. The gaps run from the header text's bottom to b's top,
and from b's visible bottom (the carousel's dots, or the code field) to the
first button's top. "Before" is the same worktree with the change removed.

| Phone | First screen before | First screen after | Code screens before | Code screens after |
| --- | --- | --- | --- | --- |
| 390×844 | 60 / 247 | 153.5 / 153.5 | 56 / 257.8 | 156.9 / 156.9 |
| 375×667 | 60 / 70 | 65 / 65 | 56 / 89.2 | 72.6 / 72.6 |
| 360×780 | 60 / 160.6 | 110.3 / 110.3 | 56 / 210.6 | 133.3 / 133.3 |
| 430×932 | 60 / 335 | 197.5 / 197.5 | 56 / 323.4 | 189.7 / 189.7 |

방 만들기 and 방 참여하기 measure the same. The header's top and bottom (48 and
108.8px) and the buttons' positions are the same before and after on every
phone.

- 320×568 (the smallest): the content is taller than the screen before and
  after, the auto margins are zero, and the same positions result. The area
  scrolls as before, with 20px (code screens) or 36px (first screen) more
  room at the end of the scroll.
- 768×1024 tablet portrait, 844×390 phone landscape, and 1440×900 desktop:
  the same numbers with and without the change. A 3px difference on the
  tablet's first screen against the separate local checkout also appears in
  this worktree without the change, so it comes from that checkout's
  installed packages, not this change.

### Tests

- `src/ui/__tests__/setup-mobile-centering.test.ts` (new): the three rules sit
  in a phone portrait block of the responsive layer, and the four gaps the
  paddings are derived from (the header's 56px, the actions' 16px top padding,
  the carousel viewport's 4px margin, and the nav row's 8px bottom margin) are
  still in place. Moving the rules back to the base layer, where the first
  screen did not change in the browser, fails the first case.
- On a `build:e2e` bundle, `e2e/connection.test.ts` and
  `e2e/setup-carousel-autoplay.test.ts` passed 15 of 15 in Chromium. They
  include the host code screen and the carousel returning to its place after
  host and guest Back and after breakpoint changes between 1440px and 390px.

### Not covered

- Real devices: iPhone Safari and the home-screen PWA, and Android Chrome,
  with their real address bars and safe areas.
- The light theme (the layout does not depend on it) and other locales, whose
  headers can wrap to more lines.

## Limits

- When an inline error appears under the code field, the centered block grows
  and moves up by half the error's height. Before, the error only extended
  downward.
- On 방 참여하기, a keyboard that shrinks the layout viewport shrinks both gaps
  equally. When it leaves no free space, the block returns to sit below the
  header, as before.
