# Standard room PIN pepper operations

`MXQR_STANDARD_ROOM_PIN_PEPPER` is a dedicated HMAC key for persisted Standard
room PIN verifiers. It must be random, at least 32 characters, and distinct from
every account, PRO signaling, and Remote Share key. Put it through Wrangler's
interactive secret prompt; never place real key material in a command argument
or this repository.

The binding accepts either a plain secret or the shared versioned keyring
envelope:

```text
mxqr-keyring-v1:{"v":1,"current":{"kid":"pin-2026-b","secret":"<new-random-32+-character-secret>"},"previous":{"kid":"pin-2026-a","secret":"<old-secret>"}}
```

New rooms, PIN changes, and legacy plaintext migrations use `current`. A guest
that successfully presents the PIN for a verifier made with `previous` is
admitted only after the Worker durably rewrites that verifier with `current`.
Malformed keyrings, weak keys, missing keys, or reuse of another signaling key
fail closed.

## Rotation and retirement boundary

Deploy keyring-capable code before changing the binding. Then install a keyring
with the new key in `current` and the old key in `previous`. Keep `previous`
available while any protected room epoch created under the old key may still be
active.

There is deliberately no time-only retirement rule. Unlike a Remote Share
assertion, a room PIN verifier is durable and has no fixed TTL; its old-key HMAC
cannot be transformed without a correct PIN presentation. In particular, the
90-second Remote Share assertion rotation window does not apply here.

Remove `previous` only after one of these conditions is proven for every room
epoch that existed at cutover:

- the epoch ended and its host reclaim grace expired; or
- the host explicitly reset the PIN; or
- a correct guest PIN admission durably rewrapped the verifier with `current`.

An active host can keep an epoch alive indefinitely, so elapsed wall-clock time
alone is never evidence that retirement is safe. If complete evidence is not
available, retain `previous`. Premature removal fails closed but locks correct
PINs until the host resets them or the epoch ends.

The current verifier does not persist its key ID and the service has no global
Durable Object inventory, rewrap receipt, or bounded room-epoch lifetime.
Consequently this repository cannot presently produce the complete retirement
proof described above. Treat `previous` as non-retirable until such evidence is
implemented; do not interpret an absence of errors or a quiet metric window as
proof.

Key rollback is also a rotation, not a restoration of the old scalar value. If
rooms may already contain verifiers written by `B/current + A/previous`, revert
first to `A/current + B/previous`. Keep that reverse keyring until every B
verifier has rewrapped to A or its epoch has ended, then retire B only under the
same evidence rule. Reverting directly to A-only locks every B verifier.

## Legacy plaintext migration boundary

Migration is eager on the first load of each room object and completes before
that room admits a host or guest. It is not a global storage sweep: dormant or
orphaned v1 Durable Objects are not awakened by a Worker deployment, and their
plaintext PIN can remain at rest until their next event. Do not claim that a
deployment alone removed every legacy plaintext value. A stronger completion
claim requires an explicit room inventory plus wake/migrate verification, or a
bounded epoch recycle that forces every protected room through the new
admission boundary.

After a v2 verifier or quarantine lock is written, do not roll signaling back to
a Worker that only understands plaintext `roomPassword`. Repair forward with a
keyring-capable Worker. The release and independent recovery workflows enforce
this boundary with
`cloudflare/standard-room-pin-storage-contract-version.txt`: once the candidate
signaling deployment is live, automatic recovery retains the compatible
signaling Worker instead of restoring a captured plaintext-only version. The
app can recover independently because the new Worker keeps the legacy
post-open configuration handshake fenced until its durable write succeeds.

## Owner-chosen PINs: kept devices and the wrong-PIN limit (App 8.10.0)

From 8.10.0 the Standard-room host types the 8-digit PIN (no generator) and,
when other devices are present, chooses "그대로 두기" (keep everyone, default) or
"모두 재입장" (everyone rejoins). The signaling Worker stores the result under
two additional Durable Object keys. Room meta v2, the guest reconnect bindings,
and `standard-room-pin-storage-contract-version.txt` are unchanged, so this
adds no contract cutover and no forward floor. Both records are written only
through their exact-key normalizers in `standard-room-pin-membership.ts`, and
the PIN storage-boundary guard pins that neither ever holds PIN material.

| Key | Shape and bounds | Written | Deleted |
| --- | --- | --- | --- |
| `standard-room-pin-membership-v1` | `{v:1, roomSecretHash, verifierDigest, kept:[{peerId, secretHash}]}`, at most 99 unique peers; hashes are 43-character base64url | With the verifier, in one transaction, by a keep change. Each kept peer's reconnect-secret hash is copied from its binding (active or inside the 5-minute reconnect window), or, for a peer without a live binding, from the current record while that record still exempts it | By a later change without the choice, turning protection off, "모두 재입장", a new room epoch, and `clearRoomMeta` |
| `standard-room-pin-failures-v1` | `{v:1, entries:[{key, count, resetAt}]}`, at most 256 address-block buckets plus one shared overflow bucket (fixed key `standard-room-pin-overflow-bucket-v1-shared`), `count` 1..20 | After each wrong PIN | Expired entries are pruned on the next write; `clearRoomMeta` (room end) deletes the key. A live bucket is never evicted |

