# Known And Accepted Risks

Originally opened on 2026-05-12 after the app-state decomposition and playback
ownership refactor; later entries carry their own acceptance dates. Paths and
the continued reachability of the listed tradeoffs were statically rechecked on
2026-08-30. Static review does not replace the real-browser checks called out
below.

This document prevents future audits from repeatedly reporting intentional tradeoffs. It is not a bug backlog. Anything here should still be revisited if MUSIXQUARE becomes a larger public multi-tenant service, adds discoverable public rooms, or introduces a new app bootstrap lifecycle.

## Current Accepted Items

### 1. YouTube IFrame API Global

Files such as `src/youtube/player.ts`, `src/youtube/iframe.ts`, and `src/youtube/handlers.ts` declare the browser-provided `YT` global using the local `YTNamespace` type.

This is accepted. The YouTube IFrame API is injected at runtime by YouTube, not imported as a normal npm module. The current code no longer relies on broad `as any` escapes for this path.

### 2. Best-Effort Cleanup Around Closed Media And Network Objects

WebRTC connections, PeerJS-compatible connections, media calls, and Web Audio nodes can throw during cleanup when they are already closed, partially initialized, or browser-disconnected.

This is accepted when the cleanup path is best-effort and the owning state is already being cleared through MUSIXQUARE state/event contracts. Do not convert these paths into hard failures unless there is a concrete recovery behavior.

### 3. Long-Lived SPA Resources

The app intentionally keeps some resources for the full page lifetime:

- singleton `AudioContext`
- app-level bus listeners registered during bootstrap
- the sync worker and in-process storage bridge
- service-worker registration update timer

This is accepted under the current contract: `app.ts` bootstraps once per page lifetime. If the app ever supports runtime re-bootstrap, micro-frontends, or hot-swapping the root app without a reload, this item must be reopened.

### 4. File Recovery Requests Are Not Operator-Only Commands

`REQUEST_CURRENT_FILE` and `REQUEST_DATA_RECOVERY` are data-plane recovery messages, not playback-control commands. A non-operator guest still needs to request the current file or missing chunks to become playable.

This is accepted only while host/session/current-track guards remain in place. Do not "fix" this by adding operator checks; that would break late join and recovery flows.

### 5. Partial Standard-Room P2P Schema Validation

Standard-room P2P and browser transport messages are not all validated through
a full schema library. Every declared message type is now inventory-guarded as
either a lightweight bounded validator or an explicit handler-authority
compatibility case. Sensitive handlers still treat session participants as
untrusted and apply connection/session/current-track checks.

This is accepted only for the current temporary, invite-code standard-room threat model. PRO persistence and Worker HTTP/WebSocket boundaries have separate runtime validators, bounds, and authority checks and are outside this standard-room P2P exception; this statement does not claim that every stored envelope uses exact-key validation. Reopen this item before exposing discoverable public standard rooms, feeding partially validated standard-room messages into persistence, or changing the standard-room trust boundary.

### 6. Browser-Only API Test Gaps

Some behavior cannot be proven by jsdom unit tests alone:

- Media Session lock-screen behavior
- service-worker cache/update behavior
- real YouTube iframe state ordering
- WebRTC DataChannel and MediaStream timing
- iOS/Safari background and audio policy behavior

This is accepted as a test-layer boundary. The right mitigation is targeted Playwright/manual device verification, not over-mocking browser APIs until tests stop resembling production.

### 7. `document.execCommand` Fallbacks

Some UI paths still use `document.execCommand(...)` as a compatibility fallback for text insertion/copy behavior.

This is accepted while modern alternatives are not equivalent across the supported mobile/browser surface. Reopen if a target browser removes the API or if a specific command path fails in production.

### 8. Fixed-Scale Mobile Application Surface

The main MUSIXQUARE SPA intentionally disables browser page zoom with both
viewport metadata and an iOS gesture-cancellation fallback. This is accepted
because the product is a dense, fixed-layout playback application whose seek,
volume, drag/reorder, swipe, drawer, safe-area, and embedded-media controls
share one viewport coordinate system. Browser zoom changes that system during
interaction instead of reflowing a document.

