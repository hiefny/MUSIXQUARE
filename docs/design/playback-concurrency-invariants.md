# Playback Concurrency Invariants (PLAYER-SPRAWL Stage A)

> **Status**: authoritative invariant matrix for the file-playback pipeline's
> concurrency-control mechanisms. Written 2026-06-11 as Stage A of the
> PLAYER-SPRAWL plan. **Stage B landed the same day**: `loadToken` and the
> preload-activation owner seq are now ONE counter — the **load epoch**
> (`_state.ts`: `newLoadEpoch` / `getCurrentLoadEpoch` / `isCurrentLoadEpoch`;
> the legacy names `getLoadToken`/`incrementLoadToken` survived briefly as
> test-only aliases, retired 2026-06-12 when the pinned tests were renamed to
> the epoch API). Stage C deferred. Where this doc says "token (bump)", read
> "epoch (allocation)" — same counter, older name.
>
> **Executable anchors** (change those in lockstep with this doc):
>
> - Pins: `src/player/__tests__/concurrency-invariants.test.ts` (pins a–g, j),
>   `src/player/__tests__/load-epoch.test.ts` (pin h, Stage B; pin i retired
>   2026-06-12 — the alias deletion made its threat a TypeScript error;
>   pin j added 2026-06-13: finalize transfer-session snapshot)
> - Static guard: `scripts/check-lifecycle-writes.mts` (`guard:lifecycle-writes`)
> - Compact inventory: header comment in `src/player/_state.ts`
> - Related pins already in place: `busy-guard.test.ts` (SA-04 family),
>   `playback-extended.test.ts` (token arithmetic ±0/+1, lifecycle gate, SA-03),
>   `decode.test.ts` (SA-05, DV-1), `playback-remote-wait.test.ts` (DV-2),
>   `lifecycle.test.ts` (FSM table, mirrored with `playback-state-machine.md`).
>
> **Review note (2026-07-11):** all executable anchors named above still
> exist. Exact call-site counts and line-oriented inventory entries are review
> snapshots; when prose and code differ, the current guard scripts and pinned
> tests are authoritative. `playback-state-machine.md` is a historical design,
> not a second live specification. The reference to deferred “Stage C” records
> the old plan; it is not an active roadmap item.

## 1. Mechanism inventory

