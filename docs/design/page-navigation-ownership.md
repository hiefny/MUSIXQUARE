# Page navigation ownership

| Field              | Value                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Maintained contract                                                                                                                                                          |
| Applies to         | Every navigation of the app's own document: reloads, home and room returns, the logo reset, the confirmed Back leave, the back-forward cache return, the unload prompt       |
| Owner              | `src/core/session-reset.ts` (registry RO-23), with the PRO claim fence in `src/core/document-reload.ts`                                                                      |
| Executable sources | `scripts/check-navigation-sinks.mts` (`npm run guard:navigation-sinks`, run in CI), `src/core/__tests__/page-navigation-owner.integration.test.ts` and the tests named below |
| Related documents  | [Resource ownership registry](resource-ownership-registry.md) (RO-22, RO-23, RO-24, RO-30), [Back closes the top window](back-closes-top-window-2026-10-17.md)               |

The page has one navigation owner. It holds the page behind the reset screen,
runs the navigation, decides whether the navigation committed, and makes the
page interactive again when it did not. Requesters choose the reason (the
message on the reset screen), the URL and the moment; they never call a
`location` sink, post `SKIP_WAITING` or traverse history themselves. Phase 2
of the 2026-10-22 structural plan (increments C6-1 to C6-14) built this owner;
the owner decisions it relies on were made on 2026-10-23.

## The owner and its state

`session-reset.ts` keeps one `PageNavigationState`:

| Phase        | Meaning                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `idle`       | Nothing holds the page.                                                                                             |
| `painting`   | The reset screen is up and the page is locked; the request waits for two frames or `RESET_PAINT_FALLBACK_MS`.       |
| `preparing`  | The request's optional prepare step runs, bounded by `NAVIGATION_PREPARE_TIMEOUT_MS`.                               |
| `navigating` | The final navigation call ran; `NAVIGATION_COMMIT_TIMEOUT_MS` is running.                                           |
| `left`       | `pagehide` was seen: the navigation committed. Only a `pageshow` or a visible return of this same document ends it. |

Every way an attempt ends while this document stays alive goes through one
`settle()`, at most once per attempt and exactly once if the document survives.
The outcome is typed: `recovered` (the commit deadline passed, the old page
returned, or the requester was no longer current) or `failed` (the navigation
call threw). A committed navigation never settles. `settle()` runs in this
order: release the page (focus restore, the window layer re-derives, the
overlay hides), report idle and release the unload exemption, give a reload's
claim back to the PRO fence, start the next queued reload, run the attempt's
`onSettled` callbacks, then send `onNavigationPendingChange`.

## Requests

- `scheduleSessionReset(message, action)` or `scheduleSessionReset(message, {
prepare?(signal), navigate, isCurrent? })`. The first request in a document
  wins; a request while any navigation holds the page returns `null`.
  - `prepare` (owner decision 2): a bounded step before the navigation. The
    owner navigates when it settles, rejects or passes its window; the signal
    aborts when the window closes or the attempt settles, so a late step stops
    and a settled attempt never navigates.
  - `isCurrent`: asked right before the final navigation call; `false` settles
    the attempt as recovered without navigating.
- `scheduleDocumentReload(message, onRecovered?)`: a reload through the queue
  and the PRO claim fence.
- The intents in `src/core/navigation.ts`: `navigateHome(message, { history })`
  (replace; push for the setup-guest Back buttons, owner decision 6) and
  `returnToRoomStart(code, …)` (the `/CODE` return, which checks the six-digit
  code at its sink and writes the reconnect marker).

The requesters, each with its count and reason, are listed in the
navigation-sink guard: the confirmed Back leave and the lazy-feature reload in
`app.ts`, the logo reset, the PRO terminal recovery, the update reload, setup's
reconnect and recovery paths, the keep-open notice and the lost-session
dialog's Restart and Go back reloads.

## Busy rule (owner decisions 1 and 13)

A reload asked for while another navigation holds the page, while another
reload runs, or behind a reload whose navigation call threw waits in one FIFO
queue and runs if that navigation settles in this document; it never runs after
a navigation commits. A waiting reload with the same message joins the one
already waiting, so one reload answers both. A reload asked for while one with
the same message runs waits behind it. A direct reset asked for while the page
is held is refused. A deferred PRO claim fence (an outcome-unknown claim
mutation in flight) holds reloads; leave navigations never enter the fence.

