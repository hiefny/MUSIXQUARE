# ADR and Runbook: Persistent PRO Rooms

- **Status:** Accepted operations baseline, amended by
  `pro-room-server-authority.md`; production activation requires the real-device
  checklist below
- **Decision date:** 2026-07-16
- **Applies to:** the reserved `0xxxxx` namespace, initially provisioned room
  codes `000000` and `000001`, the PRO control plane, dedicated PRO signaling,
  and persistent PRO media

## Context

Normal MUSIXQUARE rooms are temporary sessions. A PRO room is a stable place
for a cafe, routine listener, or invited group: its URL and QR code do not
change, its authoritative playlist survives an empty room, and it resumes from
the last server-owned playback anchor.

This checkpoint implements manually granted entitlement through the
Access-protected MUSIXQUARE admin screen. It does not add billing, checkout,
subscription, or automatic code allocation.

## Decision

The first provisioned rooms are fixed:

| Code     | Purpose                                          | Derived bootstrap value |
| -------- | ------------------------------------------------ | ----------------------- |
| `000000` | Developer room and the first MUSIXQUARE PRO room | `00000000`              |
| `000001` | Friends-and-family pilot room                    | `00000001`              |

Their natural invite URLs remain `https://musixquare.com/000000` and
`https://musixquare.com/000001`. A room code is an identifier, not a secret or
an authorization credential.

| Component                                | Responsibility                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| App route                                | Detect a leading-zero PRO code, collect PIN/activation input, render playback  |
| PRO Worker                               | Activation, auth, queue, canonical timeline, presence, quota, and signed R2    |
| One Durable Object per room              | Sole serialized manager for room state, transitions, presence, and byte ledger |
| Signaling Worker PRO path                | Own hibernatable role-neutral sockets, clock replies, chat, and event fan-out  |
| Private `musixquare-pro-media` R2 bucket | Persistent encoded source files; never a public bucket                         |
| Browser                                  | RAM-only transfer, decode, preload, and playback working set                   |
| Admin D1 registry                        | Bounded operator index of registered codes, labels, and activation state       |
| App-to-PRO cross-script DO binding       | Provision a room and issue a claim without a public admin service endpoint     |
| App-to-PRO service binding               | Same-origin `/api/pro-room/*` browser facade over the public PRO router        |

The regular signaling path reserves the complete `0xxxxx` namespace before
Durable Object lookup. `000000` and `000001` are seeded in the admin registry;
an operator may register another six-digit `0xxxxx` code. Registration writes
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

The former custom-domain cookies are host-only and cannot migrate to the facade.
On the first facade visit, an existing participant therefore enters the PIN
once more. Existing room owners must redeem a one-time owner-recovery claim
after the cutover to receive the new room-scoped owner cookie. For an active
room, an operator issues the short-lived link from that room's controls in the
Access-protected admin dashboard and redeems it only in the intended owner
browser. The offline CLI remains an emergency fallback. The old browser cookies
remain untouched, but redemption revokes the previous server-side owner
credential; rolling back the client endpoint would therefore require another
recovery on the old origin.

The public PRO front door cold-loads a bounded set of `registered` D1 rows,
including the two launch rooms, and replaces that cache on a five-second
refresh. Unknown-code probes are rejected before Durable Object lookup,
preventing namespace scans from creating one object per guessed code. A bound
registry fails closed when it cannot refresh; local test environments without
D1 retain only the two launch-room defaults. Replacing rather than extending
the cache is essential: a suspended or permanently deleted code must disappear
from the front door even when it is `000000` or `000001`.

Admin registration is an explicit two-phase reconciliation: D1 first records
`provisioning`, the cross-script binding idempotently persists the room's
provision bit, and only then may D1 expose `registered`. A failed call leaves a
retryable provisioning row rather than a false success. Repeating the same
registration self-heals that row. Registration and activation-link issuance
also write a bounded audit event containing only a session-scoped pseudonymous
actor, action/result, room code, and timestamp. PINs, claims, and activation
URLs are forbidden in both the registry and audit table. If the issuance audit
write fails, the admin endpoint discards the just-issued URL and returns an
error; retrying rotates the claim generation again, so no unaudited link can
later become the current credential.

