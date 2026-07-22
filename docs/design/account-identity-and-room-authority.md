# ADR: Optional accounts, room identities, and delegated authority

- **Status:** Accepted and implemented behind a two-stage production rollout gate
- **Decision date:** 2026-07-20
- **Applies to:** optional Google accounts, ordinary rooms, and persistent PRO rooms
- **Compatibility goal:** anonymous entry and chat continue to work when account services are unavailable

## Context

MUSIXQUARE historically treats one transport connection as one person. An
ordinary room identifies a browser with a PeerJS `peerId`; a PRO room identifies
one tab with a `participantId` and a presence incarnation. Labels, join numbers,
administrator grants, kicks, and chat grouping consequently belong to a single
device.

Optional accounts add a different concept: one person may have several active
devices, keep one nickname across rooms, own a PRO room, and retain a delegated
PRO grant while offline. Replacing a transport ID with an account ID is unsafe:
both signaling implementations deliberately allow only one live connection per
transport ID, so the person's devices would evict one another. Account identity
must therefore be an additional layer rather than a new spelling of `peerId`.

Accounts are not an admission requirement. Anonymous listeners must retain the
existing `Peer N` experience, including room entry and chat, even during an
identity-service outage.

## Decision

### 1. Four separate identity layers

```text
global accountId (optional, server-private)
  -> roomMemberId (room-scoped public pseudonym)
    -> participantId / peerId (one device or tab)
      -> presenceIncarnationId (one reconnect/takeover fence)
```

- A Google account maps to one random internal `accountId`. Google `sub`, email,
  and tokens are never exposed to a room.
- Each room maps an authenticated account to one stable, opaque
  `roomMemberId`. Anonymous users receive an ephemeral room member.
- Every device keeps a distinct transport identity and presence incarnation.
  Media transfer, signaling, READY cohorts, deduplication, and reconnect fences
  remain device-scoped.
- UI identity, account-wide kick, delegated authority, and chat grouping use the
  room member. The transport IDs remain available internally for delivery.

The room assigns the member the physical admission number of that account's
first device. Every later device still consumes its own physical slot, while the
UI groups them under the first number. Thus three devices for Minsu followed by
two for Jisu and one anonymous device render as `#1 Minsu (3)`, `#4 Jisu (2)`,
and `#6 Peer 6`. The number remains stable while that presence epoch is active.
After a PRO room becomes completely empty, the next presence epoch starts its
physical ordering at `#1` again; persistent account authority does not reserve a
visible number. The physical room limit remains a device limit rather than an
account limit.

### 2. Optional Google login

The App Worker is the only public account identity provider. It uses the Google
OpenID Connect authorization-code flow with PKCE, `state`, and `nonce`. A normal
browser opens the flow in a small same-origin completion popup so logging in
does not tear down an active room; installed/PWA contexts use a same-tab return,
which is more reliable under iOS standalone-window restrictions. Both paths
return only to allowlisted local routes.

- The requested Google scope is limited to `openid email`.
- A verified Google `sub` is HMAC-pseudonymized before storage. Email is used
  only to validate the Google assertion and is not retained.
- The browser receives a host-only, Secure, HttpOnly, SameSite=Lax opaque session
  cookie. D1 stores only a digest of the random token.
- Each browser device has a separate login session, while all sessions point to
  the same account.
- Login failure never blocks anonymous room entry or playback.
- Login begins at the canonical apex origin. OAuth return paths must be local
  paths and are allowlisted against open redirects.

The first successful login requires a MUSIXQUARE nickname. The nickname is
stored on the account and projected into every room through signed account
assertions.

New and changed account nicknames are limited to 12 Unicode code points. The
database and assertion readers retain a 20-code-point compatibility ceiling so
nicknames saved before this policy change continue to sign in, join rooms, and
render without a forced rename. A grandfathered nickname is checked against the
12-code-point limit only when its owner actively submits a nickname update; an
unchanged session read is never treated as a new write.

New and changed nicknames cannot contain Unicode whitespace and are globally
unique by a server-owned comparison key (`NFKC -> fixed-locale lowercase ->
NFC`). The original NFC display form and casing are retained. A partial unique
D1 index, rather than an availability check in the browser, serializes competing
claims. Deleting an account releases its nickname. The product does not expose a
public nickname directory or availability endpoint, and neither a nickname nor
its comparison key is authority evidence.

