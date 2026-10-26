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

## App build number and floor

From App 9.0.13 the App reports a build number: the integer of the service-worker
cache epoch (`v786` is build 786). It is not a second version. The browser reads
it from the compile-time define `__MXQR_BUILD_CACHE_VERSION__` that Vite derives
from `SERVICE_WORKER_CACHE_VERSION` (`APP_BUILD` in `src/core/app-build.ts`);
the App Worker reads its own deployed `/service-worker.js`; the release smokes
use the checked-out release identity (`scripts/live-smoke-app-build.mts`). No
copy of the number is typed anywhere else, and a build without the define
(unit tests) reports nothing, which counts as build 0.

The App build floor is runtime state, not a version identifier: the minimum
build that the Signaling and PRO Workers admit, held by the service-control
object (record RO-50 in the
[resource ownership registry](design/resource-ownership-registry.md)). Raising
it changes no version, artifact or cache epoch, and it never goes above the App
build that is live. Because epochs only grow on `main`
(`guard:sw-cache-version`), every later release's build is at or above the
floor. Consequences for a release:

- A release that must keep older builds out of rooms advances the cache epoch
  (it always does when PWA runtime inputs change) and raises the floor to its
  own build after it is committed (`raise_app_build_floor`). A release that
  keeps the build, such as a Worker-only release, cannot raise the floor beyond
  the live build.
- The floor is read at entry. It is not part of the wire contract, so it never
  becomes a frame or schema version. Rolling a Worker back leaves the stored
  value in place; after a PRO Worker rollback to a version without the floor
  routes, every reader sees floor 0 until the PRO Worker rolls forward.
- The operational steps (set, lower, the first floor, rollbacks) are in the
  [hotfix procedure](hotfix-procedure.md#app-build-floor), and the current value
  is in section 1 of the [release record](release-record.md).

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
ID, completing the operational release identity. The `serviceWorkerCacheEpoch`
is also the App build number that the App build floor compares; the floor itself
is not in the manifest, because it is runtime state that can change between
releases.

The Standard HTTPS signaling smoke records each failed bridge open, send, poll,
or close with the client role, HTTP status, recognized machine error code,
elapsed milliseconds, and Cloudflare Ray ID; a failed send also names its client
sequence and recognized frame type. Unrecognized codes are reported as
`unknown`, a JSON body without one as `none`, and a request without a usable
JSON body as `timeout`, `network-error`, `body-error`, `oversized`, or
`non-json`. Response text, tokens, peer and room IDs, authentication payloads,
and PINs are never included. The Ray ID finds the App Worker's
`standard_signaling_bridge` diagnostic for the same 5xx response, and a passing
run records both bridge open times. These fields identify the failed boundary
but do not establish an upstream root cause. A 502 or 503 still fails the smoke
without retrying admission, a failed close is printed without failing it, and a
later successful run does not explain the earlier failure.

One response is the exception, in this smoke and in the signaling and Remote
Share smokes (`scripts/live-smoke-rate-limit-retry.mts`): an HTTP 503 whose JSON
`error` is exactly `RATE_LIMIT_UNAVAILABLE`, which the App and signaling Workers
return only when their rate-limit Durable Object does not answer within its 2 s
read timeout. Each smoke process retries that response once, 5 s later, after
printing the unchanged failure line and a `retried after RATE_LIMIT_UNAVAILABLE`
line. The HTTPS bridge repeats the identical open, send, or poll, because the App
answers that code before it reads the body or calls the bridge object. The
WebSocket smokes read the rejected upgrade's body and repeat their attempt through
their existing readiness or version-convergence loop. A second such response, any
other code, a code-less 503, or the code with another status fails exactly as
before, and a failed close never spends the retry.
