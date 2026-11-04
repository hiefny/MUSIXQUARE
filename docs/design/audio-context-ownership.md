# AudioContext Ownership

- **Status:** Proposed (Phase 7 T1, 2026-11-02). Amended with each Phase 7 increment that moves an
  owner or changes a rule below; Accepted when the last Phase 7 train (7C) lands.
- **Applies to:** the app's one AudioContext: its native running or suspended state, its suspend
  leases, its `statechange` listeners and the one-shot foreground clock-health incident (resource
  ownership registry [RO-01](resource-ownership-registry.md#ro-01-audiocontext-running-state);
  structural plan C1, Phase 7 trains 7A, 7B and 7C).
- **Related:** [Resource ownership registry](resource-ownership-registry.md) (RO-01, RO-36, RO-37,
  RO-44, RO-51), [Playback concurrency invariants](playback-concurrency-invariants.md),
  [Source complexity safety limits](source-complexity-ratchet.md), QA025 and QA026 in
  [QA domains](../qa-domains.md).

## Context

The app creates one AudioContext (`getAudioContext` in `src/audio/context.ts`). On iOS WebKit it
can report `running` while its clock is frozen, or stay suspended after a call, a lock or a route
change, and only a trusted user gesture may resume it. Two machines drive it today:

| Machine                 | File                            | Starts when                                                                           |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| Play-request restart    | `src/audio/context.ts`          | a PLAY after a return to the foreground finds the clock stalled                       |
| Playback-scope recovery | `src/audio/context-recovery.ts` | an OS interruption or a stalled clock during playback (`statechange`, visibility, G7) |

Each keeps its own suspend lease, its own `statechange` listeners and its own gesture resume.
`src/app.ts` sequences both in the recovery dialog ('Audio paused unexpectedly' with the 'Restore
audio' button in English), `src/player/media-session.ts` repeats the same gesture sequence for
a lock-screen PLAY, and `src/audio/ui-sounds.ts` resumes the context on a trusted press before it
plays a UI sound, without asking either machine (until 7B-3, Decision 2.3). Phase 7 makes
`context-recovery.ts` the one owner of the recovery protocol in three app updates: 7A (counters
and sound-neutral cleanup), 7B (the behaviour changes the owner approved on 2026-11-02, each
behind a failing test) and 7C (the move behind one owner).

## Decision (proposed)

1. **One owner.** `src/audio/context-recovery.ts` owns the recovery protocol: the suspend lease, the
   `statechange` dispatcher, the gesture resume and the clock verification. `src/audio/context.ts`
   keeps the singleton and three primitives: the gesture restart (`restartAudioContextFromGesture`,
   used by the owner once 7C-2 lands), and for allowed requesters `ensureRunning` and the
   health probe's resume (`probeAudioContextHealth`).
2. **Only the owner calls native `resume()` and `suspend()`**, with three exceptions:
   1. `ensureRunning` wakes a context that is not running (PLAY, file activation, the engine's
      initialization). When an attempt holds the context, the owner's re-suspend rule undoes that
      wake (kept as today's behaviour, owner answer of 2026-11-02). Since 7B-2 the play-request
      attempt waiting for its tap has the same rule as the playback scope's, so its tap resumes a
      parked context instead of being refused.
   2. `probeAudioContextHealth` with `attemptResume: true` has one caller,
      `src/audio/output-health.ts`, and runs only after both ownership checks in that file report
      no attempt.
   3. UI sounds ask the owner whether it holds the context for a tap, and wake it themselves only
      when it does not; while it does they make no sound either (7B-3: `ui-sounds.ts` asks
      `isAudioOutputRecoveryHolding` in `context-recovery.ts`, which asks the play-request owner's
      answer when called). Their two native resumes stay counted by the guard as requesters that
      ask first.
3. **One native suspend in flight per context.** One lease and one `statechange` dispatcher per
   context (7B-4). A reader that only updates the loading indicator
   (`src/ui/file-start-loading.ts`) stays outside the dispatcher and is not counted as an owner
   listener.
4. **A gesture resume is synchronous inside the activation callback.** No `await` precedes native
   `resume()` on a gesture path (the recovery dialog's button, a lock-screen PLAY, the start tap),
   so the call keeps the transient activation. A running-but-frozen context is suspended before
   the dialog shows, so the button never spends its activation awaiting `suspend()`.
5. **Queries have no side effects.** A query answers from the owner's state and never changes it.
   Today `getPendingAudioContextClockHealthRequirement` in `context-recovery.ts` promotes a
   state-interruption attempt to clock verification when it is read; 7C-1 moves that promotion
   into the owner's own steps.
6. **Two questions, kept apart.**
   - **Holding** (narrow, asked by UI sounds before they wake the context): the owner is waiting
     for a tap. That is a suspend being prepared (`preparing-suspend`), a parked context waiting
     for the gesture (`awaiting-gesture`) or the gesture resume in flight (`gesture-resuming`), an
     unfinished lease or late-suspend fence, and only for a file-mode identity (the play-request
     attempt is always a file), an attempt the owner still holds and a current identity. An OS
     interruption waiting for its automatic resume (`awaiting-resume`) is not holding, and neither
     is a YouTube-mode attempt parked by a clock stall: no dialog asks for its tap, so holding it
     could silence UI sounds until the next lock-screen PLAY. Implemented in 7B-3 (an owner's
     suspend lease and late-suspend fence serve its attempt only while that attempt prepares the
     suspend, so the phases cover them) and pinned phase by phase by the holding table; the
     `/debug sync` counts ask the same answers.
   - **Ownership** (broad, asked by `output-health.ts` before its background check): any attempt
     exists, a play-request restart (`isForegroundAudioContextRestartOwned`) or a playback-scope
     attempt (`getPendingAudioContextRecoveryAttemptForHealth`). The background check must not race
     an OS interruption that waits for no tap either, so it keeps the broad question.
7. **`output-health.ts` stays a reader outside the owner.** It reads `src/player/transport.ts`
   (`isFilePipelineBusyForPlay`, `isFileSourceNodeUsable`), and transport imports the engine,
   which binds the owner; inside the owner those reads would close an import cycle.
8. **Phase unions live in the owner module.** After 7C-5 the C1 phase union is one type in
   `context-recovery.ts`. No guard checks shared phase unions or duplicated helper names: with one
   union left the check would guard one item, and a string-union comparison could flag unrelated
   clusters.
9. **Identity lists are documented, not merged.** `app.ts` aborts the recovery dialog on nine
   identity events (playback activity and mode, the current queue item, the current file, demo
   active and track, the buffer change, the room context, the session start), and
   `context-recovery.ts` retires a demo output attempt on seven of them (all but the queue item
   and the current file). Their scopes differ: the dialog follows the playing item, the demo
   attempt follows the demo.

## Rules for tests

- **The mock trap (vitest 5).** A factory mock throws when code reads a name the factory does not
  define; a read at module evaluation fails the import itself. So new constants, counters and
  predicates go in modules no test mocks (the timing leaf `src/audio/context-protocol.ts` since
  7A-2, or another new leaf), not in
  `context.ts` exports; `context-recovery.ts` and new modules read no `context.ts` export at module
  evaluation; and a change whose production path calls a new `context.ts` export updates, in the
  same change, every factory mock of `context.ts` on that path. Two files evaluated the real
  `context-recovery.ts` under a `context.ts` factory before 7B-3
  (`src/player/__tests__/media-session-pending-start.test.ts`,
  `src/player/__tests__/transport-ended-stop.test.ts`); they are the latch. Since 7B-3 every test
  file that loads UI sounds evaluates it too (22 more under a `context.ts` factory). Its holding
  query reads `isForegroundAudioContextRestartHolding` only after the UI sound preference, which
  among those files only `src/audio/__tests__/ui-sounds.test.ts` turns on, and that file's factory
  defines the name.
- **Public behaviour, no sub-step names.** The owner tables (`audio-output-recovery-boundary`,
  `audio-output-recovery-holding`, `audio-output-recovery-parity`, in `src/audio/__tests__/`)
  assert the fake's op log, bus events and the owners' normalized answers through one driver
  (`__helpers__/audio-output-owners.ts`), so 7C changes the driver, not the tables. No test-only
  export is added (the dead-export ratchet has no headroom).
- **Known gaps.** A row labelled 'Known gap (C1-...)' pins today's behaviour. Only an increment the
  owner approved flips it, in its own failing-test-first commit.

## Guards

- `scripts/check-resource-ownership.mts` CHECK 6 counts native `resume()` and `suspend()` per file;
  beside it, since Phase 7 T1, an exact ratchet counts per file the callers of `ensureRunning`,
  `restartAudioContextFromGesture` and `probeAudioContextHealth`, `context.ts` included (it calls
  none of them, so a wrapper there cannot hide a new caller), and reports `initAudio` uses. Each
  Phase 7 step lowers the counts it moves into the owner in the same change.
  The guard stays syntactic (RO-44).

## Limits of the evidence

- **The frozen clock cannot be produced on purpose.** The WebKit state this protocol guards
  against (running, clock frozen) cannot be created in Chromium, desktop Playwright WebKit or on a
  device. The proof path is the on-device counters 7A adds to `/debug sync` and its one-second
  samples (state and `currentTime`).
- **The fake is calibrated by comments only.** `FakeNativeAudioContext`
  (`src/audio/__tests__/__helpers__/fake-audio-context.ts`) models the orderings the owners' own
  comments record; no `/debug` or flight-recorder trace of those orderings exists yet. A
  `/debug sync` copy that shows a running state with a still clock is the first calibration
  record.
- **Browser evidence is Chromium only.** Local Playwright WebKit on Windows has no AudioContext
  (checked 2026-11-02), and the weekly WebKit lane does not play files.
- **`app.ts` has no unit seam.** It is import-terminal, so the recovery dialog's half is pinned only
  in a real browser: the local Chromium lab (`e2e/audio-lab/output-recovery.lab.ts`, run by hand
  with `playwright.audio-lab.config.ts`, never in CI) and the CI specs
  `e2e/background-resume.test.ts`, `e2e/demo-output-recovery.test.ts` and
  `e2e/back-navigation.test.ts` ('a required audio recovery dialog survives Back').

## Anchor tests

- Owner boundary: `src/audio/__tests__/audio-context-ownership.test.ts` (the C1 harness, App
  9.0.3) and the owner tables above.
- Recovery owner: `src/audio/__tests__/context-recovery.test.ts`; play-request restart:
  `src/audio/__tests__/context-health.test.ts`.
- Lock-screen PLAY: `src/player/__tests__/media-session.test.ts`,
  `src/player/__tests__/media-session-lock-screen-pause.test.ts`.
- Start tap (QA025): `src/ui/__tests__/setup-start.test.ts`,
  `src/ui/__tests__/setup-start-native-resume.test.ts`.
- Engine handoffs to YouTube audio: `src/audio/__tests__/engine-youtube-audio-handoff.test.ts`.