This exception applies only to the main app shell. Preserve the remaining
accessibility contracts and direct users who require whole-screen
magnification to OS display zoom or the OS magnifier. Do not reopen this as a
generic accessibility finding without the product/design and physical-device
conditions in `docs/mobile-app-zoom-policy.md`.

### 9. Localized YouTube Display Titles in PRO Rooms

Standard rooms use the host-resolved YouTube title as the room-wide display title.
PRO room participants may display the title returned by their own localized YouTube iframe. Differences in localized display titles between PRO participants are intentional and are not treated as playback divergence. Queue identity and playback timing remain server-authoritative. See [Queue Item Identity and Reorder](design/queue-item-identity-and-reorder.md).

### 11. Public PRO Room Seat Holding and Join Floods

Accepted 2026-10-11. A public PRO room (no entry PIN) admits anyone who has
the room code. The room Durable Object reserves one of its 100 presence places
for the owner, keeps session-create receipts in their own ledger with 16 slots
of owner headroom, keeps presence-close receipts in another ledger (one per
stored session), and soft-throttles successful non-owner joins to 200 per 10
minutes per client IPv4 address or IPv6 /64. These measures reserve
the owner's place and receipt slots, so the owner can get in and act unless the
room's byte budget is also exhausted (below); they do not keep strangers out.
What remains accepted:

- One network, such as a venue NAT or a single attacker, can hold all 99
  non-owner places by keeping its sessions alive with heartbeats. A lower
  per-address limit would break a legitimate 99-device same-NAT venue, so the
  throttle bounds churn and refill, not occupancy.
- Join traffic spread across many addresses or /64 prefixes is not limited by
  the throttle. It can fill the 99 places, or fill the 240 non-owner receipt
  slots so that new non-owner joins fail closed with
  `ROOM_STATE_CAPACITY_EXCEEDED` for up to the 10-minute receipt lifetime.
  Owner entry and owner playback, queue, and media control keep their reserved
  place and receipt slots throughout.
- Ordinary members write no receipts to the participant ledger that protects
  playback, queue, and media control; only the owner and delegated
  controllers share its 256 slots.
- The reservations count places and receipts, not bytes. Every ledger, and
  every session and presence record, shares the room's 1.2 MiB core budget
  with media metadata and the rest of the room. At the longest accepted keys,
  public traffic can occupy about 101 KiB of session-create receipts (240,
  each for 10 minutes), 52 KiB of presence-close receipts (one per stored
  session, each until that session closes again or is removed, at most 24
  hours), the session and presence records of a full room, and about 50 KiB
  of security rate-limit records. A full room of 128 sessions and 100
  presences takes about 94 KiB with anonymous members, or about 153 KiB with
  account-linked members and their account member records (the 100-member
  limit counts accounts, and one account can hold several sessions), kept
  while the sessions exist. The 512 rate-limit records each last about an
  hour. Owner-recovery and owner-transfer attempts write one before their
  claim is checked, and a wrong PIN writes one too; each is keyed by the exact
  client address rather than a /64. That is roughly 300 KiB in all with
  anonymous members and 355 KiB with account-linked ones. In a room whose
  legitimate core is already within that distance of the budget, owner
  admission and owner writes, including media reservations, can fail closed
  with `ROOM_STATE_CAPACITY_EXCEEDED`. A present owner can release most of it
  by enabling or rotating the PIN, which does not clear the rate-limit
  records; an absent owner has to wait for receipts and records to expire and
  sessions to leave, and a sustained distributed flood can repeat this. No
  byte headroom is reserved for the owner.
- The remedy is the owner's: enter through the reserved place and enable or
  rotate the PIN. That revokes every other session and presence, purges all
  session-create receipts, and resets the throttle; the revoked sessions'
  presence-close receipts go at the next prune. A kick deletes the member's
  sessions, so coming back needs a new, throttled join; there is no ban list.
- The throttle counters live only in Durable Object memory and are kept per
  room. A restart forgets them, and different rooms behind the same carrier NAT
  do not share a budget.
