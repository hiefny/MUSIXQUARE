# AppState Decomposition (Phase 5)

> Companion to [state-patterns.md](state-patterns.md). That document defines the read/write contract for playback state. This one records the migration from the old flat `appState` enum to the two-axis model (`mode` x `activity`).
>
> **Status note (2026-07-11):** the migration is complete. Sections describing
> sub-phases, estimates, rollback commits, and the old enum are historical
> implementation context, not an active rollout plan. Current callers must
> follow `state-patterns.md` and the executable contract tests.

## Status

- 5a (adapter): **DONE**. `getPlaybackOwnership()` returns derived `mode` and `activity`, and production readers now consume the narrower mode/activity helper surface where their question matches that contract.
- 5b (dual write): **DONE**. `state.playback.mode/activity` were introduced as shadow slots and are now the primary playback state.
- 5c (reader migration): **DONE for raw readers**. Production code no longer reads or writes the old `state.appState` slot, and no production caller reads the full legacy enum projection. The remaining strict-IDLE compatibility sites use `isPlaybackIdleCompat()` and are pinned by test.
- 5d (wire protocol compat): **DONE**. `SYNC_PONG` now carries mode/activity only; legacy `appState` emit/accept paths and their feature flags have been removed.
- 5e (system-capture snapshot): **DONE**. Capture restore snapshots use `playback.mode/activity`; pending file work is intentionally not revived after capture stops.
- 5f (source-of-truth flip): **DONE**. Ownership writes `playback.mode/activity` first; the temporary compatibility shadow was removed afterward.
- 5g (`state.appState` removal): **DONE**. The global state tree no longer stores `appState`, and the old full enum projection helpers have been deleted. The only remaining legacy behavior is the narrow `isPlaybackIdleCompat()` predicate.

## Motivation

Historically `src/core/constants.ts` exposed this enum:

```ts
export const APP_STATE = {
  IDLE: 'IDLE',
  PAUSED: 'PAUSED',
  PLAYING_AUDIO: 'PLAYING_AUDIO',
  PLAYING_YOUTUBE: 'PLAYING_YOUTUBE',
  PLAYING_SYSTEM_AUDIO: 'PLAYING_SYSTEM_AUDIO',
} as const;
```

Those five values overloaded two orthogonal axes:

| former value | mode | activity |
| --- | --- | --- |
| `IDLE` | null | idle |
| `PAUSED` | file (legacy assumption) | paused |
| `PLAYING_AUDIO` | file | playing |
| `PLAYING_YOUTUBE` | youtube | playing |
| `PLAYING_SYSTEM_AUDIO` | system-audio | playing |

Three concrete problems caused by the overload:

1. **No "youtube paused" representation in the state tree.** YouTube's paused state lives inside the iframe player instance (`player.getPlayerState()`). Code that needs to know "is YouTube currently paused" reads async iframe state and is race-prone. The state tree cannot answer the question.

2. **No "system-audio paused" representation.** "Pause" for system audio means "stop sharing". A future mode such as recorded podcast or prerecorded stream would want a real paused state. The former enum could not accommodate it without a new top-level value per mode.

3. **"Pending" is encoded in three different places.** `player.currentTrackMeta.systemAudioPlaceholder`, `systemAudio.isReceiving`, and `playback.lifecycle === DOWNLOADING/AWAITING_PRELOAD`. Phase 5a unified the read side via `activity: 'pending'`, but the state tree itself still scatters the original signals.

## Resulting Shape

Phase 5b added the new source slots without moving the existing `player.*`
fields.

```ts
state.playback = {
  mode: 'file' | 'youtube' | 'system-audio' | null,
  activity: 'idle' | 'paused' | 'playing' | 'pending',

  // unchanged
  lifecycle: PlaybackStateValue,
  loadSource: LoadSourceValue | null,
  pendingPlayTime: number | undefined,
  pendingPlayTimeSetAt: number,
  pendingRecoveryTarget: { index: number; name: string } | null,
  // ...
}

state.player = {
  // unchanged
  currentTrackMeta: TrackMeta | null,
  startedAt: number,
  pausedAt: number,
  // ...
}
```

Long-term, it may be useful to describe all playback-facing fields under one logical "playback domain", but this migration should not move `player.*` fields. Moving those fields would be a separate storage/API migration with no direct payoff for the `appState` split.

The old `state.appState` slot is gone. Code now reads `playback.mode/activity` directly, with `isPlaybackIdleCompat()` reserved for historical strict-IDLE checks.

