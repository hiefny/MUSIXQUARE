# ADR and Runbook: Persistent PRO Rooms

- **Status:** Accepted for staged rollout; production activation requires the
  real-device checklist below
- **Decision date:** 2026-07-16
- **Applies to:** the reserved `0xxxxx` namespace, initially provisioned room
  codes `000000` and `000001`, the PRO control plane, dedicated PRO signaling,
  and persistent PRO media

## Context

Normal MUSIXQUARE rooms are temporary sessions. A PRO room is a stable place
for a cafe, routine listener, or invited group: its URL and QR code do not
change, its authoritative playlist survives an empty room, and it resumes from
the last persisted playback checkpoint.

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

| Component                                | Responsibility                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| App route                                | Detect a leading-zero PRO code, collect PIN/activation input, render playback |
| PRO Worker                               | Activation, PIN/session auth, snapshot revisions, presence, quota, signed R2  |
| One Durable Object per room              | Serialized source of truth for room state, coordinator epoch, and byte ledger |
| Signaling Worker PRO path                | Accept only short-lived room/participant/epoch-scoped signaling tickets       |
| Private `musixquare-pro-media` R2 bucket | Persistent encoded source files; never a public bucket                        |
| Browser                                  | RAM-only transfer, decode, preload, and playback working set                  |
| Admin D1 registry                        | Bounded operator index of registered codes, labels, and activation state      |
| App-to-PRO cross-script DO binding       | Provision a room and issue a claim without a public admin service endpoint    |

The regular signaling path reserves the complete `0xxxxx` namespace before
Durable Object lookup. `000000` and `000001` are seeded in the admin registry;
an operator may register another six-digit `0xxxxx` code. Registration writes
an idempotent provision bit into that room's Durable Object through a
cross-script binding. An unprovisioned room rejects bootstrap, activation, and
all authenticated APIs. No leading-zero code may ever fall through to a normal
first-come host room.

The public PRO front door keeps the two launch rooms on an immutable fast path.
For dynamic rooms it cold-loads a bounded set of `registered` D1 rows and then
keeps positive entries in memory. Unknown-code probes share a short negative
refresh window and are rejected before Durable Object lookup, preventing
namespace scans from creating one object per guessed code. Heartbeats and
mutations for a known room do not await D1. The registry is append-only in this
release; a future suspend/delete operation must add explicit cache invalidation
before changing that rule.

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
  after browser data or the owner cookie is lost. Recovery revokes the previous
  owner credential without changing the room's controller sessions or data.
- Activation requires the claim and a new eight-digit PIN. The client derives
  the historical bootstrap value from the room code and supplies it
  automatically; the user does not type it and operators must not describe it
  as an independent second factor. The activation URL is the sensitive owner
  bearer until it expires or is superseded. The first synchronous same-origin
  bootstrap scrubs the fragment before any
  third-party analytics can run. It retains the value only in a non-enumerable,
  one-use in-memory closure; the eager app module consumes that closure before
  Cloudflare Analytics is loaded. Scrub or handoff failure is fail-closed.
- The owner credential manages PIN and membership lifecycle. A separate member
  session controls playback. This keeps ownership distinct from the current
  coordinator even when the same person holds both credentials.
- Every authenticated participant has controller capabilities. The elected
  coordinator is a synchronization tie-breaker, not an exclusive host. A
  controller may ask the coordinator to remove another current member through
  a strictly validated request; this is not a ban, and the removed member may
  authenticate again with the room PIN. PIN rotation and room configuration
  remain owner-only.
- Browser credentials are room-scoped, host-only, Secure, HttpOnly cookies, so
  multiple PRO rooms can stay signed in at the same time. Short-lived
  signaling tickets are bound to room, participant, presence incarnation,
  role, coordinator epoch, and a per-session monotonic ticket sequence. They
  are consumed once, and the signaling Durable Object persists a bounded
  participant high-water mark so an older delayed ticket cannot replace a
  newer socket.
