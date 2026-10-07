# Beta QA round 20 — PRO membership response ordering

Date: 2026-09-27 (KST)

Branch: `mxqr_beta`

Baseline: `8a2a20ed4b182580e6234e1f6dc1eaa45f7bffe4`

## Scope and method

This round reviewed audio resource lifetimes, session entry/recovery, file
transfer and clock recovery, and PRO membership/authority reconciliation.
Three independent lanes reviewed existing boundaries and reproduced candidates.
The primary agent made product changes; the other agents added tests and
independently reviewed the implementation. Earlier QA fixes were preserved.

Two related PRO defects were verified. The reproductions retain the actual API
client and runtime, delaying native streamed HTTP response bodies to control
the order in which server results become visible. No production requests or
server mutations were required.

## Verified defects and fixes

### 1. Unversioned administrator replies could overwrite newer state

Administrator PUT/DELETE replies contain a directory without a snapshot
revision. The runtime published that directory immediately, then requested a
heartbeat. When a newer heartbeat arrived before the mutation reply finished,
the late directory temporarily restored old permissions or removed a freshly
re-granted administrator. The follow-up heartbeat could heal the display, but
could not prevent the incorrect intermediate state.

The opposite response order was also reproduced: a fast grant reply followed by
an older in-flight heartbeat and then the forced fresh heartbeat published
administrator counts `2 -> 1 -> 2`.

Mutation replies now acknowledge success without publishing their unversioned
directory. The existing forced follow-up heartbeat publishes the versioned
directory and participant list together. The mutation still resolves while the
follow-up is pending, and a failed follow-up read does not turn a committed
write into an error. Existing UI callers ignore the returned directory array
and render canonical update events. No dialog design or authority policy changed.

### 2. Successful kicks could report failure or be visually undone by an old read

Both member-wide and single-presence kicks return full snapshots. If a newer
heartbeat installed a snapshot while a successful kick response body was still
arriving, strict read acceptance rejected the older success response with
`PRO_ROOM_PLAYLIST_SNAPSHOT_STALE`. The server operation had already succeeded.

The playlist manager now exposes a narrow committed-response acceptance path:
a validated, older snapshot from the same room returns the already-installed
newer snapshot. Ordinary snapshot reads remain strict. Malformed snapshots,
different-room responses, and equal-revision conflicts still fail.

Controller and playlist-manager acceptance run in separate lanes. A shared
session-scoped monotonic membership publisher also prevents a delayed older
heartbeat from visually resurrecting a kicked participant after a fast kick.
It publishes the manager's accepted snapshot, not the original response.
Publication checks both playlist and controller session ownership after the
await; the publication history resets on session retirement, not account changes.

Seventeen new runtime/manager cases cover both kick endpoints, both response
orders, administrator grant/revoke, healthy operations, delayed/failed refresh,
strict invalid/conflict rejection, and recovery after a rejected snapshot.
Five failing pre-fix cases were captured. The inverse-kick tests were added
after the source fix; they are regression controls, not captured pre-fix runs.
Existing cross-session rejection cases remain in the full runtime suite.

## Other reviewed areas

- Audio graph/effect ownership, bounded/native engine handoff, retired decoders,
  worker cleanup, and foreground context recovery: **483 tests in 23 files**
  passed; no additional verified defect.
- Standard/PRO entry, QR camera lifetime, activation, host/guest reconnect,
  presence/session replacement, wake locks and reset: **326 tests in 20 files**
  passed; no additional verified defect.
- Current-file/preload ordering, resume, storage recovery, remote download,
  memory ownership, shared clock and bootstrap catch-up: **302 tests in 16
  files** passed; no additional verified defect.
- Initial PRO authority/playback review: **215 tests in six files** passed.
  The final changed runtime file passes **121 tests**, and the playlist manager
  file passes **41 tests**. Independent compatibility review passed **121 tests
  in six files** before the last four manager cases were added.

Focused counts overlap; they are not additional unique test totals. Logs are
retained locally under ignored `scratch/qa-beta-round20-2026-09-27/`.

## Final verification

- Full unit run: **482 files passed; 9,868 tests passed, one skipped**.
  The existing deployment-artifact classifier case skips locally without `jq`;
  no new test is skipped. The run used four parallel workers and retained all
  existing assertions and timeouts.
- Full repository typecheck, app/tooling lint, changed-file formatting, and
  diff checks passed. Two new test fixture typing errors found by the first
  typecheck were corrected before the final typecheck and full unit run.
- Seven source guards passed: import graph, dead exports, bus pairing,
  lifecycle writes, source complexity, room authority, and chunk pump.
- A local production build and eight artifact guards passed: production hooks,
  security, legacy TV, service worker, UI kit, initial transfer budget, fonts,
  and app shell. The shell check verified 90 assets. The build was not deployed.
- `main` and `origin/main` still point to
  `35759e8b07f1ee0b272afbd0af03c770a858889e`; the Operations Drift Audit workflow
  remains `disabled_manually`.

## Limits and publication

These tests exercise controlled completion/failure boundaries and actual
reconciliation code. They do not measure physical audio synchronization, real
Cloudflare latency, iPhone behavior, or network handovers. The result is not a
claim that all possible session interleavings are defect-free.

This work is beta-only. UI design, room policy, app **8.6.61**, and cache **v630**
remain unchanged. Commit and push target `mxqr_beta`; no pull request, main
advancement, production deployment, or Operations Drift Audit re-enablement.