`PLAYBACK_STATE` stays untouched. It is the file-pipeline FSM and orthogonal to mode/activity.

## Migration Principle

**Dual-write before cutover, then remove the legacy slot.**

1. New slots were added and written as a side effect of existing writes.
2. Readers migrated one domain at a time. Production readers use mode/activity helpers; strict old-IDLE holdouts use `isPlaybackIdleCompat()`.
3. Wire protocol carries mode/activity only.
4. Source-of-truth flipped only after production readers were on the new slots.
5. Legacy `state.appState` was removed last; full enum projection helpers were deleted, while production holdouts use the narrower strict-IDLE predicate.

## Concrete Survey of Today's State

Refresh this survey before each new sub-phase with:

```powershell
rg -n "appState|claimPlaybackOwner|releasePlaybackOwner|isPlaybackIdleCompat" src
```

**Writers**: no direct `state.appState` writes remain.

- `ownership.ts::claimPlaybackOwner` writes `playback.mode/activity`.
- `ownership.ts::releasePlaybackOwner` clears playback to `{ mode: null, activity: 'idle' }` after the matching owner releases or a forced release runs.
- New semantic writers (`setPlaybackIdle`, `setPlaybackFilePlaying`, `setPlaybackFilePaused`, `setPlaybackYouTubePlaying`, `setPlaybackSystemAudioPlaying`) are the preferred write API for non-protocol callers.

This single-writer position was the entire reason Phase 5 was feasible. Before the Phase 1-4 work, this number was much higher.

**Wire protocol and cross-version compatibility**:

- `src/network/sync.ts::handleSyncPing` - `SYNC_PONG` payloads include `mode` and `activity`; legacy `appState` is no longer emitted.
- `src/network/sync.ts::isSyncPongPlayingFile` - guest reads `mode/activity` and rejects legacy-only `appState` payloads.
- `src/network/sync.ts` local replay/initial-sync arm gates use `playback.mode/activity`.
- `SYNC_PING` does not carry playback state and should remain unchanged unless a separate protocol need appears.

**Important readers and intentional legacy holdouts**:

- `src/player/ownership.ts` - the central ownership and mode/activity helper surface; it also owns the narrow strict-IDLE compatibility predicate.
- `src/player/transport.ts` - writes playback through semantic mode/activity helpers; its stop/pause guards preserve old IDLE semantics through `isPlaybackIdleCompat()`.
- `src/player/media-session.ts` - OS media button command handlers and OS `playbackState` display use playback mode/activity; YouTube still delegates play/pause to iframe state because the former flat enum did not represent YouTube pause.
- `src/player/playlist.ts` - historical idle checks guard async decode races where compatibility `IDLE` is the intended signal, but read it through `isPlaybackIdleCompat()`.
- `src/youtube/sync.ts` - guest sync/rendezvous guards use playback mode; pause/play still comes from iframe player state, not the former flat enum's paused value.
- `src/youtube/player.ts` - late-join/stop-mode YouTube-mode guards use playback mode; queue/indexing idle checks still use strict compatibility `IDLE` via `isPlaybackIdleCompat()`.
- `src/youtube/iframe.ts` - iframe create/ready/state/UI guards use playback mode, with indexing exceptions and `IDLE` fallback writes kept unchanged.
- `src/player/video.ts` - media-engine mode changes now gate from playback activity and write through semantic playback helpers; body-class rendering subscribes to `state:playback.mode`.
- `src/chat/commands.ts` - debug/status output now reports playback mode/activity directly.

**Mode/activity snapshots**:

- `src/audio/system-capture.ts::_preSysAudioState.playback` - stores mode/activity for restore-on-stop.
- `src/audio/system-capture.ts::restorePreSystemAudioPlaybackState` - restores YouTube through the room command path, maps prior file/system active playback to the existing paused fallback, and intentionally leaves pending work idle after capture stops.

**Initial state and types**:

- `src/core/state.ts` - no longer initializes `appState`; playback starts from `playback.mode = null` and `playback.activity = 'idle'`.
- `src/types/index.ts` - `StateTree.appState`, mapped `state:appState` events, and `SYNC_PONG.appState` are removed.

Do not treat this list as a mandate to remove every legacy reference. The remaining references are deliberately strict legacy command gates.
`src/player/__tests__/playback-state-contract.test.ts` bans raw production slot/event access and pins full legacy enum projection consumers to zero, so new legacy reads cannot appear unnoticed.

## Historical Sub-Phase Plan

### 5b - Dual Write (1 day)