### Permanent room deletion

The admin dashboard exposes permanent deletion in a separate danger zone. It
requires the operator to enter the exact six-digit room code in a modal; the
server independently verifies that confirmation and a UUID request ID. This is
not an extension of suspend. Suspend preserves the playlist and media, while
permanent deletion is an irreversible, idempotent decommission protocol.

The app records the operator audit first, then asks the room Durable Object to
durably enter `decommissioning`, and only after that acknowledgement updates
the D1 display registry. This DO-first order guarantees that a cross-script
failure cannot leave a closed-looking registry row without an alarm that owns
the cleanup. That transition immediately sets `provisioned=false`,
invalidates every browser session and owner credential, removes PIN, playlist,
playback, presence, effects, media ledgers, recovery nonces, and Developer API
commands, closes all signaling sockets, and deletes the room's Developer API
keys, room-scoped API audit rows, and rate-limit ledger. A permanent tombstone
in the Developer API database blocks late key or audit inserts, and the
room-scoped limiter retains its own authorization tombstone. Existing browser
cookies may remain as inert strings on offline devices, but their server-side
credentials no longer exist.

Persistent media is deleted by repeatedly listing and removing every R2 object
under `rooms/{roomCode}/`; individual asset ledgers are not trusted as a
complete inventory. The service performs an immediate sweep, waits until every
previously issued presigned PUT or reservation has expired, and then requires
the prefix to remain continuously empty for one hour. It rechecks every minute;
any late object is deleted and restarts that quiet window. R2, signaling,
Developer API, or registry failures also restart the window and leave the room
fail-closed in `decommissioning`. The admin endpoint therefore returns `202`
until this final safety window completes. A decommissioned tombstone keeps a
daily repair sweep afterward, catching even an abnormally long direct PUT that
finishes after the primary window without making the room reusable.

Completion scrubs the registry label and records `decommissioned`. A minimal
PRO-state tombstone and a signaling tombstone retain only the room code,
decommission timing/idempotency metadata, and non-user empty schema defaults.
These tombstones are intentional:
the room number can never be registered again, so old activation, recovery,
signaling, or upload credentials cannot become valid in a new incarnation.
Operator audit events remain under the existing 365-day retention policy; all
room-scoped Developer API audit detail is removed with the room.

For a release containing this protocol, deploy signaling before the PRO Worker
and deploy both the PRO and Developer API Workers before the app Worker. The
checked-in all-workers command already satisfies those dependency edges. The
PRO Worker owns cross-script bindings to signaling and the room-scoped
Developer API limiter so its alarm can finish every cleanup phase without an
open admin tab. The Developer API D1 schema migration is a required part of the
same release because it installs the permanent room tombstone and late-write
triggers. Deploying the app first would expose an action whose cleanup
dependencies are not ready.

### Authorization model

- Public bootstrap returns only `activation_required`, `pin_required`, or
  `suspended`. It never issues or returns an activation claim.
- An owner activation claim is issued from the Access-protected admin screen
  (with a fixed-room offline CLI retained for recovery operations), scoped to
  one room, signed with `PRO_ROOM_ACTIVATION_SECRET`, and delivered only in the
  URL fragment `#pro-claim=...`. It expires within fifteen minutes. Issuance
  atomically advances a room-local generation, so issuing again immediately
  invalidates every older unredeemed activation link. Activation consumes the
  generation by moving the room out of `unactivated` state.
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
- The owner credential manages PIN/recovery security and owner-visible room
  configuration. Access-protected operators manage suspension and permanent
  deletion. A separate member session controls live-room actions. Linking the
  verified owner account lets another physical session of that account recover
  owner authority, but a room code, PIN, or first-arrival position never creates
  ownership.
