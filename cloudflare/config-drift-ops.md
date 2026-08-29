# MUSIXQUARE Cloudflare Configuration Drift Checks

This runbook records which Cloudflare settings live outside Worker source and
how to compare them with the repository without printing secret values. The
repository inventory was reconciled on 2026-08-15. A date here records the
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
`cloudflare/ops-drift.contract.json`. The daily and manually dispatched
`Operations Drift Audit` GitHub workflow performs **GET-only** comparisons for
all three R2 CORS policies, the exact remote-share lifecycle, the PRO short-delete
guard, all six Workers' exact secret-name inventories, non-secret bindings,
custom domains (including their production environment), workers.dev/Preview
URL exposure, and the effective `main` branch rules. Each Worker surface points
to its production Wrangler TOML, which is the exact binding source. The binding
audit reads the first deployment returned by Cloudflare, requires its active
traffic split to contain one or two unique non-zero versions totaling 100%, and
compares every serving version's `resources.bindings` with that source. This
prevents a 50/50 rollout from passing merely because one version is correct.
In addition to the six service-filtered custom-domain reads, one unfiltered
account inventory read covers the contracted `musixquare.com` hostname tree.
It catches a project hostname attached to an uncontracted Worker without
retaining the unexpected hostname or service name in the report.
D1/KV/rate-limit identifiers and plain-text values are compared in memory but
reduced to a generic match/mismatch marker before the report is built. Secret
values, opaque deployment/resource/domain/route IDs, certificate IDs, and
version IDs are never serialized. It never applies a bucket policy,
edits a Worker secret, or edits a GitHub ruleset. The workflow runs only for
`main` and injects credentials only into the live comparison step. Its production environment
`CLOUDFLARE_DRIFT_AUDIT_TOKEN` requires exactly the account-level
`Workers R2 Storage Read` and `Workers Scripts Read` permissions for the
production account. The latter is required by Cloudflare's
`GET /accounts/{account_id}/workers/scripts/{script_name}/secrets` endpoint and
also covers the read-only deployment, version-detail, subdomain, and
custom-domain queries.
A missing narrow credential fails closed; the audit workflow never receives or
falls back to the production deployment token. GitHub follows the optional
`GITHUB_DRIFT_AUDIT_TOKEN` then built-in `github.token` order. Source CORS
objects are exact-key validated so misspelled fields fail before any live
query; the audit script contains no mutating HTTP method.

Schema v4 rollout precondition: before its first live dispatch, verify that the
GitHub `production` environment's existing narrow
`CLOUDFLARE_DRIFT_AUDIT_TOKEN` still contains exactly
`Workers R2 Storage Read` and `Workers Scripts Read`. Schema v3 already required
both permissions for its R2 and six Worker secret-name reads, so do not rotate a
conforming token solely for this schema change. If either permission is absent
or the token has broader deployment rights, replace it with a new account-scoped
token containing exactly those two reads. Dispatch the audit, confirm that the
Worker secret, active-deployment/version, subdomain, and custom-domain rows
reached comparison rather than authorization errors, and only then revoke a
superseded token. Do
not use the deployment token as a temporary bridge; leaving the audit failed
closed until a required narrow rotation is complete is the safe fallback.

Zone route coverage is optional because Cloudflare scopes it separately. To
enable it, set the production environment variable `CLOUDFLARE_ZONE_ID` and the
secret `CLOUDFLARE_WORKERS_ROUTES_READ_TOKEN` together; the token needs only
`Workers Routes Read` for that zone. The audit then calls
`GET /zones/{zone_id}/workers/routes` and requires exact equality across the
entire zone, including routes targeting an unexpected Worker or no Worker.
This matters because a foreign route can intercept a contracted custom domain
before its intended Worker. Current Wrangler sources declare only custom
domains, so the exact zone-route set is empty. If both values are absent,
the report says `MANUAL`; setting only one is a configuration error. The route
token is never substituted for either the Worker-script reader or deployment
credential.

