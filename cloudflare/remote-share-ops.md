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
  (`ROOM_STORAGE_QUOTA_BYTES`).
- Upgrade to Workers Paid only when real usage starts hitting Free-plan limits.
- Keep the active Cloudflare WAF burst guard on `POST /session`.

WAF Rate Limiting is not expected to reduce normal KV writes. It blocks abusive
or bursty `/session` requests before they reach the Worker. Normal successful
remote uploads still consume one KV write for the upload-session rate counter.

## Remote Upload Cost Shape

One remote file upload attempt roughly means:

- `POST /session`: Worker request, KV read/write, room-prefix R2 usage check,
  and presigned R2 PUT URL issued.
- Direct `PUT` to R2: R2 Class A operation, no Worker body upload.
- `POST /complete`: Worker request, R2 HEAD validation, and an authoritative
  room-prefix usage recheck. A racing excess object is deleted before publish.
- `GET /download/...`: one Worker request and one R2 read per remote guest.

Downloads do not write to KV.

## Current Guardrails

- Client-side AES-GCM encryption before upload.
- Signed upload session and completion tokens.
- Direct-to-R2 presigned PUT upload path.
- R2 object TTL: `OBJECT_TTL_SECONDS`, currently 1 hour by default.
- Standard-room temporary R2 quota: 1 GiB per generated room code in the exact
  `100000`-`999999` range, counting all active encrypted objects under that
  room's R2 prefix. Session creation checks
  capacity early; completion checks it again so concurrent uploads cannot
  publish an over-quota object. Failed uploads issue best-effort authenticated
  cleanup, while expiry and the bucket lifecycle remain cleanup backstops. A
  direct PUT that finishes after an interrupted client has already attempted
  cleanup can temporarily occupy physical R2 storage until expiry, so this is
  a published-object guard rather than an atomic billing hard cap.
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
  to `0` disables this storage guard. Reaching it stops only the R2 route;
  same-network direct file delivery remains available. This per-room guard
  does not replace account-wide R2 usage monitoring or billing alerts. The
  standard room code is client-supplied rather than a server-issued storage
  entitlement, so this is an operational normal-client limit, not an
  abuse-resistant account cost ceiling. Capability, IP throttling, and WAF
  remain the abuse controls; a future hard entitlement requires a
  signaling-issued room upload capability.
- The Worker rejects missing, malformed, and `0xxxxx` room IDs before issuing a
  presigned URL. The complete `0xxxxx` namespace is reserved for PRO rooms,
  whose persistent media uses the separate PRO bucket and control plane.
- App-issued capability token required on `POST /session` in production. With
  Turnstile disabled, the app Worker issues it only after a signed,
  IP/scope-bound proof-of-work challenge; Origin/Host headers are not proof.
- R2 bucket CORS allows every production origin accepted by the Workers
  (musixquare and Toss apex/wildcard origins) plus local development origins.
  Keeping these lists aligned prevents an authorized session from failing only
  when the browser performs the direct R2 PUT preflight.
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

## Active WAF Rate Limit

The production zone currently has the `Remote share session burst guard` rule
enabled:

- Match host: `share.musixquare.com`
- Match path: `/session`
- Match method: `POST`
- Characteristic: IP
- Threshold: 20 requests
- Period: 10 seconds
- Action: block for 10 seconds after the threshold is exceeded

This outer guard stops automated session-creation bursts before they consume a
Worker request or KV operation. The short window and short block keep normal
multi-file use below the threshold and minimize user-visible impact. Revisit
the threshold only with production 429 evidence; on higher Cloudflare plans, a
longer, more ergonomic per-minute window can replace it.

## Notes

- WAF does not replace the Worker-side KV rate limit. It is an outer layer for
  fast bursts.
- KV rate limiting can be removed only if we intentionally accept weaker abuse
  resistance or replace it with another durable counter.
- Capability-gated sessions use the app Worker's transparent proof-of-work path
  while Turnstile remains disabled. Both Workers must share the capability
  HMAC secret.
- Durable Objects are reserved for future room-level, strongly consistent
  counters if the simpler IP-based KV limit becomes insufficient.
