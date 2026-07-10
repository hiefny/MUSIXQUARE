# MUSIXQUARE Remote Share Operations

This note records the current operating decision for Cloudflare-backed remote
file sharing. It is intentionally practical: what to watch, when to upgrade,
and which guardrails are meant to solve which problem.

## Current Decision

- Start on Cloudflare Workers Free.
- Keep the Durable Object-backed, atomic per-IP session limit. The separate
  upload-attempt counter remains only for the rolling v2 Worker proxy.
- Do not apply a shared quota to a room code unless the room gains authenticated
  ownership; public room IDs are not an authorization boundary.
- Upgrade to Workers Paid only when real usage starts hitting Free-plan limits.
- Add Cloudflare WAF Rate Limiting for `/session` only if abuse or burst traffic
  becomes visible.

WAF Rate Limiting blocks abusive or bursty `/session` requests before they
reach the Worker. Normal v3/v4 traffic invokes the per-IP Durable Object once
for session issuance; encrypted bodies then travel directly to R2.

## Remote Upload Cost Shape

One remote file upload attempt roughly means:

- `POST /session`: one Worker request, one atomic per-IP Durable Object counter,
  and either a v3 placeholder write or a v4 `CreateMultipartUpload` operation.
- V3 uses one direct presigned `PUT`. V4 uses one direct presigned R2
  `UploadPart` per encrypted 8 MiB record. Neither upload body passes through a
  Worker request.
- `POST /parts`: v4 control-plane calls issue bounded batches of part-number,
  upload-ID, byte-length, content-type, and `Content-MD5`-bound presigned URLs.
  Each URL is valid for at most 15 minutes and never beyond the multipart
  session's transfer window.
- `POST /complete`: one Worker request, an R2 HEAD validation, and one
  conditional zero-byte ready-marker write. V4 also performs the R2 multipart
  completion operation.
- `POST /abort`: aborts an incomplete v4 upload without deleting an already
  completed object.
- `GET /download/...`: one Worker request, one ready-marker HEAD, and one R2
  full or ranged object read per remote guest.

Downloads do not invoke the rate-limiter Durable Object.

## Client Large-File Path

- Protocol v3 removes the 64 MiB product limit and sends the encrypted body from
  the browser directly to R2 with one presigned `PUT`.
- Protocol v4 maps exactly one 8 MiB plaintext AES-GCM record to one R2
  multipart part. The final record may be shorter. At the 5 GiB plaintext
  ceiling this is 640 parts and 10,240 bytes of authentication tags.
- V4 does not stage the complete plaintext or ciphertext in OPFS. The browser
  encrypts, uploads, and releases one bounded record at a time. A failed part can
  be retried without restarting already accepted parts.
- Audio whose decoded PCM would exceed the Web Audio memory budget uses an
  `HTMLAudioElement` connected through `MediaElementAudioSourceNode`.
- V3 remains the rolling single-PUT compatibility path; an interrupted v3 upload
  restarts from byte zero.

## Current Guardrails

- Client-side AES-GCM encryption before upload; large files use the chunked path
  described above.
- Protocol v3 presigns one R2 `PUT` bound to the random final key, encrypted
  byte length, `Content-Type`, `Cache-Control`, exact custom metadata, and the
  conditional `If-Match` header.
- `/session` first creates a zero-byte placeholder with `If-None-Match: *`.
  The presigned PUT carries that placeholder's quoted ETag in `If-Match`.
  The first completed write changes the ETag; every replay then fails with 412.
  Deleting the object cannot re-arm the URL because a missing object also fails
  the old `If-Match` condition.
- `Content-Length` is part of the SigV4 signed-header set but is omitted from the
  returned `uploadHeaders`, because browsers own that forbidden request header
  and derive it from the Blob. Production smoke tests must cover Chromium and
  WebKit whenever signing code or CORS changes.
- V4 `/parts` accepts only a strictly increasing, unique, bounded list of
  `{partNumber, contentMd5}` records. The digest must be canonical base64 for
  exactly 16 MD5 bytes. Each URL fixes the random final key, R2 upload ID, part
  number, exact ciphertext length, `Content-Type`, and `Content-MD5`; R2 rejects
  a different same-length body as `BadDigest`. MD5 is used only as R2's transport
  checksum, not as the encryption or authenticity primitive. AES-GCM remains
  responsible for record authentication and fails closed on altered ciphertext.
