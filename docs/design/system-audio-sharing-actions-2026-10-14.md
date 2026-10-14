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

Locally tested implementation source: `afb4ee3c5b0607dfbd9639c32aa634d8e96eea1b`.
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
PR [#331](https://github.com/hiefny/MUSIXQUARE/pull/331) CI
[38514900709](https://github.com/hiefny/MUSIXQUARE/actions/runs/38514900709) passed.
The earlier PR run
[38514475790](https://github.com/hiefny/MUSIXQUARE/actions/runs/38514475790) was
automatically cancelled when the documentation correction superseded its head;
it is not counted as a completed passing run. Concurrent PR #330 remains open
and is excluded from this candidate. Its separate release must advance the
identifiers again rather than restore 8.10.13.

Exact-main source `75842130bf2a2c7eb4f25fd16c6dafe0ec5d7ed7` passed all 11 jobs of
[CI 38515483411, attempt 2](https://github.com/hiefny/MUSIXQUARE/actions/runs/38515483411/attempts/2).
The Linux full-unit result was 562 files / 12,660 passes / zero failures / one
existing Windows-only PRO grant campaign CLI test skipped. The production
candidate browser checks passed 17 cases and the critical browser gate passed
29 cases. Static checks, broad coverage, Worker coverage, release-tooling
coverage and the immutable production-candidate build also passed. This exact
main result is the release candidate; the local and PR results above are
separate evidence.

The first main attempt did not complete its
[critical-runtime coverage job 115693204916](https://github.com/hiefny/MUSIXQUARE/actions/runs/38515483411/job/115693204916).
GitHub annotated that the job exceeded its 10m0s execution limit. Ordinary
cancellation was followed by force cancellation, and its final job conclusion
was `cancelled`. Retrieving the detailed log returned `BlobNotFound` / HTTP 404;
no test assertion result was available to establish why execution stopped
making progress. The cause remains unconfirmed. Neither a product defect nor
an infrastructure cause is established by that evidence.

Only the unsuccessful job was rerun at the unchanged exact main SHA; the ten
successful sibling jobs were retained. The
[second critical-runtime job 115697718309](https://github.com/hiefny/MUSIXQUARE/actions/runs/38515483411/job/115697718309)
passed all 60 files / 2,110 tests in 52.64s. A local Windows comparison at the
same main SHA passed the same 60 files / 2,110 tests in 58.09s. Both reported
82.02% statements, 77.05% branches, 88.05% functions and 86.09% lines. No test
assertion, coverage threshold or timeout was relaxed to obtain those results.
The successful rerun establishes current verification, not a fix or a root
cause for the first attempt's timeout.

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

App **8.10.14 / cache v680** was deployed through
[Production Release 38517124902](https://github.com/hiefny/MUSIXQUARE/actions/runs/38517124902),
attempt 1, `target=app`, Developer API D1 application `false`. The deploy job
completed successfully at **2026-10-14 14:34:04 KST**. PR
[#331](https://github.com/hiefny/MUSIXQUARE/pull/331) merged as
`75842130bf2a2c7eb4f25fd16c6dafe0ec5d7ed7`; main still matched that SHA immediately
before dispatch. No dependencies, schema, secrets, bindings, protocol or new
compatibility floor changed. Concurrent PR #330 remained unmerged and its copy
is not part of this deployment.

The successful exact-main CI result above authorized the release after its
second attempt. The immutable production artifact had already succeeded in
attempt 1 and was retained rather than rebuilt:
`production-candidate-75842130bf2a2c7eb4f25fd16c6dafe0ec5d7ed7-38515483411-1`
(artifact `11871601278`, SHA-256
`10690e951d4ae8309762a7e78be5684c02c6a793d5d992e31f5b8bda66d88e22`).
The release reverified its hashes and source identity.

| Evidence                      | Verified result                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immutable recovery checkpoint | Captured 14:32:53.812 KST, persisted 14:32:56 before mutation authorization and App deployment                                                     |
| Previous App                  | `d9364cd94ef036c5202ebf20cf5fff0b68d8cacf`, version `1ad37fdb-54bb-44a0-8b45-c2e711345ea4`, deployment `7cdfb7db-b3e6-42e0-a007-e72cb7144dd5`      |
| Recovery provenance           | `verified-release-ancestor`; generation, entitlement and Developer API authority aware; existing floors retained                                   |
| New App                       | Version `86c130ab-9ec1-4dba-9a78-76a20c041712`, deployment `d07dd99a-2b83-43b4-894f-a2fe87a6af53`, created 14:33:41.60476 KST, one version at 100% |
| Final ownership               | `verified` at 14:33:59.659 KST; deployment/version/message all match `git:75842130bf2a2c7eb4f25fd16c6dafe0ec5d7ed7`                                |
| Unselected Workers            | Both compatibility checks passed for PRO, remote-share, signaling and Developer API facade/backend; all remain at `d9364cd9`                       |
| Live smokes                   | App generation, anonymous account boundary, PRO public boundary and Standard HTTPS signaling all passed                                            |
| Commit marker                 | Exact SHA and `target=app` recorded; recovery job skipped because deployment succeeded                                                             |
| Public response               | 14:34:15 KST: root HTML HTTP 200 with `bootstrap.js?cache=v680` and Stop Sharing markup; service worker HTTP 200 with v680                         |

Post-release [Operations Drift Audit 38517373174](https://github.com/hiefny/MUSIXQUARE/actions/runs/38517373174)
also succeeded: its 14:34:56.218 KST report records 31 automated passes, no
failures and five manual-only checks. The manual checks are not claimed as
passes.

The immutable checkpoint, deployments and production-commit artifacts are
retained on the release run. Unselected Worker smokes, PRO generation readiness
restoration and signaling Custom Domain verification were correctly skipped for
this App-only release. These skips are not failed checks or actual PRO SFU
browser tests. No additional release is needed for the documentation follow-up.

An App rollback to the verified checkpoint restores the separate sender buttons
without a data migration. Existing recovery floors remain binding, and the
checkpoint is deployment evidence, not a backup of user data.

## Post-release review follow-up — 2026-10-14

Read-only source review at `10a815a0d49ee8f9855d4662a68c02192d16d049`
(App behavior unchanged from deployed `244866b8`, 8.10.16/v682) confirms two
follow-ups. No tests were rerun and no runtime changes were made in this review.

- Optional motion failure: `player-controls.ts` updates the accessible Stop
  sharing name and its click handler uses current ownership, but
  `sharing-action-motion.ts` alone writes `data-sharing` and manages Sync's
  disabled/inert/aria-hidden state and focus transfer. If the factory throws,
  the port catches it and leaves Media visible although its action stops local
  sharing. The existing failure test only asserts no throw and a warning;
  player-controls tests always register the working factory. This is a confirmed
  exceptional-path presentation/accessibility defect, not an observed production
  failure or an authorization bypass.
- Layout maintenance: the 12px action gap is repeated in the row, half-width,
  Stop label width and desktop geometry (332px = 160px * 2 + 12px); JavaScript
  measures columnGap. Values currently agree. A shared CSS gap token would avoid
  future inconsistent edits; this is not evidence of a current geometry jump.

Recommended follow-up: the always-available controls layer owns visible state,
accessibility and focus, while optional motion owns measurements, hover and
timers. Prepare motion against the previous geometry before committing semantic
DOM state, and isolate both factory and update exceptions. Pin absent/throwing
factory, update failure, late registration and teardown/ownership changes before
shipping; preserve existing pointer/hover behavior. No deployment is requested
or performed by this documentation follow-up.
