# One dialog when returning from the background — 2026-10-17

## Report

The owner returned to MUSIXQUARE after a long time in the background and saw
two dialogs in a row. They closed both with the blue button without reading
them closely. One was certainly the background warning ("앱이 잠시
백그라운드로 넘어갔어요"); the other was not identified and may have been the
same warning.

## Cause

`showDialog` queues every request and shows them one at a time, with no
de-duplication, so any two requests made around a return appear back to back.
The code has two such paths.

1. **The same warning twice.** `core/background-resume-guard.ts` runs one
   recovery and, after an absence of at least 60 s, one warning per return. A
   return that happens while that flight is still in progress is not dropped:
   it is queued as a single follow-up (later ones coalesce into it), and the
   follow-up runs as soon as the warning is answered. If that second absence
   was also at least 60 s, the follow-up showed the warning again. The unit
   test "coalesces a resume that arrives while the previous warning is still
   open" pinned this second warning. A brief visible moment (waking the
   screen, the app switcher) is enough to raise the first warning, which then
   waits on screen for the real return.
2. **The warning plus the audio recovery dialog.** After a return, a local
   file that cannot restart without a gesture opens "오디오가 잠시
   멈췄어요" (button "오디오 다시 켜기"). Recovery found during the return
   itself suppressed the warning through `suppressLongBackgroundWarningForIncident`,
   but a failed PLAY from `player/transport.ts` (`source: 'play'`), for example
   the host's play command arriving right after the return, did not. Both
   dialogs then appeared.

With both paths, one return could show up to three dialogs: the open warning,
the queued second warning, and the audio recovery dialog.

The host-unresponsive dialog and the disconnect dialog were ruled out for this
report. `network/host-presence.ts` restarts its silence window when the page
becomes visible, so its dialog needs another minute. The disconnect dialog's
blue button reconnects with a reload, which the owner did not describe.

## Change (owner decision 2026-10-17)

The owner chose to keep recovery and show at most one dialog.

- **Background resume guard.** A follow-up that arrives while the warning is
  asked for and not yet answered only recovers. The guard tracks the longest
  absence that no warning covered. An absence that ended before the flight's
  warning opened is covered too, because that warning appeared after it. A
  long absence that no warning covered still warns, for example one that
  ended during a short recovery-only flight, and so does a new absence after
  the warning was answered. Recovery still runs with the longest absence.
- **Audio recovery replaces the warning.** The warning moved from `app.ts` to
  `ui/long-background-warning.ts` (`createLongBackgroundWarning`). Every new
  audio recovery dialog, whatever asked for it, calls `yieldToAudioRecovery()`.
  That call skips the warning for the rest of that return and withdraws one
  that is already on screen or queued, through the dialog's `AbortSignal`.
  The warning is also skipped while a recovery dialog is open or queued. The
  existing suppression points (a pending native interruption attempt, output
  that needs a gesture, a background-resume recovery event) use the same call.
  `beginIncident()` replaces the reset at the start of each recovery. The
  recovery dialog's own text already says the app came back from the
  background, so no information is lost.
- Unchanged: the 1 s recovery and 60 s warning thresholds, the copy, the
  recovery dialog itself, and a warning that was already answered (a later
  recovery dialog does not touch it).

App 8.11.7 / service-worker cache v705. App only; Developer API D1 stays
disabled. There are no new dependencies, protocols, schema, secrets,
bindings, permissions, CSP, or copy changes.

## Verification

