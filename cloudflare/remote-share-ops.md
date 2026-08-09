# MUSIXQUARE Remote Share Operations

This note records the current operating decision for Cloudflare-backed remote
file sharing. The standard-room path stores one complete private object per
remote file; chunked streaming protocols are not part of the production
service.

Cloudflare plan limits were last checked against the official Workers, Durable
Objects, R2, and WAF documentation on 2026-08-09. Recheck those sources before
making a cost or upgrade decision. R2 Standard currently includes 10 GB-month
of storage per month in its free usage allowance; this is an allowance rather
than a hard account storage cap.

## Current Decision

- Start on Cloudflare Workers Free.
- Keep the shared service-control Durable Object's atomic allocation rate limit
  on `POST /session`. Production fails closed when the
  `MUSIXQUARE_SERVICE_CONTROL` binding is unavailable.
- Cap each standard room's active R2 objects at 1 GiB
  (`ROOM_STORAGE_QUOTA_BYTES`) through a per-room SQLite Durable Object.
- Upload and download each remote file as one complete private object through
  the canonical `/session`, `/complete`, `/download`, and `/object` routes.
- The peer descriptor calls this contract `whole-v1`; signed Worker tokens and
  R2 metadata call its storage representation `whole-object-v1`. These are
  layer-specific names for the same bytes, not separate engines or route eras.
- Upgrade to Workers Paid only when real usage starts hitting Free-plan limits.
- Keep the Cloudflare WAF burst guard on the single top-level allocation route,
  `POST /session`.

WAF Rate Limiting blocks abusive allocation bursts before they reach the
Worker. A normal successful upload consumes one atomic service-control request
for its per-IP allocation counter and, only when `ROOM_UPLOADS_PER_WINDOW` is
enabled, a second request for the room counter. Downloads do not consume either
allocation limiter.

## Remote Upload Cost Shape

One remote whole-file upload attempt roughly means:

- `POST /session`: one Worker request, one atomic service-control Durable Object
  request (plus the optional room counter), one room-quota Durable Object
  request, a room-prefix R2 usage check, and a presigned R2 PUT URL issued only
  after the exact stored bytes are durably reserved.
- Direct `PUT` to R2: one R2 Class A operation, with no Worker body upload.
- `POST /complete`: one Worker request, R2 HEAD validation, and one serialized
  room Durable Object request with an authoritative room-prefix usage recheck.
  A racing excess object is deleted before publication.
- `DELETE /object/...`: validates a room/object/expiry-bound cleanup HMAC before
  R2 HEAD/delete, so unauthenticated requests cannot create Class B work. The
  exact-byte reservation remains conservatively charged until its fixed expiry
  as defense-in-depth, even though deleting the placeholder/object makes the
  canonical `If-Match` PUT condition fail.
- `GET /download/...`: one Worker request and one R2 read per remote guest.

## Current Guardrails

- App-issued, IP/scope-bound capability token required on `POST /session` in
  production. With Turnstile disabled, the app Worker issues it only after a
  signed proof-of-work challenge; Origin and Host headers are not proof.
- The service-control limiter uses an HMAC-pseudonymized principal and a
  serialized SQLite transaction. Its v2 consume contract also records the
  server-HMAC upload operation ID for each successful window entry (bounded by
  the configured limit), so concurrent delivery of one logical session consumes
  the counter once while distinct allocations cannot all pass the same
  remaining slot.
- Purpose-separated signed upload-completion, download, and cleanup tokens.
- Direct-to-R2 presigned PUT upload path.
- Whole-object TTL: `OBJECT_TTL_SECONDS`, currently 1 hour.
- Standard-room temporary R2 quota: 1 GiB per generated room code in the exact
  `100000`-`999999` range. `RemoteShareQuota` serializes reservation,
  completion, release, and expiry accounting, so concurrent sessions cannot
  both consume the same remaining capacity.
- Session setup creates a zero-byte R2 placeholder, reserves the exact declared
  size, and signs `If-Match` to that placeholder's exact ETag before returning a
  presigned URL. This makes the direct PUT one-shot: a successful upload changes
  the ETag, while cleanup or expiry removes the placeholder, so a replayed or
  late-finishing PUT cannot recreate the object. The Durable Object stores only
  canonical reservation metadata, including the placeholder ETag and one
  immutable `uploadAuthorityExpiresAt`; replay reissues credentials for the
  same object only inside that original upload window and never stores a
  presigned URL or completion bearer. Placeholder, presign, or token
  construction failure attempts to roll the new reservation back. If both the
  reserve outcome and compensating release are unavailable, the zero-byte
  placeholder and receipt stay paired so an exact v3 retry can recover safely.
  Completion revalidates the R2 object and atomically marks the reservation
  completed. Any R2, Durable Object, state, bounded scan, or cleanup failure
  denies the operation rather than publishing an unaccounted object.
- Authenticated cleanup and natural expiry retain exact-key tombstones through a
  one-hour quiet interval as cleanup defense-in-depth. Quota correctness does
  not depend on that interval or on a scan winning a race with an in-flight
  upload: the signed placeholder `If-Match` condition is the write fence. Every
  later quota admission still scans the room prefix, deletes expired objects,
  and fails closed if reconciliation cannot complete. The bucket lifecycle rule
  is the final cleanup backstop.
- An abandoned or malicious session can hold its declared bytes until object
  expiry even when no PUT becomes visible. Capability, IP throttling, WAF, and
  account-wide R2 alerts remain necessary abuse and cost controls.
