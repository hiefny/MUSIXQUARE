# Playback State Consumption Plan

MUSIXQUARE still exposes legacy `APP_STATE` values for compatibility, but the global state tree no longer stores `state.appState`. This document defines the contract for how modules consume playback state during and after the ownership refactor.

## Core Problem

The old pattern allowed any module to call `getState('appState')` and decide what it meant locally. That made three different concerns look identical:

- strict mode snapshots such as `PLAYING_YOUTUBE`
- broad ownership such as pending system-audio receive before the WebRTC stream arrives
- UI render state that should update reactively when state changes

The goal is not to remove every poll. The goal is to make every poll intentional.

## Contracts

### Pattern 1: Legacy App State Compatibility Read

Use `getPlaybackLegacyAppState()` from `src/player/ownership.ts` only when a caller still needs the old enum value at the exact moment of a decision. New code should first ask whether it really wants `playback.mode/activity` instead.

Good fits:

- compatibility bridges that still expose legacy `appState`
- queue/indexing holdouts that intentionally require strict legacy `IDLE` semantics

Examples:

- `getPlaybackLegacyAppState() === APP_STATE.IDLE`
- `getPlaybackLegacyAppState() === APP_STATE.PLAYING_YOUTUBE`

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

Click handlers may still poll using Pattern 1. The rule is:

- command execution uses fresh poll
- display rendering uses subscription

## Current Buckets

| Bucket | Target | Pattern | Scope |
| --- | --- | --- | --- |
| A | rAF/timer immediate freshness reads | Pattern 2 or mode/activity poll | `seekbar`, `visualizer`, sync timers |
| B | one-shot event handler gates | Pattern 2 or mode/activity poll | `app.ts`, chat, settings, setup |
| C | UI render and labels | Pattern 3 | `player-controls`, selected visualizer reactions |
| D | audio bridges | one pattern per module | `beat-detector`, `channel`, `system-capture` |
| E | playback-domain residuals | Pattern 1 or 2 | `playback`, `playlist`, YouTube bridge code |

## Phase Plan

### Phase 0: Contract Documentation

- Add this document.
- Keep `ownership.ts` header explicit about strict app state vs broad ownership vs UI subscription.
- No behavior change.

### Phase 1: Playback Domain Residuals

- Replace remaining raw playback-domain appState polls with `ownership.ts` predicates or adapter reads. `playback.ts` and YouTube runtime mode guards are migrated; queue/indexing idle checks in `playlist.ts` and YouTube stay strict legacy `IDLE` through `getPlaybackLegacyAppState()`.
- File `PLAY`/`PAUSE` protocol payloads no longer carry the legacy `appState` enum; receivers derive behavior from existing payload fields and local playback mode/activity.

### Phase 2: Gating Site Rename

- Replace low-risk one-shot appState gates with playback mode/activity helpers or, only for true compatibility holdouts, `getPlaybackLegacyAppState()`.
- Leave protocol payload comparisons untouched.
- Leave state snapshot capture untouched when the snapshot is forwarded or stored.

### Phase 3: Audio Domain Contract

- Normalize `beat-detector`, `channel`, and `system-capture`.
- `beat-detector` keeps a module-local file-playing cache fed by `state:playback.mode` and `state:playback.activity`, with explicit freshness refresh on buffer-change paths.
- `channel` uses playback mode/activity predicates at graph mutation time when the question is "is there active playback to refresh?".
- `system-capture` is the explicit snapshot exception: it keeps pre-capture `playback.mode/activity` restore data and must not read live predicates during restore, because restore must answer "what was playing before capture started?", not "what is playing now?".

### Phase 4: UI Subscription Model

- Introduce `src/ui/_state-hooks.ts`.
- Use scoped UI state hooks for display-only UI state: `scopePlaybackModeActivity()` for mode/activity displays or refresh triggers.
- Keep click handlers polling fresh state via Pattern 1.
- `player-controls`, `visualizer`, and playlist refresh triggers now consume playback mode/activity for display and playback-activity rendering.

### Phase 5: Mode/Activity Decomposition

- Replace the legacy global state slot with the playback domain state:
  - `mode`: `file | youtube | system-audio | null`
  - `activity`: `idle | paused | playing | pending`
- `state.appState` has been removed. `getPlaybackLegacyAppState()` derives the old enum for compatibility consumers only.
- `owner` and `mode` are not guaranteed to match. Example: PAUSED has no active owner but derives `mode: file` because legacy `APP_STATE.PAUSED` only represents the local-file pause shadow; YouTube pause lives in the YouTube player state instead.
- `state.playback.mode/activity` are the primary contract. Prefer the new `isPlaybackMode*()`, `isPlaybackPlaying*()`, and `isPlaybackPaused/Pending()` helpers when the caller is asking a mode/activity question. Keep `getPlaybackLegacyAppState()` only for legacy enum compatibility inside the app.
- The full decomposition roadmap (5b through 5g) lives in [appstate-decomposition.md](appstate-decomposition.md). That document is the migration plan; this one remains the read/write contract reference.

## Verification Gate

Each phase should keep these green:

- `npm run typecheck`
- targeted tests near changed modules
- `npm run lint`
- `npm test`
- `npm run build`

Known acceptable warning: Vite chunk-size / mixed static-dynamic import warning for `playlist.ts`.
