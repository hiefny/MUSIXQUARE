# Resource Ownership Registry

| Field              | Value                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Maintained contract                                                                                                                                                                                                                                                                                                         |
| Applies to         | Every shared runtime resource in `src/`, `browser/` and `cloudflare/` that more than one recovery, retry, timeout, watchdog or lifecycle flow can drive                                                                                                                                                                     |
| Last source review | 2026-10-22 (`main` `c08b6c39`, App 9.0.1)                                                                                                                                                                                                                                                                                   |
| Executable sources | The `resource-ownership` ID block below, the anchor tests named in each record, and the [resource-ownership guard](#resource-ownership-guard) (`scripts/check-resource-ownership.mts`, run in CI)                                                                                                                           |
| Related documents  | [Realtime runtime ownership](realtime-runtime-ownership.md), [Playback concurrency invariants](playback-concurrency-invariants.md), [Source complexity safety limits](source-complexity-ratchet.md), [Known and accepted risks](../known-accepted.md), [Competing recovery flows, 9.0.1](ownership-gap-fixes-2026-10-22.md) |

This registry names one owner for each shared runtime resource and records where that is not
yet true. A 2026-10-22 survey of `1bd9cd6f` found 9 resources where the same protocol is
implemented twice or more (STRONG), 19 where independent machines with different purposes keep
their own lifecycle state on one resource (MODERATE) and 11 single owners with a side flow
(WEAK). App 9.0.1 fixed the four gaps that reading confirmed (G1 to G4). Every record below was
re-checked against `c08b6c39`.

Records cite files and symbols, not line numbers. The registry is an index: domain documents stay
authoritative for their own rules. [Realtime runtime ownership](realtime-runtime-ownership.md)
owns the split between `sync.ts`, `room-control.ts` and `heartbeat-monitor.ts`;
[Playback concurrency invariants](playback-concurrency-invariants.md) owns the file pipeline's
load epoch, play lock and `pendingPlayTime` policy. Records link to them instead of restating them.

## Principles

1. **One owner per resource.** One module holds the resource's pending, phase or generation state,
   its timers and its lifecycle operations. Every other module is a requester (calls the owner's
   API) or a reader (side-effect-free queries).
2. **One deadline owner per attempt.** When a retry ladder and a watchdog act on the same slot, one
   of them owns the attempt's deadline: either the longest retry delay stays below the watchdog, or
   the watchdog is off for that attempt. G1 (9.0.1) broke this rule.
3. **User pause or stop beats automatic recovery.** Every automatic recovery, retry or re-align
   chain retires on an explicit user pause or stop. G2 (9.0.1) broke this rule.
4. **Timing values and phase unions have one named home.** Import them from the home the record
   names and derive a mirrored value from the named constant; never retype them. Where a runtime
   cannot import (another document or bundle), pin the copy with a parity test named in the
   record.
5. **Different contracts stay separate.** Equal values or similar steps are not copies when the
   contract differs: a failed-PLAY retry publishes a room PLAY, an output rejoin never does; the
   30 s heartbeat recovering-transport grace is not the 30 s side-route cap.
6. **Read the record before splitting out a machine.** Whether a new module is justified is decided
   by [Source complexity safety limits](source-complexity-ratchet.md), not here. When the module
   would hold state or lifecycle operations for a resource that has a record here, read that
   record first: it names the owner to extend, and adding a second machine is a record change
   (see [How to change this registry](#how-to-change-this-registry)).

## Terms

- **Owner, requester, reader:** as in principle 1. A **target single owner** is where the
  consolidating phase moves ownership; `owner-in-place` records already have it.
- **Lifecycle operations:** the calls that change the resource (start, stop, resume, close,
  write, retry). The resource-ownership guard counts only some callers today: page-lock claims,
  `SKIP_WAITING` sends, AudioContext `resume()`/`suspend()`, armed
  `beginTrustedSystemAudioReception` starts, the Worker broadcast endpoint, the duration
  reader in `cloudflare/`, the Developer API authority fence writers and the header loader's
  default-holder writers. See [what it does not check yet](#resource-ownership-guard).
- **Deadline owner:** the module allowed to time out an attempt on the resource.
- **Timing-constant home:** the module and constant names that hold the resource's timing values.
- **Anchor tests:** the tests that pin the four cancellation cases: supersession (a newer attempt
  or identity wins), user pause/stop (explicit user intent beats automation), teardown (session
  end, room switch, destroy; for Workers, decommission or isolate restart) and visibility (hidden
  page, background return). `missing` means no such test exists yet; `n/a` means the case cannot
  occur for that resource.
- **Status:** `duplicated` (two or more independent machines still hold state or lifecycle
  operations on the resource; a phase consolidates it, or an owner decision has to come first, as
  for RO-26's fullscreen request chains), `owner-in-place` (one owner exists; the record tells new work which owner to
  extend) or `accepted-exception` (a deliberate duplicate, drop or deferral, with its evidence and
  what would reopen it). Exception records name a parent record and inherit its other fields. A
  primary record can itself be `accepted-exception` by design (RO-11): it keeps the full record
  fields and names no parent.

## Consolidation phases

The 2026-10-22 structural plan, kept in the owner's working notes, consolidates the records in
phases. Each phase starts only on its own owner decision; on 2026-10-22 the owner approved Phase 0
and the fix lane. Plan step identifiers (for example C1-I1) appear in parentheses for traceability;
each record also states the step in words.

| Phase    | Scope                                                                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fix lane | G5 PRO LAN-direct listener silent after its 30 s watchdog; G6 PRO SFU retry re-running the reception start; G7 gesture resume slower than 750 ms left awaiting clock verification. Each is its own train with a failing test first |
| 0        | 0a this registry; 0b the resource-ownership guard; 0c tests-only harnesses on unchanged code; 0d shared constants (one app train, then one PRO room release)                                                                       |
| 1        | Server owners in the PRO room Durable Object and App Worker (runs only between app trains)                                                                                                                                         |
| 2        | Navigation, page lock and UI shells (fullscreen, playlist, account)                                                                                                                                                                |
| 3        | Service-worker update machine                                                                                                                                                                                                      |
| 4        | Standard transport liveness, bulk lanes and local output rejoin                                                                                                                                                                    |
| 5        | System-audio receive slot                                                                                                                                                                                                          |
| 6        | YouTube start, arm protocol and iframe audio                                                                                                                                                                                       |
| 7        | AudioContext output recovery                                                                                                                                                                                                       |

**Release batching (owner decision, 2026-10-23).** Phase 1 changes only the Workers, so it releases per step and users see no app update dialog. In Phases 2 to 7, small app increments merge to main but ship as at most one app update per phase, and never more than 7 days after the first merged increment, so users see about 6 to 8 updates instead of about 20. Phase 3 needs one extra ordinary release to prove the new update path. Holding everything until Phase 7 was rejected: one large release is hard to attribute and roll back, it blocks hotfixes, and it delays device checks. A change to both the PRO room and App Workers ships with target `all`, because the partial-release gate blocks either Worker alone while the other has undeployed source (seen on 2026-10-23 with the Phase 0d server constants). Each batch gets one report and its device checks. Phase 4 is the one exception (owner decision P4-D3 A, 2026-10-24): it ships two app updates, train 4A (behaviour-neutral restructuring) and train 4B (risky or behaviour-changing increments). Owner decision 2026-10-25 (about 01:50 KST) replaces the timing parts: every train deploys as soon as its automated gates pass (local checks, review, PR CI, Codex, exact-main CI, release smokes), with no 7-day spacing and no wait for device rounds, so 4B no longer waits 7 days after 4A or for 4A's device round. Device evidence no longer gates code; each train report states what was not device-checked. The same decision moves C5-6, C5-7 and C5-8 into their own train after 4B, so Phase 4 ships three app updates: train 4C carries C5-6, C5-7, C5-8 and the connection part of C5-10, and C5-9 first stayed out of Phase 4 ([Phase 4 train 4C report](phase4-4c-link-liveness-2026-10-25.md#오너-결정)). After known-accepted #18 retired, owner decision 2026-10-25 (about 16:30 KST) adds a fourth app update, train 4D: C5-9 (the side route's outage deadline moves into the link-liveness owner, RO-15) and its ratchet, with a forward revert to the 9.0.10 side-route behaviour if the owner's later device check fails ([Phase 4 train 4D report](phase4-4d-side-route-owner-2026-10-25.md#오너-결정)). Phase 5 also ships two app updates (owner decision P5-D3 A, 2026-10-25): train 5A moves the system-audio receive slot without changing behaviour (C4-1 to C4-8 and C4-12, with C4-6 and C4-7 inside it because every today-behaviour and gap test of the four receive-slot contract suites stays green), and train 5B carries the behaviour changes the owner picks, each with its failing test first ([Phase 5 train 5A report](phase5-5a-receive-slot-2026-10-25.md#오너-결정)).

## Index

| ID    | Resource                                                 | Area           | Status             | Consolidation                  |
| ----- | -------------------------------------------------------- | -------------- | ------------------ | ------------------------------ |
| RO-01 | AudioContext running state                               | Audio          | duplicated         | 0d, 7; fix lane G7             |
| RO-02 | YouTube Standard shared start                            | YouTube        | duplicated         | 0d, 6                          |
| RO-03 | YouTube arm protocol, Standard and PRO copies            | YouTube        | duplicated         | 0d, 6                          |
| RO-04 | System-audio receive slot                                | System audio   | duplicated         | Fix lane G5, G6; 0d, 5A, 5B    |
| RO-05 | Guest YouTube re-align retry chains                      | Output rejoin  | duplicated         | 4 (C3-I1); exception RO-48     |
| RO-06 | Host shared start, playlist queue and guided demo        | Output rejoin  | duplicated         | 4 (C3-I1); exception RO-49     |
| RO-07 | PRO signaling broadcast delivery                         | Workers        | owner-in-place     | Done (0d, 1)                   |
| RO-08 | PRO asset duration read                                  | Workers        | owner-in-place     | Done (0d, 1)                   |
| RO-09 | Owner-transfer saga row                                  | Workers        | owner-in-place     | None                           |
| RO-10 | Local-file source node restart                           | Output rejoin  | owner-in-place     | Done (4, C13 docs)             |
| RO-11 | Deferred-start mailbox `playback.pendingPlayTime`        | Playback       | accepted-exception | None (by design)               |
| RO-12 | YouTube iframe audio state                               | YouTube        | duplicated         | 6                              |
| RO-13 | YouTube manual-offset transaction                        | YouTube        | owner-in-place     | None                           |
| RO-14 | YouTube iframe instance lifecycle                        | YouTube        | owner-in-place     | None                           |
| RO-15 | Standard logical data connection liveness                | Transport      | owner-in-place     | Done (4, C5-1 and C5-6 to 10)  |
| RO-16 | Data-PC SDP lane                                         | Transport      | owner-in-place     | Done (4, C5-6)                 |
| RO-17 | Host per-guest connection close                          | Transport      | duplicated         | 4 (C5-1 and C5-8 done)         |
| RO-18 | Host-to-guest bulk lanes                                 | Transfer       | duplicated         | 4 (C5-3, C5-11 reduced, C5-12) |
| RO-19 | Guest fetch of the current track                         | Transfer       | owner-in-place     | Done (4, C5-3)                 |
| RO-20 | PRO system-audio lease and publication                   | System audio   | owner-in-place     | None                           |
| RO-21 | PRO checkpoint re-apply after a disruption               | PRO room       | owner-in-place     | Done (5B, C4-13)               |
| RO-22 | Waiting service worker activation                        | Page lifecycle | duplicated         | 0d, 3                          |
| RO-23 | App-owned page navigation                                | Page lifecycle | duplicated         | 0d, 2                          |
| RO-24 | `inert` page lock                                        | Page lifecycle | owner-in-place     | Done (2, C6-11)                |
| RO-25 | Developer API authority fence row                        | Workers        | owner-in-place     | None (D5 open)                 |
| RO-26 | Top-document fullscreen state                            | UI             | duplicated         | 2 done; requests: decision     |
| RO-27 | Playlist rows and scroll position                        | UI             | owner-in-place     | Done (2)                       |
| RO-28 | Account session reads and refresh pulses                 | Account        | owner-in-place     | Done (2)                       |
| RO-29 | PRO presence heartbeat timer slot                        | PRO room       | owner-in-place     | Done (4, C5-2)                 |
| RO-30 | Back-button history entries                              | Page lifecycle | owner-in-place     | Done (2, C6-12)                |
| RO-31 | Presence delivery does not re-arm the playback outbox    | Workers        | accepted-exception | Revisit on EPOCH_STALE logs    |
| RO-32 | Two R2 duration readers                                  | Workers        | accepted-exception | Revisit on a coupling defect   |
| RO-33 | Guest YouTube recovery stays its own owner               | YouTube        | accepted-exception | Revisit with device evidence   |
| RO-34 | PRO YouTube arm adapter stays eager                      | YouTube        | accepted-exception | Revisit with an iOS proof      |
| RO-36 | Failed-PLAY confirm closure stays on the bus             | Audio          | accepted-exception | Revisit in Phase 7             |
| RO-37 | Defensive retry-versus-semantic branch stays in `app.ts` | Audio          | accepted-exception | Revisit in Phase 7             |
| RO-39 | Two Cloudflare Realtime control clients                  | System audio   | accepted-exception | Revisit after a build check    |
| RO-42 | PRO-only capture policy stays eager                      | System audio   | accepted-exception | Revisit after a build check    |
| RO-43 | Update prompt stays eager                                | Page lifecycle | accepted-exception | None (C6-15 rejected)          |
| RO-44 | AudioContext native-call guard is syntactic              | Audio          | accepted-exception | Phase 7                        |
| RO-45 | No guard for new module-level lifecycle slots            | All            | accepted-exception | After the first guard round    |
| RO-46 | Invalidation events are sent once                        | Workers        | accepted-exception | Owner decision                 |
| RO-47 | Header loader `_default` holder                          | UI             | owner-in-place     | Done (2)                       |
| RO-48 | Guest YouTube re-align lanes stay two                    | Output rejoin  | accepted-exception | Revisit with device evidence   |
| RO-49 | Queue and demo start anchors stay two                    | Output rejoin  | accepted-exception | Revisit on an anchor defect    |
| RO-50 | App build floor                                          | Workers        | owner-in-place     | None                           |
| RO-51 | Return-from-background dialog                            | Page lifecycle | duplicated         | One slot on a 4th requester    |
| RO-52 | PRO browser completion final object                      | Workers        | owner-in-place     | Revisit on copy diagnostics    |
| RO-53 | PRO browser receipt ledger                               | Workers        | owner-in-place     | None                           |

## Machine-readable ID list

The fenced block tagged `resource-ownership` below is the machine-readable copy of the index. The
registry has exactly one such block. It holds one line per record, `RO-NN status`, in ascending
ID order with no repeats; `status` is one word: `duplicated`, `owner-in-place` or
`accepted-exception`. The resource-ownership guard reads the block and fails unless:

- the block lists the same IDs, in the same order, as the `### RO-NN` record headings;
- each record has a `- **Status:**` field inside its own section (from its heading to the next
  record heading or `##` heading), and that field's first word, with backticks and surrounding
  punctuation stripped, equals the block status;
- the index has a row for every block ID, with a Status cell equal to the block status, and no row
  for an ID the block lacks;
- every record ID the guard's own manifests name has a block line.

```resource-ownership
RO-01 duplicated
RO-02 duplicated
RO-03 duplicated
RO-04 duplicated
RO-05 duplicated
RO-06 duplicated
RO-07 owner-in-place
RO-08 owner-in-place
RO-09 owner-in-place
RO-10 owner-in-place
RO-11 accepted-exception
RO-12 duplicated
RO-13 owner-in-place
RO-14 owner-in-place
RO-15 owner-in-place
RO-16 owner-in-place
RO-17 duplicated
RO-18 duplicated
RO-19 owner-in-place
RO-20 owner-in-place
RO-21 owner-in-place
RO-22 duplicated
RO-23 duplicated
RO-24 owner-in-place
RO-25 owner-in-place
RO-26 duplicated
RO-27 owner-in-place
RO-28 owner-in-place
RO-29 owner-in-place
RO-30 owner-in-place
RO-31 accepted-exception
RO-32 accepted-exception
RO-33 accepted-exception
RO-34 accepted-exception
RO-36 accepted-exception
RO-37 accepted-exception
RO-39 accepted-exception
RO-42 accepted-exception
RO-43 accepted-exception
RO-44 accepted-exception
RO-45 accepted-exception
RO-46 accepted-exception
RO-47 owner-in-place
RO-48 accepted-exception
RO-49 accepted-exception
RO-50 owner-in-place
RO-51 duplicated
RO-52 owner-in-place
RO-53 owner-in-place
```

## Resource records

### RO-01 AudioContext running state

- **Resource:** the singleton AudioContext's native running or suspended state, its suspend
  leases, its `statechange` listeners and the one-shot foreground clock-health incident.
- **Current owners/flows:** the play-request foreground restart in `src/audio/context.ts`
  (`prepareForegroundAudioContextRestart*`, `resumePreparedForegroundAudioContextRestartFromGesture`,
  phase union `ForegroundRestartPhase`) and playback-scope interruption recovery in
  `src/audio/context-recovery.ts` (`bindAudioContextInterruptionRecovery`,
  `resumePendingAudioContextInterruptionFromGesture`, phase union `RecoveryPhase`). Each keeps its
  own suspend lease and `statechange` listeners. `src/app.ts` sequences both in the recovery
  dialog, and `src/player/media-session.ts` repeats the same gesture sequence (resume, requirement,
  probe, escalate, confirm, rejoin). `src/audio/ui-sounds.ts` resumes the context, only while it
  is not running, on a trusted pointerdown or Enter or Space keydown and before it plays a UI
  sound, without asking either owner.
- **Target single owner:** `src/audio/context-recovery.ts` as the only native resume and suspend
  owner; `context.ts` keeps the singleton.
- **Allowed requesters:** `ensureRunning` callers (transport, decode, engine) and
  `probeAudioContextHealth` (defined in `context.ts`; called from `output-health.ts`, `app.ts`,
  `media-session.ts`, `context-recovery.ts` and `src/player/transport.ts`) may resume only a
  context the owner does not hold; the recovery dialog and media session call the owner's gesture
  functions; UI sounds ask the owner before resuming.
- **Lifecycle operations:** native `resume()` and `suspend()` (today in `context.ts`,
  `context-recovery.ts` and `ui-sounds.ts`), suspend lease create, settle and abandon,
  clock-health arm and consume, confirm, retire and cancel.
- **Deadline owner:** each machine times its own gesture resume (750 ms) and suspend preparation
  (500 ms). Fix lane G7: once that deadline has returned the gesture caller, the playback-scope
  owner verifies a late `running` itself (`handleNativeResumeSettlement`), and its visible edge
  verifies an attempt of either cause still awaiting clock verification
  (`continueRecoveryInForeground`). Both use the owner's existing automatic probe, with no new
  timer.
- **Timing-constant home:** none shared. `context.ts` holds `AUDIO_RESUME_DEADLINE_MS`,
  `FOREGROUND_SUSPEND_PREPARE_DEADLINE_MS`, `FOREGROUND_GESTURE_RESUME_DEADLINE_MS`,
  `FOREGROUND_LATE_SUSPEND_FENCE_MS`, `MAX_FOREGROUND_SUSPEND_ATTEMPTS`; `context-recovery.ts`
  repeats them as `SUSPEND_PREPARE_DEADLINE_MS`, `SUSPEND_WATCHDOG_MS`,
  `MAX_SEMANTIC_SUSPEND_ATTEMPTS`, `RESUME_DEADLINE_MS`; `app.ts` adds inline 1 s and 5 s waits.
  Target: a leaf `src/audio/context-protocol.ts` (Phase 0d, C1-I1).
- **Anchor tests:**
  - Supersession: `src/audio/__tests__/context-recovery.test.ts` "does not transfer a gesture
    recovery after the playback identity changes"; `src/audio/__tests__/context-health.test.ts`
    "keeps a retired late gesture resume inert against a successor restart".
  - User pause/stop: `context-recovery.test.ts` "drops a pending rejoin when the room pauses
    during interruption"; `src/audio/__tests__/audio-context-ownership.test.ts` "a user pause
    before a late resume settles retires the attempt" (G7).
  - Teardown: `context-recovery.test.ts` "does not transfer a late gesture recovery after its exact
    binding is disposed".
  - Visibility: `context-recovery.test.ts` "never calls native resume while hidden without active
    playback"; `audio-context-ownership.test.ts` "a late resume … that settles while hidden is
    verified on the visible edge" (G7).
  - Missing: both machines and UI sounds together; no unit test imports `app.ts`.
- **Status:** `duplicated`. Phase 0d (shared constants), Phase 7 (one lease, one `statechange`
  dispatcher, owner gesture functions, UI sounds yield). Fix lane G7. Exceptions RO-36, RO-37,
  RO-44.

### RO-02 YouTube Standard shared start

- **Resource:** the single YT.Player (held in `src/youtube/_state.ts`) during a Standard-room
  shared start: mute, load, pause, seek, unmute, play.
- **Current owners/flows:** the zero-start controller `YouTubeZeroStartController`
  (`src/youtube/zero-start.ts`, phase union `YouTubeZeroStartPhase`); the guest local fallback
  (the `onFallbackRequired` closure in `src/youtube/player.ts`); the host legacy recovery
  (`recoverZeroStartWithLegacyRendezvous`, `player.ts`); the legacy rendezvous `scheduleYtAutoSync`
  (`player.ts`). They retire each other directly, `iframe.ts` dispatches player states to them in a
  fixed order, and `isYouTubeZeroStartSyncOwned` (`src/youtube/zero-start-ownership.ts`) answers
  for "both zero-start owners". The PRO direct commit (`applyProPlaybackYouTubeCommit`) and the
  replacement fallback also start this player; PRO arming is RO-03.
- **Target single owner:** one start ledger over the zero-start owner (planned
  `src/youtube/start-ownership.ts`); the host legacy recovery and the replacement fallback become
  owner stages; the guest recovery stays its own owner class holding its claim (RO-33).
- **Allowed requesters:** the load entry (`tryBeginYouTubeZeroStart`); readers through
  `isYouTubeZeroStartSyncOwned`: `src/youtube/sync.ts`, `src/network/sync.ts`,
  `src/ui/manual-sync-overlay-runtime.ts`, `src/ui/player-controls.ts`,
  `src/player/background-return-sync.ts`. `src/youtube/native-control-authority.ts` asks a
  hand-kept timer-name list (`hasProtectedTransitionOwner`); Phase 6 replaces timer-name queries
  with owner queries before any timer merge.
- **Lifecycle operations:** `loadVideoById` or `cueVideoById`, `pauseVideo`, `seekTo`, `mute` and
  `unMute`, `playVideo`, release acknowledgement, ABORT.
- **Deadline owner:** the controller (`prepareTimeoutMs` 10 s, `releaseAckTimeoutMs` 1.8 s); the
  guest fallback and host recovery time themselves with literals in `player.ts` (8 × 120 ms audio
  restore, 1.8 s release acknowledgement, 0.35 s settle, 50 ms polls).
- **Timing-constant home:** `YOUTUBE_ZERO_START_TIMING` (`zero-start.ts`), repeated as literals in
  `player.ts`. Target: `src/youtube/constants.ts` (Phase 0d, C2-1).
- **Anchor tests:**
  - Supersession: `src/youtube/__tests__/zero-start.test.ts` "unmutes on release when Sequence 2
    supersedes Sequence 1 while warming under hard mute".
  - User pause/stop: `src/youtube/__tests__/zero-start-heartbeat-ownership.test.ts` "retains
    external fallback on feedback but retires it for an explicit pause".
  - Teardown: `zero-start.test.ts` "transfers hard-mute ownership during teardown without a
    detached unmute".
  - Visibility: missing.
- **Status:** `duplicated`. Phase 0d (shared start timing), Phase 6 (start ledger, routed state
  events, shared arm steps, recovery as owner stages). The no-auto-retry Sync notice right after a
  zero-start stays ([known-accepted #14](../known-accepted.md)).

### RO-03 YouTube arm protocol, Standard and PRO copies

- **Resource:** the arm protocol on the same YT.Player: hard-mute wait, warm play, pause and seek,
  settle, audio restore, release.
- **Current owners/flows:** `YouTubeZeroStartController` (`src/youtube/zero-start.ts`) and the PRO
  copy `YouTubeAuthorityArmController` (`src/youtube/authority-arm.ts`, phase union
  `YouTubeAuthorityArmPhase`, instance `proAuthorityArm` in `src/youtube/iframe.ts`, driven by the
  `iframe.ts` prepare seam `prepareYouTubeAuthorityOccurrence` with its
  `proAuthorityPreparationGeneration` fence). Their arm and settle values (hard-mute poll, warm
  play, pause-seek gap, settle poll and epsilon, release acknowledgement) and most phase names are
  identical; their prepare budgets are not (10 s Standard, 2.3 s barriered PRO). `zero-start.ts`'s
  header still says it can serve a coordinator-free PRO endpoint although PRO uses the copy. Only
  the room kind separates them; `stopYouTubeMode` cancels both.
- **Target single owner:** shared arm steps used by both protocol shells; `authority-arm.ts` stays
  the PRO protocol facade with its own tokens.
- **Allowed requesters:** Standard: the zero-start wiring in `player.ts`. PRO: PREPARE through
  `prepareYouTubeAuthorityOccurrence` (`iframe.ts`, called from `src/player/playlist.ts`) and
  COMMIT through `commitYouTubeAuthorityOccurrence` (`iframe.ts`, called from
  `applyProPlaybackYouTubeCommit` in `player.ts`). Desired-audio pushes are RO-12 requesters.
- **Lifecycle operations:** as RO-02, plus detached audio restore and the re-seek on every sixth
  settle poll.
- **Deadline owner:** each controller. The PRO prepare deadline is set by the `iframe.ts` prepare
  seam, which passes its remaining budget to `proAuthorityArm.prepare`; `authority-arm.ts`
  `TIMING.prepareTimeoutMs` is only the fallback when no budget is passed. A server PREPARE gets
  the barriered 2.3 s, which leaves room inside the server's 3 s transition barrier; restores,
  catch-ups and participant-local rejoins get the unbarriered 10 s.
- **Timing-constant home:** arm and settle values: `YOUTUBE_ZERO_START_TIMING` and
  `authority-arm.ts` `TIMING` (copies). PRO prepare budgets:
  `PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS` (2.3 s, repeated as `authority-arm.ts`
  `TIMING.prepareTimeoutMs`) and the exported
  `PRO_YOUTUBE_UNBARRIERED_PREPARE_TIMEOUT_MS` (10 s, equal to the Standard `prepareTimeoutMs`,
  imported by `playlist.ts`), both in `iframe.ts`; these are the effective values. Target:
  `src/youtube/constants.ts` (Phase 0d, C2-1).

  The PRO playback transition those budgets serve has its own home since Phase 5.5,
  `cloudflare/pro-room-playback-timing.ts`. The PRO Worker imports the barrier
  `PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS` (3 s) and the COMMIT lead
  `PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS` (700 ms); the App imports only the start-kind union
  `ProRoomPlaybackTimingMode` (its `ProPlaybackTimingMode`, a type-only import). The file is on
  both the pro-room and the app runtime
  paths, so a release that changes it targets `all`. Kept out of it on purpose:
  - the zero-start encoding of PRO Workers before PRO snapshot schemaVersion 2, one below each
    value: a 2999 ms stored deadline and a 699 ms COMMIT lead. The Worker and the App dropped it
    in different releases: the Worker stopped writing it when it started to send schemaVersion 2,
    the App stopped reading the 699 ms lead when it stopped accepting schemaVersion 1, and the
    PRO-only release after that stopped reading the 2999 ms deadline (a stored transition that
    names no kind loads and commits as `scheduled-control`, `cloudflare/pro-room-worker.ts`).
    A shared export would have gone dead in between, which `guard:dead-exports` refuses, and
    would have turned those PRO-only and App-only releases into `all`. The home's header comment
    still says each side keeps the encoding in its own file; it is corrected by the next release
    that targets `all` anyway, because changing that file alone would make a PRO-only or
    App-only release `all`;
  - the App's own budgets in `playback-controller.ts` that only share a value: the clock wait of
    a COMMIT that arrives without a current server clock (`PLAYBACK_COMMIT_CLOCK_WAIT_MS`,
    700 ms), the lead of a participant-local reconciliation
    (`PLAYBACK_RECONCILIATION_RENDEZVOUS_LEAD_MS`, 700 ms) and the late YouTube rejoin threshold
    and minimum lead (`LATE_YOUTUBE_COMMIT_THRESHOLD_MS` 1.5 s, `LATE_YOUTUBE_COMMIT_LEAD_MS`
    3 s). Each measures the device's own remaining time (`executeAtMs` against the server clock
    once the wait ends; measured iframe preparation for a rejoin), so none becomes wrong when the
    Worker's lead or barrier changes. `node scripts/check-resource-ownership.mts --report` lists
    the three that share a value with the home as report-only pairs: the two 700 ms budgets with
    the COMMIT lead and the 3 s minimum lead with the barrier. The 1.5 s threshold shares no value
    with the home and is not listed.

  The ordering test that the barriered 2.3 s fits inside the 3 s barrier waits for Phase 0d C2-1,
  which moves 2.3 s to `src/youtube/constants.ts`: until then it is a module constant of
  `iframe.ts` and `authority-arm.ts`, and a test-only export is not allowed.

- **Anchor tests:**
  - Timing home: `src/pro-room/__tests__/pro-room-playback-timing.test.ts` (the barrier and the
    lead and no other value, one start-kind union in the Worker and the App). Its row "keeps the
    copy App suites read, which load no Worker code, equal to the home" is the parity test of
    `src/pro-room/__tests__/__helpers__/pro-room-playback-timing-copy.ts`, name for name and
    value for value. A suite that loads `cloudflare/` code belongs to the Worker coverage profile
    (`src/core/__tests__/ci-quality-gates.test.ts`), so an App suite that models a PREPARE or a
    COMMIT reads the barrier and the lead from the copy. Only the late YouTube join pins of
    2026-10-30 do so today: `playback-late-cohort-join.test.ts`,
    `pro-late-prepare-reload.test.ts` and the "PRO late cohort join (pinned 2026-10-30)" blocks
    of `authority-arm.test.ts` and `pro-manual-zero-start.test.ts`. Older App suites and rows
    that model a PREPARE or a COMMIT, the other rows of those last two among them, still retype
    3000 and 700: they are not tied to the home and stay green when it changes. The same pins
    read the App's own late-join values from
    `src/pro-room/__tests__/__helpers__/pro-late-youtube-join-timing.ts`, a copy of module
    constants their homes do not export (a test-only export is not allowed); a value leaves the
    copy once its home exports it. These rows run the real home and pin the copy to it:
    - `playback-controller.ts` `LATE_YOUTUBE_COMMIT_LEAD_MS`: `playback-late-cohort-join.test.ts`
      "(c) joins a failed-READY device 3 s after COMMIT on the server clock, mid-track, as a
      scheduled control".
    - `playback-controller.ts` `LATE_YOUTUBE_RELEASE_TOLERANCE_MS`: the same file's "(d) releases
      a device ready %i ms after executeAt from its transition without a catch-up" and "(d)
      re-arms a device ready 41 ms after executeAt for a mid-track join 3 s later".
    - The arm tolerance that it mirrors, `authority-arm.ts` `TIMING.catchUpToleranceMs`:
      `authority-arm.test.ts` "(d) releases a commit $lateMs ms past its prepared 0:00 target
      with $seeks seek".
    - `authority-arm.ts` `TIMING.releaseAckTimeoutMs`: `authority-arm.test.ts` "(b) pauses an
      unacknowledged release after exactly 1.8 s without re-muting it".
  - Supersession: `src/youtube/__tests__/authority-arm.test.ts` "supersedes a prepared occurrence
    when the iframe instance is replaced".
  - User pause/stop: `authority-arm.test.ts` "cancels a long negative-offset wait before a pause or
    room teardown can be undone".
  - Teardown: `authority-arm.test.ts` "revokes detached audio retries on an external teardown".
  - Visibility: missing.
  - Missing: a parity table running both controllers on the same scenarios; a direct room switch
    without stop-mode is untraced (Phase 0c).
- **Status:** `duplicated`. Phase 0d (shared constants), Phase 6 (shared arm steps, PRO arm through
  the owner's audio state with distinct tokens). Exception RO-34.

### RO-04 System-audio receive slot

- **Resource:** the device-wide receive slot: `systemAudio.isReceiving`, the `'system-audio'`
  playback owner claim and its placeholder meta, the restore meta, the source node on
  `widener.input`, the decoder primer and the receive deadline.
- **Current owners/flows:** the receive slot `src/network/system-audio-receive-slot.ts` (Phase 5
  C4-2) owns the trusted reception: the reception generation that fences the routes'
  trust-boundary waits (`awaitTrustedSystemAudioReceptionBoundary`), the start
  (`beginTrustedSystemAudioReception`, which runs `stopAllMedia`, takes the restore meta and
  claims the `'system-audio'` placeholder), the 30 s receive watchdog, the delivery-handoff
  interrupt and the end of reception (`endTrustedSystemAudioReception`, which restores the title
  only while the slot still holds the placeholder or the `'system-audio'` owner; since 5B-G4 not
  over the sharer's own claim, and since 5B-G5 an end nested in a start before its claim keeps
  that start's restore point, below). A route joins
  every end through one port (`registerSystemAudioReceiveRoute`), which the end calls after
  taking the restore point and clearing the watchdog and before it drops the receiving flag; the
  Standard direct call is the only route with an end port. Since C4-6 the same port also carries
  a route's reaction to the receive deadline (`onDeadline`, below). Since C4-3 the slot also
  holds what a route attaches, per route: its decoder primer (`primeSystemAudioDecoder`, one per
  stream key), its source (`attachSystemAudioSource`: replace the route's previous source on
  `widener.input` and, on a reception's first attach, clear the watchdog, set the receiving flag,
  claim the `'system-audio'` owner and start the visualizer) and their release
  (`detachSystemAudioRoute`); `getSystemAudioReceiveRouteSnapshot` answers whether a route
  attached a source or holds a primer. The Standard direct call attaches through it and keeps
  its call identity, its early prime, the unmute wait, the trust-boundary wait, the playout
  hint and its own `await initAudio()` with the call re-check (the attach is synchronous, so no
  await separates that re-check from the graph); its end port detaches the route. Each route
  names which attach starts the reception: the direct call's first while the slot is not
  receiving (`'first-for-slot'`), the Standard SFU's first since its route was last detached
  (`'first-for-route'`), so each SFU subscription starts the reception and its two-hour limit
  again even while a re-publication keeps the receiving flag set. Since C4-4 the Standard SFU
  guest (`src/network/system-audio-sfu.ts`) attaches through the same slot attach: it keeps its
  Realtime subscription, the subscriber-PC identity, the trust-boundary wait, the playout hint,
  its own `await initAudio()` with the PC re-check, the two-hour receive limit per subscription
  (armed from the attach that starts the reception) and the frozen share route; it primes its
  track and reports a context that is not running once the slot confirms the graph, and its
  `cleanupGuestSfu` detaches the route and ends the reception only when its subscription
  attached (`getSystemAudioReceiveRouteSnapshot`). The SFU does not join the end port: an end
  leaves its transport, source and primer to that cleanup, as before. Since 5B-G3 (owner
  decision P5-D5 A, gap 1) a failed subscription with no successor (its subscribe with no
  pending READY, or its subscriber PC's `'failed'` state) goes through one helper
  (`failGuestSfuSubscription`): when it attached nothing while the slot is receiving, it
  continued a reception a re-publication left playing (the re-publication's
  `cleanupGuestSfu(false)` keeps the receiving flag), so it hands that reception off (the
  placeholder and restore point stay, receiving drops, the slot deadline is armed from the
  failure, and a READY within it still attaches; otherwise the deadline's `receive_failed` and
  the previous title follow). Before, the guest stayed playing in silence with no deadline and
  no notice until STOP. Any other failure cleans up as before: an attached subscription ends
  the reception (gap 8), and a failed first subscription leaves the start's deadline to end it
  (gap 13). The handoff was chosen over an immediate end with `receive_failed`: it is the
  existing Standard SFU semantic for a failed subscription that continues a reception (the
  handoff to a pending READY), it matches gap 13 (left as is), a later READY within the 30 s
  still attaches, and it adds no timer, notice or frame. The Standard routes exclude each other
  (a direct call retires the SFU route before it attaches, and a direct-failure READY ends the
  direct reception before it subscribes), so a receiving flag there is the SFU's own. Since C4-5 the PRO
  coordinator (`src/pro-room/system-audio-service.ts`) is a slot input too, as one route
  (`'pro-coordinator'`) for both of its transports, because it held one source and one primer
  whichever transport (PRO SFU or LAN-direct, `src/network/pro-system-audio-direct.ts`)
  delivered the track. `attachCoordinatorTrack` keeps the trust-boundary wait, its own
  `await initAudio()` and the publication, descriptor and owner re-checks, then attaches through
  the slot attach with `'every-attach'` (every coordinator track starts the reception again,
  as before), priming its track once the slot confirms the graph and clearing its direct receive
  deadline once the source is connected; it logs no connected line. The SFU `'subscribed'` state
  resumes the route (`resumeSystemAudioRoute`: the reception start again only while the route
  still has a source). Since 5B-G1 (owner decision P5-D5 A, gaps 2 and 3) the attach and the
  resume are fenced in the slot: a route attaches or resumes only while the slot's receive
  placeholder is the current meta (a STOP, a force-stop, a deadline expiry and a share end
  restore the previous title, and a successor owner sets its own meta). The fence reads only the
  placeholder, not the slot's phase, and comes before the graph: a refused attach returns
  `'not-receiving'` (the attach's result is
  `'attached' | 'not-receiving' | 'graph-unavailable'`, where it returned a boolean), writes
  nothing and drops the route's source
  and primer, and a refused resume claims nothing and drops them too. No route ends the reception,
  throws or notifies on a refusal: the Standard direct call stays open and current and drops its
  replacement deadline (a guest close would make the host hand the guest to the SFU with STOP,
  START and READY, whose START stops a successor; STOP or the end closes it), the Standard SFU
  closes its subscription as for the trust boundary's refusal (the share route stays frozen),
  and the PRO coordinator closes a refused SFU track's subscription for that publication
  (since 5B-G2, below) and keeps a LAN-direct route open. Accepted with the fence (the 5B-G1
  plan's risk, confirmed in review): a meta-null writer can remove the placeholder while a
  Standard guest still receives (the current-item removal in `player/playlist.ts`: removed,
  emptied or rebased). If a replacement direct call's attach is then refused, the slot drops the
  previous call's source but leaves `systemAudio.isReceiving` set and the guest drops the
  replacement deadline, so the share reads as playing, silent and with no deadline, until the
  host's STOP. The host's own removal stops its capture first (a removal plays a successor or
  empties the queue, and a START needs queue authority), so that window is about one round trip.
  `'graph-unavailable'` keeps each route's throw and policy. The disconnect grace, a retry and a receiver fallback (and
  since 5B-G6 the SFU subscriber's budget expiry, below) interrupt the slot with
  `deadline: 'route'` (`interruptTrustedSystemAudioReception`: the
  receiving flag drops
  and no watchdog is armed, because the coordinator owns its deadlines); the retry, the
  fallback and the budget expiry detach the route first, the disconnect grace keeps the source.
  The coordinator's
  cleanups detach the route, and its direct receive deadline asks the slot whether the route
  attached a source. It keeps the subscription key, the same-publication retry that skips the
  start (G6), the direct receive deadline with its five releases (since 5B-G2 the route end
  below clears it too, repeating the force-stop listener's release; an SFU key never has it
  armed) and the order in which a LAN-direct start arms it after the start, and registers no
  end port: an end leaves its source, primer and subscription to the coordinator's own
  cleanups. Since 5B-G2 (owner decision P5-D5
  A, gaps 4 and 5) one of those cleanups ends the route when the reception of an unchanged
  publication ends: the coordinator's `system-audio:force-stop` listener (while it holds a
  remote publication's key) and a refused SFU track of the live publication (the trust
  boundary's refusal or the attach fence, while the subscriber still delivers it) clear the
  pending retry, the disconnect grace and the direct receive deadline, detach the route, drop
  the subscribe in flight, stop the SFU subscriber and mark the publication ended
  (`coordinatorEndedKey`). The SFU branch of the reconcile then subscribes and begins nothing
  for that publication (a heartbeat, a room-context re-emission or a retry), the reconcile and
  retry catches treat the subscribe that stop aborted as no failure (no warn, notice or retry),
  and every key change clears the mark (`cleanupCoordinatorGraph`), so a new publication is
  never blocked. A force-stop nested in the coordinator's own start (its `stopAllMedia` while
  local capture runs) leaves that start alone: a depth counter in a `try`/`finally` around each
  of the two direct starts tells it apart, and the listener then only clears the direct receive
  deadline, as before. The LAN-direct receiver route stays open after a force-stop or a refused
  direct track, by choice: a silent local close would make the publisher fail the whole share
  over to the SFU, a `'stopped'` close would invite a re-offer on the next publisher reconcile,
  and the open route carries no Cloudflare traffic; a re-offered track meets the attach fence.
  On a force-stop the route's source and primer drop all the same, and the route stays open
  until the publication changes or ends or the room resets. Two cases stay as they were before
  5B-G2, accepted with that choice and outside gaps 4 and 5: a receiver fallback of that open
  route after a force-stop still shows `connection_unstable` once (its handler does not read the
  ended mark), and a refused resume (a `'subscribed'` after another owner replaced the
  placeholder of an attached SFU reception) drops the source and primer but leaves the SFU
  subscription open until the publication changes, since of the refusals only a refused attach
  and the boundary's refusal end the route. Since C4-6 (owner decision P5-D7 A) the two bus
  pairs the routes shared are slot inputs, and every start and interrupt names its deadline
  kind (`ReceiveDeadline`, replacing
  the `receiveWatchdog` boolean): `'slot'` arms the slot's 30 s deadline (the host START and the
  Standard SFU after a direct-route failure), `'route'` arms none (the PRO coordinator's two
  starts and three interrupts; four since 5B-G6, which added the SFU budget expiry). A Standard SFU delivery handoff (a failed subscription handing
  over to a pending READY, since 5B-G3 a failed re-subscription that attached nothing while the
  slot is receiving, or a direct call replacing the SFU) calls
  `handOffTrustedSystemAudioReception`, which interrupts under the slot deadline while the
  placeholder is up; the SFU keeps the guest-role check (`isGuestSfuReceiver`) the guest's
  `system-audio:delivery-handoff` listener made. The slot deadline and the direct call's
  replacement deadline each log their line and call `expireTrustedSystemAudioReception`: every
  registered route's `onDeadline` runs first, then the end of reception, then
  `receive_failed`, the order the `system-audio:receive-timeout` emit, the end and the toast
  had. A reaction that throws is logged at error level and the expiry goes on, as the bus
  contained a throwing listener. The Standard SFU registers an `onDeadline` (from
  `registerSystemAudioSfuListeners`, where its bus listener was; since C4-7 the same port also
  carries its `retire`, below) and no `endReception`: as a guest it drops its subscription
  (`cleanupGuestSfu()`); the fan-out still reaches no other route. Both bus events are gone from the event map. The timer
  names (`sys-audio-guest-*`) are unchanged. Since C4-7 the PRO coordinator imports neither
  Standard adapter (`system-audio-guest.ts`, `system-audio-sfu.ts`): it starts, waits on and
  ends a reception through the slot, its end behind the `!latestView.isLocalOwner` guard in
  `cleanupCoordinatorGraph` (the `'system-audio'` owner is also a local share's claim; since
  5B-G4 widened by the slot's query, below), which `resetProSystemAudioService` still runs
  before it forgets the local owner; it reads the
  receive deadline from its home (`DIRECT_RECEIVE_DEADLINE_MS`); and it retires the Standard SFU
  route through the slot's adopt (`adoptSystemAudioReceiveRoute('pro-coordinator')`, where it
  called the SFU adapter's cleanup: the room turning PRO and a retry's cleanup; 5B-OV1 removed
  the one at the top of every live reconcile, a coordinator-era remnant with nothing to retire:
  a PRO room starts no Standard SFU subscription, since `network.hostConn` stays null there and
  the Standard SFU adapter refuses a READY). The adopt runs every other registered route's
  `retire` and changes nothing in the slot itself; the Standard SFU registers one (its
  subscription through `cleanupGuestSfu(false)` and its frozen share route, no reception end),
  and no other route has one. Since C4-8 no route reaches the slot through another: `src/network/system-audio-guest.ts`
  no longer re-exports the slot's start, trust-boundary wait and end (the last as
  `cleanupGuestSystemAudio`), the Standard SFU imports them from the slot, and the guest keeps
  the host START/STOP trust gate. Since 5B-G4 (owner decision P5-D5 A, gap 6) the slot tells its
  own claim from the sharer's: the `'system-audio'` owner is also this device's own share, which
  `src/audio/system-capture.ts` claims with sharing meta (`systemAudioMode: 'sharing'`). The end
  still consumes the restore point, answers the waiters, clears the deadline, runs the route
  ports and drops the receiving flag, but writes the title, releases the owner and sets idle only
  while the placeholder is current or the `'system-audio'` owner's meta is not the sharer's; the
  sharer's claim is left to the capture module (the narrowest rule: any other state keeps its
  handling). The start never takes the sharer's meta as its restore point, whether the share is
  still claimed or its transition teardown left that title idle (`system-capture.ts` sets idle
  and keeps the meta), because restoring it after the received share would show "System Audio
  Sharing" while idle. A read-only query, `hasTrustedSystemAudioReception()` (a start claiming or
  holding its restore point, the placeholder current, or the receiving flag set), lets the PRO
  coordinator end the slot over this device's own publication only while the slot still holds a
  reception: its cleanup's guard keeps `playback.mode === 'system-audio'` and now reads
  `!latestView.isLocalOwner || hasTrustedSystemAudioReception()`, so the guard is unchanged for
  a listener's view. That is the S11 case, a sharing claim made while this device still received:
  before, the local-owner guard skipped the whole end and left the receiving flag set with no
  source and the restore point held for a later end to replay over the sharing meta. The end's
  rule itself applies to every caller, a listener's view included: a sharer's SFU publisher
  recovery releases the lease and acquires it again while capture keeps sharing, the release's
  idle view is not the local owner's, so the cleanup runs the end over the capture's claim, and
  capture is not told during that expected lease transition nor claims again after the
  re-commit. Before 5B-G4 that end released the claim and left playback idle with no title for
  the rest of the share; since 5B-G4 the sharer keeps its sharing title (pinned after the 5B-G4
  review, anchor tests below). The guard
  stays rather than going: every reconcile of the own publication (each 15 s heartbeat) runs
  that cleanup, and an unguarded end would bump the generation, cancel every waiter, run the
  route ports and stamp the `/debug sa` cleanup time on every heartbeat of a sharer. A stale held
  restore point on a sharer (a reception interrupted, then the sharing claim) is consumed with no
  title write at the next end, and a later start overwrites it. Since 5B-G5 (owner decision P5-D5
  A, gap 7) an end nested in a start before its placeholder claim (the start's `stopAllMedia`
  emits `system-audio:force-stop` while local capture runs, and the guest's listener ends the
  reception) ends what preceded that start, not the start: the slot stays `'claiming'` with the
  start's generation and restore point, so the start commits into `'held'`, its STOP or share end
  restores what it took, and a boundary wait opened after that end joins the start. The nested
  end still answers the open waiters (false, as before), clears the deadline, runs the route
  ports and drops the receiving flag, and writes no title, releases nothing and sets nothing
  idle, because the start claims the slot right after. Before, it consumed the start's restore
  point and moved the generation on, so the start's own end left no title and a wait opened
  after it joined a generation no start commits. Only an end before the claim is nested in this
  sense: one that lands once the placeholder is up (from a listener of the claim; none is known)
  ends that start as any end does. 5B-G4 comes first on purpose: a start over the sharer's title
  takes no restore point, so on a PRO device that was sharing (the only production path, which
  needs a second desktop sharer) the share end still leaves no title rather than "System Audio
  Sharing". The LAN-direct order part of gap 7 is kept: the coordinator arms its direct receive
  deadline after the start returns, so the nested force-stop cannot clear it, and the 5B-G2 depth
  counter keeps that force-stop from ending the new subscription. Since 5B-G6 (owner decision
  P5-D5 A, gaps 11 and 12) the coordinator hears two route closures. A LAN-direct publisher's
  `'stopped'` close (sent only from its explicit stop, before it releases the share) closes the
  current receiver route, live or not, and the transport now calls a new callback,
  `onLiveRouteStopped` (`ProSystemAudioDirectTransportCallbacks`, after `acceptClose` closed the
  route); the coordinator checks the live direct publication (generation, publication id, remote
  owner and its own key), clears the direct receive deadline, detaches its route and ends the
  reception while the slot still holds one (`hasTrustedSystemAudioReception()`; the end leaves a
  successor alone), with no notice. It keeps the publication key, so a heartbeat of the
  unchanged live state begins nothing again (the direct branch begins only on a key change, and
  no ended mark is needed), and the post-share restore still follows the server's idle state,
  because the view drives it; PRO room playback stays blocked while the view is live, so the
  early end starts nothing early. An end rather than an interrupt: an interrupt keeps the placeholder with receiving off, which shows the play button's loading
  spinner and reports the Media Session as paused on every LAN-direct listener until the idle
  state, a new visible state on the most common stop path; the end shows what the idle state
  shows, only earlier. `'superseded'` and a non-live `'fallback'` close the route only, as before.
  The PRO SFU subscriber's own budget expiry (its `'stopped'` event with an expired descriptor of
  the live remote publication) clears the disconnect grace, detaches the route and interrupts with
  `deadline: 'route'`, with no notice, keeping the placeholder and the key; the idle state then
  ends the reception, or, when it is late, the next heartbeat's refused subscribe (one
  `connection_unstable` and the no-network backoff,
  `system-audio-subscriber-watchdog.test.ts` "PRO SFU subscription that rejects synchronously",
  unchanged) comes first. Every PRO SFU descriptor carries the share's live budget
  (`liveExpiresAt`: two hours, or a promotion's fresh budget), the instant the server's alarm ends
  the share and the publisher's capture stops; the listener's timer needs no network hop, so it
  usually fires first at the normal end of every PRO SFU share that reaches its two-hour limit,
  promoted or not (also earlier when the listener's clock runs ahead, and long before a late idle
  state). Each SFU listener therefore shows the pending state (the play button's loading spinner,
  the play icon off, the Media Session reporting paused) from its budget until the idle state,
  usually about a second, where before 5B-G6 it showed the share playing in silence. An interrupt
  rather than an end there: the stop is the listener's own clock reading the budget, not a
  publisher or server signal, so the view still holds the share live; and an end would need the
  5B-G2 ended mark for an unchanged expired live state, so that a late heartbeat would not show
  `connection_unstable` over an idle slot, which would change that pinned retry path. P5-D5 A
  left end or interrupt to the plan, so an end with the ended mark stays a later option with no
  frame change; the device sheet has no two-hour share. The coordinator's own subscriber stops
  carry an unexpired descriptor or another publication, or come after its cleanup cleared the key
  or its route end marked the publication ended, so the handler ignores them; a retry's cleanup
  of an expired subscription detaches and interrupts the same way itself. The maintained contract
  is [System-audio receive ownership](system-audio-receive-ownership.md).
- **Target single owner:** the receive-slot module `src/network/system-audio-receive-slot.ts`
  (owner decision P5-D4 A, 2026-10-25; created in Phase 5 C4-2, deferred-only). Route adapters
  register and call begin, attach, interrupt, resume, detach, adopt and end; the later Phase 5
  increments move the attaches and the route cleanups into it (the bus pairs moved in C4-6, the
  PRO coordinator's retire of the Standard SFU route became the adopt in C4-7, and C4-8 removed
  the guest's compatibility aliases of the slot's names).
- **Allowed requesters:** the route adapters through the slot: the Standard direct call
  (`system-audio-guest.ts`), the Standard SFU guest (`system-audio-sfu.ts`) and the PRO
  coordinator (`src/pro-room/system-audio-service.ts`), which the PRO SFU and LAN-direct
  transports feed; those transports never call the slot. `src/audio/system-capture.ts` claims the `'system-audio'` playback owner for
  this device's own share (the sharer's claim, not a reception; the guard's CHECK 9 counts it
  apart, and since 5B-G4 the slot's end and start tell it apart by its sharing meta) and
  otherwise only emits `system-audio:*` events, as the Standard host does.
- **Lifecycle operations:** begin reception, attach, set receiving, claim the playback owner, arm
  or clear the receive deadline, interrupt, resume, detach, adopt, expire, cleanup with meta
  restore. Since 5B-G1 the attach and the resume pass the slot's fence first (the receive
  placeholder is the current meta) and a refused one detaches the route. Since 5B-G2 the PRO
  coordinator ends its route (and marks the publication ended) on a force-stop outside its own
  start and on a refused SFU track. Since 5B-G3 a failed Standard SFU re-subscription that
  attached nothing while the slot is receiving hands the reception off under the slot deadline.
  Since 5B-G4 the end leaves the sharer's claim (a `'system-audio'` owner with sharing meta)
  alone, the start takes no restore point over the sharer's title, and the PRO coordinator asks
  `hasTrustedSystemAudioReception()` before it ends the slot over its own publication. Since
  5B-G5 an end nested in a start before its placeholder claim keeps that start's claim,
  generation and restore point. Since 5B-G6 the PRO coordinator ends the reception on a
  LAN-direct publisher's `'stopped'` close and interrupts it on its SFU subscriber's budget
  expiry.
- **Deadline owner:** per route today, named at each start and interrupt since C4-6
  (`ReceiveDeadline`). Standard P2P: the 30 s receive watchdog, the receive slot's since C4-2
  (timer `sys-audio-guest-receive-watchdog`, the guest receive watchdog in the guard's
  findings; `deadline: 'slot'`), and the direct call's own replacement watchdog; both expire the
  reception through `expireTrustedSystemAudioReception`. PRO SFU: the subscription retry
  backoff (2.5 s doubling to 30 s); since 9.0.1 it begins without the slot deadline (G1;
  `deadline: 'route'` since C4-6, `receiveWatchdog: false` before). PRO LAN-direct: since 9.0.2
  it also begins with `deadline: 'route'`, and the service's direct receive deadline
  (`DIRECT_RECEIVE_DEADLINE_TIMER`, 30 s from `SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS`) only
  reports the failure once and keeps the listener in reception for a late track (G5).
  Standard SFU guests react to the slot's expiry through their `onDeadline` port (the
  `system-audio:receive-timeout` bus listener until C4-6).
  Target: one receive deadline per attempt in the slot.
