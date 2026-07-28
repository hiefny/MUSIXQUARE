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

### `POST /v2/sets`

Requires the same allowed Origin and `remote-share` capability as V1
`POST /session`.

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

### `GET /download/{roomId}/{recordObjectId}`

The existing endpoint serves a V2 record as one `application/octet-stream`
response with `cache-control: no-store`. In addition to the V1 size checks, a
V2 object must have valid set geometry and the exact deterministic UUIDv8 for
its set/index.

### `DELETE /v2/sets/{roomId}/{setId}`

Requires `x-mxqr-cleanup-token`. No request body is used.

The Durable Object atomically marks every reservation in the set with an
optional `revokedAt` field, after which no new upload URL or completion can
succeed. Existing physical records are deleted best-effort. Reservations are
not released: a presigned PUT issued before revocation may still land, so all
bytes remain charged until the original fixed expiry. The existing alarm
removes expired late objects; the R2 lifecycle rule remains the final
backstop.

Missing and unauthorized set cleanup returns the same non-enumerating
`{"ok":true}` shape without mutation.

## Quota state and rollback

The Durable Object state remains version 1. Each V2 record is one ordinary V1
reservation at `room/{roomId}/{recordObjectId}` with optional `setId`,
`recordIndex`, `recordCount`, and `revokedAt` fields. Previous Workers ignore
those extra fields while continuing to account, expire, and sweep the object.

V2 batch admission is a single serialized state write. Ambiguous set-creation
acknowledgement invokes an atomic batch release before any PUT URL has been
exposed. If release also fails, the full reservation remains conservatively
charged until expiry.

A rollback Worker does not expose `/v2/sets`, so no new V2 authority is issued.
Already-issued direct PUTs and `/download` remain compatible with the flat
object path and V1 metadata subset.

## Operations

- Apply `cloudflare/r2-cors.remote-share.json` before enabling the client. It
  contains every signed V2 `x-amz-meta-*` upload header.
- Extend the remote-share WAF session-creation burst rule to cover
  `POST /v2/sets` as well as `POST /session`. Per-record endpoints remain
  HMAC-set-authority and Durable-Object guarded.
- Deploy the Worker before the app. A client must treat V2 `404`, `503`, or
  capability failure during negotiation as a pre-run V1 fallback, never as a
  mid-run transport swap.
- Keep the 1-hour R2 object TTL and 1-day `room/` lifecycle backstop.
