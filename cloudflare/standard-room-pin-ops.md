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
