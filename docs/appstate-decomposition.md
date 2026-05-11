# AppState Decomposition (Phase 5)

> Companion to [state-patterns.md](state-patterns.md). That document defines the read/write contract for the current flat `appState` enum. This one is the migration plan for replacing that enum with a two-axis model (`mode` x `activity`).

## Status

- 5a (adapter): **DONE**. `getPlaybackOwnership()` returns derived `mode` and `activity`, and production readers now consume the narrower mode/activity helper surface where their question matches that contract.
- 5b (dual write): **DONE**. `state.playback.mode/activity` exist as shadow slots and are kept in sync by ownership write helpers.
- 5c (reader migration): **IN PROGRESS**. UI display readers, media-session, sync replay gates, YouTube runtime guards, and several audio/system-capture readers have landed; central transport/playback compatibility readers remain on legacy predicates by design.
- 5d (wire protocol compat): **IN PROGRESS**. 5d-1 dual emit/accept has landed; release-cycle waits and legacy field removal remain proposed/gated.
- 5e (system-capture snapshot): **DONE**. Capture restore snapshots use `playback.mode/activity`; pending file work is intentionally not revived after capture stops.

## Motivation

`src/core/constants.ts:6` defines the current enum:

```ts
export const APP_STATE = {
  IDLE: 'IDLE',
  PAUSED: 'PAUSED',
  PLAYING_AUDIO: 'PLAYING_AUDIO',
  PLAYING_YOUTUBE: 'PLAYING_YOUTUBE',
  PLAYING_SYSTEM_AUDIO: 'PLAYING_SYSTEM_AUDIO',
} as const;
```

Five values overload two orthogonal axes:

| current value | mode | activity |
| --- | --- | --- |
| `IDLE` | null | idle |
| `PAUSED` | file (legacy assumption) | paused |
| `PLAYING_AUDIO` | file | playing |
| `PLAYING_YOUTUBE` | youtube | playing |
| `PLAYING_SYSTEM_AUDIO` | system-audio | playing |

Three concrete problems caused by the overload:

1. **No "youtube paused" representation in the state tree.** YouTube's paused state lives inside the iframe player instance (`player.getPlayerState()`). Code that needs to know "is YouTube currently paused" reads async iframe state and is race-prone. The state tree cannot answer the question.

2. **No "system-audio paused" representation.** "Pause" for system audio currently means "stop sharing". A future mode such as recorded podcast or prerecorded stream would want a real paused state. The current enum cannot accommodate it without a new top-level value per mode.

3. **"Pending" is encoded in three different places.** `player.currentTrackMeta.systemAudioPlaceholder`, `systemAudio.isReceiving`, and `playback.lifecycle === DOWNLOADING/AWAITING_PRELOAD`. Phase 5a unified the read side via `activity: 'pending'`, but the state tree itself still scatters the original signals.

## Target Shape

5b should add only the new source slots to the current state tree. Existing `player.*` fields stay put.

