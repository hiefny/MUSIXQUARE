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

Deployed 2026-10-14 15:46:50 KST: product `8.10.16`, service-worker cache `v682`,
target `app`, Developer API D1 application `false`. No new dependencies, schema,
secret, binding, protocol, storage, admission or recovery-floor changes.

- Code PR [#334](https://github.com/hiefny/MUSIXQUARE/pull/334), final PR
  [CI 38522571598](https://github.com/hiefny/MUSIXQUARE/actions/runs/38522571598)
  succeeded. Merge/deployed SHA `244866b8e8c13fd6285f0586ca89d5ac248dafd5`.
- Exact-main [CI 38523313737](https://github.com/hiefny/MUSIXQUARE/actions/runs/38523313737)
  succeeded before dispatch: 11 jobs; unit 12,660 pass / 1 platform skip;
  candidate browser 17 and critical browser 29 pass; all coverage/static/build
  gates green. The Linux skip is the Windows-only cross-drive artifact-path
  rejection test in `pro-grant-campaign-cli.test.ts`; it passed locally.
- [Production Release 38523982016](https://github.com/hiefny/MUSIXQUARE/actions/runs/38523982016)
  attempt 1 succeeded. Immutable exact-main artifact; app generation, anonymous
  account boundary, PRO public boundary and Standard HTTPS signaling smoke all
  passed. Unselected Worker smokes were scope skips, not pass claims.
- App version `b00ff5b4-3e1c-43b7-a672-d3beb95ef623`, deployment
  `8d63ceda-3a63-476d-a6a6-9175ca253aea`, 100% ownership verified at
  15:46:43.441 KST; coherent-production marker matches exact SHA and app target.
  Five unselected Workers retain `d9364cd9`; compatibility recheck completed
  15:46:17.088 KST with all five compatible.
- Recovery checkpoint completed 15:45:38.757 KST: previous App `19f1d27b`
  (8.10.15/v681), version `c22ff67d-ce85-4e45-b879-e45133be11b8`, deployment
  `87ae8fff-3a04-4b98-9b76-319c84c927e1`. No rollback needed; recovery job skipped
  on success. Restoring this compatible baseline restores the old touch policy;
  it is not a fix for the report. Ownership/floor checks remain required and this
  checkpoint is not a user-data backup.
- Public read at 15:47:27 KST: `/`, entry CSS and `service-worker.js` HTTP 200;
  bootstrap/SW `v682`, `/assets/main-NXj9qV7n.css` includes the shared
  `box-sizing:border-box;touch-action:manipulation;` reset.
- Post-release [Operations Drift 38524300563](https://github.com/hiefny/MUSIXQUARE/actions/runs/38524300563)
  succeeded, report 15:48:00.186 KST: 31 pass / 0 fail / 5 manual-only.

Existing clients must apply the normal app update before this CSS takes effect;
no forced update is introduced. An already-open physical iOS PWA update and the
reported keyboard displacement remain manual verification, not inferred from
the public asset read or Linux candidate Service Worker checks. Release record
and history are updated in a documentation-only follow-up; that PR does not
trigger an additional production release.

## Physical device follow-up

On iOS 17.6.1 installed PWA after the update, enter a room code using the
keyboard, dismiss it, and double tap unavailable Previous/Play/Next as an
ordinary guest and as an empty/not-ready host. Confirm viewport stays in place,
then check playlist/chat swipes, range drag and playlist reorder. Compare an
invite-link entry without keyboard use. If displacement remains, collect
visualViewport scale/offset/page values, root/window scroll and active element
without reopening the keyboard before changing viewport recovery logic.
