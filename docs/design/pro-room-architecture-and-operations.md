# ADR and Runbook: Persistent PRO Rooms

- **Status:** Accepted operations baseline, amended by
  `pro-room-server-authority.md`
- **Decision date:** 2026-07-16
- **Last repository contract review:** 2026-08-19
- **Applies to:** the reserved `0xxxxx` namespace, the built-in `000000` launch
  canary, the PRO control plane, dedicated PRO signaling, and persistent PRO
  media

## Context

Normal MUSIXQUARE rooms are temporary sessions. A PRO room is a stable place
for a cafe, routine listener, or invited group: its URL and QR code do not
change, its authoritative playlist survives an empty room, and it resumes from
the last server-owned playback anchor.

PRO entitlement remains operator-controlled. It can be issued directly through
the Access-protected MUSIXQUARE admin screen or through a one-time voucher from
an operator-run campaign. Voucher redemption allocates a pre-registered PRO
room to a verified account; there is no paid plan, public checkout, or
subscription.

## Decision

The registry seeds one launch canary:

| Code     | Purpose                | Derived bootstrap value |
| -------- | ---------------------- | ----------------------- |
| `000000` | Built-in launch canary | `00000000`              |

Its natural invite URL is `https://musixquare.com/000000`. A six-digit
`roomCode` is a reusable public
address, not a secret, credential, or immutable room identity. Every
registration resolves that address to an immutable non-negative
`roomGeneration`. Existing rooms are generation `0`; a manually re-registered
code advances to a fresh generation and never revives the deleted incarnation.

| Component                                | Responsibility                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| App route                                | Detect a leading-zero PRO code, collect PIN/activation input, render playback                            |
| PRO Worker                               | Activation, auth, queue, canonical timeline, presence, quota, and signed R2                              |
| One Durable Object per room incarnation  | Sole serialized manager for one `(roomCode, roomGeneration)` and its state                               |
| Signaling Worker PRO path                | Own hibernatable role-neutral sockets, clock/chat/event fan-out, and targeted system-audio SDP/ICE relay |
| Private `musixquare-pro-media` R2 bucket | Persistent encoded source files; never a public bucket                                                   |
| Browser                                  | RAM-only transfer, decode, preload, and playback working set                                             |
| Admin D1 registry                        | Bounded operator index of registered codes, labels, and activation state                                 |
| App-to-PRO cross-script DO binding       | Provision a room and issue a claim without a public admin service endpoint                               |
| App-to-PRO service binding               | Same-origin `/api/pro-room/*` browser facade over the public PRO router                                  |

The regular signaling path reserves the complete `0xxxxx` namespace before
Durable Object lookup. `000000` is seeded in the admin registry; an operator may
register another six-digit `0xxxxx` code. Registration writes
an idempotent provision bit into that room's Durable Object through a
cross-script binding. An unprovisioned room rejects bootstrap, activation, and
all authenticated APIs. No leading-zero code may ever fall through to a normal
first-come host room.

Browsers use the app Worker's same-origin `/api/pro-room/*` facade. The facade
strips only that prefix and calls the PRO Worker's public router through a
service binding, so origin checks, front-door provisioning checks, IP rate
limits, path limits, and Durable Object routing stay centralized in the PRO
Worker. The browser-facing `pro.musixquare.com` custom domain is retired; the
service binding is the only production ingress for this Worker. Health checks
use `/api/pro-room/health` on the app origin. Facade cookies use host-only
`__Secure-` names and a room-specific Path; the facade maps them to the
backend's `__Host-` names only for the bound request. This prevents admin and
unrelated-room cookies from crossing the service boundary or accumulating on
ordinary app requests.

The public PRO front door cold-loads a bounded map of `registered` D1 rows and
their current `room_generation`, including the launch canary, and replaces
that cache on a five-second refresh. Unknown-code probes are rejected before
Durable Object lookup, preventing namespace scans from creating one object per
guessed code. A bound registry fails closed when it cannot refresh; local test
environments without D1 retain only the launch-canary default at generation
`0`. Replacing rather than extending the cache is essential: a suspended or
permanently deleted code must disappear from the front door even when it is
`000000`.

Every generation, including generation `0`, uses an explicit incarnation name:
`{roomCode}:generation:{roomGeneration}` for the PRO Durable Object and
`room:{roomCode}:generation:{roomGeneration}` for signaling. Its media prefix is
`pro-room-incarnations/{roomCode}/generation-{roomGeneration}/`. The registry
row is only the current public-address pointer; immutable
`mxqr_pro_room_generation_history` rows retain completed incarnation
tombstones. A stale object, alarm, repair sweep, or registry update must compare
both code and generation and is never allowed to mutate a later pointer.

Admin registration is an explicit two-phase reconciliation. A new code first
records generation `0` as `provisioning`. A decommissioned code may be advanced
only by an authenticated administrator, only after the current registry row is
`decommissioned`, and only when that exact generation has an immutable
completion-history row. There is no automatic re-registration. D1 advances the
generation and records `provisioning` atomically, the cross-script binding
idempotently persists that exact incarnation's provision bit, and only then may
D1 expose `registered`. A failed call leaves a retryable provisioning row
rather than a false success. Repeating the same registration self-heals that
same generation; it never allocates another one. Concurrent registrations are
serialized by D1 compare-and-swap predicates. The 1,000-row admission limit
counts only non-`decommissioned` registry rows, while immutable generation
history is stored separately and therefore cannot exhaust lifetime capacity.
An append-only allocation ledger records every `(roomCode, roomGeneration)`,
including active and in-progress incarnations. Registry pointers cannot be
deleted or renamed, and a missing pointer cannot silently recreate generation
`0` while either allocation or history evidence remains.
The singleton `mxqr_pro_room_generation_cutover` must be `ready` for the exact
deployed release SHA before a decommissioned code can advance. A full release
temporarily fences it as `disabled` until every generation-aware Worker, live
smoke, and ownership check succeeds. Missing, malformed, stale, or unavailable
cutover state fails closed. This global release marker proves protocol compatibility only;
it never replaces the per-incarnation deletion evidence, tombstones, zero-key
check, and empty-prefix verification required before re-registration.

