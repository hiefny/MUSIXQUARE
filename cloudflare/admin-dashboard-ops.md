# MUSIXQUARE Admin Dashboard Ops

The `/admin` dashboard is served by `musixquare-app` and reads aggregate room
metrics plus the operator-managed PRO room registry from a shared D1 database.
The signaling Worker writes minute-level counters for successful session
transitions and rejected signaling traffic. The App Worker owns PRO registry
mutations and its bounded operator audit.

The production database identity, APAC region, schema, and event inventory were
last reconciled with Wrangler and both Workers on 2026-07-16.

## Data Model

Ordinary room codes, peer IDs, IP addresses, raw Access identities, and user
agents are not stored. The PRO registry necessarily stores its explicitly
registered `0xxxxx` room codes, current immutable `room_generation`, and
operator labels. A six-digit room code is a reusable public address; the
authorization identity is `(room_code, room_generation)`. Existing rooms are
generation `0`. `mxqr_pro_room_generation_history` keeps one immutable
decommission-completion row per deleted incarnation so an administrator can
verify a completed deletion before manually advancing the public address.
`mxqr_pro_room_generation_allocations` is a separate immutable ledger for
every allocated incarnation, including the current active or in-progress one;
losing or corrupting a mutable registry pointer must never make generation `0`
available again.

An operator label is mutable display metadata, not part of room authority. Edit
it from the expanded room card only after the dashboard has loaded the current
immutable `room_generation`. The write compares both the room code and
generation, rejects provisioning or terminal incarnations, and records only the
pseudonymous actor, action/result, code, generation, and timestamp in the audit
table. Old and new label text are deliberately excluded from audit records.
Changing a label never changes ownership, activation, credentials, Durable
Object identity, or storage paths.

The audit stores a session-scoped HMAC actor pseudonym, action/result, PRO room
code, immutable room generation, and timestamp only. It must never store a PIN,
activation or owner-recovery claim, bearer URL, admin cookie, account
identifier, or Access token.

Events:

| Event                      | Meaning                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `room_opened`              | A host created a fresh room.                                                             |
| `host_reconnected`         | A host reclaimed or refreshed an existing room.                                          |
| `guest_joined`             | A guest successfully joined.                                                             |
| `guest_host_unavailable`   | A guest tried to join a missing room.                                                    |
| `guest_auth_pending`       | A password-protected guest reached the password prompt.                                  |
| `guest_auth_failed`        | A guest submitted a missing or invalid room password.                                    |
| `guest_auth_timeout`       | A guest password prompt timed out.                                                       |
| `guest_reconnect_denied`   | A same-identity reconnect used the wrong or missing reconnect secret.                    |
| `guest_reconnect_conflict` | A reconnect collided with another pending or live owner of that identity.                |
| `guest_room_full`          | A new guest was rejected because the room reached its active-guest limit.                |
| `guest_pending_capacity`   | A connection was rejected because every bounded pending slot was already authenticating. |
| `guest_identity_capacity`  | A new identity was rejected because the reconnect-binding limit was reached.             |
| `ws_message_oversized`     | A WebSocket frame or validated signaling payload exceeded its size limit.                |
| `ws_message_rate_limited`  | A guest exceeded the per-connection signaling message rate.                              |

Metric writes are deferred with the Worker execution context, so D1 latency is
not part of the room admission path. They are operational counters rather than
an authentication or billing source of truth.

`room_opened` also advances the aggregate-only
`mxqr_lifetime_metric_totals` row. Unlike the minute buckets, this counter is
not subject to operational retention. Its trigger watches only the fresh
standard-room event, so PRO activity and `host_reconnected` never contribute.
The App Worker injects a cached daily snapshot into `/about` as the validated
`data-mxqr-rooms-opened` attribute on the document element; the browser makes
no additional metrics request.

## First-Frame-Only Host Authentication

As of 2026-07-22, standard-room hosts authenticate only by sending their random
ownership secret in the first WebSocket frame. The `?secret=` query no longer
grants host ownership, and signaling no longer emits `host_legacy_url_auth`.
The `host-auth` first frame, its timeout, and the rule that a candidate cannot
replace the live host before successful authentication remain permanent.

