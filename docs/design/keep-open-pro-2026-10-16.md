# Keep-open dialog in PRO rooms — 2026-10-16

## Scope and evidence

8.10.25 added a one-time "Please keep the app open" dialog for first-time
visitors when a Standard room's first media appears
([host presence and keep-open guidance](host-presence-keep-open-2026-10-16.md)).
PRO rooms were left out because the message's second sentence is about the
host device, and PRO rooms have none.

PRO guests are often first-time visitors, and the demo prompt never shows in
PRO rooms (`isProRoomDemoBlocked`). A first-time PRO participant therefore got
no first-run guidance at all. Owner decision (2026-10-16): show the dialog in
PRO rooms too, without the host sentence.

## Change

- `src/ui/keep-open-notice.ts` no longer skips PRO rooms. In a PRO room the
  dialog uses `dialog.keep_open_message_pro`; Standard rooms keep
  `dialog.keep_open_message`. The rule is unchanged: visitors with no app-use
  record at boot, once, when the room's playlist first holds media, after any
  running demo. PRO participants enter through the same session-start event
  (`setup:guest-join-success`), and the PRO runtime projects its queue into
  `playlist.items`, so the same triggers apply.
- `dialog.keep_open_message_pro` in all 42 locales is the first sentence of
  that locale's existing `dialog.keep_open_message` ("다른 앱으로 넘어가거나
  화면이 꺼지면 소리가 멈추거나 싱크가 어긋날 수 있어요."), so no new
  translation is involved.
- The unit test that pinned "PRO rooms are left alone" now pins the PRO
  message.
- Release identity: 8.10.26, cache epoch v692.

## Verification

Environment: Windows 11 Pro local worktree, Node 24.13.1 (the repository pins
24.20.0, which pull request CI uses), Vitest 5.0.3, Playwright 1.63.0 with
Chromium.

Tested source: **`17b36d03`** (8.10.26, cache epoch v692), branch
`agent/keep-open-pro`, clean tree. These are local and branch results, not the
exact-main release candidate.

| Check | Result |
| --- | --- |
| Full `vitest run` | 567 files, **12,768 passed / 0 failed / 0 skipped**, 194.01 s |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Passed |
| `guard:dead-exports`, `guard:room-authority-boundaries`, `guard:import-graph`, `guard:bus-pairing`, `guard:lifecycle-writes`, `guard:source-complexity` | Passed |
| `guard:sw-cache-version`, `guard:release-identity` | Passed (v692 covers every runtime change) |
| `npm run test:e2e:critical` | **29 passed / 0 failed / 0 skipped / 0 flaky**, 1.3 min |

## Limits

- No browser run of a PRO room showed the dialog. The PRO path is covered by
  the unit test and by tracing the PRO join and queue code above.
- The dialog itself is the one reviewed for Standard rooms in 8.10.25, minus
  one sentence.

## Release and recovery

App-only release (`target=app`). Recovery is the ordinary Production Release
rollback to the 8.10.25 checkpoint, which only stops the dialog in PRO rooms.
