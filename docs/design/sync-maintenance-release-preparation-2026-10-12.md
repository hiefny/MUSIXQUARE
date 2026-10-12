# Synchronization release preparation — 2026-10-12

## Scope and owner decision

Prepare App 8.10.2 / cache v661 from the accumulated PRO clock, Standard
rendezvous learning, and per-device Android YouTube output corrections. The
current production baseline is 8.10.1 (`9c924ee1`), recorded by main `9fbe830e`.
That baseline's PRO duration hardening was merged into this branch as
`7395b1d8`; its optional duration-report exception guard and regression test
remain intact. No new Worker, binding, secret, D1 migration, or dependency is
introduced by this release.

On 2026-10-12 the owner selected an operational maintenance release beginning
no earlier than **2026-10-13 00:00 Asia/Seoul / 2026-10-12 15:00 UTC**. They
explicitly accepted that old and new clients need not be strictly prevented
from meeting. The uncommitted Standard admission gate and capability-v3
experiment were therefore removed. Capability v2 and existing admission remain.
No new critical-update system, forced reload, or compatibility fallback is added.

This supersedes the requirement for a guaranteed same-version boundary in the
earlier [Android report](android-youtube-output-baseline-2026-10-12.md), not its
mixed-version measurements. Old open/sleeping tabs can still rejoin and an
Android-host old/new combination can retain a 250 ms mismatch. Maintenance does
not prove zero users or replace the code running in an existing document.
The notice asks users to reload/reopen before rejoining; it is not enforcement.

## Review corrections

- `a0ec448c`: PRO release-time output-position shortfalls of at most 40 ms
  no longer trigger a new iframe seek. Record the bounded ignored amount in
  `ignoredOutputPositionAdvanceMs`; larger shortfalls and other catch-up causes
  retain their existing handling. Tests cover 1/20/40/41/50/150/250 ms, end
  clamping, and coexistence with target/callback catch-up.
- `a0ec448c`: a consumed Standard host end hold no longer synthesizes ENDED on
  every UI tick. The occurrence identity guard permits the next/repeated track.
- A newly reproduced public-control case: absolute seek and relative skip during
  a local negative-start hold or Android output-tail hold previously broadcast
  PAUSED although the room was playing. The seek path now recognizes those same
  logical-playing states as the play/pause path. Four cases failed before the
  change and pass afterward; subsequent pause fences stale release callbacks.
- The sync flight recorder is prepared through the existing awaited room/demo
  loaders instead of at initial setup. Successful initialization precedes the
  first playback/protocol event; failure remains optional. The reviewed deferred
  app-shell graph includes its static closure for offline installation.
- The eager chat callers now use a small synchronous PRO send port rather than
  importing the entire socket/clock implementation. Before initialization it
  returns false; the existing bridge retains connection/authority checks. It
  introduces no queue, replay, wire change, or optimistic send success.
- The final review reproduced another Standard-host boundary: changing/resetting
  the manual offset while a negative local-start wait was pending treated the
  physically paused iframe as a paused room and could leave its old release
  scheduled. The handoff captures the pending canonical clock, preserves playing
  intent and cancels the previous start through the existing runtime bridge.
  Zero/250 ms output and reset/replacement offsets all reproduced before repair.

## Verification

Environment: local Windows, Node 24.20.0, npm 12.0.2, Vitest 5.0.3 and
Playwright 1.63.0. First covering runtime source:
`6e03bc2d2639aae530313b6787e6aed46e687363`. These branch results are not an
exact-main CI release candidate; final repair results are recorded separately.

- Admission cleanup: 14 files, 789 passed / 0 failed / 0 skipped.
- PRO review after main integration (`7395b1d8`): 4 files, 242 passed / 0 failed /
  0 skipped.
- Standard consumed-END: 178 passed; held-start/tail seek suites: 317 passed.
- Worker type/policy checks passed. Dependency audit: 0 vulnerabilities;
  482 registry signatures and 105 attestations verified.
- `build:checked` on `6e03bc2d` passed, including cache history, initial-transfer,
  production-hook/security and offline app-shell guards. Eager JavaScript gzip
  is **464,782 B / 468,160 B**, eager total gzip **537,870 B / 543,400 B**.
  The initial conditional-recorder-only attempt had remained over budget at
  469,437 B; the synchronous send port removed the remaining eager dependency.
  Limits and the protected reserve have not been raised or weakened.
- Import graph, EventBus pairing, Standard hot-path policy, chunk-pump and
  lifecycle-write guards passed. Loader-focused tests: 174 passed; sender and
  affected callers: 328 passed. New loader and send-port coverage is 100%.
- The first full suite on `6e03bc2d` had 12,347 passed / 1 failed / 0 skipped
  across 550 files. The failure was the active-PUT/fresh-authority completion
  assertion in `runtime-media-mutation-authority.test.ts`. Investigation is
  complete: its zero-time timer flush raced an optional duration probe's dynamic
  import. A controlled pending probe reproduced the same assertion failure.
  The repaired test explicitly resolves that probe, also checking cancellation
  and stale results across the old grant. No timeout or product behavior changed;
  the existing 250 ms metadata-tail test remains. Related four files: 75 passed.
