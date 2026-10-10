# PRO public-room admission protection — 2026-10-11

Status: implemented and verified locally on branch
`agent/pro-room-admission-protection`. Not merged or deployed; production
remains `8.8.0` / `v646` at `6e59d96c` ([release record](../release-record.md)).

## Scope

Public PRO rooms (no entry PIN, shipped 2026-10-10 in
[8.8.0](pro-optional-entry-password-2026-10-10.md)) admit anyone who has the
room code. Before this change:

- The owner had no reserved seat. With 100 non-owner presences, every owner
  path (fresh session, cookie resume, recovery, transfer reconcile) returned
  `ROOM_FULL`, and every owner remedy (kick, PIN change) needs live presence.
- Session-create receipts shared the 256-entry participant ledger with
  playback, queue, and media receipts. About 256 unauthenticated join-and-leave
  cycles froze owner control, and new joins, with
  `ROOM_STATE_CAPACITY_EXCEEDED` for up to 10 minutes.
- Presence-close receipts lived in the same ledger. One admitted member could
  repeat the pagehide presence close and resume about 256 times and freeze
  owner control the same way for up to 24 hours, and a PIN change did not
  release the receipts. Found during the review rounds; see Verification.
- Nothing limited successful admissions in any room, and a refused `ROOM_FULL`
  join could still evict a dormant session or change account and display state.

The change is confined to `cloudflare/pro-room-worker.ts`:

- **Owner seat.** At most 99 non-owner presences and at most 100 in total,
  enforced in `joinPresence`, which every admission route uses. Session
  creation decides `ROOM_FULL` before it touches any receipt, account member,
  owner link, display number, or session record. The check runs on entry
  only, so an owner session demoted in place (for example by an account
  detach) can still leave the owner facing `ROOM_FULL`.
- **Dedicated session-create ledger.** `sessionCreateIdempotency`, 256 entries,
  10-minute receipts. Non-owner admissions fail closed at 240; the last 16
  slots are for proven owner admissions. Enabling or rotating a PIN purges
  every session-create receipt, including legacy ones in the shared ledger.
- **Dedicated presence-close ledger.** `presenceCloseIdempotency`, at most one
  receipt per stored session (128), 24-hour receipts. A close keeps only its
  session's latest receipt, and prune releases a receipt once its session no
  longer exists. Ordinary members therefore write nothing to the participant
  ledger that owner playback, queue, and media control use. Receipts that
  8.8.0 wrote to that shared ledger are released when the room loads.
- **Soft admission throttle.** 200 successful non-owner session creations per
  10 minutes, per room and per client IPv4 address or IPv6 /64, in Durable
  Object memory only. It resets on every authentication-epoch change, fails
  open at 1,024 buckets, skips proven owners, replays, and recovery, and counts
  an admission only after its commit succeeds.

Current design: [PRO architecture](pro-room-architecture-and-operations.md)
(admission bullets and "Persistent state and sleep"). Remaining accepted risk:
[known-accepted #11](../known-accepted.md#11-public-pro-room-seat-holding-and-join-floods).

## Contracts and compatibility

- `POST /v1/rooms/{code}/sessions`:
  - New `RATE_LIMITED` 429 with `Retry-After` (1–600 seconds) for a fresh
    non-owner admission over its address budget. It is checked after the
    replay and recovery branches and before PIN verification, so an
    outcome-unknown retry never sees it and a throttled client spends no PIN
    failures.
  - `ROOM_FULL` 409 now also applies at 99 non-owner presences while no owner
    presence is live. In a full room it takes precedence over
    `ACCOUNT_MEMBER_CAPACITY_EXCEEDED` and `ROOM_STATE_CAPACITY_EXCEEDED`; all
    three are 409 and final for the client.
  - Non-owner admission fails closed with `ROOM_STATE_CAPACITY_EXCEEDED` at 240
    unexpired session-create receipts (formerly 256 shared with other
    receipts).
  - A PIN change purges the admission receipts, so a revoked client's replay
    of its admission request reaches the PIN check instead of getting
    `SESSION_REPLAY_UNAVAILABLE`. After a PIN is first enabled, the replay
    carries no PIN and gets `PIN_REQUIRED`. After a rotation, it carries the
    old PIN and gets `PIN_INVALID`, which records one PIN-failure hit for its
    address.
- `POST /presence/enter`: a non-owner resume is refused with `ROOM_FULL` at 99
  non-owner presences while the owner is absent.
- `POST /presence/close`: a late retry of a session's earlier close (not its
  latest) now gets `PRESENCE_IDENTITY_MISMATCH` 409 instead of a replayed 200,
  and so does a retry of a close whose 8.8.0 receipt was released at rollout.
  Neither changes state: a receipt exists only for a close that removed its
  presence incarnation, and every resume gets a new incarnation. The App sends
  this request once per leave, as a keepalive on a non-persisted `pagehide`
  and at the start of an explicit leave. It never retries it and ignores a 409
  on both paths.
