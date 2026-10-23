# Back closes the topmost window — 2026-10-17

## Request

The owner asked how the Back button and the Back gesture behave on the media
source screen ("재생할 미디어를 선택해주세요"), the demo, the screensaver, and
other windows such as the language list. A read-only review found:

- The only `popstate` handler was the session guard. No window closed on
  Back.
- In a room, Back opened the leave confirmation ("세션 나가기") above any
  separate window. With a common dialog already open, the confirmation queued
  behind it, so Back seemed to do nothing until that dialog was answered.
- Outside a room, Back left MUSIXQUARE with any window still open.
- A rare gap: while a PRO room re-enters presence (for example after the
  phone was locked for more than 45 s), its projected role is `idle` for about
  two network round trips. A Back in that moment consumed the guard entry
  with no dialog, so the next Back could leave the page.

The owner decided (2026-10-17) that Back closes only the topmost window,
everywhere including outside rooms. Only with no window open does Back ask
before leaving a room, or move to the previous page outside one. The owner
also asked to fix the PRO re-entry gap.

## Change

### History

`core/back-button-guard.ts` keeps one guard history entry while a session runs
or a window is open; outside a room, opening the first window pushes it. Back
pops that entry, and then:

1. The topmost window gets the Back. If it uses it (closing, stepping back, or
   staying open on purpose), the guard is pushed again only when a session
   still runs or another window is still open.
2. With no window to take it, a session re-pushes the guard and shows the
   leave confirmation, as before. Confirming still leaves the session and pops
   two entries.
3. Outside a room with no window, the Back belongs to the page. When the last
   window closed another way (its button, Escape, a backdrop tap), its guard
   entry stays behind; the next Back finds no window and continues to the
   previous page with `history.back()`, so no Back is lost.

While a reset is already navigating the document away, Back is not answered.
A confirmed leave re-pushes the guard through its own recovery wiring, so its
two-entry Back still lands on the page before MUSIXQUARE.

Changed 2026-10-23 (owner decision 5 of Phase 2, structural plan step C6-12):
this text first said that only a confirmed leave re-pushes the guard. Now the
guard also re-arms when any app navigation that absorbed a Back settles in
this document instead of leaving (its commit deadline passes, the old page
returns, or a stale request restores the page), from the navigation owner's
`onNavigationPendingChange` in `core/session-reset.ts`. Before, one Back after
such a recovery could leave a live room without the leave confirmation, and a
window that opened during the reset was out of Back's reach. A reload that
takes the page right after the recovery keeps the guard unarmed until it
settles too.

The session check is `isGuardedSession`: a started session whose role is not
`idle`, or whose room context still has a room ID. A PRO room re-entering
presence therefore stays guarded, and its Back shows the leave confirmation.

### Windows

`ui/dom.ts` decides the topmost window from the existing modal stack: a
centred dialog above any fullscreen layer, then the newest fullscreen layer,
then a fullscreen video, then the chat sheet. The setup screens are the page
itself outside a room, not a window. Each window's owner registers what Back
does with `onWindowBack`; a layer inside a window (the demo's settings
disclosure) gets the first chance. A window whose handler does not use the
Back passes it on, and a handler that throws still uses it, so a failing
window never lets Back leave the page.

| Window | Back |
| --- | --- |
| Common dialogs (`showDialog`): confirmations, notices, prompts | Closes it as `back`, a cancel. No button's action or activation hook runs; callers that check `ok` treat it as declined. On a two-page dialog's second page it returns to the first page. The leave confirmation closes as Stay. |
| Update prompt | Same as Later (the 24-hour dismissal), not a failed presentation. |
| "오디오가 잠시 멈췄어요" (audio recovery) | Stays open (`closeOnBack: false`): only its tap can restart the audio. |
| Language, account, administrator permissions, manual sync, connection recovery, onboarding diagnostics | Closes, as Escape or the close button does. |
| Media source, YouTube link | Closes. |
| Screensaver | Closes. On Android in fullscreen the browser still spends the first Back on leaving fullscreen, which already closes it. |
| Demo | An open settings disclosure collapses first. Then the host, or a guest with room control, ends the demo as its exit button does (for the whole room). A guest who cannot end it gets the leave confirmation, so Back never traps them behind the demo. |
| Fullscreen video (YouTube) | Leaves fullscreen, natively or the iOS shell. Android already spends the first Back on leaving native fullscreen; desktop browsers and the iOS shell now do the same. |
| Chat on phones and tablets (modal sheet) | Closes. The desktop side panel is part of the page. |

Not windows, unchanged: toasts, loaders, the session-reset screen, the iOS
YouTube tap-to-play shield, the developer `/debug` overlays (Escape and tap
still close them), playlist selection, and the setup steps themselves.