Add `state.playback.mode` and `state.playback.activity` to the state tree, defaulting to `null` and `'idle'`. During the migration, ownership claim/release, track metadata writes, and the then-temporary compatibility setter wrote the new slots alongside the existing legacy state writes. `setPlaybackTrackMeta` is included because the system-audio guest placeholder can establish pending ownership before the stream arrives.

Wire `state:playback.mode` and `state:playback.activity` bus events. The old `state:appState` event was removed in 5g.

**Invariant during migration**: ownership helpers kept the new slots synchronized with the broad ownership view. The DEV assertion lived in ownership helpers rather than `core/state.ts` to avoid a core-to-player dependency.

**Verification gate**:

- Existing tests continue to pass.
- Add tests that toggle each transition path and assert `(mode, activity)` is consistent.

**Reversible by**: revert single commit. No callers depend on the new slots.

### 5c - Reader Migration (3-5 days, multiple commits)

Order, lowest-risk first:

0. **Mode/activity sync hardening (0.5 day)**
   - Keep `state.playback.mode/activity` synchronized from every source signal that contributes to `getPlaybackOwnership()`: `playback.lifecycle`, `transfer.state`, `player.currentTrackMeta`, and `systemAudio.isReceiving`.
   - Production writers for `playback.lifecycle`, `transfer.state`, and `systemAudio.isReceiving` now go through ownership helper functions that sync the primary slots immediately; the bus bridge remains a compatibility backstop.
   - This landed before production readers trusted the new slots. File pending and system-audio pending were never purely appState-derived.

1. **New mode/activity helper surface (0.5 day)**
   - Add helpers whose names match the new contract, for example `isPlaybackModeYouTube()`, `isPlaybackPlayingFile()`, `isPlaybackPaused()`, and `getPlaybackModeActivitySnapshot()`.
   - The strict `isAppState*()` helper surface has been removed. Remaining strict-IDLE consumers use `isPlaybackIdleCompat()` so their compatibility dependency is explicit without reintroducing enum reads.

2. **UI consumers (1 day)**
   - Migrate display logic that asks a mode/activity question to the new helper surface.
   - `src/player/video.ts::updateBodyModeClass` is already migrated to `state:playback.mode`.
   - `src/player/media-session.ts` OS `playbackState` display and media button command handlers are migrated to playback mode/activity, while YouTube play/pause still delegates to the iframe's own state.
   - `src/ui/_state-hooks.ts` exposes mode/activity subscriptions; `src/ui/player-controls.ts` uses them for tab-title marquee, play-icon/media-source rendering, and YouTube play-state refinements.
   - `src/ui/visualizer.ts` uses playback activity for pause/playing/idle rendering, while its draw loop skips YouTube through playback mode.
   - `src/ui/seekbar.ts` uses playback mode/activity for seek availability, system-audio zero display, and file rAF interpolation gates.
   - `src/ui/settings.ts` uses playback mode for system-audio channel/effects UI gates.
   - `src/ui/tabs.ts` and `src/ui/setup.ts` use playback mode helpers for YouTube display/cleanup gates.
   - `src/player/video.ts` uses playback activity for media-engine mode transition gating.
   - `src/youtube/sync.ts` uses playback mode for guest sync, manual rendezvous, and stop-frame guards while leaving iframe pause/play semantics untouched.
   - `src/youtube/player.ts` uses playback mode for late-join bootstrap and stop-mode guards; its queue/indexing idle checks still use the compatibility IDLE value through `isPlaybackIdleCompat()`.
   - `src/youtube/iframe.ts` uses playback mode for iframe create/ready/state/update guards; indexing exceptions and guest-ended IDLE fallback writes stay legacy by design.
   - `src/ui/playlist-view.ts` uses playback mode/activity as its playback-state refresh trigger instead of `state:appState`.
   - Leave protocol, snapshot, and compatibility bridge code on explicit compatibility helpers until their dedicated phases.

3. **`is*Owner()` helpers (0.5 day)**
   - Re-point to compute from `(mode, activity)` plus the surviving signals (file lifecycle, system-audio placeholder/receiving).
   - Done with a transitional freshness boundary: public owner predicates read mode/activity, but first reconcile stored slots against `getPlaybackOwnership()` when lifecycle/bootstrap paths leave them stale.
   - Remove that reconciliation only after lifecycle, transfer, metadata, and system-audio source signals are no longer allowed to mutate outside ownership helpers.

