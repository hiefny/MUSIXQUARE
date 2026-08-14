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
- Require the signaling-issued standard-room host assertion on every
  production `POST /session`. Missing, expired, or invalid assertions are
  rejected before allocation, quota, or R2 work.
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
for its per-IP allocation counter and a second request for the room counter.
Downloads do not consume either allocation limiter.

## Standard-Room Host Upload Assertion

The capability gate and host assertion prove different things and both remain
in the request path. The app-issued capability is the public allocation/abuse
gate. The `X-MXQR-Room-Upload-Assertion` header is a 60-second HMAC proof from
signaling that the requesting peer is the current host of that standard room.
It is not an E2EE feature and does not change the stored whole-object format.

The assertion is bound to the standard room, signaling host peer, session ID,
queue item UUID, declared size, private v3 `actorId`, v3 `requestId`, and the
base64url SHA-256 of the exact raw `/session` JSON bytes. It also carries a
unique `jti`, issue/expiry times, the `host` role, audience, scope, and version.
Remote Share recomputes the digest from the bytes it parsed; whitespace or key
order changes therefore require a fresh assertion even when the JSON is
semantically equivalent.

`jti` is deliberately not a one-time database key. The same assertion may be
retried with the byte-identical body inside its 60-second lifetime, and a fresh
assertion for the same actor/request/body can recover the existing v3 durable
receipt after that. Every authority-bearing field and the complete body bytes
remain fixed, so retry never expands the reservation to another room, item,
size, actor, request, name, or MIME type. Once signaling no longer recognizes
the peer as host, it cannot mint the fresh proof needed for later retries.

`ROOM_UPLOAD_ASSERTION_MODE` has these values:

- `disabled`: local/test-only behavior. The assertion is not checked, and the
  production security guard rejects this mode.
- `optional`: retained only for isolated compatibility tests. A missing header
  is accepted and counted as legacy, but the production security guard rejects
  this mode.
- `required`: the production invariant. Missing, expired, altered, legacy
  six-field, and cached v2/v3 requests without a valid assertion fail with 403
  before R2, quota, or rate allocation work.

Both `optional` and `required` fail closed with 503 if
`MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET` is missing, is a plain value shorter
than 32 characters, or is a malformed prefixed keyring. Every keyring secret has
the same 32-character minimum. This secret value is shared only by signaling and
Remote Share; do not reuse the upload-token or app capability secrets.
`/security-config` advertises assertion version, mode, and whether it is
required. Signaling advertises version 1 in `peer-open`, and new clients use the
correlated WebSocket
`remote-share-upload-assertion-request` / `remote-share-upload-assertion`
exchange only when that feature is present. This avoids treating an old
signaling deployment as a transient assertion failure. Once a client has
observed version 1, a disconnect, missing marker, or older replacement
signaling deployment fails closed instead of returning to a missing-header
request.

The Remote Share D1 binding writes only these three aggregate minute-bucket
counters through `ctx.waitUntil`; it never stores the room, peer, actor,
request, token, body digest, object, capability, or IP:

- `remote_share_upload_assertion_verified`
- `remote_share_upload_assertion_legacy`
- `remote_share_upload_assertion_rejected`

Verified and legacy events are written only after a new session reservation is
successfully issued; an exact v3 replay does not count again. Rejected-event
writes are independently capped at 10 per IP-derived limiter key per normal
rate window, while rejection itself remains fail closed even when telemetry is
unavailable. These are rollout signals, not request, billing, or unique-user
totals.

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
  - `ROOM_UPLOADS_PER_WINDOW`: default 120 sessions per standard room per hour.
    This permits two independent IP budgets (including a host network change)
    while bounding attacks spread across many IPs. It is far below the
    service-control idempotency-set ceiling of 1024.
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
- Every key inside `MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET` must be a third
  independent random value of at least 32 characters. The full plain or keyring
  value is shared only by signaling and Remote Share.
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
  `admin-announcement-v2+abuse-rate-v2+session-idempotency-v1`. A change to that marker also requires
  target `all`, with the PRO Worker deployed before remote-share and every other
  service-control consumer.

## Required-Assertion Cutover Record

The permanent production order is Remote Share, signaling, then the app. The
release workflow enforces a full release for this shared contract and verifies
the exact deployed Remote Share and signaling versions.
The contract marker was advanced to
`canonical-whole-object-actor-replay-v3+host-assertion-required-v1`, so once a
required candidate is observed live, both same-job and independent recovery
retain the required Remote Share/App boundary and report forward repair instead
of restoring the optional baseline.

