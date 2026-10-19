# Isolated control PC: bounded side ICE restart

2026-10-19. One of three parallel pieces for the owner's planned combined
Standard-room release (PR #410 control isolation, delay-based receipt window,
clock protection, side-PC ICE restart). This is branch work on
`claude/side-ice-restart-1eee23`, based on `db407305` (C9 runtime `6a5afaae`,
App 8.11.22/cache v731). It is not a pull request, merge, release candidate or
deployment. No App version or cache version was changed; the integration bumps
once. No native browser harness or timed measurement was run: the combined
native round runs later, serially, and owns that evidence. If this piece is not
ready and verified when that round ends, it moves to a second release and the
network-change limitation is recorded in `known-accepted.md` instead. Update,
same day: under that pre-agreed escape hatch the integrating session moved this
piece to a second release, after its own native failure-injection check. That
check is recorded in
[side-ice-restart-native-lab-2026-10-19.md](side-ice-restart-native-lab-2026-10-19.md),
on merge `ee8dcd28` (this runtime plus current main `0ae3698d`).

Tested runtime: `05551d1da803fbfb09b9ae2288e9c6bb754344d8`
(tree `23a55c02f0a0fd96caf857a8c0345f3ad01e2db6`), four runtime commits:
`9d3df2b4` (the restart), `ed932b26` (fixes from a first independent review),
`758dffe9` (type-only correction; `ed932b26` alone fails the full type check
with TS2367) and `05551d1d` (fixes from a second review and a test-harness
correction). Intermediate commits are not separately qualified.

## Problem

PR #410 review point 1: after the fenced handoff, the separate control
RTCPeerConnection was a single point of failure. A side PC that reached `failed`,
or stayed `disconnected` for one 15-second grace, called `fail()` and terminated
the whole logical connection; the guest then reported `HOST_DISCONNECTED`, media
stopped and Reconnect hard-reloaded the page. The original PC survives the same
network change (for example Wi-Fi to LTE) through its 15-second grace and one
guest-initiated ICE restart.

## Change

A restart-capable side route now restarts ICE on the **same** side PC. ICE
restart keeps DTLS, SCTP and the open ordered side channel, so controls sent
during the outage and controls already in flight stay in the side channel's SCTP
queue and arrive once, in order, after recovery. There is no route downgrade,
replay, new PC or new lease.

### Protocol additions

All frames keep `type: 'mxqr-control-isolation'`, `version: 1`, the sender's
fresh 128-bit `nonce` and the receiver's nonce as `target`, with exact key sets
and the existing SDP (≤32 KiB) and candidate bounds. They travel only on the
authenticated ordered **original control** lane; bulk-lane copies have no
authority and private frames on the side channel still close the connection.

| Kind | Fields | Sender | Meaning |
| --- | --- | --- | --- |
| `restart-capable` | — | both, in `begin()`, before `request` and therefore before its fence | advertises the restart capability |
| `restart-request` | `epoch` ≥ 0 | side-PC answerer | “my side PC is interrupted”; `epoch` is the latest restart generation it has seen |
| `restart-offer` | `epoch` ≥ 1, `sdp` | side-PC offerer (smaller nonce) | `createOffer({ iceRestart: true })` for the next generation |
| `restart-answer` | `epoch` ≥ 1, `sdp` | side-PC answerer | answer for that exact generation |
| `restart-candidate` | `epoch` ≥ 1, `candidate` | both | trickle for that generation |