- **Kept devices.** A guest is exempt from the PIN only while the record's
  `roomSecretHash` matches the current room epoch, its `verifierDigest` matches
  the current verifier, and the guest presents the same reconnect secret whose
  hash was copied. Any other record (including one that fails normalization)
  means "no exemption". A kept guest can reconnect with its old PIN, or with no
  PIN after a first enable; error precedence and close codes are unchanged.
  This also fixes the old defect where a present guest re-sent a stale PIN on
  a signaling reconnect, got `room-password-invalid`, and lost ICE-restart
  recovery. A later keep change that lists a kept guest whose binding has
  expired (its signaling socket down for over five minutes while its data
  channel lives) carries that guest's hash over from the current record, so the
  exemption still needs the same reconnect secret and is not lost between
  changes.
- **Everyone rejoins.** While the PIN mutation fence is held, the Worker sends
  `peer-left` to the host and closes every admitted guest socket with
  `room-password-changed` (1008). The message (and close reason) is
  `ROOM_PASSWORD_ENABLED` when the room had no PIN before and
  `ROOM_PASSWORD_CHANGED` otherwise, so a guest without an open data channel
  sees the matching notice. It then commits the verifier, empty bindings
  and no record in one transaction. Guests still authenticating are not closed;
  they meet the fence (1013) and then the new verifier. After the Worker
  acknowledges, the host App sends `KICK_DEVICE` with reason `room-pin-enabled`
  or `room-pin-changed` to every connected device and closes the channels.
- **Key rotation.** The same PIN under a rotated pepper re-stamps the record's
  digest: atomically on the previous-key guest rewrap, after host-auth
  re-commits the PIN, and on a legacy echo. A failed best-effort re-stamp only
  loses the exemption (fail closed).
- **Wrong-PIN limit.** Per room and per client address block (IPv4 address,
  IPv6 /64, IPv4-mapped IPv6 as IPv4), 20 failures per fixed 10-minute window
  that starts at the first failure. The bucket key is a domain-separated HMAC
  (`MUSIXQUARE:standard-room-pin-attempt:v1`) of room and address block, keyed
  with the current `MXQR_STANDARD_ROOM_PIN_PEPPER`, so a pepper rotation resets
  the windows. The address comes from `CF-Connecting-IP` only; HTTP-bridge
  guests carry none and share one per-room `unattributed` bucket, and
  `X-Forwarded-For` is never used. A locked attempt gets
  `room-password-rate-limited` (1008) with `retryAfterSeconds` and the
  `guest_auth_rate_limited` metric ("Password lockouts" in the admin Signals
  panel, last 24 hours); attempts without a PIN are not counted, and a storage
  failure never blocks a guest. Counters are stored, so hibernation does not
  reset them.
- **Who passes a locked bucket.** Kept devices bypass the lock. So does a guest
  whose reconnect secret matches its live binding (admitted now, or within the
  5-minute reconnect window): its PIN is still checked, so a device already in
  the room keeps its signaling recovery when other people on its network (or
  other HTTP-bridge guests) exhaust the shared bucket. A wrong PIN on that path
  is counted and also deletes the binding, so one binding carries at most one
  attempt past a lock. A guest whose binding has expired is treated as new.
- **Table bound.** Live buckets are never evicted. Once 256 address blocks hold
  a live bucket, attempts from every other block are charged to the single
  overflow bucket, which has the same 20-per-window limit. A room therefore
  accepts at most 256 × 20 + 20 = 5,140 wrong PINs per window however many
  addresses an attacker rotates through. The cost is a fail-closed lockout:
  while 256 blocks hold a bucket and the overflow bucket is locked, every new
  joiner from another block gets `room-password-rate-limited` until the
  overflow window ends or a bucket expires (at most 10 minutes, renewable by a
  persistent attacker). Kept devices and guests with a live binding still pass.
  The host can turn protection off or open a new room. Someone controlling 256
  IPv6 /64s (one routed /56) can reach this with about 276 wrong PINs.

### Rollback

- No marker or floor changes. An older signaling Worker never reads either key
  and does not advertise `standardRoomPinMembershipVersion`, so the App sends
  the PIN alone: "그대로 두기" behaves as before 8.10.0 (present guests stay
  but re-send their old PIN on a signaling reconnect), and "모두 재입장" is only
  the host's `KICK_DEVICE`, which a modified client could ignore because its
  signaling socket stays admitted. The wrong-PIN limit is off while rolled
  back.
- Older Apps treat every `room-password-*` error as a permanent auth error, so
  `room-password-changed` and `room-password-rate-limited` cause no reconnect
  storm; they show the generic join error.
- A record survives a rollback untouched. Because it is tied to the room epoch
  and the verifier digest, a stale record is ignored, with one exception: if an
  older Worker changes the PIN X→Y→X within one epoch, the X digest matches
  again after the forward deploy and the old kept set is revived. Its peers
  still need their own reconnect secrets.
