# In-room update prompt — 2026-10-11

Status: implemented and verified locally on branch
`agent/standard-room-owner-pin` (PR #294) as part of the unreleased App
`8.10.0`, PWA cache `v656`. Not merged or deployed; production remains App
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

## Change

### Policy (`src/sw-register.ts`)

- **Where the dialog is deferred.** `isUpdatePromptDeferred()` is true in a
  room (`isRoomSessionActive()`, the module's only `network.appRole` read),
  while `demo.active` or `demo.loading` is set, and while `body.mode-demo`
  is still present during the demo's exit curtain.
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
- **Once per generation per document.** A `Set` in the registration closure
  holds announced identities: the exact cache version when the worker
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
  no room could auto-reload) and posts the same notice instead of the
  `dialog.sw_update_msg` toast. Idle tabs still reload, aligned to
  `controllerchange`.
- **Back on setup.** Most leave paths (the Leave buttons, Back, kicks)
  navigate to `/`, and the new idle document's existing boot check shows the
  dialog for the still-waiting generation. For an in-place return to idle,
  the lifecycle signal arms a native 1-second timer (`leaveSession()` clears
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
  new use site.
- `guard:dead-exports`: the exact self-only baseline drops 79 → 78 because
  `isStandaloneDisplayMode` now has a production consumer.
- PWA cache `v655` → `v656` and the `index.html` bootstrap query; App stays
  `8.10.0`. The release-record 8.10.0 item now counts 66 App runtime paths
  against `d76b1432` (adds `src/sw-register.ts`).

## Rollout limit: the first deployment

The new behavior runs in the client. Devices still running `v655` or older
code see the `v656` update through their old code: the blocking dialog on any
screen, including in a room, and the old toast when another tab accepts.
Only updates after `v656` follow the new policy on devices that already run
`v656`. **Deploy this change outside a live event.**

## Verification

Tested code: `bb61cbc6` on `agent/standard-room-owner-pin` (`c9042ffc` copy,
`d0e84ade` policy and tests, `bb61cbc6` cache `v656`; the docs commit follows).
Windows 11, Node 24.13.1, npm 11.8.0, Vitest 5.0.3, Playwright 1.63.0
Chromium, dependencies through the main checkout's `node_modules` junction.
All runs are local; none is an exact-main CI candidate.

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | pass, zero warnings |
| `npm run format:check` | pass |
| `npx vitest run` sw-register (unit and recovery integration), sw-update coordination and completion, `src/chat`, `src/i18n` | 40 files, 619 passed |
| `npm test` | 538 files, 11,498 passed, 0 failed, 1 skipped¹ |
| `npm run test:coverage:critical` | 58 files, 1,995 passed; thresholds met (81.84 / 76.50 / 88.07 / 85.95) |
| `guard:release-identity` | pass; `8.10.0` / `v656` |
| `guard:sw-cache-version` | pass; `v656` (`bb61cbc6`) covers every committed PWA runtime change |
| `guard:service-worker`, `brand-capitalization`, `dead-exports`, `bus-pairing`, `import-graph`, `room-authority-boundaries`, `source-complexity` | pass |
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

### Browser probe

A temporary Playwright spec (not committed; archived as
`scratch/update-prompt-screens/capture.tmp.test.ts` in the main checkout)
ran against `npm run build:e2e` with the local PeerJS server: a Chromium host
at 390x844, `ko-KR`, light theme, started a Standard room; the spec then
changed `CACHE_VERSION` in `dist/service-worker.js` from `v656` to `v657` on
disk (restored afterwards) and called `registration.update()`. The worker
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
- A provisional room (`appRole` already `host` or `guest` while setup
  creates a code or runs a join) counts as a room, per decision 1. It gets
  the toast instead of the dialog.
- No native-speaker review of the 41 translated locales.
