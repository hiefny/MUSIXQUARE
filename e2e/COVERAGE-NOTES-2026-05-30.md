# E2E Coverage Notes - 2026-05-30

## Runs

- Full baseline before edits: `npm run test:e2e` -> 303 passed in 54.6m.
- Targeted post-edit verification after `npm run build:e2e`:
  `npx playwright test e2e/file-transfer.test.ts e2e/multi-guest.test.ts e2e/youtube-sync.test.ts e2e/background-resume.test.ts`
  -> 18 passed in 3.7m.
- Focused unit regression for the direct-transfer promotion race:
  `npm test -- src/storage/__tests__/remote-local-promotion.test.ts` -> 4 passed.
- Post-stabilization targeted checks:
  - `npx playwright test e2e/chat-commands.test.ts:433 --project=chromium` -> 1 passed.
  - `npx playwright test e2e/chaos-scenarios-2.test.ts:689 --project=chromium` -> 1 passed.
- Final full post-edit verification:
  `npm run test:e2e` -> 307 passed in 54.6m.

Expected local-preview noise observed during YouTube E2E: TURN endpoint 401/403 fallback, Wake Lock permission denial, and fake-YouTube shared-clock warnings. These did not fail tests.

## AppState Projection De-Stale - 2026-05-31

The legacy production `appState` state slot is gone, so raw reads inside
`page.evaluate` / `page.waitForFunction` now bypass the E2E projection and
resolve to `undefined`. I removed those direct raw reads and routed assertions
through `window.__MUSIXQUARE_GET_PROJECTED_APP_STATE__` or existing helpers
that already project `appState`.

De-staled files:

- `e2e/chaos-scenarios-2.test.ts`
- `e2e/chaos-scenarios.test.ts`
- `e2e/late-join.test.ts`
- `e2e/playback-advanced.test.ts`
- `e2e/playback-sync.test.ts`
- `e2e/youtube-sync.test.ts`
- `e2e/youtube.test.ts` (also contained current raw reads in this worktree)

Verification:

- Raw-read guard:
  `rg -n '(get\??\.?|__MUSIXQUARE_GET_STATE__)\([''\"]appState' e2e`
  -> no E2E spec matches; the only remaining match is this documentation line.
- `npm run typecheck` -> passed.
- `npm test` -> 68 files, 979 tests passed.
- `npx playwright test e2e/playback-sync.test.ts` -> 4 passed in 38.0s.
- `npx playwright test e2e/playback-advanced.test.ts` -> 14 passed in 1.9m.
- `npx playwright test e2e/youtube-sync.test.ts` -> 5 passed in 59.1s.
- `npx playwright test e2e/youtube.test.ts` -> 8 passed in 1.2m.
- `npx playwright test e2e/late-join.test.ts` -> 13 passed in 2.1m.
- `npx playwright test e2e/chaos-scenarios.test.ts` -> 15 passed in 4.8m.
- `npx playwright test e2e/chaos-scenarios-2.test.ts` -> 48 passed in 11.7m.
- `npx playwright test e2e/playback-sync.test.ts e2e/playback-advanced.test.ts e2e/youtube-sync.test.ts e2e/late-join.test.ts e2e/chaos-scenarios.test.ts e2e/chaos-scenarios-2.test.ts e2e/youtube.test.ts`
  -> 107 passed in 23.6m.
- `npm run test:e2e` -> 307 passed in 56.8m.

No stale `appState` raw-read path is currently known.

## Stale Spec Pass

The existing suite is still runnable as a whole, so I did not delete or quarantine specs. The scan found broad existing coverage for reconnects, host leave/refresh, multi-guest fan-out, mobile UI, YouTube drift/rendezvous, and transfer round trips. I added narrower regression tests where the prompt named edge paths that were only indirectly covered.

I also de-staled the shared setup helpers after full-suite runs exposed local PeerJS setup flakes:

- Corrected no-argument `page.waitForFunction` calls so timeout options are passed as Playwright options, not as the page-function argument.
- Added one bounded retry for host code generation and guest join setup. This keeps transient local signaling stalls from consuming the enclosing test timeout while still failing quickly if setup remains broken.

## Coverage Added

- `e2e/multi-guest.test.ts`
  - Added replacement-guest rejoin while another guest remains connected.
  - Verifies the host device list drops the departed peer, accepts the replacement guest, and fans the next upload to both active guests.

- `e2e/file-transfer.test.ts`
  - Added local-direct transfer promotion coverage for a guest that was waiting on remote-share/preload state.
  - This exposed a real ordering race in `src/storage/transfer-receive.ts`: `FILE_START` could clear the pending remote-share target before promotion detection.

- `src/storage/transfer-receive.ts`
  - Fixed the promotion path by detecting local-direct promotion before new-session cleanup and by promoting when the preload wait metadata still matches.

- `src/storage/__tests__/remote-local-promotion.test.ts`
  - Added a regression guard that simulates the real `storage:clear-previous-track` side effect which the prior unit mock did not expose.

- `e2e/youtube-sync.test.ts`
  - Added a manual `YOUTUBE_SYNC` rendezvous-frame test using the fake iframe player and real protocol dispatch.
  - Asserts the guest seeks before replaying.

- `e2e/background-resume.test.ts`
  - Added a mobile guest visibility-change test.
  - Verifies a long background bounce emits recovery (`sync:force-resync`/position refresh) and shows the user-facing resume dialog.

## Still Unguarded

- True OS-level mobile background suspension and native autoplay policy recovery cannot be fully simulated in headless Chromium; the new test covers the app's browser visibility/resume path.
- Real remote-share R2 upload/download success remains covered primarily below E2E by share worker/unit tests; the new E2E covers promotion from remote wait to local direct transfer without hitting external storage.
