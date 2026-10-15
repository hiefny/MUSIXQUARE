# Update notice line breaks — 2026-10-15

## Scope and evidence

The owner asked for each sentence of the "MUSIXQUARE was updated" notices to sit
on its own line. Four keys carry those notices, each with two sentences on one
line:

| Key | Where it shows |
| --- | --- |
| `chat.update_available_tab_system_message` | New version waiting, browser tab: room chat, or a toast on the create/join screens |
| `chat.update_available_app_system_message` | The same notice in an installed home-screen app |
| `dialog.sw_update_msg` | Update dialog on the first setup screen, and the setup host/join error line |
| `dialog.feature_refresh_msg` | Refresh dialog after a lazily loaded feature fails following an update |

Every surface already renders line breaks: the toast sets `innerText` on a
`pre-line` span, `.dialog-message` is `pre-wrap`, and `.setup-inline-error` and
`.chat-text` are `pre-line`.

The toast also truncates any line longer than 50 characters with an ellipsis.
Before this change, 102 of the 126 toast-capable values (the two chat keys and
`dialog.sw_update_msg` in 42 locales) were longer than 50 characters on their
single line. Shown as toasts, those values were cut off.

## Change

- All 42 locales break after the first sentence of the four notices.
  - Most locales split at `. `.
  - Hindi, Bengali and Punjabi split at `। `, and Urdu at `۔ `.
  - Japanese and Chinese split after `。`.
  - Thai, which separates sentences with a space and no terminator, splits at
    that space.
- Three home-screen lines were shortened to stay within the toast limit:
  - Spanish: "Vuelve a abrir la app para empezar a usarla."
  - Tamil: drops the redundant pronoun.
  - Ukrainian: "Вона почне діяти після перезапуску застосунку."
- After the change, no line of the toast-capable notices exceeds 50 characters.
- The factual copy contracts now pin:
  - two lines per notice;
  - each line within the toast limit;
  - the Korean and English copy with its line break;
  - a one-line refresh-dialog title.
  
  This replaces the earlier "no line breaks" rule for the refresh dialog (owner
  decision 2026-10-15).

## Verification

Environment: Windows 11 Pro local worktree, Node 24.13.1 (the repository pins
24.20.0, which pull request CI uses), Vitest 5.0.3, Playwright 1.63.0 with
Chromium. jq was supplied through `MXQR_TEST_JQ_PATH`.

Tested source: **`97e1b6434e679774d2289761d77438218e4727cd`** (8.10.21, cache
epoch v687), branch `agent/update-notice-line-breaks`, clean tree before and
after the run. Later commits on the branch change documentation only. These are
local and branch results, not the exact-main release candidate.

| Check | Result |
| --- | --- |
| Full `vitest run` | 563 files, **12,725 passed / 0 failed / 0 skipped**, 181.59 s |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Passed, zero lint warnings |
| `npm run test:e2e:critical` | **29 passed / 0 failed / 0 skipped / 0 flaky**, 1.2 min |
| `guard:sw-cache-version`, `guard:release-identity` | Passed (v687 covers the copy change) |

Not verified: the rendered notices on physical devices, right-to-left layout of
the two-line notices in a real browser, and production behavior.

## Release and recovery

App **8.10.21/v687** shipped through
[Production Release 38693244484](https://github.com/hiefny/MUSIXQUARE/actions/runs/38693244484),
attempt 1, target `app`, Developer API D1 application `false`. The deploy job
completed successfully at **2026-10-15 15:37:16 KST** using the immutable candidate
from exact-main CI `38692452260` for `a1d52c994a18657afb805693fc3a53eaf24f79aa`.
No rollback was needed; the recovery job was skipped.

- Exact-main CI ran 11 jobs: 563 unit files, 12,724 passed / 0 failed / 1 skipped
  (the Windows-only cross-drive path check on Linux), 17 candidate browser and
  29 critical browser tests passed, and every coverage, static and build gate
  passed.
- App version `bd269acb-527b-4cce-9601-af45ba319c75` became
  `9195f720-54de-4b17-b362-300b594b0259`. Final deployment ownership was verified
  at 15:37:09.325 KST, and the coherent production marker records the exact SHA
  and target `app`.
- The partial-release compatibility recheck at 15:36:39.334 KST was compatible.
  The five unselected Workers were not deployed and keep the `d9364cd9`
  identities in `docs/release-record.md` §1; the PRO smoke re-read pro-room
  `8d5d44c0`. The new App deployment identity is in the 90-day run artifact
  `production-deployments-a1d52c994a18657afb805693fc3a53eaf24f79aa-38693244484-1`.
- App generation (`main-Dsx5agp5.js`, 27 assets converged), anonymous App account
  boundary, current PRO public boundary and Standard HTTPS signaling smokes
  passed. Out-of-scope Worker smokes were skipped, not counted as passes.
- Public checks at 15:40:37 KST returned HTTP 200 for `/`, the v687 service
  worker, `bootstrap.js?cache=v687`, `main-Dsx5agp5.js` and `main-BNiplmKU.css`.
  The public English bundle carries both update notices as two lines.
- [Operations Drift Audit 38693567868](https://github.com/hiefny/MUSIXQUARE/actions/runs/38693567868)
  succeeded. Its 15:38:25.082 KST report records **31 pass / 0 fail / 5 manual-only**;
  manual checks are not treated as completed.
- The Codex review of pull request #346 failed twice with an infrastructure error
  (the reviewed commit was not found), so no automated review ran.
- The rendered notices were not checked on physical devices after release.

The immutable recovery checkpoint captured at 15:35:54.200 KST
(`production-recovery-checkpoint-a1d52c994a18657afb805693fc3a53eaf24f79aa-38693244484-1`)
preserves the previous App `27dceedc79c306142fd0fe78801cf1ca383c56ce`, 8.10.20/v686,
version `bd269acb-527b-4cce-9601-af45ba319c75`. Rolling back to it restores the
single-line notices and their toast truncation. Mixed versions are safe because
only copy changed. The checkpoint is not a user-data backup; no data migration is
needed and existing recovery floors remain binding.
