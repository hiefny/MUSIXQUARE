# Toast line length — 2026-10-15

## Scope and evidence

After the toast punctuation policy (8.10.22), many toast lines were still
longer than 50 code points:

- 921 values across 38 locales and 84 keys, measured with placeholders filled
  by realistic sample values.
- By length: 564 had 51–60 code points, 292 had 61–80, 63 had 81–100, and 2
  had more than 100.
- English had 7. Korean, Japanese and Chinese had none.
- The locales with the most were Greek (52), Italian (50) and Polish (45).
- The keys with the most locales were `account.delete_pending` and
  `system_audio.desktop_only` (38 each), then
  `system_audio.coordinator_update_required` and
  `demo.external_playback_stopped` (37 each).

The toast cut every line at 50 code points and added "…". The limit
(`TOAST_MAX_LINE_CHARS`) came from `49f373ae` ("Constrain toast text length",
2026-05-15), which was written to bound file names and backend messages. It
also cut the end off authored sentences. The translation guide's rule 7 had
asked translators to shorten the wording instead (2026-10-14), but 921 values
were still over the limit.

The limit did not keep a toast on one line. `.toast > span` already wraps
(`white-space: pre-line`, maximum width `min(100vw - 48px, 560px)`), and at
phone width a 49-character line wraps to two lines anyway. A production check
at 334 px used the Spanish `account.delete_pending` toast:

- Before this change, it ended "…se están retirando de forma segu…".
- Shown in full, it wraps to five lines.

The toast also hid after 2 s, however long the text was.

Owner decisions (2026-10-15):

- Show authored copy in full instead of shortening 921 translations.
- Lengthen the display time with the text.
- Keep shortening dynamic values.
- Trim the translations that are much wordier than their source.

## Change

### Toast rendering

`src/ui/toast.ts`:

- `TOAST_MAX_LINE_CHARS` goes from 50 to 120. It now only stops a runaway line.
  The longest authored line is 106 code points (Malayalam
  `system_audio.desktop_only`).
- The text after the first colon is shortened to 64 characters, keeping a file
  extension, whenever it is longer. The colon is a Latin `: ` or the full-width
  `：` that Chinese and Japanese templates use. Before, the value was shortened
  only to fit the whole line into 50. File names and error messages follow a colon
  (`toast.file_read_error`, `error.load_failed`, `share.remote.*_failed`). The
  longest authored text after a colon is 54 (French and Turkish
  `error.https_required`).
- Quoted text keeps its 28-character limit. The longest authored quoted text
  is 18.
- Display time: 50 ms per character, line breaks excluded. It is at least the
  requested time or the 2 s default, and at most 7 s.
  - A toast of 40 characters or fewer still shows for 2 s.
  - The longest Spanish example shows for about 6 s.
  - A caller's requested time is never shortened.

Guard and tests:

- `src/i18n/__tests__/toast-copy-policy.test.ts` reads the three limits and the
  colon pattern from `toast.ts`, and pins the limits at 120, 64 and 28. It checks that every authored
  toast line, text after a colon and quoted text in every locale stays within
  them, plural forms included, so the toast never cuts authored copy.
- `src/ui/__tests__/toast.test.ts` covers:
  - a colon value cut at 64 characters with its extension kept, after a Latin
    or a full-width colon;
  - a quoted value cut at 28;
  - a long authored sentence shown in full;
  - a runaway line cut at 120;
  - display time scaling, with its 7 s cap;
  - a requested display time that is never shortened.

  Five of these fail on the previous code.
- Translation guide rule 7 now describes this behaviour.
- The update notices keep their own 50-character contract, now as a
  compactness rule rather than a truncation limit.

### Verbose translations

Candidates were translations at least 1.6 times the English length whose
longest line passed 50 code points. Length counted approximate graphemes, with
placeholders filled. That gave 109 candidates.

- **76 trimmed.**
  - 69 of them added words the source does not have, or used a roundabout
    structure. Examples:
    - Italian "we recommend adjusting … directly";
    - Polish and Russian "copied to the clipboard";
    - "playback of the preloaded file failed" in 17 locales, now "preloaded
      playback failed";
    - Filipino "participants connected remotely".
  - 7 followed the source closely but had a sentence structure that could be
    shortened:
    - the system-audio sync notice in French, Italian, Polish and Romanian;
    - the demo tour notice in Spanish and Greek;
    - the Spanish "no playable tracks".
- **33 unchanged:**
  - 21 values of five toast keys that no code uses: `toast.yt_host_sync_sent`,
    `toast.host_sync_not_recommended`, `toast.host_sync_requested`,
    `toast.host_only` and `toast.host_only_youtube`. Removing those keys is a
    separate cleanup.
  - 12 translations that follow the source closely and are long only because
    of the language.