Admin registration and direct admin activation-link issuance write a bounded
operator-audit event containing only a session-scoped pseudonymous actor,
action/result, room code, immutable room generation, and timestamp. PINs,
claims, and activation URLs are forbidden in both the registry and operator
audit table. If the direct issuance audit write fails, the admin endpoint
discards the just-issued URL and returns an error; retrying rotates
`activationClaimGeneration` again, so no unaudited admin link can later become
the current credential. Operator-run voucher issuance and redemption instead
use the retained grant ledger and append-only redemption audit. The subsequent
account-bound activation handoff does not claim a separate admin-issuance audit.

### Permanent room deletion

The admin dashboard exposes permanent deletion in a separate danger zone. It
requires the operator to enter the exact six-digit room code in a modal; the
server independently verifies that confirmation and a UUID request ID. This is
not an extension of suspend. Suspend preserves the playlist and media, while
permanent deletion is an irreversible, idempotent decommission protocol.

The app records the operator audit first, then asks the exact room incarnation's
Durable Object to durably enter `decommissioning`, and only after that
acknowledgement updates the D1 display registry with a code-and-generation
compare-and-swap. This DO-first order guarantees that a cross-script failure
cannot leave a closed-looking registry row without an alarm that owns the
cleanup. That transition immediately sets `provisioned=false` for the exact
generation, invalidates every browser session and owner credential, removes
PIN, playlist, playback, presence, effects, media ledgers, recovery nonces, and
Developer API commands, closes that generation's signaling sockets, and
deletes that generation's Developer API keys, API audit rows, and rate-limit
ledger. A permanent `(roomCode, roomGeneration)` tombstone in the Developer API
database blocks late key or audit inserts, and the generation-scoped limiter
retains its own authorization tombstone. Existing browser cookies may remain as
inert strings on offline devices, but their server-side credentials no longer
exist.

Persistent media is deleted by repeatedly listing and removing every R2 object
under the exact incarnation prefix:
`pro-room-incarnations/{roomCode}/generation-{roomGeneration}/`. Individual
asset ledgers are not trusted as a complete inventory. Reservations, object
keys, presigned PUTs, and required upload metadata all bind the same
generation. The service performs an immediate sweep, waits until every
previously issued presigned PUT or reservation has expired, and then requires
that prefix to remain continuously empty for one hour. It rechecks every
minute; any late object is deleted and restarts that quiet window. R2,
signaling, Developer API, or registry failures also restart the window and
leave the incarnation fail-closed in `decommissioning`. The admin endpoint
therefore returns `202` until this final safety window completes. A
decommissioned incarnation tombstone keeps a daily repair sweep afterward. A
late generation-`N` PUT can land only in generation `N`'s prefix, where that
sweep removes it; it cannot create or overwrite an object in generation
`N+1`.

Completion scrubs the registry label and records `decommissioned`. A minimal
PRO-state tombstone, signaling tombstone, Developer API tombstone, limiter
tombstone, and immutable D1 history row retain only the room code, generation,
decommission timing/idempotency metadata, and non-user empty schema defaults.
These tombstones permanently block only the deleted incarnation. The public
number may later be manually re-registered, but every old activation/recovery
claim, browser session, account assertion or reverse edge, WebSocket ticket,
Developer API key/command, upload reservation, presigned URL, R2 path, and
rate-limit principal remains bound to the old generation. A missing or
mismatched generation fails closed; room-code equality alone never grants
authority. Operator audit events remain under the existing 365-day retention
policy; all incarnation-scoped Developer API audit detail is removed with the
incarnation.

Before release, verify that the admin, auth, and Developer API databases match
their canonical generation-aware schemas. For target `all`, deploy the PRO
Worker first, then remote-share, signaling, the Developer API facade/API, and
the App Worker last. The checked-in all-workers command satisfies those
dependency edges. The PRO Worker owns the shared service-control object as well
as cross-script bindings to signaling and the room-scoped Developer API limiter,
so its alarms and atomic admission decisions exist before any consumer. Deploying
the app first would expose a re-registration action whose cleanup and
generation-aware authorization dependencies are not ready.
The authorization boundary is irreversible: a concurrent administrator may
create a later generation whenever the release marker is `ready`. Never roll
any Worker below the matched generation-aware release; forward-fix or restore a
matched provider data/code checkpoint.

### Authorization model

- Public bootstrap returns only `activation_required`, `pin_required`, or
  `suspended`. It never issues or returns an activation claim.
- An owner activation claim is issued either from the Access-protected admin
  screen, from the generation-`0` emergency offline CLI, or as an account-bound
  setup handoff after a verified account redeems an operator-run voucher. It is
  scoped to one room, signed with `PRO_ROOM_ACTIVATION_SECRET`, and delivered
  only in the URL fragment `#pro-claim=...`. It expires within fifteen minutes.
  Issuance atomically advances a room-local `activationClaimGeneration`, so
  issuing again immediately invalidates every older unredeemed activation link.
  Activation consumes that claim counter by moving the room out of
  `unactivated` state. It is independent of immutable `roomGeneration`.
- A separate short-lived, one-time `#pro-recovery=...` claim restores ownership
  after browser data or the owner cookie is lost. It is issued only for an
  active room through an Access-protected, admin-session-authenticated endpoint.
  Redemption requires a current verified MUSIXQUARE account assertion; the
  bearer claim alone cannot create an anonymous owner. Recovery revokes the
  previous owner credential without changing the room's controller sessions or
  data.
- Activation requires the claim and a new eight-digit PIN. The client derives
  the historical bootstrap value from the room code and supplies it
  automatically; the user does not type it and operators must not describe it
  as an independent second factor. The activation URL is the sensitive owner
  bearer until it expires or is superseded. The first synchronous same-origin
  bootstrap scrubs the fragment before any
  third-party analytics can run. It retains the value only in a non-enumerable,
  one-use in-memory closure; the eager app module consumes that closure before
  Cloudflare Analytics is loaded. Scrub or handoff failure is fail-closed.
  While that exact valid claim is still replay-safe, a document-scoped RAM-only
  reload guard may reconstruct one canonical claim fragment only inside an
  app-owned hard-reload callback; a failed navigation immediately scrubs it
  again. The guard never writes the claim to query parameters, Web Storage,
  cookies, DOM, or an enumerable global. Activation, recovery, and transfer
  mutation calls fence reloads until their outcome is known. Only a tagged lazy
  room-gate failure, which occurs before the mutation, re-enables restoration;
  success, a definitive refusal, or user exit discards the guard before any
  queued reload continues.
