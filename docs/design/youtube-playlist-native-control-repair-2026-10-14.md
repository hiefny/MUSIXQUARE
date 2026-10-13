# YouTube playlist and native administrator control repair — 2026-10-14

## Scope and provenance

The owner authorized implementation and production deployment after the
[read-only investigation](youtube-playlist-native-control-audit-2026-10-14.md).
The implementation starts from `1964828e34587214ec3f98bee7a2cf4392a36768`.
Initial reviewed implementation: `ef1cfef729f6109bb619cbb4380e94f7ee6ba4d8`.
The first-focus follow-up and its final source identity are recorded below.
Final release evidence is recorded below when available. App **8.10.10**, service-worker cache **v673**; deployment scope
is **App**, with Developer API D1 application **false**.

No dependency, schema, binding, secret, wire protocol or room admission change.
No new maintenance, announcement or force-update policy. Existing clients need
the normal application refresh to receive the repair. Unselected Workers retain
their current production versions.

## Confirmed defects and repairs

### PRO reentry loses the persisted playlist manifest

The server already supplies complete `youtubeVideoIds`. The local runtime used
a Standard-room wire clone that discarded that field. Preview state could mask
the loss during initial addition; cache-empty reentry then could not find the
queue-occurrence manifest. This is not a server persistence migration.

`applyPlaylistProjection` retains the local manifest in the same atomic update
as queue items, selection and revision. It clones caller-owned arrays and keeps
the existing revision/conflict checks. Standard wire serialization and parsing
continue to omit local-only fields. Duplicate occurrences of the same external
playlist retain their own immutable manifests.

The actual runtime reentry and snapshot integration tests failed before this
repair and pass after it. Tests cover empty preview cache, leave/reentry,
duplicate occurrences, reordering, stale snapshots and cache eviction.

### Standard lists stop at the iframe's 200-item window

The old application limit of 200 was already removed; the current manifest
validation limit remains 5,000. The investigation observed 200 entries from the
actual iframe and 248 from the existing public complete-manifest endpoint for
the reported list. The page's displayed 257 was not reconciled video by video;
this repair does not assert every displayed video is accessible or playable.

Host input, chat and delegated administrator additions use the complete
manifest endpoint when no verified preview is available. A stable iframe count
is no longer evidence of completeness. Existing unverified caches are repaired
before selection/navigation; failure retains the previous playback and does not
silently treat a partial list as its end. Room, queue and operation lifetime
checks prevent late responses from changing another selection or departed room.
Complete manifests are protected from later partial iframe snapshots.

Administrator addition acknowledgement and completion remain separate. The
completion budget must include manifest resolution, including single-video
requests queued behind a playlist addition; unrelated mutations keep their
existing budgets.

### Delegated administrator iframe controls

Native play/pause already had a route to the host, but a canonical pause cleared
autoplay intent and the raw PLAYING guard paused a Standard administrator back
before that route could run. The exemption now requires current playback
authority, player and occurrence identity and an unowned native callback.

Application `seekTo` calls also own their resulting callbacks. A tiny seek is
still an application command; the output compensation tolerance is unrelated to
callback ownership. Instrumentation failure disables native promotion rather
than interpreting unknown output as a room command. Incomplete buffering seeks
retain bounded ownership, while completion preserves the origin of its own
callback before releasing it. Delayed matching BUFFERING can reconnect an
operation within its original deadline, without renewing it indefinitely.

Direct Standard administrator seeks are inferred only while the visible provider
iframe has focus, across nearby samples of the same video, occurrence, session,
connection and control revision. A confirmed position discontinuity sends the
existing `REQUEST_SEEK`; the host still checks authority and queue identity and
performs canonical synchronization. Manual and Android local output compensation
are removed from the requested room position. Known ads, hidden state, large
sampling gaps and application-owned transitions reset the observation.

There is no cross-origin YouTube key/seek event. A provider that changes media
time without changing its reported video/duration can be indistinguishable from
a native seek. Similarly, arbitrarily late isolated PAUSED output cannot be
proven distinct from a new user pause. The bounded heuristic does not claim to
solve every provider callback history. The user's original natural loop has no
captured trace, so its exact cause remains unconfirmed. Deterministic callback
tests prove the repaired mechanisms, not that the real incident used that trace.

## Validation

Local environment: Windows, Node 24.13.1 / npm 11.8.0, Chromium Playwright and
Vitest. Test doubles control provider timing; host/guest browser tests use actual
local signaling and application transport. No customer room is modified.

- PRO focused integration/model suites: 156 pass, 0 fail, 0 skip. Two new runtime
  cases were demonstrated RED → GREEN on the actual runtime callbacks.
- Independent native-control review: 26 synthetic callback cases pass, including
  the three initial failures (readonly `seekTo`, feedback after 1,001 ms, 20 ms
  app seek), direct pause after completion and stale operation lifetime fences.
