# Beta QA — 2026-09-26, round 3

Baseline: `mxqr_beta` at `6ac14d56`. Scope: interrupted transfer/decoding,
preload reorder and current-track priority, room replacement and reconnect,
and settings synchronization across permission changes. Changes remain on beta;
there is no production deployment or app/cache version change.

## Confirmed findings

1. **Re-selecting settings synchronization ON could overwrite another
   administrator's effects.** The selected ON chip still emitted a preference
   transition. PRO interpreted that as a fresh opt-in to publish all local
   settings. A subsequent volume edit racing another administrator's update
   then retried the full snapshot after a revision conflict, replacing their
   reverb value. A runtime regression reproduced 43% reverb becoming 0%.
   The preference event now fires only when the boolean actually changes;
   real OFF-to-ON transitions retain their existing full-publish behavior.
2. **A cancelled PRO settings edit could resume after permission returned.**
   If effects permission was revoked and restored while a PUT or its conflict
   reconciliation GET was pending, the old task saw current authority and
   retried its discarded edit. Settings checkpoints now have a cancellation
   generation separate from edit revision. Explicit cancellation retires the
   old asynchronous task, while later edits in the same valid lifecycle still
   rebase normally. Regressions cover both asynchronous boundaries and verify
   that a fresh edit after permission restoration still publishes.
3. **An old PRO signaling request could reset its replacement's retry budget.**
   A fresh signaling ticket request can finish after the user leaves and creates
   another room. The peer-identity guard rejected the old connection but also
   reset the shared retry counter, restarting the new room's backoff and
   extending its five-attempt budget. The identity check now returns without
   touching replacement state. Regressions exercise both successful and failed
   late ticket responses and verify that the successor still exhausts exactly
   five attempts. This affects signaling recovery accounting, not an observed
   audio synchronization failure.

## Other investigation

- Current-track transfer priority, preload promotion/reorder, ACK ownership,
  completed-transfer recovery, and room/connection replacement produced no
  additional confirmed defect. Six focused storage suites passed 182 cases.
- Download/decode cancellation, native/bounded engine replacement, and preload
  source ownership produced no additional confirmed defect. Five ownership
  suites and the decode suite passed 214 cases.
- An existing ordinary-room behavior also counts repeated decoder startup
  failures toward the per-track failure limit. Distinguishing temporary engine
  initialization failures from bad media is a possible improvement, but simply
  removing the failed-track marker can reopen repeated file requests. This
  round preserves the bounded retry/skip policy instead of introducing an
  undefined temporary-suspension lifecycle. A local reproduction patch is kept
  in `scratch/qa-2026-09-26/guest-startup-classification-red.patch`.
- Peer setup cancellation, operator upload authority, and system-audio
  interruption were reviewed. The initial focused network/audio selection
  passed 128 cases.

## Verification

- Baseline local Chromium selection: **40 passed**, covering seeded session
  sequences, reconnect, file transfer, and preload.
- The two settings fixes reproduced failures before correction. Six new cases
  cover selected ON/OFF chips, concurrent administrator settings, revoked PUT
  and GET completions, and checkpoint cancellation. Related six suites passed
  **259 cases**; an independent review found no additional issue in these fixes.
- The two late-ticket regressions failed before the reconnect correction;
  the corrected peer initialization suite passed **38 cases**. These tests check
  that a replacement retains its retry budget through both ticket outcomes.
- Full repository typecheck and lint, import graph, dead exports, bus pairing,
  lifecycle writes, source complexity, and authority boundaries passed. After
  the final peer guard change, application/test TypeScript and the changed
  network files' lint/format checks passed again.
- Final full unit suite after the source freeze: **464 files, 9,667 passed,
  1 skipped**. The existing release-deployment-state check requires `jq`, which
  is unavailable in this Windows environment; CI does not allow that skip.
  The earlier in-progress run included the two reconnect regressions before
  their correction; the final run includes all eight new regressions and passes.
- Final rebuilt Chromium selection: **30 passed**, covering effects UI/state,
  settings-sync authority, administrator grant/revoke, and leave/rejoin.
  Together with the baseline selection, this is 70 successful executions of
  65 distinct browser cases.
- Local production-mode build and all eight artifact guards passed: test-hook
  exclusion, security configuration, legacy TV syntax, service worker, UI kit,
  initial transfer budget, fonts, and service-worker app shell. App `8.6.61`
  and cache `v630` remain unchanged. This was a local build check, not a deploy.

## Limits

Browser tests use local Chromium and local signaling. PRO authority and delayed
API responses are controlled fixtures. These checks do not establish physical
speaker alignment, live Cloudflare behavior, or iPhone Safari/PWA behavior.
The existing CI workflow targets `main` pushes and PRs into `main`; a beta push
alone does not imply remote CI execution.