On 2026-08-15 the owner approved an immediate cached-client compatibility
cutoff because the service was still effectively prelaunch with negligible
legacy usage. The modern client and assertion-capable signaling Worker were
deployed together once while Remote Share remained optional; the strict
cross-Worker smoke proved that both Workers held the same secret and that only
the authenticated current host could mint a valid assertion. Production was
then changed to `required` without a 30-day or consecutive-zero-day adoption
gate. This is an intentional compatibility break: an old cached client must
refresh before it can create a Remote Share upload session.

The production contract is now:

1. `ROOM_UPLOAD_ASSERTION_MODE=required` and
   `roomUploadAssertionRequired=true` are required by source guards and live
   exact-version readiness checks.
2. The same independent assertion secret must exist on signaling and Remote
   Share. The release preflight checks both secret-name inventories, and the
   strict post-signaling smoke proves the values match without exposing them.
3. Missing or invalid assertions fail with 403 before allocation. Production
   must not be rolled back to `optional`; repair forward or place the upload
   path in maintenance while correcting an authority failure.
4. `remote_share_upload_assertion_legacy` is a regression sentinel and must
   remain zero. Verified and bounded rejected counters remain diagnostic
   signals, not a scheduled transition gate or a reason for weekly review.

Cached six-field/v2/v3 bundles cannot understand the new authority contract and
receive a generic failed upload. Recovery is the already-shipped
service-worker update prompt or a hard refresh. Do not weaken required mode to
manufacture an update message that the cached script cannot consume.

The existing plain `MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET` value remains a
fully supported single-key configuration and continues to mint an unkeyed v1
assertion. For a staged rotation, the same secret binding also accepts this
explicit keyring form (paste the complete value only into Wrangler's interactive
secret prompt; never put real key material in a command argument or repository):

```text
mxqr-keyring-v1:{"v":1,"current":{"kid":"2026-09-a","secret":"<new-random-32+-character-secret>"},"previous":{"kid":"2026-08-a","secret":"<old-secret>"}}
```

`kid` is a non-secret 1-64 character identifier using letters, digits, `.`, `_`,
or `-`; current and previous IDs and secret values must differ. New signaling
assertions carry the current `kid`. Remote Share selects that signed key ID and
accepts either slot. During the migration window it also tries both slots for an
old unkeyed assertion, so a signaling Worker still using the plain value does
not lose authority. A malformed prefixed keyring fails readiness closed; it is
never treated as a legacy HMAC string.

Before changing the binding, first deploy the keyring-capable release to both
Workers. Remote Share `/security-config` must report
`roomUploadAssertionKeyringVersion: 1`, and signaling's authenticated host
`peer-open` must report `remoteShareUploadAssertionKeyringVersion: 1`. The
strict live Remote Share smoke verifies both markers and, during a release,
their expected Worker version IDs. Record those two live version IDs against the
approved release before rotation. A 200 response without the keyring marker is
not sufficient: an older Remote Share Worker treats the prefixed JSON as one
plain HMAC secret and can look healthy while rejecting every assertion. If
either marker or approved version is missing, do not change either secret;
finish or repair the two-Worker code rollout first.

Rotate in this order:

1. Generate the new independent secret and a new `kid`. Keep the old secret
   available to the operator; do not reuse another MUSIXQUARE signing secret.
2. Put the two-slot keyring on **Remote Share first**. Confirm
   `/security-config` remains healthy and still reports keyring version 1. It
   now verifies both old unkeyed/current traffic and the future keyed assertion.
3. Put the byte-identical keyring on **signaling second**. Run the strict live
   Remote Share smoke and confirm a real allocation succeeds. Never swap these
   first two steps: a new keyed assertion cannot be verified by the old plain
   Remote Share configuration.
4. Wait at least 90 seconds after the signaling update (the 60-second assertion
   lifetime plus the full 30-second verifier clock-skew allowance).
5. Remove `previous` from Remote Share first, then set the same current-only
   keyring on signaling. Re-run the strict smoke. Keep the retired secret out of
   both Workers after evidence is saved.

Before step 5, rollback means restoring the old plain value on signaling first
and then on Remote Share. After previous-key removal, repair forward with the
new current key; do not reintroduce a retired key without a new incident review.

