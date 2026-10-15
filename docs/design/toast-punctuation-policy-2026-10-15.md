# Toast punctuation policy — 2026-10-15

## Scope and evidence

The owner set a copy policy for every toast: use as few periods as possible,
and put each sentence on its own line instead of separating sentences with a
period and a space. It applies to all 42 locales.

How a toast renders:

- `showToast` (`src/ui/toast.ts`) splits the text at `\n`, shortens each line
  to 50 characters with an ellipsis, and sets `innerText` on a `pre-line`
  span. A line break therefore shows as a new line.
- The events page (`browser/classic-runtime/events/event.ts`) has its own
  toast, which sets `textContent` on `#toast`. It now uses
  `white-space: pre-line` so a line break shows there too.

Which copy is toast copy:

- Every `toast.*` key (74 keys).
- 133 keys from other namespaces that reach a toast. Some are passed to
  `showToast` or `ui:show-toast` directly. Others go through a message helper:
  - room capability messages;
  - main sync and seek availability;
  - operator upload and queue-mutation errors;
  - setup connection errors;
  - PRO playlist errors;
  - YouTube rendezvous, remote share, system audio, decode failure and account
    nickname errors.
- The list was built by scanning every toast call in `src/` and tracing each
  helper. Tracing found five keys the first pass missed:
  `toast.member_management_required`, `toast.chat_notice_required`,
  `toast.room_owner_required`, `error.host_disconnected` and
  `error.host_conn_error`.
- Two of the keys also have plural forms outside the dictionary:
  `toast.added_tracks` and `toast.unsupported_files_excluded`.

Out of scope:

- Dialog, chat and inline copy that never reaches a toast, including the
  dialog fallback toast, which reuses dialog copy.
- The account completion popup and the events page's inline login and
  nickname messages. They are page text, not toasts.
- The update-completion toast (`src/core/sw-update-completion.ts`) and the
  landing page's copy toasts already had no periods.

## Change

The rule:

- A sentence-final period goes away: `.`, `。`, `．`, the danda `।` and the
  Urdu full stop `۔`.
- When another sentence follows on the same line, a line break replaces the
  period and the space.
- Question and exclamation marks (`?`, `!`, `？`, `！`, `؟`) stay. When another
  sentence follows one, a line break comes after it.
- An ellipsis (`...`, `…`) stays, because it marks progress.
- Abbreviations keep their periods, for example `etc.`, `usw.`, `osv.`,
  `jne.`, `itp.`, `apod.`, `stb.`, `vb.`, `ecc.`, `enz.`, `dll.`, `atbp.`,
  `v.v.`, `κ.λπ.`, `и др.`, `इ.`, `max.`, `maks.`, `макс.` and `pr.`.
  A first automated pass had split `maks. 200 MB` (Danish, Indonesian,
  Norwegian, Polish) and `макс. 200 МБ` (Russian) across two lines. The review
  caught it before commit.

Line structure:

- Translations keep the line breaks of the English reference, as an existing
  contract test requires.
- The two YouTube rendezvous failures (`toast.yt_rendezvous_no_data` and
  `toast.yt_rendezvous_timeout`) are two sentences in the Korean source. They
  are now two lines in English and every other locale too.
- Where the source is one sentence, translations that used two sentences now
  join them like the English copy does:
  - `transfer.preload_fail`: German, French, Italian, Japanese, Polish,
    Brazilian Portuguese, Russian, Turkish;
  - `youtube.video_unavailable`: Italian, Japanese, Polish, Russian, Turkish;
  - `toast.connection_closing`: Italian, Polish, Russian, Turkish;
  - `error.https_required`: Japanese.
- Chinese splits the four retry messages that are two lines in English at
  their comma.
- Thai separates sentences with a space. Eight values whose source has two
  sentences now break the line at that space. Spaces that act as commas stay.

Numbers (207 keys × 42 locales = 8,694 values):

