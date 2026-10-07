# Beta QA — 2026-09-26, round 12

Baseline: `mxqr_beta` at `85c0b3cc`. Scope: native decoding and preparation
supersession, participant departure/reconnection, and deferred operator navigation
during a host's YouTube offset correction. Work remains on beta; no main update,
production deployment, or app/cache version change.

## Confirmed findings

### 1. An obsolete native preparation could block newer PRO playback indefinitely

A server COMMIT can arrive at the rendezvous deadline before native decoding has
finished. The client serializes COMMIT application and waits for that preparation.
When a newer PREPARE superseded it, endpoint cancellation invalidated the old
media owner but could not terminate `decodeAudioData`. The old preparation Promise
therefore kept the COMMIT queue blocked even after the next track had actually
decoded and reported READY.

The regression uses the real playback controller, authority hooks, playlist
endpoint, and native decode path. Only native decoding of A is held. B becomes the
current paused resident and reports READY, proving that its memory admission and
decoding have already completed. On the baseline, COMMIT B cannot apply until A's
obsolete native work finishes. Both late native success and failure reproduce the
problem.

Related investigation confirmed a second entry path: after A becomes canonical,
the server has cleared its pending transition. A subsequent direct stop/idle
COMMIT has no preceding CANCEL. Cancelling only on PREPARE replacement would
therefore leave this path blocked. Regressions cover native preparation originating
from PREPARE, a COMMIT received without PREPARE, and snapshot catch-up.

The shared preparation owner now settles its observation as superseded when
retired. The underlying endpoint Promise remains observed until completion, and
its native decode memory reservation remains held until the actual work ends.
Admission of a newer canonical COMMIT retires obsolete preparations before
joining the serial queue. Matching preparations and newer pending revisions are
preserved. Obsolete transition metadata and clock waits are also retired, so
their completion cannot send stale readiness reports. Actual endpoint COMMITs
remain serialized; this change does not let old output mutations finish after
newer ones.

### 2. Deferred operator navigation could execute after permission or connection changed

In a standard room, track selection and next/previous navigation wait while the
host's YouTube manual-offset verifier settles an iframe seek. The protocol
handlers verified operator authority before entering that wait. The deferred
callback then retained only a host-local navigation action, losing the requesting
connection. Revoking permission, or replacing that peer's connection, did not
prevent the old request from executing afterward.

The regression drives the actual connection handshake, administrator grant/revoke
handlers, protocol handler, and manual-offset verifier. It changes the iframe's
observable playback position to release the wait, rather than artificially
delaying an already-resolved Promise. The baseline executes all three navigation
requests after both revocation and connection replacement: six failing cases.

Each handler now defers its own entry point, preserving the exact requester and
rechecking its live connection, authority, and requested queue item before
performing host-local navigation. Existing source-occurrence and latest-intent
fences remain intact. Eleven controls cover revocation, connection replacement,
normal authorized execution, newest authorized intent, and a later host-local
selection that must survive another participant's revocation.

The initial PREV fixture omitted the YouTube previous-video listener. Final
coverage registers that listener and uses a position below its restart threshold,
so previous-track selection follows the actual production path. Downstream file
decode is mocked only in these selection tests; queue selection and FILE_PREPARE
publication are asserted through production code.

## Other investigation

- Standard receive/decode admission, preload ownership, queue deletion, and
  terminal host loss: six existing suites, **272 passed**, no additional finding.
- Demo loader, recovery, output ownership, and local-file transport deadlines:
  six suites, **130 passed**, no additional finding.
- Operator upload and other control permission boundaries: seven suites,
  **363 passed**, no additional finding beyond the deferred navigation path.
- Baseline Chromium demo/common-start/output-recovery checks: **5 passed**.

## Verification

- Independent read-only review confirmed both reachable production paths, the
  fixes, exact requester/authority checks, and preservation of endpoint COMMIT
  serialization. Native memory reservations remain owned until actual completion.
- PRO controller/authority/device-failure/ordering suites: **212 passed**,
  including five new native preparation regressions. Twelve additional shared
  preparation controls cover exact cancellation, matching/newer/wrong-authority
  preservation, shared observers, late failure, local rendezvous, and recovery.
- Operator navigation/playlist/manual-offset/host suites: **211 passed**, including
  eleven new regression/control cases.
- Repository lint and all seven source guards passed: import graph, dead exports,
  bus pairing, lifecycle writes, source complexity, room authority, and chunk pump.
- Final Chromium selection: **12 passed**, covering operator grant/revoke,
  YouTube play/pause/seek/stop synchronization, and scheduled local-file starts.
- Production build and all eight artifact guards passed: production test-hook
  exclusion, security configuration, legacy TV syntax, service worker, UI kit,
  transfer budget, fonts, and app-shell completeness. App `8.6.61` and cache
  `v630` remain unchanged; the local build did not deploy production.
- Final full unit suite: **471 files, 9,755 passed, 1 skipped**, including all
  28 new regression/control cases. The existing release-deployment-state test
  requires `jq`, unavailable in this Windows environment; CI does not permit
  that skip.
- Final repository typecheck passed. An initial typecheck caught missing fields
  in the new settlement test's teardown fixture; the fixture was corrected
  before the final full run. Targeted lint, formatting, and test typecheck also
  passed on all final regression files.

## Limits

Native decoder completion, iframe state, and clocks are controlled at their real
asynchronous boundaries. This establishes ordering, cancellation, permission,
and resource ownership; it does not benchmark codec speed or acoustic sync.
Browser tests use local RTC and fixture media; YouTube sync tests use a
deterministic player instead of the remote iframe. Physical iPhone behavior and
production network conditions are not established by this round. A beta push
does not trigger the main-only CI workflow or deploy production.
