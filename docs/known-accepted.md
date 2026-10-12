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

### 10. Local Development Origins in Production CORS Allowlists

Accepted 2026-10-11 by the owner. The production `ALLOWED_ORIGINS` of the PRO
room and Remote Share Workers (`cloudflare/wrangler.pro-room.toml`,
`cloudflare/wrangler.remote-share.toml`) include `http://localhost` and
`http://127.0.0.1` on ports 3000, 5173, and 4173 so local development builds can
call the production services. The PRO room Worker answers allowed origins with
credentialed CORS. Only a page served from the visitor's own loopback address on
those ports can use this, and every request still passes the Worker's normal
session, PIN, and rate-limit checks. Revisit if a production Worker gains a
privileged browser API that should be reachable only from public origins.

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
  by enabling or rotating the PIN with "Everyone rejoins", which does not
  clear the rate-limit records; an absent owner has to wait for receipts and
  records to expire and sessions to leave, and a sustained distributed flood
  can repeat this. No byte headroom is reserved for the owner.
- The remedy is the owner's: enter through the reserved place and enable or
  rotate the PIN, choosing "Everyone rejoins". That revokes every other
  session and presence, purges all session-create receipts, and resets the
  throttle; the revoked sessions' presence-close receipts go at the next
  prune. The default choice, "Keep everyone", is not a flood remedy: it keeps
  every present session, strangers included, and revokes only dormant ones.
  People it keeps stay signed in to the room on that device, without the PIN,
  until they leave, are removed, or their 30-day session expires.
- A kick deletes the member's sessions, so coming back needs a new, throttled
  join; there is no ban list. The kick (and an "Everyone rejoins" PIN
  change) also writes a removal notice, so the updated App tells that browser
  why and does not re-admit it silently. It shows the notice once per tab;
  after that, deliberately opening the room again is an ordinary join. Up to
  256 notices (about 36 KiB of the core) exist at a time, each for at most 7
  days. Only owner and administrator actions write them, never public
  traffic, and each is written while a larger session record is deleted.
  Cached Apps older than 8.9.0 do not read the notice: until they update, a
  kicked member sees the generic refresh and can rejoin a public room with one
  Start tap.
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

### 12. Standard-Room Owner PINs, Kicks, and Guessing