- 3,841 values changed.
- 334 line breaks were added.
- Values with a line longer than the 50-character toast limit went from 1,076
  to 905.

Other surfaces:

- The 133 shared keys keep one copy. Dialogs, chat system messages and inline
  setup errors that reuse them now show the same wording without periods.
  - `.dialog-message` is `pre-wrap`.
  - `.chat-text` and `.setup-inline-error` are `pre-line`.
- `index.html` keeps its English fallback for `playlist.empty_hint` aligned:
  "No media yet".
- The sync button and seek slider tooltips used to turn the line break into a
  space. Without the period, that would read "Not ready yet Try again in a
  moment", so the `title` now keeps the line break.
- Two accessible names reuse two-sentence toast copy: the seek slider's
  `aria-valuetext` (which still turns the line break into a space) and the
  locked volume group's `aria-label`. Screen readers lose the short pause the
  period gave between the sentences.
- The events page: its seven toasts drop their periods. The setup-link failure
  is two sentences and now breaks its line.

## Guard

`src/i18n/__tests__/toast-copy-policy.test.ts`:

1. Every toast key in every locale, plural forms included, must pass these
   checks:
   - no line ends with a period, even inside a closing quote (an ellipsis is
     allowed);
   - no Latin period followed by a space and a capital letter, an uncased
     letter or a placeholder (a lowercase word or a number after the space
     marks an abbreviation);
   - no full-width stop, danda, Urdu full stop, or full-width `？`/`！`
     followed by more text;
   - no `?`, `!` or `؟` followed by a space and a new sentence;
   - every line is trimmed and not empty.
2. Representative copies stay pinned, including an abbreviation
   (`maks. 200 MB`) and a kept exclamation mark.
3. Every i18n key named in a `showToast` or `ui:show-toast` call under `src/`
   must be in the list.
4. The events page toasts, the events toast's `pre-line` style and the 42
   update-completion messages must follow the policy.

Two mutation checks confirmed that the guard fails when it should:

- Restoring the old Korean dictionary failed the guard on the Korean values.
- Removing `playlist.reorder_failed` from the list failed the call-site check.

Existing tests that pinned old copy were updated to the new copy. The sync
button and seek slider tests now pin the tooltip line break. A new events page
browser test checks that the setup-link failure toast renders on two lines.

## Verification

Environment: Windows 11 Pro local worktree, Node 24.13.1 (the repository pins
24.20.0, which pull request CI uses), Vitest 5.0.3, Playwright 1.63.0 with
Chromium.

Tested source: **`f3ddaa9a7d1c7c6261072626ae8ec01cc53fd2bc`** (8.10.22, cache
epoch v688), branch `agent/toast-punctuation-policy`, clean tree before and
after the run. The next commit, `23d9da10`, changes one browser-test assertion
(below); later commits change documentation only. These are local and branch
results, not the exact-main release candidate.

| Check | Result |
| --- | --- |
| Full `vitest run` | 564 files, **12,729 passed / 0 failed / 0 skipped**, 183.93 s |
| `npm run test:e2e:critical` | **29 passed / 0 failed / 0 skipped / 0 flaky**, 1.4 min |
| Browser tests for the touched files (`asamo-event`, `audio-effects`, `chat-commands`, `demo-track`, `pro-entry-retry`) | 58 passed / 1 failed, 5.6 min. The failure was a stale assertion; see below |
| `demo-track` after the fix, at `23d9da10` | **6 passed / 0 failed** |
| `npm run typecheck`, `npm run lint`, `npm run format:check` at `23d9da10` | Passed, zero lint warnings |
| `guard:sw-cache-version`, `guard:release-identity` | Passed (v688 covers every runtime change) |

The browser-test failure had nothing to do with this change. The final demo
step has read "4. Finish tour" since the 8.10.11 translation update
(`818c87bc`), but `e2e/demo-track.test.ts` still expected "4. Quit demo". The
weekly full browser suite would fail on it as well. `23d9da10` updates the
assertion.

