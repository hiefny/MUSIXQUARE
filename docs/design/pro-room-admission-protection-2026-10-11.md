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
- One admitted member could repeat the pagehide presence close and resume about
  256 times and fill the same ledger with 24-hour receipts. A PIN change did
  not release them. Found during this review round; see Verification.
- Nothing limited successful admissions in any room, and a refused `ROOM_FULL`
  join could still evict a dormant session or change account and display state.

The change is confined to `cloudflare/pro-room-worker.ts`:

- **Owner seat.** At most 99 non-owner presences and at most 100 in total,
  enforced in `joinPresence`, which every admission route uses. Session
  creation decides `ROOM_FULL` before it touches any receipt, account member,
  owner link, display number, or session record.
- **Dedicated session-create ledger.** `sessionCreateIdempotency`, 256 entries,
  10-minute receipts. Non-owner admissions fail closed at 240; the last 16
  slots are for proven owner admissions. Enabling or rotating a PIN purges
  every session-create receipt, including legacy ones in the shared ledger.
- **Presence-close receipt bound.** A session keeps only its latest
  presence-close receipt, and prune releases the receipt of any session that no
  longer exists. Members hold at most one participant-ledger slot per live
  session.
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
  - After a PIN enable or rotation, a revoked client's replay of its admission
    request gets `PIN_REQUIRED` (its receipt was purged) instead of
    `SESSION_REPLAY_UNAVAILABLE`.
- `POST /presence/enter`: a non-owner resume is refused with `ROOM_FULL` at 99
  non-owner presences while the owner is absent.
- `POST /presence/close`: a late retry of a session's earlier close (not its
  latest) now gets `PRESENCE_IDENTITY_MISMATCH` 409 instead of a replayed 200.
  Neither changes state. The App sends this request once, as a keepalive on
  `pagehide`, and does not retry it.
- Front door: the internal `x-mxqr-pro-admission-key` header is always removed
  from the incoming request and set only for session creation, as an HMAC of
  the address prefix with the existing rate-limit secret.
- Persisted core gains the additive `sessionCreateIdempotency` field,
  initialized to `{}` when absent, bounded at 256, alarmed, and pruned. Legacy
  session-create receipts in the shared ledger are read until they expire, not
  migrated.
- No App, signaling, D1, secret, binding, Durable Object migration, or R2
  change. No contract marker, SemVer, or service-worker cache change. Release
  target `pro-room`, with the partial-release provenance proof.

## Recovery

Rolling the PRO Worker back below this change keeps `sessionCreateIdempotency`
in the core but stops reading, pruning, and alarming it (at most 256 receipts,
about 108 KiB) until the Worker is rolled forward. The owner seat, throttle,
and presence-close bound stop applying. An admission retry inside the 10-minute
window converges through deterministic recovery while its session exists and
is a new admission otherwise. No marker or floor is needed; the current floor
in the [release record](../release-record.md) is unchanged.

## Verification

Tested code: `ec850bec450cab4175c6b1aa82f88110fde00b9d` on
`agent/pro-room-admission-protection`, based on main `933c6f54`. Code commits:
`baf33de9` (implementation), `5cb73bc2` (tests from the first review),
`ec850bec` (presence-close bound). Windows 11 local run, Node 24.13.1 /
npm 11.8.0, with the working tree equal to that commit. All runs are local;
none is an exact-main CI candidate.

| Command | Result | Time |
| ------- | ------ | ---- |
| `npm run check:pro-room-worker` | pass (module check and production-security guard) | 5 s |
| `npx vitest run src/pro-room/__tests__/pro-room-worker.test.ts src/core/__tests__/app-worker-cors.test.ts` | 2 files, 646 passed, 0 failed, 0 skipped | 29 s |
| `npx vitest run` on the six other test files that load the PRO Worker source¹ | 6 files, 190 passed, 0 failed, 1 skipped² | 18 s |
| `npm run typecheck` | pass | 56 s |
| `npm run guard:source-complexity` | pass; `pro-room-worker.ts` 15,568 of 20,000 lines | 1 s |
| `npm run guard:room-authority-boundaries` | pass | 2 s |
| `npm run lint` | pass, zero warnings | 79 s |
| `npm run format:check` | pass | 25 s |
| `npm run test:coverage:workers` | 28 files, 1,850 passed; all thresholds met | 35 s |

¹ `service-control`, `youtube-occurrence-manifest`, `source-complexity-guard`,
`release-deployment-state`, `policy-accordion`, and `ci-quality-gates`.
² The `release-deployment-state` shell-plan contract test skips when `jq` is
not installed; it was not installed on this machine. It does not exercise
this change.

Worker coverage for `cloudflare/pro-room-worker.ts` is 85.40% statements,
81.10% branches, 95.26% functions, and 89.72% lines (thresholds 83 / 78 /
94 / 88). The legacy-receipt deletion in the PIN purge, uncovered at
`baf33de9`, now runs 256 times in the suite.

At the first review, `baf33de9` had recorded 643 passing tests in the same
two-file run and 1,847 in the coverage run. The difference is the three tests
added below. Times are wall-clock seconds per command.

The first review of `baf33de9` (4 findings) led to this round:

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
  comment now say so and give the flood's byte cost (about 101 KiB for 240
  receipts at the maximum request-ID length).
- Checking that wording found the presence-close loop above. A temporary probe
  against the `baf33de9` Worker reproduced it: one public session made 260
  close and resume cycles, the shared ledger reached 256 entries, later closes
  were refused with 409, and an owner queue replace returned
  `ROOM_STATE_CAPACITY_EXCEEDED`. With `ec850bec` the same loop leaves one
  receipt and owner queue control works.

Each new test was checked against a temporary mutation of the Worker, restored
before the runs above: removing the legacy purge loop, recording the
admission before `persist()`, removing the per-session close release, and
removing the orphan release in prune. Each mutation failed its targeted test
(the second failed both throttle-commit tests).

## Limits and open items

- Unit tests drive the Durable Object and the PRO front door directly with
  synthetic headers and fake storage. There was no Cloudflare deployment, live
  room, real device, or multi-network client test. Address-prefix keys were
  derived from synthetic `cf-connecting-ip` values; the App facade's
  forwarding of that header is covered by its existing test.
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
