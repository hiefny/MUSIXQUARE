# Account authentication provisioning

The optional account service is implemented in `cloudflare/account-auth.js`,
but it deliberately stays disabled until its dedicated D1 database and all
server-only secrets are provisioned. When any requirement is missing,
`GET /api/auth/session` returns:

```json
{ "configured": false, "authenticated": false, "account": null }
```

All other `/api/auth/*` routes fail closed with HTTP 503. Ordinary and PRO room
entry, playback, and anonymous chat do not depend on this service. The identity,
grouping, and capability contract is defined in the
[account authority ADR](design/account-identity-and-room-authority.md).

## Production activation checkpoint

Account activation was deliberately split from compatible code delivery. The
checked-in production configuration now enables Stage 2 accounts:

```text
service-worker cache at account cutover: v204
MUSIXQUARE_AUTH_DB: musixquare-auth
PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION: 1
PRO_ROOM_MEMBER_AUTHORITY_PROJECTION: 1
```

These are historical cache epochs, not the current product version or current
cache epoch. Read current release identity with
`npm run version:status`. The historical Stage-1 App, signaling, and PRO Worker
checkpoint plus its `v203` client remain the minimum rollback floor. After
account data has been written,
never roll below that matched account-aware checkpoint; use the Stage-2 rollback
procedure in Section 5 instead.

## 1. Create the dedicated D1 database

Create a new production D1 database. Do not reuse the admin metrics, Developer
API, or PRO room data stores. Apply `cloudflare/auth.schema.sql`, then add the
real binding to `cloudflare/wrangler.app.toml`:

```toml
[[d1_databases]]
binding = "MUSIXQUARE_AUTH_DB"
database_name = "<the-created-database-name>"
database_id = "<the-real-database-id>"
```

No placeholder binding is committed because Wrangler would treat it as a
deployable production configuration. D1 contains only random account IDs,
HMAC-pseudonymized Google subjects, account nicknames, and digests of random
session tokens. Google email, OAuth tokens, and raw browser session tokens are
not stored.

New nickname writes accept at most 12 Unicode code points and reject every
Unicode whitespace character. A separate `nickname_key` is derived with NFKC,
fixed-locale lowercase, and NFC normalization. Its partial unique index is the
race-safe source of truth for global nickname ownership; the display nickname
keeps the user's submitted casing. Nicknames are display identities only and
must never replace `accountId` or a room member pseudonym as an authorization
key.

Keep the tracked schema's 20-character constraint and the read/assertion
compatibility boundary unchanged: they grandfather pre-policy nicknames without
making 13-to-20 characters writable again. Do not bulk-rewrite those rows or
prompt merely because of length. There is currently no account-moderation flag
or admin nickname directory; adding either is a separate privacy and audit
design, not a nickname-limit migration step.

Existing production databases require the reviewed, one-time additive migration
before the new nickname contract is considered active:

```text
npm run account:nickname-key:migrate:remote
```

Before applying it, audit completed profiles for normalized collisions and
export the account table to an access-controlled, ignored release artifact.
Deploy the compatible App Worker first, apply the migration, verify every named
profile has a key and no key is duplicated, then run the Stage-2 preflight. An
App version predating `nickname_key` is no longer a safe rollback target after
the migration because an old nickname update would not maintain the key.

## 2. Configure Google OpenID Connect

Create a Google OAuth 2.0 **Web application** client and register this exact
production redirect URI:

```text
https://musixquare.com/api/auth/google/callback
```

The Worker requests only `openid email`. It validates the authorization-code
PKCE verifier, encrypted state, nonce, Google JWKS signature, issuer, audience,
expiry, verified email claim, and subject before creating a session.

Configure the Google OAuth consent-screen branding with the production home
page and the public `https://musixquare.com/privacy` and
`https://musixquare.com/terms` links. The email claim is checked only to require
a Google-verified account; it is not stored or used as the account key. The
verified Google subject is HMAC-pseudonymized before it reaches D1.