- The owner credential manages PIN/recovery security and owner-visible room
  configuration. Access-protected operators manage suspension and permanent
  deletion. A separate member session controls live-room actions. Linking the
  verified owner account lets another physical session of that account recover
  owner authority, but a room code, PIN, or first-arrival position never creates
  ownership.
- A PIN-admitted ordinary PRO member has
  no playback or mutation capability. The owner always retains playback
  control. A delegated administrator receives playback, media management,
  member removal, and chat-announcement capabilities only through their
  respective explicit toggles; disabling the playback toggle removes
  `playback.control`. Media management is one coherent queue capability: it
  permits persistent-media addition and deletion, queue reorder and clear, and
  shuffle/repeat mutations. Effects, PIN/recovery, and other room configuration
  remain owner-only. BOT commands
  are checked as the initiating room member and cannot bypass those capability
  boundaries. Developer API keys are instead independent room-authoritative
  principals within their issued scopes; integrations own requester identity
  and destructive-intent confirmation. An anonymous delegation is session-lived;
  a verified account delegation is persisted in the room until owner revocation
  or room deletion.
- Chat freeze is a moderation boundary rather than a fifth permission toggle.
  While frozen, ordinary members cannot post, but the owner and every current
  delegated `controller` session may still post regardless of which of the four
  granular toggles are enabled. This exception is intentionally enforced by
  the server-authoritative `chat.manage` check.
- Browser credentials are room-scoped, host-only, Secure, HttpOnly cookies, so
  multiple PRO rooms can stay signed in at the same time. Short-lived
  signaling tickets are bound to room, participant, presence incarnation,
  authoritative presence revision, room-control incarnation, and a per-session
  monotonic ticket sequence. They are consumed once, and the signaling Durable
  Object persists bounded participant and presence high-water marks so an older
  delayed ticket cannot replace a newer socket or re-enter after removal.
  Browsers offer the ticket in a non-selected WebSocket subprotocol token and
  the server selects only `mxqr.pro-signaling.v1`. The signaling edge and its
  Durable Object reject every URL search string and require exactly the stable
  marker followed by one `mxqr.ticket.*` token; there is no URL credential or
  refresh compatibility path.
  On 2026-08-15, the owner confirmed that the sole active PRO user was already
  on the current client and explicitly accepted immediate removal of the former
  URL-credential grace path. Cached clients using that retired transport are
  intentionally unsupported rather than kept alive by a delayed cutoff.
- Every successful browser entry owns a server-issued, RAM-only presence
  incarnation. Snapshot, heartbeat, signaling, PIN, playlist, playback, and
  media requests must present that tab-local participant/incarnation pair as
  well as the HttpOnly cookie. Explicit resume rotates the incarnation; a
  superseded tab receives `PRESENCE_SUPERSEDED` and tears down its local
  authority without learning or revoking the replacement tab's incarnation.
- Re-entering replaces only that participant's presence incarnation and
  signaling socket. It does not elect a manager, rebuild a browser star, or
  force unrelated participants to reconnect. Hard room security/lifecycle
  boundaries advance the room-control incarnation.

Optional Google account identity is additive to these room credentials. The
App Worker validates its host-only account session and may issue a short-lived,
room- and audience-bound assertion after stripping any browser-supplied
identity header. A PRO room exposes only a room-scoped member identifier and
nickname; the Google subject, email claim, global account ID, and account cookie
must never appear in public snapshots, signaling tickets, or peer messages.
Each physical device retains its own participant and presence incarnation. The
full identity/capability model is defined in the
[account authority ADR](account-identity-and-room-authority.md); production
provisioning is defined in the
[account authentication runbook](../account-auth-operations.md).

Account identity on a physical PRO session is a renewable server-owned lease,
not a property of the 30-day room cookie. A fresh App assertion grants 120
seconds; an active client re-proves it every 60 seconds and also reconciles after
foreground/resume. Explicit logout detaches immediately. Logout-all, account
revocation on another device, or a tab that can no longer prove the App account
cannot extend the lease, so account-only authority disappears from that physical
session within 120 seconds even if it misses the cross-tab event. A transient
App/D1 failure may use only the lease's remaining grace and never extends it.

Lease expiry demotes only that physical session to an anonymous `Peer N` member;
it does not disconnect playback, erase the account's persistent room member,
delegated capabilities, owner association, or affect the account's other valid
devices. A later valid assertion reattaches the device. The renewal endpoint can
renew only the exact account already attached to that room session, changes no
public revision, and does not create a new account-to-room reverse-index edge.

Persistent account-linked authority has a complete deletion boundary. Before an
account assertion can reach a provisioned PRO room, the App service records a
bounded account-to-room reverse edge. Account deletion enumerates those edges
and idempotently purges the account member, delegated authority, owner
association, presence, and room sessions from awake or sleeping room objects.
Every purge installs an expiring room tombstone longer than the assertion window
so a late pre-deletion assertion cannot restore the record. The App account and
reverse index are removed only after every room confirms cleanup; a partial
failure returns a retryable error and preserves the account/index. Media still
referenced by a collaborative playlist follows the room's normal R2 retention
rules rather than being deleted merely because one account is removed.

The two Durable Objects have deliberately different authority. The PRO room
object owns authenticated presence, the canonical queue/timeline, reducers,
transition cohorts, and READY state. The signaling room object owns browser
WebSockets and hibernatable socket attachments. A PRO mutation is accepted only
by the PRO object; it then asks signaling to deliver a bounded event to the
authoritative presence-incarnation target set. Chat and clock samples can
terminate at signaling because neither can replace canonical playback state.

### Live system-audio ownership

PRO system audio has one temporary **publisher**: the authenticated room owner
that currently holds the room's short-lived media lease and browser capture.
That source lease never grants playback authority or a manager role. The
Durable Object serializes acquisition so only one owner incarnation can prepare
or publish at a time. The private lease credential remains in the acquiring
browser and the Durable Object. Public room state contains only the exact owner,
generation, and one fenced publication descriptor. A 45-second preparing claim
bounds abandoned native-picker attempts. Once committed, the live lease has a
fixed two-hour deadline and cannot be extended by heartbeat.

