# Fonts

This project is set up to **self-host Pretendard** and locale-specific Noto
fallback fonts.

## Managed assets

Font binaries and their license files are tracked in this repository; a fresh
checkout does not require a download step. When replacing Pretendard, use the
complete upstream variable WOFF2 face, update its license if needed, copy the
same bytes to the deployed design-system font path, and run the font guards
described below.

## Noto fallback fonts

The app also self-hosts Google Fonts WOFF2 shards for:

- `Noto Sans JP`
- `Noto Sans SC`
- `Noto Sans TC`
- `Noto Sans Thai`
- `Noto Sans` (Cyrillic and Greek shards)
- `Noto Sans Arabic`
- `Noto Sans Hebrew`
- `Noto Sans Devanagari`
- `Noto Sans Bengali`
- `Noto Sans Tamil`
- `Noto Sans Telugu`
- `Noto Sans Gujarati`
- `Noto Sans Kannada`
- `Noto Sans Malayalam`
- `Noto Sans Gurmukhi`

These live under `fonts/noto/` and are referenced by per-locale CSS shards in
`css/fonts/`. The app loads those CSS shards only when the resolved language
needs them:

- Japanese: `css/fonts/noto-jp.css`
- Simplified Chinese: `css/fonts/noto-sc.css`
- Traditional Chinese: `css/fonts/noto-tc.css`
- Thai: `css/fonts/noto-thai.css`
- Russian, Ukrainian, and Bulgarian: `css/fonts/noto-cyrillic.css`
- Greek: `css/fonts/noto-greek.css`
- Arabic, Persian, and Urdu: `css/fonts/noto-arabic.css`
- Hebrew: `css/fonts/noto-hebrew.css`
- Hindi and Marathi: `css/fonts/noto-devanagari.css`
- Bengali: `css/fonts/noto-bengali.css`
- Tamil: `css/fonts/noto-tamil.css`
- Telugu: `css/fonts/noto-telugu.css`
- Gujarati: `css/fonts/noto-gujarati.css`
- Kannada: `css/fonts/noto-kannada.css`
- Malayalam: `css/fonts/noto-malayalam.css`
- Punjabi (Gurmukhi): `css/fonts/noto-gurmukhi.css`

Latin and Korean both use the complete `PretendardVariable.woff2` face. This is
intentional: arbitrary user-entered Korean (including chat messages) must not
fall back glyph-by-glyph to a platform font. Every non-Latin script listed above
keeps its locale-specific Noto fallback face for characters Pretendard does not
cover. The language picker warms only the native-name glyphs it needs, and
ordinary app navigation loads only the active locale's CSS shard.

`fonts/PretendardVariable.woff2` is the canonical source copy. The deployed copy
at `public/designsystem/fonts/PretendardVariable.woff2` must be byte-identical.

## Inter and Noto Sans KR

These files are staged for the app's switch from Pretendard to Inter and Noto;
the app does not load them yet.

- `fonts/inter/` holds Inter 4.001 (Google Fonts v20): the seven variable
  subsets (`opsz` 14-32, `wght` 100-900) exactly as Google serves them.
- `fonts/noto/noto-sans-kr/` holds Noto Sans KR 2.004 (Google Fonts v40): the
  120 numbered shards under Google's file names, re-encoded without the Korean
  `locl` lookup. Google's shards register `locl` for Korean in every script, so
  with `lang="ko"` a few marks (for example `‼` next to Hangul) take a Korean
  form that no other UI shows. Without it, the Korean and English UIs shape
  every character alike. The copies keep the cmap, every outline and every
  other layout feature; only the Korean forms that `locl` produced, and
  lookups that touched nothing else, are gone.
  Their bytes therefore differ from Google's while the names stay. The SIL OFL
  1.1 allows this: the font's Reserved Font Name is "Source", not "Noto".
- `fonts/font-sources.json` is the provenance record. For each file it keeps
  the Google URL, Google's `unicode-range`, and the sha256 and size of both the
  downloaded (`source`) and the committed (`shipped`) bytes, plus the versions
  of the tools that made the Noto Sans KR copies.
- `css/fonts/app/` holds the app's sheets. They are generated from that record
  and from Google's sheets in `css/fonts/`, which stay unchanged for the
  static pages. The range edits give every script exactly one family: Inter
  draws what its cmap covers inside its ranges, Hangul only comes from Noto
  Sans KR, kana only from Noto Sans JP, and invisible marks from no CJK family.
  Each CJK face also declares only the characters its own file draws, so an
  emoji never makes the browser download a CJK shard that cannot draw it.
  The size and line-box descriptors come from `src/i18n/font-metrics.ts`.

Regenerate instead of editing:

- `npm run generate:font-sheets` writes `css/fonts/app/`
  (`npm run generate:font-sheets -- --check` compares).
- `npm run generate:noto-kr -- --check` verifies the shipped Noto Sans KR files.
- To refresh from Google, download the CSS and the files into a new empty
  folder and run `node scripts/fonts/record-font-sources.mts` (its header lists
  the arguments), then `npm run generate:noto-kr -- --source <folder> --record`
  and `npm run generate:font-sheets`. Without `--record`, the Noto Sans KR
  build must reproduce the recorded shipped bytes exactly.

## Verification

- `npm run guard:font-assets` verifies source and deployed font copies, CSS
  stacks, preload links, the Inter and Noto Sans KR files against
  `fonts/font-sources.json`, and `css/fonts/app/` against its generator.
- `npm run guard:font-build` performs the same checks against a production
  build artifact.

## Licensing and fallback behavior

- A missing font does not prevent the app shell from loading, but affected text
  falls back to the configured locale or system font.
- The font is licensed under **SIL Open Font License 1.1** (see `PRETENDARD_LICENSE.txt`).
- Noto fonts are licensed under **SIL Open Font License 1.1** (see the Noto
  license files in this directory).