Not verified:

- the rendered toasts on physical devices or in WebKit;
- right-to-left layout of the two-line toasts in a real browser;
- the full serial browser suite;
- production behavior.

## Follow-ups

- 905 toast values still have a line over 50 characters, which a toast cuts
  off with an ellipsis. The longest is Malayalam `system_audio.desktop_only`,
  at 106 characters. Fixing these needs copy work in each locale.
- Copy that only appears in dialogs, chat or inline errors keeps its periods.
  This policy covers toasts only.

## Release and recovery

App **8.10.22/v688** shipped through
[Production Release 38701766660](https://github.com/hiefny/MUSIXQUARE/actions/runs/38701766660),
attempt 1, target `app`, Developer API D1 application `false`. The deploy job
completed successfully at **2026-10-15 16:55:23 KST** using the immutable candidate
from exact-main CI `38701042285` for `2e05b070fec91c19b3ebbe40e902a7f18dba0e7b`.
No rollback was needed; the recovery job was skipped.

- Exact-main CI ran 11 jobs: 564 unit files, 12,728 passed / 0 failed / 1 skipped
  (the Windows-only cross-drive path check on Linux), 17 candidate browser and
  29 critical browser tests passed, and every coverage, static and build gate
  passed. The Codex review of pull request #348 completed with no findings.
- App version `9195f720-54de-4b17-b362-300b594b0259` became
  `603d3285-365b-46f1-b64a-a9c3faa0c1df`. Final deployment ownership was verified
  at 16:55:17.229 KST, and the coherent production marker records the exact SHA
  and target `app`.
- The partial-release compatibility recheck at 16:54:42.162 KST was compatible.
  The five unselected Workers were not deployed and keep the `d9364cd9`
  identities in `docs/release-record.md` §1; the PRO smoke re-read pro-room
  `8d5d44c0`. The new App deployment identity is in the 90-day run artifact
  `production-deployments-2e05b070fec91c19b3ebbe40e902a7f18dba0e7b-38701766660-1`.
- App generation (`main-DM_zcfwH.js`, 27 assets converged), anonymous App account
  boundary, current PRO public boundary and Standard HTTPS signaling smokes
  passed. Out-of-scope Worker smokes were skipped, not counted as passes.
- Public checks at 16:56 KST returned HTTP 200 for `/`, the v688 service worker,
  `bootstrap.js?cache=v688`, `main-DM_zcfwH.js` and `main-BNiplmKU.css`. The
  public English bundle carries the new copy (for example "Could not update your
  account" and "Please try again" on separate lines, and "No media yet" without a
  period). The events page serves the `pre-line` toast style and the two-line
  setup-link failure.
- On the production Korean page, the deployed `toast.sync_no_media` copy was
  placed in the app's toast element. It rendered as two lines without periods
  ("동기화할 미디어가 없어요" / "먼저 재생할 미디어를 선택해주세요"). This checks
  rendering only; no toast was raised through a real user flow, which would have
  meant creating a production room.
- [Operations Drift Audit 38702089960](https://github.com/hiefny/MUSIXQUARE/actions/runs/38702089960)
  succeeded. Its 16:56:12.462 KST report records **31 pass / 0 fail / 5 manual-only**;
  manual checks are not treated as completed.
- The toasts were not checked on physical devices after release.

The immutable recovery checkpoint captured at 16:54:10.024 KST
(`production-recovery-checkpoint-2e05b070fec91c19b3ebbe40e902a7f18dba0e7b-38701766660-1`)
preserves the previous App `a1d52c994a18657afb805693fc3a53eaf24f79aa`, 8.10.21/v687,
version `9195f720-54de-4b17-b362-300b594b0259`. Rolling back to it restores the
periods in toasts and the single-line tooltips. Mixed versions are safe because
only copy, one CSS declaration and two tooltips changed. The checkpoint is not a
user-data backup; no data migration is needed and existing recovery floors remain
binding.
