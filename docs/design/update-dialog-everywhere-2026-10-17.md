# One update dialog everywhere — 2026-10-17

## Report

The owner described what happened after the in-room chat notice
"MUSIXQUARE의 새 버전이 있어요. 페이지를 새로고침하면 적용돼요.":
they reloaded, quickly tapped 방 만들기, and only a toast appeared. The next
reload, on the first setup screen, applied the update with the
"세션을 새로고침하고 있어요..." screen. The notice had promised that a
reload applies the update, and the first one did not.

## Cause

A reload never activates a waiting service worker; only `SKIP_WAITING` does.
8.11.6 ([report](update-apply-on-reopen-2026-10-16.md)) sent it for a worker
already waiting when a page opened, but only after the page's loads had been
quiet for 1 s (at most 6 s), and only while the tab had not entered a room.
Tapping 방 만들기 during that wait made the tab a provisional host room, so it
kept the notice (a toast, because setup still covered the room) instead of
applying. The next reload, before any tap, applied it.

## Owner decision (2026-10-17)

The owner chose the earlier, simpler behaviour: always ask with the dialog,
and never promise that a reload applies the update. This replaces the
2026-10-11 in-room notice policy
([report](in-room-update-prompt-2026-10-11.md)) and the 8.11.6 apply on
reopen.

- Every waiting update gets the same dialog, with 나중에 and 적용하기, outside
  rooms, in standard and PRO rooms, and in the demo. It appears when an
  update is found and on every open while one is waiting.
- 나중에 hides it for the current page only. The next open shows it again.
- No chat notice or toast says that a reload or reopen applies the update.
  The silent apply on reopen and the in-room deferral are removed.
- A room guest who applies returns to the room's Start screen, the `/CODE`
  invite page that a room link or QR code opens, and taps 시작하기 there.
- Copy (owner-approved): for a host, "새 버전이 준비되었어요.\n적용하려면 방을
  다시 열어야 해요."; for a guest, "새 버전이 준비되었어요.\n적용하려면 방에 다시
  입장해야 해요."; the button 적용하기 instead of 새로고침. Outside rooms, as
  proposed in the session: "새 버전이 준비되었어요.\n적용하면 페이지를
  새로고침해요."

## Change

### The dialog

The title stays 업데이트 (`dialog.sw_update_title`), the secondary button is
나중에 (`common.later`), and the primary button is 적용하기
(`dialog.sw_update_apply`). The message depends on where the page is when the
dialog opens:

| Where | Message (Korean) | 적용하기 |
| --- | --- | --- |
| Outside a room: the first setup screen, Join with a code being typed, an invite link before Start, the demo outside a room | 새 버전이 준비되었어요. 적용하면 페이지를 새로고침해요. | Reloads the page in place. An invite link keeps its `/CODE` URL. |
| A standard-room host, including the room code screen before Start, and a room running the demo | 새 버전이 준비되었어요. 적용하려면 방을 다시 열어야 해요. | Reloads in place. The room ends with the page, and the host opens a room again from the start screen. |
| Anyone else whose session started or who has a room context: a standard guest, every PRO participant, and a PRO room during presence re-entry | 새 버전이 준비되었어요. 적용하려면 방에 다시 입장해야 해요. | Goes to that room's `/CODE` invite page, where 시작하기 enters again. |

A PRO room projects the host role locally but is not a standard-room host,
so its participants, owner included, get the second-to-last row's copy. Its
room ID is its `0xxxxx` code, so they return to `/0xxxxx`. The return path
reuses the reconnect flow's pattern: it writes `mxqr_reconnect_target`, so a
join error there says the host left rather than "check your code", and
navigates through `scheduleSessionReset` with the 세션을 새로고침하고 있어요...
screen. The browser needs the Start tap before it plays sound, so the reload
cannot enter by itself. Without a valid six-digit room code the page reloads
in place.