App 8.11.9 / service-worker cache v708. App only; Developer API D1 stays
disabled. There are no new dependencies, protocols, schema, secrets,
bindings, permissions, CSP, or copy changes.

## Verification

Base `45720acc` (main after #376). Tested runtime source: `3e84b384`. Local
Windows checks used Node 24.13.1 / npm 11.8.0. These are local branch
results, not the exact-main release candidate.

On `3e84b384`, `format:check`, `lint`, `typecheck`, and `build:checked`
passed. `build:checked` includes the room-authority boundary (the two reviewed
`app.ts` fingerprints updated), service-worker cache version (v708 covers
every committed runtime change), legacy TV build, and app-shell (97 assets)
guards. The bus-pairing, import-graph, lifecycle-writes, dead-exports
(self-only bindings stay at the baseline of 78), chunk-pump, standard-room
hot-path, Developer API boundary, D1 migration, and operations drift contract
guards also passed. The full unit run passed 575 files / 12,898 tests, with
zero failures or skips.

The first `build:checked` run, on `8d6389d5`, failed in the legacy TV build
guard: "main-Dg5EftL5.js contains unpolyfilled .at(". The match was
`{...at(r),queueItemId:e}`, a spread of a function the minifier had named
`at`, not an `Array.prototype.at` call; the new code had shifted the
minifier's names. The guard (`scripts/check-legacy-tv-build.mts`) now skips a
method pattern whose dot is the last dot of a spread, through
`findUnpolyfilledRuntimeCall`, and `legacy-tv-compatibility.test.ts` pins a
real `.at(`, `?.at(`, a spread of a real `.at(`, the minified spread, and the
other patterns. The built output then passed the guard. The earlier unit run
on `8d6389d5` had passed 575 files / 12,897 tests.

### Unit tests

- `src/core/__tests__/back-button-guard.test.ts`: the five existing cases keep
  their behaviour through the new dependencies. New cases cover one window
  closing per Back in a room before the leave confirmation, a window outside
  a room (guarded while open, and its closing Back ends there), a re-seed while
  another window stays open, a Back carried on after a window closed another
  way, a required window that stays open, one guard decision when a window
  closes during its own Back, a Back the top window does not use, and a
  pending reset (Back unanswered; a confirmed leave still re-seeds).
  `isGuardedSession` covers the PRO re-entry projection.
- `src/ui/__tests__/window-back.test.ts` (new): the setup screens are not a
  window; only the top window gets Back (a dialog above a fullscreen layer);
  an inner layer gets the first chance; an unused Back passes on; a throwing
  handler still uses it; the chat drawer counts only as a modal sheet; a
  fullscreen video counts, below a dialog above it; an aborted handler stops;
  the stack change listener runs until unsubscribed.
- `src/ui/__tests__/dialog.test.ts`: Back closes a confirmation as `back`
  without either activation hook, closes a one-button notice that Escape
  keeps, keeps a `closeOnBack: false` dialog, and steps back from a choice
  page before closing with the input kept.
- `src/demo/__tests__/mode-back.test.ts` (new): the host ends the demo; a guest
  with room control asks the host; a guest without it passes Back on (no
  request, no toast); the exit curtain holds Back only while it runs.

### Browser check

Local Vite dev server on `8d6389d5` (runtime source identical to
`3e84b384`), in the Claude desktop app's built-in Chromium browser at a
1024×768 viewport (narrow enough that chat is a modal sheet), using the
development PeerJS signaling. Back was the browser's history Back.

Outside a room:

1. Language list open → Back closed it; the start screen stayed and no new
   guard entry was added.
2. Language list closed with its Done button → one Back went to the previous
   page.

In a room, as host:

3. The first-run demo prompt → Back closed it as Later (its toast appeared),
   still in the room.
4. No window → Back opened "세션 나가기"; Back on it closed it as Stay.
5. The media source screen → Back closed it and focus returned to its
   button. The YouTube link screen → Back closed it.
6. Demo: the settings disclosure → Back folded it; the next Back ended the
   demo, still in the room.
7. Chat sheet → Back closed it. The screensaver, opened from chat over the
   sheet → Back closed the screensaver, the next Back the sheet, the next
   Back opened "세션 나가기", and "나가기" went to the page before
   MUSIXQUARE.

No Back-related console warning appeared. The local dev server has no `/api`
backend, so its 503 responses are expected and unrelated.

### Not covered

- Real devices: the Android system Back (Chrome and the installed app),
  predictive Back, and iPhone Safari's swipe. The browser check used desktop
  Chromium history Back.
- The account, administrator permissions, manual sync, connection recovery,
  and onboarding diagnostics windows, the audio recovery dialog, the update
  prompt, and a fullscreen video were checked by unit tests and diff, not in
  the browser.
- A PRO room and its re-entry (no local PRO backend), and a guest device.
- The `app.ts` wiring has no unit test (the bootstrap cannot be imported);
  the browser check exercised it.
- E2E was not run.

## Limits

- A Back pressed while a window is still animating closed (for example the
  media source fade) is used by that closing window.
- Chrome may skip a guard entry pushed before the user has interacted with
  the page at all (its history-manipulation intervention), for example a
  dialog shown on load. Back then leaves the page, as it did before.
- Android's predictive Back and Safari's swipe show a picture of the page
  under the guard entry while the gesture runs; the window closes when the
  gesture completes.
- A Back during a PRO re-entry now shows the leave confirmation; the
  re-entry itself is unchanged.

## Release and recovery

The owner approved the 8.11.9 production deploy on 2026-10-17 together with
the change. PR #377 was squash-merged as
`5cbfaadf709c25bd66f9bf45e23e532e0955ca09` after PR CI 38962941387 (11 jobs)
passed on head `1b16f9c2`; the Codex review had no findings. Exact-main push
CI 38977359502 attempt 1 passed all 11 jobs: unit 575 files / 12,897 pass / 0
fail / 1 skip (a Windows-only path check on Linux), candidate browser 17 and
critical browser 45 pass.

Production Release 38978044549 attempt 1 (target `app`, Developer API D1
disabled) succeeded. Its deploy job finished at 07:51:53 KST.

- App version `c9afffa3-34b8-4d7e-aee7-66b96da95622` / deployment
  `537f7c48-0aa0-4321-b50f-8bab3a142e40`, message
  `git:5cbfaadf709c25bd66f9bf45e23e532e0955ca09`. Final ownership was
  verified at 07:51:49.306 KST. The partial-release compatibility recheck was
  compatible at 07:51:13.616 KST, and the five unselected Workers stayed on
  `d9364cd94ef036c5202ebf20cf5fff0b68d8cacf`.
- The seven existing App D1 baseline steps applied and verified
  idempotently. The Developer API D1 and other target-specific steps were
  skipped.
- Smokes passed: App generation converged on `/assets/main-Dg5EftL5.js`
  (3 consecutive reads, 29 assets), the anonymous account boundary, the PRO
  public boundary on the existing `8d5d44c0`, and Standard HTTPS signaling
  (host and guest admission, offer and answer relay).
- Artifacts: deployments 12079986563, coherent marker 12080141370, and
  recovery checkpoint 12079642927.

Public assets at 07:52:34–36 KST: `/` (140,676 bytes),
`/service-worker.js` (39,149 bytes, `CACHE_VERSION = "v708"`),
`/bootstrap.js?cache=v708` (10,196 bytes), the entry
`/assets/main-Dg5EftL5.js` (435,676 bytes), and
`/assets/system-audio-profile-eMKgmVHb.js` (12,691 bytes, the shared chunk
that holds the window Back code) all returned 200. Each matched the
exact-main candidate artifact byte for byte (SHA-256).

Operations Drift Audit 38978419041 on `5cbfaadf` reported
automated-checks-passed: 31 pass / 0 fail / 5 manual-only (report at
07:54:07 KST).

Not verified after the deploy: Back on a real device (the Android system
Back in Chrome and the installed app, predictive Back, iPhone Safari's
swipe), a PRO room, and a guest device. Open tabs pick up 8.11.9 through the
update path recorded in [the reopen report](update-apply-on-reopen-2026-10-16.md),
so the new behaviour reaches a device only after it loads the new page code.

No rollback was needed, and the independent recovery job was skipped.
Checkpoint
`production-recovery-checkpoint-5cbfaadf709c25bd66f9bf45e23e532e0955ca09-38978044549-1`,
captured at 07:50:44.478 KST, keeps the previous App
`e0d717314c496feed645ed9c0c7848ffdc85472d` (8.11.8/v707), version
`1257c8a7-24cd-494f-9ef6-17b21c4fe0ac` / deployment
`6de2f7cb-71c6-4075-a625-2feaeeb2fff6`. The floors captured at
07:50:47.196 KST were ready, with release floor `d9364cd9`, generation floor
`4c5612d5`, and the generation and entitlement floors true. The retained App
is a verified release ancestor.

A normal authorized rollback to 8.11.8/v707 restores the previous behaviour:
Back does not close windows (in a room it opens "세션 나가기" above them;
outside a room it leaves the page with them open), and a Back during a PRO
re-entry consumes the guard silently. No stored data or wire contract
changes.
