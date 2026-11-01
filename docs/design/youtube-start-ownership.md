# YouTube Start Ownership

- **Status:** Accepted
- **Decision date:** 2026-11-01
- **Amended:** 2026-11-01 (plan step C2-7, Phase 6 6B-2): every start-ownership reader asks the
  ledger; the composite `isYouTubeZeroStartSyncOwned` and the runtime bridge's two recovery hooks
  are gone, and the resource-ownership guard keeps the readers on the ledger
- **Applies to:** YouTube start ownership in Standard and PRO rooms: which start owner holds the
  shared iframe, and the queries its readers ask (resource ownership registry
  [RO-02](resource-ownership-registry.md#ro-02-youtube-standard-shared-start); plan steps C2-5,
  Phase 6 6B-1, and C2-7, 6B-2)

## Decision

One start ledger composes the YouTube start owners for their readers. Each owner keeps its own
state, timers and lifecycle; the ledger keeps none:

| Module                                 | Sole responsibility                                                                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/youtube/start-ownership.ts`       | the start ledger: the claim kinds, each kind's registered live queries, and the derived queries every reader asks                                                                                                                                       |
| `src/youtube/zero-start.ts`            | the zero-start run owner (`YouTubeZeroStartController`), its ownership facades (`isYouTubeZeroStartInFlight`, `isYouTubeZeroStartProtocolActive`) and its snapshot reads (`getYouTubeZeroStartSnapshot`, `getYouTubeZeroStartPendingCanonicalPosition`) |
| `src/youtube/player.ts`                | the start owners' composition point, which registers every claim; the owner of the guest local recovery, the host legacy recovery and the replacement fallback that runs it, the legacy two-stage rendezvous and the PRO direct COMMIT's local wait     |
| `src/youtube/iframe.ts`                | the PRO authority arm's instance (`YouTubeAuthorityArmController` from `src/youtube/authority-arm.ts`) and the iframe state dispatch to the start owners                                                                                                |
| `src/youtube/player-runtime-bridge.ts` | the player's hooks for modules that cannot import `player.ts`: the pending auto-sync intent, the legacy rendezvous's Stage-2 query `isYouTubeAutoSyncPending` and the PRO pause gate                                                                    |

The ledger answers from live queries only. A derived query calls the queries the owners
registered at the moment it is asked, so the answer is the owners' own state at that instant, and
no second copy of that state exists to go stale.

## Claims and live queries

`player.ts` registers each claim once, at module evaluation after every backing binding exists,
through `registerYouTubeStartClaim(kind, queries)`. The queries are positional (a property name
would ship in the eagerly loaded entry chunk):

| Kind                | Queries (position: what it answers)                                                                                                                                                                                                                                                                                                            | Registered                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `standard-run`      | inFlight: `isYouTubeZeroStartInFlight()` (a run whose phase is neither `playing` nor `error`); protocolActive: `isYouTubeZeroStartProtocolActive()` (a run not in `error`, through the timeline calibration after the release); hardMuted: the run's phase is `muting`, `warming` or `settling` (read through `getYouTubeZeroStartSnapshot()`) | yes                                                                                                                 |
| `standard-recovery` | active: the recovery owns the iframe's events; pending: active, or the guest recovery still holds the player state until its release is acknowledged (`player.ts`'s two recovery flags, shared by the guest local recovery and, on a host, the legacy recovery, also after a peer replacement)                                                 | yes                                                                                                                 |
| `legacy-rendezvous` | stage2Pending: the legacy rendezvous's Stage-2 wait, `player.ts`'s own `'yt-auto-sync'` timer (the timer `isYouTubeAutoSyncPending` answers from)                                                                                                                                                                                              | yes, since 6B-2 (the room-state hold reads it)                                                                      |
| `pro-arm`           | hardMuted: `proYouTubeAuthorityOwnsHardMute()`, the arm's `ownsHardMute()` (`muting`, `warming`, `settling`)                                                                                                                                                                                                                                   | yes                                                                                                                 |
| `pro-direct`        | waiting: the PRO direct COMMIT's local wait                                                                                                                                                                                                                                                                                                    | no: no derived query reads it, and no public owner covers that wait today (see [Not covered yet](#not-covered-yet)) |

## Derived queries

Each derived query decides every kind, with one of that kind's queries or never. It asks the kinds
in this order; the first claim that holds answers, and a kind decided never, or not registered,
reads nothing:

| Derived query                  | `standard-run` | `standard-recovery` | `legacy-rendezvous` | `pro-arm` | `pro-direct` | Readers                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | -------------- | ------------------- | ------------------- | --------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isYouTubeStartSyncOwned`      | protocolActive | pending             | never               | never     | never        | `src/youtube/sync.ts`: the host heartbeat hold, the guest state actions, transition and rendezvous checks, the manual-offset apply and edit, the Sync `not-ready` answer and an explicit command's cancel; `src/network/sync.ts`, `src/ui/player-controls.ts`, `src/ui/manual-sync-overlay-runtime.ts` (twice), `src/player/background-return-sync.ts`; `player.ts`: the seek's mid-sync check and the late-join bootstrap deferral |
| `isYouTubeStartHardMuteOwned`  | hardMuted      | active              | never               | hardMuted | never        | `player.ts`: the unMute guards on `youtube:set-volume` and on the PRO pause-gate settlement                                                                                                                                                                                                                                                                                                                                         |
| `isYouTubeStartTimelineHeld`   | inFlight       | pending             | never               | never     | never        | `sync.ts`: the small-drift sample, the guest heartbeat and the auxiliary state that holds this speaker's iframe timeline                                                                                                                                                                                                                                                                                                            |
| `isYouTubeStartArmBusy`        | inFlight       | never               | never               | never     | never        | `src/ui/seekbar.ts` (the seek gate) and `iframe.ts`'s UI loop                                                                                                                                                                                                                                                                                                                                                                       |
| `isYouTubeStartRecoveryActive` | never          | active              | never               | never     | never        | `iframe.ts`'s state dispatch (the recovery owns the iframe's events)                                                                                                                                                                                                                                                                                                                                                                |
| `isYouTubeStartRoomStateHeld`  | protocolActive | never               | stage2Pending       | never     | never        | `iframe.ts`'s auxiliary `YOUTUBE_STATE` hold on a host                                                                                                                                                                                                                                                                                                                                                                              |