This removal used an explicit owner-approved **prelaunch exception** to the
previous 30-day rollout and seven-consecutive-zero-days gates. At the decision
time:

- production D1 contained two legacy-auth events dated 2026-07-18 through
  2026-07-19 and no newer legacy-auth event;
- the beta cohort was very small, had not been promoted publicly, and every
  known user was contactable and recoverable by refreshing to the current app;
- the owner accepted that a cached pre-first-frame client could require that
  recovery after the signaling cutover; and
- first-frame host creation and reconnect remained required live-smoke gates
  for the production deployment.

The historical D1 metric buckets are harmless operational history, not
credentials or authentication state. They require no deletion or migration.
Because `host_legacy_url_auth` is no longer in the current event inventory, the
dashboard summary ignores those rows while the raw retention data remains
available for audit.

## Cloudflare Setup

The production D1 database is already created:

- Name: `musixquare-admin-metrics`
- Region: APAC
- Binding: `MUSIXQUARE_ADMIN_DB`
- Database ID: `d6cc9ceb-f0b6-40e4-99aa-8f28bec412ed`

If the database ever needs to be recreated:

```powershell
npx wrangler d1 create musixquare-admin-metrics
```

Copy the returned `database_id`, then update the active `[[d1_databases]]`
blocks in all three files:

- `cloudflare/wrangler.app.toml`
- `cloudflare/wrangler.signaling.toml`
- `cloudflare/wrangler.pro-room.toml`

Apply or re-apply the schema:

```powershell
npx wrangler d1 execute musixquare-admin-metrics --remote --file cloudflare/admin-metrics.schema.sql
```

The private-beta generation migration is complete and is not a routine or
replayable production path. Its checked-in SQL remains immutable audit history;
do not execute it against launch production. If the live database loses any
generation allocation, history, registry-pointer, or cutover object, restore a
matched D1 Time Travel/provider checkpoint and repair forward.

Launch production must retain `ever_enabled=1` and a valid immutable
`floor_release_sha` on the `mxqr_pro_room_generation_cutover` singleton. The
release workflow deliberately refuses a full rollout when that floor is missing
or is not an ancestor of the candidate. Do not recreate it by replaying the old
room ceremony, delete a tombstone, or decrement a generation to recover from an
operator error.

Set or rotate the admin secrets on the app Worker:

```powershell
npx wrangler secret put MXQR_ADMIN_PASSWORD --config cloudflare/wrangler.app.toml
npx wrangler secret put MXQR_ADMIN_SESSION_SECRET --config cloudflare/wrangler.app.toml
```

`MXQR_ADMIN_SESSION_SECRET` should be a long random string. It signs the
HttpOnly admin session cookie.

After the schema and D1 bindings are committed, push the reviewed commit to
`main` and run the `Production Release` workflow with target `all`. The workflow
first proves the immutable `floor_release_sha` is an ancestor of the candidate,
then temporarily sets the cutover to `disabled`. It deploys PRO, signaling, both
Developer API Workers, and App in dependency order, reuses the validated Static
Assets artifact, runs live smokes, and verifies final deployment ownership.
Only after every gate succeeds does it restore `ready` with the exact reviewed
40-character release SHA. A failed release leaves the status disabled without
clearing `ever_enabled` or the permanent floor; a later successful full release
may restore readiness after repeating the same floor and ownership checks.
Do not hand-edit it merely to unblock an operator action. Do not deploy the
Wrangler configs directly or use the local `deploy:*` primitives for routine
releases; the exceptional operator path is documented in
`docs/hotfix-procedure.md`.

## Manual Re-registration of a Decommissioned Code

There is no automatic room-code recycling. Before an administrator selects
**Register** for a previously deleted code:

1. Read the registry and require `status='decommissioned'` for its current
   generation. A `decommissioning` or unknown state is a hard stop.
2. Read the cutover singleton and require `status='ready'` with the exact SHA of
   the generation-aware production release. A missing/malformed row or a SHA
   mismatch is a hard stop.
