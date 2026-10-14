# System audio sender action surface — 2026-10-14

## Scope and authority

The owner approved the desktop HTML motion prototype and its production
integration. A Standard host or the local PRO system-audio publisher now has
one full-width Stop Sharing action in place of the Sync and Media pair.
Receivers retain both controls and their existing capability explanations.
Stopping capture, changing publisher, leaving, and reinitializing restore the
normal controls. This change does not change playback or publishing authority.

The component preserves the actual application's start-aligned icon and label
frames (14px mobile padding; 16px padding and 22px icons on desktop). Stop
Sharing uses the existing full translation in all 42 languages, natural
wrapping, and a centered label. The surfaces animate for 300ms; labels fade for
180ms with a 75ms entry delay. RTL mirrors geometry; reduced motion removes
motion. The hidden Sync button is disabled, inert, and hidden from assistive
technology, with focus transferred before hiding.

Hover intent is held across geometry changes. A surface arriving beneath a
stationary pointer does not create an extra hover flash. Independent review
found that the sharing hover selector originally outranked this lock; excluding
locked rows from hover selectors fixes the cascade instead of adding important.
The browser regression checks computed colors after expansion and left-half
stop, including restoration when the pointer actually moves.
Actual-browser verification also exposed delayed native hover reconciliation
after dismissing the media popup. Morph completion now checks physical pointer
containment as well as `:hover` before releasing the lock. The Stop fallback
selector has deliberately lower specificity than the feature component, so
Vite's stylesheet insertion order cannot hide the label; nested labels and SVGs
inherit the component foreground instead of the generic light-theme color.

## Loading boundary

Playback action styling is imported by the complete `css/app.css` cascade.
The room boundary registers the deferred motion controller before starting
transport. A small synchronous binding port
retains only the current DOM generation and latest state; aborted bindings
cannot initialize later. Optional presentation initialization cannot reject
protocol listener installation.
The import-graph policy permits exactly this composition root's two imports of
the motion factory and binding port. This is an explicit presentation-wiring
boundary, not a general network-to-UI exemption: transport implementations still
cannot import these modules. Moving render code into a network/core directory
would conceal the dependency; an asynchronous event hook would weaken entry
ordering. The cycle and all other UI-layering checks remain unchanged.

The original eager implementation exceeded the previous transfer guard
(eager JS 468,778 B, eager total 545,040 B gzip). A CSS deferral experiment
lowered the measured graph but violated the legacy layer transform's requirement
to process the complete cascade: independently compiled chunks used incompatible
specificity ranges. That experiment is not shipped. The controller remains
conditionally loaded, while CSS stays in the common shell for consistent
desktop/mobile/theme/legacy behavior. The three aggregate capacity limits receive
a measured 5% working-room increase; entry limits, the 5% protected reserve,
zero eager fonts and secondary chunk limits are unchanged. See the
[dated capacity decision](initial-bundle-loading-policy.md#2026-10-14-sender-actions-and-aggregate-maintenance-capacity).
Service-worker closure tests retain the deferred controller for offline entry.

Controlled startup observations compare the prior PR #330 candidate artifact
(`46b7c7cd`, CI `38512631265`) with this component at `afb4ee3c`. These are
different version/copy builds, not an isolated animation CPU microbenchmark.
The same deterministic graph helper measured eager gzip 543,361 → 544,507 B
(+1,146 B, 0.211%), eager JS 467,876 → 468,087 B, and raw eager bytes
2,034,430 → 2,042,992 B. Ten alternating fresh Chromium 153 contexts used
390×844, 4× CPU slowdown, 150ms latency, 1.6Mbps down/750kbps up, gzip responses,
HTTP cache disabled, SW blocked, identical API 503s and external-request blocks.
All reached 51 ready steps with zero failures, fallbacks and page errors.
Ready medians were 3,844.2 → 3,842.9ms; FCP medians 4,092 → 4,108ms.
Five observations per build are not statistical equivalence or permission to
spend the entire new capacity without future review. The
[raw observations and artifact hashes](../performance/system-audio-sharing-startup-2026-10-14.json)
record the exact environment and limits. Offline behavior is tested separately.

## Validation

Tested source: `afb4ee3c5b0607dfbd9639c32aa634d8e96eea1b`.
Environment: Windows, Node 24.13.1, npm 11.8.0, Chromium Playwright. The remote
candidate uses the repository-pinned CI toolchain and remains separate evidence.

The first full-unit development run had 12,656 passes and five failures. Three
were actionable integration checks: the new legacy authority read was replaced
with the canonical coordinator API; the deliberate room composition imports
received the two exact documented layer exceptions above; the bootstrap URL's
cache mirror was advanced alongside its manifest. Two Git-fixture tests exceeded
their unchanged 30s/15s deadlines in the parallel local run. Final validation uses
four workers and retains those original deadlines and assertions.

The final full unit run passed all 562 files / 12,661 tests, with no failures or
skips (341.31s). `build:checked` passed at the committed source, including the
legacy Chromium 79 cascade, production-hook exclusion, service-worker shell,
font and protected-headroom checks. All 17 production-candidate browser checks
passed without retries (37.2s), including cold bootstrap and service-worker
fallback navigation. These are local evidence, not the required exact-main CI
release candidate.

All 36 focused Chromium E2E checks passed without retries (1.3m): system-audio
controls 3, adaptive actions 10, RTL player layout 13, component cascade 7 and
demo session layout 3. The built-app regression explicitly verifies visible
Stop Sharing text, red text/icon, expanded/restored geometry and computed hover
colors. Expanded and restored desktop screenshots were visually checked.
The full local typecheck, lint and formatting checks also passed. Two independent
implementation reviews found no remaining concrete blockers. GitHub review
identified an outdated version in the documentation evidence index; it was
corrected to 8.10.14/v680 without changing runtime inputs.
Concurrent PR #330 does not change these action labels or component behavior.
If it lands before this release, preserve its copy while retaining 8.10.14/v680;
if it lands later, that separate release must advance the identifiers again.

Focused tests cover Standard sender/receiver and disconnected guest authority,
PRO member-publisher reassignment, focus/abort/resize/reduced-motion lifecycle,
late factory registration, and initialization failure isolation. Browser tests
exercise a real local Standard peer connection with synthetic capture tracks.
Authored-DOM probes cover all 42 stop labels at 320px and 1440px, LTR/RTL, and
normal/200% text size.

Limits: the synthetic capture fixture does not validate native OS picker,
actual audio capture, Safari devices, or a production PRO SFU. PRO publisher
transitions are covered by unit state/service tests, not an actual PRO browser
session. The full serial E2E suite is not claimed for this scoped UI change.

## Release and recovery

Prepared identity: App 8.10.14 / cache v680. Target: App only; Developer API
D1 application disabled. No dependencies, schema, secrets, bindings, or protocol
changes. No new compatibility floor. Production authorization requires the
successful exact-main-SHA CI candidate and normal release workflow.

An App rollback to the verified pre-release checkpoint restores the separate
sender buttons and previous copy without a data migration. Existing recovery
floors remain binding. Actual release, checkpoint, smoke, ownership and public
asset evidence will be recorded after deployment.
