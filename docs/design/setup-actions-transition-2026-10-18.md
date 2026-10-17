# Setup buttons swapped inside the screen transition — 2026-10-18

## Report

Since the phone setup screens center their middle block (8.11.15–8.11.16,
[report](setup-mobile-visible-centering-2026-10-18.md)), the owner saw the
block jump when the first screen's two buttons gave way to the one-row
actions of 방 만들기: at the moment of the change the block dropped, then the
screens crossfaded. The owner suggested an empty space that eases away. After
comparing transition frames, the owner chose to swap the buttons inside the
transition and asked to deploy it (2026-10-18).

## Cause

The setup screens change through one View Transition: the browser captures
the outgoing screen, runs the update, and crossfades the two. The area swap
ran inside the update, but the action buttons were re-rendered right after
the transition was scheduled, before the capture. The outgoing snapshot
therefore already held the new buttons. On phones, where auto margins center
the middle block between the header and the actions, the old block
re-centered for the shorter actions (36px lower on the way in, 36px higher on
the way back), and the buttons changed without the crossfade. It is the same
kind of problem as the carousel hidden before the capture in 8.11.13
([report](setup-qr-reveal-2026-10-17.md)).

Three renders change the actions from two stacked buttons to one row, or
back:

- First screen → 방 만들기: back and 잠시만요… (`proceedToHostCode`).
- First screen → 방 참여하기: back and 시작하기 (`proceedToGuestCode`).
- Back to the first screen: 방 만들기 and 방 참여하기 (`showHostGuestSelection`).

## Change

- `setupRenderActionsInTransition(buttons, layout, onRendered)` in
  `src/ui/setup-shared.ts` renders through `animateTransition`, so it joins
  the area swap's transition. A render counter lets a later immediate render
  (the room code arriving turns 잠시만요… into 시작하기) win over one still
  waiting. `onRendered` runs once the new buttons exist; the guest start gate
  now binds there.
- The three renders above use it. Renders that keep the screen's one-row
  layout (retry, errors, the code arriving) stay immediate.
- Without View Transitions, and on the first paint, which runs without them,
  the buttons render at once as before.
- App 8.11.18 / service-worker cache v720. Nothing else changed.

## Verification

Base `799a95c9` (main after #394). Tested runtime source: `15ff96d8` (the fix
`f0c18406` plus the version bump). Local Windows checks used Node 24.13.1 /
npm 11.8.0. These are local branch results, not the exact-main release
candidate.

### Transition frames

Playwright 1.63.0 headless Chromium on a Vite dev server of the worktree,
390×844, device scale 2, dark theme, CDP screencast, and a test-only fake
room code so no signaling room opens. The table gives the middle block's
first visible row (the icon circle, or the QR / scanner on the way back) in
the frames before the crossfade takes over:

| Flow | 8.11.17 | Fixed |
| --- | --- | --- |
| First screen → 방 만들기 | 258px, then 294px from the first transition frame (+71 ms) | 258px |
| 방 만들기 → back | 244px (the QR's own row is 280px) | 280px |
| First screen → 방 참여하기 | 258px, then 294px | 258px |
| 방 참여하기 → back | 236px (the scanner's own row is 272px) | 272px |

In 8.11.17 the buttons changed in the first transition frame. Now they
crossfade with the rest of the screen, and the incoming block fades in at its
own centered position. The two-column layout (tablets, phone landscape,
desktop) does not center against the actions, but its buttons now crossfade
too.

### Checks

On `15ff96d8`, `typecheck` (which includes `typecheck:tests`), `lint`,
`format:check`, and `build:checked` passed. `build:checked` includes the
service-worker cache version (v720 covers every committed runtime change),
legacy TV build (Chromium 79), and app-shell (97 assets) guards. The full
unit run passed 583 of 583 files and 13,047 of 13,047 tests. On a
`build:e2e` bundle, `e2e/connection.test.ts`,
`e2e/setup-carousel-autoplay.test.ts`, and `e2e/back-navigation.test.ts`
passed 25 of 25 in Chromium. The frame table above was measured again on
`15ff96d8`.

`src/ui/__tests__/setup-actions-transition.test.ts` drives the real
`animateTransition` with a stand-in `startViewTransition`: the outgoing
capture keeps the old buttons and both changes share one transition, a later
immediate render wins over a waiting one, and without View Transitions the
render is immediate. The host, guest, and back-to-first-screen flow tests
check that the actions change only when the queued transition runs; reverting
any of the three call sites to an immediate render fails its test. The four
test files that mock `setup-shared.ts` gained the new helper.

### Not covered

- Real devices. iOS Safari before 18 has no View Transitions, so it swaps the
  screen in one frame as before.
- The invite-link start screen, which appears on the first paint without a
  transition.

## Limits

- A room code that arrives within about 0.3 s of the tap still supersedes the
  tap transition, as recorded for 8.11.13.

## Release and recovery

The owner approved the deploy on 2026-10-18 once CI and the review passed.
PR #395 was squash-merged as `06e2664538177e5ce2ff5c9b831aad6572dca37f` after
PR CI 39066988568 (11 jobs) passed on head `13135c3f`; the Codex review
finished with no findings. Exact-main push CI 39067630261 attempt 1 passed
all 11 jobs: unit 583 files / 13,046 pass / 0 fail / 1 skip (a Windows-only
path check on Linux), candidate browser 17 and critical browser 55 pass.

Production Release 39068051083 attempt 1 (target `app`, Developer API D1
disabled) deployed the exact-main candidate, artifact 12113672398 (Node
24.20.0 / npm 11.19.0 / Wrangler 4.148.0):

- Recovery checkpoint captured at 05:46:10.462 KST (artifact 12114405146). It
  preserves App 8.11.17/v719, `ee9cd197`, version `cec75670` / deployment
  `1757c1ac`. The worker floor was ready at 05:46:13.022 KST (release floor
  `d9364cd9`, generation floor `4c5612d5`).
- Partial-release recheck compatible at 05:46:35.949 KST. The five
  unselected Workers kept their `d9364cd9` provenance and IDs.
- App version `8c72ce0e-4500-4a9f-9433-dec671458490` / deployment
  `fc8c0c4f-6d19-4606-9000-7c29c839beb0`, verified by the final ownership
  check at 05:47:04.607 KST, with the exact-SHA coherent marker recorded.
- Operational smokes 4/4: App generation (`main-Cm7Rj9xb.js` converged over
  three reads), anonymous App account boundary, PRO public boundary, and
  Standard HTTPS signaling. The seven App D1 baseline steps verified. The
  deploy job completed at 05:47:10 KST. No rollback was needed, and the
  recovery job was skipped.

Public assets at 05:47:48 KST matched the candidate byte for byte (HTTP 200,
same size and SHA-256):

| Path | Bytes |
| --- | --- |
| `/` | 140,676 |
| `/service-worker.js` (v720) | 39,149 |
| `/bootstrap.js?cache=v720` | 10,196 |
| `/assets/main-Cm7Rj9xb.js` (holds this change) | 437,646 |
| `/assets/main-8_J0N3SU.css` | 324,945 |

Operations Drift Audit 39068239551 attempt 1 on `06e26645`:
automated-checks-passed, 31 pass / 0 fail / 5 manual-only.

Rolling back to the checkpoint restores 8.11.17, whose setup buttons change
before the outgoing capture, so the phone middle block jumps 36px at the
first transition frame. No stored data or wire contract changed. A rollback
re-verifies ownership and the floors as the procedure requires.

Real devices and the full serial E2E suite were not run after the deploy.
The device check stays open in the release record.
