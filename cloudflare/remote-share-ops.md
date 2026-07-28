# MUSIXQUARE Remote Share Operations

This note records the current operating decision for Cloudflare-backed remote
file sharing. It is intentionally practical: what to watch, when to upgrade,
and which guardrails are meant to solve which problem.

Cloudflare plan limits were last checked against the official Workers, Workers
KV, R2, and WAF documentation on 2026-07-18. Recheck those sources before
making a cost or upgrade decision. R2 Standard currently includes 10 GB-month
of storage per month in its free usage allowance; this is an allowance rather
than a hard account storage cap.

## Current Decision

- Start on Cloudflare Workers Free.
- Keep the existing KV-backed per-IP upload-session rate limit.
- Cap each standard room's active encrypted R2 objects at 1 GiB
  (`ROOM_STORAGE_QUOTA_BYTES`) through a per-room SQLite Durable Object.
- Upgrade to Workers Paid only when real usage starts hitting Free-plan limits.
- Keep the active Cloudflare WAF burst guard on the top-level allocation
  routes: `POST /session` and `POST /v2/sets`.

WAF Rate Limiting is not expected to reduce normal KV writes. It blocks abusive
or bursty top-level allocation requests before they reach the Worker. Normal
successful remote uploads still consume one KV write for the upload-session
rate counter. Per-record V2 upload-authority and completion requests are
intentionally excluded: one valid set can contain up to 25 records, and those
requests reuse the set's already-admitted allocation.

## Remote Upload Cost Shape

One V1 remote file upload attempt roughly means:

- `POST /session`: Worker request, KV read/write, one room Durable Object
  request, a room-prefix R2 usage check, and a presigned R2 PUT URL issued
  only after the ciphertext bytes are durably reserved.
- Direct `PUT` to R2: R2 Class A operation, no Worker body upload.
- `POST /complete`: Worker request, R2 HEAD validation, and one serialized
  room Durable Object request with an authoritative room-prefix usage recheck.
  A racing excess object is deleted before publish.
- `DELETE /object/...`: R2 HEAD/delete only. The exact-byte reservation remains
  charged until its fixed expiry because deleting an object does not revoke an
  already-issued, still-valid presigned PUT URL.
- `GET /download/...`: one Worker request and one R2 read per remote guest.

Downloads do not write to KV.

One V2 record-set upload still performs only one rate-limited allocation at
`POST /v2/sets`. Each encrypted record then requests one short-lived direct R2
PUT authority and reports one completion. These per-record control requests
must not be counted by the outer WAF allocation-burst rule.

## Current Guardrails

- Client-side AES-GCM encryption before upload.
- Signed upload session and completion tokens.
- Direct-to-R2 presigned PUT upload path.
- R2 object TTL: `OBJECT_TTL_SECONDS`, currently 1 hour by default.
- Standard-room temporary R2 quota: 1 GiB per generated room code in the exact
  `100000`-`999999` range, counting all active encrypted objects under that
  room's R2 prefix plus every issued session whose PUT is not yet visible in
  R2. `RemoteShareQuota` is addressed by room code and serializes reservation,
  completion, release, and expiry accounting. Therefore two concurrent
  `/session` calls cannot both observe the same free bytes: the first durable
  reservation is included before the second request can be admitted.
- Session setup reserves the exact AES-GCM ciphertext size before returning the
  presigned URL. Presign/token construction failure before the response rolls
  that reservation back. Completion revalidates the R2 object and atomically
  changes the reservation to completed. Any R2, Durable Object, state, bounded
  scan, or cleanup failure denies the operation rather than issuing/publishing
  an unaccounted object.
- Authenticated cleanup deletes a matching physical object but deliberately
  does not release its reservation. A HEAD miss behaves the same way: the
  already-issued presigned PUT may still be in flight or may be replayed before
  its start window closes. The room alarm removes the reservation only at the
  fixed object expiry and deletes any expired physical object it can see.
  Bucket lifecycle remains the final backstop.
- This exact accounting has a deliberate availability trade-off: an abandoned
  or malicious session can hold its declared bytes until object expiry even
  when no PUT becomes visible. At the current limits, five maximum-size
  sessions can consume almost the entire 1 GiB room allowance for up to one
  hour. The existing capability, IP, and WAF controls limit request abuse, but
  a hard per-room entitlement would require signaling-issued authorization.
- This is an atomic per-room session-admission ceiling, not an abuse-resistant
  account billing entitlement. Room codes remain client-supplied, and the
  direct R2 data plane plus bucket lifecycle still require account-wide usage
  alerts and the existing capability/IP/WAF controls.
- The production R2 bucket also has a bucket-level lifecycle rule that automatically
  expires remote-share objects. This setting lives in R2 rather than this repository
  and must remain configured for a maximum intended retention of 24 hours. Wrangler
  last confirmed the enabled one-day `room/` expiry rule on 2026-07-11.
- Max plaintext wire/storage size: fixed at 200 MiB across the descriptor,
  Worker session, and stored-object checks. AES-GCM ciphertext is exactly 16
  bytes larger. The current app does not apply a predictive device-tier or PCM
  admission ceiling before attempting the operation. Browser allocation,
  encryption/decryption, and `decodeAudioData` can still fail below 200 MiB,
  especially when a compressed file expands into a large PCM buffer.