- Front door: the internal `x-mxqr-pro-admission-key` header is always removed
  from the incoming request and set only for session creation, as an HMAC of
  the address prefix with the existing rate-limit secret.
- Persisted core gains two additive fields, each initialized to `{}` when
  absent, bounded, alarmed, and pruned: `sessionCreateIdempotency` (256) and
  `presenceCloseIdempotency` (128). Legacy session-create receipts in the
  shared ledger are read until they expire, not migrated. Legacy
  presence-close receipts there are released on load.
- No App, signaling, D1, secret, binding, Durable Object migration, or R2
  change. No contract marker, SemVer, or service-worker cache change. Release
  target `pro-room`, with the partial-release provenance proof.

## Recovery

Rolling the PRO Worker back below this change keeps both new core fields but
stops reading, pruning, and alarming them until the Worker is rolled forward:
at most 256 session-create receipts (about 108 KiB) and 128 presence-close
receipts (about 52 KiB). The owner seat, throttle, and dedicated ledgers stop
applying, and 8.8.0 writes presence-close receipts to the shared ledger again,
so the presence-close freeze is possible again during the rollback. Rolling
forward releases those shared receipts on load. An admission retry inside the
10-minute window converges through deterministic recovery while its session
exists and is a new admission otherwise. A close retry whose receipt the
other Worker does not read gets the state-free 409. No marker or floor is
needed; the current floor in the [release record](../release-record.md) is
unchanged.

## Verification

Tested code: `51e880c793d49046137216d5bc87d02c565ca6ef` on
`agent/pro-room-admission-protection`, based on main `933c6f54`. Code commits:
`baf33de9` (implementation), `5cb73bc2` (tests from the first review),
`ec850bec` (presence-close bound), `51e880c7` (dedicated presence-close
ledger, from the second review). Windows 11 local run, Node 24.13.1 /
npm 11.8.0, with the working tree equal to that commit. All runs are local;
none is an exact-main CI candidate.

| Command | Result | Time |
| ------- | ------ | ---- |
| `npm run check:pro-room-worker` | pass (module check and production-security guard) | 4 s |
| `npx vitest run src/pro-room/__tests__/pro-room-worker.test.ts src/core/__tests__/app-worker-cors.test.ts` | 2 files, 653 passed, 0 failed, 0 skipped | 30 s |
| `npx vitest run` on the six other test files that load the PRO Worker source¹ | 6 files, 190 passed, 0 failed, 1 skipped² | 19 s |
| `npm run typecheck` | pass | 52 s |
| `npm run guard:source-complexity` | pass; `pro-room-worker.ts` 15,637 of 20,000 lines | 1 s |
| `npm run guard:room-authority-boundaries` | pass | 2 s |
| `npm run lint` | pass, zero warnings | 59 s |
| `npm run format:check` | pass | 24 s |
| `npm run test:coverage:workers` | 28 files, 1,857 passed; all thresholds met | 34 s |

¹ `service-control`, `youtube-occurrence-manifest`, `source-complexity-guard`,
`release-deployment-state`, `policy-accordion`, and `ci-quality-gates`.
² The `release-deployment-state` shell-plan contract test skips when `jq` is
not installed; it was not installed on this machine. It does not exercise
this change.

Worker coverage for `cloudflare/pro-room-worker.ts` is 85.46% statements,
81.20% branches, 95.24% functions, and 89.77% lines (thresholds 83 / 78 /
94 / 88).

Test counts per round, in the same two-file run and the coverage run:
`baf33de9` 643 and 1,847; `ec850bec` 646 and 1,850; `51e880c7` 653 and 1,857
(seven new tests, one rewritten, and one extended). Times are wall-clock
seconds per command.

The first review of `baf33de9` (4 findings) led to these changes:

- The branch had no dated report, documentation-hub entry, or release-record
  update for a runtime change. This report, its hub entry, and the
  [release record](../release-record.md) open items and recovery note were
  added.
- The legacy-receipt half of the PIN purge had no test. A new test fills the
  shared ledger with legacy session-create receipts, shows owner queue control
  refused, enables the PIN, and shows the shared ledger cleared and owner queue
  and playback control working at once.
- Counting an admission only after its commit had no test. A new test makes the
  storage commit fail and requires the bucket to stay empty, then requires
  exactly one count after the committed retry. The existing in-memory receipt
  convergence test now also asserts that the failed commit and its replayed
  retry count nothing.
- The owner-availability wording promised more than the code keeps. The
  reservations cover places and receipt slots, not the shared 1.2 MiB core
  byte budget. The architecture document, known-accepted #11, and the constant
  comment now say so.