4. **Playback domain (1 day)**
   - `src/player/transport.ts` writes playback through semantic mode/activity helpers and no longer exports the old `setAppState()` adapter.
   - First pass done for YouTube mode questions in `playlist.ts`, `playback.ts`, and the silent YouTube handoff in `transport.ts`.
   - `src/player/playlist.ts` historical idle guards still use strict compatibility IDLE semantics for async decode races, but read through `isPlaybackIdleCompat()`.
   - `src/player/playback.ts` uses playback-playing file helpers for seek/restart paths that only apply to active local file playback.
   - `src/player/playback.ts` late-join bootstrap reads playback mode/activity directly; file `PLAY`/`PAUSE` bootstrap messages no longer include the legacy `state` payload.
   - `PlaybackOwnership.appState` has been removed; production callers use `ownership.mode/activity` or narrower compatibility predicates.

5. **Network/protocol gating (1 day)**
   - `src/storage/transfer-receive.ts`, `src/network/system-audio-guest.ts`, and `system-audio-sfu.ts`. These are mostly on `is*Owner()` predicates after earlier phases; flip implementation underneath them only after tests cover the pending/placeholder windows.
   - First pass done for YouTube/system-audio owner gates in transfer receive, recovery, and system-audio cleanup paths.

6. **Body-class sync (0.5 day)**
   - `src/player/video.ts::updateBodyModeClass` is done: it subscribes to `state:playback.mode` instead of `state:appState`.

7. **Audio graph mutation gates (0.5 day)**
   - `src/audio/channel.ts` is done: surround routing refreshes active playback through playback mode/activity helpers instead of legacy appState checks.

8. **Bootstrap/background gates (0.5 day)**
   - `src/app.ts` is done for keyboard play/stop gating and long-background recovery decisions that ask whether playback is currently file, YouTube, or idle.

Each sub-step lands as its own commit. Tests must pass after each. Invariant assertion from 5b stays on.

### 5d - Wire Protocol Compat (2 days work + release-cycle waits)

`network/sync.ts` was the only network surface that carried `appState`. The protocol is between this app's host and guest instances on potentially different versions.

**Step 5d-1: dual emit. DONE.** Host sent both `appState` (legacy) and `mode` + `activity` in `SYNC_PONG` payloads. Guest accepted either, preferring the new fields when present. `SYNC_PING` remains unchanged.

**Step 5d-2: wait two production releases. SKIPPED BY WORKTREE DECISION.** The worktree intentionally cut over without a production release gap.

**Step 5d-3: drop the legacy emit. DONE.** Host no longer sends `appState`.

**Step 5d-4: drop the legacy accept path. DONE.** Guests no longer accept legacy-only `appState`.

The original two-release wait between 5d-1 and 5d-3 protected cross-version sessions. This worktree intentionally removed the compatibility path; rollback is now a normal commit revert, not an env switch.

### 5e - System-Capture Snapshot (0.5 day)

DONE. `src/audio/system-capture.ts` snapshots mode/activity for restore-on-stop:

```ts
const playback = getPlaybackModeActivitySnapshot();
_preSysAudioState = {
  playback,
  // ... rest of snapshot unchanged
};
```

Restore path keeps the previous UX contract: YouTube returns through the room-wide YouTube command path, file/system active playback returns to the existing paused fallback, idle stays idle, and pending file work is not revived after capture stops. Snapshot is in-memory only, so no stored-data migration. Covered by `src/audio/__tests__/system-capture.test.ts`.

The Phase 3 doctrine still holds: this snapshot captures "what was playing before capture started", not "what is playing now". The migration preserves that semantic; only the field names change.

### 5f - Source-of-Truth Flip (0.5 day)

DONE. `playback.mode/activity` became the write source of truth:

- `ownership.ts` writes `mode` and `activity` directly.
- Lifecycle-derived pending states keep their semantic priority, so file `DOWNLOADING` / `READY` / `FAILED` do not collapse into `paused`.
- The temporary rollback flag has been removed; the flip is now the only write path.

5g later removed the stored legacy shadow and full enum projection helpers entirely.

### 5g - `appState` Removal

DONE. `state.appState` has been dropped from the state tree, and `APP_STATE` / `AppStateValue` have been removed from `core/constants.ts`.

The old full enum projection helpers and compatibility setter have also been deleted. Production code either reads `playback.mode/activity` or, for the few deliberately strict idle checks, calls `isPlaybackIdleCompat()`.

## Risk Register

