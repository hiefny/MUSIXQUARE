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
  reader in `cloudflare/` and the Developer API authority fence writers. See
  [what it does not check yet](#resource-ownership-guard).
- **Deadline owner:** the module allowed to time out an attempt on the resource.
- **Timing-constant home:** the module and constant names that hold the resource's timing values.
- **Anchor tests:** the tests that pin the four cancellation cases: supersession (a newer attempt
  or identity wins), user pause/stop (explicit user intent beats automation), teardown (session
  end, room switch, destroy; for Workers, decommission or isolate restart) and visibility (hidden
  page, background return). `missing` means no such test exists yet; `n/a` means the case cannot
  occur for that resource.
- **Status:** `duplicated` (two or more independent machines still hold state or lifecycle
  operations on the resource; a phase consolidates it, or an owner decision has to come first, as
  for RO-21), `owner-in-place` (one owner exists; the record tells new work which owner to
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

**Release batching (owner decision, 2026-10-23).** Phase 1 changes only the Workers, so it releases per step and users see no app update dialog. In Phases 2 to 7, small app increments merge to main but ship as at most one app update per phase, and never more than 7 days after the first merged increment, so users see about 6 to 8 updates instead of about 20. Phase 3 needs one extra ordinary release to prove the new update path. Holding everything until Phase 7 was rejected: one large release is hard to attribute and roll back, it blocks hotfixes, and it delays device checks. A change to both the PRO room and App Workers ships with target `all`, because the partial-release gate blocks either Worker alone while the other has undeployed source (seen on 2026-10-23 with the Phase 0d server constants). Each batch gets one report and its device checks.

## Index

| ID    | Resource                                                 | Area           | Status             | Consolidation                |
| ----- | -------------------------------------------------------- | -------------- | ------------------ | ---------------------------- |
| RO-01 | AudioContext running state                               | Audio          | duplicated         | 0d, 7; fix lane G7           |
| RO-02 | YouTube Standard shared start                            | YouTube        | duplicated         | 0d, 6                        |
| RO-03 | YouTube arm protocol, Standard and PRO copies            | YouTube        | duplicated         | 0d, 6                        |
| RO-04 | System-audio receive slot                                | System audio   | duplicated         | Fix lane G5, G6; 0d, 5       |
| RO-05 | Guest YouTube re-align retry chains                      | Output rejoin  | duplicated         | 0d, 4                        |
| RO-06 | Host shared start, playlist queue and guided demo        | Output rejoin  | duplicated         | 0d, 4                        |
| RO-07 | PRO signaling broadcast delivery                         | Workers        | owner-in-place     | Done (0d, 1)                 |
| RO-08 | PRO asset duration read                                  | Workers        | owner-in-place     | Done (0d, 1)                 |
| RO-09 | Owner-transfer saga row                                  | Workers        | owner-in-place     | None                         |
| RO-10 | Local-file source node restart                           | Output rejoin  | owner-in-place     | 4 (naming only)              |
| RO-11 | Deferred-start mailbox `playback.pendingPlayTime`        | Playback       | accepted-exception | None (by design)             |
| RO-12 | YouTube iframe audio state                               | YouTube        | duplicated         | 6                            |
| RO-13 | YouTube manual-offset transaction                        | YouTube        | owner-in-place     | None                         |
| RO-14 | YouTube iframe instance lifecycle                        | YouTube        | owner-in-place     | None                         |
| RO-15 | Standard logical data connection liveness                | Transport      | duplicated         | 0d, 4                        |
| RO-16 | Data-PC SDP lane                                         | Transport      | owner-in-place     | 4 (restart gate only)        |
| RO-17 | Host per-guest connection close                          | Transport      | duplicated         | 0d, 4                        |
| RO-18 | Host-to-guest bulk lanes                                 | Transfer       | duplicated         | 0d, 4                        |
| RO-19 | Guest fetch of the current track                         | Transfer       | owner-in-place     | 0d (deadline table)          |
| RO-20 | PRO system-audio lease and publication                   | System audio   | owner-in-place     | None                         |
| RO-21 | PRO checkpoint re-apply after a disruption               | PRO room       | duplicated         | Owner decision               |
| RO-22 | Waiting service worker activation                        | Page lifecycle | duplicated         | 0d, 3                        |
| RO-23 | App-owned page navigation                                | Page lifecycle | duplicated         | 0d, 2                        |
| RO-24 | `inert` page lock                                        | Page lifecycle | owner-in-place     | 2 (reset surface on top)     |
| RO-25 | Developer API authority fence row                        | Workers        | owner-in-place     | None (D5 open)               |
| RO-26 | Top-document fullscreen state                            | UI             | duplicated         | 0d, 2                        |
| RO-27 | Playlist rows and scroll position                        | UI             | duplicated         | 2                            |
| RO-28 | Account session reads and refresh pulses                 | Account        | duplicated         | 0d, 2                        |
| RO-29 | PRO presence heartbeat timer slot                        | PRO room       | owner-in-place     | 0d (copy triage)             |
| RO-30 | Back-button history entries                              | Page lifecycle | owner-in-place     | 2 (owner decision)           |
| RO-31 | Presence delivery does not re-arm the playback outbox    | Workers        | accepted-exception | Revisit on EPOCH_STALE logs  |
| RO-32 | Two R2 duration readers                                  | Workers        | accepted-exception | Revisit on a coupling defect |
| RO-33 | Guest YouTube recovery stays its own owner               | YouTube        | accepted-exception | Revisit with device evidence |
| RO-34 | PRO YouTube arm adapter stays eager                      | YouTube        | accepted-exception | Revisit with an iOS proof    |
| RO-35 | Side-route outage deadline stays in control isolation    | Transport      | accepted-exception | Revisit when #18 retires     |
| RO-36 | Failed-PLAY confirm closure stays on the bus             | Audio          | accepted-exception | Revisit in Phase 7           |
| RO-37 | Defensive retry-versus-semantic branch stays in `app.ts` | Audio          | accepted-exception | Revisit in Phase 7           |
| RO-38 | Separate screensaver and YouTube fullscreen exit state   | UI             | accepted-exception | Owner decision               |
| RO-39 | Two Cloudflare Realtime control clients                  | System audio   | accepted-exception | Revisit after a build check  |
| RO-40 | Hand-copied PRO publication teardown blocks              | System audio   | accepted-exception | Phase 5 or later             |
| RO-41 | Two PRO re-apply owners serialized, not deduplicated     | PRO room       | accepted-exception | Revisit after the 0c test    |
| RO-42 | PRO-only capture policy stays eager                      | System audio   | accepted-exception | Revisit after a build check  |
| RO-43 | Update prompt stays eager                                | Page lifecycle | accepted-exception | Revisit after a build check  |
| RO-44 | AudioContext native-call guard is syntactic              | Audio          | accepted-exception | Phase 7                      |
| RO-45 | No guard for new module-level lifecycle slots            | All            | accepted-exception | After the first guard round  |
| RO-46 | Invalidation events are sent once                        | Workers        | accepted-exception | Owner decision               |

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
RO-15 duplicated
RO-16 owner-in-place
RO-17 duplicated
RO-18 duplicated
RO-19 owner-in-place
RO-20 owner-in-place
RO-21 duplicated
RO-22 duplicated
RO-23 duplicated
RO-24 owner-in-place
RO-25 owner-in-place
RO-26 duplicated
RO-27 duplicated
RO-28 duplicated
RO-29 owner-in-place
RO-30 owner-in-place
RO-31 accepted-exception
RO-32 accepted-exception
RO-33 accepted-exception
RO-34 accepted-exception
RO-35 accepted-exception
RO-36 accepted-exception
RO-37 accepted-exception
RO-38 accepted-exception
RO-39 accepted-exception
RO-40 accepted-exception
RO-41 accepted-exception
RO-42 accepted-exception
RO-43 accepted-exception
RO-44 accepted-exception
RO-45 accepted-exception
RO-46 accepted-exception
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
- **Anchor tests:**
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
- **Current owners/flows:** trusted reception and its 30 s watchdog
  (`beginTrustedSystemAudioReception` in `src/network/system-audio-guest.ts`, which also runs
  `stopAllMedia`); the Standard P2P attach (same file); the Standard SFU guest attach and cleanup
  (`src/network/system-audio-sfu.ts`); the PRO coordinator subscription
  (`ensureCoordinatorSubscription`, `attachCoordinatorTrack`, `retryCoordinatorSubscription` in
  `src/pro-room/system-audio-service.ts`); PRO LAN-direct track delivery
  (`src/network/pro-system-audio-direct.ts`, through the service). The attach sequence (trust
  boundary, `initAudio`, identity re-check, source swap, primer, `widener.input`, receiving flag,
  owner claim, visualizer) is written three times. The service calls the Standard adapters'
  cleanups directly; bus pairs `system-audio:delivery-handoff` and `system-audio:receive-timeout`
  connect the rest.
- **Target single owner:** one receive-slot module (proposed
  `src/network/system-audio-receive-slot.ts`; its location is an owner decision). Route adapters
  register and call begin, attach, interrupt, resume, detach, adopt and end.
- **Allowed requesters:** the route adapters (Standard P2P, Standard SFU, PRO SFU, PRO direct)
  through the slot. `src/audio/system-capture.ts` and the Standard host only emit
  `system-audio:*` events.
- **Lifecycle operations:** begin reception, attach, set receiving, claim the playback owner, arm
  or clear the receive deadline, cleanup with meta restore.
- **Deadline owner:** per route today. Standard P2P: the guest 30 s watchdog. PRO SFU: the
  subscription retry backoff (2.5 s doubling to 30 s); since 9.0.1 it begins with
  `receiveWatchdog: false` (G1). PRO LAN-direct: since 9.0.2 it also begins with
  `receiveWatchdog: false`, and the service's direct receive deadline
  (`DIRECT_RECEIVE_DEADLINE_TIMER`, 30 s from the guest's `SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS`) only
  reports the failure once and keeps the listener in reception for a late track (G5).
  Standard SFU guests also react to `system-audio:receive-timeout`.
  Target: one receive deadline per attempt in the slot.
- **Timing-constant home:** none. `SYSTEM_AUDIO_PLAYOUT_DELAY_S` is defined in
  `system-audio-guest.ts`, `system-audio-sfu.ts` and `pro-system-audio-sfu.ts`;
  `SFU_CONTROL_REQUEST_TIMEOUT_MS` in the two SFU modules; `SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS` in the
  guest module; `RECOVERY_DELAY_MS` and `SUBSCRIBER_RETRY_MAX_DELAY_MS` in the service. Target: a
  deferred-only `src/network/system-audio-media.ts` (Phase 0d, C4-1).
- **Anchor tests:**
  - Supersession: `src/network/__tests__/system-audio-guest.test.ts` "does not let a stale async
    stream failure tear down its replacement connection".
  - User pause/stop: `system-audio-guest.test.ts` "cancels a muted-track wait on force-stop and
    fences its late unmute from a successor".
  - Teardown: `system-audio-guest.test.ts` "restores previous meta when an active adapter-level
    receive cleanup runs".
  - Visibility: missing.
  - Cross-owner: `src/pro-room/__tests__/system-audio-subscriber-watchdog.test.ts` runs the real
    guest module with the service (G1). `system-audio-service.test.ts` mocks the guest and SFU
    modules, so it cannot see their interplay.
  - Guard: the resource-ownership guard fails when the PRO SFU reception start arms the guest
    watchdog while `SUBSCRIBER_RETRY_MAX_DELAY_MS` is not below `SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS`,
    and when an armed `beginTrustedSystemAudioReception` start appears in a new function. The
    start returns early while the placeholder is active, so an armed start on the retry path
    would re-arm the watchdog before the SFU start runs.
- **Status:** `duplicated`. Fix lane G5 (a PRO LAN-direct listener whose track arrived after the
  30 s watchdog stayed silent) is fixed in 9.0.2. G6 (each PRO SFU retry re-runs the reception
  start, including `stopAllMedia` and the host-started notice) is an open release-record item.
  Phase 0d (media constants), Phase 5 (slot). Exception RO-39.

### RO-05 Guest YouTube re-align retry chains

- **Resource:** a Standard guest's iframe re-alignment through `guestRendezvousSync`
  (`src/youtube/sync.ts`: pause, seek, `playVideo`).
- **Current owners/flows:** the rejoin router (`src/player/local-output-rejoin.ts`,
  `REJOIN_RETRY_MS`, timer `local-output-rejoin-retry`; mainly lock-screen or OS PLAY) and the
  background-return chain (`src/player/background-return-sync.ts`, `rendezvousChain`,
  `RENDEZVOUS_RETRY_MS`, timer `background-return-sync-rendezvous-retry`). Both use
  `[250, 750, 1_500, 3_000, 5_000]`, each cancels only itself, and their only shared guard is the
  rendezvous busy and cooldown result. Since 9.0.1 both end on `youtube:set-local-paused` (G2).
  Single-shot callers: `src/youtube/iframe.ts`, `src/ui/manual-sync-overlay-runtime.ts` and the
  host- or user-commanded attempts inside `youtube/sync.ts`.
- **Target single owner:** `local-output-rejoin.ts` as the re-align owner for participant-local
  automatic and OS-triggered attempts; `youtube/sync.ts` keeps the rendezvous primitive and
  host- or user-commanded attempts.
- **Allowed requesters:** OS and lock-screen PLAY (rejoin events), the background return
  (`app.ts` through `runBackgroundReturnSync`), the Sync button.
- **Lifecycle operations:** start a chain, retry on `busy`, wait for a host snapshot, retire on a
  new return, a local pause or an identity change.
- **Deadline owner:** each chain's retry timer; the rendezvous cooldown in `youtube/sync.ts`.
- **Timing-constant home:** two copies (`REJOIN_RETRY_MS`, `RENDEZVOUS_RETRY_MS`). Target: export
  from `local-output-rejoin.ts` and import it (Phase 0d, C3-I1).
- **Anchor tests:**
  - Supersession: `src/player/__tests__/background-return-sync.test.ts` "replaces the previous
    return retry chain instead of stacking a second one"; `local-output-rejoin.test.ts` "drops a
    scheduled busy retry after the queue occurrence changes".
  - User pause/stop: `background-return-sync.test.ts` "lets a local YouTube pause during the retry
    wait end the chain"; `local-output-rejoin.test.ts` "cancels a busy YouTube retry on explicit
    PAUSE and permits the next PLAY".
  - Teardown: `local-output-rejoin.test.ts` "does not let a stale busy result schedule work into a
    restarted session".
  - Visibility: `background-return-sync.test.ts` "ignores a sub-second visibility bounce that is
    not a background return".
  - Missing: both chains against the real `youtube/sync.ts`; both suites mock it.
- **Status:** `duplicated`. Phase 0d (one schedule), Phase 4 (one pause rule; the return chain
  moves into the router only if the owner approves coalescing the lanes).

### RO-06 Host shared start, playlist queue and guided demo

- **Resource:** the host's pending shared-start deadline for the local-file source node and the
  start-and-publish-once step.
- **Current owners/flows:** the queue anchor (`armStandardHostCanonicalTimeline`,
  `getStandardHostPendingFileStartAt`, published by `startHostFileAndBroadcastPlay` in
  `src/player/transport.ts`) and the demo anchor (`setDemoHostStartAt`,
  `getPendingDemoHostStartAt` in `src/demo/playback-timing.ts`; `startDemoPlayback` in
  `src/demo/mode.ts`). The modes are mutually exclusive and other modules branch on `demo.active`.
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
- **Timing-constant home:** `LOCAL_FILE_START_LEAD_MS` (`src/player/file-play-timing.ts`) and
  `DEMO_PLAY_START_LEAD_MS` (`playback-timing.ts`), both 200 ms, plus inline 2 s timeline trust
  windows. The legacy wire leads (200 ms for PLAY, 350 ms `DEMO_PLAY_SCHEDULE_AHEAD_MS`) differ on
  purpose for older receivers and stay separate. Target: one lead in `file-play-timing.ts`
  (Phase 0d, C3-I1).
- **Anchor tests:**
  - Supersession: `src/demo/__tests__/mode.test.ts` "does not restore stale media over a local file
    load started during exit".
  - User pause/stop: queue side `src/player/__tests__/concurrency-invariants.test.ts` "cancels a
    pending shared host start without advancing the paused position"; demo side missing (transport
    pause and stop do not clear the demo anchor).
  - Teardown: `src/demo/__tests__/mode-recovery.test.ts` "does not retry an aborted guest fetch
    after exit".
  - Visibility: missing.
- **Status:** `duplicated` (mutually exclusive modes). Phase 0d (one lead), Phase 4 (one anchor
  after the anchor investigation; one start-and-publish-once primitive). See
  [Standard file common start](standard-file-common-start.md) for the intended separate demo path.

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
    `normalizeLoadedPlaybackAuthority`, which can advance a legacy room's epoch on load.

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
    `reconcileSystemAudio`; twelve call sites await `broadcastServerEvent` directly after persist,
    in `handleInternalDeveloperCommandCreate`, `handleUpdateEffects`, `handleUpdateSettingsSync`,
    `handleUpdateQueueMode`, `handleAcquireSystemAudio`, `handleCommitSystemAudio`,
    `handleReleaseSystemAudio`, `commitParticipantSnapshot` (from
    `handleCompactSnapshotMutation`), `handlePlaylistSwitch` and `handlePlaylistTransfer`.

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
    and the 16-attempt cap on load).
- **Status:** `owner-in-place`. Phase 0d named the constants once (C7-1). Phase 1 C7-3 merged the
  two request builders ([report](pro-room-signaling-transport-2026-10-23.md)); C7-4 gave the
  outbox one due time, one alarm drain, one epoch hook and one load normalizer, with no behaviour
  change ([report](pro-room-outbox-duration-owners-2026-10-23.md)). The trigger modes, due time,
  caps and epoch hook are pinned in `pro-room-signaling-delivery.test.ts`; the request against the
  real signaling Worker in `pro-room-signaling-contract-workerd`. Durable record shapes are frozen.
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
    an earlier commit and the current one on one row, request against cron in both directions).
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
  generation fence arbitrates (an output-only rebuild bumps it, so a pending dialog retry is
  rejected). Naming the failed-PLAY lease and writing the fence down as an invariant is optional.
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
- **Status:** `owner-in-place`. Phase 4 (optional naming). See
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
  `capturePendingFileIntent`/`restorePendingFileIntent` with five restore sites: the three §4
  names plus the route-pending file prepare and the PRO direct R2 prepare. This record does not
  edit §4; its table still sets the policy for each path it lists.
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
  PC, data and control channels); every machine ends it through `terminate()`.
