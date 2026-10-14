# PRO silent-endpoint transport — 2026-10-14

## Scope and evidence

During the 8.10.17 production measurement in the owner's PRO room, a
late-joined endpoint stayed silent because its YouTube restore had failed. Its
transport button showed Play, because the YouTube icon follows the iframe's real
player state. Pressing it still sent a room-wide Pause and paused every
participant.

The button and its action read different state. `togglePlay()` chose
`pause`/`play` from `playback.activity`, which keeps mirroring the room
("playing") while the iframe is silent.

- **Pre-existing.** The toggle predates the 8.10.18 rejoin work. 8.10.18 made
  silent endpoints much rarer but did not change the button.
- **Scope.** Only an endpoint with playback control can send the command; a
  listener's button is disabled.
- **No loading state.** Restores (late join, missed COMMIT, retry) and local
  rejoins (foreground recovery, Sync, a rejoining Play) showed no loading state.
  The button stayed pressable over a silent iframe, while server PREPAREs already
  showed a spinner.

[Observation in the rejoin report](youtube-rejoin-sync-2026-10-14.md#production-measurements).

## Change

Participant-local; no Worker, protocol or schema change.

- **The button acts on what it shows.** The player controls record the icon they
  render. A click or Space passes it to `togglePlay`, and a PRO room command
  follows it.
  - A press on a silent endpoint (button showing Play) sends Play. The server
    answers `unchanged` because the room already plays, and the existing path
    rejoins only this endpoint; YouTube uses the planned rendezvous.
  - Pause is sent only when the button shows Pause.
  - Explicit play/pause callers (lock screen, headset) pass no displayed state
    and keep their behavior.
- **Restore loading state.** A running YouTube COMMIT that this endpoint has no
  PREPARE for (late join, missed COMMIT, retry) shows the shared transition
  loading state until it releases or fails: button spinner, YouTube loading
  overlay, locked seek bar. A failure ends the spinner, so Play can rejoin.
- **Local rejoin loading state.** A local YouTube rejoin (foreground recovery,
  Sync, a rejoining Play) shows the same loading state while the arm prepares.
- **Keyboard parity.** While a PRO endpoint shows that loading state, Space is
  ignored, as the spinner already blocks pointer presses.

## Verification

Environment: Windows 11 Pro local worktree, Node 24.13.1 (the repository pins
24.20.0, which pull request CI uses), Vitest 5.0.3, Playwright 1.63.0 with
Chromium. jq was supplied through `MXQR_TEST_JQ_PATH`.

Tested source: **`a6a8f07d1c701c09eb35d768c4a1a74073ea5dc1`** (8.10.19, cache
epoch v685), branch `agent/pro-silent-transport`, clean tree before and after
the run. Later commits on the branch change documentation only. These are local
and branch results, not the exact-main release candidate.

| Check | Result |
| --- | --- |
| Full `vitest run` | 563 files, **12,721 passed / 0 failed / 0 skipped**, 159.64 s |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed, zero warnings |
| `npm run format:check` | Passed |
| `npm run test:e2e:critical` | **29 passed / 0 failed / 0 skipped / 0 flaky**, 1.3 min |
| YouTube and playback-sync E2E (same six files as the rejoin report) | **28 passed / 0 failed / 0 skipped / 0 flaky**, 9.0 min |
| `guard:sw-cache-version`, `guard:release-identity` | Passed (v685 covers the runtime changes) |

New pins:

- A PRO press routes Play, not a room-wide Pause, when the button shows a silent
  YouTube endpoint, routes Pause when it shows playback, and keeps the
  room-state toggle for explicit callers.
- The play button passes the icon it renders, and Space stays inert while a PRO
  endpoint shows its loading spinner.
- A late-join YouTube restore shows the loading state through preparation until
  it releases, or until both of its attempts fail.
- A foreground YouTube rejoin shows the loading state while the arm prepares.

The existing `unchanged` Play pin covers the server answer that turns that Play
into a rejoin of this endpoint only.

Not verified: physical iOS/Android devices, real speaker output, WebKit, the
full serial E2E suite, and production behavior. The local stack cannot open PRO
rooms, so the button was not exercised in a browser against a real room before
release.

## Release and recovery

App-only release (`target=app`). Mixed versions are safe because every change is
participant-local. Recovery is the ordinary Production Release rollback to the
8.10.18 checkpoint, which restores the activity-based toggle.