Base `106304b0` (main after #372). Tested runtime source: `eab71520`.
Local Windows checks used Node 24.13.1 / npm 11.8.0. These are local branch
results, not the exact-main release candidate.

On `eab71520`, `format:check`, `lint`, `typecheck`, and `build:checked`
passed. `build:checked` includes the room-authority boundary,
service-worker cache version (v705 covers every committed runtime change),
and app-shell (97 assets) guards. The bus-pairing, import-graph,
lifecycle-writes, dead-exports (self-only bindings stay at the baseline of 78),
chunk-pump, standard-room hot-path, Developer API boundary, D1 migration, and
operations drift contract guards also passed. The full unit run passed 573
files / 12,869 tests, with zero failures or skips. E2E was not run.

The first full run, on a draft that exported a `LongBackgroundWarning`
interface, failed in two places. The dead-export ratchet counted 79
self-only bindings against its baseline of 78; the interface was removed and
the factory's return type is now inferred. The real-workerd
`pro-room-burst.test.ts` lost its socket under full-suite load ("other side
closed"). It passed 7/7 when run alone and in the second full run, and this
change does not touch PRO admission.

### Unit tests

`src/core/__tests__/background-resume-guard.test.ts`: the pinned case is now
"only recovers for a resume that arrives while the previous warning is still
open" (recover twice, warn once). New cases cover several absences coalescing
during an open warning, an absence that ends before the warning opens, a long
uncovered follow-up that still warns, and a warning after an answered one.
Against the previous guard the three suppression cases fail; the other two
pin behaviour the previous guard already had.

`src/ui/__tests__/long-background-warning.test.ts` (new): the warning's copy
and focus; skipping it after `yieldToAudioRecovery()` or while a recovery
dialog is active; withdrawing an open warning through its signal; showing it
again after `beginIncident()`; and leaving an answered warning alone.

### Not covered

- The wiring in `src/app.ts` is not unit-tested, because the bootstrap module
  cannot be imported in tests. It was checked by reading the diff:
  `suppressLongBackgroundWarningForIncident` and `warnLongBackgroundResume`
  have no remaining references.
- No browser or device run. A real return needs a Standard or PRO room
  (signaling) and real audio suspension, which the local preview cannot
  provide. iPhone Safari/PWA and Android behaviour remain for the device
  check.

## Release and recovery

The owner approved the 8.11.7 production deploy on 2026-10-17. PR #373 was
squash-merged as `4d1e001105bb1a7a1aa52fa2ef1bf5df551b89d9` after PR CI
38943418521 (11 jobs) passed on head `024080c9`; the Codex review had no
findings. Exact-main push CI 38944217887 attempt 1 passed all 11 jobs: unit
573 files / 12,868 pass / 0 fail / 1 skip (a Windows-only path check on
Linux), candidate browser 17 and critical browser 45 pass.

Production Release 38945082862 attempt 1 (target `app`, Developer API D1
disabled) succeeded. Its deploy job finished at 03:11:36 KST.

- App version `673f3697-c6ed-43cf-8963-88f71c302fc5` / deployment
  `5945bc86-b69e-4862-97b3-c79a968d63f7`, message
  `git:4d1e001105bb1a7a1aa52fa2ef1bf5df551b89d9`. Final ownership was
  verified at 03:11:30.126 KST. The partial-release compatibility recheck was
  compatible at 03:10:36.506 KST, and the five unselected Workers stayed on
  `d9364cd94ef036c5202ebf20cf5fff0b68d8cacf`.
- The seven existing App D1 baseline steps applied and verified
  idempotently. The Developer API D1 and other target-specific steps were
  skipped.
- Smokes passed: App generation converged on `/assets/main-DJvp5cYu.js`
  (3 consecutive reads, 29 assets), the anonymous account boundary, the PRO
  public boundary on the existing `8d5d44c0`, and Standard HTTPS signaling
  (host and guest admission, offer and answer relay).
- Artifacts: deployments 12066320538, coherent marker 12066245597, and
  recovery checkpoint 12066290317.

Public assets at 03:12:06–09 KST: `/` (140,676 bytes),
`/service-worker.js` (39,149 bytes, `CACHE_VERSION = "v705"`),
`/bootstrap.js?cache=v705` (10,196 bytes), and `/assets/main-DJvp5cYu.js`
(434,764 bytes, the entry that holds this change) all returned 200. Each
matched the exact-main candidate artifact byte for byte (SHA-256).

Operations Drift Audit 38945544840 on `4d1e0011` reported
automated-checks-passed: 31 pass / 0 fail / 5 manual-only (report at
03:12:48 KST).

Not verified after the deploy: a real return from the background in a room
on a device. Open tabs pick up 8.11.7 through the update path recorded in
[the reopen report](update-apply-on-reopen-2026-10-16.md), so the new
behaviour reaches a device only after it loads the new page code.

No rollback was needed, and the independent recovery job was skipped.
Checkpoint
`production-recovery-checkpoint-4d1e001105bb1a7a1aa52fa2ef1bf5df551b89d9-38945082862-1`,
captured at 03:09:59.269 KST, keeps the previous App
`1a2fb4423e25e758336e9f1215371a3766771d85` (8.11.6/v704), version
`7a943c98-b30c-49ba-97b0-4c79d913adc0` / deployment
`0cf1427e-1ba1-45a0-bdbe-3adc183ddf1c`. The floors captured at
03:10:03.075 KST were ready, with release floor `d9364cd9`, generation floor
`4c5612d5`, and the generation and entitlement floors true. The retained App
is a verified release ancestor.

A normal authorized rollback to 8.11.6/v704 restores the previous behaviour:
a second identical warning after an absence during the first, and the warning
alongside a play-triggered audio recovery dialog. No stored data or wire
contract changes.
