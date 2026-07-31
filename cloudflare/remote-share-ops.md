# MUSIXQUARE Remote Share Operations

This note records the current operating decision for Cloudflare-backed remote
file sharing. The standard-room path stores one complete private object per
remote file; chunked streaming protocols are not part of the production
service.

Cloudflare plan limits were last checked against the official Workers, Workers
KV, R2, and WAF documentation on 2026-07-18. Recheck those sources before
making a cost or upgrade decision. R2 Standard currently includes 10 GB-month
of storage per month in its free usage allowance; this is an allowance rather
than a hard account storage cap.

## Current Decision

- Start on Cloudflare Workers Free.
- Keep the KV-backed allocation rate limit on `POST /session`.
- Cap each standard room's active R2 objects at 1 GiB
  (`ROOM_STORAGE_QUOTA_BYTES`) through a per-room SQLite Durable Object.
- Upload and download each remote file as one complete object. Current clients
  use the private plaintext route; the encrypted whole-object route remains for
  compatible cached clients until their temporary objects expire.
- Upgrade to Workers Paid only when real usage starts hitting Free-plan limits.
- Keep the Cloudflare WAF burst guard on the single top-level allocation route,
  `POST /session`.

WAF Rate Limiting blocks abusive allocation bursts before they reach the
Worker. A normal successful upload consumes one KV write for the upload-session
rate counter. Downloads do not write to KV.

## Remote Upload Cost Shape

One remote whole-file upload attempt roughly means:

- `POST /session`: one Worker request, KV read/write, one room Durable Object
  request, a room-prefix R2 usage check, and a presigned R2 PUT URL issued only
  after the exact stored bytes are durably reserved.
- Direct `PUT` to R2: one R2 Class A operation, with no Worker body upload.
- `POST /complete`: one Worker request, R2 HEAD validation, and one serialized
  room Durable Object request with an authoritative room-prefix usage recheck.
  A racing excess object is deleted before publication.
- `DELETE /object/...`: R2 HEAD/delete only. The exact-byte reservation remains
  charged until its fixed expiry because deleting an object does not revoke an
  already-issued, still-valid presigned PUT URL.
- `GET /download/...` or `GET /v3/plain/...`: one Worker request and one R2 read
  per remote guest.

## Current Guardrails

- App-issued, IP/scope-bound capability token required on `POST /session` in
  production. With Turnstile disabled, the app Worker issues it only after a
  signed proof-of-work challenge; Origin and Host headers are not proof.
- Signed upload-session and completion tokens.
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
  tombstones until a one-hour quiet interval proves that no authorized late PUT
  arrived. The bucket lifecycle rule is the final cleanup backstop.
- An abandoned or malicious session can hold its declared bytes until object
  expiry even when no PUT becomes visible. Capability, IP throttling, WAF, and
  account-wide R2 alerts remain necessary abuse and cost controls.
- The production bucket lifecycle policy in
  `cloudflare/r2-lifecycle.remote-share.json` expires both the encrypted
  `room/` prefix and plaintext `plain-room/` prefix after one day.
- Max plaintext wire/storage size is fixed at 200 MiB. AES-GCM compatibility
  objects are exactly 16 bytes larger. Browser allocation and
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

- KV writes approach the Free limit of 1,000 writes per day.
- Worker requests approach the Free limit of 100,000 requests per day.
- Users see upload-session 429 responses during normal use.
- Remote-share uploads fail because of Cloudflare platform limits.

Paid Workers are expected to be enough for a long time. WAF remains an abuse
control rather than a normal-cost optimization.

References: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/),
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
- The KV counter can be removed only after `POST /session` moves to another
  durable counter.
- Both Workers must share the capability HMAC secret.
- `wrangler.remote-share.toml` retains append-only Durable Object history: v1
  created the unused `RemoteShareRateLimiter`, v2 deleted it, and v3 created the
  distinct SQLite `RemoteShareQuota` namespace. Do not reuse the deleted class
  name or edit old migration tags.
- Cloudflare cannot roll a Worker version back across a Durable Object class
  lifecycle migration. The release bridge establishes the v3 lifecycle before
  atomic quota is enabled; later releases do not repeat it.
- Emergency remote-share deployments fail closed until that lifecycle bridge
  is present in production.
- Public `/session`, `/complete`, cleanup, and download response shapes remain
  backward-compatible with cached whole-object clients.