- The upload ID is not returned as a top-level session field; it remains inside
  the HMAC control token and each operation-specific R2 URL. After encrypting one
  part and calculating its MD5, the browser requests that single part URL just
  in time, keeps the bearer URL in host memory only for the upload, and releases
  the record before continuing. Each issued URL expires after at most 15 minutes.
  A holder can still replay the exact same ciphertext PUT during that short
  window, but cannot replace it with different content; the remaining effect is
  bounded duplicate request cost.
- V4 `/complete` requires exactly `1..chunkCount` in order and a 32-hex ETag for
  every part before calling `resumeMultipartUpload().complete()`. It then HEADs
  the completed object and validates every compact metadata field before
  publishing readiness. If R2 committed but the completion response was lost,
  a matching final object is the idempotency oracle and the ready marker is
  recovered without invoking complete again.
- V4 `/abort` is idempotent. A completion that wins a race is preserved and made
  ready; abort never serves as authorization to delete a completed object.
- The v3 presigned URL and v4 multipart session transfer window scale at an
  assumed 1 MiB/s plus two minutes, with the configured ten-minute value as
  their minimum and two hours plus grace as their ceiling. Each v4 UploadPart
  URL is separately capped at 15 minutes from batch issuance. V2 retains the
  fixed configured token TTL. V3/v4 object and completion expiry add
  `OBJECT_TTL_SECONDS` after the transfer allowance, so a slow valid upload does
  not finish with an already-expired completion token.
- `/complete` verifies HEAD size and every security-relevant metadata field
  against its HMAC token. A still-current placeholder returns 409 without being
  deleted, allowing a real upload retry. Any non-placeholder mismatch is deleted.
- Only `/complete` creates `{objectKey}.ready`. Downloads require that marker and
  verify its size, expiry, and final object ETag, so placeholders and incomplete
  direct uploads are never served. Cleanup deletes the object and ready marker.
- The bounded v2 compatibility path still streams through the Worker, counts
  actual bytes with `FixedLengthStream`, consumes an `upload-session/` nonce,
  and is hard-capped at 64 MiB plaintext plus 4 KiB encrypted headroom.
- R2 object TTL: `OBJECT_TTL_SECONDS`, currently 12 hours after the upload
  allowance. This permits long podcasts and seeks after a long pause while
  staying inside the separate 24-hour bucket lifecycle safety net.
- The production R2 bucket also has a bucket-level lifecycle rule that automatically
  expires remote-share objects and another rule for `upload-session/` nonce
  markers. These settings live in R2 rather than this repository and must remain
  configured for a maximum intended retention of 24 hours.
- Direct v3 encrypted single-PUT ceiling: 5,363,466,240 bytes, Cloudflare R2's
  documented 5 GiB minus 5 MiB maximum single-request size.
- Direct v3 plaintext ceiling: 5,363,456,000 bytes. This reserves 640 AES-GCM
  tags of 16 bytes for the 8 MiB chunks while staying below the encrypted
  single-PUT ceiling. `MAX_UPLOAD_BYTES` may lower but never raise it.
- Direct v4 multipart plaintext ceiling: 5,368,709,120 bytes (exactly 5 GiB),
  split into at most 640 parts. `MAX_MULTIPART_UPLOAD_BYTES` may lower but never
  raise it. The corresponding maximum encrypted size is 5,368,719,360 bytes.
- Atomic per-IP Durable Object rate limit:
  - `IP_SESSIONS_PER_WINDOW`: default 60 issued sessions per IP per hour.
  - `IP_UPLOADS_PER_WINDOW`: default 60 legacy v2 proxy attempts per IP per hour.
  - `IP_UPLOAD_BYTES_PER_WINDOW`: direct v3/v4 sessions atomically reserve their
    declared encrypted bytes against a default 20 GiB per-IP hourly budget.
    This bounds storage abuse without reintroducing a small per-file limit.
  - `RATE_LIMIT_WINDOW_SECONDS`: default fixed window of one hour.
  - The `session` and `upload` counters are independent and transactionally
    incremented, so concurrent requests cannot exceed their configured limit.
  - A missing, unavailable, or malformed `REMOTE_SHARE_RATE_LIMITER` binding
    fails closed with 503 instead of silently disabling the limit.