The six-field/v2 parsers and optional-mode runtime branch remain non-production
compatibility scaffolding; required mode prevents them from authorizing a live
reservation. Removing that scaffolding is a separate full-contract v4 cleanup:
bump `remote-share-contract-version.txt` and `workerContractVersion`, update the
client, live smoke, and release dependency mapping, and deploy the full
Worker/signaling/app set together. It is not tied to a traffic-observation
calendar.

## Maintenance PUT drain and emergency write freeze

Global maintenance blocks new Remote Share `/session` and `/complete` Worker
requests, but it cannot recall a direct R2 presigned PUT that was returned before
maintenance became effective. Production config sets `UPLOAD_TOKEN_TTL_SECONDS`
to 600, and the Worker clamps every newly issued or replayed URL to a request
start window of **at most 10 minutes** even if a larger value or a legacy receipt
is supplied. This is not a PUT completion deadline: SigV4 expiry is checked when
the HTTP request is admitted, so a request that starts just before expiry may
finish afterward. The one-shot `If-Match` placeholder fence still applies, but
operators must retain maintenance until in-flight work and delayed object
visibility are resolved rather than relying on the ten-minute clock alone.

For planned maintenance:

1. Record the maintenance control's effective UTC timestamp as `T0`, the Remote
   Share Worker version, and the active R2 S3 access-key ID. Do not record either
   secret or any presigned URL in a ticket or log.
2. Enable global maintenance and confirm a fresh `/session` request is rejected.
   This stops new URLs; the ten-minute clock starts at `T0`, not when an operator
   begins the change.
3. Keep maintenance enabled through `T0 + 10 minutes`. Do not infer drain from
   quiet application traffic. This deadline only prevents a client from starting
   another request with the old URL; a PUT admitted before it can still commit
   later.
4. After the deadline, confirm a controlled pre-maintenance URL can no longer
   **start** a PUT. Before changing storage or quota state, obtain provider
   evidence that active/in-flight PUT requests for the bucket and dedicated key
   are zero. If that evidence is unavailable or ambiguous, keep maintenance
   enabled and use the dedicated-key revocation procedure below; a wall-clock
   wait by itself is not a drain proof.
5. Capture an object inventory and PUT/request metrics as snapshot `S1`. After
   active requests reach zero (or dedicated-key revocation has propagated), wait
   at least two complete provider metric intervals and never less than 90
   seconds, then capture snapshot `S2`. Object keys, sizes, ETags, and
   last-modified values at or after `T0` must be unchanged. PUT counters must be
   stable, and any available active-request gauge must remain zero. Any late
   commit or metric change resets the observation window. Do not proceed when
   either snapshot or its time boundary cannot be proven.

For an incident that requires an immediate strict write freeze, first enable
maintenance and then revoke the **dedicated Remote Share R2 S3 access key** that
signed outstanding URLs. Create a replacement credential restricted to the same
bucket and update `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` while maintenance
remains active. Confirm a controlled URL signed by the revoked key is rejected;
do not assume revocation propagation from the dashboard state alone. Revocation
prevents new request admission after propagation but does not, by itself, prove
that an already admitted request was terminated. Repeat the `S1`/`S2` stability
check above; a change that cannot tolerate one late commit additionally requires
provider confirmation that no accepted PUT remains. Rotating
`REMOTE_SHARE_SIGNING_SECRET`, the capability secret, or the upload-assertion
keyring does not invalidate an already presigned R2 URL and is not a substitute
for revoking the R2 credential. Do not rotate a credential shared with another
bucket or service.

Before leaving maintenance, preserve both stable snapshots and the read-only
provider evidence for writes whose last-modified time is at or after `T0`.
Investigate every such object against its room reservation and completion state.
Do not blindly delete an object: use its authenticated cleanup path or normal
expiry so Durable Object quota accounting remains conservative. Verify that no
post-`T0` completion became downloadable, that the revoked/expired canary URL
cannot start a PUT, and that a fresh `/session` is still maintenance-blocked.
After maintenance is lifted, run the strict Remote Share live smoke; its
controlled allocation exercises prefix reconciliation, completion, download,
and cleanup.
Keep maintenance enabled and repair forward if the object view, metrics,
credential revocation test, or reconciliation result is unavailable or
ambiguous.