- Under member-authority projection `1`, a PIN-admitted ordinary PRO member has
  no playback or mutation capability. The owner always retains playback
  control. A delegated administrator receives playback, persistent media
  addition, member removal, and chat-announcement capabilities only through
  their respective explicit toggles; disabling the playback toggle removes
  `playback.control`. Queue deletion/reordering/clear, effects, repeat, shuffle,
  PIN/recovery, and other room configuration remain owner-only. BOT and
  Developer API commands are checked as the initiating room member and cannot
  bypass those capability boundaries. An anonymous delegation is session-lived;
  a verified account delegation is persisted in the room until owner revocation
  or room deletion.
- Browser credentials are room-scoped, host-only, Secure, HttpOnly cookies, so
  multiple PRO rooms can stay signed in at the same time. Short-lived
  signaling tickets are bound to room, participant, presence incarnation,
  authoritative presence revision, room-control incarnation, and a per-session
  monotonic ticket sequence. They are consumed once, and the signaling Durable
  Object persists bounded participant and presence high-water marks so an older
  delayed ticket cannot replace a newer socket or re-enter after removal.
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
seconds; an active client re-proves it every 40 seconds and also reconciles after
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

PRO system audio has one temporary **publisher**: the authenticated participant
that currently holds the room's short-lived media lease and browser capture.
That source lease never grants playback authority or a manager role.

Every active PRO participant may request that lease, but one Durable Object
serializes acquisition so only one owner can prepare or publish at a time. The
private lease credential remains in the acquiring browser and the Durable
Object; peer messages and public room state contain only a fenced generation
and the Cloudflare Realtime publication descriptor. A 45-second preparing
claim bounds abandoned native-picker attempts. Once committed, the live lease
has a fixed two-hour deadline and cannot be extended by heartbeat.

PRO live audio always uses the role-independent Cloudflare Realtime path. The
publisher sends the two mono L/R tracks once and every other participant
subscribes from the public descriptor. A participant entering or leaving does
not stop or republish the capture. Publisher exit, tab-incarnation replacement,
lease expiry, or a fifth active device atomically fences the old generation and
ends the share.

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

The first successful mutation of a storage-v1 room writes v2 atomically. While
the entire room still fits the old single-record budget, ordinary mutations
refresh an exact `pro-room:v1` storage rollback shadow. This is a data-format
safety aid, not permission to reconnect a former browser-coordinator client.
Presence-only heartbeats check that large compatibility shadow at most once
every 30 seconds. A successful check is throttled even after the room outgrows
the legacy value budget; the last valid shadow is retained rather than
repeatedly serialized, overwritten, or deleted.

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

After a room grows beyond the legacy budget, v2 stays authoritative. A rollback
to a pre-v2 Worker after that point therefore requires an operator data-restore
decision and must not be treated as a routine code-only rollback.

Heartbeat clients send the public room revisions they last applied. An
unchanged room returns only those revisions and `notModified`; any mismatch
returns a complete snapshot for recovery. The empty-body/full-response fallback
exists only for rolling Worker/schema compatibility within the current
server-authority client family. It does **not** admit the former elected-browser
coordinator protocol; that protocol is intentionally unsupported after cutover.

Browser queue mutations use the compact snapshot endpoint. It sends stable row
order only when order changes and upserts only rows whose metadata/source
changed. Playback-anchor and metadata-only changes omit order entirely. The
full-snapshot endpoint remains available during a Worker-first rolling release
for current server-authority clients, not as a compatibility path for a browser
coordinator. Public Developer API routes and payloads are unchanged; their
internal response bounds match the larger v2 queue projection.

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
- The per-file limit is an intentional RAM-only playback bound, not another
  storage entitlement. The current client downloads an encoded object into
  memory and then decodes a full `AudioBuffer`; raising the limit to 1 GiB
  without the postponed bounded-streaming engine would reintroduce predictable
  iOS tab termination.