- The sole R2 object namespace is `room/`, and the production bucket lifecycle
  policy expires it after one day.
- Max wire/storage size is fixed at 200 MiB. Browser allocation and
  `decodeAudioData` can still fail below this limit when compressed media
  expands into a large PCM buffer.
- Upload allocation limits:
  - `IP_UPLOADS_PER_WINDOW`: default 60 sessions per IP per hour.
  - `ROOM_UPLOADS_PER_WINDOW`: default 0, which disables room-wide limiting.
  - Enabled limits must remain at or below 1024 so the v2 idempotency set stays
    inside its fixed Durable Object storage bound; invalid drift fails closed.
- `ROOM_STORAGE_QUOTA_BYTES`: production is `1073741824` (1 GiB). Worker
  contract v3 requires both this positive limit and the `REMOTE_SHARE_QUOTA`
  binding, and reports the result as `sessionReplayRequired` /
  `sessionReplayEnabled` on `/security-config`. Production `POST /session`
  fails closed if either drifts off. Only isolated local tests may opt out with
  `MXQR_ALLOW_STATELESS_REMOTE_SHARE_SESSION=true`. Existing issued
  reservations can still settle while the Durable Object binding remains
  present.
- Missing, malformed, and `0xxxxx` room IDs are rejected before a presigned URL
  is issued. The complete `0xxxxx` namespace is reserved for PRO rooms, whose
  persistent media uses a separate bucket and control plane.
- R2 bucket CORS includes the exact MUSIXQUARE web origins, Toss production
  origin, and local development origins. Every new production web origin must
  be added explicitly because R2 Origin matching is exact.
- The app Worker CSP allows direct R2 upload connections through
  `https://*.r2.cloudflarestorage.com`.

## Upgrade Signals

Move from Workers Free to Workers Paid if any of these become normal rather
than temporary test noise:

- Durable Object requests or SQLite row writes approach their current Free-plan
  daily allowances.
- Worker requests approach the Free limit of 100,000 requests per day.
- Users see upload-session 429 responses during normal use.
- Remote-share uploads fail because of Cloudflare platform limits.

Paid Workers are expected to be enough for a long time. WAF remains an abuse
control rather than a normal-cost optimization.

References: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[R2 S3 conditional operations](https://developers.cloudflare.com/r2/api/s3/api/), and
[WAF rate-limiting availability](https://developers.cloudflare.com/waf/rate-limiting-rules/).

## Required WAF Rate Limit

The production zone's `Remote share session burst guard` rule must remain
enabled with this allocation-route scope:

- Match host: `share.musixquare.com`
- Match path: `/session` (exact path)
- Match method: `POST`
- Characteristic: IP
- Threshold: 20 requests
- Period: 10 seconds
- Action: block for 10 seconds after the threshold is exceeded

Do not broaden the rule to upload, completion, cleanup, or download routes.
Those are normal follow-up traffic inside an already-admitted session. Revisit
the threshold only with production 429 evidence.

## Notes

- WAF does not replace the Worker-side allocation rate limits.
- The retired remote-share KV allocation counter must not be reintroduced;
  `POST /session` uses the shared atomic service-control counter.
- `REMOTE_SHARE_SIGNING_SECRET` and the capability HMAC secret must be random
  values of at least 32 characters and must remain purpose-separated. Only the
  capability secret is shared with the App Worker.
- `wrangler.remote-share.toml` retains Cloudflare's required append-only Durable
  Object migration entries. They are immutable infrastructure schema tags; do
  not reuse deleted class names or edit old tags. The canonical copy is
  `durable-object-migrations.manifest.json`; worker bundle validation requires
  exact TOML equality and verifies the manifest's complete first-parent history
  is append-only before Wrangler runs.
- Cloudflare cannot roll a Worker version back across a Durable Object class
  lifecycle migration. The release bridge establishes the required lifecycle
  before atomic quota is enabled; later releases do not repeat it.
- Emergency remote-share deployments fail closed until that lifecycle bridge
  is present in production.
- `/session`, `/complete`, `/download`, and `/object` are the complete public
  remote-share surface.
- `cloudflare/remote-share-contract-version.txt` is the explicit public
  app/Worker cutover marker. Change it in the same commit as an incompatible
  contract change; the release workflow then rejects every target except
  `all`, so the first production rollout cannot publish only one side.
- Worker contract v3 adds an actor-secret-derived `actorId` plus `rs3_`
  `requestId`, and binds both into the atomic room-quota replay receipt for
  `POST /session`. Cached seven-field v2 (`rs_`) and legacy six-field bodies
  remain accepted during rollout, but their public metadata-derived identities
  are never replay-authoritative and each call gets a fresh reservation. New
  clients require the v3 readiness marker and enabled durable replay. Exact v3
  replay bypasses a newly exhausted allocation rate window, survives capability
  token/IP rotation, returns the same object/cleanup authority, and may mint a
  fresh conditional PUT URL and completion token only until the immutable
  initial PUT deadline.
- The GET-only operations drift audit compares the complete live remote-share
  lifecycle API result with `r2-lifecycle.remote-share.json`, not merely the
  human-readable Wrangler listing. It also rejects any enabled PRO-media delete
  rule at 86,400 seconds or less (and every date-based delete rule), preventing
  the temporary `room/` lifecycle from being copied onto persistent PRO media.
- The shared service-control contract marker is currently
  `admin-announcement-v1+abuse-rate-v2+session-idempotency-v1`. A change to that marker also requires
  target `all`, with the PRO Worker deployed before remote-share and every other
  service-control consumer.