The workflow retains a JSON report for 90 days and writes a compact table to
the Actions summary. A missing required credential, API error, missing required
branch rule, CORS mismatch, lifecycle mismatch, forbidden short delete, binding
mismatch, or unexpected public exposure fails the job. API/protocol failures
are `ERROR`; successfully queried state that differs from contract is `DRIFT`.
Rows marked `MANUAL` were deliberately
not queried and must never be interpreted as passing.

## Worker URL observability

All six production Wrangler configs currently keep sampled custom Worker logs
enabled, but set `observability.logs.invocation_logs = false` and disable
automatic traces. This is the default credential-minimization boundary: the App
OAuth callback receives one-use `code` and `state` query values, while PRO
signaling accepts its bearer only through the WebSocket subprotocol header.
Provider heuristics are not treated as reliable redaction. Application logs
must remain structured and must not include raw request URLs, query
strings, credentials, cookies, or authorization headers.

Treat any unreviewed dashboard or TOML drift that re-enables automatic
invocation logs or traces as a security incident until the affected retention
window and sampled events have been reviewed. Changing this baseline requires
an intentional config, policy-test, and privacy review rather than automatic
restoration. Operational visibility otherwise comes from the sampled,
credential-free custom event schema and the release/health summaries.

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

`cloudflare/ops-drift.contract.json` is the canonical, exact production
secret-name inventory. Current requirements are:

<!-- BEGIN OPS DRIFT WORKER SECRET INVENTORY -->
- `musixquare-app`:
  - `CLOUDFLARE_REALTIME_API_TOKEN`
  - `CLOUDFLARE_REALTIME_APP_ID`
  - `CLOUDFLARE_TURN_API_TOKEN`
  - `CLOUDFLARE_TURN_KEY_ID`
  - `GEMINI_API_KEY`
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `GOOGLE_OAUTH_CLIENT_SECRET`
  - `MXQR_ADMIN_PASSWORD`
  - `MXQR_ADMIN_SESSION_SECRET`
  - `MXQR_AUTH_SESSION_PEPPER`
  - `MXQR_AUTH_SUBJECT_PEPPER`
  - `MXQR_CAPABILITY_SECRET`
  - `MXQR_DEVELOPER_API_KEY_PEPPER`
  - `MXQR_OAUTH_STATE_SECRET`
  - `MXQR_PRO_GRANT_VOUCHER_PEPPER`
  - `MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET`
  - `MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET`
  - `YOUTUBE_API_KEY`
- `musixquare-developer-api`:
  - `MXQR_DEVELOPER_API_KEY_PEPPER`
  - `MXQR_DEVELOPER_API_RATE_SECRET`
- `musixquare-developer-api-facade`: intentionally no secrets.
- `musixquare-pro-room`:
  - `MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET`
  - `PRO_ROOM_ACTIVATION_SECRET`
  - `PRO_ROOM_PIN_PEPPER`
  - `PRO_ROOM_RATE_LIMIT_SECRET`
  - `PRO_ROOM_SESSION_SECRET`
  - `PRO_SIGNALING_SECRET`
  - `R2_ACCESS_KEY_ID`
  - `R2_ACCOUNT_ID`
  - `R2_SECRET_ACCESS_KEY`
- `musixquare-remote-share`:
  - `MXQR_CAPABILITY_SECRET`
  - `MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET`
  - `R2_ACCESS_KEY_ID`
  - `R2_ACCOUNT_ID`
  - `R2_SECRET_ACCESS_KEY`
  - `REMOTE_SHARE_SIGNING_SECRET`
- `musixquare-signaling`:
  - `MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET`
  - `MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET`
  - `MXQR_STANDARD_ROOM_PIN_PEPPER`
  - `PRO_SIGNALING_SECRET`
<!-- END OPS DRIFT WORKER SECRET INVENTORY -->