Nickname moderation is intentionally narrower than chat moderation. New and
changed account nicknames reject only standalone whole-word matches generated
from the English `EN.words` source, including that source's variations.
Korean-source terms and their romanized variants are not evaluated for account
nicknames, and substrings inside otherwise valid words remain allowed. Chat
messages continue to use the separate, broader Korean-substring and English-word
policy. Client and server must consume the same generated `accountEnglish`
pattern; account writes must not reuse the broader chat pattern.

Length alone is not a moderation violation. The service therefore does not
force a warning modal on grandfathered accounts and does not expose an account
nickname directory in the admin dashboard. If operator-requested renames are
introduced later, they require a purpose-built moderation state, a narrowly
scoped account lookup/audit trail, and a corresponding privacy-policy update;
the current schema has no such flag.

### 3. Account data boundary

Account records and sessions use a dedicated `MUSIXQUARE_AUTH_DB`, separate from
operator metrics and room-registry data. The canonical tables contain:

```text
accounts: random account ID, pseudonymous Google subject digest, nickname,
          profile state, status, timestamps
sessions: session-token digest, account ID, issued/seen/expiry timestamps
deleted sessions: session-token digest, deleted account ID, deletion/expiry timestamps
```

The App Worker authenticates the account session and, where a room service needs
identity, issues a short-lived room/audience-bound assertion. Downstream Workers
must reject browser-supplied identity headers unless the App Worker has stripped
and replaced them. No browser-provided account ID is an authorization input.
For ten minutes after account deletion, a bounded deleted-session digest can
mint only a room/peer/role-bound deletion-audience assertion. Its signature
purpose is separate from attachment assertions, and signaling accepts account
identity deletion only through that verifier. Logout and logout-all do not
create this deletion handoff state.

### 4. Login UI

The existing header role badge becomes the account entry point:

- anonymous: `LOGIN`;
- authenticated: the account nickname, ellipsized within the available header;
- connection health remains represented by the existing color/status treatment,
  not by replacing the account label.

The login dialog uses the established MUSIXQUARE dialog design and links to the
real privacy and terms pages. Anonymous nickname-change actions open the login
dialog. Authenticated nickname changes update the account and then project the
new name to active rooms.

### 5. Authority storage lifetime

The same capability model is used by both room types, but its canonical storage
lifetime differs.

| Identity / room                    | Authority storage                      | Removal                                          |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------ |
| anonymous, ordinary                | host RAM and presence lease            | last device/presence leaves                      |
| account, ordinary                  | host RAM keyed by verified room member | room closes or account deletion is proven        |
| anonymous, PRO                     | room presence/session lease            | last device/presence expires                     |
| account, PRO member                | physical lease plus live member record | final room session or account deletion           |
| account, PRO owner/delegated admin | persistent room Durable Object record  | owner revoke, account deletion, or room deletion |

A transient WebSocket close is not a presence end. Anonymous grants survive the
existing reconnect grace and disappear only when the authoritative presence
lease expires or is explicitly closed.

Persistent PRO membership is distinct from a device's current proof of that
membership. Each authenticated physical PRO session receives a 120-second
server-owned identity lease and renews it every 40 seconds with a fresh,
room-bound App assertion; the client also reconciles after foreground/resume.
Renewal is valid only for the same account already attached to that exact room
session; it cannot create a member or reverse-index edge or advance a public room
revision. Explicit logout detaches immediately. Expiry anonymizes only that
physical session to a new `Peer N` while preserving transport, playback, the
persistent member, owner link, delegated capabilities, and other verified
devices. This bounds logout-all and remote revocation even when a tab misses
browser coordination, while a brief App/D1 outage receives only the unexpired
remainder as grace. A later valid assertion may reattach the device.

PRO ownership is never claimed merely by being the first logged-in visitor. An
existing owner credential or a recovery claim must explicitly link the initial
owner account. Recovery always requires a current verified account assertion;
the claim alone can never create an anonymous owner session. A missing, invalid,
conflicting, or capacity-blocked account leaves the claim unconsumed and the
existing owner unchanged. After that link, another device with the same verified
account can recover owner authority. The room PIN remains an independent
admission secret and is not bypassed by login.

