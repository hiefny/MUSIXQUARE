# Safari screensaver blur diagnosis — 2026-10-16

## Historical status — reconciled 2026-10-17

The investigation below retains the original 2026-10-16 source, reproduction,
and limits. Its present-tense implementation descriptions and proposed correction
describe App 8.11.1/v698; they do not describe the current renderer.
The compatible renderer subsequently shipped in App 8.11.4/v701, PR
[#367](https://github.com/hiefny/MUSIXQUARE/pull/367), source `813a0220`.
[The implementation and release report](screensaver-image-backgrounds-2026-10-16.md)
records the cached effects, Windows WebKit checks, and deployment evidence.
The separate small-caption regression and its repair are recorded in
[the caption rendering report](screensaver-caption-rendering-2026-10-16.md).

This report was preserved from the older local checkout during repository
reconciliation. Its former open item for an unimplemented compatibility fix is
superseded by that release evidence; no runtime change or new test run is claimed
by this addendum. Physical iPhone verification remains outside these reports'
evidence and is still tracked in the [current release record](../release-record.md).

## Scope and identity

Investigation requested for missing directional blur/glow on iPhone. The supplied
image shows sharp displaced copies of numerals and hard rings around the colon.
No product code, dependency, deployment, or preserved standalone file changed.

- Source inspected: `a09058a3cd1db2e329c3b7bc3550859966c33be2`.
- Deployed product source: `cedc0b04707ed619647a3897f54bc1c3bcfd64e2`, App 8.11.1/v698.
- Local built renderer tested: `/assets/screensaver-runtime-1c8b7f5e.js`.
- SHA-256: `1c8b7f5e606c9788a10bc94e3bfd3572522723f85a0bc88913eafa572eb1b0d9`,
  matching the previously verified deployed renderer. No new production fetch or
  release was performed for this investigation.
- Environment: Windows, Node 24.13.1, installed Playwright Chromium
  153.0.8010.12 and WebKit 26.6, 844 × 390 CSS pixels, DPR 2, Google Sans 700 loaded.
- Completed probe: 2026-10-16 08:04:16–08:04:27 UTC.

## Finding

The renderer unconditionally uses Canvas 2D `filter = 'blur(...)'`, without a
support check or fallback. Current [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/CanvasRenderingContext2D.json)
lists Safari support behind the Canvas Filters preference, with iOS mirroring it.
The [WebKit setting](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml)
has `CanvasFiltersEnabled` disabled by default. CSS filters are a separate API.

Relevant source in `browser/auxiliary-runtime/screensaver.ts`:

- `buildDigitTile`, lines 1925–1940: six blur passes and two glow passes rely on
  `ctx.filter`. Without it, the glow is drawn sharply behind the main numeral.
- Lines 1960–1971: masked copies are displaced by `(8,-7)`, `(18,-15)` and
  `(-6,5)`. Their offsets and opacity survive when blur is absent, explaining the
  distinct upper-right copies in the supplied image.
- `buildColonTile`, lines 1986–1996: larger blue/white discs remain sharp instead
  of becoming soft halos.
- Seconds glow (2466), digit transition blur (2632), other information glyphs
  (3424–3494), moon effects (3545–3615), and information transitions (3806) share
  the dependency. Only the clock scene was visually reproduced in this round.
- Background blur uses CSS filters in `public/screensaver.html`, so its continued
  operation does not demonstrate Canvas filter support.

Reduced motion does not disable the static optical tile effects. DPR/memory
limits and clipping may merit separate testing, but do not explain this exact
failure as directly as the missing filter does.

## Reproduction and limits

A 96 × 96 pixel canvas draws a 16 × 16 white square with `blur(8px)`. Pixels
outside the original square are measured. The unchanged built screensaver also
runs inside a synthetic same-origin iframe. Weather/location requests are blocked.

| Environment | Filter exists before assignment | Pixels outside square with alpha | Center alpha | Clock appearance |
| --- | --- | --- | --- | --- |
| Chromium native | yes | 2,216 | 124 | Soft directional blur and glow |
| Chromium with prototype filter removed | no | 0 | 255 | Sharp displaced numeral copies and colon rings |
| WebKit native | no | 0 | 255 | Same failure shape as the supplied image |

All three report CSS blur support, render the clock, load Google Sans, and finish
with zero page errors. All also read back `blur(8px)` after assignment: on the two
unsupported paths this is an ordinary JavaScript property, not an active filter.
A setter/readback-only capability test would therefore give a false positive.

The diagnostic completed 3/3 cases. Expected visual behavior is present in native
Chromium and fails in native WebKit and the controlled unsupported simulation.
The first harness attempt timed out on the wrong selector `#clockCanvas` and was
stopped; the corrected `#opticalClockCanvas` run produced the table above. This
fixture error is not a product failure or an additional passing run.

Evidence is in the external screensaver evidence directory under
`ios-filter-diagnosis/`: `probe.mjs`, `results.json`, `chromium-native.png`,
`chromium-without-canvas-filter.png`, and `webkit-native.png`. All three images
were visually inspected. The native WebKit and controlled Chromium failure match
the submitted image's sharp copies/rings.

This is Windows Playwright WebKit, not physical iPhone Safari. The user's iOS
version/settings are unknown. No mobile GPU benchmark, real weather request,
live room, physical-device test, or broad regression suite was run. The controlled
reproduction establishes a concrete compatibility defect and strongly explains
the report; it does not establish every property of the user's device.

## Proposed correction, not implemented

Check actual blur pixel spread once. Keep the current rendering when it works;
otherwise blur small glyph tiles explicitly before applying the existing masks
and offsets. Cache static tiles and bounded transition blur levels to avoid
full-screen CPU pixel processing on every animation frame. A supported
`shadowBlur` path may suit the small dynamic seconds glow, with visual tuning.
Applying CSS blur to the entire canvas would also blur the intentionally sharp
parts and would not preserve the current design. Validate the correction in
native WebKit and on an iPhone before claiming physical-device parity.
