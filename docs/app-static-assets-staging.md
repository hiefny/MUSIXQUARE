# App Static Assets staging probe

This probe tests Cloudflare Static Assets routing without exposing the production App Worker or any production D1, R2, KV, Durable Object, service binding, route, cron, or secret.

## Prepare and validate

```powershell
npm run build
node scripts/prepare-app-assets-staging.mjs
npx vitest run src/core/__tests__/app-assets-staging.test.ts
npm run wrangler -- deploy --dry-run --config cloudflare/wrangler.app-assets-staging.toml
```

The preparation script copies the exact local `dist/` into the ignored `scratch/app-assets-staging-dist/` directory and injects the canonical `cloudflare/app-static-assets/_headers` file. It fails if `/assets/` contains anything other than the reviewed `.js`, `.css`, and `.woff2` types.

## Repeat the isolated deployment

No production route is configured. To repeat the already verified experiment:

```powershell
npm run wrangler -- deploy --config cloudflare/wrangler.app-assets-staging.toml
node scripts/smoke-app-assets-staging.mjs https://musixquare-app-assets-staging.<account-subdomain>.workers.dev
```

Expected behavior:

- Existing `/assets/*.js`, `/assets/*.css`, and `/assets/*.woff2` responses have no `X-MXQR-Staging-Worker` header.
- `/`, six-digit room paths, `/api/*`, `service-worker.js`, and stable bootstrap scripts have `X-MXQR-Staging-Worker: invoked`.
- Asset-first responses retain immutable caching, Wrangler-derived MIME, `nosniff`, the current CSP/security headers, and no `Access-Control-Allow-Origin` widening.

The marker site is a routing probe, not a functional MUSIXQUARE deployment. API paths deliberately return `STAGING_PROBE_ONLY` and cannot reach production data.

## Verified probe

The isolated probe was deployed and smoke-tested on 2026-07-19 as Worker
version `b5add05a-d844-4d15-9e4f-6fbf2ff68f6c`, then deleted. All reviewed
JS, CSS, and WOFF2 samples bypassed Worker code while retaining immutable
caching, MIME, CSP/security headers, and same-origin CORS behavior. Root, room,
API, service-worker, and stable bootstrap paths retained the Worker marker.
GET and HEAD requests passed, and a missing module returned a non-HTML 404.

The smoke script retries marker checks briefly because a newly deployed
Workers version can take a moment to become visible consistently at the test
edge. This is staging propagation handling, not application fallback logic.

## Staging rollback

The isolated probe had no production route or production binding, so deleting
that Worker was its complete rollback:

```powershell
npm run wrangler -- delete musixquare-app-assets-staging
```

The probe did not change content-hashed asset bytes.

## Production release contract

Production uses the same three narrow negative patterns. Cloudflare's negative
`run_worker_first` patterns take precedence, so only content-hashed
`/assets/*.js`, `/assets/*.css`, and `/assets/*.woff2` responses bypass the App
Worker. Documents, six-digit room routes, `/api/*`, `service-worker.js`, and
stable bootstrap scripts remain Worker-first.

`npm run build` writes the reviewed canonical header source to `dist/_headers`
after Vite succeeds. It also fails closed if any bypass candidate is not a
content-hashed `.js`, `.css`, or `.woff2` file. `npm run build:checked` then
verifies that `dist/_headers` still matches the canonical bytes before the
artifact is released. This keeps the response policy reproducible even for a
plain production build, without adding `public/_headers`, changing the
service-worker precache input, or requiring a service-worker cache-version
bump.

The service-worker cache guard recognizes only this one structural
`package.json` transition: `scripts.build` changes from `vite build` to the
canonical header-materialization command and every other parsed manifest field
stays identical. Dependency, metadata, lockfile, or any other script change
continues to require the normal cache-version review and bump.

Before deployment, verify:

```powershell
npm run build:checked
npx vitest run src/core/__tests__/app-assets-staging.test.ts
npm run wrangler -- deploy --dry-run --config cloudflare/wrangler.app.toml
```

The production rollback is one configuration line: restore
`run_worker_first = ["/*"]`. Leaving `dist/_headers` in an old release artifact
is harmless after that rollback because Worker-generated responses do not use
Static Assets `_headers` rules.
