# In-room update prompt — 2026-10-11

> Released 2026-10-12 as App `8.10.0` / PWA cache `v659` at main `95e9092c`
> ([Release 38165114764](https://github.com/hiefny/MUSIXQUARE/actions/runs/38165114764),
> target `all`) after merging 8.9.6. See the
> [merge, review and production verification](release-8-10-0-merge-review-2026-10-12.md).
> The status below is the pre-merge test record.
> Cache numbers `v656`–`v658` here are branch builds. Production `v656` and
> `v657` were the unrelated 8.9.5 and 8.9.6 releases.

Status: implemented and verified locally on branch
`agent/standard-room-owner-pin` (PR #294) as part of the unreleased App
`8.10.0`, PWA cache `v658` (`v656` for the first version, `v657` for the
[review follow-up](#review-follow-up-2026-10-11), then `v658` for the
[recovery dialog copy](#recovery-dialog-copy-follow-up-2026-10-11); `v656`
and `v657` were never deployed). Not merged or deployed; production remains App
`8.9.0` / `v651` at `d76b1432` ([release record](../release-record.md)). On
its own this is an App-only change; it ships in the 8.10.0 release, whose
target is `all` because of the [Standard-room owner
PIN](standard-room-owner-pin-2026-10-11.md).

## Owner decision (2026-10-11)

The owner is running a large live event. Until now, a waiting service worker
opened the blocking "업데이트 / 새 버전이 준비되었어요. 새로고침하면 업데이트가
적용돼요." dialog ([새로고침] / [나중에]) on any screen, including a host or
guest with music playing, and "나중에" stored a dismissal for that
generation. When another tab accepted the update, a tab in a room got a
toast with the same text. The owner decided:

1. In a room (`network.appRole !== 'idle'`: standard host and guest, and PRO
   rooms, which project that role) and in the demo, no update dialog. Treat
   it as an automatic "나중에" without storing a dismissal, and post a local
   chat system message once per waiting generation per document, never to
   peers. Browser tab: "MUSIXQUARE의 새 버전이 있어요. 페이지를 새로고침하면
   적용돼요." Standalone PWA: "MUSIXQUARE의 새 버전이 있어요. 앱을 다시 열면
   적용돼요." Where the chat is unavailable, use a toast with the same copy,
   never a dialog.
2. Outside rooms (setup screen, create and join flows) the dialog is
   unchanged.
3. Back on the idle setup screen after a room or the demo, a generation that
   is still waiting and not dismissed gets the dialog once, under the
   existing ledger, election, and cooldown rules; not while a leave is in
   progress or a reload is coming anyway.
4. Another tab accepting the update while this tab is in a room or the demo
   posts the same local chat message instead of the toast, deduplicated with
   decision 1 for the same generation.
5. Every existing safeguard stays, and a tab in a room is never auto-reloaded.

### Create and join screens (owner decision 2026-10-11)

Decision 1 defines a room as `network.appRole !== 'idle'`; decision 2 lists
the create and join flows as outside rooms. Tapping Host or Join, and an
invite-link landing, set `appRole` to `host` or `guest` at once
(`startHostFlow`, `startGuestFlow`), so the two decisions disagreed there. The
implementation follows decision 1: the create and join screens get no
dialog, a toast while setup still covers them, and the chat notice once the
room starts. Reason: a host already accepts guests on the code screen before
it taps Start (the `connection` handler checks only the host role), so a
Refresh there would drop them, and an invite-link guest is in the middle of
joining a live event, which a Refresh would restart. The owner confirmed
this behaviour after the review (decision 6 below).

### Owner decisions after the review (2026-10-11)

6. The create and join screens, including an invite-link join, keep the
   toast (then the chat notice once the room starts), not the dialog.
   Since 2026-10-16, a worker that is already waiting when the page opens
   outside a room, including an invite link before Start, is applied without
   the dialog or the toast; see
   [apply a waiting update on reopen](update-apply-on-reopen-2026-10-16.md).
7. The lazy-feature recovery dialog keeps its behaviour: it still opens in a
   room, is not dismissible, and its only action is 새로고침. It gets its own
   copy instead of the update dialog's: "새로고침이 필요해요" / "MUSIXQUARE가
   업데이트되었어요. 정상적으로 사용하려면 새로고침이 필요해요." See the
   [recovery dialog copy follow-up](#recovery-dialog-copy-follow-up-2026-10-11).

## Change

### Policy (`src/sw-register.ts`)

- **Where the dialog is deferred.** `isUpdatePromptDeferred()` is true in a
  room, while `demo.active` or `demo.loading` is set, and while
  `body.mode-demo` is still present during the demo's exit curtain.
  `isRoomSessionActive()` (the module's only `network.appRole` read) counts a
  room while the role is not `idle`, `setup.sessionStarted` is set, or the
  room context has a `roomId`. The role alone is not enough: PRO presence
  re-entry (`reenterAfterDetachedPresence`, after a lock longer than the
  45-second presence TTL or an account detach) projects `idle` for the
  `enterPresence` and `createSignalingTicket` calls while the PRO room UI,
  the started session, and the PRO room context stay up. A real leave
  (`leaveSession()`, or setup's back action) clears all three together.
- **Waiting worker.** The order is unchanged up to the dismissal check:
  cooldown silent activation, generation resolution, same-cache silent
  activation, and a dismissed generation stays quiet (no dialog and no
  notice). Then, in a room or the demo, the worker is recorded as deferred
  and the notice is posted; no dismissal is stored and no cross-tab prompt
  lease is taken. The check repeats after the cross-tab election, which can
  take a few frames.
- **Notice.** `postLocalUpdateNotice()` calls the chat module's existing
  local path, `announceSystemMessageLocally()` (a `chat:system-message`
  row on this device only; it is the same path as the large-track warnings).
  Nothing in `sw-register.ts` can send to peers. The copy is
  `chat.update_available_app_system_message` when `isStandaloneDisplayMode()`
  (iOS `navigator.standalone` or `display-mode: standalone`), otherwise
  `chat.update_available_tab_system_message`. The chat counts as available
  only in a room, with `#chat-messages` in the DOM, and while the setup
  overlay is not active; otherwise (a demo with no room, or setup still
  covering a provisional room while a code is created or a join runs) the
  same copy is a toast.
- **A toast does not use up the chat notice.** A generation shown only as a
  toast is marked so. On the next room-lifecycle signal, once that signal's
  task has finished (setup marks the room started and hides its overlay in
  one task), one chat row is posted if the chat can now be seen; the copy
  names no version, so one row covers every toast-only generation. A toast
  is never repeated, and a generation whose dialog the user answered on
  setup in the meantime is not re-posted.
- **Once per generation per document.** A `Map` in the registration closure
  holds announced identities (chat or toast-only): the exact cache version
  when the worker
  answers the generation protocol, otherwise its script URL (waiting worker)
  or a per-object controller identity. Re-checks, a second worker object for
  the same generation, and another tab activating that generation therefore
  share one notice; a newer generation gets a new one.
- **Open prompt when a room or the demo starts.** A room-lifecycle signal
  (`subscribeRoomAuthorityLifecycle`, plus `state:demo.active` and
  `state:demo.loading`) aborts an open or queued idle prompt through its
  `AbortSignal`, posts the notice at once (a queued dialog resolves only
  when it is dequeued), and records the deferral without a dismissal.
- **Another tab accepted.** `handlePassiveControllerChange()` now defers in a
  room or the demo (it previously checked only the role, so a demo tab with
  no room, or a PRO tab during presence re-entry, could auto-reload) and
  posts the same notice instead of the `dialog.sw_update_msg` toast. Idle
  tabs still reload, aligned to `controllerchange`.
- **Back on setup.** Most leave paths (the Leave buttons, Back, kicks)
  navigate to `/`, and the new idle document's existing boot check shows the
  dialog for the still-waiting generation. For an in-place return to idle
  (role, started session, and room context all cleared), the lifecycle
  signal arms a native 1-second timer (`leaveSession()` clears
  managed timers). When it fires it re-arms while `isSessionResetPending()`
  or `body.mode-demo` holds, drops the deferral if a reload is already
  scheduled or another prompt is open, and otherwise runs the normal waiting
  worker path again, so cooldown, generation checks, the dismissal ledger,
  and the cross-tab election all still decide. After the dialog, "나중에" is
  a real dismissal and the generation is not offered again.
- **Unchanged.** The setup-screen dialog's copy and buttons, the generation
  resolver, cooldown and same-cache silent activation, controller-aligned
  reloads, the pre-v268 legacy completion reload, legacy-tab election, and
  pagehide/reload reservations. An explicit 새로고침 approval still reloads
  after `controllerchange`.

### Copy (42 locales)

| Key | Korean (owner's text) | English |
| --- | --- | --- |
| `chat.update_available_tab_system_message` | MUSIXQUARE의 새 버전이 있어요. 페이지를 새로고침하면 적용돼요. | A new version of MUSIXQUARE is available. Refresh the page to apply it. |
| `chat.update_available_app_system_message` | MUSIXQUARE의 새 버전이 있어요. 앱을 다시 열면 적용돼요. | A new version of MUSIXQUARE is available. Reopen the app to apply it. |

Every locale keeps `MUSIXQUARE` exact and follows its existing register
(for example `du` in German, `tú` in Spanish, `vous` in French, `sen` in
Turkish). Where the local words for "app" and "apply" share a root (Arabic,
Bulgarian, Greek, Spanish, French, Brazilian Portuguese, Tamil, Ukrainian,
Chinese), the sentence says "to use it" or "it takes effect" instead.
Not reviewed by native speakers.

### Guards and release identity

- `guard:room-authority-boundaries`: the one grandfathered `appRole` read in
  `sw-register.ts` moved from `handlePassiveControllerChange` into
  `isRoomSessionActive()`; the count stays 1 and the manifest records the
  new use site (an `if` since the review follow-up).
- `guard:dead-exports`: the exact self-only baseline drops 79 → 78 because
  `isStandaloneDisplayMode` now has a production consumer.
- PWA cache `v655` → `v656` and the `index.html` bootstrap query; App stays
  `8.10.0`. The review follow-up changed `sw-register.ts` and two locales
  after that bump, so `guard:sw-cache-version` required `v657` (`c56ce268`).
  The release-record 8.10.0 item counts 66 App runtime paths against
  `d76b1432` (adds `src/sw-register.ts`); the follow-up adds no new path.
  The [recovery dialog copy
  follow-up](#recovery-dialog-copy-follow-up-2026-10-11) moves the cache to
  `v658` and the count to 67.

## Review follow-up (2026-10-11)

A review of the first version (`2759fcb2`) found six issues:

| Finding | Result |
| --- | --- |
| PRO presence re-entry projects `appRole` `idle` while the room stays up, so the deferred retry could open the dialog in the room and another tab's activation could reload it | Fixed in `75c75ac8`: a room also counts while the session is started or a room context is set. Unit tests for each condition and for another tab's activation during re-entry |
| The lazy-feature recovery dialog in `src/app.ts` reuses the update dialog's title and message, is not dismissible, and can open in a room | Behaviour not changed: it is needed, because the feature cannot load without a reload. The owner then kept the behaviour and gave it its own copy ([decision 7](#owner-decisions-after-the-review-2026-10-11), [follow-up](#recovery-dialog-copy-follow-up-2026-10-11)) |
| The docs said the create and join screens keep the dialog, but they are `host`/`guest` by role and get a toast, which also used up the chat notice | Docs corrected; the toast no longer uses up the chat notice (`75c75ac8`); the owner then confirmed the toast on these screens ([decision 6](#owner-decisions-after-the-review-2026-10-11)) |
| Urdu notices began with the Latin brand, so `dir="auto"` laid them out left to right | Fixed in `37e31cac` (both begin with "اب", "now"); the factual contract now requires RTL notices to open with RTL script |
| Russian wrote "применить ее" | Fixed in `37e31cac` ("её") |
| The README still named the owner PIN release `v655` | Corrected |


## Rollout limit: the first deployment

The new behavior runs in the client. Devices still running older code
(production `v651` or earlier; `v656` and `v657` were never deployed) see the
`v658` update through their old code: the blocking dialog on any screen,
including in a room, and the old toast when another tab accepts. Only updates
after `v658` follow the new policy on devices that already run `v658`.
**Deploy this change outside a live event.**

## Verification

Tested code: `c56ce268` on `agent/standard-room-owner-pin` (`c9042ffc` copy,
`d0e84ade` policy and tests, `bb61cbc6` cache `v656`, `2759fcb2` docs, then
the review follow-up: `75c75ac8` policy and tests, `37e31cac` copy,
`c56ce268` cache `v657`; the docs commit follows). The first version was
verified the same way at `bb61cbc6` (11,498 unit tests passed then).
Windows 11, Node 24.13.1, npm 11.8.0, Vitest 5.0.3, Playwright 1.63.0
Chromium, dependencies through the main checkout's `node_modules` junction.
All runs are local; none is an exact-main CI candidate. The later recovery
dialog copy follow-up (cache `v658`) has its own
[verification](#follow-up-verification) at `441b88fa`.

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | pass, zero warnings |
| `npm run format:check` | pass |
| `npx vitest run` sw-register (unit and recovery integration), sw-update coordination and completion, `src/chat`, `src/i18n` | 40 files, 625 passed |
| `npm test` | 538 files, 11,504 passed, 0 failed, 1 skipped¹ |
| `npm run test:coverage:critical` | 58 files, 1,995 passed; thresholds met (81.84 / 76.50 / 88.07 / 85.95) |
| `guard:release-identity` | pass; `8.10.0` / `v657` |
| `guard:sw-cache-version` | pass; `v657` (`c56ce268`) covers every committed PWA runtime change |
| `guard:service-worker`, `brand-capitalization` (771 sources), `dead-exports`, `bus-pairing` (198/198), `import-graph`, `room-authority-boundaries`, `source-complexity` | pass |
| `npm run build:checked` | pass, including `guard:legacy-tv-build` (Chromium 79), `initial-transfer-budget`, and `sw-app-shell` |
| Chromium browser probe (below) | 1 passed (`build:e2e`, local PeerJS server; outside CI) |

¹ The `release-deployment-state` shell-plan contract test skips when `jq` is
not installed, as on this machine. It does not exercise this change.

New and changed tests (`src/core/__tests__/sw-register.test.ts`, 19 new
cases in "in-room update notice"): a waiting worker in a host or guest room
posts one local chat notice with no dialog, toast, peer message, dismissal,
prompt lease, `SKIP_WAITING`, or reset; the demo with no room falls back to
a toast; a room running the demo uses the chat; setup covering a
provisional room uses a toast; the idle setup screen keeps the dialog with
its copy and buttons; browser-tab and home-screen copy for both the chat and
the toast; one notice across a same-generation re-check and another tab
activating that generation, then a second notice for a newer generation; a
dismissed generation stays quiet in a room; another tab's activation posts a
chat notice instead of the toast and does not reload; a demo tab with no
room is not auto-reloaded; leaving a room offers the dialog once after the
settle, and a later lifecycle change after "나중에" does not offer it again;
no dialog while a leave/reset is pending, then one once it is not; no dialog
until the demo curtain is gone; an open idle prompt is retracted without a
dismissal when a room starts and is offered again on leaving; and a source
check that `sw-register.ts` imports only `announceSystemMessageLocally` from
the chat module and no send or broadcast API. Five existing cases were
updated: the converging-activation case now starts its prompt on the idle
screen and joins a room while it is open (one notice, no dismissal); the
approved-update and Refresh-during-activation cases prompt on the idle
screen; two toast assertions use the new copy. The factual i18n contract
covers both keys in 42 locales. The recovery integration test mocks the new
chat and platform imports.

Review follow-up tests (7 new cases replacing 1, so 25 in "in-room update
notice"): PRO presence re-entry with the role `idle` while the session is
started, the PRO room context is set, or both, offers no dialog or toast after the settle and
through re-entry, then the dialog once after a real leave; another tab's
activation during re-entry posts the chat notice with no reset or reload;
setup covering a provisional host or guest room uses one toast, adds nothing
on a lifecycle change while it still covers the room, then posts one chat
notice once the room starts (no second toast, no dismissal); and a
toast-only generation whose dialog the user answered on setup is not posted
again when the room starts. Each new case was checked to fail with its fix
removed. The state mocks in both sw-register test files are now key-aware,
so an unrelated state key no longer reads as the role. The factual contract
now requires the RTL locales' notices to open with RTL script (it fails on
the old Urdu copy).

### Browser probe

A temporary Playwright spec (not committed; archived as
`scratch/update-prompt-screens/capture.tmp.test.ts` in the main checkout)
ran against `npm run build:e2e` with the local PeerJS server, first at
`bb61cbc6` and again at `c56ce268`: a Chromium host at 390x844, `ko-KR`,
light theme, started a Standard room; the spec then changed `CACHE_VERSION`
in `dist/service-worker.js` to the next generation on disk (`v657` to `v658`
in the second run; restored afterwards) and called `registration.update()`. The worker
installed and waited; the chat had exactly one system row with the tab copy
and no dialog opened (log: "Update waiting in a room or the demo. Posting a
local notice"). A second update check left one row. Leaving through
Connect → Leave → 확인 navigated to `/`, where the update dialog ("업데이트",
"새 버전이 준비되었어요. 새로고침하면 업데이트가 적용돼요.") appeared once with
the worker still waiting. Screenshots (outside the repository):
`scratch/update-prompt-screens/ko-390x844-light-01-host-chat-notice.png`,
`ko-390x844-light-01b-chat-drawer.png`, and
`ko-390x844-light-02-after-leave-dialog.png`, with `run-log.json`.

### Limits

- No real-device check on iPhone Safari (tab and home-screen PWA), Android,
  or desktop; it is open in the [release record](../release-record.md).
  The home-screen copy and the guest, PRO, and demo cases are covered by unit
  tests only; the browser probe covered a Chromium tab hosting a Standard
  room.
- Like other local system rows, the notice does not change the chat preview
  text or unread badge. It is seen when the chat is opened.
- A generation dismissed with "나중에" in the last 24 hours (30 minutes for an
  unidentified worker) stays quiet in rooms.
- If another tab accepts the update while this tab is in a room, this tab
  keeps its old page until its next load. Leaving through the normal Leave
  control loads the new version; an in-place return to setup shows no dialog
  because no worker is waiting any more.
- The pre-v268 legacy completion path (a reload navigation within 30 seconds
  of an already approved update, without the controller-confirmed marker)
  still completes that approved reload, as before.
- The create and join screens, including an invite-link join, are a
  provisional room by role (`appRole` `host` or `guest` from the moment
  Host or Join is tapped), so they get a toast instead of the dialog, then
  the chat notice once the room starts. Decision 2 had listed them as keeping
  the dialog; the owner confirmed the toast ([decision
  6](#owner-decisions-after-the-review-2026-10-11)).
- Owner-approved exception: when a room-time lazy feature fails to load
  (Connect on entering a room, announcements, the room session, or PRO
  setup), the lazy-feature recovery dialog in `src/app.ts` still opens in the
  room, is not dismissible, and its only button reloads the device out of the
  room, because the feature cannot load without a reload. Since the [copy
  follow-up](#recovery-dialog-copy-follow-up-2026-10-11) it no longer borrows
  the update dialog's title and message ([decision
  7](#owner-decisions-after-the-review-2026-10-11)).
- PRO presence re-entry and the toast-to-chat follow-up are covered by unit
  tests only.
- No native-speaker review of the 41 translated locales.

## Recovery dialog copy follow-up (2026-10-11)

After the review, the owner made [decisions 6 and
7](#owner-decisions-after-the-review-2026-10-11): the create and join screens
keep the toast (no code change), and the lazy-feature recovery dialog keeps
its behaviour but gets its own copy.

### Follow-up change

- **Copy (42 locales).** New keys `dialog.feature_refresh_title` and
  `dialog.feature_refresh_msg`. Korean is the owner's text; English is
  "Refresh needed" / "MUSIXQUARE has been updated. Refresh to keep using it
  normally." The message names no single feature: it says the app was
  updated and needs a refresh to keep working normally. Every locale keeps
  `MUSIXQUARE` exact (once, in the message) and its existing register. The
  Arabic, Persian, Hebrew, and Urdu texts open with RTL script (Urdu with
  "اب", as in the in-room notice), so `dir="auto"` keeps them right to left.
  `dialog.sw_update_*` and the in-room chat notice are unchanged. Not
  reviewed by native speakers.
- **Dialog (`src/app.ts`).** `runLazyFeatureRecovery` shows the new keys
  instead of `dialog.sw_update_title` / `dialog.sw_update_msg`. Behaviour is
  unchanged: it still opens in a room, `dismissible: false`, one button
  (`common.refresh`), no abort signal, and the same reload, decline, and
  stale-document handling.
- **Release identity.** PWA cache `v657` to `v658` with the `index.html`
  bootstrap query, as the last runtime commit; App stays `8.10.0`. The
  release-record 8.10.0 item now counts 67 App runtime paths against
  `d76b1432` (adds `src/app.ts`).

| Key | Korean (owner's text) | English |
| --- | --- | --- |
| `dialog.feature_refresh_title` | 새로고침이 필요해요 | Refresh needed |
| `dialog.feature_refresh_msg` | MUSIXQUARE가 업데이트되었어요. 정상적으로 사용하려면 새로고침이 필요해요. | MUSIXQUARE has been updated. Refresh to keep using it normally. |

### Follow-up tests

- `src/i18n/__tests__/factual-translation-contracts.test.ts`, one new case
  over both keys in 42 locales: plain text with no placeholders, markup,
  digits, or line breaks; the brand exactly once in the message and not in
  the title; different from the update dialog's title and message; RTL
  locales open with RTL script; no English copy outside English; the
  Korean and English copy pinned; the Korean update dialog copy unchanged.
- `src/ui/__tests__/app-ux-contract.test.ts`: the recovery dialog uses the
  two new keys, `common.refresh`, and `dismissible: false`, names no
  `dialog.sw_update_` key, and has no second button, abort signal, or room
  check that could hide or retract it in a room.

### Follow-up verification

Tested code: `441b88fa` on `agent/standard-room-owner-pin` (`314fc548` copy
and contract, `1334953f` dialog and contract, `441b88fa` cache `v658`; the
docs commit follows). Same machine and tool versions as above (Windows 11,
Node 24.13.1, npm 11.8.0, Vitest 5.0.3, main checkout's `node_modules`
junction). All runs are local; none is an exact-main CI candidate.

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | pass, zero warnings |
| `npm run format:check` | pass |
| `npx vitest run` app UX contract, reload-recovery latch, room-session feature loader, PRO setup runtime boundary and failure, sw-register (unit and recovery integration), sw-update coordination and completion, `src/i18n` | 36 files, 544 passed |
| `npm test` | 538 files, 11,505 passed, 0 failed, 1 skipped (the same `jq`-dependent shell-plan contract test) |
| `guard:release-identity` | pass; `8.10.0` / `v658` |
| `guard:sw-cache-version` | pass; `v658` (`441b88fa`) covers every committed PWA runtime change |
| `guard:brand-capitalization` | pass (771 sources) |
| `guard:dead-exports` | pass |
| `npm run build:checked` | pass, including `guard:legacy-tv-build` (Chromium 79), `service-worker` at `v658`, `initial-transfer-budget`, and `sw-app-shell` |

### Follow-up limits

- Not run for this follow-up: `test:coverage:critical`, the Chromium browser
  probe, and real devices. The recovery dialog only appears when a lazily
  loaded chunk fails to load, so its copy is covered by the unit contracts
  above, not seen in a browser.
- No native-speaker review of the 41 translated locales.
