# Fonts

The app draws its text with **Inter** and **Noto**, all self-hosted. The owner
chose this on 2026-10-31 so that the Korean and the English UI draw the same
content (track titles, chat, names, search results) with the same faces, the
same widths and the same pixels; only the app's own translated strings
differ. The train report is
[docs/design/app-font-inter-noto-2026-10-31.md](../docs/design/app-font-inter-noto-2026-10-31.md).

Pretendard is no longer used by the app. It stays deployed for the public
pages (Blog, History, the design system, About and its sibling pages,
`account-complete.html`) and for the pre-rendered share images until those
switch in a later train.

## Faces

| Family                                  | Files the app serves (inputs)                                                                 | Draws                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Inter 4.001 (Google Fonts v20)          | `fonts/app/inter/`, 7 subsets (`fonts/inter/`)                                                | Latin, digits, Cyrillic, Greek and the marks in its own cmap                            |
| Noto Sans KR 2.004 (Google Fonts v40)   | `fonts/app/noto-sans-kr/`, 120 shards (`fonts/noto/noto-sans-kr/`)                            | Hangul (only this family), Hanja, CJK punctuation and symbols Inter lacks (※ ― ‥ ‰ ‼ →) |
| Noto Sans JP, SC, TC (Google Fonts)     | `fonts/app/noto-sans-{jp,sc,tc}/`, 120, 95 and 98 shards (`fonts/noto/noto-sans-{jp,sc,tc}/`) | kana (only JP), Han and CJK marks in the Han order of the UI                            |
| Noto Sans Thai, Arabic, Hebrew, 8 Indic | `fonts/noto/noto-sans-*/`                                                                     | their own script                                                                        |

