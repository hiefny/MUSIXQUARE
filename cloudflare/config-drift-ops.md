# MUSIXQUARE Cloudflare Configuration Drift Checks

This runbook records which Cloudflare settings live outside Worker source and
how to compare them with the repository without printing secret values. The
repository inventory was reconciled on 2026-07-22. A date here records the
checked-in contract, not proof that the live dashboard was inspected that day.

## R2 CORS

Repository inputs:

- `r2-cors.demo-tracks.json`: public, read-only demo audio. `*` is intentional
  because CORS is not an object-access control and this bucket accepts only
  browser `GET`/`HEAD` requests for public assets.
- `r2-cors.remote-share.json`: credential-bearing direct uploads. Keep the
  explicit production and local-development origin list; do not use `*`.
- `r2-cors.pro-media.json`: persistent PRO-room media. Keep its explicit
  production and local-development origin list aligned with the PRO Worker.

Compare the live buckets:

```powershell
npm run wrangler -- r2 bucket cors list musixquare-demo-tracks
npm run wrangler -- r2 bucket cors list musixquare-remote-share
npm run wrangler -- r2 bucket cors list musixquare-pro-media
```

Apply a reviewed repository file only when the listing differs:

```powershell
npm run wrangler -- r2 bucket cors set musixquare-demo-tracks --file cloudflare/r2-cors.demo-tracks.json
npm run wrangler -- r2 bucket cors set musixquare-remote-share --file cloudflare/r2-cors.remote-share.json
npm run wrangler -- r2 bucket cors set musixquare-pro-media --file cloudflare/r2-cors.pro-media.json --config cloudflare/wrangler.pro-room.toml
```

The checked-in source-to-live mapping is
`cloudflare/ops-drift.contract.json`. The manually dispatched
`Operations Drift Audit` GitHub workflow performs **GET-only** comparisons for
all three R2 policies and the effective `main` branch rules. It never applies a
CORS policy or edits a GitHub ruleset. The workflow runs only for `main` and
injects credentials only into the live comparison step. It prefers the
production environment's `CLOUDFLARE_DRIFT_AUDIT_TOKEN` with R2 configuration
read access only. A missing narrow credential fails closed; the audit workflow
never receives the production deployment token. GitHub follows the optional
`GITHUB_DRIFT_AUDIT_TOKEN` then built-in `github.token` order. Source CORS
objects are exact-key validated so misspelled fields fail before any live
query; the audit script contains no mutating HTTP method.

The workflow retains a JSON report for 90 days and writes a compact table to
the Actions summary. A missing credential, API error, missing required branch
rule, or CORS mismatch fails the job. Rows marked `MANUAL` were deliberately
not queried and must never be interpreted as passing.

## Worker Secret Inventory

`wrangler secret list` prints names and types, not values. Compare names to the
variables actually read by each Worker before adding or deleting anything:

```powershell
npm run wrangler -- secret list --config cloudflare/wrangler.app.toml --format pretty
npm run wrangler -- secret list --config cloudflare/wrangler.remote-share.toml --format pretty
npm run wrangler -- secret list --config cloudflare/wrangler.signaling.toml --format pretty
npm run wrangler -- secret list --config cloudflare/wrangler.pro-room.toml --format pretty
npm run wrangler -- secret list --config cloudflare/wrangler.developer-api.toml --format pretty
npm run wrangler -- secret list --config cloudflare/wrangler.developer-api-facade.toml --format pretty
```

Current production requirements:

- App: YouTube/Gemini/Google OAuth credentials, Cloudflare TURN and Realtime
  credentials, account/session peppers and assertion secrets,
  `MXQR_CAPABILITY_SECRET`, `MXQR_DEVELOPER_API_KEY_PEPPER`, and the Access/admin
  session secrets described in `wrangler.app.toml` and the private deployment
  inventory.
- Remote share: `MXQR_CAPABILITY_SECRET`, `REMOTE_SHARE_SIGNING_SECRET`, and the
  three R2 S3 credentials.
- Signaling: `PRO_SIGNALING_SECRET` and
  `MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET`.
- PRO room: activation/PIN/session/rate-limit secrets, the shared PRO signaling
  and independent account assertion secrets, plus the three R2 S3 credentials.
- Developer API: key pepper and rate-limit secret.
- Developer API facade: intentionally no secrets.

The 2026-07-16 reconciliation removed the unreferenced `TURN_USER` and
`TURN_PASS` secrets and the inactive Turnstile keys. If the product policy is
intentionally reversed from `MXQR_TURNSTILE_DISABLED=true`, provision fresh
`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` values before enabling it.
Secret deletion is otherwise irreversible because Cloudflare does not reveal
stored values: confirm a backup or accept re-issuance before running
`wrangler secret delete`.

## Bindings and D1

Inventory every deployed Worker, not only the three original services:

- App: Static Assets, Soro R2/KV, admin/auth/Developer API D1, PRO service and
  admin Durable Object bindings.
- Signaling: room Durable Object, PRO authority binding, and admin D1.
- PRO: room/signaling/rate-limiter Durable Objects, PRO media R2, admin and
  Developer API D1.
- Remote share: temporary-media R2 and service-control Durable Object rate limiting.
- Developer API: D1, limiter Durable Object, and private facade service.
- Developer API facade: private PRO-room Durable Object binding only.

The tracked admin schema contains `mxqr_metric_buckets`,
`mxqr_lifetime_metric_totals`,
`mxqr_pro_room_registry`, and `mxqr_pro_room_admin_audit`, and explicitly drops
the retired `mxqr_api_rate_limits` table. Production metrics were reconciled on
2026-07-16 without deleting metric rows; apply the current schema before the
first PRO-room admin rollout. Use the drift and retention procedure in
`admin-dashboard-ops.md` before changing any other table found in production.

The independent `musixquare-auth` and `musixquare-developer-api` databases must
match their current declarative baselines. A Developer API release compares the
deployed Worker's recorded git SHA with the database paths derived from the D1
manifest and refuses a schema-changing release unless the explicit D1 option is
enabled. Completed nickname, launch-cleanup, generation, and effects-scope SQL
remain in the manifest as immutable history; they are not routine release
runners.

`cloudflare/d1-migrations.manifest.json` is the fail-closed inventory for all
checked-in D1 baselines and migrations. `scripts/check-d1-migration-contract.mjs`
rejects an unregistered `.schema.sql`, `.migration.sql`, or `.rollback.sql`
file. A migration must declare one of two honest contracts:

- `paired`: a matching checked-in rollback SQL file plus the ordering rule that
  schema rollback happens before Worker rollback;
- `forward-only`: `rollback: null` plus a concrete runbook and a roll-forward,
  matched-Worker-floor, or provider-restore recovery boundary.

The manifest does not claim that a declarative baseline or arbitrary DDL can be
reversed automatically. Any destructive future schema change still needs its
own reviewed migration entry and recovery decision.

Finally, verify the dashboard-only controls that source cannot enforce. They
are listed as `manual-only` in `ops-drift.contract.json` so the automated audit
reports the gap instead of silently claiming success:
Cloudflare Access/MFA for `/admin`, WAF/rate-limit rules for session and paid
API routes, Worker/R2/D1 spend notifications, and the absence of a second
Git-triggered production deployment path. Record the review date without
copying identities, tokens, rule expressions containing private data, or
secret values into the repository.
