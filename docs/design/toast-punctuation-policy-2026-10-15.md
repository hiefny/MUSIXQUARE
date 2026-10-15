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

Pending.

## Follow-ups

- 905 toast values still have a line over 50 characters, which a toast cuts
  off with an ellipsis. The longest is Malayalam `system_audio.desktop_only`,
  at 106 characters. Fixing these needs copy work in each locale.
- Copy that only appears in dialogs, chat or inline errors keeps its periods.
  This policy covers toasts only.

## Release and recovery

App-only release (`target=app`). The change is copy, one CSS declaration and
two tooltip assignments. Recovery is the ordinary Production Release rollback
to the 8.10.21 checkpoint, which restores the periods.