- **Current owners/flows:** the original PC's disconnected grace and ICE restart
  (`scheduleDisconnectedGrace`, `beginIceRestart` in
  `src/network/transport/cloudflare-signaling.ts`); the side PC's own deadline and ICE restart
  (`ControlIsolation` in `src/network/transport/control-isolation.ts`, deferring to the original
  through `originalReady` and `originalChanged`); the guest background-resume probe
  (`recoverAfterBackground`, reached from `app.ts` through `recoverPeerAfterBackground` in
  `src/network/peer.ts`), which deliberately closes after a long hidden period unless both PCs are
  connected.
- **Target single owner:** a link-liveness owner (planned
  `src/network/transport/link-liveness.ts`) holding the per-route outage deadlines, the resume
  probe and one close with a cause; the two modules keep their SDP and in-band restart executors.
- **Allowed requesters:** transport consumers through `close(reason)`; the heartbeat monitor reads
  liveness (RO-17).
- **Lifecycle operations:** start and cancel grace, ICE restart, background probe, terminate.
- **Deadline owner:** the original PC's 15 s grace; the side route's 15 s window capped at 30 s,
  deferred while the original is down; the probe's short close.
- **Timing-constant home:** `DATA_CONNECTION_DISCONNECTED_GRACE_MS` (`cloudflare-signaling.ts`)
  repeated as `DISCONNECTED_MS` and `RESTART_WINDOW_MS` (`control-isolation.ts`) and as a literal
  in `src/network/heartbeat-monitor.ts`; `RESTART_CAP_MS` is twice the grace. Target:
  `RTC_INTERRUPTION_GRACE_MS` in `src/core/constants.ts` (Phase 0d, C5-1).