- Checking that wording found the presence-close loop. A temporary probe
  against the `baf33de9` Worker reproduced it: one public session made 260
  close and resume cycles, the shared ledger reached 256 entries, later closes
  were refused with 409, and an owner queue replace returned
  `ROOM_STATE_CAPACITY_EXCEEDED`. `ec850bec` kept one receipt per session in
  the shared ledger.

The second review of `ec850bec` and `4712738e` (6 findings) led to `51e880c7`
and this revision:

- One receipt per session still let members hold up to 127 shared slots. The
  reviewer's probe made 199 join-and-close cycles from one address (under the
  throttle): 127 member receipts stayed, and the owner managed 129 queue
  mutations before the 130th and an owner playback command returned
  `ROOM_STATE_CAPACITY_EXCEEDED`. With `51e880c7` the same probe leaves no
  member receipt in the shared ledger, the owner completes 256 queue mutations
  (the whole ledger), and a commit failure during a close still restores the
  session's previous receipt. New tests pin the full owner budget after the
  churn and a member close that still succeeds once the owner's ledger is
  spent; release of 256 legacy shared receipts on restart, with the state-free
  409 retry; the leave/resume loop, latest-close replay, earlier-close 409, and
  release after the session leaves; a rollback round trip; a full-ledger skip;
  24-hour expiry while the session lives; alarm scheduling; and the byte size
  of a full close ledger.
- A temporary probe ran the real 8.8.0 Worker source (`6e59d96c`) on the same
  storage as this change. Two members had closed under the new Worker. The
  8.8.0 Worker left `presenceCloseIdempotency` unchanged, refused a retry of
  one of those closes with 409 (it does not read the new ledger), wrote a
  further close of member A to the shared ledger, and served an owner queue
  change. Rolled forward, the new Worker released that shared receipt,
  refused its retry with the state-free 409, kept both receipts in the new
  ledger (both sessions still existed), replayed member B's close with 200,
  and served an owner queue change.
- The byte statements counted only session-create receipts. A temporary probe
  filled public rooms to 100 presences. With anonymous members (128 sessions),
  session records took about 51 KiB and presence records about 43 KiB. With
  account-linked members using 20-character Hangul nicknames, the
  account-member limit kept the room at 100 sessions, which took about 53 KiB,
  beside 52 KiB of presence and 34 KiB of account member records. With
  session-create receipts (about 101 KiB at 240) and a full close ledger
  (about 52 KiB), both at the longest accepted keys, public traffic can
  occupy roughly 250 to 300 KiB of the 1.2 MiB core. The architecture
  document and known-accepted #11 now give this breakdown.
- The presence-close description now says the App sends the close once per
  leave on both the `pagehide` and the explicit-leave path, and ignores a 409
  on both.
- The PIN-replay contract now states both outcomes, and a new test pins the
  rotation case (`PIN_INVALID`, one PIN-failure hit).
- The ledger-retention paragraph and the handler comment now note that only a
  session's latest close receipt is kept, and "always" is qualified for an
  owner session demoted in place.

Each new test was checked against a temporary mutation of the Worker, restored
before the runs above. First round: removing the legacy purge loop, recording
the admission before `persist()`, removing the per-session close release, and
removing the orphan release in prune. Second round: not releasing legacy
shared receipts on load, writing close receipts to the shared ledger, not
releasing the session's earlier receipt, not releasing orphans or expired
receipts in prune, dropping the alarm candidate, throwing instead of skipping
when the ledger is full, and not purging admission receipts on a PIN change.
Every mutation failed at least one targeted test.

## Limits and open items

- Unit tests drive the Durable Object and the PRO front door directly with
  synthetic headers and fake storage. There was no Cloudflare deployment, live
  room, real device, or multi-network client test. Address-prefix keys were
  derived from synthetic `cf-connecting-ip` values; the App facade's
  forwarding of that header is covered by its existing test. The 8.8.0
  rollback probe ran its source in the same test harness, not a deployed
  rollback.
- The App still shows its generic PRO connection failure for `ROOM_FULL` and
  `RATE_LIMITED`, without the `Retry-After` time, and the existing
  `network.session_full_detail` copy (a maximum of 100 connected devices,
  including the host) does not match a refusal at 99 non-owners while the owner
  is absent. That needs an App release (target
  `all`, SemVer patch, cache advance). Open in the
  [release record](../release-record.md).
- After a `pro-room` release, confirm in a real public room that ordinary
  joins, rejoins, and returns after a tab close see neither `RATE_LIMITED` nor
  `ROOM_FULL`, and that the Worker logs show no unusual rise in either. The
  throttle counters live only in Durable Object memory and cannot be read in
  production. Open in the [release record](../release-record.md).
- What stays accepted (one network holding 99 places, distributed join floods,
  the shared byte budget) is in
  [known-accepted #11](../known-accepted.md#11-public-pro-room-seat-holding-and-join-floods).
