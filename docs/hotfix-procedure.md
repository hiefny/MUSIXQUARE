# Production Hotfix And Rollback Procedure

Reviewed against `public/service-worker.js`, `src/sw-register.ts`, the six
Wrangler configs, the production release workflow, and the live-smoke scripts
on 2026-08-09. Read the current
`CACHE_VERSION` from the service-worker source rather than copying a number
from this procedure.

This document is the canonical production hotfix note. Untracked workshop
drafts are not release instructions.

## Normal Hotfix

Use this path for ordinary production bugs that do not require immediate client replacement.

```bash
git checkout main
git pull origin main

# make the fix

npm run typecheck
npm run lint
npm test
npm run build:checked

git add <files>
git commit -m "fix(domain): describe the fix"
git push origin main
```

Pushing `main` does not deploy production. CI runs static checks, tests, and the
production build in parallel. A successful `main` CI run records one immutable
production candidate for that exact commit. Run the `Production Release`
workflow from the Actions tab and select only the Worker scope changed by the
hotfix. Every target reuses that exact-SHA CI candidate without a second
validation pass or environment self-approval, then runs its live smokes with
conflict-aware rollback.

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
`floor_release_sha`. If that fence cannot be proven, or if the permanent floor
or any generation above zero exists, it withholds rollback of every
generation-sensitive Worker. A later successful full release can restore a
marker left disabled by a failed release, but only after the same floor, smoke,
and deployment-ownership checks pass.

The complete serial Playwright suite is intentionally not a production deploy
gate or a scheduled job. Start it manually from the `Full E2E` workflow when a
change warrants the extra coverage. Review failures there as regression
signals, while using the browser-free release smokes plus real-device
verification for the production decision.

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
release stops before overwriting it. If a later deploy or smoke fails, Workers
already attempted by this run are restored in reverse order. Current-state
queries, rollback commands, and rollback verification use bounded backoff for
transient Cloudflare errors and propagation delay. A newer deployment not owned
by the release is never overwritten. Every rollback retry rechecks ownership;
if a prior command succeeded despite a lost response, seeing the previous
version already restored ends the retry without issuing a duplicate command.
Retry attempts remain in the Actions log, and the final rollback/conflict report
is retained in the deployment artifact and Actions summary.

After every selected live smoke succeeds, the workflow queries all Workers
attempted by the run one final time. Their deployment ID, 100% version, and
release message must still match the recorded release. This closes the window
where a local or external deployment could replace an earlier Worker after its
individual smoke; a mismatch fails the release and the conflict-aware recovery
will not overwrite the newer deployment.

Standalone live-smoke steps have a five-minute hard ceiling, except for the
PRO-room probe, which has eight minutes for edge propagation. The combined PRO
media CORS apply/read-back/smoke step has ten minutes. Developer API and
remote-share HTTP requests abort after 30 seconds; PRO-room, app-generation,
app-public, and signaling protocol requests use their own shorter limits. These
limits are intentionally far above the tiny synthetic payloads' normal latency,
but prevent a half-open response from delaying automatic recovery. The complete
deploy job has a four-hour ceiling; individual step limits leave substantially
more time than normal operation requires for the conflict-aware recovery path.
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

The app and signaling rollback floor is first-frame host authentication. Every
signaling version eligible for routine rollback must accept the `host-auth`
first frame; never restore a query-only signaling version below that floor.
Because both sides of the supported rollback boundary use the same first-frame
contract, signaling recovery no longer depends on app recovery succeeding.
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

An app-only production release reuses the exact-SHA CI candidate, proves
partial dependency compatibility before deployment, and runs browser-free
generation/initial-asset-graph and anonymous-session-boundary HTTP smokes after
deployment. Host/guest application-session confidence comes from the required
physical-device matrix; optional Playwright is only an auxiliary diagnostic.
The emergency-only `emergency:deploy:app` command additionally runs the
standalone live signaling smoke. A signaling protocol change must be deployed
and smoked first (normally with release target `all`); the preflight fails
closed while production still serves an incompatible signaling contract.

