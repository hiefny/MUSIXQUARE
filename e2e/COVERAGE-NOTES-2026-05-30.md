# E2E Coverage Notes - 2026-05-30

## Runs

- Full baseline before edits: `npm run test:e2e` -> 303 passed in 54.6m.
- Targeted post-edit verification after `npm run build:e2e`:
  `npx playwright test e2e/file-transfer.test.ts e2e/multi-guest.test.ts e2e/youtube-sync.test.ts e2e/background-resume.test.ts`
  -> 18 passed in 3.7m.
- Focused unit regression for the direct-transfer promotion race:
  `npm test -- src/storage/__tests__/remote-local-promotion.test.ts` -> 4 passed.

Expected local-preview noise observed during YouTube E2E: TURN endpoint 401/403 fallback, Wake Lock permission denial, and fake-YouTube shared-clock warnings. These did not fail tests.

## Stale Spec Pass

The existing suite is still runnable as a whole, so I did not delete or quarantine specs. The scan found broad existing coverage for reconnects, host leave/refresh, multi-guest fan-out, mobile UI, YouTube drift/rendezvous, and transfer round trips. I added narrower regression tests where the prompt named edge paths that were only indirectly covered.

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
