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

App **8.10.26/v692** shipped through
[Production Release 38806931867](https://github.com/hiefny/MUSIXQUARE/actions/runs/38806931867),
attempt 1, target `app`, Developer API D1 application `false`. The deploy job
completed successfully at **2026-10-16 06:06:19 KST** using the immutable
candidate from exact-main CI `38805172538` for
`476e42b11aa504a935b38e318e9c0ea328cd4345`. No rollback was needed; the recovery job was skipped.

- Exact-main CI ran 11 jobs: 567 unit files, 12,767 passed / 0 failed / 1
  skipped (the Windows-only cross-drive path check on Linux), 17 candidate
  browser and 29 critical browser tests passed, and every coverage, static and
  build gate passed. On the pull request, the lint and types jobs hung while
  installing dependencies on the runner; they were cancelled and passed on a
  rerun (attempt 2). The Codex review completed with no findings.
- App version `b85d4314-a21e-4614-83e0-16d2f2443b29` became
  `a4b4004f-5be3-47fd-a048-836085fb177b`. Final deployment ownership was
  verified at 06:06:13.268 KST, and the coherent production marker records the
  exact SHA and target `app`.
- The partial-release compatibility recheck at 06:05:24.816 KST was
  compatible. The five unselected Workers were not deployed and keep the
  `d9364cd9` identities in `docs/release-record.md` §1; the PRO smoke re-read
  pro-room `8d5d44c0`. The new App deployment identity is in the 90-day run
  artifact `production-deployments-476e42b11aa504a935b38e318e9c0ea328cd4345-38806931867-1`.
- App generation (`main-DWmHTJR9.js`, 27 assets converged), anonymous App
  account boundary, current PRO public boundary and Standard HTTPS signaling
  smokes passed. Out-of-scope Worker smokes were skipped, not counted as passes.
- Public checks at 06:07 KST returned HTTP 200 for `/`, the v692 service worker,
  `bootstrap.js?cache=v692`, `main-DWmHTJR9.js` and `main-B0bF4u0B.css`. The
  public main bundle carries `dialog.keep_open_message_pro`.
- [Operations Drift Audit 38807376083](https://github.com/hiefny/MUSIXQUARE/actions/runs/38807376083)
  succeeded. Its 06:07:35.304 KST report records **31 pass / 0 fail / 5
  manual-only**; manual checks are not treated as completed.

The immutable recovery checkpoint captured at 06:04:48.841 KST
(`production-recovery-checkpoint-476e42b11aa504a935b38e318e9c0ea328cd4345-38806931867-1`)
preserves the previous App `45850f44f74a4ab3a4094d22bd22dc3637e30fec`,
8.10.25/v691, version `b85d4314-a21e-4614-83e0-16d2f2443b29`. Rolling back to
it only stops the dialog in PRO rooms. Mixed versions are safe. The checkpoint
is not a user-data backup; no data migration is needed and existing recovery
floors remain binding.
