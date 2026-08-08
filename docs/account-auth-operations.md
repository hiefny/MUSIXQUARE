# Account authentication provisioning

The optional account service is implemented in `cloudflare/account-auth.js`,
but it deliberately stays disabled until its dedicated D1 database and all
server-only secrets are provisioned. When any requirement is missing,
`GET /api/auth/session` returns:

```json
{ "configured": false, "authenticated": false, "account": null, "statsScope": null }
```

All other `/api/auth/*` routes fail closed with HTTP 503. Ordinary and PRO room
entry, playback, and anonymous chat do not depend on this service. The identity,
grouping, and capability contract is defined in the
[account authority ADR](design/account-identity-and-room-authority.md).

## Production configuration

Account identity and least-privilege PRO authority are current-contract
invariants. They no longer have rollout flags. Anonymous users remain supported
and receive session-scoped room membership. The production configuration keeps
the dedicated account database bound:

```text
MUSIXQUARE_AUTH_DB: musixquare-auth
```

Read current release identity with `npm run version:status`. Treat the deployed
App, signaling, and PRO Workers plus the current client as one matched rollback
unit. Once account data exists, never roll back to a pre-account schema or
authorization model.

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
HMAC-pseudonymized Google subjects, account nicknames, three account-scoped
lifetime aggregate counters, and digests of random session tokens. The counters
record only sessions joined, listening seconds, and tracks played; they contain
no room code, media identity, title, event timestamp, or per-play history.
Google email, OAuth tokens, and raw browser session tokens are not stored.

New nickname writes accept at most 12 Unicode code points and reject every
Unicode whitespace character. A separate `nickname_key` is derived with NFKC,
fixed-locale lowercase, and NFC normalization. Its partial unique index is the
race-safe source of truth for global nickname ownership; the display nickname
keeps the user's submitted casing. Nicknames are display identities only and
must never replace `accountId` or a room member pseudonym as an authorization
key.

The tracked schema includes `nickname_key` and its partial unique index. Verify
that every named profile has a key and no key is duplicated before deployment.
There is currently no account-moderation flag or admin nickname directory;
adding either is a separate privacy and audit design.

Reusable PRO room codes use the generation-aware reverse index
`mxqr_account_pro_room_generations` exclusively. A fresh database receives that
table from `cloudflare/auth.schema.sql`. Verify its composite
`(account_id, room_code, room_generation)` primary key and account index before
enabling account-aware PRO traffic. Do not introduce a room-code-only reverse
index: every write, deletion lookup, and cleanup must identify one exact room
incarnation.

The baseline schema also contains the one-to-one account statistics table. Do
not expose `/api/auth/stats` when that table or its constraints do not match
`cloudflare/auth.schema.sql`. Historical migration SQL remains immutable audit
evidence; it is not part of a fresh launch deployment.

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
and bound to their public room code, immutable `roomGeneration`, and assertion
audience. The generation is required even when its value is `0`. The trusted
App facade injects the assertion into the exact room-incarnation request; the
PRO Worker rejects a missing or mismatched generation before binding the
verified account to the participant represented by that room-session cookie.
The PRO Durable Object also retains a short
account-deletion tombstone so an assertion minted immediately before deletion
cannot arrive late and recreate the purged member or authority record.

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
An optional one-to-one statistics row keeps only the three nonnegative lifetime
aggregates described above. Missing rows read as zero. Statistics writes accept
bounded positive deltas from an authenticated same-origin client. Each
authenticated session response also carries a short opaque `statsScope`, and
the client echoes it in `X-MXQR-Account-Stats-Scope` on a statistics PATCH. The
value is a purpose-separated HMAC fence for that exact session—not an account
identifier or authorization credential—and is never stored in the statistics
table. A stale scope is rejected before any write, so activity queued before a
browser switches accounts cannot be attributed to the new cookie session.
Statistics are deliberately unsuitable for ranking, rewards, billing, or
authorization because they are user-facing approximate counters rather than
an event ledger.
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
a conservative account-to-room-incarnation edge in
`mxqr_account_pro_room_generations`. Account deletion enumerates the distinct
`(roomCode, roomGeneration)` edges and wakes only that
exact Durable Object to remove the account member, delegated authority, owner
association, presence, and active room sessions. An old account edge can never
purge a later owner who received the same public code. Cleanup of an already
decommissioned incarnation is idempotent success; it must not be redirected to
the current generation.