The preferred PRO media path is `lan-direct-v1`. System audio is limited to four
active devices total, so the publisher opens at most three
`RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" })` routes and sends only targeted
offer/answer/ICE frames over the authenticated PRO WebSocket. A route passes
within five seconds only when browser statistics identify exactly one
unambiguous selected, succeeded `host`-to-`host` pair reached through a valid
UUID-shaped remote `.local` mDNS candidate. Candidate-bearing SDP is rejected;
the bounded trickle channel accepts only component-1 UDP host candidates with
that remote mDNS shape. Numeric remote candidates are never relayed or added,
even if they appear to share an RFC1918 `/24` or IPv6 private `/64`. Browsers
without usable mDNS host candidates therefore select SFU. Chromium may redact
the selected candidate address from statistics; that case passes only when the
selected remote foundation and port exactly match a strict mDNS candidate that
`addIceCandidate()` already accepted for the same live route and negotiation.
If every target passes,
the canonical descriptor is
`{ publicationId, transport: "lan-direct", protocolVersion: 1 }`:
the L/R audio packets then remain browser-to-browser and Cloudflare carries
**zero media packets** for that publication. Cloudflare is still the authority
and signaling plane; its PRO Durable Object owns the
lease/generation/publication state and its signaling Durable Object relays
fenced SDP/ICE to exactly one authenticated target socket.

Direct delivery is an all-participants invariant, not a per-listener
optimization. Each target is locally fenced by the pair
`(participantId, joinedAtMs)`. The server makes `joinedAtMs` increase
monotonically on explicit same-participant tab takeover, including two
takeovers in one clock millisecond; a changed value supersedes the old peer
connection, so proof from the replaced tab cannot satisfy the new target. The
signaling server independently fences the private presence incarnation and
current target socket.

If any initial target fails, the publisher starts the Cloudflare Realtime SFU
with the already allocated `publicationId`. If a participant arrives after
direct commit while the room remains within the four-device system-audio limit,
the publisher must prove another mDNS-local route to that exact target
incarnation. A timeout, an incompatible or late old client, a non-host or
non-UDP candidate pair, numeric/global/hidden/malformed or asymmetric address
evidence, missing or ambiguous ICE statistics, a replaced target incarnation,
or a live direct-route failure promotes the entire publication to SFU under
that same `publicationId`. Joining a fifth active device revokes the share
instead of attempting another route.

The Durable Object accepts only the exact same-publication `lan-direct` to SFU
mutation; SFU to direct, a different live publication ID, and mixed direct/SFU
delivery fail closed. The authenticated client reducer accepts that equal-rank
replacement only for the same `publicationId`; peer fan-out and every other
same-generation mutation remain state conflicts. As soon as canonical live
state is SFU, `system-audio.signal` authority is denied in both directions, so
stale direct offer/answer/candidate/close frames cannot continue under the
shared ID. Promotion is therefore one-way for the publication lifetime.

Host candidates have a deliberate privacy boundary. The authenticated signaling
relay carries only a small bounded set of component-1 UDP host candidates, and
the receiving browser adds only a valid UUID-shaped remote `.local` name. It
never adds a caller-selected numeric remote destination, so even a numerically
private address or apparently matching subnet cannot be used as locality proof.
Candidate-bearing SDP, a global or numeric peer, address hiding without the
strict UUID shape and ledger match, or a malformed hostname selects SFU. Guest-Wi-Fi client
isolation, VPN policy, an mDNS-incompatible browser, or an
enterprise firewall may
likewise prevent direct reachability. The product does not request TURN
credentials to force that path and instead promotes the whole publication to
SFU. Publisher exit, tab-incarnation replacement, lease expiry, or a fifth
active device atomically fences the old generation and ends the share.

The cost boundary is four active devices total. Acquisition is refused above
that count, and joining a fifth device ends an already-running share while the
room, playlist, chat, and ordinary playback remain active. System audio is
ephemeral: it is never persisted as a sleeping-room playback source and never
changes the PRO room's durable media quota.

### Persistent state and sleep

The Durable Object persists the canonical playlist, current queue occurrence,
playback anchor (including the exact YouTube playlist sub-item), revision
numbers, bounded sessions, room-control incarnation, media ledger, and compact
idempotency records. Persistence schema v2 keeps the non-playlist core under a
conservative 1.2 MiB value budget and stores each canonical playlist row under
its own key. The public playlist has a separate 3 MiB serialized budget beneath
the browser and Developer API 4 MiB response boundary. A v2 core record contains
only stable row order, so a large YouTube queue cannot prevent an R2 reservation
or completion record from being committed.

Browser/participant receipts and Developer API mutation receipts use separate
256-entry ledgers. Each live receipt is retained for its endpoint's full
idempotency window (normally 24 hours); saturation never evicts an unexpired
receipt. A new mutation instead fails closed with
`ROOM_STATE_CAPACITY_EXCEEDED` before its state can commit, while duplicate
retries of already accepted add, clear, media, and queue-mode operations remain
replayable. This deliberately favors exactly-once behavior over accepting more
than 256 distinct Developer API mutations inside one live window.

The v2 core and per-item playlist records are the only authoritative storage
layout. A missing v2 core represents a fresh room incarnation; the Worker does
not import a single-record predecessor or maintain a rollback shadow.

The first pure heartbeat after a quiet period persists the authoritative v2
core inline. If a second heartbeat arrives inside the following one-second
window, dense renewals are coalesced into one trailing core write. A solitary
participant therefore keeps the previous durability and cost behavior without
opening a timer, while a burst of participants avoids rewriting the same large
core for every request. Any join, leave, expiry, control-incarnation, authorization,
Developer API command, playback, queue, quota, or other full mutation remains
an immediate transaction and absorbs pending heartbeat durability. The prior
persisted liveness timestamp also forces an inline write near the 45-second
expiry boundary. Reusing an already-earlier Durable Object alarm avoids another
alarm write without delaying expiry.

Rollback must use a Worker that understands the v2 core and per-item playlist
layout. A pre-v2 Worker is never a routine code-only rollback target.

Heartbeat clients send the public room revisions they last applied. An
unchanged room returns only those revisions and `notModified`; any mismatch
returns a complete snapshot for recovery. A heartbeat without known revisions
also returns a complete snapshot so a newly opened or state-lost client can
recover. The former elected-browser coordinator protocol is unsupported.