The order is the operand order of the composites these queries replace, so every reader calls the
same owner queries in the same order with the same short-circuit: `isYouTubeZeroStartSyncOwned`
asked the run's protocol and then the recovery's pending claim; `player.ts`'s unMute guard asked
the run's hard mute, the recovery's active claim and then the PRO arm; `sync.ts`'s timeline holds
asked the run in flight and then the recovery's pending hook; and `iframe.ts`'s auxiliary state
hold asked the run's protocol and then the legacy rendezvous's Stage-2 query. The arm and recovery
queries read one claim each, as the facade and the bridge hook they replace did.

Since 6B-2 (plan step C2-7) every reader asks one of these queries, 24 reader sites in eight
production modules, beside other owners where it needs them, and no statement outside the ledger
asks two start claims, with two exceptions that read a claim's own query:

- the legacy rendezvous's Stage-2 wait, which `sync.ts`'s heartbeat hold, `iframe.ts`'s
  sub-video advance check and `native-control-authority.ts` (`hasProtectedTransitionOwner`) ask
  through `player-runtime-bridge.ts`'s `isYouTubeAutoSyncPending`. `player.ts` answers it with the
  live query the `legacy-rendezvous` claim registers (`isYouTubeAutoSyncPendingOwned`), so a
  change to that claim moves these three readers too;
- the seek's mid-sync check in `player.ts` (`seekYouTubeFromApp`), which asks
  `isYouTubeStartSyncOwned` and the legacy claim's own `'yt-auto-sync'` timer in one statement,
  beside the host's local start, end hold and manual-offset transaction. It is the one statement
  outside the ledger that the resource-ownership guard allows to ask two start claims.