- Every successful browser entry owns a server-issued, RAM-only presence
  incarnation. Snapshot, heartbeat, signaling, PIN, playlist, playback, and
  media requests must present that tab-local participant/incarnation pair as
  well as the HttpOnly cookie. Explicit resume rotates the incarnation; a
  superseded tab receives `PRESENCE_SUPERSEDED` and tears down its local
  authority without learning or revoking the replacement tab's incarnation.
- Re-entering the current coordinator advances the room coordinator epoch
  exactly once. The signaling service marks that close as an authority change,
  so browsers rebuild the legacy WebRTC facade immediately. Ordinary signaling
  blips still preserve healthy data channels, and member-only re-entry does not
  force a room-wide reconnect.

### Live system-audio ownership

PRO system audio deliberately separates two roles:

- the **coordinator** remains the room's synchronization and control-plane
  tie-breaker;
- the **system-audio owner** is whichever authenticated participant currently
  holds the room's short-lived media lease and browser capture.

Every active PRO participant may request that lease, but one Durable Object
serializes acquisition so only one owner can prepare or publish at a time. The
private lease credential remains in the acquiring browser and the Durable
Object; peer messages and public room state contain only a fenced generation
and the Cloudflare Realtime publication descriptor. A 45-second preparing
claim bounds abandoned native-picker attempts. Once committed, the live lease
has a fixed two-hour deadline and cannot be extended by heartbeat.

PRO live audio always uses the role-independent Cloudflare Realtime path. The
owner publishes the two mono L/R tracks once; the coordinator and every other
participant subscribe from the public descriptor. Coordinator handoff closes
the old receiver and rebuilds only the new coordinator's subscription. It does
not stop or republish the owner's capture. Owner exit, tab-incarnation
replacement, lease expiry, or a fifth active device atomically fences the old
generation and ends the share.

The cost boundary is four active devices total. Acquisition is refused above
that count, and joining a fifth device ends an already-running share while the
room, playlist, chat, and ordinary playback remain active. System audio is
ephemeral: it is never persisted as a sleeping-room playback source and never
changes the PRO room's durable media quota.

### Persistent state and sleep

The Durable Object persists the canonical playlist, current queue occurrence,
playback checkpoint (including the exact YouTube playlist sub-item), revision
numbers, bounded sessions, presence/coordinator epoch, media ledger, and compact
idempotency records. The serialized state is rejected atomically before it can
exceed the conservative 1.2 MiB budget beneath Cloudflare's 2 MiB value limit.
When the final participant leaves, the room becomes `sleeping` and freezes the
playing position. The next participant wakes the room from that checkpoint.

On a confirmed non-bfcache `pagehide`, the browser sends one small credentialed
`text/plain` keepalive mutation that stores the coordinator's final playback
observation and removes that participant from presence in the same Durable
Object transaction. The request deliberately keeps the room-scoped cookie
session alive so reopening the fixed link can resume without an avoidable PIN
prompt. An explicit in-product leave remains a different action: it releases
presence and revokes the exact current server session.

Explicit leave invalidates the local PRO authority, playlist hooks, transport,
and asynchronous-operation lease before its first await. The old room's atomic
checkpoint/presence close and server-session revocation then finish from
captured room context. The fenced revocation deliberately returns no cookie
tombstone: its response may arrive after another tab has installed a newer
same-name cookie, while the old browser token is harmless once its exact
server-side record is gone. A slow cleanup therefore cannot intercept an
ordinary room or another PRO room opened immediately afterward.

YouTube entries persist their canonical IDs. File entries persist an opaque PRO
asset identity and metadata; an internal R2 object key or signed URL must never
enter the playlist snapshot.

The first append into an empty, idle room commits the playlist row, selected
queue occurrence, and paused playback intent in one revision. The elected
coordinator observes that accepted transition and invokes the existing
synchronized load/play path once. A concurrent later append rebases behind the
winner and cannot steal the first selection.