Browser queue mutations use the compact snapshot endpoint. It sends stable row
order only when order changes and upserts only rows whose metadata/source
changed. Playback-anchor and metadata-only changes omit order entirely. There is
no full-snapshot mutation endpoint or mutation fallback. Public Developer API
routes use the same canonical v2 queue projection.

When the final participant leaves, the room becomes `sleeping` and freezes the
playing position at server time. If playback had been active, the first
returning participant causes the PRO object to create a wake PREPARE from that
position. The bounded cohort comes from authoritative active presence, not
from signaling-socket enumeration. All-ready commits immediately; otherwise a
persisted one-shot alarm decides the three-second deadline. There is no client
deadline nudge.

A participant joining after PREPARE cannot delay its cohort. It receives the
pending transition with its signaling-ticket response when applicable, or
catches up from the canonical snapshot. Catch-up prepares the exact R2 or
YouTube identity locally, then projects the non-ticking server anchor using the
best current signaling-clock estimate (with a receive-relative fallback while
calibration converges); it does not restart the room-wide transition.

On a confirmed non-bfcache `pagehide`, the browser sends one small credentialed
`text/plain` keepalive mutation that removes that exact participant incarnation
from presence. The browser's playback observation is accepted only as legacy
request shape and never replaces the server's canonical anchor. The request
deliberately keeps the room-scoped cookie
session alive so reopening the fixed link can resume without an avoidable PIN
prompt. An explicit in-product leave remains a different action: it releases
presence and revokes the exact current server session.

Explicit leave invalidates the local PRO authority, playlist hooks, transport,
and asynchronous-operation lease before its first await. The old room's atomic
presence close and server-session revocation then finish from captured room
context. The fenced revocation deliberately returns no cookie
tombstone: its response may arrive after another tab has installed a newer
same-name cookie, while the old browser token is harmless once its exact
server-side record is gone. A slow cleanup therefore cannot intercept an
ordinary room or another PRO room opened immediately afterward.

Every browser is an observation source, never the playback clock. An ENDED or
unavailable report captures its exact accepted playback revision before client
command serialization and is not rebased. The server rejects a mismatched room
incarnation, presence incarnation, queue occurrence, media kind, YouTube
sub-item, or playback revision. ENDED additionally requires committed playing
state. Finite media must put both the observed cursor and the server-projected
cursor within the bounded end tolerance; unknown-duration YouTube media must
have played for the minimum residency and remain close to the server timeline.
The first valid report advances through the same queue/repeat/shuffle reducer
used by UI, BOT, and Developer API commands.

YouTube entries persist their canonical IDs. File entries persist an opaque PRO
asset identity and metadata; an internal R2 object key or signed URL must never
enter the playlist snapshot.

The first append into an empty, idle room commits the playlist row without
smuggling a playback mutation through the queue endpoint. If the accepted
snapshot is still empty-selection/idle at the exact observed playback revision,
the app follows with one fenced server `select` command. That command creates
the normal PREPARE barrier and the server emits the authoritative playback
state; no browser performs a room-wide relay. A concurrent selection or newer
playback revision prevents this convenience action from rebasing over the
winner. If the follow-up selection fails, the already-canonical row (and its R2
reference) remains in the queue rather than becoming an upload orphan.

A playlist-only YouTube URL in a PRO room is resolved through the guarded App
Worker manifest endpoint before it is persisted. The immutable ordered video ID
manifest lets UI, BOT, Developer API, ENDED, next, and previous all use the same
server reducer without borrowing the hidden YouTube iframe or interrupting the
currently playing item. Ordinary rooms retain their existing lazy indexing
path.

### Storage and quota invariants

- One room has a hard **1 GiB** quota.
- One file has a hard **200 MiB** limit.
- The per-file limit is an intentional browser playback bound, not another
  storage entitlement. PRO retains its established server-authoritative
  playback path and does not inherit ordinary-room transfer experiments without
  a separate review.
- The **200 MiB** limit remains in force because playback can still download an
  encoded object and decode a full `AudioBuffer`; do not raise it until device
  and soak evidence justify doing so.
- Every reservation maintains `usedBytes + reservedBytes <= 1 GiB` inside the
  serialized room object.
- Every generation uses
  `pro-room-incarnations/{roomCode}/generation-{roomGeneration}/`. Never place
  objects outside that exact incarnation prefix or move them between
  generations.
- The server chooses every object key. The client receives only short-lived
  presigned PUT/GET URLs for the private bucket. Upload URLs target disposable
  staging keys; completion verifies the staging object, streams it to a fresh
  immutable final key, and retains cleanup state until the reusable staging URL
  has expired.
- Upload completion becomes `ready` only after R2 HEAD matches the reserved
  byte count, media type, room, generation, asset ID, version, and optional
  client-supplied SHA-256 metadata. The current R2 promotion path does not
  independently hash the uploaded body; byte-for-byte content verification is
  a future hardening item, not a property operators should assume today.
- A completed asset that is not appended to the playlist receives a 15-minute
  garbage-collection deadline. Any playlist reference clears it. Alarm cleanup
  rechecks all references and deletes R2 first; used quota is released only
  after deletion succeeds. An R2 failure postpones cleanup without weakening
  the quota ledger.
- PRO media uses its own bucket. Do not apply the temporary remote-share
  bucket's short lifecycle rule to it.

### Browser storage remains RAM-only

Persistent R2 is server-side source storage, not a browser-local playback
cache. PRO room playback follows the accepted
[browser media storage policy](browser-media-storage-policy.md): media payloads,
preloads, decoded PCM, and partially received files remain RAM-only. Do not add
OPFS or IndexedDB media bodies as part of PRO rollout. Any OPFS experiment must
pass that ADR's separate device, soak, reclamation, and rollback gates.

Any future PRO bounded path must own a manager separate from the standard-room
playback controller. PREPARE may resolve and prime an inaudible candidate,
while only a matching server COMMIT may publish playback ownership or make it
audible. Pause, resume, seek, stop, natural end, room epoch, and playback
revision remain server-authoritative. A stale candidate, signed URL, range
response, or incarnation must never acquire a newer room's playback authority.

## Initial Cloudflare Provisioning

Perform this section once, from an authenticated operator workstation. These
commands mutate Cloudflare and are intentionally not part of automated tests.

