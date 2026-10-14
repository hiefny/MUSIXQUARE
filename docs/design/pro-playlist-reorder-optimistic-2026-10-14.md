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
- **Rapid drags.** The newest pending drop stays on top. Projecting an earlier
  accepted reorder re-applies the newest dropped order. Only the newest request
  restores or reports a failure, since its full order already carries the
  earlier moves.
- **Revoked authority.** Revoking queue authority aborts an in-flight reorder.
  The rows then return to the server's order without a toast, instead of keeping
  an order the server never accepted.

Known limit: if another participant adds or removes a row while this reorder is
in flight, the projection of their change can briefly show the list without this
move until the rebased reorder is accepted.

## Verification

Environment: Windows 11 Pro local worktree, Node 24.13.1 (the repository pins
24.20.0, which pull request CI uses), Vitest 5.0.3, Playwright 1.63.0 with
Chromium. jq was supplied through `MXQR_TEST_JQ_PATH`.

Tested source: **`b5b15579872b40284f7bf0239d2bf1d9e3ce51b1`** (8.10.20, cache
epoch v686), branch `agent/pro-reorder-optimistic`, clean tree before and after
the run. The review fixes sit between a revert of the version bump and its
re-application, so the cache epoch bump stays the last runtime-covering commit.
Later commits on the branch change documentation only. These are local and
branch results, not the exact-main release candidate.

| Check | Result |
| --- | --- |
| Full `vitest run` | 563 files, **12,725 passed / 0 failed / 0 skipped**, 165.29 s |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Passed, zero lint warnings |
| `npm run test:e2e:critical` | **29 passed / 0 failed / 0 skipped / 0 flaky**, 1.5 min |
| Playlist E2E (`playlist`, `playlist-touch-reorder`, `playlist-progressive-focus`) | **7 passed / 0 failed / 0 skipped / 0 flaky**, 41.1 s |
| `guard:sw-cache-version`, `guard:release-identity` | Passed (v686 at `b5b15579` covers the runtime changes) |

New pins, each failing on the code before its change:

- A dropped reorder shows its order before the server answers and keeps it
  through the accepted snapshot.
- A rejected reorder restores the server's order and shows the new toast.
- The newest of two quick drops survives the first accepted snapshot and both
  server answers.
- Revoking queue authority mid-flight restores the server's order without a
  toast.

The existing queue-mode overlap pin had used the local row order as its signal
that the server had accepted each reorder. It now waits for the accepted
snapshot to project; the overlap it exercises is unchanged.

Not verified: physical iOS/Android devices, WebKit, the full serial E2E suite,
and production behavior. The local stack cannot open PRO rooms, so the drop was
not exercised against a real room before release.

## Release and recovery

App **8.10.20/v686** shipped through
[Production Release 38593965412](https://github.com/hiefny/MUSIXQUARE/actions/runs/38593965412),
attempt 1, target `app`, Developer API D1 application `false`. The deploy job
completed successfully at **2026-10-15 01:00:12 KST** using the immutable candidate
from exact-main CI `38593021162` for `27dceedc79c306142fd0fe78801cf1ca383c56ce`.
No rollback was needed; the recovery job was skipped.

- App version `8f42c8ee-7ec3-4d25-ae56-0eb9855bf4f4` became
  `bd269acb-527b-4cce-9601-af45ba319c75`. Final deployment ownership was verified
  at 01:00:04.896 KST, and the coherent production marker records the exact SHA
  and target `app`.
- The partial-release compatibility recheck at 00:59:30.152 KST was compatible.
  The five unselected Workers were not deployed and keep the `d9364cd9`
  identities in `docs/release-record.md` §1; the PRO smoke re-read pro-room
  `8d5d44c0`. The new App deployment identity is in the 90-day run artifact
  `production-deployments-27dceedc79c306142fd0fe78801cf1ca383c56ce-38593965412-1`.
- App generation (`main-DZrm4G_z.js`, 27 assets converged), anonymous App account
  boundary, current PRO public boundary and Standard HTTPS signaling smokes
  passed. Out-of-scope Worker smokes were skipped, not counted as passes.
- Public checks at 01:01:14 KST returned HTTP 200 for `/`, the v686 service
  worker, `bootstrap.js?cache=v686`, `main-DZrm4G_z.js` and `main-BNiplmKU.css`.
- [Operations Drift Audit 38594339347](https://github.com/hiefny/MUSIXQUARE/actions/runs/38594339347)
  succeeded. Its 01:00:54.943 KST report records **31 pass / 0 fail / 5 manual-only**;
  manual checks are not treated as completed.
- The reorder was not reproduced in a production PRO room after release.

The immutable recovery checkpoint captured at 00:58:57.678 KST
(`production-recovery-checkpoint-27dceedc79c306142fd0fe78801cf1ca383c56ce-38593965412-1`)
preserves the previous App `6afd91871ee0bf6e30a543065799c50e4191028b`, 8.10.19/v685,
version `8f42c8ee-7ec3-4d25-ae56-0eb9855bf4f4`. Rolling back to it restores the
redraw of the old order after a drop. Mixed versions are safe because the change
is participant-local. The checkpoint is not a user-data backup; no data
migration is needed and existing recovery floors remain binding.