A back-forward cache return that makes its own bounded reload drops every
reload still waiting (owner decision 13): that reload refreshes the page
anyway, so a reload queued behind a navigation that committed, or behind the
PRO claim fence, cannot run ahead of it and make two. The return decides
whether it reloads before it settles anything, takes the whole queue, then
settles the returned reset, and its bounded reload is the page's one reload.
Each dropped caller's `onRecovered` runs once, after that reload holds the
page or, while a deferred PRO claim fence holds reloads, after it waits first
in the queue behind the fence, so a caller that asks again waits behind it.
A reload that already started is not dropped: on the visible-first order the
visible return starts the first waiting reload before the `pageshow`, which
then settles it, so its callers hear while the page is idle and one that asks
again runs ahead of the bounded reload; so does a reload a settled callback of
the returned attempt asks for. The page still reloads once when the first of
them commits. A caller that throws, or a failing log of the drop, is logged
and the rest still run, and the callers are answered even if the return's own
work throws.
A return that reloads nothing (outside a room with nothing pending, or the
second return of a document that used its one reload) drops nothing and
settles only the attempt the document returned with (`left`). Current Chromium
and WebKit make the document visible before the persisted `pageshow`, and that
visible return settles the returned attempt and starts the waiting reload
first; the `pageshow` leaves that reload running. So a reload waiting at a
second return runs once whichever event comes first, and one requested reload
still makes one.

## Timing contract

All timings live in `src/core/navigation-contract.ts`, a dependency-free
module; `navigation-contract.test.ts` pins their order.