- **Anchor tests:**
  - Supersession: `src/network/transport/__tests__/cloudflare-signaling.test.ts` "rolls an
    unanswered restart back if the old path recovers before its answer".
  - User pause/stop: `cloudflare-signaling.test.ts` "suppresses synchronous channel errors caused
    by an intentional close".
  - Teardown: `cloudflare-signaling.test.ts` "closes and disposes every RTC resource exactly once
    after disconnected grace expires".
  - Visibility: `cloudflare-signaling.test.ts` "does not grant a fresh full grace when a
    long-hidden disconnected RTC resumes".
  - Mixed versions: `control-isolation.test.ts` with the frozen fixture
    `src/network/transport/__tests__/fixtures/control-isolation-c9.ts`. A Wi-Fi to LTE switch with
    both PCs is device-only.
- **Status:** `duplicated`. Phase 0d (grace constant), Phase 4 (close causes, link-liveness
  owner). See [Control isolation side ICE restart](control-isolation-side-ice-restart-2026-10-19.md).
  Exception RO-35.

### RO-16 Data-PC SDP lane

- **Resource:** the signaling state of the shared data PC, which Standard P2P system-audio media
  calls also negotiate on.
- **Current owners/flows:** ICE restart and media negotiation (`MediaNegotiationOwner`) in
  `cloudflare-signaling.ts` share one serialized lane (`runSerializedMediaNegotiation`) and one
  per-peer `iceNegotiations` slot. A restart refuses while a media owner is unsettled; a media
  offer rolls back a restart, and a settled negotiation re-queues it.
