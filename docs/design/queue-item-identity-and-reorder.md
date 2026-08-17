# Queue Item Identity and Reorder

Status: implemented current contract
Date: 2026-07-11
Last repository contract review: 2026-08-17

## Decision

MUSIXQUARE treats an item in the playback queue as a stable entity whose identity is independent
of its current array position.

Every `PlaylistItem` has one immutable `queueItemId`. In a standard room, the browser host generates
it. In a PRO room, an authorized browser add proposes a UUID that the room Durable Object validates
and adopts, while Developer API additions, including its media-upload path, generate the ID inside
the Durable Object. The ID becomes canonical only after the authoritative queue owner accepts the addition.
Moving an item, updating its title, expanding a YouTube playlist row, or synchronizing it to
participants preserves the ID. Removing an item retires the ID. Adding the same media again creates
a new ID because it is a distinct queue occurrence.

An array index is only a projection of the current order. It may be used to render a track number or
to access an item after resolving its ID, but it must not be used as asynchronous or distributed
identity.

## Identity layers

The following identifiers are deliberately separate:

| Identifier                      | Meaning                                       | Lifetime                  |
| ------------------------------- | --------------------------------------------- | ------------------------- |
| `queueItemId`                   | One occurrence in the queue                   | Add until removal         |
| `playlistRevision`              | Version of the authoritative ordered snapshot | Standard host session or PRO room incarnation |
| `sessionId`                     | One file transfer or preload attempt          | Transfer attempt          |
| `objectId`                      | One remote R2 object                          | Remote object lifetime    |
| `videoId` / `playlistId`        | YouTube content                               | YouTube content lifetime  |
| `File` / `Blob` object identity | Local byte source                             | In-memory object lifetime |
| array index                     | Current visual position                       | Until the next mutation   |

No identifier in this table substitutes for another. In particular, `queueItemId` does not replace
transfer `sessionId`, and a content identifier does not identify two separate occurrences of the
same content in the queue.

## Queue invariants

1. Every queue item has one syntactically valid `queueItemId`.
2. IDs are unique within a playlist snapshot.
3. An ID enters a canonical snapshot only through the authoritative queue owner. The standard-room
   browser host generates it. The PRO room Durable Object validates a browser-proposed ID or
   generates one for a server-owned add path. Other participants preserve accepted IDs.
4. Reorder never changes an item's ID or media object.
5. `currentQueueItemId` is `null` or names an item in the current queue.
6. Preload, recovery, remote download, async metadata, and shuffle state bind to `queueItemId`.
7. A cached index may exist as a derived rendering/access value, but identity comparisons use the
   ID and the index is reconciled after every queue mutation.
8. A deleted ID cannot be revived by a late async completion or transfer frame.
9. `playlistRevision` is a non-negative safe integer and increases for every authoritative snapshot
   mutation that is broadcast.
10. Guests reject malformed snapshots, duplicate IDs, and older revisions without partially
    applying them.

## Protocol

In a standard room, the host sends full ordered snapshots. The snapshot contains:

- `list`: serialized queue items including `queueItemId` and excluding local `File` objects;
- `revision`: the authoritative `playlistRevision`;
- `currentQueueItemId`: the currently selected occurrence or `null`.

Full standard-room snapshots are intentional. They keep recovery and late join deterministic and
avoid a second distributed mutation protocol while the room has one authoritative browser writer.
Reorder therefore mutates the host model, increments the revision once, and broadcasts the
resulting snapshot.

In a PRO room, clients submit revision-fenced mutation intents or compact snapshots to the room
Durable Object. A browser add proposes a UUID; the Durable Object validates and canonicalizes it.
For Developer API additions, including its media-upload path, the Durable Object creates the ID. It
persists the ordered queue and revision, then returns or fans out canonical server-owned
state. No browser acts as the authoritative PRO snapshot writer.

Track-scoped playback and transfer messages carry `queueItemId`. A receiver resolves the current
index from its latest snapshot. A message for an ID no longer present is stale and is ignored or
aborted according to its subsystem.

## Current deployment contract

This is an intentional protocol hard cut. Production code does not accept the former positional
`index` as a queue identity fallback.

The original queue-ID rollout was a coordinated web-client/remote-share hard cut and is complete.
Production has no positional `index` identity fallback. Any future incompatible queue contract
change must again use the coordinated release path, require incompatible cached clients to refresh,
and pass the queue-ID-aware live remote-share smoke and the separate PRO-room public-boundary smoke
before the release is declared healthy.

## Mutation semantics

### Add

- Generate one new ID per added occurrence.
- Commit the entire accepted batch as one revision.
- Preserve the IDs through asynchronous title/indexing work.

### Reorder

- Address the moved item by ID, never by its captured index.
- Resolve the drop target immediately before committing.
- Move the existing object without cloning its media identity.
- Preserve current playback, decoded audio, preload, recovery, shuffle cursor, and remote download
  ownership by ID.
- Re-evaluate the speculative next-track target after commit. If the intended occurrence is still
  the same, retain its resident Blob and transfer session; if it changed, preload the new target.
- Broadcast one post-commit snapshot.

### Remove

- Address the item by ID.
- Cancel or invalidate work owned by that ID.
- If the current item is removed, choose a successor from the post-removal queue and give playback
  ownership to that successor's ID.