- **Route parity (owner decision P5-D10 A, recorded in 5B-G1):** Phase 5 changes no parity
  between the routes; the differences below are kept on purpose. 5B-G2 and 5B-G6 completed the
  last two rows in their own changes. Since 5B-G6 the PRO SFU subscriber's own budget expiry
  interrupts the reception with no notice (gap 12), usually just before the server's idle state at
  every PRO SFU share's two-hour end, so PRO SFU listeners show the pending state briefly there.

  | Aspect                                              | Standard direct                       | Standard SFU                            | PRO SFU                                                                                | PRO LAN-direct                                              |
  | --------------------------------------------------- | ------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
  | Playout hint 0.5 s                                  | yes                                   | yes                                     | yes                                                                                    | none                                                        |
  | Initial unmute wait (2 s)                           | yes                                   | no                                      | no                                                                                     | no                                                          |
  | Decoder primer                                      | on arrival, before the trust boundary | once the slot confirms the graph        | once the slot confirms the graph                                                       | once the slot confirms the graph                            |
  | Which attach starts the reception                   | `first-for-slot`                      | `first-for-route`                       | `every-attach`                                                                         | `every-attach`                                              |
  | Deadline                                            | slot 30 s                             | slot 30 s                               | route: backoff 2.5 to 30 s                                                             | route: direct deadline 30 s                                 |
  | Deadline notice                                     | `receive_failed`, end                 | `receive_failed`, end                   | `connection_unstable` once per generation, placeholder kept                            | `connection_unstable` once per generation, placeholder kept |
  | Live route failure                                  | silent end (gap 8)                    | silent end (gap 8)                      | `connection_unstable`, retry                                                           | `connection_unstable`, fallback                             |
  | Failed first subscription                           | n/a                                   | silent until the slot deadline (gap 13) | `connection_unstable`, retry                                                           | fallback, `connection_unstable`                             |
  | Error while pending                                 | silent end (gap 14)                   | n/a                                     | n/a                                                                                    | n/a                                                         |
  | Refused attach (slot ended or another owner, 5B-G1) | call kept open, route media dropped   | subscription closed, route frozen       | subscription stopped, publication marked ended (5B-G2); a refused resume keeps it open | route media dropped, route kept open                        |
  | Publisher's explicit stop                           | STOP frame: end                       | STOP frame: end                         | server idle state: end                                                                 | `'stopped'` close: end (5B-G6), then the server idle state  |

  Gaps are those of [Today's gaps](system-audio-receive-ownership.md#todays-gaps).

- **Timing-constant home:** the deferred-only `src/network/system-audio-media.ts` (Phase 5 5A,
  C4-1). It holds the receivers' playout-delay hint (`SYSTEM_AUDIO_PLAYOUT_DELAY_S`, 0.5 s, set
  through `applySystemAudioPlayoutDelay` on the Standard direct, Standard SFU and PRO SFU
  receivers; the PRO LAN-direct receiver sets none), the senders' 256 kbps stereo bitrate and
  music constraints (`tuneSystemAudioMusicSender` for the Standard direct call and both SFU
  publishers; `tuneSystemAudioLanDirectSender`, bitrate only, for PRO LAN-direct, which also sets
  back a sender that lists no encoding) and the Cloudflare Realtime STUN entry, 15 s request
  deadline and 1 MiB response cap both SFU transports share. Since C4-2 it also holds the
  receive deadline `SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS` (30 s), which the slot's watchdog and its
  trust-boundary wait (`TRUSTED_BOUNDARY_WAIT_MS`), the direct call's replacement watchdog and
  the service's direct receive deadline (`DIRECT_RECEIVE_DEADLINE_MS`, imported from here since
  C4-7, through the guest alias before) read. No eager module
  may import it or the slot (`vite.config.ts` `DEFERRED_ENTRY_MODULES`). `RECOVERY_DELAY_MS` and
  `SUBSCRIBER_RETRY_MAX_DELAY_MS` stay in the service: they time the PRO coordinator's own
  deadlines (`deadline: 'route'`) and the service's lease and publisher retries (RO-20), not the
  slot's, and no receive-slot increment moved them.