- First browser pass: 10 pass / 1 fail. Both complete-list paths crossed item
  200 → 201. The native administrator pause failure was caused by the shared
  fake provider lacking the real API's required `cuePlaylist` method, which made
  instrumentation fail closed. Implementing that API in the fixture, with the
  same product dist, made all 11 cases pass (0 fail / 0 skip).
- The first in-progress full unit run had 12,604 pass / 28 fail. It overlapped
  active test/implementation edits and retained old native-indexing assumptions.
  The final source uses complete-manifest fixtures while preserving the real
  low-level indexing error tests, cancellation, replay and ownership assertions.
  The independent review also caught asynchronous Next/Prev consumption: the
  outer queue reads its handled callback synchronously. It is now claimed before
  acquisition and re-entered once at the verified complete-list boundary, with
  a 200 → 201 and both outer-boundary regression pins.
- That first run also caught an omitted `index.html` bootstrap cache mirror,
  corrected to v672, and three unchanged Git-heavy release-tooling timeout
  cases during concurrent checks. Their sequential recheck passed all 177 tests
  in three files without changing timeouts. The final full run limits local
  workers to four; no test is omitted and no timeout budget is relaxed.
- Full unit: **560 files / 12,635 pass / 0 fail / 0 skip**, 439.05 s,
  `npm test -- --maxWorkers=4` on preliminary commit `08962c03`. The single
  subsequent compatibility expression change is described below; exact-main CI
  validates the final source with the repository-pinned toolchain.
- Full typecheck, lint, format; Worker syntax, API/D1/operations policy; import
  graph (0 cycles), event pairing, dead exports, source complexity, Standard hot
  path, room authority, chunk pump and lifecycle guards all pass. No baseline
  was increased. Dead-export counts remain 20 test-only / 78 self-only.
- Production build and initial-transfer guard pass: eager JavaScript 456.9 KiB
  gzip, eager total 530.6 KiB gzip; the mandatory 5% headroom is preserved.
- Focused Chromium: **73 pass / 0 fail / 0 skip**, 14.1 min, on the
  preliminary commit `08962c03`. Includes all 24 critical release paths and the affected
  YouTube input/chat, native controls, end transitions, manual/zero start, delayed
  output, pending seeks, setup activation and host/guest sync scenarios.
- The first committed-HEAD checked build correctly rejected a newly used
  `Array.at(-1)` for the Chromium 79 floor. It was replaced with equivalent
  `array[array.length - 1]` access (including the empty-array case), with no
  polyfill or target/guard relaxation. The amended final implementation is
  `ef1cfef7`; five native-control suites then passed **39 tests / 0 fail / 0 skip**.
  The pre-compatibility hash is a local pre-amend test snapshot, not a published
  release candidate. Committed-HEAD `npm run build:checked` on the final source: **pass**, including
  legacy TV, v672 history coverage, app-shell, production security and bundle gates.

Physical YouTube keyboard/media-key behavior, ads, mobile WebViews, audible
alignment and every video in the user's playlist are not covered by synthetic
provider tests. Full 640-case E2E is not claimed; exact-main CI remains the
production release gate, independently of local and PR results.

### First-focus review follow-up

PR #323's automated review found a valid P2: clearing every position sample
outside iframe focus loses the baseline when the user's first click both enters
the player and seeks. A new unit test reproduced the incorrect pause/play
requests before the fix. The observer now retains a recent, same-occurrence
baseline while the document is foreground, requiring the exact iframe's focus
only when promoting a discontinuity to a host seek request. Actual window focus
loss still resets the baseline, including a blur/return between polling ticks.
The parent-window blur produced by entering a child iframe does not reset it
while `document.hasFocus()` remains true.

Independent Chromium and WebKit focus probes confirmed that distinction. Five
native-control suites pass **56 tests / 0 fail / 0 skip**; pins include first
focus plus seek, an unfocused jump followed by later focus, and background-window
reset. The browser regression removes its former focused warm-up and uses one
actual iframe click to produce focus and the provider discontinuity together.
An attempted browser RED run used a production build without the test bus and
failed in setup; it is not counted as regression evidence. The unit RED is valid.
The follow-up is commit `44f73b6f`, which advances the covering cache epoch to
v673; no published commit is amended. Its two-tab Chromium regression passes
**2 tests / 0 fail / 0 skip** in 50.3 s, including first-click focus plus seek,
exactly one host seek and both participants returning to playing. Final
committed build and full-unit results are recorded below.

## Release and recovery

Pending: reviewed PR, successful exact-main CI candidate, immutable App artifact,
Production Release workflow, live smokes and final deployment ownership.
Do not interpret this preparation as a deployed repair.

The normal workflow captures the compatible previous App deployment before
mutation. No data down-migration is needed; restoring that checkpoint restores
the known playlist/native-control defects. Preserve existing permanent recovery
floors and record any failed release or rollback separately in release history.