The composite `isYouTubeZeroStartSyncOwned` and the runtime bridge's two recovery hooks are gone.
Outside `zero-start.ts` only the run claim's registration in `player.ts` reads the run's
ownership facades (`isYouTubeZeroStartInFlight`, `isYouTubeZeroStartProtocolActive`). `player.ts`
also reads the run's snapshot, eight reads: `getYouTubeZeroStartSnapshot()` for the run's
hard-mute phase (its claim's third query), the 9.0.8 host speaker reference in
`onPlaybackStarted` and its log line, the guest recovery's audible lead and run check, and the
peer replacement fallback (twice), and `getYouTubeZeroStartPendingCanonicalPosition`, handed to
`local-offset.ts` as the scheduled-start timeline reader. No query asks the run's protocol or the
recovery's pending claim alone, because no reader needs one.

## Rules

- **Live queries only.** The ledger keeps no answer, flag, phase or snapshot; it subscribes to
  nothing (no `onPhaseChange` or `onBusyChange`, no bus event), emits nothing and imports no
  runtime module. A cached or pushed answer would be a second machine on the owners' state
  (registry rules) and would go stale: the PRO arm's `cancel` drops its run before it calls
  `onPhaseChange('idle')`, and `iframe.ts`'s instance does not wire `onPhaseChange` at all. Read
  live, `ownsHardMute()` already answers false inside the synchronous pause of that cancel.
- **One registrant file.** Only `player.ts` registers claims, one registration per kind. A query
  imported from another module is registered behind a closure: the closure reads that module's
  live binding when called, so `player.ts` still loads where a suite mocks the owner module
  without that query. Registering reads no query; a later registration of a kind replaces it.
- **The owners keep their queries.** `zero-start.ts`'s facades stay the run's public queries and
  are the run claim's live queries (they cannot ask the ledger, whose answer they feed).
  `getYouTubeZeroStartSnapshot()` is unchanged, and the ledger cannot end, clear or replace a run.
- **Readiness events stay at their sources.** `youtube:zero-start-readiness-changed` keeps its 17
  emitters and their instants: the run's phase change synchronously, the recovery's flag change one
  microtask later, and the iframe and retained-controller sources. `youtube:sync-loading` keeps its
  emitters. The ledger adds no emitter and no listener, and coalesces nothing.
- **A new start path adds a kind.** It needs the kind in `START_CLAIM_KINDS`, its claim type in
  `YouTubeStartClaims` and a decision (a read or `0`) in every derived query; the module does not
  compile until all three exist. Its registration lands with the first production reader that
  reads it.
- **Readers ask the ledger, one start claim per statement.** A reader that needs another
  combination of claims gets a new derived query in the ledger rather than composing two at its
  call site. The resource-ownership guard (CHECK 12) counts, per function, the statements outside
  the ledger that ask two or more start claims (ledger queries, a claim's own public query such
  as `isYouTubeAutoSyncPending` or `proYouTubeAuthorityOwnsHardMute`, a query `player.ts`
  registers, or the `'yt-auto-sync'` timer), and only the seek's mid-sync check has an entry,
  pinned to its two claims (`isYouTubeStartSyncOwned` and the legacy claim). It
  does not see claims combined across statements, through a variable or a local helper: `sync.ts`'s
  small-drift sample asks the timeline hold beside `isCurrentStateAction` and
  `isGuestYouTubeTransitionPending`, which each ask `isYouTubeStartSyncOwned`.
- **The run's facades and snapshot stay with their owners.** No module but `zero-start.ts` and
  the run claim's registration in `player.ts` reads the run's ownership facades, and no module but
  `player.ts` reads the run's snapshot; CHECK 12 keeps both as exact per-file counts (2 and 8),
  so a reader that rebuilt an ownership answer from the snapshot elsewhere fails it.
- **The guard keeps the ledger pure.** CHECK 12 keeps the ledger free of runtime imports, timer
  and scheduling names, module-level state other than its claim kinds (a `const` list of string
  literals) and its claims (an empty `Map`), writes outside function-local bindings, changes to
  its claims outside `registerYouTubeStartClaim` and claim registrations of its own. It lets only
  `player.ts` register claims, each kind once and in a top-level statement, and requires that
  registration for every kind a derived query decides: the ledger fails open (a kind with no
  claim answers false), so a dropped registration would hide that owner from its readers. It
  reads each derived query's decisions from its one list, and fails one it cannot read. It also
  fails a start timer named outside `src/youtube/`.
- **The wire does not change.** No frame, field, value, timing or validator changes
  (`src/network/protocol.ts`), so builds at or above the floor exchange the same frames at the same
  instants.

## Not covered yet

- The host legacy recovery and the replacement fallback answer through the recovery's flags but are
  not yet stages of the run's owner (plan step C2-11). The PRO direct COMMIT's 2 s local wait has no
  public owner, so the `pro-direct` kind holds nothing (C2-13). Iframe state events are still
  dispatched to every owner in `iframe.ts`'s fixed order, and the host's pending-start query
  (`isStandardHostYouTubeLocalStartPending`, `src/youtube/local-offset.ts`) still sees only the
  legacy hold (C2-6).
- Gaps the start-ownership truth tables pin as today's behaviour (rows marked "Looks like a
  defect") stay as they are; the ledger changes no answer, so it neither opens nor closes them.
  These are the four the owner was asked about on 2026-11-01, as rewritten after the rows were
  rerun with the fake iframe notifying one task later and only on a change, as a real iframe does
  (the 'a' rows):
  - after the host legacy recovery times out, its fence ends with the iframe paused at 0:00 while
    `playback.activity` stays 'playing': the play button, the playlist icon and the tab title show
    the iframe paused, what follows the activity (the OS media controls among them) shows it
    playing, and no notice is shown (rows H4, H4a);
  - when a guest's next-track prepare fails over a playing track, the warm-up error pauses that
    track at once and the projection stays paused, with no loading owner busy, until the new
    track's release about 2.7 s later (rows G8pa, G8, G8p and G8a);
  - in a PRO room no public owner covers the direct COMMIT's 2 s local wait, and the Sync button
    and the manual-sync panel stay open while a track starts (rows P1 and P4);
  - a host pause broadcasts its formal PAUSED and then the iframe's own PAUSED, on the first pause
    after a load and on a pause after a stall; a pause after a resume sends one (rows H10, H10a
    and H10c).

  The legacy rendezvous's own PLAYING that leaves before Stage 1 arms its hold (rows H9, H3, H5
  and H6) is marked "Fake ordering": only the synchronous fake sends it, so it is not a gap.

