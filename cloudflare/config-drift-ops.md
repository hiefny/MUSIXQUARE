# MUSIXQUARE Cloudflare Configuration Drift Checks

This runbook records which Cloudflare settings live outside Worker source and
how to compare them with the repository without printing secret values. The
inventory was reconciled on 2026-07-16.

## R2 CORS

Repository inputs:

- `r2-cors.demo-tracks.json`: public, read-only demo audio. `*` is intentional
  because CORS is not an object-access control and this bucket accepts only
  browser `GET`/`HEAD` requests for public assets.
- `r2-cors.remote-share.json`: credential-bearing direct uploads. Keep the
  explicit production and local-development origin list; do not use `*`.

Compare the live buckets:

```powershell
npm run wrangler -- r2 bucket cors list musixquare-demo-tracks
npm run wrangler -- r2 bucket cors list musixquare-remote-share
```

Apply a reviewed repository file only when the listing differs:

```powershell
npm run wrangler -- r2 bucket cors set musixquare-demo-tracks --file cloudflare/r2-cors.demo-tracks.json
npm run wrangler -- r2 bucket cors set musixquare-remote-share --file cloudflare/r2-cors.remote-share.json
```

## Worker Secret Inventory

`wrangler secret list` prints names and types, not values. Compare names to the
variables actually read by each Worker before adding or deleting anything:

```powershell
npm run wrangler -- secret list --config cloudflare/wrangler.app.toml --format pretty
npm run wrangler -- secret list --config cloudflare/wrangler.remote-share.toml --format pretty
npm run wrangler -- secret list --config cloudflare/wrangler.signaling.toml --format pretty
```

Current production requirements:

- App: `YOUTUBE_API_KEY`, Cloudflare TURN credentials,
  `MXQR_CAPABILITY_SECRET`, both `MXQR_ADMIN_*` secrets, and the enabled
  Realtime/SFU credentials.
- Remote share: `MXQR_CAPABILITY_SECRET`, `REMOTE_SHARE_SIGNING_SECRET`, and the
  three R2 S3 credentials.
- Signaling: no Worker secrets.

The 2026-07-16 reconciliation removed the unreferenced `TURN_USER` and
`TURN_PASS` secrets and the inactive Turnstile keys. If the product policy is
intentionally reversed from `MXQR_TURNSTILE_DISABLED=true`, provision fresh
`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` values before enabling it.
Secret deletion is otherwise irreversible because Cloudflare does not reveal
stored values: confirm a backup or accept re-issuance before running
`wrangler secret delete`.

## D1

The tracked admin schema contains `mxqr_metric_buckets` and explicitly drops the
retired `mxqr_api_rate_limits` table. Production was reconciled on 2026-07-16
without deleting metric rows. Use the drift and retention procedure in
`admin-dashboard-ops.md` before changing any other table found in production.