Automatic rollback preserves the restored deployment's original Git SHA in
the new rollback message when that provenance exists. A legacy or manual
deployment without Git provenance remains deliberately unverifiable; after
such a rollback, the next approved release must use target `all` to establish
a fresh common baseline.

The combined `admin-announcement-v1+abuse-rate-v1` service-control marker
requires an `all` rollout in this order: PRO, remote-share, signaling, Developer
API facade/API, then App. The PRO-owned object must exist before every consumer.
Its announcement component is also a permanent forward-only data floor once the
App/PRO pair has deployed or the global service-control object has recorded
announcement revision 1 or later. Do not
manually restore or intentionally deploy an App or PRO Worker from before that
marker: the old App reads the legacy KV copy and can revive a stale notice while
the durable object retains a different canonical revision. Automatic recovery
skips that unsafe downgrade. For manual recovery, keep both Workers at or above
the marker and use an `all` target roll-forward/forward-repair release.

If the rollback report records a conflict or exhausted retry, inspect the live
version before taking manual action. Deployment records and the Actions summary
are written even when recovery itself fails, after which an explicit final gate
keeps the release failed. A failure that occurs only after the recovery step,
while uploading artifacts or writing the Actions summary, does not roll back an
otherwise healthy release.

Cloudflare's separate Git-triggered app deployment is intentionally disabled;
do not enable it while the GitHub release workflow is authoritative. Keeping
both paths enabled creates an unapproved duplicate deployment.

The ordinary local `deploy:*` scripts are deliberately non-deploying traps: they
always stop and direct the operator back to the approved GitHub workflow. For a
local emergency app-only deployment, first commit every change and leave the
worktree clean, push it to `origin/main`, and keep `main` checked out. Then bind
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
The orchestrator derives `git:<full-HEAD-SHA> emergency-target:<target>` itself
and passes that immutable message to every Wrangler Worker deployment,
including both Developer API Workers and every Worker in `all-workers`.
Operator-supplied trailing arguments are rejected rather than forwarded to
Wrangler, so do not add `-- --message` or any other command-line option.
Before any partial emergency deployment, the same live deployment provenance
and unselected-Worker source compatibility gate used by the approved workflow
runs locally. If another Worker changed in the pushed commit, use
`all-workers` instead of publishing a mixed contract.

These automation checks are intentionally browser-free. After the deploy is
live, verify the production URL and the touched host/guest flow on physical
devices in fresh browser sessions; optional Playwright E2E is auxiliary only.
Confirm the active version with
`npm run wrangler -- deployments status --config cloudflare/wrangler.app.toml --json`.

The `production` environment uses an account-owned Cloudflare Worker deployment
token that expires on 2027-07-16. Rotate it before expiry and update the
environment secret named `CLOUDFLARE_API_TOKEN`; never copy a local Wrangler
OAuth credential into GitHub. Keep D1 writes on a separate account token in
`CLOUDFLARE_D1_API_TOKEN`, restricted to this account with the `D1:Edit`
permission. The Worker token is injected only into Wrangler status, deployment,
final-verification, and recovery steps; dependency installation, artifact
verification, and live-smoke code never receive it. The release workflow probes
the D1 token before any Worker deploy when a D1 change is requested, so a
missing or under-scoped credential stops without rolling production forward and
back. Keep base-schema changes additive and backward-compatible because Worker
rollback does not reverse a successfully committed D1 schema import; tracked
destructive changes need their own explicit migration and rollback pair.

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
   generation/initial-asset-graph and anonymous-session-boundary smokes. Complete the
   touched host/guest QA separately on physical devices.

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
product patch version when it changes shipped behavior; it advances
`CACHE_VERSION` only when the PWA cache boundary also needs to move. The Git SHA
and Cloudflare Worker version IDs identify the exact deployed build.