- Two readers have no row that tells their query from a near-equivalent one. The calibration
  window rows (`start-ownership-reader-windows.test.ts`: a Standard guest's run is protocol-active
  but no longer in flight) pin the guest heartbeat and auxiliary-state holds, the state-action and
  manual-offset apply checks and the manual-sync panel's availability. The delayed rendezvous
  steps' check (`matchesRendezvousOccurrence` in `sync.ts`) has no calibration-window row (in that
  window its follow-up asks `isYouTubeStartSyncOwned` again through `guestRendezvousSync`, which
  also refuses to begin a rendezvous), but the guest backstop gate rows in
  `sync-integration.test.ts` fail when it asks `isYouTubeStartTimelineHeld` instead. The
  manual-sync panel's Sync press (`manual-sync-overlay-runtime.ts`, the `sync_not_ready` answer)
  passes every row when it asks `isYouTubeStartArmBusy` instead. The small-drift sample's timeline
  hold cannot be told apart either, because the same condition asks
  `isGuestYouTubeTransitionPending`, which asks `isYouTubeStartSyncOwned`. The recovery's
  release-acknowledgement window (pending, not active), where the `isYouTubeStartSyncOwned`
  readers also differ from `isYouTubeStartArmBusy`, has no reader rows of its own. In the same
  window the unMute guards' recovery decision (active, not pending: the recovery does not hold the
  hard mute while it waits for that acknowledgement) is pinned only by `start-ownership.test.ts`;
  no volume row sits in that window.

## Product invariants