A playlist-only YouTube URL is resolved through the guarded App Worker
`playlistItems` endpoint before it is persisted. This obtains one playable
entry ID without borrowing the hidden YouTube iframe, so adding the link does
not stop media that is already playing. Full playlist indexing still occurs
through the existing player path when that row is played.

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
- no test/debug bypass or secret value appears in the production diff.

## Deployment Order

Use this order so the public app never advertises a dependency that is absent:

1. Remote-share Worker (independent baseline service).
2. Signaling Worker, reserving `0xxxxx` before any client can advertise PRO.
3. PRO Worker and Durable Object/R2 bindings.
4. App Worker/static build last.

The checked-in command performs all syntax/build checks before step 1 and then
uses this order:

```powershell
npm run deploy:all-workers
```

For a narrowly scoped PRO backend update, use `npm run deploy:pro-room`. Do not
run either deploy command from tests or local validation.

After deployment but before activation:

```powershell
curl.exe https://pro.musixquare.com/health
curl.exe -H "Origin: https://musixquare.com" https://pro.musixquare.com/v1/rooms/000000/bootstrap
curl.exe -H "Origin: https://musixquare.com" https://pro.musixquare.com/v1/rooms/000001/bootstrap
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

Generate a room-scoped recovery fragment from the same operator workstation:

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
3. From every device, add/reorder/remove items, seek, pause, resume, skip, and
   adjust existing shared controls. Confirm each authenticated member has
   controller behavior and coordinator handoff does not grant owner settings.
4. Add YouTube media, empty the room, reopen from another device, and verify the
   playlist and frozen playback checkpoint resume correctly. While another
   item is playing, add a playlist-only YouTube URL and confirm the current
   audio is uninterrupted and the new persistent row later indexes normally.
5. Upload and play a private file, join late from the second phone, background
   and foreground both browsers, lock/unlock the iPhone, and reopen the PWA.
   Confirm the same ready R2 asset is used after wake.
6. Verify a valid file up to 200 MiB can reserve while a 200 MiB + 1 byte request
   is rejected before upload. Exercise enough concurrent reservations to
   confirm the displayed ledger never exceeds 1 GiB; cancel them afterward.
7. Complete an upload but do not append it. After the 15-minute grace, confirm
   R2 cleanup releases used quota. Repeat while referencing the asset twice;
   removing one playlist item must not delete the shared asset.
8. Change the owner PIN. Existing controller sessions must be revoked, the
   owner must retain recovery access, and the old PIN must not create a session.
9. Let all devices leave while playing, wait, then rejoin. Repeat by directly
   closing the coordinator's Safari tab/PWA while audio is playing and reopen
   the fixed link. Playback must resume from the final frozen position rather
   than advancing through the empty interval. Confirm that an explicit leave
   still requires the PIN on the next entry, while a tab close retains the
   room-scoped session.
10. Open the same room in two tabs sharing one cookie. After the second tab
    resumes, confirm the first tab cannot refresh, mutate, issue a signaling
    ticket, or log out the replacement. Repeat with the coordinator tab: the
    prior RTC facade must close, every member must reconnect once, and ordinary
    transient signaling loss must still leave healthy playback connected.
11. Inspect browser storage and network behavior. PRO media bodies must not be
    written to OPFS or IndexedDB, internal R2 keys must not appear in snapshots,
    and signed URLs must target only the configured R2 account host.

### Pass criteria

- No unexplained tab reload, PWA termination, WebContent crash, stuck loader,
  duplicate playback, or permanent coordinator disagreement.
- No playlist/revision loss across an empty-room sleep and later wake.
- No unauthorized access with a room code alone, and no claim/PIN in logs or
  query strings.
- `usedBytes + reservedBytes` never exceeds 1 GiB and never decreases before a
  corresponding R2 deletion succeeds.
- The fixed link and QR remain identical across leave/rejoin and deployment.

Do not invite the friends-and-family group into `000001` until `000000` passes
this gate and a rollback rehearsal preserves its Durable Object and R2 data.