- **Target single owner:** unchanged; the lane already is the owner. Phase 4 only moves the
  restart gate behind the link-liveness owner.
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
- **Status:** `owner-in-place`. Phase 5 starts from a fresh baseline because system audio shares
  this lane.

### RO-17 Host per-guest connection close

- **Resource:** each guest's connection on the host.
- **Current owners/flows:** the heartbeat monitor (`src/network/heartbeat-monitor.ts`) detaches
  and closes stale peers, re-deriving transport grace from raw PC state and honouring
  `conn.iceRecoveryDeadline`; the transport grace and terminate (RO-15) close independently.
  Detach is fenced by connection identity (`detachHostPeerConnection` in
  `src/network/host-peer-departure.ts`).
- **Target single owner:** the heartbeat monitor keeps the heartbeat leases and stale fencing that
  [Realtime runtime ownership](realtime-runtime-ownership.md) assigns to it, but reads transport
  recovery only through one transport-health view.
- **Allowed requesters:** host session teardown; readers of the peer list.
- **Lifecycle operations:** record heartbeat, detach, close, publish disconnect.
- **Deadline owner:** the monitor's stale thresholds (8 s closed, 30 s recovering, 90 s connected)
  and the transport's recovery deadline.
- **Timing-constant home:** `HEARTBEAT_RECOVERING_TRANSPORT_GRACE` (a different contract that
  shares 30 s) and the `15_000` literal copy of the transport grace in `heartbeat-monitor.ts`.
  Target: import the transport grace constant (Phase 0d).
- **Anchor tests:**
  - Supersession: `src/network/__tests__/heartbeat-monitor.test.ts` "records heartbeat only for the
    exact connected connection".
  - User pause/stop: n/a.
  - Teardown: `heartbeat-monitor.test.ts` "detaches every stale peer before close, tolerates close
    errors, then emits and broadcasts".
  - Visibility: missing.
  - Cross-owner: `heartbeat-monitor.test.ts` "honors only an exact bounded ICE recovery lease
    before cleaning a failed PC".
- **Status:** `duplicated`. Phase 0d, Phase 4 (one transport-health read path).

### RO-18 Host-to-guest bulk lanes

- **Resource:** one connection's data channel and its bulk credit, shared by the main file lane
  and the preload lanes.
