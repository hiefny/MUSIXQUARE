# Production Hotfix And Rollback Procedure

Reviewed against `public/service-worker.js`, `src/sw-register.ts`, the three
Wrangler configs, and the live-smoke scripts on 2026-07-11. Read the current
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

The repository's GitHub Actions workflows run CI/E2E; they do not constitute a
production deployment. Do not treat a successful push as proof that Cloudflare
is current. For an app-only hotfix, deploy the already verified build explicitly:

```bash
npx wrangler deploy --config cloudflare/wrangler.app.toml --message "Hotfix: <summary>"
npm run smoke:live:app-session
```

After the deploy is live, verify the production URL in a fresh browser session
and confirm the active version with
`npx wrangler deployments status --config cloudflare/wrangler.app.toml`.

### Worker scope and order

Deploy only the Workers changed by the hotfix. For a backward-compatible change
that touches all three, use this order so the existing browser remains usable
while backends roll forward:

1. `cloudflare/wrangler.remote-share.toml`, then
   `npm run smoke:live:remote-share`;
2. `cloudflare/wrangler.signaling.toml`, then
   `npm run smoke:live:signaling`;
3. rebuild with `npm run build:checked`, deploy
   `cloudflare/wrangler.app.toml`, then run `npm run smoke:live` and browser QA.

Before each deploy, save the version reported by
`npx wrangler deployments status --config <config> --json`. Confirm that the
saved version is compatible with every migration already applied before using
it as the immediate rollback target.

## Client Update Behavior

MUSIXQUARE is a PWA with a service worker, so "deployed" and "every open client is already running it" are different things.

Current behavior:

| Client state | Expected behavior |
| --- | --- |
| New visitor or fresh navigation | Navigation is network-first, so the user should receive the latest deployed app shell immediately unless offline. |
| Existing open tab | `src/sw-register.ts` performs an immediate update check after registration and then checks every 60 minutes. When a waiting worker is found, the app shows the service-worker update dialog. |
| User accepts update dialog | The page sends `SKIP_WAITING`, records a 30-second cooldown in `sessionStorage`, marks the navigation intentional, and reloads once. |
| Other same-origin tabs when one tab accepts | `controllerchange` fires in every controlled tab. Idle tabs (`network.appRole === 'idle'`) auto-reload; tabs with a live session show an update-ready toast and defer the reload to their next natural load so an update cannot silently terminate a room. The worker keeps retired-version caches until every live tab confirms that its page loaded under the active controller, so a deferred tab can still import its old hashed lazy chunks. |
| Update found during cooldown | The waiting worker is activated silently to avoid a reload-dialog loop. In-session tabs still defer per the rule above, so a hotfix-on-hotfix is not guaranteed to reach them until they reload naturally. |
| User dismisses update dialog | The waiting worker is not activated by app code. The update applies on a later natural load/update path. |
| PWA/background tab | Delivery depends on when the browser wakes the page and allows the update check. Treat this as browser-controlled. |

Bumping `CACHE_VERSION` in `public/service-worker.js` creates fresh active app-shell caches and is the current lightweight way to make existing clients notice an app-shell migration. Prior generations are retired only after the page/worker readiness handshake confirms that no live tab still needs them (or when activation sees no live window clients). It still does not create a guaranteed instant reload for every active/background client.

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
5. Deploy the affected Worker explicitly as described above.
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

3. Explicitly deploy the reverted Worker scope and rerun its live smoke; a
   revert push alone does not update Cloudflare.
4. If the rollback changes app-shell behavior or users may be pinned to stale cached assets, include a `CACHE_VERSION` bump in the rollback commit.

Avoid `git reset --hard` plus force push on `main` unless there is no reasonable alternative.

For a CLI rollback, deploy the saved known-good version at 100%:

```bash
npx wrangler versions deploy <known-good-version-id>@100% --config <worker-config> --yes --message "Rollback: <reason>"
```

Cloudflare migration history is append-only. In particular, the removed
remote-share Durable Object must not be "restored" by selecting a version from
before its deletion migration; use a known-good post-deletion version.

## External Dependency Incidents

Treat these separately from app hotfixes unless the app has a confirmed code-level workaround.

| Dependency | User symptom | Current response |
| --- | --- | --- |
| PeerJS-compatible signaling / Cloudflare signaling | New sessions or remote peers fail to connect. | Check the configured transport and service status. Prefer rollback or a small isolated compatibility patch over broad session rewrites; public production hosts do not automatically fall back to PeerJS. |
| TURN credential endpoint / Cloudflare Worker | Remote peers may fall back to STUN-only and fail across restrictive NATs. | Confirm `/api/get-turn-config` response and Cloudflare status. Do not cache TURN credentials. |
| YouTube IFrame API | YouTube mode fails while file playback still works. | Confirm iframe/API availability. File mode remains the fallback user path. |
| Browser audio/WebRTC policy changes | iOS/Safari/Chrome-specific playback or connection drift. | Reproduce on the affected real device/browser. Unit tests cannot prove this class of issue. |

## Post-Hotfix Checklist

- Confirm production behavior on a fresh load and an already-open client.
- Confirm the active Cloudflare version for every deployed Worker.
- Run the live smoke that covers every deployed Worker.
- Record the root cause and the exact user symptom.
- Add or update a regression test when the issue is representable in unit/jsdom tests.
- Add a manual verification note when the issue is browser/device-specific.
- If the fix changes a cross-domain contract, update the relevant file under `docs/`.