- Removing an earlier item must not invalidate caches for later items.

### Metadata update

- Async YouTube results capture the item's ID.
- Before committing, the callback verifies that the ID is still present and still owns the expected
  content.
- The update preserves order and identity.

## Batch removal interaction

Playlist removal is a two-step, host-local selection transaction rather than a confirmation
dialog:

- Each existing row `X` is a toggle keyed by `queueItemId`. Its visual shape stays unchanged; a
  selected occurrence gains a red filled state and `aria-pressed="true"`.
- The first selection reveals one blue floating pill at the bottom of the playlist. Its three
  icon-only actions are **toggle select all**, **delete selected**, and an explicit **cancel**;
  localized ARIA labels and desktop tooltips retain language and assistive-technology support
  without visible copy.
- The select-all action becomes an active toggle once every row is selected. Pressing it again,
  using cancel, or deselecting the last row directly, clears the local selection and closes the
  pill. No authoritative queue state changes until the delete action is pressed.
- Delete emits the selected IDs once in current playlist order. The player validates live IDs,
  filters the queue once, increments the playlist revision once, broadcasts one authoritative
  snapshot, and loads at most one surviving successor.
- If the current item is selected, sequential playback chooses the first survivor after the entire
  removed set, falling back to the nearest prior survivor. Shuffle follows the prior shuffle order
  and wraps only under repeat-all.
- Selection is view-local, is pruned by stable ID after any authoritative rerender, and is cleared
  when host authority or the playlist surface is left. Guests never receive removal controls.
- Reorder is suspended while removal selection is active, avoiding two simultaneous queue-editing
  gestures while preserving the selected identities across ordinary rerenders.

## Reorder interaction

The left number slot is also the reorder affordance. Number and handle occupy the same fixed box, so
the row never reflows.

### Playlist tab entry

- Every real entry into the responsive playlist tab reveals all handles for 2 seconds, regardless of
  whether the current device reports a mouse, touch, coarse pointer, or hybrid input.
- The always-visible desktop dashboard does not synthesize a tab-entry hint; row hover remains its
  persistent discovery path.

### Fine pointer / desktop

- Hovering or focusing one row crossfades only that row's number into a drag handle.
- Other rows keep their numbers so the order remains legible.
- A completed add batch reveals handles on all reorderable rows for 2 seconds.

### Touch / coarse pointer

- A completed add batch reveals all handles for 2 seconds when the playlist is visible; otherwise
  the hint is deferred until the next visible entry.
- During a confirmed native scroll, only the row currently under the finger shows a handle. A tap
  alone never activates this hint and retains the existing play-from-start behavior.
- The row under the finger is found from the latest touch viewport coordinates and
  `elementFromPoint()` on a scroll animation frame. The hint ends when contact ends and does not
  continue through momentum scrolling.
- Holding a row body motionless for 700 ms activates reorder with that same touch. Any 8 px movement,
  actual scroll offset change, active momentum scroll, or interactive child control permanently
  disqualifies long-press for that contact. Stopping after scrolling never re-arms the timer.

### Drag behavior

- Direct dragging from the left slot is always available to authorized users.
- Only the active item floats; other rows retain their numbers.
- Crossing a destination immediately previews the `queueItemId` order in the DOM. Surviving entries
  use an interruptible FLIP transform so variable-height rows glide into their new slots instead of
  snapping; visible numbers and handle position metadata follow the preview order, and the floating
  row settles into the final slot on drop.
- Pointer capture belongs to the stationary playlist container, not the source handle, because the
  source entry is reinserted during preview and Chromium releases capture from a reparented handle.
- The floating row uses elevation without an accent outline. Hover changes only number to handle and
  never paints the whole row; the current-track and pressed-state backgrounds remain intentional.
- Edge proximity auto-scrolls the playlist.
- Native scroll anchoring is disabled only for the active reorder gesture so DOM preview moves do not
  compete with edge auto-scroll on long lists.
- Escape or pointer cancellation restores the pre-drag order.
- Keyboard users can move the focused item with explicit up/down commands and receive an ARIA live
  position announcement.
- `prefers-reduced-motion` skips both FLIP and drop-settle transitions while preserving the same
  preview, commit, cancellation, and focus semantics.
- Guests without queue mutation authority see neither handles nor reorder hints.

Interaction state priority is:

`dragging > row hover/focus or touch-scroll row > global hint > number`.

## Verification requirements

- Reorder before, after, and during playback without restarting the current item.
- Reorder a preloaded successor without another download or decode.
- Delete before a preloaded item without re-downloading that item.
- Reorder during remote download and preserve the `queueItemId` + `sessionId` owner pair.
- Resolve late YouTube titles into the original item after reorder.
- Preserve shuffle previous/next round trips after reorder and deletion.
- Select non-contiguous and duplicate-name occurrences, then verify one revision and one guest
  snapshot for the batch deletion.
- Delete the current item together with several immediate successors and load only the first live
  successor after the complete removed set.
- Reject duplicate/malformed IDs and stale revisions.
- Synchronize host and every guest to the same ID order and current ID.
- Verify mouse, touch scroll hint, direct handle drag, 700 ms long-press, cancellation, edge scroll,
  reduced motion, and keyboard behavior.
- Exercise local file, remote file, single YouTube video, and YouTube playlist rows.
