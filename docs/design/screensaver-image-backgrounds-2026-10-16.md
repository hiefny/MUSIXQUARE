# Image backgrounds and compatible screensaver effects — 2026-10-16

## Scope and source

The owner approved the local all-image background comparison and requested its
integration and production deployment. Implementation starts from `44a58c453e1a9de755c02b4521ae3e2b666ba2fb`
(App 8.11.3 / cache v700). The release advances App to 8.11.4 and cache to v701.
Only the App target changes; no service binding, secret, database, protocol,
permission, CSP, or third-party dependency changes are required.

The approved local prototype is `ambient-display-compatible-v4-images.html`,
SHA-256 `a4d4cb35c5729088490d07709e54c7b6e1401065ec1c604ef2ecce10a8283117`.
Its foreground compatibility renderer and image backgrounds are ported to the
strict TypeScript auxiliary entry instead of shipping the prototype's debug
globals, comparison controls, or inline scripts.

## Resulting behavior

Clock, date, weather, air quality, and moon use the same decoded-image background
pipeline. The clock image captures the original blue gradients and three blurred
lights at their starting position. The lights no longer move independently.
Seasonal/weather/night photos include their original blur, brightness, saturation,
and veil. AQI colors are baked in the same way. Foreground glyphs, moon,
directional trails, glow, grain, and scene transitions remain separate.

The asset bank contains 23 scene/brightness combinations and 139 viewport variants,
totalling 2,422,698 bytes of WebP quality 96 images. It includes cloudy storm day
and night variants. Six main aspect/size variants cover portrait, large portrait,
landscape, classic, wide, and square screens; the clock also has a tiny variant.
Intermediate sizes use cover cropping, so these are not pixel-identical
reconstructions at every possible aspect ratio.

`browser/screensaver-backgrounds.ts` supplies a compact typed manifest. Files
under `/assets/screensaver/backgrounds/` carry eight-character content hashes,
using the existing immutable HTTP/service-worker asset path. The manifest is
bundled into the auxiliary renderer loaded by the command, not the app entry.
Background images are selected and loaded on demand; the complete bank is not
preloaded or included in the application shell.

The existing local command, YouTube exclusion/forced exit, fullscreen restoration,
entry/exit fades, translated back button, music footer, five-second controls idle
timer, location consent, English slide content, and provider attribution remain.
The previous canvas-filter implementation did not produce the intended glow in
Windows WebKit. The port uses cached glyph rendering and CSS compositor layers
for compatible transitions, retaining the approved blue appearance.

## Verification

Runtime source `6e862e01c51f15a3301224540f298c76556f1d56` was verified on Windows
with Node 24.13.1 and npm 11.8.0. Full typecheck, ESLint, formatting, Worker syntax,
Developer API boundaries, D1 contracts, and source-only operations contracts
passed. The final startup-background correction also passed focused strict
TypeScript and lint. Independent source review found no remaining P1/P2 after
fixing the initial image waiting behind font warmup.

The full local unit run passed 570 files / 12,846 tests and failed two tests:
the raw index bootstrap cache URL still used v700, and a Git-fixture SW guard
timed out at 15 seconds under full load. The URL was corrected to v701 and both
affected files passed all 76 tests when rerun with one worker. The original
205-second failing run is retained; the focused rerun is not described as a new
full-suite pass. The focused rerun's result is recorded in the task command
output; a separate rerun log file was not retained. Asset contract tests verify all 139 file sizes/content hashes
and the actual routing function across 200 weather day/night combinations,
seasons in both hemispheres, moon, and AQI boundaries.

Committed-source `build:checked` passed all gates, including Chromium 79 syntax,
production security/test-hook checks, font checks, and 97 app-shell assets.
Eager transfer remains 2,012.2 KiB raw / 538.1 KiB gzip, with no eager font bytes.
The image bank is absent from the built service worker. The compiled child
renderer is `/assets/screensaver-runtime-49a3cd62.js`: 228,911 bytes / 46,902 bytes
gzip, SHA-256 `49a3cd626a774007cd9dd1a441ce38a8dc58b866aa2bf6e035e50c4b1c318e04`.
Child HTML is 19,033 bytes. The production artifact was retained before building
the separate E2E artifact.

Focused Chromium screensaver E2E passed **14/14** in 1.7 minutes, with no page
errors. It covers connected file playback, synthetic system audio, YouTube
blocking/forced exit, lazy entry, fullscreen ownership/restoration, host-message
boundaries, controls/music footer, small/large layouts, and location denial.
New checks require a decoded clock background before a blocked font stylesheet
is released (within 1.5 seconds), retain the previous image while its successor
is delayed or fails, verify two images during a crossfade and one afterward,
recover after reopening, render nonempty glyphs without Canvas.filter, and
dispose/recreate compositor/image roots across synthetic pagehide/pageshow.
The five-record decoded-image cache bound was reviewed in source; this is not a
heap-memory measurement.

