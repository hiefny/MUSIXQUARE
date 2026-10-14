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

Base: `44b60d18af30c98a0c086b223ca202cde575ac95`. Tested code SHA and completed
checks are recorded below after execution. Local checks are not the exact-main
CI release candidate.

Pending: local required checks, focused browser gestures, independent review,
PR CI and exact-main CI.

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
