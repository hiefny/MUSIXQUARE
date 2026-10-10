# PRO persisted-resource lane — 2026-10-11

| Field              | Value                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Evidence — completed behaviour-neutral refactor, not yet released                                                                                                                                                                                 |
| Applies to         | PRO room effects and queue-mode persistence in `src/pro-room/runtime.ts`                                                                                                                                                                          |
| Last source review | 2026-10-11 (base main `933c6f54`, tested code `4adecea3`, review follow-up `f1d35b5e`)                                                                                                                                                            |
| Executable sources | [lane](../../src/pro-room/persisted-resource-lane.ts), [runtime](../../src/pro-room/runtime.ts), [lane suite](../../src/pro-room/__tests__/runtime-persisted-resource-lane.test.ts), [critical coverage profile](../../vitest.critical.config.ts) |
| Related documents  | [Release record](../release-record.md), [release procedure](../hotfix-procedure.md), [version rules](../release-versioning.md)                                                                                                                    |

## Status and release

Branch `agent/pro-room-persisted-resource-lane`, from main
`933c6f54dd768e369ffb29b0e854ea80b4e47efa`. Not merged or deployed;
production remains `8.8.0` / `v646`.

- `fe0410d0` — the heartbeat calls the named refresh predicates.
- `4adecea3` (`4adecea315a14fee2ead36a49f317c98a26cac9c`) — the lane
  extraction, its tests, the critical coverage entry and its CI policy pin,
  and the PWA cache bump (`scripts/service-worker-asset.ts` and the
  `index.html` bootstrap query). The verification, coverage, and
  differential results below were measured on this commit.
