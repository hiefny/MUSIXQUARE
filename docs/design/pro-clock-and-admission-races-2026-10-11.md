# PRO clock wait and concurrent admission — 2026-10-11

## Scope and owner decision

The owner authorized both repairs after the event, then explicitly withheld
**all production deployment** on 2026-10-11. This work must not run Production
Release, a local deployment, or a rollback. Production remains at the release
record's deployed SHA until new owner authorization.

The review baseline was main `a740d8627f70b3fed2cace3b9251445eb33faa57`.
The relevant clock/admission sources match deployed
`d76b1432c6431e4d848fe0826c9782e6296fc4d6`; main additionally contains the
unreleased PRO PIN two-step UI from #293. The repairs target App 8.9.2 / cache
v653 and signaling. There are no schema, secret, binding, protocol, capacity,
or rate-limit changes and no new recovery floor. A later combined release must
re-evaluate scope against the then-current live SHAs (the current workflow
requires `all` for App plus signaling runtime changes).

## 1. Fresh clock requests failed before their caller's timeout

The Windows flight recorder showed a running audio context and connected PRO
bridge, with a general clock sample at RTT 334 ms / offset +817 ms. A later
fresh-calibration attempt reset the best RTT, but never established a READY
calibration. No user names, room identifiers, or raw recorder are committed.

`ServerProRoomNetworkBridge` closed a round after 220 ms even with no responses,
resolved callers false, and removed the outstanding request IDs. Thus a valid
334 ms reply could never satisfy manual reconciliation's 1,000 ms budget.
This affects slow routes on any OS; normal playback and connectivity can
continue while the Sync button reports not ready.

The 220 ms timer now ends **sample selection only when a sample exists**.
Two early samples still finish immediately using the lowest RTT. With no
sample at 220 ms, the first subsequent reply may finish within the surviving
callers' own budgets. Individual server deadlines, cancellation, disconnect,
socket generation, and the maximum bounded wait remain enforced. No global
timeout was inflated.

Eleven new tracked regressions exercise actual playback-controller
reconciliation for YouTube and PRO R2 files; 221/334/900 ms clock replies;
fresh-cache reuse; no response, retry and stale replies; short versus long
budgets; partial and final cancellation; disconnect; and differing server
deadlines. The existing fast-response and short-PREPARE cases remain.

## 2. Another arrival invalidated a still-current participant's ticket

Initial signaling admission rejected a ticket whenever its room-wide
`presenceRevision` was older than the latest presence snapshot. A can receive
a valid signed ticket, B can join and advance that revision, and A's WebSocket
can then be refused with `PRO_SIGNALING_PRESENCE_STALE` even though A's exact
incarnation is still in the authoritative active set.

Read-only probes using the actual PRO session/ticket issuer and signaling DO
reproduced this ordering. Refreshing A's ticket, without replacing A's session,
admitted it. A deliberately staged 30-arrival sequence rejected 29 older
tickets and accepted the last one before the repair. This is a controlled
interleaving, not an estimate of the event's real-world failure rate.

The repair aligns initial admission with existing connected-socket and
hibernation checks: old or equal presence revisions require the exact signed
incarnation to remain active; the existing future-revision rule is unchanged.
Removed or replaced incarnations remain invalid. Signed room/generation/epoch,
expiry, ticket sequence, single-use JTI and capacity checks remain intact.

The stale-revision guard predates the recent optional-password work: blame
identifies `d4b208cc4` (2026-07-20 KST). Without incident logs, this reproducible
defect cannot be declared the proven cause of that specific event.

## Admission limits checked separately

- PRO WebSocket opens: 120 valid-ticket attempts per exact client IP and room
  generation per fixed minute. Retrying can consume the same bucket.
- New non-owner sessions: 200 committed creations per room/address key per
  10 minutes (IPv4 address or IPv6 /64).
- Wrong PIN: 10 failures per address/room per hour; irrelevant to public entry.
- Capacity: 100 present devices, with the existing owner-seat reservation.

