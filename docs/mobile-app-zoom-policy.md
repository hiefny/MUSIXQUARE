# Mobile application zoom policy

Status: maintained product and audit policy.

MUSIXQUARE's main SPA is a fixed-scale, application-style control surface. It
combines time-sensitive playback controls, seek and volume ranges, playlist
drag/reorder, swipe surfaces, full-height drawers, safe-area positioning, and
an embedded media frame in one coordinated viewport. Browser page zoom changes
that viewport and its hit-testing geometry while the app is running; on the
supported mobile surface this produces a less predictable control experience
rather than useful document reflow.

For that reason, the main app intentionally disables browser pinch and
double-tap page zoom. This is a product decision for the application shell,
not a general recommendation for document-oriented websites. Editorial,
history, event, account-completion, and other standalone document pages are
outside this policy unless they explicitly adopt it.

## Runtime contract

The main app must keep the layers below:

1. `index.html` declares `minimum-scale=1`, `maximum-scale=1`, and
   `user-scalable=no` in its viewport metadata.
2. `src/core/platform.ts` installs non-passive cancellation for iOS
   `gesturestart`, `gesturechange`, and `gestureend` during the one-time app
   bootstrap. This is required because supported Safari/WebView variants do
   not apply viewport scaling restrictions consistently.
3. The app's base reset sets `* { touch-action: manipulation; }` without
   `!important`. This common default suppresses browser double-tap zoom before
   a gesture begins, including unavailable controls and controls inside nested
   scrollers. Native panning stays enabled. More-specific component `pan-y` and
   `none` rules retain slider/drag ownership. **Manipulation alone allows pinch**;
   the unchanged metadata and iOS gesture cancellation still prevent it.
   No per-button cancellation or synthetic click is required. Standalone
   document pages do not load this app stylesheet.

WebKit explicitly uses `manipulation` to suppress double-tap gestures; a bare
`pan-x pan-y` is not an equivalent WebKit workaround. A common element default
also avoids relying on propagation through native scroll boundaries. See
[WebKit tapping behavior](https://webkit.org/blog/5610/more-responsive-tapping-on-ios/)
and its [gesture recognizer predicate](https://github.com/WebKit/WebKit/commit/1448205ae3fa).
The policy does not reach inside an embedded YouTube browsing context or disable
text selection/ordinary control activation. The shared default suppresses
double-tap zoom where it applies; specialized gesture rules remain component-owned.
It does not repair an already-displaced iOS keyboard viewport.

Do not replace this contract with a global `touch-action: none`; that would
also suppress scrolling and application-owned gestures. Do not remove only one
of the layers and assume the remaining layers cover every supported mobile
browser.

The executable contract in
`src/ui/__tests__/app-ux-contract.test.ts` prevents an audit or refactor from
silently restoring page zoom.

## Accessibility boundary

Disabling browser page zoom is an explicit tradeoff. MUSIXQUARE must continue
to preserve semantic labels, screen-reader state, keyboard/focus behavior,
adequate control sizing and contrast, and readable default text. Users who
need whole-screen magnification can use the operating system's magnifier or
display zoom, which magnifies the composed application without changing its
internal viewport geometry.

This policy may be reconsidered if the main experience is redesigned as a
reflowing document, if an in-app large-content mode is introduced, or if
physical-device evidence shows that fixed scaling creates a greater usability
failure than browser zoom. A future accessibility audit must not remove the
lock solely as a generic checklist correction: it needs an explicit product
decision, a replacement interaction design for the controls above, and iOS and
Android device verification.

## History

- The fixed-scale contract existed before 2026-08-10.
- Commit `7478fe9d4fcad906f8e8ee60bf005471594410ff` removed both layers during a
  broad accessibility audit without changing the app's fixed-layout product
  model.
- The policy was explicitly restored on 2026-08-12 after real mobile use
  confirmed that page zoom degraded the application experience.
- On 2026-10-14 the owner requested shared double-tap protection after an
  iOS 17.6.1 installed PWA shifted by a keyboard-sized area following room-code
  entry and double taps on unavailable transport controls. The shared CSS
  default complements the existing locks. Resolution of that exact native PWA
  symptom still requires the affected physical device.
