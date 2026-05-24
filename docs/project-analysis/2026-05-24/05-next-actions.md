# Next Actions

This file separates analysis outcomes from code changes. The user asked for permission before code modification, so all implementation items below are proposals.

## Immediate No-Code Follow-Ups

1. Extend the state/protocol contract table when new code changes happen.
   - Current baseline exists in `06-state-protocol-contracts.md`.
   - Sources: `src/types/index.ts`, `src/core/state.ts`, `src/network/protocol.ts`, `src/player/ownership.ts`, `src/player/lifecycle.ts`.

2. Trace one complete flow at a time.
   - Current broad baseline exists in `07-flow-analysis.md`.
   - Recommended deeper next pass: local file playback from host select to guest play.
   - Possible output: `08-flow-local-file-playback.md`.

3. Trace remote-share path.
   - Possible output: `09-flow-remote-share.md`.
   - Include encryption, upload, descriptor, download, decrypt, decode, and timeout behavior.

4. Trace YouTube Together path.
   - Possible output: `10-flow-youtube-together.md`.
   - Include iframe load, host autosync, guest rendezvous, drift correction, and stop/cleanup.

5. Trace system audio path.
   - Possible output: `11-flow-system-audio.md`.
   - Include P2P/SFU split and previous-mode restore.

## Recommended Permission-Gated Code Fixes

### Fix 1: Migrate E2E Away From `appState`

Why:

- Confirmed stale E2E references to removed state contract.
- E2E is manual and documented as stale partly because of this.

Likely files:

- `e2e/helpers/wait.ts`
- `e2e/late-join.test.ts`
- `e2e/playback-advanced.test.ts`
- `e2e/youtube.test.ts`

Preferred implementation:

- Add semantic helpers:
  - `getPlaybackSnapshot(page)`
  - `waitForPlaybackMode(page, mode)`
  - `waitForPlaybackActivity(page, activity)`
  - `waitForFileLifecycle(page, lifecycle)`
  - `waitForYouTubeActive(page)`
- Replace direct `__MUSIXQUARE_GET_STATE__('appState')` calls.
- Keep helpers tolerant of transient `pending` where the app intentionally uses async rendezvous/transfer.

Suggested verification:

- `npm run typecheck`
- `npm run lint`
- `npm test`
- Targeted Playwright files if practical:
  - `npx playwright test e2e/playback-advanced.test.ts`
  - `npx playwright test e2e/youtube.test.ts`
  - `npx playwright test e2e/late-join.test.ts`

### Fix 2: Add a Static Guard for Legacy E2E `appState`

Why:

- Production has a guard, but E2E helper drift can reappear.

Possible approach:

- Add a small script that fails on:
  - `__MUSIXQUARE_GET_STATE__('appState')`
  - `VALID_APP_STATES`
  - comments that say E2E state mirrors old `APP_STATE`

This may be too strict if old docs need to mention migration history. A scoped search under `e2e/` is safer.

### Fix 3: Bundle Analysis Before Splitting

Why:

- Build warns about `playlist.ts` mixed static/dynamic import and main chunk size.

Safe first step:

- Add a bundle visualizer only as a dev tool or run a one-off analysis.
- Do not refactor imports until module side effects are mapped.

Potential candidates for later lazy loading:

- YouTube search/iframe path.
- Chat command debug path.
- Demo mode.
- System-audio/SFU path.

### Fix 4: Operational Note for Turnstile Grace Period

Why:

- Config is currently allowed but security-sensitive.

Possible file:

- `cloudflare/turnstile-grace-period.md`

Content:

- Current flags.
- Reason for grace period.
- Risk acceptance.
- Re-enable checklist.
- Owner/date.

No runtime code change is required.

## Release Readiness Checklist

Before treating a release as high confidence:

- Fast CI passes:
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - `npm run build:checked`
- E2E helpers are migrated away from legacy `appState`.
- At least targeted E2E passes for changed media path.
- Manual smoke matrix covers:
  - Host creates room.
  - Guest joins same network.
  - Guest joins remote network.
  - Local file playback.
  - Remote-share file playback.
  - YouTube Together playback.
  - System audio start/stop.
  - Leave/rejoin.
  - Mobile browser sanity.
- Cloudflare app worker and remote-share worker configs are reviewed.
- Production guard scripts pass.

## Suggested Order If User Approves Code Work

1. Fix E2E state helpers first.
2. Run targeted E2E.
3. Only then consider bundle/performance work.
4. Keep runtime refactors small and attached to a test.

Reasoning:

- The E2E migration improves confidence in future changes.
- Bundle splitting can change initialization order and should not happen while E2E state assertions are stale.
- Runtime flows are too interdependent for broad refactors without a reliable integration harness.
