# Standard room announcement bootstrap — 2026-10-13

## Scope and evidence

- Runtime/test commit: `98c690cf79ff46e97b5e7358d0b3fd4a10866f4b`.
- Baseline: `d76794c25d94128a2a08201b567941117b623684` (App 8.10.2 / v661).
- Deployed main commit: `8d0d310c6ee8114722d199b5c8d9834088979ec5`
  ([PR #307](https://github.com/hiefny/MUSIXQUARE/pull/307)).
- Owner authorized fixing and deploying the missing Standard-room announcement.
  The approved maintenance-complete announcement was already published through
  the admin UI at 2026-10-13 00:20:34 KST; no new notice is needed for this fix.
- Public announcement GET returned enabled and the approved text, but a fresh
  Standard-room browser did not show its pinned notice. That browser also had
  a signaling admission warning; the deterministic local reproduction below
  isolates the announcement defect from that independent observation.

## Cause and change

`app.ts` lazy-loaded announcements only when `room.context.role` was not idle.
Standard rooms keep their role in the transport projection instead, so fresh
host and guest pages never loaded the polling module. Direct announcement unit
tests initialized that module themselves and bypassed the faulty bootstrap.
The condition existed before the 8.10.2 deployment (`64e6d8b37`, 2026-08-31).

The loader now also recognizes Standard host/guest through the existing
`isStandardRoomRole` lifecycle helper. It retains the PRO condition, shared
import promise, terminal lazy-load failure handling, and existing polling
lifetime. No new authority grant or direct legacy-state read is introduced.
Initial notices remain silent; visible sessions poll every five minutes and
check on foreground return, with the existing per-document seen-ID suppression.

The blocking critical-browser suite now navigates real setup flows from fresh
host and guest pages and requires each page's own announcement request plus
the visible pinned message. A forwarded host notice cannot satisfy the guest
request assertion. Existing PRO owner-recovery coverage also asserts its
announcement, while announcement unit tests retain stale-response and
visibility checks.

## Local verification

Environment: Windows, repository Node 24.20.0, installed dependencies, local
PeerJS for Standard E2E, mocked announcement/PRO responses for deterministic
browser tests. No production payload or live room is injected into these tests.

- Before fix: new Standard bootstrap test **1 failed**, pinned notice remained
  hidden after a successful local host connection (15-second assertion).
- After fix: complete `e2e/critical-browser.test.ts` **8 passed**, no retries.
- Typecheck, lint, format, Worker syntax and Developer API/D1/operations/room-authority guards: passed.
- First full-unit run: 12,353 passed / 1 failed; build also rejected the old
  `index.html` bootstrap query (v661) after the cache bump. Corrected that mirror
  to v662 in the final runtime commit.
- Final runtime SHA `98c690cf`: **550 files / 12,354 unit tests passed, 0 failed,
  0 skipped** (local jq supplied), committed `build:checked` passed, and its
  unmodified production artifact passed **17 candidate browser tests**.
- The 8 critical-browser tests ran on the same announcement implementation
  before correcting the bootstrap cache query; exact-main CI subsequently
  passed the complete critical gate against the final source. The entire
  auxiliary Full E2E suite and physical Safari/PWA were not run for this bounded fix.
- Independent code review: 0 blockers, 0 required changes; review did not itself
  execute tests.

## Reviewed merge and production release

- PR [CI 38271897913](https://github.com/hiefny/MUSIXQUARE/actions/runs/38271897913):
  all 11 jobs succeeded. GitHub Codex review returned thumbs-up with 0 findings;
  the independent review above had 0 blockers.
- Exact-main [CI 38272698028](https://github.com/hiefny/MUSIXQUARE/actions/runs/38272698028),
  attempt 1, on `8d0d310c`: all 11 jobs succeeded, including the four coverage
  gates, production candidate browser tests and critical browser gate. Under
  the owner's deployment approval, the release reused this successful
  exact-main candidate; PR/local results did not substitute for that gate.
- [Production Release 38273449653](https://github.com/hiefny/MUSIXQUARE/actions/runs/38273449653),
  attempt 1: **success**, completed **2026-10-13 00:55:32 KST**. Version
  **8.10.3 / v662**, target **app**, Developer API D1 application **false**.
  Maintenance stayed **OFF** without a new maintenance toggle.
- App deployment `15f11373-6155-4a5b-8563-664696d6f588`, Worker version
  `9ba8ecc6-af3e-4009-b6d0-d4857b0c3294`, **100%**, Git `8d0d310c`.
  Release ownership was true; final current-deployment verification completed
  at **00:55:28 KST**, and the coherent production marker was persisted.
- App generation/assets, App anonymous account boundary, current PRO public
  boundary and Standard HTTPS signaling: **4 live smokes passed**. The other
  five Workers stayed on `9c924ee1`; partial-release compatibility and its
  recheck passed. Existing App/admin/auth D1 baselines were applied and verified
  idempotently. Dependency installation reported 0 vulnerabilities.
- Recovery was not needed and the recovery job was skipped. The immutable
  checkpoint retains the previous App deployment
  `51e0c126-f126-431b-bf19-3f617d1836ec`, version
  `32c45761-9d66-467f-b272-bb495e80d3b1`, Git
  `72a6e780c06fbd84aeb63c7abe2d1aed8f77795c` (8.10.2). A compatible rollback
  to that baseline would restore its Standard-room announcement omission.
  The checkpoint is not a user-data backup.
- Post-release [Operations Drift Audit 38273786011](https://github.com/hiefny/MUSIXQUARE/actions/runs/38273786011),
  source `8d0d310c`, completed **00:56:27 KST**: **31 pass / 0 fail / 5 manual**.
  Counts were checked against the downloaded JSON artifact. The five manual
  controls remain open in the release record.

Release logs/artifacts are retained locally under
`scratch/release-38273449653.log` and `scratch/release-38273449653/artifacts/`.
Drift evidence is under `scratch/ops-drift-38273786011.log` and
`scratch/ops-drift-38273786011/`. These ignored local files supplement the
linked GitHub runs; they are not published repository artifacts.

## Live browser verification and limits

At **2026-10-13 00:58 KST**, the real production page in the in-app browser
showed the approved pinned announcement in a newly created Standard room.
The existing browser had run `/assets/main-lVZDqPz6.js` with v661 before the
deployment. After leaving the disposable session through the UI and reloading,
the document loaded `/bootstrap.js?cache=v662` and
`/assets/main-D3VyRMei.js`. Creating a Standard room through the normal UI showed
this exact notice in the chat banner:

> Maintenance is complete. Please refresh the page or fully close and reopen the app before joining a room.

Screenshot: local ignored evidence
`scratch/announcement-live-8.10.3-2026-10-13.jpg`. No fixture or DOM injection
was used. Public GET `/` and `/service-worker.js` both returned HTTP 200, the
root bootstrap referenced v662, and the public announcement response was
enabled with the same approved message. This validates the new Standard host
page in production; fresh host and guest request ownership is separately
covered by the deterministic critical-browser regression.

The release-record announcement deployment item is closed by PR #307, the
successful exact-main candidate, Release 38273449653 and this live UI evidence.
No new announcement was published during this hotfix. No dependency, schema,
binding, secret, protocol or recovery-floor changes were introduced.

Existing open clients need their normal update and reload path; this observation
does not prove that all open clients updated automatically. No forced refresh
or new update system is introduced. No real customer PRO room or physical
iPhone/Safari/PWA was tested in this verification. The latest main-ref Full E2E
run remained [37595231001](https://github.com/hiefny/MUSIXQUARE/actions/runs/37595231001)
on `61cedbc6` (2026-10-07); no entire auxiliary Full E2E run exists for
`8d0d310c`. Dependency PR [#297](https://github.com/hiefny/MUSIXQUARE/pull/297)
was rechecked and remained open, outside this release. All other release-record
open items remain unchanged.

## Follow-up: withdrawing an already displayed notice — 2026-10-13

The owner requested disabling the published notice and observing an existing
Standard room for five minutes without reloading. This is a separate QA result,
not a new production release or a reversal of the bootstrap fix above.

- Reviewed/local test SHA: `967db779aa6c667202242b6892ce2ca51375b48f` (documentation
  merge; runtime remains the deployed `8d0d310c`, App 8.10.3 / v662).
- Environment: Windows, Codex in-app browser on the real public site; existing
  Standard host page and its open chat drawer. No fixture, DOM mutation, timer
  acceleration, navigation, reload, re-entry or notice dismissal was used.
- Admin UI saved **Disabled at 2026-10-13 01:12:01 KST**. A separate public GET
  `/api/announcement/current` returned HTTP 200 with `{"enabled":false}`.
- At **01:17:21 KST**, over five minutes and twenty seconds later, the same
  notice remained visible. The page reported `document.visibilityState` as
  `visible` at the start and each observation. Screenshot retained locally:
  `scratch/announcement-disabled-still-visible-2026-10-13.jpg`.
- The four existing `src/ui/__tests__/announcement.test.ts` tests passed locally
  with Node 24.20.0 (4 pass / 0 fail / 0 skip). They cover the five-minute update
  timer, silent initial display, session cancellation and foreground behavior;
  they do not assert withdrawal of an already displayed notice. Log:
  `scratch/announcement-polling-2026-10-13.log`.

Confirmed separate gap: `checkAnnouncement()` returns immediately when
`shouldShowAnnouncement(payload)` is false. It emits no withdrawal event and
does not hide the existing pinned banner. Bootstrap now initializes both the
initial request and interval, but this existing renderer behavior is unchanged.
The live experiment establishes that the banner persisted; browser network
timing was not captured, so it does not independently prove the exact live
poll request timestamp. Periodic execution is supported by the source and the
existing deterministic tests, not by a claimed network capture.

The consumer is shared by Standard and PRO rooms, so the same missing clear
path exists in both. Only Standard was exercised live in this follow-up. Future
repair must distinguish service announcements from room-owner notices because
they share the pinned banner. It must also distinguish authoritative disabled
state from an unavailable server read: `handlePublicAnnouncement()` currently
falls back to an empty announcement and HTTP 200 when canonical state is absent.
Blindly clearing on every `enabled:false` can therefore clear during an outage.

The public notice is left disabled as requested. Runtime code and tests were
not modified, and no deployment was performed in this follow-up. Withdrawal
remains an open item in the release record.
