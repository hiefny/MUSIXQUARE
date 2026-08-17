# Release versioning

MUSIXQUARE deliberately uses several independent identifiers. They describe
different compatibility boundaries and must not be made numerically equal.

## Product release

`package.json` is the single source of truth for the human-facing MUSIXQUARE
product version. Both `package-lock.json` locations mirror it, as do
`ADMIN_ASSET_VERSION` in `cloudflare/app-worker.ts` and `ADMIN_SCRIPT_VERSION`
in `browser/classic-runtime/admin.ts`. The `guard:release-identity` check fails
if any mirror drifts.

The product follows semantic versioning:

- patch: compatible fixes and operational hardening;
- minor: backward-compatible product features;
- major: an intentional product or compatibility milestone.

The move from 7.x to 8.0 marks the persistent PRO-room, account identity, and
room-authority generation added after the 7.0 YouTube synchronization release.
Git commit SHA and Cloudflare Worker version IDs remain the exact identifiers
for a deployment; SemVer is the understandable product milestone, not a
replacement for those immutable IDs.

Advancing product SemVer updates the browser admin mirror, which is a PWA
runtime input, so the same release also needs a covering monotonic
`SERVICE_WORKER_CACHE_VERSION` advance. A pure Worker-only change may leave both
identifiers untouched when product policy does not call for a SemVer release.

## Service-worker cache epoch

`SERVICE_WORKER_CACHE_VERSION` in `scripts/service-worker-asset.ts` is the
canonical monotonic cache epoch injected into the strict
`browser/service-worker.ts` source during dev and production builds. A value
such as `v226` means "the 226th app-shell cache boundary," not
"MUSIXQUARE version 226." It changes only when the PWA cache/update contract
requires existing clients to migrate. `guard:sw-cache-version` independently
checks its history and monotonicity.

## Classic bootstrap asset revision

The query revision on `/bootstrap.js`, declared by the classic script URL in
`index.html` and mirrored by `BOOTSTRAP_CACHE_KEY` in the service worker, is a
separate immutable-asset identity. It changes only when the emitted bootstrap
script changes. An app-shell module-graph refactor may therefore advance the
service-worker cache epoch while retaining the existing bootstrap asset
revision.

The two values must agree only within their own boundary: `index.html` and the
service worker must request the same bootstrap URL, while the app-shell cache
name must use the current `SERVICE_WORKER_CACHE_VERSION`. Tests enforce both
relationships without requiring the two independent revisions to be
numerically equal. This keeps app-shell migration and classic-bootstrap cache
invalidation independently auditable.

## API, protocol, and storage schemas

OpenAPI `info.version`, URL majors such as `/v1`, frame versions, D1 schema
revisions, and R2 object versions belong to their own wire or storage contract.
They advance only when that contract changes. They never inherit the product
version or service-worker cache epoch.

Cloudflare Wrangler `compatibility_date` is likewise a runtime compatibility
selection, not a MUSIXQUARE release number.

## Document dates

Dates in ADRs, audits, policy pages, sitemap entries, and filenames record when
that document or page was decided, reviewed, or published. They remain ISO
dates where possible and are not product versions.

## Release artifact record

Production release manifests record both independent values:

```json
{
  "release": {
    "productVersion": "1.2.3",
    "serviceWorkerCacheEpoch": 123
  }
}
```

This is an illustrative shape, not a second source of current values. Read the
current canonical values with:

```bash
npm run version:status
```

The manifest also records the Git SHA, build tools, validation profile, and
content hashes. Cloudflare deployment records add each deployed Worker version
ID, completing the operational release identity.
