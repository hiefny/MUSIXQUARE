# Remote-share encrypted record-set API V2

Status: additive server contract for the bounded file-playback engine. V1
`/session`, `/complete`, `/download`, and `/object` remain unchanged.

## Scope and invariants

- This API accepts standard ephemeral room codes (`100000`-`999999`) only.
  `0xxxxx` remains reserved for the generation-bound PRO media service.
- Plaintext is limited to 200 MiB.
- A set uses fixed 8 MiB plaintext records and one 16-byte AES-GCM tag per
  record. `recordCount` is exactly `ceil(size / 8388608)` (maximum 25).
- R2 contains independent ciphertext records. Encryption keys and nonce
  prefixes never enter Worker tokens, R2 metadata, or Worker storage.
- Set creation requires the atomic room-quota Durable Object. It reserves every
  record in one state mutation or reserves none.
- One set creation consumes one existing IP/room upload rate-limit event.
  Per-record URL refreshes do not consume additional KV events.
- All JSON request bodies use exact keys. Unknown keys, wrong primitive types,
  inconsistent geometry, expired authority, and identity mismatches fail
  closed.

## Public endpoints

### `POST /v2/sets` and `POST /v2/sets/idempotent`

Requires the same allowed Origin and `remote-share` capability as V1
`POST /session`.

When `GET /security-config` advertises
`"recordSetCreateIdempotency": true`, the publisher sends one UUIDv4 in
`X-MXQR-Idempotency-Key` for the lifetime of that logical publication and uses
`POST /v2/sets/idempotent`. The dedicated path is a rollback fence: a prior
Worker can neither ignore the header nor accidentally create two sets after a
cached client retries. `POST /v2/sets` accepts only legacy unkeyed,
single-attempt creation. The header is deliberately separate from the exact
JSON body and never enters the public descriptor or signed set-token schema.
Dedicated per-rate-key Durable Object instances serialize IP/room rate
admission, and the room Durable Object serializes allocation:

- the first key/body pair atomically fixes one allocation and all of its quota;
- the same key and canonical body replays that allocation without consuming
  quota or rate admission again;
- the same key with a different canonical body fails with HTTP 409;
- a revoked or cancelled key remains fenced and returns HTTP 410 rather than
  creating a successor allocation.

Capability verification still runs on every attempt. A refreshed capability
after HTTP 401 therefore reuses the same idempotency key and request body.
Clients which do not send the header retain the legacy single-attempt contract.

Exact request:

```json
{
  "roomId": "123456",
  "sessionId": "file-playback-session-id",
  "queueItemId": "10000000-0000-4000-8000-000000000001",
  "sourceIdentity": "immutable-source-identity",
  "name": "track.flac",
  "mime": "audio/flac",
  "size": 8388612,
  "recordSize": 8388608,
  "recordCount": 2
}
```

`sessionId` and `sourceIdentity` are trimmed, control-free identifiers of at
most 256 UTF-16 code units. `queueItemId` is UUIDv4. `name` is non-empty and at
most 512 code units. `mime` is a canonical type/subtype string of at most 128
code units.

Success returns:

```json
{
  "v": 2,
  "setId": "server-issued-uuid-v4",
  "recordSize": 8388608,
  "recordCount": 2,
  "expiresAt": 1780000000000,
  "setToken": "signed-set-authority",
  "cleanupToken": "uuid-v4",
  "records": [
    {
      "index": 0,
      "objectId": "deterministic-uuid-v8",
      "plaintextSize": 8388608,
      "encryptedSize": 8388624,
      "downloadUrl": "https://share.musixquare.com/download/123456/object-id"
    }
  ]
}
```

The HMAC `setToken` binds the room, set, playback session, queue occurrence,
source identity, presentation metadata, complete geometry, cleanup identity,
issuance time, and fixed object expiry. It is publisher-private and must not be
placed in playback offers.

Each record object ID is UUIDv8 derived from the first 128 bits of:

```text
SHA-256("MXQR\0R2-RECORD-OBJECT\0" + setId + "\0" + decimalRecordIndex)
```

The RFC UUID version and variant bits are set after hashing. The ID is an
identity, not a secret.

### `POST /v2/sets/{roomId}/{setId}/records/{index}/upload`

Exact request:

```json
{ "setToken": "signed-set-authority" }
```

The Worker verifies the token and the live, non-revoked Durable Object
reservation both before and after signing. It then returns the deterministic
record identity, exact plaintext/ciphertext lengths, a bounded presigned PUT
URL, required `uploadHeaders`, fixed set expiry, and existing `/download` URL.

The browser must upload the exact immutable ciphertext lease with every
returned header. `content-length` is signed by the Worker but omitted from
`uploadHeaders` because browsers set it themselves.

Refreshing this endpoint may return a new URL only for the same
set/index/length/metadata. It never creates another quota reservation.

### `POST /v2/sets/{roomId}/{setId}/records/{index}/complete`

Exact request:

```json
{ "setToken": "signed-set-authority" }
```

R2 HEAD must exactly match the signed room/set/object, record and total
geometry, queue item, expiry, cleanup token, presentation metadata, and
SHA-256 hashes of session/source identities. A mismatch deletes the physical
record while retaining its charged reservation.

Success includes `readyRecordCount`, which is the contiguous completed prefix
starting at record zero, and `complete`, which becomes true only when every
record is completed. Completion is idempotent.