- **Current owners/flows:** the main lane registry in `src/storage/transfer-send.ts`
  (`_activeUnicasts`, `_peerTransferOwners`, `_preparingUnicasts`; on an ICE interruption it
  excludes the peer and relies on the guest's recovery request) and the preload registry in
  `src/storage/preload.ts` (`_activePreloadUnicasts`, `_preloadPeerOwners`,
  `_suspendedPreloadLanes`; it suspends and resumes from chunk 0 on `network:peer-ice-recovered`).
  The preload lane asks `hasPendingCurrentFileTransfer`; each lane cancels on its own listener.
  Inferred, untested: after ICE recovery both lanes can stream the same file.
- **Target single owner:** one bulk-lane registry (planned `src/storage/bulk-lanes.ts`); per-lane
  policies, pumps and wire frames unchanged.
- **Allowed requesters:** file send, preload scheduling, the guest's recovery request.
- **Lifecycle operations:** register, suspend, resume, cancel, release on disconnect or
  replacement.
- **Deadline owner:** each lane's backpressure timeout.
- **Timing-constant home:** `UNICAST_BACKPRESSURE_LIMIT` and `UNICAST_BACKPRESSURE_TIMEOUT`
  (`transfer-send.ts`) with copies in `preload.ts`. Target: `src/storage/transfer-backpressure.ts`
  (Phase 0d, C5-3).
- **Anchor tests:**
  - Supersession: `src/storage/__tests__/preload-lane-ownership.test.ts` "forgets a paused lane
    whose connection was replaced".
  - User pause/stop: missing.
  - Teardown: `src/storage/__tests__/preload-capacity-lifecycle.test.ts` "cancels a parked sender
    without flushing stale bytes into a replacement unicast or ACK".
  - Visibility: n/a (host lanes do not depend on visibility).
  - Missing: both lanes after ICE recovery (Phase 0c reproduces or refutes the duplicate traffic).
- **Status:** `duplicated`. Phase 0d (lane constants), Phase 4 (registry; which lane wins after
  recovery is an owner decision). See
  [Preload resume after ICE recovery](preload-resume-after-ice-recovery-2026-10-20.md).

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
- **Lifecycle operations:** begin, send, match the wait response, complete, reset.
- **Deadline owner:** each wait; `playback.lifecycle` gates them.
- **Timing-constant home:** `WATCHDOG_TIMEOUT` (`src/core/constants.ts`) and `remote ? 60000 : X`
  literals in `transfer-receive.ts`. Target: a typed receive-deadline table beside
  `WATCHDOG_TIMEOUT` (Phase 0d, C5-3).
- **Anchor tests:**
  - Supersession: `src/network/__tests__/file-request-authority.test.ts` "prevents a stale owner
    or completion from clearing its successor".
  - User pause/stop: `src/storage/__tests__/recovery-owner-transition.test.ts` "retires pending
    recovery after authenticated PAUSE and system-audio START".
  - Teardown: `file-request-authority.test.ts` "releases a current owner when its connection
    closes before send".
  - Visibility: missing.
- **Status:** `owner-in-place`. Phase 0d (deadline table).

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
  suppresses lease-lost during the service's own release and re-acquire.
- **Target single owner:** unchanged split.
- **Allowed requesters:** the capture session through the bridge; the
  `pro-system-audio:lease-lost` event back to capture.
- **Lifecycle operations:** acquire, release, publish, recover, promote, heartbeat.
- **Deadline owner:** the service (`LEASE_HEARTBEAT_MS` 15 s, `DIRECT_AUTHORITY_LOSS_GRACE_MS`,
  release retry).
- **Timing-constant home:** `system-audio-service.ts`.
- **Anchor tests:**
  - Supersession: `src/pro-room/__tests__/system-audio-service.test.ts` "does not let a stale
    publisher recovery close the new incarnation publisher".
  - User pause/stop: `system-audio-service.test.ts` "fences a recovery acquire exactly once when
    the user stops while it is pending".
  - Teardown: `system-audio-service.test.ts` "does not revive retained direct routes or retry an
    SFU promotion after session reset".
  - Visibility: missing.
- **Status:** `owner-in-place`. Exceptions RO-39, RO-40, RO-42.

### RO-21 PRO checkpoint re-apply after a disruption

- **Resource:** the local media endpoint as driven by `playbackController.reconcile`
  (`src/pro-room/playback-controller.ts`), whose prepare step pauses the YouTube iframe until
  release.
- **Current owners/flows:** foreground recovery in `src/pro-room/runtime.ts`
  (`recoverVisibleProRoomPlayback`, `visibilityReturnReconciledGeneration`, triggered by
  `visibilitychange` and the background-return Sync) and the post-share restore in
  `system-audio-service.ts` (`restorePlaybackAfterRelease`, `resumePlaybackAfterShare`, held while
  the page is hidden). The controller's scheduler runs one flight at a time and queues the other
  owner; nothing checks across owners whether a revision was already re-applied.
- **Target single owner:** `runtime.ts` as the background-return repair authority, with the
  service deciding when to restore. Deduplication changes behaviour and needs an owner decision
  (RO-41).
- **Allowed requesters:** the runtime's visibility handler, the post-share restore through the
  runtime's restore callback.
- **Lifecycle operations:** reconcile with `rendezvous`, `youtubeOnly` and `preparePaused`.
- **Deadline owner:** each ladder; the scheduler serializes them.
- **Timing-constant home:** `VISIBILITY_PLAYBACK_RECOVERY_RETRY_MS` (`runtime.ts`) and
  `PLAYBACK_RESTORE_DELAYS_MS` (`system-audio-service.ts`), both capped at 15 s.
- **Anchor tests:**
  - Supersession: `src/pro-room/__tests__/runtime-server-playback.test.ts` "joins an in-flight
    YouTube visibility pass instead of starting a second rendezvous".
  - User pause/stop: `system-audio-service.test.ts` "does not revive an old explicit stop after a
    newer share generation is observed".
  - Teardown: missing.
  - Visibility: `runtime-server-playback.test.ts` "does not re-apply a YouTube checkpoint the
    visibility pass already re-applied"; `system-audio-service.test.ts` "holds restoration retries
    while hidden and resumes them when shown, without a cap".
  - Missing: the post-share restore and foreground recovery together (Phase 0c).
- **Status:** `duplicated`. Exception RO-41.

### RO-22 Waiting service worker activation

- **Resource:** `registration.waiting`, its activation (`SKIP_WAITING`, then `controllerchange`)
  and the navigation that follows.
- **Current owners/flows:** the update machine in `src/sw-register.ts` (`activationState`,
  `_swReloading`, four `SKIP_WAITING` sends, the cross-tab prompt lease in
  `src/sw-update-coordination.ts` and `src/sw-prompt-lock.ts`) and the hard-reset promotion in
  `src/core/sw-hard-reset.ts` (its own `SKIP_WAITING` and a 1.5 s `controllerchange` wait, called
  from the logo reset in `src/ui/player-controls.ts`), which does not consult the update machine.
  The update machine reads that activation as a passive controller change.
- **Target single owner:** the `sw-register.ts` update machine with one activation sink; the hard
  reset becomes a client of a promotion port and keeps standalone promotion when the port times
  out or is unavailable (until two clean production update cycles).
- **Allowed requesters:** the update dialog (Apply, Later), the logo hard reset, other tabs through
  the prompt lease.
- **Lifecycle operations:** `SKIP_WAITING`, `reg.update()`, the reload, completion markers.
- **Deadline owner:** the update machine (with the Chromium rule that `SKIP_WAITING` waits until
  page loads settle) and `ACTIVATION_TIMEOUT_MS` in `sw-hard-reset.ts`, which must stay below the
  session reset's 2 s commit timeout; that ordering is not written down.
- **Timing-constant home:** `sw-register.ts`, `sw-update-coordination.ts`, `sw-hard-reset.ts`.
  Target: named and exported coupled timings with an ordering test (Phase 0d, C6-1).
- **Anchor tests:**
  - Supersession: `src/core/__tests__/sw-register.test.ts` "drops a stale waiting-worker
    continuation when a newer install replaces it".
  - User pause/stop: `sw-register.test.ts` "does not re-prompt a generation put off with Later in
    the same page".
  - Teardown: `src/core/__tests__/sw-hard-reset.test.ts` "fails open after a bounded wait when
    activation stalls".
  - Visibility: missing.
  - Missing: a hard reset while an Apply is stalled.
- **Status:** `duplicated`. Phase 0d, Phase 3 (one activation owner, then the hard reset asks it;
  each alone). See [Update dialog everywhere](update-dialog-everywhere-2026-10-17.md). Exception
  RO-43.

### RO-23 App-owned page navigation

- **Resource:** the page's own `location.reload`, `location.replace` and `location.href` writes.
- **Current owners/flows:** the session reset in `src/core/session-reset.ts` (first request wins,
  overlay, 2 s commit timeout, its own pagehide, pageshow and visibility listeners);
  `src/core/document-reload.ts` (claim phases, active attempt, FIFO queue), joined to the reset by
  `scheduleDocumentReload`, which reports a reload as recovered when a reset is already pending;
  stacked requester latches in `sw-register.ts`, `src/core/reload-recovery-latch.ts` and the
  back-forward cache retry in `src/core/page-lifecycle.ts`. `scheduleSessionReset` is called
  directly from `app.ts`, `sw-register.ts`, `src/pro-room/runtime.ts`,
  `src/pro-room/setup-flow.ts`, `src/ui/connect.ts`, `src/ui/player-controls.ts`,
  `src/ui/setup.ts` and `src/ui/setup-guest.ts`.
- **Target single owner:** one navigation owner in `src/core/session-reset.ts` with one state
  type, one queue and exactly-once settlement; `document-reload.ts` keeps only the PRO claim fence.
- **Allowed requesters:** the callers above, through the owner; `page-lifecycle.ts` receives
  ownership queries (`isSessionResetPending`, `restoreSessionReset`) from `app.ts`.
- **Lifecycle operations:** schedule a reset or reload, navigate, recover, restore.
- **Deadline owner:** `NAVIGATION_COMMIT_TIMEOUT_MS` (2 s) in `session-reset.ts`.
- **Timing-constant home:** `session-reset.ts` (`NAVIGATION_COMMIT_TIMEOUT_MS`,
  `FALLBACK_DELAY_MS`); next-document `sessionStorage` keys are scattered. Target: named constants
  and keys in `src/core/navigation.ts` (Phase 0d, C6-1).
- **Anchor tests:**
  - Supersession: `src/core/__tests__/session-reset.test.ts` "uses a native timeout fallback and
    accepts only the first reset request"; `src/core/__tests__/document-reload.test.ts` "does not
    let a stale guard release its successor".
  - User pause/stop: n/a.
  - Teardown: `session-reset.test.ts` "recovers a no-op navigation and accepts a later reset
    request".
  - Visibility: `session-reset.test.ts` "cancels a pre-action reset when the returned page only
    becomes visible"; "restores a committed reset when iOS only foregrounds the old document".
  - Missing: a reload requested while a direct reset is pending (dropped, then reported as
    recovered).
- **Status:** `duplicated`. Phase 0d (names), Phase 2 (unload-exemption claims; the navigation
  owner and Back fallback in a train of its own; page transitions in one dispatch).

### RO-24 `inert` page lock

- **Resource:** `inert` (and the paired `aria-hidden`) on the body's direct children, and which
  surface is on top.
- **Current owners/flows:** since 9.0.1 one ledger, `setElementInertForOwner` in
  `src/core/inert-ownership.ts`, used by the modal stack (`src/ui/dom.ts`), mobile chat
  (`src/ui/chat.ts`) and the session reset (inert only). The modal stack no longer locks the reset
  overlay. Element-local writers (`src/player/video.ts`, `src/ui/playlist-removal.ts`,
  `src/ui/setup-shared.ts` and others) lock their own subtrees and are out of scope.
- **Target single owner:** unchanged; Phase 2 keeps the reset surface on top of the modal stack.
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
- **Current owners/flows:** the screensaver entry (`src/ui/screensaver-entry.ts`: entry lock,
  request and exit generations, 1.5 s settlement); the YouTube exit (`src/player/video.ts`,
  `pendingFullscreenExit`); the YouTube toggle (`src/ui/player-controls.ts`: native request, fake
  fullscreen, a 100 ms WebKit check). Prefixed-API resolvers exist in `src/ui/fullscreen.ts`,
  `video.ts` and `player-controls.ts`. Only playback mode separates the owners; read from the
  code (not reproduced), a YouTube toggle tapped while a screensaver exit is in flight issues a
  second exit instead of entering.
- **Target single owner:** `src/core/fullscreen.ts` (moved from `src/ui/fullscreen.ts`) with one
  bounded-exit primitive; callers keep their request policy.
- **Allowed requesters:** the screensaver, the YouTube toggle and mode exit, Back.
- **Lifecycle operations:** request, exit, settle.
- **Deadline owner:** each writer's 1.5 s settlement (request on a managed timer, exit on a native
  timer).