Compatibility: the C9 (#410) parser treats unknown kinds as invalid and ignores
them. A C9 peer therefore never advertises the capability, never sees a restart,
and both endpoints keep today's terminal side-failure behavior. Pre-#410 builds
never negotiate isolation at all. A late advertisement after the remote fence is
ignored.

### Ownership and bounds

- One owner per attempt: only the original side-PC offerer offers; generations
  increase by exactly one; one attempt is in flight at a time; every await
  rechecks the exact PC and attempt (answerer: the exact accepted generation).
  Stale, duplicate and out-of-sequence frames are ignored.
- The restart path applies once an endpoint has seen both fences and sent
  READY, the earliest point at which its peer can be active; a disconnect grace
  armed before that point is taken over then. Until activation, the existing
  10-second handoff deadline still bounds it; earlier failures keep the existing
  negotiation close.
- A local interruption begins when the side PC reports `disconnected` or
  `failed` and allows at most **two** restart offers. The offerer honors a
  peer's request only for its latest generation; during a local interruption a
  request spends that interruption's attempts, otherwise requests have a
  separate budget of two restarts per 15-second window. A peer's restart never
  shortens the offerer's own later outage window or spends its attempts. If the
  peer budget is spent, the requesting endpoint closes at its own deadline.
- An outage that began while an offer or answer was in flight asks for one more
  restart (within its budget) when that exchange completes, if the side PC is
  still not connected: the in-flight candidates may predate it.
- Deadline: 15 seconds (the original PC's grace). If the original route is
  itself unavailable during the interruption, the restart waits and the window
  becomes 15 seconds after the original PC reconnects; no interruption outlives
  30 seconds. Times are monotonic (`performance.now()`), so a clock correction
  after a network change cannot move them. A side PC that is not `connected` at
  the deadline uses the existing `fail()` → `terminate()` → reconnect owner. A
  side PC that is `closed`, or a side channel that closes or errors, still
  closes immediately.
- At most 16 restart offers per rolling 30 seconds: the offerer stops there,
  and an answerer offered more closes the connection rather than ignoring the
  offer, which would strand the offerer's attempt.
- “Original route ready” is the original PC `connected` with its control channel
  open; `CloudflareDataConnection` reports each original state change.
- Before gathering, both the offerer and the answerer run the owner's due RTC
  credential renewal (the `refreshRtcConfigurationIfDue()` rule of the original
  PC's restart).
- Candidate generations: new-generation local candidates are held until their
  own description is sent; initial-generation and wrong-generation candidates
  are dropped after a restart; a browser rejection of a restart candidate is not
  route failure; each generation has its own 128-candidate budget per direction.

Unchanged: PRO never creates the side PC and admission alone allocates none;
the eight-side-PC owner cap (a restart never creates a PC); RTC credential
refresh of owned side PCs; the background-resume side-route challenge (a
long-hidden resume with a failed or disconnected side PC is still stale);
fences, READY, queue bounds and mixed-route rejection; the original PC's own ICE
restart and grace.

## Verification

Environment: Windows 11 Pro 10.0.26200, pinned Node 24.20.0 / npm 12.0.2,
Vitest 5.0.3, a shared PC with two other sessions (no timed measurements). The
worktree has its own `npm ci` install: three existing suites
(`release-manifest`, `worker-bundle-dry-run`, `coverage-shard-contract`) read
`<repository>/node_modules/...` by explicit path, and the first full run at
`9d3df2b4`, which resolved packages from the parent checkout, failed them for
that reason alone.

New tests with paired fake PCs (`control-isolation.test.ts`, 24):

- side `failed` → restart offer/answer/candidates → `connected`, with controls
  held across the outage delivered in send order and none on the original route;
  same PC and lease; credential hook called once on each side;
- `disconnected` restart with a self-healed path finishing the in-flight attempt;
- restart while the original PC is also restarting: no restart signaling while
  it is down, offer after its recovery, window extended to 15 s after recovery;
  close at exactly that extended deadline; 30-second cap while it stays down;
- at most two offers per interruption, then the existing close at the deadline
  with no further frames or timers;
- answerer-only failure: one request per generation, stale requests ignored,
  two peer-requested restarts per window; a request during a local outage spends
  that outage's attempts; the offerer's own later outage still gets its full
  window and attempts; an outage that began during a peer-requested attempt
  restarts again once that attempt completes;
- a restart offered while the answerer still awaits READY completes and later
  outages stay restartable, but one that does not recover is still closed by the
  10-second handoff deadline; the offerer stops at 16 offers per 30 seconds and
  an answerer offered more closes; a two-minute wall-clock correction does not
  move deadlines;
- **real mixed version**: the current build against a frozen copy of the C9
  module (blob `e4325fb4`, three lint directives removed) keeps terminal
  `failed` and 15-second `disconnected` behavior on both endpoints;
- late callbacks after disposal during awaited credential renewal, restart
  offer and restart description; late PC events, owner notifications and frames;
- exact nonce/target/lane/role/generation and field validation; private restart
  frames on the side channel close the connection;
- candidate hold/order, dropped superseded generations, non-fatal rejection and
  the per-generation flood budget; fencing-time disconnect takeover; `closed`.

Adapter tests through the real `CloudflareDataConnection` (4): restart carried on
the original control lane with ordered application controls and no close;
restart deferred until the original PC itself reconnects; close through the
existing connection owner when the side does not recover; background-resume
challenge still terminal for a failed side PC. Signaling owner test (1): a due
RTC credential is renewed on the owned side PC before restart without a new PC.

Existing tests: two pins of the terminal side failure (`failed`/`closed`, and the
15-second non-renewing `disconnected` grace) now select the non-capable
configuration they describe, by one argument each; their assertions are
unchanged. All other existing control-isolation, adapter, signaling and ICE tests
run unmodified with the capability negotiated. The pair harness skipped
original-lane frames that an endpoint sent while receiving the other side's
frames in the same pass; one new test therefore passed or failed by random role
(it failed in the full run at `758dffe9`). Its cursors now advance per delivered
frame, as an ordered lane does. The two isolation files then passed 20
consecutive randomized runs.

Mutation check: 21 module mutants and 3 wiring mutants each fail at least one
new test. Module: restart disabled, no original-route gating, no window
extension, three attempts, fatal restart candidates, no candidate hold, deadline
ignoring the original, any offer generation, initial-generation trickle after a
restart, no advertisement, stale requests honored, unbounded peer window, no
fencing takeover, one per first-review finding, no retry after an outage during
an attempt, an offerer ignoring the offer bound, and requests during an outage
spending the peer window. Wiring: no recovery notification, original always
ready, no credential hook.

Two independent read-only reviews:

- Of `9d3df2b4`: no P1, one P2 and four P3, all fixed with pins in
  `ed932b26`: (P2) a peer-requested restart shared one interruption with a later
  outage of the offerer's own PC, which could then close after its remaining two
  seconds with no attempt left; (P3) restart frames sent while the peer still
  awaited READY were dropped, which could leave an attempt pending for the rest
  of the connection; (P3) no bound on offers an answerer accepts; (P3) the
  answerer skipped the due credential renewal; (P3) wall-clock deadlines.
- Of `ed932b26`/`758dffe9`: all five confirmed fixed, no P1/P2, four P3. Fixed
  with pins in `05551d1d`: an outage during an in-flight attempt waited for a
  later event; the offerer could exceed the answerer's bound on a flapping link.
  Pinned and documented: the 10-second handoff deadline still bounds a restart
  that begins before activation, and the offerer's and answerer's due renewals
  add up (below).

Both reviews also checked and refuted C9 incompatibility, changed non-capable
behavior, stale initial-generation candidates, timer leaks, unbounded work for
an authenticated peer and the eight-PC, PRO and background-resume invariants.

Gate results at the tested runtime (clean committed tree; only this report and
its README entry were uncommitted, and no gate reads them):

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run format:check` | pass |
| Full unit suite | **594 files / 13,393 tests: 13,393 passed, 0 failed, 0 skipped** (C9 recorded 13,364; 29 new). JSON SHA256 `a5dc970f031442bb05edb8320447fcfc1bd007e0579daa2f657fadb188d85ab8` |
| `npm run build:checked` | **refused as designed** at `guard:sw-cache-version`: committed PWA runtime changes are newer than v731 (`6a5afaae`). The twelve guards before it passed. This branch does not bump; the integration bumps once |
| The same chain without only that guard | pass: the other 23 guards, the production build (596 modules) and every post-build guard |

Earlier runs are not this evidence: the first full run at `9d3df2b4` without a
worktree install (12 environmental failures in three files, 2 skipped), and the
run at `758dffe9` that exposed the role-dependent harness defect (1 failure).

## Limits

- Fake PCs model the browser contract this relies on: ICE restart from `failed`,
  state events after a restart, and SCTP holding (not aborting) data while ICE
  is down. Real Chromium/WebKit timing, TURN reallocation, mobile radios,
  battery and an actual IP change are unverified until the native round.
- Held controls arrive late as a burst after recovery, like an original-PC ICE
  restart. Clock protection must reject the stale SYNC samples; the receipt
  window sees a receipt gap and burst.
- The original PC keeps one restart per interruption and a non-renewing
  15-second grace. An outage long enough for that grace to expire still ends the
  session through the original PC; that is not a side-restart result.
- A restart that begins before activation (after READY was sent) does not extend
  the existing 10-second handoff deadline.
- Due credential renewals run on the offerer, then on the answerer, each bounded
  by the existing 8-second request deadline, as for the original PC's
  offer/answer pair. In the worst case that exceeds the 15-second window.
- During a side-only outage the host heartbeat monitor sees the original PC
  `connected` (90-second grace), above the 30-second side cap.

## Native functional scenario

Written for the second release's own native failure-injection check; not
executed here. Use the product's
own negotiation (no study broker or synthetic events), new/new builds, a
Standard room with host and one guest, `?mxqrLog=info` on both pages, and
isolation active (complete one ordinary file first; both
`controlIsolation.phase === 'active'`, side PCs `connected`). Record per endpoint,
with timestamps: original and side PC `connectionState` transitions, the PC
object identities, private frame kinds and epochs on each lane, `conn` close
events, the guest's disconnected dialog, and console lines.

1. **Side-only failure (deterministic).** From `getStats()` take the side PC's
   selected candidate-pair ports; with the round's packet filter drop only that
   5-tuple until both side PCs report `failed`; restore. During the outage the
   host sends PAUSE then PLAY.
2. **Both PCs failed, then restored (owner scenario).** Drop all media-plane
   traffic between the endpoints (direct and relay) while keeping the signaling
   WebSocket; restore as soon as both original and side PCs report `failed`. The
   restore must fall inside the original PC's 15-second grace from its own
   `disconnected`; if Chromium reports `failed` later than that, or the original
   PC does not reconnect after restore, record it as an original-PC limit, not a
   side-restart result.
3. **Fail-closed.** Keep only the side path blocked for 20 seconds after it
   fails: exactly one logical close through the existing owner (guest
   disconnected dialog), no restart loop, and Reconnect → Start then succeeds.
4. **Mixed version.** New host with a C9 guest, and the reverse: a side failure
   closes the connection exactly as C9 does today, with no restart frames.
5. **IP change, if feasible.** On a machine with two independent interfaces
   (for example Wi-Fi plus USB Ethernet or a phone hotspot), connect on one, then
   disable it; expect both PCs to restart over the other. Two browsers on one
   machine usually share host candidates, so this needs a second device or a
   relay-only path; record it as not run otherwise.

Gates, fixed before running: for 1, 2 and 5, no `close` on either endpoint and no
disconnected dialog through 60 seconds after restore; the same original and side
PC objects before and after; at most two restart offers per interruption,
increasing epochs, all restart frames on the original control lane; side PCs
`connected` within 15 seconds after the original route is connected again;
PAUSE/PLAY delivered once, in order, after recovery and never on the original
route after the fence; the subsequent file completes with matching SHA and
cumulative receipts; the restart and recovery log lines present. For 3 and 4,
exactly one close and no restart offer in 4.
