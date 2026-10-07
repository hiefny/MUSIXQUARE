# Beta QA — 2026-09-26, round 5

Baseline: `mxqr_beta` at `88168c86`. Scope: queue removal/reordering,
duplicate YouTube occurrences, delayed file delivery, room/connection ownership,
PRO authority changes, and background recovery. This is beta-only work without
a production release or app/cache version change.

## Confirmed finding

Deleting the current YouTube entry could leave a guest stopped when the next
entry referred to the same video. The application permits adding the same URL
more than once; each addition has its own queue identity.

Removal selected the successor before calling `playTrack`. That made the
same-item replay optimization see the successor as already selected. If its
video matched the resident iframe, the optimization skipped the new occurrence
handoff and `YOUTUBE_PLAY` message. Updating the guest's playlist alone did not
start the successor player.

Removal now requests the existing `forceNewYouTubeOccurrence` behavior, and
the replay optimization honors it. Ordinary same-item replay retains its fast
path. File playback and server-authorized PRO removal retain their existing
paths; no UI, synchronization algorithm, or retry policy changes are involved.

A unit regression failed before the fix because the successor playback message
was absent. A browser regression independently reproduced the failure using two
contexts, local PeerJS, a controlled YouTube player, and the real chat-link
addition and playlist removal paths. It checks actual guest playback, not just
the selected queue row.

## Rejected and unconfirmed candidates

- A preload completion test forcibly replaced its host/room ownership during
  an asynchronous RAM read while reusing the queue ID and transfer SID. The
  injected test exposed a missing ownership fence, and reused transfer IDs are
  possible during reconnection. However, the current read only yields one
  microtask, and review found no concrete production scheduling path that puts
  the replacement inside that gap. This is not counted as a reproduced runtime
  defect. The proposed production guard and its three injected regressions
  were excluded from this change; an investigative patch remains in ignored
  local scratch files.
- PRO command/prepare cancellation, queue target recovery, capability changes,
  and responses arriving after room replacement yielded no additional confirmed
  issue. Five focused suites passed 215 cases. Server-authorized preparation
  surviving a local capability change is intentional behavior.
- Remote upload replacement/removal, transfer retries/cache ownership, and
  current-file completion yielded no additional confirmed issue.
- Background recovery was reviewed for stale session work. File output has
  identity protection. A possible stale recovery notification across session
  replacement was not reproduced and was not changed. Five focused audio and
  background suites passed 137 cases.

## Verification

- The queue unit regression failed before correction and the focused queue,
  YouTube, and PRO selection passed 412 cases across 12 suites after correction.
  Independent review found no additional issue in the change.
- Before correction, the two-browser regression observed the successor's queue
  metadata but an `IDLE` guest projection, no new `playVideo` command, and a
  destroyed player. The same test passed after rebuilding the corrected source.
- Final rebuilt Chromium selection: **26 passed**, covering YouTube sync,
  current-item removal, local file transfers, preload/previous-track handling,
  playlist reordering, and reconnection. The baseline queue/join/permission
  chaos selection passed another **15 distinct cases**, for 41 successful
  browser cases in this round.
- Full repository typecheck and lint passed, followed by another E2E typecheck,
  changed-browser-test lint, and changed-code formatting checks after the new
  browser regression was finalized. Import graph, dead exports, bus pairing,
  lifecycle writes, source complexity, and room-authority boundary guards
  passed without weakening their baselines.
- Final frozen-source unit suite: **464 files, 9,674 passed, 1 skipped**.
  The existing release-deployment-state case needs `jq`, unavailable in this
  Windows environment; its CI path does not permit that skip.
- Local production-mode build and all eight artifact guards passed: test-hook
  exclusion, security configuration, legacy TV syntax, service worker, UI kit,
  transfer budget, fonts, and app-shell completeness. App `8.6.61` and cache
  `v630` remain unchanged. Production was not deployed.

## Limits

Browser checks use local Chromium and local signaling. YouTube playback uses
a controlled iframe fixture, not the live YouTube service. These checks do not
establish physical-device audio alignment, iPhone Safari/PWA behavior, or every
possible network ordering. Beta pushes alone do not trigger the `main` CI
workflow and do not deploy production.
