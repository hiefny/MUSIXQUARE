# Beta QA — 2026-09-26, round 14

Baseline: `mxqr_beta` at `a0ca76ad`. Scope: late work during room recovery,
source switches, system-audio receiving, and participant-local playback recovery.
This work preserves the competition freeze, app/cache versions, and existing
room-control policy.

## Confirmed finding

### A hardware PAUSE could be lost while a guest waited for host time

A standard-room guest can pause its own file playback using lock-screen or
hardware media controls. A later PLAY clears the local-pause flag and requests
the host's current timeline. Until the reply arrives, the physical output and
semantic activity remain paused.

If the user pressed PAUSE again in that interval, the Media Session handler
invalidated its local request callback but updated the file pause flag only when
activity was already playing. Standard file rejoin had already emitted the
network request synchronously; its eventual SYNC_PONG does not carry that callback.
The cleared pause flag therefore let the normal bootstrap resume playback despite
the newer PAUSE.

The regression runs real Media Session handlers, local-output rejoin, PAUSE,
clock sampling, and protocol/SYNC_PONG handling for an admitted guest connection.
Only the final physical Web Audio PLAY boundary is observed with a mock. No
already-resolved production Promise is artificially held open: the asynchronous
boundary is the actual host message arriving after the second hardware action.
Before the fix, the no-cancellation control passed and the cancellation case
failed, with the old reply reaching PLAY. Afterward both pass, including another
explicit PLAY succeeding after cancellation.

The handler now records participant-local file PAUSE independently of current
activity, then calls the existing transport pause function to revoke queued
starts. That function already returns without changing a paused/pending pipeline
after revoking its pending play intent. Demo handling, system-audio exclusion,
and host/administrator room-control behavior are unchanged.

The same handler also restores the flag for a PRO member. A controlled pending
PRO-runtime test confirms flag preservation, request cancellation, no late retry,
and successful later PLAY. This is not counted as a second auto-resume defect:
PRO already passes the local request's liveness callback into reconciliation,
which protects that particular in-flight commit.

## Other investigation

- Standard guest admission/retry/bootstrap, connection replacement, ICE route
  detection, YouTube API/player readiness, terminal loss, and foreground recovery:
  **281 focused tests passed**. No additional confirmed defect.
- PRO session replacement, heartbeat and ticket response ordering, socket
  generation/sequence, account renewal and re-entry: **111 focused tests passed**.
  Real abort/deadline and ownership checks covered the examined stale responses.
- Standard and PRO system-audio receivers, delayed unmute/START/audio setup,
  SFU API/SDP completion, stream replacement, stop, and source switching:
  **213 focused tests passed**. Subscription/session/connection/publication
  identity checks retire old work before graph attachment.

Arbitrary repeated stream injection and ignored-abort API mocks were not counted
as defects where the production adapter could not produce those sequences.

## Verification

- Native playback/recovery focused suites: **238 tests passed** across five files.
- Independent review confirmed the cause and narrow source correction.
- Local Chromium: **7 passed**, covering native demo controls, demo late join and
  superseded decode/downloads, background output recovery, and system-audio
  controls/source switching. An initial preview launch on alternate port 4524
  failed with Windows `EACCES` before tests ran; the existing standard port 4183
  worked without application changes.
- Full repository typecheck and app/tooling lint passed. Changed TypeScript
  formatting and `git diff --check` passed.
- Seven source guards passed: import graph, dead exports, bus pairing, lifecycle
  writes, complexity, room authority, and chunk pump.
- Production build and eight artifact guards passed: production hooks/security,
  legacy TV, service worker, UI kit, initial transfer budget, fonts, and app shell.
- Full unit suite: **475 files passed; 9,772 tests passed, 1 skipped**. The existing
  deployment-artifact classifier test skips locally because `jq` is unavailable;
  it cannot skip on CI. All three new regression/control cases ran.

## Limits

The new regression validates application decisions and native action handlers,
not an actual iPhone lock screen or measured acoustic output. System-audio and
PRO API/socket timing checks use controlled unit fixtures, not live Cloudflare
traffic. Browser checks use local Chromium, RTC, and fixture audio.

Work stays on `mxqr_beta`; app **8.6.61** and cache epoch **v630** remain unchanged.
No production deployment, main advancement, pull request, or re-enabling of
Operations Drift Audit is part of this QA.