## 3. Add Worker secrets

Set the OAuth/session values as App Worker secrets; never put them in `[vars]`
or Git:

```text
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
MXQR_AUTH_SESSION_PEPPER
MXQR_AUTH_SUBJECT_PEPPER
MXQR_OAUTH_STATE_SECRET
```

All three MUSIXQUARE secrets must be independent high-entropy values of at
least 32 characters. `MXQR_AUTH_SESSION_PEPPER` protects stored session-token
digests, so rotating it signs every browser out. `MXQR_AUTH_SUBJECT_PEPPER`
protects the stable Google-subject pseudonym and must not be rotated without a
purpose-built account migration or an intentional account reset. Keeping the
two purposes separate lets an incident-response session rotation avoid
orphaning existing accounts.

Account-aware standard rooms additionally require one shared, independent
secret on **both** the App Worker and Signaling Worker:

```text
MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET
```

Use the same high-entropy value (at least 32 characters) on both services. It
signs 60-second, audience-, room-, peer-, and role-bound assertions. The
Signaling Worker derives a room-generation pseudonym from the assertion and
never publishes the account identifier. If the secret is absent or mismatched,
login still works but standard-room participants intentionally remain
anonymous. Keep this secret independent from the corresponding PRO-room
assertion secret so a compromise in either service cannot mint identities for
the other trust boundary.

Account-aware PRO rooms require a different shared secret on **only** the App
Worker and PRO Worker:

```text
MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET
```

Never reuse the ordinary-room value. PRO assertions are likewise short-lived
and bound to their room and assertion audience. The trusted App facade injects
the assertion into the exact room request; the PRO Worker binds the verified
account to the participant represented by that room-session cookie. The PRO
Durable Object also retains a short account-deletion tombstone so an assertion
minted immediately before deletion cannot arrive late and recreate the purged
member or authority record.

`MXQR_AUTH_REDIRECT_URI` is optional and defaults to the production URI above.
It exists for exact localhost/staging OAuth clients only; it must still end in
`/api/auth/google/callback` and must never contain a query or fragment.

## 4. Data lifecycle and account deletion

The OAuth flow cookie and consumed-state digest expire after about ten minutes.
Installed/mobile same-context login keeps the exact return route in
`sessionStorage` for that same ten-minute window. Because an installed PWA may
be closed while Google owns its navigation context and later relaunch at the
manifest `/` start URL, the app also keeps one `localStorage` recovery hint
containing only `/0xxxxx`, a random attempt correlation ID, and its creation
time. That durable hint restores a path only: it is never account, room, or
same-tab takeover proof, and it contains no OAuth token, PRO PIN, claim, or
session secret. Setup consumes it once; explicit session leave, abandoned
anchor navigation, corruption, and expiry remove it. Only the live
`sessionStorage` marker that captured an already-active PRO presence may use
the existing same-context reclaim path. A pre-entry route hint or relaunched
PWA still receives the normal active-tab confirmation.

Each account session has a fixed maximum lifetime of 30 days from creation, and
one account retains at most 128 browser sessions; issuing another session
removes the least recently used excess sessions. Sign-out removes the current
session, sign-out-all removes every session for the account, and account
deletion removes the active account row and all of its account-session rows.
Immediately before deletion, the same D1 transaction copies at most 128 session
digests into `mxqr_account_deleted_sessions` for ten minutes. Those rows can
mint only a separate Standard-room deletion assertion: they cannot authenticate
an account or mint an attachment assertion. This lets the deleting browser and
other signed-in devices revoke a remembered ordinary-room grant without
reusing live account authority. Sign-out and sign-out-all never create these
tombstones. Scheduled cleanup removes expired flow, session, and deleted-session
rows.