The Inter and CJK files the app serves are copies with the app's line box
baked in (see [Baked line box](#baked-line-box)). The folders in parentheses
hold their inputs; `fonts/noto/noto-sans-{jp,sc,tc}/` are Google's shards,
which About, its sibling pages and the sitemap page keep using unchanged.

- Inter's input is the seven variable subsets (`opsz` 14-32, `wght` 100-900)
  exactly as Google serves them. Its Latin subset keeps the contextual
  alternates (`calt`), so `->` draws as an arrow, `3x4` as `3×4` and a colon
  between digits sits raised, as Pretendard drew them.
- Noto Sans KR's input is Google's 120 numbered shards under Google's file
  names, re-encoded without the Korean `locl` lookup. Google's shards register
  `locl` for Korean in every script, so with `lang="ko"` a few marks (for
  example `‼` next to Hangul) take a Korean form that no other UI shows.
  Without it the Korean and English UIs shape every character alike. The
  copies keep the cmap, every outline and every other layout feature; only
  the Korean forms that `locl` produced, and lookups that touched nothing
  else, are gone. Shard #118 also loses its GDEF table, which held only an
  item variation store that the removed lookups alone used. Their bytes
  therefore differ from Google's while the names stay, and each copy keeps
  Google's copyright (name ID 0, with the Reserved Font Name) and license URL
  (name ID 14), since the files are served under `/assets/` with no license
  file beside them. The SIL OFL 1.1 allows this: the font's Reserved Font Name
  is "Source", not "Noto". The baked copies of every Inter and CJK face keep
  the name table unchanged as well.
- The four unnumbered Noto Sans KR shards (Latin, Cyrillic, Vietnamese) are
  not shipped: Inter draws those ranges.

## Sheets

The app's 16 font sheets are listed in `src/i18n/app-font-contract.ts`:

- `css/fonts/app/` holds the six sheets `scripts/fonts/build-font-sheets.mts`
  generates: `font-inter.css` (7 faces), `font-noto-kr.css` (120),
  `font-noto-jp.css` (120), `font-noto-sc.css` (95), `font-noto-tc.css` (98)
  and `font-noto-thai.css` (1). Do not edit them by hand.
- The ten single-script sheets (Arabic, Hebrew and the eight Indic scripts)
  are Google's sheets in `css/fonts/`, shared with the static pages.

The generator starts from `fonts/font-sources.json` and Google's sheets in
`css/fonts/` (left unchanged for the static pages) and edits the ranges so
every script has exactly one family:

- Inter draws what its cmap covers inside its Google ranges. Those code
  points are cut from the four CJK families by Inter's cmap, never by its
  declared ranges, so the marks Inter lacks stay in the CJK families instead
  of falling to a device font.
- The Hangul Noto Sans KR draws is removed from JP, SC and TC, and the kana
  Noto Sans JP draws from KR, SC and TC, each found by block or by Unicode
  Script (parenthesized and circled Hangul such as ㈜ and ㉠, circled and
  square katakana such as ㋖ and ㌔ sit outside the blocks). A character the
  owner lacks, such as the halfwidth jamo only JP draws, stays where it is
  drawn.
- Invisible marks (U+200B-200F, U+202F, U+2060-2064, U+FEFF) belong to no CJK
  family. In the shared stack Inter draws U+200B and U+FEFF, Noto Sans Thai
  U+200C and U+200D (a script-first UI's own face draws them there), Noto Sans
  Arabic U+200E and Noto Sans Hebrew U+200F; the device font draws U+202F and
  U+2060-2064.
- Each CJK face declares only the characters its own file draws, so an emoji
  or a stray mark never makes the browser download a shard that cannot draw
  it. Faces left empty are dropped.
- Every Inter and CJK face carries the size and line-box descriptors of
  `src/i18n/font-metrics.ts` (CSS cannot import, so a parity test pins each
  face to that one home): CJK `size-adjust` 94% with `ascent-override`
  101.29%, `descent-override` 25.66% and `line-gap-override` 0%; Inter 97.2%,
  97.96%, 24.82% and 0%. The overrides are Pretendard's ascent and descent
  divided by the size, so line boxes stay where Pretendard put them. Each
  face points at its baked copy in `fonts/app/`, which holds the same box in
  its own tables.

Generated sheets carry a `font-` prefix so their emitted names never collide
with the static pages' `noto-*.css` sheets, which the build and the
retryable stylesheet loader match by name. Keep that prefix for any new app
sheet.

## Baked line box

Safari applies `size-adjust` but not `ascent-override`, `descent-override` or
`line-gap-override`, so a `line-height: normal` line there takes its box from
each file's own vertical metrics. With Google's files a 15 px Hangul line was
about 20 px high instead of 18 px, and with several playlists the Playlist
title sat higher than the other tab titles. The owner chose on 2026-11-01 to
bake the box into the files rather than patch `line-height` in CSS
([report](../docs/design/app-font-baked-metrics-2026-11-01.md)):

- `scripts/fonts/build-app-faces.mts` (`npm run generate:app-faces`) copies
  every Inter and CJK face the app sheets keep into `fonts/app/<family>/`,
  under its input's file name, with the box of `src/i18n/font-metrics.ts` in
  `hhea` and the OS/2 typo metrics and `USE_TYPO_METRICS` set: 2006 / 508 / 0
  of 2048 units for Inter, 1013 / 257 / 0 of 1000 for the CJK families. Those
  are the nearest units to the descriptors, which a browser scales by
  `size-adjust` just as it scales the file's own metrics.
- Nothing else changes: outlines, advances, cmap, layout tables, `BASE`,
  `vhea` and `vmtx` stay, and so do the win metrics (Inter 2269 / 660, CJK
  1160 / 288), so a renderer that clips glyphs to them (GDI) clips nothing
  new. With `USE_TYPO_METRICS` set, no current browser takes line spacing from
  them.
- The sheets keep the four descriptors, so Chromium and Firefox draw exactly
  what they drew with the input files. Whether the three overrides stay is an
  owner question in the report.
- Whole units cannot equal two-decimal percentages: the baked box is within
  0.0004 em of the descriptors, not equal to them. A line drawn from the files
  (Safari) can therefore be 1 px taller or shorter than one drawn from the
  descriptors (Chromium, Firefox) at sizes next to a pixel rounding boundary:
  a CJK line at 14.5 px, and the fluid `clamp()` sizes of the setup overlay
  and the desktop demo at some window widths and heights (the report lists
  them). A WebKit that applies the overrides, as Playwright's does, applies
  them without rounding the ascent and descent, so its baselines then fall
  between pixels.
- Safari before 17 ignores `size-adjust` too and draws the baked units
  unscaled: nearer the shipped boxes than before, not equal.
- `fonts/app-faces.json` records each copy: the digests of its input and of
  itself, the box, the win metrics it keeps and the wawoff2 version. Without
  `--record`, a face baked again from its recorded input and box must give its
  recorded bytes, also after a wawoff2 update (an update that gives the same
  bytes only replaces the recorded version); otherwise the run writes nothing
  and stops. `--record` accepts new bytes after review, and `--check` bakes
  every face again in memory (about 100 s).

## Stacks

`css/style.css` defines the stacks on `:root`:

- `--font-sans-ui` is Inter, then the four CJK families in the Han order,
  then the script families, then the system fonts. The Korean, English and
  every other UI without its own Han order or script face read it as
  `--font-sans`, so the Korean and English stacks are one variable.
- Han order: the Japanese, Simplified Chinese and Traditional Chinese UIs put
  their own family first (`--font-sans-ja`, `--font-sans-cjk-sc`,
  `--font-sans-cjk-tc`). Every other UI uses one order chosen once per page
  from `navigator.languages` (`src/i18n/startup-han-order.ts`: the first of
  ko, ja, zh-Hans or zh-CN, zh-Hant or zh-TW or zh-HK; Korean when none is
  found). The app sets `html[data-mxqr-han-order]` for the Japanese and
  Chinese orders and nothing for Korean.
- The Indic, Arabic and Hebrew UIs put their own script face first, then the
  shared stack; their ranges hold no Latin, so Latin is still Inter.
- Text the app detects as Japanese, Simplified or Traditional Chinese
  (`src/ui/user-text-font.ts`, from the text alone) takes that language's
  order through `.user-text-font-ja`, `-zh-hans` or `-zh-hant`, in every UI.
  Han without a language marker follows the UI's order.
- The language picker draws each native name with its language's stack, so
  the names look the same in every UI.

## Loading

`src/i18n/locale-fonts.ts` is the only code that loads the app's font sheets
and asks the browser for their faces; its timing values live in
`src/i18n/font-loading-policy.ts`. Nothing font-related is in the initial
HTML, CSS or JavaScript graph and no font is preloaded, so the first paint
never waits for a font (the initial transfer budget holds eager font bytes at
0). Declaring a sheet downloads nothing; the browser fetches a shard when
text needs one of its characters.

- Phase A, when a language applies: Inter, the UI's own script sheet, Noto
  Sans KR for every UI that is not Japanese or Chinese, and the first family
  of its Han order. The Korean and English UIs declare the same sheets at the
  same moment under every Han order.
- Phase B, after window load and the first idle slice: every other sheet, so
  every family is declared in every UI. It ignores data saver.
- Phase C, 10 s after phase B starts: the Korean, Japanese and Chinese UIs
  load their own family's most frequent shards
  (`src/i18n/font-prefetch-samples.ts`, generated) in idle batches of three,
  at most 20 faces and 400,000 B per page load, skipping shards already
  loaded. A batch runs only once the family's sheet is declared, and counts
  against the budget only when it drew a face. Faces are read only inside idle
  slices, each shard's face found by its recorded place in the sheet. It is
  skipped on data saver, 2G or offline and pauses while the page is hidden.
- A sheet attempt that neither loads nor fails within 8 s (doubled for each
  later attempt of the sheet, up to 64 s) is abandoned. A failed sheet is
  retried by a timer three times, 10 s apart in a visible idle slice and never
  while offline, and at once on `online`, when the page becomes visible and
  when it returns from the back-forward cache, each of which grants the three
  timer retries again. A face whose download failed stays in `error` for the
  life of the document, so the same events (and a failed prefetch batch)
  declare its sheet again, at most three times per sheet per page.

The service worker does not precache fonts; the hashed sheets and shards go
through its ordinary cache-first asset path. It does install the font owner
chunk itself with the app shell, and `src/i18n/index.ts` imports the owner
again on `online` and when the page becomes visible if its import failed, so
a first launch offline after an update recovers its fonts. The old
`musixquare-optional-vN` caches that held Pretendard are retired on update.

The static pages keep their own loader (`src/i18n/static-page-fonts.ts`, used
by the sitemap page) and Google's original sheets in `css/fonts/`, which
About links through `vite.config.ts`.

## Provenance and regeneration

- `fonts/font-sources.json` is the provenance record. For each file it keeps
  the Google URL, Google's `unicode-range`, and the sha256 and size of both the
  downloaded (`source`) and the committed (`shipped`) bytes, plus the versions
  of the tools that made the Noto Sans KR copies (subset-font 2.9.0 on
  harfbuzzjs 1.6.3, fontverter 2.0.0, wawoff2 2.0.1, all GSUB and GPOS
  features except `locl`, every glyph kept, name IDs 13 and 14 kept). The
  builder checks each copy's cmap, outlines and metrics at wght 400 and 700,
  its shaping with and without Korean at the default instance and at wght 400
  and 700, and its copyright and license names, before it writes the copy.
- `fonts/app-faces.json` is the record of the baked app faces (see
  [Baked line box](#baked-line-box)), written by `npm run generate:app-faces`.
- `npm run generate:font-sheets` first bakes the app faces that are new or
  changed, then writes `css/fonts/app/` and `src/i18n/font-prefetch-samples.ts`
  (`-- --check` compares the sheets and checks the baked faces against their
  record without baking them again; `npm run generate:app-faces -- --check`
  bakes them again).
- `npm run generate:noto-kr -- --check` verifies the shipped Noto Sans KR
  files against the record and that no `locl` lookup is left.
- To refresh from Google, download the CSS and the files into a new empty
  folder and run `node scripts/fonts/record-font-sources.mts` (its header lists
  the arguments), then `npm run generate:noto-kr -- --source <folder> --record`
  and `npm run generate:font-sheets`. Without `--record`, the Noto Sans KR
  build must reproduce the recorded shipped bytes exactly.

## Verification

- `npm run guard:font-assets` checks the source: the Inter and Noto Sans KR
  inputs against `fonts/font-sources.json`, the baked app faces against
  `fonts/app-faces.json` (the box in `hhea` and the OS/2 typo metrics with
  `USE_TYPO_METRICS`, the input's win metrics, valid checksums and no other
  change from the input), the generated sheets
  against their generator, every face self-hosted with the descriptors of its
  family, every text stack (the Korean and English ones identical under every
  Han order), no app rule that applies in only one of the Korean and English
  UIs whatever it sets (but the recorded rules for translated UI copy), no
  rule that turns Inter's contextual alternates off, no `@font-face` in
  `css/app.css` or its imports, one family per script (by block and by
  Unicode Script), and coverage: every non-PUA character Pretendard drew,
  every character of the catalogs and `index.html`, the KS X 1001 repertoire
  and the text symbols of the punctuation, letterlike, arrow, math, technical,
  geometric, symbol, dingbat and CJK punctuation blocks has a self-hosted face
  in every stack, except the recorded
  `scripts/fonts/uncovered-code-points.txt`, which must name exactly the gaps.
  It also checks that nothing in the app names or preloads Pretendard.
- `npm run guard:font-build` adds the build: no font in the initial graph of
  the app document or its localized copies, each app sheet its own lazy CSS
  asset with root-relative WOFF2 files, the built Inter and CJK faces equal
  to their baked copies, no font in the service worker's install manifests
  (which do install the font owner chunk), About bound to the original sheets,
  and Pretendard deployed once.
- Unit tests: `src/i18n/__tests__/font-*.test.ts` (`font-baked-metrics`
  reads the tables of every app face itself), `app-face-metrics.test.ts`,
  `locale-fonts.test.ts`, `static-page-fonts.test.ts` and
  `src/core/__tests__/app-font-guard.test.ts`.
- `e2e/font-line-boxes.test.ts` (local, on the e2e build) serves the Inter
  and CJK sheets without the three overrides, as Safari reads them, and
  requires the line boxes of Latin, Hangul, mixed, kana and Han lines at 13,
  15 and 28 px and the four tab titles to stay where the shipped sheets put
  them.
- `e2e/font-baked-pixels.test.ts` (local, on the e2e build) answers every
  request for a baked face with its input file in a second context and
  requires the start screen, the four tab screens and the chat in the Korean
  and English UIs, and desktop Home and Playlist, to be the same PNG as with
  the baked faces.
- `e2e/font-identity.test.ts` (local, on the e2e build) draws the same chat
  and track titles in a fresh Korean and a fresh English UI and compares the
  faces of every character, the widths and the pixels, and checks what each
  UI fetches. Its line of symbols no self-hosted face draws (☺ ℹ ∼ ◈ ‣) is
  recorded for both UIs and kept out of the comparison until a face draws
  them.

## Licensing and fallback behavior

- A missing font does not prevent the app shell from loading, but affected
  text falls back to a system font until the font arrives. A character no
  self-hosted face draws (the recorded gaps: some IPA letters, combining
  marks, sub- and superscripts, and letterlike, math, technical, symbol and
  dingbat characters such as ☺ ℹ ∼ ≒ ◈) always uses a system font, which the
  browser picks by the page language, so it can differ between the Korean and
  English UIs.
- Inter is licensed under the **SIL Open Font License 1.1** (see
  `INTER_LICENSE.txt`).
- Noto fonts are licensed under the **SIL Open Font License 1.1** (see the
  Noto license files in this directory).
- Pretendard, kept for the public pages and the share images, is licensed
  under the **SIL Open Font License 1.1** (see `PRETENDARD_LICENSE.txt`).
  `fonts/PretendardVariable.woff2` is the canonical source copy; the deployed
  copy at `public/designsystem/fonts/PretendardVariable.woff2` must be
  byte-identical.
