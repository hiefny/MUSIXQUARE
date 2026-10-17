# Host QR reveal without the double flicker — 2026-10-17

## Report

The owner reported that on first opening the app and tapping 방 만들기, the
invite QR flickers about twice while it appears.

## Cause

Measured with headless Chromium frame captures (CDP screencast) of the local
dev server. The room code and the QR encoder chunk were delayed to
production-like timings (see Verification). Three things stacked up.

1. **The carousel was hidden before the transition's snapshot.**
   `startHostFlow()` and `startGuestFlow()` scheduled `animateTransition(...)`
   and then set `#ob-slider-area.hidden = true` outside its callback. A View
   Transition captures the outgoing screen at the next frame, so that image
   already lacked the carousel. Its area (the left panel on desktop, the
   middle of the welcome screen on a phone) went black for about two frames,
   and the code screen with the faint placeholder QR faded in from black.
   When the code arrived, the real QR crossfaded over the placeholder. The
   eye saw an empty area, then a faint QR, then the real QR.
2. **Desktop re-parenting.** At min-width 1280px, or in compact landscape, the
   code area's QR stage is mirrored into the left panel. Every `setupShow*()`
   call ran `syncDesktopLeftPanel()`, which moved the mirrored stage back to
   its area and then into the panel again. When the code arrived,
   `setupSetCode()` did this inside its page transition (four `childList`
   moves). Moving a node restarts its CSS animations and cancels its
   transitions: the spinner jumped back to its start, and the QR's own
   0.36 s / 0.48 s crossfade was cancelled when it had already begun.
3. **A late encoder on the first room of a page.** The `qrcode` chunk
   (`browser-B8ehoFP8.js`, 23,491 bytes in 8.11.12) is not in the
   service-worker app shell, and the reveal imported it only after the code
   arrived. On the first room of a page, the code digits changed first and the
   QR faded in one chunk load later. Later rooms in the same page had it
   cached and showed both together.

## Change

- The host and guest flows hide the carousel inside the same
  `animateTransition` callback that hides the welcome area, so the outgoing
  snapshot still shows it and it crossfades into the next screen.
- `syncDesktopLeftPanel()` first finds the visible area. If the panel already
  holds that area's diagram, it leaves it mounted and only copies the header
  again. Moving to another area and leaving the desktop layout work as before.
- `preloadHostInviteQrEncoder()` starts the encoder import on the host tap,
  and again on Retry, alongside the room request. The reveal awaits the same
  load. A failed load is forgotten, so a later reveal starts a new one, and a
  reveal that joined a load that then fails makes one attempt of its own. A
  reveal that still cannot load the encoder reports it as before.
- App 8.11.13 / service-worker cache v714. No dependency, protocol, schema,
  secret, binding, CSP, or copy change.

### Review fix

The Codex review (P2) of `1c17e9c8` found that a code arriving while the
preload was still in flight made the reveal await that same load. If it then
failed, the reveal never loaded the encoder again and the room had no invite
QR, while before the preload the reveal always made its own attempt.
`f8548a9a` gives such a reveal one fresh attempt, with a test that fails
without it. The cache moved to v714 in the same commit, so the committed
runtime stays covered without a force-push.

## Verification

