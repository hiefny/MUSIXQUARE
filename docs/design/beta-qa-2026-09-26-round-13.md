# Beta QA — 2026-09-26, round 13

Baseline: `mxqr_beta` at `1b1a3f40`. Scope: queue removal and replacement during
file preparation, remote mutation acknowledgements, queue capacity, and late
native/bounded playback work. Work remains on beta without advancing main,
deploying production, or changing app/cache versions.

## Confirmed findings

### 1. An unrelated PRO queue edit could cancel the next track's preparation

The server may still have A as its committed selection while a valid PREPARE for
B owns the participant's current download and local selection. Removing an
unrelated C publishes a new playlist snapshot whose canonical selection remains
A. The runtime projected that selection directly into the local player, changing
B back to A. The download ownership subscriber consequently aborted B's stream
and preparation reported failed.

The server's queue mutation path does not cancel the pending transition when
both the committed and pending rows survive. This is therefore not a deliberate
server cancellation. A regression drives the actual PRO runtime, queue mutation,
playlist manager, preparation endpoint, and partially received ReadableStream.
On the baseline, C removal aborts the stream, rewrites the local selection, and
sends failed readiness for the still-valid B transition.

The playback controller now resolves the local selection for queue projection.
It preserves only its exact active server PREPARE target, already selected by the
local endpoint, in the same room/epoch and while the snapshot still describes
the transition's base playback revision. The target must survive with an
unchanged canonical source. The manager's previous accepted snapshot remains
available during projection, allowing comparison before accepting the new one.
The canonical snapshot and server selection are never rewritten.

The runtime uses that resolved selection for both the legacy queue projection
and deselection teardown. Actual target deletion, source replacement, cancellation,
or a newer canonical playback checkpoint continues to invalidate old work.

### 2. Snapshot recovery confused different playback targets at the same revision

While canonical A remains at playback revision 1, a PREPARE for B reserves target
revision 2. A direct pause of canonical A can cancel B and commit A paused at
revision 2 instead. A heartbeat may deliver that checkpoint before the socket's
CANCEL and COMMIT frames, without requiring permanent packet loss.

Snapshot restoration previously reused the active PREPARE's transition ID based
only on equal revision numbers. It consequently attributed A's paused checkpoint
to B's preparation and waited for the unrelated B stream instead of retiring it.
This was exposed by the higher-checkpoint control for the first finding, with
the real download body still pending.

Restoration now requires equal epoch, revision, queue ID, state, position, and
YouTube video/sub-index before reusing a prepared transition. Commit timestamp
is deliberately excluded: the server changes it when publishing a valid
prepared checkpoint. A different target uses ordinary snapshot recovery, which
cancels the obsolete preparation before entering the serialized commit queue.

The five PRO integration cases cover unrelated removal, reorder from idle,
actual target removal, stale snapshots followed by the same-revision direct
pause, and canonical source replacement. The first case also confirms that a
matching B checkpoint with an updated commit timestamp starts playback without
an additional download or decode. All five pass after both fixes.

### 3. A blocked operator deletion was acknowledged as applied

Standard hosts protect the current YouTube occurrence while their manual-offset
seek verifier is pending. A remote administrator can request deletion during
that interval. The removal function correctly left the queue untouched, but its
protocol handler unconditionally returned a successful terminal acknowledgement.
No authoritative refresh accompanied that false success.

The handler now shares the same current-removal predicate with the existing
local guard. A blocked request receives the current snapshot and the existing
`rejected/conflict` result. This preserves the seek-time deletion policy rather
than adding deferred deletion, new timers, or automatic retries. The request
ledger retains that first terminal result; a new request after the verifier
settles can succeed normally.

Five regressions/controls use the real host handshake, permission handlers,
protocol request ledger, and iframe position verifier. They cover current and
batch removal, duplicate result replay, a fresh request after settlement,
non-current removal during the wait, and prior permission/connection invalidation.
The final baseline expectations failed for both blocked deletion cases because
the actual result was `applied`. An earlier exploratory test expected deferred
execution; that expectation was discarded in favor of preserving the existing
immediate rejection policy.

### 4. Host file selection over queue capacity failed without an explanation

The shared standard-host file append path lacked the capacity check already used
for YouTube additions and operator uploads. Selecting files that exceeded the
existing 1,000-row limit made the atomic queue commit throw. The EventBus logged
the error, but the user received no explanation and none of the files appeared.

The append path now checks the number of accepted audio files against the live
queue before allocating IDs or mutating state, and displays the existing
translated queue-full message. The limit and all-or-none behavior are unchanged.
Four tests cover a full queue, a batch exceeding its remaining space, filling
the queue exactly with unsupported files filtered out, and adding after removal.
The first two fail on the baseline; all four pass after the correction.

## Other investigation

Native/bounded source retirement, queued read completion, canonical end timers,
file-to-YouTube/system-audio/demo transitions, and current-row removal teardown
produced no additional finding. Five focused suites passed **285 tests**.
The real leave path performs session reset/navigation; hypothetical survivors
created only by suppressing that navigation were not counted as defects.

Delayed operator upload completion and duplicate acknowledgements do not revive
removed queue IDs: completed uploads publish a fresh occurrence and settled
replays only resend their result. Clearing already-published queue rows does not
claim to cancel separately pending uploads, so that behavior was not changed.

## Verification

- Independent source review confirmed the four reachable findings and found no
  further issue in their fixes.
- Focused queue/UI/capacity suites: **113 passed**; operator permission/mutation
  suites: **210 passed**; PRO projection/playback suites: **194 passed**.
- Standard-room Chromium checks: **15 passed**, covering MP3 next/previous with
  preload, queue changes, and operator permission/control. These completed before
  the final PRO-only checkpoint comparison adjustment; the PRO focused tests and
  full unit suite cover that final adjustment.
- Seven source guards passed: import graph, dead exports, bus pairing, lifecycle
  writes, complexity, room authority, and chunk pump.
- Production build and all eight checked artifact guards passed: production
  hooks/security, legacy TV, service worker, UI kit, initial transfer budget,
  fonts, and app shell.
- Final full unit suite: **474 files passed; 9,769 tests passed, 1 skipped**.
  The existing deployment-artifact classifier test skips locally because `jq`
  is unavailable; it cannot skip on CI. All 14 new regression/control cases ran.
- Full repository typecheck and app/tooling lint passed. Changed TypeScript
  formatting and `git diff --check` passed.

App version remains **8.6.61**, service-worker cache epoch **v630**. No production
deployment or main advancement is part of this QA.

## Limits

The PRO regression controls API responses and stream delivery at actual async
boundaries. It does not use production Cloudflare or measure network speed.
The operator regression controls iframe position while running the real verifier;
it does not establish remote YouTube iframe timing. Browser checks use local
Chromium/RTC and fixture media. No physical iPhone or acoustic measurement is
claimed. Beta pushes do not trigger main-only CI or production deployment.
