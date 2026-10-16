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

Committed `build:checked` at `3a47dc6a` passed all source/build/security/cache
guards, including 97 verified app-shell assets and the initial-transfer budget.
This commit adds only the corrected helper and QA record above to the tested
runtime source. The production build contains no E2E hooks. Subsequent local
record-only commits do not change the tested runtime identity; neither this
local build nor PR CI substitutes for the successful exact-main candidate.

## Release and recovery

PR [#369](https://github.com/hiefny/MUSIXQUARE/pull/369) had no review findings
and passed all 11 jobs in [PR CI 38915494397](https://github.com/hiefny/MUSIXQUARE/actions/runs/38915494397).
It merged as `a8b37386e6dbe9424cb1d335da00e2871196a526`.
The exact-main push [CI 38916351290](https://github.com/hiefny/MUSIXQUARE/actions/runs/38916351290),
attempt 1, passed all 11 jobs: 572 unit files, 12,847 tests passed and one
Linux skip for a Windows-only cross-drive path test; production candidate
browser 17 and critical browser 45 passed. Coverage, type, lint, static,
build, security, and dependency-signature gates passed. This candidate, not
the earlier local or PR checks, supplied the production artifact.

[Release 38917295260](https://github.com/hiefny/MUSIXQUARE/actions/runs/38917295260),
attempt 1, succeeded for App 8.11.5/v702, target=app and Developer API D1=false.
The deployment job completed on 2026-10-16 at 23:40:04 KST. App version is
`ab062331-b593-43ca-a4d8-b88e17887719`; deployment is
`61327e0a-cfdc-4181-8264-801f91f7cd8b`. Final ownership was verified at
23:39:58.663 KST and the exact SHA/app coherent marker was recorded.
The partial-release compatibility recheck completed compatible at
23:39:29.245 KST. The five unselected Workers were not redeployed and retain
`d9364cd94ef036c5202ebf20cf5fff0b68d8cacf` provenance:

| Worker | Version ID | Deployment ID |
| --- | --- | --- |
| signaling | `c25e8be3-bb42-465f-a66b-77360b3a5f1a` | `052c9597-cc96-44ea-91cb-40469840d760` |
| pro-room | `8d5d44c0-c925-4495-86d7-29bf11a0958e` | `e5049949-cbcf-4210-b736-92541dfadddf` |
| remote-share | `b7150b48-2e77-4db0-a908-718fe341bd5f` | `8b306664-f898-463a-aeb3-f4a083ae0d5a` |
| developer-api | `c4069dcd-524d-4752-baa0-364aba94679a` | `5bf2cebe-69f1-4cdc-847c-e9b3e0c28e5d` |
| developer-api-facade | `d4b348cd-3323-4f48-8bbb-4f49a3680110` | `44f54bd6-1af9-4da3-9829-48d28d4c7037` |

All four operational smokes passed: App generation converged for three
consecutive reads on `/assets/main-n3EFoT23.js` with 29 assets verified;
anonymous App account boundaries, the existing PRO public boundary, and
Standard HTTPS signaling passed. Other Worker smokes were outside the App
release scope. The seven existing App D1 baseline apply/verify steps passed
idempotently; Developer API D1 was skipped.

Public verification at 23:41:01–21 KST passed 16/16 checks. All 144 GETs
(index, SW, v702 bootstrap, screensaver HTML/runtime, and 139 backgrounds)
returned HTTP 200 with exact-main candidate byte counts and SHA-256 hashes.
The 139 images total 2,422,698 bytes and are byte-identical to verified v701.
The delivered caption runtime is `screensaver-runtime-879e9d3b.js`,
230,298 bytes, SHA-256
`879e9d3b79aa7a2165c221579d5e846509234c7425aab0be760a729091727c48`;
the HTML is 19,033 bytes, SHA-256
`16a6b7a666be7b60b3ca37400276dacb039681fc8fbf88e7d2fffdf5a4e73f44`.
The check confirmed immutable runtime/image caching, revalidated HTML with
CDN no-store, SW no-cache, scoped CSP/permissions, same-origin framing and
geolocation delegation, noindex, no initial screensaver/background precache,
and no embedded original photos or test globals.

The recovery checkpoint was captured at 23:38:50.573 KST and preserves the
prior App `813a02203274d52986eeeae5a901f9070a0362b4` (8.11.4/v701),
version `001c91c1-11a4-4613-8b9d-b3a9fc6ef641`, deployment
`2f61749a-6c20-439f-b16c-6926744a961b`. Rollback was unnecessary and not
performed; the separate recovery job was skipped. Restoring that version
also restores its narrow per-character caption composition, so the reported
failure can return. The checkpoint is not a user-data backup.

The 23:38:52.929 KST floor capture was ready, with release floor
`d9364cd94ef036c5202ebf20cf5fff0b68d8cacf` and generation floor
`4c5612d5fc4c5548781eb7d5b26d6904969c051c`; generation/entitlement were
true. The preserved App is a verified release ancestor and is generation,
entitlement, and Developer API authority aware. No floor or compatibility
contract changed. Recovery still requires ownership and floor checks.

Deployment records are retained in
[artifact 12053935058](https://github.com/hiefny/MUSIXQUARE/actions/runs/38917295260/artifacts/12053935058),
the coherent marker in
[12053605997](https://github.com/hiefny/MUSIXQUARE/actions/runs/38917295260/artifacts/12053605997),
and the checkpoint in
[12052911696](https://github.com/hiefny/MUSIXQUARE/actions/runs/38917295260/artifacts/12052911696),
with 90-day retention. External evidence is under
`caption-rendering-v702/release-artifacts/`, `release.log`,
`main-ci.log`, and `public-verification-report.json`.

At the record's read-only recheck, the latest main Drift Audit remained
[38876397208](https://github.com/hiefny/MUSIXQUARE/actions/runs/38876397208)
on the older `0041d5be`: 31 pass / 0 fail / 5 manual-only. There is no
post-release Drift result for `a8b37386`.
Complete serial E2E was not rerun for this repair. The latest main run
[38328670967](https://github.com/hiefny/MUSIXQUARE/actions/runs/38328670967)
is the scheduled `4854e392` run and failed. The preserved successful
[38405378201](https://github.com/hiefny/MUSIXQUARE/actions/runs/38405378201)
was a workflow_dispatch on `agent/component-cascade-refactor` at
`749f0a6a`, not a main-branch release check.

The owner's repaired Windows preview confirmation, the exact-main CI, and
the completed release/public checks close this repair's deployment readiness.
They do not claim automated reproduction of the original GPU failure,
coverage of every browser/GPU, or physical iPhone QA. The existing
physical-device limits remain open.
