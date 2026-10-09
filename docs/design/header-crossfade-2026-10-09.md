# Header-independent tab crossfades — 2026-10-09

## Scope and cause

The owner confirmed the deployed App 8.7.8 YouTube tab flicker fix resolved the
reported iPhone symptom, then requested uninterrupted tab crossfades during
seeking and loading, including production deployment.

`showLoader()` previously suppressed every View Transition for 1,200 ms on both
show and hide. YouTube PAUSED/PLAYING callbacks call `showLoader(false)` even
when no header loader is visible, repeatedly renewing that window after a seek.
The suppression protected header CSS motion from old/new snapshot overlap; it
was not a playback synchronization or iframe lifetime requirement.

## Change

- Remove the global loading suppression timer and both callers.
- Ordinary tab transitions request a separate `main-header` snapshot group.
  Hide its old snapshot and show the live new image without a crossfade or
  group animation. Keep the header's existing logo/text/progress animations.
- Keep root crossfades when dialogs, fullscreen surfaces, chat, toast, or other
  occluding UI needs the original stacking order. Header isolation is then
  omitted; the transition itself is not suppressed. Setup and media-mode
  transitions retain their original compositing, including mixed callback batches.
- Recheck synchronous tab lifecycle effects before the new capture. A generation
  token prevents a superseded transition from clearing a newer header group.
  Completion, rejection, and start failures all release the temporary class.
- If a new occluding surface arrives asynchronously during the short tab fade,
  finish that obsolete transition immediately and release its observer/listeners.
  The next tab still crossfades without a timer or cooldown. Standard and legacy
  WebKit fullscreen states also keep their existing compositing.
- Preserve the 8.7.8 iframe parking fix, synchronous first-paint scopes, native
  unsupported-browser fallback, and playback/session behavior.

App 8.7.9 / cache v645; release target `app`, Developer API D1 false. There are
no dependency, schema, binding, secret, or protocol changes. The prior App
8.7.8 / `12ecbf71d6fe27b7c1eca85abbc00a8575b1b4df` is the recovery baseline;
the release workflow's fresh ownership/compatibility checks remain authoritative.

## Verification and remaining work

### Initial implementation and review evidence

Initial product commit: `54d28703b086bb55aac2f49f7e40f3ac613bedf8`, based on
`9e91ecd403d53f043bd35c4105b71aaa752de6e3`, Windows, Node 24.20.0. Unit/static
checks ran on that working tree before commit; the browser runner records exact
input hashes. The production build ran on committed `54d28703`. These local
results are not the successful exact-main CI candidate.

- Existing focused unit suite: 138 pass, 0 fail/skip.
- New tab/loading integration and transition lifecycle regression: 21 pass,
  0 fail/skip. Tests include batching, overlay appearance, overlapping completion,
  rejection, native failure, missing API, synchronous first paint, prefixed
  fullscreen, and asynchronous modal appearance/observer cleanup.
- Full local unit suite: 531 files, 11,011 pass / 1 existing skip / 0 fail,
  with four workers. This includes the 21 new regressions; focused counts are
  subsets, not additional tests. Required typecheck, lint, format, Worker syntax,
  Developer API/D1/drift guards all pass.
- Native Chromium 153 fixture: 40 pass / 0 fail / 0 page errors, source hashes
  stable during the final run. Four viewport sizes cover loader start/stop and
  redundant hide; occluder and dark/light cases preserve the original stack.
  Header CSS motion retains the same animation instance and advances across the
  transition; the iframe remains the same object. Six asynchronous overlay cases
  prove active-effect termination and a working next tab crossfade.
- Initial review found prefixed fullscreen handling missing and independently
  reproduced the asynchronous occluder window (6 reproductions, not fix passes).
  Both were corrected before final evidence. An intermediate 40-pass browser run
  failed its source-stability guard while the implementation changed; preserve
  it separately. Initial lint caught a Promise-valued conditional; corrected
  without changing lint rules. Final static/browser results above supersede
  these implementation-stage failures.
- Committed `build:checked`: pass, including release/cache identity and
  production asset/security/transfer-budget/service-worker guards.
- Reviewed PR, successful exact-main CI candidate, production workflow and live
  smoke checks: pending.
- Physical iPhone Safari/PWA verification of this header change remains a
  post-deployment owner check. The earlier 8.7.8 owner confirmation is not
  evidence that the new header change has already passed physical testing.

Browser fixtures use actual product CSS/modules with synthetic iframe content.
They cannot prove live YouTube compositing, synchronization, or physical audio.
Raw evidence is in `scratch/header-crossfade-2026-10-09/`: `full-unit.json`,
`final-static-results.json`, `browser-results.json`, their logs, and preserved
initial/reproduction runs. Independent code and release-scope reviews report
no remaining blocking issue.

### Follow-up: permanently mounted demo curtain

PR #279's automated review identified that the inactive `.demo-curtain` is
always present in the real document. Testing presence unconditionally prevented
header isolation. The initial reduced DOM fixture missed this, so its passes
do not establish the final real-markup behavior. Reproduction with the actual
inactive curtain produced 12 failing/9 passing unit cases and one failing
browser case; preserve `curtain-before.*` and `browser-curtain-before-*`.

The guard now checks computed curtain opacity and running/pending WAAPI state,
including `demo-chrome-hiding`. A finished reveal at opacity zero permits normal
tab transitions. Style mutations are observed as well as classes. The cache
advances again to v645 to cover this later runtime commit; v644 was never deployed.

- Final new regression suite: 27 pass, fail/skip 0; related UI/demo suite:
  274 pass, fail/skip 0.
- Final native Chromium fixture now uses the complete actual `index.html` body
  with scripts/noscript removed, completed-boot state, and synthetic iframe
  content. 50 pass, 0 fail/page errors, stable source hashes, visible mobile and
  desktop screenshots. This replaces the initial reduced-fixture counts.
- Final full unit rerun: 531 files, 11,017 pass / 1 existing skip / 0 fail
  with eight workers. Final static/build evidence and product SHA follow below.
- The old PR CI candidate is superseded by the curtain fix. Reviewed final-head
  PR CI, exact-main CI, and production release remain required.
