# Production Hotfix And Rollback Procedure

Reviewed against `browser/service-worker.ts`, `scripts/service-worker-asset.ts`,
`src/sw-register.ts`, the six production Worker Wrangler configs, the
production release workflow, and the live-smoke scripts on 2026-08-30. Read the
current `SERVICE_WORKER_CACHE_VERSION` from the compiler manifest rather than
copying a number from this procedure.

This document is the canonical production hotfix note. Untracked workshop
drafts are not release instructions.

Before preparing a production release, first read the maintained
[release record](release-record.md). Reconcile its current state and open items
against the final diff, then follow this procedure. After the release, update
the record and append the run to the [release history](release-history.md). The
record does not authorize a deployment.

## Normal Hotfix

Use this path for ordinary production bugs that do not require immediate client replacement.

```bash
git switch main
git pull --ff-only origin main
git switch -c agent/describe-the-fix

# make the fix

# Advance the product patch version when shipped behavior or product copy changes.
# For public/PWA runtime inputs, also bump SERVICE_WORKER_CACHE_VERSION in the
# same commit. See "Client Update Behavior" below.

npm run typecheck
npm run lint
npm run format:check
npm test
# typecheck already covers Worker types and declaration ownership.
node --check cloudflare/app-worker.ts
npm run guard:developer-api-boundaries
npm run guard:d1-migrations
npm run guard:ops-drift-contract

git add <files>
git commit -m "fix(domain): describe the fix"

# Build once against committed HEAD so the cache-history guard checks the fix.
npm run build:checked

git push -u origin agent/describe-the-fix

# Open a pull request into main, wait for CI, and merge the reviewed PR.
```

Merging the pull request into `main` does not deploy production. CI runs static
checks, tests, and the production build in parallel. A successful `main` CI run
records one immutable production candidate for that exact commit. Run the
`Production Release` workflow from the Actions tab and select only the Worker
scope changed by the hotfix. Every target reuses that exact-SHA CI candidate
without rerunning the full CI/test suite. The immutable App artifact is reused
without rebuilding; Worker sources are revalidated and bundled from the pinned
checkout. The release still rechecks the manifest and hashes, time-sensitive
production-security rules, and Worker bundles before running live smokes with
an immutable recovery checkpoint and fail-closed forward-repair reporting.

Within each CI run, the full unit suite executes once across two shards with
coverage enabled. `Broad unit coverage` requires both shard reports and merges
them without rerunning tests, applying the original whole-suite thresholds.
Critical runtime, Worker, and release-tooling coverage retain their independent
scopes and thresholds. Type/source checks run alongside lint/formatting; the
`Static checks` result requires both lanes to succeed. Worker policy checks reuse
the type validation already included in `npm run typecheck`.
The full tooling lint runs in the lint lane; unit tests verify its resolved
configuration and zero-warning command instead of scanning the repository again.

PR and `main` CI remain separate: a PR merge candidate and the final `main`
commit have different identities, even when their file trees match. Production
Release still requires the successful exact-commit `main` candidate. Do not
replace this evidence with a PR result or skip a failed/missing coverage shard.
Shard artifacts are scoped to the commit and run, so rerunning failed jobs can
reuse a successful sibling from that same run.

Repository publication has two distinct paths:

- Changes limited to repository documentation (`README.md`, `CONTRIBUTING.md`,
  `docs/**`, or `cloudflare/*ops.md`), `.env.example`, GitHub workflows, and
  test/guard contracts that feed neither an App nor Worker bundle are published
  by merging to GitHub. Do not run a Cloudflare Production Release for them.
- Changes under `public/**` or the production
  `.workshop/{landing,privacy,terms,faq,developers,translate,sitemap}/**` trees are hosted App
  inputs. Advance the required product/cache identifiers, merge the change,
  wait for the exact merge-SHA `main` push CI candidate to succeed, then run
  `Production Release` with target `app` and Developer API D1 application
  disabled. The App target still applies and verifies its ordinary idempotent
  admin-D1 baselines and the additive translation-community tables in auth D1;
  it is not a generic no-op documentation deploy. Translation records are retained
  when rolling back to an older App; do not drop their tables during recovery.

The repository does not provide an isolated full-stack preview environment: a
static or tunneled frontend URL cannot open Standard or PRO rooms without the
corresponding signaling, service bindings, Durable Objects, and storage
services. Release authorization therefore relies on the immutable exact-SHA CI
candidate, production security and bundle checks, the pre-mutation checkpoint,
and target-specific live smoke tests. Do not treat a frontend-only preview as a
valid room test.

Leave `Apply the current Developer API D1 baseline` disabled for an ordinary
Worker release. Enable it only when the approved commit intentionally changes
the Developer API database contract and carries the required manifest entry
and recovery decision. The release workflow no longer runs completed beta
migrations or launch-cleanup commands.

The reusable PRO-room generation floor is already permanent. Every full-stack
`all` release reads its immutable `floor_release_sha`, proves that commit is an
ancestor of the candidate, and writes the room-code reuse marker to `disabled`
before any dependency changes. After every Worker, live smoke, and final
deployment-ownership check succeeds, the workflow restores `ready` for the
exact release SHA. There is no first-room enable input or deletion-evidence
ceremony to replay.

The checked-in effects-scope forward/rollback SQL pair is immutable migration
history, not an active release runner. Any future scope-constraint change must
be a new reviewed migration that explicitly preserves
`(room_code, room_generation)`, key tombstones, and their triggers. Never run
the historical table rebuild as launch-era recovery.

Once the reuse cutover has ever been marked `ready`, a later generation may be
created concurrently at any moment and automatic rollback to any
generation-blind Worker is prohibited. The generation columns, history, and
tombstones are permanent authorization fences and have no down migration. On
failure, keep PRO entry fail-closed and forward-fix, or restore a matched
provider data/code checkpoint. Do not delete a tombstone or immutable
allocation/history row, decrement a generation, or authorize by room code alone
to make an older Worker run.
If a full release fails, recovery first returns the global cutover marker to
`disabled`; it preserves `ever_enabled` and the first
`floor_release_sha`. If that fence cannot be proven, it withholds rollback of
every generation-sensitive Worker. Otherwise, the pre-mutation checkpoint binds
each selected Worker's Cloudflare deployment/version and `beforeMessage` Git SHA
to the captured floor. An already-established floor does not by itself block a
routine rollback: a baseline proven to descend from `floor_release_sha` may be
restored. A baseline that predates the floor, has unknown/divergent provenance,
or was captured before this release established the exact candidate floor is
retained on that candidate for forward repair. The entitlement floor follows a
stricter first-cutover boundary: a checkpoint that was already complete permits
an App/PRO baseline only when its exact Git provenance also descends from the
entitlement-support release `a79d1624d2314942072622cc875da7c7332a9530`. A
checkpoint captured as incomplete, an older entitlement-blind baseline, or
unknown/divergent provenance keeps the affected App/PRO Worker on the exact
candidate even if the first recovery read is still false. The candidate App can
complete that durable backfill between a read and rollback, and there is no
distributed writer fence for that interval; the first entitlement cutover
therefore prevents a mixed contract before it preserves availability. If the
candidate was never deployed, automatic recovery stays red for forward repair
instead of guessing that the older baseline is safe. Recovery freshly rereads
cutover status, release authority, and both floors after the paired Worker/R2
verification, and fails if that evidence changed or a candidate-required Worker
is not still on that release. A later
successful full release can restore a marker left disabled by a failed release,
but only after the same floor, smoke, and deployment-ownership checks pass.