- The security ledger is unchanged: PIN-failure, activation, and recovery
  limits still fail closed when that ledger is full. Public admission does not
  consult it. Its 512 records take about 50 KiB of the core, counted above.
- The reservation applies only when a session enters presence. If the owner's
  live session is demoted in place (for example by detaching its account),
  100 non-owner presences can remain, and the owner meets `ROOM_FULL` until
  somebody leaves. Signaling's
  100-socket cap has no owner preference, so the owner's control socket can be
  refused briefly until the next presence snapshot prunes a stale socket.
- The current App shows its generic PRO connection failure for both
  `ROOM_FULL` and `RATE_LIMITED`, without the `Retry-After` time.

Reopen this item if public rooms become discoverable or listed, if abuse is
observed in production, or before relying on public admission for paid events.
The next mitigations would be a WAF rule for
`/api/pro-room/v1/rooms/*/sessions`, or sign-in or proof of work for public
admission.

## Retired Risks

These older draft findings and subsequently resolved risks should no longer be
carried forward as accepted risks:

| Old item                                                               | Current status                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cleanupOPFSInWorker` listener leak                                    | Retired. Current storage is RAM-backed; `src/storage/storage.ts` explicitly avoids `navigator.storage.getDirectory()` writes.                                                                                                                                                      |
| PeerJS vendor/type escape warnings                                     | Retired. PeerJS is npm-backed and production `src` is pinned by `src/core/__tests__/type-escape-holdouts.test.ts`.                                                                                                                                                                 |
| Broad `Peer: any` / `as any` holdouts                                  | Retired. Current YouTube globals use local typed declarations; broad type escapes are covered by tests.                                                                                                                                                                            |
| Peer label/slot direct mutation as accepted reactive gap               | Retired as a blanket item. Critical peer maps now use `setState` with copied `Map`/object values in active paths.                                                                                                                                                                  |
| Tone.js cleanup/tree-shaking notes                                     | Retired. The audio layer now uses direct Web Audio helpers.                                                                                                                                                                                                                        |
| OPFS browser API coverage                                              | Retired as written. The remaining browser-only test gaps are Media Session, service worker, YouTube iframe, WebRTC, and real mobile audio policy.                                                                                                                                  |
| Blanket secondary-control accessibility gaps                           | Retired 2026-08-09. Concrete selection, carousel, dialog, chat-autocomplete, focus, and pointer contracts were audited and fixed; future exceptions must be documented individually.                                                                                               |
| System-audio media close handlers keyed only by channel/peer ID        | Retired 2026-07-19. Host and guest handlers now require exact `MediaConnection` identity, and a silent same-channel replacement has its own identity-fenced watchdog.                                                                                                              |
| `startSystemAudioCapture` mid-init failure leaves a silent-stop shadow | Retired 2026-07-16. `initAudio()` now completes before the prior playback snapshot is stopped, and a missing widener calls `abortPreparedCapture()` to restore that snapshot. Direct regression tests cover both failure paths.                                                    |
| System-audio entry does not cancel a debounce-parked file broadcast    | Retired 2026-08-30. After `stopAllMediaAsync` succeeds, `startSystemAudioCapture` now calls only `cancelPendingBroadcast()`. A failed teardown preserves the pending broadcast, while already in-flight outgoing transfers remain untouched. Regression tests pin both boundaries. |
| `/debug memory` retained and rendered every sample forever             | Retired 2026-08-30. Cumulative history now compacts to a bounded min/max envelope while preserving the full time span, endpoints, extrema, exact sample count, and running maximum; polling is single-flight.                                                                      |
| Loopback browser API clients implicitly retried production             | Retired 2026-08-30. Local PRO, TURN, and Realtime calls now fail closed on the same origin unless the explicit local-production fallback flag or a validated PRO endpoint override is configured.                                                                                  |

## Rule For Future Audits

When a new audit finding looks similar to one of these items, verify the current code path before dismissing it. Accepted means "intentional under today's contract," not "ignore forever."