- Every reservation maintains `usedBytes + reservedBytes <= 1 GiB` inside the
  serialized room object.
- The server chooses every object key. The client receives only short-lived
  presigned PUT/GET URLs for the private bucket. Upload URLs target disposable
  staging keys; completion verifies the staging object, streams it to a fresh
  immutable final key, and retains cleanup state until the reusable staging URL
  has expired.
- Upload completion becomes `ready` only after R2 HEAD matches the reserved
  byte count, media type, room, asset ID, version, and optional client-supplied
  SHA-256 metadata. The current R2 promotion path does not independently hash
  the uploaded body; byte-for-byte content verification is a future hardening
  item, not a property operators should assume today.
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

5. Provision the Durable Object and custom domain by deploying the PRO Worker
   only after all secrets below are present.

6. Confirm the App Worker has the cross-script Durable Object binding
   `PRO_ROOM_ADMIN_ROOMS` targeting class `MusixquareProRoom` in script
   `musixquare-pro-room`. It is the only admin-to-PRO path; do not add a public
   internal endpoint or shared bearer secret.

## Secrets

Secret values must come from the approved password/secret manager. Never put a
value in source, a committed `.env`, a shell argument, a URL query, an issue, or
a deployment message.

| Binding                      | Scope and rotation consequence                                                   |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `PRO_ROOM_ACTIVATION_SECRET` | PRO Worker plus the offline issuer. Rotation invalidates unredeemed claims.      |
| `PRO_ROOM_PIN_PEPPER`        | PRO Worker only. Rotation invalidates existing PIN hashes without migration.     |
| `PRO_ROOM_SESSION_SECRET`    | PRO Worker only. Rotation signs out member and owner browser credentials.        |
| `PRO_ROOM_RATE_LIMIT_SECRET` | PRO Worker only. Rotation resets pseudonymous rate-limit buckets.                |
| `PRO_SIGNALING_SECRET`       | Same value in PRO and signaling Workers; rotate/deploy both together.            |
| `MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET` | Same independent value in App and PRO Workers; signs short-lived PRO room/account assertions. |
| `R2_ACCOUNT_ID`              | Public account identifier used by the presigner and exact client host allowlist. |
| `R2_ACCESS_KEY_ID`           | R2 S3 credential restricted to the dedicated PRO media bucket.                   |
| `R2_SECRET_ACCESS_KEY`       | Paired R2 S3 secret; rotation interrupts new presigned URLs until redeployed.    |

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
npm ci
npm run check:workers
npx vitest run src/pro-room/__tests__
npm run build:checked
```

Also verify:

- the admin D1 registry seeds `000000` and `000001`, and registration accepts
  only a textual room code matching `^0\d{5}$`;
- signaling reserves all `0xxxxx` codes from ordinary rooms and accepts the PRO
  path only with a valid PRO Worker-issued signed ticket;
- the R2 bucket name is `musixquare-pro-media` in Wrangler, CORS, and the
  presigner configuration;
- production CORS includes `https://musixquare.com` and
  `https://www.musixquare.com`; and
- the account Privacy Policy, Terms, FAQ, Google consent-screen links, and
  deletion-boundary copy match the deployed account behavior;
- account deletion exercises the reverse-index purge, sleeping-room retry, and
  stale-assertion tombstone described above before projection flags are enabled;
- the checked-in compatibility checkpoint keeps
  `PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION=0` and
  `PRO_ROOM_MEMBER_AUTHORITY_PROJECTION=0`; changing both to `1` is a separate
  reviewed activation step after the compatible client is live; and
- no test/debug bypass or secret value appears in the production diff.

## Deployment Order

Account authority uses a two-stage rolling release. The repository intentionally
ships the first stage with both PRO projection flags set to `0`.

### Stage 1: compatibility baseline

1. Deploy the account-aware App, signaling, and PRO code while leaving
   `MUSIXQUARE_AUTH_DB` unbound and all account projection flags disabled.
