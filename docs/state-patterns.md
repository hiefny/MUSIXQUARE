# Playback State Consumption Plan

MUSIXQUARE still exposes the legacy `appState` enum, but callers must not treat every read as the same operation. This document defines the contract for how modules consume playback state during the ownership refactor.

## Core Problem

The old pattern allowed any module to call `getState('appState')` and decide what it meant locally. That made three different concerns look identical:

- strict mode snapshots such as `PLAYING_YOUTUBE`
- broad ownership such as pending system-audio receive before the WebRTC stream arrives
- UI render state that should update reactively when state changes

The goal is not to remove every poll. The goal is to make every poll intentional.

## Contracts

### Pattern 1: Strict App State Poll

Use `isAppState*()` from `src/player/ownership.ts` when a caller needs the current enum value at the exact moment of a decision.

Good fits:

- click handlers
- timer/rAF guards
- protocol payload decisions
- one-shot command gating
- compatibility bridges that still expose legacy `appState`

Examples:

- `isAppStatePlayingAudio()`
- `isAppStatePlayingYouTube()`
- `isAppStatePlayingSystemAudio()`
- `isAppStateIdle()`
- `isAppStatePaused()`
- `isAppStateIdleOrPaused()`

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
| A | rAF/timer immediate freshness reads | Pattern 1 | `seekbar`, `visualizer`, sync timers |
| B | one-shot event handler gates | Pattern 1 or 2 | `app.ts`, chat, settings, setup |
| C | UI render and labels | Pattern 3 | `player-controls`, selected visualizer reactions |
| D | audio bridges | one pattern per module | `beat-detector`, `channel`, `system-capture` |
| E | playback-domain residuals | Pattern 1 or 2 | `playback`, `playlist`, YouTube bridge code |

## Phase Plan

### Phase 0: Contract Documentation

- Add this document.
- Keep `ownership.ts` header explicit about strict app state vs broad ownership vs UI subscription.
- No behavior change.

### Phase 1: Playback Domain Residuals

- Replace remaining raw playback-domain appState polls in `playback.ts`, `playlist.ts`, and YouTube bridge code with `ownership.ts` predicates.
- Preserve protocol payloads and stored snapshots.

### Phase 2: Gating Site Rename

- Replace low-risk one-shot appState gates with strict `isAppState*()` helpers.
- Leave protocol payload comparisons untouched.
- Leave state snapshot capture untouched when the snapshot is forwarded or stored.

### Phase 3: Audio Domain Contract

- Normalize `beat-detector`, `channel`, and `system-capture`.
- `beat-detector` keeps a module-local appState cache fed by `state:appState`, with explicit freshness refresh on buffer-change paths.
- `channel` uses strict predicates at graph mutation time.
- `system-capture` is the explicit exception: it keeps the pre-capture `appState` snapshot as restore data and may compare that stored snapshot directly. Do not replace that snapshot with live predicates, because restore must answer "what was playing before capture started?", not "what is playing now?".

### Phase 4: UI Subscription Model

- Introduce `src/ui/_state-hooks.ts`.
- Use a scoped `subscribeAppState()` helper for display-only UI state.
- Keep click handlers polling fresh state via Pattern 1.
- Start with `player-controls` and `visualizer`, the highest-value UI consumers.

### Phase 5: Mode/Activity Decomposition Adapter

- Do not replace the global state tree in one jump.
- Add a derived adapter in `ownership.ts`:
  - `mode`: `file | youtube | system-audio | null`
  - `activity`: `idle | paused | playing | pending`
- Use it as the migration boundary for future state-tree decomposition.
- This phase proves the shape without changing wire protocol or storage schema.
- `owner` and `mode` are not guaranteed to match. Example: PAUSED has no active owner but derives `mode: file` because legacy `APP_STATE.PAUSED` only represents the local-file pause shadow; YouTube pause lives in the YouTube player state instead.
- `state.playback.mode/activity` are shadow slots during 5b/5c. Prefer the new `isPlaybackMode*()`, `isPlaybackPlaying*()`, and `isPlaybackPaused/Pending()` helpers only when the caller is asking a mode/activity question. Keep `isAppState*()` for legacy enum compatibility and wire/protocol decisions.
- The full decomposition roadmap (5b through 5g) lives in [appstate-decomposition.md](appstate-decomposition.md). That document is the migration plan; this one remains the read/write contract reference.

## Verification Gate

Each phase should keep these green:

- `npm run typecheck`
- targeted tests near changed modules
- `npm run lint`
- `npm test`
- `npm run build`

Known acceptable warning: Vite chunk-size / mixed static-dynamic import warning for `playlist.ts`.
