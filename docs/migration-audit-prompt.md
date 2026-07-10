# Migration Semantic Audit Prompt

> **Reusable template, reviewed 2026-07-11.** The MUSIXQUARE Phase 5 examples
> explain the failure pattern that motivated this prompt; they are historical
> examples, not claims that the migration is still in progress.

A reusable prompt for asking an AI to audit a state/enum migration for hidden semantic regressions. Paste the entire "Prompt" section below into Claude/ChatGPT/Gemini after filling in the bracketed inputs.

The prompt is designed to find the specific kind of bug where a refactor "looks right" because tests pass and the diff is mechanical, but quietly changes an external effect (browser API, network payload, persisted data) for a state that has no old equivalent.

---

## Why this kind of audit is needed

When a flat enum decomposes into orthogonal axes (or any "old shape → new richer shape" migration), the new shape carries values the old shape did not. Reviewer attention naturally focuses on the values that have direct equivalents. The new values without equivalents often slip into a default branch that produces a silently wrong external effect.

Example from MUSIXQUARE Phase 5 migration:

- Old `appState` enum: `IDLE | PAUSED | PLAYING_AUDIO | PLAYING_YOUTUBE | PLAYING_SYSTEM_AUDIO` (5 values)
- New `(mode, activity)` axes: mode has 4, activity has 4 → 16 combinations
- One external sink: `navigator.mediaSession.playbackState`

Old mapping handled all 5 enum values. New mapping was:

```ts
if (activity === 'playing') return 'playing';
if (activity === 'paused') return 'paused';
return 'none';  // default
```

That looks complete. But `activity === 'pending'` (a new value with no old equivalent) silently fell into the `'none'` branch. On iOS PWA, `playbackState === 'none'` lets the OS suspend the AudioContext while the screen is locked. So a guest mid-preload with a locked screen lost audio when playback resumed — a regression invisible to unit tests because the unit test for "syncs OS playback state from playback activity" only checked the three equivalent cases.

This audit prompt is designed to surface that class of bug.

---

## Inputs you provide to the AI

Fill in these before sending the prompt:

1. **Repository path**: absolute or relative path to the codebase root.
2. **Old shape**: the enum/type that was retired (or partially retired). Name, file:line of its definition, every value.
3. **New shape**: the replacement. Name(s), file:line(s) of definition(s), every value (or every combination of values if it is multi-axis).
4. **Mapping table**: which old value corresponds to which new value (or combination). Mark NEW values that have no old equivalent. These are the danger zone.
5. **Reverse mapping**: how the new shape derives the old shape, if any compatibility shim still exists.
6. **Known external sinks**: any sinks you already know about. The AI will find more.

---

## Prompt (paste this to the AI)

