# Multiple playlists in PRO rooms: implementation and verification (2026-10-21)

- Status: implementation record for the PRO (Worker-authoritative) half of
  [the multiple-playlist design](multi-playlist-2026-10-21.md). The standard-room half and all UI
  are recorded separately. Ships with 8.11.33.
- Branch: `agent/multi-playlist-pro`, built on `9182065d` (design and shared slot contract).

## Durable Object storage

- `cloudflare/pro-room-playlists.ts` holds the slot helpers (validation, summaries, swap, asset
  references). The active playlist keeps the unchanged v2 layout: `pro-room:v2:core` plus
  `pro-room:v2:playlist:<queueItemId>`. Inactive playlists live beside it:
  `pro-room:v2:slots` `{schemaVersion: 1, activeSlot, orders}` (one order per slot, the active
  slot's order always empty) and one `pro-room:v2:slot-item:<queueItemId>` row per inactive item.
- In memory the room carries `playlistSlots?: {activeSlot, inactive}`. It is stripped from the core
  record, so the core budget (1.2 MiB) is unchanged; each inactive playlist has the active
  playlist's bounds (1,000 items, 3 MiB, 128 KiB per item).
- Absent record = one playlist at slot 0, so existing rooms load unchanged and a room that never
  uses another playlist writes no new keys. A room that is back at slot 0 with empty other
  playlists deletes the record.
- Load validates the record strictly (exact keys, one order per slot, IDs unique across every
  playlist, every row present and matching) and fails closed with
  `PRO_ROOM_PERSISTENCE_V2_SLOTS_INVALID`, like an invalid core record. Persistence diffs slot rows
  and the record by signature and writes them in the same storage transaction as the core record,
  so a switch that moves rows between the two key families is atomic.
- Asset garbage collection, the explicit `DELETE /media/{assetId}` in-use check and its pending
  retry all use `referencedAssetIds()`, which now counts every playlist. Copies reuse the source
  asset, so `quota.usedBytes` stays the room-wide counter and copying never changes it.
- Decommissioning replaces the room with a fresh state without `playlistSlots`, so its next commit
  deletes every slot key.

## Client wire (PRO room public API)

- Opt-in header `X-MXQR-Pro-Playlist-Slots: v1` (added to the CORS allow list). With it, every
  `{snapshot}` envelope gains `snapshot.playlistSlots = {activeSlot, slots: [{count, bytes}] x3}`
  (`bytes` = sum of `pro-r2` `byteLength`, null for a playlist without files). Without it the
  response is byte-identical to before; the rewrite shares the entry-policy rewrite step.
- `POST {prefix}/playlists/switch` exact `{baseRevision, slot}`, capability `queue.mutate`,
  `Idempotency-Key` required, room revision CAS. Swaps the playlists, stops playback (idle commit,
  pending transition cancelled), clears `currentQueueItemId`, bumps the room and playlist
  revisions, broadcasts `pro-room-invalidated` with `playlistRevision` (and `playbackRevision` when
  playback stopped). Switching to the active slot returns the unchanged snapshot.
- `POST {prefix}/playlists/transfer` exact `{baseRevision, queueItemIds, targetSlots, mode}`,
  capability `queue.mutate` plus the `media.add` permission (a copy adds tracks). Clones get fresh
  queue item IDs per target, keep their source and attribution, and are appended in active order.
  Any target that would pass 1,000 items refuses the whole transfer
  (`409 PLAYLIST_CAPACITY_EXCEEDED`). `move` then removes the tracks from the active playlist the
  way the compact removal does, including stopping a moved current track.
- Errors: `400 INVALID_REQUEST | INVALID_REVISION | INVALID_PLAYLIST | INVALID_PLAYLIST_SLOT`,
  `404 QUEUE_ITEM_NOT_FOUND`, `409 REVISION_CONFLICT | PLAYLIST_CAPACITY_EXCEEDED |
ROOM_STATE_CAPACITY_EXCEEDED`, `403 PERMISSION_REQUIRED`. Replays use the snapshot receipt.
- Client (`src/pro-room/**`): `ProRoomApiClient.switchPlaylist` / `transferPlaylistTracks`,
  `ProRoomPlaylistStateManager.switchPlaylist` / `transferTracks` (one refresh-and-retry on a
  revision conflict), strict optional `playlistSlots` in `parseProRoomSnapshot`, and the runtime
  publishes `playlist.slots` and `playlist.storageUsage` from every accepted snapshot (both reset
  to null when the PRO playlist runtime resets). The `switchPlaylist` / `transferTracks` media
  hooks return false without queue authority, without announced slots, or for invalid arguments.

## BOT

- `/internal/bot/context` keeps `room.playlist` (the active one) and adds `room.activePlaylist`
  and `room.playlists` (all three, up to 100 items each). The app-side room response limit for
  BOT calls is 1 MiB (was 256 KiB) so three long playlists fit.
- `cloudflare/pro-bot.ts` reads a room playlist number from the request ("playlist 2",
  "플레이리스트 2", "2번 플레이리스트", ...), resolves track ordinals and deletion targets
  against that playlist, refuses ambiguous or unavailable playlists, and sends `playlist` only
  for a non-active playlist (an older Worker never sees it).
- `play_existing` with `playlist` switches the room and plays the item in one Developer command;
  it also needs the `media.add` permission because it replaces the room's queue.
  `remove_items` with `playlist` removes from that inactive playlist without touching playback.
  `youtubeSubItemNumber` is refused together with another playlist.

## Developer API 1.1 (additive)

- `GET /v1/rooms/{roomCode}/playlists`, `GET /v1/rooms/{roomCode}/playlists/{1-3}/queue`,
  `DELETE /v1/rooms/{roomCode}/playlists/{1-3}/queue/items/{queueItemId}` (the public worker
  rejects bodies and query strings on DELETE, so the playlist is a path segment), an optional
  `playlist` (1-based) on `play_item`, and `switch_playlist {playlist}` (playback:control).
  Requests without a playlist act on the active playlist exactly as before. `openapi.yaml` is
  1.1.0; the HTML developer page is not updated yet.
- Durable Object internals: read projections `playlists` and `playlist-queue` (`playlist`
  required only there), `remove`/`remove_many` with optional `playlist` (a removal naming a
  playlist answers with that playlist's queue and replays it through a
  `developer-playlist-queue` receipt).

## Compatibility and rollback

- An older PRO client never sends the header and keeps receiving the exact v1 snapshot; it edits
  only the active playlist. An older app Worker ignores the new BOT context fields; an older PRO
  Worker rejects the new internal fields with 400 (only sent for a playlist the user named).
- Mixed deploys: the facade and public Developer API Worker should not go live before the PRO
  room Worker, or the new routes answer 400/503 until it does. Existing routes are unaffected in
  either order.
- Data floor: a rolled-back Worker loads only the core record and active rows, so it shows the
  active playlist; its garbage collection counts only that playlist and would delete files that
  only inactive playlists reference (after the 15-minute grace). Rolling the PRO room Worker back
  therefore means accepting the loss of those files, or deploying a forward fix. The slot keys
  themselves are left in place by an older Worker and are read again after a forward deploy;
  on that load the Worker drops inactive items whose asset no longer exists (a file-only item
  would otherwise block every edit of its playlist once it becomes active, because edits
  validate assets), and the next commit rewrites the slot keys.

## Verification

- Environment: Windows 11, Node 24.20.0 (pinned toolchain), worktree
  `agent/multi-playlist-pro`.
- Tested code: `b5f9daae` (local branch only; this is not the exact-main release candidate).
- Pass: `npm run typecheck`, `npm run lint`, `npm run format:check`, `guard:bus-pairing`,
  `guard:import-graph`, `guard:room-authority-boundaries`, `guard:source-complexity`
  (`pro-room-worker.ts` 18,069 of 20,000 lines).
- Full `npx vitest run --maxWorkers=6`: 13,650 passed, 1 failed, 0 skipped. The failure is the
  dead-export ratchet (`dead-exports.test.ts`, same as `guard:dead-exports`): test-only bindings
  22 > baseline 20 because the shared contract's `handleProRoomPlaylistSwitch` and
  `handleProRoomTrackTransfer` have no production caller until the UI branch is merged. It is
  expected to clear on merge and must be rechecked then.
- New coverage: `pro-room-playlists.test.ts` (record validation, summaries, swap) and the
  "PRO room multiple playlists" block in `pro-room-worker.test.ts` (8 tests: snapshot parity
  without the header, copy/switch/replay/restart with the storage layout, fail-closed load,
  inactive files kept and usedBytes unchanged on copy, rollback repair, move of the current
  track and refusals including capacity, Developer API projections/removal/play_item/
  switch_playlist, BOT per-playlist ordinals and targeted play/remove). Client, BOT and
  Developer API suites cover their halves (`api.test.ts`, `playlist-state-manager.test.ts`,
  `runtime-playlist-slots.test.ts`, `pro-bot-worker.test.ts`, `developer-api-*.test.ts`,
  `developer-api-docs.test.ts`).
- Not covered: real Cloudflare runtime, real browsers, e2e (the PRO e2e CORS fixture allows the
  new header but e2e was not run), and the standard-room/UI half.