1. Apply the shared admin D1 schema before any Worker can expose registration:

   ```powershell
   npm run wrangler -- d1 execute musixquare-admin-metrics --remote --file cloudflare/admin-metrics.schema.sql
   ```

2. Create the dedicated private bucket if it does not already exist:

   ```powershell
   npm run wrangler -- r2 bucket create musixquare-pro-media --config cloudflare/wrangler.pro-room.toml
   ```

3. Apply the checked-in browser CORS rule:

   ```powershell
   npm run wrangler -- r2 bucket cors set musixquare-pro-media --file cloudflare/r2-cors.pro-media.json --config cloudflare/wrangler.pro-room.toml
   ```

4. Confirm the bucket has no lifecycle rule copied from
   `musixquare-remote-share`.

5. Provision the Durable Object class/migrations and service-binding backend by
   deploying the PRO Worker only after all secrets below are present. The PRO
   Worker has no browser-facing custom domain; production browser ingress stays
   on the App Worker facade.

6. Confirm the App Worker has the cross-script Durable Object binding
   `PRO_ROOM_ADMIN_ROOMS` targeting class `MusixquareProRoom` in script
   `musixquare-pro-room`. It is the only admin-to-PRO path; do not add a public
   internal endpoint or shared bearer secret.

## Secrets

Secret values must come from the approved password/secret manager. Never put a
value in source, a committed `.env`, a shell argument, a URL query, an issue, or
a deployment message.

| Binding                                  | Scope and rotation consequence                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `PRO_ROOM_ACTIVATION_SECRET`             | PRO Worker plus the offline issuer. Rotation invalidates unredeemed claims.                   |
| `PRO_ROOM_PIN_PEPPER`                    | PRO Worker only. Rotation invalidates existing PIN hashes without migration.                  |
| `PRO_ROOM_SESSION_SECRET`                | PRO Worker only. Rotation signs out member and owner browser credentials.                     |
| `PRO_ROOM_RATE_LIMIT_SECRET`             | PRO Worker only. Rotation resets pseudonymous rate-limit buckets.                             |
| `PRO_SIGNALING_SECRET`                   | Same value in PRO and signaling Workers; rotate/deploy both together.                         |
| `MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET` | Same independent value in App and PRO Workers; signs short-lived PRO room/account assertions. |
| `R2_ACCOUNT_ID`                          | Public account identifier used by the presigner and exact client host allowlist.              |
| `R2_ACCESS_KEY_ID`                       | R2 S3 credential restricted to the dedicated PRO media bucket.                                |
| `R2_SECRET_ACCESS_KEY`                   | Paired R2 S3 secret; rotation interrupts new presigned URLs until redeployed.                 |

The first six HMAC/signing/pepper values in this table must each be random and
at least 32 characters. Keep the two explicitly named cross-Worker pairs
identical only on their named Workers, and expose the activation secret to the
offline issuer exactly as the table states; all other purposes remain
independent. Provider-issued R2 identifiers and credentials retain their
provider-defined formats.

Set Worker secrets through Wrangler's interactive prompt, for example:

```powershell
npm run wrangler -- secret put PRO_ROOM_ACTIVATION_SECRET --config cloudflare/wrangler.pro-room.toml
npm run wrangler -- secret put PRO_ROOM_PIN_PEPPER --config cloudflare/wrangler.pro-room.toml
npm run wrangler -- secret put PRO_ROOM_SESSION_SECRET --config cloudflare/wrangler.pro-room.toml
npm run wrangler -- secret put PRO_ROOM_RATE_LIMIT_SECRET --config cloudflare/wrangler.pro-room.toml
npm run wrangler -- secret put PRO_SIGNALING_SECRET --config cloudflare/wrangler.pro-room.toml
npm run wrangler -- secret put MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET --config cloudflare/wrangler.pro-room.toml
npm run wrangler -- secret put R2_ACCOUNT_ID --config cloudflare/wrangler.pro-room.toml
npm run wrangler -- secret put R2_ACCESS_KEY_ID --config cloudflare/wrangler.pro-room.toml
npm run wrangler -- secret put R2_SECRET_ACCESS_KEY --config cloudflare/wrangler.pro-room.toml
```

Set the identical `PRO_SIGNALING_SECRET` on the signaling Worker as a separate
interactive operation. Do not rotate that shared value one Worker at a time
while rooms are active.

## Pre-deployment Checks

Run all checks before the first external mutation:

```powershell
corepack npm ci
npm run check:workers
npm exec vitest run -- src/pro-room/__tests__
npm run build:checked
```

Also verify:

- the admin D1 registry seeds `000000`, and registration accepts
  only a textual room code matching `^0\d{5}$`;
- the admin, auth, and Developer API databases match their tracked canonical
  schemas, and every room-related row carries an explicit generation;
- every current or historical incarnation has an immutable allocation-ledger
  row, and attempts to delete/rename a registry pointer, mutate allocation
  evidence, or recreate generation `0` behind missing evidence fail closed;
- re-registration rejects `registered`, `provisioning`, `suspended`, and
  `decommissioning` rows, and permits only a manually selected
  `decommissioned` generation with immutable completion history;
- old-generation sessions, claims, WebSocket tickets, Developer API keys,
  account assertions, upload reservations, presigned PUTs, and limiter
  principals are rejected against a newly registered generation;
- a late PUT to an old generation lands only in its exact incarnation prefix,
  is removed by its daily repair sweep, and cannot be observed by the new
  generation;
- signaling reserves all `0xxxxx` codes from ordinary rooms and accepts the PRO
  path only with a valid PRO Worker-issued signed ticket offered after the
  stable `mxqr.pro-signaling.v1` WebSocket subprotocol marker;
- `cloudflare/pro-system-audio-contract-version.txt` contains exactly
  `lan-direct-v1`, and the PRO, signaling, and app runtime inventories all
  include that marker;
- the `system-audio-signal` channel relays only exact, generation/publication/
  negotiation-fenced offer, answer, candidate, or close payloads to one current
  non-self target socket; stale or missing incarnations fail closed;
- live `system-audio-signal` authority exists only while the canonical
  publication is `lan-direct`; after same-ID SFU promotion, both signal
  directions fail closed;
- the R2 bucket name is `musixquare-pro-media` in Wrangler, CORS, and the
  presigner configuration;
