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

App-only release (`target=app`); the change is copy only. Recovery is the
ordinary Production Release rollback to the 8.10.20 checkpoint, which restores
the single-line notices and their toast truncation.