2. Publish the compatible static client as service-worker cache `v203`. The
   client accepts both pre-account and account-aware snapshots, but the missing
   auth binding keeps login unavailable and anonymous behavior unchanged.
3. Verify `GET /api/auth/session` reports `configured:false`, ordinary rooms
   still work anonymously, and PRO rooms retain the pre-account equal-member
   compatibility behavior. Record the exact App, signaling, and PRO Worker
   versions; together with `v203` they are the account rollout rollback floor.

Do not provision OAuth or flip either projection flag during this stage. The
point is to move every cached client and Worker onto schemas that understand the
optional fields before any production room can emit or persist account-linked
authority.

### Stage 2: account activation

1. Create and migrate the dedicated auth D1 database, bind it to the App Worker,
   register the exact Google callback, and install the OAuth/session secrets.
2. Install the independent standard-room assertion secret on App and signaling,
   and the independent PRO assertion secret on App and PRO.
3. Change both `PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION` and
   `PRO_ROOM_MEMBER_AUTHORITY_PROJECTION` from `0` to `1` in the same reviewed
   release. Do not operate indefinitely with only one flag enabled.
4. Deploy signaling first, PRO second, and App/static last. Verify the account
   session endpoint, one login/nickname flow, multi-device grouping, delegated
   allow/deny boundaries, lease expiry/reattach, logout-all, and cross-room
   deletion purge before inviting additional PRO users.

Within either stage, use this Worker dependency order so the public app never
advertises a dependency that is absent:

1. Remote-share Worker (independent baseline service).
2. Signaling Worker, reserving `0xxxxx` before any client can advertise PRO.
3. PRO Worker and Durable Object/R2 bindings.
4. App Worker, same-origin PRO service binding, and static build last.

The checked-in command performs all syntax/build checks before step 1 and then
uses this order:

```powershell
npm run deploy:all-workers
```

For a narrowly scoped PRO backend update, use `npm run deploy:pro-room`. Do not
run either deploy command from tests or local validation.

After deployment but before activation:

```powershell
curl.exe https://musixquare.com/api/pro-room/health
curl.exe https://musixquare.com/api/pro-room/v1/rooms/000000/bootstrap
curl.exe https://musixquare.com/api/pro-room/v1/rooms/000001/bootstrap
```

The health response must identify `musixquare-pro-room`. A never-activated room
must return `activation_required` without any claim, PIN, object key, or signed
URL.

## Activation Claim

The normal operator flow is the Access-protected admin screen. Register the
textual six-digit code, then issue its activation link. The claim is returned
only in a `Cache-Control: no-store` response, is never written to D1 or a log,
expires within fifteen minutes, and becomes stale immediately if an operator
issues another link. Copy it directly to the intended owner.

For the two initial fixed rooms, the offline issuer remains available only as a
bootstrap compatibility tool before the admin has ever issued a link for that
room. It always creates generation `0`; once the admin screen issues or
reissues a link, the room advances its authoritative generation and any
offline activation link is intentionally rejected. Use the admin screen for
normal activation and every retry. The CLI accepts one fixed room code, reads
the signing secret only from `PRO_ROOM_ACTIVATION_SECRET`, writes only a URL
fragment to stdout, and gives that fragment a fifteen-minute lifetime.

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

Append the printed fragment to the matching fixed invite URL:

```text
https://musixquare.com/000000#pro-claim=<opaque-claim>
```