- **Anchor tests:**
  - Supersession: `src/network/__tests__/system-audio-guest.test.ts` "does not let a stale async
    stream failure tear down its replacement connection"; for the slot's generation, "gives a wait
    opened while a start commits that start, and refuses a start nested in it".
  - User pause/stop: `system-audio-guest.test.ts` "cancels a muted-track wait on force-stop and
    fences its late unmute from a successor".
  - Teardown: `system-audio-guest.test.ts` "restores previous meta when an active adapter-level
    receive cleanup runs" and, for the slot's end through a registered route, "closes the direct
    call, its source, primer and replacement watchdog on another route's cleanup".
  - Visibility: `src/pro-room/__tests__/system-audio-receive-slot-pro-contract.test.ts`
    "visibility: a hidden page keeps the retry running and attaches in the background".
  - The slot's trusted reception (C4-2) is pinned through the names the routes call by the
    `system-audio-guest.test.ts` group "trusted reception: generation, waiters, restore point and
    watchdog", written before the move and unchanged by it.
  - The direct call's attach through the slot (C4-3) is pinned, before the move, by the
    `system-audio-guest.test.ts` group "direct call attach" (the stream object itself on the
    widener input, attach failures on the call's `/debug` channel) and by
    `src/network/__tests__/system-audio-receive-evidence-logs.test.ts` "logs the primer once per
    stream key, at the stream, never again at the attach" and "reports the P2P primer apart from
    its source, and neither once the current call closes".
  - The Standard SFU's attach through the slot (C4-4) is pinned, before the move, by the
    `src/network/__tests__/system-audio-sfu.test.ts` group "guest SFU attach: graph, primer and
    reception start per subscription" (the track in a stream of its own, the primer, one
    reception start per subscription and again on a re-publication with its own limit, the
    cleanup ending the reception only after an attach, the context warning only once the graph
    is confirmed) and by the evidence suite's "logs connected and a primer again for a
    re-publication's track, once per subscription"; the two-hour limit per subscription and the
    SFU `/debug` keys by the lifecycle contract suite.
  - The PRO coordinator's receive inputs through the slot (C4-5) are pinned, before the move, by
    the `src/pro-room/__tests__/system-audio-receive-slot-pro-contract.test.ts` group
    "coordinator receive inputs (attach, resume, interrupt)" (a `'subscribed'` inside the
    disconnect grace, a disconnect held past it with no deadline armed, a `'subscribed'` after a
    retry detached the source, and every coordinator attach starting the reception again) with
    that suite's SFU, LAN-direct, retry, fallback and promotion rows and the pro-transport
    contract suite, which run the service with real state.
  - The bus pairs as slot inputs (C4-6) are pinned, before the move, by the Standard and
    lifecycle contract suites, which since then read a handoff as the slot deadline re-armed from
    it (the `/debug` guest keys) and a receive timeout as the deadline's warn line, and by the
    Standard suite's "the slot deadline lets the SFU adapter drop its subscription before the
    reception ends, and shows receive_failed after the title is back"; after it by the
    `system-audio-guest.test.ts` deadline-reaction and handoff rows and the
    `system-audio-sfu.test.ts` group "guest SFU receive slot inputs" (the guest-role check on
    both inputs, the SFU's deadline-only port).
  - The PRO coordinator's adopt (C4-7) is pinned, before the move, by the PRO contract suite's
    two S7 rows (a Standard-to-PRO switch retires an attached or a still-connecting Standard SFU
    subscription and thaws its share route with no activity change, notice or force-stop, and
    leaves the placeholder and the Standard start's slot deadline as they were), its S11 rows
    and the `system-audio-service.test.ts` rows "retires the Standard SFU guest route at the top
    of every live reconcile, whoever publishes, and never on idle" (since 5B-OV1 "retires the
    Standard SFU guest route on no live reconcile, whoever publishes, and never on idle") and
    "skips the receive end in the coordinator cleanup while this device publishes, the reset
    included" (the local-owner guard and the reset order; since 5B-G4 "ends the reception in the
    coordinator cleanup while this device publishes only when the slot still holds one ...");
    after it by the
    `system-audio-sfu.test.ts` row "is retired by the PRO coordinator's adopt" (the SFU's retire
    through the real slot adopt).
  - The removal of the guest's compatibility aliases (C4-8) is pinned, before it, by the suites
    that called the slot through them, which import the slot's own names since then with their
    assertions unchanged (`system-audio-guest.test.ts`,
    `src/player/__tests__/file-prepare-pause.test.ts`,
    `src/storage/__tests__/recovery-owner-transition.test.ts` and
    `src/youtube/__tests__/load-lifecycle.test.ts`; `system-audio-sfu.test.ts` moved its stubs
    with the SFU's imports), and by the resource-ownership guard test "allows no route adapter a
    direct write".
  - The attach fence (5B-G1) is pinned by rows that failed before it: the
    `system-audio-guest.test.ts` group "attach fence: the slot ended or another owner plays
    (5B-G1)" (an attach after an end or a successor returns `'not-receiving'` before the graph,
    writes nothing and drops the route's source and primer; a resume after either claims nothing
    and drops them; a refused replacement direct call stays open with no replacement deadline
    until STOP), the Standard suite's "S9, fixed in 5B-G1" and "S9 (SFU), fixed in 5B-G1", the
    PRO suite's "S8b, fixed in 5B-G1", the "successor during initAudio" pair and "5B-G1: a
    'subscribed' for the live publication after a successor replaced the placeholder ...", and
    the transport suite's two "S8b ($route), fixed in 5B-G1" rows. The host guard row
    `system-audio-host.test.ts` "keeps an opened direct call with no close or error for 60 s with
    no SFU handoff" (passes before and after) shows, with the Standard S9 row's open call, that a
    refused direct attach causes no host handoff. `system-audio-sfu.test.ts` reads the
    placeholder as committed (its start is a stub), and `system-audio-service.test.ts`'s stubbed
    start commits it and its stubbed end retires it.
  - The PRO coordinator's force-stop and successor teardown (5B-G2) is pinned by rows that
    failed before it: the PRO suite's pair "5B-G2 ($route): force-stop ends the PRO reception
    without a restore, and the coordinator source and primer with it ..." (SFU: the subscription
    closes; LAN-direct: an attached direct source and primer drop while the route stays open
    until the room reset; on both a heartbeat of the same publication subscribes, attaches and
    begins nothing; the LAN-direct row also fails if the force-stop teardown skips a LAN-direct
    publication), "G6 and 5B-G2: a force-stop during a retry backoff ..." (the pending retry
    never subscribes), "5B-G2: a force-stop while a retry's
    subscribe is in flight ..." (no warn from the retry's catch), "trusted boundary, 5B-G2: ..."
    (the boundary's refusal closes the subscription) and the "S9 (SFU), fixed in 5B-G1" row (the
    fence's refusal closes it); the transport suite's "S8b (SFU), fixed in 5B-G1" row (one
    `tracks-close`, no new session) and the pair "5B-G2 (SFU): $cause between the exposed track
    and the completed subscription ..." (a force-stop or a successor while `renegotiate` is in
    flight: no notice, one `tracks-close`, no new Realtime session within 60 s, the reconcile
    catch's fence). Guards that pass before and after: the PRO "begin re-entrancy" row (the new
    subscription stays open after the nested force-stop, which the depth counter protects),
    "5B-G2 guard: after a force-stop ended a publication, the next publication begins and
    attaches again" and the transport "begin re-entrancy (LAN-direct)" row; the LAN-direct rows
    of the S8b and S9 pairs keep the route open, and the transport row "expected today: a direct
    track delivered after a force-stop ..." keeps it open until the share end closes it. The two
    accepted cases above are pinned with today's outcome: the PRO row "accepted with the open
    LAN-direct route (RO-04): a receiver fallback ..." (one `connection_unstable`, nothing else
    changes; it fails before 5B-G2 only at its precondition, the dropped source) and the end of
    the PRO row "5B-G1: a 'subscribed' for the live publication after a successor replaced the
    placeholder ..." (the subscription stays open through a heartbeat, with one subscribe and one
    start, until the share end closes it; unchanged from before 5B-G2).
  - The Standard SFU re-publication handoff (5B-G3) is pinned by rows that failed before it:
    the Standard suite's "re-publication, fixed in 5B-G3: a failed re-subscription while
    receiving hands the reception off to the slot deadline ..." (the subscribe fails with no
    pending READY: pending under the placeholder with the slot deadline armed at the failure,
    then one `receive_failed` and the previous title 30 s later) and its pair "5B-G3: an ICE
    failure of the re-subscription $when hands the reception off the same way" (the subscriber
    PC fails before the offer exposes its track, or while the exposed track waits in
    `initAudio()`). Guards that pass before and after: "5B-G3 guard: a READY inside the deadline
    a failed re-subscription leaves subscribes and attaches with no notice", and the rows that
    keep the helper's two conditions, the Standard "a live subscriber connection failure ..."
    (an attached subscription ends silently, gap 8), the lifecycle "expected today: a failed
    first SFU subscription ..." (gap 13) and the Standard "S3: a handoff re-arms the 30 s slot
    deadline from the handoff, not from START" (each fails when its condition is dropped).
  - The sharer's own claim (5B-G4) is pinned by rows that failed before it: the PRO suite's
    "S11, fixed in 5B-G4: a sharing claim made while still receiving ends the reception under
    the claim ..." (receiving drops with the claim intact, through the reset and a force-stop),
    "begin re-entrancy: ..." (activities `['pending']`, no idle flash) and "5B-G4: a remote share
    that begins over an idle stale sharing title ... leaves no title when it ends"; the
    `system-audio-service.test.ts` pair "ends the reception in the coordinator cleanup while this
    device publishes only when the slot still holds one ..." (the query mocked false: no end, as
    before; true: one end on a heartbeat bind and one on the reset); and the
    `system-audio-guest.test.ts` rows "leaves a 'system-audio' claim with sharing meta alone at
    the end, and still ends the reception (5B-G4)" and "takes no restore point when a start begins
    over $over (5B-G4)" (an active sharing claim, an idle stale sharing title). New with the
    query: `system-audio-guest.test.ts` "answers whether the slot holds a reception ..." (each of
    its four conditions alone). Guards that pass before and after: the PRO "5B-G4 guard: a remote
    share that begins while this device's sharing claim is active ..." (fails if the start takes
    the sharer's meta once the end leaves the claim alone), "5B-G4 guard: a sharer's heartbeat
    reconciles end nothing in the slot ..." (the `/debug` cleanup time stays; fails without the
    service guard), the S11 row "a listener that becomes the publisher keeps its sharing claim
    ..." and the guest unit "5B-G4 guard: still restores a receiving 'system-audio' owner whose
    meta a meta-null writer cleared" (fails if the rule narrows to the placeholder only). Added
    after the 5B-G4 review, for a path the change already covered: the PRO "5B-G4: a sharer whose
    view passes through idle while its capture still runs (publisher recovery's release and
    re-acquire) keeps its sharing claim" (fails on the parent of 5B-G4: playback idle with no
    title after the release's idle view) and the service suite's "publisher recovery reaches the
    slot end through the release's idle view while this device's capture keeps sharing" (passes
    before and after: the real recovery runs the end between the release and the re-acquire,
    and capture is not told).
  - The nested end's restore point (5B-G5) is pinned by rows that failed before it: the
    `system-audio-guest.test.ts` rows "keeps the start's restore point through a cleanup nested
    in the start, which still answers an earlier wait false (5B-G5)" (was "lets a cleanup nested
    in the start empty the restore point while the start still commits": STOP now restores the
    title from before the start) and "answers a wait opened after a cleanup nested in the start
    with that start (5B-G5)". Guards that pass before and after: the guest unit "5B-G5 guard: an
    end inside the start once its placeholder is up ends that start" (fails if every end inside
    a claiming start counts as nested), the PRO "begin re-entrancy" row (its result is unchanged:
    since 5B-G4 its start takes no restore point over the sharer's title) and the transport
    "begin re-entrancy (LAN-direct)" row (the direct deadline armed after the start). Since
    5B-G5 the guest unit query row "answers whether the slot holds a reception ..." sets its
    placeholder-only step directly.
  - The route closures the slot hears (5B-G6) are pinned by rows that failed before it: the
    transport suite's "gap 11, fixed in 5B-G6: a publisher close 'stopped' ends the LAN-direct
    reception at once with the previous title ..." (was "expected today: a publisher close
    'stopped' closes the LAN route without telling the slot ...": idle with the previous title at
    the close, no notice or close back in 60 s, two heartbeats begin nothing, the share end asks
    for the post-share restore once), "5B-G6: a publisher close 'stopped' before any track ends
    the pending reception at once ..." (no notice at 30 s; until the 5B-G6 review its title also
    claimed the direct receive deadline's clear, which it cannot see) and the first half of
    "two-hour budget re-publication case, gap 12 fixed in 5B-G6 ..." (at the promotion budget: one
    `tracks-close`, receiving off, pending, no source or primer, no notice; the heartbeat half
    unchanged). Added in the 5B-G6 review, both failing without the change: the transport row
    "5B-G6: a plain share's two-hour end (no promotion) reaches the subscriber's own budget expiry
    first ..." (at the share's budget: one `tracks-close`, the `'system-audio'` mode kept with
    activity pending, no source, primer or notice; the idle state then gives the previous title
    and one restore; on the parent the slot stayed playing until the idle state) and the service
    unit row "clears the direct receive deadline on the live publisher's 'stopped' close and ends
    the reception only while the slot holds one (5B-G6)" (another publication or owner changes
    nothing; fails without the deadline clear or with an unguarded end). Not pinned, harmless:
    the SFU stop handler's ended-mark check (after a 5B-G2 route end the subscriber is already
    stopped and a second interrupt is a no-op). Guards that pass before and after: the
    transport rows "5B-G6 guard: a publisher close 'superseded' closes the LAN route without
    telling the slot ..." (fails if the transport reports every close) and "5B-G6 guard: the
    subscriber stop the coordinator's own cleanups run emits 'stopped' with the live, unexpired
    descriptor, which changes nothing in the slot" (fails without the expiry condition). New
    with the callback:
    `src/network/__tests__/pro-system-audio-direct.test.ts` "reports only a publisher's 'stopped'
    close of the current receiver route, once and with no close back (5B-G6)" and the PRO suite's
    "5B-G6: a publisher's 'stopped' close ends the reception with the previous title and no
    notice; after a successor replaced the pending placeholder it leaves the successor alone"
    (through the fake transport's `publisherStopped`).
  - The removal of the coordinator's adopt at the top of every live reconcile (5B-OV1, neutral;
    old-version survey, OV-A03 note) is pinned, before and after, by the PRO suite's "5B-OV1
    guard: a Standard READY delivered in a PRO room starts no Standard subscription" (the frame
    reaches the Standard SFU adapter, which refuses it with no host connection; it fails once a
    host connection is set), its two S7 rows (the room turning PRO still retires an attached or
    a still-connecting Standard subscription) and the transport rows "expected today ($route):
    heartbeats and a room-context re-emission while receiving reuse the live route ...". The
    service unit row "retires the Standard SFU guest route on no live reconcile, whoever
    publishes, and never on idle" fails on the parent, where four live reconciles adopted. The
    two remaining adopt sites are pinned by the S7 rows (the room turning PRO, on the real bus;
    the service unit suite clears the bus after each test, so its listeners hear only its first
    test) and the service unit row "retires a failed playing SFU subscription inside the
    placeholder until the retry track attaches" (a retry's cleanup).
  - The removal of the host side of the Standard SFU capability negotiation and of the READY
    `'all'` fence (5B-OV2, old-version; survey OV-B05, OV-B06) changes only the sender of the
    slot's Standard inputs. A host on this build treats every LAN guest as SFU-capable (a LAN
    guest past the eight direct slots, a late LAN guest of an all-SFU share and a failed LAN
    direct call go to the SFU with `'all'`; no peer is `'unsupported'`), ignores the guests' SFU
    capability marker (no handler is registered; Phase 5.5 train 3, OV-F06, later stopped the
    guest sender and removed the kind, its validator and payload type, so the marker a 9.0.16 to
    9.0.21 guest still sends meets no validator or handler) and sends a failed-direct
    remote peer READY
    `{ audience: 'remote', handoffFromDirect: true }` where it sent `'all'`. The Standard suite's
    "OV-B06 acceptance (route direct): ..." and its pair "OV-B06 acceptance (route unselected,
    guest classified $type): ..." pass before and after: the unchanged 9.0.12/9.0.13 guest code
    takes that READY from the `'direct'` route (end, reset, a start with the same surface) and,
    after the host's STOP and START, from `'unselected'` (the marker passes the LAN check even
    for a guest classified local), freezes `'sfu-remote'` with `guestRejectLateDirectRoute`,
    subscribes and refuses a late direct call. The host-side rows that failed before it are in
    `system-audio-delivery.test.ts`, `system-audio-host.test.ts` (a ninth LAN guest starts on
    the SFU with no STOP; a failed LAN direct call gets STOP, START and the SFU handoff),
    `system-audio-sfu.test.ts` (the READY audience, the late LAN retry from the peer event alone)
    and `system-audio-start.test.ts` (the SFU module's late-LAN START sender went with the
    capability handler; five START senders remain). Since train 3, `system-audio-start.test.ts`
    "drops the raw SFU capability marker 9.0.16 to 9.0.21 guests still send, ..." passes before
    and after: through the protocol router and the guest's exact live connection, the marker
    changes no frame, call, publication or route.
  - The START `surface` and SFU_READY `audience` requirement (5B-OV3, old-version; survey
    OV-A08) changes only which frames reach the slot's Standard inputs: a START needs a bounded
    `surface` string (an unknown one still reads as DISPLAY) and a READY an `audience`, as every
    9.0.12 and 9.0.13 sender includes; a READY with the old `tracks` list stays refused, and the
    SFU adapter copies the audience instead of defaulting it. Pinned by
    `src/network/__tests__/protocol.test.ts` "rejects a START without a surface (5B-OV3)" and
    "rejects a READY without an audience (5B-OV3)" (both fail on the parent) and "accepts an
    unknown short surface and reads it as display; refuses an unbounded or non-string one"
    (passes before and after). The removal of the dead channel argument of
    `system-audio:incoming-call` (5B-OV3, neutral; SA-9) keeps the direct call's log lines, timer
    names (`sys-audio-guest-replacement-watchdog-STEREO`, `sys-audio-guest-trust-gate-STEREO-<n>`)
    and `/debug sa` channel record, pinned by the receive evidence-log suites and
    `system-audio-guest.test.ts`.
  - Cross-owner: `src/pro-room/__tests__/system-audio-subscriber-watchdog.test.ts` runs the real
    guest module and slot with the service (G1), with a spy retire registered for the Standard
    SFU route since C4-7. `system-audio-service.test.ts` hand-mocks state, so it cannot see the
    routes' interplay; it stubs the slot's start, trust boundary and end (the guest aliases
    before C4-7) and registers a spy retire for the Standard SFU route with the real slot (it
    mocked the SFU module's cleanup before C4-7). Since C4-5 it runs the real slot attach with
    the receiving flag and owner claim stubbed, and its assertions on those writes moved to the
    real-state PRO contract suites. `system-audio-sfu.test.ts` stubs the same three slot inputs
    the Standard SFU calls (the guest aliases before C4-8) and runs the rest of the slot.
  - Guard: the resource-ownership guard fails when the PRO SFU reception start arms the guest
    watchdog while `SUBSCRIBER_RETRY_MAX_DELAY_MS` is not below `SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS`
    (read from `src/network/system-audio-media.ts` since C4-2), and when an armed
    `beginTrustedSystemAudioReception` start (any use without the literal
    `{ deadline: 'route' }` since C4-6) appears in a new function. The
    start returns early while the placeholder is active, so an armed start on the retry path
    would re-arm the watchdog before the SFU start runs. Since 5B-G2 the coordinator's two
    starts sit in a `try`/`finally` depth wrapper; the check still finds the SFU start as a
    direct call before the subscribe in the same function (one SFU reception start). Since Phase 5 prep (T5) it also counts the
    slot's direct writers per file, exactly: `setSystemAudioReceiving` value uses (3: the slot),
    `claimPlaybackOwner` uses that can claim `'system-audio'` (3: the slot 2 and the sharer's own
    claim in `system-capture.ts`), `widener.input` uses (3: the file playback route's 2 in
    `engine.ts` and the slot's 1) and raw `'systemAudio.isReceiving'` writes outside
    `src/player/ownership.ts` (1: the `leaveSession` batch reset in `peer.ts`). C4-2 moved two of
    the guest's receiving flag writes (the end of reception and the delivery-handoff interrupt)
    and its placeholder claim into the slot (guest 3 to 1 and 2 to 1; totals unchanged), C4-3 the
    direct call's attach, its last receiving flag write, owner claim and `widener.input` source
    (guest 1 to 0 on each; totals unchanged), C4-4 the Standard SFU's, which attaches through the
    same slot attach (Standard SFU 1 to 0 on each; totals 9 to 8, 6 to 5 and 5 to 4), and C4-5
    the PRO coordinator's, whose attach, resume and interrupts reuse the slot's attach, reception
    start and interrupt (service 5 to 0, 2 to 0 and 1 to 0; totals 8 to 3, 5 to 3 and 4 to 3).
    C4-6 and C4-7 changed no count, and since C4-8 the counts are final: the slot is the only
    receive writer, and no route adapter has an entry, so a route that writes the slot itself is
    an unsanctioned writer, not a raised count (guard test "allows no route adapter a direct
    write"). Since Phase 5 C4-1 it also keeps the media tuning in its home:
    in `src/network/system-audio-*.ts` and `src/network/pro-system-audio-*.ts`, only
    `system-audio-media.ts` writes `playoutDelayHint` or `maxBitrate` or names
    `stun.cloudflare.com` (3 sites), and a route adapter that re-types one of its timing
    constants is a copied-timing finding. Since C4-7 the import-graph guard
    (`scripts/check-import-graph.mts`, RULE D) fails any `src/pro-room/**` production import of
    `src/network/system-audio-guest.ts` or `src/network/system-audio-sfu.ts` (tests excluded),
    and a boundary whose target module no longer exists.
- **Status:** `duplicated`. Fix lane G5 (a PRO LAN-direct listener whose track arrived after the
  30 s watchdog stayed silent) is fixed in 9.0.2. G6 (each PRO SFU retry re-runs the reception
  start, including `stopAllMedia` and the host-started notice) is fixed in 9.0.3; its
  release-record item stays open for the device check.
  Phase 5 (slot); its first increment, C4-1, moved the media constants (planned for Phase 0d),
  C4-2 created the slot module with the trusted reception, C4-3 moved the Standard direct
  call's attach and primer into it, C4-4 the Standard SFU guest's, C4-5 the PRO
  coordinator's attach, resume, interrupts and detach, C4-6 the two bus pairs (the delivery
  handoff and the receive deadline's expiry) with an explicit deadline kind, C4-7 the PRO
  coordinator's adopt (the service imports no Standard receive adapter), and C4-8 removed the
  guest's compatibility aliases and made the slot's writer counts final. These moves form train
  5A and change no behaviour ([Phase 5 train 5A report](phase5-5a-receive-slot-2026-10-25.md));
  the record stays `duplicated` after it. The PRO coordinator still owns its own deadlines
  (`deadline: 'route'`: the re-subscribe backoff, the 2.5 s disconnect grace and the direct
  receive deadline) and cleanups (no end port), and the gaps the contract suites pin as today's
  behaviour ([Today's gaps](system-audio-receive-ownership.md#todays-gaps): the attach fence,
  an end that covers every route, route closes the slot does not hear, the re-entrant restore
  point) are behaviour changes for train 5B (owner decision P5-D5 A), each with its failing test
  first. Train 5B (9.0.16 / v789, released 2026-10-27): 5B-G1 added the attach fence (gaps 2 and 3), 5B-G2
  the PRO coordinator's force-stop and successor teardown (gaps 4 and 5), 5B-G3 the
  Standard SFU re-publication handoff (gap 1), 5B-G4 the sharer's own claim (gap 6), 5B-G5
  the nested end's restore point (gap 7) and 5B-G6 the route closures the slot hears (gaps 11
  and 12), and 5B-OV1 to 5B-OV3 removed old-version and dead paths around the slot (OV-A04, the
  coordinator's adopt on every live reconcile, OV-B05, OV-B06, OV-A08 and SA-9) with no owner
  change ([Phase 5 train 5B report](phase5-5b-receive-slot-behaviour-2026-10-26.md)); the record
  stays `duplicated`. Exception RO-39.

### RO-05 Guest YouTube re-align retry chains

- **Resource:** a Standard guest's iframe re-alignment through `guestRendezvousSync`
  (`src/youtube/sync.ts`: pause, seek, `playVideo`).
- **Current owners/flows:** the rejoin router (`src/player/local-output-rejoin.ts`, timer
  `local-output-rejoin-retry`; mainly lock-screen or OS PLAY) and the background-return chain
  (`src/player/background-return-sync.ts`, `rendezvousChain`, timer
  `background-return-sync-rendezvous-retry`). Both space their retries with one schedule,
  `[250, 750, 1_500, 3_000, 5_000]`, each cancels only itself, and their only shared guard is the
  rendezvous busy and cooldown result. Since 9.0.1 both end on `youtube:set-local-paused` (G2).
  Since Phase 4 4B (P4-D7 B) the router also ends on `youtube:pro-listener-visible-pause`: a PRO
  listener's visible iframe PAUSE records the local pause without `youtube:set-local-paused`
  (whose PRO handler drops autoplay intent), and its PRO reconciliation retries would otherwise
  release it. A hidden stop of the iframe ends nothing, so a lock-screen PLAY retry outlives a
  browser stop while locked. Single-shot callers: `src/youtube/iframe.ts`,
  `src/ui/manual-sync-overlay-runtime.ts` and the host- or user-commanded attempts inside
  `youtube/sync.ts`.
- **Target single owner:** `local-output-rejoin.ts` as the re-align owner for participant-local
  automatic and OS-triggered attempts; `youtube/sync.ts` keeps the rendezvous primitive and
  host- or user-commanded attempts.
- **Allowed requesters:** OS and lock-screen PLAY (rejoin events), the background return
  (`app.ts` through `runBackgroundReturnSync`), the Sync button.
- **Lifecycle operations:** start a chain, retry on `busy`, wait for a host snapshot, retire on a
  new return, a local pause or an identity change.
- **Deadline owner:** each chain's retry timer; the rendezvous cooldown in `youtube/sync.ts`.
- **Timing-constant home:** `LOCAL_OUTPUT_REALIGN_RETRY_MS` in `src/youtube/constants.ts`, which
  both chains import (Phase 4 4A, C3-I1); the rendezvous busy retry `MANUAL_RENDEZVOUS_RETRY_MS`
  and cooldown `RENDEZVOUS_COOLDOWN_MS` live beside it. The schedule sits in that startup leaf
  rather than in either lazy chain module: a lazy leaf of its own became an extra chunk whose
  preload entries grew the eager graph.
- **Anchor tests:**
  - Supersession: `src/player/__tests__/background-return-sync.test.ts` "replaces the previous
    return retry chain instead of stacking a second one"; `local-output-rejoin.test.ts` "drops a
    scheduled busy retry after the queue occurrence changes".
  - User pause/stop: `background-return-sync.test.ts` "lets a local YouTube pause during the retry
    wait end the chain"; `local-output-rejoin.test.ts` "cancels a busy YouTube retry on explicit
    PAUSE and permits the next PLAY" and "ends a reserved PRO YouTube retry on a PRO listener
    visible PAUSE and permits the next PLAY"; `native-control-authority.test.ts` "records a
    $visibility $room listener iframe PAUSE as a local pause, published as intent: $published"
    (only the visible PRO row emits the router's end event).
  - Teardown: `local-output-rejoin.test.ts` "does not let a stale busy result schedule work into a
    restarted session".
  - Visibility: `background-return-sync.test.ts` "ignores a sub-second visibility bounce that is
    not a background return".
  - Both chains against the real `youtube/sync.ts` (Phase 4 4A, tests only):
    `src/player/__tests__/local-output-realign-cross-flow.test.ts`, the P4-D7 cases (the P4-D7 B
    fix, a locked browser-stop row and a Standard-guest row) and the P4-D8 cases. The two unit
    suites above still mock it.
- **Status:** `duplicated`. One schedule since Phase 4 4A (C3-I1); both chains already end on the
  same local pause (G2). Owner decision P4-D7 B (2026-10-25, train 4B): a PRO listener's visible
  iframe PAUSE also ends the router's retries; browser stops while hidden still do not. Owner
  decision P4-D8 A (2026-10-24): the lanes are not coalesced (C3-I3 and C3-I4 are not done), and
  the double alignment after a quick unlock and the return chain's give-up while the host is
  buffering stay as the cross-flow harness pins them. The owner is asked again only if device
  evidence shows either one disturbing playback. Exception RO-48.

### RO-06 Host shared start, playlist queue and guided demo

- **Resource:** the host's pending shared-start deadline for the local-file source node and the
  start-and-publish-once step.
- **Current owners/flows:** the queue anchor (`armStandardHostCanonicalTimeline`,
  `getStandardHostPendingFileStartAt`, published by `startHostFileAndBroadcastPlay` in
  `src/player/transport.ts`) and the demo anchor (`setDemoHostStartAt`,
  `getPendingDemoHostStartAt` in `src/demo/host-start-anchor.ts`, a leaf the startup graph can
  read without the lazy demo timing module; `startDemoPlayback` in `src/demo/mode.ts`). The modes
  are mutually exclusive and other modules branch on `demo.active`;
  `armStandardHostCanonicalTimeline` declines demo output (`demo.active` with no resident file;
  demo tracks publish none) since train 4B (P4-D9), so demo playback never arms the queue anchor
  or its canonical timeline. A queue file started while the demo flag is still set (an operator
  guest's track request reaches `playTrack` without a demo check) owns a resident and keeps the
  queue anchor and its PLAY, as before.
  The queue anchor validates its output identity; the demo anchor only checks that it lies in the
  future, and only demo code clears it.
- **Target single owner:** `transport.ts`: one pending shared-start anchor for both kinds,
  validated by output identity and revoked by transport pause and stop, and one
  start-and-publish-once primitive.
- **Allowed requesters:** queue PLAY and demo start; readers `src/network/sync.ts` (late-join
  bootstrap), `demo/mode.ts`, `src/player/playback.ts`.
- **Lifecycle operations:** arm the anchor, start the source, publish once (including
  `onRecoveredStarted`), clear on pause, stop or exit.
- **Deadline owner:** the anchor timestamp in each module.
- **Timing-constant home:** `src/player/file-play-timing.ts`: the 200 ms shared start lead
  `LOCAL_FILE_START_LEAD_MS` (`DEMO_PLAY_START_LEAD_MS` in the lazy `src/demo/playback-timing.ts`
  aliases it), the 2 s `HOST_TIMELINE_TRUST_WINDOW_MS` (the file check is two-sided, the demo
  projection bounds only deadlines ahead) and the guests' 250 ms post-start sync ping
  `GUEST_START_SYNC_PING_DELAY_MS` (timers `playback-preload-host-sync`,
  `playback-finalize-host-sync`, `demo-play-host-sync`), all since Phase 4 4A (C3-I1). The
  old-version removal train dropped the 200 ms PLAY wire lead `LEGACY_FILE_SCHEDULE_AHEAD_MS`
  (survey OV-B01): PLAY carries only `hostStartAt`, and a guest starts a PLAY without it at
  receipt. Guests require DEMO_PLAY's `hostStartAt` and gate the host timeline on clock
  calibration alone (OV-B02 stage 1). Old-version removal train 2 (OV-F05, App build floor 787)
  dropped DEMO_PLAY's `hostPlayAt`, the start plus the separate 350 ms
  `DEMO_PLAY_SCHEDULE_AHEAD_MS` that only guests of 9.0.12 and older read: DEMO_PLAY and the
  late-join demo bootstrap carry only `hostStartAt`, and neither the DEMO_PLAY nor the PLAY
  validator reads a `hostPlayAt` a 9.0.14 host still adds.
- **Anchor tests:**
  - Supersession: `src/demo/__tests__/mode.test.ts` "does not restore stale media over a local file
    load started during exit".
  - User pause/stop: queue side `src/player/__tests__/concurrency-invariants.test.ts` "cancels a
    pending shared host start without advancing the paused position"; demo side missing (transport
    pause and stop do not clear the demo anchor).
  - Teardown: `src/demo/__tests__/mode-recovery.test.ts` "does not retry an aborted guest fetch
    after exit".
  - Visibility: demo side `src/demo/__tests__/shared-start-anchor.test.ts` "the demo host reports
    its own position after a hidden stall" and "a background-resume rebuild restarts the demo at
    its own position"; queue side, same file, "keeps the queue canonical timeline governing the
    host position across a hidden stall", whose rebuild still moves the host forward (train 4B,
    P4-D9).
  - Both anchors together (Phase 4 4A, tests only; flipped to the fix in train 4B):
    `src/demo/__tests__/shared-start-anchor.test.ts` (P4-D9).
- **Status:** `duplicated` (mutually exclusive modes). One lead since Phase 4 4A (C3-I1). The
  anchor investigation (owner decision P4-D9 A, tests only) found that when a queue item was
  selected before demo entry, demo playback armed that item's queue anchor and its canonical
  timeline governed the demo host's reported position (4.8 s against 2.8 s audible after a
  hidden audio-clock stall in the harness). The owner chose the narrow fix on 2026-10-25 (train
  4B): demo playback never arms that anchor, so the demo host reports its own position, while
  DEMO_PLAY, SYNC_PONG and the late-join demo bootstrap still carry the same demo start and queue
  playback after the demo is unchanged. One anchor (C3-I8) and one start-and-publish-once
  primitive (C3-I7) stay deferred. See [Standard file common start](standard-file-common-start.md)
  for the separate demo path. Exception RO-49.

### RO-07 PRO signaling broadcast delivery

- **Resource:** the room incarnation's signaling endpoint `/internal/realtime/v1/broadcast` and the
  coordinator-epoch fence it advances in `cloudflare/signaling-worker.ts`.
- **Current owners/flows:** one signaling-outbox section of the PRO room Durable Object in
  `cloudflare/pro-room-worker.ts` (Phase 1, C7-3 and C7-4). `scheduleServerEvent` routes every
  server event by `signalingDeliveryClass` (`presence`, `playback` or `transient`). The owner's
  single parts:
  - one request builder, `postSignalingBroadcast`: one endpoint, header set, body and deadline,
    with the lane's acceptance rule passed in (`http-ok-json`: any HTTP 200 with a non-null JSON
    body; `full-fanout`: an HTTP 200 of exactly `{broadcast: true, eligible, sent}` with `sent`
    equal to `eligible`);
  - one due time, `signalingOutboxDueAtMs`: the earlier of the presence marker and the outbox
    head (never a record behind the head), the one candidate `scheduleAlarm` takes;
  - one alarm drain, `drainSignalingOutbox`: a due presence marker first, then the playback head;
  - one epoch hook, `onCoordinatorEpochAdvanced`: `bumpRoomEpoch` calls it after
    `cancelPendingPlayback`, and it empties the outbox in the epoch change's own persist.
    Signaling lets only a presence snapshot advance the epoch and answers any other event for a
    newer epoch with 409 `PRO_ROOM_EPOCH_STALE`. The outbox retries that refusal; the no-retry
    lane drops it, together with any added-tracks notice the event carries (RO-46);
  - one load normalizer, `normalizeLoadedSignalingOutbox`: both stored record shapes are frozen
    and anything else is dropped, including a playback record of another epoch. It runs after
    `normalizeLoadedPlaybackAuthority`, which can advance a legacy room's epoch on load. Since
    Phase 5.5 old-version removal train 3 (9.0.22) the shapes take one optional key, the start
    kind `timingMode` (`'zero-start'` or `'scheduled-control'`) of a PREPARE or COMMIT event: the
    loader keeps it and the write path (`enqueuePlaybackBroadcast`, whose new records pass the
    same check) queues it. Since PRO snapshot schemaVersion 2 the Worker writes it on every
    PREPARE and transition COMMIT (a direct COMMIT names no kind), so the 9.0.22 PRO Worker, the
    rollback target of that change, loads and delivers every record it writes. Any other value
    fails the check like any other malformed record.

  The lanes keep their contracts and execution modes:
  - presence (`pendingPresenceBroadcast`, `deliverPresenceBroadcast`, `settlePresenceBroadcast`,
    `retryPendingPresenceBroadcast`): `waitUntil`, three immediate tries, then the durable marker
    the alarm retries (`settlePresenceBroadcast` installs it after a failure and clears it after a
    delivery that covers it); without a signaling binding one send and no marker. Sent through
    `broadcastServerEvent` (`http-ok-json`);
  - the playback outbox (`pendingPlaybackBroadcasts`, `enqueuePlaybackBroadcast`,
    `dispatchPlaybackBroadcast`, `flushPendingPlaybackBroadcasts`, at most two records): queued
    before persist, sent after it (`full-fanout`). Every persist that does not pass
    `flushPlaybackOutbox: false` flushes the head and the request that persisted waits for it:
    command and request persists, prune (also in the alarm), heartbeat-durability flushes, and the
    presence marker's write, clear and retry. So the alarm sends presence before playback only
    when nothing else persists first;
  - a no-retry lane for `pro-room-invalidated` and `system-audio-invalidated` events: one
    `broadcastServerEvent` call and no record. `scheduleServerEvent` sends it through `waitUntil`
    for `scheduleDeveloperInvalidationHint`, `handleInternalDeveloperQueueModeUpdate` and
    `reconcileSystemAudio`; eleven call sites await `broadcastServerEvent` directly after persist,
    in `handleInternalDeveloperCommandCreate`, `handleUpdateSettingsSync`, `handleUpdateQueueMode`,
    `handleAcquireSystemAudio`, `handleCommitSystemAudio`, `handleReleaseSystemAudio`,
    `commitParticipantSnapshot` (from `handleCompactSnapshotMutation`), `handlePlaylistSwitch` and
    `handlePlaylistTransfer`.

- **Target single owner:** reached by C7-4 (the section above). The no-retry lane stays best
  effort: its senders use the same request builder, keep their current execution mode and get no
  outbox record. Making it durable is a behaviour change and needs an owner decision.
- **Allowed requesters:** the presence and playback reducers enqueue; the invalidation senders
  listed above send once through the request builder; `scheduleServerEvent` stays the router;
  `scheduleAlarm` asks the outbox for one due time and `alarm` runs its drain. Worker caller
  allowlist for `/internal/realtime/v1/broadcast`: `postSignalingBroadcast` in
  `pro-room-worker.ts` only (the route itself is `handleFetch` in `signaling-worker.ts`).
- **Lifecycle operations:** enqueue, dispatch, back off, drop on an epoch change, persist the
  retry marker, normalize on load; send once (no-retry lane).
- **Deadline owner:** each lane's backoff; the no-retry lane has none. `scheduleAlarm` stays the
  single alarm owner and takes one candidate from the outbox. The request builder uses
  `SIGNALING_BROADCAST_TIMEOUT_MS` (900 ms) for every lane, so each awaited send (an invalidation,
  or the playback head a persist flushes) can add up to 900 ms to its HTTP response.
- **Timing-constant home:** `cloudflare/pro-room-worker.ts`: `SIGNALING_BROADCAST_TIMEOUT_MS`,
  `SIGNALING_BROADCAST_RETRY_BASE_MS`, `SIGNALING_BROADCAST_RETRY_MAX_MS`,
  `SIGNALING_BROADCAST_RETRY_MAX_ATTEMPTS` (900 ms, 1 s, 60 s, 16) and one delay function,
  `signalingBroadcastRetryDelayMs`. The presence marker passes its stored attempts, the playback
  outbox its attempts minus one; the load normalizer uses the shared attempt cap. One set since
  Phase 0d (C7-1); a lane that needs its own timing gets its own constants there.
- **Anchor tests:**
  - Supersession: `src/pro-room/__tests__/pro-room-signaling-delivery.test.ts` "drops a queued
    playback record when a PIN rotation advances the epoch" and "drops a queued playback record
    of an older epoch when the room sleeps" (both check every stored core write).
  - User pause/stop: n/a (server).
  - Teardown: `src/pro-room/__tests__/pro-room-worker.test.ts` "durably retries a presence snapshot
    after transient signaling failures and isolate restart"; "keeps a failed playback dispatch
    durable and clears it after a restarted alarm retry".
  - Visibility: n/a.
  - Mixed versions: `pro-room-signaling-delivery.test.ts` "durable record shapes (rollback
    contract)", against the frozen records in
    `src/pro-room/__tests__/__helpers__/pro-room-outbox-records-51ab2be3.ts` (both directions,
    and the 16-attempt cap on load). The start kind, against the frozen records of
    `src/pro-room/__tests__/__helpers__/pro-room-playback-records-v2.ts`: the Worker writes them
    byte for byte, and "keeps and delivers in order a transition COMMIT and a PREPARE that name
    timingMode across a cold restart" and "keeps %s transition stored as the frozen v2 record
    across a cold restart and commits it" (a zero-start select and a wake) pass on the tests-first
    parent and with `cloudflare/pro-room-worker.ts` swapped to the 9.0.22 PRO Worker (9.0.22 /
    v795, `71f5b96c`), the rollback target. The write path: `pro-room-worker.test.ts` "lets the
    outbox write path queue a PREPARE and a transition COMMIT that name either timingMode", and
    the real signaling Worker in `pro-room-signaling-contract-workerd`.
- **Status:** `owner-in-place`. Phase 0d named the constants once (C7-1). Phase 1 C7-3 merged the
  two request builders ([report](pro-room-signaling-transport-2026-10-23.md)); C7-4 gave the
  outbox one due time, one alarm drain, one epoch hook and one load normalizer, with no behaviour
  change ([report](pro-room-outbox-duration-owners-2026-10-23.md)). The trigger modes, due time,
  caps and epoch hook are pinned in `pro-room-signaling-delivery.test.ts`; the request against the
  real signaling Worker in `pro-room-signaling-contract-workerd`. Durable record shapes are frozen
  apart from the optional `timingMode` key, read since Phase 5.5 train 3 (9.0.22) and written
  since PRO snapshot schemaVersion 2.
  Exceptions RO-31, RO-46.

### RO-08 PRO asset duration read

- **Resource:** the R2 duration read of one PRO asset (`readProRoomFileDuration` in
  `cloudflare/pro-room-media-duration.ts`) and its stored `'server'` duration evidence.
- **Current owners/flows:** one duration-reads section of the PRO room Durable Object in
  `cloudflare/pro-room-worker.ts` (Phase 1, C7-6) over two readers (RO-32): the registration
  probe (`pendingAssetDurationProbes`, `enqueueAssetDurationProbe`, `startAssetDurationProbe`,
  `deferAssetDurationRead`) and the playback probe (`playbackDurationProbe`,
  `startPlaybackDurationProbe`, `reconcilePlaybackDurationProbe`). The owner's single parts:
  - two slot predicates, kept apart because they answer different questions:
    `fileDurationReadInFlight` (a registration read, or a playback lookup whose slot records
    `mediaKind: 'file'`; a YouTube lookup leaves the R2 slot free) and
    `fileDurationQueuedForRegistration` (the asset waits in the registration queue, read or not,
    and the playback probe yields to it). `playbackDurationProbeBlocked` combines them with the
    playback slot; `startAssetDurationProbe` waits only while a file read is in flight;
  - one plain start, `startDurationWork` (playback probe, then registration), called after every
    persist and by the alarm;
  - one alarm candidate, `durationWorkAlarmAtMs`: a YouTube length's expiry, the playback
    probe's retry (no earlier than `PLAYBACK_DURATION_PROBE_WATCHDOG_MS`, 10 s, while it is
    blocked), a playing file's unanswered decode read, and a queued registration read (next tick,
    or the watchdog while any lookup, a YouTube one included, is in flight).

  Each completion keeps its own guarded restart, word for word: the registration completion
  restarts both probes only `if (finished)`, the playback completion restarts the playback probe
  only for a different probe key (then the registration probe). A completion that stores nothing
  (service maintenance, a changed room generation) therefore never starts its own read again; the
  next read waits for the alarm, a persist or the probe's retry time. Merging these restarts into
  `startDurationWork` would bring back the alarm hot loop fixed once before
  ([registration](pro-file-duration-registration-2026-10-12.md)).

- **Target single owner:** reached by C7-6 (the section above). Two readers remain (RO-32).
- **Allowed requesters:** registration completion, playback reconcile, persist and the alarm
  (through `startDurationWork`). Worker caller allowlist for `readProRoomFileDuration`, scoped
  to `cloudflare/`: the two probes. `src/pro-room/upload-duration.ts` runs the same parser on the
  uploader's local file before upload; that is not an R2 read and is outside this resource.
- **Lifecycle operations:** enqueue, read outside the lane, revalidate inside it, roll back on
  capacity, persist, retry.
- **Deadline owner:** each probe's retry ladder; the alarm's registration watchdog
  (`durationWorkAlarmAtMs`).
- **Timing-constant home:** `cloudflare/pro-room-worker.ts`: `FILE_DURATION_READ_RETRY_MS`
  (5 s, 30 s, then `PLAYBACK_DURATION_FILE_RETRY_MS`, 5 min) with
  `fileDurationReadRetryDelayMs`, used by `deferAssetDurationRead` and the playback probe's
  failed file read (Phase 0d, C7-2). The YouTube lookup's quick retries are a separate
  provider-quota policy, `PLAYBACK_DURATION_YOUTUBE_QUICK_RETRY_MS` (5 s, 30 s), before its
  backoff to `PLAYBACK_DURATION_YOUTUBE_RETRY_MAX_MS`.
