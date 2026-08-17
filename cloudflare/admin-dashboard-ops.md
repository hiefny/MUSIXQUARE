# MUSIXQUARE Admin Dashboard Ops

The `/admin` dashboard is served by `musixquare-app` and reads aggregate room
metrics plus the operator-managed PRO room registry from a shared D1 database.
The signaling Worker writes minute-level counters for successful session
transitions and rejected signaling traffic. The Remote Share Worker writes the
three upload-assertion rollout counters to the same aggregate table. The App
Worker owns operator/admin registry mutations and the bounded operator audit;
the PRO Worker writes activation, suspension, decommission, and generation
history projections for its room lifecycle.

The checked-in database identity, schema, binding consumers, and 17-event
inventory were last reconciled with the current Worker sources on 2026-08-17.
That source review is not proof of the live D1 table set; use the read-only drift
query below before production schema maintenance.

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

| Event                                    | Meaning                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `room_opened`                            | A host created a fresh room.                                                                                                          |
| `host_reconnected`                       | A host reclaimed or refreshed an existing room.                                                                                       |
| `guest_joined`                           | A guest successfully joined.                                                                                                          |
| `guest_host_unavailable`                 | A guest tried to join a missing room.                                                                                                 |
| `guest_auth_pending`                     | A password-protected guest reached the password prompt.                                                                               |
| `guest_auth_failed`                      | A guest submitted a missing or invalid room password.                                                                                 |
| `guest_auth_timeout`                     | A guest password prompt timed out.                                                                                                    |
| `guest_reconnect_denied`                 | A same-identity reconnect used the wrong or missing reconnect secret.                                                                 |
| `guest_reconnect_conflict`               | A reconnect collided with another pending or live owner of that identity.                                                             |
| `guest_room_full`                        | A new guest was rejected because the room reached its active-guest limit.                                                             |
| `guest_pending_capacity`                 | A connection was rejected because every bounded pending slot was already authenticating.                                              |
| `guest_identity_capacity`                | A new identity was rejected because the reconnect-binding limit was reached.                                                          |
| `remote_share_upload_assertion_verified` | A new Remote Share reservation was issued with a valid signaling-issued current-host assertion; exact v3 replay does not count again. |
| `remote_share_upload_assertion_legacy`   | A new assertion-free Remote Share reservation was issued; this is a post-cutover regression sentinel that must remain zero.           |
| `remote_share_upload_assertion_rejected` | A required or presented assertion was missing or invalid; writes are capped at 10 per IP-derived limiter key per normal rate window.  |
| `ws_message_oversized`                   | A WebSocket frame or validated signaling payload exceeded its size limit.                                                             |
| `ws_message_rate_limited`                | A guest exceeded the per-connection signaling message rate.                                                                           |

Metric writes are deferred with the Worker execution context, so D1 latency is
not part of the room admission path. They are operational counters rather than
an authentication or billing source of truth.

