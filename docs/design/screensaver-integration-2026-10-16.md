# Lazy ambient screensaver — 2026-10-16

| Field | Value |
| --- | --- |
| Status | 8.11.1/v698 deployed and verified; initial 8.11.0 evidence retained below |
| Deployed source | `cedc0b04707ed619647a3897f54bc1c3bcfd64e2`, PR #361, Release 38836510116 |
| Source baseline | `60148998acca59295963764a5286a155e0aa4256`, temporary branch `agent/screensaver` |
| Product / cache | `8.11.1` / `v698` |
| Release scope | App only; Developer API D1 application disabled |
| Authorization | Owner requested implementation and production deployment on 2026-10-16 |

## Behavior and boundaries

This section through the initial release/recovery evidence records the initial
8.11.0/v696 deployment. The final follow-up is described under
[Control shadow follow-up](#control-shadow-follow-up).

`/screensaver` (also `/스크린세이버`) is a local command available to room members.
The chat command emits a local UI intent; the chat UI dynamically imports the
host controller, then loads a same-origin document and
its separately compiled strict TypeScript renderer. No screensaver document,
renderer, background, font, or weather request is part of the initial App graph
or service-worker precache. Closing removes the frame, state subscriptions, and
subtitle observer. Playback state and room messages are not changed.

The preserved source is `ambient-display-v5.html`, SHA-256
`7e07e0eddb767f89e891ed3473595a52f3b049b70a912cce1cc2ab7adff0c3f0`.
That standalone source remains untouched. The migrated renderer retains clock
afterglow, vector seconds morphing, large moon, proportional layout, English
information scenes, and decoded-background crossfades.

The host rejects a selected YouTube mode or YouTube track, even while paused or
pending. Either state changing to YouTube immediately disposes the active
screensaver and shows the same translated toast. This follows YouTube's
[overlays and frames requirement](https://developers.google.com/youtube/terms/required-minimum-functionality#overlays-and-frames),
which prohibits obscuring any part of an embedded player. Local files and system
audio remain available.

Back and Show music info controls fade after five seconds of pointer inactivity,
return on input, and remain visible during keyboard focus. Back/Escape restore
the previous usable focus. The toggle defaults on and persists only on this
device. A music scene appears immediately before clock in the ten-second cycle
when a usable title exists; its secondary text comes from the existing App
track subtitle (codec, bitrate, or system capture profile). Long titles scroll.
Back, toggle, and YouTube refusal have 42 locale translations; information scenes
remain English and use Google Sans. The original third-party notices are retained.
The owner's follow-up removes the dark backplates behind Back, the music toggle,
and the location action in both normal and hover states.

## Security and compatibility

Only App documents (root, index, locale entries, and room invites) enable self
geolocation and same-origin frames. The screensaver document has a separate CSP:
same-origin external script, Google Fonts styles/fonts, Open-Meteo weather and air
endpoints, data images, no child frames/workers/media, and self-only embedding.
The iframe delegates geolocation/fullscreen, uses a scripts/same-origin sandbox
with popup permission for the user-clicked external attribution link,
and both bridge directions validate origin and WindowProxy identity. No arbitrary
HTML from track metadata is rendered.

The visited document can be reused offline, but its service-worker navigation
fallback never substitutes the main App inside the frame. The build binds each
HTML document to its content-hashed renderer URL so an active older service worker
cannot return a stale runtime under a newer document. Weather requests use
`no-store`. New location access still requires the browser's user permission.
The privacy page discloses the direct Google Fonts/Open-Meteo requests, rounded
in-memory coordinates, local music preference, and browser permission controls.
No npm dependencies, API protocol, schema, secret, binding, or recovery floor is
added. Mixed App versions are compatible. Rolling back the App removes the
feature while the local toggle preference is harmless.

## Verification

Local environment: Windows, Node 24.13.1, npm 11.8.0, repository test tooling.
The repository pins Node 24.20.0 and npm 12.0.2. The exact-main candidate
manifest records Node 24.20.0, npm 11.19.0 and Wrangler 4.148.0; dependency
installation used Corepack with the pinned npm 12.0.2. These are distinct
observations, and local results do not replace that exact candidate. Initial focused
checks on the baseline plus working changes: translation parity/token/toast
policies 52 pass; command suite 52 pass; host lifecycle suite 21 pass; scoped CSP,
SW caching and auxiliary compiler checks 150 pass. These are branch tests, not
an exact-main production candidate.

The first whole-project typecheck found a test passing a command name instead of
the parsed command; corrected. Initial focused lint found an optional promise
chain and an empty storage catch in the host; corrected without weakening rules.
Independent review reproduced and fixed a BFCache/font warmup race (two animation
loops became one) and duplicate weather listener registration. A cache-pair review
replaced the initial stable renderer URL with a content-hashed URL. Initial
browser runs exposed a first-payload scene race and two incorrect test assumptions
(case-sensitive scene label and exact focus target); the corrected focused six
browser cases passed. Source-engine regression passed 84/84 with the original
rendering fixtures, followed by weather 21/21 after adding no-store.

The initial full unit run found command autocomplete ordering (three assertions),
privacy date/sitemap alignment (two), import layering (one), and Worker coverage
inventory (one). Fixed by preserving existing command order, updating the dated
sitemap, routing the command through a typed UI intent, and including the Worker
security suite in its coverage profile. Corrective host/chat/graph/CI checks:
228 pass; privacy 11 pass. The diagnostic whole-suite totals were 12,808 pass /
7 fail, followed by 12,818 pass / 2 fail. The latter identified the separate
sitemap-locale date fixture and a release-gate expectation collected before its
concurrent edit; both were corrected (15 sitemap/privacy and 118 release-gate
checks passed). These early failures remain distinct from final gates.

Committed `7385be7217ce4eac438dbc8129555451411ef339` passed `build:checked`,
including production security/hooks, initial transfer, font, and SW app-shell
guards. The full TypeScript, lint and formatting checks passed. The combined
Chromium run passed 35/35 (six screensaver plus 29 existing critical cases), with
no page errors. Connected local-file host/guest playback continued, and a
synthetic native capture used a real MediaStream. A later real-Google-Fonts
component harness confirmed 500/700 faces loaded (CSS/WOFF2 HTTP 200) and visually
checked clock/music at 320×240 and 1920×1080. It exposed a 160×160 location CTA
overlap; the final CSS reduces the compact button height and prevents wrapping,
leaving a measured 10.41px gap above the toggle. A seventh blocking browser case
covers that path. The final CSS advances the cache epoch to v695.

The real-font harness used a local same-origin parent and the production renderer
`/assets/screensaver-runtime-ec660970.js` (SHA-256
`ec660970ef2fcaaafcf1edb301637f1d50924a201a6af0ab8865dce13627cdf4`). It made no
weather API requests and verified no page errors or CSP violations. The app's
integrated browser tests intentionally mock providers. This is component font
evidence, not a live-room or live-weather claim.

The initial frozen source `5a8e028f1bab6b6f1035a914752cb588670fd3e0` passed all 570 unit
files / 12,820 tests / zero failures or skips (340.28 seconds). The seven
screensaver Chromium cases passed, including the denied-location 160px layout,
with no page errors. The earlier PR CI `38825523032` at `7385be72` failed only
the old sitemap privacy-date expectation; that fixture is corrected in this
final source. Its passing jobs are not substituted for the final CI run.
Committed `build:checked` also passed on `5a8e028f`, including the production
security, no-test-hook, initial-transfer, font, and service-worker asset gates.

PR CI `38826637947` on documentation follow-up `b356a05e` passed all 11 jobs.
Independent review then found that the auxiliary compiler's ES2022 target was
newer than the App's supported Chrome 79 baseline. The shared browser target now
also applies to production auxiliary outputs; the local report viewer retains
its modern target. A syntax-tree regression verifies that optional chaining and
nullish operators are transformed. Remote Codex review separately identified a
blocking Google Fonts stylesheet, which delayed the renderer before its bounded
font fallback could start. These corrective changes and the transparent controls
require a new final CI candidate; the earlier successful run is not substituted.

Corrective source `b297e967` passed eight Chromium screensaver cases, including
a held stylesheet with an actually painted fallback clock, late font metric
refitting, failed stylesheet recovery, and transparent normal/hover controls.
Auxiliary/legacy compiler tests passed 22/22; affected TypeScript projects,
lint, ownership and release identity checks passed. Independent follow-up review
found no further blocker in font failure, late-load, BFCache or CSP behavior.
The stylesheet is now created by the external runtime after DOM readiness with
listeners attached before insertion, and the three-second bound covers both CSS
and font loading. Its final Chrome 79 renderer is
`/assets/screensaver-runtime-27fec4a4.js`, SHA-256
`27fec4a4ab5c04704e1c1d011d1e65d7f21b87bc5eafbf7ccc47f27dccf91e0f`.
Committed `build:checked` passed on `b297e967`, including the legacy-browser,
production-security, initial-transfer and service-worker gates.
The follow-up remote review of `f9096c45` completed with no findings. CI
`38828020984` found one test-only omission: the tooling include-list fixture
needed the new shared browser-target file. The corrected tooling/compiler/legacy
suites passed 27/27 with lint and formatting; product inputs are unchanged.

Real phone hardware, live YouTube playback, live system capture, and all 42 locales' visual
layout have not been tested by these synthetic checks.

## Release and recovery

PR [#360](https://github.com/hiefny/MUSIXQUARE/pull/360) merged as
`4934720117e6a14c65ddf10bf268fe473527eb11`. Final PR CI
[38828527260](https://github.com/hiefny/MUSIXQUARE/actions/runs/38828527260)
passed all 11 jobs. The review of `f9096c45` completed with no findings;
`fddfc20b` changed only a test fixture and documentation compared with those
reviewed product inputs. Exact-main CI
[38829164350](https://github.com/hiefny/MUSIXQUARE/actions/runs/38829164350)
attempt 1 passed all 11 jobs: 570 unit files / 12,820 pass / 0 fail / 1 skip
(the Windows-only cross-drive rejection test on Linux), candidate browser 17
and critical browser 37 pass, with coverage, static, security and build gates.
Its candidate artifact `12016731046` contains 794 files. Selected main, CSS,
screensaver, HTML and service-worker hashes matched the inspected local output.
The actual toolchain distinction is recorded in Verification above.

App-only [Production Release 38829782253](https://github.com/hiefny/MUSIXQUARE/actions/runs/38829782253)
attempt 1 succeeded with Developer API D1=false. It was dispatched at
09:29:40 KST; the deploy job completed at **09:32:19 KST on 2026-10-16**.
App version `16724e7d-ce3a-477a-9fc5-8f476fa02133`, deployment
`b3051793-e58d-4014-ad26-9d0d59ee4fd7`, carries the exact-main release message.
Final ownership verification completed at 09:32:14.943 KST and the coherent
SHA/app marker was committed and persisted at 09:32:14–15 KST.
The five unselected Workers retain their `d9364cd9` provenance and the exact
IDs listed in the current release record. Their compatibility recheck completed
at 09:31:27.807 KST with every target compatible.

All four workflow smoke checks passed: App generation, anonymous App account
boundary, current PRO public boundary and Standard HTTPS signaling. Generation
converged for three consecutive reads of `main-Bh2elkZ1.js` (430,614 bytes)
and verified 29 assets. Checks outside the selected release scope were skipped.
The deployment artifact is
`production-deployments-4934720117e6a14c65ddf10bf268fe473527eb11-38829782253-1`
(artifact `12017086097`); the coherent commit artifact is `12017210750`.

At 09:33:30–39 KST, read-only public checks and an isolated same-origin
component harness passed seven checks. Public root, SW, bootstrap, main,
screensaver HTML and renderer were HTTP 200; index, main, SW, child and renderer
hashes matched the exact-main candidate. The child used
`/assets/screensaver-runtime-27fec4a4.js` with the SHA-256 recorded above.
Scoped CSP, geolocation delegation and immutable renderer headers were checked.
Genuine Google Sans 500/700 loaded, controls/CTA were transparent, idle fade and
pointer reveal worked, and music toggle, Korean controls and close bridge passed.
There were zero page errors, blocked requests or backend writes. Screenshots at
160×160, 320×240, 1280×720 and 1920×1080 were visually reviewed; the title's
horizontal clipping is its intended marquee window. Browser service workers
were disabled in this component harness; public SW bytes/epoch/routes were
checked separately. This does not claim live-room command/playback tests,
live weather, real system capture or physical-device coverage.

Post-release [Operations Drift Audit 38830140855](https://github.com/hiefny/MUSIXQUARE/actions/runs/38830140855)
attempt 1 succeeded. Its 09:33:43.856 KST report recorded 31 pass / 0 fail /
5 manual-only; the job completed at 09:33:53 KST. Those manual checks remain
manual, and unrelated release-record open items remain unchanged.

The recovery checkpoint completed at 09:30:48.265 KST after starting at
09:30:46.876 KST. Artifact `12016851601`, named
`production-recovery-checkpoint-4934720117e6a14c65ddf10bf268fe473527eb11-38829782253-1`,
preserves App `0d08447cb1447edb3a32a49fb872da450db793bf` (8.10.27/v693),
version `66b01d9f-4fa2-4441-9fd7-60c1b032aab0`, deployment
`106ea65b-12c6-4800-bac0-926be3d6965b`. No recovery was needed and the
independent recovery job was skipped. Captured floors were ready under
`d9364cd9`; generation floor
`4c5612d5fc4c5548781eb7d5b26d6904969c051c`, entitlement and existing
Developer API authority awareness were verified. Existing service-control,
Soro and optional PRO entry-password contracts remain; no new floor is added.
An authorized App rollback removes the screensaver and its permission/CSP
surface; the stored music toggle is harmless. Ownership/floor checks remain
required and the checkpoint is not a user-data backup.

The preserved standalone HTML was rehashed after deployment and still matches
`7e07e0eddb767f89e891ed3473595a52f3b049b70a912cce1cc2ab7adff0c3f0`.
External evidence files are `release-38829782253-evidence.json`,
`production-smoke-results.json`, `ci-38829164350-summary.json` and
`ci-38829164350-candidate-evidence.json` in the task's
screensaver evidence directory; release/candidate/Drift artifacts
are attached to the linked workflow runs. This closes only the initial
8.11.0/v696 deployment-readiness item.

## Control shadow follow-up

The owner authorized another App-only production deployment on 2026-10-16,
**8.11.1/v698**, Developer API D1=false. The final scope removes black control
shadows, adds smooth entry/exit fades and automatic fullscreen with prior-state
restoration, replaces the music toggle with a small two-line track footer, removes
the music slide, and reduces the gap between weather temperature and description.
The owner explicitly chose to hide the footer after five idle seconds together
with Back, revealing both again on input. The earlier light-toggle request is
superseded by removing the toggle before this release.

The footer uses the current track title and existing App `track-artist` text,
including codec/bitrate or capture details. Long text stays within two single-line
rows. The cycle contains only clock, date, weather, air quality and moon. Existing
hero glow and directional text transitions remain. Music visibility preferences,
toggle messages, unused translations and the privacy claim about storing that
preference are removed; previous stored values are harmless and ignored.

Entry requests fullscreen synchronously at the command boundary, before the lazy
host import. If the API is unavailable or rejects the request, the screensaver
still opens in the available viewport. Closing releases only fullscreen entered
by this session; pre-existing fullscreen stays active. Entry/exit fades respect
reduced motion. YouTube and session teardown close immediately. A pre-existing
fullscreen subtree hosts the overlay, with ancestor-aware inert ownership and
temporary placement of higher-priority centered dialogs in that visible subtree.
The existing iframe permissions suffice; no additional header, dependency,
protocol, schema, secret, binding or recovery floor is added.

The source and local verification are recorded below. The initial 8.11.0
deployment above and the completed 8.11.1 exact-main candidate/production evidence
under [Follow-up release and recovery](#follow-up-release-and-recovery) are
separate release records.

Host lifecycle evidence was collected for product source
`bd7a5757056d4952c7906a511c522b801b5b1960` on local Windows with Node
24.13.1 and npm 11.8.0. The focused screensaver, chat and extended DOM suites
passed **218/218** tests. Application and test TypeScript checks, targeted ESLint
and whitespace checks passed. These results do not claim completion of the
separate whole-repository gates, browser suite, exact-main candidate or release.

The host tests cover requesting fullscreen during synchronous command dispatch
before the lazy import, no-session/YouTube rejection, duplicate commands, API
rejection and absence, preserving existing fullscreen, closing before a pending
request succeeds, user fullscreen exit, and another command during the closing
fade. They also cover bounded fade teardown, reduced-motion immediate close,
immediate YouTube removal during an exit fade, and restoration of modal focus
and listeners. Nested-fullscreen cases cover ancestor inert ownership, a
higher-priority dialog's visible portal and original parent/sibling restoration,
fullscreen exit after the screensaver has already closed, explicitly removed
dialogs remaining removed, and dialogs recovered from a removed fullscreen
container. Obsolete music preference/toggle behavior is no longer asserted.

Two initial timer assertions incorrectly expected the entire jsdom fake-timer
queue to be empty after iframe removal. They were narrowed to verify that the
screensaver's named managed close timer is absent after bounded or forced
teardown; unrelated platform work is not treated as a screensaver leak. The
final 218-pass result follows that correction and the portal lifecycle tests.

A separate Chromium probe executed the actual entry helper without user
activation. The native standard Fullscreen API rejected the request with its
expected user-gesture warning, produced no page error, kept the entry usable,
and permitted release and a new entry. The first probe measured activation from
Playwright evaluation, which itself supplied activation; the corrected probe
captures it inside the initial document script before requesting fullscreen.
Both records are retained as `controls-v697/fullscreen-rejection-initial-probe.json`
and `controls-v697/fullscreen-rejection-report.json` in the external evidence
directory. The probe did not create a room or write backend state.

The pre-review v697 implementation used the standard Fullscreen API. Vendor-prefixed APIs
and physical Safari/iOS behavior are not established by these local
unit tests or the Chromium rejection probe; real-browser entry/exit and nested
portal validation are recorded separately when completed.

The whole-repository typecheck, lint and format gates passed for this product
source. The first full local unit run, concurrent with other analysis, completed
570 files with 12,825 pass / 8 fail / 0 skip in 274.29 seconds. Failures were seven
timeouts across App CORS cleanup, dead-export analysis, release-deployment and
SW-cache guards, plus one localhost workerd socket closure in the 99-guest PRO
burst. All five affected files were rerun with the original timeouts and
`--maxWorkers=1`: **427 pass / 0 fail / 0 skip**, 171.64 seconds. This covers all
12,833 cases across the full run and isolated rerun; it is not a claim of a single
clean full-suite run. No implementation or timeout change was used to obtain the
rerun result.

Committed-source `build:checked` passed, including Chromium 79 compatibility,
release identity, production security, font ownership and 97 SW app-shell assets.
The first attempts stopped on the report's lowercase scratch-folder spelling;
correcting that prose resolved the brand guard. The output renderer is
`/assets/screensaver-runtime-1c8b7f5e.js`; main is `main-DqocsVjQ.js` (432.38 kB
raw). The eager-transfer gate passed at 2,011.0 KiB raw / 537.7 KiB gzip; renderer,
background and Google Fonts remain lazy.

The built child component passed real Google Sans 500/700 checks at 160×160,
320×240 and 1920×1080 with zero page errors. Root reviewed the 320px and 1920px
captures: the small two-line footer fits, all chrome backgrounds are transparent,
and Back/location controls plus their descendants and pseudo-elements have no
black shadows in normal, hover and keyboard-focus states. The passive footer has
no text/box/drop shadow, and no toggle or music scene remains. Existing canvas
glow is unchanged. Independent source review of `bd7a5757` found no remaining
blocker after the lifecycle and portal fixes.

Actual Canvas measurements with Google Sans covered 48 weather combinations:
four viewports, four temperatures and three descriptions, all fitting without
numeral/degree overlap. At 1920×1080 with `24°` and `Mostly clear`, the numeral-to-
description gap is 62.2px (0.12em), 0.171em less than the deployed layout. The
measurement uses the product layout functions; it is separate from live weather
or a physical-device test.

The final local Chromium screensaver suite passed **11/11** in 1.2 minutes using
the unchanged product source with follow-up test corrections. It covers connected
file playback, synthetic system audio, immediate YouTube interruption during a
fade, the two-line footer and five-scene sequence, idle hide/reveal, real native
fullscreen with active user gesture, sampled entry/exit opacity, existing root
and nested fullscreen preservation, visible higher-dialog placement/restoration,
delayed font loading and 160/320/1920px layouts. Page-error assertions passed.
The first run had five test-assumption failures: initial `Clock` casing and four
attempts to resize a native-fullscreen Windows Chromium window through CDP.
The initial label assertion is now case-insensitive. Only the four viewport
cases disable the API to exercise the documented fallback; the three dedicated
fullscreen cases retain the native API. This does not claim physical-device or
live YouTube/weather/capture-provider verification.


The pre-WebKit PR head `fc81e8be7647f8ffcfea64e84b5440fa00ec088c` passed
[CI 38833870743](https://github.com/hiefny/MUSIXQUARE/actions/runs/38833870743):
all 11 jobs, 570 unit files / 12,832 pass / 0 fail / 1 Linux skip, candidate
browser 17 pass and critical browser 40 pass. The remote review identified
a P2 prefixed-WebKit fullscreen gap. The compatibility correction and its
final-source verification follow; this earlier CI is not the final candidate.

### Prefixed WebKit correction — source f207dde6

Committed source `f207dde636b967802bba459bdd93cbfc41dee2a4` adds the prefixed
WebKit compatibility correction for **8.11.1/v698**. On local Windows with Node
24.13.1 and npm 11.8.0, the focused screensaver, chat and extended DOM suites
passed **230/230** tests. Application/test TypeScript, touched-file ESLint and
Prettier checks passed. The earlier v697 results above remain evidence for their
own source; they are not substituted for this corrected source's release gates.

A shared fullscreen helper reads standard and both prefixed WebKit fullscreen
element properties, selects the matching exit method, and observes standard and
WebKit change/error events. Root and nested fullscreen states are preserved on
close, and centered-dialog placement/restoration uses the same fullscreen
identity. The standard request is preferred, with the prefixed request available
when it is absent or rejects. Unsupported or rejected fullscreen still permits
the normal-viewport screensaver. The child footer, five-scene cycle and weather
layout are unchanged by this compatibility correction.

Legacy WebKit methods can return no promise. Their pending request or exit is
settled by the matching native event or a bounded **1.5-second** timer, so a silent
failure cannot indefinitely retain the entry lock. Cancellation keeps the needed
listeners until settlement, restores a late successful request within that
window, and clears the managed timers/listeners when cleanup completes. Attempt
generations and matching error-event types prevent a queued standard
`fullscreenerror` from prematurely settling an active WebKit fallback or exit.
Focused regressions cover these asynchronous void-return paths, cancellation,
silent failure, both prefixed property spellings, and root/subtree restoration.

The first v698 Chromium run had 7 pass / 4 fail. Its four viewport fixtures
disabled only the standard request method; Chromium correctly used its WebKit
fallback, after which Windows CDP refused to resize the fullscreen window.
The fixtures now disable all three request-method names only in those four
fallback-layout cases. The dedicated native-fullscreen cases passed; product
source `f207dde6` is unchanged. The initial log is `controls-v698/e2e-final.log`,
and the corrected-fixture rerun passed **11/11** in 1.2 minutes, recorded in
`controls-v698/e2e-corrected-fixture.log`.

The corrected fixture passed E2E TypeScript and tooling ESLint; the dead-export
guard also passed. Independent review of the exact product source found the
remote P2 addressed and no remaining source blocker. Committed-source
`build:checked` passed all gates, including legacy Chromium 79, production
security, fonts and 97 SW app-shell assets. Eager transfer is 2,012.3 KiB raw /
538.2 KiB gzip, with zero eager font bytes. Main is `main-qPp9zuuJ.js` (433,142
bytes); the child renderer remains `screensaver-runtime-1c8b7f5e.js` with SHA-256
`1c8b7f5e606c9788a10bc94e3bfd3572522723f85a0bc88913eafa572eb1b0d9`.

Final PR/exact-main CI and production evidence are recorded below. The prefixed-API
tests use controlled DOM fixtures and do not establish behavior on physical
Safari/iOS devices or replace the separate native Chromium browser checks.

### Follow-up release and recovery

The earlier 8.11.1/v697 preparation was not deployed. PR CI
[38833870743](https://github.com/hiefny/MUSIXQUARE/actions/runs/38833870743) passed all
11 jobs at `fc81e8be7647f8ffcfea64e84b5440fa00ec088c` before the remote P2 review
identified missing prefixed WebKit fullscreen support. Its implementation, local
unit/browser/font/weather results and CI success remain historical evidence.
Final source `f207dde636b967802bba459bdd93cbfc41dee2a4` incorporates the compatibility repair.
Verification: 230/230 focused unit tests; app/test TypeScript, touched ESLint/Prettier, corrected-fixture Chromium 11/11 and committed build:checked passed. Review result: independent review of the exact product source: remote P2 addressed, no remaining source blocker.
Physical Safari/iOS behavior must not be inferred from synthetic prefixed-API tests.

PR [#361](https://github.com/hiefny/MUSIXQUARE/pull/361) merged as
`cedc0b04707ed619647a3897f54bc1c3bcfd64e2`. Final PR CI [38835405515](https://github.com/hiefny/MUSIXQUARE/actions/runs/38835405515)
passed all 11 jobs. Exact-main CI [38835888083](https://github.com/hiefny/MUSIXQUARE/actions/runs/38835888083)
attempt 1 passed 11 jobs, with 570 unit files /
12,844 pass / 0 fail / 1 skip (Windows-only cross-drive path case on the Ubuntu runner),
candidate browser 17 and critical browser 40 pass.
Candidate artifact `12018813302` contains 794 files.
Its actual manifest toolchain is Node 24.20.0 / npm 11.19.0 / Wrangler 4.148.0; installation used Corepack with the repository-pinned npm 12.0.2 (`corepack npm ci`).
The selected main/renderer/HTML/SW hashes match the locally checked final product inputs and the artifact manifest. These
results are distinct from the earlier local full-run-plus-isolated-rerun evidence.

App-only [Production Release 38836510116](https://github.com/hiefny/MUSIXQUARE/actions/runs/38836510116)
attempt 1 succeeded with Developer API D1=false. The seven existing
App D1 baseline apply/verify steps succeeded idempotently; Developer API D1 steps
were skipped. This change adds no D1 contract. Dispatch was
10:41:54 KST and the deploy job completed **10:43:49 KST on 2026-10-16**.
App version `065ead32-e74a-4e47-b3ad-d5643ae20744`, deployment `c9f13516-65a3-4c86-96be-e44798d17dd2`, carries the exact main SHA.
Final ownership verification completed 10:43:44.595 KST; the coherent
SHA/app marker was committed/persisted 10:43:44–45 KST. The five unselected
Workers retain their recorded version/deployment IDs and `d9364cd94ef036c5202ebf20cf5fff0b68d8cacf` provenance; compatibility recheck completed
10:43:17.396 KST with status `compatible`.

Workflow smoke: all four passed: App generation, anonymous App account boundary, current PRO public boundary, and Standard HTTPS signaling. App generation converged for
3 reads of `/assets/main-qPp9zuuJ.js` (433142 bytes), 29 assets.
Deployment/coherent artifacts: `production-deployments-cedc0b04707ed619647a3897f54bc1c3bcfd64e2-38836510116-1` (`12018934083`); `production-commit-cedc0b04707ed619647a3897f54bc1c3bcfd64e2-38836510116-1` (`12019497908`).
Public-production component evidence: 8 checks passed from 10:44:25.685 to 10:44:36.410 KST, including scoped CSP/permissions and immutable runtime headers, genuine Google Sans 500/700, translated back/close bridge, transparent shadow-free controls and passive footer, shared idle fade/pointer reveal, zero page errors and zero backend writes. Layouts at 160×160, 320×240, 1280×720 and 1920×1080 passed; the root reviewer visually inspected the 320×240 and 1920×1080 production captures.
Candidate identity comparison: all six public responses (index, main, service worker, bootstrap, child HTML and renderer) exactly match artifact `12018813302` from the successful exact-main CI, including byte counts and SHA-256 values. Actual renderer:
`/assets/screensaver-runtime-1c8b7f5e.js`, SHA-256 `1c8b7f5e606c9788a10bc94e3bfd3572522723f85a0bc88913eafa572eb1b0d9`.
This production check used public assets in an isolated synthetic same-origin parent with browser service workers blocked; public SW bytes, cache epoch and routes were checked by read-only fetch. It does not establish behavior in a live room, live weather/YouTube, real system-audio sharing, physical Safari/iOS, or other physical devices. Parent command/playback guards and native Chromium fullscreen are supported by the separate automated tests above, not by this production component check.

Post-release [Operations Drift Audit 38836731860](https://github.com/hiefny/MUSIXQUARE/actions/runs/38836731860)
attempt 2 concluded **success**. Report 10:46:54.558 KST:
31 pass / 0 fail / 5 manual-only; job completed 10:47:09 KST.
Published report artifact: `12019408760`. Attempt 1 had already completed the same
31/0/5 audit successfully, but its workflow failed when `Upload drift report`
received `FinalizeArtifact ECONNRESET` at 10:45:11.605 KST, so that attempt published
no report artifact. The safe failure summary and workflow log are preserved under
the external screensaver evidence directory's `drift-38836731860-attempt-1/`; the verified published
report is under `drift-38836731860-attempt-2/report.json`. The upload failure is not
a failed live configuration check.
Manual-only items and unrelated open work remain open.

Checkpoint `production-recovery-checkpoint-cedc0b04707ed619647a3897f54bc1c3bcfd64e2-38836510116-1`, artifact `12019706238`,
started 10:42:46.318 KST and completed 10:42:47.293 KST.
It preserves `4934720117e6a14c65ddf10bf268fe473527eb11` (8.11.0/v696),
App version `16724e7d-ce3a-477a-9fc5-8f476fa02133`, deployment `b3051793-e58d-4014-ad26-9d0d59ee4fd7`.
No rollback was needed or performed; the independent recovery job was skipped.
Captured floors and awareness:
ready at 10:42:48.727 KST, release floor `d9364cd94ef036c5202ebf20cf5fff0b68d8cacf`, generation floor `4c5612d5fc4c5548781eb7d5b26d6904969c051c`, generation/entitlement true; captured App provenance `verified-release-ancestor` with generation/entitlement/Developer API authority awareness all true. No new floor is added. Rollback to the preserved
8.11.0/v696 baseline restores its toggle/music scene and prior controls/entry behavior;
it does not remove the screensaver or its existing permission/CSP surface.
Old music preference values may be used again by that restored version. Ownership
and floor rechecks remain mandatory; the checkpoint is not a user-data backup.

Evidence in the external screensaver evidence directory:
`production-evidence-38836510116-1-with-drift-attempt2.json`,
`controls-v698/production-smoke-results.json`, `ci-38835888083-summary.json`,
`ci-38835888083-candidate-evidence.json`, `controls-v698/release-final-facts.json`,
and the artifacts attached to the linked workflow runs. Standalone HTML preservation:
`ambient-display-v5.html` was rehashed after deployment and remains unchanged, SHA-256 `7e07e0eddb767f89e891ed3473595a52f3b049b70a912cce1cc2ab7adff0c3f0`. This closes only the 8.11.1/v698
screensaver follow-up deployment-readiness item.