- **Timing-constant home:** `LEGACY_SETTLEMENT_MS` (`screensaver-entry.ts`) and
  `FULLSCREEN_EXIT_SETTLEMENT_MS` (`video.ts`). Target: `FULLSCREEN_SETTLEMENT_MS` in
  `src/core/fullscreen.ts` (Phase 0d, C8-I2).
- **Anchor tests:**
  - Supersession: `src/player/__tests__/video.test.ts` "does not exit an unrelated fullscreen
    element when YouTube mode ends".
  - User pause/stop: `src/ui/__tests__/screensaver.test.ts` "requests fullscreen immediately and
    exits only the state it acquired".
  - Teardown: `video.test.ts` "exits native fullscreen before parking the YouTube wrapper".
  - Visibility: `src/ui/__tests__/screensaver-entry-back.test.ts` "releases the pending surface on
    pagehide and ignores late completion".
  - Missing: a YouTube toggle during an in-flight screensaver exit.
- **Status:** `duplicated`. Phase 0d (shared helper and constants), Phase 2 (one prefixed reader,
  one bounded exit). See [Screensaver integration](screensaver-integration-2026-10-16.md).
  Exception RO-38.

### RO-27 Playlist rows and scroll position

- **Resource:** the `#playlist-ui` row DOM and the `.tab-body` scroll position.
- **Current owners/flows:** reorder (`src/ui/playlist-reorder.ts`: drag, keyboard, settling, FLIP,
  edge auto-scroll); removal (`src/ui/playlist-removal.ts` with
  `src/ui/playlist-selection-morph.ts`: selection, exit layer, glide); the selection-gesture
  auto-scroll (`src/ui/playlist-selection-gestures.ts`, which says it mirrors the reorder edge
  scroll); follow and current-jump; the custom scrollbar drag; the render's scroll restore.
  `src/ui/playlist-view.ts` orchestrates by polling the controllers and pairing their cancels.