### 6. Capabilities and product baselines

Capabilities are checked by the canonical authority for every browser/BOT
action. Hiding a button is not authorization. A Developer API credential is a
separate server-to-server principal: within its explicitly issued scopes it is
room-authoritative and does not inherit the permissions of a browser member.
Integrations must authenticate the human requester and confirm destructive
intent themselves, as specified by the public Developer API contract.

The internal model separates at least:

```text
media.add
playback.control
members.kick
chat.notice
room.configure       (owner only; queue/effect/destructive policy)
```

The user-facing `미디어 추가` toggle grants local/YouTube addition and the queue
commit required for that addition. Live system-audio publishing, deleting,
clearing, and reordering existing items, and changing room-wide effects remain
owner/ordinary-host operations in the first release. BOT commands inherit the
caller and must pass each generated action's capability; a delegated
administrator cannot use BOT to bypass an owner-only queue mutation or queue
mode change.

Ordinary guests retain their current no-control baseline. A second verified
device of the physical ordinary-room host's account shares the owner's
host-routed product controls (media/file add, queue editing, playback, effects,
queue mode, member removal, and chat-room controls). It remains a guest
transport: the room PIN, administrator grant editor, system-audio publisher,
coordinator eligibility, host-only inbound trust, and teardown stay bound to
the physical host browser. Logging out or losing the verified room identity on
that second device removes the projection immediately; visually confusable
nicknames are never authority evidence. Under PRO member-authority projection `1`, an
ordinary PRO member receives no playback capability. The owner always retains
`playback.control`; a delegated PRO administrator receives it only when the
owner explicitly enables the playback toggle, and revoking that toggle removes
the capability. Other delegated capabilities remain independently selected by
the owner.

An account-wide kick removes every active device for the target room member and
invalidates stale room tickets. An administrator may not kick the owner or
another administrator unless an explicit future policy says otherwise.

### 7. Administrator and device views

The UI renders two projections from server/host-owned room member data:

1. `관리자 N명` above the device list. The owner/host is always first with a
   yellow crown and is included in `N`, so an owner-only room displays one
   administrator rather than zero. Delegated administrators use gray crowns.
   Authenticated PRO administrators remain visible while offline; anonymous
   administrators do not.
2. `연결된 기기 N대`, grouped by room member. The row contains the stable member
   number, nickname, optional device count, current-identity highlight, grant
   action for eligible non-admins, and account-wide kick. Revoke and capability
   settings live only in the administrator section.

Granting moves authority management to the administrator section; it does not
add a second revoke button to the connected row.

### 8. Chat identity

Display text is not an identity key. Chat frames carry a stable message ID and
a room member pseudonym in addition to their device transport source.

- Messages sent from several devices of one account group as one person.
- Account and room-member IDs, never display text, determine grouping; legacy or
  externally introduced duplicate labels cannot merge identities.
- Join is emitted when a room member's first device enters; leave is emitted
  when the last device leaves.
- Message deduplication remains message/device aware so simultaneous messages
  from two devices cannot collide.

### 9. Ordinary and PRO authority remain different

This ADR does not make ordinary rooms server-controlled. An ordinary browser
host remains the playback coordinator, canonical writer, credential owner, and
room-lifetime authority. Other verified devices of that host account can issue
bounded product requests through it, but never receive coordinator transport or
host-only inbound trust. Its verified member/grant directory lives only for
that room. The signaling service may authenticate and attest account
membership, but it does not become the playback manager.

PRO remains coordinator-free and server-authoritative. Its Durable Object owns
persistent member grants and capability enforcement; signaling continues to own
physical sockets and delivery.

## Compatibility and release sequence

PRO snapshots and signaling tickets use strict schemas. A Worker that emits new
fields before a compatible client exists can make an old app reject the entire
room. The production rollout therefore has two explicit stages.

### Stage 1: compatibility baseline

- Deploy account-aware App, signaling, and PRO code with `MUSIXQUARE_AUTH_DB`
  unbound, login unconfigured, and both
  `PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION=0` and
  `PRO_ROOM_MEMBER_AUTHORITY_PROJECTION=0`.