- **Host speaker reference (9.0.8):** `onPlaybackStarted` in `player.ts` reads
  `getYouTubeZeroStartSnapshot()?.releaseLeadMs` and subtracts only the release lead from the
  host's offset ([host speaker reference](youtube-host-speaker-reference-2026-10-25.md)). The run,
  and so its snapshot, is alive at that callback exactly as before.
- **Sync right after a zero-start:** `isYouTubeStartSyncOwned` stays true until the timeline
  calibration ends, as `isYouTubeZeroStartSyncOwned` did, so the accepted readiness gap keeps its
  window ([known-accepted #14](../known-accepted.md#14-standard-room-youtube-zero-start-sync-readiness-gap)).
- **PRO start timing:** the ledger reads the PRO arm and never drives it; PREPARE, READY and
  COMMIT timing is unchanged.
- No audio, UI or wire change.

## Module reason

`docs/design/source-complexity-ratchet.md` asks a new production module for a reason. The ledger
has two: it is a contract shared by multiple production consumers (the start-ownership readers,
24 sites in eight modules since 6B-2), and it removes a circular dependency through a narrow,
explicit port. The owners compose in `player.ts`, which imports `iframe.ts` and `sync.ts`, and
`guard:import-graph` rejects every cycle, so those two readers cannot import `player.ts`. The
ledger is a leaf with no import that every reader can import and `player.ts` registers into. It
keeps no state and has no lifecycle of its own.

## Verification

- `src/youtube/__tests__/start-ownership.test.ts` drives the ledger through its production exports
  with recorded queries: what each claim position decides in each of the six derived queries, the
  read order and short-circuit under all 256 combinations of the eight queries, reads at the call
  (no registration, event or microtask between two reads), and registration replacement.
- Until 6B-2 removed the composite, a transitional test compared the first two derived queries
  with the composites they replaced at every sample point of real Standard guest and PRO
  participant runs; no sample disagreed.
- The start-ownership truth tables (`youtube-start-ownership-table.test.ts`, Standard, and
  `youtube-start-ownership-table-pro.test.ts`, PRO) and the start goldens
  (`standard-start-wire-golden.test.ts`, `pro-ready-timing-golden.test.ts`) pass unchanged. Since
  6B-2 the tables' sampler reads the ledger's queries, the queries the readers ask, except its
  unMuteHeld column: it keeps its own copy of the hard-mute phase list (only its recovery operand
  reads the ledger), so the volume rows still compare it with the real guard's effect. Only its
  column map changed, never an expected array.
- `start-ownership-reader-windows.test.ts` pins five readers in a Standard guest's calibration
  window (see [Not covered yet](#not-covered-yet)); swapping any of them to the other query fails
  its row, and the rows pass on the tree before 6B as well.
- Suites that never load `player.ts` (for example `src/player/__tests__/local-output-realign-cross-flow.test.ts`,
  the Phase 4 D4 harness) register no claim, so every derived query answers false there, as the
  zero-start facades did before 6B; their rows show the chains' behaviour, not the gates'
  composition, which `start-ownership.test.ts`, the truth tables and the reach rows in
  `src/ui/__tests__/player-controls.test.ts` and `src/network/__tests__/sync.test.ts` pin.
- A suite that imports `player.ts` inside its rows reads the ledger's claims only after an earlier
  row has loaded it (the ledger keeps them between rows), so its rows that never import it depend
  on test order. Such a suite loads `player.ts`, or registers stand-in claims, in its shared
  `beforeEach`, as `stale-async-guards.test.ts` and `sync-integration.test.ts` do since 6B.
- `guard:import-graph` (the ledger imports nothing), `guard:dead-exports` (no test-only export),
  `node scripts/check-resource-ownership.mts` (the ledger's header claims RO-02, once; since 6B-2
  CHECK 12's facade and snapshot-read counts, its per-statement start-claim count and its ledger
  rules, with their seeded violations in `src/core/__tests__/resource-ownership-guard.test.ts`)
  and the critical coverage profile (`vitest.critical.config.ts` enrols the ledger and
  `zero-start.ts`).