The live audit requires exact set equality. A missing canonical name and any
unexpected name both fail closed. Runtime-supported legacy aliases are not
canonical production secrets unless this contract and runbook are deliberately
updated together. In particular, the retired
`MXQR_PRO_ROOM_REUSE_CANARY_OPS_SECRET` App binding and
`PRO_ROOM_DECOMMISSION_VERIFY_SECRET` signaling binding are intentionally absent
and are reported as unexpected if still deployed.

Cloudflare currently documents this list endpoint's result as a union of
`secret_text` and `secret_key` bindings. The audit accepts only those two types,
extracts only each binding's `name`, and never serializes the returned binding
objects or any value-bearing fields into its JSON or Markdown reports.

Every project-defined HMAC, signing, or pepper secret in this inventory must be
a random value of at least 32 characters unless its owning runbook documents a
stricter shape. The active `CLOUDFLARE_REALTIME_API_TOKEN` alias has the same
minimum because it also signs the app's session capability. Share only the explicitly named
App/Worker or PRO/signaling pairs; other provider-issued OAuth, R2, TURN,
Gemini, and YouTube credentials retain their provider-defined formats.
`MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET` is the one additional explicit
pair: its plain value or prefixed current/previous keyring must be byte-identical
on signaling and Remote Share. Every contained HMAC key remains independent and
must never reuse the capability, upload-token, standard-room account,
PRO-signaling, or admin-session secret. The staged keyring procedure lives in
`remote-share-ops.md`; the drift audit intentionally reads only the binding name,
never this value.

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

The exact public surface is intentionally small. Every checked-in Worker surface
declares `environment: production`. App owns `musixquare.com` and
`www.musixquare.com`; Developer API owns `api.musixquare.com`; Remote Share owns
`share.musixquare.com`; and Signaling owns both `signal.musixquare.com` and the
cold route-retry alias `signal-alt.musixquare.com`. The alias reaches the same
Worker and Durable Object namespace but is intentionally not preconnected by the
browser: it must remain a fresh hostname/TLS path until a Standard-room setup
fails before admission. Developer API facade and PRO room must have zero custom
domains, zero project zone routes, no workers.dev endpoint, and no Preview URLs.
All six Workers keep workers.dev and
Preview URLs disabled. A new hostname, route, or alternate Worker endpoint is a
contract change requiring the same security review as a new public API.
Cloudflare may omit the deprecated custom-domain `environment` field; the audit
treats omission as `production` for API compatibility. Any explicit non-production
value, including `staging`, differs from the production contract and fails as
drift.

The signaling hostname cutover uses two reviewed stages. Stage A is a distinct
restriction-only commit: deploy the signaling Worker code that denies alternate-
host PRO/private surfaces while the alternate Custom Domain and client fallback
are still absent. Verify that hardened Worker before proceeding, so the rollback
baseline is itself safe if a later edge detach is delayed. Stage B is a new
candidate containing the alias, client fallback, and recovery contract and uses
one release with target `all`. Inside that coherent run, signaling deploys first;
the live gate then admits primary/alternate cross-host rooms in both directions,
relays offer/answer frames, and verifies the alternate root, private paths, and
PRO rejection before the App Worker may deploy. Two partial targets from the
same Stage B SHA are not the rollout procedure because the compatibility guard
intentionally rejects that boundary when both runtimes changed.