| Risk | Likelihood | Severity | Mitigation |
| --- | --- | --- | --- |
| Wire protocol break (host new, guest old) | Medium after cutover | High | This worktree intentionally removed legacy SYNC_PONG compatibility. Revert the 5d cleanup commit if cross-version sessions matter again. |
| Drift between broad ownership and stored `(mode, activity)` | Low | Medium | Ownership helpers sync the slots from lifecycle, transfer, metadata, and system-audio source events; tests cover the transition paths. |
| `system-capture` restore picks wrong mode after 5e | Low | Medium | Explicit restore matrix for file/youtube/system-audio x playing/paused/idle. |
| UI displays stale during mid-migration commit | Low | Low | Per-commit test gate. Body-class sync lands in a single commit. |
| External tooling/log analytics that grep `appState` from console logs | Low | Low | Runtime code reports mode/activity now; stale tooling should migrate to those fields. |

## Verification Gates (Every Sub-Phase)

- `npm run typecheck` returns clean.
- `npm test` all green.
- `npm run lint` returns clean.
- `npm run build` succeeds.
- Manual cross-version smoke: host on previous version with guest on new version, and host on new version with guest on previous version. Critical for 5d.
- No production code may call `getState('appState')`, `setState('appState')`, subscribe to `state:appState`, or reintroduce full legacy enum projection helpers; this is pinned by `playback-state-contract.test.ts`.

## Historical Migration Rollback Strategy

| Sub-phase | Rollback |
| --- | --- |
| 5b | Revert single commit. New slots become orphaned but unused. |
| 5c | Per-domain revert. Each sub-step is one commit. |
| 5d-1 | Revert; host returns to legacy-only emit. Guest still accepts legacy. |
| 5d-3 | Revert the legacy emit removal commit. |
| 5d-4 | Revert the legacy accept removal commit. |
| 5e | Revert snapshot shape change. |
| 5f | Revert the source-of-truth flip commit. |
| 5g | Restore `state.appState` in `StateTree` and `createInitialState()`, then reintroduce the old ownership bridge. |

The temporary feature flag module has been removed because no migration flags remain.

## Resolved Questions And Follow-ups

1. **Mode identity after release — resolved.**
   Releasing playback clears the source of truth to
   `{ mode: null, activity: 'idle' }`. Any future "last mode" UI must keep a
   separate presentation value rather than weakening the ownership contract.

2. **Should `activity: 'pending'` be split into kinds?**
   Currently derived for both file lifecycle (`DOWNLOADING`/`AWAITING_PRELOAD`) and system-audio placeholder receive. If UX justifies it, this could split into `loading`, `buffering`, or `connecting`. YAGNI for the migration itself; revisit only if a real UX need surfaces.

3. **Remaining legacy idle semantic**
   `isPlaybackIdleCompat()` intentionally preserves the old strict `IDLE` behavior for queue/indexing race guards. It is not a general playback-state API; new code should ask mode/activity questions directly.

4. **What about future modes (podcast, voice-chat)?**
   Decomposition unblocks them, but does not implement them. Each new mode would add one value to `PlaybackMode` and write claim/release semantics in `ownership.ts`. No state-tree changes should be required after Phase 5.

## Original Effort Estimate

| Sub-phase | Active dev | Calendar wait |
| --- | --- | --- |
| 5b | 1 day | none |
| 5c | 3-5 days (across commits) | none |
| 5d-1 | done | none |
| 5d-3 | done | none |
| 5d-4 | done | none |
| 5e | 0.5 day | none |
| 5f | done | none |
| 5g | 0.5 day (optional) | none |

**Total**: 7-9 days active dev originally estimated; release-cadence waits were bypassed in this worktree.

## Anti-Goals

This document does not cover:

- `playback.lifecycle` FSM redesign. That is a separate axis (file-pipeline micro-states) and out of scope.
- `transfer.state` FSM redesign. Same.
- New playback modes (podcast streaming, file recording, etc.). Those become easy after Phase 5 lands, but their design lives elsewhere.
- UI redesign. Display logic stays as-is; only the source slot names change underneath.
- Wire protocol breaking changes beyond the removed `SYNC_PONG.appState` field. `SYNC_PING` remains unchanged.
- Moving `player.currentTrackMeta`, `player.startedAt`, or `player.pausedAt` into `playback`. That would be a separate state-tree layout migration.

## When to Start

Phase 5 is complete. Reasonable triggers for future follow-up work:

- A new mode (podcast, etc.) is proposed and needs the two-axis model.
- A bug report surfaces where "YouTube paused" semantic gap is the root cause.
- A follow-up can remove the remaining narrow legacy-idle compatibility gate.

Until then, keep new playback code on mode/activity helpers and avoid broadening the legacy idle predicate.