- `f1d35b5e` — test-only review follow-up that pins when the effects wrapper
  reads the notification generation. Its re-run is in
  [Review follow-up](#review-follow-up--notification-generation-pin).

The product version stays `8.8.0` because no shipped behaviour changes. The PWA
cache moves to `v647` because `guard:sw-cache-version` requires a bump for any
non-test `src/` change. `claim-bootstrap.test.ts` pins the `index.html`
bootstrap query to the same epoch, so both change together. Nothing changes in
the wire protocol, Workers, D1, R2, secrets, or bindings. The change should
merge through PR review and the successful exact-main-SHA CI candidate, then
ship with the next App release (`target=app`). These local results are not
that candidate. The release record lists this undeployed App change as a §2
open item; its §1 stays at production `8.8.0` / `v646` until the deployment.

## What changed

Room effects and queue mode each had a byte-for-byte copy of two mechanisms:

- a serial mutation lock (`enqueueEffectsMutation` / `enqueueQueueModeMutation`)
  that every refresh pass and checkpoint PUT shares;
- a coalescing refresh flight (the bodies of `refreshPersistedEffects` /
  `refreshPersistedQueueMode`).

The refresh predicates also had a third inline copy in
`refreshHeartbeatAdjunctState`.

`PersistedResourceLane` now holds one generic copy of both mechanisms. It has
no imports and exactly one export, so it adds no dead-export, import-graph, or
room-authority surface. Each resource gets its own lane. The domain rules stay
in `runtime.ts` and are passed in as callbacks: `effectsRefreshStillRequired`,
`newerEffectsRefreshSnapshot`, `queueModeRefreshStillRequired`, and
`newerQueueModeRefreshSnapshot`.

- `resetPlaylistRuntime` calls `lane.reset()` at the point where it used to
  replace the tail and clear the flight.
- `persistRoomEffects` and `persistQueueModeCheckpoint` take the lock with
  `lane.enqueue`.
- `refreshPersistedEffects` and `refreshPersistedQueueMode` stay `async`
  wrappers. The effects wrapper captures the notification generation at call
  time; the queue wrapper keeps its `options` argument.
- `runtime.ts` shrinks from 4,022 to 3,896 lines.

The lane keeps every timing and ownership detail of the old copies:

- The runtime generation is read when `refresh()` is called and again on every
  pass.
- Only the flight creator's `runUnlocked` closure runs. A joiner's notification
  generation or options are discarded, as before.
- Joiners receive the identical flight promise, not a derived one.
- The first pass takes the lock synchronously inside `refresh()`. The in-flight
  slot is installed after the flight starts, and `finally` clears it only while
  it still holds that flight.
- After a pass, a pending snapshot is checked in this order: same room, still
  required, then folded with the newer-snapshot rule.
- After a failure, a required pending snapshot still gets one more pass.
  Otherwise the last pass's failure is rethrown. `applied` OR-accumulates
  across passes.

## Asymmetries deliberately left un-unified

The rest of the two pipelines are different algorithms, several of them shaped
by earlier QA repairs. They stay verbatim. Folding them into one generic
checkpoint would change behaviour.

- **Refresh predicates.** Queue mode also requires
  `queueModeMatchesPlaylist`, and breaks ties on `playlistRevision` before
  `revision`.
- **Pre-PUT reads.** The effects pre-read matches its refresh predicate. The
  queue pre-read omits the head-revision check and relies on the server CAS.
- **Readers (`refreshPersisted*Unlocked`).**
  - Effects filters the previous value by room and rebases local changes
    through the intent tracker. It commits `acceptedEffects` before applying
    it, and can toast, complete the silent baseline, and re-arm a PUT.
  - Queue mode records the intent revision before the read and uses
    per-field and shuffle-order preservation. It commits only after the apply
    succeeds.
- **Checkpoint writers (`persistRoomEffects` / `persistQueueModeCheckpoint`).**
  - Authority: settings sync plus publish permission, versus the `queue.mutate`
    capability.
  - Entry and authority loss: effects cancels; queue mode returns silently.
  - Abort signal: effects reads it late, at each call; queue mode captures it
    early.
  - Snapshot: effects keeps the one from lock start; queue mode re-reads it
    after its GET.
  - Intent: a fixed token for effects; queue mode rebinds after its read.
  - Effects short-circuits a no-op PUT; queue mode always sends full state.
  - Attempts and conflicts: effects runs a two-attempt CAS loop that reads,
    rebases, and retries. Queue mode makes one PUT and, on conflict, retires
    fields and refreshes.
  - Backoff: effects retries 1 s / 3 s / 10 s, then every 10 s indefinitely,
    honouring Retry-After up to 5 minutes. Queue mode makes three bounded
    retries.
  - `ROOM_EPOCH_MISMATCH` is repaired with a heartbeat only for effects.
  - Terminal errors: any non-transient error for effects; only 401/403 for
    queue mode.
  - Success settlement differs.
  - Cancel: effects is lease-scoped and keeps local audio; queue mode is global
    and reverts the UI.
- **Scheduling.** Effects arms on value diffs and revalidates the lease in its
  debounce callback. Queue mode is armed per field by bus events.
  `stopLifecycle` clears only the queue-mode debounce timer.
- **Reset.** `queueModeIntentRevision` is never reset (it stays monotonic), and
  `ensurePlaylistManager` re-resets the effects intent tracker.

These existing behaviours are preserved, not fixed. Each needs its own change
and review:

- Terminal effects PUT failures are never logged. The rethrows inside the
  attempt loop are swallowed by the outer catch after the cancel retires the
  token.
- `SettingsSyncCheckpointState.clearFullPublishIntent` has no callers.
- `refreshPersistedQueueMode`'s `broadcast` option is dead.

The old note that `AGENTS.md` points at the removed
`docs/beta-release-readiness.md` no longer applies at `933c6f54`; it already
points at `docs/release-record.md`.

## Verification

Environment: Windows 11 Pro 10.0.26200, Node 24.13.1 (the repository pins
24.20.0 for CI), npm 11.8.0, Vitest 5.0.0, TypeScript 6.0.3. `node_modules`
came from the base checkout with an identical lockfile.

All commands ran in the branch worktree at `4adecea3`, with no code changes in
the working tree. Wall times are local.

| Command                                   | Result                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                       | pass (60 s)                                                                                                 |
| `npm run lint`                            | pass, 0 warnings (73 s)                                                                                     |
| `npm run format:check`                    | pass (67 s)                                                                                                 |
| `npx vitest run src/pro-room`             | 77 files / 1,595 tests pass, 0 skip (71 s)                                                                  |
| `npm test`                                | 532 files / 11,097 pass, 1 skip (the existing skip), 0 fail (212 s)                                         |
| `npm run test:coverage:critical`          | 57 files / 1,942 tests pass, all thresholds met (53 s); base `933c6f54`: 56 files / 1,919 tests             |
| `npm run guard:dead-exports`              | pass; test-only 21 (baseline 21), self-only 79 (baseline 79)                                                |
| `npm run guard:import-graph`              | pass; 346 files, 1,820 edges, 0 cycles                                                                      |
| `npm run guard:room-authority-boundaries` | pass; 0 PRO direct reads                                                                                    |
| `npm run guard:source-complexity`         | pass; `runtime.ts` 3,896 / 10,000 lines (base 4,022)                                                        |
| `npm run guard:bus-pairing`               | pass; 198 emitted / 198 listened                                                                            |
| `npm run guard:lifecycle-writes`          | pass                                                                                                        |
| `npm run guard:sw-cache-version`          | pass; `v647` (`4adecea3`) covers all committed PWA runtime changes                                          |
| `npm run build:checked`                   | pass (113 s), including `guard:sw-cache-version`, `guard:sw-app-shell` (90 assets) and the production build |

Two earlier versions of this commit failed tests, and both fixes were folded
into it before it was finalised:

- `90776312` bumped only `scripts/service-worker-asset.ts`. Its `src/pro-room`
  run failed `claim-bootstrap.test.ts` because the `index.html` bootstrap query
  still read `v646`.
- In `f03e8827`, the full `npm test` failed `ci-quality-gates.test.ts`, which
  pins the critical-coverage policy keys, because the combined glob had been
  widened. The pin now names the widened glob, the lane's include entry, and
  its own floor.

  The same run also timed out `production-security-rollout.test.ts` at 60 s.
  That test copies and runs the real security guard against files this change
  does not touch. It passed alone (21 tests, 23 s) and in the final full run.

`runtime.ts`, the lane, and the lane suite are byte-identical across all three
versions, so the mutant runs below, made on `90776312`, apply unchanged. The
fidelity checks and differential runs were repeated on `4adecea3` with
identical results.

Critical coverage (v8, statements / branches / functions / lines):

| File                                      | Base `933c6f54`               | `4adecea3`                    | Floor                         |
| ----------------------------------------- | ----------------------------- | ----------------------------- | ----------------------------- |
| `src/pro-room/persisted-resource-lane.ts` | —                             | 100 / 100 / 100 / 100         | 99 / 99 / 99 / 99 (new)       |
| `src/pro-room/runtime.ts`                 | 80.13 / 71.58 / 84.04 / 84.18 | 79.43 / 70.66 / 83.69 / 83.56 | 61 / 51 / 65 / 65 (unchanged) |
| `src/pro-room/playback-controller.ts`     | 88.96 / 84.73 / 90.84 / 92.56 | 88.96 / 84.73 / 90.84 / 92.56 | 80 / 72 / 87 / 85 (unchanged) |
| All critical files                        | 81.63 / 76.25 / 87.78 / 85.76 | 81.60 / 76.20 / 87.79 / 85.73 | 73 / 66 / 80 / 78 (unchanged) |

`runtime.ts` drops slightly because the moved code was better covered than the
file average. The lane now has its own floor, and the
`{runtime,playback-controller,persisted-resource-lane}` logical-unit floor
(66 / 58 / 69 / 70) still holds with a wide margin.

The base critical run was taken from a `git archive` export of `933c6f54`. Its
first attempt passed every test but exited 1 because a Vitest fork crashed
during `cloudflare-signaling-worker.test.ts` (Windows exit code
`0xC0000409`, outside the changed code). An immediate rerun passed cleanly, and
the coverage figures were identical.

## Differential and mutant evidence

The harness (`b1-diff/make-b1-diff.mjs` and `b1-diff/driver.ts`) lives in the
session scratchpad and is not committed. Committing a copy of the deleted code
as a test oracle would leave dead code behind. The harness builds both sides
from Git rather than from hand copies:

- the old side from `origin/main:src/pro-room/runtime.ts` (`933c6f54`);
- the new side from `runtime.ts` and the lane at `4adecea3`.

### Textual fidelity (all PASS)

- `runtime.ts` at `4adecea3` equals the base file after only the planned
  substitutions: import, lane constants, `lane.reset()`, `lane.enqueue`,
  wrapper bodies, removal of the two enqueue functions and the flight
  interface, and the two heartbeat predicate calls.
- The heartbeat inline conditions equal the named predicates' bodies.
- After identifier renaming and whitespace normalisation, `lane.refresh` and
  `lane.enqueue` equal the old effects and queue-mode bodies.
- The lane has no imports and exactly one export.

### Differential runs

Random interleavings of refresh calls (each with its own caller context),
checkpoint PUTs on the shared lock, settlement of any held pass or PUT
(true, false, or reject), accepted-value changes, runtime resets, and
generation-only bumps, with 0–4 microtasks between steps. Each run is 12,000
scenarios (6,000 effects + 6,000 queue mode) per seed, on seeds 2654435769,
625341585, and 1540483477, comparing the complete event logs of both sides.

- **Extracted harness.** The old and new functions are executed verbatim
  inside each world, with the real `queueModeMatchesPlaylist`. Async wrappers
  run on both sides, as in production.
- **Reviewer harness** (`review-b1/eq2-template.ts`). It uses the committed
  lane and the callback wiring from `review-b1/make-eq3.mjs`. On seed
  2654435769 it reproduces the review's figures exactly: M1 5,141, M2 497,
  non-async wrapper 1,428.

Mismatched scenarios out of 12,000 per seed, written as extracted / reviewer
harness. Seeds are 2654435769, 625341585, and 1540483477. The last column shows
whether the committed lane suite kills the variant.

| Variant                                                         | Seed 1        | Seed 2        | Seed 3        | Lane suite (23 tests) |
| --------------------------------------------------------------- | ------------- | ------------- | ------------- | --------------------- |
| **Committed lane**                                              | **0 / 0**     | **0 / 0**     | **0 / 0**     | 23 pass               |
| Non-async `refreshPersisted*` wrapper                           | 1,196 / 1,428 | 1,247 / 1,407 | 1,128 / 1,476 | 1 fail (wiring pin)   |
| M1: two extra awaits before each pass takes the lock            | 5,215 / 5,141 | 5,228 / 5,210 | 5,133 / 5,140 | 1 fail                |
| M2: joiners get a derived promise                               | 413 / 497     | 385 / 507     | 417 / 521     | 16 fail               |
| M3: no generation check inside the lock                         | 6,684 / 4,544 | 6,673 / 4,536 | 6,692 / 4,546 | 3 fail                |
| M4: `finally` clears whichever flight holds the slot            | 1,752 / 1,775 | 1,759 / 1,833 | 1,776 / 1,772 | 2 fail                |
| M5: pending snapshot skips `refreshStillRequired`               | 1,219 / 1,937 | 1,152 / 1,972 | 1,191 / 1,941 | 3 fail                |
| M6: `applied` short-circuits and skips later passes             | 2,763 / 3,858 | 2,848 / 3,871 | 2,872 / 3,948 | 1 fail                |
| M7: stale-generation failure is swallowed                       | 2,295 / 1,377 | 2,394 / 1,370 | 2,402 / 1,404 | 1 fail                |
| M8: `reset()` keeps the old lock tail                           | 5,826 / 6,314 | 5,828 / 6,323 | 5,765 / 6,260 | 2 fail                |
| M9: no retry pass after a failure                               | 1,523 / 2,126 | 1,499 / 2,134 | 1,565 / 2,234 | 2 fail                |
| M10: post-pass generation check compares the captured value     | 4,018 / 2,706 | 4,011 / 2,693 | 3,973 / 2,676 | 2 fail                |
| C1 (equivalent): enqueue without the unreachable reject handler | 0 / 0         | 0 / 0         | 0 / 0         | 23 pass               |
| C2 (equivalent): slot installed before the flight starts        | 0 / 0         | 0 / 0         | 0 / 0         | 23 pass               |

The two equivalence controls show that the harnesses do not report spurious
mismatches. C1 is equivalent because the lock tail never rejects; C2 because
nothing reads the slot between those two statements. For the committed lane,
each seed of the extracted harness reached about 6,500 coalesced passes,
35,000 calls that ran no pass of their own (joins and stale skips), and 8,300
caller rejections.

For comparison, the seven runtime test files that already covered this code
(`runtime-effects-contract`, `runtime-server-playback`,
`runtime-settings-intent-authority`, the three `runtime-queue-mode-*` files and
`settings-sync-retry`; 202 tests) kill only M3, M5, M6, M8, and M9. M1, M2,
M4, M7, and M10 pass them unchanged. The lane suite closes those gaps,
including the shared-lock ordering that M1 breaks and the identical-promise
contract that M2 breaks.

## Review follow-up — notification generation pin

A review found that nothing pinned when the effects wrapper reads the
notification generation. `refreshPersistedEffects` captures
`effectsNotificationGeneration` when it is called, and every pass of the flight
it creates uses that value, as the old copy at `933c6f54` did. A mutant that
passes `effectsNotificationGeneration` at pass time instead left every
`src/pro-room` test passing. The difference is observable:
`beginControlChannelRecovery` and the `settings-sync:changed` listener bump the
notification generation without bumping the runtime generation, so a flight
created before them stays live, and `shouldNotifyCanonicalEffects` compares the
value its pass was given.

`f1d35b5e` changes tests only:

- `runtime-server-playback.test.ts` holds a refresh's GET across a
  settings-sync OFF/ON toggle and lets a newer head join the flight. The
  coalesced second pass starts after the toggle, applies the newer settings
  without a toast, and a later revision still notifies. A bump during the first
  pass's GET would not tell the two reads apart, because both read before the
  GET starts.
- The lane suite's wiring pin also requires the call-time capture followed by
  `refreshPersistedEffectsUnlocked(target, notificationGeneration)`. The suite
  still has 23 tests.

The behavioural test also passes against base `933c6f54` (its file: 125 / 125),
so it pins existing behaviour. Under the pass-time mutant, the `runtime-*` files
plus `settings-sync-retry` (22 files) give 2 fail / 362 pass, and the two
failures are the new pins.

Re-run at `f1d35b5e` in the same environment. The working tree held only the
uncommitted release-record edit.

| Command                                   | Result                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run typecheck`                       | pass (51 s)                                                                                    |
| `npm run lint`                            | pass, 0 warnings (59 s)                                                                        |
| `npm run format:check`                    | pass (24 s)                                                                                    |
| `npx vitest run src/pro-room`             | 77 files / 1,596 tests pass, 0 skip (52 s)                                                     |
| `npm test`                                | 532 files / 11,098 pass, 1 skip (the existing skip), 0 fail (153 s)                            |
| `npm run test:coverage:critical`          | 57 files / 1,943 tests pass, all thresholds met (53 s); coverage figures as in the table above |
| `npm run guard:dead-exports`              | pass; test-only 21 (baseline 21), self-only 79 (baseline 79)                                   |
| `npm run guard:import-graph`              | pass; 346 files, 1,820 edges, 0 cycles                                                         |
| `npm run guard:room-authority-boundaries` | pass; 0 PRO direct reads                                                                       |
| `npm run guard:source-complexity`         | pass; `runtime.ts` 3,896 / 10,000 lines                                                        |
| `npm run guard:bus-pairing`               | pass; 198 emitted / 198 listened                                                               |
| `npm run guard:lifecycle-writes`          | pass                                                                                           |
| `npm run guard:sw-cache-version`          | pass; `v647` (`4adecea3`) covers all committed PWA runtime changes                             |
| `npm run build:checked`                   | pass (31 s), including `guard:sw-app-shell` (90 assets) and the production build               |