Custom Domain recovery is independent of Worker version recovery. Before any
mutation, release captures and persists the exact primary/alternate domain IDs,
owner, production environment, and zone. Immediately before Wrangler it also
persists deployment-start evidence, and after Wrangler it records the exact
candidate inventory together with the exact live signaling deployment ID,
version ID, and message (either the captured baseline or this release). After all
selected live gates, final Worker ownership verification, and generation-
readiness restoration, a commit fence immediately before the coherent-production
marker takes two fresh account-wide Custom Domain inventory reads and two fresh
active signaling deployment reads. Both inventories must exactly match the
recorded candidate fingerprint, and both deployment reads must exactly match its
recorded deployment ID, version ID, and message. A missing, foreign, or drifted
domain or a newer active deployment fails closed before production is marked
coherent. On an uncommitted failure, recovery first compares fresh Cloudflare
inventory with those artifacts. Immediately before any DELETE it also reads the
live signaling deployment twice and requires both reads to match that recorded
identity. It may use the official exact-ID
Custom Domain DELETE only when the baseline lacked the alternate alias and the
current alternate is the same recorded candidate identity; pre-existing aliases
are never deleted. API absence is not sufficient: after DELETE, a cache-busted,
credential-free alternate-host internal probe must observe two consecutive
responses that do not carry the signaling Worker's exact JSON 404 fingerprint.
Timeouts, transient policy/rate-limit/server responses, and other ambiguous edge
states fail closed. Domain restore and a second fresh API verification happen
after the edge probe, the rollback shell rechecks the baseline immediately
before choosing its signaling skip set, and final verification runs again after
generic Worker recovery. Missing evidence,
duplicate or foreign ownership, deployment/domain identity drift, an unrecorded
started deployment, DELETE failure, ambiguous edge propagation, or final
verification failure keeps the hardened signaling candidate forward, skips
signaling version rollback, and marks recovery incomplete for manual repair.
This ordering prevents a late alias attachment or stale edge binding from
exposing an older unrestricted Worker version.

The following is an orientation summary, not an exhaustive binding list. The
production Wrangler TOML and `cloudflare/ops-drift.contract.json` remain the
exact machine-checked inventories. Inventory every deployed Worker, not only
the three original services:

- App: Static Assets, Soro R2/KV, admin/auth/Developer API D1, PRO service,
  PRO-admin and signaling Durable Object bindings, service control, and the
  `MXQR_CAPABILITY_POW_ROOM_PRESSURE` / `MXQR_CAPABILITY_POW_GENERAL_PRESSURE`
  Rate Limiting bindings.
- Signaling: room, service-control, and PRO-authority Durable Objects plus admin
  D1.
- PRO: room, service-control, signaling, and Developer API limiter Durable
  Objects; PRO media R2; and admin/auth/Developer API D1.
- Remote share: temporary-media R2, the per-room quota Durable Object,
  service-control atomic rate limiting, and the aggregate admin-metrics D1
  binding used for assertion rollout counters.
- Developer API: D1, its limiter and service-control Durable Objects, and the
  private facade service.
- Developer API facade: private PRO-room and service-control Durable Object
  bindings only.

Signaling, PRO, Remote Share, Developer API, and the private Developer API
facade also expose `CF_VERSION_METADATA`; the App Worker does not. The exact-set
audit compares these and every other serving-version binding even when this
human summary does not name each binding.

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

The tracked admin baseline currently defines 18 application tables covering
metrics, room generations, owner-transfer sagas, grants, entitlements, and
their audits, and explicitly drops the retired `mxqr_api_rate_limits` table.
`cloudflare/admin-metrics.schema.sql` is the exact schema source; the complete
human inventory and read-only production query live in
`admin-dashboard-ops.md`. The source contract was rechecked on 2026-08-17, but
live table presence remains a separate provider check before maintenance.

The independent `musixquare-auth` and `musixquare-developer-api` databases must
match their current declarative baselines. A Developer API release compares the
deployed Worker's recorded git SHA with the database paths derived from the D1
manifest and refuses a schema-changing release unless the explicit D1 option is
enabled. Completed nickname, launch-cleanup, generation, and effects-scope SQL
remain in the manifest as immutable history; they are not routine release
runners.

`cloudflare/d1-migrations.manifest.json` is the fail-closed inventory for all
checked-in D1 baselines and migrations. `scripts/check-d1-migration-contract.mts`
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