Accepted 2026-10-11 with App 8.10.0. A Standard-room host now types the
8-digit room PIN instead of receiving a random one, and weak PINs such as
`00000000` are allowed in both room types by owner decision: a room PIN is a
soft access deterrent, not an account credential. The signaling Worker limits
wrong PINs per network only: 20 per 10 minutes per room and per client address
block (IPv4 address or IPv6 /64), counting failures only. It tracks at most 256
address blocks per room and never evicts a live bucket; a block it cannot track
is not limited at all, and there is no shared overflow bucket
([ops](../cloudflare/standard-room-pin-ops.md#owner-chosen-pins-kept-devices-and-the-wrong-pin-limit-app-8100)).
What remains accepted:

- **No ban list after an individual kick.** Kicking a Standard-room device
  closes its data channel and its unmodified App leaves, but the Worker keeps
  that guest's signaling socket admitted and the host accepts new offers
  without a deny list. A modified client can therefore come back without the
  PIN. It can also come back by reconnecting with its kept exemption ("그대로
  두기") until the next PIN change. The remedy is a PIN change with
  "모두 재입장", which closes every guest socket and clears the reconnect
  bindings and the kept set; a host-to-Worker revoke for one guest can come
  later.
- **Distributed guessing (accepted by the owner on 2026-10-11).** Each tracked
  network gets 20 wrong PINs per window. Once 256 networks hold a live bucket
  in a room, every further network is not limited and its failures are not
  recorded until a bucket expires, so someone who rotates through many
  addresses, which is easy with IPv6 (one routed /56 holds 256 /64s), can keep
  guessing without limit. With an owner-chosen PIN, and weak PINs allowed, this is
  weaker than the former random PIN. The owner chose this over the earlier
  fail-closed design, in which one shared bucket for every network past 256
  let about 276 wrong PINs from one /56 keep every new guest out of the room
  for 10 minutes at a time, renewable indefinitely: room PINs here are a soft
  access deterrent, and blocking real guests from an event is worse than a
  guessed PIN. Apart from the shared buckets below (one NAT, or the HTTP
  bridge), no guest is refused because of another network's failures, and a
  corrupt or oversized failure record, or a storage failure, refuses nobody.
  If a guesser gets in, the remedy is the host's: kick the device, or change
  the PIN with "모두 재입장".
- **Shared networks.** Everyone behind one NAT shares a bucket, so after many
  typos in a crowded venue new joiners there wait until the window ends (at
  most 10 minutes, unless someone on that network keeps entering wrong PINs).
  HTTP-bridge guests carry no client address and share one per-room bucket,
  which the owner kept. That lock is not limited to one window: anyone who
  knows the room code and can open HTTP-bridge sessions (any client with a
  Standard signaling capability, up to 8 opens a minute each) can lock it with
  20 wrong PINs and renew it every 10 minutes for as long as they continue.
  Meanwhile every fresh guest who reaches the room through the HTTPS bridge
  fallback (used when both WebSocket routes fail before admission) is refused
  even with the right PIN; WebSocket newcomers are not affected. This is the
  one newcomer lockout that someone outside the guests' own network can cause.
  For either shared bucket the host can turn protection off, kept devices
  bypass the lock, and devices already in the room keep their signaling
  recovery: a reconnect whose secret matches its live binding (admitted now,
  or within the 5-minute reconnect window) passes the lock and only has its
  PIN checked. A device whose signaling stayed down past that window, while
  its data channel lived, is treated as a new joiner; if its bucket is locked
  then, the App
  treats the refusal as a permanent auth error and that device loses signaling
  recovery (ICE restarts) for the rest of its connection, as with a stale PIN.
  During the 8.10.0 transition, cached 8.9.x hosts still generate random PINs;
  if they refreshed the PIN, their present guests re-send the old PIN on the
  deploy reconnect and those failures count against the shared bucket too.
- **Older Worker.** If signaling is rolled back, the App sends the PIN alone:
  present guests are kept as before 8.10.0 (and lose ICE-restart recovery after
  a later signaling reconnect), "모두 재입장" is only the host's kick, which a
  modified client can ignore, and the wrong-PIN limit is off.
- **Older App copy.** Guests on a cached App older than 8.10.0 removed by
  "모두 재입장" show the generic "강제퇴장" kick dialog and reload instead of the
  PIN notice, and show the generic join error for `room-password-changed` and
  `room-password-rate-limited`. Both errors stay permanent auth errors there,
  so there is no reconnect storm.

Reopen this item if Standard rooms become discoverable or listed, if kick
evasion is observed in production, or before relying on a Standard-room PIN for
anything more than keeping casual visitors out. If guessing attacks are
observed, consider adding a bot check (for example Cloudflare Turnstile) or
proof of work before guest PIN attempts. The main signal is a spike in
"Password failures" (`guest_auth_failed`) in the admin Signals panel or in the
Operations "Password issues" card, or abuse reports: every wrong PIN that
reaches the PIN check counts there, whether or not its network is tracked.
"Password lockouts" (`guest_auth_rate_limited`) is only a secondary signal,
because guessing from networks past the 256 tracked ones, or kept under 20
wrong PINs per tracked network, never produces a lockout.

### 13. Maintenance Cutover Without Client-Version Admission

Accepted by the owner on 2026-10-12 for the App 8.10.2 synchronization release.
Maintenance plus a reload/reopen notice is an operational cutover, not a proof
that all running documents have refreshed. Old settings/sleeping tabs can
rejoin, and Standard P2P sessions have a separate lifetime from signaling.
Android-host old/new combinations can retain a 250 ms output mismatch described
in the [Android report](design/android-youtube-output-baseline-2026-10-12.md).

The owner chose not to add version-based admission, a legacy fallback, or forced
reload. The existing release workflow requires maintenance OFF for its public
smokes, so the selected sequence reopens immediately before the App release and
permits arrivals during that interval. This does not relax any CI/release check.
Revisit if mixed-version reports recur or a future release requires a guaranteed
wire-contract boundary. See the
[preparation and execution record](design/sync-maintenance-release-preparation-2026-10-12.md).

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