3. Confirm the generation-history and allocation-ledger rows both exist for
   that exact pair and the history records the same completed deletion. Do not
   infer completion from elapsed wall-clock time.
4. Inspect the old generation's PRO/signaling/limiter state, Developer API keys
   and tombstone, and R2 prefix directly in the relevant Cloudflare provider
   views after the presigned-URL fence and one-hour continuous-empty window.
   Launch runtime exposes no combined deletion-evidence endpoint. The terminal
   registry status is necessary but not a substitute for provider evidence; if
   any store cannot be inspected, stop rather than deleting a tombstone to force
   registration.
5. Register through the Access-protected dashboard. The D1 transaction inserts
   the next immutable allocation and increments `room_generation` exactly once
   before provisioning the distinct Durable Object. Retry a failed
   provisioning row; do not submit another allocation.
6. Verify public bootstrap exposes only the new generation, an old browser
   session/claim/ticket/API key is rejected, and a new activation link works.

The registry capacity limit counts rows whose status is not
`decommissioned`; completed generations live in the separate history table and
do not consume one of the 1,000 active/in-progress slots. Registration uses a
single conditional D1 write so concurrent operators cannot both bypass the
limit or allocate two generations.

The dashboard remains at:

```text
https://musixquare.com/admin
```

## Notes

- Before the D1 binding is configured, `/admin` still loads but metrics return
  `ADMIN_DB_NOT_CONFIGURED` and PRO room management returns
  `PRO_ROOM_ADMIN_NOT_CONFIGURED`.
- Before the schema is applied, metrics return `ADMIN_METRICS_SCHEMA_MISSING`.
- The dashboard starts showing useful data only after the signaling Worker has
  been redeployed with the D1 binding.
- The dashboard reads the most recent 30 days. The app Worker's six-hour
  scheduled task retains 90 days of aggregate history and removes older rows
  independently from the Soro refresh, so a D1 cleanup failure cannot block
  blog maintenance or user traffic.
- `mxqr_lifetime_metric_totals` is outside that deletion path. Its
  `room_opened` row is permanent and is seeded from retained buckets when the
  lifetime-counter migration is first applied.
- The same scheduled event independently retains 365 days of PRO admin audit
  metadata. Audit cleanup failure does not cancel metrics cleanup or Soro
  refresh and never weakens claim issuance auditing.
- Historical event names that are no longer in the 15-event inventory are
  ignored by current dashboard summaries. Keep them only while their audit
  value is useful.

## D1 Drift and Retention Check

Inspect table names and aggregate row ages without exposing user data:

```powershell
npm run wrangler -- d1 execute musixquare-admin-metrics --remote --json --command "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name; SELECT MIN(bucket_minute) AS oldest_minute, MAX(bucket_minute) AS newest_minute, COUNT(*) AS rows FROM mxqr_metric_buckets;"
```

The tracked application tables are `mxqr_metric_buckets`,
`mxqr_lifetime_metric_totals`,
`mxqr_pro_room_registry`, `mxqr_pro_room_generation_history`,
`mxqr_pro_room_generation_allocations`,
`mxqr_pro_room_generation_cutover`, and `mxqr_pro_room_admin_audit`; `_cf_KV`
is managed by Cloudflare. Applying `admin-metrics.schema.sql` also removes the
retired `mxqr_api_rate_limits` table, which has no current Worker reader or
writer. The current registry is capped by application policy; generation
history and the allocation ledger are immutable and unbounded by that
active-room cap; the cutover row is a singleton release fence; and the audit
contains metadata, never credentials. For any other unexpected table, first
search the deployed Worker source, take a D1 export or confirm Time Travel
coverage, and record the maintenance decision.

The runtime retention cutoff is 90 days. To audit what the next scheduled
cleanup would remove, preview the affected row count with:

```sql
SELECT COUNT(*)
FROM mxqr_metric_buckets
WHERE bucket_minute < CAST(strftime('%s', 'now', '-90 days') AS INTEGER) / 60;
```