| Constant                        | Value  | Contract                                                                                                                                                                                                                                        |
| ------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESET_PAINT_FALLBACK_MS`       | 120 ms | The request runs after two frames, or this when frames are suspended.                                                                                                                                                                           |
| `NAVIGATION_PREPARE_TIMEOUT_MS` | 2.5 s  | The prepare window. It covers the hard reset's 1.5 s activation wait (`ACTIVATION_TIMEOUT_MS` in the lazy `sw-hard-reset.ts`) plus 1 s for its chunk and the update machine's answer. An Apply already in flight is waited for until it closes. |
| `NAVIGATION_COMMIT_TIMEOUT_MS`  | 2 s    | Starts at the final navigation call (owner decision 2). No `pagehide` within it means the navigation did not commit, and the page is made interactive again.                                                                                    |
| `LEAVE_FALLBACK_MS`             | 1 s    | The Back leave's fallback home navigation; it runs inside the commit window.                                                                                                                                                                    |

The logo reset is a prepare/navigate request: prepare loads the hard-reset
chunk and, unless aborted, applies a waiting update; navigate goes home. A slow
chunk or promotion no longer recovers the page silently at 2 s from the tap;
the logo reaches home after the prepare window at the latest.

Since Phase 3 C6-10 (owner decisions P3-8 A to P3-12 A, 2026-10-24) the hard
reset asks the update machine (registry RO-22) instead of promoting on its own.
It dispatches `HARD_RESET_CLAIM_EVENT` on the page's service-worker container
and the machine answers at once:

| Answer            | When                                                                                                                                  | The hard reset then                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `promoted`        | A worker is waiting and the page's loads are quiet                                                                                    | Waits up to 1.5 s for the new controller. The machine sent `SKIP_WAITING` through its sink, recorded the request and withdrew any prompt. |
| `apply-in-flight` | An Apply already sent `SKIP_WAITING`                                                                                                  | Waits for that activation until the prepare window closes, sending nothing.                                                               |
| `none`            | No waiting worker, or a resource of the page (other than the hard reset's own chunk, loaded for the tap) finished within the last 1 s | Goes home at once; the next page offers the update with the usual dialog.                                                                 |
| `unavailable`     | No machine yet (before the window load event, a failed registration)                                                                  | Promotes on its own: `SKIP_WAITING` to the waiting worker, then waits up to 1.5 s.                                                        |

The request carries whether the page's loads are quiet. The hard reset measures
it with a copy of the machine's 1 s quiet window, leaving out its own chunk, and
the machine decides with that reading; a request without it counts as a page
still loading (Phase 3 R2 moved the measurement into the lazy chunk to keep the
eager bundle under the reserve line).

"Update applied" is left for the next document only when this document saw the
new controller. When the machine's own promotion times out, the hard reset
TEMPORARILY promotes on its own too (owner decision P3-12 A); that use goes in a
later Phase 3 release after two clean production update cycles. The prepare
signal ends every wait and every send. Later lasts for its page only, so the
logo applies an update put off with Later.

## The update machine while a navigation holds the page

A controller change that reaches `sw-register.ts` while any navigation holds
the page (the logo's own activation, a Back leave, a PRO terminal recovery) is
decided only if that navigation releases the page in this document (Phase 3
C6-10, owner decision P3-8 A). The machine reads `isSessionResetPending` and
waits for `onNavigationPendingChange`: no update dialog under the reset screen
and no second reload request while the navigation runs; afterwards a room is
asked once, a page outside a room makes its aligned reload, and an Apply in
flight makes its reload (a guest's `/CODE` return). If the navigation commits,
nothing more happens in this document. The update reload itself keeps its own
state (`reload-scheduled`), so a controller change during it waits for that
reload's recovery as before.

## Page transitions (one dispatch)

`initPageNavigation({ getRole, bfcacheReloadMessage, log })`, wired once in
`app.ts` (the first attempt installs it too), holds the only page-transition
listeners for navigation recovery, in the capture phase, so they run before the
Back guard's resume whatever the init order:

- `pagehide`: the attempt committed (`left`).
- `pageshow`: `revealLiveShell` first. A back-forward cache return of an
  active session, or of a pending reset, settles the reset and makes one
  bounded reload, dropping every reload still queued first (owner decision
  13); a document that returns again after that reload keeps the recovered
  shell instead of looping, drops nothing and settles only a `left` attempt,
  so a reload queued behind the bounded one runs once on every event order.
  Any other `pageshow` settles a `left` attempt.
- `visibilitychange` to visible: settles a `left` attempt (iOS can foreground
  the old document without a `pageshow`).

`page-lifecycle.ts` keeps `beforeunload`, the `pagehide` session cleanup and
`revealLiveShell`.

## Unload exemption (owner decision 3)

`beforeunload` asks to confirm while a session runs and no unload-exemption
claim is live. `claimUnloadExemption(reason)` returns that claim's release;
claims are independent. The owner claims when an attempt's action starts and
releases at settle; the same-tab Google login in `src/ui/account.ts` holds its
own claim with a 10-minute bound. A reset that recovers therefore never ends a
pending login's exemption, and a reload waiting behind the PRO claim fence does
not suppress the leave prompt while it waits.

## Top surface (owner decision 4)

The reset screen stays on top of every window. The modal stack in
`src/ui/dom.ts` never locks it; a dialog that opens while a navigation is
pending sits underneath, inert, and focus stays on the reset screen. When the
navigation settles, the window layer re-derives and the dialog becomes the top
window. While an element fills the screen in the browser's fullscreen top
layer (`fullscreenSurfaceHost()` in `dom.ts`), the reset moves its overlay
inside it and locks the page around it, follows fullscreen changes, and moves
the overlay back when it settles; it never requests or exits fullscreen.

## Back guard (owner decision 5)

A Back taken while a navigation holds the page is absorbed. When that
navigation settles in this document, `onNavigationPendingChange` re-arms the
guard (`app.ts` subscribes `handleStateChange`), so the next Back closes a
window or asks to leave again. The event is sent only when the live pending
state changed, at the end of `settle()`: a reload the queue starts there keeps
the guard unarmed until it settles too. A confirmed leave keeps its own
recovery wiring.

## Navigation sinks (owner decision 7)

`npm run guard:navigation-sinks` (`scripts/check-navigation-sinks.mts`, run in
CI) keeps, with exact counts and reasons:

1. `location` navigation (reload, replace, assign and writes) per function: the
   owner's reload, the three intents in `navigation.ts`, the login popup window
   in `account.ts`, and the locale navigation in
   `src/i18n/localized-app-document.ts`. The locale navigation stays outside
   the owner by owner decision 7: it is the fail-safe full-document switch to a
   localized entry when the History API cannot rewrite the path, it never
   claims the unload exemption, and a live session still asks before leaving.
2. `SKIP_WAITING` per function: the update machine's one sink,
   `activateWaitingWorker` in `src/sw-register.ts` (Phase 3 C6-9), and the
   hard reset's own promotion, `promoteWithoutTheUpdateMachine` in
   `src/core/sw-hard-reset.ts` (since Phase 3 C6-10 only without a machine and,
   temporarily, after the machine's promotion timed out). The calls of that
   sink are counted per function too: four, Apply and Apply to a replacement
   in `handleWaitingWorker`, the quiet promotions in `activateWhenQuiet`, and
   the logo port in `claimForHardReset`. A function a `let` takes later is
   named after that `let`.
3. History traversal per function: the Back leave in `back-button-history.ts`
   and the guard's `navigateBack` port in `app.ts`.
4. The requesters of `scheduleSessionReset` and `scheduleDocumentReload`, per
   file.
5. The `claimUnloadExemption` callers, per file.
6. Retired names stay gone: `restoreSessionReset`, `requestDocumentReload`,
   `DocumentReloadAttempt`, the intentional-navigation flag functions,
   `setSessionResetReleaseHandler`, the old test seams, and the update reload
   latch `_swReloading` / `_swReloadAttempt` (Phase 3 C6-9).

Out of scope: anchors and forms that navigate on activation, `window.open`,
`location` reads, and receivers resolved only by type. The resource-ownership
guard keeps its per-file counts of the same sinks.

## Review rule

A new navigation, reload or service-worker promotion uses
`scheduleSessionReset`, `scheduleDocumentReload`, an intent in `navigation.ts`
or the update machine's port. It never posts `SKIP_WAITING`, never calls a
`location` sink and never traverses history itself; a new requester is added
to the guard's list with its reason and to RO-23 in the same change.

## Tests

- `src/core/__tests__/page-navigation-owner.integration.test.ts`: the real
  owner, fence, page lifecycle, modal stack and Back guard wired as `app.ts`
  wires them, with recorded sinks; each pin is labelled with the increment
  and owner decision that kept or flipped it.
- `src/core/__tests__/session-reset.test.ts`: settlement in every event order,
  prepare/navigate requests, `onNavigationPendingChange`.
- `src/core/__tests__/page-lifecycle.test.ts`: unload-exemption claims and the
  back-forward cache return through `initPageNavigation`.
- `src/core/__tests__/navigation-contract.test.ts`: timing order and the
  next-document marker keys.
- `src/core/__tests__/navigation-sinks-guard.test.ts`: the guard.
- `src/core/__tests__/sw-update-transitions.integration.test.ts` and
  `sw-register.test.ts`: the update machine (RO-22) on the real owner, with
  every `SKIP_WAITING` send and the listed exits of its update reload in a
  table (commit deadline, throwing reload sink, a returned or visible
  document, commit, back-forward cache return, successors, a refused `/CODE`
  return, and a reload queued behind a navigation that recovers or commits),
  including events that arrive while the reload is still pending, and the
  logo port's answers and the decisions put off behind a navigation (C6-10).
  Two exits have no row of their own: a fallback reload held behind the PRO
  claim fence and a throwing `/CODE` href sink. They go through the same owner
  queue and recovery callback as rows X10a/X10b and X2, by reading, not by a
  test.
- `src/core/__tests__/sw-hard-reset.test.ts`: the hard reset's side of the
  port, its own promotion and the prepare signal.
- `e2e/back-navigation.test.ts` (CI critical gate) for the Back flows in a
  browser. jsdom and Chromium under Playwright have no real back-forward cache,
  so the bfcache paths rest on these jsdom pins and device checks.

Device checks for this owner: iOS back-forward cache return, standalone-PWA
Back, the Google login from a room in an installed PWA, the logo reset with a
waiting update on a throttled network, and a reset during a fullscreen video.