D1 Time Travel may retain provider-managed point-in-time recovery data for the
applicable Cloudflare backup window after a row is deleted. Public copy must
describe deletion from the active database and must not promise immediate
erasure from every recovery copy.

Before a signed-in account assertion can reach a PRO room, the App Worker writes
a conservative account-to-room edge to `mxqr_account_pro_rooms`. Account
deletion enumerates those edges and wakes each room Durable Object to remove the
account member, delegated authority, owner association, presence, and active
room sessions. The purge is idempotent. If any room cannot be purged, deletion
returns `503 ACCOUNT_DELETE_CLEANUP_UNAVAILABLE` and keeps the account and
reverse index so the user can retry safely; rooms already purged remain safe to
purge again. The reverse index is atomically capped at 1,000 rooms per account;
an existing edge may still refresh at that limit, but a new account-to-room
edge is rejected so the synchronous deletion fan-out always remains bounded.

A PRO room cookie does not carry account authority for its full 30-day life.
Each physical room session instead holds a 120-second account-identity lease,
re-proved through the App Worker every 40 seconds. Renewal can extend only an
already-linked session for the same verified account and does not rewrite the
D1 account-to-room edge or advance a public room revision. The client also
reconciles on foreground/resume. When the lease expires, that one device is
downgraded to an anonymous `Peer N` without disconnecting it, changing playback,
or revoking the persistent account member, owner link, delegated grant, or other
verified devices. A signed-in tab can attach again after background expiry.
Logout detaches the current tab immediately; logout-all makes other tabs lose
account-derived authority within the bounded 120-second window even if they
receive no cross-tab event. A transient App/D1 failure cannot extend the lease
and therefore receives only the lease's remaining time as grace.

Each successful or idempotent purge writes a bounded, expiring tombstone in the
room before returning. New account assertions are rejected while that tombstone
is live. Its lifetime is deliberately longer than the assertion acceptance
window, closing the race where an already-minted request reaches a sleeping
room after the deletion purge.

Only after every linked room confirms cleanup does the App Worker remove the
active account, account sessions, and reverse-index rows. A later Google login
creates a new random account ID, so a stale room record cannot restore the old
grant. Account deletion does not delete media already shared into a
collaborative PRO playlist: that media remains governed by the room's playlist
references and retention policy. Ordinary-room account identity is held only by
the live room generation and its short signed lease, never by the account D1
reverse index. An ordinary-room delete frame is accepted only with the distinct
deletion-audience assertion bound to that room, physical peer, and role; neither
a current attachment nor a normal account assertion is deletion authority.

The separate PRO owner-recovery credential is a room recovery secret, not an
account session. Account deletion unlinks the deleted account from ownership
and delegated authority but deliberately does not decommission the PRO room or
erase that independent recovery credential. A room owner must use the PRO room
decommission action when the room itself, its recovery path, and its retained
playlist data should all be destroyed.

Revoking MUSIXQUARE in Google Security Settings stops future Google
authorization but does not delete the MUSIXQUARE account or immediately revoke
an already-issued MUSIXQUARE session. Users must use the MUSIXQUARE account
menu for account deletion.

## 5. Activation, verification, and rollback

### Stage 1: deploy the compatibility baseline

Before any account infrastructure is enabled, run the focused Worker tests and
production guards:

```text
npm test -- src/core/__tests__/account-auth.test.ts
npm run check:workers
npm run build:checked
```

Deploy the account-aware App, signaling, and PRO Workers with auth D1 unbound and
both projection flags at `0`, then publish service-worker `v203`. Verify the
session endpoint reports `configured:false`, anonymous ordinary and PRO rooms
remain functional, and PRO retains its pre-account equal-member compatibility
behavior. Record the three Worker version IDs as the matched rollback floor.

### Stage 2: enable accounts

Perform Sections 1-3, then apply the following as one reviewed activation:

Before changing either projection flag, run the dedicated manual preflight:

