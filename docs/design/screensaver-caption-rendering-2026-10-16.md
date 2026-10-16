# Screensaver caption rendering regression — 2026-10-16

## Report and source

After App 8.11.4 / v701, the owner reported rectangular missing strokes in the
small `FRI` caption, especially `I`. The issue is visible in Chrome, Edge, and
the Codex browser on Windows, in both production and the local comparison HTML.
The supplied screenshot is direct evidence; a normal gallery capture does not
disprove the live failure.

The earlier plain-caption safeguard drew text directly into the scene canvas.
The v4 compatibility prototype, subsequently ported in PR #367, replaced that
path with a small canvas for each character and CSS composition. The caption
still uses normal viewport DPR and bypasses optical masks; this is not evidence
that high resolution inherently damages text or that the old mask bug returned.
An isolated Chromium probe did not reproduce the reported interior holes.
The precise browser/GPU failure mechanism remains unconfirmed.

The initial 8.11.4 native WebKit comparison covered clock, minute transition,
weather, and moon; it did not include date/FRI. This omission is recorded rather
than treating those earlier seven comparisons as coverage for this regression.

## Change

The repair starts from `bf48858ef03525b4d09799b25464859b8b51d4d0` and advances
App to 8.11.5 / v702. Small-text draw commands are grouped by transform and
transition blur, then drawn together into a generously padded canvas at the
original DPR. Static, outgoing, and incoming captions reuse group canvases;
changing blur values do not accumulate a persistent texture cache. Character
positions, fonts, opacity, transition timing, and compatible CSS blur remain.
The vulnerable narrow per-character caption surface is removed.

Large optical glyphs, seconds morphing, baked background assets, lazy loading,
fullscreen restoration, controls, and YouTube restrictions are outside this
change. There are no new dependencies, protocols, schema, secrets, bindings,
permissions, or CSP changes. Release scope is App only; Developer API D1 stays
disabled. A normal authorized rollback returns to 8.11.4/v701 with its prior
caption rendering behavior, subject to existing ownership and recovery floors.

## Verification

The owner checked the separate local caption comparison in their Windows
browser and explicitly confirmed that the repaired version is normal. This is
user verification of that preview, not a claim that every browser/GPU or iPhone
was tested. The earlier files remain preserved.

The isolated renderer fixture extracts only the compositor functions into a
synthetic test document, without navigating the user's local browser page.
Chromium 16 + native Windows WebKit 16 cases passed with real Google Sans at
DPR 1, 1.25, 1.5, and 2. The fixture covers FRI, AQI, Mostly clear, and an
intermediate/settled FRI-to-SAT transition. FRI/AQI's I has no interior missing
ink. Static Chromium results at DPR 1/1.25/1.5 and WebKit DPR 1 match the direct
fillText reference pixel-for-pixel; other cases differ at antialiased edges
(maximum mean RGB error 0.343/255), without the reported holes or clipping.
The fixture records one static group and at most three transition groups.
Evidence is retained in `caption-group-regression/{chromium,webkit}/results.json`.

The tested runtime source is `a705cccdc26667c9802df2cc5587f0970742c9d3`.
Local Windows checks used Node 24.13.1 and npm 11.8.0; CI uses the repository's
pinned toolchain. Typecheck, full lint, formatting, Worker syntax, Developer API
boundaries, D1 migration contracts, and operations source guards passed. The
full unit run passed 572 files / 12,848 tests, with zero failures or skips.

Chromium screensaver E2E covers 16 cases. The first run passed all 14 existing
cases but failed both new caption cases because the test fixture incorrectly
accepted only uppercase letters while the product displays `Mostly clear`.
After allowing lowercase ink and normalizing only semantic matching, the two
affected cases passed in 27.1 seconds. This is a 14-case initial pass plus a
2-case corrected rerun, not an additional full 16-case run. The runtime was
unchanged; the test helper correction is committed separately. Across 12
caption samples at 390px/DPR 2 and 1280px/DPR 1.25, including a 320x240 resize
and scene revisits, the reference-alpha comparison found zero missing, stale,
or clipped pixels. The app E2E uses its existing fallback-font fixture; the
isolated comparison above separately uses real Google Sans.

Evidence is retained under `caption-rendering-v702/`: `unit.log`, static-check
logs, `screensaver-e2e.log/json` (including the two initial fixture failures),
and `caption-e2e-corrected.log/json`. Independent code and regression-test
review found no P1/P2 issue. The retained user screenshot is not a claim of
automated reproduction, and automated browser checks do not replace
physical-device QA. Physical iPhone, actual weather-provider data, audible
sync, and the complete serial E2E suite remain outside this change's local QA.

## Release and recovery

Publication follows reviewed PR, successful exact-main CI, and the normal App
release. Deployment identifiers, public asset checks, and checkpoint evidence
will be recorded after completion.
