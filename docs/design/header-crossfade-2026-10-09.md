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
- At this initial stage, reviewed PR, successful exact-main CI candidate,
  production workflow and live smoke checks were pending. Their final outcomes
  are recorded under the production release below.
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
- Final product SHA: `652297954cd0d88bef018cc3d7c47f972f0457bc`. Full unit rerun:
  531 files, 11,017 pass / 1 existing skip / 0 fail with eight workers. All seven
  required static checks pass again, and `build:checked` passes on committed
  `65229795`. Final browser input hashes match this product source. Evidence:
  `final-full-unit.json`, `curtain-static-results.json`,
  `final-build-checked.log`, `browser-results.json`.
- The old PR CI candidate was superseded by the curtain fix. Final-head PR CI
  and exact-main CI subsequently passed; the final release is recorded below.

## Production release — 2026-10-09

Automated review on the initial head of [PR #279](https://github.com/hiefny/MUSIXQUARE/pull/279)
reported the P1 permanently mounted curtain condition. The fix and regression
evidence above resolved it; final independent review found no remaining blocker.
Final-head [PR CI 37929168928](https://github.com/hiefny/MUSIXQUARE/actions/runs/37929168928)
passed all 11 jobs. The PR was squash-merged as main
`b831b9328500514df0cdc1853246af1d451e760e`.

[Exact-main CI 37929745403](https://github.com/hiefny/MUSIXQUARE/actions/runs/37929745403),
attempt 1, passed all 11 jobs on Ubuntu / Node 24.20.0:

- Full unit suite: 531 files, 11,017 pass / 1 existing Windows-only skip / 0 fail.
  Four coverage gates passed; their overlapping tests are not extra unique cases.
- Production candidate / Service Worker browser smoke: 17 pass; critical browser
  gate: 22 pass. These do not replace the physical iPhone check below.
- The immutable candidate contains 782 files; its SHA, release identity and all
  file hashes were verified. The 10 browser fixture input hashes match between
  the final product source and merged main, preserving the scope of Chromium50
  evidence without representing another browser run.

[Production Release 37930447317](https://github.com/hiefny/MUSIXQUARE/actions/runs/37930447317),
attempt 1, reused that candidate for `app` / Developer API D1 false and succeeded
at `2026-10-09T12:32:29Z` (21:32:29 KST). The deployed App is **8.7.9 / v645**:

- Deployment: `4493db1c-9cb1-4025-b790-9a4cc461c81a`.
- Version: `cdde09ba-db0a-49bd-bdbd-5a3d05f0f15a`, 100% allocation.
- Message: `git:b831b9328500514df0cdc1853246af1d451e760e`.
- Live App generation, anonymous account, current PRO public boundary and
  Standard HTTPS signaling smokes all passed. Final App ownership was verified
  and the coherent-production commit marker was persisted.
- The other five Workers remain at
  `ff7766ccc0c83ab1eee15bc030347e9067764ee6`; the partial-release compatibility
  recheck passed and this run did not deploy them.

Recovery was unnecessary; the recovery job was skipped. The immutable checkpoint
captured prior App SHA `12ecbf71d6fe27b7c1eca85abbc00a8575b1b4df`, deployment
`db79d475-d5f3-41e7-a6e1-e6ef4d921663` and version
`2e424812-cc95-4efa-a4d0-498e60ae49e8`. Any later recovery must follow the canonical
hotfix procedure and fresh ownership/compatibility-floor checks; this record is
not authority to overwrite an intervening deployment.

Evidence is preserved under `scratch/header-crossfade-2026-10-09/` in
`main-ci.json` / `main-ci.log`, `main-browser-input-verification.json`,
`release.json` / `release.log`, the downloaded candidate, `release-records`, and
`release-commit`. Initial failures and reproduction evidence remain unchanged.

At `2026-10-09T12:33:53Z`, public GETs for `/`, `/service-worker.js`,
`/bootstrap.js` and `/assets/main-DygJrkZk.css` all returned HTTP 200. All four
bodies matched the exact-main candidate's SHA-256 hashes. The index references
v645 and the delivered CSS includes the isolated-header selectors. These
read-backs are recorded in `live-assets.json`.

The new header change still requires the owner's physical iPhone Safari/PWA
check during loader start/end, seeking and tab switching. Synthetic iframe
fixtures, CI/release success and the earlier 8.7.8 owner confirmation do not prove
this new change's live YouTube compositing or physical audio behavior. Existing
open PWA clients are not assumed to have adopted the new code immediately.
Publishing this follow-up documentation requires no additional App release.