- The production candidate browser run had 8 passed / 9 failed / 0 skipped.
  All nine failures observed a ready bootstrap with zero failures/fallbacks but
  rejected its 51 steps against the old 52-step test contract. Moving recorder
  initialization into room/demo readiness removed that one bootstrap step.
  The contract must be aligned and the browser run repeated.
- After aligning the exact bootstrap contract (49 safe initializers plus I18n
  and SyncWorker), all 17 production-candidate browser cases passed on the same
  `6e03bc2d` artifact. Healthy bootstrap still rejects both too few and too many
  steps; cached-navigation fallback adds exactly one. This verifies the new
  conditional-loading boundary, not the subsequently repaired manual-start code.

### Final covering source

The unpublished preparation commit was amended to include its final fixes and
the covering v661 cache advance. Final runtime source is
**`89db01847cf04dce3eca91d734a11b1b6c75a6e7`**; later documentation does not
change that tested source. `6e03bc2d` above identifies the intermediate local
attempt, not a remotely published production candidate.

- `build:checked` passed on the final source. Eager JS gzip **464,825 B** and
  eager total gzip **537,909 B** retain the unchanged ceilings and protected
  reserve. All 94 reviewed app-shell assets are included. Six Worker dry-run
  bundles also passed; no deployment was performed.
- Negative-start manual handoff: 4 red-before/green-after cases, an actual-player
  generation-fence test that deliberately invokes retired release/broadcast
  callbacks, and 443 related tests passed. Independent source review found no
  further confirmed defects in that handoff or the optional loading boundaries.
- The first final-source full suite ran alongside full typechecking and the
  production build: **12,353 passed / 1 failed / 0 skipped**. The remaining
  failure is a 30-second timeout in the localized-input release-contract test,
  which runs about 141 real Git processes in one case. All its nine compatibility
  scenarios ran; no behavioral assertion failed. Concurrent local load is a
  plausible cause, not established CPU-versus-disk attribution. The full suite
  was repeated without the competing build/type jobs; no timeout was raised.
- That isolated full run on the same final source passed **550 files / 12,354
  tests / 0 failed / 0 skipped** in 153.75 seconds. The real jq CLI checks ran
  on Windows. This replaces neither the record of the earlier failed run nor
  the required Linux/main CI evidence.
- Final full typechecking, app/tooling lint and formatting passed. All **17
  production-candidate browser tests** passed on the final production artifact.
- After the separate E2E-mode build of the same source, **61 selected Chromium
  browser tests passed / 0 failed / 0 skipped** in 9.8 minutes: the critical
  release subset, bootstrap contract, local-file sync, demo common start and
  reliability, chat, YouTube manual zero-start, Android output combinations,
  and rendezvous/drift paths. The release-smoke cases overlap between the two
  runs; these are execution counts, not 78 unique scenarios. Tests use local
  PeerJS and controlled service/iframe fixtures, not an actual Cloudflare room
  or acoustic recording. The complete cross-browser/live E2E suite was not run.

### PR evidence

[PR #305](https://github.com/hiefny/MUSIXQUARE/pull/305) initial head `26094bc4`
passed all 11 jobs in [CI 38262715122](https://github.com/hiefny/MUSIXQUARE/actions/runs/38262715122).
Linux broad-unit merge: 550 files, 12,353 passed / 0 failed / 1 skipped; the skip
is the existing Windows-only alternate-drive CLI case. Candidate browsers:
17 passed; critical browsers: 22 passed. Coverage gates for broad, critical,
Worker and release-tooling scopes passed. This PR result is not the required
exact-main-SHA candidate. A documentation-only follow-up records final local
browser results; its own final PR CI must complete before merge.
GitHub's Codex review completed on `26094bc4` with a thumbs-up and no findings;
the follow-up changes only this evidence and current preparation state.

## Maintenance execution sequence

1. Complete the normal reviewed PR and obtain the successful CI candidate for
   the exact final main SHA. If checks are incomplete or failing, postpone the
   production operation and leave the current service available.
2. At/after the authorized time, enable maintenance through the existing admin
   control and verify its settled state. Allow a short drain; do not assert that
   every P2P channel, suspended tab, or signed upload has stopped.
3. Disable maintenance and verify the settled control state and healthy public
   responses. Then immediately run Production Release with `target=app` and
   Developer API D1 application disabled. Keep maintenance OFF through all live
   smokes. This intentionally permits new arrivals between reopening and deploy.
4. Use the existing recovery checkpoint and release checks without bypasses.
   Verify the new App/cache, production behavior and deployment ownership, then
   update release-record §1 and append exactly one release-history row.

Why reopen before deployment: the existing workflow has no operator pause
between App deployment and generation/account/PRO/signaling smokes. Maintenance
also blocks the service worker and public app assets. Racing an OFF click against
the first smoke, treating 503 as success, or removing that check is not a safe
substitute for an explicit sequence. Full-window admission blocking is outside
the accepted scope.

## Remaining physical limits

Automated YouTube tests model the iframe and the fixed output delay; they do not
record acoustic output. Actual Android/iOS/Bluetooth timing and mixed-version
residuals remain explicit device checks. Android devices that hide Android in
both UA and client hints are not guessed from touch capability. This work does
not add automatic user-Sync retry or persisted PRO startup learning.