```ts
state.playback = {
  mode: 'file' | 'youtube' | 'system-audio' | null,
  activity: 'idle' | 'paused' | 'playing' | 'pending',

  // unchanged
  lifecycle: PlaybackStateValue,
  loadSource: LoadSourceValue | null,
  pendingPlayTime: number | undefined,
  pendingPausedAt: number | undefined,
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

`state.appState` becomes a derived view for the duration of the migration and is removed, or kept as an exported compatibility getter, at the end.

`PLAYBACK_STATE` stays untouched. It is the file-pipeline FSM and orthogonal to mode/activity.

## Migration Principle

**Dual-write before cutover, every step reversible.**

1. New slots are added and written as a side effect of existing writes. Nothing reads them yet.
2. Readers migrate one domain at a time. Old readers continue to use `appState`.
3. Wire protocol carries both fields for at least two production releases before dropping legacy emit.
4. Source-of-truth flips only after every production reader is on the new slots.
5. Legacy `appState` is removed last, or kept indefinitely as an exported getter if external consumers might exist.

## Concrete Survey of Today's State

Refresh this survey before each new sub-phase with:

```powershell
rg -n "appState|setPlaybackAppState|claimPlaybackOwner|releasePlaybackOwner" src
```

**Writers**: 3 direct writes, all inside `src/player/ownership.ts`.

- `ownership.ts::claimPlaybackOwner` writes `OWNER_APP_STATE[owner]`.
- `ownership.ts::setPlaybackAppState` writes the passed value.
- `ownership.ts::releasePlaybackOwner` writes `nextAppState ?? IDLE`.

This single-writer position is the entire reason Phase 5 is feasible. Before the Phase 1-4 work, this number was much higher.

**Wire protocol and cross-version compatibility**:

- `src/network/sync.ts::handleSyncPing` - `SYNC_PONG` payloads include `mode` and `activity`; legacy `appState` is still emitted while `syncPongLegacyAppStateEmit` is enabled.
- `src/network/sync.ts::isSyncPongPlayingFile` - guest reads `mode/activity` first and falls back to legacy `appState` while `syncPongLegacyAppStateAccept` is enabled.
- `src/network/sync.ts` local replay/initial-sync arm gates use `playback.mode/activity`; wire-visible legacy `appState` is read through `getPlaybackOwnership()`, not directly from the global slot.
- `SYNC_PING` does not carry playback state and should remain unchanged unless a separate protocol need appears.

**Important readers and intentional legacy holdouts**:

- `src/player/transport.ts` - owns the legacy enum transitions and still needs strict appState gates until 5f.
- `src/player/media-session.ts` - OS media button command handlers and OS `playbackState` display use playback mode/activity; YouTube still delegates play/pause to iframe state because YouTube pause is not represented by `APP_STATE.PAUSED`.
- `src/audio/beat-detector.ts` - keeps a module-local appState cache by design, with buffer-change refresh for silent track switches.
- `src/player/playlist.ts` - remaining idle checks guard historical async decode races where appState's legacy `IDLE` shadow is the intended signal.
- `src/youtube/sync.ts` - guest sync/rendezvous guards use playback mode; pause/play still comes from iframe player state, not `APP_STATE.PAUSED`.
- `src/youtube/player.ts` - late-join/stop-mode YouTube-mode guards use playback mode; idle checks intentionally stay on strict legacy `IDLE` because they preserve queue/indexing behavior.
- `src/youtube/iframe.ts` - iframe create/ready/state/UI guards use playback mode, with indexing exceptions and `IDLE` fallback writes kept unchanged.
- `src/player/video.ts` - media-engine mode changes now gate from playback activity and write through `setPlaybackAppState`; body-class rendering subscribes to `state:playback.mode`.
- `src/chat/commands.ts` - debug/status output reads legacy appState through `getPlaybackOwnership()` alongside mode/activity; it no longer reads the global slot directly.

**Mode/activity snapshots**:

- `src/audio/system-capture.ts::_preSysAudioState.playback` - stores mode/activity for restore-on-stop.
- `src/audio/system-capture.ts::restorePreSystemAudioPlaybackState` - restores YouTube through the room command path, maps prior file/system active playback to the existing paused fallback, and intentionally leaves pending work idle after capture stops.

**Initial state and types**:

- `src/core/state.ts` - `appState: APP_STATE.IDLE` remains in the initial state until 5g.
- `src/types/index.ts` - `StateTree.appState`, sync payload compatibility fields, and mapped `state:appState` events remain until the wire wait is complete.

Do not treat this list as a mandate to remove every legacy reference. The remaining references fall into either source-of-truth writes, cross-version compatibility, or deliberately strict legacy command gates.
`src/player/__tests__/appstate-holdouts.test.ts` pins the production holdout list so new legacy `appState` readers cannot appear unnoticed.

## Sub-Phase Roadmap

### 5b - Dual Write (1 day)

Add `state.playback.mode` and `state.playback.activity` to the state tree, defaulting to `null` and `'idle'`. Inside `ownership.ts::claimPlaybackOwner`, `setPlaybackAppState`, `releasePlaybackOwner`, and `setPlaybackTrackMeta`, write the new slots alongside the existing legacy state writes. `setPlaybackTrackMeta` is included because the system-audio guest placeholder can establish pending ownership before `appState` changes.

Wire `state:playback.mode` and `state:playback.activity` bus events. Existing `state:appState` continues to fire unchanged.

**Invariant**: `deriveModeActivity()` applied to `appState` must equal `(mode, activity)` after every ownership transition. Add a DEV-only assertion in the ownership write helpers, not in `core/state.ts`. Keeping the assertion in `ownership.ts` avoids a core-to-player dependency and catches drift at the single writer boundary.

**Verification gate**:

- Existing tests continue to pass.
- Add tests that toggle each transition path and assert both `appState` and `(mode, activity)` are consistent.

**Reversible by**: revert single commit. No callers depend on the new slots.

### 5c - Reader Migration (3-5 days, multiple commits)

Order, lowest-risk first:

0. **Shadow-slot sync hardening (0.5 day)**
   - Keep `state.playback.mode/activity` synchronized from every legacy signal that contributes to `getPlaybackOwnership()`: `appState`, `playback.lifecycle`, `transfer.state`, `player.currentTrackMeta`, and `systemAudio.isReceiving`.
   - Production writers for `playback.lifecycle`, `transfer.state`, and `systemAudio.isReceiving` now go through ownership helper functions that sync the shadow slots immediately; the bus bridge remains a compatibility backstop.
   - This must land before any production reader trusts the new slots. File pending and system-audio pending are not purely appState-derived.

1. **New mode/activity helper surface (0.5 day)**
   - Add helpers whose names match the new contract, for example `isPlaybackModeYouTube()`, `isPlaybackPlayingFile()`, `isPlaybackPaused()`, and `getPlaybackModeActivitySnapshot()`.
   - Keep `isAppState*()` strict until `appState` removal. Those names currently mean "read the legacy enum"; changing their implementation underneath would violate [state-patterns.md](state-patterns.md).

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
   - `src/youtube/player.ts` uses playback mode for late-join bootstrap and stop-mode guards; its queue/indexing idle checks stay legacy by design.
   - `src/youtube/iframe.ts` uses playback mode for iframe create/ready/state/update guards; indexing exceptions and guest-ended IDLE fallback writes stay legacy by design.
   - `src/ui/playlist-view.ts` uses playback mode/activity as its playback-state refresh trigger instead of `state:appState`.
   - Leave protocol, snapshot, and compatibility bridge code on `isAppState*()` or raw snapshots until their dedicated phases.

3. **`is*Owner()` helpers (0.5 day)**
   - Re-point to compute from `(mode, activity)` plus the surviving signals (file lifecycle, system-audio placeholder/receiving).
   - Done with a transitional freshness boundary: public owner predicates read mode/activity, but first reconcile shadow slots against `getPlaybackOwnership()` when legacy direct-write/bootstrap paths leave them stale.
   - Remove that reconciliation once tests and any remaining bootstrap code stop mutating legacy source fields directly.

4. **Playback domain (1 day)**
   - `src/player/transport.ts`, `playback.ts`, and `playlist.ts`. These mostly read via predicates after Phase 1, so the change should be contract-level rather than behavioral.
   - First pass done for YouTube mode questions in `playlist.ts`, `playback.ts`, and the silent YouTube handoff in `transport.ts`.
   - `src/player/playback.ts` uses playback-playing file helpers for seek/restart paths that only apply to active local file playback.
   - Any site that reads `ownership.appState` directly should be checked and migrated to `ownership.mode` / `ownership.activity` only when that site truly wants the new semantic.

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

`network/sync.ts` is the only network surface that carries `appState`. The protocol is between this app's host and guest instances on potentially different versions.

**Step 5d-1: dual emit. DONE.** Host sends both `appState` (legacy) and `mode` + `activity` in `SYNC_PONG` payloads. Guest accepts either, preferring the new fields when present. `SYNC_PING` remains unchanged.

Compatibility switches are in place in `src/core/feature-flags.ts`:

- `syncPongLegacyAppStateEmit` defaults to `true`; 5d-3 flips this off after the release wait.
- `syncPongLegacyAppStateAccept` defaults to `true`; 5d-4 flips this off after the second release wait.

**Step 5d-2: wait two production releases.** After at least two production releases on 5d-1, the guest-side legacy path becomes unused for any peer that has updated.

**Step 5d-3: drop the legacy emit.** Host stops sending `appState`. Guest's legacy accept path stays for compatibility with old hosts.

**Step 5d-4: drop the legacy accept path.** After three production releases on 5d-3, guests no longer accept the legacy field. End-of-life for `appState` on the wire.

The two-release wait between 5d-1 and 5d-3 is non-negotiable. The user base contains people who join sessions across version boundaries (host on app v1.4, guest on app v1.5). A single-commit cutover would break those sessions.

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

### 5f - Source-of-Truth Flip (0.5 day, gated)

Once 5c and 5e land and 5d has reached at least 5d-3, flip `appState` to be a write-derived view of `(mode, activity)`. The flip itself is small:

- `ownership.ts` writes `mode` and `activity` first, then derives `appState` from them.
- The DEV-only invariant assertion from 5b becomes redundant; remove it.

This step is gated behind a feature flag for one release. Rollback is flipping the flag off.

### 5g - `appState` Removal (Optional, 0.5 day)

Drop `state.appState` from the state tree. `APP_STATE` enum stays as an exported constant in `core/constants.ts` for any code that still references the values for comparison. `AppStateValue` type stays for `network/sync.ts` legacy accept path until 5d-4.

After 5d-4, even `APP_STATE` and `AppStateValue` can be removed.

Whether to do 5g depends on whether `appState` carries any value beyond the new model. Likely answer: no, but the cost of removal is small and the cost of leaving it is also small. Defer indefinitely if no signal arrives.

## Risk Register

| Risk | Likelihood | Severity | Mitigation |
| --- | --- | --- | --- |
| Wire protocol break (host new, guest old) | High without care | High | 5d's release waits. Dual-emit phase is mandatory. |
| Invariant drift between `appState` and `(mode, activity)` during 5b-5f | Medium | High | DEV-only assertion in ownership write helpers. Comprehensive transition tests in 5b. |
| `system-capture` restore picks wrong mode after 5e | Low | Medium | Explicit restore matrix for file/youtube/system-audio x playing/paused/idle. |
| UI displays stale during mid-migration commit | Low | Low | Per-commit test gate. Body-class sync lands in a single commit. |
| Adapter's `PAUSED => mode: 'file'` assumption breaks post-decomposition | N/A | N/A | The assumption is encoded in legacy appState only. Once mode/activity are primary, "youtube paused" gets its own valid representation. Remove the special-case branch in `deriveModeActivity` when 5f lands. |
| External tooling/log analytics that grep `appState` from console logs | Low | Low | If `appState` is removed in 5g, document the rename. Internal debug logs only. |

## Verification Gates (Every Sub-Phase)

- `npm run typecheck` returns clean.
- `npm test` all green. Current checkpoint after 5d safety-belt work: 784 tests across 55 files.
- `npm run lint` returns clean.
- `npm run build` succeeds.
- Manual cross-version smoke: host on previous version with guest on new version, and host on new version with guest on previous version. Critical for 5d.
- DEV invariant assertion stays on between 5b and 5f.

## Rollback Strategy

| Sub-phase | Rollback |
| --- | --- |
| 5b | Revert single commit. New slots become orphaned but unused. |
| 5c | Per-domain revert. Each sub-step is one commit. |
| 5d-1 | Revert; host returns to legacy-only emit. Guest still accepts legacy. |
| 5d-3 | Re-enable legacy emit (one-line feature flag). |
| 5d-4 | Re-enable legacy accept path (one-line feature flag). |
| 5e | Revert snapshot shape change. |
| 5f | Flip feature flag off. `appState` returns to source-of-truth. |
| 5g | Restore `state.appState` field in state tree default. |

Feature flags for 5d-3/4 and 5f live in `src/core/feature-flags.ts`. Defaults preserve current production behavior; Vite env overrides are reserved for controlled preview builds and rollback switches.

## Open Questions

1. **Should `mode` retain identity after release?**
   When user leaves `PLAYING_YOUTUBE` for `IDLE`, does `mode` become `null` or stay `'youtube'` until something else is claimed? The adapter currently returns `null`. UI may want the last mode for badge labels and "resume" affordances. Probably `null` is correct for the source-of-truth, with UI computing a `lastMode` separately if needed.

2. **Should `activity: 'pending'` be split into kinds?**
   Currently derived for both file lifecycle (`DOWNLOADING`/`AWAITING_PRELOAD`) and system-audio placeholder receive. If UX justifies it, this could split into `loading`, `buffering`, or `connecting`. YAGNI for the migration itself; revisit only if a real UX need surfaces.

3. **Conversion utilities**
   `ownership.ts` now exposes `deriveModeActivityFromAppState(appState)` and `deriveAppStateFromModeActivity(mode, activity)` as the 5f compatibility projection helpers. They intentionally preserve legacy gaps: `idle` always projects to `IDLE`, file `pending` projects to `PAUSED`, and system-audio `pending` projects to `IDLE`.

4. **What about future modes (podcast, voice-chat)?**
   Decomposition unblocks them, but does not implement them. Each new mode would add one value to `PlaybackMode` and write claim/release semantics in `ownership.ts`. No state-tree changes should be required after Phase 5.

## Effort Estimate

| Sub-phase | Active dev | Calendar wait |
| --- | --- | --- |
| 5b | 1 day | none |
| 5c | 3-5 days (across commits) | none |
| 5d-1 | 1 day | 2 releases before 5d-3 |
| 5d-3 | 0.5 day | 3 releases before 5d-4 |
| 5d-4 | 0.5 day | none |
| 5e | 0.5 day | none |
| 5f | 0.5 day | 1 release |
| 5g | 0.5 day (optional) | none |

**Total**: 7-9 days active dev, 6-10 weeks calendar (release-cadence gated).

## Anti-Goals

This document does not cover:

- `playback.lifecycle` FSM redesign. That is a separate axis (file-pipeline micro-states) and out of scope.
- `transfer.state` FSM redesign. Same.
- New playback modes (podcast streaming, file recording, etc.). Those become easy after Phase 5 lands, but their design lives elsewhere.
- UI redesign. Display logic stays as-is; only the source slot names change underneath.
- Wire protocol breaking changes beyond the `appState` field. `SYNC_PONG` schema otherwise stays identical; `SYNC_PING` remains unchanged.
- Moving `player.currentTrackMeta`, `player.startedAt`, or `player.pausedAt` into `playback`. That would be a separate state-tree layout migration.

## When to Start

Phase 5 is not a launch blocker and has no production pressure today. Reasonable triggers:

- A new mode (podcast, etc.) is on the roadmap. Phase 5 unblocks it cleanly.
- A bug report surfaces where "YouTube paused" semantic gap is the root cause.
- Engineering bandwidth between feature work permits a 2-week migration cycle.

Until then, the Phase 5a adapter sits dormant by design.
