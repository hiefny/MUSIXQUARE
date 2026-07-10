# Playback State Consumption Contract

Last statically reviewed against the source tree on 2026-07-11. The executable
contract tests in `src/player/__tests__/playback-state-contract.test.ts` take
precedence if this prose drifts.

MUSIXQUARE no longer exports legacy `APP_STATE` from core, and the global state tree no longer stores `state.appState`. The remaining compatibility surface is a narrow `isPlaybackIdleCompat()` predicate for historical strict-IDLE semantics. This document defines the contract for how modules consume playback state during and after the ownership refactor.

## Core Problem

The old pattern allowed any module to call `getState('appState')` and decide what it meant locally. That made three different concerns look identical:

- strict mode snapshots such as `PLAYING_YOUTUBE`
- broad ownership such as pending system-audio receive before the WebRTC stream arrives
- UI render state that should update reactively when state changes

The goal is not to remove every poll. The goal is to make every poll intentional.

## Contracts

### Pattern 1: IDLE Compatibility Read

Use `playback.mode/activity` helpers for semantic questions, and use `isPlaybackIdleCompat()` only when a caller must preserve the old enum's exact `IDLE` behavior.

Good fits:

- queue/indexing holdouts that intentionally require strict legacy `IDLE` semantics

Examples:

- `isPlaybackIdleCompat()` when the caller truly needs old `APP_STATE.IDLE` compatibility
- `getPlaybackModeActivity().mode === 'youtube'`

### Pattern 2: Broad Ownership Poll

Use `is*Owner()` or `isExternalOwner()` when the caller cares who owns playback, including pending or derived signals that are not represented by `appState` alone.

Good fits:

- local-file lifecycle gates
- stale FILE/PLAY frame rejection
- async decode/preload re-checks
- system-audio pending receive windows

Examples:

- `isFileOwner()`
- `isYouTubeOwner()`
- `isSystemAudioOwner()`
- `isExternalOwner()`

### Pattern 3: Reactive UI Subscription

UI display should subscribe to state changes and render from the event payload or a scoped snapshot. Do not hide display updates inside click handlers if the display is actually a function of state.

Good fits:

- play/pause icon
- media source button label
- tab title marquee
- mode badges
- visualizer start/stop display reactions

Click handlers may still poll using Pattern 1 or 2. The rule is:

- command execution uses fresh poll
- display rendering uses subscription

## Consumption Buckets

| Bucket | Target | Pattern | Scope |
| --- | --- | --- | --- |
| A | rAF/timer immediate freshness reads | Pattern 2 or mode/activity poll | `seekbar`, `visualizer`, sync timers |
| B | one-shot event handler gates | Pattern 2 or mode/activity poll | `app.ts`, chat, settings, setup |
| C | UI render and labels | Pattern 3 | `player-controls`, selected visualizer reactions |
| D | audio bridges | one pattern per module | `channel`, `system-capture` |
| E | playback-domain residuals | Pattern 1 or 2 | `playback`, `playlist`, YouTube bridge code |

## Migration Summary

### Contract Documentation

- Keep `ownership.ts` header explicit about mode/activity, strict IDLE compatibility, broad ownership, and UI subscription.

### Playback Domain Residuals

- Replace remaining raw playback-domain appState polls with `ownership.ts` predicates or adapter reads. `playback.ts` and YouTube runtime mode guards are migrated; queue/indexing idle checks in `playlist.ts` and YouTube stay strict compatibility `IDLE` through `isPlaybackIdleCompat()`.
- File `PLAY`/`PAUSE` protocol payloads no longer carry the legacy `appState` enum; receivers derive behavior from existing payload fields and local playback mode/activity.

### Gating Sites

- Replace low-risk one-shot appState gates with playback mode/activity helpers or, only for true compatibility IDLE holdouts, `isPlaybackIdleCompat()`.

### Audio Domain Contract

- `channel` uses playback mode/activity predicates at graph mutation time when the question is "is there active playback to refresh?".
- `system-capture` is the explicit snapshot exception: it keeps pre-capture `playback.mode/activity` restore data and must not read live predicates during restore, because restore must answer "what was playing before capture started?", not "what is playing now?".

### UI Subscription Model

- Introduce `src/ui/_state-hooks.ts`.
- Use scoped UI state hooks for display-only UI state: `scopePlaybackModeActivity()` for mode/activity displays or refresh triggers.
- Keep click handlers polling fresh state via Pattern 1.
- `player-controls`, `visualizer`, and playlist refresh triggers now consume playback mode/activity for display and playback-activity rendering.

### Mode/Activity Decomposition

- Replace the legacy global state slot with the playback domain state:
  - `mode`: `file | youtube | system-audio | null`
  - `activity`: `idle | paused | playing | pending`
- `state.appState` has been removed, and the old full enum projection helpers are gone.
- `owner` and `mode` are not guaranteed to match. Example: paused local-file playback has no active owner but still records `mode: file`; YouTube pause lives in the YouTube player state instead.
- `state.playback.mode/activity` are the primary contract. Prefer the new `isPlaybackMode*()`, `isPlaybackPlaying*()`, and `isPlaybackPaused/Pending()` helpers when the caller is asking a mode/activity question.
- If a caller already has a scoped playback snapshot, pass that snapshot into the matching predicate instead of re-polling state.
- The full decomposition record (5b through 5g) lives in [appstate-decomposition.md](appstate-decomposition.md). That document records the completed migration; this one remains the read/write contract reference.

## Verification Gate

Playback-state changes should keep these green:

- `npm run typecheck`
- targeted tests near changed modules
- `npm run lint`
- `npm test`
- `npm run build:checked`

Build warnings must be evaluated against the current output; this document does
not permanently waive a named warning or bundle size.