- **Anchor tests:**
  - Supersession: `pro-room-worker.test.ts` "reuses private asset duration after queue
    replacement, cache eviction and cold restart".
  - User pause/stop: n/a.
  - Teardown: `pro-room-worker.test.ts` "resumes persisted registration probes after cold restart
    and does not retry unsupported files in the background".
  - Visibility: n/a.
  - Cross-owner: `pro-room-worker.test.ts` "uses the registration watchdog instead of hot-looping
    an overdue playback probe"; `src/pro-room/__tests__/pro-room-duration-reads.test.ts` "leaves a
    queued desired file to the registration reader once nothing is in flight" (queued predicate)
    and "lets a YouTube lookup in flight leave the R2 slot free, yet holds the queued read alarm at
    the watchdog" (in-flight predicate and alarm).
  - Continuation guards: `pro-room-duration-reads.test.ts` "refused completions do not restart a
    read" (maintenance) and `natural-completion-integration.test.ts` "PRO duration completions
    that store nothing do not restart their read" (a changed generation, evidence that does not
    fit).
- **Status:** `owner-in-place`. Phase 0d named the ladder once (C7-2); Phase 1 C7-6 gave the two
  readers one predicate pair, one plain start and one alarm candidate, with no behaviour change
  ([report](pro-room-outbox-duration-owners-2026-10-23.md)). Exception RO-32.

### RO-09 Owner-transfer saga row

- **Resource:** one `mxqr_pro_room_owner_transfer_sagas` row and the effects it drives (Durable
  Object commit, registry, old-owner edge, entitlement, fence clear, audit).
- **Current owners/flows:** one post-commit executor, `finishCommittedOwnerTransfer` in
  `cloudflare/app-worker.ts` (Phase 1, C7-9), with two entry adapters that each bring the row to
  `committed` and then call it. The transfer request `handleProRoomOwnershipTransferSaga` commits
  through the Durable Object's `/commit` with the claim's proof and maps the executor's outcome
  (`OwnerTransferTailOutcome`, a step and how it stopped: `threw`, `refused` or `not_found`)
  through one table, `OWNER_TRANSFER_REQUEST_TAIL_ANSWERS`, to the audit row and HTTP answer it
  gave before C7-9, then attaches the committed Set-Cookie. The minute cron
  `reconcileOneOwnerTransferSaga` adopts, expires or supersedes the row, commits an adopted
  transfer through `commitAdoptedOwnerTransferSaga` (the Durable Object's `/reconcile`), and
  returns the executor's `ok`; `listIncompleteOwnerTransferSagas` has no age or lease filter and the
  rotation compare-and-swap is unchanged. The entries coordinate through the ranked D1
  compare-and-swap (`OWNER_TRANSFER_SAGA_STATE_RANK`); every executor step is idempotent, so the
  request, the cron and an executor of an older Worker version can overlap on one row and
  converge. The executor's one order (owner decision D3, below): target recheck, registry
  projection and `registry_active`, old-owner edge and `old_owner_edge_retired`, final target
  recheck, canonical room check, entitlement finalize, `verified`, Developer API fence clear,
  success audit, `complete`. A target deleted at either recheck, or a room the account-deletion
  job already suspended (the cron, without a second purge), ends in
  `terminateOwnerTransferForDeletedTarget`: purge (or not), finalize, audit, `target_deleted`.
  `auditOwnerTransferCommitOnce` writes that closing row (`success` or the deleted-target result)
  before the terminal advance and at most once per result for the transfer: one
  `INSERT ... SELECT ... WHERE NOT EXISTS` bounded by the saga's intent time, through
  `appendSystemAdminProRoomAudit`'s `onceSinceMs` (no schema change). Rows that record a stop
  (`reconcile_required`, `entitlement_reconcile_required`) stay one per stop.
  `ownerTransferEntitlementInput` builds the entitlement identity every App Worker reserve,
  finalize and abort passes (the cron adds its sweep time, the request none; the PRO room's
  PREPARE builds its own reservation).
- **Target single owner:** reached in Phase 1 C7-9: one post-commit executor with the request
  and the cron as entry adapters. Owner decision (2026-10-23, D3): both entries use that
  executor's single order. The entitlement is finalized before `verified`, so `verified` means
  the room is active and the entitlement has moved; the cron's earlier verified-then-finalize
  order is retired. The audit row is written before any terminal advance (`complete` or
  `target_deleted`), at least once, with a transfer-scoped deduplication instead of the earlier
  possible loss after a terminal advance. Before `committed` each entry keeps its own route to the
  Durable Object commit, as the target design sets: only the request holds the commit proof, and
  the cron finishes a transfer whose request stopped.
- **Allowed requesters:** the transfer request and the minute cron, as entry adapters.
- **Lifecycle operations:** link, fence, Durable Object commit or reconcile, committed, then the
  executor (registry, old-owner edge, finalize, verified, fence clear, audit, complete);
  terminate for a deleted target (`terminateOwnerTransferForDeletedTarget`).
- **Deadline owner:** none per attempt; the cron adopts any incomplete saga every minute. No
  adoption lease: owner decision D4 (C7-10) was not approved, and the transfer-scoped audit
  deduplication removed the duplicate success rows a lease was meant to stop.
- **Timing-constant home:** n/a (no timing). Phase union: `cloudflare/app-worker.ts` names the
  states once, `OWNER_TRANSFER_SAGA_STATES` with `OWNER_TRANSFER_SAGA_NONTERMINAL_STATES` (the
  states the cron adopts), the derived terminal list, the derived
  `OWNER_TRANSFER_SAGA_ABANDONED_STATES` (the terminal states other than `complete`, used by
  `recordOwnerTransferIntent` and `advanceOwnerTransferSagaState`) and
  `OWNER_TRANSFER_SAGA_STATE_RANK`, and builds every SQL state list from them through
  `sqlStateList` (Phase 0d, C7-2). Three SQL copies of the full list stay as written: the state
  CHECK in `admin-metrics.owner-transfer-saga.migration.sql`, in `admin-metrics.schema.sql` and
  in the runtime DDL of `ensureAdminProRoomRegistry`.
  `src/core/__tests__/owner-transfer-saga-states.test.ts` keeps all three equal to the
  TypeScript list and runs the generated cron listing, rotation and decommission
  terminalization SQL in node:sqlite, including a saga another executor ends during the sweep.
  The states an unfilled row may hold (`intent`, `expired`, `superseded`) stay written out in
  `normalizeOwnerTransferSagaRow`, as in the table's row CHECK they mirror.
- **Anchor tests:**
  - Supersession: `src/core/__tests__/app-worker-cors.test.ts` "adopts a prepared DO transfer after
    the D1 saga fill fails and reconciles without persisting secrets";
    `owner-transfer-saga-convergence-sqlite.test.ts` "request outcome table" (a row another
    executor ended answers 503 without an audit).
  - User pause/stop: n/a.
  - Teardown: `app-worker-cors.test.ts` "naturally expires unopened claims and pending sagas
    exactly once during cron reconciliation".
  - Visibility: n/a.
  - Deleted target: `owner-transfer-saga-convergence-sqlite.test.ts` "owner-transfer saga: target
    deleted mid-transfer" and "deleted-target exits" (each site's order, failure exits and the
    one audit row); "entitlement identity" (the bound values of finalize and abort).
  - One executor: the same file's "request outcome table" (every request stop as its audit row,
    HTTP answer and saga state), "cron tail crash matrix" (each step failing, then convergence)
    and "request and cron on one row" (one success row for an overlap, a replayed request and a
    cron retry; two transfers of one incarnation keep one row each).
  - Mixed versions: `owner-transfer-saga-mixed-version-sqlite.test.ts` (an App Worker built from
    an earlier commit and the current one on one row. The Phase 0d and Phase 1 builds run only
    their cron against the current request or cron: their requests carry the `newPin` that the
    PRO room refuses since 2026-10-26, so they no longer reach a commit. The 9.0.14 build
    `dd9c9d4d`, which shares rows with the current one while release W of old-version removal
    train 2 deploys or recovers, runs request against cron in both directions, with one success
    row for an overlap).
- **Status:** `owner-in-place`. Phase 0d named the state lists once (C7-2). Phase 1 C7-8 named the
  entitlement identity and the deleted-target terminator once with no behaviour change
  ([report](app-worker-saga-fence-2026-10-23.md)), and C7-9 replaced the request's and the
  cron's post-commit tails with the one executor in the D3 order
  ([report](app-worker-saga-executor-2026-10-23.md)). Two limits stay: while an App Worker older
  than C7-9 still runs, its plain inserts can add a second row; and the deduplication is bounded
  by time because the audit table has no transfer column, so a tail of an earlier transfer stuck
  past the Durable Object's 10-minute completed-transfer replay window and resuming in the
  milliseconds between a new transfer's intent and its PREPARE could suppress the new transfer's
  row of the same result.

### RO-10 Local-file source node restart

- **Resource:** the source node `_playerNode` (`src/player/_state.ts`), started only by `play()`
  in `src/player/transport.ts`.
- **Current owners/flows:** failed-PLAY recovery (`failedPlayRecoveryGeneration` and the retry
  closure with `recoveryClaimed` and `foregroundRestartConfirmed` in `transport.ts`, run by the
  recovery dialog in `app.ts`) and the rejoin router (`local-output-rejoin.ts`: host refresh then
  `play(outputOnly)`, guest `sync:force-resync`). The router also releases and restores the local
  pause flag that `media-session.ts` and `playback.ts` write. `app.ts` maps the source to an
  intent and branches between retry and rejoin.
