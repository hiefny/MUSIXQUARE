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

| Family                                  | Files                                  | Draws                                                                                   |
| --------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| Inter 4.001 (Google Fonts v20)          | `fonts/inter/`, 7 subsets              | Latin, digits, Cyrillic, Greek and the marks in its own cmap                            |
| Noto Sans KR 2.004 (Google Fonts v40)   | `fonts/noto/noto-sans-kr/`, 120 shards | Hangul (only this family), Hanja, CJK punctuation and symbols Inter lacks (※ ― ‥ ‰ ‼ →) |
| Noto Sans JP, SC, TC (Google Fonts)     | `fonts/noto/noto-sans-{jp,sc,tc}/`     | kana (only JP), Han and CJK marks in the Han order of the UI                            |
| Noto Sans Thai, Arabic, Hebrew, 8 Indic | `fonts/noto/noto-sans-*/`              | their own script                                                                        |

- Inter ships the seven variable subsets (`opsz` 14-32, `wght` 100-900)
  exactly as Google serves them. Its Latin subset keeps the contextual
  alternates (`calt`), so `->` draws as an arrow, `3x4` as `3×4` and a colon
  between digits sits raised, as Pretendard drew them.
- Noto Sans KR ships Google's 120 numbered shards under Google's file names,
  re-encoded without the Korean `locl` lookup. Google's shards register
  `locl` for Korean in every script, so with `lang="ko"` a few marks (for
  example `‼` next to Hangul) take a Korean form that no other UI shows.
  Without it the Korean and English UIs shape every character alike. The
  copies keep the cmap, every outline and every other layout feature; only
  the Korean forms that `locl` produced, and lookups that touched nothing
  else, are gone. Their bytes therefore differ from Google's while the names
  stay. The SIL OFL 1.1 allows this: the font's Reserved Font Name is
  "Source", not "Noto".
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
- Hangul is removed from JP, SC and TC, and kana from KR, SC and TC.
- Invisible marks Inter's subsets lack (U+200B-200F, U+202F, U+2060-2064,
  U+FEFF) belong to no CJK family; the device font draws them.
- Each CJK face declares only the characters its own file draws, so an emoji
  or a stray mark never makes the browser download a shard that cannot draw
  it. Faces left empty are dropped.
- Every Inter and CJK face carries the size and line-box descriptors of
  `src/i18n/font-metrics.ts` (CSS cannot import, so a parity test pins each
  face to that one home): CJK `size-adjust` 94% with `ascent-override`
  101.29%, `descent-override` 25.66% and `line-gap-override` 0%; Inter 97.2%,
  97.96%, 24.82% and 0%. The overrides are Pretendard's ascent and descent
  divided by the size, so line boxes stay where Pretendard put them.

Generated sheets carry a `font-` prefix so their emitted names never collide
with the static pages' `noto-*.css` sheets, which the build and the
retryable stylesheet loader match by name. Keep that prefix for any new app
sheet.

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

- Phase A, when a language applies: Inter, the UI's own script sheet and the
  first family of its Han order. The Korean and English UIs declare the same
  sheets at the same moment.
- Phase B, after window load and the first idle slice: every other sheet, so
  every family is declared in every UI. It ignores data saver.
- Phase C, 10 s after phase B: the Korean, Japanese and Chinese UIs load
  their own family's most frequent shards (`src/i18n/font-prefetch-samples.ts`,
  generated) in idle batches of three, at most 20 faces and 400,000 B per page
  load, skipping shards already loaded. It is skipped on data saver, 2G or
  offline and pauses while the page is hidden.
- A sheet that fails is retried on `online` or on a later visible idle slice,
  a bounded number of times.

The service worker does not precache fonts; the hashed sheets and shards go
through its ordinary cache-first asset path, and the old
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
  features except `locl`, every glyph kept).
- `npm run generate:font-sheets` writes `css/fonts/app/` and
  `src/i18n/font-prefetch-samples.ts` (`-- --check` compares).
- `npm run generate:noto-kr -- --check` verifies the shipped Noto Sans KR
  files against the record and that no `locl` lookup is left.
- To refresh from Google, download the CSS and the files into a new empty
  folder and run `node scripts/fonts/record-font-sources.mts` (its header lists
  the arguments), then `npm run generate:noto-kr -- --source <folder> --record`
  and `npm run generate:font-sheets`. Without `--record`, the Noto Sans KR
  build must reproduce the recorded shipped bytes exactly.

## Verification

- `npm run guard:font-assets` checks the source: the shipped Inter and Noto
  Sans KR files against `fonts/font-sources.json`, the generated sheets
  against their generator, every face self-hosted with the descriptors of its
  family, every text stack (the Korean and English ones identical under every
  Han order), one family per script, and coverage: every non-PUA character
  Pretendard drew and every character of the catalogs and `index.html` has a
  self-hosted face in every stack, except the recorded
  `scripts/fonts/uncovered-code-points.txt`, which must name exactly the gaps.
  It also checks that nothing in the app names or preloads Pretendard.
- `npm run guard:font-build` adds the build: no font in the initial graph of
  the app document or its localized copies, each app sheet its own lazy CSS
  asset with root-relative WOFF2 files, the built Inter and Noto Sans KR bytes
  equal to the sources, no font in the service worker's install manifests,
  About bound to the original sheets, and Pretendard deployed once.
- Unit tests: `src/i18n/__tests__/font-*.test.ts`, `locale-fonts.test.ts`,
  `static-page-fonts.test.ts` and `src/core/__tests__/app-font-guard.test.ts`.
- `e2e/font-identity.test.ts` (local, on the e2e build) draws the same chat
  and track titles in a fresh Korean and a fresh English UI and compares the
  faces of every character, the widths and the pixels, and checks what each
  UI fetches.

## Licensing and fallback behavior

- A missing font does not prevent the app shell from loading, but affected
  text falls back to a system font until the font arrives. A character no
  self-hosted face draws (the recorded gaps: some IPA letters, combining
  marks, sub- and superscripts and rare symbols) always uses a system font,
  which the browser may pick by the page language.
- Inter is licensed under the **SIL Open Font License 1.1** (see
  `INTER_LICENSE.txt`).
- Noto fonts are licensed under the **SIL Open Font License 1.1** (see the
  Noto license files in this directory).
- Pretendard, kept for the public pages and the share images, is licensed
  under the **SIL Open Font License 1.1** (see `PRETENDARD_LICENSE.txt`).
  `fonts/PretendardVariable.woff2` is the canonical source copy; the deployed
  copy at `public/designsystem/fonts/PretendardVariable.woff2` must be
  byte-identical.
