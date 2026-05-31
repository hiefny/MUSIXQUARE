# Fonts

This project is set up to **self-host Pretendard** and Noto fallback fonts.

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
- `Noto Sans SC`
- `Noto Sans TC`
- `Noto Sans Thai`

These live under `fonts/noto/` and are referenced by `css/noto.css`.
They let Chinese and Thai glyphs render with Noto while Latin, digits, Korean,
and Japanese keep Pretendard metrics through `Pretendard UI Core`.

## Notes

- The site will still work without the font files, but it will fall back to system fonts.
- The font is licensed under **SIL Open Font License 1.1** (see `PRETENDARD_LICENSE.txt`).
- Noto fonts are licensed under **SIL Open Font License 1.1** (see
  `NOTO_CJK_LICENSE.txt` and `NOTO_THAI_LICENSE.txt`).