- KV rate limit:
  - `IP_UPLOADS_PER_WINDOW`: default 60 upload sessions per IP per hour.
  - `ROOM_UPLOADS_PER_WINDOW`: default 0, which disables room-wide limiting.
- `ROOM_STORAGE_QUOTA_BYTES`: production is `1073741824` (1 GiB). Setting it
  to `0` disables new atomic admission. Existing marked reservations still
  settle through the Durable Object while its binding is present, so changing
  the limit does not strand in-flight uploads. Reaching the configured limit
  stops only the R2 route; same-network direct file delivery remains available.
  This per-room guard
  does not replace account-wide R2 usage monitoring or billing alerts. The
  standard room code is client-supplied rather than a server-issued storage
  entitlement, so this is an operational normal-client limit, not an
  abuse-resistant account cost ceiling. Capability, IP throttling, and WAF
  remain the abuse controls; a future hard entitlement requires a
  signaling-issued room upload capability.
- The Worker rejects missing, malformed, and `0xxxxx` room IDs before issuing a
  presigned URL. The complete `0xxxxx` namespace is reserved for PRO rooms,
  whose persistent media uses the separate PRO bucket and control plane.
- App-issued capability token required on `POST /session` and `POST /v2/sets`
  in production. With Turnstile disabled, the app Worker issues it only after
  a signed, IP/scope-bound proof-of-work challenge; Origin/Host headers are not
  proof.
- R2 bucket CORS includes exact MUSIXQUARE web origins, the canonical
  `https://musixquare.apps.tossmini.com` production origin, the existing Toss
  apex/pattern entries, and local development origins. R2 documents Origin
  matching as exact, so every additional concrete production Toss origin must
  also be added explicitly; a Worker-side wildcard allowlist alone is not
  sufficient. Keeping these lists aligned prevents an authorized session from
  failing only when the browser performs the direct R2 PUT preflight.
- App worker CSP allows direct R2 upload connections via
  `https://*.r2.cloudflarestorage.com`.

## Upgrade Signals

Move from Workers Free to Workers Paid if any of these become normal rather than
temporary test noise:

- KV writes approach the Free limit of 1,000 writes per day.
- Worker requests approach the Free limit of 100,000 requests per day.
- Users see upload-session 429 responses during normal use.
- Remote share uploads fail because of Cloudflare platform limits.

Paid Workers are expected to be enough for a long time. The main reason to add
WAF after that is abuse control, not normal-cost optimization.

References: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
and [WAF rate-limiting availability](https://developers.cloudflare.com/waf/rate-limiting-rules/).

## Required WAF Rate Limit

The production zone's `Remote share session burst guard` rule must remain
enabled with this allocation-route scope:

- Match host: `share.musixquare.com`
- Match path: `/session` or `/v2/sets` (exact paths)
- Match method: `POST`
- Characteristic: IP
- Threshold: 20 requests
- Period: 10 seconds
- Action: block for 10 seconds after the threshold is exceeded

This outer guard stops automated V1 session and V2 set-creation bursts before
they consume a Worker request or KV operation. Do not broaden the match to
`/v2/sets/*`: record upload-authority and completion calls are normal traffic
inside one already-admitted set. The short window and short block keep normal
multi-file use below the threshold and minimize user-visible impact. Revisit
the threshold only with production 429 evidence; on higher Cloudflare plans, a
longer, more ergonomic per-minute window can replace it.

Before enabling V2 record sets, inspect the live rule. If its exact-path
expression still matches only `/session`, add the exact `/v2/sets` alternative
without changing the threshold or matching any descendant record route.

## Notes

- WAF does not replace the Worker-side KV rate limit. It is an outer layer for
  fast bursts.
- KV rate limiting can be removed only if we intentionally accept weaker abuse
  resistance or replace it with another durable counter.
- Capability-gated sessions use the app Worker's transparent proof-of-work path
  while Turnstile remains disabled. Both Workers must share the capability
  HMAC secret.
- `wrangler.remote-share.toml` retains the append-only Durable Object history:
  v1 created the unused `RemoteShareRateLimiter`, v2 deleted it, and v3 creates
  the distinct SQLite `RemoteShareQuota` namespace. Do not reuse the deleted
  class name or edit the old migration tags.
- Cloudflare cannot roll a Worker version back across a Durable Object class
  lifecycle migration. On the first v3 release, the release workflow therefore
  deploys the new class once with `REMOTE_SHARE_ATOMIC_QUOTA_ENABLED=false`,
  runs the live smoke, records that same-lifecycle bridge as the rollback
  baseline, and only then deploys the active configuration. Later releases do
  not repeat the bridge.
- The `emergency:deploy:remote-share` and `emergency:deploy:all-workers` paths
  fail closed until that lifecycle bridge is already present in production;
  they cannot be used to perform the first v3 migration.
- All completion tokens keep the opaque v2 envelope. New quota-backed sessions
  add a signed `quotaReservationVersion` marker that old Workers ignore while
  the new Worker uses it for Durable Object settlement. Unmarked v2 tokens keep
  bounded LIST validation during rollout and expire naturally within the
  one-hour object lifetime. Public `/session`, `/complete`, and cleanup
  response shapes are unchanged.