- **Target single owner:** unchanged. `play()` and the play lock stay the only starter; the
  `failedPlayRecoveryGeneration` fence arbitrates. Which `play()` calls move the fence, and which
  return early and leave a pending dialog retry valid, is invariant C13 in
  [Playback concurrency invariants](playback-concurrency-invariants.md#3-cross-mechanism-interaction-contracts);
  read the fence rule there, not here. Naming the failed-PLAY lease stays optional.
- **Allowed requesters:** the recovery dialog (`app.ts`), the rejoin router, the media session.
- **Lifecycle operations:** `play()`, `play({ outputOnly })`, stop, generation bump.
- **Deadline owner:** the recovery dialog (it waits for a user gesture); the router's success
  cooldown.
- **Timing-constant home:** `SUCCESS_COOLDOWN_MS` (`local-output-rejoin.ts`).
- **Anchor tests:**
  - Supersession: `src/player/__tests__/concurrency-invariants.test.ts` "does not surface recovery
    UI from a superseded resume failure".
  - User pause/stop: `concurrency-invariants.test.ts` "invalidates a failed PLAY recovery token on
    a newer PAUSE intent".
  - Teardown: missing.
  - Visibility: missing.
  - Cross-owner: `concurrency-invariants.test.ts` pin (k) "retires the outstanding retry when the
    router refresh reaches the claim point first" and "lets the exact retry that holds the lock
    keep its start and continuation".
- **Status:** `owner-in-place`. The fence is written down as invariant C13 since Phase 4 4A
  (C3-I9 docs). The roadmap reduced C3-I9 to these docs, so Phase 4 does not rename the lease. See
  [Playback concurrency invariants](playback-concurrency-invariants.md). Exception RO-36.

### RO-11 Deferred-start mailbox `playback.pendingPlayTime`

- **Resource:** the scalar mailbox `playback.pendingPlayTime` with its set-at timestamps, with
  accessors `getPendingPlayTime` and `setPendingPlayTime` (`src/player/_state.ts`).
- **Current owners/flows:** the play-lock queue in `transport.ts` (the busy path writes only the
  scalar; the lock's take clears it only when it owns a typed intent) and the decode-completion
  consumers in `src/player/decode.ts`. The per-path policy is
  [Playback concurrency invariants §4](playback-concurrency-invariants.md#4-pendingplaytime-preserveclear-policy-asymmetric-by-design)
  (its table and **Writers** paragraph). Writers through the accessors: `transport.ts`,
  `decode.ts`, `playback.ts`, `device-track-failure.ts`, `src/storage/transfer-receive.ts`,
  `src/share/remote-share.ts`. Teardown writer: `leaveSession` in `src/network/peer.ts` writes the
  three fields directly in its session-reset `setState` batch. Reader only: `guest-file-pause.ts`.
  §4's writer list lags the code. The 2026-10-22 re-check of every `setPendingPlayTime` call and
  direct `playback.pendingPlayTime` write in `src/` found these writers §4 does not list: the
  terminal clear in `markDeviceTrackUnavailable`; the `leaveSession` reset; the RAM-admission
  rejection clear in `tryAdmitMainReceive` (`transfer-receive.ts`); the clear in
  `selectUnavailableFile` (`playback.ts`), reached from `handlePlayMsg` for a locally unsupported
  track and from the `player:unavailable-file-selected` event; and the lock-queue clear
  `clearPendingPlayIntent` reached from stale-lock recovery (`recoverStalePlayLock`) and from
  `invalidatePendingFilePlayIntent` (`pause`, `seekTo`, `skipTime`, `applyProPlaybackFileCommit`
  and `handleRequestSeek` in `playback.ts`). §4 also names `tryFetchDemoForRemote`, which no
  longer exists, and `capturePendingPlaySnapshot`/`restorePendingPlaySnapshot`, now
  `capturePendingFileIntent`/`restorePendingFileIntent` with four restore sites: the three §4
  names plus the route-pending file prepare. This record does not edit §4; its table still sets
  the policy for each path it lists.
- **Target single owner:** unchanged. The asymmetric preserve and clear policy is deliberate (§4).
- **Allowed requesters:** the writers above, through the accessors. The `leaveSession` reset is
  the one allowed direct write: it sets the same cleared values as `setPendingPlayTime(undefined)`
  in the batch that resets the rest of the session state. Readers use `getPendingPlayTime`.
- **Lifecycle operations:** set, preserve, clear, consume.
- **Deadline owner:** none; consumers age the value from its set-at timestamps.
- **Timing-constant home:** n/a.
- **Anchor tests:**
  - Supersession: `concurrency-invariants.test.ts` "a superseded activation's decode failure leaves
    flag + mailbox to the superseder".
  - User pause/stop: missing as a dedicated test; the §4 table states the policy.
  - Teardown: `concurrency-invariants.test.ts` "unlocks, clears pendingPlayTime, stops the node,
    bumps the token, idles, and the wedged play aborts".
  - Visibility: n/a.
- **Status:** `accepted-exception`. Two holders by design; no consolidation.

### RO-12 YouTube iframe audio state

- **Resource:** the iframe's `mute`, `unMute` and `setVolume` state.
- **Current owners/flows:** the RO-02 and RO-03 machines (active and detached restores); the
  `youtube:set-volume` handler in `src/youtube/player.ts`, which asks three hard-mute owners plus
  parking and pushes the desired audio into each machine; the PRO pause gate
  (`_proPlaybackPauseGateToken`, held in both `player.ts` and `src/audio/engine.ts`); the PRO
  direct commit write; the retained-player hard-mute proof
  (`src/youtube/retained-player-controller.ts`); the gesture-bound prime unmute in `iframe.ts`.
  Since 9.0.1 the authority-arm prepare reads the pause gate through
  `isProPlaybackPauseGatePendingFromIframe` (G3). "Desired audio from master volume" is still
  computed in several places with two mute rules.
- **Target single owner:** one iframe-audio module (planned `src/youtube/iframe-audio.ts`) holding
  the desired state, holds and one verified restore; the retained player and prime only register
  a parking hold or keep their gesture-bound write.
- **Allowed requesters:** master volume through `youtube:set-volume` and the PRO pause-gate events
  (`pro-playback:ui-control-pending` and `-settled`), whose handlers in `player.ts` push desired
  audio into the start machines through `updateYouTubeZeroStartDesiredAudioState` and
  `updateProYouTubeAuthorityDesiredAudioState`; the start machines.
- **Lifecycle operations:** `mute`, `unMute`, `setVolume`, verified restore.
- **Deadline owner:** each writer's own retry (for example the zero-start release unmute retry).
- **Timing-constant home:** the audio-restore 120 ms and 8 attempts repeated in `zero-start.ts`,
  `authority-arm.ts` and `player.ts`. Target: `src/youtube/constants.ts`.
- **Anchor tests:**
  - Supersession: `zero-start.test.ts` "does not restore audio or report ARMED for an iframe
    replaced during audio settlement".
  - User pause/stop: `src/youtube/__tests__/player.test.ts` "keeps a participant-local PRO pause
    gate closed across volume changes" and "adopts a pause gate that arrives during an in-flight
    preparation".
  - Teardown: `src/youtube/__tests__/stale-async-guards.test.ts` "revokes a pending PRO pause gate
    before a late settlement can unmute parking".
  - Visibility: missing.
- **Status:** `duplicated`. Phase 6 (single iframe-audio owner, one verified restore, a ratchet on
  direct audio writes).

### RO-13 YouTube manual-offset transaction

- **Resource:** a Standard host's or PRO participant's local manual-offset edit applied to the
  iframe.
- **Current owners/flows:** `src/youtube/standard-host-manual-offset-gate.ts` with the lazy
  `standard-host-manual-offset-runtime.ts` (sub-plan in `standard-host-rendezvous.ts`). Other
  machines check the fail-closed query `isStandardHostManualOffsetTransactionPending`
  (`player.ts`, `sync.ts`, `iframe.ts`, `handlers.ts`, `native-control-authority.ts`,
  `src/player/playlist.ts`); deferred actions wait on settlement listeners; the transaction retires
  the local start and the end hold; the PRO orchestrator resets it before every prepare and
  commit.
- **Target single owner:** unchanged; Phase 6 talks to it only through the existing retire port.
- **Allowed requesters:** the manual-sync input; readers through the pending query.
- **Lifecycle operations:** begin, apply, settle, cancel and reset
  (`cancelStandardHostManualOffsetTransaction`, `resetStandardHostManualOffsetTransaction`).
- **Deadline owner:** the manual-offset runtime.
- **Timing-constant home:** the runtime module.
- **Anchor tests:**
  - Supersession: `src/youtube/__tests__/standard-host-manual-offset-gate.test.ts` "keeps deferred
    work behind a rapid follow-up transaction"; `manual-offset-apply.test.ts` "retires an older
    apply while a newer nudge is still being debounced".
  - User pause/stop: `src/youtube/__tests__/host-local-rendezvous.test.ts` "keeps paused-origin
    input paused and performs no scheduled resume".
  - Teardown: `standard-host-manual-offset-gate.test.ts` "discards deferred work on a hard media
    transition".
  - Visibility: missing.
- **Status:** `owner-in-place`. See
  [Standard host YouTube manual sync](standard-host-youtube-manual-sync.md).

### RO-14 YouTube iframe instance lifecycle

- **Resource:** the iframe instance: create, precreate, iOS prime, park, destroy.
- **Current owners/flows:** the loader and iOS prime flow in `src/youtube/iframe.ts`
  (`precreateYouTubePlayer`, `createYouTubePlayer`, `primeBounceAttempt`);
  `RetainedYouTubePlayerController` (`retained-player-controller.ts`), wired through ports that
  `iframe.ts` defines and also writing the prime flags; `stopYouTubeMode` (`player.ts`), which
  parks or destroys.
- **Target single owner:** unchanged: `iframe.ts` owns the instance and delegates parking to the
  retained-player controller through its ports. Phase 6 only registers a parking audio hold.
- **Allowed requesters:** `stopYouTubeMode` (park or destroy request); the guest heartbeat
  hand-off (`prepareSyncHandoff`).
- **Lifecycle operations:** create, precreate, prime bounce, park, destroy.
- **Deadline owner:** the retained-player controller (it destroys an iframe whose mute it cannot
  prove).
- **Timing-constant home:** `iframe.ts` and `retained-player-controller.ts`.
- **Anchor tests:**
  - Supersession: `src/youtube/__tests__/retained-player-controller.test.ts` "fences a superseded
    target generation and accepts the latest release boundary".
  - User pause/stop: `stale-async-guards.test.ts` "carries explicit Stop ownership across its
    IDLE-before-stop-mode ordering".
  - Teardown: `retained-player-controller.test.ts` "destroys an offscreen owner when physical mute
    cannot be proven".
  - Visibility: missing.
- **Status:** `owner-in-place`. Exception RO-34.

### RO-15 Standard logical data connection liveness

- **Resource:** one admitted `CloudflareDataConnection` (original data PC, isolated control side
  PC, data and control channels); every machine ends it through the link-liveness owner's
  `close(cause)`, whose close port is the connection's private `terminate()` (since C5-10).
- **Current owners/flows:** `LinkLiveness` in `src/network/transport/link-liveness.ts` owns the
  original PC's outage since Phase 4 C5-6 (its interruption, disconnected grace, published
  recovery deadline, restartability binding and one-restart gate) and the guest background-resume
  probe since C5-7 (`recoverAfterBackground`, reached from `app.ts` through
  `recoverPeerAfterBackground` in `src/network/peer.ts`; it deliberately closes after a long
  hidden period unless both PCs are connected and the exact challenge reply arrives).
  `CloudflareDataConnection` in `src/network/transport/cloudflare-signaling.ts` creates it, feeds
  it the original PC's state changes and every received frame, reads both PCs and their channels
  for it through one snapshot port, sends its challenge, and delegates `iceRestartBinding`,
  `iceRecoveryDeadline`, `beginIceRestart`, `finishIceRestart`, `recoverAfterBackground`,
  `reconcileBackgroundResumeRecovery` and the stop in `terminate()` to it. Since C5-8 the
  connection also exposes the owner as its read-only `linkLiveness` view
  (`TransportLinkLivenessView` in `src/network/transport/types.ts`: the original route's phase
  and the published deadline), which `src/network/transport-health.ts` reads (RO-17, RO-18).
  Since C5-10 the owner also holds the close: every close of the link (its own causes, the
  channels' close events, the bulk credit sender's control-send failure, the side route's
  `fail(reason)`, and `close(reason)` from the provider and the application) enters
  `LinkLiveness.close(cause)`, which keeps the link's first cause and calls the connection's
  private `terminate()` through its close port; `terminate()` writes the one cause line and
  disposes the PC and channels.
  Since C5-9 the owner also keeps the side (isolated control) PC's outage deadline.
  `ControlIsolation` (`src/network/transport/control-isolation.ts`) reports each side PC state
  to it as its `SideOutageOwner` (`sideChanged` with whether the route restarts its ICE,
  `sideGraceRunning`, `sideMaySignal` before restart signaling, `sideClosed`) and keeps the
  restart protocol: attempts, the 15 s peer-request and 30 s offer windows, epochs, candidates,
  fence and READY. The owner calls back `outageStarted`, `outageEnded` and `outageExpired`, and
  on each original transition that is not holding back a side outage (the original route is up,
  or no restartable side outage is held) the connection's `sideMayRestart` port calls
  `mayRestart`; a transition that leaves the original down while such an outage is held only
  marks it deferred, as control isolation's `originalChanged` returned early before C5-9.
- **Target single owner:** the link-liveness owner `src/network/transport/link-liveness.ts`
  (the original route since C5-6, the resume probe since C5-7, the side route's outage deadline
  since C5-9) holding the per-route outage deadlines, the resume probe and one close with a
  cause; the two modules keep their SDP and in-band restart executors.
- **Allowed requesters:** transport consumers through `close(reason)`, which enters the owner's
  close (C5-10); transport health reads the owner's `linkLiveness` view for the bulk lanes, the
  preload pause and the heartbeat lease (RO-17, RO-18; Phase 4 C5-8).
- **Lifecycle operations:** start and cancel grace, ICE restart, background probe, close with a
  cause (through `terminate()`).
- **Deadline owner:** the original PC's 15 s grace; the side route's 15 s per outage, deferred
  while the original is down, re-armed to 15 s after it recovers and capped at 30 s from the
  outage's start, and its non-renewing 15 s grace before READY (in `link-liveness.ts` since
  C5-9, on the monotonic clock); the probe's short close (its 3 s
  challenge window and its 1 s look at a disconnected route, both in `link-liveness.ts` since
  C5-7). No deadline covers a peer's bulk-credit or control-isolation hello (accepted limit,
  old-version removal train 2, survey OV-F01, App build floor 787): bulk on the link waits for
  both with no fallback timer, so without the isolation hello no bulk byte leaves and without the
  credit hello only the first 128 KiB window does. Every end at the floor sends both once its
  admission settles (`startBulkFlowControl`), on the ordered, reliable original control channel,
  so a hello goes missing only when that channel fails, which closes the link through its close
  event, or from a peer below the floor, reachable only while the effective floor reads 0. The
  wait has no timer, line or close of its own; replacing the connection ends it
  ([report](old-version-removal-2a-app-2026-10-26.md#남긴-것과-후속)).
- **Timing-constant home:** `RTC_INTERRUPTION_GRACE_MS` in `src/core/constants.ts` (Phase 4,
  C5-1): the original PC's grace and the connection's background-resume threshold
  (`link-liveness.ts`), the provider's background-resume threshold and the restart answer wait
  (`cloudflare-signaling.ts`), the side PC's outage window, its cap of two graces and its grace
  before READY (`link-liveness.ts`, since C5-9) and the heartbeat monitor's lease cap (RO-17).
  `control-isolation.ts` keeps `RESTART_WINDOW_MS` (15 s) and `RESTART_CAP_MS` (30 s) as its own
  literals: since C5-9 they bound only the peer restart requests and offers, which the two ends
  enforce on each other, so a change to the grace must not move them (`control-isolation.test.ts`
  "keeps the 15 s peer-request window and the 30 s offer window as literals"). The old-version
  removal train revisited this (survey TR-15) and kept both literals: older builds are no longer a
  design constraint, but consecutive builds still meet in a room while the update dialog lets a
  tab wait, and the two windows are a wire contract between them (an answerer closes on the 17th
  offer inside its own 30 s, so an offerer with a shorter window would trip it). Changing one is a
  wire change: the receiver first, then a client floor, then the sender. Before C5-9 the side
  outage window and cap were those two literals; since C5-9
  they follow the grace (one grace and two graces, the same values today), so a change to
  `RTC_INTERRUPTION_GRACE_MS` also moves the local side outage window and cap while the peer
  windows stay. This coupling is an implementation choice the owner delegated in train 4D and has
  not yet confirmed ([report](phase4-4d-side-route-owner-2026-10-25.md#오너-결정)).
- **Anchor tests:**
  - Supersession: `src/network/transport/__tests__/cloudflare-signaling.test.ts` "rolls an
    unanswered restart back if the old path recovers before its answer".
  - User pause/stop: `cloudflare-signaling.test.ts` "suppresses synchronous channel errors caused
    by an intentional close".
  - Teardown: `cloudflare-signaling.test.ts` "closes and disposes every RTC resource exactly once
    after disconnected grace expires".
  - Visibility: `cloudflare-signaling.test.ts` "does not grant a fresh full grace when a
    long-hidden disconnected RTC resumes".
  - Mixed versions: since the old-version removal train (survey OV-B07, TR-03 stage 1) every
    isolated-control peer is restart-capable, and the frozen C9 fixture (the 8.11.23 runtime) and
    its rows are deleted under the owner's old-version policy of 2026-10-25. Since train 2
    (survey OV-F03, App build floor 787) no end sends the `restart-capable` frame and the kind is
    no longer parsed: `control-isolation.test.ts` "sends no restart advertisement: its request and
    then its fence open the negotiation" pins the sender, "consumes a 9.0.14 end's restart
    advertisement at every phase without effect" and "restarts a %s side PC in place beside a
    9.0.14 peer's advertisement" pin the copy a 9.0.14 end still sends, and "ends the route at its
    own 15 s deadline when a %s side PC gets no restart answer" (the accepted degradation with an
    8.11.23 peer) pins the unanswered restart. `side-route-outage-integration.test.ts` "the
    restart-capable advertisement" and "a peer whose restart answer never arrives" pin both
    through two real connections with the device lines. A Wi-Fi to LTE switch with both PCs is
    device-only. On the original route, since train 2 (survey OV-F04 stage 1, App build
    floor 787) every Standard connection takes its restartability binding from the initial negotiation
    whether or not the first offer or answer carries `iceRestartVersion` (ends from 8.6.39 to
    9.0.21 send it; since train 3, stage 2 with App build floor 789, a Standard client sends it on
    neither the first offer nor any answer, and the restart offer keeps requiring it):
    `cloudflare-signaling.test.ts` "restarts a guest whose first answer carried no
    iceRestartVersion", "answers an exact restart in place for a guest whose first offer
    carried no iceRestartVersion" (both of its answers carry none) and "sends a Standard guest
    first data offer without iceRestartVersion", and `room-expiry-liveness.test.ts` "restarts a
    guest whose host answered without the ICE restart marker". The resume challenge carries only
    its ping id (survey OV-A12): `link-liveness-characterization.test.ts` "sends one
    control-lane challenge and closes exactly 3 s later without its pong".
  - Characterization before the owner moves (tests only, #478):
    `src/network/transport/__tests__/link-liveness-characterization.test.ts` (grace, restart gate,
    effect order, background-resume probe outcomes) and `room-expiry-liveness.test.ts` (the #471
    expiry rows); at the browser level the C5-0 lab `e2e/lab/route-outage.lab.ts` on the
    Cloudflare transport (not in CI).
  - The owner (C5-6): `src/network/transport/__tests__/link-liveness.test.ts` (every port call in
    order, a state callback that re-enters the restart gate or closes the connection, the pre-open
    grace, the non-renewing deadline across restarts, the host connection without a state
    callback), in the critical coverage profile with `link-liveness.ts` at full coverage. Since
    C5-7 the same suite pins the resume probe across both routes with each close's cause: a side
    PC that reads failed or closed, an active side channel that is not open, the 1 s look's three
    conditions, the side-route challenge and its exact pong, and a probe close inside an original
    transition before the state callback; the owner's own cases pin every probe outcome, the timer
    keys and the stop. The 4C review added "the connection's managed timer keys" (the grace key
    `cloudflare-data-disconnected-grace-N`, numbered per connection, and its two probe suffixes),
    the grace armed and published before the side route hears a disconnected (on the owner and
    through a connection), and a second resume that starts a probe that saw no disconnected while
    a running 1 s look keeps its first deadline.
  - The view (C5-8): `link-liveness.test.ts` "the original route as transport health reads it"
    (the phases through a restart that reads connecting, a side-only outage that neither blocks
    bulk nor counts as an interruption) and "reads its phase from the original route alone";
    `src/network/__tests__/transport-health.test.ts` "with the link-liveness owner view" and the
    owner-view golden table `src/storage/__tests__/__fixtures__/bulk-writable-owner-view-truth-table.txt`.
  - The close (C5-10): `link-liveness.test.ts` "one close per link, whoever reports it" (green on
    the code before the move: the first cause is the only line, later reporters add nothing, and
    a close re-entered while the connection disposes still emits `close` before the second
    channel and the PC close) and "the one close input (C5-10)"; the static lock in
    `src/core/__tests__/transport-health-guard.test.ts` "transport-health guard: the link-liveness
    owner (C5-10)" (16 retired names since the 4C review added the connection's former first-cause
    field `closeCause`, 24 since train 4D added the side route's eight former deadline names) and
    "transport-health guard: the side outage deadline (C5-9)" (each of the eight names fails in
    `control-isolation.ts` as a member, a call or a string key, `originalChanged` fails in the
    connection, the owner may keep them, and test files stay out of scope; the guard itself flags
    them in any production file under `src/` but `link-liveness.ts`).
  - The side route's outage (C5-9): `src/network/transport/__tests__/side-route-outage-integration.test.ts`
    (two real connections, each with its real owner and side route, written and green on the
    9.0.10 code before the move, train 4D D0: the side's own 15 s, the original down before or
    after it, the re-arm 15 s after the original recovers and the 30 s cap also while the
    original is down again, a restart in flight across a recovery, the grace before READY with
    its fall back and its take-over at READY, the restart budget and the offer bound, the three
    device lines by level and end, the close causes, the monotonic clock and, since the old-version
    removal train, "the restart-capable advertisement" (since train 2 none is sent and a 9.0.14
    end's copy changes nothing) and "a peer whose restart answer never arrives", which replaced
    the frozen C9 peer)
    and `link-liveness-side-outage.test.ts` (the owner's side outage on its own: every call on the
    side route and line in order, the original route's readings, the side PC's close and stop),
    both in the critical coverage profile. `control-isolation.test.ts` and
    `control-isolation-evidence-logs.test.ts` keep their assertions and drive a real owner
    through `__tests__/fixtures/side-outage-owner.ts`.
- **Status:** `owner-in-place` since C5-9 (train 4D), which moved the last second machine, the
  side route's outage deadline, into the owner; see the end of this field. Grace constant shared
  in Phase 4 (C5-1). Close causes in Phase 4
  (C5-5): every `terminate()` site names its cause, callers name theirs through `close(reason)`,
  and the connection keeps the first one and logs one info line per close
  (`[Transport] Logical connection closed (<cause>) for <peerId>`); no timer or state moved.
  Train 4B (owner decisions 2026-10-25) adds three causes that no longer read `intentional`:
  `transport-error` (the host's per-connection error handler, a host that cannot answer a current
  guest offer, the guest join's pre-open error handler), `join-bootstrap-failed` (a join
  handshake that fails on either side) and `pro-epoch-advanced` (the PRO epoch batch close,
  reachable only on the legacy close name while the client and Worker epoch close names differ).
  A cause noted by the provider's own emit-then-close (`closeAfterError`) now wins over the
  listener's reason, so a room admission expiry still reads `admission-expired`. A Standard-room
  guest also keeps its page's last close cause and time across its disconnect reload (P4-D5 B,
  `src/network/last-link-close.ts`, sessionStorage key `mxqr-prev-close` beside the next-document
  markers in `src/core/navigation-contract.ts`), and the next page in the tab that logs info lines
  logs it once; no timer, deadline or close order changed. Only the Standard guest's disconnect
  dialog and removal reload keep it; a PRO room connection's close is noted in memory too, but no
  PRO path keeps it. The link-liveness owner (C5-6) and the
  background-resume check (C5-7) were held until the #18 and preload-resume device items in the
  release record closed or were waived (owner decisions P4-D6 A and P4-D13 A, 2026-10-24); since
  the owner decision of 2026-10-25 (about 01:50 KST) device evidence no longer gates code, and
  both proceed after train 4B as their own train (4C). C5-6 moved the original route's
  interruption, grace, published deadline, restartability binding and restart gate into
  `LinkLiveness` without a behaviour change: the same managed timer key
  (`cloudflare-data-disconnected-grace-N`), the wall-clock published deadline, the non-renewing
  grace, the effect order on every transition (cancel grace, reopen the gate, the resume probe's
  reaction, the state callback, the side route's notification, `ice-recovered`; on disconnected
  the probe and the callback run before the grace is armed and a close inside the callback arms
  nothing), the host connection's grace without a state callback and the #471 expiry rules.
  C5-7 moved the guest background-resume probe into the same owner without a behaviour change:
  its armed challenge (ping id and whether a route read disconnected), the same two managed timer
  keys (`cloudflare-data-disconnected-grace-N-background-resume-liveness` and
  `-background-resume-disconnected`), the 3 s window and the 1 s look, the reads of both PCs and
  their channels (the side PC's state and an active side channel included), every outcome and
  close cause (`resume-stale`, `resume-disconnected`, `resume-probe-unanswered`), the exact
  SYNC_PONG on either lane, and its place in the effect order (on connected after the grace and
  the gate, before the state callback; on disconnected before the state callback). The provider's
  and the peer's background-resume calls and `TransportBackgroundRecoveryStatus` are unchanged.
  C5-8 (behaviour-risk) made transport health read the owner instead of re-deriving the original
  route from the PC's `connectionState`: every `CloudflareDataConnection` (Standard and PRO rooms
  alike; a PeerJS connection has none) exposes the owner as `linkLiveness`, whose
  phase is `opening` until the link opens, `recovering` while the owner holds an interruption
  (disconnected, or a restartable failed, until a `connected` event) and the route does not read
  `connected` (the condition under which its grace closes), `closed` once stopped, and `live`
  otherwise; the side route never makes it `recovering`. The heartbeat lease reads the owner's
  published deadline (the value `iceRecoveryDeadline` already delegated). The raw
  `iceConnectionState` rows stay in the predicates, which the owner does not observe, and no log
  compares them with the owner (Phase 4 owner default, 2026-10-24). The intended change is the restart
  window: a route that reads `connecting` or `new` while the owner still holds its interruption no
  longer counts as bulk-writable and pauses a preload lane, which resumes on the owner's
  `connected` (`ice-recovered`) rather than on an earlier selected-pair report. The owner, its
  timers, deadlines, effect order and close causes are unchanged. A connection without an owner
  (PeerJS) is read as before. The side route stayed in control isolation then, and every close
  still goes through the connection's `terminate()`. C5-10 (the connection part; C5-9 was not in
  train 4C, so control isolation kept its own deadline, `originalReady` and `originalChanged`)
  routed every close through the owner without a behaviour change: the owner's `close(cause)`
  keeps the first cause and passes every close, the ones the connection's disposal re-enters included, to the
  connection's private `terminate()`, so the cause line, the next-page note, the place of the
  `close` event during disposal and the dispose order are unchanged. It removed the connection's
  first-cause field and its grace key field (the key text is unchanged). The transport-health
  guard now locks the owner: the names of the machines it replaced appear only in
  `link-liveness.ts`, production code constructs it only in the connection, `terminate()` stays
  private and is referenced only inside the owner's close port, and the owner calls that port
  only from `close(cause)`. The side route's outage was then the one second machine left on the
  resource (exception RO-35, deleted by C5-9). After known-accepted #18 retired on 2026-10-25
  (the owner's Wi-Fi to LTE device check on production 9.0.10 with a Safari guest; an Android
  phone, another SSID, a remote LTE guest moving to Wi-Fi and the host console were not checked;
  [release record](../release-record.md#최근-해결-근거)), the owner decided the same day
  (about 16:30 KST) to do C5-9 as train 4D, with a forward revert to the 9.0.10 side-route
  behaviour if the later device check fails. C5-9 moved the side PC's outage into `LinkLiveness`
  without a behaviour change: 15 s per outage of a restartable route, deferred while the original
  route is down (its PC not connected or its control channel not open, sampled where control
  isolation sampled it), re-armed to 15 s after the original recovers and capped at 30 s from the
  outage's start, a connected side PC at the deadline ending the outage quietly; the non-renewing
  15 s grace of a route that cannot restart (before READY, or, until the old-version removal
  train, with a peer without restart), which the
  original never defers and whose end fails the route's setup (decline and fall back, or end the
  link with `side-failed:route`), taken over at READY by a restart outage that starts then; the
  monotonic clock and a timer of its own (not a managed one) that the side PC's close and stop
  clear. The recovered and did-not-recover lines moved with it, byte-identical at the same level
  and on the same end; the restart line, the attempts, the windows, every frame, epoch,
  candidate, fence and READY rule and the close causes stay in control isolation, and no wire
  frame changed. Control isolation lost its outage deadline, timer and original-down flag, its
  disconnect grace timer, `beginInterruption`, `armDeadline`, `restartExpired`,
  `endInterruption`, `originalChanged` and its `originalReady` option. The transport-health
  guard's retired names now include these eight (`beginInterruption`, `armDeadline`,
  `restartExpired`, `endInterruption`, `originalReady`, `originalChanged`, `originalDown`,
  `disconnectedTimer`; train 4D, the control-isolation part of C5-10), so none of them can come back in a
  production file but `link-liveness.ts`, where only the owner's `originalDown` flag lives on;
  the frozen C9 fixture kept its old grace timer as a test file, outside the guard. The
  old-version removal train (survey OV-B07, TR-03 stage 1) then made every isolated-control peer
  restart-capable: control isolation no longer waits for the peer's `restart-capable` frame,
  which it still sent before its request and fence until train 2 (survey OV-F03, App build
  floor 787) stopped sending it and stopped parsing the kind, so a route that cannot restart is one
  before READY only. Control isolation's 10 s negotiation bound, armed before the side PC exists, ends
  such a route (decline and fall back, or `side-failed:route` once fenced) before the owner's
  15 s grace can run out, or READY takes the grace over; the owner keeps that grace and the
  take-over unchanged, and the grace's own end stays pinned on the owner alone
  (`link-liveness-side-outage.test.ts`). With an 8.11.23 peer, which neither advertises nor
  answers a restart, a side outage now ends the link at its own 15 s deadline with
  `side-failed:expired` after the did-not-recover warning, instead of at once (failed) or after
  the grace (disconnected) with `side-failed:route`; the owner's policy of 2026-10-25 accepts
  this. The frozen C9 fixture and its rows are deleted, and the device lines, the owner, the
  windows and the wire are unchanged. See
  [Control isolation side ICE restart](control-isolation-side-ice-restart-2026-10-19.md), the
  [Phase 4 train 4A report](phase4-4a-transport-rejoin-2026-10-24.md), the
  [Phase 4 train 4B report](phase4-4b-behaviour-2026-10-25.md), the
  [Phase 4 train 4C report](phase4-4c-link-liveness-2026-10-25.md) and the
  [Phase 4 train 4D report](phase4-4d-side-route-owner-2026-10-25.md).

### RO-16 Data-PC SDP lane

- **Resource:** the signaling state of the shared data PC, which Standard P2P system-audio media
  calls also negotiate on.
- **Current owners/flows:** ICE restart and media negotiation (`MediaNegotiationOwner`) in
  `cloudflare-signaling.ts` share one serialized lane (`runSerializedMediaNegotiation`) and one
  per-peer `iceNegotiations` slot. A restart refuses while a media owner is unsettled; a media
  offer rolls back a restart, and a settled negotiation re-queues it.
- **Target single owner:** unchanged; the lane already is the owner. Phase 4 (C5-6) moved only
  the restart gate behind the link-liveness owner.
- **Allowed requesters:** `call()` and incoming media offers (system audio); the restart path.
- **Lifecycle operations:** set and roll back local and remote descriptions, restart offer and
  answer.
- **Deadline owner:** the restart attempt's answer wait; media negotiation rolls back on a
  crossing offer.
- **Timing-constant home:** `cloudflare-signaling.ts`.
- **Anchor tests:**
  - Supersession: `cloudflare-signaling.test.ts` "rolls back a crossing guest restart, rejects its
    late answer, then restarts after media".
  - User pause/stop: `cloudflare-signaling.test.ts` "does not run a queued media offer after the
    exact call closes synchronously".
  - Teardown: `cloudflare-signaling.test.ts` "retires the exact shared data connection when owned
    rollback fails".
  - Visibility: n/a.
- **Status:** `owner-in-place`. The restart gate (`beginIceRestart`, `finishIceRestart`) is the
  link-liveness owner's since Phase 4 C5-6 (train 4C; see RO-15); the lane, its restart executors,
  their checks and their order are unchanged. Since Phase 4 4A (C5-5) an unprovable restart rollback and the
  media rollback retirement close with the cause `rollback-unproven`. Phase 5 starts from a fresh
  baseline because system audio shares this lane.

### RO-17 Host per-guest connection close

- **Resource:** each guest's connection on the host.
- **Current owners/flows:** the heartbeat monitor (`src/network/heartbeat-monitor.ts`) detaches
  and closes stale peers. It classifies transport grace and honours the transport's recovery
  lease through the pure read path `src/network/transport-health.ts` (`heartbeatStaleThreshold`,
  `honoursRecoveryLease`): on a Cloudflare connection (every `CloudflareDataConnection`, PRO
  included) the link-liveness owner's published deadline (`linkLiveness.recoveryDeadline`, C5-8),
  otherwise (PeerJS) `conn.iceRecoveryDeadline`; the
  transport grace and the link-liveness owner's close (RO-15) close independently.
  Detach is fenced by connection identity (`detachHostPeerConnection` in
  `src/network/host-peer-departure.ts`).
- **Target single owner:** the heartbeat monitor keeps the heartbeat leases and stale fencing that
  [Realtime runtime ownership](realtime-runtime-ownership.md) assigns to it, but reads transport
  recovery only through one transport-health view.
- **Allowed requesters:** host session teardown; readers of the peer list.
- **Lifecycle operations:** record heartbeat, detach, close, publish disconnect.
- **Deadline owner:** the monitor's stale thresholds (8 s closed, 30 s recovering, 90 s connected)
  and the transport's recovery deadline.
- **Timing-constant home:** the stale thresholds `HEARTBEAT_STALE_THRESHOLD` (8 s),
  `HEARTBEAT_RECOVERING_TRANSPORT_GRACE` (30 s, a different contract that shares 30 s) and
  `HEARTBEAT_LIVE_TRANSPORT_GRACE` (90 s) in `src/network/transport-health.ts` (Phase 4, C5-4);
  the check cadence `HEARTBEAT_CHECK_INTERVAL` (5 s) stays in `heartbeat-monitor.ts`. The lease
  cap in `transport-health.ts` imports the transport grace `RTC_INTERRUPTION_GRACE_MS` from
  `src/core/constants.ts` (Phase 4, C5-1).
- **Anchor tests:**
  - Supersession: `src/network/__tests__/heartbeat-monitor.test.ts` "records heartbeat only for the
    exact connected connection".
  - User pause/stop: n/a.
  - Teardown: `heartbeat-monitor.test.ts` "detaches every stale peer before close, tolerates close
    errors, then emits and broadcasts".
  - Visibility: missing.
  - Cross-owner: `heartbeat-monitor.test.ts` "honors only an exact bounded ICE recovery lease
    before cleaning a failed PC"; with a real `CloudflareDataConnection` (C5-8) "honors the real
    lease of a Standard-room connection through a restart until its grace closes it".
- **Status:** `duplicated`. Transport grace imported in Phase 4 (C5-1). One transport-health read
  path in Phase 4 (C5-4): the monitor reads no raw RTC state except its stale-peer warning
  (`npm run guard:transport-health`, `scripts/check-transport-health.mts`, in CI; see
  [Realtime runtime ownership](realtime-runtime-ownership.md)). Its stale close names the cause
  `heartbeat-stale` (C5-5), which since C5-10 enters the link-liveness owner's close like every
  other close. The transport's own grace (the link-liveness owner since C5-6) and its close
  (RO-15) still close the connection independently of the monitor, so on the host an
  original route that fails without a restart binding ends as `original-terminal` before the
  monitor's threshold. Since C5-8 the read path takes the recovery lease from that owner's
  `linkLiveness` view (the value `iceRecoveryDeadline` delegates, so the lease is unchanged); the
  stale thresholds still read the peer connection's `connectionState`.

### RO-18 Host-to-guest bulk lanes

- **Resource:** one connection's data channel and its bulk credit, shared by the main file lane
  and the preload lanes.
- **Current owners/flows:** the main lane registry in `src/storage/transfer-send.ts`
  (`_activeUnicasts`, `_peerTransferOwners`, `_preparingUnicasts`; on an ICE interruption it
  excludes the peer and relies on the guest's recovery request) and the preload registry in
  `src/storage/preload.ts` (`_activePreloadUnicasts`, `_preloadPeerOwners`,
  `_suspendedPreloadLanes`; it suspends and resumes from chunk 0 on `network:peer-ice-recovered`).
  Both lanes read writability and the preload lanes read an interruption through
  `transport-health.ts`, which on a Cloudflare connection (every `CloudflareDataConnection`, PRO
  included, though PRO persistent media does not use these lanes) takes the original route from the
  link-liveness owner's phase (Phase 4 C5-8, RO-15): a lane stays paused while the owner holds the
  interruption, also while the restarted route reads `connecting`, and a side-only outage neither
  blocks bulk nor pauses preload. The preload lane asks `hasPendingCurrentFileTransfer`. A peer disconnect or replacement releases
  both lanes in one call (`releaseBulkLanes` in `preload.ts`, registered by `initPreload`: the main
  lane first, then the preload lanes), and `isMainLanePreparingOrActive` in `transfer-send.ts`
  answers whether the main lane is preparing or streaming one exact (connection, queue item,
  session) tuple (Phase 4 reduced C5-11).
  One stream per tuple after ICE recovery (Phase 4 C5-12, owner decision P4-D10 A, 2026-10-25;
  host rule simplified by C5-12 Inc 3, old-version removal train 2): the explicit main-lane
  recovery wins. When the main lane is preparing or streaming the exact tuple,
  `resumeSuspendedPreloadLane` does not restart a preload paused by the interruption on
  `network:peer-ice-recovered`, and a restart already running (`unicastPreload` with `restart`)
  stops at its next check once the main lane takes the tuple; `canContinue` asks the suspend check
  first, so a second interruption still pauses it. The rule reads no route: the host re-detects
  the recovered route only after announcing the recovery (`host.ts` resets the peer to `unknown`),
  and the yield does not wait for that publication. A guest awaiting the preload takes the main
  `FILE_START` while its own route is `local` (`shouldAcceptLocalDirectFileStart` in
  `transfer-receive.ts`), and on any route when the header names a session the host admitted to it
  directly on that connection (`isGuestDirectFileDelivery`; the preload's own `PRELOAD_START`
  recorded it; C5-12 Inc 1, 9.0.14). The main lane the preload yields to always carries the
  preload's own session, whatever started it (the guest's stall request, a request without a
  session, or the current-file bootstrap once the route turns local), so the guest takes its
  header even when the bulk channel overtakes the host's route publication on the control route.
  A header for another session is still dropped unless the route is `local`, and an R2 delivery is
  refused first. A guest below 9.0.14 took the header only on narrower conditions, so from 9.0.9
  to 9.0.14 the host let a restart yield only after it had published `local` for that connection
  with no recovery announcement since (`RestartedPreloadLane`); Inc 3 removed that permission
  once the App build floor (787, RO-50) kept those guests out. The yield follows the deferred-abort
  rule: one `PRELOAD_ABORT` for the tuple, sent after recovery and never followed by a host
  preload resend, and one info line,
  `[Preload] Yielding preload for <peer> to its file transfer after its connection recovered`; a
  lane that yields at recovery logs no `Resuming` line. Until 9.0.8 both lanes always streamed the
  whole file for the same tuple after recovery (survey F4). A late-join unicast and the room's
  preload broadcast do not yield.
  Known limits (C5-12 review, 2026-10-25, and C5-12 Inc 3):
  - One stream per tuple is not absolute. Both lanes still carry the whole file when the main lane
    reaches `FILE_END` before the restart's next check (a completed owner is a fence, not a
    stream), or when the restart reaches `PRELOAD_END` before the guest's request arrives. Each
    matches 9.0.8; none is a regression. The guest then plays the main lane while the restart also
    reaches its END (it keeps a second resident copy only when the main header came first).
  - The abort travels on a control route and the restart header on the bulk channel, so the abort
    can overtake it (the C5-0 lab's usual order). The guest then admits the restart as an
    explicit retry of the session the abort skipped and holds an orphan partial preload (an
    assembling RAM lease, `preload.activeTarget` on the current track, `preload.ready` cleared)
    until its progress watchdog releases it (two progress deadlines, about 30 s), and its loader
    watchdog logs the existing WARN `[Preload] Watchdog: forcing preload loader reset after 30s`
    30 s after that header. Playback takes the main lane. "Never followed by a host preload
    resend" describes the host's wire order, not what the guest processes. A later guest-side
    change could ignore a restart START for a session already aborted on the control route.
  - Only a guest below the App build floor (787) can drop the main header after a yield; it then
    waits in AWAITING_PRELOAD with no stream until the next track or a user action. The floor
    filters new entries and reconnects, so such a guest reaches a host on this rule only while the
    effective floor reads 0 (a live-App report older than `APP_BUILD_FLOOR_REPORT_STALE_MS`, or a
    failed read in a reader with no earlier value; RO-50). The owner's policy accepts it
    (2026-10-25: older App versions are not a design constraint).
- **Target single owner:** one bulk-lane registry (planned `src/storage/bulk-lanes.ts`); per-lane
  policies, pumps and wire frames unchanged.
- **Allowed requesters:** file send, preload scheduling, the guest's recovery request.
- **Lifecycle operations:** register, suspend, resume (or, while the main lane prepares or
  streams the same tuple, yield to it instead of resuming or at the restart's next check, C5-12),
  cancel, release on disconnect or replacement (one call for both lanes).
- **Deadline owner:** each lane's backpressure timeout.
- **Timing-constant home:** `src/storage/transfer-backpressure.ts` (Phase 4, C5-3):
  `BULK_LOCAL_BUFFER_LIMIT_BYTES` (64 KiB of local queue, every lane) and
  `BULK_UNICAST_STALL_TIMEOUT_MS` (30 s, the main-file and preload unicasts). The broadcast stall
  timeouts stay their own constants and differ on purpose: 5 s for the main-file broadcast
  (`transfer-send.ts`) and 30 s for the preload broadcast (`preload.ts`), which tolerates
  congestion longer so a guest does not restart the next track from zero.
- **Anchor tests:**
  - Supersession: `src/storage/__tests__/preload-lane-ownership.test.ts` "forgets a paused lane
    whose connection was replaced"; both lanes in one release:
    `src/storage/__tests__/bulk-lane-release.test.ts` "%s ends the main lane and the preload lane
    parked behind it".
  - User pause/stop: missing.
  - Teardown: `src/storage/__tests__/preload-capacity-lifecycle.test.ts` "cancels a parked sender
    without flushing stale bytes into a replacement unicast or ACK".
  - Visibility: n/a (host lanes do not depend on visibility).
  - One stream per tuple after ICE recovery (C5-12):
    `src/storage/__tests__/ice-recovery-bulk-lanes.test.ts`, whose host publishes no re-detected
    route; host: "the restarted preload yields to the main lane once the request lands after
    recovery" and "the paused preload yields at recovery without a restart when the main lane
    already holds the tuple"; guest: "plays the surviving main lane with no second resident copy
    when its route is $guestRoute at the main FILE_START (request $arrival)" (`local`, `unknown`
    and `remote`), "takes the main lane it asked for when the header overtakes the local route
    publication", "takes a main FILE_START for the preload it awaits before its request while its
    route is %s" and "drops a main FILE_START for another session while its route is %s" (both
    `unknown` and `remote`; C5-12 Inc 1) and "a PRELOAD_ABORT that overtakes the bulk frames
    leaves the main lane intact" (the orphan prefix above); and at the wire the C5-0 lab
    `e2e/lab/route-outage.lab.ts` "host traffic for a track advanced during the outage, observed
    at the wire (F4)" (17 s outage; not in CI).
  - The owner's view (C5-8): `preload-lane-ownership.test.ts` "keeps an owner-view lane paused
    while its restart reads connecting, then restarts it on connected (C5-8)", "pauses an
    owner-view unicast whose interrupted route already reads connecting (C5-8)" and "pauses an
    owner-view broadcast lane when $name (C5-8)", beside the raw (PeerJS) path "restarts a
    raw-state lane at a recovery report once its PC reads connecting (the PeerJS path)";
    `src/storage/__tests__/preload.test.ts` "keeps a lane paused while its link owner holds the
    interruption through connecting (C5-8)"; `src/storage/__tests__/chunk-pump.test.ts` "matches
    the owner-view golden table whatever the PC connectionState reads"; and the C5-12 host rows
    through a real owner in `ice-recovery-bulk-lanes.test.ts`: "the restarted preload waits for
    its owner to hear connected, then yields to the main lane once the request lands after
    recovery" and "the paused preload waits for its owner to hear connected, then yields without
    a restart when the main lane already holds the tuple".
- **Status:** `duplicated`. Lane constants shared in Phase 4 (C5-3); one release call and the
  tuple query added in Phase 4 (reduced C5-11); the main lane wins the tuple after recovery
  (C5-12, P4-D10 A), from 9.0.14 a guest takes the main header for the preload's own admitted
  direct session on any route (C5-12 Inc 1), and old-version removal train 2 dropped the host's
  route permission once the App build floor kept older guests out (C5-12 Inc 3). Writability and
  the preload pause read the link-liveness owner on every Cloudflare connection (C5-8,
  behaviour-risk: the restart window that reads `connecting` now excludes the peer from a new
  bulk stream and pauses a preload lane until the owner's `connected`). The single bulk-lane
  registry stays a target; the lanes keep their own maps, policies and pumps. See
  [Preload resume after ICE recovery](preload-resume-after-ice-recovery-2026-10-20.md), the
  [Phase 4 train 4B report](phase4-4b-behaviour-2026-10-25.md), the
  [Phase 4 train 4C report](phase4-4c-link-liveness-2026-10-25.md) (C5-8) and the
  [old-version removal train 2 report](old-version-removal-2a-app-2026-10-26.md) (C5-12 Inc 3).

### RO-19 Guest fetch of the current track

- **Resource:** a guest's file request for the current queue item and its preload receive session.
- **Current owners/flows:** one replaceable request slot (`beginFileRequest`,
  `isCurrentFileRequestOwner` in `src/network/file-request-authority.ts`) and five independent
  waits: the chunk watchdog feeding the recovery backoff (`src/storage/transfer-receive.ts`,
  `src/storage/recovery.ts`), the FILE_PREPARE and preload waits in `transfer-receive.ts`, the
  preload admission watchdog (`preload.ts`, `src/storage/preload-watchdog.ts`), the PLAY_PRELOADED
  waiter (`preload-blob-watchdog` in `src/player/playback.ts`) and the R2 wait
  (`remote-share-wait-timeout` in `src/share/remote-share.ts`).
- **Target single owner:** unchanged; `file-request-authority.ts` stays the request-slot owner.
  The deadlines move into one typed table; no watchdog merge.
- **Allowed requesters:** the five waits above, through the request slot.
- **Lifecycle operations:** begin, send, match the wait response, complete, reset. RO-18 reads
  nothing from the slot: the 9.0.9 pending-recovery query (`isPendingRecoveryRequestFor`, Codex
  P2 on #487) was removed with C5-12 Inc 1 (9.0.14), whose guest rule reads the admitted direct
  delivery instead.
- **Deadline owner:** each wait; `playback.lifecycle` gates them.
- **Timing-constant home:** `src/core/constants.ts` (Phase 4, C5-3).
  `receiveDeadlineMs(kind, connectionType)` reads a typed table for the waits in
  `transfer-receive.ts`: the chunk watchdog (12 s local, 60 s remote), FILE_PREPARE (15 s / 60 s)
  and the awaited preload (30 s / 60 s).
  `PRELOAD_RECEIVE_DEADLINE_MS` holds the preload admission (30 s) and progress (15 s) windows
  (`preload.ts`, `preload-watchdog.ts`) and the preload loader watchdog (30 s after PRELOAD_START,
  15 s after progress). The PLAY_PRELOADED waiter (`playback.ts`) and the R2 wait
  (`REMOTE_WAIT_MS` in `remote-share.ts`) keep their own single-use values. Managed timer keys
  are unchanged.
- **Anchor tests:**
  - Supersession: `src/network/__tests__/file-request-authority.test.ts` "prevents a stale owner
    or completion from clearing its successor".
  - User pause/stop: `src/storage/__tests__/recovery-owner-transition.test.ts` "retires pending
    recovery after authenticated PAUSE and system-audio START".
  - Teardown: `file-request-authority.test.ts` "releases a current owner when its connection
    closes before send".
  - Visibility: missing.
- **Status:** `owner-in-place`. Deadline table done in Phase 4 (C5-3).

### RO-20 PRO system-audio lease and publication

- **Resource:** this participant's PRO system-audio lease credential and the publication of the
  captured track (the SFU publisher and the LAN-direct publisher session).
- **Current owners/flows:** split by design. `src/audio/system-capture.ts` owns the native capture
  and the pre-share snapshot and acquires through `beginProLeaseAttempt`, rolling back through the
  attempt's `releaseIfCurrent`. `src/pro-room/system-audio-service.ts` owns the lease and the
  publication: publish (`publishLocalProSystemAudio`), publisher recovery
  (`recoverLocalPublisher`, `cancelPublisherRecovery`), direct-to-SFU promotion
  (`promoteLocalDirectPublicationToSfu`, `reconcileAmbiguousDirectPromotion`), the lease heartbeat
  and the release retry. `src/pro-room/system-audio-controller.ts` holds the credential;
  `src/pro-room/system-audio-bridge.ts` documents the scoped attempt handle. `expectedLeaseTransitions`
  suppresses lease-lost during the service's own release and re-acquire. The publication's
  teardown is three named operations in the service, `clearLocalPublicationTimers` (the lease
  heartbeat, release retry, publisher retry and direct promotion retry timers),
  `retireLocalMedia` (the SFU publisher, the LAN-direct routes and the promotion state) and
  `resetPublicationHealth` (the heartbeat-failure toast latch and the LAN-direct authority-loss
  window). Every teardown entry point composes them in its own order: the explicit stop, the
  controller's lease loss, a new presence incarnation, the service reset, a terminated publisher
  recovery, a failed publish and leaving the PRO room context. A partial teardown names what it
  keeps for a later full one (`retireLocalMedia`'s `kept` argument). Phase 5 C4-12 replaced the
  hand-copied blocks (exception RO-40, deleted by C4-12) without changing what a site tears
  down or keeps.
- **Target single owner:** unchanged split.
- **Allowed requesters:** the capture session through the bridge; the
  `pro-system-audio:lease-lost` event back to capture.
- **Lifecycle operations:** acquire, release, publish, recover, promote, heartbeat.
- **Deadline owner:** the service (`LEASE_HEARTBEAT_MS` 15 s, `DIRECT_AUTHORITY_LOSS_GRACE_MS`,
  release retry). Each LAN-direct route's negotiation is the transport's own single attempt
  (`negotiatePublisherRoute` in `src/network/pro-system-audio-direct.ts`, one signaling round trip
  since the one-offer protocol, 2026-10-30): the answer within `DIRECT_NEGOTIATION_TIMEOUT_MS`
  (2 s) of the offer, then both ends' pair proofs within `DIRECT_PAIR_PROOF_TIMEOUT_MS` (1 s), so
  one route takes at most 3 s and a route that never answers still fails at 2 s. The receiver's own
  proof window is the same 2 s constant. The service awaits the attempt with no timer of its own.
- **Timing-constant home:** `system-audio-service.ts`; the LAN-direct negotiation constants above
  stay in `src/network/pro-system-audio-direct.ts`.
- **Anchor tests:**
  - Supersession: `src/pro-room/__tests__/system-audio-service.test.ts` "does not let a stale
    publisher recovery close the new incarnation publisher".
  - User pause/stop: `system-audio-service.test.ts` "fences a recovery acquire exactly once when
    the user stops while it is pending".
  - Teardown: `system-audio-service.test.ts` "does not revive retained direct routes or retry an
    SFU promotion after session reset"; `src/pro-room/__tests__/system-audio-publication-teardown.test.ts`
    pins each teardown entry point's remaining timers, SFU publisher stops, LAN-direct resets and
    lease-lost reasons.
  - Visibility: missing.
- **Status:** `owner-in-place`. Exceptions RO-39, RO-42.

### RO-21 PRO checkpoint re-apply after a disruption

- **Resource:** the local media endpoint as driven by `playbackController.reconcile`
  (`src/pro-room/playback-controller.ts`), whose prepare step pauses the YouTube iframe until
  release.
- **Current owners/flows:** `src/pro-room/runtime.ts` is the background-return repair authority
  since Phase 5 train 5B (plan step C4-13, owner decision P5-D11 B). Its foreground recovery
  (`recoverVisibleProRoomPlayback`, triggered by `visibilitychange` and the background-return
  Sync) and the restore callback it gives `system-audio-service.ts` both record a repaired return
  in `visibilityReturnReconciledGeneration`. The post-share restore in the service
  (`restorePlaybackAfterRelease`, `resumePlaybackAfterShare`, held while the page is hidden) only
  decides when to restore and runs through that callback. The callback marks the return it began
  in when its reconcile applied, its liveness is still current, the page is shown and no hide
  came since it began (the generation it captured is still `visibilityReturnGeneration`). A
  foreground pass reconciles as its own owner (the pass object), whose liveness goes stale once
  its return is marked: the scheduler drops it while it is still queued, or it stops at its next
  boundary. In the F3 order the drain starts it just before the restore callback resumes, so it
  runs its forced heartbeat and resolves false before its clock wait and prepare. A pass whose
  return is marked settles instead of scheduling a retry. Because the pass has its own owner, a
  manual Sync pressed during it queues behind it instead of joining (before, it joined only a pass
  already widened to every medium).
- **Target single owner:** reached (`runtime.ts`); the service keeps the decision of when to
  restore.
- **Allowed requesters:** the runtime's visibility handler, the background-return Sync, and the
  post-share restore through the runtime's restore callback.
- **Lifecycle operations:** reconcile with `rendezvous`, `youtubeOnly` and `preparePaused`.
- **Deadline owner:** each ladder; the scheduler serializes them, and a marked return retires the
  foreground ladder.
- **Timing-constant home:** `VISIBILITY_PLAYBACK_RECOVERY_RETRY_MS` (`runtime.ts`) and
  `PLAYBACK_RESTORE_DELAYS_MS` (`system-audio-service.ts`), both capped at 15 s, unchanged by
  C4-13.
- **Not deduplicated (residual, no record):** the opposite order. When the restore's own pass fails
  (for example its fresh clock sample after the page is shown) and the foreground repair queued
  behind it then applies, the restore's retry (250 ms) still arms the same revision again: the
  service decides when to restore and the restore does not read the mark. Pinned as today's
  behaviour by `runtime-system-audio-join.test.ts` "5B-C4-13 residual, expected today: …"; not
  heard on a device. Revisit if Phase 5 device step 5P-5 still reports a second stop after 5B.
- **Anchor tests:**
  - Supersession: `src/pro-room/__tests__/runtime-server-playback.test.ts` "joins an in-flight
    YouTube visibility pass instead of starting a second rendezvous".
  - User pause/stop: `system-audio-service.test.ts` "does not revive an old explicit stop after a
    newer share generation is observed".
  - Teardown: missing.
  - Visibility: `runtime-server-playback.test.ts` "does not re-apply a YouTube checkpoint the
    visibility pass already re-applied"; `system-audio-service.test.ts` "holds restoration retries
    while hidden and resumes them when shown, without a cap".
  - Cross-owner: `src/pro-room/__tests__/runtime-system-audio-join.test.ts` "F3, fixed in
    5B-C4-13: a share that ends while hidden, with a failed first restore, re-arms the YouTube
    renderer once when shown" (the C4-0 F3 baseline of #454, flipped) and "5B-C4-13: a post-share
    restore still running when the page is shown, which applies after the show, reconciles that
    return"; guards in the same file: a restore that applies while the page is hidden leaves the
    repair to the show, a restore that began before a hide and show does not reconcile the newer
    return, a later hide and show repairs again, and a file item, whose restore completes without
    applying, is still repaired by the background-return Sync.
- **Status:** `owner-in-place`. Exception RO-41 was deleted with C4-13 (Phase 5 train 5B).

### RO-22 Waiting service worker activation

- **Resource:** `registration.waiting`, its activation (`SKIP_WAITING`, then `controllerchange`)
  and the navigation that follows.
- **Current owners/flows:** the update machine in `src/sw-register.ts`. Since Phase 3 C6-9 it
  keeps one typed `activationState` (`passive`, `prompting`, `awaiting-local-controller`, or
  `reload-scheduled` holding a local identity token for the reload it asked the navigation owner
  for, since the owner returns no handle, so only that reload's own recovery releases it; the
  module reload latch `_swReloading` is gone) and sends `SKIP_WAITING` through one sink,
  `activateWaitingWorker` (Apply, Apply to a replacement, the quiet cooldown and same-generation
  promotions, and since C6-10 the logo port; Apply and the logo port write the next-document
  markers, and the quiet promotions write none). A prompt that still answers while that reload is
  pending (a lost lease, a failed dialog) leaves its phase inside the `reload-scheduled` state,
  which keeps the pre-C6-9 outcomes: a newly waiting worker is still taken up, and the page
  returns to that phase if the reload recovers. The recovery checks the reload's identity; with
  the navigation owner settling each attempt once (RO-23) a stale recovery cannot reach it today,
  so that check is defensive and pinned directly. Since Phase 3 C6-10 (owner decisions P3-8 A to
  P3-12 A, 2026-10-24):
  - The logo reset asks the machine through a port instead of promoting on its own. The lazy
    `src/core/sw-hard-reset.ts` (the logo's prepare step, `src/ui/player-controls.ts`) dispatches
    `HARD_RESET_CLAIM_EVENT` on the page's service-worker container and the machine answers
    synchronously: `promoted` (it applies the waiting update without asking, Later lasting for
    that page only, through its sink, records the request like an Apply and withdraws a prompt
    shown or queued), `apply-in-flight` (an Apply already sent `SKIP_WAITING`: the hard reset waits
    for that activation until the prepare window closes and sends nothing), `none` (no waiting
    worker, or the page's loads are not quiet: the logo goes home at once and the next page
    offers the update) or `unavailable` (no machine yet: before the window load event or after a
    failed registration, on a quiet page). The request carries whether the page's loads are
    quiet: the hard reset measures it with a copy of the machine's quiet window, leaving out its
    own chunk, whose load for the tap does not count as the page loading (found by the 2026-10-24
    real-browser check: without it the logo never promoted); the machine decides with that
    reading. The measurement moved into the lazy chunk in Phase 3 R2 to keep the eager bundle
    under the 5% reserve line; a request without the reading counts as a page still loading.
    The hard reset then waits for the new controller and
    leaves "Update applied" for the next document only when it saw one (P3-11 A). The port is an
    event rather than an import: a static import of `sw-register.ts` from the logo or the lazy
    chunk reorders the eager bundle (+0.7 KB gzip measured either way).
  - The hard reset's own promotion stays in `sw-hard-reset.ts` (`promoteWithoutTheUpdateMachine`,
    P3-12 A): permanently the only path without a machine, and TEMPORARILY also after the
    machine's own promotion timed out; that use goes in a later Phase 3 release after two clean
    production update cycles.
  - A controller change that arrives while a navigation holds the page (the logo's own
    activation, or any other navigation) is decided only if that navigation releases the page in
    this document: no update dialog under the reset screen and no second reload request; a room
    is asked once, a page outside a room makes its aligned reload, and an Apply in flight makes
    its reload then (P3-8 A). The machine reads `isSessionResetPending` and subscribes to
    `onNavigationPendingChange` of the navigation owner (RO-23) for this, and writes the
    controller-confirmed markers when it puts the decision off, as the aligned reload did when it
    queued.
  - The quiet promotions (cooldown, same generation) send once the page's loads are quiet, as the
    startup prompt does (P3-9 A).
  - A new document absorbs a late activation when the next-document markers still hold a request
    from an earlier document of this tab that it did not see land (Apply or the logo; no age
    limit) and the activated generation equals the build's `__MXQR_BUILD_CACHE_VERSION__`: no
    reload, no dialog, no toast, a prompt for it withdrawn (P3-10 A, reproduced first by the C6-9
    stalled-Apply case). A document running older code (a cache fallback) still reloads, and a
    document with no such request treats the activation as before.

  Since forced update Inc 5 (train 9.0.14):
  - A refusal below the App build floor (RO-50) is a requester. The PRO entry
    (`src/pro-room/setup-flow.ts`) and, from Inc 6, the Standard signaling transport ask through
    the forced-update port in `src/core/app-build.ts` (`requestForcedAppUpdate`,
    `isForcedAppUpdatePending`, `subscribeForcedAppUpdatePresentation`; the transport uses
    `requestForcedAppUpdateFor`, which keeps a true answer with the refusal's error, and setup's
    error handlers ask `isHandledByForcedAppUpdate` before any generic text); only
    `sw-register.ts` installs its handler, so no caller imports the machine. The latch (the
    highest floor learned, the first room code named, whether a refused session was in a room
    (a host with an open room, a guest whose room channel opened), and what is on screen:
    nothing, the forced dialog, or its update reload) lives in `registerServiceWorker` scope.
    The handler is installed before the support checks, so a page with no machine (no
    service-worker support, an insecure context, before the window load event, a failed
    registration) still shows the forced dialog without a worker and reloads on Apply; the machine
    takes over the steps that depend on it after registration and keeps the latch (with nothing
    waiting it then runs one update check).
  - The forced entry: a floor this build meets, or the loop guard, answers false, and the caller
    shows its ordinary error. Otherwise it latches and answers true; runs `reg.update()` once each
    time the latched floor rises (not while a worker installs or waits, an update reload is on its
    way, or another tab's newer worker already controls the page; the hourly check lease is
    neither claimed nor written); shows nothing while an update reload is on its way (a reload
    that recovers presents it again, and a tap is still needed); waits while a navigation holds
    the page (P3-8 A applied to it: presented once if the page is released in this document,
    never if the navigation commits; the answer is true while nothing is pending yet, so a
    refused caller hides its generic text by the answer it got, not by the pending query: the
    Standard refusal's error carries it to setup through `requestForcedAppUpdateFor`); and
    otherwise takes the screen. Taking the screen
    withdraws the machine's dialogs with Later, `openPrompt` and the activated-elsewhere offer's
    own slot `openActivatedOffer` (the logo and the P3-10 absorb still withdraw only
    `openPrompt`), tells the port's presentation subscribers (RO-51), and shows the update dialog
    without Later and with `closeOnBack: false`, so Back keeps it (the 8.11.9 Back rule does not
    apply). A refusal of an entry that was never admitted gets the apply message.
  - With a controller and a waiting worker the forced dialog runs inside `handleWaitingWorker`
    past the handled-worker and phase checks, the quiet promotions, Later, the startup wait and
    the prompt lease, and its Apply takes the existing Apply and replacement branches. The forced
    dialog without a worker hands a worker that installed while it was up to that same Apply
    branch at the tap, makes the aligned reload when another tab's newer worker already controls
    the page, and otherwise records the request, calls `reg.update()` and reloads before any
    controller change (navigation is network-first, so the reload loads the newest App). Apply
    returns to the latched room code's `/CODE` when a refusal named one, else by today's rule.
    Every ordinary offer returns silently after each of its waits once the forced entry latched,
    without touching the phase, the dismissed sets or the presentation-failure record. A dialog
    fallback clears what is on screen; the next request presents again. The activated-elsewhere
    offer opens nothing while the latch is set.
  - The loop guard is the next-document key `FORCED_UPDATE_APPLY_KEY` (`"<build>:<floor>"`,
    written on Apply before any activation or reload): a request is declined when the stored
    build equals this build and the stored floor is not lower, so a tab gets one forced Apply per
    build and floor; the stored floor never moves down. It guards the documents after a forced
    Apply, not the one that made it: once a document has put the forced dialog on screen, or has
    a latch under an update reload, a further request there answers true (its floor still
    latches), including during and after that document's own Apply.
  - A new document also promotes quietly, through `activateWhenQuiet`, a waiting worker of the
    generation it would absorb (P3-10 A extended from a late activation to a late install): the
    generation this tab asked for and already runs is not offered again after the 30 s cooldown.
    A document without its own request still asks.
  - The absorb's fallback within the cooldown: a document opened by a reload within 30 s of such
    a request, with no controller-confirmed marker and no waiting worker handled by itself,
    finishes the update with the aligned reload and no dialog when a generation it does not
    absorb takes control (another tab applied a newer release, say). Its writers today are an
    Apply whose page the user reloaded before the controller change and the forced Apply without
    a waiting worker, which reloads a Standard host in place; without the fallback that host,
    back in its room, would be asked once more with the activated-elsewhere dialog. Until
    old-version removal train 2 (A-6, wording only) the code described it as the v267 transition.

  Since forced update Inc 7 (train 9.0.14, owner decision 2026-10-25 ~22:00: check the minimum
  build at start and on every return from the background):
  - The start and resume floor check is a second requester inside the machine
    (`sw-register.ts`, armed in `registerServiceWorker` scope before the support checks, so a
    page with no machine checks too). It reads `APP_BUILD_FLOOR_CLIENT_PATH` (the App Worker's
    effective floor, RO-50) at the window load moment the machine already registers at (one
    `atLoadMoment` for both) and on `visibilitychange` to visible, `pageshow` with `persisted`
    and `online`; nothing else triggers it (no timer: the hourly `sw-update-check` is not a
    trigger, owner question Q-B default No). It skips a page with no build (`APP_BUILD` 0), a
    hidden or offline page, a latch already on screen or under an update reload, an update
    reload on its way (`reload-scheduled`, `awaiting-local-controller`) and a page a navigation
    holds (the next document checks at its start). Its gate
    (`createAppBuildFloorCheckGate` in `sw-update-coordination.ts`) allows at most two read
    starts and one in flight per `APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS` window; a read a server
    answered (any status or body) or that hit its deadline is spent and ends the window, one the
    page abandoned (the `visibilitychange` to hidden aborts the read in flight) or that got no
    response is released and lets the next trigger read once more in that window. Below the
    floor it calls the forced entry with `{ admitted: true, returnCode: null }` (today's message
    and return rules wherever the page is) at once on a return and, at start, after the startup
    prompt's quiet wait (P3-9 A); the entry owns the loop guard, the latch, `reg.update()`, the
    navigation wait and the dialog. It holds no dialog, prompt, phase, reload or timer state; a
    failed or offline read shows nothing and is never retried by itself.

  `guard:navigation-sinks` counts the one literal in the sink and the one in the hard reset's own
  promotion, the four calls of the sink (Apply and Apply to a replacement in `handleWaitingWorker`,
  the quiet promotions in `activateWhenQuiet`, the logo port in `claimForHardReset`), and keeps
  `_swReloading` and `_swReloadAttempt` retired. The cross-tab prompt lease stays in
  `src/sw-update-coordination.ts` and `src/sw-prompt-lock.ts`.

- **Target single owner:** the `sw-register.ts` update machine with one activation sink; the hard
  reset is a client of its port and keeps its own promotion only where there is no machine (and,
  until two clean production update cycles, after a machine timeout).
- **Allowed requesters:** the update dialog (Apply, Later), the logo hard reset through the port,
  other tabs through the prompt lease, and refusals below the App build floor through the
  forced-update port in `src/core/app-build.ts` (the PRO entry from forced update Inc 5, the
  Standard signaling transport from Inc 6), and the machine's own start and resume floor check
  (Inc 7).
- **Lifecycle operations:** `SKIP_WAITING`, `reg.update()` (also once each time the forced
  latch's floor rises), the reload, completion markers, the forced update's loop-guard key, and
  the start and resume check's floor read (started through its gate, aborted on hide).
- **Deadline owner:** the update machine (with the Chromium rule that `SKIP_WAITING` waits until
  page loads settle: the startup prompt, the quiet promotions and the logo port all follow it)
  and, for the logo reset, the navigation owner's prepare window. Since Phase 2 C6-8 the logo
  reset runs the chunk load and the activation wait as the navigation owner's prepare step,
  bounded by `NAVIGATION_PREPARE_TIMEOUT_MS` (2.5 s, which `navigation-contract.test.ts` keeps at
  least 1 s above the hard reset's 1.5 s `ACTIVATION_TIMEOUT_MS`), and navigates home after it
  either way; the 2 s commit timeout starts only at that navigation (owner decision 2,
  2026-10-23). Since C6-10 the prepare signal reaches the port's wait and the hard reset's own
  promotion: after it aborts nothing is promoted or awaited, and an Apply in flight is waited for
  until it aborts. The start and resume floor read has one deadline,
  `APP_BUILD_FLOOR_READ_TIMEOUT_MS`, and no retry: a failed read waits for the next trigger (in
  the next window when it was spent).
- **Timing-constant home:** `src/core/navigation-contract.ts` (the next-document markers
  `SW_UPDATE_KEY`, `SW_CONTROLLER_CONFIRMED_KEY`, `UPDATE_COMPLETION_KEY` and, since forced
  update Inc 5, `FORCED_UPDATE_APPLY_KEY`; the lazy
  `sw-update-completion.ts` keeps a copy of the last, pinned by
  `src/core/__tests__/sw-update-completion.test.ts`), `sw-update-coordination.ts`
  (`UPDATE_CHECK_INTERVAL_MS` and the page-side message types, pinned against the worker's copies
  by `src/core/__tests__/sw-message-contract.test.ts`; since forced update Inc 7 also the start
  and resume check's `APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS` and
  `APP_BUILD_FLOOR_READ_TIMEOUT_MS`, which `sw-register.ts` passes to the gate and the read), `sw-hard-reset.ts`
  (`ACTIVATION_TIMEOUT_MS`, lazy) and `sw-register.ts` (prompt and quiet-load timings, and
  `HARD_RESET_CLAIM_EVENT`; the lazy `sw-hard-reset.ts` keeps a copy, and `sw-register.test.ts`
  and `sw-hard-reset.test.ts` pin both to `src/core/__tests__/__helpers__/hard-reset-port.ts`).
  Since Phase 3 R2 the lazy `sw-hard-reset.ts` also keeps a copy of `STARTUP_PROMPT_QUIET_MS`
  for the claim's quiet reading: `sw-hard-reset.test.ts` "keeps the update machine's quiet
  window" pins both sources to the same helper, its quiet-reading rows pin the copy's behaviour,
  and `scripts/check-resource-ownership.mts` lists the pair as a triaged copy.
  Named in Phase 2 (C6-1).
- **Anchor tests:**
  - Supersession: `src/core/__tests__/sw-register.test.ts` "drops a stale waiting-worker
    continuation when a newer install replaces it".
  - User pause/stop: `sw-register.test.ts` "does not re-prompt a generation put off with Later in
    the same page".
  - Teardown: `src/core/__tests__/sw-hard-reset.test.ts` "fails open after a bounded wait when
    activation stalls", and its prepare-abort cases.
  - Visibility: `src/core/__tests__/sw-update-transitions.integration.test.ts` rows X3b (the
    document is made visible again after the update reload's pagehide) and X5 (a back-forward
    cache return of a pending update reload).
  - Every `SKIP_WAITING` send and the listed exits from `reload-scheduled`, with the navigations,
    dialogs and next-document markers each produces: the transition table in
    `sw-update-transitions.integration.test.ts` (on the real navigation owner). A fallback
    reload held behind the PRO claim fence and a throwing `/CODE` href sink have no row; they
    reach the machine through the same owner queue and recovery callback as rows X10a/X10b and
    X2 (by reading). The machine's
    state is private, so a row checks its resulting state only through a later step: rows X12b
    to X19 send the next event while the reload is still latched, X20 to X22 answer a prompt
    after the reload recovered under it, and S1b and S2b end with a probe. C6-9 kept every row's
    effects of main 08003954's `sw-register.ts`; a mutation check of C6-9's state (21 mutants,
    20 killed) left only the startup gate's read, which no reachable order can tell apart. Each
    row is labelled with what C6-9 and C6-10 kept or flipped; the C6-10 rows S5a to S5j cover
    the logo port (promotion, an Apply in flight, a prompt withdrawn, a page still loading, no
    machine, a navigation that does not commit) and S1c, X12 to X13b and X22 the quiet
    promotions. The R2 review added S5k (a quiet promotion leaves a worker the logo claimed
    alone), the scope of the P3-10 absorb (a document already on the new code with no request
    of its own still reloads or asks) and the absorbing document's cache-status reply.
  - The port's answers: `sw-register.test.ts` "the logo hard reset port (C6-10)"; the hard
    reset's side: `sw-hard-reset.test.ts`.
  - The reload identity check: `sw-register.test.ts` "does not let a stale recovery release a
    successor reload attempt" hands the machine a stale recovery directly.
  - A hard reset while an Apply is stalled: the transition test file's "a stalled Apply, then the
    logo reset" cases, recorded by C6-9 (three `SKIP_WAITING` sends and a second navigation) and
    flipped by C6-10 (one send, the late activation absorbed by a document that runs that
    generation's code; a cache-fallback document still reloads). Forced update Inc 5 flipped its
    "after the cooldown" case: the new document promotes the waiting worker quietly instead of
    asking again (the late-install rule).
  - The forced entry (forced update Inc 5): the transition test file's "forced update on the real
    navigation owner (train 9.0.14)" rows F1 to F27 (with F5b, F24, F24b and F24c): supersession
    (F4 and F4b, an ordinary prompt or offer mid-await yields; F24, the activated offer
    withdrawn; F21, a worker installed under the dialog without one), user pause/stop (F12, a
    generation put off with Later is forced anyway; F18, a fallback), teardown (F22 and F22b, a
    navigation holding the page; F8 and F17, an update reload in flight and its recovery; F8c
    and F17b, this document's own forced Apply in flight and recovered) and the loop guard (F5,
    F5b); `sw-register.test.ts` "the forced update without an update
    machine (train 9.0.14)" (F9); `src/core/__tests__/app-build.test.ts` (the build and the
    port); the PRO entry rows of `src/pro-room/__tests__/setup-flow.test.ts`, and in a real
    browser (local, not in CI) `e2e/pro-entry-app-update.test.ts` (a refused PRO invite and claim
    link: no Later, Escape and Back keep it, one Apply, then the loop guard).
  - The absorb's fallback within the cooldown: `sw-register.test.ts` "finishes an update reload
    that left before its controller change without asking again" and "does not treat a
    controller-confirmed reload as an unfinished update reload"; the transition test file's F2d
    (a host reloaded in place by a forced Apply without a worker gets the aligned reload, not the
    dialog, for another generation; added by old-version removal train 2 A-6, failing when the
    branch is disabled).
  - The start and resume floor check (forced update Inc 7): the read and the gate in
    `src/core/__tests__/sw-update-coordination.test.ts` (rows R1 to R5, G1 to G3);
    `sw-register.test.ts` "the start and resume floor check (forced update Inc 7)" (rows C1 to
    C18); the transition test file's "the start and resume floor check against the navigation
    owner (Inc 7)" and the RO-51 rows I5 to I7. Supersession: C8 and C17 (an ordinary prompt or
    the activated-elsewhere offer withdrawn), C9 and I3 (a forced dialog already open, an update
    reload on its way: a return reads nothing, a read that lands after it does nothing), C14 (a
    refusal during the start wait: one dialog). User pause/stop: C10 (the loop guard keeps a
    read silent). Teardown: I1 (a back-forward cache return in a room, visible first: one read
    starts before RO-23's bounded reload and its result waits under it), I2 and I4 (a read that
    lands while a navigation holds the page waits for it: nothing if it commits, the forced
    dialog once if it releases the page). Visibility: C2, C3, C4, C15 and C16 (hidden pages do
    not read, a return reads once per window, a hide abandons the read in flight). C18 pins the
    test default: a loaded, visible document with a build reads once at load and gets 0 (both
    harnesses install that answer, because the unit network guard rejects any other fetch). In
    the production candidate browser suite (CI), `e2e/forced-update-resume.test.ts`: a return
    reads once per window and shows the forced dialog below the floor (Escape and Back keep it),
    and a forced Apply on a controlled page reloads once into a guarded document.
- **Status:** `duplicated` until the temporary timeout fallback goes. Phase 0d, Phase 3 (one
  activation owner, done in C6-9; the hard reset asks it, done in C6-10; the timeout fallback is
  removed in a later Phase 3 release after two clean production update cycles, which leaves the
  no-machine promotion as a recorded exception). See
  [Update dialog everywhere](update-dialog-everywhere-2026-10-17.md). Exception RO-43.

### RO-23 App-owned page navigation

- **Resource:** the page's own `location.reload`, `location.replace` and `location.href` writes.
- **Current owners/flows:** the session reset in `src/core/session-reset.ts` (first request wins,
  overlay, 2 s commit timeout; since Phase 2 C6-4 one `PageNavigationState` whose every exit goes
  through one exactly-once `settle()` with a typed outcome, `onSettled`, with `onRecovered` as its
  alias; since C6-5 also the one reload queue behind `scheduleDocumentReload`; since C6-6 the one
  page-transition dispatch, `initPageNavigation`, whose capture-phase pagehide, pageshow and
  visibility listeners run before the Back guard's resume whatever the init order, and which owns
  the single bounded reload of a document the back-forward cache returns, after calling
  `revealLiveShell` from `src/core/page-lifecycle.ts`; since C6-7 an unload-exemption claim held
  from the action's start until settle, from `claimUnloadExemption` in `page-lifecycle.ts`, which
  replaced the shared intentional-navigation flag: each writer, the owner and the same-tab Google
  login in `src/ui/account.ts` with its 10-minute bound, releases only its own claim, so a
  recovered reset no longer ends a pending login's exemption and a reload waiting behind the PRO
  claim fence no longer suppresses the leave prompt, owner decision 3, 2026-10-23). Its busy rule (owner decision 1, 2026-10-23): a reload asked
  for while another navigation holds the page, behind another reload, or behind a reload whose
  sink throws waits and runs if that navigation settles in this document, never after it
  commits; a waiting reload with the same message joins the one already waiting; a direct reset
  asked for while the page is held is refused (first wins); a back-forward cache return that makes
  its own bounded reload decides so before it settles anything, drops every reload still waiting,
  answers each dropped caller's `onRecovered` once (in a finally, the drop log and each callback
  isolated) once that reload holds the page or waits first in the queue behind a deferred PRO
  claim fence (a reload the visible return already started, or one a settled callback asks
  for, is not dropped and can run ahead of it; the page still reloads once when the first
  commits), and leaves the page's one reload to that bounded reload (owner decision 13,
  2026-10-23); a return that reloads nothing (outside a room with nothing pending, or a second
  return of the same document) drops nothing and settles only the attempt it returned with
  (`left`), so a reload waiting there, or one the visible return already started from the queue,
  runs once on every event order. `src/core/document-reload.ts` keeps
  only the PRO claim fence (claim phases, the claim the in-flight reload carries, a narrow port
  `isReloadFenced` / `beginFencedReload` / `setReloadFenceOpenHandler`; since C6-13 tests reset
  the owner and the fence with one `__resetPageNavigationForTests`). The update machine in
  `sw-register.ts` keeps its reload inside its own activation state since Phase 3 C6-9 (RO-22;
  the stacked `_swReloading` latch is gone) and, since C6-10, reads `isSessionResetPending` and
  subscribes to `onNavigationPendingChange` to put a controller change's decision off while a
  navigation holds the page (a reader, not a requester); `src/core/reload-recovery-latch.ts` keeps
  only its prompt single-flight, its repeated-recovery guard deleted in C6-13 because the owner
  reports a recovery at most once per attempt;
  `src/core/page-lifecycle.ts` keeps only `beforeunload`, the pagehide `leaveSession` and
  `revealLiveShell`. The navigation intents in
  `src/core/navigation.ts` (Phase 2, C6-3) run on the reset: `navigateHome` (replace, or push for
  the setup-guest Back buttons) serves `src/pro-room/setup-flow.ts`, `src/ui/connect.ts` and
  `src/ui/setup-guest.ts`; `returnToRoomStart` (the /CODE return, which checks the room code once
  at its sink and optionally writes the reconnect marker) serves `sw-register.ts`,
  `src/ui/setup.ts`, `src/ui/connect.ts` and the lost-session dialog's Restart for a guest in
  `src/network/peer.ts` (2026-10-28), whose Restart for anyone else and Go back are its two
  `scheduleDocumentReload` requests. Connect requests a fresh admission only after
  the user chooses to rejoin an expired Standard room; observing expiry never navigates.
  `scheduleSessionReset` is still called directly from `app.ts` (the confirmed Back leave),
  `src/ui/player-controls.ts` (the logo reset) and `src/pro-room/runtime.ts` (terminal PRO
  recovery). Since C6-8 a request is a plain action or `{ prepare?(signal), navigate, isCurrent? }`:
  the owner runs the optional prepare step after the paint, bounded by
  `NAVIGATION_PREPARE_TIMEOUT_MS`, then the final navigation call, and starts the 2 s commit
  timeout only there (owner decision 2); the prepare signal aborts when that window closes or the
  attempt settles, and `isCurrent()` false at navigate settles the attempt as recovered. The logo
  reset's update hand-off is its prepare step; `runtime.ts` passes `isCurrent` instead of
  restoring the reset inside its action, and its last raw `location.replace` became
  `navigateToAppHome`. `restoreSessionReset` is no longer exported.
- **Target single owner:** one navigation owner in `src/core/session-reset.ts` with one state
  type, one queue and exactly-once settlement; `document-reload.ts` keeps only the PRO claim fence.
- **Allowed requesters:** the callers above, through the owner. `app.ts` wires the owner's
  back-forward cache recovery once (`initPageNavigation`: the role, the reload message, the log).
- **Lifecycle operations:** schedule a reset or reload, navigate, recover, restore.
- **Deadline owner:** `session-reset.ts`: `NAVIGATION_PREPARE_TIMEOUT_MS` (2.5 s) for a prepare
  step, then `NAVIGATION_COMMIT_TIMEOUT_MS` (2 s) from the final navigation call.
- **Timing-constant home:** `src/core/navigation-contract.ts` (`NAVIGATION_COMMIT_TIMEOUT_MS`,
  `NAVIGATION_PREPARE_TIMEOUT_MS`, `RESET_PAINT_FALLBACK_MS` and the next-document
  `sessionStorage` keys), a dependency-free module
  because `src/core/navigation.ts` imports the owner. The ordering it relies on is pinned in
  `src/core/__tests__/navigation-contract.test.ts` (Phase 2, C6-1).
- **Anchor tests:**
  - Supersession: `src/core/__tests__/session-reset.test.ts` "uses a native timeout fallback and
    accepts only the first reset request"; `src/core/__tests__/document-reload.test.ts` "does not
    let a stale guard release its successor".
  - User pause/stop: n/a.
  - Teardown: `session-reset.test.ts` "recovers a no-op navigation and accepts a later reset
    request".
  - Visibility: `session-reset.test.ts` "cancels a pre-action reset when the returned page only
    becomes visible"; "restores a committed reset when iOS only foregrounds the old document".
  - Busy rule: `src/core/__tests__/page-navigation-owner.integration.test.ts` "(a) ... waits
    behind the reset and runs once that reset recovers", "releases the failed reload and runs the
    reload queued behind it" and "lets a waiting request join one with the same message"; at a
    back-forward cache return, "(c) ... drops a reload still queued behind a committed reset" and
    "drops every reload still queued at a pageshow-first return", and where the return reloads
    nothing, "a pageshow-first return outside a room with a reload held by a deferred PRO claim
    fence", "runs a reload queued behind the bounded reload once on a second ... return" and
    "runs a reload queued behind the bounded reload once on a second visible-first return".
  - Unload-exemption claims: `page-navigation-owner.integration.test.ts` "(e) ... keeps an
    exemption another writer holds when an unrelated reset recovers" and "(d) ... asks to confirm
    an unload while the reload waits behind the fence"; `src/ui/__tests__/account.test.ts` "keeps
    a slow same-tab OAuth navigation recoverable beyond two seconds".
  - Prepare/navigate split: `session-reset.test.ts` "prepare/navigate requests (C6-8)" and
    `page-navigation-owner.integration.test.ts` "(f) ... navigates home at the prepare deadline
    when the chunk lands later, which then posts no SKIP_WAITING".
  - One page-transition dispatch: `page-navigation-owner.integration.test.ts` "with the
    guard-first init order, re-arms the Back guard in a room only on the second pageshow-only
    return" and `src/core/__tests__/page-lifecycle.test.ts` "page navigation owner — back-forward
    cache return (initPageNavigation)".
  - Sinks and requesters: `src/core/__tests__/navigation-sinks-guard.test.ts` (C6-14).
- **Status:** `duplicated`. Phase 0d (names), Phase 2 (unload-exemption claims, C6-7; the
  navigation owner and Back fallback in a train of its own; page transitions in one dispatch,
  C6-6). Since C6-14 `npm run guard:navigation-sinks` (`scripts/check-navigation-sinks.mts`, in
  CI) pins every `location` sink, `SKIP_WAITING` send and history traversal to its function, lists
  the requesters of `scheduleSessionReset` / `scheduleDocumentReload` and the
  `claimUnloadExemption` callers per file, allow-lists the locale navigation in
  `src/i18n/localized-app-document.ts` with its reason (owner decision 7, 2026-10-23), and keeps
  the retired names gone; `app.ts`'s Back home port moved to `navigateToAppHome`. The second
  machine left is the `sw-register.ts` reload latch (Phase 3). See
  [Page navigation ownership](page-navigation-ownership.md).

### RO-24 `inert` page lock

- **Resource:** `inert` (and the paired `aria-hidden`) on the body's direct children, and which
  surface is on top.
- **Current owners/flows:** since 9.0.1 one ledger, `setElementInertForOwner` in
  `src/core/inert-ownership.ts`, used by the modal stack (`src/ui/dom.ts`), mobile chat
  (`src/ui/chat.ts`) and the session reset (inert only). The modal stack no longer locks the reset
  overlay, so the reset surface stays on top of every window and a dialog that opens while a
  navigation is pending sits underneath, inert, with focus left on the surface (owner decision 4,
  2026-10-23, pinned in Phase 2 C6-11). Since C6-11 the reset also stays above a fullscreen
  player: while `fullscreenSurfaceHost()` in `src/ui/dom.ts` (the element in the browser's
  fullscreen top layer, the same container the modal portal uses) exists, the reset moves its
  overlay inside it and claims inert on every element beside the overlay's path instead of on the
  body children, follows fullscreen changes through `onFullscreenSurfaceHostChange`, and moves the
  overlay back when it settles; it never requests or exits fullscreen. The app shell wires both
  through `setSessionResetWindowLayer`. Element-local writers (`src/player/video.ts`, `src/ui/playlist-removal.ts`,
  `src/ui/setup-shared.ts` and others) lock their own subtrees and are out of scope.
- **Target single owner:** unchanged.
- **Allowed requesters:** surfaces that cover the page, each with its own owner key.
- **Lifecycle operations:** claim, release.
- **Deadline owner:** none; the reset's release handler re-derives the modal stack.
- **Timing-constant home:** n/a.
- **Anchor tests:**
  - Supersession: `src/core/__tests__/inert-ownership.test.ts` "holds inert until the last owner
    releases and restores the saved state".
  - User pause/stop: n/a.
  - Teardown: `session-reset.test.ts` "leaves the shell interactive after a dialog opened during an
    abandoned reset closes".
  - Visibility: `session-reset.test.ts` "restores a committed reset when Safari returns the old
    document via pageshow".
  - Top surface: `src/core/__tests__/page-navigation-owner.integration.test.ts` "(g) ... keeps the
    reset surface exposed and focused" and "keeps the reset surface on top of a fullscreen player,
    with the window underneath and inert".
- **Status:** `owner-in-place`. See [Competing recovery flows, 9.0.1](ownership-gap-fixes-2026-10-22.md).

### RO-25 Developer API authority fence row

- **Resource:** one `mxqr_developer_api_room_authority_fences` row per room incarnation.
- **Current owners/flows:** `revokeDeveloperApiKeysForAuthorityChange` in
  `cloudflare/app-worker.ts` is the one activator. Each caller passes a typed `AuthorityFenceWrite`
  (Phase 1, C7-11) whose `source` fixes the fence reason and the key-revocation audit identity: the
  transfer request and the transfer cron (RO-09) and the legacy duplicate-owner detach write
  `ownership_transfer_pending` with `expected: 'any'` (no compare-and-swap), and the
  account-deletion purge (`purgeProRoomAccountAuthority`) writes `owner_account_deleted` with a
  compare-and-swap on the digest it captured (or `null` for no row). The emitted SQL and bindings
  did not change (`?6 = 0` for `'any'`). `clearDeveloperApiAuthorityFence` clears by digest for
  the transfer only. The PRO room Durable Object decommission (`deleteDeveloperRoomData` in
  `cloudflare/pro-room-worker.ts`) deletes the row with the incarnation's keys and audit rows. The
  PRO room's `projectionAcked` gate arbitrates between deletion and transfer.
- **Target single owner:** the two fence functions with the typed fence-write policy, which is in
  place; the resource-ownership guard (CHECK 7) allows writes only in them and the decommission
  delete. Whether transfers also compare-and-swap is an open owner decision (D5 of the server-owner
  design); transfers keep writing without one until it is made.
- **Allowed requesters:** the transfer saga, legacy detach, the deletion purge, the decommission
  job.
- **Lifecycle operations:** activate, clear, delete.
- **Deadline owner:** the deletion job's minute-cron retry; none for the transfer writes.
- **Timing-constant home:** n/a. The fence-digest pattern is `FENCE_DIGEST_RE`
  (`/^[A-Za-z0-9_-]{43}$/`) in `app-worker.ts`, used by the account-deletion purge
  (`purgeProRoomAccountAuthority`), `revokeDeveloperApiKeysForAuthorityChange`,
  `clearDeveloperApiAuthorityFence` and the saga row parse (`normalizeOwnerTransferSagaRow`)
  (Phase 0d, C7-2). The D1 CHECK constraints spell the same shape in SQL;
  `owner-transfer-saga-states.test.ts` checks that every tracked SQL definition spells the same
  CHECK and that the pattern accepts exactly the digests the fence and saga rows store.
- **Anchor tests:**
  - Supersession: `app-worker-cors.test.ts` "acks each exact owner-removal projection and never
    replays a stale deletion over a new owner".
  - User pause/stop: n/a.
  - Teardown: missing (the decommission delete).
  - Visibility: n/a.
  - Legacy detach path: `app-worker-cors.test.ts` "detaches only the exact duplicate legacy owner
    and safely reconciles a signaling failure".
  - Every writer: `src/core/__tests__/developer-api-authority-fence-sqlite.test.ts` "Developer API
    authority fence writers (RO-25)" pins the SQL text and every bound value of each writer through
    its real caller (the purge with a compare-and-swap on `null` or the captured digest, the
    transfer request, the cron adoption and the legacy detach without one, and the transfer's
    clear). `owner-transfer-saga-convergence-sqlite.test.ts` "fence-write policy by caller" pins
    what the policies do when they meet.
- **Status:** `owner-in-place`. Phase 0d named the digest pattern once (C7-2). Phase 1 C7-11 typed
  the fence writes (`AuthorityFenceWrite`) and made the writer list exact in the resource-ownership
  guard (CHECK 7, seeded in `resource-ownership-guard.test.ts`), with no behaviour change; the
  "every writer" pins above passed before and after it
  ([report](app-worker-saga-fence-2026-10-23.md)). New work writes the fence only through the
  activator or the clearer. The compare-and-swap policy of transfer writes is the open owner
  decision above, not a second machine. See
  [Account authentication operations](../account-auth-operations.md) for every writer and the
  precedence (deletion suspends, a transfer reactivates).

### RO-26 Top-document fullscreen state

- **Resource:** `document.fullscreenElement` (and prefixed variants), with its request and exit.
- **Current owners/flows:** `exitFullscreenFor` in `src/core/fullscreen.ts` (moved from `src/ui/`
  in Phase 2, C8-I2) is the one bounded exit (C8-I8): it owns the change, error and pagehide
  listeners, promise and void-return handling, the native 1.5 s bound, observer isolation and
  error matching (only an error of the exit method's own type at the document or the exiting
  element settles it). It holds the one exit in flight for the document (C8-I9): an exit by
  either owner for the element already being exited joins it instead of issuing a second native
  exit, and an exit for another element settles the earlier attempt first. Only this module
  calls a native exit method (guard: "fullscreen exit"), and both owners leave through the door
  they entered: the standard exit while the standard element is set, otherwise the prefixed
  exit first (owner decision O3, 2026-10-23, C8-I13; the YouTube exit used to try the standard
  exit first). Its callers: the screensaver entry (`src/ui/screensaver-entry.ts`: entry lock,
  request generation and bound) and the YouTube exit (`src/player/video.ts`: ownership
  heuristic, fake-fullscreen teardown). Two request chains stay with their callers: the
  screensaver's (standard, then WebKit) and the YouTube toggle's in `src/ui/player-controls.ts`
  (standard then fake fullscreen, or WebKit with a 100 ms check then fake). While a
  screensaver-owned exit is in flight the toggle is `aria-disabled` (dimmed) and ignores taps,
  and it comes back when the exit settles, at most 1.5 s later (owner decision O2, C8-I13,
  through `getFullscreenExitOwner` and `onFullscreenExitChange`). `getFullscreenElement` is the
  one prefixed-element reader for all of them (C8-I5).
- **Target single owner:** `src/core/fullscreen.ts`: done for exits. Whether the two request
  chains should become one is a separate owner decision; until then callers keep their request
  policy.
- **Allowed requesters:** the screensaver, the YouTube toggle and mode exit, Back.
- **Lifecycle operations:** request, exit, settle.
- **Deadline owner:** `exitFullscreenFor` for every exit and the screensaver entry for its
  request, each a 1.5 s settlement, always on a native timer: leaving a room
  clears every managed timer (`leaveSession` in `src/network/peer.ts`), which stranded a silent
  WebKit screensaver request until Phase 2 (C8-I6, `screensaver.test.ts` "bounds a silent WebKit
  request on a native timer that leaving a room cannot clear").
- **Timing-constant home:** `FULLSCREEN_SETTLEMENT_MS` in `src/core/fullscreen.ts` (Phase 2,
  C8-I2), with the change and error event names and the WebKit document and target types;
  `src/core/__tests__/fullscreen.test.ts` pins both exit bounds to it.
- **Anchor tests:**
  - Supersession: `src/player/__tests__/video.test.ts` "does not exit an unrelated fullscreen
    element when YouTube mode ends".
  - User pause/stop: `src/ui/__tests__/screensaver.test.ts` "requests fullscreen immediately and
    exits only the state it acquired".
  - Teardown: `video.test.ts` "exits native fullscreen before parking the YouTube wrapper".
  - Visibility: `src/ui/__tests__/screensaver-entry-back.test.ts` "releases the pending surface on
    pagehide and ignores late completion".
  - Both callers: `src/core/__tests__/fullscreen.test.ts` "bounded fullscreen exit" runs the
    promise, change event, legacy WebKit event, pagehide, failed exit and error-matching cases for
    the screensaver and the YouTube player alike, and "one in-flight fullscreen exit shared by
    both owners" pins the join, including across a hidden page.
  - Hand-off: `src/ui/__tests__/fullscreen-handoff.test.ts` (the screensaver closes on a YouTube
    takeover before `fullscreenchange`): "is unavailable until the screensaver exit settles, then
    enters again", "comes back at the 1.5 s bound when the screensaver exit never reports" and "a
    YouTube mode exit during the screensaver exit joins it".
  - Exit rule: `fullscreen.test.ts` "the YouTube player exits through the same door".
- **Status:** `duplicated` for the request chains only (owner decision). Phase 2 finished the
  exit side: shared helper and constants (C8-I2), one prefixed reader (C8-I5), one bounded exit
  (C8-I8), one in-flight exit slot (C8-I9, which retired exception RO-38) and one exit rule with
  the toggle unavailable during a screensaver exit (C8-I13). See
  [Screensaver integration](screensaver-integration-2026-10-16.md).

### RO-27 Playlist rows and scroll position

- **Resource:** the `#playlist-ui` row DOM and the `.tab-body` scroll position.
- **Current owners/flows:** reorder (`src/ui/playlist-reorder.ts`: drag, keyboard, settling, FLIP,
  edge auto-scroll); removal (`src/ui/playlist-removal.ts` with
  `src/ui/playlist-selection-morph.ts`: selection, exit layer, glide); the selection-gesture
  auto-scroll (`src/ui/playlist-selection-gestures.ts`); follow and current-jump; the custom
  scrollbar drag; the render's scroll restore. The three lazy controllers share
  `src/ui/playlist-motion.ts` (lazy; listed with the build's deferred modules) for the edge
  auto-scroll, the row easing and the reduced-motion check. `src/ui/playlist-view.ts` holds the
  interaction gate: `playlistInteraction()` derives one state from both controllers (the reorder
  is idle, in a gesture or settling a drop, and separately the selection is on or off, because an
  edit-mode long press drags while the selection stays), `interactionPolicy()` answers render
  deferral, follow blocking, handle use and what a long press does, and
  `cancelQueueInteractions()` ends both.
- **Target single owner:** one interaction gate in `playlist-view.ts` with the shared lazy motion
  module `src/ui/playlist-motion.ts`; controllers keep their gesture-private state.
- **Allowed requesters:** the controllers above, through the gate; room, authority, session and
  playback-mode events cancel through `cancelQueueInteractions()` (since owner decision O5,
  2026-10-23, a switch to system audio ends a drag or drop settle as well as the selection).
  Single-controller exits stay with their controller: a tab change ends the selection, starting a
  selection ends a reorder hold, the move dialog ends the selection.
- **Lifecycle operations:** move rows, animate, scroll, defer or force a render, cancel.
- **Deadline owner:** each controller's settle and glide timing.
- **Timing-constant home:** `src/ui/playlist-motion.ts`: the edge auto-scroll zone, arming and
  speed (`edgeAutoScrollVelocity`), the move tolerance `PLAYLIST_MOVE_TOLERANCE_PX`, the row
  easing `PLAYLIST_ROW_EASING` (reorder FLIP and the deletion survivors' glide) and
  `prefersReducedMotion`. Triaged as separate contracts and named apart: the click suppression
  after a drop or hold (`CLICK_SUPPRESSION_MS`, 500 ms, `playlist-reorder.ts`) and after a range
  drag (`RANGE_DRAG_CLICK_SUPPRESSION_MS`, 400 ms, `playlist-selection-gestures.ts`); the survivors'
  glide (`GLIDE_MS`, 300 ms, `playlist-removal.ts`) and the selection pills' morph (`MORPH_MS`,
  320 ms, `playlist-selection-morph.ts`); the header crossfade's curve stays in
  `playlist-removal.ts`.
- **Anchor tests:**
  - Shared motion: `src/ui/__tests__/playlist-motion.test.ts` "takes the same steps toward each
    edge of the pane visible above the bottom nav" (reorder drag and check-column drag).
  - Supersession: `src/ui/__tests__/playlist-view.test.ts` "keeps an active PRO reorder mounted
    through revision-only context pulses" and "defers renders while an edit-mode drag runs
    instead of dropping it".
  - User pause/stop: `src/ui/__tests__/playlist-reorder.test.ts` "cancels an active drag on Escape
    without changing order".
  - Teardown: `playlist-view.test.ts` "cancels a PRO deletion task on authority loss or
    room-incarnation replacement" and "cancels the drag and the selection together on ...".
  - Visibility: `playlist-reorder.test.ts` "preserves focus after hidden retires keyboard
    reorder" and `playlist-removal.test.ts` "does not resume playlist follow when the view hides
    before the release microtask".
  - System audio (O5): `playlist-view.test.ts` "cancels the drag and the selection together on a
    switch to system audio" and "cancels a handle drag outside edit mode on a switch to system
    audio".
  - Gate decisions: `playlist-view.test.ts` "stays blocked while tracks are picked and resumes its
    pending request once after" and "stays blocked through a reorder and its drop settle and
    resumes once after" (follow), "cancels a handle drag outside edit mode when the playlist
    changes under it" and "cancels an edit-mode long-press drag when the playlist changes under
    it" (a drag cannot trust changed rows; a settle keeps them), "keeps the number column for
    picking in edit mode: its handle starts no drag" and "picks a row from a title tap in edit mode
    instead of playing it".
  - Delete during a drop settle (owner decision O4, 2026-10-23: the settle finishes at once, then
    the deletion renders): `playlist-view.test.ts` "finishes a drop settle at once when Delete is
    tapped during it" for the Standard host, a Standard guest with ADMIN and a PRO media manager,
    and `e2e/playlist-edit-mode.test.ts` "Delete tapped while a dropped row settles deletes at
    once" (local only). The removal controller asks first through `onBeforeDelete`; a drag still
    in its gesture is left alone ("leaves a running drag alone when Delete is tapped and renders
    the deletion after its drop").
- **Status:** `owner-in-place`. Phase 2 moved the shared motion into `playlist-motion.ts` (C8-I3),
  gave the view one interaction gate (C8-I7) and applied owner decisions O4 (C8-I11) and O5, with
  the tests above. Known residual: a Standard guest with ADMIN who taps Delete before the host has
  answered its reorder request sees the order from before the drop until the host's snapshot
  arrives; before O4 the same happened only when the host answered after the ~474 ms settle.

### RO-28 Account session reads and refresh pulses

- **Resource:** the account session snapshot read from the cookie into `state.ts`, and the
  cross-tab refresh pulses (BroadcastChannel `mxqr-account-v1`, storage key
  `mxqr-account-refresh`).
- **Current owners/flows:** `src/account/session.ts` (generations, in-flight reads, recovery,
  login-result promises; sole snapshot writer; since C8-I10 the tab's single pulse receiver for
  window messages, storage events and BroadcastChannel, on one channel that also sends its
  mutation pulses, reading them through the one parser in `src/account/account-sync-protocol.ts`,
  C8-I4). `src/ui/account.ts` is a requester: its popup attempt and 250 ms close monitor ask the
  owner to read or reconcile, and it subscribes to login results (`subscribeAccountAuthResults`),
  which the receiver hands over before it reconciles. The UI filters them by its `accountClient`
  and keeps a once-per-result set that guards only its own toasts and popup settling. Other
  documents carry their own copies, pinned by the contract tests (owner decision O6): the producer
  in `browser/classic-runtime/account-complete.ts` and the third receiver in
  `browser/classic-runtime/events/event.ts`, which reads its campaign session once per pulse copy
  (no nonce dedupe; a known gap the tests pin). A shared promise per login nonce and a generation
  fence make the reads converge. Every pulse has carried an id since 8.3.30, so since the
  old-version removal train (survey OV-B08) all three receivers ignore a message without an id of
  8 to 160 characters, including the opaque token and the key removal of older tabs.
- **Target single owner:** reached in Phase 2: `src/account/session.ts` is the single pulse
  receiver (C8-I10) with the wire-contract module `src/account/account-sync-protocol.ts` (C8-I1)
  pinned against the classic runtimes by a contract test.
- **Allowed requesters:** the account UI (login-result subscription, popup attempt) and the popup
  monitor; focus, visibility and online triggers inside the owner.
- **Lifecycle operations:** read, refresh, reconcile a login, sign out, delete.
- **Deadline owner:** the session owner's recovery tail; the popup monitors.
- **Timing-constant home:** the wire contract `src/account/account-sync-protocol.ts`
  (`ACCOUNT_SYNC_CHANNEL`, `ACCOUNT_SYNC_STORAGE_KEY`, the 8 to 160 character pulse token bounds and
  the mutation pulse) for the app (Phase 2, C8-I1). The completion page and the events page cannot
  import it and keep their own literals (owner decision O6, 2026-10-23), pinned by
  `src/account/__tests__/account-pulse-contract.test.ts` (the events page's copy of the id bounds
  by its BroadcastChannel acceptance rows, since OV-B08). `ACCOUNT_LOGIN_POPUP_POLL_MS`
  (`account.ts`) and a 250 ms copy in `event.ts` are separate popup monitors in separate documents.
- **Anchor tests:**
  - Supersession: `src/account/__tests__/session.test.ts` "reconciles the exact popup session and
    fences an older account read".
  - User pause/stop: `session.test.ts` "does not let later external refresh pulses starve an
    explicit Retry".
  - Teardown: `session.test.ts` "keeps the aggregate-write fence outside the public account
    profile and clears it on logout".
  - Visibility: `session.test.ts` "defers background recovery until the page becomes visible".
  - Cross-document: `src/account/__tests__/account-pulse-cross-document.test.ts` runs the app tab and the
    events document together over a same-origin BroadcastChannel fake, and
    `account-pulse-contract.test.ts` freezes the pulse wire format, channel names and storage keys
    (Phase 0c C8 harness); `account-sync-protocol.test.ts` pins the parser over both former
    validators.
  - Single receiver: `src/ui/__tests__/account-pulse-receivers.test.ts` (one channel and one
    listener per transport for the session and the UI together, the I10 cases (a) to (e), the
    popup-only context and the backgrounded-opener resume orders) and `session.test.ts` "the
    single account pulse receiver".
- **Status:** `owner-in-place`. Phase 2 removed the last independent machine in the app (C8-I1
  wire contract, C8-I4 one parser, C8-I10 single receiver, with the anchor tests above). New pulse
  handling extends `session.ts` or subscribes to it; the classic runtimes stay pinned copies.

### RO-29 PRO presence heartbeat timer slot

- **Resource:** the PRO runtime's `HEARTBEAT_TIMER` slot (`'pro-room-heartbeat'`) in
  `src/pro-room/runtime.ts`.
- **Current owners/flows:** the ordinary presence loop (`runHeartbeat` every
  `HEARTBEAT_INTERVAL_MS`) and control-channel recovery (`runControlChannelRecovery`, which takes
  the slot until it succeeds or exhausts) share the slot; the visibility handler clears and re-arms
  it. Both live in `runtime.ts`; `src/pro-room/heartbeat-single-flight.ts` single-flights the
  presence request itself.
- **Target single owner:** unchanged (`runtime.ts`).
- **Allowed requesters:** none outside `runtime.ts`.
- **Lifecycle operations:** set and clear the timer, run a heartbeat, begin and complete
  control-channel recovery, publish signaling exhaustion.
- **Deadline owner:** `runtime.ts`; recovery is bounded by `SIGNALING_RECOVERY_MAX_ATTEMPTS`.
- **Timing-constant home:** `HEARTBEAT_INTERVAL_MS` and `CONTROL_CHANNEL_RECOVERY_RETRY_MS`
  (`runtime.ts`). The same `[1_000, 2_000, 4_000, 8_000, 15_000]` is the Standard signaling
  reconnect schedule `SIGNALING_RECOVERY_BACKOFF_MS` in `src/network/signaling-health.ts` (Phase 4,
  C5-2; `src/network/peer.ts` reads it and `SIGNALING_RECOVERY_MAX_ATTEMPTS` is its length).
  Phase 4 keeps the PRO copy separate and leaves the PRO runtime alone (owner decision,
  2026-10-24); adopting the shared schedule there would be a later PRO change.
- **Anchor tests:**
  - Supersession: `src/pro-room/__tests__/heartbeat-single-flight.test.ts` "guarantees a fresh
    reconciliation after an epoch event races an old heartbeat".
  - User pause/stop: n/a.
  - Teardown: `heartbeat-single-flight.test.ts` "does not let a reset flight enqueue work into the
    next room lifecycle".
  - Visibility: missing (the slot's clear and re-arm on visibility, and recovery holding the slot).
- **Status:** `owner-in-place`. Copy triage (Phase 0d): the Standard copy moved to its home in
  Phase 4 (C5-2); the PRO copy stays separate and the guard keeps the pair listed.

### RO-30 Back-button history entries

- **Resource:** this page's guard entries in browser history.
- **Current owners/flows:** the guard controller `src/core/back-button-guard.ts` (epoch, frame,
  leaving, suspended) and its helper `src/core/back-button-history.ts` (leave attempt with a 1 s
  fallback), wired in `app.ts`; each has a popstate listener. The controller is the owner per
  [Back closes the top window](back-closes-top-window-2026-10-17.md).
- **Target single owner:** unchanged (`back-button-guard.ts`).
- **Allowed requesters:** windows registered for Back, and an exit that leaves the room through
  the controller's `requestLeave()`, which opens the same leave confirmation an unused Back opens
  (2026-10-28: `app.ts` routes `ui:request-leave-session` there, sent by the demo tour of a guest
  who cannot end it on its visible exit, Finish tour, Escape and Back); the hard navigation home
  belongs to RO-23.
- **Lifecycle operations:** push or replace a guard, `history.back()`, leave attempt, suspend and
  resume.
- **Deadline owner:** `LEAVE_FALLBACK_MS` (1 s), which fires before the session reset's 2 s commit
  timeout (`src/core/__tests__/navigation-contract.test.ts`).
- **Timing-constant home:** `src/core/navigation-contract.ts` (Phase 2, C6-1).
- **Anchor tests:**
  - Supersession: `src/core/__tests__/back-button-guard.test.ts` "a newly starting surface cancels
    old frames and waits for the newer close".
  - User pause/stop: `back-button-guard.test.ts` "Back on the confirmation means Stay and the next
    Back can ask again".
  - Teardown: `back-button-guard.test.ts` "does not compete with an update or terminal reset".
  - Visibility: `back-button-guard.test.ts` "cancels a hidden document and resumes only while still
    needing a guard".
  - Re-arm after a recovered navigation: `page-navigation-owner.integration.test.ts` "(h) ... is
    absorbed, and the guard re-arms when the deadline recovers" and `back-button-guard.test.ts`
    "re-arms one guard when a navigation absorbed a Back and then settles".
  - Leave request: `back-button-guard.test.ts` "opens the unused-Back leave confirmation for an
    exit that leaves the room" and `page-navigation-owner.integration.test.ts` "(i) a leave
    request from an exit that leaves the room".
- **Status:** `owner-in-place`. Phase 2 C6-12 (owner decision 5, 2026-10-23, which reverses part
  of the 2026-10-17 Back decision): the guard subscribes `handleStateChange` to the navigation
  owner's `onNavigationPendingChange`, sent at the end of settle after the queue and the attempt's
  callbacks, so it re-arms once a navigation that absorbed a Back settles in this document; a
  confirmed leave keeps its own recovery wiring.

## Accepted exceptions

Each record below keeps a duplicate, drops a planned step or defers one, with its evidence. Where
behaviour risk remains it says whether a [known-accepted](../known-accepted.md) entry exists; a new
entry needs the owner's acceptance and is not implied by this registry.

### RO-31 Presence delivery does not re-arm the playback outbox

- **Parent:** RO-07. Plan step C7-5 dropped.
- **Exception:** a delivered presence snapshot does not make a backing-off playback head due at
  once.
- **Evidence:** a PREPARE cannot wait out a long backoff: the transition barrier
  `PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS` (3 s, `cloudflare/pro-room-playback-timing.ts`, RO-03)
  commits the transition and the COMMIT replaces the head with a record due immediately. One
  ordering miss retries after 1 s; a lag near 60 s needs about six consecutive failures (a
  signaling outage). Clients also get canonical state from the 15 s heartbeat snapshot. The
  transport returns a boolean, so a re-arm could not tell an epoch conflict from partial fan-out.
- **Behaviour risk:** delayed playback delivery only during a signaling outage; no known-accepted
  entry.
- **Revisit when:** production logs show playback retries rejected as epoch-stale.
- **Status:** `accepted-exception`.

### RO-32 Two R2 duration readers

- **Parent:** RO-08. Plan step C7-7 not scheduled.
- **Exception:** the registration and playback probes both keep reading R2; the Phase 1 owner
  (C7-6) shares only the slot predicates (in flight, queued), the plain start and the alarm
  candidate, and each probe keeps its own guarded completion restart.
- **Evidence:** one reader would have to carry over the first-failure diagnostic, the
  memory-held backoff after a refused write and the 5 min retry for a null file answer; the
  mutual-exclusion checks already prevent two concurrent reads of one object.
- **Behaviour risk:** none user-visible.
- **Revisit when:** another coupling defect between the probes appears.
- **Status:** `accepted-exception`.

### RO-33 Guest YouTube recovery stays its own owner

- **Parent:** RO-02. Plan step C2-10 dropped.
- **Exception:** the guest local recovery does not become a stage of the zero-start run.
- **Evidence:** recovery is not the arm sequence: it accepts PLAYING, BUFFERING or a paused or cued
  state within 0.35 s, re-seeks on every failed poll, restores audio by command, verify and poll,
  and unmutes before `playVideo`. Folding it in would change `isInFlight` and `isProtocolActive`,
  which gate heartbeats and readiness.
- **Behaviour risk:** none beyond today's hand-off, whose Sync readiness gap is
  [known-accepted #14](../known-accepted.md).
- **Revisit when:** the change is relabelled as intended and has device evidence.
- **Status:** `accepted-exception`.

### RO-34 PRO YouTube arm adapter stays eager

- **Parent:** RO-03 and RO-14. The lazy-adapter option of plan step C2-13 rejected.
- **Exception:** the PRO authority adapter in `iframe.ts` and `player.ts` stays in the initial
  bundle.
- **Evidence:** the iOS tap gate in `iframe.ts` sets the gesture unlock proof synchronously; a
  chunk loaded later would lose a tap made before it loads, and the next PREPARE would report
  audio locked again.
- **Behaviour risk:** none (bundle size only).
- **Revisit when:** a design keeps the gesture proof eager and an iPhone test of the first PREPARE
  after a cold room entry passes.
- **Status:** `accepted-exception`.

### RO-36 Failed-PLAY confirm closure stays on the bus

- **Parent:** RO-01 and RO-10. Plan step C1-I8 dropped.
- **Exception:** transport keeps passing `confirmForegroundRestart` to `app.ts` in the failed-PLAY
  event.
- **Evidence:** the commit happens in `app.ts`, and after it the attempt is no longer current; a
  replacement would need a defined channel back to transport before `app.ts` checks currency,
  and the generic branch has no transport caller. The closure is correct and tested.
- **Behaviour risk:** none.
- **Revisit when:** Phase 7 makes a committed attempt queryable by token.
- **Status:** `accepted-exception`.

### RO-37 Defensive retry-versus-semantic branch stays in `app.ts`

- **Parent:** RO-01. Plan step C1-I2(c) dropped.
- **Exception:** the recovery dialog keeps cancelling a semantic attempt token on the
  `retry-failed-play` path instead of deleting that branch as unreachable.
- **Evidence:** deleting it saves a few bytes, but a future path that carries a semantic token into
  a failed-PLAY retry would then confirm, emit the rejoin and also retry.
- **Behaviour risk:** none.
- **Revisit when:** Phase 7 encodes the retry-versus-semantic exclusivity in the flight-result type.
- **Status:** `accepted-exception`.

### RO-39 Two Cloudflare Realtime control clients

- **Parent:** RO-04 and RO-20. Plan step C4-11 deferred.
- **Exception:** the Realtime control calls (request, response check, track close) stay copied in
  `src/network/system-audio-sfu.ts` and `src/network/pro-system-audio-sfu.ts`. Their shared
  values (the STUN entry, the request deadline and the response cap) come from
  `src/network/system-audio-media.ts` since Phase 5 C4-1.
- **Evidence:** the copies sit in different lazy chunks, and a shared module could become a new
  shared chunk on cellular joins; the name builders and error-text fallbacks differ, and the
  Standard SFU branches on error text.
- **Behaviour risk:** none (no shared state).
- **Revisit when:** a scratch build shows the chunk impact, or a defect appears in one copy.
  Phase 5 does not schedule C4-11 or a Realtime production smoke (owner decision P5-D12 A,
  2026-10-25).
- **Status:** `accepted-exception`.

### RO-42 PRO-only capture policy stays eager

- **Parent:** RO-20. Plan step C4-14 deferred.
- **Exception:** PRO lease toasts, the share-limit timer sync and lease-failure refresh stay in the
  eager `src/audio/system-capture.ts`.
- **Evidence:** `getDisplayMedia` and `beginProLeaseAttempt` must stay in one user-gesture turn;
  the eager saving is unmeasured.
- **Behaviour risk:** none.
- **Revisit when:** a scratch build shows a meaningful eager saving. Phase 5 does not schedule
  C4-14 (owner decision P5-D13 A, 2026-10-25).
- **Status:** `accepted-exception`.

### RO-43 Update prompt stays eager

- **Parent:** RO-22. Plan step C6-15 (load the update dialog lazily) is rejected, not deferred
  (owner decision 2026-10-24).
- **Exception:** the waiting-worker prompt in `sw-register.ts` stays in the initial bundle. This
  is the settled decision, not a placeholder for a later move.
- **Evidence:** the owner rejected C6-15 on 2026-10-24 for two reasons. A lazily loaded dialog
  shows late, after the user is already in a room. A chunk that fails to load would need a
  different fallback dialog, which conflicts with the 2026-10-17
  [same dialog everywhere](update-dialog-everywhere-2026-10-17.md) rule. Loading it after a
  controller change would also risk the old-chunk criterion of the PWA update QA domain. The
  eager saving was never measured and is not a lever for the Phase 3 bundle budget.
- **Behaviour risk:** none.
- **Revisit when:** only if the owner reverses the 2026-10-24 decision.
- **Status:** `accepted-exception`.

### RO-44 AudioContext native-call guard is syntactic

- **Parent:** RO-01. The type-checker form of the native-call guard is deferred to Phase 7.
- **Exception:** the Phase 0b guard counts `resume()` and `suspend()` calls syntactically per file;
  it does not resolve the receiver type.
- **Evidence:** a syntactic count plus an importer ratchet is cheaper now; `app.ts` already has a
  `suspend()` and `resume()` on another controller, excluded by receiver.
- **Behaviour risk:** an aliased AudioContext could escape the count.
- **Revisit when:** Phase 7.
- **Status:** `accepted-exception`.

### RO-45 No guard for new module-level lifecycle slots

- **Parent:** all records. The module-slot guard is deferred.
- **Exception:** nothing flags a new module-level `let` slot with a lifecycle-style name.
- **Evidence:** a probe on 2026-10-22 found 307 such slots in 94 files, too noisy for a first
  guard.
- **Behaviour risk:** a new independent machine can start without a record; the AGENTS.md rule is
  the only stop.
- **Revisit when:** after the first guard round, as a file-level manifest.
- **Status:** `accepted-exception`.

### RO-46 Invalidation events are sent once

- **Parent:** RO-07.
- **Exception:** `pro-room-invalidated` and `system-audio-invalidated` events get one send and no
  outbox record. A failed send is dropped, including the 409 `PRO_ROOM_EPOCH_STALE` refusal of a
  send that reaches signaling before the presence snapshot of a new epoch. A
  `pro-room-invalidated` event can also carry the one-shot added-tracks notice (`addition`, a
  `pro-queue-addition` frame). `scheduleDeveloperInvalidationHint` attaches it for developer API
  and bot additions and, from `commitParticipantSnapshot`, for every participant playlist
  addition, and sends it through `scheduleServerEvent` to `broadcastServerEvent` with no retry.
  The client announces it only from a realtime frame (`acceptProRoomRealtimeFrame` to
  `acceptQueueAddition`, then `flushAcceptedQueueAdditions` to `announceTracksAddedLocally` in
  `src/pro-room/runtime.ts`), and no heartbeat replays it. A failed or epoch-stale send therefore
  drops the notice; it is not delayed.
- **Evidence:** the events are refresh hints, not state. `acceptProRoomRealtimeFrame` in
  `src/pro-room/runtime.ts` answers them with a heartbeat or a system-audio read, and every 15 s
  presence heartbeat reconciles the playlist, effects, queue mode, playback and system audio (the
  comment on `refreshSystemAudioState` names it the backstop for a lost invalidation).
  `src/pro-room/__tests__/runtime-account-lease.test.ts` "applies a share end from the next
  heartbeat when its invalidation is lost" pins that backstop. After an epoch bump, signaling also
  closes the old-epoch sockets. The added-tracks notice has no backstop, and `runtime.ts` already
  prefers omitting a stale notice to showing it late: `flushAcceptedQueueAdditions` skips a notice
  older than one already announced.
- **Behaviour risk:** after a failed send, other participants see the change up to one heartbeat
  (15 s) late and never see its added-tracks notice; no known-accepted entry; the owner may
  confirm one.
- **Revisit when:** the owner wants these changes delivered faster than one heartbeat after a
  failed send, or wants the added-tracks notice to survive one.
- **Status:** `accepted-exception`.

## Records added after the survey

### RO-47 Header loader `_default` holder

- **Resource:** the header loader's `_default` holder in `src/ui/toast.ts`: the holder that
  `showLoader(show, text)` and `updateLoader(percent)` write when they pass no holder ID.
- **Current owners/flows:** `src/ui/toast.ts` owns the holder map, picks the foreground holder
  (priority first, then the newest) and runs the 400 ms `loader-reset`. The `_default` holder
  belongs to the foreground media load: at most one load of the current track or demo runs at a
  time, serialized by the playback mode and the load epoch and session
  ([Playback concurrency invariants](playback-concurrency-invariants.md) M1, M2). Its writers are
  the file prepare and decode (`src/player/decode.ts`, hides gated by the load session), the guest
  wait, request and receive of the current track's file (`src/player/playback.ts`,
  `src/storage/transfer-receive.ts`, `src/storage/preload.ts`), the foreground remote-share wait
  and download (`src/share/remote-share.ts`), the guided demo download (`src/demo/mode.ts`),
  YouTube playlist indexing (`src/youtube/iframe.ts`), and clears when a load is superseded or
  ends: a YouTube takeover or stop (`iframe.ts`, `src/youtube/player.ts`), a stuck transfer reset
  (`src/storage/storage.ts`, `src/storage/recovery.ts`) and a failed guest join
  (`src/ui/setup.ts`).
- **Target single owner:** unchanged. The writers share the key on purpose and carry no token: a
  newer load or a mode switch must clear whatever the older load left on the header, and a
  per-flow token would make every superseding path learn every other flow's token. No report of a
  wrong or stuck header text exists.
- **Allowed requesters:** the files above, pinned per file by the resource-ownership guard (CHECK
  8). Anything that can overlap the foreground load shows its own named holder: PRO transfers
  (`src/pro-room/runtime.ts`, `src/player/transport.ts`), a background preload receive
  (`src/storage/preload.ts`; the receive a PLAY waits for writes `_default`), remote uploads
  (`src/share/remote-share.ts`), the host-wait notice (`src/ui/keep-open-notice.ts`, priority),
  YouTube info fetches (`src/youtube/player.ts`, `src/youtube/standard-playlist.ts`), the route
  check (`src/player/playback.ts`) and the Standard operator uplink (`src/ui/toast.ts`). A no-ID
  hide never removes a named holder.
- **Lifecycle operations:** show with text, update progress, hide.
- **Deadline owner:** none; each load's own deadlines end it, and the reset only repaints.
- **Timing-constant home:** `src/ui/toast.ts` (`loader-reset`, 400 ms).
- **Anchor tests:**
  - Supersession: `src/ui/__tests__/toast.test.ts` "lets a newer no-ID show take over the
    foreground load's text" and "keeps default progress behind an explicitly named foreground
    holder".
  - User pause/stop: n/a; a stop ends the load, which hides through its own path.
  - Teardown: `toast.test.ts` "lets a no-ID hide end only the default holder, never a named one".
  - Visibility: n/a (the header progress snaps while the page is hidden).
- **Status:** `owner-in-place`. Phase 2 named the owner and the writers instead of adding tokens.

### RO-48 Guest YouTube re-align lanes stay two

- **Parent:** RO-05. Plan steps C3-I3 and C3-I4 not done, and the narrow coalescing changes
  (P4-D8 B and C) not scheduled (owner decision P4-D8 A, 2026-10-24).
- **Exception:** the rejoin router (`src/player/local-output-rejoin.ts`) and the background-return
  chain (`src/player/background-return-sync.ts`) stay two re-align machines on one rendezvous.
  They share only the retry spacing `LOCAL_OUTPUT_REALIGN_RETRY_MS` (Phase 4 4A, C3-I1), the
  rendezvous busy and cooldown result and the end on `youtube:set-local-paused` (G2); each cancels
  only itself.
- **Evidence:** I3 and I4 change no behaviour. I4 would move two lanes whose policies differ on
  almost every field (pause handling, visibility, host connection, retirement, snapshot handling,
  wait mechanism, cooldown, replacement) into one module while keeping them concurrent, and would
  make the return chain depend on `initLocalOutputRejoin()`, which
  `src/network/room-session-feature-runtime.ts` runs as an optional enhancement; today the return
  chain needs no initialization. The cross-flow harness
  (`src/player/__tests__/local-output-realign-cross-flow.test.ts`, Phase 4 4A, tests only) runs
  both chains on the real `youtube/sync.ts` and pins the two seams the lanes leave. An unlock
  between about 1.3 and 3 s after a lock-screen PLAY adds a second pause, seek and play 3,010 ms
  after the first alignment (P4-D8 (a)). A return while the host is buffering, cued or on another
  video gives up after 1,250 ms and nothing retries (P4-D8 (b)); the host's own PLAYING state
  frame then re-aligns the guest, and without that frame only the heartbeat correction remains.
- **Behaviour risk:** a second short re-align after a quick unlock, and an offset left after a
  give-up until the host's next state frame or the heartbeat correction. Harness evidence only,
  not seen on a device; no known-accepted entry.
- **Revisit when:** a device check of a lock-screen PLAY with a quick unlock, or of a return while
  the host buffers, or the harness shows either seam disturbing playback; the owner is then asked
  about the narrow changes for train 4B.
- **Status:** `accepted-exception`.

### RO-49 Queue and demo start anchors stay two

- **Parent:** RO-06. Plan steps C3-I8 (one pending shared-start anchor) and C3-I7 (one
  start-and-publish-once primitive) deferred (owner decision P4-D9 A, 2026-10-24; the narrow fix
  of 2026-10-25 does not schedule them).
- **Exception:** the queue anchor in `src/player/transport.ts` and the demo anchor in
  `src/demo/host-start-anchor.ts` stay two records with different validation; only the 200 ms
  lead `LOCAL_FILE_START_LEAD_MS` is shared (Phase 4 4A, C3-I1).
- **Evidence:** the shared-start harness (`src/demo/__tests__/shared-start-anchor.test.ts`, Phase
  4 4A, flipped to the fix in train 4B) shows DEMO_PLAY, SYNC_PONG, the late-join demo bootstrap
  and `getPendingDemoHostStartAt()` carrying one demo start, and the queue anchor never armed
  while the demo runs, selected queue item or not, so only one record exists in each mode. Its
  queue rows show a queue start after the demo still arms the queue anchor, publishes it in PLAY
  and the PONG, and keeps the canonical timeline across a hidden stall. One anchor is not a plain
  move: the queue anchor is a canonical wall-clock timeline, not only a pending deadline, so
  recording the demo the same way either gives the demo that timeline or adds a second record
  behind one getter, and revoking it in `stopPlayerNode` would change queue-anchor behaviour on
  many paths. Six demo test files mock `player/transport.ts` wholesale, so a shared primitive would
  make them fail on a missing export or pass against a mock.
- **Behaviour risk:** the overlap this record named (the demo host's position governed by a
  selected queue item's timeline, 4.8 s against 2.8 s audible after a hidden stall in the
  harness) is fixed in train 4B (owner decision 2026-10-25). That timeline also drove the host's
  background-resume rebuild (`playback:refresh-current-position`), which moved a selected-queue
  demo host's output forward to the room position (4.8 s). Since the fix the demo host rebuilds
  at its own position (2.8 s) and its PONG reports that position, also while it answers hidden
  (0 s), as it already did without a selected queue item; a guest whose position is more than
  2 s from the host's (`FILE_HARD_RESYNC_DRIFT_SEC` in `src/network/sync.ts`) hard-resyncs back
  to it, so the guests, not the host, absorb the stall (guest side from code reading). Left as
  well: the demo anchor is not revoked by transport pause and stop, only by demo code; and a
  queue file started while the demo flag is still set keeps the queue anchor and publishes its
  PLAY, while the late-join PONG still advertises the demo track and the demo start (unchanged,
  pinned by the harness). No known-accepted entry.
- **Revisit when:** another demo or queue anchor problem is confirmed as a defect; the owner wants
  the room to keep its position through a demo host's background stall, which needs a
  demo-owned canonical timeline (C3-I8), not a narrower fix; or the owner schedules one anchor
  (C3-I8, with C3-I7), which needs its own owner decision.
- **Status:** `accepted-exception`.

### RO-50 App build floor

- **Resource:** the App build floor in the main global service-control object
  (`MusixquareServiceControl`, `cloudflare/service-control-object.ts`): the stored `minAppBuild`
  with its revision, request journal and history, the live-App report `{appBuild, reportedAt}`,
  and the effective floor the entry gates enforce (`effectiveAppBuildFloor` in
  `cloudflare/app-build-floor-contract.ts`: the lower of the stored floor and a report at most
  `APP_BUILD_FLOOR_REPORT_STALE_MS` old, otherwise 0). Forced update, train 9.0.14.
- **Current owners/flows:** the object is the single owner. One mutation queue serializes both
  writers; it checks the expected revision, replays by request id, refuses a raise that names no
  live App build or exceeds it, and writes a raise's live build as a fresh report. Two machines
  write it, both in `cloudflare/app-worker.ts` through `cloudflare/service-maintenance.ts`:
  - the setters, through `updateAppBuildFloor`: the GitHub Actions ops route
    (`APP_BUILD_FLOOR_OPS_PATH`, verified by `cloudflare/github-actions-oidc.ts` against pinned
    repository, ref, environment, event, runner and workflow claims; `set` names the build the
    App serves, `lower` names none) and the admin view `/api/admin/app-build-floor`, which is
    lower-only because it never names a live build;
  - the minute cron report (`reportServedAppBuild`, then `reportLiveAppBuild`), which runs before
    the maintenance return of `scheduled()` and writes only the report, never the stored floor,
    its revision or its history. The build is read from the App's own `/service-worker.js`
    asset, so no copy of the cache epoch lives in the Worker.

  Readers: the Signaling pending-auth check and the PRO front door through `readAppBuildFloor`
  (one isolate cache, fail-open), the public status (`APP_BUILD_FLOOR_PUBLIC_STATUS_PATH`) and the
  page's client read (`APP_BUILD_FLOOR_CLIENT_PATH`). The client read publishes 0 unless the floor
  was read live, keeps a live value in the colo's edge cache, and clamps the answer to the build
  its own assets serve on every request. The edge cache is a reader's cache with one lifetime,
  not a writer. A setter's or reporter's answer refreshes its own isolate's cached view. Since
  forced update Inc 7 the client read's one product caller is the page's start and resume check
  (RO-22), at most two reads per page per minute.

- **Target single owner:** reached. A new writer goes through `updateAppBuildFloor` or
  `reportLiveAppBuild`; nothing else posts to the object's floor paths.
- **Allowed requesters:** writes from `handleAppBuildFloorOps` and `handleAdminAppBuildFloor`
  (setters) and `reportServedAppBuild` (report) in `cloudflare/app-worker.ts`, and later the C5-0
  lab's generated local control route; reads through `readAppBuildFloor` in
  `cloudflare/signaling-worker.ts`, `cloudflare/pro-room-worker.ts` and `cloudflare/app-worker.ts`,
  and `readAppBuildFloorHistory` in the admin view.
- **Lifecycle operations:** set (a raise up to the live build, or a lower), lower, replay,
  conflict, repair an unreadable stored record, report the live build, read the effective floor.
- **Deadline owner:** none of its own. Each object call is bounded by
  `SERVICE_CONTROL_READ_TIMEOUT_MS`. A report older than `APP_BUILD_FLOOR_REPORT_STALE_MS` turns
  enforcement off, so a broken cron or an App older than 9.0.14 never leaves the floor on.
- **Timing-constant home:** `cloudflare/app-build-floor-contract.ts`:
  `APP_BUILD_FLOOR_REPORT_STALE_MS` (5 min) and `APP_BUILD_FLOOR_EDGE_CACHE_TTL_S` (30 s). The
  isolate cache uses `SERVICE_CONTROL_CACHE_TTL_MS` in `cloudflare/service-maintenance.ts`. The
  key-set refresh spacing `GITHUB_OIDC_JWKS_REFRESH_MIN_INTERVAL_MS` (60 s) belongs to the
  verifier in `cloudflare/github-actions-oidc.ts`, not to the floor.
- **Anchor tests:**
  - Supersession: `src/pro-room/__tests__/service-control.test.ts` "replays, refuses reuse,
    supersedes, conflicts and keeps a no-op revision" and "bounds the effective floor by a fresh
    report that never changes the stored floor or history";
    `src/core/__tests__/app-build-floor-app-worker.test.ts` "bounds an older stored floor by the
    build it reports and never writes the floor" and "refreshes the isolate floor after its own
    lower, so the gates follow without a read".
  - User pause/stop: n/a (server).
  - Teardown: `app-build-floor-app-worker.test.ts` "publishes 0 while the floor is off or once the
    live report is stale" and "publishes 0 for an object without the floor routes, no binding or
    a failed read"; `src/core/__tests__/service-maintenance.test.ts` "keeps the last canonical
    floor as stale when a later read fails, and 0 before any".
  - Visibility: n/a.
  - Setters: `src/core/__tests__/app-build-floor-ops.test.ts` (the abuse limit before any token
    parse or key fetch, each pinned claim, `set` above the live build refused, `lower` refusing a
    raise) and the admin rows of `app-build-floor-app-worker.test.ts`.
- **Status:** `owner-in-place`. Added with forced update Inc 3 (train 9.0.14), when the cron
  report became a second machine on the floor beside the setters.

### RO-51 Return-from-background dialog

- **Resource:** the dialog slot of a return from the background: one dialog per return (owner
  decision 2026-10-17, [Resume dialog dedup](resume-dialog-dedup-2026-10-17.md)).
- **Current owners/flows:** a precedence, with no single slot holder. Highest first: the forced
  update dialog (RO-22, forced update train 9.0.14), the audio recovery dialog (`src/app.ts`),
  the long-background warning (`src/ui/long-background-warning.ts`). A higher dialog withdraws
  the lower ones that are open or queued through their `AbortSignal` (a queued one is skipped
  when the dialog queue reaches it) and keeps new ones from opening while it is pending. The
  warning yields to audio recovery (`yieldToAudioRecovery`, `hasAudioRecoveryPrompt`) and to the
  forced update (`yieldToForcedUpdate`, `isForcedUpdatePending`). `app.ts` subscribes to the
  forced dialog's presentation (`subscribeForcedAppUpdatePresentation`): it withdraws the warning
  and the audio recovery dialog (a pending follow-up is cleared, the active one aborted through
  the existing supersession path), and `runAudioRecoveryRequest` returns at once while
  `isForcedAppUpdatePending()`, follow-ups and failed-PLAY requests included. The AudioContext
  stays as the return left it (RO-01 unchanged): the forced dialog has no Later and its Apply
  leaves the page.
- **Target single owner:** a return-dialog slot in `long-background-warning.ts`, if a fourth
  requester appears.
- **Allowed requesters:** the background resume guard's `warn`
  (`src/core/background-resume-guard.ts`), every audio recovery request
  (`runAudioRecoveryRequest` in `src/app.ts`), and the update machine's forced entry through the
  port in `src/core/app-build.ts`.
- **Lifecycle operations:** show, withdraw (abort), skip while a higher dialog is pending.
- **Deadline owner:** none; each dialog waits for the user. The guard's thresholds stay its own.
- **Not covered:** dialogs that need the user's answer and are not part of a return (one the user
  opened, the host-unresponsive dialog in `src/network/host-presence.ts`) are not withdrawn; the
  forced dialog follows the tap that closes them.
- **Timing-constant home:** none of its own; the guard's `DEFAULT_RECOVER_THRESHOLD_MS` (1 s) and
  `DEFAULT_WARN_THRESHOLD_MS` (60 s) in `src/core/background-resume-guard.ts`.
- **Anchor tests:** on the real guard and warning, wired as `app.ts` wires them, in
  `src/core/__tests__/sw-update-transitions.integration.test.ts` "return-time dialogs (RO-51)":
  - Supersession: F25 (a forced request withdraws the warning on screen; the guard's flight ends)
    and `src/ui/__tests__/long-background-warning.test.ts` (an open and a queued warning
    withdrawn by `yieldToForcedUpdate`; no warning while the forced update is pending).
  - User pause/stop: n/a (nothing recovers by itself; Apply is the user's act).
  - Teardown: F27 (a forced request held by a navigation withdraws nothing until it presents;
    no presentation is announced for a loop-guard refusal or a reload already in flight).
  - Visibility: F26 (a 61 s return while the forced dialog is pending recovers and never asks for
    the warning), and since forced update Inc 7 the start and resume check's real returns, both
    orders: I5 (recovery first, the warning on screen, then the read lands below the floor: the
    warning is withdrawn), I6 (the read first: the warning is never asked for) and I7 (a second
    return while the forced dialog is open: no read and no warning).
  - The `app.ts` wiring (the subscription and the early return of `runAudioRecoveryRequest`) is
    checked by reading, as 8.11.7's was: `app.ts` is the bootstrap module and is not imported in
    tests.
- **Status:** `duplicated` (three dialog holders, each with its own abort, coordinated by
  precedence and one pending query). Added with forced update Inc 5 (train 9.0.14), when the
  forced dialog became the third requester on the slot; it replaces the side-flow entry.

### RO-52 PRO browser completion final object

- **Resource:** the final R2 object of one reserved PRO asset during browser completion
  (`handleCompleteMedia` in `cloudflare/pro-room-worker.ts`): the object at `asset.objectKey`,
  promoted from the staging upload whose ETag is durably pinned in
  `RoomAsset.completionSourceEtag` before any write, with that pin in its
  `mxqr-copy-source-etag` metadata. PRO upload reliability train (9.0.17,
  [report](pro-upload-reliability-2026-10-27.md)).
- **Current owners/flows:** the completion handler is the single owner; the room's mutation
  serialization runs one completion at a time. Two writers act on the key inside it, one after
  the other:
  - the presigned R2 CopyObject (`copyReservedMediaObject`), conditional on the pinned ETag and
    bounded by `fetchWithDeadline`. A copy abandoned at its deadline can still commit at R2;
  - the binding promotion (`promoteStagedMediaThroughBinding`), the get/put path every browser
    completion used through 9.0.16. It runs only when the copy left no verified final object:
    any non-200 status (412 included), a network error, the deadline, an unparseable or
    oversized result, a failed post-copy HEAD, an ETag or metadata mismatch, or missing S3
    credentials. It reads the staging object once and writes only when that read's ETag equals
    the pin, so a replacement upload is never promoted.

  Both write the same key with the same pinned metadata, and the final HEAD checks that
  metadata, not which writer won, so a late copy that commits after the fallback leaves an
  equivalent object. A late object after the asset is deleted, as a reservation or as a ready
  asset the fallback completed, is collected by the existing staging tombstone
  (`StagingTombstone.finalObjectKey`, the room alarm). Deletion leaves that tombstone while the
  asset still holds its staging key: a ready asset drops the key only after the staging object
  has been absent for the hour-long quiet window, which starts at least 60 s after completion,
  while the copy's presigned URL expires after 8 s. A copy still committing after that hour is
  outside this record. Each attempt records one bounded `media_copy` and, when it runs, one
  `media_copy_fallback` diagnostic; a plain `media_copy` success logs only its first detail per
  window and never takes the repeated-detail budget that failures and fallbacks share. Developer
  API completion (`handleInternalDeveloperMediaUploadComplete`) keeps its own stream copy for the
  assets it reserves; it is a separate route on separate assets.

- **Target single owner:** reached (the handler). Retiring the fallback removes the second writer;
  that is an owner decision once production `media_copy` records show the copy is reliable.
- **Allowed requesters:** the browser completion route, through the upload queue's per-file
  continuation in `src/pro-room/upload-queue.ts`, which owns user retries. Nothing schedules a
  completion retry on the server. How long a same-key completion retry still replays is the
  completion receipt's lifetime in the browser receipt ledger (RO-53): until a playlist names the
  asset, at most until orphan cleanup collects it.
- **Lifecycle operations:** pin the source, copy, verify by HEAD, fall back, verify again, commit,
  keep the pin for a same-key retry, collect a late object.
- **Deadline owner:** `fetchWithDeadline` for the copy; the App facade for the whole request. The
  fallback has no deadline of its own, as completion had none through 9.0.16. After a timed-out
  copy the request has already spent the 8 s copy deadline inside the room's mutation queue, so
  the facade times out whenever the fallback takes more than the remaining 2 s, where the 9.0.16
  binding stream had the whole 5 s control budget. When the fallback outlasts the facade, the
  same-key retry replays the stored answer or re-verifies the final object. In an
  `all` release the PRO Worker deploys before the App Worker, so for that window the old facade's
  5 s control budget fronts the new copy; a slow completion then times out at the facade as it
  did on 9.0.16, and the retry recovers it the same way.
- **Timing-constant home:** `cloudflare/pro-room-media-timing.ts`:
  `PRO_ROOM_MEDIA_COPY_TIMEOUT_MS` (8 s) and `PRO_ROOM_MEDIA_COMPLETE_TIMEOUT_MS` (derived, 10 s),
  which the App facade imports.
- **Anchor tests:** in `src/pro-room/__tests__/pro-room-worker.test.ts`, "persistent PRO room
  private media accounting":
  - Supersession: "fails a definite source change without a fallback write, then reports
    UPLOAD_MISMATCH" and "refuses changed staging bytes after an ambiguous copy, including a cold
    restart" (replacement bytes never win, through either writer).
  - User pause/stop: n/a (server; the upload queue owns user cancellation).
  - Teardown: "reclaims a final object recreated by a timed-out copy after reservation deletion",
    "reclaims a final object a timed-out copy commits after its fallback-completed asset is
    deleted" and "recovers the final object after the CopyObject response is lost without another
    copy".
  - Visibility: n/a.
  - Fallback: "completes through the binding fallback after %s from the copy", "completes through
    the binding fallback when the copy has %s at its deadline", "keeps the pinned reservation
    retryable when the fallback finds %s"; diagnostics bounds in
    `src/pro-room/__tests__/pro-room-diagnostics.test.ts` "emits media copy outcomes, the first
    success included, with only bounded timing and size buckets" and "keeps the repeated detail
    budget for copy failures and fallbacks in a room full of successes".
  - Facade budget: `src/core/__tests__/pro-room-proxy-diagnostics.test.ts` "keeps only media
    completion alive beyond the control deadline without success diagnostics".
- **Status:** `owner-in-place`. Added with the PRO upload reliability train (9.0.17), when the
  binding fallback became a second writer beside the presigned copy.

### RO-53 PRO browser receipt ledger

- **Resource:** the browser receipt ledger of the PRO room Durable Object
  (`activeRoom.idempotency` in `cloudflare/pro-room-worker.ts`), at most `IDEMPOTENCY_MAX_ITEMS`
  (256) receipts shared by every participant. It holds every scope that `idempotencyLedger` does
  not send elsewhere (`session-create:*`, `*:presence-close` and `developer:*` have their own
  ledgers): `participant:<id>:snapshot`, `:playlist-switch`, `:playlist-transfer`, `:reserve`,
  `:complete`, `:delete` and `:playback-authority`, and `bot-context:<tokenHash>` and
  `bot-execute:<tokenHash>`. A receipt makes a request sent again with the same idempotency key
  replay its first answer. A full ledger refuses a new mutation with
  `ROOM_STATE_CAPACITY_EXCEEDED` and never evicts a live receipt. Receipt retention train (owner
  decision 2026-10-27, [report](pro-receipt-retention-2026-10-27.md)) and receipt follow-up
  train A (owner decision 2026-10-28, [report](pro-receipt-followup-a-2026-10-28.md)).
- **Current owners/flows:** the ledger methods of `MusixquareProRoom` are the single owner:
  `idempotencyLedger`, `reserveIdempotencySlot`, `storeIdempotency`, `storeSnapshotIdempotency`,
  `replayIdempotency`, `idempotencyRecord`, `idempotencyExpiresAt`, since the retention train
  `browserReceiptLifetimeMs`, `receiptExpiresAtMs`, `capBrowserReceiptLifetime` and
  `releaseSettledCompletionReceipts`, and since train A `releaseIdempotencyRecord` and
  `releaseSettledReserveReceipts`. `prune` (before every room request and on every alarm)
  expires receipts and cuts longer ones, and `scheduleAlarm` wakes the room at the earliest
  expiry. Two other lifecycle machines act on receipts:
  - the asset deletion marker owns the `asset-delete-pending` receipt of an explicit delete
    (`beginAssetDeletion`, `continueAssetDeletion`, load repair in
    `normalizeLoadedAssetDeletions`). Its expiry is the marker, not wall time, and the cut leaves
    it alone. The commit that finishes the delete (asset row, quota, staging tombstone and
    revision together) asks the owner to release that receipt (`releaseIdempotencyRecord`) and
    stores no final receipt, so a finished delete holds no slot;
  - the asset GC reconciliation (`reconcileAssetGarbageCollection`, on every committed playlist
    change, every upload completion and every prune) asks the owner to release the completion
    receipts whose asset a playlist names or that is no longer a ready asset
    (`releaseSettledCompletionReceipts`), and the reserve receipts whose asset is gone, no
    longer `reserved` or being deleted (`releaseSettledReserveReceipts`). Both matches read the
    stored answer, so no field is added, and a receipt whose answer names no asset waits for its
    expiry. A completion releases its own reserve receipt inside its commit, before it stores
    the completion receipt.

  A receipt lives only as long as the App can send its request again with the same key, in active
  page time:
  - single-request scopes (playlist edits, playlist switch and transfer, reserve, BOT context and
    execute, BOT destructive terminal receipts): `PRO_ROOM_REQUEST_RECEIPT_TTL_MS`, at least
    twice the longest single-request window. Every browser control request is sent once under
    the 15 s `DEFAULT_CONTROL_REQUEST_TIMEOUT_MS`; the playlist manager, reserve and delete make a
    fresh key for every attempt; a BOT execute must reach the room inside the 45 s context lease,
    and the requester relays its result inside its own 15 s deadline. Reserve keeps the earlier
    of its reservation expiry and the window, and is released as soon as its asset leaves
    `reserved`;
  - playback (`proRoomPlaybackReceiptTtlMs`): the App's second attempt reuses the key and starts
    from a timer, so a frozen page can send it until its device's presence lapses
    (`requireSession` with active presence). The receipt keeps the window, or twice one presence
    window plus one attempt when that is longer (45 s presence in production, so the window);
  - upload completion (`proRoomCompletionReceiptTtlMs`): the batch failure dialog's Retry
    (`src/pro-room/upload-queue.ts`, RO-52) reuses the completion key while the upload's RAM-only
    continuation lives. The receipt lives until a playlist names the asset or the asset is gone,
    and at most `completedAtMs` plus the orphan GC grace, so it never ends before the unnamed
    asset it describes;
  - explicit delete: no receipt once it commits. While its R2 objects are deleted, the marker's
    pending receipt fences a same-key resend; the commit that finishes the delete releases it.
    The App sends every delete once with a fresh key and only logs a failure
    (`src/pro-room/playlist-state-manager.ts`, `src/pro-room/media-transfer.ts`).

  A receipt an earlier Worker wrote (24 hours, or again after a rollback to one) is cut to its
  scope's lifetime from now at the first prune and persisted; that prune also releases a reserve
  receipt it wrote once the asset has left `reserved`, and a final delete receipt it wrote
  expires like any other. Past its window, and for a delete once it commits or a reserve once its
  asset leaves `reserved`, a same-key resend gets the fence answer and is never applied twice:
  `REVISION_CONFLICT` (compare-and-set base revision), `PLAYBACK_REVISION_CONFLICT`,
  `ASSET_NOT_FOUND`, `PRESENCE_EXPIRED`, or a second reservation that expires unused for reserve.
  Without the receipt, the same key with a different body is no longer `IDEMPOTENCY_CONFLICT`
  either: a delete acts on the asset it names and a reserve makes a new reservation, each under
  its own checks. The App sends neither, since it makes a fresh key for every delete and reserve
  attempt. Playback relies on presence as well as on its revision: a command that went to
  `preparing` and was then cancelled (queue item removed, superseded) does not bump the playback
  revision, so the presence lapse stops a late second attempt. That bounds the attempt to one
  presence window plus one attempt after the receipt was written, inside the presence-derived
  receipt lifetime. A late BOT run with the same `requestId` starts anew: its additions replay
  through BOT's 24-hour Developer mutation receipt, removals and clears answer
  `BOT_ACTION_FAILED`, queue mode is fenced by its Developer mutation receipt and base revision,
  and playback commands (play after add included) replay only while their 10-minute Developer
  command receipt lives. Nothing in the App or the App Worker sends a `requestId` twice. A client
  that resends one on purpose gets nothing a fresh `requestId` would not: the same authority
  checks and the same BOT limits (three runs a minute per member, 100 an hour per room). So BOT
  playback keeps its 10-minute Developer command receipt and BOT's Developer mutation receipts
  keep 24 hours (owner decision 2026-10-28): a longer fence on playback would guard only against
  a resend nobody makes, and it would spend the Developer mutation ledger that BOT additions and
  the public API share. The windows cover resends in active page time; the fences, with presence
  for playback, are what make a later resend safe. Session-create receipts can outlive a reload
  (`sessionStorage`), but they are in their own ledger.

- **Target single owner:** reached (the ledger methods). The cap stays 256: a 9.0.17 or 9.0.18
  Worker refuses to load a room whose ledger holds more (`assertBoundedRoomState`), so a raise
  needs two releases (load first, write second) or a separate ledger field.
- **Allowed requesters:** the Worker handlers `handleCompactSnapshotMutation` with
  `commitParticipantSnapshot`, `handlePlaylistSwitch`, `handlePlaylistTransfer`,
  `handleCreateReservation`, `handleCompleteMedia`, `handleDeleteMedia` with
  `continueAssetDeletion`, `handlePlaybackCommand`, `handleInternalBotContext` and
  `handleInternalBotExecute` with the BOT terminal receipts of
  `handleInternalDeveloperQueueMutation` and `removeInactivePlaylistItems`; the `bot.result` relay
  check in `handleInternalAuthorityCheck` reads. Client senders: `src/pro-room/playlist-state-manager.ts`,
  `src/pro-room/media-transfer.ts` with `src/pro-room/upload-queue.ts`,
  `src/pro-room/playback-controller.ts`, and the chat `/bot` path through `cloudflare/pro-bot.ts`.
- **Lifecycle operations:** reserve a slot, store, replay, expire, cut to the scope's lifetime,
  release a settled completion or reserve receipt, release the receipt of a finished delete,
  fence a pending delete (the marker).
- **Deadline owner:** none; receipts are fences, not attempts. Each request's deadline stays with
  its sender (the App's 15 s control deadline, the playback controller's attempt timeout, the BOT
  pipeline and lease).
- **Timing-constant home:** `cloudflare/pro-room-receipt-timing.ts`:
  `PRO_ROOM_REQUEST_RECEIPT_TTL_MS` (2 min), `PRO_ROOM_BOT_REQUEST_LEASE_MS` (45 s, moved from the
  Worker), `PRO_ROOM_PLAYBACK_COMMAND_REQUEST_TIMEOUT_MS` (6 s) and
  `PRO_ROOM_PLAYBACK_COMMAND_ATTEMPTS` (2), both moved from `src/pro-room/playback-controller.ts`,
  which imports them, and the derived `proRoomPlaybackReceiptTtlMs` and
  `proRoomCompletionReceiptTtlMs`. The presence window, orphan GC grace and reservation lifetime
  stay the Worker's configured `PRESENCE_TTL_SECONDS`, `ASSET_GC_GRACE_SECONDS` and
  `RESERVATION_TTL_SECONDS` (`cloudflare/wrangler.pro-room.toml`). Other ledgers keep their own
  values: Developer mutation and presence-close `IDEMPOTENCY_TTL_MS` (24 h), session-create and
  Developer command receipts 10 min.
- **Anchor tests:**
  - Ordering: `src/pro-room/__tests__/pro-room-receipt-timing.test.ts` (the window is at least
    twice the longest single-request window; playback covers twice one presence window plus one
    attempt over the whole presence clamp and the wrangler value; completion covers the GC grace;
    its copies of the Worker's accepted ranges for the presence window, GC grace and reservation
    lifetime are pinned against the Worker's own reading of them).
  - Supersession: in `src/pro-room/__tests__/pro-room-worker.test.ts`, "PRO browser receipt
    retention": "replays a same-key edit inside its window and fences it once the receipt is
    gone", "never copies a track twice when a copy is sent again after its window" and "keeps BOT
    Developer receipts for 24 hours so a late run of the same request adds nothing twice".
  - User pause/stop: n/a (server).
  - Teardown: "replays an unnamed completion until orphan cleanup collects its asset, then answers
    ASSET_NOT_FOUND", "releases a completion receipt as soon as a playlist names its asset",
    "replays a reservation while it is reserved and releases its receipt once the asset leaves
    reserved", "leaves no receipt once a delete commits, so a same-key resend answers
    ASSET_NOT_FOUND", "cuts receipts an earlier Worker kept for 24 hours to their window and
    persists the cut", "alarms and durably prunes idle idempotency and rate-limit ledgers at their
    deadlines" and, for the marker's receipt, "keeps a pending delete receipt fenced past its old
    TTL and rejects same-key reuse" and "finishes a pending delete on a full ledger and gives its
    slot back (%s)".
  - Visibility: "fences a playback command a frozen page sends again after its window".
  - Capacity and rollback shape: "lets a full ledger accept edits again one window later instead
    of one day", "takes far more than 256 edits from a busy room without filling the ledger",
    "deletes 300 files inside one window without filling the ledger", "uploads 200 small files
    inside one window without filling the ledger" and "keeps each browser receipt only as long as
    its request can be sent again".
  - Sender premises: `src/pro-room/__tests__/playlist-state-manager.test.ts` "refreshes and
    rebases once on a CAS conflict with a fresh key for the changed body",
    `src/pro-room/__tests__/media-transfer.test.ts` "retries only completion with the same
    body/key and reuses its ready result for append retries" and
    `src/pro-room/__tests__/runtime-server-playback.test.ts` "replays one lost playback response
    with the same idempotency key".
- **Status:** `owner-in-place`. Added with the receipt retention train, when the cut of longer
  receipts and the completion release became machines beside the ledger's own expiry. Train A
  extended the same owner (the reserve release, and the release of a finished delete's receipt in
  place of a final receipt) and added no machine.

## Checked side flows without a record

The survey also checked these and found one owner with a side flow (WEAK) or a single owner. They
get a record only if a change adds a second machine:

- Signaling socket reconnect (`src/network/peer.ts` outer loop, pre-admission retry in
  `cloudflare-signaling.ts`), partitioned by admission. The provider owns the current
  guest admission's explicit `ROOM_EXPIRED` reason; the existing outer loop reads
  that eligibility and cancels its retry on the provider notification. This is
  not another retry machine. RTC liveness remains with RO-15, and explicit new
  admission uses the existing page-navigation owner (Phase 3 batch, 2026-10-24;
  [contract](signaling-liveness.md#explicit-standard-room-expiry)). A refusal below
  the App build floor (`app-update-required`, forced update, train 9.0.14) is a
  permanent guest admission refusal: the provider marks the admission `authFailed`
  as for `guest-reconnect-denied`, live channel or not, the same outer loop reads it
  and reopens nothing, and the forced update dialog (RO-22) takes over.
- Transport RTC configuration (TURN): three writers, last write wins; the pre-admission retry
  passes no expiry (self-healing).
- Seek slider drag (`src/ui/range-drag.ts` and `src/ui/seekbar.ts`): two cooperating layers,
  accepted by owner decision O7 ([known-accepted #19](../known-accepted.md)). `cancelSeekGesture`
  does not call `cancelRangeDrag` on purpose; `seekbar.test.ts` "rejects every value of a drag
  whose seek permission is revoked mid-drag, then accepts a fresh accessibility seek" shows no
  seek, one denial and the authoritative position after every move, so the fix-lane candidate is
  closed.
- Guest join attempt (`src/network/guest.ts`): an old inline cancel in `src/ui/setup-guest.ts`
  skips `invalidateGuestJoinAttempt`; a fix-lane candidate only with a failing test.
- PRO Durable Object alarm (`scheduleAlarm`) and the signaling Durable Object alarms: single owners
  with side hints.

## Before adding a flow

For a new recovery, retry, timeout, watchdog or lifecycle flow:

1. Find the resource's record. Call or extend its owner; hold no pending, generation or timer
   state outside it. If no record fits, add one in the same change when your flow becomes the
   second machine on that resource, including a resource listed under
   [Checked side flows without a record](#checked-side-flows-without-a-record). A flow that is its
   resource's only owner needs no record.
2. Give each attempt one deadline. If a retry ladder's longest delay exceeds a watchdog on the same
   slot, decide which owns the deadline and write it in the record.
3. Check the flow against every other machine in the record: an explicit user pause or stop, a
   hidden page, teardown and room-kind switches, the sibling chain's timers, re-entry while an
   attempt is pending.
4. When restoring audio, mute or play, read the same desired-state function as the sibling path,
   and check the Standard and PRO copies.
5. Order catch branches abort, cancel, known, unknown.
6. Import timing from the record's home and derive mirrored values from the named constant; never
   retype them. Where a runtime cannot import, pin the copy with a parity test named in the
   record.
7. Add a failing interleaving test that runs the real sibling instead of mocking it.

## Resource-ownership guard

`scripts/check-resource-ownership.mts` runs in CI as `node scripts/check-resource-ownership.mts`
over production code in `src/` and `cloudflare/`. It walks the TypeScript syntax tree, so comments
and unrelated strings never count, and every baseline is an exact count or list with a reason:

1. **Registry parity:** the ID block against the record headings, each record's **Status** field,
   the index rows and the record IDs the guard names, as listed under
   [Machine-readable ID list](#machine-readable-id-list); and the `Resource owner:` headers.
2. **Guarded page state, per file:** `inert` writes, page-lock claims and walks over the body's
   children (RO-24), aria-hidden writes in page-lock files, Fullscreen request methods and
   Fullscreen exit methods, the latter only in `src/core/fullscreen.ts` (RO-26), history entry
   writes (RO-30), navigation through `location` (RO-23) and `SKIP_WAITING` sends (RO-22).
3. **Worker callers, per function:** the `/internal/realtime/v1/broadcast` endpoint anywhere in
   production code (RO-07) and `readProRoomFileDuration` in `cloudflare/` (RO-08; the app's
   local-file parse in `src/pro-room/upload-duration.ts` is outside that resource).
4. **One deadline owner per PRO SFU attempt** (RO-04, principle 2): the subscriber retry maximum
   stays below the guest receive watchdog (the receive slot's since Phase 5 C4-2; its
   `SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS` is read from `src/network/system-audio-media.ts`), or the PRO
   SFU reception start passes `deadline: 'route'` (`receiveWatchdog: false` before Phase 5 C4-6).
   Armed `beginTrustedSystemAudioReception` starts (any use without the literal
   `{ deadline: 'route' }`) are an exact list per function.
5. **Copied timing constants** inside the files a record names as its timing home (principle 4):
   same-named constants, identical numeric tuples and shared timing objects form a triaged list.
   Constants that share only a value are report-only, because round values such as 1 s, 15 s and
   30 s recur across different contracts; `--report` lists them.
6. **AudioContext native calls, per file:** `resume()` and `suspend()` (RO-01, RO-44).
7. **Developer API authority fence writers, per function** (RO-25): a string or template literal
   that inserts into, replaces into, updates or deletes from
   `mxqr_developer_api_room_authority_fences`, or names it in any other way (a bare table name can
   become the target of template-built SQL such as the decommission's `DELETE FROM ${table}`), is
   allowed only in `revokeDeveloperApiKeysForAuthorityChange`, `clearDeveloperApiAuthorityFence`
   and the PRO room's `deleteDeveloperRoomData` loop list. Reads (FROM or JOIN) and qualified
   columns do not count; the match ignores case, and a literal holding the name's tail
   (`authority_fences`) outside a full name counts too.
8. **Header loader default holder writers, per file** (RO-47): `showLoader()` and `updateLoader()`
   calls in `src/` whose holder ID is missing or can be undefined write the `_default` holder of
   `src/ui/toast.ts`, which belongs to the foreground media load. An ID can be undefined when it is
   `undefined` or `void`, a conditional or `??` / `||` with such a branch, or a name that one of its
   declarations in the same file can leave undefined (an optional parameter, a `let` with no value,
   or any of these as its value); names match across the file, not by scope. Shows, hides and
   progress ticks all count; calls with a named holder do not.
9. **System-audio receive slot writers, per file** (RO-04, Phase 5 prep): in `src/`,
   `setSystemAudioReceiving` value uses (calls or the setter passed on); `claimPlaybackOwner`
   value uses unless the call's first argument is a string literal other than `'system-audio'`
   (a computed owner or a passed-on claim counts); reads of `.input` on a receiver named
   `widener`; and raw `'systemAudio.isReceiving'` writes (a `setState()` call or an object-literal
   key such as a `batchSetState` reset) outside `src/player/ownership.ts`, the setter's home. The
   widener match is by name, so a widener held under another name is not seen, and neither is a
   call through a renamed import of the setter or the claim
   (`import { setSystemAudioReceiving as … }`). The counts are
   final since Phase 5 C4-8: only the receive slot writes, beside the sharer's own claim, the file
   playback route's widener input and the `leaveSession` reset; no route adapter has an entry.
10. **System-audio media tuning home, per file** (RO-04, Phase 5 C4-1): in the system-audio route
    files (`src/network/system-audio-*.ts` and `src/network/pro-system-audio-*.ts`), writes of
    `playoutDelayHint` or `maxBitrate` (an assignment or an object-literal key) and string
    literals naming `stun.cloudflare.com` stay in `src/network/system-audio-media.ts`. The eager
    STUN entries in `src/network/peer.ts` and `src/network/standard-room-prerequisites.ts` are
    out of scope, because importing the deferred home there would pull it into the first load.

The requesters of `scheduleSessionReset` and `scheduleDocumentReload`, and each page navigation
sink by function, are checked by `scripts/check-navigation-sinks.mts` (RO-23, Phase 2 C6-14).

Not checked yet: callers of the other records' lifecycle operations (YouTube player commands,
`claimPlaybackOwner` with a literal owner other than `'system-audio'`), receivers resolved by
type (RO-44), module-level lifecycle slots (RO-45), timer-name manifests, shared phase unions,
duplicated helper names, "mirrors" copy-marker comments, registered timings retyped as literals
in requester files, and header loader
holder IDs read from a property, a call or another module (RO-47). Until then, review those by
hand against each record.

## How to change this registry

- **Same change.** A change that adds a machine to a registered resource, makes a flow the second
  machine on an unregistered resource (see [Before adding a flow](#before-adding-a-flow)), moves an
  owner, consolidates a duplicate or changes a timing home updates the record, the index and the
  `resource-ownership` block in the same pull request.
- **Stable IDs.** IDs are never renumbered or reused. A new record takes the next free number. When
  a resource disappears, delete its record and its block line and leave the number unused.
- **Status changes.** `duplicated` becomes `owner-in-place` only in the change that removes the last
  independent machine, citing that change's tests. When an exception's "Revisit when" condition
  is met, the change that meets it either deletes the exception record (its number stays unused)
  and updates the parent record, or re-evidences it with new evidence and a new "Revisit when".
- **Guard baselines.** The resource-ownership guard's counts are exact: it fails when a count rises
  and also when it falls, until the baseline matches. A baseline changes only in the pull request
  that changes the counted code, with the reason written next to the entry and in that pull
  request. Lowering one is routine, in the change that removes the debt. Raising one, or adding an
  entry, also needs the record update that explains the new machine or owner. Never change a
  baseline in a separate baseline-only change.
- **Owner headers.** Owner files carry a `Resource owner: RO-NN` header comment, added with each
  area's first runtime change; the guard checks that every header names a record here that is not
  an exception, and that no ID is claimed by two files.
- **Accepted behaviour risk.** An exception that leaves user-visible risk links its
  [known-accepted](../known-accepted.md) entry once the owner accepts it.
- **Source review.** When a record is re-verified against the code, update `Last source review`.