- Publish the dual-schema client under service-worker cache `v203`.
- Verify anonymous ordinary/PRO behavior and record the matched App, signaling,
  and PRO Worker versions. This matched checkpoint, not pre-account code, is the
  rollback floor for the feature.

The repository intentionally checks in both projection flags as `0` for this
stage. That is a rollout checkpoint, not the final authorization policy. PRO
rooms temporarily retain the former equal-member compatibility behavior,
including its shared-playback baseline, while cached clients converge.

### Stage 2: account activation

1. Create and migrate the dedicated auth D1 database and bind it to App.
2. Configure the exact Google OAuth callback and all independent account,
   standard-room assertion, and PRO-room assertion secrets.
3. Change both PRO projection flags to `1` in the same reviewed release; do not
   leave production indefinitely in a one-flag state.
4. Deploy PRO first, signaling second, and App/static last.
5. Verify login/nickname, ordinary and PRO multi-device grouping, persistent
   delegation/offline revoke, account-wide kick, per-capability allow/deny,
   physical-session lease expiry/reattach, and account deletion before widening
   access.

The deletion and public-copy gates are implemented, but they remain activation
checks: the Privacy Policy, Terms, FAQ, login dialog, and every maintained locale
must describe optional login and bounded account data; deletion must enumerate
the account-to-PRO-room reverse index, purge awake and sleeping room objects,
retry partial failure, and install a stale-assertion tombstone before removing
the active account. Already-shared collaborative media continues under the
room's normal retention policy.

At every stage, account-service failure falls back to anonymous identity. It
must not terminate an established ordinary room or make a PRO room inaccessible
to a valid PIN holder.

### Rollback floor

After Stage 2 has written account members, grants, reverse edges, or deletion
tombstones, never roll App, PRO, signaling, or cached clients below the recorded
Stage-1 account-aware checkpoint. To withdraw Stage 2, hide/disable login, set
both PRO projection flags back to `0`, and if necessary redeploy the matched
Stage-1 Workers. Retain the auth D1 binding/schema, reverse index, room
tombstones, and PRO data so cleanup remains possible. Removing an OAuth/session
secret may make the service report `configured:false`; deleting D1 or rotating
the subject pepper is not an application rollback.

Projection `0` restores the historical PIN-admitted equal-member policy,
including playback control for ordinary members. If an incident cannot safely
tolerate that temporary authority expansion, put PRO entry into maintenance
rather than rolling below the compatibility floor.

## Required verification

- OAuth state/nonce/PKCE/signature/audience/issuer/expiry and replay tests.
- Session rotation, CSRF, logout, logout-all, account deletion, and nickname
  normalization tests.
- Account deletion cleanup/tombstone tests across multiple awake and sleeping
  PRO rooms, including partial failure, retry, and stale-write rejection.
- One account on three devices without socket takeover; one join and one final
  leave event; stable display number and device count.
- Anonymous and authenticated authority lifetimes for both room types.
- PRO identity-lease renewal, cross-account rejection, background reattachment,
  and per-device anonymous downgrade without playback or presence loss.
- Offline PRO administrator revoke and owner-account bootstrap/recovery.
- Account-wide kick, stale-ticket rejection, and owner/admin target protection.
- Per-capability allow/deny tests for UI, BOT, Developer API, upload, queue,
  playback, effects, kick, announcement, and system audio.
- Chat grouping/deduplication for one account across devices, plus defensive
  handling of duplicate display labels introduced by legacy or corrupted data.
- New and cached-client compatibility during the additive deployment sequence.

## Rejected alternatives

### Require login before joining

Rejected. It adds a high-friction admission barrier and turns an identity
outage into a playback outage without being necessary for anonymous listening.

### Reuse Google email as the participant ID

Rejected. Email is personal data, can change, would leak to peers, and would
make every device compete for one transport identity.

### Persist every ordinary-room grant in D1

Rejected. Ordinary rooms are intentionally ephemeral. Their authenticated
grants survive reconnect only while the host-owned room exists and disappear
with that room.

### Keep all PRO participants as full administrators

Rejected for the account-aware product. Ordinary PRO members are listeners by
default. Playback, persistent media, BOT, kick, and announcement authority must
be explicitly delegated and revocable by the room owner; the owner always
retains playback control.