| Client state                                | Expected behavior                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New visitor or fresh navigation             | Navigation is network-first, so the user should receive the latest deployed app shell immediately unless offline.                                                                                                                                                                                                                                                                                                                                 |
| Existing open tab                           | `src/sw-register.ts` performs an immediate update check after registration and then checks every 60 minutes. When a waiting worker is found, the app shows the service-worker update dialog.                                                                                                                                                                                                                                                      |
| User accepts update dialog                  | The page sends `SKIP_WAITING`, records a 30-second cooldown in `sessionStorage`, marks the navigation intentional, and reloads once.                                                                                                                                                                                                                                                                                                              |
| Other same-origin tabs when one tab accepts | `controllerchange` fires in every controlled tab. Idle tabs (`network.appRole === 'idle'`) auto-reload; tabs with a live session show an update-ready toast and defer the reload to their next natural load so an update cannot silently terminate a room. The worker keeps retired-version caches until every live tab confirms that its page loaded under the active controller, so a deferred tab can still import its old hashed lazy chunks. |
| Update found during cooldown                | The waiting worker is activated silently to avoid a reload-dialog loop. In-session tabs still defer per the rule above, so a hotfix-on-hotfix is not guaranteed to reach them until they reload naturally.                                                                                                                                                                                                                                        |
| User dismisses update dialog                | The waiting worker is not activated by app code. The update applies on a later natural load/update path.                                                                                                                                                                                                                                                                                                                                          |
| PWA/background tab                          | Delivery depends on when the browser wakes the page and allows the update check. Treat this as browser-controlled.                                                                                                                                                                                                                                                                                                                                |

Bumping `CACHE_VERSION` in `public/service-worker.js` creates fresh active app-shell caches and is the current lightweight way to make existing clients notice an app-shell migration. Prior generations are retired only after the page/worker readiness handshake confirms that no live tab still needs them (or when activation sees no live window clients). It still does not create a guaranteed instant reload for every active/background client.

`npm run guard:sw-cache-version` enforces this migration boundary for committed
PWA runtime changes. A feature commit may be followed by a separate version-bump
commit, or may include the bump itself; the guard passes once the latest bump
covers the resulting app tree. Cloudflare Worker code, repository documentation,
and test-only changes do not require a bump. The check intentionally fails on a
shallow clone because it cannot prove where the latest bump occurred, so the CI
candidate build and release deployment checkout must retain full git history
(`fetch-depth: 0`).

## Emergency Hotfix

Use this when stale clients are likely to keep hitting a severe bug.

1. Make the minimal code fix.
2. Bump `CACHE_VERSION` in `public/service-worker.js`.
3. Run the full verification gate:

```bash
npm run typecheck
npm run lint
npm test
npm run build:checked
```

4. Commit and push to `main`.
5. Run the `Production Release` workflow for the affected scope.
6. After Cloudflare deploys, verify:
   - fresh production load
   - an already-open production tab
   - service-worker update dialog or cooldown behavior
   - the specific broken scenario

Do not add a forced reload mechanism casually. There is no current production broadcast infrastructure for forced reloads, and forcibly reloading active audio/session clients can be worse than letting the service-worker update flow handle it.

## Rollback

If a deployment is bad:

1. In the Cloudflare dashboard, roll back to the previous known-good Worker deployment if immediate rollback is needed.
2. In git, prefer a revert commit:

```bash
git revert <bad-commit-sha>
npm run typecheck
npm run lint
npm test
npm run build:checked
git push origin main
```

3. Run the `Production Release` workflow for the reverted Worker scope, then
   rerun its live smoke; a revert push alone does not update Cloudflare.
4. If the rollback changes app-shell behavior or users may be pinned to stale cached assets, include a `CACHE_VERSION` bump in the rollback commit.

Avoid `git reset --hard` plus force push on `main` unless there is no reasonable alternative.

For a CLI rollback, deploy the saved known-good version at 100%:

```bash
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
- Add a manual verification note when the issue is browser/device-specific.
- If the fix changes a cross-domain contract, update the relevant file under `docs/`.