The Developer API facade/backend pair has a separate permanent authority
compatibility boundary. Its captured baseline must descend from
`4d2a4ff7898d40956fc110ad998433aa41ceb0e2`, the first release that propagates
and enforces the durable per-room authority epoch and fence. An older,
unknown, or divergent Developer API baseline stays on the exact candidate
during both same-job and independent recovery. The facade and backend are one
atomic compatibility pair: if either member fails that proof, recovery retains
both candidates. This prevents an
authority-aware retained PRO Worker from being paired with a Developer API
stack that omits the epoch and would reject valid active keys as stale.

Optional PRO entry passwords add a PRO/App recovery floor recorded in
`cloudflare/pro-room-entry-policy-contract-version.txt`. The first release must
deploy both Workers (`all`). Once the candidate PRO or App version has replaced
its captured baseline, recovery must not reinstall a baseline that predates the
optional-entry contract: public-room state may already have been written. An
older PRO Worker could reject those rooms or preserve a false policy flag while
changing their PIN. The release and independent recovery paths retain the
compatible candidate for forward repair. Untouched pre-deployment baselines
remain safe; subsequent rollback to a proven contract-aware baseline remains
available. Never repair admission by deleting the policy flag or inventing a
PIN. See [the contract and verification record](design/pro-optional-entry-password-2026-10-10.md).
The marker is now
`pro-room-optional-entry-password-v1+pro-owner-transfer-pinless-v1`: from that
release a pending owner transfer is stored without a PIN. An older PRO Worker
drops such a record as invalid, so a transfer in flight would leave its room
suspended in `ownership_transfer_pending` with no retry or cron to finish it,
and an older PRO Worker or App facade rejects the pinless transfer body. The
same PRO/App floor therefore applies again: once that candidate may be live,
neither automatic nor manual recovery restores either Worker below the marker;
repair forward with an `all` release. Any change to this marker requires
target `all`. See [the transfer change](design/phase2-navigation-ui-shells-2026-10-23.md#호환성과-배포-순서).

From 9.0.21 (old-version removal train 3) the App's PRO presence close
(`POST /presence/close`, sent on a confirmed `pagehide` and at the start of an
explicit leave) carries only its receipt key and the captured participant and
presence incarnation, without `baseRevision`, `currentQueueItemId` and
`playback`. The PRO Worker of old-version removal train 2 (`a3893f04`, deployed
2026-10-27 KST, version `319f6e8f`) and every later one take those fields as
optional. An older PRO Worker, including the 9.0.14 (`dd9c9d4d`) version in
that release's recovery checkpoint, refuses the shorter body with 400
`INVALID_REQUEST`. Once 9.0.21 or a later App has been live, never restore the
PRO Worker below that train 2 Worker by hand, even after rolling the App back:
a tab opened on 9.0.21 or later keeps sending the shorter close until it
reloads. Under such a Worker a participant who closes such a tab stays listed
until presence expires (45 seconds), a reload or an applied update shows the
"A previous connection remains" handoff dialog instead of resuming silently,
and a room whose last participant left that way freezes its playback and
sleeps only once that presence expires. An explicit leave still ends through
the fenced session close. Automated recovery stays above this line: it
restores only the failing release's recovery checkpoint, and every PRO Worker
captured in a checkpoint since train 2 is that Worker or a later one. No
contract marker changes for this boundary; a marker would stop only the
automated recovery of the release that changed it.

The complete serial Playwright suite is intentionally not a production deploy
gate. The `Full E2E` workflow runs it together with the targeted iPhone WebKit
smoke every Tuesday at 03:17 KST and remains manually dispatchable when a change
warrants the extra coverage before the next scheduled run. A focused
deterministic Chromium subset is blocking in exact-SHA CI, so an approved
release cannot select a candidate until the critical owner-recovery,
OAuth-return, host/guest, background-resume, and signed-upload browser paths
pass.

The workflow rebuilds once, records every `dist` file hash together with the
commit and tool versions, and deploys that same artifact. Its canonical
Cloudflare deployment message is exactly `git:<40-character SHA>`; the Actions
run and attempt remain in the retained deployment artifacts and release summary.

Validation also runs the chunk-pump and playback-lifecycle static ratchets named
in their design contracts. They are release gates rather than optional local
checks, so a refactor cannot bypass the shared transfer pump or introduce an
unreviewed playback-state writer while ordinary unit tests still pass.

Immediately before each Worker deploy, the workflow verifies that both the
production deployment ID and its 100% version still match the state captured
during preparation. If a manual or external deploy changed either value, the
release stops before overwriting it. Before the first D1, R2, or Worker
mutation, the workflow captures every selected Worker's exact deployment ID,
100% version, and message together with the affected live R2 policies, then
uploads that checkpoint. The production environment concurrency lease makes
the approved GitHub release workflow the only writer while a run is active;
dashboard, local, and other out-of-band deploys are prohibited during that
window. If a later deploy or smoke fails, recovery reads the current deployment
ID, 100% version, and message twice. Cloudflare does not expose an atomic
conditional rollback operation, so the second exact ownership read is the
last precondition before Wrangler rollback and an exact version read-back. Any
observed external deployment is reported as a conflict and left untouched. For
R2, the same single-writer lease applies: recovery restores the captured baseline
only when two fresh reads still match the exact candidate policy, then requires
an exact baseline read-back; any different live policy is left untouched and
becomes a forward-repair floor. The checkpoint, ownership reads, R2 recovery
report, and final report remain attached to the run.

After every selected live smoke succeeds, the workflow queries all Workers
attempted by the run one final time. Their deployment ID, 100% version, and
release message must still match the recorded release. This closes the window
where a local or external deployment could replace an earlier Worker after its
individual smoke; a mismatch fails the release and recovery will not overwrite
the newer deployment.

Standalone live-smoke steps have a five-minute hard ceiling, except for the
PRO-room probe, which has eight minutes for edge propagation. The Developer API
smoke, the PRO media CORS apply/read-back step, and its adjacent public smoke
each have ten minutes. Developer API and remote-share HTTP requests abort after
30 seconds; PRO-room,
app-generation, app-public, and signaling protocol requests use their own
shorter limits. These limits are intentionally far above the tiny synthetic
payloads' normal latency, but prevent a half-open response from indefinitely
delaying failure detection.
The complete deploy job has a four-hour ceiling. A separate 90-minute
`always()` recovery job consumes the persisted pre-mutation checkpoint, so a
deploy-job timeout cannot remove the paired R2/Worker ownership assessment and
forward-repair artifact.
These durations are workflow execution ceilings, not uptime objectives, RTO, or
RPO. The repository does not currently define formal uptime/latency SLOs, an
on-call paging integration, or a recurring data-restore drill. The recovery
checkpoint records Worker deployment identity and Git provenance, the signaling
Custom Domain state, relevant R2 CORS/lifecycle policies, and compatibility
floors. It is not a backup of D1 rows, Durable Object state, or R2 objects; a
data incident requires a separately reviewed provider restore or roll-forward
decision.

After final Worker ownership and, for `all`, generation readiness are verified,
the deploy job records a coherent-production output and artifact marker. A
later artifact-upload or summary failure must not undo that healthy production
commit. The independent job retries both marker and checkpoint downloads; it
also checks the run-scoped artifact inventory. An indeterminate marker or an
unavailable checkpoint after mutation authorization leaves production
untouched and fails for operator review instead of guessing the release phase.
After recovery decisions finish, a non-optional final gate freshly reads every
checkpointed R2 policy and Worker again. Each Worker must be either the exact
captured baseline requested by a successful rollback or the exact failed-release
candidate deliberately retained by a recorded compatibility/dependency floor;
mixed or unowned identities fail the recovery job. Every checkpointed R2 policy
must then freshly match the exact boundary required by those recovered Workers:
the captured baseline when its selected consumers were restored, or the exact
candidate when any selected consumer was deliberately retained on the failed
release. Any other live policy is external drift and remains a red manual
forward-repair boundary. A late policy or Worker change therefore cannot turn
an earlier successful read-back into a green recovery report.
The separate Worker boundary contract keeps bounded JSON request bodies on
10-second read deadlines and newly hardened downstream service/provider reads
on route-specific 5-15-second budgets. The existing playlist-manifest path keeps
its named 45-second ceiling, and the PRO BOT path remains inside one 35-second
total envelope. See the maintained first-48-hours checklist for the exact
affected services; do not remove those limits to make a hotfix smoke pass.

The release workflow does not attempt an automatic down migration after the
Developer API baseline is applied. A failed schema-bearing release keeps the
Developer API facade/backend pair on the forward-compatible release floor and
requires a reviewed roll-forward or provider restore. The historical paired
effects-scope SQL remains recorded in the D1 manifest only as immutable audit
history; it is not invoked by current recovery automation.

The app and signaling rollback floor includes first-frame standard-room host
authentication and the exact PRO WebSocket subprotocol ticket negotiation.
Rollback restores the App first and restores signaling only after that App
baseline is verified. If a durable or R2 compatibility floor keeps the current
App, recovery also keeps the current signaling Worker; otherwise a retained
subprotocol-only client could be paired with an older incompatible Worker.
Signaling still delegates PRO chat and authority decisions to the PRO room
Worker. If signaling cannot be verified as restored, recovery keeps the current
PRO Worker instead of creating a known broken new-signaling/old-PRO pairing.
That dependency fence is reported as a partial failure for operator review.

The same dependency is fenced in the forward direction. Before any approved
partial release, the workflow reads every unselected Worker's live deployment
message, requires an exact `git:<40-character SHA>` provenance token, proves
that commit is an ancestor of the candidate, and checks that Worker's mapped
runtime inputs for undeployed changes. The app mapping covers client source,
CSS, public and workshop pages, static-header generation, and production npm
dependency resolutions. Worker mappings include their transitive local helper
modules, generation migration contracts, and deployment configuration. A
deleted runtime file is a change too.
If the proof is unavailable or a counterpart changed, use target `all` rather
than guessing that the contracts remain compatible.

An app-only production release reuses an exact-SHA CI candidate that has passed
the focused Chromium gate, proves partial dependency compatibility before
deployment, and keeps the production deploy job itself browser-free by running
generation/initial-asset-graph and anonymous-session-boundary HTTP smokes after
deployment. The full Playwright suite remains auxiliary.
The emergency-only `emergency:deploy:app` command additionally runs the
standalone live signaling smoke. A signaling protocol change must be deployed
and smoked first (normally with release target `all`); the preflight fails
closed while production still serves an incompatible signaling contract.

Recovery preserves the previous deployment's original Git SHA in the checkpoint
when that provenance exists. A legacy or manual deployment without Git
provenance remains deliberately unverifiable; use target `all` for the next
approved forward-repair release to establish a fresh common baseline.

The combined `admin-announcement-v2+abuse-rate-v2+session-idempotency-v1+maintenance-status-headers-v1+abuse-rate-response-headers-v1`
service-control marker requires an `all` rollout in this order: PRO,
remote-share, signaling, Developer API facade/API, then App. Announcement v2
adds a dedicated named announcement Durable Object owned by the PRO Worker, so
that owner must be deployed before any consumer can address the new instance.
While the dedicated object is empty, the App preserves the legacy announcement;
the first accepted mutation carries its revision and history into the new object.
After that object has a canonical revision, it is the sole announcement source.

Maintenance status uses a null-body `HEAD` response with versioned headers, and
abuse-rate consumers opt into a null-body result-header response on the same
single mutating `POST`. Legacy producers remain readable from that same
response; consumers must never replay a consume request as protocol fallback.
The App never synchronously waits for maintenance control on a public request:
it serves from its last canonical isolate snapshot and refreshes in the
background. A cold App isolate can therefore admit traffic before its first
snapshot. Treat the dashboard switch as an availability-oriented suppression
control, not a strict global traffic or storage freeze; use a pre-Worker edge or
deployment control plus the documented storage protections when a hard freeze
is required.

This cutover is a permanent forward-only data floor once the v2 App/PRO pair has
deployed or the dedicated announcement object has recorded revision 1 or later.
Do not manually restore or intentionally deploy an App or PRO Worker from before
that marker: pre-v2 code addresses the legacy co-located announcement store and
can diverge from or revive a stale notice while the dedicated object retains a
different canonical revision. Recovery marks that downgrade as a forward-only
floor. Keep both Workers at or above the marker and use an `all` target
roll-forward/forward-repair release.

Soro article visibility has an App-only data floor marked by
`cloudflare/soro-article-visibility-contract-version.txt`. The `app` and `all`
release targets apply and verify its D1 table before deploying App. On the
first marker cutover, a live candidate or an unprovable current version prevents
App rollback in both recovery jobs; an unchanged captured baseline remains
eligible. Later releases with the same marker may restore a compatible App
baseline. Recovery requires the committed marker and complete immutable
checkpoint evidence. Never restore older code that ignores the canonical D1
visibility overrides, delete explicit `hidden=0` rows, or fall back to stale KV
visibility during recovery. Use an App forward fix or an explicitly reviewed
matched data/code restore; see [Admin Dashboard Ops](../cloudflare/admin-dashboard-ops.md).

If the recovery report records a conflict or unreadable floor, inspect the live version before taking manual
action and prefer a new exact-SHA `all` release. Deployment records and the
Actions summary are written even when the in-job recovery path fails; the
independent job retains the pre-mutation checkpoint and its own report.

Cloudflare's separate Git-triggered app deployment must remain disabled while
the GitHub release workflow is authoritative. The source audit cannot prove
that dashboard-only state, so verify it manually; keeping both paths enabled
creates an unapproved duplicate deployment.

### Local emergency deployment

The ordinary local `deploy:*` scripts are deliberately non-deploying traps: they
always stop and direct the operator back to the approved GitHub workflow. For a
local emergency app-only deployment, first land the committed fix on
`origin/main`, then check out that exact commit on a clean `main` worktree. Bind
the exact target and current commit into the one-shot
confirmation before using the cross-platform Node deployment orchestrator,
which also verifies signaling and rebuilds `dist`:

```bash
export MXQR_EMERGENCY_DEPLOY_CONFIRM="MUSIXQUARE_EMERGENCY_DEPLOY:app:$(git rev-parse HEAD)"
npm run emergency:deploy:app
unset MXQR_EMERGENCY_DEPLOY_CONFIRM
npm run smoke:live:app-generation
npm run smoke:live:app-public-boundary
```

PowerShell uses the same exact confirmation:

```powershell
$sha = (git rev-parse HEAD).Trim()
$env:MXQR_EMERGENCY_DEPLOY_CONFIRM = "MUSIXQUARE_EMERGENCY_DEPLOY:app:$sha"
npm run emergency:deploy:app
Remove-Item Env:MXQR_EMERGENCY_DEPLOY_CONFIRM
npm run smoke:live:app-generation
npm run smoke:live:app-public-boundary
```

For another Worker, replace `app` in both the confirmation and npm script with
one of `remote-share`, `pro-room`, `signaling`, `developer-api-stack`, or
`all-workers`. The Developer API facade and backend are one deployment contract;
their standalone emergency aliases deliberately stop and direct the operator to
`developer-api-stack`. A confirmation for a
different target or an older commit is rejected, as is any dirty worktree. The
guard also rejects detached/non-`main` checkouts and any HEAD that differs from
the live `origin/main` reported by `git ls-remote`, so a stale local tracking ref
cannot authorize an old release and every emergency deployment remains
traceable to GitHub. A network or remote-authentication failure fails closed. The
environment variable is authorization for exactly that command invocation; do
not put it in a profile, `.env` file, CI secret, or shell startup script.
The orchestrator derives the exact `git:<full-HEAD-SHA>` deployment annotation itself
and passes that immutable message to every Wrangler Worker deployment,
including both Developer API Workers and every Worker in `all-workers`.
Operator-supplied trailing arguments are rejected rather than forwarded to
Wrangler, so do not add `-- --message` or any other command-line option.
Before any partial emergency deployment, the same live deployment provenance
and unselected-Worker source compatibility gate used by the approved workflow
runs locally. The orchestrator also captures each selected Worker's exact live
identity and repeats both the unselected compatibility check and selected
preflight immediately before every deploy command. Emergency deployment is
recorded after each command and all selected Workers must still match those
exact deployment identities in one final verification. Emergency deployment is
strictly code-only: if the live Worker SHA-to-candidate diff contains a tracked
D1 migration/schema, R2 CORS/lifecycle policy, contract marker, or Wrangler
configuration change, it stops and requires the approved Production Release
workflow. `developer-api-stack` and `all-workers` therefore do not apply D1
schema changes. If another Worker changed in the pushed commit, use
`all-workers` only when the code-only fence still passes; otherwise use the
approved `all` release.

These emergency-deployment checks are intentionally browser-free; the focused
Chromium gate belongs to exact-SHA CI. After the deploy is live, verify the
production URL. The full Playwright E2E suite remains auxiliary.
Confirm the active version with
`npm run wrangler -- deployments status --config cloudflare/wrangler.app.toml --json`.

As manually recorded on 2026-08-17, the `production` environment uses an
account-owned Cloudflare Worker deployment token with a recorded 2027-07-16
expiry. Repository automation cannot verify that provider-side date; confirm it
in Cloudflare and rotate before expiry. Update the environment secret named
`CLOUDFLARE_API_TOKEN`; never copy a local Wrangler OAuth credential into
GitHub. Keep D1 writes on a separate account token in
`CLOUDFLARE_D1_API_TOKEN`, restricted to this account with the `D1:Edit`
permission. The Worker token is injected only into steps that call Cloudflare
management APIs for credential verification, checkpoint/status reads, R2 policy
mutation/read-back, Worker deployment, final verification, or recovery;
dependency installation, artifact verification, and public live-smoke code
never receive it. The release workflow probes
the D1 token before any Worker deploy when a D1 change is requested, so a
missing or under-scoped credential stops without rolling production forward and
back. Keep base-schema changes additive and backward-compatible because Worker
rollback does not reverse a successfully committed D1 schema import; tracked
destructive changes need their own reviewed manifest entry and explicit recovery
decision. Add rollback SQL only when the change is honestly reversible;
otherwise declare the migration forward-only with its matched Worker floor,
roll-forward, or provider-restore runbook.

### Worker scope and order

The release workflow deploys only the selected scope. The `developer-api` scope
deploys its private facade before its public Worker. For a backward-compatible
change that touches every Worker, `all` uses this order so the existing browser
remains usable while backends roll forward:

1. `cloudflare/wrangler.pro-room.toml`, then its version-aware health smoke;
2. `cloudflare/wrangler.remote-share.toml`, then its live smoke;
3. `cloudflare/wrangler.signaling.toml`, then its live smoke;
4. `cloudflare/wrangler.developer-api-facade.toml` (private service binding only);
5. `cloudflare/wrangler.developer-api.toml`, then its authenticated live smoke
   against the fixed `000001` smoke room;
6. `cloudflare/wrangler.app.toml` with the verified artifact, then browser-free
   generation/initial-asset-graph and anonymous-session-boundary smokes.

The production environment secret `MXQR_DEVELOPER_API_SMOKE_KEY` must contain a
valid key limited to room `000001`; it is used only by the release smoke and is
never embedded in the immutable app artifact. Production mode is enabled for
registered PRO rooms, but every credential remains bound to exactly one room
and is issued or revoked from the Access-protected admin surface. Keeping the
release smoke fixed to `000001` makes the deployment check reproducible; it does
not limit API availability to that room.

Before the first App Worker deployment that includes dashboard key issuance,
run `npm run developer-api:admin-secret:sync` from the secured operator machine.
It copies the existing Developer API pepper to the App Worker through stdin and
never prints or stores the value in a tracked file. Worker secrets persist across
later deployments, so this is a one-time setup unless the pepper is rotated.

The App build floor relies on this order. From App 9.0.14 the App sends `appBuild` in
`host-auth`, which an older Signaling Worker's exact-key validator refuses, so the Signaling
Worker that accepts it must be live first; `all` deploys it before the App, and a partial
release that leaves an older Signaling Worker behind fails its compatibility gate. A release
raise of the floor runs only after the App smokes and the commit marker
([App Build Floor](#app-build-floor)).

That Worker-first order applies only to backward-compatible protocol changes.
For an intentional hard cut such as the `queueItemId` remote-share migration,
follow the coordinated deployment contract in
[`design/queue-item-identity-and-reorder.md`](design/queue-item-identity-and-reorder.md); a mixed
old/new app and Worker pair is unsupported and must not be rolled out as an ordinary hotfix.

The PRO room persistence-v2 contract is a coordinated hard cut. Deploy the PRO
Worker before the app and deploy the Developer API facade/public Worker before
the app whenever their queue-response contract is part of the release. Current
clients mutate playlists only through the compact endpoint; there is no legacy
full-snapshot mutation route. Cached pre-cut clients are unsupported and must
reload. Do not roll the PRO Worker back to a pre-v2 version: use a v2-aware
forward fix or an explicit operator data-restore procedure instead.

Before an emergency local deploy, save the version reported by
`npm run wrangler -- deployments status --config <config> --json`. Confirm that the
saved version is compatible with every migration already applied before using
it as the immediate rollback target.

## Client Update Behavior

MUSIXQUARE is a PWA with a service worker, so "deployed" and "every open client is already running it" are different things.

Current behavior:

Product SemVer and the service-worker cache epoch are intentionally independent.
See [release versioning](release-versioning.md). A hotfix normally advances the
product patch version when it changes shipped behavior or public product copy;
it advances `SERVICE_WORKER_CACHE_VERSION` only when the PWA cache boundary also
needs to move. The Git SHA
and Cloudflare Worker version IDs identify the exact deployed build.

| Client state                                | Expected behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New visitor or fresh navigation             | Navigation is network-first, so the user should receive the latest deployed app shell immediately unless offline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Existing open tab, any screen               | `src/sw-register.ts` performs an immediate update check after registration and then checks every 60 minutes. Owner decision 2026-10-17 ([report](design/update-dialog-everywhere-2026-10-17.md)) replaces the 2026-10-11 in-room notice ([report](design/in-room-update-prompt-2026-10-11.md)) and the 8.11.6 apply on reopen ([report](design/update-apply-on-reopen-2026-10-16.md)): a waiting worker always gets the same update dialog (적용하기 / 나중에), on the setup screens, in standard and PRO rooms, and in the demo. One found while the page is open is offered at once. One already waiting when a document opens is offered once the page's loads have been quiet for 1 second (at most 6), because Chromium can hold a `SKIP_WAITING` sent during those loads for about a minute. The message says what applying costs: outside a room "새 버전이 준비되었어요. 적용하면 페이지를 새로고침해요."; for a standard-room host, including the code screen before Start, "... 적용하려면 방을 다시 열어야 해요."; for anyone else whose session started or who has a room context (a guest, every PRO participant, a PRO room during presence re-entry) "... 적용하려면 방에 다시 입장해야 해요.". No chat notice or toast announces an update, and nothing is sent to peers. |
| Existing open tab in a room or the demo     | Gets the same dialog with the room's message; it is no longer deferred, and 나중에 keeps the room or demo as it is. A tab counts as in a room while `network.appRole !== 'idle'`, `setup.sessionStarted` is set, or a room context is set, so the create and join screens, an invite page waiting for Start, and a PRO room during presence re-entry (after a phone lock longer than the 45-second presence TTL, or an account detach) count too; this decides the other-tab row below. Owner-approved exception (2026-10-11): when a room-time lazy feature fails to load (Connect, announcements, the room session, or PRO setup), the lazy-feature recovery dialog in `src/app.ts` opens. Since 2026-10-28 it offers 닫기 / 새로고침 (닫기 keeps the room and leaves only that feature unopened), and it uses its own copy (`dialog.feature_refresh_title` / `dialog.feature_refresh_msg`: "새로고침이 필요해요" / "MUSIXQUARE가 업데이트되었어요. 정상적으로 사용하려면 새로고침이 필요해요."), not the update dialog's.                                                                                                                                                                                                                                                              |
| Tab leaves a room or the demo               | Nothing was deferred, so nothing is offered on leaving. Most leave paths navigate to `/`, and the new document asks again for a generation that is still waiting. A document that returns to setup in place keeps a generation put off with 나중에 put off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| User accepts update dialog                  | The page sends `SKIP_WAITING`, records a 30-second cooldown in `sessionStorage`, marks the navigation intentional, and reloads once after `controllerchange`. A page outside a room and a standard-room host reload in place (an invite link keeps its `/CODE` URL; a host's room ends with the page). Anyone else whose session started or who has a room context goes to that room's `/CODE` invite page with `mxqr_reconnect_target` set, as the reconnect flow does, and taps Start to enter again: a reload cannot enter by itself, because the browser needs that tap before it plays sound. Without a valid six-digit room code the page reloads in place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Other same-origin tabs when one tab accepts | `controllerchange` fires in every controlled tab. Idle tabs (outside any room as defined above, and not in the demo or its exit curtain) auto-reload. Tabs in a room or the demo never auto-reload: they show the same update dialog once per generation (not for a generation put off with 나중에 in that document), and 적용하기 reloads them as above. The worker keeps retired-version caches until every live tab confirms that its page loaded under the active controller, so a tab that keeps its room can still import its old hashed lazy chunks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Update found during cooldown                | Within 30 seconds of an update reload, a newly found waiting worker is activated silently to avoid a reload-dialog loop. An idle tab then reloads once; a tab in a room or the demo gets the update dialog after `controllerchange` instead of a reload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| User dismisses update dialog                | 나중에, or Back on the dialog, puts that generation off for the current document only. The app does not activate it, the same document does not ask again for it, a newer generation is asked about at once, and nothing is stored: the next document (a reload or reopen) shows the same dialog while the worker still waits. A 24-hour dismissal stored by versions up to 8.11.10 is dropped when read. Only a dialog that failed to open still cools that generation down for 5 minutes across tabs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PWA/background tab                          | Delivery depends on when the browser wakes the page and allows the update check. Treat this as browser-controlled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Stable same-origin static revalidation has a five-second deadline covering
both response headers and body. A cached response is still returned immediately;
timed-out work is aborted and cannot replace the cache with a late response.
This prevents that background fetch from indefinitely holding an approved
update after the bounded worker is active. Deploying the fix cannot cancel
requests already owned by an older worker: a stuck first upgrade may still
require the request to settle or all app tabs to close before reopening.

Bumping `SERVICE_WORKER_CACHE_VERSION` in `scripts/service-worker-asset.ts`
creates fresh active app-shell caches and is the current lightweight way to
make existing clients notice an app-shell migration. The build injects that
epoch into the stable `/service-worker.js` output. Prior generations are
retired only after the page/worker readiness handshake confirms that no live
tab still needs them (or when activation sees no live window clients). It still
does not create a guaranteed instant reload for every active/background client.

`npm run guard:sw-cache-version` enforces this migration boundary for committed
PWA runtime changes. Include the bump in the feature commit when practical. A
separate bump commit is also valid if it lands before push and the final
committed `HEAD` passes `npm run build:checked`; the guard passes once the latest
bump covers the resulting app tree. Repository-only documents such as `README.md`,
`CONTRIBUTING.md`, `docs/**`, and `cloudflare/*ops.md`, plus Worker-only and
test-only changes that do not advance product SemVer or its browser admin
mirror, do not require a bump. A Worker module that browser code imports, such
as `cloudflare/app-build-floor-contract.ts` or
`cloudflare/pro-room-receipt-timing.ts`, is compiled into the App bundle and
does require one; the guard derives these files from the value-import graph of
`src/`, `browser/`, `index.html`, and the public `.workshop` pages at both ends
of the checked range. The `vite.config.ts` helpers that change the emitted App,
`scripts/browser-target.ts` and `scripts/locale-recovery-assets.ts`, also
require one. Files under `public/**` and the
production `.workshop/{landing,privacy,terms,faq,developers,translate,sitemap}/**` trees are App
artifact inputs and do require a covering bump. The guard reads committed
first-parent `HEAD`, not the working tree, so run `npm run build:checked` after
the final bump commit and before pushing. A build performed before that commit
does not replace this check; the normal procedure builds once after committing.
The check
intentionally fails on a shallow clone because it cannot prove where the latest
bump occurred, so the CI candidate build and release deployment checkout must
retain full git history (`fetch-depth: 0`).

## Emergency Hotfix

Use this when stale clients are likely to keep hitting a severe bug.

1. Make the minimal code fix.
2. Advance the product patch version and every required mirror when shipped
   behavior or public copy changes, as defined by
   [release versioning](release-versioning.md).
3. Bump `SERVICE_WORKER_CACHE_VERSION` in `scripts/service-worker-asset.ts`.
4. Run the repository's non-E2E verification baseline:

   ```bash
   npm run typecheck
   npm run lint
   npm run format:check
   npm test
   npm run check:workers
   npm run build:checked
   ```

5. Commit on a hotfix branch, merge a reviewed pull request into `main`, and
   wait for its exact-SHA CI candidate. If the incident cannot wait for that
   path, use the separately guarded
   [local emergency deployment](#local-emergency-deployment) rather than
   silently bypassing review.
6. Run the `Production Release` workflow for the affected scope.
7. After Cloudflare deploys, verify:
   - fresh production load
   - an already-open production tab
   - service-worker update dialog or cooldown behavior
   - the specific broken scenario

Do not add a forced reload mechanism casually. There is no current production broadcast infrastructure for forced reloads, and forcibly reloading active audio/session clients can be worse than letting the service-worker update flow handle it. To keep builds that are too old out of rooms, use the [App build floor](#app-build-floor), which refuses their new entries instead of reloading anyone.

## App Build Floor

The App build floor (forced update, App 9.0.14; record RO-50 in the
[resource ownership registry](design/resource-ownership-registry.md), evidence in the
[train report](design/forced-update-9-0-14-2026-10-25.md)) refuses new room entries
from App builds below a minimum: the Signaling Worker refuses a `host-auth` or `guest-auth` whose
`appBuild` is lower (a missing one counts as 0), and the PRO front door refuses bootstrap,
sessions and presence entry. Open sessions are never closed. The build number is the
service-worker cache epoch (`v787` is build 787; see
[release versioning](release-versioning.md#app-build-number-and-floor)). The control object
enforces the lower of the stored floor and the live App build that the App Worker reports every
minute, and nothing once that report is five minutes old, so the enforced floor never stays above
the App that is live. Refused 9.0.14+ pages, and 9.0.14+ pages that read a higher floor at start
or on return to the foreground, show the update dialog without Later; older builds show their
generic error and recover when reopened.

Change it only through GitHub Actions. No secret or owner credential is involved: the App
Worker's ops route accepts only a GitHub OIDC token of this workflow or the Production Release
on `main`, named by the token's `workflow_ref`. Both jobs run their own steps; a token minted
inside a reusable workflow (such as the release's recovery job) is refused. Whoever may dispatch
workflows on this repository (in the GitHub UI or with `gh`) can read, set and lower it; nobody
enters a password or token.

```bash
gh workflow run app-build-floor.yml --ref main -f action=status
gh workflow run app-build-floor.yml --ref main -f action=check
gh workflow run app-build-floor.yml --ref main -f action=set -f min_app_build=<build> -f reason="<why>"
gh workflow run app-build-floor.yml --ref main -f action=lower -f min_app_build=<build> -f reason="<why>"
```

- `set` never goes above the live App build, and `lower` to 0 turns the floor off. Each change
  is verified end to end (the status, the PRO and Signaling refusal of build N-1, an App cron
  report newer than the change, and the page's client read within the edge-cache lifetime plus
  30 seconds) and ends with one summary line for section 1 of the
  [release record](release-record.md). A `lower` is fail-safe, so a missing cron report after it
  only leaves a warning; a `set` or raise without one fails. The admin dashboard can only lower
  the floor. The Signaling check proves only the refusal of build N-1, not the admission of build
  N; the PRO check proves both.
- The workflow shares the Production Release concurrency group. Never dispatch it while a release
  is running or queued: GitHub keeps one pending run per group, and a newly queued run cancels
  the pending one. Take the run ID from
  `gh run list --workflow app-build-floor.yml --branch main --event workflow_dispatch --limit 1 --json databaseId,createdAt,status`
  only when its `createdAt` is later than the dispatch. Afterwards read
  `gh run view <run-id> --json conclusion`; `cancelled` means the run was replaced and nothing ran.
  A workflow `lower` therefore cannot run while a Production Release holds the group (its deploy
  job may take up to 240 minutes). If GitHub Actions is unavailable, or a Production Release is
  running or queued, the owner lowers the floor in the admin dashboard (Maintenance, App build
  floor panel, lower only).
- A `set` changes the floor first and verifies it afterwards, so a run that does not end in
  success can leave the new floor stored and enforced. Read
  `curl -s https://musixquare.com/api/app-build-floor`. If the stored floor is the target and the
  failure was transient (a rate limit, a late cron report, a cached client read), dispatch the
  same `set` again; with the floor already stored it only verifies. If the PRO front door refused
  the target build or Signaling misbehaved (for example the Signaling smoke below refused a host),
  `lower` at once and investigate: to 0 for the first floor, and for any later raise to the
  previous verified floor, not to 0. That is the value stored before the raise as its last
  successful run proved it, normally a same-value `set` just before the raise. A `lower` proves
  only what holds at the effective floor N of that moment, which may be below its target: the PRO
  front door refuses build N-1 and admits build N, and Signaling refuses build N-1 (at 0, only a
  PRO admission). It never proves that Signaling admits a host. So once it succeeds, run the
  Signaling smoke of the first floor again: both rooms must admit their host and guest, and
  `legacyCompatibility.refusedBelowAppBuildFloor` must equal the lowered floor (retry once after
  a transient 502 or 503). Lower to 0 only when a host is still refused or that `lower` run fails.
  If the hosts are admitted but that value is not the lowered floor (for example
  `admittedWithoutAppBuild`), do not lower to 0: read the status again (the effective floor and
  the App report's `reportedAt`) and run the smoke again. That answer comes from a window in which
  the effective floor is 0 (an App report more than five minutes old, or a failed floor read in a
  new isolate). If the App report has stopped, fix that first and keep the lowered floor: lowering
  to 0 would leave the cause in place and the floor off after the reports return.
- A release that needs a floor sets the Production Release input `raise_app_build_floor` (target
  `app` or `all`). The raise runs only after the commit marker, and only to this release's build
  when that build is the live App. If it fails, the release stays committed and is not rolled
  back; rerun `set` with the standalone workflow. Later raises need no separate owner approval
  (owner decision 2026-10-25): the release that needs one sets the input. That raise does not fit
  a release that stops sending a field or marker that older builds the current floor admits still
  require, or starts sending a shape they cannot read: it comes only after the release's App
  deploy, App smokes and commit marker, and only to the release's own build, which is higher than
  needed and shows the update dialog without Later to every build in between. Raise the floor for
  such a release beforehand with a standalone `set` to the oldest build that copes, prove
  Signaling admission at that floor with the smoke described for the first floor below, and
  dispatch the release with `raise_app_build_floor` false (old-version removal train 3, 9.0.21,
  sets 789 first).
- A Production Release with target `pro-room` or `all` checks the floor before it changes
  anything: its step "Check the App build floor the PRO Worker requires" runs after the
  partial-release dependency compatibility check and before the recovery checkpoint, so a stop
  changes nothing and starts no recovery. The step checks the floor once, at that moment; nothing
  later in the release checks it again. `MXQR_PRO_ROOM_REQUIRED_APP_BUILD` on that step names
  the App build that the PRO Worker on `main` requires of every client. The value lives in
  `.github/workflows/release.yml`, outside every runtime path list, so writing or clearing it never
  changes a release target; while it is empty the step only logs that nothing is required.
  Otherwise the release continues only when the public status shows both the stored and the
  effective floor at that build or above. The step reads an unreadable status again for 30
  seconds. It waits only while the stored floor reaches the value but the effective floor is 0
  (no App report for five minutes): then it waits up to 3 minutes for a new App report, and a
  status still unreadable or an effective floor still 0 then stops the release. After such a
  stop, dispatch again once the status shows a fresh `reportedAt` from the next App report
  (every minute). If the stopped App report or the unreadable status needs a repair that ships
  with target `pro-room` or `all`, that repair pull request clears the
  value (a lower value cannot pass while the effective floor is 0); once the status shows both
  floors at the required build again, a small tooling pull request writes it back while the PRO
  Worker still requires it. An `app` release does not run the step. A stored or a non-zero
  effective floor below the value does not pass by waiting: do not clear the value then unless
  the same pull request also ends the requirement; otherwise the PRO Worker ships with a
  requirement that the floor does not enforce. A local emergency deployment of `pro-room` or
  `all-workers` (`scripts/emergency-deploy.mts`) does not run this check. While the value in
  `release.yml` is set, read the public App build floor status first
  (`curl -s https://musixquare.com/api/app-build-floor`) and go ahead only when both
  `minAppBuild` and `effectiveMinAppBuild` reach the value.
- First floor (owner decision 2026-10-25): the App 9.0.14 release ships with the floor at 0 and
  `raise_app_build_floor` false. Once its smokes and public assets are verified, run `status`
  (the live App build is the released one and the App report is fresh), then `check` (the OIDC
  path end to end, no change), then `set` with the released build and a reason. Read each run's
  conclusion before the next dispatch. Right after the `set` succeeds, prove that Signaling admits
  the released build: from a checkout of the released main SHA, run `npm run smoke:live:signaling`
  without `MXQR_EXPECTED_SIGNALING_VERSION` (no credentials). It must end with `ok` true,
  `appBuild.build` equal to the floor, both rooms admitting their host and guest, and
  `legacyCompatibility.refusedBelowAppBuildFloor` equal to the floor. Like the
  release smoke it opens two smoke rooms in production. If a host is refused, run `lower` to 0 at
  once; retry once after a transient 502 or 503.
- Recording: the summary line of a `set`, `lower` or release raise goes into the "최소 앱 빌드"
  (minimum App build) row of section 1 of the release record. A release copies it while
  overwriting section 1; a standalone change between releases updates that row in a small record
  pull request and adds no release-history row (it is not a deployment). The first floor's record
  (the release's deployment record pull request if it is still open, otherwise a small record
  pull request) also removes the release record's first-floor open item in section 2, citing the
  `set` run ID, and moves known-accepted #13 to Retired Risks with that evidence. It still adds no
  release-history row.
- Automated failed-release recovery needs no floor step. Raises happen only after a commit marker
  or through the standalone workflow, both in the release concurrency group, and the dashboard
  only lowers, so the automation alone never leaves the stored floor above the App build of a
  recovery checkpoint. The stored floor exceeds a checkpoint App only after a person rolled the
  App back below it by CLI or in the dashboard without `lower`. Even then the enforced floor is
  clamped to the reported live build within one minute (or turns off within five minutes for an
  App older than 9.0.14, which never reports), and the drift audit flags the stored value.
- Before a CLI rollback of the App to a build under the stored floor, run `lower` to that build
  first (0 for a build older than 9.0.14, which has no floor routes and never reports) and wait
  for that run to succeed; the CLI rollback block under [Rollback](#rollback) carries the line.
  No script enforces it. Otherwise new entries of that build are refused until the next App
  report: up to one minute, or up to five minutes for a build older than 9.0.14. A Cloudflare
  dashboard rollback cannot be guarded; the report clamps the enforced floor the same way, and
  `lower` or a roll forward lifts the stored value while an App of 9.0.14 or later is live.
- A local emergency `app` or `all-workers` deployment reads the public status first and stops
  when the local build is below the stored floor, naming the `lower` command. When the status
  cannot be read it warns and continues.
- Never roll the Signaling Worker back below 9.0.14 while an App of 9.0.14 or later is live: an
  older Signaling Worker refuses every `host-auth` that carries `appBuild`. Roll the App back
  first, as automated recovery already does. If the 9.0.14 release itself fails after its App
  deploy, automated recovery rolls the App back to 9.0.13 and then Signaling below 9.0.14. A
  9.0.14 tab opened in that window cannot create a Standard room or reconnect as host
  (`HOST_AUTH_FIRST_FRAME_INVALID`) until it applies the update dialog back to the restored App
  (v786). Guests are not affected: the older guest validator ignores the extra key.
- Once a Signaling Worker that no longer advertises the peer-open markers is live (9.0.21,
  old-version removal train 3), an emergency recovery that takes the App below 9.0.15 rolls
  Signaling back first, in this order only: (1) Signaling to the version in that release's
  recovery checkpoint (9.0.14 or later, which still advertises them), (2) `lower` to the target
  build (787 for 9.0.14, 0 for an older App), (3) the App. Rolling Signaling back first loses
  nothing: an App of 9.0.15 or later reads none of the markers, and every Signaling Worker of
  9.0.14 or later accepts a first offer and answer without `iceRestartVersion`. Rolling the App
  back first lets a 9.0.14 tab opened in between meet the newer Signaling Worker: its Remote
  Share uploads fail with `REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE`, and its host liveness
  probe and PIN membership choice are off. The App-first rule above applies only when Signaling
  itself goes below 9.0.14.
- The service-control object that holds the floor (`MusixquareServiceControl`) lives in the PRO
  Worker script; every other Worker binds it with `script_name = "musixquare-pro-room"`. Rolling
  the PRO Worker back below 9.0.14 therefore turns the floor off for every Worker, Signaling
  included: the older object answers 404 on the floor paths, which every reader takes as floor 0.
  The floor workflow and the admin panel cannot read or change the floor until the PRO Worker
  rolls forward, and the stored value comes back then.
- A raise does not close open sessions, but every Signaling Worker deployment restarts its Durable
  Objects and reconnects every Standard socket (Cloudflare-documented behaviour, not verified in
  this project), so the next release that deploys signaling after a raise turns below-floor rooms
  into refused reconnects at once (P2P keeps playing, the host can no longer admit anyone). The
  release that raises is not affected, because signaling deploys before the raise.
- The daily Operations Drift Audit fails when the stored floor is above the live App build that
  the App reports, or when a floor is on without a fresh App report. A 404 from a live App whose
  build is below the checked-out build (between merging the forced update train and releasing it,
  or after rolling the App back below it) is reported as manual-only, not as an error: that App
  never reports, so no floor is enforced.

## Rollback

If a deployment is bad:

1. Inspect the failed release's recovery checkpoint and current live deployment.
   Do not use an old version when a D1, Durable Object, service-control, or R2
   forward floor is active. Cloudflare Worker rollback has no atomic ownership
   precondition, so coordinate a manual change and recheck that no newer deploy
   appeared before applying it. The App build floor is not such a forward floor:
   an App below it may be restored after its `lower` (see
   [App Build Floor](#app-build-floor)).
2. In git, prepare a revert without committing it immediately:

   ```bash
   git switch main
   git pull --ff-only origin main
   git switch -c agent/restore-known-good-behavior
   git revert --no-commit <bad-commit-sha>

   # If the bad release advanced product SemVer, keep moving forward to a new
   # patch version and update every required mirror. If it advanced the PWA cache
   # epoch, choose an epoch greater than the bad release; never restore an older one.

   npm run typecheck
   npm run lint
   npm run format:check
   npm test
   node --check cloudflare/app-worker.ts
   npm run guard:developer-api-boundaries
   npm run guard:d1-migrations
   npm run guard:ops-drift-contract

   git add <revert-and-forward-version-files>
   git commit -m "revert: restore the last known-good behavior"

   # Build once against committed history, including monotonic cache/version guards.
   npm run build:checked
   git push -u origin agent/restore-known-good-behavior

   # Open a pull request into main, wait for CI, and merge the reviewed rollback.
   ```

   When the reverted commit advanced product SemVer, set `package.json` to a new
   higher patch version and update `package-lock.json`, `ADMIN_ASSET_VERSION`,
   and `ADMIN_SCRIPT_VERSION` before the single rollback commit. When it touched
   PWA inputs or advanced `SERVICE_WORKER_CACHE_VERSION`, set a new cache epoch
   greater than the bad release in that same commit.

3. Run the `Production Release` workflow for the reverted scope, then rerun its
   live smoke; merging the revert into `main` alone does not update Cloudflare.

Avoid `git reset --hard` plus force push on `main` unless there is no reasonable alternative.

For an explicitly reviewed CLI rollback with no active forward floor, deploy the
saved known-good version at 100%. When the App goes below the stored App build
floor, run its `lower` first and wait for that run to succeed (see
[App Build Floor](#app-build-floor)):

```bash
# Only when the App goes below the stored App build floor (0 for an App older than 9.0.14):
gh workflow run app-build-floor.yml --ref main -f action=lower -f min_app_build=<target-app-build> -f reason="Rollback: <reason>"
gh run watch <lower-run-id> --exit-status

npm run wrangler -- versions deploy <known-good-version-id>@100% --config <worker-config> --yes --message "Rollback: <reason>"
```

Cloudflare migration history is append-only. In particular, the removed
remote-share Durable Object must not be "restored" by selecting a version from
before its deletion migration; use a known-good post-deletion version.

## External Dependency Incidents

Treat these separately from app hotfixes unless the app has a confirmed code-level workaround.

| Dependency                                         | User symptom                                                              | Current response                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PeerJS-compatible signaling / Cloudflare signaling | New sessions or remote peers fail to connect.                             | Check the configured transport and service status. Prefer rollback or a small isolated compatibility patch over broad session rewrites; public production hosts do not automatically fall back to PeerJS. |
| TURN credential endpoint / Cloudflare Worker       | Remote peers may fall back to STUN-only and fail across restrictive NATs. | Confirm `/api/get-turn-config` response and Cloudflare status. Do not cache TURN credentials.                                                                                                             |
| YouTube IFrame API                                 | YouTube mode fails while file playback still works.                       | Confirm iframe/API availability. File mode remains the fallback user path.                                                                                                                                |
| Browser audio/WebRTC policy changes                | iOS/Safari/Chrome-specific playback or connection drift.                  | Reproduce on the affected real device/browser. Unit tests cannot prove this class of issue.                                                                                                               |

## Post-Hotfix Checklist

- Confirm production behavior on a fresh load and an already-open client.
- Confirm the active Cloudflare version for every deployed Worker.
- Run the live smoke that covers every deployed Worker.
- Record the root cause and the exact user symptom.
- Add or update a regression test when the issue is representable in unit/jsdom tests.
- Add a manual verification note when the issue is browser/device-specific, as
  an open item under 실기기 확인 in [release-record.md](release-record.md) §2.
- Overwrite [release-record.md](release-record.md) §1 and its review line, and
  append one row to [release-history.md](release-history.md). This also applies
  to a local emergency deployment or a CLI rollback. Include the App build floor
  summary line (a release raise, or `status` after a rollback) in §1.
- If the fix changes a cross-domain contract, update the relevant file under `docs/`.