- production CORS includes `https://musixquare.com` and
  `https://www.musixquare.com`; and
- the account Privacy Policy, Terms, FAQ, Google consent-screen links, and
  deletion-boundary copy match the deployed account behavior;
- account deletion exercises the reverse-index purge, sleeping-room retry, and
  stale-assertion tombstone described above;
- the retired PRO account projection flags are absent; and
- no test/debug bypass or secret value appears in the production diff.

## Deployment Order

Production databases must already match the tracked canonical schemas before a
release starts. The immutable `*.migration.sql` and `*.rollback.sql` files and
the migration manifest are audit history, not launch-time upgrade steps.

Every full release proves that the immutable `floor_release_sha` commit is
available and is an ancestor of the candidate commit. It then fences room-code
reuse by changing the cutover marker from `ready` to `disabled`, deploys the
matched dependency set, runs the final health, smoke, and ownership checks, and
restores `ready` with the exact new release SHA. A failed release leaves the
marker disabled without erasing the floor and requires forward repair whenever
a generation-sensitive rollback cannot be proven safe.

Use this Worker dependency order so the public app never advertises a
dependency that is absent:

1. PRO Worker and Durable Object/R2 bindings, including the shared
   service-control owner and authority endpoint used by signaling.
2. Remote-share Worker, after its atomic service-control owner is available.
3. Signaling Worker, reserving `0xxxxx` before the App can advertise PRO.
4. Developer API facade and public API Workers.
5. App Worker, same-origin PRO service binding, admin control plane, and static
   build last.

Room-effects reads have one launch contract: callers must send
`X-MXQR-Effects-Version: 2`, and the response contains all five effect groups,
including `virtualTreble`, in schema version 2. Effects live in the canonical v2
room core; there is no version 1 projection or sidecar rollback path. Keep the
App/static and PRO Worker on a matched version that implements this contract.

Production releases use the repository's `Production Release` GitHub workflow
for the exact reviewed `main` commit. Select `all` for a cross-Worker contract
change or `pro-room` for an isolated PRO-only change, and retain the
recorded deployment IDs. Every target reuses the successful exact-SHA CI
candidate. The full CI/test suite and production build run once per commit and
are not repeated during release; the
workflow does recheck manifest/hash integrity, time-sensitive production
security rules, and Worker bundles. It owns the dependency order above,
immutable app artifact, live smokes, and conflict-aware rollback.

The current service-control marker is
`admin-announcement-v2+abuse-rate-v2+session-idempotency-v1`. Announcement v2
separates notices into a dedicated named Durable Object owned by PRO. An empty
dedicated object temporarily reads the legacy announcement, and its first
accepted mutation inherits the legacy revision and history; after that, the
dedicated object is authoritative. Any marker change requires target `all`, and
the PRO owner must deploy before its consumers. Remote-share's old KV allocation
counter is retired and must not be restored as a fallback for a missing
service-control binding.

The current PRO system-audio contract marker is `lan-direct-v1`. Its first
cutover is a matched `all` release because the PRO authority, signaling relay,
and app/client must understand the descriptor and one-way promotion together.
Release recovery compares the marker between the immutable candidate and the
captured production checkpoint. Once any marker-changing candidate component
is live, an older or unverifiable baseline cannot be restored piecemeal: the
workflow withholds rollback of PRO, signaling, and app and requires forward
repair. A baseline that is proven still live before any cutover component
landed remains rollback-compatible.

The local `deploy:*` scripts are non-deploying guards that always stop. The
separate `emergency:deploy:*` scripts are emergency/operator primitives only;
they require the target-and-commit confirmation described in
`docs/hotfix-procedure.md`, generate immutable Git provenance for every Worker
deployment internally, and are not a routine validation or release path.

After deployment but before activation:

```powershell
curl.exe https://musixquare.com/api/pro-room/health
curl.exe https://musixquare.com/api/pro-room/v1/rooms/000000/bootstrap
```

The health response must identify `musixquare-pro-room`. A never-activated room
must return `activation_required` without any claim, PIN, object key, or signed
URL.

Before the first room-code reuse, verify a completed, non-production canary
incarnation through the whole protocol: deletion remains immediately
inaccessible, the 10-to-15-minute credential-expiry fence and one-hour
continuous empty-prefix window complete, every old credential fails, a manual
admin registration advances the generation exactly once, and only new
credentials and the new R2 prefix work. First confirm the cutover row is
`ready` for the exact deployed commit. Do not use a production customer room as
this first proof.

## Activation Claim

The normal operator flow is the Access-protected admin screen. Register the
textual six-digit code, then issue its activation link. The claim is returned
only in a `Cache-Control: no-store` response, is never written to D1 or a log,
expires within fifteen minutes, and becomes stale immediately if an operator
issues another link. Copy it directly to the intended owner.

The offline issuer is an emergency generation-`0` tool for a registered
`0xxxxx` room before the admin has issued a link for that incarnation. It
creates `activationClaimGeneration=0` and does not allocate or advance immutable
`roomGeneration`; therefore it cannot activate a re-registered incarnation.
Once the admin screen issues or reissues a link, the room advances its
authoritative activation-claim counter and any offline activation link is
intentionally rejected. Use the admin screen for normal activation, every
retry, and every room generation greater than zero. The CLI reads the signing secret only from
`PRO_ROOM_ACTIVATION_SECRET`, writes only a URL fragment to stdout, and gives
that fragment a fifteen-minute lifetime.

PowerShell example that avoids placing the secret in command history or argv:

```powershell
$secure = Read-Host "PRO room activation secret" -AsSecureString
$env:PRO_ROOM_ACTIVATION_SECRET = [System.Net.NetworkCredential]::new('', $secure).Password
try {
  npm run pro-room:issue-claim -- 000000
} finally {
  Remove-Item Env:PRO_ROOM_ACTIVATION_SECRET
}
```

POSIX shell equivalent:

```sh
read -rsp 'PRO room activation secret: ' PRO_ROOM_ACTIVATION_SECRET && printf '\n'
export PRO_ROOM_ACTIVATION_SECRET
npm run pro-room:issue-claim -- 000000
unset PRO_ROOM_ACTIVATION_SECRET
```

Append the printed fragment to the matching room URL:

```text
https://musixquare.com/000000#pro-claim=<opaque-claim>
```

