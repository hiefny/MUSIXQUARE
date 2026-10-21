# Multiple playlists per room (2026-10-21)

- Status: design and implementation record for the owner's request of 2026-10-21. Ships with 8.11.33 in
  one release (owner decision: hold the 8.11.33 deploy until this is done). Verification is appended
  below as it lands.

## Owner request (summary)

- A room has three playlists: "Playlist" (no number, the default), "Playlist 2", "Playlist 3".
- The playlist header gets a chevron and becomes one large button (like the account center nickname
  row or the first-run "Hello" language button). It opens the "Multiple playlists" modal: title, the
  subtitle "Use several playlists to switch between sets of songs quickly", one row per playlist with
  the language picker's check and grey selected row, the track count and total size as the row's
  second line, and a blue confirm button. Confirming a different playlist switches the whole room to
  it and stops playback. PRO rooms show storage use ("00 / 1 GiB") where the language picker has its
  translate link.
- Long names are truncated before the number ("Playl… 2").
- In edit mode a blue Move button sits left of the red trash button. It opens "Move N tracks": the
  other playlists with the minus/check multi-select, Copy and Move (blue), and a wide grey Close,
  laid out like the account center buttons.
- A bot or API must be able to say "play track 34 of playlist 2" (switch, then play) or "delete track
  5 of playlist 1".

## Model

- `PLAYLIST_SLOT_COUNT = 3`; slot 0 is the unnumbered default. Names are derived from `nav.playlist`
  (slot n > 0 shows "<name> <n + 1>"); there is no rename, create or delete.
- `playlist.items`, `playlist.currentQueueItemId` and `playlist.revision` keep meaning exactly what they
  mean today: the **active** playlist. Every existing add/remove/reorder/play path, wire frame and
  bootstrap stays unchanged, so an older client only ever sees one playlist: the active one.
- New state: `playlist.slots: PlaylistSlotsSummary | null` (`{activeSlot, slots: [{count, bytes}]}`)
  and `playlist.storageUsage: {usedBytes, limitBytes} | null` (PRO only). `slots === null` means the
  room authority has not announced playlists (an older host or Worker): the switcher and Move stay
  hidden.
- Switching stops playback and selects no track (`currentQueueItemId = null`). Transfer appends to
  the end of each target in active-playlist order, with fresh queue item IDs per target (so the same
  track can sit in several playlists). Move then removes the tracks from the active playlist through
  the existing removal path (so moving the current track behaves like deleting it). A target that
  would exceed `MAX_QUEUE_ITEMS` refuses the whole transfer.

## Standard rooms (host-authoritative)

- The host keeps inactive playlists in memory with their items, including each file item's `File`,
  so moving a local file never loses it. Nothing is persisted (same as today).
- New host-to-guest frame `PLAYLIST_SLOTS {type, activeSlot, slots: [{count, bytes}]}` with exact keys,
  sent after the join bootstrap frames and after every change to any playlist (the active one
  included, since guests do not know file sizes). Bytes are the sum of file sizes; YouTube items add
  nothing; `bytes` is null for a playlist without file items. An older guest has no validator or
  handler for it, so it is dropped silently (`handleData`).
- New guest-to-host requests through the existing two-phase queue mutation authority (capability
  `queue.mutate`): `REQUEST_PLAYLIST_SWITCH {requestId, baseRevision, slot}` and
  `REQUEST_PLAYLIST_TRANSFER {requestId, baseRevision, queueItemIds, targetSlots, mode}`. An older host
  ignores them; the guest's accept timeout shows the existing "host must update" toast.
- The join bootstrap frame keeps its exact keys (`join-bootstrap.ts`); playlists are never added to it.

## PRO rooms (Worker-authoritative)

- Storage: inactive playlists live beside the existing v2 keys, so the active playlist's
  `pro-room:v2:core` / `pro-room:v2:playlist:<id>` layout is unchanged. A new
  `pro-room:v2:slots` record holds `{schemaVersion: 1, activeSlot, orders}` and inactive items are
  stored under `pro-room:v2:slot-item:<queueItemId>`. A room without the record has one playlist at
  slot 0.