Native Windows WebKit appearance checks passed **7/7** against the frozen
production artifact and approved prototype. Canvas.filter was unavailable.
Clock and moon screenshots in both orientations, and the landscape minute
transition screenshot, matched pixel-for-pixel with nonempty foreground layers. Weather keeps
the existing MUSIXQUARE temperature/description spacing; matching only that
layout in the reference produced identical foreground pixels/styles. The
portrait weather difference was limited to the existing attribution link's
placement (370 pixels; mean full-image RGB difference 0.059/255). Backgrounds
decoded with no runtime blur filter, and no page errors or unexpected external
requests occurred. The test response alone added deterministic scene controls;
the production files remained unchanged. Results and PNGs are retained in
`production-port-webkit/results.json` and its adjacent screenshots.

PR [#367](https://github.com/hiefny/MUSIXQUARE/pull/367) passed all 11 CI jobs in
[38908079465](https://github.com/hiefny/MUSIXQUARE/actions/runs/38908079465),
including both unit shards, candidate browser 17 checks, and critical browser
43 checks. The reviewed change was squash-merged as
`813a02203274d52986eeeae5a901f9070a0362b4`. PR CI is separate from the required
exact-main deployment candidate.

The exact-main push CI
[38909124622](https://github.com/hiefny/MUSIXQUARE/actions/runs/38909124622)
passed all 11 jobs for `813a02203274d52986eeeae5a901f9070a0362b4` using pinned
Node 24.20.0 / npm 12.0.2. Both unit shards and merged coverage report 572 files,
12,847 tests passed, zero failed, and one Linux skip for the Windows-only
different-drive-path test. Candidate browser checks passed 17/17 and critical
browser checks passed 43/43. The full CI log is retained as
`production-image-v701/main-ci-38909124622.log`.

Evidence is retained in the operator's `production-image-v701/` directory:
`typecheck.log`, `lint.log`, `format.log`, `worker-guards.log`, `unit.log`,
`build-checked.log`, `production-asset-summary.json`, the frozen
`dist-production/`, and `screensaver-chromium-report.json`. Browser checks do
not establish physical iPhone Safari behavior, real weather observations,
or audible multi-device synchronization.

The earlier prototype benchmark compared CSS-gradient backgrounds with baked
image backgrounds at static phase zero in an ABBA sequence with unchanged
foreground transitions. Windows WebKit landscape
median frame intervals changed from 158 to 120 ms (clock), 174 to 79 ms (weather),
and 202 to 116 ms (clock/weather crossfade). Chromium was about 16.7 ms for both
variants. These are prototype comparison results, not measurements of the
integrated production application or a physical iPhone.

## Release and recovery

Production Release
[38909891395](https://github.com/hiefny/MUSIXQUARE/actions/runs/38909891395)
attempt 1 succeeded on 2026-10-16, with the deploy job completing at 22:44:29 KST.
It deployed App 8.11.4 / v701 from exact-main
`813a02203274d52986eeeae5a901f9070a0362b4`, reusing CI candidate
`38909124622` attempt 1 with `target=app` and `apply_developer_api_d1=false`.
No rebuild or local/PR candidate substituted for the immutable main artifact.

The App version is `001c91c1-11a4-4613-8b9d-b3a9fc6ef641`, deployment
`2f61749a-6c20-439f-b16c-6926744a961b`. Final ownership verification completed
at 22:44:25.556 KST with the expected `git:813a0220...` provenance; the exact
SHA/App coherent marker was recorded. All four selected live smokes passed:
App generation convergence, anonymous account boundary, current PRO public
boundary, and Standard HTTPS signaling. Unselected Worker smokes were skipped;
the five unchanged Workers passed the partial-release compatibility recheck.
Existing App D1 baselines were applied/verified idempotently; Developer API D1
steps were skipped. No new compatibility floor was introduced.

Read-only public verification passed **20/20** at 22:45:35–22:45:54 KST.
All 144 HTTPS requests returned 200 and matched the exact-main candidate's
bytes and SHA-256: index, service worker, `bootstrap.js?cache=v701`, screensaver
HTML, compiled child runtime, and all 139 images (2,422,698 bytes). Screensaver
HTML/runtime/images also match the frozen local production artifact used for
browser QA. Immutable image/runtime caching, HTML revalidation/CDN no-store,
the scoped CSP and Permissions-Policy, and v701 were verified. The image bank
is absent from the SW precache; no old embedded photos or production test globals
were found. This check used no browser or backend mutation and does not extend
the earlier physical-device limits. Full evidence is
`production-image-v701/public-verification-report.json`.

The immutable checkpoint captured at 22:43:14.020 KST preserves the preceding
App 8.11.3 / v700, source `0041d5be4bffdbc6db10de5923b6a83bfcf0cca1`, version
`06eb268d-b6c8-4126-82a1-0f0d0736590f`, deployment
`0166ba6d-2197-41ab-8d0a-3da26db86b2b`. Rollback was unnecessary and not run;
the independent recovery job was skipped. An authorized rollback restores the
previous screensaver renderer/background approach, subject to the existing
ownership and compatibility-floor checks. It does not restore user data because
this checkpoint is not a user-data backup. There are no stored-data or wire
contract changes.

Release logs, workflow results, deployment IDs, coherent marker, and checkpoint
are retained under `production-image-v701/release-38909891395/`; corresponding
GitHub deployment/checkpoint artifacts have 90-day retention. Original local
comparison files and the primary checkout's uncommitted diagnostic documentation
are preserved.
