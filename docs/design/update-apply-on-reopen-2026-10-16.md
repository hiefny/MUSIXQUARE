# Apply a waiting update on reopen — 2026-10-16

## Report

The owner reported that an update found away from the first setup screen
needed two reloads. The room chat notice says "페이지를 새로고침하면 적용돼요"
(installed app: "앱을 다시 열면 적용돼요"), and the setup dialog says
"새로고침하면 업데이트가 적용돼요". After that reload or reopen, the update
dialog appeared again, and only its 새로고침 button applied the update.

## Cause

This was a defect, not a policy. The service worker activates a new version
only on `SKIP_WAITING`. A reload does not activate a waiting worker, because
the reloading page keeps the origin's client alive, and an installed app that
reopens to a new document behaves the same way. `src/sw-register.ts` treated
a worker that was already waiting when the document started exactly like a
newly found one: the dialog on the idle setup screen, nothing after "나중에",
and the room notice again in a room. On an invite link (`/CODE`), setup
projects the guest role while it waits for the Start tap, so each reload
posted the toast again and the update never applied.

Navigations are network-first, and the new `index.html` names a new
`bootstrap.js?cache=` URL that the old cache does not hold. An online reload
after a deploy therefore already runs the new page code under the old
controller. This fix takes effect on the first reload after 8.11.6 is
deployed, not only from the following update.

## Change (owner decision 2026-10-16)

The owner chose to apply the waiting update, without the dialog, when the app
opens outside a room, including an invite link before the Start tap.

- `handleWaitingWorker` takes `foundAtStartup`. Only the waiting-worker check
  that runs once when the document registers its worker passes it. After the
  existing cooldown, generation, and same-generation checks, an unblocked
  startup worker gets `SKIP_WAITING`. The dismissal ledger is skipped for it,
  because the "나중에" dialog also said a reload would apply the update.
- It first waits until no page resource has finished for 1 s (at most 6 s).
  Measured in Chromium, `SKIP_WAITING` sent while the active worker still
  served the page's first loads took 43–66 s to activate, and sending it again
  did not shorten that. Sent after those loads settled, it took under 1.5 s.
  The dialog's 새로고침 button was never affected, because a person presses it
  seconds after the page loads.
- `hasEnteredRoom()` blocks it: `setup.sessionStarted`, a room context ID,
  `network.isConnecting`, a host connection, the standard host role (guests
  can join a code screen before Start), or the standard guest role anywhere
  except an invite link (Join on the home screen, with a code being typed).
  The demo, or its exit curtain, also blocks it. The invite page keeps its URL
  across the reload, so the guest returns to the same Start screen.
- The check runs again after the wait and on the resulting
  `controllerchange`. If the user pressed Start or Join, or a room began, the
  page does not reload and shows the existing notice instead
  (`startupApplyRequested` is consumed by the first passive controller
  change).
- The 30-second cooldown after an update reload no longer bypasses this. A
  startup worker found in it takes the same quiet wait, rechecks, and flag,
  so an invite page waiting for Start reloads instead of showing the toast,
  and no request is sent during the first loads (review finding on PR #371:
  sending at once would have reloaded such a page tens of seconds later). If
  the page is already in a room or the demo, or one begins during the wait,
  the worker is activated silently as the cooldown always did, without a
  reload.
- Unchanged: an update found while the page is open (the dialog on the idle
  setup screen, the toast on create/join screens, the chat notice in rooms),
  the dialog after leaving a room in place, the same-generation path, and the
  cross-tab prompt election. Another open tab in a room reacts as it already
  did when a different tab accepted an update: no reload, one notice.

