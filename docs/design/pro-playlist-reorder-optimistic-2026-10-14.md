# PRO playlist reorder feedback — 2026-10-14

## Scope and evidence

The owner reported that dragging a track to a new position in a PRO room made the
local list show the new order, then the old order, then the new order again.

PRO queue mutations are owned by the server.

- **Old behavior.** `reorderTrack` sent the reorder to the playlist manager and
  left `playlist.items` unchanged until the accepted snapshot arrived.
- **Flicker.** After the drop, the playlist view redrew the old order from state,
  then jumped to the new order when the response projected.
- **Standard host.** It commits its own reorder at once, so it does not flicker.
- **Standard guests.** A guest with queue permission only sends a request to the
  host and may show the same delay. That path was not changed or measured here.

## Change

Participant-local; no Worker, protocol or schema change.

- **Immediate local order.** The dropped order is applied to `playlist.items` at
  once, keeping the canonical room revision.
  - The PRO projection redraws only when the canonical playlist signature
    changes, so same-revision heartbeats keep the dropped order while the request
    is in flight.
  - The accepted snapshot then projects the same order, with no visible change.
- **Rejected reorder.** The rows are restored to the server's latest order, not
  the pre-drag one, because another participant may have changed the queue
  meanwhile.
  - The restore touches only order. When the canonical item set differs, the
    projection of that newer snapshot owns the rows.
  - A toast says "Couldn't move the track" (Korean: "트랙 위치를 바꾸지 못했어요").
    The new `playlist.reorder_failed` key is translated for all 42 locales, using
    each locale's existing term for a queue row and its usual failure phrasing.
- **Shuffle.** While shuffle is on, the shuffle order is reconciled after both
  the local order and a restore.

Known limit: if another participant changes the queue while this reorder is in
flight, the projection of their change can briefly show the list without this
move until the rebased reorder is accepted.

## Verification

Environment: Windows 11 Pro local worktree, Node 24.13.1 (the repository pins
24.20.0, which pull request CI uses), Vitest 5.0.3, Playwright 1.63.0 with
Chromium. jq was supplied through `MXQR_TEST_JQ_PATH`.

Tested source: **`88319d12531b7fd0138a9f14e43d97717536eca3`** (8.10.20, cache
epoch v686), branch `agent/pro-reorder-optimistic`, clean tree before and after
the unit run. Its parent `1d2772ec` carries the same application code (only one
unit test file differs) and was used for the browser runs. Later branch commits
merge documentation from `main` and add documentation only. These are local and
branch results, not the exact-main release candidate.

| Check | Source | Result |
| --- | --- | --- |
| Full `vitest run` | `88319d12` | 563 files, **12,723 passed / 0 failed / 0 skipped**, 156.30 s |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | `88319d12` | Passed, zero lint warnings |
| `npm run test:e2e:critical` | `1d2772ec` | **29 passed / 0 failed / 0 skipped / 0 flaky**, 1.3 min |
| Playlist E2E (`playlist`, `playlist-touch-reorder`, `playlist-progressive-focus`) | `1d2772ec` | **7 passed / 0 failed / 0 skipped / 0 flaky**, 41.2 s |
| `guard:sw-cache-version`, `guard:release-identity` | `88319d12` | Passed (v686 covers the runtime changes) |

New pins:

- A dropped reorder shows its order before the server answers and keeps it
  through the accepted snapshot.
- A rejected reorder restores the server's order and shows the new toast.

Both pins fail on the previous runtime code.

The existing queue-mode overlap pin had used the local row order as its signal
that the server had accepted each reorder. It now waits for the accepted
snapshot to project; the overlap it exercises is unchanged.

Not verified: physical iOS/Android devices, WebKit, the full serial E2E suite,
and production behavior. The local stack cannot open PRO rooms, so the drop was
not exercised against a real room before release.

## Release and recovery

App-only release (`target=app`). Mixed versions are safe because the change is
participant-local. Recovery is the ordinary Production Release rollback to the
8.10.19 checkpoint, which restores the delayed redraw.
