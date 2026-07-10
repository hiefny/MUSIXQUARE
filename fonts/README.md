# Fonts

This project is set up to **self-host Pretendard** and locale-specific Noto
fallback fonts.

## Quick setup

- macOS/Linux:
  - Run: `./scripts/fetch-pretendard.sh`

- Windows (PowerShell):
  - Run: `./scripts/fetch-pretendard.ps1`

This will download:
- `fonts/PretendardVariable.woff2`
- `fonts/PRETENDARD_LICENSE.txt`

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
at `public/designsystem/fonts/PretendardVariable.woff2` must be byte-identical;
`npm run guard:font-assets` verifies the font, CSS stacks, and preload links;
`npm run guard:font-build` also verifies the production artifact.

## Notes

- The site will still work without the font files, but it will fall back to system fonts.
- The font is licensed under **SIL Open Font License 1.1** (see `PRETENDARD_LICENSE.txt`).
- Noto fonts are licensed under **SIL Open Font License 1.1** (see the Noto
  license files in this directory).
