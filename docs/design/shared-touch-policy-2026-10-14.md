# Shared app double-tap policy — 2026-10-14

## Scope and evidence

The owner reports iOS 17.6.1 installed PWA viewport displacement by roughly the
keyboard height after room-code entry and double taps on unavailable transport
controls. Both an ordinary guest and an empty/not-ready host were affected;
regular Safari and other operating systems were not reported affected.

Unavailable transport buttons normally use `aria-disabled`, retaining clicks
for feedback. The previous viewport metadata and iOS gesture cancellation did
not express a common double-tap touch policy. This is a confirmed policy gap,
not proof of the exact native WebKit failure. No physical affected device is
available to automation in this Windows environment.

## Change

- Main SPA base reset uses `* { touch-action: manipulation; }` with no new
  `!important`. This covers ordinary controls, SVG descendants and nested native
  scroll surfaces without individual button handlers.
- Native panning stays allowed. More-specific `pan-y` playlist rows and `none`
  sliders, reorder handles and mobile drawer header retain their gesture policy.
  The desktop drawer header's redundant `auto` override is removed so it uses
  the common default.
- Viewport min/max scale and `user-scalable=no`, iOS non-passive
  `gesturestart/change/end` cancellation, and document overscroll lock stay
  unchanged. Manipulation alone allows pinch; it supplements these locks.
- No touch-end interception, synthetic click, polling, focus rewrite, keyboard
  measurement change, or forced scroll reset is introduced. Existing editable
  text selection is retained. Embedded YouTube documents remain outside this
  stylesheet's reach.

WebKit's [documented behavior](https://webkit.org/blog/5610/more-responsive-tapping-on-ios/)
and [double-tap predicate](https://github.com/WebKit/WebKit/commit/1448205ae3fa)
support `manipulation` specifically. Its
[style adjustment](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/style/StyleAdjuster.cpp)
resets effective actions at native scroll boundaries, so this uses a shared
element default instead of relying only on the root. The
[standard](https://www.w3.org/TR/pointerevents3/#the-touch-action-css-property)
preserves ordinary activation and text selection independently of touch-action.

## Validation

Base: `44b60d18af30c98a0c086b223ca202cde575ac95`; runtime change
`21936d3c17deae26f110ff1670f02664b4ff18b8`. Local Windows, Node 24.13.1,
npm 11.8.0, Vitest 5.0.3 and Playwright. Local checks are not the exact-main
CI release candidate.

- Full unit run at `1badd995` (runtime same as `21936d3c`): 562 files,
  12,661 tests passed, 0 fail/skip, 331.54 seconds, `--maxWorkers=4`.
- Typecheck and lint passed; first format check found only the new source-test
  assertion wrapping. Prettier corrected it; full format recheck passed.
- App Worker syntax, Developer API boundaries, D1 migration contract and
  source-only Operations Drift contract passed.
- Independent code review found no blocker. It checked the 2024 WebKit
  action-intersection implementation and preserving `pan-y`/`none` ownership.
- Initial Chromium at `d3cdda11`: 4 pass / 1 fail. The new raw CDP playlist swipe
  began while the native tab View Transition still owned input. Saved trace
  showed the Player snapshot cross-fading beneath Playlist. Hit-test diagnostics
  confirmed `(195, 670)` initially targeted `HTML`, then `DIV.track-item` when
  ready. The test now waits for that observable hit target, not an arbitrary
  longer delay. Corrected new tests: 2 pass (15.8s); actual playlist/chat swipes
  and range drag pass. Existing reorder/scroll and chat-copy/action tests passed.
- Initial Windows WebKit: 2 existing chat tests pass, 2 new tests fail before
  gestures. Both traces explicitly report PeerJS `The current browser does not
  support WebRTC`, followed by host initialization failure and code timeout.
  This is the same platform limit handled by the existing WebKit smoke lane.
  The new WebKit cases use an explicit initialized-app role-state fixture;
  Chromium retains real host/guest room entry. Neither path catches a failure
  and silently falls back. The real authority calculation, click and toast
  handlers remain under test.

Final test code: `4eb1c3fb9412cdd09be5d5098516823c7696621d`. New Chromium
cases: 2/2 pass (15.7s); new WebKit cases: 2/2 pass (14.1s); no skips. Existing
Chromium playlist touch reorder/native scroll (1) and chat copy/nested actions
(2), plus WebKit chat copy/nested actions (2) also passed in their initial
batches. E2E typecheck, focused ESLint and formatting passed after fixture changes.
These are focused browser checks, not a new full serial E2E run.

First failures and traces were retained in local `scratch/touch-policy/` before
reruns. The corrected native-swipe tests retain hit-target diagnostics.
`npm run build:checked` passed at `4eb1c3fb`, including cache-history, release
identity, production security, initial-transfer budget and SW app-shell guards.
Final remote CI and deployment evidence follow the normal release procedure.
GitHub automated Codex review reported a usage limit; the independent local
review above is the review evidence, not a claimed GitHub approval.

The focused browser checks validate touch-policy coverage and available-engine
interaction regressions. They do not reproduce the iOS 17.6.1 native keyboard
or standalone gesture recognizer and must not close the physical-device item.

## Release and recovery

Prepared product `8.10.16`, service-worker cache `v682`, target `app`, Developer
API D1 application `false`. No new dependencies, schema, secret, binding,
protocol, storage, or admission changes. Production deployment is authorized
by the owner; exact-main CI is still required. Existing clients must apply the
normal app update before this CSS takes effect; no forced update is introduced.

Before deployment, capture the workflow's verified live baseline. An app-only
rollback must follow the standard ownership and compatibility checks. A prior
baseline restores the old touch behavior and therefore does not fix the reported
symptom. Release IDs, actual baseline, smoke and final ownership are pending.

## Physical device follow-up

On iOS 17.6.1 installed PWA after the update, enter a room code using the
keyboard, dismiss it, and double tap unavailable Previous/Play/Next as an
ordinary guest and as an empty/not-ready host. Confirm viewport stays in place,
then check playlist/chat swipes, range drag and playlist reorder. Compare an
invite-link entry without keyboard use. If displacement remains, collect
visualViewport scale/offset/page values, root/window scroll and active element
without reopening the keyboard before changing viewport recovery logic.