- **Target single owner:** one interaction gate in `playlist-view.ts` with a shared lazy motion
  module (planned `src/ui/playlist-motion.ts`); controllers keep their gesture-private state.
- **Allowed requesters:** the controllers above, through the gate.
- **Lifecycle operations:** move rows, animate, scroll, defer or force a render, cancel.
- **Deadline owner:** each controller's settle and glide timing.
- **Timing-constant home:** edge auto-scroll constants copied in `playlist-reorder.ts` and
  `playlist-selection-gestures.ts`; the row easing in three places; `prefersReducedMotion` twice.
  Target: `src/ui/playlist-motion.ts` (Phase 2).
- **Anchor tests:**
  - Supersession: `src/ui/__tests__/playlist-view.test.ts` "keeps an active PRO reorder mounted
    through revision-only context pulses".
  - User pause/stop: `src/ui/__tests__/playlist-reorder.test.ts` "cancels an active drag on Escape
    without changing order".
  - Teardown: `playlist-view.test.ts` "cancels a PRO deletion task on authority loss or
    room-incarnation replacement".
  - Visibility: missing.
  - Missing: Delete tapped during a reorder drop settle.
- **Status:** `duplicated`. Phase 2 (motion module, interaction gate, the delete-during-settle
  decision).

### RO-28 Account session reads and refresh pulses

- **Resource:** the account session snapshot read from the cookie into `state.ts`, and the
  cross-tab refresh pulses (BroadcastChannel `mxqr-account-v1`, storage key
  `mxqr-account-refresh`).
- **Current owners/flows:** `src/account/session.ts` (generations, in-flight reads, recovery,
  login-result promises; sole snapshot writer) and `src/ui/account.ts` (popup attempt, a 250 ms
  close monitor, its own pulse receiver, parser and seen-id set). Other documents carry their own
  copies: the producer in `browser/classic-runtime/account-complete.ts` and a third consumer in
  `browser/classic-runtime/events/event.ts`. A shared promise per login nonce and a generation
  fence make the reads converge.
- **Target single owner:** `src/account/session.ts` as the single pulse receiver, with a shared
  wire-contract module (planned `src/account/account-sync-protocol.ts`) pinned against the classic
  runtimes by a contract test.
- **Allowed requesters:** the account UI and the popup monitor; focus, visibility and online
  triggers inside the owner.
- **Lifecycle operations:** read, refresh, reconcile a login, sign out, delete.
- **Deadline owner:** the session owner's recovery tail; the popup monitors.
- **Timing-constant home:** channel and key literals in four files; `ACCOUNT_LOGIN_POPUP_POLL_MS`
  (`account.ts`) and a 250 ms copy in `event.ts`. Target: the wire-contract module (Phase 0d,
  C8-I1).
- **Anchor tests:**
  - Supersession: `src/account/__tests__/session.test.ts` "reconciles the exact popup session and
    fences an older account read".
  - User pause/stop: `session.test.ts` "does not let later external refresh pulses starve an
    explicit Retry".
  - Teardown: `session.test.ts` "keeps the aggregate-write fence outside the public account
    profile and clears it on logout".
  - Visibility: `session.test.ts` "defers background recovery until the page becomes visible".
  - Missing: a cross-document contract test.
- **Status:** `duplicated`. Phase 0d (wire contract), Phase 2 (one parser, single receiver
  including the events page copy).

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
  (`runtime.ts`). The same `[1_000, 2_000, 4_000, 8_000, 15_000]` is `RECONNECT_BACKOFF_MS` in
  `src/network/peer.ts`; Phase 0d decides whether that is one contract.
