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
  exact-byte reservation remains charged until its fixed expiry because
  deleting an object does not revoke an already-issued, still-valid presigned
  PUT URL.
- `GET /download/...`: one Worker request and one R2 read per remote guest.

## Current Guardrails

- App-issued, IP/scope-bound capability token required on `POST /session` in
  production. With Turnstile disabled, the app Worker issues it only after a
  signed proof-of-work challenge; Origin and Host headers are not proof.
- The service-control limiter uses an HMAC-pseudonymized principal and a
  serialized SQLite transaction, so barrier-concurrent allocations cannot all
  pass the same remaining slot.
- Purpose-separated signed upload-completion, download, and cleanup tokens.
- Direct-to-R2 presigned PUT upload path.
- Whole-object TTL: `OBJECT_TTL_SECONDS`, currently 1 hour.
- Standard-room temporary R2 quota: 1 GiB per generated room code in the exact
  `100000`-`999999` range. `RemoteShareQuota` serializes reservation,
  completion, release, and expiry accounting, so concurrent sessions cannot
  both consume the same remaining capacity.
- Session setup reserves the exact stored size before returning a presigned
  URL. Presign or token construction failure rolls that reservation back.
  Completion revalidates the R2 object and atomically marks the reservation
  completed. Any R2, Durable Object, state, bounded scan, or cleanup failure
  denies the operation rather than publishing an unaccounted object.
- Authenticated cleanup and natural expiry retain conservative exact-key
  tombstones through a one-hour quiet interval as defense-in-depth against late
  PUT completion. The interval is not a provider-backed proof that every PUT
  has finished: every later quota admission still scans the room prefix,
  deletes expired objects that appeared after tombstone retirement, and fails
  closed if that reconciliation cannot complete. The bucket lifecycle rule is
  the final cleanup backstop.
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
- `ROOM_STORAGE_QUOTA_BYTES`: production is `1073741824` (1 GiB). Setting it to
  `0` disables new atomic admission. Existing reservations still settle while
  the Durable Object binding remains present.
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
[R2 pricing](https://developers.cloudflare.com/r2/pricing/), and
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
  not reuse deleted class names or edit old tags.
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
- The shared service-control contract marker is currently
  `admin-announcement-v1+abuse-rate-v1`. A change to that marker also requires
  target `all`, with the PRO Worker deployed before remote-share and every other
  service-control consumer.