- **1 more outside the candidates:** the Italian demo-stop notice (86 → 72
  code points), which the owner saw among the longest toasts.

In total, 77 values changed in 20 locales: bg, cs, da, de, el, es, fa, fil,
fr, hu, it, nb, nl, pl, pt-br, ro, ru, sv, tr and uk. They keep the source
meaning, line breaks, placeholders, ellipsis style and the toast punctuation
policy. Examples:

| Key | Locale | Before | After |
| --- | --- | --- | --- |
| `toast.yt_rendezvous_host_paused` | it | La riproduzione dell’host è in pausa: è stata allineata solo la posizione corrente (82) | L’host è in pausa, allineata solo la posizione (46) |
| `player.seek_unavailable_system_audio` | el | Η μετακίνηση της θέσης αναπαραγωγής δεν είναι διαθέσιμη κατά την κοινοποίηση ήχου συστήματος (92) | Δεν μπορείτε να αλλάξετε θέση όσο κοινοποιείται ο ήχος συστήματος (64) |
| `transfer.preload_fail` | de | Wiedergabe der vorgeladenen Datei fehlgeschlagen, wird neu geladen... (69) | Vorgeladene Wiedergabe fehlgeschlagen, wird neu geladen... (57) |
| `chat.debug_copied` | pl | Informacje diagnostyczne zostały skopiowane do schowka / Jeśli wystąpił błąd, prześlij te informacje deweloperowi | Skopiowano informacje diagnostyczne / Jeśli wystąpił błąd, wyślij je deweloperowi |

The pinned seek copy in `translations.test.ts` now uses the new Spanish,
French, Italian and Brazilian Portuguese wording. Its contract still holds:
the message names the playback position, differs from the sync notice, and
stays on one line.

### Review fixes

The Codex review of pull request #350 found two problems, both fixed before
merge:

- The 64-character cap looked only for a Latin `: `. Chinese and Japanese
  templates put file names and error messages after a full-width `：`, so a
  long value there could reach the 120-character line cap. The toast and the
  guard now recognise both colons, and a unit test covers the full-width case.
- The first trim of `transfer.preload_fail` in 17 locales said "preloading
  failed". The toast shows when playing an already preloaded track fails
  (`src/player/decode.ts`), so the translations now say "preloaded playback
  failed". They remain shorter than before the trim.

### Result

- Toast values with a line over 50 code points went from 921 to 875. Those
  lines are shown in full.
- Translations at least 1.6 times the English length went from 109 to 40:
  - the 33 unchanged candidates;
  - 7 `transfer.preload_fail` translations that need the longer "preloaded
    playback" wording. The English source is unusually terse (34 characters).

## Verification

Environment: Windows 11 Pro local worktree, Node 24.13.1 (the repository pins
24.20.0, which pull request CI uses), Vitest 5.0.3, Playwright 1.63.0 with
Chromium.

Tested source: **`aeffc1a63b38299f103d0112870827d54e0bd1ba`** (8.10.23, cache
epoch v689), branch `agent/toast-line-length`, clean tree before and after the
run. It includes both review fixes. Later commits change documentation only.
These are local and branch results, not the exact-main release candidate.

| Check | Result |
| --- | --- |
| Full `vitest run` | 564 files, **12,734 passed / 0 failed / 0 skipped**, 162.74 s |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Passed, zero lint warnings |
| `npm run test:e2e:critical` | **29 passed / 0 failed / 0 skipped / 0 flaky**, 1.2 min |
| Browser tests that wait on toasts (`audio-effects`, `settings-descriptions`) | **24 passed / 0 failed**, 2.1 min |
| `guard:sw-cache-version`, `guard:release-identity` | Passed (v689 covers every runtime change) |

The same checks had passed at `e6b3b48a`, before the review fixes, with 12,733
unit tests. The fixes add the full-width colon test.

Not verified:

- long toasts on physical devices or in WebKit;
- right-to-left layout of long toasts in a real browser;
- the full serial browser suite;
- production behavior.

## Limits

- Long toasts grow tall on phones and stay up to 7 s. The longest Spanish
  example wraps to five lines at 334 px.
- A file name or error message is still cut. The cut now happens at 64
  characters after the colon, instead of wherever the whole line reached 50.
- The trimmed translations were written and reviewed by the author, not by
  native speakers.
- Physical devices, WebKit, right-to-left layout of long toasts in a real
  browser and the full serial browser suite are unverified.

## Release and recovery

App-only release (`target=app`). Recovery is the ordinary Production Release
rollback to the 8.10.22 checkpoint. It restores the 50-character cut, the
fixed 2 s display and the previous translations.
