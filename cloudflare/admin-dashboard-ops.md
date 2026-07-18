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
registered `0xxxxx` room codes and operator labels. Its audit stores a
session-scoped HMAC actor pseudonym, action/result, PRO room code, and timestamp
only. It must never store a PIN, activation claim, activation URL, admin cookie,
or Access token.

Events:

| Event                      | Meaning                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `room_opened`              | A host created a fresh room.                                                             |
| `host_reconnected`         | A host reclaimed or refreshed an existing room.                                          |
| `host_legacy_url_auth`     | An older cached host authenticated through the temporary query compatibility path.       |
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

## Legacy Host Authentication Removal

Current standard-room clients send the random host ownership secret in their
first WebSocket frame. They never put it in the URL. The signaling Worker
temporarily still accepts the old `?secret=` query contract because an already
open or deferred-update PWA can reconnect while the Worker is rolling forward.
Do not log full standard-room WebSocket URLs while this bridge exists.

Deploy the signaling Worker before the app. That order lets both the new
first-frame client and an older cached query client use the new Worker during
the rollout without putting the current client's credential back into its URL.

Remove the query parser and `host_legacy_url_auth` event only after all of these
conditions hold:

1. The app/service-worker release containing first-frame host authentication
   has been in production for at least 30 days; record its deployed SHA and
   cache version in the release log.
2. `host_legacy_url_auth` has remained zero for seven consecutive days.
3. A live smoke confirms first-frame host creation and reconnect against the
   then-current signaling Worker.

The removal must delete only the legacy query branch. The `host-auth` first
frame, its timeout, and the rule that a candidate cannot replace the live host
before successful authentication remain permanent.

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

Set or rotate the admin secrets on the app Worker:

```powershell
npx wrangler secret put MXQR_ADMIN_PASSWORD --config cloudflare/wrangler.app.toml
npx wrangler secret put MXQR_ADMIN_SESSION_SECRET --config cloudflare/wrangler.app.toml
```

`MXQR_ADMIN_SESSION_SECRET` should be a long random string. It signs the
HttpOnly admin session cookie.

Deploy the Workers after the schema and D1 bindings are configured. The PRO
Worker must exist before the App Worker's cross-script Durable Object binding
can become active:

```powershell
npx wrangler deploy --config cloudflare/wrangler.signaling.toml
npx wrangler deploy --config cloudflare/wrangler.pro-room.toml
npx wrangler deploy --config cloudflare/wrangler.app.toml
```

Then open:

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
`mxqr_pro_room_registry`, and `mxqr_pro_room_admin_audit`; `_cf_KV` is managed
by Cloudflare. Applying `admin-metrics.schema.sql` also removes the retired
`mxqr_api_rate_limits` table, which has no current Worker reader or writer. The
PRO registry is capped by application policy and the audit contains metadata,
never credentials. For any other unexpected table, first search the deployed
Worker source, take a D1 export or confirm Time Travel coverage, and record the
maintenance decision.

The runtime retention cutoff is 90 days. To audit what the next scheduled
cleanup would remove, preview the affected row count with:

```sql
SELECT COUNT(*)
FROM mxqr_metric_buckets
WHERE bucket_minute < CAST(strftime('%s', 'now', '-90 days') AS INTEGER) / 60;
```