Base `97873950` (main after #384). Tested runtime source: `f8548a9a`, the PR
head runtime after the review fix. Local Windows checks used Node 24.13.1 /
npm 11.8.0. These are local branch results, not the exact-main release
candidate.

On `f8548a9a`, `typecheck`, `typecheck:tests`, and `build:checked` passed.
`build:checked` includes the service-worker cache version (v714 covers every
committed runtime change), legacy TV build (Chromium 79), app-shell (97
assets), and room-authority boundary (84 grandfathered direct reads,
unchanged) guards. The full unit run passed 579 of 579 files and 12,980 of
12,980 tests on `bf6e23f3`, the first runtime revision, where `lint`,
`format:check`, and `guard:dead-exports` also passed. The review fix changed
one module and its test file, and both pass ESLint and Prettier.

### Unit tests

- `src/ui/__tests__/setup-host-recovery.test.ts`: with the transition callback
  held back, the carousel stays visible after the tap and is hidden when the
  callback runs. The encoder preload starts before the room request, and
  again on Retry.
- `src/ui/__tests__/setup-guest-recovery.test.ts`: the same carousel case for
  the guest flow.
- `src/ui/__tests__/setup-desktop-panel.test.ts` (new): on the desktop layout
  the QR stage gets no `childList` move while its code arrives; when the join
  area takes the panel, the stage returns to its place before `#setup-code`;
  leaving the desktop layout returns it and empties the panel.
- `src/ui/__tests__/setup-host-invite.test.ts`: after a failed preload, the
  reveal loads the encoder again and shows the QR; and when the preload fails
  while the reveal is waiting for it, the reveal retries and shows the QR.
- Mutation check: hiding the carousel outside the callback (host, then
  guest), always re-parenting the panel diagram, dropping the preload call,
  and a reveal without its own retry each failed exactly its new test.
  Keeping a failed load failed both retry cases. A case for "one shared load"
  was dropped because the module cache made it pass without the shared load.

### Frame check

Playwright 1.63.0 headless Chromium (CDP screencast frames and a per-frame
sampler of computed opacity and transition progress) on a Vite dev server of
each checkout, dark theme, 1440×900 desktop and 390×844 phone. No room was
opened: a test-only rewrite of the served `src/ui/setup-host.ts` returned a
fake code after a set delay (the code then showed about 60 ms later, with the
flow's own work), and a route delayed the `qrcode` chunk. Two rooms per page,
the second after Back.

| Case | Before (`97873950`) | After |
| --- | --- | --- |
| Tap transition, QR area brightness (carousel → placeholder) | Desktop 26.8 → **18.0** → 44.5; phone 30.7 → **18.0** → 45.5. 18.0 is the empty background. | Never below the carousel level, both layouts, both rooms |
| QR mounted after the code, encoder +100 ms, code 0.4 s, first room | Desktop 127 ms, phone 118 ms | Desktop 5 ms, phone 4 ms |
| Same, code 0.15 s, first room | Desktop 116 ms | Desktop 5 ms |
| Encoder +300 ms, code 0.4 s, first room | Desktop 317 ms | Desktop 4 ms |
| Encoder +300 ms, code 0.15 s, first room (encoder slower than the code) | Not run | Desktop 165 ms, the rest of a load that started at the tap |
| Second room in the page | Desktop 2 ms | 2 ms |
| Desktop stage moves and spinner restarts after the code | 4 moves, 1 restart, in every desktop room | 0 and 0 |

The QR reveal itself is unchanged: the 0.36 s / 0.48 s crossfade from the
placeholder, now also on desktop.

### Browser tests

On a `build:e2e` bundle, `e2e/connection.test.ts` and
`e2e/setup-carousel-autoplay.test.ts` passed 15 of 15 in Chromium. They
include the host code screen with the QR shown and its spinner hidden, and the
carousel returning to the desktop left panel after host and guest Back and
after breakpoint changes.

### Not covered

- Real devices: iPhone Safari and the home-screen PWA, Android Chrome, and
  GPU-composited desktop browsers. WebKit was not run.
- Production signaling timing and the light theme.

## Limits

- When the code arrives within about 0.3 s of the tap, the code's page
  transition still cuts the tap transition short, and the fading carousel
  image disappears at once (seen with a 0.15 s fake code). `animateTransition`
  supersedes a running transition by design, and this change leaves that
  alone. Production room creation also fetches a capability token and
  registers with signaling, so the first room of a page usually takes longer.
  This was not measured in production.
- The encoder still loads on demand. When it takes longer than the room
  request, the QR follows the code by the remaining load time.
- The setup buttons are replaced before the tap snapshot, as before, so they
  switch without a crossfade.
