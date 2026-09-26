# Beta QA — 2026-09-26, round 16

Baseline: `mxqr_beta` at `95869a73`. Scope: queue edits, repeat/shuffle,
asynchronous track preparation, and authority changes at their boundaries.
Competition freeze, UI design, room-control policy, and app/cache versions stay
unchanged.

## Confirmed findings

### 1. A pending native YouTube playlist could contaminate its successor

The retained iframe's `cuePlaylist` command is asynchronous. After the current
queue row is removed and its successor starts indexing, `getPlaylist()` can
still expose the preceding playlist. Fast Next used those old IDs to extend
the new row's partial sub-item map. Expanding a playlist-only successor could
similarly fill its empty map with the previous playlist's IDs.

The regressions enter the real playlist/player handlers, start A's native
indexing, remove A through the queue handler, and issue B's cue command. The
fake iframe models its asynchronous command/cache boundary; application
promises are not artificially suspended. Both wrong-map cases failed before
the fix. This is a demonstrated client-state failure under the delayed iframe
response model, not a measurement against the live YouTube service.

All three opportunistic native playlist reads now require indexing and loading
to have settled. Navigation using an already known sub-item map remains
available. Five tests cover the two failures, B's completed indexing followed
by Next, valid navigation after unrelated reorder, and the existing settled
native fallback that fills a truncated map. The fix does not claim native
playlist identity validation beyond this pending handoff window.

### 2. PRO queue-mode writes could outlive the authority that created them

A pending repeat/shuffle checkpoint had a room lease but no ownership tied to
the controller's current queue permission. Revoking and then restoring that
permission during a pending HTTP response could revive the old edit without
a new gesture. An old failure could also replace a newer gesture's normal
debounce timer with its own retry timer.

The regression uses real `ProRoomApiClient` request/body parsing and real
runtime heartbeat projection. A streamed response body remains pending while
authority changes; cancellation is honored. Before the fix, the denied old
request was retried after regrant and changed canonical repeat mode. Revocation
before the initial debounce also failed to retire the edit. A normal transient
503 retry with unchanged authority passed as a control.

Checkpoint generations now retire queued work, pending reads/writes, retries,
and their completions when permission disappears. The accepted matching queue
state is restored locally where available. Permission denials are terminal for
that intent; the existing finite transient retry delays remain unchanged.
An older request cannot clear or replace a newer edit's timer.

Independent review found two remaining GET-merge cases in the first fix, both
then reproduced: after a playlist revision change, a canceled repeat edit could
piggyback on a fresh shuffle gesture; alternatively a fresh repeat gesture that
chose the same value as an old one could be overwritten by the delayed GET.
Per-field intent revisions now distinguish those cases, clear canceled field
ownership, and preserve genuinely newer edits. Ordinary viewers can still
receive canonical queue-mode updates. These are client intent-lifetime defects;
the tests do not demonstrate a server authorization bypass.

Further verification reproduced the same stale-field replay without a heartbeat
revocation: a denied repeat PUT followed by a fresh shuffle could publish both
fields again. Denials now retire only fields owned by the rejected request,
preserving later edits and their timer. A control retains a newer repeat gesture.
Two real queue appends while a streamed canonical GET was pending exposed the
last variant: the writer ignored a rejected stale GET and combined old local
fields with the newest playlist revision. It now requires successful canonical
reconciliation before PUT, using the existing bounded retry mechanism if another
append invalidates the read. The regression verifies current playlist revision,
base revision, and the exact shuffle permutation before accepting any fixture PUT.

Ten regression/control cases cover delayed denial, pre-request revocation,
healthy transient retry, a fresh post-regrant debounce, queued GET with and
without a fresh shuffle, an equal-valued fresh repeat during a pending GET,
terminal-denial field ownership, and a second append during the required read.

## Other investigation

- Queue UI rendering, current-row following, removal, and reordering: five
  existing suites and 129 tests passed. No further defect was confirmed in the
  examined UI paths.
- Local-file decode/preload, queue removal/reorder, and late-join ownership:
  seven existing suites and 257 tests passed. Reviewed file/load generation,
  queue occurrence, exact connection, and preload promotion fences. No new
  actionable issue was confirmed in these paths.
- YouTube repeat-one completion, source changes, sub-playlist navigation,
  rendezvous generation, and retained iframe ownership: five existing suites
  and 370 tests passed after the fix, plus the five new cases.
- PRO queue-mode runtime/projection/manager coverage: four suites and 160 tests
  passed after the final fix, including the ten new cases. A second reviewer
  checked cancellation, ordinary viewer refresh, field merge, and retry behavior.

## Verification

- The first full unit run passed 9,794 tests but failed the existing search
  scrollbar frame-coalescing test (one existing test skipped). Running just its
  fake-timer predecessor and that test reproduced the failure deterministically.
  The predecessor's cleanup scheduled a fake RAF, then restoring real timers
  discarded the callback while the module's pending flag remained set. The
  round-15 native-frame drain could not execute an already discarded callback.
  The search test fixture now owns RAF callbacks across fake-clock changes and
  executes cleanup frames before restoring timers. Its one-frame/one-reveal
  assertion is unchanged. The reproducing pair and all 61 search cases passed;
  no search product code changed. A subsequent full run passed 9,797 tests
  before the final stale-GET case and its guard were added.
- Final full unit run: **479 files passed; 9,798 tests passed, 1 skipped**.
  All fifteen new unit cases ran. The existing deployment-artifact classifier
  skips locally without `jq`; its CI path does not allow that skip.
- Local Chromium: **19 checks passed**, covering queue navigation, drag reorder,
  multi-row removal, preload-to-current transfer during a repeat change,
  near-end YouTube rendezvous followed by repeat/seek/file selection, YouTube
  entry/playlist ownership, and returning local-file preloads. These use real
  local host/guest RTC and native fixture-file playback with a controlled
  YouTube backend; they do not contact the production room service.
- Full repository typecheck and app/tooling lint passed. After the final
  checkpoint changes, application/test typecheck and changed-file lint
  passed again. Changed TypeScript formatting and `git diff --check` passed.
- Seven source guards passed: import graph, dead exports, bus pairing, lifecycle
  writes, source complexity, room authority, and chunk pump.
- Production build and eight artifact guards passed: production hooks/security,
  legacy TV, service worker, UI kit, initial transfer budget, fonts, and app shell.

## Limits

PRO checks use controlled HTTP/runtime fixtures rather than a live Cloudflare
room. YouTube regression tests model the iframe's asynchronous API cache;
physical iPhone/Safari behavior and acoustic timing are not claimed. No test
claims exhaustive coverage of every queue or permission interleaving.

Work stays on `mxqr_beta`; app **8.6.61** and cache epoch **v630** stay unchanged.
No main advancement, production deployment, pull request, or Operations Drift
Audit re-enablement is part of this round.