> You are auditing a state-model migration in `[REPO PATH]` for hidden semantic regressions at external boundaries. Tests pass and typecheck is clean, so do not rely on them. Your job is to find places where the migration changed an externally observable effect for a state that has no clean old equivalent.
>
> ## Migration shape
>
> Old type: `[OLD TYPE NAME]` defined at `[FILE:LINE]` with values `[V1, V2, ...]`.
>
> New type(s): `[NEW TYPE NAMES]` defined at `[FILE:LINE]` with values `[W1, W2, ...]`.
>
> Mapping from old → new: `[fill in the table]`.
>
> NEW values with no old equivalent (the danger zone): `[list them]`.
>
> Compatibility shim, if any: `[function name and location]`.
>
> ## What counts as an external sink
>
> A line of code is an external sink when it consumes a value and produces an effect that is observable outside the JS engine. Examples:
>
> 1. **Browser API writes**: `navigator.mediaSession.*`, `navigator.wakeLock.*`, `document.title`, `document.body.classList.*`, `document.body.dataset.*`, service worker postMessage.
> 2. **Network payloads**: any `conn.send`, `broadcast`, `emit` where a state-derived field goes onto the wire. Look at the field names, not just the function calls.
> 3. **Persisted state**: `localStorage.setItem`, `sessionStorage.setItem`, IndexedDB writes, OPFS writes, in-memory restore snapshots that survive across operations (e.g., "what was playing before X").
> 4. **OS integration**: media key handlers, system notifications, share sheets, app badges.
> 5. **Analytics/logging consumed by humans or external tools**: structured log fields, error reporter tags. Plain debug logs that nobody parses are not in scope.
> 6. **Bus events that downstream subscribers turn into the above**: trace one hop downstream.
>
> Internal reads (JS-only branching, predicate functions, callers within the same module that do not produce an external effect) are NOT sinks for this audit. Do not flag them.
>
> ## Audit steps
>
> For each NEW value in the danger zone:
>
> ### Step 1: Enumerate sinks
>
> Grep the repository for sinks. Suggested patterns:
>
> - `navigator\.` (mediaSession, wakeLock, vibrate, share, clipboard, serviceWorker)
> - `document\.(title|body\.classList|body\.dataset|documentElement)`
> - `localStorage\.|sessionStorage\.|indexedDB|opfs|navigator\.storage`
> - `\.send\(|broadcast\(|emit\(.*state` (network payloads carrying state)
> - For each `state:<path>` bus subscription (or your codebase's equivalent), check whether the handler writes to one of the above.
>
> Output a list of sink locations as `file:line — short description of effect`.
>
> ### Step 2: For each sink, build a behavior table
>
> For each sink, build a 2-column table:
>
> | Input value | External effect |
> |---|---|
> | `[OLD_V1]` (legacy, pre-migration) | `[what it produced]` |
> | `[OLD_V2]` | ... |
> | `[NEW_VALUE_1]` | `[what it produces NOW]` |
> | `[NEW_VALUE_2]` | ... |
>
> Fill in legacy column from git history (`git log -p` on the sink's file before the migration), or from the migration's commit diff. Fill in current column from the current code.
>
> ### Step 3: Compare equivalent rows
>
> For each row pair (old value, equivalent new value), check the effect column matches. Mismatches are regressions.
>
> ### Step 4: Audit the danger zone rows
>
> For each NEW value with no old equivalent:
>
> 1. What external effect does the sink produce?
> 2. Is that effect appropriate for the semantic of the new value? Justify in one sentence.
> 3. Could that effect cause a user-visible regression in any scenario (background tab, screen lock, cross-version session, page reload)? Justify in one sentence.
>
> If you cannot justify the effect, flag it.
>
> ### Step 5: Default branches and catch-alls
>
> Find `switch` statements without exhaustive cases (no `default: assertNever(x)` or equivalent). Find `if/else if` chains ending in a default `else`. Find ternaries that collapse multiple inputs into one fallback (the canonical shape of the mediaSession bug).
>
> For each, check whether any new value falls into the default. If yes, repeat Step 4 for that default branch.
>
> ### Step 6: Cross-version and persistence
>
> If the wire protocol changed:
>
> - Does the producer (host or peer) emit fields the consumer expects?
> - Does the consumer accept legacy payloads from older peers? (Only relevant if dual-emit/dual-accept windows are intended.)
> - List specific scenarios: host vN with guest vN-1; host vN-1 with guest vN; reload mid-session.
>
> If state is persisted to localStorage/IndexedDB/OPFS:
>
> - On read, does the consumer handle persisted-in-old-shape data?
> - Is there a migration path for in-flight users on old data?
>
> ## Output format
>
> For each finding, return exactly:
>
> ```
> [FINDING N] Severity: critical | high | medium | low
>
> Sink: <file:line>
> External effect: <what is produced and what consumes it>
>
> Old behavior: <input → effect>
> New behavior: <input → effect>
>
> Regression scenario: <one or two sentences describing the user-visible bug, including the platform/context where it manifests>
>
> Suggested fix: <minimal code change>
> Test to add: <one test that would have caught this; if applicable, a regression test, not a unit test of the new shape>
> ```
>
> If no findings for a section, say "No findings — sinks checked: <list>." Do not pad.
>
> ## Severity guidance
>
> - **critical**: any sink change that can suspend audio, drop a session, break authentication, or corrupt persisted state.
> - **high**: any sink change that produces visibly wrong UI, wrong sync state, or wrong wire payload.
> - **medium**: log/analytics fields that downstream tooling depends on.
> - **low**: cosmetic, internal-debug only.
>
> ## What to ignore
>
> - Tests that exercise the new shape directly. They prove the new shape works; they do not prove old behavior is preserved at sinks.
> - Internal predicate refactors with no external effect.
> - Adapter/compat shim functions whose purpose is precisely to preserve old shape for some callers. (Audit their CALLERS, not them.)
> - Documentation changes.
>
> ## When you are done
>
> Summarize:
>
> - Sinks audited (count and list)
> - Findings (count by severity)
> - High-confidence "clean" sinks (where old and new behavior demonstrably match for every input)
> - Open questions where you could not determine the legacy behavior without further information

---

## Optional follow-ups for the AI

After the initial pass, follow up with these to deepen the audit:

1. **Cross-platform**: "Repeat the audit specifically for Safari iOS, Safari iOS PWA (added to home screen), Chrome Android, and a desktop browser tab in the background. Which findings change severity on each platform?"

2. **Race conditions**: "For each sink, identify whether the new value can be produced transiently during a single user interaction (mid-transition). If yes, does the sink's external effect briefly contradict the user's mental model? Example: a 'pending' state during a track switch that the user perceives as continuous playback."

3. **Persisted snapshots**: "List every in-memory snapshot the codebase takes of the old shape (search for fields whose name suggests 'previous', 'pre', 'before', 'snapshot', '_prev'). For each, check whether the snapshot is now taken of the new shape and whether the restore path can handle every new value, including new values with no old equivalent."

4. **Bus event subscribers**: "List every subscriber to bus events whose payload type changed in the migration. For each subscriber, check whether the handler narrows the payload's runtime type and whether it explicitly handles new values."

---

## Calibration: known regressions this would have caught

Used against MUSIXQUARE Phase 5 commit `1136939` (the merge), this prompt's Step 5 would have surfaced `src/player/media-session.ts:21-27` immediately:

```ts
function mediaSessionStateFromActivity(activity): MediaSessionPlaybackState {
  if (activity === 'playing') return 'playing';
  if (activity === 'paused') return 'paused';
  return 'none';  // ← 'pending' silently lands here
}
```

The danger-zone value `activity === 'pending'` (new, no old equivalent) takes the default branch and produces `'none'`, which causes iOS to suspend AudioContext during guest preload. This is exactly the shape Step 5 is designed to find.

If the prompt does not surface a similar finding on your migration, try sharpening Step 1's grep coverage for your codebase's specific sink patterns (e.g., if you use a state-management library, the bus-event grep needs to match its subscriber API).
