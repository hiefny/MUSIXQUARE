# YouTube Start Ownership

- **Status:** Accepted
- **Decision date:** 2026-11-01
- **Applies to:** YouTube start ownership in Standard and PRO rooms: which start owner holds the
  shared iframe, and the queries its readers ask (resource ownership registry
  [RO-02](resource-ownership-registry.md#ro-02-youtube-standard-shared-start); plan step C2-5,
  Phase 6 6B-1)

## Decision

One start ledger composes the YouTube start owners for their readers. Each owner keeps its own
state, timers and lifecycle; the ledger keeps none:

| Module                                 | Sole responsibility                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/youtube/start-ownership.ts`       | the start ledger: the claim kinds, each kind's registered live queries, and the derived queries readers ask (`isYouTubeStartSyncOwned`, `isYouTubeStartHardMuteOwned`)                                                                                                                              |
| `src/youtube/zero-start.ts`            | the zero-start run owner (`YouTubeZeroStartController`) and its facades (`isYouTubeZeroStartInFlight`, `isYouTubeZeroStartProtocolActive`, `getYouTubeZeroStartSnapshot`, `getYouTubeZeroStartPendingCanonicalPosition`)                                                                            |
| `src/youtube/player.ts`                | the start owners' composition point, which registers every claim; the owner of the guest local recovery, the host legacy recovery and the replacement fallback that runs it, the legacy two-stage rendezvous and the PRO direct COMMIT's local wait                                                 |
| `src/youtube/iframe.ts`                | the PRO authority arm's instance (`YouTubeAuthorityArmController` from `src/youtube/authority-arm.ts`) and the iframe state dispatch to the start owners                                                                                                                                            |
| `src/youtube/player-runtime-bridge.ts` | the player's hooks for modules that cannot import `player.ts` (the pending auto-sync intent, the legacy rendezvous's Stage-2 query `isYouTubeAutoSyncPending`, the PRO pause gate); until the readers below move, also the recovery's two hooks that `src/youtube/zero-start-ownership.ts` composes |

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
| `legacy-rendezvous` | stage2Pending: the legacy rendezvous's Stage-2 wait                                                                                                                                                                                                                                                                                            | not yet: no derived query reads it; it registers with the first reader that does                                    |
| `pro-arm`           | hardMuted: `proYouTubeAuthorityOwnsHardMute()`, the arm's `ownsHardMute()` (`muting`, `warming`, `settling`)                                                                                                                                                                                                                                   | yes                                                                                                                 |
| `pro-direct`        | waiting: the PRO direct COMMIT's local wait                                                                                                                                                                                                                                                                                                    | no: no derived query reads it, and no public owner covers that wait today (see [Not covered yet](#not-covered-yet)) |

## Derived queries

Each derived query decides every kind, with one of that kind's queries or never. It asks the kinds
in this order; the first claim that holds answers, and a kind decided never, or not registered,
reads nothing:

| Derived query                 | `standard-run` | `standard-recovery` | `legacy-rendezvous` | `pro-arm` | `pro-direct` | Readers                                                                                     |
| ----------------------------- | -------------- | ------------------- | ------------------- | --------- | ------------ | ------------------------------------------------------------------------------------------- |
| `isYouTubeStartSyncOwned`     | protocolActive | pending             | never               | never     | never        | `player.ts`: the seek's mid-sync check and the late-join bootstrap deferral                 |
| `isYouTubeStartHardMuteOwned` | hardMuted      | active              | never               | hardMuted | never        | `player.ts`: the unMute guards on `youtube:set-volume` and on the PRO pause-gate settlement |

The order is the operand order of the composites these queries replace, so every reader calls the
same owner queries in the same order with the same short-circuit: `isYouTubeZeroStartSyncOwned`
asked the run's protocol and then the recovery's pending claim, and `player.ts`'s unMute guard
asked the run's hard mute, the recovery's active claim and then the PRO arm.

The other readers still ask the composite or the owners directly: `isYouTubeZeroStartSyncOwned`
(`src/youtube/zero-start-ownership.ts`) in `src/youtube/sync.ts`, `src/network/sync.ts`,
`src/ui/player-controls.ts`, `src/ui/manual-sync-overlay-runtime.ts` and
`src/player/background-return-sync.ts`; `sync.ts`'s pairs of the run's in-flight query and the
recovery's pending hook; the recovery's active hook in `iframe.ts`'s state dispatch; and the run's
facades in `iframe.ts` (the auxiliary `YOUTUBE_STATE` hold and the UI loop) and
`src/ui/seekbar.ts`. They move to named ledger queries next (plan step C2-7), which deletes the
composite and the bridge's two recovery hooks. With the four readers in `player.ts` that already
moved, that is 24 reader sites in eight production modules.

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
- Gaps the start-ownership truth tables pin as today's behaviour stay as they are; the ledger
  changes no answer, so it neither opens nor closes them:
  - after the host legacy recovery times out, its fence ends with the iframe paused at 0:00 while
    the projection shows playing, and the next heartbeat reports the room paused at 0:00 (row H4);
  - the legacy rendezvous's own PLAYING broadcasts an auxiliary `YOUTUBE_STATE` before Stage 1
    arms its hold (rows H9, H3, H5 and H6);
  - a host pause broadcasts its formal PAUSED and then the iframe's own PAUSED (row H10);
  - after a guest's failed prepare, the projection shows paused from the COMMIT until the recovery
    releases (row G8);
  - no public owner covers the PRO direct COMMIT's 2 s local wait (row P4).

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
24 sites in eight modules once they move), and it removes a circular dependency through a narrow,
explicit port. The owners compose in `player.ts`, which imports `iframe.ts` and `sync.ts`, and
`guard:import-graph` rejects every cycle, so those two readers cannot import `player.ts`. The
ledger is a leaf with no import that every reader can import and `player.ts` registers into. It
keeps no state and has no lifecycle of its own.

## Verification

- `src/youtube/__tests__/start-ownership.test.ts` drives the ledger through its production exports
  with recorded queries: what each claim position decides, the read order and short-circuit under
  all 256 combinations of the eight queries, reads at the call (no registration, event or
  microtask between two reads), and registration replacement.
- `src/youtube/__tests__/start-ownership-equivalence.test.ts` compares each derived query with the
  composite it replaces at every sample point of real Standard guest and PRO participant runs.
  It goes with the composite.
- The start-ownership truth tables (`youtube-start-ownership-table.test.ts`, Standard, and
  `youtube-start-ownership-table-pro.test.ts`, PRO) and the start goldens
  (`standard-start-wire-golden.test.ts`, `pro-ready-timing-golden.test.ts`) pass unchanged.
- `guard:import-graph` (the ledger imports nothing), `guard:dead-exports` (no test-only export),
  `node scripts/check-resource-ownership.mts` (the ledger's header claims RO-02, once) and the
  critical coverage profile (`vitest.critical.config.ts` enrols the ledger and `zero-start.ts`).