Once a room incarnation has completed its full decommission protocol and the
admin registry records `decommissioned`, the App Worker removes only that exact
generation's account reverse edges. This happens immediately when an admin
request observes completion, through a recent-completion sweep on the minute
trigger when the room's own alarm completes without another admin request, and
through the six-hour full repair sweep over immutable generation history. The
room's durable generation tombstone remains the authorization fence. Terminal
room history therefore cannot consume an account's live cleanup budget or
inflate a future account deletion forever.

Deletion with at most 32 linked incarnations remains synchronous. If any such
incarnation cannot be purged, deletion returns
`503 ACCOUNT_DELETE_CLEANUP_UNAVAILABLE` and keeps the account and remaining
reverse index so the user can retry safely; incarnations already purged remain
safe to purge again.

For larger fan-out, the delete request atomically disables the account, copies
at most 128 session digests into the ten-minute deletion-only tombstone table,
revokes all live sessions, and returns `202 { ok:true, pending:true }`. The App
Worker immediately starts an exact-generation cleanup continuation and a
one-minute cron resumes durable jobs after interruption. Each confirmed,
idempotent room purge deletes only its matching reverse edge. The account row is
removed after no edge remains; a failed edge stays queued while the account
remains disabled and cannot log in, attach, or create new authority.
The aggregate statistics row follows the same boundary: it may remain while a
disabled account's durable PRO cleanup is pending, but it cannot be read or
updated after sessions are revoked and is removed by the final account-row
cascade. Statistics are never copied into the ten-minute deletion-only session
tombstone.

The reverse index is atomically capped at 1,000 distinct incarnations per
account; an existing edge may still refresh at that limit, but a new
account-to-incarnation edge is rejected. This bounds both inline and background
cleanup work.

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
disabled account and reverse-index rows. A later Google login
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

## 5. Production verification and rollback

Before every account release, run the focused Worker tests and production
guards:

```text
npm test -- src/core/__tests__/account-auth.test.ts
npm run check:workers
npm run build:checked
```

Use the checked-in schema and configuration as the launch baseline:

1. Confirm the D1 schema exactly matches `cloudflare/auth.schema.sql` and the
   App binding is present.
2. Confirm the exact Google callback and consent-screen links.
3. Confirm App OAuth/session secrets, the shared App+signaling standard-room
   assertion secret, and the separate shared App+PRO assertion secret.
4. Confirm the retired PRO account projection flags are absent.
5. Deploy PRO first, signaling second, and App/static last for a cross-service
   account contract change.

For a reusable-code release, verify the canonical generation-aware auth schema
before the Worker release and use the broader dependency order in the PRO
operations ADR: PRO, remote-share, signaling, Developer API facade/API, then
App/static. Keep manual re-registration unused until every generation-aware
smoke passes. Once the
reuse cutover is marked `ready`, a concurrent administrator may create a later
generation at any moment, so the matched generation-aware Worker set and D1
schemas are a permanent rollback floor even before a generation-`1` row is
observed. The cutover row retains this fact in `ever_enabled` and the original
`floor_release_sha` even while a later release temporarily fences the current
status as `disabled`. A generation-blind App could purge or assert against the
wrong owner, so recovery must forward-fix or restore a matched provider
checkpoint rather than dropping the composite reverse index.

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

To disable login during an incident, remove or rotate the affected OAuth/session
secret and deploy a matched account-aware Worker set. Never roll below the
generation-aware account schema after members, grants, reverse edges, or
deletion tombstones have been written. Keep
`MUSIXQUARE_AUTH_DB` bound and retain its schema so scheduled expiry and account
cleanup continue. Removing one OAuth/session secret makes account routes report
`configured:false` without deleting room data. Do not delete D1, remove reverse
indexes/tombstones, rotate the subject pepper, or delete PRO Durable Object/R2
data as part of an application rollback.

Do not use projection `0` as a routine rollback: it expands PIN-admitted PRO
authority. Put PRO entry into maintenance and forward-fix when the current
least-privilege contract cannot be preserved safely.