The beta publisher may offer a descriptor as soon as record zero is durably
completed. Remaining records continue uploading serially in publisher-owned
background work. Once exposed, a tail upload receives a longer abort-aware
bounded retry budget (ten upload attempts with exponential client backoff,
excluding the network operation's own timeout). A guest that seeks into an
ahead record which is not visible yet treats `404`, `409`, `503`, network, and
stall failures as transient for up to three minutes; the read remains
caller-abortable throughout.

If an exposed tail still fails permanently, the publisher removes that set
from future offers and a later offer creates a fresh set. It does not revoke
the old set merely because its tail failed or its upload was superseded:
already-issued readers retain the exact descriptor until its fixed expiry.
Explicit queue removal or room close deletes it immediately and retains failed
cleanup authority for retry. This is bounded damage containment, not live
repair: an existing reader that reaches a permanently missing tail record can
still fail after its wait budget because this protocol does not hot-rebind an
open source to a new set.

### `GET /download/{roomId}/{recordObjectId}`

The existing endpoint serves a V2 record as one `application/octet-stream`
response with `cache-control: no-store`. In addition to the V1 size checks, a
V2 object must have valid set geometry and the exact deterministic UUIDv8 for
its set/index.

### `DELETE /v2/sets/{roomId}/{setId}`

Requires `x-mxqr-cleanup-token`. No request body is used.

The Durable Object atomically marks every reservation in the set with
`revokedAt`, after which no new upload URL or completion can succeed. Existing
physical records are deleted best-effort. A presigned PUT issued before
revocation may have started without having finished, so quota remains charged
until the immutable object expiry rather than relying on an unproven provider
completion bound. At expiry the media is no longer downloadable and the
charged reservation becomes a non-charging expiry tombstone. Natural expiry
uses the same tombstone even when the set was never revoked. The alarm continues
deleting each exact old-incarnation key at fixed intervals; observing a late
object resets a one-hour quiet interval. Failed sweeps retain state and retry.
The quiet interval is an operational cleanup policy, not an assertion that
every pre-expiry PUT has completed. Prefix audits and the R2 lifecycle rule
remain the final backstops.

Missing and unauthorized set cleanup returns the same non-enumerating
`{"ok":true}` shape without mutation.

### `POST /v2/sets/intents/cancel`

This capability-protected endpoint uses the exact create JSON body and the same
`X-MXQR-Idempotency-Key`. It exists for owner cancellation before a create
response yielded the ordinary cleanup token. Cancellation is idempotent:
cancel-before-create installs a non-charging exact-incarnation fence, while
cancel-after-create atomically revokes the winning allocation and deletes its
exact physical record keys before acknowledging success. A later create with
that key cannot resurrect the allocation while its fixed-expiry/quiet-period
fence is retained. Publisher queue removal and room close retain and retry this
authority until cancellation is acknowledged. Create and cancel share the same
atomic rate marker, so either arrival order consumes one logical admission
without allowing cancel-only tombstone spam to bypass the configured limits.

## Quota state and rollback

The Durable Object state remains version 1. Each V2 record is one ordinary V1
reservation at `room/{roomId}/{recordObjectId}` with optional `setId`,
`recordIndex`, `recordCount`, `revokedAt`, and hashed create-intent metadata.
Raw idempotency keys are never persisted. After any fixed expiry, internal
`tombstoneQuietSince` and `tombstoneNextSweepAt` fields retain the exact-key
late-arrival fence for one quiet hour. These fields cannot be supplied by
public quota requests. Previous Workers ignore those additive fields while
continuing to account, expire, and sweep the object.

The state stores only the winning `iat` and nonce needed to reconstruct an
exact token payload from a fingerprint-matching retry; it does not duplicate
the full request strings. New admission also stops at a 1.5 MB serialized-state
ceiling, below the Durable Object single-value limit. Revocation, release,
expiry, and sweep operations remain available above that admission ceiling so
cleanup can always reduce state.

V2 keyed admission is a single serialized state write. An ambiguous
acknowledgement never releases the winning reservation: the exact-key retry
recovers it. This avoids one timed-out request deleting authority already
returned to a concurrent replay. Legacy unkeyed creation keeps its pre-exposure
batch-release behavior.

A rollback Worker may still expose legacy `/v2/sets`, but it does not expose
`/v2/sets/idempotent`. A client which cached the new feature therefore fails
closed with 404 instead of letting the old exact-body handler ignore its key.
Already-issued direct PUTs and `/download` remain compatible with the flat
object path and V1 metadata subset.

## Operations

- Apply `cloudflare/r2-cors.remote-share.json` before enabling the client. It
  contains every signed V2 `x-amz-meta-*` upload header.
- Extend the remote-share WAF session-creation burst rule to cover
  `POST /v2/sets` and `POST /v2/sets/idempotent` as well as `POST /session`.
  Per-record endpoints remain HMAC-set-authority and Durable-Object guarded.
- Deploy the Worker before the app. A client must treat V2 `404`, `503`, or
  capability failure during negotiation as a pre-run V1 fallback, never as a
  mid-run transport swap.
- Keep V1 `OBJECT_TTL_SECONDS` at 1 hour, V2
  `RECORD_SET_TTL_SECONDS` at 6 hours, and the 1-day `room/` lifecycle
  backstop. Future offers rotate to a fresh immutable set with 60 seconds
  remaining. The six-hour beta window intentionally covers one-hour-plus
  tracks and ordinary long pauses; an already-open source paused beyond that
  fixed window still requires a fresh playback offer rather than unsafe
  in-place secret rebinding.
- First-record readiness is intentionally not whole-file upload readiness.
  Monitor tail upload terminal failures and guest three-minute ahead-record
  wait exhaustion separately. Repeated failures indicate that playback-level
  reoffer/rebind recovery is needed; the current beta must not be described as
  seamlessly repairing an already-open reader after a permanent tail failure.