Thirty simultaneous session creations from one address key all passed in the
local probe. The actual signaling front door and service-control limiter
allowed 120 attempts, refused the 121st with 429, still refused at 59.999 s,
and allowed the next minute; another IP or room used another bucket. A normal
initial join opens one WebSocket, not four. Thirty arrivals alone do not prove
rate limiting. A failed browser WebSocket handshake can hide the HTTP reason
behind generic join failure.

The existing `pro_ticket_stale_presence` minute metric could corroborate the
revision race, but is not room-specific. Actual event logs and external WAF
configuration were not inspected. No customer room was joined or changed.

## Separate end-of-track observation

The owner confirmed that the earlier room-wide end-of-track stall occurred
when the controlling device went to the background/slept. The current server
timeline relies on an authorized online browser's ENDED report. Neither the
clock fix nor admission fix changes that architecture. The previously
reproduced unauthorized-member warning loop is not claimed fixed here.

## Verification

Tested product tree: `fd35ec75cf63e0a94f1f490b8e03f11d47a0bcd0`
(clock commit `02e847df`, admission commit `fd35ec75`). Documentation commits
after that point do not change the tested runtime. Environment: Windows,
Node 24.20.0, Vitest 5.0.3. jq 1.8.2 was installed from the official release
through WinGet at the owner's request; the installer verified its hash and
updated the user PATH. This removes the previous local-only skip for the
release-recovery inventory classifier. Existing parent processes must inherit
the new PATH or set `MXQR_TEST_JQ_PATH`; this run imported the updated user PATH.

| Check | Result |
| --- | --- |
| Final full local unit suite | 536 files, **11,371 passed / 0 failed / 0 skipped**, 178.17 s on `fd35ec75` with jq available. This replaces the earlier clock-only full run (11,365 passed / 1 missing-jq skip); counts are not added together. |
| Final full typecheck | `npm run typecheck` passes, including Worker-generated types, tests, browser runtimes and tooling. |
| Lint/format | Full lint and format baseline passed for the clock repair; scoped app-test ESLint, Worker-tooling ESLint and Prettier passed again for the final admission files. |
| Worker/operations guards | App syntax, Developer API boundaries, D1 manifest and source-only operations drift checks pass. |
| Clock regression red/green | Five selected delayed-clock/reconciliation tests fail with the baseline bridge; all 41 bridge tests pass with the repair. A later combined bridge/bootstrap run passes 77/77. Filtered baseline cases are not verification skips. |
| Admission regression red/green | Four newly allowed valid-ticket cases fail with the baseline predicate; the invalid-incarnation case already passes. With the repair, all 287 signaling tests pass. |
| Independent review | Separate review of both fixes and security invariants: no actionable findings. |
| Runtime build | `npm run build:checked` passes on committed `fd35ec75`, including cache-history, production-security, asset and app-shell guards. No deployment is performed by this build. |

Earlier local attempts exposed two preparation mistakes: the file-playback
test fixture omitted required nullable YouTube fields, and the initial cache
bump omitted the `index.html` bootstrap query. Both were corrected before the
final product commit. An admission assertion initially assumed concurrent
WebSocket creation order; it now compares the participant-ID set while still
requiring every socket to be admitted and open. The failures were not hidden
by retries or relaxed admission assertions.

The read-only pre-fix investigation ran five scratch probes using actual
Worker/DO implementations (including PRO-issued signed tickets and the
service-control limiter). Its 405 copied, name-filtered cases were unexecuted,
not additional pass evidence. Tracked regressions are the lasting checks.
Untracked local logs are under `scratch/pro-clock-fix-2026-10-11/` and
`scratch/pro-join-burst-2026-10-11/`.

No browser full E2E, remote CI or exact-main release candidate was run in this
local repair round. Native devices, real acoustic synchronization, customer
traffic and Cloudflare live behavior are outside the deterministic local tests.
No push, merge, production deploy or release-history entry is part of this
owner-held local change.