The claim itself is sensitive. Deliver it out of band to the intended owner;
do not paste it into a query string, analytics tool, chat transcript, issue, or
support log. Confirm that opening the URL removes the fragment immediately.
The client supplies the derived bootstrap value automatically; the owner only
chooses a different eight-digit room PIN. Activate `000000` first, complete its
short smoke check, and then activate the friends-and-family pilot room `000001`
with its own owner browser.

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
  npm run pro-room:issue-claim -- --recovery 000001
} finally {
  Remove-Item Env:PRO_ROOM_ACTIVATION_SECRET
}
```

Append the single printed line to the matching room URL:

```text
https://musixquare.com/000001#pro-recovery=<opaque-claim>
```

The default recovery lifetime is ten minutes and the Worker rejects any claim
longer than fifteen minutes. It is one-time, room-bound, and must be handled as
a secret. The app scrubs it before making a network request. After recovery,
confirm the owner pencil control is visible, change the PIN if compromise is
suspected, and verify the old recovery link cannot be used again.

## Rollback

Rollback must preserve data and keep PRO codes unavailable to the ordinary
host-claim path.

After the coordinator-free cutover, “last known-good” means a matched
server-authority app, PRO Worker, and signaling Worker checkpoint. Never roll a
live room back to an elected-browser coordinator merely because a v1 storage
shadow exists. If no compatible checkpoint is available, keep PRO entry in
maintenance and forward-fix or restore the whole matched data/code checkpoint.

For the account rollout, the minimum supported code rollback is the recorded
Stage-1 compatibility baseline: service-worker `v203` plus the account-aware App,
PRO, and signaling Workers with both projection flags at `0`. Once Stage 2 has
written account members, authority records, deletion tombstones, or reverse
edges, do not roll any Worker or cached client below that floor. Older code does
not own those fields or their stale-write fences.

If Stage 2 fails, first hide/disable login and set both PRO projection flags back
to `0`, then redeploy the matched Stage-1 Worker versions if necessary. Keep the
auth D1 binding, its schema, account-to-room reverse index, room tombstones, and
all room/R2 data in place. Keeping D1 bound allows expiry and deletion cleanup to
continue; removing an OAuth/session secret may make account routes report
`configured:false` without deleting data. Do not rotate the subject pepper as a
rollback. Projection `0` intentionally restores the former PIN-admitted
equal-member behavior, so use PRO maintenance instead when that temporary
authority expansion is unacceptable for the incident being handled.

1. Stop the rollout and record the Worker versions and observed symptom. Do not
   delete the R2 bucket, Durable Object binding, class migration, or room data.
2. Roll the app back first so new clients stop entering the faulty flow.
3. Roll the PRO Worker back to its last known-good version through Cloudflare
   Worker version history. Leave its Durable Object migration and R2 binding in
   place.
4. Keep a signaling version that reserves the full `0xxxxx` namespace. Never
   restore an older version that exposes a future PRO code as an ordinary room.
5. Re-run health/bootstrap checks and open both fixed invite routes without an
   activation claim. Existing PRO data should remain dormant and recoverable.

A PRO Worker rollback predating dynamic provisioning may temporarily make
`000002+` unavailable. Keep those codes reserved, keep their Durable Object and
R2 data intact, and never reinterpret them as ordinary rooms. The D1 registry
is an operator index and should be retained for forward recovery.

For a signaling-ticket incident, coordinate the PRO and signaling rollback so
both verify the same `PRO_SIGNALING_SECRET`. For a secret incident, restore or
rotate through the secret manager; PIN-pepper rotation needs a data migration
and session-secret rotation intentionally signs everyone out.

If only the client is faulty, leave the PRO backend and reserved signaling
codes deployed and roll back the app alone. This is safer than reopening the
codes or deleting persistent media.

## Manual Real-device QA Gate

Automation is supporting evidence, not the release gate for synchronized audio
and browser lifecycle behavior. Complete this matrix with physical devices:

- current physical iPhone in Safari;
- the same iPhone with MUSIXQUARE installed as a Home Screen PWA;
- a physical Android phone in Chrome; and
- one desktop browser as the second controller.

Exercise both same-Wi-Fi and mixed Wi-Fi/mobile-data connections. Record device,
OS, browser/PWA mode, network, room code, build/version, and observed result.

### Required scenarios

1. Open `000000` without a claim and confirm it cannot be seized. At the API
   regression layer, try an invalid claim, a wrong derived bootstrap value, and
   a wrong room/claim pairing; all fail without revealing which credential was
   wrong. The product UI must ask only for the new eight-digit room PIN.
2. Activate with the fragment, confirm the fragment is immediately scrubbed,
   set a new PIN, then join from two additional physical devices through the
   same fixed link and QR code.
3. At the Stage-1 checkpoint, confirm each PIN-admitted device retains the
   pre-account equal-member compatibility behavior and none is exposed as a
   browser host/coordinator. At Stage 2, confirm an ordinary member cannot
   control playback, the owner always can, and a delegated administrator can do
   so only while its playback toggle is enabled. Confirm media addition, member
   removal, and announcements follow their independent toggles; queue
   destruction, reordering, effects, repeat, and shuffle remain owner-only.
4. Add YouTube media, empty the room, reopen from another device, and verify the
   playlist and frozen server anchor resume correctly. While another
   item is playing, add a playlist-only YouTube URL and confirm the current
   audio is uninterrupted and the new persistent row later indexes normally.
5. Upload and play a private file, join late from the second phone, background
   and foreground both browsers, lock/unlock the iPhone, and reopen the PWA.
   Confirm the same ready R2 asset is used after wake.
6. Verify a valid file up to 200 MiB can reserve while a 200 MiB + 1 byte request
   is rejected before upload. Exercise enough concurrent reservations to
   confirm the displayed ledger never exceeds 1 GiB; cancel them afterward.
   Also populate more than 100 metadata-rich YouTube rows, upload a local file,
   and confirm R2 completion and compact playlist indexing both succeed without
   clearing the existing queue.
7. Complete an upload but do not append it. After the 15-minute grace, confirm
   R2 cleanup releases used quota. Repeat while referencing the asset twice;
   removing one playlist item must not delete the shared asset.
8. Change the owner PIN. Existing controller sessions must be revoked, the
   owner must retain recovery access, and the old PIN must not create a session.
9. Let all devices leave while playing, wait, then rejoin. Repeat by directly
   closing any Safari tab/PWA while audio is playing and reopen
   the fixed link. Playback must resume from the final frozen position rather
   than advancing through the empty interval. Confirm that an explicit leave
   still requires the PIN on the next entry, while a tab close retains the
   room-scoped session.
10. Open the same room in two tabs sharing one cookie. After the second tab
    resumes, confirm the first tab cannot refresh, mutate, issue a signaling
    ticket, or log out the replacement. Only the superseded participant socket
    may close; other members must remain connected and ordinary rooms must be
    unaffected.
11. Inspect browser storage and network behavior. PRO media bodies must not be
    written to OPFS or IndexedDB, internal R2 keys must not appear in snapshots,
    and signed URLs must target only the configured R2 account host.
12. With Stage 2 enabled, sign one account into several physical devices and
    confirm they group under one room member without transport takeover. Revoke
    or logout-all from another device: the affected physical session must lose
    account-only controls immediately when notified and in all cases within the
    120-second server lease, while playback remains connected. Then verify a
    valid reattach restores the persistent grant.
13. Link the same account to awake and sleeping test rooms, then delete it.
    Confirm every room purge completes before the App account row is removed,
    partial failure remains retryable, and a previously minted assertion cannot
    recreate authority across the deletion tombstone.

### Pass criteria

- No unexplained tab reload, PWA termination, WebContent crash, stuck loader,
  duplicate playback, or browser-manager dependency.
- No playlist/revision loss across an empty-room sleep and later wake.
- A queue above the legacy 1.2 MiB single-record budget survives Worker restart,
  accepts local-file completion, and remains readable through the Developer API.
- No unauthorized access with a room code alone, and no claim/PIN in logs or
  query strings.
- `usedBytes + reservedBytes` never exceeds 1 GiB and never decreases before a
  corresponding R2 deletion succeeds.
- The fixed link and QR remain identical across leave/rejoin and deployment.

Do not invite the friends-and-family group into `000001` until `000000` passes
this gate and a rollback rehearsal preserves its Durable Object and R2 data.
