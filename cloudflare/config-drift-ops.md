# MUSIXQUARE Cloudflare Configuration Drift Checks

This runbook records which Cloudflare settings live outside Worker source and
how to compare them with the repository without printing secret values. The
repository inventory was reconciled on 2026-08-09. A date here records the
checked-in contract, not proof that the live dashboard was inspected that day.

## R2 CORS and lifecycle

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

The same read-only audit queries Cloudflare's lifecycle endpoint, whose expected
successful envelope is `{ "success": true, "result": { "rules": [...] } }`.
`musixquare-remote-share` must match
`r2-lifecycle.remote-share.json` exactly: rule ID, enabled state, `room/` prefix,
delete transition type, and 86,400-second age are all contract material.
`musixquare-pro-media` is persistent source storage and must not have an enabled
date-based delete transition or an age-based delete transition of 86,400 seconds
or less. This catches a copied temporary-media cleanup rule without pretending
that the audit manages bucket state.

The checked-in source-to-live mapping is
`cloudflare/ops-drift.contract.json`. The manually dispatched
`Operations Drift Audit` GitHub workflow performs **GET-only** comparisons for
all three R2 CORS policies, the exact remote-share lifecycle, the PRO short-delete
guard, and the effective `main` branch rules. It never applies a bucket policy or
edits a GitHub ruleset. The workflow runs only for `main` and
injects credentials only into the live comparison step. It prefers the
production environment's `CLOUDFLARE_DRIFT_AUDIT_TOKEN` with R2 configuration
read access only. A missing narrow credential fails closed; the audit workflow
never receives the production deployment token. GitHub follows the optional
`GITHUB_DRIFT_AUDIT_TOKEN` then built-in `github.token` order. Source CORS
objects are exact-key validated so misspelled fields fail before any live
query; the audit script contains no mutating HTTP method.

The workflow retains a JSON report for 90 days and writes a compact table to
the Actions summary. A missing credential, API error, missing required branch
rule, CORS mismatch, lifecycle mismatch, or forbidden short delete rule fails the
job. Rows marked `MANUAL` were deliberately
not queried and must never be interpreted as passing.

## Worker URL observability

All six production Wrangler configs keep sampled custom Worker logs enabled,
but set `observability.logs.invocation_logs = false` and disable automatic
traces. This is a fleet-wide credential-minimization boundary: the App OAuth
callback receives one-use `code` and `state` query values, and cached PRO
clients may use the signaling `ticket` query only until the documented rollout
cutoff. Provider heuristics are not treated as reliable redaction. Application
logs must remain structured and must not include raw request URLs, query
strings, credentials, cookies, or authorization headers.

Treat any dashboard or TOML drift that re-enables automatic invocation logs or
traces as a security incident until the affected retention window and sampled
events have been reviewed. Operational visibility comes from the sampled,
credential-free custom event schema and the release/health summaries instead.

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
  credentials described in `admin-dashboard-ops.md` and the private deployment
  inventory.
- Remote share: `MXQR_CAPABILITY_SECRET`, `REMOTE_SHARE_SIGNING_SECRET`, and the
  three R2 S3 credentials.
- Signaling: `PRO_SIGNALING_SECRET` and
  `MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET`.
- PRO room: activation/PIN/session/rate-limit secrets, the shared PRO signaling
  and independent account assertion secrets, plus the three R2 S3 credentials.
- Developer API: key pepper and rate-limit secret.
- Developer API facade: intentionally no secrets.

Every project-defined HMAC, signing, or pepper secret in this inventory must be
a random value of at least 32 characters unless its owning runbook documents a
stricter shape. `CLOUDFLARE_REALTIME_APP_SECRET` has the same minimum because it
also signs the app's session capability. Share only the explicitly named
App/Worker or PRO/signaling pairs; other provider-issued OAuth, R2, TURN,
Gemini, and YouTube credentials retain their provider-defined formats.

`MXQR_ADMIN_PASSWORD` is not an HMAC key, but the App Worker still treats it as
configured only at 16 through 256 UTF-8 bytes. `MXQR_ADMIN_SESSION_SECRET` is a
separate signing domain and must not be reused for capability, assertion, or
provider credentials. Both values are compared/used exactly as stored;
whitespace is secret material, so secret-entry tooling must not add or trim it.

The 2026-07-16 reconciliation removed the unreferenced `TURN_USER` and
`TURN_PASS` secrets and the inactive Turnstile keys. If the product policy is
intentionally reversed from `MXQR_TURNSTILE_DISABLED=true`, provision fresh
`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` values before enabling it.
Secret deletion is otherwise irreversible because Cloudflare does not reveal
stored values: confirm a backup or accept re-issuance before running
`wrangler secret delete`.

## Bindings and D1

Inventory every deployed Worker, not only the three original services:

- App: Static Assets, Soro R2/KV, admin/auth/Developer API D1, PRO service,
  PRO-admin and signaling Durable Object bindings, and service control.
- Signaling: room, service-control, and PRO-authority Durable Objects plus admin
  D1.
- PRO: room, service-control, signaling, and Developer API limiter Durable
  Objects; PRO media R2; and admin/auth/Developer API D1.
- Remote share: temporary-media R2, the per-room quota Durable Object, and
  service-control atomic rate limiting.
- Developer API: D1, its limiter and service-control Durable Objects, and the
  private facade service.
- Developer API facade: private PRO-room and service-control Durable Object
  bindings only.

`cloudflare/durable-object-migrations.manifest.json` is the canonical ordered
history for every production `wrangler*.toml`, including App and Developer API
facade configs whose local migration arrays are currently empty. The source
guard parses each TOML and requires exact equality with the manifest before any
bundle dry-run. It then walks every visible first-parent manifest revision and
allows only suffix appends for an existing Worker script; a tag, class list,
script identity, or prior entry cannot be edited, reordered, truncated, or
removed. CI, release validation, and this drift workflow all retain full Git
history so the append-only proof does not silently degrade to the current file.
Cloudflare's newer declarative `exports` lifecycle is a separate migration and
must not be mixed into a legacy migration-array Worker without extending this
contract and reviewing the provider transition.

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