The claim itself is sensitive. Deliver it out of band to the intended owner;
do not paste it into a query string, analytics tool, chat transcript, issue, or
support log. Confirm that opening the URL removes the fragment immediately.
The client supplies the derived bootstrap value automatically; the owner only
chooses a different eight-digit room PIN. Complete a health/bootstrap smoke for
that exact room before sharing its invite.

## Owner Recovery After Browser Data Loss

Use recovery only when the owner cookie is unavailable. A normal PIN login
creates a controller session but deliberately cannot grant owner-only room
configuration rights.

First sign in to MUSIXQUARE with the account that should own the room. Then open
`/admin`, expand the active PRO room, and select **Issue owner recovery link**.
Open the issued link in that same signed-in browser. The App Worker requires
both the outer Cloudflare Access policy and its inner admin session, writes an
`owner_recovery_claim.issue` audit result, and
returns the credential with `Cache-Control: no-store`. Before showing the link,
it strictly validates the HTTPS origin, room path, fragment shape, expiry, and
the service response. The response may expose `ownerAccountLinked` as a boolean
operator hint; it never exposes an account identifier. If the audit write cannot
be confirmed, the App Worker withholds the link.

The link panel is intentionally sensitive and in-memory only. Copy the link to
the intended owner, then dismiss the panel. Issuing another link is allowed,
but each recovered nonce can be redeemed only once. Redemption by a different
signed-in account fails with `OWNER_ACCOUNT_LINK_CONFLICT` before the existing
owner credential is revoked. A browser without a verified account fails with
`ACCOUNT_SESSION_REQUIRED`; account-link and bounded-member-capacity failures
also leave the recovery nonce unconsumed, so the same link may be retried after
the account condition is corrected.

If the admin dashboard path is unavailable and the operator securely has
`PRO_ROOM_ACTIVATION_SECRET`, generate the same room-scoped recovery fragment
from the operator workstation as an emergency fallback:

```powershell
$secure = Read-Host "PRO room activation secret" -AsSecureString
$env:PRO_ROOM_ACTIVATION_SECRET = [System.Net.NetworkCredential]::new('', $secure).Password
try {
  npm run pro-room:issue-claim -- --recovery 000000
} finally {
  Remove-Item Env:PRO_ROOM_ACTIVATION_SECRET
}
```

Append the single printed line to the matching room URL:

```text
https://musixquare.com/000000#pro-recovery=<opaque-claim>
```

The default recovery lifetime is ten minutes and the Worker rejects any claim
longer than fifteen minutes. It is one-time, room-bound, and must be handled as
a secret. The app scrubs it before making a network request. After recovery,
confirm the owner pencil control is visible, change the PIN if compromise is
suspected, and verify the old recovery link cannot be used again.

## Rollback

Rollback must preserve data and keep PRO codes unavailable to the ordinary
host-claim path.

The immutable generation floor requires a matched generation-aware App, PRO,
signaling, Developer API facade, and Developer API Workers plus the canonical
D1 schemas. A generation-blind Worker
can confuse a reusable public address with immutable authority and is therefore
never a valid rollback target.
Leave entry fail-closed and forward-fix, or restore a matched provider
data/code checkpoint. Never delete a generation-history row or tombstone,
decrement `room_generation`, move objects between incarnation prefixes, or
authorize a request from `roomCode` alone.

After the coordinator-free cutover, “last known-good” means a matched
server-authority App, PRO, signaling, and Developer API checkpoint. Once the
service-control announcement floor has landed, App and PRO must also remain at
or above that marker. Other Workers follow the workflow's runtime-compatibility
and provenance checks; remote-share may be restored independently when those
checks prove it safe. Never roll a live room back to an elected-browser
coordinator or a pre-v2 storage Worker. If no compatible checkpoint is
available, keep PRO entry in maintenance and forward-fix or restore the whole
matched data/code checkpoint.

Account-aware rollback must also retain the auth D1 binding, canonical schema,
account-to-room reverse index, room tombstones, and all room/R2 data. Removing
an OAuth/session secret may make account routes report `configured:false`
without deleting data. Do not rotate the subject pepper or reintroduce projection
flags as a routine rollback; use PRO maintenance and forward repair when the
least-privilege contract cannot be preserved.

The `admin-announcement-v2+abuse-rate-v2+session-idempotency-v1`
service-control marker is an additional forward-only floor once its App/PRO pair
has deployed or the dedicated announcement object has canonical state. Never
restore App or PRO below that marker: pre-v2 code can address the legacy
co-located announcement store instead of the dedicated instance. Use target
`all` to repair forward when the release workflow reports that compatibility
floor; do not improvise a partial rollback for that pair.

`lan-direct-v1` adds a separate PRO system-audio rollback floor across the App,
PRO, and signaling Workers. After any component of the marker-changing release
has become live, do not restore one of those three below v1 or rely on an old
client silently ignoring direct offers: that can strand a direct descriptor or
split the media contract. Let the recovery workflow preserve all three and
repair forward. Only an exact checkpoint proving that no cutover component
became live may roll back below the marker.

1. Stop the rollout and record the Worker versions and observed symptom. Do not
   delete the R2 bucket, Durable Object binding, class migration, or room data.
2. Let the release workflow perform conflict-aware recovery. When every
   compatibility floor permits rollback, its reverse dependency order is App,
   Developer API, Developer API facade, signaling, remote-share, then PRO.
3. Keep a signaling version that reserves the full `0xxxxx` namespace. Never
   restore an older version that exposes a future PRO code as an ordinary room.
4. Re-run health/bootstrap checks and open both seeded invite routes without an
   activation claim. Existing PRO data should remain dormant and recoverable.

Never roll back to a PRO Worker that predates dynamic provisioning. Keep every
`0xxxxx` code reserved, retain the D1 registry, Durable Objects, and R2 data, and
forward-repair the matched Worker set.

For a signaling-ticket incident, coordinate the PRO and signaling rollback so
both verify the same `PRO_SIGNALING_SECRET`. For a secret incident, restore or
rotate through the secret manager; PIN-pepper rotation needs a data migration
and session-secret rotation intentionally signs everyone out.

If only the client is faulty, leave the PRO backend and reserved signaling
codes deployed and roll back the app alone. This is safer than reopening the
codes or deleting persistent media.
