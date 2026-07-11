# MUSIXQUARE Remote Share Operations

This note records the current operating decision for Cloudflare-backed remote
file sharing. It is intentionally practical: what to watch, when to upgrade,
and which guardrails are meant to solve which problem.

Cloudflare plan limits were last checked against the official Workers, Workers
KV, and WAF documentation on 2026-07-11. Recheck those sources before making a
cost or upgrade decision.

## Current Decision

- Start on Cloudflare Workers Free.
- Keep the existing KV-backed per-IP upload-session rate limit.
- Upgrade to Workers Paid only when real usage starts hitting Free-plan limits.
- Add Cloudflare WAF Rate Limiting for `/session` only if abuse or burst traffic
  becomes visible.

WAF Rate Limiting is not expected to reduce normal KV writes. It blocks abusive
or bursty `/session` requests before they reach the Worker. Normal successful
remote uploads still consume one KV write for the upload-session rate counter.

## Remote Upload Cost Shape

One remote file upload attempt roughly means:

- `POST /session`: Worker request, KV read, KV write, presigned R2 PUT URL issued.
- Direct `PUT` to R2: R2 Class A operation, no Worker body upload.
- `POST /complete`: Worker request, R2 HEAD validation.
- `GET /download/...`: one Worker request and one R2 read per remote guest.

Downloads do not write to KV.

## Current Guardrails

- Client-side AES-GCM encryption before upload.
- Signed upload session and completion tokens.
- Direct-to-R2 presigned PUT upload path.
- R2 object TTL: `OBJECT_TTL_SECONDS`, currently 1 hour by default.
- The production R2 bucket also has a bucket-level lifecycle rule that automatically
  expires remote-share objects. This setting lives in R2 rather than this repository
  and must remain configured for a maximum intended retention of 24 hours. Wrangler
  last confirmed the enabled one-day `room/` expiry rule on 2026-07-11.
- Max plaintext wire/storage size: fixed at 200 MiB across the descriptor,
  Worker session, and stored-object checks. AES-GCM ciphertext is exactly 16
  bytes larger. This is a protocol ceiling, not a browser admission guarantee:
  before host encryption and guest download/decryption, each endpoint applies a
  device-tier transport working-set budget, followed by a separate PCM/decode
  budget, so its effective file limit can be lower.
- KV rate limit:
  - `IP_UPLOADS_PER_WINDOW`: default 60 upload sessions per IP per hour.
  - `ROOM_UPLOADS_PER_WINDOW`: default 0, which disables room-wide limiting.
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
and [WAF rate-limiting availability](https://developers.cloudflare.com/waf/rate-limiting-rules/).

## WAF Rate Limiting Plan

Use WAF Rate Limiting for `/session` when there is evidence of automated or
bursty upload-session creation.

Suggested starting rule on a Free zone:

- Match path: `/session`
- Characteristic: IP
- Threshold: 10 to 20 requests
- Period: 10 seconds
- Action: Block or rate limit
- Duration: 10 seconds

On higher Cloudflare zone plans, prefer a more ergonomic window:

- Match host: `share.musixquare.com`
- Match path: `/session`
- Match method: `POST` if the plan supports method matching.
- Characteristic: IP
- Threshold: around 30 requests per minute to start.
- Duration: 10 minutes to 1 hour.

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