- There is deliberately no room-code quota. Room codes are public and have no
  authenticated owner, so a room-level counter would let anyone who knows or
  guesses a code exhaust another room's capacity.
- Optional app-issued capability token on `POST /session` when
  `MXQR_CAPABILITY_SECRET` or `REMOTE_SHARE_CAPABILITY_SECRET` is configured on
  the remote-share Worker.
- The remote-share Worker is exposed only on `share.musixquare.com`; Wrangler
  `workers_dev` and preview URLs are disabled.
- Bucket CORS permits GET, HEAD, and PUT only from the production, supported
  Toss, and local development origins. Its allowed and exposed headers must stay
  aligned with v3/v4 signed upload headers and ranged reads; apply
  `r2-cors.remote-share.json` before deploying a Worker that issues v4 sessions.
- `/download` accepts one RFC-style byte range, pins the R2 read to the ready
  marker's final object ETag, and returns exact 206/416 `Content-Range`,
  `Content-Length`, `Accept-Ranges`, and ETag headers. Ciphertext streams through
  the Worker from an R2 ranged get; encryption keys never reach the Worker.

## Rolling protocol deployment

Protocol v4 uploads direct R2 multipart parts. Deploy bucket CORS, then the
remote-share Worker, then the web client. A client explicitly requesting v2
receives the old same-origin, 64 MiB-bounded Worker proxy response. The
immediately preceding production client sent no protocol field and allowed 200
MiB; the Worker maps only that unversioned shape to v3 direct R2 so open tabs do
not regress during rollout. A v3 response intentionally retains the legacy
direct-response shape (`PUT`, presigned URL, completion token), which that
client already understands. Keep `/upload` and explicit-v2 token validation
until old PWA tabs are outside the supported rollback window. Keep v3 session,
completion, download, and cleanup handling during the v4 rollout so a
web-client rollback does not strand already shared objects.

The complete production rollout order is remote-share Worker (including its
Durable Object migration), app/web Worker, then signaling Worker. Signaling is
last because the current client supplies a per-install guest reconnect secret
that older open tabs do not have; those tabs may need one refresh after the
strict signaling identity check is live.

## Upgrade Signals

Move from Workers Free to Workers Paid if any of these become normal rather than
temporary test noise:

- Durable Object requests or storage operations approach the applicable plan
  limit.
- Worker requests approach the Free limit.
- Users see upload-session 429 responses during normal use.
- Remote share uploads fail because of Cloudflare platform limits.

Paid Workers are expected to be enough for a long time. The main reason to add
WAF after that is abuse control, not normal-cost optimization.

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

- WAF does not replace the Worker-side Durable Object rate limit. It is an
  outer layer for fast bursts.
- The per-IP counters use one Durable Object instance per client IP and two
  independent fixed-window records. Expiry alarms delete stale records.
- Upload replay safety does not depend on the rate limiter. V3 uses the
  placeholder ETag as a one-transition CAS; v2 uses its persistent nonce marker.
  V4 binds every presigned URL to one upload ID, part number, byte length, and
  content type plus the exact ciphertext `Content-MD5`, then accepts only the
  ordered ETag list collected from UploadPart responses. V4 bearer URLs can
  replay only that checksum-matching body during their at-most-15-minute
  lifetime. AES-GCM authenticates each downloaded record.
- Capability-gated sessions reuse the app Worker's signed capability token. The
  checked production policy mints it through invisible proof-of-work; Turnstile
  remains disabled.
- The checked Wrangler configs declare the `REMOTE_SHARE_RATE_LIMITER` binding
  and its SQLite-class migration. Deploy the migration and Worker together;
  do not remove the binding independently because requests fail closed.
- The old `REMOTE_SHARE_RATE_LIMIT` KV namespace and
  `ROOM_UPLOADS_PER_WINDOW` variable are no longer read and can be removed
  after the Durable Object deployment is healthy.