The four new keys are in all 42 locales. Each message keeps that locale's
existing first sentence of `dialog.sw_update_msg` and adds what applying does.
`chat.update_available_tab_system_message` and
`chat.update_available_app_system_message` are removed.
`dialog.sw_update_msg` ("새 버전이 준비되었어요.\n새로고침하면 업데이트가
적용돼요.") stays for the setup join and host errors after a page chunk
failed to load. There a refresh does load the new page code, because
navigations are network-first.

### When it appears

- An update found while the page is open is offered at once, anywhere.
- A worker already waiting when the page opens is offered once the page's
  own loads have been quiet for 1 s (at most 6 s), as in 8.11.6. Chromium can
  hold a `SKIP_WAITING` sent during those loads for 43–66 s, so asking at once
  could leave 적용하기 without effect for a minute. A room begun during that
  wait still gets the dialog, with that room's message.
- 나중에, or Back on the dialog (8.11.9), puts that generation off for the
  current page. The page does not ask again for it, a newer generation is
  asked about at once, and nothing is stored, so the next document asks
  again. A 24-hour 나중에 that versions up to 8.11.10 stored in
  `mxqr-sw-update-dismissal-v1` is dropped when read. That record now holds
  only the 5-minute cooldown after a dialog that failed to open.
- Another tab applied an update: a tab outside rooms and the demo reloads, as
  before. A tab in a room, on a create or join screen, on an invite page, in
  PRO presence re-entry, in the demo, or behind the demo exit curtain shows
  the same dialog instead, once per generation, and not for a generation put
  off with 나중에 in that page. 적용하기 reloads it as in the table.
- Within 30 s of an update reload, a newly found worker is still activated
  without asking, to avoid a reload-dialog loop. An idle page then reloads
  once, and a page in a room or the demo gets the dialog.
- Unchanged: the cross-tab election that lets one tab present a generation's
  dialog, the generation checks, the silent activation of a same-generation
  worker, the hourly update check, and the lazy-feature recovery dialog in
  `src/app.ts` (owner-approved exception 2026-10-11).

### Review fixes

The Codex review of the first revision (PR #381) found two gaps. Both are
fixed in `d1a3995d`.

- A dialog opened while a guest or PRO participant was still connecting
  showed the outside-room message, and the join could finish under it.
  적용하기 then followed the room path to `/CODE`, which the message had not
  said. The message is now a callback, and `showDialog` takes `refreshOn`, a
  subscription it holds only while the dialog is open and that re-reads
  callback copy as a locale change does. The update dialog passes
  `subscribeRoomAuthorityLifecycle`, so its message changes with the room
  before 적용하기 is pressed.
- A worker that never answers the generation request is known by its script
  URL (`unknown:<script URL>`) in the waiting prompt, but the dialog for
  another tab's activation keyed it as `unknown-controller:<n>`, so 나중에
  did not stop a second dialog. Both now use the resolver's prompt identity.
  Two different unidentified generations in one page therefore share one
  identity; only builds older than the generation protocol, or a worker that
  does not answer in time, are unidentified.

`docs/hotfix-procedure.md` ("Client Update Behavior") now describes this
behaviour.

App 8.11.11 / service-worker cache v711. v710 was the first PR revision and
was never released. App only; Developer API D1 stays
disabled. There are no new dependencies, protocols, schema, secrets,
bindings, permissions, or CSP changes. The copy change is four keys added and
two removed, in 42 locales.

## Verification

Base `59c3aa9e` (main after #380). Tested runtime source: `d1a3995d`, the
PR head runtime after the review fixes. Local Windows checks used Node
24.13.1 / npm 11.8.0. These are local branch results, not the exact-main
release candidate.

On `d1a3995d`, `format:check`, `lint`, `typecheck`, and `build:checked`
passed. `build:checked` includes the room-authority boundary (84
grandfathered direct reads, unchanged), service-worker cache version (v711
covers every committed runtime change), legacy TV build, and app-shell (97
assets) guards. The bus-pairing, import-graph, lifecycle-writes,
dead-exports (self-only bindings within the ratchet), chunk-pump,
standard-room hot-path, Developer API boundary, D1 migration, and operations
drift contract guards also passed. The dead-exports unit test pins exact
counts and failed there: the update dialog helper now reads `DialogResult`
from the dialog module, so the self-only count shrank to 77. `9803440f`
lowers the shrink-only baseline and the pinned test to 77, and both pass.
The full unit run on `9803440f` passed 574 of 575 files and 12,896 of
12,897 tests. The one failure was environmental: a workerd test's local
fetch landed on a port that undici refuses ("bad port"). Run alone, that
file passed 16 of 16, and it passed in the earlier full runs.

The PR's first runtime revision, `f05b1949`, had passed the same set except
one timeout in its full unit run (574 of 575 files, 12,893 of 12,894 tests):
the `browser/classic-runtime/admin.ts` case of `tooling-eslint-config.test.ts`
took 26 s against its 15 s limit in the full parallel run, and passed 18 of
18 run alone.

Before the PR, `7173dc9a` failed the dead-exports guard and its unit
test: "SELF-ONLY BINDING COUNT GREW: 79 > historical baseline 78". Without
the in-room notice, `isStandaloneDisplayMode` in `src/core/platform.ts` was
used only inside its own file; 8.10.0 had lowered the baseline from 79 to 78
when the notice started reading it. The function is module-private again,
and `platform.test.ts` now observes the `standalone` and `ios-standalone`
root classes, with a new case for the display-mode query. The stale platform,
toast, and chat mocks in `sw-register-recovery.integration.test.ts` were
removed. Every other check had passed on that revision.

### Unit tests

- `src/core/__tests__/sw-register.test.ts` (69 cases, 72 before) is rewritten
  for the decision:
  - the dialog in every place (the home screen, a host code screen, a started
    host room, a guest still joining, an entered guest room, a PRO room host,
    PRO presence re-entry, the demo, a room running the demo), with the
    message for that place and the 적용하기 and 나중에 labels;
  - a worker waiting at startup is offered only after the quiet wait and
    reloads after the new controller; an invite link before Start reloads in
    place without the reconnect marker; a room begun during the wait (a host
    code screen, an entered guest) still gets the dialog, with that room's
    message;
  - 나중에 and Back last for the page: no `SKIP_WAITING`, nothing stored, no
    second dialog for that generation in the same page, a newer generation
    asked about at once, and the next open asks again, also after a room;
  - 적용하기: a host room reloads in place; a guest, a PRO room host, and a PRO
    participant in re-entry go to `/CODE` with the reconnect marker; a code
    that is not six digits reloads in place;
  - another tab applying an update: a host room, PRO re-entry, the demo, and
    the demo exit curtain ask once instead of reloading; one dialog across
    controller wrappers; none for a generation put off in that page, and a
    newer one asks again; 적용하기 there returns a guest to `/CODE`;
  - within the cooldown, an idle page activates and reloads, and a room
    activates and then asks;
  - an open prompt whose update another client applies asks only once,
    whether the user then picks 나중에 or 적용하기 (one reload);
  - a source check that `sw-register.ts` has no chat notice, toast, system
    message, or peer send;
  - after review: an open dialog re-renders its message when a join finishes
    under it, and 적용하기 then returns to `/CODE`; and an unidentified
    generation put off with 나중에 is not offered again when another tab
    applies it. Reverting either fix makes its case fail.

  The chat-notice, toast, deferral, retraction, and apply-on-reopen cases of
  the replaced policies were removed. The other cases keep their behaviour,
  with the dialog where a toast used to be.
- Mutation check: five deliberate breaks of `src/sw-register.ts` each failed
  tests: no return path (4 failed), room tabs reloading when another tab
  applies an update (14), no quiet wait (2), 나중에 not kept for the page (1),
  and one message everywhere (9). The 나중에 break at first passed every test:
  the same-page case waited only two event-loop turns, less than the 50 ms
  that the prompt election settles without Web Locks (as in jsdom). It now
  waits 200 ms.
- `src/core/__tests__/sw-update-coordination.test.ts`: the presentation
  failure cooldown case stays, and a new case drops a stored 24-hour 나중에.
- `src/i18n/__tests__/factual-translation-contracts.test.ts`: in every
  locale the Apply label differs from the Refresh label, each of the three
  messages has two lines, its first line matches that locale's
  `dialog.sw_update_msg` first line, the three consequences differ, and
  non-English text differs from English. The Korean copy is pinned.
  `toast-copy-policy.test.ts` drops the two removed keys.
- `src/ui/__tests__/dialog-locale.test.ts`: `refreshOn` re-reads callback
  copy while the dialog is open and unsubscribes when it closes.

### Browser check

Local production builds of the first revision, `f05b1949`, ran in the Claude
desktop app's
built-in Chromium browser, served by `vite preview` at
`http://localhost:4190`, with PeerJS signaling (the transport for local
hosts). Four local builds, T0 to T3, differed only in their cache version (test
values v710 to v713, not the releases of those names) and were swapped in
place. Each update check was triggered with
`registration.update()`, as the hourly check does. The local server has no
`/api` backend.

| Step | Result |
| --- | --- |
| Home screen under T0, T1 found while the page is open | 업데이트 / "새 버전이 준비되었어요. 적용하면 페이지를 새로고침해요." / 나중에, 적용하기 |
| 나중에 | Closed. T1 still waiting, nothing stored in `mxqr-sw-update-dismissal-v1`. |
| Browser reload | The same dialog, 1.4 s after the reload (the quiet wait). |
| 적용하기 | The new document started 0.41 s after the click, under T1, with nothing waiting. |
| 방 만들기 (code 903307, before Start), T2 found | The host copy "새 버전이 준비되었어요. 적용하려면 방을 다시 열어야 해요." After 나중에 and 시작하기, the room started and the dialog did not return in that page. |
| Second tab on `/903307` before Start, T2 waiting | The outside-room copy, after the quiet wait. After 나중에 and 시작하기, the tab joined as a guest. |
| T3 found (update check from the guest tab) | The election gave the dialog to the host tab (host copy). The guest tab showed none. |
| Host 적용하기 | The host reloaded onto the start screen under T3. The guest tab kept its document and room and showed the guest copy "새 버전이 준비되었어요. 적용하려면 방에 다시 입장해야 해요." |
| Guest 적용하기 | Navigated to `/903307` under T3 with `mxqr_reconnect_target` = 903307: "환영합니다 / 903307번 방에 입장하려고 해요" with 시작하기. |
| 시작하기 there | The host's reload had ended room 903307, so the join failed with "방장이 세션을 종료한 것 같아요" and 다시 시도. |

The review fixes came after this check and are covered by the unit tests
above. The test origin's
worker, caches, and storage, the temporary preview entry, and the second tab
were removed afterwards.

### Not covered

- Real devices: iPhone Safari and the home-screen PWA, Android Chrome and the
  installed app, and desktop browsers other than the built-in Chromium.
- A PRO room and its presence re-entry (no local PRO backend), the demo, the
  cooldown path, Back on the dialog, a join finishing while the dialog is
  open, and an unidentified worker: unit tests only.
- A production deploy and a real backend.
- E2E was not run.

## Limits

- Navigations are network-first. A page opened after a deploy already runs
  the new page code under the old worker, and the dialog then asks to
  activate the waiting worker and reload once more. This is the earlier
  behaviour the owner chose.
- With several tabs open, one tab is elected to present a generation's
  dialog. 나중에 there leaves the other tabs unasked about it until they open
  again or a newer generation arrives.
- A guest who applies must tap 시작하기 on the room's Start screen. If the room
  ended meanwhile, the join there fails and says the host left.
- A standard-room host who applies ends the room. Guests then see the host
  leave and must join the new room the host opens.
- Devices still running 8.11.10 or older code keep the old notices and the
  apply on reopen until they load the new page code. A first reload or reopen
  after the deploy loads it (network-first), and that page then asks with the
  new dialog.
- An iPhone home-screen app that resumes its previous page instead of
  starting a new document keeps the old code until its next real launch.