- Asset garbage collection and per-asset deletion count references from every playlist. Copying a
  file reuses its asset, so room storage use does not grow; `usedBytes` stays the room-wide counter.
- Snapshot: a client that sends `X-MXQR-Pro-Playlist-Slots: v1` receives an optional
  `playlistSlots {activeSlot, slots}` field; others get today's exact snapshot (the deployed client
  parser rejects unknown keys). Same opt-in pattern as `X-MXQR-Pro-Entry-Policy: optional-v1`.
- Mutations (`queue.mutate`, room revision CAS): `POST {prefix}/playlists/switch {baseRevision, slot}`
  and `POST {prefix}/playlists/transfer {baseRevision, queueItemIds, targetSlots, mode}`. Both bump the
  room and playlist revisions and invalidate clients as other queue edits do.
- Bot: context lists each playlist with ordinals; plans may name a playlist. "Play track 34 of
  playlist 2" switches to slot 1 and plays its 34th item; "delete track 5 of playlist 1" removes from
  that playlist even when it is not active.
- Developer API (1.x, additive): playlist summaries and per-playlist queues, an optional `playlist`
  (1-based) on `play_item` and item deletion, and a `switch_playlist` command. Requests without it act
  on the active playlist as today.

## Compatibility and rollback

- Mixed versions: an older standard guest sees only the active playlist and follows a switch as an
  ordinary playlist replacement. An older PRO client never asks for slots and keeps working on the
  active playlist. A newer client hides the switcher and Move until the authority announces slots.
- Rollback: an older Worker ignores the new keys (it reads only the core and listed active items), but
  its garbage collection would treat files referenced only by inactive playlists as unreferenced.
  Rolling the Worker back therefore requires accepting loss of inactive-playlist files, or deploying a
  forward fix. This is recorded as a forward-only data floor in the release record.

## Other changes in this release

- Room password: the setting is titled "Room password" ("방 암호 설정") in all 42 languages. In standard rooms the
  host can show or hide the PIN this tab set with an eye button (masked by default); PRO rooms keep the pencil.
  Changing a standard-room PIN is now off then on.
- Spanish `nav.playlist` is "Lista".
- New strings (switcher, move dialog, copied/moved toasts) in 42 languages, derived from each language's existing
  playlist, track and toast wording; not reviewed by native speakers.

## Review fixes

An independent review of the merged code found, and this change fixes:

- PRO (P1): a participant could reuse an inactive playlist's queue item ID in a compact edit, which made the room fail
  to load on its next cold start. Adds now refuse IDs held by inactive playlists, and persistence refuses any ID
  collision across playlists.
- Standard (P2): inactive playlists outlived the room because standard rooms carry no room ID. They now reset per
  session (session code and role) and when the playlist module initializes.
- A guest's switch or transfer while the host is hidden is held like other commands; switching to a playlist whose
  file is being deleted leaves that item out (PRO).

## Verification (local, `cba800a5`, cache v756)

Windows, Node 24.20.0 / npm 12.0.2.

- Pass: typecheck, lint, format, guards (bus-pairing, dead-exports, import-graph, room-authority-boundaries,
  source-complexity, sw-cache-version), unit 13,661 pass / 0 fail / 0 skip, `build:checked` (eager JS 478.4 KiB gzip,
  under the unchanged ceiling).
- Chromium e2e: 41 run, 39 pass; the 2 failures were the edit bar's button count (now three with Move), updated in the
  next commit and rerun with `pro-entry-password`: 16 pass. `playlist-slots` covers copy, room-wide switch, move and a
  guest following every step.
- Not covered: a real PRO room against the deployed Worker (worker tests use the Workers test runtime), real devices,
  WebKit, screen readers, and native-speaker review of the translations. Local results do not replace the exact-main
  CI candidate.
