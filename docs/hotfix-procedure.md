# Production Hotfix And Rollback Procedure

Reviewed against `public/service-worker.js` `CACHE_VERSION = "v116"` and `src/sw-register.ts` on 2026-05-16.

This document is the canonical production hotfix note. The older working copy in `.workshop/review` was a pre-refactor draft and should not be used as the source of truth.

## Normal Hotfix

Use this path for ordinary production bugs that do not require immediate client replacement.

```bash
git checkout main
git pull origin main

# make the fix

npm run typecheck
npm run lint
npm test
npm run build

git add <files>
git commit -m "fix(domain): describe the fix"
git push origin main
```

Cloudflare's GitHub integration builds and deploys `main` automatically. For an out-of-band push, run `npx wrangler deploy --config cloudflare/wrangler.app.toml`. After the deploy is live, verify the production URL in a fresh browser session.

## Client Update Behavior

MUSIXQUARE is a PWA with a service worker, so "deployed" and "every open client is already running it" are different things.

Current behavior:

| Client state | Expected behavior |
| --- | --- |
| New visitor or fresh navigation | Navigation is network-first, so the user should receive the latest deployed app shell immediately unless offline. |
| Existing open tab | `src/sw-register.ts` performs an immediate update check after registration and then checks every 60 minutes. When a waiting worker is found, the app shows the service-worker update dialog. |
| User accepts update dialog | The page sends `SKIP_WAITING`, records a 30-second cooldown in `sessionStorage`, marks the navigation intentional, and reloads once. |
| Other same-origin tabs when one tab accepts | `controllerchange` fires in every controlled tab. Idle tabs (`network.appRole === 'idle'`) auto-reload; tabs with a live session show an update-ready toast and defer the reload to their next natural load (22차 audit CATCH-1 — auto-reload silently killed live sessions). |
| Update found during cooldown | The waiting worker is activated silently to avoid a reload-dialog loop. In-session tabs still defer per the rule above, so a hotfix-on-hotfix is not guaranteed to reach them until they reload naturally. |
| User dismisses update dialog | The waiting worker is not activated by app code. The update applies on a later natural load/update path. |
| PWA/background tab | Delivery depends on when the browser wakes the page and allows the update check. Treat this as browser-controlled. |

Bumping `CACHE_VERSION` in `public/service-worker.js` invalidates MUSIXQUARE app-shell caches and is the current lightweight way to make existing clients notice an app-shell migration. It still does not create a guaranteed instant reload for every active/background client.

## Emergency Hotfix

Use this when stale clients are likely to keep hitting a severe bug.

1. Make the minimal code fix.
2. Bump `CACHE_VERSION` in `public/service-worker.js`.
3. Run the full verification gate:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

4. Commit and push to `main`.
5. After Cloudflare deploys, verify:
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
npm run build
git push origin main
```

3. If the rollback changes app-shell behavior or users may be pinned to stale cached assets, include a `CACHE_VERSION` bump in the rollback commit.

Avoid `git reset --hard` plus force push on `main` unless there is no reasonable alternative.

## External Dependency Incidents

Treat these separately from app hotfixes unless the app has a confirmed code-level workaround.

| Dependency | User symptom | Current response |
| --- | --- | --- |
| PeerJS-compatible signaling / Cloudflare signaling | New sessions or remote peers fail to connect. | Check the configured transport and service status. Prefer transport fallback or a small compatibility patch over broad session rewrites. |
| TURN credential endpoint / Cloudflare Worker | Remote peers may fall back to STUN-only and fail across restrictive NATs. | Confirm `/api/get-turn-config` response and Cloudflare status. Do not cache TURN credentials. |
| YouTube IFrame API | YouTube mode fails while file playback still works. | Confirm iframe/API availability. File mode remains the fallback user path. |
| Browser audio/WebRTC policy changes | iOS/Safari/Chrome-specific playback or connection drift. | Reproduce on the affected real device/browser. Unit tests cannot prove this class of issue. |

## Post-Hotfix Checklist

- Confirm production behavior on a fresh load and an already-open client.
- Record the root cause and the exact user symptom.
- Add or update a regression test when the issue is representable in unit/jsdom tests.
- Add a manual verification note when the issue is browser/device-specific.
- If the fix changes a cross-domain contract, update the relevant file under `docs/`.