This narrows [decision 6](in-room-update-prompt-2026-10-11.md#owner-decisions-after-the-review-2026-10-11)
for one moment only. An invite-link screen that is still waiting for Start
when the page loads now applies a waiting update instead of showing the
toast. An update found later on that screen still gets the toast.

App 8.11.6 / service-worker cache v704 (v703 was the first PR revision and was
never released). App only; Developer API D1 stays disabled. There are no new dependencies, protocols, schema, secrets,
bindings, permissions, CSP, or copy changes.

## Verification

Base `a8b37386` (main after #369). Tested runtime source: `18ab8363`. It was
then rebased onto #370 as `484c1409`; #370 changed only documents, so the
runtime tree is identical, and the cache-version and release-identity guards
passed again there. Local Windows checks used Node 24.13.1 / npm 11.8.0.
These are local branch results, not the exact-main release candidate.

On `18ab8363`, `format:check`, `lint`, `typecheck`, and `build:checked`
passed. `build:checked` includes the room-authority boundary,
service-worker cache version (v703 covers the change), and app-shell (97
assets) guards. The bus-pairing, import-graph, lifecycle-writes,
dead-exports, chunk-pump, standard-room hot-path, Developer API boundary, D1
migration, and operations drift contract guards also passed. The full unit
run passed 572 files / 12,857 tests, with zero failures or skips. E2E was not
run.

An earlier local run caught two problems that are fixed in `18ab8363`. The
room-authority guard rejected a new direct `network.appRole` read, which now
goes through `isStandardRoomRole()`. The cache-version guard rejected runtime
edits committed after the cache bump, so the branch was squashed into one
commit.

### Unit tests

`src/core/__tests__/sw-register.test.ts` adds ten cases:

- a worker waiting at startup gets `SKIP_WAITING` only after the quiet
  wait, with no dialog, toast, or notice, and the reload follows the new
  controller;
- the request waits while page resources keep finishing;
- the invite-link screen before Start applies the update, both on open and
  right after an update reload (the cooldown path);
- a generation dismissed with "나중에" applies on reopen;
- Join tapped on the home screen during the wait keeps the toast and sends
  nothing;
- an invite join under way, a connected guest, a host code screen, and Join
  on the home screen that began before activation do not reload, and they
  show the toast.

Against the previous `src/sw-register.ts` (base `a8b37386`) nine of the ten
fail. The Join-during-the-wait case passes there too, because the old code
already showed the toast; it guards the new path. Against the first version
of this change, which asked at once and did not block Join on the home
screen, the four cases about those two points fail. The cooldown case also fails with only its cooldown line removed.
Existing cases that used a startup waiting worker to reach the dialog now
install the update after registration. Guest-room cases now model a real
joined guest (`setup.sessionStarted`) or a join under way
(`network.isConnecting`) instead of the role alone.

### Built app in a browser

The Claude desktop browser pane (Chromium) loaded local `vite preview`
production builds at `http://127.0.0.1:4190`. Successive builds differed only
in their cache version, served one after another at the same origin. There
is no backend in this setup, so `/api/*` answered 503 throughout.

| Run | Code | Steps | Result |
| --- | --- | --- | --- |
| Baseline | before this change (v702 → v703) | Update found on the first setup screen, dialog left open, browser reload | Controller stayed v702 with v703 waiting, and the same dialog appeared again. This reproduces the report. |
| Home screen | first version (v704 → v705) | Same, browser reload | Applied 0.31 s after the reload, page reopened at 0.46 s, controller v705, no dialog or toast. |
| Invite link | first version (v705 → v706, v706 → v707, v707 → v708) | Same, then open `/123456` (twice by link, once with `location.replace`) | Applied only after 66.1 s, 51.9 s, and 43.4 s. |
| Dialog button | first version and before this change | Press 새로고침 5.4–6 s after load | Applied within 0.1 s each time. |
| Second request | first version (v704 → v705) | Startup apply stalled; `SKIP_WAITING` sent again at 12.8 s | No activation in the next 2.5 s. It applied at 43.4 s. |
| Invite link | final version (v714 → v715) | Same as the slow invite runs | Applied 1.4 s after opening, reopened at 1.6 s on `/123456`, controller v715, no dialog or toast. |
| Home screen | final version (v715 → v716) | Dialog left open, browser reload | Applied 1.2 s after the reload, reopened at 1.4 s, controller v716, no dialog or toast. |

The console of the reopened pages showed `[SW] Update was waiting when this
page opened. Applying it without a prompt`. The final-version builds came
from the working tree before a comment-only edit and a test type fix, so
their runtime logic matches `18ab8363`. The temporary preview entries and
browser storage were removed afterwards.

### Not covered

- A real backend, a production deploy, and real devices. iPhone Safari/PWA,
  Android Chrome, and desktop reopen behaviour were not run. The quiet wait
  is a heuristic: a page that keeps loading resources past 6 s, or a slow
  network that is still revalidating, can still meet the slow activation
  above, and the page then reloads late unless a room has begun.
- Whether an installed iOS app reopens to a new document or resumes the old
  one depends on the OS. A resumed page keeps the old code until its next
  real launch, and this change does not affect that case.
- Pressing Start in the short time between the request and activation is
  covered by unit tests only.

## Recovery

A normal authorized rollback to 8.11.5/v702 restores the previous behaviour:
the dialog after reopen, and the toast on invite links. No stored data or wire
contract changes.