The three Remote Share assertion counters are likewise aggregate-only. They
carry no room, peer, actor, request, token, body digest, object, capability, or
IP dimensions. Production permanently requires assertions; the owner-approved
cutover record and regression response are documented in
[`remote-share-ops.md`](remote-share-ops.md).

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
npm run wrangler -- d1 create musixquare-admin-metrics
```

Copy the returned `database_id`, then update the active `[[d1_databases]]`
blocks in all four files:

- `cloudflare/wrangler.app.toml`
- `cloudflare/wrangler.signaling.toml`
- `cloudflare/wrangler.pro-room.toml`
- `cloudflare/wrangler.remote-share.toml`

Apply or re-apply the schema:

```powershell
npm run wrangler -- d1 execute musixquare-admin-metrics --remote --file cloudflare/admin-metrics.schema.sql
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
npm run wrangler -- secret put MXQR_ADMIN_PASSWORD --config cloudflare/wrangler.app.toml
npm run wrangler -- secret put MXQR_ADMIN_SESSION_SECRET --config cloudflare/wrangler.app.toml
```

`MXQR_ADMIN_PASSWORD` must be a randomly generated value whose UTF-8 encoding is
between 16 and 256 bytes. A missing, shorter, or longer value leaves the admin
login fail-closed as `ADMIN_NOT_CONFIGURED`; do not use a human phrase merely to
satisfy the byte floor. `MXQR_ADMIN_SESSION_SECRET` must be a separate randomly
generated string of at least 32 characters. It signs the domain-separated,
exactly 12-hour HttpOnly admin session cookie.

Both values are consumed exactly as stored: leading and trailing whitespace is
part of the password or signing secret. When entering them through a shell or
secret prompt, avoid accidental spaces/newlines and never add quotes unless the
secret-management command explicitly documents that quoting syntax.

The domain-separated session format intentionally rejects cookies issued by
older App Worker revisions. After a release that changes this contract, verify
that the existing cookie is rejected and sign in again through Cloudflare
Access plus the MUSIXQUARE password.

After the schema and D1 bindings are committed, push the reviewed commit to
`main` and run the `Production Release` workflow with target `all`. The workflow
first proves the immutable `floor_release_sha` is an ancestor of the candidate,
then temporarily sets the cutover to `disabled`. It deploys PRO, remote-share,
signaling, both Developer API Workers, and App in dependency order, reuses the
validated Static Assets artifact, runs live smokes, and verifies final
deployment ownership.
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
- The dashboard starts showing room/signaling data only after the signaling
  Worker has been redeployed with the D1 binding. Remote Share assertion
  counters additionally require that Worker's matching binding.
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
- Historical event names that are no longer in the 17-event inventory are
  ignored by current dashboard summaries. Keep them only while their audit
  value is useful.

## D1 Drift and Retention Check

### Runtime schema-initialization measurement

The App Worker emits one sampled custom-log event per isolate and bound Admin
D1 instance when `ensureAdminProRoomRegistry` initializes. The event name is
`admin_pro_room_registry_schema_ensure`; it contains only `outcome`,
`durationMs`, the total statement count, and aggregate read/write/DDL/other
counts. It contains no SQL text, room code, actor, account, request, or binding
identifier. Cloudflare's configured custom-log sampling applies to this event.

Review a continuous 14-day window before changing the initializer. Implement a
read-only readiness fast path only when at least one of these measured
conditions is true:

- initialization p95 exceeds 100 ms;
- initialization exceeds 10% of the affected admin/grant request latency; or
- initialization statements exceed 1% of the App Worker's observed D1
  operations.

The first optimization must be additive: a complete schema returns after one
read-only readiness probe, while an incomplete or ambiguous schema falls back
to the existing initializer. Do not remove ALTER/backfill/self-healing paths
until the release preflight independently verifies every required table,
column, index, and trigger in production.

Inspect table names and aggregate row ages without exposing user data:

```powershell
npm run wrangler -- d1 execute musixquare-admin-metrics --remote --json --command "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name; SELECT MIN(bucket_minute) AS oldest_minute, MAX(bucket_minute) AS newest_minute, COUNT(*) AS rows FROM mxqr_metric_buckets;"
```

The declarative baseline currently defines these 18 application tables; `_cf_KV`
is managed by Cloudflare:

- metrics: `mxqr_metric_buckets`, `mxqr_lifetime_metric_totals`;
- registry and generation: `mxqr_pro_room_registry`,
  `mxqr_pro_room_generation_history`,
  `mxqr_pro_room_generation_allocations`,
  `mxqr_pro_room_generation_cutover`, `mxqr_pro_room_admin_audit`;
- owner transfer: `mxqr_pro_room_owner_transfer_sagas`,
  `mxqr_pro_room_owner_transfer_issuances`;
- grants and entitlements: `mxqr_pro_grant_campaigns`,
  `mxqr_pro_grant_voucher_batches`, `mxqr_pro_grant_vouchers`,
  `mxqr_pro_grant_account_fences`, `mxqr_pro_grants`,
  `mxqr_pro_grant_allocations`, `mxqr_pro_account_entitlements`,
  `mxqr_pro_grant_redemptions`, and `mxqr_pro_grant_audit`.

`cloudflare/admin-metrics.schema.sql` is the canonical table/trigger/index
inventory. Applying it also removes the retired `mxqr_api_rate_limits` table,
which has no current Worker reader or writer. The current registry is capped by
application policy; generation history and the allocation ledger are immutable
and unbounded by that active-room cap; the cutover row is a singleton release
fence; and audit tables contain metadata, never credentials. For any other
unexpected table, first search the deployed Worker source, take a D1 export or
confirm Time Travel coverage, and record the maintenance decision.

The runtime retention cutoff is 90 days. To audit what the next scheduled
cleanup would remove, preview the affected row count with:

```sql
SELECT COUNT(*)
FROM mxqr_metric_buckets
WHERE bucket_minute < CAST(strftime('%s', 'now', '-90 days') AS INTEGER) / 60;
```
