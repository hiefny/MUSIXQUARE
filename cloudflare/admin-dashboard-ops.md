# MUSIXQUARE Admin Dashboard Ops

The `/admin` dashboard is served by `musixquare-app` and reads aggregate room
metrics from a shared D1 database. The signaling Worker writes minute-level
counters when rooms and guests connect.

## Data Model

Only aggregate counters are stored. Room codes, peer IDs, IP addresses, and user
agents are not stored.

The app Worker's separate API rate-limit table stores only an HMAC-pseudonymous
client key plus endpoint/window counters—never the source IP. Expired rows are
deleted opportunistically at most once per five minutes per isolate and by the
six-hour cron. A dedicated `MXQR_RATE_LIMIT_HASH_SECRET` may be configured for
key separation; otherwise the capability or admin session HMAC secret is used.
If no valid 32-byte secret is available while D1 is bound, sensitive endpoints
fail closed.

Events:

- `room_opened`: a host created a fresh room.
- `host_reconnected`: a host reclaimed or refreshed an existing room.
- `guest_joined`: a guest successfully joined.
- `guest_host_unavailable`: a guest tried to join a missing room.
- `guest_auth_pending`: a password-protected guest reached the password prompt.
- `guest_auth_failed`: a guest submitted a missing or invalid room password.
- `guest_auth_timeout`: a guest password prompt timed out.

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
blocks in both files:

- `cloudflare/wrangler.app.toml`
- `cloudflare/wrangler.signaling.toml`

Apply or re-apply the schema:

```powershell
npx wrangler d1 execute musixquare-admin-metrics --remote --file cloudflare/admin-metrics.schema.sql
```

Set or rotate the admin secrets on the app Worker:

```powershell
npx wrangler secret put MXQR_ADMIN_PASSWORD --config cloudflare/wrangler.app.toml
npx wrangler secret put MXQR_ADMIN_SESSION_SECRET --config cloudflare/wrangler.app.toml
# Optional HMAC key separation for D1 API rate-limit pseudonyms:
npx wrangler secret put MXQR_RATE_LIMIT_HASH_SECRET --config cloudflare/wrangler.app.toml
```

`MXQR_ADMIN_SESSION_SECRET` should be a long random string. It signs the
HttpOnly admin session cookie.

Deploy both Workers after the D1 binding is configured. The app/web Worker must
go first so newly loaded clients include the guest reconnect secret required by
the signaling Worker:

```powershell
npm run deploy:app
npx wrangler deploy --config cloudflare/wrangler.signaling.toml
```

For a release that also changes remote sharing, deploy
`wrangler.remote-share.toml` before these two. Its protocol bridge supports both
the previous and current web clients, while the signaling identity change is
intentionally strict. Tabs left open on an older client may need one refresh
after the signaling rollout.

During the rolling compatibility window, host and guest reconnect credentials
remain in the WebSocket handshake query so older tabs can reconnect. Do not
store raw request query strings in HTTP Logpush/APM; redact the `secret`
parameter if request-URI logging is enabled. Moving that credential to the
first authenticated WebSocket frame requires a Worker-first compatibility
release followed by a later fallback-removal release.

Then open:

```text
https://musixquare.com/admin
```

## Notes

- Before the D1 binding is configured, `/admin` still loads but metrics return
  `ADMIN_DB_NOT_CONFIGURED`.
- Before the schema is applied, metrics return `ADMIN_METRICS_SCHEMA_MISSING`.
- The dashboard starts showing useful data only after the signaling Worker has
  been redeployed with the D1 binding.
