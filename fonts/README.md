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
- `Noto Sans` (Cyrillic shards)

These live under `fonts/noto/` and are referenced by per-locale CSS shards in
`css/fonts/`. The app loads those CSS shards only when the resolved language
needs them:

- Japanese: `css/fonts/noto-jp.css`
- Simplified Chinese: `css/fonts/noto-sc.css`
- Traditional Chinese: `css/fonts/noto-tc.css`
- Thai: `css/fonts/noto-thai.css`
- Russian: `css/fonts/noto-cyrillic.css`

Latin and Korean both use the complete `PretendardVariable.woff2` face. This is
intentional: arbitrary user-entered Korean (including chat messages) must not
fall back glyph-by-glyph to a platform font. Japanese, Simplified/Traditional
Chinese, Thai, and Cyrillic keep their locale-specific Noto fallback faces for
characters Pretendard does not cover.

`fonts/PretendardVariable.woff2` is the canonical source copy. The deployed copy
at `public/designsystem/fonts/PretendardVariable.woff2` must be byte-identical.

## Verification

- `npm run guard:font-assets` verifies source and deployed font copies, CSS
  stacks, and preload links.
- `npm run guard:font-build` performs the same checks against a production
  build artifact.

## Licensing and fallback behavior

- A missing font does not prevent the app shell from loading, but affected text
  falls back to the configured locale or system font.
- The font is licensed under **SIL Open Font License 1.1** (see `PRETENDARD_LICENSE.txt`).
- Noto fonts are licensed under **SIL Open Font License 1.1** (see the Noto
  license files in this directory).
