# Beta QA — 2026-09-26, round 2

Baseline: `mxqr_beta` at `763f77bc`. Scope: bounded file decoding and track
completion, file/YouTube transitions, manual-sync and demo state projections,
late join, background recovery, authority changes, and transfer isolation.
Changes remain on beta without a production release or release/cache version bump.

## Confirmed findings

1. **Trimmed bounded audio could wait for, or fail on, an unused encoded tail.**
   Container edits and gapless trimming can put the audible endpoint before
   encoded EOF. The scheduler continued reading after the final audible PCM was
   scheduled, and preparation still aimed for a full second even when less audio
   remained. A delayed or failed tail could prevent normal completion or reject
   playable audio. Regression fixtures reproduced these failures. Preparation
   now stops at the audible endpoint, and playback stops requesting PCM once
   its final audible span is scheduled. Decoder iteration is bounded to the
   endpoint plus the two real samples needed for interpolation. The guard reader
   retains those samples while avoiding unused tail reads, including endpoints
   inside a chunk. Native audio-clock stop times are unchanged.
2. **An open manual-sync editor could apply a draft to the wrong media mode.**
   File and YouTube offsets are separate device preferences. Switching modes
   while the panel was open retained the old displayed value or unfinished
   draft. Enter/blur could then write it to the other mode. Integration tests
   reproduced both the stale display and erroneous commit before the fix.
   The editor now tracks its offset target, refreshes on a mode change, and
   rejects stale commits even before the state listener refreshes it. Same-mode
   track changes preserve an unfinished draft.

The full lint run also found a pre-existing unhandled Promise in the
dead-export-analyzer test fixture. Its dynamic-import callback now includes a
rejection handler while retaining the import pattern tested by the analyzer.
This is test tooling, not a production playback defect.

## Other investigation

- YouTube last-seek rendezvous scheduling, pause cancellation, repeat boundaries,
  reused iframe callbacks, and PRO prepare/commit cancellation produced no new
  confirmed defect. Related focused tests passed (381 cases).
- The previous round's unexplained seed-470000 initial guest-playback timeout
  did not recur in five consecutive runs. This does not establish a root cause
  or claim the earlier isolated timeout was fixed.
- Existing finalized-transfer guards reject a recovery response that crosses
  transfer completion. No new transfer/reconnect defect was established here.

## Verification

- Full unit suite: **464 files, 9,659 passed, 1 skipped**. The existing
  release-deployment-state test requires `jq`, unavailable on this Windows
  environment; CI does not allow that test to skip. The final guard-frame
  arithmetic and its 44.1/48/96 kHz integer/fractional endpoint cases were
  included in this run.
- Full repository typecheck and lint passed. Application and test TypeScript
  projects were checked again after the final guard-frame refinement. Changed
  source formatting, import graph, dead exports, bus pairing, lifecycle-write
  discipline, and source complexity passed without weakening their baselines.
- Baseline Chromium interaction tests: **21 passed**, covering late join,
  background recovery, administrator grant/revoke, network isolation, and
  system-audio transport controls. Seed 470000 also passed **five consecutive
  executions**.
- Final rebuilt Chromium selection: **52 passed**, including 34 hybrid-engine
  and MP3/AAC parity cases, plus demo output recovery, demo controls, and manual
  sync. Together with the baseline selection and repeated seed, this round ran
  78 successful browser executions (74 distinct cases).
- Local production-mode build and all eight artifact guards passed: test-hook
  exclusion, security configuration, legacy TV syntax, service worker, UI kit,
  initial transfer budget, fonts, and service-worker app shell. App `8.6.61`
  and cache `v630` remain unchanged. This was a local build check, not a deploy.

## Limits

Browser testing uses local Chromium and local signaling; controlled fixtures
cover decoder failures, PRO authority, and delayed callbacks. These checks do
not establish physical speaker alignment, live Cloudflare behavior, real iPhone
Safari/PWA behavior, or exhaustive coverage of every long-session ordering.
The existing CI workflow targets `main` pushes and PRs into `main`, so a beta
push alone does not imply remote CI execution.