- **Anchor tests:**
  - Supersession: `src/pro-room/__tests__/heartbeat-single-flight.test.ts` "guarantees a fresh
    reconciliation after an epoch event races an old heartbeat".
  - User pause/stop: n/a.
  - Teardown: `heartbeat-single-flight.test.ts` "does not let a reset flight enqueue work into the
    next room lifecycle".
  - Visibility: missing (the slot's clear and re-arm on visibility, and recovery holding the slot).
- **Status:** `owner-in-place`. Phase 0d (copy triage only).

### RO-30 Back-button history entries

- **Resource:** this page's guard entries in browser history.
- **Current owners/flows:** the guard controller `src/core/back-button-guard.ts` (epoch, frame,
  leaving, suspended) and its helper `src/core/back-button-history.ts` (leave attempt with a 1 s
  fallback), wired in `app.ts`; each has a popstate listener. The controller is the owner per
  [Back closes the top window](back-closes-top-window-2026-10-17.md).
- **Target single owner:** unchanged (`back-button-guard.ts`).
- **Allowed requesters:** windows registered for Back; the hard navigation home belongs to RO-23.
- **Lifecycle operations:** push or replace a guard, `history.back()`, leave attempt, suspend and
  resume.
- **Deadline owner:** `LEAVE_FALLBACK_MS` (1 s, `back-button-history.ts`), which fires before the
  session reset's 2 s commit timeout; the ordering is not written down (Phase 0d).
- **Timing-constant home:** `back-button-history.ts`.
- **Anchor tests:**
  - Supersession: `src/core/__tests__/back-button-guard.test.ts` "a newly starting surface cancels
    old frames and waits for the newer close".
  - User pause/stop: `back-button-guard.test.ts` "Back on the confirmation means Stay and the next
    Back can ask again".
  - Teardown: `back-button-guard.test.ts` "does not compete with an update or terminal reset".
  - Visibility: `back-button-guard.test.ts` "cancels a hidden document and resumes only while still
    needing a guard".
- **Status:** `owner-in-place`. Phase 2: re-arming the guard after a pending reset recovers is an
  owner decision because it reverses part of the 2026-10-17 Back decision.

## Accepted exceptions

Each record below keeps a duplicate, drops a planned step or defers one, with its evidence. Where
behaviour risk remains it says whether a [known-accepted](../known-accepted.md) entry exists; a new
entry needs the owner's acceptance and is not implied by this registry.

### RO-31 Presence delivery does not re-arm the playback outbox

- **Parent:** RO-07. Plan step C7-5 dropped.
- **Exception:** a delivered presence snapshot does not make a backing-off playback head due at
  once.
- **Evidence:** a PREPARE cannot wait out a long backoff: `PLAYBACK_TRANSITION_DEADLINE_MS` (3 s)
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

### RO-35 Side-route outage deadline stays in control isolation

- **Parent:** RO-15. Plan step C5-9 deferred.
- **Exception:** `control-isolation.ts` keeps its own side-route outage deadline and 15 s and 30 s
  constants (derived from the shared grace after Phase 0d).
- **Evidence:** the side route's ICE restart is still under
  [known-accepted #18](../known-accepted.md), awaiting the owner's real-device Wi-Fi to LTE check;
  the same timer also governs active routes to peers without restart capability.
- **Behaviour risk:** known-accepted #18.
- **Revisit when:** #18 retires.
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

### RO-38 Separate screensaver and YouTube fullscreen exit state

- **Parent:** RO-26. Plan steps C8-I9 and C8-I13 deferred.
- **Exception:** after Phase 2's shared bounded exit, the screensaver and YouTube still keep
  separate in-flight state instead of one slot.
- **Evidence:** a shared slot only matters for a behaviour the owner has not chosen: what a YouTube
  fullscreen tap does while a screensaver exit is in flight.
- **Behaviour risk:** that tap is lost (the duplicate exits settle harmlessly); no known-accepted
  entry until the owner decides.
- **Revisit when:** the owner chooses that behaviour.
- **Status:** `accepted-exception`.

### RO-39 Two Cloudflare Realtime control clients

- **Parent:** RO-04 and RO-20. Plan step C4-11 deferred.
- **Exception:** the Realtime control calls (request, response check, track close) stay copied in
  `src/network/system-audio-sfu.ts` and `src/network/pro-system-audio-sfu.ts`.
- **Evidence:** the copies sit in different lazy chunks, and a shared module could become a new
  shared chunk on cellular joins; the name builders and error-text fallbacks differ, and the
  Standard SFU branches on error text.
- **Behaviour risk:** none (no shared state).
- **Revisit when:** a scratch build shows the chunk impact, then in the Phase 5 train or later.
- **Status:** `accepted-exception`.

### RO-40 Hand-copied PRO publication teardown blocks

- **Parent:** RO-20. Plan step C4-12 deferred.
- **Exception:** `system-audio-service.ts` keeps five hand-copied publication teardown blocks.
- **Evidence:** grouping them is a behaviour-neutral refactor that only names today's
  compositions; it is optional and rides a later train.
- **Behaviour risk:** copy drift between the blocks.
- **Revisit when:** Phase 5 or a later system-audio train.
- **Status:** `accepted-exception`.

### RO-41 Two PRO re-apply owners serialized, not deduplicated

- **Parent:** RO-21. Plan step C4-13 deferred.
- **Exception:** foreground recovery and the post-share restore stay separate reconcile owners.
- **Evidence:** deduplication changes behaviour and needs an owner decision; the inferred second
  iframe pause after a share ends while hidden is not reproduced yet (Phase 0c).
- **Behaviour risk:** a possible second pause of the YouTube iframe on return (inferred); no
  known-accepted entry.
- **Revisit when:** the Phase 0c test reproduces the second re-arm.
- **Status:** `accepted-exception`.

### RO-42 PRO-only capture policy stays eager

- **Parent:** RO-20. Plan step C4-14 deferred.
- **Exception:** PRO lease toasts, the share-limit timer sync and lease-failure refresh stay in the
  eager `src/audio/system-capture.ts`.
- **Evidence:** `getDisplayMedia` and `beginProLeaseAttempt` must stay in one user-gesture turn;
  the eager saving is unmeasured.
- **Behaviour risk:** none.
- **Revisit when:** a scratch build shows a meaningful eager saving.
- **Status:** `accepted-exception`.

### RO-43 Update prompt stays eager

- **Parent:** RO-22. Plan step C6-15 deferred.
- **Exception:** the waiting-worker prompt in `sw-register.ts` stays in the initial bundle.
- **Evidence:** loading it after a controller change risks the old-chunk criterion of the PWA
  update QA domain and touches the 2026-10-17 "same dialog everywhere" decision; the saving is
  unmeasured.
- **Behaviour risk:** none.
- **Revisit when:** a measured build and an owner decision.
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

## Checked side flows without a record

The survey also checked these and found one owner with a side flow (WEAK) or a single owner. They
get a record only if a change adds a second machine:

- Signaling socket reconnect (`src/network/peer.ts` outer loop, pre-admission retry in
  `cloudflare-signaling.ts`), partitioned by admission.
- Transport RTC configuration (TURN): three writers, last write wins; the pre-admission retry
  passes no expiry (self-healing).
- Seek slider drag (`src/ui/range-drag.ts` and `src/ui/seekbar.ts`): `cancelSeekGesture` does not
  call `cancelRangeDrag`; a fix-lane candidate only with a failing test.
- Guest join attempt (`src/network/guest.ts`): an old inline cancel in `src/ui/setup-guest.ts`
  skips `invalidateGuestJoinAttempt`; a fix-lane candidate only with a failing test.
- Header loader `_default` key (`src/ui/toast.ts`): about a dozen writers without an owner token,
  serialized in practice by playback mode; Phase 2 assigns owners.
- Return-from-background dialog: the long-background warning yields to the audio recovery prompt
  (`app.ts`), per [Resume dialog dedup](resume-dialog-dedup-2026-10-17.md).
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
   children (RO-24), aria-hidden writes in page-lock files, Fullscreen request and exit methods
   (RO-26), history entry writes (RO-30), navigation through `location` (RO-23) and
   `SKIP_WAITING` sends (RO-22).
3. **Worker callers, per function:** the `/internal/realtime/v1/broadcast` endpoint anywhere in
   production code (RO-07) and `readProRoomFileDuration` in `cloudflare/` (RO-08; the app's
   local-file parse in `src/pro-room/upload-duration.ts` is outside that resource).
4. **One deadline owner per PRO SFU attempt** (RO-04, principle 2): the subscriber retry maximum
   stays below the guest receive watchdog, or the PRO SFU reception start passes
   `receiveWatchdog: false`. Armed `beginTrustedSystemAudioReception` starts (any use without the
   literal `{ receiveWatchdog: false }`) are an exact list per function.
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

Not checked yet: callers of the other records' lifecycle operations (YouTube player commands,
`claimPlaybackOwner`, `setSystemAudioReceiving`, `scheduleSessionReset`), receivers resolved by
type (RO-44), module-level lifecycle slots (RO-45), timer-name manifests, shared phase unions,
duplicated helper names, "mirrors" copy-marker comments, and registered timings retyped as
literals in requester files (the 15 s data-connection grace in `heartbeat-monitor.ts`). Until
then, review those by hand against each record.

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