One logical concern — _supersession_ ("only the CURRENT load may publish side
effects") — is implemented by several mechanisms with different allocation
scopes. Stage B merged M1 and M4's owner seq into the single load epoch;
every fix touching this pipeline must still respect the matrix below.

| #   | Mechanism                                                                                                                                                                                                                                                                                    | Lives in                                                | Allocates / bumps                                                                                                                                                                                                                                                                    | Checks                                                                                                                                                                                                                                                | Clears / resets                                                                                                                          | Protects                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | load epoch (`_loadEpoch`, ex-`loadToken`; API `newLoadEpoch`/`getCurrentLoadEpoch`/`isCurrentLoadEpoch`; the legacy aliases `incrementLoadToken`/`getLoadToken` were retired 2026-06-12)                                                                                                     | `player/_state.ts`                                      | 7 prod sites (entry-point only, guard CHECK 5): `playlist.ts` `playTrack`; `playback.ts` handlePlayMsg preload-match + use-preloaded handler; `transport.ts` `stopAllMedia({cancelInFlight})` + 15s watchdog; `playlist.ts` repeat-one ended-advance; `demo/mode.ts` `loadDemoTrack` | `decode.ts` load fns (post-decode AND failure-catch entry since 2026-06-13, **optional** — only when caller passed an epoch), `_internalPlay` checkpoints + `ended` listener, decode-fail-advance timer, `playlist.ts` SA-05 post-activation re-check | never reset, monotonic                                                                                                                   | user/track-change intent: a newer _logical run_ kills older continuations                                                                                     |
| M2  | `activeLoadSessionId`                                                                                                                                                                                                                                                                        | `player/_state.ts`                                      | **self-bumped at entry** by `loadAndBroadcastFile`, `loadDemoFile`, `finalizeGuestFile` (NOT `loadPreloadedTrack`)                                                                                                                                                                   | same three fns: loader-teardown gating (`showLoader(false)` / `pausedAt` reset in `finally`) and `finalizeGuestFile`'s pre/post-decode staleness checkpoints                                                                                          | never reset, monotonic                                                                                                                   | load _invocation_: a newer invocation that did NOT bump the epoch still invalidates me                                                                        |
| M3  | `isPlayLocked` + play-owner metadata + 15s `navigator-lock-watchdog`                                                                                                                                                                                                                         | `player/_state.ts` + `transport.ts`                     | `play()` locks; watchdog armed per `play()`                                                                                                                                                                                                                                          | `play()` entry (queue/self-heal branch)                                                                                                                                                                                                               | `_internalPlay` finally (synchronous owner-scoped release), `stopAllMedia`, watchdog fire, stale-owner recovery                          | node-start mutual exclusion (short AudioContext/node critical section)                                                                                        |
| M4  | `playPreloadedInProgress` flag + preload-activation owner handle (`_activePreloadActivation` — records its owning M1 epoch; compared by handle IDENTITY, not epoch equality, so an unrelated epoch bump mid-activation cannot strand the flag and same-epoch begins cannot stomp each other) | flag in `_state.ts`, handle in `decode.ts`              | `beginPreloadActivation(epoch)` (sets flag true, takes ownership; warns when a LIVE activation already shares the epoch — stale-epoch reuse after the prior activation finished is silent, which is fine: only the overlapping case is dangerous)                                    | `handlePlayMsg` flag gate; `tryFetchDemoForRemote` idempotency; `isCurrentPreloadActivation` in the catch path                                                                                                                                        | `finishPreloadActivation` (clear-iff-current); **second writer**: `stopAllMedia`'s flag-only clear (`transport.ts`) — deliberate, see C4 | the activation window: PLAY must queue (not double-trigger) while a preload decode is in flight; a superseded activation must not clear the superseder's flag |
| M5  | lifecycle FSM (`playback.lifecycle`)                                                                                                                                                                                                                                                         | `player/lifecycle.ts` (+ sanctioned writers, see guard) | `transition()` only                                                                                                                                                                                                                                                                  | `isFilePipelineBusyForPlay()` (busy gate), `shouldSkipIncomingFile()` (transfer-receive), handlePlayMsg lifecycle gate                                                                                                                                | `setPlaybackIdle`, session-leave reset (`network/peer.ts`)                                                                               | observable pipeline phase; the SA-04 stale-buffer window                                                                                                      |
| M6  | `pendingPlayTime` (+ `pendingPlayTimeSetAt`)                                                                                                                                                                                                                                                 | state tree, accessors in `_state.ts`                    | many writers — see §4                                                                                                                                                                                                                                                                | consumed by `loadPreloadedTrack` / `finalizeGuestFile` completion, or by the owner-fenced microtask scheduled after `_internalPlay` synchronously releases the lock                                                                                   | per-cause policy, see §4                                                                                                                 | a **mailbox**, not a guard: the latest authoritative play time, with deliberate per-cause preserve/clear asymmetry                                            |
| M7a | `_activePreloadTarget` + `_activePreloadWaiterCleanup`                                                                                                                                                                                                                                       | `playback.ts` (module-local)                            | every direct or event-driven preload activation records its index, exact Blob object, and owning load epoch                                                                                                                                                                          | dedup only when index and Blob identity match and the target epoch is still current                                                                                                                                                                   | owner-checked `.finally()` on every activation; waiter cleanup on re-emit/lifecycle exit                                                 | duplicate native decodes and cross-invocation closure cross-talk (rapid A→B switches)                                                                         |
| M7b | `_endedAdvanceToken`                                                                                                                                                                                                                                                                         | `playlist.ts` `initPlaylist` (module-local)             | every `player:ended`                                                                                                                                                                                                                                                                 | both ended-advance timers at fire time                                                                                                                                                                                                                | never                                                                                                                                    | double-fire from overlapping ended timers                                                                                                                     |

`activatePreloadedTrack` is the single activation entry for both direct PLAY
and `storage:use-preloaded` notifications. A repeat notification joins the
existing native decode only when the playlist index and Blob object are exact
matches and its load epoch is still current. A replacement Blob or an
explicitly cancelled epoch starts a new activation; redundant decode is not an
accepted steady-state path.

## 2. Disambiguation: four unrelated "session/generation" mechanisms

High implementer-trap value — the same words name DIFFERENT mechanisms.
Stage B merged ONLY the player counters (M1 + M4's seq) into the load epoch;
its name (`loadEpoch`/`newLoadEpoch`) is deliberately distinct so greps never
conflate it with these:

| Name                                                    | Lives in             | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activeLoadSessionId` (M2)                              | `player/_state.ts`   | player-local load invocation counter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `transfer.localSessionId` / `transfer.currentSessionId` | state tree           | network transfer session ids. `playback.ts` accepts `storage:file-ready` only when its session and playlist index still own the active transfer, then reads the RAM slot with that exact session; filename is only a metadata consistency check. The id is also **snapshotted at `finalizeGuestFile` entry**: a NEW transfer session starting mid-finalize (FILE*PREPARE bumps neither M1 nor M2) aborts the stale finalize at the pre/post-decode checkpoints — otherwise it would land READY + watchdog-clears + the old buffer onto the new track's active download (chunk-drop wedge). \_Pin (j).* |
| `preload.sessionId`                                     | state tree           | host send-side preload session; read by chunk-pump's caller-supplied `shouldContinue` (`storage/preload.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `_preloadGeneration`                                    | `storage/preload.ts` | send-scheduling supersession for `schedulePreload`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `_demoLoadToken`                                        | `demo/mode.ts`       | demo-mode-local fetch supersession (distinct from M1, which demo entry ALSO bumps)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 3. Cross-mechanism interaction contracts

Each rule exists because resetting one mechanism without its partners re-opens
a documented bug. Pin letters refer to `concurrency-invariants.test.ts`.

- **C1 — flag-stomp rule** (`playback.ts` use-preloaded supersession branch):
  when use-preloaded(B) supersedes in-flight load(A), do NOT clear
  `playPreloadedInProgress`. A's token-mismatch path resolves the flag itself
  (via compare-before-clear: A's `finishPreloadActivation` is a no-op once B
  owns the activation). Clearing eagerly opens a window where the flag is
  false while A's decode still runs — `handlePlayMsg` falls through and
  double-triggers play. _Pin (a)._
- **C2 — token-bump etiquette**: `stopAllMedia({silent})` = ±0 tokens (the
  track-change path: `playTrack` allocated its token BEFORE
  `loadAndBroadcastFile`, which calls `stopAllMedia({silent})` internally — a
  bump here would self-abort every track load). `stopAllMedia({cancelInFlight})`
  = exactly +1. _Pinned in `playback-extended.test.ts`._
- **C3 — watchdog reset tuple + kill set**: the 15s watchdog fire must do ALL
  of: unlock, clear `pendingPlayTime`, `stopPlayerNode()`, bump `loadToken`
  (+1), semantic IDLE. The bump aborts in-flight `_internalPlay` and
  token-checking decodes. It does **NOT** abort an in-flight
  `finalizeGuestFile` (sessionId-only checks) — see §5 owner decision.
  _Pins (b), (g)._
- **C4 — stopAllMedia must-reset-together block** (`transport.ts`): play
  invocation owner + lock + watchdog/legacy-unlock timers +
  `pendingPlayTime` + `playPreloadedInProgress` reset as one
  unit. The flag clear here bypasses `finishPreloadActivation` on purpose
  (silent-path clear while `decode.ts`'s activation register stays nonzero —
  benign because `finishPreloadActivation` is idempotent/compare-before-clear).
  Do not "fix" this second writer into the owner-seq path without re-deriving
  why stopAllMedia must clear unconditionally. _Pin (c)._
- **C5 — sessionId gates loader teardown, token gates buffer publish**:
  `loadAndBroadcastFile`/`loadDemoFile` check token AND sessionId in
  combination at their post-decode checkpoints — and since 2026-06-13 at
  their failure-catch entry too (a superseded load's failure is INERT: no
  blob clear, no FSM transition, no failed-mark/auto-advance, no play-btn
  emit — the host-load mirror of the M4-row catch guard). The `finally`
  loader teardown keys on sessionId only. `finalizeGuestFile` checks
  sessionId AND its `transfer.localSessionId` entry snapshot at the same
  pre/post-decode checkpoints (2026-06-13) — still NEVER the epoch (§5).
  _Pins (d), (g), (j)._
- **C6 — owner-scoped post-unlock queued-play consumption**: `_internalPlay`'s
  `finally` releases its lock synchronously, then schedules one microtask to
  consume `pendingPlayTime` (consume = clear + replay). The release and
  microtask may mutate the global tuple only while their monotonic
  play-invocation, start-fence, and mailbox owner are current. The watchdog clears
  `pendingPlayTime` BEFORE unlocking and invalidates that owner so a wedged
  invocation cannot later clear a newer play's watchdog or mailbox. _Pin (b)
  and the play-owner interleaving pins._
- **C7 — SA-05 post-activation double check** (`playlist.ts` fast path):
  after `await loadPreloadedTrack(...)`, re-check both the boolean result AND
  `isCurrentLoadEpoch(myLoadEpoch)` before play. Because `play()` itself crosses
  async AudioContext/engine-init boundaries, re-check the epoch, selected qid,
  and PLAYING activity again after it returns and before broadcast/scheduling —
  a stale PLAY(old occurrence) broadcast flaps every guest. _Pinned in
  `decode.test.ts` (boolean contract) and `playlist.test.ts` (post-play
  supersession)._
- **C8 — waiter-cleanup pair** (`playback.ts`): the blob-not-ready path's
  progress watchdog must tear down the PREVIOUS waiter before arming a new one
  (`_activePreloadWaiterCleanup`), or A's closure overwrites B's stall timer /
  requests recovery for the wrong track.
- **C9 — busy gate is FSM-derived, not run-derived**:
  `isFilePipelineBusyForPlay()` derives from M5, never from "a load is in
  flight". Two DIFFERENT pinned contracts depend on this: listener paths must
  bail BEFORE `play()` (refresh-current-position: `pendingPlayTime` stays
  undefined) while `play()` itself must QUEUE (`pendingPlayTime` set). See
  `busy-guard.test.ts`.
- **C10 — completion-consumer post-play ownership** (`decode.ts`):
  `finalizeGuestFile` and `loadPreloadedTrack` publish an exact resident and may
  then await `play(pendingTime)`. A newer transfer can take over the same queue
  occurrence during that await, so qid equality alone is insufficient. Before
  clearing `pendingPlayTime` or arming delayed sync, the finalizer re-runs its
  exact load/transfer/meta owner predicate; the preload path checks the exact
  published `{ queueItemId, sessionId, Blob }`, epoch, and playback mode owner.
  This preserves the newer completion consumer's mailbox without changing the
  replay-then-clear order documented below. _Pinned in
  `concurrency-invariants.test.ts`._

## 4. pendingPlayTime preserve/clear policy (asymmetric BY DESIGN)

`pendingPlayTime` belongs to the **latest MSG.PLAY**. Abort paths that know a
newer load will need it must PRESERVE it; abort paths that know nobody will
consume it must CLEAR it. A uniform "abort → clear" (or "abort → preserve")
helper is a regression generator. _Pin (e) covers both directions._

| Path                                                                                        | Policy                                                                                                                                                                                                                         | Why                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadPreloadedTrack` selected queue item no longer owns the requested resident (pre-decode) | **preserve**                                                                                                                                                                                                                   | the loader for the newly selected occurrence owns consumption; clearing can leave a completed recovery silent                                                    |
| `loadPreloadedTrack` token-mismatch post-decode                                             | **preserve**                                                                                                                                                                                                                   | the newer load owns consumption                                                                                                                                  |
| `loadPreloadedTrack` queue selection changed during decode                                  | **preserve**                                                                                                                                                                                                                   | same                                                                                                                                                             |
| `loadPreloadedTrack` external-owner abort (pre & post decode)                               | **clear**                                                                                                                                                                                                                      | no file loader will consume it under an external owner                                                                                                           |
| `loadPreloadedTrack` selected occurrence has no ready resident                              | **preserve + request recovery**                                                                                                                                                                                                | the authoritative play time belongs to the replacement transfer that was just requested                                                                          |
| `loadPreloadedTrack` catch while CURRENT activation                                         | **clear**                                                                                                                                                                                                                      | terminal failure of the live activation                                                                                                                          |
| `loadPreloadedTrack` catch while SUPERSEDED                                                 | **don't touch** (stale path is inert) — _pin (f)_                                                                                                                                                                              | the superseder owns it                                                                                                                                           |
| `finalizeGuestFile` sessionId-stale aborts                                                  | **don't touch**                                                                                                                                                                                                                | newer invocation owns it                                                                                                                                         |
| `finalizeGuestFile` transfer-sid-stale aborts (new transfer session mid-decode, pin j)      | **don't touch**                                                                                                                                                                                                                | the new session's own loader consumes it — same ownership logic as sessionId-stale                                                                               |
| `finalizeGuestFile` external-owner aborts (post-init & post-decode)                         | **clear**                                                                                                                                                                                                                      | no file loader will consume it under an external owner. (The ENTRY guard runs before invocation registration and does NOT touch it.)                             |
| `finalizeGuestFile` decode-failure catch                                                    | **don't touch**                                                                                                                                                                                                                | the retry path (recovery → re-finalize) still consumes it; terminal failures leave it for the next track's `clearPreviousTrackState` (`'file-prepare'`) to clear |
| `clearPreviousTrackState`                                                                   | **clear**, EXCEPT `reason==='new-session-start'` — note `reason==='redundant-sync'` also never reaches the clear (the function early-returns and no-ops entirely, so it is a whole-function exception, not an abort-cause one) | late-join sends PLAY bootstrap BEFORE FILE_START                                                                                                                 |
| `stopAllMedia`                                                                              | **clear** (part of C4 tuple)                                                                                                                                                                                                   | terminal/transition stop                                                                                                                                         |
| watchdog fire                                                                               | **clear** (part of C3 tuple)                                                                                                                                                                                                   | see C6                                                                                                                                                           |
| `handlePauseMsg`                                                                            | **clear**                                                                                                                                                                                                                      | host paused; a finishing download must not auto-start                                                                                                            |
| `_internalPlay` entry / post-unlock microtask                                               | **consume** (clear, possibly replay)                                                                                                                                                                                           | the mailbox is delivered                                                                                                                                         |

**Completion-consumer order note (2026-06-13, deep-dive accepted):** the two
pipeline-COMPLETION consumers (`loadPreloadedTrack` / `finalizeGuestFile`)
run replay-then-clear — the inverse of C6, whose clear-then-replay is scoped
to the `_internalPlay` post-unlock microtask consumer. Intentional-by-acceptance: the
only divergent case is a lock-branch zero-fire (constructible only under an
engine-init hang >2s spanning a track switch, via the un-raced
`_internalPlay` initAudio vs the 2s-raced loader initAudio), and there the
sync bootstrap armed on the same lines recovers at a pong-fresh,
age-correct position — strictly better than a C6-conforming swap, which
would replay a stale un-age-compensated value and force a second audible
drift-correction restart. Do NOT "align" these two sites to C6.

**Writers** (anyone adding a writer must update this table):
`handlePlayMsg` (defer branches, queue-item mismatch, metadata mismatch, no resident),
`tryFetchDemoForRemote`, `play()` (lock-queue + busy-defer branches),
remote-share wait branches, **wave-2 snapshot/restore protocol** in
`storage/transfer-receive.ts` (`capturePendingPlaySnapshot` /
`restorePendingPlaySnapshot` with its three restore sites: preload-match,
preload-waiting, file-prepare reset — restores the value `stopAllMedia`'s C4
tuple just cleared when the incoming FILE_PREPARE matches the pending target),
and remote-share's `clearStaleRemotePlayback` re-set
(`share/remote-share.ts` — capture/re-set around `storage:clear-previous-track`).

## 5. Owner decision (binding): finalize immunity to token bumps

> `newLoadEpoch()` fired during `finalizeGuestFile`'s decode await must
> NOT abort the finalize — buffer swap, DECODE_SUCCESS transition, and
> pendingPlayTime consumption all still happen. (The late-join download path
> must survive a concurrent watchdog fire / cancelInFlight stop.)

This is _pin (g)_ — the permanent tripwire that fails any future attempt to
fold `activeLoadSessionId` into a single global epoch where
`isCurrent(e) := e === latest`. Stage B (landed 2026-06-11) was therefore
scoped to merging M1 (`loadToken`) + M4's owner seq ONLY (3 counters → 2);
`activeLoadSessionId` and all eleven of its call sites stayed untouched.
The rejected workaround (conditional watchdog bump scoped to the wedged
play's epoch) silently flips the kill set the other way — in-flight host
loads that today die on a watchdog fire would newly survive — and is
likewise out of scope.