```text
npm run account:stage2:preflight -- --remote --confirm-production --callback https://musixquare.com/api/auth/google/callback --ack-deploy-order pro-room,signaling,app
```

This command is intentionally absent from normal build, test, and deploy
scripts. It refuses to contact Cloudflare unless both remote-production flags
are present. Even then it performs only these read-only operations:

- parse the checked-in App config and require one real, dedicated
  `MUSIXQUARE_AUTH_DB` binding;
- run a `SELECT` against remote D1 `sqlite_master` and compare the exact account
  table/index set and normalized definitions with `cloudflare/auth.schema.sql`;
- run `wrangler secret list --format json` for App, signaling, and PRO and check only
  required secret **names**; secret values are never requested or printed;
- exercise the PRO, Standard attach, and Standard deletion assertion codecs
  locally with a one-use in-memory key; and
- require an explicit acknowledgement of the only supported activation order:
  PRO, then signaling, then App/static.

Copy the callback argument from the production Google Web-client settings. The
script verifies that the acknowledgement and the Worker's built-in default are
exactly `https://musixquare.com/api/auth/google/callback`. It cannot read the
Google console itself. It also rejects a production `MXQR_AUTH_REDIRECT_URI`
Worker secret because Wrangler exposes only its name, making its value
impossible to verify; production should use the reviewed built-in default.

Secret-name presence cannot prove that the shared assertion values match. The
local round trip proves codec compatibility without sending an account or
writing a canary record, while the post-deployment login/room smoke below is the
required end-to-end check for App↔signaling and App↔PRO secret equality. The
preflight never creates a D1 database, applies schema, changes projection flags,
or deploys a Worker.

1. Confirm the D1 schema is current and the App binding is present.
2. Confirm the exact Google callback and consent-screen links.
3. Confirm App OAuth/session secrets, the shared App+signaling standard-room
   assertion secret, and the separate shared App+PRO assertion secret.
4. Change both `PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION` and
   `PRO_ROOM_MEMBER_AUTHORITY_PROJECTION` to `1`; do not operate indefinitely
   with one flag enabled.
5. Deploy PRO first, signaling second, and App/static last. Do not publish the
   App while either downstream Worker is still on its pre-activation version.

Verify that the session endpoint now reports `configured:true`, complete one
login and nickname update, then test logout, logout-all, 120-second PRO lease
expiry/reattach, account deletion, and scheduled expiry cleanup. Exercise one
account on several devices, persistent PRO delegation/offline revoke, ordinary
room-lifetime grants, account-wide kick, and every capability allow/deny path.
Account cookies are host-only, Secure, HttpOnly, SameSite=Lax opaque values. The
App Worker's PRO facade does not forward them as PRO cookies.

Before making login visible, also verify that the published Privacy Policy,
Terms, FAQ, and all locale dictionaries describe login as optional, distinguish
ordinary-room and PRO-room authority lifetimes, and explain that account
permissions are purged while already-shared room media follows the room
retention policy. Test deletion across both awake and sleeping PRO rooms,
including partial failure/retry and a late assertion rejected by the room
tombstone.

To roll Stage 2 back, first hide/disable login and return **both** PRO projection
flags to `0`. If code rollback is necessary, use only the matched Stage-1 App,
PRO, signaling, and `v203` checkpoint. Never roll below that floor after account
members, grants, reverse edges, or deletion tombstones have been written. Keep
`MUSIXQUARE_AUTH_DB` bound and retain its schema so scheduled expiry and account
cleanup continue. Removing one OAuth/session secret makes account routes report
`configured:false` without deleting room data. Do not delete D1, remove reverse
indexes/tombstones, rotate the subject pepper, or delete PRO Durable Object/R2
data as part of an application rollback.

Projection `0` deliberately restores the historical PIN-admitted equal-member
PRO policy. If that temporary authority expansion is unsafe for the incident,
put PRO entry into maintenance instead of rolling past the least-privilege
activation.
