# Release versioning

MUSIXQUARE deliberately uses several independent identifiers. They describe
different compatibility boundaries and must not be made numerically equal.

## Product release

`package.json` is the single source of truth for the human-facing MUSIXQUARE
product version. `package-lock.json` only mirrors it. The
`guard:release-identity` check fails if either lockfile location drifts.

The product follows semantic versioning:

- patch: compatible fixes and operational hardening;
- minor: backward-compatible product features;
- major: an intentional product or compatibility milestone.

The move from 7.x to 8.0 marks the persistent PRO-room, account identity, and
room-authority generation added after the 7.0 YouTube synchronization release.
Git commit SHA and Cloudflare Worker version IDs remain the exact identifiers
for a deployment; SemVer is the understandable product milestone, not a
replacement for those immutable IDs.

## Service-worker cache epoch

`CACHE_VERSION` in `public/service-worker.js` is a monotonic cache epoch. A
value such as `v226` means "the 226th app-shell cache boundary," not
"MUSIXQUARE version 226." It changes only when the PWA cache/update contract
requires existing clients to migrate. `guard:sw-cache-version` independently
checks its history and monotonicity.

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
