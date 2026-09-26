# Beta QA — 2026-09-26, round 10

Baseline: `mxqr_beta` at `2d2c75d3`. Scope: standard-room admission while
queue or member authority changes, PRO checkpoint restoration before initial
clock calibration, and background/YouTube recovery ownership. Work remains on
beta; no production deployment, main update, or app/cache version change.

## Confirmed findings

### 1. Queue changes could be lost while a joining guest acknowledged its baseline

The host sends the ordered playlist/repeat/shuffle baseline and waits for the
guest's APPLIED message. During that network round trip the peer remains
`connecting`, so ordinary broadcasts deliberately exclude it. Previously,
APPLIED promoted the peer and started media bootstrap without filling this gap.
A new guest could therefore receive a PLAY for an occurrence missing from its
old queue, retain a deleted item, or retain obsolete repeat/shuffle settings.

The host now remembers the published queue revision and modes. Before admitting
that exact connection, it sends a newer queue snapshot and changed modes only
to that newcomer. Queue updates use the existing monotonic gate; this does not
rebase an established authority or increment the global revision. A failed
catch-up send closes the incomplete join before media publication.

Unit regressions cover removal, mode-only updates, unchanged/duplicate ACK,
send failure, and a superseded connection's ACK. The first two failed on the
baseline. A Chromium test holds the real guest connection's APPLIED and later
outgoing frames in order while the host adds a file, selects it, and changes
repeat through the UI. The already-connected guest follows correctly; the late
guest failed to receive the new queue on the baseline. A second browser case
selects and pauses an existing occurrence without changing the queue revision,
confirming that existing media bootstrap handles this case without weakening
equal-revision conflict checks.

### 2. Authority changes could interrupt a second device's ordered join

A room administrator grant/revoke applies to a member's devices. When one
device was connected and the same member's second device was open but still
waiting to send HELLO, the host sent OPERATOR and resync frames to both. The
joining device still required the ordered queue baseline, so these premature
frames could fail its join.

Authority state still changes immediately. Projection and effect/mode resync
are sent only to connected devices; the existing completion boundary sends the
newcomer's latest authority when ready. Legacy `/op` and `/deop` handling also
uses this guarded resync path instead of repeating its frames independently.
Two regressions reproduce grant and revoke through the actual host member
authority handlers, with one completed device and one pre-HELLO device.

### 3. PRO snapshot restoration could use an uncalibrated device clock

Socket OPEN schedules clock probes but does not wait for their replies. A
persisted checkpoint contains its update timestamp, not the current server
time. If a ready endpoint beat the first clock response, restoration synthesized
a COMMIT using the device's uncorrected clock. Controlled ahead/behind clocks
produced excessive position extrapolation or a future scheduling delay.
The `unchanged` command-response path also discarded the server time already
present in that response.

Running snapshots now use the existing bounded clock-calibration wait before
extrapolation, and validate the room lease and caller again afterward. An
unavailable clock leaves the checkpoint for a later heartbeat rather than
inventing a position. An `unchanged` response retains its provided server time.
Paused/idle snapshots restore their exact position without requiring a clock
round trip. Their synthetic timing anchor remains immediate even when an
asynchronous media preparation crosses the first clock calibration. Independent
review exposed this additional case: a formerly uncalibrated future timestamp
could become a very large scheduling delay as soon as the time source changed.
The regression delays the endpoint's real preparation boundary and delivers a
clock reply before releasing it. Real live COMMIT scheduling is unchanged.

The tests combine the actual network bridge's clock parsing/calibration and
production playback controller with a controlled socket and media endpoint.
They cover skew, delayed clock responses, a newer live COMMIT, and bounded
timeout followed by a successful heartbeat retry. Seven new cases were added;
the bridge and four related suites finished with **153 passed**. This is
participant-local recovery; the tests also check that it does not issue a room
command or READY.

## Other investigation

- YouTube iframe readiness, delayed PLAY/SYNC, connection/player/queue ownership,
  retained callbacks, and seek/end transitions: six existing suites, **451
  passed**. No additional confirmed defect in the inspected paths.
- Background resume coalescing, page lifecycle, AudioContext recovery, and local
  output rejoin: five existing suites, **108 passed**. Existing room, generation,
  media identity, and native-recovery ownership checks covered the inspected
  paths; no additional source change was needed.

## Verification

- Independent source review confirmed the admission ordering, exact connection
  fencing, centralized authority resync, and PRO restore timing boundaries.
  Standard-room focused verification: seven suites, **265 passed**, including
  seven new regressions. No queue conflict rule or permission policy was relaxed.
- Full repository typecheck and lint passed. The final PRO timing refinement
  also passed test typecheck, scoped lint, and formatting after independent review.
- Import graph, dead exports, bus pairing, lifecycle writes, source complexity,
  room authority boundaries, and shared chunk-pump guards passed without changing
  their baselines.
- Final Chromium selection: **21 passed**, covering the two new admission-gap
  cases, ordinary late file/YouTube joins, queue modes, notices/chat boundaries,
  departure/replacement guests, confirmed leave, and foreground audio recovery.
- Local production-mode build and all eight artifact guards passed: test-hook
  exclusion, security configuration, legacy TV syntax, service worker, UI kit,
  transfer budget, fonts, and app-shell completeness. App `8.6.61` and cache
  `v630` remain unchanged. This build verification did not deploy production.
- Final full unit suite: **467 files, 9,720 passed, 1 skipped**, including 14
  new unit regressions/controls. The existing release-deployment-state test
  requires `jq`, unavailable in this Windows environment; CI does not permit
  that skip. An earlier run loaded the intermediate PRO timing implementation
  and failed its paused-clock control; the complete suite was rerun on the
  final frozen source and passed.

## Limits

Browser checks use local Chromium, real local RTC connections, and fixture MP3
files. Only the admission acknowledgement and frames behind it are delayed.
YouTube and PRO checks control external API/socket timing; they do not establish
physical iPhone behavior, production Cloudflare latency, external YouTube
availability, or measured acoustic synchronization accuracy. Beta pushes do not
run the main-only CI workflow or deploy production.
